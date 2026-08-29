import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveLoadTimeSwitch } from "../src/profile/ambient-profile-decision.js";

let assertions = 0;
function assert(condition, message) {
  assertions += 1;
  if (!condition) throw new Error(message);
}

const A = "profile-a";
const B = "profile-b";
const X = "profile-x";
const Y = "profile-y";

function resolve(overrides = {}) {
  return resolveLoadTimeSwitch({
    hasSharedFact: true,
    currentFactValue: B,
    factTargetKnown: true,
    rowProfileId: B,
    rowTargetKnown: true,
    activeProfileId: A,
    decision: null,
    ...overrides,
  });
}

function expect(result, { action, target = null, clearDecision = false, reason }, label) {
  assert(result.action === action, `${label}: action is ${action}`);
  assert(result.target === target, `${label}: target is ${String(target)}`);
  assert(result.clearDecision === clearDecision, `${label}: clearDecision is ${clearDecision}`);
  if (reason) assert(result.reason === reason, `${label}: reason is ${reason}`);
}

expect(resolve(), {
  action: "switch", target: B, reason: "shared-restoration",
}, "shared fact with no decision");

// Matching decisions apply by semantic value. Run every decision with coherent
// and stale row projections to prove projection cannot influence shared policy.
for (const [kind, action, target, reason] of [
  ["no", "skip", null, "decision-no"],
  ["later", "skip-and-ask", null, "decision-later"],
  ["yes", "switch", B, "decision-yes"],
]) {
  for (const rowProfileId of [B, A]) {
    const projection = rowProfileId === B ? "coherent" : "stale";
    const matching = resolve({ rowProfileId, decision: { kind, observedValue: B, stamp: { t: 10, d: "old" } } });
    expect(matching, { action, target, reason }, `${projection} projection matching ${kind.toUpperCase()}`);
    const restamped = resolve({ rowProfileId, decision: { kind, observedValue: B, stamp: { t: 500, d: "new" } } });
    expect(restamped, { action, target, reason }, `${projection} projection restamped ${kind.toUpperCase()}`);
  }
  expect(resolve({ decision: { kind, observedValue: X } }), {
    action: "switch", target: B, clearDecision: true, reason: "decision-stale",
  }, `stale ${kind.toUpperCase()}`);
}

// Exact Architecture Delta 3 F3 matrix.
for (const [label, decision, action, target, clearDecision, reason] of [
  ["NO(B)", { kind: "no", observedValue: B }, "skip", null, false, "decision-no"],
  ["LATER(B)", { kind: "later", observedValue: B }, "skip-and-ask", null, false, "decision-later"],
  ["YES(B)", { kind: "yes", observedValue: B }, "switch", B, false, "decision-yes"],
  ["NO(A)", { kind: "no", observedValue: A }, "switch", B, true, "decision-stale"],
  ["no decision", null, "switch", B, false, "shared-restoration"],
]) {
  expect(resolve({ rowProfileId: A, activeProfileId: A, decision }), {
    action, target, clearDecision, reason,
  }, `F3 ${label}`);
}

// [SYNCV3 / STAGE-09 / LOAD-TIME-AUTHORITY-CORRECTION]
// Presence and value are separate: explicit shared null suppresses row fallback,
// while no shared fact preserves the remembered local Profile.
expect(resolve({ currentFactValue: null, factTargetKnown: false, rowProfileId: A }), {
  action: "skip", reason: "shared-target-unusable",
}, "explicit shared No Profile never falls back to row A");
expect(resolve({
  hasSharedFact: false, currentFactValue: null, factTargetKnown: false,
  rowProfileId: A, rowTargetKnown: true, activeProfileId: B,
}), {
  action: "switch", target: A, reason: "local-row-restoration",
}, "no shared fact restores local remembered A");

// Rule 0 and Stage 08 post-unlink behavior. Decisions neither influence nor
// clear when no shared association fact exists.
expect(resolve({ hasSharedFact: false, rowProfileId: A, rowTargetKnown: true, activeProfileId: B }), {
  action: "switch", target: A, reason: "local-row-restoration",
}, "known remembered local Profile");
expect(resolve({ hasSharedFact: false, rowProfileId: A, rowTargetKnown: true, activeProfileId: A }), {
  action: "skip", reason: "local-row-already-active",
}, "remembered local Profile already active");
expect(resolve({ hasSharedFact: false, rowProfileId: A, rowTargetKnown: false, activeProfileId: B }), {
  action: "skip", reason: "local-row-unusable",
}, "unknown remembered local Profile");
expect(resolve({
  hasSharedFact: false, rowProfileId: A, rowTargetKnown: true, activeProfileId: B,
  decision: { kind: "no", observedValue: A },
}), {
  action: "switch", target: A, clearDecision: false, reason: "local-row-restoration",
}, "stray decision cannot affect no-fact fallback");
expect(resolve({
  hasSharedFact: false, rowProfileId: A, rowTargetKnown: true, activeProfileId: B,
  decision: { kind: "later", observedValue: B },
}), {
  action: "switch", target: A, clearDecision: false, reason: "local-row-restoration",
}, "Stage 08 unlink keeps row Profile restoration");

// Shared action guards use fact authority. Stale-decision metadata remains
// independently derived even when the action is skip.
expect(resolve({ factTargetKnown: false }), {
  action: "skip", reason: "shared-target-unusable",
}, "unresolved shared target");
expect(resolve({ factTargetKnown: false, decision: { kind: "no", observedValue: X } }), {
  action: "skip", clearDecision: true, reason: "shared-target-unusable",
}, "unresolved target still reports stale decision");
expect(resolve({ currentFactValue: null, factTargetKnown: false, decision: { kind: "yes", observedValue: X } }), {
  action: "skip", clearDecision: true, reason: "shared-target-unusable",
}, "shared null still reports stale old decision");
expect(resolve({ activeProfileId: B }), {
  action: "skip", reason: "shared-target-already-active",
}, "authoritative shared target already active");
expect(resolve({ activeProfileId: B, decision: { kind: "no", observedValue: X } }), {
  action: "skip", clearDecision: true, reason: "shared-target-already-active",
}, "already-active target still reports stale decision");

const nonAuthority = resolve({
  currentFactValue: Y,
  rowProfileId: A,
  decision: { kind: "later", observedValue: X },
});
expect(nonAuthority, {
  action: "switch", target: Y, clearDecision: true, reason: "decision-stale",
}, "conflicting decision observedValue");
assert(nonAuthority.target !== X && nonAuthority.target !== A,
  "shared switch target is neither decision X nor row A");

for (const kind of ["no", "later", "yes"]) {
  assert(resolve({ decision: { kind, observedValue: B } }).clearDecision === false,
    `matching ${kind.toUpperCase()} does not request deletion`);
  assert(resolve({ decision: { kind, observedValue: X } }).clearDecision === true,
    `stale ${kind.toUpperCase()} requests deletion`);
}
assert(resolve().clearDecision === false, "no decision does not request deletion");

// observedValue is comparison-only. Runtime matrices distinguish the explicit
// Rule 0 row fallback from the shared-fact target-authority branch.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const relative of [
  "src/profile/ambient-profile-decision.js",
  "src/profile/association-write-suppression.js",
  "src/profile/indexeddb.js",
]) {
  const source = fs.readFileSync(path.join(ROOT, relative), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  assert(!/\bswitchProfile\s*\(/.test(source), `${relative} contains no switchProfile execution call`);
  assert(!/target\s*:\s*(?:decision\s*\.\s*)?observedValue\b/.test(source),
    `${relative} never assigns observedValue as a target`);
}

console.log(`load-time switch resolver: ${assertions} assertions passed`);
