// [SYNCV3 / STAGE-03A / V3-ASSOCIATION-ISOLATION-AND-PASS-SKELETON]
// [WHY: a SIBLING of sync-v2.js, for the same reason sync-v3-transport.js is a
//  sibling of sync-v2-transport.js: V2 is shipped and proven, and the way to
//  keep it that way is to not edit it. The ORDER of the steps below is the part
//  that matters and is copied deliberately, comment for comment, because every
//  one of them was paid for by a real defect - observing before stamping, merging
//  before applying, applying before publishing, verifying before cleanup, and
//  waiting out one's own propagation instead of rewriting.
//
//  Two things genuinely differ from V2, and only two:
//    1. discovery is content-addressed (see sync-v3-transport.js), so peers and
//       this device's own generation both come back from ONE discovery call
//       rather than a peer list plus a separate self-read;
//    2. every write is gated behind one eligibility decision, because two tabs
//       of one origin share a deviceId and therefore a device directory.]
//
// WHAT: runSyncV3Pass() - one complete V3 reconcile pass.
//
// NOT AUTOMATICALLY LIVE: while sync-v3-write-policy.js keeps live writes
// disabled this pass reads, merges and adopts, but creates no directory and
// publishes nothing. That is a deliberate state, not an unfinished one.

import * as MergeEngine from "./sync-merge.js";
import * as Transport from "./sync-v3-transport.js";
import { mayPublishV3 } from "./sync-v3-write-policy.js";

// [SYNCV3 / STAGE-03A / V3-ASSOCIATION-ISOLATION-AND-PASS-SKELETON]
// [WHY: carried over from sync-v2.js unchanged, including the value. Separate
//  Drive clients observe a device's metadata and its data files at different
//  points in propagation, so this device's own just-published generation can
//  legitimately read back inconsistent for a while. Republishing on every such
//  pass is what turns a TRANSIENT propagation window into a permanent one: each
//  rewrite restarts propagation, so no peer ever observes a settled generation
//  and the publisher's own retry loop manufactures the peer's mismatch. Waiting
//  is the correct action; the bound is what keeps genuine corruption self-healing.]
const OWN_GENERATION_SETTLE_PASSES = 10;

// [SYNCV3 / STAGE-03A / V3-ASSOCIATION-ISOLATION-AND-PASS-SKELETON]
// [WHY: ProfileStore builds replicas at the V2 fact-schema version, because the
//  FACT MODEL is shared and deliberately unchanged - V3 is a different transport
//  over the same facts, not a different algebra. The transport, however, writes
//  and reads back schemaVersion 3, so a replica handed straight from
//  getFullReplica() to the transport would come back differing in exactly that
//  one field and replicasEqual() would report "changed" on EVERY publish -
//  a verification failure that looks like corruption and never resolves.
//  Normalizing at this boundary is the honest fix: the pass owns which schema
//  its transport speaks, and neither sync-facts.js nor the transport's strict
//  byte comparison has to be weakened to accommodate the other.]
function asV3Replica(replica) {
  return { ...replica, schemaVersion: Transport.SCHEMA_VERSION };
}

/**
 * Runs one Sync V3 reconcile pass against `dirHandle` for `profileStore`.
 *
 * `mayPublish` is the single write-eligibility seam - see sync-v3-write-policy.js.
 * Injectable so tests can drive both answers; it defaults to the real policy so
 * no caller can accidentally opt out of it by forgetting to pass one.
 *
 * Returns a plain result object; never throws for an ordinary sync failure.
 */
export async function runSyncV3Pass({ profileStore, dirHandle, state = {}, mayPublish = mayPublishV3 }) {
  let permission;
  try {
    permission = await dirHandle.queryPermission({ mode: "readwrite" });
  } catch (error) {
    return { status: "permission-needed", message: "The V3 sync folder is no longer accessible." };
  }
  if (permission !== "granted") return { status: "permission-needed" };

  // Load local persisted facts - whatever mutations have happened so far,
  // stamped and settled, before this pass reads or reasons about them.
  await profileStore.whenFactsSettled();

  const deviceId = profileStore.getDeviceId();
  if (!deviceId) return { status: "no-device-identity" };

  // [SYNCV3 / STAGE-03A / V3-ASSOCIATION-ISOLATION-AND-PASS-SKELETON]
  // [WHY: THE one write-eligibility call, evaluated ONCE per pass and consulted
  //  for both of the things that touch Drive - creating the directory tree and
  //  publishing into it. Evaluated here, before any handle is opened with
  //  create:true, because getDirectoryHandle({ create: true }) IS a write: a pass
  //  that asked permission only at publish time would already have created
  //  sync-v3/devices/ on a folder that is supposed to stay untouched.
  //
  //  Asked once rather than twice so the two decisions cannot disagree - under
  //  Stage 03B a lease could plausibly expire between them, and "created the
  //  directory but was not allowed to publish into it" is a state worth making
  //  unreachable rather than handling.]
  const eligibility = (await mayPublish({ deviceId })) || { allowed: false, reason: "no-eligibility-answer" };
  const mayWrite = eligibility.allowed === true;

  let root, devicesDir;
  try {
    root = await Transport.getSyncV3Root(dirHandle, { create: mayWrite });
    devicesDir = await Transport.getDevicesDir(root, { create: mayWrite });
  } catch (error) {
    // With writes disabled a missing sync-v3/ tree is the ORDINARY state, not a
    // fault: nothing has ever published here. Reported as a clean read-only pass
    // so a status surface does not describe an untouched folder as offline.
    if (!mayWrite) {
      return {
        status: "ok",
        published: false,
        adopted: false,
        publishBlocked: eligibility.reason,
        mergedPeers: 0,
        skippedPeers: [],
        peers: [],
        duplicates: [],
        rootMissing: true,
      };
    }
    return { status: "offline", message: "Could not open the sync-v3 folder." };
  }

  // ---- discover every device, keyed by the FULL declared deviceId ----
  // One call returns validated peers, this device's own winning generation, the
  // directories skipped this pass, and any duplicate directories - see
  // sync-v3-transport.js. Self-exclusion is by content, never by folder name.
  let discovery;
  try {
    discovery = await Transport.discoverDevices(devicesDir, { ownDeviceId: deviceId });
  } catch (error) {
    return { status: "offline", message: "Could not read the sync-v3 devices folder." };
  }
  const validPeers = discovery.peers;
  const skippedPeers = discovery.skipped;

  // ---- observeReplica on every valid peer BEFORE any new stamping ----
  // This pass itself never stamps (adoptMergedReplica only merges already-
  // stamped facts), but the NEXT local mutation - which can race this very
  // pass - must draw its stamp above everything just observed.
  for (const peer of validPeers) {
    await profileStore.observePeerReplica(peer.replica);
  }

  // ---- merge local + valid peers ----
  const localReplica = asV3Replica(await profileStore.getFullReplica());
  const merged = MergeEngine.mergeAll([localReplica, ...validPeers.map((peer) => peer.replica)]);

  // ---- apply only the winning per-fact changes locally ----
  await profileStore.adoptMergedReplica(merged);

  // Re-derived AFTER adoption: adoption can normalize a field, so this device
  // must publish what it actually now holds, not what it computed a moment
  // before adopting it.
  const toPublish = asV3Replica(await profileStore.getFullReplica());

  // `adopted` is how a caller distinguishes "a peer's change actually landed
  // here" from "nothing happened", so a background poll can stay silent instead
  // of re-rendering a status surface on every tick.
  const adopted = !Transport.replicasEqual(localReplica, toPublish);

  const peers = validPeers.map((peer) => ({
    deviceId: peer.deviceId,
    label: peer.label,
    updatedAt: peer.updatedAt,
    directoryName: peer.directoryName,
  }));
  const canonicalToPublish = MergeEngine.stableStringify(toPublish);

  // ---- publish this device's merged replica, only if it actually changed ----
  // `discovery.own` is this device's last published generation, read from the
  // folder itself rather than from a separately-persisted baseline - the folder
  // is already the source of truth for what was published.
  const ownPrevious = discovery.own;
  const alreadyPublished = Boolean(ownPrevious) && Transport.replicasEqual(ownPrevious.replica, toPublish);

  if (alreadyPublished) {
    state.lastPublishedCanonical = canonicalToPublish;
    state.ownSettlingPasses = 0;
    return {
      status: "ok",
      published: false,
      adopted,
      mergedPeers: validPeers.length,
      skippedPeers,
      peers,
      duplicates: discovery.duplicates,
      directoryName: ownPrevious.directoryName,
    };
  }

  // [SYNCV3 / STAGE-03A / V3-ASSOCIATION-ISOLATION-AND-PASS-SKELETON]
  // [WHY: the refusal is reported, never swallowed. A pass that merged a peer's
  //  changes and then declined to publish its own has done something real and
  //  something incomplete, and a caller that could not tell the difference would
  //  render "connected" over a device that is silently not contributing. Placed
  //  AFTER the already-published check so the ordinary steady state - nothing to
  //  publish anyway - is not reported as blocked.]
  if (!mayWrite) {
    return {
      status: "ok",
      published: false,
      adopted,
      publishBlocked: eligibility.reason,
      mergedPeers: validPeers.length,
      skippedPeers,
      peers,
      duplicates: discovery.duplicates,
    };
  }

  // Our own generation reading back inconsistent when we have already written
  // exactly these bytes says the FOLDER is still catching up, not that the data
  // is wrong - so the correct action is to wait, not to write again. Bounded, so
  // genuine corruption still self-heals. Nothing here relaxes verification.
  const ownUnreadable = !ownPrevious;
  if (ownUnreadable && state.lastPublishedCanonical === canonicalToPublish) {
    const settling = (state.ownSettlingPasses || 0) + 1;
    state.ownSettlingPasses = settling;
    if (settling < OWN_GENERATION_SETTLE_PASSES) {
      return {
        status: "ok",
        published: false,
        adopted,
        ownGenerationSettling: settling,
        mergedPeers: validPeers.length,
        skippedPeers,
        peers,
        duplicates: discovery.duplicates,
      };
    }
    state.ownSettlingPasses = 0; // bounded escape - fall through and rewrite once
  }

  // Data files first, device.json last, read-back-and-verify, own-subtree-only
  // cleanup on success - see Transport.publishOwnReplicaVerified.
  const publishResult = await Transport.publishOwnReplicaVerified(devicesDir, {
    deviceId,
    label: typeof profileStore.getDeviceLabel === "function" ? profileStore.getDeviceLabel() : null,
    replica: toPublish,
  });

  if (!publishResult.ok) {
    return {
      status: "verify-failed",
      reason: publishResult.reason,
      adopted,
      message:
        "This device's sync-v3 publish could not be verified, so nothing was accepted. Local Profile data is unaffected.",
      mergedPeers: validPeers.length,
      skippedPeers,
      peers,
      duplicates: discovery.duplicates,
    };
  }

  state.lastPublishedCanonical = canonicalToPublish;
  state.ownSettlingPasses = 0;
  return {
    status: "ok",
    published: true,
    adopted,
    mergedPeers: validPeers.length,
    skippedPeers,
    peers,
    duplicates: discovery.duplicates,
    directoryName: publishResult.directoryName,
    removedProfileFiles: publishResult.removedProfileFiles,
    removedStaleDirectories: publishResult.removedStaleDirectories,
  };
}
