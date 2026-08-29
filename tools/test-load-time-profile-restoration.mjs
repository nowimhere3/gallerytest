import fs from "node:fs";
import { applyLoadTimeProfileRestoration } from "../src/profile/load-time-profile-restoration.js";

let assertions = 0;
function assert(condition, message) {
  assertions += 1;
  if (!condition) throw new Error(message);
}

const LOCAL = "local-library";
const LIBRARY = "shared-library";
const A = "profile-a";
const B = "profile-b";
const MISSING = "profile-missing";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function setup({
  rowProfileId = A,
  libraryId = LIBRARY,
  factPresent = true,
  factValue = B,
  known = [A, B],
  active = A,
  decision = null,
} = {}) {
  let associations = factPresent ? { [LIBRARY]: { v: factValue, t: 10, d: "remote" } } : {};
  let activeProfileId = active;
  let current = true;
  const switches = [];
  const deletes = [];
  let decisionReads = 0;
  const record = { id: LOCAL, libraryId, profileId: rowProfileId, wasExisting: true };
  const run = (overrides = {}) => applyLoadTimeProfileRestoration({
    libraryRecord: record,
    getAssociations: () => associations,
    getKnownProfileIds: () => known,
    getActiveProfileId: () => activeProfileId,
    loadDecision: async () => { decisionReads += 1; return decision; },
    deleteDecision: async (id) => { deletes.push(id); return true; },
    switchProfile: async (target) => {
      switches.push(target);
      activeProfileId = target;
      return true;
    },
    isCurrent: () => current,
    ...overrides,
  });
  return {
    run, record, switches, deletes,
    get decisionReads() { return decisionReads; },
    setCurrent(value) { current = value; },
    setAssociations(value) { associations = value; },
  };
}

for (const pathName of ["legacy", "FSA"]) {
  {
    const h = setup();
    const out = await h.run();
    assert(out.switched && h.switches[0] === B, `${pathName}: no decision switches authoritative B`);
    assert(out.result.target === B, `${pathName}: resolver target is shared B`);
  }

  for (const rowProfileId of [A, B]) {
    for (const [kind, action, shouldSwitch] of [
      ["no", "skip", false],
      ["later", "skip-and-ask", false],
      ["yes", "switch", true],
    ]) {
      const h = setup({ rowProfileId, decision: { kind, observedValue: B } });
      const out = await h.run();
      assert(out.result.action === action, `${pathName}: ${kind} action ignores ${rowProfileId} projection`);
      assert(Boolean(h.switches.length) === shouldSwitch, `${pathName}: ${kind} switch behavior is exact`);
      if (shouldSwitch) assert(h.switches[0] === B, `${pathName}: YES switches shared B`);
    }
  }

  {
    const h = setup({ decision: { kind: "no", observedValue: A } });
    const out = await h.run();
    assert(out.decisionDeleted && h.deletes[0] === LIBRARY, `${pathName}: stale decision is deleted`);
    assert(h.switches[0] === B, `${pathName}: stale decision restores shared B`);
  }
  {
    const h = setup({ factValue: null });
    const out = await h.run();
    assert(out.result.action === "skip" && h.switches.length === 0,
      `${pathName}: explicit shared null never restores row A`);
  }
  {
    const h = setup({ factPresent: false, libraryId: null, active: B });
    const out = await h.run();
    assert(out.result.action === "switch" && h.switches[0] === A,
      `${pathName}: no shared fact restores remembered row A`);
    assert(h.decisionReads === 0 && h.deletes.length === 0,
      `${pathName}: Rule 0 neither reads nor clears Stage 09 decision`);
  }
  {
    const h = setup({ factPresent: false, libraryId: null, active: B });
    const out = await h.run();
    assert(out.result.reason === "local-row-restoration" && h.switches[0] === A,
      `${pathName}: Stage 08 unlink simulation preserves local restoration`);
  }
  {
    const h = setup({ factValue: MISSING, known: [A] });
    const out = await h.run();
    assert(out.result.reason === "shared-target-unusable" && h.switches.length === 0,
      `${pathName}: missing shared target preserves S4 without switch`);
  }
  {
    const h = setup({ active: B });
    const out = await h.run();
    assert(out.result.reason === "shared-target-already-active" && h.switches.length === 0,
      `${pathName}: shared target already active is not switched redundantly`);
  }
}

// clearDecision remains orthogonal for explicit null.
{
  const h = setup({ factValue: null, decision: { kind: "no", observedValue: A } });
  const out = await h.run();
  assert(out.result.action === "skip", "explicit null remains skip after stale cleanup");
  assert(out.decisionDeleted && h.deletes[0] === LIBRARY, "explicit null clears stale semantic decision");
  assert(h.switches.length === 0, "explicit null cleanup never switches row fallback");
}

// Deterministic stale load: decision read pauses, context is superseded, and
// the old continuation performs no switch/delete. Pending arming is a separate
// post-success main step and therefore also receives the same token guard.
{
  const gate = deferred();
  const h = setup({ decision: { kind: "no", observedValue: A } });
  const oldLoad = h.run({ loadDecision: async () => gate.promise });
  h.setCurrent(false);
  gate.resolve({ kind: "no", observedValue: A });
  const out = await oldLoad;
  assert(out.stale, "superseded load is reported stale after decision await");
  assert(h.switches.length === 0, "superseded load cannot switch Profile");
  assert(h.deletes.length === 0, "superseded load cannot delete a decision");
}

// The production module is used at both existing main.js restoration sites;
// observer remains execution-free.
{
  const main = fs.readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
  const callCount = (main.match(/restoreProfileForLoadedLibrary\(activeLibraryRecord, loadToken\)/g) || []).length;
  assert(callCount === 2, "legacy and FSA each invoke the one load-time restoration boundary");
  const observer = fs.readFileSync(new URL("../src/profile/ambient-profile-observer.js", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  assert(!/\bswitchProfile\s*\(/.test(observer), "ambient observer still contains zero switchProfile calls");
}

console.log(`load-time Profile restoration integration: ${assertions} assertions passed`);
