import fs from "node:fs";
import { describeMediaLibrarySurface, mapLinkState } from "../src/profile/link-state.js";

function assert(condition, message) {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

const catalog = [{ id: "shared-a", name: "Nature" }];
const states = [
  mapLinkState({}),
  mapLinkState({ sourceKind: "legacy", folderName: "Selected files" }),
  mapLinkState({ sourceKind: "fsa", localLibraryId: "local-a", folderName: "Nature" }),
  mapLinkState({ sourceKind: "fsa", localLibraryId: "local-a", folderName: "Nature", sharedLibraries: catalog }),
  mapLinkState({ sourceKind: "fsa", localLibraryId: "local-a", folderName: "Nature", sharedLibraryId: "shared-a", sharedLibraries: catalog }),
  mapLinkState({ sourceKind: "fsa", localLibraryId: "local-a", folderName: "Nature", sharedLibraryId: "missing", sharedLibraries: catalog }),
  mapLinkState({ sourceKind: "fsa", localLibraryId: "local-b", folderName: "Trips", sharedLibraries: catalog, selectedLibraryId: "shared-a", selectedClaimant: { id: "local-a", name: "Nature" } }),
  mapLinkState({ sourceKind: "fsa", localLibraryId: "local-a", folderName: "Nature", sharedLibraryId: "shared-a", sharedLibraries: catalog, permissionState: "prompt" }),
];

assert(states.map(({ state }) => state).join(",") === "L0,L1,L2,L3,L4,L5,L6,L7", "fixture exhausts L0-L7 in order");

for (const linkState of states) {
  const ordinary = describeMediaLibrarySurface({ linkState, surface: "ordinary" });
  const advanced = describeMediaLibrarySurface({ linkState, surface: "advanced" });
  assert(ordinary.showSelector === false, `${linkState.state} ordinary never shows the selector`);
  assert(!/Media Library/i.test(ordinary.statusText), `${linkState.state} ordinary status contains no Media Library vocabulary`);
  assert(advanced.showSelector === true, `${linkState.state} Advanced retains the identity surface`);
  assert(advanced.statusText === linkState.summary, `${linkState.state} Advanced retains the precise diagnostic`);
}

const l5Ordinary = describeMediaLibrarySurface({ linkState: states[5], surface: "ordinary" });
assert(l5Ordinary.showStatus && /saved setup/.test(l5Ordinary.statusText), "L5 ordinary retains customer-language status");
const l7Ordinary = describeMediaLibrarySurface({ linkState: states[7], surface: "ordinary" });
assert(l7Ordinary.showStatus && l7Ordinary.showRecoveryAction, "L7 ordinary retains status and recovery action");
assert(/Your setup is safe/.test(l7Ordinary.statusText), "L7 ordinary retains the safety reassurance");
assert(states.some((state) => /Media Library/.test(describeMediaLibrarySurface({ linkState: state, surface: "advanced" }).statusText)), "Advanced diagnostic text may name Media Library");

const linkSource = fs.readFileSync(new URL("../src/profile/link-state.js", import.meta.url), "utf8");
const mainSource = fs.readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
const profileStoreSource = fs.readFileSync(new URL("../src/profile/profile-store.js", import.meta.url), "utf8");
const surfaceStart = linkSource.indexOf("export function describeMediaLibrarySurface");
const surfaceEnd = linkSource.indexOf("function ordinaryPermissionStatus", surfaceStart);
const surfaceSource = linkSource.slice(surfaceStart, surfaceEnd);
for (const forbidden of ["peers", "v3Peers", "syncConnected", "v3Configured", "sharedLibraries", "listLibraries"]) {
  assert(!surfaceSource.includes(forbidden), `disclosure function is independent of ${forbidden}`);
}
const renderStart = mainSource.indexOf("function renderFolderLinkState");
const renderEnd = mainSource.indexOf("function populateFolderLinkPicker", renderStart);
const ordinaryRender = mainSource
  .slice(renderStart, mainSource.indexOf("const advancedSurface", renderStart))
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/.*$/gm, "");
for (const forbidden of ["peers", "v3Peers", "syncConnected", "v3Configured", "listLibraries"]) {
  assert(!ordinaryRender.includes(forbidden), `ordinary render decision is independent of ${forbidden}`);
}
assert(/setLibraryAssociation[\s\S]*?ensureLibraryId\(/.test(profileStoreSource), "setLibraryAssociation still reaches ensureLibraryId");
const recordLoaded = profileStoreSource.slice(profileStoreSource.indexOf("async recordLibraryLoaded"), profileStoreSource.indexOf("async ", profileStoreSource.indexOf("async recordLibraryLoaded") + 6));
assert(recordLoaded && !recordLoaded.includes("ensureLibraryId("), "recordLibraryLoaded still never mints identity");

console.log("PASS: North Star N1 Media Library disclosure matrix (L0-L7 × ordinary/advanced)");
