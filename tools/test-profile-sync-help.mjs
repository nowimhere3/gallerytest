import fs from "node:fs";
import { buildAmbientProfileOfferView } from "../src/profile/ambient-profile-action.js";

const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
let assertions = 0;

function assert(condition, label) {
  if (!condition) throw new Error(label);
  assertions += 1;
}

function count(needle) {
  return html.split(needle).length - 1;
}

assert(count('id="profile-sync-help"') === 1, "Profile & Sync Help exists exactly once");
const helpStart = html.indexOf('<details id="profile-sync-help"');
const helpEnd = html.indexOf("</details>", helpStart);
const help = html.slice(helpStart, helpEnd + "</details>".length);
assert(helpStart >= 0 && !html.slice(helpStart, html.indexOf(">", helpStart)).includes(" open"),
  "Help is collapsed by default");
assert(/^<details[\s\S]*?<summary>\? Help with Profile &amp; Sync<\/summary>/.test(help),
  "Help uses a native details/summary entry point");
assert(helpStart < html.indexOf('id="profile-folder-group"'), "Help is discoverable before This Folder");

const expectedConcepts = ["folder", "library", "profile", "active-profile", "profile-for-library", "sync"];
for (const concept of expectedConcepts) {
  assert(count(`data-help-concept="${concept}"`) === 1, `${concept} has exactly one canonical Help definition`);
}

assert(help.includes("The folder on this device that contains your photos and videos. Each device uses its own local folder."),
  "Folder is concrete and device-local");
assert(help.includes("Have the same media collection on another device? Link both folders to the same Library."),
  "Library explains when to link cross-device folder copies");
assert(help.includes("These folders are the same collection."), "Library explains what linking means");
assert(help.includes("Then choose a Profile for that Library"), "Library explains the next Profile step");
assert(help.includes("A Profile is a unique set of Favorites, Hidden items and Tags."),
  "Profile is a unique curation set");
assert(help.includes("The Profile this device is using right now."), "Active Profile is device-local");
assert(help.includes("may switch to the Profile that Library remembers, or ask you first."),
  "Active Profile explains ordinary open and Stage 09 ask behavior");
assert(help.includes("If another device opens the same Library, Browser Gallery can ask if you want to use that Profile there too."),
  "Profile for This Library explains why it is remembered");
assert(help.includes("Sync lets your devices use the same Libraries and Profiles."), "Sync names what devices share and use");
assert(help.includes("Your photos and videos stay where they are."), "Sync Help excludes the media collection");
assert(!/associat/i.test(help), "Help does not reintroduce user-facing association vocabulary");

for (const heading of ["This Folder", "This Library", "Active Profile on This Device", "This Device", "Sync"]) {
  assert(html.includes(`>${heading}<`), `${heading} remains in the primary Profile & Sync flow`);
}
assert(count('id="profile-create-btn"') === 1 && count('id="profile-delete-btn"') === 1,
  "existing Profile controls remain singleton");

const offer = buildAmbientProfileOfferView({
  pendingOffer: { localLibraryId: "local-a", libraryId: "library-a" },
  currentContext: { localLibraryId: "local-a", libraryId: "library-a" },
  libraryName: "Nature", targetName: "Hardcore", activeProfileName: "BEAST",
});
assert(offer.text === "“Nature” is now associated with “Hardcore”. Use Hardcore on this device too?",
  "Stage 09 offer body remains unchanged");
assert(offer.yesLabel === "Use Hardcore" && offer.noLabel === "Keep BEAST" && offer.laterLabel === "Later",
  "Stage 09 offer actions remain unchanged");

console.log(`Profile & Sync persistent Help: ${assertions} assertions passed`);
