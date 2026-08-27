import { mapAssociationCopy } from "../src/profile/association-copy.js";

let assertions = 0;
function assert(condition, label) {
  if (!condition) throw new Error(label);
  assertions += 1;
}

function verify(name, input, expected) {
  const snapshot = structuredClone(input);
  const actual = mapAssociationCopy(input);
  for (const [key, value] of Object.entries(expected)) {
    assert(actual[key] === value, `${name}: ${key} expected ${JSON.stringify(value)}, got ${JSON.stringify(actual[key])}`);
  }
  assert(JSON.stringify(input) === JSON.stringify(snapshot), `${name}: input was not mutated`);
}

verify("S0", {}, {
  state: "S0", tone: "muted", productLine: "No Media Folder loaded.", showAction: false, allowPicker: false,
});
verify("S1", { sourceKind: "fsa", folderName: "Library A" }, {
  state: "S1", tone: "muted", associatedText: "None chosen yet", productLine: "Library A — no Curation chosen yet",
  actionLabel: "Choose a Curation for this Media Library", showAction: true, allowPicker: true,
});
verify("S2", {
  sourceKind: "fsa", folderName: "Library A", associatedProfileId: "beast",
  associatedProfileName: "BEAST", activeProfileId: "beast",
}, {
  state: "S2", tone: "success", productLine: "Library A — remembered with BEAST Curation",
  actionLabel: "Change Curation for this Media Library", showAction: true, allowPicker: true,
});
verify("S3", {
  sourceKind: "legacy", legacyHasDurableIdentity: true, folderName: "Library A",
  associatedProfileId: "hardcore", associatedProfileName: "Hardcore", activeProfileId: "beast",
}, {
  state: "S3", tone: "active", productLine: "Library A — remembered with Hardcore Curation (not used on this device)",
  actionLabel: "Change Curation for this Media Library", showAction: true, allowPicker: true,
});
verify("S4", {
  sourceKind: "fsa", folderName: "Library A", associatedProfileId: "deleted", activeProfileId: "beast",
}, {
  state: "S4", tone: "warning", productLine: "Library A — remembers a Curation that no longer exists",
  actionLabel: "Choose a Curation for this Media Library", showAction: true, allowPicker: true,
});
verify("S5 unassociated", { sourceKind: "legacy", folderName: "Selected files" }, {
  state: "S5", tone: "muted", associatedText: "None chosen yet",
  productLine: "Selected files — no Curation chosen yet", showAction: false, allowPicker: false,
});
verify("S5 session", {
  sourceKind: "legacy", folderName: "Selected files", legacySessionAssociated: true, activeProfileName: "BEAST",
}, {
  state: "S5", tone: "muted", productLine: "Selected files — remembered with BEAST", showAction: false, allowPicker: false,
});
verify("current Library without a writable local identity", {
  sourceKind: "fsa", folderName: "Library A", canWriteAssociation: false,
}, {
  state: "S1", tone: "muted", showAction: false, allowPicker: false,
});

const differentActive = mapAssociationCopy({
  sourceKind: "fsa", folderName: "Library A", associatedProfileId: "hardcore",
  associatedProfileName: "Hardcore", activeProfileId: "beast",
});
assert(differentActive.tone === "active" && differentActive.tone !== "warning",
  "S3 different Active Profile is informational, not warning");
assert(mapAssociationCopy({ sourceKind: "fsa", folderName: "Library A", associatedProfileId: null }).tone === "muted",
  "explicit none-chosen/unassociated value is not warning");
assert(mapAssociationCopy({
  sourceKind: "fsa", folderName: "Library A", associatedProfileId: "missing", associatedProfileName: null,
}).tone === "warning", "missing remembered Profile is warning");
assert(mapAssociationCopy({
  sourceKind: "fsa", folderName: "Library A", associatedProfileId: "beast",
  associatedProfileName: "BEAST", activeProfileId: "beast",
}).tone === "success", "healthy remembered/Active match is success");

// [SYNCV3 / STAGE-10 / FINAL-CLOSEOUT-POLISH]
// The rail card's locked scan path is concept -> current state -> action ->
// benefit. The pure mapper owns the last two so they cannot drift apart.
const BENEFIT = "Choose a Curation to remember the Favorites, Hidden items and Tags you want to use with this Media Library.";
for (const input of [
  { sourceKind: "fsa", folderName: "Library A" },
  { sourceKind: "fsa", folderName: "Library A", associatedProfileId: "gone" },
  { sourceKind: "fsa", folderName: "Library A", associatedProfileId: "p1", associatedProfileName: "BEAST", activeProfileId: "p1" },
  { sourceKind: "fsa", folderName: "Library A", associatedProfileId: "p1", associatedProfileName: "BEAST", activeProfileId: "p2" },
]) {
  const ui = mapAssociationCopy(input);
  assert(ui.showAction === true, `${ui.state} offers the action`);
  assert(ui.actionHelp === BENEFIT, `${ui.state} explains the benefit of pressing it`);
}
// No action offered means nothing to explain.
for (const input of [{}, { sourceKind: "legacy" }]) {
  const ui = mapAssociationCopy(input);
  assert(ui.showAction === false && ui.actionHelp === "", `${ui.state} explains nothing it is not offering`);
}
// "None chosen yet" states the STATE. "No Curation" read like the name of a
// thing the Media Library had been given.
assert(mapAssociationCopy({ sourceKind: "fsa", folderName: "Library A" }).associatedText === "None chosen yet",
  "the empty card reads as an unmade choice, not as a chosen nothing");
assert(!/No Curation/.test(mapAssociationCopy({ sourceKind: "fsa", folderName: "Library A" }).associatedText),
  "the retired value is gone from the card");

console.log(`association copy: ${assertions} assertions passed`);
