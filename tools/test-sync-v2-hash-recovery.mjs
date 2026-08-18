#!/usr/bin/env node
// [PHASE-6-SYNC-V2]
// [STAGE-E-REAL-DRIVE-HASH-RECOVERY]
// [WHY: separate DriveFS clients may observe device metadata and profile bytes
//  at different points in propagation; integrity must remain strict while
//  either direction recovers automatically. The real two-device failure looked
//  like corruption (`profile-hash-mismatch`) and was not: one client saw a new
//  device.json paired with older profile bytes. Every assertion here exists to
//  pin the two halves of the correct response — never adopt unverifiable bytes,
//  and never let the publisher's own retry turn a transient window permanent.]
//
// Usage:  node tools/test-sync-v2-hash-recovery.mjs

import { pathToFileURL } from "node:url";
import path from "node:path";
import { installFakeIndexedDB, createVirtualDirectory, settle, muteConsole } from "./lib/browser-test-env.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const src = (rel) => pathToFileURL(path.join(ROOT, "src", rel)).href;

const { setSnapshotFreezeEnabled } = await import(src("profile/profile-snapshot.js"));
setSnapshotFreezeEnabled(true);

const { ProfileStore } = await import(src("profile/profile-store.js"));
const { SyncIdentity } = await import(src("profile/sync-device.js"));
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

// ---- Two-device fixture ----------------------------------------------------
//
// Deliberately role-neutral: every directional test below is run BOTH ways by
// swapping which device is the publisher, because the real failure was only
// ever observed in one direction and there is no reason to believe the defect
// respects that.

async function makeDevice() {
  installFakeIndexedDB();
  const idb = globalThis.indexedDB;
  const identity = new SyncIdentity();
  await identity.ready;
  const store = new ProfileStore({ identity });
  await settle();
  await store.whenFactsSettled();
  return { idb, identity, store, state: {} };
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

/** One convergence pass, carrying this device's own cross-pass state. */
async function pass(device, dirHandle) {
  return on(device, () => runSyncV2Pass({ profileStore: device.store, dirHandle, state: device.state }));
}

const CLIP = "Clip 2025-10-04 at 6.09.42 PM.mp4";
const OTHER = "Nature/Rain.mp4";

function profilePath(deviceId, profileId) {
  return `sync-v2/devices/${deviceId}/profiles/${profileId}.json`;
}
function devicePath(deviceId) {
  return `sync-v2/devices/${deviceId}/device.json`;
}
function writeCount(dir) {
  return dir.log.filter((e) => e.op === "write").length;
}

// =========================================================================
// 1 + 2. The publisher hashes exactly the bytes it wrote
// =========================================================================

await test("1/2. device.json declares the digest of exactly the bytes in the profile file", async () => {
  const dir = createVirtualDirectory();
  const a = await makeDevice();
  const profileId = await on(a, () => a.store.getProfileId());
  await on(a, () => a.store.setFavorite(CLIP, true));
  await quiesce(a);
  await pass(a, dir.handle);

  const manifest = JSON.parse(dir.readFile(devicePath(a.identity.deviceId)));
  const bytes = dir.readFile(profilePath(a.identity.deviceId, profileId));
  assert(Boolean(bytes), "the profile file was written");

  const declared = manifest.profiles.find((p) => p.id === profileId);
  assert(Boolean(declared), "device.json declares that profile");

  // Recompute independently, the same way a peer would.
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bytes)))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  assertEqual(declared.hash, digest, "the declared hash is the digest of the exact bytes on disk");
  assertEqual(manifest.hashAlgo, "sha256", "…and device.json names the algorithm that produced it");

  const devicesDir = await Transport.getDevicesDir(await Transport.getSyncV2Root(dir.handle));
  const read = await Transport.readDeviceReplica(devicesDir, a.identity.deviceId);
  assertEqual(read.status, "valid", "the publisher's own generation verifies");
  assertEqual(read.replica.profiles[profileId].items[CLIP].favorite.v.on, true, "…and carries the favorite");
});

// =========================================================================
// 3-6 + 14. Stale bytes under a new device.json: skip, then auto-recover
// =========================================================================

for (const [publisherName, readerName] of [
  ["A", "B"],
  ["B", "A"],
]) {
  await test(
    `3-6. ${publisherName} publishes, ${readerName} transiently sees stale profile bytes: skip then auto-recover`,
    async () => {
      const dir = createVirtualDirectory();
      const first = await makeDevice();
      const second = await makeDevice();
      const publisher = publisherName === "A" ? first : second;
      const reader = publisherName === "A" ? second : first;

      const sharedId = await on(publisher, () => publisher.store.getProfileId());
      await pass(publisher, dir.handle);
      // The reader must SYNC before it can switch: a Profile it has never seen
      // published is not in its registry yet.
      await pass(reader, dir.handle);
      await on(reader, () => reader.store.switchProfile(sharedId));
      await quiesce(reader);
      await pass(reader, dir.handle);
      await pass(publisher, dir.handle);

      // Snapshot the publisher's CURRENT (pre-favorite) profile bytes, then let
      // it publish the favorite, then restore the OLD bytes underneath the NEW
      // device.json. That is precisely what a client mid-propagation observes:
      // metadata from generation N, content from generation N-1.
      const pPath = profilePath(publisher.identity.deviceId, sharedId);
      const staleBytes = dir.readFile(pPath);
      assert(Boolean(staleBytes), "captured the pre-change profile bytes");

      await on(publisher, () => publisher.store.setFavorite(CLIP, true));
      await quiesce(publisher);
      const published = await pass(publisher, dir.handle);
      assertEqual(published.status, "ok", "the publisher's own publish verified locally");

      const freshBytes = dir.readFile(pPath);
      assert(freshBytes !== staleBytes, "the profile file really did change");
      dir.writeFile(pPath, staleBytes); // simulate mid-propagation on the reader's mount

      // ---- the reader must SKIP, adopting nothing ----
      const restore = muteConsole();
      const skipPass = await pass(reader, dir.handle);
      restore();

      assertEqual(skipPass.status, "ok", "the reader's pass still completes");
      const skip = skipPass.skippedPeers.find((p) => p.deviceId === publisher.identity.deviceId);
      assert(Boolean(skip), "the publisher was skipped");
      assertEqual(skip.reason, `profile-hash-mismatch:${sharedId}`, "…for the hash mismatch, strictly");
      assert(Boolean(skip.detail), "…with diagnostic detail for a real-device report", String(skip.detail));
      assertEqual(
        await on(reader, () => reader.store.isFavorite(CLIP)),
        false,
        "NOTHING from the mismatched generation was adopted"
      );

      // ---- once the bytes catch up, the reader recovers with NO local action ----
      dir.writeFile(pPath, freshBytes);
      const recovered = await pass(reader, dir.handle);

      assertEqual(recovered.skippedPeers.length, 0, "the peer is no longer skipped");
      assertEqual(recovered.mergedPeers, 1, "…it merged normally");
      assertEqual(
        await on(reader, () => reader.store.isFavorite(CLIP)),
        true,
        "the favorite arrived with no local mutation and no manual Sync Now"
      );
    }
  );
}

// =========================================================================
// 7 + 8. A PERSISTENT mismatch stays rejected forever
// =========================================================================

await test("7/8. a persistently mismatched generation is never accepted, however many passes run", async () => {
  const dir = createVirtualDirectory();
  const a = await makeDevice();
  const b = await makeDevice();
  const sharedId = await on(a, () => a.store.getProfileId());

  // B joins BEFORE the favorite exists, so anything it holds afterwards can
  // only have come from the corrupted generation.
  await pass(a, dir.handle);
  await pass(b, dir.handle);
  await on(b, () => b.store.switchProfile(sharedId));
  await quiesce(b);
  await pass(b, dir.handle);
  assertEqual(await on(b, () => b.store.isFavorite(CLIP)), false, "B starts without the favorite");

  await on(a, () => a.store.setFavorite(CLIP, true));
  await quiesce(a);
  await pass(a, dir.handle);

  // Permanently corrupt A's profile file — valid JSON, right shape, wrong bytes.
  const pPath = profilePath(a.identity.deviceId, sharedId);
  dir.writeFile(pPath, dir.readFile(pPath).replace('"on": true', '"on": false'));

  const restore = muteConsole();
  for (let i = 0; i < 6; i++) {
    const result = await pass(b, dir.handle);
    assertEqual(result.skippedPeers.length, 1, `pass ${i + 1}: still rejected`);
  }
  restore();

  assertEqual(await on(b, () => b.store.isFavorite(CLIP)), false, "no tampered byte was ever adopted");
  assertEqual(await on(b, () => b.store.isHidden(CLIP)), false, "…and nothing else leaked in either");
});

// =========================================================================
// 9 + 13. The publisher does not rewrite its own settled generation
// =========================================================================

await test("9/13. an unreadable OWN generation makes the publisher wait, not rewrite every pass", async () => {
  const dir = createVirtualDirectory();
  const a = await makeDevice();
  const profileId = await on(a, () => a.store.getProfileId());
  await on(a, () => a.store.setFavorite(CLIP, true));
  await quiesce(a);
  await pass(a, dir.handle);

  // The publisher's own mount now shows stale bytes under its new device.json —
  // exactly what Drive does on the round trip after an upload.
  const pPath = profilePath(a.identity.deviceId, profileId);
  const good = dir.readFile(pPath);
  dir.writeFile(pPath, good.replace('"on": true', '"on": false'));

  const writesBefore = writeCount(dir);
  const restore = muteConsole();
  const settlingResults = [];
  for (let i = 0; i < 5; i++) settlingResults.push(await pass(a, dir.handle));
  restore();

  assertEqual(
    writeCount(dir),
    writesBefore,
    "not one byte was rewritten — the publisher waited instead of restarting propagation"
  );
  assert(
    settlingResults.every((r) => r.published === false),
    "…and reported no publish on any of those passes"
  );
  assert(
    settlingResults.every((r) => r.ownGenerationSettling > 0),
    "…reporting truthfully that its own generation is still settling"
  );
  assert(
    settlingResults[4].ownGenerationSettling > settlingResults[0].ownGenerationSettling,
    "…and counting the passes it has waited"
  );

  // As soon as the folder settles, it goes quiet — still no rewrite.
  dir.writeFile(pPath, good);
  const settled = await pass(a, dir.handle);
  assertEqual(settled.published, false, "a settled generation needs no publish");
  assertEqual(writeCount(dir), writesBefore, "…and still wrote nothing");
});

// =========================================================================
// 10. Genuine corruption still self-heals — the wait is BOUNDED
// =========================================================================

await test("10. after a bounded wait the publisher republishes, so real corruption self-heals", async () => {
  const dir = createVirtualDirectory();
  const a = await makeDevice();
  const profileId = await on(a, () => a.store.getProfileId());
  await on(a, () => a.store.setFavorite(CLIP, true));
  await quiesce(a);
  await pass(a, dir.handle);

  const pPath = profilePath(a.identity.deviceId, profileId);
  dir.writeFile(pPath, dir.readFile(pPath).replace('"on": true', '"on": false'));

  const restore = muteConsole();
  let republishedAt = -1;
  for (let i = 0; i < 14; i++) {
    const result = await pass(a, dir.handle);
    if (result.published) {
      republishedAt = i + 1;
      break;
    }
  }
  restore();

  assert(republishedAt > 1, `it waited before rewriting (republished on pass ${republishedAt})`);
  assert(republishedAt <= 12, `…but did rewrite within the bound (pass ${republishedAt})`);

  const devicesDir = await Transport.getDevicesDir(await Transport.getSyncV2Root(dir.handle));
  const read = await Transport.readDeviceReplica(devicesDir, a.identity.deviceId);
  assertEqual(read.status, "valid", "the rewritten generation is consistent again");
  assertEqual(read.replica.profiles[profileId].items[CLIP].favorite.v.on, true, "…with the correct content restored");
});

// =========================================================================
// 11. One mismatched peer never blocks a healthy one
// =========================================================================

await test("11. a mismatched peer does not stop a healthy peer from merging", async () => {
  const dir = createVirtualDirectory();
  const a = await makeDevice();
  const b = await makeDevice();
  const c = await makeDevice();
  const sharedId = await on(a, () => a.store.getProfileId());

  await on(a, () => a.store.setFavorite(CLIP, true));
  await quiesce(a);
  await pass(a, dir.handle);

  await pass(b, dir.handle);
  await on(b, () => b.store.switchProfile(sharedId));
  await quiesce(b);
  await pass(b, dir.handle);
  await on(b, () => b.store.setHidden(OTHER, true));
  await quiesce(b);
  await pass(b, dir.handle);

  // Break A only.
  const aPath = profilePath(a.identity.deviceId, sharedId);
  dir.writeFile(aPath, dir.readFile(aPath).replace('"on": true', '"on": false'));

  const restoreC = muteConsole();
  await pass(c, dir.handle);
  restoreC();
  await on(c, () => c.store.switchProfile(sharedId));
  await quiesce(c);
  const restore = muteConsole();
  const result = await pass(c, dir.handle);
  restore();

  assertEqual(result.skippedPeers.length, 1, "only the broken peer was skipped");
  assertEqual(result.mergedPeers, 1, "…and the healthy peer still merged");
  await quiesce(c);
  assertEqual(await on(c, () => c.store.isHidden(OTHER)), true, "B's healthy contribution arrived");
});

// =========================================================================
// 12. A digest algorithm we cannot reproduce is named, not blamed on the bytes
// =========================================================================

await test("12. an unreproducible hash algorithm is reported as such and still rejected", async () => {
  const dir = createVirtualDirectory();
  const a = await makeDevice();
  await on(a, () => a.store.setFavorite(CLIP, true));
  await quiesce(a);
  await pass(a, dir.handle);

  const mPath = devicePath(a.identity.deviceId);
  const manifest = JSON.parse(dir.readFile(mPath));
  manifest.hashAlgo = "some-future-algo";
  dir.writeFile(mPath, JSON.stringify(manifest, null, 2));

  const devicesDir = await Transport.getDevicesDir(await Transport.getSyncV2Root(dir.handle));
  const read = await Transport.readDeviceReplica(devicesDir, a.identity.deviceId);
  assertEqual(read.status, "invalid", "an unverifiable generation is still REJECTED, never accepted");
  assert(
    String(read.reason).startsWith("hash-algo-mismatch:"),
    "…and says the algorithm is the problem, not the bytes",
    read.reason
  );

  // A device.json predating hashAlgo is assumed to be ours — backward compatible.
  delete manifest.hashAlgo;
  dir.writeFile(mPath, JSON.stringify(manifest, null, 2));
  const legacy = await Transport.readDeviceReplica(devicesDir, a.identity.deviceId);
  assertEqual(legacy.status, "valid", "a generation written before hashAlgo existed is still valid");
});

// =========================================================================
// 13b. Nothing about a skip is remembered between passes
// =========================================================================

await test("13b. a transient mismatch leaves no state that could poison later passes", async () => {
  const dir = createVirtualDirectory();
  const a = await makeDevice();
  const b = await makeDevice();
  const sharedId = await on(a, () => a.store.getProfileId());
  await pass(a, dir.handle);
  await pass(b, dir.handle);
  await on(b, () => b.store.switchProfile(sharedId));
  await quiesce(b);
  await pass(b, dir.handle);

  const aPath = profilePath(a.identity.deviceId, sharedId);

  // Alternate broken / healthy several times; each pass must judge only what it
  // can see right now.
  for (let cycle = 0; cycle < 3; cycle++) {
    await on(a, () => a.store.setFavorite(`${CLIP}#${cycle}`, true));
    await quiesce(a);
    await pass(a, dir.handle);

    const good = dir.readFile(aPath);
    dir.writeFile(aPath, good.replace('"on": true', '"on": false'));
    const restore = muteConsole();
    const broken = await pass(b, dir.handle);
    restore();
    assertEqual(broken.skippedPeers.length, 1, `cycle ${cycle}: skipped while broken`);

    dir.writeFile(aPath, good);
    const healed = await pass(b, dir.handle);
    assertEqual(healed.skippedPeers.length, 0, `cycle ${cycle}: accepted again once healthy`);
    assertEqual(healed.mergedPeers, 1, `cycle ${cycle}: merged`);
    await quiesce(b);
    assertEqual(
      await on(b, () => b.store.isFavorite(`${CLIP}#${cycle}`)),
      true,
      `cycle ${cycle}: adopted the recovered content`
    );
  }
});

// =========================================================================

console.log(`\n${"-".repeat(60)}`);
console.log(`${passes} assertion(s) passed, ${failures} failure(s)`);
if (failures) {
  console.log("\nFailures:");
  for (const detail of failureDetail) console.log(`  - ${detail}`);
}
process.exit(failures ? 1 : 0);
