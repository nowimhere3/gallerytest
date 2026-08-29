# N6-7 — StreamLoop Integration Settings + Post-Load Auto Fill (Architecture Handoff)

**Thursday, August 27, 2026 — 4:11 PM MDT** (America/Edmonton)

**Role:** architecture handoff for the implementer. Not an implementation.
**Baseline:** branch `SandboxSyncV3`, worktree clean, N6-6 complete and PASS.
**Constitution:** `Reports and Docs/NORTH-STAR.md` — it outranks this document.
**Builds on:** N6-5/N6-6 (`?launch=streamloop`, dual startup policies, the `LAUNCHPAD_PLAY`/
`LAUNCHPAD_PAUSE` bridge). This slice adds one new BG-owned Advanced disclosure and **tightens**
N6-6's own PLAY/PAUSE readiness signal — see Part 3, which is a documented correction, not scope
creep.

---

## Part 1 — Are StreamLoop-specific playback overrides needed now?

**No. Build only Auto Fill Panel.** Existing BG Playback Settings (interval, shuffle, shuffle mode,
skip duplicates, loop playlist, autoplay-on-fill) stay fully authoritative and fully shared across
both launch contexts, exactly as today.

Applying the Hidden Architecture Principle directly:

> **A concept earns customer-facing existence only when a customer decision depends on it.**

Nothing in this task names a concrete decision that requires a *different* shuffle/interval/loop
value for a StreamLoop launch than for ordinary use. "Playback (shuffle settings)" was raised as a
possible *future* area, not a specified behavior — building a control for it now would be exactly
anti-pattern #1 from the constitution ("exposing an internal concept because it exists" / because it
was merely mentioned) and #13 ("adding a Settings group instead of solving the decision"). If a
concrete need shows up later (e.g. "a StreamLoop panel should always shuffle regardless of the
customer's normal preference"), that is a small, separate, later slice with its own justification —
not something to build speculatively inside N6-7.

The `StreamLoop Integration` preference section (Part 4) is shaped so a future override, if one is
ever genuinely justified, has an obvious home to grow into — but nothing beyond Auto Fill Panel is
built now.

---

## Part 2 — The completion seam: what "safe to enter Fill Panel" actually means

### The candidate that is NOT strong enough

`state.hasVisibleItems` — N6-6's own PLAY/PAUSE readiness signal — is **not** the right trigger for
Auto Fill Panel, and this section proves it against the real code, not by assumption.

Tracing `loadFromFsaHandle()` (`main.js`, the function every startup-media path funnels through):

```text
1. restoreProfileForLoadedLibrary()      — Curation restore, AWAITED, BEFORE the scan starts
2. fsaProvider.loadFromDirectoryHandle() — the scan itself (batched internally for main-thread
                                            responsiveness; resolves ONCE, with the COMPLETE item
                                            list — BATCH_SIZE does not cause runtime.load() to run
                                            more than once, so 1,500 vs 40,000 items changes how
                                            long step 2 takes, not how many times state changes)
3. finishLoadingItems(result.items)      — stamps Favorite/Hidden/Tags, calls reloadRuntime() ->
                                            runtime.load() — THIS is the single synchronous point
                                            where state.hasVisibleItems flips true
4. armDeferredLoadTimeOffer()            — AWAITED, AFTER step 3 — arms a possible Curation
                                            question (does not block on a human answering it, but
                                            does real async work: re-reads a stored decision)
5. touchLibrary() / recordLibraryLoaded() / recordPortableStructureForLoad() / renderRecentLibraries()
                                          — AWAITED, AFTER step 3 — registry bookkeeping and
                                            portable-structure evidence sampling, whose cost scales
                                            with collection size
6. finally: isLoadingFiles = false; setLoadingState(false); syncMobileLoadState();
                                          — the function's OWN comment names this the
                                            "Authoritative completion point for this loader"
```

`state.hasVisibleItems` becomes true at **step 3** — while steps 4–6 are still pending. For a
1,500-item folder that gap is small; for a 40,000-item folder, step 5's bookkeeping (especially
portable-structure evidence sampling) is exactly the kind of work whose cost grows with collection
size, so the gap is not merely theoretical. Triggering Fill Panel — or applying a pending StreamLoop
PLAY — at step 3 would satisfy the letter of "media loaded" while contradicting the product
requirement's own step 4: *"BG completes whatever existing media/Curation state needs to settle."*
`hasVisibleItems` is real, useful, and correctly stays N6-6's readiness *floor* — but it is a weaker
proxy than the seam the code already names as authoritative.

### The seam that is strong enough

`loadFromFsaHandle()`'s own **promise resolving** — its `finally` block, reached on both success and
failure — is already the function's own documented "authoritative completion point." Both of
N6-6's startup paths already await it:

```text
attemptStartupMedia()
  "last-used"        -> await attemptBootRestore()      -> await loadFromFsaHandle(...) internally
  "random-remembered" -> await loadFromFsaHandle(...) directly
  "random-selected"   -> await loadFromFsaHandle(...) directly
```

So the correct hook is not a new signal — it is **`attemptStartupMedia()` itself finishing**, since
every one of its branches already awaits the real completion seam before returning. No new
instrumentation of `loadFromFsaHandle()` is needed or wanted.

---

## Part 3 — Exact sequencing (and the correction to N6-6's readiness definition)

### The product owner's instinct, verified

> `load complete → Fill Panel → honor PLAY` (unless a later PAUSE superseded it)

This is correct, but N6-6's current wiring does **not** yet guarantee it: N6-6's `runtime.subscribe()`
readiness callback fires the moment `state.hasVisibleItems` becomes true — step 3 above, **before**
`attemptStartupMedia()` returns. A PLAY or PAUSE that arrived earlier would already be applied by the
time Auto Fill Panel (which correctly waits for the full completion seam) runs. Worked example: if a
StreamLoop PAUSE lands in the window between step 3 and `attemptStartupMedia()` returning, N6-6's
existing code would apply it immediately (`streamLoopReady` already true) — then Auto Fill Panel
enters later and, via `enterFillPanelDeliberately()`'s own "Autoplay on Fill" branch (see below),
could **resume playback that PAUSE had just stopped**. That is the exact bug the product owner's
question was worried about, and it is real given N6-6's current code, not hypothetical.

**The fix is to tighten N6-6's readiness gate**, not to add a competing timer: `streamLoopReady` now
requires **both** `state.hasVisibleItems` **and** a new `streamLoopStartupSettled` flag that only
becomes true once `attemptStartupMedia()` itself has returned. This is a deliberate, documented
correction — cite this section, not a silent behavior change.

### The algorithm

`main.js`, module scope (promoted out of the `if (launchContext === LAUNCH_CONTEXT_STREAMLOOP) {...}`
block N6-6 added — see *Refactor* below for exactly why):

```js
let streamLoopPendingIntent = null;
let streamLoopReady = false;
let streamLoopStartupSettled = false; // true once attemptStartupMedia() itself has returned

function applyStreamLoopIntent(intent) {
  if (intent === "play") runtime.play();
  else if (intent === "pause") runtime.stop();
}

// Shared by BOTH triggers below — the boot-settle path and the fallback
// subscribe path — so neither can double-apply an intent.
function tryBecomeStreamLoopReady() {
  if (streamLoopReady) return;
  if (!streamLoopStartupSettled) return;
  if (!runtime.getState().hasVisibleItems) return;
  streamLoopReady = true;
  if (streamLoopPendingIntent) applyStreamLoopIntent(streamLoopPendingIntent);
  streamLoopPendingIntent = null;
}
```

`attemptStartupMedia()` becomes a thin wrapper around its own current body (renamed, unchanged
internally — see *Refactor*):

```js
async function attemptStartupMedia() {
  await runStartupMediaLoad(); // N6-4/N6-6's existing body, verbatim, just renamed

  if (launchContext !== LAUNCH_CONTEXT_STREAMLOOP) return;

  streamLoopStartupSettled = true;

  // Auto Fill Panel is scoped to THIS boot-time load only — never re-fires for
  // a later manual load in the same tab. See "why boot-scoped only" below.
  if (runtime.getState().hasVisibleItems && currentStreamloopIntegrationPreferences.autoFillPanel) {
    enterFillPanelDeliberately(); // THE existing shared entry path — see Part 5
  }

  // Applying any pending PLAY/PAUSE AFTER Fill Panel entry is what guarantees
  // the product owner's ordering: whatever StreamLoop said most recently
  // always has the final say over BG's own "Autoplay on Fill" default.
  tryBecomeStreamLoopReady();
}
```

The `if (launchContext === LAUNCH_CONTEXT_STREAMLOOP) { ... }` block itself shrinks to just the two
registrations that must stay conditional (an ordinary browser tab must still never add a `message`
listener or the extra `runtime.subscribe()`):

```js
if (launchContext === LAUNCH_CONTEXT_STREAMLOOP) {
  window.addEventListener("message", (event) => {
    if (!isTrustedStreamLoopSource(event)) return;
    const intent = parseStreamLoopMessage(event.data);
    if (!intent) return;
    if (streamLoopReady) applyStreamLoopIntent(intent);
    else streamLoopPendingIntent = nextPendingIntent(intent);
  });

  // Fallback ONLY: covers the boot-time load finding nothing to restore, with
  // media appearing later through some other path in the same tab. Does NOT
  // trigger Auto Fill Panel — see "why boot-scoped only" below.
  runtime.subscribe((state) => {
    if (streamLoopReady || !state.hasVisibleItems) return;
    tryBecomeStreamLoopReady();
  });
}
```

### Verifying the "Autoplay on Fill" interaction

`enterFillPanelDeliberately()` (existing, `main.js`) samples `wasPlaying` **before** calling
`enterFillMode()`, and only starts playback itself when `!wasPlaying && autoplayOnFillInput.checked`.
At the moment Auto Fill Panel calls it (inside `attemptStartupMedia()`, before
`tryBecomeStreamLoopReady()` runs), `streamLoopReady` is still false, so `wasPlaying` is false unless
something else started playback — nothing else does. Three cases, all verified correct:

| BG's "Autoplay on Fill" | Pending StreamLoop intent | Result |
| --- | --- | --- |
| ON (default) | none yet | Fill Panel enters, autoplay starts it — StreamLoop's own IntersectionObserver will PLAY/PAUSE it correctly once the panel's visibility is next evaluated |
| ON | `"pause"` | Fill Panel enters, autoplay starts it, then `tryBecomeStreamLoopReady()` immediately calls `runtime.stop()` — net result: paused, matching the LATEST StreamLoop signal |
| OFF | `"play"` | Fill Panel enters, stays paused (autoplay off), then `tryBecomeStreamLoopReady()` calls `runtime.play()` — net result: playing |

In every case, **the most recent explicit StreamLoop signal wins over BG's own default**, applied
strictly after Fill Panel entry — exactly the product owner's instinct, now verified against the two
real interacting code paths rather than assumed.

### Why Auto Fill Panel is boot-scoped only, not "any future load"

The product requirement's steps describe one sequence: StreamLoop launches BG → BG loads its
StreamLoop folder → BG enters Fill Panel. There is no requirement that a *manual* folder change
later in the same tab should also auto-enter Fill Panel — and doing so would be a surprising
UI hijack while the customer is actively using BG's own picker. Scoping the trigger to the one
`attemptStartupMedia()` call already guarantees "fires at most once, only for the StreamLoop-driven
load" with no extra flag needed — `attemptStartupMedia()` itself is only ever called once, from
`initFsaLibraries()`.

### Refactor this slice makes to N6-6's code (not new behavior, just relocated)

N6-6 declared `streamLoopPendingIntent`, `streamLoopReady`, and `applyStreamLoopIntent` **inside**
the `if (launchContext === LAUNCH_CONTEXT_STREAMLOOP) { ... }` block. `attemptStartupMedia()` is
defined later in the file and needs to read/set this shared state, so this slice promotes those
three declarations (plus the new `streamLoopStartupSettled` and `tryBecomeStreamLoopReady()`) to
module scope, unconditionally. This is safe and inert for an ordinary browser tab: the functions
simply never get called, because the only two things that call into them — the `message` listener
and the extra `runtime.subscribe()` — stay inside the `if` guard exactly as before, and
`attemptStartupMedia()`'s own StreamLoop-only branch is itself gated on `launchContext`.
`isTrustedStreamLoopSource()` can move to module scope too, for consistency, though nothing outside
the guard needs it.

**Test impact this causes, called out explicitly so it is not discovered as a surprise regression:**
`tools/test-streamloop-bridge.mjs`'s existing wiring assertions (§7) search a `guardBody` slice taken
between `if (launchContext === LAUNCH_CONTEXT_STREAMLOOP) {` and the next `\n}\n`. After this refactor
that slice contains only the two registrations — `runtime.play()`, `runtime.stop()`,
`state.hasVisibleItems`, and the `parseStreamLoopMessage`/`nextPendingIntent` calls now live in
sibling module-scope functions, not inside `guardBody`. Update those specific assertions to search
the relevant function bodies (`applyStreamLoopIntent`, `tryBecomeStreamLoopReady`) instead of
`guardBody` — the underlying properties they were proving (PLAY/PAUSE apply through
`runtime.play()`/`runtime.stop()`, readiness reads `hasVisibleItems`, no `requestPermission`, no
`LAUNCHPAD_READY`, no `postMessage()` sent back) are all still true and should still be asserted,
just against the right slice of source. The two assertions checking the listener is registered *only*
inside the guard, and that source validation checks `event.source`/`window.parent` rather than
`event.origin`, are unaffected — that code doesn't move.

---

## Part 4 — Preference shape

### Why a new top-level section, not `startup.streamloop`

`startup.streamloop` answers *which folder loads*. Auto Fill Panel answers a completely different
question — *what BG does after* a folder has already loaded — and belongs conceptually with
playback/presentation behavior, not source selection. Nesting it inside `startup.streamloop` would
also create a confusing near-duplicate name one level down (`preferences.startup.streamloop.policy`
next to a hypothetical `preferences.startup.streamloop.autoFillPanel`) for two unrelated concerns.
The new Advanced disclosure this slice adds is explicitly a *separate* disclosure from "Startup
Media" too — the data shape should mirror that separation.

```js
const DEFAULT_STREAMLOOP_INTEGRATION = {
  autoFillPanel: false,
};
```

Named `streamloopIntegration` — matching the "StreamLoop Integration" disclosure's own name exactly,
so a future reader maps `preferences.streamloopIntegration` to its UI section without
cross-referencing anything. This also gives a future genuinely-justified SL-specific override (Part
1) an obvious, already-separate home to grow into, without retrofitting `startup`.

### Default: `autoFillPanel: false`

Entering Fill Panel is a screen takeover the customer did not just click a button for. Defaulting it
off matches the conservative default this codebase already uses for behavior that acts *on the
customer's behalf* without an explicit per-action gesture (compare: `startup.*.policy` defaults to
`"last-used"`, the least surprising option, not a random policy). Turning it on is one checkbox,
device-local, remembered until changed — ordinary Advanced-settings territory.

### Normalization / persistence / migration

Reuse the existing `bool(value, fallback)` helper — no new normalization primitive needed:

```js
streamloopIntegration: {
  autoFillPanel: bool(streamloopIntegrationSource.autoFillPanel, DEFAULT_STREAMLOOP_INTEGRATION.autoFillPanel),
},
```

`saveStreamloopIntegrationPreferences(partial)` — this section has exactly one flat boolean field, no
nested per-context split like `startup` needed, so the **generic one-level `savePartial("streamloopIntegration",
partial)` is sufficient** here. Do not reuse `startup`'s two-level merge pattern; it would be
unnecessary machinery for a section with no nesting.

**No migration needed.** This is a net-new key on a record that may predate it — the same "missing
field defaults individually" pattern `onboarding`/`microArcade` already established when *they* were
added, with no `DATABASE_VERSION` bump, for the same reason: the object store's shape doesn't change,
only the record's, and every record is reshaped on every read.

---

## Part 5 — UI placement

Browser Gallery → Advanced Settings → **StreamLoop Integration** — a new fifth nested `<details>`,
closed by default, placed immediately after "Startup Media" (both concern the same launch/startup
moment) and before "Sync Your Curations". No reordering of the existing four.

```html
<details class="advanced-streamloop-integration-section">
  <summary>StreamLoop Integration</summary>
  <p class="hint">Applies only when Browser Gallery is launched by StreamLoop.</p>

  <label class="compact-check wide-check" title="Automatically enter Fill Panel once StreamLoop's media has finished loading">
    <input id="streamloop-auto-fill-panel-input" type="checkbox" />
    <span>Auto Fill Panel after media loads</span>
  </label>
</details>
```

Follows the exact existing checkbox markup convention (`autoplay-on-fill-input`,
`skip-duplicates-input` — `index.html`), not a new pattern. No new CSS is expected: the generic
`.advanced-settings-section > details` spacing (N6-4/N6-6) and the existing `.compact-check
wide-check` checkbox styling already cover this. Since this is not the first child, N6-6's
`:first-of-type` spacing rule does not apply to it and needs no change.

`main.js` wiring mirrors every other Advanced checkbox pattern in this file exactly: a DOM ref, a
`currentStreamloopIntegrationPreferences` module-level snapshot (mirroring
`currentStartupPreferences`), seeding in `applyLoadedPreferences()`, and a `change` listener saving
through `saveStreamloopIntegrationPreferences({ autoFillPanel: ... })`. Nothing about it needs to be
context-aware in the UI itself — the checkbox is a single, always-visible control (it is *read* only
when `launchContext === "streamloop"`, per Part 3's wrapper, but it is configured from an ordinary
browser tab like every other Advanced setting).

---

## Multiple StreamLoop panels — current behavior, documented only

Each StreamLoop-launched BG iframe is an independent page load — its own `window`, its own module
state, its own `launchContext`, its own `runtime`. They share the **same-origin IndexedDB**
(`loop-browser-gallery-preferences`, `library-registry`'s database, `ProfileStore`'s database), so
the `streamloopIntegration.autoFillPanel` preference and `startup.streamloop`'s policy/eligible pool
are shared configuration, but each panel independently reads them and independently runs its own
`attemptStartupMedia()` → Auto Fill → PLAY/PAUSE sequence, with zero coordination between panels.

Two or more panels running a random startup policy may land on the same folder — that is allowed and
unchanged from N6-6. **"Random without replacement across panels" is explicitly future work and is
not built or scaffolded here.** No shared "which folders are already in use" state is introduced.

Each panel's own PLAY/PAUSE bridge is independent too: GS3's `IntersectionObserver` fires per-panel,
so each iframe gets its own `LAUNCHPAD_PLAY`/`LAUNCHPAD_PAUSE` stream based on its own visibility,
handled entirely by that panel's own module-scope state. Nothing added in N6-7 changes this.

---

## Out of scope, confirmed by this handoff

- Any GS3/`nowimhere3/GS3` modification
- Cross-panel coordination of any kind, including "random without replacement"
- Native/WebView implementation
- StreamLoop controlling Curation
- New StreamLoop message types; no `LAUNCHPAD_READY` (still future-only, per N6-6)
- Volume/seek/next/previous protocol additions
- A duplicate or partial copy of the existing Playback Settings UI — see Part 1
- Any identity/SyncV3/MEDIA-ID change
- A second fullscreen/presentation mechanism — Auto Fill Panel calls the existing
  `enterFillPanelDeliberately()` and nothing else
- Waiting for a human to answer an ambient/deferred Curation question before entering Fill Panel —
  `armDeferredLoadTimeOffer()` only *arms* such a question; it does not block on an answer, and Auto
  Fill Panel correctly does not wait for one either

---

## Likely files

| File | Change |
| --- | --- |
| `src/storage/app-preferences.js` | `DEFAULT_STREAMLOOP_INTEGRATION`, normalization inside `normalizeRecord()`, `saveStreamloopIntegrationPreferences(partial)` (generic one-level `savePartial`) |
| `src/main.js` | Promote `streamLoopPendingIntent`/`streamLoopReady`/`applyStreamLoopIntent` to module scope; add `streamLoopStartupSettled`, `tryBecomeStreamLoopReady()`; rename current `attemptStartupMedia()` body to `runStartupMediaLoad()` and make `attemptStartupMedia()` the thin settle-sequence wrapper from Part 3; new DOM ref + `currentStreamloopIntegrationPreferences` + seeding + change listener for the new checkbox |
| `index.html` | New `advanced-streamloop-integration-section` disclosure, placed after Startup Media, before Sync Your Curations |
| `styles.css` | Likely no changes — verify the existing generic disclosure/checkbox styling covers it before adding anything |
| `tools/test-streamloop-autofill.mjs` | **New** — see Deterministic tests |
| `tools/test-streamloop-bridge.mjs` | **Update required** — §7's wiring assertions must be re-pointed per the *Refactor* note in Part 3; do not leave them asserting against a `guardBody` slice that no longer contains the code they're checking |

## Deterministic tests

**New — `tools/test-streamloop-autofill.mjs`:**

| Area | Case |
| --- | --- |
| Preferences | `autoFillPanel` defaults to `false`; round-trips through `saveStreamloopIntegrationPreferences`; an unrecognized/non-boolean stored value normalizes to the default; saving it leaves every sibling section (`playback`, `presentation`, `microArcade`, `onboarding`, `startup`) intact |
| DOM | `#streamloop-auto-fill-panel-input` exists inside a closed `<details class="advanced-streamloop-integration-section">`; the disclosure sits after Startup Media and before Sync Your Curations in document order |
| Wiring: sequencing | Source-level assertion that `attemptStartupMedia()`'s body calls `await runStartupMediaLoad()` (or equivalent renamed helper) BEFORE any Auto Fill / readiness logic — i.e., the settle steps are textually after the load-await, not interleaved with `runStartupMediaLoad()`'s own internals |
| Wiring: ordering | Assert `enterFillPanelDeliberately(` appears BEFORE `tryBecomeStreamLoopReady(` in `attemptStartupMedia()`'s body — proves Fill Panel entry is sequenced before pending intent is applied, not the DOM at runtime (a pure text-order proxy for a property already verified by hand in Part 3 — flag as best-effort, not a substitute for the readiness unit tests below) |
| Wiring: gating | Assert the Auto Fill check reads BOTH `hasVisibleItems` and the preference (`currentStreamloopIntegrationPreferences.autoFillPanel` or equivalent) before calling `enterFillPanelDeliberately(` |
| Wiring: reuse | Assert `enterFillMode(` is never called directly by this slice's new code (only `enterFillPanelDeliberately(` is) — no second entry mechanism |
| Wiring: scope | Assert `runStartupMediaLoad()`/`attemptBootRestore()`/`loadFromFsaHandle()` are unmodified in shape (still exported/called exactly as N6-6 left them) — this slice adds a wrapper, it does not rewrite the load path |
| `tryBecomeStreamLoopReady()` unit test | If feasible to exercise directly (it's a plain function reading/writing module state) — otherwise cover via the pure functions it composes: with `streamLoopStartupSettled=false`, no readiness regardless of `hasVisibleItems`; with both true and a pending `"pause"`, `runtime.stop()` is the only call made; calling it twice never double-applies |
| Multiple panels | Documentation-only per this handoff — no test needed; nothing shared/coordinated was built |

**`tools/test-streamloop-bridge.mjs` (updated, not just re-run):** re-point the wiring assertions
per Part 3's *Refactor* note — the properties under test are unchanged, only which source region
proves them.

**Regression:** `tools/test-boot-restore.mjs` and `decideStartupMedia()`'s own decision-table
assertions in `test-startup-media.mjs` stay untouched — this slice never modifies
`boot-restore.js`. `tools/check-dom-contract.js` passes with the one new id and disclosure. Full
suite passes.

**Human test required: NO.** Every branch here is either a pure function, a preference round-trip,
or a source-level wiring assertion; the one thing that is genuinely runtime/visual (Fill Panel
actually filling the screen) is already proven by `enterFillMode()`'s own existing behavior, which
this slice does not touch — it only decides *when* to call the same entry point a human click
already uses.

---

## Sizing

Small-to-moderate. One new preference section (no migration), one new Advanced disclosure with a
single checkbox, a function rename plus a thin sequencing wrapper in `main.js`, a promotion of five
existing module-scope declarations out of a conditional block (mechanical, not behavioral for
ordinary browser tabs), and one corrected readiness gate in N6-6's own bridge (documented, not
silent). No storage-schema, identity, fact, or transport change. No GS3 change. Reversible by
reverting the wrapper (restoring `attemptStartupMedia()` to N6-6's body) and removing the new
disclosure.
