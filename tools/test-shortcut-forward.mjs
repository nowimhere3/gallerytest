// S9B-A: child -> parent SHORTCUT_KEY forwarding, through the real main.js
// handshake block + the real single keydown observer, with a fake parent.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import * as bridgeModule from "../src/runtime/streamloop-bridge.js";
import { parseLaunchContext, LAUNCH_CONTEXT_STREAMLOOP } from "../src/runtime/launch-context.js";

const main = fs.readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
const s1 = main.indexOf("let streamLoopPendingIntent = null;");
const g1 = main.indexOf("if (launchContext === LAUNCH_CONTEXT_STREAMLOOP) {", s1);
const e1 = main.indexOf("\n}\n", g1) + 3;
const s2 = main.indexOf("// [S9B-A] ONE canonical child-side keydown observer");
const e2 = main.indexOf("\n});\n", s2) + 5;
assert(s1 >= 0 && g1 > s1 && e1 > g1 && s2 >= e1 && e2 > s2, "slices found");
const slice = main.slice(s1, e1) + main.slice(s2, e2);
assert.equal((main.match(/getShortcutKeyCode\(/g) || []).length, 1, "one forwarding call site in main.js");
assert.equal((main.match(/SHORTCUT_KEY/g) || []).length, 0, "no key table / message literal outside the bridge module");

const query = (generation) => ({ source: "gs3-capability-bridge", version: 1, type: "QUERY_CAPABILITY",
  capability: "GALLERY_FAVORITE", generation });
const CODES = ["Digit1", "Digit2", "Digit3", "Digit4", "KeyZ", "KeyX", "KeyC", "KeyV"];
const el = (props = {}) => ({ tagName: "DIV", isContentEditable: false, getAttribute: () => null, ...props });
const key = (code, extra = {}) => ({ code, key: "x", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
  repeat: false, isComposing: false, defaultPrevented: false, target: el(), ...extra });

function boot(search, { favoriteSpy } = {}) {
  const traffic = [], messageListeners = [], docListeners = [];
  const parent = { postMessage: (...args) => traffic.push(args) };
  const window = { parent, addEventListener: (type, cb) => { assert.equal(type, "message"); messageListeners.push(cb); } };
  const document = { addEventListener: (type, cb) => { assert.equal(type, "keydown"); docListeners.push(cb); } };
  const calls = [];
  const spy = (name) => (...a) => { calls.push(name); return false; };
  const runtime = { getCurrentItem: () => null, subscribe: () => {}, getState: () => ({ hasVisibleItems: true }),
    play() {}, stop() {}, toggleFavorite: spy("toggleFavorite") };
  const profileView = { isFavorite: spy("isFavorite"), setFavorite: spy("setFavorite"), toggleFavorite: spy("pv.toggleFavorite") };
  const context = vm.createContext({ window, document, runtime, profileView, profile: {},
    launchContext: parseLaunchContext(search), LAUNCH_CONTEXT_STREAMLOOP, ...bridgeModule });
  vm.runInContext(slice, context);
  return { traffic, calls, docListeners, messageListeners, parent,
    shortcuts: () => traffic.filter(([m]) => m.type === "SHORTCUT_KEY"),
    handshake(generation, source = parent, origin = "https://host.example") {
      messageListeners.forEach((fn) => fn({ data: query(generation), source, origin }));
    },
    press(event) { docListeners.forEach((fn) => fn(event)); } };
}

for (const search of ["", "?launch=streamloop"]) { // B, C: both launch modes
  const app = boot(search);
  assert.equal(app.docListeners.length, 1, "AE: exactly one DOM keydown listener");
  // O: nothing before a valid handshake (also not from untrusted sources).
  for (const code of CODES) app.press(key(code));
  app.handshake("g0", {}); app.handshake("g0", null);
  for (const code of CODES) app.press(key(code));
  assert.equal(app.traffic.length, 0);
  app.handshake("gen-1");
  assert.deepEqual(app.traffic[0][0].features, ["favoriteCurrent", "favoriteState", "keyForward"]); // A, D
  const before = app.traffic.length;
  for (const code of CODES) app.press(key(code)); // E-L
  const sent = app.shortcuts();
  assert.deepEqual(sent.map(([m]) => m.code), CODES);
  for (const [m, origin] of sent) { // M, N, AC
    assert.deepEqual(m, { source: "gs3-capability-bridge", version: 1, type: "SHORTCUT_KEY",
      capability: "GALLERY_FAVORITE", generation: "gen-1", code: m.code });
    assert.equal(origin, "https://host.example");
  }
  assert.equal(app.traffic.length, before + CODES.length);
  // P: a newer generation replaces the old one; the listener count never grows (AE).
  app.handshake("gen-2");
  app.handshake("gen-3");
  app.press(key("KeyZ"));
  assert.equal(app.shortcuts().at(-1)[0].generation, "gen-3");
  assert.equal(app.docListeners.length, 1);
  assert.equal(app.messageListeners.length, 1);
  // Q-T: any modifier blocks every candidate.
  const count = app.traffic.length;
  for (const code of CODES) for (const mod of ["ctrlKey", "metaKey", "altKey", "shiftKey"]) app.press(key(code, { [mod]: true }));
  // U, V, W: repeat, composition, already handled.
  for (const extra of [{ repeat: true }, { isComposing: true }, { defaultPrevented: true }]) app.press(key("Digit1", extra));
  // AB: unrelated keys, including look-alikes, and malformed events.
  for (const code of ["KeyA", "KeyL", "KeyF", "Space", "ArrowLeft", "Digit5", "Digit0", "Numpad1", "NumpadEnter", "Escape", "", undefined, 1, null]) app.press(key(code));
  app.press(null); app.press(undefined); app.press({});
  // X-AA: editable targets, directly and via the composed path (shadow DOM).
  const editable = [
    el({ tagName: "INPUT" }), el({ tagName: "textarea" }), el({ tagName: "SELECT" }),
    el({ isContentEditable: true }),
    el({ getAttribute: (n) => (n === "contenteditable" ? "" : null) }),
    el({ getAttribute: (n) => (n === "contenteditable" ? "true" : null) }),
    ...["textbox", "combobox", "searchbox", "spinbutton"].map((role) => el({ getAttribute: (n) => (n === "role" ? role : null) })),
  ];
  for (const target of editable) {
    app.press(key("KeyZ", { target }));
    app.press(key("KeyZ", { target: el(), composedPath: () => [el(), target, el()] })); // ancestor in path
  }
  assert.equal(app.traffic.length, count, "no forwards for modified/repeat/composing/prevented/unrelated/editable");
  // contenteditable="false" is not editable; plain focused elements still forward (focus scope).
  app.press(key("KeyV", { target: el({ getAttribute: (n) => (n === "contenteditable" ? "false" : null) }) }));
  app.press(key("Digit4", { target: el({ tagName: "BUTTON" }) }));
  app.press(key("Digit3", { target: el({ tagName: "BODY" }), composedPath: () => [el({ tagName: "VIDEO" }), el({ tagName: "BODY" })] }));
  assert.deepEqual(app.shortcuts().slice(-3).map(([m]) => m.code), ["KeyV", "Digit4", "Digit3"]);
  // AC/AD: forwarding never touches favorite APIs and never adds Position/Slot/media fields.
  assert.deepEqual(app.calls, [], "AD: no favorite API call from the forwarder path");
  for (const [m] of app.shortcuts()) assert.deepEqual(Object.keys(m).sort(), ["capability", "code", "generation", "source", "type", "version"]);
  // Forwarding does not preventDefault/stopPropagation.
  let touched = 0;
  app.press(key("KeyX", { preventDefault: () => touched++, stopPropagation: () => touched++, stopImmediatePropagation: () => touched++ }));
  assert.equal(touched, 0);
  // A throwing parent never breaks the page.
  const dead = boot(search); dead.handshake("g"); dead.parent.postMessage = () => { throw Error("dead"); };
  assert.doesNotThrow(() => dead.press(key("KeyC")));
}
// AL: no persistence primitive is used by the forwarding state or helpers.
const bridgeSrc = fs.readFileSync(new URL("../src/runtime/streamloop-bridge.js", import.meta.url), "utf8");
assert(!/localStorage|sessionStorage|indexedDB/.test(bridgeSrc), "AL: no persistence in the bridge module");
// The key table is defined exactly once, in the bridge module.
assert.deepEqual([...bridgeModule.SHORTCUT_KEY_CODES], CODES);
console.log("PASS shortcut forwarding: table, trust/generation, modifiers, repeat/composition/prevented, editable (incl. composed path + roles), single listener, no favorite/Position fields");
