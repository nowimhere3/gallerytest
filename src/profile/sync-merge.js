// [PHASE-6-SYNC-V2]
// [STAGE-C-MERGE-SEMANTICS]
// [WHY: every synchronized fact must merge deterministically and survive
//  concurrent writers. Sync V1 compared one content fingerprint per whole
//  collection, which can only ever answer "same or different" — so two clients
//  that both changed anything had no possible resolution except discarding one
//  side wholesale. Merging per fact needs ORDERING metadata, and ordering has
//  to be carried by the data itself rather than derived from file mtimes or
//  clocks that disagree between machines. This module is that ordering: a
//  total order over stamps, and a merge built from it that is commutative,
//  associative and idempotent — which is what makes every client converge on
//  the same state regardless of the order updates happen to arrive in.]
//
// WHAT: The merge algebra. Stamps, the hybrid logical clock that issues them,
// and the shape-aware merge over a Replica.
//
// This file is PURE. No DOM, no IndexedDB, no File System Access, no imports.
// It reads no clocks except through an injected `now`, and performs no I/O, so
// its behavior is fully reproducible — which is what lets Stage C's tests
// assert convergence properties rather than merely poke at examples.
//
// FUTURE / DO-NOT-BREAK: Merge must never consult anything outside its two
// arguments. The moment it reads the current time, a device id from ambient
// state, or "which side is local", it stops being commutative and the
// convergence guarantee in section 20 of the contract is gone.

// ---- Stamps --------------------------------------------------------------
//
// A Stamp is { t, d }:
//   t — monotonic logical time, milliseconds-scale so it stays human-readable
//       and roughly wall-clock-aligned
//   d — the originating deviceId, used only to break exact ties
//
// A Fact carries its stamp inline ({ v, t, d }) rather than nesting it under a
// sub-object: the stamp IS part of the fact's identity, and flattening keeps
// the published form smaller and easier to read by eye during debugging.

/**
 * Total order over stamps. Deterministic, transitive, and antisymmetric — the
 * three properties mergeFact's correctness rests on.
 *
 * Returns <0 if a precedes b, >0 if a follows b, 0 if identical.
 */
export function compareStamps(a, b) {
  if (a.t !== b.t) return a.t < b.t ? -1 : 1;
  if (a.d !== b.d) return a.d < b.d ? -1 : 1;
  return 0;
}

/**
 * Canonical JSON — keys sorted at every depth. Used for value-level tie
 * breaking below and for comparing replicas in tests. Deliberately not a
 * general serializer: it assumes the JSON-shaped values this model permits.
 */
export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  // Undefined-valued keys are skipped, matching JSON.stringify, so a fact that
  // was never set compares equal to one that is simply absent.
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

// [PHASE-6-SYNC-V2][STAGE-C-MERGE-SEMANTICS]
// [WHY: "the newest explicit mutation for the same fact wins" needs an
//  ordering that is wall-clock-aligned, so it generally tracks real-world
//  mutation time, while remaining monotonic and deterministic across devices
//  whose clocks disagree — without ever letting a skewed clock win permanently
//  or starve a device. A pure Lamport counter is deterministic but need not
//  track real time at all; a raw wall clock tracks real time but lets a machine
//  an hour fast dominate forever and a machine an hour slow never win. The
//  hybrid takes wall-clock time as one floor and the highest stamp ever
//  OBSERVED as the other, so a device that has seen a peer's future timestamp
//  immediately issues stamps above it — self-correcting within one exchange,
//  with no clock sync. Alignment is a tendency, not a guarantee: the resulting
//  order is always deterministic and convergent, but under skew it is not
//  guaranteed to match the true real-world order of two concurrent mutations.]
export class HybridClock {
  #deviceId;
  #now;
  #last = 0;

  constructor(deviceId, { now = () => Date.now() } = {}) {
    if (typeof deviceId !== "string" || !deviceId) {
      throw new Error("HybridClock requires a non-empty deviceId.");
    }
    this.#deviceId = deviceId;
    this.#now = now;
  }

  get deviceId() {
    return this.#deviceId;
  }

  /** Raises the floor to account for a stamp seen from any source. */
  observe(t) {
    if (Number.isFinite(t) && t > this.#last) this.#last = t;
    return this;
  }

  /** Raises the floor past every stamp anywhere in a replica. */
  observeReplica(replica) {
    forEachFact(replica, (fact) => this.observe(fact.t));
    return this;
  }

  /**
   * Issues the next stamp. Strictly greater than every stamp this clock has
   * issued or observed, so two mutations in the same millisecond — or on a
   * clock that has just jumped backwards — still order correctly.
   *
   * REQUIRED OF EVERY CALLER (Stage D integration contract): observeReplica()
   * must run against the current merged replica BEFORE any local mutation
   * draws a stamp from this clock. A local action carries no privilege in this
   * model — sync-facts.js applies mutations through mergeFact, so if the
   * replica already holds a NEWER fact for the key being changed, the local
   * action loses and silently does nothing. Observing first lifts this clock
   * above everything present, which is what makes "the user just did this, so
   * it wins" true. Skipping it produces an intermittent, extremely confusing
   * "my click didn't stick" bug rather than a loud failure.
   */
  tick() {
    const wall = this.#now();
    const t = Math.max(Number.isFinite(wall) ? wall : 0, this.#last + 1);
    this.#last = t;
    return { t, d: this.#deviceId };
  }
}

/** Builds a fact from a value and a stamp. */
export function makeFact(value, stamp) {
  return { v: value, t: stamp.t, d: stamp.d };
}

// ---- Fact merge ----------------------------------------------------------

// [PHASE-6-SYNC-V2][STAGE-C-MERGE-SEMANTICS]
// [WHY: this single function is where convergence comes from. It is a maximum
//  over a total order, which makes it commutative, associative and idempotent
//  — and those three properties lift unchanged through every map fold below.
//  The consequence is that a client's final state depends only on the SET of
//  facts it has seen, never on arrival order, never on how many times a fact
//  arrived, and never on which peer it came from. Any change here that makes
//  the result depend on argument order breaks section 20 of the contract for
//  the entire system, not just for one field.]
export function mergeFact(a, b) {
  if (a === undefined || a === null) return b;
  if (b === undefined || b === null) return a;

  const order = compareStamps(a, b);
  if (order > 0) return a;
  if (order < 0) return b;

  // Identical stamps. One honest device cannot produce this — tick() is
  // strictly monotonic — so it means a duplicated deviceId or tampered data.
  // Break the tie on the value itself rather than on argument order, so merge
  // stays commutative even on malformed input instead of silently diverging.
  return stableStringify(a.v) >= stableStringify(b.v) ? a : b;
}

/**
 * Merges two maps of the same kind, over the UNION of their keys. Output keys
 * are sorted so a merged replica has one canonical serialization regardless of
 * which side contributed which key.
 *
 * A key present on only one side is taken as-is — which is precisely why
 * absence can never mean deletion in this model. Deletion has to be an
 * explicit fact (see sync-facts.js), because a merge that treated a missing
 * key as "removed" would delete every fact the other client simply hadn't
 * heard about yet.
 */
export function mergeMaps(a, b, mergeValue) {
  const left = a || {};
  const right = b || {};
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();

  const out = {};
  for (const key of keys) {
    const l = left[key];
    const r = right[key];
    out[key] = l === undefined ? r : r === undefined ? l : mergeValue(l, r);
  }
  return out;
}

// ---- Shape-aware merge ---------------------------------------------------

export function mergeItemFacts(a, b) {
  return {
    favorite: mergeFact(a.favorite, b.favorite),
    hidden: mergeFact(a.hidden, b.hidden),
    tags: mergeMaps(a.tags, b.tags, mergeFact),
  };
}

export function mergeTagFacts(a, b) {
  return {
    name: mergeFact(a.name, b.name),
    deleted: mergeFact(a.deleted, b.deleted),
  };
}

// [SYNCV3 / STAGE-04B / SHARED-LIBRARY-RECORD]
// [WHY: name, sourceDeviceId and lastLoadedAt merge INDEPENDENTLY, each at its
//  own stamp. The alternative - one Fact<{name, sourceDeviceId, lastLoadedAt}>
//  merged by a single stamp - would make the later of two concurrent edits win
//  the WHOLE record, so Device A renaming a Library would silently erase Device
//  B's newer lastLoadedAt (or the reverse). That is the same defect this file
//  already avoids for Profiles: items and tags are per-key facts precisely so a
//  favourite and a tag assignment made at the same moment do not fight.
//
//  Structured exactly like mergeProfileFacts/mergeTagFacts above, so it inherits
//  their commutativity, associativity and idempotence from mergeFact rather than
//  introducing any new algebra to prove.]
export function mergeLibraryFacts(a, b) {
  return {
    name: mergeFact(a.name, b.name),
    sourceDeviceId: mergeFact(a.sourceDeviceId, b.sourceDeviceId),
    lastLoadedAt: mergeFact(a.lastLoadedAt, b.lastLoadedAt),
  };
}

export function mergeStructureFacts(a, b) {
  return {
    children: mergeMaps(a.children, b.children, mergeFact),
    sample: mergeFact(a.sample, b.sample),
  };
}

export function mergeProfileFacts(a, b) {
  return {
    name: mergeFact(a.name, b.name),
    deleted: mergeFact(a.deleted, b.deleted),
    items: mergeMaps(a.items, b.items, mergeItemFacts),
    tags: mergeMaps(a.tags, b.tags, mergeTagFacts),
  };
}

/**
 * Merges two complete replicas.
 *
 * [PHASE-6-SYNC-V2][STAGE-C-MERGE-SEMANTICS]
 * [WHY: profiles are merged as an independent map keyed by Profile ID, so a
 *  mutation belonging to BBG4 has no representation that could reach BEAST —
 *  section 1's merge boundary is structural here, not a rule someone has to
 *  remember to honor. Library associations sit OUTSIDE the profiles map
 *  because "which Profile does this library default to" is a fact about the
 *  library, not curation owned by either Profile.]
 */
export function mergeReplicas(a, b) {
  return {
    schemaVersion: Math.max(a.schemaVersion || 0, b.schemaVersion || 0),
    profiles: mergeMaps(a.profiles, b.profiles, mergeProfileFacts),
    associations: mergeMaps(a.associations, b.associations, mergeFact),
    // [SYNCV3 / STAGE-04B / SHARED-LIBRARY-RECORD]
    // [WHY: a THIRD independent top-level map, not a field inside associations
    //  and not a field inside profiles. "This Library exists, and is called
    //  this" is a fact about the Library itself - it survives the Library being
    //  disassociated (associations[id].v === null) and it belongs to no Profile.
    //  mergeMaps already takes a key present on only one side as-is, so a
    //  libraryId this device has never heard of materializes with no
    //  special-casing at all.]
    libraries: mergeMaps(a.libraries, b.libraries, mergeLibraryFacts),
    // Portable evidence is independent of catalog and association facts. A
    // newer sample wins by ordinary LWW; child relations merge per prefix.
    structure: mergeMaps(a.structure, b.structure, mergeStructureFacts),
  };
}

/** Folds any number of replicas. Order-independent by construction. */
export function mergeAll(replicas) {
  return replicas.reduce((acc, next) => mergeReplicas(acc, next));
}

// ---- Traversal -----------------------------------------------------------

/** Visits every fact in a replica. Used by the clock and by the shape guard. */
export function forEachFact(replica, visit) {
  if (!replica || typeof replica !== "object") return;

  for (const fact of Object.values(replica.associations || {})) {
    if (isFact(fact)) visit(fact);
  }

  // [SYNCV3 / CLOCK-HOTFIX / LIBRARY-FACT-OBSERVATION]
  // [WHY: LibraryFacts are three independently ordered facts. Keeping them in
  //  this canonical traversal makes every observeReplica caller raise its
  //  clock floor past the complete replica, just as it already does for
  //  associations and Profile facts.]
  for (const library of Object.values(replica.libraries || {})) {
    if (!library || typeof library !== "object") continue;
    if (isFact(library.name)) visit(library.name);
    if (isFact(library.sourceDeviceId)) visit(library.sourceDeviceId);
    if (isFact(library.lastLoadedAt)) visit(library.lastLoadedAt);
  }


  for (const structure of Object.values(replica.structure || {})) {
    if (!structure || typeof structure !== "object") continue;
    if (isFact(structure.sample)) visit(structure.sample);
    for (const child of Object.values(structure.children || {})) {
      if (isFact(child)) visit(child);
    }
  }

  for (const profile of Object.values(replica.profiles || {})) {
    if (!profile || typeof profile !== "object") continue;
    if (isFact(profile.name)) visit(profile.name);
    if (isFact(profile.deleted)) visit(profile.deleted);

    for (const item of Object.values(profile.items || {})) {
      if (!item || typeof item !== "object") continue;
      if (isFact(item.favorite)) visit(item.favorite);
      if (isFact(item.hidden)) visit(item.hidden);
      for (const assignment of Object.values(item.tags || {})) {
        if (isFact(assignment)) visit(assignment);
      }
    }

    for (const tag of Object.values(profile.tags || {})) {
      if (!tag || typeof tag !== "object") continue;
      if (isFact(tag.name)) visit(tag.name);
      if (isFact(tag.deleted)) visit(tag.deleted);
    }
  }
}

export function isFact(value) {
  return Boolean(value) && typeof value === "object" && "v" in value && typeof value.t === "number" && typeof value.d === "string";
}
