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

// [PHASE-6-SYNC-V2]
// [STAGE-D3-LIBRARY-IDENTITY]
// [WHY: physical folders are local; only stable logical identity and
//  association may synchronize. An association fact's durable home cannot be
//  "on the library-registry row it happens to match locally" alone — a device
//  that has MERGED IN an association fact for a libraryId it has no local
//  physical folder for (a library another device owns) still has to keep and
//  republish that fact, or it silently drops out of the gossip on this
//  device's next publish. This tiny cache is the single durable home for the
//  full associations[libraryId] map regardless of local library ownership;
//  library-registry.js rows still carry their OWN copy of `profileId` purely
//  for existing UI code to keep reading unchanged — this cache is what is
//  actually merged/published.]
const ASSOCIATIONS_RECORD_ID = "associations";

// [PHASE-6-SYNC-V2]
// [STAGE-E-LIVE-INTEGRATION]
// [WHY: "which transport is this installation actually using" must be a single
//  explicit, persisted value with no third "maybe" reading. The approved
//  cutover is HARD: a V2-active installation must never write V1 again, and a
//  not-yet-activated one must never write V2 — inferring that from whether a
//  sync-v2/ directory happens to exist would make an interrupted or partially
//  failed activation indistinguishable from a completed one, which is exactly
//  the ambiguity that turns a recoverable state into a data-loss decision. A
//  missing record reads as "v1", the only safe default: it is what every
//  installation predating this stage genuinely is.]
const ACTIVATION_RECORD_ID = "activation";

/** The only three activation states this record may hold. "v1" also covers "never activated". */
export const ACTIVATION_V1 = "v1";
export const ACTIVATION_V2 = "v2";
export const ACTIVATION_FAILED = "failed";

// [SYNCV3 / STAGE-01 / V3-ROOT-ISOLATION]
// [WHY: SyncV3 gets its OWN rows, and nothing in any V3 code path may write to
//  the four rows above. The reason is not tidiness — it is that the V2 rows are
//  the only description of a known-good, shipped configuration, and this branch
//  is an experiment. If V3 wrote its mode into ACTIVATION_RECORD_ID, that single
//  write would replace `activatedAt` and the `migration` provenance of the V2
//  cutover, and there would be no way back to the state the installation was in
//  before V3 was tried. Separate rows make "leave V3" a DELETE of V3's own row
//  rather than a reconstruction of V2's.
//
//  The cost of separate rows is that "which transport runs" now has two possible
//  homes, which is exactly the ambiguity ACTIVATION_RECORD_ID's own comment above
//  warns about. That is resolved by a single, explicit precedence rule stated in
//  ONE place — ProfileSync#loadActivation: the V3 row wins if and only if it says
//  "v3"; otherwise the V2 row decides, exactly as it always has. It is a
//  precedence rule over two explicit persisted values, never an inference from
//  whether a folder or directory happens to exist.]
const V3_CONNECTION_RECORD_ID = "sync-v3";
const V3_ACTIVATION_RECORD_ID = "activation-v3";

// [SYNCV3 / STAGE-01 / V3-ROOT-ISOLATION]
// [WHY: RESERVED, and deliberately created now rather than when it is first
//  needed. No V3 transport pass exists yet, so nothing reads or writes this row
//  in this stage. It exists so the stage that DOES introduce V3's shared-library
//  facts has an isolated home already sitting there — the alternative is a future
//  stage reaching for ASSOCIATIONS_RECORD_ID because it is the one that already
//  works, which would silently merge V3's association facts into the V2 cache
//  that a dormant-but-intact V2 installation still depends on.]
//
// [SYNCV3 / STAGE-03A / V3-ASSOCIATION-ISOLATION-AND-PASS-SKELETON]
// [WHY: no longer reserved — this row is now live, reached only through
//  V3_ASSOCIATION_STORE. The Stage 01 comment above is kept because it records
//  why the row was created before anything needed it, which is the decision that
//  made this stage a swap rather than a migration.]
const V3_ASSOCIATIONS_RECORD_ID = "associations-v3";

// [SYNCV3 / STAGE-04B / SHARED-LIBRARY-RECORD]
// [WHY: ONE row, and deliberately no V2/V3 adapter pair. The association cache
//  needed V2_ASSOCIATION_STORE/V3_ASSOCIATION_STORE and a boot-time gate
//  precisely BECAUSE a V2 predecessor row already existed and had to stay
//  untouched while V3 got its own - the hazard being a write landing in the
//  wrong one of two rows depending on when the mode resolved. The shared
//  Library catalog is new in V3 and has no V2 counterpart, so there is no wrong
//  row to land in and none of that machinery applies. Copying it here would be
//  cargo-culting a fix for a problem this row cannot have.]
const V3_LIBRARIES_RECORD_ID = "libraries-v3";

/** The transport mode SyncV3 activation records. Lives only in V3's own row. */
export const ACTIVATION_V3 = "v3";

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
      // [SYNCV3 / STAGE-05 / DEVICE-NAMING]
      // [WHY: the OPTIONAL custom name rides on the row that already owns device
      //  identity, rather than getting a row of its own. A second row would be a
      //  second thing to keep in step with deviceId's lifetime - it survives
      //  "Disconnect Sync", it must never be re-minted - and a name that outlived
      //  its deviceId, or vanished while the id survived, would be a bug nobody
      //  would think to look for. Null means "never named"; that is a distinct
      //  state from "named empty", which is why it is not defaulted here.]
      deviceName: typeof record.deviceName === "string" && record.deviceName ? record.deviceName : null,
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

// ---- Library associations (Phase 6 Sync V2, Stage D3) ---------------------

/** The full `{ libraryId: Fact<profileId|null> }` map, or `{}` if never saved. */
export async function loadAssociationsCache() {
  const database = await openDatabase();

  try {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const record = await requestToPromise(transaction.objectStore(STORE_NAME).get(ASSOCIATIONS_RECORD_ID));
    await completeTransaction(transaction);
    return record && record.associations && typeof record.associations === "object" ? record.associations : {};
  } finally {
    database.close();
  }
}

// ---- Activation state (Phase 6 Sync V2, Stage E) --------------------------

/**
 * This installation's transport activation state. Never null: an installation
 * with no record has genuinely never been activated, which IS "v1".
 * Shape: { mode, activatedAt, migration: { attempted, v1ProfilesSeeded, reason } }.
 */
export async function loadActivationState() {
  const database = await openDatabase();

  try {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const record = await requestToPromise(transaction.objectStore(STORE_NAME).get(ACTIVATION_RECORD_ID));
    await completeTransaction(transaction);

    const mode =
      record && (record.mode === ACTIVATION_V2 || record.mode === ACTIVATION_FAILED) ? record.mode : ACTIVATION_V1;
    return {
      mode,
      activatedAt: (record && record.activatedAt) || null,
      migration: (record && record.migration) || null,
    };
  } finally {
    database.close();
  }
}

export async function saveActivationState({ mode, activatedAt = null, migration = null }) {
  const database = await openDatabase();

  try {
    const record = { id: ACTIVATION_RECORD_ID, mode, activatedAt, migration };
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(record);
    await completeTransaction(transaction);
    return record;
  } finally {
    database.close();
  }
}

/** Replaces the whole associations map — callers always pass the full, already-merged map. */
export async function saveAssociationsCache(associations) {
  const database = await openDatabase();

  try {
    const record = { id: ASSOCIATIONS_RECORD_ID, associations: associations || {} };
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(record);
    await completeTransaction(transaction);
    return record;
  } finally {
    database.close();
  }
}

/**
 * Sets (or, with null, clears) this installation's custom Device Name.
 *
 * [SYNCV3 / STAGE-05 / DEVICE-NAMING]
 * [WHY: a read-modify-write, never a whole-row put. saveDeviceRecord() replaces
 *  the row outright and re-stamps createdAt - correct for minting a brand-new
 *  identity, catastrophic here: renaming a device would reset its clock floor to
 *  0, and freshly issued stamps could then land BELOW facts this device had
 *  already published, silently losing the user's next click. Same reasoning
 *  persistLastIssuedT already applies below.
 *
 *  No-op if the device record does not exist yet: a name for an installation
 *  with no identity has nothing to belong to.]
 */
export async function persistDeviceName(deviceName) {
  const database = await openDatabase();

  try {
    const readTx = database.transaction(STORE_NAME, "readonly");
    const record = await requestToPromise(readTx.objectStore(STORE_NAME).get(DEVICE_RECORD_ID));
    await completeTransaction(readTx);
    if (!record) return null;

    const next = typeof deviceName === "string" && deviceName ? deviceName : null;
    const updated = { ...record, deviceName: next };
    const writeTx = database.transaction(STORE_NAME, "readwrite");
    writeTx.objectStore(STORE_NAME).put(updated);
    await completeTransaction(writeTx);
    return updated;
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

// ---- SyncV3 isolated records (SyncV3, Stage 01) ---------------------------
//
// [SYNCV3 / STAGE-01 / V3-ROOT-ISOLATION]
// [WHY: every function below addresses a V3_* record id and NOTHING else. That
//  is the whole isolation guarantee, and it is enforced structurally rather than
//  by review: there is no function in this section that takes a record id as an
//  argument, so no V3 call site can be made to write a V2 row by passing the
//  wrong string. The V2 functions above are the mirror image — none of them can
//  reach a V3 row either.
//
//  The DEVICE record is the deliberate exception and is NOT duplicated here. A
//  V3 device identity would make the same installation two peers, and — far
//  worse — would reset the logical-clock floor that sync-device.js exists to
//  protect. Same machine, same installation, same deviceId, in every mode.]

/**
 * The saved V3 sync-folder relationship, or null if V3 has never been connected.
 * `handle` is the raw FileSystemDirectoryHandle — callers MUST check/request
 * permission before using it, exactly as loadSyncConfig()'s callers must.
 */
export async function loadV3SyncConfig() {
  const database = await openDatabase();

  try {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const record = await requestToPromise(transaction.objectStore(STORE_NAME).get(V3_CONNECTION_RECORD_ID));
    await completeTransaction(transaction);

    if (!record || !record.handle) return null;

    return {
      handle: record.handle,
      folderName: record.folderName || record.handle.name || null,
      connectedAt: record.connectedAt || null,
    };
  } finally {
    database.close();
  }
}

/**
 * Records a brand-new (or replacement) V3 sync-folder relationship.
 *
 * [SYNCV3 / STAGE-01 / V3-ROOT-ISOLATION]
 * [WHY: no autoSync/baseline/lastSyncAt fields, unlike saveSyncConnection. V3
 *  has no transport yet, so persisting a "last sync" or a baseline would be
 *  recording something that has never happened — the exact false reassurance
 *  Stage B removed from V1. Those fields get added by the stage that earns them.]
 */
export async function saveV3SyncConnection(handle) {
  const database = await openDatabase();

  try {
    const record = {
      id: V3_CONNECTION_RECORD_ID,
      handle,
      folderName: handle.name,
      connectedAt: Date.now(),
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
 * Forgets the V3 folder relationship only ("Disconnect V3").
 *
 * [SYNCV3 / STAGE-01 / V3-ROOT-ISOLATION]
 * [WHY: deletes exactly one row. Not the V3 activation row — an installation
 *  can legitimately be in V3 mode with no folder chosen yet, which is a state
 *  the engine reports truthfully rather than a broken one. Not the device row,
 *  for the same reason clearSyncConfig() does not touch it. And not, under any
 *  circumstance, the V2 connection row.]
 */
export async function clearV3SyncConfig() {
  const database = await openDatabase();

  try {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(V3_CONNECTION_RECORD_ID);
    await completeTransaction(transaction);
  } finally {
    database.close();
  }
}

/**
 * SyncV3's own activation record. Never null: an installation with no record
 * has genuinely never activated V3, which reads as mode `null` — deliberately
 * NOT "v1", because this row has no opinion about what runs when V3 is off.
 * That answer belongs to loadActivationState() alone.
 *
 * Shape: { mode: "v3" | null, activatedAt }.
 */
export async function loadV3ActivationState() {
  const database = await openDatabase();

  try {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const record = await requestToPromise(transaction.objectStore(STORE_NAME).get(V3_ACTIVATION_RECORD_ID));
    await completeTransaction(transaction);

    return {
      mode: record && record.mode === ACTIVATION_V3 ? ACTIVATION_V3 : null,
      activatedAt: (record && record.activatedAt) || null,
    };
  } finally {
    database.close();
  }
}

export async function saveV3ActivationState({ activatedAt = null } = {}) {
  const database = await openDatabase();

  try {
    const record = { id: V3_ACTIVATION_RECORD_ID, mode: ACTIVATION_V3, activatedAt };
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(record);
    await completeTransaction(transaction);
    return record;
  } finally {
    database.close();
  }
}

/**
 * Leaves V3 mode by deleting V3's activation row.
 *
 * [SYNCV3 / STAGE-01 / V3-ROOT-ISOLATION]
 * [WHY: leaving V3 is a DELETE, never a write of "v1"/"v2" anywhere. Because
 *  the V2 row was never modified on the way in, removing this row restores the
 *  installation's previous transport exactly — including a `failed` V2 migration
 *  that must stay failed. Writing a mode here on the way out would be this
 *  branch guessing at a state V2's own row already records correctly.]
 */
export async function clearV3ActivationState() {
  const database = await openDatabase();

  try {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(V3_ACTIVATION_RECORD_ID);
    await completeTransaction(transaction);
  } finally {
    database.close();
  }
}

/**
 * The full `{ libraryId: Fact<profileId|null> }` map for V3, or `{}` if never saved.
 *
 * [SYNCV3 / STAGE-03A / V3-ASSOCIATION-ISOLATION-AND-PASS-SKELETON]
 * [WHY: no longer reserved — this is now the authoritative association cache for
 *  a V3-mode installation, reached through V3_ASSOCIATION_STORE below. The row
 *  was created empty in Stage 01 precisely so this stage had an isolated home to
 *  move into rather than a reason to reach for the V2 cache.]
 */
export async function loadV3AssociationsCache() {
  const database = await openDatabase();

  try {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const record = await requestToPromise(transaction.objectStore(STORE_NAME).get(V3_ASSOCIATIONS_RECORD_ID));
    await completeTransaction(transaction);
    return record && record.associations && typeof record.associations === "object" ? record.associations : {};
  } finally {
    database.close();
  }
}

/** Replaces the whole V3 associations map — callers always pass the full, already-merged map. */
export async function saveV3AssociationsCache(associations) {
  const database = await openDatabase();

  try {
    const record = { id: V3_ASSOCIATIONS_RECORD_ID, associations: associations || {} };
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(record);
    await completeTransaction(transaction);
    return record;
  } finally {
    database.close();
  }
}

/**
 * The full `{ libraryId: LibraryFacts }` catalog, or `{}` if never saved.
 *
 * [SYNCV3 / STAGE-04B / SHARED-LIBRARY-RECORD]
 * [WHY: absent reads as an empty catalog, never as an error. Every V1/V2
 *  installation, and every V3 installation predating this stage, legitimately
 *  has no such row - and "no Libraries published yet" is an ordinary state, not
 *  a fault.]
 */
export async function loadV3LibrariesCache() {
  const database = await openDatabase();

  try {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const record = await requestToPromise(transaction.objectStore(STORE_NAME).get(V3_LIBRARIES_RECORD_ID));
    await completeTransaction(transaction);
    return record && record.libraries && typeof record.libraries === "object" ? record.libraries : {};
  } finally {
    database.close();
  }
}

/** Replaces the whole Library catalog — callers always pass the full, already-merged map. */
export async function saveV3LibrariesCache(libraries) {
  const database = await openDatabase();

  try {
    const record = { id: V3_LIBRARIES_RECORD_ID, libraries: libraries || {} };
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(record);
    await completeTransaction(transaction);
    return record;
  } finally {
    database.close();
  }
}

// ---- Association-cache adapters (SyncV3, Stage 03A) -----------------------
//
// [SYNCV3 / STAGE-03A / V3-ASSOCIATION-ISOLATION-AND-PASS-SKELETON]
// [WHY: ProfileStore must not learn which sync mode is running. Handing it one
//  of these two objects keeps every "which row?" decision in the module that
//  owns the row ids, and leaves ProfileStore with a single association code path
//  rather than an `if (mode === "v3")` at each of its three storage call sites —
//  the shape that would guarantee one of them eventually gets missed.
//
//  Two adapters, not a mode flag, because the failure this prevents is a WRITE
//  to the wrong row: an adapter can only reach the row its own functions name,
//  so a V3-mode store is structurally incapable of saving over the dormant V2
//  cache, whatever a caller believes the mode to be.]

/** The V1/V2 association cache. The default; unchanged behaviour. */
export const V2_ASSOCIATION_STORE = Object.freeze({
  id: ASSOCIATIONS_RECORD_ID,
  load: loadAssociationsCache,
  save: saveAssociationsCache,
});

/** The SyncV3 association cache. Isolated from V2's in every direction. */
export const V3_ASSOCIATION_STORE = Object.freeze({
  id: V3_ASSOCIATIONS_RECORD_ID,
  load: loadV3AssociationsCache,
  save: saveV3AssociationsCache,
});

/**
 * Forgets the sync-folder relationship entirely ("Disconnect Sync"). Does
 * not touch ProfileStore's own database — Profiles remain exactly as they
 * were, saved locally; only the remembered folder relationship is erased.
 *
 * [PHASE-6-SYNC-V2][STAGE-D1-LOCAL-FOUNDATION]
 * [WHY: this deletes ONLY the connection row. The device row survives, because
 *  disconnecting a folder does not make this a different installation, and
 *  losing the clock floor here would be silent and unrecoverable.]
 *
 * [SYNCV3 / STAGE-01 / V3-ROOT-ISOLATION]
 * [WHY: unchanged, and that IS the V3 requirement — "V2 disconnect must not
 *  delete V3 configuration" needs no code here precisely because this function
 *  names one record id and has never been able to address another.]
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
