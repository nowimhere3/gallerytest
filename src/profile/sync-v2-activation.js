// [PHASE-6-SYNC-V2]
// [STAGE-E-LIVE-INTEGRATION]
// [WHY: activation is the one irreversible-feeling moment in the whole phase —
//  after it, this installation stops writing V1 forever. It therefore has to be
//  impossible for activation to destroy anything: every step here either ADDS
//  recoverable state or leaves the installation exactly as it was. Local facts
//  are already authoritative by stamp (V1 seeds below LOCAL_SEED_T), V1 files
//  are only ever READ, and a failure at any point records ACTIVATION_FAILED
//  rather than a half-set "v2" — so the next boot re-offers activation instead
//  of silently running a transport whose migration never finished.]
//
// WHAT: activateSyncV2() — the controlled V1 -> V2 cutover for one
// installation, and its activation-state accessors.

import {
  loadActivationState,
  saveActivationState,
  ACTIVATION_V1,
  ACTIVATION_V2,
  ACTIVATION_FAILED,
} from "../storage/profile-sync-store.js";
import { seedFromV1 } from "./sync-v2-migration.js";

export { loadActivationState, ACTIVATION_V1, ACTIVATION_V2, ACTIVATION_FAILED };

/**
 * Activates Sync V2 on this installation.
 *
 * Order matters and is deliberate:
 *   1. read the local replica (never fails — it is already in IndexedDB)
 *   2. read V1 READ-ONLY and seed it beneath every local stamp
 *   3. adopt the merged result locally
 *   4. only then record ACTIVATION_V2
 *
 * Steps 2 and 3 are individually fault-tolerant: a V1 folder that cannot be
 * read at all is not an error, it is simply "nothing to recover", and
 * activation continues local-only with `migration.reason` recording why. Step 4
 * is what actually flips the transport, so it is last — an interruption before
 * it leaves the installation on V1 with local data untouched, which is a state
 * it can safely retry from.
 *
 * `dirHandle` may be null (activating with no sync folder connected yet) — that
 * is a normal local-only activation, not a failure.
 *
 * Returns { ok, mode, migration }.
 */
export async function activateSyncV2({ profileStore, dirHandle = null }) {
  const migration = { attempted: false, v1ProfilesSeeded: 0, reason: null };

  try {
    await profileStore.whenFactsSettled();

    if (dirHandle) {
      migration.attempted = true;
      try {
        const localReplica = await profileStore.getFullReplica();
        const { replica, seededProfileIds } = await seedFromV1(
          dirHandle,
          localReplica,
          profileStore.getDeviceId() || "unknown-device"
        );
        migration.v1ProfilesSeeded = seededProfileIds.length;

        if (seededProfileIds.length > 0) {
          // [PHASE-6-SYNC-V2][STAGE-E-LIVE-INTEGRATION]
          // [WHY: adopting the SEEDED replica cannot regress local state — every
          //  V1-derived fact carries V1_SEED_T, below even the local seed floor,
          //  so mergeFact resolves every same-fact disagreement in local's
          //  favour by construction. V1 can therefore only contribute curation
          //  local has no fact for at all. This is why adoption is safe to run
          //  before activation is recorded: if it is interrupted, the worst
          //  outcome is some recovered V1 curation on an installation still
          //  running V1.]
          await profileStore.adoptMergedReplica(replica);
        }
      } catch (error) {
        // A V1 folder that cannot be read must NEVER block activation — the
        // installation's own local data is complete and authoritative without
        // it. The reason is surfaced so the UI can offer recovery rather than
        // implying the migration succeeded.
        console.warn("[SYNC-V2] Could not read V1 data during activation (continuing local-only).", error);
        migration.reason = (error && error.message) || "V1 data could not be read.";
      }
    } else {
      migration.reason = "No sync folder was connected at activation time.";
    }

    await saveActivationState({ mode: ACTIVATION_V2, activatedAt: Date.now(), migration });
    return { ok: true, mode: ACTIVATION_V2, migration };
  } catch (error) {
    console.error("[SYNC-V2] Activation failed.", error);
    migration.reason = (error && error.message) || "Activation failed.";
    try {
      await saveActivationState({ mode: ACTIVATION_FAILED, activatedAt: null, migration });
    } catch (saveError) {
      console.error("[SYNC-V2] Could not even record the activation failure.", saveError);
    }
    return { ok: false, mode: ACTIVATION_FAILED, migration };
  }
}
