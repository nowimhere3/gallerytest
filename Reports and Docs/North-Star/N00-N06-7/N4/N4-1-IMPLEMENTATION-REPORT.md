# North Star N4 — Reverse Suggestion

**Recorded:** 2026-08-27 11:56:17 MDT (America/Edmonton, UTC-06:00)
**Status:** PASS

## Outcome

N4 now offers one quiet, customer-language proposal when the current unassociated FSA folder is a proven parent of known folders whose available Curation associations unanimously identify one Curation:

> Folders inside this one use BEAST. Use that Curation here too?

The policy is above MEDIA-ID and reads only durable same-device scope membership and proven prefix containment. Names never establish ancestry. Roots outside the proven scope, absent evidence, unavailable Curations, conflicting descendants, any existing parent association (including an explicit shared `null`), and loads reporting deferred scope merges all decline to suggest.

Candidate production has no association or Active Curation writer. Even unanimous descendants only arm an ephemeral proposal for the current load.

## Actions

- **YES** revalidates the current root, descendant evidence, unanimity, Curation availability, and association vacuum at click time, then writes through the existing durable association boundary. It does not alter Stage 09 or silently switch the local Active Curation.
- **NO** performs no write and retires the proposal for the current folder/load context, so it cannot immediately reappear.
- A stale proposal performs no write and retreats.

N3 downward inheritance remains earlier in the load-time policy and unchanged. An N3 result suppresses N4 for that load.

## Automated verification

- N4 focused policy/action/integration contract: PASS — 16 assertions.
- N3 and N3-2 focused regressions: PASS.
- Relevant association, Settings, vocabulary, hierarchy, and safety contracts: PASS.
- Full repository suite: PASS — 56 test files, using the existing temporary `/tmp` Web Locks shim for the browser-writer environment.
- JavaScript syntax and `git diff --check`: PASS.
- SyncV3 facts/transport, MEDIA-ID evidence semantics, providers, and runtime: unchanged by N4.

No human regression test is required; candidate eligibility, proposal-only behavior, and both response paths are deterministic and automated.

## Changed files

- `index.html`
- `src/main.js`
- `src/profile/reverse-curation-suggestion.js`
- `tools/test-n4-reverse-suggestion.mjs`
- `Reports and Docs/North-Star/N4/N4-1-IMPLEMENTATION-REPORT.md`

No commit was created and nothing was pushed.
