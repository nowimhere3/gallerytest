# Phase 1 — Curation Import, Merge, Duplicate-Tag Repair & Rename Amendment

**Timestamp:** September 5, 2026, 3:12 PM (America/Edmonton — Calgary local time)

**Branch:** `Cassette-V3-Amendment` (unchanged, not merged, not pushed, nothing committed)

---

## 1. Root cause, confirmed from code (Phase A audit)

A "Curation" is the customer-facing name for a `Profile` record. Before this
amendment:

- `ProfileStore.toJSON()` (`profile-store.js:3049-3070`) exported
  `{ schemaVersion, kind, exportedAt, profileId, profileName, masterFolder,
  items, tags }`, with an explicit comment: *"Identity metadata. Informational
  only for now — import intentionally does not read these back yet."*
- `ProfileStore.importJSON()` (`:3101-3178`) merged Tags **by `tag.id`** only
  (`:3152-3159`) — a same-name, different-id incoming Tag was pushed as a
  **second, visually identical Tag**, with no name check at all. This is the
  exact root cause of the reported `TOP TOP TOP` / `ASS ASS` damage.
- Import always targeted the currently active Profile; there was no concept
  of "bring this into that other existing Curation."
- No Curation-name collision guard existed anywhere (create or rename).
  `setProfileName()` (rename) already existed on `ProfileStore` (`:1455-1467`)
  and was already Sync-safe, but was never exposed in the UI.
- `deleteTag()` (`:2967-2978`) already tombstones a Tag via one fact
  (`Facts.deleteTag`) and **deliberately leaves every item's assignment to it
  in place**, invisible rather than deleted — this turned out to be exactly
  the mechanism Duplicate Tag Repair needed, with no new plumbing.

## 2. Existing importer/exporter behavior discovered

Covered above and in the Phase A audit delivered earlier in this
conversation. Two additional, load-bearing findings surfaced only while
implementing Phase B:

- `importJSON`'s "merge" mode does `{...existing, ...incoming}` **per item**
  — if an incoming record carries a `tags` array, it **replaces** the
  destination item's whole tags array rather than adding to it. The new
  Curate Import / Import All path does **not** reuse `importJSON` for this
  reason — it applies changes item-by-item through `setFavorite` /
  `setHidden` / `setItemTag`, which are additive and safe.
- `getFullCollection()` (`:1865-1910`) already contained the exact per-profile
  read needed to inspect a **non-active** Curation without switching
  (live memory for the active profile, `loadProfileData()` for any other).
  This was extracted into a new, additive, read-only
  `ProfileStore.getProfileSnapshot(profileId)` rather than rewriting the
  Sync-critical `getFullCollection()` itself.

## 3. Architecture chosen

Small, single-purpose pure modules under `src/profile/`, mirroring the
existing `media-library-options.js` / `curation-display.js` /
`sync-v3-names.js` pattern already established in this codebase (no DOM, no
storage, fully testable in isolation), plus one new additive read method on
`ProfileStore` and UI orchestration in `main.js` reusing the existing
`.app-dialog` shell (`index.html`'s `profile-sync-setup-dialog`, deliberately
named generically for exactly this reuse).

Destination targeting for a Curation that isn't currently active is done by
**inspecting it read-only** (`getProfileSnapshot`) while building/previewing
a plan, and only **switching to it** (via the existing, already-safe
`switchProfile()`) at the moment `IMPORT SELECTED` actually commits — never
during preview. This was a deliberate design checkpoint or during this
session: it avoids adding a second cross-profile write path (which would
have meant rewriting `ProfileStore` persistence, an explicit STOP
CONDITION) while never flickering the customer's active Curation just to
preview an import.

## 4. Files changed

**New pure modules (`src/profile/`):**
- `name-equivalence.js` — the one name-equivalence rule (trim + case-insensitive), mirroring `ProfileStore`'s pre-existing `#tagNameExists`.
- `curation-import-parse.js` — PARSE step; validates/shapes a raw import file.
- `curation-import-identity.js` — IDENTIFY step; Case A/B/C classification.
- `curation-import-plan.js` — COMPARE + BUILD PLAN; same-name Tag MATCH/NEW, Favorites/Hidden aggregates.
- `curation-import-commit.js` — COMMIT step; applies a finished plan via ProfileStore's public API only.
- `duplicate-tag-repair.js` — repair plan + apply, reusing `setItemTag`/`deleteTag`.
- `curation-name-guard.js` — collision detection + `"Name (2)"` suggestion, shared by Create and Rename.
- `curation-display.js` — from the prior disambiguation phase; reused, not modified, by the new import/rename choice dialogs.

**Modified:**
- `src/profile/profile-store.js` — added `getProfileSnapshot(profileId)` (additive; `getFullCollection()` untouched).
- `src/main.js` — replaced the raw Merge/Replace/"Import as New" surface with the identity-aware Import flow; added Rename, Create-guard, and Duplicate Tag Repair wiring; added the one reusable `openCurationChoiceDialog()`.
- `index.html` — added the Rename button, the generic choice dialog, the Curate Import dialog, the Duplicate Tag Repair dialog, and the duplicate-tag notice; removed the three retired import buttons.
- `styles.css` — dialog width/scroll rules for the two staging dialogs, tag-row styling, the duplicate-tag notice, minor button-row flex rule.
- `tools/test-profile-sync-polish.mjs` — one pinned-source assertion updated after a variable rename (`typedName` → `name`, reverted to keep the pin intact — see §12).

## 5. Curation identity rules implemented (Feature 1)

- **Case A (SAME_ID):** the imported file's `profileId` matches an existing Curation exactly → that Curation is the destination, no ambiguity dialog — straight to Import All / Curate Import / Cancel.
- **Case B (SAME_NAME_DIFFERENT_ID):** different id, same displayed name as one or more existing Curations → a genuine human decision: `Bring Into Existing {label}` (using the existing conditional short-ID labels when multiple candidates share the name) / `Keep Separate` / `Cancel`. "Bring Into" is a **data transfer for this import only** — it never aliases the two Curation ids permanently (per the brief's CRITICAL DISTINCTION). "Keep Separate" creates a genuinely new Curation and offers an editable name up front.
- **Case C (DIFFERENT):** no id or name collision → ordinary new-Curation import, straight to Import All / Curate Import / Cancel.

No permanent Curation identity aliasing/lineage was built anywhere — this
was an explicit HARD BOUNDARY and is only left as a breadcrumb (see §14).

## 6. Same-name Tag merge rule implemented

Two Tag names are equivalent under the **same rule `ProfileStore` already
enforces** for its own Tag vocabulary (`#tagNameExists`): trim, then
case-insensitive compare. `TOP`/`TOP` and `TOP`/`top` both collide. This rule
lives in exactly one place (`name-equivalence.js`) and is reused by Tag
matching during import, duplicate-tag grouping during repair, and the new
Curation-name collision guard — never re-implemented per call site.

During import, an incoming Tag whose name matches an existing destination
Tag is classified `MATCH` (never `NEW`); selecting it merges its assignments
onto the **existing destination Tag id** — the imported Tag id is never
created locally and never becomes a second visible same-name Tag. The
customer sees `redheads MATCH Merge`, never a `B → A` remap.

## 7. Duplicate-tag Repair — safe to implement now, and why

Yes. The Phase A audit confirmed `deleteTag()` already tombstones a Tag as
one ordinary fact while leaving assignments in place underneath, invisible
rather than deleted — this is precisely what Sync-safe repair needs. Repair
therefore uses only two already-existing, already-Sync-safe primitives per
losing duplicate: `setItemTag(path, canonicalId, true)` to reassign its
visible assignments onto the earliest-created survivor, then `deleteTag(losingId)`
to tombstone it. No new alias/lineage infrastructure was required or built.
Repair is idempotent (re-running finds nothing left to group) and leaves
unselected groups, and all unrelated Favorites/Hidden/Tags, untouched.

## 8. Import All behavior

The fast, deterministic path: builds the default plan (every Favorites/Hidden/Tag
row selected) and applies it immediately through the same commit function
Curate Import uses. Only present, positive state from the import is ever
applied — absence, or an explicit `false` on a record that also carries an
unrelated `true` field (the open-shape co-occurrence the brief specifically
warns about), never becomes a destructive OFF/removal fact. Verified by
dedicated tests (§12, Snapshot Safety).

## 9. Curate Import behavior

A non-mutating staging dialog: builds an Import Plan (`buildImportPlan`) and
lets the customer toggle `.selected` on Favorites, Hidden, and each Tag row
before anything is written. `Select All` is present; no `Clear All` was
added (rows are unchecked by hand, matching the brief). `IMPORT SELECTED` is
disabled until at least one row is selected, and is the **only** call site
that invokes `applyImportPlan`. Before actually committing, the destination's
current Tag vocabulary is re-fingerprinted; if it changed since the dialog
opened (stale-plan protection), the plan is silently rebuilt and review is
requested again rather than committing a stale MATCH/NEW classification.

## 10. Rename / Create-collision behavior

- **Rename** (`profile-rename-btn`) sits directly beside the Curation
  selector in "This Device Is Using," not buried in Advanced. It calls the
  pre-existing `setProfileName()` — id, Favorites, Hidden, Tags, and Media
  Library associations are untouched by construction (that method never
  touched them even before this amendment). Renaming to a name already in
  use warns (`Use "X" Anyway` / `Choose Another Name` / `Cancel`) and never
  merges Curations.
- **Create** (`profile-create-btn`) now checks for an existing same-name
  Curation first: `Use Existing {label}` switches to it (no duplicate
  created); `Create Another` suggests `"Name (2)"`, editable before final
  creation, and always mints a fresh durable id.

## 11. Snapshot / provenance safety behavior

`buildImportPlan` only counts an item as favorited/hidden when the imported
record explicitly carries a truthy value; absence is never a signal.
`applyImportPlan` mirrors this: it only ever calls `setFavorite(path, true)` /
`setHidden(path, true)` / `setItemTag(path, id, true)` — it contains no code
path capable of calling any of those with `false`. An old or partial export
can therefore never manufacture a destructive unfavorite/unhide/untag fact,
regardless of what it omits or explicitly sets to `false` alongside an
unrelated `true` field on the same record.

## 12. Tests run and results

New suites (all passing):

```
node tools/test-curation-import-plumbing.mjs   → 40 assertions (Phase B: identity, plan, snapshot safety, repair, name-guard)
node tools/test-curation-import-ui.mjs         → 42 assertions (Phase C/D/E: dialog wiring, Select All, no Clear All, disabled-until-selected, feature wiring)
```

Both cover every numbered case in the amendment's TESTING REQUIREMENTS
(Identity 1-4, Tag prevention 5-9, Snapshot safety 10-12, Repair 13-16,
UI/display 17-20), plus the underlying `ProfileStore.getProfileSnapshot`
seam directly against a real `ProfileStore`.

Regression: ran the entire 76-file suite under `tools/test-*.mjs` twice
(before wiring UI, and again after). One genuine regression was caught and
fixed in-session: my own edit to `createProfileFromInput()` renamed a local
variable that `tools/test-profile-sync-polish.mjs` pins by exact source
string; reverted the rename (functionally irrelevant, `name` vs `typedName`)
rather than weaken the pin. Final full-suite run:

```
FAIL: tools/test-ambient-decision-multitab.mjs   (pre-existing — verified unrelated in the prior disambiguation phase)
FAIL: tools/test-safety-reassurance.mjs          (pre-existing — verified unrelated in the prior disambiguation phase)
ALL-DONE
```

No other file fails. `node tools/check-dom-contract.js` also passes clean
(306 unique ids, 286 `getElementById` targets all present, 271 module-scope
captures, zero failures/warnings) — every new dialog, button, and id this
amendment added resolves correctly on both sides of the HTML/JS boundary.

## 13. Human testing still required

None identified as *genuinely* necessary. Every behavioral claim above is
covered by a source-level or live-`ProfileStore` assertion, and
`check-dom-contract.js` independently proves the new markup and its `main.js`
wiring are structurally consistent. The one thing this test harness cannot
observe — the dialogs' actual visual layout/scrolling in a real browser
window — is low-risk (reuses the existing, already-shipped `.app-dialog`
shell) and is offered, not required: open Settings → Curation → Import
Curation… once with a real duplicate-name export, to eyeball the Curate
Import list.

## 14. Intentionally deferred V3 lineage work (breadcrumb)

Per the brief's CRITICAL DISTINCTION, no permanent Curation identity
aliasing/lineage was built. `curation-import-identity.js`'s header is the
breadcrumb for this: "Bringing an import 'into' a SAME_NAME_DIFFERENT_ID
destination is a data transfer for THIS import only... it does not
permanently declare the two Curation ids the same Curation. That would be
distributed identity lineage, which is out of scope for this amendment."
Future Curation selection surfaces should call `displayCurationLabel()` /
`openCurationChoiceDialog()` rather than re-deriving their own duplicate-name
or identity-decision logic. If richer exports ever carry full V3 provenance,
`curation-import-parse.js` / `curation-import-plan.js` are the seams to
extend — old snapshot-style exports remain importable under today's
conservative, additive-only semantics regardless.

## 15. Reports and Docs / worktree confirmation

The pre-existing deletions under `Reports and Docs/` (Codex Reports,
North-Star, Google-Sync, PM-toolbar report) were not restored, checked out,
or regenerated at any point in this session. This report was written to the
location explicitly requested (`Reports and Docs/Claude Reports/`); nothing
was placed in `Codex Reports` or elsewhere. `git status` throughout this
session continued to show those files as `deleted:` with no attempt made to
reverse that.

## 16. Commit/push confirmation

Nothing was committed. Nothing was pushed. All changes remain as working-tree
modifications on `Cassette-V3-Amendment`, awaiting explicit approval.
