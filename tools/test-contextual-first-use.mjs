import fs from "node:fs";
import { installFakeIndexedDB } from "./lib/browser-test-env.mjs";
import {
  PROFILE_SYNC_INTRO_STEPS,
  createContextualFirstUseState,
  transitionContextualFirstUse,
} from "../src/profile/contextual-first-use.js";

const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const main = fs.readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
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
assert(state.visible === true && state.stepIndex === 0, "first intentional Profile & Sync entry shows step one");
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
state = transition(state, "next").state;
state = transition(state, "next").state;
outcome = transition(state, "done");
assert(outcome.state.seen && !outcome.state.visible && outcome.effect === "persist-seen", "Done marks first use seen");
outcome = transition(outcome.state, "replay");
assert(outcome.state.visible && outcome.state.stepIndex === 0 && outcome.state.seen && outcome.state.replay,
  "Replay opens at step one without resetting seen");
outcome = transition(outcome.state, "skip");
assert(outcome.effect === null && outcome.state.seen, "closing replay leaves the seen preference unchanged");
assert(createContextualFirstUseState().seen === false, "another device-local state can remain unseen");

assert(PROFILE_SYNC_INTRO_STEPS.length === 3, "introduction contains exactly three steps");
const helpConcepts = new Set([...html.matchAll(/data-help-concept="([^"]+)"/g)].map((match) => match[1]));
for (const step of PROFILE_SYNC_INTRO_STEPS) {
  assert(step.concepts.every((concept) => helpConcepts.has(concept)), `${step.id} is tied to canonical Help concepts`);
}
assert(PROFILE_SYNC_INTRO_STEPS[0].body.includes("does not upload, move or copy"), "media step gives explicit safety reassurance");
assert(PROFILE_SYNC_INTRO_STEPS[1].body.includes("unique set of Favorites, Hidden items and Tags"),
  "Profile step explains unique supported curation");
assert(PROFILE_SYNC_INTRO_STEPS[2].body.includes("Link both folders to the same Library"),
  "final step explains the same-collection link");
assert(PROFILE_SYNC_INTRO_STEPS[2].body.includes("when you choose"),
  "final step does not imply an automatic Profile switch");

assert((html.match(/id="profile-sync-intro"/g) || []).length === 1, "introduction exists exactly once");
assert((html.match(/id="profile-sync-intro-replay"/g) || []).length === 1, "Replay action exists exactly once");
assert((html.match(/id="profile-sync-help"/g) || []).length === 1, "Persistent Help remains exactly once");
assert(/<section id="profile-sync-intro"[^>]*class="[^"]*hidden/.test(html), "introduction is hidden by default");
for (const control of ["back", "next", "done", "skip"]) {
  assert((html.match(new RegExp(`id="profile-sync-intro-${control}"`, "g")) || []).length === 1,
    `${control} control exists exactly once`);
}
assert(!/YOUR SETUP/i.test(html), "rejected Your Setup block does not exist");
assert(main.includes('setActiveWorkspace("gallery");'), "passive boot keeps an unflagged Gallery initialization");
assert(main.includes('intentionalProfileSync: entry.name === "settings"'), "Settings activation marks intentional Profile & Sync entry");
assert(!/associat/i.test(PROFILE_SYNC_INTRO_STEPS.map((step) => `${step.title} ${step.body}`).join(" ")),
  "introduction uses approved user-facing vocabulary");

installFakeIndexedDB();
const Preferences = await import("../src/storage/app-preferences.js");
let preferences = await Preferences.loadPreferences();
assert(preferences.onboarding.profileSyncIntroSeen === false, "stored preference defaults to unseen");
await Preferences.saveOnboardingPreferences({ profileSyncIntroSeen: true });
preferences = await Preferences.loadPreferences();
assert(preferences.onboarding.profileSyncIntroSeen === true, "seen survives a true database reopen");
installFakeIndexedDB();
preferences = await Preferences.loadPreferences();
assert(preferences.onboarding.profileSyncIntroSeen === false, "another device-local preference context remains unseen");

console.log(`Contextual Profile & Sync first use: ${assertions} assertions passed`);
