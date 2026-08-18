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

function makeStoreProxy(store, ops, observer) {
  return {
    get(key) {
      const request = makeRequest();
      ops.push(() => {
        const row = store.rows.get(key);
        request.result = row === undefined ? undefined : cloneValue(row);
        if (request.onsuccess) request.onsuccess({ target: request });
      });
      return request;
    },
    getAll() {
      const request = makeRequest();
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
        store.rows.set(stored[store.keyPath], stored);
        if (observer) observer({ store: store.name, type: "put", value: cloneValue(stored) });
        request.result = stored[store.keyPath];
        if (request.onsuccess) request.onsuccess({ target: request });
      });
      return request;
    },
    delete(key) {
      const request = makeRequest();
      ops.push(() => {
        store.rows.delete(key);
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
        const store = { name, keyPath, rows: new Map() };
        db.stores.set(name, store);
        return makeStoreProxy(store, [], observer);
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
            return makeStoreProxy(store, ops, observer);
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
              return makeStoreProxy(store, upgradeOps, observer);
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

  function wrapDirectory(node, path) {
    const handle = {
      kind: "directory",
      name: node.name,

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
