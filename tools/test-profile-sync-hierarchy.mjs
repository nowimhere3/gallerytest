import fs from "node:fs";

const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
let assertions = 0;

function assert(condition, label) {
  if (!condition) throw new Error(label);
  assertions += 1;
}

function count(needle) {
  return html.split(needle).length - 1;
}

const folder = html.indexOf('id="profile-folder-group"');
const library = html.indexOf('id="profile-library-group"');
const active = html.indexOf('id="profile-active-group"');
const device = html.indexOf('id="profile-device-group"');
const sync = html.indexOf('id="profile-sync-group"');

assert(folder >= 0 && folder < library, "This Folder precedes This Library");
assert(library < active, "This Library precedes Active Profile on This Device");
assert(active < device, "Active Profile on This Device precedes This Device");
assert(device < sync, "This Device precedes Sync");

const libraryEnd = html.indexOf('id="profile-active-group"', library);
const libraryMarkup = html.slice(library, libraryEnd);
assert(libraryMarkup.includes('id="ambient-profile-offer"'),
  "the Stage 09 offer remains inside This Library");

const activeEnd = html.indexOf('id="profile-device-group"', active);
const activeMarkup = html.slice(active, activeEnd);
assert(activeMarkup.includes('id="profile-select"'), "the Profile selector remains in Active Profile");
assert(activeMarkup.includes('id="profile-create-input"') && activeMarkup.includes('id="profile-create-btn"'),
  "Profile creation is subordinate to the Active Profile group");

assert(count('id="profile-create-input"') === 1, "Create Profile input exists exactly once");
assert(count('id="profile-create-btn"') === 1, "Create Profile button exists exactly once");
assert(count('id="profile-delete-btn"') === 1, "Delete Profile exists exactly once");

const importExport = html.indexOf('<summary>Import / Export</summary>');
const deleteDisclosure = html.indexOf('<summary>Delete Profile</summary>');
assert(sync < importExport && importExport < deleteDisclosure,
  "secondary Import/Export and Delete disclosures follow Sync");
assert(/<details class="profile-import-export-section profile-delete-section">[\s\S]*?<summary>Delete Profile<\/summary>[\s\S]*?id="profile-delete-btn"[\s\S]*?<\/details>/.test(html),
  "Delete Profile is in a native collapsed disclosure");

console.log(`Profile & Sync narrative hierarchy: ${assertions} assertions passed`);
