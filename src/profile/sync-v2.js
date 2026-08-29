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

// [PHASE-6-SYNC-V2]
// [STAGE-E-REAL-DRIVE-HASH-RECOVERY]
// [WHY: separate DriveFS clients may observe device metadata and profile bytes
//  at different points in propagation; integrity must remain strict while
//  either direction recovers automatically. How many consecutive passes this
//  device will WAIT for its own just-published generation to become readable
//  again before concluding the folder is genuinely damaged and rewriting it.
//  At the 3s convergence cadence this is ~30 seconds — long enough for Drive to
//  finish a round trip, short enough that real corruption still self-heals
//  without any user action.]
const OWN_GENERATION_SETTLE_PASSES = 10;

/**
 * Runs one Sync V2 reconcile pass against `dirHandle` for `profileStore`.
 *
 * Returns a plain result object; never throws for an ordinary sync failure
 * (permission, unreadable folder, verify-failed) — those are reported in
 * `status`. Only a genuinely unexpected error propagates.
 */
export async function runSyncV2Pass({ profileStore, dirHandle, state = {} }) {
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
      // [PHASE-6-SYNC-V2][STAGE-E-HUMAN-DEVICE-LABEL]
      // [WHY: carried alongside the replica, never inside it. Only the
      //  `replica` field is ever merged; `label`/`updatedAt` exist purely so a
      //  diagnostic surface can name this peer instead of showing a bare UUID.]
      validPeers.push({ deviceId: peerId, replica: result.replica, label: result.label, updatedAt: result.updatedAt });
    } else if (result.status !== "empty") {
      // One corrupt/mid-write peer must not poison the pass — it is simply
      // excluded, and every other (possibly healthy) peer is still merged.
      // NOTHING about this skip is remembered between passes: the very next
      // pass re-reads this peer from scratch, so a peer that was mid-propagation
      // recovers automatically with no local mutation and no manual Sync Now.
      skippedPeers.push({ deviceId: peerId, reason: result.reason || result.status, detail: result.detail || null });
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

  // [PHASE-6-SYNC-V2]
  // [STAGE-E-CONVERGENCE-SCHEDULER]
  // [WHY: every active client must merge shared truth approximately every 3
  //  seconds without requiring local activity — which means most passes are
  //  no-ops, and a no-op pass must be able to say so. `adopted` is how the
  //  caller distinguishes "a peer's change actually landed here" from "nothing
  //  happened", so a background poll can stay silent instead of re-rendering
  //  the status surface every 3 seconds. Derived by comparing the replica
  //  BEFORE adoption with the one re-derived after it, which is the same
  //  canonical comparison the publish-skip below already relies on.]
  const adopted = !Transport.replicasEqual(localReplica, toPublish);

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

  const peers = validPeers.map((peer) => ({ deviceId: peer.deviceId, label: peer.label, updatedAt: peer.updatedAt }));
  const canonicalToPublish = MergeEngine.stableStringify(toPublish);

  if (alreadyPublished) {
    state.lastPublishedCanonical = canonicalToPublish;
    state.ownSettlingPasses = 0;
    return { status: "ok", published: false, adopted, mergedPeers: validPeers.length, skippedPeers, peers };
  }

  // [PHASE-6-SYNC-V2]
  // [STAGE-E-REAL-DRIVE-HASH-RECOVERY]
  // [WHY: this is the defect that turns a TRANSIENT propagation window into a
  //  permanent one. Our own generation reading back as inconsistent makes
  //  alreadyPublished false, which — before this — republished the entire
  //  subtree on EVERY 3-second pass. Each rewrite restarts Drive propagation, so
  //  a peer never observes a settled generation and its hash check fails
  //  forever: the publisher's own retry loop was manufacturing the peer's
  //  mismatch. When we have already written exactly these bytes and verified
  //  them at the time, an inconsistent read now says the FOLDER is still
  //  catching up, not that the data is wrong — so the correct action is to wait,
  //  not to write again. Bounded, so genuine corruption still self-heals: after
  //  OWN_GENERATION_SETTLE_PASSES we republish once and reset. Nothing here
  //  relaxes verification — a mismatch is still never adopted by anyone.]
  if (ownPrevious.status === "invalid" && state.lastPublishedCanonical === canonicalToPublish) {
    const settling = (state.ownSettlingPasses || 0) + 1;
    state.ownSettlingPasses = settling;
    if (settling < OWN_GENERATION_SETTLE_PASSES) {
      return {
        status: "ok",
        published: false,
        adopted,
        ownGenerationSettling: settling,
        ownGenerationReason: ownPrevious.reason || null,
        mergedPeers: validPeers.length,
        skippedPeers,
        peers,
      };
    }
    state.ownSettlingPasses = 0; // bounded escape — fall through and rewrite once
  }

  // Data files first, device.json last, read-back-and-verify, cleanup only on
  // success — see Transport.publishDeviceReplicaVerified for the full
  // discipline (reused from Stage B).
  const publishResult = await Transport.publishDeviceReplicaVerified(devicesDir, deviceId, toPublish, {
    label: typeof profileStore.getDeviceLabel === "function" ? profileStore.getDeviceLabel() : null,
  });
  if (!publishResult.ok) {
    return {
      status: "verify-failed",
      reason: publishResult.reason,
      adopted,
      message:
        "This device's sync-v2 publish could not be verified, so nothing was accepted. Your local Curation is unaffected.",
      mergedPeers: validPeers.length,
      skippedPeers,
      peers,
    };
  }

  state.lastPublishedCanonical = canonicalToPublish;
  state.ownSettlingPasses = 0;
  return { status: "ok", published: true, adopted, mergedPeers: validPeers.length, skippedPeers, peers };
}
