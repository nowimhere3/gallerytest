#!/usr/bin/env node
// [PHASE-6-SYNC-V2]
// [STAGE-E-HUMAN-DEVICE-LABEL]
// [WHY: real-device debugging must show a human-readable device name before the
//  raw UUID without allowing presentation metadata to affect sync identity. A
//  label is the kind of field that quietly acquires meaning — someone keys a
//  Map on it, or compares it to decide staleness — and by then the system has a
//  second, mutable, colliding identity nobody declared. These tests exist to
//  make that impossible to do accidentally: the label must stay additive,
//  optional, and completely absent from anything merge or publish looks at.]
//
// Usage:  node tools/test-sync-v2-device-label.mjs

import { pathToFileURL } from "node:url";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { installFakeIndexedDB, createVirtualDirectory, settle } from "./lib/browser-test-env.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const src = (rel) => pathToFileURL(path.join(ROOT, "src", rel)).href;

const { setSnapshotFreezeEnabled } = await import(src("profile/profile-snapshot.js"));
setSnapshotFreezeEnabled(true);

const { ProfileStore } = await import(src("profile/profile-store.js"));
const { SyncIdentity, detectDeviceLabel } = await import(src("profile/sync-device.js"));
const { runSyncV2Pass } = await import(src("profile/sync-v2.js"));
const Transport = await import(src("profile/sync-v2-transport.js"));

// ---- Tiny test runner ------------------------------------------------------

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
    actual === expected ? null : `expected: ${String(expected)}\n        actual:   ${String(actual)}`
  );
}

async function test(name, fn) {
  console.log(`\n${name}`);
  try {
    await fn();
  } catch (error) {
    failures++;
    failureDetail.push(`${name} — threw: ${error && error.stack}`);
    console.log(`  FAIL  threw: ${error && error.message}`);
    console.log(String(error && error.stack).split("\n").slice(1, 4).join("\n"));
  }
}

async function makeStore() {
  installFakeIndexedDB();
  const identity = new SyncIdentity();
  await identity.ready;
  const store = new ProfileStore({ identity });
  await settle();
  await store.whenFactsSettled();
  return { identity, store };
}

const SUNRISE = "Nature/Sunrise.mp4";
const RAIN = "Nature/Rain.mp4";

function deviceManifest(dir, deviceId) {
  const raw = dir.readFile(`sync-v2/devices/${deviceId}/device.json`);
  return raw ? JSON.parse(raw) : null;
}

// =========================================================================
// 1. Detection, including the safe fallback
// =========================================================================

await test("1. detection is coarse, ordered correctly, and falls back safely", async () => {
  const cases = [
    ["Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 Chrome/120", "Chromebook"],
    ["Mozilla/5.0 (Linux; Android 13; Pixel 7) Chrome/120", "Android"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)", "iOS"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120", "Windows"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120", "macOS"],
    ["Mozilla/5.0 (X11; Linux x86_64) Chrome/120", "Linux"],
  ];
  for (const [ua, expected] of cases) assertEqual(detectDeviceLabel(ua), expected, `${expected} detected`);

  // Chrome OS and Android both say "Linux"; specific must beat generic or every
  // Chromebook reads as "Linux", which is the exact confusion this removes.
  assertEqual(detectDeviceLabel("CrOS x86_64; Linux"), "Chromebook", "CrOS beats the generic Linux match");
  assertEqual(detectDeviceLabel("Linux; Android 14"), "Android", "Android beats the generic Linux match");

  for (const bad of ["", null, undefined, 42, {}, "utterly unrecognised agent"]) {
    assertEqual(detectDeviceLabel(bad), "Unknown Device", `safe fallback for ${JSON.stringify(bad)}`);
  }
});

// =========================================================================
// 2. deviceId is unchanged; the label is a separate, non-persisted thing
// =========================================================================

await test("2. adding a label changes nothing about deviceId", async () => {
  const { identity, store } = await makeStore();

  const id = identity.deviceId;
  assert(/^dev-/.test(id), "deviceId still has its original generated shape");
  assertEqual(store.getDeviceId(), id, "ProfileStore reports the same deviceId");
  assert(typeof store.getDeviceLabel() === "string" && store.getDeviceLabel().length > 0, "a label is available");
  assert(store.getDeviceLabel() !== id, "…and it is not the deviceId");

  // The label is recomputed, never stored beside the identity — so it cannot
  // drift into looking like durable state, and cannot be mistaken for identity.
  const { loadDeviceRecord } = await import(src("storage/profile-sync-store.js"));
  const record = await loadDeviceRecord();
  assertEqual(record.deviceId, id, "the persisted device record still holds the deviceId");
  assertEqual(record.label, undefined, "…and stores no label at all");

  // A reload keeps the SAME device, whatever the label says.
  const identity2 = new SyncIdentity();
  await identity2.ready;
  assertEqual(identity2.deviceId, id, "a reload is still the same device");
});

// =========================================================================
// 3. The label reaches device.json, additively
// =========================================================================

await test("3. the label is written to device.json and read back, without disturbing anything else", async () => {
  const dir = createVirtualDirectory();
  const { identity, store } = await makeStore();
  await store.setFavorite(SUNRISE, true);
  await store.whenFactsSettled();
  await settle();

  await runSyncV2Pass({ profileStore: store, dirHandle: dir.handle });

  const manifest = deviceManifest(dir, identity.deviceId);
  assert(Boolean(manifest), "device.json was written");
  assertEqual(manifest.label, store.getDeviceLabel(), "it carries this device's label");
  assertEqual(manifest.deviceId, identity.deviceId, "…alongside the unchanged deviceId");
  assert(Array.isArray(manifest.profiles), "…and the existing declared-profile list is intact");
  assert(typeof manifest.associationsHash === "string", "…and the associations hash");

  const devicesDir = await Transport.getDevicesDir(await Transport.getSyncV2Root(dir.handle));
  const read = await Transport.readDeviceReplica(devicesDir, identity.deviceId);
  assertEqual(read.status, "valid", "the generation still reads back as valid");
  assertEqual(read.label, store.getDeviceLabel(), "the label is returned as metadata");
  assert(Number.isFinite(read.updatedAt), "…with the publish time, for diagnostics");
});

// =========================================================================
// 4. A device.json with no label at all is still valid
// =========================================================================

await test("4. an old device.json written before labels existed remains fully valid", async () => {
  const dir = createVirtualDirectory();
  const { identity, store } = await makeStore();
  await store.setFavorite(SUNRISE, true);
  await store.whenFactsSettled();
  await settle();
  await runSyncV2Pass({ profileStore: store, dirHandle: dir.handle });

  // Strip the field entirely, exactly as a pre-label build would have written it.
  const manifestPath = `sync-v2/devices/${identity.deviceId}/device.json`;
  const manifest = JSON.parse(dir.readFile(manifestPath));
  delete manifest.label;
  dir.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  const devicesDir = await Transport.getDevicesDir(await Transport.getSyncV2Root(dir.handle));
  const read = await Transport.readDeviceReplica(devicesDir, identity.deviceId);

  assertEqual(read.status, "valid", "a label-less generation is still VALID, not invalid");
  assertEqual(read.label, "Unknown Device", "…and reports the safe fallback label");
  assertEqual(read.replica.profiles[store.getProfileId()].items[SUNRISE].favorite.v.on, true, "…with its facts intact");
});

// =========================================================================
// 5. The label never enters the replica, so it cannot reach merge or identity
// =========================================================================

await test("5. the label is absent from the merged replica and from every merge input", async () => {
  const dir = createVirtualDirectory();
  const { identity, store } = await makeStore();
  await store.setFavorite(SUNRISE, true);
  await store.whenFactsSettled();
  await settle();
  await runSyncV2Pass({ profileStore: store, dirHandle: dir.handle });

  const replica = await store.getFullReplica();
  assert(!JSON.stringify(replica).includes(store.getDeviceLabel()), "the local replica contains no label");

  const devicesDir = await Transport.getDevicesDir(await Transport.getSyncV2Root(dir.handle));
  const read = await Transport.readDeviceReplica(devicesDir, identity.deviceId);
  assert(
    !JSON.stringify(read.replica).includes("label"),
    "the replica reconstructed from disk has no label key anywhere"
  );
  const { findSessionStateLeaks } = await import(src("profile/sync-facts.js"));
  const leaks = findSessionStateLeaks(read.replica);
  assert(leaks.length === 0, "…and the replica is still exactly the approved shape", leaks.join(", "));

  // The profile FACT files — the things that are hashed — carry no label.
  const factsFile = dir.readFile(`sync-v2/devices/${identity.deviceId}/profiles/${store.getProfileId()}.json`);
  assert(!factsFile.includes("label"), "no label leaked into a hashed profile facts file");
});

// =========================================================================
// 6. A label change on its own cannot trigger a republish
// =========================================================================

await test("6. changing ONLY the label does not republish, and does not alter identity", async () => {
  const dir = createVirtualDirectory();
  const { identity, store } = await makeStore();
  await store.setFavorite(SUNRISE, true);
  await store.whenFactsSettled();
  await settle();
  await runSyncV2Pass({ profileStore: store, dirHandle: dir.handle });

  const filesAfterFirst = JSON.stringify(dir.snapshotFiles());
  const idBefore = store.getDeviceId();

  // Same store, but now reporting a completely different platform label.
  const relabelled = {
    whenFactsSettled: () => store.whenFactsSettled(),
    getDeviceId: () => store.getDeviceId(),
    getDeviceLabel: () => "Totally Different Label",
    getFullReplica: () => store.getFullReplica(),
    observePeerReplica: (r) => store.observePeerReplica(r),
    adoptMergedReplica: (r) => store.adoptMergedReplica(r),
  };

  const result = await runSyncV2Pass({ profileStore: relabelled, dirHandle: dir.handle });
  assertEqual(result.status, "ok", "the pass succeeded");
  assertEqual(result.published, false, "…and published NOTHING — a label change is not a reason to write");
  assertEqual(JSON.stringify(dir.snapshotFiles()), filesAfterFirst, "not one byte changed on disk");
  assertEqual(store.getDeviceId(), idBefore, "…and the device is still the same device");

  // But a publish for a REAL reason does refresh the stored label.
  await store.setHidden(RAIN, true);
  await store.whenFactsSettled();
  await settle();
  const republished = await runSyncV2Pass({ profileStore: relabelled, dirHandle: dir.handle });
  assertEqual(republished.published, true, "a real change does publish");
  assertEqual(
    deviceManifest(dir, identity.deviceId).label,
    "Totally Different Label",
    "…and refreshes the label while it is there"
  );
  assertEqual(deviceManifest(dir, identity.deviceId).deviceId, idBefore, "…still under the same deviceId");
});

// =========================================================================
// 7. Two devices with the SAME label stay completely distinct
// =========================================================================

await test("7. two devices reporting an identical label remain separate peers", async () => {
  const dir = createVirtualDirectory();

  const a = await makeStore();
  const aIdb = globalThis.indexedDB;
  await a.store.setFavorite(SUNRISE, true);
  await a.store.whenFactsSettled();
  await settle();
  const labelled = (store, label) => ({
    whenFactsSettled: () => store.whenFactsSettled(),
    getDeviceId: () => store.getDeviceId(),
    getDeviceLabel: () => label,
    getFullReplica: () => store.getFullReplica(),
    observePeerReplica: (r) => store.observePeerReplica(r),
    adoptMergedReplica: (r) => store.adoptMergedReplica(r),
  });
  await runSyncV2Pass({ profileStore: labelled(a.store, "Chromebook"), dirHandle: dir.handle });

  const b = await makeStore();
  const bIdb = globalThis.indexedDB;
  await runSyncV2Pass({ profileStore: labelled(b.store, "Chromebook"), dirHandle: dir.handle });

  assert(a.identity.deviceId !== b.identity.deviceId, "the two devices have different deviceIds despite one label");
  const subtrees = Object.keys(dir.snapshotFiles())
    .filter((p) => p.startsWith("sync-v2/devices/"))
    .map((p) => p.split("/")[2]);
  assertEqual(new Set(subtrees).size, 2, "…and published two separate device subtrees");

  globalThis.indexedDB = bIdb;
  const result = await runSyncV2Pass({ profileStore: labelled(b.store, "Chromebook"), dirHandle: dir.handle });
  assertEqual(result.mergedPeers, 1, "B still sees A as a distinct peer, not as itself");
  globalThis.indexedDB = aIdb;
});

// =========================================================================
// 8. The diagnostic surface reports label first, id second — and is read-only
// =========================================================================

await test("8. the status surface exposes label and id together, and the console helper only reads", async () => {
  const dir = createVirtualDirectory();
  const { identity, store } = await makeStore();
  await store.setFavorite(SUNRISE, true);
  await store.whenFactsSettled();
  await settle();
  const result = await runSyncV2Pass({ profileStore: store, dirHandle: dir.handle });

  assert(Array.isArray(result.peers), "a pass reports its peers for diagnostics");
  assertEqual(store.getDeviceLabel().length > 0, true, "this device has a label to report");
  assertEqual(store.getDeviceId(), identity.deviceId, "…and its id");

  // Read-only by construction: the helper reads getStatus() and never calls a
  // pass or a mutator. Asserted at the source, because a console helper cannot
  // be invoked here without a DOM.
  const mainSource = await readFile(path.join(ROOT, "src", "main.js"), "utf8");
  const start = mainSource.indexOf("window.__bgSyncDevices = function");
  assert(start > 0, "__bgSyncDevices exists in main.js");
  const body = mainSource.slice(start, mainSource.indexOf("\n};", start));

  for (const forbidden of ["syncNow", "activateSyncV2", "reconcile", "setFavorite", "setHidden", "saveProfileData", "createWritable", "adoptMergedReplica", "removeEntry"]) {
    assert(!body.includes(forbidden), `__bgSyncDevices never calls ${forbidden}() — it is strictly read-only`);
  }
  assert(body.includes("profileSync.getStatus()"), "…it reads the already-published status surface");

  // Label first, ID second, in that order.
  const labelAt = body.indexOf("`Device: ");
  const idAt = body.indexOf("`Device ID: ");
  assert(labelAt > 0 && idAt > labelAt, "the human label is printed BEFORE the raw device id");
});

// =========================================================================

console.log(`\n${"-".repeat(60)}`);
console.log(`${passes} assertion(s) passed, ${failures} failure(s)`);
if (failures) {
  console.log("\nFailures:");
  for (const detail of failureDetail) console.log(`  - ${detail}`);
}
process.exit(failures ? 1 : 0);
