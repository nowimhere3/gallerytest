# PM Toolbar Opacity — Toolbar + Hover Opacity Controls (Implementation Report)

**Recorded:** Friday, August 28, 2026 — America/Edmonton (UTC-06:00)
**Status:** PASS (optional visual confirmation recommended — see §8)
**Baseline for this correction:** `SandboxSyncV3` @ `1bf1145` ("Add Presentation Mode toolbar opacity controls") — the human's own commit of this feature's *first* (three-slider) slice, already on `origin/SandboxSyncV3`.
**This report supersedes** the original `PM-TOOLBAR-OPACITY-IMPLEMENTATION-REPORT.md` write-up for `1bf1145`, which shipped a design the human then flagged as wrong (see §1). The content below describes the corrected, currently-uncommitted working tree.

## 0. Scope

Same feature, corrected shape. Presentation Mode's toolbar needed independent control over its resting opacity and its hovered opacity. The first slice (commit `1bf1145`) implemented this as **three** sliders — the pre-existing "Ghost Opacity" plus two brand-new ones ("Toolbar Opacity", "Hover Opacity") layered on top of it. The human corrected this: there must be **exactly two** sliders. This pass removes the redundant new "Toolbar Opacity" control and instead renames the pre-existing "Ghost Opacity" control's on-screen label to "Toolbar Opacity", pairing it with the (correctly new) Hover Opacity slider that replaces what used to be a hardcoded 100% hover state.

## 1. What was wrong with the first slice, and why

`1bf1145` treated "Ghost Opacity" as if it controlled something orthogonal to "the toolbar's resting opacity" (it inspected the code and found `--ghost-opacity` fades the *entire* `#presentation-controls` overlay stack, not just the toolbar bar, and reasoned from that that a new, narrower mechanism was needed). That inspection was correct, but the conclusion was wrong: the task's own product intent — "not hovered → Toolbar Opacity; hovered → Hover Opacity; hover ends → Toolbar Opacity" — is *exactly* what Ghost Opacity's existing `mouseenter`/`mouseleave` mechanism already implements, with the hover value hardcoded to 100% instead of configurable. Adding a second, independent opacity layer nested inside the first (targeting `.presentation-controls-bar` while Ghost Opacity kept targeting `.presentation-controls`) produced two competing "resting opacity" values that multiplied together — technically consistent, but not the two-control product the human asked for, and confusing to reason about (two remembered percentages jointly determining one visual result).

The fix: stop treating Ghost Opacity as an untouchable third concept. It **is** the resting-opacity mechanism the human wants — it just needed its on-screen name changed and its hardcoded hover value replaced with a configurable one.

## 2. Files changed (this correction, on top of `1bf1145`)

- `index.html` — removed the redundant Toolbar Opacity row and `#presentation-controls-bar` id; renamed Ghost Opacity's `<label>` text and the 👻 toggle button's `aria-label`/`title` to "Toolbar Opacity".
- `src/main.js` — removed `applyToolbarOpacity()`, the `presentationControlsBar`/`toolbarOpacity*` DOM captures, and their event listeners; the `mouseenter` handler now applies a tracked, configurable `currentHoverOpacityPercent` instead of a hardcoded `"1"`.
- `src/storage/app-preferences.js` — removed `toolbarOpacityPercent`/`rememberToolbarOpacity`/`DEFAULT_TOOLBAR_OPACITY_PERCENT` entirely; `ghostOpacityPercent`/`rememberGhostOpacity` (the now-renamed-on-screen field) and `hoverOpacityPercent`/`rememberHoverOpacity` are unchanged from `1bf1145`.
- `styles.css` — removed `--pm-toolbar-opacity`/`--pm-toolbar-hover-opacity` and the opacity/`:hover` rule added to `.presentation-controls-bar` in `1bf1145`; `.ghost-popunder`'s multi-row layout (added in `1bf1145`) is kept, now sized for two rows instead of three.
- `tools/test-pm-toolbar-opacity.mjs` — rewritten to prove the two-slider model and the *absence* of the reverted redundant control (75 assertions, replacing the previous 99 written for the wrong three-slider design).

No other file touched. Ghost Opacity's `mouseleave` behavior, the ⚡ Automations state machine, and every other protected system remain untouched.

## 3. Exact preference/schema changes (`src/storage/app-preferences.js`)

```js
// Storage field names deliberately NOT renamed — see comment in-file for why.
const DEFAULT_PRESENTATION = {
  rememberGhostOpacity: true,
  ghostOpacityPercent: 15,
  rememberHoverOpacity: true,
  hoverOpacityPercent: 100,
};

export const DEFAULT_GHOST_OPACITY_PERCENT = DEFAULT_PRESENTATION.ghostOpacityPercent;
export const DEFAULT_HOVER_OPACITY_PERCENT = DEFAULT_PRESENTATION.hoverOpacityPercent;
```

`toolbarOpacityPercent`, `rememberToolbarOpacity`, and `DEFAULT_TOOLBAR_OPACITY_PERCENT` no longer exist anywhere in the codebase. `normalizeRecord()`'s `presentation` block now returns only `rememberGhostOpacity`/`ghostOpacityPercent`/`rememberHoverOpacity`/`hoverOpacityPercent` — a stray `toolbarOpacityPercent` field left over in a previously-saved IndexedDB record (from `1bf1145`, if anyone had actually used it) is simply not read back; it disappears from storage on the next write, the same retirement pattern this codebase already uses elsewhere (`fillPanel`, `streamloopIntegration`). No migration code was needed or written, per instruction, since that field was never shipped to real use before this correction.

`ghostOpacityPercent`'s own clamp (`clampOpacity()`) and default (15) are byte-for-byte unchanged from before `1bf1145` ever existed — the resting-opacity mechanism's storage path was never touched by either slice, only its on-screen label.

## 4. Exact UI changes (`index.html`)

`#ghost-popunder` now holds exactly two rows:

```html
<div id="ghost-popunder" class="ghost-popunder hidden">
  <div class="ghost-popunder-row">
    <label class="ghost-popunder-label" for="ghost-opacity-input">Toolbar Opacity</label>
    <input id="ghost-opacity-input" type="range" min="0" max="100" step="1" value="15" />
    <span id="ghost-opacity-label" class="ghost-popunder-value">15%</span>
    <label class="ghost-popunder-remember" for="ghost-remember-input">
      <input id="ghost-remember-input" type="checkbox" checked />
      <span>Remember this value</span>
    </label>
  </div>
  <div class="ghost-popunder-row">
    <label class="ghost-popunder-label" for="hover-opacity-input">Hover Opacity</label>
    <input id="hover-opacity-input" type="range" min="0" max="100" step="1" value="100" />
    <span id="hover-opacity-label" class="ghost-popunder-value">100%</span>
    <label class="ghost-popunder-remember" for="hover-remember-input">
      <input id="hover-remember-input" type="checkbox" checked />
      <span>Remember this value</span>
    </label>
  </div>
</div>
```

Note the first row's `<input id="ghost-opacity-input" ...>` — same id, same default value (15), same markup as it has had since before this feature existed. Only its `<label>` text changed, from "Ghost Opacity" to "Toolbar Opacity". The 👻 toggle button's `aria-label`/`title` were likewise changed from "Ghost Opacity" to "Toolbar Opacity", since the string "Ghost Opacity" no longer appears anywhere in customer-visible text (test #2 in §7 asserts this directly against the rendered HTML with comments stripped). The redundant `toolbar-opacity-input`/`toolbar-opacity-label`/`toolbar-remember-input` row from `1bf1145`, and the `id="presentation-controls-bar"` added solely to support it, are both gone.

## 5. Exact runtime opacity mechanism

The mechanism is now, once again, a single JS-driven pair of states on `#presentation-controls` — `1bf1145`'s CSS-`:hover`-driven second layer on `.presentation-controls-bar` is gone entirely:

```js
let currentGhostOpacityPercent = Number(ghostOpacityInput.value);  // Toolbar Opacity
let currentHoverOpacityPercent = Number(hoverOpacityInput.value);  // Hover Opacity

presentationControls.addEventListener("mouseenter", () => {
  presentationControls.style.setProperty("--ghost-opacity", String(currentHoverOpacityPercent / 100));
});

presentationControls.addEventListener("mouseleave", () => {
  applyGhostOpacity(currentGhostOpacityPercent);  // restores Toolbar Opacity exactly
});
```

`applyGhostOpacity(percent)` (Toolbar Opacity) is unchanged from before this feature existed. `applyHoverOpacity(percent)` is new: it updates `currentHoverOpacityPercent` and the percentage label, and also applies `--ghost-opacity` directly as a live preview — dragging the Hover Opacity slider can only happen while the pointer is over `#presentation-controls` (the popunder containing it is nested inside), so the toolbar is already in its hovered state for as long as the slider is reachable, and this lets the slider preview its own effect immediately rather than waiting for a `mouseenter` that already fired.

At boot, `applyLoadedPreferences()` calls `applyGhostOpacity(...)` (rendering the toolbar at Toolbar Opacity, correct for a not-yet-hovered launch) and seeds `currentHoverOpacityPercent`/the Hover Opacity label directly — deliberately *not* through `applyHoverOpacity()`, which would incorrectly force the toolbar into its hovered look before any real hover has happened.

Only `#presentation-controls` (the same element Ghost Opacity always targeted) is involved. There is no second opacity layer, no CSS custom property beyond the pre-existing `--ghost-opacity`, and no `:hover` CSS rule — mirroring exactly the mouseenter/mouseleave JS pattern the codebase already used, for the same pre-existing reason (working around `:focus-within` getting stuck after a button click).

## 6. Defaults (unchanged reasoning, corrected shape)

- **Toolbar Opacity: 15%** — unchanged from Ghost Opacity's own long-standing default. A customer who never opens this panel sees exactly what they always saw.
- **Hover Opacity: 100%** — replaces what used to be a hardcoded `"1"` in the `mouseenter` handler. A customer who never touches this new slider sees exactly the same hover behavior as before this feature existed.

Because Hover Opacity now directly *replaces* the old hardcoded value (rather than compositing with a separately-faded toolbar bar, as in `1bf1145`), these two defaults alone are sufficient to guarantee zero visual change for an untouched install — there is no multiplicative interaction to reason about anymore.

## 7. Test regression

`tools/test-pm-toolbar-opacity.mjs` was rewritten (75 assertions) to prove the corrected model and the specific regression the human called out:

1. exactly two PM opacity slider controls are customer-visible (row count, slider count, Remember-checkbox count inside `#ghost-popunder`).
2. `"Ghost Opacity"` no longer appears anywhere in visible HTML text/attributes.
3. the pre-existing mechanism (`#ghost-opacity-input`, `ghostOpacityPercent`, `applyGhostOpacity()`) is customer-labeled "Toolbar Opacity", with its id/storage/default markup verified unchanged.
4. no redundant `toolbar-opacity-input`/`toolbarOpacityPercent`/`DEFAULT_TOOLBAR_OPACITY_PERCENT`/`--pm-toolbar-opacity`/`applyToolbarOpacity`/`presentationControlsBar` remains anywhere in `index.html`, `main.js`, `app-preferences.js`, or `styles.css`.
5–7. a behavioral simulation of the exact `mouseenter`/`mouseleave`/`applyGhostOpacity`/`applyHoverOpacity` sequence proves not-hovered → Toolbar Opacity, hovered → Hover Opacity, hover-end → Toolbar Opacity exactly restored, including the case where Hover Opacity (25%) is lower than Toolbar Opacity (80%) with no forced minimum — plus a direct source-string check that `main.js` implements this exact shape.
8. Toolbar Opacity's and Hover Opacity's Remember checkboxes/values persist fully independently (via the real `app-preferences.js` against a fake IndexedDB): unchecking one's Remember doesn't touch the other's stored value or its own previously-remembered percent; each clamps out-of-range input to its own default, never the other's; sibling preference sections (`playback`, etc.) survive a save.
9. a hand-crafted stored record carrying a stray `toolbarOpacityPercent`/`rememberToolbarOpacity` (simulating leftover state from `1bf1145`) is proven to be silently dropped by `loadPreferences()`, never resurfacing as a second source of truth.
10. Ghost/Toolbar Opacity's `input`/`change`/Remember-gated persistence wiring is unchanged; Hover Opacity's mirrors it.
11. the ⚡ Automations state machine's ids and wiring markers are present and untouched.
12. every surviving DOM id from this feature is unique.

Also re-run: `node tools/check-dom-contract.js` — **0 failures, 0 warnings** (268 unique ids; the four ids removed by this correction — `presentation-controls-bar`, `toolbar-opacity-input`, `toolbar-opacity-label`, `toolbar-remember-input` — are gone cleanly with no dangling references). The full existing suite — all 65 `tools/test-*.mjs` files — was run again: **64 passed, 1 pre-existing failure** (`test-ambient-decision-multitab.mjs`, `"observer takes no row-projection input"`), previously confirmed to reproduce against the untouched baseline and unrelated to this work. `test-startup-media.mjs` (107 assertions, exercises `savePresentationPreferences({ ghostOpacityPercent: 77 })` directly) still passes unmodified.

## 8. Optional visual confirmation (not yet performed — recommended before sign-off)

1. Enter Presentation Mode, open the 👻 pop-under (now titled "Toolbar Opacity" on hover/screen-reader) — confirm it shows exactly two rows: Toolbar Opacity and Hover Opacity, no third.
2. Set Toolbar Opacity low (e.g. 20%) — confirm the toolbar rests at that opacity.
3. Hover the toolbar — confirm it changes to Hover Opacity's value; move away — confirm it returns immediately to Toolbar Opacity.
4. While still hovering (panel open), drag the Hover Opacity slider — confirm the toolbar's live opacity previews the new value immediately.
5. Reload with both Remember boxes ON — confirm both values restore.
6. Confirm ⚡ Automations (open/toggle when idle, immediate stop when active) is unchanged.

## 9. Final assessment

**PASS.** The feature now exposes exactly two customer-facing Presentation Mode toolbar opacity controls — Toolbar Opacity and Hover Opacity — as the human specified. Toolbar Opacity is the pre-existing Ghost Opacity mechanism with only its on-screen label changed (id, storage field names, clamp, and default all preserved verbatim). Hover Opacity is the one new preference, correctly replacing the old hardcoded 100% hover value rather than compositing alongside a separate new mechanism. The redundant slider/preference/CSS layer introduced in `1bf1145` has been fully removed with no migration debt (it was never real user-facing state). Automated coverage — `check-dom-contract.js`, a rewritten 75-assertion regression suite, and the full 65-file existing suite (all passing except the one confirmed-pre-existing, unrelated baseline failure) — verifies the corrected shape. This working tree has **not** been committed; per instructions, the human reviews and commits/pushes manually. Optional visual confirmation (§8) is still recommended before final sign-off.
