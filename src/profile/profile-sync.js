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
import { loadSyncConfig, saveSyncConnection, updateSyncMeta, clearSyncConfig } from "../storage/profile-sync-store.js";
import { DEFAULT_PROFILE_NAME } from "./indexeddb.js";

const AUTO_SYNC_DEBOUNCE_MS = 3000;
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

async function computeFingerprint(collection) {
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
async function readCollectionFromFolder(dirHandle) {
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

  // Best-effort cleanup of files for profiles no longer in the collection
  // (e.g. a deleted Profile). Never fatal: an orphaned file left behind by
  // a failure here references nothing the manifest points at, and the next
  // successful full write cleans it up anyway.
  try {
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

  constructor(profileStore) {
    this.#profile = profileStore;
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
  async init() {
    let config;
    try {
      config = await loadSyncConfig();
    } catch (error) {
      console.warn("[PROFILE-SYNC] Could not read saved sync configuration.", error);
      config = null;
    }

    if (!config || !config.handle) {
      this.#status = "not-configured";
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

  /** "Disconnect Sync" — forgets the folder relationship only. Profile data itself is untouched. */
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
    this.#emit();
  }

  /** "Sync Now" — manual trigger, bypasses the debounce and runs immediately. */
  async syncNow() {
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
  async resolveConflict(choice) {
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
        await this.#writeLocal(localCollection, localFingerprint);
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
    };
  }

  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit() {
    for (const listener of this.#listeners) listener();
  }

  // ---- Auto Sync debounce -------------------------------------------------

  #onProfileChanged() {
    // Our OWN application of a synced collection (#applyRemote) fires this
    // same subscription — skip scheduling a redundant pass for a change we
    // just made from the sync folder's own data.
    if (this.#applyingRemote) return;
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
  #reconcile() {
    const run = () =>
      this.#reconcileImpl().catch((error) => {
        console.error("[PROFILE-SYNC] Sync attempt failed.", error);
        this.#status = "offline";
        this.#message = (error && error.message) || "Sync failed.";
        this.#emit();
      });
    this.#reconcileChain = this.#reconcileChain.then(run, run);
    return this.#reconcileChain;
  }

  async #reconcileImpl() {
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
      await this.#writeLocal(localCollection, localFingerprint);
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
        await this.#writeLocal(localCollection, localFingerprint);
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
      await this.#writeLocal(localCollection, localFingerprint);
      return;
    }
    // Both sides changed independently since the last successful sync, and
    // they disagree with each other. Neither wins automatically.
    this.#enterConflict();
  }

  async #writeLocal(collection, fingerprint) {
    await writeCollectionToFolder(this.#dirHandle, collection, fingerprint);
    await this.#acceptBaseline(fingerprint);
  }

  async #applyRemote(remote) {
    this.#applyingRemote = true;
    try {
      await this.#profile.replaceAllProfiles(remote.collection);
    } finally {
      this.#applyingRemote = false;
    }
    await this.#acceptBaseline(remote.fingerprint);
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

  #enterConflict() {
    this.#status = "conflict";
    this.#message = null;
    this.#emit();
  }
}
