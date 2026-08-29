// [SYNCV3 / STAGE-08 / LINK-STATE]
// [WHY: "This Media Folder" is local link state while "This Media Library"
// remains shared Profile-association state; the two must not collapse into one
// concept.]
// Pure L0-L7 mapping: no DOM, storage, ProfileStore, or writes.
//
// BREADCRUMBS — IS: the CUSTOMER-FACING model is SELECTION. A Media Library is
//   presented as a property of the loaded Media Folder ("which Media Library
//   does this Media Folder represent?"), never as a filesystem operation. The
//   selector is the change affordance, so `showAction`/`actionLabel` now serve
//   exactly one real action — L7 reconnect — and `allowPicker` means "show the
//   Media Library selector", which is true for every durable folder including
//   one with an empty catalog (it can still create the first Media Library).
// BREADCRUMBS — WAS: these states drove a "Link to a Library" / "Share this
//   Library" / "Unlink" button pair. Three rounds of first-time-user testing
//   showed "link" made users expect folders to be merged, copied, synchronized
//   or symlinked — the opposite of the trust model. The verbs were retired from
//   visible copy only.
// BREADCRUMBS — FUTURE: the L0-L7 codes, the local-only ownership of the
//   Folder->Library relationship and the direct-relink refusal are Stage 08
//   semantics and stay frozen. Presentation may keep moving; do not reintroduce
//   customer-facing link/unlink language to describe them.
export function mapLinkState({
  sourceKind = "none",
  legacyHasDurableIdentity = false,
  folderName = "Loaded Media Folder",
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
    return base("L0", "No Media Folder loaded.", "muted");
  }

  if (!durable || !localLibraryId) {
    return base("L1", `${folderName} is available for this session only.`, "muted");
  }

  if (sourceKind === "fsa" && permissionState !== "granted") {
    return {
      ...base("L7", `${folderName} needs permission again. Its Media Library is safe.`, "warning"),
      actionLabel: "Reconnect Media Folder",
      showAction: true,
      reconnectNeeded: true,
      sharedLibraryId,
    };
  }

  if (!sharedLibraryId && selectedLibraryId && selectedClaimant) {
    const libraryName = selectedLibrary ? selectedLibrary.name : "That Media Library";
    const otherFolder = selectedClaimant.name || "another Media Folder";
    return {
      ...base("L6", `${libraryName} already represents ${otherFolder} on this device.`, "danger"),
      actionHelp: mediaLibraryHelp(),
      allowPicker: true,
      saveEnabled: false,
      conflict: `Remove ${otherFolder} from that Media Library first.`,
      selectedLibraryId,
    };
  }

  if (!sharedLibraryId) {
    const hasCatalog = catalog.length > 0;
    return {
      ...base(
        hasCatalog ? "L3" : "L2",
        hasCatalog
          ? `${folderName} has no Media Library yet.`
          : `${folderName} is ready for its first Media Library.`,
        "muted"
      ),
      actionHelp: mediaLibraryHelp(),
      allowPicker: true,
      saveEnabled: Boolean(selectedLibraryId),
      defaultSelection: "",
    };
  }


  if (selectedLibraryId && selectedLibraryId !== sharedLibraryId) {
    return {
      ...base("L4", "Remove this Media Folder from its Media Library before choosing a different one.", "danger"),
      actionHelp: mediaLibraryHelp(),
      allowPicker: true,
      saveEnabled: false,
      conflict: "Remove this Media Folder from its Media Library first.",
      defaultSelection: sharedLibraryId,
      sharedLibraryId,
    };
  }

  const linkedLibrary = catalog.find((library) => library.id === sharedLibraryId) || null;
  if (!linkedLibrary) {
    return {
      ...base("L5", "This Media Folder uses a Media Library that Browser Gallery cannot find yet.", "active"),
      actionHelp: mediaLibraryHelp(),
      allowPicker: true,
      saveEnabled: false,
      defaultSelection: sharedLibraryId,
      sharedLibraryId,
    };
  }

  return {
    ...base("L4", `${folderName} uses the ${linkedLibrary.name} Media Library.`, "success"),
    actionHelp: mediaLibraryHelp(),
    allowPicker: true,
    saveEnabled: true,
    defaultSelection: sharedLibraryId,
    sharedLibraryId,
    sharedLibraryName: linkedLibrary.name,
  };
}

// [NORTH-STAR / N1 / PROGRESSIVE-DISCLOSURE]
// BREADCRUMBS — IS: disclosure routes on LINK STATE only. The ordinary surface
//   never shows Media Library administration; Advanced exposes it; L7 recovery
//   and L5 status stay ordinary.
// BREADCRUMBS — WAS: `allowPicker` exposed identity administration to every
//   durable folder, including customers who had no identity decision to make.
// BREADCRUMBS — WILL BE / FUTURE: N2 may extend this seam with a real unresolved
//   cross-device decision for the current folder, never mere peer presence.
export function describeMediaLibrarySurface({ linkState, surface } = {}) {
  if (!linkState || !["ordinary", "advanced"].includes(surface)) {
    throw new TypeError("A linkState and an ordinary or advanced surface are required.");
  }

  if (surface === "advanced") {
    return Object.freeze({
      showSelector: true,
      showStatus: true,
      showRecoveryAction: false,
      statusText: linkState.summary,
    });
  }

  // BREADCRUMBS — IS: ordinary L5/L7 copy names the customer's saved setup;
  //   Advanced passes mapLinkState's precise diagnostic summary through.
  // BREADCRUMBS — WAS: recovery copy named Media Library on the ordinary path,
  //   reintroducing the plumbing vocabulary N1 exists to contain.
  const statusText = linkState.state === "L5"
    ? "Browser Gallery can't find this folder's saved setup yet."
    : linkState.state === "L7"
      ? ordinaryPermissionStatus(linkState.summary)
      : "";
  return Object.freeze({
    showSelector: false,
    showStatus: Boolean(statusText),
    showRecoveryAction: linkState.state === "L7" && linkState.reconnectNeeded === true,
    statusText,
  });
}

function ordinaryPermissionStatus(summary) {
  const permissionLead = String(summary || "").split(". Its Media Library is safe.")[0];
  return `${permissionLead}. Your setup is safe.`;
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

// [SYNCV3 / STAGE-10 / MEDIA-LIBRARY-SELECTION]
// [WHY: one helper sentence pair for every durable state. The old model needed
// two different explanations because Share and Link were two different buttons;
// selecting from a list is one idea, so it gets one explanation.]
function mediaLibraryHelp() {
  return "Which collection of photos and videos this Media Folder represents. Choose the same Media Library on each device where you open that collection.";
}
