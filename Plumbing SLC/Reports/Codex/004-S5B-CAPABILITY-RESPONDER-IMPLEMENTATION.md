<!-- sideline-provenance: {"gameId":"game_git_7b79a141","clientRef":"ref_1793552510073_039a2aa3","playerInstanceId":"codex-f64abdd7","playerType":"codex","provider":"codex","model":"gpt-6.1-sol","effort":"medium","at":"2026-11-01T17:01:50.076Z"} -->
<!-- sideline-work: {"work":["CHECK","BUILD"],"tags":["S5B","StreamLoop","capability-handshake"]} -->
# S5B — Browser Gallery Capability Responder

Recorded: Sunday, November 1, 2026 — 10:14 AM -07:00 (Calgary, America/Edmonton)

Implementation complete. Verified the Game repository root before editing. Implemented against the exact GS3 contract supplied in the resumed Play, attributed to GS3 commit 917ff915ad6ef5e0bd934f0a8096f3ce5831a574.

## Changes

- src/runtime/streamloop-bridge.js: added pure createGalleryCapabilityResponse validation and reply construction. Requires the exact source, numeric version, query type, capability, and string generation. Echoes the string unchanged with features: []. No generation storage, normalization, or replacement.
- src/main.js: extended the existing StreamLoop message listener after its existing trusted-parent check. Sends a reply only for a valid query, using the actual parent WindowProxy. Pins targetOrigin to the message origin when addressable; uses * for opaque origins. Existing PLAY/PAUSE dispatch remains in place.
- tools/test-gallery-capability.mjs: new executable coverage runs the actual main.js bridge registration region in a Node VM with controlled window and runtime objects. Covers normal/StreamLoop activation, no boot announcement, exact response envelope, empty features, opaque generation echo, malformed queries, missing/non-string generation, unrelated/self/null sources, unframed self-parent rejection, target origin, no media-state access during discovery, and unchanged pending PLAY/PAUSE behavior. Runtime access is restricted to known playback seams; unexpected calls fail.
- tools/test-streamloop-bridge.mjs: updated import and reply wiring assertions to reflect the permitted capability response.
- Plumbing SLC/Reports/Codex/004-S5B-CAPABILITY-RESPONDER-IMPLEMENTATION.md: this report.

No ProfileStore, MediaRuntime, launch-context implementation, favorite actions, UI, or shortcut code changed. No GS3 changes, commit, or push. Existing untracked .vs/ and prior report folders were preserved.

## Verification

Focused tests ran first and passed:

- node tools/test-gallery-capability.mjs
- node tools/test-streamloop-bridge.mjs — 45 assertions
- node tools/test-launch-context.mjs — 20 assertions

Full normal suite: all 66 tools/test-*.mjs scripts were run sequentially to completion. 65 passed; 1 failed. StreamLoop autofill, startup media, and startup context parity tests passed.

The sole failure was tools/test-ambient-decision-multitab.mjs at line 194: “observer takes no row-projection input.” Both this test and src/profile/ambient-profile-observer.js are byte-for-byte unchanged from HEAD, verified with git diff --exit-code HEAD for those paths. This unrelated failure was left untouched. The suite runner collected failures and continued; its own exit code is not evidence of an entirely green suite.

node tools/check-dom-contract.js passed: 57 JavaScript files parse, DOM/module/asset checks pass, zero failures or warnings. git diff --check passed.

Verification exercised the actual bridge block with simulated WindowProxy identities, not a live GS3/browser end-to-end session. No live integration verification is claimed.
