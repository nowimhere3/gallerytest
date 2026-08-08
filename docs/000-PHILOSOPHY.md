# Loop Browser Gallery (LBG)

# 000 — Philosophy

## Purpose

Loop Browser Gallery (LBG) exists to make browsing and presenting local media as effortless as possible.

The application should disappear into the background.

The user's attention should remain on their photos and videos—not on the software itself.

Every feature should reduce friction, improve flow, or simplify presentation.

If a feature adds complexity without making the experience noticeably better, it probably doesn't belong.

---

# Core Principles

## 1. Local First

Media belongs to the user.

LBG is designed around local media.

There are:

- no accounts
- no uploads
- no cloud dependency
- no required internet connection

Everything should continue working completely offline.

Future cloud integrations may exist as separate providers, but the local experience must always remain first-class.

---

## 2. Fast Above All

Speed is a feature.

Selecting a folder should begin showing media immediately.

Large collections should progressively load without freezing the interface.

The application should always feel lightweight and responsive, regardless of collection size.

Performance improvements should never come at the expense of simplicity.

---

## 3. Minimize Friction

The application should remember as much as reasonably possible.

Users should not have to repeat work.

Examples include:

- Favorites
- Hidden media
- Presentation preferences
- Playback preferences
- User profile data

The software should assist without becoming intrusive.

---

## 4. Presentation First

LBG is more than a gallery.

Presentation Mode is a first-class experience.

Everything should support presenting media smoothly with as little interaction as possible.

Gallery Mode exists to prepare.

Presentation Mode exists to present.

---

## 5. Session State vs Profile State

LBG intentionally separates temporary state from persistent user data.

### Session State

Exists only while the application is running.

Examples:

- Current media
- Shuffle history
- Playback state
- Slideshow timer
- Presentation state

---

### Profile State

Persists between sessions.

Examples:

- Favorites
- Hidden media

Future examples may include:

- Tags
- Ratings
- Collections
- Loop Automations

This separation keeps Runtime focused on playback while ProfileStore manages user preferences.

---

## 6. Small, Focused Features

Every feature should have a clear purpose.

LBG is intentionally not trying to become:

- a DAM
- a photo editor
- a media server
- a cloud platform

It is a lightweight browser application for viewing and presenting media.

When in doubt:

Prefer fewer features implemented exceptionally well over many features implemented adequately.

---

## 7. Automate Carefully

Automation should reduce effort without reducing control.

Automation should always be:

- Optional
- Predictable
- Reversible

The user should always understand why something happened.

Global automation should never surprise the user.

---

## Long-Term Vision

The long-term goal is simple:

Become the fastest and most enjoyable way to browse, present, and intelligently loop local media.

Not by becoming larger.

By becoming smoother.

Every release should remove friction.

Every release should make presenting media feel a little more effortless than before.
