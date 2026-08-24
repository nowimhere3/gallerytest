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

const catalog = [
  { id: "shared-a", name: "Nature", sourceDeviceName: "Studio" },
  { id: "shared-b", name: "Nature", sourceDeviceName: "Laptop" },
];

verify("L0", {}, { state: "L0", summary: "No folder loaded.", showAction: false, allowPicker: false });
verify("L1", { sourceKind: "legacy", folderName: "Selected files" }, {
  state: "L1", summary: "Selected files is available for this session only.", showAction: false, allowPicker: false,
});
verify("L2", { sourceKind: "fsa", localLibraryId: "local-a", folderName: "Folder A" }, {
  state: "L2", summary: "Folder A is ready to become a shared Library.",
  actionLabel: "Share this Library", allowPicker: false, defaultSelection: "",
});
verify("L3", { sourceKind: "fsa", localLibraryId: "local-a", folderName: "Folder A", sharedLibraries: catalog }, {
  state: "L3", summary: "Folder A is not linked to a shared Library.",
  actionLabel: "Link to a Library", allowPicker: true, defaultSelection: "", saveEnabled: false,
});
verify("L4", {
  sourceKind: "fsa", localLibraryId: "local-a", folderName: "Folder A",
  sharedLibraryId: "shared-a", sharedLibraries: catalog,
}, {
  state: "L4", summary: "Folder A is your copy of Nature.", actionLabel: "Change or Unlink",
  defaultSelection: "shared-a", saveEnabled: true,
});
verify("direct relink refusal", {
  sourceKind: "fsa", localLibraryId: "local-a", folderName: "Folder A",
  sharedLibraryId: "shared-a", selectedLibraryId: "shared-b", sharedLibraries: catalog,
}, {
  state: "L4", summary: "Unlink this folder before linking it to a different Library.",
  saveEnabled: false, conflict: "Unlink this folder first.", defaultSelection: "shared-a",
});
verify("L5", {
  sourceKind: "fsa", localLibraryId: "local-a", folderName: "Folder A",
  sharedLibraryId: "not-arrived", sharedLibraries: catalog,
}, {
  state: "L5", summary: "This folder is linked to a Library your devices haven't shared yet.",
  actionLabel: "Change or Unlink", sharedLibraryId: "not-arrived",
});
verify("L6", {
  sourceKind: "fsa", localLibraryId: "local-b", folderName: "Folder B", sharedLibraries: catalog,
  selectedLibraryId: "shared-a", selectedClaimant: { id: "local-a", name: "Folder A" },
}, {
  state: "L6", summary: "Nature is already linked to Folder A on this device.",
  saveEnabled: false, conflict: "Unlink Folder A first.", selectedLibraryId: "shared-a",
});
verify("L7", {
  sourceKind: "fsa", localLibraryId: "local-a", folderName: "Folder A",
  sharedLibraryId: "shared-a", sharedLibraries: catalog, permissionState: "prompt",
}, {
  state: "L7", summary: "Folder A needs permission again. Its Library link is safe.",
  actionLabel: "Reconnect Folder", reconnectNeeded: true, sharedLibraryId: "shared-a",
});
verify("durable legacy folder", {
  sourceKind: "legacy", legacyHasDurableIdentity: true, localLibraryId: "legacy-a", folderName: "Legacy A",
}, { state: "L2", actionLabel: "Share this Library" });

console.log(`link state: ${assertions} assertions passed`);
