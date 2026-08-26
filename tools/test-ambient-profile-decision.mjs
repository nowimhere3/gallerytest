import {
  AMBIENT_DECISION_REASONS as REASONS,
  createAmbientDecisionLoadState,
  evaluateAmbientProfileDecision,
} from "../src/profile/ambient-profile-decision.js";

let assertions = 0;
function assert(condition, message) {
  assertions += 1;
  if (!condition) throw new Error(message);
}

const LIBRARY = "library-nature";
const OTHER_LIBRARY = "library-portraits";
const A = "profile-a";
const B = "profile-b";
const C = "profile-c";

function observe(overrides = {}) {
  return evaluateAmbientProfileDecision({
    loadedLibraryId: LIBRARY,
    observedLibraryId: LIBRARY,
    durable: true,
    currentFactValue: B,
    activeProfileId: A,
    targetKnown: true,
    loadState: createAmbientDecisionLoadState({ libraryId: LIBRARY, observedValue: A }),
    ...overrides,
  });
}

// Core A -> B and current-load anti-spam.
{
  const first = observe();
  assert(first.eligible && first.reason === REASONS.ELIGIBLE, "A -> B with a valid target is eligible");
  assert(first.target === B, "eligible target is current authoritative B");
  assert(first.semanticChanged, "A -> B is a semantic value transition");

  const repeated = observe({ loadState: first.loadState });
  assert(!repeated.eligible && repeated.reason === REASONS.ALREADY_OFFERED, "repeated B is not offered again");
  assert(!repeated.semanticChanged, "repeated B is not a semantic transition");

  // Fact stamps are deliberately not model inputs: B@S2 is indistinguishable
  // from B@S1 and therefore cannot create a second opportunity.
  const restamped = observe({ loadState: repeated.loadState });
  assert(!restamped.eligible && restamped.reason === REASONS.ALREADY_OFFERED,
    "same B with a new external stamp cannot re-offer");
}

{
  const active = observe({ activeProfileId: B });
  assert(!active.eligible && active.reason === REASONS.TARGET_ALREADY_ACTIVE,
    "a target that is already active needs no offer");
  const other = observe({ observedLibraryId: OTHER_LIBRARY });
  assert(!other.eligible && other.reason === REASONS.OTHER_LIBRARY,
    "an association observation for another Library is ignored");
  assert(other.loadState.semanticValue === A, "another Library cannot advance current-load state");
  const none = observe({ loadedLibraryId: null, observedLibraryId: LIBRARY });
  assert(!none.eligible && none.reason === REASONS.NO_LOADED_LIBRARY, "no loaded Library is ineligible");
  const ephemeral = observe({ durable: false });
  assert(!ephemeral.eligible && ephemeral.reason === REASONS.NON_DURABLE_LIBRARY,
    "an ephemeral/session-only source is ineligible");
}

// Null and missing-target behavior.
{
  const toNull = observe({ currentFactValue: null });
  assert(!toNull.eligible && toNull.reason === REASONS.NO_TARGET, "A -> null produces no offer");
  const fromNull = observe({ loadState: createAmbientDecisionLoadState({ libraryId: LIBRARY, observedValue: null }) });
  assert(fromNull.eligible && fromNull.target === B, "null -> valid B is eligible");

  const missing = observe({ targetKnown: false });
  assert(!missing.eligible && missing.reason === REASONS.TARGET_UNRESOLVED,
    "A -> missing B defers to Stage 07 S4");
  assert(missing.loadState.semanticValue === B && missing.loadState.offeredValue === null,
    "missing B is observed semantically but not marked offered");
  const arrived = observe({ targetKnown: true, loadState: missing.loadState });
  assert(arrived.eligible && arrived.target === B, "same B becomes eligible when its Profile arrives");
  const arrivedAgain = observe({ targetKnown: true, loadState: arrived.loadState });
  assert(!arrivedAgain.eligible && arrivedAgain.reason === REASONS.ALREADY_OFFERED,
    "newly resolved B is offered exactly once");
}

// Slice 0 classification is consumed as an exclusion, not re-derived here.
{
  const exactLocal = observe({ selfWriteSuppressed: true });
  assert(!exactLocal.eligible && exactLocal.reason === REASONS.SELF_WRITE_SUPPRESSED,
    "Slice 0 exact authored L classification is not ambient-eligible");
  const remote = observe({ currentFactValue: C, selfWriteSuppressed: false });
  assert(remote.eligible && remote.target === C, "a newer/different remote R remains eligible");
}

// Decisions apply by observed VALUE only, never by their diagnostic stamp.
for (const kind of ["no", "later", "yes"]) {
  const matching = observe({ decision: { kind, observedValue: B, stamp: { t: 1, d: "old" } } });
  assert(!matching.eligible && matching.reason === REASONS.DECISION_APPLIES,
    `matching ${kind.toUpperCase()} suppresses the ambient offer`);
  const restamped = observe({
    decision: { kind, observedValue: B, stamp: { t: 1, d: "old" } },
    // Same B; a newer fact stamp is intentionally absent from this pure API.
  });
  assert(!restamped.eligible && restamped.reason === REASONS.DECISION_APPLIES,
    `same-value restamp cannot defeat ${kind.toUpperCase()}`);
}

{
  const stale = observe({ currentFactValue: C, decision: { kind: "no", observedValue: B } });
  assert(stale.eligible, "a decision for B does not apply to current C");
  assert(stale.target === C, "stale B decision cannot become the target for C");

  const conflicting = observe({ currentFactValue: C, decision: { kind: "later", observedValue: "profile-x" } });
  assert(conflicting.target === C, "decision.observedValue is never emitted as target");
  assert(conflicting.loadState.offeredValue === C, "offered state records authoritative C only");
}

// Semantic transition sequences.
{
  const bState = observe().loadState;
  const toC = observe({ currentFactValue: C, loadState: bState });
  assert(toC.eligible && toC.semanticChanged && toC.target === C, "B -> C creates one C opportunity");
  const cRestamp = observe({ currentFactValue: C, loadState: toC.loadState });
  assert(!cRestamp.eligible && cRestamp.reason === REASONS.ALREADY_OFFERED,
    "C -> C restamp does not create another C opportunity");
  const backToB = observe({ currentFactValue: B, loadState: cRestamp.loadState });
  assert(backToB.eligible && backToB.semanticChanged && backToB.target === B,
    "observed B -> C -> B permits a new B opportunity");
}

{
  const alreadyB = createAmbientDecisionLoadState({ libraryId: LIBRARY, observedValue: B });
  const firstObservedB = observe({ loadState: alreadyB });
  assert(firstObservedB.eligible, "without an offered marker, current B may be offered once");
  const unseenRoundTrip = observe({ loadState: firstObservedB.loadState });
  assert(!unseenRoundTrip.semanticChanged && unseenRoundTrip.reason === REASONS.ALREADY_OFFERED,
    "the model does not invent an unobserved B -> C -> B history");
}

console.log(`ambient profile decision: ${assertions} assertions passed`);
