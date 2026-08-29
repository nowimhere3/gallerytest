// [SYNCV3 / STAGE-09 / AMBIENT-DECISION-MODEL]
// Pure current-load eligibility model. It owns no DOM, storage, Profile state,
// association facts, or transport; callers supply observations and retain the
// returned load state.

export const AMBIENT_DECISION_REASONS = Object.freeze({
  ELIGIBLE: "eligible",
  NO_LOADED_LIBRARY: "no-loaded-library",
  NON_DURABLE_LIBRARY: "non-durable-library",
  OTHER_LIBRARY: "other-library",
  NO_TARGET: "no-target",
  TARGET_UNRESOLVED: "target-unresolved",
  TARGET_ALREADY_ACTIVE: "target-already-active",
  SELF_WRITE_SUPPRESSED: "self-write-suppressed",
  DECISION_APPLIES: "decision-applies",
  ALREADY_OFFERED: "already-offered",
});

function valueOrNull(value) {
  return typeof value === "string" && value ? value : null;
}

function stateFor(libraryId, semanticValue = null, offeredValue = null) {
  return Object.freeze({
    libraryId: valueOrNull(libraryId),
    semanticValue: valueOrNull(semanticValue),
    offeredValue: valueOrNull(offeredValue),
  });
}

export function createAmbientDecisionLoadState({ libraryId = null, observedValue = null } = {}) {
  return stateFor(libraryId, observedValue, null);
}

function result(reason, loadState, { eligible = false, target = null, semanticChanged = false } = {}) {
  return Object.freeze({ eligible, reason, target: eligible ? valueOrNull(target) : null, semanticChanged, loadState });
}

/**
 * Evaluates one authoritative association observation for the current load.
 * `currentFactValue` is the sole target authority. Fact stamps are deliberately
 * absent from the API because they cannot change association meaning.
 */
export function evaluateAmbientProfileDecision({
  loadedLibraryId = null,
  observedLibraryId = null,
  durable = false,
  currentFactValue = null,
  activeProfileId = null,
  targetKnown = false,
  selfWriteSuppressed = false,
  decision = null,
  loadState = null,
} = {}) {
  const currentLibraryId = valueOrNull(loadedLibraryId);
  const observationLibraryId = valueOrNull(observedLibraryId);
  const authoritativeValue = valueOrNull(currentFactValue);

  // [SYNCV3 / STAGE-09 / LOADED-LIBRARY-ONLY]
  // [WHY: shared association changes can converge for every catalog entry, but
  // only the Library whose media is currently loaded may affect this device's
  // viewing context. An unrelated observation must not even advance this
  // load's anti-spam state.]
  if (!currentLibraryId) {
    return result(AMBIENT_DECISION_REASONS.NO_LOADED_LIBRARY, stateFor(null));
  }
  if (!durable) {
    return result(AMBIENT_DECISION_REASONS.NON_DURABLE_LIBRARY, stateFor(null));
  }
  if (observationLibraryId !== currentLibraryId) {
    const unchanged = loadState?.libraryId === currentLibraryId
      ? stateFor(currentLibraryId, loadState.semanticValue, loadState.offeredValue)
      : stateFor(currentLibraryId);
    return result(AMBIENT_DECISION_REASONS.OTHER_LIBRARY, unchanged);
  }

  const prior = loadState?.libraryId === currentLibraryId
    ? stateFor(currentLibraryId, loadState.semanticValue, loadState.offeredValue)
    : stateFor(currentLibraryId);
  const semanticChanged = prior.semanticValue !== authoritativeValue;

  // [SYNCV3 / STAGE-09 / SEMANTIC-VALUE-NOT-STAMP]
  // [WHY: an association is its Profile-id/null VALUE. A newer (t,d) carrying
  // the same value is convergence bookkeeping, not a new user decision. A real
  // value transition clears the current-load offered marker so B -> C -> B may
  // offer B again, while B@S1 -> B@S2 cannot.]
  let nextState = semanticChanged
    ? stateFor(currentLibraryId, authoritativeValue, null)
    : prior;

  if (!authoritativeValue) {
    return result(AMBIENT_DECISION_REASONS.NO_TARGET, nextState, { semanticChanged });
  }

  // [SYNCV3 / STAGE-09 / TARGET-RESOLVABILITY]
  // [WHY: shared truth may arrive before its Profile. Keep the semantic value
  // observed but do not mark it offered; if that same target later materializes
  // locally, it remains eligible exactly once. Stage 07 S4 owns the meantime.]
  if (!targetKnown) {
    return result(AMBIENT_DECISION_REASONS.TARGET_UNRESOLVED, nextState, { semanticChanged });
  }
  if (authoritativeValue === valueOrNull(activeProfileId)) {
    return result(AMBIENT_DECISION_REASONS.TARGET_ALREADY_ACTIVE, nextState, { semanticChanged });
  }

  // [SYNCV3 / STAGE-09 / SELF-WRITE-EXCLUSION]
  // [WHY: Slice 0 classifies this tab's intentional association fact by exact
  // identity. Treating that fact as ambient would ask the user to react to the
  // action they just explicitly performed. A different remote fact is not
  // suppressed and reaches the ordinary rules below.]
  if (selfWriteSuppressed) {
    return result(AMBIENT_DECISION_REASONS.SELF_WRITE_SUPPRESSED, nextState, { semanticChanged });
  }

  // [SYNCV3 / STAGE-09 / DECISION-VALUE-APPLICABILITY]
  // [WHY: observedValue is NON-AUTHORITATIVE and participates only in this
  // equality check. Decision stamps are diagnostic and intentionally ignored,
  // so a same-value restamp cannot defeat YES, NO, or LATER. No target is ever
  // derived from the decision record.]
  const decisionKind = decision && ["yes", "no", "later"].includes(decision.kind) ? decision.kind : null;
  const decisionApplies = decisionKind && valueOrNull(decision.observedValue) === authoritativeValue;
  if (decisionApplies) {
    return result(AMBIENT_DECISION_REASONS.DECISION_APPLIES, nextState, { semanticChanged });
  }

  // [SYNCV3 / STAGE-09 / CURRENT-LOAD-ANTI-SPAM]
  // [WHY: semantic value, target availability, and offer acknowledgement are
  // separate. Resolvability can change without a value transition; an offered
  // marker changes only when an offer is actually produced. This permits a
  // missing B to offer once when it appears while preventing every convergence
  // pass (and every B restamp) from offering B again.]
  if (nextState.offeredValue === authoritativeValue) {
    return result(AMBIENT_DECISION_REASONS.ALREADY_OFFERED, nextState, { semanticChanged });
  }

  nextState = stateFor(currentLibraryId, authoritativeValue, authoritativeValue);
  return result(AMBIENT_DECISION_REASONS.ELIGIBLE, nextState, {
    eligible: true,
    // Current shared truth is the only target authority. Never decision.observedValue.
    target: authoritativeValue,
    semanticChanged,
  });
}

function loadTimeResult(action, reason, targetValue, { clearDecision = false } = {}) {
  return Object.freeze({
    action,
    reason,
    target: action === "switch" ? valueOrNull(targetValue) : null,
    clearDecision: Boolean(clearDecision),
  });
}

/**
 * [SYNCV3 / STAGE-09 / LOAD-TIME-SWITCH-RESOLVER]
 * Pure policy for a recognized Library load/reopen. The caller performs any
 * reported switch, prompt arming, or local decision deletion.
 *
 * Fact stamps are deliberately absent: decision applicability is semantic
 * value equality, so a same-value restamp cannot alter this result.
 */
export function resolveLoadTimeSwitch({
  hasSharedFact = false,
  currentFactValue = null,
  factTargetKnown = false,
  rowProfileId = null,
  rowTargetKnown = false,
  activeProfileId = null,
  decision = null,
} = {}) {
  const rowValue = valueOrNull(rowProfileId);
  const authoritativeValue = valueOrNull(currentFactValue);
  const activeValue = valueOrNull(activeProfileId);

  // [SYNCV3 / STAGE-09 / LOAD-TIME-AUTHORITY-CORRECTION]
  // [WHY: absence of a shared fact is not the same state as a shared fact whose
  // value is null. With no fact, the remembered local row preserves historical
  // restoration and Stage 08 post-unlink behavior. Once a fact exists, even an
  // explicit No Profile fact is authoritative and the row becomes projection
  // only. A stray Stage 09 decision cannot affect or be cleared by Rule 0.]
  if (!hasSharedFact) {
    if (rowValue && rowTargetKnown && rowValue !== activeValue) {
      return loadTimeResult("switch", "local-row-restoration", rowValue);
    }
    const reason = rowValue && rowTargetKnown ? "local-row-already-active" : "local-row-unusable";
    return loadTimeResult("skip", reason, null);
  }

  const hasDecision = Boolean(decision);
  const decisionMatches = hasDecision && valueOrNull(decision.observedValue) === authoritativeValue;
  // Staleness is orthogonal to switch policy. Null, unresolved, and already
  // active shared targets can still prove an older semantic decision stale.
  const clearDecision = hasDecision && !decisionMatches;

  if (!authoritativeValue || !factTargetKnown) {
    return loadTimeResult("skip", "shared-target-unusable", null, { clearDecision });
  }

  // [SYNCV3 / STAGE-09 / SHARED-FACT-TARGET-AUTHORITY]
  // [WHY: for a shared Library, currentFactValue alone selects the target.
  // rowProfileId may lag reconciliation and must not alter matching decisions;
  // observedValue only tests applicability and never supplies a target.]
  if (authoritativeValue === activeValue) {
    return loadTimeResult("skip", "shared-target-already-active", null, { clearDecision });
  }

  // [SYNCV3 / STAGE-09 / LOAD-TIME-DECISION-APPLICABILITY]
  // [WHY: observedValue is non-authoritative and appears only in equality. A
  // matching local decision may veto, defer, or allow normal restoration; its
  // diagnostic stamp is absent and therefore a restamp cannot change meaning.]
  if (decisionMatches) {
    if (decision.kind === "no") return loadTimeResult("skip", "decision-no", null);
    if (decision.kind === "later") return loadTimeResult("skip-and-ask", "decision-later", null);
    if (decision.kind === "yes") return loadTimeResult("switch", "decision-yes", authoritativeValue);
  }

  // Rule 4 — deliberate shared-Library restoration. Projection disagreement
  // is diagnostic/reconciliation state only and has no policy branch.
  return loadTimeResult(
    "switch",
    clearDecision ? "decision-stale" : "shared-restoration",
    authoritativeValue,
    { clearDecision }
  );
}
