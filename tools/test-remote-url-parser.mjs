import { readFile } from "node:fs/promises";
import { extractRemoteUrls } from "../src/providers/remote-url-parser.js";

let assertions = 0;
function assert(condition, label) {
  if (!condition) throw new Error(label);
  assertions += 1;
}

const fixtureDirectory = new URL("./remote-fixtures/", import.meta.url);
async function fixture(name) {
  return readFile(new URL(name, fixtureDirectory), "utf8");
}

const expectedTwenty = Array.from(
  { length: 20 },
  (_, index) => `https://cdn.example.com/images/${String(index + 1).padStart(2, "0")}.jpg`
);

const cases = [
  ["01-one-image.txt", 1, { totalLines: 1, blank: 0, rejected: 0, duplicates: 0 }],
  ["02-twenty-images.txt", 20, { totalLines: 20, blank: 0, rejected: 0, duplicates: 0 }],
  ["03-duplicates.txt", 3, { totalLines: 6, blank: 0, rejected: 0, duplicates: 3 }],
  ["04-bad-lines.txt", 1, { totalLines: 9, blank: 0, rejected: 8, duplicates: 0 }],
  ["05-images-and-video.txt", 8, { totalLines: 8, blank: 0, rejected: 0, duplicates: 0 }],
  ["06-empty.txt", 0, { totalLines: 0, blank: 0, rejected: 0, duplicates: 0 }],
  ["07-mixed-whitespace.txt", 3, { totalLines: 5, blank: 2, rejected: 0, duplicates: 0 }],
];

const results = new Map();
for (const [name, expectedLength, expectedDiagnostics] of cases) {
  const result = extractRemoteUrls(await fixture(name));
  results.set(name, result);
  assert(result.urls.length === expectedLength, `${name} has the exact expected URL count`);
  assert(
    JSON.stringify(result.diagnostics) === JSON.stringify(expectedDiagnostics),
    `${name} has exact expected diagnostics`
  );
}

const twenty = results.get("02-twenty-images.txt");
assert(twenty.urls.length === 20, "the gate fixture returns exactly 20 URLs");
assert(JSON.stringify(twenty.urls) === JSON.stringify(expectedTwenty), "the gate fixture preserves exact file order");

const badLines = results.get("04-bad-lines.txt");
for (const scheme of ["javascript:", "data:", "file:", "ftp:"]) {
  assert(badLines.urls.every((url) => !url.startsWith(scheme)), `${scheme} is rejected`);
}
assert(
  badLines.urls.includes("https://cdn.example.com/media/survivor.jpg"),
  "the valid URL survives the bad-lines fixture"
);
assert(badLines.urls.every((url) => !url.includes("user:pass@")), "credential-bearing URLs are rejected");

const duplicates = results.get("03-duplicates.txt");
assert(
  JSON.stringify(duplicates.urls) ===
    JSON.stringify([
      "https://cdn.example.com/media/alpha.jpg",
      "https://cdn.example.com/media/beta.jpg",
      "https://cdn.example.com/media/gamma.jpg",
    ]),
  "duplicates preserve first occurrences and their order"
);
assert(duplicates.diagnostics.duplicates === 3, "duplicate count is exact");

const repeatedText = await fixture("05-images-and-video.txt");
assert(
  JSON.stringify(extractRemoteUrls(repeatedText)) === JSON.stringify(extractRemoteUrls(repeatedText)),
  "identical input is idempotent"
);

for (const [input, label] of [
  ["", "empty string"],
  [" \t\r\n  ", "whitespace-only string"],
  [null, "null"],
  [undefined, "undefined"],
]) {
  const result = extractRemoteUrls(input);
  assert(result.urls.length === 0, `${label} returns no URLs without throwing`);
}

const preserved = "  HTTP://CDN.EXAMPLE.COM/%7efile.jpg?b=2&a=1#KeepMe  ";
assert(
  extractRemoteUrls(preserved).urls[0] === preserved.trim(),
  "accepted URLs preserve exact trimmed input rather than constructor canonicalization"
);

const bareCarriageReturns = extractRemoteUrls(
  "https://cdn.example.com/a.jpg\rhttps://cdn.example.com/b.jpg\r"
);
assert(bareCarriageReturns.urls.length === 2, "bare carriage-return line endings are supported");
assert(bareCarriageReturns.diagnostics.totalLines === 2, "a trailing line ending adds no phantom line");

const embedded = extractRemoteUrls("log: fetched https://cdn.example.com/inside.jpg successfully");
assert(embedded.urls.length === 0, "URLs buried in log text are rejected");
assert(embedded.diagnostics.rejected === 1, "buried URL rejection is diagnosed");

const localhost = extractRemoteUrls("http://localhost:8080/test.jpg\nhttp://192.168.1.2/test.jpg");
assert(localhost.urls.length === 2, "localhost and private-network URLs remain allowed in Phase 1A");

console.log(`remote URL parser: ${assertions} assertions passed`);
