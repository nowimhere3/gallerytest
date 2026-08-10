# Loop Browser Gallery (LBG)

# 000 — Philosophy

## Purpose

Loop Browser Gallery (LBG) exists to make browsing, organizing, and presenting user-controlled media as effortless as possible.

The application should disappear into the background.

The user's attention should remain on the media — not on the software managing it.

Every feature should reduce friction, improve flow, preserve useful context, or make presentation easier.

If a feature adds complexity without producing a noticeable improvement for the user, it probably does not belong.

---

# Core Principles

## 1. Local First Means User-Controlled First

Media belongs to the user.

LBG is designed around browser-accessible files rather than accounts, uploads, servers, or provider-specific cloud APIs.

The core application should not require:

- an LBG account
- an LBG backend
- media uploads
- an LBG-hosted media library
- a permanent internet connection

The normal local-folder experience must remain first-class and capable of working offline.

However, "local-first" does not mean media must physically originate on the Chromebook's internal storage.

If the operating system or browser exposes user-controlled storage through normal file abstractions — for example a synced cloud folder, network share, removable drive, WebKit folder selection, or File System Access handle — LBG should be able to benefit from that without becoming a cloud platform itself.

Prefer:

> storage provider → OS/browser file abstraction → LBG

rather than:

> storage provider → provider-specific LBG integration

when the simpler path already works.

---

## 2. Fast Above All

Speed is a feature.

Selecting a folder should begin producing useful results as quickly as practical.

Large collections should load progressively without freezing the interface.

Navigation should feel immediate.

Presentation should not be interrupted by unnecessary re-rendering, reloading, or state reconstruction.

Performance improvements should be evidence-driven and should not make the architecture harder to understand without a meaningful benefit.

---

## 3. Minimize Friction

The application should remember useful work when doing so is safe and understandable.

Users should not have to repeatedly reconstruct the same context.

Examples include:

- Favorites
- Hidden Media
- Tags
- Profiles
- remembered FSA Libraries
- useful workflow checkpoints
- presentation preferences where appropriate

But persistence should be intentional.

Not every temporary UI state deserves to survive forever.

Remember what reduces repeated effort; discard what is genuinely temporary.

---

## 4. Presentation First

LBG is more than a gallery.

Presentation Mode is a first-class experience.

Gallery Mode exists to browse, organize, curate, filter, and prepare.

Presentation Mode exists to present.

Presentation should therefore feel visually quiet and media-first.

Normal Gallery controls should not intrude into Presentation merely because those controls exist elsewhere in the application.

Controls should appear when useful and disappear when they are not.

---

## 5. Separate State by Meaning

LBG intentionally separates different kinds of state.

The question is not simply:

> "Should this be persisted?"

The better question is:

> "What kind of thing is this, and which system actually owns it?"

### Session / UI State

Temporary context such as:

- current media
- current index
- shuffle history
- slideshow timer
- playback state
- Presentation state
- active loop-automation progress
- temporary UI panels
- current filters

belongs to the running session unless there is a deliberate reason to persist it.

### Profile State

Persistent user curation such as:

- Favorites
- Hidden Media
- Tags
- profile identity
- profile-specific organization

belongs to ProfileStore.

### Library State

Persistent knowledge about an accessible media source such as:

- remembered FSA directory handles
- library identity
- last opened/scanned metadata

belongs to the Library Registry.

These categories may interact, but interaction does not mean they should be collapsed into one store.

A Profile describes user context and curation.

A Library describes a media source.

Runtime describes what is happening now.

Preserve those distinctions.

---

## 6. Extend Existing Boundaries Before Creating New Ones

LBG should grow by extending stable concepts rather than duplicating them.

Prefer:

- one filtering pipeline
- one ProfileStore
- one Runtime
- one common MediaItem contract
- provider-specific discovery behind providers
- format-specific playback behind playback adapters

Avoid parallel implementations that solve nearly the same problem in slightly different ways.

At the same time, do not delete a proven path merely because a newer path looks cleaner.

For example, WebKit folder loading and File System Access can coexist because they solve the same user need through different browser capabilities while converging on the same downstream media model.

Shared architecture matters more than artificial uniformity.

---

## 7. Preserve Working Weirdness Until You Understand It

Some code will look awkward because it protects a behavior discovered through real testing.

Do not "clean up" a strange-looking decision solely because a different implementation appears more elegant.

Before changing non-obvious behavior:

1. inspect the current code,
2. inspect nearby architecture breadcrumbs,
3. understand the regression or requirement that produced the decision,
4. then decide whether the behavior should change.

A little intentional awkwardness is better than a beautiful regression.

---

## 8. Architecture Breadcrumbs Are Part of the Product

LBG is developed incrementally and often with AI-assisted implementation.

That makes durable reasoning especially important.

Code can usually explain **what** it does.

It often cannot explain **why** an unusual decision exists.

For important non-obvious decisions, use small `BG BREADCRUMB` comments to preserve reasoning close to the implementation.

Useful breadcrumb fields include:

```text
BG BREADCRUMB
WHY:
WHAT:
FUTURE:
```

Only include the fields that add value.

If something is intentionally deferred, say so explicitly:

```text
NOT IMPLEMENTED:
```

Breadcrumbs should document decisions, boundaries, traps, identity rules, and intentional oddities.

They should NOT narrate obvious code.

The goal is to stop future humans or AI agents from accidentally undoing a decision because its original reason was invisible.

---

## 9. Source of Truth Lives Closest to Reality

Documentation is useful, but documentation can become stale.

When sources disagree, use this order:

1. Current working implementation
2. `BG BREADCRUMB` comments and other explicit architectural comments beside that implementation
3. Current architecture / roadmap documentation
4. Historical changelogs, prompts, implementation reports, and older plans

The code proves what exists now.

Breadcrumbs preserve why important parts exist.

Architecture and roadmap docs summarize the current system and direction.

Changelogs preserve history.

None of these should be confused with the others.

When documentation conflicts with working code, do not blindly rewrite the code to satisfy the documentation.

First determine reality, then update the documentation.

---

## 10. Small, Focused Features

Every feature should have a clear purpose.

LBG is intentionally not trying to become:

- a Digital Asset Management platform
- a photo editor
- a media server
- an online hosting service
- a cloud-account platform
- a general-purpose file manager

It is a lightweight browser application for browsing, organizing, and presenting media.

When in doubt:

> Prefer fewer features that fit together exceptionally well over many features that merely exist.

---

## 11. Automate Carefully

Automation should reduce effort without reducing control.

Automation should be:

- Optional
- Predictable
- Understandable
- Easy to stop

The user should be able to understand why the application advanced, looped, filtered, restored, or changed state.

Automation should reuse existing navigation and playback systems rather than secretly creating another behavior path.

Global automation should never surprise the user.

---

## 12. Test Reality, Not Architecture Alone

A design that looks correct in code is still a hypothesis until the important behavior is exercised in the real environment.

This matters especially for browser/platform boundaries such as:

- File System Access
- `webkitdirectory`
- persisted permissions
- cloud-backed filesystem mounts
- ChromeOS behavior
- large media collections
- unusual formats such as `.ts`

Use code inspection to form strong predictions.

Use real device testing to decide what is actually true.

Do not redesign working systems to solve theoretical problems that have not occurred.

---

# Development Philosophy

LBG should become more capable without becoming harder to reason about.

A good change should ideally do at least one of these:

- reduce user friction
- make an existing workflow clearer
- preserve useful context
- extend an existing architectural boundary cleanly
- improve compatibility without duplicating downstream logic
- make future development safer

A change that accomplishes none of those deserves skepticism.

---

# Long-Term Vision

The long-term goal is simple:

Become the fastest and most enjoyable way to browse, organize, present, and intelligently loop user-controlled media.

Not by becoming larger for its own sake.

By becoming smoother.

By remembering the right things.

By hiding complexity behind stable boundaries.

By letting the operating system and browser do work LBG does not need to duplicate.

By preserving the reasoning behind important decisions so the project can evolve without repeatedly rediscovering its own history.

Every release should remove friction.

Every release should make the application easier to use — and easier for the next human or AI developer to understand.
