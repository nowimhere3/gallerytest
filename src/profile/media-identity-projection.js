// [MEDIA-ID / STAGE-02 / LOCAL-PROJECTION]
//
// The pure half of Stage 02: which existing Profile fact paths denote the same
// logical media as the path the user is currently looking at, and — once that
// is known — which single value each curated field projects to.
//
// No I/O, no IndexedDB, no FSA, no DOM, no ProfileStore, no clock. Existence is
// supplied as an injected async callback, so every admission rule below can be
// driven exhaustively from a table in Node. Kept out of profile-store.js the
// same way sync-translate.js is.
//
// ---- T0 and T1, and what separates them ----------------------------------
//
// T0 is the exact key lookup the app has always done: the fact stored under the
// path being viewed applies to the item being viewed. It is UNCONDITIONAL here
// and is never refused.
//
// [WHY UNCONDITIONAL: existing facts carry no root provenance. Suppressing T0
//  when a key looks ambiguous would hide the Favorite on the file the user
//  actually curated exactly as often as it would hide a wrong one — trading a
//  false positive for a false negative on a coin flip, which is not the same
//  thing as preferring false negatives. The pre-existing exact-key collision
//  (one literal key produced by two independently picked roots) is therefore
//  left exactly as it is: Stage 02 makes it no worse and does not claim to
//  solve it.]
//
// T1 re-expresses a path through a PROVEN ancestry relationship. Stage 01's
// root prefixes come only from FileSystemDirectoryHandle.resolve() proofs or
// from a version-guarded re-base — never from inference — so the mapping itself
// is deterministic. What is NOT automatic is that the fact key being re-mapped
// meant THIS destination.
//
// ---- The competing-destination rule --------------------------------------
//
// [WHY: this is the rule that stops Stage 02 introducing a brand new false
//  positive, and it does not fall out of "use T0/T1 only".
//
//  MASTER/ (prefix "") and MASTER/Backup/ (prefix "Backup/") in one proven
//  scope. The user favourites MASTER/Cats/cat.jpg while viewing MASTER, so the
//  fact key is "Cats/cat.jpg". Now view MASTER again and look at the BACKUP
//  copy, scope path "Backup/Cats/cat.jpg". Reverse-mapping through the Backup
//  root yields the candidate key "Cats/cat.jpg" — and naively projecting it
//  would land the sibling's Favorite on the backup copy.
//
//  So a candidate key K is admitted onto destination S only when every OTHER
//  scope path K could denote is proven ABSENT. In the example "Cats/cat.jpg"
//  also denotes scope path "Cats/cat.jpg", which is PRESENT, so K is refused —
//  while still applying to its own item through T0.
//
//  UNKNOWN refuses. A destination that cannot be proven either way is exactly
//  the case where guessing would be unsafe, so it is never treated as absence.
//  Roots that map K to the SAME S are not competitors — they are two views of
//  one location, which is the whole point of a scope.]

import { compareStamps } from "./sync-merge.js";
import { LOCAL_SEED_T } from "./sync-translate.js";
import { EXISTENCE } from "../storage/fsa-existence.js";
// [MEDIA-ID / STAGE-02B / TELEMETRY]
import { createRefusalLedger, normalizeExistence } from "./media-identity-telemetry.js";

export const REFUSAL = Object.freeze({
  COMPETITOR_PRESENT: "competitor-present",
  COMPETITOR_UNKNOWN: "competitor-unknown",
  NO_FACT: "no-fact",
});

/** Expresses a root-relative path in scope-relative terms. */
export function toScopePath(prefix, relativePath) {
  return prefix ? `${prefix}${relativePath}` : relativePath;
}

/**
 * Every scope path the fact key `key` could denote, given the roots of one
 * scope. Deduplicated BY VALUE, because two roots that resolve a key to the
 * same location describe one destination, not two.
 */
export function destinationsFor(key, roots) {
  const out = new Set();
  for (const root of roots) out.add(toScopePath(root.prefixFromScopeRoot || "", key));
  return [...out];
}

/**
 * The candidate fact keys for one observed scope path, excluding the T0 key.
 *
 * A root whose prefix is a prefix of `scopePath` can name that same location
 * with a shorter key; that key is a candidate precisely when a Profile fact
 * exists under it.
 */
export function candidateKeysFor({ scopePath, roots, t0Key, factKeySet }) {
  const seen = new Set([t0Key]);
  const candidates = [];
  for (const root of roots) {
    const prefix = root.prefixFromScopeRoot || "";
    if (prefix && !scopePath.startsWith(prefix)) continue;
    const key = scopePath.slice(prefix.length);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (!factKeySet.has(key)) continue;
    candidates.push({ key, viaRootId: root.rootId });
  }
  return candidates;
}

/**
 * Decides whether candidate key `key` may be projected onto `scopePath`.
 *
 * `statusOf(scopePath)` returns an EXISTENCE value and may be async. It is
 * called ONLY for competing destinations, never for the whole library.
 *
 * Returns { admitted, reason, checked }.
 */
export async function admitCandidate({ key, scopePath, roots, statusOf }) {
  const competing = destinationsFor(key, roots).filter((destination) => destination !== scopePath);
  const checked = [];

  for (const destination of competing) {
    // [MEDIA-ID / STAGE-02B / TELEMETRY]
    // [WHY: `statusOf` may answer with a bare EXISTENCE string (Stage 02's
    //  contract, still honoured) or with { status, reason, detail }. The STATUS
    //  is compared below exactly as before; the reason rides along untouched so
    //  the ledger can attribute the refusal without re-asking anything. If this
    //  normalization ever changed a status, the admission rule would change with
    //  it — so it may only ever widen the SHAPE, never the values.]
    const answer = normalizeExistence(await statusOf(destination));
    const status = answer.status;
    checked.push({ destination, status, reason: answer.reason, detail: answer.detail });
    if (status === EXISTENCE.PRESENT) {
      return { admitted: false, reason: REFUSAL.COMPETITOR_PRESENT, checked };
    }
    if (status !== EXISTENCE.ABSENT) {
      // UNKNOWN, or anything a caller invented. Refuse; never optimism.
      return { admitted: false, reason: REFUSAL.COMPETITOR_UNKNOWN, checked };
    }
  }

  return { admitted: true, reason: null, checked };
}

/**
 * Builds the alias map for one load.
 *
 * `observed` is [{ relativePath }] as the provider produced it. Entries are
 * emitted ONLY where a candidate was actually admitted, so a library with no
 * aliasing yields an empty map and Stage 02 costs nothing at read time.
 *
 * Returns { aliases: Map<relativePath, string[]>, diagnostics }.
 */
export async function buildAliasMap({
  prefixFromScopeRoot = "",
  roots = [],
  observed = [],
  factKeys = [],
  statusOf,
  // [MEDIA-ID / STAGE-02B / TELEMETRY]
  // Injected so a caller can own the ledger, and so a test can prove the ledger
  // is fed by the same pass that makes the decisions rather than by a second
  // walk of its own.
  ledger = createRefusalLedger(),
}) {
  const aliases = new Map();
  const factKeySet = factKeys instanceof Set ? factKeys : new Set(factKeys);
  const diagnostics = {
    observed: observed.length,
    factKeys: factKeySet.size,
    candidates: 0,
    admitted: 0,
    refusedPresent: 0,
    refusedUnknown: 0,
    aliasedItems: 0,
    telemetry: ledger.snapshot(),
  };

  // A single-root scope can produce no candidate other than the T0 key, so the
  // whole pass is skipped rather than walked for nothing.
  if (roots.length < 2 || !factKeySet.size) return { aliases, diagnostics };

  for (const item of observed) {
    const relativePath = item && typeof item.relativePath === "string" ? item.relativePath : null;
    if (!relativePath) continue;

    const scopePath = toScopePath(prefixFromScopeRoot, relativePath);
    const candidates = candidateKeysFor({ scopePath, roots, t0Key: relativePath, factKeySet });
    if (!candidates.length) continue;

    const admittedKeys = [];
    for (const candidate of candidates) {
      diagnostics.candidates += 1;
      const verdict = await admitCandidate({ key: candidate.key, scopePath, roots, statusOf });
      // [MEDIA-ID / STAGE-02B / TELEMETRY] Observes the verdict. Cannot change it.
      ledger.recordCandidate({
        scopePath,
        key: candidate.key,
        viaRootId: candidate.viaRootId,
        verdict,
      });
      if (verdict.admitted) {
        diagnostics.admitted += 1;
        admittedKeys.push(candidate.key);
      } else if (verdict.reason === REFUSAL.COMPETITOR_PRESENT) {
        diagnostics.refusedPresent += 1;
      } else {
        diagnostics.refusedUnknown += 1;
      }
    }

    ledger.recordItem({ candidateCount: candidates.length, admittedCount: admittedKeys.length });

    if (admittedKeys.length) {
      diagnostics.aliasedItems += 1;
      // T0 first: it is the status quo and the tiebreak of last resort below.
      aliases.set(relativePath, [relativePath, ...admittedKeys]);
    }
  }

  diagnostics.telemetry = ledger.snapshot();
  return { aliases, diagnostics };
}

// ---- Field resolution -----------------------------------------------------
//
// [WHY: resolution reads STAMPED facts, never the flattened local record. The
//  local record carries no ordering at all, so two aliases that disagree could
//  only be resolved by a rule invented here — and any such rule would be a
//  guess about which of the user's two actions came first. The stamps already
//  answer that, deterministically and identically on every device.
//
//  Nothing in this section writes, mutates or restamps anything. Resolution
//  returns a VALUE; the facts stay exactly where the user put them.]

function pickNewest(aliases, facts, read) {
  let best = null;
  for (const key of aliases) {
    const item = facts[key];
    if (!item) continue;
    const fact = read(item);
    if (!fact || typeof fact.t !== "number") continue;
    if (!best || compareStamps(fact, best.fact) > 0) best = { fact, key };
  }
  return best;
}

/**
 * [WHY: a winner sitting at or below LOCAL_SEED_T came from the pre-Sync-V2
 *  local seed, where every fact in the profile was stamped with the same floor
 *  and the only tiebreak is a deviceId string comparison. That is deterministic
 *  but MEANINGLESS — it encodes no information about which action the user took
 *  first. With no ordering to honour, the correct answer is to change nothing:
 *  fall back to the key the app would have read before Stage 02 existed.]
 */
function applySeedFloorPolicy(best, aliases, facts, read) {
  if (!best || best.fact.t > LOCAL_SEED_T) return best;
  const t0Key = aliases[0];
  const t0Item = facts[t0Key];
  const t0Fact = t0Item ? read(t0Item) : null;
  if (t0Fact && typeof t0Fact.t === "number") return { fact: t0Fact, key: t0Key };
  return best;
}

function resolveField(aliases, facts, read) {
  return applySeedFloorPolicy(pickNewest(aliases, facts, read), aliases, facts, read);
}

const readFavorite = (item) => item.favorite;
const readHidden = (item) => item.hidden;

/**
 * Favorite projects as ONE indivisible fact.
 *
 * [WHY: sync-facts.js models { on, at } as a single value precisely so a merge
 *  can never pair an un-favourite with a stale favourited-at. Composing the two
 *  halves from different aliases here would reintroduce exactly that defect one
 *  layer up, so `at` is always read from the SAME fact that won `on`.]
 */
export function resolveFavorite(aliases, facts) {
  const best = resolveField(aliases, facts, readFavorite);
  if (!best || !best.fact.v) return { on: false, at: null, key: null };
  const value = best.fact.v;
  const on = Boolean(value.on);
  return { on, at: on && Number.isFinite(value.at) ? value.at : null, key: best.key };
}

export function resolveHidden(aliases, facts) {
  const best = resolveField(aliases, facts, readHidden);
  return { hidden: Boolean(best && best.fact.v === true), key: best ? best.key : null };
}

/**
 * Tag membership resolves PER TAG ID.
 *
 * [WHY: sync-facts.js stores one fact per (item, tag) pair so that two people
 *  tagging one item with different tags is a non-event. Resolving a whole tag
 *  SET by one stamp would undo that at projection time — the newest alias would
 *  silently define membership for tags it never mentioned.]
 */
export function resolveTags(aliases, facts, liveTagIds) {
  const tagIds = new Set();
  for (const key of aliases) {
    const item = facts[key];
    if (!item || !item.tags) continue;
    for (const tagId of Object.keys(item.tags)) tagIds.add(tagId);
  }

  const assigned = [];
  for (const tagId of tagIds) {
    // A tombstoned tag is retained on the record so Restore can bring it back,
    // but must never be reported — mirrors ProfileStore#getItemTags exactly.
    if (liveTagIds && !liveTagIds.has(tagId)) continue;
    const best = resolveField(aliases, facts, (item) => (item.tags ? item.tags[tagId] : undefined));
    if (best && best.fact.v === true) assigned.push(tagId);
  }
  return assigned.sort();
}

export const __TEST__ = { pickNewest, applySeedFloorPolicy, LOCAL_SEED_T };
