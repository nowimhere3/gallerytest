// [SYNCV3 / STAGE-09 / SLICE-5-MULTITAB-DECISIONS]
// Same-device, multi-tab decision invalidation.
//
// Contract under test (recovered from the locked Stage 09 architecture):
// independent prompts, shared durable decisions. Two contexts on one device may
// each show the same offer; once ANY of them decides, the others must retire
// their offer WITHOUT acting. The BroadcastChannel announcement is invalidation
// only and carries no payload — the durable decision store is the sole
// authority a receiver consults.
import fs from "node:fs";
import { createAmbientProfileObserver } from "../src/profile/ambient-profile-observer.js";
import { LOCAL_STATE_MESSAGE_KINDS } from "../src/profile/local-state-channel.js";

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

// One shared decision store standing in for the device-wide IndexedDB row set.
function device() {
  const decisions = new Map();
  const gate = { pending: null };
  function makeTab() {
    return createAmbientProfileObserver({
      loadDecision: async (libraryId) => {
        if (gate.pending) await gate.pending.promise;
        return decisions.get(libraryId) || null;
      },
      deleteDecision: async (libraryId) => { decisions.delete(libraryId); return true; },
    });
  }
  return { decisions, gate, makeTab };
}

function input(overrides = {}) {
  return {
    localLibraryId: LOCAL_A,
    libraryId: LIB_A,
    currentFactValue: B,
    activeProfileId: A,
    targetKnown: true,
    selfWriteSuppressed: false,
    ...overrides,
  };
}

function decisionFor(kind, value, libraryId = LIB_A) {
  return { libraryId, kind, observedValue: value, stamp: { t: 7, d: "dev-a" }, decidedAt: 1 };
}

// Brings one tab to the state "offer for B is on screen".
async function tabShowingOfferForB(observer) {
  observer.setContext({ localLibraryId: LOCAL_A, libraryId: LIB_A, currentFactValue: A, targetKnown: true });
  const result = await observer.observe(input());
  assert(result.result.eligible, "tab reaches an eligible B offer");
  assert(observer.getSnapshot().pendingOffer.observedValue === B, "tab holds a pending B offer");
  return observer;
}

// ---- The channel kind exists and is invalidation-only ---------------------
{
  assert(LOCAL_STATE_MESSAGE_KINDS.AMBIENT_DECISION_CHANGED === "ambient-decision-changed",
    "AMBIENT_DECISION_CHANGED kind is defined");
  const source = fs.readFileSync(new URL("../src/profile/profile-store.js", import.meta.url), "utf8");
  // The announcement must not smuggle decision data through the channel.
  assert(/announceAmbientProfileDecisionChanged\(\)\s*{\s*\n\s*this\.#announceLocalStateChange\(\s*LOCAL_STATE_MESSAGE_KINDS\.AMBIENT_DECISION_CHANGED\s*\);/.test(source),
    "ambient decision announcement posts the bare kind with no payload");
  assert(/subscribeAmbientProfileDecisionChanged\(listener\)/.test(source),
    "ProfileStore exposes an ambient decision subscription");
}

// ---- Each of YES / NO / LATER in a sibling retires this tab's offer -------
for (const kind of ["yes", "no", "later"]) {
  const { decisions, makeTab } = device();
  const tabB = await tabShowingOfferForB(makeTab());

  // Sibling tab records its decision, then announces.
  decisions.set(LIB_A, decisionFor(kind, B));
  const state = await tabB.reconcilePendingOfferWithDecision();

  assert(state.dismissed, `sibling ${kind.toUpperCase()} retires this tab's offer`);
  assert(state.pendingOffer === null, `no pending offer remains after sibling ${kind.toUpperCase()}`);
  assert(state.loadState.offeredValue === B,
    `sibling ${kind.toUpperCase()} marks B offered so convergence does not re-offer it`);

  // The retired offer must not come back on the next ordinary observation.
  const next = await tabB.observe(input());
  assert(!next.result.eligible, `B is not re-offered after a sibling ${kind.toUpperCase()}`);
  assert(next.pendingOffer === null, `no offer returns after a sibling ${kind.toUpperCase()}`);
}

// ---- A decision for a DIFFERENT value must not retire this offer ----------
{
  const { decisions, makeTab } = device();
  const tabB = await tabShowingOfferForB(makeTab());
  decisions.set(LIB_A, decisionFor("no", C));
  const state = await tabB.reconcilePendingOfferWithDecision();
  assert(!state.dismissed, "a decision for another value does not retire the B offer");
  assert(state.pendingOffer !== null, "the B offer survives an unrelated-value decision");
  assert(state.pendingOffer.observedValue === B, "the surviving offer still targets B");
}

// ---- A decision for a DIFFERENT Library must not retire this offer --------
{
  const { decisions, makeTab } = device();
  const tabB = await tabShowingOfferForB(makeTab());
  decisions.set(LIB_B, decisionFor("no", B, LIB_B));
  const state = await tabB.reconcilePendingOfferWithDecision();
  assert(!state.dismissed, "another Library's decision does not retire this offer");
  assert(state.pendingOffer !== null, "the offer survives another Library's decision");
}

// ---- No pending offer is a safe no-op ------------------------------------
{
  const { decisions, makeTab } = device();
  const tab = makeTab();
  tab.setContext({ localLibraryId: LOCAL_A, libraryId: LIB_A, currentFactValue: B, targetKnown: true });
  decisions.set(LIB_A, decisionFor("no", B));
  const state = await tab.reconcilePendingOfferWithDecision();
  assert(!state.dismissed, "reconciling with no pending offer is a no-op");
  assert(state.pendingOffer === null, "no offer is invented by reconciliation");
}

// ---- Stale async continuation cannot retire a NEWER offer -----------------
{
  const { decisions, gate, makeTab } = device();
  const tabB = await tabShowingOfferForB(makeTab());
  decisions.set(LIB_A, decisionFor("no", B));

  // Hold the store read open, then let a real observation supersede it.
  const held = deferred();
  gate.pending = held;
  const inFlight = tabB.reconcilePendingOfferWithDecision();
  gate.pending = null;
  const superseding = await tabB.observe(input({ currentFactValue: C }));
  held.resolve();
  assert(superseding.result.eligible, "a newer semantic value produces a newer offer");
  assert(tabB.getSnapshot().pendingOffer.observedValue === C, "the newer C offer is pending");

  const state = await inFlight;
  assert(!state.dismissed, "a stale reconciliation cannot retire a newer offer");
  assert(tabB.getSnapshot().pendingOffer !== null, "the newer C offer survives");
  assert(tabB.getSnapshot().pendingOffer.observedValue === C, "the surviving offer is still C");
}

// ---- A Library switch during the read cannot retire anything --------------
{
  const { decisions, gate, makeTab } = device();
  const tabB = await tabShowingOfferForB(makeTab());
  decisions.set(LIB_A, decisionFor("no", B));

  const held = deferred();
  gate.pending = held;
  const inFlight = tabB.reconcilePendingOfferWithDecision();
  gate.pending = null;
  tabB.setContext({ localLibraryId: LOCAL_B, libraryId: LIB_B, currentFactValue: null, targetKnown: false });
  held.resolve();

  const state = await inFlight;
  assert(!state.dismissed, "a reconciliation cannot act after the Library changed");
  assert(state.pendingOffer === null, "the new context has no pending offer");
}

// ---- Reconciliation switches nothing and writes nothing -------------------
{
  const source = fs.readFileSync(new URL("../src/profile/ambient-profile-observer.js", import.meta.url), "utf8");
  assert(!/\bswitchProfile\s*\(/.test(source), "observer still contains no switchProfile call");
  assert(!/\bsetLibrary(?:Association|Profile)\s*\(/.test(source),
    "observer still contains no association-write call");
  assert(!/\bsaveDecision\b/.test(source), "observer never writes a decision itself");
  // Slice 5 must not resurrect row-projection authority under a new name.
  // Comments are stripped first: Stage 09M deliberately NAMES the removed flag
  // in its breadcrumb, and that explanation must not be mistaken for a use.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
  assert(!/projectionCoherent|previousProjectedValue|rowProfileId/.test(code),
    "observer takes no row-projection input");
}

console.log(`ambient decision multi-tab: ${assertions} assertions passed`);
