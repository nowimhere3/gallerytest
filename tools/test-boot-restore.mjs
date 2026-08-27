#!/usr/bin/env node
// [BOOT-RESTORE / N6]
// [WHY: decideBootRestore() is the ENTIRE policy for zero-ceremony reopen —
//  a pure function over already-resolved inputs, with no I/O of its own.
//  That is deliberate (see boot-restore.js's header): it makes every branch
//  of "should boot silently restore this folder" exhaustively testable in
//  Node, without a real FileSystemDirectoryHandle or a browser permission
//  prompt. This file proves the exact table from the N6 architecture
//  handoff, plus the one property that matters most — there is no path
//  through this function that can ask for permission.]
//
// Usage:  node tools/test-boot-restore.mjs

import { pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";

const ROOT = path.resolve(import.meta.dirname, "..");
const src = (rel) => pathToFileURL(path.join(ROOT, "src", rel)).href;

const { decideBootRestore } = await import(src("storage/boot-restore.js"));

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
    actual === expected ? null : `expected: ${JSON.stringify(expected)}\n        actual:   ${JSON.stringify(actual)}`
  );
}

function assertNoRestore(decision, label) {
  return assertEqual(decision.restore, false, label);
}

function row(id, overrides = {}) {
  return { id, name: id, handle: {}, sourceKind: "fsa", removedFromRecents: false, lastOpenedAt: 1, ...overrides };
}

console.log("\n1. no rows -> no restore");
assertNoRestore(decideBootRestore({ rows: [], permissionStates: {} }), "empty rows array -> no restore");
assertNoRestore(decideBootRestore({ rows: null, permissionStates: {} }), "null rows -> no restore");
assertNoRestore(decideBootRestore({}), "missing rows entirely -> no restore");

console.log("\n2. rows exist, rows[0] permission granted -> restore rows[0]");
{
  const rows = [row("lib-1")];
  const decision = decideBootRestore({ rows, permissionStates: { "lib-1": "granted" } });
  assertEqual(decision.restore, true, "granted rows[0] -> restore: true");
  assertEqual(decision.rowId, "lib-1", "restores exactly rows[0]'s id");
}

console.log("\n3. rows[0] permission 'prompt' -> no restore");
assertNoRestore(
  decideBootRestore({ rows: [row("lib-1")], permissionStates: { "lib-1": "prompt" } }),
  "'prompt' permission -> no restore"
);

console.log("\n4. rows[0] permission 'denied' -> no restore");
assertNoRestore(
  decideBootRestore({ rows: [row("lib-1")], permissionStates: { "lib-1": "denied" } }),
  "'denied' permission -> no restore"
);

console.log("\n5. rows[0] handle missing / no queryPermission -> no restore");
{
  // The caller (main.js's readFolderPermissionForBootRestore) resolves a
  // missing handle or a missing queryPermission method to "unavailable"
  // before this function ever sees it — proving that state is handled here
  // exactly like any other non-"granted" state.
  assertNoRestore(
    decideBootRestore({ rows: [row("lib-1", { handle: null })], permissionStates: { "lib-1": "unavailable" } }),
    "missing handle resolved to 'unavailable' -> no restore"
  );
  assertNoRestore(
    decideBootRestore({ rows: [row("lib-1")], permissionStates: {} }),
    "no permissionStates entry at all -> no restore"
  );
}

console.log("\n6. queryPermission throws -> no restore");
{
  // Same shape: the caller catches the throw and resolves it to an
  // "error:<Name>" string rather than letting it propagate.
  assertNoRestore(
    decideBootRestore({ rows: [row("lib-1")], permissionStates: { "lib-1": "error:InvalidStateError" } }),
    "queryPermission throw resolved to 'error:...' -> no restore"
  );
}

console.log("\n7. rows[0] 'prompt', rows[1] 'granted' -> no restore (never fall through)");
{
  const rows = [row("lib-1"), row("lib-2")];
  const decision = decideBootRestore({
    rows,
    permissionStates: { "lib-1": "prompt", "lib-2": "granted" },
  });
  assertNoRestore(decision, "rows[0] not granted -> no restore, even though rows[1] is granted");
}

console.log("\n8. legacy / removedFromRecents rows are never candidates");
{
  assertNoRestore(
    decideBootRestore({
      rows: [row("legacy-1", { sourceKind: "legacy" })],
      permissionStates: { "legacy-1": "granted" },
    }),
    "a legacy row at rows[0], even if 'granted', is never a candidate"
  );
  assertNoRestore(
    decideBootRestore({
      rows: [row("removed-1", { removedFromRecents: true })],
      permissionStates: { "removed-1": "granted" },
    }),
    "a removedFromRecents row at rows[0], even if 'granted', is never a candidate"
  );
}

console.log("\n9. no code path can return a 'request permission' outcome");
{
  // Exhaustively enumerate every reachable outcome shape and assert none of
  // them names anything but restore:false or restore:true+rowId.
  const inputs = [
    { rows: [], permissionStates: {} },
    { rows: [row("a")], permissionStates: { a: "granted" } },
    { rows: [row("a")], permissionStates: { a: "prompt" } },
    { rows: [row("a")], permissionStates: { a: "denied" } },
    { rows: [row("a")], permissionStates: { a: "unavailable" } },
    { rows: [row("a")], permissionStates: { a: "error:AbortError" } },
    { rows: [row("a", { sourceKind: "legacy" })], permissionStates: { a: "granted" } },
    { rows: [row("a", { removedFromRecents: true })], permissionStates: { a: "granted" } },
  ];
  let sawUnexpectedShape = false;
  for (const input of inputs) {
    const decision = decideBootRestore(input);
    const keys = Object.keys(decision).sort();
    const validNoRestore = decision.restore === false && keys.join(",") === "restore";
    const validRestore = decision.restore === true && keys.join(",") === "restore,rowId" && typeof decision.rowId === "string";
    if (!validNoRestore && !validRestore) sawUnexpectedShape = true;
  }
  assert(!sawUnexpectedShape, "every decision shape is exactly {restore:false} or {restore:true, rowId}");
  assert(
    !JSON.stringify(inputs.map(decideBootRestore)).includes("request"),
    "no decision ever mentions 'request' in any form"
  );
}

// ---- 10. Integration: main.js wiring ---------------------------------------
//
// [WHY: main.js is UI-coordination wired directly to the DOM and cannot be
//  instantiated headlessly here (same constraint test-n2-device-aware-media-
//  question.mjs and test-media-library-disclosure.mjs already work around) —
//  so, matching their established pattern, this section asserts against the
//  actual attemptBootRestore() source text rather than executing it. It
//  proves the two structural guarantees the N6 handoff calls out: boot
//  restore reaches the SAME granted-folder load path a Recent-row click
//  uses (no second, parallel load implementation — P3), and it excludes
//  exactly the two explicit-click-only behaviours resumeLibrary() still has
//  (requestPermission and removeFromRecents — P1/P6).]

console.log("\n10. integration: attemptBootRestore() wiring in main.js");
{
  const mainSource = fs.readFileSync(path.join(ROOT, "src/main.js"), "utf8");
  const start = mainSource.indexOf("async function attemptBootRestore");
  const end = mainSource.indexOf("(async function initFsaLibraries");
  assert(start !== -1 && end !== -1 && end > start, "attemptBootRestore() is defined just before initFsaLibraries()");
  const fnBody = mainSource.slice(start, end);

  assert(fnBody.includes("decideBootRestore("), "attemptBootRestore() consults the pure decision function");
  assert(
    fnBody.includes("await loadFromFsaHandle(candidate.handle, candidate)"),
    "on a restore decision, boot restore calls the SAME loadFromFsaHandle() a Recent-row click uses — the shared load path"
  );
  assert(
    !fnBody.includes("requestPermission"),
    "attemptBootRestore() never calls requestPermission() — P1, no prompting at boot"
  );
  assert(
    !fnBody.includes("removeFromRecents"),
    "attemptBootRestore() never calls removeFromRecents() — P6, a boot-time failure never prunes Recents"
  );

  // resumeLibrary() itself must be untouched: it still owns both behaviours
  // excluded from boot restore, so the explicit-click path keeps working
  // exactly as before.
  const resumeStart = mainSource.indexOf("async function resumeLibrary");
  const resumeEnd = mainSource.indexOf("\n}\n", resumeStart);
  const resumeBody = mainSource.slice(resumeStart, resumeEnd);
  assert(resumeBody.includes("requestPermission"), "resumeLibrary() still requests permission on an explicit click");
  assert(resumeBody.includes("removeFromRecents"), "resumeLibrary() still prunes Recents on an explicit-click failure");
}

console.log("\n11. integration: the existing generation guard supersedes an in-flight boot restore");
{
  // loadFromFsaHandle() is the ONE place libraryLoadGeneration is bumped
  // into a fresh loadToken, and every arming call (Curation restoration,
  // N2/N3/N4) already gates on `isLibraryLoadCurrent(loadToken, ...)` /
  // `loadToken === libraryLoadGeneration` before acting. Because
  // attemptBootRestore() calls loadFromFsaHandle() with no bespoke guard of
  // its own (see section 10 above), a competing explicit load — which also
  // goes through loadFromFsaHandle() and therefore bumps the SAME counter —
  // automatically supersedes an in-flight boot restore. No new staleness
  // machinery was added for this, matching P5's instruction to reuse the
  // existing guard rather than invent one.
  const mainSource = fs.readFileSync(path.join(ROOT, "src/main.js"), "utf8");
  assert(
    mainSource.includes("const loadToken = ++libraryLoadGeneration;"),
    "loadFromFsaHandle() still bumps the single shared generation counter every call"
  );
  assert(
    (mainSource.match(/isLibraryLoadCurrent\(loadToken/g) || []).length >= 2,
    "N2/N3/N4/Stage-09 arming still gates on the same loadToken boot restore's call inherits"
  );
}

console.log(`\n${"-".repeat(60)}`);
if (failures) {
  console.log(`FAIL  ${failures} assertion(s) failed, ${passes} passed.`);
  for (const detail of failureDetail) console.log(`  - ${detail}`);
  process.exit(1);
}
console.log(`ok    ${passes} assertion(s) passed - the boot-restore decision table holds.`);
