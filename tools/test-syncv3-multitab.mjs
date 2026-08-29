#!/usr/bin/env node
// [SYNCV3 / STAGE-03B / SAME-DEVICE-WRITER-COORDINATION]
// [WHY: two or three Browser Gallery tabs on one origin is normal, supported
//  use - and it is the one configuration where V3's transport is unsafe without
//  help. Those tabs share a deviceId and therefore ONE directory under
//  sync-v3/devices/, and each tab's publish ends by deleting every file in that
//  directory the manifest it just wrote does not name. Two tabs publishing
//  concurrently therefore delete each other's Profile files while both believing
//  they are tidying their own subtree, and a third device reading in between
//  sees a half-built generation. Every failure here is silent and lands on real
//  curation, so the coordination is proven mechanically rather than by opening
//  three tabs and hoping.]
//
// Usage:  node tools/test-syncv3-multitab.mjs

import { pathToFileURL } from "node:url";
import path from "node:path";
import {
  installFakeIndexedDB,
  createVirtualDirectory,
  createFakeLockManager,
  createLockNamespace,
  settle,
  muteConsole,
} from "./lib/browser-test-env.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const src = (rel) => pathToFileURL(path.join(ROOT, "src", rel)).href;

const { setSnapshotFreezeEnabled } = await import(src("profile/profile-snapshot.js"));
setSnapshotFreezeEnabled(true);

const { ProfileStore } = await import(src("profile/profile-store.js"));
const { SyncIdentity } = await import(src("profile/sync-device.js"));
const { ProfileSync } = await import(src("profile/profile-sync.js"));
const { runSyncV3Pass } = await import(src("profile/sync-v3.js"));
const Transport = await import(src("profile/sync-v3-transport.js"));
const Store = await import(src("storage/profile-sync-store.js"));
const Policy = await import(src("profile/sync-v3-write-policy.js"));

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

const liveInstances = [];
const leasesToRelease = [];

async function test(name, fn) {
  console.log(`\n${name}`);
  try {
    await fn();
  } catch (error) {
    failures++;
    failureDetail.push(`${name} - threw: ${error && error.stack}`);
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
    // A sustained lease outlives its pass by design, so every test must hand it
    // back or the next test starts with the lock already taken.
    for (const lease of leasesToRelease.splice(0)) {
      try {
        lease.release();
      } catch {
        /* already gone */
      }
    }
  }
}

// ---- Multi-tab fixture -----------------------------------------------------
//
// A "tab" is its own ProfileStore over its own IndexedDB, but sharing ONE
// deviceId and ONE lock namespace - which is precisely what two tabs of one
// installation are. Separate IndexedDB per tab is a deliberate simplification:
// it isolates what this file is about (Drive-write coordination) from the
// separate, pre-existing question of shared local state between tabs.

const SHARED_DEVICE_ID = "dev-a31f2c4e-1111-4222-8333-444455556666";
const OTHER_DEVICE_ID = "dev-90a84b71-7777-4888-8999-aaaabbbbcccc";

function fixedIdentity(deviceId) {
  return {
    ready: Promise.resolve(),
    deviceId,
    isEphemeral: false,
    label: "Chromebook",
    observeReplica() {
      return this;
    },
    observe() {
      return this;
    },
    tick() {
      fixedIdentity.counter = (fixedIdentity.counter || 1_700_000_000_000) + 1;
      return { t: fixedIdentity.counter, d: deviceId };
    },
    async flush() {},
  };
}

// [SYNCV3 / STAGE-03B / SAME-DEVICE-WRITER-COORDINATION]
// [WHY: every tab of an origin shares ONE IndexedDB and ONE Web Locks namespace,
//  so the fixture gives them one of each. An earlier version installed a fresh
//  fake IndexedDB per tab, which quietly made each tab its own browser - and hid
//  the very interleaving this file exists to test, because the "tabs" could not
//  reach each other's storage at all. Two ProfileStores over one database is
//  what two tabs actually are.]
function makeOrigin() {
  const env = installFakeIndexedDB();
  return { env, idb: globalThis.indexedDB, namespace: createLockNamespace() };
}

function rowsOf(origin) {
  const db = origin.env.databases.get("loop-browser-gallery-profile-sync");
  const store = db ? db.stores.get("sync") : null;
  return store ? store.rows : new Map();
}

async function makeTab(origin, { deviceId = SHARED_DEVICE_ID } = {}) {
  globalThis.indexedDB = origin.idb;
  const identity = fixedIdentity(deviceId);
  const store = new ProfileStore({ identity, associationStore: Store.V3_ASSOCIATION_STORE });
  await settle();
  await store.whenFactsSettled();
  await store.whenAssociationsSettled();
  const locks = createFakeLockManager(origin.namespace);
  // [SYNCV3 / STAGE-03B-FIX / DUAL-WRITER-DIAGNOSIS]
  // [WHY: ONE lease per tab, created here and reused by every pass that tab
  //  runs - mirroring ProfileSync, which holds one for the tab's lifetime. A
  //  fixture that built a lease per pass would reproduce the very bug this file
  //  now guards against and call it a pass.]
  const lease = Policy.createV3WriterLease({ deviceId, locks });
  leasesToRelease.push(lease);
  return { origin, env: origin.env, identity, store, locks, lease, deviceId };
}

/** Runs one V3 pass for a tab, against the shared lock namespace. */
function passFor(tab, dir, state = tab.state || (tab.state = {})) {
  return runSyncV3Pass({ profileStore: tab.store, dirHandle: dir.handle, state, writerLease: tab.lease });
}

function v3Files(dir) {
  return Object.keys(dir.snapshotFiles()).sort();
}

function deviceDirectories(dir) {
  const prefix = `${Transport.ROOT_DIR_NAME}/${Transport.DEVICES_DIR_NAME}/`;
  return [...new Set(Object.keys(dir.snapshotFiles()).filter((p) => p.startsWith(prefix)).map((p) => p.split("/")[2]))].sort();
}

function fact(value, t = 5_000_000_000_000, d = "dev-peer") {
  return { v: value, t, d };
}

async function publishPeer(dir, { deviceId, label, replica }) {
  const root = await Transport.getSyncV3Root(dir.handle, { create: true });
  const devicesDir = await Transport.getDevicesDir(root, { create: true });
  return Transport.publishOwnReplicaVerified(devicesDir, { deviceId, label, replica });
}

// ============================================================================

console.log("SyncV3 Stage 03B - same-device writer coordination");

// ---- Lease mechanics (1, 2, 8, 9, 13, 14, 15) ------------------------------

await test("Two tabs share one deviceId and contend for ONE lock (req 1, 2, 13)", async () => {
  const origin = makeOrigin();
  const tabA = await makeTab(origin);
  const tabB = await makeTab(origin);

  assertEqual(tabA.deviceId, tabB.deviceId, "both tabs report the SAME full deviceId (req 1)");
  assertEqual(tabA.lease.lockName, tabB.lease.lockName, "and therefore the same lock name (req 13)");
  assert(tabA.lease.lockName.includes(SHARED_DEVICE_ID), "the lock name carries the FULL deviceId");

  const a = await tabA.lease.ensure();
  const b = await tabB.lease.ensure();

  assertEqual(a.allowed, true, "exactly one tab holds the lease (req 2)");
  assertEqual(b.allowed, false, "the other is refused");
  assertEqual(b.reason, Policy.WRITE_BLOCKED_LEASE_HELD_ELSEWHERE, "with a reason it can render");
  assertEqual(tabA.lease.held, true, "tab A owns the writer role");
  assertEqual(tabB.lease.held, false, "tab B does not");
});

// [SYNCV3 / STAGE-03B-FIX / DUAL-WRITER-DIAGNOSIS]
// [WHY: THE regression. The original implementation acquired the lock inside a
//  pass and released it on the way out, so two tabs polling three seconds apart
//  never overlapped, both were granted the lease every time, and both published -
//  each overwriting the other's generation. Every earlier test ran the two passes
//  CONCURRENTLY and therefore passed while the bug was live. This one runs them
//  strictly sequentially, which is what real polling produces.]
await test("REGRESSION: sequential, non-overlapping passes do NOT both write", async () => {
  const dir = createVirtualDirectory("V3 Sync");
  const origin = makeOrigin();
  const tabA = await makeTab(origin);
  const tabB = await makeTab(origin);

  const wroteA = [];
  const wroteB = [];
  for (let round = 1; round <= 3; round++) {
    tabA.store.setFavorite(`a-${round}.mp4`, true);
    await tabA.store.whenFactsSettled();
    wroteA.push((await passFor(tabA, dir)).published);

    tabB.store.setFavorite(`b-${round}.mp4`, true);
    await tabB.store.whenFactsSettled();
    wroteB.push((await passFor(tabB, dir)).published);
  }

  assertEqual(wroteB.some(Boolean), false, "the reader tab NEVER published across three rounds");
  assertEqual(wroteA.every(Boolean), true, "the writer tab published on every round");
  assertEqual(tabA.lease.held, true, "the writer still holds the lease BETWEEN passes");
  assertEqual(tabB.lease.held, false, "and the reader never acquired it");

  // The published subtree reflects one tab consistently, not a flip-flop.
  const published = JSON.stringify(dir.snapshotFiles());
  assert(published.includes("a-3.mp4"), "the writer's latest change is published");
  assert(!published.includes("b-3.mp4"), "the reader's change did not overwrite it");
  assertEqual(deviceDirectories(dir).length, 1, "one device directory throughout");
});

await test("A failed pass KEEPS the lease; release() gives it up (req 9, 11)", async () => {
  const origin = makeOrigin();
  const tab = await makeTab(origin);
  const other = await makeTab(origin);

  assertEqual((await tab.lease.ensure()).allowed, true, "the tab takes the lease");

  // [SYNCV3 / STAGE-03B-FIX / DUAL-WRITER-DIAGNOSIS]
  // [WHY: the semantics INVERTED with the fix and the test says so. Under the
  //  per-pass lease, releasing on failure was the safety property. Under a
  //  sustained lease it is the hazard: handing the role to another tab because
  //  of one transient Drive error is exactly what produces the alternating
  //  publishes this fix removes. A failure must leave the role where it is.]
  const restore = muteConsole();
  let threw = false;
  try {
    await runSyncV3Pass({
      profileStore: {
        whenFactsSettled: async () => {},
        getDeviceId: () => tab.deviceId,
        getFullReplica: async () => {
          throw new Error("pass exploded");
        },
        observePeerReplica: async () => {},
        adoptMergedReplica: async () => {},
      },
      dirHandle: createVirtualDirectory("V3 Sync").handle,
      state: {},
      writerLease: tab.lease,
    });
  } catch {
    threw = true;
  }
  restore();

  assert(threw, "the pass genuinely failed");
  assertEqual(tab.lease.held, true, "the lease is RETAINED across a failed pass");
  assertEqual((await other.lease.ensure()).allowed, false, "so no other tab can take over on a transient error");

  tab.lease.release();
  assertEqual(tab.lease.held, false, "release() gives the role up");
  // Releasing a Web Lock settles asynchronously - the holder's callback promise
  // has to resolve before the name is free. Real tabs poll seconds apart, so
  // this gap only matters to a test that retries immediately.
  await settle(2);
  assertEqual((await other.lease.ensure()).allowed, true, "and the next tab can take it (req 10, 11)");
});

await test("Different deviceIds use different locks and write concurrently (req 14)", async () => {
  const origin = makeOrigin();
  const one = await makeTab(origin, { deviceId: SHARED_DEVICE_ID });
  const two = await makeTab(origin, { deviceId: OTHER_DEVICE_ID });

  assert(one.lease.lockName !== two.lease.lockName, "two devices compute different lock names");
  assertEqual((await one.lease.ensure()).allowed, true, "device one holds its own lease");
  assertEqual((await two.lease.ensure()).allowed, true, "a DIFFERENT device is not blocked by it (req 14)");
});

await test("No Web Locks means read-only, never an uncoordinated write (req 15)", async () => {
  const dir = createVirtualDirectory("V3 Sync");
  const origin = makeOrigin();
  const tab = await makeTab(origin);
  const lease = Policy.createV3WriterLease({ deviceId: tab.deviceId, locks: null });

  const result = await runSyncV3Pass({
    profileStore: tab.store,
    dirHandle: dir.handle,
    state: {},
    writerLease: lease,
  });

  assertEqual(result.published, false, "nothing published without Web Locks (req 15)");
  assertEqual(result.publishBlocked, Policy.WRITE_BLOCKED_NO_WEB_LOCKS, "and the reason is truthful");
  assertEqual(JSON.stringify(v3Files(dir)), "[]", "sync-v3/ was not even created");
});

await test("A pass with NO lease at all fails closed", async () => {
  const dir = createVirtualDirectory("V3 Sync");
  const origin = makeOrigin();
  const tab = await makeTab(origin);

  const result = await runSyncV3Pass({ profileStore: tab.store, dirHandle: dir.handle, state: {} });

  assertEqual(result.published, false, "omitting the lease never grants a write");
  assertEqual(JSON.stringify(v3Files(dir)), "[]", "and nothing was created");
});

await test("Writer publishes; reader writes NOTHING but still merges (req 3, 4, 5, 6)", async () => {
  const dir = createVirtualDirectory("V3 Sync");
  const origin = makeOrigin();
  const writer = await makeTab(origin);
  const reader = await makeTab(origin);

  await publishPeer(dir, {
    deviceId: OTHER_DEVICE_ID,
    label: "Windows",
    replica: {
      schemaVersion: 3,
      profiles: { "93bc1a7d-beast": { name: fact("BEAST"), items: {}, tags: {} } },
      associations: { "lib-shared": fact("93bc1a7d-beast") },
    },
  });

  const writerResult = await passFor(writer, dir);
  assertEqual(writerResult.published, true, "the writer published (req 3)");

  // The reader has something of its own to say, so the refusal path is genuinely
  // exercised rather than short-circuiting on "already published".
  reader.store.setFavorite("reader-only-change.mp4", true);
  await reader.store.whenFactsSettled();

  const filesBeforeReader = JSON.stringify(v3Files(dir));
  const readerResult = await passFor(reader, dir);
  const filesAfterReader = JSON.stringify(v3Files(dir));

  assertEqual(readerResult.published, false, "the reader published nothing (req 4)");
  assertEqual(
    readerResult.publishBlocked,
    Policy.WRITE_BLOCKED_LEASE_HELD_ELSEWHERE,
    "and reports the lease as held elsewhere"
  );
  assertEqual(filesAfterReader, filesBeforeReader, "the reader made ZERO Drive changes (req 4, req 12)");
  assertEqual(readerResult.removedProfileFiles, undefined, "and ran no cleanup (req 7)");

  assertEqual(readerResult.mergedPeers, 1, "the reader still merged the peer (req 5)");
  const materialized = reader.store.listProfiles().find((entry) => entry.id === "93bc1a7d-beast");
  assert(Boolean(materialized), "the peer's Profile materialized in the READER tab (req 5)");
  assertEqual(reader.store.listAssociations()["lib-shared"], "93bc1a7d-beast", "and its association projected");
  assertEqual(deviceDirectories(dir).length, 2, "exactly two device directories: this device and the peer");
});

await test("A reader never creates sync-v3/ on an untouched folder (req 6)", async () => {
  const dir = createVirtualDirectory("V3 Sync");
  const origin = makeOrigin();
  const holder = await makeTab(origin);
  const reader = await makeTab(origin);

  assertEqual((await holder.lease.ensure()).allowed, true, "another tab holds the lease");

  const result = await passFor(reader, dir);

  assertEqual(result.rootMissing, true, "the reader reports that no V3 tree exists");
  assertEqual(JSON.stringify(v3Files(dir)), "[]", "and created nothing (req 6)");
  assertEqual(result.publishBlocked, Policy.WRITE_BLOCKED_LEASE_HELD_ELSEWHERE, "for the right reason");
});

await test("After the writer releases, another tab takes over on its next pass (req 10)", async () => {
  const dir = createVirtualDirectory("V3 Sync");
  const origin = makeOrigin();
  const tabA = await makeTab(origin);
  const tabB = await makeTab(origin);

  const first = await passFor(tabA, dir);
  assertEqual(first.published, true, "tab A published first");
  const directoryAfterA = deviceDirectories(dir).join(",");

  const blocked = await passFor(tabB, dir);
  assertEqual(blocked.published, false, "tab B is a reader while A holds the lease");

  // Tab A closes.
  tabA.lease.release();

  tabB.store.setFavorite("from-tab-b.mp4", true);
  await tabB.store.whenFactsSettled();
  const second = await passFor(tabB, dir);

  assertEqual(second.published, true, "tab B became the writer on its next pass (req 10)");
  assertEqual(tabB.lease.held, true, "and now holds the lease itself");
  assertEqual(deviceDirectories(dir).join(","), directoryAfterA, "publishing into the SAME device directory");
  assertEqual(deviceDirectories(dir).length, 1, "no duplicate own-device directory appeared");
  assert(JSON.stringify(dir.snapshotFiles()).includes("from-tab-b.mp4"), "tab B's change reached Drive");
});

await test("Two tabs cannot run own cleanup concurrently (req 7, 12)", async () => {
  const dir = createVirtualDirectory("V3 Sync");
  const origin = makeOrigin();
  const tabA = await makeTab(origin);
  const tabB = await makeTab(origin);

  await tabA.store.createProfile("BEAST");
  await tabA.store.whenFactsSettled();
  await settle();
  const seeded = await passFor(tabA, dir);
  assertEqual(seeded.published, true, "a two-Profile generation is published");
  const profileFilesBefore = Object.keys(dir.snapshotFiles()).filter((p) => p.includes("/profiles/")).length;
  assert(profileFilesBefore >= 2, `the seeded generation has ${profileFilesBefore} Profile files`);

  // Tab B runs a full pass while A holds the lease across passes.
  tabB.store.setFavorite("b-change.mp4", true);
  await tabB.store.whenFactsSettled();
  const bResult = await passFor(tabB, dir);

  assertEqual(bResult.published, false, "tab B did not publish (req 12)");
  assertEqual(bResult.removedProfileFiles, undefined, "tab B ran no cleanup at all (req 7)");
  const profileFilesAfter = Object.keys(dir.snapshotFiles()).filter((p) => p.includes("/profiles/")).length;
  assertEqual(profileFilesAfter, profileFilesBefore, "no Profile file was destroyed by the concurrent pass");

  const read = await Transport.readDeviceDirectory(
    await Transport.getDevicesDir(await Transport.getSyncV3Root(dir.handle), {}),
    deviceDirectories(dir)[0]
  );
  assertEqual(read.status, "valid", "the device directory is still a valid, complete generation");
});

// ---- Live engine behaviour (16, 17, 18) ------------------------------------

await test("On a reader tab, Profile edits and syncNow do not publish (req 16, 17, 18)", async () => {
  const dir = createVirtualDirectory("V3 Sync");
  const origin = makeOrigin();

  // [SYNCV3 / STAGE-03B / SAME-DEVICE-WRITER-COORDINATION]
  // [WHY: the live engine reaches the seam through its DEFAULT, which is the real
  //  Web Locks manager - so "another tab" has to hold the real lock, not a fake
  //  one, or the engine would never see it taken and the test would prove
  //  nothing. Node exposes navigator.locks; where it does not, the engine fails
  //  closed and the same assertion still holds, which is why this is written to
  //  pass either way rather than skipped.]
  const lockName = Policy.writerLockName(SHARED_DEVICE_ID);
  const realLocks = typeof navigator !== "undefined" && navigator ? navigator.locks : null;
  let release = () => {};
  let holding = Promise.resolve();
  if (realLocks) {
    const held = new Promise((resolve) => {
      release = resolve;
    });
    holding = realLocks.request(lockName, { ifAvailable: true }, async () => held);
    await settle(2);
  }

  const identity = fixedIdentity(SHARED_DEVICE_ID);
  const store = new ProfileStore({ identity });
  await settle();
  await store.whenFactsSettled();
  const sync = new ProfileSync(store);
  liveInstances.push(sync);

  await sync.connectV3Folder(dir.handle);
  await settle();
  await sync.activateSyncV3();
  await settle();
  assertEqual(sync.getStatus().mode, "v3", "the engine is in V3 mode");
  assertEqual(sync.getStatus().associationStoreId, "associations-v3", "using the V3 association row");

  // Sync Now on a tab that is not the writer.
  await sync.syncNow();
  await settle();
  assertEqual(JSON.stringify(v3Files(dir)), "[]", "syncNow on a reader published nothing (req 17)");

  // A Profile edit, waited out past the auto-sync debounce.
  store.setFavorite("reader-edit.mp4", true);
  await store.whenFactsSettled();
  await new Promise((resolve) => setTimeout(resolve, 3600));
  await settle();
  assertEqual(JSON.stringify(v3Files(dir)), "[]", "a debounced Profile edit published nothing (req 16)");

  const status = sync.getStatus();
  assertEqual(status.v3LiveWritesEnabled, true, "live writes are enabled - the tab is a reader by lease, not by switch");
  assert(
    status.v3PublishBlocked === Policy.WRITE_BLOCKED_LEASE_HELD_ELSEWHERE ||
      status.v3PublishBlocked === Policy.WRITE_BLOCKED_NO_WEB_LOCKS,
    `the reason is a coordination one: ${status.v3PublishBlocked}`
  );

  // [SYNCV3 / STAGE-03B / SAME-DEVICE-WRITER-COORDINATION]
  // [WHY: a reader KEEPS polling (req 18). It is how it learns about peers at
  //  all; a reader that stopped would be frozen at whatever it knew when it lost
  //  the lease, which is the "only one tab works" outcome this stage avoids.]
  assertEqual(sync.getStatus().mode, "v3", "the reader tab is still live and scheduling passes");

  release();
  await holding;
  assert(Boolean(origin), "origin fixture wired");
});

// ---- Association boot window (19, 20, 21, 22) ------------------------------

await test("Association writes are blocked until the store is named (req 19, 20)", async () => {
  const origin = makeOrigin();
  const identity = fixedIdentity(SHARED_DEVICE_ID);
  const store = new ProfileStore({ identity });
  await settle();
  await store.whenFactsSettled();

  // ProfileSync's constructor closes the gate synchronously. Simulated here by
  // calling the same method, which is what it calls.
  store.deferAssociationStore();
  assertEqual(store.isAssociationStorePending(), true, "the association gate is closed (req 19)");

  // An association write issued during the gap must not resolve yet.
  let settledEarly = false;
  const pending = store
    .adoptMergedReplica({ schemaVersion: 3, profiles: {}, associations: { lib: fact("p1", 10, "dev-x") } })
    .then(() => {
      settledEarly = true;
    });
  await settle(6);
  assertEqual(settledEarly, false, "the association write is HELD, not applied to a guessed row (req 19)");

  const rows = rowsOf(origin);
  assertEqual(rows.get("associations"), undefined, "no V2 association row was created (req 20)");

  // Naming the V3 row releases it.
  await store.setAssociationStore(Store.V3_ASSOCIATION_STORE);
  await pending;
  await settle();

  assertEqual(store.isAssociationStorePending(), false, "the gate is open once the row is named");
  assertEqual(store.getAssociationStoreId(), "associations-v3", "and it is the V3 row");
  assert(Boolean(rows.get("associations-v3")), "the association landed in associations-v3 (req 20)");
  assertEqual(rows.get("associations"), undefined, "and never in the V2 row");
});

await test("A V1/V2 boot still resolves to the V2 row and never deadlocks (req 21)", async () => {
  const origin = makeOrigin();
  const identity = fixedIdentity(SHARED_DEVICE_ID);
  const store = new ProfileStore({ identity });
  await settle();
  await store.whenFactsSettled();
  const sync = new ProfileSync(store);
  liveInstances.push(sync);

  await sync.init();
  await settle();

  assertEqual(sync.getStatus().mode, "v1", "a fresh installation is V1");
  assertEqual(store.isAssociationStorePending(), false, "the gate opened rather than deadlocking (req 21)");
  assertEqual(store.getAssociationStoreId(), "associations", "resolved to the V2 association row");

  await store.adoptMergedReplica({ schemaVersion: 2, profiles: {}, associations: { lib: fact("p-v2", 10, "dev-x") } });
  await settle();
  const rows = rowsOf(origin);
  assert(Boolean(rows.get("associations")), "a V2 installation writes the V2 row, unchanged");
  assertEqual(rows.get("associations-v3"), undefined, "and never touches V3's");
});

await test("V2 -> V3 -> V2 still preserves both caches (req 22)", async () => {
  const origin = makeOrigin();
  const identity = fixedIdentity(SHARED_DEVICE_ID);
  const store = new ProfileStore({ identity });
  await settle();
  await store.whenFactsSettled();
  store.deferAssociationStore();
  await store.setAssociationStore(Store.V2_ASSOCIATION_STORE);

  await store.adoptMergedReplica({ schemaVersion: 2, profiles: {}, associations: { "lib-v2": fact("p-v2", 10, "d") } });
  await settle();
  const rows = rowsOf(origin);
  const v2Snapshot = JSON.stringify(rows.get("associations"));

  await store.setAssociationStore(Store.V3_ASSOCIATION_STORE);
  await store.adoptMergedReplica({ schemaVersion: 3, profiles: {}, associations: { "lib-v3": fact("p-v3", 20, "d") } });
  await settle();
  const v3Snapshot = JSON.stringify(rows.get("associations-v3"));

  await store.setAssociationStore(Store.V2_ASSOCIATION_STORE);
  await settle();

  assertEqual(store.listAssociations()["lib-v2"], "p-v2", "V2's association survived");
  assertEqual(store.listAssociations()["lib-v3"], undefined, "V3's did not follow it back");
  assertEqual(JSON.stringify(rows.get("associations")), v2Snapshot, "the V2 row is byte-identical (req 22)");
  assertEqual(JSON.stringify(rows.get("associations-v3")), v3Snapshot, "the V3 row is byte-identical (req 22)");
});

// ---- First live shape (23, 24) ---------------------------------------------

await test("The first live pass produces the Stage 02 readable shape (req 23)", async () => {
  const dir = createVirtualDirectory("V3 Sync");
  const origin = makeOrigin();
  const tab = await makeTab(origin);
  await tab.store.createProfile("BEAST");
  await tab.store.whenFactsSettled();
  await settle();

  const result = await passFor(tab, dir);
  assertEqual(result.published, true, "the first live pass publishes");

  const files = v3Files(dir);
  const dirs = deviceDirectories(dir);
  assertEqual(dirs.length, 1, "one device directory");
  assert(/^Chromebook -- a31f2c4e$/.test(dirs[0]), `readable device directory: "${dirs[0]}"`);
  assert(
    files.some((p) => p === `sync-v3/devices/${dirs[0]}/device.json`),
    "device.json at the commit point"
  );
  assert(
    files.some((p) => p === `sync-v3/devices/${dirs[0]}/associations.json`),
    "associations.json alongside it"
  );
  assert(
    files.some((p) => /\/profiles\/BEAST -- [0-9a-f]{8}\.json$/.test(p)),
    `readable Profile filename among: ${files.filter((p) => p.includes("/profiles/")).join(", ")}`
  );
  assert(
    !files.some((p) => p.includes("beebeegees")),
    "no Library-named entries were invented - that is Stage 04"
  );

  const manifest = JSON.parse(dir.readFile(`sync-v3/devices/${dirs[0]}/device.json`));
  assertEqual(manifest.deviceId, SHARED_DEVICE_ID, "the FULL deviceId lives in content, not the name");
});

await test("A second unchanged pass does not churn (req 24)", async () => {
  const dir = createVirtualDirectory("V3 Sync");
  const origin = makeOrigin();
  const tab = await makeTab(origin);

  const first = await passFor(tab, dir);
  assertEqual(first.published, true, "first pass publishes");
  const after = JSON.stringify(dir.snapshotFiles());

  const second = await passFor(tab, dir);
  assertEqual(second.published, false, "an unchanged second pass republishes nothing (req 24)");
  assertEqual(second.adopted, false, "and adopts nothing");
  assertEqual(JSON.stringify(dir.snapshotFiles()), after, "the Drive tree is byte-identical");

  const third = await passFor(tab, dir);
  assertEqual(third.published, false, "and a third pass is still quiet");
  assertEqual(deviceDirectories(dir).length, 1, "with no directory churn");
});

// ---- Summary ---------------------------------------------------------------

console.log(`\n${"-".repeat(60)}`);
if (failures === 0) {
  console.log(`ok    ${passes} assertion(s) passed - SyncV3 Stage 03B holds.`);
} else {
  console.log(`FAIL  ${failures} failure(s), ${passes} passed:`);
  for (const detail of failureDetail) console.log(`  - ${detail}`);
}
process.exit(failures === 0 ? 0 : 1);
