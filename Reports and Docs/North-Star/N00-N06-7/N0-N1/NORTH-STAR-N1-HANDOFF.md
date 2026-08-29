# North Star N1 — Implementation Handoff

**Thursday, August 27, 2026 — 9:26 AM MDT**

*Revision 2 — final amendments applied: manual-verification policy reduced, L5/L7
ordinary-copy invariant added, future-initiative taxonomy reopened.*

**Phase:** North Star N1 — Progressive Disclosure of Media Library
**Prepared by:** Lead Architect (documentation pass)
**Status:** Ready for implementer. **Not implemented.**
**Constitution:** `Reports and Docs/NORTH-STAR.md` — read it before starting. It outranks this document.
**Evidence:** `../North-Star/NORTH-STAR-ARCHITECTURE-AUDIT.md`

**Baseline verified:** branch `SandboxSyncV3`, HEAD `8ba3379` ("Complete SyncV3 Stage 10 UX
compression"), worktree clean, `git diff --check` clean, 52/52 tests passing.

---

## 1. Goal

> **Make Media Library invisible on the ordinary path.**

A customer who opens a folder and chooses a Curation must complete their entire job without ever
encountering the words "Media Library", a Media Library selector, or any control whose purpose is
identity bookkeeping.

This is a **presentation-only** slice. It changes what is shown, never what is stored, stamped,
merged, published or proven.

---

## 2. Current architecture facts the implementer must know

These are verified against the repository at `8ba3379`. Do not re-derive them; do not contradict
them without checking.

**F1 — The North Star flow already works.** `ProfileStore#setLibraryAssociation()`
(`src/profile/profile-store.js:588`) opens by calling `LibraryRegistry.ensureLibraryId()`
(`src/storage/library-registry.js:324`), which is mint-once-preserve-forever. **Choosing a
Curation already creates the shared Media Library identity silently.** The customer has never
needed to select one.

**F2 — Opening a folder mints nothing.** `ProfileStore#recordLibraryLoaded()`
(`profile-store.js:654`) *reads* the shared `libraryId` and returns `null` when there is none. A
folder that was never explicitly associated is simply not catalogued. This is Stage D3's rule and
it must survive N1 untouched.

**F3 — The selector has exactly three unique capabilities**, all reachable only through
`renderFolderLinkState()` in `src/main.js`:

| Capability | Call site | Nature |
| --- | --- | --- |
| Create a *named* Media Library | `promoteLibraryToShared` (`main.js:5817`) | administrative — `ensureLibraryId` already creates the identity without it |
| Link this folder to an **existing** shared Media Library | `linkLocalLibraryToShared` (`main.js:5823`) | **the genuine cross-device decision** |
| Remove this folder from its Media Library | `unlinkLocalLibraryFromShared` (`main.js:5870`) | administrative / recovery |

Only the middle one is ever a customer decision, and it has **no human-language question attached
to it yet** — that is N2's job. Until N2 exists, exposing this selector exposes plumbing with
nothing behind it.

**F4 — `mapLinkState()` already computes every state N1 needs.** `src/profile/link-state.js`
returns L0–L7. `allowPicker` is currently `true` for every durable folder, including `L2`
("ready for its first Media Library") — a brand-new local-only customer with an empty catalog.
`main.js:5665` then renders a hint explaining that the empty selector needs a Sync Folder. **This
is the regression, in one place.**

**F5 — Peer knowledge is already available and already unused by customer UI.**
`discoverDevices()` returns `peers[]` with content-verified `deviceId` and `label`;
`ProfileSync.resolveDeviceName()` (`profile-sync.js:1209`) converts an id to a name. Today these
reach the customer through **nothing** except the `window.__bgSyncDevices()` console helper
(`main.js:11513`). **N1 must keep it that way** — see §4.

**F6 — A naming lag exists, and N1 must not fix it.** A Media Library minted by
`ensureLibraryId` during association carries no `name` fact until the *next* load, when
`recordLibraryLoaded` names it from the folder. Under N1 the customer cannot see the catalog at
all, so this is invisible to them; in Advanced it may briefly render as "Unnamed Media Library".
**Changing the call order to fix this is a semantic change and is out of scope.** Record it as an
observation, not a defect.

---

## 3. Exact presentation boundary

**Route on link state. Never on peer state.**

```text
ORDINARY SETTINGS
  Media Library SELECTOR ............................. never shown
  "Create Media Library" / name field ................ never shown
  "Use This Media Library" / "Remove from…" .......... never shown
  Media Library STATUS LINE .......................... only in non-healthy states (L5)
  "Reconnect Media Folder" ........................... always shown when L7 (recovery)

ADVANCED SETTINGS
  Full selector, create, link, unlink, all status ..... always available
```

State-by-state, using `mapLinkState`'s existing codes:

| State | Meaning | Ordinary Settings | Advanced |
| --- | --- | --- | --- |
| `L0` | no folder loaded | nothing (already `allowPicker: false`) | full |
| `L1` | session-only folder | nothing (already `allowPicker: false`) | full |
| `L2` | durable, no Media Library, empty catalog | **hide selector** | full |
| `L3` | durable, no Media Library, catalog exists | **hide selector** | full |
| `L4` steady | folder uses Media Library X | **hide selector** | full |
| `L4` conflict | direct-relink refusal | Advanced-only (see note) | full |
| `L5` | linked to a Media Library not in the catalog | **status line only, in customer language** (§3.1), no selector | full, with the precise diagnosis |
| `L6` | claimant collision | Advanced-only (see note) | full |
| `L7` | permission needed | **"Reconnect Media Folder" stays**, summary in customer language (§3.1) | full |

**Note on L4-conflict and L6.** Both are reachable only *after a selection has been made*, which
requires the selector. With the selector gone from the ordinary path, these states become
Advanced-only by construction. **Their storage-level refusals are untouched** — they still fire,
still refuse, still explain. Only the surface that can trigger them moves.

**Note on L5.** This is the one judgment call in the boundary. L5 is usually transient (sync has
not yet brought the catalog across) and self-healing, and its recovery — unlink then relink — is
administrative. The recommendation is: **keep the informational status line, move the selector to
Advanced.** If the product owner prefers L5 to expose recovery inline, that is a one-row change to
the table above and does not affect anything else in this slice.

---

### 3.1 Ordinary-surface copy invariant — recovery may surface, plumbing vocabulary need not

Keeping a recovery **status** on the ordinary path does **not** grant permission to reintroduce
the phrase "Media Library" into ordinary UX.

> **Recovery may surface. Plumbing vocabulary does not have to.**

**Two ordinary-path states currently carry the forbidden vocabulary.** Both must be reworded for
the ordinary surface:

| State | Current string (`link-state.js`) | Ordinary surface must say |
| --- | --- | --- |
| `L5` | "This Media Folder uses a Media Library that Browser Gallery cannot find yet." | something like *"Browser Gallery can't find this folder's saved setup yet."* |
| `L7` | "…needs permission again. Its Media Library is safe." | something like *"…needs permission again. Your setup is safe."* |

Exact wording is the implementer's to draft and the product owner's to approve. What is fixed is
that the ordinary surface names **the customer's folder and the customer's setup**, never Browser
Gallery's identity model.

**Advanced may state the precise diagnosis**, including the Media Library name and id. That is
what a diagnostic escape hatch is for, and it is more useful there than a softened sentence would
be.

**L7's action label ("Reconnect Media Folder") is acceptable as-is.** "Media Folder" maps onto the
customer's own noun for their media; "Media Library" is a claim about Browser Gallery's internal
model. Only the latter is contained by this rule.

**Do not achieve this by editing `mapLinkState`.** See §8 — its strings are asserted verbatim by a
Tier 1 test, and Advanced needs the diagnostic wording anyway. The ordinary copy is supplied by
the new surface function, which is precisely the seam that knows which surface it is rendering.

**Safety and refusal behaviour is unchanged.** The claimant guard and the direct-relink refusal
still fire, still refuse, still explain. This rule governs vocabulary, not enforcement.

---

## 4. The corrected cross-device condition

The architecture audit proposed:

```text
crossDeviceQuestionExists =
  catalogHasLibraryNotFromThisDevice OR (syncConnected && peers.length > 0)
```

**The product owner has corrected this, and the correction is approved and binding.**

> **Peer existence is not question existence.**

A peer device is *context*. It is information Browser Gallery may use while resolving identity,
and it is what makes a human question answerable when one is genuinely needed. It is **not**
itself a reason to expose identity plumbing.

```text
One device                                              → invisible
Sync connected, still one device                        → invisible
Two devices connected, no unresolved identity decision  → invisible
An unresolved identity decision for the CURRENT media   → a human question may appear
```

The eventual predicate is conceptually `unresolvedCrossDeviceIdentityDecisionForCurrentFolder`.
**Do not hardcode it in N1.**

**The safest expression of this correction is that N1 does not consult peer state at all.**

> **N1 must not read `peers`, `v3Peers`, `syncConnected`, `v3Configured`, or the shared catalog
> in order to decide what to show.** Its only input is the link state that `mapLinkState` already
> computes.

That makes the invariant structural rather than remembered: N1 *cannot* surface plumbing because
a device joined Sync, because the signal is not wired in. N2 introduces peer-awareness together
with the human question that justifies it.

---

## 5. Recovery states that must remain reachable

Non-negotiable. Each is a real customer-recoverable condition:

1. **L7 — permission needed.** "Reconnect Media Folder" stays on the ordinary path. The action
   is unchanged; its **summary is reworded** per §3.1. A customer whose folder permission lapsed
   must be able to fix it without visiting Advanced.
2. **L5 — saved setup not found.** Informational status line stays, **in customer language** per
   §3.1. Full recovery, and the precise Media Library diagnosis, in Advanced.
3. **Claimant guard** (`library-registry.js:427`) and **direct-relink refusal**
   (`library-registry.js:445`). These are enforced **atomically in the write transaction**, not in
   the UI. They must continue to fire and continue to explain themselves. N1 changes nothing about
   them.
4. **Stale/unavailable Curation (S4)** in `mapAssociationCopy`. Untouched by this slice.

> **A safety refusal may be reworded. It may never be removed, hidden, or auto-resolved.**

---

## 6. Advanced escape hatch

Advanced Settings (`<details class="advanced-settings-section">`, `index.html:1656`) gains the
**complete, unconditional** Media Library surface: selector, create-with-name, link, unlink, every
status line, every conflict warning.

Requirements:

- Available in **every** state where it works today — no new gating.
- Not a second implementation. It renders from the **same** pure state and the **same** handlers.
  Two code paths computing the same answer is exactly the defect this project has repeatedly
  refused.
- Labelled honestly as advanced/diagnostic. Do not apologise for it and do not advertise it.

---

## 7. Files likely involved

| File | Change |
| --- | --- |
| `src/profile/link-state.js` | **Add a new pure function; do not modify `mapLinkState`.** The new function also owns the ordinary-surface copy for L5/L7 (§3.1). See §8 |
| `src/main.js` | `renderFolderLinkState()` consults the new function; render the Advanced surface from the same state |
| `index.html` | Move the Media Library controls into the Advanced disclosure; merge the `This Media Folder` / `This Media Library` headings on the ordinary path |
| `src/profile/contextual-first-use.js` | `PROFILE_SYNC_INTRO_STEPS` 5 → 3 (`media`, `curation`, `sync`). **Keep the "Nothing is copied, moved or uploaded" trust sentence** — it is the trust message, not the concept message |
| `src/profile/association-copy.js` | Copy only: "…for this Media Library" → "…for this folder" |
| `src/main.js` glossary | `PROFILE_SYNC_BACKGROUND_GLOSSARY` — the `mediaLibrary` entry moves to Advanced-only consumption |
| `tools/test-*.mjs` | New tests per §9. Existing tests per the two tiers in §9 |

**Do not touch:** anything under `src/storage/`, `src/profile/sync-*`, `src/profile/profile-store.js`,
`src/profile/media-identity-*`, `src/profile/ambient-profile-*`, `src/providers/`, `src/runtime/`.

---

## 8. Recommended design — why a new function, not a new parameter

`mapLinkState` has a dedicated pure test (`tools/test-link-state.mjs`) that asserts its exact
outputs for every state including `allowPicker`. Adding a parameter that changes those outputs
puts that test in the "must be edited" pile and blurs the semantic/presentation line.

**Recommended:** leave `mapLinkState` byte-identical and add a sibling pure function in the same
module:

```text
describeMediaLibrarySurface({ linkState, surface })
  → { showSelector, showStatus, showRecoveryAction, statusText }

  surface: "ordinary" | "advanced"
```

`statusText` is what makes §3.1 achievable without touching `mapLinkState`: the ordinary surface
receives customer-language copy for L5 and L7, while the advanced surface passes `linkState`'s own
diagnostic summary straight through. One function knows which surface it is rendering, so the two
vocabularies cannot leak into each other — and `mapLinkState`'s strings, which a Tier 1 test
asserts verbatim, never change.

Consequences, all good:

- `test-link-state.mjs` passes **unchanged** — by construction, not by luck.
- The disclosure rule becomes provable in a pure model with an exhaustive state table, which is
  this project's established discipline for anything with more than two branches.
- The rule lives beside the states it routes on, so the two cannot drift.
- N2 extends the same function with its cross-device input rather than re-deriving disclosure
  somewhere else.

---

## 9. Tests and invariants

### Correction to the architecture audit

The audit's proof obligation said *"all 52 tests pass unchanged."* **That is not achievable as
stated,** and the implementer should not try to force it.
`tools/test-contextual-first-use.mjs:51` hard-asserts `PROFILE_SYNC_INTRO_STEPS.length === 5`, and
six further tests scan `index.html` for the exact phrases and headings N1 removes. Those tests
encode the very presentation N1 is deliberately changing.

Use this two-tier invariant instead.

### Tier 1 — MUST pass byte-unchanged

Everything encoding semantics. Any diff here means the slice has left presentation and must stop.

```text
All SyncV2 / SyncV3 transport, merge, device, multitab and pass tests
All MEDIA-ID tests (identity, projection, alias, perf, telemetry, concurrency)
All Stage 09 ambient-decision / load-time / suppression tests
tools/test-link-state.mjs            ← unchanged BY DESIGN, per §8
tools/test-library-link.mjs
tools/test-sync-folder-change.mjs
tools/test-load-time-*.mjs
tools/test-no-decision-rearm.mjs
```

### Tier 2 — expected to change; each change justified in the commit message

At most these ten. **Touching any test outside this list is a stop condition.**

```text
tools/test-contextual-first-use.mjs      intro step count and content
tools/test-profile-vocabulary.mjs        DOM phrase scan + association copy
tools/test-association-copy.mjs          actionLabel wording
tools/test-settings-compression.mjs      group structure
tools/test-media-library-selection.mjs   selector presence
tools/test-profile-sync-hierarchy.mjs    group order and headings
tools/test-safety-reassurance.mjs        may reference moved copy
tools/test-profile-sync-help.mjs         may reference moved copy
tools/test-profile-sync-polish.mjs       may reference moved copy
tools/test-status-tone.mjs               may reference moved elements
```

For each Tier 2 edit, state in one line **what the test used to protect** and **why that
protection is now expressed elsewhere**. A test deleted without that sentence is a regression in
architectural memory.

### New tests required

1. **`tools/test-media-library-disclosure.mjs`** — exhaustive table over
   `describeMediaLibrarySurface` × {L0…L7} × {ordinary, advanced}. Must assert:
   - no ordinary state yields `showSelector: true`
   - L7 yields `showRecoveryAction: true` on the ordinary surface
   - every advanced state yields `showSelector: true` wherever it does today
2. **Peer-independence assertion.** A static check that `describeMediaLibrarySurface` takes no
   peer/sync/catalog input, and that the ordinary render path in `main.js` does not consult
   `peers`, `v3Peers`, `v3Configured` or `listLibraries()` to decide visibility. This is the
   executable form of the §4 correction.
3. **Vocabulary containment — including exceptional states.** The ordinary Settings surface
   contains **no occurrence of "Media Library" in any state**, L5 and L7 explicitly included.
   Drive this from the state table, not from a single happy-path render: assert that
   `describeMediaLibrarySurface({ linkState, surface: "ordinary" }).statusText` is free of the
   phrase for **every** L0–L7 input. The Advanced disclosure must still contain it.

### Invariants that must hold

- `ensureLibraryId` is still reached by `setLibraryAssociation` — **the shared `libraryId` must
  continue minting silently exactly as it does today.**
- `recordLibraryLoaded` still never mints.
- No change to the replica, the fact allow-list, the transport, or any published bytes.
- `git diff --check` clean.

---

## 10. Prohibited semantic changes

Do **not**, in this slice:

- change SyncV3 semantics, the fact model, the allow-list, or the transport
- change MEDIA-ID semantics, its database, or its scope/ancestry rules
- change Stage 08 link semantics — the L0–L7 codes, the claimant guard, the direct-relink refusal
- change Stage 09 decision rules — `resolveLoadTimeSwitch`, the decision store, suppression
- implement Curation inheritance (N3) or reverse suggestion (N4)
- implement portable structural facts (N5)
- implement Google or any OAuth work (a future major initiative, not a slice)
- implement native anything (a future major initiative, not a slice)
- introduce the cross-device human question (N2) — N1 only removes; it does not add a question
- "fix" the F6 naming lag
- delete or weaken `libraryId` in any way

> Hiding a concept from the interface and removing it from the architecture are **opposite
> actions**. See anti-pattern 2 in `Reports and Docs/NORTH-STAR.md`.

---

## 11. Proof obligations

```text
Local-only:
  Choose Folder → Choose Curation → Done
  → never sees Media Library terminology

Sync connected, no relevant identity question:
  same result

Peer exists, no relevant identity question:
  same result                                    ← the approved correction, proven

Genuine unresolved cross-device identity decision:
  a human-language question MAY surface           ← N2 delivers this; N1 must not block it

Safety / recovery state:
  recovery remains reachable — in customer language, with no "Media Library" phrasing

Advanced:
  full plumbing remains reachable, including the precise identity diagnosis
```

Plus:

- **the ordinary Settings surface contains no "Media Library" terminology in ANY state**,
  including L5 and L7
- the shared `libraryId` still mints silently on Curation association
- every Tier 1 test passes byte-unchanged
- every Tier 2 edit is justified in one line
- `git diff --check` clean

---

## 12. Final human verification — deliberately small

**This project has already paid for extensive deterministic coverage, and the product owner must
not be asked to re-run large manual matrices.** The behavioural matrix is proven by the pure
state-table tests in §9; the protected architecture is proven by the Tier 1 semantic suites. Those
are the proof. Browser Preview is a **final visual eyeball**, not a test plan.

### The default check — 3 to 4 actions

```text
1. Open one normal, durable Media Folder
2. Open Settings
3. Choose / confirm its Curation if it does not already have one
4. Look at the page
```

Looking for exactly two things:

- the ordinary Settings page is **dramatically quieter** than before
- **no ordinary Media Library plumbing appears** — no selector, no create/name field, no
  link/unlink controls, and no "Media Library" phrasing anywhere on the ordinary surface

That is the whole default expectation.

### Explicitly NOT being re-verified by hand

Do **not** ask the product owner to re-run Stage 09's ambient-decision matrix, the multi-device
sync matrices, permission-revocation scenarios, claimant-collision scenarios, or the legacy-picker
path. All of those are already covered by deterministic suites that must pass unchanged, and
N1 changes none of their semantics. Re-running them by hand would be paying twice for the same
assurance.

### Adding a manual step

If the implementer finds a behaviour that **genuinely cannot be proven automatically**, one
additional manual step may be proposed — but it must come with a specific written explanation of
*why* the automated path cannot reach it. "It felt worth checking" is not a reason. Absent such a
finding, the four actions above are the complete human verification for N1.

## 13. Breadcrumbs to add

At minimum, in the canonical forms defined in `Reports and Docs/NORTH-STAR.md` and the README:

**`src/profile/link-state.js`**, beside the new function:

```text
BREADCRUMBS — IS: disclosure routes on LINK STATE only. The ordinary surface never shows the
  Media Library selector; Advanced always does; L7 recovery and L5 status stay ordinary.
BREADCRUMBS — WAS: allowPicker was true for every durable folder, so a first-time local-only
  customer with an empty catalog was shown a selector they could not use, for a concept they did
  not need. That single decision is what grew the five-step introduction and the six-entry
  glossary around it.
BREADCRUMBS — WILL BE / FUTURE: N2 adds a cross-device input HERE, carrying an actual human
  question. It must express "an unresolved identity decision for the CURRENT folder" — never
  "a peer exists". Peer presence is context, not a customer decision.
```

**`src/profile/link-state.js`**, beside the ordinary-surface copy:

```text
BREADCRUMBS — IS: the ordinary surface gets customer-language copy for L5 and L7; the advanced
  surface passes mapLinkState's own diagnostic summary through unchanged. Recovery may surface;
  plumbing vocabulary does not have to.
BREADCRUMBS — WAS: both states named "Media Library" on the ordinary path, which reintroduced
  the exact vocabulary N1 exists to remove — through the one door left open for recovery.
```

**`src/main.js`**, at the ordinary render path:

```text
BREADCRUMBS — IS: this path deliberately does not read peers, v3Peers, v3Configured or the
  shared catalog. Visibility is derived from link state alone, so plumbing structurally cannot
  appear because a device joined Sync.
```

**`src/profile/contextual-first-use.js`**, at the reduced step list:

```text
BREADCRUMBS — WAS: five steps, two of which taught Media Library before any customer decision
  required it. BREADCRUMBS — IS: three steps; the trust sentence ("nothing is copied, moved or
  uploaded") is retained because it is the trust message, not the concept message.
```

**`src/storage/library-registry.js`**, beside `ensureLibraryId` — a FUTURE breadcrumb protecting
the inversion:

```text
BREADCRUMBS — WILL BE / FUTURE: libraryId becomes MORE load-bearing as a machine address
  (sync, automation, StreamLoop) as it becomes LESS visible to customers. Hiding it from the UI
  must never be read as license to weaken or remove it.
```

---

## 14. Recommendation on the open product question

**Question:** should N1 hide ordinary Media Library UI *unconditionally*, leaving only
safety/recovery states, future human-language cross-device questions, and the Advanced escape
hatch as routes where plumbing can surface?

### Recommendation: **YES — hide it unconditionally on the ordinary path.**

Five reasons, in order of weight:

1. **There is no question to attach it to yet.** The selector's only genuinely customer-relevant
   capability is joining an existing shared Media Library (F3). The human sentence that makes that
   a *customer* decision — *"Is this the same media you use on Chromebook Pro?"* — is N2. Shipping
   a selector before its question is shipping plumbing with nothing behind it.
2. **Unconditional is a smaller, more auditable boundary than conditional.** "The ordinary path
   never shows it" is one rule with an exhaustive state table. A conditional rule requires
   inventing `unresolvedCrossDeviceIdentityDecisionForCurrentFolder` *now*, in a slice explicitly
   forbidden from touching identity semantics — and a predicate invented under that constraint
   would almost certainly collapse back into "a peer exists", which is precisely what the product
   owner corrected.
3. **It makes the correction structural rather than remembered.** With no peer signal wired into
   the disclosure path at all, N1 *cannot* regress into peer-triggered plumbing. A future agent
   would have to add the input deliberately — at which point the FUTURE breadcrumb tells them what
   the input must mean.
4. **Nothing is lost.** Every capability stays reachable in Advanced, backed by the same handlers
   and the same storage-level refusals. Recovery states stay on the ordinary path.
5. **It is trivially reversible.** One function, one table row per state.

### The one thing to watch

Between N1 and N2 there is a real, narrow gap: a customer on a second device who genuinely wants
to join an existing Media Library must use Advanced to do it. That is acceptable — it is rare, it
is exactly the case N2 exists to serve, and Advanced is a legitimate answer for a rare expert
action. **It should be stated plainly to the product owner rather than engineered around**, because
engineering around it means building N2's predicate inside N1, which is the trap this
recommendation exists to avoid.

If that gap is judged unacceptable before N2 lands, the correct response is to **sequence N2
immediately after N1** — not to soften N1.

---

## 15. Working sequence context

North Star browser/product slices:

```text
N1  Progressive Disclosure        ← this handoff
N2  Device-Aware Human Questions    joins sourceDeviceId → resolveDeviceName; adds the question
N3  Proven Parent Inheritance       downward, proven, vacuum-only
N4  Reverse Suggestion              upward, suggestion only
N5  Portable Structure              first phase to touch V3 facts
```

Future major initiatives — **scope and numbering deliberately open**:

```text
FUTURE MAJOR INITIATIVE — Google-authorized low-friction Sync    exact phase/name TBD
FUTURE MAJOR INITIATIVE — Native Browser Gallery                 exact phase/name TBD
```

These are **not** slices. Both are substantially larger bodies of work than N1–N5, and either may
become a separate major phase, a separately named initiative, or something organized differently
once N1–N5 have settled the model. Their architectural direction is settled and recorded in
`Reports and Docs/NORTH-STAR.md`; only their implementation taxonomy is open. An earlier draft of this handoff
listed them as "N6" and "N7" — that shorthand was wrong and has been withdrawn.

N1–N4 touch no synchronized data. This is a working sequence, not constitution — see
`Reports and Docs/NORTH-STAR.md`.
