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

import { loadProfile, saveProfile } from "./indexeddb.js";

const SCHEMA_VERSION = 1;
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

  constructor() {
    // Loading is intentionally started by the store itself. Consumers keep
    // using the synchronous ProfileStore API; once saved records arrive, the
    // normal subscription mechanism refreshes any loaded media.
    this.#loadSavedRecords();
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

    // Serializing writes prevents an older save from finishing after a newer
    // favorite toggle and overwriting it in the database.
    this.#saveQueue = this.#saveQueue
      .catch(() => undefined)
      .then(() => saveProfile(snapshot))
      .catch((error) => {
        // Persistence must never make the in-memory profile unusable.
        console.warn("Could not save gallery profile.", error);
      });
  }

  async #loadSavedRecords() {
    try {
      const { items, tags } = await loadProfile();

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

  recordTagActivity(tagId, { position, total, timestamp = Date.now() } = {}) {
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

    tag.lastTagPosition = normalizedPosition;
    tag.totalAtTime = normalizedTotal;
    tag.lastTaggedAt = normalizedTimestamp;
    this.#tagIdsChangedBeforeLoad.add(tagId);
    this.#emit();
    this.#persist();
    return true;
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
