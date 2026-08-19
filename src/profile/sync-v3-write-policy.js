// [SYNCV3 / STAGE-03A / V3-ASSOCIATION-ISOLATION-AND-PASS-SKELETON]
// [WHY: THE single seam that decides whether this tab, right now, is allowed to
//  write V3 state to Drive. It is a whole module rather than a boolean buried in
//  the pass because Stage 03B has to replace exactly one thing, and a reviewer
//  has to be able to see, in one file, every reason a write can be refused.
//
//  The reason it must exist BEFORE writer coordination is built: two or three
//  Browser Gallery tabs on one origin share a deviceId, and therefore share a
//  device directory under sync-v3/devices/. That breaks the one-writer-per-device
//  discipline the whole transport rests on - not subtly, but in the worst way
//  available: each tab's publish would delete the other's stale files (the
//  cleanup pass legitimately believes that directory is its own), and a third
//  device reading in between would see a half-built generation. Nothing in the
//  transport can detect this, because the transport correctly cannot see tabs.]
//
// WHAT: mayPublishV3() - the one write-eligibility decision, and the kill switch
// that keeps it answering "no" until same-device writer ownership exists.
//
// FUTURE / DO-NOT-BREAK: this is the function Stage 03B replaces the body of.
// Keep it the ONLY place that can authorize a V3 write. If a second answer to
// "may I write?" ever appears anywhere, the coordination Stage 03B builds is
// already bypassed.

/**
 * Master switch for live V3 Drive writes.
 *
 * [SYNCV3 / STAGE-03A / V3-ASSOCIATION-ISOLATION-AND-PASS-SKELETON]
 * [WHY: false, deliberately, and NOT hidden behind a condition that could be
 *  satisfied accidentally. While this is false a V3 installation reads and
 *  merges normally but cannot create a directory, cannot publish, and cannot be
 *  provoked into either by polling, a Sync Now, or a Profile edit - so ordinary
 *  Browser Gallery use leaves the configured V3 Drive folder byte-for-byte
 *  unchanged. Stage 03B flips this once it can answer "is this tab the writer?".]
 */
export const V3_LIVE_WRITES_ENABLED = false;

/** Why a write was refused. Reported in pass results so a status surface can be truthful. */
export const WRITE_BLOCKED_LIVE_WRITES_DISABLED = "live-writes-disabled";

/**
 * Decides whether the caller may write V3 state to Drive in this pass.
 *
 * Returns { allowed: boolean, reason: string|null }.
 *
 * `context` carries { deviceId } today. Stage 03B may need more (a tab id, a
 * lease deadline); adding fields here is expected and requires no change at the
 * single call site, which passes the whole context through.
 *
 * [SYNCV3 / STAGE-03A / V3-ASSOCIATION-ISOLATION-AND-PASS-SKELETON]
 * [WHY: async, and answering a REASON rather than a bare boolean, even though
 *  today's answer is a constant. Both are for Stage 03B's benefit: acquiring a
 *  lock or a lease is asynchronous, and a refusal a tab must be able to explain
 *  ("another tab holds the writer lease") is the difference between a status
 *  surface that stays truthful and one that reports a silent no-op as success.
 *  Making the signature right now means Stage 03B changes a body, not a
 *  call chain.]
 */
export async function mayPublishV3(context = {}) {
  if (!V3_LIVE_WRITES_ENABLED) {
    return { allowed: false, reason: WRITE_BLOCKED_LIVE_WRITES_DISABLED };
  }

  // [SYNCV3 / STAGE-03A / V3-ASSOCIATION-ISOLATION-AND-PASS-SKELETON]
  // [WHY: unreachable while the switch above is false, and that is the point -
  //  the shape Stage 03B fills in is already here, so enabling live writes is a
  //  change to this function and nothing else. A device with no identity can
  //  never be allowed to write: it would publish under an id that does not
  //  survive a reload, orphaning the directory on the very next boot.]
  if (!context.deviceId) {
    return { allowed: false, reason: "no-device-identity" };
  }

  return { allowed: true, reason: null };
}
