# Phase 3-2 - Held Frame Implementation Report

**Timestamp:** 2026-09-02 15:46:08 -06:00 (Calgary, Alberta)

# Stage

Browser Gallery Remote — Phase 3A: Held Frame and Transition Instrumentation.

Claude accidentally began the implementation due to an agent-routing error. Codex subsequently audited the preserved working tree against the approved Phase 3-1 handoff and completed/verified the Builder work. The preserved implementation required no corrective code change.

Implementation and automated gates are complete. Human evidence is **PENDING HUMAN TEST**. No commit or push was performed.

# Goal

For image-to-image transitions, keep the outgoing image visible while the incoming image loads and best-effort decodes, then replace it in one synchronous commit. This changes the visible wait from a black stage to a held frame; it does not make the origin, network, decode, or Browser Gallery dispatch faster.

# Files Changed

- `src/main.js`
- `src/runtime/viewer-commit.js`
- `tools/test-viewer-commit.mjs`
- `Reports and Docs/Codex Reports/Phase 3-2 - Held Frame Implementation Report.md`

The known unrelated dirty baseline remains untouched. No protected file or function was modified; in particular, `MediaRuntime`, providers, storage, profile code, TS playback, `index.html`, `styles.css`, `finishLoadingItems()`, `loadRemoteSession()`, and the body of `clearViewerNode()` remain unchanged.

# What Was Implemented

- Added an image-to-image held-frame dispatch before eager teardown.
- Starts the incoming image request while the outgoing image remains mounted.
- Treats `load` as the readiness authority and `decode()` as best-effort refinement only.
- Commits teardown and insertion in one synchronous block through the existing `clearViewerNode()` teardown owner.
- Added a pure `shouldCommitPreparedViewer()` predicate requiring all four facts to match:
  - preparation token;
  - `libraryLoadGeneration`;
  - `galleryGeneration`; and
  - item object identity.
- Claims `currentViewerItem` eagerly during preparation, preventing duplicate preparation on same-item re-emits while leaving `currentViewerNode` pointing to the visible outgoing image.
- Silently discards stale preparations by clearing only the prepared image's `src`; discarded work changes no viewer DOM, classes, status, current item/node, or outcome tally.
- Converges a current failed preparation onto the existing Phase 1C failure sentence and hidden-stage behavior.
- Leaves every non-image→image case on the existing eager path, including first render, image/video crossings, video→video, and recovery from a hidden failure state.
- Added source-neutral transition instrumentation for `dispatch_to_src_ms`, `src_wait_ms`, `decode_ms`, `blank_ms`, `ready_ms`, held-path use, and hostname-only source evidence.
- Added a rolling 10-transition median/p90 summary reset across `libraryLoadGeneration` changes.
- Applied Phase 3A-2 viewer-before-gallery ordering inside the same synchronous `render()` call.

The render-order change was retained after verifying that `renderGallery()` mutates only gallery state/DOM not read by `buildViewer()`, while `syncGalleryJumpTarget()` and `syncNowPlayingStrip()` do not depend on the former ordering. It is a small, low-risk, regression-tested ordering correction whose measured opportunity is sub-millisecond—not the performance fix.

# What Was Explicitly Not Implemented

No shuffle lookahead, Ready Queue, future-item preload, MediaRuntime planning, second RNG path, video readiness, Dead Item Auto-Skip, spinner/progress/acknowledgment cue, UI redesign, retry, network optimization, gallery optimization, or Phase 3B work was implemented.

There is no `if (remote)` path. Local `blob:` and remote `https:` images use the same held-frame mechanism.

# Tests Run

```text
node --check src/main.js
node tools/test-viewer-commit.mjs
node tools/test-remote-url-parser.mjs
node tools/test-remote-url-provider.mjs
node tools/test-cassette-registry.mjs
node tools/check-dom-contract.js
node tools/test-shuffle-modes.mjs
node tools/test-pm-shuffle-folders.mjs
node tools/test-startup-media.mjs
node tools/test-streamloop-autofill.mjs
all tools/test-*.mjs in isolated jobs with a 120-second per-file timeout
git diff --check
```

# Results

- JavaScript syntax: PASS.
- Viewer commit predicate: **16 assertions passed**.
- Remote URL parser: **35 assertions passed**.
- Remote URL provider: **51 assertions passed**.
- Cassette registry: **33 assertions passed**.
- DOM contract: **0 failure(s), 0 warning(s)** across 62 JavaScript files and 273 unique ids.
- Shuffle modes: **20 assertions passed**.
- Presentation Shuffle Folders: **146 assertions passed, 0 failures**.
- Startup media: **107 assertions passed**.
- StreamLoop Auto Fill: **26 assertions passed**.
- Full suite: **70 total, 68 pass, 2 known pre-existing failures**.
  - `tools/test-ambient-decision-multitab.mjs` — known pre-existing assertion failure.
  - `tools/test-sync-v2-scheduler.mjs` — known pre-existing timeout/hang.
- Additional failures: none.
- `git diff --check`: PASS.

The pure test freezes the B/C race explicitly: B starts, C supersedes it, C may commit while B must reject even if B settles last. It also proves each of the token, load-generation, gallery-generation, and identity guards independently rejects stale work.

# Before / After Transition Evidence

The settled pre-change human baseline over 25 real Remote Cassette transitions was:

| Metric | Pre-change median | Phase 3A post-change |
|---|---:|---:|
| Application dispatch (`advance_to_src_ms`) | ~0.8 ms | Expected substantially unchanged |
| Resource wait (`src_to_load_ms` / `src_wait_ms`) | ~4647 ms | Expected unchanged; Phase 3A does not accelerate the resource |
| Ready (`advance_to_ready_ms` / `ready_ms`) | ~4665 ms | Expected unchanged; rAF remains only a readiness proxy, not paint |
| **Black/blank gap (`black_gap_to_ready_ms` / `blank_ms`)** | **~4664 ms** | **PENDING HUMAN TEST; designed to collapse toward one synchronous swap/frame on held image→image transitions** |

The authorized claim after implementation is structural: the outgoing image remains mounted throughout `src_wait_ms`, and outgoing teardown plus prepared-image insertion occur without an intervening `await`. The customer should no longer look at black while waiting, but real visual confirmation and post-change console measurements remain pending.

Instrumentation uses honest boundaries: `dispatch_to_src_ms` begins at `render()` entry rather than the click/timer; `src_wait_ms` is not labeled network latency; and the rAF-derived `ready_ms` is not called paint time.

# Regressions

No automated regression was found. Video construction/playback code remains on the eager path and was not changed. Local image behavior and real Presentation navigation remain pending the two minimal browser runs.

# Known Unknowns

- Whether the black frame is visually gone for the tested real Remote Cassette.
- Actual post-change `blank_ms`, `src_wait_ms`, and `ready_ms` observations.
- Whether several rapid manual Next actions feel adequately acknowledged while the prior frame remains held; no cue was pre-built.
- Human confirmation that shuffle navigation remains correct.
- Human confirmation that remembered local-folder image transitions remain correct.

# Breadcrumbs Added

The three-tier `BREADCRUMBS - WAS / IS / WILL BE` block at the held-frame seam records:

- the verifiable eager-teardown history and measured ~4.65-second blank baseline;
- the current source-neutral held-frame, four-guard commit, silent discard, and Phase 1C failure convergence contract; and
- the deliberate exclusion of lookahead, queues, extra RNG authority, MediaRuntime changes, CPU cleanup, and video readiness from Phase 3A.

The new pure predicate module separately documents why each of the four commit facts is independently load-bearing.

# Git Status

Branch: `Cassette`  
Committed baseline: `45f471b phase 2a: remember and reopen remote cassettes by file handle`

Phase 3A working changes are limited to the four authorized paths listed above. The pre-existing dirty baseline consists of deleted historical report files plus untracked `Reports and Docs/Claude Reports/`, `Reports and Docs/NA/`, and the two Remote-Cassette founding documents; it remains untouched.

The new module, test, and report remain untracked until the later authorized commit, so ordinary `git diff --name-only` lists only tracked `src/main.js` plus the unrelated pre-existing deletions. No Phase 3A path is staged, committed, or pushed.

# Recommendation

Implementation ready; takeover audit and automated gates complete; human evidence pending.

Run exactly the two approved minimal checks, then return the evidence for the Phase 3A gate. Do not begin Phase 3B.

**STOP FOR HUMAN TEST.**
