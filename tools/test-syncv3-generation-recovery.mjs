// SCRATCH diagnostic (not part of the repo). Drives the REAL ProfileStore, projection view,
// ProfileSync (scheduler + writer lease via real navigator.locks) and V3 transport in Node,
// and reads the virtual Drive exactly as the Heart Watcher gate does (hash-verified device read).
import {pathToFileURL} from 'node:url';
import path from 'node:path';
const ROOT = path.resolve(import.meta.dirname, "..");
const U = (rel) => pathToFileURL(path.join(ROOT, rel)).href;
const {installFakeIndexedDB, createVirtualDirectory, settle} = await import(U('tools/lib/browser-test-env.mjs'));
const {setSnapshotFreezeEnabled} = await import(U('src/profile/profile-snapshot.js'));
setSnapshotFreezeEnabled(true);
const {ProfileStore} = await import(U('src/profile/profile-store.js'));
const {ProfileSync} = await import(U('src/profile/profile-sync.js'));
const {createProfileProjectionView} = await import(U('src/profile/profile-projection-view.js'));
const Store = await import(U('src/storage/profile-sync-store.js'));
const Channel = await import(U('src/profile/local-state-channel.js'));
const T = await import(U('src/profile/sync-v3-transport.js'));

const DEVICE = 'dev-e50184fd-aaaa-4bbb-8ccc-ddddeeeeffff';
let counter = 1_800_000_000_000;
const identity = () => ({ready: Promise.resolve(), deviceId: DEVICE, isEphemeral: false, label: 'Chromebook Pro',
  observeReplica() { return this; }, observe() { return this; }, tick() { counter += 1; return {t: counter, d: DEVICE}; }, async flush() {}});

const idb = installFakeIndexedDB(); const IDB = globalThis.indexedDB;
const dir = createVirtualDirectory('Drive');
const CH = 'hl-chan-1';
const results = [];
const mute = () => { const w = console.warn, l = console.log, e = console.error; return () => { console.warn = w; console.log = l; console.error = e; }; };

async function openTab(label) {
  globalThis.indexedDB = IDB;
  const channel = Channel.createLocalStateChannel({channelName: CH, factory: null, onMessage: null});
  const store = new ProfileStore({identity: identity(), associationStore: Store.V3_ASSOCIATION_STORE, localStateChannel: channel});
  await settle(20); await store.whenFactsSettled(); await store.whenAssociationsSettled();
  const sync = new ProfileSync(store);
  await sync.connectV3Folder(dir.handle); await settle(); await sync.activateSyncV3(); await settle();
  return {label, store, sync};
}
async function closeTab(t) { try { t.sync.dispose(); } catch {} try { t.store.closeLocalStateChannel(); } catch {} await settle(10); }

// What the Heart Watcher can see: hash-verified read of the device generation.
async function driveView(profileId) {
  const root = await T.getSyncV3Root(dir.handle, {create: false});
  const devices = await T.getDevicesDir(root, {create: false});
  const names = await T.listDeviceDirectoryNames(devices);
  if (!names.length) return {status: 'none', hearts: new Set()};
  const gen = await T.readDeviceDirectory(devices, names[0]);
  if (gen.status !== 'valid') return {status: gen.status, reason: gen.reason, hearts: new Set()};
  const items = gen.replica.profiles?.[profileId]?.items || {};
  const hearts = new Set(Object.entries(items).filter(([, i]) => i.favorite?.v?.on === true).map(([p]) => p));
  return {status: 'valid', hearts};
}
async function until(profileId, paths, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await driveView(profileId);
    if (v.status === 'valid' && paths.every((p) => v.hearts.has(p))) return {ok: true, ms: Date.now() - t0, status: v.status};
    await new Promise((r) => setTimeout(r, 250));
  }
  const v = await driveView(profileId);
  return {ok: false, ms, status: v.status, missing: paths.filter((p) => !v.hearts.has(p)), reason: v.reason};
}
function record(step, r, extra = '') { results.push({step, ...r}); console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${step}  ${r.ok ? `(visible on Drive after ${r.ms} ms)` : `NOT on Drive after ${r.ms} ms; drive status=${r.status} missing=${JSON.stringify(r.missing)}`} ${extra}`); }

// ---- A. existing hearts present ------------------------------------------------
let tab1 = await openTab('tab1');
const beast = (await tab1.store.createProfile('BEAST')).id;
const other = (await tab1.store.createProfile('Other')).id;
await tab1.store.setPrimaryCuration(beast); await tab1.store.switchProfile(beast);
let view = createProfileProjectionView({profile: tab1.store});
const existing = Array.from({length: 5}, (_, i) => `instagram/acct/old${i}.jpg`);
for (const p of existing) view.setFavorite(p, true);
await tab1.store.whenFactsSettled();
await tab1.sync.syncNow(); await settle(30);
record('A. 5 existing hearts published (initial sync)', await until(beast, existing));
console.log('   writer status:', JSON.stringify({mode: tab1.sync.getStatus().mode, blocked: tab1.sync.getStatus().v3PublishBlocked}));

// ---- B. heart #1 (no manual sync) ----------------------------------------------
const h1 = 'instagram/acct/new1.jpg';
view.setFavorite(h1, true);
record('B. heart #1, no manual sync', await until(beast, [h1]));

// ---- C. hearts #2, #3 (no reload) ----------------------------------------------
const h2 = 'instagram/acct/new2.jpg', h3 = 'instagram/acct/new3.jpg';
view.setFavorite(h2, true);
await new Promise((r) => setTimeout(r, 700));
view.setFavorite(h3, true);
record('C. hearts #2/#3 (second+third, no reload)', await until(beast, [h2, h3]));

// ---- D1. reload source (new projection view over same store) --------------------
view = createProfileProjectionView({profile: tab1.store});
const h4 = 'instagram/acct/new4.jpg'; view.setFavorite(h4, true);
record('D1. "reload source" (fresh projection view) then heart', await until(beast, [h4]));

// ---- D2. full page reload (new ProfileStore + ProfileSync on same IndexedDB) ----
await closeTab(tab1);
tab1 = await openTab('tab1-reloaded');
view = createProfileProjectionView({profile: tab1.store});
const h5 = 'instagram/acct/new5.jpg'; view.setFavorite(h5, true);
record('D2. full page reload then heart', await until(beast, [h5]));

// ---- E. switch away and back to the same Curation -------------------------------
await tab1.store.switchProfile(other); await settle(20);
await tab1.store.switchProfile(beast); await settle(20);
view = createProfileProjectionView({profile: tab1.store});
const h6 = 'instagram/acct/new6.jpg'; view.setFavorite(h6, true);
record('E. switch Curation away/back then heart', await until(beast, [h6]));

// ---- F. two tabs, same device: heart in the READER tab --------------------------
const tab2 = await openTab('tab2');
const st1 = tab1.sync.getStatus(), st2 = tab2.sync.getStatus();
console.log('   tab1 blocked:', st1.v3PublishBlocked, '| tab2 blocked:', st2.v3PublishBlocked);
const reader = st1.v3PublishBlocked ? tab1 : tab2;
const writer = reader === tab1 ? tab2 : tab1;
console.log('   writer is', writer.label, 'reader is', reader.label);
await reader.store.switchProfile(beast);
const rview = createProfileProjectionView({profile: reader.store});
const h7 = 'instagram/acct/fromReader1.jpg', h8 = 'instagram/acct/fromReader2.jpg';
rview.setFavorite(h7, true);
record('F1. heart made in the READER tab (writer tab idle)', await until(beast, [h7]));
rview.setFavorite(h8, true);
record('F2. second heart in the reader tab', await until(beast, [h8]));
const wview = createProfileProjectionView({profile: writer.store});
const h9 = 'instagram/acct/fromWriter.jpg';
wview.setFavorite(h9, true);
record('F3. heart in the writer tab with reader open', await until(beast, [h9]));

// ---- G. reader tab becomes the only tab (writer closes) --------------------------
await closeTab(writer);
const h10 = 'instagram/acct/afterWriterClosed.jpg';
await reader.store.switchProfile(beast);
createProfileProjectionView({profile: reader.store}).setFavorite(h10, true);
record('G. writer tab closed; heart in the surviving tab (lease handover)', await until(beast, [h10], 25000));

// Own generation corruption/mixed visibility must recover without another edit.
const beforeFacts = JSON.stringify((await reader.store.getFullReplica()).profiles[beast].items);
function mixOwnGeneration() {
  const files = dir.snapshotFiles();
  const manifestPath = Object.keys(files).find(p => p.endsWith('/device.json'));
  const manifest = JSON.parse(files[manifestPath]);
  const entry = manifest.profiles.find(p => p.id === beast);
  const profilePath = manifestPath.slice(0, -'device.json'.length) + entry.file;
  dir.writeFile(profilePath, files[profilePath] + "\n");
}
mixOwnGeneration();
const rejected = await driveView(beast);
if (rejected.status !== 'invalid') throw Error('mixed generation must be rejected');
record('I. idle own hash mismatch automatically repairs', await until(beast, [h10], 45000));
if (JSON.stringify((await reader.store.getFullReplica()).profiles[beast].items) !== beforeFacts) throw Error('repair changed favorite facts');
record('J. repair preserved exact facts without re-hearting', {ok:true,ms:0});
mixOwnGeneration();
await closeTab(reader);
const reopened = await openTab('reopened-invalid');
record('I2. full reload repairs invalid own generation automatically', await until(beast,[h10],15000));
await closeTab(reopened);
console.log('\nSUMMARY');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.step}`);
await closeTab(reader);
process.exit(results.every(r => r.ok) ? 0 : 1);
