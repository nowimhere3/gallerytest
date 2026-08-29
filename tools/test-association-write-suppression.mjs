import { createAssociationWriteSuppression } from "../src/profile/association-write-suppression.js";
import { installFakeIndexedDB, settle } from "./lib/browser-test-env.mjs";

let assertions = 0;
function assert(condition, message) {
  assertions += 1;
  if (!condition) throw new Error(message);
}

const localId = "local-nature";
const sharedId = "shared-nature";
const authored = { v: "profile-hardcore", t: 41, d: "device-here" };
const remote = { v: "profile-wildlife", t: 42, d: "device-away" };

// Refresh before, during, and after the authoritative write all identify the
// same-tab operation without relying on a timer or callback ordering.
{
  const reevaluations = [];
  const guard = createAssociationWriteSuppression({ onIntentClosed: (value) => reevaluations.push(value) });
  guard.setLoadedLibrary(localId);
  const token = guard.beginIntent(localId);
  assert(guard.shouldSuppress({ localLibraryId: localId, libraryId: sharedId, fact: null }),
    "the open intent suppresses a refresh that still sees the old fact");
  assert(guard.shouldSuppress({ localLibraryId: localId, libraryId: sharedId, fact: authored }),
    "the open intent suppresses a refresh that already sees the authored fact");
  assert(guard.captureAuthoredFact(token, sharedId, authored), "a successful write captures its fact identity");
  assert(guard.endIntent(token), "the matching intent token closes successfully");
  assert(reevaluations.length === 1, "closing the intent triggers exactly one authoritative re-evaluation");
  assert(reevaluations[0].libraryId === sharedId, "the re-evaluation names the authored shared Library");
  assert(guard.shouldSuppress({ localLibraryId: localId, libraryId: sharedId, fact: authored }),
    "the exact authored fact remains suppressed after the intent closes");
}

// Success clears the intent: a different fact must immediately be ambient.
{
  const guard = createAssociationWriteSuppression();
  const token = guard.beginIntent(localId);
  guard.captureAuthoredFact(token, sharedId, authored);
  guard.endIntent(token);
  assert(!guard.shouldSuppress({ localLibraryId: localId, libraryId: sharedId, fact: remote }),
    "a different or newer fact is never mistaken for this tab's authored fact");
  assert(!guard.endIntent(token), "an already-cleared success token cannot close twice");
}

// A thrown/failed write still clears intent in the caller's finally path.
{
  let reevaluations = 0;
  const guard = createAssociationWriteSuppression({ onIntentClosed: () => { reevaluations += 1; } });
  const token = guard.beginIntent(localId);
  guard.endIntent(token);
  assert(!guard.shouldSuppress({ localLibraryId: localId, libraryId: sharedId, fact: remote }),
    "failed-write cleanup clears the open intent without inventing an authored fact");
  assert(reevaluations === 1, "failed-write cleanup still schedules one authoritative re-evaluation");
}

// A remote transition arriving inside the intent window is deferred, not lost.
{
  let reevaluate = null;
  const observed = [];
  const guard = createAssociationWriteSuppression({ onIntentClosed: () => reevaluate?.() });
  guard.setLoadedLibrary(localId);
  const token = guard.beginIntent(localId);
  guard.captureAuthoredFact(token, sharedId, authored);
  let authoritative = remote;
  reevaluate = () => {
    if (!guard.shouldSuppress({ localLibraryId: localId, libraryId: sharedId, fact: authoritative })) {
      observed.push(authoritative.v);
    }
  };
  assert(guard.shouldSuppress({ localLibraryId: localId, libraryId: sharedId, fact: remote }),
    "a remote transition is temporarily suppressed while intent is open");
  guard.endIntent(token);
  assert(observed.length === 1 && observed[0] === "profile-wildlife",
    "intent close re-evaluates and exposes the different remote transition");
}

// Suppression belongs to one loaded local row and cannot leak across loads.
{
  const guard = createAssociationWriteSuppression();
  const token = guard.beginIntent(localId);
  guard.captureAuthoredFact(token, sharedId, authored);
  guard.endIntent(token);
  assert(guard.setLoadedLibrary("local-portraits"), "a different loaded Library resets transient state");
  assert(!guard.shouldSuppress({ localLibraryId: "local-portraits", libraryId: sharedId, fact: authored }),
    "authored identity from the previous Library is cleared on context change");
  assert(guard.setLoadedLibrary(null), "unload clears the loaded-Library context");
  assert(!guard.shouldSuppress({ localLibraryId: localId, libraryId: sharedId, fact: authored }),
    "no suppression remains after unload");
}

// [SYNCV3 / STAGE-09 / SELF-WRITE-SUPPRESSION-RACE-AUDIT]
// [WHY: this exercises the real ProfileStore boundary, not only the pure guard.
// The association-store save is paused after L enters memory, then a newer R is
// adopted before the local operation returns. The optional result must still
// carry L, or main.js would permanently label R as this tab's own fact.]
{
  installFakeIndexedDB();
  const { ProfileStore } = await import("../src/profile/profile-store.js");
  const LibraryRegistry = await import("../src/storage/library-registry.js");

  let releaseLocalSave;
  let localSaveStartedResolve;
  const localSaveStarted = new Promise((resolve) => { localSaveStartedResolve = resolve; });
  let saveCount = 0;
  const associationStore = {
    id: "stage09-race-audit",
    async load() { return {}; },
    async save() {
      saveCount += 1;
      if (saveCount !== 1) return;
      localSaveStartedResolve();
      await new Promise((resolve) => { releaseLocalSave = resolve; });
    },
  };
  let tick = 100;
  const identity = {
    ready: Promise.resolve(),
    deviceId: "device-local",
    displayName: "Local",
    tick() { return { t: ++tick, d: "device-local" }; },
    observeReplica() { return this; },
    async flush() {},
  };
  const channel = { available: false, post() {}, setHandler() {}, close() {} };
  const store = new ProfileStore({ identity, associationStore, localStateChannel: channel });
  await settle();
  await store.whenAssociationsSettled();

  const handle = { name: "Nature", kind: "directory" };
  handle.isSameEntry = async (other) => other === handle;
  const row = await LibraryRegistry.addOrUpdateLibrary(handle);

  const localWrite = store.setLibraryAssociation(row.id, "profile-local", { includeAuthoredFact: true });
  await localSaveStarted;
  const linkedRow = await LibraryRegistry.getLibraryById(row.id);
  const remoteFact = { v: "profile-remote", t: 999, d: "device-remote" };
  await store.adoptMergedReplica({
    schemaVersion: 3,
    profiles: {},
    associations: { [linkedRow.libraryId]: remoteFact },
    libraries: {},
  });
  releaseLocalSave();

  const writeResult = await localWrite;
  assert(writeResult.libraryId === linkedRow.libraryId, "race result preserves the shared Library id");
  assert(writeResult.authoredFact.v === "profile-local", "race result returns local L, not current remote R");
  assert(writeResult.authoredFact.t === 101 && writeResult.authoredFact.d === "device-local",
    "race result returns the exact locally minted (t,d)");
  assert(store.getAssociations()[linkedRow.libraryId].v === "profile-remote",
    "newer remote R is authoritative when the local operation completes");

  const seen = [];
  const guard = createAssociationWriteSuppression({
    onIntentClosed: () => {
      const current = store.getAssociations()[linkedRow.libraryId];
      if (!guard.shouldSuppress({ localLibraryId: row.id, libraryId: linkedRow.libraryId, fact: current })) {
        seen.push(current.v);
      }
    },
  });
  const token = guard.beginIntent(row.id);
  guard.captureAuthoredFact(token, writeResult.libraryId, writeResult.authoredFact);
  assert(guard.shouldSuppress({ localLibraryId: row.id, libraryId: linkedRow.libraryId, fact: writeResult.authoredFact }),
    "local authored L itself remains suppressed");
  guard.endIntent(token);
  assert(seen.length === 1 && seen[0] === "profile-remote",
    "post-intent authoritative re-evaluation exposes R rather than suppressing it");
}

console.log(`association write suppression: ${assertions} assertions passed`);
