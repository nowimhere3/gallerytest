// [PLAYBACK / MICRO-ARCADE / ANIMATION-ORDER]
// Loading-animation selection is deliberately independent from MediaRuntime.
export const ARCADE_ORDER_SEQUENTIAL = "sequential";
export const ARCADE_ORDER_TRUE_RANDOM = "true-random";
export const ARCADE_ORDER_SHUFFLE_LOOP = "shuffle-loop";
export const DEFAULT_ARCADE_ANIMATION_ORDER = ARCADE_ORDER_TRUE_RANDOM;

const VALID_ORDERS = new Set([ARCADE_ORDER_SEQUENTIAL, ARCADE_ORDER_TRUE_RANDOM, ARCADE_ORDER_SHUFFLE_LOOP]);

export function normalizeArcadeAnimationOrder(value) {
  return VALID_ORDERS.has(value) ? value : DEFAULT_ARCADE_ANIMATION_ORDER;
}

// [PLAYBACK / MICRO-ARCADE / ANIMATION-HELPER]
export function getArcadeAnimationOrderHelper(order) {
  switch (normalizeArcadeAnimationOrder(order)) {
    case ARCADE_ORDER_SEQUENTIAL:
      return "Plays the arcade scenes in order.";
    case ARCADE_ORDER_SHUFFLE_LOOP:
      return "Plays every arcade scene once in random order before reshuffling.";
    default:
      return "Every loading animation is picked randomly. Repeats can happen.";
  }
}

export function renderArcadeAnimationOrderHelper(element, order) {
  element.textContent = getArcadeAnimationOrderHelper(order);
}

function pickRandomScene(scenes, random) {
  return scenes[Math.floor(random() * scenes.length)];
}

function pickSequentialScene(scenes, readIndex, writeIndex) {
  const index = readIndex();
  writeIndex((index + 1) % scenes.length);
  return scenes[index];
}

function pickShuffleLoopScene(scenes, previousScene, visitedScenes, random) {
  let cycle = visitedScenes.filter((scene) => scenes.includes(scene));
  let candidates = scenes.filter((scene) => !cycle.includes(scene));
  if (candidates.length === 0) {
    cycle = [];
    candidates = scenes.length > 1 ? scenes.filter((scene) => scene !== previousScene) : scenes;
  }
  const scene = pickRandomScene(candidates, random);
  return { scene, visitedScenes: [...cycle, scene] };
}

export function selectArcadeScene({
  scenes,
  order = DEFAULT_ARCADE_ANIMATION_ORDER,
  previousScene = null,
  visitedScenes = [],
  random = Math.random,
  readIndex,
  writeIndex,
}) {
  switch (normalizeArcadeAnimationOrder(order)) {
    case ARCADE_ORDER_SEQUENTIAL:
      return { scene: pickSequentialScene(scenes, readIndex, writeIndex), visitedScenes };
    case ARCADE_ORDER_SHUFFLE_LOOP:
      return pickShuffleLoopScene(scenes, previousScene, visitedScenes, random);
    default:
      return { scene: pickRandomScene(scenes, random), visitedScenes: [] };
  }
}
