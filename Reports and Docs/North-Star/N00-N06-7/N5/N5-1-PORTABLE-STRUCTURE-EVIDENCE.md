# N5-1 — Portable Structure Evidence

**Verdict:** PASS
**Recorded:** 2026-08-27 12:14:49 MDT (`America/Edmonton`)

## Outcome

N5 adds a portable, content-corroborated MEDIA-ID evidence channel without adding Curation policy or implementing the N2 question.

- Completed media loads can publish a bounded, deterministic sample containing only relative paths and byte sizes.
- Evidence is attached to an existing shared Library ID; observing media never mints or silently binds a Library.
- Portable evidence has its own top-level `structure` replica map, local cache, merge path, and independently manifest-hashed SyncV3 `structure.json` file.
- Absolute paths, handles, local root IDs, local scope IDs, permission state, and undeclared fields are excluded by construction and rejected by the strict replica shape guard.
- Cross-device comparison reuses MEDIA-ID's existing T2 structural matcher, overlap/count thresholds, minimum corroboration, size-mismatch veto, and ambiguity refusal.
- `UNKNOWN`, contradicted, under-corroborated, and multiple-candidate results remain unresolved. No Curation is selected or written.
- Pre-N5 SyncV3 generations without `structure.json` remain readable; existing Profile, association, and Library facts retain their formats and merge behavior.

N5 now exposes a legitimate current-media-to-peer-Library candidate when portable content evidence is strong and unique. This removes the architectural dependency recorded by N2. N2 remains a separate policy/UX slice and was not implemented here.

## Automated verification

- Added `tools/test-n5-portable-structure.mjs` (21 focused assertions): deterministic serialization, leak prevention, strict validation, convergence, corroborated matching, ambiguity, vetoes, thresholds, and fact compatibility.
- Extended `tools/test-syncv3-transport.mjs` to prove the dedicated structure file, manifest declaration/hash, round trip, and tamper refusal.
- Ran every `tools/test-*.mjs` test with the repository browser-lock shim: **57 test files passed, 0 failed**. This includes SyncV2 compatibility, SyncV3 transport/merge/multitab behavior, and N3/N4 behavior.
- `git diff --check`: PASS.

## Changed implementation surface

- `src/storage/portable-structure-evidence.js`
- `src/storage/profile-sync-store.js`
- `src/profile/media-identity-matcher.js`
- `src/profile/sync-facts.js`
- `src/profile/sync-merge.js`
- `src/profile/sync-v3-transport.js`
- `src/profile/sync-v3.js`
- `src/profile/profile-store.js`
- `src/profile/local-state-channel.js`
- `src/main.js`
- `tools/test-n5-portable-structure.mjs`
- `tools/test-syncv3-transport.mjs`

No provider behavior, MEDIA-ID matching semantics, N3/N4 policy, or Curation resolution policy was changed. No commit or push was performed.
