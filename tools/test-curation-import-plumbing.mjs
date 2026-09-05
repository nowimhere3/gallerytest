// [CURATION-IMPORT / STAGE-B] Pure plan/plumbing regression suite: identity
// classification, same-name Tag matching, snapshot safety, and duplicate-tag
// repair — all against a real ProfileStore, no UI. Corresponds to the
// amendment's TESTING REQUIREMENTS groups "Identity", "Tag prevention",
// "Snapshot safety" and "Repair".
import { installFakeIndexedDB, createVirtualDirectory } from "./lib/browser-test-env.mjs";
import { classifyCurationImport } from "../src/profile/curation-import-identity.js";
import { buildImportPlan, importPlanHasSelection } from "../src/profile/curation-import-plan.js";
import { applyImportPlan } from "../src/profile/curation-import-commit.js";
import { buildDuplicateTagRepairPlan, applyDuplicateTagRepairPlan } from "../src/profile/duplicate-tag-repair.js";
import { findCurationNameCollisions, suggestNextCurationName } from "../src/profile/curation-name-guard.js";
import { parseCurationExport } from "../src/profile/curation-import-parse.js";

let assertions = 0;
function assert(condition, label) {
  if (!condition) throw new Error(label);
  assertions += 1;
}

// =========================================================================
// IDENTITY — classifyCurationImport
// =========================================================================

{
  const curations = [{ id: "AAAA", name: "BEAST" }, { id: "CCCC", name: "FAMILY" }];

  assert(
    classifyCurationImport({ importedProfileId: "AAAA", importedProfileName: "BEAST", curations }).kind === "SAME_ID",
    "1. same durable Curation id does not create another Curation — classified SAME_ID"
  );

  const sameName = classifyCurationImport({ importedProfileId: "BBBB", importedProfileName: "BEAST", curations });
  assert(sameName.kind === "SAME_NAME_DIFFERENT_ID",
    "2. same name + different id is ambiguous, not automatically equivalent");
  assert(sameName.destinations.length === 1 && sameName.destinations[0].id === "AAAA",
    "2. the ambiguous destination candidate is the existing same-name Curation, not auto-merged");

  const different = classifyCurationImport({ importedProfileId: "DDDD", importedProfileName: "WORK", curations });
  assert(different.kind === "DIFFERENT" && different.destinations.length === 0,
    "3. different name + different id imports as an ordinary new Curation");

  // Case-insensitive name equivalence, matching the Tag vocabulary rule.
  const caseInsensitive = classifyCurationImport({ importedProfileId: "EEEE", importedProfileName: "beast", curations });
  assert(caseInsensitive.kind === "SAME_NAME_DIFFERENT_ID", "name collision detection is case-insensitive, like Tags");
}

// =========================================================================
// TAG PREVENTION — buildImportPlan / applyImportPlan against a real store
// =========================================================================

installFakeIndexedDB();
const { ProfileStore } = await import("../src/profile/profile-store.js");
createVirtualDirectory("Media Folder");

const store = new ProfileStore();
await store.whenFactsSettled();

// Destination already has "redheads" (tag X) assigned to A, B, C.
const redheadsX = store.createTag("redheads");
const uniqueDestTag = store.createTag("gym");
store.setItemTag("A.jpg", redheadsX.id, true);
store.setItemTag("B.jpg", redheadsX.id, true);
store.setItemTag("C.jpg", redheadsX.id, true);
store.setFavorite("A.jpg", true);
store.setHidden("Z.jpg", true); // unrelated existing hidden item, must survive untouched

// Imported package: "redheads" (tag Y, a different id) assigned to B, C, D, E;
// plus a genuinely new tag "tattoos" assigned to D.
const imported = parseCurationExport({
  schemaVersion: 1,
  kind: "browser-gallery-profile",
  profileId: "BBBB",
  profileName: "BEAST",
  items: {
    "B.jpg": { tags: ["tag-Y-redheads"] },
    "C.jpg": { tags: ["tag-Y-redheads"] },
    "D.jpg": { tags: ["tag-Y-redheads", "tag-Y-tattoos"], favorite: true },
    "E.jpg": { tags: ["tag-Y-redheads"] },
  },
  tags: [
    { id: "tag-Y-redheads", name: "redheads" },
    { id: "tag-Y-tattoos", name: "tattoos" },
  ],
});

const destinationSnapshot = await store.getProfileSnapshot(store.getProfileId());
const plan = buildImportPlan({ imported, destination: destinationSnapshot });

const redheadsPlan = plan.tags.find((tag) => tag.importedTagName === "redheads");
const tattoosPlan = plan.tags.find((tag) => tag.importedTagName === "tattoos");
assert(redheadsPlan.matchType === "MATCH" && redheadsPlan.destinationTagId === redheadsX.id,
  "5. existing 'redheads X' + imported 'redheads Y' classifies as MATCH onto the existing destination tag");
assert(tattoosPlan.matchType === "NEW", "7. a uniquely imported Tag classifies as NEW");
assert(importPlanHasSelection(plan), "17. building a plan defaults every row selected (Select All posture)");

applyImportPlan(store, plan, imported.items);

assert(store.getTags().filter((tag) => tag.name === "redheads").length === 1,
  "5. applying the plan produces exactly ONE visible 'redheads' Tag, never a second same-name Tag");
assert(store.getTags().some((tag) => tag.name === "tattoos"), "7. the new Tag was actually created");
assert(
  ["A.jpg", "B.jpg", "C.jpg", "D.jpg", "E.jpg"].every((path) => store.hasItemTag(path, redheadsX.id)),
  "6. assignments from both the destination tag (A,B,C) and the imported tag (B,C,D,E) are preserved on the ONE resulting tag"
);
assert(store.hasItemTag("D.jpg", store.getTags().find((tag) => tag.name === "tattoos").id),
  "7. the new Tag's own assignment came through");
assert(store.isHidden("Z.jpg"), "unrelated existing Hidden state survives an unrelated import untouched");

// 9. Re-importing the same package is idempotent — no second redheads tag,
// no duplicate assignments, no crash on re-selecting an already-merged Tag.
const secondPlan = buildImportPlan({ imported, destination: await store.getProfileSnapshot(store.getProfileId()) });
assert(secondPlan.tags.every((tag) => tag.matchType === "MATCH"),
  "9. re-importing the same package now finds every one of its Tags already MATCHed");
applyImportPlan(store, secondPlan, imported.items);
assert(store.getTags().filter((tag) => tag.name === "redheads").length === 1
  && store.getTags().filter((tag) => tag.name === "tattoos").length === 1,
  "9. re-importing the same package does not create another duplicate Tag");

// 8. A skipped (unchecked) MATCH tag makes no change to the destination.
const skipStore = new ProfileStore();
await skipStore.whenFactsSettled();
const gymDest = skipStore.createTag("gym");
skipStore.setItemTag("only.jpg", gymDest.id, true);
const skipImported = parseCurationExport({
  profileId: "ZZZZ", profileName: "OTHER",
  items: { "only.jpg": { tags: ["tag-foreign-gym"] } },
  tags: [{ id: "tag-foreign-gym", name: "gym" }],
});
const skipDestSnapshot = await skipStore.getProfileSnapshot(skipStore.getProfileId());
const skipPlan = buildImportPlan({ imported: skipImported, destination: skipDestSnapshot });
skipPlan.tags[0].selected = false; // customer unchecks the MATCH row
const beforeIds = skipStore.getTags().map((t) => t.id).join(",");
applyImportPlan(skipStore, skipPlan, skipImported.items);
assert(skipStore.getTags().map((t) => t.id).join(",") === beforeIds,
  "8. an unselected MATCH Tag row leaves the destination Tag vocabulary completely untouched");
skipStore.closeLocalStateChannel();

store.closeLocalStateChannel();

// =========================================================================
// SNAPSHOT SAFETY
// =========================================================================

{
  const safeStore = new ProfileStore();
  await safeStore.whenFactsSettled();
  safeStore.setFavorite("kept.jpg", true);
  safeStore.setHidden("keptHidden.jpg", true);

  // An import that never mentions favorite/hidden at all for these paths —
  // simulating an older/partial export that simply never knew about them.
  const silentImport = parseCurationExport({
    profileId: null, profileName: "",
    items: { "kept.jpg": {}, "keptHidden.jpg": {} },
    tags: [],
  });
  const safeDest = await safeStore.getProfileSnapshot(safeStore.getProfileId());
  const safePlan = buildImportPlan({ imported: silentImport, destination: safeDest });
  assert(safePlan.favorites.total === 0 && safePlan.hidden.total === 0,
    "10. absence of favorite/hidden in an imported record is never counted as a signal");
  applyImportPlan(safeStore, safePlan, silentImport.items);
  assert(safeStore.isFavorite("kept.jpg") && safeStore.isHidden("keptHidden.jpg"),
    "10. absence in a snapshot never manufactures a destructive OFF fact for existing state");

  // An import that explicitly carries `hidden: false` alongside an unrelated
  // true field on the SAME record (the open-shape co-occurrence the
  // amendment brief warns about) must not be read as "explicitly un-hide".
  const explicitFalseImport = parseCurationExport({
    items: { "keptHidden.jpg": { favorite: true, hidden: false } },
    tags: [],
  });
  const explicitFalsePlan = buildImportPlan({
    imported: explicitFalseImport,
    destination: await safeStore.getProfileSnapshot(safeStore.getProfileId()),
  });
  applyImportPlan(safeStore, explicitFalsePlan, explicitFalseImport.items);
  assert(safeStore.isHidden("keptHidden.jpg"),
    "11. an explicit `false` field in an imported record never becomes a tag-removal-style destructive fact");

  safeStore.closeLocalStateChannel();
}

// =========================================================================
// REPAIR
// =========================================================================

{
  const repairStore = new ProfileStore();
  await repairStore.whenFactsSettled();

  const top1 = repairStore.createTag("TOP-temp-1");
  const top2 = repairStore.createTag("TOP-temp-2");
  const top3 = repairStore.createTag("TOP-temp-3");
  // Rename after creation so all three land on the exact same displayed name
  // without renameTag's own collision guard refusing the second/third rename.
  const rawTags = repairStore.getTags();
  for (const tag of rawTags) {
    if (tag.name.startsWith("TOP-temp")) {
      // Directly exercise the duplicate condition the repair targets: three
      // distinct tag ids that already display the identical name "TOP".
    }
  }
  // Simplest reliable way to reach the "three TOP tags" state under test
  // without fighting createTag's own collision guard: import a package that
  // (pre-amendment-importer-style) pushes same-name/different-id tags.
  repairStore.importJSON(JSON.stringify({ items: {}, tags: [{ id: "tag-1000-a", name: "TOP" }] }));
  repairStore.importJSON(JSON.stringify({ items: {}, tags: [{ id: "tag-2000-b", name: "TOP" }] }));
  repairStore.importJSON(JSON.stringify({ items: {}, tags: [{ id: "tag-3000-c", name: "top" }] })); // case-insensitive dup
  repairStore.setItemTag("p1.jpg", "tag-1000-a", true);
  repairStore.setItemTag("p2.jpg", "tag-2000-b", true);
  repairStore.setItemTag("p3.jpg", "tag-3000-c", true);
  repairStore.setFavorite("p1.jpg", true); // unrelated state that must survive
  const untouchedTag = repairStore.createTag("untouched");

  const repairPlan = buildDuplicateTagRepairPlan(repairStore.getTags());
  const topGroup = repairPlan.find((group) => group.name === "TOP");
  assert(topGroup.tagIds.length === 3, "13. all three TOP-named tag records are grouped");
  assert(topGroup.canonicalTagId === "tag-1000-a", "13. the earliest-created tag id is chosen canonical");
  assert(!repairPlan.some((group) => group.name === "untouched"),
    "14. a Tag with no duplicates is not proposed for repair at all");

  applyDuplicateTagRepairPlan(repairStore, repairPlan);

  assert(repairStore.getTags().filter((tag) => tag.name.toLowerCase() === "top").length === 1,
    "13. TOP x3 becomes exactly one visible TOP");
  assert(
    ["p1.jpg", "p2.jpg", "p3.jpg"].every((path) => repairStore.hasItemTag(path, "tag-1000-a")),
    "13. the union of assignments from all three duplicates lands on the single surviving TOP"
  );
  assert(repairStore.isFavorite("p1.jpg"), "15. repair does not disturb unrelated Favorites");
  assert(repairStore.getTags().some((tag) => tag.id === untouchedTag.id),
    "15. repair does not disturb unrelated Tags");

  // 16. Repeat repair is a no-op: nothing left to group, nothing left to reassign.
  const secondRepairPlan = buildDuplicateTagRepairPlan(repairStore.getTags());
  assert(!secondRepairPlan.some((group) => group.name.toLowerCase() === "top"),
    "16. repeat Repair finds no remaining TOP duplicates");
  const beforeSecondApply = repairStore.getTags().map((t) => t.id).sort().join(",");
  applyDuplicateTagRepairPlan(repairStore, secondRepairPlan);
  assert(repairStore.getTags().map((t) => t.id).sort().join(",") === beforeSecondApply,
    "16. repeat Repair changes nothing");

  // An unselected group is left completely untouched.
  const thirdRepairStore = repairStore; // reuse: create a fresh second duplicate pair
  repairStore.importJSON(JSON.stringify({ items: {}, tags: [{ id: "tag-4000-d", name: "ASS" }] }));
  repairStore.importJSON(JSON.stringify({ items: {}, tags: [{ id: "tag-5000-e", name: "ASS" }] }));
  const assPlan = buildDuplicateTagRepairPlan(repairStore.getTags());
  const assGroup = assPlan.find((group) => group.name === "ASS");
  assGroup.selected = false;
  const beforeUnselectedApply = repairStore.getTags().map((t) => t.id).sort().join(",");
  applyDuplicateTagRepairPlan(repairStore, assPlan);
  assert(repairStore.getTags().map((t) => t.id).sort().join(",") === beforeUnselectedApply,
    "14. an unselected duplicate group remains completely untouched");
  void thirdRepairStore;

  repairStore.closeLocalStateChannel();
}

// =========================================================================
// getProfileSnapshot — read-only inspection seam
// =========================================================================

{
  const inspectStore = new ProfileStore();
  await inspectStore.whenFactsSettled();
  const activeIdBefore = inspectStore.getProfileId();

  const other = await inspectStore.createProfile("OTHER CURATION");
  // Still active on the original profile — creating another does not switch.
  assert(inspectStore.getProfileId() === activeIdBefore, "creating a Curation does not switch the active one");

  const snapshot = await inspectStore.getProfileSnapshot(other.id);
  assert(snapshot.id === other.id && snapshot.name === "OTHER CURATION",
    "getProfileSnapshot reads a non-active Curation's identity");
  assert(inspectStore.getProfileId() === activeIdBefore,
    "getProfileSnapshot never switches the active Curation");
  assert(await inspectStore.getProfileSnapshot("does-not-exist") === null,
    "getProfileSnapshot returns null for an unknown id rather than throwing");

  const activeSnapshot = await inspectStore.getProfileSnapshot(inspectStore.getProfileId());
  assert(activeSnapshot.id === activeIdBefore, "getProfileSnapshot also serves the currently active Curation");

  inspectStore.closeLocalStateChannel();
}

// =========================================================================
// FEATURE 5/6 — Curation name-collision guard
// =========================================================================

{
  const curations = [{ id: "AAAA", name: "BEAST" }, { id: "CCCC", name: "FAMILY" }];
  assert(findCurationNameCollisions("BEAST", curations).length === 1, "an exact-name collision is found");
  assert(findCurationNameCollisions("beast", curations).length === 1, "collision detection is case-insensitive");
  assert(findCurationNameCollisions("WORK", curations).length === 0, "a unique name has no collision");
  assert(findCurationNameCollisions("BEAST", curations, "AAAA").length === 0,
    "renaming a Curation to its own current name is not a collision with itself");

  assert(suggestNextCurationName("BEAST", ["BEAST", "FAMILY"]) === "BEAST (2)",
    "the first duplicate suggests the familiar (2) convention");
  assert(suggestNextCurationName("BEAST", ["BEAST", "BEAST (2)"]) === "BEAST (3)",
    "suggestion skips numbers already taken");
}

console.log(`Curation import plumbing (Phase B): ${assertions} assertions passed`);
