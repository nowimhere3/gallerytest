// [HEART-REACH / EXPLICIT-LOCAL-BINDING-PUBLICATION]
// WHAT: Decides whether a just-loaded local folder carries an EXPLICIT Curation
// binding that was only ever saved on this device, and if so publishes it through
// the one sanctioned association seam.
//
// WHY: a registry row can hold `profileId` (an explicit Human choice or an older
// version's save) without ever having received a shared `libraryId`. Such a
// folder is invisible to every other device and to the Curation Suite Heart
// Watcher: V3 has no library identity and no libraryId -> Curation association
// for it, so a Heart made in that folder can reach Drive and still be impossible
// to locate for preservation. Publishing the existing explicit binding makes the
// folder addressable without inventing anything the Human did not already choose.
//
// WHAT THIS NEVER DOES (Primary Curation and Stage D3 stay intact):
//  - no binding on the row (a plain open, or a Primary-Curation fallback) -> null.
//    Opening a folder, or being routed to the Primary, never mints identity.
//  - a row that already has a shared libraryId -> null (nothing to migrate).
//  - a binding naming a Profile that no longer exists locally -> null (a stale
//    pointer is never published as a fact).
// The write itself is delegated; this module owns the policy only, so it can be
// tested without a browser.

/**
 * @param {object} args
 * @param {{id?: string, libraryId?: string|null, profileId?: string|null}|null} args.record
 * @param {(profileId: string) => boolean} args.profileExists
 * @param {(localLibraryId: string, profileId: string) => Promise<object|null>} args.associate
 * @returns {Promise<object|null>} the updated registry row when a binding was
 *   published, otherwise null.
 */
export async function publishExplicitLocalBinding({ record, profileExists, associate }) {
  if (!record || !record.id) return null;
  if (record.libraryId) return null;
  if (!record.profileId) return null;
  if (!profileExists(record.profileId)) return null;
  return (await associate(record.id, record.profileId)) || null;
}
