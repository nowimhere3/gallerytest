import fs from "node:fs";
import { installFakeIndexedDB } from "./lib/browser-test-env.mjs";
import {
  PROFILE_SYNC_INTRO_STEPS,
  createContextualFirstUseState,
  describeContextualFirstUseActions,
  transitionContextualFirstUse,
} from "../src/profile/contextual-first-use.js";

const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const main = fs.readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
const css = fs.readFileSync(new URL("../styles.css", import.meta.url), "utf8");
let assertions = 0;

function assert(condition, label) {
  if (!condition) throw new Error(label);
  assertions += 1;
}

function transition(state, type, extra = {}) {
  return transitionContextualFirstUse(state, { type, ...extra });
}

let state = createContextualFirstUseState();
assert(state.seen === false && state.visible === false, "default introduction state is unseen and hidden");
state = transition(state, "enter-profile-sync", { intentional: false }).state;
assert(state.visible === false && state.seen === false, "passive entry/render does not show or consume introduction");
state = transition(state, "enter-profile-sync", { intentional: true }).state;
assert(state.visible === true && state.stepIndex === 0, "first intentional Curations & Sync entry shows step one");
state = transition(state, "next").state;
assert(state.stepIndex === 1, "Next advances one step");
state = transition(state, "back").state;
assert(state.stepIndex === 0, "Back returns one step");
let outcome = transition(state, "skip");
assert(outcome.state.seen && !outcome.state.visible && outcome.effect === "persist-seen", "Skip marks first use seen");
assert(!transition(outcome.state, "enter-profile-sync", { intentional: true }).state.visible,
  "later intentional entry stays quiet after seen");

state = createContextualFirstUseState();
state = transition(state, "enter-profile-sync", { intentional: true }).state;
for (let index = 1; index < PROFILE_SYNC_INTRO_STEPS.length; index += 1) state = transition(state, "next").state;
outcome = transition(state, "done");
assert(outcome.state.seen && !outcome.state.visible && outcome.effect === "persist-seen", "Done marks first use seen");
outcome = transition(outcome.state, "replay");
assert(outcome.state.visible && outcome.state.stepIndex === 0 && outcome.state.seen && outcome.state.replay,
  "Replay opens at step one without resetting seen");
outcome = transition(outcome.state, "skip");
assert(outcome.effect === null && outcome.state.seen, "closing replay leaves the seen preference unchanged");
assert(createContextualFirstUseState().seen === false, "another device-local state can remain unseen");

assert(PROFILE_SYNC_INTRO_STEPS.length === 5, "introduction contains exactly five steps");
const helpConcepts = new Set([...html.matchAll(/data-help-concept="([^"]+)"/g)].map((match) => match[1]));
for (const step of PROFILE_SYNC_INTRO_STEPS) {
  assert(step.concepts.every((concept) => helpConcepts.has(concept)), `${step.id} is tied to canonical Help concepts`);
}
assert(PROFILE_SYNC_INTRO_STEPS[0].body.includes("Media Folder") && PROFILE_SYNC_INTRO_STEPS[0].body.includes("does not upload, move or copy"),
  "step one identifies the Media Folder and gives explicit safety reassurance");
assert(PROFILE_SYNC_INTRO_STEPS[0].body.startsWith("Browser Gallery opens your photos and videos"),
  "step one has not introduced Sync yet, so Browser Gallery is the actor");
assert(!PROFILE_SYNC_INTRO_STEPS[0].body.includes("Sync does not"),
  "step one never names Sync before step five introduces it");

// Step 2 teaches the familiar ACTIONS before it names the new noun.
const curation = PROFILE_SYNC_INTRO_STEPS[1];
assert(curation.title === "Your Curation", "step two is titled Your Curation");
assert(curation.body.indexOf("mark Favorites, hide items and add Tags") < curation.body.indexOf("is a Curation"),
  "step two teaches the actions first and the noun second");
assert(!curation.body.includes("unique set"), "step two drops the meaningless 'unique set'");
// A Curation is not merely an alternate arrangement of one fixed collection.
assert(curation.body.includes("Create different Curations for different people, purposes, or ways of organizing your media."),
  "step two explains why more than one Curation exists, without tying one to a single collection");
assert(!/organize the same photos and videos/.test(curation.body),
  "the narrower same-collection framing is retired");

// [SYNCV3 / STAGE-10 / MEDIA-LIBRARY-SELECTION]
// Step 3 is the card three rounds of usability testing failed on. It must
// answer all five questions, so all five are pinned individually.
const library = PROFILE_SYNC_INTRO_STEPS[2];
assert(library.title === "Your Media Library", "step three keeps its heading");
assert(library.body.startsWith("Have the same collection of photos and videos in different Media Folders across your devices?"),
  "step three describes the reader's existing situation across devices rather than instructing them to keep duplicates");
assert(!library.body.startsWith("Keep "), "'Keep' could read as an instruction to maintain copies");
assert(library.body.includes("Browser Gallery doesn't automatically know those folders are the same collection"),
  "WHY: the reader learns why Browser Gallery cannot just work it out");
assert(library.body.includes("Choosing the same Media Library is how you tell it"),
  "WHEN: choosing the same one is the answer to that problem");
assert(library.body.includes("A Media Library is Browser Gallery's name for that collection"),
  "WHAT: a name, not another folder");
assert(library.body.includes("which Favorites, Hidden items and Tags belong with those photos and videos"),
  "WHY THE READER CARES: their organization stays with the right media");
assert(library.body.includes("Different collections use different Media Libraries"),
  "the same-collection rule is taught in BOTH directions");
assert(library.body.includes("Nothing is copied, moved or uploaded"),
  "WHAT IT DOES NOT DO is stated explicitly");
assert(!/\bmatching\b/i.test(library.body), "step three never says 'matching' without defining it");
assert(!/\bexact same photos\b/i.test(library.body),
  "step three never demands file-for-file equality between Media Folders");

const libraryCuration = PROFILE_SYNC_INTRO_STEPS[3];
assert(libraryCuration.title === "Choose the Curation for This Media Library",
  "step four names both nouns instead of leaning on a pronoun");
// The Media Library remembers WHICH Curation to use. The Curation itself stays
// a reusable saved organization — it is not owned by one collection.
assert(libraryCuration.body.includes("Choose the Curation you want this Media Library to use."),
  "step four makes the Media Library the thing doing the using");
assert(libraryCuration.body.includes("Browser Gallery will remember that choice"),
  "step four says the CHOICE is what is remembered");
assert(libraryCuration.body.includes("which Favorites, Hidden items and Tags to use when you open this Media Library"),
  "step four keeps the concrete consequence");
assert(!/belongs? to this collection/i.test(libraryCuration.body)
  && !/remember for this collection/i.test(libraryCuration.body),
  "step four never implies the Curation itself belongs only to this collection");
// Stage 09 is frozen: onboarding must not promise an automatic switch anywhere.
assert(!/\bautomatically\b/i.test(libraryCuration.body) && !/\beverywhere\b/i.test(libraryCuration.body)
  && !/\balways asks\b/i.test(libraryCuration.body),
  "step four never overpromises an automatic or universal Curation switch");

const sync = PROFILE_SYNC_INTRO_STEPS[4];
assert(sync.body.includes("connect each device you want to use to the same Google Drive Sync Folder"),
  "step five scales past two devices");
assert(sync.body.includes("stores Browser Gallery information only")
  && sync.body.includes("separate from a Google Drive Media Folder"),
  "step five distinguishes the two Google Drive roles");
assert(sync.body.includes("may ask before changing which Curation a device is using"),
  "step five states Stage 09 consent without promising it always asks");

// Multi-device copy rule: general product concepts must scale to many devices.
const introCopy = PROFILE_SYNC_INTRO_STEPS.map((step) => `${step.title} ${step.body}`).join(" ");
assert(!/\bboth devices\b/i.test(introCopy) && !/\bboth folders\b/i.test(introCopy)
  && !/\bboth Media Folders\b/i.test(introCopy),
  "onboarding avoids pairwise device language");
assert(!/\b(link|linked|linking|unlink|shared)\b/i.test(introCopy),
  "onboarding carries no retired link/shared vocabulary");

assert((html.match(/id="profile-sync-intro"/g) || []).length === 1, "introduction exists exactly once");
assert((html.match(/id="profile-sync-intro-replay"/g) || []).length === 1, "Replay action exists exactly once");
assert((html.match(/id="profile-sync-help"/g) || []).length === 1, "Persistent Help remains exactly once");
assert(/<section id="profile-sync-intro"[^>]*class="[^"]*hidden/.test(html), "introduction is hidden by default");
for (const control of ["back", "next", "done", "skip", "close"]) {
  assert((html.match(new RegExp(`id="profile-sync-intro-${control}"`, "g")) || []).length === 1,
    `${control} control exists exactly once`);
}
assert(!/YOUR SETUP/i.test(html), "rejected Your Setup block does not exist");
const actionsStart = html.indexOf('class="profile-sync-intro-actions"');
const actionMarkup = html.slice(actionsStart, html.indexOf("</div>", actionsStart));
assert(actionMarkup.indexOf('profile-sync-intro-back') < actionMarkup.indexOf('profile-sync-intro-skip')
  && actionMarkup.indexOf('profile-sync-intro-skip') < actionMarkup.indexOf('profile-sync-intro-next')
  && actionMarkup.indexOf('profile-sync-intro-next') < actionMarkup.indexOf('profile-sync-intro-done'),
  "DOM order keeps the forward action rightmost");
assert(html.includes('id="profile-sync-intro-skip" class="secondary" type="button">Skip Intro</button>'),
  "Skip Intro is unambiguous");
// [SYNCV3 / STAGE-10 / FINAL-UX-POLISH]
// The approved action pattern, proved against the pure model that main.js now
// renders rather than against the shape of a class toggle.
const lastStep = PROFILE_SYNC_INTRO_STEPS.length - 1;
function actionsAt(stepIndex) {
  return describeContextualFirstUseActions({ visible: true, stepIndex, seen: false, replay: false });
}
const first = actionsAt(0);
assert(!first.back && first.skip && first.next && !first.done,
  "step one offers Skip Intro and Next only");
for (let index = 1; index < lastStep; index += 1) {
  const middle = actionsAt(index);
  assert(middle.back && middle.skip && middle.next && !middle.done,
    `step ${index + 1} offers Back, Skip Intro and Next`);
}
const final = actionsAt(lastStep);
assert(final.back && !final.skip && !final.next && final.done,
  "the final step drops Skip Intro and Next, leaving Back and Done");
for (let index = 0; index <= lastStep; index += 1) {
  const actions = actionsAt(index);
  assert(Number(actions.next) + Number(actions.done) === 1,
    `step ${index + 1} offers exactly one forward action`);
}
assert(main.includes("const actions = describeContextualFirstUseActions(profileSyncIntroState);"),
  "the rendered buttons come from that same model");
for (const [control, key] of [["back", "back"], ["skip", "skip"], ["next", "next"], ["done", "done"]]) {
  assert(main.includes(`profileSyncIntro${control[0].toUpperCase()}${control.slice(1)}.classList.toggle("hidden", !actions.${key});`),
    `${control} visibility is applied straight from the model`);
}
// Next and Done share one visual forward position; Back and Skip Intro do not
// claim it, so the forward action is farthest right on every step.
assert(/#profile-sync-intro-next,\s*\n#profile-sync-intro-done \{\s*\n\s*margin-left: auto;/.test(css),
  "Next and Done occupy the same rightmost forward position");
assert(!/#profile-sync-intro-back \{[^}]*margin-left: auto/.test(css)
  && !/#profile-sync-intro-skip \{[^}]*margin-left: auto/.test(css),
  "Back and Skip Intro never take the forward position");
// [SYNCV3 / STAGE-10 / REPLAY-CLOSE]
// First run was not asked for, so it may be skipped. Replay WAS asked for, so
// offering to skip it is backwards; replay gets an ordinary Close instead.
function replayActionsAt(stepIndex) {
  return describeContextualFirstUseActions({ visible: true, stepIndex, seen: true, replay: true });
}
for (let index = 0; index <= lastStep; index += 1) {
  const replayActions = replayActionsAt(index);
  assert(!replayActions.skip, `replay step ${index + 1} never offers Skip Intro`);
  assert(replayActions.close, `replay step ${index + 1} offers Close`);
  assert(Number(replayActions.next) + Number(replayActions.done) === 1,
    `replay step ${index + 1} keeps exactly one forward action`);
  const firstRun = actionsAt(index);
  assert(!firstRun.close, `first-run step ${index + 1} shows no Close`);
  assert(firstRun.back === replayActions.back, `replay step ${index + 1} keeps normal Back navigation`);
}
assert(main.includes('profileSyncIntroClose.classList.toggle("hidden", !actions.close);'),
  "the Close control is driven by that same model");
assert(html.includes('id="profile-sync-intro-close"') && /id="profile-sync-intro-close"[\s\S]{0,200}?aria-label="Close introduction"/.test(html),
  "the Close affordance carries an accessible name");
assert(!/profile-sync-intro-close[\s\S]{0,400}?confirm/i.test(main), "closing a replay asks for no confirmation");

// Close must never write seen:false, and must never persist on a device that
// has already seen the introduction.
let replaySession = transition(createContextualFirstUseState({ seen: true }), "replay").state;
replaySession = transition(replaySession, "next").state;
const closed = transition(replaySession, "close");
assert(closed.state.visible === false && closed.state.seen === true && closed.effect === null,
  "Close hides the replay, keeps seen true and persists nothing");
assert(closed.state.replay === false, "Close leaves replay mode");

assert(main.includes('setActiveWorkspace("gallery");'), "passive boot keeps an unflagged Gallery initialization");
assert(main.includes('intentionalProfileSync: entry.name === "settings"'), "Settings activation marks intentional Curations & Sync entry");
// The approved step-four wording used "associates with this collection".
// "association" is on the retired-jargon list, and Help already teaches the
// same idea with "remembers for", so onboarding uses that verb instead.
assert(!/associat/i.test(introCopy), "introduction uses approved user-facing vocabulary");
assert(libraryCuration.body.includes("will remember that choice"),
  "step four states the remembered relationship in the product's own verb");

installFakeIndexedDB();
const Preferences = await import("../src/storage/app-preferences.js");
let preferences = await Preferences.loadPreferences();
assert(preferences.onboarding.profileSyncIntroSeen === false, "stored preference defaults to unseen");
await Preferences.saveOnboardingPreferences({ profileSyncIntroSeen: true });
preferences = await Preferences.loadPreferences();
assert(preferences.onboarding.profileSyncIntroSeen === true, "seen survives a true database reopen");

// [SYNCV3 / STAGE-10 / FINAL-UX-POLISH]
// A hard refresh reloads the page; it does not clear IndexedDB. So the state a
// reloaded tab boots with is a fresh in-memory model seeded from the SAME saved
// preference — which is exactly why an already-seen device stays quiet, and why
// the absence of the introduction after Ctrl+Shift+R is the contract working.
let reloaded = createContextualFirstUseState({ seen: preferences.onboarding.profileSyncIntroSeen });
assert(reloaded.seen === true && reloaded.visible === false,
  "a reload rehydrates seen from the surviving preference and shows nothing");
assert(!transition(reloaded, "enter-profile-sync", { intentional: true }).state.visible,
  "an intentional entry after a hard refresh stays quiet on a seen device");
const replayed = transition(reloaded, "replay");
assert(replayed.state.visible && replayed.state.stepIndex === 0 && replayed.effect === null,
  "Replay Introduction still opens it on that same reloaded, seen device");
assert(transition(replayed.state, "done").state.seen === true,
  "closing that replay leaves the device seen, so nothing auto-opens later");

installFakeIndexedDB();
preferences = await Preferences.loadPreferences();
assert(preferences.onboarding.profileSyncIntroSeen === false, "another device-local preference context remains unseen");
reloaded = createContextualFirstUseState({ seen: preferences.onboarding.profileSyncIntroSeen });
assert(transition(reloaded, "enter-profile-sync", { intentional: true }).state.visible,
  "a genuinely fresh local preference context still gets the introduction");

console.log(`Contextual Curations & Sync first use: ${assertions} assertions passed`);
