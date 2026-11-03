// [HEART-REACH / REMEMBERED-FOLDER-LIBRARY-IDENTITY]
// WHAT: Decides whether a Heart just made in a remembered local folder should
// publish that folder's shared LIBRARY identity, and does so through a supplied
// `promote` function (ProfileStore.promoteLibraryToShared + structure evidence).
//
// WHY: a remembered folder that follows the Primary Curation has no explicit
// binding, so it never received a shared libraryId. Its Hearts sync everywhere,
// yet the Curation Suite Heart Watcher cannot tell which folder holds the media.
// "This is Library X" is separate from "Library X uses Curation Y": this module
// publishes only the first. Primary stays a default, never a per-folder binding.
//
// WHAT THIS NEVER DOES:
//  - write an association (that is an explicit, outranking Curation choice);
//  - touch a folder that already has a shared libraryId;
//  - touch a folder with a local explicit binding (the load-time publication in
//    explicit-binding-publication.js owns that case and mints the association);
//  - mint for anything but a durable local folder (not files, not Floppy Disks).
// Timing: at the first Heart, not on open, so merely browsing a folder never
// gives it a synchronized identity, and the Human has already had the chance to
// link it to an existing Library before one is minted.

/**
 * @param {object} args
 * @param {{id?: string, libraryId?: string|null, profileId?: string|null, name?: string}|null} args.record
 * @param {string} args.sourceKind  "fsa" is the only durable local-folder kind.
 * @param {(record: object) => Promise<object|null>} args.promote
 * @returns {Promise<object|null>} the updated registry row, or null when nothing was published.
 */
export async function publishLibraryIdentityForHeart({ record, sourceKind, promote }) {
  if (sourceKind !== "fsa") return null;
  if (!record || !record.id) return null;
  if (record.libraryId) return null;
  if (record.profileId) return null;
  return (await promote(record)) || null;
}
