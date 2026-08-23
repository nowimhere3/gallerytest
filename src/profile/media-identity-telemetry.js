// [MEDIA-ID / STAGE-02B / TELEMETRY]
//
// LOCAL OBSERVABILITY ONLY. Pure: no I/O, no IndexedDB, no FSA, no DOM, no
// BroadcastChannel, no network. Nothing in this file can change an admission
// decision — it is handed decisions that have ALREADY been made and does
// arithmetic on them.
//
// ---- Why there is no database here ---------------------------------------
//
// [WHY: Stage 02B asks whether Stage 03's shared media evidence is warranted.
//  That question is answered by the SHAPE and FREQUENCY of refusals, not by
//  their history — and every durable option costs far more than it returns:
//
//    A. per-load aggregate only   — correct, but the console line is overwritten
//                                   by the next rebuild, and one load produces
//                                   several. Too lossy to compare MASTER-first
//                                   against child-first in one sitting.
//    B. bounded session history   — CHOSEN. A fixed-length in-memory ring of
//                                   per-build aggregates. No schema, no
//                                   migration, no invalidation on re-base, no
//                                   multi-tab convergence question, and it dies
//                                   with the tab.
//    C. bounded persistent history— rejected. It would need a store, a version,
//                                   a retention policy, an eviction policy, and
//                                   a multi-tab story, all to answer a question
//                                   a single session already answers. It would
//                                   also be a durable record of which media a
//                                   user curates, which is exactly the "database
//                                   of raw media paths" this stage must not
//                                   build.
//
//  So: session-local, in-memory, bounded, never broadcast, never persisted.
//  Multi-tab semantics are therefore trivially "none" — two tabs each observe
//  their own builds and neither can see or corrupt the other's counters.]
//
// ---- Cardinality ---------------------------------------------------------
//
// [WHY: a diagnostic that grows with the library is not a diagnostic. Every
//  aggregate below is keyed by the CLOSED EXISTENCE_REASON vocabulary, so the
//  headline output has a fixed maximum width no matter whether the library
//  holds 12 files or 200,000. Two bounded escapes exist for development —
//  per-reason `detail` values and per-reason path exemplars — and both are hard
//  capped with an overflow counter rather than allowed to grow.
//
//  Exemplars are the only place a real path is retained. They are capped at
//  EXEMPLARS_PER_REASON per reason (so a few dozen strings for the whole
//  session), they are NEVER written to the normal console line, and they are
//  reachable only through the explicit debug accessor in main.js.]

import { EXISTENCE, EXISTENCE_REASON } from "../storage/fsa-existence.js";

export const TELEMETRY_LIMITS = Object.freeze({
  EXEMPLARS_PER_REASON: 3,
  DETAILS_PER_REASON: 8,
  SESSION_BUILDS: 20,
});

/**
 * [MEDIA-ID / STAGE-02B / REASON-MODEL]
 *
 * Accepts what an existence oracle actually returns and normalizes it to
 * { status, reason, detail }.
 *
 * [WHY IT TOLERATES A BARE STRING: `statusOf` is an INJECTED callback and the
 *  Stage 02 test tables drive it with plain EXISTENCE values. Requiring the rich
 *  shape would have meant rewriting those tables, which is how a telemetry
 *  change quietly becomes a semantics change. A bare status keeps its exact
 *  meaning and reports as `unattributed`.
 *
 *  An answer that is neither — null, undefined, a number — becomes UNKNOWN,
 *  which REFUSES. A string this module does not recognize is passed through
 *  untouched so admitCandidate can refuse it exactly as Stage 02 does.]
 */
export function normalizeExistence(answer) {
  if (typeof answer === "string") return { status: answer, reason: null, detail: null };
  if (answer && typeof answer.status === "string") {
    return {
      status: answer.status,
      reason: typeof answer.reason === "string" ? answer.reason : null,
      detail: answer.detail === undefined ? null : answer.detail,
    };
  }
  return { status: EXISTENCE.UNKNOWN, reason: null, detail: null };
}

function unattributedFor(status) {
  if (status === EXISTENCE.PRESENT) return EXISTENCE_REASON.UNATTRIBUTED_PRESENT;
  if (status === EXISTENCE.ABSENT) return EXISTENCE_REASON.UNATTRIBUTED_ABSENT;
  return EXISTENCE_REASON.UNATTRIBUTED_UNKNOWN;
}

/**
 * One load's refusal ledger.
 *
 * It is fed the verdict objects admitCandidate already produces, so it observes
 * decisions rather than re-deriving them. It never calls statusOf, never probes,
 * and never reads storage — the whole reason Stage 02's probe counts are
 * unchanged by Stage 02B.
 */
export function createRefusalLedger({
  exemplarsPerReason = TELEMETRY_LIMITS.EXEMPLARS_PER_REASON,
  detailsPerReason = TELEMETRY_LIMITS.DETAILS_PER_REASON,
} = {}) {
  const presentBy = new Map();
  const unknownBy = new Map();
  const absentBy = new Map();
  const details = new Map(); // reason -> Map(detail -> count)
  const exemplars = new Map(); // reason -> [{ scopePath, key, destination, viaRootId }]

  let detailsDropped = 0;
  let exemplarsDropped = 0;

  const candidates = { total: 0, admitted: 0, refusedPresent: 0, refusedUnknown: 0 };
  const items = { withCandidates: 0, aliased: 0, refused: 0, contested: 0, multiAlias: 0 };

  function bump(map, key) {
    map.set(key, (map.get(key) || 0) + 1);
  }

  function noteDetail(reason, detail) {
    if (detail === null || detail === undefined || detail === "") return;
    const text = String(detail);
    let bucket = details.get(reason);
    if (!bucket) {
      bucket = new Map();
      details.set(reason, bucket);
    }
    if (!bucket.has(text) && bucket.size >= detailsPerReason) {
      detailsDropped += 1;
      return;
    }
    bump(bucket, text);
  }

  function noteExemplar(reason, sample) {
    let bucket = exemplars.get(reason);
    if (!bucket) {
      bucket = [];
      exemplars.set(reason, bucket);
    }
    if (bucket.length >= exemplarsPerReason) {
      exemplarsDropped += 1;
      return;
    }
    bucket.push(sample);
  }

  /**
   * Records ONE candidate-key decision.
   *
   * [WHY THE DECIDING CHECK IS THE LAST ONE: admitCandidate returns the instant a
   *  competing destination refuses, so the final entry of `checked` IS the reason
   *  the candidate was refused. Earlier entries were all proven ABSENT and are
   *  counted as such — they are how the census/probe split is measured.]
   */
  function recordCandidate({ scopePath = null, key = null, viaRootId = null, verdict }) {
    candidates.total += 1;
    const checked = (verdict && verdict.checked) || [];

    if (verdict && verdict.admitted) {
      candidates.admitted += 1;
      for (const check of checked) bump(absentBy, check.reason || unattributedFor(check.status));
      return;
    }

    const deciding = checked.length ? checked[checked.length - 1] : null;
    // Everything before the deciding check was ABSENT; count that evidence too.
    for (let i = 0; i < checked.length - 1; i++) {
      bump(absentBy, checked[i].reason || unattributedFor(checked[i].status));
    }

    const status = deciding ? deciding.status : EXISTENCE.UNKNOWN;
    const reason = (deciding && deciding.reason) || unattributedFor(status);

    if (status === EXISTENCE.PRESENT) {
      candidates.refusedPresent += 1;
      bump(presentBy, reason);
    } else {
      candidates.refusedUnknown += 1;
      bump(unknownBy, reason);
    }

    noteDetail(reason, deciding ? deciding.detail : null);
    noteExemplar(reason, {
      scopePath,
      key,
      destination: deciding ? deciding.destination : null,
      viaRootId,
    });
  }

  /**
   * Records ONE observed item that produced at least one candidate.
   *
   * [WHY `contested` AND `multiAlias` ARE SEPARATE: they answer two different
   *  Stage 03 questions. `contested` is "more than one stored fact path could
   *  denote this file", which is where ambiguity LIVES. `multiAlias` is "more
   *  than one of them was ADMITTED", which is where the stamped-fact conflict
   *  algebra actually has to arbitrate. A library can have plenty of the first
   *  and none of the second.]
   */
  function recordItem({ candidateCount = 0, admittedCount = 0 } = {}) {
    if (candidateCount <= 0) return;
    items.withCandidates += 1;
    if (candidateCount > 1) items.contested += 1;
    if (admittedCount > 0) {
      items.aliased += 1;
      if (admittedCount > 1) items.multiAlias += 1;
    } else {
      items.refused += 1;
    }
  }

  function plain(map) {
    const out = {};
    for (const [key, value] of map) out[key] = value;
    return out;
  }

  function snapshot() {
    const detailOut = {};
    for (const [reason, bucket] of details) detailOut[reason] = plain(bucket);
    const exemplarOut = {};
    for (const [reason, bucket] of exemplars) exemplarOut[reason] = bucket.map((entry) => ({ ...entry }));
    return {
      candidates: { ...candidates },
      items: { ...items },
      presentBy: plain(presentBy),
      unknownBy: plain(unknownBy),
      absentBy: plain(absentBy),
      details: detailOut,
      // Debug-only. Never printed by formatTelemetry.
      exemplars: exemplarOut,
      truncated: { exemplars: exemplarsDropped, details: detailsDropped },
    };
  }

  return { recordCandidate, recordItem, snapshot };
}

function formatBuckets(buckets) {
  const parts = [];
  for (const [reason, count] of Object.entries(buckets || {})) {
    if (!count) continue;
    // "unknown/no-handle" -> "no-handle": the bucket name already says which.
    parts.push(`${reason.slice(reason.indexOf("/") + 1)}=${count}`);
  }
  return parts.join(", ");
}

/**
 * The compact normal-operation line. Aggregates only — no paths, no filenames,
 * no fact values, and a fixed maximum width set by the closed vocabulary.
 */
export function formatTelemetry(snapshot) {
  if (!snapshot) return "no telemetry";
  // `candidates` is deliberately NOT repeated here — the Stage 02 half of the
  // same line already reports candidates/admitted/refused. This half adds only
  // the WHY and the per-ITEM view that Stage 02 had no counter for.
  const items = snapshot.items;
  const present = formatBuckets(snapshot.presentBy);
  const unknown = formatBuckets(snapshot.unknownBy);
  const absent = formatBuckets(snapshot.absentBy);
  const parts = [
    `items(candidates=${items.withCandidates}, aliased=${items.aliased}, refused=${items.refused}, ` +
      `contested=${items.contested}, multiAlias=${items.multiAlias})`,
  ];
  if (present) parts.push(`refusedPresent[${present}]`);
  if (unknown) parts.push(`refusedUnknown[${unknown}]`);
  if (absent) parts.push(`absentVia[${absent}]`);
  const dropped = snapshot.truncated || {};
  if (dropped.details) parts.push(`detailsDropped=${dropped.details}`);
  return parts.join(" ");
}

/**
 * The bounded session ring. In-memory, session-local, never persisted, never
 * broadcast. Oldest entries are dropped, so a long session cannot grow it.
 */
export function createSessionHistory(limit = TELEMETRY_LIMITS.SESSION_BUILDS) {
  const entries = [];
  let dropped = 0;
  return {
    push(entry) {
      entries.push(entry);
      while (entries.length > limit) {
        entries.shift();
        dropped += 1;
      }
      return entry;
    },
    entries() {
      return entries.slice();
    },
    get size() {
      return entries.length;
    },
    get dropped() {
      return dropped;
    },
    clear() {
      entries.length = 0;
      dropped = 0;
    },
  };
}
