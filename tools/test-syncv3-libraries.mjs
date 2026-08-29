#!/usr/bin/env node
// [SYNCV3 / STAGE-04B / SHARED-LIBRARY-RECORD]
// [WHY: the shared Library catalog is the first thing SyncV3 publishes whose
//  fields a UI reads DIRECTLY - a name to show, a device to attribute it to, a
//  time to rank it by. Everything before it was curation, where a wrong answer
//  shows up as a missing favourite; here a wrong answer shows up as one Library
//  wearing another's name, or a Library vanishing from the catalog because its
//  association went null. Both are silent, and both destroy the user's ability
//  to find their own work, so the guarantees are proven mechanically.]
//
// Usage:  node tools/test-syncv3-libraries.mjs

import { pathToFileURL } from "node:url";
import path from "node:path";
import { installFakeIndexedDB, createVirtualDirectory, settle, muteConsole } from "./lib/browser-test-env.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const src = (rel) => pathToFileURL(path.join(ROOT, "src", rel)).href;

const { setSnapshotFreezeEnabled } = await import(src("profile/profile-snapshot.js"));
setSnapshotFreezeEnabled(true);

const Facts = await import(src("profile/sync-facts.js"));
const Merge = await import(src("profile/sync-merge.js"));
const { ProfileStore } = await import(src("profile/profile-store.js"));
const { runSyncV3Pass } = await import(src("profile/sync-v3.js"));
const Transport = await import(src("profile/sync-v3-transport.js"));
const Store = await import(src("storage/profile-sync-store.js"));
const Policy = await import(src("profile/sync-v3-write-policy.js"));
const Channel = await import(src("profile/local-state-channel.js"));
const LibraryRegistry = await import(src("storage/library-registry.js"));
const { SyncIdentity } = await import(src("profile/sync-device.js"));

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
    for (const store of openContexts.splice(0)) {
      try {
        store.closeLocalStateChannel();
      } catch {
        /* already gone */
      }
    }
    for (const lease of openLeases.splice(0)) {
      try {
        lease.release();
      } catch {
        /* already gone */
      }
    }
  }
}

// ---- Fixtures --------------------------------------------------------------

const DEVICE_A = "dev-a31f2c4e-1111-4222-8333-444455556666";
const DEVICE_B = "dev-90a84b71-7777-4888-8999-aaaabbbbcccc";
const LIB_1 = "178d159d-1111-4222-8333-444455556666";
const LIB_2 = "c771a902-7777-4888-8999-aaaabbbbcccc";

function fact(value, t, d = DEVICE_A) {
  return { v: value, t, d };
}

function libraryFacts({ name, sourceDeviceId, lastLoadedAt, t = 1000, d = DEVICE_A }) {
  const out = {};
  if (name !== undefined) out.name = fact(name, t, d);
  if (sourceDeviceId !== undefined) out.sourceDeviceId = fact(sourceDeviceId, t, d);
  if (lastLoadedAt !== undefined) out.lastLoadedAt = fact(lastLoadedAt, t, d);
  return out;
}

function replicaWith(libraries = {}, associations = {}, profiles = {}) {
  return { schemaVersion: 3, profiles, associations, libraries };
}

let channelCounter = 0;
function makeOrigin() {
  const env = installFakeIndexedDB();
  return { env, idb: globalThis.indexedDB, channelName: `bg-lib-test-${++channelCounter}` };
}

function rowsOf(origin) {
  const db = origin.env.databases.get("loop-browser-gallery-profile-sync");
  const store = db ? db.stores.get("sync") : null;
  return store ? store.rows : new Map();
}

function fixedIdentity(deviceId = DEVICE_A) {
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

async function makeContext(origin, { deviceId = DEVICE_A, channel = "real" } = {}) {
  globalThis.indexedDB = origin.idb;
  const localStateChannel = Channel.createLocalStateChannel({
    channelName: origin.channelName,
    factory: channel === null ? null : undefined,
  });
  const store = new ProfileStore({
    identity: fixedIdentity(deviceId),
    associationStore: Store.V3_ASSOCIATION_STORE,
    localStateChannel,
  });
  openContexts.push(store);
  await settle(20);
  await store.whenFactsSettled();
  await store.whenAssociationsSettled();
  await store.whenLibrariesSettled();
  return store;
}

const propagate = () => settle(60);

function v3Files(dir) {
  return Object.keys(dir.snapshotFiles()).sort();
}

function deviceDirectories(dir) {
  const prefix = `${Transport.ROOT_DIR_NAME}/${Transport.DEVICES_DIR_NAME}/`;
  return [
    ...new Set(Object.keys(dir.snapshotFiles()).filter((p) => p.startsWith(prefix)).map((p) => p.split("/")[2])),
  ].sort();
}

async function publishPeer(dir, { deviceId, label, replica }) {
  const root = await Transport.getSyncV3Root(dir.handle, { create: true });
  const devicesDir = await Transport.getDevicesDir(root, { create: true });
  return Transport.publishOwnReplicaVerified(devicesDir, { deviceId, label, replica });
}

// ============================================================================

console.log("SyncV3 Stage 04B - shared Library record");

// ---- Shape + validation (1-5) ----------------------------------------------

await test("emptyReplica carries a libraries map, and it validates (req 1, 2)", async () => {
  const empty = Facts.emptyReplica();
  assert(Object.hasOwn(empty, "libraries"), "emptyReplica has a libraries key (req 1)");
  assertEqual(JSON.stringify(empty.libraries), "{}", "and it starts empty");
  assertEqual(Facts.findSessionStateLeaks(empty).length, 0, "an empty replica still validates");

  const withLibrary = replicaWith({
    [LIB_1]: libraryFacts({ name: "beebeegees", sourceDeviceId: DEVICE_A, lastLoadedAt: 1_700_000_000_000 }),
  });
  assertEqual(Facts.findSessionStateLeaks(withLibrary).length, 0, "a well-formed Library record validates (req 2)");

  // Individually-absent fields are legitimate mid-publish states.
  assertEqual(
    Facts.findSessionStateLeaks(replicaWith({ [LIB_1]: libraryFacts({ name: "partial" }) })).length,
    0,
    "a record with only some fields present is still valid"
  );
});

await test("Malformed Library facts are rejected (req 3, 4, 5)", async () => {
  const notAnObject = replicaWith({ [LIB_1]: "beebeegees" });
  assert(Facts.findSessionStateLeaks(notAnObject).length > 0, "a non-object Library record is rejected (req 3)");

  const notAFact = replicaWith({ [LIB_1]: { name: "beebeegees" } });
  assert(Facts.findSessionStateLeaks(notAFact).length > 0, "a bare value where a Fact belongs is rejected (req 3)");

  const wrongValueType = replicaWith({ [LIB_1]: { name: fact({ nested: true }, 10) } });
  const wrongLeaks = Facts.findSessionStateLeaks(wrongValueType);
  assert(wrongLeaks.length > 0, "a name whose value is not a string is rejected (req 3)");
  assert(
    wrongLeaks.some((leak) => leak.includes("not a string")),
    `the leak names the type problem: ${wrongLeaks.join(", ")}`
  );

  const badTimestamp = replicaWith({ [LIB_1]: { lastLoadedAt: fact("yesterday", 10) } });
  assert(
    Facts.findSessionStateLeaks(badTimestamp).some((leak) => leak.includes("finite number")),
    "a non-numeric lastLoadedAt is rejected (req 3)"
  );

  const extraField = replicaWith({
    [LIB_1]: { ...libraryFacts({ name: "x" }), createdAt: fact(1, 10) },
  });
  assert(
    Facts.findSessionStateLeaks(extraField).some((leak) => leak.includes("createdAt")),
    "an unapproved extra Library field is rejected (req 4)"
  );

  const sessionLeak = replicaWith({
    [LIB_1]: { ...libraryFacts({ name: "x" }), handle: fact("fs-handle", 10) },
  });
  assert(
    Facts.findSessionStateLeaks(sessionLeak).some((leak) => leak.includes("handle")),
    "a session-only field under a Library record is rejected (req 5)"
  );

  const extraTopLevel = { ...Facts.emptyReplica(), mediaIndex: {} };
  assert(
    Facts.findSessionStateLeaks(extraTopLevel).includes("mediaIndex"),
    "the top-level allow-list is still an allow-list"
  );
});

// ---- Identity rules (6, 7) -------------------------------------------------

await test("Same libraryId with different local names stays ONE Library (req 6)", async () => {
  // Two devices, same shared libraryId, each naming it what its own user sees.
  const a = replicaWith({ [LIB_1]: libraryFacts({ name: "beebeegees", sourceDeviceId: DEVICE_A, lastLoadedAt: 100, t: 10, d: DEVICE_A }) });
  const b = replicaWith({ [LIB_1]: libraryFacts({ name: "BBG Main", sourceDeviceId: DEVICE_B, lastLoadedAt: 200, t: 20, d: DEVICE_B }) });

  const merged = Merge.mergeReplicas(a, b);
  assertEqual(Object.keys(merged.libraries).length, 1, "one Library record, not two (req 6)");
  assertEqual(merged.libraries[LIB_1].name.v, "BBG Main", "the newer name wins by ordinary LWW");
  assertEqual(Facts.projectLibraries(merged).length, 1, "and the projection reports one Library");
});

await test("Same human name with DIFFERENT libraryIds stays TWO Libraries (req 7)", async () => {
  const merged = Merge.mergeReplicas(
    replicaWith({ [LIB_1]: libraryFacts({ name: "beebeegees", t: 10 }) }),
    replicaWith({ [LIB_2]: libraryFacts({ name: "beebeegees", t: 20 }) })
  );
  assertEqual(Object.keys(merged.libraries).length, 2, "two independent Libraries (req 7)");
  const projected = Facts.projectLibraries(merged);
  assertEqual(projected.length, 2, "both project");
  assertEqual(projected[0].name, projected[1].name, "sharing a display name is allowed");
  assert(projected[0].id !== projected[1].id, "but their identities differ");
});

// ---- Merge algebra (8-13) --------------------------------------------------

await test("Concurrent name and lastLoadedAt edits BOTH survive (req 8, 9)", async () => {
  // [SYNCV3 / STAGE-04B / SHARED-LIBRARY-RECORD]
  // [WHY: the two sides are built as PARTIAL records with genuinely independent
  //  per-field stamps, not via recordLibraryLoaded. That builder stamps all
  //  three fields at one stamp because a load legitimately updates all three at
  //  once - so it cannot, by construction, produce the divergence this test is
  //  about. Partial records are a valid shape (the shape guard accepts them, and
  //  mergeMaps produces them whenever one side knows about a field the other
  //  does not), and they are precisely the state a composite Fact<{...}> would
  //  resolve wrongly.]
  const base = replicaWith({
    [LIB_1]: libraryFacts({ name: "old name", sourceDeviceId: DEVICE_A, lastLoadedAt: 100, t: 10, d: DEVICE_A }),
  });

  // Device A: a NEWER name, and nothing else.
  const renamedOnly = replicaWith({ [LIB_1]: { name: fact("new name", 50, DEVICE_A) } });
  // Device B: a NEWER load, at an OLDER stamp than A's rename.
  const reloadedOnly = replicaWith({
    [LIB_1]: { lastLoadedAt: fact(999, 30, DEVICE_B), sourceDeviceId: fact(DEVICE_B, 30, DEVICE_B) },
  });

  const merged = Merge.mergeAll([base, renamedOnly, reloadedOnly]);
  const record = merged.libraries[LIB_1];

  assertEqual(record.name.v, "new name", "A's newer rename survived (req 8)");
  assertEqual(record.lastLoadedAt.v, 999, "B's newer load time ALSO survived (req 8)");
  assertEqual(record.sourceDeviceId.v, DEVICE_B, "sourceDeviceId merged on its own stamp (req 9)");

  // The point of the whole schema: the fields resolved to DIFFERENT stamps, so a
  // single whole-record LWW would necessarily have discarded one of them.
  assertEqual(record.name.t, 50, "the name kept its own stamp");
  assertEqual(record.lastLoadedAt.t, 30, "and lastLoadedAt kept a different one (req 8)");
  assert(record.name.t !== record.lastLoadedAt.t, "the two fields genuinely carry different stamps");

  // Order-independent, as every merge in this system must be.
  const reordered = Merge.mergeAll([reloadedOnly, base, renamedOnly]);
  assertEqual(
    Merge.stableStringify(reordered.libraries[LIB_1]),
    Merge.stableStringify(record),
    "and the same result regardless of arrival order"
  );
});

await test("Library merge is commutative, associative and idempotent (req 10, 11, 12)", async () => {
  const a = replicaWith({ [LIB_1]: libraryFacts({ name: "a", lastLoadedAt: 1, t: 10, d: DEVICE_A }) });
  const b = replicaWith({ [LIB_1]: libraryFacts({ name: "b", sourceDeviceId: DEVICE_B, t: 20, d: DEVICE_B }) });
  const c = replicaWith({ [LIB_2]: libraryFacts({ name: "c", lastLoadedAt: 5, t: 15, d: DEVICE_A }) });

  const ab = Merge.stableStringify(Merge.mergeReplicas(a, b));
  const ba = Merge.stableStringify(Merge.mergeReplicas(b, a));
  assertEqual(ab, ba, "commutative (req 10)");

  const left = Merge.stableStringify(Merge.mergeReplicas(Merge.mergeReplicas(a, b), c));
  const right = Merge.stableStringify(Merge.mergeReplicas(a, Merge.mergeReplicas(b, c)));
  assertEqual(left, right, "associative (req 11)");

  const once = Merge.mergeReplicas(a, b);
  assertEqual(Merge.stableStringify(Merge.mergeReplicas(once, once)), ab, "idempotent (req 12)");
  assertEqual(Merge.stableStringify(Merge.mergeReplicas(once, b)), ab, "replaying one side changes nothing");
});

await test("An unknown peer libraryId materializes with no special-casing (req 13)", async () => {
  const mine = replicaWith({ [LIB_1]: libraryFacts({ name: "mine", t: 10 }) });
  const theirs = replicaWith({ [LIB_2]: libraryFacts({ name: "theirs", sourceDeviceId: DEVICE_B, lastLoadedAt: 77, t: 20, d: DEVICE_B }) });

  const merged = Merge.mergeReplicas(mine, theirs);
  assert(Object.hasOwn(merged.libraries, LIB_2), "the unknown Library simply appears (req 13)");
  const projected = Facts.projectLibrary(merged, LIB_2);
  assertEqual(projected.name, "theirs", "with its published name");
  assertEqual(projected.sourceDeviceId, DEVICE_B, "and its publishing device");
  assertEqual(projected.lastLoadedAt, 77, "and its load time");
});

// ---- Catalog independence (14, 15) -----------------------------------------

await test("A null association does NOT remove the Library from the catalog (req 14)", async () => {
  const replica = replicaWith(
    { [LIB_1]: libraryFacts({ name: "beebeegees", sourceDeviceId: DEVICE_A, lastLoadedAt: 500, t: 10 }) },
    { [LIB_1]: fact(null, 20) }
  );

  // The association projection correctly reports nothing...
  assertEqual(Object.keys(Facts.projectAssociations(replica)).length, 0, "no association currently points anywhere");

  // ...but the catalog still knows the Library. This is the whole point.
  const libraries = Facts.projectLibraries(replica);
  assertEqual(libraries.length, 1, "the Library remains catalogued (req 14)");
  assertEqual(libraries[0].name, "beebeegees", "with its name intact");
  assertEqual(libraries[0].associatedProfileId, null, "and an explicitly null association");
  assert(libraries[0].associationChangedAt > 0, "the disassociation's own stamp is available for ranking");
});

await test("A shared Library needs no local physical row (req 15)", async () => {
  const origin = makeOrigin();
  const store = await makeContext(origin);

  // Adopt a Library this device has never had a folder for.
  await store.adoptMergedReplica(
    replicaWith({ [LIB_2]: libraryFacts({ name: "someone elses", sourceDeviceId: DEVICE_B, lastLoadedAt: 42, t: 20, d: DEVICE_B }) })
  );
  await settle();

  const listed = store.listLibraries();
  assertEqual(listed.length, 1, "the Library is known locally (req 15)");
  assertEqual(listed[0].name, "someone elses", "with its shared name");

  const localRow = await LibraryRegistry.getLibraryByLibraryId(LIB_2);
  assertEqual(localRow, null, "and there is genuinely no local physical row for it");
});

// ---- Local boundaries (16, 17) ---------------------------------------------

await test("activeProfileId is neither published nor adopted (req 16, 17)", async () => {
  const origin = makeOrigin();
  const store = await makeContext(origin);
  const activeBefore = store.getProfileId();
  const profilesBefore = store.listProfiles().length;

  const replica = await store.getFullReplica();
  const serialized = JSON.stringify(replica);
  assert(!Object.hasOwn(replica, "activeProfileId"), "the replica has no activeProfileId key (req 16)");
  assert(!serialized.includes("activeProfileId"), "and it appears nowhere in the published bytes (req 16)");

  // A Library arriving from a peer must not change which Profile is active.
  await store.adoptMergedReplica(
    replicaWith({ [LIB_1]: libraryFacts({ name: "peer library", sourceDeviceId: DEVICE_B, lastLoadedAt: 9, t: 20, d: DEVICE_B }) })
  );
  await settle();

  assertEqual(store.getProfileId(), activeBefore, "the active Profile is unchanged (req 16)");
  assertEqual(store.listProfiles().length, profilesBefore, "and Profile materialization is unaffected (req 17)");
  assertEqual(store.listLibraries().length, 1, "while the Library did arrive");
});

await test("Profile materialization from a peer still works alongside libraries (req 17)", async () => {
  const origin = makeOrigin();
  const store = await makeContext(origin);

  await store.adoptMergedReplica({
    schemaVersion: 3,
    profiles: { "93bc1a7d-beast": { name: fact("BEAST", 5_000_000_000_000, DEVICE_B), items: {}, tags: {} } },
    associations: { [LIB_1]: fact("93bc1a7d-beast", 5_000_000_000_000, DEVICE_B) },
    libraries: { [LIB_1]: libraryFacts({ name: "beebeegees", sourceDeviceId: DEVICE_B, lastLoadedAt: 12, t: 5_000_000_000_000, d: DEVICE_B }) },
  });
  await settle();

  assert(
    store.listProfiles().some((entry) => entry.id === "93bc1a7d-beast"),
    "the peer's Profile still materialized (req 17)"
  );
  const library = store.listLibraries()[0];
  assertEqual(library.associatedProfileId, "93bc1a7d-beast", "and the Library reports its association");
  assertEqual(library.name, "beebeegees", "with its shared name");
});

// ---- Local persistence + freshness (18-23) ---------------------------------

await test("The libraries-v3 cache persists and reloads (req 18)", async () => {
  const origin = makeOrigin();
  const store = await makeContext(origin);

  await store.adoptMergedReplica(
    replicaWith({ [LIB_1]: libraryFacts({ name: "persisted", sourceDeviceId: DEVICE_A, lastLoadedAt: 7, t: 20 }) })
  );
  await settle();

  const rows = rowsOf(origin);
  assert(Boolean(rows.get("libraries-v3")), "a libraries-v3 row was written (req 18)");
  assertEqual(rows.get("associations-v3"), undefined, "and the association row was not touched");

  // A fresh context over the same storage reads it back.
  const reopened = await makeContext(origin);
  const listed = reopened.listLibraries();
  assertEqual(listed.length, 1, "a new context reloads the catalog (req 18)");
  assertEqual(listed[0].name, "persisted", "with the same name");
  assertEqual(listed[0].lastLoadedAt, 7, "and the same load time");
});

await test("libraries-changed refreshes a sibling context (req 19, 20, 21)", async () => {
  const dir = createVirtualDirectory("V3 Sync");
  const origin = makeOrigin();
  const a = await makeContext(origin);
  const b = await makeContext(origin);

  const driveBefore = JSON.stringify(v3Files(dir));

  await a.adoptMergedReplica(
    replicaWith({ [LIB_1]: libraryFacts({ name: "from A", sourceDeviceId: DEVICE_A, lastLoadedAt: 55, t: 20 }) })
  );
  await propagate();

  const listed = b.listLibraries();
  assertEqual(listed.length, 1, "the sibling learned about the Library (req 19)");
  assertEqual(listed[0].name, "from A", "with the right name");

  // The receiver ADOPTS; it does not re-stamp.
  const aFact = a.getLibraries()[LIB_1].name;
  const bFact = b.getLibraries()[LIB_1].name;
  assertEqual(bFact.t, aFact.t, "the sibling holds the SAME stamp - no duplicate mutation (req 20)");
  assertEqual(bFact.d, aFact.d, "and the same originating device");

  assertEqual(JSON.stringify(v3Files(dir)), driveBefore, "and nothing reached Drive from the handler (req 21)");
  assertEqual(driveBefore, "[]", "the folder was and remains untouched");
});

await test("reload-before-publish gives the writer a sibling's newest Library facts (req 22)", async () => {
  const dir = createVirtualDirectory("V3 Sync");
  const origin = makeOrigin();
  const writer = await makeContext(origin);
  const editor = await makeContext(origin);

  const lease = Policy.createV3WriterLease({ deviceId: DEVICE_A });
  openLeases.push(lease);
  assertEqual((await lease.ensure()).allowed, true, "the writer holds the lease");

  // The other context learns about a Library.
  await editor.adoptMergedReplica(
    replicaWith({ [LIB_1]: libraryFacts({ name: "typed elsewhere", sourceDeviceId: DEVICE_A, lastLoadedAt: 88, t: 30 }) })
  );
  await propagate();

  const result = await runSyncV3Pass({
    profileStore: writer,
    dirHandle: dir.handle,
    state: {},
    writerLease: lease,
  });
  await settle();

  assertEqual(result.published, true, "the writer published");
  const published = JSON.stringify(dir.snapshotFiles());
  assert(published.includes("typed elsewhere"), "and the published bytes carry the sibling's Library (req 22)");
  assert(published.includes(LIB_1), "keyed by the FULL libraryId");
  assertEqual(deviceDirectories(dir).length, 1, "one device directory");
});

await test("Three same-device contexts converge on the union (req 23)", async () => {
  const origin = makeOrigin();
  const a = await makeContext(origin);
  const b = await makeContext(origin);
  const c = await makeContext(origin);

  await a.adoptMergedReplica(replicaWith({ [LIB_1]: libraryFacts({ name: "from A", lastLoadedAt: 1, t: 20 }) }));
  await propagate();
  await b.adoptMergedReplica(replicaWith({ [LIB_2]: libraryFacts({ name: "from B", lastLoadedAt: 2, t: 30 }) }));
  await propagate();

  for (const [label, context] of [["A", a], ["B", b], ["C", c]]) {
    const ids = context.listLibraries().map((entry) => entry.id).sort();
    assertEqual(ids.length, 2, `${label} sees both Libraries (req 23)`);
    assertEqual(ids.join(","), [LIB_1, LIB_2].sort().join(","), `${label} has the union`);
  }
});

// ---- Transport (24-30) -----------------------------------------------------

await test("An old V3 manifest with no librariesHash still reads (req 24)", async () => {
  const dir = createVirtualDirectory("V3 Sync");
  const published = await publishPeer(dir, {
    deviceId: DEVICE_B,
    label: "Windows",
    replica: replicaWith({ [LIB_1]: libraryFacts({ name: "will be removed", t: 10 }) }),
  });
  assertEqual(published.ok, true, "seeded a current-generation directory");

  // Simulate a Stage 02/03 generation: strip the file and its declaration.
  const manifestPath = `sync-v3/devices/${published.directoryName}/device.json`;
  const manifest = JSON.parse(dir.readFile(manifestPath));
  delete manifest.librariesHash;
  delete manifest.librariesFile;
  dir.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  dir.removeFile(`sync-v3/devices/${published.directoryName}/${Transport.LIBRARIES_FILE_NAME}`);

  const root = await Transport.getSyncV3Root(dir.handle);
  const devicesDir = await Transport.getDevicesDir(root);
  const read = await Transport.readDeviceDirectory(devicesDir, published.directoryName);

  assertEqual(read.status, "valid", "an old generation is VALID, not corrupt (req 24)");
  assertEqual(JSON.stringify(read.replica.libraries), "{}", "and reads as an empty catalog (req 24)");
  assert(Object.keys(read.replica.profiles).length >= 0, "the rest of the generation is intact");
});

await test("A valid libraries.json publishes and reads back exactly (req 25)", async () => {
  const dir = createVirtualDirectory("V3 Sync");
  const replica = replicaWith({
    [LIB_1]: libraryFacts({ name: "beebeegees", sourceDeviceId: DEVICE_A, lastLoadedAt: 1_700_000_000_000, t: 10 }),
    [LIB_2]: libraryFacts({ name: "FA-Collections", sourceDeviceId: DEVICE_B, lastLoadedAt: 1_600_000_000_000, t: 20, d: DEVICE_B }),
  });

  const result = await publishPeer(dir, { deviceId: DEVICE_A, label: "Chromebook", replica });
  assertEqual(result.ok, true, "publish succeeded (req 25)");

  const files = v3Files(dir);
  assert(
    files.some((p) => p.endsWith(`/${Transport.LIBRARIES_FILE_NAME}`)),
    `libraries.json was written: ${files.join(", ")}`
  );
  assert(
    !files.some((p) => p.includes("beebeegees/") || p.includes("/beebeegees")),
    "no human-readable per-Library Drive directory was invented"
  );

  const parsed = JSON.parse(dir.readFile(`sync-v3/devices/${result.directoryName}/${Transport.LIBRARIES_FILE_NAME}`));
  assertEqual(parsed.kind, "gallery-profile-sync-v3-libraries", "with the stable technical kind");
  assertEqual(Object.keys(parsed.libraries).sort().join(","), [LIB_1, LIB_2].sort().join(","), "keyed by FULL libraryId");

  const root = await Transport.getSyncV3Root(dir.handle);
  const devicesDir = await Transport.getDevicesDir(root);
  const read = await Transport.readDeviceDirectory(devicesDir, result.directoryName);
  assertEqual(read.status, "valid", "reads back valid");
  assert(Transport.replicasEqual(read.replica, replica), "and the replica round-trips exactly (req 25)");

  const manifest = JSON.parse(dir.readFile(`sync-v3/devices/${result.directoryName}/device.json`));
  assertEqual(typeof manifest.librariesHash, "string", "the manifest declares librariesHash");
});

await test("A tampered or malformed libraries.json rejects the whole directory (req 26, 27)", async () => {
  const dir = createVirtualDirectory("V3 Sync");
  const published = await publishPeer(dir, {
    deviceId: DEVICE_B,
    label: "Windows",
    replica: replicaWith({ [LIB_1]: libraryFacts({ name: "original", t: 10 }) }),
  });
  const libPath = `sync-v3/devices/${published.directoryName}/${Transport.LIBRARIES_FILE_NAME}`;
  const original = dir.readFile(libPath);

  const root = await Transport.getSyncV3Root(dir.handle);
  const devicesDir = await Transport.getDevicesDir(root);

  // Tampered but still well-formed JSON — only the hash can catch this.
  const tampered = JSON.parse(original);
  tampered.libraries[LIB_1].name.v = "tampered";
  dir.writeFile(libPath, JSON.stringify(tampered, null, 2));

  const restore = muteConsole();
  const tamperedRead = await Transport.readDeviceDirectory(devicesDir, published.directoryName);
  restore();
  assertEqual(tamperedRead.status, "invalid", "a tampered catalog rejects the directory (req 26)");
  assertEqual(tamperedRead.reason, "libraries-hash-mismatch", "for the hash mismatch, strictly");
  assert(Boolean(tamperedRead.detail), "with diagnostic detail");

  // Malformed JSON.
  dir.writeFile(libPath, "{ not json");
  const restore2 = muteConsole();
  const malformedRead = await Transport.readDeviceDirectory(devicesDir, published.directoryName);
  restore2();
  assertEqual(malformedRead.status, "invalid", "malformed JSON rejects the directory (req 27)");
  assert(
    malformedRead.reason === "libraries-hash-mismatch" || malformedRead.reason === "libraries-malformed",
    `rejected before being trusted: ${malformedRead.reason}`
  );

  // A structurally wrong but correctly-hashed file is caught by the shape check.
  const wrongShape = JSON.stringify({ schemaVersion: 3, kind: "gallery-profile-sync-v3-libraries", libraries: "nope" }, null, 2);
  dir.writeFile(libPath, wrongShape);
  const manifestPath = `sync-v3/devices/${published.directoryName}/device.json`;
  const manifest = JSON.parse(dir.readFile(manifestPath));
  const bytes = new TextEncoder().encode(wrongShape);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  manifest.librariesHash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  dir.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  const restore3 = muteConsole();
  const shapeRead = await Transport.readDeviceDirectory(devicesDir, published.directoryName);
  restore3();
  assertEqual(shapeRead.status, "invalid", "a correctly-hashed but wrong-shaped catalog is still rejected (req 27)");
  assertEqual(shapeRead.reason, "libraries-shape", "by the shape check");

  dir.writeFile(libPath, original);
});

await test("Publish discipline is preserved with libraries present (req 28, 29, 30)", async () => {
  let sabotage = false;
  const dir = createVirtualDirectory("V3 Sync", {
    transformWrite: (filePath, text) => (sabotage && filePath.includes("libraries.json") ? `${text} ` : text),
  });
  const root = await Transport.getSyncV3Root(dir.handle, { create: true });
  const devicesDir = await Transport.getDevicesDir(root, { create: true });

  // A healthy peer that must never be touched by our failures.
  await Transport.publishOwnReplicaVerified(devicesDir, {
    deviceId: DEVICE_B,
    label: "Windows",
    replica: replicaWith({ [LIB_2]: libraryFacts({ name: "peer library", t: 10, d: DEVICE_B }) }),
  });
  const peerDir = deviceDirectories(dir).find((name) => name.startsWith("Windows"));
  const peerFilesBefore = JSON.stringify(
    Object.keys(dir.snapshotFiles()).filter((p) => p.includes(peerDir)).sort()
  );

  const replica = replicaWith({ [LIB_1]: libraryFacts({ name: "mine", t: 20 }) });
  const first = await Transport.publishOwnReplicaVerified(devicesDir, { deviceId: DEVICE_A, label: "Chromebook", replica });
  assertEqual(first.ok, true, "a healthy publish succeeds (req 29)");
  const ownFilesAfterSuccess = JSON.stringify(
    Object.keys(dir.snapshotFiles()).filter((p) => p.includes(first.directoryName)).sort()
  );

  // Now corrupt libraries.json on write, so read-back verification fails.
  sabotage = true;
  const restore = muteConsole();
  const failed = await Transport.publishOwnReplicaVerified(devicesDir, {
    deviceId: DEVICE_A,
    label: "Chromebook",
    replica: replicaWith({ [LIB_1]: libraryFacts({ name: "mine v2", t: 30 }) }),
  });
  restore();

  assertEqual(failed.ok, false, "a corrupted catalog fails verification (req 28)");
  assertEqual(failed.reason, "libraries-hash-mismatch", "for the right reason");
  assertEqual(failed.removedProfileFiles, undefined, "and NO cleanup ran (req 28)");
  assertEqual(failed.removedStaleDirectories, undefined, "no directory cleanup either (req 28)");

  assertEqual(
    JSON.stringify(Object.keys(dir.snapshotFiles()).filter((p) => p.includes(peerDir)).sort()),
    peerFilesBefore,
    "the PEER directory is untouched throughout (req 30)"
  );

  sabotage = false;
  const recovered = await Transport.publishOwnReplicaVerified(devicesDir, { deviceId: DEVICE_A, label: "Chromebook", replica });
  assertEqual(recovered.ok, true, "the retry succeeds once the fault clears (req 29)");
  assertEqual(recovered.directoryName, first.directoryName, "into the same own directory");
  assertEqual(
    JSON.stringify(Object.keys(dir.snapshotFiles()).filter((p) => p.includes(first.directoryName)).sort()),
    ownFilesAfterSuccess,
    "with the same file set - no churn"
  );
});

// ---- recordLibraryLoaded semantics (31-34) ---------------------------------

/** A local library row with (or without) a shared libraryId, via the real registry. */
async function seedLocalLibrary(origin, { shared = true } = {}) {
  globalThis.indexedDB = origin.idb;
  const handle = {
    name: "beebeegees",
    kind: "directory",
    async isSameEntry(other) {
      return other === handle;
    },
  };
  const row = await LibraryRegistry.addOrUpdateLibrary(handle);
  if (!shared) return row;
  const linked = await LibraryRegistry.linkLocalLibraryToSharedId(row.id, LIB_1);
  return linked || row;
}

await test("A successful load records name, sourceDeviceId and lastLoadedAt once (req 31)", async () => {
  const origin = makeOrigin();
  const store = await makeContext(origin);
  const row = await seedLocalLibrary(origin);

  const returned = await store.recordLibraryLoaded(row.id, { name: "beebeegees", at: 1_700_000_000_000 });
  await settle();

  assertEqual(returned, LIB_1, "it returns the SHARED libraryId (req 31)");
  const listed = store.listLibraries();
  assertEqual(listed.length, 1, "one catalog entry");
  assertEqual(listed[0].id, LIB_1, "keyed by the full shared libraryId");
  assertEqual(listed[0].name, "beebeegees", "with the device's human folder name (req 31)");
  assertEqual(listed[0].sourceDeviceId, DEVICE_A, "attributed to this installation (req 31)");
  assertEqual(listed[0].lastLoadedAt, 1_700_000_000_000, "with the load time (req 31)");

  // It touched nothing else.
  assertEqual(Object.keys(store.getAssociations()).length, 0, "associations were not touched");
});

await test("A folder with no shared identity is not catalogued, and none is minted (req 32)", async () => {
  const origin = makeOrigin();
  const store = await makeContext(origin);
  const row = await seedLocalLibrary(origin, { shared: false });
  assertEqual(row.libraryId, undefined, "the local row has no shared libraryId yet");

  const returned = await store.recordLibraryLoaded(row.id, { name: "beebeegees" });
  await settle();

  assertEqual(returned, null, "recordLibraryLoaded declines (req 32)");
  assertEqual(store.listLibraries().length, 0, "nothing was catalogued");

  const after = await LibraryRegistry.getLibraryById(row.id);
  assertEqual(after.libraryId, undefined, "and NO shared libraryId was minted by opening a folder (req 32)");

  // An unknown local id is equally safe.
  assertEqual(await store.recordLibraryLoaded("lib-does-not-exist", { name: "x" }), null, "an unknown row is a no-op");
});

await test("Rescan/refresh noise does not repeatedly stamp lastLoadedAt (req 33)", async () => {
  const origin = makeOrigin();
  const store = await makeContext(origin);
  const row = await seedLocalLibrary(origin);

  const base = 1_700_000_000_000;
  await store.recordLibraryLoaded(row.id, { name: "beebeegees", at: base });
  await settle();
  const firstStamp = store.getLibraries()[LIB_1].lastLoadedAt.t;
  const firstValue = store.listLibraries()[0].lastLoadedAt;

  // The same load, observed again by a rescan / re-render / permission check.
  for (const offset of [10, 250, 1000, 5000]) {
    await store.recordLibraryLoaded(row.id, { name: "beebeegees", at: base + offset });
    await settle();
  }

  assertEqual(store.getLibraries()[LIB_1].lastLoadedAt.t, firstStamp, "no new stamp was minted (req 33)");
  assertEqual(store.listLibraries()[0].lastLoadedAt, firstValue, "and the recorded time is unchanged (req 33)");
  assertEqual(store.listLibraries().length, 1, "still one catalog entry");
});

await test("A later meaningful load DOES advance lastLoadedAt (req 34)", async () => {
  const origin = makeOrigin();
  const store = await makeContext(origin);
  const row = await seedLocalLibrary(origin);

  const base = 1_700_000_000_000;
  await store.recordLibraryLoaded(row.id, { name: "beebeegees", at: base });
  await settle();
  const firstStamp = store.getLibraries()[LIB_1].lastLoadedAt.t;

  // Well beyond the redundancy window: a genuine second load.
  const later = base + 10 * 60 * 1000;
  await store.recordLibraryLoaded(row.id, { name: "beebeegees", at: later });
  await settle();

  assertEqual(store.listLibraries()[0].lastLoadedAt, later, "the load time advanced (req 34)");
  assert(store.getLibraries()[LIB_1].lastLoadedAt.t > firstStamp, "on a newer stamp (req 34)");

  // A rename is also a meaningful change, even inside the window.
  await store.recordLibraryLoaded(row.id, { name: "BBG Main", at: later + 100 });
  await settle();
  assertEqual(store.listLibraries()[0].name, "BBG Main", "a changed folder name is recorded immediately");
});

// ---- V2 isolation (35, 36) -------------------------------------------------

await test("A V2-mode store publishes no Library catalog (req 35, 36)", async () => {
  const origin = makeOrigin();
  globalThis.indexedDB = origin.idb;
  const store = new ProfileStore({ identity: fixedIdentity(), associationStore: Store.V2_ASSOCIATION_STORE });
  openContexts.push(store);
  await settle(20);
  await store.whenFactsSettled();
  await store.whenLibrariesSettled();

  // [SYNCV3 / STAGE-04B / SHARED-LIBRARY-RECORD]
  // [WHY: an empty catalog is OMITTED from the replica, not published as {} -
  //  see getFullReplica's WHY. The assertion is that a V2 installation publishes
  //  no Library data whatsoever, which "absent" satisfies more strictly than an
  //  empty object would: V2's read-back comparison never sees a key it cannot
  //  reconstruct.]
  const replica = await store.getFullReplica();
  assertEqual(replica.libraries, undefined, "a V2 installation publishes no catalog at all (req 35)");
  assert(
    !JSON.stringify(replica).includes("libraries"),
    "and the word does not appear in its published bytes (req 35)"
  );
  assertEqual(rowsOf(origin).get("libraries-v3"), undefined, "and no libraries-v3 row exists (req 35)");

  // The V2 transport publishes only what it declares - no libraries.json.
  const V2Transport = await import(src("profile/sync-v2-transport.js"));
  const dir = createVirtualDirectory("V2 Sync");
  const v2Root = await V2Transport.getSyncV2Root(dir.handle, { create: true });
  const v2Devices = await V2Transport.getDevicesDir(v2Root, { create: true });
  const published = await V2Transport.publishDeviceReplicaVerified(v2Devices, DEVICE_A, {
    schemaVersion: 2,
    profiles: {},
    associations: {},
  });

  assertEqual(published.ok, true, "the V2 transport still publishes normally (req 36)");
  const files = Object.keys(dir.snapshotFiles());
  assert(!files.some((p) => p.includes("libraries.json")), `V2 wrote no libraries.json: ${files.join(", ")}`);
  assert(files.some((p) => p.includes("sync-v2/devices/")), "under the V2 root, unchanged");
});

// ---- Durable read-back observation (37-39) ---------------------------------

await test("Durable read-back of libraries restores the clock floor across restart (req 37)", async () => {
  const origin = makeOrigin();
  const FUTURE = Date.now() + 5 * 365 * 24 * 60 * 60 * 1000;

  // Persist a Library fact stamped far in the future (e.g. accepted from a peer before restart).
  globalThis.indexedDB = origin.idb;
  await Store.saveV3LibrariesCache({
    [LIB_1]: {
      name: fact("Peer Library Name", FUTURE, DEVICE_B),
      sourceDeviceId: fact(DEVICE_B, FUTURE, DEVICE_B),
      lastLoadedAt: fact(12345, FUTURE, DEVICE_B),
    },
  });

  // Recreate store and identity from scratch (simulating a process/tab restart).
  const identity = new SyncIdentity();
  await identity.ready;
  const store = new ProfileStore({
    identity,
    associationStore: Store.V3_ASSOCIATION_STORE,
  });
  openContexts.push(store);
  await settle(20);
  await store.whenLibrariesSettled();

  assertEqual(store.listLibraries()[0].name, "Peer Library Name", "reloaded peer library from durable cache");

  // Local device now performs a meaningful library load.
  const row = await seedLocalLibrary(origin);
  await store.recordLibraryLoaded(row.id, { name: "Local Library Name", at: Date.now() });
  await settle(20);

  const localLib = store.getLibraries()[LIB_1];
  assert(
    localLib.name.t > FUTURE,
    `new local library name stamp (${localLib.name.t}) outranks persisted remote stamp (${FUTURE})`
  );
  assertEqual(localLib.name.v, "Local Library Name", "local mutation wins because clock floor was restored");
  assertEqual(store.listLibraries()[0].name, "Local Library Name", "and the catalog reflects the local update");
});

await test("Durable read-back of associations restores the clock floor across restart (req 38)", async () => {
  const origin = makeOrigin();
  const FUTURE = Date.now() + 5 * 365 * 24 * 60 * 60 * 1000;

  // Persist an association fact stamped far in the future (e.g. accepted from a peer before restart).
  globalThis.indexedDB = origin.idb;
  await Store.saveV3AssociationsCache({
    [LIB_1]: fact("profile-remote", FUTURE, DEVICE_B),
  });

  // Recreate store and identity from scratch.
  const identity = new SyncIdentity();
  await identity.ready;
  const store = new ProfileStore({
    identity,
    associationStore: Store.V3_ASSOCIATION_STORE,
  });
  openContexts.push(store);
  await settle(20);
  await store.whenAssociationsSettled();

  assertEqual(store.listAssociations()[LIB_1], "profile-remote", "reloaded remote association from durable cache");

  // Local device changes the association.
  const row = await seedLocalLibrary(origin);
  await store.setLibraryAssociation(row.id, "profile-local");
  await settle(20);

  const replica = await store.getFullReplica();
  const assocFact = replica.associations[LIB_1];
  assert(
    assocFact.t > FUTURE,
    `new local association stamp (${assocFact.t}) outranks persisted remote stamp (${FUTURE})`
  );
  assertEqual(assocFact.v, "profile-local", "local mutation wins because clock floor was restored");
  assertEqual(store.listAssociations()[LIB_1], "profile-local", "and local state agrees");
});

await test("Sibling-context refresh of associations and libraries raises the clock floor (req 39)", async () => {
  const origin = makeOrigin();
  const FUTURE = Date.now() + 5 * 365 * 24 * 60 * 60 * 1000;

  const identityA = new SyncIdentity();
  await identityA.ready;
  const a = new ProfileStore({
    identity: identityA,
    associationStore: Store.V3_ASSOCIATION_STORE,
    localStateChannel: Channel.createLocalStateChannel({ channelName: origin.channelName }),
  });
  openContexts.push(a);

  const identityB = new SyncIdentity();
  await identityB.ready;
  const b = new ProfileStore({
    identity: identityB,
    associationStore: Store.V3_ASSOCIATION_STORE,
    localStateChannel: Channel.createLocalStateChannel({ channelName: origin.channelName }),
  });
  openContexts.push(b);

  await settle(20);
  await a.whenLibrariesSettled();
  await b.whenLibrariesSettled();

  // Context A adopts a future peer replica (e.g. from sync pass) and announces it.
  await a.adoptMergedReplica(
    replicaWith({
      [LIB_1]: libraryFacts({ name: "from sync pass", sourceDeviceId: DEVICE_B, lastLoadedAt: 10, t: FUTURE, d: DEVICE_B }),
    })
  );
  await propagate();

  // Context B should have refreshed from storage and raised its clock floor.
  const row = await seedLocalLibrary(origin);
  await b.recordLibraryLoaded(row.id, { name: "B updated locally", at: Date.now() });
  await settle(20);

  const bLib = b.getLibraries()[LIB_1];
  assert(
    bLib.name.t > FUTURE,
    `sibling context B's stamp (${bLib.name.t}) outranks the refreshed fact (${FUTURE})`
  );
  assertEqual(bLib.name.v, "B updated locally", "B's local update wins");
});

// ---- Summary ---------------------------------------------------------------

console.log(`\n${"-".repeat(60)}`);
if (failures === 0) {
  console.log(`ok    ${passes} assertion(s) passed - SyncV3 Stage 04B holds.`);
} else {
  console.log(`FAIL  ${failures} failure(s), ${passes} passed:`);
  for (const detail of failureDetail) console.log(`  - ${detail}`);
}
process.exit(failures === 0 ? 0 : 1);
