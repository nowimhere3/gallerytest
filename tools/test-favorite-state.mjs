// S7A: live CURRENT_FAVORITE_STATE publisher, exercised through the real main.js
// listener block + real MediaRuntime + real ProfileStore/projection view.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { installFakeIndexedDB, settle } from "./lib/browser-test-env.mjs";
import * as bridgeModule from "../src/runtime/streamloop-bridge.js";
import { parseLaunchContext, LAUNCH_CONTEXT_STREAMLOOP } from "../src/runtime/launch-context.js";
installFakeIndexedDB();
const { ProfileStore } = await import("../src/profile/profile-store.js");
const { SyncIdentity } = await import("../src/profile/sync-device.js");
const { createProfileProjectionView } = await import("../src/profile/profile-projection-view.js");
const { MediaRuntime } = await import("../src/runtime/media-runtime.js");

const main = fs.readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
const start = main.indexOf("let streamLoopPendingIntent = null;");
const guard = main.indexOf("if (launchContext === LAUNCH_CONTEXT_STREAMLOOP) {", start);
const end = main.indexOf("\n}\n", guard) + 3;
assert(start >= 0 && guard > start && end > guard);
const slice = main.slice(start, end);

const identity = new SyncIdentity({});
const profile = new ProfileStore({ identity });
await settle(); await profile.whenFactsSettled();
const view = createProfileProjectionView({ profile });
const runtime = new MediaRuntime({ profile: view });
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(predicate) {
  for (let i = 0; i < 500 && !predicate(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert(predicate(), "timed out waiting");
}
const query = (generation) => ({ source: "gs3-capability-bridge", version: 1, type: "QUERY_CAPABILITY",
  capability: "GALLERY_FAVORITE", generation });
const mk = (name) => ({ id: `fsa-0-${name}-1`, relativePath: `C:\\Users\\secret\\${name}`, kind: "image", name });

function boot(search, framed = true) {
  const traffic = [], listeners = [];
  const parent = { postMessage: (...args) => traffic.push(args) };
  const window = { parent, addEventListener: (type, cb) => listeners.push(cb) };
  if (!framed) window.parent = window;
  const context = vm.createContext({ window, runtime, profileView: view, profile,
    launchContext: parseLaunchContext(search), LAUNCH_CONTEXT_STREAMLOOP, ...bridgeModule });
  vm.runInContext(slice, context);
  return { window, parent, traffic, context,
    states: () => traffic.filter(([m]) => m.type === "CURRENT_FAVORITE_STATE").map(([m]) => m),
    send(data, source = parent, origin = "https://host.example") { listeners.forEach((fn) => fn({ data, source, origin })); } };
}

// A, B, C, D, E, G: capability + normal/StreamLoop parity (before any handshake: silence).
for (const search of ["", "?launch=streamloop"]) {
  runtime.clear(); await tick();
  const app = boot(search);
  runtime.load([mk("a.jpg")]); await tick();
  assert.equal(app.traffic.length, 0, "D: nothing before a valid handshake");
  app.send(query("g1"), app.window); app.send(query("g1"), {}); app.send(query("g1"), null);
  app.send({ ...query("g1"), capability: "OTHER" });
  await tick(); assert.equal(app.traffic.length, 0, "S: untrusted sources / bad queries grant no authority");
  runtime.clear(); await tick();
  app.send(query("g1")); // E/F/G: exact generation, immediate no-media snapshot
  assert.deepEqual(app.traffic[0][0].features, ["favoriteCurrent", "favoriteState"]); // A/B/C
  assert.deepEqual(app.traffic[1], [{ source: "gs3-capability-bridge", version: 1, type: "CURRENT_FAVORITE_STATE",
    capability: "GALLERY_FAVORITE", generation: "g1", hasMedia: false, mediaKey: null, isFavorite: false }, "https://host.example"]);
  const unframed = boot(search, false);
  unframed.send(query("g1"), unframed.window); await tick();
  assert.equal(unframed.traffic.length, 0);
}
console.log("PASS capability features, silence before handshake, trust, immediate no-media snapshot (both launch modes)");

// Fresh publisher per scenario; the runtime/profile are shared real objects.
runtime.clear(); await tick();
const A = mk("a.jpg"), B = mk("b.jpg");
runtime.load([A, B]); runtime.setCurrentIndex(0); await tick();
const app = boot("");
app.send(query("g-1")); // H: current, un-favorited
let states = app.states();
assert.equal(states.length, 1);
assert.deepEqual([states[0].hasMedia, states[0].isFavorite, states[0].generation], [true, false, "g-1"]);
const keyA = states[0].mediaKey;
assert.match(keyA, /^m\d+$/);
// T: no path, id or filename leaks through the key or anywhere in the state envelope.
assert(!JSON.stringify(states[0]).match(/secret|a\.jpg|fsa-|Users/), "T: no absolute path / filename exposed");

// L/K: Gallery's own favorite button goes through runtime.toggleFavorite.
runtime.toggleFavorite(); await tick();
states = app.states(); assert.equal(states.length, 2);
assert.deepEqual([states[1].mediaKey, states[1].isFavorite], [keyA, true]); // I, same item changed state
// P: identical emissions deduplicated (play/interval/loop/shuffle re-emit without changing the tuple).
runtime.setLoop(true); runtime.setShuffle(false); runtime.setIntervalMs(2000); view.emit(); view.emit(); await tick();
assert.equal(app.states().length, 2, "P: no duplicate churn");
// N: already-favorite FAVORITE_CURRENT => no write, no extra state.
const at = profile.getFavoritedAt(A.relativePath);
const before = app.traffic.length;
app.send({ ...query("g-1"), type: "FAVORITE_CURRENT", requestId: "r1" });
await until(() => app.traffic.some(([m]) => m.requestId === "r1"));
assert.equal(app.traffic.length, before + 1);
assert.equal(app.traffic.at(-1)[0].status, "already-favorite");
assert.equal(profile.getFavoritedAt(A.relativePath), at);
assert.equal(app.states().length, 2, "N: already-favorite creates no state churn");

// J: moving to B publishes a new key with B's own (un-favorited) truth.
runtime.setCurrentIndex(1); await tick();
states = app.states(); assert.equal(states.length, 3);
assert.notEqual(states[2].mediaKey, keyA); assert.equal(states[2].isFavorite, false);
const keyB = states[2].mediaKey;
// M: FAVORITE_CURRENT favorites B; the normal observation path publishes isFavorite:true.
app.send({ ...query("g-1"), type: "FAVORITE_CURRENT", requestId: "r2" });
await until(() => app.traffic.some(([m]) => m.requestId === "r2"));
assert(app.traffic.some(([m]) => m.type === "FAVORITE_RESULT" && m.status === "favorited"));
states = app.states(); assert.equal(states.length, 4);
assert.deepEqual([states[3].mediaKey, states[3].isFavorite], [keyB, true]);
// Returning to A keeps A's previously issued key (stable within the session).
runtime.setCurrentIndex(0); await tick();
assert.equal(app.states().at(-1).mediaKey, keyA); assert.equal(app.states().at(-1).isFavorite, true);

// Projection truth beats stale copied item.isFavorite: an alias-proven favorite is reported.
runtime.setCurrentIndex(1); await tick();
view.setFavorite(B.relativePath, false); await profile.whenLocalWritesSettled(); await tick();
assert.equal(app.states().at(-1).isFavorite, false);
A.isFavorite = false; // deliberately stale copy
runtime.setCurrentIndex(0); await tick();
assert.equal(app.states().at(-1).isFavorite, view.isFavorite(A.relativePath));
assert.equal(app.states().at(-1).isFavorite, true);

// Q/R: a newer valid query replaces the generation and yields a fresh snapshot; no obsolete generation after.
const priorCount = app.states().length;
app.send(query("g-2"));
states = app.states(); assert.equal(states.length, priorCount + 1);
assert.equal(states.at(-1).generation, "g-2"); assert.equal(states.at(-1).mediaKey, keyA);
runtime.setCurrentIndex(1); await tick();
assert.equal(app.states().at(-1).generation, "g-2");
assert(app.states().slice(priorCount).every((m) => m.generation === "g-2"), "R: no obsolete generation");
// A malformed/untrusted newer query must not replace the generation.
app.send(query("g-evil"), app.window); app.send({ ...query("g-evil"), version: 2 }); runtime.setCurrentIndex(0); await tick();
assert.equal(app.states().at(-1).generation, "g-2");

// O: clearing publishes hasMedia:false, then dedupes repeats.
runtime.clear(); await tick();
assert.deepEqual([app.states().at(-1).hasMedia, app.states().at(-1).mediaKey, app.states().at(-1).isFavorite], [false, null, false]);
const cleared = app.states().length; runtime.clear(); await tick();
assert.equal(app.states().length, cleared);

// Replies pin to the handshake origin; opaque origin falls back to "*" as S5B/S6B do.
assert(app.states().every((m) => app.traffic.find(([x]) => x === m)[1] === "https://host.example"));
const opaque = boot(""); runtime.load([A]); opaque.send(query("o"), opaque.parent, "null");
assert.equal(opaque.traffic.at(-1)[1], "*");

// A throwing parent/runtime never breaks Gallery.
const broken = boot(""); broken.parent.postMessage = (m) => { if (m.type === "CURRENT_FAVORITE_STATE") throw Error("dead"); };
assert.doesNotThrow(() => broken.send(query("x")));
await identity.flush();
console.log("PASS live state: truth, identity, dedupe, S6B interaction, generations, clear, origin pinning");
process.exit(0);
