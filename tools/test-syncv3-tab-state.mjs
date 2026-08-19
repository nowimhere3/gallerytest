#!/usr/bin/env node
// [SYNCV3 / STAGE-03C / SAME-DEVICE-TAB-STATE]
// [WHY: two or three Browser Gallery tabs - and same-origin iframes - are one
//  installation with several views. They share a deviceId and an IndexedDB but
//  NOT a ProfileStore, so every context is a snapshot of whenever it last read.
//  With the V3 writer role pinned to a single tab by Stage 03B, the tab that
//  publishes is quite possibly not the tab the user is typing in - so a stale
//  writer publishes an old view, and the newer change sits durable but
//  unpublished until that writer happens to touch something itself. Worse, each
//  context writes the Profile row WHOLE, so a stale one can overwrite a
//  sibling's newer facts with no version anywhere to notice.
//
//  Both failures are silent and land on real curation, so they are proven here
//  rather than by opening three tabs and hoping.]
//
// Usage:  node tools/test-syncv3-tab-state.mjs

import { pathToFileURL } from "node:url";
import path from "node:path";
import { installFakeIndexedDB, createVirtualDirectory, settle, muteConsole } from "./lib/browser-test-env.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const src = (rel) => pathToFileURL(path.join(ROOT, "src", rel)).href;

const { setSnapshotFreezeEnabled } = await import(src("profile/profile-snapshot.js"));
setSnapshotFreezeEnabled(true);

const { ProfileStore } = await import(src("profile/profile-store.js"));
const { runSyncV3Pass } = await import(src("profile/sync-v3.js"));
const Transport = await import(src("profile/sync-v3-transport.js"));
const Store = await import(src("storage/profile-sync-store.js"));
const Policy = await import(src("profile/sync-v3-write-policy.js"));
const Channel = await import(src("profile/local-state-channel.js"));
const Facts = await import(src("profile/sync-facts.js"));

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

const openContexts = [];
const openLeases = [];

async function test(name, fn) {
  console.log(`\n${name}`);
  try {
    await fn();
  } catch (error) {
    failures++;
    failureDetail.push(`${name} - threw: ${error && error.stack}`);
    console.log(`  FAIL  threw: ${error && error.message}`);
    console.log(String(error && error.stack).split("\n").slice(1, 4).join("\n"));
  } finally {
    // [SYNCV3 / STAGE-03C / SAME-DEVICE-TAB-STATE]
    // [WHY: quiesced BEFORE the next test installs a fresh fake IndexedDB. These
    //  contexts resolve globalThis.indexedDB at call time, so a refresh still in
    //  flight when the global is swapped reads the NEXT test's database - which
    //  looks exactly like "the message never arrived" and is not a product bug.
    //  Browsers have one database per origin and no such swap exists.]
    await settle(20);
    for (const store of openContexts.splice(0)) {
      try {
        store.closeLocalStateChannel();
      } catch {
        /* already gone */
      }
    }
    for (const lease of openLeases.splice(0)) {
      try {
        lease.release();
      } catch {
        /* already gone */
      }
    }
  }
}

// ---- Fixture ---------------------------------------------------------------
//
// An "origin" is one IndexedDB plus one BroadcastChannel name. A "context" is a
// ProfileStore over it - which is exactly what a tab, a window, or a same-origin
// iframe is. Node's BroadcastChannel has the same semantics browsers do (no
// self-delivery, cross-instance delivery within the process), so these are the
// real API rather than a double.

const DEVICE_ID = "dev-a31f2c4e-1111-4222-8333-444455556666";
let channelCounter = 0;

function fixedIdentity() {
  return {
    ready: Promise.resolve(),
    deviceId: DEVICE_ID,
    isEphemeral: false,
    label: "Chromebook",
    observeReplica() {
      return this;
    },
    observe() {
      return this;
    },
    tick() {
      fixedIdentity.counter = (fixedIdentity.counter || 1_700_000_000_000) + 1;
      return { t: fixedIdentity.counter, d: DEVICE_ID };
    },
    async flush() {},
  };
}

function makeOrigin() {
  const env = installFakeIndexedDB();
  return { env, idb: globalThis.indexedDB, channelName: `bg-test-${++channelCounter}` };
}

/**
 * `channel: null` models a context on a browser with no BroadcastChannel.
 * `spy` collects every message this context posts, for the payload assertions.
 */
async function makeContext(origin, { channel = "real", spy = null } = {}) {
  globalThis.indexedDB = origin.idb;

  let factory;
  if (channel === null) factory = null;
  else if (spy) {
    factory = (name) => {
      const real = new BroadcastChannel(name);
      return {
        set onmessage(handler) {
          real.onmessage = handler;
        },
        get onmessage() {
          return real.onmessage;
        },
        postMessage(message) {
          spy.push(message);
          real.postMessage(message);
        },
        close() {
          real.close();
        },
      };
    };
  }

  const localStateChannel = Channel.createLocalStateChannel({
    channelName: origin.channelName,
    factory,
    onMessage: null,
  });

  const store = new ProfileStore({
    identity: fixedIdentity(),
    associationStore: Store.V3_ASSOCIATION_STORE,
    localStateChannel,
  });
  // The store installs its own handler on the channel it is given.
  openContexts.push(store);
  // Generous, for the same reason propagate() is: constructing a store is
  // several IndexedDB round trips and the second context must see the first
  // context's registry before it resolves its own active Profile.
  await settle(20);
  await store.whenFactsSettled();
  await store.whenAssociationsSettled();
  return store;
}

/**
 * Lets a BroadcastChannel message cross contexts and the resulting refresh land.
 *
 * [SYNCV3 / STAGE-03C / SAME-DEVICE-TAB-STATE]
 * [WHY: the count is generous because the chain is long, not because it is
 *  flaky. One propagation is: the writing context's queued save drains, re-reads
 *  its row, writes it, announces; the message crosses the channel; the receiving
 *  context re-reads the registry, the Profile row and the associations, then
 *  merges and projects. Every one of those IndexedDB requests is a separate
 *  macrotask in the fake store, so the tick budget has to cover all of them. In
 *  a browser this is a handful of milliseconds.]
 */
const propagate = () => settle(60);

function v3Files(dir) {
  return Object.keys(dir.snapshotFiles()).sort();
}

function deviceDirectories(dir) {
  const prefix = `${Transport.ROOT_DIR_NAME}/${Transport.DEVICES_DIR_NAME}/`;
  return [
    ...new Set(Object.keys(dir.snapshotFiles()).filter((p) => p.startsWith(prefix)).map((p) => p.split("/")[2])),
  ].sort();
}

// ============================================================================

console.log("SyncV3 Stage 03C - same-device tab/iframe state freshness");

// ---- Identity + wiring (1, 2, 11, 12) --------------------------------------

await test("Contexts share one IndexedDB and have unique ephemeral ids (req 1, 2)", async () => {
  const origin = makeOrigin();
  const a = await makeContext(origin);
  const b = await makeContext(origin);

  assert(Boolean(a.getContextId()), "context A has an id");
  assert(Boolean(b.getContextId()), "context B has an id");
  assert(a.getContextId() !== b.getContextId(), "the two ids differ (req 2)");
  assert(a.getContextId().startsWith("ctx-"), `the id is namespaced: ${a.getContextId()}`);
  assert(a.getContextId() !== DEVICE_ID && !a.getContextId().includes(DEVICE_ID), "and is NOT the deviceId");

  // Same installation: both resolve to the same active Profile out of the shared
  // registry, which is what makes them one installation with two views.
  assertEqual(a.getProfileId(), b.getProfileId(), "both contexts resolve the same active Profile (req 1)");
});

await test("Messages carry invalidation only, never a Profile payload (req 12, 25)", async () => {
  const origin = makeOrigin();
  const spy = [];
  const a = await makeContext(origin, { spy });
  spy.length = 0;

  a.setFavorite("clip.mp4", true);
  a.createTag("Sunsets");
  await a.whenFactsSettled();
  await propagate();

  assert(spy.length > 0, `at least one message was posted (${spy.length})`);
  const allowedKeys = new Set(["kind", "at", "profileId", "contextId", "deviceId"]);
  for (const message of spy) {
    for (const key of Object.keys(message)) {
      assert(allowedKeys.has(key), `message key "${key}" is one of the allowed invalidation keys (req 12)`);
    }
    const text = JSON.stringify(message);
    assert(!text.includes("clip.mp4"), "no item path leaked into the message (req 12)");
    assert(!text.includes("Sunsets"), "no tag name leaked into the message (req 12)");
    for (const field of Facts.SESSION_ONLY_FIELDS) {
      assert(!text.includes(`"${field}"`), `no session-only field "${field}" leaked (req 25)`);
    }
  }
});

await test("Self-originated messages are ignored (req 11)", async () => {
  const origin = makeOrigin();
  const a = await makeContext(origin);

  let refreshes = 0;
  const original = a.refreshFromStorage.bind(a);
  a.refreshFromStorage = (...args) => {
    refreshes += 1;
    return original(...args);
  };

  a.setFavorite("self.mp4", true);
  await a.whenFactsSettled();
  await propagate();

  assertEqual(refreshes, 0, "a context does not refresh in response to its own writes (req 11)");
  assertEqual(a.isFavorite("self.mp4"), true, "and its own change is unaffected");
});

// ---- Propagation (3, 4, 5, 6, 7, 8, 9, 10) ---------------------------------

await test("Favorite and Hidden changes propagate between contexts (req 3, 4)", async () => {
  const origin = makeOrigin();
  const a = await makeContext(origin);
  const b = await makeContext(origin);

  assertEqual(a.getProfileId(), b.getProfileId(), "both contexts are on the same active Profile");
  assertEqual(b.isFavorite("shared.mp4"), false, "B starts without the favourite");

  a.setFavorite("shared.mp4", true);
  await a.whenFactsSettled();
  await propagate();
  assertEqual(b.isFavorite("shared.mp4"), true, "B learned the favourite without touching anything (req 3)");

  a.setHidden("hide-me.mp4", true);
  await a.whenFactsSettled();
  await propagate();
  assertEqual(b.isHidden("hide-me.mp4"), true, "B learned the hidden change (req 4)");

  // And back the other way, to prove the channel is not one-directional.
  b.setFavorite("from-b.mp4", true);
  await b.whenFactsSettled();
  await propagate();
  assertEqual(a.isFavorite("from-b.mp4"), true, "A learned B's change too");
});

await test("Tag vocabulary and assignments propagate (req 5)", async () => {
  const origin = makeOrigin();
  const a = await makeContext(origin);
  const b = await makeContext(origin);

  const tag = a.createTag("Beaches");
  await a.whenFactsSettled();
  await propagate();
  assert(
    b.getTags().some((entry) => entry.id === tag.id && entry.name === "Beaches"),
    "B sees the new tag (req 5)"
  );

  a.setItemTag("beach.mp4", tag.id, true);
  await a.whenFactsSettled();
  await propagate();
  assertEqual(b.hasItemTag("beach.mp4", tag.id), true, "B sees the assignment");

  a.renameTag(tag.id, "Coastline");
  await a.whenFactsSettled();
  await propagate();
  assertEqual(
    (b.getTags().find((entry) => entry.id === tag.id) || {}).name,
    "Coastline",
    "B sees the rename"
  );

  a.deleteTag(tag.id);
  await a.whenFactsSettled();
  await propagate();
  assertEqual(
    b.getTags().some((entry) => entry.id === tag.id),
    false,
    "B sees the deletion"
  );
});

await test("Profile create, rename and delete propagate (req 6, 7, 8)", async () => {
  const origin = makeOrigin();
  const a = await makeContext(origin);
  const b = await makeContext(origin);

  const created = await a.createProfile("BEAST");
  await a.whenFactsSettled();
  await propagate();
  assert(
    b.listProfiles().some((entry) => entry.id === created.id),
    "B sees the newly created Profile (req 7)"
  );

  a.setProfileName("Renamed Gallery");
  await a.whenFactsSettled();
  await propagate();
  const activeId = a.getProfileId();
  assertEqual(
    (b.listProfiles().find((entry) => entry.id === activeId) || {}).name,
    "Renamed Gallery",
    "B sees the Profile rename (req 6)"
  );

  await a.deleteProfile(created.id);
  await a.whenFactsSettled();
  await propagate();
  assertEqual(
    b.listProfiles().some((entry) => entry.id === created.id),
    false,
    "B sees the Profile deletion (req 8)"
  );
  assert(Boolean(b.getProfileId()), "and B still has an active Profile of its own");
});

await test("Association changes propagate (req 9)", async () => {
  const origin = makeOrigin();
  const a = await makeContext(origin);
  const b = await makeContext(origin);

  await a.adoptMergedReplica({
    schemaVersion: 3,
    profiles: {},
    associations: { "lib-shared": { v: "profile-x", t: 5_000_000_000_000, d: DEVICE_ID } },
  });
  await settle();
  await propagate();

  assertEqual(b.listAssociations()["lib-shared"], "profile-x", "B sees the association (req 9)");
  assertEqual(b.getAssociationStoreId(), "associations-v3", "and it came from the V3 row");
});

await test("A receiving context adopts, it does not re-stamp (req 10)", async () => {
  const origin = makeOrigin();
  const a = await makeContext(origin);
  const b = await makeContext(origin);

  a.setFavorite("stamped.mp4", true);
  await a.whenFactsSettled();
  const aFacts = a.getFacts();
  const aStamp = aFacts.items["stamped.mp4"].favorite;

  await propagate();

  const bFacts = b.getFacts();
  const bStamp = bFacts.items["stamped.mp4"].favorite;
  assertEqual(bStamp.t, aStamp.t, "B holds the SAME logical time - no second stamp was minted (req 10)");
  assertEqual(bStamp.d, aStamp.d, "and the same originating device");
  assertEqual(
    JSON.stringify(bStamp.v),
    JSON.stringify(aStamp.v),
    "and the identical value"
  );
});

// ---- Stale-write prevention (13, 14, 15, 16) -------------------------------

await test("Receiving a message never writes to Drive (req 13)", async () => {
  const dir = createVirtualDirectory("V3 Sync");
  const origin = makeOrigin();
  const a = await makeContext(origin);
  const b = await makeContext(origin);

  const before = JSON.stringify(v3Files(dir));
  a.setFavorite("no-drive.mp4", true);
  await a.whenFactsSettled();
  await propagate();

  assertEqual(b.isFavorite("no-drive.mp4"), true, "B refreshed from IndexedDB");
  assertEqual(JSON.stringify(v3Files(dir)), before, "and nothing reached Drive (req 13)");
  assertEqual(before, "[]", "the folder was and remains untouched");
});

await test("A stale whole-row write cannot overwrite a newer sibling fact (req 16)", async () => {
  const origin = makeOrigin();
  // [SYNCV3 / STAGE-03C / SAME-DEVICE-TAB-STATE]
  // [WHY: B is deliberately given NO channel, so it never hears about A's change.
  //  That isolates the read-modify-write in #persist from the BroadcastChannel
  //  path entirely - this is the guarantee that has to hold on a browser without
  //  BroadcastChannel, and for any message that is simply missed.]
  const a = await makeContext(origin);
  const b = await makeContext(origin, { channel: null });
  assertEqual(b.isLocalStateChannelAvailable(), false, "B has no local state channel");

  a.setFavorite("from-a.mp4", true);
  await a.whenFactsSettled();
  await settle();

  // B knows nothing about it and writes the row whole.
  assertEqual(b.isFavorite("from-a.mp4"), false, "B is genuinely stale");
  b.setFavorite("from-b.mp4", true);
  await b.whenFactsSettled();
  await settle();

  // The durable row must hold BOTH.
  const c = await makeContext(origin);
  await settle();
  assertEqual(c.isFavorite("from-a.mp4"), true, "A's fact survived B's stale whole-row write (req 16)");
  assertEqual(c.isFavorite("from-b.mp4"), true, "and B's own fact landed too");

  // B itself is now current, because its own write folded storage in.
  assertEqual(b.isFavorite("from-a.mp4"), true, "the writing context absorbed what it had been missing");
});

await test("Two fresh contexts writing at the same instant both survive (req 16)", async () => {
  // [SYNCV3 / STAGE-03C / SAME-DEVICE-TAB-STATE]
  // [WHY: this is what the presence handshake buys. The stale-row guard skips its
  //  merge when no sibling is known, so without a presence announcement the FIRST
  //  concurrent write after a second tab opens is unprotected - the one a user
  //  produces by opening a tab and immediately clicking. Both contexts here write
  //  before any DATA message could have told either about the other, so only the
  //  handshake can have armed them.]
  const origin = makeOrigin();
  // [SYNCV3 / STAGE-03C / SAME-DEVICE-TAB-STATE]
  // [WHY: an ESTABLISHED installation, not a fresh one. A context opening onto an
  //  empty database writes the registry as it resolves an active Profile, and
  //  that write announces presence incidentally - which would arm the siblings
  //  and let this test pass without the handshake existing at all. Seeding the
  //  registry first means A and B resolve it without writing anything, so the
  //  explicit presence announcement is the only thing that can arm them. This is
  //  also the real case: a second tab opened on a Gallery that has been used
  //  before.]
  const seed = await makeContext(origin);
  seed.closeLocalStateChannel();
  await settle(20);

  const a = await makeContext(origin);
  const b = await makeContext(origin);

  // Neither has exchanged a data message; both must already be armed.
  a.setFavorite("simultaneous-a.mp4", true);
  b.setFavorite("simultaneous-b.mp4", true);
  await a.whenFactsSettled();
  await b.whenFactsSettled();
  await propagate();

  const witness = await makeContext(origin);
  assertEqual(witness.isFavorite("simultaneous-a.mp4"), true, "A's simultaneous write survived (req 16)");
  assertEqual(witness.isFavorite("simultaneous-b.mp4"), true, "B's simultaneous write survived (req 16)");
});

await test("A stale writer publishes the newest durable state (req 14, 15)", async () => {
  const dir = createVirtualDirectory("V3 Sync");
  const origin = makeOrigin();
  const writer = await makeContext(origin);
  const editor = await makeContext(origin);

  const lease = Policy.createV3WriterLease({ deviceId: DEVICE_ID });
  openLeases.push(lease);
  assertEqual((await lease.ensure()).allowed, true, "the writer context holds the lease");

  // The user types in the OTHER tab.
  editor.setFavorite("typed-elsewhere.mp4", true);
  await editor.whenFactsSettled();
  await propagate();

  assertEqual(writer.isFavorite("typed-elsewhere.mp4"), true, "the writer learned it before publishing (req 14)");

  const result = await runSyncV3Pass({
    profileStore: writer,
    dirHandle: dir.handle,
    state: {},
    writerLease: lease,
  });
  await settle();

  assertEqual(result.published, true, "the writer published");
  assert(
    JSON.stringify(dir.snapshotFiles()).includes("typed-elsewhere.mp4"),
    "and the published bytes contain the OTHER tab's change (req 15)"
  );
  assertEqual(deviceDirectories(dir).length, 1, "one device directory (req 23)");
});

await test("Reload-before-publish saves a writer with NO channel (req 20)", async () => {
  const dir = createVirtualDirectory("V3 Sync");
  const origin = makeOrigin();
  // The writer cannot hear anything at all.
  const writer = await makeContext(origin, { channel: null });
  const editor = await makeContext(origin, { channel: null });
  assertEqual(writer.isLocalStateChannelAvailable(), false, "no BroadcastChannel anywhere in this origin");

  const lease = Policy.createV3WriterLease({ deviceId: DEVICE_ID });
  openLeases.push(lease);
  assertEqual((await lease.ensure()).allowed, true, "the writer holds the lease");

  editor.setFavorite("no-channel-change.mp4", true);
  await editor.whenFactsSettled();
  await settle();
  assertEqual(writer.isFavorite("no-channel-change.mp4"), false, "the writer is stale, as expected without a channel");

  const result = await runSyncV3Pass({
    profileStore: writer,
    dirHandle: dir.handle,
    state: {},
    writerLease: lease,
  });
  await settle();

  assertEqual(result.published, true, "the pass published");
  assertEqual(
    writer.isFavorite("no-channel-change.mp4"),
    true,
    "reload-before-publish made the writer current anyway (req 20)"
  );
  assert(
    JSON.stringify(dir.snapshotFiles()).includes("no-channel-change.mp4"),
    "and the change reached Drive without any BroadcastChannel (req 20)"
  );
});

// ---- Three contexts (17, 21, 23, 24) ---------------------------------------

await test("Three contexts converge and the writer publishes every change (req 17, 21)", async () => {
  const dir = createVirtualDirectory("V3 Sync");
  const origin = makeOrigin();
  const a = await makeContext(origin);
  const b = await makeContext(origin);
  const writer = await makeContext(origin);

  const lease = Policy.createV3WriterLease({ deviceId: DEVICE_ID });
  openLeases.push(lease);
  assertEqual((await lease.ensure()).allowed, true, "context C is the writer");

  a.setFavorite("from-a.mp4", true);
  await a.whenFactsSettled();
  b.setHidden("from-b.mp4", true);
  await b.whenFactsSettled();
  await propagate();

  // All three converge locally.
  for (const [name, context] of [["A", a], ["B", b], ["C", writer]]) {
    assertEqual(context.isFavorite("from-a.mp4"), true, `${name} has A's favourite (req 17)`);
    assertEqual(context.isHidden("from-b.mp4"), true, `${name} has B's hidden (req 17)`);
  }

  const result = await runSyncV3Pass({
    profileStore: writer,
    dirHandle: dir.handle,
    state: {},
    writerLease: lease,
  });
  await settle();

  assertEqual(result.published, true, "the writer published");
  const published = JSON.stringify(dir.snapshotFiles());
  assert(published.includes("from-a.mp4"), "Drive has A's change (req 17)");
  assert(published.includes("from-b.mp4"), "Drive has B's change (req 17)");
  assertEqual(deviceDirectories(dir).length, 1, "still exactly one device directory (req 23)");
});

await test("Repeated passes with peer chatter do not churn Profile files (req 24)", async () => {
  const dir = createVirtualDirectory("V3 Sync");
  const origin = makeOrigin();
  const writer = await makeContext(origin);
  const peer = await makeContext(origin);

  const lease = Policy.createV3WriterLease({ deviceId: DEVICE_ID });
  openLeases.push(lease);
  await lease.ensure();

  const state = {};
  await runSyncV3Pass({ profileStore: writer, dirHandle: dir.handle, state, writerLease: lease });
  await settle();
  const profileFiles = () => Object.keys(dir.snapshotFiles()).filter((p) => p.includes("/profiles/")).sort();
  const afterFirst = JSON.stringify(profileFiles());
  assert(afterFirst !== "[]", "the first pass published Profile files");

  // A peer edit, then several quiet passes.
  peer.setFavorite("churn-check.mp4", true);
  await peer.whenFactsSettled();
  await propagate();
  await runSyncV3Pass({ profileStore: writer, dirHandle: dir.handle, state, writerLease: lease });
  await settle();

  const second = await runSyncV3Pass({ profileStore: writer, dirHandle: dir.handle, state, writerLease: lease });
  const third = await runSyncV3Pass({ profileStore: writer, dirHandle: dir.handle, state, writerLease: lease });
  await settle();

  assertEqual(second.published, false, "a quiet pass republishes nothing (req 24)");
  assertEqual(third.published, false, "and stays quiet");
  assertEqual(JSON.stringify(profileFiles()), afterFirst, "the same Profile files are present - none deleted (req 24)");
  assertEqual(deviceDirectories(dir).length, 1, "and one device directory throughout (req 23)");
});

// ---- Iframe semantics + lock independence (18, 19) -------------------------

await test("Same-origin iframe semantics are the same channel (req 18)", async () => {
  // [SYNCV3 / STAGE-03C / SAME-DEVICE-TAB-STATE]
  // [WHY: BroadcastChannel is scoped to the ORIGIN, not to the browsing context -
  //  a same-origin iframe, a popup window and a second tab all reach the same
  //  channel through the identical API, with no frame-specific handling
  //  anywhere. So an iframe is represented here by what it actually is: another
  //  independent ProfileStore + channel pair over the same origin. There is no
  //  top-level-only assumption in the implementation to test around, which is
  //  precisely why this test looks the same as the two-tab one.]
  const origin = makeOrigin();
  const parent = await makeContext(origin);
  const embedded = await makeContext(origin);

  assert(parent.getContextId() !== embedded.getContextId(), "parent and embedded context have distinct ids");

  parent.setFavorite("from-parent.mp4", true);
  await parent.whenFactsSettled();
  await propagate();
  assertEqual(embedded.isFavorite("from-parent.mp4"), true, "the embedded context learned the parent's change (req 18)");

  embedded.setFavorite("from-iframe.mp4", true);
  await embedded.whenFactsSettled();
  await propagate();
  assertEqual(parent.isFavorite("from-iframe.mp4"), true, "and the parent learned the embedded context's change");
});

await test("The Stage 03B writer lock is unchanged (req 19)", async () => {
  const origin = makeOrigin();
  await makeContext(origin);

  const first = Policy.createV3WriterLease({ deviceId: DEVICE_ID });
  const second = Policy.createV3WriterLease({ deviceId: DEVICE_ID });
  openLeases.push(first, second);

  assertEqual((await first.ensure()).allowed, true, "one lease is granted");
  assertEqual((await second.ensure()).allowed, false, "the second is refused");
  assertEqual(
    (await second.ensure()).reason,
    Policy.WRITE_BLOCKED_LEASE_HELD_ELSEWHERE,
    "for the Stage 03B reason, unchanged (req 19)"
  );
  assertEqual(first.held, true, "and the lease is still held between calls");

  first.release();
  await settle(2);
  assertEqual((await second.ensure()).allowed, true, "handoff still works");
});

// ---- Summary ---------------------------------------------------------------

console.log(`\n${"-".repeat(60)}`);
if (failures === 0) {
  console.log(`ok    ${passes} assertion(s) passed - SyncV3 Stage 03C holds.`);
} else {
  console.log(`FAIL  ${failures} failure(s), ${passes} passed:`);
  for (const detail of failureDetail) console.log(`  - ${detail}`);
}
process.exit(failures === 0 ? 0 : 1);
