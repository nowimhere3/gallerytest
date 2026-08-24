// [SYNCV3 / STAGE-07 / ASSOCIATION-STATE]
// Pure S0-S5 association mapping. Every association display consumes this
// result so Settings, the rail, and mobile cannot derive competing answers.
export function mapAssociationCopy({
  sourceKind = "none",
  legacyHasDurableIdentity = false,
  folderName = "Loaded folder",
  associatedProfileId = null,
  associatedProfileName = null,
  activeProfileId = null,
  activeProfileName = null,
  legacySessionAssociated = false,
  canWriteAssociation = true,
} = {}) {
  if (sourceKind === "none") {
    return {
      state: "S0",
      associatedText: "—",
      productLine: "No folder loaded.",
      actionLabel: "",
      showAction: false,
      allowPicker: false,
      associatedProfileId: null,
    };
  }

  const durable = sourceKind === "fsa" || (sourceKind === "legacy" && legacyHasDurableIdentity);
  if (!durable) {
    const remembered = legacySessionAssociated && activeProfileName;
    return {
      state: "S5",
      associatedText: remembered ? activeProfileName : "Not associated",
      productLine: remembered
        ? `${folderName} — remembered with ${activeProfileName}`
        : `${folderName} — not linked to a Profile yet`,
      actionLabel: "",
      showAction: false,
      allowPicker: false,
      associatedProfileId: null,
    };
  }

  if (associatedProfileId && !associatedProfileName) {
    return {
      state: "S4",
      associatedText: "Unavailable Profile",
      productLine: `${folderName} — remembers a Profile that no longer exists`,
      actionLabel: "Choose a Profile",
      showAction: canWriteAssociation,
      allowPicker: canWriteAssociation,
      associatedProfileId,
    };
  }

  if (!associatedProfileId) {
    return {
      state: "S1",
      associatedText: "Not associated",
      productLine: `${folderName} — not linked to a Profile yet`,
      actionLabel: "Associate Current Library",
      showAction: canWriteAssociation,
      allowPicker: canWriteAssociation,
      associatedProfileId: null,
    };
  }

  const isActive = associatedProfileId === activeProfileId;
  return {
    state: isActive ? "S2" : "S3",
    associatedText: associatedProfileName,
    productLine:
      `${folderName} — remembered with ${associatedProfileName}` + (isActive ? "" : " (not your active Profile)"),
    actionLabel: "Change Association",
    showAction: canWriteAssociation,
    allowPicker: canWriteAssociation,
    associatedProfileId,
  };
}
