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

verify("L0", {}, { state: "L0", tone: "muted", summary: "No folder loaded.", showAction: false, allowPicker: false });
verify("L1", { sourceKind: "legacy", folderName: "Selected files" }, {
  state: "L1", tone: "muted", summary: "Selected files is available for this session only.", showAction: false, allowPicker: false,
});
verify("L2", { sourceKind: "fsa", localLibraryId: "local-a", folderName: "Folder A" }, {
  state: "L2", tone: "muted", summary: "Folder A is ready to become a Library.",
  actionLabel: "Share this Library", allowPicker: false, defaultSelection: "",
  actionHelp: "Have this media collection on another device, or plan to move it there? Share this Library so the other device can link its copy to the same collection. Your photos and videos are not uploaded or moved.",
});
verify("L3", { sourceKind: "fsa", localLibraryId: "local-a", folderName: "Folder A", sharedLibraries: catalog }, {
  state: "L3", tone: "muted", summary: "Folder A is not linked to a Library yet.",
  actionLabel: "Link to a Library", allowPicker: true, defaultSelection: "", saveEnabled: false,
  actionHelp: "Have this media collection on another device? Link this folder to the same Library. That tells Browser Gallery both folders are the same collection. Your photos and videos are not uploaded or moved.",
});
verify("L4", {
  sourceKind: "fsa", localLibraryId: "local-a", folderName: "Folder A",
  sharedLibraryId: "shared-a", sharedLibraries: catalog,
}, {
  state: "L4", tone: "success", summary: "Folder A is your copy of Nature.", actionLabel: "Change link",
  defaultSelection: "shared-a", saveEnabled: true,
});
verify("direct relink refusal", {
  sourceKind: "fsa", localLibraryId: "local-a", folderName: "Folder A",
  sharedLibraryId: "shared-a", selectedLibraryId: "shared-b", sharedLibraries: catalog,
}, {
  state: "L4", tone: "danger", summary: "Unlink this folder before linking it to a different Library.",
  actionLabel: "Change link", saveEnabled: false, conflict: "Unlink this folder first.", defaultSelection: "shared-a",
});
verify("L5", {
  sourceKind: "fsa", localLibraryId: "local-a", folderName: "Folder A",
  sharedLibraryId: "not-arrived", sharedLibraries: catalog,
}, {
  state: "L5", tone: "active", summary: "This folder is linked to a Library that Browser Gallery cannot find yet.",
  actionLabel: "Change link", sharedLibraryId: "not-arrived",
});
verify("L6", {
  sourceKind: "fsa", localLibraryId: "local-b", folderName: "Folder B", sharedLibraries: catalog,
  selectedLibraryId: "shared-a", selectedClaimant: { id: "local-a", name: "Folder A" },
}, {
  state: "L6", tone: "danger", summary: "Nature is already linked to Folder A on this device.",
  saveEnabled: false, conflict: "Unlink Folder A first.", selectedLibraryId: "shared-a",
});
verify("L7", {
  sourceKind: "fsa", localLibraryId: "local-a", folderName: "Folder A",
  sharedLibraryId: "shared-a", sharedLibraries: catalog, permissionState: "prompt",
}, {
  state: "L7", tone: "warning", summary: "Folder A needs permission again. Its Library link is safe.",
  actionLabel: "Reconnect Folder", reconnectNeeded: true, sharedLibraryId: "shared-a",
});
verify("durable legacy folder", {
  sourceKind: "legacy", legacyHasDurableIdentity: true, localLibraryId: "legacy-a", folderName: "Legacy A",
}, { state: "L2", tone: "muted", actionLabel: "Share this Library" });

assert(mapLinkState({ sourceKind: "fsa", localLibraryId: "local-a", sharedLibraries: catalog }).tone !== "warning",
  "ordinary unlinked folder is not warning");
assert(mapLinkState({ sourceKind: "fsa", localLibraryId: "local-a", sharedLibraries: catalog }).actionLabel === "Link to a Library",
  "Link to a Library remains available without any Sync configuration input");
assert(mapLinkState({
  sourceKind: "fsa", localLibraryId: "local-b", sharedLibraries: catalog,
  selectedLibraryId: "shared-a", selectedClaimant: { id: "local-a", name: "Folder A" },
}).tone === "danger", "real claimant conflict remains danger");
assert(mapLinkState({
  sourceKind: "fsa", localLibraryId: "local-a", sharedLibraryId: "shared-a", sharedLibraries: catalog,
}).tone === "success", "healthy linked folder remains success");

console.log(`link state: ${assertions} assertions passed`);
