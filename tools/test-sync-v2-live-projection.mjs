#!/usr/bin/env node
// [PHASE-6-SYNC-V2]
// [STAGE-E-LIVE-REMOTE-PROJECTION]
// [WHY: synchronized facts adopted into the active Profile must immediately
//  become visible in the loaded UI on either device without reload or local
//  interaction. The real two-device failure had a correct replica, a correct
//  ProfileStore, and a correct export — and a stale screen, because remote
//  adoption notified nobody. That failure mode is invisible to every existing
//  suite: they all assert on STATE, and the state was right. These tests assert
//  on the NOTIFICATION, which is the thing that was missing.]
//
// Usage:  node tools/test-sync-v2-live-projection.mjs

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
const { runSyncV2Pass } = await import(src("profile/sync-v2.js"));

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

// ---- Fixture ---------------------------------------------------------------
//
// Each device carries a `view` — a faithful stand-in for main.js's loaded media
// projection. It is wired to the store the SAME way main.js wires it (a single
// profile.subscribe that re-projects every loaded item), so a missing
// notification fails here exactly as it did on the real Chromebook.

const CLIP = "X--------------OLD-Pic-Collection/MasterAll/Photo 2022-01-03 at 12.00.00 PM.png";
const OTHER = "X--------------OLD-Pic-Collection/MasterAll/Photo 2022-02-02 at 1.00.00 PM.png";
const THIRD = "X--------------OLD-Pic-Collection/MasterAll/Photo 2022-03-03 at 2.00.00 PM.png";
const LOADED = [CLIP, OTHER, THIRD];

async function makeDevice() {
  installFakeIndexedDB();
  const idb = globalThis.indexedDB;
  const identity = new SyncIdentity();
  await identity.ready;
  const store = new ProfileStore({ identity });
  await settle();
  await store.whenFactsSettled();

  // The live projection main.js maintains on every loaded MediaItem.
  const view = {
    items: LOADED.map((relativePath) => ({
      relativePath,
      isFavorite: false,
      isHidden: false,
      favoritedAt: null,
      userTags: [],
    })),
    reprojections: 0,
    notifications: 0,
    tagVocabulary: [],
  };

  store.subscribe(() => {
    view.notifications += 1;
    view.reprojections += 1;
    for (const item of view.items) {
      item.isFavorite = store.isFavorite(item.relativePath);
      item.isHidden = store.isHidden(item.relativePath);
      item.favoritedAt = store.getFavoritedAt(item.relativePath);
      item.userTags = store.getItemTags(item.relativePath);
    }
    view.tagVocabulary = store.getTags().map((t) => t.name);
  });

  const device = { idb, identity, store, view, state: {} };
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
async function pass(device, dirHandle) {
  return on(device, () => runSyncV2Pass({ profileStore: device.store, dirHandle, state: device.state }));
}
const viewItem = (device, relativePath) => device.view.items.find((i) => i.relativePath === relativePath);
/** main.js's Favorites Only filter, applied to the SAME projected flags. */
const favoritesOnly = (device) => device.view.items.filter((i) => i.isFavorite).map((i) => i.relativePath);

/** Two devices sharing one Profile, both already converged. */
async function makePair(dir) {
  const a = await makeDevice();
  const b = await makeDevice();
  const sharedId = await on(a, () => a.store.getProfileId());
  await pass(a, dir.handle);
  await pass(b, dir.handle);
  await on(b, () => b.store.switchProfile(sharedId));
  await quiesce(b);
  await pass(b, dir.handle);
  await pass(a, dir.handle);
  return { a, b, sharedId };
}

// =========================================================================
// 1-3. A remote favorite / unfavorite reaches the LIVE projection, both ways
// =========================================================================

for (const [publisherName, readerName] of [
  ["A", "B"],
  ["B", "A"],
]) {
  await test(`1-3. ${publisherName} favorites, ${readerName}'s live view updates with no local action`, async () => {
    const dir = createVirtualDirectory();
    const { a, b } = await makePair(dir);
    const publisher = publisherName === "A" ? a : b;
    const reader = publisherName === "A" ? b : a;

    assertEqual(viewItem(reader, CLIP).isFavorite, false, "the reader's view starts unfavorited");
    const before = reader.view.reprojections;

    await on(publisher, () => publisher.store.setFavorite(CLIP, true));
    await quiesce(publisher);
    await pass(publisher, dir.handle);

    await pass(reader, dir.handle);
    await quiesce(reader);

    assertEqual(
      await on(reader, () => reader.store.isFavorite(CLIP)),
      true,
      "the fact reached the reader's ProfileStore"
    );
    assert(reader.view.reprojections > before, "…and the live projection was NOTIFIED — this is the bug");
    assertEqual(viewItem(reader, CLIP).isFavorite, true, "…so the loaded item now reads as favorited");
    assertEqual(
      viewItem(reader, CLIP).favoritedAt,
      await on(publisher, () => publisher.store.getFavoritedAt(CLIP)),
      "…with the publisher's favoritedAt, not a locally invented one"
    );

    // ---- and the reverse mutation ----
    const beforeUnfav = reader.view.reprojections;
    await on(publisher, () => publisher.store.setFavorite(CLIP, false));
    await quiesce(publisher);
    await pass(publisher, dir.handle);
    await pass(reader, dir.handle);
    await quiesce(reader);

    assert(reader.view.reprojections > beforeUnfav, "an un-favorite notifies too");
    assertEqual(viewItem(reader, CLIP).isFavorite, false, "…and the live view clears it");
  });
}

// =========================================================================
// 4. Remote hide / unhide
// =========================================================================

await test("4. a remote hide and unhide both reach the live projection", async () => {
  const dir = createVirtualDirectory();
  const { a, b } = await makePair(dir);

  await on(a, () => a.store.setHidden(OTHER, true));
  await quiesce(a);
  await pass(a, dir.handle);
  await pass(b, dir.handle);
  await quiesce(b);
  assertEqual(viewItem(b, OTHER).isHidden, true, "the remote hide is visible in the live view");

  await on(a, () => a.store.setHidden(OTHER, false));
  await quiesce(a);
  await pass(a, dir.handle);
  await pass(b, dir.handle);
  await quiesce(b);
  assertEqual(viewItem(b, OTHER).isHidden, false, "…and so is the unhide");
});

// =========================================================================
// 5. Remote tag assignment / untag / vocabulary
// =========================================================================

await test("5. remote tag vocabulary and assignments reach the live projection", async () => {
  const dir = createVirtualDirectory();
  const { a, b } = await makePair(dir);

  const tag = await on(a, () => a.store.createTag("REMOTE-TAG"));
  await on(a, () => a.store.setItemTag(CLIP, tag.id, true));
  await quiesce(a);
  await pass(a, dir.handle);
  await pass(b, dir.handle);
  await quiesce(b);

  assert(b.view.tagVocabulary.includes("REMOTE-TAG"), "the remote tag reached the live vocabulary");
  assert(viewItem(b, CLIP).userTags.includes(tag.id), "…and the assignment reached the loaded item");

  // Untag.
  await on(a, () => a.store.setItemTag(CLIP, tag.id, false));
  await quiesce(a);
  await pass(a, dir.handle);
  await pass(b, dir.handle);
  await quiesce(b);
  assert(!viewItem(b, CLIP).userTags.includes(tag.id), "a remote untag clears it live");

  // Deleting the tag remotely removes it from the live vocabulary too.
  await on(a, () => a.store.deleteTag(tag.id));
  await quiesce(a);
  await pass(a, dir.handle);
  await pass(b, dir.handle);
  await quiesce(b);
  assert(!b.view.tagVocabulary.includes("REMOTE-TAG"), "a remote tag deletion clears the live vocabulary");
});

// =========================================================================
// 6 + 7. A live Favorites-Only filter follows remote changes both ways
// =========================================================================

await test("6/7. an active Favorites Only filter gains and loses items from remote changes", async () => {
  const dir = createVirtualDirectory();
  const { a, b } = await makePair(dir);

  assertEqual(favoritesOnly(b).length, 0, "the filter starts empty");

  await on(a, () => a.store.setFavorite(CLIP, true));
  await on(a, () => a.store.setFavorite(THIRD, true));
  await quiesce(a);
  await pass(a, dir.handle);
  await pass(b, dir.handle);
  await quiesce(b);
  assertEqual(favoritesOnly(b).length, 2, "remote favorites entered the filtered set");
  assert(favoritesOnly(b).includes(CLIP), "…including the exact real-device item");

  await on(a, () => a.store.setFavorite(CLIP, false));
  await quiesce(a);
  await pass(a, dir.handle);
  await pass(b, dir.handle);
  await quiesce(b);
  assertEqual(favoritesOnly(b).length, 1, "a remote un-favorite left the filtered set");
  assert(!favoritesOnly(b).includes(CLIP), "…and it is the right one that left");
});

// =========================================================================
// 8. The currently-selected item's controls read from the same source
// =========================================================================

await test("8. the selected item's favorite/hide state is truthful after a remote change", async () => {
  const dir = createVirtualDirectory();
  const { a, b } = await makePair(dir);

  // main.js's syncFavoriteButtons/syncHideButton read the STORE directly for
  // the current item, so this asserts the same values those controls render.
  const selected = CLIP;
  assertEqual(await on(b, () => b.store.isFavorite(selected)), false, "control starts off");

  await on(a, () => a.store.setFavorite(selected, true));
  await on(a, () => a.store.setHidden(selected, true));
  await quiesce(a);
  await pass(a, dir.handle);
  await pass(b, dir.handle);
  await quiesce(b);

  assertEqual(await on(b, () => b.store.isFavorite(selected)), true, "the favourite control would now render on");
  assertEqual(await on(b, () => b.store.isHidden(selected)), true, "…and the hide control too");
  assert(b.view.notifications > 0, "…and a notification fired to make the controls re-render");
});

// =========================================================================
// 9 + 10. Exactly enough notification — and none when nothing changed
// =========================================================================

await test("9/10. a no-op remote pass notifies nobody; a real change notifies once", async () => {
  const dir = createVirtualDirectory();
  const { a, b } = await makePair(dir);

  await quiesce(b);
  const idleBefore = b.view.notifications;
  for (let i = 0; i < 4; i++) {
    await pass(b, dir.handle);
    await quiesce(b);
  }
  assertEqual(
    b.view.notifications,
    idleBefore,
    "four idle no-op passes re-projected nothing — the 17k loop must not run for free"
  );

  await on(a, () => a.store.setFavorite(OTHER, true));
  await quiesce(a);
  await pass(a, dir.handle);

  const beforeReal = b.view.notifications;
  await pass(b, dir.handle);
  await quiesce(b);
  assert(b.view.notifications > beforeReal, "a real adopted change DID notify");
  assertEqual(viewItem(b, OTHER).isFavorite, true, "…and projected");

  // Re-passing the same state must go quiet again.
  const afterReal = b.view.notifications;
  await pass(b, dir.handle);
  await quiesce(b);
  assertEqual(b.view.notifications, afterReal, "and re-passing the same state is silent again");
});

// =========================================================================
// 11 + 12. An INACTIVE Profile's remote changes never touch the active view
// =========================================================================

await test("11/12. remote changes to a non-active Profile leave the active view alone, then appear on switch", async () => {
  const dir = createVirtualDirectory();
  const { a, b, sharedId } = await makePair(dir);

  // A second Profile that B is NOT currently in.
  const other = await on(a, () => a.store.createProfile("OTHER-PROFILE"));
  await on(a, () => a.store.switchProfile(other.id));
  await quiesce(a);
  await on(a, () => a.store.setFavorite(CLIP, true));
  await quiesce(a);
  await pass(a, dir.handle);

  const beforeItems = JSON.stringify(b.view.items);
  await pass(b, dir.handle);
  await quiesce(b);

  assertEqual(
    viewItem(b, CLIP).isFavorite,
    false,
    "B's ACTIVE profile view is untouched by a change to a different Profile"
  );
  assertEqual(
    JSON.stringify(b.view.items.map((i) => [i.isFavorite, i.isHidden, i.userTags])),
    JSON.stringify(JSON.parse(beforeItems).map((i) => [i.isFavorite, i.isHidden, i.userTags])),
    "…no projected flag changed at all"
  );

  // But the adopted state IS there, and appears the moment B switches to it.
  await on(b, () => b.store.switchProfile(other.id));
  await quiesce(b);
  assertEqual(viewItem(b, CLIP).isFavorite, true, "switching to that Profile shows its already-adopted remote state");

  await on(b, () => b.store.switchProfile(sharedId));
  await quiesce(b);
  assertEqual(viewItem(b, CLIP).isFavorite, false, "…and switching back is isolated again");
});

// =========================================================================
// 13. main.js refreshes the RENDERED surfaces, not just the data
// =========================================================================

await test("13. the main.js ProfileStore subscriber refreshes the rendered surfaces too", async () => {
  // [PHASE-6-SYNC-V2][STAGE-E-LIVE-REMOTE-PROJECTION]
  // [WHY: re-projecting allItems fixes the DATA; the rendered badges and
  //  controls are driven by runtime.subscribe(render), which a REMOTE change
  //  never moves. Asserted at the source because these are DOM renders this
  //  harness cannot invoke — but the call sites are exactly what was missing,
  //  so guarding them is what stops the regression coming back.]
  const source = await readFile(path.join(ROOT, "src", "main.js"), "utf8");
  const start = source.indexOf("profile.subscribe(() => {\n  allItems.forEach(");
  assert(start > 0, "found the loaded-media ProfileStore subscriber");
  const raw = source.slice(start, source.indexOf("\n});", start));
  // Comments explaining what must NOT be called would otherwise match the
  // forbidden-call check below.
  const body = raw.replace(/^\s*\/\/.*$/gm, "");

  for (const call of ["renderGallery(", "syncFavoriteButtons(", "syncHideButton(", "renderPresentationTagsPanel("]) {
    assert(body.includes(call), `the subscriber refreshes ${call.replace("(", "()")}`);
  }
  assert(
    !body.includes("buildViewer("),
    "…and does NOT rebuild the media element, which would interrupt playback on a background sync"
  );
  // The data projection itself must stay.
  for (const field of ["isFavorite", "isHidden", "favoritedAt", "userTags"]) {
    assert(body.includes(field), `…while still re-projecting ${field} onto every loaded item`);
  }
});

// =========================================================================
// 14. No physical media enumeration is involved
// =========================================================================

await test("14. adopting a remote change performs no media-folder access", async () => {
  const dir = createVirtualDirectory();
  const { a, b } = await makePair(dir);

  const opened = [];
  const realGetDir = dir.handle.getDirectoryHandle.bind(dir.handle);
  dir.handle.getDirectoryHandle = async (name, opts) => {
    opened.push(name);
    return realGetDir(name, opts);
  };

  await on(a, () => a.store.setFavorite(THIRD, true));
  await quiesce(a);
  await pass(a, dir.handle);
  await pass(b, dir.handle);
  await quiesce(b);

  assertEqual(viewItem(b, THIRD).isFavorite, true, "the change was adopted and projected");
  assert(opened.length > 0, "the sync folder was opened");
  assertEqual(
    opened.every((name) => name === "sync-v2"),
    true,
    "every directory opened was the sync folder — no media path was traversed",
    [...new Set(opened)].join(", ")
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
