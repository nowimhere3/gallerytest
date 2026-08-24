import { readFileSync } from "node:fs";
import { installFakeIndexedDB } from "./lib/browser-test-env.mjs";
import {
  ARCADE_ORDER_SEQUENTIAL,
  ARCADE_ORDER_SHUFFLE_LOOP,
  ARCADE_ORDER_TRUE_RANDOM,
  getArcadeAnimationOrderHelper,
  renderArcadeAnimationOrderHelper,
  selectArcadeScene,
} from "../src/runtime/micro-arcade-selector.js";

let assertions = 0;
function assert(condition, label) {
  if (!condition) throw new Error(label);
  assertions += 1;
}

const scenes = ["one", "two", "three"];
let sequentialIndex = 0;
const sequential = () => selectArcadeScene({
  scenes,
  order: ARCADE_ORDER_SEQUENTIAL,
  readIndex: () => sequentialIndex,
  writeIndex: (index) => { sequentialIndex = index; },
}).scene;
assert(sequential() === "one", "Sequential starts at the first scene");
assert(sequential() === "two", "Sequential walks in defined order");
assert(sequential() === "three", "Sequential reaches the final scene");
assert(sequential() === "one", "Sequential wraps to the first scene");

const trueRandom = (sample) => selectArcadeScene({
  scenes,
  order: ARCADE_ORDER_TRUE_RANDOM,
  random: () => sample,
}).scene;
assert(trueRandom(0) === "one", "True Shuffle can select the first scene");
assert(trueRandom(0.5) === "two", "True Shuffle can select a middle scene");
assert(trueRandom(0.999) === "three", "True Shuffle can select the final scene");
assert(trueRandom(0) === trueRandom(0), "True Shuffle allows an immediate repeat");
const memoryless = selectArcadeScene({
  scenes,
  order: ARCADE_ORDER_TRUE_RANDOM,
  previousScene: "one",
  visitedScenes: scenes,
  random: () => 0,
});
assert(memoryless.scene === "one", "True Shuffle ignores previous and exhausted scenes");
assert(memoryless.visitedScenes.length === 0, "True Shuffle retains no exhaustion memory");

let loopVisited = [];
let loopPrevious = null;
const loopPick = (sample) => {
  const result = selectArcadeScene({
    scenes,
    order: ARCADE_ORDER_SHUFFLE_LOOP,
    previousScene: loopPrevious,
    visitedScenes: loopVisited,
    random: () => sample,
  });
  loopPrevious = result.scene;
  loopVisited = result.visitedScenes;
  return result.scene;
};
const firstCycle = [loopPick(0), loopPick(0), loopPick(0)];
assert(new Set(firstCycle).size === scenes.length, "Shuffle Loop uses every scene once per cycle");
assert(firstCycle[0] !== firstCycle[1] && firstCycle[1] !== firstCycle[2], "Shuffle Loop has no cycle repeat");
const priorCycleLast = firstCycle.at(-1);
const nextCycleFirst = loopPick(0);
assert(loopVisited.length === 1, "Shuffle Loop starts a fresh cycle after exhaustion");
assert(nextCycleFirst !== priorCycleLast, "A new cycle does not immediately repeat the prior cycle's last scene");

const helper = { textContent: "" };
const helperCases = [
  [ARCADE_ORDER_SEQUENTIAL, "Plays the arcade scenes in order."],
  [ARCADE_ORDER_TRUE_RANDOM, "Every loading animation is picked randomly. Repeats can happen."],
  [ARCADE_ORDER_SHUFFLE_LOOP, "Plays every arcade scene once in random order before reshuffling."],
];
for (const [order, copy] of helperCases) {
  assert(getArcadeAnimationOrderHelper(order) === copy, `${order} helper copy matches`);
  renderArcadeAnimationOrderHelper(helper, order);
  assert(helper.textContent === copy, `${order} selection immediately updates the helper`);
}

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
assert((html.match(/>Arcade animations</g) || []).length === 1, "UI has one Arcade animations heading");
assert(!html.includes('<h3 class="profile-sync-heading">Playback</h3>'), "Advanced Settings has no Playback heading");
const orderSelectMarkup = html.match(/<select id="arcade-animation-order-select"[\s\S]*?<\/select>/)?.[0] || "";
const optionValues = [...orderSelectMarkup.matchAll(/<option value="([^"]+)">/g)].map((match) => match[1]);
assert(
  JSON.stringify(optionValues) === JSON.stringify(["sequential", "true-random", "shuffle-loop"]),
  "Animation order dropdown has exactly the three modes in product order",
);

installFakeIndexedDB();
const Preferences = await import("../src/storage/app-preferences.js");
let preferences = await Preferences.loadPreferences();
assert(preferences.microArcade.animationOrder === ARCADE_ORDER_TRUE_RANDOM, "Animation order defaults to True Shuffle");
const playbackBefore = { ...preferences.playback };
for (const order of [ARCADE_ORDER_SEQUENTIAL, ARCADE_ORDER_TRUE_RANDOM, ARCADE_ORDER_SHUFFLE_LOOP]) {
  await Preferences.saveMicroArcadePreferences({ animationOrder: order });
  preferences = await Preferences.loadPreferences();
  assert(preferences.microArcade.animationOrder === order, `${order} persists`);
}
await Preferences.saveMicroArcadePreferences({ animationOrder: "invalid" });
preferences = await Preferences.loadPreferences();
assert(preferences.microArcade.animationOrder === ARCADE_ORDER_TRUE_RANDOM, "Invalid animation order normalizes safely");
assert(JSON.stringify(preferences.playback) === JSON.stringify(playbackBefore), "Media Playback preferences are unaffected");

console.log(`micro arcade animation order: ${assertions} assertions passed`);
