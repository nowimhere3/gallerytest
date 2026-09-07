// [PM-SHUFFLE-FOLDERS]
// WHAT: The pure candidate-ordering half of Presentation Mode's 🎲 Shuffle
// Folders action — "given the remembered Media Folders and which one is
// loaded right now, in what random order should switching be attempted?"
//
// WHY a separate module rather than a helper inside main.js: the two halves
// of this action have completely different natures. Choosing IS pure — a
// list in, a shuffled list out, with `random` injected — and is therefore
// the half worth proving deterministically (see
// tools/test-pm-shuffle-folders.mjs). Actually switching is not pure at all:
// it needs live FSA permission state and the real loader, and both of those
// already have exactly one authoritative home in main.js
// (resumeLibrary() -> loadFromFsaHandle()). Keeping the pure half here means
// the random-selection RULE can be regression-tested without a DOM, an
// IndexedDB, or a single FSA handle, and the impure half stays a thin walk
// over this function's output rather than a second selection algorithm.
//
// This module owns NO storage of its own. Its input is whatever
// library-registry.js's listLibraries() returned — the single authoritative
// remembered-Media-Folder collection — never a private copy or cache.
//
// FUTURE: PM Shuffle Folders may optionally use a customer-selected
// eligible-folder scope configured through persistent settings/Automations.
// The 🎲 control remains the immediate runtime action.

/**
 * A remembered folder is only a shuffle candidate if it can plausibly be
 * resumed without the customer being asked to do anything: it needs a
 * registry id and a saved FSA directory handle. A record with no handle
 * (a legacy webkitdirectory row, or one whose handle failed to persist)
 * could only be "opened" by putting a folder picker in front of the
 * customer, which is exactly what 🎲 must never do — so it is not a
 * candidate at all, rather than a candidate that fails later.
 *
 * This is the CHEAP, synchronous half of usability. The expensive half —
 * whether the browser will still hand over read access without a
 * permission prompt — is a live `queryPermission()` question that only the
 * caller can ask, and is deliberately left to it (see main.js).
 */
function isShuffleCandidate(record) {
  return Boolean(record && record.id && record.handle);
}

/**
 * Fisher-Yates, on a copy, with the caller's `random`. Every permutation is
 * equally likely, which a repeated "pick one at random" would not
 * guarantee once the caller starts skipping unusable entries — the ORDER
 * this returns is the selection, so it has to be uniformly random all the
 * way down, not just at its head.
 */
function shuffled(rows, random) {
  const out = [...rows];
  for (let i = out.length - 1; i > 0; i--) {
    const sample = Number(random());
    const unit = Number.isFinite(sample) ? Math.min(Math.max(sample, 0), 0.9999999999999999) : 0;
    const j = Math.floor(unit * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * [PM-SHUFFLE-FOLDERS]
 * Returns the remembered Media Folders 🎲 should try to switch to, in a
 * randomly-ordered sequence of ATTEMPTS — not a single choice.
 *
 * WHY an ordered list instead of one pick: a remembered folder can turn out
 * to be unusable (revoked permission, disconnected storage, a stale handle)
 * only when it is actually asked, and the brief's rule for that case is
 * "skip it and try another currently usable remembered folder." Handing the
 * caller a random ORDER lets it walk down until one works, while every
 * skip-and-retry decision still comes from this one uniformly-random
 * sequence. A "pick one, ask again if it fails" design would have to
 * re-randomize mid-action and could re-offer a folder it already rejected.
 *
 * `currentLibraryId` is excluded outright and is never re-added as a
 * fallback: "prefer a folder other than the current one" and "with only the
 * current folder usable, do nothing gracefully" are the same rule seen from
 * two sides. An empty result therefore means "there is nothing to shuffle
 * to", which the caller answers by staying exactly where it is — not an
 * error, and not a reason to prompt.
 */
export function orderShuffleFolderCandidates({ libraries, currentLibraryId = null, random = Math.random } = {}) {
  const rows = Array.isArray(libraries) ? libraries : [];
  const others = rows.filter((record) => isShuffleCandidate(record) && record.id !== currentLibraryId);
  return shuffled(others, random);
}
