# N6-1 — Zero-Ceremony Reopen (Architecture Handoff)

**Thursday, August 27, 2026 — 12:42 PM MDT** (America/Edmonton)

*Revision 2 — shared-load-path vs Recents-pruning boundary made explicit; required human
verification removed.*

**Slice:** N6 — Zero-Ceremony Reopen
**Role of this document:** architecture handoff for the implementer. Not an implementation.
**Baseline:** branch `SandboxSyncV3`, HEAD `106c07f` ("Complete North Star N2 device-aware media
questions"), worktree clean, 58 test files.
**Constitution:** `Reports and Docs/NORTH-STAR.md` — it outranks this document.

---

## 1. Customer outcome

> **Open Browser Gallery → your media is already there.**

Today, every session begins with the customer telling Browser Gallery something it already knows:
*which folder they were using.* The folder is remembered, its handle is stored, its Curation is
resolved — and the customer still has to click.

After N6, when the browser still holds the folder permission, Browser Gallery opens straight into
the media. When it does not, nothing changes: the Recent list works exactly as it does now.

This is the browser's honest approximation of the native promise. It does not fake native
persistence, and it does not prompt.

---

## 2. Why this slice is next

**It is the last remaining North Star behaviour that costs the customer work on the ordinary
path.** N1–N5 removed concepts, questions and duplicate representations. What remains is a
*mechanical* step, repeated every session, whose answer Browser Gallery already holds.

Three pieces of evidence make it ready now:

**(a) The current refusal is a pre-North-Star decision that the codebase has already outgrown.**
`src/main.js:11250-11257` declines to check permission at boot:

> *"This is a pure metadata read — it does NOT check/request permission or load anything on its
> own (requestPermission needs a user gesture, and queryPermission-only would still mean silently
> touching folder access on every page load without the user asking)."*

That comment predates the North Star. `queryPermission` is now called from non-gesture background
paths in **six** modules — `fsa-ancestry.js`, `fsa-existence.js`, `profile-sync.js`, `sync-v2.js`,
`sync-v3.js` and `main.js` itself. The discipline the project actually settled on is
*queryPermission-never-requestPermission*, which N6 follows exactly.

**(b) The precedent is already shipped, twelve lines below the refusal.** `profileSync.init()`
silently reconnects a remembered **Sync Folder** at boot when permission is still usable. Browser
Gallery already does this for its own plumbing folder. N6 extends the same proven pattern to the
folder the customer actually cares about.

**(c) Nothing new has to be stored.** `listLibraries()` already filters out legacy rows and rows
removed from Recents, and already sorts by `lastOpenedAt` descending
(`library-registry.js:177-178`). The target is `listLibraries()[0]`.

**Why before Google / Native.** Both future initiatives promise reduced ceremony. N6 establishes
the *restore semantics* — what gets restored, under what proof, and how it degrades — in the
cheapest environment available, before either initiative inherits them. It also directly advances
"press go → start go": an Automation cannot address a source that is not loaded.

Governing rules applied: **If Browser Gallery knows, do not ask.** **Make the machine think harder
so the human thinks less.**

---

## 3. Exact behaviour

At boot, after the existing library render:

```text
1. rows = listLibraries()                      (already sorted, already filtered)
2. candidate = rows[0]                          most recently opened durable FSA row
3. if no candidate                              → do nothing (today's behaviour)
4. state = await candidate.handle.queryPermission({ mode: "read" })
5. if state === "granted"                       → load it through the EXISTING load path
   else                                         → do nothing (today's behaviour)
```

That is the whole policy. No prompt, ever. No second-choice fallback if `rows[0]` is not granted —
trying `rows[1]`, `rows[2]`… would be Browser Gallery guessing which folder the customer wanted.

### Honest limits — do not overclaim these

File System Access permission does **not** reliably survive a browser restart. It generally
persists within a session and across soft reloads; across a full restart it survives only where
the browser itself persists the grant (notably an installed PWA). So N6 delivers zero-ceremony
reopen **whenever the browser still holds the grant**, and exactly today's one click otherwise.

Do not describe this to the customer as "Browser Gallery remembers your folder forever", and do
not add a mechanism that tries to make it appear so.

---

## 4. Precedence and invariants

**P1 — Never prompt at boot.** `queryPermission` only. `requestPermission` requires a gesture and
must remain confined to `resumeLibrary()`. A boot path that prompts is an immediate stop.

**P2 — Proof, not inference.** Restore only on `"granted"`. `"prompt"`, `"denied"`, a missing
handle, a missing API, or any throw all mean *do nothing*. This is the same three-state discipline
`fsa-ancestry.js` and `fsa-existence.js` already enforce: the absence of a result is never a
positive one.

**P3 — One load path, minus the explicit-click failure behaviour.** State it precisely, because
P3 and P6 together define a boundary rather than a contradiction:

> **Boot restore must reuse the normal granted-folder loading machinery so that Curation
> restoration, Stage 09, MEDIA-ID, N3, N4 and N2 behave identically — while excluding the
> explicit-click failure and Recents-pruning behaviour.**

The *loading* is shared. The *failure handling* is not. Concretely, boot restore must reach
`restoreProfileForLoadedLibrary` → Stage 09 `resolveLoadTimeSwitch`, MEDIA-ID scope resolution,
and the N2/N3/N4 arming exactly as a Recent-row click does; it must **not** inherit
`resumeLibrary()`'s `requestPermission` prompt or its `removeFromRecents()` call (see P1 and P6).

**A parallel boot-only load path is the primary failure mode of this slice.** If the implementer
finds themselves duplicating load logic, stop.

**Sonnet may extract the safe shared portion** of `resumeLibrary()` into a common function that
both callers use, leaving the prompt and the pruning in the explicit-click wrapper. That is the
preferred shape if the current structure does not already allow reuse cleanly. Extracting is
refactoring; re-implementing is not.

**P4 — Auto-restore answers no question.** N2's device-aware question, N4's reverse suggestion and
Stage 09's offers must arm exactly as on a manual open, and must still wait for the customer.
Restoring a folder is not consent to anything else.

**P5 — A customer gesture always wins.** If the customer picks a folder or clicks a Recent row
while boot restore is in flight, their choice wins. Use the existing `libraryLoadGeneration` /
`loadToken` guards — do not invent new staleness machinery.

**P6 — A boot-time failure never prunes Recents.** `resumeLibrary()` calls `removeFromRecents()`
when a handle proves invalid; that is correct for an *explicit* click, where the customer is
present and watching. It is **wrong** at boot — a transient failure must not silently delete the
customer's remembered folder. Boot restore fails silently and changes nothing. This is the
exclusion named in P3, and it is the reason the two callers share loading but not failure
handling.

**P7 — No new Settings surface.** No toggle, no group, no preference row. (Constitution
anti-pattern 13.) The affordance already exists: choose a different folder, or remove it from
Recents.

**P8 — Legacy is excluded structurally.** `webkitdirectory` rows have no handle and are already
filtered by `listLibraries()`. No special-casing needed; do not add any.

---

## 5. Files and seams

| File | Expected change |
| --- | --- |
| **new** `src/storage/boot-restore.js` (or `src/profile/`) | The **pure** decision: `decideBootRestore({ rows, permissionStates })` → `{ restore: false }` or `{ restore: true, rowId }`. No I/O, no DOM. This is what makes the policy exhaustively testable |
| `src/main.js` `initFsaLibraries()` ~L11249 | After `renderRecentLibraries()`, consult the decision, then call the existing load path. **Replace the stale WHY comment** with one stating the current rule and its precedent |
| `src/storage/library-registry.js` | Expected: **no change**. Ordering and filtering already exist |

Everything else — Stage 08/09, MEDIA-ID, SyncV3, N1–N5 modules, providers, runtime — is untouched.

---

## 6. Out of scope

- Any preference, toggle or Settings control for auto-restore
- Restoring more than one folder, or falling back to a second candidate
- Any change to `resumeLibrary()`'s explicit-click behaviour, including its `removeFromRecents`
- Prompting for permission at boot, under any condition
- Native work, Google/OAuth work, or any transport change
- Changes to Stage 08 link semantics or Stage 09 decision rules
- Changes to MEDIA-ID, N2, N3, N4 or N5 policy
- Auto-answering, auto-dismissing or suppressing any customer question
- Persisting or caching permission state — it is queried live, every boot

---

## 7. Deterministic tests required

**New — `tools/test-boot-restore.mjs`.** Exhaustive table over the pure decision:

| Input | Expected |
| --- | --- |
| no rows | no restore |
| rows exist, `rows[0]` permission `granted` | restore `rows[0]` |
| `rows[0]` permission `prompt` | no restore |
| `rows[0]` permission `denied` | no restore |
| `rows[0]` handle missing / no `queryPermission` | no restore |
| `queryPermission` throws | no restore |
| `rows[0]` `prompt`, `rows[1]` `granted` | **no restore** — never fall through |
| legacy / `removedFromRecents` rows | never candidates |

Assert additionally that the decision function has **no** code path that can return a "request
permission" outcome.

**Integration.** Assert boot restore reaches the shared load path (so Curation restoration and the
N2/N3/N4 arming run), and that a competing customer load supersedes an in-flight boot restore via
the existing generation guard.

**Regression.** The full suite passes unchanged — in particular `test-media-library-disclosure`,
the N2/N3/N4/N5 suites, Stage 08/09 suites, and every MEDIA-ID and SyncV3 suite. **No existing
test should need editing.** If one does, N6 has changed semantics it was not supposed to touch.

---

## 8. Human verification

**HUMAN TEST REQUIRED: NO.**

N6's correctness is fully determined by its decision table, and permission state is an injected
input, so every branch is deterministically testable in Node.

An earlier revision proposed one browser-restart observation. It is withdrawn: **both outcomes are
valid**. Whether a given browser or profile still holds the grant after a restart decides only
*which* correct behaviour appears — restore, or today's one click — and never whether N6 is right.
Asking a human to observe that would be gathering platform trivia under the guise of verification,
which the README's testing rule exists to prevent.

Real-world permission-persistence behaviour will be observed organically through ordinary use. If
it ever turns out to matter to a decision, that is its own small investigation, not a gate on this
slice.

## 9. Slice sizing

Small. One pure decision module, one call site, one stale comment corrected, one new test file.
No storage, fact, transport or identity change. Fully reversible by deleting the call site.

**Suitable for Sonnet:** yes. The policy is fully specified above, the risky part is isolated in a
pure function with an exhaustive table, and the one genuine hazard (P3 — duplicating the load
path) is named explicitly.

### Breadcrumbs to add

```text
BREADCRUMBS — IS: boot restores the most recent durable folder only when queryPermission
  already reports "granted". Never requestPermission — that needs a gesture. Anything other
  than "granted" does nothing at all.
BREADCRUMBS — WAS: boot deliberately avoided touching permission, on the reasoning that even
  queryPermission was "silently touching folder access". Six modules now query permission from
  background paths, and profileSync.init() already silently reconnects the Sync Folder on the
  same basis; the ordinary media folder was the last one still asking the customer for an
  answer Browser Gallery already had.
BREADCRUMBS — WILL BE / FUTURE: native owns durable folder access and restores without any
  permission question. Keep this decision pure and permission-shaped so the native provider
  substitutes its own always-granted answer rather than needing different policy.
```
