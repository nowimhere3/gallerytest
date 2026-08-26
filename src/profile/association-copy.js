// [SYNCV3 / STAGE-07 / ASSOCIATION-STATE]
// Pure S0-S5 association mapping. Every association display consumes this
// result so Settings, the rail, and mobile cannot derive competing answers.
// [SYNCV3 / STAGE-10 / VOCABULARY]
// [WHY: Folder <-> Library is a link; Library <-> Profile is what the Library
// remembers. Keeping those user-facing terms distinct prevents two different
// identity relationships from sounding like the same operation.]
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
      tone: "muted",
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
      tone: "muted",
      associatedText: remembered ? activeProfileName : "No Profile",
      productLine: remembered
        ? `${folderName} — remembered with ${activeProfileName}`
        : `${folderName} — no Profile chosen yet`,
      actionLabel: "",
      showAction: false,
      allowPicker: false,
      associatedProfileId: null,
    };
  }

  if (associatedProfileId && !associatedProfileName) {
    return {
      state: "S4",
      tone: "warning",
      associatedText: "Unavailable Profile",
      productLine: `${folderName} — remembers a Profile that no longer exists`,
      actionLabel: "Choose a Profile for this Library",
      showAction: canWriteAssociation,
      allowPicker: canWriteAssociation,
      associatedProfileId,
    };
  }

  if (!associatedProfileId) {
    return {
      state: "S1",
      tone: "muted",
      associatedText: "No Profile",
      productLine: `${folderName} — no Profile chosen yet`,
      actionLabel: "Choose a Profile for this Library",
      showAction: canWriteAssociation,
      allowPicker: canWriteAssociation,
      associatedProfileId: null,
    };
  }

  const isActive = associatedProfileId === activeProfileId;
  return {
    state: isActive ? "S2" : "S3",
    // [SYNCV3 / STAGE-10 / STATUS-TONES]
    // [WHY: Active Profile differing from the Library's remembered Profile is
    // an intentional Stage 09 state, so it is informational rather than warning.]
    tone: isActive ? "success" : "active",
    associatedText: associatedProfileName,
    productLine:
      `${folderName} — remembered with ${associatedProfileName}` + (isActive ? "" : " (not your active Profile)"),
    actionLabel: "Change Profile for this Library",
    showAction: canWriteAssociation,
    allowPicker: canWriteAssociation,
    associatedProfileId,
  };
}
