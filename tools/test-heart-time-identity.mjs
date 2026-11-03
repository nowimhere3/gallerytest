#!/usr/bin/env node
// [HEART-REACH / REMEMBERED-FOLDER-LIBRARY-IDENTITY]
// A remembered local folder that follows the Primary Curation must become
// preservable: its first Heart publishes the folder's shared LIBRARY identity
// (catalog + structure evidence) WITHOUT any Curation association. Primary stays
// a default; explicit source choices still outrank it; explicit "No Curation"
// still blocks it.
//
// Usage:  node tools/test-heart-time-identity.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {publishLibraryIdentityForHeart} from '../src/profile/heart-time-identity.js';
import {createProfileProjectionView} from '../src/profile/profile-projection-view.js';
import {primaryFallbackTarget} from '../src/profile/primary-curation-policy.js';
import {ProfileStore} from '../src/profile/profile-store.js';
import {SyncIdentity} from '../src/profile/sync-device.js';
import {V3_ASSOCIATION_STORE} from '../src/storage/profile-sync-store.js';
import {buildPortableStructureSample} from '../src/storage/portable-structure-evidence.js';
import * as LibraryRegistry from '../src/storage/library-registry.js';
import {installFakeIndexedDB, settle, createVirtualDirectory} from './lib/browser-test-env.mjs';
import {runSyncV3Pass} from '../src/profile/sync-v3.js';
import * as T from '../src/profile/sync-v3-transport.js';

let n = 0;
const eq = (a, b, label) => { assert.equal(a, b, label); n++; };
const ok = (v, label) => { assert.ok(v, label); n++; };

// ---- Policy (pure) -------------------------------------------------------
const calls = [];
const promote = async (record) => { calls.push(record.id); return {...record, libraryId: 'L'}; };
const run = (record, sourceKind = 'fsa') => publishLibraryIdentityForHeart({record, sourceKind, promote});
eq(await run(null), null, 'no record');
eq(await run({}), null, 'no id');
eq(await run({id: 'r'}, 'legacy'), null, 'legacy selection is not a durable local folder');
eq(await run({id: 'r'}, 'cassette'), null, 'Floppy Disks are not local folders');
eq(await run({id: 'r', libraryId: 'L'}), null, 'already shared');
eq(await run({id: 'r', profileId: 'P'}), null, 'explicit local binding is published as an association at load, not here');
eq(calls.length, 0, 'none of the above published');
eq((await run({id: 'r'})).libraryId, 'L', 'remembered Primary-backed folder publishes identity');
eq(calls.length, 1, 'exactly one publication');

// ---- Projection hook: observation only ----------------------------------
installFakeIndexedDB();
const profile = new ProfileStore({identity: new SyncIdentity(), associationStore: V3_ASSOCIATION_STORE});
await settle(); await profile.whenFactsSettled();
const primary = (await profile.createProfile('BEAST')).id;
const other = (await profile.createProfile('Other')).id;
await profile.setPrimaryCuration(primary);
await profile.switchProfile(primary);

const seen = [];
let flight = null;
let active = null;                      // stands in for main.js activeLibraryRecord
let items = [];                         // stands in for main.js allItems
const view = createProfileProjectionView({profile, onFavoriteSet: (path) => {
  seen.push(path);
  flight = (async () => {
    const updated = await publishLibraryIdentityForHeart({record: active, sourceKind: 'fsa', promote: async (record) => {
      const shared = await profile.promoteLibraryToShared(record.id, {name: record.name});
      if (!shared) return null;
      await profile.recordLibraryStructure(record.id, buildPortableStructureSample(items));
      return LibraryRegistry.getLibraryById(record.id);
    }});
    if (updated) active = updated;
  })();
}});

const mkHandle = (name) => { const h = {name, kind: 'directory', async isSameEntry(o) { return o === h; }}; return h; };
const folder = await LibraryRegistry.addOrUpdateLibrary(mkHandle('brand-new-folder'));   // "Remember Folder"
active = await LibraryRegistry.getLibraryById(folder.id);
items = [{relativePath: 'new/one.jpg', size: 10}, {relativePath: 'new/two.jpg', size: 20}];
eq(active.libraryId ?? null, null, 'Remember alone mints nothing');
eq(active.profileId ?? null, null, 'and binds nothing: the folder follows Primary');

view.setFavorite('new/one.jpg', false);
view.setFavorite('new/one.jpg', true);
await flight; await profile.whenFactsSettled();
eq(seen.length, 1, 'hook fires on Heart on only');
ok(active.libraryId, 'the first Heart published a shared Library identity');
eq(active.profileId ?? null, null, 'row still has no Curation binding');
eq(Object.keys(profile.getAssociations()).length, 0, 'no association fact exists: Primary was not converted into an override');
eq(profile.getProfileId(), primary, 'Heart remains in the Primary Curation');
ok(profile.isFavorite('new/one.jpg'), 'the Heart itself is intact');

view.setFavorite('new/two.jpg', true);
await flight;
eq((await LibraryRegistry.getLibraryById(folder.id)).libraryId, active.libraryId, 'identity minted once, preserved');

// A hook failure never affects the Heart.
const throwing = createProfileProjectionView({profile, onFavoriteSet: () => { throw new Error('boom'); }});
const warn = console.warn; console.warn = () => {};
throwing.setFavorite('new/three.jpg', true);
console.warn = warn;
ok(profile.isFavorite('new/three.jpg'), 'a failing observer does not fail the Heart');

// ---- Primary semantics, using main.js's real helpers ---------------------
const source = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const start = source.indexOf('function currentSourceHasChoice()');
const end = source.indexOf('function getCurrentAssociationUiState()', start);
const ctx = vm.createContext({profile, primaryFallbackTarget, primaryActivationQueue: Promise.resolve(), sessionExplicitNoCuration: false,
  legacySessionAssociated: false, currentSourceKind: 'fsa', activeLibraryRecord: null, activeCassetteCurationId: null,
  legacyHasDurableIdentity: false, pendingLegacySignature: null, deleteAmbientProfileDecision: async () => {}, syncAssociateButtonVisibility: () => {}});
vm.runInContext(source.slice(start, end), ctx);
const choice = () => vm.runInContext('currentSourceHasChoice()', ctx);
const apply = () => vm.runInContext('applyPrimaryForCurrentSource()', ctx);

ctx.activeLibraryRecord = await LibraryRegistry.getLibraryById(folder.id);          // shared identity, no association
eq(choice(), false, 'identity without association is NOT a source choice');
await profile.switchProfile(other);
await apply();
eq(profile.getProfileId(), primary, 'Primary still applies to the shared-identity folder');

// Explicit source override still outranks Primary.
const bound = await LibraryRegistry.addOrUpdateLibrary(mkHandle('explicit-folder'));
await profile.setLibraryAssociation(bound.id, other);
ctx.activeLibraryRecord = await LibraryRegistry.getLibraryById(bound.id);
eq(choice(), true, 'explicit association is a source choice');
await profile.switchProfile(other);
await apply();
eq(profile.getProfileId(), other, 'explicit source override outranks Primary');

// Explicit "No Curation" still blocks Primary.
const none = await LibraryRegistry.addOrUpdateLibrary(mkHandle('no-curation-folder'));
await profile.setLibraryAssociation(none.id, null);
ctx.activeLibraryRecord = await LibraryRegistry.getLibraryById(none.id);
eq(choice(), true, 'explicit null is a source choice');
await profile.switchProfile(other);
await apply();
eq(profile.getProfileId(), other, 'explicit No Curation still blocks Primary');

// ---- What the Heart Watcher can read from Drive --------------------------
const dir = createVirtualDirectory('Drive');
const pass = await runSyncV3Pass({profileStore: profile, dirHandle: dir.handle, writerLease: {ensure: async () => ({allowed: true})}, state: {}});
eq(pass.status, 'ok', 'V3 pass ok');
const root = await T.getSyncV3Root(dir.handle, {create: false});
const devices = await T.getDevicesDir(root, {create: false});
const names = await T.listDeviceDirectoryNames(devices);
const gen = await T.readDeviceDirectory(devices, names[0]);
const replica = gen.replica || gen.data?.replica || gen;
const identityId = active.libraryId;
ok(replica.libraries && replica.libraries[identityId], 'published libraries.json carries the remembered folder');
eq(replica.associations?.[identityId], undefined, 'published associations.json does NOT bind it to any Curation');
const structure = replica.structure?.[identityId]?.sample?.v;
ok(structure && structure.entries.some((e) => e.path === 'new/one.jpg'), 'published structure evidence lists the hearted file');
const heart = replica.profiles[primary].items['new/one.jpg'].favorite;
ok(heart.v.on === true, 'the Heart is published under the Primary Curation');
ok(typeof heart.d === 'string' && heart.d.length > 0, 'the Heart carries its authoring device');
eq(replica.libraries[identityId].sourceDeviceId.v, heart.d, 'the library publisher is the Heart author: the provenance the Heart Watcher matches on');

// ---- main.js wiring ------------------------------------------------------
ok(source.includes('onFavoriteSet: () => { void ensureLibraryIdentityForHeart(); }'), 'projection view is wired to the identity publisher');
const body = source.slice(source.indexOf('function ensureLibraryIdentityForHeart()'), source.indexOf('// [SYNCV3 / STAGE-07 / ASSOCIATION-WRITE]'));
ok(body.includes('promoteLibraryToShared') && body.includes('recordPortableStructureForLoad'), 'publisher promotes identity and records structure');
ok(!/associate|setLibraryAssociation|setLibraryProfile/.test(body.replace(/\/\/.*$/gm, '')), 'publisher never writes an association or a local profile binding');

console.log(`ok    ${n} assertion(s) passed - remembered Primary-backed folders publish Library identity without becoming explicit overrides.`);
process.exit(0);
