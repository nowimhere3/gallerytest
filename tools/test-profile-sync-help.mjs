import fs from "node:fs";
import { buildAmbientProfileOfferView } from "../src/profile/ambient-profile-action.js";

const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const main = fs.readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
let assertions = 0;
function assert(condition, label) { if (!condition) throw new Error(label); assertions += 1; }
function count(needle) { return html.split(needle).length - 1; }

assert(count('id="profile-sync-help-btn"') === 1, "persistent ? Help control exists exactly once");
assert(/<button id="profile-sync-help-btn"[^>]*>\? Help<\/button>/.test(html), "Help entry is a compact native button");
assert(!html.includes('<details id="profile-sync-help"'), "old Help disclosure no longer occupies Settings");
assert(!html.includes('id="profile-sync-help-dialog"'), "full glossary dialog is no longer a Help destination");
assert(!html.includes("data-help-concept="), "the complete glossary is not rendered to the customer");
assert(!html.includes("Replay Introduction"), "Help itself owns the replay entry");
assert(main.includes('dispatchProfileSyncIntroduction({ type: "replay" });'), "Help invokes the existing replay flow");
assert(main.includes("Choose a Media Folder on this device or a Google Drive Media Folder."),
  "Media Folder distinguishes local and Drive media sources");
assert(main.includes("Browser Gallery does not upload, move or copy what is inside it."),
  "Media Folder states the media-safety boundary");

// [SYNCV3 / STAGE-10 / MEDIA-LIBRARY-SELECTION]
// Three rounds of first-time-user testing failed on exactly this entry, so it
// is pinned question by question rather than as one string match.
const glossaryStart = main.indexOf("const PROFILE_SYNC_BACKGROUND_GLOSSARY");
const glossaryEnd = main.indexOf("function glossaryExcerpt", glossaryStart);
const help = main.slice(glossaryStart, glossaryEnd);
const libStart = help.indexOf("mediaLibrary:");
const libraryEntry = help.slice(libStart, help.indexOf("curation:", libStart));
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
const curStart = help.indexOf("curation:");
const curationEntry = help.slice(curStart, help.indexOf("activeCuration:", curStart));
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
const syncStart = help.indexOf("sync:");
const syncEntry = help.slice(syncStart);
assert(syncEntry.includes("Connect each device you want to use to the same Google Drive Sync Folder"),
  "Sync scales to any number of devices");
assert(syncEntry.includes("stores Browser Gallery information only"), "the Sync Folder's role is explicit");
assert(syncEntry.includes("separate from a Google Drive Media Folder"),
  "the two Google Drive roles are distinguished inside Help");
assert(syncEntry.includes("does not contain your photos and videos"), "Sync excludes media files");
assert(!/\bProfiles?\b/.test(help), "Help has no customer-facing Profile terminology");
assert(!/\bShared (Library|Media Library)\b/.test(help), "Help never says Shared Library");
assert(main.includes('glossaryExcerpt("mediaFolder", 1)') && main.includes('glossaryExcerpt("mediaLibrary", 2)')
  && main.includes('glossaryExcerpt("activeCuration", 2)') && main.includes('glossaryExcerpt("sync", 2)'),
  "customer UI extracts only concept-local Help from the background glossary");

const offer = buildAmbientProfileOfferView({ pendingOffer: { localLibraryId: "local-a", libraryId: "library-a" }, currentContext: { localLibraryId: "local-a", libraryId: "library-a" }, libraryName: "Nature", targetName: "Hardcore", activeProfileName: "BEAST" });
assert(offer.text === "“Nature” now remembers the “Hardcore” Curation. Use Hardcore on this device too?", "Stage 09 uses Curation vocabulary");
assert(offer.yesLabel === "Use Hardcore" && offer.noLabel === "Keep BEAST" && offer.laterLabel === "Later", "Stage 09 action semantics are unchanged");

console.log(`Curations & Sync persistent Help: ${assertions} assertions passed`);
