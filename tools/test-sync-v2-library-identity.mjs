#!/usr/bin/env node
// [PHASE-6-SYNC-V2]
// [STAGE-D3-LIBRARY-IDENTITY]
// [WHY: physical folders are local; only stable logical identity and
//  association may synchronize. This proves the boundary holds end to end —
//  a libraryId is minted only on explicit association, an FSA handle/
//  signature/folder name never crosses into a replica or a published byte,
//  association changes converge like any other fact, and a second device can
//  only join an existing shared library through an explicit id, never a
//  name/signature guess.]
//
// Usage:  node tools/test-sync-v2-library-identity.mjs

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

// ---- Multi-device fixture (same pattern as test-sync-v2-transport.mjs) ---

async function makeDevice() {
  installFakeIndexedDB();
  const idb = globalThis.indexedDB;
  const identity = new SyncIdentity();
  await identity.ready;
  const store = new ProfileStore({ identity });
  await settle();
  await store.whenFactsSettled();
  await store.whenAssociationsSettled();
  return { idb, identity, store };
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

async function syncPass(device, dirHandle) {
  return on(device, () => runSyncV2Pass({ profileStore: device.store, dirHandle }));
}

/** A fake FSA directory handle sufficient for library-registry.js's isSameEntry matching. */
function fakeHandle(name) {
  const handle = { name, kind: "directory" };
  handle.isSameEntry = async (other) => other === handle;
  return handle;
}

// =========================================================================
// 1. Explicit association mints a libraryId
// =========================================================================

await test("1. explicit association mints a libraryId; opening a folder alone does not", async () => {
  const a = await makeDevice();

  const row = await on(a, () => LibraryRegistry.addOrUpdateLibrary(fakeHandle("Nature")));
  assertEqual(row.libraryId, undefined, "opening the folder alone did not mint a libraryId");

  const libraryId = await on(a, () => a.store.setLibraryAssociation(row.id, "profile-x"));
  assert(typeof libraryId === "string" && libraryId.length > 0, "association minted a libraryId");

  const reread = await on(a, () => LibraryRegistry.getLibraryByLibraryId(libraryId));
  assertEqual(reread.id, row.id, "the row now carries that libraryId");
  assertEqual(reread.profileId, "profile-x", "…and the local profileId field");
});

// =========================================================================
// 2. Reopening the same local library preserves its libraryId
// =========================================================================

await test("2. reopening the same physical folder preserves its libraryId", async () => {
  const a = await makeDevice();
  const handle = fakeHandle("Nature");
  const row = await on(a, () => LibraryRegistry.addOrUpdateLibrary(handle));
  const libraryId = await on(a, () => a.store.setLibraryAssociation(row.id, "profile-x"));

  // Re-pick the SAME physical folder (same handle -> isSameEntry matches).
  const reopened = await on(a, () => LibraryRegistry.addOrUpdateLibrary(handle));
  assertEqual(reopened.id, row.id, "re-picking matched the existing row");
  assertEqual(reopened.libraryId, libraryId, "…and its libraryId is unchanged");

  // Re-associating (even to the same Profile) must not mint a second id.
  const libraryId2 = await on(a, () => a.store.setLibraryAssociation(row.id, "profile-x"));
  assertEqual(libraryId2, libraryId, "re-associating preserves the same libraryId");
});

// =========================================================================
// 3/4. Association changes and disassociation sync
// =========================================================================

await test("3/4. association A→B and explicit disassociation both sync", async () => {
  const dir = createVirtualDirectory();
  const a = await makeDevice();
  const row = await on(a, () => LibraryRegistry.addOrUpdateLibrary(fakeHandle("Nature")));
  const libraryId = await on(a, () => a.store.setLibraryAssociation(row.id, "profile-a"));
  await quiesce(a);
  await syncPass(a, dir.handle);

  const b = await makeDevice();
  await syncPass(b, dir.handle);
  const afterFirst = await on(b, () => b.store.listAssociations());
  assertEqual(afterFirst[libraryId], "profile-a", "B learned the initial association");

  // A changes the association to a different Profile.
  await on(a, () => a.store.setLibraryAssociation(row.id, "profile-b"));
  await quiesce(a);
  await syncPass(a, dir.handle);
  await syncPass(b, dir.handle);
  assertEqual((await on(b, () => b.store.listAssociations()))[libraryId], "profile-b", "the change to profile-b synced");

  // A explicitly disassociates.
  await on(a, () => a.store.setLibraryAssociation(row.id, null));
  await quiesce(a);
  await syncPass(a, dir.handle);
  await syncPass(b, dir.handle);
  const afterDisassociate = await on(b, () => b.store.listAssociations());
  assertEqual(afterDisassociate[libraryId], undefined, "the disassociation synced — no association reported");

  const raw = await on(b, () => b.store.getAssociations());
  assertEqual(raw[libraryId].v, null, "…as an EXPLICIT null fact, not merely an absent key");
});

// =========================================================================
// 5. Two devices update the same association; newer stamped fact wins
// =========================================================================

await test("5. two devices race an association update; the newer stamp wins deterministically", async () => {
  const dir = createVirtualDirectory();
  const a = await makeDevice();
  const rowA = await on(a, () => LibraryRegistry.addOrUpdateLibrary(fakeHandle("Nature")));
  const libraryId = await on(a, () => a.store.setLibraryAssociation(rowA.id, "profile-a"));
  await quiesce(a);
  await syncPass(a, dir.handle);

  const b = await makeDevice();
  await syncPass(b, dir.handle); // B never had a local row for it, but now holds the fact

  // B links its OWN local folder to the same shared library, then updates the
  // association. B's write is issued strictly after A's (real wall-clock
  // stamps), so it must win.
  const bLibraryRow = await on(b, () => LibraryRegistry.addOrUpdateLibrary(fakeHandle("Nature (on B)")));
  await on(b, () => LibraryRegistry.linkLocalLibraryToSharedId(bLibraryRow.id, libraryId));
  await on(b, () => b.store.setLibraryAssociation(bLibraryRow.id, "profile-c"));
  await quiesce(b);
  await syncPass(b, dir.handle);

  await syncPass(a, dir.handle);
  assertEqual((await on(a, () => a.store.listAssociations()))[libraryId], "profile-c", "A converged on B's newer update");
  await syncPass(b, dir.handle);
  assertEqual((await on(b, () => b.store.listAssociations()))[libraryId], "profile-c", "…and B kept it (idempotent)");
});

// =========================================================================
// 6. Unrelated library associations survive merge
// =========================================================================

await test("6. unrelated associations are untouched by merging in a different one", async () => {
  const dir = createVirtualDirectory();
  const a = await makeDevice();
  const rowNature = await on(a, () => LibraryRegistry.addOrUpdateLibrary(fakeHandle("Nature")));
  const rowUrban = await on(a, () => LibraryRegistry.addOrUpdateLibrary(fakeHandle("Urban")));
  const natureId = await on(a, () => a.store.setLibraryAssociation(rowNature.id, "profile-a"));
  const urbanId = await on(a, () => a.store.setLibraryAssociation(rowUrban.id, "profile-b"));
  await quiesce(a);
  await syncPass(a, dir.handle);

  const b = await makeDevice();
  await syncPass(b, dir.handle);
  const associations = await on(b, () => b.store.listAssociations());
  assertEqual(associations[natureId], "profile-a", "Nature's association arrived");
  assertEqual(associations[urbanId], "profile-b", "…and Urban's, independently");

  // Changing Nature must not disturb Urban.
  await on(a, () => a.store.setLibraryAssociation(rowNature.id, "profile-z"));
  await quiesce(a);
  await syncPass(a, dir.handle);
  await syncPass(b, dir.handle);
  const after = await on(b, () => b.store.listAssociations());
  assertEqual(after[natureId], "profile-z", "Nature's change synced");
  assertEqual(after[urbanId], "profile-b", "Urban's association is UNCHANGED");
});

// =========================================================================
// 7. Active Profile != associated Profile — curation still lands correctly
// =========================================================================

await test("7. associating a library does not switch the active Profile, and curation follows the active Profile", async () => {
  const a = await makeDevice();
  const originalActive = await on(a, () => a.store.getProfileId());
  const otherProfile = await on(a, () => a.store.createProfile("OTHER"));

  const row = await on(a, () => LibraryRegistry.addOrUpdateLibrary(fakeHandle("Nature")));
  await on(a, () => a.store.setLibraryAssociation(row.id, otherProfile.id));

  assertEqual(await on(a, () => a.store.getProfileId()), originalActive, "the active Profile did not change");

  await on(a, () => a.store.setFavorite("Nature/Sunrise.mp4", true));
  await quiesce(a);
  const replica = await on(a, () => a.store.getFullReplica());
  assertEqual(
    replica.profiles[originalActive].items["Nature/Sunrise.mp4"].favorite.v.on,
    true,
    "curation landed in the ACTIVE profile"
  );
  assertEqual(
    replica.profiles[otherProfile.id]?.items?.["Nature/Sunrise.mp4"],
    undefined,
    "…never in the merely-ASSOCIATED profile"
  );
});

// =========================================================================
// 8. FSA handle never appears in the replica or published bytes
// =========================================================================

await test("8. an FSA handle, signature and folder name never leak into the replica or published bytes", async () => {
  const dir = createVirtualDirectory();
  const a = await makeDevice();
  const row = await on(a, () => LibraryRegistry.addOrUpdateLibrary(fakeHandle("Very Secret Folder Name")));
  await on(a, () => a.store.setLibraryAssociation(row.id, "profile-x"));
  await quiesce(a);
  await syncPass(a, dir.handle);

  const replica = await on(a, () => a.store.getFullReplica());
  const replicaText = JSON.stringify(replica);
  assert(!replicaText.includes("Very Secret Folder Name"), "the folder name is not in the replica");
  assert(!replicaText.includes("isSameEntry"), "no handle-shaped object leaked into the replica");

  const published = JSON.stringify(dir.snapshotFiles());
  assert(!published.includes("Very Secret Folder Name"), "the folder name is not in any published file");
  assert(!published.includes("handle"), "no `handle` key appears in any published file");
});

// =========================================================================
// 9. Signature / folder name are never used as shared identity
// =========================================================================

await test("9. two different physical folders that happen to share a name never share a libraryId", async () => {
  const a = await makeDevice();
  const rowOne = await on(a, () => LibraryRegistry.addOrUpdateLibrary(fakeHandle("Nature")));
  const rowTwo = await on(a, () => LibraryRegistry.addOrUpdateLibrary(fakeHandle("Nature"))); // different handle, same name

  assert(rowOne.id !== rowTwo.id, "two different handles produced two different local rows despite the identical name");

  const idOne = await on(a, () => a.store.setLibraryAssociation(rowOne.id, "profile-a"));
  const idTwo = await on(a, () => a.store.setLibraryAssociation(rowTwo.id, "profile-b"));
  assert(idOne !== idTwo, "…and two independently-minted libraryIds — no name-based coalescing");
});

// =========================================================================
// 10. Second-device linking requires an explicit libraryId; no auto-match
// =========================================================================

await test("10. a second device can only join an EXISTING shared library via an explicit libraryId, never a guess", async () => {
  const dir = createVirtualDirectory();
  const a = await makeDevice();
  const rowA = await on(a, () => LibraryRegistry.addOrUpdateLibrary(fakeHandle("Nature")));
  const sharedId = await on(a, () => a.store.setLibraryAssociation(rowA.id, "profile-x"));
  await quiesce(a);
  await syncPass(a, dir.handle);

  const b = await makeDevice();
  await syncPass(b, dir.handle); // B now knows the association fact exists, but has no local folder for it

  // B opens a DIFFERENT physical folder that happens to share the same name.
  // Opening it alone must NOT auto-link it to the shared library — no
  // signature/name heuristic anywhere in this path.
  const rowB = await on(b, () => LibraryRegistry.addOrUpdateLibrary(fakeHandle("Nature")));
  assertEqual(rowB.libraryId, undefined, "opening a same-named folder on B did not auto-link it");

  const restoreConsole = muteConsole();
  const wrongLink = await on(b, () => LibraryRegistry.linkLocalLibraryToSharedId(rowB.id, "totally-made-up-id"));
  restoreConsole();
  assert(wrongLink !== null, "linking to an arbitrary (even unknown) id is mechanically allowed — it is an explicit user action");

  // The REAL explicit link, using the actual shared id.
  const freshRow = await on(b, () => LibraryRegistry.addOrUpdateLibrary(fakeHandle("Nature (B's copy)")));
  const linked = await on(b, () => LibraryRegistry.linkLocalLibraryToSharedId(freshRow.id, sharedId));
  assertEqual(linked.libraryId, sharedId, "explicit linking with the real shared id succeeded");

  // Relinking to a DIFFERENT id is refused — one physical folder cannot fork
  // onto two logical identities.
  const restoreConsole2 = muteConsole();
  const refused = await on(b, () => LibraryRegistry.linkLocalLibraryToSharedId(freshRow.id, "some-other-id"));
  restoreConsole2();
  assertEqual(refused, null, "relinking an already-linked row to a DIFFERENT id is refused");

  // Once linked, a sync pass reconciles the local profileId field.
  await syncPass(b, dir.handle);
  const reread = await on(b, () => LibraryRegistry.getLibraryByLibraryId(sharedId));
  assertEqual(reread.profileId, "profile-x", "after linking, the next sync reconciled B's local profileId field");
});

// =========================================================================
// 11. Association survives reload
// =========================================================================

await test("11. an association survives a full reload", async () => {
  const a = await makeDevice();
  const row = await on(a, () => LibraryRegistry.addOrUpdateLibrary(fakeHandle("Nature")));
  const libraryId = await on(a, () => a.store.setLibraryAssociation(row.id, "profile-x"));
  await quiesce(a);

  activate(a);
  const reloadedIdentity = new SyncIdentity();
  await reloadedIdentity.ready;
  const reloaded = new ProfileStore({ identity: reloadedIdentity });
  await settle();
  await reloaded.whenAssociationsSettled();

  assertEqual(reloaded.listAssociations()[libraryId], "profile-x", "the association survived reload");
  const rowAfterReload = await on(a, () => LibraryRegistry.getLibraryByLibraryId(libraryId));
  assertEqual(rowAfterReload.id, row.id, "…and the local row's libraryId link survived too");
});

// =========================================================================
// 12. Corrupted associations.json causes peer skip
// =========================================================================

await test("12. a corrupted associations.json invalidates that peer's WHOLE generation, exactly like other declared files", async () => {
  const dir = createVirtualDirectory();
  const a = await makeDevice();
  const row = await on(a, () => LibraryRegistry.addOrUpdateLibrary(fakeHandle("Nature")));
  await on(a, () => a.store.setLibraryAssociation(row.id, "profile-x"));
  await on(a, () => a.store.setFavorite("Nature/Sunrise.mp4", true));
  await quiesce(a);
  await syncPass(a, dir.handle);

  const assocPath = `sync-v2/devices/${a.identity.deviceId}/associations.json`;
  dir.writeFile(assocPath, dir.readFile(assocPath).replace('"profile-x"', '"tampered-value"'));

  const b = await makeDevice();
  const restoreConsole = muteConsole();
  const result = await syncPass(b, dir.handle);
  restoreConsole();

  assert(
    result.skippedPeers.some((p) => p.deviceId === a.identity.deviceId),
    "A was skipped as a whole peer due to the tampered associations.json"
  );
  const associations = await on(b, () => b.store.listAssociations());
  assertEqual(associations[row.libraryId], undefined, "…so its association did NOT merge in");
  const replica = await on(b, () => b.store.getFullReplica());
  assertEqual(
    Object.values(replica.profiles).some((p) => p.items && p.items["Nature/Sunrise.mp4"]),
    false,
    "…and A's PROFILE data (declared in the same corrupted generation) did not merge in either"
  );
});

// =========================================================================
// 13. Replay / idempotence
// =========================================================================

await test("13. replaying the same association passes repeatedly converges to a fixed point", async () => {
  const dir = createVirtualDirectory();
  const a = await makeDevice();
  const row = await on(a, () => LibraryRegistry.addOrUpdateLibrary(fakeHandle("Nature")));
  const libraryId = await on(a, () => a.store.setLibraryAssociation(row.id, "profile-x"));
  await quiesce(a);

  const first = await syncPass(a, dir.handle);
  assertEqual(first.published, true, "the first pass published");
  const second = await syncPass(a, dir.handle);
  assertEqual(second.published, false, "an unchanged second pass republishes nothing");

  const b = await makeDevice();
  await syncPass(b, dir.handle);
  await syncPass(b, dir.handle);
  await syncPass(b, dir.handle);
  const state1 = await on(b, () => b.store.getAssociations());
  await syncPass(a, dir.handle);
  await syncPass(b, dir.handle);
  const state2 = await on(b, () => b.store.getAssociations());
  assertEqual(JSON.stringify(state1), JSON.stringify(state2), "repeated redundant passes converge to a fixed point");
  assertEqual(state2[libraryId].v, "profile-x", "…holding the correct, converged value");
});

// =========================================================================

console.log(`\n${"-".repeat(60)}`);
console.log(`${passes} assertion(s) passed, ${failures} failure(s)`);
if (failures) {
  console.log("\nFailures:");
  for (const detail of failureDetail) console.log(`  - ${detail}`);
}
process.exit(failures ? 1 : 0);
