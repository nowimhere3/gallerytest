// [MEDIA-ID / STAGE-02 / LOCAL-PROJECTION]
//
// The read facade every UI surface goes through. Reads are projected across
// deterministic T0/T1 aliases; writes are pass-throughs to ProfileStore against
// the path the user is currently viewing.
//
// ---- Why a facade rather than a ProfileStore change ----------------------
//
// [WHY: two DIFFERENT read styles exist in main.js and both have to agree or the
//  heart button and the grid will disagree with each other. Some code stamps
//  item.isFavorite/isHidden/userTags onto the MediaItem (finishLoadingItems, the
//  profile subscription, MediaRuntime#stampProfileFields); other code reads
//  ProfileStore live at render time (syncFavoriteButtons, the tag panel). One
//  seam in front of both is the only way to keep them consistent.
//
//  MediaRuntime uses exactly subscribe/isFavorite/isHidden/toggleFavorite/
//  toggleHidden, so this object satisfies it verbatim and media-runtime.js needs
//  no edit at all. ProfileStore keeps its single additive read-only seam and
//  nothing else.]
//
// ---- Why writes are never redirected -------------------------------------
//
// [WHY: a write goes to the path being viewed, full stop. ProfileStore stamps it
//  with HybridClock#tick(), which is strictly greater than every stamp the clock
//  has issued or observed — so the user's action wins the projection on every
//  alias immediately and stays winning after sync, without anything being
//  rewritten. Redirecting to a "canonical" alias would require choosing one of
//  two proven-equivalent roots as the real one (a decision with no correct
//  answer), would write into a namespace the user is not looking at, and would
//  destroy the property that deleting the MEDIA-ID database restores today's
//  behaviour exactly.]

import {
  resolveFavorite,
  resolveHidden,
  resolveTags,
} from "./media-identity-projection.js";

/**
 * Creates the projection view over a ProfileStore.
 *
 * `profile` is the real ProfileStore. Nothing here writes to it except through
 * its existing public mutators.
 */
export function createProfileProjectionView({ profile }) {
  const listeners = new Set();

  let aliasIndex = null;
  // Bumped on every load and on every active-Profile change. Every overlay
  // entry records the epoch it was written under and is ignored — then dropped
  // — once that epoch is stale.
  let epoch = 0;
  // Strictly increasing across the whole session. See clearPending.
  let generation = 0;

  // path -> { epoch, favorite?: {on, gen}, hidden?: {value, gen}, tags?: Map }
  const pending = new Map();

  // One getItemFactsForPaths() call per ProfileStore emit, taken lazily and
  // only if a projected read actually happens.
  let factsCache = null;
  let lastProfileId = profile.getProfileId ? profile.getProfileId() : null;

  function emit() {
    for (const listener of listeners) listener();
  }

  function invalidateFacts() {
    factsCache = null;
  }

  // ---- Facts --------------------------------------------------------------

  function factsForAliases() {
    if (factsCache) return factsCache;
    if (!aliasIndex || !aliasIndex.aliases.size) {
      factsCache = {};
      return factsCache;
    }
    const keys = new Set();
    for (const aliases of aliasIndex.aliases.values()) {
      for (const key of aliases) keys.add(key);
    }
    factsCache =
      typeof profile.getItemFactsForPaths === "function" ? profile.getItemFactsForPaths([...keys]) : {};
    return factsCache;
  }

  /**
   * The alias list for a viewed path, or null when this path has no projection
   * and every read is a plain delegation.
   *
   * [WHY: the profileId guard is STRUCTURAL Profile isolation, not a convention.
   *  One media scope can contain roots associated with different Profiles, so an
   *  index built while Profile P was active must never answer a read taken while
   *  Profile Q is active. The index carries the id it was built for and is
   *  discarded the moment they disagree — so a leak requires deleting this
   *  check, which is what the sabotage test does.]
   */
  function aliasesFor(relativePath) {
    if (!aliasIndex) return null;
    const activeProfileId = profile.getProfileId ? profile.getProfileId() : null;
    if (aliasIndex.profileId !== activeProfileId) return null;
    return aliasIndex.aliases.get(relativePath) || null;
  }

  // ---- Pending-write overlay ---------------------------------------------
  //
  // [WHY THE OVERLAY EXISTS AT ALL: ProfileStore#setFavorite updates the local
  //  record, then calls #emit() SYNCHRONOUSLY, and only then queues #recordFact
  //  — which applies the mutation to the stamped facts in a later microtask and
  //  does NOT emit when it lands. So a projection that resolved purely from
  //  stamped facts would render the pre-click value during that emit and keep
  //  rendering it until some unrelated change happened to emit again. Not a
  //  one-frame flicker: an indefinitely stuck value, on the user's own click.
  //
  //  The overlay is not a second source of truth. It anticipates a fact that is
  //  already committed to be minted, and it is discarded the instant that fact
  //  exists. It is written by exactly the three write methods below, which is
  //  why a peer's change arriving through refreshFromStorage can never be
  //  mistaken for a local pending write — nothing else can create an entry.]

  function pendingFor(path) {
    const entry = pending.get(path);
    if (!entry) return null;
    if (entry.epoch !== epoch) {
      pending.delete(path);
      return null;
    }
    return entry;
  }

  function putPending(path, apply) {
    let entry = pending.get(path);
    if (!entry || entry.epoch !== epoch) {
      entry = { epoch };
      pending.set(path, entry);
    }
    apply(entry);
    return entry;
  }

  /**
   * [WHY THE GENERATION GUARD: the settle callback for toggle #1 can land after
   *  toggle #2 has already replaced the override. Clearing unconditionally would
   *  erase the NEWER pending value and snap the UI back to a fact that is about
   *  to be superseded. Each override carries the generation that wrote it and is
   *  cleared only by its own callback.]
   */
  function clearPending(path, field, gen, writtenEpoch, tagId = null) {
    if (writtenEpoch !== epoch) return false;
    const entry = pending.get(path);
    if (!entry || entry.epoch !== epoch) return false;

    if (field === "tags") {
      if (!entry.tags) return false;
      const held = entry.tags.get(tagId);
      if (!held || held.gen !== gen) return false;
      entry.tags.delete(tagId);
      if (!entry.tags.size) delete entry.tags;
    } else {
      const held = entry[field];
      if (!held || held.gen !== gen) return false;
      delete entry[field];
    }

    if (!entry.favorite && !entry.hidden && !entry.tags) pending.delete(path);
    return true;
  }

  // ---- Projected reads ----------------------------------------------------

  function projectedFavorite(relativePath) {
    const aliases = aliasesFor(relativePath);
    if (!aliases) {
      return { on: profile.isFavorite(relativePath), at: profile.getFavoritedAt(relativePath) };
    }

    const held = pendingFor(relativePath);
    if (held && held.favorite) {
      // [WHY: the override carries `on` and NOTHING ELSE. ProfileStore has
      //  already written record.favoritedAt with its own Date.now() before the
      //  emit that is running right now, so the exact value is readable here.
      //  Minting a provisional timestamp would put a different instant on the
      //  first render than the one the fact will carry — splitting an
      //  indivisible {on, at} fact across two clocks — and would then need a
      //  second corrective render to repair it.]
      return held.favorite.on
        ? { on: true, at: profile.getFavoritedAt(relativePath) }
        : { on: false, at: null };
    }

    const resolved = resolveFavorite(aliases, factsForAliases());
    return { on: resolved.on, at: resolved.at };
  }

  function projectedHidden(relativePath) {
    const aliases = aliasesFor(relativePath);
    if (!aliases) return profile.isHidden(relativePath);

    const held = pendingFor(relativePath);
    if (held && held.hidden) return held.hidden.value;

    return resolveHidden(aliases, factsForAliases()).hidden;
  }

  function projectedTags(relativePath) {
    const aliases = aliasesFor(relativePath);
    if (!aliases) return profile.getItemTags(relativePath);

    const liveTagIds = new Set((profile.getTags() || []).map((tag) => tag.id));
    const assigned = new Set(resolveTags(aliases, factsForAliases(), liveTagIds));

    const held = pendingFor(relativePath);
    if (held && held.tags) {
      for (const [tagId, override] of held.tags) {
        if (!liveTagIds.has(tagId)) continue;
        if (override.value) assigned.add(tagId);
        else assigned.delete(tagId);
      }
    }
    return [...assigned].sort();
  }

  function projectionFingerprint(relativePath) {
    const favorite = projectedFavorite(relativePath);
    return `${favorite.on}|${favorite.at}|${projectedHidden(relativePath)}|${projectedTags(relativePath).join(",")}`;
  }

  /**
   * Clears one override and emits only if the visible answer actually moved.
   *
   * [WHY: in the ordinary case the override and the settled fact agree exactly,
   *  so clearing changes nothing a user could see. Emitting anyway would cost a
   *  second full re-render on every single click.]
   */
  function settle(path, field, gen, writtenEpoch, tagId = null) {
    const before = pending.has(path) ? projectionFingerprint(path) : null;
    if (!clearPending(path, field, gen, writtenEpoch, tagId)) return;
    invalidateFacts();
    if (before !== null && projectionFingerprint(path) !== before) emit();
  }

  // ---- Writes -------------------------------------------------------------
  //
  // The override is installed BEFORE delegating, because ProfileStore emits
  // synchronously from inside the mutator. Installing it afterwards would let
  // that emit render the stale projected value.

  function setFavorite(relativePath, value) {
    if (!relativePath) return;
    const gen = ++generation;
    const writtenEpoch = epoch;
    const next = Boolean(value);
    putPending(relativePath, (entry) => {
      entry.favorite = { on: next, gen };
    });
    profile.setFavorite(relativePath, next);
    profile.whenFactsSettled().then(
      () => settle(relativePath, "favorite", gen, writtenEpoch),
      () => settle(relativePath, "favorite", gen, writtenEpoch)
    );
  }

  function setHidden(relativePath, value) {
    if (!relativePath) return;
    const gen = ++generation;
    const writtenEpoch = epoch;
    const next = Boolean(value);
    putPending(relativePath, (entry) => {
      entry.hidden = { value: next, gen };
    });
    profile.setHidden(relativePath, next);
    profile.whenFactsSettled().then(
      () => settle(relativePath, "hidden", gen, writtenEpoch),
      () => settle(relativePath, "hidden", gen, writtenEpoch)
    );
  }

  /**
   * [WHY THE PRIMING WRITE: ProfileStore#setItemTag opens with
   *
   *      if (currentTags.includes(tagId) === nextValue) return;  // no-op
   *
   *  which compares the requested value against THIS PATH's flattened local
   *  record. That is correct when the record is the whole truth, and it silently
   *  swallows the write when it is not. Removing a tag that reached this item
   *  through a proven alias is exactly that case: the user sees the chip, clicks
   *  it off, the viewed path's record never had the tag, and the guard drops the
   *  mutation — no fact, no emit, the chip comes straight back. The mirror case
   *  (turning ON a tag whose alias holds a newer `false`) fails the same way.
   *
   *  So when the delegation would be a no-op, the opposite value is asserted
   *  first. Both writes are issued synchronously, back to back, so both are
   *  queued onto #factQueue before anything can await — and every publish path
   *  drains that queue first, so the intermediate fact can never be published on
   *  its own. It is also not a lie: it asserts the value the projection was
   *  already showing, an instant before superseding it. The net result is one
   *  stamped fact on the viewed path carrying the user's actual intent, which is
   *  what the projection needs to outrank the alias.
   *
   *  Doing this in the facade rather than relaxing that guard keeps
   *  profile-store.js to its one approved read-only seam.]
   */
  function setItemTag(relativePath, tagId, value) {
    if (!relativePath || !tagId) return;
    const gen = ++generation;
    const writtenEpoch = epoch;
    const next = Boolean(value);
    putPending(relativePath, (entry) => {
      if (!entry.tags) entry.tags = new Map();
      entry.tags.set(tagId, { value: next, gen });
    });
    if (profile.hasItemTag(relativePath, tagId) === next) profile.setItemTag(relativePath, tagId, !next);
    profile.setItemTag(relativePath, tagId, next);
    profile.whenFactsSettled().then(
      () => settle(relativePath, "tags", gen, writtenEpoch, tagId),
      () => settle(relativePath, "tags", gen, writtenEpoch, tagId)
    );
  }

  // ---- ProfileStore subscription -----------------------------------------

  const unsubscribe = profile.subscribe(() => {
    invalidateFacts();
    const activeProfileId = profile.getProfileId ? profile.getProfileId() : null;
    if (activeProfileId !== lastProfileId) {
      lastProfileId = activeProfileId;
      // A Profile switch invalidates both the index and every override. The
      // overrides were display anticipation only — ProfileStore#switchProfile
      // already drains pending writes, so nothing durable is lost.
      beginEpoch();
      aliasIndex = null;
    }
    emit();
  });

  function beginEpoch() {
    epoch += 1;
    pending.clear();
    invalidateFacts();
  }

  return {
    // ---- MediaRuntime interface (media-runtime.js is unmodified) ----------
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    isFavorite(relativePath) {
      return projectedFavorite(relativePath).on;
    },
    getFavoritedAt(relativePath) {
      return projectedFavorite(relativePath).at;
    },
    isHidden(relativePath) {
      return projectedHidden(relativePath);
    },
    getItemTags(relativePath) {
      return projectedTags(relativePath);
    },
    hasItemTag(relativePath, tagId) {
      return projectedTags(relativePath).includes(tagId);
    },

    setFavorite,
    setHidden,
    setItemTag,

    // [WHY: toggles read the PROJECTED value, not ProfileStore's. A heart that
    //  is filled because a proven alias holds the Favorite must un-fill when
    //  clicked; computing `next` from the raw per-path record would compute
    //  !false === true and re-favourite what already looks favourited.]
    toggleFavorite(relativePath) {
      setFavorite(relativePath, !projectedFavorite(relativePath).on);
    },
    toggleHidden(relativePath) {
      setHidden(relativePath, !projectedHidden(relativePath));
    },
    toggleItemTag(relativePath, tagId) {
      setItemTag(relativePath, tagId, !projectedTags(relativePath).includes(tagId));
    },

    // ---- Stage 02 control surface ----------------------------------------

    /** Starts a new load / Profile epoch. Drops every override. */
    beginEpoch,

    /** Installs (or clears) this load's alias index and notifies the UI. */
    setAliasIndex(index) {
      aliasIndex = index || null;
      invalidateFacts();
      emit();
    },

    getAliasIndex() {
      return aliasIndex;
    },

    /** Diagnostics only. */
    stats() {
      return {
        epoch,
        generation,
        pendingPaths: pending.size,
        aliasedItems: aliasIndex ? aliasIndex.aliases.size : 0,
        profileId: aliasIndex ? aliasIndex.profileId : null,
      };
    },

    emit,

    dispose() {
      unsubscribe();
      listeners.clear();
      pending.clear();
      aliasIndex = null;
    },
  };
}
