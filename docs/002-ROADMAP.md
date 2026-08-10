# Loop Browser Gallery (LBG)

# 002 — Roadmap

This roadmap reflects the current direction of Loop Browser Gallery.

Development follows four stages:

- ✅ Complete
- 🚧 In Progress
- 📋 Planned
- 💡 Future Ideas

The roadmap intentionally prioritizes simplicity.

Features are added when they improve the experience of browsing, organizing,
and presenting media without breaking the project's architectural boundaries.

The current implementation is the factual source of truth. If this roadmap
falls behind the code, inspect the implementation and `BG BREADCRUMB` comments
before changing working behavior.

---

# Design Principles

Loop Browser Gallery is guided by a few core principles:

- Local-first
- Fast by default
- Progressive disclosure
- Reduce before adding
- Shared architecture over duplicated logic
- Build foundations that future features naturally extend
- Preserve independent responsibilities
- Prefer one source of truth for each kind of state

Every new feature should reinforce these principles rather than compete with
them.

---

# Foundation

The architectural backbone of LBG.

## Status

✅ Complete

### Completed

- Runtime / Profile separation
- Modular MediaRuntime
- ProfileStore persistence boundary
- IndexedDB persistence
- Stable relative-path media identity
- Local-first architecture
- Presentation architecture
- Responsive UI foundation
- Shared MediaItem contract
- UI / Runtime / Profile responsibility separation
- Profile data vs Profile Registry separation
- FSA Library Registry separation
- TS playback adapter boundary

The core architecture is considered stable.

Future development should extend these systems rather than replace them.

---

# Media Loading & Providers

LBG currently supports more than one local folder-access path.

## Status

🚧 In Progress

### Completed

- Choose Files
- `webkitdirectory` folder loading
- Progressive/batched media loading
- Common media classification
- Image support
- Browser-native video support
- `.ts` discovery fallback
- `.ts` playback through the TS Playback Adapter
- File System Access API provider
- Recursive FSA traversal
- FSA traversal diagnostics
- Incomplete/fatal-scan reporting
- FSA/WebKit relative-path compatibility
- Shared supported-file classification between providers

### Current Focus

- FSA reliability / traversal completeness testing
- Physical-device regression testing
- Large-library performance
- Confirming `.ts` playback across all supported source paths

### Planned

- Additional provider hardening where justified by real tests
- Additional playback adapters only when needed

The WebKit path and FSA path intentionally coexist.

FSA is not intended to replace the proven folder-input path simply for
architectural cleanliness.

---

# FSA Libraries

Persisted File System Access folders / libraries.

## Status

🚧 In Progress

### Completed

- Persisted FSA directory handles
- Recent Libraries UI foundation
- Multi-library registry
- Library identity via `isSameEntry()`
- Stable generated library IDs
- Item-count metadata
- Last-opened / last-scanned timestamps
- Remove remembered library
- Migration from the earlier single saved-folder slot
- Library persistence kept separate from ProfileStore

### Current Focus

- Multi-library workflow refinement
- Permission / stale-handle behavior
- More reliable scan diagnostics
- Relationship between remembered FSA libraries and Profiles

### Planned

- Profile ↔ FSA Library association
- Profile auto-detection from a selected/remembered master library
- Restore the correct profile/context when reopening a known library

A Library describes an accessible media source.

A Profile describes user curation.

These remain intentionally separate until an explicit association layer is
introduced.

---

# Gallery

The primary workspace for preparing media.

## Status

🚧 In Progress

### Completed

- Thumbnail Gallery
- Progressive thumbnail loading
- Favorites
- Favorites newest-first ordering
- Hidden Media
- Hidden-media visual de-emphasis
- Quick Favourite
- Undo Last Hide
- Responsive layout
- Media metadata foundation
- View filtering (All / Favorites)
- Type filtering (All / Images / Videos)
- User Tag filtering
- Multi-tag filtering
- Shared filtering pipeline
- Gallery media navigation / Find / Play workflow
- Randomized initial selection rules
- Profile Export / Import controls

### Current Focus

- Search / Jump / tagging interaction
- Status Update Center semantics
- Tagging-position tracking
- Shuffle-aware tagging state
- Gallery UI refinement

### Planned

- Search refinements
- Collections
- Ratings
- Richer metadata

---

# Tags

Persistent user-defined organization and classification.

## Status

✅ Foundation Complete / 🚧 Workflow Refinement

### Completed

- Tag vocabulary
- Create tag
- Rename tag
- Delete tag
- Persistent tag vocabulary
- Per-media tag assignment
- Tag persistence per Profile
- Tag cleanup when vocabulary entries are deleted
- Presentation Quick Tagging
- Gallery Tag Filtering
- Multi-select tag filters
- Tag-aware shared filtering pipeline
- Profile import/export support for tags

### Current Focus

- Tag → Search auto-population
- Last Tagged → Jump/position workflow
- Keeping Search position and Last Tagged position distinct
- Mode-aware Status Update Center
- Shuffle ON/OFF tagging context

### Future

- Tag-aware automation
- Collections built from tags
- More advanced organizational workflows

---

# Presentation Mode

The flagship experience of LBG.

## Status

🚧 In Progress

### Completed

- Presentation Overlay
- Previous / Play / Next
- Favorite toggle
- Hide Media
- Undo Hide
- Ghost Controls
- Ghost opacity pop-under
- Keyboard shortcuts
- Presentation Settings
- Exit Presentation
- Fill Panel / simulated fullscreen behavior
- Video Loop
- Loop Automation
- Presentation Quick Tags
- Presentation UI isolation from normal Gallery controls

### Current Focus

- Presentation polish
- Status/position clarity
- Automation UX refinement
- Tagging workflow refinement
- Regression hardening across source/provider types

Presentation should remain immersive and lightweight.

---

# Loop Automation

One of the defining Presentation features of LBG.

## Status

✅ Foundation Complete / 🚧 Refinement

### Completed

- Loop Forever
- Loop X Times
- Loop Until Timer
- Automation Engine
- Automation UI workflow
- Correct X-Times total-play semantics
- Finite-rule completion handoff
- Manual navigation invalidation
- Stale callback protection
- One-click 🤖 enable/open workflow
- Session-only automation state

### Current Focus

- Workflow polish
- Regression protection
- Clear separation between draft automation UI and active playback rule

### Future

- Rule chaining
- Tag-aware automation
- Additional conditions
- Presentation workflows
- Stream Loop integration

Automation should remain powerful internally while appearing simple and
predictable to the user.

---

# Profiles

Persistent user curation and identity.

## Status

🚧 In Progress

### Completed

- Favorites
- Favorite timestamps
- Hidden Media
- User Tags
- Profile Export
- Profile Import
- Profile Merge
- Profile Replace
- Relative-path identity
- IndexedDB persistence
- Stable generated Profile IDs
- Profile Registry
- Active Profile pointer
- Profile names
- Master-folder metadata
- Multi-profile creation
- Profile switching
- Full state isolation between profiles
- Profile deletion
- Safe fallback when deleting the active/last profile
- Legacy single-profile migration

### Current Focus

- Profile ↔ FSA Library relationship
- Profile auto-detection from remembered libraries
- Profile as a broader context object

### Planned

- Smarter context restoration
- Collections
- Ratings
- Additional persisted preferences where they genuinely belong to Profile

Profiles should increasingly represent a coherent user context without
becoming a dumping ground for unrelated session or library state.

---

# Filtering Architecture

A shared filtering pipeline used throughout the application.

## Status

✅ Foundation Complete

Current pipeline:

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

### Completed

- Central filter function
- View filtering
- Type filtering
- Tag filtering
- Combined filters
- Favorites ordering
- Runtime receives already-filtered collections

### Planned

- Search integration where appropriate
- Future collection/rating filters

Future capabilities should extend this pipeline rather than create parallel
feature-specific filtering logic.

---

# Navigation

Presentation and Gallery navigation.

## Status

✅ Core Complete / 🚧 Workflow Refinement

### Completed

- Previous / Next
- Sequential navigation
- Browser-style shuffle history
- Forward replay after Back
- Shuffle-cycle repeat avoidance
- Hidden-media skipping
- Keyboard navigation
- Gallery Find / Play navigation foundation

### Current Focus

- Search vs Jump semantics
- Last Tagged checkpoint behavior
- Shuffle-aware status reporting

---

# Status Update Center

A compact place to preserve useful workflow context.

## Status

🚧 In Progress

### Current Focus

- Distinguish Current Viewer Position from Last Tagged Position
- Record tagging mode at the moment of tagging
- Show Shuffle ON / Shuffle OFF context
- Prevent ordinary navigation from overwriting the Last Tagged checkpoint
- Keep Search-related position distinct from Last Tagged position

Conceptually:

```text
Current Viewer

Last Tagged
├── position/context
├── total
└── mode
    ├── Shuffle ON
    └── Shuffle OFF
```

This state should be made unambiguous before any future Profile/FSA context
persistence is introduced.

---

# TS Playback

Browser playback support for MPEG Transport Stream media.

## Status

✅ Proof of Concept Working / 🚧 Hardening

### Completed

- `.ts` extension fallback when browser MIME is empty
- Discovery through the same media-provider classification path
- Dedicated TS Playback Adapter
- mux.js transmuxing
- MediaSource playback through the existing video element
- Local Chromebook playback confirmed
- Existing Gallery/Presentation controls reused around TS media

### Current Focus

- Broader regression testing
- Synced Google Drive `.ts` test
- FSA `.ts` test
- Large-file memory behavior
- Codec/profile edge cases

### Future

- Incremental/chunked input instead of whole-file `arrayBuffer()` where useful
- Additional codec handling only if real media requires it

---

# Performance

Performance is considered a core feature rather than a milestone.

## Status

✅ Foundation Complete / 🚧 Continuous

### Completed

- Fast startup foundation
- Batched loading
- Yielding between large processing batches
- Progressive thumbnails
- Lazy thumbnail mounting
- Reduced unnecessary Gallery rebuilds
- Large collection support
- Object URL cleanup

### Current Focus

- FSA large-library reliability
- `.ts` memory behavior
- Cloud/Drive-backed file-read behavior
- Continued Chromebook testing

Optimization should remain evidence-driven rather than speculative.

---

# Architecture Breadcrumbs

Durable in-code reasoning for decisions that are not obvious from code alone.

## Status

🚧 Being Established

### Current Focus

Introduce `BG BREADCRUMB` comments around non-obvious architectural decisions,
especially:

- media identity / relative-path semantics
- Profile vs Library separation
- FSA/WebKit coexistence
- tagging-position semantics
- Shuffle-aware status state
- intentional session-only state
- future Profile/FSA association boundaries

Breadcrumbs should preserve decisions, not narrate obvious code.

When code and older docs disagree, current code plus explicit breadcrumbs take
priority.

---

# Stream Loop

The long-term evolution of Presentation Mode.

## Status

💡 Future Ideas

Current exploration includes:

- Automation integration
- Rule-based playback
- Dynamic playlists
- Scheduled presentations
- Intelligent playback rules
- Tag-aware behavior
- Collection-aware behavior

Rather than becoming a separate application, Stream Loop should build upon the
existing Gallery, Presentation, filtering, Profile, and Automation systems.

---

# Future Ideas

Ideas that are intentionally exploratory:

- Ratings
- Collections
- Presenter Notes
- Richer metadata
- Folder Playlists
- Additional automation conditions
- Smarter Profile/FSA context restoration
- Additional local/media providers
- Additional playback adapters

Ideas may evolve or disappear as the project matures.

---

# Out of Scope

The following are intentionally not core project goals:

- User accounts
- Media server functionality
- Digital Asset Management (DAM)
- Photo editing
- AI tagging
- Online media hosting
- Building provider-specific cloud-account integrations inside LBG when the OS/browser can already expose the storage as normal files

LBG may consume media that originates from synced/cloud-backed or network-backed
storage when the operating system/browser presents it through the same local
file abstractions.

That does not change LBG's local-first architecture.

Loop Browser Gallery remains focused on being a fast, lightweight way to
browse, organize, and present user-controlled media.
