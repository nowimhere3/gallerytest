#!/usr/bin/env node
// [PHASE-6-SYNC-V2]
// [STAGE-E-CONVERGENCE-SCHEDULER]
// [WHY: every active client must merge shared truth approximately every 3
//  seconds without requiring local activity. The real two-device test proved
//  facts, transport and merge all worked and STILL failed the product
//  contract, because convergence was conditional on the local user touching
//  something. That class of gap is invisible to every layer test — each layer
//  is correct, nothing is ever triggered — so it needs tests that assert on the
//  passage of time with no local action at all.]
//
// Usage:  node tools/test-sync-v2-scheduler.mjs
//
// TIMING: these tests use the REAL clock, because the thing under test IS a
// timer. The cadence is 3000 ms, so waits are sized in whole cadences with
// slack; the suite takes ~40s by design. Nothing here polls a shared resource
// faster than the app itself would.

import { pathToFileURL } from "node:url";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { installFakeIndexedDB, createVirtualDirectory, settle, muteConsole } from "./lib/browser-test-env.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const src = (rel) => pathToFileURL(path.join(ROOT, "src", rel)).href;

// ---- Minimal browser environment for the wake triggers ---------------------
//
// Installed BEFORE ProfileSync is imported/constructed: it binds its listeners
// in the constructor, so the targets have to exist first. Deliberately the
// smallest surface the scheduler actually uses.
function makeEventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
    },
    removeEventListener(type, handler) {
      if (listeners.has(type)) listeners.get(type).delete(handler);
    },
    dispatch(type) {
      for (const handler of listeners.get(type) || []) handler();
    },
    count(type) {
      return (listeners.get(type) || new Set()).size;
    },
  };
}

const fakeDocument = makeEventTarget();
fakeDocument.visibilityState = "visible";
globalThis.document = fakeDocument;

const globalEvents = makeEventTarget();
globalThis.addEventListener = globalEvents.addEventListener.bind(globalEvents);
globalThis.removeEventListener = globalEvents.removeEventListener.bind(globalEvents);

const { setSnapshotFreezeEnabled } = await import(src("profile/profile-snapshot.js"));
setSnapshotFreezeEnabled(true);

const { ProfileStore } = await import(src("profile/profile-store.js"));
const { SyncIdentity } = await import(src("profile/sync-device.js"));
const { ProfileSync } = await import(src("profile/profile-sync.js"));
const { saveActivationState } = await import(src("storage/profile-sync-store.js"));

const CADENCE_MS = 3000;

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

const live = [];
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
    // Every installation created by a test is disposed before the next one, so
    // a stray timer can never make a later test pass (or fail) for the wrong
    // reason.
    for (const device of live.splice(0)) {
      try {
        device.sync.dispose();
      } catch {
        /* already disposed */
      }
    }
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- Fixture ---------------------------------------------------------------

async function makeInstallation(dirHandle, { activate: doActivate = true } = {}) {
  installFakeIndexedDB();
  const idb = globalThis.indexedDB;
  const identity = new SyncIdentity();
  await identity.ready;
  const store = new ProfileStore({ identity });
  await settle();
  await store.whenFactsSettled();

  const sync = new ProfileSync(store);
  await sync.connectNewFolder(dirHandle);
  await settle();

  const device = { idb, identity, store, sync, statuses: [] };
  sync.subscribe(() => device.statuses.push(sync.getStatus().status));
  if (doActivate) {
    await sync.activateSyncV2();
    await settle();
  }
  live.push(device);
  return device;
}

function use(device) {
  globalThis.indexedDB = device.idb;
}

async function on(device, fn) {
  use(device);
  return fn(device);
}

async function quiesce(device) {
  return on(device, async () => {
    await device.store.whenFactsSettled();
    await settle();
    await device.store.whenFactsSettled();
  });
}

/**
 * Lets a device's scheduler run for `ms` of real time WITH its own storage
 * active. Two installations share one globalThis.indexedDB, so a timer that
 * fires while the other device is "current" would read the wrong database —
 * this keeps the right one selected for the whole window.
 */
async function idleFor(device, ms) {
  use(device);
  const step = 100;
  for (let elapsed = 0; elapsed < ms; elapsed += step) {
    use(device);
    await wait(step);
  }
  use(device);
  await settle();
}

const SUNRISE = "Nature/Sunrise.mp4";
const RAIN = "Nature/Rain.mp4";
const STORM = "Nature/Storm.mp4";

function ownFiles(dir, deviceId) {
  const out = {};
  const prefix = `sync-v2/devices/${deviceId}/`;
  for (const [p, text] of Object.entries(dir.snapshotFiles())) {
    if (p.startsWith(prefix)) out[p.slice(prefix.length)] = text;
  }
  return out;
}

// =========================================================================
// 1 + 14. An idle device adopts a peer's change with no local action
// =========================================================================

await test("1. an IDLE device adopts a peer's fact within a couple of cadences, with no local action", async () => {
  const dir = createVirtualDirectory();
  const a = await makeInstallation(dir.handle);
  const sharedId = await on(a, () => a.store.getProfileId());
  await on(a, () => a.store.setFavorite(SUNRISE, true));
  await quiesce(a);
  await on(a, () => a.sync.syncNow());

  const b = await makeInstallation(dir.handle);
  await on(b, () => b.store.switchProfile(sharedId));
  await quiesce(b);
  await on(b, () => b.sync.syncNow());
  assertEqual(await on(b, () => b.store.isFavorite(RAIN)), false, "B does not have the change yet");

  // A publishes something new. B does NOTHING — no click, no mutation, no
  // Sync Now. This is exactly the real-device scenario that failed.
  await on(a, () => a.store.setFavorite(RAIN, true));
  await quiesce(a);
  await on(a, () => a.sync.syncNow());

  await idleFor(b, CADENCE_MS * 2 + 1500);

  assertEqual(
    await on(b, () => b.store.isFavorite(RAIN)),
    true,
    "the idle device converged on its own — this is the whole point of the scheduler"
  );
  // 14. and it is visible through the LIVE store the UI reads, not just on disk.
  assertEqual(
    await on(b, () => b.store.getFacts().items[RAIN].favorite.v.on),
    true,
    "…and it is readable through the live ProfileStore the UI renders from"
  );
});

// =========================================================================
// 2. Reverse direction
// =========================================================================

await test("2. the reverse direction converges the same way", async () => {
  const dir = createVirtualDirectory();
  const a = await makeInstallation(dir.handle);
  const sharedId = await on(a, () => a.store.getProfileId());
  await quiesce(a);
  await on(a, () => a.sync.syncNow());

  const b = await makeInstallation(dir.handle);
  await on(b, () => b.store.switchProfile(sharedId));
  await quiesce(b);
  await on(b, () => b.sync.syncNow());

  // B mutates and publishes; A sits idle.
  await on(b, () => b.store.setHidden(STORM, true));
  await quiesce(b);
  await on(b, () => b.sync.syncNow());

  await idleFor(a, CADENCE_MS * 2 + 1500);

  assertEqual(await on(a, () => a.store.isHidden(STORM)), true, "the idle device in the other direction converged too");
});

// =========================================================================
// 3. Cadence
// =========================================================================

await test("3. a connected V2 device runs a pass roughly every cadence while idle", async () => {
  const dir = createVirtualDirectory();
  const a = await makeInstallation(dir.handle);
  await quiesce(a);

  let reads = 0;
  const realQuery = dir.handle.queryPermission.bind(dir.handle);
  dir.handle.queryPermission = async (...args) => {
    reads += 1;
    return realQuery(...args);
  };

  reads = 0;
  await idleFor(a, CADENCE_MS * 3 + 1200);

  // Every pass begins with exactly one queryPermission, so this counts passes.
  assert(reads >= 3, `at least 3 passes ran in ~3 cadences (saw ${reads})`, null);
  assert(reads <= 6, `…and not a runaway loop (saw ${reads})`, null);
});

// =========================================================================
// 4. A no-op poll does not rewrite this device's own subtree
// =========================================================================

await test("4. an idle no-op poll publishes nothing and rewrites no bytes", async () => {
  const dir = createVirtualDirectory();
  const a = await makeInstallation(dir.handle);
  await on(a, () => a.store.setFavorite(SUNRISE, true));
  await quiesce(a);
  await on(a, () => a.sync.syncNow());

  const before = JSON.stringify(ownFiles(dir, a.identity.deviceId));
  const writesBefore = dir.log.filter((e) => e.op === "write").length;

  await idleFor(a, CADENCE_MS * 3 + 1200);

  assertEqual(JSON.stringify(ownFiles(dir, a.identity.deviceId)), before, "not one published byte changed");
  assertEqual(
    dir.log.filter((e) => e.op === "write").length,
    writesBefore,
    "…and no write operation was issued at all — reads happen on the cadence, writes only when needed"
  );
});

// =========================================================================
// 5. A local mutation still triggers the earlier debounced pass
// =========================================================================

await test("5. a local mutation publishes on the existing debounce, not the poll cadence", async () => {
  const dir = createVirtualDirectory();
  const a = await makeInstallation(dir.handle);
  await quiesce(a);
  await on(a, () => a.sync.syncNow());

  const before = JSON.stringify(ownFiles(dir, a.identity.deviceId));
  await on(a, () => a.store.setFavorite(STORM, true));
  await quiesce(a);

  // Well inside one debounce + a little settle, and short of two cadences.
  await idleFor(a, CADENCE_MS + 1200);

  assert(
    JSON.stringify(ownFiles(dir, a.identity.deviceId)) !== before,
    "the local change was published promptly by the debounce path"
  );
});

// =========================================================================
// 6. A tick during an in-flight pass is coalesced, never concurrent
// =========================================================================

await test("6. a scheduled tick during an in-flight pass never overlaps it, and still runs after", async () => {
  let inFlight = 0;
  let maxConcurrent = 0;
  let completed = 0;

  const dir = createVirtualDirectory();
  const a = await makeInstallation(dir.handle);
  await quiesce(a);

  const realQuery = dir.handle.queryPermission.bind(dir.handle);
  dir.handle.queryPermission = async (...args) => {
    inFlight += 1;
    maxConcurrent = Math.max(maxConcurrent, inFlight);
    // Hold the pass open across more than one full cadence, so a tick is
    // guaranteed to become due while this one is still running.
    await wait(CADENCE_MS + 800);
    inFlight -= 1;
    completed += 1;
    return realQuery(...args);
  };

  const slowPass = on(a, () => a.sync.syncNow());
  await idleFor(a, 400);
  await slowPass;
  await idleFor(a, CADENCE_MS * 2 + 1500);

  assertEqual(maxConcurrent, 1, "never more than one filesystem pass at a time");
  assert(completed >= 2, `the tick that became due mid-pass still ran afterwards (${completed} passes)`, null);
});

// =========================================================================
// 7. Repeated init/reconnect does not create duplicate schedulers
// =========================================================================

await test("7. repeated init()/reconnect() leaves exactly one timer, not one per call", async () => {
  const dir = createVirtualDirectory();
  const a = await makeInstallation(dir.handle);
  await quiesce(a);

  let reads = 0;
  const realQuery = dir.handle.queryPermission.bind(dir.handle);
  dir.handle.queryPermission = async (...args) => {
    reads += 1;
    return realQuery(...args);
  };

  // Hammer every lifecycle entry point that arms the timer.
  await on(a, () => a.sync.init());
  await on(a, () => a.sync.init());
  await on(a, () => a.sync.reconnect());
  await on(a, () => a.sync.connectNewFolder(dir.handle));
  await settle();

  reads = 0;
  await idleFor(a, CADENCE_MS * 2 + 1200);

  // Two cadences => ~2 passes. Duplicated timers would multiply this.
  assert(reads <= 4, `no duplicate schedulers — ~2 passes in 2 cadences (saw ${reads})`, null);
  assert(reads >= 1, `…and polling is still running at all (saw ${reads})`, null);
});

// =========================================================================
// 8 + 9. V1, unconfigured and activation-failed never poll
// =========================================================================

await test("8/9. V1, disconnected and activation-failed installations never spin the V2 scheduler", async () => {
  // ---- V1 ----
  const v1Dir = createVirtualDirectory();
  const v1 = await makeInstallation(v1Dir.handle, { activate: false });
  await quiesce(v1);
  assertEqual(await on(v1, () => v1.sync.getStatus().mode), "v1", "still on V1");
  let v1Writes = v1Dir.log.filter((e) => e.op === "write").length;
  await idleFor(v1, CADENCE_MS * 2 + 800);
  assertEqual(
    v1Dir.log.filter((e) => e.op === "write").length,
    v1Writes,
    "a V1 installation added no polling writes — no V1 polling behaviour was introduced"
  );
  assertEqual(
    Object.keys(ownFiles(v1Dir, v1.identity.deviceId)).length,
    0,
    "…and never created a V2 subtree"
  );

  // ---- disconnected ----
  const dir = createVirtualDirectory();
  const a = await makeInstallation(dir.handle);
  await quiesce(a);
  await on(a, () => a.sync.disconnect());
  const afterDisconnect = JSON.stringify(dir.snapshotFiles());
  await idleFor(a, CADENCE_MS * 2 + 800);
  assertEqual(JSON.stringify(dir.snapshotFiles()), afterDisconnect, "a disconnected installation stopped polling");

  // ---- activation failed ----
  const failedDir = createVirtualDirectory();
  installFakeIndexedDB();
  const failedIdb = globalThis.indexedDB;
  await saveActivationState({ mode: "failed", activatedAt: null, migration: { reason: "simulated" } });
  const identity = new SyncIdentity();
  await identity.ready;
  const store = new ProfileStore({ identity });
  await settle();
  const sync = new ProfileSync(store);
  await sync.connectNewFolder(failedDir.handle);
  await settle();
  const failed = { idb: failedIdb, identity, store, sync, statuses: [] };
  live.push(failed);

  const beforeFailed = JSON.stringify(failedDir.snapshotFiles());
  await idleFor(failed, CADENCE_MS * 2 + 800);
  assertEqual(await on(failed, () => failed.sync.getStatus().status), "migration-failed", "state is truthful");
  assertEqual(JSON.stringify(failedDir.snapshotFiles()), beforeFailed, "…and it wrote nothing while idling");
});

// =========================================================================
// 10 + 11. Visibility and online wake the client immediately
// =========================================================================

await test("10/11. becoming visible, focused, or online triggers an immediate peer check", async () => {
  const dir = createVirtualDirectory();
  const a = await makeInstallation(dir.handle);
  const sharedId = await on(a, () => a.store.getProfileId());
  await quiesce(a);
  await on(a, () => a.sync.syncNow());

  const b = await makeInstallation(dir.handle);
  await on(b, () => b.store.switchProfile(sharedId));
  await quiesce(b);
  await on(b, () => b.sync.syncNow());

  // ---- visibilitychange ----
  await on(a, () => a.store.setFavorite(SUNRISE, true));
  await quiesce(a);
  await on(a, () => a.sync.syncNow());

  use(b);
  fakeDocument.visibilityState = "visible";
  fakeDocument.dispatch("visibilitychange");
  await idleFor(b, 1200); // far short of a cadence
  assertEqual(await on(b, () => b.store.isFavorite(SUNRISE)), true, "becoming visible checked shared truth at once");

  // ---- online ----
  await on(a, () => a.store.setHidden(RAIN, true));
  await quiesce(a);
  await on(a, () => a.sync.syncNow());

  use(b);
  globalEvents.dispatch("online");
  await idleFor(b, 1200);
  assertEqual(await on(b, () => b.store.isHidden(RAIN)), true, "coming back online checked shared truth at once");

  // ---- a HIDDEN tab must not be woken by visibilitychange ----
  const hiddenChecks = [];
  const realQuery = dir.handle.queryPermission.bind(dir.handle);
  dir.handle.queryPermission = async (...args) => {
    hiddenChecks.push(1);
    return realQuery(...args);
  };
  use(b);
  fakeDocument.visibilityState = "hidden";
  fakeDocument.dispatch("visibilitychange");
  await wait(150);
  assertEqual(hiddenChecks.length, 0, "going HIDDEN does not trigger a pass");
  fakeDocument.visibilityState = "visible";
});

// =========================================================================
// 12. One failed pass does not permanently stop polling
// =========================================================================

await test("12. a pass that fails does not kill the scheduler", async () => {
  const dir = createVirtualDirectory();
  const a = await makeInstallation(dir.handle);
  await quiesce(a);

  let calls = 0;
  const realQuery = dir.handle.queryPermission.bind(dir.handle);
  dir.handle.queryPermission = async (...args) => {
    calls += 1;
    if (calls <= 2) throw new Error("Simulated transient Drive failure");
    return realQuery(...args);
  };

  const restoreConsole = muteConsole();
  await idleFor(a, CADENCE_MS * 4 + 1500);
  restoreConsole();

  assert(calls > 3, `polling continued past the failures (${calls} attempts)`, null);
  assertEqual(
    await on(a, () => a.sync.getStatus().status),
    "connected",
    "…and recovered to a truthful connected state once the fault cleared"
  );
});

// =========================================================================
// 13. Idle polling does not flicker the status
// =========================================================================

await test("13. no-op background polling never shows Syncing… and does not spam the status surface", async () => {
  const dir = createVirtualDirectory();
  const a = await makeInstallation(dir.handle);
  await on(a, () => a.store.setFavorite(SUNRISE, true));
  await quiesce(a);
  await on(a, () => a.sync.syncNow());

  a.statuses.length = 0;
  await idleFor(a, CADENCE_MS * 3 + 1500);

  assertEqual(
    a.statuses.filter((s) => s === "syncing").length,
    0,
    "a background poll never announced Syncing… — this is the strobe the UI must not do"
  );
  assertEqual(a.statuses.length, 0, "…and emitted nothing at all, because nothing meaningful happened");

  // A user-initiated pass still reports normally.
  await on(a, () => a.sync.syncNow());
  assert(a.statuses.includes("syncing"), "an explicit Sync Now DOES still show Syncing…");
  assert(a.statuses.includes("connected"), "…and lands on connected");
});

// =========================================================================
// 15. The scheduler never touches the physical media library
// =========================================================================

await test("15. a convergence pass performs no FSA media enumeration", async () => {
  // [PHASE-6-SYNC-V2][STAGE-E-CONVERGENCE-SCHEDULER]
  // [WHY: the BEAST test library is ~17,000 files. A scheduler that touched the
  //  media source every 3 seconds would be unusable, and the guarantee that it
  //  cannot is STRUCTURAL — nothing in the convergence path holds a reference to
  //  the media library at all. This asserts that structurally (no import edge)
  //  and behaviourally (every filesystem call in a pass lands on the SYNC
  //  folder), because a counter on a handle nobody references would pass no
  //  matter what the code did.]
  const modules = ["profile/sync-v2.js", "profile/sync-v2-transport.js", "profile/profile-sync.js"];
  for (const rel of modules) {
    const source = await readFile(path.join(ROOT, "src", rel), "utf8");
    const imports = [...source.matchAll(/^import[^;]*?from\s+"([^"]+)"/gms)].map((m) => m[1]);
    const mediaImports = imports.filter((spec) => /providers\/|media-runtime|fsa-file-provider|legacy-library-signature/.test(spec));
    assert(
      mediaImports.length === 0,
      `${rel} has no import edge to any media/provider module`,
      mediaImports.join(", ")
    );
  }

  // Behavioural half: instrument the SYNC folder handle and confirm every
  // directory a pass opens is inside sync-v2/, never a media path.
  const dir = createVirtualDirectory();
  const a = await makeInstallation(dir.handle);
  await quiesce(a);

  const opened = [];
  const realGetDir = dir.handle.getDirectoryHandle.bind(dir.handle);
  dir.handle.getDirectoryHandle = async (name, opts) => {
    opened.push(name);
    return realGetDir(name, opts);
  };

  await on(a, () => a.store.setFavorite(SUNRISE, true));
  await quiesce(a);
  await idleFor(a, CADENCE_MS * 3 + 1500);

  assert(opened.length > 0, `the pass really did open the sync folder (${opened.length} times)`);
  assertEqual(
    opened.every((name) => name === "sync-v2"),
    true,
    "every directory a convergence pass opened was the sync-v2 root — no media path was ever traversed",
    [...new Set(opened)].join(", ")
  );

  // And the media-item projection loop is not driven by a no-op poll either:
  // ProfileStore only emits when adoption actually changed something.
  let profileEmits = 0;
  const unsubscribe = a.store.subscribe(() => {
    profileEmits += 1;
  });
  await idleFor(a, CADENCE_MS * 2 + 1200);
  unsubscribe();
  assertEqual(profileEmits, 0, "…and an idle no-op poll did not fire the ProfileStore subscriber that re-projects all 17k items");
});

// =========================================================================

console.log(`\n${"-".repeat(60)}`);
console.log(`${passes} assertion(s) passed, ${failures} failure(s)`);
if (failures) {
  console.log("\nFailures:");
  for (const detail of failureDetail) console.log(`  - ${detail}`);
}
process.exit(failures ? 1 : 0);
