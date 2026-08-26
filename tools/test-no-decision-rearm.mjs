// [SYNCV3 / STAGE-09 / NO-DECISION-REARM-BUG]
// Regression coverage for the manually reproduced Browser Preview failure:
// an observed semantic transition away from a declined value failed to
// invalidate the stored NO, so the later return to that value never re-armed.
//
// [WHY: the pre-existing observer suite passed `projectionCoherent: true` in
// every case. Production computes that flag from the LOCAL ROW, and
// ProfileStore#adoptMergedAssociations emits BEFORE its row-reconciliation
// loop runs — so at the only moment this code observes the transition the flag
// is structurally false. These cases therefore drive the observer with
// production-realistic projection lag instead of the fixture's optimistic
// value.]
import fs from "node:fs";
import { createAmbientProfileObserver } from "../src/profile/ambient-profile-observer.js";

let assertions = 0;
function assert(condition, message) {
  assertions += 1;
  if (!condition) throw new Error(message);
}

const LOCAL_A = "local-a";
const LIB_A = "library-a";
const A = "profile-a";
const B = "profile-b";

function harness() {
  const decisions = new Map();
  const deleted = [];
  const observer = createAmbientProfileObserver({
    loadDecision: async (libraryId) => decisions.get(libraryId) || null,
    deleteDecision: async (libraryId) => {
      deleted.push(libraryId);
      decisions.delete(libraryId);
      return true;
    },
  });
  return { observer, decisions, deleted };
}

// Production-realistic observation: the local row projection lags shared truth,
// because adoption emits before reconciling rows.
function laggingInput(currentFactValue, overrides = {}) {
  return {
    localLibraryId: LOCAL_A,
    libraryId: LIB_A,
    currentFactValue,
    activeProfileId: A,
    targetKnown: true,
    selfWriteSuppressed: false,
    projectionCoherent: false,
    ...overrides,
  };
}

function noDecisionForB() {
  return { libraryId: LIB_A, kind: "no", observedValue: B, stamp: { t: 10, d: "dev-a" }, decidedAt: 1 };
}

// ---- The full manual reproduction, end to end ----------------------------
// Device B: Active Profile A, association B, stored NO(B).
// Device A drives B -> A, then A -> B. Device B observes both.
{
  const { observer, decisions, deleted } = harness();
  decisions.set(LIB_A, noDecisionForB());

  observer.setContext({
    localLibraryId: LOCAL_A, libraryId: LIB_A, currentFactValue: B, targetKnown: true,
  });

  // 1-3. Baseline B stays quiet, and a same-value restamp must not re-arm.
  const baseline = await observer.observe(laggingInput(B));
  assert(!baseline.result.eligible, "baseline B with stored NO(B) does not offer");
  assert(baseline.pendingOffer === null, "baseline B leaves no pending offer");

  const restamp = await observer.observe(laggingInput(B));
  assert(!restamp.result.eligible, "same-value B restamp does not re-arm");
  assert(restamp.pendingOffer === null, "same-value B restamp leaves no pending offer");
  assert(deleted.length === 0, "same-value B restamp never clears the decision");
  assert(decisions.has(LIB_A), "NO(B) survives a same-value restamp");

  // 4-6. The observed semantic transition away from B must invalidate NO(B),
  // even though the local row has not been reconciled yet.
  const awayToA = await observer.observe(laggingInput(A));
  assert(awayToA.result.semanticChanged, "B -> A is a semantic change");
  assert(!awayToA.result.eligible, "A is already the Active Profile, so nothing is offered");
  assert(awayToA.decisionCleared, "observed B -> A clears the stale NO(B)");
  assert(deleted.length === 1 && deleted[0] === LIB_A, "stale NO(B) deletion targets this Library");
  assert(!decisions.has(LIB_A), "NO(B) no longer stored after the observed transition");

  // 7-10. The return to B is a new semantic opportunity and must offer once.
  const backToB = await observer.observe(laggingInput(B));
  assert(backToB.result.semanticChanged, "A -> B is a semantic change");
  assert(backToB.result.eligible, "A -> B re-arms after the decision was invalidated");
  assert(backToB.result.target === B, "the offer targets authoritative B");
  assert(backToB.pendingOffer !== null, "a pending offer exists for B");
  assert(backToB.pendingOffer.observedValue === B, "pending offer records observed B");

  // Exactly one offer: convergence restamps of B must not produce a second.
  const repeatB = await observer.observe(laggingInput(B));
  assert(!repeatB.result.eligible, "repeat B does not produce a second offer");
  assert(repeatB.pendingOffer !== null, "the single existing B offer is preserved");
  assert(deleted.length === 1, "no further decision deletion occurs");
}

// ---- Projection lag must not be able to defeat invalidation ---------------
// The same sequence with a coherent projection must behave identically.
{
  const { observer, decisions, deleted } = harness();
  decisions.set(LIB_A, noDecisionForB());
  observer.setContext({
    localLibraryId: LOCAL_A, libraryId: LIB_A, currentFactValue: B, targetKnown: true,
  });
  await observer.observe(laggingInput(B, { projectionCoherent: true }));
  await observer.observe(laggingInput(A, { projectionCoherent: true }));
  assert(deleted.length === 1, "coherent projection clears the stale decision too");
  const backToB = await observer.observe(laggingInput(B, { projectionCoherent: true }));
  assert(backToB.result.eligible, "coherent projection re-arms identically");
}

// ---- An applicable decision still suppresses without a transition ---------
// NO semantics are unchanged: while the association still means B, stay quiet.
{
  const { observer, decisions, deleted } = harness();
  decisions.set(LIB_A, noDecisionForB());
  observer.setContext({
    localLibraryId: LOCAL_A, libraryId: LIB_A, currentFactValue: A, targetKnown: true,
  });
  // A -> B with a stored NO(B): the decision applies to the current value.
  const toB = await observer.observe(laggingInput(B));
  assert(toB.result.semanticChanged, "A -> B is a semantic change");
  assert(!toB.result.eligible, "stored NO(B) still suppresses the offer for B");
  assert(!toB.decisionCleared, "an applicable NO(B) is never cleared");
  assert(deleted.length === 0, "an applicable decision is not deleted");
  assert(decisions.has(LIB_A), "applicable NO(B) remains stored");
}

// ---- The observer still switches nothing and writes no shared state -------
{
  const source = fs.readFileSync(new URL("../src/profile/ambient-profile-observer.js", import.meta.url), "utf8");
  assert(!/\bswitchProfile\s*\(/.test(source), "observer contains no switchProfile call");
  assert(!/\bsetLibrary(?:Association|Profile)\s*\(/.test(source),
    "observer contains no association-write call");
}

console.log(`no-decision re-arm regression: ${assertions} assertions passed`);
