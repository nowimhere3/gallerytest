import fs from "node:fs";

const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
let assertions = 0;
function assert(condition, label) { if (!condition) throw new Error(label); assertions += 1; }
function count(needle) { return html.split(needle).length - 1; }

const folder = html.indexOf('id="profile-folder-group"');
const active = html.indexOf('id="profile-active-group"');
const device = html.indexOf('id="profile-device-group"');
const sync = html.indexOf('id="profile-sync-group"');
assert(folder >= 0 && folder < active, "the combined media area precedes This Device Is Using");
assert(active < device && device < sync, "device Curation, device identity, and Sync retain order");
assert(html.slice(folder, active).includes('id="ambient-profile-offer"'), "Stage 09 offer remains inside the combined media area");
assert(html.slice(active, device).includes('id="profile-select"'), "Curation selector remains in This Device Is Using");
assert(count('id="profile-create-input"') === 1 && count('id="profile-create-btn"') === 1, "Create Curation controls remain singleton");
assert(count('id="profile-delete-btn"') === 1, "Delete Curation remains singleton");
const importExport = html.indexOf('<summary>Import / Export</summary>');
const deleteDisclosure = html.indexOf('<summary>Delete Curation</summary>');
assert(sync < importExport && importExport < deleteDisclosure, "secondary administration follows Sync");
assert(/<details class="profile-import-export-section profile-delete-section">[\s\S]*?<summary>Delete Curation<\/summary>[\s\S]*?id="profile-delete-btn"[\s\S]*?<\/details>/.test(html), "Delete Curation stays in a native collapsed disclosure");

console.log(`Curations & Sync narrative hierarchy: ${assertions} assertions passed`);
