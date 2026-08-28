# N2-2 — Device-Aware Human Questions

**Verdict:** PASS
**Recorded:** 2026-08-27 12:29:30 MDT (`America/Edmonton`)

## Outcome

N2 is complete. An unassociated current FSA folder may now receive one quiet human question when N5 identifies exactly one strong, content-corroborated peer-Library candidate:

> **Is this the same media you use on Chromebook Pro?**

Candidate production is policy above MEDIA-ID. It uses N5's existing matcher and refusal verdicts without changing evidence semantics or thresholds. Peer presence, catalog presence, folder/catalog names, and device names do not participate in identity matching. The source device fact is joined only after a strong unique match; `resolveDeviceName()` is then used only to present that legitimate candidate.

Existing local/shared identity and Curation associations outrank N2. Same-device candidates, unavailable Curations, weak evidence, contradictions, and multiple candidates stay quiet. N3 automatic inheritance and N4 reverse suggestion retain precedence and behavior.

Candidate production has no writer. **YES** revalidates the current folder and N5 evidence at click time, then uses the existing Stage 08 claimant-guarded `linkLocalLibraryToShared` boundary. The already-synchronized association supplies the Curation, which is activated as the explicit result of YES. **NO** writes nothing and retires the proposal for the current load/context, so it cannot immediately nag again.

## Automated verification

- Added `tools/test-n2-device-aware-media-question.mjs` with **17 assertions** covering strong unique evidence, peer-presence refusal, weak/ambiguous/contradicted evidence, name independence, existing-association precedence, same-device refusal, unavailable Curation, YES/NO, stale revalidation, guarded link integration, presentation-only device naming, and customer vocabulary.
- Ran every `tools/test-*.mjs` test: **58 test files passed, 0 failed**.
- Focused N3, N4, SyncV3 shared-catalog, and same-device multitab suites passed unchanged.
- `git diff --check`: PASS.

## Changed files

- `index.html`
- `src/main.js`
- `src/profile/device-aware-media-question.js`
- `tools/test-n2-device-aware-media-question.mjs`
- `Reports and Docs/North-Star/N2/N2-2-DEVICE-AWARE-HUMAN-QUESTIONS.md`

No MEDIA-ID/N5 evidence semantics, SyncV3 facts or transport, Stage 08 claimant rules, or Stage 09 decision rules were changed. No commit or push was performed.
