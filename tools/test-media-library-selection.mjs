// [SYNCV3 / STAGE-10 / MEDIA-LIBRARY-SELECTION]
// The Media Folder -> Media Library seam was the weakest point in three rounds
// of independent first-time-user testing. This suite pins the SELECTION model
// that replaced it — the presentation, the create/choose/remove paths, the
// Sync prerequisite that the empty selector has to be honest about — while
// proving that the Stage 08 semantics underneath are untouched.
import fs from "node:fs";
import { installFakeIndexedDB, createVirtualDirectory } from "./lib/browser-test-env.mjs";
import { mapLinkState } from "../src/profile/link-state.js";

const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const main = fs.readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
const css = fs.readFileSync(new URL("../styles.css", import.meta.url), "utf8");

let assertions = 0;
function assert(condition, label) {
  if (!condition) throw new Error(label);
  assertions += 1;
}
function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

const groupStart = html.indexOf('class="advanced-media-library-section"');
const groupEnd = html.indexOf('class="advanced-playback-section"');
const group = html.slice(groupStart, groupEnd);
assert(groupStart >= 0 && groupEnd > groupStart, "Media Library administration is contained in Advanced");

// =========================================================================
// 1. THE SELECTOR IS THE CONTROL — no verb in steady state
// =========================================================================

assert(count(html, 'id="profile-folder-link-select"') === 1, "the Media Library selector exists exactly once");
assert(/<label for="profile-folder-link-select">Media Library<\/label>/.test(group),
  "the selector is labelled with the concept alone — it reads as a property of the Media Folder");
assert(!/aria-expanded/.test(group), "the selector row is no longer a disclosure someone must open first");
assert(!/aria-controls="profile-folder-link-row"/.test(group), "nothing claims to control the row's visibility");

// The one button left in this group has one real job.
const btn = html.slice(html.indexOf('id="profile-folder-link-btn"'));
assert(btn.slice(0, 300).includes(">Reconnect Media Folder<"),
  "the remaining button is the genuine L7 reconnect action, not a Link/Change toggle");
assert(!group.includes('id="profile-folder-link-btn"'), "L7 recovery stays ordinary rather than moving into identity diagnostics");
assert(main.includes("if (linkUi.reconnectNeeded) resumeLibrary(activeLibraryRecord);"),
  "that button does exactly one thing");
assert(!main.includes("openFolderLinkEditor"), "the open/close editor toggle is gone");

// Row visibility now follows the pure model rather than a click.
assert(main.includes("const showSelector = Boolean(advancedSurface.showSelector);")
  && main.includes('profileFolderLinkRow.classList.toggle("hidden", !showSelector);'),
  "the Advanced selector is shown by the disclosure model, not by interaction");

// Save/Cancel are consequences of changing the selection, never a permanent
// confirmation ritual sitting under an unchanged value.
assert(main.includes("const pendingChange = selected !== linkedId;"), "a pending change is a changed selection");
assert(main.includes('profileFolderLinkSaveBtn.classList.toggle("hidden", !pendingChange);')
  && main.includes('profileFolderLinkCancelBtn.classList.toggle("hidden", !pendingChange);'),
  "Save and Cancel appear only once the selection actually changed");
assert(main.includes("const canUnlink = Boolean(linkedId) && !pendingChange;"),
  "removal is offered against the saved Media Library, not against a half-made choice");
assert(!/confirm\(\s*["'`][^)]*Media Library/i.test(main), "choosing a Media Library adds no confirmation dialog");

// =========================================================================
// 2. CHOOSING AN EXISTING MEDIA LIBRARY
// =========================================================================

assert(main.includes('placeholder.textContent = "Choose a Media Library…";'),
  "the unset selector invites a choice rather than describing an operation");
assert(main.includes("describeMediaLibraryOptions({") && main.includes("element.value = option.id;"),
  "known Media Libraries are selectable directly — nothing has to be typed");
assert(main.includes("element.textContent = option.label;"),
  "each option is identified by its derived label");
const populate = main.slice(main.indexOf("function populateFolderLinkPicker("), main.indexOf("async function refreshFolderLinkSelection("));
assert(populate.indexOf("for (const library of catalog)") < populate.indexOf("NEW_SHARED_LIBRARY_VALUE"),
  "existing Media Libraries come before Create New, so reuse is the first path offered");
assert(populate.includes('createOption.textContent = "Create New Media Library…";'),
  "creation is offered from inside the same selector");
assert(!populate.includes("Share as a new"), "the retired share vocabulary is gone from the option list");

// Selection is keyed by id; the displayed name is presentation only.
assert(main.includes("const selected = profileFolderLinkSelect.value;")
  && main.includes("result = await profile.linkLocalLibraryToShared(activeLibraryRecord.id, selected);"),
  "the raw catalog id, not the displayed name, is what is written");

// =========================================================================
// 3. CREATE NEW MEDIA LIBRARY
// =========================================================================

assert(count(html, 'id="profile-folder-new-library-input"') === 1, "the name field exists exactly once");
assert(/<label for="profile-folder-new-library-input">Media Library name<\/label>/.test(group),
  "the field is labelled Media Library name");
assert(main.includes('profileFolderNewLibraryRow.classList.toggle("hidden", !isCreateNew);'),
  "naming appears only while creating");
assert(main.includes("profileFolderNewLibraryInput.value = activeLibraryRecord?.name || \"\";"),
  "the name is prefilled from the Media Folder, matching what promoteLibraryToShared already stored");
assert(group.includes("This name is only used inside Browser Gallery. Your Media Folder keeps its own name and stays where it is."),
  "the prefill cannot be read as renaming the folder");
assert(main.includes("const typedName = profileFolderNewLibraryInput.value.trim();")
  && main.includes("name: typedName || activeLibraryRecord.name,"),
  "a typed name is what gets stored, falling back to the folder name");
assert(!/Create Library from Folder/i.test(html) && !/Create Library from Folder/i.test(main),
  "creation never sounds like converting or importing the folder");

// =========================================================================
// 4. THE SYNC PREREQUISITE — verified against the code, not assumed
// =========================================================================

// A Media Library minted on another device can only enter this device's
// catalog through ProfileStore#adoptMergedReplica. Prove who calls it.
const profileStore = fs.readFileSync(new URL("../src/profile/profile-store.js", import.meta.url), "utf8");
assert(profileStore.includes("async #adoptMergedLibraries(incoming)"), "peer Libraries are adopted in one place");
const adoptCallers = ["sync-v2.js", "sync-v3.js", "sync-v2-activation.js"].filter((file) =>
  fs.readFileSync(new URL(`../src/profile/${file}`, import.meta.url), "utf8").includes("adoptMergedReplica"));
assert(adoptCallers.length === 3, "the sync passes are callers of adoptMergedReplica");
function executable(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}
const nonSyncCallers = fs.readdirSync(new URL("../src/", import.meta.url), { recursive: true })
  .filter((entry) => typeof entry === "string" && entry.endsWith(".js"))
  .map((entry) => entry.split("\\").join("/"))
  .filter((entry) => !["profile/sync-v2.js", "profile/sync-v3.js", "profile/sync-v2-activation.js",
    "profile/profile-store.js"].includes(entry))
  .filter((entry) => executable(fs.readFileSync(new URL(`../src/${entry}`, import.meta.url), "utf8"))
    .includes("adoptMergedReplica("));
assert(nonSyncCallers.length === 0,
  `nothing outside the sync passes adopts peer Libraries (found: ${nonSyncCallers.join(", ")})`);

// So an empty selector on a device that has never synced is the truth, and it
// must say so instead of looking broken.
assert(main.includes("const catalogIsEmpty = profile.listLibraries().length === 0;")
  && main.includes("const syncConfigured = Boolean(syncStatus.configured || syncStatus.v3Configured);")
  && main.includes("const showSyncHint = catalogIsEmpty && !syncConfigured;"),
  "the empty state is scoped to the exact condition that produces it");
assert(group.includes("Media Libraries from your other devices appear here after Sync is set up."),
  "the empty selector states the real prerequisite");
assert(main.includes('profileFolderLibrarySyncHint.classList.toggle("hidden", !showSyncHint);')
  && main.includes('profileFolderLibrarySyncBtn.classList.toggle("hidden", !showSyncHint);'),
  "the hint and its action are hidden once either condition stops holding");
// It is a prerequisite for DISCOVERY only. Creating and choosing must not gate on Sync.
assert(mapLinkState({ sourceKind: "fsa", localLibraryId: "local-a" }).allowPicker === true,
  "the selector works with no Sync configured at all");
const saveGate = "profileFolderLinkSaveBtn.disabled = isCreateNew ? Boolean(linkedId) : !linkUi.saveEnabled;";
assert(main.includes(saveGate), "the save gate is still Stage 08's, expressed in one place");
assert(!saveGate.includes("sync") && !saveGate.includes("Sync"),
  "the Sync hint never gates whether a Media Library can be chosen or created");
assert(main.includes("profileFolderLinkSelect.disabled = !activeLibraryRecord?.id || !linkUi.allowPicker;"),
  "Advanced remains visible but disables writes where Stage 08 says they do not work");
// Reuses existing Settings navigation rather than a second Sync entry point.
assert(main.includes("profileSyncGroup.scrollIntoView({ block: \"nearest\" });")
  && main.includes("profileSyncV3ChooseBtn.focus();"),
  "Set Up Sync scrolls to the existing Sync group and focuses its existing chooser");
assert(count(html, 'id="profile-sync-v3-choose-btn"') === 1, "no second Sync chooser was created");

// =========================================================================
// 5. POST-SELECTION REASSURANCE via the existing status line
// =========================================================================

assert(count(html, 'id="profile-folder-link-result"') === 1
  && /id="profile-folder-link-result"[^>]*role="status"/.test(html),
  "the reassurance reuses the group's existing status line");
assert(main.includes("Your files were not changed or moved."), "the reassurance is calm, brief and concrete");
assert(!/new Notification|alert\(/.test(main.slice(main.indexOf("profileFolderLinkSaveBtn.addEventListener"),
  main.indexOf("profileFolderUnlinkBtn.addEventListener"))),
  "no new notification architecture was built for it");

// =========================================================================
// 6. STAGE 08 SEMANTICS ARE UNCHANGED — against real storage
// =========================================================================

installFakeIndexedDB();
const Registry = await import("../src/storage/library-registry.js");
const { ProfileStore } = await import("../src/profile/profile-store.js");

const folderA = await Registry.addOrUpdateLibrary(createVirtualDirectory("Photos NEW-HC").handle);
const folderB = await Registry.addOrUpdateLibrary(createVirtualDirectory("Other Photos").handle);
await Registry.setLibraryProfile(folderA.id, "profile-beast");

const store = new ProfileStore();
await store.whenFactsSettled();
await store.whenLibrariesSettled();

// Before anything is created or synced, this device knows no Media Libraries.
assert(store.listLibraries().length === 0,
  "a device that has never created or synced a Media Library has an empty catalog — the empty state is real");

// Create New Media Library, with a name the reader typed.
const createdId = await store.promoteLibraryToShared(folderA.id, { name: "NEW-HC" });
assert(typeof createdId === "string" && createdId.length > 0, "creating mints a durable Media Library id");
const created = store.listLibraries().find((library) => library.id === createdId);
assert(created && created.name === "NEW-HC", "the typed name is what the Media Library carries");
assert(createdId !== "NEW-HC", "the durable id remains an id — the name is never the identity");
assert((await Registry.getLibraryById(folderA.id)).libraryId === createdId,
  "the local Media Folder row records which Media Library it represents");
assert((await Registry.getLibraryById(folderA.id)).profileId === "profile-beast",
  "creating a Media Library does not disturb the Curation this Media Folder remembers");

// Choosing an existing Media Library from another local Media Folder is refused
// while that Media Library already represents one — Stage 08, unchanged.
const claimed = await store.linkLocalLibraryToShared(folderB.id, createdId);
assert(claimed && claimed.ok === false && claimed.reason === "claimed",
  "a second Media Folder cannot silently take over a Media Library on this device");
assert(claimed.by.id === folderA.id, "the refusal names the Media Folder already using it");
assert((await Registry.getLibraryById(folderB.id)).libraryId == null, "the refusal wrote nothing");

// Remove clears only this device's local relationship.
const beforeRemove = await Registry.getLibraryById(folderA.id);
const removed = await store.unlinkLocalLibraryFromShared(folderA.id);
assert(removed.libraryId === null, "removing clears which Media Library this Media Folder represents");
assert(removed.id === beforeRemove.id && removed.handle === beforeRemove.handle,
  "removing preserves the local row and the physical folder handle");
assert(removed.profileId === "profile-beast", "removing preserves the remembered Curation");
assert(store.listLibraries().some((library) => library.id === createdId),
  "removing deletes nothing from the Media Library catalog");
assert((await Registry.getLibraryById(folderA.id)) !== null, "removing does not remove the Media Folder");

// After removal that Media Library is free, so the other Media Folder may use it.
const reused = await store.linkLocalLibraryToShared(folderB.id, createdId);
assert(reused && reused.libraryId === createdId, "a freed Media Library can be chosen by another Media Folder");
store.closeLocalStateChannel();

// =========================================================================
// 7. OPTION LABELS — no implementation ids during ordinary use
// =========================================================================

const { describeMediaLibraryOptions } = await import(new URL("../src/profile/media-library-options.js", import.meta.url));
const labelsOf = (libraries, currentDeviceId = null) =>
  describeMediaLibraryOptions({ libraries, currentDeviceId }).map((option) => option.label);

// 1 — a unique name shows the name and nothing else. This is the ordinary case
// and the whole point: "Mackenzie · d7751417…" is now just "Mackenzie".
assert(labelsOf([
  { id: "c35cc158aaaa", name: "A BBGs Curation", sourceDeviceId: "dev-1" },
  { id: "d7751417bbbb", name: "Mackenzie", sourceDeviceId: "dev-2" },
]).join("|") === "A BBGs Curation|Mackenzie", "unique names carry no suffix at all");

// 2 — a duplicated name gets the smallest distinction that actually works.
const dupes = [
  { id: "758c513acccc", name: "2", sourceDeviceId: "dev-1" },
  { id: "765ab982dddd", name: "2", sourceDeviceId: "dev-2" },
  { id: "be993047eeee", name: "2", sourceDeviceId: "dev-3" },
];
const dupeLabels = labelsOf(dupes, "dev-1");
assert(dupeLabels[0] === "2 · This device",
  "the colliding Media Library that came from HERE says so, in words");
assert(dupeLabels[1] === "2 · 765a…" && dupeLabels[2] === "2 · be99…",
  "the rest fall back to the SHORTEST id prefix that separates them, not a fixed eight");
assert(new Set(dupeLabels).size === dupeLabels.length, "colliding options remain distinguishable");

// 3 — duplicate name AND device collision: "This device" cannot disambiguate
// two entries that both came from here, so it is not used.
const sameDevice = [
  { id: "aaa1111111", name: "Photos", sourceDeviceId: "dev-1" },
  { id: "aaa2222222", name: "Photos", sourceDeviceId: "dev-1" },
];
const sameDeviceLabels = labelsOf(sameDevice, "dev-1");
assert(!sameDeviceLabels.some((label) => label.includes("This device")),
  "a distinction that does not distinguish is not offered");
assert(new Set(sameDeviceLabels).size === 2, "the fallback still separates them");
assert(sameDeviceLabels.every((label) => label.startsWith("Photos · ")), "and it keeps the name first");

// A missing device id must not silently become a match.
assert(!labelsOf([
  { id: "bbb1111111", name: "Photos", sourceDeviceId: null },
  { id: "bbb2222222", name: "Photos", sourceDeviceId: null },
], null).some((label) => label.includes("This device")),
  "an absent device id never claims to be this device");
// A blank name is still a collidable name, not a crash.
const unnamed = labelsOf([
  { id: "ccc1111111", name: "  ", sourceDeviceId: "dev-9" },
  { id: "ccc2222222", name: "", sourceDeviceId: "dev-9" },
]);
assert(unnamed.every((label) => label.startsWith("Unnamed Media Library · ")), "blank names get a readable placeholder");

// 4 — selection stays keyed by the durable id no matter what the label says.
const described = describeMediaLibraryOptions({ libraries: dupes, currentDeviceId: "dev-1" });
assert(described.map((option) => option.id).join("|") === "758c513acccc|765ab982dddd|be993047eeee",
  "every option carries its durable Media Library id");
assert(described.every((option) => option.label !== option.id), "the label is never the identity");
// Two Media Libraries sharing a visible name must not become selectable as one.
const twins = describeMediaLibraryOptions({
  libraries: [{ id: "id-a", name: "Nature", sourceDeviceId: "d1" }, { id: "id-b", name: "Nature", sourceDeviceId: "d2" }],
});
assert(twins[0].id !== twins[1].id && twins[0].label !== twins[1].label,
  "a duplicate visible name cannot collapse two Media Libraries into one choice");

// 5 — rendering never mutates the records it was given.
const records = [
  { id: "mut-1", name: "Nature", sourceDeviceId: "dev-1" },
  { id: "mut-2", name: "Nature", sourceDeviceId: "dev-2" },
];
const snapshot = JSON.stringify(records);
describeMediaLibraryOptions({ libraries: records, currentDeviceId: "dev-1" });
assert(JSON.stringify(records) === snapshot, "describing options mutates no stored Media Library record");
assert(records.every((record) => !record.name.includes("·")), "no stored name absorbed its own disambiguation");

// The dead field that caused this: the projection never produced a device NAME,
// so the old label always fell through to the id prefix.
const facts = fs.readFileSync(new URL("../src/profile/sync-facts.js", import.meta.url), "utf8");
const projected = facts.slice(facts.indexOf("export function projectLibrary("), facts.indexOf("* Every known shared Library"));
assert(!projected.includes("sourceDeviceName") && !projected.includes("deviceName:"),
  "there is still no peer device NAME on the projection — the id prefix stays the last resort");
assert(projected.includes("sourceDeviceId:"), "only the raw device id exists, which is why it is not shown");
assert(!main.includes("sourceDeviceName"), "the dead field is gone from the renderer");

// =========================================================================
// 8. PRESENTATION
// =========================================================================

assert(/\.profile-folder-link-row > label \{[^}]*text-transform: uppercase;/.test(css),
  "the Media Library label is styled as a property label, matching the group headings around it");
assert(/\.profile-folder-new-library-row \{[^}]*flex-direction: column;/.test(css),
  "the create step stacks inside the same column");

console.log(`Media Library selection: ${assertions} assertions passed`);
