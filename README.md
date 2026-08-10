# Loop Browser Gallery (LBG)

Loop Browser Gallery is a local-first browser app for browsing, organizing, and presenting user-controlled media.

It is designed around normal browser/OS file access rather than uploads, accounts, or a media server. Media can come from a traditional folder picker, the File System Access API, or storage the operating system already exposes as normal files.

## Current capabilities

LBG currently supports:

- Choose Files
- Choose Folder with `webkitdirectory`
- File System Access API folder loading
- Remembered FSA libraries
- Multiple remembered FSA folders
- Recursive folder discovery
- Image playback
- Browser-native video playback
- MPEG-TS (`.ts`) discovery and playback through a dedicated TS playback adapter
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
- Multiple Profiles
- Profile creation
- Profile switching
- Profile deletion
- Profile import/export
- Merge / Replace import behavior
- Persistent profile data through IndexedDB

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

## Profiles

LBG supports multiple persistent Profiles.

A Profile is an independent curation context containing data such as:

- Favorites
- favorite timestamps
- Hidden Media
- Tag vocabulary
- per-media tag assignments
- profile identity/name
- master-folder metadata

Each Profile has a stable generated profile ID.

Profiles can be:

- created
- switched
- deleted
- exported
- imported
- merged
- replaced

Switching Profiles fully isolates one Profile's curation data from another.

Persistent media identity is based on portable `relativePath`, not a temporary object URL or runtime index.

## Tags

Tags are persistent Profile data.

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

`.ts` files are supported through a dedicated playback path.

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

For the deeper architectural model, see:

- `docs/000-PHILOSOPHY.md`
- `docs/001-ARCHITECTURE.md`
- `docs/002-ROADMAP.md`

## Source-of-truth rule

LBG is developed incrementally and some historical documentation may become stale.

When sources disagree, use this order:

1. Current working implementation
2. `BG BREADCRUMB` comments and other explicit architectural comments beside the code
3. Current architecture / roadmap documentation
4. Historical changelogs, implementation notes, and planning material

Do not rewrite working behavior solely because an older document describes something differently.

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
- a media server
- an online media host
- an LBG cloud-account platform
- a general-purpose file manager

The goal is narrower:

> Make browsing, organizing, and presenting user-controlled media fast, lightweight, and enjoyable.
