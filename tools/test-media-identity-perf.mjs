#!/usr/bin/env node
// [MEDIA-ID / STAGE-01 / PERFORMANCE-TESTS]
// [WHY: the approved performance contract is not a target, it is a safety
//  property. An O(n^2) intersection is invisible at the 1.5k libraries this was
//  developed against and is minutes of frozen main thread at 20k — the exact
//  size this app is built for. A transaction-per-item is the same shape of
//  defect. Both are the kind of regression that gets introduced by an innocuous
//  refactor and is never noticed by whoever writes it, so the scaling behaviour
//  is asserted rather than eyeballed.
//
//  1.5k matches the real library the Stage 00B probe ran against (itemCount
//  1425); 20k is the top of the stated target range.]
//
// Usage:  node tools/test-media-identity-perf.mjs

import { pathToFileURL } from "node:url";
import path from "node:path";
import { installFakeIndexedDB, createVirtualDirectory, settle } from "./lib/browser-test-env.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const src = (rel) => pathToFileURL(path.join(ROOT, "src", rel)).href;

const fakeDb = installFakeIndexedDB();

const Identity = await import(src("storage/media-identity.js"));
const Scope = await import(src("storage/media-scope.js"));
const Seeding = await import(src("storage/media-seeding.js"));

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
  return assert(actual === expected, label, actual === expected ? null : `expected: ${expected}\n        actual:   ${actual}`);
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

// Deliberately nested, like a real library — a flat list would not exercise the
// path-string handling that dominates the intersection.
function buildLibrary(count) {
  const items = [];
  for (let index = 0; index < count; index++) {
    const folder = `Folder${Math.floor(index / 50)}/Sub${index % 7}`;
    items.push({
      relativePath: `${folder}/media-${index}.jpg`,
      path: `${folder}/media-${index}.jpg`,
      name: `media-${index}.jpg`,
      size: 1000 + index,
      lastModified: 1_700_000_000_000 + index,
      type: "image/jpeg",
    });
  }
  return items;
}

// ---- 1. The intersection is O(n) -------------------------------------------

await test("buildSeedEntries scales linearly, not quadratically (sabotage 10)", async () => {
  const small = buildLibrary(1500);
  const large = buildLibrary(20000);
  // Half of each library is already curated — the realistic shape, and the one
  // that actually exercises the intersection.
  const smallFacts = small.filter((_, index) => index % 2 === 0).map((entry) => entry.relativePath);
  const largeFacts = large.filter((_, index) => index % 2 === 0).map((entry) => entry.relativePath);

  const timeIt = (items, factPaths) => {
    const started = process.hrtime.bigint();
    const entries = Seeding.buildSeedEntries({
      scopeId: "scope-1",
      prefixFromScopeRoot: "Staging area/Mackenzie/",
      items,
      factPaths,
      profileId: "p1",
    });
    return { ms: Number(process.hrtime.bigint() - started) / 1e6, entries };
  };

  // Warm both paths first so JIT warmup is not mistaken for complexity.
  timeIt(small, smallFacts);
  const smallRun = timeIt(small, smallFacts);
  const largeRun = timeIt(large, largeFacts);

  assertEqual(smallRun.entries.length, 1500, "1.5k library produces one entry per path");
  assertEqual(largeRun.entries.length, 20000, "20k library produces one entry per path");

  const sizeRatio = 20000 / 1500;
  const timeRatio = largeRun.ms / Math.max(smallRun.ms, 0.05);
  console.log(`        1.5k: ${smallRun.ms.toFixed(2)}ms   20k: ${largeRun.ms.toFixed(2)}ms   ratio ${timeRatio.toFixed(1)}x (n grew ${sizeRatio.toFixed(1)}x)`);

  // Quadratic would be ~178x. A generous linear ceiling still separates the two
  // by more than an order of magnitude.
  assert(
    timeRatio < sizeRatio * 6,
    `scaling stays linear (${timeRatio.toFixed(1)}x for ${sizeRatio.toFixed(1)}x the data; quadratic would be ~${(sizeRatio * sizeRatio).toFixed(0)}x)`
  );
  assert(largeRun.ms < 2000, `20k intersection stays well under a second of CPU (${largeRun.ms.toFixed(0)}ms)`);
});

await test("The 20k intersection classifies all three populations correctly", async () => {
  const items = buildLibrary(20000);
  const factPaths = items.slice(0, 8000).map((entry) => entry.relativePath);
  // 500 curated paths that are NOT reachable at that path any more.
  for (let index = 0; index < 500; index++) factPaths.push(`Vanished/old-${index}.jpg`);

  const entries = Seeding.buildSeedEntries({
    scopeId: "scope-1",
    prefixFromScopeRoot: "",
    items,
    factPaths,
    profileId: "p1",
  });

  const anchored = entries.filter((entry) => entry.anchorState === "anchored");
  const factOnly = entries.filter((entry) => entry.origin === "fact-only");

  assertEqual(entries.length, 20500, "20000 observed plus 500 fact-only");
  assertEqual(anchored.length, 8000, "THE RETRO-ANCHOR: 8000 historical facts gained real content evidence");
  assertEqual(factOnly.length, 500, "and the genuinely lossy set is recorded rather than invisible");
  assert(
    anchored.every((entry) => entry.observedSignature && Number.isFinite(entry.observedSignature.size)),
    "every anchored entry carries a size"
  );
  assert(factOnly.every((entry) => entry.observedSignature === null), "and no fact-only entry pretends to");
});

// ---- 2. Transactions are O(n / batch), never O(n) --------------------------

await test("Transaction count is O(n / batchSize), never one per item", async () => {
  const dir = createVirtualDirectory("2");
  const scope = await Scope.resolveScopeForRoot({ rootId: "lib-master", handle: dir.handle, knownRootHandles: [] });

  const items = buildLibrary(1500);
  const stats = await Seeding.runSeedingPass({
    scopeId: scope.scopeId,
    rootId: "lib-master",
    prefixFromScopeRoot: "",
    items,
    factPaths: items.slice(0, 700).map((entry) => entry.relativePath),
    profileId: "p1",
  });

  assertEqual(stats.total, 1500, "1500 entries");
  assertEqual(stats.created, 1500, "all banked");
  // 1500 entries at the 500 default = 3 batches. One per item would be 1500.
  assertEqual(stats.batches, 3, `3 batches at the default batch size, not 1500 (${stats.batches})`);
  assert(Identity.SEED_BATCH_SIZE === 500, "and the default batch size is the approved 500");

  const rows = await Identity.listPathsInScope(scope.scopeId);
  assertEqual(rows.length, 1500, "every path is durably banked exactly once");
  assertEqual(
    rows.filter((row) => row.anchorState === "anchored").length,
    700,
    "with the retro-anchor applied to exactly the curated ones"
  );
});

// ---- 3. Seeding stays off the critical path --------------------------------

await test("Seeding yields between batches and can be superseded mid-flight", async () => {
  const dir = createVirtualDirectory("2");
  const scope = await Scope.resolveScopeForRoot({ rootId: "lib-master", handle: dir.handle, knownRootHandles: [] });
  const items = buildLibrary(1500);

  let yields = 0;
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...rest) => {
    if (ms === 0) yields += 1;
    return realSetTimeout(fn, ms, ...rest);
  };

  let batches = 0;
  const stats = await Seeding.runSeedingPass({
    scopeId: scope.scopeId,
    rootId: "lib-master",
    prefixFromScopeRoot: "",
    items,
    factPaths: [],
    profileId: "p1",
    batchSize: 250,
    // A new load arrives after two batches.
    shouldContinue: () => batches++ < 2,
  });

  globalThis.setTimeout = realSetTimeout;

  assertEqual(stats.superseded, true, "the pass abandoned itself instead of racing the new load");
  assert(stats.batches < 6, `it stopped early (${stats.batches} of 6 batches)`);
  assert(yields > 0, "and it yielded to the event loop between batches rather than blocking");

  const rows = await Identity.listPathsInScope(scope.scopeId);
  assertEqual(rows.length, 500, "the work it did complete is durable");
});

await test("A resumed 20k pass does not re-walk what it already banked", async () => {
  const dir = createVirtualDirectory("2");
  const scope = await Scope.resolveScopeForRoot({ rootId: "lib-master", handle: dir.handle, knownRootHandles: [] });
  const items = buildLibrary(20000);

  let batches = 0;
  const partial = await Seeding.runSeedingPass({
    scopeId: scope.scopeId, rootId: "lib-master", prefixFromScopeRoot: "",
    items, factPaths: [], profileId: "p1",
    shouldContinue: () => batches++ < 10,
  });
  assertEqual(partial.superseded, true, "interrupted after 10 batches");
  assertEqual(partial.created, 5000, "5000 banked so far");

  const resumed = await Seeding.runSeedingPass({
    scopeId: scope.scopeId, rootId: "lib-master", prefixFromScopeRoot: "",
    items, factPaths: [], profileId: "p1",
  });

  assertEqual(resumed.resumedFrom, 5000, "resumed exactly where it stopped");
  assertEqual(resumed.created, 15000, "created only the remainder");
  assertEqual(resumed.updated, 0, "and re-touched nothing it had already banked");

  const rows = await Identity.listPathsInScope(scope.scopeId);
  assertEqual(rows.length, 20000, "20k paths, one identity each");
  assertEqual(new Set(rows.map((row) => row.mediaId)).size, 20000, "all distinct");
});

// ---- Summary ---------------------------------------------------------------

console.log(`\n${"-".repeat(60)}`);
if (failures === 0) {
  console.log(`ok    ${passes} assertion(s) passed - MEDIA-ID Stage 01 performance holds.`);
} else {
  console.log(`FAIL  ${failures} failure(s), ${passes} passed:`);
  for (const detail of failureDetail) console.log(`  - ${detail}`);
}
process.exit(failures === 0 ? 0 : 1);
