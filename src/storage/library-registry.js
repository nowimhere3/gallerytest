// [LIBRARY-REGISTRY] Persists a LIST of previously-chosen FSA folders
// ("libraries") so the app can offer "Recent Libraries" instead of a
// single fixed "last folder" slot. This replaces fsa-handle-store.js's
// one-slot design with a genuine registry, while keeping the same
// database — this module owns a NEW object store (`libraries`) inside it,
// and migrates the old single-slot entry (if one exists from a prior
// session) into the list exactly once.
//
// This module ONLY persists identity/metadata (handle, name, counts,
// timestamps, and — as of Phase 8.4 — an associated profileId). It knows
// nothing about scanning, MediaItems, or the FSA traversal itself — that
// stays FsaFileProvider's job. Deliberately kept out of ProfileStore's
// database too, same reasoning as the file it replaces: a library record
// is a different kind of data than profile items/tags, and mixing them
// would make every future profile-schema migration also have to reason
// about this.
//
// Deliberately NOT tracking webkitdirectory-picked folders: a File List
// from <input webkitdirectory> carries no reusable handle or permission,
// so there is nothing here that could actually "resume" one without a
// full manual re-pick — the same friction as today. Listing it as a fake
// "recent library" would be a misleading affordance, not a shortcut.
//
// ---- Phase 8.4 — Library <-> Profile association --------------------
//
// [LIBRARY-PROFILE-ASSOCIATION] This is the SINGLE authoritative place
// "this physical folder belongs with this profileId" is stored — a
// `profileId` field directly on the SAME record `isSameEntry()` already
// uses to recognize a physical folder (see addOrUpdateLibrary below). No
// separate association table was introduced: the library record already
// IS keyed by physical folder identity, so a second registry mapping
// identity -> profileId would just be a second source of truth for the
// same fact, with its own copy of the same isSameEntry() dedup logic to
// keep in sync. One record, one place a stale/duplicate association could
// live: nowhere.
//
// A "Recent Library" shortcut and the historical folder<->profile
// association are still conceptually different things (see
// `removedFromRecents` below) — they just happen to be safely
// representable on the same row, which is what the phase spec asked for
// when one registry can do it.
const DATABASE_NAME = "loop-browser-gallery-fsa";
const DATABASE_VERSION = 2; // v1: `handles` only. v2: adds `libraries`.
const LEGACY_STORE_NAME = "handles";
const LEGACY_KEY = "lastFolder";
const STORE_NAME = "libraries";

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(LEGACY_STORE_NAME)) {
        database.createObjectStore(LEGACY_STORE_NAME, { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open the library registry database."));
  });
}

function completeTransaction(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error("Library registry operation failed."));
    transaction.onabort = () => reject(transaction.error || new Error("Library registry operation was aborted."));
  });
}

function generateLibraryId() {
  return `lib-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Library registry request failed."));
  });
}

// Runs once per call to listLibraries(): if the OLD single-slot store
// still has an entry and the NEW list is empty, carries it over as the
// first library record, then removes the legacy entry so this only ever
// happens once. Never overwrites an existing list — if the user already
// has libraries recorded (this migration already ran, or they're on a
// fresh install), the legacy entry (if any) is left alone rather than
// risking a duplicate or clobbering newer data.
async function migrateLegacyHandleIfNeeded(database) {
  const readTx = database.transaction([LEGACY_STORE_NAME, STORE_NAME], "readonly");
  const [legacy, existing] = await Promise.all([
    requestToPromise(readTx.objectStore(LEGACY_STORE_NAME).get(LEGACY_KEY)),
    requestToPromise(readTx.objectStore(STORE_NAME).getAll()),
  ]);
  await completeTransaction(readTx);

  if (!legacy || !legacy.handle || (existing && existing.length)) return;

  const record = {
    id: generateLibraryId(),
    name: legacy.handle.name || "Library",
    handle: legacy.handle,
    itemCount: null,
    lastOpenedAt: legacy.savedAt || Date.now(),
    lastScannedAt: null,
    createdAt: legacy.savedAt || Date.now(),
  };

  const writeTx = database.transaction([LEGACY_STORE_NAME, STORE_NAME], "readwrite");
  writeTx.objectStore(STORE_NAME).put(record);
  writeTx.objectStore(LEGACY_STORE_NAME).delete(LEGACY_KEY);
  await completeTransaction(writeTx);
}

/**
 * Returns remembered libraries meant for the "Recent Libraries" shortcut
 * list — most-recently-opened first, EXCLUDING any that were removed from
 * that list via removeFromRecents() (see below). Runs the one-time legacy
 * migration first (see above) so a folder saved before this module
 * existed still shows up.
 *
 * [LIBRARY-PROFILE-ASSOCIATION] This filtering is exactly why "remove
 * from Recent Libraries" and "forget everything about this folder" are
 * different operations on this record rather than one delete: this
 * function is the ONLY thing that needs to stop seeing a
 * removed-from-recents record. addOrUpdateLibrary()'s identity matching
 * below deliberately does NOT use this function — it reads the raw store
 * directly — so a folder removed from Recent Libraries can still be
 * recognized (and its profile association recovered) the next time it's
 * FSA-picked again.
 */
export async function listLibraries() {
  const database = await openDatabase();

  try {
    await migrateLegacyHandleIfNeeded(database);

    const transaction = database.transaction(STORE_NAME, "readonly");
    const records = await requestToPromise(transaction.objectStore(STORE_NAME).getAll());
    await completeTransaction(transaction);

    return records
      .filter((record) => !record.removedFromRecents)
      .sort((a, b) => (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0));
  } finally {
    database.close();
  }
}

/**
 * Registers a newly-picked FileSystemDirectoryHandle as a library, or —
 * if it refers to the SAME folder as an existing record (checked via the
 * real FSA `isSameEntry()` identity method, not name matching, which
 * would false-positive on two differently-located folders that happen to
 * share a name) — updates that existing record instead of creating a
 * duplicate every time "Choose Folder (FSA)" is used on a folder that's
 * already registered.
 *
 * [LIBRARY-PROFILE-ASSOCIATION] Matching is deliberately performed
 * against EVERY stored record, including ones removedFromRecents — see
 * listLibraries() above. If a match IS found, `removedFromRecents` is
 * explicitly cleared (Test D: re-picking a folder that was "X"'d re-adds
 * it to Recent Libraries) while `profileId` is preserved by the `{
 * ...match }` spread below (re-picking recovers the historical
 * association, it doesn't reset it).
 *
 * Returns the resulting library record (existing or newly created).
 */
export async function addOrUpdateLibrary(handle) {
  const database = await openDatabase();

  try {
    const readTx = database.transaction(STORE_NAME, "readonly");
    const records = await requestToPromise(readTx.objectStore(STORE_NAME).getAll());
    await completeTransaction(readTx);

    let match = null;
    for (const record of records) {
      try {
        if (record.handle && (await handle.isSameEntry(record.handle))) {
          match = record;
          break;
        }
      } catch (error) {
        // A stored handle can be stale enough that isSameEntry() itself
        // throws (e.g. permission fully revoked) — treat as "not a
        // match" rather than aborting the whole lookup.
      }
    }

    const now = Date.now();
    const record = match
      ? { ...match, name: handle.name, handle, removedFromRecents: false }
      : {
          id: generateLibraryId(),
          name: handle.name,
          handle,
          itemCount: null,
          lastOpenedAt: now,
          lastScannedAt: null,
          createdAt: now,
          profileId: null,
          removedFromRecents: false,
        };

    const writeTx = database.transaction(STORE_NAME, "readwrite");
    writeTx.objectStore(STORE_NAME).put(record);
    await completeTransaction(writeTx);

    return record;
  } finally {
    database.close();
  }
}

/**
 * Updates a library record's counters after a load attempt (successful
 * or not — `itemCount: null` is a valid call if the load failed outright
 * and nothing should be assumed about the folder's contents).
 */
export async function touchLibrary(id, { itemCount, scannedAt = Date.now(), openedAt = Date.now() } = {}) {
  const database = await openDatabase();

  try {
    const readTx = database.transaction(STORE_NAME, "readonly");
    const record = await requestToPromise(readTx.objectStore(STORE_NAME).get(id));
    await completeTransaction(readTx);
    if (!record) return null;

    const updated = {
      ...record,
      itemCount: typeof itemCount === "number" ? itemCount : record.itemCount,
      lastScannedAt: scannedAt,
      lastOpenedAt: openedAt,
    };

    const writeTx = database.transaction(STORE_NAME, "readwrite");
    writeTx.objectStore(STORE_NAME).put(updated);
    await completeTransaction(writeTx);

    return updated;
  } finally {
    database.close();
  }
}

/**
 * Sets (or, with profileId = null, clears) which Profile this physical
 * library is associated with. This is the one function that writes the
 * durable Library <-> Profile relationship described at the top of this
 * file. No-op (returns null) if the library id isn't known.
 */
export async function setLibraryProfile(id, profileId) {
  const database = await openDatabase();

  try {
    const readTx = database.transaction(STORE_NAME, "readonly");
    const record = await requestToPromise(readTx.objectStore(STORE_NAME).get(id));
    await completeTransaction(readTx);
    if (!record) return null;

    const updated = { ...record, profileId: profileId || null };

    const writeTx = database.transaction(STORE_NAME, "readwrite");
    writeTx.objectStore(STORE_NAME).put(updated);
    await completeTransaction(writeTx);

    return updated;
  } finally {
    database.close();
  }
}

/**
 * Removes one library from the "Recent Libraries" shortcut list ("X" in
 * the UI) WITHOUT erasing what this module knows about the physical
 * folder — its identity (handle, for isSameEntry() matching) and its
 * profileId association both survive. See listLibraries() and
 * addOrUpdateLibrary() above for the two places that reflects: the record
 * stops appearing in Recent Libraries, but re-picking the same physical
 * folder later still recognizes it and recovers the association.
 *
 * No-op if the library id isn't known.
 */
export async function removeFromRecents(id) {
  const database = await openDatabase();

  try {
    const readTx = database.transaction(STORE_NAME, "readonly");
    const record = await requestToPromise(readTx.objectStore(STORE_NAME).get(id));
    await completeTransaction(readTx);
    if (!record) return;

    const writeTx = database.transaction(STORE_NAME, "readwrite");
    writeTx.objectStore(STORE_NAME).put({ ...record, removedFromRecents: true });
    await completeTransaction(writeTx);
  } finally {
    database.close();
  }
}

/**
 * Permanently forgets a library — identity, handle, AND its profile
 * association. This is the "erase everything" operation the phase spec
 * explicitly deferred a dedicated UI for ("Forget Association" / "Forget
 * Library Identity"); nothing in this app's UI currently calls this. Kept
 * available for that future feature and for genuinely broken records that
 * should never resurface.
 */
export async function removeLibrary(id) {
  const database = await openDatabase();

  try {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(id);
    await completeTransaction(transaction);
  } finally {
    database.close();
  }
}
