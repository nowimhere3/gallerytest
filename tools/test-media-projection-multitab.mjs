#!/usr/bin/env node
// [MEDIA-ID / STAGE-02 / LOCAL-PROJECTION]
// [WHY: this app is commonly open in two Chrome split tabs, several same-origin
//  tabs, and one or more iframes inside StreamLoop. A re-base in ANY of them
//  rewrites every stored scope-relative path and every root prefix, so every
//  other context's cached alias index describes state that no longer exists —
//  and unlike Stage 01, Stage 02 renders that cache. The channel must therefore
//  carry INVALIDATION and nothing else: IndexedDB stays the authority, and a
//  receiver that always re-reads it cannot be wrong about what it says.]
//
// Usage:  node tools/test-media-projection-multitab.mjs

import { pathToFileURL } from "node:url";
import path from "node:path";
import { installFakeIndexedDB, createVirtualDirectory, settle } from "./lib/browser-test-env.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const src = (rel) => pathToFileURL(path.join(ROOT, "src", rel)).href;

const fakeDb = installFakeIndexedDB();

const Identity = await import(src("storage/media-identity.js"));
const Scope = await import(src("storage/media-scope.js"));
const AliasIndex = await import(src("storage/media-alias-index.js"));
const Registry = await import(src("storage/library-registry.js"));

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

function assertDeep(actual, expected, label) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  return assert(a === b, label, a === b ? null : `expected: ${b}\n        actual:   ${a}`);
}

async function test(name, fn) {
  console.log(`\n${name}`);
  fakeDb.reset();
  try {
    await fn();
  } catch (error) {
    failures++;
    failureDetail.push(`${name} - threw: ${error && error.stack}`);
    console.log(`  FAIL  threw: ${error && error.message}`);
    console.log(String(error && error.stack).split("\n").slice(1, 4).join("\n"));
  } finally {
    await settle(20);
  }
}

// ---- A shared in-process BroadcastChannel ---------------------------------
//
// Mirrors the real API in the one way that matters: a message reaches every
// OTHER context on the same channel name, never the sender.

function makeChannelBus() {
  const contexts = new Map();
  let nextId = 0;
  return {
    factory(name) {
      const id = `ctx-${nextId++}`;
      const handle = { id, name, onmessage: null, closed: false };
      contexts.set(id, handle);
      return {
        get onmessage() {
          return handle.onmessage;
        },
        set onmessage(fn) {
          handle.onmessage = fn;
        },
        postMessage(message) {
          for (const [otherId, other] of contexts) {
            if (otherId === id || other.closed || other.name !== name) continue;
            if (other.onmessage) other.onmessage({ data: JSON.parse(JSON.stringify(message)) });
          }
        },
        close() {
          handle.closed = true;
          contexts.delete(id);
        },
      };
    },
    count: () => contexts.size,
  };
}

function item(relativePath) {
  const name = relativePath.slice(relativePath.lastIndexOf("/") + 1);
  return { relativePath, path: relativePath, name, size: 100, lastModified: 1000 };
}

// ---- 21: invalidation reaches a sibling context ---------------------------

await test("21 — a scope change in one context invalidates and REBUILDS the other's index", async () => {
  const bus = makeChannelBus();

  // Tab B is open on the child root and holds an alias index.
  const received = [];
  let rebuilds = 0;
  const tabB = AliasIndex.createMediaIdentityChannel({
    factory: bus.factory,
    deviceId: "dev-1",
    onInvalidate: (message) => {
      received.push(message);
      rebuilds += 1;
    },
  });

  // Tab A claims a root and announces it.
  const tabA = AliasIndex.createMediaIdentityChannel({ factory: bus.factory, deviceId: "dev-1" });
  tabA.announce(AliasIndex.MEDIA_IDENTITY_MESSAGE_KINDS.SCOPE_CHANGED, { scopeId: "scope-9" });

  assertEqual(rebuilds, 1, "the sibling context was told to rebuild");
  assertEqual(received[0].kind, "media-scope-changed", "with the scope-changed kind");
  assertEqual(received[0].scopeId, "scope-9", "carrying the scope identifier");

  tabA.announce(AliasIndex.MEDIA_IDENTITY_MESSAGE_KINDS.EVIDENCE_CHANGED, { scopeId: "scope-9" });
  assertEqual(rebuilds, 2, "an evidence change invalidates too");

  tabA.close();
  tabB.close();
});

await test("the message carries NO MEDIA-ID truth — only an identifier and a timestamp", async () => {
  const bus = makeChannelBus();
  let payload = null;
  const listener = AliasIndex.createMediaIdentityChannel({
    factory: bus.factory,
    deviceId: "dev-1",
    onInvalidate: (message) => {
      payload = message;
    },
  });
  const sender = AliasIndex.createMediaIdentityChannel({ factory: bus.factory, deviceId: "dev-1" });
  sender.announce(AliasIndex.MEDIA_IDENTITY_MESSAGE_KINDS.SCOPE_CHANGED, { scopeId: "scope-9", at: 1234 });

  assertDeep(
    Object.keys(payload).sort(),
    ["at", "contextId", "deviceId", "kind", "scopeId"],
    "exactly the invalidation envelope — no prefixes, no aliases, no projected values"
  );
  for (const forbidden of ["aliases", "prefix", "prefixFromScopeRoot", "paths", "facts", "favorite", "tags"]) {
    assertEqual(forbidden in payload, false, `the message carries no "${forbidden}"`);
  }
  listener.close();
  sender.close();
});

await test("a message from a different installation is ignored", async () => {
  const bus = makeChannelBus();
  let heard = 0;
  const mine = AliasIndex.createMediaIdentityChannel({
    factory: bus.factory,
    deviceId: "dev-1",
    onInvalidate: () => {
      heard += 1;
    },
  });
  const theirs = AliasIndex.createMediaIdentityChannel({ factory: bus.factory, deviceId: "dev-2" });
  theirs.announce(AliasIndex.MEDIA_IDENTITY_MESSAGE_KINDS.SCOPE_CHANGED, { scopeId: "scope-9" });
  assertEqual(heard, 0, "another installation's scope change is not ours to react to");

  const alsoMine = AliasIndex.createMediaIdentityChannel({ factory: bus.factory, deviceId: "dev-1" });
  alsoMine.announce(AliasIndex.MEDIA_IDENTITY_MESSAGE_KINDS.SCOPE_CHANGED, { scopeId: "scope-9" });
  assertEqual(heard, 1, "our own installation's is");

  mine.close();
  theirs.close();
  alsoMine.close();
});

await test("an unrelated message kind is ignored", async () => {
  const bus = makeChannelBus();
  let heard = 0;
  const listener = AliasIndex.createMediaIdentityChannel({
    factory: bus.factory,
    deviceId: "dev-1",
    onInvalidate: () => {
      heard += 1;
    },
  });
  const raw = bus.factory(AliasIndex.MEDIA_IDENTITY_CHANNEL_NAME);
  raw.postMessage({ kind: "something-else", deviceId: "dev-1" });
  assertEqual(heard, 0, "only MEDIA-ID kinds invalidate");
  listener.close();
});

await test("no BroadcastChannel degrades to a silent channel, never to an error", async () => {
  const channel = AliasIndex.createMediaIdentityChannel({ factory: null, deviceId: "dev-1", onInvalidate: () => {} });
  assertEqual(channel.available, false, "reported unavailable");
  assertEqual(channel.announce(AliasIndex.MEDIA_IDENTITY_MESSAGE_KINDS.SCOPE_CHANGED, {}), false, "posting is a no-op");
  channel.close();
  assert(true, "closing an unavailable channel does not throw");
});

// ---- IndexedDB remains the authority ---------------------------------------

await test("a rebuild after a re-base reads the NEW prefixes from storage, not from the message", async () => {
  // Tab B opens the child root FIRST, so it holds a scope rooted at the child.
  const dir = createVirtualDirectory("MASTER");
  let child = dir.handle;
  for (const segment of ["Staging area", "Mackenzie"]) child = await child.getDirectoryHandle(segment, { create: true });

  const kid = await Registry.addOrUpdateLibrary(child);
  const before = await Scope.resolveScopeForRoot({ rootId: kid.id, handle: child, sourceKind: "fsa", knownRootHandles: [] });
  assertEqual(before.prefixFromScopeRoot, "", "the child is its own scope root to begin with");

  const staleIndex = await AliasIndex.buildAliasIndexForLoad({
    rootId: kid.id,
    profileId: "P",
    items: [item("cat.jpg")],
    factKeys: ["Staging area/Mackenzie/cat.jpg"],
    loadComplete: true,
  });
  assertEqual(staleIndex, null, "a single-root scope has nothing to project");

  // Tab A now opens MASTER, which re-bases the scope underneath Tab B.
  const master = await Registry.addOrUpdateLibrary(dir.handle);
  const after = await Scope.resolveScopeForRoot({
    rootId: master.id,
    handle: dir.handle,
    sourceKind: "fsa",
    knownRootHandles: [{ rootId: kid.id, handle: child }],
  });
  assertEqual(after.action, "rebased", "the scope re-based onto MASTER");

  const childRow = await Identity.getRoot(kid.id);
  assertEqual(childRow.prefixFromScopeRoot, "Staging area/Mackenzie/", "the child's prefix moved in STORAGE");

  // Tab B rebuilds. It re-reads IndexedDB and picks up the new prefix — which is
  // exactly why the message needs to carry nothing.
  const rebuilt = await AliasIndex.buildAliasIndexForLoad({
    rootId: kid.id,
    profileId: "P",
    items: [item("cat.jpg")],
    factKeys: ["Staging area/Mackenzie/cat.jpg"],
    loadComplete: true,
  });

  assert(rebuilt !== null, "the rebuilt index exists");
  assertEqual(rebuilt.prefixFromScopeRoot, "Staging area/Mackenzie/", "built against the re-based prefix");
  assertDeep(
    rebuilt.aliases.get("cat.jpg"),
    ["cat.jpg", "Staging area/Mackenzie/cat.jpg"],
    "and the MASTER-relative curation now projects into the child view"
  );
});

console.log(`\n${"-".repeat(60)}`);
if (failures) {
  console.log(`FAIL  ${failures} assertion(s) failed, ${passes} passed.`);
  for (const detail of failureDetail) console.log(`  - ${detail}`);
  process.exit(1);
}
console.log(`ok    ${passes} assertion(s) passed - MEDIA-ID multi-tab freshness holds.`);
