# N1-2 — Implementation Report

**Calgary, Alberta, Canada**
**Thursday, August 27, 2026 — 10:16 AM MDT**
**Phase:** Browser Gallery North Star N1 — Progressive Disclosure
**Verdict:** PASS

## N1 verdict

North Star N1 passed. The ordinary Settings path no longer exposes Media Library identity administration or Media Library vocabulary. The complete identity-management surface remains available in Advanced Settings, backed by the original semantic state and handlers.

The ordinary customer path is now:

```text
Choose Folder → Choose Curation → Done
```

## Files changed

### Production presentation

- `index.html`
- `src/main.js`
- `src/profile/association-copy.js`
- `src/profile/contextual-first-use.js`
- `src/profile/link-state.js`
- `src/storage/library-registry.js` — approved comment-only FUTURE breadcrumb beside `ensureLibraryId()`

### Tests

- `tools/test-media-library-disclosure.mjs` — new exhaustive N1 disclosure test
- `tools/test-association-copy.mjs`
- `tools/test-contextual-first-use.mjs`
- `tools/test-media-library-selection.mjs`
- `tools/test-profile-sync-hierarchy.mjs`
- `tools/test-profile-sync-polish.mjs`
- `tools/test-profile-vocabulary.mjs`
- `tools/test-safety-reassurance.mjs`
- `tools/test-settings-compression.mjs`

The pre-existing `README.md` and `docs/` North Star documentation changes were preserved and were not modified by the N1 implementation.

## Implementation summary

- Added the pure sibling presentation function `describeMediaLibrarySurface({ linkState, surface })` beside `mapLinkState()`.
- Kept `mapLinkState()` byte-identical to HEAD.
- Routed disclosure exclusively from link state; peer, Sync, and catalog signals do not control ordinary visibility.
- Reused the existing Media Library DOM controls, semantic state, and handlers inside Advanced Settings rather than creating a second implementation.
- Added the approved North Star breadcrumbs at the disclosure seam, ordinary render path, first-use introduction, and `ensureLibraryId()`.

## Presentation changes

- Ordinary Settings never shows the Media Library selector, create/name controls, link/use controls, unlink/remove controls, or identity administration.
- Ordinary Settings contains zero occurrences of “Media Library” in every L0–L7 state.
- The former ordinary “This Media Folder” and “This Media Library” areas are combined into one quieter customer-facing media area.
- Curation remains prominent and uses folder-facing customer language.
- L5 remains visible as: “Browser Gallery can't find this folder's saved setup yet.”
- L7 retains “Reconnect Media Folder” and reassures: “Your setup is safe.”
- Advanced Settings retains precise Media Library status, selector, creation/name capability, linking, unlinking, conflict detail, and diagnostic terminology.
- The first-use introduction was reduced from five steps to three concepts: media, Curation, and Sync.
- The trust reassurance that Browser Gallery does not upload, move, or copy media was preserved.
- The ordinary Help path remains aligned with the simpler customer mental model; Media Library background belongs to Advanced diagnostics.

## Invariants preserved

- `setLibraryAssociation()` still reaches `ensureLibraryId()` and silently mints shared identity when a Curation is chosen.
- `recordLibraryLoaded()` still never mints shared identity.
- Opening a folder alone still does not mint `libraryId`.
- `mapLinkState()` is byte-identical and its L0–L7 semantics are unchanged.
- Stage 08 claimant guard and direct-relink refusal semantics are unchanged.
- Stage 09 ambient, load-time, suppression, and no-decision-rearm semantics are unchanged.
- Stale/unavailable Curation behavior is unchanged.
- MEDIA-ID semantics are unchanged.
- SyncV2 and SyncV3 facts, merge, transport, writer policy, replica, and published-byte semantics are unchanged.
- Providers and runtime are unchanged.
- Disclosure is independent of peers, `v3Peers`, `syncConnected`, `v3Configured`, and shared-catalog presence.

## Tier 2 test changes

- `test-association-copy.mjs` — folder-facing wording now protects the same Curation action without plumbing vocabulary.
- `test-contextual-first-use.mjs` — five-step architecture teaching was replaced by the approved three customer concepts.
- `test-media-library-selection.mjs` — selector/create/link/unlink protections now target the Advanced surface.
- `test-profile-sync-hierarchy.mjs` — the separate folder/library groups were replaced by the combined ordinary media area.
- `test-profile-sync-polish.mjs` — the rail Curation context now names the folder.
- `test-profile-vocabulary.mjs` — ordinary zero-vocabulary containment was added while diagnostic vocabulary remains Advanced.
- `test-safety-reassurance.mjs` — Curation reassurance now uses customer-facing folder language.
- `test-settings-compression.mjs` — contextual Media Library Help and controls are proven Advanced-only.

All Tier 1 semantic tests remained byte-unchanged.

## Automated test results

- Changed-JavaScript syntax checks: PASS
- New N1 disclosure matrix, L0–L7 × ordinary/Advanced: PASS
- Ordinary selector containment: PASS
- L5/L7 customer-language status and L7 recovery: PASS
- Peer-independent disclosure checks: PASS
- Silent `libraryId` minting and no-mint-on-load checks: PASS
- Eight legitimately modified Tier 2 presentation tests: PASS
- Tier 1 semantic tests: PASS and byte-unchanged
- Full automated suite: PASS — 53/53 tests
- Stage 09 regression gate: PASS
- DOM contract: PASS — 0 failures, 0 warnings
- `git diff --check`: PASS
- Protected sync, transport, ProfileStore, provider, and runtime diff audit: PASS — no changes

The test host did not provide Node.js or browser Web Locks initially. Portable Node runtimes and a temporary `/tmp` Web Locks test shim matching the repository's existing fake-lock semantics were used only to execute the gates. No runtime or shim file was added to the repository.

## Browser Preview readiness

Browser Preview is ready for the final small visual eyeball.

Default human check:

```text
1. Open/load one normal durable Media Folder
2. Open Settings
3. Choose/confirm its Curation if needed
4. Look at the page
```

The human is checking only that Settings feels dramatically quieter and that ordinary Media Library plumbing is absent.

No additional manual check is required. Stage 09, multi-device, permission-revocation, claimant-collision, and legacy-picker matrices are already covered by deterministic tests and do not need manual repetition.

## Git state

- Implementation and tests are present in the working tree.
- Existing North Star `README.md` and `docs/` changes are preserved.
- No unexpected files were touched.
- No commit was created.
- Nothing was pushed.

```text
N1-2 IMPLEMENTATION REPORT: PASS
NORTH STAR N1: PASS
READY FOR USER EYEBALL: YES
ADDITIONAL MANUAL CHECK REQUIRED: NO
REPORT PATH: Reports and Docs/North-Star/N1-2-IMPLEMENTATION-REPORT.md
COMMITTED: NO
PUSHED: NO
```
