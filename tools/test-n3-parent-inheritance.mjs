#!/usr/bin/env node

import { resolveProvenParentCuration } from "../src/profile/parent-curation-inheritance.js";
import { readFile } from "node:fs/promises";

let assertions = 0;
function assert(condition, message) {
  assertions += 1;
  if (!condition) throw new Error(message);
}

const profiles = ["BEAST", "FAMILY", "CHILD"];
const roots = [
  { rootId: "master", scopeId: "scope-1", prefixFromScopeRoot: "" },
  { rootId: "near", scopeId: "scope-1", prefixFromScopeRoot: "Media/" },
  { rootId: "child", scopeId: "scope-1", prefixFromScopeRoot: "Media/Favorites/" },
  { rootId: "foreign", scopeId: "scope-2", prefixFromScopeRoot: "" },
];
const libraries = [
  { id: "master", libraryId: "shared-master", profileId: "BEAST" },
  { id: "near", libraryId: "shared-near", profileId: "BEAST" },
  { id: "child", libraryId: null, profileId: null },
  { id: "foreign", libraryId: "shared-foreign", profileId: "FAMILY" },
];
const associations = {
  "shared-master": { v: "BEAST" },
  "shared-near": { v: "FAMILY" },
  "shared-foreign": { v: "FAMILY" },
};

function resolve(overrides = {}) {
  return resolveProvenParentCuration({
    currentRootId: "child",
    currentRoot: roots[2],
    roots,
    libraries,
    associations,
    knownProfileIds: profiles,
    ...overrides,
  });
}

const nearest = resolve();
assert(nearest?.ancestorRootId === "near", "the nearest proven ancestor wins");
assert(nearest?.profileId === "FAMILY", "the nearest ancestor's explicit Curation is selected");

assert(resolve({
  libraries: libraries.map((row) => row.id === "child" ? { ...row, profileId: "CHILD" } : row),
}) === null, "an existing local folder association outranks inheritance");

assert(resolve({
  libraries: libraries.map((row) => row.id === "child" ? { ...row, libraryId: "shared-child" } : row),
  associations: { ...associations, "shared-child": { v: "CHILD" } },
}) === null, "an explicit shared Curation outranks inheritance");

assert(resolve({
  libraries: libraries.map((row) => row.id === "child" ? { ...row, libraryId: "shared-child" } : row),
  associations: { ...associations, "shared-child": { v: null } },
}) === null, "an explicit No Curation fact outranks inheritance");

assert(resolve({
  currentRoot: { ...roots[2], scopeId: "scope-unknown" },
}) === null, "UNKNOWN or absent ancestry cannot inherit");

assert(resolve({
  roots: roots.map((root) => root.rootId === "near" ? { ...root, prefixFromScopeRoot: "Other/" } : root),
})?.ancestorRootId === "master", "an unrelated prefix is ignored while a proven farther ancestor remains eligible");

assert(resolve({
  associations: { ...associations, "shared-near": { v: null } },
})?.ancestorRootId === "master", "an unassociated nearer folder does not hide a farther explicit ancestor");

assert(resolve({
  associations: { ...associations, "shared-near": { v: "MISSING" } },
})?.ancestorRootId === "master", "an unavailable Curation is never inherited");

assert(resolve({
  roots: roots.filter((root) => root.rootId === "child" || root.rootId === "foreign"),
}) === null, "peer scope presence alone is not ancestry evidence");

const mainSource = await readFile(new URL("../src/main.js", import.meta.url), "utf8");
const scopeResolutionAt = mainSource.indexOf("const scope = await resolveScopeForRoot");
const inheritanceAt = mainSource.indexOf("await applyProvenParentCurationForLoad({ rootId, scope })");
const projectionAt = mainSource.indexOf("const index = await buildAliasIndexForLoad(request)", inheritanceAt);
assert(scopeResolutionAt >= 0 && scopeResolutionAt < inheritanceAt,
  "load integration consults N3 only after MEDIA-ID has resolved durable scope evidence");
assert(inheritanceAt < projectionAt,
  "the inherited Curation is active before the first alias projection is built");
assert(mainSource.includes('sourceKind === "fsa" && Date.now() <= loadTimePolicyDeadlineAt'),
  "only FSA proof can apply N3, and a slow proof never switches a live session");
assert(mainSource.includes("const updated = await associateThroughSyncV2(rootId, candidate.profileId)"),
  "inheritance uses the single durable association boundary instead of creating a live parent link");

console.log(`N3 parent inheritance: ${assertions} assertions passed`);
