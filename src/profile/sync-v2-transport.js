// [PHASE-6-SYNC-V2]
// [STAGE-D2-TRANSPORT]
// [WHY: Sync V1's single manifest.json/profiles/ layout has exactly one
//  writer path for the WHOLE collection, which is what forced Sync V1 into
//  whole-collection winner-takes-all reconciliation — two devices writing at
//  once can only ever collide on the same files. A one-writer-per-device
//  layout gives every device its own subtree that only it ever writes, so N
//  devices can publish concurrently with no shared writable path at all; what
//  makes them converge is the merge algebra (sync-merge.js) folding every
//  device's published replica together, not file-level locking.]
//
// WHAT: The Sync V2 file layout and its read/write/verify primitives.
//
//   <sync folder>/sync-v2/devices/<deviceId>/
//     device.json          { deviceId, profiles: [{id, file, hash}], associationsHash, updatedAt }
//     associations.json    the replica's `associations` map (unwired content in D2 — see plan)
//     profiles/
//       <profileId>.json   { schemaVersion, kind, profileId, facts }
//
// device.json is the commit point, exactly like Sync V1's manifest.json: it is
// written LAST, and every file it declares is re-hashed on every read and
// compared against the hash device.json itself records. A read that finds
// device.json missing is "empty" (nothing published yet, or a peer mid-FIRST-
// write that hasn't reached its commit point); one that finds device.json
// present but any declared file missing, unparseable, or hash-mismatched is
// "invalid" — which SKIPS THAT WHOLE DEVICE for the current pass. A read never
// partially trusts a device's data: readDeviceReplica returns one replica or
// none, the same all-or-nothing contract readCollectionFromFolder (Sync V1,
// Stage B) already established for its own manifest.
//
// DEVICE ISOLATION: every write function in this file takes the writing
// device's OWN deviceId and constructs paths ONLY under
// devices/<thatDeviceId>/ — there is no function anywhere in this module that
// can address another device's subtree for writing. assertOwnDeviceScope
// below is the explicit, loud version of that guarantee for anything that
// composes paths from caller-supplied ids.

import { stableStringify } from "./sync-merge.js";

const ROOT_DIR_NAME = "sync-v2";
const DEVICES_DIR_NAME = "devices";
const PROFILES_DIR_NAME = "profiles";
const DEVICE_FILE_NAME = "device.json";
const ASSOCIATIONS_FILE_NAME = "associations.json";
const DEVICE_KIND = "gallery-profile-sync-v2-device";
const PROFILE_FACTS_KIND = "gallery-profile-sync-v2-facts";
const ASSOCIATIONS_KIND = "gallery-profile-sync-v2-associations";
const SCHEMA_VERSION = 2;

/** Shown for a peer whose device.json predates labels, or whose platform is unrecognised. */
export const UNKNOWN_DEVICE_LABEL = "Unknown Device";

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// [PHASE-6-SYNC-V2][STAGE-D2-TRANSPORT]
// [WHY: a device id that has escaped identity generation entirely (empty,
//  wrong type, or containing a path separator) must never reach a
//  getDirectoryHandle call — that is exactly how one device's write could land
//  outside its own subtree, or worse, outside devices/ altogether via "..".
//  Thrown loudly rather than sanitized: a deviceId this malformed means
//  something upstream is broken, and silently coercing it would hide that.]
export function assertOwnDeviceScope(deviceId) {
  if (typeof deviceId !== "string" || !deviceId) {
    throw new Error("[SYNC-V2] Refusing to address a device subtree with an invalid deviceId.");
  }
  if (deviceId.includes("/") || deviceId.includes("\\") || deviceId === "." || deviceId === "..") {
    throw new Error(`[SYNC-V2] Refusing to address a device subtree with an unsafe deviceId "${deviceId}".`);
  }
}

// [PHASE-6-SYNC-V2]
// [STAGE-E-REAL-DRIVE-HASH-RECOVERY]
// [WHY: separate DriveFS clients may observe device metadata and profile bytes
//  at different points in propagation; integrity must remain strict while
//  either direction recovers automatically. This function used to SILENTLY
//  choose between SHA-256 and an FNV fallback depending on whether
//  crypto.subtle happened to be available. A publisher with subtle writes a
//  64-char digest; a reader without it recomputes an 8-char one and they can
//  never agree — producing a PERMANENT `profile-hash-mismatch` that is
//  indistinguishable from real corruption, in one direction only, with no way
//  to tell the two apart from a diagnostic. The algorithm is now reported
//  alongside the digest and recorded in device.json, so a reader that cannot
//  reproduce a publisher's algorithm says exactly that instead of blaming the
//  bytes. Integrity is unchanged: a digest is still compared strictly, and a
//  mismatch is still a hard reject.]
async function hashText(text) {
  if (typeof crypto !== "undefined" && crypto.subtle && typeof crypto.subtle.digest === "function") {
    try {
      const bytes = new TextEncoder().encode(text);
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      return { algo: "sha256", value: [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("") };
    } catch {
      // Fall through — same tolerance computeFingerprint (Stage B) applies.
    }
  }
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return { algo: "fnv1a", value: (hash >>> 0).toString(16).padStart(8, "0") };
}

/** The digest algorithm this runtime can actually produce. */
export async function currentHashAlgo() {
  return (await hashText("")).algo;
}

/** Two replicas are equal iff their canonical form is byte-identical. */
export function replicasEqual(a, b) {
  return stableStringify(a) === stableStringify(b);
}

// ---- Directory navigation --------------------------------------------------

export async function getSyncV2Root(dirHandle, { create = false } = {}) {
  return dirHandle.getDirectoryHandle(ROOT_DIR_NAME, { create });
}

export async function getDevicesDir(root, { create = false } = {}) {
  return root.getDirectoryHandle(DEVICES_DIR_NAME, { create });
}

export async function listPeerDeviceIds(devicesDir) {
  const ids = [];
  try {
    for await (const [name, handle] of devicesDir.entries()) {
      if (handle.kind === "directory") ids.push(name);
    }
  } catch (error) {
    console.warn("[SYNC-V2] Could not list device subtrees.", error);
  }
  return ids;
}

// ---- Reading / validating one device's published generation ---------------

/**
 * Reads and validates one device's published replica.
 *
 * Returns one of:
 *   { status: "empty" }                        — no device.json (never published, or mid-first-write)
 *   { status: "invalid", reason }               — present but unreadable/inconsistent — SKIP this device
 *   { status: "valid", replica }                — safe to merge
 */
export async function readDeviceReplica(devicesDir, deviceId) {
  assertOwnDeviceScope(deviceId);

  let deviceDir;
  try {
    deviceDir = await devicesDir.getDirectoryHandle(deviceId);
  } catch {
    return { status: "empty" };
  }

  let manifestText;
  try {
    const handle = await deviceDir.getFileHandle(DEVICE_FILE_NAME);
    manifestText = await (await handle.getFile()).text();
  } catch (error) {
    if (error && error.name === "NotFoundError") return { status: "empty" };
    return { status: "invalid", reason: "manifest-unreadable" };
  }

  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    return { status: "invalid", reason: "manifest-malformed" };
  }

  if (
    !isPlainObject(manifest) ||
    manifest.kind !== DEVICE_KIND ||
    manifest.deviceId !== deviceId ||
    !Array.isArray(manifest.profiles) ||
    typeof manifest.associationsHash !== "string"
  ) {
    return { status: "invalid", reason: "manifest-shape" };
  }

  // [PHASE-6-SYNC-V2][STAGE-E-REAL-DRIVE-HASH-RECOVERY]
  // [WHY: a peer whose digest algorithm this runtime cannot reproduce is not
  //  corrupt, and calling it corrupt sends whoever is debugging to look at the
  //  wrong thing entirely. Absent hashAlgo means the generation predates this
  //  field, in which case the only algorithm that ever existed was ours — so
  //  "assume ours" is both backward compatible and correct. This is a REJECT,
  //  not a bypass: unverifiable bytes are never adopted.]
  const ourAlgo = await currentHashAlgo();
  const theirAlgo = typeof manifest.hashAlgo === "string" && manifest.hashAlgo ? manifest.hashAlgo : ourAlgo;
  if (theirAlgo !== ourAlgo) {
    return { status: "invalid", reason: `hash-algo-mismatch:${theirAlgo}-vs-${ourAlgo}` };
  }

  const profiles = {};
  let profilesDir = null;
  if (manifest.profiles.length > 0) {
    try {
      profilesDir = await deviceDir.getDirectoryHandle(PROFILES_DIR_NAME);
    } catch {
      return { status: "invalid", reason: "profiles-dir-missing" };
    }
  }

  for (const declared of manifest.profiles) {
    if (!isPlainObject(declared) || typeof declared.id !== "string" || !declared.id || typeof declared.hash !== "string") {
      return { status: "invalid", reason: "profile-entry-shape" };
    }
    let text;
    try {
      const handle = await profilesDir.getFileHandle(`${declared.id}.json`);
      text = await (await handle.getFile()).text();
    } catch {
      return { status: "invalid", reason: `profile-file-missing:${declared.id}` };
    }

    const actualHash = await hashText(text);
    if (actualHash.value !== declared.hash) {
      // Detail exists so a real-device diagnostic can distinguish
      // mid-propagation staleness (bytes differ, both digests well-formed)
      // from a structural fault, without ever relaxing the reject itself.
      return {
        status: "invalid",
        reason: `profile-hash-mismatch:${declared.id}`,
        detail: `bytes=${text.length} declared=${String(declared.hash).slice(0, 8)} actual=${actualHash.value.slice(0, 8)} algo=${actualHash.algo}`,
      };
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { status: "invalid", reason: `profile-file-malformed:${declared.id}` };
    }
    if (
      !isPlainObject(parsed) ||
      parsed.kind !== PROFILE_FACTS_KIND ||
      parsed.profileId !== declared.id ||
      !isPlainObject(parsed.facts)
    ) {
      return { status: "invalid", reason: `profile-file-shape:${declared.id}` };
    }
    profiles[declared.id] = parsed.facts;
  }

  let associationsText;
  try {
    const handle = await deviceDir.getFileHandle(ASSOCIATIONS_FILE_NAME);
    associationsText = await (await handle.getFile()).text();
  } catch {
    return { status: "invalid", reason: "associations-missing" };
  }

  const associationsActualHash = await hashText(associationsText);
  if (associationsActualHash.value !== manifest.associationsHash) {
    return {
      status: "invalid",
      reason: "associations-hash-mismatch",
      detail: `bytes=${associationsText.length} declared=${String(manifest.associationsHash).slice(0, 8)} actual=${associationsActualHash.value.slice(0, 8)}`,
    };
  }

  let associationsParsed;
  try {
    associationsParsed = JSON.parse(associationsText);
  } catch {
    return { status: "invalid", reason: "associations-malformed" };
  }
  if (!isPlainObject(associationsParsed) || associationsParsed.kind !== ASSOCIATIONS_KIND || !isPlainObject(associationsParsed.associations)) {
    return { status: "invalid", reason: "associations-shape" };
  }

  return {
    status: "valid",
    // Read as OPTIONAL metadata, alongside — never inside — the replica. A
    // device.json written before this field existed simply has no `label`, and
    // is still perfectly valid; it reports the same fallback an unrecognised
    // platform does.
    label: typeof manifest.label === "string" && manifest.label ? manifest.label : UNKNOWN_DEVICE_LABEL,
    updatedAt: Number.isFinite(manifest.updatedAt) ? manifest.updatedAt : null,
    replica: { schemaVersion: SCHEMA_VERSION, profiles, associations: associationsParsed.associations },
  };
}

// ---- Publishing (write -> read back -> verify -> cleanup) -----------------

async function writeProfileFile(profilesDir, profileId, facts) {
  const handle = await profilesDir.getFileHandle(`${profileId}.json`, { create: true });
  const writable = await handle.createWritable();
  const text = JSON.stringify(
    { schemaVersion: SCHEMA_VERSION, kind: PROFILE_FACTS_KIND, profileId, facts },
    null,
    2
  );
  await writable.write(text);
  await writable.close();
  return hashText(text);
}

async function writeAssociationsFile(deviceDir, associations) {
  const handle = await deviceDir.getFileHandle(ASSOCIATIONS_FILE_NAME, { create: true });
  const writable = await handle.createWritable();
  const text = JSON.stringify(
    { schemaVersion: SCHEMA_VERSION, kind: ASSOCIATIONS_KIND, associations: associations || {} },
    null,
    2
  );
  await writable.write(text);
  await writable.close();
  return hashText(text);
}

async function writeDeviceManifest(deviceDir, manifest) {
  const handle = await deviceDir.getFileHandle(DEVICE_FILE_NAME, { create: true });
  const writable = await handle.createWritable();
  await writable.write(JSON.stringify(manifest, null, 2));
  await writable.close();
}

// Removes this device's OWN profile files that are no longer part of what it
// just published. Never fatal, and — like Stage B's removeObsoleteProfileFiles
// — only ever called AFTER the publish below has been read back and verified.
async function cleanupObsoleteOwnProfileFiles(profilesDir, keepIds) {
  try {
    for await (const [name, handle] of profilesDir.entries()) {
      if (handle.kind !== "file" || !name.endsWith(".json")) continue;
      const id = name.slice(0, -".json".length);
      if (!keepIds.has(id)) await profilesDir.removeEntry(name).catch(() => undefined);
    }
  } catch (error) {
    console.warn("[SYNC-V2] Could not clean up this device's obsolete profile files (non-fatal).", error);
  }
}

/**
 * Publishes `replica` under devices/<deviceId>/ — data files first, device.json
 * last — then re-reads it back and verifies every hash before treating the
 * publish as real, then (only then) removes obsolete files of its OWN.
 *
 * [PHASE-6-SYNC-V2]
 * [STAGE-D2-TRANSPORT]
 * [WHY: reuses Stage B's verified-publish discipline exactly: write -> read
 *  back -> recompute -> compare. A generation that does not survive its own
 *  read-back must never be treated as published — the caller's baseline (if
 *  any) does not advance, cleanup does not run, and local Profile data is
 *  completely unaffected, because this function never touches ProfileStore at
 *  all.]
 *
 * Returns { ok: true } or { ok: false, reason }.
 */
export async function publishDeviceReplicaVerified(devicesDir, deviceId, replica, { label = null } = {}) {
  assertOwnDeviceScope(deviceId);

  const deviceDir = await devicesDir.getDirectoryHandle(deviceId, { create: true });
  const profilesDir = await deviceDir.getDirectoryHandle(PROFILES_DIR_NAME, { create: true });

  const profileIds = Object.keys(replica.profiles || {}).sort();
  const declared = [];
  let hashAlgo = null;
  for (const profileId of profileIds) {
    const hash = await writeProfileFile(profilesDir, profileId, replica.profiles[profileId]);
    hashAlgo = hash.algo;
    declared.push({ id: profileId, file: `${PROFILES_DIR_NAME}/${profileId}.json`, hash: hash.value });
  }

  const associations = await writeAssociationsFile(deviceDir, replica.associations || {});
  const associationsHash = associations.value;
  hashAlgo = hashAlgo || associations.algo;

  // Data files are all committed above; device.json is the commit point and
  // must be written last (see the module header).
  // [PHASE-6-SYNC-V2][STAGE-E-HUMAN-DEVICE-LABEL]
  // [WHY: `label` rides in device.json and NOWHERE else. device.json is the
  //  file that CARRIES the hashes rather than being hashed itself, so an extra
  //  field here cannot change any content hash, cannot change the replica that
  //  readDeviceReplica reconstructs, and therefore cannot reach merge, ordering
  //  or the publish-skip comparison. The consequence is deliberate: a label
  //  that changes on its own will NOT trigger a publish — it refreshes the next
  //  time this device publishes for a real reason. A possibly-stale debug
  //  string is the correct trade for keeping presentation metadata completely
  //  outside the convergence path.]
  await writeDeviceManifest(deviceDir, {
    schemaVersion: SCHEMA_VERSION,
    kind: DEVICE_KIND,
    label: typeof label === "string" && label ? label : undefined,
    // Additive and backward compatible: a device.json written before this field
    // existed simply has none, and is read as "assume ours" (see readDeviceReplica).
    hashAlgo,
    deviceId,
    profiles: declared,
    associationsHash,
    updatedAt: Date.now(),
  });

  let readBack;
  try {
    readBack = await readDeviceReplica(devicesDir, deviceId);
  } catch (error) {
    return { ok: false, reason: "unreadable" };
  }
  if (readBack.status !== "valid" || !replicasEqual(readBack.replica, replica)) {
    return { ok: false, reason: readBack.status === "valid" ? "changed" : readBack.status };
  }

  await cleanupObsoleteOwnProfileFiles(profilesDir, new Set(profileIds));
  return { ok: true };
}
