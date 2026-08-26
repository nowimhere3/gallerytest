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

assert(html.includes("Sync lets your devices use the same Libraries and Profiles. Your photos and videos stay where they are."),
  "Sync reassurance names Libraries and Profiles while excluding media");
assert(transportSource.includes('export const PROFILES_DIR_NAME = "profiles"')
  && transportSource.includes('export const ASSOCIATIONS_FILE_NAME = "associations.json"')
  && transportSource.includes('export const LIBRARIES_FILE_NAME = "libraries.json"'),
  "SyncV3 transport evidence is Profile/association/Library data");

assert(html.includes("Choose the Library this folder belongs to. Your photos and videos are not uploaded or moved."),
  "folder editor states the link purpose and media safety");

const share = mapLinkState({ sourceKind: "fsa", localLibraryId: "local-a", folderName: "Nature" });
assert(share.actionHelp.includes("another device, or plan to move it there"),
  "Share this Library explains when the action is useful");
assert(share.actionHelp.includes("link its copy to the same collection"),
  "Share this Library explains the cross-device consequence");
assert(share.actionHelp.includes("not uploaded or moved"), "Share this Library retains media reassurance");

const link = mapLinkState({
  sourceKind: "fsa", localLibraryId: "local-a", folderName: "Nature",
  sharedLibraries: [{ id: "library-a", name: "Nature" }],
});
assert(link.actionHelp.includes("Link this folder to the same Library"), "Link explains the action");
assert(link.actionHelp.includes("both folders are the same collection"), "Link explains what Browser Gallery learns");
assert(!/Favorites|Hidden items|Tags/.test(link.actionHelp), "Link does not claim to transfer Profile curation");
assert((html.match(/id="profile-folder-action-help"/g) || []).length === 1,
  "Share/Link explanation has one adjacent presentation surface");
assert(mainSource.includes("profileFolderActionHelp.textContent = linkUi.actionHelp")
  && mainSource.includes('profileFolderActionHelp.classList.toggle("hidden", !linkUi.actionHelp)'),
  "Share/Link explanation renders only when its pure state owner supplies copy");

const unlinkCopy = "Unlinking only disconnects this folder from the Library on this device. Your media, shared Library, Profile, Favorites, Hidden items and Tags are not deleted.";
assert(html.includes(unlinkCopy), "unlink reassurance names its local scope and preserved data");
assert(html.includes('id="profile-folder-unlink-btn"')
  && html.includes('aria-describedby="profile-folder-unlink-help"'),
  "explicit Unlink action is associated with its reassurance");
assert(mainSource.includes('profileFolderUnlinkHelp.classList.toggle("hidden", !canUnlink)'),
  "unlink reassurance appears only beside an available Unlink action");

assert(html.includes("Only the Profile remembered for this Library changes. Favorites, Hidden items and Tags stay in their own Profiles."),
  "Profile-for-Library reassurance preserves Profile curation");
assert(html.includes("This choice is shared with your other devices. Your active Profile stays on this device."),
  "Profile-for-Library reassurance separates shared choice from local Active Profile");

assert(mainSource.includes("Syncing stops on this device. Your local Browser Gallery information and the files already in the Sync Folder are kept."),
  "Sync disconnect confirmation states the proven local consequence");
assert(mainSource.includes('`Delete ${activeName}`'), "Delete action remains explicit about the target Profile");
assert(mainSource.includes("This removes its tags, favorites, and hidden state. Your media files are not affected. This cannot be undone."),
  "existing Profile-delete confirmation remains explicit and unchanged");

const claimant = mapLinkState({
  sourceKind: "fsa", localLibraryId: "local-b",
  sharedLibraries: [{ id: "library-a", name: "Nature" }],
  selectedLibraryId: "library-a", selectedClaimant: { id: "local-a", name: "Folder A" },
});
assert(claimant.tone === "danger", "real claimant refusal remains danger");
assert(claimant.summary === "Nature is already linked to Folder A on this device."
  && claimant.conflict === "Unlink Folder A first.", "claimant refusal copy remains prominent and unchanged");

const offer = buildAmbientProfileOfferView({
  pendingOffer: { localLibraryId: "local-a", libraryId: "library-a" },
  currentContext: { localLibraryId: "local-a", libraryId: "library-a" },
  libraryName: "Nature", targetName: "Hardcore", activeProfileName: "BEAST",
});
assert(offer.text === "“Nature” is now associated with “Hardcore”. Use Hardcore on this device too?",
  "Stage 09 offer body remains byte-for-byte unchanged");
assert(offer.yesLabel === "Use Hardcore" && offer.noLabel === "Keep BEAST" && offer.laterLabel === "Later",
  "Stage 09 offer action labels remain unchanged");

console.log(`safety reassurance: ${assertions} assertions passed`);
