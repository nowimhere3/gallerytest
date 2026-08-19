#!/usr/bin/env node
// [SYNCV3 / STAGE-01 / V3-ROOT-ISOLATION]
// [WHY: this stage's entire promise is a negative one — "V3 exists and V2 is
//  exactly as it was" — and a negative is precisely what manual testing cannot
//  establish. A V3 write that clobbered the V2 activation row would look like
//  nothing at all in the browser until the user tried to go back, at which point
//  the state it needed is already gone. So every assertion here is made against
//  the RAW persisted rows rather than the engine's own report of itself: the
//  engine is the thing under test, and asking it whether it corrupted something
//  is asking the wrong witness.]
//
// Usage:  node tools/test-syncv3-root-isolation.mjs

import { pathToFileURL } from "node:url";
import path from "node:path";
import { installFakeIndexedDB, createVirtualDirectory, settle, muteConsole } from "./lib/browser-test-env.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const src = (rel) => pathToFileURL(path.join(ROOT, "src", rel)).href;

const { setSnapshotFreezeEnabled } = await import(src("profile/profile-snapshot.js"));
setSnapshotFreezeEnabled(true);

const { ProfileStore } = await import(src("profile/profile-store.js"));
const { SyncIdentity } = await import(src("profile/sync-device.js"));
const { ProfileSync } = await import(src("profile/profile-sync.js"));
const Store = await import(src("storage/profile-sync-store.js"));

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

// Every ProfileSync built by a test is disposed when that test ends — same
// reasoning as tools/test-sync-v2-live.mjs: a live instance owns a real timer,
// and installations here share one globalThis.indexedDB.
const liveInstances = [];

async function test(name, fn) {
  console.log(`\n${name}`);
  try {
    await fn();
  } catch (error) {
    failures++;
    failureDetail.push(`${name} — threw: ${error && error.stack}`);
    console.log(`  FAIL  threw: ${error && error.message}`);
    console.log(String(error && error.stack).split("\n").slice(1, 4).join("\n"));
  } finally {
    for (const sync of liveInstances.splice(0)) {
      try {
        sync.dispose();
      } catch {
        /* already gone */
      }
    }
  }
}

// ---- Raw-row inspection ----------------------------------------------------
//
// Reads the fake IndexedDB's backing Maps DIRECTLY, bypassing every accessor in
// profile-sync-store.js. A helper built on those accessors could not detect the
// failure this file is about: a V3 function writing a V2 row would be reported
// faithfully by the very reader that shares its bug.

const SYNC_DB = "loop-browser-gallery-profile-sync";
const SYNC_STORE = "sync";

// `env` is installFakeIndexedDB()'s RETURN value (the backing store), not
// globalThis.indexedDB (the request-issuing façade). Only the former exposes the
// committed rows, which is the whole point of reading them here.
function rawRow(env, id) {
  const db = env.databases.get(SYNC_DB);
  if (!db) return undefined;
  const store = db.stores.get(SYNC_STORE);
  if (!store) return undefined;
  return store.rows.get(id);
}

/**
 * A stable string for one row. A persisted FileSystemDirectoryHandle is a host
 * object whose methods JSON.stringify drops, so handles are reduced to a marker
 * naming the folder — enough to detect a row being repointed at a different
 * folder, which is the only handle change that matters here.
 */
function rowFingerprint(env, id) {
  const row = rawRow(env, id);
  if (row === undefined) return "<absent>";
  return JSON.stringify(row, (key, value) => {
    if (key === "handle" && value && typeof value === "object") return `<handle:${value.name}>`;
    return value;
  });
}

function allRowIds(env) {
  const db = env.databases.get(SYNC_DB);
  if (!db) return [];
  const store = db.stores.get(SYNC_STORE);
  if (!store) return [];
  return [...store.rows.keys()].sort();
}

/** Fingerprints of every row V3 must never touch. */
function v2Fingerprints(env) {
  return {
    connection: rowFingerprint(env, "sync"),
    activation: rowFingerprint(env, "activation"),
    associations: rowFingerprint(env, "associations"),
    device: rowFingerprint(env, "device"),
  };
}

function assertV2Untouched(before, after, label) {
  for (const key of ["connection", "activation", "associations", "device"]) {
    assert(
      before[key] === after[key],
      `${label} — V2 "${key}" row is byte-identical`,
      before[key] === after[key] ? null : `before: ${before[key]}\n        after:  ${after[key]}`
    );
  }
}

// ---- Installation fixture --------------------------------------------------

async function makeInstallation() {
  const env = installFakeIndexedDB();
  const idb = globalThis.indexedDB;
  const identity = new SyncIdentity();
  await identity.ready;
  const store = new ProfileStore({ identity });
  await settle();
  await store.whenFactsSettled();

  const sync = new ProfileSync(store);
  liveInstances.push(sync);
  return { env, idb, identity, store, sync };
}

/** A fresh engine over the SAME storage — the fixture's stand-in for a reload. */
async function reboot(install) {
  install.sync.dispose();
  const store = new ProfileStore({ identity: install.identity });
  await settle();
  await store.whenFactsSettled();
  const sync = new ProfileSync(store);
  liveInstances.push(sync);
  await sync.init();
  await settle();
  return { ...install, store, sync };
}

/** Seeds a fully configured, activated Sync V2 installation over `dir`. */
async function seedActivatedV2(dir) {
  const install = await makeInstallation();
  await install.sync.connectNewFolder(dir.handle);
  await settle();
  await install.sync.activateSyncV2();
  await settle();
  return install;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ============================================================================

console.log("SyncV3 Stage 01 — V3 root isolation");

// 1 + 2 --------------------------------------------------------------------
await test("A seeded V2 installation is not modified by connecting a V3 folder", async () => {
  const v2Dir = createVirtualDirectory("V2 Sync");
  const v3Dir = createVirtualDirectory("V3 Sync");
  const install = await seedActivatedV2(v2Dir);

  assertEqual(install.sync.getStatus().mode, "v2", "seeded installation is on V2");
  const before = v2Fingerprints(install.env);
  assert(before.connection !== "<absent>", "V2 connection row was seeded");
  assert(before.activation !== "<absent>", "V2 activation row was seeded");
  assert(before.device !== "<absent>", "shared device row exists");

  await install.sync.connectV3Folder(v3Dir.handle);
  await settle();

  assertV2Untouched(before, v2Fingerprints(install.env), "after connectV3Folder");

  const v3Row = rawRow(install.env, "sync-v3");
  assert(Boolean(v3Row), "a sync-v3 row was created");
  assertEqual(v3Row && v3Row.folderName, "V3 Sync", "sync-v3 row names the V3 folder");
  assertEqual(v3Row && v3Row.handle && v3Row.handle.name, "V3 Sync", "sync-v3 row stores the V3 handle");

  // Connecting a V3 folder before activating must not hijack the running V2
  // status line — the V2 sync is still genuinely running.
  const status = install.sync.getStatus();
  assertEqual(status.mode, "v2", "connecting a V3 folder does not change the transport");
  assertEqual(status.v3Configured, true, "status reports the V3 folder as configured");
  assertEqual(status.v3Status, "ready", "status reports the V3 folder as ready");
  assert(String(status.status).startsWith("v3-") === false, "V2's own status line is not overwritten");
});

// 3 -------------------------------------------------------------------------
await test("Activating V3 records its own row and deletes no V2 configuration", async () => {
  const v2Dir = createVirtualDirectory("V2 Sync");
  const v3Dir = createVirtualDirectory("V3 Sync");
  const install = await seedActivatedV2(v2Dir);
  await install.sync.connectV3Folder(v3Dir.handle);
  await settle();

  const before = v2Fingerprints(install.env);

  const result = await install.sync.activateSyncV3();
  await settle();

  assertEqual(result.ok, true, "activateSyncV3 reports success");
  assertEqual(install.sync.getStatus().mode, "v3", "engine mode is now v3");

  assertV2Untouched(before, v2Fingerprints(install.env), "after activateSyncV3");

  const v3Activation = rawRow(install.env, "activation-v3");
  assert(Boolean(v3Activation), "an activation-v3 row was created");
  assertEqual(v3Activation && v3Activation.mode, "v3", "activation-v3 records mode v3");
  assert(Number.isFinite(v3Activation && v3Activation.activatedAt), "activation-v3 records activatedAt");

  // The V2 activation row must still describe the V2 cutover, not V3's.
  const v2Activation = rawRow(install.env, "activation");
  assertEqual(v2Activation && v2Activation.mode, "v2", "V2 activation row still says v2");
});

// 4 + 5 ---------------------------------------------------------------------
await test("Disconnecting V3 clears only the V3 connection row", async () => {
  const v2Dir = createVirtualDirectory("V2 Sync");
  const v3Dir = createVirtualDirectory("V3 Sync");
  const install = await seedActivatedV2(v2Dir);

  const beforeCycle = v2Fingerprints(install.env);

  await install.sync.connectV3Folder(v3Dir.handle);
  await settle();
  await install.sync.activateSyncV3();
  await settle();
  await install.sync.disconnectV3();
  await settle();

  assertEqual(rawRow(install.env, "sync-v3"), undefined, "sync-v3 row is gone");
  assert(Boolean(rawRow(install.env, "activation-v3")), "activation-v3 row survives a folder disconnect");
  assertEqual(install.sync.getStatus().mode, "v3", "disconnecting the folder does not leave V3 mode");
  assertEqual(install.sync.getStatus().status, "v3-not-configured", "status truthfully reports no V3 folder");

  // The full requirement: V2 byte-identical across the WHOLE connect/activate/
  // disconnect cycle, not merely across each step measured separately.
  assertV2Untouched(beforeCycle, v2Fingerprints(install.env), "across the whole V3 connect/disconnect cycle");
});

// 6 -------------------------------------------------------------------------
await test("V3 mode and the V3 folder survive a reload", async () => {
  const v2Dir = createVirtualDirectory("V2 Sync");
  const v3Dir = createVirtualDirectory("V3 Sync");
  let install = await seedActivatedV2(v2Dir);
  await install.sync.connectV3Folder(v3Dir.handle);
  await settle();
  await install.sync.activateSyncV3();
  await settle();

  install = await reboot(install);

  const status = install.sync.getStatus();
  assertEqual(status.mode, "v3", "a rebooted engine resolves mode v3 from the V3 row");
  assertEqual(status.v3Configured, true, "the V3 folder is remembered across a reload");
  assertEqual(status.v3FolderName, "V3 Sync", "the remembered V3 folder is the right one");
  assertEqual(status.status, "v3-ready", "status reports the V3 folder as ready after reload");

  // The V2 relationship is still on disk, and deliberately not adopted in memory.
  assert(Boolean(rawRow(install.env, "sync")), "the V2 connection row survives a V3-mode reload");
  assertEqual(status.configured, false, "V2's handle is not adopted while V3 is active");
});

// 7 -------------------------------------------------------------------------
await test("The installation deviceId is reused, never re-minted, across V3 activation", async () => {
  const v2Dir = createVirtualDirectory("V2 Sync");
  const v3Dir = createVirtualDirectory("V3 Sync");
  let install = await seedActivatedV2(v2Dir);

  const originalDeviceId = install.store.getDeviceId();
  const originalDeviceRow = rowFingerprint(install.env, "device");
  assert(Boolean(originalDeviceId), "the installation has a deviceId before V3");

  await install.sync.connectV3Folder(v3Dir.handle);
  await settle();
  await install.sync.activateSyncV3();
  await settle();
  install = await reboot(install);

  assertEqual(install.store.getDeviceId(), originalDeviceId, "deviceId is unchanged after activating V3 and reloading");
  assertEqual(rowFingerprint(install.env, "device"), originalDeviceRow, "the device row itself is byte-identical");

  // No V3-specific device identity may exist anywhere in the store.
  const ids = allRowIds(install.env);
  const deviceLike = ids.filter((id) => id !== "device" && id.includes("device"));
  assertEqual(deviceLike.length, 0, `no second device row was minted (found: ${deviceLike.join(", ") || "none"})`);
});

// 8 -------------------------------------------------------------------------
await test("V3 mode runs no transport — neither folder is written to", async () => {
  const v2Dir = createVirtualDirectory("V2 Sync");
  const v3Dir = createVirtualDirectory("V3 Sync");
  const install = await seedActivatedV2(v2Dir);

  // A real V2 pass has already published here; that is the baseline V3 must not
  // add to, and must not silently rewrite.
  const v2FilesBefore = JSON.stringify(v2Dir.snapshotFiles());
  assert(v2FilesBefore.includes("sync-v2/devices/"), "the seeded V2 installation really did publish");
  // Captured from the V2 era: the point is that V3 never MOVES this forward,
  // not that it is null — a seeded V2 installation has legitimately synced.
  const lastSyncAtBeforeV3 = install.sync.getStatus().lastSyncAt;
  assert(Number.isFinite(lastSyncAtBeforeV3), "the seeded V2 installation recorded a real lastSyncAt");

  await install.sync.connectV3Folder(v3Dir.handle);
  await settle();
  await install.sync.activateSyncV3();
  await settle();

  // A local mutation is the strongest trigger available: it is what schedules
  // the debounced auto-sync pass on a V1/V2 installation.
  install.store.setFavorite("clip.mp4", true);
  await install.store.whenFactsSettled();
  await install.sync.syncNow();
  await settle();
  // Past AUTO_SYNC_DEBOUNCE_MS — proves the mutation did not merely fail to
  // publish YET.
  await wait(3600);
  await settle();

  assertEqual(
    JSON.stringify(v3Dir.snapshotFiles()),
    "{}",
    "the V3 folder is still completely empty — no transport, no placeholder"
  );
  assertEqual(JSON.stringify(v2Dir.snapshotFiles()), v2FilesBefore, "the V2 folder gained and lost nothing under V3");
  assertEqual(install.sync.getStatus().status, "v3-ready", "status never claims a sync occurred");
  assertEqual(install.sync.getStatus().lastSyncAt, lastSyncAtBeforeV3, "lastSyncAt was not advanced by V3");
});

// 9 -------------------------------------------------------------------------
await test("Disconnecting V2 does not delete V3 records", async () => {
  const v2Dir = createVirtualDirectory("V2 Sync");
  const v3Dir = createVirtualDirectory("V3 Sync");
  const install = await seedActivatedV2(v2Dir);
  await install.sync.connectV3Folder(v3Dir.handle);
  await settle();

  const v3ConnectionBefore = rowFingerprint(install.env, "sync-v3");

  await install.sync.disconnect();
  await settle();

  assertEqual(rawRow(install.env, "sync"), undefined, "the V2 connection row was cleared, as V2 disconnect must");
  assertEqual(rowFingerprint(install.env, "sync-v3"), v3ConnectionBefore, "the V3 connection row is byte-identical");
  assert(Boolean(rawRow(install.env, "device")), "the shared device row survives a V2 disconnect");
});

// 10 ------------------------------------------------------------------------
await test("Leaving V3 restores V2 exactly, and V2 resumes publishing", async () => {
  const v2Dir = createVirtualDirectory("V2 Sync");
  const v3Dir = createVirtualDirectory("V3 Sync");
  let install = await seedActivatedV2(v2Dir);
  await install.sync.connectV3Folder(v3Dir.handle);
  await settle();
  await install.sync.activateSyncV3();
  await settle();

  // While V3 is active, V2 activation must refuse rather than half-work.
  const restore = muteConsole();
  const blocked = await install.sync.activateSyncV2();
  restore();
  assertEqual(blocked.blockedByV3, true, "activateSyncV2 refuses while V3 is active");
  assertEqual(install.sync.getStatus().mode, "v3", "the refused activation left the mode alone");

  const leave = await install.sync.deactivateSyncV3();
  await settle();

  assertEqual(leave.ok, true, "deactivateSyncV3 reports success");
  assertEqual(install.sync.getStatus().mode, "v2", "the installation is back on V2");
  assertEqual(rawRow(install.env, "activation-v3"), undefined, "the activation-v3 row was deleted");
  assertEqual(install.sync.getStatus().configured, true, "the V2 folder relationship was restored");
  assertEqual(install.sync.getStatus().folderName, "V2 Sync", "restored to the ORIGINAL V2 folder");

  // A genuine V2 pass runs again and publishes a real change.
  install.store.setFavorite("resumed.mp4", true);
  await install.store.whenFactsSettled();
  await install.sync.syncNow();
  await settle();

  const files = v2Dir.snapshotFiles();
  const published = Object.entries(files).find(([p]) => p.includes("sync-v2/devices/") && p.endsWith(".json"));
  assert(Boolean(published), "V2 published again after leaving V3");
  assert(
    JSON.stringify(files).includes("resumed.mp4"),
    "the post-V3 V2 publish contains the change made after leaving V3"
  );
  assertEqual(JSON.stringify(v3Dir.snapshotFiles()), "{}", "the V3 folder is still empty afterwards");

  // And the restored state survives a reload, which is what proves nothing was
  // reconstructed only in memory.
  install = await reboot(install);
  assertEqual(install.sync.getStatus().mode, "v2", "V2 is still the mode after a reload");
});

// Reserved-row isolation ----------------------------------------------------
await test("The reserved V3 associations row is isolated from V2's", async () => {
  const install = await makeInstallation();

  await Store.saveAssociationsCache({ "lib-v2": { v: "profile-v2", t: 10, d: "dev-a" } });
  await Store.saveV3AssociationsCache({ "lib-v3": { v: "profile-v3", t: 20, d: "dev-a" } });

  const v2Cache = await Store.loadAssociationsCache();
  const v3Cache = await Store.loadV3AssociationsCache();

  assertEqual(Object.keys(v2Cache).join(","), "lib-v2", "the V2 associations cache holds only V2's entry");
  assertEqual(Object.keys(v3Cache).join(","), "lib-v3", "the V3 associations cache holds only V3's entry");
  assert(Boolean(rawRow(install.env, "associations")), "the V2 associations row exists under its own id");
  assert(Boolean(rawRow(install.env, "associations-v3")), "the V3 associations row exists under its own id");
});

// ---- Summary ---------------------------------------------------------------

console.log(`\n${"-".repeat(60)}`);
if (failures === 0) {
  console.log(`ok    ${passes} assertion(s) passed — SyncV3 Stage 01 isolation holds.`);
} else {
  console.log(`FAIL  ${failures} failure(s), ${passes} passed:`);
  for (const detail of failureDetail) console.log(`  - ${detail}`);
}
process.exit(failures === 0 ? 0 : 1);
