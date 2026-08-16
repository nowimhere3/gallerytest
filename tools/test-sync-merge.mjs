#!/usr/bin/env node
// [PHASE-6-SYNC-V2]
// [STAGE-C-MERGE-SEMANTICS]
// [WHY: every synchronized fact must merge deterministically and survive
//  concurrent writers — and "deterministically" is a claim about ALL possible
//  orderings, not about the two or three a human happens to try by hand. The
//  merge engine is pure precisely so this can be proven by exhausting
//  permutations and replaying seeded random histories, which is the only form
//  of evidence that actually supports section 20's convergence requirement.]
//
// Usage:  node tools/test-sync-merge.mjs
// Exits non-zero on any failure, matching tools/check-dom-contract.js.
//
// FUTURE: add new capability as a new numbered test; never weaken an existing
// assertion to make a stage pass.

import { pathToFileURL } from "node:url";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const src = (rel) => pathToFileURL(path.join(ROOT, "src", rel)).href;

const { compareStamps, HybridClock, mergeFact, mergeReplicas, mergeAll, stableStringify, forEachFact } =
  await import(src("profile/sync-merge.js"));
const F = await import(src("profile/sync-facts.js"));

// ---- Runner --------------------------------------------------------------

let passes = 0;
let failures = 0;
const failed = [];

function assert(condition, label, detail) {
  if (condition) {
    passes++;
    return true;
  }
  failures++;
  failed.push(label);
  console.log(`  FAIL  ${label}`);
  if (detail) console.log(`        ${detail}`);
  return false;
}

function assertEqual(actual, expected, label) {
  return assert(actual === expected, label, actual === expected ? null : `expected: ${expected}\n        actual:   ${actual}`);
}

function assertSame(a, b, label) {
  const sa = stableStringify(a);
  const sb = stableStringify(b);
  return assert(sa === sb, label, sa === sb ? null : `A: ${sa.slice(0, 240)}\n        B: ${sb.slice(0, 240)}`);
}

async function test(name, fn) {
  console.log(`\n${name}`);
  try {
    await fn();
  } catch (error) {
    failures++;
    failed.push(`${name} (threw)`);
    console.log(`  FAIL  threw: ${error && error.message}`);
    console.log(String(error && error.stack).split("\n").slice(1, 4).join("\n"));
  }
}

// ---- Fixtures ------------------------------------------------------------

/** A virtual device: its own clock, reading a wall clock the test controls. */
function device(id, wall = { ms: 1_000_000 }) {
  const clock = new HybridClock(id, { now: () => wall.ms });
  return { id, clock, wall, stamp: () => clock.tick() };
}

const BEAST = "profile-beast";
const BBG4 = "profile-bbg4";

function factCount(replica) {
  let n = 0;
  forEachFact(replica, () => n++);
  return n;
}

/** Deterministic PRNG (mulberry32) so property runs are reproducible. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function permutations(list) {
  if (list.length <= 1) return [list];
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const rest = [...list.slice(0, i), ...list.slice(i + 1)];
    for (const p of permutations(rest)) out.push([list[i], ...p]);
  }
  return out;
}

// =========================================================================

await test("1. stamp comparison is a deterministic total order", async () => {
  assert(compareStamps({ t: 1, d: "a" }, { t: 2, d: "a" }) < 0, "lower t precedes");
  assert(compareStamps({ t: 2, d: "a" }, { t: 1, d: "z" }) > 0, "t dominates deviceId");
  assert(compareStamps({ t: 5, d: "a" }, { t: 5, d: "b" }) < 0, "equal t falls back to deviceId");
  assertEqual(compareStamps({ t: 5, d: "a" }, { t: 5, d: "a" }), 0, "identical stamps compare equal");

  // Antisymmetry and transitivity across a spread of stamps.
  const stamps = [
    { t: 1, d: "b" }, { t: 1, d: "a" }, { t: 3, d: "c" }, { t: 2, d: "z" }, { t: 3, d: "a" },
  ];
  let antisymmetric = true;
  for (const x of stamps) {
    for (const y of stamps) {
      if (Math.sign(compareStamps(x, y)) !== -Math.sign(compareStamps(y, x))) antisymmetric = false;
    }
  }
  assert(antisymmetric, "compare(x,y) === -compare(y,x) for all pairs");

  const sorted = [...stamps].sort(compareStamps);
  let transitive = true;
  for (let i = 0; i + 2 < sorted.length; i++) {
    if (!(compareStamps(sorted[i], sorted[i + 1]) < 0 && compareStamps(sorted[i + 1], sorted[i + 2]) < 0)) continue;
    if (!(compareStamps(sorted[i], sorted[i + 2]) < 0)) transitive = false;
  }
  assert(transitive, "ordering is transitive");
});

await test("2. hybrid clock is monotonic under a frozen and a rewound wall clock", async () => {
  const wall = { ms: 5_000 };
  const a = device("device-a", wall);

  const s1 = a.stamp();
  const s2 = a.stamp();
  const s3 = a.stamp();
  assert(s1.t < s2.t && s2.t < s3.t, "strictly increasing even with the wall clock frozen");

  wall.ms = 1_000; // clock jumps an hour backwards
  const s4 = a.stamp();
  assert(s4.t > s3.t, "a backwards wall-clock jump cannot produce an older stamp");

  // Observing a peer far in the future self-corrects within one exchange.
  a.clock.observe(9_999_999);
  const s5 = a.stamp();
  assert(s5.t > 9_999_999, "after observing a future peer stamp, the next stamp beats it");

  // A device that has seen a peer's replica outranks it on the next mutation.
  const b = device("device-b", { ms: 100 });
  let r = F.createTag(F.emptyReplica(), BEAST, "tag-1", "KEEP", { t: 50_000, d: "device-x" });
  b.clock.observeReplica(r);
  const next = b.stamp();
  assert(next.t > 50_000, "observeReplica raises the floor above every stamp present");
});

await test("3. favorite vs unfavorite — the same fact, newest wins, both directions", async () => {
  const wall = { ms: 1000 };
  const a = device("device-a", wall);
  const b = device("device-b", wall);
  const base = F.emptyReplica();

  const favored = F.setFavorite(base, BEAST, "N/X.mp4", true, a.stamp());
  wall.ms += 10;
  const unfavored = F.setFavorite(base, BEAST, "N/X.mp4", false, b.stamp());

  const ab = mergeReplicas(favored, unfavored);
  const ba = mergeReplicas(unfavored, favored);
  assertSame(ab, ba, "merge is order-independent");
  assertEqual(F.projectProfile(ab, BEAST).favorites.length, 0, "the newer un-favorite wins");

  // And the reverse ordering of the actions yields the opposite result.
  const wall2 = { ms: 1000 };
  const c = device("device-a", wall2);
  const d = device("device-b", wall2);
  const off = F.setFavorite(base, BEAST, "N/X.mp4", false, c.stamp());
  wall2.ms += 10;
  const on = F.setFavorite(base, BEAST, "N/X.mp4", true, d.stamp());
  const merged = mergeReplicas(off, on);
  assertEqual(F.projectProfile(merged, BEAST).favorites.length, 1, "a newer favorite wins over an older un-favorite");

  // Un-favorite is a real fact, not an absence.
  assert(ab.profiles[BEAST].items["N/X.mp4"].favorite.v.on === false, "un-favorite is stored explicitly as false");
});

await test("4. hide vs unhide propagates in both directions", async () => {
  const wall = { ms: 1000 };
  const a = device("device-a", wall);
  const b = device("device-b", wall);
  const base = F.setHidden(F.emptyReplica(), BEAST, "N/D.mp4", true, a.stamp());
  wall.ms += 5;
  const unhidden = F.setHidden(base, BEAST, "N/D.mp4", false, b.stamp());

  assertEqual(F.projectProfile(mergeReplicas(base, unhidden), BEAST).hidden.length, 0, "newer unhide wins");
  assertEqual(F.projectProfile(mergeReplicas(unhidden, base), BEAST).hidden.length, 0, "and in the other order");
  assert(unhidden.profiles[BEAST].items["N/D.mp4"].hidden.v === false, "unhide is stored explicitly as false");
});

await test("5. tag assign vs untag, and independent assignments never collide", async () => {
  const wall = { ms: 1000 };
  const a = device("device-a", wall);
  const b = device("device-b", wall);

  let base = F.createTag(F.emptyReplica(), BEAST, "tag-T", "T", a.stamp());
  base = F.setItemTag(base, BEAST, "N/X.mp4", "tag-T", true, a.stamp());

  // Contract Test E: A untags X while B tags Y. Different facts entirely.
  wall.ms += 5;
  const aSide = F.setItemTag(base, BEAST, "N/X.mp4", "tag-T", false, a.stamp());
  const bSide = F.setItemTag(base, BEAST, "N/Y.mp4", "tag-T", true, b.stamp());

  const merged = mergeReplicas(aSide, bSide);
  const view = F.projectProfile(merged, BEAST);
  assert(!view.itemTags["N/X.mp4"], "X remains untagged");
  assertSame(view.itemTags["N/Y.mp4"], ["tag-T"], "Y remains tagged");
  assertSame(merged, mergeReplicas(bSide, aSide), "order-independent");
  assert(merged.profiles[BEAST].items["N/X.mp4"].tags["tag-T"].v === false, "untag is stored explicitly as false");
});

await test("6. tag create, rename, delete, restore", async () => {
  const wall = { ms: 1000 };
  const a = device("device-a", wall);

  let r = F.createTag(F.emptyReplica(), BEAST, "tag-1", "HOT", a.stamp());
  assertSame(F.projectProfile(r, BEAST).tags, [{ id: "tag-1", name: "HOT" }], "created tag is visible");

  wall.ms += 5;
  r = F.renameTag(r, BEAST, "tag-1", "WARM", a.stamp());
  assertEqual(F.projectProfile(r, BEAST).tags[0].name, "WARM", "rename is visible");

  wall.ms += 5;
  r = F.deleteTag(r, BEAST, "tag-1", a.stamp());
  assertEqual(F.projectProfile(r, BEAST).tags.length, 0, "deleted tag disappears from the projection immediately");
  assert(r.profiles[BEAST].tags["tag-1"].deleted.v === true, "the tombstone itself remains as sync bookkeeping");

  wall.ms += 5;
  r = F.restoreTag(r, BEAST, "tag-1", a.stamp());
  assertEqual(F.projectProfile(r, BEAST).tags.length, 1, "restore brings it back");
  assertEqual(F.projectProfile(r, BEAST).tags[0].name, "WARM", "restore keeps the latest name");
});

await test("7. delete beats an older rename; a later restore beats the delete", async () => {
  const wall = { ms: 1000 };
  const a = device("device-a", wall);
  const b = device("device-b", wall);

  let base = F.createTag(F.emptyReplica(), BEAST, "tag-X", "X", a.stamp());
  base = F.setItemTag(base, BEAST, "N/M.mp4", "tag-X", true, a.stamp());

  wall.ms += 5;
  const renamed = F.renameTag(base, BEAST, "tag-X", "GOOD", a.stamp()); // older
  wall.ms += 5;
  const deleted = F.deleteTag(base, BEAST, "tag-X", b.stamp()); // newer

  const merged = mergeReplicas(renamed, deleted);
  assertSame(merged, mergeReplicas(deleted, renamed), "order-independent");
  assertEqual(F.projectProfile(merged, BEAST).tags.length, 0, "the rename does not resurrect the deleted tag");
  assertEqual(merged.profiles[BEAST].tags["tag-X"].name.v, "GOOD", "the rename still won its own fact, invisibly");
  assert(!F.projectProfile(merged, BEAST).itemTags["N/M.mp4"], "assignments to a deleted tag stop projecting");

  wall.ms += 5;
  const restored = F.restoreTag(merged, BEAST, "tag-X", a.stamp());
  const view = F.projectProfile(restored, BEAST);
  assertEqual(view.tags.length, 1, "an explicit later restore wins");
  assertEqual(view.tags[0].name, "GOOD", "and carries the newest name");
  assertSame(view.itemTags["N/M.mp4"], ["tag-X"], "restoring a tag restores its prior assignments");
});

await test("8. identical timestamps from different devices resolve deterministically", async () => {
  const wall = { ms: 7777 };
  const a = device("device-aaa", wall);
  const b = device("device-zzz", wall);
  const base = F.emptyReplica();

  // A shared starting point, stamped in the distant past so both renames beat
  // it. Each mutation below draws its OWN stamp, as every real caller must:
  // reusing one stamp for two mutations makes them collide with each other
  // rather than with the other device, which is a caller error, not a merge.
  const seeded = F.createTag(base, BEAST, "tag-1", "N", { t: 1, d: "device-seed" });

  const sa = a.stamp();
  const sb = b.stamp();
  assertEqual(sa.t, sb.t, "the two devices really did produce the same logical time");

  const ra = F.renameTag(seeded, BEAST, "tag-1", "FROM-AAA", sa);
  const rb = F.renameTag(seeded, BEAST, "tag-1", "FROM-ZZZ", sb);

  const ab = mergeReplicas(ra, rb);
  const ba = mergeReplicas(rb, ra);
  assertSame(ab, ba, "tie resolution is order-independent");
  assertEqual(F.projectProfile(ab, BEAST).tags[0].name, "FROM-ZZZ", "the higher deviceId wins the tie");

  // A malformed pair sharing a stamp but differing in value must still be
  // commutative rather than dependent on which side was passed first.
  const f1 = { v: "alpha", t: 9, d: "same" };
  const f2 = { v: "beta", t: 9, d: "same" };
  assertSame(mergeFact(f1, f2), mergeFact(f2, f1), "duplicated-stamp merge is still commutative");

  // Reusing one stamp for two mutations on the SAME device is a caller error.
  // It must resolve deterministically rather than letting the later call win by
  // accident of ordering — mutations are applied through mergeFact, so nothing
  // is privileged simply for being applied second or for being local.
  const reused = { t: 4242, d: "device-reuse" };
  const first = F.renameTag(F.createTag(F.emptyReplica(), BEAST, "tag-r", "AAA", reused), BEAST, "tag-r", "BBB", reused);
  const second = F.renameTag(F.createTag(F.emptyReplica(), BEAST, "tag-r", "BBB", reused), BEAST, "tag-r", "AAA", reused);
  assertEqual(
    stableStringify(first.profiles[BEAST].tags["tag-r"].name),
    stableStringify(second.profiles[BEAST].tags["tag-r"].name),
    "a reused stamp resolves to the same fact regardless of application order"
  );
});

await test("9. concurrent edits to unrelated facts all survive (contract section 7)", async () => {
  const wall = { ms: 1000 };
  const a = device("device-a", wall);
  const b = device("device-b", wall);

  // Shared starting point: G is hidden and D exists.
  let base = F.setHidden(F.emptyReplica(), BEAST, "G", true, a.stamp());
  base = F.createTag(base, BEAST, "tag-good", "GOOD", a.stamp());
  wall.ms += 10;

  // Computer A
  let A = F.setFavorite(base, BEAST, "A", true, a.stamp());
  A = F.setFavorite(A, BEAST, "B", true, a.stamp());
  A = F.setItemTag(A, BEAST, "C", "tag-good", true, a.stamp());
  A = F.setHidden(A, BEAST, "D", true, a.stamp());

  // Computer B, concurrently
  let B = F.setFavorite(base, BEAST, "E", true, b.stamp());
  B = F.createTag(B, BEAST, "tag-keep", "KEEP", b.stamp());
  B = F.setItemTag(B, BEAST, "F", "tag-keep", true, b.stamp());
  B = F.setHidden(B, BEAST, "G", false, b.stamp());

  const merged = mergeReplicas(A, B);
  const view = F.projectProfile(merged, BEAST);
  const favorites = view.favorites.map((f) => f.path).sort();

  assertSame(favorites, ["A", "B", "E"], "A, B and E are all favorited");
  assertSame(view.itemTags["C"], ["tag-good"], "C is tagged GOOD");
  assert(view.tags.some((t) => t.name === "KEEP"), "KEEP exists");
  assertSame(view.itemTags["F"], ["tag-keep"], "F is tagged KEEP");
  assert(view.hidden.includes("D"), "D is hidden");
  assert(!view.hidden.includes("G"), "G is unhidden");
  assertSame(merged, mergeReplicas(B, A), "order-independent");
});

await test("10. a stale client cannot resurrect a tombstone, however often it syncs", async () => {
  const wall = { ms: 1000 };
  const a = device("device-a", wall);

  let shared = F.createTag(F.emptyReplica(), BEAST, "tag-hot", "HOT", a.stamp());
  const staleClient = shared; // B's copy, taken before the delete

  wall.ms += 10;
  const afterDelete = F.deleteTag(shared, BEAST, "tag-hot", a.stamp());

  let converged = mergeReplicas(afterDelete, staleClient);
  assertEqual(F.projectProfile(converged, BEAST).tags.length, 0, "HOT stays deleted after the stale client syncs");

  // The stale client keeps re-publishing its old state; it must never win.
  for (let round = 0; round < 5; round++) {
    converged = mergeReplicas(converged, staleClient);
  }
  assertEqual(F.projectProfile(converged, BEAST).tags.length, 0, "still deleted after five stale re-syncs");
  assertSame(converged, afterDelete, "the stale replica contributes nothing at all");
});

await test("11. merge is idempotent and replays are harmless", async () => {
  const wall = { ms: 1000 };
  const a = device("device-a", wall);
  let r = F.createTag(F.emptyReplica(), BEAST, "tag-1", "T", a.stamp());
  r = F.setFavorite(r, BEAST, "X", true, a.stamp());
  r = F.setHidden(r, BEAST, "Y", true, a.stamp());

  assertSame(mergeReplicas(r, r), r, "merging a replica with itself changes nothing");

  const b = device("device-b", wall);
  wall.ms += 5;
  const other = F.setFavorite(r, BEAST, "Z", true, b.stamp());
  const once = mergeReplicas(r, other);
  assertSame(mergeReplicas(once, other), once, "re-merging an already-absorbed replica changes nothing");
  assertSame(mergeReplicas(once, r), once, "re-merging the original changes nothing");
  assertSame(mergeReplicas(once, once), once, "self-merge of the result changes nothing");
});

await test("12. three-way merge is order-independent and associative", async () => {
  const wall = { ms: 1000 };
  const a = device("device-a", wall);
  const b = device("device-b", wall);
  const c = device("device-c", wall);

  let base = F.createTag(F.emptyReplica(), BEAST, "tag-1", "T", a.stamp());
  wall.ms += 5;

  const A = F.setFavorite(base, BEAST, "X", true, a.stamp());
  const B = F.setItemTag(base, BEAST, "Y", "tag-1", true, b.stamp());
  const C = F.setHidden(base, BEAST, "Z", true, c.stamp());

  const orders = permutations([A, B, C]);
  const results = orders.map((o) => stableStringify(mergeAll(o)));
  assertEqual(new Set(results).size, 1, `all ${orders.length} orderings converge to one state`);

  assertSame(
    mergeReplicas(mergeReplicas(A, B), C),
    mergeReplicas(A, mergeReplicas(B, C)),
    "associativity holds"
  );
});

await test("13. profiles are isolated — editing one cannot touch another", async () => {
  const wall = { ms: 1000 };
  const a = device("device-a", wall);
  const b = device("device-b", wall);

  let base = F.setProfileName(F.emptyReplica(), BEAST, "BEAST", a.stamp());
  base = F.setProfileName(base, BBG4, "BBG4", a.stamp());
  base = F.setFavorite(base, BEAST, "beast/keep.mp4", true, a.stamp());
  wall.ms += 10;

  const A = F.setFavorite(base, BEAST, "beast/new.mp4", true, a.stamp());
  const B = F.createTag(F.setFavorite(base, BBG4, "bbg4/new.mp4", true, b.stamp()), BBG4, "tag-b", "B-ONLY", b.stamp());

  const merged = mergeReplicas(A, B);
  assertSame(
    F.projectProfile(merged, BEAST).favorites.map((f) => f.path).sort(),
    ["beast/keep.mp4", "beast/new.mp4"],
    "BEAST keeps its own work"
  );
  assertSame(
    F.projectProfile(merged, BBG4).favorites.map((f) => f.path).sort(),
    ["bbg4/new.mp4"],
    "BBG4 keeps its own work"
  );
  assertEqual(F.projectProfile(merged, BEAST).tags.length, 0, "BBG4's tag did not leak into BEAST");

  // Contract Test I: editing BBG4 leaves BEAST's subtree byte-identical.
  const beastBefore = stableStringify(base.profiles[BEAST]);
  const afterBbg4Edit = F.setItemTag(F.createTag(base, BBG4, "t", "T", b.stamp()), BBG4, "x", "t", true, b.stamp());
  assertEqual(stableStringify(afterBbg4Edit.profiles[BEAST]), beastBefore, "mutating BBG4 leaves BEAST untouched");
});

await test("14. profile deletion is a tombstone; library association merges separately", async () => {
  const wall = { ms: 1000 };
  const a = device("device-a", wall);
  const b = device("device-b", wall);

  let r = F.setProfileName(F.emptyReplica(), BEAST, "BEAST", a.stamp());
  r = F.setProfileName(r, BBG4, "BBG4", a.stamp());
  assertSame(F.liveProfileIds(r), [BEAST, BBG4].sort(), "both profiles live");

  wall.ms += 5;
  const deleted = F.deleteProfile(r, BBG4, a.stamp());
  assertSame(F.liveProfileIds(deleted), [BEAST], "deleted profile drops out of the live list");
  assert(deleted.profiles[BBG4] !== undefined, "its facts remain as bookkeeping, not erased");

  wall.ms += 5;
  const restored = F.restoreProfile(deleted, BBG4, a.stamp());
  assertSame(F.liveProfileIds(restored), [BEAST, BBG4].sort(), "an explicit restore brings it back");

  // Association is a fact about the library, resolved independently.
  const libId = "lib-0001";
  wall.ms += 5;
  const assocA = F.setLibraryAssociation(r, libId, BEAST, a.stamp());
  wall.ms += 5;
  const assocB = F.setLibraryAssociation(r, libId, BBG4, b.stamp());
  const mergedAssoc = mergeReplicas(assocA, assocB);
  assertEqual(F.projectAssociations(mergedAssoc)[libId], BBG4, "the newer association change wins");
  assertSame(mergedAssoc, mergeReplicas(assocB, assocA), "order-independent");

  const cleared = F.setLibraryAssociation(mergedAssoc, libId, null, (wall.ms += 5, b.stamp()));
  assertEqual(F.projectAssociations(cleared)[libId], undefined, "clearing an association is an explicit null fact");
  assert(cleared.associations[libId].v === null, "and is stored, not removed");
});

await test("15. the shape guard rejects session state and malformed facts", async () => {
  const wall = { ms: 1000 };
  const a = device("device-a", wall);
  let clean = F.createTag(F.emptyReplica(), BEAST, "tag-1", "T", a.stamp());
  clean = F.setFavorite(clean, BEAST, "X", true, a.stamp());
  clean = F.setLibraryAssociation(clean, "lib-1", BEAST, a.stamp());

  assertSame(F.findSessionStateLeaks(clean), [], "a well-formed replica reports no leaks");

  // The exact fields approved as local-only in Stage C's scope.
  const polluted = JSON.parse(JSON.stringify(clean));
  polluted.profiles[BEAST].tags["tag-1"].tagActivity = { shuffleOff: { position: 3 } };
  polluted.profiles[BEAST].items["X"].lastTagPosition = 7;
  polluted.playbackPosition = 42;
  const leaks = F.findSessionStateLeaks(polluted);
  assert(leaks.length === 3, `all three leaks are reported (got ${leaks.length}: ${leaks.join(", ")})`);
  assert(leaks.some((l) => l.includes("tagActivity")), "tagActivity is caught");
  assert(leaks.some((l) => l.includes("lastTagPosition")), "lastTagPosition is caught");
  assert(leaks.some((l) => l.includes("playbackPosition")), "playbackPosition is caught");

  const malformed = JSON.parse(JSON.stringify(clean));
  malformed.profiles[BEAST].items["X"].favorite = { v: { on: true }, t: "not-a-number", d: "x" };
  assert(F.findSessionStateLeaks(malformed).some((l) => l.includes("not a well-formed fact")), "a malformed fact is caught");

  // Every field on the approved local-only list is absent from a real replica.
  const serialized = stableStringify(clean);
  const present = F.SESSION_ONLY_FIELDS.filter((field) => serialized.includes(`"${field}"`));
  assertSame(present, [], "no approved-local-only field appears anywhere in a replica");
});

await test("16. property: commutative, associative, idempotent over seeded histories", async () => {
  const PATHS = ["a.mp4", "b.mp4", "c.mp4", "d.jpg", "e.jpg"];
  const TAGS = ["tag-1", "tag-2", "tag-3"];
  const PROFILES = [BEAST, BBG4];

  function randomHistory(seed, deviceCount, opCount) {
    const rand = rng(seed);
    const wall = { ms: 1_000_000 };
    const devices = Array.from({ length: deviceCount }, (_, i) => device(`device-${i}`, wall));

    // Common starting point so tags exist to rename/delete.
    let base = F.emptyReplica();
    for (const profileId of PROFILES) {
      base = F.setProfileName(base, profileId, profileId, devices[0].stamp());
      for (const tagId of TAGS) base = F.createTag(base, profileId, tagId, tagId.toUpperCase(), devices[0].stamp());
    }

    const replicas = devices.map(() => base);
    for (let i = 0; i < opCount; i++) {
      // Advancing by 0 sometimes is deliberate: it manufactures cross-device
      // stamp ties, which is the case deviceId tie-breaking exists for.
      wall.ms += rand() < 0.25 ? 0 : 1 + Math.floor(rand() * 5);

      const which = Math.floor(rand() * deviceCount);
      const dev = devices[which];
      const profileId = PROFILES[Math.floor(rand() * PROFILES.length)];
      const p = PATHS[Math.floor(rand() * PATHS.length)];
      const tagId = TAGS[Math.floor(rand() * TAGS.length)];
      const op = Math.floor(rand() * 8);
      const flag = rand() < 0.5;
      let r = replicas[which];

      if (op === 0) r = F.setFavorite(r, profileId, p, flag, dev.stamp());
      else if (op === 1) r = F.setHidden(r, profileId, p, flag, dev.stamp());
      else if (op === 2) r = F.setItemTag(r, profileId, p, tagId, flag, dev.stamp());
      else if (op === 3) r = F.renameTag(r, profileId, tagId, `N${i}`, dev.stamp());
      else if (op === 4) r = F.deleteTag(r, profileId, tagId, dev.stamp());
      else if (op === 5) r = F.restoreTag(r, profileId, tagId, dev.stamp());
      else if (op === 6) r = F.setProfileName(r, profileId, `P${i}`, dev.stamp());
      else r = F.setLibraryAssociation(r, `lib-${Math.floor(rand() * 3)}`, flag ? profileId : null, dev.stamp());

      replicas[which] = r;
    }
    return replicas;
  }

  let commutative = 0;
  let associative = 0;
  let idempotent = 0;
  let noLoss = 0;
  const SEEDS = [1, 2, 3, 7, 11, 42, 1337, 90210];

  for (const seed of SEEDS) {
    const [A, B, C] = randomHistory(seed, 3, 60);

    if (stableStringify(mergeReplicas(A, B)) === stableStringify(mergeReplicas(B, A))) commutative++;

    if (
      stableStringify(mergeReplicas(mergeReplicas(A, B), C)) ===
      stableStringify(mergeReplicas(A, mergeReplicas(B, C)))
    ) {
      associative++;
    }

    const merged = mergeAll([A, B, C]);
    if (stableStringify(mergeReplicas(merged, merged)) === stableStringify(merged)) idempotent++;

    // A merge may only ever ADD facts, never drop one.
    const before = Math.max(factCount(A), factCount(B), factCount(C));
    if (factCount(merged) >= before) noLoss++;
  }

  assertEqual(commutative, SEEDS.length, `commutative on all ${SEEDS.length} seeded histories`);
  assertEqual(associative, SEEDS.length, `associative on all ${SEEDS.length} seeded histories`);
  assertEqual(idempotent, SEEDS.length, `idempotent on all ${SEEDS.length} seeded histories`);
  assertEqual(noLoss, SEEDS.length, `no merge lost a fact on any seeded history`);
});

await test("17. convergence: many devices, random interleavings, one final state", async () => {
  const rand = rng(20260816);
  const DEVICES = 4;
  const wall = { ms: 2_000_000 };
  const devices = Array.from({ length: DEVICES }, (_, i) => device(`device-${i}`, wall));

  let base = F.setProfileName(F.emptyReplica(), BEAST, "BEAST", devices[0].stamp());
  base = F.setProfileName(base, BBG4, "BBG4", devices[0].stamp());
  base = F.createTag(base, BEAST, "tag-1", "ONE", devices[0].stamp());

  const replicas = devices.map(() => base);

  // Each device works independently, and gossips with a random peer as it goes
  // — so devices observe each other's stamps mid-history, exactly as they would
  // in a real few-second sync cycle.
  for (let round = 0; round < 120; round++) {
    wall.ms += 1 + Math.floor(rand() * 4);
    const i = Math.floor(rand() * DEVICES);
    const dev = devices[i];
    const profileId = rand() < 0.5 ? BEAST : BBG4;
    const p = `item-${Math.floor(rand() * 6)}.mp4`;

    const roll = rand();
    if (roll < 0.3) replicas[i] = F.setFavorite(replicas[i], profileId, p, rand() < 0.6, dev.stamp());
    else if (roll < 0.55) replicas[i] = F.setHidden(replicas[i], profileId, p, rand() < 0.5, dev.stamp());
    else if (roll < 0.75) replicas[i] = F.setItemTag(replicas[i], profileId, p, "tag-1", rand() < 0.6, dev.stamp());
    else if (roll < 0.85) replicas[i] = F.deleteTag(replicas[i], profileId, "tag-1", dev.stamp());
    else if (roll < 0.92) replicas[i] = F.restoreTag(replicas[i], profileId, "tag-1", dev.stamp());
    else replicas[i] = F.createTag(replicas[i], profileId, `tag-${round}`, `T${round}`, dev.stamp());

    // Partial, one-directional gossip — the receiver learns, the sender does not.
    if (rand() < 0.4) {
      const j = Math.floor(rand() * DEVICES);
      if (j !== i) {
        replicas[j] = mergeReplicas(replicas[j], replicas[i]);
        devices[j].clock.observeReplica(replicas[j]);
      }
    }
  }

  const canonical = stableStringify(mergeAll(replicas));

  // Every device merging everyone else, in its own random order, must land on
  // the identical state — that is the convergence requirement.
  let converged = 0;
  for (let i = 0; i < DEVICES; i++) {
    const order = [...replicas].sort(() => (rand() < 0.5 ? -1 : 1));
    let acc = replicas[i];
    for (const other of order) acc = mergeReplicas(acc, other);
    if (stableStringify(acc) === canonical) converged++;
  }
  assertEqual(converged, DEVICES, `all ${DEVICES} devices converge on the identical canonical state`);

  // And the projection of that state is well-formed and leak-free.
  assertSame(F.findSessionStateLeaks(mergeAll(replicas)), [], "the converged replica passes the shape guard");
  const view = F.projectProfile(mergeAll(replicas), BEAST);
  assert(view !== null && Array.isArray(view.favorites), "the converged state projects cleanly");
});

// =========================================================================

console.log(`\n${"-".repeat(60)}`);
console.log(`${passes} assertion(s) passed, ${failures} failure(s)`);
if (failures) {
  console.log("\nFailures:");
  for (const label of failed) console.log(`  - ${label}`);
}
process.exit(failures ? 1 : 0);
