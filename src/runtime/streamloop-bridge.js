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
