// This module is deliberately the only boundary between profile data and
// IndexedDB. ProfileStore deals exclusively in plain objects.

const DATABASE_NAME = "loop-browser-gallery";
const DATABASE_VERSION = 1;
const STORE_NAME = "profiles";
const PROFILE_KEY = "default";

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
    request.onerror = () => reject(request.error || new Error("Could not open the profile database."));
  });
}

function completeTransaction(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error("Profile database operation failed."));
    transaction.onabort = () => reject(transaction.error || new Error("Profile database operation was aborted."));
  });
}

/**
 * Loads the saved profile as a plain object: item records keyed by relative
 * path, plus the tag vocabulary array. A missing saved profile is
 * represented by empty defaults for both.
 */
export async function loadProfile() {
  const database = await openDatabase();

  try {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).get(PROFILE_KEY);
    const result = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Could not read the saved profile."));
    });

    await completeTransaction(transaction);
    return {
      items: result && result.items && typeof result.items === "object" ? result.items : {},
      tags: result && Array.isArray(result.tags) ? result.tags : [],
    };
  } finally {
    database.close();
  }
}

/**
 * Saves a complete snapshot of the current profile — item records AND the
 * tag vocabulary — in a single put(). This has to happen together: put()
 * replaces the entire stored record for PROFILE_KEY, so saving one field
 * without the other would silently erase whichever field wasn't included.
 */
export async function saveProfile({ items, tags }) {
  const database = await openDatabase();

  try {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put({ id: PROFILE_KEY, items, tags });
    await completeTransaction(transaction);
  } finally {
    database.close();
  }
}
