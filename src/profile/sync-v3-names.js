// [SYNCV3 / STAGE-02 / CONTENT-ADDRESSED-DEVICE-DISCOVERY]
// [WHY: V3's core rule is NAMES DESCRIBE STATE, IDs DEFINE IDENTITY - and a rule
//  stated only in prose gets violated the first time somebody needs a quick
//  lookup. Putting every naming decision in one module with NO inverse function
//  is how the rule is enforced structurally: there is deliberately no
//  parseReadableName(), no extractIdFromName(), no way to go from a filesystem
//  string back to an id. Code that wants an identity has to read file CONTENT,
//  because this module offers it no alternative.]
//
// WHAT: the V3 human-readable naming rules - sanitization, the short display
// suffix, and deterministic collision-free name assignment.
//
// This file is PURE: no DOM, no IndexedDB, no FSA, no clock. Every function is a
// total function of its arguments, so the naming contract is fully testable
// without a filesystem.
//
// FUTURE / DO-NOT-BREAK: do not add a parser. If a later stage feels it needs
// one, the thing it actually needs is a declaration inside the manifest.

// The visual separator between the human part and the display suffix. Chosen to
// be readable at a glance and to survive every filesystem this app targets.
//
// [SYNCV3 / STAGE-02 / CONTENT-ADDRESSED-DEVICE-DISCOVERY]
// [WHY: a human name containing " -- " itself is deliberately NOT escaped. There
//  is nothing to protect: no code splits on this separator, because no code ever
//  recovers an id from a name. Escaping it would imply a parser exists, which is
//  precisely the belief this module is built to prevent.]
export const NAME_SEPARATOR = " -- ";

// Human portion caps. Both are enforced: code points keep the name sane to read,
// UTF-8 bytes keep it inside real filesystem limits, which count bytes rather
// than characters - a 64-character CJK or emoji name is well past 200 bytes.
const MAX_HUMAN_CHARS = 64;
const MAX_HUMAN_BYTES = 120;

// The default display-suffix length. Eight characters of a UUID is enough to
// tell two entries apart by eye without inviting anyone to treat it as an id.
export const DEFAULT_DISPLAY_ID_LENGTH = 8;

// Escalation ladder used when two entries would produce the same filename. Never
// affects identity - only how many characters of the (display-only) suffix are
// shown so a human can still tell the files apart.
const DISPLAY_ID_ESCALATION = [DEFAULT_DISPLAY_ID_LENGTH, 12, 16, 24, 32];

// [SYNCV3 / STAGE-02 / CONTENT-ADDRESSED-DEVICE-DISCOVERY]
// [WHY: an explicit, closed list rather than a generic "strip any leading
//  letters-and-a-dash" pattern. A generic rule silently mangles a real UUID that
//  happens to begin with hex letters - "deadbeef-..." would have its FIRST group
//  stripped and display its second, so two ids differing only in that group
//  would look identical in a directory listing. These are the only prefixes this
//  codebase's id generators actually produce.]
const KNOWN_ID_PREFIXES = ["dev-", "profile-", "sharedlib-"];

// Characters that are legal in Drive but hostile on a filesystem the folder may
// be synced down to. Replaced with a space rather than deleted so the remaining
// words stay separated and readable.
const HOSTILE_CHARACTERS = /[/\\:*?"<>|]/g;

// [SYNCV3 / STAGE-02 / CONTENT-ADDRESSED-DEVICE-DISCOVERY]
// [WHY: control characters are matched with an explicit code-point predicate
//  rather than a regex range. A range written as an escape is one transcription
//  slip away from embedding a real control byte in this source file, and such a
//  byte is invisible in every diff and review that would have to catch it. A
//  predicate says what it means in printable ASCII.]
function isControlCodePoint(code) {
  return code < 32 || code === 127;
}

function stripControlCharacters(text) {
  let out = "";
  for (const character of text) {
    if (!isControlCodePoint(character.codePointAt(0))) out += character;
  }
  return out;
}

function hasControlCharacters(text) {
  for (const character of text) {
    if (isControlCodePoint(character.codePointAt(0))) return true;
  }
  return false;
}

function utf8Length(text) {
  return new TextEncoder().encode(text).length;
}

// FNV-1a 32-bit, matching the fallback already used by legacy-library-signature.js.
// Only ever used to give an otherwise unprintable id SOME stable display suffix.
function fnv1a32(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Trims whitespace AND leading/trailing dots - see sanitizeHumanName. */
function trimEdges(text) {
  return text.replace(/^[\s.]+/, "").replace(/[\s.]+$/, "");
}

/**
 * Turns an arbitrary user-supplied string into a filesystem-safe, still-readable
 * name fragment.
 *
 * [SYNCV3 / STAGE-02 / CONTENT-ADDRESSED-DEVICE-DISCOVERY]
 * [WHY: sanitization deliberately REPLACES rather than strips-to-nothing. The
 *  product requirement is that a person can find their own device and Profile in
 *  a Drive listing; a rule that reduces "David's Laptop (work)" to "DavidsLaptop"
 *  or to a hash defeats the entire point of the readable-naming redesign. Spaces,
 *  apostrophes, parentheses and unicode all survive. Only genuinely dangerous
 *  characters are touched, and the two things that could change path SEMANTICS -
 *  separators, and leading/trailing dots - are removed rather than escaped,
 *  because an escaped separator is still a separator to some filesystem
 *  somewhere.]
 *
 * Unicode is normalized to NFC so the same name typed on macOS (which tends to
 * hand back NFD) and on Windows produces the same bytes. Nothing depends on that
 * agreement - names are not identity - but two directories differing only by
 * normalization form would be a confusing thing to hand a user.
 *
 * [SYNCV3 / STAGE-02B / REAL-DRIVE-PROBE-RESULTS]
 * [WHY: confirmed against real Google Drive through FSA. Spaces, apostrophes,
 *  parentheses, CJK, an astral-plane emoji and a full 64-character name all
 *  round-tripped BYTE FOR BYTE - created, enumerated, and reopened by exact
 *  name with contents intact. Drive performs no normalization of its own, so
 *  the NFC pass above is this app's choice alone and the caps below are
 *  comfortably inside what Drive accepts rather than at its limit.]
 */
export function sanitizeHumanName(
  raw,
  { fallback = "Unnamed", maxChars = MAX_HUMAN_CHARS, maxBytes = MAX_HUMAN_BYTES } = {}
) {
  if (typeof raw !== "string") return fallback;

  let text = raw;
  try {
    text = text.normalize("NFC");
  } catch {
    // A string that cannot be normalized is still usable; normalization is a
    // consistency nicety, never a correctness requirement.
  }

  text = stripControlCharacters(text);
  text = text.replace(HOSTILE_CHARACTERS, " ");
  text = text.replace(/\s+/g, " ");
  text = trimEdges(text);

  // Cap by code points first - [...text] iterates whole code points, so a
  // surrogate pair is never split into a lone half.
  const codePoints = [...text];
  if (codePoints.length > maxChars) text = codePoints.slice(0, maxChars).join("");

  // Then by UTF-8 bytes, dropping whole code points from the end.
  if (utf8Length(text) > maxBytes) {
    const remaining = [...text];
    while (remaining.length > 0 && utf8Length(remaining.join("")) > maxBytes) remaining.pop();
    text = remaining.join("");
  }

  // Truncation can expose a new trailing space or dot.
  text = trimEdges(text);

  return text || fallback;
}

/**
 * The DISPLAY-ONLY short form of an immutable id.
 *
 * [SYNCV3 / STAGE-02 / CONTENT-ADDRESSED-DEVICE-DISCOVERY]
 * [WHY: this return value must never be compared, keyed, deduplicated, merged,
 *  or used to establish ownership. It is lossy by construction - that is its
 *  entire purpose, and it is why the function is named for what it is FOR
 *  (display) rather than for what it does to the input (shorten). Identity comes
 *  from file content, always.]
 */
export function shortDisplayId(id, length = DEFAULT_DISPLAY_ID_LENGTH) {
  if (typeof id !== "string" || !id) return "unknown";

  let rest = id;
  for (const prefix of KNOWN_ID_PREFIXES) {
    if (rest.startsWith(prefix)) {
      rest = rest.slice(prefix.length);
      break;
    }
  }

  const compact = rest.replace(/[^0-9a-zA-Z]/g, "").toLowerCase();
  if (!compact) return fnv1a32(id);
  return compact.slice(0, Math.max(1, length));
}

/**
 * `<sanitized human name> -- <display id>`.
 *
 * The human portion is truncated when long; the suffix is never truncated, so a
 * very long name still ends in something a person can match against a diagnostic.
 */
export function buildReadableName(humanName, id, { fallback = "Unnamed", idLength = DEFAULT_DISPLAY_ID_LENGTH } = {}) {
  return `${sanitizeHumanName(humanName, { fallback })}${NAME_SEPARATOR}${shortDisplayId(id, idLength)}`;
}

/** buildReadableName with a .json extension - for Profile files. */
export function buildReadableFileName(humanName, id, options = {}) {
  return `${buildReadableName(humanName, id, options)}.json`;
}

/**
 * Structural backstop: a final path segment must be exactly one segment.
 *
 * [SYNCV3 / STAGE-02 / CONTENT-ADDRESSED-DEVICE-DISCOVERY]
 * [WHY: sanitizeHumanName already makes an escaping name impossible, so reaching
 *  this throw means something bypassed it - a hand-built name, a future caller, a
 *  manifest supplying its own string. Thrown rather than sanitized in place for
 *  the same reason assertOwnDeviceScope throws in V2: quietly repairing a path
 *  that should never have been malformed hides the bug that produced it, and this
 *  particular bug writes outside the device's own subtree.]
 */
export function assertSafePathSegment(segment, what = "path segment") {
  if (typeof segment !== "string" || !segment) {
    throw new Error(`[SYNCV3] Refusing to use an empty ${what}.`);
  }
  if (segment.includes("/") || segment.includes("\\")) {
    throw new Error(`[SYNCV3] Refusing to use a ${what} containing a path separator: "${segment}".`);
  }
  if (segment === "." || segment === "..") {
    throw new Error(`[SYNCV3] Refusing to use "${segment}" as a ${what}.`);
  }
  if (hasControlCharacters(segment)) {
    throw new Error(`[SYNCV3] Refusing to use a ${what} containing control characters.`);
  }
  return segment;
}

/**
 * Assigns a unique readable name to each entry, deterministically.
 *
 * [SYNCV3 / STAGE-02 / CONTENT-ADDRESSED-DEVICE-DISCOVERY]
 * [WHY: two Profiles genuinely may share a display name, and two different ids
 *  may share their first eight characters. Either way the names would collide and
 *  one file would silently overwrite the other - verified publish WOULD catch
 *  that as a hash mismatch, but a transport that only fails loudly on a nameable,
 *  preventable collision is worse than one that prevents it. The escalation
 *  lengthens the DISPLAY suffix for every entry at once rather than only the
 *  colliding pair, so the result depends solely on the input set and not on
 *  iteration order - two devices computing names for the same Profiles produce
 *  the same names.
 *
 *  Collision is checked case-INSENSITIVELY because Drive-backed folders are
 *  routinely synced onto case-insensitive filesystems, where "Beast -- ab" and
 *  "BEAST -- ab" are one file.]
 *
 * [SYNCV3 / STAGE-02B / REAL-DRIVE-PROBE-RESULTS]
 * [WHY: measured, not assumed - Google Drive through FSA reports itself
 *  case-SENSITIVE, so this check is not load-bearing against Drive itself. It is
 *  kept anyway and deliberately: a Drive folder is routinely mirrored onto
 *  Windows and macOS volumes that are case-insensitive, and the failure it
 *  guards against there is one file silently overwriting another. Being
 *  conservative costs a longer display suffix in a case that will essentially
 *  never arise; being permissive costs somebody's curation.]
 *
 * `entries` - [{ id, human }]. Returns Map<id, name>.
 */
export function assignUniqueReadableNames(entries, { fallback = "Unnamed", extension = "" } = {}) {
  const list = [...entries];

  for (const idLength of DISPLAY_ID_ESCALATION) {
    const names = new Map();
    const seen = new Set();
    let collided = false;

    for (const entry of list) {
      const name = `${buildReadableName(entry.human, entry.id, { fallback, idLength })}${extension}`;
      const key = name.toLowerCase();
      if (seen.has(key)) {
        collided = true;
        break;
      }
      seen.add(key);
      names.set(entry.id, name);
    }

    if (!collided) return names;
  }

  // Exhausted escalation: fall back to the whole id, sanitized for path safety.
  // Still display material - nothing reads it back - but guaranteed distinct,
  // because ids are distinct.
  const names = new Map();
  for (const entry of list) {
    const suffix = String(entry.id).replace(/[^0-9a-zA-Z-]/g, "") || fnv1a32(String(entry.id));
    names.set(entry.id, `${sanitizeHumanName(entry.human, { fallback })}${NAME_SEPARATOR}${suffix}${extension}`);
  }
  return names;
}
