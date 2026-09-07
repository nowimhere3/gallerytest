# Phase 3-6 - Remote Presentation Warm Start Implementation Report

**Timestamp:** Wednesday, September 2, 2026 at 9:20:01 PM MDT (Calgary, Alberta)

# Stage

Phase 3B.1 — Remote Presentation Warm Start. Implementation and automated verification are complete. Human evidence is **PENDING HUMAN TEST**.

# Goal

Cover the cold-start interval for URL-backed photo Presentation playback while the existing two-worker Phase 3B queue establishes a useful reserve, without changing runtime planning, concurrency, steady-state playback, or local-session behavior.

# Files Changed

- `src/main.js`
- `src/runtime/warm-start.js` (new)
- `index.html`
- `styles.css`
- `tools/test-warm-start.mjs` (new)
- `Reports and Docs/Codex Reports/Phase 3-6 - Remote Presentation Warm Start Implementation Report.md` (new)

# What Was Implemented

- A small `inactive | warming` controller in `main.js`.
- A viewer-panel overlay using the exact approved sentence and the existing hidden-class convention.
- Named release constants: `RELEASE_READY_COUNT = 3` and `WARM_START_MAX_MS = 10000`.
- Pure `shouldReleaseWarmStart()` and `canApplyWarmStartRelease()` decisions with no DOM, timers, or browser globals.
- Release instrumentation logging reason, elapsed milliseconds, and valid prepared count under `[PM WARM START] Release`.
- Immediate cancellation for Pause/Stop, Presentation exit, Next, and Previous, with the human action continuing normally.

# Source-Provenance Implementation

`currentSessionIsUrlBacked` is module-local Presentation state. It is set to `true` only in the existing `loadRemoteSession()` preamble and set to `false` in the `loadFiles()` preamble, `loadFromFsaHandle()` preamble, and Clear Media handler.

Both one-shot Remote Session and remembered Remote Cassette entry points converge through `loadRemoteSession()`, so both receive the behavior. No URL inspection, source sniffing, `currentSourceKind` expansion, or runtime source semantics were added.

# Warm Start Trigger Contract

Warm Start begins only when Presentation playback is starting, the session is URL-backed, the current item is an image, and fewer than three valid upcoming prepared images exist. It covers both entering Fill Panel when playback will run and starting playback while Fill Panel is already active.

It does not trigger from loading a remote session, manual navigation, a video current item, or a local FSA/legacy session. Healthy reserve depth suppresses gratuitous replay on resume or re-entry.

# Release Contract

The controller observes the existing Phase 3B queue and releases for:

- three valid upcoming prepared images (`ready`);
- ten seconds of extra queue-building time followed by a real current viewer terminal outcome (`timeout`); or
- immediate human cancellation (`cancelled`).

Release hides the overlay, stops the shared arcade engine, and calls the existing `runtime.notifyCurrentItemVisible()` exactly once. No slideshow scheduler was added.

# Council Amendment 1 Handling

The ten-second timer records that the Warm Start maximum was reached. If the current image has not committed or failed, the overlay stays up and the runtime hold remains in force. The next normal current-viewer terminal outcome then releases immediately with reason `timeout`.

The pure `canApplyWarmStartRelease()` predicate freezes this rule: ready/timeout decisions require `currentVisualSettled`; cancellation remains immediate. No visible interval is started for an image that has not actually reached a terminal viewer outcome, and no extra current-image timeout was introduced.

# Council Amendment 2 Validity Finding

Raw `preparedViewerImages.size` was **not treated as inherently safe** at every release-decision point. `countValidPreparedWarmStartItems()` synchronously:

- removes generation-stale entries;
- obtains the current runtime plan;
- verifies both `libraryLoadGeneration` and `galleryGeneration`;
- verifies exact item membership in the current plan; and
- releases any entry that fails those checks.

Only the resulting valid upcoming count is compared with the threshold of three. No runtime or ready-queue API was added.

# Arcade Engine Reuse

`startArcadeAnimation(canvas)` now resolves its context from the supplied host canvas. The existing mobile takeover continues to call the same engine with `mobileLoadCanvas`; Warm Start calls it with `warmStartCanvas`.

The scene selector, scene pool, animation controller, shared stop path, and existing reduced-motion branch remain unchanged. `syncMobileLoadState()` and the `.mobile-load-takeover` shell were not modified. Automated source assertions verify the original mobile host is still passed and reduced-motion handling remains present.

# Protected Module Identity

Blob comparison against `HEAD` confirms byte identity:

- `src/runtime/media-runtime.js`: `5bcc788995c0b52dd295f3dd57e77d17953f0756` — MATCH
- `src/runtime/ready-queue.js`: `3d2fc60ab32906e293f5310b430fd1fd863e05eb` — MATCH
- `src/runtime/viewer-commit.js`: `8881b63c14eca56c96282a6dbe96e41dd131a91e` — MATCH

The six-item plan/prepared caps and two-worker concurrency cap remain unchanged.

# What Was Explicitly Not Implemented

- No MediaRuntime, ready-queue, viewer-commit, shuffle-selector, provider, storage, profile, or playback changes.
- No additional preloader, RNG, selector, worker, queue API, concurrency, or prepared capacity.
- No adaptive policy, retry, image timeout, video readiness, local-session delay, or UI redesign.
- No changes to `finishLoadingItems()`, `clearViewerNode()`, or the functional remote-loader body beyond the authorized provenance write.

# Tests Run

- `node --check src/main.js` — PASS
- `node --check src/runtime/warm-start.js` — PASS
- `node tools/test-warm-start.mjs` — **18 assertions passed**
- `node tools/test-shuffle-plan.mjs` — **27 assertions passed**
- `node tools/test-ready-queue.mjs` — **9 assertions passed**
- `node tools/test-viewer-commit.mjs` — **16 assertions passed**
- `node tools/test-shuffle-modes.mjs` — **20 assertions passed**
- `node tools/test-remote-url-parser.mjs` — **35 assertions passed**
- `node tools/test-remote-url-provider.mjs` — **51 assertions passed**
- `node tools/test-cassette-registry.mjs` — **33 assertions passed**
- `node tools/check-dom-contract.js` — **0 failures, 0 warnings**
- Full isolated `tools/test-*.mjs` suite with 120-second per-file timeout — **73 total / 71 pass / 2 known pre-existing non-passes / 0 new failures**
- `git diff --check` — PASS

# Results

All Phase 3B.1 automated gates passed. The only full-suite non-passes remain the approved baseline:

- `tools/test-ambient-decision-multitab.mjs` — existing assertion failure
- `tools/test-sync-v2-scheduler.mjs` — existing timeout

# Breadcrumbs Added

The Warm Start controller seam contains `BREADCRUMBS - WAS / IS / WILL BE`, recording the observed early 15–20 second stall, the bounded curtain over the existing queue, the real-terminal-outcome requirement, human cancellation, and deliberately deferred adaptive/video/memory architecture.

# Git Status

Phase 3B.1 is uncommitted. Its changes are limited to the six authorized paths listed above. The known deleted historical reports and unrelated untracked documentation directories/files remain untouched.

# Human Evidence

**PENDING HUMAN TEST**

Run 1: Remote Cassette or Remote Session, Photos, Presentation, Fill Panel, Shuffle, 5-second interval. Confirm the arcade and sentence appear intentionally, the recurring early stall is absent, normal cadence remains good, and Stop/Exit/Next during the arcade behave sanely.

Run 2: one local folder, Presentation, a few transitions. Confirm no Warm Start arcade, no startup delay, and normal local playback.

# Known Unknowns

- The first real release reason, elapsed duration, and valid prepared count await browser evidence from the native log.
- The overlay’s perceived presentation and cancellation behavior require the authorized human browser run.

# Recommendation

Proceed to the two minimal human runs. Do not commit or push until human evidence and council review are complete.
