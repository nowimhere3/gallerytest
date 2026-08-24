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
  state: "S0", productLine: "No folder loaded.", showAction: false, allowPicker: false,
});
verify("S1", { sourceKind: "fsa", folderName: "Library A" }, {
  state: "S1", productLine: "Library A — not linked to a Profile yet",
  actionLabel: "Associate Current Library", showAction: true, allowPicker: true,
});
verify("S2", {
  sourceKind: "fsa", folderName: "Library A", associatedProfileId: "beast",
  associatedProfileName: "BEAST", activeProfileId: "beast",
}, {
  state: "S2", productLine: "Library A — remembered with BEAST",
  actionLabel: "Change Association", showAction: true, allowPicker: true,
});
verify("S3", {
  sourceKind: "legacy", legacyHasDurableIdentity: true, folderName: "Library A",
  associatedProfileId: "hardcore", associatedProfileName: "Hardcore", activeProfileId: "beast",
}, {
  state: "S3", productLine: "Library A — remembered with Hardcore (not your active Profile)",
  actionLabel: "Change Association", showAction: true, allowPicker: true,
});
verify("S4", {
  sourceKind: "fsa", folderName: "Library A", associatedProfileId: "deleted", activeProfileId: "beast",
}, {
  state: "S4", productLine: "Library A — remembers a Profile that no longer exists",
  actionLabel: "Choose a Profile", showAction: true, allowPicker: true,
});
verify("S5 unassociated", { sourceKind: "legacy", folderName: "Selected files" }, {
  state: "S5", productLine: "Selected files — not linked to a Profile yet", showAction: false, allowPicker: false,
});
verify("S5 session", {
  sourceKind: "legacy", folderName: "Selected files", legacySessionAssociated: true, activeProfileName: "BEAST",
}, {
  state: "S5", productLine: "Selected files — remembered with BEAST", showAction: false, allowPicker: false,
});
verify("current Library without a writable local identity", {
  sourceKind: "fsa", folderName: "Library A", canWriteAssociation: false,
}, {
  state: "S1", showAction: false, allowPicker: false,
});

console.log(`association copy: ${assertions} assertions passed`);
