// ProfileStore owns PROFILE state — the user's curation data (favorites
// today; hidden items, collections, ratings, tags, loop automations later)
// — as distinct from SESSION state (current item, shuffle history, playback
// timer), which stays in MediaRuntime.
//
// Profile records are keyed by a portable relative path (e.g.
// "Nature/Sunrise.mp4"), NOT by any session-specific identifier, so the
// profile can be exported, handed to another computer, and re-imported
// against the same folder structure — independent of the browser tab that
// created it.
//
// Records are intentionally "open shape": import/export round-trips
// whatever fields a record has, even ones this version of the code doesn't
// read itself. That's what lets a future field (e.g. "hidden") be added
// later without a schema-breaking migration for data written today.

import {
  loadProfileData,
  saveProfileData,
  loadRegistry,
  saveRegistry,
  deleteProfileData,
  listAllProfileIds,
  generateProfileId,
  DEFAULT_PROFILE_NAME,
} from "./indexeddb.js";
// [PHASE-6-SYNC-V2]
// [STAGE-B-SNAPSHOT-INTEGRITY]
// [WHY: every value this store hands OUT for hashing, saving or writing must be
//  detached from the live in-memory Map/array it came from. The shallow copies
//  that used to serve this purpose left nested objects (tag.tagActivity,
//  record.tags, masterFolder) aliased, so a mutation arriving during an async
//  save or sync write silently changed data that had already been
//  fingerprinted. takeSnapshot() is the single boundary that guarantee lives
//  behind — see profile-snapshot.js.]
import { takeSnapshot } from "./profile-snapshot.js";
// [PHASE-6-SYNC-V2]
// [STAGE-D1-LOCAL-FOUNDATION]
// [WHY: every synchronized mutation must be recorded as a stamped fact in the
//  SAME turn it changes the in-memory state, and persisted in the SAME row
//  write — otherwise a value and the stamp that orders it can disagree, and the
//  merge engine reasons from a state that never existed. ProfileStore is the
//  only place every curation mutation already funnels through, which makes it
//  the only place that guarantee can be made structural rather than
//  remembered.]
import * as Facts from "./sync-facts.js";
import * as MergeEngine from "./sync-merge.js";
import { SyncIdentity } from "./sync-device.js";
// [PHASE-6-SYNC-V2]
// [STAGE-D3-LIBRARY-IDENTITY]
// [WHY: physical folders are local; only stable logical identity and
//  association may synchronize. library-registry.js owns the physical
//  identity (FSA handle, legacy signature) and never learns about facts,
//  stamps, or merge — this is the only place those two vocabularies meet, the
//  same boundary ProfileStore already keeps between itself and indexeddb.js.]
import * as LibraryRegistry from "../storage/library-registry.js";
import {
  V2_ASSOCIATION_STORE,
  loadV3LibrariesCache,
  saveV3LibrariesCache,
} from "../storage/profile-sync-store.js";
// [SYNCV3 / STAGE-03C / SAME-DEVICE-TAB-STATE]
// [WHY: same-origin contexts share IndexedDB but not this object. The channel
//  tells the others that durable state moved; it never carries the state.]
import {
  createLocalStateChannel,
  LOCAL_STATE_MESSAGE_KINDS,
} from "./local-state-channel.js";
import {
  seedFactsFromProfileData,
  diffFactsAgainstProfileData,
  diffLocalStates,
  applyProfileDiff,
  findProjectionDrift,
  localSeedStamp,
} from "./sync-translate.js";

// Bumped from 1 -> 2 for Multi-Profile Foundation (Phase 8.1): exported
// profiles now also carry profileId/profileName/masterFolder. This is
// additive — importJSON below still only reads `items` and `tags`, so a
// schemaVersion-2 export remains fully readable by the same merge/replace
// logic as a schemaVersion-1 one, and a schemaVersion-1 file imports into
// today's app unchanged.
const SCHEMA_VERSION = 2;
const KIND = "gallery-profile";

// [PHASE-6-SYNC-V2]
// [STAGE-D1-LOCAL-FOUNDATION]
// [WHY: the projection/facts invariant is checked on the ordinary mutation path,
//  which is exactly where it is useful and exactly where it must not cost a
//  production user anything. It is therefore gated to development the same way
//  profile-snapshot.js gates deep freezing — deliberately a SEPARATE flag, since
//  a maintainer may well want one without the other, and a shared switch would
//  make disabling a slow check also silently disable the freeze guard.
//  Detection is duplicated rather than shared for one reason only: importing the
//  gate from profile-snapshot.js would make that module's meaning "development
//  switches in general", and its header states plainly that it is the snapshot
//  boundary and nothing else.]
const FACT_CHECK_FLAG = "__BG_FACT_CHECK__";
let factCheckEnabled = null;

function detectFactCheckDefault() {
  try {
    if (typeof globalThis[FACT_CHECK_FLAG] === "boolean") return globalThis[FACT_CHECK_FLAG];
  } catch {
    // Reading an exotic global can throw in some sandboxed contexts.
  }

  try {
    const location = globalThis.location;
    if (!location) return false; // non-browser (the Node harness) — opt in explicitly
    const host = location.hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "";
  } catch {
    return false;
  }
}

export function isFactCheckEnabled() {
  if (factCheckEnabled === null) factCheckEnabled = detectFactCheckDefault();
  return factCheckEnabled;
}

/** Forces the development invariant check on or off. Production never calls this. */
export function setFactCheckEnabled(enabled) {
  factCheckEnabled = Boolean(enabled);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// A record with only default/falsy values carries no information worth
// keeping — dropping it keeps the profile (and its exported JSON) limited
// to files the user has actually curated, not every file ever seen.
function isEmptyRecord(record) {
  return Object.values(record).every((value) => {
    if (typeof value === "boolean") return value === false;
    if (value === null || value === undefined) return true;
    if (Array.isArray(value)) return value.length === 0;
    return false;
  });
}

// [SYNCV3 / STAGE-04B / SHARED-LIBRARY-RECORD]
// [WHY: how close together two "loads" have to be before the second is treated
//  as noise from the first. Generous, because the events being collapsed - a
//  rescan, a re-render, a permission re-check, a sync pass observing the same
//  load - all happen within seconds of each other, while a genuine second load
//  requires a human to navigate away and back. Erring long costs at most a
//  slightly stale lastLoadedAt for a few seconds; erring short costs a stamp
//  (and a Drive publish) per redundant event forever.]
const REDUNDANT_LIBRARY_LOAD_WINDOW_MS = 30_000;

export class ProfileStore {
  #recordsByPath = new Map();
  #listeners = new Set();
  // [SYNCV3 / STAGE-09 / SLICE-5-MULTITAB-DECISIONS]
  // [WHY: kept separate from #listeners. #emit() means "durable state this class
  //  owns has changed"; an ambient decision is a local-only row owned elsewhere,
  //  and routing it through #emit() would re-render every Profile surface for a
  //  change none of them reflect.]
  #ambientDecisionListeners = new Set();
  #saveQueue = Promise.resolve();
  #changedBeforeLoad = new Set();
  #replaceBeforeLoad = false;

  // Tag VOCABULARY (Phase 6.1 — Tag Management): { id, name } pairs, kept
  // separate from per-item records above. Applying a tag to a specific
  // media item is a later milestone — this phase only manages the list of
  // tags that exist. #tagIdsChangedBeforeLoad mirrors #changedBeforeLoad's
  // purpose: guards against the (practically unreachable, since it needs a
  // real UI click) race where a tag is created before the initial async
  // IndexedDB read resolves.
  #tags = [];
  #tagIdsChangedBeforeLoad = new Set();

  // ---- Profile identity (Phase 8.1 — Multi-Profile Foundation) ----------
  //
  // #ready resolves once #profileId is known — either an existing active
  // profile read from the registry, or a freshly created one. Every
  // read/write of profile ITEM data (items/tags) must happen against a
  // known profileId, so #loadSavedRecords and #persist both wait on this
  // before touching indexeddb. Synchronous callers (setFavorite etc.) are
  // unaffected: they only ever touch the in-memory Map directly, exactly
  // as before this phase.
  #profileId = null;
  #profileName = DEFAULT_PROFILE_NAME;
  #masterFolder = null;
  #profiles = []; // full registry snapshot; unused by any UI yet, kept for
                   // the Profile Selector phase that follows this one.
  #ready;

  // ---- Sync V2 facts (Phase 6, Stage D1) --------------------------------
  //
  // #facts is the ACTIVE profile's stamped-fact slice — the synchronized truth
  // for this profile, held alongside (not instead of) #recordsByPath/#tags.
  // Those remain the local working state and, critically, the carrier for every
  // local-only field (tagActivity, favouritedAt bookkeeping, unknown fields
  // from an imported profile) which has no representation in the fact model and
  // must never be rewritten by it.
  #facts = { items: {}, tags: {} };
  #identity;
  #factQueue = Promise.resolve();
  // How many mutations have been applied to local state but not yet stamped.
  // Used by the development invariant check AND, together with #pendingSaves,
  // by #drainPendingWrites to know when a profile switch may safely proceed.
  #pendingFacts = 0;
  // How many row writes are queued but not yet committed. See #drainPendingWrites.
  #pendingSaves = 0;

  // ---- Library associations (Phase 6, Stage D3) --------------------------
  //
  // { libraryId: Fact<profileId|null> } — the SHARED identity's association,
  // never a physical folder. Durable home is profile-sync-store.js's tiny
  // associations cache (see loadAssociationsCache), completely independent of
  // whether THIS device happens to have a local library-registry row for a
  // given libraryId — a device can hold and republish an association fact for
  // a library it has never physically opened at all.
  #associations = {};
  #associationsReady;

  // [SYNCV3 / STAGE-03A / V3-ASSOCIATION-ISOLATION-AND-PASS-SKELETON]
  // [WHY: WHICH persistent row backs #associations is now injected rather than
  //  hard-coded, because a V3-mode installation must never read or write the
  //  dormant V2 cache. This is the ONLY thing that changes: the fact model, the
  //  merge semantics, the projection and every caller are untouched — the shared
  //  fact is still associations[libraryId] = Fact<profileId|null>, and there is
  //  still exactly one association authority in this class.
  //
  //  An injected adapter rather than a mode flag, because an adapter can only
  //  reach the row its own two functions name. A flag would leave this class
  //  able to write either row and relying on a branch being correct at each of
  //  the three call sites below; the adapter makes writing the wrong row
  //  unrepresentable.]
  #associationStore = V2_ASSOCIATION_STORE;

  // ---- Same-device tab/iframe freshness (SyncV3, Stage 03C) --------------
  //
  // [SYNCV3 / STAGE-03C / SAME-DEVICE-TAB-STATE]
  // [WHY: one channel per store, opened in the constructor so every context has
  //  it before any mutation can happen. #localStateRefresh coalesces overlapping
  //  refreshes: a burst of messages (a tag rename touches the registry AND the
  //  facts row) must produce one re-read, not one per message.]
  #localStateChannel = null;
  #localStateRefresh = null;
  // [SYNCV3 / STAGE-03C / SAME-DEVICE-TAB-STATE]
  // [WHY: the stale-row guard in #persist costs one extra IndexedDB read per
  //  save, and - more importantly - merging storage back in during the initial
  //  load race is redundant with #adoptFacts and perturbs ordering that V2's
  //  tests pin down precisely. So it arms only once this context has evidence
  //  that a sibling context exists: a message received, or no channel at all to
  //  receive one on. A lone tab, the overwhelmingly common case, behaves exactly
  //  as it did before this stage.
  //
  //  Sticky once armed: a sibling that has spoken once can speak again, and
  //  disarming would reopen the window at the exact moment it is most likely to
  //  matter.]
  #peerContextObserved = false;

  // ---- Shared Library catalog (SyncV3, Stage 04B) ------------------------
  //
  // [SYNCV3 / STAGE-04B / SHARED-LIBRARY-RECORD]
  // [WHY: { libraryId: LibraryFacts } - the shared answer to "which Libraries
  //  exist, what are they called, and who last opened one". Held here, beside
  //  #associations, because it is published in the same replica and adopted by
  //  the same pass; kept in its OWN durable row because it is a different fact
  //  about a different thing. A Library survives its association being set to
  //  null, so the two maps cannot share a lifetime.
  //
  //  Loaded unconditionally rather than only under V3. ProfileStore stays
  //  mode-agnostic by design (Stage 03A), and a V1/V2 installation simply reads
  //  an absent row as {} forever - nothing writes libraries-v3 there.]
  #libraries = {};
  #librariesReady;

  // [SYNCV3 / STAGE-03B / SAME-DEVICE-WRITER-COORDINATION]
  // [WHY: closes the boot window Stage 03A left open. This store is constructed
  //  before anything knows which transport is running, so it defaults to the V2
  //  cache — which is correct for every V1/V2 installation and WRONG for a V3
  //  one, for however long mode resolution takes. An association written in that
  //  window lands in the V2 row on a V3 installation: contamination in exactly
  //  the direction this whole line of work exists to prevent, and invisible
  //  because it needs a click during boot to happen at all.
  //
  //  The gate makes it structural rather than improbable. While it is pending,
  //  every association read and write waits, so there is no window to hit — not
  //  a smaller one. It is only ever pending when something has explicitly said
  //  "I will resolve the mode" (ProfileSync, from its constructor), so a
  //  ProfileStore used WITHOUT a ProfileSync keeps working exactly as before
  //  rather than hanging forever waiting for an answer nobody will give.]
  #associationStoreGate = Promise.resolve();
  #openAssociationStoreGate = null;
  #associationStoreDeferred = false;
  // Guards against an in-flight load from a superseded store landing on top of
  // a newer one — see #loadAssociations.
  #associationLoadGeneration = 0;

  constructor({ identity, associationStore, localStateChannel } = {}) {
    // Loading is intentionally started by the store itself. Consumers keep
    // using the synchronous ProfileStore API; once saved records arrive, the
    // normal subscription mechanism refreshes any loaded media.
    this.#identity = identity || new SyncIdentity();
    // Defaults to the V1/V2 cache: an installation that has never heard of V3 —
    // every installation, until ProfileSync resolves its mode — behaves exactly
    // as it did before this stage.
    // A caller that names the row up front (tests, and any embedder that already
    // knows its mode) has nothing to defer — the gate stays open.
    if (associationStore) this.#associationStore = associationStore;
    // [SYNCV3 / STAGE-03C / SAME-DEVICE-TAB-STATE]
    // [WHY: opened before #resolveActiveProfile so no window exists in which this
    //  context is mutating state while deaf to its siblings. `localStateChannel`
    //  is injectable purely so a test can put two contexts on one channel.]
    this.#localStateChannel = localStateChannel || createLocalStateChannel();
    // Installed unconditionally, so an INJECTED channel receives too - see
    // setHandler's WHY in local-state-channel.js.
    if (typeof this.#localStateChannel.setHandler === "function") {
      this.#localStateChannel.setHandler((message) => this.#onLocalStateMessage(message));
    }
    // Announces this context so any sibling arms its stale-row guard before the
    // first click, and so this one learns of siblings that are already open.
    this.#announceLocalStateChange(LOCAL_STATE_MESSAGE_KINDS.CONTEXT_ONLINE);
    this.#ready = this.#resolveActiveProfile();
    this.#loadSavedRecords();
    this.#associationsReady = this.#loadAssociations();
    this.#librariesReady = this.#loadLibraries();
  }

  async #loadAssociations() {
    // [SYNCV3 / STAGE-03B / SAME-DEVICE-WRITER-COORDINATION]
    // [WHY: the generation guard makes a superseded load discard its own result.
    //  Without it, the V2 load already in flight when deferAssociationStore() is
    //  called would land AFTER the correct V3 load and quietly replace it — the
    //  boot bug wearing a different hat. It also makes two rapid
    //  setAssociationStore() calls safe, which the mode-switch path can produce.]
    const generation = ++this.#associationLoadGeneration;
    await this.#associationStoreGate;
    try {
      const loaded = await this.#associationStore.load();
      if (generation !== this.#associationLoadGeneration) return;
      this.#associations = loaded;
      await this.#identity.ready;
      // [SYNCV3 / CLOCK-HOTFIX / ASSOCIATION-CACHE-OBSERVATION]
      // [WHY: durable read-back is an observation too; otherwise a restart can
      //  restore an LWW fact without restoring the clock floor that received it.]
      this.#identity.observeReplica({ profiles: {}, associations: this.#associations, libraries: {} });
    } catch (error) {
      console.warn(`[SYNC] Could not load library associations from "${this.#associationStore.id}".`, error);
    }
  }

  /**
   * Holds every association read and write until setAssociationStore() names the
   * row this installation should be using.
   *
   * [SYNCV3 / STAGE-03B / SAME-DEVICE-WRITER-COORDINATION]
   * [WHY: SYNCHRONOUS, and called from ProfileSync's constructor — which main.js
   *  runs in the same synchronous block as `new ProfileStore()`. No user event
   *  can be dispatched between two synchronous module-scope statements, so the
   *  gate is closed before any click could reach setLibraryAssociation(). That
   *  is what turns "a very small race" into "not a race".
   *
   *  Idempotent, so a second ProfileSync over the same store cannot strand the
   *  gate half-open.]
   */
  deferAssociationStore() {
    if (this.#associationStoreDeferred) return;
    this.#associationStoreDeferred = true;
    this.#associations = {};
    this.#associationStoreGate = new Promise((resolve) => {
      this.#openAssociationStoreGate = resolve;
    });
    // Re-armed so the pending read waits behind the gate. The load started in
    // the constructor is superseded by the generation guard above.
    this.#associationsReady = this.#loadAssociations();
  }

  /** True while association access is waiting for its row to be named. Diagnostics and tests. */
  isAssociationStorePending() {
    return this.#associationStoreDeferred && this.#openAssociationStoreGate !== null;
  }

  /**
   * Points this store's association cache at a different persistent row and
   * reloads it. Called only by ProfileSync, when the installation's transport
   * mode is resolved or changed.
   *
   * [SYNCV3 / STAGE-03A / V3-ASSOCIATION-ISOLATION-AND-PASS-SKELETON]
   * [WHY: deliberately RELOADS and never SAVES. The outgoing mode's map must not
   *  follow the store into the incoming mode's row — that single write would
   *  merge a dormant V2 installation's associations into V3's cache (or worse,
   *  the reverse), which is precisely the contamination this stage exists to
   *  prevent. #associations is cleared before the reload so a failed read leaves
   *  an empty map rather than the previous mode's data masquerading as this
   *  one's.]
   */
  async setAssociationStore(store) {
    if (!store || typeof store.load !== "function" || typeof store.save !== "function") {
      throw new Error("[SYNCV3] setAssociationStore requires an adapter with load() and save().");
    }

    // [SYNCV3 / STAGE-03B / SAME-DEVICE-WRITER-COORDINATION]
    // [WHY: opening the gate is handled BEFORE the "same store, nothing to do"
    //  short-circuit below. A deferred store whose resolved row happens to be
    //  the V2 default still has to be released, or a V1/V2 installation would
    //  wait on a gate that never opens — the deadlock the deferral must not
    //  introduce. Deliberately does not await #associationsReady first: that
    //  promise is waiting on the very gate this branch opens.]
    if (this.#openAssociationStoreGate) {
      const open = this.#openAssociationStoreGate;
      this.#openAssociationStoreGate = null;
      this.#associationStore = store;
      this.#associations = {};
      this.#associationsReady = this.#loadAssociations();
      open();
      await this.#associationsReady;
      this.#emit();
      return store.id;
    }

    await this.#associationsReady;
    if (this.#associationStore && this.#associationStore.id === store.id) return store.id;

    this.#associationStore = store;
    this.#associations = {};
    this.#associationsReady = this.#loadAssociations();
    await this.#associationsReady;
    this.#emit();
    return store.id;
  }

  /** Which association row is currently authoritative. Diagnostics and tests only. */
  getAssociationStoreId() {
    return this.#associationStore ? this.#associationStore.id : null;
  }

  /** This installation's stable device identity. Null until it resolves. */
  // [PHASE-6-SYNC-V2][STAGE-E-HUMAN-DEVICE-LABEL]
  // [WHY: real-device debugging must show a human-readable device name before
  //  the raw UUID without allowing presentation metadata to affect sync
  //  identity. Exposed beside getDeviceId() so a caller cannot accidentally
  //  reach for the label when it wanted identity — but note the asymmetry:
  //  getDeviceId() returns durable persisted state, this returns a string
  //  recomputed on every call. Nothing may key, order, or merge on it.]
  getDeviceLabel() {
    return this.#identity.label;
  }

  getDeviceId() {
    return this.#identity.deviceId;
  }

  // ---- Device Name (SyncV3, Stage 05) -----------------------------------

  /**
   * What a human should see for this installation.
   *
   * [SYNCV3 / STAGE-05 / DEVICE-NAMING]
   * [WHY: a SEPARATE method from getDeviceLabel() above rather than a change to
   *  it. getDeviceLabel() is what the V2 pass publishes, and V2's device.json
   *  format must not change - so the custom name reaches V3's transport (which
   *  asks for this one) and stops there. Two methods with different jobs, not
   *  one method that quietly means different things to different transports.]
   */
  getDeviceDisplayName() {
    // [SYNCV3 / STAGE-05 / DEVICE-NAMING]
    // [WHY: degrades to the detected label for any identity-shaped object that
    //  predates Stage 05 - an injected test double, or a future alternative
    //  SyncIdentity. Without this the caller receives undefined and the
    //  transport falls back to its generic "Device" placeholder, so an
    //  installation that HAS a perfectly good detected label would publish
    //  itself as "Device -- a31f2c4e". Silent, cosmetic, and exactly the kind of
    //  degradation nobody notices until they are looking at their Drive.]
    const display = this.#identity.displayName;
    if (typeof display === "string" && display) return display;
    return this.#identity.label;
  }

  /** The custom Device Name, or null when the user has never set one. */
  getDeviceName() {
    return this.#identity.deviceName;
  }

  /**
   * Sets or clears this installation's Device Name.
   *
   * [SYNCV3 / STAGE-05 / DEVICE-NAMING]
   * [WHY: persists, tells sibling tabs, and notifies local subscribers - and
   *  does nothing else. It does not touch deviceId, the Profile registry, the
   *  active Profile, associations, or the Library catalog, and it never writes
   *  Drive: the renamed directory appears when the scheduler next publishes
   *  under the writer lease, which is the only thing allowed to write.]
   */
  async setDeviceName(name) {
    const saved = await this.#identity.setDeviceName(name);
    this.#announceLocalStateChange(LOCAL_STATE_MESSAGE_KINDS.DEVICE_NAME_CHANGED);
    this.#emit();
    return saved;
  }

  /**
   * Resolves once every mutation issued so far has been stamped and recorded.
   * Fact recording is queued behind the clock being ready (see #recordFact), so
   * anything reading facts must wait on this rather than assuming the queue has
   * drained.
   */
  async whenFactsSettled() {
    await this.#ready;
    await this.#identity.ready;
    await this.#factQueue;
  }

  async whenAssociationsSettled() {
    await this.#associationsReady;
    await this.#identity.ready;
  }

  async #loadLibraries() {
    try {
      this.#libraries = await loadV3LibrariesCache();
      await this.#identity.ready;
      // [SYNCV3 / CLOCK-HOTFIX / LIBRARY-CACHE-OBSERVATION]
      // [WHY: re-observing the durable cache preserves observe-before-tick
      //  across a restart after accepting a peer's newer Library facts.]
      this.#identity.observeReplica({ profiles: {}, associations: {}, libraries: this.#libraries });
    } catch (error) {
      console.warn("[SYNCV3] Could not load the shared Library catalog.", error);
    }
  }

  async whenLibrariesSettled() {
    await this.#librariesReady;
    await this.#identity.ready;
  }

  /** Every known shared Library fact record, detached — { libraryId: LibraryFacts }. */
  getLibraries() {
    return takeSnapshot(this.#libraries);
  }

  /**
   * Every known shared Library, projected for display/ranking.
   *
   * [SYNCV3 / STAGE-04B / SHARED-LIBRARY-RECORD]
   * [WHY: built from #libraries and #associations TOGETHER, so a Library whose
   *  association is null still appears - with associatedProfileId: null rather
   *  than being absent. listAssociations() cannot answer this question: it
   *  projects only associations that currently point somewhere, which is correct
   *  for "what is associated" and would silently erase the catalog.]
   */
  listLibraries() {
    return takeSnapshot(
      Facts.projectLibraries({
        schemaVersion: Facts.REPLICA_SCHEMA_VERSION,
        profiles: {},
        associations: this.#associations,
        libraries: this.#libraries,
      })
    );
  }

  /** Every known association fact, detached — {libraryId: Fact<profileId|null>}. */
  getAssociations() {
    return takeSnapshot(this.#associations);
  }

  /** Projected {libraryId: profileId} for every association currently pointing somewhere — Stage E's "listSharedLibraries" surface. */
  listAssociations() {
    return takeSnapshot(Facts.projectAssociations({ schemaVersion: 2, profiles: {}, associations: this.#associations }));
  }

  // [PHASE-6-SYNC-V2]
  // [STAGE-D3-LIBRARY-IDENTITY]
  // [WHY: associating/disassociating a library never touches this.#profileId
  //  or this.#facts — there is no code path here that could make it write to
  //  the wrong Profile, because it never writes to a Profile's facts AT ALL.
  //  The stamp/merge discipline is identical to a Profile-fact mutation (same
  //  clock, same mergeFact semantics via mergeMaps), but the fact itself lives
  //  entirely outside the profiles map, exactly as sync-facts.js's schema
  //  requires — see mergeReplicas' WHY in sync-merge.js.]
  //
  // `localLibraryId` is library-registry.js's LOCAL row id (NOT the shared
  // libraryId — that's minted/preserved here via ensureLibraryId).
  // `profileId: null` disassociates explicitly. Returns the shared libraryId
  // on success, or null if the local library id isn't known. Stage 09's narrow
  // `includeAuthoredFact` option instead returns { libraryId, authoredFact };
  // existing callers retain the original string contract.
  async setLibraryAssociation(localLibraryId, profileId, { includeAuthoredFact = false } = {}) {
    await this.#associationsReady;
    await this.#identity.ready;

    let row;
    try {
      row = await LibraryRegistry.ensureLibraryId(localLibraryId);
    } catch (error) {
      console.warn(`[SYNC-V2] Could not resolve a shared libraryId for "${localLibraryId}".`, error);
      return null;
    }
    if (!row) return null;

    const stamp = this.#identity.tick();
    const fact = MergeEngine.makeFact(profileId || null, stamp);
    // [SYNCV3 / STAGE-09 / SELF-WRITE-SUPPRESSION-RACE-AUDIT]
    // [WHY: return THIS immutable snapshot when requested, not whichever fact
    // is current after the awaits below. Association persistence, same-device
    // refresh, or SyncV3 adoption can merge a newer remote fact while this
    // method is suspended. Re-reading #associations after resolution would then
    // misclassify that remote fact as authored by this tab and suppress it.]
    const authoredFact = includeAuthoredFact ? takeSnapshot(fact) : null;
    this.#associations = MergeEngine.mergeMaps(this.#associations, { [row.libraryId]: fact }, MergeEngine.mergeFact);

    try {
      await this.#saveAssociationsAndAnnounce();
    } catch (error) {
      console.warn(`[SYNC] Could not persist library associations to "${this.#associationStore.id}".`, error);
    }
    // Best-effort: keeps the row's UI-facing `profileId` field (existing,
    // pre-Sync-V2 field — see [LIBRARY-PROFILE-ASSOCIATION] in
    // library-registry.js) in step with the fact this method just won. If
    // this device's OWN stamp lost the merge above (can't happen here — it's
    // always the newest — but WOULD apply symmetrically on adoption), the row
    // would instead be corrected by adoptMergedReplica below.
    try {
      await LibraryRegistry.setLibraryProfile(localLibraryId, this.#associations[row.libraryId].v);
    } catch (error) {
      console.warn(`[SYNC-V2] Could not update local library "${localLibraryId}" after association.`, error);
    }

    this.#emit();
    return includeAuthoredFact ? { libraryId: row.libraryId, authoredFact } : row.libraryId;
  }

  /**
   * Records that a shared Library was meaningfully loaded on THIS device.
   *
   * `localLibraryId` is library-registry.js's LOCAL row id. Returns the shared
   * libraryId on success, or null when this row has no shared identity yet.
   *
   * [SYNCV3 / STAGE-04B / SHARED-LIBRARY-RECORD]
   * [WHY: reads the shared libraryId, never mints one. ensureLibraryId() is
   *  reserved for an explicit association (see setLibraryAssociation) precisely
   *  so that merely OPENING a folder cannot give it a synchronized identity
   *  nobody asked for - Stage D3's rule, unchanged. A folder with no shared
   *  identity yet is simply not catalogued, and returning null says so.
   *
   *  Touches ONLY the Library catalog: not associations, not activeProfileId,
   *  not any Profile's facts. "This Library was opened" and "this Library
   *  belongs to that Profile" are independent facts and this method is the
   *  boundary that keeps them so.
   *
   *  Writes locally and announces to sibling tabs; it never touches Drive.
   *  Publishing is the scheduler's job, gated by the writer lease.]
   */
  async recordLibraryLoaded(localLibraryId, { name = null, at = undefined } = {}) {
    await this.#librariesReady;
    await this.#identity.ready;

    let row;
    try {
      row = await LibraryRegistry.getLibraryById(localLibraryId);
    } catch (error) {
      console.warn(`[SYNCV3] Could not read local library "${localLibraryId}" to catalog it.`, error);
      return null;
    }
    if (!row || !row.libraryId) return null;

    const displayName = typeof name === "string" && name ? name : row.name || "";
    const loadedAt = Number.isFinite(at) ? at : Date.now();

    // [SYNCV3 / STAGE-04B / SHARED-LIBRARY-RECORD]
    // [WHY: the repeated-stamping guard. lastLoadedAt must mean "a meaningful
    //  load happened", so a rescan, a re-render, a permission re-check or a sync
    //  pass that all describe the SAME load must produce one fact, not four.
    //  Suppressed when nothing this device would publish has actually changed:
    //  the name is the same, this device is already the recorded source, and the
    //  recorded load time is within a short window. Compared against what is
    //  already HELD rather than against a separate "last call" timestamp, so the
    //  guard survives a reload and cannot drift out of step with the facts.]
    const current = this.#libraries[row.libraryId];
    if (current && this.#isRedundantLibraryLoad(current, displayName, loadedAt)) return row.libraryId;

    const stamp = this.#identity.tick();
    const next = Facts.recordLibraryLoaded(
      { schemaVersion: Facts.REPLICA_SCHEMA_VERSION, profiles: {}, associations: {}, libraries: this.#libraries },
      row.libraryId,
      { name: displayName, sourceDeviceId: this.#identity.deviceId, at: loadedAt },
      stamp
    );
    this.#libraries = next.libraries;

    try {
      await this.#saveLibrariesAndAnnounce();
    } catch (error) {
      console.warn("[SYNCV3] Could not persist the shared Library catalog.", error);
    }

    this.#emit();
    return row.libraryId;
  }

  /**
   * [SYNCV3 / STAGE-08 / PROMOTE-LIBRARY]
   * [WHY: promoting a durable local folder creates/publishes shared Library
   * identity without creating a Profile association or switching Active Profile.]
   */
  async promoteLibraryToShared(localLibraryId, { name = null } = {}) {
    await this.#librariesReady;
    await this.#identity.ready;

    let row;
    try {
      row = await LibraryRegistry.ensureLibraryId(localLibraryId);
    } catch (error) {
      console.warn(`[SYNCV3] Could not promote local Library "${localLibraryId}".`, error);
      return null;
    }
    if (!row) return null;

    // recordLibraryLoaded owns the catalog stamp, durable cache write, and
    // write-then-LIBRARIES_CHANGED announcement. It touches no association.
    return this.recordLibraryLoaded(localLibraryId, { name: name || row.name || null });
  }

  // [SYNCV3 / STAGE-08 / LINK-AND-SYNC]
  // Sanctioned local-link writes. The registry commits first; only then does
  // LIBRARIES_CHANGED invalidate sibling tabs. No shared fact is stamped here.
  async linkLocalLibraryToShared(localLibraryId, sharedLibraryId) {
    const result = await LibraryRegistry.linkLocalLibraryToSharedId(localLibraryId, sharedLibraryId);
    if (!result || result.ok === false) return result;
    this.#announceLocalStateChange(LOCAL_STATE_MESSAGE_KINDS.LIBRARIES_CHANGED);
    this.#emit();
    return result;
  }

  async unlinkLocalLibraryFromShared(localLibraryId) {
    const result = await LibraryRegistry.unlinkLocalLibraryFromSharedId(localLibraryId);
    if (!result) return null;
    this.#announceLocalStateChange(LOCAL_STATE_MESSAGE_KINDS.LIBRARIES_CHANGED);
    this.#emit();
    return result;
  }

  // See recordLibraryLoaded's WHY. A load is redundant when every field it would
  // stamp already says the same thing, allowing for a short window on the clock.
  #isRedundantLibraryLoad(current, displayName, loadedAt) {
    const heldName = current.name && typeof current.name.v === "string" ? current.name.v : null;
    const heldSource =
      current.sourceDeviceId && typeof current.sourceDeviceId.v === "string" ? current.sourceDeviceId.v : null;
    const heldAt = current.lastLoadedAt && Number.isFinite(current.lastLoadedAt.v) ? current.lastLoadedAt.v : null;

    if (heldName !== displayName) return false;
    if (heldSource !== this.#identity.deviceId) return false;
    if (heldAt === null) return false;
    return loadedAt - heldAt < REDUNDANT_LIBRARY_LOAD_WINDOW_MS;
  }

  /** The active profile's fact slice, detached. */
  getFacts() {
    return takeSnapshot(this.#facts);
  }

  /**
   * Stamped ItemFacts for exactly these paths, for the ACTIVE profile only.
   *
   * [MEDIA-ID / STAGE-02 / LOCAL-PROJECTION]
   * [WHY: the ONE additive seam Stage 02 needed in this class, and it is
   *  getFacts() with a key filter — nothing more. The projection has to resolve
   *  a disagreement between two alias paths, and only the STAMPS can do that;
   *  the flattened #recordsByPath carries no ordering at all. But getFacts()
   *  deep-clones the entire fact slice, and calling that on every user action in
   *  a 20k library would be a full structural clone per click. This returns only
   *  the handful of aliased keys the projection actually holds.
   *
   *  Read-only by construction: it reads #facts, calls takeSnapshot (the single
   *  detachment boundary — see profile-snapshot.js), and touches nothing else.
   *  No profileId parameter exists, so a foreign Profile is unreachable rather
   *  than merely discouraged. It never touches #identity, so it cannot read a
   *  clock or draw a stamp; it never calls a Facts.* builder, so it cannot mint
   *  one; and it never touches #factQueue/#saveQueue/#persist, so it cannot
   *  write or schedule a write.]
   */
  /**
   * Every path the ACTIVE profile holds a stamped ItemFacts entry for.
   *
   * [MEDIA-ID / STAGE-02 / BP-FAIL-03]
   * [WHY: knownPaths() cannot answer this and structurally never will.
   *  #setRecord DELETES a record that isEmptyRecord() considers empty, and
   *  {favorite:false} / {hidden:false} / {tags:[]} are all empty by that
   *  definition — so a path carrying ONLY negative curation has no local record
   *  at all. Its stamped facts are still authoritative: an un-favourite is a
   *  fact whose stamp is what makes it beat an older favourite on a proven
   *  alias. Driving alias DISCOVERY off knownPaths() therefore lost exactly the
   *  removals, and the older positive value on the other alias won forever.
   *  Proven in the real browser: child un-favourite and un-tag both persisted as
   *  stamped facts, and MASTER still showed the Favorite after a full reload.
   *
   *  DISCOVERY (this) and VALUE RESOLUTION (getItemFactsForPaths) are separate
   *  jobs, which is why this is a second, narrower accessor rather than a change
   *  to either existing one. Object.keys() already returns a fresh array of
   *  immutable strings, so no live reference escapes and no snapshot is needed —
   *  cloning the whole fact slice just to enumerate its keys would be the cost
   *  getItemFactsForPaths exists to avoid.
   *
   *  Read-only on the same terms as getItemFactsForPaths: active Profile only
   *  (no profileId parameter exists), no #identity, no clock, no stamp minted,
   *  no Facts.* builder, no #factQueue/#saveQueue/#persist.]
   */
  getFactPaths() {
    return Object.keys(this.#facts.items || {});
  }

  getItemFactsForPaths(paths) {
    const out = {};
    if (!paths) return out;
    const items = this.#facts.items || {};
    for (const path of paths) {
      if (typeof path !== "string" || !path) continue;
      const item = items[path];
      if (item) out[path] = item;
    }
    return takeSnapshot(out);
  }

  /**
   * Every known profile's facts as a Sync V2 replica. The active profile comes
   * from memory (always at least as fresh as IndexedDB); the rest are read from
   * their own rows. Stage D2's transport publishes this.
   */
  // [PHASE-6-SYNC-V2]
  // [STAGE-D2-TRANSPORT]
  // [WHY: enumerates every profileId ever PERSISTED (listAllProfileIds), not
  //  this.#profiles (the UI-facing, visible registry). A deleted Profile is
  //  removed from #profiles immediately (see #deleteProfile) but its row, now
  //  carrying a deleted:true fact, remains — enumerating only #profiles would
  //  silently stop publishing that tombstone the moment it was created, which
  //  is exactly how a peer that has not yet seen the deletion would never
  //  learn of it and keep the Profile alive forever.]
  async getFullReplica() {
    await this.whenFactsSettled();
    await this.whenAssociationsSettled();
    await this.whenLibrariesSettled();

    const replica = Facts.emptyReplica();
    replica.associations = this.#associations;
    // [SYNCV3 / STAGE-04B / SHARED-LIBRARY-RECORD]
    // [WHY: present only when it carries something, and this is a CORRECTION to
    //  the Stage 04A audit rather than a style choice. That audit reasoned that
    //  an always-present `libraries: {}` was harmless to V2 because V2's
    //  transport declares the fields it publishes explicitly. True for the WRITE
    //  - and irrelevant, because publishDeviceReplicaVerified finishes by
    //  comparing the whole read-back replica against the whole object it was
    //  given. V2's transport reconstructs only { schemaVersion, profiles,
    //  associations }, so the read-back lacked a key the input had, the two
    //  canonical forms differed by exactly one empty object, and EVERY V2 publish
    //  failed verification - permanently, looking exactly like corruption. Three
    //  V2 suites caught it immediately.
    //
    //  Omitting an empty map is the minimal fix that touches neither the V2
    //  transport nor the V2 pass: stableStringify skips undefined keys, so a
    //  V1/V2 installation - which never catalogues a Library, because nothing
    //  writes libraries-v3 there - serializes byte-for-byte as it always has.
    //  ProfileStore still asks nothing about which transport is running; it only
    //  declines to publish a map with nothing in it.]
    if (Object.keys(this.#libraries).length > 0) replica.libraries = this.#libraries;
    else delete replica.libraries;
    let knownIds;
    try {
      knownIds = new Set(await listAllProfileIds());
    } catch (error) {
      console.warn("[SYNC-V2] Could not list known profiles for a replica.", error);
      knownIds = new Set();
    }
    if (this.#profileId) knownIds.add(this.#profileId);

    for (const profileId of knownIds) {
      if (profileId === this.#profileId) {
        replica.profiles[profileId] = this.#facts;
        continue;
      }
      try {
        const data = await loadProfileData(profileId);
        if (data.facts) replica.profiles[profileId] = data.facts;
      } catch (error) {
        console.warn(`[SYNC-V2] Could not read facts for profile "${profileId}".`, error);
      }
    }
    return takeSnapshot(replica);
  }

  // [PHASE-6-SYNC-V2]
  // [STAGE-D2-TRANSPORT]
  // [WHY: this is the observe half of observe-before-tick, applied to a PEER's
  //  replica rather than this device's own persisted facts. It must run for
  //  every valid peer BEFORE the sync pass does anything else — in particular
  //  before adoptMergedReplica below, and before any user mutation that could
  //  land while a pass is in flight — or a local click issued between reading a
  //  peer and finishing this pass could draw a stamp that loses to a fact the
  //  peer already published, silently discarding the click.]
  async observePeerReplica(replica) {
    await this.#identity.ready;
    this.#identity.observeReplica(replica);
  }

  // [PHASE-6-SYNC-V2]
  // [STAGE-D2-TRANSPORT]
  // [WHY: a sync pass has already merged local + every valid peer (see
  //  sync-v2.js) into ONE replica covering every Profile any of them mentioned.
  //  Applying that here — instead of the caller writing IndexedDB directly —
  //  keeps "how a replica becomes local state" a single ProfileStore
  //  responsibility, the same reasoning [PROFILE-SYNC] already documents for
  //  getFullCollection/replaceAllProfiles. Every profile is MERGED into
  //  whatever is already stored, never assigned over it — merge is
  //  commutative/idempotent, so replaying the same pass twice, or running two
  //  devices' passes in either order, converges to the same result. This never
  //  mints a stamp: it only reconciles already-stamped facts, so it never
  //  drains through #recordFact/#factQueue.]
  //
  // A profile mentioned in `mergedReplica` that this device has never seen
  // before is added to its OWN registry — recovering a Profile another device
  // created, not just its content — with a name projected from its facts.
  async adoptMergedReplica(mergedReplica) {
    await this.#ready;
    await this.#identity.ready;
    await this.#drainPendingWrites();

    const now = Date.now();
    let registryChanged = false;
    let activeWasDeletedRemotely = false;

    for (const profileId of Object.keys(mergedReplica.profiles || {})) {
      const facts = mergedReplica.profiles[profileId];
      const deletedRemotely = Facts.isProfileDeleted(mergedReplica, profileId);
      let entry = this.#profiles.find((candidate) => candidate.id === profileId);

      if (!entry && !deletedRemotely) {
        const projected = Facts.projectProfile(mergedReplica, profileId);
        entry = {
          id: profileId,
          name: (projected && projected.name) || DEFAULT_PROFILE_NAME,
          masterFolder: null,
          createdAt: now,
          updatedAt: now,
        };
        this.#profiles.push(entry);
        registryChanged = true;
      } else if (entry && deletedRemotely) {
        // [PHASE-6-SYNC-V2][STAGE-D2-TRANSPORT]
        // [WHY: a peer's deletion must make this device's VISIBLE registry
        //  agree — a Profile the rest of the world considers gone must stop
        //  showing up here too. Facts (below) are still merged and persisted
        //  regardless, because the tombstone must keep propagating to any
        //  THIRD device that has not yet seen it — only the local, UI-facing
        //  list is what changes here.]
        this.#profiles = this.#profiles.filter((candidate) => candidate.id !== profileId);
        registryChanged = true;
        if (profileId === this.#profileId) activeWasDeletedRemotely = true;
        entry = null;
      }
      // else: not deleted and already known — proceed to ordinary adoption below.

      if (profileId === this.#profileId) {
        // Reuses the exact merge-then-apply-then-persist path load already
        // goes through — see #adoptFacts. It merges rather than assigns for the
        // same reason: this pass and a concurrent local mutation must both
        // survive regardless of which finishes first.
        await this.#adoptFacts(facts);
        continue;
      }

      const currentName = entry ? entry.name : DEFAULT_PROFILE_NAME;
      const updatedName = await this.#adoptMergedFactsForForeignProfile(profileId, facts, currentName);
      if (entry && updatedName && updatedName !== entry.name) {
        entry.name = updatedName;
        entry.updatedAt = now;
        registryChanged = true;
      }
    }

    // [PHASE-6-SYNC-V2][STAGE-D2-TRANSPORT]
    // [WHY: reuses deleteProfile's exact fallback-then-switch sequence — a
    //  Profile deleted on ANOTHER device must not leave THIS device active on
    //  a Profile that no longer visibly exists, any more than a local delete
    //  would. #adoptFacts above already merged the tombstone into #facts, so
    //  this only handles the "what becomes active now" half.]
    if (activeWasDeletedRemotely) {
      const fallback = this.#pickFallbackProfile();
      registryChanged = true;
      await this.#drainPendingWrites();
      this.#profileId = null;
      await this.switchProfile(fallback.id);
    }

    if (registryChanged) {
      try {
        await this.#saveRegistryAndAnnounce({ activeProfileId: this.#profileId, profiles: this.#profiles });
      } catch (error) {
        console.warn("[SYNC-V2] Could not save the profile registry after adopting a merged replica.", error);
      }
      this.#emit();
    }

    await this.#adoptMergedAssociations(mergedReplica.associations);
    await this.#adoptMergedLibraries(mergedReplica.libraries);
  }

  // [SYNCV3 / STAGE-04B / SHARED-LIBRARY-RECORD]
  // [WHY: merged, never assigned - the same discipline every other adoption in
  //  this class follows. A libraryId this device has never seen is simply added;
  //  one it already knows is resolved per FIELD by mergeLibraryFacts, so a peer
  //  whose only news is a newer lastLoadedAt cannot roll back a name this device
  //  holds more recently.
  //
  //  Deliberately does NOT touch library-registry.js. #adoptMergedAssociations
  //  reconciles local rows because the local row carries a UI-facing profileId
  //  copy that predates sync; the shared Library name has no such local mirror,
  //  and creating one now would invent a second source of truth for a display
  //  string. It also never touches activeProfileId: a Library record arriving
  //  from another device says nothing about which Profile this device is on.]
  async #adoptMergedLibraries(incoming) {
    await this.#librariesReady;
    const merged = MergeEngine.mergeMaps(this.#libraries, incoming || {}, MergeEngine.mergeLibraryFacts);
    if (MergeEngine.stableStringify(merged) === MergeEngine.stableStringify(this.#libraries)) return;

    this.#libraries = merged;
    try {
      await this.#saveLibrariesAndAnnounce();
    } catch (error) {
      console.warn("[SYNCV3] Could not persist the merged shared Library catalog.", error);
    }
    this.#emit();
  }

  // [PHASE-6-SYNC-V2]
  // [STAGE-D3-LIBRARY-IDENTITY]
  // [WHY: merged, never assigned — the same reasoning as every profile-facts
  //  adoption above. A libraryId this device has never heard of before is
  //  simply added to the map; one it already has an opinion on is resolved by
  //  ordinary LWW via mergeFact, regardless of which side's stamp is newer.
  //  local-registry rows are updated ONLY for a libraryId this device actually
  //  has a physical folder for (getLibraryByLibraryId) — a device with no such
  //  row still keeps and republishes the fact via #associations/the durable
  //  cache, it just has nothing local to reconcile.]
  async #adoptMergedAssociations(incoming) {
    await this.#associationsReady;
    const merged = MergeEngine.mergeMaps(this.#associations, incoming || {}, MergeEngine.mergeFact);
    const changed = MergeEngine.stableStringify(merged) !== MergeEngine.stableStringify(this.#associations);

    if (changed) {
      this.#associations = merged;
      try {
        await this.#saveAssociationsAndAnnounce();
      } catch (error) {
        console.warn(`[SYNC] Could not persist merged library associations to "${this.#associationStore.id}".`, error);
      }
      this.#emit();
    }

    // [PHASE-6-SYNC-V2][STAGE-D3-LIBRARY-IDENTITY]
    // [WHY: reconciles EVERY locally-linked library against #associations —
    //  not only libraryIds whose fact changed in THIS pass. A row freshly
    //  linked via linkLocalLibraryToSharedId (a raw storage operation Stage E
    //  calls directly, with no ProfileStore involvement at link time — see
    //  library-registry.js) needs its UI-facing profileId picked up from
    //  whatever association value this device ALREADY held, which is exactly
    //  the case "only changed ids" would miss. Cheap self-heal, same
    //  philosophy as the facts/local-records drift check in #adoptFacts.]
    let knownLinks;
    try {
      knownLinks = await LibraryRegistry.listKnownLibraryIds();
    } catch (error) {
      console.warn("[SYNC-V2] Could not list locally-linked libraries to reconcile.", error);
      return;
    }
    for (const { id, libraryId } of knownLinks) {
      const fact = this.#associations[libraryId];
      if (!fact) continue;
      try {
        await LibraryRegistry.setLibraryProfile(id, fact.v);
      } catch (error) {
        console.warn(`[SYNC-V2] Could not reconcile local library "${id}" for libraryId "${libraryId}".`, error);
      }
    }
  }

  // Adopts merged facts for a profile that is NOT the active one — no live
  // in-memory state to update, so this reads/merges/diffs/writes its stored row
  // directly. See applyProfileDiff in sync-translate.js for why this is a pure
  // field-by-field application rather than a wholesale replacement.
  async #adoptMergedFactsForForeignProfile(profileId, mergedFacts, currentName) {
    let stored;
    try {
      stored = await loadProfileData(profileId);
    } catch (error) {
      console.warn(`[SYNC-V2] Could not read profile "${profileId}" to adopt a merged replica.`, error);
      return null;
    }

    const current = stored.facts || { items: {}, tags: {} };
    const merged = MergeEngine.mergeProfileFacts(current, mergedFacts);
    const diff = diffFactsAgainstProfileData(merged, {
      name: currentName,
      items: stored.items,
      tags: stored.tags,
    });
    const { items, tags } = applyProfileDiff(diff, { items: stored.items, tags: stored.tags });

    try {
      await saveProfileData(profileId, { items, tags, facts: merged });
    } catch (error) {
      console.warn(`[SYNC-V2] Could not save profile "${profileId}" after adopting a merged replica.`, error);
    }

    return diff.profileName !== null ? diff.profileName : null;
  }

  // [PHASE-6-SYNC-V2]
  // [STAGE-D1-LOCAL-FOUNDATION]
  // [WHY: this is the observe-before-tick gate, made structural. A stamp issued
  //  before the persisted clock floor is restored can land BELOW facts this
  //  device already recorded, and sync-facts.js then correctly discards the
  //  mutation — the user's click does nothing, silently, with no error anywhere.
  //  Queueing every fact behind identity.ready makes that impossible to get
  //  wrong at a call site. The UI path stays synchronous (items/tags and #emit
  //  already happened); only the stamping is deferred, by milliseconds, and
  //  #persist waits on this queue so a saved row is never missing the fact for
  //  a value it contains.]
  //
  // `mutate` is (replica, profileId, stamp) => replica, i.e. any sync-facts.js
  // builder. Facts are held as a one-profile slice and wrapped into a replica
  // here so those builders can be used unmodified.
  #recordFact(mutate) {
    // Captured synchronously, for the same reason #persist captures its target
    // profile id: this fact belongs to the profile that was active when the user
    // acted, never to whatever happens to be active by the time the queue
    // drains. Null means the mutation beat #ready — the only case where reading
    // the id later is correct, since no switch can have happened yet.
    const requestedProfileId = this.#profileId;
    this.#pendingFacts += 1;

    this.#factQueue = this.#factQueue
      .catch(() => undefined)
      // [PHASE-6-SYNC-V2][STAGE-D1-LOCAL-FOUNDATION]
      // [WHY BOTH: #ready as well as the clock. A mutation can beat the registry
      //  read — a favourite clicked the instant the page is interactive — and
      //  until it resolves there is no Profile ID to record the fact under. The
      //  local record survives that race already (#changedBeforeLoad); without
      //  this wait the FACT does not, because the drain finds a null id and
      //  drops it. The value would then be saved with no stamp ordering it, so
      //  the click works locally and never leaves the machine.
      //
      //  Both are caught rather than awaited bare so the body always runs: it
      //  owns the #pendingFacts decrement, and a stranded counter would silently
      //  disable the development invariant check for the rest of the session.]
      .then(() => this.#ready.catch(() => undefined))
      .then(() => this.#identity.ready.catch(() => undefined))
      .then(() => {
        const profileId = requestedProfileId || this.#profileId;
        if (!profileId) return undefined;

        const stamp = this.#identity.tick();

        if (profileId === this.#profileId) {
          const replica = { schemaVersion: 2, profiles: { [profileId]: this.#facts }, associations: {} };
          const next = mutate(replica, profileId, stamp);
          this.#facts = next.profiles[profileId];
          this.#reportFactDrift("after recording a mutation");
          return undefined;
        }

        // [PHASE-6-SYNC-V2][STAGE-D1-LOCAL-FOUNDATION]
        // [WHY: with #drainPendingWrites now counter-driven (see below) this
        //  branch should be unreachable — #profileId cannot change while a fact
        //  is still pending. It is kept as a hard backstop rather than an
        //  assumption: if it IS somehow reached, the fact must never be applied
        //  to the (already reused) in-memory #facts slice, which by now belongs
        //  to a different profile, and it must never be dropped. It is instead
        //  applied directly to the ORIGINAL profile's PERSISTED facts — read,
        //  merged, written back — so the mutation/fact pair can never split: the
        //  value already landed on this profile's row (see #persist, which
        //  captures its target profileId the same way), and this guarantees the
        //  fact lands there too.]
        return this.#applyFactToStoredProfile(profileId, mutate, stamp);
      })
      .catch((error) => {
        // Never let fact recording break curation — the same tolerance
        // #persist already applies to a failed save.
        console.warn("[SYNC-V2] Could not record a sync fact.", error);
      })
      .then(() => {
        this.#pendingFacts -= 1;
      });
  }

  // Backstop for #recordFact's stale-profile branch — see the WHY there. Reads
  // the target profile's OWN persisted facts (never the active profile's
  // in-memory slice), merges the mutation in, and writes it back under the same
  // profileId. Correct regardless of what #facts/#profileId currently hold.
  async #applyFactToStoredProfile(profileId, mutate, stamp) {
    const { items, tags, facts: storedFacts } = await loadProfileData(profileId);
    const current = storedFacts || { items: {}, tags: {} };
    const replica = { schemaVersion: 2, profiles: { [profileId]: current }, associations: {} };
    const next = mutate(replica, profileId, stamp);
    await saveProfileData(profileId, { items, tags, facts: next.profiles[profileId] });
    console.warn(
      `[SYNC-V2] Recorded a fact for profile "${profileId}" via the stale-profile backstop — ` +
        "the active profile changed while it was still queued."
    );
  }

  // [PHASE-6-SYNC-V2]
  // [STAGE-D1-LOCAL-FOUNDATION]
  // [WHY: everything the outgoing profile has in flight must be BOTH stamped and
  //  written before its fact slice is replaced. Draining only the fact queue is
  //  not enough and fails silently: the fact lands in #facts, the switch then
  //  discards #facts, and the pending save — which by then sees a different
  //  active profile — writes the row WITHOUT it. The user's last action before
  //  switching profiles simply disappears, with the value saved and the fact
  //  gone, which is the worst of the two possible losses because the row still
  //  looks complete.
  //
  //  COUNTER-DRIVEN, not a fixed pass count: a fixed count is provably
  //  insufficient — a fact's own drain can synchronously trigger another
  //  mutation (e.g. from code chained off it), extending the chain past
  //  whatever number of passes was chosen. #pendingFacts/#pendingSaves are
  //  incremented synchronously at the moment a mutation is ISSUED (before any
  //  await), so the loop cannot exit while genuinely new work keeps arriving,
  //  and #profileId is not reassigned until this returns — so no fact can ever
  //  be queued against a profile that has already stopped being active. #recordFact's
  //  stale-profile branch above exists purely as defence in depth for a
  //  discipline violation elsewhere, not because this loop can legitimately miss
  //  anything.]
  async #drainPendingWrites() {
    while (this.#pendingFacts > 0 || this.#pendingSaves > 0) {
      await this.#factQueue;
      await this.#saveQueue;
    }
  }

  /**
   * Development-only diagnostic: reports (never repairs) any disagreement
   * between this profile's facts and its local records. See findProjectionDrift
   * in sync-translate.js for why this is report-only.
   *
   * Also callable directly — checkFactInvariants() below — so a test or a
   * console session can assert the invariant regardless of the gate.
   */
  #reportFactDrift(context) {
    if (!isFactCheckEnabled()) return;

    // [PHASE-6-SYNC-V2][STAGE-D1-LOCAL-FOUNDATION]
    // [WHY: local state is updated synchronously and stamped asynchronously, so
    //  during a burst — Presentation Quick Tagging is exactly this — local
    //  legitimately runs ahead of the facts. Comparing them mid-burst reports
    //  every not-yet-stamped mutation as missing, which is noise, not drift. The
    //  two representations are only required to agree once nothing is in flight,
    //  so that is the only moment worth checking.]
    if (this.#pendingFacts > 0) return;

    const problems = this.checkFactInvariants();
    if (!problems.length) return;
    console.warn(
      `[SYNC-V2] Facts and local state disagree ${context} (profile ${this.#profileId}):\n  ` +
        problems.join("\n  ")
    );
  }

  // Same check, deferred behind everything currently queued. Load and switch run
  // OUTSIDE the fact queue, so checking inline there would report a mutation
  // that is stamped but not yet drained as missing — a false alarm, and a noisy
  // one, which is the fastest way to get a useful diagnostic switched off.
  #queueFactDriftReport(context) {
    if (!isFactCheckEnabled()) return;
    this.#factQueue = this.#factQueue.catch(() => undefined).then(() => this.#reportFactDrift(context));
  }

  /**
   * Returns every way this profile's facts and local records currently
   * disagree; empty means they are in step. Diagnostic only — calling it never
   * changes any state.
   */
  checkFactInvariants() {
    return findProjectionDrift(this.#facts, {
      name: this.#profileName,
      // Deliberately the RAW records, not #projectItems(): the projection hides
      // assignments to tombstoned tags, which the check would then misread as
      // local state that has gone missing.
      items: this.#snapshotItems(),
      tags: this.#tags,
    });
  }

  // Determines which profile is active, creating one if none exists yet
  // (a genuinely fresh install with no registry at all — the v1->v2
  // migration in indexeddb.js already handles the "had a v1 default
  // profile" case by creating the registry entry itself). Never throws:
  // if IndexedDB is unavailable entirely (e.g. some private-browsing
  // modes), the store still gets a profileId so the rest of its logic
  // behaves normally for the current session, just without persistence.
  async #resolveActiveProfile() {
    let registry;
    try {
      registry = await loadRegistry();
    } catch (error) {
      console.warn("Could not read the profile registry; using a session-only profile.", error);
      this.#profileId = generateProfileId();
      return;
    }

    const profiles = Array.isArray(registry.profiles) ? registry.profiles : [];
    let active = profiles.find((candidate) => candidate.id === registry.activeProfileId) || profiles[0] || null;

    if (!active) {
      const now = Date.now();
      active = {
        id: generateProfileId(),
        name: DEFAULT_PROFILE_NAME,
        masterFolder: null,
        createdAt: now,
        updatedAt: now,
      };
      profiles.push(active);

      try {
        await this.#saveRegistryAndAnnounce({ activeProfileId: active.id, profiles });
      } catch (error) {
        console.warn("Could not save the new profile registry entry.", error);
      }
    }

    this.#profileId = active.id;
    this.#profileName = active.name || DEFAULT_PROFILE_NAME;
    this.#masterFolder = active.masterFolder || null;
    this.#profiles = profiles;
  }

  // Persists a change to this profile's registry entry (name and/or
  // masterFolder — never items/tags, which go through #persist/saveProfileData
  // instead). Waits on #ready first so it can't race the initial resolution
  // above and, e.g., write a masterFolder onto a profileId that then gets
  // silently replaced once resolution finishes.
  async #persistProfileMeta() {
    await this.#ready;
    if (!this.#profileId) return;

    const now = Date.now();
    const index = this.#profiles.findIndex((candidate) => candidate.id === this.#profileId);
    const updatedEntry = {
      id: this.#profileId,
      name: this.#profileName,
      masterFolder: this.#masterFolder,
      createdAt: index >= 0 ? this.#profiles[index].createdAt || now : now,
      updatedAt: now,
    };

    if (index >= 0) {
      this.#profiles[index] = updatedEntry;
    } else {
      this.#profiles.push(updatedEntry);
    }

    try {
      await this.#saveRegistryAndAnnounce({ activeProfileId: this.#profileId, profiles: this.#profiles });
    } catch (error) {
      console.warn("Could not save profile metadata.", error);
    }
  }

  // ---- Profile identity accessors ----------------------------------------

  getProfileId() {
    return this.#profileId;
  }

  getProfileName() {
    return this.#profileName;
  }

  setProfileName(name) {
    const trimmed = (name || "").trim();
    if (!trimmed || trimmed === this.#profileName) return;

    this.#profileName = trimmed;
    this.#emit();
    this.#persistProfileMeta();
    this.#recordFact((replica, profileId, stamp) => Facts.setProfileName(replica, profileId, trimmed, stamp));
    // The name lives in the registry, which #persistProfileMeta writes; the FACT
    // lives in the profile row, which only #persist writes. Both must happen or
    // a reload would show one and publish the other.
    this.#persist();
  }

  // Master/Top Folder metadata (Phase 8.1): purely descriptive at this
  // stage — the folder's own name, as picked. Intentionally NOT used for
  // any matching/comparison here; that folder-association logic (FSA
  // handles, smart re-detection when a folder moves/copies) is explicitly
  // deferred to a later phase. This just gives the profile model somewhere
  // to record which folder the user most recently associated with it.
  getMasterFolder() {
    return this.#masterFolder ? { ...this.#masterFolder } : null;
  }

  setMasterFolder({ name } = {}) {
    const trimmed = (name || "").trim();
    if (!trimmed) return;

    this.#masterFolder = { name: trimmed, updatedAt: Date.now() };
    this.#emit();
    this.#persistProfileMeta();
  }

  // Registry snapshot — every known profile's identity/metadata (not this
  // profile's items/tags). Not consumed anywhere yet; exposed now so the
  // Profile Selector UI phase can read it without further ProfileStore
  // changes.
  listProfiles() {
    return this.#profiles.map((entry) => ({ ...entry }));
  }

  // ---- Multi-Profile Foundation (Phase 8.2) ------------------------------
  //
  // this.#profiles (populated once in #resolveActiveProfile) is treated as
  // the in-memory source of truth for the registry for the lifetime of this
  // ProfileStore instance — create/switch mutate it directly and persist
  // the whole array, rather than each re-reading the registry from
  // IndexedDB independently. That avoids a read-modify-write race between
  // e.g. createProfile and setMasterFolder firing close together. The
  // known limitation this leaves: two browser TABS open on the same origin
  // won't see each other's registry changes live. Out of scope for this
  // foundation phase (no multi-tab requirement was specified); the last
  // write still always wins safely, nothing corrupts.

  // Creates a new, empty, independently-addressable profile and registers
  // it — but does NOT activate it. Switching is a separate, explicit step
  // (switchProfile) so "create" and "make active" stay two distinct,
  // composable operations rather than one that surprises a caller who only
  // wanted to create.
  async createProfile(name) {
    await this.#ready;

    const trimmed = (name || "").trim() || DEFAULT_PROFILE_NAME;
    const now = Date.now();
    const entry = {
      id: generateProfileId(),
      name: trimmed,
      masterFolder: null,
      createdAt: now,
      updatedAt: now,
    };

    this.#profiles.push(entry);

    try {
      await this.#saveRegistryAndAnnounce({ activeProfileId: this.#profileId, profiles: this.#profiles });
    } catch (error) {
      console.warn("Could not save the new profile.", error);
    }

    // [PHASE-6-SYNC-V2]
    // [STAGE-D2-TRANSPORT]
    // [WHY: existence must be a synchronized fact from the moment a Profile is
    //  created, not only once it happens to be loaded/switched to and thereby
    //  gains a seeded fact row. Without this, a Profile created and never
    //  activated has NO row in storage at all — listAllProfileIds() would never
    //  see it, getFullReplica() would never publish it, and another device
    //  would have no way to learn this Profile exists until the creating device
    //  happened to switch to it first.
    //
    //  Deliberately NOT awaited here — createProfile() must keep resolving as
    //  soon as the registry write finishes, exactly as it did before this
    //  stamp existed. It is queued on #factQueue instead (same discipline as
    //  #recordFact: counted in #pendingFacts, waited for by whenFactsSettled()
    //  and #drainPendingWrites()), so it is never lost and never dropped, but
    //  a caller awaiting createProfile() is never made to wait on the clock.]
    this.#stampNewProfileExistence(entry.id, trimmed);

    this.#emit();
    return { ...entry };
  }

  // Writes the row (items:{}, tags:[], name fact) that makes a brand-new
  // Profile immediately enumerable and publishable — see createProfile above.
  // Queued rather than awaited by its caller; see the WHY there.
  #stampNewProfileExistence(profileId, name) {
    this.#pendingFacts += 1;
    this.#factQueue = this.#factQueue
      .catch(() => undefined)
      .then(() => this.#ready.catch(() => undefined))
      .then(() => this.#identity.ready.catch(() => undefined))
      .then(async () => {
        const stamp = this.#identity.tick();
        const facts = Facts.setProfileName(Facts.emptyReplica(), profileId, name, stamp).profiles[profileId];
        await saveProfileData(profileId, { items: {}, tags: [], facts });
      })
      .catch((error) => {
        console.warn(`[SYNC-V2] Could not stamp existence for the new profile "${profileId}".`, error);
      })
      .then(() => {
        this.#pendingFacts -= 1;
      });
  }

  // Makes an already-registered profile (by id) the active one: persists
  // the new activeProfileId, then completely resets and reloads this
  // store's in-memory item/tag state from THAT profile's own IndexedDB
  // record. Nothing from the outgoing profile survives the switch —
  // that's the isolation guarantee. Any save still in flight for the
  // outgoing profile is unaffected: #persist captured its own target
  // profileId at call time (see above), so it still lands correctly on the
  // profile it was queued for, not on whatever becomes active afterward.
  //
  // No-op if profileId is already active, or isn't a known profile.
  async switchProfile(profileId) {
    await this.#ready;
    if (!profileId || profileId === this.#profileId) return false;

    const target = this.#profiles.find((candidate) => candidate.id === profileId);
    if (!target) {
      console.warn(`Cannot switch profile: unknown profile id "${profileId}".`);
      return false;
    }

    try {
      await this.#saveRegistryAndAnnounce({ activeProfileId: profileId, profiles: this.#profiles });
    } catch (error) {
      console.warn("Could not save the active profile pointer.", error);
    }

    // [PHASE-6-SYNC-V2][STAGE-D1-LOCAL-FOUNDATION]
    // [WHY: every fact already stamped for the OUTGOING profile must land in the
    //  outgoing profile's slice before that slice is replaced. Without this
    //  drain, a favourite the user set moments before switching resolves against
    //  whichever slice happens to be loaded when the queue runs — the fact is
    //  either lost or written into the wrong Gallery, and merge then propagates
    //  the mistake to every device. Placed immediately before the reset, with no
    //  await between, so nothing can queue into the gap.]
    await this.#drainPendingWrites();

    // Full isolation reset — nothing from the outgoing profile carries
    // over. Same fresh state a brand-new ProfileStore would start with.
    this.#recordsByPath = new Map();
    this.#tags = [];
    this.#changedBeforeLoad = new Set();
    this.#tagIdsChangedBeforeLoad = new Set();
    this.#replaceBeforeLoad = false;
    this.#facts = { items: {}, tags: {} };

    this.#profileId = target.id;
    this.#profileName = target.name || DEFAULT_PROFILE_NAME;
    this.#masterFolder = target.masterFolder || null;

    let incomingFacts = null;
    try {
      const { items, tags, facts } = await loadProfileData(this.#profileId);
      incomingFacts = facts;

      for (const [path, record] of Object.entries(items)) {
        if (typeof path !== "string" || !path || !isPlainObject(record)) continue;
        this.#setRecord(path, record);
      }

      for (const tag of tags) {
        if (!isPlainObject(tag) || typeof tag.id !== "string" || typeof tag.name !== "string") continue;
        this.#tags.push({ ...tag });
      }
    } catch (error) {
      console.warn("Could not load the newly-active profile's data.", error);
    }

    // Adopted (or seeded) AFTER the records above are in place: seeding reads
    // this profile's items/tags, and adoption diffs against them.
    await this.#adoptFacts(incomingFacts);

    this.#emit();
    return true;
  }

  // Deletes a profile from the registry (Phase 8.3 — Profile Management)
  // and its persisted item/tag data. If the deleted profile was active,
  // falls back to another known profile — deterministically the next one
  // in registry order — or, if it was the LAST profile, creates a fresh
  // empty default profile so the app is never left without an active
  // Gallery world. Deleting a non-active profile only touches the
  // registry list; it never resets this store's current in-memory state.
  //
  // Never deletes/modifies any actual media files — this only removes
  // ProfileStore-owned metadata (registry entry + IndexedDB row).
  //
  // No-op (returns false) if profileId isn't a known profile.
  // Deleting the only remaining profile (locally OR via a remote deletion
  // adopted in adoptMergedReplica) can't leave the registry empty — the app
  // always needs an active Gallery world to load into, same as a genuinely
  // fresh install (#resolveActiveProfile above). Pushes the fresh fallback
  // onto this.#profiles itself; callers still persist the registry.
  // Merges a `deleted:true` fact into `profileId`'s facts and persists the row
  // — never deletes it. The active profile goes through #recordFact (so it is
  // queued/stamped/drained exactly like any other mutation on the profile the
  // user is currently in); any other profile is read-merged-written directly,
  // the same pattern #adoptMergedFactsForForeignProfile already uses.
  async #tombstoneProfile(profileId, isActive) {
    if (isActive) {
      this.#recordFact((replica, id, stamp) => Facts.deleteProfile(replica, id, stamp));
      // [PHASE-6-SYNC-V2][STAGE-D2-TRANSPORT]
      // [WHY: #recordFact only merges the tombstone into the in-memory
      //  this.#facts — it never persists on its own (every OTHER caller pairs
      //  it with an explicit #persist(), e.g. setFavorite). Without this call
      //  the tombstone lives only in memory and switchProfile's very next reset
      //  (this.#facts = { items: {}, tags: {} }) discards it — the row on disk
      //  never learns the profile was deleted at all.]
      this.#persist();
      await this.#drainPendingWrites();
      return;
    }

    try {
      await this.#identity.ready;
      const stamp = this.#identity.tick();
      const stored = await loadProfileData(profileId);
      const current = stored.facts || { items: {}, tags: {} };
      const tombstoned = Facts.deleteProfile(
        { schemaVersion: 2, profiles: { [profileId]: current }, associations: {} },
        profileId,
        stamp
      ).profiles[profileId];
      await saveProfileData(profileId, { items: stored.items, tags: stored.tags, facts: tombstoned });
    } catch (error) {
      console.warn(`[SYNC-V2] Could not tombstone profile "${profileId}".`, error);
    }
  }

  #pickFallbackProfile() {
    let fallback = this.#profiles[0] || null;
    if (!fallback) {
      const now = Date.now();
      fallback = { id: generateProfileId(), name: DEFAULT_PROFILE_NAME, masterFolder: null, createdAt: now, updatedAt: now };
      this.#profiles.push(fallback);
    }
    return fallback;
  }

  async deleteProfile(profileId) {
    await this.#ready;
    if (!profileId) return false;

    const index = this.#profiles.findIndex((candidate) => candidate.id === profileId);
    if (index === -1) return false;

    const wasActive = profileId === this.#profileId;
    this.#profiles.splice(index, 1);

    let nextActiveId = this.#profileId;
    if (wasActive) {
      nextActiveId = this.#pickFallbackProfile().id;
    }

    try {
      await this.#saveRegistryAndAnnounce({ activeProfileId: nextActiveId, profiles: this.#profiles });
    } catch (error) {
      console.warn("Could not save the profile registry after deletion.", error);
    }

    // [PHASE-6-SYNC-V2]
    // [STAGE-D2-TRANSPORT]
    // [WHY: deletion is now a stamped, tombstoned FACT (Facts.deleteProfile),
    //  never a physical row removal (deleteProfileData is no longer called
    //  here). A tombstone with nowhere durable to live cannot propagate — a
    //  peer offline at the moment of this delete would rejoin, see the
    //  Profile's real (pre-deletion) facts with no contrary evidence anywhere,
    //  and resurrect it. Keeping the row — now carrying deleted:true — is what
    //  lets getFullReplica() keep publishing the tombstone until every peer has
    //  converged on it, exactly like a tag's deletion already works.]
    await this.#tombstoneProfile(profileId, wasActive);

    if (wasActive) {
      // [DEBUG-8.3-PROFILE-DELETE] Deleting the ACTIVE profile needs the
      // exact same full-isolation reset switchProfile() already performs
      // (clear in-memory items/tags, load the new active profile's own
      // data) — reuse it instead of duplicating that logic here.
      // this.#profileId is forced to null first so switchProfile's
      // same-id guard doesn't treat nextActiveId as a no-op; the registry
      // write above already persisted nextActiveId as active, so
      // switchProfile's own registry write is a harmless repeat.
      //
      // [PHASE-6-SYNC-V2][STAGE-D1-LOCAL-FOUNDATION]
      // [WHY: drained BEFORE #profileId is cleared. #recordFact refuses to apply
      //  a fact whose profile is no longer active, so a fact still queued when
      //  the id is nulled would be dropped rather than recorded against the
      //  profile the user was actually curating.]
      await this.#drainPendingWrites();
      this.#profileId = null;
      await this.switchProfile(nextActiveId);
    } else {
      this.#emit();
    }

    return true;
  }

  // [PHASE-6-SYNC-V2]
  // [STAGE-D2-TRANSPORT]
  // [WHY: explicit Restore must be a NEW, newer fact — never a weakening of
  //  what the deletion meant, and never a special local-only override that
  //  merge doesn't understand. Facts.restoreProfile draws a fresh stamp above
  //  everything this device has observed, so it deterministically beats an
  //  older deletion once it propagates, and loses cleanly to a genuinely
  //  NEWER deletion (e.g. someone deleted it again on another device after
  //  this restore) — ordinary LWW, no special-casing required. Re-adds the
  //  Profile to the visible registry so it reappears wherever it was hidden.]
  //
  // No-op (returns false) if profileId is already visible, or has never
  // existed at all (no row to restore).
  async restoreProfile(profileId) {
    await this.#ready;
    if (!profileId) return false;
    if (this.#profiles.some((candidate) => candidate.id === profileId)) return false;

    let projectedName = DEFAULT_PROFILE_NAME;
    try {
      if (profileId === this.#profileId) {
        this.#recordFact((replica, id, stamp) => Facts.restoreProfile(replica, id, stamp));
        this.#persist(); // see the identical note in #tombstoneProfile
        await this.#drainPendingWrites();
        projectedName = this.#profileName;
      } else {
        await this.#identity.ready;
        const stamp = this.#identity.tick();
        const stored = await loadProfileData(profileId);
        if (!stored.facts) return false; // no row at all — nothing to restore
        const current = stored.facts;
        const restored = Facts.restoreProfile(
          { schemaVersion: 2, profiles: { [profileId]: current }, associations: {} },
          profileId,
          stamp
        ).profiles[profileId];
        await saveProfileData(profileId, { items: stored.items, tags: stored.tags, facts: restored });
        const projected = Facts.projectProfile({ schemaVersion: 2, profiles: { [profileId]: restored }, associations: {} }, profileId);
        projectedName = (projected && projected.name) || DEFAULT_PROFILE_NAME;
      }
    } catch (error) {
      console.warn(`[SYNC-V2] Could not restore profile "${profileId}".`, error);
      return false;
    }

    const now = Date.now();
    this.#profiles.push({ id: profileId, name: projectedName, masterFolder: null, createdAt: now, updatedAt: now });
    try {
      await this.#saveRegistryAndAnnounce({ activeProfileId: this.#profileId, profiles: this.#profiles });
    } catch (error) {
      console.warn("[SYNC-V2] Could not save the profile registry after restoring a profile.", error);
    }
    this.#emit();
    return true;
  }

  // ---- Profile Sync support (Profile Sync Folder POC) --------------------
  //
  // [PROFILE-SYNC] Two methods, both built entirely from primitives
  // ProfileStore already uses for itself (this.#profiles/#recordsByPath/
  // #tags in memory for the active profile, loadProfileData/saveProfileData
  // /saveRegistry/deleteProfileData for everything else) — no second
  // Profile persistence path exists anywhere in this file because of Sync.
  //
  // WHY: profile-sync.js needs to read/replace the WHOLE profile
  // collection (every profile, not just the active one) to compute a
  // collection-wide fingerprint and to safely adopt a synced collection.
  // Putting that here, instead of profile-sync.js reaching into
  // indexeddb.js directly, keeps "how Profile data is shaped and
  // persisted" a single ProfileStore responsibility.
  //
  // FUTURE / DO-NOT-BREAK: Any future feature needing "every profile's
  // data" should reuse getFullCollection() rather than re-reading
  // indexeddb.js directly; any future feature needing to bulk-replace the
  // registry should reuse replaceAllProfiles() rather than writing a
  // second saveRegistry()-calling code path.

  /**
   * Returns every known profile's full identity + item/tag data as a plain,
   * serializable array: [{ id, name, masterFolder, items, tags }, ...]. The
   * ACTIVE profile's slice comes from this instance's in-memory state
   * (authoritative — #persist saves it immediately on every mutation, so it
   * is always at least as fresh as IndexedDB); every other profile is read
   * fresh from IndexedDB, since this instance never holds their data in
   * memory.
   *
   * The returned collection is a fully detached snapshot (and, in development,
   * deeply frozen): a caller may hold it across any number of awaits and it
   * will not change underneath them. Callers must not mutate it.
   */
  async getFullCollection() {
    await this.#ready;

    const results = [];
    for (const entry of this.#profiles) {
      if (entry.id === this.#profileId) {
        results.push({
          id: entry.id,
          name: this.#profileName,
          masterFolder: this.#masterFolder,
          // Projected, not raw: this collection is serialized to the sync folder
          // and fingerprinted, so it must carry what a reader can act on. See
          // #projectItems.
          items: this.#projectItems(),
          tags: this.#tags.map((tag) => ({ ...tag })),
        });
        continue;
      }

      let data;
      try {
        data = await loadProfileData(entry.id);
      } catch (error) {
        console.warn(`Could not read profile "${entry.id}" for sync.`, error);
        data = { items: {}, tags: [] };
      }

      results.push({
        id: entry.id,
        name: entry.name || DEFAULT_PROFILE_NAME,
        masterFolder: entry.masterFolder || null,
        items: data.items,
        tags: data.tags,
      });
    }

    // [PHASE-6-SYNC-V2][STAGE-B-SNAPSHOT-INTEGRITY]
    // [WHY: this is the collection Profile Sync fingerprints and then, several
    //  awaits later, serializes to disk. It must be one immutable logical
    //  state for that whole span, or the files written stop matching the
    //  fingerprint published alongside them. One takeSnapshot() over the
    //  finished array covers the active profile's live in-memory records AND
    //  every nested field of every other profile, including fields added long
    //  after this line was written.]
    return takeSnapshot(results);
  }

  /**
   * Replaces the ENTIRE local Profile collection — registry identity AND
   * every profile's item/tag data — with `collection`, an array of the same
   * { id, name, masterFolder, items, tags } shape getFullCollection()
   * produces. Used exclusively by Profile Sync to adopt a synced collection
   * once its conservative three-way comparison has decided that's safe.
   *
   * Registry-level createdAt is preserved for any profile id already known
   * locally (so adopting a synced collection doesn't reset "when was this
   * profile created"); a genuinely new id gets `now`. The active profile
   * is: preferredActiveId if it's present in the new collection, else the
   * CURRENTLY active id if it's still present, else the collection's first
   * entry — so switching to a synced collection never leaves the app
   * without something active.
   *
   * Finishes via the exact same null-profileId-then-switchProfile() reset
   * deleteProfile() already relies on above, so this is not a second,
   * competing way profile state gets applied — it is switchProfile() being
   * pointed at a freshly-written registry/data set instead of an
   * already-existing one.
   */
  async replaceAllProfiles(collection, { preferredActiveId } = {}) {
    await this.#ready;
    if (!Array.isArray(collection) || collection.length === 0) return false;

    const now = Date.now();
    const existingById = new Map(this.#profiles.map((entry) => [entry.id, entry]));

    const profiles = collection.map((incoming) => {
      const existing = existingById.get(incoming.id);
      return {
        id: incoming.id,
        name: incoming.name || DEFAULT_PROFILE_NAME,
        masterFolder: incoming.masterFolder || null,
        createdAt: existing ? existing.createdAt || now : now,
        updatedAt: now,
      };
    });

    const activeId =
      (preferredActiveId && profiles.some((p) => p.id === preferredActiveId) && preferredActiveId) ||
      (profiles.some((p) => p.id === this.#profileId) && this.#profileId) ||
      profiles[0].id;

    for (const incoming of collection) {
      try {
        await saveProfileData(incoming.id, {
          items: isPlainObject(incoming.items) ? incoming.items : {},
          tags: Array.isArray(incoming.tags) ? incoming.tags : [],
          // [PHASE-6-SYNC-V2][STAGE-D1-LOCAL-FOUNDATION]
          // [WHY: an explicit null CLEARS the stored facts (omitting the field
          //  would preserve them — see saveProfileData). This is the one place
          //  that is correct, and it is required for correctness rather than
          //  tidiness: this method is Sync V1's wholesale collection
          //  replacement, so the facts describing the pre-replacement state are
          //  no longer true of anything. Left in place they would be re-applied
          //  by #adoptFacts on the very next load and silently revert the
          //  collection the user just adopted. Clearing forces a fresh seed from
          //  the adopted data, at the seed floor, which every later real
          //  mutation outranks.
          //
          //  This is also the boundary the approved CONTROLLED HARD CUTOVER
          //  policy describes: while V1 is still the writing path, V1 adoption
          //  is authoritative and V2 facts are re-derived from its result. When
          //  an installation is cut over to V2 (Stage D2), this call site is
          //  replaced by a merge, not amended.]
          facts: null,
        });
      } catch (error) {
        console.warn(`Could not save synced profile "${incoming.id}".`, error);
      }
    }

    // A profile present locally but NOT in the incoming collection was
    // deleted on the other side — remove its stored data too, so a deleted
    // Profile can't resurface later. See replaceAllProfiles' caller
    // (profile-sync.js's three-way reconcile) for why this is only ever
    // reached once a deletion has been safely identified as unambiguous.
    const incomingIds = new Set(profiles.map((p) => p.id));
    for (const stale of this.#profiles) {
      if (!incomingIds.has(stale.id)) {
        try {
          await deleteProfileData(stale.id);
        } catch (error) {
          console.warn(`Could not remove obsolete profile "${stale.id}".`, error);
        }
      }
    }

    try {
      await this.#saveRegistryAndAnnounce({ activeProfileId: activeId, profiles });
    } catch (error) {
      console.warn("Could not save the synced profile registry.", error);
    }

    this.#profiles = profiles;
    // Drained before the id is cleared, for the same reason as deleteProfile:
    // #recordFact will not apply a fact to a profile that is no longer active.
    await this.#drainPendingWrites();
    // Forced to null (rather than compared against activeId) so the reset
    // below always runs even when activeId === the currently-active id —
    // the ACTIVE profile's own item/tag content may itself be what changed.
    this.#profileId = null;
    this.#facts = { items: {}, tags: {} };
    await this.switchProfile(activeId);
    return true;
  }

  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  // ---- Same-device freshness (SyncV3, Stage 03C) -------------------------

  /** This page load's ephemeral context id. Diagnostics and self-echo suppression only. */
  getContextId() {
    return this.#localStateChannel ? this.#localStateChannel.contextId : null;
  }

  /** False when BroadcastChannel is unavailable — see refreshFromStorage's WHY. */
  isLocalStateChannelAvailable() {
    return Boolean(this.#localStateChannel && this.#localStateChannel.available);
  }

  // [SYNCV3 / STAGE-09 / SLICE-5-MULTITAB-DECISIONS]
  // [WHY: a thin pass-through over the ONE local-state channel this class owns.
  //  Adding a second BroadcastChannel elsewhere would create a parallel
  //  notification system for the same origin. Nothing about ambient decisions is
  //  stored, cached, or interpreted here - the announcement carries no payload
  //  and the receiver re-reads the decision store, which stays authoritative.]
  announceAmbientProfileDecisionChanged() {
    this.#announceLocalStateChange(LOCAL_STATE_MESSAGE_KINDS.AMBIENT_DECISION_CHANGED);
  }

  /** Subscribes to sibling-context ambient decision announcements. Returns an unsubscribe. */
  subscribeAmbientProfileDecisionChanged(listener) {
    if (typeof listener !== "function") return () => {};
    this.#ambientDecisionListeners.add(listener);
    return () => this.#ambientDecisionListeners.delete(listener);
  }

  /** Releases the channel. Tests and any embedder tearing a context down. */
  closeLocalStateChannel() {
    if (this.#localStateChannel) this.#localStateChannel.close();
    this.#localStateChannel = null;
  }

  // [SYNCV3 / STAGE-03C / SAME-DEVICE-TAB-STATE]
  // [WHY: posted only AFTER the durable write has committed. Announcing before
  //  the write lands would send peers to re-read a database that does not yet
  //  contain the change - they would read the old row, conclude they are current,
  //  and ignore the real change when nothing announced it a second time.]
  #announceLocalStateChange(kind, detail = {}) {
    if (!this.#localStateChannel) return;
    // [SYNCV3 / STAGE-03C / SAME-DEVICE-TAB-STATE]
    // [WHY: the message carries the installation's deviceId so a receiver can
    //  tell "another VIEW of my installation" from "some other installation
    //  entirely". In a browser the distinction is academic - one origin means one
    //  IndexedDB means one deviceId, so every context on the channel is by
    //  definition the same installation. It stops being academic the moment
    //  several installations share a process, which is exactly what the
    //  multi-device test fixtures do: without this scope they cross-notify, and
    //  one simulated device refreshes itself from another's database.]
    this.#localStateChannel.post({
      kind,
      at: Date.now(),
      deviceId: this.#identity ? this.#identity.deviceId : null,
      ...detail,
    });
  }

  #onLocalStateMessage(message) {
    // Only another view of THIS installation can tell us anything about our own
    // storage - see #announceLocalStateChange.
    const ourDeviceId = this.#identity ? this.#identity.deviceId : null;
    if (message.deviceId && ourDeviceId && message.deviceId !== ourDeviceId) return;

    // Proof that another view of this installation is live. Arms the stale-row
    // guard in #persist from here on.
    this.#peerContextObserved = true;

    switch (message.kind) {
      // Presence only - nothing durable changed, so nothing needs re-reading.
      // Answered once so the newcomer learns about THIS context too; HERE is
      // never answered, which is what stops the handshake echoing.
      case LOCAL_STATE_MESSAGE_KINDS.CONTEXT_ONLINE:
        this.#announceLocalStateChange(LOCAL_STATE_MESSAGE_KINDS.CONTEXT_HERE);
        return;
      case LOCAL_STATE_MESSAGE_KINDS.CONTEXT_HERE:
        return;
      case LOCAL_STATE_MESSAGE_KINDS.PROFILE_FACTS_CHANGED:
        // A message about a Profile this context is not showing needs no work:
        // foreign Profiles are read from IndexedDB on demand, never cached here.
        if (message.profileId && message.profileId !== this.#profileId) return;
        break;
      case LOCAL_STATE_MESSAGE_KINDS.PROFILE_REGISTRY_CHANGED:
      case LOCAL_STATE_MESSAGE_KINDS.ASSOCIATIONS_CHANGED:
      case LOCAL_STATE_MESSAGE_KINDS.LIBRARIES_CHANGED:
      case LOCAL_STATE_MESSAGE_KINDS.DEVICE_NAME_CHANGED:
        break;
      // [SYNCV3 / STAGE-09 / SLICE-5-MULTITAB-DECISIONS]
      // [WHY: returns WITHOUT refreshFromStorage(). A sibling's ambient
      //  decision changed a local-only row that this class neither owns nor
      //  caches; re-reading shared Profile/association/Library storage would be
      //  pure waste and would imply shared state moved when none did. This class
      //  owns the one channel, so it demultiplexes the kind and hands it on -
      //  it stores nothing about ambient decisions and interprets nothing.]
      case LOCAL_STATE_MESSAGE_KINDS.AMBIENT_DECISION_CHANGED:
        for (const listener of this.#ambientDecisionListeners) {
          try {
            listener();
          } catch (error) {
            console.warn("[SYNCV3 / STAGE-09] An ambient decision listener failed.", error);
          }
        }
        return;
      default:
        return;
    }
    // [SYNCV3 / STAGE-03C / SAME-DEVICE-TAB-STATE]
    // [WHY: the handler REFRESHES and does nothing else. It does not stamp - the
    //  other context already stamped this mutation, and a second stamp would make
    //  one user action into two logical facts, the later of which could outrank a
    //  genuine concurrent edit on a third device. It does not publish either:
    //  what reaches Drive is decided by the scheduler and the writer lease, not
    //  by whichever context happened to hear about a local change first.]
    const localLibraryLinkChanged = message.kind === LOCAL_STATE_MESSAGE_KINDS.LIBRARIES_CHANGED;
    this.refreshFromStorage()
      .then((durableSharedStateChanged) => {
        // [SYNCV3 / STAGE-08 / MULTITAB-LINK-REFRESH]
        // [WHY: sibling tabs must re-read durable local Library link state after
        // write-then-announce, rather than trusting stale UI state. A local-only
        // link can leave every shared cache byte unchanged, so force one emit
        // only when refreshFromStorage did not already emit for shared changes.]
        if (localLibraryLinkChanged && !durableSharedStateChanged) this.#emit();
      })
      .catch((error) =>
        console.warn("[SYNCV3] Could not refresh local state after a peer context changed it.", error)
      );
  }

  /**
   * Re-reads this context's state from IndexedDB — the local durable authority.
   *
   * [SYNCV3 / STAGE-03C / SAME-DEVICE-TAB-STATE]
   * [WHY: safe to call at any time and from anywhere, because every step is a
   *  MERGE rather than an assignment: facts go through #adoptFacts (LWW by
   *  stamp), associations through mergeMaps. A refresh can therefore never lose a
   *  local mutation that has not reached storage yet, which is what makes it safe
   *  to run on a timer, on a message, and immediately before a publish.
   *
   *  The V3 pass calls this before deriving what to publish, which is why
   *  freshness does not depend on BroadcastChannel being available: without it
   *  peers simply become current at their next pass instead of within
   *  milliseconds, and the writer is still never the stale one.]
   */
  async refreshFromStorage() {
    if (this.#localStateRefresh) return this.#localStateRefresh;
    this.#localStateRefresh = this.#refreshFromStorageImpl().finally(() => {
      this.#localStateRefresh = null;
    });
    return this.#localStateRefresh;
  }

  async #refreshFromStorageImpl() {
    await this.#ready;
    let registryChanged = false;

    // ---- registry (Profile create / rename / delete on a peer context) ----
    try {
      const registry = await loadRegistry();
      if (registry && Array.isArray(registry.profiles)) {
        const incoming = registry.profiles.filter((entry) => entry && typeof entry.id === "string");
        // [SYNCV3 / STAGE-03C / SAME-DEVICE-TAB-STATE]
        // [WHY: the stored registry is authoritative — it has to be, or a Profile
        //  deleted in another tab would be resurrected here on every refresh. The
        //  ONE exception is the Profile this context is actively on: dropping it
        //  from under a live UI mid-session is worse than briefly disagreeing
        //  with storage, and the next registry write reconciles it anyway.]
        const next = incoming.map((entry) => ({ ...entry }));
        if (this.#profileId && !next.some((entry) => entry.id === this.#profileId)) {
          const active = this.#profiles.find((entry) => entry.id === this.#profileId);
          if (active) next.push({ ...active });
        }
        if (MergeEngine.stableStringify(next) !== MergeEngine.stableStringify(this.#profiles)) {
          this.#profiles = next;
          registryChanged = true;
        }
      }
    } catch (error) {
      console.warn("[SYNCV3] Could not re-read the profile registry.", error);
    }

    // ---- active profile facts ----
    try {
      if (this.#profileId) {
        const stored = await loadProfileData(this.#profileId);
        // #adoptFacts merges, applies to local records, emits when something
        // actually changed, and persists only if it had to — so a refresh that
        // finds nothing new is silent and free.
        if (stored && stored.facts) await this.#adoptFacts(stored.facts);
      }
    } catch (error) {
      console.warn("[SYNCV3] Could not re-read the active profile's facts.", error);
    }

    // ---- associations ----
    try {
      await this.#associationsReady;
      const stored = await this.#associationStore.load();
      const merged = MergeEngine.mergeMaps(this.#associations, stored || {}, MergeEngine.mergeFact);
      this.#identity.observeReplica({ profiles: {}, associations: merged, libraries: {} });
      if (MergeEngine.stableStringify(merged) !== MergeEngine.stableStringify(this.#associations)) {
        this.#associations = merged;
        registryChanged = true;
      }
    } catch (error) {
      console.warn("[SYNCV3] Could not re-read library associations.", error);
    }

    // ---- shared Library catalog ----
    // [SYNCV3 / STAGE-04B / SHARED-LIBRARY-RECORD]
    // [WHY: merged, not assigned, for the same reason every block above is - a
    //  refresh must never discard a Library fact this context stamped but has not
    //  yet written. This block is also what makes reload-before-publish carry
    //  Libraries: sync-v3.js calls refreshFromStorage() generically before
    //  deriving the replica, so a writer tab picks up a sibling tab's load here
    //  with no change to the pass itself.]
    try {
      await this.#librariesReady;
      const stored = await loadV3LibrariesCache();
      const merged = MergeEngine.mergeMaps(this.#libraries, stored || {}, MergeEngine.mergeLibraryFacts);
      // [SYNCV3 / CLOCK-HOTFIX / LIBRARY-CACHE-OBSERVATION]
      // [WHY: sibling-context read-back accepts stamped facts just like peer
      //  adoption does, so it must raise the same canonical clock floor.]
      this.#identity.observeReplica({ profiles: {}, associations: {}, libraries: merged });
      if (MergeEngine.stableStringify(merged) !== MergeEngine.stableStringify(this.#libraries)) {
        this.#libraries = merged;
        registryChanged = true;
      }
    } catch (error) {
      console.warn("[SYNCV3] Could not re-read the shared Library catalog.", error);
    }

    // ---- Device Name ----
    // [SYNCV3 / STAGE-05 / DEVICE-NAMING]
    // [WHY: re-reads the persisted name so a sibling tab's rename becomes
    //  visible here without a reload, and so the WRITER tab picks it up before
    //  its next publish - reload-before-publish already calls this method, so
    //  the renamed directory follows with no change to the pass. Reads only;
    //  it can neither mint an identity nor write Drive.]
    try {
      if (typeof this.#identity.refreshDeviceName === "function") {
        const before = this.#identity.displayName;
        await this.#identity.refreshDeviceName();
        if (this.#identity.displayName !== before) registryChanged = true;
      }
    } catch (error) {
      console.warn("[SYNCV3] Could not re-read the Device Name.", error);
    }

    if (registryChanged) this.#emit();
    return registryChanged;
  }

  // [SYNCV3 / STAGE-03C / SAME-DEVICE-TAB-STATE]
  // [WHY: one wrapper so every registry write announces itself. Wrapping rather
  //  than adding a post() beside each of the seven saveRegistry call sites is
  //  the point: a future eighth call site gets the announcement for free, and
  //  cannot forget it.]
  async #saveRegistryAndAnnounce(payload) {
    await saveRegistry(payload);
    this.#announceLocalStateChange(LOCAL_STATE_MESSAGE_KINDS.PROFILE_REGISTRY_CHANGED);
  }

  // [SYNCV3 / STAGE-04B / SHARED-LIBRARY-RECORD]
  // [WHY: announces only AFTER the durable write resolves, matching every other
  //  announcer here. A sibling told to re-read before the row lands would read
  //  the old catalog, conclude it was current, and never hear again.]
  async #saveLibrariesAndAnnounce() {
    await saveV3LibrariesCache(this.#libraries);
    this.#announceLocalStateChange(LOCAL_STATE_MESSAGE_KINDS.LIBRARIES_CHANGED);
  }

  async #saveAssociationsAndAnnounce() {
    await this.#associationStore.save(this.#associations);
    this.#announceLocalStateChange(LOCAL_STATE_MESSAGE_KINDS.ASSOCIATIONS_CHANGED);
  }

  #emit() {
    for (const listener of this.#listeners) listener();
  }

  #getRecord(relativePath) {
    return this.#recordsByPath.get(relativePath) || null;
  }

  #setRecord(relativePath, record) {
    if (!relativePath) return;

    if (isEmptyRecord(record)) {
      this.#recordsByPath.delete(relativePath);
    } else {
      this.#recordsByPath.set(relativePath, record);
    }
  }

  // [PHASE-6-SYNC-V2][STAGE-B-SNAPSHOT-INTEGRITY]
  // [WHY: this assembles the shape only — it is NOT the detachment boundary,
  //  and its shallow copies must never be relied on as one. Every caller wraps
  //  its result in takeSnapshot(), which is what actually severs the nested
  //  references. The shallow copy is kept purely as defence in depth so a live
  //  record object cannot escape even momentarily.]
  #snapshotItems() {
    const items = {};
    for (const [path, record] of this.#recordsByPath.entries()) {
      items[path] = { ...record };
    }
    return items;
  }

  // [PHASE-6-SYNC-V2]
  // [STAGE-D1-LOCAL-FOUNDATION]
  // [WHY: deleting a tag now tombstones it and deliberately leaves the per-item
  //  assignments underneath, so an explicit Restore brings the user's tagging
  //  back instead of silently losing it (Stage C semantics). Those retained
  //  assignments are internal bookkeeping, not user-visible state: no live tag
  //  resolves the id, so exposing it would mean an export carrying ids that
  //  resolve to nothing, and item-tag reads reporting tags the user cannot see.
  //  Filtering therefore happens HERE, at the projection/export boundary only —
  //  never on the storage path (#persist uses #snapshotItems), because
  //  projecting into storage is what would destroy the facts Restore needs.]
  #projectItems() {
    const liveTagIds = new Set(this.#tags.map((tag) => tag.id));
    const items = {};

    for (const [path, record] of this.#recordsByPath.entries()) {
      const projected = { ...record };

      if (Array.isArray(record.tags)) {
        const visible = record.tags.filter((tagId) => liveTagIds.has(tagId));
        if (visible.length !== record.tags.length) projected.tags = visible;
      }

      // A record that exists ONLY to hold assignments to deleted tags carries
      // nothing a reader can act on — same rule #setRecord already applies to a
      // record whose every field is default.
      if (isEmptyRecord(projected)) continue;
      items[path] = projected;
    }

    return items;
  }

  #persist() {
    // [PHASE-6-SYNC-V2][STAGE-B-SNAPSHOT-INTEGRITY]
    // [WHY: this snapshot is built synchronously but written asynchronously,
    //  behind a queue that may drain several mutations later. Without a real
    //  detachment it shares tag.tagActivity (and any future nested field) with
    //  live state, so the row that eventually lands in IndexedDB is not the row
    //  this mutation intended to save. Same defect class as the sync-write
    //  corruption, with a shorter window.]
    const snapshot = takeSnapshot({
      items: this.#snapshotItems(),
      tags: this.#tags.map((tag) => ({ ...tag })),
    });

    // Captured NOW (synchronously, at the moment of the mutation that
    // triggered this save) rather than read lazily once the async chain
    // below finally runs. This matters once profiles can be switched
    // (Phase 8.2): if this.#profileId changes while this save is still
    // queued, a lazy read would misfile this snapshot under the NEW
    // profile's id instead of the one it actually belongs to.
    const targetProfileId = this.#profileId;
    // See #drainPendingWrites — counted the same way #pendingFacts is, so a
    // profile switch cannot proceed while a write for the outgoing profile is
    // still queued.
    this.#pendingSaves += 1;

    // Serializing writes prevents an older save from finishing after a newer
    // favorite toggle and overwriting it in the database. Also waits on
    // #ready first: item/tag saves must always land under a resolved
    // profileId, never before it's known.
    this.#saveQueue = this.#saveQueue
      .catch(() => undefined)
      .then(() => this.#ready)
      // [PHASE-6-SYNC-V2][STAGE-D1-LOCAL-FOUNDATION]
      // [WHY: waiting on the fact queue means the row written below always
      //  contains the facts for every mutation that preceded it. Values are
      //  snapshotted at mutation time (Stage B) while facts are read at drain
      //  time — deliberately different, because a value must record what the
      //  user did at that instant, whereas facts are cumulative and monotone,
      //  so the freshest set is always the correct one to store.]
      .then(() => this.#factQueue)
      .then(async () => {
        const profileId = targetProfileId || this.#profileId;
        if (!profileId) return;
        // Facts are only supplied for the profile still active; a save queued
        // before a profile switch passes undefined, which saveProfileData
        // treats as "preserve what is stored" rather than "erase".
        const facts = profileId === this.#profileId ? takeSnapshot(this.#facts) : undefined;
        if (!facts) {
          await saveProfileData(profileId, { ...snapshot, facts });
          return;
        }

        // [SYNCV3 / STAGE-03C / SAME-DEVICE-TAB-STATE]
        // [WHY: THE stale-row guard, and it is deliberately narrow: it makes the
        //  row's FACTS monotone and leaves the row's value representation exactly
        //  as it has always been written.
        //
        //  Same-origin contexts share this row and each writes it WHOLE, so a
        //  context holding a slightly older view would otherwise overwrite a
        //  sibling's newer facts with its own - silently, with no version
        //  anywhere to notice. Re-reading and merging fixes that:
        //  mergeProfileFacts is LWW by stamp, so the facts that land are the
        //  union regardless of which context wrote first. It is a
        //  compare-and-merge rather than a compare-and-fail, so it never retries
        //  and cannot livelock.
        //
        //  An earlier version also RECONSTRUCTED items/tags from the merged facts
        //  before writing. That was wrong: it changed the row's value shape -
        //  pruning records the normal path keeps, materialising fields the normal
        //  path omits - and two V2 tests caught it immediately. Facts are what
        //  sync publishes and what the value records are projected FROM, so
        //  merging facts alone is sufficient; the records self-heal through
        //  #absorbRefreshedFacts below and the persist it schedules.
        //
        //  Deliberately independent of BroadcastChannel: this must hold on a
        //  browser without it, and for any message that is simply missed.]
        // Armed by a peer message or by a peer's presence announcement, and
        // unconditionally when there is no channel to hear one on - see
        // #peerContextObserved.
        const guardArmed =
          this.#peerContextObserved || !(this.#localStateChannel && this.#localStateChannel.available);
        if (!guardArmed) {
          await saveProfileData(profileId, { ...snapshot, facts });
          this.#announceLocalStateChange(LOCAL_STATE_MESSAGE_KINDS.PROFILE_FACTS_CHANGED, { profileId });
          return;
        }

        // [SYNCV3 / STAGE-03C / SAME-DEVICE-TAB-STATE]
        // [WHY: the merge happens INSIDE saveProfileData's transaction, not here.
        //  An earlier version read the row, merged, then wrote - which is not
        //  atomic, so two contexts saving at the same instant both read the old
        //  row and the second write still erased the first's facts. Handing the
        //  merge to the write transaction is what actually closes that race; this
        //  callback just supplies the algebra and captures the result.]
        let mergedFacts = null;
        await saveProfileData(profileId, {
          ...snapshot,
          facts,
          mergeFacts: (mine, storedFacts) => {
            mergedFacts = MergeEngine.mergeProfileFacts(mine, storedFacts);
            return mergedFacts;
          },
        });
        this.#announceLocalStateChange(LOCAL_STATE_MESSAGE_KINDS.PROFILE_FACTS_CHANGED, { profileId });

        const gainedFacts =
          Boolean(mergedFacts) && MergeEngine.stableStringify(mergedFacts) !== MergeEngine.stableStringify(facts);

        // Only when storage genuinely held something this context had not seen.
        // Terminates: the persist this schedules merges against storage, finds
        // nothing new, and absorbs nothing.
        if (gainedFacts && profileId === this.#profileId) this.#absorbRefreshedFacts(mergedFacts);
      })
      .catch((error) => {
        // Persistence must never make the in-memory profile unusable.
        console.warn("Could not save gallery profile.", error);
      })
      .then(() => {
        this.#pendingSaves -= 1;
      });
  }

  async #loadSavedRecords() {
    try {
      await this.#ready;
      if (!this.#profileId) return;

      const { items, tags, facts } = await loadProfileData(this.#profileId);

      if (!this.#replaceBeforeLoad) {
        for (const [path, record] of Object.entries(items)) {
          if (typeof path !== "string" || !path || !isPlainObject(record)) continue;

          if (this.#changedBeforeLoad.has(path)) continue;

          this.#setRecord(path, record);
        }
      }

      // Tags now go through the same replace-vs-merge distinction as items
      // above: a replace-mode import already fully replaced #tags
      // synchronously (see importJSON), so a late-arriving IndexedDB read
      // from BEFORE that replace must not merge the old vocabulary back in
      // underneath it. In normal use this window is effectively
      // unreachable (importing requires clicking through a file picker,
      // which takes far longer than this read resolving), but it's a real
      // race for anything that imports programmatically right after
      // construction, so it's guarded the same way regardless.
      if (!this.#replaceBeforeLoad) {
        for (const tag of tags) {
          if (!isPlainObject(tag) || typeof tag.id !== "string" || typeof tag.name !== "string") continue;
          if (this.#tagIdsChangedBeforeLoad.has(tag.id)) continue;
          if (this.#tags.some((existing) => existing.id === tag.id)) continue;
          this.#tags.push({ ...tag });
        }
      }

      await this.#adoptFacts(facts);

      this.#emit();
      this.#persist();
    } catch (error) {
      // Browsers can disable private-mode storage. Favorites should still
      // work for the current session if persistence is unavailable.
      console.warn("Could not load gallery profile.", error);
    }
  }

  // [PHASE-6-SYNC-V2]
  // [STAGE-D1-LOCAL-FOUNDATION]
  // [WHY: a profile arrives in exactly one of two states, and confusing them is
  //  destructive. `null` facts means this profile predates Sync V2 and must be
  //  seeded ONCE from its existing curation; stored facts mean it is already
  //  under the fact model and must be adopted, never re-seeded — re-seeding
  //  would re-stamp everything at the floor and throw away the real ordering
  //  information the profile had earned. Seeding is also the moment the clock
  //  floor is restored from what is already stored, so no stamp issued
  //  afterwards can collide with or fall beneath the profile's own history.]
  async #adoptFacts(storedFacts) {
    // Awaited FIRST, so everything after it runs synchronously: the read of
    // this.#facts, the merge, and the assignment must be one uninterrupted step
    // or a fact draining between them would be overwritten.
    await this.#identity.ready;

    const profileId = this.#profileId;
    if (!profileId) return;

    if (storedFacts) {
      // [PHASE-6-SYNC-V2][STAGE-D1-LOCAL-FOUNDATION]
      // [WHY: MERGED into whatever is already held, never assigned over it. A
      //  mutation can legitimately be stamped while this load is in flight — a
      //  favourite clicked during a profile switch, or before the initial read
      //  resolves — and assigning would discard it with no trace. Merge is the
      //  right operation rather than a workaround: it is commutative and
      //  idempotent, so "what was stored" and "what just happened" combine to
      //  the same result in either order. In the ordinary case the held slice is
      //  empty and this is exactly adoption.]
      const merged = MergeEngine.mergeProfileFacts(this.#facts, storedFacts);
      // [PHASE-6-SYNC-V2][STAGE-D2-TRANSPORT]
      // [WHY: persistence must follow whether the FACTS changed, not only
      //  whether #applyFactsToLocal found a name/item/tag difference worth
      //  writing to local records. profile.deleted (and profile.name when it
      //  equals what's already local) are real fields on the SAME facts object
      //  that #applyFactsToLocal never reads at all — merging in a fresh
      //  tombstone with no other change would otherwise leave the tombstone
      //  sitting only in memory, discarded the moment this profile is next
      //  reset (e.g. by switchProfile), and never actually written to the row
      //  whose whole job is making it durable.]
      const factsChanged = MergeEngine.stableStringify(merged) !== MergeEngine.stableStringify(this.#facts);
      this.#facts = merged;
      this.#identity.observeReplica({ profiles: { [profileId]: this.#facts }, associations: {} });

      // Facts are authoritative for everything they describe, so any drift
      // between them and the stored records self-heals here on every load.
      const localChanged = this.#applyFactsToLocal(this.#facts);
      if (localChanged || factsChanged) this.#persist();

      // [PHASE-6-SYNC-V2]
      // [STAGE-E-LIVE-REMOTE-PROJECTION]
      // [WHY: synchronized facts adopted into the active Profile must
      //  immediately become visible in the loaded UI on either device without
      //  reload or local interaction. This emit was missing entirely, and it is
      //  the whole bug: a remote favorite/hide/tag reached #recordsByPath and
      //  IndexedDB (so an export was correct) but NOTHING was notified, because
      //  adoptMergedReplica only emits when the REGISTRY changes — adding,
      //  removing or renaming a Profile — and a favorite on an already-known
      //  active Profile changes no registry entry. Every live surface in
      //  main.js hangs off profile.subscribe(), so all of them silently kept
      //  rendering pre-sync state. Gated on localChanged so an idle no-op pass
      //  still notifies nobody and costs nothing.]
      if (localChanged) this.#emit();
      this.#queueFactDriftReport("after adopting stored facts");
      return;
    }

    const seeded = seedFactsFromProfileData(
      {
        profileId,
        name: this.#profileName,
        items: this.#snapshotItems(),
        tags: this.#tags,
      },
      localSeedStamp(this.#identity.deviceId)
    );
    // Same reasoning as above, and it matters more here: a seed stamp is the
    // lowest in the system, so a real mutation merged against it always wins.
    this.#facts = MergeEngine.mergeProfileFacts(this.#facts, seeded);
    this.#persist();
    this.#queueFactDriftReport("after seeding facts from local state");
  }

  // [PHASE-6-SYNC-V2]
  // [STAGE-D1-LOCAL-FOUNDATION]
  // [WHY: applies ONLY the fields that actually differ. Sync V1 adopted state
  //  by replacing whole records, which silently took every local-only field on
  //  them along too. Writing field by field is what lets tagActivity, an
  //  unknown field from an imported profile, and a future schema addition all
  //  survive a sync untouched — the record is only rewritten where a fact says
  //  it must be. Returns whether anything changed so callers can avoid a
  //  pointless emit/persist.]
  // [SYNCV3 / STAGE-03C / SAME-DEVICE-TAB-STATE]
  // [WHY: the memory-only half of adoption - merge, project onto local records,
  //  notify. It exists so #persist's read-modify-write can make this context
  //  current WITHOUT scheduling another save: the row it just wrote already
  //  contains exactly these facts, and a second save would find the same union,
  //  write it again, and announce it again on every mutation forever.]
  #absorbRefreshedFacts(facts) {
    const merged = MergeEngine.mergeProfileFacts(this.#facts, facts);
    if (MergeEngine.stableStringify(merged) === MergeEngine.stableStringify(this.#facts)) return;
    this.#facts = merged;
    if (this.#profileId) {
      this.#identity.observeReplica({ profiles: { [this.#profileId]: this.#facts }, associations: {} });
    }
    if (this.#applyFactsToLocal(this.#facts)) {
      this.#emit();
      // The value records just changed to match the newly-merged facts, so the
      // row has to be rewritten to match. Safe from recursion: that save merges
      // against storage, finds nothing new, and absorbs nothing.
      this.#persist();
    }
  }

  #applyFactsToLocal(facts) {
    const diff = diffFactsAgainstProfileData(facts, {
      name: this.#profileName,
      items: this.#snapshotItems(),
      tags: this.#tags,
    });

    let changed = false;

    if (diff.profileName !== null) {
      this.#profileName = diff.profileName;
      changed = true;
    }

    for (const tag of diff.tags.add) {
      this.#tags.push({ id: tag.id, name: tag.name });
      changed = true;
    }
    for (const tag of diff.tags.rename) {
      const existing = this.#tags.find((candidate) => candidate.id === tag.id);
      if (existing) {
        existing.name = tag.name;
        changed = true;
      }
    }
    for (const tagId of diff.tags.remove) {
      const index = this.#tags.findIndex((candidate) => candidate.id === tagId);
      if (index >= 0) {
        // Only the vocabulary entry goes. Per-item assignments stay on their
        // records so an explicit restore brings them back (Stage C semantics);
        // while the tag is tombstoned nothing can resolve the id to a name, so
        // they are invisible.
        this.#tags.splice(index, 1);
        changed = true;
      }
    }

    for (const item of diff.items) {
      const existing = this.#getRecord(item.path) || {};
      const record = { ...existing };

      if ("favorite" in item) {
        record.favorite = item.favorite;
        if (item.favorite && item.favoritedAt !== null && item.favoritedAt !== undefined) {
          record.favoritedAt = item.favoritedAt;
        } else {
          delete record.favoritedAt;
        }
      }
      if ("hidden" in item) record.hidden = item.hidden;

      if (item.addTags.length || item.removeTags.length) {
        const tagIds = new Set(Array.isArray(existing.tags) ? existing.tags : []);
        for (const tagId of item.addTags) tagIds.add(tagId);
        for (const tagId of item.removeTags) tagIds.delete(tagId);
        record.tags = [...tagIds];
      }

      this.#setRecord(item.path, record);
      this.#changedBeforeLoad.add(item.path);
      changed = true;
    }

    return changed;
  }

  // ---- Favorites (Phase 1) -------------------------------------------

  isFavorite(relativePath) {
    const record = this.#getRecord(relativePath);
    return Boolean(record && record.favorite);
  }

  // Timestamp (ms) of the most recent time this path was favorited, or
  // null if it isn't currently favorited / was never favorited under the
  // new schema (older exported profiles won't have this field — treated
  // as "unknown", not "never", so those still sort, just last).
  getFavoritedAt(relativePath) {
    const record = this.#getRecord(relativePath);
    return record && record.favorite && typeof record.favoritedAt === "number" ? record.favoritedAt : null;
  }

  setFavorite(relativePath, value) {
    if (!relativePath) return;

    const existing = this.#getRecord(relativePath) || {};
    const nextValue = Boolean(value);
    const record = { ...existing, favorite: nextValue };

    if (nextValue) {
      // Re-favoriting counts as "new" for ordering purposes, matching how
      // the user experiences it (Gallery Favourite Ordering).
      record.favoritedAt = Date.now();
    } else {
      delete record.favoritedAt;
    }

    this.#setRecord(relativePath, record);
    this.#changedBeforeLoad.add(relativePath);
    this.#emit();
    // `at` is captured from the record written above, not re-read from
    // Date.now() when the queue drains: the fact must carry the instant the user
    // acted, which is what makes favourite ordering agree across devices.
    const at = nextValue ? record.favoritedAt : null;
    this.#recordFact((replica, profileId, stamp) =>
      Facts.setFavorite(replica, profileId, relativePath, nextValue, stamp, { at })
    );
    this.#persist();
  }

  toggleFavorite(relativePath) {
    this.setFavorite(relativePath, !this.isFavorite(relativePath));
  }

  // ---- Hidden (Phase 4 — Presentation Filter) ---------------------------
  //
  // Hidden is a completely independent field from favorite — a record can
  // be favorite, hidden, both, or neither. It reuses the exact same
  // storage path (ProfileStore -> IndexedDB) with zero new persistence
  // code, since records were already "open shape" from Phase 1.

  isHidden(relativePath) {
    const record = this.#getRecord(relativePath);
    return Boolean(record && record.hidden);
  }

  setHidden(relativePath, value) {
    if (!relativePath) return;

    const existing = this.#getRecord(relativePath) || {};
    const nextValue = Boolean(value);
    this.#setRecord(relativePath, { ...existing, hidden: nextValue });
    this.#changedBeforeLoad.add(relativePath);
    this.#emit();
    this.#recordFact((replica, profileId, stamp) =>
      Facts.setHidden(replica, profileId, relativePath, nextValue, stamp)
    );
    this.#persist();
  }

  toggleHidden(relativePath) {
    this.setHidden(relativePath, !this.isHidden(relativePath));
  }

  // ---- Tags (Phase 6.1 — Tag Management) ---------------------------------
  //
  // Vocabulary: create/rename/delete a tag *definition*. Assigning a tag to
  // an item (item.userTags) is handled below, in Phase 6.2.

  getTags() {
    // Sorted by name for a stable, predictable grid — creation order isn't
    // meaningful once there are more than a couple of tags.
    return this.#tags.map((tag) => ({ ...tag })).sort((a, b) => a.name.localeCompare(b.name));
  }

  recordTagActivity(tagId, { position, total, timestamp = Date.now(), shuffle } = {}) {
    const tag = this.#tags.find((candidate) => candidate.id === tagId);
    const normalizedPosition = Number(position);
    const normalizedTotal = Number(total);
    const normalizedTimestamp = Number(timestamp);

    if (
      !tag ||
      !Number.isInteger(normalizedPosition) ||
      !Number.isInteger(normalizedTotal) ||
      normalizedPosition < 1 ||
      normalizedTotal < normalizedPosition ||
      !Number.isFinite(normalizedTimestamp)
    ) {
      return false;
    }

    // Legacy flat fields — kept purely for backward compatibility (an
    // older exported profile, or any other code still reading these
    // directly) and always reflect whichever tagging action happened most
    // recently, regardless of Shuffle mode. Phase 8.3-2 stops treating
    // these as the source of truth for display/resume — see tagActivity
    // below and getTagActivity() — since a single flat position can't
    // represent "where I was in Shuffle OFF" AND "where I was in Shuffle
    // ON" at the same time.
    tag.lastTagPosition = normalizedPosition;
    tag.totalAtTime = normalizedTotal;
    tag.lastTaggedAt = normalizedTimestamp;

    if (typeof shuffle === "boolean") {
      tag.lastTagShuffle = shuffle;

      // [Phase 8.3-2] Two independent resume points, keyed by the Shuffle
      // mode active at the moment of tagging. A later Shuffle ON tagging
      // action must never overwrite the saved Shuffle OFF position (or
      // vice versa) — each mode keeps its own last-known
      // {position, total, timestamp}, only ever overwritten by a later
      // tagging action in that SAME mode.
      if (!isPlainObject(tag.tagActivity)) tag.tagActivity = {};
      tag.tagActivity[shuffle ? "shuffleOn" : "shuffleOff"] = {
        position: normalizedPosition,
        total: normalizedTotal,
        timestamp: normalizedTimestamp,
      };
    }
    // If `shuffle` isn't a boolean (a caller that doesn't know the Shuffle
    // state at all), only the legacy flat fields above are updated — we
    // never guess which bucket an unknown mode belongs in.

    this.#tagIdsChangedBeforeLoad.add(tagId);
    this.#emit();
    this.#persist();
    return true;
  }

  // Reads back the two independent resume points Phase 8.3-2 introduced.
  // Each of `shuffleOff`/`shuffleOn` is either a
  // { position, total, timestamp } snapshot or null if that mode has never
  // been tagged in for this tag.
  //
  // `legacy` covers a record written before Shuffle context was tracked at
  // all (pre-8.4 — lastTagShuffle is genuinely undefined, not false): its
  // position is real and still perfectly usable for resuming, but it is
  // deliberately kept OUT of the shuffleOff/shuffleOn buckets rather than
  // guessed into one, since that would fabricate a Shuffle state that was
  // never actually recorded.
  //
  // A record that DOES know its Shuffle mode (lastTagShuffle is a real
  // boolean) but predates the tagActivity object itself (written between
  // 8.4 and this phase) is bucketed correctly straight away — that much is
  // known, not guessed.
  getTagActivity(tagId) {
    const tag = this.#tags.find((candidate) => candidate.id === tagId);
    if (!tag) return { shuffleOff: null, shuffleOn: null, legacy: null };

    const hasLegacyPosition =
      Number.isInteger(tag.lastTagPosition) &&
      Number.isInteger(tag.totalAtTime) &&
      Number.isFinite(tag.lastTaggedAt);
    const legacySnapshot = hasLegacyPosition
      ? { position: tag.lastTagPosition, total: tag.totalAtTime, timestamp: tag.lastTaggedAt }
      : null;

    const modern = isPlainObject(tag.tagActivity) ? tag.tagActivity : null;

    const shuffleOff =
      (modern && modern.shuffleOff) || (!modern && tag.lastTagShuffle === false ? legacySnapshot : null);
    const shuffleOn =
      (modern && modern.shuffleOn) || (!modern && tag.lastTagShuffle === true ? legacySnapshot : null);
    const legacy = !modern && typeof tag.lastTagShuffle !== "boolean" ? legacySnapshot : null;

    return { shuffleOff, shuffleOn, legacy };
  }

  #tagNameExists(name, excludingId = null) {
    const normalized = name.toLowerCase();
    return this.#tags.some((tag) => tag.id !== excludingId && tag.name.toLowerCase() === normalized);
  }

  createTag(name) {
    const trimmed = (name || "").trim();
    if (!trimmed) return null;
    if (this.#tagNameExists(trimmed)) return null; // "Nature" / "nature" would be indistinguishable chips

    const tag = {
      id: `tag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: trimmed,
    };

    this.#tags.push(tag);
    this.#tagIdsChangedBeforeLoad.add(tag.id);
    this.#emit();
    this.#recordFact((replica, profileId, stamp) => Facts.createTag(replica, profileId, tag.id, trimmed, stamp));
    this.#persist();
    return { ...tag };
  }

  renameTag(id, name) {
    const trimmed = (name || "").trim();
    if (!trimmed) return false;

    const tag = this.#tags.find((t) => t.id === id);
    if (!tag) return false;
    if (this.#tagNameExists(trimmed, id)) return false;

    tag.name = trimmed;
    this.#tagIdsChangedBeforeLoad.add(id);
    this.#emit();
    this.#recordFact((replica, profileId, stamp) => Facts.renameTag(replica, profileId, id, trimmed, stamp));
    this.#persist();
    return true;
  }

  // [PHASE-6-SYNC-V2]
  // [STAGE-D1-LOCAL-FOUNDATION]
  // [WHY: this used to STRIP the deleted tag from every record that carried it.
  //  That made deletion destructive and irreversible — the assignments were
  //  gone, so a Restore could bring the tag back but never the tagging work, and
  //  across devices a delete arriving before a peer's tagging would erase it
  //  with nothing to replay. Deletion is now exactly one tombstone fact and the
  //  assignments stay underneath it, which is what Stage C's restore semantics
  //  require. The assignments are hidden rather than deleted: every read that
  //  faces a user or a file goes through #projectItems/getItemTags, which report
  //  only tags that currently exist.]
  deleteTag(id) {
    const index = this.#tags.findIndex((t) => t.id === id);
    if (index === -1) return false;

    this.#tags.splice(index, 1);
    this.#tagIdsChangedBeforeLoad.add(id);

    this.#emit();
    this.#recordFact((replica, profileId, stamp) => Facts.deleteTag(replica, profileId, id, stamp));
    this.#persist();
    return true;
  }

  // ---- Item Tags (Phase 6.2 — Fast Tagging) ------------------------------
  //
  // Which tags (by id) are applied to a specific media item, as opposed to
  // the tag VOCABULARY above (which tags exist at all). Stored on the same
  // "open shape" per-path record as favorite/hidden, under a `tags` array
  // of tag ids — so it persists, exports, and imports for free via the
  // exact same machinery those fields already use.

  // Reports only assignments to tags that currently EXIST. An assignment to a
  // tombstoned tag is retained on the record (so Restore can bring it back) but
  // is not user-visible state — nothing resolves the id to a name, so reporting
  // it here would make item.userTags and the tag chips disagree. See
  // #projectItems for the full reasoning.
  getItemTags(relativePath) {
    const record = this.#getRecord(relativePath);
    if (!record || !Array.isArray(record.tags)) return [];

    const liveTagIds = new Set(this.#tags.map((tag) => tag.id));
    return record.tags.filter((tagId) => liveTagIds.has(tagId));
  }

  hasItemTag(relativePath, tagId) {
    return this.getItemTags(relativePath).includes(tagId);
  }

  setItemTag(relativePath, tagId, value) {
    if (!relativePath || !tagId) return;

    const existing = this.#getRecord(relativePath) || {};
    const currentTags = Array.isArray(existing.tags) ? existing.tags : [];
    const nextValue = Boolean(value);
    if (currentTags.includes(tagId) === nextValue) return; // no-op, skip redundant persist/emit

    const nextTags = nextValue ? [...currentTags, tagId] : currentTags.filter((id) => id !== tagId);

    this.#setRecord(relativePath, { ...existing, tags: nextTags });
    this.#changedBeforeLoad.add(relativePath);
    this.#emit();
    this.#recordFact((replica, profileId, stamp) =>
      Facts.setItemTag(replica, profileId, relativePath, tagId, nextValue, stamp)
    );
    this.#persist();
  }

  // Fast Tagging's whole interaction (Phase 6.2): one click assigns, the
  // same click again removes. No dialog, no separate add/remove buttons.
  toggleItemTag(relativePath, tagId) {
    this.setItemTag(relativePath, tagId, !this.hasItemTag(relativePath, tagId));
  }

  // ---- Introspection ---------------------------------------------------

  size() {
    return this.#recordsByPath.size;
  }

  knownPaths() {
    return [...this.#recordsByPath.keys()];
  }

  // ---- Export ------------------------------------------------------------

  // [PHASE-6-SYNC-V2][STAGE-B-SNAPSHOT-INTEGRITY]
  // [WHY: export is the third place a live record used to escape behind a
  //  shallow copy. Nothing today holds this result across an await, so it has
  //  never corrupted a file — but leaving one aliased exit open is how the
  //  boundary erodes, and routing it through the same takeSnapshot() keeps
  //  "no live Profile reference leaves this class" a rule with no exceptions
  //  to remember.]
  toJSON() {
    // Projected, not raw — an export must never contain a tag id that resolves
    // to no tag. See #projectItems.
    const items = this.#projectItems();

    return takeSnapshot({
      schemaVersion: SCHEMA_VERSION,
      kind: KIND,
      exportedAt: new Date().toISOString(),
      // Identity metadata (Phase 8.1). Informational only for now — import
      // intentionally does not read these back yet (see importJSON), so
      // importing a file never changes *this* browser's profile identity.
      // That stays deferred to the Profile Selector phase, which is where
      // "import as a new profile" vs. "import into the current profile"
      // actually needs to be decided.
      profileId: this.#profileId,
      profileName: this.#profileName,
      masterFolder: this.#masterFolder,
      items,
      tags: this.#tags.map((tag) => ({ ...tag })),
    });
  }

  exportText() {
    return JSON.stringify(this.toJSON(), null, 2);
  }

  // ---- Import ------------------------------------------------------------

  /**
   * Imports a previously-exported profile.
   *
   * options:
   *   - mode: "merge" (default) field-merges each incoming record onto any
   *     existing record for that path, so fields the import doesn't mention
   *     (e.g. a locally-set "hidden" flag, once that ships) survive.
   *     "replace" wipes the current profile first, then loads exactly
   *     what's in the file.
   *   - skipMissingFiles: if true, only apply entries whose path is in
   *     knownRelativePaths (the files actually loaded in this session
   *     right now). Entries for anything else are counted as skipped and
   *     not stored. Defaults to false, since a profile is often imported
   *     *before* the matching folder is loaded — portability is the point.
   *   - knownRelativePaths: iterable of relative paths currently loaded;
   *     only consulted when skipMissingFiles is true.
   *
   * Malformed individual entries are skipped rather than aborting the
   * whole import over one bad record. Throws only if the file isn't a
   * recognizable profile at all (no "items" object).
   *
   * Returns { applied, skipped, mode }.
   */
  importJSON(data, { mode = "merge", skipMissingFiles = false, knownRelativePaths = [] } = {}) {
    const parsed = typeof data === "string" ? JSON.parse(data) : data;

    if (!isPlainObject(parsed) || !isPlainObject(parsed.items)) {
      throw new Error("Not a recognized profile file (missing an 'items' object).");
    }

    const knownSet = skipMissingFiles ? new Set(knownRelativePaths) : null;

    // Captured before ANY mutation below, in both modes — see diffLocalStates
    // in sync-translate.js for why comparing this to the state once import has
    // finished is what makes "no opinion" vs. "explicit removal" fall out
    // automatically from each mode's existing, already-approved semantics
    // rather than needing separate handling here.
    const beforeItems = this.#snapshotItems();
    const beforeTags = this.#tags.map((tag) => ({ ...tag }));

    if (mode === "replace") {
      this.#recordsByPath.clear();
      this.#tags = [];
      this.#replaceBeforeLoad = true;
    }

    let applied = 0;
    let skipped = 0;

    for (const [path, incoming] of Object.entries(parsed.items)) {
      if (typeof path !== "string" || !path || !isPlainObject(incoming)) {
        skipped += 1;
        continue;
      }

      if (knownSet && !knownSet.has(path)) {
        skipped += 1;
        continue;
      }

      const existing = mode === "merge" ? this.#getRecord(path) || {} : {};
      this.#setRecord(path, { ...existing, ...incoming });
      this.#changedBeforeLoad.add(path);
      applied += 1;
    }

    if (Array.isArray(parsed.tags)) {
      const incomingTags = parsed.tags.filter(
        (tag) => isPlainObject(tag) && typeof tag.id === "string" && tag.id && typeof tag.name === "string" && tag.name
      );

      if (mode === "replace") {
        this.#tags = incomingTags.map((tag) => ({ ...tag }));
      } else {
        for (const incomingTag of incomingTags) {
          const existingIndex = this.#tags.findIndex((tag) => tag.id === incomingTag.id);
          if (existingIndex >= 0) {
            this.#tags[existingIndex] = { ...this.#tags[existingIndex], ...incomingTag };
          } else {
            this.#tags.push({ ...incomingTag });
          }
        }
      }

      incomingTags.forEach((tag) => this.#tagIdsChangedBeforeLoad.add(tag.id));
    }

    // [PHASE-6-SYNC-V2]
    // [STAGE-D1-LOCAL-FOUNDATION]
    // [WHY: imports must participate in Sync V2 facts, same as any other
    //  mutation, or curation restored/changed via import would silently fail to
    //  propagate. The diff runs against the FINISHED local state (after both
    //  the item loop and the tag loop above), not incrementally per field,
    //  because replace mode's tag removals are only knowable once the whole
    //  tag list has been rebuilt.]
    this.#stampImportDiff({ items: beforeItems, tags: beforeTags }, { items: this.#snapshotItems(), tags: this.#tags });

    this.#emit();
    this.#persist();
    return { applied, skipped, mode };
  }

  // See importJSON. One #recordFact call per changed field, so each gets its
  // own stamp — identical to how a UI click on a single field would be
  // recorded, just issued in a batch here instead of one at a time.
  #stampImportDiff(before, after) {
    const diff = diffLocalStates(before, after);

    for (const tag of diff.tags.add) {
      this.#recordFact((replica, profileId, stamp) => Facts.createTag(replica, profileId, tag.id, tag.name, stamp));
    }
    for (const tag of diff.tags.rename) {
      this.#recordFact((replica, profileId, stamp) => Facts.renameTag(replica, profileId, tag.id, tag.name, stamp));
    }
    for (const tagId of diff.tags.remove) {
      this.#recordFact((replica, profileId, stamp) => Facts.deleteTag(replica, profileId, tagId, stamp));
    }

    for (const item of diff.items) {
      if ("favorite" in item) {
        const at = item.favoritedAt;
        this.#recordFact((replica, profileId, stamp) =>
          Facts.setFavorite(replica, profileId, item.path, item.favorite, stamp, {
            at: Number.isFinite(at) ? at : undefined,
          })
        );
      }
      if ("hidden" in item) {
        this.#recordFact((replica, profileId, stamp) =>
          Facts.setHidden(replica, profileId, item.path, item.hidden, stamp)
        );
      }
      for (const tagId of item.addTags) {
        this.#recordFact((replica, profileId, stamp) =>
          Facts.setItemTag(replica, profileId, item.path, tagId, true, stamp)
        );
      }
      for (const tagId of item.removeTags) {
        this.#recordFact((replica, profileId, stamp) =>
          Facts.setItemTag(replica, profileId, item.path, tagId, false, stamp)
        );
      }
    }
  }
}
