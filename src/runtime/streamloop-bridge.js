// [STREAMLOOP-INTEGRATION / N6-6]
// BREADCRUMBS — IS: parses the exact postMessage shape StreamLoop's
// IntersectionObserver already sends per-panel (confirmed by reading
// js/launch.js in the read-only nowimhere3/GS3 reference repo):
// `iframe.contentWindow.postMessage({ type: "LAUNCHPAD_PLAY" | "LAUNCHPAD_PAUSE" }, '*')`.
// Only that exact object shape is accepted — there is no bare-string sender
// to accommodate, so none is accepted either. This module is pure: no
// `window`, no `postMessage` call of its own, no source/origin check (that
// needs `window` and lives in main.js). Exhaustively testable in Node.
export const STREAMLOOP_MESSAGE_PLAY = "LAUNCHPAD_PLAY";
export const STREAMLOOP_MESSAGE_PAUSE = "LAUNCHPAD_PAUSE";

// BREADCRUMBS — WILL BE / FUTURE: LAUNCHPAD_PLAY/LAUNCHPAD_PAUSE are today's
// iframe-postMessage contract. A future native host is not guaranteed to use
// postMessage at all — keep the accepted intents ("play"/"pause") decoupled
// from the transport that carries them, so a future native bridge can drive
// the same play/pause intents without this module's parsing logic changing
// shape. A LAUNCHPAD_READY acknowledgement is deliberately not built yet:
// GS3's IntersectionObserver fires PLAY/PAUSE purely off panel visibility and
// does not wait for or expect a reply, and adding one would require a GS3
// change, which is out of scope for this slice.
export function parseStreamLoopMessage(data) {
  if (!data || typeof data !== "object") return null;
  if (data.type === STREAMLOOP_MESSAGE_PLAY) return "play";
  if (data.type === STREAMLOOP_MESSAGE_PAUSE) return "pause";
  return null;
}

// [WHY: the latest intent always wins — this alone is what makes a PAUSE
//  arriving before BG is media-ready supersede an earlier pending PLAY, with
//  no special-cased "unless it was a pause" branch anywhere. Overwriting the
//  pending intent on every pre-readiness message is the entire rule.]
export function nextPendingIntent(intent) {
  return intent === "play" || intent === "pause" ? intent : null;
}

// The host owns generation freshness; echo opaque strings unchanged.
export function createGalleryCapabilityResponse(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  if (data.source !== "gs3-capability-bridge" || data.version !== 1 ||
      data.type !== "QUERY_CAPABILITY" || data.capability !== "GALLERY_FAVORITE" ||
      typeof data.generation !== "string") return null;
  return {
    source: "gs3-capability-bridge",
    version: 1,
    type: "CAPABILITY_PRESENT",
    capability: "GALLERY_FAVORITE",
    generation: data.generation,
    features: ["favoriteCurrent", "favoriteState", "keyForward"],
  };
}

// [S9B-A / SHORTCUT KEY FORWARDING]
// IS: the ONE table of candidate shortcut codes. Gallery forwards raw key INTENT
// only (KeyboardEvent.code); the trusted parent alone decides presets, physical
// Positions, Slots and Panels. Keep this table here and nowhere else.
export const SHORTCUT_KEY_CODES = Object.freeze(new Set([
  "Digit1", "Digit2", "Digit3", "Digit4", "KeyZ", "KeyX", "KeyC", "KeyV",
  "KeyM", "Comma", "Period", "Slash",
]));

const EDITABLE_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);
const EDITABLE_ROLES = new Set(["textbox", "combobox", "searchbox", "spinbutton"]);

function isEditableNode(node) {
  if (!node || typeof node !== "object") return false;
  if (node.isContentEditable === true) return true;
  if (typeof node.tagName === "string" && EDITABLE_TAGS.has(node.tagName.toUpperCase())) return true;
  const getAttribute = typeof node.getAttribute === "function" ? (name) => node.getAttribute(name) : () => null;
  const editable = getAttribute("contenteditable");
  if (editable !== null && editable !== undefined && String(editable).toLowerCase() !== "false") return true;
  const role = getAttribute("role");
  return typeof role === "string" && role.split(/\s+/).some((token) => EDITABLE_ROLES.has(token.toLowerCase()));
}

// Walks the composed path (crosses shadow roots) plus target as a fallback.
export function isEditableShortcutTarget(event) {
  let path = [];
  try { path = typeof event.composedPath === "function" ? event.composedPath() : []; } catch { path = []; }
  if (!Array.isArray(path) || !path.length) path = [event.target];
  return path.some(isEditableNode);
}

// Returns the approved KeyboardEvent.code, or null if this keydown must not be forwarded.
export function getShortcutKeyCode(event) {
  if (!event || typeof event !== "object") return null;
  if (typeof event.code !== "string" || !SHORTCUT_KEY_CODES.has(event.code)) return null;
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return null;
  if (event.repeat || event.isComposing || event.defaultPrevented) return null;
  if (isEditableShortcutTarget(event)) return null;
  return event.code;
}

// [S7A / LIVE CURRENT FAVORITE STATE]
// IS: Gallery is the authority on whether the CURRENT item is favorited. This
// publisher tells the trusted parent, so the parent never has to guess from its
// own FAVORITE_CURRENT presses. It owns only ephemeral, in-memory session state:
// the latest accepted host generation (opaque, never generated here), the
// reply target, and the last published fingerprint. Nothing is persisted.
// Truth comes from the projected Profile view (same semantics as Gallery's own
// heart), never from a possibly stale copied item.isFavorite.
// mediaKey is a session-local opaque counter token: item ids and relativePaths
// embed file names / folder structure, so neither is exposed.
// WHY a microtask coalesce for runtime emissions: reloadRuntime() calls
// runtime.load() (index 0) then setCurrentIndex(preserved) synchronously, so
// without it the parent would briefly be told about the wrong item.
export function createCurrentFavoriteStatePublisher(runtime, profileView) {
  let session = null; // { generation, parent, targetOrigin }
  let lastFingerprint = null;
  let flushQueued = false;
  let nextKey = 1;
  const keys = new WeakMap();

  function mediaKeyFor(item) {
    let key = keys.get(item);
    if (!key) { key = `m${nextKey++}`; keys.set(item, key); }
    return key;
  }

  function readState() {
    const item = runtime.getCurrentItem();
    const path = item?.relativePath;
    // Same "has media" predicate as FAVORITE_CURRENT, so the two never disagree.
    if (typeof path !== "string" || !path.trim()) {
      return { hasMedia: false, mediaKey: null, isFavorite: false };
    }
    return { hasMedia: true, mediaKey: mediaKeyFor(item), isFavorite: profileView.isFavorite(path) === true };
  }

  function publish() {
    if (!session) return;
    let state;
    try { state = readState(); } catch { return; } // never publish a guess
    const fingerprint = JSON.stringify([session.generation, state.hasMedia, state.mediaKey, state.isFavorite]);
    if (fingerprint === lastFingerprint) return;
    lastFingerprint = fingerprint;
    try {
      session.parent.postMessage({
        source: "gs3-capability-bridge", version: 1, type: "CURRENT_FAVORITE_STATE",
        capability: "GALLERY_FAVORITE", generation: session.generation, ...state,
      }, session.targetOrigin);
    } catch { /* a dead parent must never break Gallery */ }
  }

  return {
    // Call only after a valid, trusted GALLERY_FAVORITE QUERY_CAPABILITY.
    // Every accepted query yields exactly one fresh snapshot.
    establish(generation, parent, targetOrigin) {
      session = { generation, parent, targetOrigin };
      lastFingerprint = null;
      publish();
    },
    // [S9B-A] Forward one approved key code to the trusted parent using the
    // already-accepted generation and reply target. Silent before a handshake.
    // Pure signal: no favorite write, no Position/Slot/media fields.
    forwardShortcutKey(code) {
      if (!session || !SHORTCUT_KEY_CODES.has(code)) return false;
      try {
        session.parent.postMessage({
          source: "gs3-capability-bridge", version: 1, type: "SHORTCUT_KEY",
          capability: "GALLERY_FAVORITE", generation: session.generation, code,
        }, session.targetOrigin);
        return true;
      } catch { return false; }
    },
    // Wire to runtime.subscribe(): covers navigation, clear, and every
    // profile/alias projection change. Duplicates are dropped by fingerprint.
    refresh() {
      if (!session || flushQueued) return;
      flushQueued = true;
      queueMicrotask(() => { flushQueued = false; publish(); });
    },
  };
}

// Pure envelope parsing: never execute malformed requests or retain correlation IDs.
export function parseFavoriteCurrent(data) {
  if (!data || typeof data !== "object" || Array.isArray(data) ||
      data.source !== "gs3-capability-bridge" || data.version !== 1 ||
      data.type !== "FAVORITE_CURRENT" || data.capability !== "GALLERY_FAVORITE" ||
      typeof data.generation !== "string" || typeof data.requestId !== "string") return null;
  return { generation: data.generation, requestId: data.requestId };
}

export async function executeFavoriteCurrent(command, runtime, profileView, settleLocal) {
  let status = "unavailable";
  try {
    const item = runtime.getCurrentItem();
    const path = item?.relativePath;
    if (typeof path !== "string" || !path.trim()) status = "no-media";
    else if (profileView.isFavorite(path)) status = "already-favorite";
    else {
      profileView.setFavorite(path, true);
      await settleLocal();
      status = "favorited";
    }
  } catch {
    status = "unavailable";
  }
  return {
    source: "gs3-capability-bridge", version: 1, type: "FAVORITE_RESULT",
    capability: "GALLERY_FAVORITE", generation: command.generation,
    requestId: command.requestId, status,
  };
}
