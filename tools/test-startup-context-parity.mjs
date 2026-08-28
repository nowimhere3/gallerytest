#!/usr/bin/env node
// [STARTUP-CONTEXT-PARITY / N6-9]
// [WHY: N6-9 makes Normal Browser Gallery and StreamLoop symmetrical — each
//  gets an independent startup policy (now including an explicit "off"
//  choice) and an independent post-load Auto Fill preference — and moves
//  ALL StreamLoop-specific customer-facing controls into the StreamLoop
//  Integration disclosure. This file proves the NEW cross-context behavior:
//  the "off" mode itself (both contexts, both persistence and the boot-time
//  no-op it produces), Normal BG's own Auto Fill, independence between the
//  two contexts' policy/pool/autoFill values, the disabled-checkbox
//  semantics while a context's policy is "off", and the Advanced Settings
//  regrouping. StreamLoop's own migration/sequencing tests stay in
//  tools/test-streamloop-autofill.mjs; decideStartupMedia()'s own decision
//  table stays in tools/test-startup-media.mjs, both untouched by this
//  slice.]
//
// Usage:  node tools/test-startup-context-parity.mjs

import { pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { installFakeIndexedDB } from "./lib/browser-test-env.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const src = (rel) => pathToFileURL(path.join(ROOT, "src", rel)).href;

let failures = 0;
let passes = 0;
const failureDetail = [];

function assert(condition, label, detail) {
  if (condition) {
    passes++;
    return true;
  }
  failures++;
  failureDetail.push(`${label}${detail ? `\n        ${detail}` : ""}`);
  console.log(`  FAIL  ${label}`);
  if (detail) console.log(`        ${detail}`);
  return false;
}

function assertEqual(actual, expected, label) {
  return assert(
    actual === expected,
    label,
    actual === expected ? null : `expected: ${JSON.stringify(expected)}\n        actual:   ${JSON.stringify(actual)}`
  );
}

// ---- 1. preferences: "off" normalizes correctly, in both directions -------

console.log('\n1. preferences: the "off" startup policy normalizes correctly');
{
  installFakeIndexedDB();
  const Preferences = await import(src("storage/app-preferences.js"));

  await Preferences.saveStartupPreferences("browser", { policy: "off" });
  await Preferences.saveStartupPreferences("streamloop", { policy: "off" });
  let preferences = await Preferences.loadPreferences();
  assertEqual(preferences.startup.browser.policy, "off", "browser policy can be explicitly set to off");
  assertEqual(preferences.startup.streamloop.policy, "off", "streamloop policy can be explicitly set to off");

  // "off" is reachable ONLY by explicit choice — malformed/unrecognized data
  // still falls back to "last-used", exactly as before "off" existed.
  await Preferences.saveStartupPreferences("browser", { policy: "definitely-not-a-real-policy" });
  preferences = await Preferences.loadPreferences();
  assertEqual(preferences.startup.browser.policy, "last-used", "an unrecognized policy string still falls back to last-used, never off");

  // Absence of any opinion at all (a bare, empty startup object) also lands
  // on last-used — the pre-N6-9 default is completely undisturbed.
  await Preferences.saveStartupPreferences("browser", {});
  preferences = await Preferences.loadPreferences();
  assertEqual(preferences.startup.browser.policy, "last-used", "no explicit policy at all still defaults to last-used");
}

// ---- 2. preferences: Normal BG gets its own independent Auto Fill ---------

console.log("\n2. preferences: browser.autoFillPanel is independent of streamloop.autoFillPanel");
{
  installFakeIndexedDB();
  const Preferences = await import(src("storage/app-preferences.js"));

  let preferences = await Preferences.loadPreferences();
  assertEqual(preferences.startup.browser.autoFillPanel, false, "browser autoFillPanel defaults to false, same as streamloop's");

  // Example from the task: browser ON, streamloop OFF.
  await Preferences.saveStartupPreferences("browser", { autoFillPanel: true });
  preferences = await Preferences.loadPreferences();
  assertEqual(preferences.startup.browser.autoFillPanel, true, "browser autoFillPanel turns on independently");
  assertEqual(preferences.startup.streamloop.autoFillPanel, false, "streamloop autoFillPanel is untouched by browser's own save");

  // And the inverse: streamloop ON, browser OFF.
  await Preferences.saveStartupPreferences("browser", { autoFillPanel: false });
  await Preferences.saveStartupPreferences("streamloop", { autoFillPanel: true });
  preferences = await Preferences.loadPreferences();
  assertEqual(preferences.startup.browser.autoFillPanel, false, "browser autoFillPanel turned back off independently");
  assertEqual(preferences.startup.streamloop.autoFillPanel, true, "streamloop autoFillPanel is untouched by browser's own save (inverse case)");
}

// ---- 3. preferences: startup policy independence, including OFF ----------

console.log("\n3. preferences: startup policy independence, including the off mode");
{
  installFakeIndexedDB();
  const Preferences = await import(src("storage/app-preferences.js"));

  // browser OFF, streamloop RANDOM_SELECTED
  await Preferences.saveStartupPreferences("browser", { policy: "off" });
  await Preferences.saveStartupPreferences("streamloop", { policy: "random-selected", eligibleLibraryIds: ["lib-1"] });
  let preferences = await Preferences.loadPreferences();
  assertEqual(preferences.startup.browser.policy, "off", "browser is off");
  assertEqual(preferences.startup.streamloop.policy, "random-selected", "streamloop is random-selected, unaffected by browser being off");
  assertEqual(preferences.startup.streamloop.eligibleLibraryIds.join(","), "lib-1", "streamloop's own eligible pool is intact");

  // Inverse: streamloop OFF, browser RANDOM_SELECTED. A fresh
  // installFakeIndexedDB() call is enough to reset storage — the already-
  // imported module holds no state of its own beyond the write-serialization
  // queue, which is safe to keep reusing across a reset backing store.
  installFakeIndexedDB();
  await Preferences.saveStartupPreferences("streamloop", { policy: "off" });
  await Preferences.saveStartupPreferences("browser", { policy: "random-selected", eligibleLibraryIds: ["lib-2"] });
  preferences = await Preferences.loadPreferences();
  assertEqual(preferences.startup.streamloop.policy, "off", "streamloop is off (inverse case)");
  assertEqual(preferences.startup.browser.policy, "random-selected", "browser is random-selected, unaffected by streamloop being off");
  assertEqual(preferences.startup.browser.eligibleLibraryIds.join(","), "lib-2", "browser's own eligible pool is intact");
}

// ---- 4. preferences: a saved Auto Fill value survives while policy is off,
//        and reappears once an automatic mode is chosen again ---------------

console.log("\n4. preferences: a saved Auto Fill value survives untouched while policy is off");
{
  installFakeIndexedDB();
  const Preferences = await import(src("storage/app-preferences.js"));

  await Preferences.saveStartupPreferences("streamloop", { autoFillPanel: true });
  await Preferences.saveStartupPreferences("streamloop", { policy: "off" });
  let preferences = await Preferences.loadPreferences();
  assertEqual(preferences.startup.streamloop.policy, "off", "policy is off");
  assertEqual(preferences.startup.streamloop.autoFillPanel, true, "the previously saved Auto Fill=true value is NOT destroyed by switching to off");

  // Switching back to an automatic mode must not have silently reset it.
  await Preferences.saveStartupPreferences("streamloop", { policy: "last-used" });
  preferences = await Preferences.loadPreferences();
  assertEqual(preferences.startup.streamloop.policy, "last-used", "policy is back to an automatic mode");
  assertEqual(preferences.startup.streamloop.autoFillPanel, true, "the Auto Fill value survived the round trip through off and back");
}

// ---- 5. DOM: both startup selectors expose the off choice ------------------

console.log("\n5. DOM: both startup policy selects expose the off option");
{
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");

  for (const selectId of ["startup-media-browser-policy-select", "startup-media-streamloop-policy-select"]) {
    const selectAt = html.indexOf(`id="${selectId}"`);
    assert(selectAt !== -1, `#${selectId} is present`);
    if (selectAt === -1) continue;
    const selectEnd = html.indexOf("</select>", selectAt);
    const selectBody = html.slice(selectAt, selectEnd);
    assert(selectBody.includes('value="off"'), `#${selectId} includes the off option`);
    assert(
      selectBody.includes(">Do not load media automatically<"),
      `#${selectId}'s off option uses the explicit customer-facing phrase, not a bare technical value`
    );
    // "off" is listed first, matching the task's own ordering.
    const offAt = selectBody.indexOf('value="off"');
    const lastUsedAt = selectBody.indexOf('value="last-used"');
    assert(offAt !== -1 && lastUsedAt !== -1 && offAt < lastUsedAt, `#${selectId} lists "off" before the other choices`);
  }
}

// ---- 6. DOM: Normal BG has its own Auto Fill control -----------------------

console.log("\n6. DOM: Normal Browser Gallery has its own Auto Fill Panel control, inside Startup Media");
{
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");

  const startupMediaAt = html.indexOf('class="advanced-startup-media-section"');
  const startupMediaEnd = html.indexOf("</details>", startupMediaAt);
  const startupMediaSection = html.slice(startupMediaAt, startupMediaEnd);

  assert(startupMediaSection.includes('id="startup-media-browser-auto-fill-panel-input"'), "Normal BG's own Auto Fill checkbox lives inside Startup Media");
  assert(startupMediaSection.includes('id="startup-media-browser-auto-fill-helper"'), "Normal BG's Auto Fill disabled-state helper lives inside Startup Media");
  assert(startupMediaSection.includes(">Auto Fill Panel after media loads<"), "the checkbox uses the same customer-facing label as StreamLoop's own");
  assert(!startupMediaSection.includes("streamloop"), "Startup Media contains no reference to streamloop at all any more");
}

// ---- 7. DOM: ids stay unique across the whole page -------------------------

console.log("\n7. DOM: no duplicate ids were introduced by the regrouping");
{
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  const seen = new Set();
  const duplicates = new Set();
  for (const id of ids) {
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  assertEqual(duplicates.size, 0, `no duplicate ids (found: ${[...duplicates].join(", ")})`);
}

// ---- 8. main.js wiring: runStartupMediaLoad() honors "off" -----------------

console.log('\n8. integration: runStartupMediaLoad() performs no load, no permission query, under "off"');
{
  const mainSource = fs.readFileSync(path.join(ROOT, "src/main.js"), "utf8");

  const start = mainSource.indexOf("async function runStartupMediaLoad()");
  assert(start !== -1, "runStartupMediaLoad() is defined");
  const end = mainSource.indexOf("\n}\n", start);
  const fnBody = mainSource.slice(start, end);

  const offCheckAt = fnBody.indexOf('startup.policy === "off"');
  assert(offCheckAt !== -1, 'runStartupMediaLoad() checks startup.policy === "off"');
  const fallbackCheckAt = fnBody.indexOf('startup.policy !== "random-remembered"');
  assert(offCheckAt !== -1 && fallbackCheckAt !== -1 && offCheckAt < fallbackCheckAt, '"off" is checked BEFORE the last-used fallback branch, so it is never absorbed by it');

  // Everything between the off-check and the fallback branch must be a bare
  // early return — no permission read, no restore call, no decision call.
  const offBranch = fnBody.slice(offCheckAt, fallbackCheckAt);
  assert(!offBranch.includes("attemptBootRestore"), '"off" never calls attemptBootRestore()');
  assert(!offBranch.includes("decideStartupMedia"), '"off" never calls decideStartupMedia()');
  assert(!offBranch.includes("readFolderPermissionForBootRestore"), '"off" never queries permission');
  assert(!offBranch.includes("requestPermission"), '"off" never requests permission');
  assert(!offBranch.includes("loadFromFsaHandle"), '"off" never loads a folder');
}

// ---- 9. main.js wiring: attemptStartupMedia() Auto Fill is symmetric ------

console.log("\n9. integration: attemptStartupMedia() considers Auto Fill for whichever context is active, not just streamloop");
{
  const mainSource = fs.readFileSync(path.join(ROOT, "src/main.js"), "utf8");

  const start = mainSource.indexOf("async function attemptStartupMedia()");
  const end = mainSource.indexOf("\n}\n", start);
  const fnBody = mainSource.slice(start, end);

  // The Auto Fill gate itself must run BEFORE any streamloop-only branch —
  // i.e. it must not be nested inside `if (launchContext !== LAUNCH_CONTEXT_STREAMLOOP) return;`.
  const guardAt = fnBody.indexOf("launchContext !== LAUNCH_CONTEXT_STREAMLOOP");
  const fillAt = fnBody.indexOf("enterFillPanelDeliberately(");
  assert(guardAt !== -1 && fillAt !== -1 && fillAt < guardAt, "Auto Fill Panel is considered BEFORE the streamloop-only early return — it applies to both contexts");

  assert(
    fnBody.includes("currentStartupPreferences?.[activeContext]?.autoFillPanel") ||
      fnBody.includes("currentStartupPreferences[activeContext]") ,
    "Auto Fill reads the ACTIVE context's own autoFillPanel value, not a hardcoded context"
  );
  assert(fnBody.includes("hasVisibleItems"), "Auto Fill is still gated on hasVisibleItems for either context");
}

// ---- 10. main.js wiring: disabled-checkbox semantics while policy is off --

console.log('\n10. integration: the Auto Fill checkbox is disabled (not unchecked) while policy is "off"');
{
  const mainSource = fs.readFileSync(path.join(ROOT, "src/main.js"), "utf8");

  const start = mainSource.indexOf("function updateStartupMediaAutoFillAvailability(context)");
  assert(start !== -1, "updateStartupMediaAutoFillAvailability() is defined");
  const end = mainSource.indexOf("\n}\n", start);
  const fnBody = mainSource.slice(start, end);

  assert(fnBody.includes('=== "off"'), 'availability is decided by comparing policy to "off"');
  assert(fnBody.includes(".autoFillInput.disabled ="), "the checkbox's disabled property is set, not its checked property");
  assert(!fnBody.includes(".autoFillInput.checked ="), "this function never writes .checked — a saved true/false value is never destroyed here");
  assert(fnBody.includes(".autoFillHelper.classList.toggle"), "the explanatory helper's visibility is toggled");

  // Called from the policy helper updater, so it re-evaluates on both boot
  // load and every subsequent policy change.
  const helperStart = mainSource.indexOf("function updateStartupMediaPolicyHelper(context)");
  const helperEnd = mainSource.indexOf("\n}\n", helperStart);
  const helperBody = mainSource.slice(helperStart, helperEnd);
  assert(helperBody.includes("updateStartupMediaAutoFillAvailability(context)"), "updateStartupMediaPolicyHelper() also refreshes Auto Fill availability");
}

console.log(`\n${"-".repeat(60)}`);
if (failures) {
  console.log(`FAIL  ${failures} assertion(s) failed, ${passes} passed.`);
  for (const detail of failureDetail) console.log(`  - ${detail}`);
  process.exit(1);
}
console.log(`ok    ${passes} assertion(s) passed - startup context parity holds.`);
