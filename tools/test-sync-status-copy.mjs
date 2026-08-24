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

console.log(`sync status copy: ${assertions} assertions passed`);
