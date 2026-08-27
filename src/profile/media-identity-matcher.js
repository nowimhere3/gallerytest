// [MEDIA-ID / STAGE-01 / MATCHER]
//
// Pure. No I/O, no storage, no ProfileStore, no DOM. Built and fully tested in
// Stage 01 and deliberately CALLED BY NOTHING — mirroring SyncV3 Stage 02's
// "transport built and proven before any live wiring" discipline. Stage 02
// wires it, and only after the Stage 01B shared-signature audit reports.
//
// Kept out of profile-store.js the same way sync-translate.js is, so the
// algorithm can be reasoned about and sabotaged in isolation.
//
// ---- The tiering, and where confidence actually comes from ----------------
//
// [WHY: an earlier draft called structural subtree matching "high confidence"
//  while simultaneously requiring that structure never auto-resolve. Both could
//  not stand. Separating the two questions dissolves the contradiction:
//
//    "are these two roots in one tree?"  -> scope membership
//    "is this path the same media?"      -> per-item identity WITHIN a scope
//
//  T1 (FSA resolve) answers the first DETERMINISTICALLY — it is proof, not
//  inference. Once membership is proven, per-item identity is T0: an exact
//  scope-relative key lookup. That is where the confidence was really coming
//  from, and it was being misattributed to the structural tier.
//
//  T2 (structural) only ever PROPOSES membership, and proposing is not
//  resolving. Structure alone may never auto-resolve — the counterexample is
//  ordinary in a media library: a BACKUP COPY. "Backup/2023/" and "2023/" can
//  have identical layouts and identical filenames while being genuinely
//  different files. Nothing structural separates them. Content corroboration
//  is therefore mandatory, and a single size mismatch is a VETO rather than a
//  lowered score — one file that disagrees is strong evidence of a different
//  tree, and averaging it away is exactly how a false positive gets through.]

export const TIER = {
  EXACT: "T0-exact",
  ANCESTRY: "T1-ancestry",
  STRUCTURAL: "T2-structural",
  SIGNATURE: "T3-signature",
  LEGACY_SAMPLE: "T3L-legacy-sample",
};

export const VERDICT = {
  RESOLVED: "resolved",
  REFUSED_AMBIGUOUS: "refused-ambiguous",
  REFUSED_UNCORROBORATED: "refused-uncorroborated",
  REFUSED_VETOED: "refused-vetoed",
  NONE: "none",
};

// Starting values copied from legacy-library-signature.js's production-tuned
// constants — copied deliberately rather than imported, so the two matchers
// stay independently tunable.
export const STRONG_OVERLAP_MIN = 0.6;
export const STRONG_COUNT_DRIFT_MAX = 0.35;
export const AMBIGUITY_MARGIN = 0.15;
// A floor, not a ratio: a handful of corroborated files proves far more than a
// percentage of a tiny overlap does.
export const MIN_CORROBORATED_MATCHES = 3;

/**
 * T0 — exact scope-relative key lookup. Deterministic. A lookup, not a match.
 */
export function matchExact(index, scopeRelativePath) {
  const record = index.get(scopeRelativePath);
  if (!record) return { verdict: VERDICT.NONE, tier: TIER.EXACT, mediaId: null };
  return { verdict: VERDICT.RESOLVED, tier: TIER.EXACT, mediaId: record.mediaId, deterministic: true };
}

/**
 * T1 — ancestry-proven reinterpretation. Deterministic.
 *
 * Given a PROVEN prefix (from fsa-ancestry's "descendant"/"self" relation
 * only), a path observed under the descendant root is expressed in the
 * ancestor's terms and then resolved by exact lookup. Nothing is inferred.
 */
export function matchByProvenAncestry(index, relativePath, provenPrefix) {
  if (typeof provenPrefix !== "string") {
    return { verdict: VERDICT.NONE, tier: TIER.ANCESTRY, mediaId: null, reason: "no-proof" };
  }
  const result = matchExact(index, `${provenPrefix}${relativePath}`);
  return { ...result, tier: TIER.ANCESTRY, deterministic: result.verdict === VERDICT.RESOLVED };
}

function overlapRatio(currentPaths, storedPaths) {
  if (!currentPaths.length || !storedPaths.size) return 0;
  let intersect = 0;
  for (const path of currentPaths) if (storedPaths.has(path)) intersect += 1;
  return intersect / Math.max(1, Math.min(currentPaths.length, storedPaths.size));
}

/**
 * Corroboration: compares stored signatures against currently observed ones for
 * the paths the two sets share.
 *
 * Returns { corroborated, mismatched, uncorroborable }.
 *
 * A mismatch is any overlapping path where BOTH sides have a size and the sizes
 * differ. lastModified is never consulted here — it is corroborating only, and
 * promoting it to a veto signal would make ordinary re-copies look like
 * different files.
 */
export function corroborate(candidatePaths, storedByPath, observedByPath) {
  let corroborated = 0;
  let mismatched = 0;
  let uncorroborable = 0;

  for (const path of candidatePaths) {
    const stored = storedByPath.get(path);
    const observed = observedByPath.get(path);
    if (!stored || !observed) continue;

    const storedSize = stored.observedSignature ? stored.observedSignature.size : null;
    const observedSize = observed ? observed.size : null;

    if (!Number.isFinite(storedSize) || !Number.isFinite(observedSize)) {
      uncorroborable += 1;
      continue;
    }
    if (storedSize === observedSize) corroborated += 1;
    else mismatched += 1;
  }

  return { corroborated, mismatched, uncorroborable };
}

/**
 * T2 — structural subtree membership. PROPOSES only.
 *
 * `candidates` is [{ scopeId, subtreePrefix, storedPaths: Set, storedByPath: Map }].
 * `observedByPath` maps the candidate-relative path (already expressed under
 * subtreePrefix) to the observed item.
 *
 * All five requirements must hold, or this refuses:
 *   1. overlap >= STRONG_OVERLAP_MIN
 *   2. count drift <= STRONG_COUNT_DRIFT_MAX
 *   3. no second candidate within AMBIGUITY_MARGIN
 *   4. >= MIN_CORROBORATED_MATCHES corroborated sizes
 *   5. ZERO size mismatches  <- veto, not a penalty
 */
export function proposeStructuralMembership({ observedPaths, observedByPath, observedItemCount = observedPaths.length, candidates }) {
  const scored = [];

  for (const candidate of candidates) {
    const projected = observedPaths.map((path) => `${candidate.subtreePrefix || ""}${path}`);
    const ratio = overlapRatio(projected, candidate.storedPaths);
    const candidateCount = Number.isFinite(candidate.itemCount) ? candidate.itemCount : candidate.storedPaths.size;
    const drift =
      Math.abs(observedItemCount - candidateCount) /
      Math.max(observedItemCount, candidateCount, 1);

    if (ratio < STRONG_OVERLAP_MIN || drift > STRONG_COUNT_DRIFT_MAX) continue;

    // Observed items re-keyed into the candidate's terms so corroborate()
    // compares like with like.
    const projectedObserved = new Map();
    for (const path of observedPaths) {
      const item = observedByPath.get(path);
      if (item) projectedObserved.set(`${candidate.subtreePrefix || ""}${path}`, item);
    }

    const evidence = corroborate(projected, candidate.storedByPath, projectedObserved);
    scored.push({ candidate, score: ratio, evidence });
  }

  if (!scored.length) return { verdict: VERDICT.NONE, tier: TIER.STRUCTURAL, scopeId: null };

  scored.sort((a, b) => b.score - a.score);
  const [best, second] = scored;

  // Requirement 3, applied at SUBTREE granularity. Two similar sibling subtrees
  // ("2023/Cats/", "2024/Cats/") are exactly what a per-item margin misses.
  if (second && best.score - second.score < AMBIGUITY_MARGIN) {
    return {
      verdict: VERDICT.REFUSED_AMBIGUOUS,
      tier: TIER.STRUCTURAL,
      scopeId: null,
      candidateScopeIds: scored.slice(0, 2).map((entry) => entry.candidate.scopeId),
    };
  }

  // Requirement 5 first: a veto is not a score, and must not be outranked by a
  // strong overlap.
  if (best.evidence.mismatched > 0) {
    return {
      verdict: VERDICT.REFUSED_VETOED,
      tier: TIER.STRUCTURAL,
      scopeId: null,
      mismatched: best.evidence.mismatched,
    };
  }

  // Requirement 4. No corroborable evidence at all is the cross-device case:
  // per-file metadata is not synced, so another device's paths can NEVER be
  // corroborated, and this refusal is what makes that structural rather than
  // a rule somebody has to remember.
  if (best.evidence.corroborated < MIN_CORROBORATED_MATCHES) {
    return {
      verdict: VERDICT.REFUSED_UNCORROBORATED,
      tier: TIER.STRUCTURAL,
      scopeId: null,
      corroborated: best.evidence.corroborated,
      required: MIN_CORROBORATED_MATCHES,
    };
  }

  return {
    verdict: VERDICT.RESOLVED,
    tier: TIER.STRUCTURAL,
    scopeId: best.candidate.scopeId,
    score: best.score,
    evidence: best.evidence,
    deterministic: false,
  };
}

/**
 * T3 — per-item signature anchoring, for a path that moved WITHIN an
 * established scope.
 *
 * `observedThisLoad` is the set of scope-relative paths present in the SAME
 * load. Anything in it is excluded as a candidate.
 *
 * [WHY: two files observed TOGETHER are never one logical item, however
 *  identical their bytes. Unifying them would make favoriting one silently
 *  favorite the other. duplicate-filter.js draws the same boundary for the same
 *  reason — it hides one from the VIEW and never merges identity. Unification
 *  may only ever consider a path that has VANISHED against one that has
 *  APPEARED.]
 */
export function matchBySignature({ signature, candidates, observedThisLoad = new Set() }) {
  if (!signature || !Number.isFinite(signature.size)) {
    return { verdict: VERDICT.NONE, tier: TIER.SIGNATURE, mediaId: null, reason: "no-signature" };
  }

  const viable = candidates.filter((candidate) => {
    if (observedThisLoad.has(candidate.scopeRelativePath)) return false;
    const stored = candidate.observedSignature;
    if (!stored || !Number.isFinite(stored.size)) return false;
    if (stored.size !== signature.size) return false;
    // Name equality is required: size alone is a weak signal that collides
    // constantly in a real media library.
    return stored.name === signature.name;
  });

  if (!viable.length) return { verdict: VERDICT.NONE, tier: TIER.SIGNATURE, mediaId: null };

  if (viable.length > 1) {
    // mtime may only ever BREAK a tie, never create a match on its own.
    const corroborated = viable.filter(
      (candidate) =>
        signature.lastModified !== null &&
        candidate.observedSignature.lastModified === signature.lastModified
    );
    if (corroborated.length !== 1) {
      return {
        verdict: VERDICT.REFUSED_AMBIGUOUS,
        tier: TIER.SIGNATURE,
        mediaId: null,
        candidateCount: viable.length,
      };
    }
    return { verdict: VERDICT.RESOLVED, tier: TIER.SIGNATURE, mediaId: corroborated[0].mediaId, deterministic: false };
  }

  return { verdict: VERDICT.RESOLVED, tier: TIER.SIGNATURE, mediaId: viable[0].mediaId, deterministic: false };
}

/**
 * T3L — retro-anchor from a Legacy library signature.
 *
 * legacy-library-signature.js persists sampleEntries as literal
 * "relativePath|size" strings, refreshed on every recognized re-pick. That is
 * REAL historical path->size evidence predating MEDIA-ID — the only such
 * channel that exists, and it is Legacy-only (FSA records store a handle and no
 * sizes). Complete for libraries at or below SMALL_LIBRARY_THRESHOLD (200);
 * roughly 2% above it.
 */
export function parseLegacySampleEntries(sampleEntries) {
  const byPath = new Map();
  for (const entry of sampleEntries || []) {
    if (typeof entry !== "string") continue;
    const separator = entry.lastIndexOf("|");
    if (separator <= 0) continue;
    const path = entry.slice(0, separator);
    const size = Number(entry.slice(separator + 1));
    if (!path || !Number.isFinite(size)) continue;
    byPath.set(path, size);
  }
  return byPath;
}

export function matchByLegacySample({ historicalPath, sizesByPath, observedByPath, observedThisLoad = new Set() }) {
  const historicalSize = sizesByPath.get(historicalPath);
  if (!Number.isFinite(historicalSize)) {
    return { verdict: VERDICT.NONE, tier: TIER.LEGACY_SAMPLE, mediaId: null, reason: "not-sampled" };
  }

  const basename = historicalPath.slice(historicalPath.lastIndexOf("/") + 1);
  const matches = [];
  for (const [path, item] of observedByPath) {
    if (observedThisLoad.has(path) && path === historicalPath) continue;
    if (!item || item.size !== historicalSize) continue;
    if ((item.name || "") !== basename) continue;
    matches.push({ path, item });
  }

  if (!matches.length) return { verdict: VERDICT.NONE, tier: TIER.LEGACY_SAMPLE, mediaId: null };
  if (matches.length > 1) {
    return { verdict: VERDICT.REFUSED_AMBIGUOUS, tier: TIER.LEGACY_SAMPLE, mediaId: null, candidateCount: matches.length };
  }
  return { verdict: VERDICT.RESOLVED, tier: TIER.LEGACY_SAMPLE, matchedPath: matches[0].path, deterministic: false };
}
