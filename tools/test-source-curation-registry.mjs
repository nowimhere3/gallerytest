import { installFakeIndexedDB } from "./lib/browser-test-env.mjs";

const environment = installFakeIndexedDB();
const Registry = await import("../src/storage/source-curation-registry.js");

let assertions = 0;
function assert(condition, label) {
  if (!condition) throw new Error(label);
  assertions += 1;
}
async function rejects(operation, label) {
  let rejected = false;
  try { await operation(); } catch { rejected = true; }
  assert(rejected, label);
}

assert(Object.keys(Registry).sort().join("|") === [
  "clearSourceCuration", "getSourceCuration", "listSourceCurations", "setSourceCuration",
].join("|"), "registry exports only the approved API");

const diskId = "cassette:cas-1725412345678-a1b2c3";
const folderId = "cassette:cas-1725412345678-folder";
const disk = await Registry.setSourceCuration(diskId, "prof-gallery", { sourceKind: "cassette" });
assert(disk.profileId === "prof-gallery", "namespaced cassette set returns the profile id");
assert((await Registry.getSourceCuration(diskId)).profileId === "prof-gallery", "cassette profile id round-trips");
assert(disk.sourceKind === "cassette", "cassette source kind round-trips");
assert(typeof disk.updatedAt === "number" && disk.updatedAt > 0, "set records an update timestamp");
assert(Object.keys(disk).sort().join("|") === "profileId|sourceId|sourceKind|updatedAt", "record shape is exactly four fields");

await Registry.setSourceCuration(folderId, "prof-folder", { sourceKind: "cassette-folder" });
const folder = await Registry.getSourceCuration(folderId);
assert(folder.profileId === "prof-folder", "remembered cassette-folder profile id can be recalled");
assert(folder.sourceKind === "cassette-folder", "cassette-folder source kind round-trips");

assert(await Registry.getSourceCuration("cassette:cas-unknown") === null, "unknown source returns null");
await rejects(() => Registry.getSourceCuration("cas-bare"), "bare cassette id is rejected");
await rejects(() => Registry.setSourceCuration("cassette:wrong", "prof-x", { sourceKind: "cassette" }),
  "invalid namespaced id is rejected");

let rows = await Registry.listSourceCurations();
assert(rows.length === 2, "list returns current association rows");
assert(rows.some((row) => row.sourceId === diskId) && rows.some((row) => row.sourceId === folderId),
  "list identifies both remembered source types");

await Registry.setSourceCuration(diskId, null, { sourceKind: "cassette" });
assert(await Registry.getSourceCuration(diskId) === null, "null profile clears instead of storing an empty row");
assert((await Registry.listSourceCurations()).length === 1, "null clear removes the row from the list");

await Registry.clearSourceCuration(folderId);
assert(await Registry.getSourceCuration(folderId) === null, "explicit clear removes the association");
assert((await Registry.listSourceCurations()).length === 0, "forget cleanup leaves no orphan row");

assert(environment.databases.has("loop-browser-gallery-source-curation"), "source-curation database uses its approved name");
const database = environment.databases.get("loop-browser-gallery-source-curation");
assert(database.version === 1, "database version is one");
assert(database.stores.has("associations"), "database owns the associations store");
assert(database.stores.get("associations").keyPath === "sourceId", "associations are keyed by sourceId");
assert(!environment.databases.has("loop-browser-gallery-cassettes"), "source-curation database is distinct from cassette storage");

// A one-shot source never calls setSourceCuration because it has no cassette record id.
assert((await Registry.listSourceCurations()).length === 0, "one-shot source creates no persisted association");

await Registry.setSourceCuration(diskId, "prof-recalled", { sourceKind: "cassette" });
await Registry.setSourceCuration(folderId, "prof-folder-recalled", { sourceKind: "cassette-folder" });
assert((await Registry.getSourceCuration(diskId)).profileId === "prof-recalled",
  "remembered cassette reopen can recall its profile id");
assert((await Registry.getSourceCuration(folderId)).profileId === "prof-folder-recalled",
  "remembered cassette-folder reopen can recall its profile id");

console.log(`source-curation registry: ${assertions} assertions passed`);
