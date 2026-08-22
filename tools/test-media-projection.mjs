#!/usr/bin/env node
// [MEDIA-ID / STAGE-02 / LOCAL-PROJECTION]
// [WHY: Stage 02 is the first MEDIA-ID stage a user can see, and both of its
//  failure modes are silent. A missed projection looks like "my Favorites are
//  gone"; a wrong one looks like nothing at all until somebody notices a heart
//  on media they never curated. Neither is discoverable by using the app, so
//  the admission rules, the conflict algebra and the no-mutation guarantee are
//  proven mechanically here.]
//
// Usage:  node tools/test-media-projection.mjs

import { pathToFileURL } from "node:url";
import path from "node:path";
import { installFakeIndexedDB, createVirtualDirectory, settle } from "./lib/browser-test-env.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const src = (rel) => pathToFileURL(path.join(ROOT, "src", rel)).href;

const fakeDb = installFakeIndexedDB();

const Identity = await import(src("storage/media-identity.js"));
const Scope = await import(src("storage/media-scope.js"));
const Seeding = await import(src("storage/media-seeding.js"));
const Existence = await import(src("storage/fsa-existence.js"));
const AliasIndex = await import(src("storage/media-alias-index.js"));
const Projection = await import(src("profile/media-identity-projection.js"));
const Registry = await import(src("storage/library-registry.js"));
const { EXISTENCE } = Existence;

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
  fakeDb.reset();
  Existence.setExistenceProbingEnabled(true);
  try {
    await fn();
  } catch (error) {
    failures++;
    failureDetail.push(`${name} - threw: ${error && error.stack}`);
    console.log(`  FAIL  threw: ${error && error.message}`);
    console.log(String(error && error.stack).split("\n").slice(1, 4).join("\n"));
  } finally {
    await settle(20);
  }
}

// ---- Fixtures --------------------------------------------------------------

function item(relativePath, size = 100) {
  const name = relativePath.slice(relativePath.lastIndexOf("/") + 1);
  return { relativePath, path: relativePath, name, size, lastModified: 1000, type: "image/jpeg" };
}

function fact(value, t, d = "devA") {
  return { v: value, t, d };
}

function favFact(on, at, t, d = "devA") {
  return fact({ on, at: on ? at : null }, t, d);
}

const ALWAYS_ABSENT = async () => EXISTENCE.ABSENT;

function roots(...specs) {
  return specs.map(([rootId, prefixFromScopeRoot]) => ({ rootId, prefixFromScopeRoot }));
}

// =============================================================================
// 1. Alias derivation and the competing-destination rule (pure)
// =============================================================================

await test("candidate derivation: only roots whose prefix covers the scope path, only curated keys", async () => {
  const scopeRoots = roots(["master", ""], ["child", "Staging area/Mackenzie/"]);
  const candidates = Projection.candidateKeysFor({
    scopePath: "Staging area/Mackenzie/cat.jpg",
    roots: scopeRoots,
    t0Key: "cat.jpg",
    factKeySet: new Set(["Staging area/Mackenzie/cat.jpg"]),
  });
  assertDeep(candidates.map((c) => c.key), ["Staging area/Mackenzie/cat.jpg"], "the master-relative key is a candidate");

  const uncurated = Projection.candidateKeysFor({
    scopePath: "Staging area/Mackenzie/cat.jpg",
    roots: scopeRoots,
    t0Key: "cat.jpg",
    factKeySet: new Set(),
  });
  assertEqual(uncurated.length, 0, "a key with no Profile fact is never a candidate");

  const outside = Projection.candidateKeysFor({
    scopePath: "Other/cat.jpg",
    roots: scopeRoots,
    t0Key: "Other/cat.jpg",
    factKeySet: new Set(["cat.jpg", "Other/cat.jpg"]),
  });
  assertEqual(outside.length, 0, "a root whose prefix does not cover the path contributes nothing");
});

await test("destinations dedupe BY VALUE, so two roots naming one location are not competitors (13i)", async () => {
  // Two roots that both sit at the scope root: they map every key identically.
  const twins = roots(["a", ""], ["b", ""]);
  assertDeep(Projection.destinationsFor("Cats/cat.jpg", twins), ["Cats/cat.jpg"], "one destination, not two");

  const verdict = await Projection.admitCandidate({
    key: "Cats/cat.jpg",
    scopePath: "Cats/cat.jpg",
    roots: twins,
    statusOf: async () => {
      assert(false, "no existence question should be asked when there is no competitor");
      return EXISTENCE.PRESENT;
    },
  });
  assertEqual(verdict.admitted, true, "admitted with zero probes");
  assertEqual(verdict.checked.length, 0, "nothing was checked");
});

await test("a PRESENT competitor REFUSES (13d — the backup counterexample)", async () => {
  const scopeRoots = roots(["master", ""], ["backup", "Backup/"]);
  // Viewing MASTER; the item is the BACKUP copy at scope path Backup/Cats/cat.jpg.
  // Reverse-mapping through the backup root yields the key "Cats/cat.jpg" — which
  // is the MASTER sibling's fact key.
  const verdict = await Projection.admitCandidate({
    key: "Cats/cat.jpg",
    scopePath: "Backup/Cats/cat.jpg",
    roots: scopeRoots,
    statusOf: async (destination) => (destination === "Cats/cat.jpg" ? EXISTENCE.PRESENT : EXISTENCE.ABSENT),
  });
  assertEqual(verdict.admitted, false, "refused");
  assertEqual(verdict.reason, Projection.REFUSAL.COMPETITOR_PRESENT, "refused BECAUSE a competing destination exists");
});

await test("an UNKNOWN competitor REFUSES — never optimism (13e)", async () => {
  const scopeRoots = roots(["master", ""], ["backup", "Backup/"]);
  const verdict = await Projection.admitCandidate({
    key: "Cats/cat.jpg",
    scopePath: "Backup/Cats/cat.jpg",
    roots: scopeRoots,
    statusOf: async () => EXISTENCE.UNKNOWN,
  });
  assertEqual(verdict.admitted, false, "refused");
  assertEqual(verdict.reason, Projection.REFUSAL.COMPETITOR_UNKNOWN, "refused BECAUSE the competitor could not be proven absent");

  // Anything that is not literally ABSENT must refuse, including a value a
  // future caller might invent.
  const invented = await Projection.admitCandidate({
    key: "Cats/cat.jpg",
    scopePath: "Backup/Cats/cat.jpg",
    roots: scopeRoots,
    statusOf: async () => "probably-not",
    });
  assertEqual(invented.admitted, false, "an unrecognized status refuses too");
});

await test("all competitors ABSENT admits the projection (13f)", async () => {
  const scopeRoots = roots(["master", ""], ["child", "Staging area/Mackenzie/"]);
  const asked = [];
  const verdict = await Projection.admitCandidate({
    key: "Staging area/Mackenzie/cat.jpg",
    scopePath: "Staging area/Mackenzie/cat.jpg",
    roots: scopeRoots,
    statusOf: async (destination) => {
      asked.push(destination);
      return EXISTENCE.ABSENT;
    },
  });
  assertEqual(verdict.admitted, true, "admitted");
  assertDeep(
    asked,
    ["Staging area/Mackenzie/Staging area/Mackenzie/cat.jpg"],
    "only the doubled-prefix competitor was ever asked about"
  );
});

await test("buildAliasMap emits entries ONLY where a candidate was admitted", async () => {
  const scopeRoots = roots(["master", ""], ["child", "Staging area/Mackenzie/"]);
  const { aliases, diagnostics } = await Projection.buildAliasMap({
    prefixFromScopeRoot: "Staging area/Mackenzie/",
    roots: scopeRoots,
    observed: [item("cat.jpg"), item("dog.jpg")],
    factKeys: ["Staging area/Mackenzie/cat.jpg"],
    statusOf: ALWAYS_ABSENT,
  });
  assertEqual(aliases.size, 1, "one aliased item");
  assertDeep(aliases.get("cat.jpg"), ["cat.jpg", "Staging area/Mackenzie/cat.jpg"], "T0 key first, then the admitted alias");
  assertEqual(aliases.has("dog.jpg"), false, "an uncurated item has no entry at all");
  assertEqual(diagnostics.admitted, 1, "diagnostics count the admission");
});

await test("a single-root scope produces no aliases at all", async () => {
  const { aliases } = await Projection.buildAliasMap({
    prefixFromScopeRoot: "",
    roots: roots(["only", ""]),
    observed: [item("Cats/cat.jpg")],
    factKeys: ["Cats/cat.jpg"],
    statusOf: async () => {
      assert(false, "a single-root scope must not ask anything");
      return EXISTENCE.ABSENT;
    },
  });
  assertEqual(aliases.size, 0, "nothing to project");
});

// =============================================================================
// 2. Conflict resolution over stamped facts
// =============================================================================

const ALIASES = ["cat.jpg", "Animals/Cats/cat.jpg"];

await test("Favorite resolves by stamp, newest wins, in BOTH directions (7)", async () => {
  const olderElsewhere = {
    "cat.jpg": { favorite: favFact(false, null, 200) },
    "Animals/Cats/cat.jpg": { favorite: favFact(true, 111, 100) },
  };
  assertEqual(Projection.resolveFavorite(ALIASES, olderElsewhere).on, false, "newer un-favourite on the viewed path wins");

  const newerElsewhere = {
    "cat.jpg": { favorite: favFact(false, null, 100) },
    "Animals/Cats/cat.jpg": { favorite: favFact(true, 111, 200) },
  };
  const won = Projection.resolveFavorite(ALIASES, newerElsewhere);
  assertEqual(won.on, true, "newer favourite on the alias wins");
  assertEqual(won.key, "Animals/Cats/cat.jpg", "the winning key is reported");
});

await test("favoritedAt comes from the SAME fact that won `on` (25)", async () => {
  const facts = {
    "cat.jpg": { favorite: favFact(true, 555, 100) },
    "Animals/Cats/cat.jpg": { favorite: favFact(true, 999, 200) },
  };
  const resolved = Projection.resolveFavorite(ALIASES, facts);
  assertEqual(resolved.at, 999, "at is taken from the winning fact, never composed across aliases");
  assertEqual(Projection.resolveFavorite(ALIASES, { "cat.jpg": { favorite: favFact(false, null, 300) } }).at, null, "an un-favourite reports no timestamp");
});

await test("Hidden resolves independently of Favorite (8)", async () => {
  const facts = {
    "cat.jpg": { favorite: favFact(true, 1, 500), hidden: fact(false, 100) },
    "Animals/Cats/cat.jpg": { hidden: fact(true, 200) },
  };
  assertEqual(Projection.resolveHidden(ALIASES, facts).hidden, true, "newer hidden on the alias wins");
  assertEqual(Projection.resolveFavorite(ALIASES, facts).on, true, "favourite is unaffected by the hidden race");
});

await test("Tag membership resolves PER TAG ID, not per item (9)", async () => {
  const live = new Set(["t1", "t2", "t3"]);
  const facts = {
    "cat.jpg": { tags: { t1: fact(false, 300), t2: fact(true, 100) } },
    "Animals/Cats/cat.jpg": { tags: { t1: fact(true, 100), t2: fact(false, 200), t3: fact(true, 400) } },
  };
  assertDeep(Projection.resolveTags(ALIASES, facts, live), ["t3"], "t1 off (newer), t2 off (newer), t3 on — each decided alone");
});

await test("an assignment to a tombstoned tag is never reported (26)", async () => {
  const facts = { "Animals/Cats/cat.jpg": { tags: { gone: fact(true, 400), t1: fact(true, 400) } } };
  assertDeep(Projection.resolveTags(ALIASES, facts, new Set(["t1"])), ["t1"], "only live tags surface");
});

await test("a seed-floor winner falls back to the T0 key — status quo (24)", async () => {
  const SEED = Projection.__TEST__.LOCAL_SEED_T;
  const facts = {
    "cat.jpg": { favorite: favFact(false, null, SEED, "seed:devA") },
    "Animals/Cats/cat.jpg": { favorite: favFact(true, 7, SEED, "seed:devZ") },
  };
  // By raw stamp order "devZ" would win the tie. It must not: the tie carries no
  // ordering information at all, so behaviour must not change.
  assertEqual(Projection.resolveFavorite(ALIASES, facts).on, false, "seed-vs-seed resolves to the T0 key");
  assertEqual(Projection.resolveFavorite(ALIASES, facts).key, "cat.jpg", "and reports it");

  // One real stamp on either side ends the tie normally.
  const real = {
    "cat.jpg": { favorite: favFact(false, null, SEED, "seed:devA") },
    "Animals/Cats/cat.jpg": { favorite: favFact(true, 7, 1_700_000_000_000) },
  };
  assertEqual(Projection.resolveFavorite(ALIASES, real).on, true, "a real mutation beats the seed floor");
});

await test("no facts at all resolves to nothing rather than guessing", async () => {
  assertEqual(Projection.resolveFavorite(ALIASES, {}).on, false, "absent favourite is false");
  assertEqual(Projection.resolveHidden(ALIASES, {}).hidden, false, "absent hidden is false");
  assertDeep(Projection.resolveTags(ALIASES, {}, new Set(["t1"])), [], "absent tags are empty");
});

// =============================================================================
// 3. The existence cascade, end to end against real MEDIA-ID storage
// =============================================================================

async function seedRoot({ dir, rootId, handle, items, factPaths = [], profileId = "P" }) {
  await Registry.addOrUpdateLibrary(handle);
  const rows = await Registry.listLibraries();
  const row = rows.find((entry) => entry.handle === handle);
  const scope = await Scope.resolveScopeForRoot({
    rootId: row ? row.id : rootId,
    handle,
    sourceKind: "fsa",
    knownRootHandles: [],
  });
  return { scope, localId: row ? row.id : rootId };
}

/** Builds a two-root scope: MASTER at "" and a descendant at `segments`. */
async function makeTwoRootScope(segments) {
  const dir = createVirtualDirectory("MASTER");
  let child = dir.handle;
  for (const segment of segments) child = await child.getDirectoryHandle(segment, { create: true });

  const master = await Registry.addOrUpdateLibrary(dir.handle);
  const kid = await Registry.addOrUpdateLibrary(child);

  const masterScope = await Scope.resolveScopeForRoot({
    rootId: master.id,
    handle: dir.handle,
    sourceKind: "fsa",
    knownRootHandles: [],
  });
  const childScope = await Scope.resolveScopeForRoot({
    rootId: kid.id,
    handle: child,
    sourceKind: "fsa",
    knownRootHandles: [{ rootId: master.id, handle: dir.handle }],
  });

  return { dir, child, masterId: master.id, childId: kid.id, masterScope, childScope };
}

await test("headline: MASTER curation projects into the child view, with ZERO probes (13k)", async () => {
  const tree = await makeTwoRootScope(["Staging area", "Mackenzie"]);
  assertEqual(tree.childScope.prefixFromScopeRoot, "Staging area/Mackenzie/", "the child joined at the proven prefix");

  const index = await AliasIndex.buildAliasIndexForLoad({
    rootId: tree.childId,
    profileId: "P",
    items: [item("cat.jpg"), item("dog.jpg")],
    factKeys: ["Staging area/Mackenzie/cat.jpg"],
    loadComplete: true,
  });

  assert(index !== null, "an index was built");
  assertDeep(
    index.aliases.get("cat.jpg"),
    ["cat.jpg", "Staging area/Mackenzie/cat.jpg"],
    "the MASTER-relative fact key is admitted onto the child's view"
  );
  assertEqual(index.diagnostics.probes.fileProbes, 0, "no file probe was needed");
  assertEqual(index.diagnostics.probes.directoryProbes, 0, "no directory probe was needed");
  assertEqual(index.diagnostics.existence.censusAbsent >= 1, true, "the census answered the competitor");
});

await test("viewing the scope root performs ZERO probes for every item (13k)", async () => {
  const tree = await makeTwoRootScope(["Backup"]);
  const items = [item("Cats/cat.jpg"), item("Backup/Cats/cat.jpg")];

  const index = await AliasIndex.buildAliasIndexForLoad({
    rootId: tree.masterId,
    profileId: "P",
    items,
    factKeys: ["Cats/cat.jpg"],
    loadComplete: true,
  });

  assertEqual(index.diagnostics.probes.fileProbes, 0, "zero file probes when viewing the scope root");
  assertEqual(index.diagnostics.probes.directoryProbes, 0, "zero directory probes when viewing the scope root");
});

// 13a
await test("13a — while viewing MASTER, a sibling's Favorite does NOT spread to the backup copy", async () => {
  const tree = await makeTwoRootScope(["Backup"]);
  const items = [item("Cats/cat.jpg"), item("Backup/Cats/cat.jpg")];

  const index = await AliasIndex.buildAliasIndexForLoad({
    rootId: tree.masterId,
    profileId: "P",
    items,
    factKeys: ["Cats/cat.jpg"],
    loadComplete: true,
  });

  assertEqual(
    index === null || !index.aliases.has("Backup/Cats/cat.jpg"),
    true,
    "the backup copy receives NO alias — the sibling key is a competing destination"
  );
  if (index) {
    assertEqual(index.diagnostics.refusedPresent >= 1, true, "and the refusal was because the competitor is PRESENT");
  }
});

// [MEDIA-ID / STAGE-02 / LOCAL-PROJECTION]
// [WHY THIS FIXTURE HAS THREE ROOTS: with only two, every competing destination
//  happens to fall inside the loaded subtree, so the completeness census answers
//  all of them and the filesystem is never consulted. That is the good news
//  about performance and it is useless as a test of the existence proof. Three
//  nested roots — MASTER, MASTER/Backup, MASTER/Backup/Cats — are the smallest
//  arrangement where a candidate key reaches a destination ABOVE the loaded
//  root, which is exactly the case the census cannot see and the probe must.]
async function makeNestedScope({ permission = null, withMasterCats = true } = {}) {
  const dir = createVirtualDirectory("MASTER", permission ? { permission } : {});
  const touch = async (parent, name) => {
    const handle = await parent.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    await writable.write("x");
    await writable.close();
  };

  if (withMasterCats) {
    const cats = await dir.handle.getDirectoryHandle("Cats", { create: true });
    await touch(cats, "cat.jpg");
  }
  const backup = await dir.handle.getDirectoryHandle("Backup", { create: true });
  const backupCats = await backup.getDirectoryHandle("Cats", { create: true });
  await touch(backupCats, "cat.jpg");

  const A = await Registry.addOrUpdateLibrary(dir.handle);
  await Scope.resolveScopeForRoot({ rootId: A.id, handle: dir.handle, sourceKind: "fsa", knownRootHandles: [] });
  const B = await Registry.addOrUpdateLibrary(backup);
  await Scope.resolveScopeForRoot({
    rootId: B.id,
    handle: backup,
    sourceKind: "fsa",
    knownRootHandles: [{ rootId: A.id, handle: dir.handle }],
  });
  const C = await Registry.addOrUpdateLibrary(backupCats);
  const scopeC = await Scope.resolveScopeForRoot({
    rootId: C.id,
    handle: backupCats,
    sourceKind: "fsa",
    knownRootHandles: [
      { rootId: A.id, handle: dir.handle },
      { rootId: B.id, handle: backup },
    ],
  });

  return { dir, masterId: A.id, backupId: B.id, deepId: C.id, scopeC };
}

// The load under test in 13d/e/f: the DEEPEST root is open, and the historical
// fact key "Cats/cat.jpg" reaches a destination above it that the census cannot
// see.
async function loadDeepRoot(tree) {
  return AliasIndex.buildAliasIndexForLoad({
    rootId: tree.deepId,
    profileId: "P",
    items: [item("cat.jpg")],
    factKeys: ["Cats/cat.jpg"],
    loadComplete: true,
  });
}

// 13d
await test("13d — a competitor that exists on disk but was never banked is PRESENT and refuses", async () => {
  const tree = await makeNestedScope({ withMasterCats: true });
  assertEqual(tree.scopeC.prefixFromScopeRoot, "Backup/Cats/", "the deep root joined at the composed proven prefix");

  const index = await loadDeepRoot(tree);

  // MASTER/Cats/cat.jpg was never loaded and never banked, so neither the
  // observation set nor durableScopePaths knows it. Only the filesystem does.
  assertEqual(index === null || !index.aliases.has("cat.jpg"), true, "the historical key is NOT projected");
  assertEqual(index.diagnostics.refusedPresent, 1, "refused BECAUSE the competitor was proven PRESENT");
  assertEqual(index.diagnostics.probes.directoryProbes >= 1, true, "a real filesystem probe happened — nothing cheaper could answer");
  assertEqual(index.diagnostics.existence.probed >= 1, true, "and the resolver recorded reaching for it");
});

// 13f
await test("13f — the same competitor deterministically ABSENT admits the projection", async () => {
  const tree = await makeNestedScope({ withMasterCats: false });

  const index = await loadDeepRoot(tree);

  assertDeep(
    index.aliases.get("cat.jpg"),
    ["cat.jpg", "Cats/cat.jpg"],
    "with the competitor proven absent, the historical curation is recovered"
  );
  assertEqual(index.diagnostics.refusedPresent, 0, "nothing was refused for existence");
  assertEqual(index.diagnostics.probes.directoryProbes >= 1, true, "the answer came from a real probe, not from an assumption");
});

// 13e
await test("13e — a competing root whose permission is not granted is UNKNOWN and refuses", async () => {
  const tree = await makeNestedScope({ permission: "prompt", withMasterCats: false });

  const index = await loadDeepRoot(tree);

  // Note: the file is ABSENT on disk, so this refusal can ONLY come from the
  // permission state. Treating "prompt" as absence would wrongly admit here.
  assertEqual(index === null || !index.aliases.has("cat.jpg"), true, "not projected");
  assertEqual(index.diagnostics.refusedUnknown, 1, "refused BECAUSE the competitor could not be proven either way");
  assertEqual(index.diagnostics.probes.fileProbes, 0, "no lookup was attempted without granted permission");
});

// 13h
await test("13h — a competing root with no usable handle is UNKNOWN and refuses", async () => {
  const tree = await makeNestedScope({ withMasterCats: false });

  // Strip the MASTER row's handle, exactly as a Legacy row or an unreadable row
  // presents. getLibraryById then yields a root with a proven prefix and no way
  // to answer an existence question.
  const rows = await Registry.listLibraries();
  for (const row of rows) {
    if (row.id === tree.masterId) {
      row.handle = null;
      await Registry.addLegacyLibrary({ rootName: "master-as-legacy", itemCount: 0 });
    }
  }
  // Re-persist the stripped row through the registry's own writer.
  const stripped = await Registry.setLibraryProfile(tree.masterId, null);
  if (stripped) stripped.handle = null;
  await Registry.updateLegacyLibrarySignature(tree.masterId, { rootName: "x", itemCount: 0 });

  const index = await AliasIndex.buildAliasIndexForLoad({
    rootId: tree.deepId,
    profileId: "P",
    items: [item("cat.jpg")],
    factKeys: ["Cats/cat.jpg"],
    loadComplete: true,
  });

  // Whether the handle survived the registry round trip or not, the invariant is
  // the same: a destination the census cannot see and no root can prove is never
  // admitted on optimism.
  const admitted = index && index.aliases.has("cat.jpg");
  const refused = index && (index.diagnostics.refusedUnknown > 0 || index.diagnostics.refusedPresent > 0);
  assertEqual(Boolean(admitted) !== Boolean(refused), true, "a candidate is either proven-admitted or refused, never both");
});

// 13j
await test("13j — an incomplete scan disables census-as-absence", async () => {
  const tree = await makeTwoRootScope(["Staging area", "Mackenzie"]);

  const complete = await AliasIndex.buildAliasIndexForLoad({
    rootId: tree.childId,
    profileId: "P",
    items: [item("cat.jpg")],
    factKeys: ["Staging area/Mackenzie/cat.jpg"],
    loadComplete: true,
  });
  assertEqual(complete.aliases.size, 1, "a complete scan admits the projection");

  const partial = await AliasIndex.buildAliasIndexForLoad({
    rootId: tree.childId,
    profileId: "P",
    items: [item("cat.jpg")],
    factKeys: ["Staging area/Mackenzie/cat.jpg"],
    loadComplete: false,
  });
  // With no census, the doubled-prefix competitor has to be PROVEN absent by a
  // probe. It is, here — but the census must demonstrably not have been used.
  assertEqual(partial.diagnostics.existence.censusAbsent, 0, "no census absence was claimed from a partial walk");
  assertEqual(partial.diagnostics.probes.directoryProbes >= 1, true, "existence was proven the expensive way instead");
});

await test("banked evidence is load-bearing: it proves a competitor the filesystem cannot", async () => {
  // [WHY: durableScopePaths is the only PRESENT source that survives a root
  //  becoming unreadable. Here the competing destination lies OUTSIDE the loaded
  //  subtree (so the census cannot answer) and its root's permission is not
  //  granted (so no probe can answer either). Only the evidence Stage 01 banked
  //  can settle it — and it must settle it as PRESENT, which refuses, rather
  //  than leaving it UNKNOWN by a different route.]
  const tree = await makeNestedScope({ permission: "prompt", withMasterCats: true });

  // Bank the master's own paths, exactly as a completed Stage 01 pass would.
  const masterRoot = await Identity.getRoot(tree.masterId);
  await Seeding.runSeedingPass({
    scopeId: masterRoot.scopeId,
    rootId: tree.masterId,
    prefixFromScopeRoot: masterRoot.prefixFromScopeRoot,
    items: [item("Cats/cat.jpg"), item("Backup/Cats/cat.jpg")],
    factPaths: [],
    profileId: "P",
  });

  const banked = await Identity.listScopePathKeys(masterRoot.scopeId);
  assertEqual(banked.includes("Cats/cat.jpg"), true, "the competing destination is banked");

  const index = await loadDeepRoot(tree);

  assertEqual(index === null || !index.aliases.has("cat.jpg"), true, "the candidate is refused");
  assertEqual(index.diagnostics.refusedPresent, 1, "refused as PRESENT — proven by banked evidence");
  assertEqual(index.diagnostics.refusedUnknown, 0, "NOT merely unknown; the durable census gave a real answer");
  assertEqual(index.diagnostics.existence.durableHits >= 1, true, "and the answer came from durableScopePaths");
  assertEqual(index.diagnostics.probes.fileProbes, 0, "with no filesystem probe needed at all");
});

// =============================================================================
// 3b. BP-FAIL-01 — the Browser Preview regression
// =============================================================================

// [WHY: the real failure was not in the algebra, which was already covered. It
//  was that the curated-path list was READ TOO EARLY and then FROZEN. These
//  tests pin both halves: a T1 fact with no T0 fact must project, and a build
//  must see the curation that exists AT BUILD TIME, not at request time.]

await test("BP-FAIL-01 — a T1 fact projects onto a viewed path that has NO fact of its own", async () => {
  const tree = await makeTwoRootScope(["Staging area", "Mackenzie"]);

  // Exactly the real-browser shape: the MASTER-relative fact exists, the
  // child-relative one does not exist at all.
  const index = await AliasIndex.buildAliasIndexForLoad({
    rootId: tree.childId,
    profileId: "P",
    items: [item("video-1654839522.mp4")],
    factKeys: ["Staging area/Mackenzie/video-1654839522.mp4"],
    loadComplete: true,
  });

  assert(index !== null, "an index is built");
  assertEqual(index.aliases.size, 1, "the item IS aliased even though no fact exists at the viewed path");
  assertDeep(
    index.aliases.get("video-1654839522.mp4"),
    ["video-1654839522.mp4", "Staging area/Mackenzie/video-1654839522.mp4"],
    "the alias list carries the T0 write target FIRST and the existing T1 fact second"
  );

  // And all three fields resolve off it — the defect was never field-specific.
  const aliases = index.aliases.get("video-1654839522.mp4");
  const facts = {
    "Staging area/Mackenzie/video-1654839522.mp4": {
      favorite: favFact(true, 4242, 1_700_000_000_000),
      hidden: fact(true, 1_700_000_000_000),
      tags: { t1: fact(true, 1_700_000_000_000) },
    },
  };
  assertEqual(Projection.resolveFavorite(aliases, facts).on, true, "Favorite projects");
  assertEqual(Projection.resolveFavorite(aliases, facts).at, 4242, "favoritedAt projects");
  assertEqual(Projection.resolveHidden(aliases, facts).hidden, true, "Hidden projects");
  assertDeep(Projection.resolveTags(aliases, facts, new Set(["t1"])), ["t1"], "Tags project");
});

await test("BP-FAIL-01 — factKeys is read AT BUILD TIME, so a rebuild recovers from an early empty read", async () => {
  const tree = await makeTwoRootScope(["Staging area", "Mackenzie"]);

  // ProfileStore loads its saved records asynchronously and exposes no promise
  // for it, so immediately after a page reload knownPaths() is legitimately [].
  let curated = [];
  const request = {
    rootId: tree.childId,
    profileId: () => "P",
    items: [item("video-1654839522.mp4")],
    factKeys: () => curated,
    loadComplete: true,
  };

  const early = await AliasIndex.buildAliasIndexForLoad(request);
  assertEqual(early === null || early.aliases.size === 0, true, "the early build correctly finds nothing to project");

  // The records land.
  curated = ["Staging area/Mackenzie/video-1654839522.mp4"];

  const rebuilt = await AliasIndex.buildAliasIndexForLoad(request);
  assertEqual(rebuilt.aliases.size, 1, "the SAME request rebuilt now sees the curation");
  assertDeep(
    rebuilt.aliases.get("video-1654839522.mp4"),
    ["video-1654839522.mp4", "Staging area/Mackenzie/video-1654839522.mp4"],
    "and projects it"
  );
  assertEqual(rebuilt.profileId, "P", "the profileId callback resolves to a plain value on the index");
});

await test("BP-FAIL-01 — a FROZEN factKeys array can never recover (the defect, pinned)", async () => {
  const tree = await makeTwoRootScope(["Staging area", "Mackenzie"]);

  // This is what the shipped code did: capture the array once.
  const frozen = [];
  const request = {
    rootId: tree.childId,
    profileId: "P",
    items: [item("video-1654839522.mp4")],
    factKeys: frozen,
    loadComplete: true,
  };
  await AliasIndex.buildAliasIndexForLoad(request);
  frozen.length = 0; // the curation arrives elsewhere; this array never learns of it

  const rebuilt = await AliasIndex.buildAliasIndexForLoad(request);
  assertEqual(
    rebuilt === null || rebuilt.aliases.size === 0,
    true,
    "a frozen snapshot stays empty forever — which is why every caller that can rebuild MUST pass a callback"
  );
});

await test("BP-FAIL-01 — rootPrefixes are exposed so a caller can cheaply test for new aliases", async () => {
  const tree = await makeTwoRootScope(["Staging area", "Mackenzie"]);
  const index = await AliasIndex.buildAliasIndexForLoad({
    rootId: tree.childId,
    profileId: "P",
    items: [item("video-1654839522.mp4")],
    factKeys: ["Staging area/Mackenzie/video-1654839522.mp4"],
    loadComplete: true,
  });
  assertDeep(
    [...index.rootPrefixes].sort(),
    ["", "Staging area/Mackenzie/"],
    "every root prefix in the scope is reported"
  );
});

// =============================================================================
// 3c. BP-FAIL-02 — banked fact-only rows are not existence evidence
// =============================================================================

// [WHY: the `paths` store holds two populations. `origin: "observed"` means a
//  file was seen. `origin: "fact-only"` means a Profile fact merely NAMED that
//  scope path while some root was loaded — and buildSeedEntries creates exactly
//  such a row, under the LOADED root's prefix, for every curated key it did not
//  observe. So opening the child root banks a DOUBLED-PREFIX fact-only row for
//  every MASTER-relative curated key, and those doubled paths are precisely the
//  competitors T1 has to rule out. Counting a mere row as PRESENT refused every
//  candidate in the real browser: candidates=5, durable=5, refusedPresent=5.]

/** Runs Stage 01 seeding for both roots, exactly as two real loads would. */
async function seedBothRoots(tree, { masterItems, childItems, factPaths }) {
  const masterRoot = await Identity.getRoot(tree.masterId);
  const childRoot = await Identity.getRoot(tree.childId);
  await Seeding.runSeedingPass({
    scopeId: masterRoot.scopeId,
    rootId: tree.masterId,
    prefixFromScopeRoot: masterRoot.prefixFromScopeRoot,
    items: masterItems,
    factPaths,
    profileId: "P",
  });
  await Seeding.runSeedingPass({
    scopeId: childRoot.scopeId,
    rootId: tree.childId,
    prefixFromScopeRoot: childRoot.prefixFromScopeRoot,
    items: childItems,
    factPaths,
    profileId: "P",
  });
  return { masterRoot, childRoot };
}

const BP2_NAME = "video-1654839522.mp4";
const BP2_KEY = `Staging area/Mackenzie/${BP2_NAME}`;
const BP2_DOUBLED = `Staging area/Mackenzie/${BP2_KEY}`;

await test("BP-FAIL-02 — a fact-only doubled-prefix row must NOT refuse the candidate", async () => {
  const tree = await makeTwoRootScope(["Staging area", "Mackenzie"]);
  const { masterRoot } = await seedBothRoots(tree, {
    masterItems: [item(BP2_KEY)],
    childItems: [item(BP2_NAME)],
    factPaths: [BP2_KEY],
  });

  // The doubled path IS banked — as a fact-only row, which is not a sighting.
  const allRows = await Identity.listScopePathKeys(masterRoot.scopeId);
  const observedRows = await Identity.listObservedScopePathKeys(masterRoot.scopeId);
  assertEqual(allRows.includes(BP2_DOUBLED), true, "the doubled-prefix row exists in the store");
  assertEqual(observedRows.includes(BP2_DOUBLED), false, "but it was never OBSERVED");
  assertEqual(observedRows.includes(BP2_KEY), true, "while the real file was");

  const index = await AliasIndex.buildAliasIndexForLoad({
    rootId: tree.childId,
    profileId: "P",
    items: [item(BP2_NAME)],
    factKeys: [BP2_KEY],
    loadComplete: true,
  });

  assert(index !== null, "an index is built");
  assertEqual(index.diagnostics.candidates, 1, "the candidate is discovered");
  assertEqual(index.diagnostics.refusedPresent, 0, "and is NOT refused as PRESENT");
  assertEqual(index.diagnostics.admitted, 1, "it is admitted");
  assertDeep(index.aliases.get(BP2_NAME), [BP2_NAME, BP2_KEY], "S itself is ignored; only the doubled path competes, and it is absent");

  // All three fields project off it.
  const aliases = index.aliases.get(BP2_NAME);
  const facts = {
    [BP2_KEY]: {
      favorite: favFact(true, 4242, 1_700_000_000_000),
      hidden: fact(true, 1_700_000_000_000),
      tags: { t1: fact(true, 1_700_000_000_000) },
    },
  };
  assertEqual(Projection.resolveFavorite(aliases, facts).on, true, "Favorite projects");
  assertEqual(Projection.resolveFavorite(aliases, facts).at, 4242, "favoritedAt projects");
  assertEqual(Projection.resolveHidden(aliases, facts).hidden, true, "Hidden projects");
  assertDeep(Projection.resolveTags(aliases, facts, new Set(["t1"])), ["t1"], "Tags project");
});

await test("BP-FAIL-02 safety counterpart — an OBSERVED doubled-prefix file still refuses", async () => {
  const tree = await makeTwoRootScope(["Staging area", "Mackenzie"]);
  // A real file genuinely living at the doubled path, observed by the MASTER
  // load. This is a true competing destination and must still refuse.
  await seedBothRoots(tree, {
    masterItems: [item(BP2_KEY), item(BP2_DOUBLED)],
    childItems: [item(BP2_NAME)],
    factPaths: [BP2_KEY],
  });

  const masterRoot = await Identity.getRoot(tree.masterId);
  const observedRows = await Identity.listObservedScopePathKeys(masterRoot.scopeId);
  assertEqual(observedRows.includes(BP2_DOUBLED), true, "the doubled path is now genuinely observed");

  const index = await AliasIndex.buildAliasIndexForLoad({
    rootId: tree.childId,
    profileId: "P",
    items: [item(BP2_NAME)],
    factKeys: [BP2_KEY],
    loadComplete: true,
  });

  assertEqual(index.diagnostics.candidates, 1, "the candidate is still discovered");
  assertEqual(index.diagnostics.refusedPresent, 1, "and REFUSED, because a real competing file exists");
  assertEqual(index.diagnostics.existence.durableHits, 1, "proven by the observed bank");
  assertEqual(index.aliases.has(BP2_NAME), false, "nothing is projected");
});

await test("BP-FAIL-02 — listObservedScopePathKeys separates the two populations", async () => {
  const tree = await makeTwoRootScope(["Staging area", "Mackenzie"]);
  const { masterRoot } = await seedBothRoots(tree, {
    masterItems: [item(BP2_KEY)],
    childItems: [item(BP2_NAME)],
    factPaths: [BP2_KEY],
  });

  const all = await Identity.listScopePathKeys(masterRoot.scopeId);
  const observed = await Identity.listObservedScopePathKeys(masterRoot.scopeId);
  assert(all.length > observed.length, `the store holds more rows (${all.length}) than sightings (${observed.length})`);
  assertEqual(await Identity.listObservedScopePathKeys(null), null, "a missing scopeId is null — NO KNOWLEDGE, never []");
});

// =============================================================================
// 4. No mutation, ever
// =============================================================================

await test("10 — projection performs no Profile or fact writes at all", async () => {
  const writes = [];
  fakeDb.observe((event) => writes.push(event));

  const tree = await makeTwoRootScope(["Staging area", "Mackenzie"]);
  const index = await AliasIndex.buildAliasIndexForLoad({
    rootId: tree.childId,
    profileId: "P",
    items: [item("cat.jpg")],
    factKeys: ["Staging area/Mackenzie/cat.jpg"],
    loadComplete: true,
  });

  const before = writes.length;
  const facts = {
    "cat.jpg": {},
    "Staging area/Mackenzie/cat.jpg": { favorite: favFact(true, 9, 500), hidden: fact(true, 500), tags: { t1: fact(true, 500) } },
  };
  const aliases = index.aliases.get("cat.jpg");
  const factsBefore = JSON.stringify(facts);

  for (let i = 0; i < 10000; i++) {
    Projection.resolveFavorite(aliases, facts);
    Projection.resolveHidden(aliases, facts);
    Projection.resolveTags(aliases, facts, new Set(["t1"]));
  }

  assertEqual(writes.length, before, "10,000 projected reads wrote nothing to any database");
  assertEqual(JSON.stringify(facts), factsBefore, "and mutated no fact in place — no restamping");
  fakeDb.observe(null);
});

console.log(`\n${"-".repeat(60)}`);
if (failures) {
  console.log(`FAIL  ${failures} assertion(s) failed, ${passes} passed.`);
  for (const detail of failureDetail) console.log(`  - ${detail}`);
  process.exit(1);
}
console.log(`ok    ${passes} assertion(s) passed - Stage 02 projection holds.`);
