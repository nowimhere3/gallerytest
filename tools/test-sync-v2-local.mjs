#!/usr/bin/env node
// [PHASE-6-SYNC-V2]
// [STAGE-D1-LOCAL-FOUNDATION]
// [WHY: Stage C proved the merge ALGEBRA in isolation, over hand-built
//  replicas. Everything it guarantees still evaporates if the app wires it up
//  wrongly — a mutation that never becomes a fact, a stamp minted before the
//  clock floor is restored, a fact written under the wrong Profile ID, a
//  deviceId that changes on reload. Every one of those failures is silent: the
//  UI looks correct on the device that made the change, and the loss only
//  appears later, on a different machine, as curation that quietly did not
//  arrive. This harness is the permanent proof that the WIRING holds, not just
//  the algebra.]
//
// Usage:  node tools/test-sync-v2-local.mjs
// Exits non-zero on any failure, matching the other harnesses.
//
// SCOPE: local foundation only — no transport, no remote replica, no library
// association. Those are Stage D2/D3 and get their own numbered tests here
// rather than weakened assertions in these.

import { pathToFileURL } from "node:url";
import path from "node:path";
import { installFakeIndexedDB, settle, muteConsole } from "./lib/browser-test-env.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const src = (rel) => pathToFileURL(path.join(ROOT, "src", rel)).href;

// Deep freezing is development-only in the app; the harness opts in explicitly
// so every snapshot the store hands out is frozen and an accidental
// write-through fails loudly here rather than silently in a browser.
const { setSnapshotFreezeEnabled } = await import(src("profile/profile-snapshot.js"));
setSnapshotFreezeEnabled(true);

const { ProfileStore, setFactCheckEnabled } = await import(src("profile/profile-store.js"));
const { SyncIdentity, generateDeviceId } = await import(src("profile/sync-device.js"));
const { HybridClock, mergeFact, mergeProfileFacts, stableStringify } = await import(src("profile/sync-merge.js"));
const Facts = await import(src("profile/sync-facts.js"));
const { LOCAL_SEED_T, findProjectionDrift } = await import(src("profile/sync-translate.js"));
const { loadProfileData, saveProfileData, saveRegistry } = await import(src("profile/indexeddb.js"));

// The development invariant check doubles as a test oracle here: every test
// below runs with it on, and driftWatch() turns any report it makes into a
// failure. A wiring mistake anywhere therefore fails the suite even in a test
// that was not written to look for it.
setFactCheckEnabled(true);

// ---- Tiny test runner ----------------------------------------------------

let failures = 0;
let passes = 0;
const failureDetail = [];

function assert(condition, label, detail) {
  if (condition) {
    passes++;
    return true;
  }
  failures++;
  failureDetail.push(`${label}${detail ? `\n        ${detail}` : ""}`);
  console.log(`  FAIL  ${label}`);
  if (detail) console.log(`        ${detail}`);
  return false;
}

function assertEqual(actual, expected, label) {
  return assert(
    actual === expected,
    label,
    actual === expected ? null : `expected: ${String(expected)}\n        actual:   ${String(actual)}`
  );
}

// Key ORDER is not part of a replica's identity — mergeMaps deliberately emits
// sorted keys while the store builds its slice incrementally — so comparisons
// go through the merge engine's own canonical form rather than JSON.stringify.
function assertDeepEqual(actual, expected, label) {
  const a = stableStringify(actual);
  const b = stableStringify(expected);
  return assert(a === b, label, a === b ? null : `expected: ${b}\n        actual:   ${a}`);
}

async function test(name, fn) {
  console.log(`\n${name}`);
  const watch = driftWatch();
  try {
    await fn();
    watch.assertClean();
  } catch (error) {
    failures++;
    failureDetail.push(`${name} — threw: ${error && error.stack}`);
    console.log(`  FAIL  threw: ${error && error.message}`);
    console.log(String(error && error.stack).split("\n").slice(1, 4).join("\n"));
  } finally {
    watch.stop();
  }
}

/** Captures every invariant-check report the store emits during a test. */
function driftWatch() {
  const saved = console.warn;
  const reports = [];
  let expected = false;

  console.warn = (...args) => {
    const text = args.map((a) => (typeof a === "string" ? a : "")).join(" ");
    if (text.includes("Facts and local state disagree")) reports.push(text);
  };

  return {
    reports,
    /** Marks drift as the thing this test is deliberately provoking. */
    expectDrift() {
      expected = true;
    },
    assertClean() {
      if (expected) return;
      assert(
        reports.length === 0,
        "the development invariant check reported no facts/local drift",
        reports.length ? reports[0] : null
      );
    },
    stop() {
      console.warn = saved;
    },
  };
}

// ---- Fixtures ------------------------------------------------------------

const SUNRISE = "Nature/Sunrise.mp4";
const RAIN = "Nature/Rain.mp4";
const STORM = "Nature/Storm.mp4";

/** A ProfileStore with an explicit, inspectable identity. */
async function makeStore(identityOptions = {}) {
  const identity = new SyncIdentity(identityOptions);
  const store = new ProfileStore({ identity });
  await settle();
  await store.whenFactsSettled();
  await settle();
  return { store, identity };
}

/** Drains everything a mutation sets in motion: facts, then the row write. */
async function quiesce(store) {
  await store.whenFactsSettled();
  await settle();
  await store.whenFactsSettled();
}

function factsOf(replicaSlice, path) {
  return (replicaSlice.items && replicaSlice.items[path]) || {};
}

// =========================================================================
// 1. First local V2 seed
// =========================================================================

await test("1. a pre-Sync-V2 profile is seeded exactly once, from positive state only", async () => {
  installFakeIndexedDB();

  // A profile row as written by every version before D1: items and tags, no
  // `facts` key at all.
  const profileId = "profile-legacy-1";
  await saveRegistry({
    activeProfileId: profileId,
    profiles: [{ id: profileId, name: "Mackenzie", masterFolder: null, createdAt: 1, updatedAt: 1 }],
  });
  await saveProfileData(profileId, {
    items: {
      [SUNRISE]: { favorite: true, favoritedAt: 1700000000000, tags: ["tag-a"] },
      [RAIN]: { hidden: true },
      // Explicitly-false fields: indistinguishable from "never touched" in V1,
      // so they must NOT become facts.
      [STORM]: { favorite: false, hidden: false },
    },
    tags: [{ id: "tag-a", name: "ALPHA" }],
  });

  const { store } = await makeStore();
  await quiesce(store);

  assertEqual(store.getProfileId(), profileId, "the legacy profile stayed active");

  const facts = store.getFacts();
  assertEqual(facts.name.v, "Mackenzie", "the profile name was seeded");
  assertEqual(facts.name.t, LOCAL_SEED_T, "seeded facts carry the seed floor, not a wall clock");
  assertEqual(factsOf(facts, SUNRISE).favorite.v.on, true, "the favorite was seeded");
  assertEqual(factsOf(facts, SUNRISE).favorite.v.at, 1700000000000, "the real favoritedAt was preserved");
  assertEqual(factsOf(facts, SUNRISE).tags["tag-a"].v, true, "the tag assignment was seeded");
  assertEqual(factsOf(facts, RAIN).hidden.v, true, "the hidden flag was seeded");
  assertEqual(facts.tags["tag-a"].name.v, "ALPHA", "the tag vocabulary was seeded");

  assertEqual(facts.items[STORM], undefined, "an all-false record produced no facts at all");

  // The seed must persist, and a reload must ADOPT rather than re-seed.
  const stored = await loadProfileData(profileId);
  assert(stored.facts !== null, "the seeded facts were persisted with the row");

  const { store: reloaded } = await makeStore();
  await quiesce(reloaded);
  assertDeepEqual(
    reloaded.getFacts(),
    facts,
    "reloading adopted the stored facts unchanged — no second seed re-stamped anything"
  );
});

// =========================================================================
// 2. Profile isolation
// =========================================================================

await test("2. facts are per-Profile — nothing leaks between two Galleries", async () => {
  installFakeIndexedDB();
  const { store } = await makeStore();

  const beast = await store.createProfile("BEAST");
  const bbg4 = await store.createProfile("BBG4");

  await store.switchProfile(beast.id);
  await quiesce(store);
  store.setFavorite(SUNRISE, true);
  const beastTag = store.createTag("BEAST-ONLY");
  await quiesce(store);

  await store.switchProfile(bbg4.id);
  await quiesce(store);

  const bbg4Facts = store.getFacts();
  assertEqual(bbg4Facts.items[SUNRISE], undefined, "BBG4 carries no trace of BEAST's favorite");
  assertEqual(bbg4Facts.tags[beastTag.id], undefined, "BBG4 carries no trace of BEAST's tag");
  assertEqual(store.isFavorite(SUNRISE), false, "and no trace in local state either");

  store.setHidden(RAIN, true);
  await quiesce(store);

  const replica = await store.getFullReplica();
  assertEqual(
    replica.profiles[beast.id].items[SUNRISE].favorite.v.on,
    true,
    "the full replica still holds BEAST's favorite"
  );
  assertEqual(replica.profiles[bbg4.id].items[RAIN].hidden.v, true, "and BBG4's hidden flag");
  assertEqual(replica.profiles[beast.id].items[RAIN], undefined, "BEAST did not acquire BBG4's hidden flag");
  assertEqual(replica.profiles[bbg4.id].items[SUNRISE], undefined, "BBG4 did not acquire BEAST's favorite");
});

// =========================================================================
// 3. Active Profile is not the same thing as an associated Profile
// =========================================================================

await test("3. a mutation follows the ACTIVE Profile, not any other association", async () => {
  installFakeIndexedDB();
  const { store } = await makeStore();

  const beast = await store.createProfile("BEAST");
  const bbg4 = await store.createProfile("BBG4");

  // BEAST is given real curation first, so it is a fully-formed profile in the
  // replica — otherwise "nothing landed in BEAST" would pass trivially.
  await store.switchProfile(beast.id);
  await quiesce(store);
  store.setHidden(RAIN, true);
  await quiesce(store);

  await store.switchProfile(bbg4.id);
  await quiesce(store);

  // Stage D3 introduces libraryId -> profileId associations. Stage C's algebra
  // already supports them, so the association is built here directly and
  // deliberately pointed at the NON-active profile: nothing about the active
  // curation path may consult it.
  const stamp = { t: Date.now(), d: "dev-test" };
  const associated = Facts.setLibraryAssociation(Facts.emptyReplica(), "library-1", beast.id, stamp);
  assertEqual(
    Facts.projectAssociations(associated)["library-1"],
    beast.id,
    "the library is associated with BEAST"
  );

  store.setFavorite(SUNRISE, true);
  await quiesce(store);

  const replica = await store.getFullReplica();
  assertEqual(
    replica.profiles[bbg4.id].items[SUNRISE].favorite.v.on,
    true,
    "the favorite landed in the ACTIVE profile (BBG4)"
  );
  assertEqual(
    replica.profiles[beast.id].items[SUNRISE],
    undefined,
    "and NOT in the associated profile (BEAST), which is present in the replica but untouched"
  );
  assertEqual(replica.profiles[beast.id].items[RAIN].hidden.v, true, "BEAST kept its own curation");
  assertDeepEqual(
    Facts.projectAssociations(replica),
    {},
    "ProfileStore publishes no associations of its own — that wiring is Stage D3"
  );
});

// =========================================================================
// 4. Every mutation lands, under the active Profile ID, in the same row
// =========================================================================

await test("4. every wired mutation records a fact and persists it with its value", async () => {
  installFakeIndexedDB();
  const { store } = await makeStore();
  const profileId = store.getProfileId();

  store.setProfileName("Mackenzie");
  store.setFavorite(SUNRISE, true);
  store.setHidden(RAIN, true);
  const tag = store.createTag("ALPHA");
  store.setItemTag(SUNRISE, tag.id, true);
  await quiesce(store);
  store.renameTag(tag.id, "ALPHA-2");
  await quiesce(store);

  const facts = store.getFacts();
  assertEqual(facts.name.v, "Mackenzie", "setProfileName recorded a fact");
  assertEqual(factsOf(facts, SUNRISE).favorite.v.on, true, "setFavorite recorded a fact");
  assertEqual(factsOf(facts, RAIN).hidden.v, true, "setHidden recorded a fact");
  assertEqual(facts.tags[tag.id].name.v, "ALPHA-2", "createTag + renameTag recorded facts");
  assertEqual(facts.tags[tag.id].deleted.v, false, "createTag asserted the tag lives");
  assertEqual(factsOf(facts, SUNRISE).tags[tag.id].v, true, "setItemTag recorded a fact");

  assertEqual(
    factsOf(facts, SUNRISE).favorite.v.at,
    store.getFavoritedAt(SUNRISE),
    "the fact's favoritedAt is the same instant the record carries"
  );

  // Un-setting is the same fact with the opposite value — a negative fact, not
  // an absence, or it could never propagate.
  store.setFavorite(SUNRISE, false);
  store.setHidden(RAIN, false);
  store.setItemTag(SUNRISE, tag.id, false);
  await quiesce(store);

  const negated = store.getFacts();
  assertEqual(factsOf(negated, SUNRISE).favorite.v.on, false, "un-favoriting is a fact, not an absence");
  assertEqual(factsOf(negated, RAIN).hidden.v, false, "un-hiding is a fact");
  assertEqual(factsOf(negated, SUNRISE).tags[tag.id].v, false, "un-tagging is a fact");

  // Value and stamp must be in the SAME persisted row — that is the whole
  // reason `facts` rides in saveProfileData's single put().
  const stored = await loadProfileData(profileId);
  assertEqual(stored.facts.items[SUNRISE].favorite.v.on, false, "the row's facts match the row's values");
  assertEqual(Boolean(stored.items[SUNRISE] && stored.items[SUNRISE].favorite), false, "…and its records");

  const leaks = Facts.findSessionStateLeaks({
    schemaVersion: 2,
    profiles: { [profileId]: stored.facts },
    associations: {},
  });
  assertDeepEqual(leaks, [], "the persisted facts are exactly the approved shape — no session state");
});

// =========================================================================
// 5. deviceId persists across reload
// =========================================================================

await test("5. deviceId is minted once and survives reload — and Disconnect Sync", async () => {
  installFakeIndexedDB();

  const first = new SyncIdentity();
  await first.ready;
  const deviceId = first.deviceId;
  assert(typeof deviceId === "string" && deviceId.startsWith("dev-"), "a device id was minted");
  assertEqual(first.isEphemeral, false, "and it was persisted");

  const second = new SyncIdentity();
  await second.ready;
  assertEqual(second.deviceId, deviceId, "a reload reuses the SAME device id");

  // "Disconnect Sync" clears the connection record; the device row must survive,
  // or this installation becomes a brand-new peer every time it reconnects.
  const { clearSyncConfig } = await import(src("storage/profile-sync-store.js"));
  await clearSyncConfig();

  const third = new SyncIdentity();
  await third.ready;
  assertEqual(third.deviceId, deviceId, "Disconnect Sync does not destroy the device identity");

  assert(generateDeviceId() !== generateDeviceId(), "generateDeviceId does not collide with itself");
});

// =========================================================================
// 6. A missing device record mints safely
// =========================================================================

await test("6. a missing or unreadable device record degrades to a working install", async () => {
  installFakeIndexedDB();

  // No record at all — the ordinary first-run path.
  const fresh = new SyncIdentity();
  await fresh.ready;
  assert(Boolean(fresh.deviceId), "a first run mints an id rather than failing");

  // Storage entirely unavailable (private-browsing modes disable IndexedDB).
  const restore = muteConsole();
  const broken = new SyncIdentity({
    storage: {
      loadDeviceRecord: async () => {
        throw new Error("IndexedDB is disabled");
      },
      saveDeviceRecord: async () => {
        throw new Error("IndexedDB is disabled");
      },
      persistLastIssuedT: async () => {
        throw new Error("IndexedDB is disabled");
      },
    },
  });
  await broken.ready;
  restore();

  assert(Boolean(broken.deviceId), "an unreadable device record still yields a usable id");
  assertEqual(broken.isEphemeral, true, "…marked ephemeral, so a later stage can refuse to publish under it");
  assert(Boolean(broken.tick().t), "and stamping still works, so curation is never blocked");

  // Curation must survive that too — the store must not throw or stall.
  installFakeIndexedDB();
  const restore2 = muteConsole();
  const store = new ProfileStore({
    identity: new SyncIdentity({
      storage: {
        loadDeviceRecord: async () => {
          throw new Error("IndexedDB is disabled");
        },
        saveDeviceRecord: async () => {
          throw new Error("IndexedDB is disabled");
        },
        persistLastIssuedT: async () => {
          throw new Error("IndexedDB is disabled");
        },
      },
    }),
  });
  await settle();
  store.setFavorite(SUNRISE, true);
  await quiesce(store);
  restore2();

  assertEqual(store.isFavorite(SUNRISE), true, "favoriting still works with an ephemeral identity");
  assertEqual(factsOf(store.getFacts(), SUNRISE).favorite.v.on, true, "and it is still recorded as a fact");
});

// =========================================================================
// 7. The clock floor survives reload and never regresses
// =========================================================================

await test("7. the logical clock floor is restored on reload — a stamp can never go backwards", async () => {
  installFakeIndexedDB();

  // A wall clock that is deliberately stuck in the past on the second run: the
  // ONLY thing that can keep stamps rising is the persisted floor.
  const identity = new SyncIdentity({ now: () => 5_000 });
  await identity.ready;

  let last = 0;
  for (let i = 0; i < 5; i += 1) {
    const stamp = identity.tick();
    assert(stamp.t > last, `stamp ${i} rose above the previous one`);
    last = stamp.t;
  }
  // A peer from the future must raise the floor too.
  identity.observe(9_000_000);
  const afterObserve = identity.tick();
  assert(afterObserve.t > 9_000_000, "observing a future peer raises the floor above it");
  await identity.flush();

  const reloaded = new SyncIdentity({ now: () => 5_000 });
  await reloaded.ready;
  const first = reloaded.tick();
  assert(
    first.t > afterObserve.t,
    "the first stamp after reload is above everything the previous session issued",
    `previous: ${afterObserve.t}, after reload: ${first.t}`
  );

  // The persisted floor is monotonic in its own right: a stale write cannot
  // lower it and let a stamp be re-issued.
  const { persistLastIssuedT, loadDeviceRecord } = await import(src("storage/profile-sync-store.js"));
  await reloaded.flush();
  const before = await loadDeviceRecord();
  await persistLastIssuedT(1);
  const after = await loadDeviceRecord();
  assertEqual(after.lastIssuedT, before.lastIssuedT, "a lower floor write is ignored, not applied");
});

// =========================================================================
// 8. Observe-before-tick — the silent-loss failure mode
// =========================================================================

await test("8. a local mutation outranks facts already present (observe-before-tick)", async () => {
  installFakeIndexedDB();

  // First, the failure mode itself, in isolation: a clock that has NOT observed
  // an existing fact issues a stamp that loses, so the mutation vanishes with no
  // error anywhere.
  const FUTURE = Date.now() + 5 * 365 * 24 * 60 * 60 * 1000;
  const existing = { v: { on: true, at: FUTURE }, t: FUTURE, d: "dev-peer" };

  const blind = new HybridClock("dev-local", { now: () => Date.now() });
  const blindStamp = blind.tick();
  const blindResult = mergeFact(existing, { v: { on: false, at: null }, ...blindStamp });
  assertEqual(blindResult.v.on, true, "WITHOUT observing, the local un-favorite is silently discarded");

  const observing = new HybridClock("dev-local", { now: () => Date.now() });
  observing.observe(FUTURE);
  const observedStamp = observing.tick();
  const observedResult = mergeFact(existing, { v: { on: false, at: null }, ...observedStamp });
  assertEqual(observedResult.v.on, false, "AFTER observing, the local un-favorite wins");

  // Now the wiring: a profile row whose stored facts carry a far-future stamp.
  // ProfileStore must observe them at load, so the user's next click still wins.
  const profileId = "profile-future-1";
  await saveRegistry({
    activeProfileId: profileId,
    profiles: [{ id: profileId, name: "Mackenzie", masterFolder: null, createdAt: 1, updatedAt: 1 }],
  });
  await saveProfileData(profileId, {
    items: { [SUNRISE]: { favorite: true, favoritedAt: FUTURE } },
    tags: [],
    facts: {
      name: { v: "Mackenzie", t: FUTURE, d: "dev-peer" },
      items: { [SUNRISE]: { favorite: existing, tags: {} } },
      tags: {},
    },
  });

  const { store } = await makeStore();
  await quiesce(store);
  assertEqual(store.isFavorite(SUNRISE), true, "the stored future favorite was adopted locally");

  store.setFavorite(SUNRISE, false);
  await quiesce(store);

  assertEqual(
    factsOf(store.getFacts(), SUNRISE).favorite.v.on,
    false,
    "the user's un-favorite beat a fact stamped five years in the future"
  );
  assertEqual(store.isFavorite(SUNRISE), false, "and local state agrees");

  // And it must still be true after a reload, which re-runs the adopt path.
  const { store: reloaded } = await makeStore();
  await quiesce(reloaded);
  assertEqual(reloaded.isFavorite(SUNRISE), false, "the un-favorite survived a reload");
});

// =========================================================================
// 9. Local-only fields survive a full round trip
// =========================================================================

await test("9. tagActivity and unknown local fields survive load, mutation and adoption", async () => {
  installFakeIndexedDB();

  const profileId = "profile-local-fields-1";
  await saveRegistry({
    activeProfileId: profileId,
    profiles: [{ id: profileId, name: "Mackenzie", masterFolder: null, createdAt: 1, updatedAt: 1 }],
  });
  await saveProfileData(profileId, {
    items: {
      // `rating` and `note` are fields this version of the code has never heard
      // of — the "open shape" contract. They must not be touched by anything.
      [SUNRISE]: { favorite: true, favoritedAt: 1700000000000, rating: 4, note: "keep" },
    },
    tags: [
      {
        id: "tag-a",
        name: "ALPHA",
        lastTagPosition: 3,
        totalAtTime: 10,
        lastTaggedAt: 1700000000001,
        lastTagShuffle: false,
        tagActivity: { shuffleOff: { position: 3, total: 10, timestamp: 1700000000001 } },
      },
    ],
  });

  const { store } = await makeStore();
  await quiesce(store);

  // A mutation on the SAME item, and on the same tag, is the dangerous case:
  // it rewrites the record, and used to take unknown fields with it.
  store.setHidden(SUNRISE, true);
  store.recordTagActivity("tag-a", { position: 7, total: 12, shuffle: true, timestamp: 1700000000002 });
  await quiesce(store);

  const stored = await loadProfileData(profileId);
  assertEqual(stored.items[SUNRISE].rating, 4, "an unknown field survived a mutation on the same record");
  assertEqual(stored.items[SUNRISE].note, "keep", "…and so did the second one");
  assertEqual(stored.items[SUNRISE].hidden, true, "the mutation itself landed");

  const activity = store.getTagActivity("tag-a");
  assertEqual(activity.shuffleOff.position, 3, "the Shuffle OFF resume point was not overwritten");
  assertEqual(activity.shuffleOn.position, 7, "the Shuffle ON resume point was recorded independently");

  // tagActivity is session-local: it must never appear in a replica.
  const replica = await store.getFullReplica();
  assertDeepEqual(
    Facts.findSessionStateLeaks(replica),
    [],
    "no session-only field leaked into the replica"
  );
  assert(
    !JSON.stringify(replica).includes("tagActivity"),
    "tagActivity does not appear anywhere in the published replica"
  );
  assert(!JSON.stringify(replica).includes("\"rating\""), "unknown local fields do not appear either");

  // A reload runs the adopt path, which applies facts back onto local records —
  // the exact place Sync V1 destroyed local-only fields by replacing records.
  const { store: reloaded } = await makeStore();
  await quiesce(reloaded);
  const afterReload = await loadProfileData(profileId);
  assertEqual(afterReload.items[SUNRISE].rating, 4, "adoption did not strip the unknown field");
  assertEqual(reloaded.getTagActivity("tag-a").shuffleOn.position, 7, "adoption did not strip tagActivity");
});

// =========================================================================
// 10. Replay / idempotence
// =========================================================================

await test("10. replaying the same mutations converges to the same facts", async () => {
  installFakeIndexedDB();
  const { store } = await makeStore();
  const profileId = store.getProfileId();

  store.setFavorite(SUNRISE, true);
  const tag = store.createTag("ALPHA");
  store.setItemTag(SUNRISE, tag.id, true);
  store.setHidden(RAIN, true);
  await quiesce(store);

  const facts = store.getFacts();

  // Merging a replica with itself must change nothing (idempotence), and
  // merging it with a strict subset of its own history must change nothing
  // either (replaying an already-applied mutation is a no-op).
  assertDeepEqual(mergeProfileFacts(facts, facts), facts, "merging the facts with themselves is a no-op");

  const replayed = Facts.setItemTag(
    { schemaVersion: 2, profiles: { [profileId]: facts }, associations: {} },
    profileId,
    SUNRISE,
    tag.id,
    true,
    facts.items[SUNRISE].tags[tag.id] // the ORIGINAL stamp, replayed verbatim
  ).profiles[profileId];
  assertDeepEqual(replayed, facts, "replaying a mutation at its original stamp changes nothing");

  // Re-issuing the SAME user action at a NEW stamp is a new fact with the same
  // value: state is unchanged, ordering advances.
  store.setItemTag(SUNRISE, tag.id, false);
  store.setItemTag(SUNRISE, tag.id, true);
  await quiesce(store);
  const reapplied = store.getFacts();
  assertEqual(factsOf(reapplied, SUNRISE).tags[tag.id].v, true, "the value is where it started");
  assert(
    factsOf(reapplied, SUNRISE).tags[tag.id].t > factsOf(facts, SUNRISE).tags[tag.id].t,
    "…at a strictly later stamp"
  );

  // And a reload is itself a replay: the row is read back and re-adopted.
  const { store: reloaded } = await makeStore();
  await quiesce(reloaded);
  assertDeepEqual(reloaded.getFacts(), reapplied, "a reload re-adopts the identical facts");
});

// =========================================================================
// 11. Profile IDs are never regenerated
// =========================================================================

await test("11. Profile IDs are stable across load, mutation, switch and reload", async () => {
  installFakeIndexedDB();
  const { store } = await makeStore();

  const original = store.getProfileId();
  const beast = await store.createProfile("BEAST");

  store.setFavorite(SUNRISE, true);
  await quiesce(store);
  assertEqual(store.getProfileId(), original, "a mutation does not regenerate the Profile ID");

  await store.switchProfile(beast.id);
  await quiesce(store);
  assertEqual(store.getProfileId(), beast.id, "switching moves to the requested id exactly");

  await store.switchProfile(original);
  await quiesce(store);
  assertEqual(store.getProfileId(), original, "switching back returns the SAME id, not a new one");
  assertEqual(store.isFavorite(SUNRISE), true, "…with its curation intact");

  const { store: reloaded } = await makeStore();
  await quiesce(reloaded);
  assertEqual(reloaded.getProfileId(), original, "a reload keeps the active Profile ID");
  assertDeepEqual(
    reloaded.listProfiles().map((p) => p.id).sort(),
    [original, beast.id].sort(),
    "…and every registered Profile ID"
  );
});

// =========================================================================
// 12. A queued fact never drains against the wrong Profile
// =========================================================================

await test("12. a mutation issued just before a switch lands in the profile it was made in", async () => {
  installFakeIndexedDB();

  // The race has to be forced, not hoped for. An identity whose device record
  // cannot be read until the test says so holds the ENTIRE fact queue open —
  // every stamp waits on `ready` — so a mutation issued before the switch is
  // provably still queued when switchProfile runs. Left to natural timing the
  // queue drains during switchProfile's own registry write and the test would
  // pass without ever exercising the thing it names.
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const identity = new SyncIdentity({
    storage: {
      loadDeviceRecord: async () => {
        await gate;
        return null;
      },
      saveDeviceRecord: async (record) => record,
      persistLastIssuedT: async () => null,
    },
  });

  const store = new ProfileStore({ identity });
  await settle();

  const source = store.getProfileId();
  const beast = await store.createProfile("BEAST");

  store.setFavorite(SUNRISE, true);
  const switching = store.switchProfile(beast.id);
  await settle();
  release();
  await switching;

  // Read with NO settle in between: switchProfile must not resolve until the
  // outgoing profile is fully written. Draining only the fact queue leaves the
  // row write in flight here, and it then lands without the fact.
  const immediately = await loadProfileData(source);
  assertEqual(
    immediately.facts && immediately.facts.items[SUNRISE].favorite.v.on,
    true,
    "the outgoing profile's fact was PERSISTED before switchProfile resolved"
  );
  assertEqual(immediately.items[SUNRISE].favorite, true, "…alongside its value, in the same row");

  await quiesce(store);

  assertEqual(store.getProfileId(), beast.id, "the switch completed");
  assertEqual(store.getFacts().items[SUNRISE], undefined, "BEAST did not receive the in-flight fact");

  const replica = await store.getFullReplica();
  assertEqual(
    replica.profiles[source].items[SUNRISE].favorite.v.on,
    true,
    "the in-flight fact landed in the profile that was active when the user clicked"
  );
});

// =========================================================================
// 13. Deleting a tag is a tombstone, not a strip
// =========================================================================

await test("13. deleting a tag tombstones it and keeps the assignments underneath", async () => {
  installFakeIndexedDB();
  const { store } = await makeStore();
  const profileId = store.getProfileId();

  const tag = store.createTag("ALPHA");
  const keeper = store.createTag("BETA");
  store.setItemTag(SUNRISE, tag.id, true);
  store.setItemTag(SUNRISE, keeper.id, true);
  store.setItemTag(RAIN, tag.id, true);
  await quiesce(store);

  store.deleteTag(tag.id);
  await quiesce(store);

  // ---- the tombstone ----
  const facts = store.getFacts();
  assertEqual(facts.tags[tag.id].deleted.v, true, "the tag carries a deletion tombstone");
  assertEqual(facts.tags[tag.id].name.v, "ALPHA", "…and still carries its name, so a restore is complete");
  assertEqual(
    factsOf(facts, SUNRISE).tags[tag.id].v,
    true,
    "the assignment fact is retained — deletion cost one fact, not one per item"
  );

  // ---- hidden at every projection boundary ----
  assertDeepEqual(store.getItemTags(SUNRISE), [keeper.id], "getItemTags reports only tags that exist");
  assertEqual(store.hasItemTag(SUNRISE, tag.id), false, "hasItemTag agrees");
  assertDeepEqual(
    store.getTags().map((t) => t.id),
    [keeper.id],
    "the vocabulary no longer offers the deleted tag"
  );

  const exported = store.toJSON();
  assertDeepEqual(exported.items[SUNRISE].tags, [keeper.id], "the export carries no dangling tag id");
  assertEqual(exported.items[RAIN], undefined, "a record left holding only deleted-tag ids is not exported");

  const collection = await store.getFullCollection();
  const active = collection.find((entry) => entry.id === profileId);
  assertDeepEqual(active.items[SUNRISE].tags, [keeper.id], "the sync collection carries no dangling tag id");

  // ---- but still there underneath ----
  const stored = await loadProfileData(profileId);
  assert(stored.items[SUNRISE].tags.includes(tag.id), "storage retains the assignment for a future restore");
  assert(stored.items[RAIN].tags.includes(tag.id), "…on every item that had it");

  // ---- and a restore brings the tagging back ----
  const restoreStamp = { t: Date.now() + 1000, d: "dev-test" };
  const restored = Facts.restoreTag(
    { schemaVersion: 2, profiles: { [profileId]: stored.facts }, associations: {} },
    profileId,
    tag.id,
    restoreStamp
  );
  const projected = Facts.projectProfile(restored, profileId);
  assert(
    projected.tags.some((t) => t.id === tag.id),
    "restoring the tag brings it back into the vocabulary"
  );
  assertDeepEqual(
    projected.itemTags[SUNRISE].sort(),
    [tag.id, keeper.id].sort(),
    "…with the prior assignments intact, which a strip could never have recovered"
  );
});

// =========================================================================
// 14. The invariant check is a real check, and never repairs
// =========================================================================

await test("14. the development invariant check detects drift and changes nothing", async () => {
  installFakeIndexedDB();
  const { store } = await makeStore();

  store.setFavorite(SUNRISE, true);
  const tag = store.createTag("ALPHA");
  store.setItemTag(SUNRISE, tag.id, true);
  store.setHidden(RAIN, true);
  await quiesce(store);

  assertDeepEqual(store.checkFactInvariants(), [], "a correctly wired store reports no drift");

  // The check must actually be capable of failing — a check that always passes
  // is worse than none, because it is trusted.
  const facts = store.getFacts();
  const localOnly = findProjectionDrift(facts, {
    name: store.getProfileName(),
    items: { ...{}, [SUNRISE]: { favorite: true }, [STORM]: { favorite: true } },
    tags: store.getTags(),
  });
  assert(
    localOnly.some((problem) => problem.includes(STORM) && problem.includes("no fact")),
    "local state with no covering fact is reported",
    localOnly.join(" | ")
  );

  const factOnly = findProjectionDrift(facts, {
    name: "Something Else",
    items: {},
    tags: [],
  });
  assert(
    factOnly.some((problem) => problem.includes("profile name")),
    "a fact the local state does not reflect is reported",
    factOnly.join(" | ")
  );
  assert(
    factOnly.some((problem) => problem.includes("absent locally")),
    "a tag live in facts but missing locally is reported",
    factOnly.join(" | ")
  );

  // …and running it left nothing altered.
  assertEqual(store.isFavorite(SUNRISE), true, "the check did not touch local state");
  assertDeepEqual(store.getFacts(), facts, "the check did not touch the facts");
  assertDeepEqual(store.checkFactInvariants(), [], "and the store is still clean afterwards");
});

// =========================================================================
// 15. Seeding never fabricates a favoritedAt
// =========================================================================

await test("15. seeding a favorite that predates favoritedAt does not invent a timestamp", async () => {
  installFakeIndexedDB();

  const profileId = "profile-old-export-1";
  await saveRegistry({
    activeProfileId: profileId,
    profiles: [{ id: profileId, name: "Mackenzie", masterFolder: null, createdAt: 1, updatedAt: 1 }],
  });
  // A schemaVersion-1 style record: favorite with no favoritedAt at all.
  await saveProfileData(profileId, { items: { [SUNRISE]: { favorite: true } }, tags: [] });

  const { store } = await makeStore();
  await quiesce(store);

  assertEqual(store.isFavorite(SUNRISE), true, "the favorite was preserved");
  assertEqual(
    store.getFavoritedAt(SUNRISE),
    null,
    "favoritedAt stayed unknown — the seed floor was not written back as a 1970 timestamp"
  );

  const stored = await loadProfileData(profileId);
  assertEqual(
    "favoritedAt" in stored.items[SUNRISE],
    false,
    "and nothing fabricated was persisted onto the record"
  );

  // A REAL favoritedAt arriving from a merge must still be applied.
  const realAt = Date.now();
  const withReal = Facts.setFavorite(
    { schemaVersion: 2, profiles: { [profileId]: stored.facts }, associations: {} },
    profileId,
    SUNRISE,
    true,
    { t: realAt, d: "dev-peer" },
    { at: realAt }
  );
  await saveProfileData(profileId, {
    items: stored.items,
    tags: stored.tags,
    facts: withReal.profiles[profileId],
  });

  const { store: reloaded } = await makeStore();
  await quiesce(reloaded);
  assertEqual(reloaded.getFavoritedAt(SUNRISE), realAt, "a genuine favoritedAt from a peer IS applied");
});

// =========================================================================
// 16a. A burst of mutations is fully written before a switch swaps the slice
// =========================================================================

await test("16a. a switch during a burst persists every fact, not just the drained ones", async () => {
  installFakeIndexedDB();
  const { store } = await makeStore();

  const source = store.getProfileId();
  const beast = await store.createProfile("BEAST");

  // Presentation Quick Tagging shape: many mutations with no await between them,
  // so the save queue is genuinely backed up when the switch arrives. Each
  // #persist is serialized behind the last, and each waits on the fact queue —
  // so a switch that drains only facts can reach its reset while saves are still
  // deciding whether to include them.
  const BURST = 40;
  for (let i = 0; i < BURST; i += 1) store.setFavorite(`Burst/${i}.mp4`, true);

  await store.switchProfile(beast.id);

  // No settle: switchProfile must not resolve until the outgoing profile is
  // completely written.
  const row = await loadProfileData(source);
  const persisted = row.facts ? Object.keys(row.facts.items || {}) : [];
  assertEqual(persisted.length, BURST, `all ${BURST} facts were persisted before the switch resolved`);

  const missingValues = [];
  for (let i = 0; i < BURST; i += 1) {
    const path = `Burst/${i}.mp4`;
    if (!(row.items[path] && row.items[path].favorite)) missingValues.push(path);
  }
  assertDeepEqual(missingValues, [], "every VALUE landed in the same row as its fact");

  await quiesce(store);
  assertEqual(store.getFacts().items["Burst/0.mp4"], undefined, "and none of it followed the switch");
});

// =========================================================================
// 16. A mutation made before the initial load finishes is not lost
// =========================================================================

await test("16. a mutation racing the initial load survives adoption of the stored facts", async () => {
  installFakeIndexedDB();

  const profileId = "profile-race-1";
  const storedAt = 1700000000000;
  await saveRegistry({
    activeProfileId: profileId,
    profiles: [{ id: profileId, name: "Mackenzie", masterFolder: null, createdAt: 1, updatedAt: 1 }],
  });
  await saveProfileData(profileId, {
    items: { [RAIN]: { hidden: true } },
    tags: [],
    facts: {
      name: { v: "Mackenzie", t: storedAt, d: "dev-prior" },
      items: { [RAIN]: { hidden: { v: true, t: storedAt, d: "dev-prior" }, tags: {} } },
      tags: {},
    },
  });

  // The clock is resolved BEFORE the store exists, which fixes the interleaving
  // deterministically: stamping a mutation then costs only microtasks, while the
  // initial load must first read the registry and the profile row from
  // IndexedDB. So the mutation is stamped into the fact slice FIRST, and
  // adoption runs against a slice that already has content — the ordering that
  // loses the user's click outright if adoption assigns instead of merging.
  const identity = new SyncIdentity();
  await identity.ready;
  const store = new ProfileStore({ identity });

  // Issued IMMEDIATELY, before any settle: this is the same race
  // #changedBeforeLoad already guards for item records.
  store.setFavorite(SUNRISE, true);
  await quiesce(store);

  const facts = store.getFacts();
  assertEqual(
    factsOf(facts, SUNRISE).favorite.v.on,
    true,
    "the racing mutation survived — adoption MERGED the stored facts rather than assigning over them"
  );
  assertEqual(factsOf(facts, RAIN).hidden.v, true, "…and the stored facts were adopted too");
  assertEqual(store.isFavorite(SUNRISE), true, "local state agrees");
  assertEqual(store.isHidden(RAIN), true, "…for both");

  const stored = await loadProfileData(profileId);
  assertEqual(stored.facts.items[SUNRISE].favorite.v.on, true, "and both were persisted");
  assertEqual(stored.facts.items[RAIN].hidden.v, true, "…in the same row");

  // The SEEDING branch has to survive the same race. A pre-Sync-V2 profile
  // reaches #adoptFacts with no stored facts at all, and the seed it builds must
  // not replace a mutation that has already been stamped into the slice.
  installFakeIndexedDB();
  const legacyId = "profile-race-legacy-1";
  await saveRegistry({
    activeProfileId: legacyId,
    profiles: [{ id: legacyId, name: "Mackenzie", masterFolder: null, createdAt: 1, updatedAt: 1 }],
  });
  await saveProfileData(legacyId, { items: { [RAIN]: { hidden: true } }, tags: [] });

  const seedIdentity = new SyncIdentity();
  await seedIdentity.ready;
  const seedStore = new ProfileStore({ identity: seedIdentity });
  seedStore.setFavorite(SUNRISE, true);
  await quiesce(seedStore);

  const seedFacts = seedStore.getFacts();
  assertEqual(
    factsOf(seedFacts, SUNRISE).favorite.v.on,
    true,
    "the racing mutation survived seeding — the seed was MERGED, not assigned"
  );
  assert(
    factsOf(seedFacts, SUNRISE).favorite.t > LOCAL_SEED_T,
    "…at its own real stamp, not flattened to the seed floor"
  );
  assertEqual(factsOf(seedFacts, RAIN).hidden.v, true, "and the pre-existing curation was still seeded");
  assertEqual(factsOf(seedFacts, RAIN).hidden.t, LOCAL_SEED_T, "…at the seed floor, where it belongs");
});

// =========================================================================
// 17. The persistence contract for `facts`
// =========================================================================

await test("17. omitting `facts` preserves them; null clears them; both in one atomic row", async () => {
  installFakeIndexedDB();

  const profileId = "profile-persist-1";
  const facts = {
    name: { v: "Mackenzie", t: 1700000000000, d: "dev-a" },
    items: { [SUNRISE]: { favorite: { v: { on: true, at: 1 }, t: 1700000000001, d: "dev-a" }, tags: {} } },
    tags: {},
  };

  await saveProfileData(profileId, { items: { [SUNRISE]: { favorite: true } }, tags: [], facts });
  assertDeepEqual((await loadProfileData(profileId)).facts, facts, "facts are stored with the row");

  // OMITTED — a save queued for a profile that is no longer active does this,
  // and it must not erase the stamps.
  await saveProfileData(profileId, { items: { [RAIN]: { hidden: true } }, tags: [] });
  const preserved = await loadProfileData(profileId);
  assertDeepEqual(preserved.facts, facts, "omitting `facts` PRESERVED them");
  assertEqual(preserved.items[SUNRISE], undefined, "…while the items were still replaced wholesale");
  assertEqual(preserved.items[RAIN].hidden, true, "…by exactly what was passed");

  // NULL — the explicit clear, used only by a V1 wholesale adoption.
  await saveProfileData(profileId, { items: {}, tags: [], facts: null });
  assertEqual((await loadProfileData(profileId)).facts, null, "an explicit null CLEARED the facts");

  // A row that has never had facts reports null, not an empty object — the two
  // mean different things to #adoptFacts.
  await saveProfileData("profile-persist-2", { items: {}, tags: [] });
  assertEqual((await loadProfileData("profile-persist-2")).facts, null, "a never-seeded row reports null");
});

// =========================================================================
// 18. V1 wholesale adoption stays authoritative (controlled hard cutover)
// =========================================================================

await test("18. a Sync V1 collection replacement is not reverted by stale facts", async () => {
  installFakeIndexedDB();
  const { store } = await makeStore();
  const profileId = store.getProfileId();

  store.setFavorite(SUNRISE, true);
  store.setHidden(RAIN, true);
  await quiesce(store);
  assert(factsOf(store.getFacts(), SUNRISE).favorite.v.on === true, "the pre-adoption facts exist");

  // What Sync V1 does today: replace the entire collection with the remote one.
  // The incoming collection disagrees with every local fact.
  await store.replaceAllProfiles([
    {
      id: profileId,
      name: "Mackenzie",
      masterFolder: null,
      items: { [STORM]: { favorite: true, favoritedAt: 1700000000000 } },
      tags: [{ id: "tag-remote", name: "REMOTE" }],
    },
  ]);
  await quiesce(store);

  assertEqual(store.isFavorite(STORM), true, "the adopted collection is what the user now has");
  assertEqual(store.isFavorite(SUNRISE), false, "the superseded favorite did NOT come back");
  assertEqual(store.isHidden(RAIN), false, "…nor the superseded hidden flag");
  assertDeepEqual(store.getTags().map((t) => t.id), ["tag-remote"], "…and the tag vocabulary is the adopted one");

  // The facts were re-derived from the adopted data — at the seed floor, so
  // every later real mutation on any device outranks them.
  const facts = store.getFacts();
  assertEqual(facts.items[SUNRISE], undefined, "the stale facts were cleared, not merged");
  assertEqual(factsOf(facts, STORM).favorite.v.on, true, "the adopted state was re-seeded as facts");
  assertEqual(factsOf(facts, STORM).favorite.t, LOCAL_SEED_T, "…at the seed floor");

  // And a reload must not resurrect anything either — the adopt path runs again.
  const { store: reloaded } = await makeStore();
  await quiesce(reloaded);
  assertEqual(reloaded.isFavorite(SUNRISE), false, "a reload did not resurrect the superseded favorite");
  assertEqual(reloaded.isFavorite(STORM), true, "…and kept the adopted one");
});

// =========================================================================
// 19. A mutation cascading in DURING the drain cannot split from its fact
// =========================================================================

await test("19. a mutation issued from inside the drain itself is not lost or misfiled", async () => {
  installFakeIndexedDB();
  const { store, identity } = await makeStore();

  const source = store.getProfileId();
  const beast = await store.createProfile("BEAST");

  // Forces the exact interleaving #drainPendingWrites exists to survive: a
  // SECOND mutation is issued synchronously from inside the callback that is
  // resolving the FIRST mutation's fact — i.e. while switchProfile's drain is
  // still awaiting the (about-to-be-replaced) #factQueue reference. A
  // fixed-count drain can exit before catching a chain like this; a
  // counter-driven one cannot, because #pendingFacts is incremented
  // synchronously the instant the second mutation is issued, before the first
  // pass's await resolves.
  const realTick = identity.tick.bind(identity);
  let cascaded = false;
  identity.tick = (...args) => {
    if (!cascaded) {
      cascaded = true;
      store.setHidden(STORM, true); // the cascading second mutation
    }
    return realTick(...args);
  };

  store.setFavorite(SUNRISE, true); // the first mutation; its drain triggers the cascade
  await store.switchProfile(beast.id);

  // No settle before this read: switchProfile must not resolve until BOTH
  // facts are fully persisted on the profile that was active when each was
  // issued.
  const row = await loadProfileData(source);
  assertEqual(
    row.facts && factsOf(row.facts, SUNRISE).favorite.v.on,
    true,
    "the first (triggering) mutation's fact was persisted before the switch resolved"
  );
  assertEqual(
    row.facts && factsOf(row.facts, STORM).hidden.v,
    true,
    "the CASCADED mutation's fact was also persisted — the drain caught the chain, not just the trigger"
  );
  assertEqual(row.items[SUNRISE].favorite, true, "…with its value in the same row");
  assertEqual(row.items[STORM].hidden, true, "…and the cascaded value too");

  await quiesce(store);
  assertEqual(store.getProfileId(), beast.id, "the switch completed");
  assertEqual(store.getFacts().items[SUNRISE], undefined, "BEAST received neither the trigger fact...");
  assertEqual(store.getFacts().items[STORM], undefined, "...nor the cascaded one");
});

// =========================================================================
// 20. importJSON (merge mode) — absent fields are no opinion
// =========================================================================

await test("20. a merge-mode import stamps only the fields it actually changes", async () => {
  installFakeIndexedDB();
  const { store } = await makeStore();

  store.setFavorite(SUNRISE, true);
  store.setHidden(RAIN, true);
  await quiesce(store);
  const before = store.getFacts();

  store.importJSON({
    schemaVersion: 2,
    kind: "gallery-profile",
    items: {
      // SUNRISE: favorite omitted entirely — merge mode field-merges, so this
      // must NOT touch the existing favorite. hidden IS present and true.
      [SUNRISE]: { hidden: true },
      // A brand-new item.
      [STORM]: { favorite: true, favoritedAt: 1700000000000 },
    },
    tags: [{ id: "tag-imported", name: "IMPORTED" }],
  });
  await quiesce(store);

  assertEqual(store.isFavorite(SUNRISE), true, "the pre-existing favorite survived the import untouched");
  assertEqual(store.isHidden(SUNRISE), true, "…and the imported field was applied");
  assertEqual(store.isFavorite(STORM), true, "the new item's favorite was applied");

  const facts = store.getFacts();
  assertEqual(
    factsOf(facts, SUNRISE).favorite.t,
    factsOf(before, SUNRISE).favorite.t,
    "SUNRISE's favorite fact was NOT re-stamped — the import had no opinion on it"
  );
  assertEqual(factsOf(facts, SUNRISE).hidden.v, true, "SUNRISE's hidden change WAS stamped");
  assertEqual(factsOf(facts, STORM).favorite.v.on, true, "STORM's new favorite was stamped");
  assertEqual(factsOf(facts, STORM).favorite.v.at, 1700000000000, "…with the imported favoritedAt");
  assertEqual(facts.tags["tag-imported"].name.v, "IMPORTED", "the new tag was stamped");
  assertEqual(factsOf(facts, RAIN).hidden.v, true, "RAIN, untouched by the import, kept its own fact unchanged");

  // Importing the SAME data again must be a true no-op: nothing re-stamped.
  const afterFirstImport = store.getFacts();
  store.importJSON({
    schemaVersion: 2,
    kind: "gallery-profile",
    items: { [SUNRISE]: { hidden: true }, [STORM]: { favorite: true, favoritedAt: 1700000000000 } },
    tags: [{ id: "tag-imported", name: "IMPORTED" }],
  });
  await quiesce(store);
  assertDeepEqual(store.getFacts(), afterFirstImport, "re-importing identical data stamped nothing new");
});

// =========================================================================
// 21. importJSON (replace mode) — the diff produces real negative facts
// =========================================================================

await test("21. a replace-mode import stamps negative facts for everything it removes", async () => {
  installFakeIndexedDB();
  const { store } = await makeStore();

  const keep = store.createTag("KEEP");
  const gone = store.createTag("GONE");
  store.setFavorite(SUNRISE, true);
  store.setHidden(RAIN, true);
  store.setItemTag(SUNRISE, keep.id, true);
  store.setItemTag(SUNRISE, gone.id, true);
  store.setItemTag(RAIN, gone.id, true);
  await quiesce(store);

  // The imported file is the user's explicit desired state: SUNRISE keeps only
  // the KEEP tag (favorite dropped, GONE dropped); RAIN is not mentioned at
  // all (everything about it removed); the GONE tag itself is not in the file.
  store.importJSON(
    {
      schemaVersion: 2,
      kind: "gallery-profile",
      items: { [SUNRISE]: { tags: [keep.id] } },
      tags: [{ id: keep.id, name: "KEEP" }],
    },
    { mode: "replace" }
  );
  await quiesce(store);

  // ---- resulting local state ----
  assertEqual(store.isFavorite(SUNRISE), false, "the dropped favorite is gone locally");
  assertEqual(store.hasItemTag(SUNRISE, gone.id), false, "the dropped tag assignment is gone locally");
  assertDeepEqual(store.getItemTags(SUNRISE), [keep.id], "…leaving only what the import specified");
  assertEqual(store.isHidden(RAIN), false, "the unmentioned item's hidden flag is gone");
  assertDeepEqual(store.getTags().map((t) => t.id), [keep.id], "the dropped tag is gone from the vocabulary");

  // ---- the facts required by the approved policy ----
  const facts = store.getFacts();
  assertEqual(factsOf(facts, SUNRISE).favorite.v.on, false, "removed favorite => favorite=false fact");
  assertEqual(factsOf(facts, RAIN).hidden.v, false, "removed hidden => hidden=false fact");
  assertEqual(factsOf(facts, SUNRISE).tags[gone.id].v, false, "removed media/tag relation => assignment=false fact");
  assertEqual(factsOf(facts, RAIN).tags[gone.id].v, false, "…on every item that had it");
  assertEqual(facts.tags[gone.id].deleted.v, true, "removed tag => tag tombstone");
  assertEqual(facts.tags[gone.id].name.v, "GONE", "…with its name preserved for a future restore");
  assertEqual(factsOf(facts, SUNRISE).tags[keep.id].v, true, "the kept assignment is a positive fact");

  // ---- and it survives a reload ----
  const { store: reloaded } = await makeStore();
  await quiesce(reloaded);
  assertEqual(reloaded.isFavorite(SUNRISE), false, "the removal survived a reload");
  assertDeepEqual(reloaded.getItemTags(SUNRISE), [keep.id], "…and the kept assignment did too");
});

// =========================================================================

console.log(`\n${"-".repeat(60)}`);
console.log(`${passes} assertion(s) passed, ${failures} failure(s)`);
if (failures) {
  console.log("\nFailures:");
  for (const detail of failureDetail) console.log(`  - ${detail}`);
}
// Debounced clock-floor writes may still be pending; nothing further is
// asserted, so exit deterministically rather than waiting them out.
process.exit(failures ? 1 : 0);
