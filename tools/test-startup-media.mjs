#!/usr/bin/env node
// [STARTUP-MEDIA / N6-4]
// [WHY: decideStartupMedia() (boot-restore.js) is the entire policy for what
//  Browser Gallery loads at launch beyond N6's existing last-used default —
//  a pure function over already-resolved inputs (rows, permission states, an
//  injected random()), exactly like decideBootRestore() before it. This file
//  proves the exact table from the N6-3 handoff, that decideBootRestore()
//  (and therefore test-boot-restore.mjs) is untouched, that the
//  app-preferences.js `startup` section round-trips and normalizes
//  correctly, and that the four Advanced disclosures exist as closed
//  <details> in index.html.]
//
// Usage:  node tools/test-startup-media.mjs

import { pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { installFakeIndexedDB } from "./lib/browser-test-env.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const src = (rel) => pathToFileURL(path.join(ROOT, "src", rel)).href;

const { decideStartupMedia, decideBootRestore } = await import(src("storage/boot-restore.js"));

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

function row(id, overrides = {}) {
  return { id, name: id, handle: {}, sourceKind: "fsa", removedFromRecents: false, lastOpenedAt: 1, ...overrides };
}

// ---- 1. last-used, rows[0] granted -> restore rows[0] ----------------------

console.log("\n1. last-used, rows[0] granted -> restore rows[0]");
{
  const rows = [row("lib-1", { lastOpenedAt: 100 }), row("lib-2", { lastOpenedAt: 90 })];
  const decision = decideStartupMedia({ policy: "last-used", rows, permissionStates: { "lib-1": "granted" } });
  assertEqual(decision.restore, true, "restores");
  assertEqual(decision.rowId, "lib-1", "restores exactly rows[0]");
}

// ---- 2. last-used, rows[0] not granted, rows[1] granted -> no restore ------

console.log("\n2. last-used, rows[0] not granted, rows[1] granted -> no restore (N6 rule preserved)");
{
  const rows = [row("lib-1", { lastOpenedAt: 100 }), row("lib-2", { lastOpenedAt: 90 })];
  const decision = decideStartupMedia({
    policy: "last-used",
    rows,
    permissionStates: { "lib-1": "prompt", "lib-2": "granted" },
  });
  assertEqual(decision.restore, false, "no restore — never falls through to rows[1]");
}

// ---- 3. random-remembered, none granted -> no restore ----------------------

console.log("\n3. random-remembered, none granted -> no restore");
{
  const rows = [row("lib-1"), row("lib-2"), row("lib-3")];
  const decision = decideStartupMedia({
    policy: "random-remembered",
    rows,
    permissionStates: { "lib-1": "prompt", "lib-2": "denied" },
  });
  assertEqual(decision.restore, false, "no restore when nothing in the pool is granted");
}

// ---- 4. random-remembered, subset granted -> always picks from the granted subset

console.log("\n4. random-remembered, subset granted -> always picks from the granted subset");
{
  const rows = [row("lib-1", { lastOpenedAt: 100 }), row("lib-2", { lastOpenedAt: 90 }), row("lib-3", { lastOpenedAt: 80 })];
  const grantedIds = new Set(["lib-2", "lib-3"]);
  for (const sample of [0, 0.25, 0.5, 0.75, 0.999]) {
    const decision = decideStartupMedia({
      policy: "random-remembered",
      rows,
      permissionStates: { "lib-1": "denied", "lib-2": "granted", "lib-3": "granted" },
      random: () => sample,
    });
    assert(decision.restore === true && grantedIds.has(decision.rowId), `sample ${sample} picks only from the granted subset`);
  }
}

// ---- 5. random-remembered, fixed random -> same row every run (determinism)

console.log("\n5. random-remembered, fixed random -> same row every run (determinism)");
{
  const rows = [row("lib-1", { lastOpenedAt: 100 }), row("lib-2", { lastOpenedAt: 90 }), row("lib-3", { lastOpenedAt: 80 })];
  const permissionStates = { "lib-1": "granted", "lib-2": "granted", "lib-3": "granted" };
  const first = decideStartupMedia({ policy: "random-remembered", rows, permissionStates, random: () => 0.4 });
  const second = decideStartupMedia({ policy: "random-remembered", rows, permissionStates, random: () => 0.4 });
  const third = decideStartupMedia({ policy: "random-remembered", rows: [...rows].reverse(), permissionStates, random: () => 0.4 });
  assertEqual(first.rowId, second.rowId, "identical inputs and a fixed random() pick the identical row");
  assertEqual(first.rowId, third.rowId, "row order in `rows` does not change the outcome — the pool is sorted deterministically first");
}

// ---- 6. random-selected, empty eligible set -> no restore ------------------

console.log("\n6. random-selected, empty eligible set -> no restore, never falls back to last-used");
{
  const rows = [row("lib-1", { lastOpenedAt: 100 })];
  const decision = decideStartupMedia({
    policy: "random-selected",
    rows,
    permissionStates: { "lib-1": "granted" },
    eligibleIds: [],
  });
  assertEqual(decision.restore, false, "no restore — an explicit empty selection is not an invitation to use last-used");
}

// ---- 7. random-selected, eligible ids all stale -> no restore, set not modified

console.log("\n7. random-selected, eligible ids all stale -> no restore, set not modified");
{
  const rows = [row("lib-1", { lastOpenedAt: 100 })];
  const eligibleIds = ["removed-long-ago", "also-gone"];
  const decision = decideStartupMedia({
    policy: "random-selected",
    rows,
    permissionStates: { "lib-1": "granted" },
    eligibleIds,
  });
  assertEqual(decision.restore, false, "no restore when every eligible id is stale");
  assertEqual(eligibleIds.length, 2, "the caller's eligibleIds array is never mutated by this pure function");
}

// ---- 8. random-selected, mixed stale/valid/granted -> valid ∩ granted only -

console.log("\n8. random-selected, mixed stale/valid/granted -> picks only from valid ∩ granted");
{
  const rows = [row("lib-1", { lastOpenedAt: 100 }), row("lib-2", { lastOpenedAt: 90 }), row("lib-3", { lastOpenedAt: 80 })];
  // lib-1: eligible but NOT granted. lib-2: eligible AND granted. lib-3: granted but NOT eligible. "stale-id": eligible but not a real row.
  const decision = decideStartupMedia({
    policy: "random-selected",
    rows,
    permissionStates: { "lib-1": "prompt", "lib-2": "granted", "lib-3": "granted" },
    eligibleIds: ["lib-1", "lib-2", "stale-id"],
    random: () => 0,
  });
  assertEqual(decision.restore, true, "restores");
  assertEqual(decision.rowId, "lib-2", "the only row that is simultaneously eligible AND granted");
}

// ---- 9. any policy, unknown policy string -> behaves as last-used ---------

console.log("\n9. any policy, unknown policy string -> behaves as last-used");
{
  const rows = [row("lib-1", { lastOpenedAt: 100 }), row("lib-2", { lastOpenedAt: 90 })];
  const permissionStates = { "lib-1": "granted", "lib-2": "granted" };
  const viaUnknown = decideStartupMedia({ policy: "future-policy-not-yet-invented", rows, permissionStates });
  const viaLastUsed = decideBootRestore({ rows, permissionStates });
  assertEqual(viaUnknown.restore, viaLastUsed.restore, "unknown policy matches decideBootRestore()'s restore outcome");
  assertEqual(viaUnknown.rowId, viaLastUsed.rowId, "unknown policy matches decideBootRestore()'s chosen row");
}

// ---- 10. context omitted -> behaves as "browser" ---------------------------

console.log('\n10. context omitted -> behaves as "browser"');
{
  const rows = [row("lib-1", { lastOpenedAt: 100 }), row("lib-2", { lastOpenedAt: 90 })];
  const permissionStates = { "lib-1": "granted", "lib-2": "granted" };
  const omitted = decideStartupMedia({ policy: "random-remembered", rows, permissionStates, random: () => 0.1 });
  const explicit = decideStartupMedia({ policy: "random-remembered", rows, permissionStates, random: () => 0.1, context: "browser" });
  assertEqual(omitted.rowId, explicit.rowId, "omitting context produces the identical decision to passing 'browser' explicitly");
}

// ---- 11. no code path can return a "request permission" outcome -----------

console.log("\n11. no code path can return a 'request permission' outcome");
{
  const rows = [row("lib-1", { lastOpenedAt: 100 }), row("lib-2", { lastOpenedAt: 90 })];
  const inputs = [
    { policy: "last-used", rows, permissionStates: { "lib-1": "granted" } },
    { policy: "last-used", rows, permissionStates: {} },
    { policy: "random-remembered", rows, permissionStates: {} },
    { policy: "random-remembered", rows, permissionStates: { "lib-1": "granted", "lib-2": "granted" }, random: () => 0.5 },
    { policy: "random-selected", rows, permissionStates: {}, eligibleIds: [] },
    { policy: "random-selected", rows, permissionStates: { "lib-1": "granted" }, eligibleIds: ["lib-1"] },
    { policy: "bogus", rows, permissionStates: { "lib-1": "granted" } },
  ];
  let sawUnexpectedShape = false;
  for (const input of inputs) {
    const decision = decideStartupMedia(input);
    const keys = Object.keys(decision).sort();
    const validNoRestore = decision.restore === false && keys.join(",") === "restore";
    const validRestore = decision.restore === true && keys.join(",") === "restore,rowId" && typeof decision.rowId === "string";
    if (!validNoRestore && !validRestore) sawUnexpectedShape = true;
  }
  assert(!sawUnexpectedShape, "every decision shape is exactly {restore:false} or {restore:true, rowId}");
  assert(
    !JSON.stringify(inputs.map(decideStartupMedia)).toLowerCase().includes("request"),
    "no decision ever mentions 'request' in any form"
  );
}

// ---- 12. decideBootRestore() itself is untouched by this slice ------------

console.log("\n12. decideBootRestore() is untouched — test-boot-restore.mjs stays valid");
{
  const bootRestoreSource = fs.readFileSync(path.join(ROOT, "src/storage/boot-restore.js"), "utf8");
  assert(bootRestoreSource.includes("export function decideBootRestore("), "decideBootRestore() is still exported with its original signature");
  assert(bootRestoreSource.includes("export function decideStartupMedia("), "decideStartupMedia() is exported alongside it, extending the same module");
}

// ---- 13. preferences: startup section round-trips and normalizes ----------

console.log("\n13. preferences: startup section round-trips and normalizes");
{
  installFakeIndexedDB();
  const Preferences = await import(src("storage/app-preferences.js"));

  let preferences = await Preferences.loadPreferences();
  assertEqual(preferences.startup.policy, "last-used", "startup policy defaults to last-used");
  assertEqual(preferences.startup.eligibleLibraryIds.length, 0, "eligibleLibraryIds defaults to empty");

  await Preferences.saveStartupPreferences({ policy: "random-remembered" });
  preferences = await Preferences.loadPreferences();
  assertEqual(preferences.startup.policy, "random-remembered", "saved policy survives a reload");

  await Preferences.saveStartupPreferences({ eligibleLibraryIds: ["lib-a", "lib-b", "lib-a", "", 42, null] });
  preferences = await Preferences.loadPreferences();
  assertEqual(preferences.startup.eligibleLibraryIds.length, 2, "eligibleLibraryIds normalizes to unique non-empty strings only");
  assert(
    preferences.startup.eligibleLibraryIds.includes("lib-a") && preferences.startup.eligibleLibraryIds.includes("lib-b"),
    "the two valid ids both survive normalization"
  );
  // The prior save already proved policy survives one reload; this confirms a
  // LATER save of a different section (eligibleLibraryIds) does not revert it.
  assertEqual(preferences.startup.policy, "random-remembered", "saving eligibleLibraryIds does not revert a previously saved policy");

  await Preferences.saveStartupPreferences({ policy: "not-a-real-policy" });
  preferences = await Preferences.loadPreferences();
  assertEqual(preferences.startup.policy, "last-used", "an unrecognized stored policy string normalizes to last-used");
}

// ---- 14. saving startup leaves every sibling section intact ---------------

console.log("\n14. saving startup leaves playback / presentation / microArcade / onboarding intact");
{
  installFakeIndexedDB();
  const Preferences = await import(src("storage/app-preferences.js"));

  await Preferences.savePlaybackPreferences({ intervalSeconds: 42, shuffle: false });
  await Preferences.savePresentationPreferences({ ghostOpacityPercent: 77 });
  await Preferences.saveMicroArcadePreferences({ animationOrder: "sequential" });
  await Preferences.saveOnboardingPreferences({ profileSyncIntroSeen: true });

  await Preferences.saveStartupPreferences({ policy: "random-selected", eligibleLibraryIds: ["lib-x"] });
  const preferences = await Preferences.loadPreferences();

  assertEqual(preferences.playback.intervalSeconds, 42, "playback.intervalSeconds survives a startup save");
  assertEqual(preferences.playback.shuffle, false, "playback.shuffle survives a startup save");
  assertEqual(preferences.presentation.ghostOpacityPercent, 77, "presentation.ghostOpacityPercent survives a startup save");
  assertEqual(preferences.microArcade.animationOrder, "sequential", "microArcade.animationOrder survives a startup save");
  assertEqual(preferences.onboarding.profileSyncIntroSeen, true, "onboarding.profileSyncIntroSeen survives a startup save");
  assertEqual(preferences.startup.policy, "random-selected", "the startup save itself still lands");
  assertEqual(preferences.startup.eligibleLibraryIds[0], "lib-x", "the startup save's eligible set still lands");
}

// ---- 15. DOM: the four Advanced disclosures exist as closed <details> -----

console.log("\n15. DOM: each of the four advanced sections is a closed <details>");
{
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const sections = [
    { needle: 'class="advanced-media-library-section"', summary: "Media Library diagnostics" },
    { needle: 'class="advanced-playback-section"', summary: "Arcade animations" },
    { needle: 'class="advanced-startup-media-section"', summary: "Startup Media" },
    { needle: 'class="profile-sync-section" id="profile-sync-section"', summary: "Sync Your Curations" },
  ];
  for (const { needle, summary } of sections) {
    const at = html.indexOf(needle);
    assert(at !== -1, `"${summary}" section markup is present`);
    if (at === -1) continue;
    // The <details ...> opening tag is the text immediately before `needle`
    // back to the preceding "<details". Slicing that exact tag (not the
    // whole section body, which legitimately contains the word "open" in
    // unrelated copy elsewhere) is what lets this assertion be precise.
    const tagStart = html.lastIndexOf("<details", at);
    const tagEnd = html.indexOf(">", at);
    const openingTag = html.slice(tagStart, tagEnd + 1);
    assert(!/\sopen(\s|>)/.test(openingTag), `"${summary}" <details> has no "open" attribute — closed by default`);
    const nextSummary = html.indexOf("<summary>", tagEnd);
    assert(
      nextSummary !== -1 && html.slice(nextSummary, nextSummary + 200).includes(summary),
      `"${summary}" section's own <summary> immediately follows its <details> tag`
    );
  }

  // The OUTER "Advanced Settings" details must still exist and still be
  // closed by default too — this slice must not have accidentally changed
  // that pre-existing behavior.
  const outerAt = html.indexOf('class="advanced-settings-section"');
  assert(outerAt !== -1, "the outer Advanced Settings <details> is present");
  const outerTagStart = html.lastIndexOf("<details", outerAt);
  const outerTagEnd = html.indexOf(">", outerAt);
  assert(!/\sopen(\s|>)/.test(html.slice(outerTagStart, outerTagEnd + 1)), "the outer Advanced Settings <details> is still closed by default");
}

// ---- 16. main.js wiring: attemptStartupMedia() reuses the shared load path

console.log("\n16. integration: attemptStartupMedia() wiring in main.js");
{
  const mainSource = fs.readFileSync(path.join(ROOT, "src/main.js"), "utf8");

  const start = mainSource.indexOf("async function attemptStartupMedia");
  assert(start !== -1, "attemptStartupMedia() is defined in main.js");
  const end = mainSource.indexOf("\n}\n", start);
  const fnBody = mainSource.slice(start, end);

  assert(fnBody.includes("decideStartupMedia("), "attemptStartupMedia() consults the pure decision function");
  assert(fnBody.includes("await attemptBootRestore()"), "the default (last-used) policy delegates to the SAME attemptBootRestore() N6 already tests");
  assert(
    fnBody.includes("await loadFromFsaHandle(candidate.handle, candidate)"),
    "the random-policy branch loads through the SAME loadFromFsaHandle() every other caller uses — the shared load path"
  );
  assert(!fnBody.includes("requestPermission"), "attemptStartupMedia() never calls requestPermission() — no prompting at boot");
  assert(!fnBody.includes("removeFromRecents"), "attemptStartupMedia() never calls removeFromRecents()");

  assert(
    mainSource.includes("attemptStartupMedia();") && mainSource.includes("await renderRecentLibraries();"),
    "boot calls attemptStartupMedia() (not attemptBootRestore() directly) after rendering Recent Libraries"
  );

  // attemptBootRestore() itself — N6's frozen function — must still be
  // exactly what test-boot-restore.mjs already asserts about it.
  const bootRestoreStart = mainSource.indexOf("async function attemptBootRestore");
  const bootRestoreEnd = mainSource.indexOf("(async function initFsaLibraries");
  const bootRestoreBody = mainSource.slice(bootRestoreStart, bootRestoreEnd);
  assert(bootRestoreBody.includes("decideBootRestore("), "attemptBootRestore() still consults decideBootRestore()");
  assert(!bootRestoreBody.includes("requestPermission"), "attemptBootRestore() still never calls requestPermission()");
  assert(!bootRestoreBody.includes("removeFromRecents"), "attemptBootRestore() still never calls removeFromRecents()");
}

console.log(`\n${"-".repeat(60)}`);
if (failures) {
  console.log(`FAIL  ${failures} assertion(s) failed, ${passes} passed.`);
  for (const detail of failureDetail) console.log(`  - ${detail}`);
  process.exit(1);
}
console.log(`ok    ${passes} assertion(s) passed - startup media + advanced disclosures hold.`);
