import {
  AMBIENT_DECISION_REASONS,
  createAmbientDecisionLoadState,
  evaluateAmbientProfileDecision,
} from "./ambient-profile-decision.js";

// [SYNCV3 / STAGE-09 / AMBIENT-OBSERVATION-INTEGRATION]
// Owns only ephemeral state for the one currently loaded Library. Storage and
// Profile authorities are injected; this coordinator never switches a Profile
// or writes a shared association.
export function createAmbientProfileObserver({ loadDecision, deleteDecision } = {}) {
  if (typeof loadDecision !== "function" || typeof deleteDecision !== "function") {
    throw new TypeError("Ambient Profile observer requires decision-store read/delete functions.");
  }

  let generation = 0;
  let observationSequence = 0;
  let context = null;
  let loadState = createAmbientDecisionLoadState();
  let pendingOffer = null;

  function snapshot() {
    return Object.freeze({
      context: context ? Object.freeze({ ...context }) : null,
      loadState,
      pendingOffer: pendingOffer ? Object.freeze({ ...pendingOffer }) : null,
    });
  }

  function clearContext() {
    generation += 1;
    context = null;
    loadState = createAmbientDecisionLoadState();
    pendingOffer = null;
    return snapshot();
  }

  function setContext({ localLibraryId, libraryId, currentFactValue = null, targetKnown = false } = {}) {
    generation += 1;
    context = localLibraryId && libraryId ? {
      localLibraryId,
      libraryId,
      baselineValue: currentFactValue || null,
      baselineTargetKnown: Boolean(targetKnown),
      observedTransition: false,
    } : null;
    loadState = createAmbientDecisionLoadState({
      libraryId: context?.libraryId || null,
      observedValue: context?.baselineValue || null,
    });
    pendingOffer = null;
    return snapshot();
  }

  function matchesContext(localLibraryId, libraryId) {
    return Boolean(context
      && context.localLibraryId === localLibraryId
      && context.libraryId === libraryId);
  }

  function armLoadTimeOffer({ localLibraryId, libraryId, currentFactValue } = {}) {
    const authoritativeValue = typeof currentFactValue === "string" && currentFactValue
      ? currentFactValue
      : null;
    if (!authoritativeValue || !matchesContext(localLibraryId, libraryId)) return false;

    // [SYNCV3 / STAGE-09 / LOAD-TIME-LATER-REASK]
    // [WHY: matching LATER is an explicit load-resolver instruction, not a fake
    // ambient transition. Arm the same single pending slot and mark this value
    // offered in the current-load state so ordinary convergence cannot duplicate
    // it. Slice 4 will still re-read shared truth before any user action.]
    observationSequence += 1;
    loadState = Object.freeze({
      libraryId,
      semanticValue: authoritativeValue,
      offeredValue: authoritativeValue,
    });
    pendingOffer = Object.freeze({ localLibraryId, libraryId, observedValue: authoritativeValue });
    return true;
  }

  function dismissPendingOffer(expectedOffer = null) {
    if (!pendingOffer) return false;
    if (expectedOffer && (
      pendingOffer.localLibraryId !== expectedOffer.localLibraryId
      || pendingOffer.libraryId !== expectedOffer.libraryId
      || pendingOffer.observedValue !== expectedOffer.observedValue
    )) return false;
    observationSequence += 1;
    pendingOffer = null;
    return true;
  }

  // [SYNCV3 / STAGE-09 / SLICE-5-MULTITAB-DECISIONS]
  // Re-reads the decision store and retires a pending offer that another
  // context on this device has already decided.
  //
  // [WHY: sibling tabs each evaluate eligibility independently, so two tabs may
  // legitimately show the same offer. What must NOT diverge is the decision. The
  // announcement that triggers this carries no payload; the durable store is the
  // only authority consulted, exactly as the local-state channel's contract
  // requires. This retires an offer and never produces one, never switches a
  // Profile, and never writes anything.]
  async function reconcilePendingOfferWithDecision() {
    if (!pendingOffer || !context) return Object.freeze({ dismissed: false, ...snapshot() });

    const offer = pendingOffer;
    const token = generation;
    // Deliberately does NOT bump observationSequence: this is a reconciliation
    // read, not a new observation, and it must be superseded by any real
    // observation that lands while the store read is in flight.
    const observationToken = observationSequence;
    const decision = await loadDecision(offer.libraryId);
    if (!isCurrent(token, observationToken, offer.localLibraryId, offer.libraryId)) {
      return Object.freeze({ dismissed: false, ...snapshot() });
    }

    // Value-keyed applicability, identical to the ambient evaluator. A decision
    // recorded for a different value cannot retire this offer.
    const kind = decision && ["yes", "no", "later"].includes(decision.kind) ? decision.kind : null;
    const decidedValue = decision && typeof decision.observedValue === "string" && decision.observedValue
      ? decision.observedValue
      : null;
    if (!kind || decidedValue !== offer.observedValue) {
      return Object.freeze({ dismissed: false, ...snapshot() });
    }

    // Mark the value offered for this load so the sibling's decision does not
    // simply get re-offered by the next convergence pass.
    loadState = Object.freeze({
      libraryId: offer.libraryId,
      semanticValue: offer.observedValue,
      offeredValue: offer.observedValue,
    });
    observationSequence += 1;
    pendingOffer = null;
    return Object.freeze({ dismissed: true, ...snapshot() });
  }

  function isCurrent(token, observationToken, localLibraryId, libraryId) {
    return generation === token
      && observationSequence === observationToken
      && matchesContext(localLibraryId, libraryId);
  }

  async function observe({
    localLibraryId,
    libraryId,
    currentFactValue = null,
    activeProfileId = null,
    targetKnown = false,
    selfWriteSuppressed = false,
  } = {}) {
    if (!matchesContext(localLibraryId, libraryId)) {
      return Object.freeze({ stale: true, result: null, decisionCleared: false, ...snapshot() });
    }

    const token = generation;
    const observationToken = ++observationSequence;
    const authoritativeValue = currentFactValue || null;

    // [SYNCV3 / STAGE-09 / INITIAL-LOAD-BASELINE]
    // [WHY: merely opening a Library is not an ambient transition. A resolved
    // association already present when this context was established is the
    // baseline handled by the load-time path, so repeated refresh/restamp must
    // remain quiet. An initially missing target is deliberately not settled:
    // if that Profile later arrives, the pure evaluator may offer it once.]
    if (!context.observedTransition
      && authoritativeValue === context.baselineValue
      && context.baselineTargetKnown) {
      return Object.freeze({
        stale: false,
        result: Object.freeze({
          eligible: false,
          reason: AMBIENT_DECISION_REASONS.ALREADY_OFFERED,
          target: null,
          semanticChanged: false,
          loadState,
        }),
        decisionCleared: false,
        ...snapshot(),
      });
    }

    const decision = await loadDecision(libraryId);
    // [SYNCV3 / STAGE-09 / ASYNC-CONTEXT-GUARD]
    // [WHY: IndexedDB may resolve after a folder switch or after a newer fact
    // observation for the same folder. Identity, context generation, and
    // observation sequence prevent either stale continuation from replacing
    // current pending state; wall-clock time is neither needed nor authority.]
    if (!isCurrent(token, observationToken, localLibraryId, libraryId)) {
      return Object.freeze({ stale: true, result: null, decisionCleared: false, ...snapshot() });
    }

    const result = evaluateAmbientProfileDecision({
      loadedLibraryId: context.libraryId,
      observedLibraryId: libraryId,
      durable: true,
      currentFactValue: authoritativeValue,
      activeProfileId,
      targetKnown,
      selfWriteSuppressed,
      decision,
      loadState,
    });
    loadState = result.loadState;
    if (result.semanticChanged) context = { ...context, observedTransition: true };

    let decisionCleared = false;
    const decisionValue = decision && typeof decision.observedValue === "string"
      ? decision.observedValue
      : null;
    // [SYNCV3 / STAGE-09 / STALE-DECISION-INVALIDATION]
    // [WHY: clear only when this load actually observes a semantic VALUE
    // transition away from the decided value. `result.semanticChanged` already
    // excludes stamp-only convergence, so a same-value restamp still cannot
    // invalidate a decision.]
    //
    // [SYNCV3 / STAGE-09 / NO-DECISION-REARM-BUG]
    // [WHY: this deliberately does NOT consult the local row projection.
    // Gating invalidation on `projectionCoherent` gave the projection policy
    // authority it must never have, and it could never be satisfied here:
    // ProfileStore#adoptMergedAssociations emits BEFORE its row-reconciliation
    // loop, so at the only moment the transition is observed the row still
    // holds the OLD value. A stale NO therefore survived an observed change
    // away and silently suppressed the later return to that value. Shared
    // truth is the sole association authority — see Architecture Delta 3.]
    if (result.semanticChanged
      && decisionValue !== null
      && decisionValue !== authoritativeValue) {
      await deleteDecision(libraryId);
      if (!isCurrent(token, observationToken, localLibraryId, libraryId)) {
        return Object.freeze({ stale: true, result: null, decisionCleared: true, ...snapshot() });
      }
      decisionCleared = true;
    }

    if (result.eligible) {
      // Observational only. Slice 4 must re-read authoritative truth at click
      // time; `observedValue` here is never a switch target.
      pendingOffer = Object.freeze({ localLibraryId, libraryId, observedValue: authoritativeValue });
    } else if (!(result.reason === AMBIENT_DECISION_REASONS.ALREADY_OFFERED
      && pendingOffer?.libraryId === libraryId
      && pendingOffer.observedValue === authoritativeValue)) {
      pendingOffer = null;
    }

    return Object.freeze({ stale: false, result, decisionCleared, ...snapshot() });
  }

  return Object.freeze({
    clearContext,
    setContext,
    matchesContext,
    armLoadTimeOffer,
    dismissPendingOffer,
    reconcilePendingOfferWithDecision,
    observe,
    getSnapshot: snapshot,
  });
}
