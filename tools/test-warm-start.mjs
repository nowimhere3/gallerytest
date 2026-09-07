import fs from "node:fs";
import { canApplyWarmStartRelease, shouldReleaseWarmStart } from "../src/runtime/warm-start.js";

let assertions = 0;
function assert(condition, label) {
  if (!condition) throw new Error(label);
  assertions += 1;
}

let decision = shouldReleaseWarmStart({ preparedCount: 4, readyThreshold: 3, elapsedMs: 1, maxMs: 10000 });
assert(decision.release && decision.reason === "ready", "prepared reserve above threshold releases as ready");

decision = shouldReleaseWarmStart({ preparedCount: 0, readyThreshold: 3, elapsedMs: 10001, maxMs: 10000 });
assert(decision.release && decision.reason === "timeout", "elapsed duration above maximum releases as timeout");

decision = shouldReleaseWarmStart({ preparedCount: 0, readyThreshold: 3, elapsedMs: 0, maxMs: 10000, cancelled: true });
assert(decision.release && decision.reason === "cancelled", "cancellation releases immediately");

decision = shouldReleaseWarmStart({ preparedCount: 2, readyThreshold: 3, elapsedMs: 9999, maxMs: 10000 });
assert(!decision.release && decision.reason === null, "below both thresholds does not release");

decision = shouldReleaseWarmStart({ preparedCount: 3, readyThreshold: 3, elapsedMs: 10000, maxMs: 10000, cancelled: true });
assert(decision.reason === "cancelled", "cancellation has deterministic precedence");

decision = shouldReleaseWarmStart({ preparedCount: 3, readyThreshold: 3, elapsedMs: 0, maxMs: 10000 });
assert(decision.release && decision.reason === "ready", "equality at readiness threshold releases");

const timeoutDecision = shouldReleaseWarmStart({ preparedCount: 2, readyThreshold: 3, elapsedMs: 10000, maxMs: 10000 });
assert(timeoutDecision.release && timeoutDecision.reason === "timeout", "equality at maximum duration returns timeout");

decision = shouldReleaseWarmStart({ preparedCount: 0, readyThreshold: 0, elapsedMs: 0, maxMs: 10000 });
assert(decision.release && decision.reason === "ready", "zero readiness threshold cannot hang");
assert(!canApplyWarmStartRelease({ decision: timeoutDecision, currentVisualSettled: false }), "timeout cannot release before a current visual terminal outcome");
assert(canApplyWarmStartRelease({ decision: timeoutDecision, currentVisualSettled: true }), "timeout releases once the current visual settles");
assert(canApplyWarmStartRelease({ decision: { release: true, reason: "cancelled" }, currentVisualSettled: false }), "human cancellation remains immediate");

const mainSource = fs.readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
const htmlSource = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
assert(mainSource.includes("const PLAN_LENGTH = 6;") && mainSource.includes("const MAX_PREPARED = 6;"), "six-item plan and prepared caps remain frozen");
assert(mainSource.includes("const MAX_CONCURRENT_WARMING = 2;"), "warming concurrency remains exactly two");
assert(mainSource.includes("function startArcadeAnimation(canvas)") && mainSource.includes("startArcadeAnimation(mobileLoadCanvas);"), "the existing mobile takeover passes its original canvas to the shared engine");
assert(mainSource.includes('window.matchMedia("(prefers-reduced-motion: reduce)").matches'), "the shared arcade engine retains reduced-motion handling");
assert(mainSource.includes("entry.loadGeneration === libraryLoadGeneration") && mainSource.includes("plannedItems.includes(item)"), "warm-start readiness validates generations and current plan membership");
assert((mainSource.match(/currentSessionIsUrlBacked = true;/g) || []).length === 1, "URL-backed provenance is written by one converged remote loader");
assert(htmlSource.includes("Loading a few photos ahead so your slideshow keeps playing smoothly."), "Warm Start uses the exact approved customer sentence");

console.log(`warm start: ${assertions} assertions passed`);
