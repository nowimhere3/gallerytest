import { readFile } from "node:fs/promises";
import { extractRemoteUrls } from "../src/providers/remote-url-parser.js";
import { RemoteUrlProvider } from "../src/providers/remote-url-provider.js";
import { skipDuplicateMedia } from "../src/runtime/duplicate-filter.js";
import { MediaRuntime } from "../src/runtime/media-runtime.js";

let assertions = 0;
function assert(condition, label) {
  if (!condition) throw new Error(label);
  assertions += 1;
}

const fixtureDirectory = new URL("./remote-fixtures/", import.meta.url);
async function fixture(name) {
  return readFile(new URL(name, fixtureDirectory), "utf8");
}

const classificationText = await fixture("08-classification.txt");
const classificationUrls = extractRemoteUrls(classificationText).urls;
const provider = new RemoteUrlProvider();
let result = await provider.loadFromUrls(classificationUrls);

for (const extension of ["jpg", "jpeg", "png", "webp", "gif"]) {
  assert(result.items.find((item) => item.url.endsWith(`.${extension}`))?.kind === "image", `.${extension} maps to image`);
}
for (const extension of ["mp4", "webm", "mov", "m4v"]) {
  assert(result.items.find((item) => item.url.endsWith(`.${extension}`))?.kind === "video", `.${extension} maps to video`);
}
assert(result.items.every((item) => !item.url.endsWith(".ts")), ".ts is skipped");
assert(result.items.every((item) => !item.url.endsWith("/extensionless")), "extensionless URL is skipped");
assert(
  result.items.every((item) => !item.url.includes("resource?format=jpg")),
  "classification uses pathname rather than query-string format hints"
);

const expectedKeys = [
  "id", "kind", "mediaType", "name", "path", "relativePath", "systemTags", "type", "url", "userTags",
].sort();
assert(
  JSON.stringify(Object.keys(result.items[0]).sort()) === JSON.stringify(expectedKeys),
  "remote item has the exact approved key set"
);
assert(!("size" in result.items[0]), "size is absent");
assert(!("lastModified" in result.items[0]), "lastModified is absent");

const collisions = await new RemoteUrlProvider().loadFromUrls([
  "https://cdn.example.com/a/001.jpg",
  "https://cdn.example.com/b/001.jpg",
]);
assert(collisions.items[0].name === collisions.items[1].name, "duplicate-filter test inputs share a filename");
assert(skipDuplicateMedia(collisions.items).length === 2, "duplicate filtering fails open without size metadata");

assert(result.items.every((item) => item.relativePath.startsWith("remote://")), "every remote key is namespaced");
assert(new Set(result.items.map((item) => item.relativePath)).size === result.items.length, "remote keys are unique");
assert(result.items.every((item) => item.relativePath !== "photos/example.jpg"), "remote keys cannot equal a local path");
assert(new Set(result.items.map((item) => item.id)).size === result.items.length, "session-local IDs are unique");
assert(result.items.every((item) => !item.id.includes(item.url)), "IDs do not contain complete remote URLs");
assert(result.items.every((item) => /^remote-\d+$/.test(item.id)), "IDs make only an index-based session-local claim");

const names = await new RemoteUrlProvider().loadFromUrls([
  "https://cdn.example.com/path/normal.jpg",
  "https://cdn.example.com/path/encoded%20name.png",
  "https://cdn.example.com/path/bad%ZZ.jpg",
  "https://fallback.example.com/path/",
]);
assert(names.items.find((item) => item.name === "normal.jpg")?.kind === "image", "normal pathname name is derived");
assert(names.items.some((item) => item.name === "encoded name.png"), "percent-encoded name is decoded");
assert(names.items.some((item) => item.name === "bad%ZZ.jpg"), "malformed percent escape does not throw");
assert(names.diagnostics.skipped === 1, "trailing-slash URL is safely classified as skipped");

assert(result.diagnostics.images === 6, "classification fixture reports exact image count");
assert(result.diagnostics.videos === 4, "classification fixture reports exact video count");
assert(result.diagnostics.skipped === 4, "classification fixture reports exact skipped count");
assert(
  result.diagnostics.images + result.diagnostics.videos + result.diagnostics.skipped === result.diagnostics.total,
  "classification diagnostics arithmetic is exact"
);
assert(
  collisions.diagnostics.images + collisions.diagnostics.videos + collisions.diagnostics.skipped === collisions.diagnostics.total,
  "diagnostics arithmetic holds for an all-image mix"
);

const trailingSlashOnly = await new RemoteUrlProvider().loadFromUrls(["https://fallback.example.com/"]);
assert(trailingSlashOnly.items.length === 0, "trailing slash without an extension emits no item");

const disposable = new RemoteUrlProvider();
await disposable.loadFromUrls(["https://cdn.example.com/a.jpg"]);
disposable.dispose();
assert(disposable.getItems().length === 0, "dispose clears items");

const superseded = new RemoteUrlProvider();
const staleLoad = superseded.loadFromUrls(
  ["https://cdn.example.com/old-1.jpg", "https://cdn.example.com/old-2.jpg"],
  { batchSize: 1 }
);
const newLoad = superseded.loadFromUrls(["https://cdn.example.com/new.jpg"]);
await Promise.all([staleLoad, newLoad]);
assert(superseded.getItems().length === 1, "superseded async load cannot append stale items");
assert(superseded.getItems()[0].url === "https://cdn.example.com/new.jpg", "newer load remains authoritative");

const parsedMixed = extractRemoteUrls(await fixture("05-images-and-video.txt"));
const mixed = await new RemoteUrlProvider().loadFromUrls(parsedMixed.urls);
assert(mixed.diagnostics.total === 8, "parser-to-provider fixture passes all eight valid URLs");
assert(mixed.diagnostics.images === 4, "parser-to-provider fixture reports four images");
assert(mixed.diagnostics.videos === 2, "parser-to-provider fixture reports two videos");
assert(mixed.diagnostics.skipped === 2, "parser-to-provider fixture skips two extensionless paths");
assert(mixed.items.length === 6, "parser-to-provider integration emits six supported items");

const runtime = new MediaRuntime();
runtime.load(mixed.items);
runtime.setShuffle(false);
assert(runtime.getState().total === 6, "real MediaRuntime accepts all remote items");
assert(runtime.getCurrentItem()?.url === mixed.items[0].url, "real MediaRuntime exposes the first remote item");
runtime.next();
assert(runtime.getCurrentItem()?.url === mixed.items[1].url, "real MediaRuntime advances to the next remote item");
runtime.previous();
assert(runtime.getCurrentItem()?.url === mixed.items[0].url, "real MediaRuntime returns to the previous remote item");

const copy = provider.getItems();
copy.length = 0;
assert(provider.getItems().length === 10, "getItems returns a copy rather than live provider state");

console.log(`remote URL provider: ${assertions} assertions passed`);
