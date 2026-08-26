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
    return base("L0", "No folder loaded.", "muted");
  }

  if (!durable || !localLibraryId) {
    return base("L1", `${folderName} is available for this session only.`, "muted");
  }

  if (sourceKind === "fsa" && permissionState !== "granted") {
    return {
      ...base("L7", `${folderName} needs permission again. Its Library link is safe.`, "warning"),
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
      ...base("L6", `${libraryName} is already linked to ${otherFolder} on this device.`, "danger"),
      actionLabel: "Link to a Library",
      actionHelp: linkActionHelp(),
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
          ? `${folderName} is not linked to a Library yet.`
          : `${folderName} is ready to become a Library.`,
        "muted"
      ),
      actionLabel: hasCatalog ? "Link to a Library" : "Share this Library",
      actionHelp: hasCatalog ? linkActionHelp() : shareActionHelp(),
      showAction: true,
      allowPicker: hasCatalog,
      saveEnabled: Boolean(selectedLibraryId),
      defaultSelection: "",
    };
  }


  if (selectedLibraryId && selectedLibraryId !== sharedLibraryId) {
    return {
      ...base("L4", "Unlink this folder before linking it to a different Library.", "danger"),
      actionLabel: "Change link",
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
      ...base("L5", "This folder is linked to a Library that Browser Gallery cannot find yet.", "active"),
      actionLabel: "Change link",
      showAction: true,
      allowPicker: true,
      saveEnabled: false,
      defaultSelection: sharedLibraryId,
      sharedLibraryId,
    };
  }

  return {
    ...base("L4", `${folderName} is your copy of ${linkedLibrary.name}.`, "success"),
    actionLabel: "Change link",
    showAction: true,
    allowPicker: true,
    saveEnabled: true,
    defaultSelection: sharedLibraryId,
    sharedLibraryId,
    sharedLibraryName: linkedLibrary.name,
  };
}

function base(state, summary, tone) {
  return {
    state,
    summary,
    tone,
    actionLabel: "",
    actionHelp: "",
    showAction: false,
    allowPicker: false,
    saveEnabled: false,
    defaultSelection: "",
    reconnectNeeded: false,
    conflict: "",
    sharedLibraryId: null,
  };
}

function linkActionHelp() {
  return "Have this media collection on another device? Link this folder to the same Library. That tells Browser Gallery both folders are the same collection. Your photos and videos are not uploaded or moved.";
}

function shareActionHelp() {
  return "Have this media collection on another device, or plan to move it there? Share this Library so the other device can link its copy to the same collection. Your photos and videos are not uploaded or moved.";
}
