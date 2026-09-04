// [REMOTE-CASSETTE / PHASE 2A]
// BREADCRUMBS - WAS
// Remembered remote sources were individual Floppy Disk FileHandles only.
// DirectoryHandles were owned by the local-library path.
//
// BREADCRUMBS - IS
// The cassette registry may also own a typed cassette-folder DirectoryHandle.
// Reopening that record re-enumerates and rereads current top-level Floppy .txt
// files, then hands combined raw text to the existing remote-session pipeline.
//
// BREADCRUMBS - WILL BE
// Future source-neutral library features may treat remembered local folders,
// Floppy Disks, and Floppy Folders uniformly at the UI/association layer while
// their persistence owners remain separate.

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

export async function addOrUpdateCassette(handle, { sourceKind = "cassette" } = {}) {
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
          sourceKind,
          name: handle.name,
          handle,
          lastOpenedAt: now,
          createdAt: match.createdAt,
        }
      : {
          id: generateCassetteId(),
          sourceKind,
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
      sourceKind: record.sourceKind,
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
