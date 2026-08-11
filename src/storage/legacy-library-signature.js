// [Phase 8.4-3] Legacy (webkitdirectory) folder identity.
//
// FSA has a real, reusable FileSystemDirectoryHandle and a browser-native
// isSameEntry() to recognize "this is physically the same folder as
// before." webkitdirectory gives none of that — every pick is a fresh
// FileList with no reusable handle. This module builds the strongest
// PRACTICAL identity signal available from that FileList's metadata alone,
// and a matching function that only ever claims a match when it's
// confident — silence (no match) is the safe failure mode here, not a
// guess. See main.js's loadFiles() for where this gets called, and
// library-registry.js for where the result is persisted.
//
// ---- What's actually available from a legacy File --------------------
//
// Inspected directly against LocalFileInputProvider's output (the only
// place this app turns a FileList into MediaItems): per file, the browser
// reliably provides `name`, `size`, `lastModified`, and — for a
// webkitdirectory pick specifically — `webkitRelativePath` (folder-relative
// path, root segment stripped further down into `relativePath` by that
// provider). Total file count falls out of the list length. There is
// nothing else stable: no content hash, no inode/volume id, no persisted
// handle. `lastModified` is included in the signature but NOT weighted
// heavily — it changes on innocuous things (a re-copy, a re-download, a
// filesystem touch) that don't mean the file is actually different
// content, so it's informational only, never load-bearing for a match.
//
// ---- Signature shape ---------------------------------------------------
//
//   {
//     version: 1,
//     rootName: "<normalized root folder name>",
//     rootNameHash: "<short hash of rootName — for privacy-safe logging>",
//     itemCount: number,
//     totalSize: number,               // sum of all item sizes — cheap aggregate
//     exactHash: "<sha256 hex>",       // hash of the FULL sorted metadata list;
//                                      // matches only when NOTHING changed at all
//     sampleEntries: string[],         // "relativePath|size" — see below
//   }
//
// `exactHash` is a fast short-circuit for the common case (re-picking the
// exact same, unchanged folder) — one string comparison instead of running
// the overlap math below. It is NOT full-file-content hashing (explicitly
// out of scope/too slow for thousands of media files) — it's a hash of
// metadata strings only (paths + sizes), which is cheap regardless of
// library size.
//
// `sampleEntries` is what tolerates drift (files added/removed/renamed).
// Each item's inclusion is decided independently by hashing ITS OWN
// relativePath — NOT by its position in a sorted list — so adding or
// removing files elsewhere in the tree doesn't shift which files end up
// sampled (the classic failure mode of "take every Nth item by index").
// This is a form of consistent sampling: the same file, unchanged,
// deterministically samples the same way regardless of what else in the
// folder changed. A fixed inclusion rate (not derived from the current
// item count) keeps that stable across small count changes too.

const SAMPLE_MODULUS = 50; // ~2% of files sampled by content-based inclusion
const SMALL_LIBRARY_THRESHOLD = 200; // below this, just sample everything — cheap, and more reliable for small folders where a 2% rate would round to ~0

// ---- Hashing -------------------------------------------------------------
//
// FNV-1a 32-bit: fast, deterministic, good-enough distribution for sampling
// decisions and short debug-safe ids. Not cryptographic — doesn't need to
// be; nothing here is a security boundary.
function fnv1a32(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

async function sha256Hex(str) {
  if (typeof crypto !== "undefined" && crypto.subtle && typeof crypto.subtle.digest === "function") {
    const bytes = new TextEncoder().encode(str);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
  // No SubtleCrypto available (very old browser, or a non-secure-context
  // edge case) — fall back to the same FNV-1a used for sampling. Weaker,
  // but this hash is only ever a same-machine short-circuit; the overlap
  // matching below is the real safety net either way.
  return fnv1a32(str);
}

function normalizeRootName(rootName) {
  return (rootName || "").trim().toLowerCase();
}

/**
 * Builds a legacy library signature from a loaded item list (as produced
 * by LocalFileInputProvider — needs `.relativePath` and `.size` on each)
 * plus the picked folder's own top-level name. Cheap and metadata-only:
 * one pass to sort/sample + one hash of the resulting string, nothing
 * proportional to file CONTENT size regardless of how many files there
 * are.
 */
export async function computeLegacySignature(items, rootName) {
  const normalizedRoot = normalizeRootName(rootName);
  const entries = items.map((item) => `${item.relativePath}|${item.size}`);
  const sorted = [...entries].sort();

  const totalSize = items.reduce((sum, item) => sum + (Number(item.size) || 0), 0);

  // Consistent sampling: each item's inclusion is decided by hashing ITS
  // OWN relativePath, not by position in the sorted list — so files
  // added/removed elsewhere in the tree don't shift which files end up
  // sampled. Small libraries just use everything (a 2% rate would round
  // to ~0 and be unreliable there anyway).
  const reservoir =
    items.length <= SMALL_LIBRARY_THRESHOLD
      ? sorted
      : items
          .filter((item) => parseInt(fnv1a32(item.relativePath), 16) % SAMPLE_MODULUS === 0)
          .map((item) => `${item.relativePath}|${item.size}`)
          .sort();

  const exactHash = await sha256Hex(`${normalizedRoot}::${items.length}::${sorted.join("\n")}`);

  return {
    version: 1,
    rootName: normalizedRoot,
    rootNameHash: fnv1a32(normalizedRoot),
    itemCount: items.length,
    totalSize,
    exactHash,
    sampleEntries: reservoir,
  };
}

function overlapRatio(currentEntries, storedEntries) {
  if (!currentEntries.length || !storedEntries.length) return 0;
  const storedSet = new Set(storedEntries);
  let intersect = 0;
  for (const entry of currentEntries) {
    if (storedSet.has(entry)) intersect += 1;
  }
  return intersect / Math.max(1, Math.min(currentEntries.length, storedEntries.length));
}

// Confidence thresholds. Deliberately conservative — "false negatives are
// preferable to false-positive Profile switching" (spec). These are a
// starting point; real browser testing against real libraries (Test C —
// drift) is expected to inform tuning, see the phase report.
const STRONG_OVERLAP_MIN = 0.6;
const STRONG_COUNT_DRIFT_MAX = 0.35; // itemCount allowed to differ by up to 35% of the larger count
const AMBIGUITY_MARGIN = 0.15; // two candidates within this score of each other -> refuse to guess

/**
 * Compares a freshly-computed signature against every stored legacy
 * library record and decides whether one of them is confidently the same
 * physical folder.
 *
 * Returns one of:
 *   { status: "match", record, score }       — confident enough to auto-restore
 *   { status: "ambiguous", candidateIds }     — two+ plausible matches, refuse to guess
 *   { status: "none" }                        — no confident match; treat as a new/unrecognized library
 */
export function matchLegacySignature(current, storedRecords) {
  const scored = [];

  for (const record of storedRecords) {
    const stored = record.signature;
    if (!stored) continue;

    if (stored.exactHash && current.exactHash === stored.exactHash) {
      scored.push({ record, score: 1 });
      continue;
    }

    if (stored.rootName !== current.rootName) continue; // root name alone is never sufficient, but a MISMATCH is still a useful early exclusion

    const ratio = overlapRatio(current.sampleEntries, stored.sampleEntries);
    const countDrift =
      Math.abs(current.itemCount - stored.itemCount) / Math.max(current.itemCount, stored.itemCount, 1);

    if (ratio >= STRONG_OVERLAP_MIN && countDrift <= STRONG_COUNT_DRIFT_MAX) {
      scored.push({ record, score: ratio });
    }
    // Anything scoring below the strong threshold is deliberately dropped
    // here rather than kept as a "weak" candidate — a weak match is not
    // treated as a match at all; only STRONG candidates ever participate
    // in the ambiguity check below, per "do not silently reinterpret /
    // do not guess."
  }

  if (!scored.length) return { status: "none" };

  scored.sort((a, b) => b.score - a.score);
  const [best, second] = scored;

  if (second && best.score - second.score < AMBIGUITY_MARGIN) {
    return { status: "ambiguous", candidateIds: scored.slice(0, 2).map((entry) => entry.record.id) };
  }

  return { status: "match", record: best.record, score: best.score };
}
