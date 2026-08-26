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
  state: "S0", tone: "muted", productLine: "No folder loaded.", showAction: false, allowPicker: false,
});
verify("S1", { sourceKind: "fsa", folderName: "Library A" }, {
  state: "S1", tone: "muted", associatedText: "No Profile", productLine: "Library A — no Profile chosen yet",
  actionLabel: "Choose a Profile for this Library", showAction: true, allowPicker: true,
});
verify("S2", {
  sourceKind: "fsa", folderName: "Library A", associatedProfileId: "beast",
  associatedProfileName: "BEAST", activeProfileId: "beast",
}, {
  state: "S2", tone: "success", productLine: "Library A — remembered with BEAST",
  actionLabel: "Change Profile for this Library", showAction: true, allowPicker: true,
});
verify("S3", {
  sourceKind: "legacy", legacyHasDurableIdentity: true, folderName: "Library A",
  associatedProfileId: "hardcore", associatedProfileName: "Hardcore", activeProfileId: "beast",
}, {
  state: "S3", tone: "active", productLine: "Library A — remembered with Hardcore (not your active Profile)",
  actionLabel: "Change Profile for this Library", showAction: true, allowPicker: true,
});
verify("S4", {
  sourceKind: "fsa", folderName: "Library A", associatedProfileId: "deleted", activeProfileId: "beast",
}, {
  state: "S4", tone: "warning", productLine: "Library A — remembers a Profile that no longer exists",
  actionLabel: "Choose a Profile for this Library", showAction: true, allowPicker: true,
});
verify("S5 unassociated", { sourceKind: "legacy", folderName: "Selected files" }, {
  state: "S5", tone: "muted", associatedText: "No Profile",
  productLine: "Selected files — no Profile chosen yet", showAction: false, allowPicker: false,
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
  "explicit No Profile/unassociated value is not warning");
assert(mapAssociationCopy({
  sourceKind: "fsa", folderName: "Library A", associatedProfileId: "missing", associatedProfileName: null,
}).tone === "warning", "missing remembered Profile is warning");
assert(mapAssociationCopy({
  sourceKind: "fsa", folderName: "Library A", associatedProfileId: "beast",
  associatedProfileName: "BEAST", activeProfileId: "beast",
}).tone === "success", "healthy remembered/Active match is success");

console.log(`association copy: ${assertions} assertions passed`);
