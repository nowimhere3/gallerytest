// [PHASE-6-SYNC-V2]
// [STAGE-D2-TRANSPORT]
// [WHY: this is the ONE place the whole D2 lifecycle is sequenced, so the
//  order it runs in is the order the approved plan requires and nowhere else —
//  observing every peer before any new stamp is drawn, merging before
//  applying, applying before publishing, and verifying a publish before
//  cleanup or metadata acceptance. Scattering these steps across callers would
//  make it possible for a future change to reorder them without anyone
//  noticing the invariant that broke.]
//
// WHAT: runSyncV2Pass() — one complete reconcile pass: read every peer,
// validate independently, merge with local, adopt the result, and publish this
// device's own merged view if it changed.
//
// NOT WIRED INTO THE APP: nothing in main.js calls this yet. Per the approved
// controlled-hard-cutover policy, Sync V2 stays sandboxed until an
// installation is explicitly migrated — this module is exercised directly by
// tests and, eventually, by whatever Stage activates it, never automatically.

import * as MergeEngine from "./sync-merge.js";
import * as Transport from "./sync-v2-transport.js";

/**
 * Runs one Sync V2 reconcile pass against `dirHandle` for `profileStore`.
 *
 * Returns a plain result object; never throws for an ordinary sync failure
 * (permission, unreadable folder, verify-failed) — those are reported in
 * `status`. Only a genuinely unexpected error propagates.
 */
export async function runSyncV2Pass({ profileStore, dirHandle }) {
  let permission;
  try {
    permission = await dirHandle.queryPermission({ mode: "readwrite" });
  } catch (error) {
    return { status: "permission-needed", message: "The sync folder is no longer accessible." };
  }
  if (permission !== "granted") return { status: "permission-needed" };

  // Load local persisted facts — whatever D1 mutations have happened so far,
  // stamped and settled, before this pass reads or reasons about them.
  await profileStore.whenFactsSettled();

  const deviceId = profileStore.getDeviceId();
  if (!deviceId) return { status: "no-device-identity" };

  let root, devicesDir;
  try {
    root = await Transport.getSyncV2Root(dirHandle, { create: true });
    devicesDir = await Transport.getDevicesDir(root, { create: true });
  } catch (error) {
    return { status: "offline", message: "Could not open the sync-v2 folder." };
  }

  // ---- enumerate + validate every peer independently ----
  const peerIds = (await Transport.listPeerDeviceIds(devicesDir)).filter((id) => id !== deviceId);
  const validPeers = [];
  const skippedPeers = [];

  for (const peerId of peerIds) {
    let result;
    try {
      result = await Transport.readDeviceReplica(devicesDir, peerId);
    } catch (error) {
      result = { status: "invalid", reason: "read-threw" };
    }
    if (result.status === "valid") {
      validPeers.push({ deviceId: peerId, replica: result.replica });
    } else if (result.status !== "empty") {
      // One corrupt/mid-write peer must not poison the pass — it is simply
      // excluded, and every other (possibly healthy) peer is still merged.
      skippedPeers.push({ deviceId: peerId, reason: result.reason || result.status });
    }
  }

  // ---- observeReplica on every valid peer BEFORE any new stamping ----
  // This pass itself never stamps (adoptMergedReplica only merges already-
  // stamped facts), but the NEXT local mutation — which can race this very
  // pass — must draw its stamp above everything just observed.
  for (const peer of validPeers) {
    await profileStore.observePeerReplica(peer.replica);
  }

  // ---- merge local + valid peers ----
  const localReplica = await profileStore.getFullReplica();
  const merged = MergeEngine.mergeAll([localReplica, ...validPeers.map((peer) => peer.replica)]);

  // ---- apply only the winning per-fact changes locally ----
  await profileStore.adoptMergedReplica(merged);

  // Re-derived AFTER adoption: adoption can normalize a field the same way
  // Sync V1's replaceAllProfiles does (see profile-sync.js's #applyRemote) —
  // this device must publish what it actually now holds, not what it computed
  // a moment before adopting it.
  const toPublish = await profileStore.getFullReplica();

  // ---- publish this device's merged replica, only if it actually changed ----
  // Re-reads OUR OWN last-published generation from the folder itself rather
  // than a second, separately-persisted baseline — the folder is already the
  // source of truth for what was published, so there is nothing else to keep
  // in sync with it.
  let ownPrevious;
  try {
    ownPrevious = await Transport.readDeviceReplica(devicesDir, deviceId);
  } catch (error) {
    ownPrevious = { status: "invalid" };
  }
  const alreadyPublished = ownPrevious.status === "valid" && Transport.replicasEqual(ownPrevious.replica, toPublish);

  if (alreadyPublished) {
    return { status: "ok", published: false, mergedPeers: validPeers.length, skippedPeers };
  }

  // Data files first, device.json last, read-back-and-verify, cleanup only on
  // success — see Transport.publishDeviceReplicaVerified for the full
  // discipline (reused from Stage B).
  const publishResult = await Transport.publishDeviceReplicaVerified(devicesDir, deviceId, toPublish);
  if (!publishResult.ok) {
    return {
      status: "verify-failed",
      reason: publishResult.reason,
      message:
        "This device's sync-v2 publish could not be verified, so nothing was accepted. Local Profile data is unaffected.",
      mergedPeers: validPeers.length,
      skippedPeers,
    };
  }

  return { status: "ok", published: true, mergedPeers: validPeers.length, skippedPeers };
}
