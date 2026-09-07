# Phase 1-7 - First Light Classification Implementation Report

**Timestamp:** 2026-09-02 10:41:59 -06:00 (Calgary, Alberta; updated after failure-message fix)

# Stage

Browser Gallery Remote — Phase 1C: First Light Classification + Failure Isolation.

Implementation and automated gates are complete. Human browser evidence is pending. No final Phase 1C commit was created.

# Goal

Observe source-neutral media-element render outcomes, contain and honestly report remote-session load failures, freeze remote `.ts` unreachability upstream, and measure the three approved remote-load phases without optimization.

# Files Changed

- `src/main.js`
- `tools/test-remote-url-provider.mjs`
- `tools/remote-fixtures/09-broken-items.txt`
- `Reports and Docs/Codex Reports/Phase 1-7 - First Light Classification Implementation Report.md`

No protected provider, parser, runtime, TS adapter, HTML, CSS, profile, or storage file was changed.

# What Was Implemented

- Added a per-load, in-memory `{ mounted, loaded, failed }` tally at the shared viewer and thumbnail render seams.
- Added a trailing one-second, count-only console report using the source-neutral label `[MEDIA RENDER] Outcomes`.
- Added viewer staleness guards using `currentViewerNode` and thumbnail staleness guards using the captured `galleryGeneration`.
- Added the exact current-item failure message: `This item could not be loaded.` The existing next-item render path remains responsible for clearing it.
- After the human recheck confirmed that the sentence was not visible, corrected the existing empty-state interaction: a current-item error now hides `viewerStage` as well as showing `viewerEmpty`. The failed media element remains untouched in the stage; the next item still clears/rebuilds through the existing `buildViewer()` path.
- Covered both `file.text()` rejection and parse/provider loading errors with `That file could not be read.` and safe warning output.
- Cleared superseded remote status and stale remote/FSA status during source switches and Clear Media.
- Added count-only `parse_ms`, `provider_ms`, and `to_first_paint_ms` instrumentation around verified existing synchronous seams.
- Added upstream `.ts` exclusion tests, including uppercase, encoded-dot, query-string, and decoded-display-name cases.
- Added a deliberately dead fixture using only reserved `.invalid` hosts.

The gallery continues to lazy-mount thumbnails through its existing `IntersectionObserver`; that architecture was observed, not changed.

# What Was Explicitly Not Implemented

No retries, fallback sources, placeholder artwork, CORS/header/cookie/proxy work, failure taxonomy, performance optimization, remote TS support, user-facing diagnostics/count dashboard, structured or remembered sessions, durable remote identity, remote curation persistence, discovery integration, or Phase 2 preparation was implemented.

`finishLoadingItems()`, `MediaRuntime`, and `ts-playback-adapter.js` remain untouched.

# Tests Run

- `node --check src/main.js`
- `node tools/test-remote-url-provider.mjs`
- `node tools/test-remote-url-parser.mjs`
- `node tools/check-dom-contract.js`
- Every `tools/test-*.mjs` in an isolated process/job with a per-file timeout; long-running non-Phase-1C suites that exceeded 30 seconds were re-run with a 120-second cap.
- `git diff --check`

# Results

- JavaScript syntax: PASS.
- Remote URL provider: PASS — **51 assertions passed** (new exact freeze count).
- Remote URL parser: PASS — **35 assertions passed** (unchanged).
- DOM contract: PASS — **0 failure(s), 0 warning(s)**.
- Full suite: **68 total, 66 pass, 2 known pre-existing failures**.
  - `tools/test-ambient-decision-multitab.mjs` — known pre-existing assertion failure.
  - `tools/test-sync-v2-scheduler.mjs` — known pre-existing timeout/hang.
- Additional failures: none.
- `git diff --check`: PASS; only a line-ending advisory for the provider test was printed.

# Automated Acceptance Gates

| Gate | Result | Evidence |
|---|---|---|
| Provider invariant | PASS | 51 assertions |
| Frozen parser | PASS | 35 assertions |
| DOM contract | PASS | 0 failures, 0 warnings |
| Full Node suite | PASS against baseline | 66 pass, 2 known failures |
| Whitespace | PASS | `git diff --check` found no whitespace error |
| Authorized Phase 1C delta | PASS | Only the four authorized Phase 1C paths were edited/created |
| Browser behavior | AWAITING HUMAN | Runs A/B/C not performed by Codex CLI |

# Rendering Evidence Record

| Feature | Local | Remote image | Remote video | Notes |
|---|---|---|---|---|
| Gallery thumbnail | PASS | PASS | PASS | Runs A and B passed human browser recheck. |
| Viewer render | PASS | PASS | PASS | Runs A and B passed; repaired dead-item sentence still awaits one final visual recheck. |
| Previous / Next | PASS | PASS | PASS | Runs A, B, and C passed human browser recheck. |
| Presentation Mode | PASS | PASS | PASS | Runs A, B, and C passed human browser recheck. |
| Shuffle | PASS | PASS | PASS | Local and remote behavior passed human evidence. |
| Type filtering | PASS | PASS | PASS | Human evidence passed; structurally, `mediaType` mirrors `kind`. |
| Favorite / Hidden / Tag | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN — identity required (Phase 5). |
| Dead item survivability | UNKNOWN | PASS | PASS | Run C confirmed the session survives and good items continue. Failure-message repair awaits final visual recheck. Failed counts measure media-element attempts, not unique dead URLs. |

# Performance Measurements

The implementation emits one count-only `[REMOTE SESSION] Load phases` console record containing `parse_ms`, `provider_ms`, `to_first_paint_ms`, parsed count, and emitted-item count.

Actual browser values: **AWAITING HUMAN**. No values were fabricated and no performance interpretation or optimization was performed.

# Human Evidence Status

Run A — Local regression:  
**PASS**

Run B — Remote video:  
**PASS**

Run C — Dead-item survivability:  
**PASS**

Run C — Failure-message visibility:  
**FIX IMPLEMENTED — AWAITING FINAL HUMAN VISUAL RECHECK**

Minimum final browser checklist:

- Select a dead item and confirm `This item could not be loaded.` is visible.
- Press Next and confirm a good item renders.

# Regressions

No automated regression was found. Run A passed human local-render regression testing. The two full-suite failures exactly match the checkpoint baseline and were not investigated or changed.

# Known Unknowns

- Final human visual confirmation that the repaired dead-item sentence is visible.
- Actual render-outcome tallies; one dead URL may legitimately contribute multiple failed media-element attempts.
- Actual `parse_ms`, `provider_ms`, and `to_first_paint_ms` values.
- Favorite/Hidden/Tag semantics for remote items pending durable identity in Phase 5.
- Future ideas preserved but not built: Dead Item Auto-Skip (mark a failed item for the current session and auto-advance during active slideshow/Presentation/playback), remembered remote sessions, tighter lazy loading, concurrency control, current-media/visible-thumbnail prioritization, progressive loading, thumbnail scheduling, and cache-aware behavior.

# Breadcrumbs Added

One three-tier `BREADCRUMBS - WAS / IS / WILL BE` architectural block was added beside the source-neutral render-outcome tally. It records the verified local object-URL history, the current contained-failure invariant, upstream remote `.ts` exclusion, console-only evidence policy, deferred taxonomy/transport work, and the prohibition on pre-optimization.

# Git Status

Branch: `Cassette`  
Checkpoint: `83424ef phase 1b: add remote media provider and remote session entry point`

The pre-existing dirty baseline contained deleted historical reports and untracked `Reports and Docs/Claude Reports/`, `Reports and Docs/NA/`, and the two Remote-Cassette handoff documents. Those unrelated changes were not disturbed.

Phase 1C working changes are limited to the four paths listed under Files Changed. No files were staged, committed, or pushed.

# Recommendation

Implementation ready; automated gates complete; human evidence pending.

**STOP FOR HUMAN + CHATGPT COUNCIL REVIEW.**
