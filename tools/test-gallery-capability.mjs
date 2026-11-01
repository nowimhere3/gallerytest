// Exercise the actual main.js parent-message registration block with a fake parent.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createGalleryCapabilityResponse, parseStreamLoopMessage, nextPendingIntent } from "../src/runtime/streamloop-bridge.js";
import { parseLaunchContext, LAUNCH_CONTEXT_STREAMLOOP } from "../src/runtime/launch-context.js";

const main = fs.readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
const start = main.indexOf("let streamLoopPendingIntent = null;");
const guard = main.indexOf("if (launchContext === LAUNCH_CONTEXT_STREAMLOOP) {", start);
const end = main.indexOf("\n}\n", guard) + 3;
assert(start >= 0 && guard > start && end > guard);
const bridge = main.slice(start, end);
const query = {
  source: "gs3-capability-bridge", version: 1, type: "QUERY_CAPABILITY",
  capability: "GALLERY_FAVORITE", generation: "0123456789abcdef0123456789abcdef",
};
function boot(search, framed = true) {
  const traffic = [], playback = [], listeners = [];
  const parent = { postMessage: (...args) => traffic.push(args) };
  const window = { parent, addEventListener: (type, callback) => {
    assert.equal(type, "message"); listeners.push(callback);
  } };
  if (!framed) window.parent = window;
  let stateReads = 0;
  let subscriptions = 0;
  const runtime = new Proxy({
    getState: () => { stateReads++; return { hasVisibleItems: true }; },
    subscribe: () => { subscriptions++; }, play: () => playback.push("play"), stop: () => playback.push("pause"),
  }, { get(target, key) {
    assert(key in target, `unexpected runtime access: ${String(key)}`);
    return target[key];
  } });
  const context = vm.createContext({ window, runtime,
    launchContext: parseLaunchContext(search), LAUNCH_CONTEXT_STREAMLOOP,
    createGalleryCapabilityResponse, parseStreamLoopMessage, nextPendingIntent });
  vm.runInContext(bridge, context);
  return { window, parent, traffic, playback, listeners, context,
    reads: () => stateReads, subscriptions: () => subscriptions,
    send(data, source = parent, origin = "https://host.example") {
      listeners.forEach(fn => fn({ data, source, origin }));
    } };
}
for (const search of ["", "?launch=streamloop"]) {
  const app = boot(search);
  const isStreamLoop = search !== "";
  assert.equal(app.subscriptions(), isStreamLoop ? 1 : 0);
  assert.equal(app.listeners.length, 1);
  assert.equal(app.traffic.length, 0); // no startup announcement
  app.send(query);
  assert.deepEqual(app.traffic, [[{
    source: "gs3-capability-bridge", version: 1, type: "CAPABILITY_PRESENT",
    capability: "GALLERY_FAVORITE", generation: query.generation, features: [],
  }, "https://host.example"]]);
  // Strings are opaque, including strings unlike today's host token format.
  for (const generation of ["", " opaque token \n", "NEXT-generation"]) {
    app.send({ ...query, generation });
    assert.equal(app.traffic.at(-1)[0].generation, generation);
  }
  const invalid = [null, undefined, 1, true, "QUERY_CAPABILITY", [], {},
    ...["source", "version", "type", "capability", "generation"].flatMap(key => {
      const missing = { ...query }; delete missing[key];
      return [missing, { ...query, [key]: null }, { ...query, [key]: {} }];
    }),
    { ...query, source: "other" }, { ...query, version: "1" },
    { ...query, version: 2 }, { ...query, type: "CAPABILITY_PRESENT" },
    { ...query, capability: "OTHER" }, { ...query, generation: 123 },
  ];
  const count = app.traffic.length;
  for (const data of invalid) assert.doesNotThrow(() => app.send(data));
  app.send(query, {});
  app.send(query, app.window);
  app.send(query, null);
  assert.equal(app.traffic.length, count);
  const unframed = boot(search, false);
  unframed.send(query, unframed.window);
  assert.equal(unframed.traffic.length, 0);
  app.send(query, app.parent, "null");
  assert.equal(app.traffic.at(-1)[1], "*");
  assert.deepEqual(app.playback, []);
  assert.equal(app.reads(), 0); // discovery never consults media or favorite state
  // Existing pending-intent semantics still work and ordinary commands send no reply.
  const beforePlayback = app.traffic.length;
  app.send({ type: "LAUNCHPAD_PLAY" });
  app.send({ type: "LAUNCHPAD_PAUSE" });
  if (isStreamLoop) {
    vm.runInContext("streamLoopStartupSettled = true; tryBecomeStreamLoopReady();", app.context);
  } else {
    assert.equal(vm.runInContext("streamLoopPendingIntent", app.context), null);
    // Normal mode must reject commands even if readiness has otherwise settled.
    vm.runInContext("streamLoopReady = true;", app.context);
  }
  app.send({ type: "LAUNCHPAD_PLAY" });
  assert.deepEqual(app.playback, isStreamLoop ? ["pause", "play"] : []);
  assert.equal(app.traffic.length, beforePlayback);
}
console.log("PASS Gallery capability: both launch contexts, playback gating, exact envelope/echo, invalid queries, parent trust, no media access, playback compatibility");
