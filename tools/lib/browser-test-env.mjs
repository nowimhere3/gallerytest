// [PHASE-6-SYNC-V2]
// [STAGE-B-TEST-FIXTURES]
// [WHY: the Stage B invariant is about what happens ACROSS asynchronous
//  boundaries — a mutation landing between the hash and the write, a generation
//  that does not read back as written. Proving that by hand in a browser is not
//  repeatable, and the defect it guards against is invisible until it has
//  already corrupted a generation. These fixtures let the REAL ProfileStore and
//  the REAL ProfileSync run in Node against storage we can pause, observe and
//  corrupt on demand, so the regression can be reproduced deterministically
//  every time the checks run.]
//
// Dependency-free and self-contained, matching tools/check-dom-contract.js.
// These are test doubles, not polyfills: they implement exactly the slice of
// IndexedDB and the File System Access API that src/profile/* actually calls,
// and nothing else.

// ---- In-memory IndexedDB ------------------------------------------------
//
// Faithful in the ways this code depends on: values are structurally cloned on
// the way in and out (so a stored row can never alias a caller's object — the
// real store behaves this way, and a fixture that shared references would hide
// exactly the class of bug under test), request callbacks fire on a later task
// so callers can attach handlers first, and a transaction completes only after
// every request queued against it has fired.

function cloneValue(value) {
  try {
    return typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value));
  } catch {
    // Real IndexedDB can store host objects a structured clone in Node cannot —
    // a FileSystemDirectoryHandle is the case that matters here (see
    // profile-sync-store.js). Pass those through by reference: the app only ever
    // re-uses such a handle, never mutates it, so reference identity is the
    // faithful behavior.
    return value;
  }
}

function makeRequest() {
  return { onsuccess: null, onerror: null, result: undefined, error: null };
}

// [MEDIA-ID / STAGE-01] Array keyPath support.
// [WHY: media-identity.js keys its `paths` store on the COMPOSITE
//  [scopeId, scopeRelativePath], because that composite key is what makes one
//  media identity per path an invariant the database enforces rather than one
//  the code remembers. A fixture that only understood scalar keys could not
//  exercise that guarantee at all. Map cannot compare arrays by value, so a
//  composite key is serialized for storage while the caller keeps passing real
//  arrays, exactly as with the real API.]
function toMapKey(key) {
  return Array.isArray(key) ? `\u0000arr:${JSON.stringify(key)}` : key;
}

function extractKey(store, value) {
  if (Array.isArray(store.keyPath)) return store.keyPath.map((field) => value[field]);
  return value[store.keyPath];
}

function makeConstraintError(store) {
  const error = new Error(`Key already exists in "${store.name}".`);
  error.name = "ConstraintError";
  return error;
}

// [MEDIA-ID / STAGE-02] Index support.
// [WHY: media-identity.js's v2 upgrade adds a `scopeId` index on `paths` and
//  the projection build reads it with index.getAllKeys(), which returns PRIMARY
//  keys - here the composite [scopeId, scopeRelativePath] - without
//  deserializing a record. A fixture with no index at all could not exercise
//  either the upgrade or the read, so the one hot path Stage 02 depends on would
//  be untested. Counters are exposed so a performance test can assert that the
//  hot read path performs no full-store getAll().]
function makeStoreProxy(store, ops, observer, counters) {
  const bump = (name) => {
    if (counters) counters[name] = (counters[name] || 0) + 1;
  };
  return {
    get indexNames() {
      return {
        contains: (name) => store.indexes instanceof Map && store.indexes.has(name),
      };
    },
    createIndex(name, keyPath, { unique = false } = {}) {
      if (!(store.indexes instanceof Map)) store.indexes = new Map();
      store.indexes.set(name, { name, keyPath, unique });
      return { name, keyPath, unique };
    },
    index(name) {
      const definition = store.indexes instanceof Map ? store.indexes.get(name) : null;
      if (!definition) throw new Error(`No index named "${name}".`);
      return {
        getAllKeys(query) {
          const request = makeRequest();
          bump("getAllKeys");
          ops.push(() => {
            const out = [];
            for (const row of store.rows.values()) {
              // [MEDIA-ID / STAGE-02] Compound index keyPaths.
              // [WHY: media-identity.js's v3 index is on [scopeId, origin] — the
              //  projection asks for the OBSERVED population of one scope. A
              //  fixture that only understood scalar keyPaths would silently
              //  match nothing and hand back [], which reads as "this scope has
              //  no observed paths" — a false ABSENT that makes the very test
              //  guarding against it pass for the wrong reason.]
              if (query !== undefined) {
                const value = Array.isArray(definition.keyPath)
                  ? definition.keyPath.map((field) => row[field])
                  : row[definition.keyPath];
                const wanted = Array.isArray(definition.keyPath) ? query : [query];
                const actual = Array.isArray(definition.keyPath) ? value : [value];
                if (actual.length !== wanted.length) continue;
                let matches = true;
                for (let i = 0; i < wanted.length; i++) {
                  if (actual[i] !== wanted[i]) {
                    matches = false;
                    break;
                  }
                }
                if (!matches) continue;
              }
              out.push(extractKey(store, row));
            }
            request.result = out;
            if (request.onsuccess) request.onsuccess({ target: request });
          });
          return request;
        },
      };
    },
    get(key) {
      const request = makeRequest();
      ops.push(() => {
        const row = store.rows.get(toMapKey(key));
        request.result = row === undefined ? undefined : cloneValue(row);
        if (request.onsuccess) request.onsuccess({ target: request });
      });
      return request;
    },
    // [MEDIA-ID / STAGE-01] add() — the concurrency primitive.
    // [WHY: unlike put(), add() FAILS when the key already exists. That failure
    //  is what makes get-or-create atomic across tabs: two writers race, exactly
    //  one add() succeeds, and the loser adopts the winner's row instead of
    //  clobbering it. Faithful in the detail that matters — the error event
    //  carries a preventDefault() the caller must invoke, because in real
    //  IndexedDB an unhandled request error aborts the ENTIRE transaction,
    //  taking every batched sibling write with it.]
    add(value) {
      const request = makeRequest();
      const stored = cloneValue(value);
      ops.push(() => {
        const key = toMapKey(extractKey(store, stored));
        if (store.rows.has(key)) {
          request.error = makeConstraintError(store);
          let defaultPrevented = false;
          const event = {
            target: request,
            preventDefault() {
              defaultPrevented = true;
            },
            stopPropagation() {},
            get defaultPrevented() {
              return defaultPrevented;
            },
          };
          if (request.onerror) request.onerror(event);
          if (!defaultPrevented && store.onUnhandledError) store.onUnhandledError(request.error);
          return;
        }
        store.rows.set(key, stored);
        if (observer) observer({ store: store.name, type: "add", value: cloneValue(stored) });
        request.result = extractKey(store, stored);
        if (request.onsuccess) request.onsuccess({ target: request });
      });
      return request;
    },
    getAll() {
      const request = makeRequest();
      bump("getAll");
      ops.push(() => {
        request.result = [...store.rows.values()].map(cloneValue);
        if (request.onsuccess) request.onsuccess({ target: request });
      });
      return request;
    },
    put(value) {
      const request = makeRequest();
      // Cloned at CALL time, exactly as a real put() snapshots its argument.
      const stored = cloneValue(value);
      ops.push(() => {
        const key = extractKey(store, stored);
        store.rows.set(toMapKey(key), stored);
        if (observer) observer({ store: store.name, type: "put", value: cloneValue(stored) });
        request.result = key;
        if (request.onsuccess) request.onsuccess({ target: request });
      });
      return request;
    },
    delete(key) {
      const request = makeRequest();
      ops.push(() => {
        store.rows.delete(toMapKey(key));
        if (observer) observer({ store: store.name, type: "delete", key });
        if (request.onsuccess) request.onsuccess({ target: request });
      });
      return request;
    },
  };
}

function drain(ops, done) {
  setTimeout(() => {
    // Index loop, not for...of: an op may itself queue further ops (the v1->v2
    // migration in indexeddb.js does exactly this from inside onsuccess).
    for (let i = 0; i < ops.length; i++) ops[i]();
    setTimeout(done, 0);
  }, 0);
}

/**
 * Installs a fresh in-memory `indexedDB` on globalThis.
 *
 * Returns { databases, observe(fn), reset() }. `observe` registers a callback
 * fired on every committed put/delete with a deep copy of the row — which is
 * how the harness inspects what a given save ACTUALLY persisted, as opposed to
 * what the store held by the time the save landed.
 */
export function installFakeIndexedDB() {
  const databases = new Map();
  let observer = null;
  const counters = { open: 0, getAll: 0, getAllKeys: 0 };

  function makeDatabaseHandle(db) {
    return {
      name: db.name,
      get version() {
        return db.version;
      },
      objectStoreNames: {
        contains: (name) => db.stores.has(name),
      },
      createObjectStore(name, { keyPath } = {}) {
        const store = { name, keyPath, rows: new Map(), indexes: new Map() };
        db.stores.set(name, store);
        return makeStoreProxy(store, [], observer, counters);
      },
      transaction(storeNames, mode = "readonly") {
        const names = Array.isArray(storeNames) ? storeNames : [storeNames];
        const ops = [];
        const transaction = {
          mode,
          error: null,
          oncomplete: null,
          onerror: null,
          onabort: null,
          objectStore(name) {
            if (!names.includes(name)) throw new Error(`Store "${name}" is not in this transaction's scope.`);
            const store = db.stores.get(name);
            if (!store) throw new Error(`No object store named "${name}".`);
            return makeStoreProxy(store, ops, observer, counters);
          },
        };
        drain(ops, () => {
          if (transaction.oncomplete) transaction.oncomplete({ target: transaction });
        });
        return transaction;
      },
      close() {},
    };
  }

  globalThis.indexedDB = {
    open(name, version) {
      counters.open += 1;
      const request = { onupgradeneeded: null, onsuccess: null, onerror: null, result: null, transaction: null };

      setTimeout(() => {
        let db = databases.get(name);
        if (!db) {
          db = { name, version: 0, stores: new Map() };
          databases.set(name, db);
        }

        const target = version || db.version || 1;
        const handle = makeDatabaseHandle(db);
        request.result = handle;

        if (target > db.version) {
          const oldVersion = db.version;
          db.version = target;

          const upgradeOps = [];
          request.transaction = {
            objectStore(storeName) {
              const store = db.stores.get(storeName);
              if (!store) throw new Error(`No object store named "${storeName}" during upgrade.`);
              return makeStoreProxy(store, upgradeOps, observer, counters);
            },
          };

          if (request.onupgradeneeded) {
            request.onupgradeneeded({ oldVersion, newVersion: target, target: request });
          }
          drain(upgradeOps, () => {
            if (request.onsuccess) request.onsuccess({ target: request });
          });
          return;
        }

        if (request.onsuccess) request.onsuccess({ target: request });
      }, 0);

      return request;
    },
  };

  return {
    databases,
    counters,
    resetCounters() {
      counters.open = 0;
      counters.getAll = 0;
      counters.getAllKeys = 0;
    },
    observe(fn) {
      observer = fn;
    },
    reset() {
      databases.clear();
      observer = null;
    },
  };
}

// ---- Virtual File System Access directory --------------------------------
//
// Implements the subset profile-sync.js uses: getFileHandle / getDirectoryHandle
// (with `create`), createWritable -> write/close, getFile -> text, entries(),
// removeEntry, queryPermission.
//
// Write semantics mirror the real thing in the one way that matters here:
// createWritable() buffers and close() commits, so a file is never observably
// half-written. That is also the seam the fault-injection hooks use.

function notFound(name) {
  const error = new Error(`Not found: ${name}`);
  error.name = "NotFoundError";
  return error;
}

function makeDirNode(name) {
  return { name, files: new Map(), dirs: new Map() };
}

/**
 * Creates a virtual directory handle.
 *
 * hooks:
 *   - onWrite(path, text)      awaited just BEFORE a file is committed. This is
 *                              the seam that reproduces "a user acted while a
 *                              publish was in flight".
 *   - transformWrite(path, text) -> string   replaces the bytes actually
 *                              committed, without the writer knowing. Used to
 *                              inject a generation whose contents do not match
 *                              the fingerprint its manifest advertises.
 *   - permission               value returned by queryPermission (default
 *                              "granted").
 */
export function createVirtualDirectory(name = "Browser Gallery Profiles", hooks = {}) {
  const root = makeDirNode(name);
  const log = [];

  // [MEDIA-ID / STAGE-01] Ancestry support for the virtual directory.
  // [WHY: wrapDirectory() mints a NEW handle object on every call, so two
  //  handles for the same folder are never reference-equal — exactly like the
  //  real API, where isSameEntry() exists precisely because object identity
  //  proves nothing. Comparison therefore goes through the underlying node.]
  function findDescendantSegments(fromNode, targetNode) {
    if (fromNode === targetNode) return [];
    const queue = [[fromNode, []]];
    while (queue.length) {
      const [node, segments] = queue.shift();
      for (const [childName, childNode] of node.dirs) {
        const childSegments = [...segments, childName];
        if (childNode === targetNode) return childSegments;
        queue.push([childNode, childSegments]);
      }
    }
    return null;
  }

  function wrapDirectory(node, path) {
    const handle = {
      kind: "directory",
      name: node.name,
      // Test-double seam only; the real API exposes nothing like this.
      __node: node,

      async isSameEntry(other) {
        return Boolean(other && other.__node === node);
      },

      // Mirrors the behaviour Stage 00B's real-browser probe confirmed:
      // [] for self, the segment array for a descendant, null for anything
      // else. `hooks.resolveBehavior` lets a test force the outcomes the probe
      // could NOT prove — notably a throw, which must read as "no information"
      // rather than as a negative result.
      async resolve(other) {
        if (hooks.resolveBehavior === "throw") {
          const error = new Error("resolve() denied");
          error.name = "NotAllowedError";
          throw error;
        }
        if (hooks.resolveBehavior === "absent") throw new Error("resolve is not a function");
        if (!other || !other.__node) return null;
        return findDescendantSegments(node, other.__node);
      },

      async queryPermission() {
        return hooks.permission || "granted";
      },
      async requestPermission() {
        return hooks.permission || "granted";
      },

      async getDirectoryHandle(childName, { create = false } = {}) {
        let child = node.dirs.get(childName);
        if (!child) {
          if (!create) throw notFound(childName);
          child = makeDirNode(childName);
          node.dirs.set(childName, child);
        }
        return wrapDirectory(child, `${path}${childName}/`);
      },

      async getFileHandle(childName, { create = false } = {}) {
        // Read-fault seam: lets a test make the folder briefly unreadable
        // (a transient Drive glitch) without touching what was written.
        if (!create && hooks.beforeRead) hooks.beforeRead(`${path}${childName}`);
        if (!node.files.has(childName)) {
          if (!create) throw notFound(childName);
          // A handle opened with create:true does not itself produce content;
          // the file appears when a writable is closed, as in the real API.
        }
        return wrapFile(node, childName, `${path}${childName}`);
      },

      async removeEntry(childName) {
        if (!node.files.delete(childName) && !node.dirs.delete(childName)) throw notFound(childName);
        log.push({ op: "remove", path: `${path}${childName}` });
      },

      async *entries() {
        for (const [childName] of node.files) yield [childName, { kind: "file" }];
        for (const [childName] of node.dirs) yield [childName, { kind: "directory" }];
      },
    };
    return handle;
  }

  function wrapFile(parent, fileName, path) {
    return {
      kind: "file",
      name: fileName,

      async getFile() {
        const content = parent.files.get(fileName);
        if (content === undefined) throw notFound(fileName);
        return { name: fileName, async text() { return content; } };
      },

      async createWritable() {
        let buffer = "";
        return {
          async write(chunk) {
            buffer += chunk;
          },
          async close() {
            if (hooks.onWrite) await hooks.onWrite(path, buffer);
            const finalText = hooks.transformWrite ? hooks.transformWrite(path, buffer) : buffer;
            parent.files.set(fileName, finalText);
            log.push({ op: "write", path, bytes: finalText.length });
          },
        };
      },
    };
  }

  return {
    handle: wrapDirectory(root, ""),
    log,
    /** Every file currently in the virtual folder, as { path: text }. */
    snapshotFiles() {
      const out = {};
      (function walk(node, prefix) {
        for (const [fileName, text] of node.files) out[`${prefix}${fileName}`] = text;
        for (const [dirName, child] of node.dirs) walk(child, `${prefix}${dirName}/`);
      })(root, "");
      return out;
    },
    /**
     * Writes straight into the virtual folder, bypassing the handle API — the
     * fixture's stand-in for "another device wrote here". Creates parent
     * directories as needed.
     */
    writeFile(filePath, text) {
      const parts = filePath.split("/");
      let node = root;
      for (const part of parts.slice(0, -1)) {
        if (!node.dirs.has(part)) node.dirs.set(part, makeDirNode(part));
        node = node.dirs.get(part);
      }
      node.files.set(parts[parts.length - 1], text);
    },
    readFile(filePath) {
      const parts = filePath.split("/");
      let node = root;
      for (const part of parts.slice(0, -1)) {
        node = node.dirs.get(part);
        if (!node) return undefined;
      }
      return node.files.get(parts[parts.length - 1]);
    },
    /**
     * Deletes straight out of the virtual folder, bypassing the handle API - the
     * mirror of writeFile above. Additive: nothing that existed before this
     * behaves differently.
     *
     * [SYNCV3 / STAGE-02 / CONTENT-ADDRESSED-DEVICE-DISCOVERY]
     * [WHY: needed to stage the states this stage has to survive but no correct
     *  writer ever produces - a folder renamed underneath the app, a manifest
     *  committed before its data files landed. Both are things Drive does to a
     *  folder, not things the transport does, so they have to be staged from
     *  outside the transport's own API.]
     */
    removeFile(filePath) {
      const parts = filePath.split("/");
      let node = root;
      for (const part of parts.slice(0, -1)) {
        node = node.dirs.get(part);
        if (!node) return false;
      }
      return node.files.delete(parts[parts.length - 1]);
    },
    /** Removes a whole directory subtree by path. Same purpose as removeFile. */
    removeDirectory(dirPath) {
      const parts = dirPath.split("/");
      let node = root;
      for (const part of parts.slice(0, -1)) {
        node = node.dirs.get(part);
        if (!node) return false;
      }
      return node.dirs.delete(parts[parts.length - 1]);
    },
  };
}

// ---- Web Locks double ------------------------------------------------------
//
// [SYNCV3 / STAGE-03B / SAME-DEVICE-WRITER-COORDINATION]
// [WHY: models the ONE property the writer lease depends on - that a name can be
//  held by at most one holder at a time, per origin, and is released when the
//  holder's callback settles however it settles. Several managers can be created
//  over ONE shared namespace, which is what makes two "tabs" in this harness
//  genuinely contend rather than each quietly winning its own private lock.
//
//  Only `ifAvailable: true` is implemented, deliberately: that is the only mode
//  production uses, and a double that silently supported waiting would let a
//  future change adopt blocking semantics without any test noticing the tabs had
//  started serializing.]

/** A lock namespace shared by every manager created over it - i.e. one origin. */
export function createLockNamespace() {
  return new Map();
}

export function createFakeLockManager(namespace = createLockNamespace()) {
  return {
    namespace,
    /** Names currently held. Diagnostics for tests. */
    heldNames() {
      return [...namespace.keys()].sort();
    },
    async request(name, optionsOrCallback, maybeCallback) {
      const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback;
      const options = typeof optionsOrCallback === "function" ? {} : optionsOrCallback || {};

      if (typeof callback !== "function") throw new TypeError("request() requires a callback");
      if (!options.ifAvailable) {
        throw new Error("[test-env] The fake lock manager only implements { ifAvailable: true }.");
      }

      if (namespace.has(name)) return callback(null);

      const token = { name, mode: "exclusive" };
      namespace.set(name, token);
      try {
        return await callback(token);
      } finally {
        // Released whether the callback returned or threw - the property the
        // production code relies on for "a crashed pass never strands the lock".
        if (namespace.get(name) === token) namespace.delete(name);
      }
    },
  };
}

// ---- Misc -----------------------------------------------------------------

/** Lets queued IndexedDB tasks and promise chains settle. */
export function settle(ticks = 12) {
  return new Promise((resolve) => {
    let remaining = ticks;
    (function step() {
      if (remaining-- <= 0) return resolve();
      setTimeout(step, 0);
    })();
  });
}

/** Silences console noise from expected, already-asserted failure paths. */
export function muteConsole() {
  const saved = { warn: console.warn, error: console.error, log: console.log };
  console.warn = () => {};
  console.error = () => {};
  return () => {
    console.warn = saved.warn;
    console.error = saved.error;
    console.log = saved.log;
  };
}
