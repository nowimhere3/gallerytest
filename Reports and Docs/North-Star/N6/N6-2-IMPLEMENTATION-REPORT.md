# North Star N6 — Zero-Ceremony Reopen (Implementation Report)

**Recorded:** Thursday, August 27, 2026 — 1:06 PM MDT (America/Edmonton, UTC-06:00)
**Status:** PASS
**Handoff:** `Reports and Docs/North-Star/N6/N6-1-ARCHITECTURE-HANDOFF.md`

## Outcome

At boot, Browser Gallery now silently restores the most recently opened durable FSA folder
whenever `queryPermission({ mode: "read" })` already reports `"granted"` for it — reaching the
customer's media with no click. Every other outcome (`"prompt"`, `"denied"`, a missing handle, a
missing API, a thrown error) does nothing at all, and today's one-click Recent-folder workflow is
completely unchanged.

`requestPermission()` is never called at boot. There is no fallback to a second candidate.

## What changed

**New — `src/storage/boot-restore.js`.** One pure function, `decideBootRestore({ rows,
permissionStates })`. No I/O, no DOM. It looks only at `rows[0]` (the row `listLibraries()` already
sorted to the front) and the pre-resolved permission state for that one row's id, and returns
either `{ restore: false }` or `{ restore: true, rowId }`. It never inspects `rows[1]` or beyond —
falling through to a second candidate would be Browser Gallery guessing which folder the customer
wanted, which the handoff rules out explicitly. It also independently guards against a
`sourceKind: "legacy"` or `removedFromRecents` row reaching `rows[0]`, as a second, structural line
of defense on top of `listLibraries()`'s own filtering.

**`src/main.js`.** Two new functions just above `initFsaLibraries()`:

- `readFolderPermissionForBootRestore(handle)` — a `queryPermission`-only wrapper that resolves a
  missing handle, a missing API, or a thrown error to a non-`"granted"` string instead of
  throwing, mirroring the same defensive shape `fsa-ancestry.js`'s `readPermission()` already uses
  for background permission reads elsewhere in the codebase.
- `attemptBootRestore()` — reads `listLibraries()`, resolves permission for `rows[0]` only, asks
  `decideBootRestore()`, and on a restore decision calls `loadFromFsaHandle(candidate.handle,
  candidate)` — the exact same function a Recent-row click reaches after `resumeLibrary()`
  confirms permission. This is not a second load path: `loadFromFsaHandle()` is already the single
  function both the folder picker and `resumeLibrary()` call into, and boot restore now becomes its
  third caller. Curation restoration, Stage 09, MEDIA-ID, and the N2/N3/N4 arming all run exactly
  as they do on a manual open, because they live inside `loadFromFsaHandle()` itself and nothing
  there changed.

`initFsaLibraries()` now calls `attemptBootRestore()` (unawaited, same pattern as
`profileSync.init()` just below it) after its existing `renderRecentLibraries()` call. The stale
`[LIBRARY-REGISTRY]` comment that refused to touch permission at boot — reasoning the handoff
identifies as pre-dating the North Star — was replaced with a `BREADCRUMBS — WAS` explaining why
that refusal no longer applies, plus an `IS`/`WHY` pair on the two new functions.

**`resumeLibrary()` was not touched.** Its `requestPermission()` call and its
`removeFromRecents()`-on-failure branch are exactly what boot restore must exclude (P1/P6), so
rather than extract and re-parameterize that function, `attemptBootRestore()` uses its own
minimal, separate permission read and calls `loadFromFsaHandle()` directly. The one genuinely
shared piece — the granted-folder load machinery — was already a clean, independently callable
function before N6, so no further extraction was needed to reuse it. This was a deliberate choice
to minimize risk to `resumeLibrary()`'s existing, already-tested explicit-click behavior; see
*Design note* below.

**New — `tools/test-boot-restore.mjs`.** The exhaustive decision table from the handoff (11 numbered
sections, 24 assertions): no rows, `rows[0]` granted/prompt/denied, missing handle/API, a thrown
`queryPermission`, the never-fall-through case (`rows[0]` prompt + `rows[1]` granted), legacy/removed
rows at `rows[0]`, and an exhaustive scan proving no reachable decision shape ever mentions
"request" in any form. Two integration sections, following the same main.js-source-slicing pattern
`test-n2-device-aware-media-question.mjs` and `test-media-library-disclosure.mjs` already use
(`main.js` cannot be instantiated headlessly — it is wired directly to the DOM): one proves
`attemptBootRestore()`'s body calls `decideBootRestore()` and `loadFromFsaHandle()` and contains
neither `requestPermission` nor `removeFromRecents`, while `resumeLibrary()`'s body still contains
both; the other proves `loadFromFsaHandle()` still bumps the single shared
`libraryLoadGeneration` counter and that the N2/N3/N4/Stage-09 arming calls still gate on it — the
existing guard P5 asks boot restore to rely on, unmodified.

## Design note — why no extraction from `resumeLibrary()`

The handoff allows (but does not require) extracting "the safe shared portion of `resumeLibrary()`"
into a common function "if the current structure does not already allow reuse cleanly." Looking at
`resumeLibrary()`, its only genuinely shared step is the final `await
loadFromFsaHandle(dirHandle, record)` call once permission is confirmed — and that function was
already directly importable/callable, not embedded inline. Wrapping `resumeLibrary()`'s permission
check in a helper shared with boot restore was considered and rejected: `readFolderPermissionForBootRestore()`
swallows a thrown `queryPermission` into a string rather than letting it propagate, and
`resumeLibrary()`'s existing `try/catch` relies on that throw reaching its `catch` block to trigger
`removeFromRecents()`. Sharing the helper would have required `resumeLibrary()` to re-detect the
swallowed error some other way, which is exactly the kind of quiet semantic change the handoff
warns against ("no existing test should need editing"). Keeping the two permission reads separate
— one seven-line wrapper apiece — cost less than the risk of coupling them.

## How P1–P8 map to the code

| Invariant | Where enforced |
| --- | --- |
| P1 — never prompt at boot | `readFolderPermissionForBootRestore()` only calls `queryPermission`; `attemptBootRestore()`'s body contains no `requestPermission` (asserted by test §10) |
| P2 — proof, not inference | `decideBootRestore()` requires `state === "granted"` exactly; every other value (including thrown-error strings) falls to `{ restore: false }` |
| P3 — one load path | `attemptBootRestore()` calls the same `loadFromFsaHandle()` as `resumeLibrary()`; no second load implementation exists (asserted by test §10) |
| P4 — auto-restore answers no question | Unchanged: N2/N3/N4/Stage-09 arming happens inside `loadFromFsaHandle()`, identical on every caller |
| P5 — a customer gesture wins | `attemptBootRestore()` adds no new staleness guard; it inherits `libraryLoadGeneration`/`loadToken` because it calls the same `loadFromFsaHandle()` (asserted by test §11) |
| P6 — boot failure never prunes Recents | `attemptBootRestore()`'s body contains no `removeFromRecents` (asserted by test §10); `resumeLibrary()`'s still does |
| P7 — no new Settings surface | None added |
| P8 — legacy excluded structurally | `listLibraries()` unchanged; `decideBootRestore()` also independently guards `sourceKind === "legacy"` / `removedFromRecents` at `rows[0]` |

## Automated verification

- `tools/test-boot-restore.mjs` — PASS, 24 assertions (decision table + integration wiring).
- Full repository suite — PASS, 59 test files total: 58 run directly (60s timeout each), all
  green, plus `tools/test-sync-v2-scheduler.mjs` (a pre-existing real-timer test unrelated to N6,
  confirmed separately — it needs roughly two minutes of wall-clock time and passed with 34
  assertions, 0 failures).
- `node --check` on `src/main.js` and `src/storage/boot-restore.js` — PASS.
- `git diff --check` — PASS, no whitespace errors.
- No existing test file required any edit.

## Out of scope, confirmed untouched

`library-registry.js`, Stage 08/09 semantics, MEDIA-ID, N2, N3, N4, N5 policy, SyncV3, and
`resumeLibrary()`'s explicit-click behavior are all unmodified. No Settings toggle, group, or
stored permission state was added; permission is queried live on every boot.

## Changed files

- `src/main.js`
- `src/storage/boot-restore.js` (new)
- `tools/test-boot-restore.mjs` (new)
- `Reports and Docs/North-Star/N6/N6-2-IMPLEMENTATION-REPORT.md` (this report)

No commit was created and nothing was pushed.
