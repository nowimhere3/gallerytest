// [SYNCV3 / STAGE-10 / FINAL-UX-POLISH]
// Two narrow contracts that the copy/hierarchy suites deliberately do not own:
// the "This Device Is Using" selector's display-vs-stored split, and the rail
// action label's deliberate two-line wrap. Both are places where a later edit
// could quietly turn presentation into identity, so they are pinned here.
import fs from "node:fs";
import { installFakeIndexedDB, createVirtualDirectory } from "./lib/browser-test-env.mjs";

const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const mainSource = fs.readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
const css = fs.readFileSync(new URL("../styles.css", import.meta.url), "utf8");

let assertions = 0;
function assert(condition, label) {
  if (!condition) throw new Error(label);
  assertions += 1;
}

function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

// The accessible name of a control is its flattened text with white space
// normalised, so this is what a screen reader announces for a label whose copy
// carries its own line break.
function accessibleName(text) {
  return text.replace(/\s+/g, " ").trim();
}

// =========================================================================
// 1. THIS DEVICE IS USING — the selector
// =========================================================================

assert(count(html, 'id="profile-select"') === 1, "the Curation selector exists exactly once");
assert(!/<label[^>]*\sfor="profile-select"/.test(html),
  "the standalone visible Curation label beside the selector is gone");
assert(/<select id="profile-select"[^>]*aria-label="[^"]+"/.test(html),
  "the selector keeps an accessible name now that its visible label is gone");

const activeGroup = html.indexOf('id="profile-active-group"');
const deviceGroup = html.indexOf('id="profile-device-group"');
const activeMarkup = html.slice(activeGroup, deviceGroup);
assert(activeGroup >= 0 && deviceGroup > activeGroup, "This Device Is Using precedes This Device");
assert(activeMarkup.includes("<h3 class=\"profile-group-heading\">This Device Is Using</h3>"),
  "the group heading still names the concept, so the selector need not repeat it");

const currentRowStart = activeMarkup.indexOf('class="profile-current-row"');
const currentRow = activeMarkup.slice(currentRowStart, activeMarkup.indexOf("</div>", currentRowStart));
assert(currentRowStart >= 0, "the selector still lives in its existing row");
assert(!currentRow.includes("<label"), "nothing pushes the selector sideways inside its row");
assert(currentRow.includes('class="field-control"'),
  "the selector keeps the shared control styling used by the rest of the section");
assert(!css.includes(".profile-select-label"), "the label-only offset rule is retired with the label");
assert(/\.profile-current-row select \{\s*flex: 1 1 auto;/.test(css),
  "the selector fills its row like the other primary controls");

// The word "Curation" is display text. Value, stored name and switching must
// all keep reading the same identity they did before this polish.
assert(mainSource.includes("option.value = entry.id;"), "each option's value stays the raw profile id");
assert(mainSource.includes("option.textContent = `${entry.name} Curation`;"),
  "each option displays {CurationName} Curation");
assert(!mainSource.includes("entry.name = "), "rendering the selector never rewrites a stored name");

const changeHandler = mainSource.slice(mainSource.indexOf('profileSelect.addEventListener("change"'));
assert(changeHandler.includes("const targetId = profileSelect.value;"),
  "switching still reads the raw id straight off the selector");
assert(/switchProfile\(targetId\)/.test(changeHandler.slice(0, 2000)),
  "the raw id, not the displayed text, is what is switched to");

const createFn = mainSource.slice(mainSource.indexOf("async function createProfileFromInput()"));
assert(createFn.slice(0, 400).includes("const name = profileCreateInput.value.trim();"),
  "creation stores exactly what was typed");
assert(!createFn.slice(0, 800).includes("Curation`"), "creation never appends the display word to a stored name");

// =========================================================================
// 2. Display value versus stored value, against a real ProfileStore
// =========================================================================

installFakeIndexedDB();
const { ProfileStore } = await import("../src/profile/profile-store.js");
createVirtualDirectory("Media Folder");
const store = new ProfileStore();
await store.whenFactsSettled();

const beast = await store.createProfile("BEAST");
const stored = store.listProfiles().find((entry) => entry.id === beast.id);
assert(stored.name === "BEAST", "the stored Curation name remains exactly BEAST");
assert(stored.id !== "BEAST" && stored.id !== "BEAST Curation", "the stored id is an id, not display text");
assert(`${stored.name} Curation` === "BEAST Curation", "the selector would display BEAST Curation");
await store.switchProfile(stored.id);
assert(store.getProfileId() === stored.id, "switching by the option value activates that Curation");
assert(store.getProfileName() === "BEAST", "the active Curation name is still the stored name");
assert(store.listProfiles().every((entry) => !entry.name.endsWith(" Curation")),
  "no stored Curation name absorbed the display word");
store.closeLocalStateChannel();

// =========================================================================
// 3. Rail action label — short, because the card's own label carries the concept
// =========================================================================
//
// [SYNCV3 / STAGE-10 / FINAL-CLOSEOUT-POLISH]
// This section previously pinned a hard-coded "\n" in the label plus a
// `white-space: pre-line` rule to make a long label wrap into two tidy centred
// lines. The closeout pass shortened the label instead — the card's
// "Curation for This Media Library" heading two lines above already names the
// concept — so the wrap machinery is retired rather than merely unused.

assert(mainSource.includes('? "Change Curation"') && mainSource.includes(': "Choose a Curation"'),
  "the rail action says only what pressing it does");
assert(!mainSource.includes("Curation for\\nThis Media Library"),
  "the hard-coded line break is gone from the runtime labels");
assert(accessibleName("Change Curation") === "Change Curation"
  && accessibleName("Choose a Curation") === "Choose a Curation",
  "both labels are announced exactly as written");

const staticLabel = html.slice(html.indexOf('<span id="fsa-associate-btn-label">'));
const staticText = staticLabel.slice(staticLabel.indexOf(">") + 1, staticLabel.indexOf("</span>"));
assert(!staticText.includes("\n"), "the markup default carries no break either");
assert(accessibleName(staticText) === "Choose a Curation", "the markup default matches the runtime Choose label");

assert(!/#fsa-associate-btn-label \{[^}]*white-space: pre-line;/.test(css),
  "the pre-line rule is retired with the label that needed it");
assert(/#fsa-associate-btn-label \{[^}]*text-align: center;/.test(css), "the label stays centred");
assert(/\.fsa-associate-btn \{[^}]*width: 100%;/.test(css),
  "the button still fills the rail");
assert(!/\.fsa-associate-btn \{[^}]*max-width/.test(css), "no width hack was introduced");

// The card's locked scan path: concept -> current state -> action -> benefit.
const cardStart = html.indexOf('class="rail-profile-summary"');
const card = html.slice(cardStart, html.indexOf("</div>", html.indexOf('id="fsa-associate-help"')));
const order = [
  'class="rail-profile-summary-label"',
  'id="associated-text"',
  'id="fsa-associate-btn"',
  'id="fsa-associate-help"',
];
let previous = -1;
for (const marker of order) {
  const at = card.indexOf(marker);
  assert(at > previous, `card order: ${marker} follows what precedes it`);
  previous = at;
}
assert(card.includes("Curation for This Media Library"), "the card names the concept first");
assert(mainSource.includes('fsaAssociateHelp.textContent = shouldShow && actionHelpIsCurrent ? (associationUi.actionHelp || "") : "";'),
  "the current benefit comes from the pure mapper and completed-action Help can retreat");

// Behaviour is untouched: this is the same single navigation-only control.
assert(count(html, 'id="fsa-associate-btn"') === 1, "the rail action still exists exactly once");
assert(mainSource.includes("fsaAssociateBtn.classList.toggle(\"hidden\", !shouldShow)"),
  "the label change did not alter when the action is offered");

console.log(`Curations & Sync final UX polish: ${assertions} assertions passed`);
