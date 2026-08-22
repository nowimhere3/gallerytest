// [MEDIA-ID / STAGE-01 / IDENTITY-STORE]
//
// Durable local storage for MEDIA-ID's alias/evidence index.
//
// ---- Why its own database ------------------------------------------------
//
// [WHY: sibling to library-registry.js, deliberately NOT folded into the
//  profile database. That module's own header states the precedent — "a library
//  record is a different kind of data than profile items/tags, and mixing them
//  would make every future profile-schema migration also have to reason about
//  this." A media-identity index is the same kind of thing again: it is
//  evidence ABOUT a collection, it is rebuilt from observation rather than
//  authored by the user, and it must never make a Profile migration harder.
//  Separate database, separate version line, nothing shared.]
//
// ---- Nothing here is ever synchronized -----------------------------------
//
// No value in this store reaches sync-facts.js, the V3 transport, or any
// replica. `observedSignature` is deliberately shaped so it COULD be published
// verbatim if a future audited stage decided to — that keeps the decision a
// transport question rather than a schema redesign — but Stage 01 publishes
// nothing.
//
// ---- The concurrency contract -------------------------------------------
//
// [WHY: two or three same-origin tabs seeding the same folder concurrently must
//  end with ONE media identity per path, never two. The authority for that is
//  IndexedDB itself, not a lock: the `paths` store's key is the composite
//  [scopeId, scopeRelativePath], so the key alone enforces uniqueness, and
//  get-or-create uses add() — never put() — so exactly one racing writer wins
//  and the loser gets a ConstraintError it can adopt from. put() would silently
//  clobber the winner and hand out two ids for one path, which is precisely the
//  defect this shape exists to make impossible.
//
//  Evidence fields (lastSeenAt, signature history, factSeenIn) are last-writer-
//  wins and benign to race on — losing a millisecond or re-recording an
//  identical signature costs nothing. The invariant that must hold absolutely
//  is one mediaId per (scopeId, scopeRelativePath), and that is the one the
//  composite key protects.]

const DATABASE_NAME = "browser-gallery-media-identity";
const DATABASE_VERSION = 1;

const SCOPES = "scopes";
const ROOTS = "roots";
const PATHS = "paths";
const CURSORS = "cursors";

// How many paths share one IndexedDB transaction. One transaction PER ITEM at
// 20k items would be ruinous; one transaction for ALL of them would hold a
// write lock across the whole pass. See the performance contract in
// media-seeding.js.
export const SEED_BATCH_SIZE = 500;

export function generateMediaId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return `media-${crypto.randomUUID()}`;
  return `media-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function generateScopeId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return `scope-${crypto.randomUUID()}`;
  return `scope-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(SCOPES)) {
        database.createObjectStore(SCOPES, { keyPath: "scopeId" });
      }
      if (!database.objectStoreNames.contains(ROOTS)) {
        database.createObjectStore(ROOTS, { keyPath: "rootId" });
      }
      if (!database.objectStoreNames.contains(PATHS)) {
        // The composite key IS the uniqueness guarantee. See the header.
        database.createObjectStore(PATHS, { keyPath: ["scopeId", "scopeRelativePath"] });
      }
      if (!database.objectStoreNames.contains(CURSORS)) {
        database.createObjectStore(CURSORS, { keyPath: "cursorKey" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Media identity database failed to open."));
  });
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Media identity request failed."));
  });
}

// [WHY: a rejected add() must NOT abort the surrounding transaction. In real
//  IndexedDB an unhandled request error propagates and aborts the whole
//  transaction, which would throw away the several hundred sibling writes
//  batched alongside it. preventDefault() on the error event is what stops
//  that, and it is why every batched add() goes through this helper rather than
//  requestToPromise above. A conflict is an ordinary, expected outcome here —
//  it means another tab won the race — not a failure.]
function addToPromise(request) {
  return new Promise((resolve) => {
    request.onsuccess = () => resolve({ conflict: false });
    request.onerror = (event) => {
      if (event && typeof event.preventDefault === "function") event.preventDefault();
      if (event && typeof event.stopPropagation === "function") event.stopPropagation();
      resolve({ conflict: true, error: request.error || null });
    };
  });
}

function completeTransaction(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("Media identity transaction failed."));
    transaction.onabort = () => reject(transaction.error || new Error("Media identity transaction aborted."));
  });
}

async function withDatabase(run) {
  const database = await openDatabase();
  try {
    return await run(database);
  } finally {
    database.close();
  }
}

// ---- Scopes --------------------------------------------------------------

export async function getScope(scopeId) {
  if (!scopeId) return null;
  return withDatabase(async (database) => {
    const tx = database.transaction(SCOPES, "readonly");
    const record = await requestToPromise(tx.objectStore(SCOPES).get(scopeId));
    await completeTransaction(tx);
    return record || null;
  });
}

export async function listScopes() {
  return withDatabase(async (database) => {
    const tx = database.transaction(SCOPES, "readonly");
    const records = await requestToPromise(tx.objectStore(SCOPES).getAll());
    await completeTransaction(tx);
    return records || [];
  });
}

/**
 * Mints a scope whose root is `scopeRootId`. The scopeId is a fresh opaque id,
 * so this never collides — a racing tab creates a DIFFERENT scope, and the
 * roots store (whose key is the rootId) is what resolves that race, not this.
 */
export async function createScope(scopeRootId, { at = Date.now() } = {}) {
  const scope = {
    scopeId: generateScopeId(),
    scopeRootId,
    scopeVersion: 1,
    createdAt: at,
    // Local-only diagnostics. This is how ordinary use answers Stage 00B's
    // still-open "does resolve() work at permission state prompt?" question
    // without that answer ever being load-bearing. Never synced.
    ancestryAttempts: [],
  };

  await withDatabase(async (database) => {
    const tx = database.transaction(SCOPES, "readwrite");
    tx.objectStore(SCOPES).put(scope);
    await completeTransaction(tx);
  });

  return scope;
}

const MAX_ANCESTRY_DIAGNOSTICS = 50;

export async function recordAncestryAttempt(scopeId, attempt) {
  if (!scopeId) return null;
  return withDatabase(async (database) => {
    const readTx = database.transaction(SCOPES, "readonly");
    const scope = await requestToPromise(readTx.objectStore(SCOPES).get(scopeId));
    await completeTransaction(readTx);
    if (!scope) return null;

    const attempts = [...(scope.ancestryAttempts || []), attempt].slice(-MAX_ANCESTRY_DIAGNOSTICS);
    const updated = { ...scope, ancestryAttempts: attempts };

    const writeTx = database.transaction(SCOPES, "readwrite");
    writeTx.objectStore(SCOPES).put(updated);
    await completeTransaction(writeTx);
    return updated;
  });
}

// ---- Roots ---------------------------------------------------------------

export async function getRoot(rootId) {
  if (!rootId) return null;
  return withDatabase(async (database) => {
    const tx = database.transaction(ROOTS, "readonly");
    const record = await requestToPromise(tx.objectStore(ROOTS).get(rootId));
    await completeTransaction(tx);
    return record || null;
  });
}

export async function listRoots() {
  return withDatabase(async (database) => {
    const tx = database.transaction(ROOTS, "readonly");
    const records = await requestToPromise(tx.objectStore(ROOTS).getAll());
    await completeTransaction(tx);
    return records || [];
  });
}

/**
 * Atomically claims `rootId` for a scope.
 *
 * The rootId key is what resolves a scope-minting race: two tabs that both
 * decided to mint a scope for the same unseen root will both try to add() this
 * row, exactly one wins, and the loser adopts the winner's scopeId and
 * discards the scope it minted. An orphaned scope row is inert — nothing
 * points at it — and costs one small record.
 *
 * Returns { root, created }.
 */
export async function claimRoot(candidate) {
  return withDatabase(async (database) => {
    const readTx = database.transaction(ROOTS, "readonly");
    const existing = await requestToPromise(readTx.objectStore(ROOTS).get(candidate.rootId));
    await completeTransaction(readTx);
    if (existing) return { root: existing, created: false };

    const writeTx = database.transaction(ROOTS, "readwrite");
    const outcome = await addToPromise(writeTx.objectStore(ROOTS).add(candidate));
    await completeTransaction(writeTx);
    if (!outcome.conflict) return { root: candidate, created: true };

    // Lost the race. The winner's row is authoritative.
    const rereadTx = database.transaction(ROOTS, "readonly");
    const winner = await requestToPromise(rereadTx.objectStore(ROOTS).get(candidate.rootId));
    await completeTransaction(rereadTx);
    return { root: winner || candidate, created: false };
  });
}

export async function updateRoot(rootId, patch) {
  return withDatabase(async (database) => {
    const readTx = database.transaction(ROOTS, "readonly");
    const record = await requestToPromise(readTx.objectStore(ROOTS).get(rootId));
    await completeTransaction(readTx);
    if (!record) return null;

    const updated = { ...record, ...patch, rootId };
    const writeTx = database.transaction(ROOTS, "readwrite");
    writeTx.objectStore(ROOTS).put(updated);
    await completeTransaction(writeTx);
    return updated;
  });
}

// ---- Paths ---------------------------------------------------------------

export async function getPath(scopeId, scopeRelativePath) {
  return withDatabase(async (database) => {
    const tx = database.transaction(PATHS, "readonly");
    const record = await requestToPromise(tx.objectStore(PATHS).get([scopeId, scopeRelativePath]));
    await completeTransaction(tx);
    return record || null;
  });
}

export async function listPathsInScope(scopeId) {
  return withDatabase(async (database) => {
    const tx = database.transaction(PATHS, "readonly");
    const records = await requestToPromise(tx.objectStore(PATHS).getAll());
    await completeTransaction(tx);
    return (records || []).filter((record) => record.scopeId === scopeId);
  });
}

export async function countPaths() {
  return withDatabase(async (database) => {
    const tx = database.transaction(PATHS, "readonly");
    const records = await requestToPromise(tx.objectStore(PATHS).getAll());
    await completeTransaction(tx);
    return (records || []).length;
  });
}

const MAX_SIGNATURE_HISTORY = 8;

// [WHY: history exists so a CHANGED signature can VETO a match later rather
//  than silently overwriting the evidence that would have caught it. Identical
//  consecutive observations are collapsed — re-opening the same unchanged
//  folder every day must not grow an unbounded list.]
function appendSignatureHistory(history, signature, at) {
  if (!signature) return history || [];
  const list = history || [];
  const last = list[list.length - 1];
  if (last && last.size === signature.size && last.lastModified === signature.lastModified) return list;
  return [...list, { size: signature.size, lastModified: signature.lastModified, at }].slice(-MAX_SIGNATURE_HISTORY);
}

function mergeFactSeenIn(existing, profileId) {
  const list = Array.isArray(existing) ? existing : [];
  if (!profileId || list.includes(profileId)) return list;
  return [...list, profileId];
}

// [WHY: "anchored" is a one-way upgrade. A path that has EVER been observed
//  carrying a Profile fact keeps that status even if a later load of a
//  different root does not include it — the evidence was real when it was
//  taken, and downgrading it would quietly discard the retro-anchor that
//  capture-now exists to bank.]
function mergeAnchorState(existing, incoming) {
  if (existing === "anchored" || incoming === "anchored") return "anchored";
  return incoming || existing || "unanchored";
}

function mergeOrigin(existing, incoming) {
  if (existing === "observed" || incoming === "observed") return "observed";
  return incoming || existing || "fact-only";
}

function mergeExisting(record, entry, now) {
  return {
    ...record,
    lastSeenAt: now,
    origin: mergeOrigin(record.origin, entry.origin),
    anchorState: mergeAnchorState(record.anchorState, entry.anchorState),
    observedSignature: entry.observedSignature || record.observedSignature || null,
    signatureHistory: appendSignatureHistory(record.signatureHistory, entry.observedSignature, now),
    factSeenIn: mergeFactSeenIn(record.factSeenIn, entry.profileId),
  };
}

function buildNew(entry, now) {
  return {
    scopeId: entry.scopeId,
    scopeRelativePath: entry.scopeRelativePath,
    mediaId: generateMediaId(),
    firstSeenAt: now,
    lastSeenAt: now,
    origin: entry.origin || "observed",
    anchorState: entry.anchorState || "unanchored",
    // Shaped so a future audited stage COULD publish it verbatim. Not published.
    observedSignature: entry.observedSignature || null,
    signatureHistory: appendSignatureHistory([], entry.observedSignature, now),
    // [WHY: fact-derived evidence is PROFILE-SCOPED. Seeding reads the ACTIVE
    //  profile's knownPaths(), so without this tag a scope shared by two roots
    //  associated with different Profiles would let Stage 02 project one
    //  Profile's Favorite into the other's view. Observed file evidence
    //  (size/mtime) is profile-independent and carries no tag.]
    factSeenIn: mergeFactSeenIn([], entry.profileId),
  };
}

/**
 * Atomic get-or-create for a batch of (scopeId, scopeRelativePath) entries.
 *
 * Three transactions per batch regardless of batch size:
 *   1. readonly  — every get() queued synchronously, so they share one tx
 *   2. readwrite — every add()/put() queued synchronously, conflicts collected
 *   3. readonly  — re-read ONLY the rows a racing tab won, to adopt their ids
 *
 * The third runs only when a race actually happened, which is rare.
 *
 * Returns { created, adopted, updated, records } — records keyed by
 * scopeRelativePath, each carrying the DURABLE mediaId (this tab's, or the
 * winner's).
 */
export async function seedPathBatch(entries, { now = Date.now() } = {}) {
  if (!entries.length) return { created: 0, adopted: 0, updated: 0, records: new Map() };

  return withDatabase(async (database) => {
    const readTx = database.transaction(PATHS, "readonly");
    const readStore = readTx.objectStore(PATHS);
    // Queued synchronously — one transaction, not one per entry.
    const pending = entries.map((entry) => requestToPromise(readStore.get([entry.scopeId, entry.scopeRelativePath])));
    await completeTransaction(readTx);
    const existingRows = await Promise.all(pending);

    const writeTx = database.transaction(PATHS, "readwrite");
    const writeStore = writeTx.objectStore(PATHS);

    const records = new Map();
    const conflicts = [];
    const outcomes = [];
    let created = 0;
    let updated = 0;

    entries.forEach((entry, index) => {
      const existing = existingRows[index];
      if (existing) {
        const merged = mergeExisting(existing, entry, now);
        writeStore.put(merged);
        records.set(entry.scopeRelativePath, merged);
        updated += 1;
        return;
      }
      const fresh = buildNew(entry, now);
      // add(), NEVER put(). See the concurrency contract in the header.
      outcomes.push({ entry, fresh, promise: addToPromise(writeStore.add(fresh)) });
    });

    await completeTransaction(writeTx);

    for (const outcome of outcomes) {
      const result = await outcome.promise;
      if (result.conflict) {
        conflicts.push(outcome.entry);
      } else {
        records.set(outcome.entry.scopeRelativePath, outcome.fresh);
        created += 1;
      }
    }

    let adopted = 0;
    if (conflicts.length) {
      const adoptTx = database.transaction(PATHS, "readonly");
      const adoptStore = adoptTx.objectStore(PATHS);
      const rereads = conflicts.map((entry) =>
        requestToPromise(adoptStore.get([entry.scopeId, entry.scopeRelativePath]))
      );
      await completeTransaction(adoptTx);
      const winners = await Promise.all(rereads);

      winners.forEach((winner, index) => {
        if (!winner) return;
        // Adopt the winner's mediaId. The id this tab minted is discarded and
        // was never durable — exactly one identity exists for this path.
        records.set(conflicts[index].scopeRelativePath, winner);
        adopted += 1;
      });
    }

    return { created, adopted, updated, records };
  });
}

// ---- Re-basing -----------------------------------------------------------

/**
 * Moves a scope's root UP — the user opened a subfolder first and the real
 * MASTER later — re-expressing every stored path and every member root
 * relative to the new, shallower root.
 *
 * `prefixToPrepend` comes from a PROVEN resolve() result, never from
 * inference, so this migration is deterministic.
 *
 * [WHY: guarded by scopeVersion compare-and-set. Two tabs that both notice the
 *  new ancestor would otherwise both re-base, prepending the prefix twice and
 *  corrupting every path in the scope. The version check makes the second one a
 *  no-op it can detect and retry against fresh state. Every store the migration
 *  touches is in ONE transaction, so a re-base is all-or-nothing — a partially
 *  re-based scope, with some paths shifted and some not, would be
 *  indistinguishable from genuine data and unrecoverable.]
 *
 * Returns { ok: true, scope } or { ok: false, reason }.
 */
export async function rebaseScope(scopeId, expectedVersion, { newScopeRootId, prefixToPrepend, at = Date.now() }) {
  if (!prefixToPrepend) return { ok: false, reason: "empty-prefix" };

  return withDatabase(async (database) => {
    // [WHY: read AND write in ONE readwrite transaction. An earlier shape read
    //  the scope in a readonly transaction, compared scopeVersion, then wrote in
    //  a second transaction — which is not a compare-and-set at all: two tabs
    //  both read version 1, both passed the check, and both applied the prefix,
    //  producing "Staging area/Mackenzie/Staging area/Mackenzie/cat.jpg" and
    //  destroying every path in the scope. The concurrency suite caught it.
    //
    //  Requests are queued synchronously and the decision is made inside the
    //  LAST one's success callback, which is still inside the live transaction —
    //  awaiting between requests would let the transaction go inactive and
    //  commit underneath the rest of the work.]
    const tx = database.transaction([SCOPES, ROOTS, PATHS], "readwrite");
    const scopeStore = tx.objectStore(SCOPES);
    const rootStore = tx.objectStore(ROOTS);
    const pathStore = tx.objectStore(PATHS);

    const scopeRequest = scopeStore.get(scopeId);
    const rootsRequest = rootStore.getAll();
    const pathsRequest = pathStore.getAll();

    let outcome = { ok: false, reason: "no-result" };

    pathsRequest.onsuccess = () => {
      const scope = scopeRequest.result;
      if (!scope) {
        outcome = { ok: false, reason: "no-scope" };
        return;
      }
      if (scope.scopeVersion !== expectedVersion) {
        // The guard. A racing tab already re-based; applying ours on top would
        // double-prepend the prefix.
        outcome = { ok: false, reason: "version-conflict" };
        return;
      }

      const scopeRoots = (rootsRequest.result || []).filter((root) => root.scopeId === scopeId);
      const scopePaths = (pathsRequest.result || []).filter((record) => record.scopeId === scopeId);

      const nextScope = { ...scope, scopeRootId: newScopeRootId, scopeVersion: scope.scopeVersion + 1, rebasedAt: at };
      scopeStore.put(nextScope);

      // [WHY: the NEW scope root is excluded from the prepend and pinned to "".
      //  It is the origin every other prefix is measured from, so nesting it
      //  inside itself is a contradiction. This is not theoretical: the root row
      //  is claimed (with prefix "") immediately BEFORE this migration runs, so
      //  a blanket prepend over "every root in the scope" caught the new master
      //  too and stamped it with the very prefix it was replacing.
      //
      //  Real Browser Preview testing found it, and the damage is not confined
      //  to a cosmetically wrong row: the NEXT load of that master reads the
      //  bad prefix back and seeds every path a second time under a doubled
      //  key, forking identity for the entire library, silently.
      //
      //  Written as an explicit set rather than by re-ordering the claim, so the
      //  invariant "the scope root's prefix is empty" holds regardless of
      //  whether the row was claimed before or after this runs.]
      for (const root of scopeRoots) {
        if (root.rootId === newScopeRootId) {
          rootStore.put({ ...root, prefixFromScopeRoot: "" });
          continue;
        }
        rootStore.put({ ...root, prefixFromScopeRoot: `${prefixToPrepend}${root.prefixFromScopeRoot || ""}` });
      }

      // Delete-then-add, because the path IS part of the primary key: a put()
      // under the new key would leave the old row behind as a second, orphaned
      // identity for the very same file.
      for (const record of scopePaths) {
        pathStore.delete([record.scopeId, record.scopeRelativePath]);
      }
      for (const record of scopePaths) {
        pathStore.put({ ...record, scopeRelativePath: `${prefixToPrepend}${record.scopeRelativePath}` });
      }

      outcome = { ok: true, scope: nextScope, rebasedPaths: scopePaths.length, rebasedRoots: scopeRoots.length };
    };

    await completeTransaction(tx);
    return outcome;
  });
}

// ---- Seeding cursors (efficiency only — never correctness) ---------------

// [WHY: seeding is resumable WITHOUT this. Every write is an idempotent
//  get-or-create, so re-running a partially finished pass is a no-op for
//  everything already banked. The cursor exists purely so a resumed pass does
//  not re-walk work it already did; losing it, or reading a stale one, costs
//  time and nothing else. Correctness must never depend on it.]
export async function getSeedCursor(scopeId, rootId) {
  const cursorKey = `${scopeId}::${rootId}`;
  return withDatabase(async (database) => {
    const tx = database.transaction(CURSORS, "readonly");
    const record = await requestToPromise(tx.objectStore(CURSORS).get(cursorKey));
    await completeTransaction(tx);
    return record || null;
  });
}

export async function setSeedCursor(scopeId, rootId, { index, total, at = Date.now(), done = false }) {
  const cursorKey = `${scopeId}::${rootId}`;
  return withDatabase(async (database) => {
    const tx = database.transaction(CURSORS, "readwrite");
    tx.objectStore(CURSORS).put({ cursorKey, scopeId, rootId, index, total, at, done });
    await completeTransaction(tx);
  });
}

export const __TEST__ = { DATABASE_NAME, SCOPES, ROOTS, PATHS, CURSORS };
