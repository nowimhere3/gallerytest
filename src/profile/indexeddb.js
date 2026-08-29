// This module is deliberately the only boundary between profile data and
// IndexedDB. ProfileStore deals exclusively in plain objects.
//
// Schema (v3 — Multi-Profile Foundation + local Stage 09 decisions):
//
//   "profiles" store (keyPath "id"): one row per profile, id = that
//     profile's stable profileId. Row shape: { id, items, tags }. This is
//     unchanged in shape from v1 — only the *meaning* of `id` changed, from
//     the hardcoded literal "default" to a generated, stable profileId.
//
//   "registry" store (keyPath "id"): a single row, id = REGISTRY_KEY,
//     holding { activeProfileId, profiles: [{ id, name, masterFolder,
//     createdAt, updatedAt }, ...] }. This is profile *metadata* (identity,
//     display name, which folder it's associated with) — never item/tag
//     data, which stays in "profiles". Deliberately a single row for now:
//     this phase establishes the data model, not a multi-profile UI, so
//     there is exactly one profile in practice (migrated or freshly
//     created) even though the shape already supports more.
//
//   "ambient-profile-decisions" store (keyPath "libraryId"): one local-only
//     YES/NO/LATER decision per shared Library. These rows are deliberately
//     outside Profile records and the registry row, so Profile export/import
//     and synchronized replica construction cannot see them.
//
// Migration (v1 -> v2): a v1 database has exactly one possible row in
// "profiles", keyed by the literal "default". That row's DATA (items,
// tags) is preserved byte-for-byte; it is re-keyed under a freshly
// generated profileId so nothing in the app ever again treats the string
// "default" as an identity. A "registry" entry is created pointing at that
// new id, with a deterministic name (DEFAULT_PROFILE_NAME below) since a
// v1 install never had a user-chosen name to preserve. A v1 database that
// was opened but never actually saved a profile (no "default" row) migrates
// to an empty registry — ProfileStore creates a fresh profile for that case
// itself, the same way it would for a brand-new install.

const DATABASE_NAME = "loop-browser-gallery";
const DATABASE_VERSION = 3;
const STORE_NAME = "profiles";
const REGISTRY_STORE_NAME = "registry";
const AMBIENT_DECISION_STORE_NAME = "ambient-profile-decisions";
const REGISTRY_KEY = "registry";
const LEGACY_PROFILE_KEY = "default";

// The name assigned to a profile that didn't previously have one: either
// migrated from the v1 single-profile database, or created fresh because
// no registry existed yet at all. Exported so ProfileStore uses the exact
// same default rather than a second, possibly-diverging literal.
export const DEFAULT_PROFILE_NAME = "My Gallery";

// Stable profile identity. Prefers crypto.randomUUID (available in secure
// contexts, which includes http://localhost); falls back to a
// timestamp+random id in the same style already used for tag ids
// elsewhere in this codebase, for environments without it.
export function generateProfileId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `profile-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

    request.onupgradeneeded = (event) => {
      const database = request.result;
      const transaction = request.transaction;
      const oldVersion = event.oldVersion || 0;

      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: "id" });
      }

      const registryStoreIsNew = !database.objectStoreNames.contains(REGISTRY_STORE_NAME);
      if (registryStoreIsNew) {
        database.createObjectStore(REGISTRY_STORE_NAME, { keyPath: "id" });
      }

      // [SYNCV3 / STAGE-09 / LOCAL-DECISION-STORE]
      // [WHY: YES/NO/LATER answers are a preference of THIS device, not a
      // shared association fact, Profile fact, or physical-folder identity.
      // Keeping them in their own store beside local Profile/device state makes
      // their exclusion from export and replicas structural, while avoiding the
      // FSA registry whose job is physical handles and Folder -> Library links.
      // The upgrade is additive: same-value restamps have no schema meaning and
      // never rewrite either existing store.]
      if (!database.objectStoreNames.contains(AMBIENT_DECISION_STORE_NAME)) {
        database.createObjectStore(AMBIENT_DECISION_STORE_NAME, { keyPath: "libraryId" });
      }

      // Only migrate legacy data the first time the registry store is
      // introduced (oldVersion < 2). Re-running this on a database that
      // already has a registry would risk clobbering real multi-profile
      // data with a re-derived single entry.
      if (registryStoreIsNew && oldVersion < 2) {
        const profilesStore = transaction.objectStore(STORE_NAME);
        const registryStore = transaction.objectStore(REGISTRY_STORE_NAME);
        const legacyRequest = profilesStore.get(LEGACY_PROFILE_KEY);

        legacyRequest.onsuccess = () => {
          const legacy = legacyRequest.result;

          if (!legacy) {
            // v1 database that never actually saved a profile — nothing to
            // carry forward. Leave the registry empty; ProfileStore treats
            // "no registry" the same as a brand-new install.
            return;
          }

          const migratedId = generateProfileId();
          const now = Date.now();

          profilesStore.put({ id: migratedId, items: legacy.items || {}, tags: legacy.tags || [] });
          profilesStore.delete(LEGACY_PROFILE_KEY);

          registryStore.put({
            id: REGISTRY_KEY,
            activeProfileId: migratedId,
            profiles: [
              {
                id: migratedId,
                name: DEFAULT_PROFILE_NAME,
                masterFolder: null,
                createdAt: now,
                updatedAt: now,
              },
            ],
          });
        };
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
 * Loads the saved profile ITEM/TAG data (not identity metadata — see
 * loadRegistry for that) for a specific profileId, as a plain object: item
 * records keyed by relative path, plus the tag vocabulary array. A missing
 * saved profile is represented by empty defaults for both.
 */
export async function loadProfileData(profileId) {
  const database = await openDatabase();

  try {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).get(profileId);
    const result = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Could not read the saved profile."));
    });

    await completeTransaction(transaction);
    return {
      items: result && result.items && typeof result.items === "object" ? result.items : {},
      tags: result && Array.isArray(result.tags) ? result.tags : [],
      // [PHASE-6-SYNC-V2][STAGE-D1-LOCAL-FOUNDATION]
      // [WHY: null means "this profile has never been seeded into the Sync V2
      //  fact model", which is a genuinely different state from "seeded and
      //  currently empty" — the first must trigger a one-time seed from the
      //  existing items/tags, the second must not, or every load would
      //  re-stamp the whole profile at the seed floor and quietly discard the
      //  real stamps its facts already carry.]
      facts: result && result.facts && typeof result.facts === "object" ? result.facts : null,
    };
  } finally {
    database.close();
  }
}

/**
 * Saves a complete snapshot of one profile's item/tag data — item records
 * AND the tag vocabulary — in a single put(). This has to happen together:
 * put() replaces the entire stored record for this profileId, so saving
 * one field without the other would silently erase whichever field wasn't
 * included.
 *
 * [PHASE-6-SYNC-V2]
 * [STAGE-D1-LOCAL-FOUNDATION]
 * [WHY: `facts` rides in this SAME put() precisely because put() is atomic
 *  over the whole row. A synchronized value and the stamp that orders it must
 *  be impossible to separate — a row holding a favorite with a stale stamp, or
 *  a stamp whose value never landed, would let the merge engine reason from
 *  data that never existed. Storing facts in a second row or a second store
 *  would require a dual write, which is a new tearing surface in a phase whose
 *  entire purpose is removing one.]
 *
 * The `facts` argument has three distinct meanings, and they are not
 * interchangeable:
 *
 *   omitted    PRESERVE whatever is already stored. put() replaces the entire
 *              row, so simply leaving the key off would erase the profile's
 *              stamps and force a re-seed at the floor, discarding every real
 *              stamp it had. The existing row is therefore read inside the same
 *              readwrite transaction.
 *   an object  store it.
 *   null       CLEAR the stored facts, forcing a fresh seed on the next load.
 *              Only ProfileStore#replaceAllProfiles does this, and only because
 *              a wholesale V1 collection replacement makes the previous facts
 *              untrue — see the call site.
 *
 * [PHASE-6-SYNC-V2][STAGE-D1-LOCAL-FOUNDATION]
 * [WHY THE READ IS CALLBACK-SHAPED: the put() MUST be issued from inside the
 *  get()'s onsuccess handler, not after `await`ing it. An IndexedDB transaction
 *  goes inactive once control returns to the event loop, and an `await` between
 *  two requests in the same transaction does exactly that — the read succeeds,
 *  the write is rejected as TransactionInactiveError, and the profile silently
 *  does not save. Chaining the request the way the spec intends keeps read and
 *  write in ONE atomic transaction, which is the whole point: nothing may
 *  interleave between reading the stored facts and writing them back.]
 *
 * No DATABASE_VERSION bump is needed for this field: IndexedDB records are
 * schema-less, so an older row simply has no `facts` key — see loadProfileData,
 * which reports that as null.
 */
/**
 * `mergeFacts(mine, stored)` — optional. When supplied alongside `facts`, the
 * stored row is read and merged INSIDE this transaction.
 *
 * [SYNCV3 / STAGE-03C / SAME-DEVICE-TAB-STATE]
 * [WHY: atomicity is the whole point, and it is why this lives here rather than
 *  as a read-then-write in ProfileStore. Same-origin tabs share this row and each
 *  writes it whole, so two contexts saving at the same moment is an ordinary
 *  lost-update race: both read the old row, both write, and whichever lands
 *  second erases the other's facts. Reading and writing in ONE readwrite
 *  transaction closes that — IndexedDB serializes overlapping readwrite
 *  transactions on the same store, so the second one observes the first one's
 *  result rather than the state before it.
 *
 *  The same get-then-put-in-one-transaction shape the `facts === undefined`
 *  branch below already uses; this branch merges instead of preserving.]
 */
export async function saveProfileData(profileId, { items, tags, facts, mergeFacts }) {
  const database = await openDatabase();

  try {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);

    if (typeof mergeFacts === "function" && facts !== undefined && facts !== null) {
      const request = store.get(profileId);
      request.onsuccess = () => {
        const existing = request.result;
        const storedFacts = existing && existing.facts && typeof existing.facts === "object" ? existing.facts : null;
        store.put({ id: profileId, items, tags, facts: storedFacts ? mergeFacts(facts, storedFacts) : facts });
      };
    } else if (facts === undefined) {
      const request = store.get(profileId);
      request.onsuccess = () => {
        const existing = request.result;
        const record = { id: profileId, items, tags };
        if (existing && existing.facts && typeof existing.facts === "object") {
          record.facts = existing.facts;
        }
        store.put(record);
      };
    } else {
      const record = { id: profileId, items, tags };
      if (facts !== null) record.facts = facts;
      store.put(record);
    }

    await completeTransaction(transaction);
  } finally {
    database.close();
  }
}

/**
 * Loads the profile REGISTRY — identity/metadata for every known profile
 * (id, name, masterFolder, timestamps) plus which one is active. This
 * never contains item/tag data. A database with no registry row yet
 * (brand-new install, or a v1 install that never saved anything) returns
 * an empty registry rather than throwing.
 */
export async function loadRegistry() {
  const database = await openDatabase();

  try {
    const transaction = database.transaction(REGISTRY_STORE_NAME, "readonly");
    const request = transaction.objectStore(REGISTRY_STORE_NAME).get(REGISTRY_KEY);
    const result = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Could not read the profile registry."));
    });

    await completeTransaction(transaction);
    return {
      activeProfileId: result && typeof result.activeProfileId === "string" ? result.activeProfileId : null,
      profiles: result && Array.isArray(result.profiles) ? result.profiles : [],
    };
  } finally {
    database.close();
  }
}

/**
 * Deletes a single profile's stored item/tag data. Does not touch the
 * registry — callers (ProfileStore.deleteProfile) are responsible for
 * removing/replacing the corresponding registry entry separately, since
 * "which profile is active" and "this profile's data no longer exists"
 * are two distinct facts that can't both be expressed by one delete().
 */
export async function deleteProfileData(profileId) {
  const database = await openDatabase();

  try {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(profileId);
    await completeTransaction(transaction);
  } finally {
    database.close();
  }
}

/**
 * [PHASE-6-SYNC-V2]
 * [STAGE-D2-TRANSPORT]
 * [WHY: getFullReplica() must publish a deleted Profile's tombstone fact, not
 *  just the profiles the LOCAL registry currently shows — a Profile removed
 *  from the visible registry still has a row here (deletion is now a stamped
 *  fact, never deleteProfileData — see ProfileStore#deleteProfile). This is
 *  the enumeration source that makes that distinction possible: every
 *  profileId this installation has ever persisted a row for, live or
 *  tombstoned, independent of what the UI-facing registry currently lists.]
 */
export async function listAllProfileIds() {
  const database = await openDatabase();

  try {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).getAll();
    const rows = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Could not list saved profiles."));
    });
    await completeTransaction(transaction);
    return rows.filter((row) => row && typeof row.id === "string").map((row) => row.id);
  } finally {
    database.close();
  }
}

/**
 * Saves the complete profile registry. Like saveProfileData, this replaces
 * the whole row, so callers must always pass the full { activeProfileId,
 * profiles } shape, not a partial update.
 */
export async function saveRegistry({ activeProfileId, profiles }) {
  const database = await openDatabase();

  try {
    const transaction = database.transaction(REGISTRY_STORE_NAME, "readwrite");
    transaction.objectStore(REGISTRY_STORE_NAME).put({ id: REGISTRY_KEY, activeProfileId, profiles });
    await completeTransaction(transaction);
  } finally {
    database.close();
  }
}

const AMBIENT_DECISION_KINDS = new Set(["yes", "no", "later"]);

function normalizeAmbientProfileDecision(record, { throwOnInvalid = false } = {}) {
  const invalid = (message) => {
    if (throwOnInvalid) throw new TypeError(message);
    return null;
  };

  if (!record || typeof record !== "object") return invalid("Ambient Profile decision must be an object.");
  if (typeof record.libraryId !== "string" || !record.libraryId) {
    return invalid("Ambient Profile decision requires a non-empty libraryId.");
  }
  if (!AMBIENT_DECISION_KINDS.has(record.kind)) {
    return invalid('Ambient Profile decision kind must be "yes", "no", or "later".');
  }
  // Association -> null never has a Stage 09 decision UI. Reject it here so a
  // future caller cannot accidentally turn "No Profile" into a switch target.
  if (typeof record.observedValue !== "string" || !record.observedValue) {
    return invalid("Ambient Profile decision requires a non-empty observedValue.");
  }
  if (
    !record.stamp ||
    typeof record.stamp !== "object" ||
    !Number.isFinite(record.stamp.t) ||
    typeof record.stamp.d !== "string" ||
    !record.stamp.d
  ) {
    return invalid("Ambient Profile decision requires a valid diagnostic stamp.");
  }
  if (!Number.isFinite(record.decidedAt)) {
    return invalid("Ambient Profile decision requires a finite decidedAt timestamp.");
  }

  // [SYNCV3 / STAGE-09 / LOCAL-DECISION-STORE]
  // [WHY: observedValue is retained only for equality against future shared
  // truth; stamp and decidedAt are diagnostics only. Rebuilding the exact
  // allow-listed row prevents arbitrary caller state from becoming a second
  // authority merely because IndexedDB can clone it.]
  return {
    libraryId: record.libraryId,
    kind: record.kind,
    observedValue: record.observedValue,
    stamp: { t: record.stamp.t, d: record.stamp.d },
    decidedAt: record.decidedAt,
  };
}

export async function loadAmbientProfileDecision(libraryId) {
  if (typeof libraryId !== "string" || !libraryId) return null;
  const database = await openDatabase();

  try {
    const transaction = database.transaction(AMBIENT_DECISION_STORE_NAME, "readonly");
    const request = transaction.objectStore(AMBIENT_DECISION_STORE_NAME).get(libraryId);
    const stored = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Could not read the ambient Profile decision."));
    });
    await completeTransaction(transaction);
    return normalizeAmbientProfileDecision(stored);
  } finally {
    database.close();
  }
}

export async function saveAmbientProfileDecision(record) {
  const normalized = normalizeAmbientProfileDecision(record, { throwOnInvalid: true });
  const database = await openDatabase();

  try {
    const transaction = database.transaction(AMBIENT_DECISION_STORE_NAME, "readwrite");
    transaction.objectStore(AMBIENT_DECISION_STORE_NAME).put(normalized);
    await completeTransaction(transaction);
    return { ...normalized, stamp: { ...normalized.stamp } };
  } finally {
    database.close();
  }
}

export async function deleteAmbientProfileDecision(libraryId) {
  if (typeof libraryId !== "string" || !libraryId) return false;
  const database = await openDatabase();

  try {
    const transaction = database.transaction(AMBIENT_DECISION_STORE_NAME, "readwrite");
    transaction.objectStore(AMBIENT_DECISION_STORE_NAME).delete(libraryId);
    await completeTransaction(transaction);
    return true;
  } finally {
    database.close();
  }
}
