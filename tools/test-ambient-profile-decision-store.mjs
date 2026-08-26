import { installFakeIndexedDB, settle } from "./lib/browser-test-env.mjs";

const DATABASE_NAME = "loop-browser-gallery";
const DECISION_STORE_NAME = "ambient-profile-decisions";

let assertions = 0;
function assert(condition, message) {
  assertions += 1;
  if (!condition) throw new Error(message);
}

function equal(actual, expected, message) {
  assert(JSON.stringify(actual) === JSON.stringify(expected), message);
}

function openRaw(version, onUpgrade = null) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, version);
    request.onupgradeneeded = (event) => onUpgrade?.(request.result, request.transaction, event);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Raw database open failed."));
  });
}

function complete(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error("Raw transaction failed."));
    transaction.onabort = () => reject(transaction.error || new Error("Raw transaction aborted."));
  });
}

async function putRaw(database, storeName, value) {
  const transaction = database.transaction(storeName, "readwrite");
  transaction.objectStore(storeName).put(value);
  await complete(transaction);
}

function decision(libraryId, kind, observedValue, t = 123) {
  return { libraryId, kind, observedValue, stamp: { t, d: "device-A" }, decidedAt: 1_700_000_000_000 + t };
}

// Import once; every API call resolves globalThis.indexedDB at execution time,
// so each test can install an isolated real upgrade/reopen fixture.
const Storage = await import("../src/profile/indexeddb.js");

// Fresh v3 database: all three stores exist and decisions begin empty.
{
  const env = installFakeIndexedDB();
  assert(await Storage.loadAmbientProfileDecision("missing") === null, "fresh decision store returns null for absence");
  const db = env.databases.get(DATABASE_NAME);
  assert(db.version === 3, "fresh Profile database opens at v3");
  assert(db.stores.has("profiles"), "fresh v3 database contains profiles");
  assert(db.stores.has("registry"), "fresh v3 database contains registry");
  assert(db.stores.has(DECISION_STORE_NAME), "fresh v3 database contains the decision store");
  assert(db.stores.get(DECISION_STORE_NAME).rows.size === 0, "fresh decision store begins empty");
}

// [SYNCV3 / STAGE-09 / LOCAL-DECISION-STORE]
// [WHY: build an actual v2 database first, then let current code perform its
// normal v3 open. This catches the dangerous upgrade regression: re-running the
// old v1 migration or rewriting either existing row while adding the new store.]
{
  const env = installFakeIndexedDB();
  const profileRow = {
    id: "profile-existing",
    items: { "Nature/bird.jpg": { favorite: true, customLocalField: "preserve-me" } },
    tags: [{ id: "tag-wild", name: "Wild" }],
    facts: { items: {}, tags: {} },
  };
  const registryRow = {
    id: "registry",
    activeProfileId: "profile-existing",
    profiles: [{ id: "profile-existing", name: "Existing", masterFolder: null, createdAt: 10, updatedAt: 20 }],
  };
  const v2 = await openRaw(2, (database) => {
    database.createObjectStore("profiles", { keyPath: "id" });
    database.createObjectStore("registry", { keyPath: "id" });
  });
  await putRaw(v2, "profiles", profileRow);
  await putRaw(v2, "registry", registryRow);
  v2.close();

  assert(await Storage.loadAmbientProfileDecision("none") === null, "v2 -> v3 decision store starts empty");
  const upgraded = env.databases.get(DATABASE_NAME);
  assert(upgraded.version === 3, "v2 database upgrades additively to v3");
  assert(upgraded.stores.has(DECISION_STORE_NAME), "v2 -> v3 creates the decision store");
  equal([...upgraded.stores.get("profiles").rows.values()][0], profileRow, "v2 -> v3 preserves Profile row exactly");
  equal([...upgraded.stores.get("registry").rows.values()][0], registryRow, "v2 -> v3 preserves registry row exactly");
  assert(upgraded.stores.get(DECISION_STORE_NAME).rows.size === 0, "migration invents no decision rows");
}

// Round trip all kinds, strict allow-listing, overwrite, and Library isolation.
{
  installFakeIndexedDB();
  for (const [index, kind] of ["yes", "no", "later"].entries()) {
    const row = decision(`library-${kind}`, kind, `profile-${kind}`, 200 + index);
    const saved = await Storage.saveAmbientProfileDecision({ ...row, targetProfileId: "must-not-persist", extra: true });
    equal(saved, row, `${kind.toUpperCase()} save returns only the allow-listed row`);
    equal(await Storage.loadAmbientProfileDecision(row.libraryId), row, `${kind.toUpperCase()} round-trips exactly`);
  }

  const no = decision("library-overwrite", "no", "profile-B", 300);
  const later = decision("library-overwrite", "later", "profile-B", 301);
  await Storage.saveAmbientProfileDecision(no);
  await Storage.saveAmbientProfileDecision(later);
  equal(await Storage.loadAmbientProfileDecision("library-overwrite"), later,
    "one Library retains exactly its latest local decision row");
  equal(await Storage.loadAmbientProfileDecision("library-no"), decision("library-no", "no", "profile-no", 201),
    "overwriting one Library leaves another Library isolated");

  // Storage has no current-fact input and therefore cannot react to a restamp.
  const beforeRestamp = await Storage.loadAmbientProfileDecision("library-overwrite");
  equal(await Storage.loadAmbientProfileDecision("library-overwrite"), beforeRestamp,
    "an association restamp elsewhere cannot rewrite storage");

  assert(await Storage.deleteAmbientProfileDecision("library-overwrite"), "delete reports completion");
  assert(await Storage.loadAmbientProfileDecision("library-overwrite") === null, "deleted decision is absent");
  assert(await Storage.deleteAmbientProfileDecision("library-overwrite"), "deleting an absent decision is idempotent");
}

// True API reopen: save closes its handle; a later open/load reads the durable row.
{
  const env = installFakeIndexedDB();
  const row = decision("library-reopen", "later", "profile-reopen", 400);
  await Storage.saveAmbientProfileDecision(row);
  const opensAfterSave = env.counters.open;
  equal(await Storage.loadAmbientProfileDecision(row.libraryId), row, "decision survives a separate database reopen");
  assert(env.counters.open === opensAfterSave + 1, "reopen test used a new IndexedDB open, not a retained handle");
}

// Defensive write validation: null has no Stage 09 decision UX.
{
  installFakeIndexedDB();
  const malformed = [
    null,
    decision("", "no", "profile-B"),
    decision("library-A", "maybe", "profile-B"),
    decision("library-A", "no", null),
    { ...decision("library-A", "no", "profile-B"), stamp: { t: "bad", d: "device-A" } },
    { ...decision("library-A", "no", "profile-B"), decidedAt: Number.NaN },
  ];
  for (const row of malformed) {
    let rejected = false;
    try {
      await Storage.saveAmbientProfileDecision(row);
    } catch (error) {
      rejected = error instanceof TypeError;
    }
    assert(rejected, "malformed decision is rejected before persistence");
  }
  assert(await Storage.loadAmbientProfileDecision("") === null, "invalid read key safely returns null");
  assert(await Storage.deleteAmbientProfileDecision("") === false, "invalid delete key safely returns false");
}

// Replica/export isolation is structural: those surfaces enumerate ProfileStore
// facts/records, never this independent IndexedDB store.
{
  installFakeIndexedDB();
  const sentinel = decision("library-local-decision-only", "no", "profile-local-decision-only", 500);
  await Storage.saveAmbientProfileDecision(sentinel);
  const { ProfileStore } = await import("../src/profile/profile-store.js");
  const store = new ProfileStore({
    localStateChannel: { available: false, post() {}, setHandler() {}, close() {} },
  });
  await settle();
  await store.whenFactsSettled();
  await store.whenAssociationsSettled();
  const replicaText = JSON.stringify(await store.getFullReplica());
  const exportText = store.exportText();
  assert(!replicaText.includes(sentinel.libraryId) && !replicaText.includes(sentinel.observedValue),
    "decision row never enters synchronized replica shape");
  assert(!exportText.includes(sentinel.libraryId) && !exportText.includes(sentinel.observedValue),
    "decision row never enters Profile export shape");
  equal(await Storage.loadAmbientProfileDecision(sentinel.libraryId), sentinel,
    "replica/export construction leaves the local decision intact");
}

console.log(`ambient profile decision store: ${assertions} assertions passed`);

