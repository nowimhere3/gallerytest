<!-- sideline-provenance: {"gameId":"game_git_7b79a141","clientRef":"ref_1793919070849_f8171ca1","playerInstanceId":"codex-f64abdd7","playerType":"codex","provider":"codex","model":"gpt-6.1-sol","effort":"high","at":"2026-11-05T22:51:10.850Z"} -->
<!-- sideline-work: {"work":["CHECK","BUILD"],"tags":["DESKTOP","LOADING","PROGRESS","ARCADE","REGRESSION"]} -->
# Desktop loading progress

Implemented locally in C:\Users\dmcal\Documents\GitHub\GalleryTest-HeartSync. Verified existing branch feature/folder-favs and HEAD 417d65ae4c65826861246031896a8139ce1f5daf before editing; both unchanged afterward. No commit, push, deployment, or branch switch.

## Implementation

- index.html: added phase, activity-bar, and count text to the existing desktop viewer loading overlay. It remains decorative/aria-hidden; existing desktop status/accessibility behavior is retained.
- src/main.js: renderMobileLoadProgress writes the desktop phase and counts directly from the same existing loader callback arguments. Known totals mirror the mobile loaded/total text. Unknown totals show the actual callback count as “media files found so far.” The existing ratio and sweep functions mirror their same ten-segment bar into desktop. No second counter, estimate, progress observer, or loading state was introduced.
- A known-to-unknown transition resets the shared bar to the existing indeterminate sweep, preventing a previous full ratio from persisting through a new scan under reduced motion. Mobile layout, count visibility, ticker cadence, and loading lifecycle are preserved.
- styles.css: compact centered text above the unchanged 480px canvas, within the existing viewer overlay bounds. Thumbnail Gallery remains outside the overlay. No canvas sizing changes.
- tools/test-desktop-loading-progress.py: new real Chromium integration for actual 600-file local and remembered-folder providers, using their genuine batch callbacks. Test-only completion gates allow inspection; no production sleeps/delays were added.

## Verification

- New progress suite: **8/8 scenarios PASS**, at desktop 1440x1000 and compact 390x1000, with normal and reduced motion. Each uses both a local folder with a known total and a genuine browser OPFS directory selected through the remembered-folder route.
- All scenarios observe real batches 250, 500, 600. Known totals show “250 / 600”, “500 / 600”, and “600 / 600 media files” with correctly filled ratio segments. Unknown totals show those actual discovered counts without a denominator, using the three-cell sweep rather than a stale ratio. Mobile and desktop bar/phase readouts match; mobile unknown-total count text stays hidden as before.
- Painted Arcade pixels verified; desktop canvas remains exactly 480px and inside the viewer. Gallery remains visible. Overlay disappears and animation stops when intake finishes. An additional ungated single-file load in each context completes normally without a release or minimum dwell requirement.
- Existing desktop Arcade browser suite: **24/24 PASS**, including all intake routes, scan failure, warm-start priority, responsive transfer, and reduced motion.
- Arcade scene selection: 29 assertions PASS. Warm-start: 18 assertions PASS. DOM contract: 0 failures, 0 warnings. git diff --check: PASS (Git prints line-ending normalization advisories).
- Desktop known/unknown screenshots visually inspected: centered composition fits the existing viewer without covering thumbnails. The existing Arcade suite also refreshes its generated 021 screenshot evidence when run.

## Evidence and acceptance

- [Desktop known-total progress](022-progress-1440-known.png)
- [Desktop unknown-total scanning](022-progress-1440-unknown.png)
- [Compact known-total regression](022-progress-390-known.png)
- [Compact unknown-total regression](022-progress-390-unknown.png)

Browser tests use isolated Edge/Chromium profiles, real files/providers, and real OPFS handles; native OS picker selection is emulated. No user libraries, IndexedDB, Curation data, or Sync storage was reset. Pre-existing Sync source/test WIP was not edited.

Human visual acceptance remains pending: locally open a large folder, then a remembered folder; confirm phase/bar/counts appear above the approved Arcade canvas and disappear with loading completion. Fast loads intentionally have no guaranteed display duration. Hosted Pages is unchanged.

REPORT COMPLETE
