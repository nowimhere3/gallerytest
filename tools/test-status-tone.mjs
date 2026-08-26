import fs from "node:fs";
import { applyProductStatusTone, PRODUCT_STATUS_TONES } from "../src/profile/status-tone.js";

let assertions = 0;
function assert(condition, label) {
  if (!condition) throw new Error(label);
  assertions += 1;
}

class FakeClassList {
  constructor(...entries) { this.values = new Set(entries); }
  add(...entries) { entries.forEach((entry) => this.values.add(entry)); }
  remove(...entries) { entries.forEach((entry) => this.values.delete(entry)); }
  contains(entry) { return this.values.has(entry); }
}

assert(PRODUCT_STATUS_TONES.join(",") === "muted,active,success,warning,danger",
  "the established five-tone vocabulary is unchanged");

const element = { classList: new FakeClassList("product-status", "product-status-warning", "product-status-danger") };
applyProductStatusTone(element, "success");
assert(element.classList.contains("product-status-success"), "healthy render adds success");
assert(!element.classList.contains("product-status-warning"), "healthy render removes stale warning");
assert(!element.classList.contains("product-status-danger"), "healthy render removes stale danger");
assert(element.classList.contains("product-status"), "class swap preserves unrelated base class");

applyProductStatusTone(element, "active");
assert(element.classList.contains("product-status-active"), "next render adds active");
assert(!element.classList.contains("product-status-success"), "next render removes prior success");

applyProductStatusTone(element, "not-a-tone");
assert(element.classList.contains("product-status-muted"), "invalid mapper output fails safely to muted");
assert(PRODUCT_STATUS_TONES.filter((tone) => element.classList.contains(`product-status-${tone}`)).length === 1,
  "exactly one tone class survives every class swap");

const mainSource = fs.readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
assert(mainSource.includes("applyProductStatusTone(profileFolderLinkSummary, linkUi.tone)"),
  "This Folder rendering applies the pure link-state tone through the class-swap helper");
assert(mainSource.includes("applyProductStatusTone(profileLibraryAssociationText, associationUi.tone)"),
  "This Library rendering applies the pure association-copy tone through the class-swap helper");

console.log(`status tone rendering: ${assertions} assertions passed`);
