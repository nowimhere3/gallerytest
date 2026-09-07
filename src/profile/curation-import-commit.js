// [CURATION-IMPORT / STAGE-B / COMMIT]
//
// The COMMIT step of the Curate Import pipeline. Applies a FINISHED,
// customer-approved Import Plan (curation-import-plan.js) to `store`, which
// must already be the destination Curation's active ProfileStore — see
// curation-import-identity.js's header for why switching the active
// Curation, rather than a second cross-profile write path, is how a
// destination that was not already active gets targeted.
//
// Every mutation goes through ProfileStore's ordinary, fact-emitting public
// API (setFavorite / setHidden / createTag / setItemTag) — nothing here
// touches IndexedDB or the fact layer directly, and nothing here is
// destructive: only present, positive state in the import is ever applied.
// An item's absence, or an explicit `false`, from the imported package never
// turns into a call that would remove or unset anything at the destination.
//
// THE SINGLE MOST IMPORTANT RULE THIS MODULE ENFORCES: a MATCH tag's
// assignments are translated onto the existing destination tag id — the
// imported tag id is never created locally, never becomes a second visible
// same-name Tag, and the customer never sees the remap, only "Merge".

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {object} store a ProfileStore already active on the destination Curation
 * @param {object} plan a finished plan from buildImportPlan(), after customer edits
 * @param {object} importedItems the imported package's `items` (curation-import-parse.js)
 * @returns {{ tagsCreated: number, tagsMerged: number }}
 */
export function applyImportPlan(store, plan, importedItems) {
  const items = isPlainObject(importedItems) ? importedItems : {};

  // Tags first, so the per-item loop below always has somewhere to land a
  // selected tag's assignments.
  const destinationTagIdFor = new Map(); // importedTagId -> destination tagId
  let tagsCreated = 0;
  let tagsMerged = 0;

  for (const tagPlan of plan.tags || []) {
    if (!tagPlan.selected) continue;

    if (tagPlan.matchType === "MATCH") {
      // The destination's existing Tag stays canonical — nothing is created,
      // nothing is renamed. Only its id is recorded so assignments below
      // translate onto it.
      destinationTagIdFor.set(tagPlan.importedTagId, tagPlan.destinationTagId);
      tagsMerged += 1;
      continue;
    }

    // NEW: mint a real destination Tag for it. createTag() can return null if
    // another selected row already created (or the destination already had,
    // undetected at plan-build time) the same name — fall back to finding it
    // rather than silently dropping this tag's assignments.
    const created = store.createTag(tagPlan.importedTagName);
    const destinationTagId =
      created?.id ||
      store.getTags().find((tag) => tag.name.trim().toLowerCase() === tagPlan.importedTagName.trim().toLowerCase())?.id ||
      null;
    if (destinationTagId) {
      destinationTagIdFor.set(tagPlan.importedTagId, destinationTagId);
      tagsCreated += 1;
    }
  }

  for (const [path, record] of Object.entries(items)) {
    if (!isPlainObject(record)) continue;

    if (plan.favorites?.selected && record.favorite) {
      store.setFavorite(path, true);
    }
    if (plan.hidden?.selected && record.hidden) {
      store.setHidden(path, true);
    }
    if (Array.isArray(record.tags)) {
      for (const importedTagId of record.tags) {
        const destinationTagId = destinationTagIdFor.get(importedTagId);
        if (destinationTagId) store.setItemTag(path, destinationTagId, true);
      }
    }
  }

  return { tagsCreated, tagsMerged };
}
