#!/usr/bin/env node
// [NORTH-STAR / N5 / PORTABLE-STRUCTURE-EVIDENCE]

import assert from "node:assert/strict";
import { buildPortableStructureSample, isPortableStructureSample, matchPortableStructure } from "../src/storage/portable-structure-evidence.js";
import { emptyReplica, findSessionStateLeaks, setLibraryStructureSample } from "../src/profile/sync-facts.js";
import { mergeReplicas, stableStringify } from "../src/profile/sync-merge.js";
import { VERDICT } from "../src/profile/media-identity-matcher.js";

let assertions = 0;
const check = (actual, expected, message) => { assert.deepEqual(actual, expected, message); assertions += 1; };
const ok = (actual, message) => { assert.ok(actual, message); assertions += 1; };
const fact = (v, t, d) => ({ v, t, d });

const items = [
  { relativePath: "Clips/c.mp4", size: 30, handle: { local: true }, absolutePath: "/secret/c.mp4" },
  { relativePath: "a.jpg", size: 10, localRootId: "root-private" },
  { relativePath: "Favorites/b.jpg", size: 20, scopeId: "scope-private" },
];
const sample = buildPortableStructureSample(items);
check(sample, buildPortableStructureSample([...items].reverse()), "serialization is deterministic across enumeration order");
check(sample, { v: 1, count: 3, totalSize: 60, entries: [
  { path: "a.jpg", size: 10 }, { path: "Clips/c.mp4", size: 30 }, { path: "Favorites/b.jpg", size: 20 },
] }, "only portable relative path and size facts are serialized");
ok(!/(secret|root-private|scope-private|handle|absolutePath)/.test(JSON.stringify(sample)), "local paths, handles, roots, and scopes do not leak");
check(buildPortableStructureSample([{ relativePath: "/etc/passwd", size: 1 }, { relativePath: "../escape", size: 2 }]).count, 0, "unsafe paths are refused");
ok(isPortableStructureSample(sample), "generated evidence satisfies the portable allow-list");

const a = setLibraryStructureSample(emptyReplica(), "library-beast", sample, { t: 10, d: "device-a" });
const b = setLibraryStructureSample(emptyReplica(), "library-beast", { ...sample, totalSize: 61 }, { t: 20, d: "device-b" });
b.structure["library-beast"].children = { Favorites: fact("library-favorites", 12, "device-b") };
check(mergeReplicas(a, b), mergeReplicas(b, a), "portable structure merge is commutative");
const merged = mergeReplicas(a, b);
check(mergeReplicas(merged, merged), merged, "portable structure merge is idempotent");
check(merged.structure["library-beast"].sample.v.totalSize, 61, "newest sample fact wins");
check(merged.structure["library-beast"].children.Favorites.v, "library-favorites", "portable child facts converge independently");
check(findSessionStateLeaks(merged), [], "valid structure and existing facts pass the replica allow-list");

const leaking = structuredClone(merged);
leaking.structure["library-beast"].sample.v.entries[0].handle = {};
ok(findSessionStateLeaks(leaking).some((path) => path.includes("invalid portable sample")), "strict shape guard rejects handle fields");
const absolute = structuredClone(merged);
absolute.structure["library-beast"].sample.v.entries[0].path = "/private/photo.jpg";
ok(findSessionStateLeaks(absolute).length > 0, "strict shape guard rejects absolute paths");

const structure = {
  "library-beast": { sample: fact(sample, 10, "device-a"), children: {} },
};
let result = matchPortableStructure({ currentSample: sample, structure });
check(result.verdict, VERDICT.RESOLVED, "three size-corroborated paths produce a strong candidate");
check(result.libraryId, "library-beast", "resolved evidence exposes the peer library candidate for later N2 policy");
result = matchPortableStructure({ currentSample: buildPortableStructureSample([{ relativePath: "a.jpg", size: 999 }, ...items.slice(1)]), structure });
check(result.verdict, VERDICT.REFUSED_VETOED, "a size contradiction remains a safety refusal");
const ambiguous = { ...structure, "library-copy": { sample: fact(sample, 11, "device-b"), children: {} } };
result = matchPortableStructure({ currentSample: sample, structure: ambiguous });
check(result.verdict, VERDICT.REFUSED_AMBIGUOUS, "multiple equally strong candidates remain ambiguous");
check(result.libraryId, null, "ambiguity never selects a library");
result = matchPortableStructure({ currentSample: buildPortableStructureSample(items.slice(0, 2)), structure });
check(result.verdict, VERDICT.REFUSED_UNCORROBORATED, "fewer than the existing T2 corroboration threshold licenses nothing");

// Existing facts remain byte-for-byte present beside the new top-level map.
let compatible = emptyReplica();
compatible.profiles.p = { name: fact("BEAST", 1, "device-a"), items: {}, tags: {} };
compatible.associations.l = fact("p", 2, "device-a");
compatible.libraries.l = { name: fact("Media", 3, "device-a") };
compatible = setLibraryStructureSample(compatible, "l", sample, { t: 4, d: "device-a" });
const roundTrip = JSON.parse(stableStringify(compatible));
check(roundTrip.profiles.p.name.v, "BEAST", "existing Profile facts remain compatible");
check(roundTrip.associations.l.v, "p", "existing association facts remain compatible");
check(roundTrip.libraries.l.name.v, "Media", "existing Library facts remain compatible");

console.log(`N5 portable structure evidence: PASS (${assertions} assertions)`);
