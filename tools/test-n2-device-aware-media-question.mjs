#!/usr/bin/env node

import fs from "node:fs";
import {
  performDeviceAwareMediaQuestionAction,
  resolveDeviceAwareMediaQuestion,
} from "../src/profile/device-aware-media-question.js";
import { buildPortableStructureSample } from "../src/storage/portable-structure-evidence.js";

let assertions = 0;
function assert(condition, message) { assertions += 1; if (!condition) throw new Error(message); }
const fact = (v) => ({ v, t: 10, d: "peer-device" });
const sample = buildPortableStructureSample([
  { relativePath: "a.jpg", size: 10 },
  { relativePath: "Clips/c.mp4", size: 30 },
  { relativePath: "Favorites/b.jpg", size: 20 },
]);
const base = {
  currentRootId: "local-root",
  currentLibrary: { id: "local-root", libraryId: null, profileId: null },
  currentSample: sample,
  structure: { peerLibrary: { children: {}, sample: fact(sample) } },
  libraries: { peerLibrary: { sourceDeviceId: fact("peer-device"), name: fact("Names are presentation only") } },
  associations: { peerLibrary: fact("BEAST") },
  knownProfileIds: ["BEAST"],
  ownDeviceId: "this-device",
};

const candidate = resolveDeviceAwareMediaQuestion(base);
assert(candidate?.libraryId === "peerLibrary" && candidate.sourceDeviceId === "peer-device",
  "one strong unique portable match produces one peer candidate");
assert(resolveDeviceAwareMediaQuestion({ ...base, structure: {} }) === null,
  "peer catalog presence without N5 evidence stays quiet");
assert(resolveDeviceAwareMediaQuestion({ ...base, currentSample: buildPortableStructureSample([
  { relativePath: "a.jpg", size: 10 }, { relativePath: "Clips/c.mp4", size: 30 },
]) }) === null, "weak evidence below T2 corroboration stays quiet");
assert(resolveDeviceAwareMediaQuestion({ ...base, structure: {
  ...base.structure, copy: { children: {}, sample: fact(sample) },
} }) === null, "ambiguous portable candidates stay quiet");
assert(resolveDeviceAwareMediaQuestion({ ...base, currentSample: buildPortableStructureSample([
  { relativePath: "a.jpg", size: 999 },
  { relativePath: "Clips/c.mp4", size: 30 },
  { relativePath: "Favorites/b.jpg", size: 20 },
]) }) === null, "content contradiction stays quiet");
assert(resolveDeviceAwareMediaQuestion({ ...base, currentLibrary: { ...base.currentLibrary, libraryId: "known" } }) === null,
  "existing shared identity outranks N2");
assert(resolveDeviceAwareMediaQuestion({ ...base, currentLibrary: { ...base.currentLibrary, profileId: "BEAST" } }) === null,
  "existing local association outranks N2");
assert(resolveDeviceAwareMediaQuestion({ ...base, ownDeviceId: "peer-device" }) === null,
  "same-device evidence never produces a device question");
assert(resolveDeviceAwareMediaQuestion({ ...base, associations: {} }) === null,
  "a candidate without an available Curation does not create a useless question");
assert(resolveDeviceAwareMediaQuestion({ ...base, libraries: {
  peerLibrary: { ...base.libraries.peerLibrary, name: fact("Completely Different Name") },
} })?.libraryId === "peerLibrary", "folder/catalog names do not affect identity evidence");

let links = 0;
const no = await performDeviceAwareMediaQuestionAction({
  kind: "no", pendingQuestion: candidate, getCurrentRootId: () => "local-root",
  resolveCurrentQuestion: async () => candidate,
  linkLocalLibrary: async () => { links += 1; return {}; },
});
assert(no.status === "declined" && links === 0, "NO does not bind the current media");
const yes = await performDeviceAwareMediaQuestionAction({
  kind: "yes", pendingQuestion: candidate, getCurrentRootId: () => "local-root",
  resolveCurrentQuestion: async () => candidate,
  linkLocalLibrary: async (rootId, libraryId) => { links += 1; return rootId === "local-root" && libraryId === "peerLibrary" ? {} : null; },
});
assert(yes.status === "linked" && links === 1, "YES links once through the injected guarded identity boundary");
const stale = await performDeviceAwareMediaQuestionAction({
  kind: "yes", pendingQuestion: candidate, getCurrentRootId: () => "local-root",
  resolveCurrentQuestion: async () => null,
  linkLocalLibrary: async () => { links += 1; return {}; },
});
assert(stale.status === "stale" && links === 1, "YES revalidates evidence before linking");

const policy = fs.readFileSync(new URL("../src/profile/device-aware-media-question.js", import.meta.url), "utf8");
assert(!policy.includes("resolveDeviceName") && !policy.includes("setLibraryAssociation"),
  "candidate evidence is independent of names and has no association writer");
const main = fs.readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
assert(main.includes("profileSync.resolveDeviceName(candidate.sourceDeviceId)"),
  "device name resolution is presentation-only after candidate production");
assert(main.includes("profile.linkLocalLibraryToShared(localRootId, sharedLibraryId)"),
  "YES integration uses the existing Stage 08 guarded local-link boundary");
const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const questionMarkup = html.slice(html.indexOf('id="device-aware-media-question"'), html.indexOf('id="device-aware-media-question-result"'));
assert(questionMarkup && !questionMarkup.includes("Media Library"),
  "the N2 question is customer-facing and contains no Media Library vocabulary");

console.log(`N2 device-aware media question: ${assertions} assertions passed`);
