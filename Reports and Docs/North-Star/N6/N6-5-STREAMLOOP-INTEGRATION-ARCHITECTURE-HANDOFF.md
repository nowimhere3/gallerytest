# N6-5 — BG ↔ StreamLoop Integration (Architecture Handoff)

**Thursday, August 27, 2026 — 3:34 PM MDT** (America/Edmonton)

**Role:** architecture handoff for the implementer. Not an implementation.
**Baseline:** branch `SandboxSyncV3`, HEAD `1badbf6` ("Add North Star N6 startup media policies"),
worktree clean.
**Constitution:** `Reports and Docs/NORTH-STAR.md` — it outranks this document.
**Builds on:** `N6-3-STARTUP-MEDIA-ARCHITECTURE-HANDOFF.md` / `N6-4-IMPLEMENTATION-REPORT.md` — this
slice cashes in the `context` seam N6-4 deliberately left unused, and the FUTURE breadcrumb on
`decideStartupMedia()` that named exactly this moment.

**Scope discipline: Browser Gallery only.** The StreamLoop reference repo (`nowimhere3/GS3`) was
read for evidence, never for a change target. `js/launch.js` was fetched directly to confirm the
exact message contract rather than guessing it — see Part 3. Nothing in GS3 is touched by this
handoff or should be touched by its implementation.

---

## Part 1 — Explicit StreamLoop launch context

### The contract

```text
?launch=streamloop   →  launchContext = "streamloop"
(anything else)      →  launchContext = "browser"
```

Case-insensitive on the value only (`Streamloop`, `STREAMLOOP` all match); the param name itself
(`launch`) is exact. Missing, empty, misspelled (`streemloop`), or any other value: `"browser"`.
Malformed query strings must never throw — `URLSearchParams` already tolerates malformed input, so
no extra guarding is needed beyond a defensive `try/catch` around the parse.

### Where it's parsed

New tiny pure module, **`src/runtime/launch-context.js`** — same shape as
`shuffle-selector.js`/`micro-arcade-selector.js`: no DOM, no I/O, exhaustively testable in Node.

```js
export const LAUNCH_CONTEXT_BROWSER = "browser";
export const LAUNCH_CONTEXT_STREAMLOOP = "streamloop";

export function parseLaunchContext(search) {
  try {
    const raw = new URLSearchParams(search || "").get("launch");
    if (typeof raw === "string" && raw.trim().toLowerCase() === "streamloop") {
      return LAUNCH_CONTEXT_STREAMLOOP;
    }
  } catch {
    // malformed query string — fall through to the safe default
  }
  return LAUNCH_CONTEXT_BROWSER;
}
```

`main.js` calls this **once**, near the top of the module (before `applyLoadedPreferences()` and
well before `initFsaLibraries()`), and keeps the result in a `const launchContext = ...`.

### Runtime-only — never persisted

`launchContext` is a plain module-scope constant. It is never written to `app-preferences.js`,
never stored in IndexedDB, never round-tripped through `normalizeRecord()`. Every page load
re-derives it from the URL the tab was actually opened with. This is deliberate: a StreamLoop panel
is reloaded/hotswapped by the GS3 side constantly (⟳ reload, 🎲 shuffle, position swap all rebuild
or repoint the iframe), and each of those is a fresh navigation carrying its own query string — there
is no "session" for this fact to leak across, and persisting it would let a context from one launch
silently survive into an unrelated later one opened without the param.

### Critical rule, restated as code discipline

> **Never infer StreamLoop merely because BG is inside an iframe.**

`window.self !== window.top` must not appear anywhere in this feature's logic. `launchContext` is
the **only** thing every other piece of this handoff is allowed to key off of. This is exactly the
discipline N6-3 already wrote into `decideStartupMedia()`'s own breadcrumb — this slice is where
that promise gets cashed in, not renegotiated.

### How a StreamLoop launch actually happens

Confirmed by reading `js/launch.js` in the GS3 reference repo: `_buildPanel()` sets
`iframe.src = url` directly from whatever URL is stored in that folder's link database — GS3 has
no BG-specific knowledge and does not append anything to the URL itself. **The `?launch=streamloop`
param is exercised by the customer (or an automation) configuring a panel's URL in GS3 to already
include it** — e.g. `https://my-browser-gallery.example/?launch=streamloop` saved as a Playlist
entry or folder link. This is data GS3 stores, not code GS3 runs, and needs no GS3 change.

### Feeds two things, nothing else

1. **Which dual-context Startup Media preference section is consulted at boot** — Part 2.
2. **Whether the PLAY/PAUSE `message` listener is registered at all** — Part 3.

No STREAM/GRID distinction. GS3's `launchMatrix()`/`buildStreamPanel()` are the same builder for
both `index.html` and `index3.html` per the reference repo — BG has no reason to know or care which
one embedded it, and no BG decision in this handoff depends on that distinction.

---

## Part 2 — Dual startup preference

### State shape (extends the N6-4 shape, doesn't replace its meaning)

`app-preferences.js`'s `startup` section becomes two independent policy records, keyed by launch
context:

```js
const DEFAULT_STARTUP_POLICY = {
  policy: "last-used",     // "last-used" | "random-remembered" | "random-selected"
  eligibleLibraryIds: [],  // only meaningful for random-selected — own pool per context
};

const DEFAULT_STARTUP = {
  browser: { ...DEFAULT_STARTUP_POLICY },
  streamloop: { ...DEFAULT_STARTUP_POLICY },
};
```

Each side normalizes with the **exact same** `startupPolicy()` / `normalizeStartupEligibleLibraryIds()`
helpers N6-4 already wrote — reuse them per-context, do not fork a second copy.

### Migration

A record written by N6-4 stores `startup: { policy, eligibleLibraryIds }` directly (no `browser`/
`streamloop` keys). Detect that legacy shape and migrate it **once, on read, non-destructively**:

```js
function normalizeStartupSection(value) {
  return {
    policy: startupPolicy(value?.policy),
    eligibleLibraryIds: normalizeStartupEligibleLibraryIds(value?.eligibleLibraryIds),
  };
}

function normalizeStartupContexts(startupSource) {
  const isLegacyShape =
    startupSource && typeof startupSource === "object" &&
    !("browser" in startupSource) && !("streamloop" in startupSource) &&
    ("policy" in startupSource || "eligibleLibraryIds" in startupSource);

  if (isLegacyShape) {
    // [WHY: a customer's existing N6-4 choice was made without StreamLoop in
    //  mind at all — it becomes their Normal Browser Gallery policy verbatim.
    //  StreamLoop starts at "last-used"/empty, the same safe default every
    //  fresh preference gets, never inherited from the browser side.]
    return { browser: normalizeStartupSection(startupSource), streamloop: normalizeStartupSection(undefined) };
  }

  return {
    browser: normalizeStartupSection(startupSource?.browser),
    streamloop: normalizeStartupSection(startupSource?.streamloop),
  };
}
```

`normalizeRecord()`'s `startup:` field becomes `normalizeStartupContexts(startupSource)`. Nothing
else in `normalizeRecord()` changes. **No IndexedDB `DATABASE_VERSION` bump** — same reasoning
`autoplayOnFill` already documents at the top of this file: the object store's shape hasn't changed,
only the record's, and every record is reshaped on every read.

### Persistence — the one real gotcha

`savePartial(section, partial)` only merges **one level deep** (`{...current[section], ...partial}`).
Passed a `browser`/`streamloop` sub-object directly as `partial`, it would **replace that whole
sub-object**, dropping whichever of `policy`/`eligibleLibraryIds` the caller didn't include — silently
clobbering the sibling field within the SAME context, not just the sibling context. `saveStartupPreferences`
must therefore do its own two-level read-merge instead of delegating to `savePartial`:

```js
export function saveStartupPreferences(context, partial) {
  const key = context === "streamloop" ? "streamloop" : "browser";
  return enqueueWrite(async () => {
    try {
      const database = await openDatabase();
      try {
        const current = await readCurrentRecord(database);
        const merged = normalizeRecord({
          ...current,
          startup: { ...current.startup, [key]: { ...current.startup[key], ...partial } },
        });
        await writeRecord(database, merged);
        return merged;
      } finally {
        database.close();
      }
    } catch (error) {
      console.warn(`[app-preferences] Could not save startup (${key}) preferences.`, error);
      return null;
    }
  });
}
```

This still goes through `enqueueWrite`, so it still serializes against every other preference write
exactly as before. `context` here is a plain string param the **caller** (main.js) passes — it is
`"browser"` or `"streamloop"` literally, never `launchContext` reinterpreted; a customer editing
Advanced Settings from an ordinary browser tab must be able to set the StreamLoop pool too.

### Separate folder-pool semantics

- `eligibleLibraryIds` lives independently under `.browser` and `.streamloop`. Checking a folder for
  one context never touches the other's set. This is the "strong product preference" stated
  verbatim in the task — not a UI nicety, a data-shape decision.
- Same stale-id tolerance N6-4 already established, per context: an id that stops matching a
  `listLibraries()` row is simply skipped at decision time, never eagerly pruned from either set.
- Both pools draw from the same underlying population (`listLibraries()`'s remembered durable FSA
  rows) — there is one Recents list, just two independent subsets a customer can draw from it.

### `decideStartupMedia()` — unchanged, deliberately

N6-4's pure decision function (`boot-restore.js`) keeps its existing signature and its existing 61
assertions untouched. It stays single-policy-in, single-decision-out. **`main.js` resolves which
context's `{policy, eligibleLibraryIds}` to hand it, before calling it** — the dual-context branch
happens one level up, at the boundary that already knows `launchContext`. This is the same
reasoning N6-4 itself used to keep `decideBootRestore()` untouched: don't grow a well-tested pure
function's contract when the boundary can carry the new decision instead.

```js
const activeStartup = currentStartupPreferences[
  launchContext === LAUNCH_CONTEXT_STREAMLOOP ? "streamloop" : "browser"
];
const decision = decideStartupMedia({
  policy: activeStartup.policy,
  rows,
  permissionStates,
  eligibleIds: activeStartup.eligibleLibraryIds,
});
```

The `context` parameter `decideStartupMedia()` already accepts stays exactly as N6-4 left it —
accepted, defaulted to `"browser"`, unused inside the function. Do not wire it now; the caller-side
resolution above is where this slice's actual decision lives.

### Permission behaviour — unchanged from N6/N6-4

`queryPermission({ mode: "read" })` only, never `requestPermission` at boot, under either context.
Only `"granted"` folders are ever eligible for either pool. If StreamLoop's pool resolves to nothing
eligible, BG does nothing at boot — same "no restore, no ceremony" outcome as the browser side.

### UI shape

Inside the existing single `.advanced-startup-media-section` `<details>` — **do not add a second
nested disclosure**; both blocks live under the one "Startup Media" summary, matching the mockup in
the task and keeping the disclosure count at four (Feature 5 stays "no redesign"):

```text
▸ Startup Media
    Normal Browser Gallery
    [ policy select ]
    (eligible checkbox list — shown only when policy = random-selected)

    When launched by StreamLoop
    [ policy select ]
    (eligible checkbox list — shown only when policy = random-selected)
```

New/renamed ids (the existing N6-4 ids are renamed with a `-browser-` segment; StreamLoop's mirror
them exactly):

| Browser (renamed from N6-4) | StreamLoop (new) |
| --- | --- |
| `#startup-media-browser-policy-select` | `#startup-media-streamloop-policy-select` |
| `#startup-media-browser-policy-helper` | `#startup-media-streamloop-policy-helper` |
| `#startup-media-browser-eligible-section` | `#startup-media-streamloop-eligible-section` |
| `#startup-media-browser-eligible-empty` | `#startup-media-streamloop-eligible-empty` |
| `#startup-media-browser-eligible-list` | `#startup-media-streamloop-eligible-list` |

`renderStartupMediaSettings()` becomes `renderStartupMediaSettings(context)`, called twice (once per
context) from the same place N6-4 already calls it (end of `renderRecentLibraries()`), reading/
writing `currentStartupPreferences[context]` and calling `saveStartupPreferences(context, partial)`.
`currentStartupPreferences` itself becomes `{ browser: {...}, streamloop: {...} }`, seeded from
`preferences.startup` in `applyLoadedPreferences()` exactly as before — just no longer a single flat
object.

**Both blocks are always visible and editable**, regardless of the current tab's `launchContext`. A
customer configuring the StreamLoop pool almost always does it from an ordinary browser tab, not
from inside an active StreamLoop panel — `launchContext` governs which pool is *consulted at boot*,
never which pool is *shown in Advanced Settings*.

---

## Part 3 — Runtime PLAY / PAUSE contract

### Confirmed message shape (read directly from `js/launch.js` in the GS3 reference repo)

```js
// GS3's IntersectionObserver, per iframe panel, threshold 0.5:
iframe.contentWindow.postMessage({ type: msg }, '*');
// msg is exactly the string "LAUNCHPAD_PLAY" or "LAUNCHPAD_PAUSE"
```

This fires **repeatedly** as a panel scrolls in and out of the 50% visibility threshold — not once.
`runtime.play()`/`runtime.stop()` are already idempotent no-ops when already in that state (see
`media-runtime.js`'s `play()`/`stop()` early returns), so no debouncing is needed on BG's side.

GS3 posts with target origin `'*'` — it does not restrict where the message can go, and it has no
fixed origin of its own to validate against (self-hosted, dev/staging/prod all differ). Origin
string validation is therefore not a meaningful security boundary here — see Validation below for
what BG checks instead.

### Accepted message shape — pure, testable

New tiny module, **`src/runtime/streamloop-bridge.js`**:

```js
export const STREAMLOOP_MESSAGE_PLAY = "LAUNCHPAD_PLAY";
export const STREAMLOOP_MESSAGE_PAUSE = "LAUNCHPAD_PAUSE";

// Pure. Only the exact object shape GS3 actually sends is accepted — no bare
// string fallback, since none exists in the real sender. Extra unrelated
// fields on the object are tolerated (StreamLoop may add fields later);
// only `type` is examined.
export function parseStreamLoopMessage(data) {
  if (!data || typeof data !== "object") return null;
  if (data.type === STREAMLOOP_MESSAGE_PLAY) return "play";
  if (data.type === STREAMLOOP_MESSAGE_PAUSE) return "pause";
  return null;
}

// Pure. The latest intent always wins — this alone is what makes a PAUSE
// arriving before readiness supersede an earlier pending PLAY, with no
// special-cased "unless it was a pause" branch anywhere.
export function nextPendingIntent(intent) {
  return intent === "play" || intent === "pause" ? intent : null;
}
```

### Source validation (not origin-string validation)

Structural, in `main.js` (needs `window`, so not part of the pure module):

```js
function isTrustedStreamLoopSource(event) {
  return event.source != null && event.source === window.parent && event.source !== window;
}
```

This accepts a message only from the window that is actually framing this tab — the caller GS3
itself put us inside — and rejects everything else, including a message BG might somehow receive
from itself or from an unrelated window. It requires no knowledge of GS3's deployed origin, which
BG cannot know in general (self-hosted GS3 has no fixed origin), and it costs nothing extra since
GS3 already sends with `'*'` and cannot be made to pin an origin without a GS3 change, which is out
of scope.

### Readiness

**`state.hasVisibleItems`** — not `hasItems`. This is not a new concept: it's the exact condition
`main.js` already uses to enable the manual Play button (`canNavigate = state.hasVisibleItems` at
`main.js:8415`, `playBtn.disabled = !canNavigate && !state.isPlaying` at `main.js:8426`). A StreamLoop
PLAY command should become honorable at precisely the moment a human clicking Play would no longer
be disabled — reusing that condition instead of inventing "media-ready" as a new idea.

### Pending-intent lifecycle

```js
let streamLoopPendingIntent = null;
let streamLoopReady = false;

function applyStreamLoopIntent(intent) {
  if (intent === "play") runtime.play();
  else if (intent === "pause") runtime.stop();
}

window.addEventListener("message", (event) => {
  if (!isTrustedStreamLoopSource(event)) return;
  const intent = parseStreamLoopMessage(event.data);
  if (!intent) return;
  if (streamLoopReady) applyStreamLoopIntent(intent);
  else streamLoopPendingIntent = nextPendingIntent(intent);
});

runtime.subscribe((state) => {
  if (streamLoopReady || !state.hasVisibleItems) return;
  streamLoopReady = true;
  if (streamLoopPendingIntent) applyStreamLoopIntent(streamLoopPendingIntent);
  streamLoopPendingIntent = null;
});
```

Registered **only when `launchContext === LAUNCH_CONTEXT_STREAMLOOP`** — ordinary browser tabs never
add this listener at all, so there is no dormant surface for a normal customer session. Place the
registration after `runtime` exists (same general area as the `beforeunload` listener), guarded by
a single `if (launchContext === LAUNCH_CONTEXT_STREAMLOOP) { ... }` block.

`runtime.subscribe()` calls its listener immediately with current state on registration (see
`media-runtime.js`'s `subscribe()`) — if the runtime somehow already has visible items at the moment
this subscriber attaches, readiness resolves immediately with an empty pending intent. No special
handling needed; it falls out of the existing subscribe contract.

### Exact BG seams reused, nothing new invented

- `runtime.play()` / `runtime.stop()` — the identical calls `togglePlay()` (`main.js:7482`) already
  makes. A StreamLoop PLAY/PAUSE is indistinguishable, downstream, from a human click: the same
  `runtime.subscribe(render)` repaint, the same `syncPlayPauseButton()`, the same waiting-on-video
  handling.
- `state.hasVisibleItems` — the same field `canNavigate` already reads for the Play button's own
  enabled/disabled state.
- `runtime.subscribe()` — the same subscription mechanism `render` and
  `handlePendingFilterReloadOnAdvance` already use; this is a third subscriber, not a new mechanism.

### READY acknowledgement

**Not built now.** GS3's `IntersectionObserver` fires PLAY/PAUSE purely off panel visibility — it
does not wait for or expect any reply, and changing that would be a GS3 change, out of scope. A
future `LAUNCHPAD_READY` message BG could send back (so GS3 could stop re-sending redundant PLAYs to
a panel it already knows is ready, or surface a loading state) is a genuine future idea, but it is a
**two-way protocol change requiring a GS3-side change to consume it**, which this slice does not
make. Leave a `BREADCRUMBS — WILL BE / FUTURE` at `streamloop-bridge.js` naming this and stop there.

---

## Part 4 — Future Native StreamLoop breadcrumb

The truth to protect:

> **StreamLoop panels are independently controllable media surfaces. iframe is today's
> implementation of that surface, not the definition of it.**

BG holds the *consumer* side of this truth, not the surface itself — BG never constructs an iframe
of itself; GS3 does. What BG must protect is the assumption on **its own** side: that "an authorized
StreamLoop launch/runtime context" is defined by the explicit contract this handoff builds
(`?launch=streamloop` + the `LAUNCHPAD_PLAY`/`LAUNCHPAD_PAUSE` message contract), never by detecting
that it happens to be framed. That is precisely what makes a future native surface (WebView2/
WKWebView/Android WebView) a non-event for BG: if native StreamLoop ever hosts BG in a native
WebView instead of a browser iframe, the *same* explicit contract can be honored there — a native
host can set the same query param on its initial navigation and post the same two message strings —
without BG's own logic changing at all, because BG's logic never depended on "iframe" in the first
place.

Two `BREADCRUMBS — WILL BE / FUTURE` blocks, both small:

**`src/runtime/launch-context.js`** (primary — this is the seam that would have to change if BG ever
needed to recognize a launch through a different mechanism):

```text
BREADCRUMBS — WILL BE / FUTURE: `?launch=streamloop` is today's explicit launch contract. A future
  native StreamLoop host (WebView2 / WKWebView / Android WebView) may set the same param on its
  initial navigation rather than BG detecting a native host some other way. Keep launch-context
  recognition behind this one function — never derive it from window.top, referrer, user agent, or
  which runtime is hosting the page.
```

**`src/runtime/streamloop-bridge.js`** (the message contract mirrors it):

```text
BREADCRUMBS — WILL BE / FUTURE: LAUNCHPAD_PLAY/LAUNCHPAD_PAUSE are today's iframe-postMessage
  contract. A future native host is not guaranteed to use postMessage at all — keep the accepted
  intents ("play"/"pause") decoupled from the transport that carries them, so a future native
  bridge can call applyStreamLoopIntent()'s equivalent without this module's parsing logic
  changing shape. A LAUNCHPAD_READY acknowledgement is deliberately not built yet — see Part 3.
```

Do not build anything toward native now. No WebView prototype, no abstraction layer beyond what's
already here. The two breadcrumbs above are the entire deliverable for Part 4 — they exist so a
future agent reads *why* `launch-context.js` and `streamloop-bridge.js` are shaped as narrowly as
they are, not as a plan to act on.

---

## Part 5 — Advanced Settings spacing fix

`styles.css:298`:

```css
.advanced-settings-section > details:first-of-type {
  margin-top: 0;
}
```

This zeroes the gap between "Advanced Settings" and its first nested disclosure ("Media Library
diagnostics" today; whichever section is first in the future). Change the value to a small nonzero
amount — `12px` reads as "a little more," not a redesign, and stays well under the `20px` the rule
already uses for every other nested `<details>`'s `margin-top`/`margin-bottom`:

```css
.advanced-settings-section > details:first-of-type {
  margin-top: 12px;
}
```

This is already the **structural** fix the task asks for: the rule targets `:first-of-type`
generically, so if a future section is ever reordered to be first, it inherits this spacing
automatically with no per-element change. No other rule in this block needs to move.

---

## Likely files

| File | Change |
| --- | --- |
| `src/runtime/launch-context.js` | **New.** `parseLaunchContext()`, `LAUNCH_CONTEXT_BROWSER`/`LAUNCH_CONTEXT_STREAMLOOP`, FUTURE breadcrumb |
| `src/runtime/streamloop-bridge.js` | **New.** `parseStreamLoopMessage()`, `nextPendingIntent()`, message constants, FUTURE breadcrumb |
| `src/storage/app-preferences.js` | `DEFAULT_STARTUP` → dual-context shape, `normalizeStartupContexts()` + migration, rewritten `saveStartupPreferences(context, partial)` |
| `src/storage/boot-restore.js` | **No change.** `decideStartupMedia()`'s signature and tests stay exactly as N6-4 shipped them |
| `src/main.js` | `launchContext` computed at boot; `attemptStartupMedia()` resolves the active context's policy before calling `decideStartupMedia()`; `currentStartupPreferences` becomes `{browser, streamloop}`; `renderStartupMediaSettings(context)` called twice; policy-select/checkbox handlers become context-aware; new gated `message` listener + `streamLoopReady`/`streamLoopPendingIntent` wiring |
| `index.html` | Startup Media disclosure gets two labeled sub-blocks (Normal Browser Gallery / When launched by StreamLoop) with the renamed/new ids in Part 2's table |
| `styles.css` | `.advanced-settings-section > details:first-of-type` margin-top `0` → `12px`; minor layout for the two new sub-block labels (reuse existing `.hint`/heading patterns, no new visual language) |
| `tools/test-startup-media.mjs` | Existing DOM/id assertions updated for the renamed browser-context ids; existing decision-table assertions against `decideStartupMedia()` itself need **no changes** |

## Out of scope, confirmed by this handoff

- Any GS3/`nowimhere3/GS3` modification, including anything that would make GS3 append the launch
  param automatically or send a fixed-origin message
- Replacing, wrapping, or refactoring GS3's iframes; no native/WebView prototype
- Inferring StreamLoop from `window.top`/`window.self`, referrer, or user agent, anywhere
- STREAM vs GRID distinction inside BG
- A `LAUNCHPAD_READY` acknowledgement message (breadcrumbed as future only)
- Any messaging protocol beyond `LAUNCHPAD_PLAY`/`LAUNCHPAD_PAUSE` — no volume, seek, next/prev,
  metadata, or any other StreamLoop→BG or BG→StreamLoop message
- StreamLoop controlling Curation in any way
- Loading more than one folder at startup, under either context
- SyncV3 / MEDIA-ID / identity changes of any kind
- Migrating an existing customer's browser-context policy value into the StreamLoop context (it
  starts fresh at `last-used`/empty, per Part 2's migration rule)
- A redesign of Advanced Settings beyond the two labeled sub-blocks and the one-line spacing fix

---

## Deterministic tests

**New — `tools/test-launch-context.mjs`** (pure, no DOM):

| Case | Expected |
| --- | --- |
| `?launch=streamloop` | `"streamloop"` |
| `?launch=STREAMLOOP` / `?launch=StreamLoop` | `"streamloop"` (value is case-insensitive) |
| `?launch=streemloop` (typo) | `"browser"` |
| no query string / empty string / `undefined` | `"browser"` |
| `?foo=bar` (unrelated param, no `launch`) | `"browser"` |
| `?launch=` (present, empty value) | `"browser"` |
| `?launch=streamloop&launch=browser` (duplicate param) | first occurrence wins (`URLSearchParams` default) — assert whichever `"streamloop"` actually resolves to, and pin it |
| malformed query string that would throw naively | `"browser"`, no throw |

**New — `tools/test-streamloop-bridge.mjs`** (pure, no DOM):

| Case | Expected |
| --- | --- |
| `{ type: "LAUNCHPAD_PLAY" }` | `"play"` |
| `{ type: "LAUNCHPAD_PAUSE" }` | `"pause"` |
| `{ type: "LAUNCHPAD_PLAY", extra: 1 }` | `"play"` (extra fields tolerated) |
| `{ type: "SOMETHING_ELSE" }` | `null` |
| bare string `"LAUNCHPAD_PLAY"` | `null` (no bare-string fallback — GS3 never sends one) |
| `null` / `undefined` / `42` / `[]` | `null`, no throw |
| `nextPendingIntent("play")` / `("pause")` | `"play"` / `"pause"` |
| `nextPendingIntent("anything else")` | `null` |

**`tools/test-startup-media.mjs` (extended):**

- Preferences round-trip for the **dual** shape: saving `streamloop`'s policy leaves `browser`
  untouched and vice versa; saving `eligibleLibraryIds` for one context leaves the other context's
  `policy` untouched (the two-level-merge gotcha from Part 2).
- Migration: a raw record shaped like N6-4's `{policy, eligibleLibraryIds}` normalizes into
  `{browser: <that value>, streamloop: <defaults>}`.
- DOM: both `#startup-media-browser-*` and `#startup-media-streamloop-*` id sets exist, both
  eligible-list containers are `hidden` unless their own policy select is `random-selected`.
- `decideStartupMedia()`'s own decision-table assertions (already in this file from N6-4) — run
  unmodified, confirming the pure function truly didn't move.

**Wiring assertions in `src/main.js`** (source-level string/regex assertions, same technique
`test-startup-media.mjs` §16 already uses against `attemptStartupMedia()`):

- The `message` listener registration is textually inside an `if (launchContext === LAUNCH_CONTEXT_STREAMLOOP)`
  guard (or equivalent) — never registered unconditionally.
- The handler body calls `isTrustedStreamLoopSource(event)` before calling `parseStreamLoopMessage`.
- The only runtime-mutating calls inside the handler/readiness path are `runtime.play()` and
  `runtime.stop()` — no `requestPermission`, no `loadFromFsaHandle`, nothing else.
- `attemptStartupMedia()`'s body resolves `currentStartupPreferences[browser|streamloop]` based on
  `launchContext` before calling `decideStartupMedia(`.

**`tools/check-dom-contract.js`** — passes with the renamed/added ids; every `getElementById` target
in the new sub-blocks resolves.

**Regression:** full suite passes; `test-boot-restore.mjs` and `decideStartupMedia()`'s own N6-4
assertions inside `test-startup-media.mjs` stay green **unmodified** — if either needs editing, this
slice moved semantics it wasn't supposed to touch.

**Human test required: NO.** `postMessage` can be simulated in a headless/jsdom-style harness if the
repo's test tooling supports dispatching synthetic `message` events against `window`; if it does
not, the wiring assertions above (source-level, deterministic) are the correct substitute — do not
ask a human to manually embed BG in GS3 and scroll a panel to prove this. Manual embedding in an
actual GS3 instance is reasonable as a one-time sanity check by the human product owner, but it is
not a substitute for the automated suite and should not be requested as a blocking step.

---

## Sizing

Moderate. Two new small pure modules, one preference-shape migration, one rewritten save function,
meaningful `main.js` wiring (dual rendering + a new gated message listener), matching `index.html`/
`styles.css` changes, and one unrelated one-line CSS fix bundled in per the task. No storage-schema
version bump, no identity/fact/transport change, no GS3 change. Reversible by reverting the
`app-preferences.js` migration (the legacy shape is still read correctly going forward) and removing
the `message` listener registration.
