import assert from 'node:assert/strict';
import {installFakeIndexedDB,settle} from './lib/browser-test-env.mjs';
import {ProfileStore} from '../src/profile/profile-store.js';
import {SyncIdentity} from '../src/profile/sync-device.js';
import {loadRegistry} from '../src/profile/indexeddb.js';
import {createLocalStateChannel} from '../src/profile/local-state-channel.js';
installFakeIndexedDB();
const store=new ProfileStore({identity:new SyncIdentity(),localStateChannel:createLocalStateChannel({factory:null})});
await settle(20);await store.whenLocalWritesSettled();
const original=store.getProfileId();
const target=(await store.createProfile('Intake destination')).id;
await store.whenLocalWritesSettled();
await store.switchProfile(target);store.setFavorite('target-before.jpg',true);await store.whenLocalWritesSettled();
await store.switchProfile(original);store.setFavorite('original-before.jpg',true);await store.whenLocalWritesSettled();

const nativeOpen=indexedDB.open.bind(indexedDB);
let nextGate=null;
indexedDB.open=(name,...args)=>{
 const request=nativeOpen(name,...args);
 if(name==='loop-browser-gallery'&&nextGate){
  const gate=nextGate;nextGate=null;let success=null;
  Object.defineProperty(request,'onsuccess',{get(){return event=>{gate.deliver=()=>success?.(event);gate.enter();};},set(fn){success=fn;}});
 }
 return request;
};
function holdNextProfileOpen(){
 let enter;const entered=new Promise(resolve=>enter=resolve);
 const gate={enter,entered,deliver:null};nextGate=gate;return gate;
}

// A stalled target read can finish after intake abandons its optional policy.
let current=true;
const read=holdNextProfileOpen();
const staleSwitch=store.switchProfile(target,{isCurrent:()=>current});
await read.entered;
assert.equal(store.getProfileId(),original,'pending target read leaves active Profile intact');
store.setFavorite('while-target-read-pending.jpg',true);await store.whenLocalWritesSettled();
current=false;read.deliver();
assert.equal(await staleSwitch,false,'cancelled preload does not activate target later');
assert.equal(store.getProfileId(),original);
assert.equal((await loadRegistry()).activeProfileId,original,'cancelled restore never writes target pointer');
assert(store.isFavorite('original-before.jpg'));assert(store.isFavorite('while-target-read-pending.jpg'));

// Cancellation is checked again after draining a blocked outgoing save.
const save=holdNextProfileOpen();
store.setFavorite('while-save-pending.jpg',true);await save.entered;
current=true;const afterDrain=store.switchProfile(target,{isCurrent:()=>current});
await settle(10);assert.equal(store.getProfileId(),original);
current=false;save.deliver();assert.equal(await afterDrain,false);
await store.whenLocalWritesSettled();assert.equal(store.getProfileId(),original);
assert(store.isFavorite('while-save-pending.jpg'));

// Successful optional switching has data ready before exposing the new pointer.
let targetSeen=false;
const unsubscribe=store.subscribe(()=>{if(store.getProfileId()===target){targetSeen=true;assert(store.isFavorite('target-before.jpg'),'target records adopted before subscribers see target');}});
assert.equal(await store.switchProfile(target,{isCurrent:()=>true}),true);
unsubscribe();assert(targetSeen);assert.equal((await loadRegistry()).activeProfileId,target);
store.setFavorite('target-after.jpg',true);await store.whenLocalWritesSettled();
const replica=await store.getFullReplica();
assert(replica.profiles[original].items['while-save-pending.jpg'].favorite.v.on);
assert(replica.profiles[target].items['target-after.jpg'].favorite.v.on);
assert.equal(replica.profiles[target].items['while-save-pending.jpg'],undefined,'old hearts stay in original Curation');
assert.equal(await store.switchProfile(original,{isCurrent:()=>false}),false);
assert.equal(store.getProfileId(),target);
store.closeLocalStateChannel();
console.log('PASS guarded intake switch: cancelled read/drain cannot switch late; old hearts preserved; successful target adoption is complete');
process.exit(0);
