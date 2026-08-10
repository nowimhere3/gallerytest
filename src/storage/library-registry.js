// [LIBRARY-REGISTRY] Persists a LIST of previously-chosen FSA folders
// ("libraries") so the app can offer "Recent Libraries" instead of a
// single fixed "last folder" slot. This replaces fsa-handle-store.js's
// one-slot design with a genuine registry, while keeping the same
// database — this module owns a NEW object store (`libraries`) inside it,
// and migrates the old single-slot entry (if one exists from a prior
// session) into the list exactly once.
//
// This module ONLY persists identity/metadata (handle, name, counts,
// timestamps). It knows nothing about scanning, MediaItems, or the FSA
// traversal itself — that stays FsaFileProvider's job. Deliberately kept
// out of ProfileStore's database too, same reasoning as the file it
// replaces: a library record is a different kind of data than
// profile items/tags, and mixing them would make every future
// profile-schema migration also have to reason about this.
//
// Deliberately NOT tracking webkitdirectory-picked folders: a File List
// from <input webkitdirectory> carries no reusable handle or permission,
// so there is nothing here that could actually "resume" one without a
// full manual re-pick — the same friction as today. Listing it as a fake
// "recent library" would be a misleading affordance, not a shortcut.

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
 * Returns all remembered libraries, most-recently-opened first. Runs the
 * one-time legacy migration first (see above) so a folder saved before
 * this module existed still shows up.
 */
export async function listLibraries() {
  const database = await openDatabase();

  try {
    await migrateLegacyHandleIfNeeded(database);

    const transaction = database.transaction(STORE_NAME, "readonly");
    const records = await requestToPromise(transaction.objectStore(STORE_NAME).getAll());
    await completeTransaction(transaction);

    return records
      .slice()
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
      ? { ...match, name: handle.name, handle }
      : {
          id: generateLibraryId(),
          name: handle.name,
          handle,
          itemCount: null,
          lastOpenedAt: now,
          lastScannedAt: null,
          createdAt: now,
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

/** Forgets one library — used both for explicit "Remove" and for a handle that turns out to be stale/invalid. */
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
