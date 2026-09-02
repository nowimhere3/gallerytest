// [PRESENTATION-PERF / PHASE 3A]
//
// The single pure decision behind the held-frame path: "this image finished
// preparing — is it still the image the viewer is waiting for?"
//
// WHY THIS IS ITS OWN MODULE: preparing an image is asynchronous, and the
// world can change while it is in flight. The customer can advance again, load
// a different cassette or folder, change a filter, or clear media entirely.
// Only one thing may commit a prepared node to the stage, and the rule for
// that has to be provable without a DOM — so the rule lives here and the I/O
// stays in main.js, exactly as boot-restore.js and shuffle-selector.js already
// split their own decisions from their callers.
//
// Pure: no DOM, no storage, no timers, no Math.random(). Exhaustively testable
// in Node — see tools/test-viewer-commit.mjs.
//
// The four facts are independent on purpose. Each one alone is enough to make
// a prepared node stale, and each guards a different way the world moves:
//
//   token             a NEWER preparation superseded this one. This is the
//                     case the async ownership contract is named for: A is
//                     visible, B starts preparing, the customer advances to C,
//                     and B finishes last. B must never appear.
//   loadGeneration    a different media source was loaded — another cassette,
//                     another folder, a remote session, or Clear Media. Phase 1
//                     proved local <-> remote switching leaves no residue; a
//                     prepared image from a retired source would break that.
//   galleryGeneration the visible item list itself changed — a filter, View,
//                     Type, Tag or Skip Duplicates change. Every reloadRuntime()
//                     bumps this.
//   item identity     anything else moved the viewer on. Compared by identity,
//                     never by value: two different loads can produce records
//                     that look alike and are not the same item.
//
// Returning false is not an error and is not a failure — it means "the answer
// arrived too late to matter". The caller discards the node and does nothing
// else. Nothing here retries, reorders, removes, or classifies.

/**
 * True only when a prepared viewer node still belongs to the current viewer,
 * source and generation, and may therefore be committed to the stage.
 *
 * All four pairs must match. `preparedItem` must also be a real item — a
 * preparation for nothing can never be current, even when `currentViewerItem`
 * is also null.
 */
export function shouldCommitPreparedViewer({
  preparedToken,
  currentToken,
  preparedLoadGeneration,
  currentLoadGeneration,
  preparedGalleryGeneration,
  currentGalleryGeneration,
  preparedItem,
  currentViewerItem,
} = {}) {
  if (preparedToken !== currentToken) return false;
  if (preparedLoadGeneration !== currentLoadGeneration) return false;
  if (preparedGalleryGeneration !== currentGalleryGeneration) return false;
  if (!preparedItem) return false;
  return preparedItem === currentViewerItem;
}
