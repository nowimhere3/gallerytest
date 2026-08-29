#!/usr/bin/env node
// [STREAMLOOP-INTEGRATION / N6-6]
// [WHY: parseLaunchContext() (launch-context.js) is the ENTIRE mechanism
//  Browser Gallery uses to recognize an explicit StreamLoop launch — a pure
//  function over a query string, deliberately with no access to window.top,
//  referrer, or user agent. This file proves the exact decision table from
//  the N6-5 handoff's Part 1.]
//
// Usage:  node tools/test-launch-context.mjs

import { pathToFileURL } from "node:url";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const src = (rel) => pathToFileURL(path.join(ROOT, "src", rel)).href;

const { parseLaunchContext, LAUNCH_CONTEXT_BROWSER, LAUNCH_CONTEXT_STREAMLOOP } = await import(src("runtime/launch-context.js"));

let failures = 0;
let passes = 0;
const failureDetail = [];

function assert(condition, label, detail) {
  if (condition) {
    passes++;
    return true;
  }
  failures++;
  failureDetail.push(`${label}${detail ? `\n        ${detail}` : ""}`);
  console.log(`  FAIL  ${label}`);
  if (detail) console.log(`        ${detail}`);
  return false;
}

function assertEqual(actual, expected, label) {
  return assert(
    actual === expected,
    label,
    actual === expected ? null : `expected: ${JSON.stringify(expected)}\n        actual:   ${JSON.stringify(actual)}`
  );
}

assertEqual(LAUNCH_CONTEXT_BROWSER, "browser", "LAUNCH_CONTEXT_BROWSER is 'browser'");
assertEqual(LAUNCH_CONTEXT_STREAMLOOP, "streamloop", "LAUNCH_CONTEXT_STREAMLOOP is 'streamloop'");

console.log("\n1. ?launch=streamloop -> streamloop");
assertEqual(parseLaunchContext("?launch=streamloop"), LAUNCH_CONTEXT_STREAMLOOP, "exact match");

console.log("\n2. value is case-insensitive");
assertEqual(parseLaunchContext("?launch=STREAMLOOP"), LAUNCH_CONTEXT_STREAMLOOP, "all caps matches");
assertEqual(parseLaunchContext("?launch=StreamLoop"), LAUNCH_CONTEXT_STREAMLOOP, "mixed case matches");

console.log("\n3. param name is exact — a typo never matches");
assertEqual(parseLaunchContext("?launch=streemloop"), LAUNCH_CONTEXT_BROWSER, "misspelled value falls back to browser");
assertEqual(parseLaunchContext("?launcher=streamloop"), LAUNCH_CONTEXT_BROWSER, "misspelled param name falls back to browser");

console.log("\n4. missing / empty / undefined -> browser");
assertEqual(parseLaunchContext(""), LAUNCH_CONTEXT_BROWSER, "empty string falls back to browser");
assertEqual(parseLaunchContext(undefined), LAUNCH_CONTEXT_BROWSER, "undefined falls back to browser");
assertEqual(parseLaunchContext(null), LAUNCH_CONTEXT_BROWSER, "null falls back to browser");
assertEqual(parseLaunchContext("?foo=bar"), LAUNCH_CONTEXT_BROWSER, "unrelated param, no launch key, falls back to browser");
assertEqual(parseLaunchContext("?launch="), LAUNCH_CONTEXT_BROWSER, "launch present but empty falls back to browser");

console.log("\n5. duplicate param — first occurrence wins (URLSearchParams default)");
assertEqual(parseLaunchContext("?launch=streamloop&launch=browser"), LAUNCH_CONTEXT_STREAMLOOP, "first 'streamloop' wins over a later 'browser'");
assertEqual(parseLaunchContext("?launch=browser&launch=streamloop"), LAUNCH_CONTEXT_BROWSER, "first 'browser' wins over a later 'streamloop'");

console.log("\n6. malformed query strings never throw");
assert(
  (() => {
    try {
      parseLaunchContext("%%%not-a-valid-query%%%");
      return true;
    } catch {
      return false;
    }
  })(),
  "a malformed query string does not throw"
);
assertEqual(parseLaunchContext("%%%not-a-valid-query%%%"), LAUNCH_CONTEXT_BROWSER, "a malformed query string resolves to browser, not streamloop");

console.log("\n7. surrounding whitespace on the value is tolerated");
assertEqual(parseLaunchContext("?launch=%20streamloop%20"), LAUNCH_CONTEXT_STREAMLOOP, "leading/trailing whitespace on the value is trimmed");

console.log("\n8. window.top / iframe framing never appears in parseLaunchContext()'s own code");
{
  const fs = await import("node:fs");
  const source = fs.readFileSync(path.join(ROOT, "src/runtime/launch-context.js"), "utf8");
  const fnStart = source.indexOf("export function parseLaunchContext(");
  const fnEnd = source.indexOf("\n}\n", fnStart);
  const fnBody = source.slice(fnStart, fnEnd);
  assert(!fnBody.includes("window."), "parseLaunchContext() never references window.* — it only reads the `search` string handed to it");
  assert(!fnBody.includes("referrer"), "parseLaunchContext() never references document.referrer");
  assert(!/user.?agent/i.test(fnBody), "parseLaunchContext() never references user agent");
}

console.log(`\n${"-".repeat(60)}`);
if (failures) {
  console.log(`FAIL  ${failures} assertion(s) failed, ${passes} passed.`);
  for (const detail of failureDetail) console.log(`  - ${detail}`);
  process.exit(1);
}
console.log(`ok    ${passes} assertion(s) passed - launch context contract holds.`);
