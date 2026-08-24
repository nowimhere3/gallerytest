// [MEDIA-ID / STAGE-01 / CAPTURE-NOW-SEEDING]
//
// The write-only evidence-banking pass. Runs AFTER a load has already
// rendered, never as part of it.
//
// ---- What this is actually for -------------------------------------------
//
// [WHY: no Profile fact, local or synced, has ever stored a single byte of file
//  metadata — verified by enumerating every write site in profile-store.js and
//  by sync-facts.js's ALLOWED.item allow-list, which is exactly
//  {favorite, hidden, tags}. Size, lastModified and MIME live only on a
//  currently-observed MediaItem and have never been retained.
//
//  But for any path that exists in Profile facts AND is still reachable at that
//  same path today, the live MediaItem carries all of it right now. Recording
//  that retro-anchors the historical fact with real content evidence — no fact
//  is rewritten, nothing new is synced, nobody is asked anything. Every user who
//  has not yet reorganized gets full protection retroactively.
//
//  This is the one part of the track that is time-sensitive: the intersection
//  shrinks every time a folder is renamed before it has been banked.]
//
// ---- Three populations ---------------------------------------------------
//
//   observed ∩ facts   anchorState "anchored"    <- the retro-anchor
//   observed \ facts   origin "observed"         <- protection from here on
//   facts \ observed   anchorState "unanchored"  <- the genuinely lossy set,
//                                                   recorded so we KNOW what it is
//
// Nothing is matched, reconciled or merged here. Stage 01 seeds only, so
// ambiguity is structurally impossible during seeding — which is also why the
// seed-then-reconcile ORDER is load-bearing rather than incidental.

import { SEED_BATCH_SIZE, getSeedCursor, seedPathBatch, setSeedCursor } from "./media-identity.js";
import { toScopeRelativePath } from "./media-scope.js";

function nextFrame() {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });
}

function getExtension(name) {
  const index = String(name || "").lastIndexOf(".");
  return index > 0 ? name.slice(index + 1).toLowerCase() : "";
}

// [WHY: shaped so a future audited stage COULD publish it verbatim, which keeps
//  that a transport decision rather than a schema redesign. lastModified is
//  captured but is CORROBORATING ONLY — legacy-library-signature.js reached the
//  same conclusion independently ("changes on innocuous things… informational
//  only, never load-bearing"), and nothing here may promote it.]
function buildSignature(item) {
  if (!item) return null;
  const size = Number(item.size);
  if (!Number.isFinite(size)) return null;
  return {
    size,
    lastModified: Number.isFinite(Number(item.lastModified)) ? Number(item.lastModified) : null,
    name: item.name || "",
    ext: getExtension(item.name),
  };
}

/**
 * Builds the full seed entry list for one load.
 *
 * O(n): one Set of fact paths, one Map of observed items, and a single pass
 * over each. There is deliberately no nested scan anywhere in this function —
 * at 20k items an O(n²) pass would be minutes of blocked main thread.
 */
export function buildSeedEntries({ scopeId, prefixFromScopeRoot, items, factPaths, profileId }) {
  const observedByScopePath = new Map();
  for (const item of items) {
    const relativePath = item && typeof item.relativePath === "string" ? item.relativePath : null;
    if (!relativePath) continue;
    observedByScopePath.set(toScopeRelativePath(prefixFromScopeRoot, relativePath), item);
  }

  // Fact paths are stored by the ACTIVE profile relative to whatever root was
  // loaded when they were written. Seeding compares them in the same
  // scope-relative terms as everything else.
  const factScopePaths = new Set();
  for (const path of factPaths) {
    if (typeof path !== "string" || !path) continue;
    factScopePaths.add(toScopeRelativePath(prefixFromScopeRoot, path));
  }

  const entries = [];

  for (const [scopeRelativePath, item] of observedByScopePath) {
    const anchored = factScopePaths.has(scopeRelativePath);
    entries.push({
      scopeId,
      scopeRelativePath,
      origin: "observed",
      anchorState: anchored ? "anchored" : "unanchored",
      observedSignature: buildSignature(item),
      // Only fact-derived evidence carries the profile tag. An observed file's
      // size is a fact about the file, not about whose curation it is.
      profileId: anchored ? profileId || null : null,
    });
  }

  for (const scopeRelativePath of factScopePaths) {
    if (observedByScopePath.has(scopeRelativePath)) continue;
    entries.push({
      scopeId,
      scopeRelativePath,
      origin: "fact-only",
      // In facts, not observed here. It may be reachable from a different root,
      // or it may be genuinely gone. Recorded either way so the lossy set is
      // known rather than invisible.
      anchorState: "unanchored",
      observedSignature: null,
      profileId: profileId || null,
    });
  }

  return entries;
}

/**
 * Runs the seeding pass in the background.
 *
 * [WHY: deliberately NOT awaited by the load flow. The gallery renders normally
 *  while evidence banks behind it, yielding between batches with the same
 *  nextFrame() idiom both providers already use to stay off the critical path.
 *  A user must never wait on bookkeeping that has no visible effect until a
 *  later stage.]
 *
 * `shouldContinue()` is the supersede hook — the same loadToken discipline
 * FsaFileProvider already uses, so a new load abandons an in-flight pass
 * instead of racing it.
 *
 * Resumability is a property of the WRITES, not of the cursor: every write is
 * an idempotent get-or-create, so re-running an interrupted pass is a no-op for
 * everything already banked. The cursor only saves time.
 */
export async function runSeedingPass({
  scopeId,
  rootId,
  prefixFromScopeRoot,
  items,
  factPaths,
  profileId,
  batchSize = SEED_BATCH_SIZE,
  shouldContinue = () => true,
  onProgress = null,
  now = Date.now(),
} = {}) {
  const stats = { total: 0, created: 0, adopted: 0, updated: 0, batches: 0, superseded: false, resumedFrom: 0 };
  if (!scopeId || !rootId) return stats;

  const entries = buildSeedEntries({ scopeId, prefixFromScopeRoot, items, factPaths, profileId });
  stats.total = entries.length;
  if (!entries.length) return stats;

  let start = 0;
  try {
    const cursor = await getSeedCursor(scopeId, rootId);
    // Only trusted when it describes the SAME workload. A different total means
    // the folder changed, and the cursor no longer refers to anything real.
    if (cursor && !cursor.done && cursor.total === entries.length && Number.isFinite(cursor.index)) {
      start = Math.max(0, Math.min(cursor.index, entries.length));
      stats.resumedFrom = start;
    }
  } catch {
    // Cursor is an optimization only — a failure to read it costs a re-walk of
    // idempotent writes, never correctness.
    start = 0;
  }

  for (let index = start; index < entries.length; index += batchSize) {
    if (!shouldContinue()) {
      stats.superseded = true;
      return stats;
    }

    const batch = entries.slice(index, index + batchSize);
    const result = await seedPathBatch(batch, { now });

    stats.created += result.created;
    stats.adopted += result.adopted;
    stats.updated += result.updated;
    stats.batches += 1;

    const done = index + batchSize >= entries.length;
    try {
      await setSeedCursor(scopeId, rootId, { index: index + batch.length, total: entries.length, at: now, done });
    } catch {
      // See above: efficiency only.
    }

    if (onProgress) onProgress(Math.min(index + batch.length, entries.length), entries.length);
    if (!done) await nextFrame();
  }

  return stats;
}
