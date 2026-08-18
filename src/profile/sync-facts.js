// [PHASE-6-SYNC-V2]
// [STAGE-C-MERGE-SEMANTICS]
// [WHY: every synchronized fact must merge deterministically and survive
//  concurrent writers, and that is only possible if the state is MODELLED as
//  facts in the first place. Sync V1 stored curation as a document whose shape
//  made negative actions invisible: unfavorite deleted the record, untag
//  emptied an array, deleting a tag spliced it out — so "I un-favorited this"
//  and "I have never heard of this" had byte-identical representations, and no
//  merge could ever tell them apart. This module gives every synchronized
//  action, positive AND negative, an explicit stamped fact at the smallest
//  boundary that can independently change, so unrelated work never collides
//  and deletion can outrank a stale client that still remembers the old value.]
//
// WHAT: The Sync V2 fact model — replica shape, the pure mutation builders
// that produce new replicas, the projection that turns facts back into what
// the UI shows, and the shape guard that keeps session state out.
//
// This file is PURE: no DOM, no IndexedDB, no FSA, no time source of its own
// (every mutation takes a stamp from the caller's clock). It knows nothing
// about ProfileStore's storage shape — translating between the two is Stage D.
//
// FUTURE / DO-NOT-BREAK: Do not add a "remove this key" operation. Removing a
// key is exactly the representation that cannot survive merge, because the
// other client's copy of that key simply wins and the removal evaporates. Every
// removal is expressed as a fact whose VALUE says removed.

import { makeFact, mergeFact, isFact } from "./sync-merge.js";

export const REPLICA_SCHEMA_VERSION = 2;

// ---- Replica shape -------------------------------------------------------
//
// Replica {
//   schemaVersion: 2
//   profiles: { [profileId]: ProfileFacts }
//   associations: { [libraryId]: Fact<profileId | null> }
// }
//
// ProfileFacts { name: Fact<string>, deleted: Fact<boolean>,
//                items: { [relativePath]: ItemFacts },
//                tags:  { [tagId]: TagFacts } }
//
// ItemFacts { favorite: Fact<{ on: boolean, at: number|null }>,
//             hidden:   Fact<boolean>,
//             tags:     { [tagId]: Fact<boolean> } }
//
// TagFacts  { name: Fact<string>, deleted: Fact<boolean> }
//
// Fact<V>   { v: V, t: number, d: deviceId }

export function emptyReplica() {
  return { schemaVersion: REPLICA_SCHEMA_VERSION, profiles: {}, associations: {} };
}

function emptyProfileFacts() {
  return { items: {}, tags: {} };
}

function emptyItemFacts() {
  return { tags: {} };
}

// ---- Immutable update helpers -------------------------------------------
//
// Every builder returns a NEW replica and never mutates its input. Stage B's
// finding applies with full force here: a value that is fingerprinted, merged
// or published must not change underneath the code holding it. Structural
// sharing keeps that cheap — only the path being changed is copied.

function withProfile(replica, profileId, updater) {
  const current = replica.profiles[profileId] || emptyProfileFacts();
  return {
    ...replica,
    profiles: { ...replica.profiles, [profileId]: updater(current) },
  };
}

function withItem(profile, path, updater) {
  const current = profile.items[path] || emptyItemFacts();
  return { ...profile, items: { ...profile.items, [path]: updater(current) } };
}

function withTag(profile, tagId, updater) {
  const current = profile.tags[tagId] || {};
  return { ...profile, tags: { ...profile.tags, [tagId]: updater(current) } };
}

// [PHASE-6-SYNC-V2][STAGE-C-MERGE-SEMANTICS]
// [WHY: a mutation is applied through mergeFact against the fact already
//  present, not by overwriting it. That makes every builder idempotent and
//  safe to replay, and it means a stamp that is somehow older than what is
//  already stored simply loses — a local action can never roll state backwards
//  just because it happened locally. "Local" carries no privilege anywhere in
//  this model; only stamps decide.]
function put(existing, value, stamp) {
  return mergeFact(existing, makeFact(value, stamp));
}

// ---- Profile identity ----------------------------------------------------

export function setProfileName(replica, profileId, name, stamp) {
  return withProfile(replica, profileId, (p) => ({ ...p, name: put(p.name, String(name), stamp) }));
}

export function deleteProfile(replica, profileId, stamp) {
  return withProfile(replica, profileId, (p) => ({ ...p, deleted: put(p.deleted, true, stamp) }));
}

export function restoreProfile(replica, profileId, stamp) {
  return withProfile(replica, profileId, (p) => ({ ...p, deleted: put(p.deleted, false, stamp) }));
}

// ---- Item curation -------------------------------------------------------

/**
 * Favorite and un-favorite are the SAME fact with different values — which is
 * what lets an un-favorite propagate at all. `at` travels inside the value
 * because "favorited, and when" is one indivisible fact; splitting the
 * timestamp into its own fact would let a merge pair an un-favorite with a
 * stale favorited-at from the other side.
 */
export function setFavorite(replica, profileId, path, on, stamp, { at } = {}) {
  const value = { on: Boolean(on), at: on ? (Number.isFinite(at) ? at : stamp.t) : null };
  return withProfile(replica, profileId, (p) =>
    withItem(p, path, (item) => ({ ...item, favorite: put(item.favorite, value, stamp) }))
  );
}

export function setHidden(replica, profileId, path, hidden, stamp) {
  return withProfile(replica, profileId, (p) =>
    withItem(p, path, (item) => ({ ...item, hidden: put(item.hidden, Boolean(hidden), stamp) }))
  );
}

/**
 * One fact per (media, tag) pair. This is the boundary that makes "A tags X
 * while B tags Y" a non-event: they are different keys, so there is nothing to
 * resolve. Storing a tag LIST on the item instead would make every tagging
 * action collide with every other one on the same item.
 */
export function setItemTag(replica, profileId, path, tagId, assigned, stamp) {
  return withProfile(replica, profileId, (p) =>
    withItem(p, path, (item) => ({
      ...item,
      tags: { ...item.tags, [tagId]: put(item.tags[tagId], Boolean(assigned), stamp) },
    }))
  );
}

// ---- Tag vocabulary ------------------------------------------------------

/** Creating a tag asserts both facts about it: its name, and that it lives. */
export function createTag(replica, profileId, tagId, name, stamp) {
  return withProfile(replica, profileId, (p) =>
    withTag(p, tagId, (tag) => ({
      ...tag,
      name: put(tag.name, String(name), stamp),
      deleted: put(tag.deleted, false, stamp),
    }))
  );
}

export function renameTag(replica, profileId, tagId, name, stamp) {
  return withProfile(replica, profileId, (p) =>
    withTag(p, tagId, (tag) => ({ ...tag, name: put(tag.name, String(name), stamp) }))
  );
}

// [PHASE-6-SYNC-V2][STAGE-C-MERGE-SEMANTICS]
// [WHY: deletion touches ONLY the `deleted` fact and deliberately leaves
//  `name` alone. Because they are separate facts, a rename that is older than
//  the delete loses the name race but cannot resurrect the tag, and a rename
//  that is NEWER updates a name nobody sees without undeleting it — which is
//  section 13's required semantics falling out of the model rather than being
//  special-cased. Deletion also does NOT rewrite the tag's assignments: the
//  tombstone alone hides them at projection time, so deleting a tag costs one
//  fact instead of one per tagged item, and an Undo restores the previous
//  assignments for free.]
export function deleteTag(replica, profileId, tagId, stamp) {
  return withProfile(replica, profileId, (p) =>
    withTag(p, tagId, (tag) => ({ ...tag, deleted: put(tag.deleted, true, stamp) }))
  );
}

/** Undo. A new, newer mutation — never a weakening of what delete means. */
export function restoreTag(replica, profileId, tagId, stamp) {
  return withProfile(replica, profileId, (p) =>
    withTag(p, tagId, (tag) => ({ ...tag, deleted: put(tag.deleted, false, stamp) }))
  );
}

// ---- Library association -------------------------------------------------

// [PHASE-6-SYNC-V2][STAGE-C-MERGE-SEMANTICS]
// [WHY: the synchronized fact is libraryId -> associatedProfileId, and nothing
//  else. The physical folder — the FSA handle or the legacy folder signature —
//  is local device state and has no representation in this model at all, so it
//  cannot leak into a published replica by accident. This lives outside the
//  profiles map because it is a fact about the LIBRARY: moving Library A from
//  BEAST to BBG4 must not read as curation belonging to either Profile.
//  Minting a libraryId and matching a physical folder to one is Stage D/E; the
//  pure model only needs the fact to exist and to merge.]
export function setLibraryAssociation(replica, libraryId, profileId, stamp) {
  const value = profileId === null || profileId === undefined ? null : String(profileId);
  return {
    ...replica,
    associations: { ...replica.associations, [libraryId]: put(replica.associations[libraryId], value, stamp) },
  };
}

// ---- Projection ----------------------------------------------------------
//
// [PHASE-6-SYNC-V2][STAGE-C-MERGE-SEMANTICS]
// [WHY: tombstones are synchronization bookkeeping and must never reach the
//  user. Projection is the one place that distinction is enforced: deleted
//  profiles and deleted tags vanish here immediately, assignments to a deleted
//  tag stop being reported, and a fact whose value is false is simply absent
//  from the positive lists. Anything rendering Sync V2 state reads a
//  projection, never the facts.]

// [PHASE-6-SYNC-V2][STAGE-C-MERGE-SEMANTICS]
// [WHY: two devices independently creating a tag with the SAME display name
//  produce two distinct tag ids, and merge keeps both. That is deliberate and
//  approved: neither creation is wrong, and collapsing them would mean
//  rewriting one device's assignments onto the other's id purely because two
//  display strings matched — the merge layer guessing at user intent and
//  destroying information to do it. The merge algebra preserves information and
//  converges; it does not reconcile meaning.]
// FUTURE: duplicate display names are a PROJECTION/UI policy question, not a
// merge one. If the duplicate chips prove annoying in practice, resolve them at
// or above this projection boundary in Stage D/E — deterministically, from
// merged state alone, so every device computes the same answer. Do not push
// that policy down into sync-merge.js.

/** Profile ids that are not tombstoned, sorted for determinism. */
export function liveProfileIds(replica) {
  return Object.keys(replica.profiles)
    .filter((id) => !isTrue(replica.profiles[id].deleted))
    .sort();
}

export function isProfileDeleted(replica, profileId) {
  const profile = replica.profiles[profileId];
  return Boolean(profile && isTrue(profile.deleted));
}

/**
 * Turns one profile's facts into the shape a UI would render.
 * Returns null if the profile is unknown.
 */
export function projectProfile(replica, profileId) {
  const profile = replica.profiles[profileId];
  if (!profile) return null;

  const liveTagIds = new Set(
    Object.keys(profile.tags).filter((tagId) => !isTrue(profile.tags[tagId].deleted))
  );

  const tags = [...liveTagIds]
    .map((tagId) => ({ id: tagId, name: profile.tags[tagId].name ? profile.tags[tagId].name.v : "" }))
    .sort((a, b) => (a.name === b.name ? (a.id < b.id ? -1 : 1) : a.name < b.name ? -1 : 1));

  const favorites = [];
  const hidden = [];
  const itemTags = {};

  for (const path of Object.keys(profile.items).sort()) {
    const item = profile.items[path];

    if (item.favorite && item.favorite.v && item.favorite.v.on) {
      favorites.push({ path, at: item.favorite.v.at });
    }
    if (isTrue(item.hidden)) hidden.push(path);

    const assigned = Object.keys(item.tags || {})
      .filter((tagId) => liveTagIds.has(tagId) && isTrue(item.tags[tagId]))
      .sort();
    if (assigned.length) itemTags[path] = assigned;
  }

  // Newest favorite first, matching the Gallery's existing favourite ordering;
  // path breaks ties so the order is total rather than merely stable.
  favorites.sort((a, b) => (b.at || 0) - (a.at || 0) || (a.path < b.path ? -1 : 1));

  return {
    id: profileId,
    name: profile.name ? profile.name.v : null,
    deleted: isTrue(profile.deleted),
    favorites,
    hidden,
    tags,
    itemTags,
  };
}

/** libraryId -> profileId for every association that currently points somewhere. */
export function projectAssociations(replica) {
  const out = {};
  for (const libraryId of Object.keys(replica.associations).sort()) {
    const value = replica.associations[libraryId].v;
    if (value) out[libraryId] = value;
  }
  return out;
}

function isTrue(fact) {
  return Boolean(fact && fact.v === true);
}

// ---- Shape guard ---------------------------------------------------------

// [PHASE-6-SYNC-V2][STAGE-C-MERGE-SEMANTICS]
// [WHY: section 5 forbids Profile Sync from becoming session synchronization,
//  and the failure mode is silent — a field added to a Profile record for a
//  local convenience quietly starts travelling between machines. This guard is
//  an ALLOW-list of the keys the model defines, not a block-list of today's
//  known session fields, because a block-list only ever catches the leaks
//  somebody already thought of. Anything unrecognized is reported.]

const ALLOWED = {
  replica: new Set(["schemaVersion", "profiles", "associations"]),
  profile: new Set(["name", "deleted", "items", "tags"]),
  item: new Set(["favorite", "hidden", "tags"]),
  tag: new Set(["name", "deleted"]),
};

/**
 * Fields that are explicitly session/local-only and must never appear in a
 * replica. Documentation for humans — the guard below does not consult it,
 * since the allow-list already excludes them and everything like them.
 *
 * tagActivity / lastTagPosition / totalAtTime / lastTaggedAt / lastTagShuffle
 * are per-tag PLAYBACK RESUME POSITIONS ("where was I in this tag, in this
 * shuffle mode"). They are position-in-a-collection values whose meaning
 * depends on how many items the local device has actually loaded, so they are
 * not even well-defined on another machine with a different library. Approved
 * as local-only.
 */
export const SESSION_ONLY_FIELDS = Object.freeze([
  "tagActivity",
  "lastTagPosition",
  "totalAtTime",
  "lastTaggedAt",
  "lastTagShuffle",
  "handle",
  "currentItem",
  "playbackPosition",
  "shuffleHistory",
  "navigationHistory",
]);

/**
 * Returns a list of paths in `replica` that are not part of the fact model.
 * Empty means the replica is exactly the approved shape — no session state, no
 * stray fields, and every fact well-formed.
 */
export function findSessionStateLeaks(replica) {
  const leaks = [];

  const checkFact = (fact, path) => {
    if (!isFact(fact)) {
      leaks.push(`${path} (not a well-formed fact)`);
      return;
    }
    for (const key of Object.keys(fact)) {
      if (key !== "v" && key !== "t" && key !== "d") leaks.push(`${path}.${key}`);
    }
  };

  if (!replica || typeof replica !== "object") return ["(replica is not an object)"];

  for (const key of Object.keys(replica)) {
    if (!ALLOWED.replica.has(key)) leaks.push(key);
  }

  for (const [libraryId, fact] of Object.entries(replica.associations || {})) {
    checkFact(fact, `associations[${libraryId}]`);
  }

  for (const [profileId, profile] of Object.entries(replica.profiles || {})) {
    const base = `profiles[${profileId}]`;
    if (!profile || typeof profile !== "object") {
      leaks.push(`${base} (not an object)`);
      continue;
    }
    for (const key of Object.keys(profile)) {
      if (!ALLOWED.profile.has(key)) leaks.push(`${base}.${key}`);
    }
    if (profile.name !== undefined) checkFact(profile.name, `${base}.name`);
    if (profile.deleted !== undefined) checkFact(profile.deleted, `${base}.deleted`);

    for (const [path, item] of Object.entries(profile.items || {})) {
      const itemBase = `${base}.items[${path}]`;
      if (!item || typeof item !== "object") {
        leaks.push(`${itemBase} (not an object)`);
        continue;
      }
      for (const key of Object.keys(item)) {
        if (!ALLOWED.item.has(key)) leaks.push(`${itemBase}.${key}`);
      }
      if (item.favorite !== undefined) checkFact(item.favorite, `${itemBase}.favorite`);
      if (item.hidden !== undefined) checkFact(item.hidden, `${itemBase}.hidden`);
      for (const [tagId, assignment] of Object.entries(item.tags || {})) {
        checkFact(assignment, `${itemBase}.tags[${tagId}]`);
      }
    }

    for (const [tagId, tag] of Object.entries(profile.tags || {})) {
      const tagBase = `${base}.tags[${tagId}]`;
      if (!tag || typeof tag !== "object") {
        leaks.push(`${tagBase} (not an object)`);
        continue;
      }
      for (const key of Object.keys(tag)) {
        if (!ALLOWED.tag.has(key)) leaks.push(`${tagBase}.${key}`);
      }
      if (tag.name !== undefined) checkFact(tag.name, `${tagBase}.name`);
      if (tag.deleted !== undefined) checkFact(tag.deleted, `${tagBase}.deleted`);
    }
  }

  return leaks;
}
