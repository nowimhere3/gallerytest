#!/usr/bin/env node
// [MEDIA-ID / STAGE-02B / TELEMETRY]
// [WHY: Stage 02B's whole product is a claim about WHY the matcher refused, and
//  a wrong reason code is worse than no reason code — it would send Stage 03 to
//  build shared evidence for a problem the library does not actually have. So
//  every reason is proven against the code path that produces it, and the two
//  dangerous directions are asserted explicitly: a fact-only row must never
//  report as durable PRESENT (BP-FAIL-02), and an UNKNOWN must never be counted
//  as an ABSENT.
//
//  The second claim under test is that none of this costs anything. Telemetry
//  OBSERVES decisions already being made; it may not add a probe, an IndexedDB
//  read, or a second walk. That is asserted by counting, not by timing.]
//
// Usage:  node tools/test-media-projection-telemetry.mjs

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
const Telemetry = await import(src("profile/media-identity-telemetry.js"));
const Registry = await import(src("storage/library-registry.js"));

const { EXISTENCE, EXISTENCE_REASON } = Existence;
const { createRefusalLedger, formatTelemetry, createSessionHistory, normalizeExistence, TELEMETRY_LIMITS } = Telemetry;

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

function roots(...specs) {
  return specs.map(([rootId, prefixFromScopeRoot, handle = null]) => ({
    rootId,
    prefixFromScopeRoot,
    handle,
  }));
}

/** MASTER at "" plus a proven descendant at `segments`. */
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

// [MEDIA-ID / STAGE-02 / LOCAL-PROJECTION]
// Three nested roots — MASTER, MASTER/Backup, MASTER/Backup/Cats — the smallest
// arrangement where a candidate key reaches a destination ABOVE the loaded root,
// which the completeness census cannot see and a probe must answer. Copied from
// tools/test-media-projection.mjs so both files exercise the same real geometry.
async function makeNestedScope({ permission = null, withMasterCats = true, masterCatsFile = "cat.jpg" } = {}) {
  const dir = createVirtualDirectory("MASTER", permission ? { permission } : {});
  const touch = async (parent, name) => {
    const handle = await parent.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    await writable.write("x");
    await writable.close();
  };

  // `masterCatsFile` exists so a test can make the DIRECTORY resolvable while
  // the competing FILE is not — the only geometry in which the file-probe
  // budget is ever consulted, because a missing ancestor answers ABSENT first.
  if (withMasterCats) {
    const cats = await dir.handle.getDirectoryHandle("Cats", { create: true });
    await touch(cats, masterCatsFile);
  }
  const backup = await dir.handle.getDirectoryHandle("Backup", { create: true });
  const backupCats = await backup.getDirectoryHandle("Cats", { create: true });
  await touch(backupCats, "cat.jpg");

  const A = await Registry.addOrUpdateLibrary(dir.handle);
  const scopeA = await Scope.resolveScopeForRoot({ rootId: A.id, handle: dir.handle, sourceKind: "fsa", knownRootHandles: [] });
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

  return { dir, masterId: A.id, backupId: B.id, deepId: C.id, scopeA, scopeC };
}

/** Loads the DEEPEST root; the historical key "Cats/cat.jpg" reaches above it. */
async function loadDeepRoot(tree, extra = {}) {
  return AliasIndex.buildAliasIndexForLoad({
    rootId: tree.deepId,
    profileId: "P",
    items: [item("cat.jpg")],
    factKeys: ["Cats/cat.jpg"],
    loadComplete: true,
    ...extra,
  });
}

const tele = (index) => index.diagnostics.telemetry;

// =============================================================================
// A. The reason model itself (pure)
// =============================================================================

await test("A1 — the reason vocabulary is CLOSED and every code is uniquely named", async () => {
  const codes = Object.values(EXISTENCE_REASON);
  assertEqual(new Set(codes).size, codes.length, "no two reason codes share a string");
  const badPrefix = codes.filter(
    (code) => !code.startsWith("present/") && !code.startsWith("absent/") && !code.startsWith("unknown/")
  );
  assertDeep(badPrefix, [], "every code is namespaced by the status it explains");
  assert(Object.isFrozen(EXISTENCE_REASON), "the vocabulary is frozen — no caller can add a code at runtime");
});

await test("A2 — normalizeExistence accepts Stage 02's bare status and never changes a value", async () => {
  assertDeep(normalizeExistence(EXISTENCE.PRESENT), { status: "present", reason: null, detail: null }, "a bare PRESENT stays PRESENT");
  assertDeep(normalizeExistence(EXISTENCE.ABSENT), { status: "absent", reason: null, detail: null }, "a bare ABSENT stays ABSENT");
  assertDeep(
    normalizeExistence({ status: EXISTENCE.UNKNOWN, reason: EXISTENCE_REASON.BUDGET, detail: "time" }),
    { status: "unknown", reason: "unknown/budget", detail: "time" },
    "a rich answer passes through intact"
  );
  // An invented status must survive so admitCandidate can refuse it exactly as
  // Stage 02 does — normalizing it to ABSENT would be a silent admission.
  assertEqual(normalizeExistence("banana").status, "banana", "an invented status is NOT coerced");
  assertEqual(normalizeExistence(null).status, EXISTENCE.UNKNOWN, "a missing answer is UNKNOWN, which refuses");
  assertEqual(normalizeExistence(undefined).status, EXISTENCE.UNKNOWN, "so is undefined");
  assertEqual(normalizeExistence(42).status, EXISTENCE.UNKNOWN, "so is a nonsense answer");
});

await test("A3 — probeDetailed classifies every UNKNOWN cause the prober can actually reach", async () => {
  const err = (name) => {
    const error = new Error(name);
    error.name = name;
    return error;
  };
  function makeRoot(tree, { faults = {}, permission = "granted" } = {}) {
    function wrap(node, prefix) {
      return {
        kind: "directory",
        async queryPermission() {
          return permission;
        },
        async getDirectoryHandle(name) {
          const full = `${prefix}${name}`;
          if (faults[full]) throw err(faults[full]);
          const child = node ? node[name] : undefined;
          if (child === undefined) throw err("NotFoundError");
          if (child === true) throw err("TypeMismatchError");
          return wrap(child, `${full}/`);
        },
        async getFileHandle(name) {
          const full = `${prefix}${name}`;
          if (faults[full]) throw err(faults[full]);
          const child = node ? node[name] : undefined;
          if (child === undefined) throw err("NotFoundError");
          if (child !== true) throw err("TypeMismatchError");
          return { kind: "file", name };
        },
      };
    }
    return wrap(tree, "");
  }
  const TREE = { Cats: { "cat.jpg": true }, "notes.txt": true };

  const found = await Existence.createExistenceProber().probeDetailed("r", makeRoot(TREE), "Cats/cat.jpg");
  assertDeep(found, { status: "present", reason: EXISTENCE_REASON.PROBE_FOUND, detail: null }, "PRESENT is attributed to the probe");

  const missing = await Existence.createExistenceProber().probeDetailed("r", makeRoot(TREE), "Cats/nope.jpg");
  assertEqual(missing.reason, EXISTENCE_REASON.PROBE_NOT_FOUND, "NotFoundError -> absent/fsa-not-found");
  assertEqual(missing.status, EXISTENCE.ABSENT, "and it is still ABSENT");

  const mismatch = await Existence.createExistenceProber().probeDetailed("r", makeRoot(TREE), "notes.txt/cat.jpg");
  assertEqual(mismatch.reason, EXISTENCE_REASON.PROBE_TYPE_MISMATCH, "TypeMismatchError -> absent/fsa-type-mismatch");
  assertEqual(mismatch.status, EXISTENCE.ABSENT, "and it is still ABSENT");

  const denied = await Existence.createExistenceProber().probeDetailed("r", makeRoot(TREE, { faults: { "Cats": "NotAllowedError" } }), "Cats/cat.jpg");
  assertEqual(denied.status, EXISTENCE.UNKNOWN, "NotAllowedError is UNKNOWN, never ABSENT");
  assertEqual(denied.reason, EXISTENCE_REASON.FILESYSTEM_ERROR, "and is reported as a filesystem error");
  assertEqual(denied.detail, "NotAllowedError", "with the DOMException name as the bounded detail");

  const secure = await Existence.createExistenceProber().probeDetailed("r", makeRoot(TREE, { faults: { "Cats/cat.jpg": "SecurityError" } }), "Cats/cat.jpg");
  assertEqual(secure.status, EXISTENCE.UNKNOWN, "SecurityError is UNKNOWN");
  assertEqual(secure.detail, "SecurityError", "and names itself in the detail rather than in an invented code");

  const prompt = await Existence.createExistenceProber().probeDetailed("r", makeRoot(TREE, { permission: "prompt" }), "Cats/cat.jpg");
  assertEqual(prompt.reason, EXISTENCE_REASON.PERMISSION, "a non-granted permission is unknown/permission");
  assertEqual(prompt.detail, "prompt", "and the state is carried");

  const noHandle = await Existence.createExistenceProber().probeDetailed("r", {}, "Cats/cat.jpg");
  assertEqual(noHandle.reason, EXISTENCE_REASON.NO_HANDLE, "a handle without the lookup methods is unknown/no-handle");

  const countBudget = await Existence.createExistenceProber({ fileProbeBudget: 0 }).probeDetailed("r", makeRoot(TREE), "Cats/cat.jpg");
  assertEqual(countBudget.reason, EXISTENCE_REASON.BUDGET, "an exhausted file-probe budget is unknown/budget");
  assertEqual(countBudget.detail, "file-probes", "and says WHICH budget");

  const timeBudget = await Existence.createExistenceProber({ msBudget: 0 }).probeDetailed("r", makeRoot(TREE), "Cats/cat.jpg");
  assertEqual(timeBudget.reason, EXISTENCE_REASON.BUDGET, "an exhausted time budget is unknown/budget");
  assertEqual(timeBudget.detail, "time", "and is distinguishable from the count budget");

  const empty = await Existence.createExistenceProber().probeDetailed("r", makeRoot(TREE), "");
  assertEqual(empty.reason, EXISTENCE_REASON.EMPTY_PATH, "an empty destination is unknown/empty-path");

  Existence.setExistenceProbingEnabled(false);
  const off = await Existence.createExistenceProber().probeDetailed("r", makeRoot(TREE), "Cats/cat.jpg");
  assertEqual(off.reason, EXISTENCE_REASON.PROBING_DISABLED, "the kill switch is its own reason");
  assertEqual(off.status, EXISTENCE.UNKNOWN, "and it refuses");
  Existence.setExistenceProbingEnabled(true);
});

await test("A4 — probe() still answers exactly what Stage 02 asserted (probeDetailed is a widening, not a change)", async () => {
  const TREE = { Cats: { "cat.jpg": true } };
  function makeRoot() {
    function wrap(node, prefix) {
      return {
        kind: "directory",
        async queryPermission() {
          return "granted";
        },
        async getDirectoryHandle(name) {
          const child = node ? node[name] : undefined;
          if (child === undefined || child === true) {
            const error = new Error("x");
            error.name = child === true ? "TypeMismatchError" : "NotFoundError";
            throw error;
          }
          return wrap(child, `${prefix}${name}/`);
        },
        async getFileHandle(name) {
          const child = node ? node[name] : undefined;
          if (child !== true) {
            const error = new Error("x");
            error.name = child === undefined ? "NotFoundError" : "TypeMismatchError";
            throw error;
          }
          return { kind: "file", name };
        },
      };
    }
    return wrap(TREE, "");
  }
  const prober = Existence.createExistenceProber();
  for (const [target, expected] of [
    ["Cats/cat.jpg", EXISTENCE.PRESENT],
    ["Cats/nope.jpg", EXISTENCE.ABSENT],
    ["Nope/cat.jpg", EXISTENCE.ABSENT],
  ]) {
    const bare = await prober.probe("r", makeRoot(), target);
    const rich = await prober.probeDetailed("r", makeRoot(), target);
    assertEqual(bare, expected, `probe("${target}") is still ${expected}`);
    assertEqual(rich.status, bare, `probeDetailed agrees with probe for "${target}"`);
  }
});

// =============================================================================
// B. The ledger's arithmetic (pure)
// =============================================================================

function verdict(admitted, checks) {
  return { admitted, reason: admitted ? null : "x", checked: checks };
}
const check = (destination, status, reason, detail = null) => ({ destination, status, reason, detail });

await test("B1 — the DECIDING check is the last one, and earlier ABSENT proofs are still counted", async () => {
  const ledger = createRefusalLedger();
  ledger.recordCandidate({
    scopePath: "S",
    key: "K",
    verdict: verdict(false, [
      check("d1", EXISTENCE.ABSENT, EXISTENCE_REASON.CENSUS),
      check("d2", EXISTENCE.PRESENT, EXISTENCE_REASON.PROBE_FOUND),
    ]),
  });
  const snap = ledger.snapshot();
  assertEqual(snap.candidates.refusedPresent, 1, "the PRESENT check decided the refusal");
  assertEqual(snap.candidates.refusedUnknown, 0, "and it is not double counted as UNKNOWN");
  assertDeep(snap.presentBy, { "present/fsa-probe": 1 }, "attributed to the probe that proved it");
  assertDeep(snap.absentBy, { "absent/census": 1 }, "the earlier census proof is not lost");
});

await test("B2 — an UNKNOWN refusal is NEVER counted as ABSENT (sabotage: classify UNKNOWN as ABSENT)", async () => {
  const ledger = createRefusalLedger();
  ledger.recordCandidate({
    scopePath: "S",
    key: "K",
    verdict: verdict(false, [check("d1", EXISTENCE.UNKNOWN, EXISTENCE_REASON.PERMISSION, "prompt")]),
  });
  const snap = ledger.snapshot();
  assertEqual(snap.candidates.refusedUnknown, 1, "counted as UNKNOWN");
  assertEqual(snap.candidates.refusedPresent, 0, "not as PRESENT");
  assertDeep(snap.absentBy, {}, "and NOTHING was recorded as proven absent");
  assertDeep(snap.unknownBy, { "unknown/permission": 1 }, "attributed to the permission state");
  assertDeep(snap.details["unknown/permission"], { prompt: 1 }, "with the state as a bounded detail");
});

await test("B3 — items are classified as aliased / fully refused / contested / multi-alias", async () => {
  const ledger = createRefusalLedger();
  ledger.recordItem({ candidateCount: 1, admittedCount: 1 });
  ledger.recordItem({ candidateCount: 2, admittedCount: 0 });
  ledger.recordItem({ candidateCount: 2, admittedCount: 2 });
  ledger.recordItem({ candidateCount: 0, admittedCount: 0 });
  const items = ledger.snapshot().items;
  assertEqual(items.withCandidates, 3, "an item with no candidate is not counted at all");
  assertEqual(items.aliased, 2, "two items got at least one alias");
  assertEqual(items.refused, 1, "one item had candidates and got none");
  assertEqual(items.contested, 2, "two items had more than one candidate key");
  assertEqual(items.multiAlias, 1, "one item had more than one ADMITTED key");
});

await test("B4 — an oracle that answers with a bare status reports as `unattributed`, never as a guess", async () => {
  const ledger = createRefusalLedger();
  ledger.recordCandidate({ scopePath: "S", key: "K", verdict: verdict(false, [check("d", EXISTENCE.PRESENT, null)]) });
  ledger.recordCandidate({ scopePath: "S", key: "K2", verdict: verdict(false, [check("d", EXISTENCE.UNKNOWN, null)]) });
  const snap = ledger.snapshot();
  assertDeep(snap.presentBy, { "present/unattributed": 1 }, "an unattributed PRESENT says so");
  assertDeep(snap.unknownBy, { "unknown/unattributed": 1 }, "an unattributed UNKNOWN says so");
});

await test("B5 — the session history is bounded and drops the OLDEST build", async () => {
  const history = createSessionHistory(3);
  for (let i = 0; i < 10; i++) history.push({ at: i, reason: `build ${i}` });
  assertEqual(history.size, 3, "never grows past its limit");
  assertEqual(history.dropped, 7, "and reports how many it let go");
  assertDeep(history.entries().map((entry) => entry.at), [7, 8, 9], "the newest builds are the ones retained");
});

// =============================================================================
// C. End to end, against real MEDIA-ID storage
// =============================================================================

// ---- 1. ADMITTED T1 --------------------------------------------------------
await test("1 — an admitted T1 alias counts as admitted and carries NO refusal reason", async () => {
  const tree = await makeTwoRootScope(["Staging area", "Mackenzie"]);
  const index = await AliasIndex.buildAliasIndexForLoad({
    rootId: tree.childId,
    profileId: "P",
    items: [item("cat.jpg"), item("dog.jpg")],
    factKeys: ["Staging area/Mackenzie/cat.jpg"],
    loadComplete: true,
  });

  assertDeep(index.aliases.get("cat.jpg"), ["cat.jpg", "Staging area/Mackenzie/cat.jpg"], "the alias was admitted");
  const t = tele(index);
  assertEqual(t.candidates.total, 1, "one candidate was considered");
  assertEqual(t.candidates.admitted, 1, "and it was admitted");
  assertEqual(t.candidates.refusedPresent, 0, "nothing was refused for PRESENT");
  assertEqual(t.candidates.refusedUnknown, 0, "nothing was refused for UNKNOWN");
  assertDeep(t.presentBy, {}, "no PRESENT refusal reason at all");
  assertDeep(t.unknownBy, {}, "no UNKNOWN refusal reason at all");
  assertDeep(t.absentBy, { "absent/census": 1 }, "the competitor was proven absent BY THE CENSUS, with no probe");
  assertEqual(t.items.aliased, 1, "one item aliased");
  assertEqual(t.items.refused, 0, "no item fully refused");
  assertEqual(t.items.contested, 0, "and no item was contested");
  assertDeep(t.exemplars, {}, "an all-admitted build retains no path exemplars at all");
});

// ---- 2. REAL PRESENT COMPETITOR -------------------------------------------
await test("2 — a competitor observed IN THIS LOAD refuses, classified as present/observed-current", async () => {
  const tree = await makeTwoRootScope(["Backup"]);
  const index = await AliasIndex.buildAliasIndexForLoad({
    rootId: tree.masterId,
    profileId: "P",
    items: [item("Cats/cat.jpg"), item("Backup/Cats/cat.jpg")],
    factKeys: ["Cats/cat.jpg"],
    loadComplete: true,
  });

  assertEqual(index.aliases.has("Backup/Cats/cat.jpg"), false, "the backup copy is NOT aliased");
  const t = tele(index);
  assertEqual(t.candidates.refusedPresent, 1, "exactly one candidate refused for PRESENT");
  assertDeep(t.presentBy, { "present/observed-current": 1 }, "proven by THIS load's own census, with no I/O");
  assertDeep(t.unknownBy, {}, "nothing was unknown");
  assertEqual(index.diagnostics.probes.fileProbes, 0, "and no probe was needed to say so");
  assertEqual(t.items.refused, 1, "the backup item had a candidate and received none");
  assertEqual(t.items.aliased, 0, "no item was aliased in this load");
});

await test("2b — a competitor that only the FILESYSTEM knows refuses, classified as present/fsa-probe", async () => {
  const tree = await makeNestedScope({ withMasterCats: true });
  const index = await loadDeepRoot(tree);

  assertEqual(index.aliases.has("cat.jpg"), false, "the historical key is not projected");
  const t = tele(index);
  assertEqual(t.candidates.refusedPresent, 1, "refused for PRESENT");
  assertDeep(t.presentBy, { "present/fsa-probe": 1 }, "and the probe — not the census — is credited");
  assert(index.diagnostics.probes.directoryProbes >= 1, "a real probe happened");
});

// ---- 3. UNKNOWN: missing / unusable handle --------------------------------
await test("3 — a covering root with NO handle is unknown/no-handle and refuses", async () => {
  // Driven through the real resolver so the reason comes from the production
  // cascade, not from a stubbed oracle.
  // Three roots, matching makeNestedScope's geometry: the curated MASTER-relative
  // key "Cats/cat.jpg" is reached from the viewed path via the MIDDLE root, and
  // its competing destination sits ABOVE the loaded subtree where the census
  // cannot see it. None of the roots has a usable handle.
  const scopeRoots = roots(["master", "", null], ["backup", "Backup/", null], ["deep", "Backup/Cats/", null]);
  const prober = Existence.createExistenceProber();
  const resolver = AliasIndex.createStatusResolver({
    roots: scopeRoots,
    loadedPrefix: "Backup/Cats/",
    loadComplete: true,
    observedScopePaths: new Set(["Backup/Cats/cat.jpg"]),
    durableScopePaths: null,
    prober,
  });

  const { aliases, diagnostics } = await Projection.buildAliasMap({
    prefixFromScopeRoot: "Backup/Cats/",
    roots: scopeRoots,
    observed: [item("cat.jpg")],
    factKeys: ["Cats/cat.jpg"],
    statusOf: resolver.resolve,
  });

  assertEqual(diagnostics.candidates, 1, "the MASTER-relative key was discovered as a candidate");

  assertEqual(aliases.size, 0, "nothing was admitted");
  assertEqual(diagnostics.refusedUnknown, 1, "refused as UNKNOWN");
  assertDeep(diagnostics.telemetry.unknownBy, { "unknown/no-handle": 1 }, "classified as a missing/unusable handle");
  assertDeep(diagnostics.telemetry.absentBy, {}, "and nothing was mistaken for proven absence");
  assertEqual(prober.stats.fileProbes, 0, "no probe was even attempted without a handle");
});

await test("3b — a covering root whose permission is not granted is unknown/permission, with the state", async () => {
  const tree = await makeNestedScope({ permission: "prompt", withMasterCats: false });
  const index = await loadDeepRoot(tree);

  assertEqual(index.aliases.has("cat.jpg"), false, "not projected — the file is absent on disk but we cannot prove it");
  const t = tele(index);
  assertEqual(t.candidates.refusedUnknown, 1, "refused as UNKNOWN");
  assertDeep(t.unknownBy, { "unknown/permission": 1 }, "classified as a permission state");
  assertDeep(t.details["unknown/permission"], { prompt: 1 }, "and the exact state is reported");
  assertEqual(index.diagnostics.probes.fileProbes, 0, "no lookup was attempted without granted permission");
});

// ---- 4. UNKNOWN: probe / budget exhaustion --------------------------------
await test("4 — an exhausted FILE-PROBE budget is unknown/budget and never accidentally admits", async () => {
  // MASTER/Cats/ resolves but holds a different file, so the walk gets all the
  // way to the file lookup — where the budget is checked.
  const tree = await makeNestedScope({ withMasterCats: true, masterCatsFile: "other.jpg" });
  const index = await loadDeepRoot(tree, { fileProbeBudget: 0 });

  assertEqual(index.aliases.has("cat.jpg"), false, "NOT admitted — an exhausted budget costs recall, never correctness");
  const t = tele(index);
  assertEqual(t.candidates.admitted, 0, "zero admissions");
  assertEqual(t.candidates.refusedUnknown, 1, "refused as UNKNOWN");
  assertDeep(t.unknownBy, { "unknown/budget": 1 }, "classified as a budget exhaustion");
  assertDeep(t.details["unknown/budget"], { "file-probes": 1 }, "and says WHICH budget ran out");
  assertEqual(index.diagnostics.probes.budgetExhausted, true, "the prober agrees its budget is spent");
});

await test("4b — an exhausted TIME budget is distinguishable from the count budget", async () => {
  const tree = await makeNestedScope({ withMasterCats: false });
  const index = await loadDeepRoot(tree, { probeMsBudget: 0 });

  assertEqual(index.aliases.has("cat.jpg"), false, "NOT admitted");
  const t = tele(index);
  assertDeep(t.unknownBy, { "unknown/budget": 1 }, "still a budget refusal");
  assertDeep(t.details["unknown/budget"], { time: 1 }, "but attributed to the TIME budget, not the count budget");
});

// ---- 5. DURABLE OBSERVED PRESENT ------------------------------------------
await test("5 — a durable origin=observed row counts as PRESENT and is credited as such", async () => {
  const tree = await makeNestedScope({ withMasterCats: false });

  // Bank a real sighting of MASTER/Cats/cat.jpg from a previous MASTER load.
  // The file is NOT on disk in this fixture, so ONLY the durable row can prove
  // it — which is exactly what makes the credit unambiguous.
  await Seeding.runSeedingPass({
    scopeId: tree.scopeA.scopeId,
    rootId: tree.masterId,
    prefixFromScopeRoot: "",
    items: [item("Cats/cat.jpg")],
    factPaths: [],
    profileId: "P",
  });

  const index = await loadDeepRoot(tree);

  assertEqual(index.aliases.has("cat.jpg"), false, "the durable sighting refuses the projection");
  const t = tele(index);
  assertEqual(t.candidates.refusedPresent, 1, "refused for PRESENT");
  assertDeep(t.presentBy, { "present/observed-durable": 1 }, "credited to the durable observed evidence");
  assertEqual(index.diagnostics.probes.fileProbes, 0, "and the durable row answered before any filesystem probe");
});

// ---- 6. FACT-ONLY ROW ------------------------------------------------------
await test("6 — a fact-only row is NOT existence evidence (sabotage: BP-FAIL-02)", async () => {
  const tree = await makeNestedScope({ withMasterCats: false });

  // A MASTER-relative curated key that was never observed as a file. Stage 01
  // banks this as origin="fact-only".
  await Seeding.runSeedingPass({
    scopeId: tree.scopeA.scopeId,
    rootId: tree.masterId,
    prefixFromScopeRoot: "",
    items: [],
    factPaths: ["Cats/cat.jpg"],
    profileId: "P",
  });

  const all = await Identity.listScopePathKeys(tree.scopeA.scopeId);
  const observedOnly = await Identity.listObservedScopePathKeys(tree.scopeA.scopeId);
  assert(all.includes("Cats/cat.jpg"), "the fact-only row IS banked");
  assertEqual(observedOnly.includes("Cats/cat.jpg"), false, "but it is NOT in the observed-path index");

  const index = await loadDeepRoot(tree);

  assertDeep(index.aliases.get("cat.jpg"), ["cat.jpg", "Cats/cat.jpg"], "so the projection is still admitted");
  const t = tele(index);
  assertEqual(t.candidates.refusedPresent, 0, "nothing was refused for PRESENT");
  assertEqual((t.presentBy["present/observed-durable"] || 0), 0, "and no fact-only row was ever credited as durable PRESENT");
  assert(
    (t.absentBy["absent/fsa-not-found"] || 0) >= 1,
    "the competitor's absence came from a real filesystem answer, not from the fact-only row"
  );
});

// ---- 7. SAME TARGET S ------------------------------------------------------
await test("7 — a root that maps the key onto the SAME target S is not a competitor (sabotage)", async () => {
  // Two roots at the same proven prefix: every destination for the candidate key
  // collapses onto the viewed scope path itself.
  const scopeRoots = roots(["a", "Sub/"], ["b", "Sub/"]);
  const seen = [];
  const verdictOut = await Projection.admitCandidate({
    key: "cat.jpg",
    scopePath: "Sub/cat.jpg",
    roots: scopeRoots,
    statusOf: async (destination) => {
      seen.push(destination);
      return EXISTENCE.PRESENT; // the viewed item itself is, of course, present
    },
  });

  assertEqual(verdictOut.admitted, true, "admitted — its own location is not a competing destination");
  assertDeep(seen, [], "and the oracle was never asked: there was nothing to rule out");

  const ledger = createRefusalLedger();
  ledger.recordCandidate({ scopePath: "Sub/cat.jpg", key: "cat.jpg", verdict: verdictOut });
  const snap = ledger.snapshot();
  assertEqual(snap.candidates.admitted, 1, "the ledger records the admission");
  assertDeep(snap.presentBy, {}, "and records NO present-competitor refusal");
  assertDeep(snap.absentBy, {}, "and invents no absence proof either");
});

// ---- 8. NEGATIVE-ONLY FACT PATH -------------------------------------------
await test("8 — a negative-only fact path stays discoverable and is counted (sabotage: BP-FAIL-03)", async () => {
  const { ProfileStore, setFactCheckEnabled } = await import(src("profile/profile-store.js"));
  setFactCheckEnabled(true);
  const store = new ProfileStore();
  await store.whenReady?.();
  await settle(10);

  // Favourite then un-favourite: the flattened record is DELETED because it now
  // carries only default values, while the stamped fact survives.
  store.setFavorite("Cats/cat.jpg", true);
  store.setFavorite("Cats/cat.jpg", false);
  await store.whenFactsSettled();

  const knownPaths = store.knownPaths();
  const factPaths = store.getFactPaths();
  assertEqual(knownPaths.includes("Cats/cat.jpg"), false, "the flattened record is gone — knownPaths() cannot see it");
  assertEqual(factPaths.includes("Cats/cat.jpg"), true, "but getFactPaths() still reports the stamped key");

  // main.js unions both sources; here the union is fed in directly so the
  // discovery path is exercised end to end.
  const union = [...new Set([...factPaths, ...knownPaths])];
  const tree = await makeNestedScope({ withMasterCats: false });
  const index = await AliasIndex.buildAliasIndexForLoad({
    rootId: tree.deepId,
    profileId: "P",
    items: [item("cat.jpg")],
    factKeys: union,
    loadComplete: true,
  });

  const t = tele(index);
  assertEqual(t.candidates.total, 1, "the negative-only key produced a candidate");
  assertEqual(t.candidates.admitted, 1, "and it was admitted — removals project in both directions");
  assertDeep(index.aliases.get("cat.jpg"), ["cat.jpg", "Cats/cat.jpg"], "the alias names the negative-only key");
  store.closeLocalStateChannel();
});

// =============================================================================
// D. Cost and cardinality
// =============================================================================

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

// ---- 9. PERFORMANCE --------------------------------------------------------
await test("9 — the ledger asks the existence oracle NOTHING extra (sabotage: an extra probe for telemetry)", async () => {
  const scopeRoots = roots(["master", ""], ["child", "Staging area/Mackenzie/"]);
  const items = buildLibrary(400);
  const factKeys = items.map((entry) => `Staging area/Mackenzie/${entry.relativePath}`);

  async function run(ledger) {
    let calls = 0;
    const result = await Projection.buildAliasMap({
      prefixFromScopeRoot: "Staging area/Mackenzie/",
      roots: scopeRoots,
      observed: items,
      factKeys,
      statusOf: async () => {
        calls += 1;
        return { status: EXISTENCE.ABSENT, reason: EXISTENCE_REASON.CENSUS, detail: null };
      },
      ...(ledger ? { ledger } : {}),
    });
    return { calls, result };
  }

  // An inert ledger: the control. Its counters stay at zero, so any difference
  // in oracle calls could only come from the real ledger doing work of its own.
  const inert = { recordCandidate() {}, recordItem() {}, snapshot: () => null };
  const control = await run(inert);
  const measured = await run(createRefusalLedger());

  assertEqual(measured.calls, control.calls, "identical number of existence questions with and without the ledger");
  assertEqual(measured.result.aliases.size, control.result.aliases.size, "and identical admission outcomes");
  assertEqual(measured.result.diagnostics.candidates, control.result.diagnostics.candidates, "identical candidate counts");

  // [WHY THE ABSOLUTE COUNT MATTERS MORE THAN THE COMPARISON: a probe added to
  //  the shared code path would appear in BOTH runs and the two would still
  //  agree. Only pinning the exact number catches it. Each item here yields one
  //  candidate whose single competing destination is the doubled prefix — so the
  //  correct total is exactly one question per item, and nothing else.
  //  (Deliberately not >=: an inequality is what let a real sabotage pass here.)]
  assertEqual(measured.calls, items.length, "exactly ONE existence question per item — no telemetry probe was added");
  assertEqual(control.calls, items.length, "and the control agrees on the same absolute count");
});

await test("9b — a 20k library still probes nothing and does no per-item IndexedDB work", async () => {
  const dir = createVirtualDirectory("MASTER");
  let child = dir.handle;
  for (const segment of ["Staging area", "Mackenzie"]) child = await child.getDirectoryHandle(segment, { create: true });
  const master = await Registry.addOrUpdateLibrary(dir.handle);
  await Scope.resolveScopeForRoot({ rootId: master.id, handle: dir.handle, sourceKind: "fsa", knownRootHandles: [] });
  const kid = await Registry.addOrUpdateLibrary(child);
  await Scope.resolveScopeForRoot({
    rootId: kid.id,
    handle: child,
    sourceKind: "fsa",
    knownRootHandles: [{ rootId: master.id, handle: dir.handle }],
  });

  const items = buildLibrary(20000);
  const curated = 2000;
  const factKeys = items.slice(0, curated).map((entry) => `Staging area/Mackenzie/${entry.relativePath}`);

  fakeDb.resetCounters();
  const started = process.hrtime.bigint();
  const index = await AliasIndex.buildAliasIndexForLoad({
    rootId: kid.id,
    profileId: "P",
    items,
    factKeys,
    loadComplete: true,
  });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  console.log(
    `        20k: ${ms.toFixed(1)}ms, ${index.aliases.size}/${curated} aliased, ` +
      `getAll=${fakeDb.counters.getAll} getAllKeys=${fakeDb.counters.getAllKeys}`
  );

  assertEqual(index.aliases.size, curated, "every curated item is aliased");
  assertEqual(index.diagnostics.probes.fileProbes, 0, "zero file probes with telemetry on");
  assertEqual(index.diagnostics.probes.directoryProbes, 0, "zero directory probes with telemetry on");
  assertEqual(fakeDb.counters.getAllKeys, 1, "exactly one indexed key read for the whole load — not one per item");
  assert(fakeDb.counters.getAll <= 6, `no full-store path scan (getAll=${fakeDb.counters.getAll})`);
  assert(ms < 1500, `build stays inside the first-render budget (${ms.toFixed(1)}ms)`);
});

// ---- 10. DIAGNOSTIC AGGREGATION -------------------------------------------
await test("10 — identical reasons aggregate, and the output does NOT grow with the library", async () => {
  const scopeRoots = roots(["master", ""], ["child", "Sub/"]);

  async function refuseEverything(count) {
    const items = buildLibrary(count);
    const ledger = createRefusalLedger();
    const { diagnostics } = await Projection.buildAliasMap({
      prefixFromScopeRoot: "Sub/",
      roots: scopeRoots,
      observed: items,
      factKeys: items.map((entry) => `Sub/${entry.relativePath}`),
      statusOf: async () => ({ status: EXISTENCE.UNKNOWN, reason: EXISTENCE_REASON.NO_HANDLE, detail: null }),
      ledger,
    });
    return diagnostics.telemetry;
  }

  const small = await refuseEverything(100);
  const large = await refuseEverything(5000);

  assertDeep(small.unknownBy, { "unknown/no-handle": 100 }, "100 identical refusals aggregate to ONE key");
  assertDeep(large.unknownBy, { "unknown/no-handle": 5000 }, "5000 identical refusals still aggregate to ONE key");
  assertEqual(Object.keys(large.unknownBy).length, Object.keys(small.unknownBy).length, "the number of buckets does not grow with the library");

  assertEqual(
    large.exemplars["unknown/no-handle"].length,
    TELEMETRY_LIMITS.EXEMPLARS_PER_REASON,
    "path exemplars are hard capped per reason"
  );
  assertEqual(large.truncated.exemplars, 5000 - TELEMETRY_LIMITS.EXEMPLARS_PER_REASON, "and the ledger says how many it declined to keep");

  const smallLine = formatTelemetry(small);
  const largeLine = formatTelemetry(large);
  console.log(`        50x library, line grew from ${smallLine.length} to ${largeLine.length} chars`);
  assert(largeLine.length - smallLine.length <= 8, "a 50x larger library grows the diagnostic line only by the digits in its counters");
  assertEqual(smallLine.includes("IMG_"), false, "no filename ever reaches the normal diagnostic line");
  assertEqual(largeLine.includes("IMG_"), false, "not at 5000 items either");
  assertEqual(largeLine.includes("no-handle=5000"), true, "but the aggregate reason and its count ARE reported");
});

await test("10b — per-reason DETAIL values are bounded too, with an overflow counter", async () => {
  const ledger = createRefusalLedger({ detailsPerReason: 3 });
  for (let i = 0; i < 50; i++) {
    ledger.recordCandidate({
      scopePath: `S${i}`,
      key: "K",
      verdict: verdict(false, [check("d", EXISTENCE.UNKNOWN, EXISTENCE_REASON.FILESYSTEM_ERROR, `Error${i}`)]),
    });
  }
  const snap = ledger.snapshot();
  assertEqual(Object.keys(snap.details["unknown/filesystem-error"]).length, 3, "distinct detail values are capped");
  assertEqual(snap.truncated.details, 47, "and the overflow is counted rather than silently dropped");
  assertEqual(snap.unknownBy["unknown/filesystem-error"], 50, "while the REASON count stays exact");
});

console.log(`\n${"-".repeat(60)}`);
if (failures) {
  console.log(`FAIL  ${failures} assertion(s) failed, ${passes} passed.`);
  for (const detail of failureDetail) console.log(`  - ${detail}`);
  process.exit(1);
}
console.log(`ok    ${passes} assertion(s) passed - Stage 02B refusal telemetry holds.`);
// Test 8 constructs a real ProfileStore, which holds a live BroadcastChannel and
// keeps the loop alive. Same teardown as tools/test-media-projection-overlay.mjs.
process.exit(0);
