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

// [SYNCV3 / STAGE-10 / CHANGE-SYNC-FOLDER-FIX]
// [WHY: naming the folder is what makes "Change Sync Folder" observable. Without
// it the primary line is byte-identical before and after a successful change,
// which is precisely how the control came to look broken.]
function folderSuffix(name) {
  const trimmed = typeof name === "string" ? name.trim() : "";
  return trimmed ? ` · ${trimmed}` : "";
}

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

    const suffix = folderSuffix(status.v3FolderName) + peerSuffix(status.v3MergedPeers, status.v3SkippedPeers);
    if (status.v3PublishBlocked) {
      return { line: `Syncing — reading only right now${suffix}`, tone: "warning" };
    }
    if (status.v3Status === "ready" && status.status === "v3-ready") {
      return { line: `Syncing — up to date${suffix}`, tone: "success" };
    }

    return { line: "Sync had a problem — changes aren't being shared", tone: "danger" };
  }

  // [SYNCV3 / STAGE-10 / CHANGE-SYNC-FOLDER-FIX]
  //
  // BREADCRUMBS — IS: a V3 Sync Folder may be connected while V3 is NOT yet the
  //   active transport — profile-sync.js #refreshV3Connection deliberately
  //   leaves #status describing the V1/V2 transport in that case, and the
  //   default mode is v1. This branch is what keeps the PRIMARY Sync group
  //   honest about a folder the reader can plainly see they just chose.
  // BREADCRUMBS — WAS: `v3Configured` was consulted only inside the mode ===
  //   "v3" branch above. Under the default mode the primary line therefore read
  //   "Not syncing — no sync folder chosen" while the button beside it read
  //   "Change Sync Folder", and running the whole picker changed nothing
  //   visible. That is the defect this branch fixes.
  // BREADCRUMBS — FUTURE: this reports a CHOSEN folder, never a syncing one.
  //   A merely-connected V3 folder must never claim to be syncing, and it must
  //   never outrank a V1/V2 sync that is genuinely running — hence the position
  //   of this block, after the live-transport checks below would have matched.
  const v3FolderOnly = Boolean(status.v3Configured) && !status.configured;
  if (v3FolderOnly && status.v3Status === "permission-needed") {
    return { line: "Sync folder needs permission again", tone: "warning" };
  }
  if (v3FolderOnly) {
    const name = typeof status.v3FolderName === "string" ? status.v3FolderName.trim() : "";
    return {
      line: name ? `Sync Folder "${name}" chosen — not syncing yet` : "Sync Folder chosen — not syncing yet",
      tone: "active",
    };
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
