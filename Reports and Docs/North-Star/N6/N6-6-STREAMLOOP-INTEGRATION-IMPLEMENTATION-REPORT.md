# North Star N6-6 — BG ↔ StreamLoop Integration (Implementation Report)

**Recorded:** Thursday, August 27, 2026 — 3:55 PM MDT (America/Edmonton, UTC-06:00)
**Status:** PASS
**Handoff:** `Reports and Docs/North-Star/N6/N6-5-STREAMLOOP-INTEGRATION-ARCHITECTURE-HANDOFF.md`
**Baseline:** branch `SandboxSyncV3`, HEAD `1badbf6` ("Add North Star N6 startup media policies")

## Outcome

**Launch context.** `src/runtime/launch-context.js` (new) exports `parseLaunchContext(search)`, a
pure function parsing `?launch=streamloop` (case-insensitive on the value, exact on the param name)
into `LAUNCH_CONTEXT_STREAMLOOP`; everything else — missing, empty, misspelled, malformed — resolves
to `LAUNCH_CONTEXT_BROWSER`, never throwing. `main.js` calls it exactly once, at module load, into a
`const launchContext`. It is never written to `app-preferences.js` or any other persistence — every
page load re-derives it fresh from the URL that tab actually opened with.

**Dual Startup Media.** `app-preferences.js`'s `startup` section is now `{ browser: {...},
streamloop: {...} }`, each an independent `{policy, eligibleLibraryIds}` record with its own
selected-folder pool. A record written by N6-4 (`startup: {policy, eligibleLibraryIds}` directly, no
`browser`/`streamloop` keys) migrates non-destructively on read: that value becomes the customer's
`browser` policy verbatim; `streamloop` starts at today's safe default (`last-used`, empty pool).
`saveStartupPreferences(context, partial)` now takes an explicit context and does its own two-level
read-merge (not the generic one-level `savePartial()`), so saving one field in one context can never
clobber a sibling field in the same context or touch the other context at all.

**Boot resolution.** `attemptStartupMedia()` resolves `activeContext` from the live `launchContext`
(`streamloop` only when the tab was launched with `?launch=streamloop`; `browser` otherwise) and
reads `currentStartupPreferences[activeContext]` **before** calling `decideStartupMedia()`.
`decideStartupMedia()` itself is untouched — same signature, same 61 pre-existing assertions, still
single-policy-in/single-decision-out. The dual-context branch lives entirely at the main.js boundary
that already knows `launchContext`, exactly as the handoff specified.

**PLAY/PAUSE bridge.** `src/runtime/streamloop-bridge.js` (new) exports `parseStreamLoopMessage(data)`
and `nextPendingIntent(intent)` — pure functions matching the exact message shape confirmed by
reading `js/launch.js` in the read-only `nowimhere3/GS3` reference repo:
`{ type: "LAUNCHPAD_PLAY" | "LAUNCHPAD_PAUSE" }`, no bare-string fallback. `main.js` registers a
`window.addEventListener("message", ...)` **only** inside `if (launchContext ===
LAUNCH_CONTEXT_STREAMLOOP)` — an ordinary browser tab never adds this listener. Source validation
checks `event.source === window.parent && event.source !== window` (not `event.origin`, since GS3
posts with target origin `'*'` and has no fixed origin to pin). Readiness is
`state.hasVisibleItems` — the exact condition that already enables the manual Play button
(`canNavigate`, `main.js`). A message arriving before readiness overwrites a module-level pending
intent (latest wins, so PAUSE supersedes an earlier pending PLAY with no special-cased branch); once
ready, every message applies immediately through `runtime.play()`/`runtime.stop()` — the same calls
`togglePlay()` already uses. No `LAUNCHPAD_READY` acknowledgement was built; both new modules carry a
`BREADCRUMBS — WILL BE / FUTURE` note on why, and on the native/WebView door this contract keeps
open.

**Advanced Settings spacing.** `.advanced-settings-section > details:first-of-type`'s `margin-top`
changed from the hard `0` to `12px` — a small, structural fix (the selector still targets
"whichever section is first," not "Media Library diagnostics" specifically), so any future reordered
section inherits it automatically.

## What changed

### `src/runtime/launch-context.js` (new)

`LAUNCH_CONTEXT_BROWSER`, `LAUNCH_CONTEXT_STREAMLOOP`, `parseLaunchContext(search)`. Pure, no
`window` access inside the function itself — the caller hands in the string. Carries the
`BREADCRUMBS — WILL BE / FUTURE` note from the handoff on a future native host reusing the same
`?launch=streamloop` contract.

### `src/runtime/streamloop-bridge.js` (new)

`STREAMLOOP_MESSAGE_PLAY`/`STREAMLOOP_MESSAGE_PAUSE`, `parseStreamLoopMessage(data)`,
`nextPendingIntent(intent)`. Pure. Carries the `BREADCRUMBS — WILL BE / FUTURE` note on decoupling
accepted intents from the postMessage transport, and on why `LAUNCHPAD_READY` stays unbuilt (GS3's
visibility-driven sender doesn't wait for one, and adding it would require a GS3 change).

### `src/storage/app-preferences.js`

- `DEFAULT_STARTUP_POLICY` (the old flat shape) is now the template for `DEFAULT_STARTUP.browser`
  and `DEFAULT_STARTUP.streamloop` independently.
- `normalizeStartupSection(value)` — the existing `startupPolicy()`/
  `normalizeStartupEligibleLibraryIds()` helpers applied to one context's record; reused verbatim,
  not forked.
- `normalizeStartupContexts(startupSource)` — detects the legacy N6-4 flat shape structurally (no
  `browser`/`streamloop` key present, but `policy`/`eligibleLibraryIds` is) and migrates it into
  `browser`, leaving `streamloop` at defaults. No `DATABASE_VERSION` bump, same reasoning
  `autoplayOnFill`'s own comment already documents: the store's shape didn't change, only the
  record's, and every record is reshaped on every read.
- `normalizeRecord()`'s `startup:` field is now `normalizeStartupContexts(startupSource)`.
- `saveStartupPreferences(context, partial)` rewritten to do its own two-level read-merge
  (`{...current.startup, [key]: {...current.startup[key], ...partial}}`) rather than delegating to
  the generic one-level `savePartial()`, which would have replaced the whole target context's
  sub-object and silently dropped whichever field the caller didn't include.

### `src/main.js`

- New imports: `parseLaunchContext`/`LAUNCH_CONTEXT_STREAMLOOP` from `launch-context.js`;
  `parseStreamLoopMessage`/`nextPendingIntent` from `streamloop-bridge.js`.
- `const launchContext = parseLaunchContext(window.location.search);` — computed once, near the top
  of the module, before any DOM refs or preference loading.
- The five flat `startupMedia*` DOM refs became `startupMediaControls = { browser: {...}, streamloop:
  {...} }`, each holding the five refs (`policySelect`, `policyHelper`, `eligibleSection`,
  `eligibleEmpty`, `eligibleList`) for that context, keyed by the same `"browser"`/`"streamloop"`
  strings `app-preferences.js` uses.
- `currentStartupPreferences` is now `{ browser: {...}, streamloop: {...} }`; its safe pre-load
  default mirrors `DEFAULT_STARTUP`.
- `renderStartupMediaSettings()` takes a `context` param and is called twice from
  `renderRecentLibraries()` (once per context) so neither pool's checkbox list can drift from
  `listLibraries()`'s population or from each other.
- `updateStartupMediaPolicyHelper()` takes a `context` param.
- The single policy-`<select>` change listener became a `for (const context of ["browser",
  "streamloop"])` loop wiring both selects independently, each saving through
  `saveStartupPreferences(context, {...})`.
- `applyLoadedPreferences()` seeds both contexts' selects/helpers from `preferences.startup[context]`.
- `attemptStartupMedia()` resolves `activeContext` from `launchContext` and reads
  `currentStartupPreferences[activeContext]` before doing anything else; the rest of the function
  (permission-only queries, `decideStartupMedia()` call, `loadFromFsaHandle()` load) is unchanged
  from N6-4.
- New block, gated on `launchContext === LAUNCH_CONTEXT_STREAMLOOP`, registered after the
  `beforeunload` listener: the `message` event listener (source-validated via
  `event.source === window.parent`), the pending-intent variables, and a `runtime.subscribe()`
  callback that flips `streamLoopReady` on the first `state.hasVisibleItems` and applies whatever
  intent was pending.

### `index.html`

The single "Startup Media" `<details>` now contains two `.startup-media-context-group` blocks —
"Normal Browser Gallery" and "When launched by StreamLoop" — each with its own policy `<select>`,
helper `<p>`, and eligible-folder checkbox container, using the renamed/new ids from the handoff's
Part 2 table. No new nested `<details>` was added; the disclosure count stays at four.

### `styles.css`

- `.advanced-settings-section > details:first-of-type` `margin-top`: `0` → `12px`.
- New `.startup-media-context-group + .startup-media-context-group` (20px gap between the two
  blocks) and `.startup-media-context-heading` (matches the existing nested-summary weight/size).

### `tools/test-startup-media.mjs`

Sections 13/14 rewritten for the dual shape and the new `saveStartupPreferences(context, partial)`
signature. Added: §14b (browser/streamloop independence, including the two-level-merge gotcha —
saving only `streamloop`'s policy must not drop its own already-saved `eligibleLibraryIds` or touch
`browser` at all), §14c (a hand-written legacy flat record migrates into `browser`, `streamloop`
starts at defaults), §15b (both id sets present in `index.html`, the five old un-prefixed N6-4 ids
are gone — renamed, not duplicated — and both customer-facing labels are present), §15c (the CSS
spacing rule is no longer hard-zeroed and is a small nonzero value). §16 extended with two
assertions that `attemptStartupMedia()`'s body actually resolves `activeContext` from
`launchContext`/`LAUNCH_CONTEXT_STREAMLOOP` before reading `currentStartupPreferences`. All
pre-existing decision-table assertions (§1–§12) are untouched and still pass against the unmodified
`decideStartupMedia()`.

### `tools/test-launch-context.mjs` (new)

The full decision table from the handoff's Part 1: exact match, case-insensitivity on the value,
exact param-name matching (a typo never matches), missing/empty/malformed → browser, duplicate-param
first-occurrence-wins, no-throw on malformed input, whitespace tolerance, and a source-level check
that `parseLaunchContext()`'s own function body never touches `window.*`, `referrer`, or user agent.

### `tools/test-streamloop-bridge.mjs` (new)

Pure-function tests for `parseStreamLoopMessage()` (the real GS3 object shape, tolerance of extra
fields, unknown type, no bare-string fallback, non-object/non-string inputs never throw) and
`nextPendingIntent()` (latest wins, unrecognized intent → null). Plus source-level wiring assertions
against `main.js`: the listener is registered only inside the `launchContext` guard and nowhere
outside it; source validation checks `event.source`/`window.parent`/`window`, not `event.origin`;
readiness is `state.hasVisibleItems`, not the weaker `state.hasItems`; PLAY/PAUSE apply through
`runtime.play()`/`runtime.stop()`; no `requestPermission`, no `LAUNCHPAD_READY`, no `postMessage()`
sent back to StreamLoop; and `main.js` never references `window.top`/iframe framing anywhere.

## Automated verification

- `tools/test-launch-context.mjs` — **new**, PASS, 20 assertions.
- `tools/test-streamloop-bridge.mjs` — **new**, PASS, 40 assertions.
- `tools/test-startup-media.mjs` — PASS, 99 assertions (was 61 under N6-4; grew with the dual-context
  round-trip, migration, independence, DOM, spacing, and wiring assertions above). Every pre-existing
  `decideStartupMedia()` decision-table assertion still passes against the function's unmodified
  source.
- `tools/test-boot-restore.mjs` — **verified unchanged** (`git diff --stat` shows zero changes to this
  file) and still PASS, 24/24 assertions.
- `tools/check-dom-contract.js` — PASS: 57 JS files parse, 261 unique ids (0 duplicates), 247
  `getElementById` targets all present, all aria/label references resolve, all local asset/module
  paths resolve, 236 module-scope element captures, no destructive DOM ops on workspace-named
  variables.
- Full repository suite — PASS, 62 test files total, run individually: 61 with a 60s timeout each,
  plus `tools/test-sync-v2-scheduler.mjs` (the same pre-existing real-timer test N6-4's own report
  already noted needs ~2 minutes of wall-clock time, unrelated to this slice — confirmed separately,
  34/34 assertions).
- `node --check` on every touched/new `.js` file — PASS.
- `git diff --stat src/storage/boot-restore.js` — empty. `decideStartupMedia()` and `decideBootRestore()`
  are byte-identical to the N6-4 baseline.

## Invariants confirmed

- `window.top`/`window.self`/`.referrer`/user-agent do not appear anywhere in
  `launch-context.js`'s `parseLaunchContext()` body or in `main.js` — StreamLoop identity comes from
  `?launch=streamloop` alone.
- `launchContext` is a plain `const`, never passed to any `save*Preferences()` call, never read back
  from IndexedDB.
- No GS3 file was read for anything other than confirming the message contract (`js/launch.js`); no
  GS3 file was written.
- No STREAM/GRID distinction exists anywhere in the new code.
- `requestPermission` is never called by `attemptStartupMedia()`, `attemptBootRestore()`, or the
  StreamLoop bridge — only `queryPermission({mode:"read"})`, exactly as N6/N6-4 established. Only
  `"granted"` rows are ever eligible, under either context.
- The bridge's only two runtime-mutating calls are `runtime.play()` and `runtime.stop()` — no direct
  DOM manipulation, no bypass of `MediaRuntime`.
- No Curation, MEDIA-ID, or SyncV3 code was touched.

## Out of scope, confirmed untouched

No GS3/`nowimhere3/GS3` file was modified. No iframe was created, wrapped, or replaced by BG (BG only
ever receives `postMessage`; it does not host an iframe of itself). No native/WebView prototype was
built — the two `BREADCRUMBS — WILL BE / FUTURE` blocks in `launch-context.js` and
`streamloop-bridge.js` are the entire Part 4 deliverable. No `LAUNCHPAD_READY` message was built or
sent. No messaging beyond `LAUNCHPAD_PLAY`/`LAUNCHPAD_PAUSE` was added. StreamLoop cannot control
Curation. No more than one folder loads at startup under either context. `decideStartupMedia()`'s
signature and `decideBootRestore()` are both byte-identical to baseline.

## Changed files

- `index.html`
- `src/main.js`
- `src/storage/app-preferences.js`
- `styles.css`
- `tools/test-startup-media.mjs`
- `src/runtime/launch-context.js` (new)
- `src/runtime/streamloop-bridge.js` (new)
- `tools/test-launch-context.mjs` (new)
- `tools/test-streamloop-bridge.mjs` (new)
- `Reports and Docs/North-Star/N6/N6-6-STREAMLOOP-INTEGRATION-IMPLEMENTATION-REPORT.md` (this report)

No commit was created and nothing was pushed.
