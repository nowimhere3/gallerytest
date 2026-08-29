#!/usr/bin/env node
// [MEDIA-ID / STAGE-01 / IDENTITY-TESTS]
// [WHY: every guarantee Stage 01 claims is a guarantee about something the user
//  will never see it do. Evidence is banked silently, scopes are joined
//  silently, and a wrong answer here does not surface until Stage 02 projects
//  it — as somebody else's Favorite appearing on their media, or their own
//  curation failing to come back. Neither is discoverable by using the app, so
//  both are proven mechanically here instead.]
//
// Usage:  node tools/test-media-identity.mjs

import { pathToFileURL } from "node:url";
import path from "node:path";
import { installFakeIndexedDB, createVirtualDirectory, settle, muteConsole } from "./lib/browser-test-env.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const src = (rel) => pathToFileURL(path.join(ROOT, "src", rel)).href;

const fakeDb = installFakeIndexedDB();

const Identity = await import(src("storage/media-identity.js"));
const Scope = await import(src("storage/media-scope.js"));
const Seeding = await import(src("storage/media-seeding.js"));
const Ancestry = await import(src("storage/fsa-ancestry.js"));
const Matcher = await import(src("profile/media-identity-matcher.js"));

// ---- Tiny test runner ------------------------------------------------------

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
  Ancestry.setAncestryEnabled(true);
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

// Mirrors the real tree the Stage 00B probe ran against.
function buildMasterTree() {
  const dir = createVirtualDirectory("2");
  return dir;
}

async function makeTree(dir, segments) {
  let handle = dir.handle;
  for (const segment of segments) handle = await handle.getDirectoryHandle(segment, { create: true });
  return handle;
}

function item(relativePath, size, lastModified = 1000) {
  const name = relativePath.slice(relativePath.lastIndexOf("/") + 1);
  return { relativePath, path: relativePath, name, size, lastModified, type: "image/jpeg" };
}

async function pathsInScope(scopeId) {
  const rows = await Identity.listPathsInScope(scopeId);
  return new Map(rows.map((row) => [row.scopeRelativePath, row]));
}

// ---- 1. Ancestry contract --------------------------------------------------

await test("resolve() outcomes map to the four-state contract, and a throw is UNKNOWN", async () => {
  const dir = buildMasterTree();
  const deep = await makeTree(dir, ["Staging area", "Mackenzie"]);
  const other = createVirtualDirectory("Software");

  const self = await Ancestry.probeAncestry(dir.handle, dir.handle);
  assertEqual(self.relation, Ancestry.ANCESTRY.SELF, "same handle -> self");
  assertEqual(self.prefix, "", "self prefix is empty");

  const descendant = await Ancestry.probeAncestry(dir.handle, deep);
  assertEqual(descendant.relation, Ancestry.ANCESTRY.DESCENDANT, "deep descendant -> descendant");
  assertEqual(descendant.segments.join("/"), "Staging area/Mackenzie", "segments match the real probe result");
  assertEqual(descendant.prefix, "Staging area/Mackenzie/", "prefix is segment-joined with a trailing slash");

  const reverse = await Ancestry.probeAncestry(deep, dir.handle);
  assertEqual(reverse.relation, Ancestry.ANCESTRY.UNRELATED, "reverse -> unrelated (proven negative)");

  const unrelated = await Ancestry.probeAncestry(dir.handle, other.handle);
  assertEqual(unrelated.relation, Ancestry.ANCESTRY.UNRELATED, "unrelated folder -> unrelated");

  // Direct child was NOT independently verified in the real browser (Stage 00B
  // §7). Same code path as the deep case — no separate branch — proven here.
  const child = await makeTree(dir, ["Staging area"]);
  const single = await Ancestry.probeAncestry(dir.handle, child);
  assertEqual(single.relation, Ancestry.ANCESTRY.DESCENDANT, "direct child -> descendant");
  assertEqual(single.prefix, "Staging area/", "single-segment prefix");

  // THE case the real browser could not prove.
  const throwing = createVirtualDirectory("Denied", { resolveBehavior: "throw" });
  const denied = await makeTree(throwing, ["Inner"]);
  const blocked = await Ancestry.probeAncestry(throwing.handle, denied);
  assertEqual(blocked.relation, Ancestry.ANCESTRY.UNKNOWN, "a throw is UNKNOWN, never UNRELATED");
  assert(String(blocked.reason).startsWith("threw:"), "the reason records why");
});

await test("probeAncestry never requests permission and reports the state it saw", async () => {
  const dir = createVirtualDirectory("Prompted", { permission: "prompt" });
  const deep = await makeTree(dir, ["A", "B"]);
  let requested = false;
  dir.handle.requestPermission = async () => {
    requested = true;
    return "granted";
  };

  const result = await Ancestry.probeAncestry(dir.handle, deep);
  assertEqual(requested, false, "requestPermission was never called");
  assertEqual(result.permissionState, "prompt", "the observed permission state is recorded");
  assertEqual(result.relation, Ancestry.ANCESTRY.DESCENDANT, "and the probe still reports its result");
});

// ---- 2. Scope identity -----------------------------------------------------

await test("MASTER then descendant picked separately land in ONE scope (req: scope identity)", async () => {
  const dir = buildMasterTree();
  const deep = await makeTree(dir, ["Staging area", "Mackenzie"]);

  const master = await Scope.resolveScopeForRoot({ rootId: "lib-master", handle: dir.handle, knownRootHandles: [] });
  assertEqual(master.action, "minted", "the first root mints a scope");
  assertEqual(master.prefixFromScopeRoot, "", "the scope root has an empty prefix");

  const sub = await Scope.resolveScopeForRoot({
    rootId: "lib-sub",
    handle: deep,
    knownRootHandles: [{ rootId: "lib-master", handle: dir.handle }],
  });

  assertEqual(sub.scopeId, master.scopeId, "the descendant JOINS the master's scope, not a new one");
  assertEqual(sub.prefixFromScopeRoot, "Staging area/Mackenzie/", "and carries the proven prefix");
  assertEqual(
    Scope.toScopeRelativePath(sub.prefixFromScopeRoot, "cat.jpg"),
    "Staging area/Mackenzie/cat.jpg",
    "so a subfolder file and the same file seen from MASTER share one key"
  );
});

await test("An unrelated root gets its OWN scope", async () => {
  const dir = buildMasterTree();
  const other = createVirtualDirectory("Software");

  const master = await Scope.resolveScopeForRoot({ rootId: "lib-master", handle: dir.handle, knownRootHandles: [] });
  const foreign = await Scope.resolveScopeForRoot({
    rootId: "lib-other",
    handle: other.handle,
    knownRootHandles: [{ rootId: "lib-master", handle: dir.handle }],
  });

  assert(foreign.scopeId !== master.scopeId, "proven-unrelated roots never share a scope");
});

await test("Ancestry UNKNOWN neither joins nor excludes (sabotage 1)", async () => {
  // A master whose resolve() throws — the permission-blocked case the real
  // browser could not test.
  const dir = createVirtualDirectory("2", { resolveBehavior: "throw" });
  const deep = await makeTree(dir, ["Staging area", "Mackenzie"]);

  const master = await Scope.resolveScopeForRoot({ rootId: "lib-master", handle: dir.handle, knownRootHandles: [] });
  const sub = await Scope.resolveScopeForRoot({
    rootId: "lib-sub",
    handle: deep,
    knownRootHandles: [{ rootId: "lib-master", handle: dir.handle }],
  });

  assert(sub.scopeId !== master.scopeId, "no join happened on UNKNOWN - it is not a positive");
  const scope = await Identity.getScope(sub.scopeId);
  const attempts = scope.ancestryAttempts || [];
  assert(
    attempts.some((entry) => entry.outcome === "unknown"),
    "and the unknown outcome is recorded as a diagnostic, not silently dropped"
  );
  // The load-bearing half: it must not have been recorded as a PROVEN negative,
  // because that is what would make a later retry skip the join forever.
  assert(
    !attempts.some((entry) => entry.outcome === "unrelated"),
    "UNKNOWN was never written down as UNRELATED"
  );
});

// ---- 3. Subfolder-first, master-later re-basing ---------------------------

await test("Subfolder first, MASTER later: the scope re-bases atomically", async () => {
  const dir = buildMasterTree();
  const deep = await makeTree(dir, ["Staging area", "Mackenzie"]);

  // The user opens the SUBFOLDER first.
  const sub = await Scope.resolveScopeForRoot({ rootId: "lib-sub", handle: deep, knownRootHandles: [] });
  assertEqual(sub.action, "minted", "the subfolder mints its own scope, having no ancestor to find");

  await Seeding.runSeedingPass({
    scopeId: sub.scopeId,
    rootId: "lib-sub",
    prefixFromScopeRoot: sub.prefixFromScopeRoot,
    items: [item("cat.jpg", 12345), item("dog.jpg", 555)],
    factPaths: ["cat.jpg"],
    profileId: "profile-1",
  });

  let rows = await pathsInScope(sub.scopeId);
  assert(rows.has("cat.jpg"), "seeded under the subfolder's own terms");
  const originalMediaId = rows.get("cat.jpg").mediaId;

  // NOW the user opens MASTER.
  const master = await Scope.resolveScopeForRoot({
    rootId: "lib-master",
    handle: dir.handle,
    knownRootHandles: [{ rootId: "lib-sub", handle: deep }],
  });

  assertEqual(master.action, "rebased", "MASTER re-bases the existing scope rather than minting a rival");
  assertEqual(master.scopeId, sub.scopeId, "same scope");
  assertEqual(master.prefixFromScopeRoot, "", "MASTER becomes the scope root");

  rows = await pathsInScope(sub.scopeId);
  assert(rows.has("Staging area/Mackenzie/cat.jpg"), "every stored path was re-expressed under the new root");
  assert(!rows.has("cat.jpg"), "and the old key is GONE, not left behind as a duplicate identity");
  assertEqual(
    rows.get("Staging area/Mackenzie/cat.jpg").mediaId,
    originalMediaId,
    "the media identity SURVIVED the re-base - this is the whole point"
  );
  assertEqual(
    rows.get("Staging area/Mackenzie/cat.jpg").anchorState,
    "anchored",
    "and so did its retro-anchor"
  );

  const subRoot = await Identity.getRoot("lib-sub");
  assertEqual(subRoot.prefixFromScopeRoot, "Staging area/Mackenzie/", "the member root's prefix was re-based too");

  // Re-read, not the returned object. The returned value and the stored value
  // disagreeing is exactly what the manual re-base failure was.
  const masterRootRow = await Identity.getRoot("lib-master");
  assertEqual(masterRootRow.prefixFromScopeRoot, "", "and the new scope root's PERSISTED prefix is empty");

  const scope = await Identity.getScope(sub.scopeId);
  assertEqual(scope.scopeVersion, 2, "scopeVersion was bumped");
  assertEqual(scope.scopeRootId, "lib-master", "and the scope root moved up");
});

await test("After re-base the PERSISTED root rows are correct, and a MASTER reload does not fork identity", async () => {
  // [WHY: this reproduces a defect real Browser Preview testing found and the
  //  original re-base test missed. That test asserted the value
  //  resolveScopeForRoot RETURNED for the new master, which is the in-memory
  //  object claimRoot built moments earlier — not what was durably stored after
  //  the migration ran on top of it. Every assertion here re-reads persisted
  //  state, because "what the function said" and "what the database holds" are
  //  exactly the two things that disagreed.]
  const dir = buildMasterTree();
  const deep = await makeTree(dir, ["Staging area", "Mackenzie"]);

  // 1. Subfolder first.
  const sub = await Scope.resolveScopeForRoot({ rootId: "lib-sub", handle: deep, knownRootHandles: [] });
  await Seeding.runSeedingPass({
    scopeId: sub.scopeId, rootId: "lib-sub", prefixFromScopeRoot: sub.prefixFromScopeRoot,
    items: [item("cat.jpg", 12345), item("dog.jpg", 999)],
    factPaths: ["cat.jpg"], profileId: "p1",
  });
  const idsBefore = new Map(
    (await Identity.listPathsInScope(sub.scopeId)).map((row) => [row.scopeRelativePath, row.mediaId])
  );

  // 2. MASTER later.
  const master = await Scope.resolveScopeForRoot({
    rootId: "lib-master", handle: dir.handle,
    knownRootHandles: [{ rootId: "lib-sub", handle: deep }],
  });
  assertEqual(master.action, "rebased", "the re-base ran");

  await Seeding.runSeedingPass({
    scopeId: master.scopeId, rootId: "lib-master", prefixFromScopeRoot: master.prefixFromScopeRoot,
    items: [item("Staging area/Mackenzie/cat.jpg", 12345), item("Staging area/Mackenzie/dog.jpg", 999), item("other.jpg", 7)],
    factPaths: [], profileId: "p1",
  });

  // Req 1: the scope root points at MASTER.
  const scope = await Identity.getScope(master.scopeId);
  assertEqual(scope.scopeRootId, "lib-master", "req 1: scopeRootId points at MASTER");

  // Req 2: MASTER's PERSISTED prefix is exactly "".
  const masterRoot = await Identity.getRoot("lib-master");
  assertEqual(
    masterRoot.prefixFromScopeRoot,
    "",
    "req 2: the scope root's PERSISTED prefix is empty - it cannot be nested inside itself"
  );

  // Req 3: the old subfolder root carries exactly the proven descendant prefix.
  const subRoot = await Identity.getRoot("lib-sub");
  assertEqual(
    subRoot.prefixFromScopeRoot,
    "Staging area/Mackenzie/",
    "req 3: the old subfolder root carries exactly the proven prefix"
  );

  // Req 4: identity survived.
  const rows = await pathsInScope(master.scopeId);
  assertEqual(
    rows.get("Staging area/Mackenzie/cat.jpg").mediaId,
    idsBefore.get("cat.jpg"),
    "req 4: the mediaId minted under the subfolder survived the re-base"
  );
  assertEqual(
    rows.get("Staging area/Mackenzie/dog.jpg").mediaId,
    idsBefore.get("dog.jpg"),
    "req 4: and so did its sibling's"
  );

  // Req 5: a SECOND MASTER load must not double-prefix anything.
  const reload = await Scope.resolveScopeForRoot({
    rootId: "lib-master", handle: dir.handle,
    knownRootHandles: [{ rootId: "lib-sub", handle: deep }],
  });
  assertEqual(reload.action, "existing", "the reload recognizes the root it already knows");
  assertEqual(reload.prefixFromScopeRoot, "", "and reads back an empty prefix for the scope root");

  await Seeding.runSeedingPass({
    scopeId: reload.scopeId, rootId: "lib-master", prefixFromScopeRoot: reload.prefixFromScopeRoot,
    items: [item("Staging area/Mackenzie/cat.jpg", 12345), item("Staging area/Mackenzie/dog.jpg", 999), item("other.jpg", 7)],
    factPaths: [], profileId: "p1",
  });

  const afterReload = await pathsInScope(reload.scopeId);
  assert(
    !afterReload.has("Staging area/Mackenzie/Staging area/Mackenzie/cat.jpg"),
    "req 5: NO double-prefixed key was created"
  );
  assert(
    ![...afterReload.keys()].some((key) => key.includes("Staging area/Mackenzie/Staging area/")),
    "req 5: no doubled prefix anywhere in the scope"
  );
  assertEqual(afterReload.size, 3, "req 5: still exactly three paths, not six");
  assertEqual(
    afterReload.get("Staging area/Mackenzie/cat.jpg").mediaId,
    idsBefore.get("cat.jpg"),
    "req 5: and the reload did not fork identity - same mediaId as the very first load"
  );
});

await test("A stale re-base is refused by the scopeVersion guard (sabotage 7)", async () => {
  const dir = buildMasterTree();
  const deep = await makeTree(dir, ["Staging area", "Mackenzie"]);
  const sub = await Scope.resolveScopeForRoot({ rootId: "lib-sub", handle: deep, knownRootHandles: [] });

  await Seeding.runSeedingPass({
    scopeId: sub.scopeId,
    rootId: "lib-sub",
    prefixFromScopeRoot: "",
    items: [item("cat.jpg", 12345)],
    factPaths: [],
    profileId: "profile-1",
  });

  const first = await Identity.rebaseScope(sub.scopeId, 1, {
    newScopeRootId: "lib-master",
    prefixToPrepend: "Staging area/Mackenzie/",
  });
  assertEqual(first.ok, true, "the first re-base applies");

  // A second tab that read scopeVersion 1 before the first re-base landed.
  const second = await Identity.rebaseScope(sub.scopeId, 1, {
    newScopeRootId: "lib-master",
    prefixToPrepend: "Staging area/Mackenzie/",
  });
  assertEqual(second.ok, false, "the stale re-base is refused");
  assertEqual(second.reason, "version-conflict", "for the right reason");

  const rows = await pathsInScope(sub.scopeId);
  assert(rows.has("Staging area/Mackenzie/cat.jpg"), "the prefix was applied exactly once");
  assert(
    !rows.has("Staging area/Mackenzie/Staging area/Mackenzie/cat.jpg"),
    "NOT twice - which is the corruption the guard exists to prevent"
  );
});

// ---- 4. Capture-now seeding -----------------------------------------------

await test("Seeding banks all three populations, and retro-anchors the intersection", async () => {
  const dir = buildMasterTree();
  const scope = await Scope.resolveScopeForRoot({ rootId: "lib-master", handle: dir.handle, knownRootHandles: [] });

  const stats = await Seeding.runSeedingPass({
    scopeId: scope.scopeId,
    rootId: "lib-master",
    prefixFromScopeRoot: "",
    items: [item("Animals/Cats/cat.jpg", 12345, 777), item("Animals/Dogs/dog.jpg", 999)],
    // "gone.jpg" is in the Profile but is not reachable at that path today.
    factPaths: ["Animals/Cats/cat.jpg", "gone.jpg"],
    profileId: "profile-1",
  });

  assertEqual(stats.total, 3, "two observed plus one fact-only");
  assertEqual(stats.created, 3, "all newly minted");

  const rows = await pathsInScope(scope.scopeId);

  const anchored = rows.get("Animals/Cats/cat.jpg");
  assertEqual(anchored.anchorState, "anchored", "observed AND in facts -> anchored");
  assertEqual(anchored.origin, "observed", "origin observed");
  assertEqual(anchored.observedSignature.size, 12345, "THE RETRO-ANCHOR: a size now exists for a historical fact path");
  assertEqual(anchored.observedSignature.lastModified, 777, "mtime captured (corroborating only)");
  assertEqual(anchored.observedSignature.ext, "jpg", "extension captured");
  assertEqual(anchored.factSeenIn.join(","), "profile-1", "fact-derived evidence is PROFILE-TAGGED (sabotage 8)");

  const observedOnly = rows.get("Animals/Dogs/dog.jpg");
  assertEqual(observedOnly.anchorState, "unanchored", "observed but not curated -> unanchored");
  assertEqual(observedOnly.observedSignature.size, 999, "still captured, for future protection");
  assertEqual(observedOnly.factSeenIn.length, 0, "observed-only evidence carries NO profile tag");

  const lossy = rows.get("gone.jpg");
  assertEqual(lossy.origin, "fact-only", "in facts, not observed -> fact-only");
  assertEqual(lossy.observedSignature, null, "no signature can exist for it");
  assertEqual(lossy.factSeenIn.join(","), "profile-1", "but we know whose curation it was");
});

await test("Seeding is idempotent, and re-seeding never mints a second identity", async () => {
  const dir = buildMasterTree();
  const scope = await Scope.resolveScopeForRoot({ rootId: "lib-master", handle: dir.handle, knownRootHandles: [] });
  const items = [item("a.jpg", 1), item("b.jpg", 2)];

  const first = await Seeding.runSeedingPass({
    scopeId: scope.scopeId, rootId: "lib-master", prefixFromScopeRoot: "",
    items, factPaths: [], profileId: "p1",
  });
  const rowsBefore = await pathsInScope(scope.scopeId);
  const idBefore = rowsBefore.get("a.jpg").mediaId;

  const second = await Seeding.runSeedingPass({
    scopeId: scope.scopeId, rootId: "lib-master", prefixFromScopeRoot: "",
    items, factPaths: [], profileId: "p1",
  });

  assertEqual(first.created, 2, "first pass creates");
  assertEqual(second.created, 0, "second pass creates nothing");
  assertEqual(second.updated, 2, "it refreshes instead");

  const rowsAfter = await pathsInScope(scope.scopeId);
  assertEqual(rowsAfter.size, 2, "still exactly two rows");
  assertEqual(rowsAfter.get("a.jpg").mediaId, idBefore, "and the identity is stable across loads");
});

await test("An interrupted pass resumes without duplicating identity (resumability)", async () => {
  const dir = buildMasterTree();
  const scope = await Scope.resolveScopeForRoot({ rootId: "lib-master", handle: dir.handle, knownRootHandles: [] });
  const items = Array.from({ length: 25 }, (_, index) => item(`f${index}.jpg`, index + 1));

  let batches = 0;
  const partial = await Seeding.runSeedingPass({
    scopeId: scope.scopeId, rootId: "lib-master", prefixFromScopeRoot: "",
    items, factPaths: [], profileId: "p1", batchSize: 10,
    shouldContinue: () => batches++ < 2,
  });

  assertEqual(partial.superseded, true, "the pass was abandoned mid-way");
  const afterPartial = await pathsInScope(scope.scopeId);
  assertEqual(afterPartial.size, 20, "two batches landed");
  const survivor = afterPartial.get("f0.jpg").mediaId;

  const resumed = await Seeding.runSeedingPass({
    scopeId: scope.scopeId, rootId: "lib-master", prefixFromScopeRoot: "",
    items, factPaths: [], profileId: "p1", batchSize: 10,
  });

  assertEqual(resumed.resumedFrom, 20, "it resumed from the cursor rather than re-walking");
  const afterResume = await pathsInScope(scope.scopeId);
  assertEqual(afterResume.size, 25, "and finished the job");
  assertEqual(afterResume.get("f0.jpg").mediaId, survivor, "with no identity churn for what was already banked");
});

await test("Correctness does not depend on the cursor (it is an optimization only)", async () => {
  const dir = buildMasterTree();
  const scope = await Scope.resolveScopeForRoot({ rootId: "lib-master", handle: dir.handle, knownRootHandles: [] });
  const items = Array.from({ length: 12 }, (_, index) => item(`f${index}.jpg`, index + 1));

  let batches = 0;
  await Seeding.runSeedingPass({
    scopeId: scope.scopeId, rootId: "lib-master", prefixFromScopeRoot: "",
    items, factPaths: [], profileId: "p1", batchSize: 5,
    shouldContinue: () => batches++ < 1,
  });
  const idBefore = (await pathsInScope(scope.scopeId)).get("f0.jpg").mediaId;

  // Destroy the cursor: a resumed pass must still converge on the same result.
  await Identity.setSeedCursor(scope.scopeId, "lib-master", { index: 0, total: 0, done: false });

  const rerun = await Seeding.runSeedingPass({
    scopeId: scope.scopeId, rootId: "lib-master", prefixFromScopeRoot: "",
    items, factPaths: [], profileId: "p1", batchSize: 5,
  });

  assertEqual(rerun.resumedFrom, 0, "a mismatched cursor is distrusted and ignored");
  const rows = await pathsInScope(scope.scopeId);
  assertEqual(rows.size, 12, "the full set is present exactly once");
  assertEqual(rows.get("f0.jpg").mediaId, idBefore, "and already-banked identity is untouched");
});

await test("anchorState is a one-way upgrade", async () => {
  const dir = buildMasterTree();
  const scope = await Scope.resolveScopeForRoot({ rootId: "lib-master", handle: dir.handle, knownRootHandles: [] });

  await Seeding.runSeedingPass({
    scopeId: scope.scopeId, rootId: "lib-master", prefixFromScopeRoot: "",
    items: [item("cat.jpg", 5)], factPaths: ["cat.jpg"], profileId: "p1",
  });
  // A later load under a Profile with no curation for it at all.
  await Seeding.runSeedingPass({
    scopeId: scope.scopeId, rootId: "lib-master", prefixFromScopeRoot: "",
    items: [item("cat.jpg", 5)], factPaths: [], profileId: "p2",
  });

  const row = (await pathsInScope(scope.scopeId)).get("cat.jpg");
  assertEqual(row.anchorState, "anchored", "the retro-anchor is not discarded by a later un-curated load");
  assertEqual(row.factSeenIn.join(","), "p1", "and it stays attributed to the Profile it came from");
});

await test("Signature history records drift instead of overwriting it", async () => {
  const dir = buildMasterTree();
  const scope = await Scope.resolveScopeForRoot({ rootId: "lib-master", handle: dir.handle, knownRootHandles: [] });

  for (const size of [100, 100, 200]) {
    await Seeding.runSeedingPass({
      scopeId: scope.scopeId, rootId: "lib-master", prefixFromScopeRoot: "",
      items: [item("cat.jpg", size)], factPaths: [], profileId: "p1",
    });
  }

  const row = (await pathsInScope(scope.scopeId)).get("cat.jpg");
  assertEqual(row.signatureHistory.length, 2, "identical consecutive observations collapse; a real change is kept");
  assertEqual(row.signatureHistory[0].size, 100, "the earlier size survives");
  assertEqual(row.signatureHistory[1].size, 200, "alongside the new one, so a later match can VETO on it");
});

await test("The index stores no absolute or host-derived path (sabotage 11)", async () => {
  const dir = buildMasterTree();
  const deep = await makeTree(dir, ["Staging area", "Mackenzie"]);
  const master = await Scope.resolveScopeForRoot({ rootId: "lib-master", handle: dir.handle, knownRootHandles: [] });
  const sub = await Scope.resolveScopeForRoot({
    rootId: "lib-sub", handle: deep,
    knownRootHandles: [{ rootId: "lib-master", handle: dir.handle }],
  });

  await Seeding.runSeedingPass({
    scopeId: sub.scopeId, rootId: "lib-sub", prefixFromScopeRoot: sub.prefixFromScopeRoot,
    items: [item("cat.jpg", 1)], factPaths: [], profileId: "p1",
  });

  const serialized = JSON.stringify({
    scopes: await Identity.listScopes(),
    roots: await Identity.listRoots(),
    paths: await Identity.listPathsInScope(master.scopeId),
  });

  assert(!serialized.includes("/home/"), "no unix absolute path");
  assert(!/[A-Za-z]:\\\\/.test(serialized), "no windows drive path");
  assert(!serialized.includes("file://"), "no file URL");
  assert(serialized.includes("Staging area/Mackenzie/"), "only relative segments, which is all resolve() ever returns");
});

// ---- 5. Matcher: tiers, corroboration, veto, ambiguity --------------------

await test("T0/T1: exact and ancestry-proven lookups are deterministic", async () => {
  const index = new Map([["Staging area/Mackenzie/cat.jpg", { mediaId: "media-1" }]]);

  const exact = Matcher.matchExact(index, "Staging area/Mackenzie/cat.jpg");
  assertEqual(exact.verdict, Matcher.VERDICT.RESOLVED, "exact key resolves");
  assertEqual(exact.deterministic, true, "deterministically");

  const viaAncestry = Matcher.matchByProvenAncestry(index, "cat.jpg", "Staging area/Mackenzie/");
  assertEqual(viaAncestry.verdict, Matcher.VERDICT.RESOLVED, "a subfolder path resolves through the proven prefix");
  assertEqual(viaAncestry.mediaId, "media-1", "to the SAME media identity");
  assertEqual(viaAncestry.deterministic, true, "and it is proof, not inference");

  const noProof = Matcher.matchByProvenAncestry(index, "cat.jpg", null);
  assertEqual(noProof.verdict, Matcher.VERDICT.NONE, "with no proof there is no match");
});

function structuralCase({ storedSizes, observedSizes, subtreePrefix = "Animals/" }) {
  const storedPaths = new Set(Object.keys(storedSizes));
  const storedByPath = new Map(
    Object.entries(storedSizes).map(([path, size]) => [path, { observedSignature: size === null ? null : { size } }])
  );
  const observedPaths = Object.keys(observedSizes);
  const observedByPath = new Map(Object.entries(observedSizes).map(([path, size]) => [path, { size }]));
  return {
    observedPaths,
    observedByPath,
    candidates: [{ scopeId: "scope-1", subtreePrefix, storedPaths, storedByPath }],
  };
}

await test("T2 resolves ONLY with content corroboration", async () => {
  const corroborated = Matcher.proposeStructuralMembership(
    structuralCase({
      storedSizes: { "Animals/a.jpg": 1, "Animals/b.jpg": 2, "Animals/c.jpg": 3, "Animals/d.jpg": 4 },
      observedSizes: { "a.jpg": 1, "b.jpg": 2, "c.jpg": 3, "d.jpg": 4 },
    })
  );
  assertEqual(corroborated.verdict, Matcher.VERDICT.RESOLVED, "strong overlap PLUS matching sizes resolves");
  assertEqual(corroborated.deterministic, false, "but is explicitly not claimed as deterministic");
});

await test("T2 REFUSES on structure alone - the backup-copy case (sabotage 2)", async () => {
  // Identical layout, identical names, no size evidence at all. This is
  // "Backup/2023/" versus "2023/", and it is also every cross-device case,
  // since per-file metadata is not synced.
  const result = Matcher.proposeStructuralMembership(
    structuralCase({
      storedSizes: { "Animals/a.jpg": null, "Animals/b.jpg": null, "Animals/c.jpg": null, "Animals/d.jpg": null },
      observedSizes: { "a.jpg": 1, "b.jpg": 2, "c.jpg": 3, "d.jpg": 4 },
    })
  );
  assertEqual(result.verdict, Matcher.VERDICT.REFUSED_UNCORROBORATED, "perfect structure alone is NOT enough");
  assertEqual(result.corroborated, 0, "because nothing could be corroborated");
});

await test("A single size mismatch VETOES, it does not merely lower the score (sabotage 3)", async () => {
  const result = Matcher.proposeStructuralMembership(
    structuralCase({
      storedSizes: { "Animals/a.jpg": 1, "Animals/b.jpg": 2, "Animals/c.jpg": 3, "Animals/d.jpg": 999 },
      observedSizes: { "a.jpg": 1, "b.jpg": 2, "c.jpg": 3, "d.jpg": 4 },
    })
  );
  assertEqual(result.verdict, Matcher.VERDICT.REFUSED_VETOED, "one disagreeing file blocks the whole match");
  assertEqual(result.mismatched, 1, "and says how many");
  assert(
    result.verdict !== Matcher.VERDICT.RESOLVED,
    "three corroborations do NOT outvote one contradiction"
  );
});

await test("Two similar sibling subtrees refuse at SUBTREE granularity (sabotage 5)", async () => {
  const shared = { "a.jpg": 1, "b.jpg": 2, "c.jpg": 3, "d.jpg": 4 };
  const build = (prefix) => ({
    scopeId: `scope-${prefix}`,
    subtreePrefix: prefix,
    storedPaths: new Set(Object.keys(shared).map((name) => `${prefix}${name}`)),
    storedByPath: new Map(
      Object.entries(shared).map(([name, size]) => [`${prefix}${name}`, { observedSignature: { size } }])
    ),
  });

  const result = Matcher.proposeStructuralMembership({
    observedPaths: Object.keys(shared),
    observedByPath: new Map(Object.entries(shared).map(([name, size]) => [name, { size }])),
    candidates: [build("2023/Cats/"), build("2024/Cats/")],
  });

  assertEqual(result.verdict, Matcher.VERDICT.REFUSED_AMBIGUOUS, "a near-tie refuses instead of guessing");
  assertEqual(result.candidateScopeIds.length, 2, "and names both candidates");
});

await test("T3 never unifies two paths observed in the SAME load (duplicate rule)", async () => {
  const candidates = [{ scopeRelativePath: "copy/cat.jpg", mediaId: "media-2", observedSignature: { size: 5, name: "cat.jpg", lastModified: 1 } }];
  const signature = { size: 5, name: "cat.jpg", lastModified: 1 };

  const together = Matcher.matchBySignature({
    signature,
    candidates,
    observedThisLoad: new Set(["copy/cat.jpg"]),
  });
  assertEqual(together.verdict, Matcher.VERDICT.NONE, "byte-identical files present TOGETHER are two items, not one");

  const vanished = Matcher.matchBySignature({ signature, candidates, observedThisLoad: new Set() });
  assertEqual(vanished.verdict, Matcher.VERDICT.RESOLVED, "but a vanished path may be reconciled against an appeared one");
});

await test("T3 refuses a genuine name+size collision (sabotage 4)", async () => {
  const candidates = [
    { scopeRelativePath: "x/cat.jpg", mediaId: "media-1", observedSignature: { size: 5, name: "cat.jpg", lastModified: 1 } },
    { scopeRelativePath: "y/cat.jpg", mediaId: "media-2", observedSignature: { size: 5, name: "cat.jpg", lastModified: 1 } },
  ];
  const result = Matcher.matchBySignature({
    signature: { size: 5, name: "cat.jpg", lastModified: 1 },
    candidates,
    observedThisLoad: new Set(),
  });
  assertEqual(result.verdict, Matcher.VERDICT.REFUSED_AMBIGUOUS, "two equally good candidates -> refuse");
  assertEqual(result.mediaId, null, "and no identity is handed out");
});

await test("mtime may break a tie but never create a match", async () => {
  const candidates = [
    { scopeRelativePath: "x/cat.jpg", mediaId: "media-1", observedSignature: { size: 5, name: "cat.jpg", lastModified: 111 } },
    { scopeRelativePath: "y/cat.jpg", mediaId: "media-2", observedSignature: { size: 5, name: "cat.jpg", lastModified: 222 } },
  ];
  const broken = Matcher.matchBySignature({
    signature: { size: 5, name: "cat.jpg", lastModified: 222 },
    candidates, observedThisLoad: new Set(),
  });
  assertEqual(broken.verdict, Matcher.VERDICT.RESOLVED, "a unique mtime resolves the tie");
  assertEqual(broken.mediaId, "media-2", "to the right one");

  const sizeMismatch = Matcher.matchBySignature({
    signature: { size: 6, name: "cat.jpg", lastModified: 222 },
    candidates, observedThisLoad: new Set(),
  });
  assertEqual(sizeMismatch.verdict, Matcher.VERDICT.NONE, "a matching mtime cannot rescue a size mismatch");
});

await test("T3L exploits legacy sampleEntries as real historical path->size evidence", async () => {
  // The literal shape legacy-library-signature.js persists.
  const sizes = Matcher.parseLegacySampleEntries(["Animals/Cats/cat.jpg|12345", "Animals/Dogs/dog.jpg|999"]);
  assertEqual(sizes.get("Animals/Cats/cat.jpg"), 12345, "parsed a historical size for a historical path");

  const observed = new Map([["Moved/cat.jpg", { size: 12345, name: "cat.jpg" }]]);
  const found = Matcher.matchByLegacySample({
    historicalPath: "Animals/Cats/cat.jpg",
    sizesByPath: sizes,
    observedByPath: observed,
    observedThisLoad: new Set(["Moved/cat.jpg"]),
  });
  assertEqual(found.verdict, Matcher.VERDICT.RESOLVED, "an upstream rename is recoverable from evidence that predates MEDIA-ID");
  assertEqual(found.matchedPath, "Moved/cat.jpg", "at its new path");

  const unsampled = Matcher.matchByLegacySample({
    historicalPath: "Never/Sampled.jpg",
    sizesByPath: sizes,
    observedByPath: observed,
  });
  assertEqual(unsampled.verdict, Matcher.VERDICT.NONE, "a path outside the ~2% sample simply has no evidence");
  assertEqual(unsampled.reason, "not-sampled", "and says so honestly rather than guessing");
});

// ---- 6. Storage boundary ---------------------------------------------------

await test("MEDIA-ID uses its own database, never the profile or registry ones (sabotage 9)", async () => {
  const dir = buildMasterTree();
  const scope = await Scope.resolveScopeForRoot({ rootId: "lib-master", handle: dir.handle, knownRootHandles: [] });
  await Seeding.runSeedingPass({
    scopeId: scope.scopeId, rootId: "lib-master", prefixFromScopeRoot: "",
    items: [item("cat.jpg", 1)], factPaths: [], profileId: "p1",
  });

  const names = [...fakeDb.databases.keys()];
  assert(names.includes("browser-gallery-media-identity"), `media identity DB exists: ${names.join(", ")}`);
  assert(!names.includes("loop-browser-gallery-fsa"), "the library registry database was never opened");
  assert(!names.some((name) => name.includes("profile")), `no profile database was touched: ${names.join(", ")}`);
});

// ---- Summary ---------------------------------------------------------------

console.log(`\n${"-".repeat(60)}`);
if (failures === 0) {
  console.log(`ok    ${passes} assertion(s) passed - MEDIA-ID Stage 01 holds.`);
} else {
  console.log(`FAIL  ${failures} failure(s), ${passes} passed:`);
  for (const detail of failureDetail) console.log(`  - ${detail}`);
}
process.exit(failures === 0 ? 0 : 1);
