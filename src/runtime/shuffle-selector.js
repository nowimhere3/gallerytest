export const SHUFFLE_MODE_TRUE_RANDOM = "true-random";
export const SHUFFLE_MODE_LOOP = "shuffle-loop";

export function normalizeShuffleMode(value) {
  return value === SHUFFLE_MODE_TRUE_RANDOM ? SHUFFLE_MODE_TRUE_RANDOM : SHUFFLE_MODE_LOOP;
}

function pick(pool, random) {
  if (!pool.length) return null;
  const sample = Number(random());
  const unit = Number.isFinite(sample) ? Math.min(Math.max(sample, 0), 0.9999999999999999) : 0;
  return pool[Math.floor(unit * pool.length)];
}

/**
 * [PLAYBACK / SHUFFLE-MODES / TRUE-SHUFFLE]
 * [PLAYBACK / SHUFFLE-MODES / SHUFFLE-LOOP]
 * Pure next-item selection. History remains MediaRuntime's responsibility;
 * this owns only random mode dispatch and the non-repeating cycle.
 */
export function selectNextShuffledIndex({
  eligibleIndices,
  currentIndex,
  mode,
  visitedIndices = [],
  random = Math.random,
}) {
  const eligible = Array.isArray(eligibleIndices) ? [...eligibleIndices] : [];
  if (!eligible.length) return { nextIndex: null, visitedIndices: [] };

  if (normalizeShuffleMode(mode) === SHUFFLE_MODE_TRUE_RANDOM) {
    return { nextIndex: pick(eligible, random), visitedIndices: [] };
  }

  let visited = new Set(visitedIndices);
  let pool = eligible.filter((index) => !visited.has(index));

  if (!pool.length) {
    visited = new Set();
    pool = eligible.length > 1 ? eligible.filter((index) => index !== currentIndex) : eligible;
  }

  const nextIndex = pick(pool, random);
  if (nextIndex !== null) visited.add(nextIndex);
  return { nextIndex, visitedIndices: [...visited] };
}
