# Phase 3-4 - Planned Shuffle Ready Queue Implementation Report

**Timestamp:** Wednesday, September 2, 2026 at 8:11:43 PM MDT (Calgary, Alberta)

# Stage

Phase 3B — Planned Shuffle + Ready Queue. The initial implementation passed its human browser run. An evidence-driven bounded runway tune is implemented and automated; post-tune confirmation is **PENDING FINAL SANITY**.

# Goal

Prepare the runtime-owned upcoming shuffle sequence while the current image is visible, allowing normal Presentation interval advances to commit already-ready images rather than placing resource acquisition on the visible transition path.

# Files Changed

- `src/runtime/media-runtime.js`
- `src/main.js`
- `src/runtime/ready-queue.js` (new)
- `tools/test-shuffle-plan.mjs` (new)
- `tools/test-ready-queue.mjs` (new)
- `Reports and Docs/Codex Reports/Phase 3-4 - Planned Shuffle Ready Queue Implementation Report.md` (new)

No protected file or protected function was changed.

# What Was Implemented

- `MediaRuntime.getPlannedItems(count)` materializes at most six real future decisions through the existing `selectNextShuffledIndex()`, visible pool, and injected random source.
- `next()` consumes a valid plan head only after forward-history handling and pool-key validation. There is no second selector or random authority.
- The runtime plan is cleared by load/clear, shuffle changes, shuffle-mode changes, direct index selection, removal, and eligible-pool changes. Back/forward-history navigation retains it.
- `planReadyQueueWork()` is a pure DOM-free decision function returning bounded `start` and `release` lists.
- Presentation-only warming prepares image nodes with native load plus best-effort decode. Following the human evidence run, the plan and prepared-node caps were tuned from 3 to 6 while the concurrent warm-operation cap remains 2.
- Prepared entries have exactly `{ item, node, loadGeneration, galleryGeneration }`. Generation and exact-item validation protect commits; stale and released nodes have `src` cleared.
- Presentation exit releases prepared and warming nodes. Warming resumes only after Presentation is entered and a current image is visibly committed with no current-item preparation in flight.
- A ready hit commits the prepared node synchronously. A miss enters the existing Phase 3A held-frame path.
- An obsolete animation-frame callback is rejected before it can release the hold or re-anchor the timer for a newer rapid-Next transition.
- `[PM TRANSITION]` now records `visible_ms` and `ready_hit`; the ten-transition summary reports visible median/p90 and the ready-hit rate.

# Runtime Methods Added

- `getPlannedItems(count)`
- `holdAdvanceForPendingVisual()`
- `notifyCurrentItemVisible()`

The exact scheduler change is one guard immediately after its existing timer clear:

```js
this.#clearTimer();
if (this.#advanceHeld) return;
```

`holdAdvanceForPendingVisual()` sets the hold and clears the timer. Every current viewer terminal outcome releases it through `notifyCurrentItemVisible()`. `load()`, `clear()`, `stop()`, and `play()` defensively clear the hold. Video mounting also reports visibility, while the existing video rule continues to prevent an image interval timer.

# What Was Explicitly Not Implemented

- No second RNG, selector, prediction path, or remote-specific branch.
- No preload-all, unbounded cache, byte accounting, timeout, retry, skip, removal, reordering, or failure taxonomy.
- No video/TS readiness, buffering, codec work, Dead Item Auto-Skip, UI changes, or later-phase architecture.
- No claim that the CDN, origin, or network became faster.

# Sequence Equivalence Evidence

`tools/test-shuffle-plan.mjs` passed **27 assertions**. Seeded 20-advance comparisons were index-for-index equal for both `shuffle-loop` and `true-random`. The suite also froze a complete no-repeat loop cycle, the six-item plan cap, eligibility, stable prefixes, history precedence, Back/Next continuation, pool invalidation, required mutation invalidation, timer holding/re-anchoring, manual-Next urgency, and video behavior.

Equivalence applies to the same starting state when a materialized plan remains valid and is consumed uninterrupted. Planning consumes RNG draws earlier in wall-clock time; if eligibility changes and the plan is discarded, those draws are intentionally not restored.

# Ready Queue Evidence

`tools/test-ready-queue.mjs` passed **9 assertions**. It verified plan order, a hard prepared cap of 6, an unchanged warming-concurrency cap of 2, release of items outside the plan, suppression of duplicate prepared/warming starts, empty-plan behavior, and the six-node prepared bound across 100 simulated advances.

# Cadence Evidence

The initial real-browser run produced a clean autonomous Presentation capture of 15 visible transitions (14 cadence intervals):

- minimum: 5.00 s
- median: approximately **5.01 s**
- p75: approximately 5.01 s
- p90: approximately **5.01 s**
- maximum: 5.02 s
- mean: 5.01 s
- advance-to-ready median: approximately 13 ms
- black-gap median: 0 ms

This confirms the visible-anchored timer contract stabilized normal ready-hit cadence. One human-observed long-tail stall around 15 seconds remained.

Instrumentation now supplies:

- `visible_ms`: previous image visible commit to current image visible commit
- rolling `visible_ms` median and p90
- `ready_hit`: whether the committed image came from the ready queue
- rolling ready-hit rate

External profiler fields based on `advance → src → load → visible` are not interpreted as conventional Phase 3B transition timings because warming intentionally assigns `src` before an item becomes current. Visible cadence, visible commit behavior, black gap, human experience, and Browser Gallery's native instrumentation are the trustworthy evidence.

# Phase 3A Fallback

Confirmed by code inspection: every image queue miss continues into the committed Phase 3A `prepareHeldFrameImage()` path. `shouldCommitPreparedViewer()` is reused unchanged, and `clearViewerNode()` remains the teardown owner. A warm failure releases its detached node and leaves the item eligible for its normal Phase 3A attempt when it becomes current.

# Tests Run

- `node --check src/main.js` — PASS
- `node --check src/runtime/media-runtime.js` — PASS
- `node tools/test-shuffle-plan.mjs` — **27 assertions passed**
- `node tools/test-ready-queue.mjs` — **9 assertions passed**
- `node tools/test-viewer-commit.mjs` — **16 assertions passed**
- `node tools/test-shuffle-modes.mjs` — **20 assertions passed**
- `node tools/test-pm-shuffle-folders.mjs` — **146 assertions passed, 0 failures**
- `node tools/test-remote-url-parser.mjs` — **35 assertions passed**
- `node tools/test-remote-url-provider.mjs` — **51 assertions passed**
- `node tools/test-cassette-registry.mjs` — **33 assertions passed**
- `node tools/check-dom-contract.js` — **0 failures, 0 warnings**
- Complete isolated `tools/test-*.mjs` suite, 120-second per-file timeout — **72 total / 70 pass / 2 known pre-existing non-passes / 0 new failures**
- `git diff --check` — PASS

# Results

All Phase 3B automated gates passed. The only complete-suite non-passes remain the approved baseline:

- `tools/test-ambient-decision-multitab.mjs` — existing assertion failure
- `tools/test-sync-v2-scheduler.mjs` — existing timeout

Protected startup, boot restore, folder shuffle, and StreamLoop tests passed within the full suite.

# Before / After Transition Evidence

Settled pre-3B evidence remains: dispatch about 0.8 ms median; resource readiness about 4,647 ms median and 10,967 ms p90; Phase 3A removed the black frame but did not stabilize cadence.

Phase 3B prepares upcoming images while the current image is on screen, so an interval can normally expire onto an already-ready node. Human evidence confirms this normally produces immediate swaps and approximately 5.01-second visible cadence. The single approximately 15-second outlier is consistent with exhausting the original three-item, approximately 15-second runway against previously measured 10–17+ second resource tails.

The narrow resilience tune increases `PLAN_LENGTH` and `MAX_PREPARED` from 3 to 6, providing approximately 30 seconds of full-buffer runway at a 5-second interval. `MAX_CONCURRENT_WARMING` remains 2, so the tune does not create six simultaneous requests or alter queue architecture.

# Human Evidence Status

Initial real-customer run — Remote Cassette / Photos / Presentation Mode / Fill Panel / Shuffle / 5-second interval:

- feels fast: **YES**
- cadence approximately stable: **YES**
- immediate swaps normally: **YES**
- skipped-looking weirdness: **NO**
- rapid navigation: **worked well**
- long stalls: **one observed outlier around 15 seconds**

Post-tune human confirmation: **PENDING FINAL SANITY**. No further benchmark is requested; the remaining check is ordinary real Presentation Shuffle use to judge whether the long-tail experience remains acceptable.

# Regressions

No new automated regression was found. The initial human run found no navigation regression. Post-tune final sanity remains pending.

# Known Unknowns

- The post-tune long-tail experience awaits final human sanity; no new benchmark is required.
- The captured evidence establishes cadence but did not provide a final native ready-hit rate for this report.
- Browser/network hangs that emit neither load nor error remain the existing Phase 3A exposure; no arbitrary timeout was added.
- The cap is by node count, not decoded bytes. Six 4000×3000 RGBA images may theoretically approach roughly 288 MB decoded. This bounded memory tradeoff is accepted for the additional runway; no byte-accounting or memory-pressure subsystem was added.

# Breadcrumbs Added

Three-tier `BREADCRUMBS - WAS / IS / WILL BE` architectural memory was added at the runtime plan seam and the Presentation warmer seam. It records the single-authority invariant, advisory bounded queue, source neutrality, and deliberately deferred video/byte-policy/failure features.

# Git Status

Phase 3B paths are modified/untracked and uncommitted. The pre-existing deleted historical reports and unrelated untracked documentation directories/files remain untouched and are not part of Phase 3B.

# Recommendation

Run the single ordinary post-tune Presentation Shuffle sanity check. Do not commit or push until that final human observation is recorded.
