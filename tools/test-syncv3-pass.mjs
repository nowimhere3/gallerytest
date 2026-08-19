#!/usr/bin/env node
// [SYNCV3 / STAGE-03A / V3-ASSOCIATION-ISOLATION-AND-PASS-SKELETON]
// [WHY: this stage's two promises are both invisible in a browser until they
//  have already caused harm. "V3 never touches the dormant V2 association cache"
//  looks like nothing at all until somebody leaves V3 and finds their Library
//  associations rewritten. "V3 publishes nothing yet" looks like nothing at all
//  until a second tab has already corrupted a device directory. Both are
//  asserted here against raw persisted rows and against the real virtual Drive
//  tree, not against the engine's own account of itself.]
//
// Usage:  node tools/test-syncv3-pass.mjs

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
const { runSyncV3Pass } = await import(src("profile/sync-v3.js"));
const Transport = await import(src("profile/sync-v3-transport.js"));
const Store = await import(src("storage/profile-sync-store.js"));
const WritePolicy = await import(src("profile/sync-v3-write-policy.js"));

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
  }
}

// ---- Raw-row inspection ----------------------------------------------------

const SYNC_DB = "loop-browser-gallery-profile-sync";
const SYNC_STORE = "sync";

function rawRow(env, id) {
  const db = env.databases.get(SYNC_DB);
  if (!db) return undefined;
  const store = db.stores.get(SYNC_STORE);
  if (!store) return undefined;
  return store.rows.get(id);
}

function rowFingerprint(env, id) {
  const row = rawRow(env, id);
  if (row === undefined) return "<absent>";
  return JSON.stringify(row, (key, value) => {
    if (key === "handle" && value && typeof value === "object") return `<handle:${value.name}>`;
    return value;
  });
}

// ---- Fixtures --------------------------------------------------------------

async function makeInstallation({ associationStore } = {}) {
  const env = installFakeIndexedDB();
  const identity = new SyncIdentity();
  await identity.ready;
  const store = new ProfileStore(associationStore ? { identity, associationStore } : { identity });
  await settle();
  await store.whenFactsSettled();
  await store.whenAssociationsSettled();
  return { env, identity, store };
}

const ALLOW = async () => ({ allowed: true, reason: null });
const REFUSE = async () => ({ allowed: false, reason: "test-refusal" });

/** Publishes a peer device's generation directly through the transport. */
async function publishPeer(dir, { deviceId, label, replica }) {
  const root = await Transport.getSyncV3Root(dir.handle, { create: true });
  const devicesDir = await Transport.getDevicesDir(root, { create: true });
  return Transport.publishOwnReplicaVerified(devicesDir, { deviceId, label, replica });
}

function fact(value, t = 5_000_000_000_000, d = "dev-peer") {
  return { v: value, t, d };
}

function v3Files(dir) {
  return Object.keys(dir.snapshotFiles()).sort();
}

// ============================================================================

console.log("SyncV3 Stage 03A - association isolation + pass skeleton");

// ---- Association isolation (1-4) -------------------------------------------

await test("V3 associations persist ONLY in associations-v3 (req 1, 2)", async () => {
  const install = await makeInstallation();

  // Seed a V2-era association through the default (V2) adapter.
  await Store.saveAssociationsCache({ "lib-v2": fact("profile-v2", 10, "dev-a") });
  const v2Before = rowFingerprint(install.env, "associations");
  assert(v2Before !== "<absent>", "a V2 association row exists to protect");

  await install.store.setAssociationStore(Store.V3_ASSOCIATION_STORE);
  assertEqual(install.store.getAssociationStoreId(), "associations-v3", "the store is now backed by associations-v3");

  // A V3-mode adoption writes association facts.
  await install.store.adoptMergedReplica({
    schemaVersion: 3,
    profiles: {},
    associations: { "lib-v3": fact("profile-v3", 20, "dev-b") },
  });
  await settle();

  const v3Row = rawRow(install.env, "associations-v3");
  assert(Boolean(v3Row), "the V3 association row was written (req 2)");
  assertEqual(Object.keys(v3Row.associations).join(","), "lib-v3", "and holds only V3's entry");

  assertEqual(rowFingerprint(install.env, "associations"), v2Before, "the V2 association row is byte-identical (req 1)");
  assertEqual(install.store.listAssociations()["lib-v3"], "profile-v3", "the V3 association projects correctly");
  assertEqual(install.store.listAssociations()["lib-v2"], undefined, "V2's association is not visible in V3 mode");
});

await test("Switching V2 -> V3 -> V2 preserves each mode's cache (req 4)", async () => {
  const install = await makeInstallation();

  await install.store.adoptMergedReplica({
    schemaVersion: 2,
    profiles: {},
    associations: { "lib-v2": fact("profile-v2", 10, "dev-a") },
  });
  await settle();
  const v2Snapshot = rowFingerprint(install.env, "associations");

  await install.store.setAssociationStore(Store.V3_ASSOCIATION_STORE);
  assertEqual(Object.keys(install.store.getAssociations()).length, 0, "switching to V3 starts from V3's own (empty) cache");

  await install.store.adoptMergedReplica({
    schemaVersion: 3,
    profiles: {},
    associations: { "lib-v3": fact("profile-v3", 20, "dev-b") },
  });
  await settle();
  const v3Snapshot = rowFingerprint(install.env, "associations-v3");

  await install.store.setAssociationStore(Store.V2_ASSOCIATION_STORE);
  assertEqual(install.store.getAssociationStoreId(), "associations", "back on the V2 cache");
  assertEqual(install.store.listAssociations()["lib-v2"], "profile-v2", "V2's association survived the round trip");
  assertEqual(install.store.listAssociations()["lib-v3"], undefined, "V3's association did not follow it back");

  assertEqual(rowFingerprint(install.env, "associations"), v2Snapshot, "the V2 row is byte-identical after the round trip");
  assertEqual(rowFingerprint(install.env, "associations-v3"), v3Snapshot, "the V3 row is byte-identical after the round trip");
});

await test("V3 association merge/adopt semantics match V2 (req 3)", async () => {
  const install = await makeInstallation({ associationStore: Store.V3_ASSOCIATION_STORE });

  await install.store.adoptMergedReplica({
    schemaVersion: 3,
    profiles: {},
    associations: { lib: fact("profile-old", 100, "dev-a") },
  });
  await settle();
  assertEqual(install.store.listAssociations().lib, "profile-old", "the first fact is adopted");

  // Older stamp loses.
  await install.store.adoptMergedReplica({
    schemaVersion: 3,
    profiles: {},
    associations: { lib: fact("profile-stale", 50, "dev-b") },
  });
  await settle();
  assertEqual(install.store.listAssociations().lib, "profile-old", "an older stamp loses, exactly as LWW requires");

  // Newer stamp wins.
  await install.store.adoptMergedReplica({
    schemaVersion: 3,
    profiles: {},
    associations: { lib: fact("profile-new", 200, "dev-b") },
  });
  await settle();
  assertEqual(install.store.listAssociations().lib, "profile-new", "a newer stamp wins");

  // An explicit null disassociation is a value, not a deletion.
  await install.store.adoptMergedReplica({
    schemaVersion: 3,
    profiles: {},
    associations: { lib: fact(null, 300, "dev-b") },
  });
  await settle();
  assertEqual(install.store.listAssociations().lib, undefined, "a null association stops projecting");
  assert(Boolean(install.store.getAssociations().lib), "but the FACT is retained so it keeps propagating");
});

// ---- The pass (5-10) -------------------------------------------------------

await test("A foreign Profile and association materialize under the V3 pass (req 5, 6)", async () => {
  const dir = createVirtualDirectory("V3 Sync");
  const install = await makeInstallation({ associationStore: Store.V3_ASSOCIATION_STORE });

  await publishPeer(dir, {
    deviceId: "dev-90a84b71-peer",
    label: "Windows",
    replica: {
      schemaVersion: 3,
      profiles: { "93bc1a7d-beast": { name: fact("BEAST"), items: {}, tags: {} } },
      associations: { "lib-shared": fact("93bc1a7d-beast") },
    },
  });

  const result = await runSyncV3Pass({
    profileStore: install.store,
    dirHandle: dir.handle,
    state: {},
    mayPublish: ALLOW,
  });
  await settle();

  assertEqual(result.status, "ok", "the pass completed");
  assertEqual(result.mergedPeers, 1, "one peer was merged");

  const materialized = install.store.listProfiles().find((entry) => entry.id === "93bc1a7d-beast");
  assert(Boolean(materialized), "the foreign Profile materialized in the local registry (req 5)");
  assertEqual(materialized && materialized.name, "BEAST", "with its published name");
  assertEqual(install.store.listAssociations()["lib-shared"], "93bc1a7d-beast", "the foreign association projects (req 6)");

  // And it landed in V3's row, not V2's.
  assert(Boolean(rawRow(install.env, "associations-v3")), "the adopted association is in associations-v3");
  assertEqual(rowFingerprint(install.env, "associations"), "<absent>", "the V2 association row was never created");
});

await test("Peers are observed BEFORE any local stamping (req 7)", async () => {
  const dir = createVirtualDirectory("V3 Sync");
  const install = await makeInstallation({ associationStore: Store.V3_ASSOCIATION_STORE });

  // A peer stamped far in the future. If the pass stamped before observing it,
  // this device's next mutation would draw a LOWER stamp and lose the merge -
  // the silent "my click did nothing" failure observe-before-tick prevents.
  const FUTURE = 9_000_000_000_000;
  await publishPeer(dir, {
    deviceId: "dev-future-peer",
    label: "Windows",
    replica: {
      schemaVersion: 3,
      profiles: { "93bc1a7d-beast": { name: fact("BEAST", FUTURE, "dev-future-peer"), items: {}, tags: {} } },
      associations: {},
    },
  });

  await runSyncV3Pass({ profileStore: install.store, dirHandle: dir.handle, state: {}, mayPublish: ALLOW });
  await settle();

  // Now make a local change and confirm its stamp outranks the peer's.
  install.store.setFavorite("clip.mp4", true);
  await install.store.whenFactsSettled();
  const replica = await install.store.getFullReplica();
  const activeId = install.store.getProfileId();
  const favouriteFact = replica.profiles[activeId].items["clip.mp4"].favorite;

  assert(
    favouriteFact.t > FUTURE,
    "a local mutation after the pass outranks the peer's future stamp (req 7)",
    `local t=${favouriteFact.t} peer t=${FUTURE}`
  );
});

await test("Merge/adopt ordering matches V2, and publish-if-changed holds (req 8, 10)", async () => {
  const dir = createVirtualDirectory("V3 Sync");
  const install = await makeInstallation({ associationStore: Store.V3_ASSOCIATION_STORE });
  const state = {};

  const first = await runSyncV3Pass({ profileStore: install.store, dirHandle: dir.handle, state, mayPublish: ALLOW });
  await settle();
  assertEqual(first.status, "ok", "first pass ok");
  assertEqual(first.published, true, "the first pass publishes this device's generation");

  // Nothing changed - the second pass must NOT republish.
  const second = await runSyncV3Pass({ profileStore: install.store, dirHandle: dir.handle, state, mayPublish: ALLOW });
  await settle();
  assertEqual(second.published, false, "an unchanged second pass publishes nothing (req 10)");
  assertEqual(second.adopted, false, "and adopts nothing");

  // A real local change must publish again.
  install.store.setFavorite("clip.mp4", true);
  await install.store.whenFactsSettled();
  const third = await runSyncV3Pass({ profileStore: install.store, dirHandle: dir.handle, state, mayPublish: ALLOW });
  await settle();
  assertEqual(third.published, true, "a genuine local change publishes");

  // The published generation is readable and carries the change.
  const files = JSON.stringify(dir.snapshotFiles());
  assert(files.includes("clip.mp4"), "the published bytes contain the local change");
  assert(files.includes("sync-v3/devices/"), "published under the V3 root");
});

await test("OWN_GENERATION_SETTLE_PASSES behaviour is carried over (req 9)", async () => {
  const dir = createVirtualDirectory("V3 Sync");
  const install = await makeInstallation({ associationStore: Store.V3_ASSOCIATION_STORE });
  const state = {};

  const published = await runSyncV3Pass({ profileStore: install.store, dirHandle: dir.handle, state, mayPublish: ALLOW });
  await settle();
  assertEqual(published.published, true, "a generation is published");
  assert(Boolean(state.lastPublishedCanonical), "the pass remembers what it published");

  // Make our own generation unreadable, as a mid-propagation Drive read does.
  const own = published.directoryName;
  dir.removeFile(`sync-v3/devices/${own}/device.json`);

  const restore = muteConsole();
  const settling = await runSyncV3Pass({ profileStore: install.store, dirHandle: dir.handle, state, mayPublish: ALLOW });
  restore();
  await settle();

  assertEqual(settling.published, false, "the pass WAITS instead of rewriting (req 9)");
  assertEqual(settling.ownGenerationSettling, 1, "and counts the settle pass");
  assertEqual(state.ownSettlingPasses, 1, "the counter is carried on the pass state");

  // Bounded: after the cap it republishes once rather than waiting forever.
  state.ownSettlingPasses = 9;
  const restore2 = muteConsole();
  const escaped = await runSyncV3Pass({ profileStore: install.store, dirHandle: dir.handle, state, mayPublish: ALLOW });
  restore2();
  await settle();
  assertEqual(escaped.published, true, "the bounded escape republishes once");
  assertEqual(state.ownSettlingPasses, 0, "and resets the counter");
});

// ---- Live-write safety switch (11, 12) -------------------------------------

await test("The shipped write policy refuses (req 11)", async () => {
  assertEqual(WritePolicy.V3_LIVE_WRITES_ENABLED, false, "live V3 writes are DISABLED in this stage");
  const decision = await WritePolicy.mayPublishV3({ deviceId: "dev-anything" });
  assertEqual(decision.allowed, false, "the real policy refuses");
  assertEqual(decision.reason, WritePolicy.WRITE_BLOCKED_LIVE_WRITES_DISABLED, "with a reason a status surface can render");
});

await test("With writes refused, a pass reads and adopts but writes NOTHING (req 11, 12)", async () => {
  const dir = createVirtualDirectory("V3 Sync");
  const install = await makeInstallation({ associationStore: Store.V3_ASSOCIATION_STORE });

  await publishPeer(dir, {
    deviceId: "dev-90a84b71-peer",
    label: "Windows",
    replica: {
      schemaVersion: 3,
      profiles: { "93bc1a7d-beast": { name: fact("BEAST"), items: {}, tags: {} } },
      associations: { "lib-shared": fact("93bc1a7d-beast") },
    },
  });
  const before = JSON.stringify(v3Files(dir));

  const result = await runSyncV3Pass({
    profileStore: install.store,
    dirHandle: dir.handle,
    state: {},
    mayPublish: REFUSE,
  });
  await settle();

  assertEqual(result.status, "ok", "the pass completes cleanly");
  assertEqual(result.published, false, "nothing was published");
  assertEqual(result.publishBlocked, "test-refusal", "the refusal is reported, not swallowed (req 12)");
  assertEqual(result.mergedPeers, 1, "the peer was still read and merged");
  assertEqual(JSON.stringify(v3Files(dir)), before, "the Drive tree is byte-for-byte unchanged (req 11)");

  // Reading and adopting still happened - this is a useful pass, not a no-op.
  const materialized = install.store.listProfiles().find((entry) => entry.id === "93bc1a7d-beast");
  assert(Boolean(materialized), "the peer's Profile still materialized locally");
});

await test("With writes refused, an EMPTY V3 folder is not even created (req 11)", async () => {
  const dir = createVirtualDirectory("V3 Sync");
  const install = await makeInstallation({ associationStore: Store.V3_ASSOCIATION_STORE });

  const result = await runSyncV3Pass({
    profileStore: install.store,
    dirHandle: dir.handle,
    state: {},
    mayPublish: REFUSE,
  });
  await settle();

  assertEqual(result.status, "ok", "an untouched folder is an ordinary state, not a fault");
  assertEqual(result.rootMissing, true, "the pass reports that no sync-v3 tree exists");
  assertEqual(JSON.stringify(v3Files(dir)), "[]", "sync-v3/ was NOT created (req 11)");
  assertEqual(result.publishBlocked, "test-refusal", "and the refusal is reported");
});

await test("A pass with NO mayPublish supplied defaults to refusing", async () => {
  const dir = createVirtualDirectory("V3 Sync");
  const install = await makeInstallation({ associationStore: Store.V3_ASSOCIATION_STORE });

  // Deliberately omits mayPublish: a caller must not be able to opt OUT of the
  // seam by forgetting it.
  const result = await runSyncV3Pass({ profileStore: install.store, dirHandle: dir.handle, state: {} });
  await settle();

  assertEqual(result.published, false, "the default is to refuse, never to allow");
  assertEqual(result.publishBlocked, WritePolicy.WRITE_BLOCKED_LIVE_WRITES_DISABLED, "the real policy answered");
  assertEqual(JSON.stringify(v3Files(dir)), "[]", "and nothing was written");
});

// ---- Live engine integration (11) ------------------------------------------

await test("Through the live engine: syncNow, polling and Profile edits write nothing (req 11)", async () => {
  const v3Dir = createVirtualDirectory("V3 Sync");
  const install = await makeInstallation();
  const sync = new ProfileSync(install.store);
  liveInstances.push(sync);

  await sync.connectV3Folder(v3Dir.handle);
  await settle();
  await sync.activateSyncV3();
  await settle();

  assertEqual(sync.getStatus().mode, "v3", "the engine is in V3 mode");
  assertEqual(
    sync.getStatus().associationStoreId,
    "associations-v3",
    "activating V3 repointed the association cache immediately"
  );

  const before = JSON.stringify(v3Files(v3Dir));
  assertEqual(before, "[]", "the V3 folder starts empty");

  // Sync Now.
  await sync.syncNow();
  await settle();
  assertEqual(JSON.stringify(v3Files(v3Dir)), "[]", "Sync Now wrote nothing");

  // A Profile edit, waited out past the auto-sync debounce.
  install.store.setFavorite("clip.mp4", true);
  await install.store.whenFactsSettled();
  await new Promise((resolve) => setTimeout(resolve, 3600));
  await settle();
  assertEqual(JSON.stringify(v3Files(v3Dir)), "[]", "a Profile edit wrote nothing, even past the debounce");

  // And the scheduler is not armed at all while writes are off.
  assertEqual(sync.getStatus().v3LiveWritesEnabled, false, "the engine reports live writes as disabled");

  // V2's rows remain untouched throughout.
  assertEqual(rowFingerprint(install.env, "associations"), "<absent>", "no V2 association row was created by V3 mode");
});

// ---- Summary ---------------------------------------------------------------

console.log(`\n${"-".repeat(60)}`);
if (failures === 0) {
  console.log(`ok    ${passes} assertion(s) passed - SyncV3 Stage 03A holds.`);
} else {
  console.log(`FAIL  ${failures} failure(s), ${passes} passed:`);
  for (const detail of failureDetail) console.log(`  - ${detail}`);
}
process.exit(failures === 0 ? 0 : 1);
