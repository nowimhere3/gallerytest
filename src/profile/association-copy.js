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
  folderName = "Loaded Media Folder",
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
      productLine: "No Media Folder loaded.",
      actionLabel: "",
      actionHelp: "",
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
      associatedText: remembered ? activeProfileName : "None chosen yet",
      productLine: remembered
        ? `${folderName} — remembered with ${activeProfileName}`
        : `${folderName} — no Curation chosen yet`,
      actionLabel: "",
      actionHelp: "",
      showAction: false,
      allowPicker: false,
      associatedProfileId: null,
    };
  }

  if (associatedProfileId && !associatedProfileName) {
    return {
      state: "S4",
      tone: "warning",
      associatedText: "Unavailable Curation",
      productLine: `${folderName} — remembers a Curation that no longer exists`,
      actionLabel: "Choose a Curation for this folder",
      actionHelp: chooseCurationBenefit(),
      showAction: canWriteAssociation,
      allowPicker: canWriteAssociation,
      associatedProfileId,
    };
  }

  if (!associatedProfileId) {
    return {
      state: "S1",
      tone: "muted",
      associatedText: "None chosen yet",
      productLine: `${folderName} — no Curation chosen yet`,
      actionLabel: "Choose a Curation for this folder",
      actionHelp: chooseCurationBenefit(),
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
      `${folderName} — remembered with ${associatedProfileName} Curation` + (isActive ? "" : " (not used on this device)"),
    actionLabel: "Change Curation for this folder",
    actionHelp: chooseCurationBenefit(),
    showAction: canWriteAssociation,
    allowPicker: canWriteAssociation,
    associatedProfileId,
  };
}

// [NORTH-STAR / N3-2 / CURATION-UI-COMPRESSION]
// The folder's remembered Curation and this device's active Curation remain
// separate state. Their second presentation earns ordinary UI only when the
// values actually diverge (or the folder has not resolved a Curation yet).
export function shouldShowActiveCurationChoice(associationUi) {
  return !associationUi || associationUi.state !== "S2";
}

// [SYNCV3 / STAGE-10 / FINAL-CLOSEOUT-POLISH]
// [WHY: the rail card's last line answers "why would I press that button?".
// Owned here, beside actionLabel, so the card's benefit and its action cannot
// drift apart or be derived twice.]
function chooseCurationBenefit() {
  return "Choose a Curation to remember the Favorites, Hidden items and Tags you want to use with this folder.";
}
