import { MediaRuntime } from "../src/runtime/media-runtime.js";
import { SHUFFLE_MODE_LOOP, SHUFFLE_MODE_TRUE_RANDOM } from "../src/runtime/shuffle-selector.js";

let assertions = 0;
function assert(condition, label) {
  if (!condition) throw new Error(label);
  assertions += 1;
}

let nextTimerId = 0;
const timers = new Map();
globalThis.window = {
  setTimeout(callback, delay) {
    const id = ++nextTimerId;
    timers.set(id, { callback, delay });
    return id;
  },
  clearTimeout(id) {
    timers.delete(id);
  },
};

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function makeItems(count = 7) {
  return Array.from({ length: count }, (_, index) => ({
    id: `item-${index}`,
    relativePath: `item-${index}.jpg`,
    name: `item-${index}.jpg`,
    kind: "image",
    url: `blob:item-${index}`,
  }));
}

function createRuntime(mode, seed = 12345, items = makeItems()) {
  const runtime = new MediaRuntime({ random: seededRandom(seed) });
  runtime.load(items);
  runtime.setShuffle(true);
  runtime.setShuffleMode(mode);
  return runtime;
}

for (const mode of [SHUFFLE_MODE_LOOP, SHUFFLE_MODE_TRUE_RANDOM]) {
  const unplanned = createRuntime(mode);
  const planned = createRuntime(mode);
  const expected = [];
  const actual = [];
  for (let step = 0; step < 20; step += 1) {
    unplanned.next();
    expected.push(unplanned.getState().currentIndex);
    planned.getPlannedItems(3);
    planned.next();
    actual.push(planned.getState().currentIndex);
  }
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${mode} planned sequence equals unplanned sequence`);
}

const cycleRuntime = createRuntime(SHUFFLE_MODE_LOOP, 77, makeItems(6));
const cycle = [cycleRuntime.getState().currentIndex];
cycleRuntime.getPlannedItems(5);
for (let step = 0; step < 5; step += 1) {
  cycleRuntime.next();
  cycle.push(cycleRuntime.getState().currentIndex);
}
assert(new Set(cycle).size === 6, "a full planned Shuffle Loop cycle has no repeat");

const eligibleItems = makeItems(6);
eligibleItems[2].isHidden = true;
const eligible = createRuntime(SHUFFLE_MODE_LOOP, 9, eligibleItems);
const eligiblePlan = eligible.getPlannedItems(20);
assert(eligiblePlan.length === 6, "plan length never exceeds the six-item runtime cap");
assert(eligiblePlan.every((item) => item !== eligibleItems[2]), "planned items respect hidden eligibility");
const prefix = eligible.getPlannedItems(3);
assert(prefix.every((item, index) => item === eligiblePlan[index]), "repeated planning returns a stable prefix");
const stateBeforePlanning = eligible.getState();
eligible.getPlannedItems(3);
const stateAfterPlanning = eligible.getState();
assert(stateAfterPlanning.currentIndex === stateBeforePlanning.currentIndex, "planning does not move currentIndex");
assert(stateAfterPlanning.navigationStep === stateBeforePlanning.navigationStep, "planning does not change navigationStep");

const history = createRuntime(SHUFFLE_MODE_LOOP, 33);
const originalPlan = history.getPlannedItems(3);
history.next();
history.previous();
assert(history.getPlannedItems(3).length === 0, "forward history takes precedence over planning");
history.next();
assert(history.getState().currentItem === originalPlan[0], "Next walks forward history without consuming another planned item");
history.next();
assert(history.getState().currentItem === originalPlan[1], "the preserved plan resumes after forward history is exhausted");

const invalidated = createRuntime(SHUFFLE_MODE_LOOP, 91);
const oldPlan = invalidated.getPlannedItems(3);
oldPlan[0].isHidden = true;
const newPlan = invalidated.getPlannedItems(3);
assert(!newPlan.includes(oldPlan[0]), "a pool-key eligibility change invalidates the old plan");

for (const [label, mutate, restore] of [
  ["setShuffle", (runtime) => runtime.setShuffle(false), (runtime) => runtime.setShuffle(true)],
  ["setShuffleMode", (runtime) => runtime.setShuffleMode(SHUFFLE_MODE_TRUE_RANDOM)],
  ["setCurrentIndex", (runtime) => runtime.setCurrentIndex(4)],
  ["removeItemById", (runtime) => runtime.removeItemById("item-4")],
  ["load", (runtime) => runtime.load(makeItems(4))],
  ["clear", (runtime) => runtime.clear(), (runtime) => runtime.load(makeItems(4))],
]) {
  let draws = 0;
  const runtime = new MediaRuntime({ random: () => {
    draws += 1;
    return 0.25;
  } });
  runtime.load(makeItems());
  runtime.getPlannedItems(3);
  const drawsBeforeMutation = draws;
  mutate(runtime);
  if (restore) restore(runtime);
  runtime.getPlannedItems(3);
  assert(draws > drawsBeforeMutation, `${label} clears the materialized plan`);
}

const timerRuntime = createRuntime(SHUFFLE_MODE_LOOP, 5);
timerRuntime.play();
assert(timers.size === 1, "play schedules one image timer");
timerRuntime.holdAdvanceForPendingVisual();
assert(timers.size === 0, "advance hold clears and blocks the timer");
const heldIndex = timerRuntime.getState().currentIndex;
timerRuntime.next();
assert(timerRuntime.getState().currentIndex !== heldIndex, "manual Next is never blocked by the advance hold");
assert(timers.size === 0, "manual Next does not bypass the unresolved visual hold");
timerRuntime.notifyCurrentItemVisible();
assert(timers.size === 1, "visible notification re-anchors one timer");
timerRuntime.holdAdvanceForPendingVisual();
timerRuntime.stop();
timerRuntime.play();
assert(timers.size === 1, "stop and play cannot leave the hold latched");
timerRuntime.holdAdvanceForPendingVisual();
timerRuntime.load(makeItems(3));
timerRuntime.play();
assert(timers.size === 1, "load cannot leave the hold latched");
timerRuntime.holdAdvanceForPendingVisual();
timerRuntime.clear();
assert(timers.size === 0, "clear cannot leave a timer or hold active");

const videoItems = makeItems(2).map((item) => ({ ...item, kind: "video" }));
const videoRuntime = createRuntime(SHUFFLE_MODE_LOOP, 1, videoItems);
videoRuntime.holdAdvanceForPendingVisual();
videoRuntime.notifyCurrentItemVisible();
videoRuntime.play();
assert(timers.size === 0, "a visible video does not latch the hold or schedule an image timer");

console.log(`shuffle plan: ${assertions} assertions passed`);
