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
