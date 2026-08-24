#!/usr/bin/env node
// [MEDIA-ID / STAGE-02 / LOCAL-PROJECTION]
// [WHY: the gallery renders thousands of thumbnails and reads Favorite/Hidden/
//  Tags for every one of them, every render. If projection were an async or an
//  IndexedDB-backed read, Stage 02 would be a per-thumbnail database query and
//  the app would be unusable at 20k — so "the alias index is built ONCE per load
//  and every read after that is an in-memory Map hit" is a correctness-shaped
//  performance claim, and it is asserted here by counting real database calls
//  rather than by timing anything.]
//
// Usage:  node tools/test-media-projection-perf.mjs

import { pathToFileURL } from "node:url";
import path from "node:path";
import { installFakeIndexedDB, createVirtualDirectory, settle } from "./lib/browser-test-env.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const src = (rel) => pathToFileURL(path.join(ROOT, "src", rel)).href;

const fakeDb = installFakeIndexedDB();

const Identity = await import(src("storage/media-identity.js"));
const Scope = await import(src("storage/media-scope.js"));
const Seeding = await import(src("storage/media-seeding.js"));
const AliasIndex = await import(src("storage/media-alias-index.js"));
const Projection = await import(src("profile/media-identity-projection.js"));
const Registry = await import(src("storage/library-registry.js"));

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

async function test(name, fn) {
  console.log(`\n${name}`);
  fakeDb.reset();
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

const FOLDERS = ["Cats", "Dogs", "Holidays/2023", "Family/Scans", "Live Sets"];

function buildLibrary(count) {
  const items = [];
  for (let i = 0; i < count; i++) {
    const folder = FOLDERS[i % FOLDERS.length];
    const relativePath = `${folder}/IMG_${20000 + i}.jpg`;
    items.push({ relativePath, path: relativePath, name: `IMG_${20000 + i}.jpg`, size: 1000 + i, lastModified: 1000 });
  }
  return items;
}

/** MASTER at "" plus a proven child at "Staging area/Mackenzie/". */
async function buildTwoRootScope() {
  const dir = createVirtualDirectory("MASTER");
  let child = dir.handle;
  for (const segment of ["Staging area", "Mackenzie"]) child = await child.getDirectoryHandle(segment, { create: true });

  const master = await Registry.addOrUpdateLibrary(dir.handle);
  await Scope.resolveScopeForRoot({ rootId: master.id, handle: dir.handle, sourceKind: "fsa", knownRootHandles: [] });
  const kid = await Registry.addOrUpdateLibrary(child);
  const childScope = await Scope.resolveScopeForRoot({
    rootId: kid.id,
    handle: child,
    sourceKind: "fsa",
    knownRootHandles: [{ rootId: master.id, handle: dir.handle }],
  });
  return { masterId: master.id, childId: kid.id, childScope };
}

async function measureBuild(count, curatedFraction) {
  const tree = await buildTwoRootScope();
  const items = buildLibrary(count);
  const curated = Math.round(count * curatedFraction);
  const factKeys = items.slice(0, curated).map((entry) => `Staging area/Mackenzie/${entry.relativePath}`);

  fakeDb.resetCounters();
  const started = process.hrtime.bigint();
  const index = await AliasIndex.buildAliasIndexForLoad({
    rootId: tree.childId,
    profileId: "P",
    items,
    factKeys,
    loadComplete: true,
  });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  return { index, ms, counters: { ...fakeDb.counters }, curated };
}

// ---- 19 / 20: build cost ---------------------------------------------------

await test("19 — a 1.5k library builds its alias index quickly and probes nothing", async () => {
  const { index, ms, counters, curated } = await measureBuild(1500, 0.25);
  console.log(`        1.5k: ${ms.toFixed(1)}ms, ${index.aliases.size}/${curated} aliased, getAll=${counters.getAll} getAllKeys=${counters.getAllKeys}`);
  assertEqual(index.aliases.size, curated, "every curated item is aliased");
  assertEqual(index.diagnostics.probes.fileProbes, 0, "zero file probes");
  assertEqual(index.diagnostics.probes.directoryProbes, 0, "zero directory probes");
  assert(ms < 500, `build stays well under half a second (${ms.toFixed(1)}ms)`);
});

await test("20 — a 20k library builds its alias index within budget and probes nothing", async () => {
  const { index, ms, counters, curated } = await measureBuild(20000, 0.1);
  console.log(`        20k:  ${ms.toFixed(1)}ms, ${index.aliases.size}/${curated} aliased, getAll=${counters.getAll} getAllKeys=${counters.getAllKeys}`);
  assertEqual(index.aliases.size, curated, "every curated item is aliased");
  assertEqual(index.diagnostics.probes.fileProbes, 0, "zero file probes at 20k");
  assertEqual(index.diagnostics.probes.directoryProbes, 0, "zero directory probes at 20k");
  assert(ms < 1500, `build stays inside the first-render budget (${ms.toFixed(1)}ms)`);
});

// ---- The hot read path -----------------------------------------------------

await test("hot reads perform ZERO database work — the index is load-level, not thumbnail-level", async () => {
  const { index } = await measureBuild(20000, 0.1);

  const facts = {};
  for (const [viewed, aliases] of index.aliases) {
    facts[aliases[1]] = { favorite: { v: { on: true, at: 5 }, t: 900, d: "devA" } };
    void viewed;
  }

  fakeDb.resetCounters();
  const started = process.hrtime.bigint();
  let on = 0;
  let reads = 0;
  for (const [viewed, aliases] of index.aliases) {
    for (let i = 0; i < 5; i++) {
      if (Projection.resolveFavorite(aliases, facts).on) on += 1;
      reads += 1;
    }
    void viewed;
  }
  const ms = Number(process.hrtime.bigint() - started) / 1e6;

  console.log(`        ${reads} projected reads in ${ms.toFixed(1)}ms`);
  assertEqual(fakeDb.counters.open, 0, "no database was opened during the read loop");
  assertEqual(fakeDb.counters.getAll, 0, "no full-store getAll() happened during the read loop");
  assertEqual(fakeDb.counters.getAllKeys, 0, "no index read happened during the read loop either");
  assertEqual(on, reads, "every read resolved");
  assert(ms < 1000, `${reads} reads stay under a second (${ms.toFixed(1)}ms)`);
});

// ---- The scopeId index is the read path, not a full-store scan -------------

await test("the alias build reads the scopeId INDEX and never a full paths getAll()", async () => {
  const tree = await buildTwoRootScope();
  const items = buildLibrary(2000);

  // Bank real evidence so the durable census has something to read.
  await Seeding.runSeedingPass({
    scopeId: tree.childScope.scopeId,
    rootId: tree.childId,
    prefixFromScopeRoot: tree.childScope.prefixFromScopeRoot,
    items,
    factPaths: [],
    profileId: "P",
  });

  fakeDb.resetCounters();
  await AliasIndex.buildAliasIndexForLoad({
    rootId: tree.childId,
    profileId: "P",
    items,
    factKeys: items.slice(0, 100).map((entry) => `Staging area/Mackenzie/${entry.relativePath}`),
    loadComplete: true,
  });

  assertEqual(fakeDb.counters.getAllKeys, 1, "exactly one indexed key read for the whole load");
  // getAll() is still used for the tiny `roots` store and the library registry —
  // both are one row per folder ever picked. What must never happen is a full
  // scan of `paths`, which listScopePathKeys deliberately avoids.
  assert(fakeDb.counters.getAll <= 6, `no full-store path scan; only small-store reads (getAll=${fakeDb.counters.getAll})`);

  const keys = await Identity.listScopePathKeys(tree.childScope.scopeId);
  assertEqual(Array.isArray(keys), true, "listScopePathKeys returns keys");
  assertEqual(keys.length, items.length, "and it returns every banked path for the scope");
});

await test("listScopePathKeys reports NO KNOWLEDGE rather than an empty census when the index is missing", async () => {
  const keys = await Identity.listScopePathKeys("scope-that-does-not-exist");
  // A real scope with no rows yields []; a bad argument yields null. Neither may
  // ever be confused with "this scope provably has no paths".
  assertEqual(Array.isArray(keys) && keys.length === 0, true, "an unknown scope has no keys");
  assertEqual(await Identity.listScopePathKeys(null), null, "a missing scopeId is null, not []");
});

console.log(`\n${"-".repeat(60)}`);
if (failures) {
  console.log(`FAIL  ${failures} assertion(s) failed, ${passes} passed.`);
  for (const detail of failureDetail) console.log(`  - ${detail}`);
  process.exit(1);
}
console.log(`ok    ${passes} assertion(s) passed - Stage 02 projection performance holds.`);
