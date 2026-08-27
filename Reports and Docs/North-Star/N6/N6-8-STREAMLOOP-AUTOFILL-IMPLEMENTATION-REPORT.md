# North Star N6-8 — StreamLoop Integration Settings + Post-Load Auto Fill (Implementation Report)

**Recorded:** Thursday, August 27, 2026 — 4:27 PM MDT (America/Edmonton, UTC-06:00)
**Status:** PASS
**Handoff:** `Reports and Docs/North-Star/N6/N6-7-STREAMLOOP-AUTOFILL-ARCHITECTURE-HANDOFF.md`
**Baseline:** branch `SandboxSyncV3`, N6-6 complete and PASS (uncommitted on this worktree)

## Outcome

**StreamLoop Integration disclosure.** A new closed-by-default Advanced Settings disclosure,
`StreamLoop Integration`, sits between `Startup Media` and `Sync Your Curations`. It contains exactly
one control — `☑ Auto Fill Panel after media loads` — and nothing else. No StreamLoop-specific
playback (shuffle/interval/loop) overrides were added; existing BG Playback Settings remain fully
authoritative and shared across both launch contexts, per the handoff's Part 1.

**Preference.** `app-preferences.js` gained a new top-level `streamloopIntegration: { autoFillPanel:
false }` section, deliberately separate from `startup.streamloop` (different question — "what BG
does after load" vs. "which folder loads"). Normalizes with the existing `bool()` helper, persists
through a new `saveStreamloopIntegrationPreferences(partial)` using the generic one-level
`savePartial()` (no two-level merge needed — the section has no nesting). No `DATABASE_VERSION` bump,
no migration beyond the standard missing-field-defaults-individually pattern.

**Readiness correction.** N6-6's `streamLoopReady` gate previously required only
`state.hasVisibleItems`. That flips true inside `loadFromFsaHandle()`'s `finishLoadingItems()` call —
*before* that same function's remaining Curation/registry bookkeeping
(`armDeferredLoadTimeOffer`/`touchLibrary`/`recordLibraryLoaded`/`recordPortableStructureForLoad`/
`renderRecentLibraries`) has settled. Readiness now additionally requires a new
`streamLoopStartupSettled` flag, which only becomes `true` once `attemptStartupMedia()` itself has
returned — i.e., once `loadFromFsaHandle()`'s own documented "authoritative completion point" (its
`finally` block) has actually been reached.

**Ordering.** `attemptStartupMedia()` — previously the whole N6-6 startup-load function — is now a
thin wrapper: it awaits the renamed `runStartupMediaLoad()` (N6-4/N6-6's original body, otherwise
untouched), marks `streamLoopStartupSettled = true`, considers Auto Fill Panel (gated on
`hasVisibleItems` **and** the preference, entering through the existing
`enterFillPanelDeliberately()`), and only *then* calls `tryBecomeStreamLoopReady()` to apply whatever
StreamLoop PLAY/PAUSE intent is currently pending. This guarantees: `load complete → mark settled →
Fill Panel (if enabled) → honor latest pending PLAY/PAUSE`. Verified against the real
`enterFillPanelDeliberately()`/"Autoplay on Fill" interaction (see *Ordering verification* below) —
the most recent explicit StreamLoop signal always has the final say over BG's own autoplay default.

**Reuse, not reinvention.** Auto Fill Panel calls `enterFillPanelDeliberately()` — the same shared
entry point the `Fill ⛶` button and `F` shortcut use — and nothing else. No second fullscreen
mechanism was built.

**Boot-scoped only.** `attemptStartupMedia()` is called exactly once, from `initFsaLibraries()`; Auto
Fill Panel cannot re-fire for a later manual folder pick in the same tab, confirmed by a wiring
assertion (see Testing).

**Multiple panels.** Documented only, unchanged from N6-6: each StreamLoop-launched BG instance is an
independent page load with its own module state; the `streamloopIntegration`/`startup.streamloop`
preferences are shared same-origin IndexedDB configuration each instance reads independently, with
zero cross-panel coordination. Duplicate random folder picks across panels remain allowed;
random-without-replacement was not built or scaffolded.

## What changed

### `src/storage/app-preferences.js`

- `DEFAULT_STREAMLOOP_INTEGRATION = { autoFillPanel: false }`, with a `[WHY:]` explaining the naming
  choice (matches the "StreamLoop Integration" disclosure's own name, avoiding a confusing
  near-duplicate next to `startup.streamloop`) and the conservative default (entering Fill Panel is
  a screen takeover the customer didn't just click a button for).
- `normalizeRecord()` gained a `streamloopIntegrationSource` extraction and a
  `streamloopIntegration: { autoFillPanel: bool(...) }` field, following the exact same
  missing-field-defaults-individually pattern every other section already uses.
- `saveStreamloopIntegrationPreferences(partial)` — a thin wrapper around the existing generic
  `savePartial("streamloopIntegration", partial)`, with a `[WHY:]` explaining why this section does
  **not** need `saveStartupPreferences()`'s two-level merge (no nesting here).

### `src/main.js`

- New import: `saveStreamloopIntegrationPreferences`.
- New DOM ref: `streamloopAutoFillPanelInput`.
- New module-level state: `currentStreamloopIntegrationPreferences` (safe pre-load default mirroring
  `DEFAULT_STREAMLOOP_INTEGRATION`).
- `applyLoadedPreferences()` now also seeds `currentStreamloopIntegrationPreferences` and the
  checkbox's `checked` state, before `initFsaLibraries()` can run — same ordering guarantee
  `currentStartupPreferences` already relies on.
- New `change` listener on `streamloopAutoFillPanelInput`, saving through
  `saveStreamloopIntegrationPreferences()` — a pure preference write, never itself entering Fill
  Panel or touching playback, matching `autoplayOnFillInput`'s own adjacent pattern exactly.
- **The N6-6 bridge refactor:** `streamLoopPendingIntent`, `streamLoopReady`, `applyStreamLoopIntent`,
  and `isTrustedStreamLoopSource` were promoted from inside the `if (launchContext ===
  LAUNCH_CONTEXT_STREAMLOOP) { ... }` block to module scope, unconditionally declared. A new
  `streamLoopStartupSettled` flag and `tryBecomeStreamLoopReady()` function (shared by both the
  boot-settle path and the fallback `runtime.subscribe()` path, so neither can double-apply an
  intent) joined them. The `if (launchContext === LAUNCH_CONTEXT_STREAMLOOP) { ... }` block itself now
  contains **only** the two registrations that must stay conditional — the `message` listener and the
  fallback `runtime.subscribe()` — exactly as the handoff specified. This is a mechanical relocation;
  none of N6-6's message-shape parsing, source validation, or apply logic changed.
- N6-4/N6-6's `attemptStartupMedia()` body was renamed to `runStartupMediaLoad()`, byte-identical
  internally. The real `attemptStartupMedia()` is now the thin settle-sequence wrapper described
  above.

### `index.html`

New `<details class="advanced-streamloop-integration-section">` disclosure, closed by default,
inserted immediately after the Startup Media `</details>` and before the `[PROFILE-SYNC]` comment
block / `Sync Your Curations` `<details>`. Contains a `<p class="hint">` scoping note ("Applies only
when Browser Gallery is launched by StreamLoop.") and one `<label class="compact-check wide-check">`
checkbox, following the exact existing markup convention `autoplay-on-fill-input`/
`skip-duplicates-input` already use.

### `styles.css`

**No changes in this slice.** The existing generic `.advanced-settings-section > details` spacing
(N6-4/N6-6) and `.compact-check.wide-check` checkbox styling already cover the new disclosure —
verified visually would require a browser, but structurally the new markup reuses classes with no
new selectors needed, matching the handoff's prediction.

### `tools/test-startup-media.mjs`

§16 updated: its wiring assertions now target `runStartupMediaLoad()` (the renamed function) instead
of the old `attemptStartupMedia()` name, plus one new assertion that `attemptStartupMedia()` awaits
`runStartupMediaLoad()`. All of §16's underlying properties (decision-function consultation,
`attemptBootRestore()` delegation, the shared `loadFromFsaHandle()` load path, no
`requestPermission`/`removeFromRecents`, dual-context resolution) are unchanged — only which function
name they're proven against.

### `tools/test-streamloop-bridge.mjs`

§7 updated per the N6-7 handoff's explicit call-out: since the shared bridge state/functions moved to
module scope, assertions that used to search a `guardBody` slice (bounded to the `if
(launchContext===...)` block) now search a broader `bridgeRegion` (from the shared-state declaration
through the end of the guard) for the properties that moved — source validation, `parseStreamLoopMessage`/
`nextPendingIntent` usage, `hasVisibleItems`, `runtime.play()`/`runtime.stop()`, the `requestPermission`/
`LAUNCHPAD_READY`/`postMessage` absence checks. The "listener/subscribe registered only inside the
guard" assertions still use the narrower `guardBody`, since that code didn't move. New assertions
added for the N6-7 correction itself: `streamLoopStartupSettled` appears in the bridge region, and
`tryBecomeStreamLoopReady()`'s own body gates on both `!streamLoopStartupSettled` and
`hasVisibleItems`.

### `tools/test-streamloop-autofill.mjs` (new)

Preference default/round-trip/normalization/no-migration/sibling-section-survives tests; DOM tests
for the new disclosure (closed, correctly labeled, correctly ordered between Startup Media and Sync
Your Curations, and — a negative check — contains no shuffle/interval/loop-playlist override
markup); `main.js` wiring tests for the checkbox's own plumbing (never itself enters Fill Panel); and
the settle-sequencing tests: `attemptStartupMedia()` awaits `runStartupMediaLoad()` first, marks
`streamLoopStartupSettled` before considering Auto Fill Panel, the textual order of "mark settled →
Auto Fill Panel → apply pending intent" matches the required execution order (straight-line
synchronous code, so textual order is execution order here), the Auto Fill gate reads both
`hasVisibleItems` and the preference, `enterFillMode()` is never called directly, and
`attemptStartupMedia()` is called exactly once in the whole file (boot-scoped-only, proven by counting
the exact call syntax `attemptStartupMedia();` rather than every textual mention of the name).

## Ordering verification (against the real interacting code, not assumed)

Traced `enterFillPanelDeliberately()`'s own logic (`wasPlaying` sampled before `enterFillMode()`;
autoplay only fires when `!wasPlaying && autoplayOnFillInput.checked`) against the new sequencing:

| BG's "Autoplay on Fill" | Pending StreamLoop intent | Result |
| --- | --- | --- |
| ON (default) | none yet | Fill Panel enters, autoplay starts it |
| ON | `"pause"` | Fill Panel enters, autoplay starts it, then `tryBecomeStreamLoopReady()` immediately calls `runtime.stop()` — net: paused |
| OFF | `"play"` | Fill Panel enters, stays paused, then `tryBecomeStreamLoopReady()` calls `runtime.play()` — net: playing |

At the moment Auto Fill Panel runs, `streamLoopReady` is still `false` (it only flips inside
`tryBecomeStreamLoopReady()`, called strictly afterward), so `wasPlaying` can only be `false` unless
something else started playback — nothing else does in this path. In every case the most recent
explicit StreamLoop signal wins over BG's own default, exactly as required.

## Automated verification

- `tools/test-streamloop-autofill.mjs` — **new**, PASS, 41 assertions.
- `tools/test-streamloop-bridge.mjs` — updated, PASS, 45 assertions (was 40 under N6-6).
- `tools/test-startup-media.mjs` — updated, PASS, 100 assertions (was 99 under N6-6).
- `tools/test-boot-restore.mjs` — **verified unchanged** (`git diff --stat` empty for both this file
  and `src/storage/boot-restore.js`), PASS, 24/24 assertions.
- `tools/check-dom-contract.js` — PASS: 57 JS files parse, 262 unique ids (0 duplicates), 248
  `getElementById` targets all present, 237 module-scope element captures (was 236 before this
  slice — the one new `streamloopAutoFillPanelInput` ref).
- Full repository suite — PASS, 62 test files total: 61 run individually (60s timeout each), all
  green, plus `tools/test-sync-v2-scheduler.mjs` (the same pre-existing real-timer test noted in
  every prior N6 report, unrelated to this slice — confirmed separately, 34/34 assertions).
- `node --check` on every touched/new `.js` file — PASS.

## Invariants confirmed

- Auto Fill Panel only ever calls `enterFillPanelDeliberately()` — `enterFillMode()` is never called
  directly by any code this slice added.
- `attemptStartupMedia()` is called exactly once in the whole file.
- Readiness requires both `streamLoopStartupSettled` and `state.hasVisibleItems` — neither alone.
- No timer of any kind was introduced; the correction is a second boolean flag, not a delay.
- `requestPermission` is never called by any new or modified code path.
- No StreamLoop-specific playback (shuffle/interval/loop) control was added — verified by both a
  manual re-read of the new markup and a negative DOM assertion in the new test file.
- No cross-panel coordination or random-without-replacement logic was built.
- `decideStartupMedia()`, `decideBootRestore()`, and `boot-restore.js` as a whole are untouched
  (`git diff --stat` empty).

## Out of scope, confirmed untouched

No GS3/`nowimhere3/GS3` file was modified. No native/WebView work. No Curation control from
StreamLoop. No new StreamLoop message types and no `LAUNCHPAD_READY`. No volume/seek/next/previous
protocol. No duplicate Playback Settings UI. No identity/SyncV3/MEDIA-ID change.

## Changed files

- `index.html`
- `src/main.js`
- `src/storage/app-preferences.js`
- `tools/test-startup-media.mjs`
- `tools/test-streamloop-bridge.mjs`
- `tools/test-streamloop-autofill.mjs` (new)
- `Reports and Docs/North-Star/N6/N6-8-STREAMLOOP-AUTOFILL-IMPLEMENTATION-REPORT.md` (this report)

`styles.css` was inspected but not modified — the existing generic disclosure/checkbox styling
already covers the new markup.

No commit was created and nothing was pushed.
