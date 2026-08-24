// [SYNCV3 / STAGE-06 / STATUS-COPY]
// [WHY: keep product language derived from one immutable status snapshot,
// without coupling presentation decisions to ProfileSync or the DOM.]

const FAILURE_STATUSES = new Set([
  "conflict",
  "migration-failed",
  "offline",
  "verify-failed",
  "v3-verify-failed",
]);

function peerSuffix(mergedPeers, skippedPeers) {
  const shared = Number.isFinite(mergedPeers) ? Math.max(0, Math.trunc(mergedPeers)) : 0;
  const pending = Array.isArray(skippedPeers) ? skippedPeers.length : 0;
  let suffix = "";

  if (shared > 0) suffix += ` · Sharing with ${shared} other ${shared === 1 ? "device" : "devices"}`;
  if (pending > 0) suffix += ` · ${pending === 1 ? "one device is" : `${pending} devices are`} still catching up`;

  return suffix;
}

/**
 * Maps one ProfileSync.getStatus() snapshot to non-diagnostic product copy.
 * The input is read only and no external state is consulted.
 */
export function mapSyncStatusCopy(status = {}) {
  const mode = status.mode;

  if (mode === "v3") {
    if (!status.v3Configured || status.v3Status === "not-configured") {
      return { line: "Not syncing — no sync folder chosen", tone: "muted" };
    }
    if (status.v3Status === "permission-needed" || status.status === "v3-permission-needed") {
      return { line: "Sync folder needs permission again", tone: "warning" };
    }
    if (FAILURE_STATUSES.has(status.status)) {
      return { line: "Sync had a problem — changes aren't being shared", tone: "danger" };
    }
    if (status.status === "syncing") {
      return { line: "Syncing — saving changes", tone: "active" };
    }

    const suffix = peerSuffix(status.v3MergedPeers, status.v3SkippedPeers);
    if (status.v3PublishBlocked) {
      return { line: `Syncing — reading only right now${suffix}`, tone: "warning" };
    }
    if (status.v3Status === "ready" && status.status === "v3-ready") {
      return { line: `Syncing — up to date${suffix}`, tone: "success" };
    }

    return { line: "Sync had a problem — changes aren't being shared", tone: "danger" };
  }

  if (!status.configured || status.status === "not-configured") {
    return { line: "Not syncing — no sync folder chosen", tone: "muted" };
  }
  if (status.status === "permission-needed") {
    return { line: "Sync folder needs permission again", tone: "warning" };
  }
  if (status.status === "syncing") {
    return { line: "Syncing — saving changes", tone: "active" };
  }
  if (FAILURE_STATUSES.has(status.status) || mode === "failed") {
    return { line: "Sync had a problem — changes aren't being shared", tone: "danger" };
  }
  if (status.status === "checking") {
    return { line: "Syncing — checking for changes", tone: "active" };
  }
  if ((mode === "v1" || mode === "v2") && status.status === "connected") {
    return { line: "Syncing — up to date", tone: "success" };
  }

  return { line: "Sync had a problem — changes aren't being shared", tone: "danger" };
}
