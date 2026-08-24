// [SYNCV3 / STAGE-02 / CONTENT-ADDRESSED-DEVICE-DISCOVERY]
// [WHY: this is a SIBLING of sync-v2-transport.js, not a generalization of it.
//  Parameterizing V2's module to serve both roots would put the shipped, proven
//  transport one argument-default away from writing V3's schema into V2's tree,
//  and would make every future V3 change a change to code a working
//  installation depends on. The duplication here is deliberate and is the
//  cheaper risk: V2 stays literally untouched, and V3 is free to change the one
//  thing that actually differs.
//
//  What differs is identity resolution. V2 treats a device subtree's DIRECTORY
//  NAME as the deviceId - devicesDir.getDirectoryHandle(deviceId), and a
//  manifest whose deviceId does not equal its folder name is rejected outright.
//  That is what makes a rename indistinguishable from a new device, and it is
//  incompatible with names a human is allowed to edit. V3 reads identity out of
//  file CONTENT and treats every filesystem name as presentation.]
//
// WHAT: the Sync V3 file layout and its read/write/verify primitives.
//
//   <V3 sync folder>/sync-v3/devices/
//     Chromebook -- a31f2c4e/            <- readable; NOT identity
//       device.json                      { deviceId: "dev-a31f2c4e-...", profiles: [{id, file, hash}], ... }
//       associations.json
//       profiles/
//         BEAST -- 93bc1a7d.json         <- readable; NOT identity
//
// device.json is the commit point exactly as in V2: written LAST, carrying the
// hash of every file it declares, and re-hashed on every read. A read that finds
// device.json missing is "empty"; one that finds it present but any declared
// file missing, unparseable, hash-mismatched, or declaring the wrong profileId
// is "invalid" - which skips that WHOLE directory for the current pass. A read
// never partially trusts a directory.
//
// DEVICE ISOLATION: every write path here resolves the writing device's own
// directory by reading device.json and matching the FULL deviceId. There is no
// function in this module that can write into, or delete, a directory that
// declares somebody else's deviceId.

import { stableStringify } from "./sync-merge.js";
import {
  assertSafePathSegment,
  assignUniqueReadableNames,
  buildReadableName,
  DEFAULT_DISPLAY_ID_LENGTH,
} from "./sync-v3-names.js";

export const ROOT_DIR_NAME = "sync-v3";
export const DEVICES_DIR_NAME = "devices";
export const PROFILES_DIR_NAME = "profiles";
export const DEVICE_FILE_NAME = "device.json";
// [SYNCV3 / STAGE-02 / CONTENT-ADDRESSED-DEVICE-DISCOVERY]
// [WHY: associations.json keeps a stable technical filename. A readable name for
//  a Library needs shared Library METADATA - a name, and which device published
//  it - and V3 has none yet. Inventing a folder name for Libraries now would
//  mean inventing it from the only thing currently available, the libraryId,
//  which is precisely the unreadable naming this redesign exists to replace.
//  This becomes readable in the stage that introduces the shared Library record.]
export const ASSOCIATIONS_FILE_NAME = "associations.json";

// [SYNCV3 / STAGE-04B / SHARED-LIBRARY-RECORD]
// [WHY: a stable TECHNICAL filename, deliberately, exactly like
//  associations.json above. A readable per-Library Drive directory is a
//  different decision with different consequences (what happens when a Library
//  is renamed? when two share a name?) and belongs to whichever stage builds
//  the Library UI - not to the stage that first gives a Library a name at all.]
export const LIBRARIES_FILE_NAME = "libraries.json";

const DEVICE_KIND = "gallery-profile-sync-v3-device";
const PROFILE_FACTS_KIND = "gallery-profile-sync-v3-facts";
const ASSOCIATIONS_KIND = "gallery-profile-sync-v3-associations";
const LIBRARIES_KIND = "gallery-profile-sync-v3-libraries";
export const SCHEMA_VERSION = 3;

/** Shown for a device whose manifest carries no label. */
export const UNKNOWN_DEVICE_LABEL = "Unknown Device";
/** Used when a device has no usable label at all, so its directory still reads sensibly. */
const DEVICE_NAME_FALLBACK = "Device";
/** Used when a Profile's name fact is absent or empty. */
const PROFILE_NAME_FALLBACK = "Profile";

// Escalation for the OWN device directory name when the preferred name is
// already occupied by a different device. Display-only, exactly as in
// sync-v3-names.js.
const DIRECTORY_ID_ESCALATION = [DEFAULT_DISPLAY_ID_LENGTH, 12, 16, 24, 32];

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// [SYNCV3 / STAGE-02 / CONTENT-ADDRESSED-DEVICE-DISCOVERY]
// [WHY: carried over from V2 unchanged, including the algorithm negotiation.
//  A publisher with crypto.subtle writes a 64-char digest; a reader without it
//  recomputes an 8-char one, and they can never agree - producing a permanent
//  hash mismatch indistinguishable from real corruption. Reporting the algorithm
//  alongside the digest lets a reader say "I cannot reproduce your algorithm"
//  instead of blaming the bytes. Integrity is unchanged: a digest is still
//  compared strictly and a mismatch is still a hard reject.]
async function hashText(text) {
  if (typeof crypto !== "undefined" && crypto.subtle && typeof crypto.subtle.digest === "function") {
    try {
      const bytes = new TextEncoder().encode(text);
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      return { algo: "sha256", value: [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("") };
    } catch {
      // Fall through to the portable digest below.
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

export async function getSyncV3Root(dirHandle, { create = false } = {}) {
  return dirHandle.getDirectoryHandle(ROOT_DIR_NAME, { create });
}

export async function getDevicesDir(root, { create = false } = {}) {
  return root.getDirectoryHandle(DEVICES_DIR_NAME, { create });
}

/**
 * Every subdirectory under devices/.
 *
 * [SYNCV3 / STAGE-02 / CONTENT-ADDRESSED-DEVICE-DISCOVERY]
 * [WHY: returns DIRECTORY NAMES, and the name of this function says so. V2's
 *  equivalent is listPeerDeviceIds(), whose name states the assumption this
 *  stage removes - that a directory name IS a device id. Nothing downstream may
 *  treat these strings as anything but candidates to open.]
 */
export async function listDeviceDirectoryNames(devicesDir) {
  const names = [];
  try {
    for await (const [name, handle] of devicesDir.entries()) {
      if (handle.kind === "directory") names.push(name);
    }
  } catch (error) {
    console.warn("[SYNCV3] Could not list device directories.", error);
  }
  return names;
}

// [SYNCV3 / STAGE-02 / CONTENT-ADDRESSED-DEVICE-DISCOVERY]
// [WHY: a declared profile path is data from a file, so it is treated as
//  untrusted input rather than as a path. It must name a file directly inside
//  this device's own profiles/ directory and nowhere else - one leading
//  "profiles/", then a single safe segment. Without this a corrupt or hostile
//  manifest could declare "../../someone-else/device.json" and a reader that
//  merely joined strings would follow it straight out of the subtree.]
function resolveDeclaredProfileFile(file) {
  if (typeof file !== "string" || !file) return null;
  const prefix = `${PROFILES_DIR_NAME}/`;
  if (!file.startsWith(prefix)) return null;
  const remainder = file.slice(prefix.length);
  if (!remainder || remainder.includes("/") || remainder.includes("\\")) return null;
  if (remainder === "." || remainder === "..") return null;
  try {
    assertSafePathSegment(remainder, "declared profile file");
  } catch {
    return null;
  }
  return remainder;
}

// ---- Reading / validating one device directory ----------------------------

/**
 * Reads and validates ONE device directory, all-or-nothing.
 *
 * Returns one of:
 *   { status: "empty",   directoryName }
 *   { status: "invalid", directoryName, reason, detail? }
 *   { status: "valid",   directoryName, deviceId, label, updatedAt, replica }
 *
 * [SYNCV3 / STAGE-02 / CONTENT-ADDRESSED-DEVICE-DISCOVERY]
 * [WHY: `directoryName` is an argument and `deviceId` is a RESULT. That
 *  asymmetry is the whole stage. V2's equivalent takes a deviceId, uses it as
 *  the folder name, and then rejects any manifest that disagrees with it -
 *  which makes the folder name authoritative and a rename fatal. Here the caller
 *  says only "open this directory", and the directory answers "I belong to this
 *  device".]
 */
export async function readDeviceDirectory(devicesDir, directoryName) {
  assertSafePathSegment(directoryName, "device directory name");

  let deviceDir;
  try {
    deviceDir = await devicesDir.getDirectoryHandle(directoryName);
  } catch {
    return { status: "empty", directoryName };
  }

  let manifestText;
  try {
    const handle = await deviceDir.getFileHandle(DEVICE_FILE_NAME);
    manifestText = await (await handle.getFile()).text();
  } catch (error) {
    if (error && error.name === "NotFoundError") return { status: "empty", directoryName };
    return { status: "invalid", directoryName, reason: "manifest-unreadable" };
  }

  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    return { status: "invalid", directoryName, reason: "manifest-malformed" };
  }

  // Note what is NOT checked here: any relationship between manifest.deviceId
  // and directoryName. They are allowed to disagree completely.
  if (
    !isPlainObject(manifest) ||
    manifest.kind !== DEVICE_KIND ||
    typeof manifest.deviceId !== "string" ||
    !manifest.deviceId ||
    !Array.isArray(manifest.profiles) ||
    typeof manifest.associationsHash !== "string"
  ) {
    return { status: "invalid", directoryName, reason: "manifest-shape" };
  }

  const ourAlgo = await currentHashAlgo();
  const theirAlgo = typeof manifest.hashAlgo === "string" && manifest.hashAlgo ? manifest.hashAlgo : ourAlgo;
  if (theirAlgo !== ourAlgo) {
    return { status: "invalid", directoryName, reason: `hash-algo-mismatch:${theirAlgo}-vs-${ourAlgo}` };
  }

  const profiles = {};
  let profilesDir = null;
  if (manifest.profiles.length > 0) {
    try {
      profilesDir = await deviceDir.getDirectoryHandle(PROFILES_DIR_NAME);
    } catch {
      return { status: "invalid", directoryName, reason: "profiles-dir-missing" };
    }
  }

  const seenProfileIds = new Set();
  for (const declared of manifest.profiles) {
    if (
      !isPlainObject(declared) ||
      typeof declared.id !== "string" ||
      !declared.id ||
      typeof declared.hash !== "string" ||
      typeof declared.file !== "string"
    ) {
      return { status: "invalid", directoryName, reason: "profile-entry-shape" };
    }
    // Two entries claiming the same profileId make "which file is this Profile"
    // unanswerable; rejecting the generation is the only honest response.
    if (seenProfileIds.has(declared.id)) {
      return { status: "invalid", directoryName, reason: `profile-entry-duplicate:${declared.id}` };
    }
    seenProfileIds.add(declared.id);

    const fileName = resolveDeclaredProfileFile(declared.file);
    if (!fileName) {
      return { status: "invalid", directoryName, reason: `profile-entry-path:${declared.id}` };
    }

    let text;
    try {
      const handle = await profilesDir.getFileHandle(fileName);
      text = await (await handle.getFile()).text();
    } catch {
      return { status: "invalid", directoryName, reason: `profile-file-missing:${declared.id}` };
    }

    const actualHash = await hashText(text);
    if (actualHash.value !== declared.hash) {
      return {
        status: "invalid",
        directoryName,
        reason: `profile-hash-mismatch:${declared.id}`,
        detail: `bytes=${text.length} declared=${String(declared.hash).slice(0, 8)} actual=${actualHash.value.slice(0, 8)} algo=${actualHash.algo}`,
      };
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { status: "invalid", directoryName, reason: `profile-file-malformed:${declared.id}` };
    }

    // [SYNCV3 / STAGE-02 / CONTENT-ADDRESSED-DEVICE-DISCOVERY]
    // [WHY: the file's OWN profileId must equal the id the manifest declared for
    //  it. This is what makes the readable filename provably decorative: the
    //  binding between "which Profile" and "which bytes" is asserted twice in
    //  content and zero times in the name, so a renamed - or even deliberately
    //  misleading - filename cannot misattribute curation to the wrong Profile.]
    if (
      !isPlainObject(parsed) ||
      parsed.kind !== PROFILE_FACTS_KIND ||
      parsed.profileId !== declared.id ||
      !isPlainObject(parsed.facts)
    ) {
      return { status: "invalid", directoryName, reason: `profile-file-shape:${declared.id}` };
    }
    profiles[declared.id] = parsed.facts;
  }

  let associationsText;
  try {
    const handle = await deviceDir.getFileHandle(ASSOCIATIONS_FILE_NAME);
    associationsText = await (await handle.getFile()).text();
  } catch {
    return { status: "invalid", directoryName, reason: "associations-missing" };
  }

  const associationsActualHash = await hashText(associationsText);
  if (associationsActualHash.value !== manifest.associationsHash) {
    return {
      status: "invalid",
      directoryName,
      reason: "associations-hash-mismatch",
      detail: `bytes=${associationsText.length} declared=${String(manifest.associationsHash).slice(0, 8)} actual=${associationsActualHash.value.slice(0, 8)}`,
    };
  }

  let associationsParsed;
  try {
    associationsParsed = JSON.parse(associationsText);
  } catch {
    return { status: "invalid", directoryName, reason: "associations-malformed" };
  }
  if (
    !isPlainObject(associationsParsed) ||
    associationsParsed.kind !== ASSOCIATIONS_KIND ||
    !isPlainObject(associationsParsed.associations)
  ) {
    return { status: "invalid", directoryName, reason: "associations-shape" };
  }

  // [SYNCV3 / STAGE-04B / SHARED-LIBRARY-RECORD]
  // [WHY: BACKWARD COMPATIBILITY. Every device directory published by Stages 02
  //  and 03 predates this file and carries no librariesHash. Such a generation
  //  is COMPLETE AND VALID - it simply has no Library catalog yet - and treating
  //  it as corrupt would make every existing peer vanish from every pass the
  //  moment this stage shipped. Absent hash therefore means "no catalog
  //  published", read as {}. Once the hash IS declared, verification is exactly
  //  as strict as it is for associations: hash must match, kind must match,
  //  shape must match, or the WHOLE device directory is rejected.]
  let libraries = {};
  if (typeof manifest.librariesHash === "string") {
    let librariesText;
    try {
      const handle = await deviceDir.getFileHandle(LIBRARIES_FILE_NAME);
      librariesText = await (await handle.getFile()).text();
    } catch {
      return { status: "invalid", directoryName, reason: "libraries-missing" };
    }

    const librariesActualHash = await hashText(librariesText);
    if (librariesActualHash.value !== manifest.librariesHash) {
      return {
        status: "invalid",
        directoryName,
        reason: "libraries-hash-mismatch",
        detail: `bytes=${librariesText.length} declared=${String(manifest.librariesHash).slice(0, 8)} actual=${librariesActualHash.value.slice(0, 8)}`,
      };
    }

    let librariesParsed;
    try {
      librariesParsed = JSON.parse(librariesText);
    } catch {
      return { status: "invalid", directoryName, reason: "libraries-malformed" };
    }
    if (!isPlainObject(librariesParsed) || librariesParsed.kind !== LIBRARIES_KIND || !isPlainObject(librariesParsed.libraries)) {
      return { status: "invalid", directoryName, reason: "libraries-shape" };
    }
    libraries = librariesParsed.libraries;
  }

  return {
    status: "valid",
    directoryName,
    // The authoritative identity, from content.
    deviceId: manifest.deviceId,
    label: typeof manifest.label === "string" && manifest.label ? manifest.label : UNKNOWN_DEVICE_LABEL,
    updatedAt: Number.isFinite(manifest.updatedAt) ? manifest.updatedAt : null,
    replica: {
      schemaVersion: SCHEMA_VERSION,
      profiles,
      associations: associationsParsed.associations,
      libraries,
    },
  };
}

/**
 * Answers "whose directory is this?" from device.json alone, without validating
 * any data file.
 *
 * [SYNCV3 / STAGE-02 / CONTENT-ADDRESSED-DEVICE-DISCOVERY]
 * [WHY: OWNERSHIP and VALIDITY are different questions, and conflating them
 *  breaks retries. A publish that fails read-back leaves a directory whose
 *  device.json is committed and correct but whose data is corrupt - that
 *  directory is unambiguously OURS and is exactly where the retry belongs. If
 *  ownership were derived from a full validation, the failed directory would
 *  read as "not provably ours", the retry would pick a fresh escalated name, and
 *  every transient Drive fault would strand another abandoned directory that
 *  only ever grows.
 *
 *  Three outcomes, because two would force a wrong answer somewhere:
 *    "device"     - declares an id; ours iff it equals ours
 *    "none"       - no device.json at all: an aborted write, never a claim
 *    "unreadable" - a manifest we cannot parse; it may be somebody else's, so
 *                   it is never treated as ours and never written into]
 */
async function readOwnershipMarker(devicesDir, directoryName) {
  let deviceDir;
  try {
    deviceDir = await devicesDir.getDirectoryHandle(directoryName);
  } catch {
    return { kind: "none" };
  }

  let text;
  try {
    const handle = await deviceDir.getFileHandle(DEVICE_FILE_NAME);
    text = await (await handle.getFile()).text();
  } catch (error) {
    if (error && error.name === "NotFoundError") return { kind: "none" };
    return { kind: "unreadable" };
  }

  try {
    const manifest = JSON.parse(text);
    if (!isPlainObject(manifest) || manifest.kind !== DEVICE_KIND) return { kind: "unreadable" };
    if (typeof manifest.deviceId !== "string" || !manifest.deviceId) return { kind: "unreadable" };
    return { kind: "device", deviceId: manifest.deviceId };
  } catch {
    return { kind: "unreadable" };
  }
}

/** Ownership markers for every device directory, as Map<directoryName, marker>. */
async function scanOwnership(devicesDir) {
  const markers = new Map();
  for (const directoryName of await listDeviceDirectoryNames(devicesDir)) {
    markers.set(directoryName, await readOwnershipMarker(devicesDir, directoryName));
  }
  return markers;
}

/** Reads every device directory once. The single I/O pass discovery and publish share. */
async function scanDeviceDirectories(devicesDir) {
  const names = await listDeviceDirectoryNames(devicesDir);
  const results = [];
  for (const directoryName of names) {
    let result;
    try {
      result = await readDeviceDirectory(devicesDir, directoryName);
    } catch (error) {
      result = { status: "invalid", directoryName, reason: "read-threw" };
    }
    results.push(result);
  }
  return results;
}

// [SYNCV3 / STAGE-02 / CONTENT-ADDRESSED-DEVICE-DISCOVERY]
// [WHY: newest-committed-generation-wins, decided from CONTENT. updatedAt is the
//  primary key; the tie-break is the canonical replica text, so two devices
//  resolving the same duplicate pair independently choose the same winner
//  without consulting a filesystem name. The final directoryName comparison is
//  reached only when two directories hold byte-identical replicas at the same
//  instant - at which point the choice cannot affect merge at all, and exists
//  purely so a diagnostic reports the same directory twice in a row.]
function compareGenerations(a, b) {
  const at = Number.isFinite(a.updatedAt) ? a.updatedAt : -Infinity;
  const bt = Number.isFinite(b.updatedAt) ? b.updatedAt : -Infinity;
  if (at !== bt) return bt - at;

  const ac = stableStringify(a.replica);
  const bc = stableStringify(b.replica);
  if (ac !== bc) return ac < bc ? 1 : -1;

  if (a.directoryName === b.directoryName) return 0;
  return a.directoryName < b.directoryName ? -1 : 1;
}

/**
 * Discovers every device published under devices/, keyed by the FULL deviceId
 * each directory declares.
 *
 * Returns {
 *   peers,       // [{ deviceId, replica, label, updatedAt, directoryName }] - excluding ownDeviceId
 *   own,         // the winning generation for ownDeviceId, or null
 *   skipped,     // [{ directoryName, reason, detail }] - unreadable/inconsistent, retried next pass
 *   duplicates,  // [{ deviceId, chosen, ignored: [directoryName] }]
 * }
 *
 * [SYNCV3 / STAGE-02 / CONTENT-ADDRESSED-DEVICE-DISCOVERY]
 * [WHY: self-exclusion compares full declared deviceIds - never directory names.
 *  Under readable naming this device's own directory is called something like
 *  "Chromebook -- a31f2c4e" while its deviceId is "dev-a31f2c4e-...", so a
 *  name-equality check (V2's `id !== deviceId` filter) would never match and the
 *  device would merge its own subtree as though it were a peer. Merge is
 *  idempotent so the replica would survive, but every skip count, duplicate
 *  report and peer list would be wrong, and the device would appear to itself as
 *  another machine.]
 */
export async function discoverDevices(devicesDir, { ownDeviceId = null } = {}) {
  const scan = await scanDeviceDirectories(devicesDir);

  const skipped = [];
  const byDeviceId = new Map();

  for (const result of scan) {
    if (result.status === "valid") {
      const list = byDeviceId.get(result.deviceId) || [];
      list.push(result);
      byDeviceId.set(result.deviceId, list);
    } else if (result.status !== "empty") {
      // One corrupt or mid-write directory must not poison the pass. Nothing
      // about this skip is remembered: the next pass re-reads it from scratch,
      // so a directory caught mid-propagation recovers with no user action.
      skipped.push({ directoryName: result.directoryName, reason: result.reason || result.status, detail: result.detail || null });
    }
  }

  const peers = [];
  const duplicates = [];
  let own = null;

  for (const [deviceId, generations] of byDeviceId) {
    generations.sort(compareGenerations);
    const [winner, ...stale] = generations;
    if (stale.length > 0) {
      duplicates.push({
        deviceId,
        chosen: winner.directoryName,
        ignored: stale.map((entry) => entry.directoryName),
      });
    }
    if (ownDeviceId && deviceId === ownDeviceId) {
      own = winner;
      continue;
    }
    peers.push(winner);
  }

  // Stable output ordering so a caller's diagnostics do not reshuffle between
  // passes for no reason. Ordered by the authoritative id, not by name.
  peers.sort((a, b) => (a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0));

  return { peers, own, skipped, duplicates };
}

// ---- Publishing (write -> read back -> verify -> cleanup) -----------------

function profileHumanName(replica, profileId) {
  const facts = replica.profiles && replica.profiles[profileId];
  const name = facts && facts.name && typeof facts.name.v === "string" ? facts.name.v : "";
  return name || PROFILE_NAME_FALLBACK;
}

async function writeProfileFile(profilesDir, fileName, profileId, humanName, facts) {
  const handle = await profilesDir.getFileHandle(fileName, { create: true });
  const writable = await handle.createWritable();
  // `name` is recorded so the file is self-describing when opened by hand. It is
  // NOT read back into the replica (see readDeviceDirectory), so it can never
  // influence merge - it is the file's caption, not its content.
  const text = JSON.stringify(
    { schemaVersion: SCHEMA_VERSION, kind: PROFILE_FACTS_KIND, profileId, name: humanName, facts },
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

async function writeLibrariesFile(deviceDir, libraries) {
  const handle = await deviceDir.getFileHandle(LIBRARIES_FILE_NAME, { create: true });
  const writable = await handle.createWritable();
  const text = JSON.stringify(
    { schemaVersion: SCHEMA_VERSION, kind: LIBRARIES_KIND, libraries: libraries || {} },
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

/**
 * Chooses this device's directory name.
 *
 * [SYNCV3 / STAGE-02 / CONTENT-ADDRESSED-DEVICE-DISCOVERY]
 * [WHY: the preferred name is recomputed from the CURRENT label every publish,
 *  which is what makes a later user-editable device name work with no migration:
 *  the device simply starts publishing under its new name and removes its old
 *  directory once the new one verifies. Identity is unaffected because identity
 *  was never in the name.
 *
 *  `occupied` holds names belonging to anything that is not provably us -
 *  including directories that failed to read. Refusing to write into a directory
 *  we cannot prove is ours is what preserves one-writer-per-device when two
 *  different devices would otherwise pick the same readable name.]
 */
function resolveOwnDirectoryName({ deviceId, label, occupied }) {
  for (const idLength of DIRECTORY_ID_ESCALATION) {
    const candidate = buildReadableName(label || DEVICE_NAME_FALLBACK, deviceId, {
      fallback: DEVICE_NAME_FALLBACK,
      idLength,
    });
    if (!occupied.has(candidate.toLowerCase())) return candidate;
  }
  throw new Error("[SYNCV3] Could not find an unoccupied device directory name.");
}

/**
 * Removes this device's OWN profile files that are no longer declared.
 *
 * [SYNCV3 / STAGE-02 / CONTENT-ADDRESSED-DEVICE-DISCOVERY]
 * [WHY: this is the V2 defect that readable names would have turned from
 *  harmless into catastrophic. V2's cleanup strips ".json" from each filename,
 *  ASSUMES the remainder is a profileId, and deletes any file whose derived id
 *  is not in the keep set. Under UUID filenames that assumption happens to hold.
 *  Under "BEAST -- 93bc1a7d.json" the derived "id" matches nothing, so EVERY
 *  valid Profile file would be deleted on EVERY publish - silently, immediately
 *  after a successful verification.
 *
 *  V3 compares whole filenames against the exact set the manifest just declared
 *  and that read-back just verified. No parsing, no derivation, no inference:
 *  a file is obsolete precisely when the authoritative manifest does not name
 *  it. A renamed Profile's old file is correctly removed because the manifest
 *  no longer names it, and every current file is correctly kept because the
 *  manifest does.]
 */
async function cleanupOwnProfileFiles(profilesDir, declaredFileNames) {
  const removed = [];
  try {
    for await (const [name, handle] of profilesDir.entries()) {
      if (handle.kind !== "file" || !name.endsWith(".json")) continue;
      if (declaredFileNames.has(name)) continue;
      try {
        await profilesDir.removeEntry(name);
        removed.push(name);
      } catch {
        // Non-fatal: a file we could not remove is stale clutter, never a
        // correctness problem - readers only ever open declared files.
      }
    }
  } catch (error) {
    console.warn("[SYNCV3] Could not clean up this device's obsolete profile files (non-fatal).", error);
  }
  return removed;
}

/**
 * Removes directories that declare THIS device's own deviceId and are not the
 * one just published.
 *
 * [SYNCV3 / STAGE-02 / CONTENT-ADDRESSED-DEVICE-DISCOVERY]
 * [WHY: peer directories are NEVER touched, however stale they look. Deleting
 *  another device's subtree would break one-writer-per-device in the most
 *  damaging way available - the owner would republish it on its next pass, so
 *  the two devices would take turns deleting and recreating the same tree
 *  forever, and any generation a third device read in between would be a partial
 *  one. A stale peer duplicate is simply ignored for the read pass (see
 *  discoverDevices) and left for its owner to clean up, which it will, because
 *  this function is what its owner runs.]
 */
async function cleanupOwnStaleDirectories(devicesDir, deviceId, currentDirectoryName) {
  const removed = [];
  let names;
  try {
    names = await listDeviceDirectoryNames(devicesDir);
  } catch (error) {
    console.warn("[SYNCV3] Could not list device directories for own cleanup (non-fatal).", error);
    return removed;
  }

  for (const name of names) {
    if (name === currentDirectoryName) continue;
    const marker = await readOwnershipMarker(devicesDir, name);
    // Only a directory that EXPLICITLY declares our id is removable. "unreadable"
    // and "no manifest" are both left alone: neither is evidence of ownership,
    // and deleting on absence of proof is how a peer's subtree gets destroyed.
    if (marker.kind !== "device" || marker.deviceId !== deviceId) continue;
    try {
      await devicesDir.removeEntry(name, { recursive: true });
      removed.push(name);
    } catch (error) {
      console.warn(`[SYNCV3] Could not remove this device's stale directory "${name}" (non-fatal).`, error);
    }
  }
  return removed;
}

/**
 * Publishes `replica` under this device's own directory - data files first,
 * device.json last - then re-reads it and verifies every hash before treating
 * the publish as real, and only then performs cleanup of its OWN subtree.
 *
 * [SYNCV3 / STAGE-02 / CONTENT-ADDRESSED-DEVICE-DISCOVERY]
 * [WHY: the ordering is V2's, unchanged, because it is the part that was hard to
 *  get right: write -> read back -> recompute -> compare -> only then delete
 *  anything. A generation that does not survive its own read-back must never be
 *  treated as published, and in particular must never authorize a cleanup pass -
 *  under readable naming a premature cleanup would delete files the failed
 *  manifest no longer names, which is exactly the data the retry needs.]
 *
 * Returns { ok: true, directoryName, removedProfileFiles, removedStaleDirectories }
 *      or { ok: false, reason, directoryName }.
 */
export async function publishOwnReplicaVerified(devicesDir, { deviceId, label = null, replica }) {
  if (typeof deviceId !== "string" || !deviceId) {
    throw new Error("[SYNCV3] Refusing to publish without a deviceId.");
  }
  if (!isPlainObject(replica)) {
    throw new Error("[SYNCV3] Refusing to publish a replica that is not an object.");
  }

  // [SYNCV3 / STAGE-02 / CONTENT-ADDRESSED-DEVICE-DISCOVERY]
  // [WHY: occupancy is decided from OWNERSHIP markers, not from a full
  //  validation - see readOwnershipMarker. A directory is unavailable only when
  //  something that is provably not us has claimed it. Our own directory stays
  //  ours whether or not its current contents are valid, which is what lets a
  //  retry land back on the same directory instead of stranding it.]
  // [SYNCV3 / STAGE-04B / SHARED-LIBRARY-RECORD]
  // [WHY: normalized ONCE, then used for both the write and the verification
  //  comparison. Without this, a caller that omits an empty map writes a file
  //  containing {} (the `|| {}` fallbacks below have always done that) but then
  //  compares the read-back replica - which HAS the key - against its own input,
  //  which does not. The two differ in exactly one empty object and
  //  replicasEqual reports "changed", so the publish fails verification on every
  //  single pass, forever, looking exactly like corruption. That is the same
  //  failure shape the schemaVersion mismatch produced in Stage 03A, and it is
  //  latent for `associations` too - so both are normalized here rather than
  //  only the field this stage happens to add.]
  const normalized = {
    ...replica,
    associations: replica.associations || {},
    libraries: replica.libraries || {},
  };

  const ownership = await scanOwnership(devicesDir);
  const occupied = new Set();
  for (const [directoryName, marker] of ownership) {
    if (marker.kind === "device" && marker.deviceId === deviceId) continue;
    if (marker.kind === "none") continue;
    occupied.add(directoryName.toLowerCase());
  }

  const directoryName = resolveOwnDirectoryName({ deviceId, label, occupied });
  assertSafePathSegment(directoryName, "device directory name");

  const deviceDir = await devicesDir.getDirectoryHandle(directoryName, { create: true });
  const profilesDir = await deviceDir.getDirectoryHandle(PROFILES_DIR_NAME, { create: true });

  const profileIds = Object.keys(normalized.profiles || {}).sort();
  const fileNames = assignUniqueReadableNames(
    profileIds.map((id) => ({ id, human: profileHumanName(normalized, id) })),
    { fallback: PROFILE_NAME_FALLBACK, extension: ".json" }
  );

  const declared = [];
  const declaredFileNames = new Set();
  let hashAlgo = null;

  for (const profileId of profileIds) {
    const fileName = fileNames.get(profileId);
    assertSafePathSegment(fileName, "profile file name");
    const humanName = profileHumanName(normalized, profileId);
    const hash = await writeProfileFile(profilesDir, fileName, profileId, humanName, normalized.profiles[profileId]);
    hashAlgo = hash.algo;
    declared.push({
      id: profileId,
      name: humanName,
      file: `${PROFILES_DIR_NAME}/${fileName}`,
      hash: hash.value,
    });
    declaredFileNames.add(fileName);
  }

  const associations = await writeAssociationsFile(deviceDir, normalized.associations);
  hashAlgo = hashAlgo || associations.algo;

  // Written BEFORE device.json, like every other data file - the manifest is the
  // commit point and must be last (see the module header).
  const libraries = await writeLibrariesFile(deviceDir, normalized.libraries);
  hashAlgo = hashAlgo || libraries.algo;

  // Data files are all committed above; device.json is the commit point and must
  // be written last.
  await writeDeviceManifest(deviceDir, {
    schemaVersion: SCHEMA_VERSION,
    kind: DEVICE_KIND,
    // The authoritative identity. Everything else in this file, and every name
    // on disk, is presentation.
    deviceId,
    label: typeof label === "string" && label ? label : undefined,
    hashAlgo,
    // Recorded so a diagnostic can see what this device believed its own
    // directory was called at publish time. Never read back as identity.
    directoryName,
    profiles: declared,
    associationsFile: ASSOCIATIONS_FILE_NAME,
    associationsHash: associations.value,
    librariesFile: LIBRARIES_FILE_NAME,
    librariesHash: libraries.value,
    updatedAt: Date.now(),
  });

  let readBack;
  try {
    readBack = await readDeviceDirectory(devicesDir, directoryName);
  } catch (error) {
    return { ok: false, reason: "unreadable", directoryName };
  }
  if (readBack.status !== "valid") {
    return { ok: false, reason: readBack.reason || readBack.status, directoryName };
  }
  if (readBack.deviceId !== deviceId) {
    return { ok: false, reason: "device-id-changed", directoryName };
  }
  if (!replicasEqual(readBack.replica, normalized)) {
    return { ok: false, reason: "changed", directoryName };
  }

  const removedProfileFiles = await cleanupOwnProfileFiles(profilesDir, declaredFileNames);
  const removedStaleDirectories = await cleanupOwnStaleDirectories(devicesDir, deviceId, directoryName);

  return { ok: true, directoryName, removedProfileFiles, removedStaleDirectories };
}
