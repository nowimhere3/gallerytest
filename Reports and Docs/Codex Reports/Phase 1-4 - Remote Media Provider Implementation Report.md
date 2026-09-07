# Phase 1-4 - Remote Media Provider Implementation Report

**Timestamp:** Wednesday, September 2, 2026 at 7:45 AM MDT (Calgary, Alberta)

# Stage

Phase 1B only: validated remote URL records enter Browser Gallery through a dedicated provider, the existing `finishLoadingItems(items)` seam, and the existing `MediaRuntime`.

# Goal

Convert Phase 1A's exact trimmed URL strings into the approved temporary Browser Gallery media-record shape, expose a minimal text-file entry point, prove runtime acceptance automatically, and stop before Phase 1C rendering work.

# Files Changed

Created:

- `src/providers/remote-url-provider.js`
- `tools/test-remote-url-provider.mjs`
- `tools/remote-fixtures/08-classification.txt`
- `Reports and Docs/Codex Reports/Phase 1-4 - Remote Media Provider Implementation Report.md`

Modified, as explicitly authorized:

- `src/main.js`
- `index.html`

No protected file was modified. In particular, `finishLoadingItems()`, `MediaRuntime`, the Phase 1A parser, local/FSA providers, duplicate filter, playback, profile, storage, CSS, and existing tests remain unchanged.

# What Was Implemented

- `RemoteUrlProvider` with `loadFromUrls(urls, options)`, copied `getItems()` results, disposal generation tokens, 250-item default batches, progress/batch callbacks, and browser/Node-safe frame yielding.
- Count-only `{ total, images, videos, skipped }` diagnostics with arithmetic frozen under test.
- Pathname-extension classification for the approved image and video lists. `.ts`, extensionless paths, trailing-slash paths, and unknown extensions are skipped.
- Exact approved item keys. `size`, `lastModified`, `file`, durable identity fields, and speculative metadata are absent.
- Session-local index IDs (`remote-N`) that never contain a complete URL.
- Temporary `remote://${url}` relative paths using the parser's exact URL string.
- Safe display-name derivation with guarded percent decoding and hostname fallback.
- Symmetric remote-provider disposal when switching to legacy input, switching to FSA, clearing media, and unloading.
- `loadRemoteSession()` with the approved state/identity-clearing preamble, count-only logging, ordinary-language status, and the unchanged `finishLoadingItems(result.items)` tail.
- One `.txt` file input and one status line in the existing Media Folders section, using existing CSS classes only.
- A synthetic classification fixture and a dependency-free 46-assertion provider suite, including parser-to-provider and real-`MediaRuntime` acceptance.

# What Was Explicitly Not Implemented

No `.ts` rendering guard, render repair, CORS/auth/proxy work, fetch/HEAD/probe/retry/cache behavior, MIME inference, durable remote identity, persistence, remembered library, structured session format, discovery integration, gallery-dl assumptions, new source kind, Profile/Curation change, CSS, download feature, or Phase 1C work was implemented.

# Tests Run

```text
node tools/test-remote-url-provider.mjs
node tools/test-remote-url-parser.mjs
node tools/check-dom-contract.js
all 68 tools/test-*.mjs files, isolated with a 120-second per-file timeout
git diff --check
```

# Results

- Provider suite: `remote URL provider: 46 assertions passed`.
- Phase 1A parser regression: `remote URL parser: 35 assertions passed`.
- DOM contract: 60 JavaScript files, 271 unique IDs, 257 `getElementById` targets; `0 failure(s), 0 warning(s)`.
- Full suite: 68 total, 66 passed, 2 failed.
- The two failures exactly match the documented pre-existing baseline:
  - `tools/test-ambient-decision-multitab.mjs`: `observer takes no row-projection input`.
  - `tools/test-sync-v2-scheduler.mjs`: timed out after 120 seconds; its last output reached scheduler checks 10/11 and 12.
- New failures: none.
- `git diff --check`: no whitespace errors; Git emitted only its existing Windows LF-to-CRLF working-copy warning for `index.html`.

The provider test initially assumed sequential `MediaRuntime.next()` behavior. The real runtime correctly revealed that shuffle is enabled by default. The test was corrected to call the existing `runtime.setShuffle(false)` before asserting deterministic next/previous order; no runtime or provider change was needed.

Two preliminary full-suite wrapper attempts were invalid because this PowerShell environment rejected their process-launch/argument handling. Their outputs were discarded. The reported 66/2 totals come only from the valid isolated run.

# Automated Acceptance Gates

- Remote provider suite: PASS.
- Phase 1A parser remains exactly 35 assertions: PASS.
- DOM contract has zero failures and zero warnings: PASS.
- Real `MediaRuntime` accepted six parser/provider-produced remote items and passed total/current/next/previous assertions: PASS.
- Full suite matches the documented 66-pass/2-known-failure Phase 1B expectation after adding the new passing suite: PASS.
- Only authorized Phase 1B code paths and new files differ from the checkpoint, in addition to the untouched dirty-tree baseline: PASS.
- Automated Phase 1B gates: PASS.

# Human Smoke Test Status

**AWAITING HUMAN TEST.** No claim is made that browser/file-picker or rendering behavior has been manually verified.

Recommended human checklist:

- Choose Files loads local media.
- Choose Folder loads local media.
- Choose Folder (FSA) loads local media.
- Gallery thumbnails, Next/Previous, Presentation Mode, and existing local playback work.
- Local-to-remote and remote-to-local switches leave no stale items.
- Open Remote Session accepts a synthetic `.txt` fixture and reports honest counts.

Use a scratch Profile for Phase 1B testing. Favorites, Hidden, and Tags are outside this stage; clicking them on remote items can write temporary `remote://https://…` curation keys that will sync. Those keys cannot collide with local relative paths, but they are intentionally not durable and may become inert data.

# Regressions

No new automated regression was detected. The two full-suite failures are the named pre-existing baseline failures. Browser-gesture and local-media regression checks remain awaiting human smoke testing.

# Known Unknowns

- Actual remote image/video rendering was not tested and is not a Phase 1B gate; no incidental rendering evidence was observed.
- Remote `.ts` remains structurally skipped pending Phase 1C safety work.
- Extensionless and unknown media remain skipped without network probing.
- `currentSourceKind` intentionally remains `"none"`, so the temporary `No Media Folder loaded.` copy can appear during a remote session.
- Temporary URL-derived curation keys are not durable identity.

# Breadcrumbs Added

`src/providers/remote-url-provider.js` contains all three required tiers:

- `BREADCRUMBS - WAS`: verified local File/object-URL creation and revocation ownership.
- `BREADCRUMBS - IS`: sole URL-to-media-record ownership, no minted URLs, source-neutral runtime, extension-only classification, and explicit non-responsibilities.
- `BREADCRUMBS - WILL BE`: `.ts` exclusion, absent duplicate metadata, temporary identity, inert source-kind/copy debt, future disposal ownership, and discovery remaining upstream.

# Remembered-Library Safety / Grep Evidence

The inspected `loadRemoteSession()` block contained zero matches for every forbidden remembered-library/profile function:

```text
addLegacyLibrary: 0 matches
recordLibraryLoaded: 0 matches
touchLibrary: 0 matches
recordPortableStructureForLoad: 0 matches
beginMediaIdentityForLoad: 0 matches
startMediaIdentitySeeding: 0 matches
establishAmbientProfileContext: 0 matches
switchProfile: 0 matches
```

Its only `activeLibraryRecord` assignment is:

```js
activeLibraryRecord = null;
```

Remote disposal is present in all four required directions/sites: legacy load, FSA load, Clear Media, and `beforeunload`.

# Git Status

## Pre-existing baseline

The start remained the acknowledged dirty tree: 21 deleted tracked report files plus four unrelated untracked paths (`Reports and Docs/Claude Reports/`, `Reports and Docs/NA/`, and the two Remote Cassette governing documents). Codex did not restore, delete, edit, stage, stash, or otherwise alter those items.

## Codex Phase 1B changes

Relative to checkpoint `839983b`, Codex modified only `src/main.js` and `index.html`, and added only the provider, provider test, classification fixture, and this report. The ending tree deliberately remains uncommitted for the human smoke gate. No Phase 1B file was staged or committed.

# Recommendation

Automated Phase 1B acceptance gates pass. Perform the human smoke test under a scratch Profile. If it passes, authorize the isolated commit `phase 1b: add remote media provider and remote session entry point`. Do not begin Phase 1C until Architect and council review.
