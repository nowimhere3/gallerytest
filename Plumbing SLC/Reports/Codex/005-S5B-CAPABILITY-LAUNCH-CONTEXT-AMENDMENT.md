<!-- sideline-provenance: {"gameId":"game_git_7b79a141","clientRef":"ref_1793554812740_fdccdea6","playerInstanceId":"codex-f64abdd7","playerType":"codex","provider":"codex","model":"gpt-6.1-sol","effort":"medium","at":"2026-11-01T17:40:12.742Z"} -->
<!-- sideline-work: {"work":["CHECK","BUILD"],"tags":["S5B","capability-handshake","launch-context"]} -->
# S5B Amendment — Capability Independent of Launch Context

Recorded: Sunday, November 1, 2026 — 10:44 AM -07:00 (Calgary, America/Edmonton)

Status: COMPLETE. Verified the GalleryTest-HeartSync repository before editing. Continued from the uncommitted S5B implementation without discarding its work.

## Result and exact files changed this Play

- src/main.js: one shared trusted-parent message listener now handles capability queries before the StreamLoop launch-context check. Playback dispatch returns immediately outside StreamLoop mode; its readiness subscription stays within the original explicit StreamLoop guard. Updated nearby comments. Startup, autofill, and folder logic were not edited.
- tools/test-gallery-capability.mjs: executes the actual bridge region in both normal and StreamLoop contexts. Checks identical response envelopes, exact opaque generation echo, empty features, malformed queries, unrelated/self/null sources, opaque target origins, no unsolicited boot messages, no discovery media-state access, and StreamLoop-only readiness subscriptions and PLAY/PAUSE behavior. Normal mode rejects commands both before and after simulated readiness.
- tools/test-streamloop-bridge.mjs: updated wiring assertions for one shared listener, the explicit playback guard, and the still-gated readiness subscription.
- Plumbing SLC/Reports/Codex/005-S5B-CAPABILITY-LAUNCH-CONTEXT-AMENDMENT.md: this report.

The pure parser in src/runtime/streamloop-bridge.js was not changed by this amendment; its existing uncommitted S5B change remains. The wire contract and trusted-parent source checks are unchanged. No URL/path detection, storage, favorite commands, hearts, media-change reporting, or shortcuts were added.

## Verification

Focused tests ran first and passed:

- node tools/test-gallery-capability.mjs — both launch contexts, exact contract and playback separation.
- node tools/test-streamloop-bridge.mjs — 46 assertions.
- node tools/test-launch-context.mjs — 20 assertions.

All 66 tools/test-*.mjs scripts then ran to completion in separate Node processes, with up to eight processes running independently. Result: 65 passed, 1 failed. Startup media, startup context parity, StreamLoop autofill, launch-context, and capability coverage passed.

The sole failure remains tools/test-ambient-decision-multitab.mjs:194, “observer takes no row-projection input.” This failure was also recorded before the amendment. Both the test and src/profile/ambient-profile-observer.js remain unchanged from HEAD, verified with git diff --exit-code HEAD on those paths. No unrelated fix was attempted. The collecting runner continued after failures; its exit code does not mean every test passed.

node tools/check-dom-contract.js passed with 57 JavaScript files parsing and zero failures or warnings. git diff --check passed. Verification uses controlled window identities in a Node VM and source/DOM checks; a live GS3 browser integration was not exercised.

## Compatibility and delivery boundary

- /gallerytest/ normal mode is capability-ready in this implementation.
- /gallerytest/?launch=streamloop is capability-ready in this implementation.
- /gallery/ and /gallery/?launch=streamloop remain a separate future compatibility port until that repository receives the same responder.

The responder remains URL/path agnostic. These statements describe local implementation readiness, not a deployment claim. GS3 and the older Gallery repository were not modified. No commit or push occurred. Pre-existing untracked files and earlier reports were preserved.
