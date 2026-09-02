# Phase 2-2 - Remembered Cassette Foundation Implementation Report

**Timestamp:** 2026-09-02 14:47:19 -06:00 (Calgary, Alberta; updated after human evidence)

# Stage

Browser Gallery Remote — Phase 2A: Remembered Cassette Foundation.

Implementation, automated testing, and the real-browser persistence gate are complete. **PHASE 2A: PASS.**

# Goal

Determine whether Browser Gallery can remember the location of a Remote Cassette as a `FileSystemFileHandle`, retain it through IndexedDB, and reopen the file later through the unchanged Phase 1 remote-session loader. The full-browser-restart gate passed in the tested Chromium environment.

# Files Changed

- `src/storage/cassette-registry.js` — new isolated cassette registry.
- `tools/test-cassette-registry.mjs` — new registry contract suite.
- `src/main.js` — cassette picker, remembered list, fresh reopen path, and independent capability-gated boot rendering.
- `index.html` — the authorized Add Remote Cassette control and Remote Cassettes list container.
- `Reports and Docs/Codex Reports/Phase 2-2 - Remembered Cassette Foundation Implementation Report.md` — this report.

No protected file was changed. `finishLoadingItems()` and `loadRemoteSession()` remain unchanged.

# What Was Implemented

- Added IndexedDB database `loop-browser-gallery-cassettes`, version 1, with store `cassettes` and key path `id`.
- Added exactly the four approved registry operations: `listCassettes()`, `addOrUpdateCassette(handle)`, `touchCassette()`, and `removeCassette()`.
- Persisted exactly six record keys: `id`, `sourceKind`, `name`, `handle`, `lastOpenedAt`, and `createdAt`.
- Added `isSameEntry()` deduplication that continues scanning when comparison against a stale row throws.
- Added deterministic ordering by `lastOpenedAt` descending and then `id` ascending.
- Preserved the existing universal, one-shot Open Remote Session input unchanged.
- Added Add Remote Cassette using `showOpenFilePicker()` directly from its click handler.
- Added an independent `showOpenFilePicker` capability check. Unsupported browsers hide the new button and list without reading the registry; Open Remote Session remains available.
- Added metadata-only remembered-list rendering with existing classes and `textContent` for filesystem names. Rendering performs no permission or file access.
- Added explicit-click permission query/request, fresh `handle.getFile()` and `file.text()` on every reopen, registry touch, and convergence on the existing `loadRemoteSession(text, { name })`.
- Added hard-delete removal. Permission and file failures leave the remembered row intact.
- Used a separate small cassette boot IIFE because directory-picker capability and file-picker capability are independent; `initFsaLibraries()` intentionally returns early when directory FSA is unavailable.

Stored cassette names refresh when the same handle is explicitly added again. Ordinary reopen does not silently rewrite the saved name.

# What Was Explicitly Not Implemented

No startup/boot cassette selection, Local/Remote/Both source setting, eligible cassette preferences, Advanced Settings work, StreamLoop changes, UI redesign, folder-of-cassettes scanning, durable remote identity, Favorites/Hidden/Tags semantics, gallery-dl integration, Dead Item Auto-Skip, retries, proxy/CORS work, or performance work was implemented.

No cassette contents, parsed URL array, or item count is cached. No local-library registry or association API participates.

# Tests Run

```text
node tools/test-cassette-registry.mjs
node tools/test-remote-url-parser.mjs
node tools/test-remote-url-provider.mjs
node tools/check-dom-contract.js
node --check src/main.js
node tools/test-startup-media.mjs
node tools/test-boot-restore.mjs
node tools/test-pm-shuffle-folders.mjs
node tools/test-streamloop-autofill.mjs
all tools/test-*.mjs in isolated jobs with a 120-second per-file timeout
git diff --check
```

The cassette separation grep inspected executable lines in `src/storage/cassette-registry.js` and the bounded new cassette functions in `src/main.js` for calls to:

```text
addOrUpdateLibrary listLibraries touchLibrary addLegacyLibrary
recordLibraryLoaded recordPortableStructureForLoad beginMediaIdentityForLoad
startMediaIdentitySeeding establishAmbientProfileContext switchProfile
setLibraryProfile ensureLibraryId loadFromFsaHandle resumeLibrary
```

Exact result:

```text
main cassette code paths: 0 forbidden call(s)
cassette registry executable code: 0 forbidden call(s)
```

# Results

- Cassette registry: **33 assertions passed**.
- Remote URL parser: **35 assertions passed**.
- Remote URL provider: **51 assertions passed**.
- DOM contract: **0 failure(s), 0 warning(s)** across 61 JavaScript files and 273 unique DOM ids.
- `node --check src/main.js`: PASS.
- `test-startup-media.mjs`: PASS — 107 assertions.
- `test-boot-restore.mjs`: PASS — 24 assertions.
- `test-pm-shuffle-folders.mjs`: PASS — 146 assertions, 0 failures.
- `test-streamloop-autofill.mjs`: PASS — 26 assertions.
- Full suite after adding the new cassette test: **69 total, 67 pass, 2 known pre-existing failures**.
  - `tools/test-ambient-decision-multitab.mjs` — known pre-existing assertion failure.
  - `tools/test-sync-v2-scheduler.mjs` — known pre-existing timeout/hang.
- New failures: none.
- `git diff --check`: PASS. Git emitted only an `index.html` LF-to-CRLF advisory, not a whitespace error.

# Handle Persistence Evidence

## Automated evidence

**PASS:** the real registry module stores and retrieves a fake file handle through the repository's existing `installFakeIndexedDB()` environment. The round-tripped handle retains `isSameEntry()` identity, deduplication works, and the cassette database/store are isolated from `loop-browser-gallery-fsa`.

This proves the module's IndexedDB contract in the automated environment. It does not prove that Chromium persists a real host `FileSystemFileHandle` through a complete browser restart.

## Human evidence

Run A1 — Local sanity: **PASS**. One existing remembered FSA folder opened normally; media rendered and basic navigation worked.  
Run A2 — Phase 1 Remote sanity: **PASS**. The existing one-shot Open Remote Session path continued to load `.txt` remote media successfully.  
Run B — Add and reopen in the same browser session: **PASS**. The cassette loaded immediately after being added; after page reload, its remembered row remained and reopened successfully.  
Run C — Full browser restart persistence gate: **PASS**. Chrome was completely exited and restarted. The row remained listed, clicking it required **no permission prompt**, and the cassette loaded successfully.  
Run D — Live re-read after external cassette edit: **PASS**. The externally edited cassette changed from 3 URLs to 7 URLs, and reopening loaded the new count of 7.

On the tested Chromium environment, a real persisted `FileSystemFileHandle` survived a complete browser restart and successfully reopened the current contents of the remembered cassette without requiring a new permission prompt.

# Regressions

No automated regression was found. The Phase 1 parser/provider counts are unchanged, the DOM contract remains clean, the four specifically protected startup/shuffle/StreamLoop tests pass, and the complete suite has only the two acknowledged baseline failures.

Human testing found no local-folder or one-shot Remote Session regression.

# Known Unknowns

- Portability beyond the tested Chromium environment. Phase 2A does not establish handle persistence or permission behavior in other browsers, operating systems, profiles, or storage configurations.
- Whether future browser policy or customer permission changes alter post-restart behavior.

# Breadcrumbs Added

The new registry begins with `BREADCRUMBS - WAS / IS / WILL BE` documenting:

- the verifiable history of remembered directory handles and one-shot remote files;
- the cassette registry's sole persistence ownership and strict no-read/no-permission/no-DOM boundary;
- why its database is isolated from every local-library consumer;
- why removal is a hard delete;
- why profile/library identity, signatures, counts, and cached contents remain absent;
- why startup selection belongs above this module in Phase 2B; and
- why a future folder-of-cassettes concept would require a new source kind rather than contaminating the local-library registry.

# Git Status

Branch: `Cassette`  
Approved baseline: `75eee33 phase 1c: observe remote render outcomes and close the remote failure path`

Phase 2A working changes are limited to the five authorized paths listed above. The pre-existing dirty baseline of deleted historical reports and untracked handoff/report directories remains present and untouched. New files do not appear in `git diff --name-only` until tracked, but are visible in `git status --short`.

No files were staged, committed, pushed, restored, moved, or deleted.

# Recommendation

**PHASE 2A: PASS.** Close Phase 2A. The remembered cassette foundation passed its automated checks, minimal regression checks, same-session reopen test, full Chrome restart gate, and live reread test.

Do not begin Phase 2B without separate authorization.
