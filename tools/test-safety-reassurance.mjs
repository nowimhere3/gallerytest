import fs from "node:fs";
import { buildAmbientProfileOfferView } from "../src/profile/ambient-profile-action.js";
import { mapLinkState } from "../src/profile/link-state.js";

const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const mainSource = fs.readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
const transportSource = fs.readFileSync(new URL("../src/profile/sync-v3-transport.js", import.meta.url), "utf8");
let assertions = 0;

function assert(condition, label) {
  if (!condition) throw new Error(label);
  assertions += 1;
}

// [SYNCV3 / STAGE-10 / DRIVE-ROLES]
// The two Google Drive roles are now STRUCTURAL — a role label beside each
// chooser — rather than a sentence a reader has to find and parse.
assert(html.includes('<p class="role-descriptor">Google Drive Sync Folder</p>'),
  "the Sync Folder chooser carries its role as a label");
assert(html.includes('<p class="role-descriptor-detail">Browser Gallery information only · No photos or videos</p>'),
  "the Sync Folder's role says what it does NOT hold");
assert(html.includes('<p class="role-descriptor">Your photos and videos</p>'),
  "the Media Folders chooser carries its own role descriptor");
const railRole = html.indexOf('<p class="role-descriptor">Your photos and videos</p>');
const syncRole = html.indexOf('<p class="role-descriptor">Google Drive Sync Folder</p>');
assert(railRole >= 0 && syncRole > railRole,
  "each role descriptor stays with the chooser it belongs to — they were not merged onto one screen");
assert(mainSource.includes("Connect each device you want to use to the same Google Drive Sync Folder."),
  "Sync copy scales to any number of devices");
assert(transportSource.includes('export const PROFILES_DIR_NAME = "profiles"')
  && transportSource.includes('export const ASSOCIATIONS_FILE_NAME = "associations.json"')
  && transportSource.includes('export const LIBRARIES_FILE_NAME = "libraries.json"'),
  "SyncV3 transport evidence is Profile/association/Library data");

// [SYNCV3 / STAGE-10 / MEDIA-LIBRARY-SELECTION]
// The same-collection rule is the safety rule for this control: putting two
// different collections in one Media Library is the mistake worth preventing.
assert(mainSource.includes("Use the same Media Library only for Media Folders that show the same collection of photos and videos. Different collections use different Media Libraries."),
  "the selector teaches the same-collection rule in both directions plus media safety");

const durable = mapLinkState({ sourceKind: "fsa", localLibraryId: "local-a", folderName: "Nature" });
const withCatalog = mapLinkState({
  sourceKind: "fsa", localLibraryId: "local-a", folderName: "Nature",
  sharedLibraries: [{ id: "library-a", name: "Nature" }],
});
assert(durable.actionHelp === withCatalog.actionHelp,
  "selection is one idea, so it gets one explanation regardless of catalog size");
assert(durable.actionHelp.includes("Which collection of photos and videos this Media Folder represents"),
  "the selector explains what is being chosen");
assert(durable.actionHelp.includes("Choose the same Media Library on each device where you open that collection"),
  "the selector explains when to reuse one, scaled past two devices");
assert((html.match(/id="profile-folder-action-help"/g) || []).length === 1,
  "the selector explanation has one adjacent presentation surface");
assert(mainSource.includes("profileFolderActionHelp.textContent = linkUi.actionHelp")
  && mainSource.includes("profileMediaLibraryContextHelp")
  && mainSource.includes("renderContextualHelp"),
  "the pure state owner supplies copy to the selector's contextual surface");

// Creation must not read as a folder rename or an import.
assert(html.includes("This name is only used inside Browser Gallery. Your Media Folder keeps its own name and stays where it is. Nothing is copied or uploaded."),
  "creating a Media Library reassures that the Media Folder is untouched");

const removeCopy = "Removing only clears which Media Library this Media Folder represents on this device. Your photos, videos, Media Library, Curation, Favorites, Hidden items and Tags are not deleted.";
assert(html.includes(removeCopy), "removal reassurance names its local scope and preserved data");
assert(html.includes('id="profile-folder-unlink-btn"')
  && html.includes('aria-describedby="profile-folder-unlink-help"'),
  "the explicit removal action is associated with its reassurance");
assert(/id="profile-folder-unlink-btn"[^>]*>Remove from This Media Library</.test(html),
  "the removal action reads as removal, not as unlinking");
assert(mainSource.includes('profileFolderUnlinkHelp.classList.toggle("hidden", !canUnlink)'),
  "removal reassurance appears only beside an available removal action");

// The one moment a reader most needs to hear that their files are untouched.
assert(mainSource.includes("`Now using the ${savedName} Media Library. Your files were not changed or moved.`"),
  "choosing a Media Library reassures through the status line this group already owns");
assert(mainSource.includes("profileFolderLinkResult.textContent = \"This Media Folder no longer uses a Media Library. Your files were not changed or moved.\""),
  "removing reassures the same way");

assert(html.includes("Only the Curation remembered for this folder changes. Favorites, Hidden items and Tags stay in their own Curations."),
  "folder Curation reassurance preserves other Curations without exposing plumbing");
assert(html.includes("This choice is shared with your other devices. The Curation this device is using does not change."),
  "remembered Curation stays separate from the local device choice");

assert(mainSource.includes("Syncing stops on this device. Your local Browser Gallery information and the files already in the Sync Folder are kept."),
  "Sync disconnect confirmation states the proven local consequence");
assert(mainSource.includes('`Delete ${activeName} Curation`'), "Delete action explicitly names the target Curation");
assert(mainSource.includes("This removes its Tags, Favorites, and Hidden items. Your photos and videos are not affected. This cannot be undone."),
  "Curation-delete confirmation is explicit about preserved media");

const claimant = mapLinkState({
  sourceKind: "fsa", localLibraryId: "local-b",
  sharedLibraries: [{ id: "library-a", name: "Nature" }],
  selectedLibraryId: "library-a", selectedClaimant: { id: "local-a", name: "Folder A" },
});
assert(claimant.tone === "danger", "real claimant refusal remains danger");
assert(claimant.summary === "Nature already represents Folder A on this device."
  && claimant.conflict === "Remove Folder A from that Media Library first.",
  "claimant refusal stays prominent; only its verb moved off 'unlink'");
assert(claimant.saveEnabled === false, "the claimant refusal still blocks the write");

const offer = buildAmbientProfileOfferView({
  pendingOffer: { localLibraryId: "local-a", libraryId: "library-a" },
  currentContext: { localLibraryId: "local-a", libraryId: "library-a" },
  libraryName: "Nature", targetName: "Hardcore", activeProfileName: "BEAST",
});
assert(offer.text === "“Nature” now remembers the “Hardcore” Curation. Use Hardcore on this device too?",
  "Stage 09 offer changes vocabulary only");
assert(offer.yesLabel === "Use Hardcore" && offer.noLabel === "Keep BEAST" && offer.laterLabel === "Later",
  "Stage 09 offer action labels remain unchanged");

console.log(`safety reassurance: ${assertions} assertions passed`);
