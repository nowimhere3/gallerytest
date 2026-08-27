import fs from "node:fs";
import { buildAmbientProfileOfferView } from "../src/profile/ambient-profile-action.js";

const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
let assertions = 0;
function assert(condition, label) { if (!condition) throw new Error(label); assertions += 1; }
function count(needle) { return html.split(needle).length - 1; }

assert(count('id="profile-sync-help"') === 1, "Curations & Sync Help exists exactly once");
const helpStart = html.indexOf('<details id="profile-sync-help"');
const helpEnd = html.indexOf("</details>", helpStart);
const help = html.slice(helpStart, helpEnd + "</details>".length);
assert(helpStart >= 0 && !html.slice(helpStart, html.indexOf(">", helpStart)).includes(" open"), "Help is collapsed by default");
assert(/^<details[\s\S]*?<summary>\? Help with Curations &amp; Sync<\/summary>/.test(help), "Help uses native details/summary");
assert(helpStart < html.indexOf('id="profile-folder-group"'), "Help precedes This Media Folder");
for (const concept of ["folder", "library", "profile", "active-profile", "profile-for-library", "sync"]) {
  assert(count(`data-help-concept="${concept}"`) === 1, `${concept} has one canonical definition`);
}
for (const heading of ["Media Folder", "Media Library", "Curation", "This Device Is Using", "Curation for This Media Library", "Sync"]) {
  assert(help.includes(`<h3>${heading}</h3>`), `${heading} is a Help concept`);
}
assert(help.includes("Choose a Media Folder on this device or a Google Drive Media Folder."),
  "Media Folder distinguishes local and Drive media sources");
assert(help.includes("Browser Gallery does not upload, move or copy what is inside it."),
  "Media Folder states the media-safety boundary");

// [SYNCV3 / STAGE-10 / MEDIA-LIBRARY-SELECTION]
// Three rounds of first-time-user testing failed on exactly this entry, so it
// is pinned question by question rather than as one string match.
const libStart = help.indexOf('data-help-concept="library"');
const libraryEntry = help.slice(libStart, help.indexOf("</section>", libStart));
assert(libraryEntry.includes("A Media Library is Browser Gallery's name for one collection of photos and videos."),
  "WHAT: the Media Library is a NAME, not another folder");
assert(libraryEntry.includes("across your devices, choose the same Media Library for each one"),
  "WHEN: the same collection through different Media Folders uses the same Media Library");
assert(libraryEntry.includes("which Favorites, Hidden items and Tags belong with it"),
  "WHY THE READER CARES: it is what keeps their organization with the right media");
assert(libraryEntry.includes("Different collections use different Media Libraries."),
  "the same-collection rule is taught in BOTH directions");
assert(libraryEntry.includes("Nothing is copied, moved, combined or uploaded."),
  "WHAT IT DOES NOT DO is stated explicitly");
assert(libraryEntry.includes("does not create or change a folder"),
  "the Media Library is not a filesystem operation");
assert(!/\b(link|linked|linking|unlink|shared)\b/i.test(libraryEntry),
  "the Media Library entry carries no retired link/shared vocabulary");
assert(!/\bmatching\b/i.test(libraryEntry), "the Media Library entry never says 'matching' without defining it");

// Curation teaches the familiar ACTIONS before it introduces the new noun.
const curStart = help.indexOf('data-help-concept="profile"');
const curationEntry = help.slice(curStart, help.indexOf("</section>", curStart));
assert(curationEntry.indexOf("mark Favorites, hide items and add Tags")
  < curationEntry.indexOf("is a Curation"), "Curation is taught action-first, noun-second");
assert(!curationEntry.includes("unique set"), "Curation drops the meaningless 'unique set'");
// A Curation is not tied to one collection: it may exist for different people,
// different purposes, or entirely different media.
assert(curationEntry.includes("Create different Curations for different people, purposes, or ways of organizing your media."),
  "multiple Curations are intentional and not limited to re-organizing one fixed collection");
assert(!/organize the same photos and videos/.test(curationEntry),
  "the narrower same-collection framing is retired");

assert(help.includes("The Curation this device is using right now."), "This Device Is Using is concrete");
assert(help.includes("Each of your devices can use a different Curation."), "device locality scales past two devices");
assert(help.includes("may switch to the Curation that Media Library remembers, or ask you first."), "Help explains Stage 09 consent");
assert(help.includes("The Curation Browser Gallery remembers for this Media Library."), "remembered Curation is defined");

// [SYNCV3 / STAGE-10 / DRIVE-ROLES]
const syncStart = help.indexOf('data-help-concept="sync"');
const syncEntry = help.slice(syncStart, help.indexOf("</section>", syncStart));
assert(syncEntry.includes("Connect each device you want to use to the same Google Drive Sync Folder"),
  "Sync scales to any number of devices");
assert(syncEntry.includes("stores Browser Gallery information only"), "the Sync Folder's role is explicit");
assert(syncEntry.includes("separate from a Google Drive Media Folder"),
  "the two Google Drive roles are distinguished inside Help");
assert(syncEntry.includes("does not contain your photos and videos"), "Sync excludes media files");
assert(!/\bProfiles?\b/.test(help), "Help has no customer-facing Profile terminology");
assert(!/\bShared (Library|Media Library)\b/.test(help), "Help never says Shared Library");

const offer = buildAmbientProfileOfferView({ pendingOffer: { localLibraryId: "local-a", libraryId: "library-a" }, currentContext: { localLibraryId: "local-a", libraryId: "library-a" }, libraryName: "Nature", targetName: "Hardcore", activeProfileName: "BEAST" });
assert(offer.text === "“Nature” now remembers the “Hardcore” Curation. Use Hardcore on this device too?", "Stage 09 uses Curation vocabulary");
assert(offer.yesLabel === "Use Hardcore" && offer.noLabel === "Keep BEAST" && offer.laterLabel === "Later", "Stage 09 action semantics are unchanged");

console.log(`Curations & Sync persistent Help: ${assertions} assertions passed`);
