#!/usr/bin/env node
// [SYNCV3 / STAGE-02 / CONTENT-ADDRESSED-DEVICE-DISCOVERY]
// [WHY: this stage changes WHERE identity comes from, and every failure it can
//  introduce is silent. A directory rename read as a new device just looks like
//  an extra peer. A filename parsed as an id just looks like a Profile that went
//  missing. A cleanup that derives identity from a readable name deletes valid
//  data immediately after a SUCCESSFUL publish, which is the worst possible
//  moment because the publish has already been reported as fine. None of that
//  surfaces in a browser until data is gone, so it is proven here instead.]
//
// Usage:  node tools/test-syncv3-transport.mjs

import { pathToFileURL } from "node:url";
import path from "node:path";
import { createVirtualDirectory, muteConsole } from "./lib/browser-test-env.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const src = (rel) => pathToFileURL(path.join(ROOT, "src", rel)).href;

const Transport = await import(src("profile/sync-v3-transport.js"));
const Names = await import(src("profile/sync-v3-names.js"));

// ---- Tiny test runner ------------------------------------------------------

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
    actual === expected ? null : `expected: ${String(expected)}\n        actual:   ${String(actual)}`
  );
}

async function test(name, fn) {
  console.log(`\n${name}`);
  try {
    await fn();
  } catch (error) {
    failures++;
    failureDetail.push(`${name} - threw: ${error && error.stack}`);
    console.log(`  FAIL  threw: ${error && error.message}`);
    console.log(String(error && error.stack).split("\n").slice(1, 4).join("\n"));
  }
}

// ---- Fixtures --------------------------------------------------------------
//
// Replicas are built as plain data rather than through ProfileStore: this module
// is a pure transport over already-stamped facts, and a fixture that dragged in
// the whole store would make a transport failure look like a store failure.

const DEVICE_A = "dev-a31f2c4e-1111-4222-8333-444455556666";
const DEVICE_B = "dev-90a84b71-7777-4888-8999-aaaabbbbcccc";
const PROFILE_BEAST = "93bc1a7d-1111-4222-8333-444455556666";
const PROFILE_BUKK = "c771a902-7777-4888-8999-aaaabbbbcccc";

function fact(value, t = 1000, d = DEVICE_A) {
  return { v: value, t, d };
}

function profileFacts(name, { favorites = [] } = {}) {
  const items = {};
  for (const pathName of favorites) items[pathName] = { favorite: fact({ on: true, at: 1000 }) };
  return { name: fact(name), items, tags: {} };
}

// [SYNCV3 / STAGE-04B / SHARED-LIBRARY-RECORD]
// [WHY: the fixture now builds the CURRENT replica shape, including the
//  libraries map. Assertions are unchanged - this is a fixture that had gone
//  stale, not a weakened check. A test comparing a read-back replica against a
//  hand-built one that omits a field the model now defines is testing the
//  fixture's age, not the transport.]
function replicaOf(profiles, associations = {}, libraries = {}) {
  return { schemaVersion: 3, profiles, associations, libraries };
}

async function devicesDirOf(dir) {
  const root = await Transport.getSyncV3Root(dir.handle, { create: true });
  return Transport.getDevicesDir(root, { create: true });
}

/** Copies every file of one device directory to another directory name, raw. */
function cloneDeviceDirectory(dir, fromName, toName) {
  const files = dir.snapshotFiles();
  const prefix = `${Transport.ROOT_DIR_NAME}/${Transport.DEVICES_DIR_NAME}/${fromName}/`;
  const target = `${Transport.ROOT_DIR_NAME}/${Transport.DEVICES_DIR_NAME}/${toName}/`;
  for (const [filePath, text] of Object.entries(files)) {
    if (!filePath.startsWith(prefix)) continue;
    dir.writeFile(`${target}${filePath.slice(prefix.length)}`, text);
  }
}

function devicePath(directoryName, rest = "") {
  return `${Transport.ROOT_DIR_NAME}/${Transport.DEVICES_DIR_NAME}/${directoryName}${rest ? `/${rest}` : ""}`;
}

function readManifest(dir, directoryName) {
  return JSON.parse(dir.readFile(devicePath(directoryName, Transport.DEVICE_FILE_NAME)));
}

function writeManifest(dir, directoryName, manifest) {
  dir.writeFile(devicePath(directoryName, Transport.DEVICE_FILE_NAME), JSON.stringify(manifest, null, 2));
}

function fileNamesUnder(dir, directoryName, sub) {
  const prefix = `${devicePath(directoryName, sub)}/`;
  return Object.keys(dir.snapshotFiles())
    .filter((p) => p.startsWith(prefix))
    .map((p) => p.slice(prefix.length))
    .sort();
}

// ============================================================================

console.log("SyncV3 Stage 02 - content-addressed device discovery + readable naming");

// ---- Naming helper contract (13-18) ---------------------------------------

await test("Naming: readable output preserves human meaning", async () => {
  assertEqual(Names.sanitizeHumanName("David's Laptop (work)"), "David's Laptop (work)", "apostrophes and parens survive");
  assertEqual(Names.sanitizeHumanName("Chromebook Pro"), "Chromebook Pro", "spaces survive (req 13)");
  assertEqual(Names.sanitizeHumanName("  spaced   out  "), "spaced out", "runs of whitespace collapse and trim");
  assertEqual(Names.buildReadableName("Chromebook", DEVICE_A), "Chromebook -- a31f2c4e", "device name shape");
  assertEqual(
    Names.buildReadableFileName("BEAST", PROFILE_BEAST),
    "BEAST -- 93bc1a7d.json",
    "profile file name shape"
  );
});

await test("Naming: unicode survives and is normalized (req 15)", async () => {
  assertEqual(Names.sanitizeHumanName("Papa's Laptop"), "Papa's Laptop", "ascii baseline");
  assertEqual(Names.sanitizeHumanName("Bibliotheque"), "Bibliotheque", "plain latin");
  // NFD "e" + combining acute normalizes to the NFC single code point.
  const nfd = "Café";
  const sanitized = Names.sanitizeHumanName(nfd);
  assertEqual(sanitized, "Café", "NFD input is normalized to NFC");
  assertEqual(Names.sanitizeHumanName("日本語の名前"), "日本語の名前", "CJK survives intact");
  assertEqual(Names.sanitizeHumanName("Photos 📷"), "Photos 📷", "astral emoji survives intact");
});

await test("Naming: separators and dot-paths cannot escape (req 16, 17)", async () => {
  const slashes = Names.sanitizeHumanName("../../etc/passwd");
  assert(!slashes.includes("/") && !slashes.includes("\\"), `no separators survive: "${slashes}"`);
  assert(!slashes.startsWith("."), `no leading dot survives: "${slashes}"`);
  assertEqual(Names.sanitizeHumanName("a\\b/c"), "a b c", "separators become spaces, words stay readable");
  assertEqual(Names.sanitizeHumanName("."), "Unnamed", "a lone dot degrades to the fallback");
  assertEqual(Names.sanitizeHumanName(".."), "Unnamed", "a lone double dot degrades to the fallback");
  assertEqual(Names.sanitizeHumanName("  ...  "), "Unnamed", "dots and spaces only degrade to the fallback");
  assertEqual(Names.sanitizeHumanName("v1.2 backup"), "v1.2 backup", "an INTERNAL dot is preserved");

  let threw = false;
  try {
    Names.assertSafePathSegment("evil/../escape");
  } catch {
    threw = true;
  }
  assert(threw, "assertSafePathSegment throws on a separator");

  threw = false;
  try {
    Names.assertSafePathSegment("..");
  } catch {
    threw = true;
  }
  assert(threw, "assertSafePathSegment throws on '..'");
});

await test("Naming: long names are bounded but keep the id suffix (req 18)", async () => {
  const long = "L".repeat(500);
  const name = Names.buildReadableName(long, DEVICE_A);
  assert(name.endsWith(" -- a31f2c4e"), `suffix retained: "${name.slice(-24)}"`);
  assert(name.length <= 64 + 4 + 8, `bounded length (${name.length})`);

  // Multi-byte: 200 CJK characters is 600 UTF-8 bytes before capping.
  const cjk = "漢".repeat(200);
  const cjkName = Names.buildReadableName(cjk, DEVICE_A);
  assert(cjkName.endsWith(" -- a31f2c4e"), "suffix retained for a multi-byte name");
  const bytes = new TextEncoder().encode(cjkName).length;
  assert(bytes <= 140, `byte length bounded (${bytes} bytes)`);

  // An emoji-only name must not be truncated into a lone surrogate half.
  const emoji = "📷".repeat(100);
  const emojiName = Names.buildReadableName(emoji, DEVICE_A);
  assert(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(emojiName), "no orphaned high surrogate after truncation");
});

await test("Naming: a source name containing the separator is harmless (req 14)", async () => {
  const name = Names.buildReadableName("A -- B", PROFILE_BEAST);
  assertEqual(name, "A -- B -- 93bc1a7d", "the human portion keeps its own dashes verbatim");
  // Nothing anywhere splits on the separator, so there is no ambiguity to
  // resolve - identity is asserted in file content and checked there.
});

await test("Naming: display suffix never mangles a hex-leading id", async () => {
  assertEqual(Names.shortDisplayId("deadbeef-1111-4222-8333-444455556666"), "deadbeef", "hex-letter first group is kept");
  assertEqual(Names.shortDisplayId(DEVICE_A), "a31f2c4e", "the dev- prefix is stripped");
  assertEqual(Names.shortDisplayId("profile-1750000000000-abc12345"), "17500000", "the profile- prefix is stripped");
  assertEqual(Names.shortDisplayId(""), "unknown", "an empty id degrades safely");
});

// ---- Layout + full-id authority (1-4) --------------------------------------

await test("Publish produces readable device and Profile names, full ids in content (req 1-4)", async () => {
  const dir = createVirtualDirectory("V3 Sync");
  const devicesDir = await devicesDirOf(dir);

  const replica = replicaOf({
    [PROFILE_BEAST]: profileFacts("BEAST", { favorites: ["clip.mp4"] }),
    [PROFILE_BUKK]: profileFacts("BUKK"),
  });

  const result = await Transport.publishOwnReplicaVerified(devicesDir, {
    deviceId: DEVICE_A,
    label: "Chromebook",
    replica,
  });

  assertEqual(result.ok, true, "publish succeeded");
  assertEqual(result.directoryName, "Chromebook -- a31f2c4e", "readable device directory name (req 1)");

  const profileFileNames = fileNamesUnder(dir, result.directoryName, Transport.PROFILES_DIR_NAME);
  assertEqual(
    profileFileNames.join(" | "),
    "BEAST -- 93bc1a7d.json | BUKK -- c771a902.json",
    "readable Profile file names (req 2)"
  );
  assert(!profileFileNames.some((n) => n.startsWith(PROFILE_BEAST)), "no full-profileId filename was written");

  const manifest = readManifest(dir, result.directoryName);
  assertEqual(manifest.deviceId, DEVICE_A, "full deviceId lives in device.json (req 3)");
  assertEqual(manifest.kind, "gallery-profile-sync-v3-device", "device manifest kind");
  const declaredBeast = manifest.profiles.find((entry) => entry.id === PROFILE_BEAST);
  assertEqual(declaredBeast.file, "profiles/BEAST -- 93bc1a7d.json", "manifest declares the readable file path");

  const profileJson = JSON.parse(dir.readFile(devicePath(result.directoryName, "profiles/BEAST -- 93bc1a7d.json")));
  assertEqual(profileJson.profileId, PROFILE_BEAST, "full profileId lives in the Profile file (req 4)");

  const readBack = await Transport.readDeviceDirectory(devicesDir, result.directoryName);
  assertEqual(readBack.status, "valid", "the published generation reads back valid");
  assertEqual(readBack.deviceId, DEVICE_A, "read-back reports the full deviceId from content");
  assert(Transport.replicasEqual(readBack.replica, replica), "read-back replica equals what was published");
});

// ---- Rename + self exclusion (5, 6) ----------------------------------------

await test("Renaming the device directory keeps ONE logical device (req 5, 6)", async () => {
  const dir = createVirtualDirectory("V3 Sync");
  const devicesDir = await devicesDirOf(dir);
  const replica = replicaOf({ [PROFILE_BEAST]: profileFacts("BEAST") });

  const first = await Transport.publishOwnReplicaVerified(devicesDir, {
    deviceId: DEVICE_A,
    label: "Chromebook",
    replica,
  });
  assertEqual(first.directoryName, "Chromebook -- a31f2c4e", "published under the original readable name");

  // A human renames the folder in Drive. device.json is untouched.
  cloneDeviceDirectory(dir, "Chromebook -- a31f2c4e", "Chromebook Pro -- a31f2c4e");
  dir.removeDirectory(devicePath("Chromebook -- a31f2c4e"));

  const discovered = await Transport.discoverDevices(devicesDir, { ownDeviceId: DEVICE_B });
  assertEqual(discovered.peers.length, 1, "the renamed directory is ONE peer, not a second device (req 5)");
  assertEqual(discovered.peers[0].deviceId, DEVICE_A, "identified by the full declared deviceId");
  assertEqual(discovered.peers[0].directoryName, "Chromebook Pro -- a31f2c4e", "reported under its new readable name");

  // Self-exclusion by CONTENT: the directory name has never equalled the id.
  const asSelf = await Transport.discoverDevices(devicesDir, { ownDeviceId: DEVICE_A });
  assertEqual(asSelf.peers.length, 0, "this device does not see itself as a peer (req 6)");
  assert(Boolean(asSelf.own), "its own generation is reported separately");
  assertEqual(asSelf.own.directoryName, "Chromebook Pro -- a31f2c4e", "own generation found by content, under the new name");
});

// ---- Duplicate directories (7, 8, 9) ---------------------------------------

await test("Duplicate PEER directories: newest valid wins, stale is never deleted (req 7)", async () => {
  const dir = createVirtualDirectory("V3 Sync");
  const devicesDir = await devicesDirOf(dir);

  await Transport.publishOwnReplicaVerified(devicesDir, {
    deviceId: DEVICE_A,
    label: "Chromebook",
    replica: replicaOf({ [PROFILE_BEAST]: profileFacts("BEAST") }),
  });

  cloneDeviceDirectory(dir, "Chromebook -- a31f2c4e", "Chromebook Pro -- a31f2c4e");
  // device.json carries the hashes rather than being hashed, so bumping
  // updatedAt leaves the copy perfectly valid - exactly like a real newer publish.
  const newer = readManifest(dir, "Chromebook Pro -- a31f2c4e");
  newer.updatedAt = 9_000_000_000_000;
  writeManifest(dir, "Chromebook Pro -- a31f2c4e", newer);

  const discovered = await Transport.discoverDevices(devicesDir, { ownDeviceId: DEVICE_B });
  assertEqual(discovered.peers.length, 1, "two directories, one logical peer");
  assertEqual(discovered.peers[0].directoryName, "Chromebook Pro -- a31f2c4e", "the newer updatedAt wins");
  assertEqual(discovered.duplicates.length, 1, "the duplicate is reported");
  assertEqual(discovered.duplicates[0].ignored.join(","), "Chromebook -- a31f2c4e", "the stale copy is named as ignored");

  const stillThere = dir.readFile(devicePath("Chromebook -- a31f2c4e", Transport.DEVICE_FILE_NAME));
  assert(Boolean(stillThere), "the stale PEER directory was NOT deleted by the reader (req 7)");
});

await test("A malformed newer duplicate does not beat an older valid one (req 9)", async () => {
  const dir = createVirtualDirectory("V3 Sync");
  const devicesDir = await devicesDirOf(dir);

  await Transport.publishOwnReplicaVerified(devicesDir, {
    deviceId: DEVICE_A,
    label: "Chromebook",
    replica: replicaOf({ [PROFILE_BEAST]: profileFacts("BEAST") }),
  });

  cloneDeviceDirectory(dir, "Chromebook -- a31f2c4e", "Chromebook Pro -- a31f2c4e");
  const newer = readManifest(dir, "Chromebook Pro -- a31f2c4e");
  newer.updatedAt = 9_000_000_000_000;
  writeManifest(dir, "Chromebook Pro -- a31f2c4e", newer);
  // Corrupt the newer copy's data AFTER its manifest committed - the shape a
  // half-propagated Drive write takes.
  dir.writeFile(devicePath("Chromebook Pro -- a31f2c4e", "profiles/BEAST -- 93bc1a7d.json"), "{ corrupted");

  const restore = muteConsole();
  const discovered = await Transport.discoverDevices(devicesDir, { ownDeviceId: DEVICE_B });
  restore();

  assertEqual(discovered.peers.length, 1, "the peer is still discovered");
  assertEqual(discovered.peers[0].directoryName, "Chromebook -- a31f2c4e", "the OLDER but VALID copy wins (req 9)");
  assertEqual(discovered.skipped.length, 1, "the corrupt copy is reported as skipped");
  assert(
    String(discovered.skipped[0].reason).startsWith("profile-hash-mismatch"),
    `skip reason names the mismatch: ${discovered.skipped[0].reason}`
  );
});

await test("Duplicate OWN directories are removed, but only after verification (req 8)", async () => {
  let corrupt = false;
  const dir = createVirtualDirectory("V3 Sync", {
    transformWrite: (filePath, text) => (corrupt && filePath.includes("/profiles/") ? "{ sabotaged" : text),
  });
  const devicesDir = await devicesDirOf(dir);
  const replica = replicaOf({ [PROFILE_BEAST]: profileFacts("BEAST") });

  await Transport.publishOwnReplicaVerified(devicesDir, { deviceId: DEVICE_A, label: "Chromebook", replica });
  assert(Boolean(dir.readFile(devicePath("Chromebook -- a31f2c4e", Transport.DEVICE_FILE_NAME))), "original own directory exists");

  // A FAILED publish under a new name must leave the old directory alone.
  corrupt = true;
  const restore = muteConsole();
  const failed = await Transport.publishOwnReplicaVerified(devicesDir, {
    deviceId: DEVICE_A,
    label: "Chromebook Pro",
    replica,
  });
  restore();
  assertEqual(failed.ok, false, "the sabotaged publish is not accepted");
  assert(
    Boolean(dir.readFile(devicePath("Chromebook -- a31f2c4e", Transport.DEVICE_FILE_NAME))),
    "the previous own directory survives a FAILED publish (req 8)"
  );

  // Now let it succeed: the new directory verifies, and only then is the stale
  // own directory removed.
  corrupt = false;
  const ok = await Transport.publishOwnReplicaVerified(devicesDir, {
    deviceId: DEVICE_A,
    label: "Chromebook Pro",
    replica,
  });
  assertEqual(ok.ok, true, "the retried publish succeeds");
  assertEqual(ok.directoryName, "Chromebook Pro -- a31f2c4e", "published under the new readable name");
  assertEqual(ok.removedStaleDirectories.join(","), "Chromebook -- a31f2c4e", "the stale OWN directory was removed");
  assertEqual(
    dir.readFile(devicePath("Chromebook -- a31f2c4e", Transport.DEVICE_FILE_NAME)),
    undefined,
    "the stale OWN directory is gone after verification"
  );

  const discovered = await Transport.discoverDevices(devicesDir, { ownDeviceId: DEVICE_B });
  assertEqual(discovered.peers.length, 1, "still exactly one logical device afterwards");
});

await test("A failed publish does not strand its own directory - the retry reuses it", async () => {
  let corrupt = true;
  const dir = createVirtualDirectory("V3 Sync", {
    transformWrite: (filePath, text) => (corrupt && filePath.includes("/profiles/") ? "{ sabotaged" : text),
  });
  const devicesDir = await devicesDirOf(dir);
  const replica = replicaOf({ [PROFILE_BEAST]: profileFacts("BEAST") });

  const restore = muteConsole();
  const failedOnce = await Transport.publishOwnReplicaVerified(devicesDir, { deviceId: DEVICE_A, label: "Chromebook", replica });
  const failedTwice = await Transport.publishOwnReplicaVerified(devicesDir, { deviceId: DEVICE_A, label: "Chromebook", replica });
  restore();

  assertEqual(failedOnce.ok, false, "first attempt fails verification");
  assertEqual(failedTwice.ok, false, "second attempt also fails");
  assertEqual(
    failedTwice.directoryName,
    failedOnce.directoryName,
    "a retry targets the SAME directory - a failed publish must not escalate its own name"
  );

  corrupt = false;
  const recovered = await Transport.publishOwnReplicaVerified(devicesDir, { deviceId: DEVICE_A, label: "Chromebook", replica });
  assertEqual(recovered.ok, true, "the publish succeeds once the fault clears");
  assertEqual(recovered.directoryName, "Chromebook -- a31f2c4e", "and lands on the original readable name");

  const directoryNames = new Set(
    Object.keys(dir.snapshotFiles())
      .filter((filePath) => filePath.startsWith(`${Transport.ROOT_DIR_NAME}/${Transport.DEVICES_DIR_NAME}/`))
      .map((filePath) => filePath.split("/")[2])
  );
  assertEqual(directoryNames.size, 1, `exactly one device directory exists, not a fan of abandoned retries: ${[...directoryNames].join(", ")}`);

  const discovered = await Transport.discoverDevices(devicesDir, { ownDeviceId: DEVICE_B });
  assertEqual(discovered.peers.length, 1, "and it reads back as one healthy device");
});

// ---- Filenames are never identity (10, 11, 12) -----------------------------

await test("A readable Profile filename is never parsed as identity (req 10)", async () => {
  const dir = createVirtualDirectory("V3 Sync");
  const devicesDir = await devicesDirOf(dir);
  const replica = replicaOf({ [PROFILE_BEAST]: profileFacts("BEAST") });
  const published = await Transport.publishOwnReplicaVerified(devicesDir, {
    deviceId: DEVICE_A,
    label: "Chromebook",
    replica,
  });

  // Rename the file on disk to something deliberately misleading and update the
  // manifest's DECLARATION to match. Content is untouched.
  const originalPath = devicePath(published.directoryName, "profiles/BEAST -- 93bc1a7d.json");
  const text = dir.readFile(originalPath);
  dir.writeFile(devicePath(published.directoryName, "profiles/TOTALLY OTHER NAME -- ffffffff.json"), text);
  dir.removeFile(originalPath);
  const manifest = readManifest(dir, published.directoryName);
  manifest.profiles[0].file = "profiles/TOTALLY OTHER NAME -- ffffffff.json";
  manifest.profiles[0].name = "TOTALLY OTHER NAME";
  writeManifest(dir, published.directoryName, manifest);

  const read = await Transport.readDeviceDirectory(devicesDir, published.directoryName);
  assertEqual(read.status, "valid", "a misleading filename does not invalidate the generation");
  assert(Object.hasOwn(read.replica.profiles, PROFILE_BEAST), "the Profile still binds to its CONTENT profileId (req 10)");
  assert(!Object.hasOwn(read.replica.profiles, "ffffffff"), "nothing was derived from the filename");

  // And the converse: renaming a file WITHOUT updating the manifest is an
  // invalid generation, because the manifest declaration is what locates it.
  dir.writeFile(devicePath(published.directoryName, "profiles/Renamed Behind Its Back -- 11111111.json"), text);
  dir.removeFile(devicePath(published.directoryName, "profiles/TOTALLY OTHER NAME -- ffffffff.json"));
  const broken = await Transport.readDeviceDirectory(devicesDir, published.directoryName);
  assertEqual(broken.status, "invalid", "a file renamed behind the manifest's back is not silently found");
  assert(String(broken.reason).startsWith("profile-file-missing"), `reason names the missing declaration: ${broken.reason}`);
});

await test("Publishing twice unchanged deletes ZERO valid Profile files (req 11)", async () => {
  const dir = createVirtualDirectory("V3 Sync");
  const devicesDir = await devicesDirOf(dir);
  const replica = replicaOf({
    [PROFILE_BEAST]: profileFacts("BEAST"),
    [PROFILE_BUKK]: profileFacts("BUKK"),
  });

  const first = await Transport.publishOwnReplicaVerified(devicesDir, { deviceId: DEVICE_A, label: "Chromebook", replica });
  assertEqual(first.ok, true, "first publish succeeded");
  const afterFirst = fileNamesUnder(dir, first.directoryName, Transport.PROFILES_DIR_NAME);
  assertEqual(afterFirst.length, 2, "two Profile files after the first publish");

  const second = await Transport.publishOwnReplicaVerified(devicesDir, { deviceId: DEVICE_A, label: "Chromebook", replica });
  assertEqual(second.ok, true, "second publish succeeded");
  assertEqual(second.removedProfileFiles.length, 0, "the second publish deleted ZERO Profile files (req 11)");
  assertEqual(
    fileNamesUnder(dir, second.directoryName, Transport.PROFILES_DIR_NAME).join(" | "),
    afterFirst.join(" | "),
    "the same readable Profile files are still present"
  );

  const read = await Transport.readDeviceDirectory(devicesDir, second.directoryName);
  assertEqual(read.status, "valid", "the twice-published generation is still valid");
  assertEqual(Object.keys(read.replica.profiles).sort().join(","), [PROFILE_BEAST, PROFILE_BUKK].sort().join(","), "both Profiles survive");
});

await test("Stale Profile files are removed from manifest declarations, not filenames (req 12)", async () => {
  const dir = createVirtualDirectory("V3 Sync");
  const devicesDir = await devicesDirOf(dir);

  const before = replicaOf({
    [PROFILE_BEAST]: profileFacts("BEAST"),
    [PROFILE_BUKK]: profileFacts("BUKK"),
  });
  const first = await Transport.publishOwnReplicaVerified(devicesDir, { deviceId: DEVICE_A, label: "Chromebook", replica: before });

  // Rename BEAST -> BEAST-2 (same profileId) and drop BUKK entirely.
  const after = replicaOf({ [PROFILE_BEAST]: profileFacts("BEAST-2") });
  const second = await Transport.publishOwnReplicaVerified(devicesDir, { deviceId: DEVICE_A, label: "Chromebook", replica: after });

  assertEqual(second.ok, true, "the rename publish succeeded");
  assertEqual(
    fileNamesUnder(dir, second.directoryName, Transport.PROFILES_DIR_NAME).join(" | "),
    "BEAST-2 -- 93bc1a7d.json",
    "only the currently declared file remains"
  );
  assertEqual(
    second.removedProfileFiles.sort().join(" | "),
    "BEAST -- 93bc1a7d.json | BUKK -- c771a902.json",
    "the renamed-away file AND the removed Profile's file were both cleaned up (req 12)"
  );

  const read = await Transport.readDeviceDirectory(devicesDir, second.directoryName);
  assertEqual(read.status, "valid", "the generation after cleanup is valid");
  assertEqual(read.replica.profiles[PROFILE_BEAST].name.v, "BEAST-2", "the surviving Profile kept its identity across the rename");
  assert(first.directoryName === second.directoryName, "the device directory itself did not change");
});

// ---- Same human name, different ids (19, 20) -------------------------------

await test("Two devices sharing a human name stay two devices (req 19)", async () => {
  const dir = createVirtualDirectory("V3 Sync");
  const devicesDir = await devicesDirOf(dir);

  const a = await Transport.publishOwnReplicaVerified(devicesDir, {
    deviceId: DEVICE_A,
    label: "Chromebook",
    replica: replicaOf({ [PROFILE_BEAST]: profileFacts("BEAST") }),
  });
  const b = await Transport.publishOwnReplicaVerified(devicesDir, {
    deviceId: DEVICE_B,
    label: "Chromebook",
    replica: replicaOf({ [PROFILE_BUKK]: profileFacts("BUKK") }),
  });

  assert(a.directoryName !== b.directoryName, `distinct directories: "${a.directoryName}" vs "${b.directoryName}"`);
  assertEqual(a.directoryName, "Chromebook -- a31f2c4e", "device A directory");
  assertEqual(b.directoryName, "Chromebook -- 90a84b71", "device B directory");

  const discovered = await Transport.discoverDevices(devicesDir, { ownDeviceId: null });
  assertEqual(discovered.peers.length, 2, "two logical devices despite one shared human name (req 19)");
  assertEqual(discovered.duplicates.length, 0, "neither is treated as a duplicate of the other");
});

await test("Two Profiles sharing a human name stay two files (req 20)", async () => {
  const dir = createVirtualDirectory("V3 Sync");
  const devicesDir = await devicesDirOf(dir);

  const result = await Transport.publishOwnReplicaVerified(devicesDir, {
    deviceId: DEVICE_A,
    label: "Chromebook",
    replica: replicaOf({
      [PROFILE_BEAST]: profileFacts("BEAST"),
      [PROFILE_BUKK]: profileFacts("BEAST"),
    }),
  });

  assertEqual(result.ok, true, "publish with duplicate Profile names succeeded");
  const files = fileNamesUnder(dir, result.directoryName, Transport.PROFILES_DIR_NAME);
  assertEqual(files.length, 2, "two distinct files for two Profiles with the same name (req 20)");
  assertEqual(files.join(" | "), "BEAST -- 93bc1a7d.json | BEAST -- c771a902.json", "disambiguated by display suffix");

  const read = await Transport.readDeviceDirectory(devicesDir, result.directoryName);
  assertEqual(Object.keys(read.replica.profiles).length, 2, "both Profiles read back independently");
});

await test("Identical human names AND colliding display suffixes still disambiguate", async () => {
  const dir = createVirtualDirectory("V3 Sync");
  const devicesDir = await devicesDirOf(dir);
  // Two ids identical for their first 8 characters - the display suffix alone
  // cannot separate them, so the escalation must.
  const twinA = "93bc1a7d-aaaa-4222-8333-444455556666";
  const twinB = "93bc1a7d-bbbb-4222-8333-444455556666";

  const result = await Transport.publishOwnReplicaVerified(devicesDir, {
    deviceId: DEVICE_A,
    label: "Chromebook",
    replica: replicaOf({ [twinA]: profileFacts("BEAST"), [twinB]: profileFacts("BEAST") }),
  });

  assertEqual(result.ok, true, "publish succeeded despite a display-suffix collision");
  const files = fileNamesUnder(dir, result.directoryName, Transport.PROFILES_DIR_NAME);
  assertEqual(files.length, 2, "two files, not one overwriting the other");
  assertEqual(new Set(files).size, 2, "the two filenames are distinct");

  const read = await Transport.readDeviceDirectory(devicesDir, result.directoryName);
  assertEqual(Object.keys(read.replica.profiles).length, 2, "both Profiles survive the collision");
});

// ---- Verified publish + integrity (21, 22, 23) -----------------------------

await test("Verified publish still detects corruption (req 21)", async () => {
  let sabotage = false;
  const dir = createVirtualDirectory("V3 Sync", {
    transformWrite: (filePath, text) => (sabotage && filePath.includes("/profiles/") ? `${text} ` : text),
  });
  const devicesDir = await devicesDirOf(dir);
  const replica = replicaOf({ [PROFILE_BEAST]: profileFacts("BEAST") });

  sabotage = true;
  const restore = muteConsole();
  const result = await Transport.publishOwnReplicaVerified(devicesDir, { deviceId: DEVICE_A, label: "Chromebook", replica });
  restore();

  assertEqual(result.ok, false, "a publish whose bytes changed under it is rejected");
  assert(String(result.reason).startsWith("profile-hash-mismatch"), `reason identifies the hash mismatch: ${result.reason}`);
  assertEqual(result.removedProfileFiles, undefined, "no cleanup ran for a failed publish");
});

await test("Hash algorithm negotiation still rejects an unreproducible digest (req 22)", async () => {
  const dir = createVirtualDirectory("V3 Sync");
  const devicesDir = await devicesDirOf(dir);
  const published = await Transport.publishOwnReplicaVerified(devicesDir, {
    deviceId: DEVICE_A,
    label: "Chromebook",
    replica: replicaOf({ [PROFILE_BEAST]: profileFacts("BEAST") }),
  });

  const ourAlgo = await Transport.currentHashAlgo();
  assert(ourAlgo === "sha256" || ourAlgo === "fnv1a", `a known algorithm is reported: ${ourAlgo}`);

  const manifest = readManifest(dir, published.directoryName);
  assertEqual(manifest.hashAlgo, ourAlgo, "the publisher records the algorithm it used");
  manifest.hashAlgo = "some-future-algo";
  writeManifest(dir, published.directoryName, manifest);

  const read = await Transport.readDeviceDirectory(devicesDir, published.directoryName);
  assertEqual(read.status, "invalid", "a generation we cannot verify is rejected, not adopted");
  assert(String(read.reason).startsWith("hash-algo-mismatch"), `reason blames the algorithm, not the bytes: ${read.reason}`);

  // A manifest with no hashAlgo at all is read as "assume ours" - backward compatible.
  delete manifest.hashAlgo;
  writeManifest(dir, published.directoryName, manifest);
  const legacy = await Transport.readDeviceDirectory(devicesDir, published.directoryName);
  assertEqual(legacy.status, "valid", "an absent hashAlgo is assumed to be ours");
});

await test("All-or-nothing peer read skips a mid-write directory (req 23)", async () => {
  const dir = createVirtualDirectory("V3 Sync");
  const devicesDir = await devicesDirOf(dir);

  await Transport.publishOwnReplicaVerified(devicesDir, {
    deviceId: DEVICE_A,
    label: "Chromebook",
    replica: replicaOf({ [PROFILE_BEAST]: profileFacts("BEAST") }),
  });
  const healthy = await Transport.publishOwnReplicaVerified(devicesDir, {
    deviceId: DEVICE_B,
    label: "Windows",
    replica: replicaOf({ [PROFILE_BUKK]: profileFacts("BUKK") }),
  });

  // Device A's profile file has not landed yet - its manifest is committed but
  // its data is missing. Classic half-propagated Drive state.
  dir.removeFile(devicePath("Chromebook -- a31f2c4e", "profiles/BEAST -- 93bc1a7d.json"));

  const restore = muteConsole();
  const discovered = await Transport.discoverDevices(devicesDir, { ownDeviceId: null });
  restore();

  assertEqual(discovered.peers.length, 1, "the incomplete device is skipped entirely, not partially trusted");
  assertEqual(discovered.peers[0].deviceId, DEVICE_B, "the healthy peer is still merged");
  assertEqual(discovered.skipped.length, 1, "the incomplete device is reported as skipped (req 23)");
  assertEqual(discovered.skipped[0].directoryName, "Chromebook -- a31f2c4e", "the skip names the directory");
  assert(String(discovered.skipped[0].reason).startsWith("profile-file-missing"), `reason: ${discovered.skipped[0].reason}`);

  // A directory with no device.json at all is "empty", not an error.
  await devicesDir.getDirectoryHandle("Half Made -- 00000000", { create: true });
  const restore2 = muteConsole();
  const again = await Transport.discoverDevices(devicesDir, { ownDeviceId: null });
  restore2();
  assertEqual(again.skipped.length, 1, "a directory with no manifest yet is not reported as a fault");
  assertEqual(again.peers.length, 1, "and does not disturb the healthy peer");
  assert(Boolean(healthy.ok), "the healthy publish itself was fine");
});

// ---- Publish never escapes its own subtree ---------------------------------

await test("A hostile label cannot escape the devices directory (req 16, 17)", async () => {
  const dir = createVirtualDirectory("V3 Sync");
  const devicesDir = await devicesDirOf(dir);

  const result = await Transport.publishOwnReplicaVerified(devicesDir, {
    deviceId: DEVICE_A,
    label: "../../../etc/passwd",
    replica: replicaOf({ [PROFILE_BEAST]: profileFacts("../../escape") }),
  });

  assertEqual(result.ok, true, "publish still succeeds with a hostile label");
  assert(!result.directoryName.includes("/"), `no separator in the directory name: "${result.directoryName}"`);
  assert(!result.directoryName.startsWith("."), `no leading dot: "${result.directoryName}"`);

  const everyPath = Object.keys(dir.snapshotFiles());
  const inside = everyPath.every((p) => p.startsWith(`${Transport.ROOT_DIR_NAME}/${Transport.DEVICES_DIR_NAME}/`));
  assert(inside, `every written file stayed inside devices/: ${everyPath.join(", ")}`);
  assert(!everyPath.some((p) => p.includes("..")), "no path component is '..'");

  // A declared path that tries to escape is refused at READ time too.
  const manifest = readManifest(dir, result.directoryName);
  manifest.profiles[0].file = "profiles/../../../../evil.json";
  writeManifest(dir, result.directoryName, manifest);
  const read = await Transport.readDeviceDirectory(devicesDir, result.directoryName);
  assertEqual(read.status, "invalid", "an escaping declared path is rejected, never followed");
  assert(String(read.reason).startsWith("profile-entry-path"), `reason: ${read.reason}`);
});

await test("An empty replica publishes and reads back cleanly", async () => {
  const dir = createVirtualDirectory("V3 Sync");
  const devicesDir = await devicesDirOf(dir);
  const replica = replicaOf({});

  const result = await Transport.publishOwnReplicaVerified(devicesDir, { deviceId: DEVICE_A, label: "Chromebook", replica });
  assertEqual(result.ok, true, "an empty replica is publishable");
  const read = await Transport.readDeviceDirectory(devicesDir, result.directoryName);
  assertEqual(read.status, "valid", "and reads back valid");
  assertEqual(Object.keys(read.replica.profiles).length, 0, "with no Profiles");
});

// ---- Summary ---------------------------------------------------------------

console.log(`\n${"-".repeat(60)}`);
if (failures === 0) {
  console.log(`ok    ${passes} assertion(s) passed - SyncV3 transport contract holds.`);
} else {
  console.log(`FAIL  ${failures} failure(s), ${passes} passed:`);
  for (const detail of failureDetail) console.log(`  - ${detail}`);
}
process.exit(failures === 0 ? 0 : 1);
