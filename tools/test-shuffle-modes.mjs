import { MediaRuntime } from "../src/runtime/media-runtime.js";
import { installFakeIndexedDB } from "./lib/browser-test-env.mjs";
import {
  selectNextShuffledIndex,
  SHUFFLE_MODE_LOOP,
  SHUFFLE_MODE_TRUE_RANDOM,
} from "../src/runtime/shuffle-selector.js";

let assertions = 0;
function assert(condition, label) {
  if (!condition) throw new Error(label);
  assertions += 1;
}

function select(options, samples) {
  let cursor = 0;
  return selectNextShuffledIndex({ ...options, random: () => samples[cursor++] ?? samples.at(-1) ?? 0 });
}

// [PLAYBACK / SHUFFLE-MODES / TRUE-SHUFFLE]
let result = select({ eligibleIndices: [], currentIndex: -1, mode: SHUFFLE_MODE_TRUE_RANDOM }, [0]);
assert(result.nextIndex === null, "an empty shuffle pool has no selection");
result = select({ eligibleIndices: [0, 1, 2], currentIndex: 0, mode: SHUFFLE_MODE_TRUE_RANDOM }, [0]);
assert(result.nextIndex === 0, "True Shuffle allows an immediate repeat");
assert(result.visitedIndices.length === 0, "True Shuffle retains no exhaustion memory");
result = select({ eligibleIndices: [0, 1, 2], currentIndex: 0, mode: SHUFFLE_MODE_TRUE_RANDOM }, [0.999]);
assert(result.nextIndex === 2, "True Shuffle can select any eligible item");
result = select({ eligibleIndices: [0, 1], currentIndex: 1, mode: SHUFFLE_MODE_TRUE_RANDOM, visitedIndices: [0, 1] }, [0]);
assert(result.nextIndex === 0, "True Shuffle ignores prior-cycle visits");

// [PLAYBACK / SHUFFLE-MODES / SHUFFLE-LOOP]
let visited = [0];
const cycle = [];
for (const sample of [0, 0]) {
  result = select(
    { eligibleIndices: [0, 1, 2], currentIndex: cycle.at(-1) ?? 0, mode: SHUFFLE_MODE_LOOP, visitedIndices: visited },
    [sample]
  );
  cycle.push(result.nextIndex);
  visited = result.visitedIndices;
}
assert(new Set([0, ...cycle]).size === 3, "Shuffle Loop uses every item once before a repeat");
assert(cycle[0] !== cycle[1], "Shuffle Loop has no repeat within a cycle");
const priorLast = cycle.at(-1);
result = select({ eligibleIndices: [0, 1, 2], currentIndex: priorLast, mode: SHUFFLE_MODE_LOOP, visitedIndices: visited }, [0]);
assert(result.nextIndex !== priorLast, "new cycle does not begin with the prior cycle's last item");
assert(result.visitedIndices.length === 1, "exhaustion starts a fresh cycle");
result = select({ eligibleIndices: [7], currentIndex: 7, mode: SHUFFLE_MODE_LOOP, visitedIndices: [7] }, [0]);
assert(result.nextIndex === 7, "one-item Shuffle Loop remains valid");
result = select({ eligibleIndices: [1, 3], currentIndex: 1, mode: SHUFFLE_MODE_LOOP, visitedIndices: [0, 1, 2] }, [0]);
assert(result.nextIndex === 3, "a mutated pool rebuilds from currently eligible items");
result = select({ eligibleIndices: [1, 3], currentIndex: 9, mode: SHUFFLE_MODE_LOOP, visitedIndices: [9] }, [0]);
assert(result.nextIndex === 1, "a pool remains valid when the former current item is no longer eligible");

const items = [0, 1, 2].map((id) => ({ id: String(id), relativePath: String(id), kind: "video" }));
const sequential = new MediaRuntime({ random: () => 0 });
sequential.load(items);
sequential.setShuffle(false);
sequential.setLoop(false);
sequential.next();
assert(sequential.getState().currentIndex === 1, "Shuffle off remains sequential");
sequential.setCurrentIndex(2);
sequential.next();
assert(sequential.getState().currentIndex === 2, "ordinary Loop off still stops at the sequential end");
sequential.setLoop(true);
sequential.next();
assert(sequential.getState().currentIndex === 0, "ordinary Loop on still wraps sequential playback");

const disableShuffle = new MediaRuntime({ random: () => 0 });
disableShuffle.load(items);
disableShuffle.next();
disableShuffle.setShuffle(false);
disableShuffle.next();
assert(disableShuffle.getState().currentIndex === 2, "disabling Shuffle after a loop cycle resumes sequential order");

const manual = new MediaRuntime({ random: () => 0.999 });
manual.load(items);
manual.setShuffleMode(SHUFFLE_MODE_TRUE_RANDOM);
manual.next();
const autoplay = new MediaRuntime({ random: () => 0.999 });
autoplay.load(items);
autoplay.setShuffleMode(SHUFFLE_MODE_TRUE_RANDOM);
autoplay.play();
autoplay.notifyVideoEnded();
assert(manual.getState().currentIndex === autoplay.getState().currentIndex, "manual Next and video autoplay share selection");

installFakeIndexedDB();
const Preferences = await import("../src/storage/app-preferences.js");
let preferences = await Preferences.loadPreferences();
assert(preferences.playback.shuffleMode === SHUFFLE_MODE_LOOP, "missing preference preserves shipped Shuffle Loop behavior");
await Preferences.savePlaybackPreferences({ shuffleMode: SHUFFLE_MODE_TRUE_RANDOM });
preferences = await Preferences.loadPreferences();
assert(preferences.playback.shuffleMode === SHUFFLE_MODE_TRUE_RANDOM, "True Shuffle preference persists");
await Preferences.savePlaybackPreferences({ shuffleMode: "unknown-mode" });
preferences = await Preferences.loadPreferences();
assert(preferences.playback.shuffleMode === SHUFFLE_MODE_LOOP, "invalid stored mode normalizes to compatibility default");

console.log(`shuffle modes: ${assertions} assertions passed`);
