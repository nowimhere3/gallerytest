import fs from "node:fs";
import {
  buildAmbientProfileOfferView,
  performAmbientProfileAction,
} from "../src/profile/ambient-profile-action.js";

let assertions = 0;
function assert(condition, message) {
  assertions += 1;
  if (!condition) throw new Error(message);
}

const LOCAL = "local-nature";
const LIBRARY = "library-nature";
const A = "profile-beast";
const B = "profile-hardcore";
const C = "profile-wildlife";
const pendingB = Object.freeze({ localLibraryId: LOCAL, libraryId: LIBRARY, observedValue: B });

function harness({ factValue = B, factPresent = true, known = [A, B, C], active = A } = {}) {
  let associations = factPresent ? { [LIBRARY]: { v: factValue, t: 42, d: "device-z" } } : {};
  let activeProfileId = active;
  let context = { localLibraryId: LOCAL, libraryId: LIBRARY };
  let switchSucceeds = true;
  let saveError = null;
  const order = [];
  const switches = [];
  const saves = [];
  const run = (kind, overrides = {}) => performAmbientProfileAction({
    kind,
    pendingOffer: pendingB,
    getCurrentContext: () => context,
    getAssociations: () => associations,
    getKnownProfileIds: () => known,
    getActiveProfileId: () => activeProfileId,
    switchProfile: async (target) => {
      order.push("switch");
      switches.push(target);
      if (switchSucceeds) activeProfileId = target;
      return switchSucceeds;
    },
    saveDecision: async (record) => {
      order.push("save");
      if (saveError) throw saveError;
      saves.push(record);
      return record;
    },
    now: () => 123456,
    ...overrides,
  });
  return {
    run, order, switches, saves,
    setFact(value) { associations = { [LIBRARY]: { v: value, t: 99, d: "device-new" } }; },
    removeFact() { associations = {}; },
    setContext(value) { context = value; },
    failSwitch() { switchSucceeds = false; },
    failSave() { saveError = new Error("save failed"); },
  };
}

// Pure rendering follows pending/context and updates B -> C without carrying
// stale display authority.
{
  assert(!buildAmbientProfileOfferView().visible, "no pending offer renders hidden");
  const viewB = buildAmbientProfileOfferView({
    pendingOffer: pendingB,
    currentContext: { localLibraryId: LOCAL, libraryId: LIBRARY },
    libraryName: "Nature",
    targetName: "Hardcore",
    activeProfileName: "BEAST",
  });
  assert(viewB.visible, "pending B renders visible");
  assert(viewB.text.includes("Nature") && viewB.text.includes("Hardcore"), "render includes Library and target names");
  assert(viewB.yesLabel === "Use Hardcore" && viewB.noLabel === "Keep BEAST", "render labels state consequences");
  const viewC = buildAmbientProfileOfferView({
    pendingOffer: { ...pendingB, observedValue: C },
    currentContext: { localLibraryId: LOCAL, libraryId: LIBRARY },
    libraryName: "Nature",
    targetName: "Wildlife",
    activeProfileName: "BEAST",
  });
  assert(viewC.text.includes("Wildlife") && !viewC.text.includes("Hardcore"), "B -> C render replaces stale B copy");
  assert(!buildAmbientProfileOfferView({ pendingOffer: pendingB, currentContext: null, targetName: "Hardcore" }).visible,
    "cleared/switched Library context renders hidden");
}

// YES revalidates, switches current truth, then persists exact diagnostic fact.
{
  const h = harness();
  const result = await h.run("yes");
  assert(result.status === "applied" && result.switched, "valid YES applies and switches");
  assert(h.switches[0] === B, "YES switch target is current authoritative B");
  assert(h.order.join(",") === "switch,save", "YES switches before persistence");
  assert(h.saves[0].kind === "yes" && h.saves[0].observedValue === B, "YES persists current B");
  assert(h.saves[0].stamp.t === 42 && h.saves[0].stamp.d === "device-z", "YES persists current diagnostic stamp");
  assert(h.saves[0].decidedAt === 123456, "YES persists diagnostic decidedAt");
}
{
  const h = harness({ factValue: C });
  const result = await h.run("yes");
  assert(result.status === "stale", "stale B prompt/current C is rejected");
  assert(h.switches.length === 0 && h.saves.length === 0, "stale YES neither switches B nor saves B");
}
for (const config of [
  { factPresent: false },
  { factValue: null },
  { factValue: B, known: [A] },
  { factValue: B, active: B },
]) {
  const h = harness(config);
  const result = await h.run("yes");
  assert(result.status === "stale", "missing fact/null/missing target/already-active invalidates YES");
  assert(h.switches.length === 0 && h.saves.length === 0, "invalid YES performs no action");
}
{
  const h = harness();
  h.failSwitch();
  const result = await h.run("yes");
  assert(result.status === "switch-failed", "switch failure is explicit");
  assert(h.saves.length === 0, "failed switch never persists false YES");
}
{
  const h = harness();
  h.failSave();
  const result = await h.run("yes");
  assert(result.status === "persistence-failed" && result.switched, "YES save failure reports successful local switch");
  assert(h.switches[0] === B, "YES save failure leaves B switched locally");
}
{
  const h = harness();
  const result = await h.run("yes", {
    switchProfile: async () => {
      h.setFact(C);
      return true;
    },
  });
  assert(result.status === "stale-after-switch" && result.switched,
    "fact change during switch prevents obsolete durable YES");
  assert(h.saves.length === 0, "post-switch stale YES is not persisted");
}

for (const kind of ["no", "later"]) {
  const h = harness();
  const result = await h.run(kind);
  assert(result.status === "applied", `${kind.toUpperCase()} persists successfully`);
  assert(h.switches.length === 0, `${kind.toUpperCase()} never switches`);
  assert(h.saves[0].kind === kind && h.saves[0].observedValue === B,
    `${kind.toUpperCase()} saves current authoritative B`);

  const stale = harness({ factValue: C });
  assert((await stale.run(kind)).status === "stale", `stale ${kind.toUpperCase()} is rejected`);
  assert(stale.saves.length === 0, `stale ${kind.toUpperCase()} cannot save obsolete B`);

  const failed = harness();
  failed.failSave();
  const failure = await failed.run(kind);
  assert(failure.status === "persistence-failed" && !failure.switched,
    `${kind.toUpperCase()} persistence failure is not false success`);
}

// Library/context changes invalidate every action.
{
  const h = harness();
  h.setContext({ localLibraryId: "other-local", libraryId: "other-library" });
  assert((await h.run("later")).status === "stale", "Library switch invalidates old prompt action");
  assert(h.saves.length === 0, "Library switch cannot save old decision");
}

// Static boundaries: no association/link writer exists in the action module;
// main routes X and visible Later through one exact function and Escape defers
// when a higher-priority handler already consumed the event.
{
  const actionSource = fs.readFileSync(new URL("../src/profile/ambient-profile-action.js", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  assert(!/\bsetLibrary(?:Association|Profile)\s*\(/.test(actionSource), "action coordinator has zero association writes");
  assert(!/switchProfile\s*\(\s*(?:pendingOffer|.*observedValue)/.test(actionSource),
    "pending/display observedValue is never a switch argument");
  const observerSource = fs.readFileSync(new URL("../src/profile/ambient-profile-observer.js", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  assert(!/\bswitchProfile\s*\(/.test(observerSource), "ambient observer still has zero switchProfile calls");
  const main = fs.readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
  assert((main.match(/chooseAmbientProfileLater\(\)/g) || []).length >= 3,
    "Later, X, and Escape route through the same LATER function");
  assert(main.includes('event.key !== "Escape" || event.defaultPrevented'),
    "ambient Escape yields to higher-priority consumed Escape behavior");
}

console.log(`ambient Profile action/UI coordination: ${assertions} assertions passed`);
