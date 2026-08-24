// [SYNCV3 / STAGE-08 / LINK-STATE]
// [WHY: "This Folder" is local link state while "This Library" remains
// shared Profile-association state; the two must not collapse into one concept.]
// Pure L0-L7 mapping: no DOM, storage, ProfileStore, or writes.
export function mapLinkState({
  sourceKind = "none",
  legacyHasDurableIdentity = false,
  folderName = "Loaded folder",
  localLibraryId = null,
  sharedLibraryId = null,
  sharedLibraries = [],
  permissionState = "granted",
  selectedLibraryId = null,
  selectedClaimant = null,
} = {}) {
  const catalog = Array.isArray(sharedLibraries) ? sharedLibraries : [];
  const durable = sourceKind === "fsa" || (sourceKind === "legacy" && legacyHasDurableIdentity);
  const selectedLibrary = selectedLibraryId
    ? catalog.find((library) => library.id === selectedLibraryId) || null
    : null;

  if (sourceKind === "none") {
    return base("L0", "No folder loaded.");
  }

  if (!durable || !localLibraryId) {
    return base("L1", `${folderName} is available for this session only.`);
  }

  if (sourceKind === "fsa" && permissionState !== "granted") {
    return {
      ...base("L7", `${folderName} needs permission again. Its Library link is safe.`),
      actionLabel: "Reconnect Folder",
      showAction: true,
      reconnectNeeded: true,
      sharedLibraryId,
    };
  }

  if (!sharedLibraryId && selectedLibraryId && selectedClaimant) {
    const libraryName = selectedLibrary ? selectedLibrary.name : "That Library";
    const otherFolder = selectedClaimant.name || "another folder";
    return {
      ...base("L6", `${libraryName} is already linked to ${otherFolder} on this device.`),
      actionLabel: "Link to a Library",
      showAction: true,
      allowPicker: true,
      saveEnabled: false,
      conflict: `Unlink ${otherFolder} first.`,
      selectedLibraryId,
    };
  }

  if (!sharedLibraryId) {
    const hasCatalog = catalog.length > 0;
    return {
      ...base(
        hasCatalog ? "L3" : "L2",
        hasCatalog
          ? `${folderName} is not linked to a shared Library.`
          : `${folderName} is ready to become a shared Library.`
      ),
      actionLabel: hasCatalog ? "Link to a Library" : "Share this Library",
      showAction: true,
      allowPicker: hasCatalog,
      saveEnabled: Boolean(selectedLibraryId),
      defaultSelection: "",
    };
  }


  if (selectedLibraryId && selectedLibraryId !== sharedLibraryId) {
    return {
      ...base("L4", "Unlink this folder before linking it to a different Library."),
      actionLabel: "Change or Unlink",
      showAction: true,
      allowPicker: true,
      saveEnabled: false,
      conflict: "Unlink this folder first.",
      defaultSelection: sharedLibraryId,
      sharedLibraryId,
    };
  }

  const linkedLibrary = catalog.find((library) => library.id === sharedLibraryId) || null;
  if (!linkedLibrary) {
    return {
      ...base("L5", "This folder is linked to a Library your devices haven't shared yet."),
      actionLabel: "Change or Unlink",
      showAction: true,
      allowPicker: true,
      saveEnabled: false,
      defaultSelection: sharedLibraryId,
      sharedLibraryId,
    };
  }

  return {
    ...base("L4", `${folderName} is your copy of ${linkedLibrary.name}.`),
    actionLabel: "Change or Unlink",
    showAction: true,
    allowPicker: true,
    saveEnabled: true,
    defaultSelection: sharedLibraryId,
    sharedLibraryId,
    sharedLibraryName: linkedLibrary.name,
  };
}

function base(state, summary) {
  return {
    state,
    summary,
    actionLabel: "",
    showAction: false,
    allowPicker: false,
    saveEnabled: false,
    defaultSelection: "",
    reconnectNeeded: false,
    conflict: "",
    sharedLibraryId: null,
  };
}
