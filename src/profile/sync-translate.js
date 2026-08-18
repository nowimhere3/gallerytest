// [PHASE-6-SYNC-V2]
// [STAGE-D1-LOCAL-FOUNDATION]
// [WHY: ProfileStore's storage shape and the Sync V2 fact model describe the
//  same curation in two different languages, and the translation between them
//  is the only place local-only data can leak into a replica or be destroyed by
//  one. Both directions are therefore written here, together, so the fields
//  each direction is allowed to touch are visible in one file: seeding reads
//  ONLY the synchronized fields, and applying writes ONLY the synchronized
//  fields — which is what leaves tagActivity, favoritedAt bookkeeping, and any
//  field a future version or an imported profile happens to carry completely
//  untouched.]
//
// WHAT: seedFactsFromProfileData() — builds a first fact replica slice from
// existing local state; projectFactsOntoProfileData() — computes the per-field
// changes needed to bring local state in line with a set of facts.
//
// This file is PURE: it takes plain data and returns plain data. It never
// touches IndexedDB, the DOM, or a clock — every stamp is supplied by the
// caller, so translation is fully reproducible in tests.

import * as Facts from "./sync-facts.js";

/**
 * The logical time used for facts derived from pre-Sync-V2 local state.
 *
 * [PHASE-6-SYNC-V2][STAGE-D1-LOCAL-FOUNDATION]
 * [WHY: seeded facts must lose to every genuine mutation, on every device,
 *  forever. Real stamps are wall-clock-scale (~1.7e12), so a floor of 2 is
 *  beaten by any real action by twelve orders of magnitude — there is no
 *  arithmetic edge where a seed could outrank a real edit. 2 rather than 1
 *  leaves room beneath it for the V1 REMOTE seed in Stage D2, which must lose
 *  to local when the two disagree: pre-V2 data carries no ordering at all, so
 *  that conflict has no correct answer and the tie is resolved deterministically
 *  in favor of the copy this installation has actually been using.]
 */
export const LOCAL_SEED_T = 2;

export function localSeedStamp(deviceId) {
  return { t: LOCAL_SEED_T, d: `seed:${deviceId}` };
}

/**
 * [PHASE-6-SYNC-V2]
 * [STAGE-D2-TRANSPORT]
 * [WHY: V1 has no stamps at all — it is pre-ordering data recovered by reading
 *  its files directly (see sync-v2-migration.js), not a peer with real history.
 *  Seeding it BELOW LOCAL_SEED_T is what makes "local seed outranks V1 where
 *  the same fact disagrees" true by construction: any local fact, even one this
 *  installation only ever seeded from its own pre-V2 state, already carries a
 *  higher stamp and wins the merge outright. V1 can only ever contribute a fact
 *  that has no local counterpart at all — pure recovery, never regression.]
 */
export const V1_SEED_T = 1;

export function v1SeedStamp(deviceId) {
  return { t: V1_SEED_T, d: `v1-seed:${deviceId}` };
}

/**
 * Builds a fact replica from one profile's existing ProfileStore data.
 *
 * Only POSITIVE state is seeded. A record that does not exist, or a field that
 * is false, produces no fact at all — because in V1 those two situations are
 * byte-identical, so asserting "this was explicitly un-favorited" from them
 * would be inventing information. Absence stays absence, which is safe: the
 * first real mutation on any device creates the fact properly.
 */
export function seedFactsFromProfileData({ profileId, name, items, tags }, stamp) {
  let replica = Facts.emptyReplica();

  if (typeof name === "string" && name) {
    replica = Facts.setProfileName(replica, profileId, name, stamp);
  }

  for (const tag of tags || []) {
    if (!tag || typeof tag.id !== "string" || !tag.id) continue;
    replica = Facts.createTag(replica, profileId, tag.id, typeof tag.name === "string" ? tag.name : "", stamp);
  }

  for (const [path, record] of Object.entries(items || {})) {
    if (typeof path !== "string" || !path || !record || typeof record !== "object") continue;

    if (record.favorite) {
      const at = Number.isFinite(record.favoritedAt) ? record.favoritedAt : null;
      replica = Facts.setFavorite(replica, profileId, path, true, stamp, { at });
    }
    if (record.hidden) {
      replica = Facts.setHidden(replica, profileId, path, true, stamp);
    }
    for (const tagId of Array.isArray(record.tags) ? record.tags : []) {
      if (typeof tagId !== "string" || !tagId) continue;
      replica = Facts.setItemTag(replica, profileId, path, tagId, true, stamp);
    }
  }

  return replica.profiles[profileId] || { items: {}, tags: {} };
}

/**
 * Computes the changes needed to bring one profile's ProfileStore data in line
 * with its facts. Returns a plain description; applying it is ProfileStore's
 * job, because only ProfileStore may touch its own Maps.
 *
 * [PHASE-6-SYNC-V2][STAGE-D1-LOCAL-FOUNDATION]
 * [WHY: this returns a DIFF, not a replacement. Sync V1 adopted remote state by
 *  calling replaceAllProfiles(), which overwrote every record wholesale and
 *  took every local-only field on those records with it. Emitting only the
 *  fields that actually differ means an untouched item is genuinely untouched —
 *  its tagActivity, its unknown imported fields, its identity all survive
 *  because nothing rewrites them.]
 *
 * Shape:
 *   {
 *     profileName: string | null,        // null when unchanged
 *     items: [{ path, favorite?, favoritedAt?, hidden?, addTags[], removeTags[] }],
 *     tags:  { add: [{id, name}], rename: [{id, name}], remove: [id] },
 *   }
 */
export function diffFactsAgainstProfileData(facts, { name, items, tags }) {
  const changes = { profileName: null, items: [], tags: { add: [], rename: [], remove: [] } };
  if (!facts) return changes;

  // ---- profile identity ----
  if (facts.name && typeof facts.name.v === "string" && facts.name.v !== name) {
    changes.profileName = facts.name.v;
  }

  // ---- tag vocabulary ----
  const localTagsById = new Map((tags || []).map((tag) => [tag.id, tag]));
  const liveTagIds = new Set();

  for (const [tagId, tagFacts] of Object.entries(facts.tags || {})) {
    const deleted = Boolean(tagFacts.deleted && tagFacts.deleted.v === true);
    const factName = tagFacts.name && typeof tagFacts.name.v === "string" ? tagFacts.name.v : "";
    const local = localTagsById.get(tagId);

    if (deleted) {
      if (local) changes.tags.remove.push(tagId);
      continue;
    }
    liveTagIds.add(tagId);

    if (!local) changes.tags.add.push({ id: tagId, name: factName });
    else if (local.name !== factName) changes.tags.rename.push({ id: tagId, name: factName });
  }

  // ---- per-item curation ----
  const localItems = items || {};
  for (const [path, itemFacts] of Object.entries(facts.items || {})) {
    const record = localItems[path] || {};
    const change = { path, addTags: [], removeTags: [] };
    let touched = false;

    if (itemFacts.favorite && itemFacts.favorite.v && typeof itemFacts.favorite.v === "object") {
      const on = Boolean(itemFacts.favorite.v.on);
      const at = Number.isFinite(itemFacts.favorite.v.at) ? itemFacts.favorite.v.at : null;
      if (Boolean(record.favorite) !== on) {
        change.favorite = on;
        change.favoritedAt = at;
        touched = true;
      } else if (on && at !== null && at > LOCAL_SEED_T && record.favoritedAt !== at) {
        // Same state, different ordering timestamp — a merge can legitimately
        // hand us a different favoritedAt for an already-favorited item.
        //
        // [PHASE-6-SYNC-V2][STAGE-D1-LOCAL-FOUNDATION]
        // [WHY: `at > LOCAL_SEED_T` excludes a timestamp that was never real.
        //  Seeding an old profile whose favourite predates favoritedAt entirely
        //  has no time to record, and setFavorite defaults a missing `at` to the
        //  stamp's own logical time — which for a seed is the floor, not a wall
        //  clock. Without this guard that floor would be written back onto the
        //  record as a favoritedAt of 2ms-past-epoch: fabricated data, presented
        //  to the user as the moment they favourited the item. A real mutation's
        //  stamp is wall-clock-scale, so nothing genuine is ever excluded here.]
        change.favorite = true;
        change.favoritedAt = at;
        touched = true;
      }
    }

    if (itemFacts.hidden && typeof itemFacts.hidden.v === "boolean") {
      if (Boolean(record.hidden) !== itemFacts.hidden.v) {
        change.hidden = itemFacts.hidden.v;
        touched = true;
      }
    }

    // Assignments to a tombstoned tag are deliberately NOT removed from the
    // record — Stage C keeps them underneath so an Undo restores them. They are
    // simply invisible while the tag is deleted, since nothing can resolve the
    // id to a name.
    const recordTags = new Set(Array.isArray(record.tags) ? record.tags : []);
    for (const [tagId, assignment] of Object.entries(itemFacts.tags || {})) {
      if (!liveTagIds.has(tagId)) continue;
      const assigned = assignment && assignment.v === true;
      if (assigned && !recordTags.has(tagId)) {
        change.addTags.push(tagId);
        touched = true;
      } else if (!assigned && recordTags.has(tagId)) {
        change.removeTags.push(tagId);
        touched = true;
      }
    }

    if (touched) changes.items.push(change);
  }

  return changes;
}

// A record with only default/falsy values carries no information worth
// keeping. Mirrors profile-store.js's private isEmptyRecord — duplicated
// rather than imported because this file is deliberately dependency-free
// (see the module header): a pure function belongs where its inputs/outputs
// are plain data, not reaching into ProfileStore's private helpers.
function isEmptyProfileRecord(record) {
  return Object.values(record).every((value) => {
    if (typeof value === "boolean") return value === false;
    if (value === null || value === undefined) return true;
    if (Array.isArray(value)) return value.length === 0;
    return false;
  });
}

/**
 * Applies a diffFactsAgainstProfileData()-shaped diff to plain items/tags data,
 * returning NEW plain objects — never mutates its input.
 *
 * [PHASE-6-SYNC-V2]
 * [STAGE-D2-TRANSPORT]
 * [WHY: ProfileStore#applyFactsToLocal already does this for the ACTIVE
 *  profile, applying directly to `this.#recordsByPath`/`this.#tags` because it
 *  IS that profile's live state. Adopting a merged sync pass touches every
 *  profile a device knows about, most of which are NOT the active one and have
 *  no live in-memory state to mutate — this is that same field-by-field
 *  application, written as a pure function so it can run against a profile
 *  that is simply data read from IndexedDB.]
 */
export function applyProfileDiff(diff, { items, tags }) {
  let nextItems = { ...(items || {}) };
  let nextTags = (tags || []).map((tag) => ({ ...tag }));

  for (const tag of diff.tags.add) nextTags.push({ id: tag.id, name: tag.name });
  for (const tag of diff.tags.rename) {
    nextTags = nextTags.map((t) => (t.id === tag.id ? { ...t, name: tag.name } : t));
  }
  for (const tagId of diff.tags.remove) nextTags = nextTags.filter((t) => t.id !== tagId);

  for (const item of diff.items) {
    const existing = nextItems[item.path] || {};
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

    if (isEmptyProfileRecord(record)) delete nextItems[item.path];
    else nextItems[item.path] = record;
  }

  return { items: nextItems, tags: nextTags };
}

/**
 * Diffs two RAW local profile-data snapshots (not facts) and describes exactly
 * which SYNCHRONIZED fields changed between them.
 *
 * [PHASE-6-SYNC-V2]
 * [STAGE-D1-LOCAL-FOUNDATION]
 * [WHY: ProfileStore#importJSON uses this to record facts. An import (merge OR
 *  replace) determines the resulting local state through its EXISTING,
 *  already-approved semantics first; this then stamps only what actually
 *  differs. That is what makes "a field the import didn't mention" and "a field
 *  explicitly imported as unchanged" both correctly produce no fact — merge
 *  mode's field-level merge only ever touches a path/field that appears in the
 *  incoming record, so `after` is byte-identical to `before` everywhere the
 *  import had no opinion, and the diff below naturally reports nothing there.
 *  Replace mode wipes local state first, so anything present in `before` but
 *  absent from `after` reads as an explicit removal — exactly the negative
 *  facts required (favorite/hidden -> false, an assignment -> unset, a missing
 *  tag -> tombstoned) — with no special-casing needed for either mode.]
 *
 * Returns { items: [{path, favorite?, favoritedAt?, hidden?, addTags[], removeTags[]}],
 *           tags: { add: [{id,name}], rename: [{id,name}], remove: [id] } }.
 */
export function diffLocalStates(before, after) {
  const changes = { items: [], tags: { add: [], rename: [], remove: [] } };

  const beforeTagsById = new Map((before.tags || []).map((tag) => [tag.id, tag]));
  const afterTagsById = new Map((after.tags || []).map((tag) => [tag.id, tag]));

  for (const [tagId, tag] of afterTagsById) {
    const prior = beforeTagsById.get(tagId);
    if (!prior) changes.tags.add.push({ id: tagId, name: tag.name });
    else if (prior.name !== tag.name) changes.tags.rename.push({ id: tagId, name: tag.name });
  }
  // A tag present before and absent after can only happen in replace mode —
  // merge mode's tag handling only ever adds or updates, never removes.
  for (const tagId of beforeTagsById.keys()) {
    if (!afterTagsById.has(tagId)) changes.tags.remove.push(tagId);
  }

  const paths = new Set([...Object.keys(before.items || {}), ...Object.keys(after.items || {})]);
  for (const path of paths) {
    const priorRecord = (before.items || {})[path] || {};
    // A path present before but pruned from `after` entirely (isEmptyRecord
    // dropped it, or replace mode never re-added it) means everything on it was
    // explicitly removed — treating it as {} here produces exactly that.
    const nextRecord = (after.items || {})[path] || {};
    const change = { path, addTags: [], removeTags: [] };
    let touched = false;

    const wasFavorite = Boolean(priorRecord.favorite);
    const isFavorite = Boolean(nextRecord.favorite);
    if (wasFavorite !== isFavorite) {
      change.favorite = isFavorite;
      change.favoritedAt = isFavorite && Number.isFinite(nextRecord.favoritedAt) ? nextRecord.favoritedAt : null;
      touched = true;
    }

    const wasHidden = Boolean(priorRecord.hidden);
    const isHidden = Boolean(nextRecord.hidden);
    if (wasHidden !== isHidden) {
      change.hidden = isHidden;
      touched = true;
    }

    const priorTags = new Set(Array.isArray(priorRecord.tags) ? priorRecord.tags : []);
    const nextTags = new Set(Array.isArray(nextRecord.tags) ? nextRecord.tags : []);
    for (const tagId of nextTags) {
      if (!priorTags.has(tagId)) {
        change.addTags.push(tagId);
        touched = true;
      }
    }
    for (const tagId of priorTags) {
      if (!nextTags.has(tagId)) {
        change.removeTags.push(tagId);
        touched = true;
      }
    }

    if (touched) changes.items.push(change);
  }

  return changes;
}

/**
 * Diagnostic: lists every way a profile's facts and its local records disagree.
 *
 * [PHASE-6-SYNC-V2][STAGE-D1-LOCAL-FOUNDATION]
 * [WHY: the fact model and the local records are two representations of the same
 *  curation, and the entire correctness of Sync V2 rests on them staying in
 *  step. A mutator that updates one and forgets the other produces state that is
 *  locally correct and remotely wrong — the user sees their favourite, the
 *  replica never carries it, and nothing anywhere reports a problem. This makes
 *  that class of defect observable during development.
 *
 *  It is deliberately REPORT-ONLY and returns strings rather than repairs.
 *  Load-time reconciliation (ProfileStore#adoptFacts) is a separate, deliberate
 *  mechanism that runs once against persisted state; a check that quietly
 *  repaired on every mutation would hide the very wiring bug it exists to
 *  expose, and would give two independent pieces of code authority to rewrite
 *  the user's curation.]
 *
 * `items` MUST be the raw local records, not an export projection — a projection
 * hides assignments to tombstoned tags, which would then read as missing.
 *
 * Returns [] when the two agree.
 */
export function findProjectionDrift(facts, { name, items, tags }) {
  const problems = [];
  if (!facts) return problems;

  // ---- facts assert something local does not reflect ----
  const diff = diffFactsAgainstProfileData(facts, { name, items, tags });

  if (diff.profileName !== null) {
    problems.push(`profile name: facts say "${diff.profileName}", local says "${name}"`);
  }
  for (const tag of diff.tags.add) problems.push(`tag ${tag.id}: live in facts, absent locally`);
  for (const tag of diff.tags.rename) problems.push(`tag ${tag.id}: facts name it "${tag.name}"`);
  for (const tagId of diff.tags.remove) problems.push(`tag ${tagId}: tombstoned in facts, still in the local vocabulary`);

  for (const item of diff.items) {
    const fields = [];
    if ("favorite" in item) fields.push(`favorite=${item.favorite}`);
    if ("hidden" in item) fields.push(`hidden=${item.hidden}`);
    if (item.addTags.length) fields.push(`+tags(${item.addTags.join(",")})`);
    if (item.removeTags.length) fields.push(`-tags(${item.removeTags.join(",")})`);
    problems.push(`item ${item.path}: facts assert ${fields.join(", ")}`);
  }

  // ---- local asserts something no fact covers ----
  //
  // Only POSITIVE local state is checked. An absent record and an explicitly
  // false one are indistinguishable locally, so demanding a fact for every
  // falsy field would report a "problem" for every file the user has never
  // touched.
  const factItems = facts.items || {};
  for (const [path, record] of Object.entries(items || {})) {
    if (!record || typeof record !== "object") continue;
    const itemFacts = factItems[path] || {};

    if (record.favorite && !itemFacts.favorite) problems.push(`item ${path}: favorited locally with no fact`);
    if (record.hidden && !itemFacts.hidden) problems.push(`item ${path}: hidden locally with no fact`);
    for (const tagId of Array.isArray(record.tags) ? record.tags : []) {
      if (!(itemFacts.tags && itemFacts.tags[tagId])) {
        problems.push(`item ${path}: tag ${tagId} assigned locally with no fact`);
      }
    }
  }

  const factTags = facts.tags || {};
  for (const tag of tags || []) {
    if (!tag || typeof tag.id !== "string") continue;
    if (!factTags[tag.id]) problems.push(`tag ${tag.id}: in the local vocabulary with no fact`);
  }

  return problems;
}
