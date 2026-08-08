# Loop Browser Gallery (LBG)

# 002 — Roadmap

This roadmap reflects the long-term direction of Loop Browser Gallery.

Development follows four stages:

- ✅ Complete
- 🚧 In Progress
- 📋 Planned
- 💡 Future Ideas

The roadmap intentionally prioritizes simplicity.

Features are only added when they improve the experience of browsing, organizing, and presenting local media.

---

# Design Principles

Loop Browser Gallery is guided by a few core principles:

- Local-first
- Fast by default
- Progressive disclosure
- Reduce before adding
- Shared architecture over duplicated logic
- Build foundations that future features naturally extend

Every new feature should reinforce these principles rather than compete with them.

---

# Foundation

The architectural backbone of LBG.

## Status

✅ Complete

### Completed

- Runtime / Profile separation
- Modular Runtime
- ProfileStore
- IndexedDB persistence
- Local-first architecture
- Clean Presentation architecture
- Responsive UI foundation

The core architecture is now considered stable and future development should continue building upon it rather than replacing it.

---

# Gallery

The primary workspace for preparing media.

## Status

🚧 In Progress

### Completed

- Local folder loading
- Image & Video support
- Thumbnail Gallery
- Favorites
- Hidden Media
- Quick Favourite
- Responsive layout
- Profile Export

### Current Focus

- Undo Hidden Media
- Gallery layout refinements
- Favorite ordering improvements
- Media metadata
- Shared filtering architecture
- Type filtering (Images / Videos)

### Planned

- User Tags
- Gallery Settings
- Search
- Collections
- Ratings

---

# Presentation Mode

The flagship experience of LBG.

## Status

🚧 In Progress

### Completed

- Presentation Overlay
- Previous / Next
- Favorite toggle
- Hide Media
- Ghost Controls
- Keyboard Shortcuts
- Presentation Settings
- Exit Presentation
- Video Loop
- Loop Automation Foundation

### Current Focus

- Presentation polish
- Automation UX
- Advanced Automation
- UI refinements

Presentation Mode will continue to receive the majority of active development.

---

# Profiles

Persistent media preferences.

## Status

🚧 In Progress

### Completed

- Favorites
- Hidden Media
- Profile Export
- Profile Import
- Profile Merge
- Profile Replace
- Relative-path Profiles
- IndexedDB persistence

### Planned

- User Tags
- Collections
- Ratings

---

# Filtering Architecture

A shared filtering pipeline used throughout the application.

## Status

🚧 In Progress

Rather than each playback mode deciding what media to display, every feature should consume the same filtered media collection.

Conceptually:

```
All Media
      │
      ▼
View
      │
      ▼
Type
      │
      ▼
User Tags
      │
      ▼
Search
      │
      ▼
Sort / Shuffle
      │
      ▼
Gallery
Presentation
Slideshow
Stream Loop
```

The filtering pipeline should become a shared service rather than feature-specific logic.

Future capabilities should extend this pipeline rather than replace it.

---

# Loop Automation

One of the defining features of LBG.

## Status

🚧 In Progress

### Completed

- Loop Forever
- Loop X Times
- Loop Until Timer
- Automation Engine
- Automation UI Foundation

### Current Focus

- Advanced Automation
- Rule Conditions
- Duration-based Automation
- Workflow refinements

### Future

- Rule chaining
- Tag-aware automation
- Presentation workflows
- Stream Loop integration

Automation should remain powerful internally while appearing simple to the user.

---

# Navigation

Presentation navigation.

## Status

✅ Complete

### Completed

- Previous / Next
- Browser-style Forward history
- Shuffle navigation
- Keyboard navigation

Future refinements will focus on polish rather than new functionality.

---

# Performance

Performance is considered a core feature rather than a milestone.

## Status

✅ Foundation Complete

### Completed

- Fast startup
- Progressive loading
- Thumbnail optimization
- Reduced memory usage
- Large media collection support

Future optimization will continue naturally as new features are introduced.

---

# Stream Loop

The long-term evolution of Presentation Mode.

## Status

💡 Future Ideas

Current exploration includes:

- Shared filtering pipeline
- Automation integration
- Rule-based playback
- Dynamic playlists
- Scheduled presentations
- Intelligent playback rules

Rather than becoming a separate application, Stream Loop should build upon the existing Gallery, Presentation, and Automation systems.

---

# Future Ideas

Ideas that are intentionally exploratory.

- User Tags
- Ratings
- Collections
- Presenter Notes
- Improved metadata
- Folder Playlists
- Enhanced fullscreen experience
- Additional automation conditions

Ideas may evolve or disappear as the project matures.

---

# Out of Scope

The following are intentionally not project goals.

- Cloud synchronization
- User accounts
- Media server functionality
- Digital Asset Management (DAM)
- Photo editing
- AI tagging
- Online media hosting

Loop Browser Gallery is intentionally focused on being the fastest and most enjoyable way to browse and present local media.
