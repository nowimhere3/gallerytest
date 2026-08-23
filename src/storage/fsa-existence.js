// [MEDIA-ID / STAGE-02 / LOCAL-PROJECTION]
//
// The ONLY place in this codebase that asks the File System Access API whether
// a path EXISTS. A sibling of fsa-ancestry.js, deliberately built to the same
// shape: one seam, one kill switch, one three-state contract, and no caller
// anywhere else that touches getDirectoryHandle()/getFileHandle() to answer an
// existence question.
//
// ---- Why a three-state contract, again -----------------------------------
//
// [WHY: fsa-ancestry.js keeps "unknown" as its own state because a throw is
//  the ABSENCE of a result, never a negative one. The same distinction is what
//  makes T1 safe here, and the stakes are higher: T1 projects a user's curation
//  onto a file, so reading "I could not look" as "it is not there" would let
//  one file's Favorite land on a different file.
//
//  ABSENT is therefore reachable from exactly TWO outcomes, both of which the
//  FSA spec defines as deterministic negative answers:
//    NotFoundError      - no entry with that name
//    TypeMismatchError  - an entry exists but is the wrong kind, so the path
//                         being asked about deterministically does not exist
//  Everything else - NotAllowedError, SecurityError, a missing handle, a
//  permission state that is not "granted", an exhausted budget, an exotic
//  throw - is UNKNOWN, and every caller must refuse on UNKNOWN.]
//
// ---- Nothing here ever asks for permission -------------------------------
//
// queryPermission() only, never requestPermission(), matching fsa-ancestry.js
// and main.js's read-only audit discipline. requestPermission() needs a user
// gesture, and silently prompting from a background projection build is exactly
// the surprise this project has repeatedly refused. A root whose permission is
// not already "granted" is UNKNOWN, which refuses - it is never escalated.
//
// ---- Why the memoization is per DIRECTORY, not per path ------------------
//
// [WHY: the competing destination a child-root projection has to rule out is
//  usually a DOUBLED PREFIX - "Staging area/Mackenzie/Staging area/Mackenzie/
//  cat.jpg". Its very first segment is absent, and that single NotFoundError
//  settles every one of the several hundred candidates underneath it. Caching
//  full paths would re-walk that same missing directory once per curated item;
//  caching directories collapses the whole set to one probe. This is what makes
//  the safety upgrade affordable rather than a per-item I/O storm.]

export const EXISTENCE = Object.freeze({
  PRESENT: "present",
  ABSENT: "absent",
  UNKNOWN: "unknown",
});

// [MEDIA-ID / STAGE-02B / REASON-MODEL]
//
// The closed vocabulary for WHY an existence question got the answer it got.
// One frozen object, owned by the module that owns EXISTENCE itself, so a
// reviewer can see the entire surface at a glance and so no caller has to
// invent a string.
//
// [WHY IT LIVES HERE AND NOT IN THE TELEMETRY MODULE: every code below names a
//  source of existence knowledge, which is this module's subject. Putting the
//  vocabulary in the aggregator would invert the dependency — the thing that
//  MAKES the decisions would have to import the thing that merely COUNTS them,
//  and fsa-existence.js would stop being a leaf.
//
//  Three codes are produced elsewhere (media-alias-index.js's resolver answers
//  from the census before any probe happens) and three are "unattributed" —
//  emitted when an injected oracle returns a bare status string with no reason,
//  which every Stage 02 test fixture legitimately does. They are named here
//  anyway so the vocabulary is ONE closed set and aggregation can never grow a
//  key nobody declared.
//
//  There is deliberately NO separate `security` code. The implementation cannot
//  reliably tell a SecurityError apart from any other exotic throw except by
//  reading error.name, which is carried as the bounded `detail` alongside
//  FILESYSTEM_ERROR. Inventing a distinction the code cannot make would be a
//  lie in a diagnostic whose whole job is to be trusted.]
export const EXISTENCE_REASON = Object.freeze({
  // ---- PRESENT ----------------------------------------------------------
  // Seen by the provider during THIS load's walk. Zero I/O.
  OBSERVED_CURRENT: "present/observed-current",
  // A durable MEDIA-ID row with origin="observed". Zero I/O.
  // [MEDIA-ID / STAGE-02 / BP-FAIL-02] fact-only rows can never reach this.
  OBSERVED_DURABLE: "present/observed-durable",
  // getFileHandle() resolved.
  PROBE_FOUND: "present/fsa-probe",
  UNATTRIBUTED_PRESENT: "present/unattributed",

  // ---- ABSENT -----------------------------------------------------------
  // Inside a COMPLETED walk's subtree and not in it. A census result.
  CENSUS: "absent/census",
  PROBE_NOT_FOUND: "absent/fsa-not-found",
  PROBE_TYPE_MISMATCH: "absent/fsa-type-mismatch",
  UNATTRIBUTED_ABSENT: "absent/unattributed",

  // ---- UNKNOWN (every one of these REFUSES) -----------------------------
  // No root in the scope has a prefix that covers this destination at all.
  NO_COVERING_ROOT: "unknown/no-covering-root",
  // A covering root exists but has no handle, or a handle without the FSA
  // lookup methods.
  NO_HANDLE: "unknown/no-handle",
  // The module kill switch is off.
  PROBING_DISABLED: "unknown/probing-disabled",
  // queryPermission() is not "granted". detail carries the state.
  PERMISSION: "unknown/permission",
  // A per-load ceiling was hit. detail is "file-probes" or "time".
  BUDGET: "unknown/budget",
  // Any throw that is not a deterministic negative. detail carries error.name.
  FILESYSTEM_ERROR: "unknown/filesystem-error",
  // Nothing to look up — the destination equals a root prefix exactly.
  EMPTY_PATH: "unknown/empty-path",
  UNATTRIBUTED_UNKNOWN: "unknown/unattributed",
});

/**
 * Per-load ceilings. Directory lookups are memoized and effectively free, so
 * the count budget applies to FILE lookups; the time budget applies to both.
 *
 * [WHY: bounded on purpose. Two genuinely mirrored trees (a real backup folder)
 *  would otherwise want one file probe per curated item. Exhausting the budget
 *  yields UNKNOWN, which REFUSES - so the escape hatch costs recall, never
 *  correctness. That is the approved trade: narrow the projection rather than
 *  accept a false positive.]
 */
export const DEFAULT_FILE_PROBE_BUDGET = 300;
export const DEFAULT_PROBE_MS_BUDGET = 400;

// Single kill switch, exactly like fsa-ancestry.js's. Flipping this to false
// makes every probe UNKNOWN, which degrades T1 to "refuse whenever the census
// cannot answer" - a supported mode, not a broken one.
let existenceEnabled = true;

export function setExistenceProbingEnabled(enabled) {
  existenceEnabled = Boolean(enabled);
}

export function isExistenceProbingAvailable(handle = null) {
  if (!existenceEnabled) return false;
  if (!handle) return false;
  return typeof handle.getDirectoryHandle === "function" && typeof handle.getFileHandle === "function";
}

// [WHY: the two error names that mean "deterministically not there", named in
//  one place so a reviewer can see the entire ABSENT surface at a glance. Any
//  future addition here widens what counts as proof and must be argued for on
//  its own.]
function isDeterministicAbsence(error) {
  const name = error && error.name ? error.name : "";
  return name === "NotFoundError" || name === "TypeMismatchError";
}

// [MEDIA-ID / STAGE-02B / REASON-MODEL]
// Classifies one thrown lookup. The STATUS half is byte-for-byte the Stage 02
// rule (isDeterministicAbsence and nothing else reaches ABSENT); only the
// reason half is new.
function classifyLookupError(error) {
  const name = error && error.name ? error.name : "";
  if (name === "NotFoundError") {
    return { status: EXISTENCE.ABSENT, reason: EXISTENCE_REASON.PROBE_NOT_FOUND, detail: null };
  }
  if (name === "TypeMismatchError") {
    return { status: EXISTENCE.ABSENT, reason: EXISTENCE_REASON.PROBE_TYPE_MISMATCH, detail: null };
  }
  return {
    status: EXISTENCE.UNKNOWN,
    reason: EXISTENCE_REASON.FILESYSTEM_ERROR,
    detail: name || "unknown",
  };
}

function splitPath(relativePath) {
  return String(relativePath || "")
    .split("/")
    .filter((segment) => segment.length > 0);
}

/**
 * Creates one load's prober. Never throws. Never mutates anything. Never
 * requests permission.
 *
 * `probe(rootId, rootHandle, relativePath)` answers whether `relativePath`
 * exists as a FILE under `rootHandle`, as one of EXISTENCE's three states.
 *
 * The prober is deliberately per-load and is never persisted:
 * [WHY: a durable ABSENT cache would be a false positive waiting to happen -
 *  the user adds the competing file, nothing invalidates the row, and T1
 *  projects onto the wrong media forever. Existence is re-proven every load,
 *  which is cheap precisely because the census (see media-alias-index.js)
 *  answers most of it with no I/O at all.]
 */
export function createExistenceProber({
  fileProbeBudget = DEFAULT_FILE_PROBE_BUDGET,
  msBudget = DEFAULT_PROBE_MS_BUDGET,
  now = () => Date.now(),
} = {}) {
  // "rootId<SEP>a/b/" -> { status, handle }
  const directories = new Map();
  // rootId -> "granted" | anything else
  const permissions = new Map();
  const startedAt = now();

  const stats = {
    fileProbes: 0,
    directoryProbes: 0,
    permissionChecks: 0,
    cacheHits: 0,
    budgetExhausted: false,
    get elapsedMs() {
      return now() - startedAt;
    },
  };

  function outOfTime() {
    if (now() - startedAt >= msBudget) {
      stats.budgetExhausted = true;
      return true;
    }
    return false;
  }

  async function permissionFor(rootId, rootHandle) {
    if (permissions.has(rootId)) return permissions.get(rootId);
    let state = "unavailable";
    if (rootHandle && typeof rootHandle.queryPermission === "function") {
      stats.permissionChecks += 1;
      try {
        state = await rootHandle.queryPermission({ mode: "read" });
      } catch (error) {
        state = `error:${error && error.name ? error.name : "unknown"}`;
      }
    }
    permissions.set(rootId, state);
    return state;
  }

  /**
   * Resolves one directory chain, memoized per segment. Returns
   * { status, handle, reason, detail }. An ABSENT ancestor short-circuits every
   * descendant without further I/O.
   *
   * [MEDIA-ID / STAGE-02B / REASON-MODEL]
   * [WHY THE REASON IS CACHED TOO: the memo is what makes a doubled prefix cost
   *  one probe instead of several hundred, and a cached answer that lost its
   *  reason would report every one of those descendants as unattributed. The
   *  reason is produced at the same instant as the status and costs one field.]
   */
  async function directoryAt(rootId, rootHandle, segments) {
    let handle = rootHandle;
    let walked = "";

    for (const segment of segments) {
      walked += `${segment}/`;
      const cacheKey = `${rootId}::${walked}`;
      const cached = directories.get(cacheKey);
      if (cached) {
        stats.cacheHits += 1;
        if (cached.status !== EXISTENCE.PRESENT) {
          return { status: cached.status, handle: null, reason: cached.reason, detail: cached.detail };
        }
        handle = cached.handle;
        continue;
      }

      if (outOfTime()) {
        const timedOut = {
          status: EXISTENCE.UNKNOWN,
          handle: null,
          reason: EXISTENCE_REASON.BUDGET,
          detail: "time",
        };
        directories.set(cacheKey, timedOut);
        return { ...timedOut };
      }

      let next = null;
      let status = EXISTENCE.UNKNOWN;
      let reason = null;
      let detail = null;
      stats.directoryProbes += 1;
      try {
        next = await handle.getDirectoryHandle(segment);
        status = EXISTENCE.PRESENT;
      } catch (error) {
        const classified = classifyLookupError(error);
        status = classified.status;
        reason = classified.reason;
        detail = classified.detail;
      }

      directories.set(cacheKey, {
        status,
        handle: status === EXISTENCE.PRESENT ? next : null,
        reason,
        detail,
      });
      if (status !== EXISTENCE.PRESENT) return { status, handle: null, reason, detail };
      handle = next;
    }

    return { status: EXISTENCE.PRESENT, handle, reason: null, detail: null };
  }

  // [MEDIA-ID / STAGE-02B / REASON-MODEL]
  //
  // The full-fidelity probe: { status, reason, detail }. Every early return
  // below is one of Stage 02's existing refusal paths — not one has been added,
  // removed or reordered, and the STATUS this returns is identical to what
  // Stage 02 returned at the same point. Only the reason is new.
  //
  // [WHY A SECOND ENTRY POINT RATHER THAN A WIDER `probe`: probe() is called by
  //  the resolver and asserted by fifty existence assertions that compare it to
  //  a bare EXISTENCE string. Changing its return type to answer a telemetry
  //  question would make every one of those tests prove something weaker than
  //  it proves today. probe() is now a projection of probeDetailed(), so the two
  //  cannot drift.]
  async function probeDetailed(rootId, rootHandle, relativePath) {
    if (!existenceEnabled) {
      return { status: EXISTENCE.UNKNOWN, reason: EXISTENCE_REASON.PROBING_DISABLED, detail: null };
    }
    if (!rootId || !isExistenceProbingAvailable(rootHandle)) {
      return { status: EXISTENCE.UNKNOWN, reason: EXISTENCE_REASON.NO_HANDLE, detail: null };
    }

    const segments = splitPath(relativePath);
    if (!segments.length) {
      return { status: EXISTENCE.UNKNOWN, reason: EXISTENCE_REASON.EMPTY_PATH, detail: null };
    }

    const permission = await permissionFor(rootId, rootHandle);
    // Not "granted" is NOT absence. It is no information, and it refuses.
    if (permission !== "granted") {
      return { status: EXISTENCE.UNKNOWN, reason: EXISTENCE_REASON.PERMISSION, detail: permission };
    }

    const fileName = segments[segments.length - 1];
    const parent = await directoryAt(rootId, rootHandle, segments.slice(0, -1));
    if (parent.status !== EXISTENCE.PRESENT) {
      return { status: parent.status, reason: parent.reason, detail: parent.detail };
    }

    if (stats.fileProbes >= fileProbeBudget) {
      stats.budgetExhausted = true;
      return { status: EXISTENCE.UNKNOWN, reason: EXISTENCE_REASON.BUDGET, detail: "file-probes" };
    }
    if (outOfTime()) {
      return { status: EXISTENCE.UNKNOWN, reason: EXISTENCE_REASON.BUDGET, detail: "time" };
    }

    stats.fileProbes += 1;
    try {
      await parent.handle.getFileHandle(fileName);
      return { status: EXISTENCE.PRESENT, reason: EXISTENCE_REASON.PROBE_FOUND, detail: null };
    } catch (error) {
      return classifyLookupError(error);
    }
  }

  async function probe(rootId, rootHandle, relativePath) {
    return (await probeDetailed(rootId, rootHandle, relativePath)).status;
  }

  return { probe, probeDetailed, stats };
}

export const __TEST__ = { isDeterministicAbsence, classifyLookupError, splitPath };
