#!/usr/bin/env node
// [SYNCV3 / STAGE-05 / DEVICE-NAMING]
// [WHY: this stage lets a user change a string that appears in a Drive DIRECTORY
//  NAME, on an installation whose entire transport was built around never
//  trusting directory names. Every failure it can introduce is quiet and
//  expensive: a rename that mints a new deviceId orphans the device's whole
//  published subtree; a peer name read by splitting a path trusts a string
//  anyone can edit; a stale-directory cleanup that runs before verification
//  deletes the only good copy. None of that surfaces in a browser until data is
//  gone, so it is proven here.]
//
// Usage:  node tools/test-syncv3-device-naming.mjs

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
const Policy = await import(src("profile/sync-v3-write-policy.js"));
const Channel = await import(src("profile/local-state-channel.js"));
const Names = await import(src("profile/sync-v3-names.js"));
const LibraryRegistry = await import(src("storage/library-registry.js"));

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

const openContexts = [];
const openLeases = [];
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
    await settle(20);
    for (const sync of liveInstances.splice(0)) {
      try {
        sync.dispose();
      } catch {
        /* gone */
      }
    }
    for (const store of openContexts.splice(0)) {
      try {
        store.closeLocalStateChannel();
      } catch {
        /* gone */
      }
    }
    for (const lease of openLeases.splice(0)) {
      try {
        lease.release();
      } catch {
        /* gone */
      }
    }
  }
}

// ---- Fixtures --------------------------------------------------------------

const DEVICE_B = "dev-90a84b71-7777-4888-8999-aaaabbbbcccc";
const LIB_1 = "178d159d-1111-4222-8333-444455556666";

let channelCounter = 0;
function makeOrigin() {
  const env = installFakeIndexedDB();
  return { env, idb: globalThis.indexedDB, channelName: `bg-name-test-${++channelCounter}` };
}

function deviceRow(origin) {
  const db = origin.env.databases.get("loop-browser-gallery-profile-sync");
  const store = db ? db.stores.get("sync") : null;
  return store ? store.rows.get("device") : undefined;
}

/**
 * A real SyncIdentity over the origin's storage. The detected label is pinned so
 * the fallback rule is testable without depending on the host's user agent.
 */
async function makeIdentity(origin, { detected = "Chromebook" } = {}) {
  globalThis.indexedDB = origin.idb;
  const identity = new SyncIdentity();
  await identity.ready;
  Object.defineProperty(identity, "label", { get: () => detected, configurable: true });
  const realDisplay = Object.getOwnPropertyDescriptor(SyncIdentity.prototype, "displayName");
  Object.defineProperty(identity, "displayName", {
    get: () => identity.deviceName || detected,
    configurable: true,
  });
  assert(Boolean(realDisplay), "SyncIdentity really does define displayName");
  return identity;
}

async function makeContext(origin, { identity, channel = "real" } = {}) {
  globalThis.indexedDB = origin.idb;
  const localStateChannel = Channel.createLocalStateChannel({
    channelName: origin.channelName,
    factory: channel === null ? null : undefined,
  });
  const store = new ProfileStore({
    identity,
    associationStore: Store.V3_ASSOCIATION_STORE,
    localStateChannel,
  });
  openContexts.push(store);
  await settle(20);
  await store.whenFactsSettled();
  await store.whenLibrariesSettled();
  return store;
}

const propagate = () => settle(60);

function deviceDirectories(dir) {
  const prefix = `${Transport.ROOT_DIR_NAME}/${Transport.DEVICES_DIR_NAME}/`;
  return [
    ...new Set(Object.keys(dir.snapshotFiles()).filter((p) => p.startsWith(prefix)).map((p) => p.split("/")[2])),
  ].sort();
}

function manifestOf(dir, directoryName) {
  return JSON.parse(dir.readFile(`sync-v3/devices/${directoryName}/device.json`));
}

async function passFor(store, dir, lease, state = {}) {
  return runSyncV3Pass({ profileStore: store, dirHandle: dir.handle, state, writerLease: lease });
}

function leaseFor(deviceId) {
  const lease = Policy.createV3WriterLease({ deviceId });
  openLeases.push(lease);
  return lease;
}

// ============================================================================

console.log("SyncV3 Stage 05 - device naming");

// ---- Persistence + fallback (1-5) ------------------------------------------

await test("Default name is the detected label; deviceId is stable (req 1, 2)", async () => {
  const origin = makeOrigin();
  const identity = await makeIdentity(origin);

  assert(Boolean(identity.deviceId), "the installation has a deviceId");
  assert(identity.deviceId.startsWith("dev-"), "in the established form");
  assertEqual(identity.deviceName, null, "no custom name has ever been set (req 2)");
  assertEqual(identity.displayName, "Chromebook", "so the detected label is the effective name (req 2)");

  const row = deviceRow(origin);
  assertEqual(row.deviceId, identity.deviceId, "the persisted id matches (req 1)");
  assertEqual(row.deviceName, undefined, "and no name was persisted just by booting");
});

await test("A custom name persists across a fresh identity, and the id does not move (req 3, 4)", async () => {
  const origin = makeOrigin();
  const identity = await makeIdentity(origin);
  const originalId = identity.deviceId;
  const originalFloor = deviceRow(origin).lastIssuedT;

  await identity.setDeviceName("Chromebook Pro");
  await settle();

  assertEqual(identity.deviceName, "Chromebook Pro", "the custom name is held");
  assertEqual(identity.displayName, "Chromebook Pro", "and is the effective name");
  assertEqual(identity.deviceId, originalId, "the deviceId did NOT change (req 4)");

  // A fresh identity over the same storage - i.e. a reload.
  const reloaded = await makeIdentity(origin);
  assertEqual(reloaded.deviceId, originalId, "the SAME deviceId after a reload (req 4)");
  assertEqual(reloaded.deviceName, "Chromebook Pro", "and the name survived (req 3)");
  assertEqual(reloaded.displayName, "Chromebook Pro", "as the effective name (req 3)");

  // [SYNCV3 / STAGE-05 / DEVICE-NAMING]
  // [WHY: the clock floor is the thing a careless whole-row write would destroy.
  //  A reset floor lets a freshly issued stamp land below facts this device has
  //  already published, which silently discards the user's next click.]
  assert(deviceRow(origin).lastIssuedT >= originalFloor, "the clock floor was not reset by renaming");
  assert(Number.isFinite(deviceRow(origin).createdAt), "and createdAt survived too");
});

await test("Clearing the custom name falls back to the detected label (req 5)", async () => {
  const origin = makeOrigin();
  const identity = await makeIdentity(origin);
  const originalId = identity.deviceId;

  await identity.setDeviceName("Living Room Chromebook");
  await settle();
  assertEqual(identity.displayName, "Living Room Chromebook", "custom name applied");

  for (const cleared of ["", "   ", null]) {
    await identity.setDeviceName(cleared);
    await settle();
    assertEqual(identity.deviceName, null, `${JSON.stringify(cleared)} clears the custom name (req 5)`);
    assertEqual(identity.displayName, "Chromebook", `and falls back to the detected label (req 5)`);
    await identity.setDeviceName("Living Room Chromebook");
    await settle();
  }

  await identity.setDeviceName("");
  await settle();
  const reloaded = await makeIdentity(origin);
  assertEqual(reloaded.deviceName, null, "the cleared state is durable (req 5)");
  assertEqual(reloaded.displayName, "Chromebook", "and still falls back after a reload (req 5)");
  assertEqual(reloaded.deviceId, originalId, "with the same deviceId throughout (req 4)");
});

// ---- device.json + Library integration (6, 7, 8) ---------------------------

await test("device.json carries the full deviceId AND the effective name (req 6)", async () => {
  const dir = createVirtualDirectory("V3 Sync");
  const origin = makeOrigin();
  const identity = await makeIdentity(origin);
  await identity.setDeviceName("Chromebook Pro");
  const store = await makeContext(origin, { identity });

  const lease = leaseFor(identity.deviceId);
  assertEqual((await lease.ensure()).allowed, true, "the writer holds the lease");
  const result = await passFor(store, dir, lease);
  await settle();

  assertEqual(result.published, true, "the pass published");
  const dirs = deviceDirectories(dir);
  assertEqual(dirs.length, 1, "one device directory");
  assert(/^Chromebook Pro -- [0-9a-f]{8}$/.test(dirs[0]), `named from the custom name: "${dirs[0]}"`);

  const manifest = manifestOf(dir, dirs[0]);
  assertEqual(manifest.deviceId, identity.deviceId, "the FULL deviceId is in device.json (req 6)");
  assertEqual(manifest.label, "Chromebook Pro", "and the effective human name (req 6)");
  assert(manifest.deviceId.length > 20, "the id is the full one, not a suffix");
});

await test("LibraryFacts.sourceDeviceId stays the FULL deviceId across a rename (req 7, 8)", async () => {
  const origin = makeOrigin();
  const identity = await makeIdentity(origin);
  const store = await makeContext(origin, { identity });

  await store.adoptMergedReplica({
    schemaVersion: 3,
    profiles: {},
    associations: {},
    libraries: {
      [LIB_1]: {
        name: { v: "beebeegees", t: 10, d: identity.deviceId },
        sourceDeviceId: { v: identity.deviceId, t: 10, d: identity.deviceId },
        lastLoadedAt: { v: 1_700_000_000_000, t: 10, d: identity.deviceId },
      },
    },
  });
  await settle();

  const before = store.getLibraries()[LIB_1].sourceDeviceId.v;
  assertEqual(before, identity.deviceId, "sourceDeviceId is the full deviceId (req 7)");

  await store.setDeviceName("Chromebook Pro");
  await settle();

  const after = store.getLibraries()[LIB_1].sourceDeviceId.v;
  assertEqual(after, identity.deviceId, "and is UNCHANGED by a rename (req 8)");
  assertEqual(after, before, "byte for byte");
  assert(after !== "Chromebook Pro", "it is emphatically not the human name (req 8)");

  // The library's own name fact is untouched too - renaming a DEVICE is not
  // renaming a LIBRARY.
  assertEqual(store.getLibraries()[LIB_1].name.v, "beebeegees", "the Library's own name is unaffected");
});

await test("recordLibraryLoaded stamps the full deviceId, never the Device Name (req 7, 8)", async () => {
  // [SYNCV3 / STAGE-05 / DEVICE-NAMING]
  // [WHY: exercises the REAL write path rather than adopting a hand-built
  //  replica. The test above proves an already-stored sourceDeviceId survives a
  //  rename; this one proves the value written in the first place is the
  //  identity and not the display name - which is the mistake that would
  //  actually be made, because at that call site both are one property access
  //  away on the same object.]
  const origin = makeOrigin();
  const identity = await makeIdentity(origin);
  const store = await makeContext(origin, { identity });

  await store.setDeviceName("Chromebook Pro");
  await settle();
  assertEqual(store.getDeviceDisplayName(), "Chromebook Pro", "a custom name is in effect");

  globalThis.indexedDB = origin.idb;
  const handle = {
    name: "beebeegees",
    kind: "directory",
    async isSameEntry(other) {
      return other === handle;
    },
  };
  const row = await LibraryRegistry.addOrUpdateLibrary(handle);
  await LibraryRegistry.linkLocalLibraryToSharedId(row.id, LIB_1);

  const shared = await store.recordLibraryLoaded(row.id, { name: "beebeegees", at: 1_700_000_000_000 });
  await settle();

  assertEqual(shared, LIB_1, "the Library was catalogued");
  const stamped = store.getLibraries()[LIB_1].sourceDeviceId.v;
  assertEqual(stamped, identity.deviceId, "sourceDeviceId is the FULL deviceId (req 7)");
  assert(stamped !== "Chromebook Pro", "and emphatically not the Device Name (req 8)");
  assert(stamped.startsWith("dev-"), "in the established identity form (req 7)");

  // The Library's own name is the FOLDER name, independent of the device name.
  assertEqual(store.getLibraries()[LIB_1].name.v, "beebeegees", "the Library name is the folder's, not the device's");
});

// ---- Directory rename via normal publish discipline (9-12) -----------------

await test("A rename republishes under a new directory and removes the old ONE (req 9, 10)", async () => {
  const dir = createVirtualDirectory("V3 Sync");
  const origin = makeOrigin();
  const identity = await makeIdentity(origin);
  const store = await makeContext(origin, { identity });
  const lease = leaseFor(identity.deviceId);
  await lease.ensure();

  const state = {};
  await passFor(store, dir, lease, state);
  await settle();
  const firstDirs = deviceDirectories(dir);
  assertEqual(firstDirs.length, 1, "one directory to begin with");
  assert(firstDirs[0].startsWith("Chromebook -- "), `under the detected label: "${firstDirs[0]}"`);
  const suffix = firstDirs[0].split(" -- ")[1];

  await store.setDeviceName("Chromebook Pro");
  await settle();

  const renamed = await passFor(store, dir, lease, state);
  await settle();

  assertEqual(renamed.published, true, "the rename published (req 9)");
  const afterDirs = deviceDirectories(dir);
  assertEqual(afterDirs.length, 1, "exactly ONE own directory afterwards (req 10)");
  assertEqual(afterDirs[0], `Chromebook Pro -- ${suffix}`, "under the new name, SAME id suffix (req 9)");
  assertEqual(renamed.removedStaleDirectories.join(","), `Chromebook -- ${suffix}`, "the old one was removed (req 10)");

  // Identity is untouched by all of it.
  assertEqual(manifestOf(dir, afterDirs[0]).deviceId, identity.deviceId, "the deviceId is unchanged");

  // And it is still ONE logical device to a peer.
  const root = await Transport.getSyncV3Root(dir.handle);
  const devicesDir = await Transport.getDevicesDir(root);
  const discovered = await Transport.discoverDevices(devicesDir, { ownDeviceId: DEVICE_B });
  assertEqual(discovered.peers.length, 1, "one logical peer after the rename");
  assertEqual(discovered.peers[0].deviceId, identity.deviceId, "identified by content, not by name");
});

await test("A FAILED publish leaves the old own directory intact (req 11)", async () => {
  let corrupt = false;
  const dir = createVirtualDirectory("V3 Sync", {
    transformWrite: (filePath, text) => (corrupt && filePath.includes("/profiles/") ? "{ sabotaged" : text),
  });
  const origin = makeOrigin();
  const identity = await makeIdentity(origin);
  const store = await makeContext(origin, { identity });
  const lease = leaseFor(identity.deviceId);
  await lease.ensure();

  const state = {};
  await passFor(store, dir, lease, state);
  await settle();
  const original = deviceDirectories(dir)[0];
  const suffix = original.split(" -- ")[1];
  const filesBefore = JSON.stringify(Object.keys(dir.snapshotFiles()).filter((p) => p.includes(original)).sort());

  await store.setDeviceName("Chromebook Pro");
  await settle();

  corrupt = true;
  const restore = muteConsole();
  const failed = await passFor(store, dir, lease, state);
  restore();
  await settle();

  assertEqual(failed.status, "verify-failed", "the rename publish failed verification (req 11)");
  assert(
    Boolean(dir.readFile(`sync-v3/devices/${original}/device.json`)),
    "the OLD valid directory still exists (req 11)"
  );
  assertEqual(
    JSON.stringify(Object.keys(dir.snapshotFiles()).filter((p) => p.includes(original)).sort()),
    filesBefore,
    "byte-for-byte intact - no cleanup ran (req 11)"
  );

  // And the retry, once healthy, completes the rename properly.
  corrupt = false;
  const recovered = await passFor(store, dir, lease, state);
  await settle();
  assertEqual(recovered.published, true, "the retry succeeds");
  assertEqual(deviceDirectories(dir).join(","), `Chromebook Pro -- ${suffix}`, "and only then is the old name gone");
});

await test("A peer directory is NEVER removed by an own rename (req 12)", async () => {
  const dir = createVirtualDirectory("V3 Sync");
  const origin = makeOrigin();
  const identity = await makeIdentity(origin);
  const store = await makeContext(origin, { identity });
  const lease = leaseFor(identity.deviceId);
  await lease.ensure();

  // A peer publishes first, under a name that will soon match ours.
  const root = await Transport.getSyncV3Root(dir.handle, { create: true });
  const devicesDir = await Transport.getDevicesDir(root, { create: true });
  await Transport.publishOwnReplicaVerified(devicesDir, {
    deviceId: DEVICE_B,
    label: "Chromebook Pro",
    replica: { schemaVersion: 3, profiles: {}, associations: {}, libraries: {} },
  });
  const peerDir = deviceDirectories(dir).find((name) => name.includes("90a84b71"));
  const peerFilesBefore = JSON.stringify(Object.keys(dir.snapshotFiles()).filter((p) => p.includes(peerDir)).sort());

  const state = {};
  await passFor(store, dir, lease, state);
  await settle();
  await store.setDeviceName("Chromebook Pro");
  await settle();
  await passFor(store, dir, lease, state);
  await settle();

  assertEqual(
    JSON.stringify(Object.keys(dir.snapshotFiles()).filter((p) => p.includes(peerDir)).sort()),
    peerFilesBefore,
    "the peer directory is untouched (req 12)"
  );
  assertEqual(deviceDirectories(dir).length, 2, "two device directories: ours and the peer's (req 13)");
});

// ---- Collisions + sanitization (13-17) -------------------------------------

await test("Two devices sharing a Device Name stay two devices (req 13, 14)", async () => {
  const dir = createVirtualDirectory("V3 Sync");
  const root = await Transport.getSyncV3Root(dir.handle, { create: true });
  const devicesDir = await Transport.getDevicesDir(root, { create: true });
  const empty = { schemaVersion: 3, profiles: {}, associations: {}, libraries: {} };

  const a = await Transport.publishOwnReplicaVerified(devicesDir, {
    deviceId: "dev-c5ee4e83-1111-4222-8333-444455556666",
    label: "Chromebook Pro",
    replica: empty,
  });
  // Same human name, different case - the conservative guard must still keep
  // them apart, and their ids differ regardless.
  const b = await Transport.publishOwnReplicaVerified(devicesDir, {
    deviceId: "dev-a19f72d1-7777-4888-8999-aaaabbbbcccc",
    label: "chromebook pro",
    replica: empty,
  });

  assertEqual(a.ok, true, "device A published");
  assertEqual(b.ok, true, "device B published under a case-variant name (req 14)");
  assert(a.directoryName !== b.directoryName, `distinct directories: "${a.directoryName}" vs "${b.directoryName}"`);
  assertEqual(a.directoryName.toLowerCase() !== b.directoryName.toLowerCase(), true, "distinct case-insensitively too (req 14)");

  const discovered = await Transport.discoverDevices(devicesDir, { ownDeviceId: null });
  assertEqual(discovered.peers.length, 2, "TWO logical devices despite one human name (req 13)");
  assertEqual(discovered.duplicates.length, 0, "neither is treated as a duplicate of the other (req 13)");
});

await test("Device Names go through the existing Stage 02 sanitizer (req 15, 16, 17)", async () => {
  const dir = createVirtualDirectory("V3 Sync");
  const origin = makeOrigin();
  const identity = await makeIdentity(origin);
  const store = await makeContext(origin, { identity });
  const lease = leaseFor(identity.deviceId);
  await lease.ensure();

  // A name that is legitimate to a human and hostile to a filesystem.
  const hostile = "Dad's Laptop (work) / 日本語 📷";
  await store.setDeviceName(hostile);
  await settle();

  // [SYNCV3 / STAGE-05 / DEVICE-NAMING]
  // [WHY: the LOGICAL name keeps the slash - it is what the user typed, and
  //  persisting a path-safe derivative would let path sanitization quietly
  //  become the stored value. Filesystem safety happens only at the path
  //  boundary, below.]
  assertEqual(store.getDeviceName(), hostile, "the user's logical name is stored verbatim (req 17)");

  await passFor(store, dir, lease, {});
  await settle();

  const directoryName = deviceDirectories(dir)[0];
  assert(!directoryName.includes("/"), `the separator was sanitized out of the path: "${directoryName}"`);
  assert(!directoryName.includes("\\"), "and so was a backslash (req 16)");
  assert(directoryName.includes("日本語"), "CJK survives (req 15)");
  assert(directoryName.includes("📷"), "an astral emoji survives (req 15)");
  assert(directoryName.includes("Dad's"), "an apostrophe survives (req 15)");
  assert(directoryName.includes("(work)"), "parentheses survive (req 15)");

  // Exactly the Stage 02 sanitizer, not a second one.
  const expected = Names.buildReadableName(hostile, identity.deviceId);
  assertEqual(directoryName, expected, "the directory name is what sync-v3-names.js produces (req 15, 16)");

  // device.json carries the LOGICAL name, so a peer reads what the user typed.
  assertEqual(manifestOf(dir, directoryName).label, hostile, "device.json carries the logical name (req 17)");
});

// ---- Peer discovery reads metadata, not paths (18, 19) ---------------------

await test("Peer names come from validated device.json, never the path (req 18)", async () => {
  const dir = createVirtualDirectory("V3 Sync");
  const root = await Transport.getSyncV3Root(dir.handle, { create: true });
  const devicesDir = await Transport.getDevicesDir(root, { create: true });

  const published = await Transport.publishOwnReplicaVerified(devicesDir, {
    deviceId: DEVICE_B,
    label: "Living Room Chromebook",
    replica: { schemaVersion: 3, profiles: {}, associations: {}, libraries: {} },
  });

  // Somebody renames the directory on Drive to something misleading. The
  // manifest is untouched.
  const files = dir.snapshotFiles();
  const oldPrefix = `sync-v3/devices/${published.directoryName}/`;
  const lyingName = "TOTALLY DIFFERENT NAME -- ffffffff";
  for (const [filePath, text] of Object.entries(files)) {
    if (filePath.startsWith(oldPrefix)) dir.writeFile(`sync-v3/devices/${lyingName}/${filePath.slice(oldPrefix.length)}`, text);
  }
  dir.removeDirectory(`sync-v3/devices/${published.directoryName}`);

  const discovered = await Transport.discoverDevices(devicesDir, { ownDeviceId: null });
  assertEqual(discovered.peers.length, 1, "still one peer");
  assertEqual(discovered.peers[0].deviceId, DEVICE_B, "identified by content (req 18)");
  assertEqual(discovered.peers[0].label, "Living Room Chromebook", "and NAMED from device.json, not the path (req 18)");
  assert(discovered.peers[0].label !== "TOTALLY DIFFERENT NAME", "the misleading path was not believed (req 18)");
  assertEqual(discovered.peers[0].directoryName, lyingName, "the path is reported, but only as presentation");
});

await test("An old V3 device.json with no name metadata stays readable (req 19)", async () => {
  const dir = createVirtualDirectory("V3 Sync");
  const root = await Transport.getSyncV3Root(dir.handle, { create: true });
  const devicesDir = await Transport.getDevicesDir(root, { create: true });

  const published = await Transport.publishOwnReplicaVerified(devicesDir, {
    deviceId: DEVICE_B,
    label: "Windows",
    replica: { schemaVersion: 3, profiles: {}, associations: {}, libraries: {} },
  });

  // A generation from before any of this existed: no label at all.
  const manifestPath = `sync-v3/devices/${published.directoryName}/device.json`;
  const manifest = JSON.parse(dir.readFile(manifestPath));
  delete manifest.label;
  dir.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  const read = await Transport.readDeviceDirectory(devicesDir, published.directoryName);
  assertEqual(read.status, "valid", "an old generation is VALID, not corrupt (req 19)");
  assertEqual(read.deviceId, DEVICE_B, "with its identity intact");
  assertEqual(read.label, Transport.UNKNOWN_DEVICE_LABEL, "and a safe fallback name (req 19)");
});

// ---- Live surfaces + multi-tab (20-25) -------------------------------------

await test("A rename is visible in the same context immediately (req 20)", async () => {
  const origin = makeOrigin();
  const identity = await makeIdentity(origin);
  const store = await makeContext(origin, { identity });

  let emits = 0;
  store.subscribe(() => {
    emits += 1;
  });

  assertEqual(store.getDeviceDisplayName(), "Chromebook", "starts on the detected label");
  await store.setDeviceName("Travel Chromebook");

  assertEqual(store.getDeviceDisplayName(), "Travel Chromebook", "the effective name is current at once (req 20)");
  assertEqual(store.getDeviceName(), "Travel Chromebook", "and so is the custom name (req 20)");
  assert(emits > 0, "subscribers were notified, so a live surface re-renders (req 20)");
});

await test("A rename reaches a sibling tab without a reload (req 21, 22, 23)", async () => {
  const dir = createVirtualDirectory("V3 Sync");
  const origin = makeOrigin();
  const identityA = await makeIdentity(origin);
  const a = await makeContext(origin, { identity: identityA });
  const identityB = await makeIdentity(origin);
  const b = await makeContext(origin, { identity: identityB });

  assertEqual(identityA.deviceId, identityB.deviceId, "both tabs are the same installation");
  const sharedId = identityB.deviceId;
  const driveBefore = JSON.stringify(Object.keys(dir.snapshotFiles()).sort());

  await a.setDeviceName("Chromebook Pro");
  await propagate();

  assertEqual(b.getDeviceDisplayName(), "Chromebook Pro", "the sibling learned the new name (req 21)");
  assertEqual(b.getDeviceName(), "Chromebook Pro", "as a custom name, not a guess (req 21)");
  assertEqual(b.getDeviceId(), sharedId, "and did NOT mint a new deviceId (req 22)");
  assertEqual(JSON.stringify(Object.keys(dir.snapshotFiles()).sort()), driveBefore, "nothing reached Drive (req 23)");
  assertEqual(driveBefore, "[]", "the folder was and remains untouched (req 23)");

  // A reset propagates the same way.
  await b.setDeviceName("");
  await propagate();
  assertEqual(a.getDeviceDisplayName(), "Chromebook", "a reset propagates too (req 21)");
  assertEqual(a.getDeviceName(), null, "back to no custom name");
});

await test("The writer publishes a sibling's rename; one writer at a time (req 24, 25)", async () => {
  const dir = createVirtualDirectory("V3 Sync");
  const origin = makeOrigin();
  const writerIdentity = await makeIdentity(origin);
  const writer = await makeContext(origin, { identity: writerIdentity });
  const readerIdentity = await makeIdentity(origin);
  const reader = await makeContext(origin, { identity: readerIdentity });

  const lease = leaseFor(writerIdentity.deviceId);
  assertEqual((await lease.ensure()).allowed, true, "the writer holds the lease (req 24)");
  const readerLease = Policy.createV3WriterLease({ deviceId: readerIdentity.deviceId });
  openLeases.push(readerLease);
  assertEqual((await readerLease.ensure()).allowed, false, "the reader cannot (req 24)");

  const state = {};
  await passFor(writer, dir, lease, state);
  await settle();
  const suffix = deviceDirectories(dir)[0].split(" -- ")[1];

  // The user renames from the READER tab.
  await reader.setDeviceName("Desktop PC");
  await propagate();
  assertEqual(writer.getDeviceDisplayName(), "Desktop PC", "the writer learned the rename (req 25)");

  const published = await passFor(writer, dir, lease, state);
  await settle();

  assertEqual(published.published, true, "the writer published it (req 25)");
  assertEqual(deviceDirectories(dir).join(","), `Desktop PC -- ${suffix}`, "under the sibling's chosen name (req 25)");
  assertEqual(manifestOf(dir, `Desktop PC -- ${suffix}`).label, "Desktop PC", "and device.json agrees");
  assertEqual(deviceDirectories(dir).length, 1, "still one own device subtree");
});

// ---- Everything else is unaffected (26-29) ---------------------------------

await test("Profiles, libraries, associations and activeProfileId are unaffected (req 26-29)", async () => {
  const origin = makeOrigin();
  const identity = await makeIdentity(origin);
  const store = await makeContext(origin, { identity });

  await store.adoptMergedReplica({
    schemaVersion: 3,
    profiles: { "93bc1a7d-beast": { name: { v: "BEAST", t: 5e12, d: DEVICE_B }, items: {}, tags: {} } },
    associations: { [LIB_1]: { v: "93bc1a7d-beast", t: 5e12, d: DEVICE_B } },
    libraries: {
      [LIB_1]: {
        name: { v: "beebeegees", t: 5e12, d: DEVICE_B },
        sourceDeviceId: { v: DEVICE_B, t: 5e12, d: DEVICE_B },
        lastLoadedAt: { v: 1_700_000_000_000, t: 5e12, d: DEVICE_B },
      },
    },
  });
  await settle();

  const activeBefore = store.getProfileId();
  const profilesBefore = JSON.stringify(store.listProfiles());
  const associationsBefore = JSON.stringify(store.getAssociations());
  const librariesBefore = JSON.stringify(store.getLibraries());

  await store.setDeviceName("Chromebook Pro");
  await settle();

  assertEqual(store.getProfileId(), activeBefore, "activeProfileId is unchanged (req 28)");
  assertEqual(JSON.stringify(store.listProfiles()), profilesBefore, "Profile materialization is unaffected (req 26)");
  assertEqual(JSON.stringify(store.getAssociations()), associationsBefore, "associations are unchanged (req 29)");
  assertEqual(JSON.stringify(store.getLibraries()), librariesBefore, "the Library catalog is unchanged (req 27)");

  // The replica a rename would publish carries no device name at all.
  const replica = await store.getFullReplica();
  assert(!JSON.stringify(replica).includes("Chromebook Pro"), "the human name is NOT in the replica (req 27)");
  assert(JSON.stringify(replica).includes(DEVICE_B), "while the full sourceDeviceId still is (req 27)");
});

await test("resolveDeviceName reads metadata, and falls back safely (req 18, 27)", async () => {
  const dir = createVirtualDirectory("V3 Sync");
  const origin = makeOrigin();
  const identity = await makeIdentity(origin);
  const store = await makeContext(origin, { identity });
  const sync = new ProfileSync(store);
  liveInstances.push(sync);

  await store.setDeviceName("Chromebook Pro");
  await settle();

  // Own device resolves to the effective name.
  assertEqual(sync.resolveDeviceName(identity.deviceId), "Chromebook Pro", "own deviceId resolves to its name");

  // [SYNCV3 / STAGE-05 / DEVICE-NAMING]
  // [WHY: an unknown device falls back to a short id rather than inventing a
  //  name or throwing - this is what a Library picker will call for a
  //  sourceDeviceId belonging to a peer it has never met.]
  const unknown = sync.resolveDeviceName(DEVICE_B);
  assertEqual(unknown, "90a84b71", "an unknown device falls back to a short id");
  assert(!unknown.includes("--"), "and never looks like a parsed directory name");
  assertEqual(sync.resolveDeviceName(null), null, "a missing id resolves to nothing");
  assert(Boolean(dir), "fixture wired");
});

// ---- Summary ---------------------------------------------------------------

console.log(`\n${"-".repeat(60)}`);
if (failures === 0) {
  console.log(`ok    ${passes} assertion(s) passed - SyncV3 Stage 05 holds.`);
} else {
  console.log(`FAIL  ${failures} failure(s), ${passes} passed:`);
  for (const detail of failureDetail) console.log(`  - ${detail}`);
}
process.exit(failures === 0 ? 0 : 1);
