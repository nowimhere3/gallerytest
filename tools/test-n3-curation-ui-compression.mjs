#!/usr/bin/env node

import fs from "node:fs";
import { mapAssociationCopy, shouldShowActiveCurationChoice } from "../src/profile/association-copy.js";

const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const main = fs.readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
const northStar = fs.readFileSync(new URL("../Reports and Docs/NORTH-STAR.md", import.meta.url), "utf8");

let assertions = 0;
function assert(condition, message) {
  assertions += 1;
  if (!condition) throw new Error(message);
}

const aligned = mapAssociationCopy({
  sourceKind: "fsa",
  associatedProfileId: "BBG4",
  associatedProfileName: "BBG4",
  activeProfileId: "BBG4",
  activeProfileName: "BBG4",
});
const divergent = mapAssociationCopy({
  sourceKind: "fsa",
  associatedProfileId: "BBG4",
  associatedProfileName: "BBG4",
  activeProfileId: "BEAST",
  activeProfileName: "BEAST",
});

assert(aligned.state === "S2" && !shouldShowActiveCurationChoice(aligned),
  "aligned remembered and active Curations collapse to one presentation");
assert(divergent.state === "S3" && shouldShowActiveCurationChoice(divergent),
  "real divergence surfaces the local Active Curation choice");
for (const state of ["S0", "S1", "S4", "S5"]) {
  assert(shouldShowActiveCurationChoice({ state }), `${state} retains the local choice while Curation state is unresolved`);
}

assert(main.includes('profileActiveGroup.classList.toggle("hidden", !shouldShowActiveCurationChoice(associationUi))'),
  "ordinary presentation is driven by the pure association-state decision");
assert((html.match(/id="profile-select"/g) || []).length === 1,
  "the underlying Active Curation selector remains a singleton");
assert(main.includes("profile.switchProfile(targetId)"),
  "local Active Curation switching semantics remain wired");

const folderGroup = html.slice(html.indexOf('id="profile-folder-group"'), html.indexOf('id="profile-active-group"'));
const activeGroup = html.slice(html.indexOf('id="profile-active-group"'), html.indexOf('id="profile-device-group"'));
assert(folderGroup.includes('<h3 class="profile-group-heading">Curation</h3>'),
  "ordinary Settings names one Curation concept");
assert(folderGroup.includes('id="profile-associate-btn"') && folderGroup.includes('id="profile-create-btn"'),
  "change and create capabilities live together in the ordinary Curation area");
assert(!activeGroup.includes('id="profile-create-btn"') && activeGroup.includes('id="profile-select"'),
  "the conditional divergence surface contains only the distinct local choice");
assert(html.includes('<summary>Advanced Settings</summary>'),
  "the Advanced diagnostic and plumbing escape hatch remains present");

assert(northStar.includes("do not show two customer-facing")
  && northStar.includes("A second representation appears only while a real"),
  "the North Star records decision-needed presentation as the governing rule");

console.log(`N3-2 Curation UI compression: ${assertions} assertions passed`);
