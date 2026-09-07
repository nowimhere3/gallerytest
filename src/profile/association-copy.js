// [SYNCV3 / STAGE-07 / ASSOCIATION-STATE]
// Pure S0-S5 association mapping. Every association display consumes this
// result so Settings, the rail, and mobile cannot derive competing answers.
//
// BREADCRUMBS - WAS
// Current-media Curation presentation assumed the loaded source was a Media Folder. Remote Floppy sessions discarded their source provenance and therefore fell into the "no media folder" association state even while media was successfully loaded.
//
// BREADCRUMBS - IS
// mapAssociationCopy() is the single source-neutral presentation/action authority for CURRENT MEDIA -> CURATION. It understands local folders, temporary local selections, Floppy Disks and Floppy Folders while durable persistence remains owned by each source's existing subsystem.
//
// BREADCRUMBS - WILL BE
// New media source types must extend this shared current-media association mapping rather than adding source-specific Curation UI. Device-local Floppy persistence is added separately and must never collapse cassette identity into shared Media Library / Sync identity.
export function mapAssociationCopy({
  sourceKind = "none",
  legacyHasDurableIdentity = false,
  mediaName = "Loaded Media Folder",
  folderName,
  rememberedSourceId = null,
  associatedProfileId = null,
  associatedProfileName = null,
  activeProfileId = null,
  activeProfileName = null,
  legacySessionAssociated = false,
  canWriteAssociation = true,
} = {}) {
  const displayName = folderName || mediaName;
  const isCassette = sourceKind === "cassette" || sourceKind === "cassette-folder";
  const durable = sourceKind === "fsa"
    || (sourceKind === "legacy" && legacyHasDurableIdentity)
    || (isCassette && Boolean(rememberedSourceId));
  const sourceLabel = sourceKind === "fsa" || (sourceKind === "legacy" && legacyHasDurableIdentity)
    ? "Local Folder"
    : sourceKind === "legacy"
      ? "Selected Files"
      : sourceKind === "cassette"
        ? "Floppy Disk"
        : sourceKind === "cassette-folder"
          ? "Floppy Folder"
          : "";
  const associationScope = sourceKind === "none" ? "none" : durable ? (isCassette ? "device" : "shared") : "session";
  const scopeNote = associationScope === "shared"
    ? "Remembered with this Media Library."
    : associationScope === "device"
      ? "Remembered on this device."
      : associationScope === "session"
        ? "Used for this session only."
        : "";
  const sourceLine = sourceKind === "none" ? "No media loaded." : `${displayName} · ${sourceLabel}`;
  const writable = canWriteAssociation;
  const common = { sourceLabel, sourceLine, associationScope, scopeNote };

  if (sourceKind === "none") {
    return {
      ...common, state: "S0", tone: "muted", associatedText: "—",
      productLine: "No media loaded.", actionLabel: "", actionHelp: "",
      showAction: false, allowPicker: false, associatedProfileId: null,
    };
  }

  if (!durable) {
    const sessionProfile = activeProfileName || (legacySessionAssociated ? associatedProfileName : null) || "None chosen yet";
    return {
      ...common, state: "S5", tone: "muted", associatedText: sessionProfile,
      productLine: `${displayName} — used for this session only. Curation: ${sessionProfile}`,
      actionLabel: "", actionHelp: "", showAction: false, allowPicker: false,
      associatedProfileId: null,
    };
  }

  if (associatedProfileId && !associatedProfileName) {
    return {
      ...common, state: "S4", tone: "warning", associatedText: "Unavailable Curation",
      productLine: `${displayName} — remembers a Curation that no longer exists`,
      actionLabel: "Choose a Curation for this media", actionHelp: chooseCurationBenefit(),
      showAction: writable, allowPicker: writable, associatedProfileId,
    };
  }

  if (!associatedProfileId) {
    return {
      ...common, state: "S1", tone: "muted", associatedText: "None chosen yet",
      productLine: `${displayName} — no Curation chosen yet`,
      actionLabel: "Choose a Curation for this media", actionHelp: chooseCurationBenefit(),
      showAction: writable, allowPicker: writable, associatedProfileId: null,
    };
  }

  const isActive = associatedProfileId === activeProfileId;
  return {
    ...common, state: isActive ? "S2" : "S3", tone: isActive ? "success" : "active",
    associatedText: associatedProfileName,
    productLine: `${displayName} — remembered with ${associatedProfileName} Curation`
      + (isActive ? "" : " (not used on this device)"),
    actionLabel: "Change Curation for this media", actionHelp: chooseCurationBenefit(),
    showAction: writable, allowPicker: writable, associatedProfileId,
  };
}

export function shouldShowActiveCurationChoice(associationUi) {
  return !associationUi || associationUi.state !== "S2";
}

function chooseCurationBenefit() {
  return "Choose a Curation to remember the Favorites, Hidden items and Tags you want to use with this media.";
}
