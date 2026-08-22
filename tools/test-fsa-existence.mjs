#!/usr/bin/env node
// [MEDIA-ID / STAGE-02 / LOCAL-PROJECTION]
// [WHY: this module is the ONLY thing standing between "a proven prefix maps
//  this key here" and "therefore this Favorite belongs to this file". Every one
//  of its answers is load-bearing for a projection the user will see, and the
//  dangerous direction — reading "I could not look" as "it is not there" — is
//  invisible in a browser until somebody's curation lands on the wrong media.
//  So the three-state contract is proven by table here, including the exact
//  error names that may and may not become ABSENT.]
//
// Usage:  node tools/test-fsa-existence.mjs

import { pathToFileURL } from "node:url";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const src = (rel) => pathToFileURL(path.join(ROOT, "src", rel)).href;

const Existence = await import(src("storage/fsa-existence.js"));
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

async function test(name, fn) {
  console.log(`\n${name}`);
  Existence.setExistenceProbingEnabled(true);
  try {
    await fn();
  } catch (error) {
    failures++;
    failureDetail.push(`${name} - threw: ${error && error.stack}`);
    console.log(`  FAIL  threw: ${error && error.message}`);
  }
}

// ---- Fixture: a directory handle with scriptable failure modes -------------

function err(name) {
  const error = new Error(name);
  error.name = name;
  return error;
}

/**
 * `tree` is a plain object: nested objects are directories, `true` is a file.
 * `faults` maps "a/b" (a directory path) or "a/b.jpg" (a file path) to an error
 * name that lookup should throw instead of answering.
 */
function makeRoot(tree, { faults = {}, permission = "granted", counters = null } = {}) {
  function wrap(node, prefix) {
    return {
      kind: "directory",
      async queryPermission() {
        if (counters) counters.permission = (counters.permission || 0) + 1;
        return permission;
      },
      async getDirectoryHandle(name) {
        const full = `${prefix}${name}`;
        if (counters) counters.dir = (counters.dir || 0) + 1;
        if (faults[full]) throw err(faults[full]);
        const child = node ? node[name] : undefined;
        if (child === undefined) throw err("NotFoundError");
        if (child === true) throw err("TypeMismatchError"); // it is a file
        return wrap(child, `${full}/`);
      },
      async getFileHandle(name) {
        const full = `${prefix}${name}`;
        if (counters) counters.file = (counters.file || 0) + 1;
        if (faults[full]) throw err(faults[full]);
        const child = node ? node[name] : undefined;
        if (child === undefined) throw err("NotFoundError");
        if (child !== true) throw err("TypeMismatchError"); // it is a directory
        return { kind: "file", name };
      },
    };
  }
  return wrap(tree, "");
}

const TREE = {
  Cats: { "cat.jpg": true, "dog.jpg": true },
  Backup: { Cats: { "cat.jpg": true } },
  "notes.txt": true,
};

// ---- 1. The three states ---------------------------------------------------

await test("a resolvable file is PRESENT", async () => {
  const prober = Existence.createExistenceProber();
  assertEqual(await prober.probe("r1", makeRoot(TREE), "Cats/cat.jpg"), EXISTENCE.PRESENT, "existing file -> PRESENT");
  assertEqual(await prober.probe("r1", makeRoot(TREE), "Backup/Cats/cat.jpg"), EXISTENCE.PRESENT, "nested file -> PRESENT");
});

await test("NotFoundError is the deterministic negative and yields ABSENT", async () => {
  const prober = Existence.createExistenceProber();
  const root = makeRoot(TREE);
  assertEqual(await prober.probe("r1", root, "Cats/missing.jpg"), EXISTENCE.ABSENT, "missing leaf -> ABSENT");
  assertEqual(await prober.probe("r1", root, "Nope/cat.jpg"), EXISTENCE.ABSENT, "missing directory -> ABSENT");
  assertEqual(
    await prober.probe("r1", root, "Staging area/Mackenzie/Staging area/Mackenzie/cat.jpg"),
    EXISTENCE.ABSENT,
    "the doubled-prefix competitor -> ABSENT"
  );
});

// 13g
await test("TypeMismatchError is ALSO a deterministic negative (13g)", async () => {
  const prober = Existence.createExistenceProber();
  const root = makeRoot(TREE);
  // "notes.txt" is a file, so asking for a directory under it cannot exist.
  assertEqual(await prober.probe("r1", root, "notes.txt/cat.jpg"), EXISTENCE.ABSENT, "file-where-directory-expected -> ABSENT");
  // "Cats" is a directory, so asking for it as a FILE cannot exist.
  assertEqual(await prober.probe("r1", root, "Cats"), EXISTENCE.ABSENT, "directory-where-file-expected -> ABSENT");
});

// 13e
await test("NotAllowedError / SecurityError are UNKNOWN, never ABSENT (13e)", async () => {
  for (const name of ["NotAllowedError", "SecurityError", "InvalidStateError", "AbortError"]) {
    const prober = Existence.createExistenceProber();
    const root = makeRoot(TREE, { faults: { Cats: name } });
    assertEqual(await prober.probe("r1", root, "Cats/cat.jpg"), EXISTENCE.UNKNOWN, `${name} on a directory -> UNKNOWN`);
  }
  for (const name of ["NotAllowedError", "SecurityError"]) {
    const prober = Existence.createExistenceProber();
    const root = makeRoot(TREE, { faults: { "Cats/cat.jpg": name } });
    assertEqual(await prober.probe("r1", root, "Cats/cat.jpg"), EXISTENCE.UNKNOWN, `${name} on a file -> UNKNOWN`);
  }
});

await test("a permission state that is not granted is UNKNOWN and never escalated", async () => {
  for (const permission of ["prompt", "denied"]) {
    const counters = {};
    const prober = Existence.createExistenceProber();
    const root = makeRoot(TREE, { permission, counters });
    assertEqual(await prober.probe("r1", root, "Cats/cat.jpg"), EXISTENCE.UNKNOWN, `permission "${permission}" -> UNKNOWN`);
    assertEqual(counters.dir || 0, 0, "no directory lookup is attempted without granted permission");
    assertEqual(counters.file || 0, 0, "no file lookup is attempted without granted permission");
  }
  // requestPermission must never be reached. The fixture does not define one,
  // so a call would throw; asserting UNKNOWN proves the code never tried.
  const prober = Existence.createExistenceProber();
  assertEqual(
    await prober.probe("r1", makeRoot(TREE, { permission: "prompt" }), "Cats/cat.jpg"),
    EXISTENCE.UNKNOWN,
    "no requestPermission() escalation"
  );
});

// 13h
await test("a missing handle is UNKNOWN (13h — the legacy/no-handle root)", async () => {
  const prober = Existence.createExistenceProber();
  assertEqual(await prober.probe("r1", null, "Cats/cat.jpg"), EXISTENCE.UNKNOWN, "null handle -> UNKNOWN");
  assertEqual(await prober.probe("", makeRoot(TREE), "Cats/cat.jpg"), EXISTENCE.UNKNOWN, "no rootId -> UNKNOWN");
  assertEqual(await prober.probe("r1", { kind: "directory" }, "Cats/cat.jpg"), EXISTENCE.UNKNOWN, "handle without the API -> UNKNOWN");
});

await test("the kill switch degrades every probe to UNKNOWN", async () => {
  Existence.setExistenceProbingEnabled(false);
  const prober = Existence.createExistenceProber();
  assertEqual(await prober.probe("r1", makeRoot(TREE), "Cats/cat.jpg"), EXISTENCE.UNKNOWN, "disabled -> UNKNOWN even for an existing file");
  Existence.setExistenceProbingEnabled(true);
});

// ---- 2. Memoization (13m) --------------------------------------------------

await test("directory memoization collapses a shared missing prefix to ONE probe (13m)", async () => {
  const counters = {};
  const prober = Existence.createExistenceProber();
  const root = makeRoot(TREE, { counters });

  for (let i = 0; i < 500; i++) {
    const status = await prober.probe("r1", root, `Staging area/Mackenzie/file-${i}.jpg`);
    if (status !== EXISTENCE.ABSENT) {
      assert(false, "every doubled-prefix candidate is ABSENT");
      break;
    }
  }
  assertEqual(counters.dir, 1, "500 candidates under one absent directory cost exactly ONE directory lookup");
  assertEqual(counters.file || 0, 0, "no file lookup happens beneath an absent directory");
  assertEqual(counters.permission, 1, "permission is queried once per root, not once per probe");
  assertEqual(prober.stats.fileProbes, 0, "fileProbes stays at zero");
});

await test("a PRESENT directory is reused, and file lookups still happen per candidate", async () => {
  const counters = {};
  const prober = Existence.createExistenceProber();
  const root = makeRoot(TREE, { counters });

  assertEqual(await prober.probe("r1", root, "Cats/cat.jpg"), EXISTENCE.PRESENT, "first candidate PRESENT");
  assertEqual(await prober.probe("r1", root, "Cats/dog.jpg"), EXISTENCE.PRESENT, "second candidate PRESENT");
  assertEqual(await prober.probe("r1", root, "Cats/none.jpg"), EXISTENCE.ABSENT, "third candidate ABSENT");
  assertEqual(counters.dir, 1, "the shared PRESENT directory is walked once");
  assertEqual(counters.file, 3, "each distinct leaf is asked");
});

// ---- 3. Budget (13l) -------------------------------------------------------

await test("exhausting the file-probe budget yields UNKNOWN, which refuses (13l)", async () => {
  const counters = {};
  const prober = Existence.createExistenceProber({ fileProbeBudget: 5 });
  const root = makeRoot(TREE, { counters });

  const seen = [];
  for (let i = 0; i < 12; i++) seen.push(await prober.probe("r1", root, `Cats/f${i}.jpg`));

  assertEqual(counters.file, 5, "exactly the budgeted number of file lookups happened");
  assertEqual(seen.slice(0, 5).every((status) => status === EXISTENCE.ABSENT), true, "answers within budget are deterministic");
  assertEqual(seen.slice(5).every((status) => status === EXISTENCE.UNKNOWN), true, "answers past the budget are UNKNOWN, never ABSENT");
  assertEqual(prober.stats.budgetExhausted, true, "exhaustion is reported");
});

await test("exhausting the time budget yields UNKNOWN", async () => {
  let clock = 0;
  const prober = Existence.createExistenceProber({ msBudget: 10, now: () => (clock += 4) });
  const root = makeRoot(TREE);
  const first = await prober.probe("r1", root, "Cats/cat.jpg");
  const later = await prober.probe("r1", root, "Backup/Cats/cat.jpg");
  assert(first === EXISTENCE.PRESENT || first === EXISTENCE.UNKNOWN, "first probe answers or times out");
  assertEqual(later, EXISTENCE.UNKNOWN, "a probe past the time budget is UNKNOWN");
  assertEqual(prober.stats.budgetExhausted, true, "time exhaustion is reported");
});

// ---- 4. Non-vacuity --------------------------------------------------------

await test("the ABSENT surface is exactly two error names (sabotage guard)", async () => {
  const { isDeterministicAbsence } = Existence.__TEST__;
  assertEqual(isDeterministicAbsence(err("NotFoundError")), true, "NotFoundError proves absence");
  assertEqual(isDeterministicAbsence(err("TypeMismatchError")), true, "TypeMismatchError proves absence");
  for (const name of ["NotAllowedError", "SecurityError", "AbortError", "InvalidStateError", "QuotaExceededError", "", "TypeError"]) {
    assertEqual(isDeterministicAbsence(err(name)), false, `${name || "(unnamed)"} does NOT prove absence`);
  }
  assertEqual(isDeterministicAbsence(null), false, "a missing error proves nothing");
});

console.log(`\n${"-".repeat(60)}`);
if (failures) {
  console.log(`FAIL  ${failures} assertion(s) failed, ${passes} passed.`);
  for (const detail of failureDetail) console.log(`  - ${detail}`);
  process.exit(1);
}
console.log(`ok    ${passes} assertion(s) passed - the existence contract holds.`);
