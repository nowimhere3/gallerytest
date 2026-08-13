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

// Bumped from 1 -> 2 for Multi-Profile Foundation (Phase 8.1): exported
// profiles now also carry profileId/profileName/masterFolder. This is
// additive — importJSON below still only reads `items` and `tags`, so a
// schemaVersion-2 export remains fully readable by the same merge/replace
// logic as a schemaVersion-1 one, and a schemaVersion-1 file imports into
// today's app unchanged.
const SCHEMA_VERSION = 2;
const KIND = "gallery-profile";

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

  constructor() {
    // Loading is intentionally started by the store itself. Consumers keep
    // using the synchronous ProfileStore API; once saved records arrive, the
    // normal subscription mechanism refreshes any loaded media.
    this.#ready = this.#resolveActiveProfile();
    this.#loadSavedRecords();
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

    // Full isolation reset — nothing from the outgoing profile carries
    // over. Same fresh state a brand-new ProfileStore would start with.
    this.#recordsByPath = new Map();
    this.#tags = [];
    this.#changedBeforeLoad = new Set();
    this.#tagIdsChangedBeforeLoad = new Set();
    this.#replaceBeforeLoad = false;

    this.#profileId = target.id;
    this.#profileName = target.name || DEFAULT_PROFILE_NAME;
    this.#masterFolder = target.masterFolder || null;

    try {
      const { items, tags } = await loadProfileData(this.#profileId);

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
          items: this.#snapshotItems(),
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
    return results;
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
    // Forced to null (rather than compared against activeId) so the reset
    // below always runs even when activeId === the currently-active id —
    // the ACTIVE profile's own item/tag content may itself be what changed.
    this.#profileId = null;
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

  #snapshotItems() {
    const items = {};
    for (const [path, record] of this.#recordsByPath.entries()) {
      items[path] = { ...record };
    }
    return items;
  }

  #persist() {
    const snapshot = {
      items: this.#snapshotItems(),
      tags: this.#tags.map((tag) => ({ ...tag })),
    };

    // Captured NOW (synchronously, at the moment of the mutation that
    // triggered this save) rather than read lazily once the async chain
    // below finally runs. This matters once profiles can be switched
    // (Phase 8.2): if this.#profileId changes while this save is still
    // queued, a lazy read would misfile this snapshot under the NEW
    // profile's id instead of the one it actually belongs to.
    const targetProfileId = this.#profileId;

    // Serializing writes prevents an older save from finishing after a newer
    // favorite toggle and overwriting it in the database. Also waits on
    // #ready first: item/tag saves must always land under a resolved
    // profileId, never before it's known.
    this.#saveQueue = this.#saveQueue
      .catch(() => undefined)
      .then(() => this.#ready)
      .then(() => {
        const profileId = targetProfileId || this.#profileId;
        if (!profileId) return;
        return saveProfileData(profileId, snapshot);
      })
      .catch((error) => {
        // Persistence must never make the in-memory profile unusable.
        console.warn("Could not save gallery profile.", error);
      });
  }

  async #loadSavedRecords() {
    try {
      await this.#ready;
      if (!this.#profileId) return;

      const { items, tags } = await loadProfileData(this.#profileId);

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

      this.#emit();
      this.#persist();
    } catch (error) {
      // Browsers can disable private-mode storage. Favorites should still
      // work for the current session if persistence is unavailable.
      console.warn("Could not load gallery profile.", error);
    }
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
    this.#setRecord(relativePath, { ...existing, hidden: Boolean(value) });
    this.#changedBeforeLoad.add(relativePath);
    this.#emit();
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
    this.#persist();
    return true;
  }

  deleteTag(id) {
    const index = this.#tags.findIndex((t) => t.id === id);
    if (index === -1) return false;

    this.#tags.splice(index, 1);
    this.#tagIdsChangedBeforeLoad.add(id);

    // Un-assign the deleted tag from anything it was applied to (Phase
    // 6.2). Without this, every item that had it would carry a dangling id
    // forever — one that no longer resolves to a name anywhere, including
    // in exported JSON.
    for (const [path, record] of this.#recordsByPath.entries()) {
      if (!Array.isArray(record.tags) || !record.tags.includes(id)) continue;
      this.#setRecord(path, { ...record, tags: record.tags.filter((tagId) => tagId !== id) });
      this.#changedBeforeLoad.add(path);
    }

    this.#emit();
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

  getItemTags(relativePath) {
    const record = this.#getRecord(relativePath);
    return record && Array.isArray(record.tags) ? [...record.tags] : [];
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

  toJSON() {
    const items = {};
    for (const [path, record] of this.#recordsByPath.entries()) {
      items[path] = { ...record };
    }

    return {
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
    };
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

    this.#emit();
    this.#persist();
    return { applied, skipped, mode };
  }
}
