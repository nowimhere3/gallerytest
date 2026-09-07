// [CURATION-IMPORT / STAGE-B / NAME-EQUIVALENCE]
//
// The one equivalence rule for "is this displayed name the same as that
// one", shared by every place this amendment decides two human-facing names
// collide: same-name Tag matching during import/repair, and the new
// Curation-name collision guard (create + rename).
//
// This mirrors, rather than reinvents, ProfileStore's own pre-existing Tag
// vocabulary guard (#tagNameExists, profile-store.js:2917-2919): trim, then
// case-insensitive compare — "Nature"/"nature" would be indistinguishable
// chips there, and "BEAST"/"beast" would be indistinguishable Curations or
// duplicate Tags here for the same reason. Two names are never considered
// equivalent if either is blank.
export function namesMatch(a, b) {
  const left = typeof a === "string" ? a.trim().toLowerCase() : "";
  const right = typeof b === "string" ? b.trim().toLowerCase() : "";
  return left !== "" && left === right;
}
