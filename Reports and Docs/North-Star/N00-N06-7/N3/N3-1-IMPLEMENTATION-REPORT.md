# North Star N3 — Proven Parent Inheritance

**Recorded:** 2026-08-27 11:20:35 MDT (America/Edmonton, UTC-06:00)
**Status:** PASS

## Outcome

N3 now applies the nearest proven ancestor's Curation once when an FSA folder has no shared association fact and no local folder association of its own.

The policy is implemented above MEDIA-ID. It reads only durable same-device scope membership and proven prefix containment; it does not probe handles, infer from names, reinterpret `UNKNOWN`, or alter MEDIA-ID evidence semantics. An explicit shared fact (including explicit `null`) or local folder association vetoes inheritance. Unavailable Curations and unrelated or absent scope evidence also decline to conclude.

The inherited choice is written through the existing durable association boundary and the Curation is switched before the first projection is built. This makes inheritance a one-time remembered association rather than a reactive parent/child link. Any later explicit choice for the child uses the existing higher-precedence association path and wins normally.

A slow structural rebase that exceeds the existing first-render budget declines N3 for that load instead of switching a live session; its durable proof is available on the next load.

## UX

No question or identity-plumbing UI was added. A successful inheritance adds one brief acknowledgement in customer language: the Curation was remembered from a parent folder.

## Automated verification

- N3 focused policy/integration contract: PASS — 14 assertions.
- Full repository suite: PASS — 54 test files. Five browser-writer suites were rerun with the existing temporary `/tmp` Web Locks shim because the test host does not expose browser Web Locks; all passed.
- JavaScript syntax checks: PASS.
- `git diff --check`: PASS.
- SyncV3 facts/transport diff audit: PASS — no changes.

No duplicate human regression testing is required; the N3 decision and integration contracts are deterministic and automated.

## Files

- Added `src/profile/parent-curation-inheritance.js`.
- Updated `src/main.js` at the load-time policy seam.
- Updated association-boundary comments in `src/profile/profile-store.js` and `src/storage/library-registry.js` to include approved deterministic N3 inheritance.
- Added `tools/test-n3-parent-inheritance.mjs`.

No commit was created and nothing was pushed.
