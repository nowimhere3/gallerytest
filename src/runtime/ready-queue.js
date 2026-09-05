/**
 * Pure bounded-work decision for the Presentation image warmer.
 * Items are compared by reference because the runtime plan returns the exact
 * MediaItem objects that next() will later make current.
 */
export function planReadyQueueWork({
  plannedItems = [],
  preparedItems = [],
  warmingItems = [],
  maxPrepared = 0,
  maxConcurrent = 0,
} = {}) {
  const plan = Array.isArray(plannedItems) ? plannedItems : [];
  const prepared = Array.isArray(preparedItems) ? preparedItems : [];
  const warming = Array.isArray(warmingItems) ? warmingItems : [];
  const planSet = new Set(plan);
  const preparedSet = new Set(prepared);
  const warmingSet = new Set(warming);
  const release = prepared.filter((item) => !planSet.has(item));
  const retainedPrepared = prepared.length - release.length;
  const preparedSlots = Math.max(0, Math.floor(maxPrepared) - retainedPrepared - warming.length);
  const concurrentSlots = Math.max(0, Math.floor(maxConcurrent) - warming.length);
  const startLimit = Math.min(preparedSlots, concurrentSlots);
  const start = [];

  for (const item of plan) {
    if (start.length >= startLimit) break;
    if (preparedSet.has(item) || warmingSet.has(item) || start.includes(item)) continue;
    start.push(item);
  }

  return { start, release };
}
