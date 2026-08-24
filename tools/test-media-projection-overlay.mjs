#!/usr/bin/env node
// [MEDIA-ID / STAGE-02 / LOCAL-PROJECTION]
// [WHY: ProfileStore#setFavorite updates the local record, calls #emit()
//  SYNCHRONOUSLY, and only then queues #recordFact — which applies the mutation
//  to the stamped facts in a later microtask and does NOT emit when it lands.
//  A projection resolved purely from stamped facts therefore renders the
//  PRE-CLICK value during that emit and keeps rendering it until something
//  unrelated happens to emit again. Not a one-frame flicker: an indefinitely
//  stuck value, on the user's own click.
//
//  These tests capture values INSIDE that synchronous emit, which is the only
//  place the defect is observable. Asserting after the call returns would pass
//  against a broken implementation.]
//
// Usage:  node tools/test-media-projection-overlay.mjs

import { pathToFileURL } from "node:url";
import path from "node:path";
import { installFakeIndexedDB, settle } from "./lib/browser-test-env.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const src = (rel) => pathToFileURL(path.join(ROOT, "src", rel)).href;

const fakeDb = installFakeIndexedDB();

const { setSnapshotFreezeEnabled } = await import(src("profile/profile-snapshot.js"));
setSnapshotFreezeEnabled(true);

const { ProfileStore, setFactCheckEnabled } = await import(src("profile/profile-store.js"));
const { SyncIdentity } = await import(src("profile/sync-device.js"));
const { createProfileProjectionView } = await import(src("profile/profile-projection-view.js"));
setFactCheckEnabled(true);

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

function assertDeep(actual, expected, label) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  return assert(a === b, label, a === b ? null : `expected: ${b}\n        actual:   ${a}`);
}

async function test(name, fn) {
  console.log(`\n${name}`);
  // Each test builds its own ProfileStore; without resetting storage they all
  // share one persisted Profile and earlier tests' tag assignments bleed into
  // later ones.
  fakeDb.reset();
  try {
    await fn();
  } catch (error) {
    failures++;
    failureDetail.push(`${name} - threw: ${error && error.stack}`);
    console.log(`  FAIL  threw: ${error && error.message}`);
    console.log(String(error && error.stack).split("\n").slice(1, 4).join("\n"));
  }
}

// ---- Fixture ---------------------------------------------------------------

const VIEWED = "cat.jpg";
const ALIAS = "Animals/Cats/cat.jpg";

/**
 * A store plus a view whose alias index maps the viewed path to a proven alias.
 * The alias holds curation; the viewed path starts with none, which is exactly
 * the MASTER-curated / child-viewed headline case.
 */
const liveIdentities = [];

async function makeFixture({ profileId = null } = {}) {
  const identity = new SyncIdentity({});
  liveIdentities.push(identity);
  const store = new ProfileStore({ identity });
  await settle();
  await store.whenFactsSettled();
  await settle();

  const view = createProfileProjectionView({ profile: store });
  const setIndex = () =>
    view.setAliasIndex({
      scopeId: "scope-1",
      rootId: "root-1",
      profileId: profileId || store.getProfileId(),
      prefixFromScopeRoot: "Animals/Cats/",
      aliases: new Map([[VIEWED, [VIEWED, ALIAS]]]),
      diagnostics: {},
    });
  setIndex();
  return { store, view, identity, setIndex };
}

async function quiesce(store) {
  await store.whenFactsSettled();
  await settle();
  await store.whenFactsSettled();
}

/** Runs `fn` once, from inside the very first synchronous emit it triggers. */
function captureDuringEmit(store, capture) {
  let captured = null;
  let seen = 0;
  const off = store.subscribe(() => {
    seen += 1;
    if (seen === 1) captured = capture();
  });
  return {
    stop() {
      off();
      return { captured, emits: seen };
    },
  };
}

// ---- 27: immediate Favorite ------------------------------------------------

await test("27 — Favorite is visible synchronously, inside ProfileStore's own emit", async () => {
  const { store, view } = await makeFixture();

  const probe = captureDuringEmit(store, () => view.isFavorite(VIEWED));
  view.setFavorite(VIEWED, true);
  const { captured, emits } = probe.stop();

  assertEqual(captured, true, "the projected Favorite is already true DURING the emit");
  assertEqual(emits >= 1, true, "ProfileStore emitted synchronously");
  assertEqual(view.isFavorite(VIEWED), true, "and immediately after the call");

  await quiesce(store);
  assertEqual(view.isFavorite(VIEWED), true, "and still after the fact settles");
});

// ---- 28: immediate un-Favorite of a PROJECTED Favorite ---------------------

await test("28 — un-Favoriting a PROJECTED Favorite sticks, synchronously and after settle", async () => {
  const { store, view } = await makeFixture();

  // Curate the ALIAS path, never the viewed one. This is the case that breaks
  // without the overlay: the viewed path has no fact of its own, so resolution
  // would keep returning the alias's `true` until something else emitted.
  store.setFavorite(ALIAS, true);
  await quiesce(store);
  assertEqual(view.isFavorite(VIEWED), true, "the alias's Favorite projects onto the viewed path");

  const probe = captureDuringEmit(store, () => view.isFavorite(VIEWED));
  view.toggleFavorite(VIEWED);
  const { captured } = probe.stop();

  assertEqual(captured, false, "the heart un-fills DURING the emit, not one render later");
  assertEqual(view.isFavorite(VIEWED), false, "still false after the call");

  await quiesce(store);
  assertEqual(view.isFavorite(VIEWED), false, "still false once the real fact lands — no snap-back");
  assertEqual(store.isFavorite(ALIAS), true, "and the ALIAS's own fact was never rewritten");
});

// ---- 11 / 12: writes stay on the viewed path -------------------------------

await test("11 — a projected toggle writes ONLY to the viewed path", async () => {
  const { store, view } = await makeFixture();
  store.setFavorite(ALIAS, true);
  await quiesce(store);

  view.toggleFavorite(VIEWED);
  await quiesce(store);

  assertEqual(store.isFavorite(VIEWED), false, "the viewed path received the write");
  assertEqual(store.isFavorite(ALIAS), true, "the alias path is untouched — no redirection, no fan-out");

  const facts = store.getItemFactsForPaths([VIEWED, ALIAS]);
  assertEqual(Boolean(facts[VIEWED] && facts[VIEWED].favorite), true, "a fact exists on the viewed path");
  assertEqual(facts[ALIAS].favorite.v.on, true, "the alias's fact still says true — never restamped");
});

// ---- 29 / 30: generation safety --------------------------------------------

await test("29 — rapid Favorite -> un-Favorite -> Favorite converges on the last click", async () => {
  const { store, view } = await makeFixture();

  view.setFavorite(VIEWED, true);
  assertEqual(view.isFavorite(VIEWED), true, "after click 1");
  view.setFavorite(VIEWED, false);
  assertEqual(view.isFavorite(VIEWED), false, "after click 2");
  view.setFavorite(VIEWED, true);
  assertEqual(view.isFavorite(VIEWED), true, "after click 3");

  assertEqual(view.stats().pendingPaths, 1, "one path is pending, not three");

  await quiesce(store);
  assertEqual(view.isFavorite(VIEWED), true, "the last click is what survives");
  assertEqual(view.stats().pendingPaths, 0, "every override is cleared once its own fact lands");
});

await test("30 — a stale settle callback cannot erase a newer override", async () => {
  const { store, view } = await makeFixture();
  store.setFavorite(ALIAS, true);
  await quiesce(store);

  // Hold the settle callbacks so click #1's can be released AFTER click #2 has
  // already replaced the override — the exact interleaving a fast double-click
  // produces.
  const held = [];
  const realWhenFactsSettled = store.whenFactsSettled.bind(store);
  store.whenFactsSettled = () =>
    new Promise((resolve) => {
      held.push(() => realWhenFactsSettled().then(resolve));
    });

  view.setFavorite(VIEWED, false); // click 1
  view.setFavorite(VIEWED, true); // click 2 — replaces the override
  assertEqual(held.length, 2, "both clicks registered a settle callback");

  // Release click 1's callback first. Under a naive unconditional clear, it
  // would drop click 2's override and the projection would snap back.
  held[0]();
  await settle(5);
  assertEqual(view.isFavorite(VIEWED), true, "click 2's override survives click 1's settle");
  assertEqual(view.stats().pendingPaths, 1, "the newer override is still held");

  held[1]();
  await settle(5);
  store.whenFactsSettled = realWhenFactsSettled;
  await quiesce(store);
  assertEqual(view.isFavorite(VIEWED), true, "and the settled answer agrees");
});

// ---- 31 / 32: Hidden and per-tag -------------------------------------------

await test("31 — Hidden toggles synchronously and clears on settle", async () => {
  const { store, view } = await makeFixture();
  store.setHidden(ALIAS, true);
  await quiesce(store);
  assertEqual(view.isHidden(VIEWED), true, "the alias's Hidden projects");

  const probe = captureDuringEmit(store, () => view.isHidden(VIEWED));
  view.toggleHidden(VIEWED);
  assertEqual(probe.stop().captured, false, "un-hidden DURING the emit");

  await quiesce(store);
  assertEqual(view.isHidden(VIEWED), false, "and after settle");
  assertEqual(store.isHidden(ALIAS), true, "the alias's fact is untouched");
});

await test("32 — a tag override touches only its own tag id", async () => {
  const { store, view } = await makeFixture();
  const red = store.createTag(`Red-${Date.now()}-${Math.random()}`);
  const blue = store.createTag(`Blue-${Date.now()}-${Math.random()}`);
  store.setItemTag(ALIAS, red.id, true);
  store.setItemTag(ALIAS, blue.id, true);
  await quiesce(store);
  assertDeep(view.getItemTags(VIEWED).sort(), [red.id, blue.id].sort(), "both alias tags project");

  const probe = captureDuringEmit(store, () => view.getItemTags(VIEWED));
  view.toggleItemTag(VIEWED, red.id);
  const captured = probe.stop().captured;

  assertDeep(captured, [blue.id], "red is off DURING the emit and blue is unaffected");
  await quiesce(store);
  assertDeep(view.getItemTags(VIEWED), [blue.id], "and after settle");
  assertEqual(store.hasItemTag(ALIAS, red.id), true, "the alias's own assignment is untouched");
});

// ---- 33: external updates create no override -------------------------------

await test("33 — a cross-tab/external fact update creates NO pending override", async () => {
  const { store, view } = await makeFixture();
  assertEqual(view.stats().pendingPaths, 0, "clean to start");

  // The path a peer's change actually takes: refreshFromStorage -> #adoptFacts
  // -> #applyFactsToLocal -> #emit. Nothing routes through the facade's writers,
  // so nothing can create an override. Simulated here by driving ProfileStore
  // directly, which is what that path ultimately does.
  store.setFavorite(ALIAS, true);
  store.setHidden(ALIAS, true);
  await quiesce(store);
  await store.refreshFromStorage();
  await settle(5);

  assertEqual(view.stats().pendingPaths, 0, "no override was invented from an external change");
  assertEqual(view.isFavorite(VIEWED), true, "the external change still projects correctly");
});

// ---- 34: epoch invalidation ------------------------------------------------

await test("34 — beginEpoch drops every override (load / Profile switch)", async () => {
  const { store, view } = await makeFixture();
  store.setFavorite(ALIAS, true);
  await quiesce(store);

  const realWhenFactsSettled = store.whenFactsSettled.bind(store);
  const held = [];
  store.whenFactsSettled = () => new Promise((resolve) => held.push(resolve));

  view.setFavorite(VIEWED, false);
  assertEqual(view.stats().pendingPaths, 1, "an override is held");

  view.beginEpoch();
  assertEqual(view.stats().pendingPaths, 0, "the epoch bump dropped it");

  // The stale callback must be inert rather than corrupting the new epoch.
  held.forEach((resolve) => resolve());
  await settle(5);
  store.whenFactsSettled = realWhenFactsSettled;
  await quiesce(store);
  assertEqual(view.stats().pendingPaths, 0, "a stale settle in a new epoch changes nothing");
  // The write itself was real and is still the newest fact on the viewed path,
  // so the projection now resolves to it FROM THE FACTS rather than from an
  // override — which is the point: dropping an override never loses a write.
  assertEqual(view.isFavorite(VIEWED), false, "the projection resolves from the stamped facts alone");
  assertEqual(store.isFavorite(ALIAS), true, "and the alias's own fact is untouched");
});

// ---- 35 / 37: favoritedAt is never invented ---------------------------------

await test("37 — favoritedAt DURING the emit is exactly ProfileStore's own value", async () => {
  const { store, view } = await makeFixture();

  // [WHY THE STUBBED CLOCK: with a provisional Date.now() in the overlay there
  //  would be TWO reads of the clock for one click — ProfileStore's and the
  //  facade's. Advancing the stub on every call makes them provably different,
  //  so this assertion fails deterministically under that sabotage instead of
  //  passing by luck on a fast machine.]
  const realNow = Date.now;
  let tick = 1_700_000_000_000;
  Date.now = () => (tick += 1000);

  let captured = null;
  const off = store.subscribe(() => {
    if (captured === null) {
      captured = { projected: view.getFavoritedAt(VIEWED), store: store.getFavoritedAt(VIEWED) };
    }
  });

  view.setFavorite(VIEWED, true);
  off();
  Date.now = realNow;

  assert(captured !== null, "the emit was observed");
  assertEqual(
    captured.projected,
    captured.store,
    "the first render's favoritedAt IS ProfileStore's value — no provisional timestamp"
  );
  assert(Number.isFinite(captured.projected), "and it is a real timestamp");

  await quiesce(store);
  const facts = store.getItemFactsForPaths([VIEWED]);
  assertEqual(facts[VIEWED].favorite.v.at, captured.projected, "the settled FACT carries that same instant");
});

await test("35 — un-Favoriting projects a null favoritedAt", async () => {
  const { store, view } = await makeFixture();
  store.setFavorite(ALIAS, true);
  await quiesce(store);
  assert(Number.isFinite(view.getFavoritedAt(VIEWED)), "projected favoritedAt starts as a real value");

  view.setFavorite(VIEWED, false);
  assertEqual(view.getFavoritedAt(VIEWED), null, "an un-favourite reports no timestamp, synchronously");
  await quiesce(store);
  assertEqual(view.getFavoritedAt(VIEWED), null, "and after settle");
});

// ---- 36: one render per click ----------------------------------------------

await test("36 — a single click produces one visible render, not a corrective second one", async () => {
  const { store, view } = await makeFixture();
  store.setFavorite(ALIAS, true);
  await quiesce(store);

  let renders = 0;
  const off = view.subscribe(() => {
    renders += 1;
  });

  view.setFavorite(VIEWED, false);
  assertEqual(renders, 1, "the click renders once");

  await quiesce(store);
  assertEqual(renders, 1, "settling the fact adds no corrective render — the value never changed");
  off();
});

// ---- 12: Profile isolation --------------------------------------------------

await test("12 — an index built for another Profile never answers a read", async () => {
  const { store, view } = await makeFixture({ profileId: "some-other-profile" });
  store.setFavorite(ALIAS, true);
  await quiesce(store);

  assertEqual(
    view.isFavorite(VIEWED),
    false,
    "the alias's Favorite does NOT leak: the index's profileId does not match the active Profile"
  );
  assertEqual(store.isFavorite(ALIAS), true, "the fact itself is untouched and still readable directly");
});

// ---- BP-FAIL-03: negative facts must be DISCOVERABLE ------------------------
//
// [WHY: ProfileStore#setRecord deletes a record that isEmptyRecord() considers
//  empty, and {favorite:false} / {hidden:false} / {tags:[]} all are. So a path
//  carrying only a REMOVAL has no local record and never appears in
//  knownPaths() — while its stamped fact is precisely what must beat the older
//  positive value on a proven alias. Driving discovery off knownPaths() made
//  projection one-way: MASTER -> child worked, child -> MASTER silently did not,
//  even across a full reload. These tests pin the invariant that projection is
//  BIDIRECTIONAL: path is an address, media identity owns the curation truth.]

await test("BP-FAIL-03 — a negative-only path has NO local record but DOES have a stamped fact", async () => {
  const { store } = await makeFixture();
  store.setFavorite(ALIAS, true);
  await quiesce(store);

  const sizeBefore = store.size();
  const factPathsBefore = store.getFactPaths().length;
  store.setFavorite(VIEWED, false);
  await quiesce(store);

  assertEqual(store.knownPaths().includes(VIEWED), false, "knownPaths() cannot see the removal — the record was discarded");
  assertEqual(store.size(), sizeBefore, "and the record COUNT did not change either, so a size-gated rebuild would never fire");
  assertEqual(store.getFactPaths().includes(VIEWED), true, "getFactPaths() DOES see it");

  // [MEDIA-ID / STAGE-02 / BP-FAIL-03] The exact signal main.js's rebuild gate
  // now uses. size() is blind to this transition; the stamped fact-key count is
  // not — and because sync-facts.js has no remove-a-key operation, that count is
  // append-only within a Profile, so a change means new keys.
  assertEqual(
    store.getFactPaths().length,
    factPathsBefore + 1,
    "the stamped fact-key COUNT does change — the only signal that can trigger the rebuild"
  );

  const facts = store.getItemFactsForPaths([VIEWED]);
  assertEqual(facts[VIEWED].favorite.v.on, false, "the stamped fact says un-favourited");
  assert(Number.isFinite(facts[VIEWED].favorite.t), "and carries a real stamp");
});

await test("BP-FAIL-03 — Favorite=false on the child wins on MASTER (the exact browser case)", async () => {
  const { store, view } = await makeFixture();

  // MASTER: favorite=true @ older.   CHILD: favorite=false @ newer.
  store.setFavorite(ALIAS, true);
  await quiesce(store);
  store.setFavorite(VIEWED, false);
  await quiesce(store);

  // Now VIEW FROM MASTER: the alias list is built from the discovery source.
  const discovered = new Set([...store.getFactPaths(), ...store.knownPaths()]);
  assertEqual(discovered.has(VIEWED), true, "the child path is discovered as a candidate");

  view.setAliasIndex({
    scopeId: "s",
    rootId: "master",
    profileId: store.getProfileId(),
    prefixFromScopeRoot: "",
    rootPrefixes: ["", "Staging area/Mackenzie/"],
    aliases: new Map([[ALIAS, [ALIAS, VIEWED]]]),
    diagnostics: {},
  });

  assertEqual(view.isFavorite(ALIAS), false, "MASTER shows un-favourited — the newer child removal wins");
  assertEqual(view.getFavoritedAt(ALIAS), null, "and reports no favourited-at");
  assertEqual(store.isFavorite(ALIAS), true, "while the MASTER fact itself is untouched — nothing was rewritten");
});

await test("BP-FAIL-03 — Tag=false on the child wins on MASTER", async () => {
  const { store, view } = await makeFixture();
  const tag = store.createTag(`Keep-${Date.now()}-${Math.random()}`);

  store.setItemTag(ALIAS, tag.id, true);
  await quiesce(store);
  // The facade's priming write, then the removal (see setItemTag's WHY).
  store.setItemTag(VIEWED, tag.id, true);
  store.setItemTag(VIEWED, tag.id, false);
  await quiesce(store);

  assertEqual(store.knownPaths().includes(VIEWED), false, "the child path has no local record");
  assertEqual(store.getFactPaths().includes(VIEWED), true, "but it does have stamped facts");

  view.setAliasIndex({
    scopeId: "s",
    rootId: "master",
    profileId: store.getProfileId(),
    prefixFromScopeRoot: "",
    rootPrefixes: ["", "Staging area/Mackenzie/"],
    aliases: new Map([[ALIAS, [ALIAS, VIEWED]]]),
    diagnostics: {},
  });

  assertDeep(view.getItemTags(ALIAS), [], "MASTER no longer shows the tag — the newer child removal wins");
  assertEqual(store.hasItemTag(ALIAS, tag.id), true, "while the MASTER assignment itself is untouched");
});

await test("BP-FAIL-03 — Hidden=false on the child wins on MASTER", async () => {
  const { store, view } = await makeFixture();

  store.setHidden(ALIAS, true);
  await quiesce(store);
  store.setHidden(VIEWED, false);
  await quiesce(store);

  assertEqual(store.knownPaths().includes(VIEWED), false, "a hidden=false record is empty and is discarded too");
  assertEqual(store.getFactPaths().includes(VIEWED), true, "the stamped un-hide survives");

  view.setAliasIndex({
    scopeId: "s",
    rootId: "master",
    profileId: store.getProfileId(),
    prefixFromScopeRoot: "",
    rootPrefixes: ["", "Staging area/Mackenzie/"],
    aliases: new Map([[ALIAS, [ALIAS, VIEWED]]]),
    diagnostics: {},
  });

  assertEqual(view.isHidden(ALIAS), false, "MASTER shows un-hidden");
  assertEqual(store.isHidden(ALIAS), true, "while the MASTER fact is untouched");
});

await test("BP-FAIL-03 — the invariant, both directions, all three fields", async () => {
  const { store, view } = await makeFixture();
  const tag = store.createTag(`Both-${Date.now()}-${Math.random()}`);

  const masterIndex = {
    scopeId: "s",
    rootId: "master",
    profileId: store.getProfileId(),
    prefixFromScopeRoot: "",
    rootPrefixes: ["", "Staging area/Mackenzie/"],
    aliases: new Map([[ALIAS, [ALIAS, VIEWED]]]),
    diagnostics: {},
  };
  const childIndex = {
    ...masterIndex,
    rootId: "child",
    prefixFromScopeRoot: "Staging area/Mackenzie/",
    aliases: new Map([[VIEWED, [VIEWED, ALIAS]]]),
  };

  // MASTER -> CHILD, positive.
  store.setFavorite(ALIAS, true);
  store.setHidden(ALIAS, true);
  store.setItemTag(ALIAS, tag.id, true);
  await quiesce(store);
  view.setAliasIndex(childIndex);
  assertEqual(view.isFavorite(VIEWED), true, "MASTER->CHILD favorite=true");
  assertEqual(view.isHidden(VIEWED), true, "MASTER->CHILD hidden=true");
  assertDeep(view.getItemTags(VIEWED), [tag.id], "MASTER->CHILD tag=true");

  // CHILD -> MASTER, negative. Written THROUGH the facade, so this also covers
  // the tag priming write and the pending overlay.
  view.setFavorite(VIEWED, false);
  view.setHidden(VIEWED, false);
  view.setItemTag(VIEWED, tag.id, false);
  await quiesce(store);

  view.setAliasIndex(masterIndex);
  assertEqual(view.isFavorite(ALIAS), false, "CHILD->MASTER favorite=false");
  assertEqual(view.isHidden(ALIAS), false, "CHILD->MASTER hidden=false");
  assertDeep(view.getItemTags(ALIAS), [], "CHILD->MASTER tag=false");

  // CHILD -> MASTER, positive again, to prove it is not a one-way latch.
  view.setAliasIndex(childIndex);
  view.setFavorite(VIEWED, true);
  view.setItemTag(VIEWED, tag.id, true);
  await quiesce(store);
  view.setAliasIndex(masterIndex);
  assertEqual(view.isFavorite(ALIAS), true, "CHILD->MASTER favorite=true");
  assertDeep(view.getItemTags(ALIAS), [tag.id], "CHILD->MASTER tag=true");
});

// ---- 18: reversibility ------------------------------------------------------

await test("18 — with no alias index every read is exactly ProfileStore's answer", async () => {
  const { store, view } = await makeFixture();
  const tag = store.createTag(`Red-${Date.now()}-${Math.random()}`);
  store.setFavorite(ALIAS, true);
  store.setHidden(ALIAS, true);
  store.setItemTag(ALIAS, tag.id, true);
  await quiesce(store);

  // Deleting the MEDIA-ID database presents here as: no index.
  view.setAliasIndex(null);

  for (const path of [VIEWED, ALIAS]) {
    assertEqual(view.isFavorite(path), store.isFavorite(path), `isFavorite matches for ${path}`);
    assertEqual(view.getFavoritedAt(path), store.getFavoritedAt(path), `getFavoritedAt matches for ${path}`);
    assertEqual(view.isHidden(path), store.isHidden(path), `isHidden matches for ${path}`);
    assertDeep(view.getItemTags(path), store.getItemTags(path), `getItemTags matches for ${path}`);
  }
  assertEqual(view.isFavorite(VIEWED), false, "and the viewed path is back to path-exact behaviour");
});

// SyncIdentity debounces its clock-floor write on a timer; flushing keeps the
// process from being held open by bookkeeping the tests do not care about.
for (const identity of liveIdentities) await identity.flush();

console.log(`\n${"-".repeat(60)}`);
if (failures) {
  console.log(`FAIL  ${failures} assertion(s) failed, ${passes} passed.`);
  for (const detail of failureDetail) console.log(`  - ${detail}`);
  process.exit(1);
}
console.log(`ok    ${passes} assertion(s) passed - the pending-write overlay holds.`);
// Two tests deliberately leave a stubbed whenFactsSettled() promise chain in
// flight to reproduce a stale settle callback; that keeps the loop alive. The
// suite's verdict is complete at this point, so exit on it explicitly.
process.exit(0);
