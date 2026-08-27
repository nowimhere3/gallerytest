// [STREAMLOOP-INTEGRATION / N6-6]
// BREADCRUMBS — IS: `launchContext` is the ONE explicit contract Browser
// Gallery honors for recognizing a StreamLoop launch — a `?launch=streamloop`
// query param, parsed once at boot from the URL the tab was actually opened
// with. Nothing else in the app is allowed to set it.
//
// [WHY: "Never infer StreamLoop merely because BG is inside an iframe" —
//  window.self !== window.top proves only that SOME page framed us; any site
//  can do that. Only an explicit, deliberately-configured launch contract may
//  identify a StreamLoop launch. See NORTH-STAR.md's Decision Ladder — proof
//  licenses action, and framing is not proof of identity.]
//
// Pure: no DOM beyond the `search` string handed in by the caller, no
// storage, no Math.random(). Exhaustively testable in Node.
export const LAUNCH_CONTEXT_BROWSER = "browser";
export const LAUNCH_CONTEXT_STREAMLOOP = "streamloop";

// BREADCRUMBS — WILL BE / FUTURE: `?launch=streamloop` is today's explicit
// launch contract. A future native StreamLoop host (WebView2 / WKWebView /
// Android WebView) may set the same param on its initial navigation rather
// than BG detecting a native host some other way. Keep launch-context
// recognition behind this one function — never derive it from window.top,
// referrer, user agent, or which runtime is hosting the page.
export function parseLaunchContext(search) {
  try {
    const raw = new URLSearchParams(search || "").get("launch");
    if (typeof raw === "string" && raw.trim().toLowerCase() === "streamloop") {
      return LAUNCH_CONTEXT_STREAMLOOP;
    }
  } catch {
    // Malformed query string — fall through to the safe default below.
  }
  return LAUNCH_CONTEXT_BROWSER;
}
