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
import {
  seedFactsFromProfileData,
  diffFactsAgainstProfileData,
  diffLocalStates,
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

export class ProfileStore {
  #recordsByPath = new Map();
  #listeners = new Set();
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

  constructor({ identity } = {}) {
    // Loading is intentionally started by the store itself. Consumers keep
    // using the synchronous ProfileStore API; once saved records arrive, the
    // normal subscription mechanism refreshes any loaded media.
    this.#identity = identity || new SyncIdentity();
    this.#ready = this.#resolveActiveProfile();
    this.#loadSavedRecords();
  }

  /** This installation's stable device identity. Null until it resolves. */
  getDeviceId() {
    return this.#identity.deviceId;
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

  /** The active profile's fact slice, detached. */
  getFacts() {
    return takeSnapshot(this.#facts);
  }

  /**
   * Every known profile's facts as a Sync V2 replica. The active profile comes
   * from memory (always at least as fresh as IndexedDB); the rest are read from
   * their own rows. Stage D2's transport publishes this.
   */
  async getFullReplica() {
    await this.whenFactsSettled();

    const replica = Facts.emptyReplica();
    for (const entry of this.#profiles) {
      if (entry.id === this.#profileId) {
        replica.profiles[entry.id] = this.#facts;
        continue;
      }
      try {
        const data = await loadProfileData(entry.id);
        if (data.facts) replica.profiles[entry.id] = data.facts;
      } catch (error) {
        console.warn(`[SYNC-V2] Could not read facts for profile "${entry.id}".`, error);
      }
    }
    return takeSnapshot(replica);
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
        await saveRegistry({ activeProfileId: active.id, profiles });
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
      await saveRegistry({ activeProfileId: this.#profileId, profiles: this.#profiles });
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
      await saveRegistry({ activeProfileId: this.#profileId, profiles: this.#profiles });
    } catch (error) {
      console.warn("Could not save the new profile.", error);
    }

    this.#emit();
    return { ...entry };
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
      await saveRegistry({ activeProfileId: profileId, profiles: this.#profiles });
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
  async deleteProfile(profileId) {
    await this.#ready;
    if (!profileId) return false;

    const index = this.#profiles.findIndex((candidate) => candidate.id === profileId);
    if (index === -1) return false;

    const wasActive = profileId === this.#profileId;
    this.#profiles.splice(index, 1);

    let nextActiveId = this.#profileId;
    if (wasActive) {
      let fallback = this.#profiles[0] || null;

      // Deleting the only remaining profile can't leave the registry
      // empty — the app always needs an active Gallery world to load into,
      // same as a genuinely fresh install (#resolveActiveProfile above).
      if (!fallback) {
        const now = Date.now();
        fallback = {
          id: generateProfileId(),
          name: DEFAULT_PROFILE_NAME,
          masterFolder: null,
          createdAt: now,
          updatedAt: now,
        };
        this.#profiles.push(fallback);
      }

      nextActiveId = fallback.id;
    }

    try {
      await saveRegistry({ activeProfileId: nextActiveId, profiles: this.#profiles });
    } catch (error) {
      console.warn("Could not save the profile registry after deletion.", error);
    }

    try {
      await deleteProfileData(profileId);
    } catch (error) {
      console.warn("Could not delete the profile's stored data.", error);
    }

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
      await saveRegistry({ activeProfileId: activeId, profiles });
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
      .then(() => {
        const profileId = targetProfileId || this.#profileId;
        if (!profileId) return;
        // Facts are only supplied for the profile still active; a save queued
        // before a profile switch passes undefined, which saveProfileData
        // treats as "preserve what is stored" rather than "erase".
        const facts = profileId === this.#profileId ? takeSnapshot(this.#facts) : undefined;
        return saveProfileData(profileId, { ...snapshot, facts });
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
      this.#facts = MergeEngine.mergeProfileFacts(this.#facts, storedFacts);
      this.#identity.observeReplica({ profiles: { [profileId]: this.#facts }, associations: {} });

      // Facts are authoritative for everything they describe, so any drift
      // between them and the stored records self-heals here on every load.
      if (this.#applyFactsToLocal(this.#facts)) this.#persist();
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
