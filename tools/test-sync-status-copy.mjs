import { mapSyncStatusCopy } from "../src/profile/sync-status-copy.js";

let assertions = 0;

function assertCopy(name, status, line, tone) {
  const snapshot = structuredClone(status);
  const actual = mapSyncStatusCopy(status);
  if (actual.line !== line || actual.tone !== tone) {
    throw new Error(`${name}: expected ${JSON.stringify({ line, tone })}, got ${JSON.stringify(actual)}`);
  }
  if (JSON.stringify(status) !== JSON.stringify(snapshot)) throw new Error(`${name}: mutated its input`);
  assertions += 2;
}

// [SYNCV3 / STAGE-06 / STATUS-COPY]
assertCopy("V3 not configured", { mode: "v3", v3Configured: false, v3Status: "not-configured" }, "Not syncing — no sync folder chosen", "muted");
assertCopy("V3 permission needed", { mode: "v3", v3Configured: true, v3Status: "permission-needed", status: "v3-permission-needed" }, "Sync folder needs permission again", "warning");
assertCopy("writing", { mode: "v3", v3Configured: true, v3Status: "ready", status: "syncing" }, "Syncing — saving changes", "active");
assertCopy("V3 ready writer", { mode: "v3", v3Configured: true, v3Status: "ready", status: "v3-ready", v3IsWriter: true }, "Syncing — up to date", "success");
assertCopy("V3 ready reader", { mode: "v3", v3Configured: true, v3Status: "ready", status: "v3-ready", v3IsWriter: false }, "Syncing — up to date", "success");
assertCopy("peers singular", { mode: "v3", v3Configured: true, v3Status: "ready", status: "v3-ready", v3MergedPeers: 1 }, "Syncing — up to date · Sharing with 1 other device", "success");
assertCopy("peers plural", { mode: "v3", v3Configured: true, v3Status: "ready", status: "v3-ready", v3MergedPeers: 2 }, "Syncing — up to date · Sharing with 2 other devices", "success");
assertCopy("one skipped peer", { mode: "v3", v3Configured: true, v3Status: "ready", status: "v3-ready", v3SkippedPeers: [{}] }, "Syncing — up to date · one device is still catching up", "success");
assertCopy("multiple skipped peers", { mode: "v3", v3Configured: true, v3Status: "ready", status: "v3-ready", v3SkippedPeers: [{}, {}] }, "Syncing — up to date · 2 devices are still catching up", "success");
assertCopy("publish blocked", { mode: "v3", v3Configured: true, v3Status: "ready", status: "v3-ready", v3PublishBlocked: "writer-lease-held-by-another-tab" }, "Syncing — reading only right now", "warning");
for (const status of ["offline", "v3-verify-failed"]) {
  assertCopy(`V3 failure ${status}`, { mode: "v3", v3Configured: true, v3Status: "ready", status }, "Sync had a problem — changes aren't being shared", "danger");
}
assertCopy("legacy not configured", { mode: "v1", configured: false, status: "not-configured" }, "Not syncing — no sync folder chosen", "muted");
assertCopy("legacy permission needed", { mode: "v2", configured: true, status: "permission-needed" }, "Sync folder needs permission again", "warning");
assertCopy("legacy checking", { mode: "v2", configured: true, status: "checking" }, "Syncing — checking for changes", "active");
assertCopy("legacy ready", { mode: "v2", configured: true, status: "connected" }, "Syncing — up to date", "success");
for (const status of ["offline", "verify-failed", "conflict", "migration-failed"]) {
  assertCopy(`legacy failure ${status}`, { mode: status === "migration-failed" ? "failed" : "v1", configured: true, status }, "Sync had a problem — changes aren't being shared", "danger");
}

// [SYNCV3 / STAGE-10 / CHANGE-SYNC-FOLDER-FIX]
// Regression for a reported defect: "Change Sync Folder does nothing."
// Connecting a V3 Sync Folder is allowed BEFORE activating V3 (see
// profile-sync.js #refreshV3Connection's own note), and the default mode is v1.
// In that state v3Configured is true while `configured`/`status` still describe
// the untouched V1 transport, so this mapper used to fall through to
// "Not syncing — no sync folder chosen" — the primary Sync group would say no
// folder was chosen while its own button said "Change Sync Folder", and running
// the whole picker changed not one visible character.
assertCopy("V3 folder connected before activation",
  { mode: "v1", configured: false, status: "not-configured", v3Configured: true, v3Status: "ready", v3FolderName: "Browser Gallery Sync" },
  'Sync Folder "Browser Gallery Sync" chosen — not syncing yet', "active");
assertCopy("V3 folder connected before activation, under v2",
  { mode: "v2", configured: false, status: "not-configured", v3Configured: true, v3Status: "ready", v3FolderName: "BG Sync" },
  'Sync Folder "BG Sync" chosen — not syncing yet', "active");
assertCopy("unactivated V3 folder needing permission",
  { mode: "v1", configured: false, status: "not-configured", v3Configured: true, v3Status: "permission-needed", v3FolderName: "BG Sync" },
  "Sync folder needs permission again", "warning");
// A real V1/V2 sync still running must keep describing itself, not be
// overwritten by a V3 folder that is merely connected.
assertCopy("live V2 sync outranks a merely-connected V3 folder",
  { mode: "v2", configured: true, status: "connected", v3Configured: true, v3Status: "ready", v3FolderName: "BG Sync" },
  "Syncing — up to date", "success");
// Nothing chosen anywhere is still the muted absence it always was.
assertCopy("no folder anywhere", { mode: "v1", configured: false, status: "not-configured", v3Configured: false },
  "Not syncing — no sync folder chosen", "muted");

// The folder name is what makes "Change Sync Folder" observable: without it the
// line is identical before and after a successful change.
const before = mapSyncStatusCopy({ mode: "v3", v3Configured: true, v3Status: "ready", status: "v3-ready", v3FolderName: "Old Folder" });
const after = mapSyncStatusCopy({ mode: "v3", v3Configured: true, v3Status: "ready", status: "v3-ready", v3FolderName: "New Folder" });
if (before.line === after.line) throw new Error("changing the Sync Folder must change the visible status line");
assertions += 1;
assertCopy("active V3 names its folder",
  { mode: "v3", v3Configured: true, v3Status: "ready", status: "v3-ready", v3FolderName: "Browser Gallery Sync" },
  'Syncing — up to date · Browser Gallery Sync', "success");
assertCopy("folder name sits before the peer suffix",
  { mode: "v3", v3Configured: true, v3Status: "ready", status: "v3-ready", v3FolderName: "BG Sync", v3MergedPeers: 2 },
  "Syncing — up to date · BG Sync · Sharing with 2 other devices", "success");
// A missing name must never render an empty separator.
assertCopy("no folder name renders no separator",
  { mode: "v3", v3Configured: true, v3Status: "ready", status: "v3-ready", v3FolderName: "   " },
  "Syncing — up to date", "success");

console.log(`sync status copy: ${assertions} assertions passed`);
