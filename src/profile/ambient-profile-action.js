const DECISION_KINDS = new Set(["yes", "no", "later"]);
const hasOwn = (object, key) => Boolean(key)
  && Object.prototype.hasOwnProperty.call(object || {}, key);

function outcome(status, extra = {}) {
  return Object.freeze({ status, ...extra });
}

export function buildAmbientProfileOfferView({
  pendingOffer = null,
  currentContext = null,
  libraryName = "This Library",
  targetName = null,
  activeProfileName = "my current Profile",
} = {}) {
  const visible = Boolean(pendingOffer && currentContext && targetName
    && pendingOffer.localLibraryId === currentContext.localLibraryId
    && pendingOffer.libraryId === currentContext.libraryId);
  if (!visible) return Object.freeze({ visible: false });
  return Object.freeze({
    visible: true,
    text: `“${libraryName}” is now associated with “${targetName}”. Use ${targetName} on this device too?`,
    yesLabel: `Use ${targetName}`,
    noLabel: `Keep ${activeProfileName}`,
    laterLabel: "Later",
  });
}

// [SYNCV3 / STAGE-09 / AMBIENT-PROFILE-PROMPT-UI]
// One action boundary for YES/NO/LATER (including X/Escape routed as LATER).
// It reads current authorities through injected functions and contains no
// shared association or Folder->Library mutation capability.
export async function performAmbientProfileAction({
  kind,
  pendingOffer,
  getCurrentContext,
  getAssociations,
  getKnownProfileIds,
  getActiveProfileId,
  switchProfile,
  saveDecision,
  now = Date.now,
} = {}) {
  if (!DECISION_KINDS.has(kind)) throw new TypeError("Unknown ambient Profile action.");
  if (!pendingOffer) return outcome("stale");

  const context = getCurrentContext();
  const contextMatches = context
    && context.localLibraryId === pendingOffer.localLibraryId
    && context.libraryId === pendingOffer.libraryId;
  if (!contextMatches) return outcome("stale");

  // [SYNCV3 / STAGE-09 / STALE-PROMPT-REVALIDATION]
  // [WHY: pending/display observedValue is stale-prone. Re-read association-map
  // membership and value at click time, then require equality only to prove the
  // displayed offer still applies. It never supplies a switch/save target.]
  const associations = getAssociations();
  if (!hasOwn(associations, context.libraryId)) return outcome("stale");
  let fact = associations[context.libraryId];
  const currentFactValue = typeof fact?.v === "string" && fact.v ? fact.v : null;
  if (!currentFactValue || currentFactValue !== pendingOffer.observedValue) {
    return outcome("stale", { currentFactValue });
  }
  if (!new Set(getKnownProfileIds()).has(currentFactValue)) {
    return outcome("stale", { currentFactValue });
  }
  if (getActiveProfileId() === currentFactValue) {
    return outcome("stale", { currentFactValue });
  }

  let switched = false;
  if (kind === "yes") {
    // [SYNCV3 / STAGE-09 / YES-SWITCH-BEFORE-PERSIST]
    // [WHY: a durable YES must never claim a switch that failed. The target is
    // the freshly read fact value; successful local switching precedes saving.
    // A later save failure leaves the honest successful local switch intact.]
    switched = Boolean(await switchProfile(currentFactValue));
    if (!switched) return outcome("switch-failed", { currentFactValue });

    // Switching is asynchronous. Revalidate once more before persisting YES so
    // a Library/fact change during that await cannot leave an obsolete durable
    // YES. The already-completed local switch remains honest and is not undone.
    const latestContext = getCurrentContext();
    const latestAssociations = getAssociations();
    if (!latestContext
      || latestContext.localLibraryId !== context.localLibraryId
      || latestContext.libraryId !== context.libraryId
      || !hasOwn(latestAssociations, context.libraryId)
      || latestAssociations[context.libraryId]?.v !== currentFactValue
      || !new Set(getKnownProfileIds()).has(currentFactValue)) {
      return outcome("stale-after-switch", { switched: true, currentFactValue });
    }
    fact = latestAssociations[context.libraryId];
  }

  const record = {
    libraryId: context.libraryId,
    kind,
    observedValue: currentFactValue,
    stamp: { t: fact.t, d: fact.d },
    decidedAt: now(),
  };

  try {
    // [SYNCV3 / STAGE-09 / LOCAL-DECISION-ONLY]
    // [WHY: NO/LATER exist only when this local row becomes durable. This save
    // is the entire effect for them; no association/link writer is available
    // in this module, and failure must keep the offer retryable.]
    await saveDecision(record);
  } catch (error) {
    return outcome("persistence-failed", { error, switched, currentFactValue });
  }

  return outcome("applied", { kind, switched, currentFactValue, decision: Object.freeze(record) });
}
