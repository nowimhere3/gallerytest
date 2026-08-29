#!/usr/bin/env node
// [PM-SHUFFLE-FOLDERS]
// [WHY: 🎲 Shuffle Folders is an IMMEDIATE RUNTIME ACTION living inside the
//  ⚡ Automations shelf — a shelf whose whole point until now was ongoing
//  automations. That adjacency is the risk this file exists to pin down:
//  every plausible regression here is a one-shot action quietly acquiring
//  automation-shaped state (⚡ starting to think a shuffle is "active", so
//  its protected one-click stop stops the wrong thing), or the action
//  reaching for a shortcut instead of the paths Browser Gallery already
//  trusts (its own folder list, its own loader, its own permission model) —
//  a duplicated scan, a folder picker the customer never asked for, or a
//  startup policy rewritten as a side effect of a die roll.
//
//  The RULE half (which folders are candidates, in what order, and that the
//  current one is never re-offered) is proven for real against
//  src/runtime/folder-shuffle.js, which is pure and takes an injected
//  `random`. The WIRING half lives in src/main.js, which captures ~240 DOM
//  nodes at parse time and cannot be imported in Node — so it is proven the
//  way test-pm-toolbar-opacity.mjs already proves its own wiring: by
//  extracting the exact function bodies and asserting on what they do and,
//  just as importantly, what they never mention.]
//
// Usage:  node tools/test-pm-shuffle-folders.mjs

import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const src = (rel) => pathToFileURL(path.join(ROOT, "src", rel)).href;

let failures = 0;
let passes = 0;

function assert(condition, label, detail) {
  if (condition) {
    passes++;
    return true;
  }
  failures++;
  console.log(`  FAIL  ${label}`);
  if (detail) console.log(`        ${detail}`);
  return false;
}

function assertEqual(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  return assert(
    ok,
    label,
    ok ? null : `expected: ${JSON.stringify(expected)}\n        actual:   ${JSON.stringify(actual)}`
  );
}

const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const css = fs.readFileSync(path.join(ROOT, "styles.css"), "utf8");
const mainJs = fs.readFileSync(path.join(ROOT, "src", "main.js"), "utf8");

const { orderShuffleFolderCandidates } = await import(src("runtime/folder-shuffle.js"));

// Extracts one function's source by name, brace-matching from its opening `{`
// so an assertion about "this function never mentions X" is scoped to that
// function rather than to the whole 9000-line file.
function functionBody(source, name) {
  const signature = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const match = signature.exec(source);
  if (!match) return null;
  const open = source.indexOf("{", match.index);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(match.index, i + 1);
    }
  }
  return null;
}

// Strips comments so a "this function never reaches for X" assertion tests
// what the function DOES, not what its breadcrumbs explain it deliberately
// avoids — this codebase comments heavily, and naming the path you are not
// taking is exactly how these functions are documented.
function withoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

// The executable half of a named function in src/main.js.
function functionCode(source, name) {
  const body = functionBody(source, name);
  return body === null ? null : withoutComments(body);
}

// A deterministic `random` so an ORDER, not just a membership set, can be
// asserted. Cycles through the supplied samples.
function scriptedRandom(samples) {
  let i = 0;
  return () => samples[i++ % samples.length];
}

const handle = (name) => ({ name, queryPermission: async () => "granted" });
const library = (id, extra = {}) => ({ id, name: id, handle: handle(id), ...extra });

// ---- 1. 🎲 exists inside the EXISTING PM Automations shelf ----------------

console.log("\n1. 🎲 lives inside the existing #pm-automations-group shelf");
{
  const open = html.indexOf('<div id="pm-automations-group"');
  const close = html.indexOf("</div>", open);
  assert(open !== -1 && close !== -1, "#pm-automations-group located in index.html");
  const shelf = html.slice(open, close);

  assert(shelf.includes('id="overlay-shuffle-folders-btn"'), "#overlay-shuffle-folders-btn is a child of the existing shelf");
  assert(shelf.includes(">🎲<"), "the shelf control is the 🎲 glyph");

  // The shelf it joined must still be the SAME shelf — same id, still opened
  // by the same ⚡ button. A "shuffle shelf" of its own would be exactly the
  // ⚡-system redesign this slice was told not to do.
  assert(
    (html.match(/id="pm-automations-group"/g) || []).length === 1,
    "there is exactly one Automations shelf — no second/duplicate shelf was introduced"
  );
  assert(
    html.includes('aria-controls="pm-automations-group"'),
    "⚡ (#overlay-automations-menu-btn) still controls that same shelf"
  );
  // Its established residents are untouched.
  assert(shelf.includes('id="video-loop-control"'), "the existing Loop toggle is still in the shelf");
  assert(shelf.includes('id="overlay-automation-btn"'), "the existing 🤖 Loop Automations button is still in the shelf");
}

// ---- 2. accessible name / tooltip is exactly "Shuffle Folders" ------------

console.log('\n2. the accessible name and tooltip are exactly "Shuffle Folders"');
{
  const button = /<button id="overlay-shuffle-folders-btn"[^>]*>/.exec(html);
  assert(Boolean(button), "#overlay-shuffle-folders-btn markup located");
  const tag = button ? button[0] : "";
  assert(tag.includes('aria-label="Shuffle Folders"'), 'aria-label="Shuffle Folders"');
  assert(tag.includes('title="Shuffle Folders"'), 'title="Shuffle Folders"');
  assert(tag.includes('type="button"'), 'type="button" — never submits anything');

  // No explanatory paragraph was added beside it; the shelf's only <p> is
  // the pre-existing photo empty state.
  const open = html.indexOf('<div id="pm-automations-group"');
  const shelf = html.slice(open, html.indexOf("</div>", open));
  const paragraphs = (shelf.match(/<p /g) || []).length;
  assertEqual(paragraphs, 1, "no explanatory paragraph added to PM — the shelf still has only the pre-existing empty-state <p>");
}

// ---- 3. the authoritative remembered-folder collection is what is used ----

console.log("\n3. the action reads the authoritative remembered-folder collection");
{
  const body = functionCode(mainJs, "shuffleToAnotherRememberedFolder");
  assert(Boolean(body), "shuffleToAnotherRememberedFolder() located in src/main.js");

  assert(body.includes("await listLibraries()"), "reads library-registry.js's listLibraries() — the authoritative remembered-folder source");
  assert(
    mainJs.includes("listLibraries,") && mainJs.includes('from "./storage/library-registry.js"'),
    "listLibraries is imported from the one registry module, not re-implemented"
  );
  // No private folder store, cache, or parallel list of its own.
  assert(
    !/indexedDB|localStorage|openDatabase/.test(body),
    "the action opens no storage of its own — no duplicate folder-storage machinery"
  );
  const shuffleModule = withoutComments(fs.readFileSync(path.join(ROOT, "src", "runtime", "folder-shuffle.js"), "utf8"));
  assert(
    !/indexedDB|localStorage|import\s/.test(shuffleModule),
    "src/runtime/folder-shuffle.js is pure — it owns no storage and imports nothing"
  );
}

// ---- 4. the current folder is excluded from the candidates ----------------

console.log("\n4. with [A, B, C] and A current, A is excluded from the random candidates");
{
  const libraries = [library("A"), library("B"), library("C")];

  // Every scripted random, not just a convenient one: A must never appear
  // regardless of which permutation Fisher-Yates lands on.
  for (const samples of [[0], [0.5], [0.99], [0, 0.99], [0.75, 0.2, 0.9]]) {
    const ordered = orderShuffleFolderCandidates({
      libraries,
      currentLibraryId: "A",
      random: scriptedRandom(samples),
    });
    assertEqual(ordered.map((row) => row.id).sort(), ["B", "C"], `candidates are exactly B and C (random samples ${JSON.stringify(samples)})`);
  }

  // ...and both alternatives are genuinely reachable — "excludes A" would
  // also be satisfied by a broken function that always returned B.
  const heads = new Set();
  for (const samples of [[0], [0.99]]) {
    heads.add(orderShuffleFolderCandidates({ libraries, currentLibraryId: "A", random: scriptedRandom(samples) })[0].id);
  }
  assertEqual([...heads].sort(), ["B", "C"], "the selection is genuinely random — both B and C can be chosen first");

  // With no folder loaded at all, nothing is excluded.
  const none = orderShuffleFolderCandidates({ libraries, currentLibraryId: null, random: scriptedRandom([0]) });
  assertEqual(none.length, 3, "with no current folder, every remembered folder is a candidate");
}

// ---- 5. only the current folder usable → safely does nothing --------------

console.log("\n5. with only the current folder A remembered, the action safely does nothing");
{
  const ordered = orderShuffleFolderCandidates({
    libraries: [library("A")],
    currentLibraryId: "A",
    random: scriptedRandom([0]),
  });
  assertEqual(ordered, [], "no candidates — A is never re-offered as a fallback to itself");

  // An empty candidate list must reach no loader and no error path: the loop
  // body simply never runs, and the function returns having done nothing.
  const body = functionCode(mainJs, "shuffleToAnotherRememberedFolder");
  assert(
    /for\s*\(const candidate of candidates\)/.test(body),
    "the action iterates the candidate list — an empty list therefore performs no switch at all"
  );
  assert(
    !/\balert\s*\(|showModal|throw new Error/.test(body),
    "nothing to shuffle to raises no modal, alert, or thrown error — it fails gracefully"
  );
  assertEqual(orderShuffleFolderCandidates({ libraries: [], currentLibraryId: null }), [], "no remembered folders at all yields no candidates");
  assertEqual(orderShuffleFolderCandidates(), [], "called with no arguments at all, yields no candidates rather than throwing");
}

// ---- 6. unusable remembered candidates are skipped ------------------------

console.log("\n6. unusable remembered candidates are skipped, and another is tried");
{
  // Cheap half: a record with no reusable handle could only be "opened" via a
  // picker, so it is never a candidate.
  const ordered = orderShuffleFolderCandidates({
    libraries: [library("A"), { id: "B", name: "B" }, library("C"), { name: "D", handle: handle("D") }],
    currentLibraryId: "A",
    random: scriptedRandom([0]),
  });
  assertEqual(ordered.map((row) => row.id), ["C"], "a remembered row with no handle (B) and one with no id (D) are not candidates");

  // Live half: permission is QUERIED, never requested, and a failure skips.
  const check = functionCode(mainJs, "canShuffleToRememberedFolder");
  assert(Boolean(check), "canShuffleToRememberedFolder() located in src/main.js");
  assert(check.includes('queryPermission({ mode: "read" })'), "usability is decided by queryPermission() — the existing permission/access model");
  assert(!check.includes("requestPermission"), "canShuffleToRememberedFolder() never calls requestPermission() — no unsolicited permission ceremony");
  assert(/catch\s*\([^)]*\)\s*{[^}]*return false/.test(check), "a handle that throws when checked is skipped (returns false), not propagated");
  assert(
    !check.includes("removeFromRecents"),
    "a skipped candidate is NOT pruned from the customer's remembered folders — a die roll must not edit their list"
  );

  const body = functionCode(mainJs, "shuffleToAnotherRememberedFolder");
  assert(
    /if\s*\(!\(await canShuffleToRememberedFolder\(candidate\)\)\)\s*continue;/.test(body),
    "an unusable candidate is `continue`d past so the next candidate is tried"
  );
}

// ---- 7. no folder picker is ever invoked by 🎲 ----------------------------

console.log("\n7. 🎲 never opens a folder picker");
{
  const body = functionCode(mainJs, "shuffleToAnotherRememberedFolder");
  const check = functionCode(mainJs, "canShuffleToRememberedFolder");
  const shuffleModule = withoutComments(fs.readFileSync(path.join(ROOT, "src", "runtime", "folder-shuffle.js"), "utf8"));

  for (const [label, source] of [
    ["shuffleToAnotherRememberedFolder()", body],
    ["canShuffleToRememberedFolder()", check],
    ["src/runtime/folder-shuffle.js", shuffleModule],
  ]) {
    assert(!source.includes("showDirectoryPicker"), `${label} never calls window.showDirectoryPicker()`);
    assert(!source.includes("addOrUpdateLibrary"), `${label} never registers a newly-picked folder`);
    assert(!/\.click\(\)|fsaChooseFolderBtn/.test(source), `${label} never drives the "Choose Folder (FSA)" control`);
  }
}

// ---- 8. startup policy / preferences are not mutated ----------------------

console.log("\n8. no startup policy or preference is written as a side effect");
{
  const body = functionCode(mainJs, "shuffleToAnotherRememberedFolder");
  const check = functionCode(mainJs, "canShuffleToRememberedFolder");
  const shuffleModule = withoutComments(fs.readFileSync(path.join(ROOT, "src", "runtime", "folder-shuffle.js"), "utf8"));

  const forbidden = [
    "saveStartupPreferences",
    "savePresentationPreferences",
    "savePlaybackPreferences",
    "saveOnboardingPreferences",
    "saveMicroArcadePreferences",
    "eligibleLibraryIds",
    "autoFillPanel",
    "startup.browser",
    "startup.streamloop",
  ];
  for (const [label, source] of [
    ["shuffleToAnotherRememberedFolder()", body],
    ["canShuffleToRememberedFolder()", check],
    ["src/runtime/folder-shuffle.js", shuffleModule],
  ]) {
    for (const token of forbidden) {
      assert(!source.includes(token), `${label} never touches ${token}`);
    }
  }

  // 🎲 also switches folders WITHOUT claiming a StreamLoop/Auto Fill role.
  assert(!body.includes("streamloop") && !body.includes("StreamLoop"), "the action does not reach into the StreamLoop bridge");
}

// ---- 9. the canonical folder-loading pathway is reused --------------------

console.log("\n9. the existing authoritative remembered-folder loading path is reused");
{
  const body = functionCode(mainJs, "shuffleToAnotherRememberedFolder");

  assert(body.includes("await resumeLibrary(candidate)"), "loads through resumeLibrary() — the same path a Recent Media Folders click uses");
  assert(
    /async function resumeLibrary\(record\)[\s\S]{0,3000}?await loadFromFsaHandle\(dirHandle, record\)/.test(mainJs),
    "resumeLibrary() still reaches the canonical loadFromFsaHandle() loader"
  );

  // Nothing about scanning, projection, FSA traversal, profile association or
  // startup media is re-implemented in the action.
  for (const token of [
    "loadFromDirectoryHandle",
    "finishLoadingItems",
    "beginMediaIdentityForLoad",
    "recordLibraryLoaded",
    "restoreProfileForLoadedLibrary",
    "decideStartupMedia",
    "touchLibrary",
    "reloadRuntime",
    "runtime.load",
  ]) {
    assert(!body.includes(token), `the action does not duplicate ${token} — the loader owns it`);
  }
}

// ---- 10. the action waits for authoritative media-load completion ---------

console.log("\n10. the switch is awaited to the authoritative MEDIA LOADED boundary");
{
  const body = functionCode(mainJs, "shuffleToAnotherRememberedFolder");

  assert(/await resumeLibrary\(candidate\);/.test(body), "resumeLibrary() is awaited, not fire-and-forget");
  assert(/async function shuffleToAnotherRememberedFolder/.test(mainJs), "the action is async so it can await that completion");

  // Presentation Mode is restored strictly AFTER that await — restoring it
  // earlier would put the customer back in front of the outgoing media set.
  const awaitAt = body.indexOf("await resumeLibrary(candidate)");
  const enterAt = body.indexOf("enterFillMode()");
  assert(awaitAt !== -1 && enterAt !== -1 && awaitAt < enterAt, "Presentation Mode is re-entered only after the load has completed");

  // The loader itself still reaches its own full-load completion seam.
  assert(
    /finishLoadingItems\(result\.items\)/.test(mainJs),
    "loadFromFsaHandle() still completes through finishLoadingItems() — the full-load seam, not a partial render"
  );

  // A second click cannot land mid-switch and be silently swallowed by the
  // loader's own isLoadingFiles guard.
  assert(/if\s*\(isShufflingFolders \|\| isLoadingFiles\)\s*return;/.test(body), "re-entry is guarded while a switch is in flight");
  assert(/finally\s*{[\s\S]*isShufflingFolders = false;/.test(body), "the guard is always released, including on an early return or a throw");
}

// ---- 11. 🎲 establishes no continuing "active automation" state -----------

console.log('\n11. 🎲 never establishes a continuing "active automation" state');
{
  const body = functionCode(mainJs, "shuffleToAnotherRememberedFolder");
  const check = functionCode(mainJs, "canShuffleToRememberedFolder");

  // ⚡'s active state is derived from videoLoopInput.checked and nothing
  // else; the action must never write it, nor the loop-rule engine state,
  // nor invent an indicator of its own.
  for (const [label, source] of [
    ["shuffleToAnotherRememberedFolder()", body],
    ["canShuffleToRememberedFolder()", check],
  ]) {
    for (const token of [
      "videoLoopInput",
      "activeLoopRule",
      "syncVideoLoopControl",
      "syncAutomationsActiveIndicator",
      "is-automation-active",
      "loopRuleTimerId",
      "setInterval",
      "setTimeout",
    ]) {
      assert(!source.includes(token), `${label} never touches ${token}`);
    }
  }

  // No separate Stop state was created for it.
  assert(!html.includes("Stop Shuffle") && !html.includes("stop-shuffle"), "no Stop control was added for the one-shot action");
  assert(!mainJs.includes("isShuffleAutomationActive"), "no persistent shuffle-active flag exists");

  // The click handler does exactly one thing.
  const listener = /overlayShuffleFoldersBtn\.addEventListener\("click",[\s\S]{0,240}?\}\);/.exec(mainJs);
  assert(Boolean(listener), "the 🎲 click listener is registered");
  assert(
    listener && listener[0].includes("shuffleToAnotherRememberedFolder()"),
    "the click runs the one-shot action"
  );
  assert(
    listener && !listener[0].includes("closeAutomationsTray"),
    "the click does not close the shelf — repeated ⚡ → 🎲 → 🎲 keeps working from the same open shelf"
  );
}

// ---- 12. ⚡'s existing idle-toggle / active-stop contract is intact -------

console.log("\n12. ⚡'s protected two-state contract is unchanged");
{
  const listener = /overlayAutomationsMenuBtn\.addEventListener\("click",[\s\S]*?\n\}\);/.exec(mainJs);
  assert(Boolean(listener), "⚡'s click listener located");
  const source = listener ? listener[0] : "";

  // Priority order preserved verbatim: active → stop; otherwise → toggle.
  assert(/if \(videoLoopInput\.checked\)/.test(source), "⚡ still branches on videoLoopInput.checked first");
  assert(/stopAllPresentationAutomations\(\);/.test(source), "an active automation is still stopped immediately by one click");
  assert(/toggleAutomationsTray\(\);/.test(source), "the idle case still toggles the shelf");
  const stopAt = source.indexOf("stopAllPresentationAutomations");
  const toggleAt = source.indexOf("toggleAutomationsTray");
  assert(stopAt !== -1 && toggleAt !== -1 && stopAt < toggleAt, "stop still takes priority over the toggle");
  assert(!source.includes("shuffle"), "⚡'s handler knows nothing about 🎲 — the one-shot action is invisible to it");

  // The indicator's single source of truth is untouched.
  const indicator = functionCode(mainJs, "syncAutomationsActiveIndicator");
  assert(Boolean(indicator), "syncAutomationsActiveIndicator() located");
  assert(/const isActive = videoLoopInput\.checked;/.test(indicator), "⚡'s active state is still derived from videoLoopInput.checked alone");
  assert(!indicator.includes("huffle"), "the indicator does not consider shuffle state");

  // The one tray-opening path stayed one path.
  assertEqual((mainJs.match(/function openAutomationsTray\(/g) || []).length, 1, "there is exactly one openAutomationsTray()");
  const toggle = functionCode(mainJs, "toggleAutomationsTray");
  assert(toggle.includes("openAutomationsTray()"), "toggleAutomationsTray() opens through that same single path");
  assert(toggle.includes("closeAutomationsTray()"), "toggleAutomationsTray() still closes through the existing close path");
}

// ---- 13. the existing Loop automation is intact ---------------------------

console.log("\n13. the existing Loop / Loop Automations behavior is intact");
{
  // Loop and 🤖 are still gated to video exactly as before — the shuffle
  // slice changed only the empty state's DERIVATION, not this gating.
  const availability = functionCode(mainJs, "syncAutomationsMediaAvailability");
  assert(Boolean(availability), "syncAutomationsMediaAvailability() located");
  assert(
    availability.includes('videoLoopControl.classList.toggle("hidden", !isVideo)'),
    "Loop is still hidden on a photo, unchanged"
  );
  assert(
    availability.includes('overlayAutomationBtn.classList.toggle("hidden", !isVideo)'),
    "🤖 is still hidden on a photo, unchanged"
  );
  // 🎲 is deliberately NOT media-gated, and the empty state is now derived
  // from real availability rather than asserting "nothing here" beside it.
  assert(
    !/overlayShuffleFoldersBtn\.classList\.toggle\("hidden"/.test(availability),
    "🎲 is not media-gated — switching Media Folders means the same on a photo as on a video"
  );
  assert(
    availability.includes("overlayShuffleFoldersBtn") && availability.includes("anyAvailable"),
    "the photo empty state is derived from what is actually available, so it can never contradict a visible 🎲"
  );

  // The Loop engine's own entry points are untouched.
  assert(mainJs.includes("function stopAllPresentationAutomations()"), "the ⚡ universal stop path still exists");
  assert(mainJs.includes("function applyLoopRuleToCurrentVideo()"), "the Loop rule engine still exists");
  assert(mainJs.includes("function resetLoopRuleToDefault()"), "the Loop rule reset still exists");
  const stop = functionCode(mainJs, "stopAllPresentationAutomations");
  assert(
    /videoLoopInput\.checked = false;\s*syncVideoLoopControl\(\);/.test(stop),
    "the stop path is still exactly the existing Loop-OFF path, with no shuffle step bolted on"
  );
}

// ---- 14. DOM ids stay unique and every reference resolves -----------------

console.log("\n14. DOM ids remain unique and references resolve");
{
  const ids = [...html.matchAll(/\sid\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
  const counts = new Map();
  for (const id of ids) counts.set(id, (counts.get(id) || 0) + 1);
  const duplicates = [...counts].filter(([, n]) => n > 1);
  assertEqual(duplicates, [], "no duplicate ids in index.html");

  assertEqual(counts.get("overlay-shuffle-folders-btn"), 1, "#overlay-shuffle-folders-btn appears exactly once");

  // Every id main.js captures still exists — including the new one.
  const missing = [...mainJs.matchAll(/getElementById\(\s*"([^"]+)"\s*\)/g)]
    .map((m) => m[1])
    .filter((id) => !counts.has(id));
  assertEqual(missing, [], "every getElementById target in src/main.js resolves in index.html");

  assert(
    mainJs.includes('const overlayShuffleFoldersBtn = document.getElementById("overlay-shuffle-folders-btn");'),
    "🎲 is captured as a module-scope const like every other PM control"
  );

  // Styled through the shelf's own visual language, and folded into the
  // shared compact-tier sizing system alongside its sibling controls.
  assert(css.includes(".overlay-btn-shuffle-folders"), "🎲 has a style rule");
  assert(
    (css.match(/\.overlay-btn-shuffle-folders/g) || []).length >= 4,
    "🎲 is included in the responsive --pm-control-size tiers, like its sibling controls"
  );
}

// ---- 15. the FUTURE breadcrumb is recorded, and only as FUTURE ------------

console.log("\n15. the FUTURE scope breadcrumb exists and nothing of it is implemented");
{
  const shuffleModule = fs.readFileSync(path.join(ROOT, "src", "runtime", "folder-shuffle.js"), "utf8");
  assert(
    /FUTURE: PM Shuffle Folders may optionally use a customer-selected/.test(shuffleModule),
    "the FUTURE breadcrumb is recorded in the authoritative selection module"
  );
  assert(
    /The 🎲 control remains the immediate runtime action\./.test(shuffleModule),
    "the breadcrumb states that 🎲 itself stays the immediate runtime action"
  );

  // None of it is built today.
  const body = functionCode(mainJs, "shuffleToAnotherRememberedFolder");
  for (const token of ["shuffleScope", "shuffleEligible", "excludedFolders", "recurrence", "cron"]) {
    assert(!mainJs.includes(token), `no ${token} scope/recurrence machinery was added`);
  }
  assert(!/tags|favorites/i.test(body), "no Tags or Favorites scoping in the action");
}

// ---- summary --------------------------------------------------------------

console.log(`\n${passes} assertion(s) passed, ${failures} failure(s)`);
process.exit(failures ? 1 : 0);
