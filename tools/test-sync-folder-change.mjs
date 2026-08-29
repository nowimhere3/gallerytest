#!/usr/bin/env node
// [SYNCV3 / STAGE-10 / CHANGE-SYNC-FOLDER-FIX]
//
// Regression suite for a manually reported defect: clicking "Change Sync
// Folder" produced no visible result. Two independent causes were found, and
// both are the kind that manual testing reports as "nothing happened" while
// every unit underneath is behaving correctly:
//
//   1. mapSyncStatusCopy() consulted v3Configured only inside the mode === "v3"
//      branch. Connecting a V3 Sync Folder BEFORE activating V3 is explicitly
//      allowed (profile-sync.js #refreshV3Connection says so), and the default
//      mode is v1 — so the primary status line kept reporting "no sync folder
//      chosen" beside a button reading "Change Sync Folder".
//   2. runV3FolderPicker() reported failure only through
//      #profile-sync-v3-status-text, which lives inside the COLLAPSED Advanced
//      Settings disclosure, while the button that calls it lives in the
//      always-visible Sync group.
//
// The native directory picker cannot be driven by automation, so the chain is
// proved up to exactly that boundary: the wiring into it statically, and
// everything after it against a real ProfileSync.

import fs from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { installFakeIndexedDB, createVirtualDirectory, settle } from "./lib/browser-test-env.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const src = (rel) => pathToFileURL(path.join(ROOT, "src", rel)).href;

const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const main = fs.readFileSync(path.join(ROOT, "src/main.js"), "utf8");

let assertions = 0;
function assert(condition, label) {
  if (!condition) throw new Error(label);
  assertions += 1;
}

// =========================================================================
// 1. THE EVENT CHAIN, UP TO THE PLATFORM BOUNDARY
// =========================================================================

assert(main.includes('profileSyncV3ChooseBtn.addEventListener("click", runV3FolderPicker);'),
  "the button is wired to the picker flow");
assert(main.includes('profileSyncV3ChooseBtn.textContent = connected ? "Change Sync Folder" : "Choose Sync Folder";'),
  "the same control is Choose when unconfigured and Change when configured");
const picker = main.slice(main.indexOf("async function runV3FolderPicker()"),
  main.indexOf("// [SYNCV3 / STAGE-05 / DEVICE-NAMING]", main.indexOf("async function runV3FolderPicker()")));
assert(picker.includes('await window.showDirectoryPicker({ mode: "readwrite" })'),
  "it reaches the platform picker — the one step automation cannot execute");
assert(picker.includes("await profileSync.connectV3Folder(dirHandle);"),
  "the chosen handle is handed to the existing supported connect flow");

// There is no early return that a CONFIGURED state could trip: the function
// never reads v3Configured, so Change and Choose take an identical path.
assert(!picker.includes("v3Configured") && !picker.includes("getStatus()"),
  "an already-configured Sync Folder cannot short-circuit the picker");

// A cancelled picker stays silent; every other failure is reported.
assert(picker.includes('if (error && error.name === "AbortError") return;'),
  "closing the picker is not an error");
assert((picker.match(/reportSyncFolderProblem\(/g) || []).length === 3,
  "unsupported browser, picker error and connect failure all report");
assert(picker.includes("console.warn(\"[SYNCV3] Could not connect the chosen Sync Folder.\", error);"),
  "a failing connect is no longer swallowed");

// =========================================================================
// 2. FAILURE HAS TO LAND SOMEWHERE VISIBLE
// =========================================================================

const advancedStart = html.indexOf('<details class="advanced-settings-section">');
assert(advancedStart >= 0, "Advanced Settings is a collapsed disclosure");
assert(!/<details class="advanced-settings-section"[^>]*\sopen/.test(html),
  "Advanced Settings is collapsed by default — anything inside it is unseen");
const diagnostic = html.indexOf('id="profile-sync-v3-status-text"');
const product = html.indexOf('id="profile-sync-product-status"');
const chooser = html.indexOf('id="profile-sync-v3-choose-btn"');
assert(diagnostic > advancedStart,
  "the diagnostic V3 line is inside Advanced Settings — this is what made failures invisible");
assert(product < advancedStart && chooser < advancedStart,
  "the product status line and the chooser both live on the always-visible surface");
assert(main.includes("function reportSyncFolderProblem(message, tone)")
  && main.includes("profileSyncV3StatusText.textContent = message;")
  && main.includes("profileSyncProductStatus.textContent = message;"),
  "failures now reach the visible line as well as the diagnostic one");
assert(main.includes("applyProductStatusTone(profileSyncProductStatus, tone);"),
  "the visible failure carries a tone, using the existing five-tone vocabulary");

// =========================================================================
// 3. THE STATUS LINE ACTUALLY CHANGES — against a real ProfileSync
// =========================================================================

installFakeIndexedDB();
const { ProfileStore } = await import(src("profile/profile-store.js"));
const { ProfileSync } = await import(src("profile/profile-sync.js"));
const { mapSyncStatusCopy } = await import(src("profile/sync-status-copy.js"));

const store = new ProfileStore();
await settle();
await store.whenFactsSettled();
const sync = new ProfileSync(store);

let emits = 0;
sync.subscribe(() => { emits += 1; });
const emitsAtStart = emits;

const before = sync.getStatus();
assert(before.mode === "v1", "a fresh installation is on the default transport, not V3");
assert(before.v3Configured === false, "no Sync Folder is connected yet");
const lineBefore = mapSyncStatusCopy(before).line;
assert(lineBefore === "Not syncing — no sync folder chosen", "the untouched installation says so");

// This is the step immediately after the platform boundary: the handle the
// picker would have returned, handed to the same call the click makes.
await sync.connectV3Folder(createVirtualDirectory("Browser Gallery Sync").handle);
await settle();

const after = sync.getStatus();
assert(after.v3Configured === true, "the Sync Folder is connected");
assert(after.v3FolderName === "Browser Gallery Sync", "the connected folder is named in the status snapshot");
assert(after.mode === "v1", "connecting a folder did NOT silently activate a transport");
assert(emits > emitsAtStart, "connecting emitted, so the UI re-rendered");

const lineAfter = mapSyncStatusCopy(after).line;
assert(lineAfter !== lineBefore, "the visible status line changed — the click is observable");
assert(lineAfter === 'Sync Folder "Browser Gallery Sync" chosen — not syncing yet',
  "and it names the folder that was chosen");
assert(mapSyncStatusCopy(after).tone === "active",
  "a chosen-but-not-syncing folder is informational, not success and not failure");

// Changing to a DIFFERENT folder must also be observable — that is the exact
// reported action, and the one a folder-less line could never show.
await sync.connectV3Folder(createVirtualDirectory("Second Sync Folder").handle);
await settle();
const changed = sync.getStatus();
assert(changed.v3FolderName === "Second Sync Folder", "the second folder replaced the first");
const lineChanged = mapSyncStatusCopy(changed).line;
assert(lineChanged !== lineAfter, "changing the Sync Folder changes the visible line");
assert(lineChanged.includes("Second Sync Folder"), "the new folder is what the reader sees");

sync.dispose();
store.closeLocalStateChannel();

// =========================================================================
// 4. NOTHING ABOUT SYNC ITSELF MOVED
// =========================================================================

// Three genuine picker call sites, unchanged: the Media Folder picker, the
// V1/V2 sync folder, and this one. No second setup mechanism was introduced.
const pickerCalls = (main.match(/await window\.showDirectoryPicker\(/g) || []).length;
assert(pickerCalls === 3, `no new folder-picking entry point was created (found ${pickerCalls})`);
assert((html.match(/id="profile-sync-v3-choose-btn"/g) || []).length === 1,
  "there is still exactly one Sync Folder chooser");
assert(main.includes('profileSyncV3ReconnectBtn.addEventListener("click", () => profileSync.reconnectV3());'),
  "Reconnect still reuses the remembered handle and never opens a picker");
const syncSource = fs.readFileSync(path.join(ROOT, "src/profile/profile-sync.js"), "utf8");
assert(syncSource.includes("async connectV3Folder(dirHandle) {") && syncSource.includes("await saveV3SyncConnection(dirHandle);"),
  "connectV3Folder and its persistence are unchanged");
assert(syncSource.includes("if (this.#mode === ACTIVATION_V3) {"),
  "connecting still refuses to overwrite a running V1/V2 status line");

console.log(`Change Sync Folder: ${assertions} assertions passed`);
