#!/usr/bin/env node
// [MEDIA-ID / STAGE-01 / CONCURRENCY-TESTS]
// [WHY: the one invariant that cannot be allowed to fail even once is ONE media
//  identity per (scopeId, scopeRelativePath). Two ids for one file is not a
//  visible bug — it is a silent fork, where curation reached through one alias
//  is invisible through the other, forever, with no error and nothing in the UI
//  to suggest anything went wrong. Two or three same-origin tabs is the normal
//  way this app is used, so the guarantee is proven against concurrent writers
//  rather than assumed from single-tab behaviour.
//
//  IndexedDB is the authority here, not a lock: the composite key enforces
//  uniqueness and add() is the compare-and-set. navigator.locks is an
//  optimization elsewhere and is deliberately absent from these tests, because
//  correctness must not depend on it.]
//
// Usage:  node tools/test-media-identity-concurrency.mjs

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

function item(relativePath, size) {
  return {
    relativePath,
    path: relativePath,
    name: relativePath.slice(relativePath.lastIndexOf("/") + 1),
    size,
    lastModified: 1000,
  };
}

// ---- 1. The core invariant -------------------------------------------------

await test("Two tabs seeding the same unseen paths produce ONE mediaId each (sabotage 6)", async () => {
  const dir = createVirtualDirectory("2");
  const scope = await Scope.resolveScopeForRoot({ rootId: "lib-master", handle: dir.handle, knownRootHandles: [] });

  const items = Array.from({ length: 40 }, (_, index) => item(`f${index}.jpg`, index + 1));
  const common = {
    scopeId: scope.scopeId,
    prefixFromScopeRoot: "",
    items,
    factPaths: [],
    profileId: "p1",
    batchSize: 10,
  };

  // Genuinely interleaved: both passes are in flight at once, each yielding
  // between batches, exactly as two tabs would.
  const [tabA, tabB] = await Promise.all([
    Seeding.runSeedingPass({ ...common, rootId: "lib-master" }),
    Seeding.runSeedingPass({ ...common, rootId: "lib-master-tab-b" }),
  ]);

  const rows = await Identity.listPathsInScope(scope.scopeId);
  assertEqual(rows.length, 40, "exactly one row per path - no duplicates");

  const byPath = new Map();
  for (const row of rows) {
    assert(!byPath.has(row.scopeRelativePath), `no second row for ${row.scopeRelativePath}`);
    byPath.set(row.scopeRelativePath, row);
  }

  const ids = new Set(rows.map((row) => row.mediaId));
  assertEqual(ids.size, 40, "and exactly 40 distinct media identities - never 80");

  // Between them the two tabs account for every path exactly once: whoever lost
  // a race adopted the winner rather than minting a rival.
  const created = tabA.created + tabB.created;
  const adopted = tabA.adopted + tabB.adopted;
  const updated = tabA.updated + tabB.updated;
  assertEqual(created, 40, `exactly 40 creations across both tabs (created=${created})`);
  assert(adopted + updated > 0, `the losing tab adopted rather than clobbered (adopted=${adopted} updated=${updated})`);
});

await test("Three tabs racing the same single path converge on one identity", async () => {
  const dir = createVirtualDirectory("2");
  const scope = await Scope.resolveScopeForRoot({ rootId: "lib-master", handle: dir.handle, knownRootHandles: [] });

  const entry = {
    scopeId: scope.scopeId,
    scopeRelativePath: "cat.jpg",
    origin: "observed",
    anchorState: "anchored",
    observedSignature: { size: 12345, lastModified: 1, name: "cat.jpg", ext: "jpg" },
    profileId: "p1",
  };

  const results = await Promise.all([
    Identity.seedPathBatch([entry]),
    Identity.seedPathBatch([entry]),
    Identity.seedPathBatch([entry]),
  ]);

  const rows = await Identity.listPathsInScope(scope.scopeId);
  assertEqual(rows.length, 1, "one durable row");

  const durableId = rows[0].mediaId;
  for (const [index, result] of results.entries()) {
    const handedOut = result.records.get("cat.jpg").mediaId;
    assertEqual(handedOut, durableId, `tab ${index} was handed the DURABLE id, not the one it minted`);
  }

  const created = results.reduce((sum, result) => sum + result.created, 0);
  assertEqual(created, 1, "exactly one writer created it");
});

await test("A ConstraintError is handled, not thrown, and does not lose sibling writes", async () => {
  const dir = createVirtualDirectory("2");
  const scope = await Scope.resolveScopeForRoot({ rootId: "lib-master", handle: dir.handle, knownRootHandles: [] });

  const make = (name) => ({
    scopeId: scope.scopeId,
    scopeRelativePath: name,
    origin: "observed",
    anchorState: "unanchored",
    observedSignature: { size: 1, lastModified: 1, name, ext: "jpg" },
    profileId: null,
  });

  // Tab B already banked the middle path.
  const first = await Identity.seedPathBatch([make("b.jpg")]);
  const winnerId = first.records.get("b.jpg").mediaId;

  // Tab A now seeds a batch that COLLIDES on the middle entry only.
  const second = await Identity.seedPathBatch([make("a.jpg"), make("b.jpg"), make("c.jpg")]);

  assertEqual(second.records.get("b.jpg").mediaId, winnerId, "the colliding entry adopted the existing identity");
  assert(second.records.has("a.jpg") && second.records.has("c.jpg"), "and its batch-mates were still written");

  const rows = await Identity.listPathsInScope(scope.scopeId);
  assertEqual(rows.length, 3, "one conflict did not abort the whole transaction");
});

// ---- 2. Scope-level races --------------------------------------------------

await test("Two tabs racing to mint a scope for the same root converge on ONE scope", async () => {
  const dir = createVirtualDirectory("2");

  const [a, b] = await Promise.all([
    Scope.resolveScopeForRoot({ rootId: "lib-master", handle: dir.handle, knownRootHandles: [] }),
    Scope.resolveScopeForRoot({ rootId: "lib-master", handle: dir.handle, knownRootHandles: [] }),
  ]);

  assertEqual(a.scopeId, b.scopeId, "both tabs end up in the same scope");

  const root = await Identity.getRoot("lib-master");
  assertEqual(root.scopeId, a.scopeId, "and the durable root row agrees with both");

  const roots = await Identity.listRoots();
  assertEqual(roots.length, 1, "exactly one root row - the rootId key resolved the race");
});

await test("Concurrent re-base attempts apply the prefix exactly once", async () => {
  const dir = createVirtualDirectory("2");
  let deep = dir.handle;
  for (const segment of ["Staging area", "Mackenzie"]) {
    deep = await deep.getDirectoryHandle(segment, { create: true });
  }

  const sub = await Scope.resolveScopeForRoot({ rootId: "lib-sub", handle: deep, knownRootHandles: [] });
  await Seeding.runSeedingPass({
    scopeId: sub.scopeId,
    rootId: "lib-sub",
    prefixFromScopeRoot: "",
    items: [item("cat.jpg", 12345)],
    factPaths: ["cat.jpg"],
    profileId: "p1",
  });
  const before = (await Identity.listPathsInScope(sub.scopeId))[0].mediaId;

  // Both tabs read scopeVersion 1 and both try to re-base.
  const scope = await Identity.getScope(sub.scopeId);
  const [first, second] = await Promise.all([
    Identity.rebaseScope(sub.scopeId, scope.scopeVersion, {
      newScopeRootId: "lib-master",
      prefixToPrepend: "Staging area/Mackenzie/",
    }),
    Identity.rebaseScope(sub.scopeId, scope.scopeVersion, {
      newScopeRootId: "lib-master",
      prefixToPrepend: "Staging area/Mackenzie/",
    }),
  ]);

  const applied = [first, second].filter((result) => result.ok);
  assertEqual(applied.length, 1, "exactly one re-base was allowed to apply");

  const rows = await Identity.listPathsInScope(sub.scopeId);
  assertEqual(rows.length, 1, "still one row");
  assertEqual(rows[0].scopeRelativePath, "Staging area/Mackenzie/cat.jpg", "prefix applied once");
  assertEqual(rows[0].mediaId, before, "identity survived the contested re-base");

  const after = await Identity.getScope(sub.scopeId);
  assertEqual(after.scopeVersion, 2, "version advanced by exactly one");
});

// ---- Summary ---------------------------------------------------------------

console.log(`\n${"-".repeat(60)}`);
if (failures === 0) {
  console.log(`ok    ${passes} assertion(s) passed - MEDIA-ID Stage 01 concurrency holds.`);
} else {
  console.log(`FAIL  ${failures} failure(s), ${passes} passed:`);
  for (const detail of failureDetail) console.log(`  - ${detail}`);
}
process.exit(failures === 0 ? 0 : 1);
