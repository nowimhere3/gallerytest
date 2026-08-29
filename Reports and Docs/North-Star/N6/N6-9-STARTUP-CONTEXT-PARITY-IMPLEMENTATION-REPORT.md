# North Star N6-9 — Startup Context Parity + Advanced Settings Cleanup (Implementation Report)

**Recorded:** Thursday, August 27, 2026 — 10:52 PM MDT (America/Edmonton, UTC-06:00)
**Status:** PASS
**Baseline branch/commit:** `SandboxSyncV3` @ `fe87e0a` ("Add Browser Gallery StreamLoop integration and autofill") — verified clean before any edit (`git status --short` empty, `git log -1 --oneline` matched exactly).

## 1. Baseline

Confirmed before editing:

```
$ git status --short
(empty)
$ git log -1 --oneline
fe87e0a Add Browser Gallery StreamLoop integration and autofill
```

Both matched the expected baseline stated in the task. Proceeded per "otherwise implement the smallest clean solution."

**Note on an unrelated observation.** Partway through this session, `git status` began showing `Reports and Docs/North-Star/N0-N1/`, `N2/`, `N3/`, `N4/`, `N5/` as deleted and a new `Reports and Docs/North-Star/N00-N06-7/` directory (containing the same five subfolders) as untracked. This is a directory move/consolidation this session did not perform — no tool call in this session touched any path under those folders. It appears to be an external reorganization (e.g. a retention-review consolidation per the README's own "phase folders will be deleted" policy) that landed on disk while this session was working. It is left completely untouched and unstaged; it is unrelated to N6-9 and is the human's to review. The diff summarized below is scoped only to files this slice actually changed.

## 2. Files changed

- `src/storage/app-preferences.js`
- `src/main.js`
- `index.html`
- `styles.css`
- `tools/test-startup-media.mjs` (updated)
- `tools/test-streamloop-autofill.mjs` (rewritten for the new preference/DOM shape)
- `tools/test-startup-context-parity.mjs` (new)
- `Reports and Docs/North-Star/N6/N6-9-STARTUP-CONTEXT-PARITY-IMPLEMENTATION-REPORT.md` (this report)

No GS3/StreamLoop file touched. No commit made.

## 3. Exact preference representation chosen

**Decision: extend the existing per-context `startup.browser` / `startup.streamloop` objects with one new field, `autoFillPanel`, and retire the separate top-level `streamloopIntegration` section.**

```js
// app-preferences.js
const DEFAULT_STARTUP_POLICY = {
  policy: "last-used",        // "off" | "last-used" | "random-remembered" | "random-selected"
  eligibleLibraryIds: [],
  autoFillPanel: false,       // NEW — independent per context
};
const DEFAULT_STARTUP = {
  browser: { ...DEFAULT_STARTUP_POLICY },
  streamloop: { ...DEFAULT_STARTUP_POLICY },
};
```

This was a deliberate choice between two options, weighed explicitly against the task's own instruction to prefer the smaller compatible change:

1. **Chosen:** nest `autoFillPanel` inside `startup.browser`/`startup.streamloop`. N6-9's own UI change is what tips the scale here — Advanced Settings now co-locates a context's *entire* startup+post-load configuration in one disclosure (Startup Media for browser, StreamLoop Integration for streamloop) for the first time. Nesting the preference to match is the smaller diff: it extends an object that already exists and is already keyed by context, rather than inventing a symmetric new top-level `browserIntegration` section purely to mirror `streamloopIntegration`.
2. **Rejected:** keep `streamloopIntegration` as-is and add a parallel `browserIntegration` section. This would have meant two new top-level sections' worth of default/normalize/save plumbing for a shape that no longer matches where the UI actually put the controls, and would have left `saveStartupPreferences()`'s two-level context merge and a hypothetical `browserIntegration`'s one-level merge as two different save mechanics for what is now conceptually the same kind of per-context data.

`"off"` (the new fourth startup choice) was added as a fourth accepted value in `startupPolicy()`'s normalizer, reachable **only** by explicit selection — any unrecognized or missing value still falls back to `"last-used"`, exactly as before this field existed. No enum export was added; it is a plain string literal, consistent with the existing `"last-used"`/`"random-remembered"`/`"random-selected"` style.

## 4. Existing compatibility behavior

- **N6-4-era flat `startup: {policy, eligibleLibraryIds}` records** still migrate into `startup.browser` exactly as N6-6 already established; `startup.streamloop` still starts fresh (now also carrying `autoFillPanel`, sourced per the migration below).
- **N6-7/N6-8's `streamloopIntegration.autoFillPanel`** is read one more time, as a **fallback default** for `startup.streamloop.autoFillPanel` — only consulted when `startup.streamloop` itself has no `autoFillPanel` field yet. Once any write happens under the new location (which happens automatically because `normalizeRecord()` no longer includes `streamloopIntegration` in its returned/re-written record), the legacy section disappears from storage on the next write — the same non-destructive retirement pattern this file already used for `playback.fillPanel`.
- **A record that already has `startup.streamloop.autoFillPanel` set** (e.g. a hypothetical partially-migrated state) always wins over the legacy fallback — migration can never happen twice or overwrite an already-current value.
- **Normal BG's `autoFillPanel`** has no prior location to migrate from and defaults to plain `false` for every existing user — this is a pure opt-in addition with zero behavior change until a customer explicitly turns it on.
- **No `DATABASE_VERSION` bump.** The object store's shape is unchanged; only the record's shape changed, and every record is reshaped on every read — the same reasoning every prior additive field in this file already documents.

## 5. New Normal BG Auto Fill behavior

Normal Browser Gallery now has its own checkbox, `#startup-media-browser-auto-fill-panel-input`, inside the Startup Media disclosure, saved via the same `saveStartupPreferences("browser", {autoFillPanel})` two-level-merge path StreamLoop's already used (no new save function needed).

`attemptStartupMedia()` (the thin settle-sequence wrapper around `runStartupMediaLoad()`, unchanged from N6-7/N6-8 in its overall shape) now resolves Auto Fill **symmetrically** for whichever context is actually active:

```js
async function attemptStartupMedia() {
  await runStartupMediaLoad();

  const activeContext = launchContext === LAUNCH_CONTEXT_STREAMLOOP ? "streamloop" : "browser";
  const autoFillEnabled = Boolean(currentStartupPreferences?.[activeContext]?.autoFillPanel);

  if (runtime.getState().hasVisibleItems && autoFillEnabled) {
    enterFillPanelDeliberately();
  }

  if (launchContext !== LAUNCH_CONTEXT_STREAMLOOP) return;

  streamLoopStartupSettled = true;
  tryBecomeStreamLoopReady();
}
```

This reuses, unchanged:

- **The same authoritative completion seam** N6-7 established — Auto Fill is only ever considered after `runStartupMediaLoad()` (N6-4/N6-6/N6-7's original `attemptStartupMedia()` body, renamed but byte-identical internally) has fully resolved, never from `state.hasVisibleItems` alone, a timer, DOM polling, or any duplicated load logic.
- **The same shared entry point**, `enterFillPanelDeliberately()` — never `enterFillMode()` directly, and no second fullscreen mechanism.
- **The same boot-scoped-only guarantee** — `attemptStartupMedia()` is called exactly once per page load, from `initFsaLibraries()`, for either context, so Auto Fill cannot re-fire for a later manual folder pick in the same tab.

Ordering with the StreamLoop PLAY/PAUSE bridge is preserved: Auto Fill Panel is still considered strictly before `tryBecomeStreamLoopReady()` applies any pending intent, for a StreamLoop launch. Normal BG has no PLAY/PAUSE concept at all, so its own path simply ends after the Auto Fill check.

## 6. StreamLoop UI regrouping

All StreamLoop-specific customer-facing configuration now lives together inside **StreamLoop Integration**:

- The "When launched by StreamLoop" policy `<select>` (with its helper text and eligible-folder checkbox list) moved out of Startup Media and into StreamLoop Integration, ids unchanged (`startup-media-streamloop-*`) — only their DOM location moved.
- The existing `streamloop-auto-fill-panel-input` checkbox stays where it already was (StreamLoop Integration), now positioned after the moved startup controls, matching the target IA's `On startup → [selected-folder controls] → Auto Fill` order.
- **Startup Media now contains only Normal Browser Gallery's own controls** — policy select, eligible list, and its new Auto Fill checkbox. It has zero remaining reference to StreamLoop.

Verified by `tools/test-streamloop-autofill.mjs` §4 (StreamLoop Integration contains its own controls) and `tools/test-startup-context-parity.mjs` §6 (Startup Media contains no reference to StreamLoop at all).

No StreamLoop-specific playback (shuffle/interval/loop) override was added — this was evaluated per the task's own instructions and rejected for the same reason N6-7 originally rejected it: nothing in this slice's requirements names a concrete decision that needs a value different from BG's existing shared Playback Settings, so building one would be exposing capability nobody asked for. Existing Playback Settings remain the single authority for both contexts.

## 7. OFF startup semantics

`"off"` — labeled **"Do not load media automatically"** in the UI, listed first in both `<select>`s — is now a fourth, fully persisted value for `policy`.

`runStartupMediaLoad()` (the renamed N6-4/N6-6/N6-7 body) checks for it **before** the existing "fall back to last-used" branch:

```js
if (startup.policy === "off") return;

if (startup.policy !== "random-remembered" && startup.policy !== "random-selected") {
  await attemptBootRestore();
  return;
}
```

This guarantees, for whichever context is active:

- no remembered-folder load (never reaches `attemptBootRestore()`)
- no random-folder selection (never reaches `decideStartupMedia()`)
- no permission query of any kind (never reaches `readFolderPermissionForBootRestore()`)
- no Auto Fill (falls out naturally: nothing loaded → `runtime.getState().hasVisibleItems` stays `false` → the Auto Fill gate in `attemptStartupMedia()` never passes, even if that context's saved Auto Fill preference is `true`)
- Browser Gallery is left exactly as available for a normal manual folder pick as it always is — nothing about the manual folder-pick/Recent-Libraries code paths was touched

`decideStartupMedia()` and `decideBootRestore()` in `boot-restore.js` **never see `"off"` at all** — it is intercepted one layer up, in `main.js`, before either pure function is ever called. Both functions and their existing test files are therefore completely untouched, confirmed by an empty `git diff` on `boot-restore.js`.

Both contexts are independently configurable: `startup.browser.policy` and `startup.streamloop.policy` can each independently be `"off"` or any of the three automatic modes, proven for both directions in `tools/test-startup-context-parity.mjs` §3.

## 8. Auto Fill disabled-state semantics

A new `updateStartupMediaAutoFillAvailability(context)` function, called from the existing `updateStartupMediaPolicyHelper(context)` (itself already called both at boot-preference-load and on every policy `change` event), does exactly two things when a context's policy is `"off"`:

```js
function updateStartupMediaAutoFillAvailability(context) {
  const controls = startupMediaControls[context];
  const isOff = controls.policySelect.value === "off";
  controls.autoFillInput.disabled = isOff;
  controls.autoFillHelper.classList.toggle("hidden", !isOff);
}
```

- Sets `.disabled` on the checkbox — never `.checked`. The saved boolean is never written to, read from a different location, or reset; it simply isn't consulted at boot while policy is `"off"` (see §7).
- Shows a single line of explanatory copy, **"Available when media loads automatically."**, in a `<p class="hint hidden">` that exists per context (`startup-media-browser-auto-fill-helper` / `streamloop-auto-fill-helper`), toggled visible only while disabled.
- No modal, confirmation, or extra workflow of any kind was added.

Because the checkbox is only ever disabled (never unchecked) and the preference is only ever read from `startup.<context>.autoFillPanel` (never derived from or reset by `policy`), a previously saved `true` survives untouched through any number of round trips through `"off"` and back to an automatic mode — proven in `tools/test-startup-context-parity.mjs` §4.

## 9. Advanced Settings spacing fix

**Root cause found by inspecting the actual cascade, not by guessing at a new number.** The N6-6 attempt set `.advanced-settings-section > details:first-of-type { margin-top: 12px; }`, but `.advanced-settings-section[open] summary { margin-bottom: 16px; }` — a *descendant* combinator — also matches the OUTER "Advanced Settings" `<summary>` itself (it has no way to exclude it). Adjoining block margins collapse to the **larger** of the two values, not their sum, so the actual rendered gap depended on the browser resolving two different declared numbers (16 and 12) against each other, rather than on any single value this stylesheet controls.

**Fix:** a new, more specific *child*-combinator rule zeroes the outer summary's own margin-bottom specifically:

```css
.advanced-settings-section[open] > summary {
  margin-bottom: 0;
}
```

Placed after the existing broader rule so it wins the specificity tie for the one element they both match (the outer summary). A nested disclosure's own `<summary>` is never a direct child of `.advanced-settings-section` (it's a grandchild, inside its own `<details>`), so this cannot affect spacing between later nested disclosures at all — confirmed the existing `.advanced-settings-section > details[open] > summary { margin-bottom: 10px; }` rule (which governs a nested disclosure's own open-state summary spacing) is untouched.

With one side of the pair now always exactly `0`, the first nested `<details>`'s own `margin-top: 12px` is the gap's only remaining source — deterministic whether a browser collapses adjoining margins (the correct, expected behavior: `max(0, 12) = 12`) or, hypothetically, summed them (`0 + 12 = 12`, identically). No inline styles were added; both rules live in the existing stylesheet structure, targeted at the existing selectors' logical extensions.

**Automated proof:** `tools/test-startup-media.mjs` §15c asserts the new rule exists, zeroes margin-bottom, appears after the broader rule in source order, and that the nested-disclosure spacing rule is untouched. **Optional visual confirmation** (not a release gate): opening Advanced Settings in an actual browser and eyeballing that the gap now reads as a deliberate ~12px separation rather than whatever it visually read as before — CSS box-model math cannot be executed by this test suite, only inspected as source text, so a human glance is the only way to confirm the *rendered* pixel result matches intent. Everything else about this fix (which rule wins, that it can't leak into other disclosures) is fully proven by source-level assertions.

## 10. Tests added/updated

**`tools/test-startup-context-parity.mjs` (new, 49 assertions):** the "off" mode's normalization (both directions, and that malformed/absent data still falls back to `"last-used"`, never `"off"`); Normal BG's `autoFillPanel` independence from StreamLoop's, both directions; startup-policy independence including `"off"`, both directions; a saved Auto Fill value surviving a round trip through `"off"` and back; both `<select>`s exposing the off option with the required customer-facing phrase, listed first; Normal BG's own Auto Fill DOM control existing inside Startup Media with no StreamLoop reference remaining there; no duplicate ids introduced; `runStartupMediaLoad()`'s `"off"` branch calling none of `attemptBootRestore`/`decideStartupMedia`/permission-query/`loadFromFsaHandle`; `attemptStartupMedia()`'s Auto Fill check running for whichever context is active (not hardcoded to streamloop); and the disabled-checkbox wiring (`.disabled` set, `.checked` never touched, helper visibility toggled, refreshed from the policy-helper updater).

**`tools/test-streamloop-autofill.mjs` (rewritten, 26 assertions):** narrowed to what is genuinely StreamLoop-specific now that cross-context parity moved to the file above — `startup.streamloop.autoFillPanel` round-trip; the N6-7/N6-8 `streamloopIntegration.autoFillPanel` migration into its new home (including that it is absent from the *normalized* record and disappears from the *stored* record after any subsequent write); that an already-migrated value is never re-migrated from a stale legacy section; that StreamLoop Integration's DOM contains its full moved configuration; and that `attemptStartupMedia()`'s sequencing (Auto Fill → mark settled → apply pending intent) still holds for the StreamLoop path specifically.

**`tools/test-startup-media.mjs` (updated, 107 assertions, was 100):** §15 extended from four to five Advanced disclosures (StreamLoop Integration had never actually been added to this list in N6-7/N6-8 — corrected now); §15c rewritten to prove the deterministic CSS mechanism from §9 rather than just a nonzero value. §13/14/14b/14c/16 needed no changes — they still pass unmodified and still describe true things (they simply don't yet know about `autoFillPanel`/`"off"`, which the two files above now cover).

## 11. Full test results

- `tools/test-startup-context-parity.mjs` — **new**, PASS, 49 assertions.
- `tools/test-streamloop-autofill.mjs` — rewritten, PASS, 26 assertions.
- `tools/test-startup-media.mjs` — PASS, 107 assertions (was 100).
- `tools/test-streamloop-bridge.mjs` — PASS, 45 assertions, **unmodified by this slice** (nothing it tests changed).
- `tools/test-launch-context.mjs` — PASS, 20 assertions, unmodified.
- `tools/test-boot-restore.mjs` — **verified byte-identical** (`git diff --stat` empty for both this file and `src/storage/boot-restore.js`), PASS, 24/24.
- `tools/check-dom-contract.js` — PASS: 57 JS files parse, 265 unique ids (0 duplicates), 251 `getElementById` targets all present, all aria/label references resolve, all local asset/module paths resolve, no destructive DOM ops on workspace-named variables.
- Full repository suite — PASS, 62 test files total: 61 run individually (60s timeout each), all green, plus `tools/test-sync-v2-scheduler.mjs` (the same pre-existing real-timer test every prior N6 report has noted needs ~2 minutes wall-clock, unrelated to this slice — confirmed separately, 34/34 assertions).
- `node --check` on every touched/new `.js`/`.mjs` file — PASS.

## 12. Explicit invariants preserved

- `decideStartupMedia()` and `decideBootRestore()` — untouched, `git diff` empty on `boot-restore.js`.
- `"off"` is reachable only by explicit customer selection; any unrecognized/missing policy value still normalizes to `"last-used"`, exactly as before.
- No permission prompting (`requestPermission`) is introduced anywhere in the `"off"` path or the Auto Fill path, for either context.
- Auto Fill's completion seam is unchanged from N6-7: `attemptStartupMedia()` awaiting `runStartupMediaLoad()`, never `state.hasVisibleItems` alone, a timer, or DOM polling.
- `enterFillPanelDeliberately()` is the only Fill Panel entry point either context's Auto Fill uses; `enterFillMode()` is never called directly by this slice's code.
- `attemptStartupMedia()` is called exactly once per page load — Auto Fill remains a startup-context behavior, never a general "every folder load" behavior, for either context.
- The two launch contexts remain fully independent at every layer touched: preference storage (two-level merge per context, unchanged mechanism), boot-time resolution (`activeContext` computed once from the live, never-persisted `launchContext`), and UI (each context's controls read/write only that context's own record).
- StreamLoop identity is still determined solely by the explicit `?launch=streamloop` contract (`launch-context.js`) — no iframe/referrer/user-agent/parent-window inference was added or considered.
- The StreamLoop PLAY/PAUSE bridge's message contract, source validation, and readiness gate (`streamLoopStartupSettled && hasVisibleItems`) are unmodified.

## 13. Anything intentionally NOT changed

MEDIA-ID, Profile identity, Shared Library identity, Profile Sync / Sync V3, Curations, the StreamLoop bridge's PLAY/PAUSE semantics and source validation, GS3/StreamLoop code, `decideStartupMedia()`/`decideBootRestore()`, general manual folder-load semantics, startup randomness semantics (the pure decision function itself), Fill Panel's implementation, general Playback preferences, general Presentation Mode behavior, Loop automation, and any AutoM/future-automation architecture. No StreamLoop-specific playback override was added (see §6). The external `N0-N1`/`N2`–`N5` report-folder reorganization noted in §1 was left completely untouched.

## 14. Whether human testing is actually required

**No automated test is being skipped that could reasonably have been automated.** Every behavioral claim in this report — preference normalization and independence, the `"off"` short-circuit's exact call graph, the disabled-checkbox wiring, the DOM regrouping, and the CSS cascade's specificity/source-order resolution — is proven by a source-level or preference-round-trip assertion, following the same convention this codebase has used since N6-4 for logic that would otherwise require a real browser to exercise.

The **one** thing genuinely outside automation's reach here is the literal rendered pixel gap under "Advanced Settings" (§9) — CSS box-model resolution ultimately depends on a real layout engine, and this suite has none. That is reported above as an **optional visual confirmation**, not a release gate: the reasoning proves the mechanism is now deterministic (not collapse-dependent) and the source-level assertions prove the rule shape is correct; only the exact number of rendered pixels is left for a human glance if the product owner wants one.

## 15. Final assessment

**PASS.** All required changes implemented per spec: StreamLoop-specific configuration consolidated into StreamLoop Integration; Normal Browser Gallery given its own independent Auto Fill preference using the same authoritative completion seam; an explicit, persisted "Do not load media automatically" mode added to both contexts with correct off-semantics and non-destructive disabled-checkbox handling; the Advanced Settings spacing gap made deterministic; all changes additive/normalizing with no destructive migration and no `DATABASE_VERSION` bump; `decideStartupMedia()`, `decideBootRestore()`, and `test-boot-restore.mjs` byte-identical to baseline; full regression suite green.
