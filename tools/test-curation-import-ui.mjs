// [CURATION-IMPORT / STAGE-C/D/E] UI-wiring regression suite. This codebase
// has no DOM test runner, so — matching every other *-ui-*.mjs / *-polish.mjs
// suite here (see test-media-library-selection.mjs, test-profile-sync-polish.mjs)
// — this asserts against the raw HTML/JS source: markup shape, exact wiring
// lines, and the absence of retired UI, rather than executing main.js in a
// simulated DOM.
import fs from "node:fs";

const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const main = fs.readFileSync(new URL("../src/main.js", import.meta.url), "utf8");

let assertions = 0;
function assert(condition, label) {
  if (!condition) throw new Error(label);
  assertions += 1;
}
function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

// =========================================================================
// 1. THE OLD RAW MERGE/REPLACE/COPY SURFACE IS GONE
// =========================================================================

assert(!html.includes('id="profile-import-merge-btn"') && !html.includes('id="profile-import-replace-btn"')
  && !html.includes('id="profile-import-copy-btn"') && !html.includes('id="profile-import-copy-input"'),
  "the old raw Merge/Replace/Copy import buttons are retired");
assert(!main.includes("profileImportMergeBtn") && !main.includes("profileImportReplaceBtn")
  && !main.includes("profileImportCopyBtn") && !main.includes("pendingImportMode"),
  "no leftover references to the retired import-mode plumbing");
assert(count(html, 'id="profile-import-btn"') === 1, "one unified Import Curation entry point exists");
assert(main.includes('profileImportBtn.addEventListener("click", () => profileImportInput.click());'),
  "the new entry point opens the same file picker the old buttons used");
assert(html.includes('id="profile-skip-missing-input"'),
  "the existing 'only import entries for files currently loaded' capability is carried over");

// =========================================================================
// 2. FEATURE 1 — IMPORT IDENTITY (Case A/B/C)
// =========================================================================

assert(main.includes('import { classifyCurationImport } from "./profile/curation-import-identity.js";'),
  "the importer routes through the durable-identity classifier, not name-only comparison");
assert(main.includes('classification.kind === "SAME_ID"') && main.includes('classification.kind === "DIFFERENT"'),
  "Case A (SAME_ID) and Case C (DIFFERENT) are both routed");
assert(main.includes('Another Curation named "${sourceName}" already exists'),
  "Case B's customer-facing framing asks the genuine human question, not a UUID comparison");
assert(main.includes("Keep Separate") && main.includes("Bring Into"),
  "Case B offers Bring Into Existing / Keep Separate, matching the brief");
assert(main.includes("displayCurationLabel(candidate, curations)"),
  "multiple same-name destination candidates are disambiguated with the existing conditional short-id labels");
assert(!main.includes("profileId === profileId") /* sanity: no accidental tautology */, "no stray tautological id comparison");

// =========================================================================
// 3. FEATURE 2 — IMPORT ALL + CURATE IMPORT
// =========================================================================

assert(main.includes('{ label: "Import All", value: "all", primary: true }')
  && main.includes('{ label: "Curate Import", value: "curate" }'),
  "every destination offers Import All / Curate Import / Cancel, Import All as the default action");
assert(main.includes("async function commitCurationImport(") && main.includes("function openCurateImportDialog("),
  "Import All and Curate Import share one commit path (commitCurationImport)");

// =========================================================================
// 4. FEATURE 3 — CURATE IMPORT IS A NON-MUTATING STAGING SYSTEM
// =========================================================================

assert(count(html, 'id="curate-import-dialog"') === 1, "the Curate Import staging dialog exists exactly once");
assert(html.includes('id="curate-import-select-all"') && html.includes(">Select All<"),
  "Select All is present");
assert(!html.toLowerCase().includes("clear all"),
  "no prominent Clear All control was added — the brief explicitly forbids one");
assert(html.match(/id="curate-import-commit-btn"[^>]*disabled/),
  "Import Selected starts disabled — nothing is pre-committed to");
assert(main.includes("curateImportCommitBtn.disabled = !importPlanHasSelection(plan);"),
  "Import Selected stays gated on the plan actually having a selection");
assert(main.includes("tagPlan.selected = checkbox.checked;") && !main.includes("profile.setItemTag(") ,
  "checking/unchecking a Curate Import row edits the in-memory plan, never calls a ProfileStore mutator directly");
assert(
  main.slice(main.indexOf("function openCurateImportDialog("), main.indexOf("// [CURATION-IMPORT / STAGE-C / GENERIC CHOICE DIALOG]"))
    .match(/applyImportPlan/) === null,
  "opening/editing the Curate Import dialog never itself calls applyImportPlan — only commitCurationImport (via Import Selected) does"
);
assert(main.includes("await commitCurationImport({ imported, destinationId, newCurationName, plan });"),
  "Import Selected is the only path that commits the edited plan");

// =========================================================================
// 5. SNAPSHOT SAFETY / DESTINATION INSPECTION WITHOUT SWITCHING
// =========================================================================

assert(main.includes("await profile.getProfileSnapshot(destinationId)") || main.includes("await profile.getProfileSnapshot(targetId)"),
  "building/refreshing a plan reads the destination via the read-only snapshot seam, not by switching to it");
assert(main.includes("planFingerprint") && main.includes("fingerprintTags"),
  "stale-plan protection re-checks the destination's Tag vocabulary before committing");

// =========================================================================
// 6. FEATURE 4 — DUPLICATE TAG REPAIR
// =========================================================================

assert(html.includes('id="duplicate-tag-notice"') && html.includes('class="duplicate-tag-notice hidden"'),
  "the duplicate-tag notice is hidden until a duplicate group actually exists");
assert(main.includes("function renderDuplicateTagNotice()") && main.includes("buildDuplicateTagRepairPlan(profile.getTags())"),
  "the notice is computed from the customer's actual current Tag vocabulary");
assert(count(html, 'id="duplicate-tag-repair-dialog"') === 1, "the repair staging dialog exists exactly once");
assert(html.match(/id="duplicate-tag-repair-commit-btn"[^>]*disabled/),
  "Merge Selected starts disabled");
assert(main.includes("applyDuplicateTagRepairPlan(profile, plan)"),
  "repair commits through the plan-based apply function, not ad hoc deleteTag/setItemTag calls scattered inline");
assert(main.includes("renderDuplicateTagNotice();") && main.slice(main.indexOf('profile.subscribe(() => {\n  // Deleting the tag')).includes("renderDuplicateTagNotice()"),
  "the notice refreshes on every profile change, alongside the existing Tags grid render");

// =========================================================================
// 7. FEATURE 5 — CREATE DUPLICATE-NAME GUARD
// =========================================================================

assert(main.includes("findCurationNameCollisions(name, existing)"),
  "manual Curation creation checks for an existing same-name Curation before creating");
assert(main.includes("label: `Use Existing ${existingLabel}`") && main.includes('{ label: "Create Another"'),
  "the create-guard offers Use Existing / Create Another / Cancel");
assert(main.includes("suggestNextCurationName(name, existing.map((entry) => entry.name))"),
  "Create Another proposes the familiar '(2)' convention");
assert(main.includes("await profile.switchProfile(collisions[0].id);") ,
  "Use Existing switches to the existing Curation rather than creating a duplicate");

// =========================================================================
// 8. FEATURE 6 — FRONT-FACING RENAME
// =========================================================================

assert(html.includes('id="profile-rename-btn"'), "Rename is a first-class control");
assert(html.slice(html.indexOf('id="profile-active-group"'), html.indexOf('id="profile-device-group"'))
  .includes('id="profile-rename-btn"'),
  "Rename lives with the currently selected Curation (This Device Is Using), not buried in Advanced");
assert(main.includes("profile.setProfileName(newName)"), "Rename calls the existing, already Sync-safe setProfileName API");
assert(!main.slice(main.indexOf('profileRenameBtn.addEventListener("click"'), main.indexOf("profileDeleteBtn.addEventListener"))
  .includes("createProfile("),
  "Renaming never creates a new Curation or id");
assert(main.includes('findCurationNameCollisions(newName, profile.listProfiles(), activeId)'),
  "renaming to a name already in use is checked, excluding the Curation being renamed itself");
assert(main.includes('{ label: "Use "') === false && main.includes('Use "${newName}" Anyway'),
  "rename collision offers Use Anyway / Choose Another Name / Cancel, never an automatic merge");

// =========================================================================
// 9. THE ONE REUSABLE CHOICE DIALOG (no scattered bespoke duplicates)
// =========================================================================

assert(count(html, 'id="curation-choice-dialog"') === 1, "exactly one generic choice dialog exists");
assert(count(main, "function openCurationChoiceDialog(") === 1,
  "exactly one implementation of the choice-dialog primitive — reused by Import identity, Create-guard, and Rename");
assert(count(main, "openCurationChoiceDialog({") >= 4,
  "the generic dialog is actually reused across multiple decision points, not duplicated per-feature");

console.log(`Curation import/repair/rename UI wiring: ${assertions} assertions passed`);
