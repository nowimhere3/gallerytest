// [CURATION-IMPORT / STAGE-E / DUPLICATE-TAG-REPAIR]
//
// Repairs Tags that already exist as multiple same-name records (e.g. three
// separate "TOP" tags) — damage the old ID-based importer allowed before
// this amendment's same-name Tag matching (curation-import-plan.js)
// prevented it going forward. See the amendment's "REPAIR SAFETY GATE":
// this is safe to implement WITHOUT any new distributed alias/lineage
// infrastructure, because ProfileStore.deleteTag() already tombstones a Tag
// via an ordinary fact (Facts.deleteTag) and deliberately leaves every
// item's assignment to it in place underneath, invisible rather than
// deleted (profile-store.js:2956-2978). Repair therefore only needs two
// already-existing, already-Sync-safe primitives: setItemTag() to reassign
// a losing tag's visible assignments onto the canonical survivor, then
// deleteTag() to tombstone the loser — the same two calls any ordinary
// re-tagging action in the UI already performs.
//
// Name equivalence is the same trim + case-insensitive rule used everywhere
// else in this amendment (see name-equivalence.js) — a "TOP"/"top" pair is a
// duplicate group exactly as "TOP"/"TOP" is.

import { namesMatch } from "./name-equivalence.js";

function parseTagCreatedAt(id) {
  // Tag ids are minted as `tag-<Date.now()>-<random>` (profile-store.js
  // createTag). An id that doesn't match this shape (e.g. one carried over
  // from an older export format) sorts last rather than throwing, so it
  // never wins canonical-survivor selection over an id we can actually date.
  const match = /^tag-(\d+)-/.exec(String(id ?? ""));
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
}

/**
 * Groups the customer's current Tag vocabulary by displayed name and
 * proposes, for every name with more than one Tag record, which one survives
 * as canonical — the earliest-created, so the Tag the customer has had
 * longest keeps its identity and any newer duplicates are the ones absorbed.
 *
 * @param {Array<{id: string, name: string}>} tags ProfileStore#getTags()
 * @returns {Array<{name: string, tagIds: string[], canonicalTagId: string, losingTagIds: string[], selected: boolean}>}
 */
export function buildDuplicateTagRepairPlan(tags = []) {
  const groups = [];

  for (const tag of tags) {
    if (typeof tag?.name !== "string" || !tag.name.trim()) continue;
    const existingGroup = groups.find((group) => namesMatch(group[0].name, tag.name));
    if (existingGroup) existingGroup.push(tag);
    else groups.push([tag]);
  }

  return groups
    .filter((group) => group.length > 1)
    .map((group) => {
      const sorted = [...group].sort((a, b) => parseTagCreatedAt(a.id) - parseTagCreatedAt(b.id));
      const [canonical, ...losing] = sorted;
      return {
        name: canonical.name,
        tagIds: sorted.map((tag) => tag.id),
        canonicalTagId: canonical.id,
        losingTagIds: losing.map((tag) => tag.id),
        selected: true,
      };
    });
}

/**
 * Applies a finished, customer-approved repair plan to `store`. Only
 * selected groups are touched; everything else (Favorites, Hidden, unrelated
 * Tags, unrelated assignments) is left exactly as it was. Idempotent: a
 * losing tag id that no longer exists (e.g. a repeat run) is simply skipped
 * by deleteTag() returning false, and hasItemTag() is false for every path
 * once that id's assignments are no longer visible.
 *
 * @param {object} store a ProfileStore already active on the Curation being repaired
 * @param {Array} plan from buildDuplicateTagRepairPlan(), after customer edits
 * @returns {{ reassigned: number, tombstoned: number }}
 */
export function applyDuplicateTagRepairPlan(store, plan = []) {
  let reassigned = 0;
  let tombstoned = 0;
  const paths = store.knownPaths();

  for (const group of plan) {
    if (!group.selected) continue;

    for (const losingTagId of group.losingTagIds) {
      for (const path of paths) {
        if (store.hasItemTag(path, losingTagId)) {
          store.setItemTag(path, group.canonicalTagId, true);
          reassigned += 1;
        }
      }
      if (store.deleteTag(losingTagId)) tombstoned += 1;
    }
  }

  return { reassigned, tombstoned };
}
