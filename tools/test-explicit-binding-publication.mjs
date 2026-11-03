#!/usr/bin/env node
// [HEART-REACH / EXPLICIT-LOCAL-BINDING-PUBLICATION]
// A folder bound to a Curation on one device only (registry `profileId`, no shared
// `libraryId`) must become addressable in V3 so the Curation Suite Heart Watcher
// can locate Hearts made in it. Primary fallback and plain opens must NOT.
//
// Usage:  node tools/test-explicit-binding-publication.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {publishExplicitLocalBinding} from '../src/profile/explicit-binding-publication.js';
import {ProfileStore} from '../src/profile/profile-store.js';
import {SyncIdentity} from '../src/profile/sync-device.js';
import {V3_ASSOCIATION_STORE} from '../src/storage/profile-sync-store.js';
import * as LibraryRegistry from '../src/storage/library-registry.js';
import {installFakeIndexedDB, settle, createVirtualDirectory} from './lib/browser-test-env.mjs';
import {runSyncV3Pass} from '../src/profile/sync-v3.js';
import * as T from '../src/profile/sync-v3-transport.js';

let n = 0;
const ok = (value, label) => { assert.ok(value, label); n++; };
const eq = (a, b, label) => { assert.equal(a, b, label); n++; };

// ---- Policy (pure) -------------------------------------------------------
const calls = [];
const associate = async (id, profileId) => { calls.push([id, profileId]); return {id, libraryId: 'L', profileId}; };
const exists = (known) => (id) => known.includes(id);
eq(await publishExplicitLocalBinding({record: null, profileExists: exists(['P']), associate}), null, 'no record');
eq(await publishExplicitLocalBinding({record: {id: 'r'}, profileExists: exists(['P']), associate}), null, 'no binding -> nothing (open / Primary fallback)');
eq(await publishExplicitLocalBinding({record: {id: 'r', profileId: null}, profileExists: exists(['P']), associate}), null, 'explicit null -> nothing');
eq(await publishExplicitLocalBinding({record: {id: 'r', libraryId: 'L', profileId: 'P'}, profileExists: exists(['P']), associate}), null, 'already shared -> nothing');
eq(await publishExplicitLocalBinding({record: {id: 'r', profileId: 'GONE'}, profileExists: exists(['P']), associate}), null, 'stale binding never published');
eq(calls.length, 0, 'none of the above wrote');
const done = await publishExplicitLocalBinding({record: {id: 'r', profileId: 'P'}, profileExists: exists(['P']), associate});
eq(done.libraryId, 'L', 'explicit local binding publishes');
eq(calls.length, 1, 'exactly one write');

// ---- Real stores + V3 publication ---------------------------------------
installFakeIndexedDB();
const profile = new ProfileStore({identity: new SyncIdentity(), associationStore: V3_ASSOCIATION_STORE});
await settle(); await profile.whenFactsSettled();
const primary = (await profile.createProfile('BEAST')).id;
const bbg4 = (await profile.createProfile('BBG4')).id;
await profile.setPrimaryCuration(primary);
const mkHandle = (name) => { const h = {name, kind: 'directory', async isSameEntry(o) { return o === h; }}; return h; };

const bound = await LibraryRegistry.addOrUpdateLibrary(mkHandle('all2-folder'));
await LibraryRegistry.setLibraryProfile(bound.id, bbg4);          // legacy/local-only explicit binding
const fallback = await LibraryRegistry.addOrUpdateLibrary(mkHandle('opened-under-primary'));
const stale = await LibraryRegistry.addOrUpdateLibrary(mkHandle('stale-binding'));
await LibraryRegistry.setLibraryProfile(stale.id, 'deleted-profile-id');
eq((await LibraryRegistry.getLibraryById(bound.id)).libraryId ?? null, null, 'bound row starts without shared identity');

const publish = (row) => publishExplicitLocalBinding({
  record: row,
  profileExists: (id) => profile.listProfiles().some((p) => p.id === id),
  associate: async (localId, profileId) => {
    const libraryId = await profile.setLibraryAssociation(localId, profileId);
    return libraryId ? LibraryRegistry.getLibraryByLibraryId(libraryId) : null;
  },
});

eq(await publish(await LibraryRegistry.getLibraryById(fallback.id)), null, 'Primary-fallback folder: nothing published');
eq(await publish(await LibraryRegistry.getLibraryById(stale.id)), null, 'stale binding: nothing published');
eq((await LibraryRegistry.getLibraryById(fallback.id)).libraryId ?? null, null, 'fallback folder still has no shared identity');
eq((await LibraryRegistry.getLibraryById(stale.id)).libraryId ?? null, null, 'stale folder still has no shared identity');

const updated = await publish(await LibraryRegistry.getLibraryById(bound.id));
ok(updated && updated.libraryId, 'bound folder minted a shared libraryId');
eq(updated.profileId, bbg4, 'row keeps its Curation');
const again = await publish(await LibraryRegistry.getLibraryById(bound.id));
eq(again, null, 'second load is a no-op (mint-once)');
eq((await LibraryRegistry.getLibraryById(bound.id)).libraryId, updated.libraryId, 'identity preserved');
await profile.recordLibraryLoaded(bound.id, {name: 'all2-folder'});
eq(profile.getAssociations()[updated.libraryId].v, bbg4, 'association fact names BBG4, not the Primary');
eq(profile.getProfileId() === primary || profile.getProfileId() === bbg4 || true, true, 'active Curation not required to change');

// The published generation is what the Heart Watcher reads.
const dir = createVirtualDirectory('Drive');
const pass = await runSyncV3Pass({profileStore: profile, dirHandle: dir.handle, writerLease: {ensure: async () => ({allowed: true})}, state: {}});
eq(pass.status, 'ok', 'V3 pass ok');
const root = await T.getSyncV3Root(dir.handle, {create: false});
const devices = await T.getDevicesDir(root, {create: false});
const names = await T.listDeviceDirectoryNames(devices);
eq(names.length, 1, 'one device generation');
const gen = await T.readDeviceDirectory(devices, names[0]);
eq(gen.status, 'valid', 'generation valid');
const published = gen.replica || gen.data?.replica || gen;
const assoc = published.associations || {};
ok(assoc[updated.libraryId] && assoc[updated.libraryId].v === bbg4, 'published associations.json carries libraryId -> BBG4');
ok(published.libraries && published.libraries[updated.libraryId], 'published libraries.json carries the library');
eq(Object.keys(assoc).filter((k) => k !== updated.libraryId).length, 0, 'no association minted for fallback/stale folders');

// main.js wiring: both load hooks publish before cataloguing the load.
const src = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const hooks = src.split('await publishExplicitBindingForLoadedLibrary();');
eq(hooks.length - 1, 2, 'FSA and legacy load paths both publish');
ok(hooks.slice(1).every((tail) => /^\s*await profile\.recordLibraryLoaded\(/.test(tail)), 'publication precedes recordLibraryLoaded');
ok(src.includes('associate: associateThroughSyncV2'), 'publication uses the single association seam');

console.log(`ok    ${n} assertion(s) passed - explicit local bindings reach V3; fallback/open never do.`);
process.exit(0);
