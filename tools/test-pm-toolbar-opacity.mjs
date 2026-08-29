#!/usr/bin/env node
// [PM-TOOLBAR-OPACITY]
// [WHY: Presentation Mode toolbar opacity has exactly TWO customer-facing
//  sliders — Toolbar Opacity (not-hovered) and Hover Opacity (hovered) — not
//  three. Toolbar Opacity is NOT a new preference: it is the pre-existing
//  "Ghost Opacity" mechanism (id `ghost-opacity-input`, storage field
//  `ghostOpacityPercent`/`rememberGhostOpacity`) with its on-screen label
//  renamed; its implementation/storage path was deliberately left alone.
//  Hover Opacity is the one genuinely new preference, replacing what used
//  to be a hardcoded 100% hover state. An earlier slice mistakenly ADDED a
//  third, redundant "Toolbar Opacity" control alongside Ghost Opacity
//  instead of renaming it — this file proves that regression is fully
//  reverted (no `toolbar-opacity-input`/`toolbarOpacityPercent` anywhere)
//  and that the corrected two-slider model holds, the same way
//  test-startup-media.mjs proves the startup-policy contract.]
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
const preferencesSource = fs.readFileSync(path.join(ROOT, "src", "storage", "app-preferences.js"), "utf8");

// ---- 1. exactly two PM opacity slider controls are customer-visible -------

console.log("\n1. exactly two PM opacity slider controls are customer-visible");
{
  const popunderOpen = html.indexOf('id="ghost-popunder"');
  const popunderClose = html.indexOf('<!-- The "⚙" row.', popunderOpen);
  assert(popunderOpen !== -1 && popunderClose !== -1 && popunderOpen < popunderClose, "#ghost-popunder container located");
  const popunderBody = html.slice(popunderOpen, popunderClose);

  const rowCount = (popunderBody.match(/class="ghost-popunder-row"/g) || []).length;
  assertEqual(rowCount, 2, "#ghost-popunder contains exactly two rows (Toolbar Opacity, Hover Opacity) — not three");

  const sliderCount = (popunderBody.match(/type="range"/g) || []).length;
  assertEqual(sliderCount, 2, "#ghost-popunder contains exactly two range sliders");

  const rememberCount = (popunderBody.match(/class="ghost-popunder-remember"/g) || []).length;
  assertEqual(rememberCount, 2, "#ghost-popunder contains exactly two Remember checkboxes");
}

// ---- 2. "Ghost Opacity" is no longer the customer-facing label ------------

console.log('\n2. "Ghost Opacity" is no longer a customer-facing label anywhere');
{
  // Strip HTML comments before searching — internal breadcrumbs are allowed
  // to reference the old name historically; only visible text/attributes
  // (label text, aria-label, title) must not say it.
  const visibleHtml = html.replace(/<!--[\s\S]*?-->/g, "");
  assert(!visibleHtml.includes("Ghost Opacity"), '"Ghost Opacity" does not appear in any visible HTML text or attribute');
}

// ---- 3. the pre-existing Ghost/resting mechanism is now Toolbar Opacity ---

console.log("\n3. the pre-existing Ghost Opacity mechanism is customer-labeled Toolbar Opacity, implementation unchanged");
{
  assert(html.includes('for="ghost-opacity-input">Toolbar Opacity<'), 'the <label> for #ghost-opacity-input now reads "Toolbar Opacity"');
  // Implementation/storage path preserved verbatim — same ids, same default,
  // same preference field names as before the rename.
  assert(html.includes('id="ghost-opacity-input" type="range" min="0" max="100" step="1" value="15"'), "#ghost-opacity-input markup (id, range, default 15) is unchanged");
  assert(html.includes('id="ghost-opacity-label"'), "#ghost-opacity-label id is unchanged");
  assert(html.includes('id="ghost-remember-input" type="checkbox" checked'), "#ghost-remember-input markup is unchanged");
  assert(preferencesSource.includes("ghostOpacityPercent"), "the ghostOpacityPercent storage field name is unchanged");
  assert(preferencesSource.includes("rememberGhostOpacity"), "the rememberGhostOpacity storage field name is unchanged");
  assert(mainJs.includes("function applyGhostOpacity(percent)"), "applyGhostOpacity() is still the function name backing Toolbar Opacity");
  assert(mainJs.includes("ghostOpacityInput"), "main.js still captures #ghost-opacity-input under its original name");

  // The toggle button that opens the popunder is also renamed, since it no
  // longer represents a "Ghost Opacity"-only control.
  assert(html.includes('aria-label="Toolbar Opacity"'), 'the 👻 toggle button aria-label reads "Toolbar Opacity"');
  assert(html.includes('title="Toolbar Opacity"'), 'the 👻 toggle button title reads "Toolbar Opacity"');
}

// ---- 4. there is no duplicate resting Toolbar Opacity control -------------

console.log("\n4. there is no duplicate/redundant resting Toolbar Opacity control left over from the reverted slice");
{
  for (const needle of [
    'id="toolbar-opacity-input"',
    'id="toolbar-opacity-label"',
    'id="toolbar-remember-input"',
    'id="presentation-controls-bar"',
  ]) {
    assert(!html.includes(needle), `${needle} no longer exists in index.html`);
  }
  for (const needle of ["toolbarOpacityPercent", "rememberToolbarOpacity", "DEFAULT_TOOLBAR_OPACITY_PERCENT"]) {
    assert(!preferencesSource.includes(needle), `${needle} no longer exists in app-preferences.js`);
    assert(!mainJs.includes(needle), `${needle} no longer exists in main.js`);
  }
  assert(!css.includes("--pm-toolbar-opacity"), "--pm-toolbar-opacity CSS var no longer exists");
  assert(!css.includes("--pm-toolbar-hover-opacity"), "--pm-toolbar-hover-opacity CSS var no longer exists");
  assert(!mainJs.includes("applyToolbarOpacity"), "applyToolbarOpacity() no longer exists — Toolbar Opacity is applyGhostOpacity()");
  assert(!mainJs.includes("presentationControlsBar"), "the redundant presentationControlsBar DOM capture no longer exists");
}

// ---- 5/6/7. Toolbar Opacity / Hover Opacity state machine (behavioral) ----

console.log("\n5-7. Toolbar Opacity governs not-hovered, Hover Opacity governs hovered, leaving hover restores Toolbar Opacity");
{
  // Simulate the real DOM/CSSOM effect main.js produces, using a minimal
  // fake element with the same style.setProperty surface main.js calls.
  function fakeElement() {
    const vars = {};
    return {
      vars,
      style: { setProperty: (name, value) => { vars[name] = value; } },
    };
  }

  const presentationControls = fakeElement();
  let currentGhostOpacityPercent = 15; // Toolbar Opacity, default
  let currentHoverOpacityPercent = 100; // Hover Opacity, default

  function applyGhostOpacity(percent) {
    currentGhostOpacityPercent = percent;
    presentationControls.style.setProperty("--ghost-opacity", String(percent / 100));
  }
  function applyHoverOpacity(percent) {
    currentHoverOpacityPercent = percent;
    presentationControls.style.setProperty("--ghost-opacity", String(percent / 100));
  }
  function mouseenter() {
    presentationControls.style.setProperty("--ghost-opacity", String(currentHoverOpacityPercent / 100));
  }
  function mouseleave() {
    applyGhostOpacity(currentGhostOpacityPercent);
  }

  // Realistic sequence: boot applies Toolbar Opacity last (not Hover
  // Opacity) — see main.js applyLoadedPreferences(), which calls
  // applyGhostOpacity() and only seeds currentHoverOpacityPercent directly
  // (no applyHoverOpacity() call) specifically so boot doesn't leave the
  // toolbar looking hovered.
  applyGhostOpacity(15);
  currentHoverOpacityPercent = 100;
  assertEqual(presentationControls.vars["--ghost-opacity"], "0.15", "at boot (not hovered), the toolbar renders at Toolbar Opacity (15%)");

  mouseenter();
  assertEqual(presentationControls.vars["--ghost-opacity"], "1", "hovering switches the toolbar to Hover Opacity (100%)");

  mouseleave();
  assertEqual(presentationControls.vars["--ghost-opacity"], "0.15", "leaving hover restores Toolbar Opacity (15%) exactly");

  // Hover Opacity lower than Toolbar Opacity — explicitly allowed, no
  // validation coupling.
  applyGhostOpacity(80);
  applyHoverOpacity(25);
  mouseenter();
  assertEqual(presentationControls.vars["--ghost-opacity"], "0.25", "Hover Opacity (25%) applies on hover even though lower than Toolbar Opacity (80%) — no forced minimum");
  mouseleave();
  assertEqual(presentationControls.vars["--ghost-opacity"], "0.8", "leaving hover restores Toolbar Opacity (80%), unaffected by the lower Hover Opacity value");
}

// Confirm the actual main.js source implements exactly this shape.
console.log("\n5-7b. main.js source implements the two-state hover model correctly");
{
  assert(
    mainJs.includes('presentationControls.addEventListener("mouseenter", () => {\n  presentationControls.style.setProperty("--ghost-opacity", String(currentHoverOpacityPercent / 100));\n});'),
    "mouseenter applies currentHoverOpacityPercent (Hover Opacity), not a hardcoded 1",
  );
  assert(
    mainJs.includes('presentationControls.addEventListener("mouseleave", () => {\n  applyGhostOpacity(currentGhostOpacityPercent);\n});'),
    "mouseleave restores currentGhostOpacityPercent (Toolbar Opacity) exactly, unchanged from before this correction",
  );
  assert(mainJs.includes("let currentGhostOpacityPercent = Number(ghostOpacityInput.value);"), "currentGhostOpacityPercent (Toolbar Opacity) is tracked");
  assert(mainJs.includes("let currentHoverOpacityPercent = Number(hoverOpacityInput.value);"), "currentHoverOpacityPercent (Hover Opacity) is tracked alongside it");
  assert(
    mainJs.includes("function applyHoverOpacity(percent) {\n  currentHoverOpacityPercent = percent;"),
    "applyHoverOpacity() updates the tracked hover value",
  );
}

// ---- 8. both Remember settings remain independent -------------------------

console.log("\n8. Toolbar Opacity's and Hover Opacity's Remember settings/values persist independently");
{
  installFakeIndexedDB();
  const Preferences = await import(src("storage/app-preferences.js"));

  await Preferences.savePresentationPreferences({ ghostOpacityPercent: 42, rememberGhostOpacity: true });
  await Preferences.savePresentationPreferences({ rememberHoverOpacity: false });

  let preferences = await Preferences.loadPreferences();
  assertEqual(preferences.presentation.ghostOpacityPercent, 42, "Toolbar Opacity's value saved independently");
  assertEqual(preferences.presentation.rememberGhostOpacity, true, "Toolbar Opacity's Remember saved independently");
  assertEqual(preferences.presentation.rememberHoverOpacity, false, "Hover Opacity's Remember saved independently, unaffected by Toolbar Opacity's save");
  assertEqual(preferences.presentation.hoverOpacityPercent, 100, "Hover Opacity's value (never explicitly saved) is still its default, untouched by the Remember-off save");

  // Unchecking Remember must not overwrite the previously stored remembered
  // value (mirrors the pre-existing Ghost Opacity contract exactly).
  await Preferences.savePresentationPreferences({ hoverOpacityPercent: 55, rememberHoverOpacity: true });
  await Preferences.savePresentationPreferences({ rememberHoverOpacity: false });
  preferences = await Preferences.loadPreferences();
  assertEqual(preferences.presentation.rememberHoverOpacity, false, "Hover Opacity's Remember is now false");
  assertEqual(preferences.presentation.hoverOpacityPercent, 55, "the previously remembered Hover Opacity value (55) survives being un-remembered");
  assertEqual(preferences.presentation.ghostOpacityPercent, 42, "Toolbar Opacity's own value is untouched by Hover Opacity's saves");

  // Clamping: each field falls back to its own default, not the other's.
  await Preferences.savePresentationPreferences({ ghostOpacityPercent: 999, hoverOpacityPercent: -5 });
  preferences = await Preferences.loadPreferences();
  assertEqual(preferences.presentation.ghostOpacityPercent, 15, "an out-of-range Toolbar Opacity value clamps to ITS OWN default (15)");
  assertEqual(preferences.presentation.hoverOpacityPercent, 100, "an out-of-range Hover Opacity value clamps to ITS OWN default (100), not Toolbar's (15)");

  // Sibling sections untouched.
  await Preferences.savePlaybackPreferences({ intervalSeconds: 42 });
  await Preferences.savePresentationPreferences({ hoverOpacityPercent: 33 });
  preferences = await Preferences.loadPreferences();
  assertEqual(preferences.playback.intervalSeconds, 42, "playback preferences survive a Hover Opacity save");
  assertEqual(preferences.presentation.hoverOpacityPercent, 33, "the Hover Opacity save itself still lands");

  assertEqual(Preferences.DEFAULT_GHOST_OPACITY_PERCENT, 15, "DEFAULT_GHOST_OPACITY_PERCENT (Toolbar Opacity's default) is unchanged");
  assertEqual(Preferences.DEFAULT_HOVER_OPACITY_PERCENT, 100, "DEFAULT_HOVER_OPACITY_PERCENT export is 100");
  assert(Preferences.DEFAULT_TOOLBAR_OPACITY_PERCENT === undefined, "DEFAULT_TOOLBAR_OPACITY_PERCENT is no longer exported");
}

// ---- 9. no stale redundant preference acts as a second source of truth ---

console.log("\n9. no stale redundant preference can act as a second source of truth for resting opacity");
{
  installFakeIndexedDB();
  const Preferences = await import(src("storage/app-preferences.js"));

  // A record carrying a stray `toolbarOpacityPercent`/`rememberToolbarOpacity`
  // (as if written by the reverted slice, or hand-edited) must simply be
  // ignored — normalizeRecord() only ever reads/returns the fields it knows
  // about, so an old stray field can never resurface as a second truth.
  await new Promise((resolve, reject) => {
    const request = indexedDB.open("loop-browser-gallery-preferences", 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("preferences")) {
        request.result.createObjectStore("preferences", { keyPath: "id" });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction("preferences", "readwrite");
      tx.objectStore("preferences").put({
        id: "global",
        schemaVersion: 1,
        presentation: {
          rememberGhostOpacity: true,
          ghostOpacityPercent: 15,
          rememberToolbarOpacity: true,
          toolbarOpacityPercent: 77,
          rememberHoverOpacity: true,
          hoverOpacityPercent: 60,
        },
      });
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
    request.onerror = () => reject(request.error);
  });

  const preferences = await Preferences.loadPreferences();
  assert(!("toolbarOpacityPercent" in preferences.presentation), "a stray stored toolbarOpacityPercent is dropped, not returned");
  assert(!("rememberToolbarOpacity" in preferences.presentation), "a stray stored rememberToolbarOpacity is dropped, not returned");
  assertEqual(preferences.presentation.ghostOpacityPercent, 15, "Toolbar Opacity (ghostOpacityPercent) is the sole resting-opacity value, read normally");
  assertEqual(preferences.presentation.hoverOpacityPercent, 60, "Hover Opacity is read normally alongside it");
}

// ---- 10. Ghost/Toolbar Opacity's persistence-gating pattern is unchanged --

console.log("\n10. Toolbar Opacity's Remember-gated input/change wiring is unchanged; Hover Opacity mirrors it");
{
  assert(mainJs.includes('ghostOpacityInput.addEventListener("input", () => {\n  applyGhostOpacity(Number(ghostOpacityInput.value));\n});'), "Toolbar Opacity's 'input' listener is unchanged");
  assert(
    mainJs.includes('ghostOpacityInput.addEventListener("change", () => {\n  if (!ghostRememberInput.checked) return;'),
    "Toolbar Opacity's persistence path is still gated on ghostRememberInput.checked",
  );
  assert(mainJs.includes('hoverOpacityInput.addEventListener("input", () => {\n  applyHoverOpacity(Number(hoverOpacityInput.value));\n});'), "Hover Opacity's 'input' listener mirrors Toolbar Opacity's");
  assert(
    mainJs.includes('hoverOpacityInput.addEventListener("change", () => {\n  if (!hoverRememberInput.checked) return;'),
    "Hover Opacity's persistence path is gated on hoverRememberInput.checked",
  );
  assert(mainJs.includes("rememberHoverOpacity: remember"), "hoverRememberInput's change handler saves rememberHoverOpacity");
}

// ---- 11. PM ⚡ Automations state machine is untouched -----------------------

console.log("\n11. PM Automations (⚡) state machine markup/wiring is untouched");
{
  assert(html.includes('id="overlay-automations-menu-btn"'), "the ⚡ Automations button id is unchanged");
  assert(html.includes('id="pm-automations-group"'), "the Automations tray id is unchanged");
  assert(html.includes('id="automation-panel"'), "the Automations panel id is unchanged");
  assert(mainJs.includes('pmAutomationsGroup.classList.remove("is-open");'), "Automations tray close wiring is present and untouched");
  assert(mainJs.includes("resetLoopRuleToDefault();"), "Loop Rule reset-on-exit wiring is present and untouched");
}

// ---- 12. DOM ids stay unique / references resolve --------------------------

console.log("\n12. surviving DOM ids are unique and correctly referenced");
{
  for (const id of ["ghost-opacity-input", "ghost-opacity-label", "ghost-remember-input", "hover-opacity-input", "hover-opacity-label", "hover-remember-input", "ghost-toggle-btn", "ghost-popunder"]) {
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
  console.log(`ok    ${passes} assertion(s) passed - PM Toolbar/Hover Opacity (two-slider model) holds.`);
}
