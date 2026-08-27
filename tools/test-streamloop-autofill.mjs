#!/usr/bin/env node
// [STREAMLOOP-INTEGRATION / N6-7]
// [WHY: Auto Fill Panel's entire correctness rests on ORDERING — Fill Panel
//  must enter before any pending StreamLoop PLAY/PAUSE intent is applied,
//  and the "safe to enter Fill Panel" moment must be the STRONG completion
//  seam (attemptStartupMedia() -> runStartupMediaLoad() resolving), not the
//  weaker state.hasVisibleItems proxy N6-6 originally used alone. This file
//  proves: the preference round-trips and normalizes; the new "StreamLoop
//  Integration" disclosure exists in the right place; and the sequencing/
//  gating properties from the N6-7 handoff hold in main.js's actual source.
//  See tools/test-streamloop-bridge.mjs for the readiness-gate correction
//  itself (streamLoopStartupSettled) and tools/test-startup-media.mjs §16
//  for runStartupMediaLoad()'s own wiring.]
//
// Usage:  node tools/test-streamloop-autofill.mjs

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

// ---- 1. preferences: streamloopIntegration.autoFillPanel ------------------

console.log("\n1. preferences: streamloopIntegration.autoFillPanel defaults, round-trips, normalizes");
{
  installFakeIndexedDB();
  const Preferences = await import(src("storage/app-preferences.js"));

  let preferences = await Preferences.loadPreferences();
  assertEqual(preferences.streamloopIntegration.autoFillPanel, false, "autoFillPanel defaults to false");

  await Preferences.saveStreamloopIntegrationPreferences({ autoFillPanel: true });
  preferences = await Preferences.loadPreferences();
  assertEqual(preferences.streamloopIntegration.autoFillPanel, true, "saved autoFillPanel survives a reload");

  await Preferences.saveStreamloopIntegrationPreferences({ autoFillPanel: false });
  preferences = await Preferences.loadPreferences();
  assertEqual(preferences.streamloopIntegration.autoFillPanel, false, "autoFillPanel can be turned back off");
}

console.log("\n2. preferences: a non-boolean stored value normalizes to the default");
{
  installFakeIndexedDB();
  const Preferences = await import(src("storage/app-preferences.js"));

  await new Promise((resolve, reject) => {
    const request = indexedDB.open("loop-browser-gallery-preferences", 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("preferences")) db.createObjectStore("preferences", { keyPath: "id" });
    };
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction("preferences", "readwrite");
      tx.objectStore("preferences").put({ id: "global", schemaVersion: 1, streamloopIntegration: { autoFillPanel: "yes" } });
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
    request.onerror = () => reject(request.error);
  });

  const preferences = await Preferences.loadPreferences();
  assertEqual(preferences.streamloopIntegration.autoFillPanel, false, 'a non-boolean stored value ("yes") normalizes to the false default');
}

console.log("\n3. preferences: no migration needed — a record predating this key defaults cleanly");
{
  installFakeIndexedDB();
  const Preferences = await import(src("storage/app-preferences.js"));

  await new Promise((resolve, reject) => {
    const request = indexedDB.open("loop-browser-gallery-preferences", 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("preferences")) db.createObjectStore("preferences", { keyPath: "id" });
    };
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction("preferences", "readwrite");
      // No streamloopIntegration key at all — simulates a record saved before N6-7 existed.
      tx.objectStore("preferences").put({ id: "global", schemaVersion: 1, playback: { intervalSeconds: 9 } });
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
    request.onerror = () => reject(request.error);
  });

  const preferences = await Preferences.loadPreferences();
  assertEqual(preferences.streamloopIntegration.autoFillPanel, false, "a pre-N6-7 record defaults autoFillPanel to false, no migration needed");
  assertEqual(preferences.playback.intervalSeconds, 9, "the pre-existing playback field is untouched by adding this new section");
}

console.log("\n4. saving streamloopIntegration leaves every sibling section intact");
{
  installFakeIndexedDB();
  const Preferences = await import(src("storage/app-preferences.js"));

  await Preferences.savePlaybackPreferences({ intervalSeconds: 42 });
  await Preferences.saveStartupPreferences("browser", { policy: "random-remembered" });
  await Preferences.saveStartupPreferences("streamloop", { policy: "random-selected", eligibleLibraryIds: ["lib-x"] });

  await Preferences.saveStreamloopIntegrationPreferences({ autoFillPanel: true });
  const preferences = await Preferences.loadPreferences();

  assertEqual(preferences.playback.intervalSeconds, 42, "playback survives a streamloopIntegration save");
  assertEqual(preferences.startup.browser.policy, "random-remembered", "startup.browser survives a streamloopIntegration save");
  assertEqual(preferences.startup.streamloop.policy, "random-selected", "startup.streamloop.policy survives a streamloopIntegration save");
  assertEqual(preferences.startup.streamloop.eligibleLibraryIds.join(","), "lib-x", "startup.streamloop.eligibleLibraryIds survives a streamloopIntegration save");
  assertEqual(preferences.streamloopIntegration.autoFillPanel, true, "the streamloopIntegration save itself still lands");
}

// ---- 5. DOM: the new disclosure, placed correctly --------------------------

console.log("\n5. DOM: StreamLoop Integration disclosure exists, closed, correctly placed");
{
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");

  const needle = 'class="advanced-streamloop-integration-section"';
  const at = html.indexOf(needle);
  assert(at !== -1, '"StreamLoop Integration" section markup is present');

  if (at !== -1) {
    const tagStart = html.lastIndexOf("<details", at);
    const tagEnd = html.indexOf(">", at);
    const openingTag = html.slice(tagStart, tagEnd + 1);
    assert(!/\sopen(\s|>)/.test(openingTag), '"StreamLoop Integration" <details> has no "open" attribute — closed by default');

    const nextSummary = html.indexOf("<summary>", tagEnd);
    assert(
      nextSummary !== -1 && html.slice(nextSummary, nextSummary + 100).includes("StreamLoop Integration"),
      '"StreamLoop Integration" section\'s own <summary> immediately follows its <details> tag'
    );
  }

  assert(html.includes('id="streamloop-auto-fill-panel-input"'), "the Auto Fill Panel checkbox is present");
  assert(html.includes(">Auto Fill Panel after media loads<"), "the checkbox has the expected customer-facing label");

  const startupAt = html.indexOf('class="advanced-startup-media-section"');
  const syncAt = html.indexOf('class="profile-sync-section" id="profile-sync-section"');
  assert(
    startupAt !== -1 && at !== -1 && syncAt !== -1 && startupAt < at && at < syncAt,
    "StreamLoop Integration sits after Startup Media and before Sync Your Curations, in document order"
  );

  // No StreamLoop-specific playback overrides were added — Part 1 of the handoff.
  const streamloopSectionEnd = html.indexOf("</details>", at);
  const streamloopSectionBody = html.slice(at, streamloopSectionEnd);
  for (const forbidden of ["shuffle", "interval", "loop-playlist", "Shuffle", "Interval", "Loop Playlist"]) {
    assert(!streamloopSectionBody.includes(forbidden), `no StreamLoop-specific "${forbidden}" playback override was added`);
  }
}

// ---- 6. main.js wiring: preference plumbing --------------------------------

console.log("\n6. integration: streamloopIntegration preference wiring in main.js");
{
  const mainSource = fs.readFileSync(path.join(ROOT, "src/main.js"), "utf8");

  assert(
    mainSource.includes('import {') && mainSource.includes("saveStreamloopIntegrationPreferences"),
    "main.js imports saveStreamloopIntegrationPreferences"
  );
  assert(
    mainSource.includes('document.getElementById("streamloop-auto-fill-panel-input")'),
    "main.js captures the Auto Fill Panel checkbox"
  );
  assert(
    mainSource.includes("currentStreamloopIntegrationPreferences = streamloopIntegration;") ||
      mainSource.includes("currentStreamloopIntegrationPreferences = preferences.streamloopIntegration;"),
    "applyLoadedPreferences() seeds currentStreamloopIntegrationPreferences before boot proceeds"
  );
  assert(
    mainSource.includes("streamloopAutoFillPanelInput.checked = streamloopIntegration.autoFillPanel;"),
    "applyLoadedPreferences() seeds the checkbox's checked state"
  );

  const listenerStart = mainSource.indexOf("streamloopAutoFillPanelInput.addEventListener(\"change\"");
  assert(listenerStart !== -1, "a change listener is registered on the Auto Fill Panel checkbox");
  const listenerEnd = mainSource.indexOf("\n});\n", listenerStart);
  const listenerBody = mainSource.slice(listenerStart, listenerEnd);
  assert(
    listenerBody.includes("saveStreamloopIntegrationPreferences("),
    "the checkbox's change listener saves through saveStreamloopIntegrationPreferences()"
  );
  assert(
    !listenerBody.includes("enterFillMode(") && !listenerBody.includes("enterFillPanelDeliberately("),
    "ticking the checkbox never itself enters Fill Panel — it is a pure preference, read only at the boot-settle decision"
  );
}

// ---- 7. main.js wiring: attemptStartupMedia() settle-sequencing -----------

console.log("\n7. integration: attemptStartupMedia() settle-sequencing in main.js");
{
  const mainSource = fs.readFileSync(path.join(ROOT, "src/main.js"), "utf8");

  const start = mainSource.indexOf("async function attemptStartupMedia()");
  assert(start !== -1, "attemptStartupMedia() is defined in main.js");
  const end = mainSource.indexOf("\n}\n", start);
  const fnBody = mainSource.slice(start, end);

  assert(fnBody.includes("await runStartupMediaLoad();"), "attemptStartupMedia() awaits the full load path before deciding anything else");

  assert(
    fnBody.includes("launchContext !== LAUNCH_CONTEXT_STREAMLOOP") || fnBody.includes("launchContext === LAUNCH_CONTEXT_STREAMLOOP"),
    "attemptStartupMedia() gates its post-load behavior on the live launchContext"
  );
  assert(fnBody.includes("streamLoopStartupSettled = true;"), "attemptStartupMedia() marks streamLoopStartupSettled AFTER the load has resolved");

  // Ordering: the settled flag is set, Auto Fill Panel is considered, and
  // ONLY THEN is the pending intent applied. Prove textual order as a proxy
  // for execution order (this is straight-line synchronous code with no
  // branches between these three statements once inside the StreamLoop
  // branch, so textual order IS execution order here).
  const settledAt = fnBody.indexOf("streamLoopStartupSettled = true;");
  const fillAt = fnBody.indexOf("enterFillPanelDeliberately(");
  const readyAt = fnBody.indexOf("tryBecomeStreamLoopReady(");
  assert(settledAt !== -1 && fillAt !== -1 && readyAt !== -1, "all three settle-sequence steps are present");
  assert(settledAt < fillAt && fillAt < readyAt, "execution order is: mark settled -> consider Auto Fill Panel -> apply pending intent");

  // Gating: Auto Fill Panel only fires when there is visible media AND the
  // preference is on.
  const fillLineStart = fnBody.lastIndexOf("if (", fillAt);
  const fillLineEnd = fnBody.indexOf(")", fillAt);
  const fillGateCondition = fnBody.slice(fillLineStart, fillLineEnd);
  assert(fillGateCondition.includes("hasVisibleItems"), "Auto Fill Panel is gated on runtime.getState().hasVisibleItems");
  assert(
    fillGateCondition.includes("currentStreamloopIntegrationPreferences.autoFillPanel"),
    "Auto Fill Panel is gated on the autoFillPanel preference"
  );

  assert(!fnBody.includes("enterFillMode("), "attemptStartupMedia() never calls enterFillMode() directly — only the shared enterFillPanelDeliberately() entry point");
  assert(!fnBody.includes("requestPermission"), "attemptStartupMedia() never calls requestPermission()");

  // Boot-scoped only: attemptStartupMedia() must be CALLED exactly once, from
  // initFsaLibraries() — never wired to any later/manual load path. Counts
  // the exact call syntax `attemptStartupMedia();` (parens then semicolon,
  // no arguments) rather than every textual mention of the name, since the
  // identifier also appears in prose comments/breadcrumbs throughout the file.
  const callSites = mainSource.split("attemptStartupMedia();").length - 1;
  assertEqual(callSites, 1, "attemptStartupMedia() is called exactly once in main.js (inside initFsaLibraries())");
}

console.log(`\n${"-".repeat(60)}`);
if (failures) {
  console.log(`FAIL  ${failures} assertion(s) failed, ${passes} passed.`);
  for (const detail of failureDetail) console.log(`  - ${detail}`);
  process.exit(1);
}
console.log(`ok    ${passes} assertion(s) passed - StreamLoop Integration Auto Fill Panel holds.`);
