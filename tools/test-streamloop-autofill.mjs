#!/usr/bin/env node
// [STREAMLOOP-INTEGRATION / N6-7] [STREAMLOOP-INTEGRATION / N6-9]
// [WHY: StreamLoop's Auto Fill Panel preference now lives at
//  `startup.streamloop.autoFillPanel` (see app-preferences.js's
//  normalizeStartupSection()) rather than in the separate top-level
//  `streamloopIntegration` section N6-7/N6-8 originally used — N6-9's
//  Advanced Settings cleanup co-locates a context's ENTIRE startup+post-load
//  configuration in one disclosure, and the preference shape now mirrors
//  that. This file proves: the N6-7/N6-8 value migrates correctly into its
//  new home; the sequencing/ordering invariants proven in N6-7/N6-8 (Fill
//  Panel before pending intent, hasVisibleItems + streamLoopStartupSettled
//  readiness) still hold now that the surrounding preference/DOM shape
//  changed; and the DOM actually moved into StreamLoop Integration. Broader
//  cross-context parity (Normal BG's own Auto Fill, the new "off" startup
//  mode, and independence between the two contexts) is covered in
//  tools/test-startup-context-parity.mjs — this file stays focused on what
//  is genuinely StreamLoop-specific.]
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

function putRawRecord(record) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("loop-browser-gallery-preferences", 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("preferences")) db.createObjectStore("preferences", { keyPath: "id" });
    };
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction("preferences", "readwrite");
      tx.objectStore("preferences").put({ id: "global", schemaVersion: 1, ...record });
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
    request.onerror = () => reject(request.error);
  });
}

// ---- 1. preferences: startup.streamloop.autoFillPanel ---------------------

console.log("\n1. preferences: startup.streamloop.autoFillPanel defaults, round-trips, normalizes");
{
  installFakeIndexedDB();
  const Preferences = await import(src("storage/app-preferences.js"));

  let preferences = await Preferences.loadPreferences();
  assertEqual(preferences.startup.streamloop.autoFillPanel, false, "streamloop autoFillPanel defaults to false");

  await Preferences.saveStartupPreferences("streamloop", { autoFillPanel: true });
  preferences = await Preferences.loadPreferences();
  assertEqual(preferences.startup.streamloop.autoFillPanel, true, "saved streamloop autoFillPanel survives a reload");
  assertEqual(preferences.startup.browser.autoFillPanel, false, "browser autoFillPanel is untouched by a streamloop-only save");

  await Preferences.saveStartupPreferences("streamloop", { autoFillPanel: false });
  preferences = await Preferences.loadPreferences();
  assertEqual(preferences.startup.streamloop.autoFillPanel, false, "streamloop autoFillPanel can be turned back off");
}

// ---- 2. migration: the N6-7/N6-8 streamloopIntegration value moves in ------

console.log("\n2. migration: legacy streamloopIntegration.autoFillPanel migrates into startup.streamloop.autoFillPanel");
{
  installFakeIndexedDB();
  const Preferences = await import(src("storage/app-preferences.js"));

  await putRawRecord({
    startup: { browser: { policy: "last-used", eligibleLibraryIds: [] }, streamloop: { policy: "random-selected", eligibleLibraryIds: ["lib-a"] } },
    streamloopIntegration: { autoFillPanel: true },
  });

  let preferences = await Preferences.loadPreferences();
  assertEqual(preferences.startup.streamloop.autoFillPanel, true, "the legacy streamloopIntegration value migrates into startup.streamloop.autoFillPanel");
  assertEqual(preferences.startup.streamloop.policy, "random-selected", "streamloop's own policy is untouched by the migration");
  assertEqual(preferences.startup.streamloop.eligibleLibraryIds.join(","), "lib-a", "streamloop's own eligible set is untouched by the migration");
  assertEqual(preferences.startup.browser.autoFillPanel, false, "browser's autoFillPanel does NOT inherit the legacy StreamLoop value");
  assert(!("streamloopIntegration" in preferences), "the retired streamloopIntegration section is not present in the normalized record");

  // Once ANY write happens, the legacy section must be gone from storage —
  // same retirement pattern `fillPanel` under `playback` already established.
  await Preferences.saveStartupPreferences("browser", { policy: "last-used" });
  const rawAfterWrite = await new Promise((resolve, reject) => {
    const request = indexedDB.open("loop-browser-gallery-preferences", 1);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction("preferences", "readonly");
      const getRequest = tx.objectStore("preferences").get("global");
      getRequest.onsuccess = () => {
        db.close();
        resolve(getRequest.result);
      };
      getRequest.onerror = () => reject(getRequest.error);
    };
    request.onerror = () => reject(request.error);
  });
  assert(!("streamloopIntegration" in rawAfterWrite), "streamloopIntegration disappears from the STORED record after any subsequent write");
  preferences = await Preferences.loadPreferences();
  assertEqual(preferences.startup.streamloop.autoFillPanel, true, "the migrated value survives after streamloopIntegration is gone");
}

console.log("\n3. migration: an already-migrated record is not re-migrated (new location always wins)");
{
  installFakeIndexedDB();
  const Preferences = await import(src("storage/app-preferences.js"));

  await putRawRecord({
    startup: {
      browser: { policy: "last-used", eligibleLibraryIds: [] },
      streamloop: { policy: "last-used", eligibleLibraryIds: [], autoFillPanel: false },
    },
    streamloopIntegration: { autoFillPanel: true },
  });

  const preferences = await Preferences.loadPreferences();
  assertEqual(
    preferences.startup.streamloop.autoFillPanel,
    false,
    "startup.streamloop's OWN autoFillPanel (false) wins over a stale legacy streamloopIntegration value (true)"
  );
}

// ---- 4. DOM: StreamLoop Integration owns ALL StreamLoop-specific controls -

console.log("\n4. DOM: StreamLoop Integration disclosure contains its full startup+auto-fill configuration");
{
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");

  const at = html.indexOf('class="advanced-streamloop-integration-section"');
  assert(at !== -1, "the StreamLoop Integration disclosure is present");
  const sectionEnd = html.indexOf("</details>", at);
  const section = html.slice(at, sectionEnd);

  assert(section.includes('id="startup-media-streamloop-policy-select"'), "the streamloop startup policy select lives inside StreamLoop Integration");
  assert(section.includes('id="startup-media-streamloop-eligible-list"'), "the streamloop eligible-folder list lives inside StreamLoop Integration");
  assert(section.includes('id="streamloop-auto-fill-panel-input"'), "the streamloop Auto Fill checkbox lives inside StreamLoop Integration");
  assert(section.includes('id="streamloop-auto-fill-helper"'), "the streamloop Auto Fill disabled-state helper lives inside StreamLoop Integration");

  // And it must NOT still live inside Startup Media.
  const startupMediaAt = html.indexOf('class="advanced-startup-media-section"');
  const startupMediaEnd = html.indexOf("</details>", startupMediaAt);
  const startupMediaSection = html.slice(startupMediaAt, startupMediaEnd);
  assert(!startupMediaSection.includes("startup-media-streamloop"), "no streamloop startup control remains inside Startup Media");
  assert(!startupMediaSection.includes("streamloop-auto-fill"), "no streamloop Auto Fill control remains inside Startup Media");
}

// ---- 5. main.js wiring: sequencing still holds for the streamloop context -

console.log("\n5. integration: attemptStartupMedia() still honors StreamLoop-specific sequencing");
{
  const mainSource = fs.readFileSync(path.join(ROOT, "src/main.js"), "utf8");

  const start = mainSource.indexOf("async function attemptStartupMedia()");
  const end = mainSource.indexOf("\n}\n", start);
  const fnBody = mainSource.slice(start, end);

  assert(fnBody.includes("await runStartupMediaLoad();"), "attemptStartupMedia() still awaits the full load path first");
  assert(fnBody.includes("streamLoopStartupSettled = true;"), "attemptStartupMedia() still marks streamLoopStartupSettled for a streamloop launch");
  assert(fnBody.includes("tryBecomeStreamLoopReady();"), "attemptStartupMedia() still applies pending StreamLoop intent");

  const fillAt = fnBody.indexOf("enterFillPanelDeliberately(");
  const settledAssignAt = fnBody.indexOf("streamLoopStartupSettled = true;");
  const readyAt = fnBody.indexOf("tryBecomeStreamLoopReady(");
  assert(fillAt !== -1 && settledAssignAt !== -1 && readyAt !== -1, "all three sequencing landmarks are present");
  assert(fillAt < settledAssignAt && settledAssignAt < readyAt, "execution order is: Auto Fill Panel -> mark settled -> apply pending intent");

  assert(!fnBody.includes("enterFillMode("), "attemptStartupMedia() never calls enterFillMode() directly");
  assert(!fnBody.includes("requestPermission"), "attemptStartupMedia() never calls requestPermission()");
}

console.log(`\n${"-".repeat(60)}`);
if (failures) {
  console.log(`FAIL  ${failures} assertion(s) failed, ${passes} passed.`);
  for (const detail of failureDetail) console.log(`  - ${detail}`);
  process.exit(1);
}
console.log(`ok    ${passes} assertion(s) passed - StreamLoop Integration Auto Fill Panel holds.`);
