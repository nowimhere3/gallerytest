// This module is deliberately the only boundary between profile data and
// IndexedDB. ProfileStore deals exclusively in plain objects.
//
// Schema (v2 — Multi-Profile Foundation, Phase 8.1):
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
const DATABASE_VERSION = 2;
const STORE_NAME = "profiles";
const REGISTRY_STORE_NAME = "registry";
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
 */
export async function saveProfileData(profileId, { items, tags }) {
  const database = await openDatabase();

  try {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put({ id: profileId, items, tags });
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
