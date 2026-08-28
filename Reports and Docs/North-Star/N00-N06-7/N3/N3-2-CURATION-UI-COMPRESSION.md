# North Star N3-2 — Curation UI Compression

**Recorded:** 2026-08-27 11:38:37 MDT (America/Edmonton, UTC-06:00)
**Status:** PASS

## Outcome

Ordinary Settings now presents one Curation concept when the folder's remembered Curation and this device's active Curation agree. The folder Curation status, Change Curation action, and Create Curation controls live together in that ordinary area.

The separate `This Device Is Using` selector is presentation-only conditional UI:

- aligned resolved state (`S2`) hides it because it would repeat the same Curation;
- actual divergence (`S3`) shows it because a customer decision depends on the distinction;
- unresolved, unavailable, and non-durable states retain it until Browser Gallery can resolve the state safely.

The underlying folder association and local Active Curation remain separate. Existing Profile IDs, `switchProfile`, creation behavior, Stage 08/09 policy, shared association facts, and advanced diagnostic/plumbing controls are unchanged.

`Reports and Docs/NORTH-STAR.md` now states that duplicate customer-facing representations retreat unless a real decision depends on the distinction.

## Automated verification

- N3-2 presentation/state contract: PASS — 14 assertions.
- Relevant Settings, vocabulary, association, safety, N3, and DOM contracts: PASS.
- Full repository suite: PASS — 55 test files, using the existing temporary `/tmp` Web Locks shim for the browser-writer environment.
- JavaScript syntax and `git diff --check`: PASS.
- SyncV3, MEDIA-ID, providers, and runtime: unchanged by N3-2.

No subjective human regression test is required; visibility is a deterministic mapping from association state and is covered automatically.

## Changed files

- `index.html`
- `src/main.js`
- `src/profile/association-copy.js`
- `Reports and Docs/NORTH-STAR.md`
- `tools/test-n3-curation-ui-compression.mjs`
- `Reports and Docs/North-Star/N3/N3-2-CURATION-UI-COMPRESSION.md`

No commit was created and nothing was pushed.
