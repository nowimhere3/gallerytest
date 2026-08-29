#!/usr/bin/env node
// [STREAMLOOP-INTEGRATION / N6-6]
// [WHY: parseStreamLoopMessage()/nextPendingIntent() (streamloop-bridge.js)
//  are the entire accepted-message contract for StreamLoop's existing
//  LAUNCHPAD_PLAY/LAUNCHPAD_PAUSE postMessage protocol — pure functions with
//  no window/DOM dependency, exhaustively testable in Node. Source/origin
//  validation and the readiness/pending-intent wiring itself live in
//  main.js (they need `window`), so those are proven here as source-level
//  wiring assertions, the same technique test-startup-media.mjs's own §16
//  already uses.]
//
// Usage:  node tools/test-streamloop-bridge.mjs

import { pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";

const ROOT = path.resolve(import.meta.dirname, "..");
const src = (rel) => pathToFileURL(path.join(ROOT, "src", rel)).href;

const {
  parseStreamLoopMessage,
  nextPendingIntent,
  STREAMLOOP_MESSAGE_PLAY,
  STREAMLOOP_MESSAGE_PAUSE,
} = await import(src("runtime/streamloop-bridge.js"));

let failures = 0;
let passes = 0;
const failureDetail = [];

function assert(condition, label, detail) {
  if (condition) {
    passes++;
    return true;
  }
  failures++;
  failureDetail.push(`${label}${detail ? `\n        ${detail}` : ""}`);
  console.log(`  FAIL  ${label}`);
  if (detail) console.log(`        ${detail}`);
  return false;
}

function assertEqual(actual, expected, label) {
  return assert(
    actual === expected,
    label,
    actual === expected ? null : `expected: ${JSON.stringify(expected)}\n        actual:   ${JSON.stringify(actual)}`
  );
}

assertEqual(STREAMLOOP_MESSAGE_PLAY, "LAUNCHPAD_PLAY", "STREAMLOOP_MESSAGE_PLAY matches GS3's exact string");
assertEqual(STREAMLOOP_MESSAGE_PAUSE, "LAUNCHPAD_PAUSE", "STREAMLOOP_MESSAGE_PAUSE matches GS3's exact string");

// ---- parseStreamLoopMessage -------------------------------------------------

console.log("\n1. the real GS3 shapes: { type: 'LAUNCHPAD_PLAY' | 'LAUNCHPAD_PAUSE' }");
assertEqual(parseStreamLoopMessage({ type: "LAUNCHPAD_PLAY" }), "play", "LAUNCHPAD_PLAY -> play");
assertEqual(parseStreamLoopMessage({ type: "LAUNCHPAD_PAUSE" }), "pause", "LAUNCHPAD_PAUSE -> pause");

console.log("\n2. extra unrelated fields on the object are tolerated");
assertEqual(parseStreamLoopMessage({ type: "LAUNCHPAD_PLAY", extra: 1, nested: { a: 1 } }), "play", "extra fields don't break parsing");

console.log("\n3. unknown type -> null");
assertEqual(parseStreamLoopMessage({ type: "SOMETHING_ELSE" }), null, "unrecognized type string");
assertEqual(parseStreamLoopMessage({ type: "" }), null, "empty type string");
assertEqual(parseStreamLoopMessage({}), null, "object with no type field at all");

console.log("\n4. no bare-string fallback — GS3 never sends one");
assertEqual(parseStreamLoopMessage("LAUNCHPAD_PLAY"), null, "a bare string is not accepted, even the exact right value");
assertEqual(parseStreamLoopMessage("LAUNCHPAD_PAUSE"), null, "a bare string is not accepted for pause either");

console.log("\n5. non-object/non-string data never throws");
for (const value of [null, undefined, 42, true, [], ["LAUNCHPAD_PLAY"], () => {}]) {
  assert(
    (() => {
      try {
        return parseStreamLoopMessage(value) === null;
      } catch {
        return false;
      }
    })(),
    `parseStreamLoopMessage(${JSON.stringify(value) ?? String(value)}) is null and does not throw`
  );
}

// ---- nextPendingIntent ------------------------------------------------------

console.log("\n6. nextPendingIntent — latest intent always wins");
assertEqual(nextPendingIntent("play"), "play", "'play' passes through");
assertEqual(nextPendingIntent("pause"), "pause", "'pause' passes through");
assertEqual(nextPendingIntent("bogus"), null, "an unrecognized intent normalizes to null");
assertEqual(nextPendingIntent(null), null, "null stays null");
assertEqual(nextPendingIntent(undefined), null, "undefined normalizes to null");

// ---- main.js wiring: the gated listener, source validation, readiness -----

console.log("\n7. integration: the message listener in main.js");
{
  const mainSource = fs.readFileSync(path.join(ROOT, "src/main.js"), "utf8");

  assert(
    mainSource.includes('import { parseLaunchContext, LAUNCH_CONTEXT_STREAMLOOP } from "./runtime/launch-context.js";'),
    "main.js imports the launch-context contract"
  );
  assert(
    mainSource.includes('import { parseStreamLoopMessage, nextPendingIntent } from "./runtime/streamloop-bridge.js";'),
    "main.js imports the streamloop-bridge contract"
  );
  assert(
    mainSource.includes("const launchContext = parseLaunchContext(window.location.search);"),
    "launchContext is parsed once, from window.location.search"
  );

  // [STREAMLOOP-INTEGRATION / N6-7] N6-6 declared the bridge's shared state
  // and helpers INSIDE the launchContext guard. N6-7 promoted them to module
  // scope — attemptStartupMedia() needs to reach them — leaving only the two
  // registrations (the message listener and the fallback runtime.subscribe())
  // behind the guard. `bridgeRegion` spans from that shared-state declaration
  // through the end of the guard block, so assertions about what the bridge
  // DOES (source validation, runtime.play()/stop(), readiness) still hold
  // regardless of which of the two regions the code physically lives in;
  // assertions about what stays CONDITIONAL still use the narrower guardBody.
  const sharedStateStart = mainSource.indexOf("let streamLoopPendingIntent = null;");
  assert(sharedStateStart !== -1, "the StreamLoop bridge's shared state is declared in main.js");

  const guardStart = mainSource.indexOf("if (launchContext === LAUNCH_CONTEXT_STREAMLOOP) {", sharedStateStart);
  assert(guardStart !== -1, "the StreamLoop bridge's registrations are wired inside an explicit launchContext guard");
  const guardEnd = mainSource.indexOf("\n}\n", guardStart);
  const guardBody = mainSource.slice(guardStart, guardEnd);
  const bridgeRegion = mainSource.slice(sharedStateStart, guardEnd);

  assert(guardBody.includes('window.addEventListener("message"'), "a message listener is registered inside the guard");
  assert(
    !mainSource.slice(0, guardStart).includes('window.addEventListener("message"') &&
      !mainSource.slice(guardEnd).includes('window.addEventListener("message"'),
    "no message listener is registered OUTSIDE the launchContext guard — an ordinary browser tab never adds one"
  );
  assert(
    guardBody.includes("runtime.subscribe((state) => {"),
    "the fallback runtime.subscribe() readiness watch is also registered inside the guard"
  );

  assert(
    bridgeRegion.includes("event.source === window.parent") && bridgeRegion.includes("event.source !== window"),
    "source validation checks event.source against window.parent, excluding the tab's own window"
  );
  assert(!bridgeRegion.includes("event.origin"), "source validation does not key off event.origin (GS3 posts with target origin '*')");

  assert(bridgeRegion.includes("parseStreamLoopMessage(event.data)"), "incoming messages are parsed through the pure bridge function");
  assert(bridgeRegion.includes("nextPendingIntent("), "a pre-readiness intent is folded through nextPendingIntent() — latest wins");
  assert(bridgeRegion.includes("state.hasVisibleItems"), "readiness reads state.hasVisibleItems, the same condition that enables the manual Play button");
  assert(!bridgeRegion.includes("state.hasItems ") && !bridgeRegion.includes("state.hasItems)"), "readiness is NOT the weaker state.hasItems alone");

  // [STREAMLOOP-INTEGRATION / N6-7] The readiness correction: hasVisibleItems
  // alone is no longer sufficient — see the N6-7 handoff's Part 2/3.
  assert(bridgeRegion.includes("streamLoopStartupSettled"), "readiness also requires streamLoopStartupSettled — the N6-7 correction");
  const tryBecomeReadyStart = mainSource.indexOf("function tryBecomeStreamLoopReady()");
  assert(tryBecomeReadyStart !== -1, "tryBecomeStreamLoopReady() is defined");
  const tryBecomeReadyEnd = mainSource.indexOf("\n}\n", tryBecomeReadyStart);
  const tryBecomeReadyBody = mainSource.slice(tryBecomeReadyStart, tryBecomeReadyEnd);
  assert(
    tryBecomeReadyBody.includes("!streamLoopStartupSettled") && tryBecomeReadyBody.includes("hasVisibleItems"),
    "tryBecomeStreamLoopReady() gates on BOTH streamLoopStartupSettled and hasVisibleItems"
  );

  assert(bridgeRegion.includes("runtime.play()"), "PLAY is applied through runtime.play() — the same seam togglePlay() uses");
  assert(bridgeRegion.includes("runtime.stop()"), "PAUSE is applied through runtime.stop() — the same seam togglePlay() uses");
  assert(!bridgeRegion.includes("requestPermission"), "the bridge never calls requestPermission()");
  assert(!bridgeRegion.includes("LAUNCHPAD_READY"), "no LAUNCHPAD_READY acknowledgement is sent — deliberately left as future only");
  assert(!bridgeRegion.includes("postMessage("), "the bridge never posts a message back to StreamLoop");

  assert(
    !mainSource.includes("window.top") && !mainSource.includes("window.self !== window.top"),
    "main.js never infers StreamLoop from iframe framing"
  );
}

console.log(`\n${"-".repeat(60)}`);
if (failures) {
  console.log(`FAIL  ${failures} assertion(s) failed, ${passes} passed.`);
  for (const detail of failureDetail) console.log(`  - ${detail}`);
  process.exit(1);
}
console.log(`ok    ${passes} assertion(s) passed - StreamLoop PLAY/PAUSE bridge holds.`);
