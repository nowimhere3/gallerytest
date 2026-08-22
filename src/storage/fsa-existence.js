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
   * { status, handle }. An ABSENT ancestor short-circuits every descendant
   * without further I/O.
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
        if (cached.status !== EXISTENCE.PRESENT) return { status: cached.status, handle: null };
        handle = cached.handle;
        continue;
      }

      if (outOfTime()) {
        directories.set(cacheKey, { status: EXISTENCE.UNKNOWN, handle: null });
        return { status: EXISTENCE.UNKNOWN, handle: null };
      }

      let next = null;
      let status = EXISTENCE.UNKNOWN;
      stats.directoryProbes += 1;
      try {
        next = await handle.getDirectoryHandle(segment);
        status = EXISTENCE.PRESENT;
      } catch (error) {
        status = isDeterministicAbsence(error) ? EXISTENCE.ABSENT : EXISTENCE.UNKNOWN;
      }

      directories.set(cacheKey, { status, handle: status === EXISTENCE.PRESENT ? next : null });
      if (status !== EXISTENCE.PRESENT) return { status, handle: null };
      handle = next;
    }

    return { status: EXISTENCE.PRESENT, handle };
  }

  async function probe(rootId, rootHandle, relativePath) {
    if (!existenceEnabled) return EXISTENCE.UNKNOWN;
    if (!rootId || !isExistenceProbingAvailable(rootHandle)) return EXISTENCE.UNKNOWN;

    const segments = splitPath(relativePath);
    if (!segments.length) return EXISTENCE.UNKNOWN;

    const permission = await permissionFor(rootId, rootHandle);
    // Not "granted" is NOT absence. It is no information, and it refuses.
    if (permission !== "granted") return EXISTENCE.UNKNOWN;

    const fileName = segments[segments.length - 1];
    const parent = await directoryAt(rootId, rootHandle, segments.slice(0, -1));
    if (parent.status !== EXISTENCE.PRESENT) return parent.status;

    if (stats.fileProbes >= fileProbeBudget) {
      stats.budgetExhausted = true;
      return EXISTENCE.UNKNOWN;
    }
    if (outOfTime()) return EXISTENCE.UNKNOWN;

    stats.fileProbes += 1;
    try {
      await parent.handle.getFileHandle(fileName);
      return EXISTENCE.PRESENT;
    } catch (error) {
      return isDeterministicAbsence(error) ? EXISTENCE.ABSENT : EXISTENCE.UNKNOWN;
    }
  }

  return { probe, stats };
}

export const __TEST__ = { isDeterministicAbsence, splitPath };
