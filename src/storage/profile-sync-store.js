// [PROFILE-SYNC]
// WHAT: Persists the independently-selected Profile Sync directory handle
// (a FileSystemDirectoryHandle) plus small sync-relationship metadata —
// whether Auto Sync is on, and the last-successful-sync baseline
// fingerprint (see [PROFILE-SYNC-BASELINE] in profile-sync.js) — in its own
// tiny IndexedDB database.
// WHY: Profile Sync must remain a separate, independently remembered
// resource from whichever media library (FSA or legacy) happens to be
// loaded — see the header of profile-sync.js for the full architectural
// boundary this protects, and library-registry.js's own header for why
// THAT module already keeps itself separate from ProfileStore's database.
// A FileSystemDirectoryHandle is structured-clonable, so IndexedDB can hold
// it directly — the same technique library-registry.js already uses for
// media-library handles.
// FUTURE / DO-NOT-BREAK: This handle is INSTALLATION-LOCAL — it does not
// travel through the sync folder to another browser/device (see
// profile-sync.js). Never assume a loaded handle is still usable without
// queryPermission/requestPermission first; stored permission does not
// reliably survive a browser restart. Do not fold this into
// library-registry.js's database: a Profile Sync folder is conceptually
// never a "library" (it is never a media source), and mixing the two
// stores would blur that boundary for anyone reading either file later.

const DATABASE_NAME = "loop-browser-gallery-profile-sync";
const DATABASE_VERSION = 1;
const STORE_NAME = "sync";
const RECORD_ID = "sync";

// [PHASE-6-SYNC-V2]
// [STAGE-D1-LOCAL-FOUNDATION]
// [WHY: device identity must outlive the sync CONNECTION. It is kept as a
//  separate row rather than fields on the connection record because
//  clearSyncConfig() ("Disconnect Sync") deletes that record outright — and a
//  deviceId that vanished on disconnect would make this installation a brand
//  new peer every time, orphaning its published subtree and, far worse,
//  resetting the logical-clock floor so freshly issued stamps could land BELOW
//  facts this device had already published. Same database, different key: no
//  DATABASE_VERSION bump, because IndexedDB rows are schema-less per record.]
const DEVICE_RECORD_ID = "device";

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
    request.onerror = () => reject(request.error || new Error("Could not open the profile sync database."));
  });
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Profile sync database request failed."));
  });
}

function completeTransaction(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error("Profile sync database operation failed."));
    transaction.onabort = () => reject(transaction.error || new Error("Profile sync database operation was aborted."));
  });
}

/**
 * Returns the saved sync-folder relationship, or null if Profile Sync has
 * never been configured on this installation. `handle` is the raw
 * FileSystemDirectoryHandle — callers MUST check/request permission before
 * using it (see profile-sync.js).
 */
export async function loadSyncConfig() {
  const database = await openDatabase();

  try {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const record = await requestToPromise(transaction.objectStore(STORE_NAME).get(RECORD_ID));
    await completeTransaction(transaction);

    if (!record || !record.handle) return null;

    return {
      handle: record.handle,
      folderName: record.folderName || record.handle.name || null,
      autoSync: record.autoSync !== false,
      connectedAt: record.connectedAt || null,
      lastSyncAt: record.lastSyncAt || null,
      baselineFingerprint: typeof record.baselineFingerprint === "string" ? record.baselineFingerprint : null,
    };
  } finally {
    database.close();
  }
}

/**
 * Records a brand-new (or replacement) sync-folder relationship. Always
 * resets baselineFingerprint/lastSyncAt to null — a different folder is a
 * genuinely new sync relationship, not a continuation of the old one, so
 * carrying forward a stale baseline could hide a real divergence.
 */
export async function saveSyncConnection(handle, { autoSync = true } = {}) {
  const database = await openDatabase();

  try {
    const record = {
      id: RECORD_ID,
      handle,
      folderName: handle.name,
      autoSync,
      connectedAt: Date.now(),
      lastSyncAt: null,
      baselineFingerprint: null,
    };

    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(record);
    await completeTransaction(transaction);

    return record;
  } finally {
    database.close();
  }
}

/**
 * Read-modify-write partial update (autoSync / baselineFingerprint /
 * lastSyncAt) — never touches `handle`. No-op if Profile Sync isn't
 * currently configured at all.
 */
export async function updateSyncMeta(partial) {
  const database = await openDatabase();

  try {
    const readTx = database.transaction(STORE_NAME, "readonly");
    const record = await requestToPromise(readTx.objectStore(STORE_NAME).get(RECORD_ID));
    await completeTransaction(readTx);
    if (!record) return null;

    const updated = { ...record, ...partial };
    const writeTx = database.transaction(STORE_NAME, "readwrite");
    writeTx.objectStore(STORE_NAME).put(updated);
    await completeTransaction(writeTx);

    return updated;
  } finally {
    database.close();
  }
}

// ---- Device identity (Phase 6 Sync V2, Stage D1) -------------------------

/**
 * Returns this installation's device record, or null if it has never been
 * created. Shape: { deviceId, lastIssuedT }.
 *
 * `lastIssuedT` is the highest logical time this installation's clock has ever
 * issued or observed. It is persisted so a reload cannot reset the floor — see
 * sync-device.js for why that would silently lose the user's next click.
 */
export async function loadDeviceRecord() {
  const database = await openDatabase();

  try {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const record = await requestToPromise(transaction.objectStore(STORE_NAME).get(DEVICE_RECORD_ID));
    await completeTransaction(transaction);

    if (!record || typeof record.deviceId !== "string" || !record.deviceId) return null;

    return {
      deviceId: record.deviceId,
      lastIssuedT: Number.isFinite(record.lastIssuedT) ? record.lastIssuedT : 0,
      createdAt: record.createdAt || null,
    };
  } finally {
    database.close();
  }
}

/** Creates the device record. Only ever called when none exists. */
export async function saveDeviceRecord({ deviceId, lastIssuedT = 0 }) {
  const database = await openDatabase();

  try {
    const record = { id: DEVICE_RECORD_ID, deviceId, lastIssuedT, createdAt: Date.now() };
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(record);
    await completeTransaction(transaction);
    return record;
  } finally {
    database.close();
  }
}

/**
 * Raises the persisted clock floor. Deliberately monotonic: a lower value is
 * ignored rather than written, so an out-of-order or stale write can never
 * lower the floor and let a later stamp be re-issued.
 */
export async function persistLastIssuedT(lastIssuedT) {
  if (!Number.isFinite(lastIssuedT)) return null;
  const database = await openDatabase();

  try {
    const readTx = database.transaction(STORE_NAME, "readonly");
    const record = await requestToPromise(readTx.objectStore(STORE_NAME).get(DEVICE_RECORD_ID));
    await completeTransaction(readTx);
    if (!record) return null;
    if (Number.isFinite(record.lastIssuedT) && record.lastIssuedT >= lastIssuedT) return record;

    const updated = { ...record, lastIssuedT };
    const writeTx = database.transaction(STORE_NAME, "readwrite");
    writeTx.objectStore(STORE_NAME).put(updated);
    await completeTransaction(writeTx);
    return updated;
  } finally {
    database.close();
  }
}

/**
 * Forgets the sync-folder relationship entirely ("Disconnect Sync"). Does
 * not touch ProfileStore's own database — Profiles remain exactly as they
 * were, saved locally; only the remembered folder relationship is erased.
 *
 * [PHASE-6-SYNC-V2][STAGE-D1-LOCAL-FOUNDATION]
 * [WHY: this deletes ONLY the connection row. The device row survives, because
 *  disconnecting a folder does not make this a different installation, and
 *  losing the clock floor here would be silent and unrecoverable.]
 */
export async function clearSyncConfig() {
  const database = await openDatabase();

  try {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(RECORD_ID);
    await completeTransaction(transaction);
  } finally {
    database.close();
  }
}
