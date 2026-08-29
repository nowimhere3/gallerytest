import fs from "node:fs";
import { createAmbientProfileObserver } from "../src/profile/ambient-profile-observer.js";

let assertions = 0;
function assert(condition, message) {
  assertions += 1;
  if (!condition) throw new Error(message);
}

const LOCAL_A = "local-a";
const LOCAL_B = "local-b";
const LIB_A = "library-a";
const LIB_B = "library-b";
const A = "profile-a";
const B = "profile-b";
const C = "profile-c";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

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

function input(overrides = {}) {
  return {
    localLibraryId: LOCAL_A,
    libraryId: LIB_A,
    currentFactValue: B,
    activeProfileId: A,
    targetKnown: true,
    // [SYNCV3 / STAGE-09 / NO-DECISION-REARM-BUG]
    // [WHY: this fixture used to pass `projectionCoherent: true`, which the
    // observer required before invalidating a stale decision. Production could
    // never satisfy it at that moment, so the suite passed while the real path
    // failed. The observer no longer accepts projection state at all.]
    ...overrides,
  };
}

// Initial context is a baseline, not an ambient transition.
{
  const { observer } = harness();
  const start = observer.setContext({
    localLibraryId: LOCAL_A, libraryId: LIB_A, currentFactValue: B, targetKnown: true,
  });
  assert(start.loadState.semanticValue === B, "initial load state records authoritative B");
  const result = await observer.observe(input());
  assert(!result.result.eligible, "initial B does not create an ambient offer");
  assert(result.pendingOffer === null, "initial context has no pending offer");
}

// Matching LATER on reopen explicitly arms the same pending slot without
// fabricating an ambient transition; ordinary refresh cannot duplicate it.
{
  const { observer, decisions } = harness();
  decisions.set(LIB_A, { kind: "later", observedValue: B });
  observer.setContext({ localLibraryId: LOCAL_A, libraryId: LIB_A, currentFactValue: B, targetKnown: true });
  assert(observer.armLoadTimeOffer({ localLibraryId: LOCAL_A, libraryId: LIB_A, currentFactValue: B }),
    "LATER reopen arms current observer context");
  assert(observer.armLoadTimeOffer({ localLibraryId: LOCAL_A, libraryId: LIB_A, currentFactValue: B }),
    "re-arming same LATER value is idempotent");
  const armed = observer.getSnapshot();
  assert(armed.pendingOffer?.observedValue === B && armed.loadState.offeredValue === B,
    "one pending B and offered marker share the existing observer state");
  const refreshed = await observer.observe(input());
  assert(!refreshed.result.eligible && refreshed.pendingOffer?.observedValue === B,
    "ordinary same-value refresh preserves one LATER pending offer");
  assert(!observer.dismissPendingOffer({ localLibraryId: LOCAL_A, libraryId: LIB_A, observedValue: C }),
    "stale expected value cannot dismiss current B offer");
  assert(observer.dismissPendingOffer({ localLibraryId: LOCAL_A, libraryId: LIB_A, observedValue: B }),
    "successful action dismisses the exact current offer");
  assert(observer.getSnapshot().pendingOffer === null, "dismiss leaves no UI-parallel pending state");
  const afterDismiss = await observer.observe(input());
  assert(afterDismiss.pendingOffer === null, "matching LATER convergence does not reopen during this load");
}

// Remote A -> B produces one internal offer, never a Profile switch operation.
{
  const { observer } = harness();
  observer.setContext({ localLibraryId: LOCAL_A, libraryId: LIB_A, currentFactValue: A, targetKnown: true });
  const first = await observer.observe(input());
  assert(first.result.eligible, "remote A -> B is eligible");
  assert(first.pendingOffer?.observedValue === B, "pending offer observes authoritative B");
  const repeated = await observer.observe(input());
  assert(!repeated.result.eligible, "repeated B does not duplicate the offer");
  assert(repeated.pendingOffer?.observedValue === B, "repeated B preserves the one pending offer");
  const restamp = await observer.observe(input());
  assert(!restamp.result.semanticChanged, "same-value restamp is not semantic change");
  assert(restamp.pendingOffer?.observedValue === B, "same-value restamp preserves pending B");
}

// Suppression is consumed as classification; exact local B remains quiet and
// a genuinely different remote C after intent closure is eligible.
{
  const { observer } = harness();
  observer.setContext({ localLibraryId: LOCAL_A, libraryId: LIB_A, currentFactValue: A, targetKnown: true });
  const duringIntent = await observer.observe(input({ selfWriteSuppressed: true }));
  assert(!duringIntent.result.eligible && duringIntent.pendingOffer === null,
    "intentional same-tab A -> B creates no offer");
  const exactAuthored = await observer.observe(input({ selfWriteSuppressed: true }));
  assert(!exactAuthored.result.eligible && exactAuthored.pendingOffer === null,
    "exact self-authored B remains suppressed");
  const remote = await observer.observe(input({ currentFactValue: C }));
  assert(remote.result.eligible && remote.pendingOffer?.observedValue === C,
    "different remote C remains eligible after intent closure");
}

// Matching decisions suppress; mismatching decisions clear only on a coherent
// semantic transition. A restamp of the matching value clears nothing.
for (const kind of ["yes", "no", "later"]) {
  const { observer, decisions } = harness();
  decisions.set(LIB_A, { kind, observedValue: B });
  observer.setContext({ localLibraryId: LOCAL_A, libraryId: LIB_A, currentFactValue: A, targetKnown: true });
  const result = await observer.observe(input());
  assert(!result.result.eligible, `matching ${kind.toUpperCase()} suppresses offer`);
  assert(!result.decisionCleared, `matching ${kind.toUpperCase()} is retained`);
}
{
  const { observer, decisions, deleted } = harness();
  decisions.set(LIB_A, { kind: "no", observedValue: A });
  observer.setContext({ localLibraryId: LOCAL_A, libraryId: LIB_A, currentFactValue: A, targetKnown: true });
  const changed = await observer.observe(input());
  assert(changed.decisionCleared && deleted[0] === LIB_A, "stale A decision clears on coherent A -> B");
  assert(changed.pendingOffer?.observedValue === B, "clearing stale decision does not lose eligible B");
}
{
  const { observer, decisions, deleted } = harness();
  decisions.set(LIB_A, { kind: "no", observedValue: B });
  observer.setContext({ localLibraryId: LOCAL_A, libraryId: LIB_A, currentFactValue: B, targetKnown: false });
  const restamp = await observer.observe(input());
  assert(!restamp.decisionCleared && deleted.length === 0, "same B/restamp never clears matching decision");
}

// Missing target may become eligible without a fake association transition.
{
  const { observer } = harness();
  observer.setContext({ localLibraryId: LOCAL_A, libraryId: LIB_A, currentFactValue: A, targetKnown: true });
  const missing = await observer.observe(input({ targetKnown: false }));
  assert(!missing.result.eligible && missing.pendingOffer === null, "missing B creates no offer");
  const arrived = await observer.observe(input({ targetKnown: true }));
  assert(arrived.result.eligible && arrived.pendingOffer?.observedValue === B,
    "same B offers once when target becomes available");
}
{
  const { observer } = harness();
  observer.setContext({ localLibraryId: LOCAL_A, libraryId: LIB_A, currentFactValue: B, targetKnown: false });
  const stillMissing = await observer.observe(input({ targetKnown: false }));
  assert(!stillMissing.result.eligible, "initial unresolved B remains quiet");
  const arrived = await observer.observe(input({ targetKnown: true }));
  assert(arrived.result.eligible && arrived.pendingOffer?.observedValue === B,
    "initially missing B may offer when it later resolves");
}
{
  const { observer } = harness();
  observer.setContext({ localLibraryId: LOCAL_A, libraryId: LIB_A, currentFactValue: A, targetKnown: true });
  await observer.observe(input());
  const vanished = await observer.observe(input({ targetKnown: false }));
  assert(!vanished.result.eligible && vanished.pendingOffer === null,
    "a pending target that disappears is discarded safely");
}

// Null and Active Profile changes clear obsolete pending state without action.
{
  const { observer } = harness();
  observer.setContext({ localLibraryId: LOCAL_A, libraryId: LIB_A, currentFactValue: A, targetKnown: true });
  await observer.observe(input());
  const noProfile = await observer.observe(input({ currentFactValue: null, targetKnown: false }));
  assert(!noProfile.result.eligible && noProfile.pendingOffer === null, "A -> null clears pending and does not offer");
}
{
  const { observer } = harness();
  observer.setContext({ localLibraryId: LOCAL_A, libraryId: LIB_A, currentFactValue: A, targetKnown: true });
  await observer.observe(input());
  const active = await observer.observe(input({ activeProfileId: B }));
  assert(!active.result.eligible && active.pendingOffer === null, "pending B clears when B becomes Active");
}

// Another Library observation cannot advance this context.
{
  const { observer } = harness();
  observer.setContext({ localLibraryId: LOCAL_A, libraryId: LIB_A, currentFactValue: A, targetKnown: true });
  const unrelated = await observer.observe(input({ localLibraryId: LOCAL_B, libraryId: LIB_B }));
  assert(unrelated.stale && observer.getSnapshot().loadState.semanticValue === A,
    "unrelated Library cannot change current load state");
}

// Deterministic async stale-result guard: A's decision read pauses, B becomes
// current, then A resumes and cannot install an offer into B.
{
  const gate = deferred();
  const observer = createAmbientProfileObserver({
    loadDecision: async (libraryId) => libraryId === LIB_A ? gate.promise : null,
    deleteDecision: async () => true,
  });
  observer.setContext({ localLibraryId: LOCAL_A, libraryId: LIB_A, currentFactValue: A, targetKnown: true });
  const oldRefresh = observer.observe(input());
  observer.setContext({ localLibraryId: LOCAL_B, libraryId: LIB_B, currentFactValue: C, targetKnown: true });
  gate.resolve(null);
  const stale = await oldRefresh;
  assert(stale.stale, "paused A continuation is classified stale");
  assert(observer.getSnapshot().context.libraryId === LIB_B, "B remains current after A resumes");
  assert(observer.getSnapshot().pendingOffer === null, "stale A cannot install a pending offer");
}

// A later observation in the same Library also supersedes an earlier paused
// read; current association truth must not be rolled back by completion order.
{
  const firstGate = deferred();
  let reads = 0;
  const observer = createAmbientProfileObserver({
    loadDecision: async () => (++reads === 1 ? firstGate.promise : null),
    deleteDecision: async () => true,
  });
  observer.setContext({ localLibraryId: LOCAL_A, libraryId: LIB_A, currentFactValue: A, targetKnown: true });
  const oldB = observer.observe(input({ currentFactValue: B }));
  const newC = await observer.observe(input({ currentFactValue: C }));
  firstGate.resolve(null);
  const staleB = await oldB;
  assert(newC.pendingOffer?.observedValue === C, "later same-context C becomes pending");
  assert(staleB.stale, "earlier paused B is stale after C observation starts");
  assert(observer.getSnapshot().pendingOffer?.observedValue === C,
    "late B completion cannot replace current C offer");
}

// The coordinator has no execution authority: it cannot switch a Profile or
// mutate a shared/local association projection.
{
  const source = fs.readFileSync(new URL("../src/profile/ambient-profile-observer.js", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  assert(!/\bswitchProfile\s*\(/.test(source), "observer contains no switchProfile call");
  assert(!/\bsetLibrary(?:Association|Profile)\s*\(/.test(source),
    "observer contains no association-write call");
}

console.log(`ambient profile observer: ${assertions} assertions passed`);
