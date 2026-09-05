import { planReadyQueueWork } from "../src/runtime/ready-queue.js";

let assertions = 0;
function assert(condition, label) {
  if (!condition) throw new Error(label);
  assertions += 1;
}

const items = Array.from({ length: 8 }, (_, index) => ({ id: String(index) }));

let work = planReadyQueueWork({
  plannedItems: items.slice(0, 7),
  preparedItems: [],
  warmingItems: [],
  maxPrepared: 6,
  maxConcurrent: 2,
});
assert(work.start.length === 2, "warming respects its concurrency cap");
assert(work.start[0] === items[0] && work.start[1] === items[1], "warming follows plan order");
assert(work.release.length === 0, "a fresh plan releases nothing");

work = planReadyQueueWork({
  plannedItems: items.slice(0, 6),
  preparedItems: [items[0], items[7]],
  warmingItems: [items[1]],
  maxPrepared: 6,
  maxConcurrent: 2,
});
assert(work.release.length === 1 && work.release[0] === items[7], "prepared items outside the plan are released");
assert(work.start.length === 1 && work.start[0] === items[2], "prepared and warming items are not restarted");

work = planReadyQueueWork({
  plannedItems: items.slice(0, 6),
  preparedItems: items.slice(0, 6),
  warmingItems: [],
  maxPrepared: 6,
  maxConcurrent: 2,
});
assert(work.start.length === 0, "the prepared cap prevents more work");

work = planReadyQueueWork({
  plannedItems: [],
  preparedItems: [items[0]],
  warmingItems: [],
  maxPrepared: 6,
  maxConcurrent: 2,
});
assert(work.start.length === 0, "an empty plan starts no work");
assert(work.release.length === 1 && work.release[0] === items[0], "an empty plan releases prepared work");

let prepared = [];
let warming = [];
let largestPreparedSet = 0;
for (let advance = 0; advance < 100; advance += 1) {
  const plan = Array.from({ length: 6 }, (_, offset) => items[(advance + offset) % items.length]);
  const decision = planReadyQueueWork({
    plannedItems: plan,
    preparedItems: prepared,
    warmingItems: warming,
    maxPrepared: 6,
    maxConcurrent: 2,
  });
  prepared = prepared.filter((item) => !decision.release.includes(item));
  warming = decision.start;
  prepared.push(...warming);
  warming = [];
  largestPreparedSet = Math.max(largestPreparedSet, prepared.length);
}
assert(largestPreparedSet <= 6, "the prepared set remains bounded at six across 100 advances");

console.log(`ready queue: ${assertions} assertions passed`);
