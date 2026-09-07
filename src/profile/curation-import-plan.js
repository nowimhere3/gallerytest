// [CURATION-IMPORT / STAGE-B / COMPARE + BUILD-IMPORT-PLAN]
//
// The COMPARE and BUILD IMPORT PLAN steps of the Curate Import pipeline.
// Pure: takes an already-parsed import package (curation-import-parse.js)
// and a destination Curation snapshot (ProfileStore#getProfileSnapshot, or
// null for a brand-new destination Curation) and produces a plain,
// serializable Import Plan whose rows the UI toggles directly (`.selected`)
// as the customer checks/unchecks Curate Import rows. Building a plan reads
// nothing and writes nothing — no ProfileStore call happens until the
// customer presses IMPORT SELECTED and the plan is handed to
// curation-import-commit.js.
//
// THE SINGLE MOST IMPORTANT RULE THIS MODULE ENFORCES: an imported Tag whose
// displayed name matches an existing destination Tag is classified MATCH,
// never NEW — so merging never produces a second same-name Tag. Name
// equivalence is the same trim + case-insensitive rule ProfileStore's own
// Tag vocabulary guard already enforces (see name-equivalence.js).
//
// SNAPSHOT SAFETY: only POSITIVE, present state in the import is ever
// counted or later applied (a favorited/hidden/tagged item). Absence of a
// field in an imported record is never treated as a destination-changing
// signal — an old snapshot's silence about an item is not evidence that its
// state was ever explicitly changed. See curation-import-commit.js, which is
// the module that actually calls ProfileStore's mutators and where this rule
// is enforced at the point it matters.

import { namesMatch } from "./name-equivalence.js";

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {object} options
 * @param {{profileId: string|null, profileName: string, items: object, tags: Array}} options.imported
 *   an already-parsed package, see curation-import-parse.js
 * @param {{id: string, name: string, items: object, tags: Array}|null} options.destination
 *   a destination Curation snapshot (ProfileStore#getProfileSnapshot), or
 *   null when the destination is a brand-new Curation with no prior data
 */
export function buildImportPlan({ imported, destination = null }) {
  const importedItems = isPlainObject(imported?.items) ? imported.items : {};
  const importedTags = Array.isArray(imported?.tags) ? imported.tags : [];
  const destItems = isPlainObject(destination?.items) ? destination.items : {};
  const destTags = Array.isArray(destination?.tags) ? destination.tags : [];

  const tags = importedTags.map((tag) => {
    const match = destTags.find((candidate) => namesMatch(candidate.name, tag.name));
    return {
      importedTagId: tag.id,
      importedTagName: tag.name,
      matchType: match ? "MATCH" : "NEW",
      destinationTagId: match ? match.id : null,
      selected: true,
    };
  });

  let favoriteTotal = 0;
  let favoriteKnown = 0;
  let hiddenTotal = 0;
  let hiddenKnown = 0;

  for (const [path, record] of Object.entries(importedItems)) {
    if (!isPlainObject(record)) continue;

    if (record.favorite) {
      favoriteTotal += 1;
      if (isPlainObject(destItems[path]) && destItems[path].favorite) favoriteKnown += 1;
    }
    if (record.hidden) {
      hiddenTotal += 1;
      if (isPlainObject(destItems[path]) && destItems[path].hidden) hiddenKnown += 1;
    }
  }

  return {
    sourceProfileId: imported?.profileId || null,
    sourceProfileName: imported?.profileName || "",
    destinationProfileId: destination?.id || null,
    favorites: {
      total: favoriteTotal,
      known: favoriteKnown,
      new: favoriteTotal - favoriteKnown,
      selected: favoriteTotal > 0,
    },
    hidden: {
      total: hiddenTotal,
      known: hiddenKnown,
      new: hiddenTotal - hiddenKnown,
      selected: hiddenTotal > 0,
    },
    tags,
  };
}

/** True once at least one row in the plan is selected — gates IMPORT SELECTED. */
export function importPlanHasSelection(plan) {
  if (!plan) return false;
  if (plan.favorites?.selected && plan.favorites.total > 0) return true;
  if (plan.hidden?.selected && plan.hidden.total > 0) return true;
  return (plan.tags || []).some((tag) => tag.selected);
}
