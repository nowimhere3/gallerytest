// [SYNCV3 / STAGE-10 / CURATION-CHOICE-LABELS]
// Pins the conditional short-id disambiguation rule for Curation choice
// lists: a name stays clean until another Curation in the same list shares
// it, and only the colliding entries grow an eight-character id suffix.
import fs from "node:fs";
import { installFakeIndexedDB, createVirtualDirectory } from "./lib/browser-test-env.mjs";
import { displayCurationLabel } from "../src/profile/curation-display.js";

const mainSource = fs.readFileSync(new URL("../src/main.js", import.meta.url), "utf8");

let assertions = 0;
function assert(condition, label) {
  if (!condition) throw new Error(label);
  assertions += 1;
}

// =========================================================================
// 1. A single Curation named BEAST shows exactly "BEAST" — no id at all.
// =========================================================================

const soloBeast = [{ id: "a0bb0eb5-aaaa-bbbb-cccc-000000000001", name: "BEAST" }];
assert(displayCurationLabel(soloBeast[0], soloBeast) === "BEAST",
  "a unique Curation name shows the name and nothing else");

// =========================================================================
// 2. Two distinct Curations both named BEAST get distinguishable suffixes.
// =========================================================================

const twoBeasts = [
  { id: "a0bb0eb5-1111-2222-3333-444444444444", name: "BEAST" },
  { id: "c7b7e1ef-5555-6666-7777-888888888888", name: "BEAST" },
];
const labels = twoBeasts.map((entry) => displayCurationLabel(entry, twoBeasts));
assert(labels[0] === "BEAST — a0bb0eb5", "the first colliding BEAST gets its own id suffix");
assert(labels[1] === "BEAST — c7b7e1ef", "the second colliding BEAST gets its own, different id suffix");
assert(new Set(labels).size === 2, "colliding entries remain distinguishable from each other");

// =========================================================================
// 3. Duplicate BEAST plus a unique FAMILY — only BEAST is touched.
// =========================================================================

const mixed = [
  { id: "a0bb0eb5-1111-2222-3333-444444444444", name: "BEAST" },
  { id: "c7b7e1ef-5555-6666-7777-888888888888", name: "BEAST" },
  { id: "d000000000000000000000000000family", name: "FAMILY" },
  { id: "e000000000000000000000000000000work", name: "WORK" },
];
const mixedLabels = mixed.map((entry) => displayCurationLabel(entry, mixed));
assert(mixedLabels[0] === "BEAST — a0bb0eb5" && mixedLabels[1] === "BEAST — c7b7e1ef",
  "duplicate BEAST entries receive suffixes even alongside unique names");
assert(mixedLabels[2] === "FAMILY", "a uniquely-named Curation elsewhere in the same list stays untouched");
assert(mixedLabels[3] === "WORK", "a second uniquely-named Curation elsewhere in the same list also stays untouched");

// =========================================================================
// 4. The underlying name and id are never mutated by computing a label.
// =========================================================================

const records = [
  { id: "a0bb0eb5-1111-2222-3333-444444444444", name: "BEAST" },
  { id: "c7b7e1ef-5555-6666-7777-888888888888", name: "BEAST" },
];
const snapshot = JSON.stringify(records);
records.forEach((entry) => displayCurationLabel(entry, records));
assert(JSON.stringify(records) === snapshot, "computing a label mutates no Curation record");

// =========================================================================
// 5. Existing unique-name behaviour at the real call sites is unchanged.
// =========================================================================

assert(mainSource.includes("import { displayCurationLabel } from \"./profile/curation-display.js\";"),
  "main.js imports the shared display-label helper rather than re-deriving its own collision check");
assert(mainSource.includes("option.textContent = `${displayCurationLabel(entry, profiles)} Curation`;"),
  "the Curation switcher routes its option text through the shared helper");
assert(mainSource.includes("option.textContent = displayCurationLabel(entry, profiles);"),
  "the Media Library association picker routes its option text through the shared helper");
assert(!mainSource.includes("entry.name = "), "rendering a Curation choice list never rewrites a stored name");

// =========================================================================
// 6. End to end against a real ProfileStore: two Curations legitimately
//    named BEAST produce distinguishable, stable labels; the stored names
//    and ids are untouched.
// =========================================================================

installFakeIndexedDB();
const { ProfileStore } = await import("../src/profile/profile-store.js");
createVirtualDirectory("Media Folder");
const store = new ProfileStore();
await store.whenFactsSettled();

const first = await store.createProfile("BEAST");
const second = await store.createProfile("BEAST");
const stored = store.listProfiles().filter((entry) => entry.name === "BEAST");
assert(stored.length === 2, "both newly-created Curations genuinely keep the stored name BEAST");
assert(stored[0].id !== stored[1].id, "the two Curations remain distinct identities");

const storeLabels = stored.map((entry) => displayCurationLabel(entry, stored));
assert(new Set(storeLabels).size === 2, "the real ProfileStore's colliding Curations get distinguishable labels");
assert(storeLabels.every((label) => label.startsWith("BEAST — ")), "each label keeps the human name first");
assert(store.listProfiles().filter((entry) => entry.name === "BEAST").length === 2,
  "computing display labels never rewrote the stored Curation name");
void first;
void second;
store.closeLocalStateChannel();

console.log(`Curation choice-list labels: ${assertions} assertions passed`);
