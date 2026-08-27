import { mapLinkState } from "../src/profile/link-state.js";

let assertions = 0;
function assert(condition, label) {
  if (!condition) throw new Error(label);
  assertions += 1;
}

function verify(name, input, expected) {
  const snapshot = structuredClone(input);
  const actual = mapLinkState(input);
  for (const [key, value] of Object.entries(expected)) {
    assert(actual[key] === value, `${name}: ${key} expected ${JSON.stringify(value)}, got ${JSON.stringify(actual[key])}`);
  }
  assert(JSON.stringify(input) === JSON.stringify(snapshot), `${name}: input was not mutated`);
}

const HELP = "Which collection of photos and videos this Media Folder represents. Choose the same Media Library on each device where you open that collection.";

const catalog = [
  { id: "shared-a", name: "Nature", sourceDeviceName: "Studio" },
  { id: "shared-b", name: "Nature", sourceDeviceName: "Laptop" },
];

verify("L0", {}, { state: "L0", tone: "muted", summary: "No Media Folder loaded.", showAction: false, allowPicker: false });
verify("L1", { sourceKind: "legacy", folderName: "Selected files" }, {
  state: "L1", tone: "muted", summary: "Selected files is available for this session only.", showAction: false, allowPicker: false,
});
verify("L2", { sourceKind: "fsa", localLibraryId: "local-a", folderName: "Folder A" }, {
  state: "L2", tone: "muted", summary: "Folder A is ready for its first Media Library.",
  actionLabel: "", showAction: false, allowPicker: true, defaultSelection: "",
  actionHelp: HELP,
});
verify("L3", { sourceKind: "fsa", localLibraryId: "local-a", folderName: "Folder A", sharedLibraries: catalog }, {
  state: "L3", tone: "muted", summary: "Folder A has no Media Library yet.",
  actionLabel: "", showAction: false, allowPicker: true, defaultSelection: "", saveEnabled: false,
  actionHelp: HELP,
});
verify("L4", {
  sourceKind: "fsa", localLibraryId: "local-a", folderName: "Folder A",
  sharedLibraryId: "shared-a", sharedLibraries: catalog,
}, {
  state: "L4", tone: "success", summary: "Folder A uses the Nature Media Library.",
  actionLabel: "", showAction: false, allowPicker: true,
  defaultSelection: "shared-a", saveEnabled: true, sharedLibraryName: "Nature",
});
verify("direct relink refusal", {
  sourceKind: "fsa", localLibraryId: "local-a", folderName: "Folder A",
  sharedLibraryId: "shared-a", selectedLibraryId: "shared-b", sharedLibraries: catalog,
}, {
  state: "L4", tone: "danger", summary: "Remove this Media Folder from its Media Library before choosing a different one.",
  actionLabel: "", showAction: false, allowPicker: true, saveEnabled: false,
  conflict: "Remove this Media Folder from its Media Library first.", defaultSelection: "shared-a",
});
verify("L5", {
  sourceKind: "fsa", localLibraryId: "local-a", folderName: "Folder A",
  sharedLibraryId: "not-arrived", sharedLibraries: catalog,
}, {
  state: "L5", tone: "active", summary: "This Media Folder uses a Media Library that Browser Gallery cannot find yet.",
  actionLabel: "", showAction: false, allowPicker: true, sharedLibraryId: "not-arrived",
});
verify("L6", {
  sourceKind: "fsa", localLibraryId: "local-b", folderName: "Folder B", sharedLibraries: catalog,
  selectedLibraryId: "shared-a", selectedClaimant: { id: "local-a", name: "Folder A" },
}, {
  state: "L6", tone: "danger", summary: "Nature already represents Folder A on this device.",
  showAction: false, allowPicker: true, saveEnabled: false,
  conflict: "Remove Folder A from that Media Library first.", selectedLibraryId: "shared-a",
});
verify("L7", {
  sourceKind: "fsa", localLibraryId: "local-a", folderName: "Folder A",
  sharedLibraryId: "shared-a", sharedLibraries: catalog, permissionState: "prompt",
}, {
  state: "L7", tone: "warning", summary: "Folder A needs permission again. Its Media Library is safe.",
  actionLabel: "Reconnect Media Folder", showAction: true, reconnectNeeded: true, sharedLibraryId: "shared-a",
});
verify("durable legacy folder", {
  sourceKind: "legacy", legacyHasDurableIdentity: true, localLibraryId: "legacy-a", folderName: "Legacy A",
}, { state: "L2", tone: "muted", actionLabel: "", allowPicker: true });

assert(mapLinkState({ sourceKind: "fsa", localLibraryId: "local-a", sharedLibraries: catalog }).tone !== "warning",
  "ordinary unlinked folder is not warning");
assert(mapLinkState({ sourceKind: "fsa", localLibraryId: "local-a", sharedLibraries: catalog }).allowPicker === true,
  "the Media Library selector remains available without any Sync configuration input");
assert(mapLinkState({
  sourceKind: "fsa", localLibraryId: "local-b", sharedLibraries: catalog,
  selectedLibraryId: "shared-a", selectedClaimant: { id: "local-a", name: "Folder A" },
}).tone === "danger", "real claimant conflict remains danger");
assert(mapLinkState({
  sourceKind: "fsa", localLibraryId: "local-a", sharedLibraryId: "shared-a", sharedLibraries: catalog,
}).tone === "success", "healthy linked folder remains success");

// [SYNCV3 / STAGE-10 / MEDIA-LIBRARY-SELECTION]
// Customer-facing "link"/"unlink"/"share" was retired in favour of selection.
// The MODULE is still called link-state and still returns L0-L7 — that is the
// Stage 08 architecture and is deliberately untouched — so this guard is aimed
// at the strings a reader actually sees, not at the code around them.
const everyState = [
  mapLinkState({}),
  mapLinkState({ sourceKind: "legacy", folderName: "Selected files" }),
  mapLinkState({ sourceKind: "fsa", localLibraryId: "local-a", folderName: "Folder A" }),
  mapLinkState({ sourceKind: "fsa", localLibraryId: "local-a", folderName: "Folder A", sharedLibraries: catalog }),
  mapLinkState({ sourceKind: "fsa", localLibraryId: "local-a", folderName: "Folder A", sharedLibraryId: "shared-a", sharedLibraries: catalog }),
  mapLinkState({ sourceKind: "fsa", localLibraryId: "local-a", folderName: "Folder A", sharedLibraryId: "shared-a", selectedLibraryId: "shared-b", sharedLibraries: catalog }),
  mapLinkState({ sourceKind: "fsa", localLibraryId: "local-a", folderName: "Folder A", sharedLibraryId: "not-arrived", sharedLibraries: catalog }),
  mapLinkState({ sourceKind: "fsa", localLibraryId: "local-b", folderName: "Folder B", sharedLibraries: catalog, selectedLibraryId: "shared-a", selectedClaimant: { id: "local-a", name: "Folder A" } }),
  mapLinkState({ sourceKind: "fsa", localLibraryId: "local-a", folderName: "Folder A", sharedLibraryId: "shared-a", sharedLibraries: catalog, permissionState: "prompt" }),
];
const RETIRED = /\b(link|linked|linking|unlink|unlinking|shared)\b/i;
for (const state of everyState) {
  for (const field of ["summary", "actionLabel", "actionHelp", "conflict"]) {
    const copy = state[field] || "";
    assert(!RETIRED.test(copy), `${state.state} ${field} avoids retired link/shared vocabulary: ${JSON.stringify(copy)}`);
  }
}

// Selection, not an operation: every durable state offers the selector, and the
// only state that still offers a BUTTON is the one with a genuine action.
for (const state of everyState) {
  if (state.state === "L0" || state.state === "L1") {
    assert(!state.allowPicker, `${state.state} has no Media Folder to describe`);
    continue;
  }
  if (state.state === "L7") {
    assert(state.showAction && state.actionLabel === "Reconnect Media Folder", "L7 keeps its real action");
    continue;
  }
  assert(state.allowPicker, `${state.state} shows the Media Library selector`);
  assert(!state.showAction && state.actionLabel === "", `${state.state} needs no button before the selector`);
  assert(state.actionHelp === HELP, `${state.state} carries the one selector explanation`);
}

// Stage 08 semantics are frozen: choosing a different Media Library directly is
// still refused until the current one is removed, and a claimant collision is
// still a danger-toned refusal with Save disabled.
const relink = mapLinkState({
  sourceKind: "fsa", localLibraryId: "local-a", folderName: "Folder A",
  sharedLibraryId: "shared-a", selectedLibraryId: "shared-b", sharedLibraries: catalog,
});
assert(relink.saveEnabled === false && relink.tone === "danger", "direct relink is still refused");
const claim = mapLinkState({
  sourceKind: "fsa", localLibraryId: "local-b", sharedLibraries: catalog,
  selectedLibraryId: "shared-a", selectedClaimant: { id: "local-a", name: "Folder A" },
});
assert(claim.saveEnabled === false && claim.tone === "danger", "claimant collision is still refused");

console.log(`link state: ${assertions} assertions passed`);
