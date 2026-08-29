#!/usr/bin/env node

import fs from "node:fs";
import {
  performReverseCurationSuggestionAction,
  resolveReverseCurationSuggestion,
} from "../src/profile/reverse-curation-suggestion.js";

let assertions = 0;
function assert(condition, message) {
  assertions += 1;
  if (!condition) throw new Error(message);
}

const roots = [
  { rootId: "parent", scopeId: "scope", prefixFromScopeRoot: "" },
  { rootId: "favorites", scopeId: "scope", prefixFromScopeRoot: "Favorites/" },
  { rootId: "clips", scopeId: "scope", prefixFromScopeRoot: "Clips/" },
  { rootId: "unknown", scopeId: "other-scope", prefixFromScopeRoot: "Maybe/" },
];
const libraries = [
  { id: "parent", libraryId: null, profileId: null },
  { id: "favorites", libraryId: "shared-favorites", profileId: "BEAST" },
  { id: "clips", libraryId: "shared-clips", profileId: "BEAST" },
  { id: "unknown", libraryId: "shared-unknown", profileId: "FAMILY" },
];
const associations = {
  "shared-favorites": { v: "BEAST" },
  "shared-clips": { v: "BEAST" },
  "shared-unknown": { v: "FAMILY" },
};

function resolve(overrides = {}) {
  return resolveReverseCurationSuggestion({
    currentRootId: "parent",
    currentRoot: roots[0],
    roots,
    libraries,
    associations,
    knownProfileIds: ["BEAST", "FAMILY"],
    deferredScopeMerges: [],
    ...overrides,
  });
}

const candidate = resolve();
assert(candidate?.profileId === "BEAST" && candidate.descendantCount === 2,
  "proven unanimous descendants produce one candidate");
assert(resolve({ associations: { ...associations, "shared-clips": { v: "FAMILY" } } }) === null,
  "conflicting descendant Curations produce no suggestion");
assert(resolve({ roots: [roots[0], roots[3]] }) === null,
  "UNKNOWN or unrelated scope membership produces no suggestion");
assert(resolve({
  libraries: libraries.map((row) => row.id === "parent" ? { ...row, profileId: "FAMILY" } : row),
}) === null, "an existing local parent association vetoes suggestion");
assert(resolve({
  libraries: libraries.map((row) => row.id === "parent" ? { ...row, libraryId: "shared-parent" } : row),
  associations: { ...associations, "shared-parent": { v: null } },
}) === null, "an explicit shared parent association, including null, vetoes suggestion");
assert(resolve({ deferredScopeMerges: ["scope-deferred"] }) === null,
  "known-incomplete scope merging vetoes suggestion");

let writes = 0;
const noResult = await performReverseCurationSuggestionAction({
  kind: "no",
  pendingSuggestion: candidate,
  getCurrentRootId: () => "parent",
  resolveCurrentSuggestion: async () => candidate,
  writeAssociation: async () => { writes += 1; return true; },
});
assert(noResult.status === "declined" && writes === 0,
  "NO leaves the parent unchanged");

const yesResult = await performReverseCurationSuggestionAction({
  kind: "yes",
  pendingSuggestion: candidate,
  getCurrentRootId: () => "parent",
  resolveCurrentSuggestion: async () => candidate,
  writeAssociation: async (profileId) => { writes += 1; return profileId === "BEAST"; },
});
assert(yesResult.status === "applied" && yesResult.wrote && writes === 1,
  "YES writes once through the injected normal association boundary");

const staleResult = await performReverseCurationSuggestionAction({
  kind: "yes",
  pendingSuggestion: candidate,
  getCurrentRootId: () => "parent",
  resolveCurrentSuggestion: async () => null,
  writeAssociation: async () => { writes += 1; return true; },
});
assert(staleResult.status === "stale" && writes === 1,
  "YES revalidates evidence and never writes a stale proposal");

const source = fs.readFileSync(new URL("../src/profile/reverse-curation-suggestion.js", import.meta.url), "utf8");
assert(!source.includes("setLibraryAssociation") && !source.includes("switchProfile"),
  "proposal policy has no direct association or Active Curation writer");

const main = fs.readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
assert(main.includes("performReverseCurationSuggestionAction")
  && main.includes("associateThroughSyncV2(rootId, profileId)"),
  "YES integration uses the existing durable association seam");
assert(!/reverseSuggestion[^\n]*associateThroughSyncV2/.test(main),
  "candidate production itself contains no upward auto-write");

const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
assert(html.includes('id="reverse-curation-offer"') && html.includes("Use the same Curation here?"),
  "the proposal is a quiet inline customer-language question");
assert((html.match(/id="reverse-curation-offer-yes"/g) || []).length === 1
  && (html.match(/id="reverse-curation-offer-no"/g) || []).length === 1,
  "YES and NO actions are singletons");
assert(main.includes("pendingReverseCurationSuggestion = null;")
  && main.includes('result.status === "declined"'),
  "NO retires the proposal for the current load context");
assert(!main.includes("switchProfile(pending.profileId)"),
  "N4 never silently changes the local Active Curation");

console.log(`N4 reverse suggestion: ${assertions} assertions passed`);
