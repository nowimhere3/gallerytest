import { installFakeIndexedDB, createVirtualDirectory } from "./lib/browser-test-env.mjs";

installFakeIndexedDB();
const Registry = await import("../src/storage/library-registry.js");

let assertions = 0;
function assert(condition, label) {
  if (!condition) throw new Error(label);
  assertions += 1;
}

const folderAHandle = createVirtualDirectory("Folder A").handle;
const folderBHandle = createVirtualDirectory("Folder B").handle;
const folderA = await Registry.addOrUpdateLibrary(folderAHandle);
const folderB = await Registry.addOrUpdateLibrary(folderBHandle);
await Registry.setLibraryProfile(folderA.id, "profile-a");

const linkedA = await Registry.linkLocalLibraryToSharedId(folderA.id, "shared-a");
assert(linkedA.libraryId === "shared-a", "an unclaimed shared Library can be linked");

const collision = await Registry.linkLocalLibraryToSharedId(folderB.id, "shared-a");
assert(collision && collision.ok === false && collision.reason === "claimed", "a second local claimant is refused");
assert(collision.by.id === folderA.id && collision.by.name === "Folder A", "claim refusal identifies the owning folder");
assert((await Registry.getLibraryById(folderB.id)).libraryId == null, "claim refusal changes no local row");

const selfLink = await Registry.linkLocalLibraryToSharedId(folderA.id, "shared-a");
assert(selfLink.libraryId === "shared-a", "same-row same-Library linking is idempotent");
assert(await Registry.linkLocalLibraryToSharedId(folderA.id, "shared-b") === null, "direct A to B relinking remains refused");

const beforeUnlink = await Registry.getLibraryById(folderA.id);
const unlinked = await Registry.unlinkLocalLibraryFromSharedId(folderA.id);
assert(unlinked.libraryId === null, "unlink clears libraryId");
assert(unlinked.id === beforeUnlink.id, "unlink preserves the local row id");
assert(unlinked.handle === beforeUnlink.handle, "unlink preserves the physical handle");
assert(unlinked.profileId === "profile-a", "unlink preserves profileId");
assert(unlinked.removedFromRecents === beforeUnlink.removedFromRecents, "unlink preserves recent-list state");
assert(unlinked.sourceKind === beforeUnlink.sourceKind, "unlink preserves source kind");
assert((await Registry.getLibraryById(folderA.id)) !== null, "unlink does not remove the local row");

const linkedB = await Registry.linkLocalLibraryToSharedId(folderA.id, "shared-b");
assert(linkedB.libraryId === "shared-b", "an unlinked row can link to another shared Library");

const { ProfileStore } = await import("../src/profile/profile-store.js");
const { resolveScopeForRoot } = await import("../src/storage/media-scope.js");
const promotedFolder = await Registry.addOrUpdateLibrary(createVirtualDirectory("Promoted Folder").handle);
const store = new ProfileStore();
await store.whenFactsSettled();
await store.whenLibrariesSettled();
const activeProfileBefore = store.getProfileId();
const associationsBefore = JSON.stringify(store.getAssociations());

const promotedId = await store.promoteLibraryToShared(promotedFolder.id, { name: "Promoted Folder" });
const promotedAgain = await store.promoteLibraryToShared(promotedFolder.id, { name: "Promoted Folder" });
assert(typeof promotedId === "string" && promotedId.length > 0, "first promotion mints a shared Library id");
assert(promotedAgain === promotedId, "second promotion preserves the same shared Library id");
assert((await Registry.getLibraryById(promotedFolder.id)).libraryId === promotedId, "promotion persists the local link");
assert(store.listLibraries().some((library) => library.id === promotedId), "promotion adds the Library to the shared catalog");
assert(JSON.stringify(store.getAssociations()) === associationsBefore, "promotion writes no association fact");
assert((await store.unlinkLocalLibraryFromShared(promotedFolder.id)).libraryId === null,
  "unlink removes only the promoted folder's local shared-Library link");
assert(store.listLibraries().some((library) => library.id === promotedId),
  "unlink does not delete the promoted shared Library from the catalog");
assert(store.getProfileId() === activeProfileBefore, "promotion leaves Active Profile unchanged");

// [SYNCV3 / STAGE-08 / LINK-AND-SYNC]
// [WHY: link identity is intentionally orthogonal to active Profile, curation,
// shared association facts, and MEDIA-ID scope. Exercise the full allowed
// link -> unlink -> different link transition against all five boundaries.]
const invariantHandle = createVirtualDirectory("Invariant Folder").handle;
const invariantFolder = await Registry.addOrUpdateLibrary(invariantHandle);
const mediaScopeBefore = await resolveScopeForRoot({
  rootId: invariantFolder.id,
  handle: invariantHandle,
  knownRootHandles: [],
});
const tag = store.createTag("Invariant Tag");
store.setFavorite("proof.jpg", true);
store.setHidden("proof.jpg", true);
store.setItemTag("proof.jpg", tag.id, true);
await store.whenFactsSettled();
const invariantBefore = {
  activeProfileId: store.getProfileId(),
  favorite: store.isFavorite("proof.jpg"),
  hidden: store.isHidden("proof.jpg"),
  tags: JSON.stringify(store.getItemTags("proof.jpg")),
  associations: JSON.stringify(store.getAssociations()),
};

assert((await store.linkLocalLibraryToShared(invariantFolder.id, "shared-proof-a")).libraryId === "shared-proof-a",
  "integration transition links to the first shared Library");
assert((await store.unlinkLocalLibraryFromShared(invariantFolder.id)).libraryId === null,
  "integration transition unlinks the physical folder only");
assert((await store.linkLocalLibraryToShared(invariantFolder.id, "shared-proof-b")).libraryId === "shared-proof-b",
  "integration transition links to a different Library after unlink");
const mediaScopeAfter = await resolveScopeForRoot({
  rootId: invariantFolder.id,
  handle: invariantHandle,
  knownRootHandles: [],
});
assert(store.getProfileId() === invariantBefore.activeProfileId, "link transitions preserve Active Profile ID");
assert(store.listProfiles().some((entry) => entry.id === invariantBefore.activeProfileId),
  "link transitions do not delete the active Profile record");
assert(store.isFavorite("proof.jpg") === invariantBefore.favorite, "link transitions preserve Favorite truth");
assert(store.isHidden("proof.jpg") === invariantBefore.hidden, "link transitions preserve Hidden truth");
assert(JSON.stringify(store.getItemTags("proof.jpg")) === invariantBefore.tags, "link transitions preserve Tags truth");
assert(JSON.stringify(store.getAssociations()) === invariantBefore.associations,
  "link transitions preserve shared Library-Profile association facts");
assert(mediaScopeAfter.scopeId === mediaScopeBefore.scopeId && mediaScopeAfter.rootId === mediaScopeBefore.rootId,
  "link transitions preserve MEDIA-ID scope identity");
store.closeLocalStateChannel();

console.log(`library link: ${assertions} assertions passed`);
