#!/usr/bin/env node
// [PHASE-6-SYNC-V2]
// [STAGE-B-REGRESSION-GUARD]
// [WHY: this is the permanent proof of the Stage B invariant — the state
//  fingerprinted == the state serialized == the state read back == the state
//  accepted as baseline. Both halves of the defect it guards (V-01 snapshot
//  aliasing, V-02 unverified baseline acceptance) are silent: they produce a
//  generation that looks successful and only surfaces later as data that
//  cannot be trusted. A test that fails loudly the moment either returns is the
//  only thing that keeps this fixed while Sync V2 is built on top of it.]
//
// Usage:  node tools/test-sync-publish.mjs
// Exits non-zero on any failure, matching tools/check-dom-contract.js.
//
// FUTURE: Stage C's merge engine gets its own harness; add new capability as a
// new numbered test below rather than weakening an existing assertion to make a
// stage pass.

import { pathToFileURL } from "node:url";
import path from "node:path";
import { installFakeIndexedDB, createVirtualDirectory, settle, muteConsole } from "./lib/browser-test-env.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const src = (rel) => pathToFileURL(path.join(ROOT, "src", rel)).href;

// Deep freezing is development-only in the app (see profile-snapshot.js); the
// harness opts in explicitly so every snapshot taken below is frozen and any
// accidental write-through fails loudly here rather than silently in a browser.
const { setSnapshotFreezeEnabled, takeSnapshot } = await import(src("profile/profile-snapshot.js"));
setSnapshotFreezeEnabled(true);

const { ProfileStore } = await import(src("profile/profile-store.js"));
const { ProfileSync, computeFingerprint, readCollectionFromFolder } = await import(src("profile/profile-sync.js"));

// ---- Tiny test runner ----------------------------------------------------

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

// ---- Fixtures ------------------------------------------------------------

const SUNRISE = "Nature/Sunrise.mp4";
const RAIN = "Nature/Rain.mp4";

/**
 * A ProfileStore with three profiles, the LAST of which is active and carries
 * every nested shape the old shallow copy failed to detach: an item record with
 * a tags array, a tag with a nested tagActivity object, and a masterFolder.
 *
 * The active profile is deliberately last in registry order, because
 * writeCollectionToFolder serializes profiles in that order — so a mutation
 * injected during the FIRST file's write lands before the active (and therefore
 * only aliasable) profile is serialized. That ordering is what makes the V-01
 * regression reproducible rather than accidental.
 */
async function buildStore() {
  const fake = installFakeIndexedDB();
  const store = new ProfileStore();
  await settle();

  await store.createProfile("BEAST");
  const bbg4 = await store.createProfile("BBG4");
  await store.switchProfile(bbg4.id);
  await settle();

  store.setFavorite(SUNRISE, true);
  store.setHidden(RAIN, true);
  const tag = store.createTag("KEEP");
  store.setItemTag(SUNRISE, tag.id, true);
  store.recordTagActivity(tag.id, { position: 3, total: 10, shuffle: false });
  store.setMasterFolder({ name: "Nature" });
  await settle();

  return { fake, store, tagId: tag.id, activeId: bbg4.id };
}

function profileFileFor(dir, profileId) {
  return dir.readFile(`profiles/${profileId}.json`);
}

// =========================================================================
// 1. The snapshot boundary itself
// =========================================================================

await test("1. takeSnapshot() detaches every nesting level and freezes the result", async () => {
  const live = { a: { b: [{ c: 1 }] }, tags: ["x"] };
  const snap = takeSnapshot(live);

  assert(snap.a !== live.a, "nested object is a different reference");
  assert(snap.a.b !== live.a.b, "nested array is a different reference");
  assert(snap.a.b[0] !== live.a.b[0], "object inside a nested array is a different reference");

  live.a.b[0].c = 999;
  live.tags.push("y");
  assertEqual(snap.a.b[0].c, 1, "mutating live state does not reach the snapshot");
  assertEqual(snap.tags.length, 1, "pushing to a live array does not reach the snapshot");

  let threw = false;
  try {
    snap.a.b[0].c = 5;
  } catch {
    threw = true;
  }
  assert(threw, "writing through a frozen snapshot throws (development guard)");
});

// =========================================================================
// 2. getFullCollection() — the collection handed to fingerprinting/writing
// =========================================================================

await test("2. getFullCollection() snapshot is unaffected by later live mutations", async () => {
  const { store, tagId } = await buildStore();

  const snapshot = await store.getFullCollection();
  const before = JSON.stringify(snapshot);

  // Every mutation shape that used to reach through a shallow copy.
  store.recordTagActivity(tagId, { position: 99, total: 100, shuffle: false }); // nested tagActivity
  store.setItemTag(SUNRISE, tagId, false); // record.tags array
  store.setFavorite("Nature/Added-Later.mp4", true); // new record
  store.renameTag(tagId, "KEEPER"); // tag object field
  store.setHidden(RAIN, false); // record removal
  store.setMasterFolder({ name: "Somewhere Else" }); // masterFolder object
  await settle();

  assertEqual(JSON.stringify(snapshot), before, "snapshot is byte-identical after live mutation");
});

// =========================================================================
// 3. #persist() — the same defect class, shorter window
// =========================================================================

await test("3. each queued save persists the state as of ITS mutation", async () => {
  const { fake, store, tagId } = await buildStore();

  const saved = [];
  fake.observe((event) => {
    if (event.type === "put" && event.store === "profiles" && Array.isArray(event.value.tags)) {
      const tag = event.value.tags.find((candidate) => candidate.id === tagId);
      const position = tag && tag.tagActivity && tag.tagActivity.shuffleOff && tag.tagActivity.shuffleOff.position;
      if (typeof position === "number") saved.push(position);
    }
  });

  // Two mutations in the same synchronous turn: both snapshots are built before
  // either save drains. If the first snapshot still aliases live state, both
  // saves land as 22 and the first mutation's intended row is lost.
  store.recordTagActivity(tagId, { position: 11, total: 50, shuffle: false });
  store.recordTagActivity(tagId, { position: 22, total: 50, shuffle: false });
  // [SYNCV3 / STAGE-03C / SAME-DEVICE-TAB-STATE]
  // [WHY: tick budget only - the assertions below are untouched. #persist now
  //  re-reads the stored row before writing it (the stale-row guard for
  //  same-origin tabs), and every IndexedDB request is a separate macrotask in
  //  the fake store, so two serialized saves need roughly twice the ticks they
  //  did. Raised rather than reasoned about per-request so this stays robust if
  //  the save path gains another await.]
  await settle(60);

  assert(saved.includes(11), "the first save recorded position 11", `saved positions: [${saved.join(", ")}]`);
  assert(saved.includes(22), "the second save recorded position 22", `saved positions: [${saved.join(", ")}]`);
});

// =========================================================================
// 4. V-01 regression — mutation DURING an in-flight publish
// =========================================================================

await test("4. a publish interrupted by user mutations still writes exactly what it hashed", async () => {
  const { store, tagId, activeId } = await buildStore();

  let injected = false;
  const dir = createVirtualDirectory("Browser Gallery Profiles", {
    async onWrite(filePath) {
      // Fire once, on the first profile file — i.e. after the collection has
      // been fingerprinted and while later files are still to be serialized.
      if (injected || !filePath.startsWith("profiles/")) return;
      injected = true;
      store.recordTagActivity(tagId, { position: 777, total: 1000, shuffle: false });
      store.setFavorite("Nature/Injected-Mid-Write.mp4", true);
      store.createTag("INJECTED-MID-WRITE");
    },
  });

  const sync = new ProfileSync(store);
  await sync.connectNewFolder(dir.handle);
  await settle(25);

  assert(injected, "the harness actually injected a mutation mid-write");

  const status = sync.getStatus();
  assertEqual(status.status, "connected", "publish completed and was accepted");

  // The generation on disk must be internally consistent...
  const readBack = await readCollectionFromFolder(dir.handle);
  assertEqual(readBack.status, "valid", "published generation re-reads as valid");
  assertEqual(readBack.fingerprint, status.baselineFingerprint, "read-back fingerprint == accepted baseline");

  // ...and must be the PRE-mutation state, since that is what was hashed.
  const activeFile = profileFileFor(dir, activeId);
  assert(!activeFile.includes("INJECTED-MID-WRITE"), "the mid-write tag did not leak into the published file");
  assert(!activeFile.includes("Injected-Mid-Write.mp4"), "the mid-write favorite did not leak into the published file");
  assert(!activeFile.includes("777"), "the mid-write tagActivity position did not leak into the published file");

  // And the fingerprint published is genuinely the fingerprint of those bytes.
  const recomputed = await computeFingerprint(readBack.collection);
  assertEqual(recomputed, status.baselineFingerprint, "fingerprint recomputed from files == accepted baseline");
});

// =========================================================================
// 5. Happy path round-trip
// =========================================================================

await test("5. an uninterrupted publish round-trips fingerprint -> files -> read-back", async () => {
  const { store } = await buildStore();
  const dir = createVirtualDirectory();

  const intended = await computeFingerprint(await store.getFullCollection());

  const sync = new ProfileSync(store);
  await sync.connectNewFolder(dir.handle);
  await settle(25);

  const status = sync.getStatus();
  assertEqual(status.status, "connected", "status is connected");
  assertEqual(status.baselineFingerprint, intended, "baseline == the fingerprint of the state we published");
  assert(status.lastSyncAt !== null, "lastSyncAt was recorded");

  const manifest = JSON.parse(dir.readFile("manifest.json"));
  assertEqual(manifest.fingerprint, intended, "manifest advertises the intended fingerprint");

  const readBack = await readCollectionFromFolder(dir.handle);
  assertEqual(readBack.status, "valid", "generation reads back as valid");
  assertEqual(await computeFingerprint(readBack.collection), intended, "files hash to the intended fingerprint");
});

// =========================================================================
// 6. V-02 regression — an inconsistent generation must not become baseline
// =========================================================================

await test("6. a generation whose files do not match its manifest is never blessed", async () => {
  const { store } = await buildStore();

  let corrupt = true;
  const dir = createVirtualDirectory("Browser Gallery Profiles", {
    // Rewrites the committed bytes AFTER the writer has produced them, and
    // leaves manifest.json alone — reproducing "the manifest advertises a
    // fingerprint the actual collection does not hash to".
    transformWrite(filePath, text) {
      if (!corrupt || !filePath.startsWith("profiles/")) return text;
      const parsed = JSON.parse(text);
      parsed.items["Injected/By-Corruption.mp4"] = { favorite: true, favoritedAt: 1 };
      return JSON.stringify(parsed, null, 2);
    },
  });

  const restoreConsole = muteConsole();
  const sync = new ProfileSync(store);
  await sync.connectNewFolder(dir.handle);
  await settle(25);
  restoreConsole();

  const status = sync.getStatus();
  assertEqual(status.status, "verify-failed", "status reports the failure truthfully");
  assertEqual(status.baselineFingerprint, null, "baseline did NOT advance");
  assertEqual(status.lastSyncAt, null, "lastSyncAt was NOT marked successful");
  assert(typeof status.message === "string" && status.message.length > 0, "a truthful message is surfaced");

  // Local Profile state is untouched — publishing only ever reads it.
  assertEqual(store.isFavorite(SUNRISE), true, "local favorite intact");
  assertEqual(store.isHidden(RAIN), true, "local hidden intact");
  assertEqual(store.getTags().length, 1, "local tag vocabulary intact");
  assertEqual(store.getProfileName(), "BBG4", "active profile unchanged");
  assertEqual(store.listProfiles().length, 3, "no profile was lost");

  // The folder now holds an inconsistent generation. The engine must keep
  // refusing to overwrite it rather than "repairing" data whose true state it
  // cannot know — see the invalid-remote branch in #reconcileImpl.
  corrupt = false;
  const muted = muteConsole();
  await sync.syncNow();
  await settle(25);
  muted();
  assertEqual(sync.getStatus().baselineFingerprint, null, "baseline still not advanced over unknown remote data");
});

// =========================================================================
// 7. A generation that verifies but is NOT ours (a concurrent writer)
// =========================================================================

/** An internally consistent generation, as though another device published it. */
async function buildForeignGeneration(collection) {
  const foreign = JSON.parse(JSON.stringify(collection));
  foreign[0].items["Foreign/Other-Device.mp4"] = { favorite: true, favoritedAt: 1 };

  const fingerprint = await computeFingerprint(foreign);
  const files = {};
  for (const entry of foreign) {
    files[`profiles/${entry.id}.json`] = JSON.stringify(
      {
        schemaVersion: 2,
        kind: "gallery-profile",
        exportedAt: new Date().toISOString(),
        profileId: entry.id,
        profileName: entry.name,
        masterFolder: entry.masterFolder || null,
        items: entry.items || {},
        tags: entry.tags || [],
      },
      null,
      2
    );
  }
  const manifest = JSON.stringify(
    {
      schemaVersion: 1,
      kind: "gallery-profile-sync-manifest",
      profileIds: foreign.map((entry) => entry.id),
      fingerprint,
      updatedAt: Date.now(),
    },
    null,
    2
  );
  return { fingerprint, files, manifest };
}

await test("7. a self-consistent generation written by another device is not blessed as ours", async () => {
  const { store } = await buildStore();
  const ours = await computeFingerprint(await store.getFullCollection());
  const foreign = await buildForeignGeneration(await store.getFullCollection());
  assert(foreign.fingerprint !== ours, "the foreign generation really is different");

  let swapped = false;
  const dir = createVirtualDirectory("Browser Gallery Profiles", {
    // Lands the other device's complete generation on top of ours at the moment
    // our manifest commits — the concurrent-writer race, made deterministic.
    transformWrite(filePath, text) {
      if (filePath !== "manifest.json" || swapped) return text;
      swapped = true;
      for (const [foreignPath, foreignText] of Object.entries(foreign.files)) dir.writeFile(foreignPath, foreignText);
      return foreign.manifest;
    },
  });

  const restoreConsole = muteConsole();
  const sync = new ProfileSync(store);
  await sync.connectNewFolder(dir.handle);
  await settle(25);
  restoreConsole();

  assert(swapped, "the harness actually swapped in the foreign generation");

  const status = sync.getStatus();
  assertEqual(status.status, "verify-failed", "a valid-but-foreign generation still fails verification");
  assertEqual(status.baselineFingerprint, null, "we did not adopt another device's fingerprint as our baseline");

  // The remote is valid, so the next pass reconciles normally rather than
  // being stuck — here into the existing user-resolvable conflict state,
  // because both sides genuinely diverged.
  await sync.syncNow();
  await settle(25);
  assertEqual(sync.getStatus().status, "conflict", "the next pass reaches a resolvable state, not silent overwrite");
  assertEqual(sync.getStatus().baselineFingerprint, null, "still no baseline was invented");
});

// =========================================================================
// 8. A transient read-back failure must not advance the baseline — and recovers
// =========================================================================

await test("8. a transient read-back failure withholds the baseline, then self-heals", async () => {
  const { store } = await buildStore();

  let failRead = false;
  const dir = createVirtualDirectory("Browser Gallery Profiles", {
    beforeRead(filePath) {
      if (!failRead || filePath !== "manifest.json") return;
      const error = new Error("transient read failure");
      error.name = "NotReadableError";
      throw error;
    },
    async onWrite(filePath) {
      // Arm the fault as the manifest commits, so the write itself succeeds and
      // only the verification read fails — the realistic Drive glitch.
      if (filePath === "manifest.json") failRead = true;
    },
  });

  const restoreConsole = muteConsole();
  const sync = new ProfileSync(store);
  await sync.connectNewFolder(dir.handle);
  await settle(25);
  restoreConsole();

  assertEqual(sync.getStatus().status, "verify-failed", "unverifiable publish is reported, not assumed successful");
  assertEqual(sync.getStatus().baselineFingerprint, null, "baseline withheld even though the write itself succeeded");

  // Next pass, folder readable again: the files really were correct, so this
  // settles with no user intervention and no rewrite.
  failRead = false;
  await sync.syncNow();
  await settle(25);

  const recovered = sync.getStatus();
  assertEqual(recovered.status, "connected", "the next pass recovers automatically");
  const manifest = JSON.parse(dir.readFile("manifest.json"));
  assertEqual(recovered.baselineFingerprint, manifest.fingerprint, "baseline now matches what is actually on disk");
});

// =========================================================================
// 9. The irreversible half of publishing is withheld until verified
// =========================================================================

await test("9. obsolete profile files are deleted only by a VERIFIED publish", async () => {
  // ---- verified publish: the cleanup runs ----
  {
    const { store } = await buildStore();
    const dir = createVirtualDirectory();
    const sync = new ProfileSync(store);
    await sync.connectNewFolder(dir.handle);
    await settle(25);
    assertEqual(sync.getStatus().status, "connected", "baseline publish succeeded");

    const doomed = store.listProfiles().find((entry) => entry.name === "BEAST");
    assert(profileFileFor(dir, doomed.id) !== undefined, "the profile's file exists before deletion");

    await store.deleteProfile(doomed.id);
    await settle();
    await sync.syncNow();
    await settle(25);

    assertEqual(sync.getStatus().status, "connected", "the publish verified");
    assertEqual(profileFileFor(dir, doomed.id), undefined, "obsolete file removed after a verified publish");
  }

  // ---- unverified publish: the cleanup is withheld ----
  {
    const { store } = await buildStore();

    let armFault = false;
    let failRead = false;
    const dir = createVirtualDirectory("Browser Gallery Profiles", {
      beforeRead(filePath) {
        if (!failRead || filePath !== "manifest.json") return;
        const error = new Error("transient read failure");
        error.name = "NotReadableError";
        throw error;
      },
      async onWrite(filePath) {
        if (armFault && filePath === "manifest.json") failRead = true;
      },
    });

    const sync = new ProfileSync(store);
    await sync.connectNewFolder(dir.handle);
    await settle(25);
    assertEqual(sync.getStatus().status, "connected", "baseline publish succeeded");

    const doomed = store.listProfiles().find((entry) => entry.name === "BEAST");
    await store.deleteProfile(doomed.id);
    await settle();

    armFault = true;
    const restoreConsole = muteConsole();
    await sync.syncNow();
    await settle(25);
    restoreConsole();

    assertEqual(sync.getStatus().status, "verify-failed", "the unverified publish is reported as failed");
    assert(
      profileFileFor(dir, doomed.id) !== undefined,
      "the obsolete file survives an unverified publish — no irreversible step ran"
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
// Auto-sync debounce timers may still be pending; nothing further is asserted,
// so exit deterministically rather than waiting ~3s for them.
process.exit(failures ? 1 : 0);
