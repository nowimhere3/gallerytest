import fs from "node:fs";

const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const main = fs.readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
const css = fs.readFileSync(new URL("../styles.css", import.meta.url), "utf8");
let assertions = 0;
function assert(condition, label) { if (!condition) throw new Error(label); assertions += 1; }
function count(text, needle) { return text.split(needle).length - 1; }

assert(count(html, 'id="profile-sync-help-btn"') === 1, "? Help button exists once");
assert(/<button id="profile-sync-help-btn"[^>]*>\? Help<\/button>/.test(html), "? Help is a native button");
const sectionStart = html.indexOf('<details class="profile-section"');
const summaryStart = html.indexOf("<summary>", sectionStart);
const summaryEnd = html.indexOf("</summary>", summaryStart);
const helpStart = html.indexOf('id="profile-sync-help-btn"', sectionStart);
const introStart = html.indexOf('id="profile-sync-intro"', sectionStart);
const folderStart = html.indexOf('id="profile-folder-group"', sectionStart);
assert(sectionStart >= 0 && summaryEnd < helpStart, "? Help is inside expanded Curations & Sync content");
assert(!html.slice(summaryStart, summaryEnd).includes("profile-sync-help-btn"), "? Help is not inside the disclosure trigger");
assert(helpStart < introStart && helpStart < folderStart, "? Help is the first utility before intro and settings groups");
const helpCss = css.slice(css.indexOf(".profile-sync-help-btn"), css.indexOf("}", css.indexOf(".profile-sync-help-btn")));
assert(!/position:\s*absolute/.test(helpCss), "? Help is not far-right absolute chrome");

assert(main.includes('profileSyncHelpBtn.addEventListener("click"'), "? Help has a click action");
assert(main.includes('dispatchProfileSyncIntroduction({ type: "replay" });'), "? Help uses the existing replay event");
assert(!main.includes("profileSyncHelpDialog.showModal"), "? Help does not open a glossary modal");
assert(!html.includes('id="profile-sync-help-dialog"'), "full glossary dialog is absent");
assert(!html.includes('id="profile-sync-help-content"'), "full glossary is not a rendered destination");
assert(!html.includes("data-help-concept="), "no all-concepts Help surface remains");
assert(!html.includes("Replay Introduction"), "redundant Replay Introduction control is absent");
assert(!main.includes("profileSyncIntroSeen: false"), "replay never resets seen persistence");
assert(main.includes("PROFILE_SYNC_BACKGROUND_GLOSSARY"), "reviewed glossary language remains background source material");
for (const key of ["mediaFolder", "mediaLibrary", "curation", "activeCuration", "libraryCuration", "sync"]) {
  assert(new RegExp(`\\b${key}:`).test(main), `${key} background knowledge remains available`);
}
assert(main.includes('glossaryExcerpt("mediaFolder", 1)'), "Media Folder uses only its relevant excerpt");
assert(main.includes('glossaryExcerpt("mediaLibrary", 2)'), "Media Library uses only its relevant excerpt");
assert(main.includes('glossaryExcerpt("activeCuration", 2)'), "active Curation uses only its relevant excerpt");
assert(main.includes('glossaryExcerpt("sync", 2)'), "Sync uses only its relevant excerpt");

for (const id of ["profile-media-folder-context-help", "profile-media-library-context-help", "profile-active-context-help", "profile-sync-context-help"]) {
  assert(count(html, `id="${id}"`) === 1, `${id} exists once`);
  assert(new RegExp(`id="${id}" class="contextual-help hidden" role="note"`).test(html), `${id} is hidden and semantic by default`);
}
const mediaFolderControls = html.slice(html.indexOf('id="profile-media-folder-controls"'), html.indexOf('id="profile-folder-link-row"'));
const mediaLibraryControls = html.slice(html.indexOf('id="profile-folder-link-row"'), html.indexOf('id="profile-folder-link-result"'));
assert(mediaFolderControls.includes('profile-media-folder-context-help') && !mediaFolderControls.includes('profile-media-library-context-help'), "Media Folder reveals only Media Folder Help");
assert(mediaLibraryControls.includes('profile-media-library-context-help') && !mediaLibraryControls.includes('profile-media-folder-context-help'), "Media Library reveals only Media Library Help");

const controllerStart = main.indexOf("const contextualHelpEntries");
const controllerEnd = main.indexOf("function renderProfileSyncIntroduction", controllerStart);
const controller = main.slice(controllerStart, controllerEnd);
assert(controller.includes('addEventListener("focusin"'), "keyboard focus reveals contextual Help");
assert(controller.includes('addEventListener("focusout"'), "focus leaving a group may retreat Help");
assert(controller.includes('addEventListener("change"'), "click/change reveals contextual Help");
assert(controller.includes("event.relatedTarget") && controller.includes("entry.group.contains(event.relatedTarget)"), "focus movement inside a group does not dismiss Help");
assert(controller.includes("queueMicrotask") && controller.includes("document.activeElement"), "focus settling is checked before retreat");
assert(!/mouseover|mouseenter|hover/.test(controller), "contextual behavior never depends on hover");
assert(controller.includes("entry.hasPendingChange()") && controller.includes("contextualHelpHasWarning(entry)") && controller.includes("entry.hasConflict()"), "pending, tone and conflict states remain sticky");
assert(controller.includes("product-status-warning") && controller.includes("product-status-danger"), "warning and danger tones remain sticky");
assert(controller.includes("profileSyncIntroState.visible"), "visible introduction suppresses contextual Help");
assert(controller.includes("entry.block.classList.toggle") && controller.includes("entry !== visibleEntry"), "only one contextual concept can be shown");
assert(css.includes("transition: opacity 120ms ease") && !/contextual-help[^}]*transition:[^;}]*height/s.test(css), "only opacity animates");

assert(main.includes('? `This device: ${status.deviceDisplayName}${status.deviceName ? "" : " (detected)"}`'), "ordinary device line uses only display name");
assert(!main.includes('shortId ? ` · ${shortId}'), "ordinary device line has no raw-id fragment");
assert(main.includes('if (status.deviceId) line += ` Device ID: ${status.deviceId}.`;'), "Advanced diagnostics retain durable identity");
assert(html.includes('aria-describedby="profile-folder-link-conflict profile-media-library-context-help"'), "Media Library control references only its contextual Help");
assert(html.includes('aria-describedby="profile-active-context-help"'), "Curation control references only its contextual Help");
assert(html.includes('aria-describedby="profile-sync-context-help"'), "Sync chooser references only its contextual Help");

const associationSaveStart = main.indexOf('profileAssociationSaveBtn.addEventListener("click"');
const associationSaveEnd = main.indexOf('profileAssociationCancelBtn.addEventListener("click"', associationSaveStart);
const associationSave = main.slice(associationSaveStart, associationSaveEnd);
assert(main.includes("let dismissedAssociationHelpKey = null;"), "completed-action Help has presentation-only dismissal state");
assert(main.includes("dismissedAssociationHelpKey !== associationHelpKey(associationUi)"), "only the exact completed association state is suppressed");
assert(associationSave.includes('`Now remembered with ${selectedProfileName}.`'), "successful association renders the remembered Curation state");
assert(associationSave.indexOf("dismissedAssociationHelpKey = associationHelpKey(getCurrentAssociationUiState());")
  < associationSave.indexOf("syncAssociateButtonVisibility();"), "successful association dismisses obsolete Help before the final state render");
assert(main.includes('fsaAssociateBtn.addEventListener("click"') && main.includes("dismissedAssociationHelpKey = null;"), "a later association action can reveal Help for its current action");
assert(main.includes('? "Change Curation"') && main.includes(': "Choose a Curation"'), "new steady-state Change Curation action remains available");

console.log(`Settings compression: ${assertions} assertions passed`);
