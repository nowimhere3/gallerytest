# North Star N6-4 — Startup Media + Advanced Disclosures (Implementation Report)

**Recorded:** Thursday, August 27, 2026 — 2:20 PM MDT (America/Edmonton, UTC-06:00)
**Status:** PASS
**Handoff:** `Reports and Docs/North-Star/N6/N6-3-STARTUP-MEDIA-ARCHITECTURE-HANDOFF.md`
**Baseline:** branch `SandboxSyncV3`, HEAD `c022f94` ("Complete North Star N6 zero-ceremony reopen")

## Outcome

**Feature 1 — Startup Media.** An Advanced "Startup Media" preference chooses what loads at boot:
`last-used` (default, exactly N6's existing zero-ceremony reopen, byte-identical behavior),
`random-remembered` (random pick among every remembered durable folder Browser Gallery can still
open), and `random-selected` (random pick among a customer-chosen checkbox subset). Only
`queryPermission({ mode: "read" }) === "granted"` folders are ever eligible; `requestPermission` is
never called at boot, under any policy. The startup preference persists device-locally in
`app-preferences.js`, in its own `startup` section, alongside `playback` / `presentation` /
`microArcade` / `onboarding`.

**Feature 2 — Advanced Settings disclosures.** The four functions inside Advanced Settings —
Media Library diagnostics, Arcade animations, Sync Your Curations, and the new Startup Media — are
each now their own nested `<details>`, closed by default. An audit of every programmatic
focus/scroll path that reaches into Advanced Settings found none that targets a control inside
these four sections from outside them, so no additional open-before-focus fix was needed (see
*Disclosure audit* below).

**StreamLoop seam.** `decideStartupMedia()` accepts a `context` parameter defaulting to
`"browser"`. Nothing else was built: no detection, no iframe inference, no second policy.

## What changed

### `src/storage/boot-restore.js`

Added `decideStartupMedia({ policy, rows, permissionStates, eligibleIds, random, context })`,
extending the module N6 started rather than adding a second one. `decideBootRestore()` is
**completely untouched** — `decideStartupMedia()`'s `"last-used"` branch (the default, and the
fallback for any unrecognized policy string) delegates to it directly, so the two can never drift
apart and N6's own frozen test stays valid by construction, not by parallel maintenance.

For `random-remembered` and `random-selected`, the pool is built from `rows` (structurally
re-filtered to durable FSA rows, mirroring `decideBootRestore()`'s own defensive guard), narrowed
to the eligible-id set for `random-selected` (an empty set returns `{ restore: false }` — it never
falls back to `last-used`), sorted deterministically by `lastOpenedAt` descending then `id`
ascending (so a fixed injected `random()` always resolves to the same row regardless of `rows`'
input order), then filtered to `permissionStates[row.id] === "granted"`. A single-entry granted
pool returns that entry without calling `random()` at all; a multi-entry pool calls
`pool[floor(random() * pool.length)]`, clamped defensively. `random` defaults to `Math.random`,
matching `micro-arcade-selector.js:56`'s existing injected-randomness pattern exactly — no new
seeding scheme.

"A customer gesture already in flight wins" (the handoff's step 1) is not implemented as code here:
it is already true structurally, because every caller loads the winning row through
`loadFromFsaHandle()`, which owns the one `libraryLoadGeneration`/`loadToken` guard every arming
call already gates on. Adding a second staleness check inside this pure function would have been
exactly the "new machinery" P5 (N6) already rules out.

### `src/storage/app-preferences.js`

Added a `startup` section: `DEFAULT_STARTUP = { policy: "last-used", eligibleLibraryIds: [] }`,
`startupPolicy()` (unrecognized string → `"last-used"`), `normalizeStartupEligibleLibraryIds()`
(coerces to an array of unique non-empty strings — stale ids are never pruned here; that's
`decideStartupMedia()`'s job at decision time, not this normalizer's), and
`saveStartupPreferences(partial)` wrapping the existing per-section `savePartial()`, so a startup
save can never erase a sibling section.

### `src/main.js`

- Two DOM-ref groups added: the Startup Media policy `<select>`/helper/eligible-list controls, and
  `currentStartupPreferences` (a module-level snapshot mirroring the `arcadeAnimationOrder`
  pattern already used for `microArcade`).
- `applyLoadedPreferences()` now also seeds `currentStartupPreferences` and the policy `<select>`
  from the loaded record.
- `renderStartupMediaSettings()` — rebuilds the eligible-folder checkbox list from `listLibraries()`
  every time, called from the end of `renderRecentLibraries()` so the two lists can never drift out
  of sync with each other. Each checkbox toggles membership in `eligibleLibraryIds` and saves
  immediately; checking a folder never touches its permission, identity, Curation, or Recents
  position.
- **`attemptStartupMedia()`** — new, called from `initFsaLibraries()` in place of the direct
  `attemptBootRestore()` call N6 added. For the default/unrecognized policy it `await`s
  `attemptBootRestore()` **unchanged** — the exact same function N6's frozen test already covers.
  For `random-remembered`/`random-selected` it reads `listLibraries()`, queries permission
  (`queryPermission` only, via the same `readFolderPermissionForBootRestore()` N6 already added) for
  every row in the pool, hands the result to `decideStartupMedia()`, and on a restore decision calls
  `loadFromFsaHandle(candidate.handle, candidate)` — the identical shared load path
  `attemptBootRestore()` and every Recent-row click already use. No second load implementation was
  written.
- **`attemptBootRestore()` itself was not modified at all** — same function body N6 shipped,
  verified by `git diff` showing zero changes to it and by `tools/test-boot-restore.mjs` passing
  unmodified (see *Testing* below).

### `index.html` + `styles.css`

The four sections became nested `<details>` (`summary` replacing the old `h3.profile-sync-heading`
inside three of them), closed by default, plus the new Startup Media disclosure with a policy
`<select>` and a checkbox-list container (`#startup-media-eligible-list`, hidden unless
`random-selected` is chosen). Each pre-existing element **kept its original class attribute
unchanged** (`advanced-media-library-section`, `advanced-playback-section`,
`profile-sync-section`) — the shared disclosure styling is applied structurally, via
`.advanced-settings-section > details` / `> summary` in CSS, rather than by adding a shared class
token to each element. This was a deliberate correction: an earlier pass added a shared
`.advanced-nested-section` class, which broke `tools/test-media-library-selection.mjs`'s exact
`class="advanced-media-library-section"` string match (see *Testing* below) — reverted before
finishing, in favor of the structural selector, which needed no test edited and no markup semantics
changed.

## Disclosure audit

Per the handoff: *"Audit any programmatic focus/scroll path that targets controls inside them so
the required disclosure opens before focus/scroll."* Every `scrollIntoView`/`.focus()` call in
`main.js` was traced:

- `resetFolderLinkSelection()` focuses `profileFolderLinkSelect` — but its only two callers
  (`profileFolderLinkCancelBtn`'s click, and Escape on `profileFolderLinkRow`) both fire on
  elements *already inside* the Media Library diagnostics `<details>`. A customer cannot click or
  keyboard-focus either without that section already being open, so there is no closed-section case
  to guard against.
- `profileFolderLibrarySyncBtn`'s click handler (`profileSyncGroup.scrollIntoView(...)` +
  `profileSyncV3ChooseBtn.focus()`) targets `#profile-sync-group` — the **top-level, always-open**
  Sync group inside `.profile-section` (`open` attribute, never collapsed by this slice). That is a
  different element from the Advanced "Sync Your Curations" disclosure (`.profile-sync-section`,
  `id="profile-sync-section"`) this slice nested. The button itself lives inside Media Library
  diagnostics, so it's reachable only when that section is already open — and its target was never
  one of the four sections being nested, so it needed no change.
- `expandAndScrollToProfileSection()` and `expandAndScrollToTagsSection()` target `.profile-section`
  and `.tags-admin-section` respectively — both are siblings of `.advanced-settings-section`, not
  descendants of it, and were untouched by this slice.
- No other function reads or writes `.open` on any of the four sections or on
  `.advanced-settings-section` itself.

**Conclusion: no existing focus/scroll path needed an open-before-focus fix.** All interactions
that reach a control inside one of the four sections originate from inside that same section.

## How the N6-3 "four rules easy to get wrong" map to the code

| Rule | Where enforced |
| --- | --- |
| Filter to `granted` after building the pool, never before | `pickGrantedRow()` filters `permissionStates` last, after the policy-specific pool is built |
| `last-used` still consults `rows[0]` only | Delegates directly to the unmodified `decideBootRestore()` |
| Empty eligible set under `random-selected` → no restore, no last-used fallback | Explicit `eligibleSet.size === 0` check returns before any pooling |
| Sort the pool deterministically before indexing | `sortStartupPoolDeterministically()`: `lastOpenedAt` desc, then `id` asc |

## Automated verification

- `tools/test-startup-media.mjs` — **new**, PASS, 61 assertions: the full decision table from the
  handoff (`last-used` granted/not-granted-no-fallthrough, `random-remembered` none/subset
  granted, determinism under a fixed `random`, `random-selected` empty/stale/mixed eligible sets,
  unknown-policy-behaves-as-last-used, `context` omitted behaves as `"browser"`, no code path can
  return a "request permission" outcome), preferences round-trip + normalization +
  sibling-section-survives-a-startup-save, DOM assertions that all four sections are closed
  `<details>` (and that the outer Advanced Settings `<details>` is still closed too), and
  `main.js` wiring assertions (`attemptStartupMedia()` delegates to the unmodified
  `attemptBootRestore()` for the default policy, uses the shared `loadFromFsaHandle()` for the
  random policies, and never calls `requestPermission`/`removeFromRecents`).
- `tools/test-boot-restore.mjs` — **verified unchanged** (`git diff` shows zero changes to this
  file) and still PASS, 24/24 assertions, confirming N6 semantics did not move.
- `tools/check-dom-contract.js` — PASS: 55 JS files parse, 256 unique ids (0 duplicates), 242
  `getElementById` targets all present, all aria/label references resolve, all local asset/module
  paths resolve, 241 module-scope element captures (was 236 before this slice — the 5 new Startup
  Media DOM refs), no destructive DOM ops on workspace-named variables.
- Full repository suite — PASS, 60 test files total: 59 run directly (60s timeout each), all
  green, plus `tools/test-sync-v2-scheduler.mjs` (the same pre-existing real-timer test noted in
  N6's own report — needs ~2 minutes of wall-clock time, unrelated to this slice, confirmed
  separately with 34 assertions / 0 failures).
- One transient, unrelated flake observed and resolved during the run: `test-sync-publish.mjs`
  failed once on a `tagActivity` mid-write timing assertion (no code this slice touches is anywhere
  near sync-publish), then passed cleanly on three consecutive reruns — a pre-existing flake, not a
  regression.
- One regression caught and fixed during implementation, not shipped: an earlier pass added a
  shared `.advanced-nested-section` class to all four disclosure elements, which broke
  `test-media-library-selection.mjs`'s exact `class="advanced-media-library-section"` string match.
  Fixed by reverting to the original class attributes and moving the shared summary/spacing styling
  to a structural `.advanced-settings-section > details` CSS selector instead — see *What changed*
  above. `test-media-library-selection.mjs` now passes (77 assertions) with **no edits** to that
  test file.
- `node --check` on every touched `.js` file — PASS.

## Out of scope, confirmed untouched

No StreamLoop detection, iframe inference, or second policy was added — `context` exists purely as
an accepted, defaulted, unused-for-now parameter with a `BREADCRUMBS — WILL BE / FUTURE` comment
at its definition. `resumeLibrary()`'s explicit-click behavior (its `requestPermission` prompt and
`removeFromRecents` pruning) is unmodified. No folder loads more than one item at startup under any
policy. No weighting/ordering/rotation/"don't repeat" logic was added. No existing users were
migrated to a non-default policy — `DEFAULT_STARTUP.policy` is `"last-used"`. Stage 08/09, MEDIA-ID,
SyncV3, and N1–N5 policy modules are untouched.

## Changed files

- `index.html`
- `src/main.js`
- `src/storage/app-preferences.js`
- `src/storage/boot-restore.js`
- `styles.css`
- `tools/test-startup-media.mjs` (new)
- `Reports and Docs/North-Star/N6/N6-4-IMPLEMENTATION-REPORT.md` (this report)

No commit was created and nothing was pushed.
