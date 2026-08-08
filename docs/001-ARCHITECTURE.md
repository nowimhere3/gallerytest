# Loop Browser Gallery (LBG)

# 001 — Architecture

## Overview

Loop Browser Gallery (LBG) is intentionally built around a small number of independent systems.

Each system has a single responsibility.

Keeping these responsibilities separate makes the application easier to understand, maintain, and extend.

The guiding principle is simple:

> Runtime plays media.
>
> ProfileStore remembers user preferences.

Nothing more.

---

# High-Level Architecture

```
                ┌──────────────────────┐
                │     User Interface    │
                │  Gallery / Presentation
                └──────────┬───────────┘
                           │
                           ▼
                ┌──────────────────────┐
                │       Runtime         │
                │ Navigation & Playback │
                └──────────┬───────────┘
                           │
          ┌────────────────┴────────────────┐
          ▼                                 ▼
 ┌───────────────────┐              ┌──────────────────┐
 │   Media Provider   │              │   ProfileStore   │
 │  Local Media Files │              │ Favorites, Hidden│
 └───────────────────┘              └─────────┬────────┘
                                              │
                                              ▼
                                      ┌──────────────────┐
                                      │    IndexedDB     │
                                      │ Persistent State │
                                      └──────────────────┘
```

---

# Core Components

## Runtime

The Runtime controls everything related to the current session.

It is responsible for:

- Current media
- Previous / Next navigation
- Shuffle
- Shuffle history
- Slideshow
- Presentation Mode
- Video playback
- Video Loop
- Keyboard shortcuts

The Runtime should **never** concern itself with persistence.

If the browser closes, Runtime state disappears.

This is intentional.

---

## ProfileStore

ProfileStore owns persistent user preferences.

It is the only part of the application that knows how to save or load user state.

Current Profile data includes:

- ❤️ Favorites
- 🙈 Hidden Media

Future Profile data may include:

- Collections
- Tags
- Ratings
- Loop Automations

Nothing outside ProfileStore should communicate directly with IndexedDB.

---

## IndexedDB

IndexedDB is the application's persistence layer.

Its responsibility is simply to store Profile data.

It should not contain application logic.

It should not contain Runtime behaviour.

Think of it as permanent storage, not business logic.

---

## Media Provider

The Media Provider discovers local media.

Responsibilities include:

- Reading folders
- Enumerating media
- Providing media metadata
- Providing media URLs

It does **not** decide:

- Favorites
- Hidden state
- Presentation behaviour
- Playback rules

It simply supplies media.

---

# Session State

Session State exists only while LBG is running.

Examples include:

- Current media
- Playback position
- Shuffle history
- Slideshow timer
- Presentation Mode
- Video Loop state

Closing the browser destroys Session State.

This behaviour is intentional.

---

# Profile State

Profile State survives between sessions.

Examples include:

- Favorites
- Hidden Media

Future additions should naturally fit into Profile State without affecting Runtime.

---

# Presentation Mode

Presentation Mode is the flagship feature of LBG.

Presentation operates independently of Gallery browsing.

Presentation controls currently include:

- ❤️ Favorite
- ◀ Previous
- ▶ Next
- 🙈 Hide
- 🔁 Video Loop
- ⚙ Presentation Settings
- 🚪 Exit

Presentation should always feel immersive.

Controls are intentionally lightweight and fade into the background when not being used.

---

# Navigation

Navigation is handled entirely by Runtime.

Supported navigation includes:

- Sequential
- Shuffle
- Previous
- Next

Shuffle maintains navigation history so that:

Back behaves predictably.

Forward behaves predictably.

Navigation should always feel deterministic from the user's perspective.

---

# Gallery

Gallery Mode is the preparation workspace.

Users can:

- Browse media
- Select media
- Favorite items
- View hidden items
- Prepare presentations

Gallery should display all media.

Nothing is ever removed simply because it is hidden.

---

# Hidden Media

Hidden Media is a Presentation filter.

Hidden media:

- remains on disk
- remains visible in Gallery
- remains part of the collection

Presentation simply skips hidden media.

This distinction is important.

Hidden does **not** mean deleted.

---

# Favorites

Favorites are Profile data.

They exist independently of Hidden Media.

A media item may be:

- Favorite
- Hidden
- Both
- Neither

These states never conflict.

---

# Design Rules

Whenever adding new features, prefer extending existing systems instead of creating new ones.

Examples:

Need persistent user data?

→ Add it to ProfileStore.

Need playback behaviour?

→ Extend Runtime.

Need media discovery?

→ Extend the Media Provider.

Need storage?

→ Extend IndexedDB through ProfileStore.

Avoid bypassing these boundaries.

---

# Current Responsibilities

| System | Responsibility |
|----------|----------------|
| Runtime | Playback, navigation, slideshow, presentation |
| ProfileStore | Persistent user preferences |
| IndexedDB | Storage only |
| Media Provider | Local media discovery |
| Gallery | Preparation |
| Presentation | Playback experience |

---

# Future Growth

Future features should naturally fit into the existing architecture.

Examples include:

- Collections
- Tags
- Ratings
- Advanced Loop Automations
- Profile Import / Export

These should extend existing systems rather than introducing parallel ones.

The architecture should become richer over time, not more complicated.
