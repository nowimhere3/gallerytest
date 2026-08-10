// [FSA] Persists ONE FileSystemDirectoryHandle — the last folder chosen via
// the File System Access API — so a future session can offer "Start Here"
// instead of requiring the user to browse again.
//
// Deliberately its OWN database, entirely separate from ProfileStore's
// "loop-browser-gallery" database (src/profile/indexeddb.js). Handles are
// structured-clonable and IndexedDB-storable directly (no serialization
// needed), but they are a different KIND of data than profile
// items/tags/registry — mixing them into the same store/schema would mean
// every future profile-schema migration also has to reason about handle
// storage, for no benefit. This module is intentionally the only thing
// that touches this database.
//
// A single fixed key is used because this MVP remembers exactly one
// "last folder," not a history/list of folders.

const DATABASE_NAME = "loop-browser-gallery-fsa";
const DATABASE_VERSION = 1;
const STORE_NAME = "handles";
const HANDLE_KEY = "lastFolder";

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open the folder-handle database."));
  });
}

function completeTransaction(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error("Folder-handle database operation failed."));
    transaction.onabort = () => reject(transaction.error || new Error("Folder-handle database operation was aborted."));
  });
}

/**
 * Saves the given FileSystemDirectoryHandle as "the last folder." Replaces
 * whatever was saved before — this MVP only ever remembers one.
 */
export async function saveFolderHandle(handle) {
  const database = await openDatabase();

  try {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put({ id: HANDLE_KEY, handle, savedAt: Date.now() });
    await completeTransaction(transaction);
  } finally {
    database.close();
  }
}

/**
 * Returns { handle, savedAt } for the last saved folder, or null if none has
 * been saved (or the browser can't store handles at all — see the try/catch
 * below; this never throws for "nothing saved yet," only for a genuine
 * database failure).
 */
export async function loadFolderHandle() {
  const database = await openDatabase();

  try {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).get(HANDLE_KEY);
    const result = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Could not read the saved folder handle."));
    });

    await completeTransaction(transaction);
    return result && result.handle ? { handle: result.handle, savedAt: result.savedAt || null } : null;
  } finally {
    database.close();
  }
}

/**
 * Forgets the saved folder — used when a saved handle turns out to be
 * stale/invalid, so a broken "Start Here" doesn't keep reappearing.
 */
export async function clearFolderHandle() {
  const database = await openDatabase();

  try {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(HANDLE_KEY);
    await completeTransaction(transaction);
  } finally {
    database.close();
  }
}
