import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as F from '../src/profile/sync-facts.js';
import { mergeReplicas, forEachFact } from '../src/profile/sync-merge.js';
import * as T from '../src/profile/sync-v3-transport.js';
import * as S from '../src/storage/profile-sync-store.js';
import { createVirtualDirectory, installFakeIndexedDB } from './lib/browser-test-env.mjs';

const a = F.setPrimaryCuration(F.emptyReplica(), 'best', { t: 100, d: 'a' });
const b = F.setPrimaryCuration(F.emptyReplica(), 'family', { t: 100, d: 'b' });
const off = F.setPrimaryCuration(a, null, { t: 101, d: 'a' });
assert.deepEqual(mergeReplicas(a, b), mergeReplicas(b, a));
assert.equal(mergeReplicas(a, b).primaryCuration.v, 'family');
assert.deepEqual(mergeReplicas(a, off).primaryCuration, off.primaryCuration);
assert.deepEqual(mergeReplicas(off, a).primaryCuration, off.primaryCuration);
assert.equal(a.primaryCuration.v, 'best');
const facts = []; forEachFact(off, (f) => facts.push(f));
assert.equal(Math.max(...facts.map((f) => f.t)), 101);
assert.deepEqual(F.findSessionStateLeaks(off), []);
for (const value of ['', 4, {}, undefined]) assert.throws(() => F.setPrimaryCuration(a, value, { t: 102, d: 'a' }));
assert(F.findSessionStateLeaks({ ...a, primaryCuration: { v: {}, t: 1, d: 'a' } }).length);

installFakeIndexedDB();
assert.equal(await S.getPrimaryCurationV3(), null);
await S.putPrimaryCurationV3(a.primaryCuration);
assert.deepEqual(await S.getPrimaryCurationV3(), a.primaryCuration);
await S.putPrimaryCurationV3(off.primaryCuration);
assert.deepEqual(await S.getPrimaryCurationV3(), off.primaryCuration);
await assert.rejects(S.putPrimaryCurationV3({ v: 5, t: 1, d: 'a' }));
assert.deepEqual(await S.getPrimaryCurationV3(), off.primaryCuration);

for (const value of [undefined, null, a.primaryCuration, off.primaryCuration]) {
  const dir = createVirtualDirectory('Primary test');
  const root = await T.getSyncV3Root(dir.handle, { create: true });
  const devices = await T.getDevicesDir(root, { create: true });
  const replica = { ...F.emptyReplica(), schemaVersion: 3 };
  if (value === undefined) delete replica.primaryCuration;
  else replica.primaryCuration = value;
  const published = await T.publishOwnReplicaVerified(devices, { deviceId: 'device-a', label: 'Test', replica });
  assert.equal(published.ok, true);
  const read = await T.readDeviceDirectory(devices, published.directoryName);
  assert.equal(read.status, 'valid');
  assert.deepEqual(read.replica.primaryCuration, value ?? null);
  // Rehash a legacy or invalid envelope, exercising shape validation beyond hash integrity.
  const device = await devices.getDirectoryHandle(published.directoryName);
  const envelopeHandle = await device.getFileHandle(T.ASSOCIATIONS_FILE_NAME);
  const envelope = JSON.parse(await (await envelopeHandle.getFile()).text());
  if (value === undefined) delete envelope.primaryCuration;
  else envelope.primaryCuration = { v: 7, t: 1, d: 'a' };
  const bytes = JSON.stringify(envelope);
  let writer = await envelopeHandle.createWritable(); await writer.write(bytes); await writer.close();
  const manifestHandle = await device.getFileHandle(T.DEVICE_FILE_NAME);
  const manifest = JSON.parse(await (await manifestHandle.getFile()).text());
  if (manifest.hashAlgo === 'sha256' || manifest.associationsHash.length === 64) {
    manifest.associationsHash = createHash('sha256').update(bytes).digest('hex');
  } else {
    let hash = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i++) { hash ^= bytes.charCodeAt(i); hash = Math.imul(hash, 0x01000193); }
    manifest.associationsHash = (hash >>> 0).toString(16).padStart(8, '0');
  }
  writer = await manifestHandle.createWritable(); await writer.write(JSON.stringify(manifest)); await writer.close();
  const changed = await T.readDeviceDirectory(devices, published.directoryName);
  assert.equal(changed.status, value === undefined ? 'valid' : 'invalid');
  if (value !== undefined) assert.equal(changed.reason, 'primary-curation-shape');
}
console.log('PASS Primary Curation foundation: merge, Off, traversal, validation, persistence, transport and legacy reads');
