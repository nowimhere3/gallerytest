# Loop Browser Gallery (LBG)

# 001 — Architecture

## Overview

Loop Browser Gallery (LBG) is a local-first browser application for browsing,
organizing, and presenting media.

Its architecture is intentionally divided by responsibility.

The core rule remains:

> Runtime manages the current media session.
>
> ProfileStore remembers persistent user curation.
>
> Providers discover media.
>
> Storage modules persist only the data they own.
>
> `main.js` coordinates these systems and owns UI/session-only behavior.

These boundaries matter more as LBG grows.

Features should extend the appropriate existing system rather than create
parallel sources of truth.

---

# Source of Truth

When documentation and implementation disagree, use this order:

1. Current working implementation
2. `BG BREADCRUMB` comments and other explicit architectural comments in code
3. Current architecture / roadmap documentation
4. Historical changelogs, implementation notes, and planning documents

Historical documentation explains how LBG arrived at its current design.

It does not override working code.

`BG BREADCRUMB` comments are especially important around decisions that may
look unnecessary or tempting to "simplify" without understanding why they
exist.

Before changing an architectural boundary, persistence model, media identity
rule, or deliberately separate code path, inspect nearby breadcrumbs and the
current implementation first.

---

# High-Level Architecture

Conceptually:

                    ┌─────────────────────────────┐
                    │            UI               │
                    │ Gallery / Presentation /    │
                    │ Profile / Library Controls  │
                    └──────────────┬──────────────┘
                                   │
                                   ▼
                    ┌─────────────────────────────┐
                    │          main.js            │
                    │ Coordination + UI/session   │
                    │ behavior                    │
                    └───────┬─────────┬───────────┘
                            │         │
                  ┌─────────┘         └─────────┐
                  ▼                             ▼
        ┌──────────────────┐          ┌──────────────────┐
        │   MediaRuntime   │          │   ProfileStore   │
        │ Playback / Nav   │          │ Persistent       │
        │ Session State    │          │ Curation State   │
        └──────────────────┘          └────────┬─────────┘
                                               │
                                               ▼
                                      ┌──────────────────┐
                                      │ Profile IndexedDB │
                                      │ Data + Registry   │
                                      └──────────────────┘


        ┌───────────────────────────────────────────────┐
        │               Media Sources                   │
        │                                               │
        │ LocalFileInputProvider    FsaFileProvider     │
        │ webkitdirectory/files     File System Access  │
        └──────────────────────┬────────────────────────┘
                               │
                               ▼
                     Common MediaItem Shape


        ┌────────────────────────────┐
        │    FSA Library Registry    │
        │ Remembered folder handles │
        │ and library metadata       │
        └────────────────────────────┘

The important architectural point is that the two folder-access mechanisms
converge on the same MediaItem contract.

Runtime, ProfileStore, filtering, Gallery rendering, and playback should not
need separate implementations depending on how a file was discovered.

---

# Core Components

## 1. MediaRuntime

`src/runtime/media-runtime.js`

MediaRuntime owns playback/navigation state for the currently loaded,
already-filtered media collection.

Responsibilities include:

- Current media item
- Previous / Next navigation
- Sequential navigation
- Shuffle
- Browser-style shuffle history
- Shuffle-cycle repeat avoidance
- Slideshow state
- Slideshow timing
- Playlist looping
- Hidden-item navigation avoidance
- Video-ended handoff
- Current runtime collection
- Runtime playback state

Runtime state is SESSION state.

Examples:

- current index
- shuffle history
- slideshow timer
- whether playback is running
- the current filtered collection

Closing/reloading the application may destroy this state.

That is intentional.

MediaRuntime must not become a persistence layer.

It may interact with ProfileStore through ProfileStore's public API, but it
does not own persistent favorites, hidden state, tags, profile identity, or
IndexedDB.

---

## 2. ProfileStore

`src/profile/profile-store.js`

ProfileStore owns persistent user curation and profile identity.

Current persistent profile data includes:

- ❤️ Favorites
- favorite timestamps / ordering metadata
- 🙈 Hidden Media
- User Tags assigned to media
- Tag vocabulary
- Profile identity
- Profile name
- Master-folder metadata

ProfileStore also owns multi-profile behavior:

- list profiles
- create profile
- switch active profile
- delete profile
- isolate one profile's data from another
- import profile data
- export profile data
- merge imports
- replace imports

Each media record is keyed by portable `relativePath`, not by an object URL,
temporary runtime index, or session-specific identifier.

This is critical.

A favorite/tag/hidden record should still refer to the same logical media when
the same folder structure is loaded in another session or imported elsewhere.

Profile records intentionally remain open-shaped so new persistent curation
fields can be introduced without unnecessarily breaking older profile data.

---

# Multi-Profile Model

LBG supports multiple independently-addressable profiles.

A profile represents an independent Gallery world.

Each profile has a stable `profileId`.

Profile identity metadata is separate from the profile's actual media
curation data.

Conceptually:

Profile Registry

    profileId
    name
    masterFolder
    createdAt
    updatedAt

Profile Data

    profileId
    items
    tags

Switching profiles must fully isolate persistent state.

Favorites, Hidden Media, and Tags from one profile must not leak into another.

Creating a profile and activating a profile are separate operations.

Deleting an active profile must always leave LBG with another valid active
profile; if necessary, a fresh default profile is created.

---

# Profile Persistence

## IndexedDB Boundary

`src/profile/indexeddb.js`

This module is the persistence boundary for ProfileStore data.

Nothing outside the Profile system should directly manipulate the profile
IndexedDB database.

IndexedDB stores two conceptually different things:

### Profile Data

One record per stable profile ID:

    {
      id,
      items,
      tags
    }

`items` contains the persistent per-media records keyed by `relativePath`.

`tags` contains the profile's tag vocabulary.

### Profile Registry

The registry stores identity/metadata for known profiles and identifies the
active profile.

Conceptually:

    {
      activeProfileId,
      profiles: [
        {
          id,
          name,
          masterFolder,
          createdAt,
          updatedAt
        }
      ]
    }

The registry does NOT contain each profile's item/tag data.

The profile data store does NOT decide which profile is active.

Those concerns intentionally remain separate.

---

# Media Sources

LBG currently has two independent local folder-access paths.

Neither replaces the other.

## Local File Input / WebKit Provider

`src/providers/local-file-input-provider.js`

This is the proven browser file-input path.

It supports browser-selected files and folder selection using the existing
file-input / `webkitdirectory` mechanism.

Responsibilities include:

- accepting browser `File` objects
- determining supported media
- creating MediaItems
- creating object URLs
- normalizing relative paths
- disposing object URLs

This path remains important for compatibility and as an independent fallback.

---

## File System Access Provider

`src/providers/fsa-file-provider.js`

This is the File System Access API path.

It recursively walks a `FileSystemDirectoryHandle`.

Responsibilities include:

- recursive folder traversal
- reading file handles
- collecting diagnostics
- distinguishing complete vs incomplete scans
- recording traversal errors
- batching MediaItem creation
- creating/revoking object URLs
- cancellation/supersession protection

A partial or interrupted traversal must never silently present itself as a
successful complete scan.

The FSA provider deliberately uses the same supported-file classification
logic as the traditional provider.

---

# Common MediaItem Contract

Both media providers converge on the same downstream MediaItem shape.

Conceptually, MediaItems contain fields such as:

    id
    name
    path
    relativePath
    type
    kind
    size
    lastModified
    file
    url
    mediaType
    systemTags
    userTags

Downstream systems should operate on this common contract rather than
branching on provider type.

This is one of the most important extensibility boundaries in LBG.

A future provider should ideally produce compatible MediaItems instead of
requiring a separate Gallery, Runtime, Profile, or filtering architecture.

---

# FSA Library Registry

`src/storage/library-registry.js`

Remembered FSA folders are NOT ProfileStore data.

They live in their own persistence system.

The Library Registry stores reusable folder identity/access information such
as:

- stable library ID
- directory handle
- display name
- item count
- last opened timestamp
- last scanned timestamp
- creation timestamp

It supports multiple remembered libraries.

Folder identity is determined using the File System Access API's real entry
identity (`isSameEntry`) rather than folder-name comparison.

This prevents two different folders with the same name from being treated as
the same library.

The Library Registry also handles migration from the earlier single saved
folder-handle model.

Why separate this from ProfileStore?

Because:

> A Profile describes user curation.

while:

> A Library describes an accessible media source.

Those are different kinds of persistent state and should not be coupled.

---

# Media Identity

Persistent media curation is keyed by `relativePath`.

Both WebKit and FSA loading paths should normalize paths so the same logical
file receives compatible relative-path identity regardless of which local
folder-access mechanism discovered it.

This is what allows Favorites, Hidden Media, Tags, and other Profile state to
continue working independently of the selected media provider.

Provider-specific IDs and object URLs are runtime conveniences.

They are not persistent media identity.

---

# Shared Filtering Pipeline

Filtering is coordinated centrally before media is handed to MediaRuntime.

Current dimensions include:

- View
  - All
  - Favorites
- Media Type
  - All
  - Images
  - Videos
- User Tags

Tag filters may be combined.

Gallery, Presentation, Slideshow, and Shuffle should consume the same filtered
collection rather than implementing independent filter rules.

Conceptually:

    All Loaded Media
           │
           ▼
        Favorites
           │
           ▼
       Media Type
           │
           ▼
        User Tags
           │
           ▼
    Visible Collection
           │
           ▼
      MediaRuntime
       /        \
   Gallery    Presentation

Future filters should extend this pipeline rather than create another one.

---

# Tags

Tags have two related but distinct forms.

## Tag Vocabulary

The profile owns the list of tags that exist:

    { id, name }

## Per-Media Tag Assignment

Individual media records store the IDs of tags applied to that item.

This allows:

- tag management
- Presentation quick-tagging
- Gallery tag filtering
- future tag-aware automation

Deleting a tag must not leave dangling assignments on media records.

Tags are Profile data and therefore remain isolated between profiles.

---

# Hidden Media

Hidden Media is persistent Profile data.

Hidden does NOT mean deleted.

A hidden item:

- remains on disk
- remains visible/manageable in Gallery
- remains part of Profile data
- is visually de-emphasized in Gallery
- is skipped by playback/navigation where appropriate

MediaRuntime understands enough about hidden state to avoid navigating to
hidden media and to move away when the current media becomes hidden.

The underlying persistent truth remains ProfileStore.

---

# Favorites

Favorites are persistent Profile data.

Favorites and Hidden Media are independent states.

An item may be:

- Favorite
- Hidden
- Both
- Neither

Favorite timestamps support Favorites ordering without changing ordinary
Gallery ordering.

ProfileStore remains the source of truth for favorite state.

---

# Presentation Mode

Presentation Mode is primarily a UI/presentation layer coordinated from
`main.js` on top of MediaRuntime.

It should not be treated as synonymous with Runtime itself.

Presentation currently includes capabilities such as:

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
- Exit
- Fill Panel behavior

Presentation should remain immersive.

Normal Gallery controls should not intrude into the Presentation experience.

---

# Looping and Automation

LBG contains more than one loop concept.

## Playlist Loop

MediaRuntime owns playlist-level looping/navigation behavior.

## Video Loop

Presentation can loop the currently displayed video.

## Loop Automations

Presentation supports rules such as:

- Loop Forever
- Loop X Times
- Loop Until Timer

These automation rules are intentionally session/presentation behavior.

They are not currently persistent Profile data.

The automation engine should remain separate from persistent user curation
unless a future feature explicitly introduces saved automation rules.

---

# TS Playback Adapter

`src/playback/ts-playback-adapter.js`

Transport Stream (`.ts`) playback is handled through a dedicated playback
adapter rather than by changing the core media-provider architecture.

Providers are responsible for discovering/classifying supported files.

The playback adapter is responsible for the special playback path required by
`.ts` media.

This separation allows `.ts` support to work regardless of whether the file
came from WebKit folder selection or the FSA provider.

Special playback requirements should remain adapters where practical rather
than leaking into ProfileStore, MediaRuntime, or media discovery.

---

# UI / Coordination Layer

`src/main.js`

`main.js` is intentionally the integration layer.

It connects:

- DOM controls
- providers
- MediaRuntime
- ProfileStore
- filtering
- FSA library selection
- TS playback
- Gallery rendering
- Presentation rendering
- UI-only ephemeral state

Not every piece of state belongs in Runtime or ProfileStore.

Examples of intentionally UI/session-local state include:

- current Gallery filter selection
- open/closed popovers
- Presentation-only automation draft state
- single-level Undo Hide pointer
- rendering/cache state
- lazy-thumbnail state

The test is not "can this state be put in Runtime?"

The test is:

> Who actually owns this responsibility?

Ephemeral UI behavior should remain in the UI/coordination layer unless it
becomes genuine playback state or persistent user data.

---

# Session State vs Persistent State

## Session / UI State

Examples:

- current media
- current index
- shuffle history
- slideshow timer
- playback state
- Presentation state
- Video Loop state
- active finite Loop Automation
- current filter selections
- Undo Last Hide pointer
- open UI panels

This state may disappear when the application closes.

## Persistent Profile State

Examples:

- Favorites
- favorite timestamps
- Hidden Media
- Tag vocabulary
- per-media tag assignments
- profile identity/name
- master-folder metadata

This state survives sessions through ProfileStore.

## Persistent Library State

Examples:

- remembered FSA directory handles
- library names
- scan/open timestamps
- remembered item counts

This survives sessions through the independent FSA Library Registry.

These three categories should not be casually merged.

---

# Design Rules

When adding a feature, first determine which existing responsibility owns it.

Need persistent media curation?

→ Extend ProfileStore.

Need profile persistence?

→ Extend `src/profile/indexeddb.js` through ProfileStore.

Need playback/navigation behavior?

→ Extend MediaRuntime.

Need media discovery?

→ Extend or add a Media Provider that produces the common MediaItem shape.

Need remembered FSA source identity?

→ Extend the Library Registry.

Need special decoding/playback behavior?

→ Prefer a playback adapter.

Need temporary UI workflow state?

→ Keep it in the UI/coordination layer unless there is a strong reason to
promote it elsewhere.

Avoid creating parallel sources of truth.

Avoid moving behavior across boundaries merely to reduce file count.

Separation is intentional.

---

# Current Responsibility Map

| System | Responsibility |
|---|---|
| `main.js` | UI coordination, rendering, filters, Presentation-specific behavior |
| `MediaRuntime` | Current collection, navigation, shuffle, slideshow, playlist playback |
| `ProfileStore` | Persistent curation, tags, profile identity and multi-profile behavior |
| Profile IndexedDB | Profile data + profile registry persistence |
| `LocalFileInputProvider` | Traditional browser File / WebKit folder discovery |
| `FsaFileProvider` | File System Access recursive discovery |
| FSA Library Registry | Remembered FSA folders and handles |
| TS Playback Adapter | Special `.ts` playback path |
| Gallery | Browsing / preparation / curation |
| Presentation | Immersive playback experience |

---

# Future Growth

Future features should extend these boundaries rather than replace them.

Examples may include:

- Collections
- Ratings
- Search
- richer metadata
- tag-aware automation
- additional media providers
- smarter library/profile association
- additional playback adapters

The architecture should become more capable without becoming less
understandable.

When a future implementation appears to require a second ProfileStore,
second filtering pipeline, second Runtime, or provider-specific Gallery
logic, stop and inspect the existing architecture first.

There is probably already a boundary intended to absorb the feature.
