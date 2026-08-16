#!/usr/bin/env node
// [PHASE-6-SYNC-V2]
// [STAGE-D2-TRANSPORT]
// [WHY: D1 proved local mutations become correctly stamped facts; this proves
//  those facts actually CONVERGE across independent installations through the
//  one-writer-per-device file layout — concurrent writers not colliding,
//  one corrupt/mid-write peer not poisoning healthy ones, a device's own
//  publish never accepted unless it survives read-back verification, and V1
//  contributing recovery data without ever being written to. Every property
//  Stage C proved about the merge algebra in the abstract is only real once
//  it is proven to survive the filesystem — that is this harness's job.]
//
// Usage:  node tools/test-sync-v2-transport.mjs
// Exits non-zero on any failure, matching the other harnesses.
//
// MULTI-DEVICE SIMULATION: each simulated device gets its OWN fake IndexedDB
// (installFakeIndexedDB() creates a fresh, independent one every call) so its
// local Profile state is genuinely isolated from every other device's, the
// same way two separate browser installations are. All devices share ONE
// virtual sync folder (createVirtualDirectory) — that folder is the only
// thing they have in common, exactly like a shared Drive folder. Because this
// is single-threaded Node rather than truly parallel browsers, "concurrent"
// publishes are simulated as independent, UNCOORDINATED passes (neither
// device aware of the other's not-yet-published state) rather than literally
// simultaneous — what is actually proven is that neither publish depends on,
// blocks, or collides with the other's writable path, which is the property
// the approved plan asks for.

import { pathToFileURL } from "node:url";
import path from "node:path";
import { installFakeIndexedDB, createVirtualDirectory, settle, muteConsole } from "./lib/browser-test-env.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const src = (rel) => pathToFileURL(path.join(ROOT, "src", rel)).href;

const { setSnapshotFreezeEnabled } = await import(src("profile/profile-snapshot.js"));
setSnapshotFreezeEnabled(true);
const { setFactCheckEnabled } = await import(src("profile/profile-store.js"));
setFactCheckEnabled(true);

const { ProfileStore } = await import(src("profile/profile-store.js"));
const { SyncIdentity } = await import(src("profile/sync-device.js"));
const { runSyncV2Pass } = await import(src("profile/sync-v2.js"));
const Transport = await import(src("profile/sync-v2-transport.js"));
const { seedFromV1, readV1ProfilesReadOnly } = await import(src("profile/sync-v2-migration.js"));
const Facts = await import(src("profile/sync-facts.js"));
const { loadProfileData, deleteProfileData } = await import(src("profile/indexeddb.js"));

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

function assertDeepEqual(actual, expected, label) {
  const a = JSON.stringify(sortDeep(actual));
  const b = JSON.stringify(sortDeep(expected));
  return assert(a === b, label, a === b ? null : `expected: ${b}\n        actual:   ${a}`);
}

function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortDeep(value[key]);
    return out;
  }
  return value;
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

// ---- Multi-device fixture ---------------------------------------------------

// Each device gets its own fake IndexedDB (fresh state, genuinely isolated —
// see the module header). `idb` is captured so we can re-activate this exact
// device's storage later, after another device's operations have swapped the
// global to THEIRS.
async function makeDevice() {
  installFakeIndexedDB();
  const idb = globalThis.indexedDB;
  const identity = new SyncIdentity();
  await identity.ready;
  const store = new ProfileStore({ identity });
  await settle();
  await store.whenFactsSettled();
  return { idb, identity, store };
}

function activate(device) {
  globalThis.indexedDB = device.idb;
}

/** Runs `fn` with `device`'s own storage active. Devices never run concurrently. */
async function on(device, fn) {
  activate(device);
  return fn(device);
}

async function quiesce(device) {
  return on(device, async () => {
    await device.store.whenFactsSettled();
    await settle();
    await device.store.whenFactsSettled();
  });
}

async function syncPass(device, dirHandle) {
  return on(device, () => runSyncV2Pass({ profileStore: device.store, dirHandle }));
}

const SUNRISE = "Nature/Sunrise.mp4";
const RAIN = "Nature/Rain.mp4";
const STORM = "Nature/Storm.mp4";

function readOwnFiles(dir, deviceId) {
  const files = dir.snapshotFiles();
  const prefix = `sync-v2/devices/${deviceId}/`;
  const out = {};
  for (const [path, text] of Object.entries(files)) {
    if (path.startsWith(prefix)) out[path.slice(prefix.length)] = text;
  }
  return out;
}

// =========================================================================
// 1. First V2 publish
// =========================================================================

await test("1. a fresh device's first sync pass publishes device.json last, with valid hashes", async () => {
  const dir = createVirtualDirectory();
  const a = await makeDevice();
  const profileId = await on(a, () => a.store.getProfileId());

  await on(a, () => a.store.setFavorite(SUNRISE, true));
  await quiesce(a);

  const result = await syncPass(a, dir.handle);
  assertEqual(result.status, "ok", "the pass reported ok");
  assertEqual(result.published, true, "a fresh device always has something to publish");

  const files = readOwnFiles(dir, a.identity.deviceId);
  assert(Boolean(files["device.json"]), "device.json was written");
  assert(Boolean(files[`profiles/${profileId}.json`]), "the profile facts file was written");
  assert(Boolean(files["associations.json"]), "the associations file was written");

  const manifest = JSON.parse(files["device.json"]);
  assertEqual(manifest.deviceId, a.identity.deviceId, "device.json declares its own deviceId");
  assertEqual(manifest.profiles.length, 1, "device.json declares exactly one profile");

  const readBack = await Transport.readDeviceReplica(
    await Transport.getDevicesDir(await Transport.getSyncV2Root(dir.handle)),
    a.identity.deviceId
  );
  assertEqual(readBack.status, "valid", "the published generation reads back as valid");
  assertEqual(readBack.replica.profiles[profileId].items[SUNRISE].favorite.v.on, true, "…with the real content");

  // Order: every write for device.json's own writeIndex must precede it —
  // the log records writes in commit order.
  const writeOps = dir.log.filter((entry) => entry.op === "write");
  const deviceJsonIndex = writeOps.findIndex((entry) => entry.path.endsWith("device.json"));
  assert(deviceJsonIndex === writeOps.length - 1, "device.json was written LAST");
});

// =========================================================================
// 2. Two devices publish independently and BOTH sets survive
// =========================================================================

await test("2. two devices' publishes both survive and converge on a third pass", async () => {
  const dir = createVirtualDirectory();
  const a = await makeDevice();
  const sharedProfileId = await on(a, () => a.store.getProfileId());

  await on(a, () => a.store.setFavorite(SUNRISE, true));
  await quiesce(a);
  await syncPass(a, dir.handle);

  // B is a second installation of the SAME Gallery — it discovers the shared
  // Profile from A's publish, switches to it, then contributes its own
  // curation, all before ever seeing A publish again ("uncoordinated").
  const b = await makeDevice();
  await syncPass(b, dir.handle); // adopts the profile A published, into B's registry
  await on(b, () => b.store.switchProfile(sharedProfileId));
  await quiesce(b);
  await on(b, () => b.store.setHidden(RAIN, true));
  await quiesce(b);
  const publishB = await syncPass(b, dir.handle);
  assertEqual(publishB.status, "ok", "B's pass succeeded");

  // A has NOT seen B's second publish yet — a third pass is what converges them.
  const converge = await syncPass(a, dir.handle);
  assertEqual(converge.status, "ok", "A's converging pass succeeded");

  const projected = await on(a, () => Facts.projectProfile(
    { schemaVersion: 2, profiles: { [sharedProfileId]: a.store.getFacts() }, associations: {} },
    sharedProfileId
  ));
  assert(
    projected.favorites.some((f) => f.path === SUNRISE),
    "A's own favorite survived the round trip"
  );
  assert(projected.hidden.includes(RAIN), "B's hidden flag arrived and was adopted");

  const localFavorite = await on(a, () => a.store.isFavorite(SUNRISE));
  const localHidden = await on(a, () => a.store.isHidden(RAIN));
  assertEqual(localFavorite, true, "…reflected in A's local state too");
  assertEqual(localHidden, true, "…both fields, from two independent writers");
});

// =========================================================================
// 3. Three-device convergence under interleaving
// =========================================================================

await test("3. three devices converge to the same state regardless of pass order", async () => {
  const dir = createVirtualDirectory();
  const a = await makeDevice();
  const sharedProfileId = await on(a, () => a.store.getProfileId());
  await on(a, () => a.store.setFavorite(SUNRISE, true));
  await quiesce(a);
  await syncPass(a, dir.handle);

  const b = await makeDevice();
  await syncPass(b, dir.handle);
  await on(b, () => b.store.switchProfile(sharedProfileId));
  await quiesce(b);
  await on(b, () => b.store.setHidden(RAIN, true));
  await quiesce(b);
  await syncPass(b, dir.handle);

  const c = await makeDevice();
  await syncPass(c, dir.handle);
  await on(c, () => c.store.switchProfile(sharedProfileId));
  await quiesce(c);
  const tag = await on(c, () => c.store.createTag("GAMMA"));
  await on(c, () => c.store.setItemTag(STORM, tag.id, true));
  await quiesce(c);
  await syncPass(c, dir.handle);

  // Scrambled re-sync order: B, A, C, A again.
  await syncPass(b, dir.handle);
  await syncPass(a, dir.handle);
  await syncPass(c, dir.handle);
  await syncPass(a, dir.handle);

  for (const [label, device] of [["A", a], ["B", b], ["C", c]]) {
    const projected = await on(device, () =>
      Facts.projectProfile(
        { schemaVersion: 2, profiles: { [sharedProfileId]: device.store.getFacts() }, associations: {} },
        sharedProfileId
      )
    );
    assert(projected.favorites.some((f) => f.path === SUNRISE), `${label}: has A's favorite`);
    assert(projected.hidden.includes(RAIN), `${label}: has B's hidden flag`);
    assert(
      (projected.itemTags[STORM] || []).includes(tag.id),
      `${label}: has C's tag assignment`
    );
  }
});

// =========================================================================
// 4. Offline mutations + rejoin
// =========================================================================

await test("4. offline mutations are preserved and merge cleanly on rejoin", async () => {
  const dir = createVirtualDirectory();
  const a = await makeDevice();
  const profileId = await on(a, () => a.store.getProfileId());
  await on(a, () => a.store.setFavorite(SUNRISE, true));
  await quiesce(a);
  await syncPass(a, dir.handle);

  const b = await makeDevice();
  await syncPass(b, dir.handle);
  await on(b, () => b.store.switchProfile(profileId));
  await quiesce(b);

  // A goes "offline": several local mutations, no sync pass at all.
  await on(a, () => a.store.setHidden(RAIN, true));
  await on(a, () => a.store.createTag("OFFLINE"));
  await quiesce(a);
  const offlineTag = await on(a, () => a.store.getTags().find((t) => t.name === "OFFLINE"));
  await on(a, () => a.store.setItemTag(STORM, offlineTag.id, true));
  await quiesce(a);

  assertEqual(await on(a, () => a.store.isFavorite(SUNRISE)), true, "offline mutations still work locally");

  // Rejoin: A's next pass merges instead of prompting Keep Local / Use Synced —
  // there is no such prompt anywhere in this design; it is just a merge.
  const rejoin = await syncPass(a, dir.handle);
  assertEqual(rejoin.status, "ok", "rejoin pass succeeded with no user decision needed");

  await syncPass(b, dir.handle);
  const bHasIt = await on(b, () =>
    b.store.hasItemTag(STORM, b.store.getTags().find((t) => t.name === "OFFLINE")?.id)
  );
  assertEqual(await on(b, () => b.store.isHidden(RAIN)), true, "B received A's offline hidden-flag mutation");
  assertEqual(bHasIt, true, "…and A's offline tag assignment");
});

// =========================================================================
// 5. A stale device repeatedly republishing a deleted tag cannot resurrect it
// =========================================================================

await test("5. repeated stale re-syncs cannot resurrect a tombstoned tag (no zombies)", async () => {
  const dir = createVirtualDirectory();
  const a = await makeDevice();
  const profileId = await on(a, () => a.store.getProfileId());
  const tag = await on(a, () => a.store.createTag("DOOMED"));
  await on(a, () => a.store.setItemTag(SUNRISE, tag.id, true));
  await quiesce(a);
  await syncPass(a, dir.handle);

  const b = await makeDevice();
  await syncPass(b, dir.handle);
  await on(b, () => b.store.switchProfile(profileId));
  await quiesce(b);
  await on(b, () => b.store.deleteTag(tag.id)); // the tombstone
  await quiesce(b);
  await syncPass(b, dir.handle);

  // A repeatedly re-syncs WITHOUT ever locally re-creating the tag — each pass
  // merges in B's (newer) tombstone. Proving this stays dead across several
  // redundant passes is the idempotence half of "no zombies".
  for (let i = 0; i < 4; i++) {
    await syncPass(a, dir.handle);
    assertEqual(
      await on(a, () => a.store.getTags().some((t) => t.id === tag.id)),
      false,
      `pass ${i + 1}: the tag has not resurrected on A`
    );
  }

  for (let i = 0; i < 3; i++) await syncPass(b, dir.handle);
  assertEqual(await on(b, () => b.store.getTags().some((t) => t.id === tag.id)), false, "…nor on B");

  const facts = await on(a, () => a.store.getFacts());
  assertEqual(facts.tags[tag.id].deleted.v, true, "the tombstone fact itself is present and true");
});

// =========================================================================
// 6. Own publish read-back mismatch => metadata does not advance, no cleanup
// =========================================================================

await test("6. a corrupted own publish reports verify-failed and changes nothing", async () => {
  const dir = createVirtualDirectory();
  const a = await makeDevice();
  await on(a, () => a.store.setFavorite(SUNRISE, true));
  await quiesce(a);
  const first = await syncPass(a, dir.handle);
  assertEqual(first.status, "ok", "the first, uncorrupted publish succeeds");
  const beforeFiles = readOwnFiles(dir, a.identity.deviceId);

  // Corrupt exactly one profile file's bytes on the way to disk — same
  // fault-injection technique Stage B's test 6 uses. Armed for exactly one
  // write so the RETRY later in this test is not corrupted too.
  const dirtyProfileId = await on(a, () => a.store.getProfileId());
  const dirtyPath = `sync-v2/devices/${a.identity.deviceId}/profiles/${dirtyProfileId}.json`;
  let armFault = true;
  const dirty = createVirtualDirectory("dirty", {
    transformWrite: (path, text) => {
      if (path === dirtyPath && armFault) {
        armFault = false;
        return text + "TAMPERED";
      }
      return text;
    },
  });
  // Re-seed the dirty fixture with the already-published, uncorrupted state so
  // this reproduces "a SUBSEQUENT publish is corrupted", not "the first one".
  for (const [relPath, text] of Object.entries(dir.snapshotFiles())) dirty.writeFile(relPath, text);

  await on(a, () => a.store.setHidden(RAIN, true));
  await quiesce(a);
  const restoreConsole = muteConsole();
  const second = await syncPass(a, dirty.handle);
  restoreConsole();

  assertEqual(second.status, "verify-failed", "the corrupted publish is reported as verify-failed");
  const afterFiles = readOwnFiles(dirty, a.identity.deviceId);
  assert(
    afterFiles[`profiles/${dirtyProfileId}.json`] !== beforeFiles[`profiles/${dirtyProfileId}.json`],
    "the corrupted bytes did land on disk (the fault injection took effect)"
  );

  // Local Profile data is completely unaffected — the corruption only ever
  // touched the OUTBOUND publish, never anything read back into ProfileStore.
  assertEqual(await on(a, () => a.store.isFavorite(SUNRISE)), true, "local data remains intact");
  assertEqual(await on(a, () => a.store.isHidden(RAIN)), true, "…including the mutation that triggered this pass");

  // Republishing (uncorrupted this time) must still succeed — verify-failed is
  // recoverable, not a permanent wedge.
  const retry = await syncPass(a, dirty.handle);
  assertEqual(retry.status, "ok", "a subsequent clean publish recovers");
});

// =========================================================================
// 7. A peer mid-write (no device.json yet) is treated as empty, not merged
// =========================================================================

await test("7. a peer mid-first-write (device.json not yet committed) is ignored, not merged or errored", async () => {
  const dir = createVirtualDirectory();
  const a = await makeDevice();
  await on(a, () => a.store.setFavorite(SUNRISE, true));
  await quiesce(a);

  // A "peer" that has written its profile file but not yet its device.json —
  // exactly mid-write, before the commit point.
  dir.writeFile(
    "sync-v2/devices/dev-midwrite/profiles/ghost-profile.json",
    JSON.stringify({ schemaVersion: 2, kind: "gallery-profile-sync-v2-facts", profileId: "ghost-profile", facts: {} })
  );

  const result = await syncPass(a, dir.handle);
  assertEqual(result.status, "ok", "the pass completes normally");
  assertDeepEqual(result.skippedPeers, [], "a mid-write peer is NOT reported as skipped/corrupt — it's simply not there yet");
  assertEqual(
    await on(a, () => a.store.listProfiles().some((p) => p.id === "ghost-profile")),
    false,
    "its (uncommitted) profile was not adopted"
  );
});

// =========================================================================
// 8. One corrupt peer does not poison a healthy peer
// =========================================================================

await test("8. a corrupt peer is skipped while a healthy peer still merges", async () => {
  const dir = createVirtualDirectory();
  const a = await makeDevice();
  const profileId = await on(a, () => a.store.getProfileId());
  await on(a, () => a.store.setFavorite(SUNRISE, true));
  await quiesce(a);
  await syncPass(a, dir.handle);

  const b = await makeDevice();
  await syncPass(b, dir.handle);
  await on(b, () => b.store.switchProfile(profileId));
  await quiesce(b);
  await on(b, () => b.store.setHidden(RAIN, true));
  await quiesce(b);
  await syncPass(b, dir.handle);

  // Corrupt device B's own profile file directly on disk (a byte-level tamper,
  // not through the write path) — the exact signature of a torn/corrupted
  // generation from a peer — BEFORE any other device can gossip B's (still
  // healthy, at the time it was written) hidden flag onward. Otherwise C would
  // simply absorb it from B during its own pass and carry it forward,
  // which would prove nothing about corruption handling.
  const bProfilePath = `sync-v2/devices/${b.identity.deviceId}/profiles/${profileId}.json`;
  dir.writeFile(bProfilePath, dir.readFile(bProfilePath) + "CORRUPTED");

  const c = await makeDevice();
  const muteC = muteConsole();
  await syncPass(c, dir.handle);
  muteC();
  await on(c, () => c.store.switchProfile(profileId));
  await quiesce(c);
  const tag = await on(c, () => c.store.createTag("HEALTHY"));
  await on(c, () => c.store.setItemTag(STORM, tag.id, true));
  await quiesce(c);
  const muteC2 = muteConsole();
  await syncPass(c, dir.handle);
  muteC2();

  const d = await makeDevice();
  const restoreConsole = muteConsole();
  const result = await syncPass(d, dir.handle);
  restoreConsole();

  assertEqual(result.status, "ok", "the pass still completes");
  assert(
    result.skippedPeers.some((p) => p.deviceId === b.identity.deviceId),
    "the corrupt peer (B) was reported as skipped"
  );
  assertEqual(result.mergedPeers, 2, "the two healthy peers (A, C) were still merged");

  await on(d, () => d.store.switchProfile(profileId));
  await quiesce(d);
  assertEqual(await on(d, () => d.store.isFavorite(SUNRISE)), true, "A's (healthy) contribution merged");
  assertEqual(await on(d, () => d.store.isHidden(RAIN)), false, "B's (corrupt) contribution did NOT merge");
  assertEqual(await on(d, () => d.store.hasItemTag(STORM, tag.id)), true, "C's (healthy) contribution merged");
});

// =========================================================================
// 8a. Content tampering that stays valid JSON is still caught by the hash
// =========================================================================

await test("8a. tampering a profile file's content (still valid JSON) is caught by the declared hash", async () => {
  const dir = createVirtualDirectory();
  const a = await makeDevice();
  const profileId = await on(a, () => a.store.getProfileId());
  await on(a, () => a.store.setFavorite(SUNRISE, true));
  await quiesce(a);
  await syncPass(a, dir.handle);

  // Flip a value in place — the file is still perfectly valid, well-shaped
  // JSON, so only the declared hash can catch this.
  const filePath = `sync-v2/devices/${a.identity.deviceId}/profiles/${profileId}.json`;
  dir.writeFile(filePath, dir.readFile(filePath).replace('"on": true', '"on": false'));

  const devicesDir = await Transport.getDevicesDir(await Transport.getSyncV2Root(dir.handle));
  const readBack = await Transport.readDeviceReplica(devicesDir, a.identity.deviceId);
  assertEqual(readBack.status, "invalid", "content tampering that preserves valid JSON is still rejected");
});

// =========================================================================
// 9. Profile isolation through a full transport round-trip
// =========================================================================

await test("9. two Profiles remain isolated through publish, peer-read and adoption", async () => {
  const dir = createVirtualDirectory();
  const a = await makeDevice();
  const beast = await on(a, () => a.store.createProfile("BEAST"));
  await on(a, () => a.store.switchProfile(beast.id));
  await quiesce(a);
  await on(a, () => a.store.setFavorite(SUNRISE, true));
  await quiesce(a);
  await syncPass(a, dir.handle);

  const bbg4 = await on(a, () => a.store.createProfile("BBG4"));
  await on(a, () => a.store.switchProfile(bbg4.id));
  await quiesce(a);
  await on(a, () => a.store.setHidden(RAIN, true));
  await quiesce(a);
  await syncPass(a, dir.handle);

  const b = await makeDevice();
  await syncPass(b, dir.handle);

  await on(b, () => b.store.switchProfile(beast.id));
  await quiesce(b);
  assertEqual(await on(b, () => b.store.isFavorite(SUNRISE)), true, "BEAST's favorite arrived on B");
  assertEqual(await on(b, () => b.store.isHidden(RAIN)), false, "…without BBG4's hidden flag leaking in");

  await on(b, () => b.store.switchProfile(bbg4.id));
  await quiesce(b);
  assertEqual(await on(b, () => b.store.isHidden(RAIN)), true, "BBG4's hidden flag arrived on B");
  assertEqual(await on(b, () => b.store.isFavorite(SUNRISE)), false, "…without BEAST's favorite leaking in");
});

// =========================================================================
// 10. Active Profile ≠ associated Profile remains safe through sync
// =========================================================================

await test("10. a mutation follows the ACTIVE profile through a sync pass, regardless of associations", async () => {
  const dir = createVirtualDirectory();
  const a = await makeDevice();
  const beast = await on(a, () => a.store.createProfile("BEAST"));
  const bbg4 = await on(a, () => a.store.createProfile("BBG4"));
  await on(a, () => a.store.switchProfile(bbg4.id));
  await quiesce(a);
  await on(a, () => a.store.setFavorite(SUNRISE, true));
  await quiesce(a);

  const result = await syncPass(a, dir.handle);
  assertEqual(result.status, "ok", "the pass succeeded");

  const devicesDir = await Transport.getDevicesDir(await Transport.getSyncV2Root(dir.handle));
  const own = await Transport.readDeviceReplica(devicesDir, a.identity.deviceId);
  assertEqual(own.replica.profiles[bbg4.id].items[SUNRISE].favorite.v.on, true, "published under the ACTIVE profile");
  assertEqual(own.replica.profiles[beast.id]?.items?.[SUNRISE], undefined, "not under the merely-associated one");
  assertDeepEqual(own.replica.associations, {}, "no association content was published by this device (D3 scope)");
});

// =========================================================================
// 11. V1 seeds recoverable state without ever writing to V1
// =========================================================================

await test("11. V1 seeding reads an inconsistent V1 generation without modifying it", async () => {
  const dir = createVirtualDirectory();
  const v1ProfileId = "v1-profile-1";

  // An INCONSISTENT V1 generation, exactly like profile-sync.js's documented
  // stuck state: the manifest fingerprint does not match the files. Seeding
  // must not care — it never even reads manifest.json.
  dir.writeFile("manifest.json", JSON.stringify({ kind: "gallery-profile-sync-manifest", profileIds: [v1ProfileId], fingerprint: "stale-and-wrong" }));
  dir.writeFile(
    `profiles/${v1ProfileId}.json`,
    JSON.stringify({
      kind: "gallery-profile",
      profileId: v1ProfileId,
      profileName: "V1 Gallery",
      items: { [SUNRISE]: { favorite: true, favoritedAt: 1600000000000 } },
      tags: [{ id: "v1-tag", name: "V1TAG" }],
    })
  );

  const beforeSnapshot = JSON.stringify(dir.snapshotFiles());
  const beforeLogLength = dir.log.length;

  const a = await makeDevice();
  const localReplica = await on(a, () => a.store.getFullReplica());
  const { replica: seeded, seededProfileIds } = await seedFromV1(dir.handle, localReplica, a.identity.deviceId);

  assertDeepEqual(seededProfileIds, [v1ProfileId], "the V1 profile was discovered");
  assertEqual(seeded.profiles[v1ProfileId].items[SUNRISE].favorite.v.on, true, "its favorite was seeded");
  assertEqual(seeded.profiles[v1ProfileId].tags["v1-tag"].name.v, "V1TAG", "its tag vocabulary was seeded");
  assertEqual(
    seeded.profiles[v1ProfileId].items[SUNRISE].favorite.t,
    1,
    "seeded at V1_SEED_T — below even the ordinary local seed floor"
  );

  // V1 is untouched: byte-identical files, and not a single write/remove op.
  assertEqual(JSON.stringify(dir.snapshotFiles()), beforeSnapshot, "every V1 byte is unchanged");
  assertEqual(dir.log.length, beforeLogLength, "no write or remove operation touched the folder at all");

  // "Local seed outranks V1 where the same fact disagrees": rewrite the V1
  // file to use A's OWN local profile id and assert the opposite of what A
  // already has locally. A real (higher-stamped) local mutation must survive
  // adopting the V1 seed unchanged.
  const localProfileId = await on(a, () => a.store.getProfileId());
  await on(a, () => a.store.setFavorite(SUNRISE, false)); // real, higher-stamped local fact
  await quiesce(a);

  dir.writeFile(
    `profiles/${localProfileId}.json`,
    JSON.stringify({
      kind: "gallery-profile",
      profileId: localProfileId,
      profileName: "From V1",
      items: { [SUNRISE]: { favorite: true, favoritedAt: 1600000000000 } }, // disagrees with local
      tags: [],
    })
  );

  const localReplica2 = await on(a, () => a.store.getFullReplica());
  const { replica: conflictSeeded } = await seedFromV1(dir.handle, localReplica2, a.identity.deviceId);
  await on(a, () => a.store.adoptMergedReplica(conflictSeeded));
  await quiesce(a);

  assertEqual(
    await on(a, () => a.store.isFavorite(SUNRISE)),
    false,
    "local's real un-favorite outranked V1's conflicting seeded favorite"
  );
});

// =========================================================================
// 12. Local/session-only fields never enter V2 replica bytes
// =========================================================================

await test("12. tagActivity and other local-only fields never appear in published bytes", async () => {
  const dir = createVirtualDirectory();
  const a = await makeDevice();
  const tag = await on(a, () => a.store.createTag("ALPHA"));
  await on(a, () => a.store.setItemTag(SUNRISE, tag.id, true));
  await quiesce(a);
  await on(a, () => a.store.recordTagActivity(tag.id, { position: 3, total: 10, shuffle: false }));
  await quiesce(a);

  await syncPass(a, dir.handle);

  const files = readOwnFiles(dir, a.identity.deviceId);
  const blob = Object.values(files).join("\n");
  assert(!blob.includes("tagActivity"), "tagActivity does not appear anywhere in published bytes");
  assert(!blob.includes("lastTagPosition"), "…nor lastTagPosition");
  assert(!blob.includes("shuffleOff"), "…nor the shuffle-mode resume buckets");

  // And local state still has it — nothing was stripped locally either.
  const activity = await on(a, () => a.store.getTagActivity(tag.id));
  assertEqual(activity.shuffleOff.position, 3, "the local resume position survived the sync pass untouched");
});

// =========================================================================
// 13. Replay / idempotence
// =========================================================================

await test("13. re-running a pass with nothing new to say publishes nothing new", async () => {
  const dir = createVirtualDirectory();
  const a = await makeDevice();
  await on(a, () => a.store.setFavorite(SUNRISE, true));
  await quiesce(a);

  const first = await syncPass(a, dir.handle);
  assertEqual(first.published, true, "the first pass published");

  const filesAfterFirst = JSON.stringify(readOwnFiles(dir, a.identity.deviceId));
  const second = await syncPass(a, dir.handle);
  assertEqual(second.published, false, "an unchanged second pass does not republish");
  assertEqual(
    JSON.stringify(readOwnFiles(dir, a.identity.deviceId)),
    filesAfterFirst,
    "…and the on-disk bytes are unchanged"
  );

  const b = await makeDevice();
  await syncPass(b, dir.handle);
  await syncPass(b, dir.handle);
  await syncPass(b, dir.handle);
  const state1 = await on(b, () => b.store.getFullReplica());
  await syncPass(b, dir.handle);
  const state2 = await on(b, () => b.store.getFullReplica());
  assertDeepEqual(state1, state2, "repeated redundant passes converge to a fixed point");
});

// =========================================================================
// 14. No device ever writes outside its own deviceId subtree
// =========================================================================

await test("14. a device's sync pass never touches another device's files", async () => {
  const dir = createVirtualDirectory();
  const a = await makeDevice();
  await on(a, () => a.store.setFavorite(SUNRISE, true));
  await quiesce(a);
  await syncPass(a, dir.handle);

  const b = await makeDevice();
  await syncPass(b, dir.handle);
  await on(b, () => b.store.setHidden(RAIN, true));
  await quiesce(b);
  await syncPass(b, dir.handle);

  const bFilesBefore = JSON.stringify(readOwnFiles(dir, b.identity.deviceId));

  // A does substantial further work and several more passes.
  await on(a, () => a.store.createTag("MORE"));
  await quiesce(a);
  await syncPass(a, dir.handle);
  await syncPass(a, dir.handle);

  assertEqual(
    JSON.stringify(readOwnFiles(dir, b.identity.deviceId)),
    bFilesBefore,
    "B's entire subtree is byte-identical after A's activity — A never wrote there"
  );

  assert(
    (() => {
      try {
        Transport.assertOwnDeviceScope("../escape");
        return false;
      } catch {
        return true;
      }
    })(),
    "the runtime guard rejects a path-escaping deviceId"
  );
  assert(
    (() => {
      try {
        Transport.assertOwnDeviceScope(b.identity.deviceId + "/../" + a.identity.deviceId);
        return false;
      } catch {
        return true;
      }
    })(),
    "…and rejects a deviceId that embeds another device's id via a path separator"
  );
});

// =========================================================================
// 15. Obsolete own profile files are cleaned only after a verified publish
// =========================================================================

await test("15. cleanup of a device's own obsolete profile file happens only on verified success", async () => {
  const dir = createVirtualDirectory();
  const a = await makeDevice();
  const first = await on(a, () => a.store.getProfileId());
  const second = await on(a, () => a.store.createProfile("SECOND"));
  // A profile is only included in getFullReplica() once it has been seeded —
  // which only happens once it has been loaded (switched to). Give it real
  // curation, same as a user actually would, before publishing.
  await on(a, () => a.store.switchProfile(second.id));
  await quiesce(a);
  await on(a, () => a.store.setFavorite(SUNRISE, true));
  await quiesce(a);
  await on(a, () => a.store.switchProfile(first));
  await quiesce(a);
  await syncPass(a, dir.handle); // publishes BOTH profiles

  const secondPath = `sync-v2/devices/${a.identity.deviceId}/profiles/${second.id}.json`;
  assert(Boolean(dir.readFile(secondPath)), "the second profile's file exists after the first publish");

  // NOTE: store.deleteProfile() no longer makes a profile's file obsolete —
  // deletion is now a durable tombstone fact and the row (and therefore the
  // published file) is deliberately KEPT FOREVER so the tombstone can keep
  // propagating (see test 15a below). The only way a profile's file becomes
  // genuinely obsolete now is the row disappearing entirely — which today
  // only happens via Sync V1's replaceAllProfiles adoption path
  // (deleteProfileData). Simulated directly here to isolate the cleanup
  // mechanism itself from that unrelated V1 behavior.
  await on(a, () => deleteProfileData(second.id));

  // Force this publish to fail verification. Armed for exactly one write so
  // the retry below is not corrupted too.
  let armFault = true;
  const dirty = createVirtualDirectory("dirty2", {
    transformWrite: (path, text) => {
      if (path.endsWith(`${first}.json`) && armFault) {
        armFault = false;
        return text + "TAMPERED";
      }
      return text;
    },
  });
  for (const [relPath, text] of Object.entries(dir.snapshotFiles())) dirty.writeFile(relPath, text);

  const restoreConsole = muteConsole();
  const failed = await syncPass(a, dirty.handle);
  restoreConsole();
  assertEqual(failed.status, "verify-failed", "the deletion's publish attempt failed verification");
  assert(
    Boolean(dirty.readFile(secondPath)),
    "cleanup was WITHHELD — the obsolete file survives an unverified publish"
  );

  const succeeded = await syncPass(a, dirty.handle);
  assertEqual(succeeded.status, "ok", "a clean retry succeeds");
  assertEqual(
    dirty.readFile(secondPath),
    undefined,
    "cleanup ran only once the publish was actually verified"
  );
});

// =========================================================================
// 16. A newly-created, never-activated Profile still propagates
// =========================================================================

await test("16. Profile existence propagates before it has any item/tag facts", async () => {
  const dir = createVirtualDirectory();
  const a = await makeDevice();
  const created = await on(a, () => a.store.createProfile("EMPTY"));
  // Deliberately never switched to — no favorite/hidden/tag has ever touched
  // it. Only whenFactsSettled(), never quiesce()'s extra settle, since the
  // existence stamp is queued on the same #factQueue whenFactsSettled awaits.
  await on(a, () => a.store.whenFactsSettled());

  const result = await syncPass(a, dir.handle);
  assertEqual(result.status, "ok", "the pass succeeded");

  const devicesDir = await Transport.getDevicesDir(await Transport.getSyncV2Root(dir.handle));
  const own = await Transport.readDeviceReplica(devicesDir, a.identity.deviceId);
  assert(Boolean(own.replica.profiles[created.id]), "the empty Profile's facts were published");
  assertEqual(own.replica.profiles[created.id].name.v, "EMPTY", "…carrying at least its name");

  const b = await makeDevice();
  await syncPass(b, dir.handle);
  assert(
    await on(b, () => b.store.listProfiles().some((p) => p.id === created.id)),
    "a second device discovered the Profile's existence with no curation at all on it yet"
  );
});

// =========================================================================
// 17. Deleting a Profile while a peer is offline, then the peer reconnects
// =========================================================================

await test("17. a Profile deleted while a peer is offline does not resurrect when the peer reconnects", async () => {
  const dir = createVirtualDirectory();
  const a = await makeDevice();
  const sharedId = await on(a, () => a.store.getProfileId());
  await on(a, () => a.store.setFavorite(SUNRISE, true));
  await quiesce(a);
  await syncPass(a, dir.handle);

  // B connects once, discovers the shared Profile, then goes offline — it
  // never sees what happens to it next.
  const b = await makeDevice();
  await syncPass(b, dir.handle);
  assert(await on(b, () => b.store.listProfiles().some((p) => p.id === sharedId)), "B knows the Profile before going offline");

  // A deletes the Profile entirely while B is offline.
  await on(a, () => a.store.deleteProfile(sharedId));
  await quiesce(a);
  assertEqual(await on(a, () => a.store.listProfiles().some((p) => p.id === sharedId)), false, "A no longer shows it locally");
  await syncPass(a, dir.handle);

  // B reconnects and syncs — no Keep Local / Use Synced prompt, just a merge.
  await syncPass(b, dir.handle);
  assertEqual(
    await on(b, () => b.store.listProfiles().some((p) => p.id === sharedId)),
    false,
    "B's registry adopted the deletion — the Profile is gone from B's visible list too"
  );

  // The tombstone itself is durable on both sides (not merely "absent").
  const devicesDir = await Transport.getDevicesDir(await Transport.getSyncV2Root(dir.handle));
  const ownA = await Transport.readDeviceReplica(devicesDir, a.identity.deviceId);
  assertEqual(ownA.replica.profiles[sharedId].deleted.v, true, "A's published replica carries an explicit tombstone");
});

// =========================================================================
// 18. A stale peer repeatedly rejoining cannot resurrect a deleted Profile
// =========================================================================

await test("18. repeated stale rejoins cannot resurrect a deleted Profile (no zombie Profile)", async () => {
  const dir = createVirtualDirectory();
  const a = await makeDevice();
  const sharedId = await on(a, () => a.store.getProfileId());
  await on(a, () => a.store.setFavorite(SUNRISE, true));
  await quiesce(a);
  await syncPass(a, dir.handle);

  // B syncs ONCE (learns the Profile, still holding its pre-deletion facts
  // forever after — it never syncs again until the loop below), then A
  // deletes it.
  const b = await makeDevice();
  await syncPass(b, dir.handle);
  await on(a, () => a.store.deleteProfile(sharedId));
  await quiesce(a);
  await syncPass(a, dir.handle);

  // B — genuinely stale, still carrying the live (pre-deletion) Profile in ITS
  // OWN registry — repeatedly re-syncs. Each pass merges A's tombstone in;
  // proving the Profile stays dead across several redundant passes is the
  // idempotence half of "no zombies", exactly like test 5's tag case.
  for (let i = 0; i < 4; i++) {
    await syncPass(b, dir.handle);
    assertEqual(
      await on(b, () => b.store.listProfiles().some((p) => p.id === sharedId)),
      false,
      `pass ${i + 1}: the Profile has not resurrected on B`
    );
  }

  // And B's own next publish (now correctly holding the tombstone too) must
  // not un-delete it back for A on a later pass.
  for (let i = 0; i < 3; i++) await syncPass(a, dir.handle);
  assertEqual(await on(a, () => a.store.listProfiles().some((p) => p.id === sharedId)), false, "…nor does it come back on A");
});

// =========================================================================
// 19. An explicit, newer restore beats an older deletion
// =========================================================================

await test("19. an explicit newer restore deterministically beats an older deletion", async () => {
  const dir = createVirtualDirectory();
  const a = await makeDevice();
  const sharedId = await on(a, () => a.store.getProfileId());
  await on(a, () => a.store.setFavorite(SUNRISE, true));
  await quiesce(a);
  await syncPass(a, dir.handle);

  const b = await makeDevice();
  await syncPass(b, dir.handle);

  await on(a, () => a.store.deleteProfile(sharedId));
  await quiesce(a);
  await syncPass(a, dir.handle);
  await syncPass(b, dir.handle);
  assertEqual(await on(b, () => b.store.listProfiles().some((p) => p.id === sharedId)), false, "B adopted the deletion first");

  // B explicitly restores it — a NEW, strictly newer fact than A's deletion.
  const restored = await on(b, () => b.store.restoreProfile(sharedId));
  assertEqual(restored, true, "restoreProfile reported success");
  await quiesce(b);
  assert(await on(b, () => b.store.listProfiles().some((p) => p.id === sharedId)), "…and it is visible on B again");
  await syncPass(b, dir.handle);

  await syncPass(a, dir.handle);
  assert(
    await on(a, () => a.store.listProfiles().some((p) => p.id === sharedId)),
    "the newer restore propagated back and beat A's older deletion"
  );
  // A's ACTIVE profile is now its own fallback (created when A deleted its
  // only profile) — switch back to the restored one to inspect ITS curation.
  await on(a, () => a.store.switchProfile(sharedId));
  await quiesce(a);
  assertEqual(
    await on(a, () => a.store.isFavorite(SUNRISE)),
    true,
    "…with its original curation intact — restore recovers content, not just visibility"
  );

  // A later, genuinely NEWER deletion still wins over that restore — ordinary
  // LWW, no special-casing for "restore always wins".
  await on(a, () => a.store.deleteProfile(sharedId));
  await quiesce(a);
  await syncPass(a, dir.handle);
  await syncPass(b, dir.handle);
  assertEqual(
    await on(b, () => b.store.listProfiles().some((p) => p.id === sharedId)),
    false,
    "a later, newer deletion still beats an earlier restore"
  );
});

// =========================================================================
// 20. A tombstone merged into the ACTIVE profile survives a reload
// =========================================================================

await test("20. a peer's deletion of the profile a device is ACTIVELY using is durably persisted, not just held in memory", async () => {
  const dir = createVirtualDirectory();
  const a = await makeDevice();
  const sharedId = await on(a, () => a.store.getProfileId());
  await on(a, () => a.store.setFavorite(SUNRISE, true));
  await quiesce(a);
  await syncPass(a, dir.handle);

  // C is a SECOND installation of the same Gallery — it makes the shared
  // Profile its own ACTIVE profile too (unlike every other test above, where
  // the receiving device stays on its own default profile).
  const c = await makeDevice();
  await syncPass(c, dir.handle);
  await on(c, () => c.store.switchProfile(sharedId));
  await quiesce(c);

  // B deletes it.
  const b = await makeDevice();
  await syncPass(b, dir.handle);
  await on(b, () => b.store.deleteProfile(sharedId));
  await quiesce(b);
  await syncPass(b, dir.handle);

  // C syncs while STILL ACTIVE on the now-deleted Profile — this exercises
  // #adoptFacts, not the foreign-profile path every other test above uses.
  // Locally there is no item/tag content for C to change (the deletion adds
  // no new favorite/hidden/tag), so a persist gated on "did local records
  // change" would wrongly skip writing the tombstone to disk.
  await syncPass(c, dir.handle);
  assertEqual(
    await on(c, () => c.store.listProfiles().some((p) => p.id === sharedId)),
    false,
    "C's registry immediately reflects the deletion (it fell back to another profile)"
  );

  // The real proof is NOT listProfiles() — the visible registry entry is
  // removed unconditionally, regardless of whether the tombstone FACT itself
  // was ever written to the row. What actually depends on persisting it is
  // whether the row — read completely independently, via a fresh reload —
  // still carries deleted:true, which is what lets THIS device keep
  // propagating the tombstone to any future peer.
  const rowAfterSync = await on(c, () => loadProfileData(sharedId));
  assertEqual(
    rowAfterSync.facts && rowAfterSync.facts.deleted && rowAfterSync.facts.deleted.v,
    true,
    "the tombstone fact was actually written to C's row for sharedId, not left only in memory"
  );

  // Simulate a reload — a FRESH SyncIdentity/ProfileStore reading C's SAME
  // persisted storage — and confirm the replica IT would publish still
  // carries the tombstone too.
  activate(c);
  const reloadedIdentity = new SyncIdentity();
  await reloadedIdentity.ready;
  const reloaded = new ProfileStore({ identity: reloadedIdentity });
  await settle();
  await reloaded.whenFactsSettled();

  assertEqual(
    reloaded.listProfiles().some((p) => p.id === sharedId),
    false,
    "the registry stays consistent across reload"
  );
  const reloadedReplica = await reloaded.getFullReplica();
  assertEqual(
    Facts.isProfileDeleted(reloadedReplica, sharedId),
    true,
    "…and the tombstone itself is still there to publish — reload did not lose it"
  );
});

// =========================================================================

console.log(`\n${"-".repeat(60)}`);
console.log(`${passes} assertion(s) passed, ${failures} failure(s)`);
if (failures) {
  console.log("\nFailures:");
  for (const detail of failureDetail) console.log(`  - ${detail}`);
}
process.exit(failures ? 1 : 0);
