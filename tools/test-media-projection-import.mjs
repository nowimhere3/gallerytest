#!/usr/bin/env node
// [MEDIA-ID / STAGE-02 / LOCAL-PROJECTION]
// [WHY: Profile export/import is the one path that moves curated fact keys into
//  a Profile that never observed the folder they were written against. A Profile
//  exported while only the CHILD folder was ever loaded carries CHILD-RELATIVE
//  keys ("photo.jpg"); imported into a fresh Profile that is then active while
//  MASTER is loaded, those keys must still resolve — through exactly the same
//  T0/T1 admission rule, with no import-specific special case anywhere.
//
//  It works today only because three independent properties line up, and each
//  one is silently breakable by an unrelated change:
//
//    1. importJSON stamps a REAL fact per imported field (#stampImportDiff), so
//       the imported key appears in getFactPaths() — the projection's discovery
//       source. An import that only wrote #recordsByPath would still show up in
//       knownPaths() and would still half-work, which is why this asserts the FACT
//       path specifically.
//    2. The media scope is Profile-AGNOSTIC. Roots, prefixes and banked evidence
//       are keyed by scopeId, never by profileId, so a brand-new Profile inherits
//       the ancestry proof the old one paid for.
//    3. The projection reads factKeys and profileId through CALLBACKS, so an
//       index built after a Profile switch sees the incoming Profile's curation
//       rather than a frozen snapshot of the outgoing one.
//
//  Also pinned here: what export DELIBERATELY does not carry. toJSON() projects
//  #recordsByPath, and #setRecord deletes any record isEmptyRecord() considers
//  empty — so a path holding ONLY negative curation (an un-favourite) has no
//  record and is not exported. The imported Profile therefore has no opinion at
//  all there, rather than a wrong one. That is the safe direction, and it is
//  asserted rather than assumed so a future export change cannot quietly make
//  removals travel as absences.]
//
// Usage:  node tools/test-media-projection-import.mjs

import { pathToFileURL } from "node:url";
import path from "node:path";
import { installFakeIndexedDB, createVirtualDirectory, settle } from "./lib/browser-test-env.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const src = (rel) => pathToFileURL(path.join(ROOT, "src", rel)).href;

const fakeDb = installFakeIndexedDB();

const { ProfileStore } = await import(src("profile/profile-store.js"));
const { SyncIdentity } = await import(src("profile/sync-device.js"));
const Scope = await import(src("storage/media-scope.js"));
const AliasIndex = await import(src("storage/media-alias-index.js"));
const Registry = await import(src("storage/library-registry.js"));
const View = await import(src("profile/profile-projection-view.js"));

let failures = 0;
let passes = 0;

function assert(condition, label, detail) {
  if (condition) {
    passes++;
    return true;
  }
  failures++;
  console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ""}`);
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
  fakeDb.reset();
  try {
    await fn();
  } catch (error) {
    failures++;
    console.log(`  FAIL  threw: ${error && error.message}`);
    console.log(String(error && error.stack).split("\n").slice(1, 4).join("\n"));
  } finally {
    await settle(20);
  }
}

// ---- Fixtures --------------------------------------------------------------

function item(relativePath, size = 100) {
  const name = relativePath.slice(relativePath.lastIndexOf("/") + 1);
  return { relativePath, path: relativePath, name, size, lastModified: 1000, type: "image/jpeg" };
}

/** MASTER at "" plus a proven descendant root at `segments`. */
async function makeTwoRootScope(segments) {
  const dir = createVirtualDirectory("MASTER");
  let child = dir.handle;
  for (const segment of segments) child = await child.getDirectoryHandle(segment, { create: true });

  const master = await Registry.addOrUpdateLibrary(dir.handle);
  const kid = await Registry.addOrUpdateLibrary(child);

  await Scope.resolveScopeForRoot({
    rootId: master.id,
    handle: dir.handle,
    sourceKind: "fsa",
    knownRootHandles: [],
  });
  const childScope = await Scope.resolveScopeForRoot({
    rootId: kid.id,
    handle: child,
    sourceKind: "fsa",
    knownRootHandles: [{ rootId: master.id, handle: dir.handle }],
  });

  return { masterId: master.id, childId: kid.id, childScope };
}

async function makeStore() {
  const store = new ProfileStore({ identity: new SyncIdentity({ deviceId: "devIMPORT" }) });
  await settle();
  await store.whenFactsSettled();
  await settle();
  return store;
}

/** Drains everything a mutation sets in motion: facts, then the row write. */
async function quiesce(store) {
  await store.whenFactsSettled();
  await settle();
  await store.whenFactsSettled();
}

const CHILD_SEGMENTS = ["Staging area", "Mackenzie"];
const MASTER_PATH = "Staging area/Mackenzie/photo.jpg";
const CHILD_KEY = "photo.jpg";

// =============================================================================
// 1. What export carries, and what it deliberately does not
// =============================================================================

await test("export carries positive curation under the CHILD-relative key", async () => {
  const store = await makeStore();
  const profileA = await store.createProfile("A-child");
  await store.switchProfile(profileA.id);
  await quiesce(store);

  const tag = await store.createTag("keep");
  store.setFavorite(CHILD_KEY, true);
  store.setItemTag(CHILD_KEY, tag.id, true);
  store.setHidden("clip.mp4", true);
  await quiesce(store);

  const exported = JSON.parse(store.exportText());
  assert(CHILD_KEY in exported.items, "the favourited child-relative key is exported");
  assertEqual(exported.items[CHILD_KEY].favorite, true, "with its favourite value");
  assert(
    Array.isArray(exported.items[CHILD_KEY].tags) && exported.items[CHILD_KEY].tags.includes(tag.id),
    "and its tag assignment"
  );
  assert("clip.mp4" in exported.items, "a hidden-only path is exported too");
});

await test("export does NOT carry a negative-only path — it carries no opinion, not a wrong one", async () => {
  const store = await makeStore();
  const profileA = await store.createProfile("A-child");
  await store.switchProfile(profileA.id);
  await quiesce(store);

  store.setFavorite("neg.jpg", true);
  store.setFavorite("neg.jpg", false);
  await quiesce(store);

  const exported = JSON.parse(store.exportText());
  assert(!("neg.jpg" in exported.items), "the un-favourited path is absent from the export");
  assert(
    store.getFactPaths().includes("neg.jpg"),
    "…while its stamped fact still exists locally, so the removal is not lost in the SOURCE profile"
  );
});

// =============================================================================
// 2. The headline: imported child-relative curation projects onto MASTER
// =============================================================================

await test("imported child-relative curation projects onto the MASTER view", async () => {
  const tree = await makeTwoRootScope(CHILD_SEGMENTS);
  assertEqual(tree.childScope.prefixFromScopeRoot, "Staging area/Mackenzie/", "the child joined at the proven prefix");

  const store = await makeStore();

  // Profile A: curated while only the CHILD folder had ever been loaded.
  const profileA = await store.createProfile("A-child");
  await store.switchProfile(profileA.id);
  await quiesce(store);
  const tag = await store.createTag("keep");
  store.setFavorite(CHILD_KEY, true);
  store.setItemTag(CHILD_KEY, tag.id, true);
  await quiesce(store);
  const exportText = store.exportText();

  // Profile B: brand new, never saw the child folder at all.
  const profileB = await store.createProfile("B-imported");
  await store.switchProfile(profileB.id);
  await quiesce(store);
  const result = store.importJSON(exportText, { mode: "merge" });
  await quiesce(store);
  assertEqual(result.applied, 1, "one record was imported");

  assert(
    store.getFactPaths().includes(CHILD_KEY),
    "the import STAMPED a fact under the child-relative key, so alias discovery can see it"
  );

  // MASTER is now loaded while Profile B is active.
  const observed = [item(MASTER_PATH), item("Staging area/Mackenzie/other.jpg")];
  const index = await AliasIndex.buildAliasIndexForLoad({
    rootId: tree.masterId,
    profileId: () => store.getProfileId(),
    items: observed,
    factKeys: () => store.getFactPaths(),
    loadComplete: true,
  });

  assert(index !== null, "an index was built while the IMPORTED profile is active");
  assert(index.aliases.has(MASTER_PATH), "the imported key is admitted onto the MASTER path");
  assertEqual(index.diagnostics.admitted, 1, "exactly one candidate was admitted");
  assertEqual(index.diagnostics.refusedPresent, 0, "nothing was refused as a present competitor");
  assertEqual(index.diagnostics.refusedUnknown, 0, "nothing was refused as unknown");
  assertEqual(index.diagnostics.probes.fileProbes, 0, "the census answered — zero file probes");

  const view = View.createProfileProjectionView({ profile: store });
  view.setAliasIndex(index);
  assertEqual(view.isFavorite(MASTER_PATH), true, "the imported Favorite resolves on the MASTER path");
  assert(view.getItemTags(MASTER_PATH).includes(tag.id), "the imported Tag resolves on the MASTER path");
  assertEqual(view.isFavorite("Staging area/Mackenzie/other.jpg"), false, "an uncurated sibling is untouched");
  view.dispose();
});

// =============================================================================
// 3. Non-vacuity: the admission rule still applies to imported keys
// =============================================================================

await test("an imported key is refused when a competing destination is PRESENT", async () => {
  // MASTER + MASTER/Backup. The imported key "Cats/cat.jpg" was written against
  // MASTER, and the item under inspection is the BACKUP copy — whose reverse
  // mapping produces the same key. The sibling exists, so this must refuse.
  const dir = createVirtualDirectory("MASTER");
  const backup = await dir.handle.getDirectoryHandle("Backup", { create: true });
  const master = await Registry.addOrUpdateLibrary(dir.handle);
  const backupRow = await Registry.addOrUpdateLibrary(backup);
  await Scope.resolveScopeForRoot({ rootId: master.id, handle: dir.handle, sourceKind: "fsa", knownRootHandles: [] });
  await Scope.resolveScopeForRoot({
    rootId: backupRow.id,
    handle: backup,
    sourceKind: "fsa",
    knownRootHandles: [{ rootId: master.id, handle: dir.handle }],
  });

  const store = await makeStore();
  const profileA = await store.createProfile("A");
  await store.switchProfile(profileA.id);
  await quiesce(store);
  store.setFavorite("Cats/cat.jpg", true);
  await quiesce(store);
  const exportText = store.exportText();

  const profileB = await store.createProfile("B");
  await store.switchProfile(profileB.id);
  await quiesce(store);
  store.importJSON(exportText, { mode: "merge" });
  await quiesce(store);

  const index = await AliasIndex.buildAliasIndexForLoad({
    rootId: master.id,
    profileId: () => store.getProfileId(),
    items: [item("Cats/cat.jpg"), item("Backup/Cats/cat.jpg")],
    factKeys: () => store.getFactPaths(),
    loadComplete: true,
  });

  assert(
    index === null || !index.aliases.has("Backup/Cats/cat.jpg"),
    "the backup copy gets NO alias from the imported key — the original is a present competitor"
  );
  if (index) {
    assert(index.diagnostics.refusedPresent >= 1, "and the refusal reason is a PRESENT competitor");
  }
});

await test("a foreign Profile's index can never answer a read — the profileId guard holds", async () => {
  const tree = await makeTwoRootScope(CHILD_SEGMENTS);
  const store = await makeStore();

  const profileA = await store.createProfile("A-child");
  await store.switchProfile(profileA.id);
  await quiesce(store);
  store.setFavorite(CHILD_KEY, true);
  await quiesce(store);

  const index = await AliasIndex.buildAliasIndexForLoad({
    rootId: tree.masterId,
    profileId: () => store.getProfileId(),
    items: [item(MASTER_PATH)],
    factKeys: () => store.getFactPaths(),
    loadComplete: true,
  });
  assert(index.aliases.has(MASTER_PATH), "Profile A projects");

  const view = View.createProfileProjectionView({ profile: store });
  view.setAliasIndex(index);
  assertEqual(view.isFavorite(MASTER_PATH), true, "…and the value resolves while A is active");

  // Switch to a Profile the index was NOT built for. It must stop answering,
  // rather than leak A's curation into B.
  const profileB = await store.createProfile("B-empty");
  await store.switchProfile(profileB.id);
  await quiesce(store);
  view.setAliasIndex(index);
  assertEqual(view.isFavorite(MASTER_PATH), false, "a stale index answers nothing once another Profile is active");
  view.dispose();
});

console.log("\n" + "-".repeat(60));
if (failures) {
  console.log(`  ${failures} assertion(s) FAILED`);
  process.exit(1);
}
console.log(`  ok    ${passes} assertion(s) passed - export/import projection holds.`);
console.log("-".repeat(60));
// ProfileStore leaves debounced clock-floor writes pending; nothing further is
// asserted, so exit deterministically rather than waiting them out. Same reason
// tools/test-sync-v2-local.mjs ends this way.
process.exit(0);
