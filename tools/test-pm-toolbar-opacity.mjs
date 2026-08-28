#!/usr/bin/env node
// [PM-TOOLBAR-OPACITY]
// [WHY: Toolbar Opacity and Hover Opacity are two new, independently
//  persisted Presentation Mode preferences — siblings of the pre-existing
//  Ghost Opacity, never merged with it or with each other. This file proves
//  the preference-layer contract (defaults, clamping, independent
//  Remember-checkbox persistence, Ghost Opacity left untouched) the same
//  way test-startup-media.mjs proves the startup-policy contract, plus a
//  set of static source/DOM checks confirming main.js/index.html/styles.css
//  wire the two new sliders to the correct target element
//  (#presentation-controls-bar, NOT #presentation-controls, which Ghost
//  Opacity already owns) and leave the ⚡ Automations state machine alone.]
//
// Usage:  node tools/test-pm-toolbar-opacity.mjs

import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { installFakeIndexedDB } from "./lib/browser-test-env.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const src = (rel) => pathToFileURL(path.join(ROOT, "src", rel)).href;

let failures = 0;
let passes = 0;

function assert(condition, label, detail) {
  if (condition) {
    passes++;
    return true;
  }
  failures++;
  console.log(`  FAIL  ${label}`);
  if (detail) console.log(`        ${detail}`);
  return false;
}

function assertEqual(actual, expected, label) {
  return assert(
    actual === expected,
    label,
    actual === expected ? null : `expected: ${JSON.stringify(expected)}\n        actual:   ${JSON.stringify(actual)}`,
  );
}

const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const css = fs.readFileSync(path.join(ROOT, "styles.css"), "utf8");
const mainJs = fs.readFileSync(path.join(ROOT, "src", "main.js"), "utf8");

// ---- 1. defaults preserve current visual behavior --------------------------

console.log("\n1. Toolbar Opacity / Hover Opacity have defaults that preserve existing behavior");
{
  installFakeIndexedDB();
  const Preferences = await import(src("storage/app-preferences.js"));

  const preferences = await Preferences.loadPreferences();
  assertEqual(preferences.presentation.toolbarOpacityPercent, 100, "toolbarOpacityPercent defaults to 100 (no visual change vs. today's hardcoded full-opacity bar)");
  assertEqual(preferences.presentation.hoverOpacityPercent, 100, "hoverOpacityPercent defaults to 100 (matches today's hardcoded hover state)");
  assertEqual(preferences.presentation.rememberToolbarOpacity, true, "rememberToolbarOpacity defaults to true");
  assertEqual(preferences.presentation.rememberHoverOpacity, true, "rememberHoverOpacity defaults to true");
  assertEqual(Preferences.DEFAULT_TOOLBAR_OPACITY_PERCENT, 100, "DEFAULT_TOOLBAR_OPACITY_PERCENT export is 100");
  assertEqual(Preferences.DEFAULT_HOVER_OPACITY_PERCENT, 100, "DEFAULT_HOVER_OPACITY_PERCENT export is 100");
  // Ghost Opacity's own default is untouched by this slice.
  assertEqual(preferences.presentation.ghostOpacityPercent, 15, "ghostOpacityPercent default (15) is unchanged");
  assertEqual(Preferences.DEFAULT_GHOST_OPACITY_PERCENT, 15, "DEFAULT_GHOST_OPACITY_PERCENT export is unchanged");
}

// ---- 2. both values normalize/clamp correctly -------------------------------

console.log("\n2. toolbarOpacityPercent / hoverOpacityPercent normalize and clamp correctly");
{
  installFakeIndexedDB();
  const Preferences = await import(src("storage/app-preferences.js"));

  await Preferences.savePresentationPreferences({ toolbarOpacityPercent: 150, hoverOpacityPercent: -10 });
  let preferences = await Preferences.loadPreferences();
  assertEqual(preferences.presentation.toolbarOpacityPercent, 100, "an out-of-range toolbarOpacityPercent (150) clamps to ITS OWN default (100), not Ghost's (15)");
  assertEqual(preferences.presentation.hoverOpacityPercent, 100, "an out-of-range hoverOpacityPercent (-10) clamps to ITS OWN default (100), not Ghost's (15)");

  await Preferences.savePresentationPreferences({ toolbarOpacityPercent: "not-a-number", hoverOpacityPercent: NaN });
  preferences = await Preferences.loadPreferences();
  assertEqual(preferences.presentation.toolbarOpacityPercent, 100, "a non-numeric toolbarOpacityPercent falls back to 100");
  assertEqual(preferences.presentation.hoverOpacityPercent, 100, "a NaN hoverOpacityPercent falls back to 100");

  await Preferences.savePresentationPreferences({ toolbarOpacityPercent: 37.6, hoverOpacityPercent: 8.2 });
  preferences = await Preferences.loadPreferences();
  assertEqual(preferences.presentation.toolbarOpacityPercent, 38, "toolbarOpacityPercent rounds like Ghost Opacity's own clamp does");
  assertEqual(preferences.presentation.hoverOpacityPercent, 8, "hoverOpacityPercent rounds like Ghost Opacity's own clamp does");
}

// ---- 3. Hover Opacity may legitimately be lower than Toolbar Opacity -------

console.log("\n3. setting Hover Opacity lower than Toolbar Opacity is allowed (no forced minimum)");
{
  installFakeIndexedDB();
  const Preferences = await import(src("storage/app-preferences.js"));

  await Preferences.savePresentationPreferences({ toolbarOpacityPercent: 90, hoverOpacityPercent: 10 });
  const preferences = await Preferences.loadPreferences();
  assertEqual(preferences.presentation.toolbarOpacityPercent, 90, "toolbarOpacityPercent saved as-is");
  assertEqual(preferences.presentation.hoverOpacityPercent, 10, "hoverOpacityPercent saved as-is, lower than toolbarOpacityPercent, with no validation error");
}

// ---- 4. each Remember checkbox persists independently -----------------------

console.log("\n4. Toolbar Opacity and Hover Opacity Remember state/value persist independently of each other and of Ghost Opacity");
{
  installFakeIndexedDB();
  const Preferences = await import(src("storage/app-preferences.js"));

  await Preferences.savePresentationPreferences({ ghostOpacityPercent: 60, rememberGhostOpacity: true });
  await Preferences.savePresentationPreferences({ toolbarOpacityPercent: 25, rememberToolbarOpacity: true });
  await Preferences.savePresentationPreferences({ rememberHoverOpacity: false });

  const preferences = await Preferences.loadPreferences();
  assertEqual(preferences.presentation.ghostOpacityPercent, 60, "ghostOpacityPercent saved independently");
  assertEqual(preferences.presentation.rememberGhostOpacity, true, "rememberGhostOpacity saved independently");
  assertEqual(preferences.presentation.toolbarOpacityPercent, 25, "toolbarOpacityPercent saved independently, unaffected by the hover-only save that followed it");
  assertEqual(preferences.presentation.rememberToolbarOpacity, true, "rememberToolbarOpacity saved independently");
  assertEqual(preferences.presentation.rememberHoverOpacity, false, "rememberHoverOpacity saved independently, unaffected by the earlier ghost/toolbar saves");
  // hoverOpacityPercent itself was never written above, so it must still be
  // sitting at its default — the Remember-off save above did not smuggle in
  // some other value for it.
  assertEqual(preferences.presentation.hoverOpacityPercent, 100, "hoverOpacityPercent, never explicitly saved, is still the default");
}

// ---- 5. Remember OFF does not overwrite the stored remembered value ---------

console.log("\n5. Remember OFF does not overwrite the previously stored remembered value");
{
  installFakeIndexedDB();
  const Preferences = await import(src("storage/app-preferences.js"));

  // Simulates: user sets Toolbar Opacity to 55 with Remember ON (main.js's
  // toolbarOpacityInput "change" handler commits it because
  // toolbarRememberInput.checked is true at that moment).
  await Preferences.savePresentationPreferences({ toolbarOpacityPercent: 55, rememberToolbarOpacity: true });

  // User then unchecks Remember. main.js's toolbarRememberInput "change"
  // handler saves ONLY { rememberToolbarOpacity: false } — it deliberately
  // does not include toolbarOpacityPercent in that partial (mirroring
  // ghostRememberInput's own handler), so the stored 55 must survive
  // untouched even though the UI will now display the built-in default
  // instead of it.
  await Preferences.savePresentationPreferences({ rememberToolbarOpacity: false });

  const preferences = await Preferences.loadPreferences();
  assertEqual(preferences.presentation.rememberToolbarOpacity, false, "rememberToolbarOpacity is now false");
  assertEqual(preferences.presentation.toolbarOpacityPercent, 55, "the previously remembered 55 is still in storage, not overwritten by unchecking Remember");
}

// ---- 6. saving Toolbar/Hover Opacity leaves every sibling section intact ---

console.log("\n6. saving Toolbar Opacity / Hover Opacity leaves playback / startup / microArcade / onboarding / Ghost Opacity intact");
{
  installFakeIndexedDB();
  const Preferences = await import(src("storage/app-preferences.js"));

  await Preferences.savePlaybackPreferences({ intervalSeconds: 42, shuffle: false });
  await Preferences.savePresentationPreferences({ ghostOpacityPercent: 77 });
  await Preferences.saveMicroArcadePreferences({ animationOrder: "sequential" });
  await Preferences.saveOnboardingPreferences({ profileSyncIntroSeen: true });
  await Preferences.saveStartupPreferences("browser", { policy: "random-selected", eligibleLibraryIds: ["lib-x"] });

  await Preferences.savePresentationPreferences({ toolbarOpacityPercent: 33, hoverOpacityPercent: 66 });
  const preferences = await Preferences.loadPreferences();

  assertEqual(preferences.playback.intervalSeconds, 42, "playback.intervalSeconds survives a Toolbar/Hover Opacity save");
  assertEqual(preferences.playback.shuffle, false, "playback.shuffle survives a Toolbar/Hover Opacity save");
  assertEqual(preferences.presentation.ghostOpacityPercent, 77, "presentation.ghostOpacityPercent survives a Toolbar/Hover Opacity save");
  assertEqual(preferences.microArcade.animationOrder, "sequential", "microArcade.animationOrder survives a Toolbar/Hover Opacity save");
  assertEqual(preferences.onboarding.profileSyncIntroSeen, true, "onboarding.profileSyncIntroSeen survives a Toolbar/Hover Opacity save");
  assertEqual(preferences.startup.browser.policy, "random-selected", "startup.browser.policy survives a Toolbar/Hover Opacity save");
  assertEqual(preferences.presentation.toolbarOpacityPercent, 33, "the Toolbar Opacity save itself still lands");
  assertEqual(preferences.presentation.hoverOpacityPercent, 66, "the Hover Opacity save itself still lands");
}

// ---- 7. DOM: Toolbar Opacity / Hover Opacity controls are present ----------

console.log("\n7. DOM: Toolbar Opacity and Hover Opacity controls exist with the Ghost Opacity slider pattern");
{
  for (const [prefix, label] of [
    ["toolbar", "Toolbar Opacity"],
    ["hover", "Hover Opacity"],
  ]) {
    assert(html.includes(`id="${prefix}-opacity-input"`), `#${prefix}-opacity-input is present`);
    assert(html.includes(`id="${prefix}-opacity-label"`), `#${prefix}-opacity-label is present`);
    assert(html.includes(`id="${prefix}-remember-input"`), `#${prefix}-remember-input is present`);
    assert(html.includes(`for="${prefix}-opacity-input">${label}<`), `the "${label}" <label> targets #${prefix}-opacity-input`);
    assert(html.includes(`for="${prefix}-remember-input"`), `#${prefix}-remember-input has an associated Remember <label>`);

    const inputTagMatch = html.match(new RegExp(`<input id="${prefix}-opacity-input"[^>]*>`));
    assert(!!inputTagMatch, `#${prefix}-opacity-input <input> tag found`);
    if (inputTagMatch) {
      const tag = inputTagMatch[0];
      assert(/type="range"/.test(tag), `#${prefix}-opacity-input is a range slider, matching Ghost Opacity's slider`);
      assert(/min="0"/.test(tag) && /max="100"/.test(tag), `#${prefix}-opacity-input covers the same 0-100 range as Ghost Opacity`);
      assert(/value="100"/.test(tag), `#${prefix}-opacity-input's markup default is 100 (matches the no-visual-change default)`);
    }
  }

  // Ghost Opacity's own row is untouched: same id, same label text, same
  // default markup value, class-renamed value span notwithstanding.
  assert(html.includes('for="ghost-opacity-input">Ghost Opacity<'), "Ghost Opacity's own <label> is unchanged");
  assert(html.includes('id="ghost-opacity-input" type="range" min="0" max="100" step="1" value="15"'), "Ghost Opacity's own <input> markup is unchanged");

  // All three rows live inside the same #ghost-popunder container ("where
  // the existing Presentation Mode opacity controls live").
  const popunderOpen = html.indexOf('id="ghost-popunder"');
  const popunderClose = html.indexOf("<!-- The \"⚙\" row.", popunderOpen);
  assert(popunderOpen !== -1 && popunderClose !== -1 && popunderOpen < popunderClose, "#ghost-popunder container located");
  const popunderBody = html.slice(popunderOpen, popunderClose);
  for (const id of ["ghost-opacity-input", "toolbar-opacity-input", "hover-opacity-input"]) {
    assert(popunderBody.includes(`id="${id}"`), `#${id} lives inside #ghost-popunder, alongside its siblings`);
  }
}

// ---- 8. DOM: presentation-controls-bar id exists and is the toolbar bar ----

console.log("\n8. DOM: #presentation-controls-bar is the actual PM toolbar bar, distinct from #presentation-controls");
{
  assert(html.includes('id="presentation-controls-bar" class="presentation-controls-bar"'), "#presentation-controls-bar id is present on the toolbar bar element");
  // It must be a CHILD of #presentation-controls (Ghost Opacity's own
  // target), not a replacement for it.
  const outerAt = html.indexOf('id="presentation-controls" class="presentation-controls');
  const barAt = html.indexOf('id="presentation-controls-bar"');
  assert(outerAt !== -1 && barAt !== -1 && outerAt < barAt, "#presentation-controls-bar appears nested inside #presentation-controls, not standalone");
  // Sanity: the toolbar bar itself contains the actual buttons (Hide/Undo/Exit/gear).
  const barSection = html.slice(barAt, barAt + 8000);
  assert(barSection.includes('id="overlay-exit-btn"'), "#presentation-controls-bar contains the Exit button — confirms this is the real toolbar, not an empty wrapper");
}

// ---- 9. CSS: Toolbar/Hover Opacity target the bar; Ghost targets the wrapper -

console.log("\n9. CSS: --pm-toolbar-opacity/--pm-toolbar-hover-opacity apply to .presentation-controls-bar only; --ghost-opacity still applies to .presentation-controls only");
{
  const barRuleMatch = css.match(/\.presentation-controls-bar\s*\{[^}]*\}/);
  assert(!!barRuleMatch, ".presentation-controls-bar rule found");
  if (barRuleMatch) {
    assert(/opacity:\s*var\(--pm-toolbar-opacity/.test(barRuleMatch[0]), ".presentation-controls-bar's own opacity is driven by --pm-toolbar-opacity");
  }
  assert(/\.presentation-controls-bar:hover\s*\{[^}]*--pm-toolbar-hover-opacity/.test(css), ".presentation-controls-bar:hover switches to --pm-toolbar-hover-opacity via plain CSS :hover");

  const wrapperRuleMatch = css.match(/\.presentation-controls\s*\{[^}]*\}/);
  assert(!!wrapperRuleMatch, ".presentation-controls (Ghost Opacity's target) rule found");
  if (wrapperRuleMatch) {
    assert(/opacity:\s*var\(--ghost-opacity\)/.test(wrapperRuleMatch[0]), ".presentation-controls still uses --ghost-opacity, unchanged by this slice");
    assert(!/--pm-toolbar/.test(wrapperRuleMatch[0]), ".presentation-controls does not also carry the new toolbar/hover opacity vars — the two mechanisms stay independent");
  }

  assert(/--pm-toolbar-opacity:\s*1;/.test(css), "--pm-toolbar-opacity root fallback is 1 (fully opaque, no-op default)");
  assert(/--pm-toolbar-hover-opacity:\s*1;/.test(css), "--pm-toolbar-hover-opacity root fallback is 1 (fully opaque, no-op default)");
}

// ---- 10. main.js: applyToolbarOpacity/applyHoverOpacity wired correctly ---

console.log("\n10. main.js: Toolbar Opacity / Hover Opacity are wired via the same input/change/Remember pattern as Ghost Opacity");
{
  assert(/function applyToolbarOpacity\(percent\)\s*\{/.test(mainJs), "applyToolbarOpacity() is defined");
  assert(/function applyHoverOpacity\(percent\)\s*\{/.test(mainJs), "applyHoverOpacity() is defined");
  assert(
    /applyToolbarOpacity\(percent\)\s*\{\s*presentationControlsBar\.style\.setProperty\("--pm-toolbar-opacity"/.test(mainJs),
    "applyToolbarOpacity() sets --pm-toolbar-opacity on presentationControlsBar (not presentationControls)",
  );
  assert(
    /applyHoverOpacity\(percent\)\s*\{\s*presentationControlsBar\.style\.setProperty\("--pm-toolbar-hover-opacity"/.test(mainJs),
    "applyHoverOpacity() sets --pm-toolbar-hover-opacity on presentationControlsBar",
  );

  assert(mainJs.includes('toolbarOpacityInput.addEventListener("input"'), "toolbarOpacityInput has a live 'input' listener");
  assert(mainJs.includes('hoverOpacityInput.addEventListener("input"'), "hoverOpacityInput has a live 'input' listener");
  assert(
    mainJs.includes('toolbarOpacityInput.addEventListener("change", () => {\n  if (!toolbarRememberInput.checked) return;'),
    "toolbarOpacityInput's persistence path is gated on toolbarRememberInput.checked, matching Ghost Opacity",
  );
  assert(
    mainJs.includes('hoverOpacityInput.addEventListener("change", () => {\n  if (!hoverRememberInput.checked) return;'),
    "hoverOpacityInput's persistence path is gated on hoverRememberInput.checked, matching Ghost Opacity",
  );
  assert(mainJs.includes("rememberToolbarOpacity: remember"), "toolbarRememberInput's change handler saves rememberToolbarOpacity");
  assert(mainJs.includes("rememberHoverOpacity: remember"), "hoverRememberInput's change handler saves rememberHoverOpacity");

  // Boot-time restore: seeded from loaded preferences with the same
  // unchecked-Remember-falls-back-to-default rule Ghost Opacity uses.
  assert(mainJs.includes("toolbarOpacityInput.value = String(toolbarPercent);"), "boot restores toolbarOpacityInput.value from loaded preferences");
  assert(mainJs.includes("hoverOpacityInput.value = String(hoverPercent);"), "boot restores hoverOpacityInput.value from loaded preferences");
  assert(mainJs.includes("applyToolbarOpacity(Number(toolbarOpacityInput.value));"), "boot applies the restored Toolbar Opacity");
  assert(mainJs.includes("applyHoverOpacity(Number(hoverOpacityInput.value));"), "boot applies the restored Hover Opacity");
  assert(
    mainJs.includes("? presentation.toolbarOpacityPercent\n    : DEFAULT_TOOLBAR_OPACITY_PERCENT;"),
    "an unchecked rememberToolbarOpacity falls back to DEFAULT_TOOLBAR_OPACITY_PERCENT at boot, not a stale stored number",
  );
  assert(
    mainJs.includes("? presentation.hoverOpacityPercent\n    : DEFAULT_HOVER_OPACITY_PERCENT;"),
    "an unchecked rememberHoverOpacity falls back to DEFAULT_HOVER_OPACITY_PERCENT at boot, not a stale stored number",
  );
}

// ---- 11. Ghost Opacity's own code path is byte-for-byte unchanged ---------

console.log("\n11. Ghost Opacity's existing implementation is unchanged");
{
  assert(
    mainJs.includes('function applyGhostOpacity(percent) {\n  currentGhostOpacityPercent = percent;\n  presentationControls.style.setProperty("--ghost-opacity", String(percent / 100));\n  ghostOpacityLabel.textContent = `${percent}%`;\n}'),
    "applyGhostOpacity() body is character-for-character unchanged",
  );
  assert(
    mainJs.includes('presentationControls.addEventListener("mouseenter", () => {\n  presentationControls.style.setProperty("--ghost-opacity", "1");\n});'),
    "Ghost Opacity's mouseenter handler is unchanged",
  );
  assert(
    mainJs.includes('presentationControls.addEventListener("mouseleave", () => {\n  applyGhostOpacity(currentGhostOpacityPercent);\n});'),
    "Ghost Opacity's mouseleave handler is unchanged",
  );
  assert(mainJs.includes('ghostOpacityInput.addEventListener("change", () => {\n  if (!ghostRememberInput.checked) return;'), "Ghost Opacity's own Remember-gated save handler is unchanged");
}

// ---- 12. PM ⚡ Automations state machine is untouched -----------------------

console.log("\n12. PM Automations (⚡) state machine markup/wiring is untouched");
{
  assert(html.includes('id="overlay-automations-menu-btn"'), "the ⚡ Automations button id is unchanged");
  assert(html.includes('id="pm-automations-group"'), "the Automations tray id is unchanged");
  assert(html.includes('id="automation-panel"'), "the Automations panel id is unchanged");
  assert(mainJs.includes("pmAutomationsGroup.classList.remove(\"is-open\");"), "Automations tray close wiring is present and untouched");
  assert(mainJs.includes("resetLoopRuleToDefault();"), "Loop Rule reset-on-exit wiring is present and untouched");
}

// ---- 13. DOM ids stay unique / references resolve --------------------------

console.log("\n13. DOM ids introduced by this slice are unique and referenced correctly");
{
  const newIds = [
    "presentation-controls-bar",
    "toolbar-opacity-input",
    "toolbar-opacity-label",
    "toolbar-remember-input",
    "hover-opacity-input",
    "hover-opacity-label",
    "hover-remember-input",
  ];
  for (const id of newIds) {
    const count = (html.match(new RegExp(`id="${id}"`, "g")) || []).length;
    assertEqual(count, 1, `#${id} appears exactly once in index.html`);
  }
}

// ---- summary -----------------------------------------------------------

console.log(`\n------------------------------------------------------------`);
if (failures > 0) {
  console.log(`FAIL  ${failures} failure(s), ${passes} passed - PM Toolbar/Hover Opacity regressions found.`);
  process.exit(1);
} else {
  console.log(`ok    ${passes} assertion(s) passed - PM Toolbar/Hover Opacity holds.`);
}
