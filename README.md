# Loop Browser Gallery (LBG)

Loop Browser Gallery is a local-first browser app for browsing, organizing, and presenting user-controlled media.

It is designed around normal browser/OS file access rather than uploads, accounts, or a media server. Media can come from a traditional folder picker, the File System Access API, or storage the operating system already exposes as normal files — including a Google Drive folder that ChromeOS has mounted into the Files interface.

**Browser Gallery is a standalone product.** It is a complete personal-media application on its
own, and it does not require StreamLoop — or any account, backend or companion product — to exist,
operate, or provide value. It was deliberately architected so that it *can* integrate deeply with
StreamLoop, and that relationship should be preserved. Both things are true at once:

> **Standalone first. Seamlessly integrable by design.**

## Product North Star

> **Same media. Different device. Same Curation. Almost no setup.**
>
> **Choose Folder → Choose Curation → Done.**
>
> **Make the machine think harder so the human thinks less.**

Browser Gallery deliberately **hides its own identity machinery**. Underneath the interface it
maintains durable logical collection identity, per-device identity, a synchronized fact model,
proven folder-ancestry evidence and a media alias index. None of that is a customer concept, and
the customer should not have to learn any of it to reach their media.

The customer owns roughly three ideas: **my media**, **my Curation**, **my devices**. Curation —
the saved set of Favorites, Hidden items and Tags — is the one concept that genuinely deserves
prominence, and it should become more prominent as everything else recedes. Media Library,
`libraryId`, `mediaId`, scopes, replicas, association facts, transports and alias indexes are
architecture. They are important, they are load-bearing, and they should normally be invisible.

The governing rule is that **added complexity must reduce customer work**. Stronger architecture
is meant to purchase simplicity; if it has not bought any, it has not been spent. Every change is
measured against one regression test: *does this make the user think or do more than before?* If
it does, there must be a concrete unavoidable reason.

Browser Gallery is intended to become a prepared personal-media runtime in its own right. The
native target is **Open Browser Gallery → Enjoy your media**. The automation target is
**Press go → start go** — anything driving Browser Gallery should be able to load a source, set a
Curation, filter, shuffle and play without opening a folder picker or running setup inside every
panel. That runtime is worth building for Browser Gallery's own users; it is also exactly what
lets Browser Gallery act as **StreamLoop's personal-media arm** when the two products are used
together. That phrase names an integration role, not a dependency.

**Required reading before any North Star work:** [`Reports and Docs/NORTH-STAR.md`](Reports%20and%20Docs/NORTH-STAR.md) — the
full product/architecture constitution, including the decision ladder, the parent/child and
cross-device rules, the Media Library philosophy, and the anti-patterns future agents must not
reintroduce.

## Current capabilities

LBG currently supports:

- Choose Files
- Choose Folder with `webkitdirectory`
- File System Access API folder loading
- Remembered FSA libraries
- Multiple remembered FSA folders
- Recursive folder discovery
- Playback from an OS-mounted Google Drive folder (see below)
- Image playback
- Browser-native video playback
- MPEG-TS (`.ts`) discovery and playback through Browser Gallery's dedicated TS playback engine
- Progressive/batched loading for large collections
- Lazy thumbnail mounting
- Gallery browsing
- Presentation Mode
- Fill Panel / simulated fullscreen presentation
- Previous / Next navigation
- Sequential navigation
- Shuffle
- Browser-style Shuffle history
- Slideshow timing
- Playlist Loop
- Per-video Loop
- Loop Automations
- Favorites
- Hidden Media
- Undo Last Hide
- User Tags
- Tag management
- Presentation Quick Tagging
- Gallery Tag Filtering
- Type filtering (All / Images / Videos)
- Favorites filtering and newest-first favorite ordering
- Shared filtering across Gallery / Presentation / Slideshow / Shuffle
- Multiple Curations (called Profiles in internal code — see [Curations](#curations))
- Curation creation, switching and deletion
- Curation import/export
- Merge / Replace import behavior
- Persistent Curation data through IndexedDB

## Local-first by design

LBG does not upload media to a backend.

The normal architecture is:

```text
User-controlled storage
        ↓
Browser / operating-system file access
        ↓
Loop Browser Gallery
```

That storage may physically be:

- Chromebook/local storage
- removable storage
- a synced Google Drive folder
- another cloud-backed folder exposed by ChromeOS
- a network-backed folder
- an FSA directory handle

LBG does not need to know which cloud provider or disk originally owns the bytes if the browser presents them through the normal File/Blob APIs.

This keeps the app local-first without artificially restricting it to internal-device storage.

### Google Drive media

Browser Gallery can play media **directly from a Google Drive folder** when Drive is exposed
through the Chromebook / operating-system Files interface and that folder is selected through one
of Browser Gallery's supported folder-access paths.

- The media **stays in the user's Google Drive / OS-mounted folder**. Nothing is uploaded to a
  Browser Gallery backend, because there isn't one.
- Images and supported video formats both work.
- `.ts` / MPEG-TS files work too, through the dedicated TS playback adapter.
- The browser receives ordinary `File`/`Blob` access from the OS/provider layer, so this needs no
  separate playback stack merely because the bytes originate in Drive.

**This is not the Google Drive API.** The proven path today is:

```text
OS/ChromeOS-mounted Google Drive folder
        ↓
Browser Gallery provider
        ↓
normal media pipeline
```

A Drive *API* integration is a separate future concern, and where it is being considered it is for
**sync data**, not for media playback — see [`Reports and Docs/NORTH-STAR.md`](Reports%20and%20Docs/NORTH-STAR.md).

## Media loading

LBG currently has two independent folder-access paths.

### Traditional browser folder selection

`src/providers/local-file-input-provider.js`

Supports normal browser-selected files and `webkitdirectory` folder selection.

This remains a proven compatibility path and is intentionally not replaced by FSA.

### File System Access API

`src/providers/fsa-file-provider.js`

Supports recursive traversal of a `FileSystemDirectoryHandle`.

The FSA provider includes:

- recursive walking
- diagnostics
- incomplete-scan reporting
- per-file error recording
- cancellation/supersession protection
- batched MediaItem creation

Both providers produce the same downstream MediaItem shape so Gallery, Runtime, Profiles, Tags, filtering, and playback do not need separate implementations for each source.

## Remembered FSA Libraries

LBG can remember multiple previously selected FSA folders.

`src/storage/library-registry.js` stores library access/identity information separately from Profile data.

A remembered library may contain information such as:

- directory handle
- library ID
- display name
- item count
- last opened time
- last scanned time

Folder identity uses the File System Access API's `isSameEntry()` behavior instead of comparing names alone.

This matters because two unrelated folders can have the same name.

## Curations

**Product language note.** What the customer calls a **Curation**, the code calls a **Profile**.
The customer-facing concept is the Curation: one saved set of Favorites, Hidden items and Tags.
Internal modules, class names and persistence APIs (`profile-store.js`, `profileId`,
`setLibraryAssociation`, the `profiles` map in the replica) still use the historical `Profile`
terminology, and **that is fine**.

> **Do not mechanically rename the internal Profile architecture for documentation consistency.**
> It is load-bearing in persisted records, synchronized facts and on-disk sync files. Renaming it
> is an audited migration, not a find-and-replace.

Use *Curation* in anything a customer reads. Use *Profile* when naming the code.

LBG supports multiple persistent Curations.

A Curation is an independent curation context containing data such as:

- Favorites
- favorite timestamps
- Hidden Media
- Tag vocabulary
- per-media tag assignments
- profile identity/name
- master-folder metadata

Each Curation has a stable generated profile ID.

Curations can be:

- created
- switched
- deleted
- exported
- imported
- merged
- replaced

Switching Curations fully isolates one Curation's data from another.

Persistent media identity is based on portable `relativePath`, not a temporary object URL or runtime index.

## Tags

Tags are persistent Curation data.

LBG currently supports:

- Create Tag
- Rename Tag
- Delete Tag
- Apply/remove Tags from media
- Presentation Quick Tagging
- Gallery Tag Filtering
- Multiple active Tag filters

Deleting a Tag also removes stale references to that Tag from media records.

## Filtering

Filtering is shared rather than reimplemented separately by each playback mode.

Conceptually:

```text
All Loaded Media
      │
      ▼
View
(All / Favorites)
      │
      ▼
Type
(All / Images / Videos)
      │
      ▼
User Tags
      │
      ▼
Visible Collection
      │
      ▼
MediaRuntime
      │
      ├── Gallery
      ├── Presentation
      ├── Slideshow
      └── Shuffle
```

Future filters should extend this pipeline rather than create parallel filtering logic.

## Presentation Mode

Presentation Mode is the flagship experience.

Current Presentation capabilities include:

- Favorite
- Previous
- Play / playback control
- Next
- Hide
- Undo Hide
- Video Loop
- Loop Automations
- Presentation Tags
- Ghost opacity controls
- Presentation settings
- Fill Panel
- Exit Presentation

Presentation intentionally hides normal Gallery controls so the experience remains media-first.

## Looping and automation

LBG has multiple distinct loop concepts.

### Playlist Loop

Controls whether the overall media sequence loops.

### Video Loop

Loops the currently displayed video.

### Loop Automations

Presentation supports rules including:

- Loop Forever
- Loop X Times
- Loop Until Timer

Automation state is currently session/presentation state rather than persistent Profile data.

## MPEG-TS playback

`.ts` files are supported through a dedicated playback path — one of Browser Gallery's more
distinctive capabilities, and the reason `.ts` media works here without a server.

`src/playback/ts-playback-adapter.js` uses mux.js + MediaSource to transmux compatible MPEG-TS content for playback in the existing `<video>` element.

This is transmuxing rather than server-side transcoding.

The provider layer is responsible for discovering/classifying `.ts` files; the playback adapter handles the special playback requirement.

Because the adapter consumes normal `File` objects, the same TS path can be used regardless of whether the file came from the WebKit picker or FSA, provided the browser can read the file.

Current TS support should still be considered a working implementation undergoing broader regression/hardening tests, especially for large files and unusual codecs.

## Persistence

LBG currently uses IndexedDB for persistent state.

There are intentionally separate persistence domains.

### Profile persistence

`src/profile/indexeddb.js`

Stores:

- Profile Registry
- active Profile ID
- per-Profile item records
- per-Profile Tag vocabulary

### FSA Library persistence

`src/storage/library-registry.js`

Stores remembered FSA library handles and metadata.

Profiles and FSA Libraries are intentionally not the same thing.

A Profile describes curation/context.

A Library describes an accessible media source.

## Architecture

Major components include:

- `src/main.js`
  - UI coordination
  - Gallery rendering
  - Presentation rendering
  - filtering
  - provider coordination
  - UI/session-only workflow state

- `src/runtime/media-runtime.js`
  - current collection
  - navigation
  - shuffle/history
  - slideshow
  - playlist playback state

- `src/profile/profile-store.js`
  - persistent curation
  - Favorites
  - Hidden Media
  - Tags
  - multi-profile behavior
  - import/export

- `src/profile/indexeddb.js`
  - Profile persistence boundary

- `src/providers/local-file-input-provider.js`
  - traditional browser File / WebKit folder loading

- `src/providers/fsa-file-provider.js`
  - File System Access recursive loading

- `src/storage/library-registry.js`
  - remembered FSA libraries

- `src/playback/ts-playback-adapter.js`
  - MPEG-TS playback adapter

For the deeper product/architecture model, see
[`Reports and Docs/NORTH-STAR.md`](Reports%20and%20Docs/NORTH-STAR.md).

## Breadcrumbs

**Breadcrumbs are architectural memory.** This codebase records *why*, not just *what* — including
the defects that paid for each rule. That is the reason correct decisions here have survived being
casually undone across many stages and several agents.

The test a breadcrumb has to pass:

> **A future agent should be able to distinguish a rule nobody revisited from a rule the project
> paid dearly to learn.**

**Breadcrumbs are what lets old implementation reports eventually disappear.** They are the
concise, durable architectural memory that survives after the reports that produced them are
deleted. Or, put the way the product owner puts it:

> **The best there is, the best there was, and the best there ever will be.**

Which translates directly into three engineering jobs. Two conventions are current and neither
replaces the other: `[WHY: …]` blocks carry the reasoning for a specific decision at the point
where it is made; `BREADCRUMBS` blocks explain a seam's trajectory through time.

#### `BREADCRUMBS — IS` — the best current truth

- what is true **now**
- why it is true
- which invariant it protects

#### `BREADCRUMBS — WAS` — the best relevant historical lesson

Only history that explains why today's design would otherwise look strange or removable:

- what used to happen
- what failed
- what we learned
- why casually reverting would be dangerous

**WAS is not a changelog.** Git already provides the changelog. If the history does not explain a
present rule, leave it out.

#### `BREADCRUMBS — WILL BE / FUTURE` — protected optionality

Add this **only when today's code is intentionally shaped** to preserve an approved future
direction:

- the future capability the seam protects
- what today's code must not do
- why that optionality matters

> **A FUTURE breadcrumb is architectural protection, not feature brainstorming.**

Do not add one merely because somebody had an idea. If today's code is not actually shaped by it,
it does not belong in the code.

Keep them to one or two sentences. A breadcrumb that describes what the next line does has failed;
one that explains why the next line is not the obvious alternative has succeeded.

The full breadcrumb constitution, and the approved current → future directions it protects, are in
[`Reports and Docs/NORTH-STAR.md`](Reports%20and%20Docs/NORTH-STAR.md).

## Source-of-truth rule

LBG is developed incrementally and some historical documentation may become stale. When sources
disagree, **first decide which question you are actually asking** — the two have different
hierarchies, and conflating them is how a future agent talks itself into the wrong answer.

### A. What does Browser Gallery do *today*?

1. Current working implementation
2. `[WHY: …]` and `BREADCRUMBS — IS` / `— WAS` beside that implementation
3. Current README / architecture documentation
4. Implementation reports and historical notes

This answers **current fact**. Do not rewrite working behavior solely because an older document
describes something differently.

### B. Where is Browser Gallery *going*?

1. Human product-owner decisions
2. [`Reports and Docs/NORTH-STAR.md`](Reports%20and%20Docs/NORTH-STAR.md) — the approved governing product/architecture
   direction
3. `BREADCRUMBS — WILL BE / FUTURE` at intentionally protected seams
4. Current roadmap / approved phase documentation
5. Reports and speculative notes

This answers **approved direction**.

### The rule that keeps these straight

> **Current implementation does not veto an approved future direction merely because the future
> has not been built yet.**

A future agent must not reason: *"the current UI exposes Media Library, therefore that outranks
the North Star direction to hide it."* That is exactly backwards. The current UI is the correct
answer to question A and has no authority over question B.

Equally: an approved direction does not license breaking working behavior on the way there. Use
hierarchy A to learn what is true, hierarchy B to learn where to take it, and change things
deliberately in slices.

## Reports and Docs

Architecture audits, implementation handoffs, implementation reports, testing reports, planning
documents and debugging archaeology live in `Reports and Docs/`.

### One documentation home

There is exactly one documentation home. `docs/` no longer exists — it was consolidated into
`Reports and Docs/`, and durable documents now sit at that folder's root:

```text
README.md                     ← repo root

Reports and Docs/
  NORTH-STAR.md               ← durable — the product/architecture constitution
  <other audited/current docs> ← durable

  North-Star/                 ← temporary working history
  V3.../                      ← temporary working history
  Google-Sync/                ← temporary/initiative history
```

The rule that keeps it one home:

> **Durable documents live at the root of `Reports and Docs/`. Everything in a phase or slice
> subfolder is temporary working history.**

Do not reintroduce a second top-level documentation directory. If a document is durable, promote
it to the root of `Reports and Docs/` rather than giving it a new home of its own.

**Reports exist to help us do the work. They are not permanent architectural source-of-truth.**

> **A report should eventually become unnecessary.**

Whatever a report discovers that turns out to be *durable* must graduate into a permanent layer —
production code, tests, `[WHY: …]`, `BREADCRUMBS`, this README, `Reports and Docs/NORTH-STAR.md`, or another
current architecture document. Once it has graduated, the report has done its job.

### Structure

```text
Reports and Docs/
  <Major Phase>/            e.g. V3/, North-Star/, Google-Sync/
    <Slice>/                e.g. N1/, N2/  — added once a slice accumulates history
      001-N2-ARCHITECTURE-HANDOFF.md
      002-N2-IMPLEMENTATION-REPORT.md
      003-N2-UX-CORRECTION.md
      004-N2-REGRESSION-AUDIT.md
```

A major phase or initiative gets a folder. A slice gets its own subfolder **once it starts
accumulating implementation history** — don't create one for a single small report.

### Numbering, and why history is additive

Use sortable numeric prefixes (`001-`, `002-`, `003-…`) with a descriptive name after the number,
so chronological order is obvious at a glance. Every report also carries a human-readable
timestamp near the top, in the product owner's local time (**Calgary — `America/Edmonton`**), with
the timezone abbreviation:

```text
Thursday, August 27, 2026 — 9:55 AM MDT
```

**One slice does not mean one implementation.** A slice may take many passes; if N2 genuinely took
eighteen meaningful implementation and review passes, then roughly eighteen records is the
*correct* outcome. Each new implementation or review event gets a **new numbered record**.

> **Do not overwrite meaningful prior reports to keep a folder tidy.**

### Living documents vs historical records

| Kind | Examples | Rule |
| --- | --- | --- |
| **Living** — describe current approved truth | `README.md`, `Reports and Docs/NORTH-STAR.md`, a current slice handoff | **Revise in place.** No new timestamp needed per edit unless the document already tracks revision metadata |
| **Historical** — record an event that happened | audits, implementation reports, corrections, regression reports | **Additive.** New event → new numbered file, stamped |

### Phase and slice report folders will be deleted

These folders are **temporary by design**. They are not merely *deletable* — they **will**
eventually be deleted. The only open question is *when*.

The gate is one question:

> **Can this report folder disappear without losing knowledge needed to safely understand or
> modify Browser Gallery?**

Durable knowledge should already have graduated into code, tests, `[WHY: …]`, `BREADCRUMBS`, this
README, or a current durable document. If it has not, the answer is not "keep the reports forever"
— it is **name what still needs to graduate, graduate it, then delete**.

> **A future agent should not need V3's report folder in order to safely understand V3.**

If one would, that is a documentation defect to fix *before* deleting — not a reason to keep the
archive.

#### Retention review — and deletion

Either agent can perform a retention review on a report or folder and report:

```text
REPORT RETENTION REVIEW

PATH:
STATUS: SAFE TO DELETE / KEEP

MISSING DURABLE KNOWLEDGE:
ACTIVE DEPENDENCIES:
RECOMMENDATION:
```

> **When a report or completed phase folder is verified SAFE TO DELETE, delete it.**

This applies to Claude and Codex alike. No separate human permission is required — the review
*is* the authorization — unless the human has explicitly asked for that material to be preserved.
Durable documents (`README.md`, `Reports and Docs/NORTH-STAR.md`, other current durable docs) are
not temporary reports and are never in scope.

If important knowledge exists only in the report, **graduate it first, then delete.** A folder
that cannot yet be deleted is a work item, not a permanent resident.

Two things make deletion the *safer* option once the gate passes. Stale reports accumulate
superseded conclusions — an intermediate audit that a later pass reversed reads exactly like a
current one, and a future agent can implement the wrong answer in good faith. And an archive
nobody can safely ignore quietly becomes required reading, which is the outcome breadcrumbs exist
to prevent.

## For AI agents

Read what is relevant. Do not read the archive.

```text
1. README.md                    (this file)
2. Reports and Docs/NORTH-STAR.md   when doing North Star / product-architecture work
3. the relevant code, plus nearby [WHY:] and BREADCRUMBS
4. the current handoff for the slice being worked on
```

**Do not** automatically read every old phase report, every V2/V3 audit, or every historical
implementation log. Open historical reports only when:

- the current handoff explicitly points there
- a breadcrumb says the history matters
- debugging genuinely requires archaeology
- the human asks for it

Keeping context small is not a shortcut — it is what keeps reasoning quality high. Breadcrumbs
exist precisely so that the history does not have to be re-read to be respected.

### Do not outsource testing to the human

> **Do not ask the user to manually test behavior that internal automated testing already
> proves.**

Human testing is for what automation genuinely cannot reach:

- visual and UX judgment
- subjective workflow feel
- browser/OS permission UI that cannot be deterministically exercised
- other genuinely non-automatable behavior

If an agent asks for human testing, it must (1) say why automated testing cannot prove it, and
(2) ask for the **smallest** necessary check.

**Manual testing is not a duplicate regression layer.** Re-running by hand what a suite already
covers pays twice for the same assurance and erodes both the user's patience and the workflow.

### Work proportionally

> **Prompt size and analysis depth should be proportional to task size, risk, and ambiguity.**

```text
tiny task                → tiny prompt, act
bounded task             → focused prompt
high-risk architecture   → detailed prompt, full analysis
```

Strong reasoning should improve *judgment*, not inflate routine work. A one-line fix does not need
an audit; an identity-safety change does. AI should make the workflow faster and clearer — never
slower through ceremony nobody asked for.

## Running locally

Because the project uses ES modules, serve it through a small static server instead of opening `index.html` directly as a file.

### Python

```bash
python -m http.server 8080
```

Then open:

```text
http://localhost:8080
```

### Node

For example:

```bash
npx serve .
```

## Static hosting

LBG does not require an application backend.

It can be served as static files through services such as:

- GitHub Pages
- Netlify
- Vercel
- Cloudflare Pages

Browser/platform APIs still determine which local file-access capabilities are available in a given environment.

## Browser notes

### Choose Files

Works broadly in modern browsers.

### Choose Folder (`webkitdirectory`)

Works best in Chromium-based environments and remains the proven folder-loading path.

### File System Access API

FSA support depends on the browser/platform and permission model.

Persisted handles may require permission to be granted again after a restart depending on browser behavior.

The FSA path is intentionally additive rather than a replacement for `webkitdirectory`.

## Current areas of active development

Current work is focused on:

- FSA reliability and large-library testing
- remembered-library/Profile relationships
- Search / Jump / Last Tagged semantics
- mode-aware Status Update Center behavior
- architecture breadcrumbs
- `.ts` regression and source-path testing
- continued Presentation workflow refinement

## Non-goals

LBG is intentionally not trying to become:

- a Digital Asset Management platform
- a photo editor
- a centralized or general-purpose media server (Plex/Jellyfin-style)
- an online media host
- an LBG cloud-account platform
- a general-purpose file manager

The goal is narrower:

> Make browsing, organizing, and presenting user-controlled media fast, lightweight, and enjoyable.

**On the media-server line specifically.** Browser Gallery is not becoming a centralized media
server product. That is different from saying it will never serve bytes locally: the approved
native trajectory may eventually include a very small **private localhost media gateway**, so that
registered local media can be consumed by StreamLoop (or by Browser Gallery's own native runtime)
without a folder-picker round trip. That is a narrow local bridge for media the user already owns
on that machine — not a hosted service, not a library others connect to, not a product surface.
See [`Reports and Docs/NORTH-STAR.md`](Reports%20and%20Docs/NORTH-STAR.md) for the trajectory and the constraints on it.
