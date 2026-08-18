// [PHASE-6-SYNC-V2]
// [STAGE-B-SNAPSHOT-INTEGRITY]
// [WHY: a Profile collection that is fingerprinted and then serialized across
//  asynchronous write boundaries must be ONE immutable logical state. If any
//  nested reference inside that collection is still shared with live
//  ProfileStore data, an ordinary user action landing mid-write changes what
//  gets serialized WITHOUT changing what was already hashed — which is exactly
//  how a published generation came to advertise a fingerprint it does not
//  round-trip to. This module is the single authoritative place that
//  detachment happens.]
//
// WHAT: takeSnapshot() — deep-detaches a value from every live reference it
// came from, and (in development) deep-freezes the result so an accidental
// write through a surviving reference throws instead of silently corrupting a
// generation that is already being hashed.
//
// WHY THIS IS STRUCTURAL, NOT A FIELD LIST: the previous code shallow-copied
// the two nesting levels it knew about at the time (`{...record}`, `tags.map(t
// => ({...t}))`), which left `tag.tagActivity`, `record.tags` and
// `masterFolder` aliased to live state. Profile records are deliberately "open
// shape" — they round-trip fields this version of the code has never heard of
// — so any snapshot built by enumerating today's known fields is guaranteed to
// rot the moment a nested field is added. This walks whatever is actually
// there.
//
// FUTURE / DO-NOT-BREAK: There must never be a second, slightly-different
// cloning implementation for Profile data. Anything that needs a detached
// Profile collection calls this. If a future field genuinely cannot survive a
// structured clone plus a JSON round-trip, that is a schema problem to solve at
// the schema, not by weakening this boundary — see the fidelity note on
// deepClone() below.

const FREEZE_FLAG = "__BG_SNAPSHOT_FREEZE__";

// Resolved lazily (not at module-evaluation time) so a test harness or a
// console session can opt in via globalThis.__BG_SNAPSHOT_FREEZE__ before the
// first snapshot is taken, without depending on module import order.
let freezeEnabled = null;

function detectFreezeDefault() {
  try {
    if (typeof globalThis[FREEZE_FLAG] === "boolean") return globalThis[FREEZE_FLAG];
  } catch {
    // Reading an exotic global can throw in some sandboxed contexts.
  }

  try {
    const location = globalThis.location;
    if (!location) return false; // non-browser (e.g. the Node test harness) — opt in explicitly
    const host = location.hostname;
    // Local development only. "" covers file:// origins.
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "";
  } catch {
    return false;
  }
}

export function isSnapshotFreezeEnabled() {
  if (freezeEnabled === null) freezeEnabled = detectFreezeDefault();
  return freezeEnabled;
}

/**
 * Forces deep-freezing on or off. Exists for the Stage B regression harness
 * (which must run the freeze path deterministically, with no browser globals
 * to detect) and for manual debugging from a console. Production code never
 * calls this — the detection above is what decides.
 */
export function setSnapshotFreezeEnabled(enabled) {
  freezeEnabled = Boolean(enabled);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// Fallback clone for environments without structuredClone, and for the (not
// expected in practice) case where structuredClone rejects a value. Handles
// cycles via `seen` for the same reason structuredClone does — an infinite
// recursion here would hang a sync pass rather than fail it.
//
// Anything that is neither a primitive, a plain object, nor an array is
// dropped rather than shared: returning the original reference would silently
// reintroduce exactly the aliasing this module exists to prevent, and that
// failure is invisible. A dropped field, by contrast, changes the fingerprint
// and is therefore caught loudly by read-back verification.
function manualClone(value, seen) {
  if (value === null || typeof value !== "object") return value;

  const existing = seen.get(value);
  if (existing) return existing;

  if (Array.isArray(value)) {
    const out = [];
    seen.set(value, out);
    for (const entry of value) out.push(manualClone(entry, seen));
    return out;
  }

  if (!isPlainObject(value)) return undefined;

  const out = {};
  seen.set(value, out);
  for (const key of Object.keys(value)) {
    const cloned = manualClone(value[key], seen);
    // Preserve an explicitly-undefined field; drop a field whose value could
    // not be cloned at all.
    if (cloned !== undefined || value[key] === undefined) out[key] = cloned;
  }
  return out;
}

// FIDELITY NOTE: structuredClone is preferred because it is native, fast,
// cycle-safe and preserves the value faithfully. It is deliberately NOT
// followed by a JSON normalization pass. Profile data is JSON-shaped by
// contract, so the two are identical in practice; if a future field ever holds
// something that survives a structured clone but not a JSON round-trip (a Date,
// say), the published generation will fail read-back verification and sync will
// stop with a truthful error — which is the correct outcome. Normalizing here
// instead would silently rewrite the user's data to make the hash agree.
function deepClone(value) {
  if (typeof structuredClone === "function") {
    try {
      return structuredClone(value);
    } catch {
      // Fall through — a non-cloneable value is handled by manualClone.
    }
  }
  return manualClone(value, new WeakMap());
}

function freezeDeep(value, seen) {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return value;
  seen.add(value);

  Object.freeze(value);

  if (Array.isArray(value)) {
    for (const entry of value) freezeDeep(entry, seen);
  } else {
    for (const key of Object.keys(value)) freezeDeep(value[key], seen);
  }
  return value;
}

/**
 * The one authoritative snapshot boundary for Profile data.
 *
 * Returns a value structurally identical to `value` that shares NO reference
 * with it, at any depth. In development the result is also deeply frozen, so
 * code that still holds a stale reference and tries to write through it fails
 * immediately and visibly instead of mutating a collection that is mid-publish.
 *
 * Deliberately cheap enough to sit on the ordinary mutation path: the previous
 * code already shallow-copied every record on every save, and this replaces
 * that copy rather than adding a pass to it.
 */
export function takeSnapshot(value) {
  const clone = deepClone(value);
  return isSnapshotFreezeEnabled() ? freezeDeep(clone, new WeakSet()) : clone;
}
