import assert from "node:assert/strict";
import { installFakeIndexedDB, settle } from "./lib/browser-test-env.mjs";
import { executeFavoriteCurrent } from "../src/runtime/streamloop-bridge.js";
installFakeIndexedDB();
const { ProfileStore } = await import("../src/profile/profile-store.js");
const { SyncIdentity } = await import("../src/profile/sync-device.js");
const { createProfileProjectionView } = await import("../src/profile/profile-projection-view.js");
const identity = new SyncIdentity({});
const profile = new ProfileStore({ identity });
await settle(); await profile.whenFactsSettled();
const view = createProfileProjectionView({ profile });
const runtime = { getCurrentItem: () => ({ relativePath: "cat.jpg" }), toggleFavorite() { assert.fail("never toggle"); } };
const command = { generation: " opaque generation ", requestId: "request" };
let writes = 0;
const original = view.setFavorite;
view.setFavorite = (...args) => { writes++; return original(...args); };
const run = () => executeFavoriteCurrent(command, runtime, view, () => profile.whenLocalWritesSettled());
assert.equal((await run()).status, "favorited");
assert.equal(view.isFavorite("cat.jpg"), true);
const at = profile.getFavoritedAt("cat.jpg");
assert.equal(typeof at, "number");
assert.equal((await run()).status, "already-favorite");
assert.equal(profile.getFavoritedAt("cat.jpg"), at);
assert.equal(writes, 1);
// Proven alias truth must also suppress writes to the viewed path.
view.setAliasIndex({ scopeId: "scope", rootId: "root", profileId: profile.getProfileId(),
  prefixFromScopeRoot: "", aliases: new Map([["alias.jpg", ["alias.jpg", "cat.jpg"]]]) });
assert.equal((await executeFavoriteCurrent(command, { getCurrentItem: () => ({ relativePath: "alias.jpg" }) }, view, () => profile.whenLocalWritesSettled())).status, "already-favorite");
assert.equal(writes, 1);
for (const item of [null, {}, { relativePath: "" }, { relativePath: 1 }]) {
 assert.equal((await executeFavoriteCurrent(command, { getCurrentItem: () => item }, view, () => {})).status, "no-media");
}
for (const failure of ["read", "write", "settle"]) {
 const broken = { isFavorite: () => { if (failure === "read") throw Error(); return false; },
  setFavorite: () => { if (failure === "write") throw Error(); } };
 assert.equal((await executeFavoriteCurrent(command, runtime, broken, async () => { throw Error(); })).status, "unavailable");
}
await identity.flush();
console.log("PASS real ProfileStore/projection: positive write, alias truth, timestamp preservation, no-media, failures");
process.exit(0);
