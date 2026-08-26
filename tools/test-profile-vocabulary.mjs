import fs from "node:fs";
import { buildAmbientProfileOfferView } from "../src/profile/ambient-profile-action.js";
import { mapAssociationCopy } from "../src/profile/association-copy.js";
import { mapLinkState } from "../src/profile/link-state.js";

const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const mainSource = fs.readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
const executableMain = mainSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
let assertions = 0;

function assert(condition, label) {
  if (!condition) throw new Error(label);
  assertions += 1;
}

const renderedHtml = html.replace(/<!--[\s\S]*?-->/g, "");
for (const obsolete of ["Associated Profile", "Associate with Profile", "Associate Current Library", "Save Association"]) {
  assert(!renderedHtml.includes(obsolete), `rendered HTML retires ${JSON.stringify(obsolete)}`);
}
for (const obsolete of ["Could not save the association", "Associated the current folder", "no longer linked to a Profile"]) {
  assert(!executableMain.includes(obsolete), `runtime UI copy retires ${JSON.stringify(obsolete)}`);
}

assert(renderedHtml.includes("Profile for This Library"), "rail names the Library/Profile relationship plainly");
assert(renderedHtml.includes("Profiles keep your Favorites, Hidden items and Tags together."),
  "lead Profile explanation is short and concrete");
assert(renderedHtml.includes("Save Profile for this Library"), "editor save action identifies what it changes");

const unchosen = mapAssociationCopy({ sourceKind: "fsa", folderName: "Nature" });
assert(unchosen.associatedText === "No Profile", "unchosen Library uses the locked No Profile term");
assert(unchosen.productLine === "Nature — no Profile chosen yet", "unchosen Library does not use link vocabulary");
assert(unchosen.actionLabel === "Choose a Profile for this Library", "Library action uses Profile-for-Library vocabulary");
assert(mapAssociationCopy({
  sourceKind: "fsa", associatedProfileId: "missing", associatedProfileName: null,
}).actionLabel === "Choose a Profile for this Library", "missing-Profile recovery names the same relationship");

const remembered = mapAssociationCopy({
  sourceKind: "fsa", folderName: "Nature", associatedProfileId: "beast",
  associatedProfileName: "BEAST", activeProfileId: "beast",
});
assert(remembered.productLine === "Nature — remembered with BEAST", "remembered with is canonical status copy");
assert(remembered.actionLabel === "Change Profile for this Library", "change action identifies the relationship");

const linked = mapLinkState({
  sourceKind: "fsa", localLibraryId: "local-a", sharedLibraryId: "library-a",
  folderName: "Nature folder", sharedLibraries: [{ id: "library-a", name: "Nature" }],
});
assert(linked.summary === "Nature folder is your copy of Nature.", "Folder/Library status retains copy-of wording");
assert(linked.actionLabel === "Change link", "Folder/Library action retains link vocabulary");

const offer = buildAmbientProfileOfferView({
  pendingOffer: { localLibraryId: "local-a", libraryId: "library-a" },
  currentContext: { localLibraryId: "local-a", libraryId: "library-a" },
  libraryName: "Nature", targetName: "Hardcore", activeProfileName: "BEAST",
});
assert(offer.text === "“Nature” is now associated with “Hardcore”. Use Hardcore on this device too?",
  "Stage 09 verified offer body remains unchanged");
assert(offer.yesLabel === "Use Hardcore" && offer.noLabel === "Keep BEAST" && offer.laterLabel === "Later",
  "Stage 09 YES/NO/LATER labels remain unchanged");
assert(renderedHtml.includes("This Library changed Profiles")
  && renderedHtml.includes('id="ambient-profile-offer-yes"')
  && renderedHtml.includes('id="ambient-profile-offer-no"')
  && renderedHtml.includes('id="ambient-profile-offer-later"'),
  "Stage 09 offer markup and actions remain present");

assert(mainSource.includes('profileDeleteBtn.textContent = activeId && activeName ? `Delete ${activeName}` : "Delete Profile"'),
  "Delete action remains explicitly named for the active Profile");
assert((renderedHtml.match(/id="profile-create-btn"/g) || []).length === 1
  && (renderedHtml.match(/id="profile-delete-btn"/g) || []).length === 1,
  "create and delete controls remain singleton");

console.log(`Profile & Sync vocabulary: ${assertions} assertions passed`);
