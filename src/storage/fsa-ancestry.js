// [MEDIA-ID / STAGE-01 / FSA-ANCESTRY]
//
// The ONLY place in this codebase that calls
// FileSystemDirectoryHandle.prototype.resolve(). Everything else asks this
// module, so the one browser API MEDIA-ID depends on lives behind a single
// seam that can be feature-detected, disabled, or replaced without touching
// the matcher, the store, or the load path.
//
// ---- Why the four-state contract ----------------------------------------
//
// [WHY: resolve() has THREE observable outcomes and they must never be
//  collapsed into two. A segment array is PROOF of ancestry. A literal null is
//  PROOF of non-ancestry. A throw — or a missing API, or a handle we do not
//  have — is NO INFORMATION AT ALL, and the difference is load-bearing.
//
//  Stage 00B's real-browser probe (Chrome 150 / ChromeOS) proved the positive
//  and negative cases, including against a genuinely persisted registry handle
//  and across a normal page reload, and proved resolve() does not mutate
//  permission state. It did NOT prove behaviour while a persisted handle sits
//  at permission state "prompt", because permission was granted throughout.
//
//  If "unknown" were ever folded into "unrelated", a permission-blocked master
//  would be read as PROOF that a real descendant is unrelated — the scope join
//  would be skipped, fresh identity would be minted, and the user's curation
//  would be silently stranded. Keeping "unknown" as its own state is what makes
//  the unproven case safe: it declines to conclude anything, rather than
//  concluding the wrong thing.]
//
// Nothing here requests permission. queryPermission() only, matching the
// discipline already stated in main.js's read-only audit block. The permission
// state is recorded alongside each outcome so ordinary use answers the
// still-open "does resolve() work at prompt?" question empirically, locally,
// without ever making the answer load-bearing.

export const ANCESTRY = {
  SELF: "self",
  DESCENDANT: "descendant",
  UNRELATED: "unrelated",
  UNKNOWN: "unknown",
};

// Single kill switch. Flipping this to false degrades MEDIA-ID to the
// structural path everywhere, which is exactly the Legacy provider's
// permanent situation — a supported mode, not a broken one.
let ancestryEnabled = true;

export function setAncestryEnabled(enabled) {
  ancestryEnabled = Boolean(enabled);
}

// [WHY: checked against the HANDLE where one is available, not against a global
//  prototype. The global is absent in non-browser contexts, and treating that
//  absence as "ancestry is unavailable" would silently disable the one
//  deterministic mechanism this track has wherever the check is wrong rather
//  than wherever the API is missing. probeAncestry re-checks per call anyway and
//  degrades to UNKNOWN, so this is a fast path, never the safety boundary.]
export function isAncestryAvailable(handle = null) {
  if (!ancestryEnabled) return false;
  if (handle) return typeof handle.resolve === "function";
  const proto = typeof FileSystemDirectoryHandle !== "undefined" ? FileSystemDirectoryHandle.prototype : null;
  if (proto) return typeof proto.resolve === "function";
  return true;
}

// queryPermission ONLY. Never requestPermission — that needs a user gesture,
// and silently touching folder access from a background evidence pass is
// exactly the kind of surprise this project has repeatedly refused.
async function readPermission(handle) {
  if (!handle || typeof handle.queryPermission !== "function") return "unavailable";
  try {
    return await handle.queryPermission({ mode: "read" });
  } catch (error) {
    return `error:${error && error.name ? error.name : "unknown"}`;
  }
}

function unknown(reason, permissionState = "unavailable") {
  return { relation: ANCESTRY.UNKNOWN, segments: null, prefix: null, permissionState, reason };
}

/**
 * Asks whether `candidateHandle` sits inside `ancestorHandle`.
 *
 * Returns { relation, segments, prefix, permissionState, reason }:
 *   relation "self"       — the same directory. segments [], prefix "".
 *   relation "descendant" — segments is the proven path from ancestor to
 *                           candidate; prefix is those segments joined with a
 *                           trailing slash, i.e. exactly what must be prepended
 *                           to a candidate-relative path to express it
 *                           ancestor-relatively.
 *   relation "unrelated"  — PROVEN not a descendant (resolve returned null).
 *   relation "unknown"    — no information. Callers must neither join nor
 *                           exclude on this. `reason` says why.
 *
 * Never throws. Never requests permission. Never mutates anything.
 */
export async function probeAncestry(ancestorHandle, candidateHandle) {
  if (!ancestryEnabled) return unknown("disabled");
  if (!ancestorHandle || !candidateHandle) return unknown("missing-handle");
  if (typeof ancestorHandle.resolve !== "function") return unknown("no-resolve-api");

  const permissionState = await readPermission(ancestorHandle);

  let segments;
  try {
    segments = await ancestorHandle.resolve(candidateHandle);
  } catch (error) {
    // The single most important line in this module. A throw is NOT a negative
    // result — it is the absence of a result. See the WHY at the top.
    return unknown(`threw:${error && error.name ? error.name : "unknown"}`, permissionState);
  }

  if (segments === null) {
    return { relation: ANCESTRY.UNRELATED, segments: null, prefix: null, permissionState, reason: null };
  }

  if (!Array.isArray(segments)) {
    // Spec violation. Treated as no information rather than guessed at.
    return unknown("non-array-result", permissionState);
  }

  if (segments.some((segment) => typeof segment !== "string" || !segment)) {
    return unknown("malformed-segments", permissionState);
  }

  if (segments.length === 0) {
    return { relation: ANCESTRY.SELF, segments: [], prefix: "", permissionState, reason: null };
  }

  return {
    relation: ANCESTRY.DESCENDANT,
    segments,
    // Trailing slash included so callers concatenate rather than re-join.
    // resolve() returns RELATIVE segments only — never an absolute or
    // host-derived path — which is what makes this privacy-safe by
    // construction rather than by filtering.
    prefix: `${segments.join("/")}/`,
    permissionState,
    reason: null,
  };
}
