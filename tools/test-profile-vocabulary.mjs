import fs from "node:fs";
import { buildAmbientProfileOfferView } from "../src/profile/ambient-profile-action.js";
import { mapAssociationCopy } from "../src/profile/association-copy.js";
import { mapLinkState } from "../src/profile/link-state.js";

const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const mainSource = fs.readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
const renderedHtml = html.replace(/<!--[\s\S]*?-->/g, "");
const executableMain = mainSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
let assertions = 0;
function assert(condition, label) { if (!condition) throw new Error(label); assertions += 1; }

assert(!renderedHtml.includes("Profile &amp; Sync") && !renderedHtml.includes("Profile Sync"), "old section names are not rendered");
assert(renderedHtml.includes("Curations &amp; Sync"), "main section is Curations & Sync");
assert(renderedHtml.includes("Sync Your Curations"), "Advanced Settings is benefit-first");

// [SYNCV3 / STAGE-10 / SETTINGS-LABEL]
// Curations & Sync is a SECTION inside Settings, alongside Tags and Advanced
// Settings. Naming the whole destination after one of its sections hid the rest.
assert(renderedHtml.includes(">⚙ Settings</button>"), "the utility workspace tab is still ⚙ Settings");
assert(!/>⚙ (Curations?|Profile)</.test(renderedHtml), "the Settings tab is not renamed after one of its sections");
assert(renderedHtml.includes('id="workspace-tab-settings"'), "the Settings tab keeps its id");
for (const obsolete of ["Associated Profile", "Active Profile", "No Profile", "Create Profile", "Delete Profile", "Import Profile", "Export Profile", "Profile for This Library"]) {
  assert(!renderedHtml.includes(obsolete), `rendered HTML retires ${JSON.stringify(obsolete)}`);
}
assert(!/\bProfiles?\b/.test(renderedHtml), "rendered HTML has no customer-facing Profile noun");
for (const obsolete of ["Could not switch Profiles", "This Library now has No Profile", "Could not save the Profile", "Profile changed, but", "Profile: ${"]) {
  assert(!executableMain.includes(obsolete), `runtime customer copy retires ${JSON.stringify(obsolete)}`);
}
assert(mainSource.includes("ProfileStore") && mainSource.includes("activeProfileId") && mainSource.includes("profileId"), "internal Profile architecture remains intact");

for (const phrase of ["This Media", "Curation for This Folder", "This Device Is Using", "— No Curation —", "Create Curation", "Import Curation", "Delete Curation"]) {
  assert(renderedHtml.includes(phrase) || executableMain.includes(phrase), `${phrase} is customer-facing`);
}
assert(renderedHtml.includes("Export Curation (.json)") && mainSource.includes("Export ${activeName} Curation (.json)"), "Export action names the current Curation");
assert(renderedHtml.includes('id="profile-media-source"') && renderedHtml.includes("No media loaded."),
  "Settings has one source-neutral current-media line");
assert(mainSource.includes("let activeCassetteRecord = null;"), "controller tracks active remembered Floppy provenance");
assert(mainSource.includes('rememberedSourceId: activeCassetteRecord?.id ? `cassette:${activeCassetteRecord.id}` : null'),
  "remembered Floppy evidence is namespaced before entering the mapper");
assert(mainSource.includes('record, sourceKind: "cassette"') && mainSource.includes('record, sourceKind: "cassette-folder"'),
  "remembered Floppy reopen paths retain record and exact source kind");
assert(mainSource.includes('name: floppy.name, sourceKind: "cassette"')
  && mainSource.includes('name: rootName, sourceKind: "cassette-folder"'),
  "one-shot Floppy paths retain exact source kind without a record");
assert(mainSource.split("activeCassetteRecord = null;").length - 1 >= 4,
  "local, FSA, clear, and declaration paths prevent stale cassette provenance");
assert(mainSource.includes('currentSourceKind === "cassette" || currentSourceKind === "cassette-folder"')
  && mainSource.includes('? "none"'), "Floppy sources are adapted to none at the folder-link boundary");

const unchosen = mapAssociationCopy({ sourceKind: "fsa", folderName: "Nature" });
assert(unchosen.associatedText === "None chosen yet" && unchosen.productLine === "Nature — no Curation chosen yet",
  "an unchosen Media Library states an unmade choice, in Curation language");
assert(unchosen.actionLabel === "Choose a Curation for this media", "choose action names the customer relationship");
const remembered = mapAssociationCopy({ sourceKind: "fsa", folderName: "Nature", associatedProfileId: "beast", associatedProfileName: "BEAST", activeProfileId: "beast" });
assert(remembered.productLine === "Nature — remembered with BEAST Curation", "remembered status identifies Curation");
assert(remembered.actionLabel === "Change Curation for this media", "change action names the customer relationship");

const linked = mapLinkState({ sourceKind: "fsa", localLibraryId: "local-a", sharedLibraryId: "library-a", folderName: "Nature folder", sharedLibraries: [{ id: "library-a", name: "Nature" }] });
assert(linked.summary === "Nature folder uses the Nature Media Library.",
  "the Media Folder's Media Library reads as a property, not an operation");
assert(linked.actionLabel === "" && linked.allowPicker === true,
  "the selector is the change affordance; no verb is needed in steady state");

const offer = buildAmbientProfileOfferView({ pendingOffer: { localLibraryId: "local-a", libraryId: "library-a" }, currentContext: { localLibraryId: "local-a", libraryId: "library-a" }, libraryName: "Nature", targetName: "Hardcore", activeProfileName: "BEAST" });
assert(offer.text === "“Nature” now remembers the “Hardcore” Curation. Use Hardcore on this device too?", "Stage 09 visible copy migrates only its noun model");
assert(offer.yesLabel === "Use Hardcore" && offer.noLabel === "Keep BEAST" && offer.laterLabel === "Later", "Stage 09 YES/NO/LATER semantics remain unchanged");
assert(renderedHtml.includes('id="ambient-profile-offer-yes"') && renderedHtml.includes('id="ambient-profile-offer-no"') && renderedHtml.includes('id="ambient-profile-offer-later"'), "Stage 09 action markup remains present");

// [SYNCV3 / STAGE-10 / FINAL-UX-POLISH]
// The Curations & Sync surface reached its vocabulary one string at a time, so
// the risk is a straggler that reads "folder"/"Library" beside a neighbour that
// already reads "Media Folder"/"Media Library". These are the places where the
// old noun survived a pass, pinned so a later edit cannot quietly restore it.
for (const straggler of [
  "another folder\"",
  "Unlink this folder first",
  "already linked to the folder",
  "Could not unlink this folder",
  "This folder is remembered with",
  "you pick the same folder here",
  "\"Loaded folder\"",
  "No V3 folder chosen yet",
  'line = "Status: Checking folder access…',
]) {
  assert(!executableMain.includes(straggler), `Curations & Sync copy retires ${JSON.stringify(straggler)}`);
}
for (const phrase of [
  "another Media Folder",
  "This Media Folder is remembered with",
  // Stage 10 final synthesis retired "unlink" from visible copy; these are the
  // strings that replaced the two runtime messages this list used to pin.
  "Could not remove this Media Folder from its Media Library",
  "Remove this Media Folder first",
  "No Sync Folder chosen yet",
  "Checking Sync Folder access",
]) {
  assert(executableMain.includes(phrase), `${phrase} is customer-facing`);
}

// The fallback used when a load has no readable name is itself customer-facing:
// it is substituted straight into the association and link sentences.
assert(mapAssociationCopy({ sourceKind: "fsa" }).productLine === "Loaded Media Folder — no Curation chosen yet",
  "the unnamed-load fallback speaks the same noun as a named one");
assert(mapLinkState({ sourceKind: "fsa", localLibraryId: "local-a", durable: true }).summary
  === "Loaded Media Folder is ready for its first Media Library.",
  "the Media Folder summary's unnamed-load fallback matches");

// [SYNCV3 / STAGE-10 / MEDIA-LIBRARY-SELECTION]
// "Link" is retired from CUSTOMER-FACING copy only. Internal Stage 08 code —
// link-state.js, linkLocalLibraryToShared(), the profile-folder-link-* ids and
// their comments — is accurate about what it does and stays exactly as it is.
const visibleText = renderedHtml
  .replace(/<(script|style)[\s\S]*?<\/\1>/g, " ")
  .replace(/<[^>]+>/g, " ")
  .replace(/&amp;/g, "&")
  .replace(/\s+/g, " ");

// [UNIFIED MEDIA INTAKE / STAGE D] The rail asks only for selection shape and
// intent. Backend nouns may still appear after loading in Saved Libraries.
for (const action of ["Open Files", "Open Folder", "Remember File", "Remember Folder"]) {
  assert(visibleText.includes(action), `${action} is a visible intake action`);
}
for (const retired of ["Open Floppy Disk", "Remember Floppy Disk", "Open Floppy Folder",
  "Remember Floppy Folder", "Remember This Folder", "Choose Folder (FSA)",
  "Open Remote Session", "Add Remote Cassette", "Legacy Picker"]) {
  assert(!visibleText.includes(retired), `${retired} is not a visible intake action`);
}
assert((visibleText.match(/Open Files/g) || []).length === 1, "Open Files appears once");
assert((visibleText.match(/Open Folder/g) || []).length === 1, "Open Folder appears once");
assert((visibleText.match(/Remember File/g) || []).length === 1, "Remember File appears once");
assert((visibleText.match(/Remember Folder/g) || []).length === 1, "Remember Folder appears once");
assert(/id="file-input"[^>]*accept="[^"]*image\/\*[^"]*video\/\*[^"]*\.txt[^"]*"/.test(renderedHtml),
  "Open Files picker accepts ordinary media and .txt files");
assert(!renderedHtml.includes('id="remote-session-input"'), "source-specific Floppy input is removed");
assert(mainSource.includes('cassetteAddBtn.classList.remove("hidden");') && !mainSource.includes('cassetteAddBtn.classList.add("hidden");'),
  "Remember File remains visible when file-handle persistence is unavailable");
assert(mainSource.includes('routeOpenSelection(files, { shape: "files" })'), "Open Files uses unified routing");
assert(mainSource.includes('routeOpenSelection(files, { shape: "folder", rootName: topFolderName })'),
  "Open Folder uses unified routing");
assert(mainSource.includes("const files = Array.from(event.target.files || []);"),
  "picker FileLists are snapshotted before asynchronous routing");
assert(mainSource.includes('const selectionKind = classifySelection(evidence);'),
  "open and remember handlers reuse unified classification");
assert(mainSource.includes("Browser Gallery can remember folders and Floppy Disks. Choose a folder to remember this media."),
  "Remember File has truthful ordinary-media copy");
for (const savedKind of ["Local Folder", "Floppy Disk", "Floppy Folder"]) {
  assert(mainSource.includes(savedKind), `Saved Libraries still renders ${savedKind}`);
}
const ordinarySettings = renderedHtml.slice(
  renderedHtml.indexOf('<details class="profile-section"'),
  renderedHtml.indexOf('<details class="advanced-settings-section"'),
);
assert(!/Media Librar/i.test(ordinarySettings), "ordinary Settings contains no Media Library vocabulary");
for (const retired of ["Shared Library", "Shared Media Library", "Link to a Media Library",
  "Link to a Library", "Link both", "Link this", "Linked Library", "Linked Media Library",
  "Unlink", "Unlinking", "Share this Media Library", "Share as a new"]) {
  assert(!visibleText.includes(retired), `visible copy retires ${JSON.stringify(retired)}`);
}
assert(!/\b(linked|linking|unlinked|unlinking)\b/i.test(visibleText),
  "no visible copy describes the Media Folder relationship as linking");

// Internal architecture is deliberately untouched by that retirement.
assert(mainSource.includes("linkLocalLibraryToShared") && mainSource.includes("unlinkLocalLibraryFromShared"),
  "the Stage 08 storage API keeps its accurate internal names");
assert(mainSource.includes("mapLinkState") && renderedHtml.includes('id="profile-folder-link-select"'),
  "internal link-state module and element ids are retained");

// The selection model's own visible vocabulary.
for (const phrase of ["Media Library", "Choose a Media Library", "Create New Media Library",
  "Use This Media Library", "Remove from This Media Library", "Media Library name"]) {
  assert(visibleText.includes(phrase) || executableMain.includes(phrase),
    `${phrase} is customer-facing`);
}

// Multi-device copy rule across every visible string in the document.
assert(!/\bboth devices\b/i.test(visibleText) && !/\bboth folders\b/i.test(visibleText)
  && !/\bboth Media Folders\b/i.test(visibleText),
  "visible copy avoids pairwise device language");

console.log(`customer Curation vocabulary: ${assertions} assertions passed`);
