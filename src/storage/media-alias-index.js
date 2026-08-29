// [MEDIA-ID / STAGE-02 / LOCAL-PROJECTION]
//
// The I/O half of Stage 02. Reads MEDIA-ID's own stores and (only where nothing
// cheaper can answer) the filesystem, then hands plain data to the pure algebra
// in media-identity-projection.js. Every decision lives there; every read lives
// here.
//
// ---- The existence cascade -----------------------------------------------
//
// [WHY: T1 may only admit a candidate when every COMPETING destination is
//  proven ABSENT, and "proven" is expensive if asked naively — one filesystem
//  walk per curated item. It is almost never necessary, because the load itself
//  is already a proof:
//
//    1. observed this load          -> PRESENT   (0 I/O)
//    2. banked in MEDIA-ID's paths  -> PRESENT   (0 I/O)
//    3. inside the loaded subtree,
//       and the scan COMPLETED      -> ABSENT    (0 I/O)   <- the census
//    4. otherwise                   -> probe the filesystem
//    5. nothing deterministic       -> UNKNOWN             (refuses)
//
//  Step 3 is the one that makes this affordable. The provider walked the entire
//  subtree under the loaded root, so for any scope path inside it, absence from
//  the observation set is a CENSUS RESULT, not an assumption. Consequences:
//  viewing the scope root (the MASTER case) needs zero probes because every
//  scope path is inside the loaded subtree; and the headline child case needs
//  zero probes because its only competitor is a doubled prefix which is also
//  inside it.
//
//  The census is gated on the scan having completed. An interrupted walk proves
//  nothing about what is missing — its absences are just files on the other side
//  of the failure — which is the same reason Stage 01 refuses to bank evidence
//  from an incomplete load.]
//
// ---- Root handles --------------------------------------------------------
//
// [WHY: handles come from getLibraryById(rootId), NOT listLibraries(). The
//  latter filters out rows the user removed from Recent Libraries. Under Stage
//  01 that only meant such a root was "not probed for ancestry — a missed
//  recovery, never a wrong one". Here it would be worse: an unreachable root
//  becomes UNKNOWN, and UNKNOWN refuses, so hiding a folder from Recent
//  Libraries would silently switch projection off for its whole scope.
//  getLibraryById reads the raw row and recovers those handles.]

import { getRoot, listRoots, listObservedScopePathKeys } from "./media-identity.js";
import { getLibraryById } from "./library-registry.js";
import { createExistenceProber, EXISTENCE, EXISTENCE_REASON } from "./fsa-existence.js";
import { buildAliasMap, toScopePath } from "../profile/media-identity-projection.js";
// [MEDIA-ID / STAGE-02B / TELEMETRY]
import { createRefusalLedger } from "../profile/media-identity-telemetry.js";
import { createLocalStateChannel } from "../profile/local-state-channel.js";

// [MEDIA-ID / STAGE-02 / LOCAL-PROJECTION]
// [WHY: MEDIA-ID's OWN channel name, not the Profile one. The Profile channel is
//  constructed by ProfileStore and dispatched by its private handler, so routing
//  a MEDIA-ID message through it would mean teaching ProfileStore about media
//  scopes — the exact coupling this track has avoided since Stage 01. A separate
//  name on the same generic factory costs nothing and keeps local-state-channel.js
//  unmodified.]
export const MEDIA_IDENTITY_CHANNEL_NAME = "browser-gallery-media-identity";

export const MEDIA_IDENTITY_MESSAGE_KINDS = Object.freeze({
  // A root was claimed/joined/minted, or a scope was re-based. Every stored
  // scope-relative path and every root prefix may have moved.
  SCOPE_CHANGED: "media-scope-changed",
  // A seeding pass finished, so the durable path census grew.
  EVIDENCE_CHANGED: "media-evidence-changed",
});

/**
 * Opens MEDIA-ID's invalidation channel.
 *
 * [WHY: INVALIDATION ONLY, carrying an identifier and a timestamp and nothing
 *  else. A message that carried prefixes, alias maps or projected values would
 *  be a second source of truth that can arrive twice, arrive late, or arrive
 *  from a context whose write later failed — and the receiver could not tell.
 *  IndexedDB stays the authority; a receiver that always re-reads it cannot be
 *  wrong about what it says. This mirrors local-state-channel.js's own stated
 *  contract rather than inventing a second discipline.]
 */
export function createMediaIdentityChannel({ onInvalidate = null, factory = undefined, deviceId = null } = {}) {
  const channel = createLocalStateChannel({
    channelName: MEDIA_IDENTITY_CHANNEL_NAME,
    factory,
    onMessage: (message) => {
      // Only another view of THIS installation can say anything about our own
      // storage — copied from ProfileStore#onLocalStateMessage for the same
      // reason: multi-installation test fixtures share one process and must not
      // cross-notify.
      if (message.deviceId && deviceId && message.deviceId !== deviceId) return;
      if (
        message.kind !== MEDIA_IDENTITY_MESSAGE_KINDS.SCOPE_CHANGED &&
        message.kind !== MEDIA_IDENTITY_MESSAGE_KINDS.EVIDENCE_CHANGED
      ) {
        return;
      }
      if (onInvalidate) onInvalidate(message);
    },
  });

  return {
    contextId: channel.contextId,
    get available() {
      return channel.available;
    },
    announce(kind, { scopeId = null, at = Date.now() } = {}) {
      return channel.post({ kind, scopeId, deviceId, at });
    },
    close() {
      channel.close();
    },
  };
}

/**
 * Reads the roots of one scope, each with the handle needed to prove existence
 * under it. A root with no usable handle keeps its prefix (the mapping is still
 * proven) but can answer no existence question — which surfaces as UNKNOWN and
 * therefore refuses.
 */
async function readScopeRoots(scopeId) {
  const all = await listRoots();
  const members = all.filter((root) => root && root.scopeId === scopeId);
  const roots = [];
  for (const member of members) {
    let handle = null;
    try {
      const row = await getLibraryById(member.rootId);
      handle = row && row.handle ? row.handle : null;
    } catch {
      // A row we cannot read is a root we cannot probe. Prefix still applies.
      handle = null;
    }
    roots.push({
      rootId: member.rootId,
      prefixFromScopeRoot: member.prefixFromScopeRoot || "",
      sourceKind: member.sourceKind || null,
      handle,
    });
  }
  // Shallowest first, so the scope root is tried before deeper members when
  // proving existence — it can see the most and is usually already granted.
  roots.sort((a, b) => a.prefixFromScopeRoot.length - b.prefixFromScopeRoot.length);
  return roots;
}

/**
 * Builds the existence oracle for one load. Memoized per scope path, so a
 * destination shared by many candidates is decided once.
 */
export function createStatusResolver({
  roots,
  loadedPrefix,
  loadComplete,
  observedScopePaths,
  durableScopePaths,
  prober,
}) {
  const decided = new Map();
  const stats = { observedHits: 0, durableHits: 0, censusAbsent: 0, probed: 0, unknown: 0 };

  /**
   * [MEDIA-ID / STAGE-02B / REASON-MODEL]
   *
   * Returns { status, reason, detail } instead of a bare status. The cascade
   * below is UNCHANGED — same order, same conditions, same short-circuits, same
   * `break` on the first deterministic probe answer. Every branch already knew
   * why it was answering what it answered; Stage 02B stops discarding it.
   *
   * [WHY THE MEMO STILL HOLDS THE WHOLE ANSWER: one destination decided once,
   *  reused by every candidate that names it. That is what keeps a doubled
   *  prefix at one probe rather than several hundred, and the reason has to
   *  travel with the cached status or every reuse would report as unattributed.]
   */
  async function resolve(scopePath) {
    const cached = decided.get(scopePath);
    if (cached) return cached;

    let answer;
    if (observedScopePaths.has(scopePath)) {
      stats.observedHits += 1;
      answer = { status: EXISTENCE.PRESENT, reason: EXISTENCE_REASON.OBSERVED_CURRENT, detail: null };
    } else if (durableScopePaths && durableScopePaths.has(scopePath)) {
      // [MEDIA-ID / STAGE-02 / BP-FAIL-02] `durableScopePaths` is built from
      // listObservedScopePathKeys(), so a fact-only row can never land here.
      stats.durableHits += 1;
      answer = { status: EXISTENCE.PRESENT, reason: EXISTENCE_REASON.OBSERVED_DURABLE, detail: null };
    } else if (loadComplete && scopePath.startsWith(loadedPrefix)) {
      // The census. See the module header for why this is proof, not assumption.
      stats.censusAbsent += 1;
      answer = { status: EXISTENCE.ABSENT, reason: EXISTENCE_REASON.CENSUS, detail: null };
    } else {
      answer = { status: EXISTENCE.UNKNOWN, reason: null, detail: null };
      // [MEDIA-ID / STAGE-02B / REASON-MODEL]
      // [WHY THESE TWO FLAGS: a destination no root can even NAME and a
      //  destination a root names but cannot open are the same UNKNOWN to the
      //  admission rule and completely different problems to fix. The first is
      //  structural (the scope's roots do not cover this path); the second is a
      //  lapsed or missing handle, which is the case Stage 03 shared evidence
      //  could plausibly help with. Collapsing them would erase the distinction
      //  this whole stage exists to measure.]
      let firstProbeReason = null;
      let firstProbeDetail = null;
      let sawCoveringRootWithoutHandle = false;
      for (const root of roots) {
        const prefix = root.prefixFromScopeRoot || "";
        if (prefix && !scopePath.startsWith(prefix)) continue;
        if (!root.handle) {
          sawCoveringRootWithoutHandle = true;
          continue;
        }
        stats.probed += 1;
        const probed = await prober.probeDetailed(root.rootId, root.handle, scopePath.slice(prefix.length));
        // A file either exists at a scope location or it does not, so the first
        // DETERMINISTIC answer settles it — no need to ask a second root.
        if (probed.status === EXISTENCE.PRESENT || probed.status === EXISTENCE.ABSENT) {
          answer = { status: probed.status, reason: probed.reason, detail: probed.detail };
          break;
        }
        // Shallowest covering root first (see readScopeRoots' sort), so the
        // first UNKNOWN is the most representative one to report.
        if (!firstProbeReason) {
          firstProbeReason = probed.reason;
          firstProbeDetail = probed.detail;
        }
      }
      if (answer.status === EXISTENCE.UNKNOWN) {
        stats.unknown += 1;
        // An attempted probe explains more than a skip, so it wins.
        answer.reason =
          firstProbeReason ||
          (sawCoveringRootWithoutHandle ? EXISTENCE_REASON.NO_HANDLE : EXISTENCE_REASON.NO_COVERING_ROOT);
        answer.detail = firstProbeReason ? firstProbeDetail : null;
      }
    }

    decided.set(scopePath, answer);
    return answer;
  }

  return { resolve, stats, size: () => decided.size };
}

/**
 * Builds one load's alias index.
 *
 * Returns null when there is nothing to project — no scope, a single-root
 * scope, or no curated paths — which is the ordinary case and makes every
 * facade read a straight delegation.
 */
export async function buildAliasIndexForLoad({
  rootId,
  profileId,
  items,
  factKeys,
  loadComplete = true,
  fileProbeBudget,
  probeMsBudget,
} = {}) {
  if (!rootId) return null;

  const root = await getRoot(rootId);
  if (!root || !root.scopeId) return null;

  const prefix = root.prefixFromScopeRoot || "";
  const roots = await readScopeRoots(root.scopeId);
  if (roots.length < 2) {
    // One root means the only key for a location is the T0 key. Nothing to do.
    return null;
  }

  const observedScopePaths = new Set();
  for (const item of items || []) {
    if (item && typeof item.relativePath === "string" && item.relativePath) {
      observedScopePaths.add(toScopePath(prefix, item.relativePath));
    }
  }

  let durableScopePaths = null;
  try {
    // [MEDIA-ID / STAGE-02 / BP-FAIL-02]
    // OBSERVED rows only. A `fact-only` row means a Profile fact named this
    // scope path during some load, not that a file was seen there — and a child
    // load banks exactly such a row, under a DOUBLED prefix, for every
    // MASTER-relative curated key. Those doubled paths are the very competitors
    // T1 must rule out, so counting them as PRESENT refused every candidate.
    const keys = await listObservedScopePathKeys(root.scopeId);
    // null means "no knowledge" (missing index), NOT "no paths" — see
    // listObservedScopePathKeys. Left null so it contributes no false absence.
    durableScopePaths = keys ? new Set(keys) : null;
  } catch (error) {
    console.warn("[MEDIA-ID] Could not read banked path keys; projection will prove existence instead.", error);
    durableScopePaths = null;
  }

  const prober = createExistenceProber({
    fileProbeBudget,
    msBudget: probeMsBudget,
  });

  const status = createStatusResolver({
    roots,
    loadedPrefix: prefix,
    loadComplete,
    observedScopePaths,
    durableScopePaths,
    prober,
  });

  // [MEDIA-ID / STAGE-02 / BP-FAIL-01]
  // [WHY: `factKeys` may be a FUNCTION, and every caller that can be rebuilt
  //  must pass one. ProfileStore loads its saved records asynchronously in its
  //  constructor and exposes no promise for it — whenFactsSettled() awaits the
  //  fact QUEUE, not that read — so on a page reload knownPaths() is legitimately
  //  EMPTY for the first few tasks. A build that captured the array at that
  //  moment saw zero curated paths and produced zero aliases, and because the
  //  captured array was reused for every later rebuild, the projection could
  //  never recover for the life of the session. Reading through a callback makes
  //  every rebuild see the CURRENT curation, which is the property that lets a
  //  rebuild fix an early build. Proven against a real Browser Preview failure:
  //  222 items refreshed into the correct scope, correct prefix, five stamped
  //  MASTER facts present — and 0 aliased items on every single rebuild.]
  const resolvedFactKeys = typeof factKeys === "function" ? factKeys() : factKeys;

  // [MEDIA-ID / STAGE-02B / TELEMETRY]
  // One ledger per build. It is fed by the SAME pass that makes the decisions —
  // there is no second walk, no second probe and no extra read anywhere in this
  // stage. See tools/test-media-projection-telemetry.mjs, which asserts the
  // probe and IndexedDB counters are identical with and without it.
  const ledger = createRefusalLedger();

  const { aliases, diagnostics } = await buildAliasMap({
    prefixFromScopeRoot: prefix,
    roots,
    observed: items || [],
    factKeys: resolvedFactKeys || [],
    statusOf: status.resolve,
    ledger,
  });

  return {
    scopeId: root.scopeId,
    rootId,
    // Resolved the same way factKeys is, so a long-lived request cannot pin the
    // index to a Profile that is no longer active. See the WHY above.
    profileId: (typeof profileId === "function" ? profileId() : profileId) || null,
    prefixFromScopeRoot: prefix,
    // [MEDIA-ID / STAGE-02 / BP-FAIL-01]
    // Carried so a caller can cheaply ask "could newly curated paths produce an
    // alias here?" without rebuilding the whole map.
    rootPrefixes: roots.map((entry) => entry.prefixFromScopeRoot || ""),
    aliases,
    diagnostics: {
      ...diagnostics,
      roots: roots.length,
      rootsWithHandles: roots.filter((entry) => entry.handle).length,
      durableKeys: durableScopePaths ? durableScopePaths.size : null,
      existence: status.stats,
      probes: { ...{ fileProbes: prober.stats.fileProbes, directoryProbes: prober.stats.directoryProbes, budgetExhausted: prober.stats.budgetExhausted } },
    },
  };
}
