// [PROFILE-SYNC]
// WHAT: A thin sync LAYER on top of the existing Profile system
// (ProfileStore + its IndexedDB persistence) that mirrors the full Profile
// collection into a user-chosen folder — ideally one inside Google Drive —
// so multiple Browser Gallery installations pointed at the same folder can
// share Profile state conservatively.
//
// WHY: Browser Gallery must stay local-first. IndexedDB (via ProfileStore)
// remains the ONLY place Profile writes land synchronously and
// immediately; this module never intercepts or replaces that path — it
// only watches for changes (profile.subscribe) and, after a short
// debounce, mirrors the resulting collection out to a folder. If the
// folder is unavailable, permission-blocked, or the write fails, Profile
// functionality is completely unaffected: Favorites/Hidden/Tags/Profile
// switching/creation/deletion all keep working purely against IndexedDB.
//
// FUTURE / DO-NOT-BREAK:
//  - Do NOT make any Profile mutation depend on this module succeeding,
//    being connected, or even existing. ProfileStore must remain fully
//    usable with no ProfileSync instance at all.
//  - Do NOT let this module's directory handle get tied to media-source
//    selection (FSA library picking, legacy folder picking, Recent
//    Libraries). It is an entirely independent, separately-remembered
//    resource — see profile-sync-store.js's header. Loading a different
//    media library must never reconnect, disconnect, or otherwise touch
//    this module's connection.
//  - Do NOT resolve a genuine conflict (see [PROFILE-SYNC-BASELINE] below)
//    automatically, ever, no matter how tempting a timestamp-based
//    shortcut looks. That decision is explicitly reserved for the user.
//
// [PHASE-6-SYNC-V2]
// [STAGE-B-VERIFIED-PUBLISH]
// [WHY: a write ATTEMPT is not a successful sync. This module previously
//  computed a fingerprint, wrote the files, and accepted that fingerprint as
//  the baseline without ever reading back what actually landed — so a
//  generation whose files did not match its own manifest could become the
//  accepted baseline, and did. Publishing is now write -> read back ->
//  recompute -> compare, and the baseline advances only on equality. This
//  whole-collection transport is still the Sync V1 design and is scheduled for
//  replacement; Stage B's job is to make it incapable of blessing an
//  internally inconsistent generation while that replacement is built.]
import { loadSyncConfig, saveSyncConnection, updateSyncMeta, clearSyncConfig } from "../storage/profile-sync-store.js";
// [SYNCV3 / STAGE-01 / V3-ROOT-ISOLATION]
// [WHY: V3's lifecycle lives in THIS class rather than a second engine, because
//  the guarantees the module header already lists — one serialized reconcile
//  chain, one timer, one status surface, one subscribe() the UI renders from —
//  are properties of there being exactly one of this object. A parallel SyncV3
//  class would give two engines the same ProfileStore and two timers the same
//  Drive folder, which is the single failure mode this design has spent every
//  stage avoiding. V3 is therefore a MODE, not an engine.]
import {
  loadV3SyncConfig,
  saveV3SyncConnection,
  clearV3SyncConfig,
  loadV3ActivationState,
  saveV3ActivationState,
  clearV3ActivationState,
  ACTIVATION_V3,
  V2_ASSOCIATION_STORE,
  V3_ASSOCIATION_STORE,
} from "../storage/profile-sync-store.js";
// [SYNCV3 / STAGE-03A / V3-ASSOCIATION-ISOLATION-AND-PASS-SKELETON]
// [WHY: V3_LIVE_WRITES_ENABLED is imported here as well as consulted inside the
//  pass, because the scheduler has to make the same decision one level up: a
//  cadence that polls every three seconds to run a read-only pass that can never
//  publish is pure cost. Both readings come from the ONE constant, so enabling
//  live writes turns on the pass and its cadence together and cannot half-enable
//  either.]
import { runSyncV3Pass } from "./sync-v3.js";
import { V3_LIVE_WRITES_ENABLED } from "./sync-v3-write-policy.js";
import { DEFAULT_PROFILE_NAME } from "./indexeddb.js";
// [PHASE-6-SYNC-V2]
// [STAGE-E-LIVE-INTEGRATION]
// [WHY: routing lives HERE rather than in a parallel sync class because every
//  guarantee this module already owns — the ~3s debounce, the serialized
//  reconcile chain, queryPermission-never-requestPermission on auto passes, and
//  the single subscribe() the UI renders from — must hold identically for V2.
//  A second engine alongside this one would be a second chance for two passes
//  to overlap on the same folder handle, and a second status surface for the UI
//  to disagree with. One engine, one chain, one status; the MODE decides which
//  reconcile body runs, and nothing else changes.]
import { runSyncV2Pass } from "./sync-v2.js";
import { UNKNOWN_DEVICE_LABEL } from "./sync-v2-transport.js";
import {
  activateSyncV2 as runActivation,
  loadActivationState,
  ACTIVATION_V1,
  ACTIVATION_V2,
  ACTIVATION_FAILED,
} from "./sync-v2-activation.js";

const AUTO_SYNC_DEBOUNCE_MS = 3000;

// [PHASE-6-SYNC-V2]
// [STAGE-E-CONVERGENCE-SCHEDULER]
// [WHY: every active client must merge shared truth approximately every 3
//  seconds without requiring local activity. Before this, the ONLY reconcile
//  triggers were boot, reconnect, Sync Now, and a LOCAL ProfileStore mutation —
//  so a device sitting idle never looked at the folder again, and a peer's
//  change was invisible until its user happened to touch something. That is a
//  correctness gap, not a tuning problem: convergence was conditional on local
//  activity, which no distributed-state contract can be.]
const CONVERGENCE_POLL_MS = 3000;
const MANIFEST_FILE_NAME = "manifest.json";
const PROFILES_DIR_NAME = "profiles";
const MANIFEST_KIND = "gallery-profile-sync-manifest";
const MANIFEST_SCHEMA_VERSION = 1;
const PROFILE_FILE_KIND = "gallery-profile"; // matches ProfileStore#toJSON's `kind` — see writeCollectionToFolder

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// ---- Deterministic fingerprinting ------------------------------------
//
// [PROFILE-SYNC-BASELINE]
// WHAT: Turns a Profile collection into a stable, order-independent
// fingerprint string, and remembers the fingerprint from the last FULLY
// successful sync (the "baseline") — see ProfileSync's #baselineFingerprint
// field and #reconcileImpl below for how it's used.
// WHY: Device clocks differ and filesystem mtimes are unreliable, so
// "which side is newer" can never safely decide which Profile state wins.
// A content fingerprint sidesteps clocks entirely: two collections with
// identical content always hash identically, regardless of when or on
// which machine they were written. Deliberately excludes registry-level
// createdAt/updatedAt bookkeeping timestamps from what gets hashed — only
// genuine Profile content (identity, items, tags) affects the fingerprint.
// FUTURE / DO-NOT-BREAK: Never advance the baseline after a partial or
// failed sync (see #acceptBaseline, only ever called after a verified
// read or a verified completed write) — doing so can hide a real
// local/remote conflict and cause silent Profile data loss. Never use
// this fingerprint as anything OTHER than an equality check; it carries
// no ordering information ("newer/older") by design.
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
    return out;
  }
  return value;
}

function profileFingerprintPayload(entry) {
  return {
    id: entry.id,
    name: entry.name || "",
    masterFolder: entry.masterFolder && entry.masterFolder.name ? entry.masterFolder.name : null,
    items: canonicalize(entry.items || {}),
    tags: [...(entry.tags || [])]
      .slice()
      .sort((a, b) => (a.id > b.id ? 1 : a.id < b.id ? -1 : 0))
      .map(canonicalize),
  };
}

function collectionFingerprintPayload(collection) {
  return [...collection]
    .slice()
    .sort((a, b) => (a.id > b.id ? 1 : a.id < b.id ? -1 : 0))
    .map(profileFingerprintPayload);
}

// Exported for the Stage B regression harness (tools/test-sync-publish.mjs),
// which must assert against the REAL fingerprint algorithm rather than a second
// copy of it that could drift. Nothing in the app imports it.
export async function computeFingerprint(collection) {
  const text = JSON.stringify(collectionFingerprintPayload(collection));

  if (typeof crypto !== "undefined" && crypto.subtle && typeof crypto.subtle.digest === "function") {
    try {
      const bytes = new TextEncoder().encode(text);
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    } catch {
      // Fall through to the manual hash below (e.g. digest unsupported for
      // this input in some non-secure-context environment).
    }
  }

  // Fallback for environments without SubtleCrypto — same reasoning as
  // generateProfileId()'s non-secure-context fallback in indexeddb.js.
  // Not cryptographically strong, but this only needs to be a stable
  // equality check, not tamper-proof.
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function isMeaningfulCollection(collection) {
  if (!Array.isArray(collection) || collection.length === 0) return false;
  if (collection.length > 1) return true;
  const [only] = collection;
  const hasItems = only.items && Object.keys(only.items).length > 0;
  const hasTags = Array.isArray(only.tags) && only.tags.length > 0;
  return Boolean(hasItems || hasTags);
}

// ---- Sync-folder file layout -------------------------------------------
//
// Browser Gallery Profiles/
// ├── manifest.json            { profileIds, fingerprint, updatedAt }
// └── profiles/
//     ├── <profile-id>.json    one full ProfileStore#toJSON()-shaped file
//     └── ...

function parseProfileFile(text) {
  const parsed = JSON.parse(text);
  if (
    !isPlainObject(parsed) ||
    parsed.kind !== PROFILE_FILE_KIND ||
    typeof parsed.profileId !== "string" ||
    !parsed.profileId ||
    !isPlainObject(parsed.items)
  ) {
    throw new Error("Not a recognized synced profile file.");
  }

  return {
    id: parsed.profileId,
    name: typeof parsed.profileName === "string" && parsed.profileName ? parsed.profileName : DEFAULT_PROFILE_NAME,
    masterFolder: isPlainObject(parsed.masterFolder) ? parsed.masterFolder : null,
    items: parsed.items,
    tags: Array.isArray(parsed.tags) ? parsed.tags : [],
  };
}

/**
 * Reads and validates whatever Profile collection currently exists in the
 * sync folder. Returns one of:
 *   { status: "empty" }                                — no manifest.json at all
 *   { status: "invalid" }                               — present but unreadable/inconsistent
 *   { status: "valid", collection, fingerprint }         — safely usable
 *
 * "invalid" deliberately covers malformed JSON, a manifest referencing a
 * profile file that's missing/unparseable, AND a manifest whose fingerprint
 * doesn't match what's actually on disk (which is exactly the signature of
 * a write that was interrupted between writing profile files and
 * committing the manifest — see writeCollectionToFolder below). Any of
 * these must be treated as "cannot trust this," never partially applied.
 */
export async function readCollectionFromFolder(dirHandle) {
  let manifestText;
  try {
    const manifestHandle = await dirHandle.getFileHandle(MANIFEST_FILE_NAME);
    const file = await manifestHandle.getFile();
    manifestText = await file.text();
  } catch (error) {
    if (error && error.name === "NotFoundError") return { status: "empty" };
    return { status: "invalid" };
  }

  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    return { status: "invalid" };
  }

  if (
    !isPlainObject(manifest) ||
    manifest.kind !== MANIFEST_KIND ||
    !Array.isArray(manifest.profileIds) ||
    typeof manifest.fingerprint !== "string"
  ) {
    return { status: "invalid" };
  }

  if (manifest.profileIds.length === 0) {
    const fingerprint = await computeFingerprint([]);
    if (fingerprint !== manifest.fingerprint) return { status: "invalid" };
    return { status: "valid", collection: [], fingerprint: manifest.fingerprint };
  }

  let profilesDir;
  try {
    profilesDir = await dirHandle.getDirectoryHandle(PROFILES_DIR_NAME);
  } catch {
    return { status: "invalid" };
  }

  const collection = [];
  for (const id of manifest.profileIds) {
    if (typeof id !== "string" || !id) return { status: "invalid" };
    try {
      const fileHandle = await profilesDir.getFileHandle(`${id}.json`);
      const file = await fileHandle.getFile();
      const text = await file.text();
      collection.push(parseProfileFile(text));
    } catch {
      return { status: "invalid" };
    }
  }

  const recomputed = await computeFingerprint(collection);
  if (recomputed !== manifest.fingerprint) return { status: "invalid" };

  return { status: "valid", collection, fingerprint: manifest.fingerprint };
}

// [SAFE-SYNC-WRITE]
// WHAT: Writes a full Profile collection into the sync folder as one
// per-profile file each, then commits manifest.json LAST, then (only after
// that succeeds) removes any leftover per-profile files for profiles no
// longer in the collection.
// WHY: createWritable()/close() is relied on as the safest per-file
// primitive this FSA implementation offers — writes go to a temporary swap
// file and only replace the real file atomically at close(). Committing
// the manifest last means nothing ever reads a manifest that points at
// profile files that haven't actually been written yet; readCollectionFromFolder
// re-validates the fingerprint on every read specifically to catch the
// case where this write was interrupted midway (some profile files
// updated, manifest still pointing at the old fingerprint) — that shows up
// as "invalid", never as a silently-adopted partial state.
// FUTURE / DO-NOT-BREAK: Do not reorder this — manifest must always be
// last. Do not delete stale profile files before the manifest commit;
// a crash between those two steps must always leave the PREVIOUS valid
// representation (manifest + its referenced files) intact, never a
// half-updated one with nothing to recover to.
//
// [PHASE-6-SYNC-V2]
// [STAGE-B-VERIFIED-PUBLISH]
// [WHY: this function now only WRITES. Removing obsolete per-profile files —
//  the one irreversible part of publishing — moved out to
//  removeObsoleteProfileFiles() below so the caller can withhold it until the
//  generation has been read back and verified. Deleting files on the strength
//  of a publish we could not verify is how an unverifiable pass turns into
//  actual data loss.]
async function writeCollectionToFolder(dirHandle, collection, fingerprint) {
  const profilesDir = await dirHandle.getDirectoryHandle(PROFILES_DIR_NAME, { create: true });

  for (const entry of collection) {
    const fileHandle = await profilesDir.getFileHandle(`${entry.id}.json`, { create: true });
    const writable = await fileHandle.createWritable();
    const payload = {
      schemaVersion: 2,
      kind: PROFILE_FILE_KIND,
      exportedAt: new Date().toISOString(),
      profileId: entry.id,
      profileName: entry.name,
      masterFolder: entry.masterFolder || null,
      items: entry.items || {},
      tags: entry.tags || [],
    };
    await writable.write(JSON.stringify(payload, null, 2));
    await writable.close();
  }

  const manifestHandle = await dirHandle.getFileHandle(MANIFEST_FILE_NAME, { create: true });
  const manifestWritable = await manifestHandle.createWritable();
  const manifestPayload = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    kind: MANIFEST_KIND,
    profileIds: collection.map((entry) => entry.id),
    fingerprint,
    updatedAt: Date.now(),
  };
  await manifestWritable.write(JSON.stringify(manifestPayload, null, 2));
  await manifestWritable.close();
}

// Best-effort cleanup of files for profiles no longer in the collection
// (e.g. a deleted Profile). Never fatal: an orphaned file left behind by a
// failure here references nothing the manifest points at, and the next
// successful full write cleans it up anyway.
//
// [PHASE-6-SYNC-V2][STAGE-B-VERIFIED-PUBLISH]
// [WHY: called only AFTER read-back verification succeeds. These deletes are
//  the single irreversible step in a publish, so they must never run on the
//  strength of a generation we could not confirm we actually wrote.]
async function removeObsoleteProfileFiles(dirHandle, collection) {
  try {
    const profilesDir = await dirHandle.getDirectoryHandle(PROFILES_DIR_NAME, { create: true });
    const currentIds = new Set(collection.map((entry) => entry.id));
    for await (const [name, handle] of profilesDir.entries()) {
      if (handle.kind !== "file" || !name.endsWith(".json")) continue;
      const id = name.slice(0, -".json".length);
      if (!currentIds.has(id)) {
        await profilesDir.removeEntry(name).catch(() => undefined);
      }
    }
  } catch (error) {
    console.warn("[PROFILE-SYNC] Could not clean up obsolete profile files (non-fatal).", error);
  }
}

/**
 * ProfileSync — owns the connection to a sync folder and the conservative
 * three-way reconciliation between local Profile state (via ProfileStore)
 * and whatever's currently in that folder. See the module header above for
 * the architectural rules this must never violate.
 */
export class ProfileSync {
  #profile;
  #dirHandle = null;
  #folderName = null;
  #autoSync = false;
  #baselineFingerprint = null;
  #lastSyncAt = null;
  #status = "checking"; // overwritten by init() almost immediately
  #message = null;
  #listeners = new Set();
  #debounceTimer = null;
  #reconcileChain = Promise.resolve();
  #applyingRemote = false; // guards against our own replaceAllProfiles() re-triggering a redundant auto-sync pass

  // ---- Sync V2 activation (Stage E) --------------------------------------
  //
  // #mode is this installation's persisted transport. Read once at init() and
  // updated only by activateV2(). Defaults to V1 rather than "unknown": every
  // installation that predates Stage E genuinely IS V1, and a mode that could
  // read as neither would leave #reconcileImpl with no defined behaviour.
  #mode = ACTIVATION_V1;
  #activation = null;
  #lastPassInfo = null; // { mergedPeers, skippedPeers } from the most recent V2 pass

  // ---- SyncV3 connection (SyncV3, Stage 01) ------------------------------
  //
  // [SYNCV3 / STAGE-01 / V3-ROOT-ISOLATION]
  // [WHY: a SEPARATE handle field, never a reassignment of #dirHandle. #dirHandle
  //  is read by #reconcileV1, #reconcileV2, activateSyncV2's migration source and
  //  disconnect() — every one of which is V1/V2 machinery that must keep pointing
  //  at the V1/V2 folder no matter what mode is active. Pointing #dirHandle at the
  //  V3 folder would make "Disconnect Sync" clear the V2 row while releasing the
  //  V3 folder, and would make a later V2 activation migrate FROM the V3 root.
  //  Two fields cost nothing; one field that means different folders at different
  //  times is how a transport writes into the wrong tree.]
  #v3DirHandle = null;
  #v3FolderName = null;
  #v3ConnectedAt = null;
  #v3ActivatedAt = null;
  // "not-configured" | "permission-needed" | "ready". Tracked independently of
  // #status so connecting a V3 folder while still running V2 cannot overwrite
  // the V2 status line the user is reading. When mode IS v3, #status mirrors
  // this as "v3-<value>" — see #refreshV3Connection.
  #v3Status = "not-configured";
  // Per-pass carry-over for the V3 pass, mirroring #passState's role for V2:
  // what this device last successfully published, so the pass can tell "our own
  // generation is still propagating" from "our own generation is wrong".
  #v3PassState = {};
  #lastV3PassInfo = null;
  // [PHASE-6-SYNC-V2][STAGE-E-LIVE-INTEGRATION]
  // [WHY: started in the CONSTRUCTOR and awaited by #reconcileImpl, so no
  //  reconcile can possibly run before this installation's transport is known.
  //  Loading it in init() alone was not enough: connectNewFolder() reconciles
  //  too, and a caller that reached it without init() having finished would run
  //  the default (V1) transport on an installation that had already cut over —
  //  writing V1 after cutover, which the policy forbids absolutely.]
  #activationReady;

  // ---- Convergence scheduler (Stage E follow-up) -------------------------
  //
  // ONE timer, never an interval: it is armed only after the previous pass has
  // fully settled (see #reconcile's finally), which makes overlapping passes
  // structurally impossible rather than merely unlikely. #armPollTimer always
  // clears before arming, so no lifecycle path — repeated init(), reconnect(),
  // connectNewFolder(), activation — can leave two timers running.
  #pollTimer = null;
  #disposed = false;
  // [PHASE-6-SYNC-V2][STAGE-E-REAL-DRIVE-HASH-RECOVERY]
  // [WHY: carries what this device last successfully published across passes, so
  //  runSyncV2Pass can tell "our own generation is still propagating" apart from
  //  "our own generation is wrong". Lives on the engine because a pass is a pure
  //  function; deliberately in-memory only — a fresh boot has no memory of a
  //  previous publish and correctly falls back to re-reading the folder.]
  #passState = {};
  #environmentListeners = [];

  constructor(profileStore) {
    this.#profile = profileStore;
    this.#activationReady = this.#loadActivation();
    this.#installEnvironmentTriggers();
    // A single subscription drives every auto-sync trigger: favorites,
    // hidden, tags, tag vocabulary, profile create/switch/delete/rename,
    // and import all funnel through ProfileStore's #emit() already (see
    // profile-store.js) — nothing sync-specific needs to be added there.
    this.#profile.subscribe(() => this.#onProfileChanged());
  }

  // ---- Boot / connection lifecycle --------------------------------------

  /**
   * Called once at app boot. Reads whatever sync-folder relationship was
   * remembered on this installation and, if permission is already usable,
   * connects silently and runs one reconcile pass. Never opens a folder
   * picker itself — see [PROFILE-SYNC] header: only an explicit user
   * action (Choose/Change/Reconnect) may do that.
   */
  async #loadActivation() {
    try {
      this.#activation = await loadActivationState();
      this.#mode = this.#activation.mode;
    } catch (error) {
      console.warn("[PROFILE-SYNC] Could not read the sync activation state; staying on V1.", error);
      this.#mode = ACTIVATION_V1;
    }

    // [SYNCV3 / STAGE-01 / V3-ROOT-ISOLATION]
    // [WHY: THE precedence rule, stated once, here, and nowhere else. Two
    //  persisted rows can describe the transport, so exactly one line has to
    //  decide between them or the ambiguity spreads: V3's own row wins if and
    //  only if it explicitly says "v3"; in every other case the V2 row decides,
    //  byte-for-byte as it always has. This is a comparison of two explicit
    //  values — never an inference from whether a folder was chosen or a
    //  directory exists, which is the reading ACTIVATION_RECORD_ID's own
    //  comment rules out.
    //
    //  A failure to READ the V3 row deliberately leaves the V2 answer standing.
    //  Defaulting to V3 on an unreadable row would activate an experimental
    //  transport because of a storage glitch.]
    try {
      const v3 = await loadV3ActivationState();
      if (v3.mode === ACTIVATION_V3) {
        this.#mode = ACTIVATION_V3;
        this.#v3ActivatedAt = v3.activatedAt;
      }
    } catch (error) {
      console.warn("[SYNCV3] Could not read the V3 activation state; leaving the transport as V2/V1 recorded it.", error);
    }

    // Connection metadata only — no permission call, no picker, no I/O against
    // the folder itself. Whether that handle is actually usable is answered by
    // #refreshV3Connection, which every entry point below runs explicitly.
    try {
      const config = await loadV3SyncConfig();
      if (config && config.handle) {
        this.#v3DirHandle = config.handle;
        this.#v3FolderName = config.folderName || config.handle.name || "V3 Sync Folder";
        this.#v3ConnectedAt = config.connectedAt;
      }
    } catch (error) {
      console.warn("[SYNCV3] Could not read the saved V3 sync configuration.", error);
    }

    // Last, because it depends on the mode every branch above may have changed.
    await this.#applyAssociationStoreForMode();
  }

  // [SYNCV3 / STAGE-03A / V3-ASSOCIATION-ISOLATION-AND-PASS-SKELETON]
  // [WHY: the ONE place that decides which association row ProfileStore uses,
  //  and it decides it from the one place that already knows the transport mode.
  //  ProfileStore is never told what mode is running — it is handed an adapter —
  //  so "which row?" cannot drift apart from "which transport?" the way two
  //  independent mode checks eventually would.
  //
  //  Tolerant of a store without the method so a test double, or a future
  //  ProfileStore-shaped object, does not have to implement it to be usable.]
  async #applyAssociationStoreForMode() {
    if (!this.#profile || typeof this.#profile.setAssociationStore !== "function") return;
    const store = this.#mode === ACTIVATION_V3 ? V3_ASSOCIATION_STORE : V2_ASSOCIATION_STORE;
    try {
      await this.#profile.setAssociationStore(store);
    } catch (error) {
      console.warn(`[SYNCV3] Could not point the association cache at "${store.id}".`, error);
    }
  }

  async init() {
    // Which transport this installation uses decides what every step below is
    // even allowed to write, so it is resolved before anything touches the
    // folder. Started in the constructor; merely awaited here.
    await this.#activationReady;

    // [SYNCV3 / STAGE-01 / V3-ROOT-ISOLATION]
    // [WHY: returns BEFORE the V1/V2 body below, which would otherwise adopt the
    //  V2 handle, announce "connected", and run a reconcile pass — against the V2
    //  folder, in V3 mode. Leaving early means a V3-mode installation performs no
    //  I/O whatsoever against the V1/V2 tree at boot. The V2 connection row is
    //  read by nothing here and therefore cannot be modified by anything here: it
    //  survives untouched, ready for deactivateSyncV3() to restore.]
    if (this.#mode === ACTIVATION_V3) {
      await this.#refreshV3Connection();
      // #shouldPoll() is false in V3 mode, so this clears any timer and arms
      // nothing — V3 has no transport pass to schedule yet.
      this.#armPollTimer();
      return;
    }

    let config;
    try {
      config = await loadSyncConfig();
    } catch (error) {
      console.warn("[PROFILE-SYNC] Could not read saved sync configuration.", error);
      config = null;
    }

    if (!config || !config.handle) {
      this.#status = "not-configured";
      this.#armPollTimer();
      this.#emit();
      return;
    }

    this.#dirHandle = config.handle;
    this.#folderName = config.folderName || config.handle.name || "Sync Folder";
    this.#autoSync = config.autoSync !== false;
    this.#baselineFingerprint = config.baselineFingerprint;
    this.#lastSyncAt = config.lastSyncAt;

    let permission;
    try {
      permission = await this.#dirHandle.queryPermission({ mode: "readwrite" });
    } catch (error) {
      console.warn("[PROFILE-SYNC] The saved sync folder handle is no longer usable.", error);
      this.#status = "permission-needed";
      this.#message = "The saved folder is no longer accessible.";
      this.#emit();
      return;
    }

    if (permission !== "granted") {
      this.#status = "permission-needed";
      this.#emit();
      return;
    }

    this.#status = "connected";
    this.#emit();
    await this.#reconcile();
  }

  /**
   * Restores access to the ALREADY-saved sync folder — never opens a new
   * picker. Only requestPermission() (which needs a user gesture; this is
   * always called from a click handler) can turn "permission-needed" back
   * into "connected" without the user re-choosing the folder.
   */
  async reconnect() {
    if (!this.#dirHandle) {
      this.#status = "not-configured";
      this.#emit();
      return;
    }

    this.#status = "checking";
    this.#message = null;
    this.#emit();

    try {
      let permission = await this.#dirHandle.queryPermission({ mode: "readwrite" });
      if (permission !== "granted") {
        permission = await this.#dirHandle.requestPermission({ mode: "readwrite" });
      }
      if (permission !== "granted") {
        this.#status = "permission-needed";
        this.#message = "Access was not granted.";
        this.#emit();
        return;
      }
    } catch (error) {
      console.error("[PROFILE-SYNC] The saved sync folder is no longer accessible.", error);
      this.#status = "permission-needed";
      this.#message = "The saved folder is no longer accessible.";
      this.#emit();
      return;
    }

    this.#status = "connected";
    this.#emit();
    await this.#reconcile();
  }

  /**
   * Connects a freshly-picked directory handle (from showDirectoryPicker,
   * called by the caller BEFORE this — main.js is responsible for the
   * Google Drive explanation and the picker call itself; this only takes
   * the resulting handle and owns everything from here). Auto Sync turns
   * on immediately — no separate "enable syncing" step.
   */
  async connectNewFolder(dirHandle) {
    if (this.#debounceTimer) {
      clearTimeout(this.#debounceTimer);
      this.#debounceTimer = null;
    }

    this.#dirHandle = dirHandle;
    this.#folderName = dirHandle.name;
    this.#autoSync = true;
    this.#baselineFingerprint = null;
    this.#lastSyncAt = null;
    this.#status = "checking";
    this.#message = null;
    this.#emit();

    try {
      await saveSyncConnection(dirHandle, { autoSync: true });
    } catch (error) {
      // Persistence failing doesn't block using the folder THIS session —
      // it just won't be resumable next time (same tolerance
      // library-registry.js's addOrUpdateLibrary already uses).
      console.warn("[PROFILE-SYNC] Could not persist the sync folder for future sessions.", error);
    }

    await this.#reconcile();
  }

  /**
   * "Disconnect Sync" — forgets the folder relationship only. Profile data itself is untouched.
   *
   * [SYNCV3 / STAGE-01 / V3-ROOT-ISOLATION]
   * [WHY: deliberately NOT extended to clear anything V3. clearSyncConfig() can
   *  only address the V2 connection row, and every field reset below is a V1/V2
   *  field — so "V2 disconnect must not delete V3 configuration" holds by
   *  construction rather than by a guard someone could later remove.]
   */
  async disconnect() {
    if (this.#debounceTimer) {
      clearTimeout(this.#debounceTimer);
      this.#debounceTimer = null;
    }

    try {
      await clearSyncConfig();
    } catch (error) {
      console.warn("[PROFILE-SYNC] Could not clear the saved sync configuration.", error);
    }

    this.#dirHandle = null;
    this.#folderName = null;
    this.#autoSync = false;
    this.#baselineFingerprint = null;
    this.#lastSyncAt = null;
    this.#status = "not-configured";
    this.#message = null;
    // #shouldPoll() is now false, so this clears the timer and arms nothing.
    this.#armPollTimer();
    this.#emit();
  }

  /** "Sync Now" — manual trigger, bypasses the debounce and runs immediately. */
  async syncNow() {
    // [SYNCV3 / STAGE-01 / V3-ROOT-ISOLATION]
    // [WHY: "Sync Now" has nothing to do in V3 mode, and must not pretend
    //  otherwise. Returning here rather than letting the pass reach #reconcileV3
    //  keeps the button honest: no status flicker through "Syncing…", no
    //  lastSyncAt refresh, no implication that a V3 sync exists yet.]
    //
    // [SYNCV3 / STAGE-03A / V3-ASSOCIATION-ISOLATION-AND-PASS-SKELETON]
    // [WHY: now runs the real pass instead of returning. It remains honest while
    //  live writes are off because the PASS is what refuses to write — it reads,
    //  merges and adopts, creates no directory, publishes nothing, and reports
    //  publishBlocked. A manual Sync Now that adopts a peer's changes is useful;
    //  one that silently did nothing at all was not.]
    if (this.#mode === ACTIVATION_V3) {
      if (!this.#v3DirHandle) return;
      if (this.#debounceTimer) {
        clearTimeout(this.#debounceTimer);
        this.#debounceTimer = null;
      }
      await this.#reconcile();
      return;
    }
    if (!this.#dirHandle) return;
    if (this.#debounceTimer) {
      clearTimeout(this.#debounceTimer);
      this.#debounceTimer = null;
    }
    await this.#reconcile();
  }

  /**
   * Explicit user resolution of a conflict state (see #enterConflict).
   * choice: "use-synced" | "keep-local". Only after this succeeds does a
   * new baseline get established — see #acceptBaseline.
   */
  /**
   * [PHASE-6-SYNC-V2]
   * [STAGE-E-LIVE-INTEGRATION]
   * [WHY: activation is user-initiated and one-way by design. It runs through
   *  the same serialized reconcile chain as every other pass so it can never
   *  interleave with one — an activation landing halfway through a V1 publish
   *  would be exactly the V1+V2 coexistence the policy forbids. On success the
   *  very next pass is already V2; on failure #mode becomes ACTIVATION_FAILED
   *  and #reconcileImpl refuses BOTH transports rather than falling back to
   *  V1, because a partially-migrated installation is no longer described by
   *  V1's own data.]
   */
  async activateSyncV2() {
    await this.#activationReady;
    if (this.#mode === ACTIVATION_V2) return { ok: true, alreadyActive: true };

    // [SYNCV3 / STAGE-01 / V3-ROOT-ISOLATION]
    // [WHY: refuses loudly instead of half-working. Running this while V3 is
    //  active would flip the in-memory #mode to v2 and start V2 passes, but the
    //  V3 activation row would still say "v3" — so the very next reload would
    //  silently revert to V3, with a V2 migration already run in between. Leaving
    //  V3 is an explicit act (deactivateSyncV3), and it must happen first so
    //  there is only ever one recorded transport to come back to.]
    if (this.#mode === ACTIVATION_V3) {
      console.warn("[SYNCV3] Refusing to activate Sync V2 while Sync V3 is active — leave V3 mode first.");
      return { ok: false, mode: ACTIVATION_V3, blockedByV3: true };
    }

    const run = async () => {
      this.#status = "syncing";
      this.#message = "Activating Sync V2…";
      this.#emit();

      const result = await runActivation({ profileStore: this.#profile, dirHandle: this.#dirHandle });
      this.#mode = result.mode;
      this.#activation = { mode: result.mode, activatedAt: Date.now(), migration: result.migration };

      if (!result.ok) {
        this.#status = "migration-failed";
        this.#message =
          (result.migration && result.migration.reason) ||
          "Sync activation did not finish. Your Profile data is safe and saved locally.";
        this.#emit();
        return result;
      }

      // Immediately run the first real V2 pass so the status the user sees
      // reflects an actual verified pass, not merely "we flipped a flag".
      await this.#reconcileImpl();
      // Called explicitly because this is the one pass that does NOT go through
      // #reconcile() (it is already inside the chain), so it misses that
      // method's re-arm. This is what starts polling at the moment of cutover.
      this.#armPollTimer();
      return result;
    };

    this.#reconcileChain = this.#reconcileChain.then(run, run);
    return this.#reconcileChain;
  }

  /** This installation's transport mode — "v1" | "v2" | "v3" | "failed". */
  getActivation() {
    return { mode: this.#mode, ...(this.#activation || {}) };
  }

  // ---- SyncV3 lifecycle (SyncV3, Stage 01) --------------------------------
  //
  // [SYNCV3 / STAGE-01 / V3-ROOT-ISOLATION]
  // [WHY: connection plumbing ONLY. Not one function in this section opens,
  //  creates, reads or writes a single file inside the chosen folder — the V3
  //  directory is expected to be completely empty after this stage, and a
  //  placeholder written merely to prove the handle works would be indistinguish-
  //  able, to the next stage's transport, from a real generation left by a peer.]

  /**
   * Re-checks whether the remembered V3 folder is currently usable and updates
   * the V3 status. `request: true` may prompt, so it is only ever passed from a
   * real click (reconnectV3) — every other caller is silent, matching the
   * queryPermission-never-requestPermission rule the V1/V2 paths already follow
   * for anything not driven by a user gesture.
   */
  async #refreshV3Connection({ request = false } = {}) {
    if (!this.#v3DirHandle) {
      this.#v3Status = "not-configured";
    } else {
      let permission = null;
      try {
        permission = await this.#v3DirHandle.queryPermission({ mode: "readwrite" });
        if (permission !== "granted" && request) {
          permission = await this.#v3DirHandle.requestPermission({ mode: "readwrite" });
        }
      } catch (error) {
        console.warn("[SYNCV3] The saved V3 sync folder handle is no longer usable.", error);
        permission = null;
      }
      this.#v3Status = permission === "granted" ? "ready" : "permission-needed";
    }

    // [SYNCV3 / STAGE-01 / V3-ROOT-ISOLATION]
    // [WHY: #status is only touched while V3 is the ACTIVE transport. Connecting
    //  a V3 folder is allowed before activating V3, and doing so must not
    //  overwrite the V1/V2 status line describing a sync that is still really
    //  running. The V3 panel reads #v3Status, which is always current.]
    if (this.#mode === ACTIVATION_V3) {
      this.#status = `v3-${this.#v3Status}`;
      this.#message = null;
    }
    this.#emit();
  }

  /**
   * Connects a freshly-picked V3 directory handle. The caller runs the picker
   * (same division of responsibility connectNewFolder already has with main.js).
   */
  async connectV3Folder(dirHandle) {
    await this.#activationReady;

    this.#v3DirHandle = dirHandle;
    this.#v3FolderName = dirHandle.name;
    this.#v3ConnectedAt = Date.now();

    try {
      await saveV3SyncConnection(dirHandle);
    } catch (error) {
      // Same tolerance connectNewFolder applies: an unpersisted handle still
      // works for this session, it just will not resume after a reload.
      console.warn("[SYNCV3] Could not persist the V3 sync folder for future sessions.", error);
    }

    await this.#refreshV3Connection();
  }

  /** Restores access to the ALREADY-saved V3 folder. Needs a user gesture; never opens a picker. */
  async reconnectV3() {
    await this.#activationReady;
    await this.#refreshV3Connection({ request: true });
  }

  /** "Disconnect V3" — forgets the V3 folder relationship. Touches no V2 record and no Profile data. */
  async disconnectV3() {
    await this.#activationReady;

    try {
      await clearV3SyncConfig();
    } catch (error) {
      console.warn("[SYNCV3] Could not clear the saved V3 sync configuration.", error);
    }

    this.#v3DirHandle = null;
    this.#v3FolderName = null;
    this.#v3ConnectedAt = null;
    await this.#refreshV3Connection();
  }

  /**
   * Activates SyncV3 on this installation.
   *
   * [SYNCV3 / STAGE-01 / V3-ROOT-ISOLATION]
   * [WHY: nothing like activateSyncV2's migration happens here, and that is not
   *  an omission. V3 starts from a FRESH Drive root by decision, so there is no
   *  prior V3 generation to recover and nothing to seed — and seeding from V2
   *  would be exactly the "write V2's schema into V3" the design forbids. This
   *  writes one row and re-reports status.
   *
   *  Queued on the same reconcile chain as every other pass so it can never
   *  interleave with one — an activation landing mid-publish is the same hazard
   *  activateSyncV2 documents, and the answer is the same single chain.
   *
   *  V2's in-memory connection is released (the ROW is left untouched) so no
   *  V2/V1 code path can find a handle to act on while V3 is the active mode.]
   */
  async activateSyncV3() {
    await this.#activationReady;
    if (this.#mode === ACTIVATION_V3) return { ok: true, alreadyActive: true, mode: ACTIVATION_V3 };

    const run = async () => {
      const activatedAt = Date.now();
      try {
        await saveV3ActivationState({ activatedAt });
      } catch (error) {
        console.error("[SYNCV3] Could not record V3 activation.", error);
        return { ok: false, mode: this.#mode, reason: "Could not record V3 activation." };
      }

      if (this.#debounceTimer) {
        clearTimeout(this.#debounceTimer);
        this.#debounceTimer = null;
      }

      this.#mode = ACTIVATION_V3;
      this.#v3ActivatedAt = activatedAt;
      this.#dirHandle = null;
      this.#folderName = null;
      this.#autoSync = false;
      this.#baselineFingerprint = null;
      this.#lastPassInfo = null;
      this.#passState = {};
      // A fresh transport gets fresh per-pass carry-over; the V2 settle state
      // describes a different folder entirely.
      this.#v3PassState = {};
      this.#lastV3PassInfo = null;

      // [SYNCV3 / STAGE-03A / V3-ASSOCIATION-ISOLATION-AND-PASS-SKELETON]
      // [WHY: repointed the moment the mode changes, not at the next boot. This
      //  is the one path that flips the mode WITHOUT going through
      //  #loadActivation, so without this line the installation would run V3 for
      //  the rest of the session while still reading and writing the V2
      //  association cache - the exact contamination this stage prevents, in the
      //  one window nobody would think to test.]
      await this.#applyAssociationStoreForMode();

      await this.#refreshV3Connection();
      // Arms the V3 cadence once live writes are enabled, and nothing while they
      // are off - see #shouldPoll.
      this.#armPollTimer();
      return { ok: true, mode: ACTIVATION_V3 };
    };

    this.#reconcileChain = this.#reconcileChain.then(run, run);
    return this.#reconcileChain;
  }

  /**
   * Leaves V3 mode and returns the installation to whatever V2's own record says
   * it was — v1, v2, or failed.
   *
   * [SYNCV3 / STAGE-01 / V3-ROOT-ISOLATION]
   * [WHY: re-runs #loadActivation and then the ordinary init() rather than
   *  restoring remembered fields by hand. Those fields were deliberately dropped
   *  on activation, and reconstructing them here would be a second, drifting copy
   *  of boot. Re-reading the untouched rows is both shorter and the only version
   *  that cannot disagree with what a real reload would do — which is precisely
   *  what "V2 still behaves exactly as before" has to mean.]
   */
  async deactivateSyncV3() {
    await this.#activationReady;

    try {
      await clearV3ActivationState();
    } catch (error) {
      console.error("[SYNCV3] Could not clear the V3 activation state.", error);
      return { ok: false, mode: this.#mode };
    }

    this.#v3ActivatedAt = null;
    this.#status = "checking";
    this.#message = null;
    this.#emit();

    this.#activationReady = this.#loadActivation();
    await this.init();
    return { ok: true, mode: this.#mode };
  }

  /**
   * [PHASE-6-SYNC-V2][STAGE-E-LIVE-INTEGRATION]
   * [WHY: recovery ONLY. Normal V2 reconciliation never reaches "conflict" —
   *  there is no code path in #reconcileV2 that sets it — so this can only be
   *  entered from a V1-mode installation, or deliberately by the recovery UI.
   *  The V1 guard below is what keeps a V2 installation from being talked into
   *  a whole-collection overwrite by a stale UI state: after cutover, V1's
   *  collection no longer describes this installation.]
   */
  async resolveConflict(choice) {
    if (this.#mode === ACTIVATION_V2) {
      console.warn("[SYNC-V2] Refusing a Keep Local / Use Synced resolution on a V2 installation.");
      return;
    }
    if (this.#status !== "conflict" || !this.#dirHandle) return;

    this.#status = "syncing";
    this.#message = null;
    this.#emit();

    try {
      if (choice === "use-synced") {
        const remote = await readCollectionFromFolder(this.#dirHandle);
        if (remote.status !== "valid") {
          this.#status = "conflict";
          this.#message = "Could not read the synced version — try again.";
          this.#emit();
          return;
        }
        await this.#applyRemote(remote);
      } else if (choice === "keep-local") {
        const localCollection = await this.#profile.getFullCollection();
        const localFingerprint = await computeFingerprint(localCollection);
        await this.#publishVerified(localCollection, localFingerprint);
      }
    } catch (error) {
      console.error("[PROFILE-SYNC] Could not resolve the sync conflict.", error);
      this.#status = "conflict";
      this.#message = (error && error.message) || "Could not complete — try again.";
      this.#emit();
    }
  }

  // ---- Status / subscription ---------------------------------------------

  getStatus() {
    return {
      configured: Boolean(this.#dirHandle),
      status: this.#status,
      folderName: this.#folderName,
      autoSync: this.#autoSync,
      lastSyncAt: this.#lastSyncAt,
      message: this.#message,
      // [PHASE-6-SYNC-V2][STAGE-B-VERIFIED-PUBLISH]
      // [WHY: exposed read-only so "did this pass actually advance the
      //  baseline?" is observable — by the Stage B regression harness, and by
      //  the read-only console audit already in main.js. No UI renders it; it
      //  is state, not a string for a user to read.]
      baselineFingerprint: this.#baselineFingerprint,
      // [PHASE-6-SYNC-V2][STAGE-E-LIVE-INTEGRATION]
      // [WHY: the UI must be able to say WHICH transport produced the status it
      //  is rendering, and report a skipped peer WITHOUT implying the whole
      //  pass failed — a peer skipped mid-write is a normal, self-healing
      //  event, not an error, and conflating the two is how a truthful status
      //  surface starts lying.]
      mode: this.#mode,
      migration: (this.#activation && this.#activation.migration) || null,
      mergedPeers: this.#lastPassInfo ? this.#lastPassInfo.mergedPeers : null,
      skippedPeers: this.#lastPassInfo ? this.#lastPassInfo.skippedPeers : [],
      // [PHASE-6-SYNC-V2][STAGE-E-HUMAN-DEVICE-LABEL]
      // [WHY: real-device debugging must show a human-readable device name
      //  before the raw UUID without allowing presentation metadata to affect
      //  sync identity. Both are exposed together, label first, so a caller
      //  cannot render one without having the other to hand — and neither is
      //  used by anything in this class beyond being handed to a reader.]
      deviceLabel:
        typeof this.#profile.getDeviceLabel === "function" ? this.#profile.getDeviceLabel() : UNKNOWN_DEVICE_LABEL,
      deviceId: typeof this.#profile.getDeviceId === "function" ? this.#profile.getDeviceId() : null,
      peers: (this.#lastPassInfo ? this.#lastPassInfo.peers : []) || [],
      ownGenerationSettling: this.#lastPassInfo ? this.#lastPassInfo.ownGenerationSettling : null,
      ownGenerationReason: this.#lastPassInfo ? this.#lastPassInfo.ownGenerationReason : null,
      // [SYNCV3 / STAGE-01 / V3-ROOT-ISOLATION]
      // [WHY: V3's connection state rides on the SAME status object, rather than
      //  a second getStatus()/subscribe() pair, so the temporary V3 controls and
      //  the existing sync controls can never render from two snapshots taken at
      //  different moments. `v3Configured` is about the folder alone; whether V3
      //  is the active transport is `mode`, and the two are independent on
      //  purpose — a folder may be connected before activation.]
      v3Configured: Boolean(this.#v3DirHandle),
      v3Status: this.#v3Status,
      v3FolderName: this.#v3FolderName,
      v3ConnectedAt: this.#v3ConnectedAt,
      v3ActivatedAt: this.#v3ActivatedAt,
      // [SYNCV3 / STAGE-03A / V3-ASSOCIATION-ISOLATION-AND-PASS-SKELETON]
      // [WHY: `v3PublishBlocked` is surfaced rather than hidden. A device that
      //  merged peers but published nothing has done something real and something
      //  incomplete, and a status surface unable to tell those apart is how
      //  "connected" starts covering for a device that is silently not
      //  contributing.]
      v3LiveWritesEnabled: V3_LIVE_WRITES_ENABLED,
      v3PublishBlocked: this.#lastV3PassInfo ? this.#lastV3PassInfo.publishBlocked : null,
      v3MergedPeers: this.#lastV3PassInfo ? this.#lastV3PassInfo.mergedPeers : null,
      v3SkippedPeers: (this.#lastV3PassInfo ? this.#lastV3PassInfo.skippedPeers : []) || [],
      v3Peers: (this.#lastV3PassInfo ? this.#lastV3PassInfo.peers : []) || [],
      v3Duplicates: (this.#lastV3PassInfo ? this.#lastV3PassInfo.duplicates : []) || [],
      associationStoreId:
        typeof this.#profile.getAssociationStoreId === "function" ? this.#profile.getAssociationStoreId() : null,
    };
  }

  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit() {
    for (const listener of this.#listeners) listener();
  }

  // ---- Convergence scheduler ----------------------------------------------

  /** True only when a periodic V2 convergence pass is currently warranted. */
  #shouldPoll() {
    // [PHASE-6-SYNC-V2][STAGE-E-CONVERGENCE-SCHEDULER]
    // [WHY: deliberately NOT gated on status. Gating on "permission-needed"
    //  looked prudent and was a real bug: a single transient Drive fault
    //  surfaces as exactly that status, and excluding it stopped this device
    //  from ever polling again for the rest of the session — one hiccup, silent
    //  permanent divergence. queryPermission() never prompts, so retrying costs
    //  nothing and is how a recoverable fault recovers by itself. Only genuinely
    //  terminal conditions stop the loop: not on V2, no folder, auto-sync off,
    //  or disposed.]
    //
    // [SYNCV3 / STAGE-01 / V3-ROOT-ISOLATION]
    // [WHY: unchanged, and already correct for V3 without an added clause — the
    //  test is an explicit `=== ACTIVATION_V2`, not "is not V1", so a V3
    //  installation polls nothing. That is intended while V3 has no pass to run;
    //  the stage that introduces the V3 transport extends this predicate
    //  deliberately rather than inheriting a cadence it never asked for.]
    // [SYNCV3 / STAGE-03A / V3-ASSOCIATION-ISOLATION-AND-PASS-SKELETON]
    // [WHY: V3's cadence is ready and gated on the SAME constant the pass uses to
    //  authorize a write. Polling a read-only pass every three seconds would burn
    //  Drive requests to reach a decision that is already known to be "cannot
    //  publish", and — more to the point — a device that cannot write has nothing
    //  to converge TOWARDS: it can adopt peers, but it never contributes, so the
    //  cadence buys nothing until Stage 03B makes writing possible. One constant
    //  governs both, so they cannot be half-enabled.]
    if (this.#mode === ACTIVATION_V3) {
      return !this.#disposed && V3_LIVE_WRITES_ENABLED && Boolean(this.#v3DirHandle);
    }
    return !this.#disposed && this.#mode === ACTIVATION_V2 && Boolean(this.#dirHandle) && this.#autoSync;
  }

  // [PHASE-6-SYNC-V2][STAGE-E-CONVERGENCE-SCHEDULER]
  // [WHY: clears before arming, unconditionally. Every lifecycle entry point
  //  and every completed pass calls this, so "did something already arm a
  //  timer?" never has to be reasoned about — the answer cannot cause a
  //  duplicate. A state that must not poll (V1, activation failed,
  //  disconnected, permission lost, disposed) simply arms nothing, which is how
  //  polling stops without a second stop path to keep in sync.]
  #armPollTimer() {
    if (this.#pollTimer) {
      clearTimeout(this.#pollTimer);
      this.#pollTimer = null;
    }
    if (!this.#shouldPoll()) return;

    this.#pollTimer = setTimeout(() => {
      this.#pollTimer = null;
      // Queues on the same serialized chain as every other pass. If one is
      // already running this simply runs after it — coalesced, never
      // concurrent, and never dropped. The next tick is armed by that pass's
      // own completion, so a slow pass cannot accumulate a backlog.
      this.#reconcile({ background: true }).catch(() => undefined);
    }, CONVERGENCE_POLL_MS);
  }

  // [PHASE-6-SYNC-V2][STAGE-E-CONVERGENCE-SCHEDULER]
  // [WHY: a tab that was hidden or offline has been running a timer the browser
  //  was free to throttle to minutes, so the moment it becomes usable again the
  //  cadence guarantee is already broken — the only honest repair is to check
  //  immediately rather than wait out a stale interval. Registered once, in the
  //  constructor, and removable via dispose() so a long-lived page cannot
  //  accumulate listeners across reconnects.]
  #installEnvironmentTriggers() {
    const wake = (reason) => {
      if (!this.#shouldPoll()) return;
      if (reason === "visibilitychange" && globalThis.document && globalThis.document.visibilityState === "hidden") {
        return;
      }
      this.#armPollTimer(); // reset the cadence so we do not double-fire
      this.#reconcile({ background: true }).catch(() => undefined);
    };

    const bind = (target, type) => {
      if (!target || typeof target.addEventListener !== "function") return;
      const handler = () => wake(type);
      target.addEventListener(type, handler);
      this.#environmentListeners.push({ target, type, handler });
    };

    bind(globalThis.document, "visibilitychange");
    bind(globalThis, "focus");
    bind(globalThis, "online");
  }

  /** Releases every timer and listener this instance owns. */
  dispose() {
    this.#disposed = true;
    if (this.#pollTimer) {
      clearTimeout(this.#pollTimer);
      this.#pollTimer = null;
    }
    if (this.#debounceTimer) {
      clearTimeout(this.#debounceTimer);
      this.#debounceTimer = null;
    }
    for (const { target, type, handler } of this.#environmentListeners) {
      if (target && typeof target.removeEventListener === "function") target.removeEventListener(type, handler);
    }
    this.#environmentListeners = [];
  }

  // ---- Auto Sync debounce -------------------------------------------------

  #onProfileChanged() {
    // Our OWN application of a synced collection (#applyRemote) fires this
    // same subscription — skip scheduling a redundant pass for a change we
    // just made from the sync folder's own data.
    if (this.#applyingRemote) return;
    // [SYNCV3 / STAGE-01 / V3-ROOT-ISOLATION]
    // [WHY: a local edit must not schedule a pass that has nothing to run. Under
    //  V3 the debounced pass would reach #reconcileV3 and merely re-check a
    //  permission, so every favourite/tag click would queue pointless work three
    //  seconds later. Checked before the handle test below because that one is
    //  about the V1/V2 handle, which V3 mode has deliberately released.]
    // [SYNCV3 / STAGE-03A / V3-ASSOCIATION-ISOLATION-AND-PASS-SKELETON]
    // [WHY: the V3 path is wired and deliberately inert. With live writes off a
    //  debounced pass could only re-read Drive and decline to publish, so every
    //  favourite or tag click would queue a pointless round trip three seconds
    //  later. Gated on the same constant as the scheduler and the pass itself.]
    if (this.#mode === ACTIVATION_V3) {
      if (!V3_LIVE_WRITES_ENABLED || !this.#v3DirHandle) return;
      if (this.#debounceTimer) clearTimeout(this.#debounceTimer);
      this.#debounceTimer = setTimeout(() => {
        this.#debounceTimer = null;
        this.#reconcile().catch((error) => console.warn("[SYNCV3] Auto sync failed.", error));
      }, AUTO_SYNC_DEBOUNCE_MS);
      return;
    }
    if (!this.#dirHandle || !this.#autoSync) return;
    // [PROFILE-SYNC-BASELINE] While a conflict is unresolved, Auto Sync
    // must never write over the synced copy — see resolveConflict, the
    // only path allowed to clear a conflict.
    if (this.#status === "conflict") return;

    if (this.#debounceTimer) clearTimeout(this.#debounceTimer);
    this.#debounceTimer = setTimeout(() => {
      this.#debounceTimer = null;
      this.#reconcile().catch((error) => console.warn("[PROFILE-SYNC] Auto sync failed.", error));
    }, AUTO_SYNC_DEBOUNCE_MS);
  }

  // ---- Reconciliation ------------------------------------------------------

  // Serializes reconcile passes through one chain (same pattern as
  // ProfileStore's #saveQueue) so an auto-triggered pass can never overlap
  // a manual "Sync Now" or a conflict resolution against the same handle.
  #reconcile(options = {}) {
    const run = () =>
      this.#reconcileImpl(options)
        .catch((error) => {
          console.error("[PROFILE-SYNC] Sync attempt failed.", error);
          this.#status = "offline";
          this.#message = (error && error.message) || "Sync failed.";
          this.#emit();
        })
        // [PHASE-6-SYNC-V2][STAGE-E-CONVERGENCE-SCHEDULER]
        // [WHY: the single re-arm point, and deliberately after the catch — a
        //  pass that FAILED must still schedule the next one, or one transient
        //  Drive error would silently end convergence for the rest of the
        //  session. This also means the cadence is measured from the end of the
        //  previous pass, so a slow pass delays the next tick instead of
        //  stacking one behind it.]
        .then(() => this.#armPollTimer());
    this.#reconcileChain = this.#reconcileChain.then(run, run);
    return this.#reconcileChain;
  }

  // [PHASE-6-SYNC-V2]
  // [STAGE-E-LIVE-INTEGRATION]
  // [WHY: the single fork between transports, placed at the TOP of the
  //  reconcile body so there is exactly one line to read to know which one ran.
  //  ACTIVATION_FAILED deliberately runs NEITHER: an installation whose
  //  activation did not complete must not resume writing V1 (it may already
  //  have adopted V1-seeded facts, so V1 no longer describes it) and must not
  //  write V2 either (its migration is unfinished). It reports a truthful
  //  status and waits for the user to retry activation — fail safe, surface
  //  recovery, never guess.]
  async #reconcileImpl(options = {}) {
    await this.#activationReady;

    if (this.#mode === ACTIVATION_FAILED) {
      this.#status = "migration-failed";
      this.#message =
        (this.#activation && this.#activation.migration && this.#activation.migration.reason) ||
        "Sync activation did not finish. Your Profile data is safe and saved locally.";
      this.#emit();
      return;
    }
    // [SYNCV3 / STAGE-01 / V3-ROOT-ISOLATION]
    // [WHY: every arm is now named explicitly, and the fall-through default runs
    //  NOTHING. This used to end `return this.#reconcileV1()` — an else-branch
    //  meaning "not v2 and not failed", which silently included any mode added
    //  later. Adding "v3" to that shape would have made a V3 installation write
    //  V1 manifests into whatever folder it had, with no error anywhere. The
    //  default arm is deliberately not V1: an unrecognised mode is a bug, and the
    //  safe response to a bug about WHICH transport to run is to run none.]
    if (this.#mode === ACTIVATION_V3) return this.#reconcileV3(options);
    if (this.#mode === ACTIVATION_V2) return this.#reconcileV2(options);
    if (this.#mode === ACTIVATION_V1) return this.#reconcileV1();

    console.warn(`[PROFILE-SYNC] Unrecognised sync mode "${this.#mode}" — running no transport.`);
    this.#status = "offline";
    this.#message = "Sync is not running. Local changes are saved.";
    this.#emit();
    return undefined;
  }

  // [SYNCV3 / STAGE-01 / V3-ROOT-ISOLATION]
  // [WHY: V3 has no transport yet, and this reports exactly that. It does NOT
  //  fall back to V2's pass, does not touch the folder, and does not advance
  //  lastSyncAt — a status surface that said "connected" or refreshed a sync
  //  time here would be claiming a sync that provably never happened, which is
  //  the same untruth Stage B removed from V1's verified publish. The only thing
  //  a V3 pass may do in this stage is re-check that the folder is still usable.]
  async #reconcileV3({ background = false } = {}) {
    // Re-checks the folder first: this also updates #v3Status, which is what the
    // V3 panel renders, and answers "is the handle still usable" before the pass
    // spends any time on it.
    await this.#refreshV3Connection();
    if (!this.#v3DirHandle || this.#v3Status !== "ready") return;

    let result;
    try {
      result = await runSyncV3Pass({
        profileStore: this.#profile,
        dirHandle: this.#v3DirHandle,
        state: this.#v3PassState,
      });
    } catch (error) {
      console.error("[SYNCV3] Sync pass threw.", error);
      this.#status = "offline";
      this.#message = "Sync could not complete. Local changes are saved.";
      this.#emit();
      return;
    }

    this.#lastV3PassInfo = {
      mergedPeers: result.mergedPeers || 0,
      skippedPeers: result.skippedPeers || [],
      peers: result.peers || [],
      duplicates: result.duplicates || [],
      published: Boolean(result.published),
      adopted: Boolean(result.adopted),
      publishBlocked: result.publishBlocked || null,
      ownGenerationSettling: result.ownGenerationSettling || null,
    };

    switch (result.status) {
      case "permission-needed":
        this.#v3Status = "permission-needed";
        this.#status = "v3-permission-needed";
        this.#message = result.message || null;
        this.#emit();
        return;

      case "verify-failed":
        // Stage B's discipline, unchanged: nothing accepted, nothing cleaned up,
        // local data untouched, and no claim that a sync happened.
        this.#status = "v3-verify-failed";
        this.#message = result.message || null;
        this.#emit();
        return;

      case "no-device-identity":
        this.#status = "offline";
        this.#message = "This device has no sync identity yet. Local changes are saved.";
        this.#emit();
        return;

      case "ok":
        this.#status = "v3-ready";
        this.#message = null;
        // [SYNCV3 / STAGE-03A / V3-ASSOCIATION-ISOLATION-AND-PASS-SKELETON]
        // [WHY: a background pass that changed nothing observable emits nothing,
        //  the same quietness rule #acceptV2Pass follows. At a three-second
        //  cadence the alternative is a re-render per tick forever.]
        if (!background || result.adopted || result.published) this.#emit();
        return;

      default:
        this.#status = "offline";
        this.#message = "Sync could not complete. Local changes are saved.";
        this.#emit();
    }
  }

  // [PHASE-6-SYNC-V2]
  // [STAGE-E-LIVE-INTEGRATION]
  // [WHY: this is the whole V2 live path. Note what is NOT here: no
  //  fingerprint comparison, no baseline three-way branch, and above all no
  //  conflict state — V2 merges per fact, so "both sides changed" is an
  //  ordinary outcome with a correct answer, not a question for the user. The
  //  Keep Local / Use Synced controls stay reachable only as explicit recovery
  //  (see resolveConflict), never from here.]
  async #reconcileV2({ background = false } = {}) {
    if (!this.#dirHandle) return;

    // [PHASE-6-SYNC-V2][STAGE-E-CONVERGENCE-SCHEDULER]
    // [WHY: a background poll never announces "Syncing…". At a 3-second cadence
    //  that transient state is the entire flicker problem — the status would
    //  strobe Syncing/Connected forever while nothing was happening. A
    //  user-initiated pass still shows it, because there the user asked and is
    //  waiting for an answer.]
    if (!background) {
      this.#status = "syncing";
      this.#emit();
    }

    let result;
    try {
      result = await runSyncV2Pass({
        profileStore: this.#profile,
        dirHandle: this.#dirHandle,
        state: this.#passState,
      });
    } catch (error) {
      console.error("[SYNC-V2] Sync pass threw.", error);
      this.#status = "offline";
      this.#message = "Sync could not complete. Local changes are saved.";
      this.#emit();
      return;
    }

    const previousStatus = this.#status;
    const previousSkipped = JSON.stringify((this.#lastPassInfo && this.#lastPassInfo.skippedPeers) || []);
    this.#lastPassInfo = {
      mergedPeers: result.mergedPeers || 0,
      skippedPeers: result.skippedPeers || [],
      // Diagnostics: non-null while this device is waiting for its OWN
      // just-published generation to become readable again, rather than
      // rewriting it. See runSyncV2Pass.
      ownGenerationSettling: result.ownGenerationSettling || null,
      ownGenerationReason: result.ownGenerationReason || null,
      // Diagnostics only — see getStatus(). Retained from the LAST pass so a
      // console helper can report peers without running a pass of its own.
      peers: result.peers || (this.#lastPassInfo ? this.#lastPassInfo.peers : []) || [],
    };
    const skippedChanged = JSON.stringify(this.#lastPassInfo.skippedPeers) !== previousSkipped;

    switch (result.status) {
      case "permission-needed": {
        // Re-entered on every poll while the fault persists, so it only
        // re-renders when the state actually changes — same quietness rule the
        // ok branch below follows.
        const changed = previousStatus !== "permission-needed" || this.#message !== (result.message || null);
        this.#status = "permission-needed";
        this.#message = result.message || null;
        if (changed || !background) this.#emit();
        return;
      }

      case "verify-failed":
        // Reuses Stage B's exact discipline: nothing accepted, nothing cleaned
        // up, local data untouched, and the baseline/lastSyncAt deliberately
        // NOT advanced.
        this.#enterVerifyFailed(result.reason === "changed" ? "changed" : "unreadable");
        return;

      case "no-device-identity":
        this.#status = "offline";
        this.#message = "This device has no sync identity yet. Local changes are saved.";
        this.#emit();
        return;

      case "ok":
        // [PHASE-6-SYNC-V2][STAGE-E-LIVE-INTEGRATION]
        // [WHY: "connected" is only ever reached on an `ok` result, which
        //  runSyncV2Pass returns only after either a read-back-VERIFIED publish
        //  or a confirmed no-op (this device's published generation already
        //  equals what it would publish). Every other outcome falls into a
        //  branch above. That is the whole of "do not claim Synced unless the
        //  pass was actually accepted".]
        //
        // [PHASE-6-SYNC-V2][STAGE-E-CONVERGENCE-SCHEDULER]
        // [WHY: `silent` covers the ordinary case — an idle background poll
        //  that read every peer, agreed with all of them, and had nothing to
        //  publish. Nothing observable changed, so nothing is re-rendered and
        //  no metadata write is issued; at a 3-second cadence those would be
        //  ~1200 pointless DOM renders and IndexedDB writes an hour. Anything a
        //  user would actually notice — remote changes adopted, a publish, a
        //  peer skipped, or coming back from a non-connected state — is not
        //  silent.]
        await this.#acceptV2Pass({
          silent:
            background &&
            !result.published &&
            !result.adopted &&
            previousStatus === "connected" &&
            skippedChanged === false,
        });
        return;

      default:
        this.#status = "offline";
        this.#message = "Sync could not complete. Local changes are saved.";
        this.#emit();
    }
  }

  async #reconcileV1() {
    if (!this.#dirHandle) return;

    // Auto-triggered passes have no user gesture available, so only
    // queryPermission (never requestPermission, which needs one) — a
    // silently-revoked permission must degrade to "needs attention," not
    // throw or spam a browser permission prompt with no gesture behind it.
    let permission;
    try {
      permission = await this.#dirHandle.queryPermission({ mode: "readwrite" });
    } catch (error) {
      this.#status = "permission-needed";
      this.#message = "The sync folder is no longer accessible.";
      this.#emit();
      return;
    }
    if (permission !== "granted") {
      this.#status = "permission-needed";
      this.#emit();
      return;
    }

    this.#status = "syncing";
    this.#emit();

    // [PHASE-6-SYNC-V2]
    // [STAGE-B-SNAPSHOT-INTEGRITY]
    // [WHY: `localCollection` is captured ONCE here and is an immutable
    //  snapshot (ProfileStore#getFullCollection detaches and, in development,
    //  freezes it). Everything downstream — the fingerprint below, the remote
    //  comparison, and the files eventually written — must read that same
    //  object. Re-reading the store further down, or holding a value that is
    //  still aliased to live state, is what let a mutation arriving during the
    //  read/write awaits change the bytes written without changing the
    //  fingerprint published beside them. Do not re-fetch the collection later
    //  in this pass.]
    const localCollection = await this.#profile.getFullCollection();
    const localFingerprint = await computeFingerprint(localCollection);

    let remote;
    try {
      remote = await readCollectionFromFolder(this.#dirHandle);
    } catch (error) {
      this.#status = "offline";
      this.#message = "Could not read the sync folder.";
      this.#emit();
      return;
    }

    if (remote.status === "invalid") {
      // Could be a torn write in progress on another device right now, or
      // genuine corruption — either way, never guess. Local changes are
      // already safe in IndexedDB; this just leaves the previous baseline
      // untouched and retries on the next change or manual Sync Now.
      this.#status = "offline";
      this.#message = "Synced data could not be read (it may be mid-write on another device). Local changes are saved.";
      this.#emit();
      return;
    }

    if (remote.status === "empty") {
      // Nothing valid exists remotely — this direction (writing local TO
      // the folder) can never destroy anything, unlike the reverse, which
      // is why an "empty" remote never gets applied onto local anywhere in
      // this file. Covers first connection AND a folder that was cleared
      // out after a previous successful sync.
      await this.#publishVerified(localCollection, localFingerprint);
      return;
    }

    // remote.status === "valid" from here.
    const baseline = this.#baselineFingerprint;

    if (baseline === null || baseline === undefined) {
      // First connection with existing valid remote data — see the
      // [PROFILE-SYNC-BASELINE] rules in the module header for exactly
      // this branch.
      if (localFingerprint === remote.fingerprint) {
        await this.#acceptBaseline(localFingerprint);
        return;
      }

      const localMeaningful = isMeaningfulCollection(localCollection);
      const remoteMeaningful = isMeaningfulCollection(remote.collection);

      if (!localMeaningful) {
        await this.#applyRemote(remote);
        return;
      }
      if (!remoteMeaningful) {
        await this.#publishVerified(localCollection, localFingerprint);
        return;
      }
      this.#enterConflict();
      return;
    }

    const localMatchesBaseline = localFingerprint === baseline;
    const remoteMatchesBaseline = remote.fingerprint === baseline;
    const localMatchesRemote = localFingerprint === remote.fingerprint;

    if (localMatchesRemote) {
      // Both sides already agree — just refresh baseline/status metadata.
      await this.#acceptBaseline(localFingerprint);
      return;
    }
    if (localMatchesBaseline && !remoteMatchesBaseline) {
      // Only the synced side changed.
      await this.#applyRemote(remote);
      return;
    }
    if (remoteMatchesBaseline && !localMatchesBaseline) {
      // Only the local side changed.
      await this.#publishVerified(localCollection, localFingerprint);
      return;
    }
    // Both sides changed independently since the last successful sync, and
    // they disagree with each other. Neither wins automatically.
    this.#enterConflict();
  }

  // [PHASE-6-SYNC-V2]
  // [STAGE-B-VERIFIED-PUBLISH]
  // [WHY: the invariant this whole stage exists for — the state fingerprinted
  //  must equal the state serialized must equal the state read back must equal
  //  the state accepted as baseline. `collection` is an immutable snapshot (see
  //  ProfileStore#getFullCollection) so links 1 and 2 hold by construction;
  //  this method establishes 3 and 4 by re-reading the folder and recomputing
  //  the fingerprint from the bytes that actually landed.]
  //
  // Two independent things are checked, and both must hold:
  //   1. the published generation is INTERNALLY consistent — its files hash to
  //      the fingerprint its own manifest advertises (readCollectionFromFolder
  //      recomputes this, which is exactly the check that surfaced the
  //      historical corruption);
  //   2. that generation is OURS — it equals the fingerprint we intended. A
  //      remote that is self-consistent but different means another writer
  //      landed on top of ours; our publish did not survive, so it must not
  //      become our baseline either.
  //
  // Returns true only if the baseline was advanced.
  async #publishVerified(collection, fingerprint) {
    await writeCollectionToFolder(this.#dirHandle, collection, fingerprint);

    let published;
    try {
      published = await readCollectionFromFolder(this.#dirHandle);
    } catch (error) {
      console.error("[PROFILE-SYNC] Could not read back the generation just written.", error);
      this.#enterVerifyFailed("unreadable");
      return false;
    }

    if (published.status !== "valid" || published.fingerprint !== fingerprint) {
      console.error(
        "[PROFILE-SYNC] Refusing to accept an unverified generation.",
        { intended: fingerprint, readBack: published.status === "valid" ? published.fingerprint : published.status }
      );
      this.#enterVerifyFailed(published.status === "valid" ? "changed" : "unreadable");
      return false;
    }

    // Verified — only now is the irreversible half of publishing allowed to
    // run, and only now does the baseline advance.
    await removeObsoleteProfileFiles(this.#dirHandle, collection);
    await this.#acceptBaseline(fingerprint);
    return true;
  }

  async #applyRemote(remote) {
    this.#applyingRemote = true;
    try {
      await this.#profile.replaceAllProfiles(remote.collection);
    } finally {
      this.#applyingRemote = false;
    }

    // [PHASE-6-SYNC-V2][STAGE-B-VERIFIED-PUBLISH]
    // [WHY: remote.fingerprint is already a VERIFIED read — readCollectionFromFolder
    //  recomputed it from the actual files before returning "valid" — so
    //  accepting it as the baseline does not bless anything unverified, and the
    //  control flow is deliberately left alone here. What is NOT proven is that
    //  the local adoption reproduced it exactly (replaceAllProfiles normalizes
    //  a few fields, e.g. a missing name to DEFAULT_PROFILE_NAME). If it ever
    //  diverges the next pass simply republishes, which is safe but wasteful —
    //  so it is reported loudly rather than silently tolerated. Stage D replaces
    //  this whole-collection adoption with per-fact application.]
    await this.#acceptBaseline(remote.fingerprint);

    try {
      const adopted = await this.#profile.getFullCollection();
      const adoptedFingerprint = await computeFingerprint(adopted);
      if (adoptedFingerprint !== remote.fingerprint) {
        console.warn(
          "[PROFILE-SYNC] Adopted collection does not reproduce the synced fingerprint; the next pass will republish.",
          { synced: remote.fingerprint, adopted: adoptedFingerprint }
        );
      }
    } catch (error) {
      console.warn("[PROFILE-SYNC] Could not re-check the adopted collection (non-fatal).", error);
    }
  }

  // [PROFILE-SYNC-BASELINE] The only place #baselineFingerprint is ever
  // advanced. Reached only after a verified read (fingerprint recomputed
  // and matched against the manifest in readCollectionFromFolder) or a
  // verified completed write (writeCollectionToFolder finishing without
  // throwing, manifest committed last) — never after a partial operation.
  async #acceptBaseline(fingerprint) {
    this.#baselineFingerprint = fingerprint;
    this.#lastSyncAt = Date.now();
    this.#status = "connected";
    this.#message = null;

    try {
      await updateSyncMeta({ baselineFingerprint: fingerprint, lastSyncAt: this.#lastSyncAt });
    } catch (error) {
      console.warn("[PROFILE-SYNC] Could not persist sync metadata.", error);
    }

    this.#emit();
  }

  // [PHASE-6-SYNC-V2]
  // [STAGE-E-LIVE-INTEGRATION]
  // [WHY: deliberately NOT #acceptBaseline. V2 has no collection fingerprint,
  //  and nulling #baselineFingerprint here would destroy the V1 baseline that
  //  is still the only record of what the V1 generation this installation
  //  migrated FROM contained — read-only recovery material, per the cutover
  //  policy. This advances only what a V2 pass actually establishes: that a
  //  verified pass completed, and when.]
  async #acceptV2Pass({ silent = false } = {}) {
    this.#lastSyncAt = Date.now();
    this.#status = "connected";
    this.#message = null;

    // A silent pass still advances #lastSyncAt in memory — the pass really did
    // happen and getStatus() must not under-report it — but skips the metadata
    // write and the render, neither of which anyone can observe a difference
    // from when nothing changed.
    if (silent) return;

    try {
      await updateSyncMeta({ lastSyncAt: this.#lastSyncAt });
    } catch (error) {
      console.warn("[SYNC-V2] Could not persist sync metadata.", error);
    }

    this.#emit();
  }

  #enterConflict() {
    this.#status = "conflict";
    this.#message = null;
    this.#emit();
  }

  // [PHASE-6-SYNC-V2]
  // [STAGE-B-VERIFIED-PUBLISH]
  // [WHY: a publish that could not be verified must leave the installation in
  //  a state that is truthful, non-destructive and recoverable. Specifically:
  //  the baseline and lastSyncAt are NOT advanced (so the next pass still sees
  //  the real divergence rather than a fabricated agreement), local Profile
  //  data is not touched at all — it never was, since publishing only ever
  //  reads it — and nothing is retried by rewriting data whose current state we
  //  do not know. The next profile change or Sync Now runs a clean pass.]
  //
  // Deliberately NOT the "conflict" status: conflict means the user must choose
  // between two versions, and this is not that. It is "we could not confirm the
  // write, so nothing was accepted" — which auto-sync is allowed to retry on
  // its own, and #onProfileChanged therefore does not suppress.
  #enterVerifyFailed(reason) {
    this.#status = "verify-failed";
    this.#message =
      reason === "changed"
        ? "The synced folder changed while this device was writing, so nothing was accepted. Your changes are saved locally and will sync on the next attempt."
        : "The synced folder could not be read back and verified after writing, so nothing was accepted. Your changes are saved locally.";
    this.#emit();
  }
}
