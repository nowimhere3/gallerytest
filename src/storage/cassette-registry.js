// [REMOTE-CASSETTE / PHASE 2A]
// BREADCRUMBS - WAS
// Remembered media sources were exclusively FSA directory handles in
// library-registry.js. Those rows carry local-library concerns including
// Curation association, shared SyncV3 identity, legacy signatures, and folder
// isSameEntry() matching. profile-sync-store.js already established that a
// separately remembered handle belongs in its own small database. Remote
// sessions used an <input type="file">, yielded no reusable handle, and were
// structurally incapable of being remembered.
//
// BREADCRUMBS - IS
// This module solely owns which remote cassette files this device remembers.
// It stores only an id, source kind, display name, FileSystemFileHandle, and two
// timestamps. It performs no permission call, file read, parse, load, or DOM
// work. Its database is separate because existing listLibraries() consumers
// (Recent Media Folders, resumeLibrary(), boot restore, eligible-folder UI, and
// folder shuffle) otherwise treat every row as a resumable folder. Removal is
// a hard delete because a cassette has no association for soft removal to save.
//
// BREADCRUMBS - WILL BE
// profileId, libraryId, signature, and itemCount stay absent: curation and
// shared identity require durable item identity, which remembering a cassette
// does not provide, while a cached count becomes stale when the file is edited.
// Remembering how to reopen a source must not quietly become knowing which item
// is which. Startup selection belongs above this module in Phase 2B. A future
// folder-of-cassettes source would be a new sourceKind here, never a directory
// handle smuggled into the local-library registry.

const DATABASE_NAME = "loop-browser-gallery-cassettes";
const DATABASE_VERSION = 1;
const STORE_NAME = "cassettes";

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open the cassette registry database."));
  });
}

function completeTransaction(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error("Cassette registry operation failed."));
    transaction.onabort = () => reject(transaction.error || new Error("Cassette registry operation was aborted."));
  });
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Cassette registry request failed."));
  });
}

function generateCassetteId() {
  return `cas-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function sortCassettes(records) {
  return records.sort((a, b) => (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0) || a.id.localeCompare(b.id));
}

export async function listCassettes() {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const records = await requestToPromise(transaction.objectStore(STORE_NAME).getAll());
    await completeTransaction(transaction);
    return sortCassettes(records);
  } finally {
    database.close();
  }
}

export async function addOrUpdateCassette(handle) {
  const database = await openDatabase();
  try {
    const readTransaction = database.transaction(STORE_NAME, "readonly");
    const records = await requestToPromise(readTransaction.objectStore(STORE_NAME).getAll());
    await completeTransaction(readTransaction);

    let match = null;
    for (const record of records) {
      try {
        if (record.handle && (await handle.isSameEntry(record.handle))) {
          match = record;
          break;
        }
      } catch {
        // A stale stored handle is not a match; keep scanning remembered rows.
      }
    }

    const now = Date.now();
    const record = match
      ? {
          id: match.id,
          sourceKind: "cassette",
          name: handle.name,
          handle,
          lastOpenedAt: now,
          createdAt: match.createdAt,
        }
      : {
          id: generateCassetteId(),
          sourceKind: "cassette",
          name: handle.name,
          handle,
          lastOpenedAt: now,
          createdAt: now,
        };

    const writeTransaction = database.transaction(STORE_NAME, "readwrite");
    writeTransaction.objectStore(STORE_NAME).put(record);
    await completeTransaction(writeTransaction);
    return record;
  } finally {
    database.close();
  }
}

export async function touchCassette(id, { openedAt = Date.now() } = {}) {
  const database = await openDatabase();
  try {
    const readTransaction = database.transaction(STORE_NAME, "readonly");
    const record = await requestToPromise(readTransaction.objectStore(STORE_NAME).get(id));
    await completeTransaction(readTransaction);
    if (!record) return null;

    const updated = {
      id: record.id,
      sourceKind: "cassette",
      name: record.name,
      handle: record.handle,
      lastOpenedAt: openedAt,
      createdAt: record.createdAt,
    };
    const writeTransaction = database.transaction(STORE_NAME, "readwrite");
    writeTransaction.objectStore(STORE_NAME).put(updated);
    await completeTransaction(writeTransaction);
    return updated;
  } finally {
    database.close();
  }
}

export async function removeCassette(id) {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(id);
    await completeTransaction(transaction);
  } finally {
    database.close();
  }
}
