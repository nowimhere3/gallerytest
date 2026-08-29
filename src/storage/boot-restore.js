// [BOOT-RESTORE / N6]
//
// BREADCRUMBS — IS: boot restores the most recent durable folder only when
// queryPermission already reports "granted". Never requestPermission — that
// needs a gesture. Anything other than "granted" does nothing at all.
//
// BREADCRUMBS — WAS: boot deliberately avoided touching permission, on the
// reasoning that even queryPermission was "silently touching folder access".
// Six modules now query permission from background paths, and
// profileSync.init() already silently reconnects the Sync Folder on the same
// basis; the ordinary media folder was the last one still asking the
// customer for an answer Browser Gallery already had.
//
// BREADCRUMBS — WILL BE / FUTURE: native owns durable folder access and
// restores without any permission question. Keep this decision pure and
// permission-shaped so the native provider substitutes its own
// always-granted answer rather than needing different policy.
//
// This module holds ONLY the pure decision — no I/O, no DOM, no
// queryPermission call itself. `rows` is whatever listLibraries() returned
// (already sorted by lastOpenedAt descending and already filtered to
// durable FSA rows — see library-registry.js). `permissionStates` maps a
// row's id to whatever its handle's queryPermission({mode:"read"}) already
// resolved to (the caller performs that live, async, non-gesture read — see
// main.js's initFsaLibraries()). Keeping the query itself outside this
// function is what makes the whole policy exhaustively testable in Node
// without a real FileSystemDirectoryHandle.
//
// [WHY: only rows[0] is ever consulted, even if permissionStates carries an
//  entry for rows[1] or beyond. Trying a second candidate when the most
//  recent one isn't granted would be Browser Gallery GUESSING which folder
//  the customer wanted — see NORTH-STAR.md's Decision Ladder. "No restore"
//  degrades to today's one-click Recent-folder workflow, which already
//  exists and needs nothing new to keep working.]
export function decideBootRestore({ rows, permissionStates } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return { restore: false };

  const candidate = rows[0];
  if (!candidate || !candidate.id) return { restore: false };

  // [WHY: listLibraries() already excludes legacy and removedFromRecents
  //  rows (P8) — this repeats that exclusion structurally, as a second
  //  independent guard, rather than trusting every future caller to always
  //  pass an already-filtered rows[0].]
  if (candidate.sourceKind === "legacy" || candidate.removedFromRecents) return { restore: false };

  const state = permissionStates ? permissionStates[candidate.id] : undefined;
  if (state !== "granted") return { restore: false };

  return { restore: true, rowId: candidate.id };
}

// [STARTUP-MEDIA / N6-4]
//
// Extends this module rather than adding a second one — `decideBootRestore()`
// above is untouched, and IS this function's own `"last-used"` branch (see
// below). Still pure: no I/O, no DOM, no `Math.random()` call of its own —
// `random` is injected, exactly the pattern `micro-arcade-selector.js`
// already uses for its own deterministic-test seam. `rows` and
// `permissionStates` carry the same meaning `decideBootRestore()` documents
// above; `eligibleIds` is whatever `app-preferences.js` normalized
// `startup.eligibleLibraryIds` to.
//
// [WHY: "a customer gesture already in flight wins" (the first rule in the
//  N6-3 handoff's decision order) is NOT implemented here. It is already
//  true structurally, for the same reason it was true for N6's boot restore:
//  every caller of this function goes on to load its result through
//  loadFromFsaHandle(), which is the ONE place libraryLoadGeneration is
//  bumped, and every arming call already gates on that token. Duplicating a
//  staleness check in this pure function would be new machinery this
//  project's own P5 rule says not to invent.]
function normalizeStartupPool(rows) {
  return Array.isArray(rows)
    ? rows.filter((row) => row && row.id && row.sourceKind !== "legacy" && !row.removedFromRecents)
    : [];
}

// [WHY: a fixed `random` must map to a fixed row across runs, but Array.sort
//  order for equal keys (ties on lastOpenedAt, or rows sharing no timestamp
//  at all) is not guaranteed stable input-order-wise once ids differ — so a
//  second, deterministic tiebreaker (id, ascending) is required, not
//  optional. See the N6-3 handoff's own "four rules that are easy to get
//  wrong."]
function sortStartupPoolDeterministically(pool) {
  return [...pool].sort((a, b) => {
    const byRecency = (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0);
    if (byRecency !== 0) return byRecency;
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });
}

function pickGrantedRow(pool, permissionStates, random) {
  const granted = sortStartupPoolDeterministically(pool).filter(
    (row) => (permissionStates ? permissionStates[row.id] : undefined) === "granted"
  );
  if (granted.length === 0) return { restore: false };
  if (granted.length === 1) return { restore: true, rowId: granted[0].id };

  const index = Math.floor(random() * granted.length);
  const safeIndex = Math.min(Math.max(index, 0), granted.length - 1);
  return { restore: true, rowId: granted[safeIndex].id };
}

// BREADCRUMBS — WILL BE / FUTURE: `context` exists so an explicitly
// identified StreamLoop launch can select a different startup policy than
// ordinary browser use. It must be set only from an explicit launch/runtime
// contract — never inferred from framing, referrer, or user agent.
export function decideStartupMedia({
  policy,
  rows,
  permissionStates,
  eligibleIds,
  random = Math.random,
  // `context` is intentionally unused below — it is a seam, not dead code.
  // See the BREADCRUMBS above.
  context = "browser",
} = {}) {
  // [WHY: any unrecognized policy string — including one from a stored
  //  record written by a future version this build doesn't know about —
  //  degrades to today's proven default rather than doing nothing-in-a-new-
  //  way or throwing. Matches app-preferences.js's own normalization rule
  //  for this field.]
  if (policy !== "random-remembered" && policy !== "random-selected") {
    return decideBootRestore({ rows, permissionStates });
  }

  const pool = normalizeStartupPool(rows);

  if (policy === "random-selected") {
    const eligibleSet = new Set(
      Array.isArray(eligibleIds) ? eligibleIds.filter((id) => typeof id === "string" && id) : []
    );
    // [WHY: an empty eligible set is a customer's explicit "nothing chosen
    //  yet", never an invitation to fall back to last-used — that would
    //  silently override the policy they picked with a default they didn't.
    //  See the N6-3 handoff's "four rules that are easy to get wrong."]
    if (eligibleSet.size === 0) return { restore: false };
    return pickGrantedRow(pool.filter((row) => eligibleSet.has(row.id)), permissionStates, random);
  }

  return pickGrantedRow(pool, permissionStates, random);
}
