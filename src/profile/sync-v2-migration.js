// [PHASE-6-SYNC-V2]
// [STAGE-D2-TRANSPORT]
// [WHY: an installation migrating onto V2 may have real V1 curation sitting in
//  the same sync folder, under manifest.json/profiles/ — and per the approved
//  controlled-hard-cutover policy, V1 remains read-only recovery material
//  forever, never a second active writer. This module's ONLY job is turning
//  that pre-ordering data into recoverable Sync V2 facts without ever writing,
//  moving, or deleting a single V1 byte, and without ever letting it overrule
//  something local already knows. It is deliberately NOT wired into
//  runSyncV2Pass (sync-v2.js) — activating a migration is a policy decision
//  for a later stage, not something a routine sync pass should do on its own.]
//
// WHAT: seedFromV1() — reads V1's per-profile JSON files DIRECTLY (never
// through profile-sync.js's readCollectionFromFolder, whose manifest
// fingerprint check this module is explicitly told not to trust as
// authoritative for this purpose — a V1 installation stuck in the
// known-inconsistent state documented in profile-sync.js should still be
// recoverable file-by-file), seeds each into facts at V1_SEED_T (below every
// local stamp, including the ordinary local seed floor), and merges that into
// whatever replica the caller already has. Because V1 seeding only ever
// contributes POSITIVE facts (see seedFactsFromProfileData) at the lowest
// stamp in the system, this can only ADD state nothing local already covers —
// it can never delete, and it can never win a genuine disagreement.

import { seedFactsFromProfileData, v1SeedStamp } from "./sync-translate.js";
import { mergeReplicas, mergeProfileFacts } from "./sync-merge.js";

const V1_PROFILES_DIR_NAME = "profiles";
const V1_PROFILE_KIND = "gallery-profile";

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseV1ProfileFile(text) {
  const parsed = JSON.parse(text);
  if (
    !isPlainObject(parsed) ||
    parsed.kind !== V1_PROFILE_KIND ||
    typeof parsed.profileId !== "string" ||
    !parsed.profileId ||
    !isPlainObject(parsed.items)
  ) {
    throw new Error("Not a recognized V1 profile file.");
  }
  return {
    id: parsed.profileId,
    name: typeof parsed.profileName === "string" ? parsed.profileName : "",
    items: parsed.items,
    tags: Array.isArray(parsed.tags) ? parsed.tags : [],
  };
}

/**
 * Reads every V1 per-profile file it can, DIRECTLY — never validating against
 * manifest.json's fingerprint, since a V1 installation can be legitimately
 * stuck with a manifest that no longer matches its files (see profile-sync.js)
 * while the individual profile files themselves remain perfectly readable and
 * recoverable. A file that fails to read or parse is skipped, not fatal — this
 * must never block V2 from starting on local data alone.
 *
 * Returns a plain array of { id, name, items, tags } — never touches anything
 * writable, so it is safe to call against the REAL V1 folder for inspection
 * (still gated by the caller's own policy on when that is appropriate).
 */
export async function readV1ProfilesReadOnly(dirHandle) {
  const results = [];
  let profilesDir;
  try {
    profilesDir = await dirHandle.getDirectoryHandle(V1_PROFILES_DIR_NAME);
  } catch (error) {
    return results; // no V1 data at all — not an error, nothing to recover.
  }

  try {
    for await (const [name, entry] of profilesDir.entries()) {
      if (entry.kind !== "file" || !name.endsWith(".json")) continue;
      try {
        const handle = await profilesDir.getFileHandle(name);
        const text = await (await handle.getFile()).text();
        results.push(parseV1ProfileFile(text));
      } catch (error) {
        console.warn(`[SYNC-V2] Could not read V1 profile file "${name}" (skipped, non-fatal).`, error);
      }
    }
  } catch (error) {
    console.warn("[SYNC-V2] Could not enumerate V1 profile files (non-fatal).", error);
  }

  return results;
}

/**
 * Builds a replica of V1-derived facts, stamped at V1_SEED_T so they can only
 * ever ADD recoverable state — never win a disagreement with anything local
 * already covers. `deviceId` is this installation's own id, used only to tag
 * the synthetic stamp (see v1SeedStamp) so it is attributable, never to gate
 * behavior.
 */
export function buildV1SeedReplica(v1Profiles, deviceId) {
  const stamp = v1SeedStamp(deviceId);
  let replica = { schemaVersion: 2, profiles: {}, associations: {} };

  for (const profile of v1Profiles) {
    const facts = seedFactsFromProfileData(profile, stamp);
    const existing = replica.profiles[profile.id];
    replica.profiles[profile.id] = existing ? mergeProfileFacts(existing, facts) : facts;
  }

  return replica;
}

/**
 * Reads V1 read-only, seeds it, and merges the result into `localReplica`.
 * Pure with respect to the filesystem beyond reading — never calls a single
 * writable FSA API. The caller decides what to do with the result (typically
 * ProfileStore#adoptMergedReplica, itself unaffected by V1 seeding losing any
 * genuine disagreement, by construction of the stamp used here).
 */
export async function seedFromV1(dirHandle, localReplica, deviceId) {
  const v1Profiles = await readV1ProfilesReadOnly(dirHandle);
  if (v1Profiles.length === 0) return { replica: localReplica, seededProfileIds: [] };

  const v1Replica = buildV1SeedReplica(v1Profiles, deviceId);
  return {
    replica: mergeReplicas(localReplica, v1Replica),
    seededProfileIds: v1Profiles.map((p) => p.id),
  };
}
