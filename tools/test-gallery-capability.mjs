// Exercise the actual main.js parent-message registration block with a fake parent.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createGalleryCapabilityResponse, parseStreamLoopMessage, nextPendingIntent, parseFavoriteCurrent, executeFavoriteCurrent } from "../src/runtime/streamloop-bridge.js";
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
function boot(search, framed = true, action = {}) {
  const traffic = [], playback = [], listeners = [];
  const parent = { postMessage: (...args) => traffic.push(args) };
  const window = { parent, addEventListener: (type, callback) => {
    assert.equal(type, "message"); listeners.push(callback);
  } };
  if (!framed) window.parent = window;
  let stateReads = 0;
  let subscriptions = 0;
  const runtime = new Proxy({
    getCurrentItem: () => action.item || null,
    getState: () => { stateReads++; return { hasVisibleItems: true }; },
    subscribe: () => { subscriptions++; }, play: () => playback.push("play"), stop: () => playback.push("pause"),
  }, { get(target, key) {
    assert(key in target, `unexpected runtime access: ${String(key)}`);
    return target[key];
  } });
  const context = vm.createContext({ window, runtime, profileView: action.view, profile: action.profile,
    launchContext: parseLaunchContext(search), LAUNCH_CONTEXT_STREAMLOOP,
    createGalleryCapabilityResponse, parseStreamLoopMessage, nextPendingIntent, parseFavoriteCurrent, executeFavoriteCurrent });
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
    capability: "GALLERY_FAVORITE", generation: query.generation, features: ["favoriteCurrent"],
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

// Actual listener command routing, in both launch contexts.
for (const search of ["", "?launch=streamloop"]) {
  let writes = 0, on = false, at = 0, release;
  const saved = new Promise(resolve => { release = resolve; });
  const view = { isFavorite: () => on, setFavorite: (path, value) => {
    assert.equal(path, "cat.jpg"); assert.equal(value, true); writes++; on = true; at = 123;
  } };
  const app = boot(search, true, { item: { relativePath: "cat.jpg" }, view,
    profile: { whenLocalWritesSettled: () => saved } });
  const command = { ...query, type: "FAVORITE_CURRENT", requestId: " opaque request " };
  app.send(command);
  assert.equal(writes, 1); assert.equal(on, true); assert.equal(app.traffic.length, 0);
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(app.traffic[0], [{ source: query.source, version: 1,
    type: "FAVORITE_RESULT", capability: query.capability, generation: query.generation,
    requestId: command.requestId, status: "favorited" }, "https://host.example"]);
  app.send(command); await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.traffic.at(-1)[0].status, "already-favorite");
  assert.equal(writes, 1); assert.equal(at, 123);
  const count = app.traffic.length;
  for (const key of ["source", "version", "type", "capability", "generation", "requestId"]) {
    for (const value of [null, undefined, 2, {}]) app.send({ ...command, [key]: value });
  }
  app.send(command, {}); app.send(command, app.window);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(app.traffic.length, count);
  const empty = boot(search); empty.send(command);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(empty.traffic[0][0].status, "no-media");
}
console.log("PASS FAVORITE_CURRENT routing, correlation, local acknowledgement, idempotence, validation");
