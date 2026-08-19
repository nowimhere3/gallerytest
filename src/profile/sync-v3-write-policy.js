// [SYNCV3 / STAGE-03A / V3-ASSOCIATION-ISOLATION-AND-PASS-SKELETON]
// [WHY: THE single seam that decides whether this tab, right now, is allowed to
//  write V3 state to Drive. It is a whole module rather than a boolean buried in
//  the pass because a reviewer has to be able to see, in one file, every reason
//  a write can be refused.]
//
// [SYNCV3 / STAGE-03B / SAME-DEVICE-WRITER-COORDINATION]
// [WHY: the decision is now a LEASE rather than a question, and the difference
//  is the whole stage. "May I write?" answered as a boolean is a race: the
//  answer is already stale by the time the caller acts on it, and two tabs can
//  both be told yes microseconds apart. A lease that is HELD for the duration of
//  the write phase cannot be raced, because the thing granting permission is the
//  same thing preventing anyone else from holding it.
//
//  The hazard being closed: two or three Browser Gallery tabs on one origin
//  share a deviceId, and therefore share one directory under sync-v3/devices/.
//  Each tab's publish runs cleanupOwnProfileFiles and cleanupOwnStaleDirectories
//  against that directory, and each is CORRECT to believe the directory is its
//  own - so concurrent passes delete each other's files, and any third device
//  reading in between sees a half-built generation. The transport cannot detect
//  this and should not try: it correctly cannot see tabs. Coordination belongs
//  exactly here, one level above it.]
//
// WHAT: withV3WriterLease() - acquire-hold-release around the write phase, and
// the named reasons a lease can be refused.
//
// FUTURE / DO-NOT-BREAK: keep this the ONLY place that can authorize a V3 write.
// A second answer to "may I write?" anywhere else bypasses the coordination
// entirely, and the resulting corruption is silent.

/**
 * Master switch for live V3 Drive writes.
 *
 * [SYNCV3 / STAGE-03B / SAME-DEVICE-WRITER-COORDINATION]
 * [WHY: true as of this stage. It was false for exactly as long as
 *  same-device writer ownership was unproven, which is the condition it was
 *  introduced to represent - not a general-purpose feature flag. Kept rather
 *  than deleted because it is the one line to change if live writes ever need
 *  to be stopped without unpicking the lease machinery.]
 */
export const V3_LIVE_WRITES_ENABLED = true;

/** Lock-name prefix. The FULL deviceId is appended - never a display id or a folder name. */
export const WRITER_LOCK_PREFIX = "syncv3-writer:";

export const WRITE_BLOCKED_LIVE_WRITES_DISABLED = "live-writes-disabled";
export const WRITE_BLOCKED_NO_DEVICE_IDENTITY = "no-device-identity";
export const WRITE_BLOCKED_NO_WEB_LOCKS = "web-locks-unavailable";
export const WRITE_BLOCKED_LEASE_HELD_ELSEWHERE = "writer-lease-held-by-another-tab";

/**
 * The lock name for one installation.
 *
 * [SYNCV3 / STAGE-03B / SAME-DEVICE-WRITER-COORDINATION]
 * [WHY: keyed on the FULL deviceId and nothing else. A human device name is
 *  editable and two machines may share one; a short display id is lossy by
 *  construction; a directory name is presentation. Any of the three would let
 *  two genuinely different installations contend for one lock (harmless but
 *  wrong) or - far worse - let two tabs of the SAME installation pick different
 *  lock names and both believe they are the writer, which is the exact failure
 *  this lock exists to prevent. Web Locks are per-origin, so the deviceId also
 *  correctly scopes the lock to the installation rather than to the browser.]
 */
export function writerLockName(deviceId) {
  return `${WRITER_LOCK_PREFIX}${deviceId}`;
}

/** The real Web Locks manager, or null where the API does not exist. */
function resolveLockManager() {
  try {
    if (typeof navigator !== "undefined" && navigator && navigator.locks) return navigator.locks;
  } catch {
    // Touching navigator can throw in exotic embeddings; treated as absent.
  }
  return null;
}

/**
 * Creates this tab's SUSTAINED writer lease for one installation.
 *
 * [SYNCV3 / STAGE-03B-FIX / DUAL-WRITER-DIAGNOSIS]
 * [WHY: the previous shape acquired the lock inside each pass and released it on
 *  the way out. That is mutual exclusion WITHIN a pass, which is not the same
 *  thing as a writer ROLE - and the difference is invisible in a test that runs
 *  two passes at once and fatal in production, where they never overlap. A pass
 *  takes milliseconds; the cadence is three seconds. Two tabs therefore never
 *  contended, both were granted the lease every time, and both published - each
 *  overwriting the other's generation with its own in-memory view. Measured
 *  directly: after three alternating rounds the published subtree contained one
 *  tab's changes and had lost the other's.
 *
 *  So the lease is now HELD ACROSS PASSES, for the lifetime of the tab. Exactly
 *  one tab can hold it, that tab writes on every pass, and the others read. The
 *  browser releases it when the tab closes or crashes, so the role transfers
 *  with no heartbeat, no timeout and no stale-lease recovery to get wrong.
 *
 *  Deliberately NOT released when a pass fails: a transient Drive error must not
 *  hand the writer role to a different tab, because handing it over is precisely
 *  what produces the alternating-publish churn this fix removes.]
 *
 * `locks` is injectable so the algorithm is testable without a browser. It
 * defaults to the real Web Locks manager, so no caller can opt out of
 * coordination by omitting it.
 */
export function createV3WriterLease({ deviceId, locks = resolveLockManager() } = {}) {
  let held = false;
  let releaseHeld = null;
  let pending = null;

  const lockName = deviceId ? writerLockName(deviceId) : null;

  function acquire() {
    let settleOutcome;
    const outcome = new Promise((resolve) => {
      settleOutcome = resolve;
    });

    // [SYNCV3 / STAGE-03B-FIX / DUAL-WRITER-DIAGNOSIS]
    // [WHY: the callback returns a promise that stays pending for as long as this
    //  tab should remain the writer. That is what keeps the Web Lock held between
    //  passes - the browser holds a lock exactly as long as the callback's
    //  promise is unsettled. Returning undefined (as the per-pass version
    //  effectively did) releases it immediately, which was the bug.]
    const holding = locks.request(lockName, { ifAvailable: true }, (lock) => {
      if (!lock) {
        settleOutcome({ allowed: false, reason: WRITE_BLOCKED_LEASE_HELD_ELSEWHERE, lockName });
        return undefined; // another tab holds it; do not queue behind them
      }
      held = true;
      settleOutcome({ allowed: true, reason: null, lockName });
      return new Promise((resolve) => {
        releaseHeld = resolve;
      });
    });

    holding.then(
      () => {
        held = false;
        releaseHeld = null;
      },
      (error) => {
        held = false;
        releaseHeld = null;
        console.warn("[SYNCV3] Could not request the writer lease; running read-only.", error);
        // A no-op if the outcome already settled.
        settleOutcome({ allowed: false, reason: WRITE_BLOCKED_NO_WEB_LOCKS, lockName });
      }
    );

    return outcome;
  }

  return {
    /** True while this tab currently owns the writer role. */
    get held() {
      return held;
    },

    get lockName() {
      return lockName;
    },

    /**
     * Ensures this tab holds the lease if it can, and reports the outcome.
     * Called once per pass: a reader retries on every pass, which is how the
     * role transfers after the writer tab closes.
     */
    async ensure() {
      if (!V3_LIVE_WRITES_ENABLED) return { allowed: false, reason: WRITE_BLOCKED_LIVE_WRITES_DISABLED, lockName: null };
      if (!deviceId) return { allowed: false, reason: WRITE_BLOCKED_NO_DEVICE_IDENTITY, lockName: null };
      if (!locks || typeof locks.request !== "function") {
        return { allowed: false, reason: WRITE_BLOCKED_NO_WEB_LOCKS, lockName };
      }
      if (held) return { allowed: true, reason: null, lockName };

      // Coalesced: two passes overlapping on one tab must not race to acquire.
      if (!pending) {
        pending = acquire().finally(() => {
          pending = null;
        });
      }
      return pending;
    },

    /**
     * Gives up the writer role.
     *
     * [SYNCV3 / STAGE-03B-FIX / DUAL-WRITER-DIAGNOSIS]
     * [WHY: called on dispose, on leaving V3 mode, and on disconnecting the V3
     *  folder - every path by which this tab stops being a V3 writer while the
     *  page stays open. Without it the lock would survive until the tab closed,
     *  and a user who simply switched back to V2 would keep the whole
     *  installation's writer role hostage.]
     */
    release() {
      const resolve = releaseHeld;
      releaseHeld = null;
      held = false;
      if (resolve) resolve();
    },
  };
}
