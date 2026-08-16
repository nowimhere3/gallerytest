#!/usr/bin/env node
// [PHASE-6-SYNC-V2]
// [STAGE-E-LIVE-INTEGRATION]
// [WHY: D1/D2/D3 each proved a layer in isolation. This proves the LIVE
//  wiring — that ProfileSync actually routes to V2 after activation and never
//  writes V1 again, that activation cannot destroy local data no matter how
//  broken the V1 folder is, that the status it reports is true rather than
//  merely optimistic, and that the folder-open path no longer associates a
//  library with whatever Profile happens to be active. Every one of those is a
//  wiring property: correct in each layer, wrong in the app, and invisible
//  until a real user loses curation.]
//
// Usage:  node tools/test-sync-v2-live.mjs

import { pathToFileURL } from "node:url";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { installFakeIndexedDB, createVirtualDirectory, settle, muteConsole } from "./lib/browser-test-env.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const src = (rel) => pathToFileURL(path.join(ROOT, "src", rel)).href;

const { setSnapshotFreezeEnabled } = await import(src("profile/profile-snapshot.js"));
setSnapshotFreezeEnabled(true);

const { ProfileStore } = await import(src("profile/profile-store.js"));
const { SyncIdentity } = await import(src("profile/sync-device.js"));
const { ProfileSync } = await import(src("profile/profile-sync.js"));
const Transport = await import(src("profile/sync-v2-transport.js"));
const LibraryRegistry = await import(src("storage/library-registry.js"));
const { loadActivationState } = await import(src("storage/profile-sync-store.js"));
const { activateSyncV2 } = await import(src("profile/sync-v2-activation.js"));

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

// ---- Live-app fixture ------------------------------------------------------
//
// Builds the same object graph main.js does — ProfileStore + ProfileSync over
// one folder handle — with its own isolated IndexedDB, so each "device" here is
// a genuine separate installation running the real engine, not a stub.

async function makeInstallation(dirHandle, { connect = true } = {}) {
  installFakeIndexedDB();
  const idb = globalThis.indexedDB;
  const identity = new SyncIdentity();
  await identity.ready;
  const store = new ProfileStore({ identity });
  await settle();
  await store.whenFactsSettled();

  const sync = new ProfileSync(store);
  if (connect && dirHandle) {
    await sync.connectNewFolder(dirHandle);
    await settle();
  } else {
    await sync.init();
    await settle();
  }

  return { idb, identity, store, sync, dirHandle };
}

function activate(device) {
  globalThis.indexedDB = device.idb;
}

async function on(device, fn) {
  activate(device);
  return fn(device);
}

async function quiesce(device) {
  return on(device, async () => {
    await device.store.whenFactsSettled();
    await device.store.whenAssociationsSettled();
    await settle();
    await device.store.whenFactsSettled();
  });
}

const SUNRISE = "Nature/Sunrise.mp4";
const RAIN = "Nature/Rain.mp4";
const STORM = "Nature/Storm.mp4";

function fakeHandle(name) {
  const handle = { name, kind: "directory" };
  handle.isSameEntry = async (other) => other === handle;
  return handle;
}

/** Writes a V1 generation into the folder, bypassing the handle API. */
function seedV1Folder(dir, { profileId, profileName = "V1 Gallery", items, tags = [], manifestFingerprint = null }) {
  dir.writeFile(
    "manifest.json",
    JSON.stringify({
      schemaVersion: 1,
      kind: "gallery-profile-sync-manifest",
      profileIds: [profileId],
      // Deliberately a WRONG fingerprint by default — this is the documented
      // stuck state a real installation can be in, and recovery must not depend
      // on the manifest being trustworthy.
      fingerprint: manifestFingerprint || "stale-and-definitely-wrong",
      updatedAt: 1600000000000,
    })
  );
  dir.writeFile(
    `profiles/${profileId}.json`,
    JSON.stringify({ schemaVersion: 2, kind: "gallery-profile", profileId, profileName, items, tags })
  );
}

function v2Files(dir, deviceId) {
  const out = {};
  const prefix = `sync-v2/devices/${deviceId}/`;
  for (const [p, text] of Object.entries(dir.snapshotFiles())) {
    if (p.startsWith(prefix)) out[p.slice(prefix.length)] = text;
  }
  return out;
}

function v1Files(dir) {
  const out = {};
  for (const [p, text] of Object.entries(dir.snapshotFiles())) {
    if (!p.startsWith("sync-v2/")) out[p] = text;
  }
  return out;
}

// =========================================================================
// 1. Fresh V2 activation from local-only state
// =========================================================================

await test("1. activating with no V1 data cuts over cleanly and publishes via V2", async () => {
  const dir = createVirtualDirectory();
  const a = await makeInstallation(dir.handle);
  await on(a, () => a.store.setFavorite(SUNRISE, true));
  await quiesce(a);

  assertEqual(await on(a, () => a.sync.getActivation().mode), "v1", "starts on V1");

  const result = await on(a, () => a.sync.activateSyncV2());
  assertEqual(result.ok, true, "activation reported success");
  assertEqual(await on(a, () => a.sync.getActivation().mode), "v2", "mode is now v2");
  assertEqual((await on(a, () => loadActivationState())).mode, "v2", "…and it was persisted");

  const status = await on(a, () => a.sync.getStatus());
  assertEqual(status.mode, "v2", "status reports the v2 mode");
  assertEqual(status.status, "connected", "the first V2 pass was accepted");

  const own = v2Files(dir, a.identity.deviceId);
  assert(Boolean(own["device.json"]), "a V2 generation was published");
  assertEqual(
    await on(a, () => a.store.isFavorite(SUNRISE)),
    true,
    "local curation is untouched by activation"
  );
});

// =========================================================================
// 2. Activation with usable V1 JSON but an INVALID manifest
// =========================================================================

await test("2. activation recovers usable V1 profile JSON even when the V1 manifest is invalid", async () => {
  const dir = createVirtualDirectory();
  const v1ProfileId = "v1-profile-1";
  seedV1Folder(dir, {
    profileId: v1ProfileId,
    items: { [STORM]: { favorite: true, favoritedAt: 1600000000000 } },
    tags: [{ id: "v1-tag", name: "V1TAG" }],
  });
  const v1Before = JSON.stringify(v1Files(dir));

  const a = await makeInstallation(dir.handle);
  await on(a, () => a.store.setFavorite(SUNRISE, true));
  await quiesce(a);

  const restoreConsole = muteConsole();
  const result = await on(a, () => a.sync.activateSyncV2());
  restoreConsole();

  assertEqual(result.ok, true, "activation succeeded despite the bad manifest");
  assertEqual(result.migration.v1ProfilesSeeded, 1, "the usable V1 profile JSON was recovered");

  const replica = await on(a, () => a.store.getFullReplica());
  assertEqual(
    replica.profiles[v1ProfileId].items[STORM].favorite.v.on,
    true,
    "its curation is now present as V2 facts"
  );
  assertEqual(replica.profiles[v1ProfileId].items[STORM].favorite.t, 1, "…at V1_SEED_T, below every local stamp");
  assertEqual(await on(a, () => a.store.isFavorite(SUNRISE)), true, "local curation still intact");

  assertEqual(JSON.stringify(v1Files(dir)), v1Before, "every V1 byte is unchanged");
});

// =========================================================================
// 3. Activation when V1 is unreadable still preserves local state
// =========================================================================

await test("3. an unreadable V1 folder does not block activation and does not lose local state", async () => {
  const dir = createVirtualDirectory("Sync", {
    beforeRead: (p) => {
      if (p.startsWith("profiles/")) throw new Error("Simulated Drive read fault");
    },
  });
  seedV1Folder(dir, { profileId: "v1-unreadable", items: { [STORM]: { favorite: true } } });

  const a = await makeInstallation(dir.handle);
  await on(a, () => a.store.setFavorite(SUNRISE, true));
  await on(a, () => a.store.setHidden(RAIN, true));
  await quiesce(a);

  const restoreConsole = muteConsole();
  const result = await on(a, () => a.sync.activateSyncV2());
  restoreConsole();

  assertEqual(result.ok, true, "activation still succeeded — a broken V1 folder is not fatal");
  assertEqual(await on(a, () => a.sync.getActivation().mode), "v2", "the installation is on V2");
  assertEqual(await on(a, () => a.store.isFavorite(SUNRISE)), true, "local favorite preserved");
  assertEqual(await on(a, () => a.store.isHidden(RAIN)), true, "local hidden flag preserved");
  assertEqual(
    (await on(a, () => a.store.getFullReplica())).profiles["v1-unreadable"],
    undefined,
    "nothing was invented for the profile that could not be read"
  );
});

// =========================================================================
// 4. After activation, the V1 write path never runs
// =========================================================================

await test("4. after cutover this device never writes V1 again", async () => {
  const dir = createVirtualDirectory();
  const v1ProfileId = "v1-profile-2";
  seedV1Folder(dir, { profileId: v1ProfileId, items: { [STORM]: { favorite: true } } });

  const a = await makeInstallation(dir.handle);
  const restoreConsole = muteConsole();
  await on(a, () => a.sync.activateSyncV2());
  restoreConsole();

  const v1AfterActivation = JSON.stringify(v1Files(dir));

  // Lots of ordinary activity, plus explicit Sync Now passes.
  await on(a, () => a.store.setFavorite(SUNRISE, true));
  await on(a, () => a.store.setHidden(RAIN, true));
  const tag = await on(a, () => a.store.createTag("AFTER-CUTOVER"));
  await on(a, () => a.store.setItemTag(SUNRISE, tag.id, true));
  await quiesce(a);
  await on(a, () => a.sync.syncNow());
  await on(a, () => a.sync.syncNow());
  await quiesce(a);

  assertEqual(JSON.stringify(v1Files(dir)), v1AfterActivation, "no V1 file changed, at all");
  assert(Boolean(v2Files(dir, a.identity.deviceId)["device.json"]), "…while V2 kept publishing normally");

  // The V1 recovery controls are refused outright on a V2 installation.
  const restore2 = muteConsole();
  await on(a, () => a.sync.resolveConflict("keep-local"));
  restore2();
  assertEqual(JSON.stringify(v1Files(dir)), v1AfterActivation, "even an explicit Keep Local cannot write V1 after cutover");
});

// =========================================================================
// 5. Sync Now and auto-sync both go through V2
// =========================================================================

await test("5. Sync Now and the auto-sync debounce both run the V2 pass", async () => {
  const dir = createVirtualDirectory();
  const a = await makeInstallation(dir.handle);
  await on(a, () => a.sync.activateSyncV2());

  // ---- Sync Now ----
  await on(a, () => a.store.setFavorite(SUNRISE, true));
  await quiesce(a);
  await on(a, () => a.sync.syncNow());

  const devicesDir = await Transport.getDevicesDir(await Transport.getSyncV2Root(dir.handle));
  let own = await Transport.readDeviceReplica(devicesDir, a.identity.deviceId);
  const profileId = await on(a, () => a.store.getProfileId());
  assertEqual(own.replica.profiles[profileId].items[SUNRISE].favorite.v.on, true, "Sync Now published via V2");

  // ---- auto-sync ----
  // A mutation schedules the real ~3s debounce; drive it with fake timers
  // rather than waiting, then let the pass settle.
  await on(a, () => a.store.setHidden(RAIN, true));
  await quiesce(a);

  const realSetTimeout = globalThis.setTimeout;
  await new Promise((resolve) => realSetTimeout(resolve, 3200));
  await quiesce(a);
  await settle(20);

  own = await Transport.readDeviceReplica(devicesDir, a.identity.deviceId);
  assertEqual(
    own.replica.profiles[profileId].items[RAIN].hidden.v,
    true,
    "the auto-sync debounce fired a V2 pass with no manual action"
  );
});

// =========================================================================
// 6. Verified-publish failure => truthful status, nothing accepted
// =========================================================================

await test("6. a publish that fails read-back verification reports truthfully and accepts nothing", async () => {
  // One folder throughout — the fault is armed only AFTER a successful pass, so
  // this reproduces "a subsequent publish is corrupted" rather than confusing
  // the result with a reconnect (which legitimately resets sync metadata).
  let armed = false;
  let dirtyPath = null;
  const dir = createVirtualDirectory("Sync", {
    transformWrite: (p, text) => {
      if (armed && p === dirtyPath) {
        armed = false;
        return text + "TAMPERED";
      }
      return text;
    },
  });

  const a = await makeInstallation(dir.handle);
  await on(a, () => a.sync.activateSyncV2());
  const profileId = await on(a, () => a.store.getProfileId());
  dirtyPath = `sync-v2/devices/${a.identity.deviceId}/profiles/${profileId}.json`;

  await on(a, () => a.store.setFavorite(SUNRISE, true));
  await quiesce(a);
  await on(a, () => a.sync.syncNow());

  const goodStatus = await on(a, () => a.sync.getStatus());
  assertEqual(goodStatus.status, "connected", "the clean pass is connected");
  const lastSyncBefore = goodStatus.lastSyncAt;
  assert(typeof lastSyncBefore === "number", "…and recorded a real lastSyncAt");

  // Now corrupt exactly the next write of that profile file.
  armed = true;
  await on(a, () => a.store.setHidden(RAIN, true));
  await quiesce(a);
  const restoreConsole = muteConsole();
  await on(a, () => a.sync.syncNow());
  restoreConsole();

  const status = await on(a, () => a.sync.getStatus());
  assertEqual(status.status, "verify-failed", "the failed publish is reported as verify-failed");
  assert(
    !String(status.message || "").toLowerCase().includes("connected"),
    "…and the message does not claim connection"
  );
  assertEqual(status.lastSyncAt, lastSyncBefore, "lastSyncAt was NOT advanced by the failed pass");
  assertEqual(await on(a, () => a.store.isHidden(RAIN)), true, "local Profile data is completely unaffected");
  assertEqual(await on(a, () => a.store.isFavorite(SUNRISE)), true, "…including everything from before it");

  // Recoverable, not a permanent wedge.
  await on(a, () => a.sync.syncNow());
  const recovered = await on(a, () => a.sync.getStatus());
  assertEqual(recovered.status, "connected", "a clean retry recovers");
  assert(recovered.lastSyncAt > lastSyncBefore, "…and only THEN does lastSyncAt advance");
});

// =========================================================================
// 7. A corrupt peer does not make healthy peers unusable
// =========================================================================

await test("7. one corrupt peer is skipped and reported without claiming total failure", async () => {
  const dir = createVirtualDirectory();
  const a = await makeInstallation(dir.handle);
  await on(a, () => a.sync.activateSyncV2());
  const sharedId = await on(a, () => a.store.getProfileId());
  await on(a, () => a.store.setFavorite(SUNRISE, true));
  await quiesce(a);
  await on(a, () => a.sync.syncNow());

  const b = await makeInstallation(dir.handle);
  await on(b, () => b.sync.activateSyncV2());
  await on(b, () => b.store.switchProfile(sharedId));
  await quiesce(b);
  await on(b, () => b.store.setHidden(RAIN, true));
  await quiesce(b);
  await on(b, () => b.sync.syncNow());

  // Corrupt B's generation on disk.
  const bPath = `sync-v2/devices/${b.identity.deviceId}/profiles/${sharedId}.json`;
  dir.writeFile(bPath, dir.readFile(bPath) + "CORRUPTED");

  const c = await makeInstallation(dir.handle);
  const restoreConsole = muteConsole();
  await on(c, () => c.sync.activateSyncV2());
  restoreConsole();

  const status = await on(c, () => c.sync.getStatus());
  assertEqual(status.status, "connected", "C's own pass is still connected — one bad peer is not total failure");
  assert(
    status.skippedPeers.some((p) => p.deviceId === b.identity.deviceId),
    "…and the skipped peer IS reported rather than hidden"
  );

  await on(c, () => c.store.switchProfile(sharedId));
  await quiesce(c);
  assertEqual(await on(c, () => c.store.isFavorite(SUNRISE)), true, "the healthy peer's curation still merged");
  assertEqual(await on(c, () => c.store.isHidden(RAIN)), false, "the corrupt peer's did not");
});

// =========================================================================
// 8. Folder load does NOT associate; explicit association DOES
// =========================================================================

await test("8. loading a folder associates nothing; only the explicit action does", async () => {
  const dir = createVirtualDirectory();
  const a = await makeInstallation(dir.handle);
  await on(a, () => a.sync.activateSyncV2());

  const activeProfileId = await on(a, () => a.store.getProfileId());
  const otherProfile = await on(a, () => a.store.createProfile("OTHER"));
  await quiesce(a);

  // Opening a folder = addOrUpdateLibrary only. This is exactly what main.js's
  // FSA pick path does, and it must mint no shared identity and change no
  // Profile metadata.
  const beforeName = await on(a, () => a.store.getProfileName());
  const row = await on(a, () => LibraryRegistry.addOrUpdateLibrary(fakeHandle("Nature")));

  assertEqual(row.libraryId, undefined, "opening a folder minted no shared libraryId");
  assertEqual(row.profileId, null, "…and associated it with no Profile");
  assertEqual(await on(a, () => a.store.getProfileName()), beforeName, "the active Profile's name is untouched");
  assertEqual(
    await on(a, () => a.store.getMasterFolder()),
    null,
    "…and no masterFolder was written onto the active Profile (the Stage A leak)"
  );
  assert(
    Object.keys(await on(a, () => a.store.listAssociations())).length === 0,
    "no association fact was created by opening a folder"
  );

  // The explicit action — the one main.js's associateCurrentLibraryWithProfile
  // now routes through — DOES associate, and to the Profile it was told, which
  // here is deliberately NOT the active one.
  const sharedId = await on(a, () => a.store.setLibraryAssociation(row.id, otherProfile.id));
  assert(typeof sharedId === "string" && sharedId.length > 0, "explicit association minted a shared libraryId");
  assertEqual(
    (await on(a, () => a.store.listAssociations()))[sharedId],
    otherProfile.id,
    "…pointing at the Profile the user chose"
  );
  assertEqual(await on(a, () => a.store.getProfileId()), activeProfileId, "the active Profile did not change");

  // And curation still lands in the ACTIVE Profile, not the associated one.
  await on(a, () => a.store.setFavorite(SUNRISE, true));
  await quiesce(a);
  const replica = await on(a, () => a.store.getFullReplica());
  assertEqual(replica.profiles[activeProfileId].items[SUNRISE].favorite.v.on, true, "curation landed in the ACTIVE Profile");
  assertEqual(
    replica.profiles[otherProfile.id]?.items?.[SUNRISE],
    undefined,
    "…never in the associated one"
  );

  // Switching Profiles must not transfer the association.
  await on(a, () => a.store.switchProfile(otherProfile.id));
  await quiesce(a);
  assertEqual(
    (await on(a, () => a.store.listAssociations()))[sharedId],
    otherProfile.id,
    "switching the active Profile transferred no association"
  );
});

// =========================================================================
// 8a. The association leak is guarded at its actual call site
// =========================================================================

await test("8a. no folder-load path in main.js writes Profile-level folder association", async () => {
  // [PHASE-6-SYNC-V2][STAGE-E-LIVE-INTEGRATION]
  // [WHY: the Stage A leak lived in main.js's folderInput change handler — a
  //  DOM event this Node harness cannot dispatch, so the behavioural test above
  //  cannot reach it. The defect is a CALL SITE, so this guards the call site:
  //  setMasterFolder writes durable association metadata onto whichever Profile
  //  is active, which is only ever correct from an explicit association action,
  //  and there is currently no such action that needs it. Any reintroduction —
  //  in the folder handler or anywhere else in main.js — fails here.]
  const mainSource = await readFile(path.join(ROOT, "src", "main.js"), "utf8");

  const callSites = mainSource
    .split("\n")
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => /\bsetMasterFolder\s*\(/.test(line))
    // Comments explaining WHY the call was removed are expected and fine.
    .filter(({ line }) => !line.trimStart().startsWith("//"));

  assert(
    callSites.length === 0,
    "main.js contains no live setMasterFolder() call — opening a folder cannot associate it with the active Profile",
    callSites.map((c) => `line ${c.number}: ${c.line.trim()}`).join("\n        ")
  );

  // The folder handler must still compute topFolderName — it is what legacy
  // RECOGNITION fingerprints against, which is local-only and associates
  // nothing. Guarding its removal keeps a future "fix" from deleting the wrong
  // half of this seam.
  assert(
    /const topFolderName\s*=/.test(mainSource),
    "…while the folder handler still derives topFolderName for local-only legacy recognition"
  );
});

// =========================================================================
// 9. Second-device linking requires explicit action
// =========================================================================

await test("9. a second device links to a shared library only by explicit id, never by name", async () => {
  const dir = createVirtualDirectory();
  const a = await makeInstallation(dir.handle);
  await on(a, () => a.sync.activateSyncV2());
  const rowA = await on(a, () => LibraryRegistry.addOrUpdateLibrary(fakeHandle("Nature")));
  const aProfileId = await on(a, () => a.store.getProfileId());
  const sharedId = await on(a, () => a.store.setLibraryAssociation(rowA.id, aProfileId));
  await quiesce(a);
  await on(a, () => a.sync.syncNow());

  const b = await makeInstallation(dir.handle);
  await on(b, () => b.sync.activateSyncV2());
  assertEqual(
    (await on(b, () => b.store.listAssociations()))[sharedId] !== undefined,
    true,
    "B learned the shared library exists"
  );

  // A same-named local folder on B must NOT auto-link.
  const rowB = await on(b, () => LibraryRegistry.addOrUpdateLibrary(fakeHandle("Nature")));
  assertEqual(rowB.libraryId, undefined, "opening a same-named folder on B linked nothing");

  const linked = await on(b, () => LibraryRegistry.linkLocalLibraryToSharedId(rowB.id, sharedId));
  assertEqual(linked.libraryId, sharedId, "the explicit link succeeded");

  // Linking moves no curation.
  assertEqual(
    Object.keys((await on(b, () => b.store.getFullReplica())).profiles).length >= 1,
    true,
    "B still has its own Profile(s)"
  );
  await on(b, () => b.sync.syncNow());
  const rereadB = await on(b, () => LibraryRegistry.getLibraryByLibraryId(sharedId));
  assert(Boolean(rereadB), "B's local row now carries the shared identity");
});

// =========================================================================
// 10. No FSA handle / signature in published bytes
// =========================================================================

await test("10. handles, signatures and folder names never reach published bytes", async () => {
  const dir = createVirtualDirectory();
  const a = await makeInstallation(dir.handle);
  await on(a, () => a.sync.activateSyncV2());

  const row = await on(a, () => LibraryRegistry.addOrUpdateLibrary(fakeHandle("Extremely Distinctive Folder Name")));
  const ownProfileId = await on(a, () => a.store.getProfileId());
  await on(a, () => a.store.setLibraryAssociation(row.id, ownProfileId));
  const tag = await on(a, () => a.store.createTag("ALPHA"));
  await on(a, () => a.store.setItemTag(SUNRISE, tag.id, true));
  await quiesce(a);
  await on(a, () => a.store.recordTagActivity(tag.id, { position: 3, total: 10, shuffle: false }));
  await quiesce(a);
  await on(a, () => a.sync.syncNow());

  const published = JSON.stringify(v2Files(dir, a.identity.deviceId));
  for (const forbidden of [
    "Extremely Distinctive Folder Name",
    "isSameEntry",
    "handle",
    "signature",
    "tagActivity",
    "lastTagPosition",
    "totalAtTime",
    "lastTaggedAt",
    "lastTagShuffle",
  ]) {
    assert(!published.includes(forbidden), `"${forbidden}" does not appear in any published byte`);
  }

  // The local-only data is still there locally — nothing was stripped to
  // achieve the above.
  assertEqual(
    (await on(a, () => a.store.getTagActivity(tag.id))).shuffleOff.position,
    3,
    "the local resume position survived the live sync pass"
  );
});

// =========================================================================
// 11. Profile delete/restore + tag delete/restore survive a live round trip
// =========================================================================

await test("11. Profile and tag tombstones survive a live two-device round trip", async () => {
  const dir = createVirtualDirectory();
  const a = await makeInstallation(dir.handle);
  await on(a, () => a.sync.activateSyncV2());
  const sharedId = await on(a, () => a.store.getProfileId());
  const doomedTag = await on(a, () => a.store.createTag("DOOMED"));
  await on(a, () => a.store.setItemTag(SUNRISE, doomedTag.id, true));
  const extraProfile = await on(a, () => a.store.createProfile("EXTRA"));
  await quiesce(a);
  await on(a, () => a.sync.syncNow());

  const b = await makeInstallation(dir.handle);
  await on(b, () => b.sync.activateSyncV2());
  assert(
    await on(b, () => b.store.listProfiles().some((p) => p.id === extraProfile.id)),
    "the empty Profile's existence synced to B"
  );

  // A deletes the tag and the extra Profile.
  await on(a, () => a.store.deleteTag(doomedTag.id));
  await on(a, () => a.store.deleteProfile(extraProfile.id));
  await quiesce(a);
  await on(a, () => a.sync.syncNow());

  await on(b, () => b.sync.syncNow());
  await on(b, () => b.store.switchProfile(sharedId));
  await quiesce(b);
  assertEqual(await on(b, () => b.store.getTags().some((t) => t.id === doomedTag.id)), false, "the tag tombstone reached B");
  assertEqual(
    await on(b, () => b.store.listProfiles().some((p) => p.id === extraProfile.id)),
    false,
    "the Profile tombstone reached B"
  );

  // Repeated stale re-syncs cannot resurrect either.
  for (let i = 0; i < 3; i++) {
    await on(b, () => b.sync.syncNow());
    await on(a, () => a.sync.syncNow());
  }
  assertEqual(await on(b, () => b.store.getTags().some((t) => t.id === doomedTag.id)), false, "…and stays dead across replays");
  assertEqual(
    await on(a, () => a.store.listProfiles().some((p) => p.id === extraProfile.id)),
    false,
    "…on both devices"
  );

  // But the deleted tag's assignments are still underneath, so a restore works.
  const restored = await on(a, () => {
    const stored = a.store.getFacts();
    return stored.tags[doomedTag.id];
  });
  assertEqual(restored.deleted.v, true, "the tag tombstone is an explicit fact");
  assertEqual(restored.name.v, "DOOMED", "…with its name kept for a future restore");
});

// =========================================================================
// 12. Import (merge and replace) survives a live round trip
// =========================================================================

await test("12. imported curation propagates through the live V2 path", async () => {
  const dir = createVirtualDirectory();
  const a = await makeInstallation(dir.handle);
  await on(a, () => a.sync.activateSyncV2());
  const sharedId = await on(a, () => a.store.getProfileId());
  await on(a, () => a.store.setFavorite(SUNRISE, true));
  await quiesce(a);
  await on(a, () => a.sync.syncNow());

  const b = await makeInstallation(dir.handle);
  await on(b, () => b.sync.activateSyncV2());
  await on(b, () => b.store.switchProfile(sharedId));
  await quiesce(b);

  // Merge-mode import on A adds something without touching the existing favorite.
  await on(a, () =>
    a.store.importJSON({
      schemaVersion: 2,
      kind: "gallery-profile",
      items: { [STORM]: { favorite: true, favoritedAt: 1700000000000 } },
      tags: [{ id: "imported-tag", name: "IMPORTED" }],
    })
  );
  await quiesce(a);
  await on(a, () => a.sync.syncNow());
  await on(b, () => b.sync.syncNow());

  assertEqual(await on(b, () => b.store.isFavorite(STORM)), true, "the merge-imported favorite reached B");
  assertEqual(await on(b, () => b.store.isFavorite(SUNRISE)), true, "…without disturbing the pre-existing one");
  assert(await on(b, () => b.store.getTags().some((t) => t.id === "imported-tag")), "the imported tag reached B");

  // Replace-mode import on A removes things — as explicit negative facts.
  await on(a, () =>
    a.store.importJSON(
      { schemaVersion: 2, kind: "gallery-profile", items: { [STORM]: { favorite: true } }, tags: [] },
      { mode: "replace" }
    )
  );
  await quiesce(a);
  await on(a, () => a.sync.syncNow());
  await on(b, () => b.sync.syncNow());

  assertEqual(await on(b, () => b.store.isFavorite(SUNRISE)), false, "the replace-mode removal propagated as a negative fact");
  assertEqual(await on(b, () => b.store.isFavorite(STORM)), true, "…while what the import kept survived");
});

// =========================================================================
// 13. Offline mutations + reconnect, and replay/idempotence
// =========================================================================

await test("13. offline mutations converge on reconnect with no Keep Local / Use Synced prompt", async () => {
  const dir = createVirtualDirectory();
  const a = await makeInstallation(dir.handle);
  await on(a, () => a.sync.activateSyncV2());
  const sharedId = await on(a, () => a.store.getProfileId());
  await on(a, () => a.store.setFavorite(SUNRISE, true));
  await quiesce(a);
  await on(a, () => a.sync.syncNow());

  const b = await makeInstallation(dir.handle);
  await on(b, () => b.sync.activateSyncV2());
  await on(b, () => b.store.switchProfile(sharedId));
  await quiesce(b);

  // Both mutate with no syncing at all — the "both were offline" case that
  // used to be an unresolvable conflict under V1.
  await on(a, () => a.store.setHidden(RAIN, true));
  await on(b, () => b.store.setHidden(STORM, true));
  await quiesce(a);
  await quiesce(b);

  await on(a, () => a.sync.syncNow());
  await on(b, () => b.sync.syncNow());
  await on(a, () => a.sync.syncNow());

  assertEqual((await on(a, () => a.sync.getStatus())).status, "connected", "A never entered a conflict state");
  assertEqual((await on(b, () => b.sync.getStatus())).status, "connected", "…nor did B");
  assertEqual(await on(a, () => a.store.isHidden(RAIN)), true, "A kept its own change");
  assertEqual(await on(a, () => a.store.isHidden(STORM)), true, "…and gained B's");

  // Replay / idempotence: further redundant passes change nothing.
  const before = JSON.stringify(await on(a, () => a.store.getFullReplica()));
  for (let i = 0; i < 3; i++) {
    await on(a, () => a.sync.syncNow());
    await on(b, () => b.sync.syncNow());
  }
  assertEqual(
    JSON.stringify(await on(a, () => a.store.getFullReplica())),
    before,
    "repeated passes converge to a fixed point"
  );
});

// =========================================================================
// 14. A V1 installation still behaves exactly as before
// =========================================================================

await test("14. an un-activated installation still runs V1 unchanged", async () => {
  const dir = createVirtualDirectory();
  const a = await makeInstallation(dir.handle);
  await on(a, () => a.store.setFavorite(SUNRISE, true));
  await quiesce(a);
  await on(a, () => a.sync.syncNow());

  const status = await on(a, () => a.sync.getStatus());
  assertEqual(status.mode, "v1", "still on V1");
  assertEqual(status.status, "connected", "and syncing normally");
  assert(Boolean(dir.readFile("manifest.json")), "a V1 manifest was written");
  assertEqual(
    Object.keys(v2Files(dir, a.identity.deviceId)).length,
    0,
    "and NOTHING was written into a V2 device subtree"
  );
});

// =========================================================================
// 15. A failed activation is its own state and runs NEITHER transport
// =========================================================================

await test("15. an installation whose activation failed writes neither V1 nor V2, and says so", async () => {
  // Force the failure at the one step activateSyncV2 does not itself tolerate:
  // reading local facts. A store that cannot even report its own state is not
  // something a migration may guess past.
  const dir = createVirtualDirectory();
  installFakeIndexedDB();
  const brokenStore = {
    whenFactsSettled: async () => {
      throw new Error("Simulated local read failure");
    },
    getDeviceId: () => "dev-broken",
    getFullReplica: async () => ({ schemaVersion: 2, profiles: {}, associations: {} }),
    adoptMergedReplica: async () => undefined,
  };

  const restoreConsole = muteConsole();
  const result = await activateSyncV2({ profileStore: brokenStore, dirHandle: dir.handle });
  restoreConsole();

  assertEqual(result.ok, false, "activation reported failure");
  assertEqual(result.mode, "failed", "…as the explicit third state, not a silent fallback to v1");
  assertEqual((await loadActivationState()).mode, "failed", "…and it was persisted");
  assert(Boolean(result.migration.reason), "…with a reason to surface to the user");

  // A REAL installation booting into that persisted failed state must refuse
  // both transports rather than resuming V1 (its migration may already have
  // adopted V1-seeded facts) or V2 (its migration never finished).
  const identity = new SyncIdentity();
  await identity.ready;
  const store = new ProfileStore({ identity });
  await settle();
  await store.setFavorite(SUNRISE, true);
  await store.whenFactsSettled();

  const sync = new ProfileSync(store);
  await sync.connectNewFolder(dir.handle);
  await settle();

  const beforeFiles = JSON.stringify(dir.snapshotFiles());
  await sync.syncNow();
  await settle();

  const status = sync.getStatus();
  assertEqual(status.mode, "failed", "the installation reports the failed mode");
  assertEqual(status.status, "migration-failed", "…and a truthful, non-connected status");
  assert(
    !["connected", "syncing"].includes(status.status),
    "…never one that implies a working sync"
  );
  assertEqual(JSON.stringify(dir.snapshotFiles()), beforeFiles, "no V1 and no V2 bytes were written");
  assertEqual(store.isFavorite(SUNRISE), true, "and local Profile data is completely intact");
});

// =========================================================================
// 16. Reload (init()) on an activated installation resumes V2, not V1
// =========================================================================

await test("16. a page reload on an activated installation boots straight back into V2", async () => {
  const dir = createVirtualDirectory();
  const a = await makeInstallation(dir.handle);
  await on(a, () => a.sync.activateSyncV2());
  await on(a, () => a.store.setFavorite(SUNRISE, true));
  await quiesce(a);
  await on(a, () => a.sync.syncNow());

  const v1Before = JSON.stringify(v1Files(dir));

  // A RELOAD: same IndexedDB, brand-new object graph, and — unlike every test
  // above — entry through init() rather than connectNewFolder(). This is the
  // path every real user takes on every page load, and the one where a mode
  // that was only read inside connectNewFolder would silently fall back to V1.
  activate(a);
  const identity2 = new SyncIdentity();
  await identity2.ready;
  const store2 = new ProfileStore({ identity: identity2 });
  await settle();
  await store2.whenFactsSettled();
  const sync2 = new ProfileSync(store2);
  await sync2.init();
  await settle();

  assertEqual(sync2.getActivation().mode, "v2", "the reloaded installation resumed on V2");
  assertEqual(sync2.getStatus().mode, "v2", "…and reports it");
  assertEqual(store2.isFavorite(SUNRISE), true, "curation survived the reload");
  assertEqual(identity2.deviceId, a.identity.deviceId, "…and it is still the SAME device, not a new peer");

  // init() runs a reconcile of its own — it must have been a V2 one.
  await settle();
  assertEqual(JSON.stringify(v1Files(dir)), v1Before, "boot wrote no V1 bytes");
  assertEqual(sync2.getStatus().status, "connected", "the boot pass was accepted");

  // And ordinary post-reload activity still goes to V2 only.
  store2.setHidden(RAIN, true);
  await store2.whenFactsSettled();
  await settle();
  await sync2.syncNow();
  assertEqual(JSON.stringify(v1Files(dir)), v1Before, "…and so did everything after it");

  const devicesDir = await Transport.getDevicesDir(await Transport.getSyncV2Root(dir.handle));
  const own = await Transport.readDeviceReplica(devicesDir, identity2.deviceId);
  const profileId = store2.getProfileId();
  assertEqual(own.replica.profiles[profileId].items[RAIN].hidden.v, true, "the post-reload change published via V2");
});

// =========================================================================

console.log(`\n${"-".repeat(60)}`);
console.log(`${passes} assertion(s) passed, ${failures} failure(s)`);
if (failures) {
  console.log("\nFailures:");
  for (const detail of failureDetail) console.log(`  - ${detail}`);
}
process.exit(failures ? 1 : 0);
