/*
BREADCRUMBS - WAS
A media source could remember a Curation only through local Media Library identity. Remembered Floppy Disk and Floppy Folder sources had stable device-local cassette ids but no safe Curation association owner; cassette rows are frozen and shared Profile associations require a shared libraryId.

BREADCRUMBS - IS
This module owns exactly one device-local fact: which Curation a namespaced remembered media source uses. Floppy associations are keyed as "cassette:cas-..." and remain separate from both cassette handle persistence and shared Media Library / Sync association state.

BREADCRUMBS - WILL BE
Cross-device Floppy Curation association requires a portable shared media identity that does not exist today. Until such an architecture is explicitly designed, ids stored here must never be published to Sync or passed into LibraryRegistry/ProfileStore shared-association APIs.
*/

const DB_NAME = "loop-browser-gallery-source-curation";
const DB_VERSION = 1;
const STORE_NAME = "associations";
const SOURCE_ID_PATTERN = /^cassette:cas-[^\s]+$/;
const SOURCE_KINDS = new Set(["cassette", "cassette-folder"]);

function validateSourceId(sourceId) {
  if (typeof sourceId !== "string" || !SOURCE_ID_PATTERN.test(sourceId)) {
    throw new TypeError('sourceId must use the "cassette:cas-..." namespace.');
  }
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: "sourceId" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function runTransaction(mode, operation) {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, mode);
      let result;
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
      result = operation(transaction.objectStore(STORE_NAME));
    });
  } finally {
    db.close();
  }
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
  });
}

export async function getSourceCuration(sourceId) {
  validateSourceId(sourceId);
  return runTransaction("readonly", (store) => requestResult(store.get(sourceId)));
}

export async function setSourceCuration(sourceId, profileId, { sourceKind } = {}) {
  validateSourceId(sourceId);
  if (profileId === null) return clearSourceCuration(sourceId);
  if (typeof profileId !== "string" || !profileId.trim()) {
    throw new TypeError("profileId must be a non-empty string or null.");
  }
  if (!SOURCE_KINDS.has(sourceKind)) {
    throw new TypeError("sourceKind must be cassette or cassette-folder.");
  }
  const record = { sourceId, profileId, updatedAt: Date.now(), sourceKind };
  await runTransaction("readwrite", (store) => requestResult(store.put(record)));
  return record;
}

export async function clearSourceCuration(sourceId) {
  validateSourceId(sourceId);
  await runTransaction("readwrite", (store) => requestResult(store.delete(sourceId)));
  return null;
}

export async function listSourceCurations() {
  const rows = await runTransaction("readonly", (store) => requestResult(store.getAll()));
  return rows || [];
}
