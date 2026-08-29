import { resolveLoadTimeSwitch } from "./ambient-profile-decision.js";

const hasOwn = (object, key) => Boolean(key)
  && Object.prototype.hasOwnProperty.call(object || {}, key);

// [SYNCV3 / STAGE-09 / LOAD-TIME-INTEGRATION]
// One orchestration boundary shared by the legacy and FSA load sites. It owns
// no Library state and receives every authority/action as an injected function.
export async function applyLoadTimeProfileRestoration({
  libraryRecord,
  getAssociations,
  getKnownProfileIds,
  getActiveProfileId,
  loadDecision,
  deleteDecision,
  switchProfile,
  isCurrent,
} = {}) {
  const localLibraryId = libraryRecord?.id || null;
  const libraryId = libraryRecord?.libraryId || null;
  const current = () => typeof isCurrent !== "function" || isCurrent();
  if (!localLibraryId || !current()) return Object.freeze({ stale: true, result: null });

  let associations = getAssociations();
  let hasSharedFact = hasOwn(associations, libraryId);
  let decision = null;

  // A Stage 09 decision has meaning only while this local row is linked to a
  // shared Library and that Library has an actual fact entry. Explicit null is
  // still a present fact and therefore still loads/invalidates decisions.
  if (hasSharedFact) {
    decision = await loadDecision(libraryId);
    if (!current()) return Object.freeze({ stale: true, result: null });
    // Re-read after IndexedDB: shared truth may have advanced while the local
    // decision row was loading. The resolver must never act on the old value.
    associations = getAssociations();
    hasSharedFact = hasOwn(associations, libraryId);
  }

  const derive = (savedDecision) => {
    const fact = hasSharedFact ? associations[libraryId] : null;
    const currentFactValue = fact?.v ?? null;
    const knownProfileIds = new Set(getKnownProfileIds());
    return {
      result: resolveLoadTimeSwitch({
        hasSharedFact,
        currentFactValue,
        factTargetKnown: Boolean(currentFactValue && knownProfileIds.has(currentFactValue)),
        rowProfileId: libraryRecord.profileId || null,
        rowTargetKnown: Boolean(libraryRecord.profileId && knownProfileIds.has(libraryRecord.profileId)),
        activeProfileId: getActiveProfileId(),
        decision: hasSharedFact ? savedDecision : null,
      }),
      currentFactValue,
    };
  };

  let { result, currentFactValue } = derive(decision);
  let decisionDeleted = false;
  let decisionDeleteError = null;

  if (result.clearDecision && libraryId) {
    try {
      await deleteDecision(libraryId);
      decisionDeleted = true;
    } catch (error) {
      decisionDeleteError = error;
    }
    if (!current()) {
      return Object.freeze({ stale: true, result: null, decisionDeleted, decisionDeleteError });
    }
    // [SYNCV3 / STAGE-09 / STALE-DECISION-CALLER]
    // [WHY: deletion is caller-owned and action-independent. Re-read shared
    // truth afterward so a skip/null cleanup cannot be followed by a switch to
    // a fact value that changed while IndexedDB was awaited.]
    associations = getAssociations();
    hasSharedFact = hasOwn(associations, libraryId);
    ({ result, currentFactValue } = derive(decisionDeleteError ? decision : null));
  }

  if (!current()) {
    return Object.freeze({ stale: true, result: null, decisionDeleted, decisionDeleteError });
  }

  let switched = false;
  if (result.action === "switch" && result.target) {
    // [SYNCV3 / STAGE-09 / DELIBERATE-OPEN-RESTORATION]
    // [WHY: deliberate open/reopen follows the resolver and may switch. An
    // already-open Library's remote change never enters here; Slice 3 observes
    // that ambiently. For shared facts result.target is authoritative shared
    // truth; Rule 0 alone permits the remembered local-row fallback.]
    switched = Boolean(await switchProfile(result.target));
  }

  return Object.freeze({
    stale: false,
    result,
    switched,
    decisionDeleted,
    decisionDeleteError,
    localLibraryId,
    libraryId,
    hasSharedFact,
    currentFactValue,
  });
}
