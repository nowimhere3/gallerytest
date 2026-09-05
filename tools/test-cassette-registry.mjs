import { installFakeIndexedDB } from "./lib/browser-test-env.mjs";

const environment = installFakeIndexedDB();
const {
  addOrUpdateCassette,
  listCassettes,
  removeCassette,
  touchCassette,
} = await import("../src/storage/cassette-registry.js");

let assertions = 0;
function assert(condition, label) {
  if (!condition) throw new Error(label);
  assertions += 1;
}

function handle(identity, name, { throwsFor } = {}) {
  return {
    identity,
    name,
    async isSameEntry(other) {
      if (other?.identity === throwsFor) throw new Error("stale handle");
      return other?.identity === identity;
    },
  };
}

const first = await addOrUpdateCassette(handle("one", "One.txt"));
assert(
  JSON.stringify(Object.keys(first).sort()) ===
    JSON.stringify(["createdAt", "handle", "id", "lastOpenedAt", "name", "sourceKind"]),
  "record has exactly the approved six keys"
);
for (const forbidden of ["profileId", "libraryId", "signature", "itemCount", "removedFromRecents"]) {
  assert(!(forbidden in first), `${forbidden} is absent`);
}
assert(/^cas-\d+-[a-z0-9]+$/.test(first.id), "cassette id uses the cas namespace");
assert(!/^lib-/.test(first.id), "cassette id cannot use the library namespace");
assert(first.sourceKind === "cassette", "sourceKind is cassette from the first row");

const second = await addOrUpdateCassette(handle("two", "Two.txt"));
assert(second.id !== first.id, "independent cassettes receive unique ids");
assert((await listCassettes()).every((row) => row.sourceKind === "cassette"), "every stored row is typed cassette");

const folder = await addOrUpdateCassette(handle("folder", "My Floppies"), { sourceKind: "cassette-folder" });
assert(folder.sourceKind === "cassette-folder", "cassette folder retains its source kind");
assert(
  JSON.stringify(Object.keys(folder).sort()) ===
    JSON.stringify(["createdAt", "handle", "id", "lastOpenedAt", "name", "sourceKind"]),
  "cassette folder has exactly the approved six keys"
);
const bothKinds = await listCassettes();
assert(bothKinds.some((row) => row.sourceKind === "cassette"), "listCassettes returns ordinary cassettes");
assert(bothKinds.some((row) => row.sourceKind === "cassette-folder"), "listCassettes returns cassette folders");
assert(environment.databases.get("loop-browser-gallery-cassettes").version === 1, "cassette folder needs no database migration");

const roundTrip = (await listCassettes()).find((row) => row.id === first.id);
assert(Boolean(roundTrip?.handle), "handle survives the IndexedDB round trip");
assert(await roundTrip.handle.isSameEntry(handle("one", "Other name.txt")), "round-tripped handle preserves entry identity");

const originalCreatedAt = first.createdAt;
const deduped = await addOrUpdateCassette(handle("one", "One Renamed.txt"));
assert(deduped.id === first.id, "re-picking the same entry preserves id");
assert(deduped.createdAt === originalCreatedAt, "re-picking preserves createdAt");
assert(deduped.name === "One Renamed.txt", "re-picking refreshes the display name");
assert((await listCassettes()).length === 3, "re-picking does not create a duplicate row");

const matchedAfterThrow = await addOrUpdateCassette(handle("two", "Two Refreshed.txt", { throwsFor: "one" }));
assert(matchedAfterThrow.id === second.id, "a throwing comparison does not prevent a later stored-row match");

const throwing = handle("throwing", "Throwing.txt", { throwsFor: "one" });
const afterThrow = await addOrUpdateCassette(throwing);
assert(afterThrow.id !== first.id, "a throwing stale comparison is treated as not a match");
const throwingRepick = await addOrUpdateCassette(handle("throwing", "Throwing Renamed.txt"));
assert(throwingRepick.id === afterThrow.id, "scan continues after a throwing row and finds a later match");

await touchCassette(first.id, { openedAt: 100 });
await touchCassette(second.id, { openedAt: 300 });
await touchCassette(afterThrow.id, { openedAt: 300 });
await touchCassette(folder.id, { openedAt: 50 });
let ordered = await listCassettes();
assert(ordered[0].lastOpenedAt === 300 && ordered[1].lastOpenedAt === 300, "newest timestamps sort first");
assert(ordered[0].id.localeCompare(ordered[1].id) < 0, "timestamp ties sort by id ascending");
assert(ordered.at(-1).id === folder.id, "older timestamp sorts last");

const cassetteStore = environment.databases.get("loop-browser-gallery-cassettes").stores.get("cassettes");
cassetteStore.rows.set("cas-0-b", {
  id: "cas-0-b", sourceKind: "cassette", name: "No Time B.txt", handle: handle("no-time-b", "No Time B.txt"), createdAt: 0,
});
cassetteStore.rows.set("cas-0-a", {
  id: "cas-0-a", sourceKind: "cassette", name: "No Time A.txt", handle: handle("no-time-a", "No Time A.txt"), createdAt: 0,
});
ordered = await listCassettes();
const noTimestampIds = ordered.filter((row) => !row.lastOpenedAt).map((row) => row.id);
assert(JSON.stringify(noTimestampIds) === JSON.stringify(["cas-0-a", "cas-0-b"]), "rows without timestamps use the id tiebreak");

const beforeTouch = (await listCassettes()).find((row) => row.id === first.id);
const touched = await touchCassette(first.id, { openedAt: 999 });
assert(touched.lastOpenedAt === 999, "touchCassette updates lastOpenedAt");
assert(touched.createdAt === beforeTouch.createdAt && touched.name === beforeTouch.name, "touchCassette changes nothing else");
assert((await listCassettes())[0].id === first.id, "touchCassette affects deterministic ordering");
assert((await touchCassette("missing", { openedAt: 1 })) === null, "touching an unknown id is a safe no-op");
const touchedFolder = await touchCassette(folder.id, { openedAt: 998 });
assert(touchedFolder.sourceKind === "cassette-folder", "touch preserves cassette-folder source kind");

await removeCassette(second.id);
assert(!(await listCassettes()).some((row) => row.id === second.id), "removeCassette deletes the selected row");
assert((await listCassettes()).some((row) => row.id === first.id), "removeCassette leaves other rows intact");
await removeCassette("missing");
assert((await listCassettes()).length === 5, "removing an unknown id is a safe no-op");

assert(environment.databases.has("loop-browser-gallery-cassettes"), "cassette database uses its approved name");
assert(!environment.databases.get("loop-browser-gallery-fsa")?.stores.has("cassettes"), "cassette store is isolated from the FSA database");

console.log(`cassette registry: ${assertions} assertions passed`);
