import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";
import { runIntakeMetadata } from "../src/runtime/intake-metadata.js";
import { applyLoadTimeProfileRestoration } from "../src/profile/load-time-profile-restoration.js";

let resolveDecision;
const pendingDecision = new Promise(resolve => { resolveDecision = resolve; });
let switched = false;
let warning = null;
const result = await runIntakeMetadata(current => applyLoadTimeProfileRestoration({
  libraryRecord: { id: "folder", libraryId: "shared" },
  getAssociations: () => ({ shared: { v: "family", t: 1, d: "device" } }),
  getKnownProfileIds: () => ["family", "primary"],
  getActiveProfileId: () => "primary",
  loadDecision: () => pendingDecision,
  deleteDecision: async () => {},
  switchProfile: async () => { switched = true; return true; },
  isCurrent: current,
}), { timeoutMs: 5, onUnavailable: error => { warning = error; } });
assert.equal(result, null);
assert.match(warning.message, /timed out/);
resolveDecision(null);
await new Promise(resolve => setImmediate(resolve));
assert.equal(switched, false, "timed-out decision must not activate an old source later");
assert.equal(await runIntakeMetadata(async () => "next load"), "next load", "budget does not wedge later intake");

let failures = 0;
assert.equal(await runIntakeMetadata(() => { throw new Error("metadata failed"); }, {
  onUnavailable: () => { failures++; },
}), null);
assert.equal(failures, 1);
assert.equal(await runIntakeMetadata(async current => current() ? "ready" : "stale"), "ready");
let executed = false;
assert.equal(await runIntakeMetadata(() => { executed = true; }, { isCurrent: () => false }), null);
assert.equal(executed, false, "obsolete intake must not start metadata work");
console.log("PASS intake metadata deadline, rejection, late decision cancellation and next-attempt recovery");

// Existing N3 first-paint deadline also guards asynchronous continuations.
const main = fs.readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
let finishRoots; let clock = 0; let associationsWritten = 0;
const ctx = vm.createContext({
  libraryLoadGeneration: 1, activeLibraryRecord: {id:"child"}, Date: {now:()=>clock}, console,
  listRoots: () => new Promise(resolve => { finishRoots = resolve; }),
  getLibraryById: async () => ({id:"child"}),
  resolveProvenParentCuration: () => ({profileId:"family"}),
  profile: {getAssociations:()=>({}),listProfiles:()=>[{id:"family"}]},
  associateThroughSyncV2: async () => { associationsWritten++; },
});
const start = main.indexOf("async function applyProvenParentCurationForLoad(");
const end = main.indexOf("\nasync function resolveReverseCurationSuggestionForLoad",start);
vm.runInContext(main.slice(start,end),ctx);
const parent = ctx.applyProvenParentCurationForLoad({rootId:"child",scope:{rootId:"child",scopeId:"scope"},loadTimePolicyDeadlineAt:1});
clock=2;finishRoots([{rootId:"child",scopeId:"scope"}]);
assert.equal(await parent,null);assert.equal(associationsWritten,0,"late parent proof must not write or activate after its deadline");
console.log("PASS parent Curation continuation respects the existing first-paint deadline");
