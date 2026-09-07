// [CURATION-IMPORT / STAGE-B / PARSE]
//
// The PARSE step of the Curate Import pipeline (parse -> validate ->
// identify -> compare -> build plan -> ... -> commit). Pure: no DOM, no
// storage, no ProfileStore. Mirrors the shape check ProfileStore.importJSON
// already uses (profile-store.js:3104-3106) so a file this module accepts
// is one importJSON would also have accepted, and vice versa.

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Parses and shape-validates a Curation export. Returns
 * `{ profileId, profileName, masterFolder, items, tags }` (identity fields
 * default to null/"" rather than throwing — see toJSON()'s comment that they
 * are informational metadata that may be absent from an older export) or
 * throws with a message meant to reach the customer if the file isn't a
 * recognizable Curation export at all.
 */
export function parseCurationExport(data) {
  let parsed;
  try {
    parsed = typeof data === "string" ? JSON.parse(data) : data;
  } catch {
    throw new Error("That file isn't valid JSON.");
  }

  if (!isPlainObject(parsed) || !isPlainObject(parsed.items)) {
    throw new Error("Not a recognized Curation file (missing an 'items' object).");
  }

  return {
    profileId: typeof parsed.profileId === "string" && parsed.profileId ? parsed.profileId : null,
    profileName: typeof parsed.profileName === "string" ? parsed.profileName : "",
    masterFolder: parsed.masterFolder || null,
    items: parsed.items,
    tags: Array.isArray(parsed.tags)
      ? parsed.tags.filter(
          (tag) => isPlainObject(tag) && typeof tag.id === "string" && tag.id && typeof tag.name === "string" && tag.name
        )
      : [],
  };
}
