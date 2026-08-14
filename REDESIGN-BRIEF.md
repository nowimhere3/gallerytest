# Browser Gallery — Staged UI/UX Redesign Implementation Brief

> **Operating instruction for the agent:** this file lives in the repository root. Re-read it in full at the start of every stage, before inspecting code or making any edit. Do not work from a summary of it held in conversation context — this project spans multiple sessions and the conversation will be compacted between stages.

---

## Role

You are the senior implementation engineer applying an already-approved UI/UX redesign to Browser Gallery without regressing any existing behavior.

This is primarily a structural HTML/CSS re-layout with carefully bounded JavaScript changes. It is **not** permission to redesign the product, rewrite its architecture, replace its storage model, or "clean up" unrelated code.

Accuracy and preservation matter more than speed. A stage that ships late and correct is a success. A stage that ships fast and quietly breaks Presentation Mode is a failure, even if it looks right.

---

## Repository and source of truth

- Repository: `https://github.com/nowimhere3/gallerytest`
- Target baseline: the **current checkout in this Codespace**. Current files and current `HEAD` are authoritative.
- Do not rely on old ZIPs, historical conversations, stale line numbers, older branch assumptions, or the verified baseline below if it disagrees with what you actually read on disk.

### Verified baseline

The following was measured directly against `main` at SHA `5d08793a8b69e9036518262f15fe6769c4c3dd42`. **Confirm each figure against the live checkout during Stage 0 and report any drift.** These numbers exist so you can detect drift, not so you can skip reading the files.

| File | Size | Role |
| --- | --- | --- |
| `index.html` | 469 lines | Entire application markup. 111 elements carry an `id`. |
| `styles.css` | ~1,679 lines | All styling. No preprocessor. |
| `src/main.js` | 3,432 lines | Application monolith. |
| `src/storage/app-preferences.js` | ~7.8 KB | Playback preference persistence. |
| `src/storage/library-registry.js` | ~18 KB | Recent libraries / library identity. |
| `src/storage/legacy-library-signature.js` | ~9 KB | Legacy load identity. |
| `src/profile/profile-store.js` | ~33 KB | Profile data + import/export. |
| `src/profile/indexeddb.js` | ~9.7 KB | Profile persistence layer. |
| `src/providers/fsa-file-provider.js` | ~7.3 KB | File System Access loading. |
| `src/providers/local-file-input-provider.js` | ~6 KB | Legacy picker loading. |
| `src/runtime/media-runtime.js` | ~14 KB | Sequence/playback runtime. |
| `src/runtime/duplicate-filter.js` | ~1.5 KB | Skip-duplicates logic. |
| `src/playback/ts-playback-adapter.js` | ~9.5 KB | `.ts` playback. |

**There is no `package.json`, no test runner, no linter, and no build step.** Any instruction elsewhere to "run existing repo tests" resolves to: there are none. The static checks in this brief are the only automated gate this project has.

**Existing external dependency:** `index.html` loads `mux.js@7` from jsDelivr via a plain `<script>` tag, and `src/main.js` is loaded as `<script type="module">`. The "no dependencies" rule below means **no new** dependencies. Do not remove, bundle, vendor, or version-bump `mux.js`.

### `docs/` exclusion

`agents.md` excludes `docs/` from default working context. This brief adopts that rule as a hard constraint for this project: **do not read, scan, search, summarize, index, or modify anything under `docs/`** unless I explicitly authorize it in a later message.

Note that `docs/launch.js` exists but is **not** referenced by `index.html`. It is not a runtime dependency. Do not treat its presence as a reason to open the directory.

### Instruction precedence

Where two instructions appear to conflict, resolve in this order:

1. My explicit instruction in the live conversation.
2. This brief.
3. `agents.md`.
4. In-code `[PHASE X.Y]` comments and existing breadcrumbs.

`agents.md` and this brief have been checked and are compatible — `agents.md` is a context-hygiene policy, not a security boundary, and its `docs/` rule matches this brief's. If you nonetheless find a genuine conflict, **stop and report it rather than choosing a winner.**

### Design mockup

The approved final redesign mockup is the visual target. It will be attached to the conversation or supplied as a local file path.

**Mockup access is a Stage 0 gate.** If you cannot actually open and inspect the image, stop and ask me for an accessible path. Do not proceed on the basis of the prose description in this brief. Do not silently work from an assumed layout and surface the problem at Stage 5.

---

## Non-negotiable execution rule: one stage at a time

This project is implemented in gated stages because I manually test the real application after every stage.

1. Begin with **Stage 0 only**.
2. Stage 0 is inspection and planning only. Do not edit any files. Do not create a branch.
3. End Stage 0 with the required report and stop.
4. Do not begin the next stage until I explicitly reply `PROCEED TO STAGE <next label>` using the exact label from the progression below.
5. At the end of every implementation stage: run the static checks, give me a stage-specific manual test checklist, show the files changed and the nature of the diff, identify the breadcrumbs added, and **stop completely — without committing**.
6. If I report a regression, fix only that regression inside the current **uncommitted** stage, re-run checks, and stop again at the test gate.
7. If mid-stage you discover that this brief is wrong about the code, **stop and report it**. Do not improvise a fix to the plan. A brief that is wrong about the code is my problem to resolve, not yours to route around.
8. Never interpret approval of one stage as approval for any remaining stage.

### Stage progression and exact commands

The stage order is fixed:

```text
Stage 0 → Stage 1A → Stage 1B → Stage 1C → Stage 2 → Stage 3 → Stage 4 → Stage 5 → Stage 6 → Stage 7
```

Two separate approvals gate each transition, and each has an exact command:

1. After I test an implemented stage and it passes, I reply `STAGE <label> PASSED — COMMIT`. Only then do you create the local stage commit.
2. Separately, I reply `PROCEED TO STAGE <next label>` before you begin the next stage.

Every end-of-stage message must name **both** exact commands for the current position — the `STAGE <label> PASSED — COMMIT` command for the stage just finished, and the `PROCEED TO STAGE <next label>` command that follows. Never write a generic `PROCEED TO STAGE N` or `STAGE N+1`; substitute the real label (`1A`, `1B`, `1C`, `2`, …, `7`).

### Git protocol

**Stage 0 (no edits):**

- Run `git status --short` and `git branch --show-current`. Record `HEAD` SHA.
- **Task-input files are expected and do not halt Stage 0.** The following are planning inputs for this task, not application changes. If they appear untracked or modified, report them in a separate "task inputs" list and continue — do not treat them as a dirty worktree that stops the stage:
  - `REDESIGN-BRIEF.md`
  - `tools/check-dom-contract.js`
  - the supplied redesign mockup, if it is stored in the repository.
- For **any other** pre-existing worktree change, identify it and stop. Do not overwrite, discard, reset, or absorb it unless I explicitly authorize it.
- Recommend a dedicated branch name. Do not create it yet.

**On `PROCEED TO STAGE 1A`, before any edit:**

- Create and check out the redesign branch (proposed: `redesign/workspace-shell`).
- Never work directly on `main`.
- Bring the task-input files (the brief, the checker, and the mockup if repo-stored) onto the redesign branch. You may commit **only those task-input files** as a clearly labeled setup commit (`redesign: task inputs (brief, checker, mockup)`). Do **not** fold any application source change into that commit, and do not silently commit anything else.

**Committing is manual-approval-gated. Do not auto-commit at the end of a stage.** The sequence for every implementation stage is:

1. Implement the stage.
2. Run the static checks.
3. Report the diff and the manual test gate.
4. **Stop without committing.**
5. Only after I reply `STAGE <label> PASSED — COMMIT` do you create the local stage commit with message `redesign: stage <label> — <short description>`.
6. **Do not push. Do not open a PR. Do not merge. Do not tag.**
7. Do not begin the next stage until I separately reply `PROCEED TO STAGE <next label>`.

Per-stage commits exist so that (a) each stage diff is reviewable in isolation rather than smeared into one multi-stage blob, and (b) a bad stage can be reverted to a known-good point instead of unpicked by hand — but they happen only on my explicit `STAGE <label> PASSED — COMMIT`, never automatically.

**Never use destructive Git commands** — no `reset --hard`, `checkout -- .`, `clean -fd`, `rebase`, or force operations — without my explicit instruction in the moment.

---

## Core implementation doctrine

### Preserve behavior; relocate presentation

The existing application works. The redesign changes where controls live and how the interface is organized. It does not grant permission to change what those controls do.

> Preserve every existing DOM ID, event hook, runtime method, persistence path, state transition, filter rule, and Presentation Mode behavior. Move the existing element once and restyle it. Do not create a visually similar replacement with different behavior.

Specifically:

- Keep all existing IDs unique and present, unless Stage 0 proves an ID is genuinely obsolete **and** I explicitly approve removing it.
- Never duplicate an existing ID across workspaces or responsive variants.
- Do not replace working controls with cloned desktop/mobile copies. Prefer one semantic element with responsive CSS.
- Preserve current disabled, hidden, active, `aria-*`, and status states.
- Preserve loading, FSA permissions, recent libraries, library/profile association, slideshow, filters, favorites, hidden items, tags, profiles, imports/exports, `.ts` playback, Presentation Mode, loop behavior, PM automations, and IndexedDB behavior.
- Do not change media ordering, shuffle history, duplicate detection, filtering logic, object URL lifecycle, Profile data, or library identity.
- Keep the app vanilla HTML/CSS/JavaScript. No framework, build system, UI library, or new dependency.
- No broad refactors, rename sweeps, formatting rewrites, or unrelated cleanup.

### The static-markup constraint (highest-risk item in this project)

`src/main.js` captures **109 element references as module-scope `const` declarations**, executed once at module parse time (roughly lines 57–183):

```js
const fileInput = document.getElementById("file-input");
const fsaChooseFolderBtn = document.getElementById("fsa-choose-folder-btn");
// ...107 more
```

This produces three hard rules that govern the entire redesign:

1. **Every element referenced by `main.js` must exist in the static markup of `index.html` when the module first parses.** All four workspace containers — Gallery, Tagging, Automations, Settings — must be present in the initial document. Workspaces are shown and hidden with CSS and/or the `hidden` attribute. They are **never** lazily rendered, injected, or created on first activation.
2. **No protected container may ever be rebuilt via `innerHTML`, `replaceChildren`, `replaceWith`, `outerHTML`, or node removal.** Doing so destroys the captured references, which are `const` and are never re-queried. The failure mode is silent: the element is gone, the const still points at a detached node, and a feature stops working with no console error.
3. **A renamed or removed ID is not a refactor, it is an outage.** The capture yields `null`, and the failure surfaces later, somewhere unrelated, as a `TypeError` on a user action.

**What "protected" covers, precisely.** These rules apply to:

- the top-level workspace containers (Gallery, Tagging, Automations, Settings);
- any existing DOM element captured by a module-scope reference in `main.js`;
- any new architectural wrapper you introduce **around** those captured elements.

**What these rules do NOT prohibit.** The application already repopulates certain child containers as normal runtime behavior — the Gallery thumbnail grid, the Tags grid, the recent-libraries list, and similar. Those are intentionally dynamic and are expected to keep re-rendering their **own inner contents** exactly as they do today. The prohibition is on destroying or rebuilding a protected container or a captured element itself, not on the existing rendering that happens inside a dynamic child container. If you are unsure whether a container is protected or intentionally dynamic, treat it as protected and ask.

Moving an element to a different parent in static markup is safe and is the intended technique throughout this redesign. Creating, destroying, or renaming a protected element is not.

Baseline as measured: **111 unique IDs, zero duplicates, all 109 `getElementById` targets resolve, zero computed/dynamic `getElementById` calls.** Every stage must end in that same clean state. Two IDs — `tag-activity-center` and `video-loop-state-text` — are present in markup but never fetched by `getElementById`; they are reached another way. **Do not treat them as dead and do not remove them.**

### ID namespace collision warning

The existing Presentation Mode loop automations already own the `automation-*` ID prefix (`automation-timer-minutes-value`, `automation-timer-apply-btn`, and others). The new **Automations workspace** must therefore use a distinct prefix — `cookbook-*` is recommended — for every new ID. Do not extend, reuse, or shadow the `automation-*` namespace. Confirm this in Stage 0 and state the prefix you will use.

### Existing persistence is authoritative

Playback preferences already use `src/storage/app-preferences.js` and IndexedDB. Preserve that implementation and its fallback behavior.

Current global Playback preferences: interval seconds, shuffle, skip duplicates, loop playlist, fill panel.

They are **global application preferences, not Profile data**, and must remain excluded from Profile export / import / merge / replace. Chosen values persist and restore automatically. Do not add a separate "remember this" toggle for Playback and do not build a second preference store.

Presentation Ghost Opacity has its own existing remember/value behavior. Preserve it.

### Required three-part breadcrumbs

For every new architectural wrapper, workspace controller, popover, responsive drawer, or non-obvious behavior, add a concise adjacent comment using this exact structure:

```text
[UI-REDESIGN / Stage N]
WHAT: What was introduced or moved.
WHY: The product/architecture reason it exists here.
FUTURE: The intended extension point or the boundary future work must preserve.
```

Use valid HTML, CSS, or JS comments for the file. Breadcrumbs explain load-bearing intent; they do not narrate obvious declarations. Preserve existing `[PHASE X.Y]` comments and breadcrumbs — do not delete or rewrite an old breadcrumb merely because the surrounding element moved.

---

## Approved product architecture

### Current structure (as measured)

```text
header.topbar                    — large title/subtitle, to be replaced
main.layout
├── section.panel.controls-panel
│   ├── h2 Load Media            — legacy picker, FSA, recent libraries, status
│   ├── section.playback-section — h2 Slideshow (transport)
│   ├── details.tags-section     — Tags management
│   ├── details.profile-section  — Profile management
│   └── section.slideshow-settings-section
├── section#viewer-panel         — h2 Gallery + player
└── section.panel.gallery-panel  — h2 Gallery + filters + thumbnails
#presentation-controls           — PM overlay, SIBLING of main.layout
```

Note that Tags and Profiles are currently `<details>` elements. Moving them into always-visible workspace panels requires a decision about whether the `<details>`/`<summary>` disclosure is retained inside the workspace or unwrapped. **Stage 0 must propose one and justify it**; unwrapping changes focus order and any CSS keyed to `[open]`.

Note also that `#presentation-controls` is a sibling of `main.layout`, not a child. Restructuring `main.layout` should not reach PM — verify this and report if any PM CSS is keyed to a selector inside `main.layout`.

### Target desktop information architecture

```text
Page exterior gutter
├── Left rail
│   ├── Browser Gallery identity / logo placeholder
│   ├── Libraries (Legacy Picker · Choose Folder (FSA) · Recent Libraries · load status)
│   ├── Associated Profile summary + Change shortcut
│   ├── Clear Media
│   └── Live Status
└── Main workspace
    ├── Primary navigation (Gallery · Tagging · Automations · ⚙ Settings far right)
    ├── Active workspace
    └── Contextual now-playing strip when appropriate
```

The code's actual dimensions and breakpoints are authoritative. Do not infer pixels from the raster mockup. Preserve the current shell geometry (approximately a `1400px` max shell and a `340px + 20px + remainder` desktop relationship) unless Stage 0 finds the checkout has changed or a small adjustment is needed to match the approved composition.

Use a restrained external page gutter — roughly `16–18px` at desktop, not a banner-sized empty region and not internal card padding. Confirm against the live preview, not against a generated-image pixel.

### Placement rule

- **Left rail:** load and library context, associated Profile context, destructive Clear Media, live state.
- **Player transport:** immediate slideshow/sequence controls plus contextual Playback settings.
- **Gallery workspace:** Player, transport, Gallery filters/navigation, thumbnails.
- **Tagging workspace:** Tag creation/management/assignment and Tag Status Update Center.
- **Automations workspace:** future Automation Cookbook home. Do not invent the Cookbook engine.
- **Settings utility:** rare administration, including existing Profile management.
- **Presentation Mode:** immersive runtime controls only, unchanged.

---

## Approved visual and interaction details

### Brand placeholder

Replace the large top title/subtitle with a compact identity at the top of the left rail:

```text
[ BG ] Browser Gallery
```

Placeholder only. Do not create or embed a generated logo asset.

### Primary navigation

`Gallery` · `Tagging` · `Automations`, with far-right `⚙ Settings`.

Gallery, Tagging, and Automations are genuine workspaces. Settings is a separate utility, not a fourth equal creative tab.

Use accessible tab/button semantics, visible focus states, `aria-selected` / `aria-current` or the appropriate equivalent, and deterministic keyboard behavior.

Switching workspaces must not reload the library, reset filters, change Profiles, destroy the current item, or stop playback. Per the static-markup constraint, switching is a visibility change over persistent DOM — never a render.

### Gallery workspace hierarchy

1. Player / media stage
2. attached sequence transport row
3. Gallery filter row
4. Gallery title/count and navigation row
5. thumbnail grid

Remove the redundant `Player` / `Gallery` heading above the media stage. The Player should be visually dedicated to media.

The Player already renders native video controls where appropriate. Browser Gallery's transport controls operate the mixed image/video sequence and slideshow; they are not replacements for native seek/volume.

### Transport row

Directly below the Player, left-align this cluster in its existing semantic order:

```text
Favorite · Previous · Start · Stop · Next
```

Keep the established Start/Stop behavior. Do not merge them into a Play/Pause state machine.

Right side of the same row:

```text
Playback ⚙     current/total counter
```

- The Playback button says exactly `Playback ⚙` in its closed state.
- Do not show `7`, `7s`, or the current interval on the button — the popover controls more than interval.
- Keep all existing disabled/active behavior.

### Playback popover

Clicking `Playback ⚙` opens a compact contextual popover containing the existing controls and existing IDs: Interval stepper, Shuffle, Skip Duplicates, Loop Playlist, Fill Panel.

- Closed by default. Second click closes. Outside click closes.
- `Escape` closes and returns focus to `Playback ⚙`.
- Opening updates `aria-expanded` / `aria-controls`.
- Must not cover critical transport controls. Must remain usable by keyboard and at narrow widths.
- Uses the existing auto-save preference path. Do not build new storage.
- Remove the permanent rail Playback Settings block **only after** the popover is verified working.

### Gallery filters

```text
Show: All media | Favorites
Type: Any type | Images | Videos
Tag:  Any tag ▼
```

- Existing filtering behavior and combination semantics are authoritative.
- Existing multi-Tag selection and AND-combination must not be reduced to single-select merely because the closed button reads `Any tag` when nothing is selected.
- Preserve active Tag rendering and Tag panel behavior.
- Preserve filters when leaving and returning to Gallery.
- Update counts from the existing visible-item sequence.
- Add a clear-filter affordance **only** if it can be added without changing filter semantics; otherwise defer and report the deferral.

`Show` replaces the ambiguous label `View`; reserve "View" for a possible future grid/list choice.

### Gallery navigation

Preserve existing filtered-sequence behavior of the media-number input, `Find Below`, and `Load in Player`.

Add `Use Current` beside the media-number input. It populates the current media's 1-based position within the current visible/filtered sequence. **It must not navigate or load anything by itself.**

`Find Below` continues to scroll without loading. Its target thumbnail receives a temporary **yellow** find highlight, visually distinct from the existing blue/purple active-selection language.

Do not create a second numbering/order system.

### Tagging workspace

Use the name `Tagging`, not `Tags`, to distinguish the management workspace from Gallery's Tag filter.

Move the existing Tags section into this workspace intact: Tag Status Update Center, latest activity state, Shuffle OFF / Shuffle ON checkpoints, existing Find actions, create Tag, existing Tag list/grid, existing assignment/removal/management behavior, current status messaging.

Preserve all IDs and behavior. Do not implement bulk assignment, drag ordering, new history, recipes, or other speculative features.

If tagging activity continues while another workspace is visible, do not cancel or reset it. A lightweight status badge is acceptable only if driven from existing state without creating a parallel source of truth.

### Profiles and Settings

Profiles are supporting infrastructure, not a primary workspace tab.

The left rail shows the **currently loaded library's actual association**, not merely the globally active Profile:

```text
ASSOCIATED PROFILE
BEAST                         Change
```

Use existing association state as the single source of truth. Preserve the distinct meanings of: associated Profile, globally active Profile, unassociated library, no current load.

`Change` / `Associate with Profile` opens Settings and focuses the authoritative Profile area. **It must not grow a second Profile-management implementation inside the rail.**

Move the existing full Profile selector and management tools into Settings: current Profile, associate current library, create, delete, export, import merge, import replace, import as new Profile, "only import entries for files currently loaded", and existing Profile status messages.

Preserve every existing Profile ID, storage call, import/export schema, association behavior, and confirmation flow.

Settings may establish clearly labeled future sections, but do not build speculative Preferences. Playback stays contextual in the Player; Ghost Opacity stays contextual in PM.

### Automations workspace

Future home of the **Automation Cookbook** and reusable named **Recipes**.

For this redesign only:

- Create a polished, honest workspace shell / empty state titled `Automation Cookbook`.
- Briefly explain that saved Recipes will be managed here in a later feature phase.
- Do not simulate working Recipe controls. Do not create Recipe persistence, schemas, triggers, actions, delays, or execution logic.
- Do not move or break current Presentation Mode loop automations.
- Use the `cookbook-*` ID prefix, never `automation-*`.
- Document via the `FUTURE` breadcrumb that Cookbook Recipes are **global application data, not Profile data**, unless a later approved architecture explicitly changes that rule.

---

## Presentation Mode protection boundary

Presentation Mode works and is high-risk. Preserve: simulated fullscreen behavior, Favorite, video-only Loop, the Loop Automations panel and its state rules, Previous / Play-Pause / Next, Hide / Undo Hide, Exit, PM Settings, Ghost Opacity including `0%` and its remember behavior, PM Tags, toolbar ghosting/hover behavior, and image / video / `.ts` rendering.

Do not visually redesign the PM toolbar in these stages. Change PM CSS/JS only where necessary to prevent a demonstrable regression caused by the new shell, and **report that change explicitly** when you make it.

---

## Responsive / mobile target

Do not treat 50% desktop zoom as a mobile preview.

Desktop retains the left rail. On narrow screens:

```text
Compact app header
Current library/profile summary + Controls button
Player
Transport
Horizontally scrollable workspace tabs
Active workspace
Controls drawer/bottom sheet for former left-rail content
```

- One accessible `Controls` drawer/bottom sheet for Libraries, association, Clear Media, Live Status.
- Do not create a second independent loading/settings implementation, and — per the static-markup constraint — do not duplicate functional DOM controls into a mobile-only copy. One element, responsive CSS.
- When media is loaded, prioritize Player → transport → workspace navigation.
- In the empty state, make Load / Recent Libraries immediately discoverable rather than showing a useless large empty Player.
- Workspace tabs stay horizontal and scrollable — no two-row wrap, no icon-only ambiguity. Bring the selected tab fully into view automatically.
- Tagging, Settings, Automations become single-column / drill-in-friendly.
- Playback settings open as a narrow popover or bottom sheet from the same `Playback ⚙` control.
- Preserve comfortable touch targets, keyboard focus, safe overflow, no clipped controls.
- Preserve Presentation Mode responsive behavior.

Test at minimum: desktop `1440 × 900`, tablet `768 × 1024`, phone `390 × 844`, narrow phone `~360px`.

---

## Staged implementation plan

Stage 0 may refine technical details or split a stage further if the current code makes a boundary unsafe. **It must not merge stages or broaden scope without my approval.**

### Stage 0 — Inspection, contract map, and risk report (NO EDITS)

Inspect targeted current source only. Deliver:

0. **Mockup access confirmation.** State the exact path or attachment you opened and describe what you actually see. If you cannot open it, stop here and ask.
1. Git branch, clean/dirty status, current `HEAD` SHA, and any drift from the verified baseline table above.
2. Current shell/layout map.
3. A table of every element/ID that will move: current parent, proposed destination, DOM reference variable in `main.js`, listener/behavior owner, and target stage.
4. Workspace-state proposal that does not reset playback, filters, Profile, or loaded libraries — explicitly confirming the static-markup constraint (all workspaces in initial DOM, visibility-only switching).
5. Playback preference flow confirmation: UI → `src/main.js` → `app-preferences.js` → IndexedDB → startup restore.
6. Profile/association distinction and how the left rail summary will remain truthful across all four states.
7. Responsive risks and Presentation Mode collision risks, including whether any PM CSS is keyed inside `main.layout`.
8. The `<details>` decision for the Tags and Profile sections, with justification.
9. Confirmed ID prefix for the Automations workspace.
10. Verification that `tools/check-dom-contract.js` runs clean against the current checkout, with its output pasted.
11. Any contradiction between the current code and this brief, **or between `agents.md` and this brief**.
12. Recommended dedicated branch name.

Do not edit. Do not create a branch. Stop and ask only for `PROCEED TO STAGE 1A` — Stage 0 has no commit to request.

### Stage 1A — Workspace shell only

- Create the redesign branch first.
- Add accessible `Gallery`, `Tagging`, `Automations`, far-right `Settings` navigation.
- Add all four workspace containers to static markup, empty except Gallery.
- Gallery workspace contains the existing viewer/gallery content, behavior unchanged.
- Add visibility-only workspace switching that preserves all state.
- Leave Tags, Profiles, Player, transport, filters, and rail playback controls exactly where they are.

**Do not** move the Tags or Profile sections yet. **Do not** add the now-playing strip yet.

Manual testing: load legacy files/folder; load/resume FSA library; switch all workspaces with and without active playback; confirm current media, filters, and playback survive switching; enter/exit Presentation Mode.

Stop after Stage 1A.

### Stage 1B — Tagging migration

- Move the existing Tags section intact into the Tagging workspace.
- Apply the approved `<details>` decision.
- Preserve every ID, listener, and status message.

Manual testing: create / apply / remove a Tag; Tag Status Update Center updates; Shuffle OFF/ON checkpoints; activity Find; tagging activity continuing while another workspace is visible; Gallery Tag filter still works and still supports multi-Tag AND.

Stop after Stage 1B.

### Stage 1C — Settings / Profile migration

- Move the existing Profile management section intact into the Settings workspace.
- Add the honest Automations / Cookbook shell (`cookbook-*` IDs, no engine).
- Preserve every Profile ID, storage call, import/export schema, association behavior, and confirmation flow.

Manual testing (use safe test data — **Profile delete and import-replace are destructive**): create / switch / delete Profile; export; import merge; import replace; import as new; "only import entries for files currently loaded"; association for both legacy and FSA loads; Profile status messaging.

Stop after Stage 1C.

### Stage 2 — Left rail identity, association, and Live Status

- Replace the large topbar title/subtitle with the compact `[BG] Browser Gallery` placeholder in the rail.
- Organize Libraries, recent libraries, source status, and association context.
- Build the truthful `Associated Profile` summary from existing state.
- Make Change/Associate open Settings and focus the authoritative Profile area.
- Keep `Clear Media` in the rail; move Live Status directly beneath it so large loads can be watched without scrolling.
- Retain current Slideshow transport and Playback settings in the rail temporarily until Stage 3.
- Apply the restrained outside page gutter, not extra internal header padding.

Manual testing: all four association states for legacy and FSA loads; status progression during a large load; **Clear Media (destructive)**; recent-library removal; Profile switching and repair.

Stop after Stage 2.

### Stage 3 — Player transport and contextual Playback settings

- Move existing Favorite, Previous, Start, Stop, Next controls beneath the Player, left-aligned as one cluster.
- Keep `Playback ⚙` and the counter on the right.
- Build the accessible, closed-by-default Playback popover from the existing controls and IDs.
- Verify existing IndexedDB auto-save and startup restoration. Do not create a new preference store.
- Remove the old rail Slideshow/Playback blocks **only after** equivalent behavior is verified.
- Keep Clear Media and Live Status in the rail.

Manual testing: every transport control with images, normal videos, and `.ts` videos where available; shuffle on/off; loop playlist; skip duplicates; fill panel; interval bounds and stepper; reload persistence; outside-click close; second-click close; Escape and focus return; PM entry/exit.

Stop after Stage 3.

### Stage 4 — Gallery composition, filters, navigation, yellow Find state, now-playing strip

- Remove the redundant heading above the Player.
- Establish the final Gallery order: Player → transport → filters → navigation → thumbnails.
- Move and relabel filters to Show / Type / Tag without altering semantics.
- Preserve existing multi-Tag AND filtering.
- Add `Use Current` based on the current filtered sequence.
- Add the temporary yellow Find Below target state, distinct from active selection.
- Add the minimal now-playing strip shown when leaving Gallery during active playback: current filename, stop access using existing runtime actions, and `Return to Gallery`.

The now-playing strip is deliberately last among functional additions because it is the only place in this redesign that creates a second control surface for an existing runtime action. **Do not clone existing IDs.** Use distinct, clearly named controls that call the same existing runtime functions. If Stage 0 flagged this as unsafe, report and defer rather than improvising.

Manual testing: every filter combination; multi-Tag AND; Favorites; images and videos; clearing and changing filters; Find Below without loading; Load in Player; Use Current; invalid and out-of-range input; filters surviving workspace switches; now-playing strip appearing, stopping playback, and returning to Gallery.

Stop after Stage 4.

### Stage 5 — Desktop fidelity and accessibility pass

- Bring the completed desktop composition into close alignment with the approved mockup.
- Tune spacing, borders, typography, grouping, widths, hover/active/focus states, overflow.
- Maintain real shell geometry and Player proportions rather than faking the raster image.
- Confirm no horizontal clipping at 100% zoom.
- Complete keyboard navigation and ARIA state verification for tabs, Settings, Playback popover, Tag filter, and now-playing strip.

Do not change functionality except to correct accessibility or a demonstrated redesign regression.

Stop after Stage 5.

### Stage 6 — Responsive / mobile transformation

- Convert the desktop rail to the single Controls drawer/bottom sheet on narrow screens.
- Add the compact mobile app header and current-library context.
- Make loaded-state media Player-first; make empty-state loading immediately discoverable.
- Make workspace navigation horizontally scrollable and selected-tab-aware.
- Adapt transport, Playback popover, Tagging, Automations, and Settings **without duplicating functional DOM controls**.
- Preserve Presentation Mode.

Run the listed viewport tests and provide a separate checklist for touch, keyboard, drawer focus/close, rotation/resize, overflow, and returning from PM.

Stop after Stage 6.

### Stage 7 — Full regression audit and handoff

No new design work. Full regression pass covering: legacy Choose Files and Choose Folder; FSA Choose Folder, permissions, recent libraries, removal, reload/resume; legacy and FSA association states; large loading and status progression; Clear Media; all transport and Playback preferences; preference reload persistence; all Gallery filters and navigation; Favorites and Hidden; Tags, activity checkpoints, and Find; all Profile management and import/export modes; images, standard videos, `.ts` playback; Presentation Mode controls, Ghost Opacity including `0%`, Loop and PM automations; desktop/tablet/phone layouts; keyboard and focus behavior; DOM ID uniqueness and `getElementById` target resolution; console errors and unhandled promise rejections.

Deliver a final change inventory and **explicitly list anything not tested in the real environment**.

Stop. Do not commit beyond the stage commit, and do not push without my command.

---

## Required static checks after each implementation stage

Run, and paste actual output for:

```bash
node tools/check-dom-contract.js
git diff --check
git diff --stat
```

`tools/check-dom-contract.js` is dependency-free and covers: JS syntax across all `src/**/*.js`; duplicate IDs in `index.html`; every literal `getElementById` target resolving; computed `getElementById` calls flagged for human review; `aria-controls` / `aria-labelledby` / `aria-describedby` / `for` targets resolving; local script, stylesheet, and ES module paths resolving; module-scope capture count in `main.js`; and a focused guard that flags destructive DOM operations (`innerHTML` / `outerHTML` / `replaceChildren` / `replaceWith` / `remove()`) performed on any variable whose name contains `workspace` (case-insensitive). It handles both single- and double-quoted HTML attributes. It exits non-zero on failure.

The workspace-destruction guard is a **focused guard plus human-review aid**, not a proof: it cannot confirm that every captured DOM node remains attached at runtime. It catches the specific, high-likelihood mistake this codebase is prone to and surfaces computed lookups for you to review by hand.

**Baseline (current `main`, all green):** 11 JS files parse · 111 unique IDs, no duplicates · 109 `getElementById` targets all present · 0 computed lookups · all aria/label references resolve · all local asset and module paths resolve · 109 module-scope captures. Any stage that does not end green has a regression, not a new baseline.

If the checker itself needs a new rule as the redesign progresses, add a new numbered check block following the existing pattern in the file and say so in your report. Do not weaken any existing check — syntax, duplicate-ID, literal `getElementById`, aria/label, or path — to make a stage pass.

Also inspect the focused stage diff rather than merely reporting that files changed.

### Honesty about what was and was not verified

- **Do not claim browser behavior was tested if you only ran static checks.**
- If no headless browser is available in this environment, say so explicitly in every stage report rather than skipping the line. Do not describe console output you did not observe.
- If you serve the site locally, state the command and what you could actually observe from it.
- Always separate automated results from the manual verification I must perform.

---

## Required end-of-stage response format

### Stage `<label>` result
- Outcome and whether the stage is complete (implemented and tested, **not yet committed**).
- Exact files changed.
- Concise behavior-preservation explanation.

### Static checks
- Each command and its actual pasted output.
- Any check unavailable or not run, and why.
- Explicit statement of what was **not** verified in a real browser.

### Manual test gate
- Numbered, stage-specific steps with an expected result for each.
- Explicitly flag any destructive test, permission prompt, or test-data caution.

### Breadcrumbs
- Location of each new `[UI-REDESIGN / Stage N]` breadcrumb.
- One-line WHAT / WHY / FUTURE summary of each.

### Diff and risk notes
- Unrelated pre-existing changes preserved.
- Known limitations or remaining risks.
- What the next stage would do — but do not start it.

End with exactly:

> **STOPPED AT STAGE `<label>` — waiting for your manual test result. On pass, reply `STAGE <label> PASSED — COMMIT`; then, to continue, reply `PROCEED TO STAGE <next label>`.**

Substitute the real labels. For example, at the end of Stage 1A: "STOPPED AT STAGE 1A — waiting for your manual test result. On pass, reply `STAGE 1A PASSED — COMMIT`; then, to continue, reply `PROCEED TO STAGE 1B`." At the end of Stage 7 there is no next stage — ask for the `STAGE 7 PASSED — COMMIT` confirmation only.

**Stage 0 exception:** Stage 0 is inspection-only and creates no edits or commit. At the end of Stage 0, ask only for `PROCEED TO STAGE 1A`. Do not request `STAGE 0 PASSED — COMMIT`.

---

## Start now

Perform **Stage 0 only**. Inspect, report, and stop. Do not modify the repository. Do not create a branch.
