# Browser Gallery — North Star Architecture & Product Audit

**Phase:** North Star (post-SyncV3 Stage 10)
**Role:** Lead Architect. Audit only.
**Date:** 2026-08-27
**Repository:** `~/gallerytest`

---

## 0. Verification block

```text
git branch --show-current   → SandboxSyncV3
git rev-parse HEAD          → 8ba3379ba696a3983e159b7c7e33a407ac93e225
git log -1                  → "Complete SyncV3 Stage 10 UX compression"  (2026-08-27 06:28:42 +0000)
git status --porcelain      → (empty — clean)
git stash list              → (empty)
```

Test baseline, run in full during this audit:

```text
52 test files under tools/test-*.mjs
52 pass, 0 fail
```

**Nothing was modified, created inside the repository, committed or pushed.** The only file
written by this pass is this report.

History inspected: the SyncV2 arc (`110927c` → `5759dd1`), the MEDIA-ID arc
(`6d400fa` → `f81548e`, plus `c41147c` / `3752c87`), and the SyncV3 arc
(`1ab26ad` stage 01 → `8ba3379` stage 10). Breadcrumbs and `[WHY: …]` blocks were read as
primary sources, not skimmed — several conclusions below contradict what the task prompt
assumed, and every one of those contradictions is sourced to a specific line.

Also read as adjacent context: `~/codex-reports/Google-Sync/GOOGLE-AUTHORIZED-SYNC-FEASIBILITY.md`.

---

## 1. Executive verdict

**The North Star is architecturally sound, and it is much closer to reachable than the
prompt assumes. The single most important finding of this audit is this:**

> **The "Choose Folder → Choose Curation → Done" flow already works today, end to end, with
> zero changes to storage, facts, transport or MEDIA-ID. The Media Library is already minted
> silently as a side effect of choosing a Curation. The user is never required to select one.**

The proof is in `profile-store.js:588–594`. `setLibraryAssociation()` — the function behind
the "Choose a Curation for this Media Library" button — opens with:

```js
row = await LibraryRegistry.ensureLibraryId(localLibraryId);
```

`ensureLibraryId()` (`library-registry.js:324`) is **mint-once, preserve-forever**. Choosing a
Curation therefore *creates* the shared Media Library identity automatically, names nothing,
asks nothing, and publishes nothing until Sync exists. Correspondingly,
`recordLibraryLoaded()` (`profile-store.js:654`) *reads* the shared id and explicitly refuses
to mint one, so merely opening a folder never manufactures a synchronized identity.

That is exactly the North Star's "the machine absorbs complexity" behaviour — and it was built
in Stage D3 of SyncV2, before the North Star was articulated. The architecture is already
correct. **The regression is entirely in the presentation layer.**

The regression has one identifiable source: **Stage 08 introduced a Media Library selector as a
permanent property row of the loaded folder, and Stage 10 made it unconditional.**
`link-state.js` returns `allowPicker: true` for *every* durable folder — including state `L2`,
`"is ready for its first Media Library"`, which is a brand-new local-only user with an empty
catalog and no Sync. `main.js:5665–5674` then renders a hint explaining that the empty selector
needs a Sync Folder. A first-time local-only user is thus shown a control they cannot use, for
a concept they do not need, to solve a problem they do not have.

Everything else follows from that one decision: the concept needed a name, the name needed a
Help entry, the Help entry needed an intro card, the intro card needed a companion card
("Choose the Curation for This Media Library"), and the settings panel needed a fifth group
heading to hold it.

**Verdict: the fix is a disclosure change, not an architecture change.** V3's internal machinery
is not the problem and should not be weakened. It should be *hidden harder*.

### The regression, quantified

| | SyncV2 (`5759dd1`) | SyncV3 Stage 10 (`8ba3379`) |
| --- | --- | --- |
| Customer concepts in Settings | Profile, Library, Profile Sync | Media Folder, Media Library, Curation, Curation-for-this-Media-Library, Active Curation ("This Device Is Using"), This Device, Sync Folder |
| Settings group headings | 1 (`Profile`) | 5 (`This Media Folder`, `This Media Library`, `This Device Is Using`, `This Device`, `Sync`) |
| First-run teaching screens | 0 | 5 (`PROFILE_SYNC_INTRO_STEPS`) |
| Buttons on the association path | 1 — `Associate Current Library` | Choose Curation, Save Curation, Use This Media Library, Create Media Library, Remove from This Media Library, Reconnect Media Folder |
| Glossary entries maintained | 0 | 6 (`PROFILE_SYNC_BACKGROUND_GLOSSARY`) |

Applying the prompt's Core Regression Test — *does this make the user think or do more than
SyncV2 required?* — the honest answer for the local-only user is **yes, substantially, and
without an unavoidable reason.** That is the finding this phase exists to correct.

---

## 2. Current architecture map

### 2.1 Four independent identity layers

The codebase maintains four *deliberately separate* identities. Understanding that they are
separate is the key to the whole audit, because it is what makes hiding one of them safe.

```text
┌─ PHYSICAL FOLDER IDENTITY ─────────────────────────────────────────────┐
│  library-registry.js                                                    │
│  record.id  "lib-…"    minted on EVERY FSA pick. Local. Never leaves    │
│                        this device. Keyed by isSameEntry().             │
│  record.handle         the FileSystemDirectoryHandle (structured-cloned) │
│  record.profileId      the UI-facing Curation association (projection)   │
│  record.libraryId      ← the ONE link up to the shared layer            │
└─────────────────────────────────────────────────────────────────────────┘
                                   │  ensureLibraryId()  (explicit assoc only)
                                   ▼
┌─ SHARED LOGICAL MEDIA IDENTITY ────────────────────────────────────────┐
│  sync-facts.js                                                          │
│  libraryId  (uuid)     the identity two installations agree refers to   │
│                        one logical collection.                          │
│  replica.libraries[libraryId]      { name, sourceDeviceId, lastLoadedAt }│
│  replica.associations[libraryId]   Fact<profileId | null>               │
└─────────────────────────────────────────────────────────────────────────┘

┌─ MEDIA SCOPE IDENTITY (local, never synced) ───────────────────────────┐
│  media-scope.js / media-identity.js — its OWN IndexedDB database        │
│  scopeId   the UNION of physical roots PROVEN to live in one tree       │
│  root.prefixFromScopeRoot   proven path from scope root to this root    │
│  root.ancestryEvidence      { relation, provenAgainstRootId, at }       │
│  path (scopeId, scopeRelativePath) → mediaId   composite key = the      │
│                                                uniqueness guarantee     │
└─────────────────────────────────────────────────────────────────────────┘

┌─ DEVICE IDENTITY ──────────────────────────────────────────────────────┐
│  sync-device.js                                                         │
│  deviceId  "dev-<uuid>"  random, minted once, NEVER derived from a      │
│                          Profile id, folder name, machine name or       │
│                          account. Survives "Disconnect Sync".           │
│  deviceName              display only. Never identity.                  │
└─────────────────────────────────────────────────────────────────────────┘
```

The three `[WHY:]` blocks that establish these boundaries are worth quoting because the North
Star must not erode them:

- `media-scope.js:6–22` — "neither existing identity can key a media index… So MEDIA-ID mints
  its own: a scopeId, local, opaque, never written to the library registry, never into facts,
  never synced."
- `library-registry.js:88–97` — `libraryId` "must be minted only on an explicit association…
  never merely because a folder was opened, or every folder anyone ever picks would acquire a
  synchronized identity nobody asked for."
- `sync-device.js:16–23` — "deviceId must never be derived from anything that can legitimately
  change or collide."

### 2.2 Transport and merge

```text
ProfileStore ──── owns Curations, items, tags, tombstones, the Library catalog,
                  Library→Curation associations, and the logical clock.
      │
      ├─ sync-facts.js ......... pure fact algebra + the ALLOW-list shape guard
      ├─ sync-merge.js ......... HybridClock, makeFact, mergeFact, mergeReplicas
      │
ProfileSync ───── ONE engine, ONE reconcile chain, ONE status surface.
      │           mode (v1|v2|v3) selects the pass body. 3s debounce + 3s poll.
      │
      ├─ sync-v3.js ............ runSyncV3Pass: preflight → settle → refresh →
      │                          deviceId → writer lease → pass body
      ├─ sync-v3-write-policy .. THE single seam authorizing a V3 write (Web Locks)
      └─ sync-v3-transport.js .. content-addressed device discovery; every
                                 filesystem NAME is presentation; identity is
                                 read out of device.json content.
```

The published on-disk shape:

```text
<Sync Folder>/sync-v3/devices/
  Chromebook -- a31f2c4e/          ← readable, NOT identity
    device.json                    ← commit point, written LAST, hashes every file
    associations.json
    libraries.json
    profiles/BEAST -- 93bc1a7d.json
```

### 2.3 MEDIA-ID, wired and live

MEDIA-ID is not dormant. `main.js:4340 prepareMediaIdentityForLoad()` runs on every load:
enumerate other persisted roots → `resolveScopeForRoot()` → probe ancestry both directions →
join / rebase / mint → build the alias index → apply projection. Two Browser-Preview defects
(BP-FAIL-01, BP-FAIL-03) were found and fixed against live curation, which is strong evidence
the path is genuinely exercised.

### 2.4 What the customer actually sees today

```text
Settings ▸ Curations & Sync
  [? Help] → replays a 5-step introduction
  ── This Media Folder ─────────  summary, [Reconnect], Media Library selector,
                                  [Use This Media Library] / [Create Media Library],
                                  [Remove from This Media Library], sync hint
  ── This Media Library ────────  association summary, ambient offer panel,
                                  [Choose a Curation for this Media Library],
                                  Curation select, [Save Curation for this Media Library]
  ── This Device Is Using ──────  Active Curation select, [Create Curation]
  ── This Device ───────────────  device name
  ── Sync ──────────────────────  [Choose Sync Folder] / Reconnect / Disconnect
  ▸ Import / Export   ▸ Delete Curation   ▸ Tags   ▸ Advanced Settings
```

---

## 3. V2 simplicity lessons

Read directly from `git show 5759dd1:index.html`, the SyncV2 Stage E tree:

```html
<summary>Profile</summary>
<label for="profile-select">Profile</label>
<button id="profile-associate-btn">Associate Current Library</button>
<button id="profile-create-btn">Save Profile</button>
<h3 class="profile-sync-heading">Profile Sync</h3>
```

Three lessons, stated as lessons rather than nostalgia:

**L1 — V2 had exactly one association verb.** "Associate Current Library". The user pressed one
button and BG did the rest. V2 was not simpler because it knew less; it was simpler because it
*asked* less. The shared `libraryId` was minted behind that same button (`ensureLibraryId` is a
V2/Stage-D3 function). V3 kept the mechanism and added a second, manual way to reach it.

**L2 — V2 had no vocabulary to teach.** "Library" meant the folder you were looking at. It was
imprecise, and V3's `Media Folder` / `Media Library` split is genuinely more truthful. But the
truthfulness was purchased with five teaching screens and a six-entry glossary. **Precision in
internal vocabulary is free; precision in customer vocabulary is expensive.** V3 spent customer
budget on an internal distinction.

**L3 — V2's failure was silent wrongness, not complexity.** SyncV1's document model made
un-favouriting and never-knowing byte-identical (`sync-facts.js:5–13`). V3 fixed that class of
defect permanently. **That fix cost the user nothing.** The correctness improvements and the
UX regression are separable, and this is the evidence: the merge engine, the clock, the writer
lease, content-addressed discovery and MEDIA-ID all landed without adding a single customer
concept. Only Stage 08's selector did.

The lesson for this phase: **do not roll back V3 to recover V2's simplicity.** Roll back Stage
08's *disclosure* decision and keep everything else.

---

## 4. V3 capabilities worth preserving

Every item below is an essential internal foundation for the North Star. None should be exposed.

| Capability | Where | Why the North Star needs it |
| --- | --- | --- |
| Fact model with explicit negative facts | `sync-facts.js` | "Same Curation over there" is unachievable if un-favourite cannot survive merge |
| HybridClock + persisted floor | `sync-device.js`, `sync-merge.js` | Without it a click silently does nothing after reload; automation cannot be trusted |
| Durable random `deviceId` | `sync-device.js` | The *only* thing that lets BG say "your Chromebook Pro" without an account |
| Content-addressed discovery | `sync-v3-transport.js:519` | Lets a device be renamed by a human without becoming a new device |
| Manifest-as-commit-point | `device.json` written last, hashes everything | The reason a cloud provider is credible later |
| Write→read-back→verify→cleanup | `publishOwnReplicaVerified` | Never partially trusts a directory |
| Web Locks writer lease | `sync-v3-write-policy.js` | Multi-tab safety; the single authorization seam |
| Shared Library catalog | Stage 04B `libraries` facts | Carries `sourceDeviceId` — the raw material for the human question |
| Association facts | `replica.associations` | "Same Curation on the other device" *is* this fact |
| Stage 09 decision store | `ambient-profile-decision.js` | Already implements "explicit user choice beats automation" |
| MEDIA-ID scope join | `media-scope.js`, `fsa-ancestry.js` | Already proves parent/child ancestry, durably |
| MEDIA-ID competing-destination refusal | `media-identity-projection.js` | The safety rule that makes any inference-based feature possible at all |
| The three-state contracts | `fsa-ancestry.js`, `fsa-existence.js` | `UNKNOWN` ≠ `NO`. This is the invariant every North Star inference depends on |
| The allow-list shape guard | `sync-facts.js:427` | Stops session state silently becoming portable |

**`ensureLibraryId()`'s mint-on-association rule deserves special protection.** It is the single
line that makes the North Star's "Browser Gallery may create whatever internal identity it needs;
that does not mean the user must see it" *already true*.

---

## 5. North Star principles — audited and refined

The candidate principles hold. Four need sharpening; none needs weakening.

| Principle | Verdict | Note |
| --- | --- | --- |
| Same media. Different device. Same Curation. Almost no setup. | **Keep verbatim** | Good north star; correctly names the customer's job |
| Choose Folder → Choose Curation → Done. | **Keep verbatim** | Already achievable today. Make it the acceptance test |
| Make the user think as little as possible. | **Keep** | — |
| Make the user do as little as possible. | **Keep** | — |
| Make the machine think harder so the human thinks less. | **Keep** | — |
| Never ask a plumbing question when BG can ask a human question. | **Keep verbatim** | The single most useful rule in the set |
| If BG knows, do not ask. | **Keep** | — |
| If BG can safely infer, do not ask. | **Refine → "If BG can *prove* it, act. If BG can only *infer* it, propose."** | The codebase already draws exactly this line. `media-identity-matcher.js:24–33`: "T2 (structural) only ever PROPOSES membership, and proposing is not resolving." "Infer" is dangerously close to "guess"; "prove vs. propose" is the discipline that is actually implemented |
| If BG is genuinely unsure, ask the smallest possible question. | **Refine → "…ask one question, in the customer's own nouns, with a safe default."** | "Smallest" invites terse plumbing prompts. The failure mode is not length, it is vocabulary |
| Explicit user choice beats inheritance or automation. | **Refine → "…and is remembered until the user changes it."** | Stage 09 already implements durability of a decision; the principle should say so, or a future agent will re-ask |
| Never trade identity safety for convenience. | **Keep verbatim** | This is the principle that outranks every other one. State that explicitly |
| Open Browser Gallery → Enjoy your media. | **Keep as native trajectory** | Label it as native, not browser — see §13 |
| Press go → start go. | **Keep** | — |

**One principle should be added.** It is implicit in the codebase and was the *actual* cause of
the Stage 08 regression:

> **A concept earns customer-facing existence only when a customer decision depends on it.**

Media Library is a real, valuable, correct concept. It became a customer concept before any
customer decision required it. That is the whole regression in one sentence.

---

## 6. Proposed customer mental model

**Three nouns. That is the budget.**

```text
MY MEDIA        the folder(s) I point Browser Gallery at
MY CURATION     my Favorites, Hidden items and Tags — one saved set of choices
MY DEVICES      the machines I use Browser Gallery on
```

Everything else — Media Library, scope, mediaId, libraryId, deviceId, replica, association fact,
writer lease, alias index, prefix, transport, generation — is **machinery**, and the customer's
correct level of awareness of it is *none*.

The corresponding sentence set the product may say out loud:

```text
"Your media stays where it is."
"This is your Curation."
"You're also using Browser Gallery on Chromebook Pro."
"Is this the same media you use on Chromebook Pro?"
```

Note that the last one is the *only* question, it is asked at most once per folder per device,
and it never uses a noun the customer did not already own.

---

## 7. Concepts to hide

| Concept | Today | Target | Feasibility |
| --- | --- | --- | --- |
| **Media Library** | Permanent selector + group heading + intro card + glossary entry | Hidden until a genuine cross-device identity question exists | **Fully achievable today, presentation-layer only** |
| "Curation *for this Media Library*" | Button label, select label, 2 hint lines | "Curation for this folder" — same fact, customer noun | Copy only |
| "This Device Is Using" (Active Curation) | Its own group heading | Merge with the Curation choice; they differ only when the user has *made* them differ | Presentation |
| "Google Drive Sync Folder" | Group + dialog + role descriptor + safety copy | Becomes "Connect Google" when the Drive provider lands; keep manual folder as an Advanced/account-free option | Blocked on Google work |
| Device name | Its own group heading | Only appears where a device is *mentioned* in a sentence | Presentation |
| `libraryId` prefixes in labels | `media-library-options.js` rung 3 | Should be unreachable in normal use once names come from devices | Presentation |
| Scope / mediaId / prefix / alias index | Already invisible (console telemetry only) | **Keep invisible** | Already correct |
| Replica / generation / writer lease | Already invisible | **Keep invisible** | Already correct |

**Nothing in this table requires deleting a mechanism.** Every row is a disclosure change.

---

## 8. Human-question strategy

### 8.1 The decision ladder, as the codebase already implements it

```text
1. STORED?    Is the answer already in library-registry / associations / MEDIA-ID?
                  → act. Never ask.
                  Implemented: resolveLoadTimeSwitch() Rule 0 and Rule 4.

2. PROVEN?    Can FSA resolve() / isSameEntry() / an exact scope-key lookup settle it?
                  → act. Never ask.
                  Implemented: probeAncestry(), matchExact(), matchByProvenAncestry().

3. REDUCIBLE? Can BG shrink the candidate set before asking?
                  → shrink it.
                  Implemented: destinationsFor() / candidateKeysFor() / the census cascade.

4. PROPOSABLE? Is there ONE strong, content-corroborated candidate?
                  → propose it as a yes/no in customer nouns.
                  Partially implemented: T2/T3 exist and are pure; nothing consumes them.

5. AMBIGUOUS?  → ask one question naming things the customer owns. Default = the safe option.

NEVER:        infer identity from names or appearance.
                  Enforced: "names/appearance alone never prove identity" is the whole
                  reason T2 requires content corroboration and a size-mismatch VETO.
```

Rungs 1–3 are built and live. Rung 4 is built (`media-identity-matcher.js`) and **called by
nothing** — the module header says so deliberately: *"built and fully tested in Stage 01 and
deliberately CALLED BY NOTHING."* That is the largest piece of ready-made North Star capability
sitting unused in the repository.

### 8.2 Question rewrites

| Today | North Star |
| --- | --- |
| "Which Media Library should this Media Folder be associated with?" | "Is this the same media you use on Chromebook Pro?" |
| "Choose a Curation for this Media Library" | "Which Curation should this folder use?" |
| "This Media Library remembers another Curation" | "Chromebook Pro uses **BEAST** for this media. Use it here too?" |
| "Remove this Media Folder from its Media Library before choosing a different one." | "This folder is already set up as your **Mackenzie** media. Change what it is?" |
| "Media Library name" | (never asked — BG names it from the folder, silently, as `promoteLibraryToShared` already does) |

The last row matters: `main.js:5657–5661` already prefills the new-Media-Library name from the
folder name, because `promoteLibraryToShared` stores exactly that. **BG already knows the
answer to the question it is asking.** By Rung 1, it should not ask it.

### 8.3 The safety-critical exception

Two refusals must survive every simplification, because they are enforced in storage, not UI:

- **Claimant guard** — one shared Library may have only one local folder per device
  (`library-registry.js:427`, atomic in the write transaction).
- **Direct-relink refusal** — a folder already carrying a different `libraryId` is never
  silently re-pointed (`library-registry.js:445`).

These are the "never trade identity safety for convenience" principle in executable form. They
may be *reworded*; they may never be *removed or auto-resolved*.

---

## 9. Parent / child folder analysis

### 9.1 The evidence already exists, and it is durable

This is the audit's second-largest finding. **Everything needed for proven parent/child Curation
inheritance is already stored on this device.**

- `fsa-ancestry.probeAncestry()` is the only caller of `FileSystemDirectoryHandle.resolve()`.
  It returns a **four-state** result: `SELF` / `DESCENDANT` / `UNRELATED` / `UNKNOWN`.
- `media-scope.resolveScopeForRoot()` probes **both directions** against every other persisted
  root and calls `decideScopeJoin()` → `join` / `rebase` / `mint`.
- `claimRoot()` persists `{ rootId, scopeId, prefixFromScopeRoot, ancestryEvidence: { relation,
  provenAgainstRootId, at } }`.
- **`rootId` *is* `library-registry`'s local row `id`** (`main.js:4340` passes it through). So
  every scope member maps 1:1 to a library row, and every library row carries `profileId`.

Therefore, for the loaded folder, BG can already answer — from IndexedDB, with no filesystem
I/O and no new proof — *"which other folders on this device are proven ancestors of this one,
and what Curation does each of them use?"*

Ancestry *within* a scope is derivable by prefix containment, and that derivation is sound
because every prefix in the scope came from a `resolve()` proof or a version-guarded rebase,
never from inference.

The `MASTER → Staging → Mackenzie` example in the prompt maps exactly:

```text
MASTER      root A   prefix ""                        profileId = BEAST
Mackenzie   root B   prefix "Staging/Mackenzie/"      profileId = null
            → B.prefix startsWith A.prefix, both in scope S ⇒ A is a PROVEN ancestor of B
```

### 9.2 The boundary that was deliberately drawn — and must be crossed deliberately

`media-scope.js:25–34` states, unambiguously:

> "this module never calls `ensureLibraryId`, `setLibraryProfile` or
> `linkLocalLibraryToSharedId`, never mints or links a `libraryId`, and never publishes an
> association fact. Two roots sharing a media scope remain two independent library rows with
> independent — possibly different, possibly absent — Profile associations. MEDIA-ID
> deliberately does NOT 'fix' such a mismatch: that would be a semantic change nobody approved."

**This is not an obstacle; it is a correctly-placed seam.** MEDIA-ID is the *evidence* layer.
Curation inheritance is a *policy* layer. The North Star should add the policy layer **above**
MEDIA-ID, reading its evidence read-only, and must not push policy down into it. Doing
otherwise would put curation semantics inside the module whose entire discipline is "observe,
never decide".

### 9.3 Four hazards that make naive inheritance unsafe

**H1 — `UNKNOWN` is common, and it is not `UNRELATED`.**
`probeAncestry` returns `UNKNOWN` for: a missing `resolve()` API, a handle BG does not hold, a
throw, a legacy (`webkitdirectory`) root, and — critically — the case
`fsa-ancestry.js:18–24` explicitly flags as **unproven**: a persisted handle sitting at
permission state `"prompt"`. Stage 00B's real-browser probe never covered it. Inheritance must
refuse on `UNKNOWN`, exactly as projection does.

**H2 — ancestry is probed once, at first join.**
`resolveScopeForRoot()` short-circuits with `action: "existing"` when the root already has a
scope row. The evidence is therefore a *snapshot* from the moment the child was first opened
while the parent's handle was reachable. It stays true (a proven ancestry does not become false)
but it can be **absent** for roots that were first opened when the parent was not available.
Absence must read as "ask", never as "unrelated".

**H3 — scope membership can be incomplete.**
`decideScopeJoin`'s rebase branch handles at most **one** scope per load and records
`deferredScopeMerges` for the rest — deliberately, because merging scopes is "a strictly larger
operation with its own identity-collision questions". So the set of proven descendants BG can
see may be a *subset* of the truth. Any rule that depends on "all descendants agree" must
therefore be a **suggestion**, never an automatic action.

**H4 — a scope legitimately contains disagreeing Curations.**
By H2's own design (`media-scope.js:25–34`), two roots in one scope may carry different
`profileId`s on purpose. Inheritance must never overwrite an existing association.

### 9.4 Verdict

**Parent → child Curation inheritance is SAFE, conditional on four constraints:**

1. Only from a **proven** ancestor (`DESCENDANT`/`SELF` relation, or prefix containment within
   one proven scope). `UNKNOWN` and `UNRELATED` never inherit.
2. Only when the child has **no** association of its own — no `libraryId` association fact, and
   no local `record.profileId`. Inheritance fills a vacuum; it never resolves a conflict.
3. Only the **nearest** proven ancestor with an explicit Curation. Nearest = longest matching
   prefix, mirroring `decideScopeJoin`'s "shallowest ancestor wins" logic inverted for
   specificity.
4. It must be **visible and reversible**: BG says what it did in one sentence, and one control
   changes it. Silent correct behaviour is the goal; silent *unexplained* behaviour is not.

Under those four, inheritance strictly reduces user work and never fights the user.

---

## 10. Precedence rules (exact)

Proposed as a total order. Higher wins. This slots **beneath** Stage 09's existing resolver
rather than replacing it — Stage 09's rules stay frozen and become P1–P3.

```text
P0  SAFETY REFUSALS (never overridden)
      claimant guard; direct-relink refusal.
      → refuse and explain. Never auto-resolve.

P1  EXPLICIT SHARED FACT for THIS library
      associations[libraryId] exists (even value null = "No Curation").
      → resolveLoadTimeSwitch() Rule 4. Authoritative.
      Stage 09 unchanged.

P2  LOCAL STAGE-09 DECISION for THIS library
      decision.observedValue === currentFactValue and kind ∈ {yes,no,later}.
      → veto / defer / allow. Beats P1's automatic switch.
      This is "explicit user choice beats automation", already implemented.

P3  LOCAL ROW ASSOCIATION for THIS folder (no shared fact present)
      libraryRecord.profileId, target known.
      → resolveLoadTimeSwitch() Rule 0. Unchanged.

── everything below is NEW North Star policy ──────────────────────────────

P4  PROVEN NEAREST-ANCESTOR INHERITANCE
      Conditions, ALL required:
        · this folder has no fact (P1) and no row profileId (P3)
        · an ancestor root is PROVEN (scope membership + prefix containment,
          relation DESCENDANT or SELF; never UNKNOWN, never UNRELATED)
        · that ancestor has an explicit Curation
        · among proven ancestors, the one with the LONGEST matching prefix
      → APPLY. Announce in one sentence. Offer one control to change it.
      → Writing it makes it an ordinary P3/P1 association from then on,
        so inheritance is evaluated at most once per folder.

P5  PROVEN DESCENDANT SUGGESTION  (reverse — see §11)
      → SUGGEST ONLY. Never apply.

P6  NOTHING PROVEN
      → ask: "Which Curation should this folder use?"
        Default = the Curation this device is already using.
        Never mention Media Library.
```

Two properties of this order are worth stating explicitly:

- **A user's explicit choice for a child permanently outranks its parent.** Choosing Profile B
  for Mackenzie writes a P1 fact (via `setLibraryAssociation`) and a P3 row. P4 is then
  structurally unreachable for that folder — not by a flag, but because its precondition
  ("no fact and no row") can never again be true. This is the correct implementation of
  "explicit choice must win": it wins by making the automation's guard fail, not by a
  suppression list that could be lost.
- **Inheritance is a one-time write, not a live link.** Renaming or re-curating MASTER later
  does not retroactively move Mackenzie. That is the conservative direction and it matches how
  every other association in this codebase behaves.

---

## 11. Reverse parent resolution

Reverse inference is genuinely more dangerous and the prompt is right to flag it.

MEDIA-ID already handles the *structural* half: `decideScopeJoin`'s `rebase` action is exactly
"subfolder-first, master-later" — opening MASTER after Mackenzie re-bases the scope so MASTER
becomes the scope root and every descendant prefix is re-expressed. So at that moment BG
**does** know, provably, that MASTER contains Mackenzie.

But knowing the containment does not license the Curation conclusion:

```text
MASTER/
├── Mackenzie → BEAST
├── Family    → FAMILY
└── Work      → WORK
```

Opening MASTER means "show me everything", which is semantically a *different* collection from
any of its children. The prompt's instinct is correct.

### The exact safe rule

```text
REVERSE SUGGESTION — permitted only when ALL of the following hold:

  R1  The newly-opened root is a PROVEN ancestor of ≥1 known root
      (relation DESCENDANT from probeAncestry, or prefix containment
       inside one proven scope after rebase).
  R2  The opened root has no association of its own (no P1 fact, no P3 row).
  R3  Consider ONLY proven descendants that carry an EXPLICIT Curation.
  R4  Those descendants are UNANIMOUS on one profileId.
  R5  decideScopeJoin reported NO deferredScopeMerges for this load
      (otherwise descendant knowledge is knowingly incomplete — see §9.3 H3).

  → SUGGEST, in customer nouns:
      "A folder inside this one uses BEAST. Use BEAST here too?"
      [ Use BEAST ]  [ Choose another ]  [ Not now ]

  → NEVER apply automatically, even at unanimity.
  → A dismissal is remembered for this folder (same shape as the Stage 09
    decision store), so the suggestion is offered once, not on every open.
```

**Why suggestion and never application, even when unanimous.** Three independent reasons, each
sufficient: (a) R5's incompleteness means "unanimous" can be a sampling artefact; (b) a parent
is semantically a *superset*, so the descendant's Curation is a plausible default but not a
proven answer — and BG's own discipline is that structure alone never auto-resolves; (c) the
cost asymmetry is stark — a wrong parent Curation silently mis-presents the user's *entire*
library, whereas a wrong child Curation mis-presents one subfolder.

Note this is a strictly weaker claim than P4. P4 applies because the child is provably a *view
into* the parent's collection; P5 only suggests because the parent is provably *more than* the
child's collection. The asymmetry is real and should be preserved in the permanent document.

---

## 12. What must remain explicit user choice

1. **Choosing a folder.** Browser-mandated; also correct — it is a permission grant.
2. **Choosing a different Curation because you want a different experience.** This is the
   product, not administration. It must always be one visible control away.
3. **Confirming cross-device media identity when it cannot be proven.** The "is this the same
   media?" question. One yes/no, in customer nouns, once per folder per device.
4. **Overriding any inherited or suggested Curation.** Per P4/P5 — and, per §10, the override
   must be durable by construction.
5. **Connecting Sync / connecting Google.** An outward-facing action. Never automatic.
6. **Resolving a safety refusal (claimant / direct relink).** Never auto-resolved.
7. **Deleting a Curation, importing/replacing, disconnecting Sync.** Destructive or
   outward-facing.

Everything else is BG's job.

---

## 13. MEDIA-ID analysis

### 13.1 What MEDIA-ID stores today

Own IndexedDB database `browser-gallery-media-identity`, v3, four stores:

| Store | Key | Contents |
| --- | --- | --- |
| `scopes` | `scopeId` | scope record + `ancestryAttempts` diagnostics |
| `roots` | `rootId` (= local library row id) | `scopeId`, `prefixFromScopeRoot`, `sourceKind`, `ancestryEvidence` |
| `paths` | **`[scopeId, scopeRelativePath]`** | `mediaId`, `origin` (`observed` / `fact-only`), `observedSignature`, `anchorState`, `lastSeenAt`, `factSeenIn`, `profileId` |
| `cursors` | `cursorKey` | seeding resume cursors |

`observedSignature` = `{ size, lastModified, name, ext }`.

Indexes: `scopeId`, and the compound `[scopeId, origin]` (added for BP-FAIL-02, so the
projection can read the *observed* population alone using keys only).

### 13.2 What it deliberately does NOT synchronize

`media-identity.js:16–23` is explicit:

> "No value in this store reaches `sync-facts.js`, the V3 transport, or any replica.
> `observedSignature` is deliberately shaped so it COULD be published verbatim if a future
> audited stage decided to — that keeps the decision a transport question rather than a schema
> redesign — but Stage 01 publishes nothing."

**This audit is that future audited stage's prerequisite.** The signature shape was designed for
exactly this moment. `media-seeding.js:52–56` reinforces it, and adds the constraint that
`lastModified` is "CORROBORATING ONLY … and nothing here may promote it" — independently
reached by `legacy-library-signature.js`.

### 13.3 Portability classification

| Evidence | Portable? | Reason |
| --- | --- | --- |
| `scopeId` | **NEVER** | Local, opaque, explicitly "never synced". Two devices' scope ids are unrelated by construction |
| `rootId` / `record.id` | **NEVER** | A local row key. Meaningless elsewhere |
| `FileSystemDirectoryHandle` | **NEVER** | Not portable; also a capability |
| Absolute paths | **NEVER** | Never captured. `resolve()` returns relative segments only |
| `permissionState`, `ancestryAttempts` | **NEVER** | Local browser diagnostics |
| `lastSeenAt`, seeding cursors | **NEVER** | Device-local bookkeeping |
| `mediaId` | **Not yet** | Minted locally per scope. Portable only *after* two devices agree on one Media Library — i.e. an output of cross-device agreement, not an input to it |
| `prefixFromScopeRoot` | **YES** | Relative segments only — "privacy-safe by construction rather than by filtering" (`fsa-ancestry.js:130–133`) |
| Proven ancestry **relation** between two roots | **YES**, expressed relative to a shared Media Library | Same reason |
| `observedSignature` `{size, name, ext}` | **YES**, as a sampled subset | Designed to be publishable verbatim |
| `observedSignature.lastModified` | **YES but never load-bearing** | Two independent modules reached this conclusion |
| Item count / total size aggregates | **YES** | Cheap, low-entropy, drift-tolerant |

### 13.4 Privacy note that must be stated before anything is published

`prefixFromScopeRoot` and sampled `name`/`ext` values are **user file and folder names**. They
are relative, never absolute, and never host-derived — but they are still personal content.
Publishing them means writing them into the Sync Folder, and later into Google
`appDataFolder`. That is a genuine, if modest, escalation from today, where BG publishes only
`{favorite, hidden, tags}` keyed by relative path… which, note, *already* contains relative
paths in the fact keys. So the escalation is smaller than it first appears: `replica.profiles[].items` is already keyed by `relativePath`. The new exposure is limited to sizes and
sampled names of *uncurated* files.

**Recommendation:** publish the structure graph (prefixes) freely — it is no more revealing than
today's fact keys. Publish signatures **only as a bounded, deterministic sample** (the
`sampleEntries` discipline in `legacy-library-signature.js`: per-path hashing decides inclusion
independently of position, so drift elsewhere does not reshuffle the sample), and only for a
Media Library the user has already chosen to share.

---

## 14. Cross-device note-sharing analysis

### 14.1 How A and B compare notes without matching folder names

Names may never prove identity. The honest chain is:

```text
DEVICE A                                      DEVICE B
folder "MASTER" → Media Library L
  publishes into L:
    · structure graph: prefixes of proven          user opens folder "media-backup"
      descendants within L                         (different name, different path)
    · bounded signature sample for L
    · (existing) name, sourceDeviceId,             B computes the SAME bounded
      lastLoadedAt                                 sample from its own load
                                                             │
                                                             ▼
                                     matcher (media-identity-matcher.js, already built)
                                       overlapRatio ≥ STRONG_OVERLAP_MIN (0.6)
                                       countDrift  ≤ STRONG_COUNT_DRIFT_MAX (0.35)
                                       corroborated matches ≥ MIN_CORROBORATED_MATCHES (3)
                                       ANY size mismatch ⇒ VETO
                                       second candidate within AMBIGUITY_MARGIN ⇒ REFUSE
                                                             │
                                          ┌──────────────────┴──────────────────┐
                                     one strong candidate              none / ambiguous
                                          │                                     │
                                          ▼                                     ▼
                        "Is this the same media you use            "Which Curation should
                         on Chromebook Pro?"   [Yes] [No]           this folder use?"
                                          │
                                     Yes ⇒ linkLocalLibraryToSharedId(row, L)
                                           → Curation arrives via the existing
                                             association fact. No new mechanism.
```

**Every threshold in that box already exists** as a tested constant in
`media-identity-matcher.js`. The module is pure, fully covered by `tools/test-media-identity.mjs`,
and — by design — called by nothing. This is the North Star's single largest ready-made asset.

The device name in the question comes from `ProfileSync.resolveDeviceName(deviceId)`
(`profile-sync.js:1209`), joined to `LibraryFacts.sourceDeviceId`. That seam was built in
Stage 05 **explicitly for this**: *"THE seam a later Library picker uses to turn
`LibraryFacts.sourceDeviceId` into 'Device: Chromebook Pro'. It exists now, before that UI
does."* And `media-library-options.js`'s FUTURE breadcrumb pre-approves the join:
*"If peer device names ever become available, add them as a rung between 'This device' and the
id prefix."*

### 14.2 Where portable structural knowledge should live

Four candidates were considered.

| Option | Verdict |
| --- | --- |
| Inside MEDIA-ID's database | **No.** Its header states nothing there is ever synchronized; its whole value is being a local evidence store that cannot leak. Making it a sync participant would force every future Profile/transport migration to reason about it — the exact coupling the separate-database decision was made to avoid |
| Bolted onto `replica.libraries[].*` | **No.** The `library` allow-list is `{name, sourceDeviceId, lastLoadedAt}` and its `[WHY:]` warns that adding the top-level key without the shape (or vice versa) breaks every replica in the system. Structure is a different *kind* of fact with different merge semantics |
| A separate non-replica sidecar file | **No.** It would sit outside the manifest, so it would not be hash-verified, not covered by write→read-back→verify, and not protected by the writer lease |
| **A new top-level replica container, `structure`, alongside `associations` and `libraries`** | **YES** |

The fourth mirrors precisely how Stage 04B introduced `libraries`, and that precedent is
documented at both ends (`sync-facts.js:419–431`, `sync-v3.js:asV3Replica`). Concretely:

```text
replica.structure[libraryId] = {
  children: { [relativePrefix]: Fact<childLibraryId | null> },
  sample:   Fact<{ v:1, count, totalSize, entries: ["<relpath>|<size>", …] }>
}
```

Requirements, non-negotiable, each traceable to an existing lesson:

1. **Allow-list and shape guard in one edit** (`sync-facts.js:419–431`'s stated rule).
2. **Its own transport file**, `structure.json`, declared in `device.json` with its hash, so it
   inherits manifest-commit and verify-before-cleanup.
3. **`asV3Replica()` must normalize `structure: replica.structure || {}`** — otherwise the
   publish-skip comparison mismatches on every pass and the device republishes forever. This
   exact defect already happened once with `libraries` (`sync-v3.js`'s Stage 04B correction).
   It is documented; there is no excuse for repeating it.
4. **Removal expressed as a fact whose value says removed**, never key deletion
   (`sync-facts.js:23–26`, FUTURE/DO-NOT-BREAK).
5. **MEDIA-ID exports; it never imports.** A thin, explicitly-audited read-only seam produces
   the portable projection. No sync module imports MEDIA-ID's store, and MEDIA-ID gains no
   knowledge of replicas. **Do not merge the two architectures.**

### 14.3 Minimum human question when deterministic matching fails

**One question. One sentence. Two buttons. A safe default.**

```text
  Is this the same media you use on Chromebook Pro?
  [ Yes, it's the same ]        [ No, it's different ]
```

- `No` is the safe default and the safe failure: BG mints fresh identity, exactly as today.
- Asked **once per folder per device**, then remembered.
- If no peer device exists → **do not ask at all.** Mint silently. This is the single change that
  restores the local-only North Star.
- If two or more candidates are within `AMBIGUITY_MARGIN` → name the devices, not the libraries:
  *"Which of these is it? Chromebook Pro · Desktop · Neither."*
- The words "Media Library", "associate", "link" and "identity" appear nowhere.

---

## 15. Google implications

Reading `GOOGLE-AUTHORIZED-SYNC-FEASIBILITY.md` (2026-08-27) against the North Star:

**What Google removes (confirmed by that spike, §26):** the Sync Folder concept entirely —
creating it, naming it, finding it again on each device, and the
Media-Folder-vs-Sync-Folder confusion that currently costs a Help entry, a role descriptor and a
dialog paragraph. Also the `v3Configured`-vs-active-mode split.

**What Google does *not* remove:** choosing a Media Folder (a real permission grant), and the
cross-device media identity question. Those are BG's, forever.

**North Star sequencing implication — and this is a correction to the spike's own framing.**
That report says the Drive catalog makes step 2 *"a real choice, because the catalog exists"*
and turns the Media Library selector from a constraint into an advantage. That is true as
plumbing and **wrong as product.** Under the North Star, the arriving catalog should not
produce a selector; it should produce a *question*:

```text
Spike's framing:   "Which Media Library is this folder?"   ← plumbing
North Star:        "Is this the same media you use on Chromebook Pro?"   ← human
```

Same operation. Only one requires knowing BG's architecture. The catalog's arrival is what makes
the *human* question answerable — which is a stronger result than the spike claimed.

**Sequencing verdict.** Google is **not a prerequisite** for the first North Star slices, and
should not be sequenced ahead of them. Every §16 item below is independent of it. Google's
correct position is: after the disclosure work, because it removes a *concept* (Sync Folder)
whose removal is much cheaper once the surrounding concepts have already shrunk.

The spike's central asymmetry stands and should be respected: **Q1 (appDataFolder as transport)
= YES; Q2 (browser-only persistent auth) = NO without a broker.** A "connect once and forget"
promise made on Model B would be false, and the honest fallback — sync silently stopping between
hourly gestures — is precisely the failure shape Stage 10 spent a whole pass eliminating.
**Do not make the promise until the broker exists.**

Keep the manual Sync Folder permanently, as an account-free provider. It is the only option for
a user who declines an account, and it is already proven.

---

## 16. Browser implications

Stated precisely, with no hand-waving.

**Genuinely unavoidable in the browser:**

1. **The first folder pick requires a user gesture.** `window.showDirectoryPicker()` cannot be
   called without one. No amount of stored state removes this.
2. **Permission may need re-granting after a browser restart,** and `requestPermission()` also
   requires a gesture. `main.js:5180–5184` handles this correctly: `queryPermission` first,
   `requestPermission` only if needed, both inside a click handler.
3. **Therefore the browser floor for subsequent use is ONE CLICK** — a Recent Media Folders row,
   which is itself the gesture that can carry the permission request. It cannot become zero.
4. **`webkitdirectory` has no durable handle at all.** Permanently a full re-pick. This is why
   `library-registry.js:18–24` refuses to list legacy folders as "Recent" — *"listing it as a
   fake 'recent library' would be a misleading affordance, not a shortcut."*
5. **FSA is Chromium-only**, and `resolve()` is feature-detected per handle.
6. **No background convergence with no tab open.** Sync is tab-lifetime.
7. **`resolve()` at permission state `"prompt"` is UNPROVEN** (`fsa-ancestry.js:18–24`). Stage
   00B could not test it. Ancestry may therefore be `UNKNOWN` exactly at boot, before the user
   grants. **Consequence for §10: P4 inheritance must be evaluated on the load path, after
   permission is granted** — which is where `resolveScopeForRoot()` already runs. No new
   machinery; just do not move it earlier.

**Not unavoidable — currently paid for no reason:**

- The Media Library selector for a local-only user. (Presentation.)
- The 5-step introduction before any decision exists. (Presentation.)
- Five settings group headings. (Presentation.)
- Re-asking for a Curation on a proven child folder. (§10 P4.)
- Naming a Media Library BG already named from the folder. (Rung 1: BG knows.)

**Realistic browser North Star:**

```text
First use:       Choose Folder → Choose Curation → Done          (2 decisions)
Every later use: click your folder in Recent → Done              (1 click)
Second device:   Connect Sync → Choose Folder →
                 "Is this the same media you use on Chromebook Pro?" [Yes]
                                                                  (1 extra question, once)
```

That is the floor. It is achievable, and — apart from the last line — it is achievable **today**.

---

## 17. Native implications

Native removes exactly the constraints listed above as browser-mandated:

| Browser constraint | Native |
| --- | --- |
| Gesture-bound folder pick | Gone after first Add Folder |
| Permission re-grant on restart | Gone — durable OS access |
| Full re-scan per load | Gone — maintained index, incremental updates |
| No background convergence | Gone — a daemon/background task can converge |
| Chromium-only FSA | Gone — native filesystem |
| `resolve()` unknown at `"prompt"` | Gone — ancestry always provable |

Native target:

```text
First setup:  Add Folder once → Choose Curation → Done
Normal use:   Open Browser Gallery → Enjoy your media
```

**Note that H1 and H2 from §9.3 largely dissolve natively.** Ancestry becomes reliably provable
and re-provable, so P4 inheritance gets *stronger* on native — another reason to define the
policy layer above MEDIA-ID rather than inside it: the evidence source improves, the policy does
not change.

### Breadcrumbs to leave TODAY (without building native)

1. **Keep providers behind the existing seam.** `src/providers/` already holds
   `fsa-file-provider.js` and `local-file-input-provider.js` with a common item shape. A native
   provider is a third file. **Do not let native-specific assumptions leak into `main.js`.**
2. **Keep the two FSA seams single.** `fsa-ancestry.js` is the only caller of `resolve()`;
   `fsa-existence.js` is the only caller of existence checks. Both have kill switches. Natively
   these become "always available" — which is a one-line change *only while they stay single*.
3. **Keep the transport directory-shaped.** The Google spike found the entire Drive-facing
   surface funnels through one `devicesDir` object. Native storage is the same seam again.
4. **Keep `deviceId` account-free and locally minted.** A native install must be able to join
   the same replica set with no account. `sync-device.js` already guarantees this.
5. **Never make a browser limitation load-bearing in a data model.** It is not today, and that
   is why native is cheap.

---

## 18. StreamLoop implications

The runtime target:

```text
Load BG source
Set Curation
Filter Favorites
Shuffle
Play
```

**What already supports it.** `media-runtime.js` owns playback/navigation/shuffle as programmatic
state; `shuffle-selector.js` and `duplicate-filter.js` are pure; `profile-projection-view.js`
exposes curation as a queryable view; filters are plain state in `main.js`
(`viewMode` / `typeFilter` / `activeTagFilters`), already shared across
Gallery/Presentation/Slideshow/Shuffle.

**What is missing is an address.** For an Automation to say "load BG source X with Curation Y",
that pair needs a stable, durable name. **It already exists: `(libraryId, profileId)`.** Both are
UUIDs, both are durable, both are already synchronized, and both already survive renames.

**The recommendation is therefore an inversion of the usual instinct — and it is the single most
important StreamLoop breadcrumb:**

> `libraryId` should become **more** load-bearing as an *automation address* at exactly the same
> time it becomes **less** visible as a *customer concept*.

Those are not in tension. It is the same fact playing its correct role in two layers: an opaque
stable handle for machines, and nothing at all for humans. Hiding it from the UI does not weaken
it; it protects it, because a customer-facing identifier acquires renaming, merging and
"why are there two?" pressure that an internal address never does.

Concrete breadcrumbs for today:

1. **Do not delete or weaken `libraryId`.** Hide it.
2. **Never let a customer-facing rename change an id.** Already true (`sync-v3-names.js` treats
   names as presentation; `sync-v3-transport.js` reads identity from content).
3. **Keep filter/shuffle/playback state programmatically settable**, not DOM-derived. Already
   true.
4. **Native must reach "permission-ready, indexed, addressable" without a UI round trip.** That
   is the real meaning of "Press go → start go", and §17's breadcrumbs are what protect it.

---

## 19. Risks

| # | Risk | Severity | Mitigation |
| --- | --- | --- | --- |
| R1 | Hiding the Media Library selector also hides the *recovery* path when a user genuinely needs it (L5/L6/L7 states) | **High** | Disclosure must be state-driven, not deleted. `link-state.js`'s L0–L7 codes stay frozen; L5/L6/L7 always surface, and Advanced always offers the full selector |
| R2 | An agent reads "hide Media Library" as "delete `libraryId`" | **Critical** | State it as an anti-pattern in the permanent document, in bold. `libraryId` is load-bearing for sync *and* for StreamLoop addressing |
| R3 | P4 inheritance applies a wrong Curation because `UNKNOWN` was read as proof | **Critical** | Carry the four-state contract verbatim. `UNKNOWN` refuses. Never collapse to a boolean |
| R4 | Reverse inference auto-applies on false unanimity via `deferredScopeMerges` incompleteness | **High** | R5 in §11: no suggestion at all when merges were deferred. Suggest, never apply |
| R5 | Adding `structure` to the replica breaks the allow-list guard for every existing replica | **High** | One edit, both halves, with shape validation — the Stage 04B pattern. `test-sync-merge` / `test-syncv3-*` must pass unchanged |
| R6 | Forgetting `asV3Replica()` normalization → permanent republish churn | **Medium** | This exact defect already happened with `libraries`. It is documented in `sync-v3.js`. Add it to the slice's checklist |
| R7 | Publishing signatures/prefixes exposes file and folder names | **Medium** | Bounded deterministic sample; only for a Library the user chose to share; never absolute paths. Note fact keys already carry relative paths |
| R8 | Auto-switching Curation mid-session surprises a user who is actively curating | **Medium** | Stage 09's decision store already governs this. P4 fires only at load, only into a vacuum |
| R9 | Removing intro steps loses genuinely useful reassurance ("nothing is copied or uploaded") | **Medium** | That is the *trust* message, not the *concept* message. Keep it; drop the concept cards |
| R10 | Promising "connect once and forget" on Model B auth | **High** | Do not make the promise until the broker exists (§15) |
| R11 | The policy layer gets pushed down into `media-scope.js` for convenience | **High** | Its header forbids it. The layer sits above, reading evidence read-only |
| R12 | Legacy (`webkitdirectory`) users silently lose inheritance and cross-device matching | **Low** | Correct and expected — legacy has no handle, so `UNKNOWN` everywhere. It degrades to "ask", which is the supported mode, not a broken one |

---

## 20. Sequencing

Ordered by *value per unit of risk*. Each phase is independently shippable and independently
revertible.

```text
PHASE N1 — PROGRESSIVE DISCLOSURE          presentation only, no storage/facts/transport change
  · Media Library selector becomes conditional on a real cross-device question
  · Intro drops 5 steps → 3 (media / curation / sync)
  · Settings groups 5 → 3
  · Copy: "Curation for this Media Library" → "Curation for this folder"
  RISK: low.  REVERT: trivial.  PROVES: the central hypothesis.

PHASE N2 — DEVICE-AWARE HUMAN QUESTIONS    joins two existing seams, no new facts
  · Join LibraryFacts.sourceDeviceId → ProfileSync.resolveDeviceName()
  · Media Library options gain the device rung the FUTURE breadcrumb pre-approved
  · The cross-device prompt becomes "Is this the same media you use on Chromebook Pro?"
  RISK: low.  DEPENDS ON: N1.

PHASE N3 — PROVEN PARENT INHERITANCE (P4)  new policy layer above MEDIA-ID, read-only
  · Nearest proven ancestor, vacuum-only, announced, reversible
  RISK: medium.  DEPENDS ON: N1.  Needs its own exhaustive pure-model test table.

PHASE N4 — REVERSE SUGGESTION (P5)         suggestion only
  RISK: medium.  DEPENDS ON: N3.

PHASE N5 — PORTABLE STRUCTURE + SIGNATURES new `structure` replica container
  · Allow-list + shape guard + structure.json + asV3Replica normalization, one edit
  · Wire the already-built matcher (T2/T3) to propose, never resolve
  RISK: high.  DEPENDS ON: N2, N3.  This is the first phase touching V3 facts.

PHASE N6 — GOOGLE PROVIDER + BROKER        per the Google spike's own sequencing
  · Provider seam first (auth-agnostic), auth measurement second, broker third
  RISK: high.  INDEPENDENT of N1–N5.

PHASE N7 — NATIVE                          only after N1–N5 have settled the model
```

**N1 through N4 touch no synchronized data at all.** That is the point of this ordering: the
majority of the North Star's *felt* benefit is reachable without opening the file the project
most carefully protects.

---

## 21. Recommended first North Star implementation phase

### The smallest first slice

> **Make Media Library invisible to a user who has no cross-device question.**

Scope — presentation layer only:

1. `link-state.js` — `mapLinkState()` gains one input, `crossDeviceQuestionExists`. When false,
   states L2/L3/L4 return `allowPicker: false`. **L0/L1/L5/L6/L7 are untouched** — recovery and
   safety states always surface. The L0–L7 codes stay frozen, per the module's own FUTURE
   breadcrumb.
2. `main.js` — computes that input from state BG already has:
   `catalogHasLibraryNotFromThisDevice || (syncConnected && peers.length > 0)`. Both are
   available now (`profile.listLibraries()`, `profileSync.getStatus().v3Peers`).
3. `contextual-first-use.js` — `PROFILE_SYNC_INTRO_STEPS` drops the `library` and
   `library-curation` cards for a local-only user: 5 steps → 3. The trust sentence *"Nothing is
   copied, moved or uploaded"* is **retained** in the `media` card (R9).
4. `index.html` — the `This Media Folder` and `This Media Library` group headings merge into one
   `Your Media` group while the selector is hidden. Advanced Settings gains the full selector,
   unconditionally, as the permanent escape hatch.
5. Copy — "Curation for this Media Library" → "Curation for this folder", in `association-copy.js`
   and the two hint lines.

**Explicitly NOT in this slice:** no storage change, no fact change, no transport change, no
MEDIA-ID change, no Stage 08 semantic change, no Stage 09 rule change, no inheritance, no Google,
no new replica key.

### What it must prove

| # | Proof obligation | How it is demonstrated |
| --- | --- | --- |
| P1 | A first-time local-only user completes **Choose Folder → Choose Curation → Done** and never encounters the words "Media Library" | New pure test over `mapLinkState` + `describeContextualFirstUseActions` asserting no library-concept surface in the local-only state set |
| P2 | The shared `libraryId` is **still minted** on that Curation choice | Assert `ensureLibraryId` is still reached via `setLibraryAssociation`; the user is silently second-device-ready |
| P3 | Connecting Sync and meeting a peer **surfaces the question for the first time** | State-table test: `peers.length` 0 → 1 flips `allowPicker` in L2/L3/L4 |
| P4 | Safety states are **never** hidden | L5/L6/L7 and both storage refusals surface regardless of the new input |
| P5 | **No regression** | All 52 existing tests pass **unchanged**. Not adjusted — unchanged. Any test that must change indicates the slice crossed into semantics |
| P6 | Advanced Settings always reaches the full selector | Escape hatch present in every state |

**P5 is the real gate.** The current suite encodes Stage 07/08/09/10 semantics precisely. If this
slice is genuinely presentation-only, every one of those 52 files passes untouched. If any needs
editing, the slice has silently become an architecture change and should stop.

### Why this slice first

- It tests the phase's **central hypothesis** — "Media Library is plumbing" — at the lowest
  possible cost.
- It is the **largest single reduction in user-facing complexity** available anywhere in the
  system.
- It is **fully reversible** — one boolean.
- It **unblocks everything else**: N2's human question has nowhere sensible to live until the
  plumbing question is gone.
- It requires **no decision about Google, native, or portable evidence** to be made first.

---

## 22. Explicit out-of-scope areas

Not addressed by this audit, and deliberately so:

- The full virtual-collections / playlist system (cross-folder Favorites, tag collections,
  video-only subsets). Noted as future context only, as instructed.
- Physical export/copy flows. Should remain a separate, explicit user action.
- Google OAuth implementation, scopes, the broker, or any credential work.
- Native code, Tauri, or a native provider implementation.
- The micro-arcade / loading-scene subsystem, playback transport, TS adapter, presentation mode,
  and Automations UI — none bears on the North Star.
- Tag administration, Import/Export, Delete Curation flows.
- V1/V2 migration paths. V2 stays untouched, per the sibling-not-generalization discipline.
- Any change to Stage 08 link semantics or Stage 09 decision rules. Both are frozen; the North
  Star sits above them.
- Performance work. The projection budget and seeding batch discipline are already sound.

## 23. Answer index — the 25 audit questions

Answered against the actual repository at `8ba3379`. Section references point to the fuller
treatment above.

**1. Which V3 capabilities are essential internal foundations?** Fact model with explicit negative
facts, HybridClock + persisted floor, durable random `deviceId`, content-addressed discovery,
manifest-as-commit-point, write→read-back→verify, the Web Locks writer lease, the shared Library
catalog, association facts, the Stage 09 decision store, MEDIA-ID's scope join, the
competing-destination refusal, the three/four-state contracts, and the allow-list shape guard.
Full table in §4. All are internal; none needs exposing.

**2. Which customer-facing V3 concepts can be hidden entirely?** Media Library (selector, group
heading, two intro cards, glossary entry); "Curation *for this Media Library*" as distinct
vocabulary; the separate "This Device Is Using" group; device name as its own group; `libraryId`
prefixes in option labels. §7.

**3. Can Media Library become almost completely invisible while retaining its value?** **Yes, and
with no architecture change.** `setLibraryAssociation()` → `ensureLibraryId()` already mints the
shared identity silently when the customer chooses a Curation, and `recordLibraryLoaded()`
explicitly refuses to mint on mere folder-open. The concept is already optional; only the
presentation makes it look mandatory. §1, §4.

**4. When would a logical identity concept genuinely need to surface?** Four states only:
(a) a peer device exists and BG cannot prove whether this folder is the same collection —
and even then it surfaces as *"Is this the same media you use on Chromebook Pro?"*, not as a
selector; (b) the storage-level claimant guard fires (L6); (c) the direct-relink refusal fires
(L4/L5); (d) Advanced/diagnostics, always. §7, §8.3.

**5. What already tells BG another device exists?** `discoverDevices()` returns `peers[]` with
content-verified `deviceId` and human `label`; `ProfileSync.getStatus().v3Peers` exposes it;
`resolveDeviceName(deviceId)` converts an id to a name. Today this reaches the customer through
**nothing** — only the `window.__bgSyncDevices()` console helper (`main.js:11513`). §2.2, §14.1.

**6. What can BG know automatically once Google/Sync is established?** Which devices exist and
their names; the full Media Library catalog including `sourceDeviceId`; every Library→Curation
association; every Curation's facts, tags and tombstones; which Libraries were loaded where and
when. It cannot know which local folder is which — that is device-local truth. §15.

**7. Which setup steps can be eliminated immediately, without Google?** Selecting a Media
Library; naming a Media Library (BG already prefills it from the folder); two of the five
introduction cards; the "This Media Folder" / "This Media Library" split; the "Curation for this
Media Library" phrasing. §21.

**8. Which steps could Google authorization eliminate?** Choosing/creating/naming a Sync Folder,
finding the same one on each device, and the Media-Folder-vs-Sync-Folder distinction — with its
Help entry, role descriptor and dialog paragraph. Not the folder pick; not the identity
question. §15.

**9. Which browser constraints are genuinely unavoidable?** Gesture-bound folder pick;
gesture-bound permission re-grant; therefore a one-click floor for later use; no durable handle
for `webkitdirectory`; Chromium-only FSA; no convergence without an open tab; and `resolve()` at
permission state `"prompt"` remains empirically unproven. §16.

**10. Which constraints disappear natively?** All of the above. Native also makes ancestry
reliably provable, which strengthens parent/child inheritance rather than changing its policy.
§17.

**11. Can proven same-device ancestry safely drive Curation inheritance?** **Yes, conditionally.**
The evidence already exists and is durable: `probeAncestry` proofs, `prefixFromScopeRoot`,
`ancestryEvidence.provenAgainstRootId`, and `rootId` == the local library row id. Four hazards
must be respected: `UNKNOWN` is common and is not `UNRELATED`; ancestry is probed once at first
join; scope membership can be incomplete (`deferredScopeMerges`); and a scope legitimately holds
disagreeing Curations. §9.

**12. Exact precedence rules?** P0 safety refusals → P1 explicit shared fact → P2 Stage 09 local
decision → P3 local row association → **P4 proven nearest-ancestor inheritance (new)** → **P5
proven-descendant suggestion (new)** → P6 ask. P1–P3 are Stage 09, frozen. §10.

**13. How should reverse inference work?** Suggestion only, never application, and only when: the
opened root is a proven ancestor; it has no association of its own; proven descendants with an
explicit Curation are unanimous; and `decideScopeJoin` reported no deferred scope merges. The
downward/upward asymmetry is deliberate — a child is a view *into* the parent; a parent is *more
than* any child. §11.

**14. What must remain explicit user choice?** Choosing a folder; choosing a different Curation
because you want one; confirming unprovable cross-device identity; overriding inheritance;
connecting Sync/Google; resolving a safety refusal; destructive actions. §12.

**15. What MEDIA-ID knowledge already supports the North Star?** Scope membership, proven
prefixes, per-root ancestry evidence, `(scopeId, scopeRelativePath) → mediaId` with the composite
key as the uniqueness guarantee, `observedSignature {size, lastModified, name, ext}`, `origin`
observed/fact-only, `anchorState`, and the fully-built-but-uncalled T2/T3 matcher with
production-tuned thresholds. §13.1, §14.1.

**16. Which facts are safe to synchronize?** `prefixFromScopeRoot` and proven ancestry relations
expressed **relative to a shared Media Library**; bounded, deterministically-sampled
`observedSignature` `{size, name, ext}`; item-count and total-size aggregates. `lastModified` may
travel but must never be load-bearing. §13.3.

**17. Which evidence must remain device-local?** `scopeId`, `rootId`/`record.id`, folder handles,
absolute paths, permission states, ancestry attempt diagnostics, `lastSeenAt`, seeding cursors.
`mediaId` is portable only *after* two devices have agreed on a Media Library — it is an output
of agreement, never an input to it. §13.3.

**18. Where should portable folder-relationship knowledge live?** **A new top-level `structure`
container in the replica**, alongside `associations` and `libraries`, with its own allow-list
entry, its own shape guard, its own `structure.json` in the transport, and `asV3Replica()`
normalization. Not in MEDIA-ID (never synchronized, by design); not bolted onto
`replica.libraries`; not in a sidecar outside the manifest. MEDIA-ID exports read-only; it never
imports. **Do not merge the two architectures.** §14.2.

**19. How should A and B compare notes without matching folder names?** A publishes, per Media
Library, a relative structure graph plus a bounded signature sample. B computes the same sample
from its own load and runs the already-built matcher: overlap ≥ 0.6, count drift ≤ 0.35, ≥ 3
corroborated matches, any size mismatch is a **veto**, a second candidate within 0.15 **refuses**.
A single strong candidate becomes a human yes/no naming the peer *device*. Names never enter the
decision. §14.1.

**20. Minimum human question when matching fails?** One sentence, two buttons, safe default:
*"Is this the same media you use on Chromebook Pro?"* — asked once per folder per device, and
**not asked at all** when no peer device exists. §14.3.

**21. How should Settings shrink?** Five groups → three: *Your Media*, *Your Curation*, *Your
Devices*. The Media Library selector leaves the main surface; the Active-Curation group merges
into the Curation choice; the device-name group disappears into the sentences that mention a
device. §7, §21.

**22. What belongs in Advanced / diagnostics only?** The full Media Library selector (permanent
escape hatch), Media Library creation and removal, device name editing, sync mode/transport
state, `__bgSyncDevices` / `__bgMediaIdTelemetry` / projection telemetry, import/export,
Delete Curation, and manual Sync Folder selection once Google exists. §7, §21.

**23. What breadcrumbs should we leave today?** Keep providers behind the existing
`src/providers/` seam; keep `fsa-ancestry.js` and `fsa-existence.js` the *single* callers of
their APIs, each with its kill switch; keep the transport directory-shaped; keep `deviceId`
account-free and locally minted; keep filter/shuffle/playback state programmatically settable
rather than DOM-derived; and keep `(libraryId, profileId)` intact as the automation address while
hiding it from the interface. §17, §18.

**24. What can be implemented incrementally without destabilizing V3?** Phases N1–N4 —
progressive disclosure, device-aware human questions, proven parent inheritance, reverse
suggestion — touch **no synchronized data at all**. Only N5 (portable structure) opens the fact
model, and it follows the documented Stage 04B pattern. §20.

**25. What should the first phase prove?** That the local-only customer reaches Choose Folder →
Choose Curation → Done with no Media Library vocabulary; that the shared identity is still minted
silently, leaving them second-device-ready for free; that the cross-device question appears only
when a peer exists; that safety and recovery states are never hidden; and that **all 52 existing
tests pass unchanged**. §21.

---

---

# CANDIDATE PERMANENT NORTH STAR DOCUMENT

> **DRAFT — for human review. Not added to the repository.**
> Proposed future location: `Reports and Docs/NORTH-STAR.md`

---

# Browser Gallery North Star

## Purpose

This document is a constitution, not a plan. It states what Browser Gallery is for, what it
promises the person using it, and which rules may not be broken in pursuit of any feature.

It exists because Browser Gallery's architecture will keep getting more capable, and capability
has a gravitational pull toward the interface. Every internal concept that is genuinely useful
will, at some point, seem worth exposing. This document is the standing answer to that
temptation.

When a proposed change conflicts with this document, the change is wrong until this document is
deliberately amended by a human.

## Customer promise

> **Same media. Different device. Same Curation. Almost no setup.**

The customer's job is never "configure synchronization" and never "associate logical media
identities". Their job is:

> **"I have this media set up here. I want the same experience over there."**

## Governing philosophy

> **Make the user think as little as possible.**
> **Make the user do as little as possible.**
> **Make the machine think harder so the human thinks less.**

Inherited from StreamLoop. Increasing architectural sophistication is justified **only** when it
reduces human work, human decisions, or human understanding requirements. Sophistication that
increases any of those is a regression, however correct it is.

**The governing regression test.** For every change:

> *Does this make the user think or do more than before?*

If yes, there must be a concrete, unavoidable, written reason. Otherwise it is a North Star
violation, regardless of how much it improves the internals.

## User mental model

The customer owns exactly three nouns:

```text
MY MEDIA        the folders I point Browser Gallery at
MY CURATION     my Favorites, Hidden items and Tags
MY DEVICES      the machines I use Browser Gallery on
```

The operational target:

```text
Choose Folder → Choose Curation → Done
```

Everything else — media libraries, scopes, media ids, library ids, device ids, replicas,
associations, writer leases, alias indexes, prefixes, transports, generations — is **machinery**.
The customer's correct level of awareness of machinery is **none**.

## The hidden architecture principle

> **A concept earns customer-facing existence only when a customer decision depends on it.**

Browser Gallery may create, maintain, synchronize and depend on as much internal identity as it
needs. **Creating an identity is not a reason to show it.** An internal concept becomes
customer-facing only when the customer must make a decision that cannot be expressed without it —
and even then, it is expressed in the customer's own nouns, not the system's.

The corollary, which is where this principle is usually lost:

> **Never ask a plumbing question when Browser Gallery can ask a human question.**

```text
GOOD   "Is this the same media you use on Chromebook Pro?"
BAD    "Which Media Library should this Media Folder be associated with?"
```

Both may perform the identical internal operation. Only one requires the customer to have
learned Browser Gallery's architecture.

## The decision ladder

Whenever Browser Gallery faces a decision, in this order:

```text
1. Does BG already KNOW the answer from stored state?      → act, never ask
2. Can BG PROVE the answer from deterministic evidence?     → act, never ask
3. Can BG REDUCE the ambiguity before asking?               → reduce it
4. Is there ONE strong, corroborated candidate?             → propose it, as a yes/no
5. Otherwise                                                → ask one question, in the
                                                              customer's nouns, with a
                                                              safe default
```

**Prove and propose are different verbs and must never be confused.** Proof licenses action.
Anything short of proof licenses only a proposal. Structure, layout and names are never proof —
a backup copy has identical structure and identical names while being genuinely different files.

## Curation philosophy

Curation is one of the very few concepts that genuinely deserves customer-facing prominence, and
it should become **more** prominent as everything else recedes.

A Curation is a saved set of the customer's own choices: Favorites, Hidden items, Tags. Customers
may keep many, for different people, different purposes, simplified or expanded views, different
organizing styles, the same media source or different ones.

**Changing Curation must always be something the customer does because they want a different
experience — never because Browser Gallery needs administrative help.** If a Curation prompt
appears for a bookkeeping reason, that is a defect in Browser Gallery, not a decision for the
customer.

## Folder identity philosophy

A physical folder's identity is **device-local truth**. Absolute paths, folder handles, and
permission states never leave the device.

Logical media identity — the fact that a folder on this machine and a folder on another machine
show the same collection — is **shared truth**, and it exists so that curation can follow media
across devices.

These two must never collapse into one concept, and the shared one must never be minted merely
because a folder was opened. It is created when the customer does something that genuinely
implies it, and it is created **silently**.

**Names never prove identity.** Not folder names, not file names, not device names. Names are
presentation, everywhere, always.

## Parent / child philosophy

Folders are trees. A customer who curates a parent has, in a real sense, already answered the
question for its children.

> **Where Browser Gallery can PROVE that one folder is inside another, it should not ask the
> customer the same question twice.**

Precedence:

```text
1. An explicit choice for THIS folder always wins.
2. Otherwise, a PROVEN nearest ancestor's Curation may be inherited.
3. Otherwise, PROVEN descendants may produce a SUGGESTION — never an action.
4. Otherwise, ask.
5. Names and appearance never prove anything.
```

Inheritance fills a vacuum. It never resolves a conflict and never overwrites a choice. When it
acts, it says so in one sentence and offers one control to change it.

**Downward and upward are not symmetric, and the asymmetry is deliberate.** A child is provably a
*view into* the parent's collection, so the parent's Curation applies. A parent is provably
*more than* any one child's collection, so a child's Curation is at most a plausible default.
Downward may act; upward may only suggest.

**Proof has a fourth state, and it is load-bearing.** Ancestry is *proven*, *proven-not*, or
*unknown*. Unknown is the absence of a result — never a negative one. Treating unknown as
"unrelated" would let a permission-blocked parent silently strand a customer's curation.
**Unknown always declines to conclude.**

## Cross-device philosophy

Browser Gallery already knows when the customer has another device. **The customer must never
have to tell it so.**

Devices compare notes. What is portable is knowledge that is meaningful anywhere:

- media identity that two devices have agreed on
- relationships between folders, expressed **relative** to a shared collection
- bounded, sampled content evidence — sizes, names, counts
- Curation relationships

What is never portable is knowledge that is only meaningful here:

- absolute filesystem paths
- folder handles and permission states
- local row keys and local scope ids
- anything that is a capability rather than a fact

**Shared knowledge exists so another device can reconstruct as much as possible without asking
the human again.** That is its entire purpose. When it cannot, the fallback is one human
question — never a second setup ritual.

Be careful with the word "share". It must never imply that photos or videos are copied, moved,
combined or uploaded. Browser Gallery shares *knowledge about* media. It never moves media.

## Ambiguity and safety rules

These outrank every convenience rule in this document.

1. **Never trade identity safety for convenience.** A wrong identity match silently attaches one
   person's curation to the wrong files. There is no user-visible error and no obvious recovery.
   This is the worst outcome the product can produce.
2. **Unknown is not no.** Every three- and four-state contract in the system exists for this. Never
   collapse one into a boolean.
3. **Structure alone never auto-resolves.** Content corroboration is mandatory, and a single
   contradiction is a veto, not a lowered score.
4. **Two plausible candidates mean zero answers.** Ambiguity refuses; it does not pick a winner.
5. **Refusing is always safe.** A missed recovery costs the customer one question. A false match
   costs them their curation.
6. **Storage-enforced refusals are never auto-resolved.** They may be reworded. They may not be
   bypassed on the customer's behalf.

## Browser trajectory

Browser Gallery in a browser is bounded by real constraints, and this document names them so that
future work does not mistake them for laziness:

- The first folder pick requires a user gesture.
- Permission may need re-granting after a restart, and that also requires a gesture.
- **Therefore the browser floor for later use is one click. It cannot be zero.**
- Legacy folder picking has no durable handle and is permanently a full re-pick.
- There is no convergence without an open tab.

Target:

```text
First use:       Choose Folder → Choose Curation → Done
Every later use: one click on your folder → Done
Second device:   Connect → Choose Folder → one human question → Done
```

Anything beyond that floor is ceremony, and ceremony is a defect.

## Native trajectory

The installed edition removes the browser's constraints and should go further:

```text
First setup:  Add Folder once → Choose Curation → Done
Normal use:   Open Browser Gallery → Enjoy your media
```

No folder picker. No re-scan ceremony. No reconnection ritual under normal conditions. The
customer changes Curation only when they want a different Curation.

Native is not a rewrite. It is a **provider** and a **transport** behind seams that already
exist. Browser work must keep those seams single and clean so that native remains a small change
rather than a second architecture.

## StreamLoop relationship

Browser Gallery is StreamLoop's personal-media arm. StreamLoop's philosophy is Browser Gallery's:
reduce friction, reduce manual actions, increase automation, make the user think less, let the
user intervene whenever they want, and ask only when genuinely necessary.

The eventual native edition is a **prepared personal-media runtime**. Registered sources should
already be permission-ready, indexed, known, Curation-aware, addressable and playback-ready, so
that an Automation can say:

```text
Load BG source
Set Curation
Filter Favorites
Shuffle
Play
```

with no folder picker and no setup inside every panel.

> **Press go → start go.**

**A source and a Curation form an address.** That address is made of durable internal ids and it
must stay stable across every rename, move and reorganization. Making an id *less visible* to
customers and *more load-bearing* for automation is not a contradiction — it is the same fact
playing its correct role in two different layers, and it is the intended end state.

## Automation philosophy

Automation exists to remove work, never to remove control.

- Automation acts where Browser Gallery has proof.
- Automation proposes where it has evidence.
- Automation asks where it has neither.
- Automation always says what it did, in one sentence.
- Automation is always reversible by one control.
- **An explicit customer choice permanently outranks automation** — and is remembered until the
  customer changes it.

Automation that has to be supervised is not automation. Automation that cannot be overridden is
not acceptable.

## Breadcrumb philosophy

This codebase records **why**, not just **what** — including the defects that paid for each rule.
That practice is not decoration; it is what has repeatedly stopped correct decisions from being
casually undone. It continues.

- Record the reasoning, especially for a rule that looks removable.
- Record what was tried and rejected, and what it cost.
- Record what is deliberately **not** done, and why.
- When a boundary is deliberate, say so at the boundary.
- Leave seams where the future will need them, and keep each seam **single**.

A future agent must be able to tell the difference between a rule nobody has revisited and a rule
that was paid for.

## Anti-patterns — things future agents must not reintroduce

1. **Exposing an internal concept because it exists.** The concept must be required by a customer
   *decision*, not merely present in the architecture.
2. **Deleting internal identity because it was hidden.** Hiding a concept from the interface and
   removing it from the architecture are opposite actions. Shared identity is load-bearing for
   synchronization and for automation addressing.
3. **Asking a question Browser Gallery can already answer.** Especially one whose default value
   Browser Gallery computed itself.
4. **Teaching the product model before the customer has a decision to make.** Introductions that
   explain concepts nobody has needed yet are a symptom that too many concepts are exposed.
5. **Treating unknown as no.** In any contract, anywhere.
6. **Resolving identity from names, layouts or appearance.** A backup copy defeats all three.
7. **Auto-resolving a safety refusal on the customer's behalf.**
8. **Letting a folder acquire synchronized identity merely by being opened.**
9. **Letting a display name become an identity, or an identity become a display name.**
10. **Pushing policy down into the evidence layer.** The layer that observes must never be the
    layer that decides.
11. **Making a browser limitation load-bearing in a data model.** It closes the native door.
12. **Promising persistence the authorization model cannot deliver.** A promise that silently
    fails is worse than a smaller promise kept.
13. **Adding a settings group instead of answering a question.** A new group heading is usually
    evidence that Browser Gallery asked the customer to do its thinking.
14. **Using "share" where a customer could hear "copies my photos".**
15. **Trading identity safety for a smoother flow.** This is the one rule with no exceptions.

---

## Handoff — the smallest first North Star slice

No implementation prompt is written here, as instructed. The slice, and what it must prove:

> **SLICE:** Make Media Library invisible to a customer who has no cross-device question.
> Presentation layer only — `link-state.js` gains one input; `main.js` computes it from state
> Browser Gallery already has; the introduction drops from five steps to three; the two folder/
> library settings groups merge into one; the full selector moves to Advanced as a permanent
> escape hatch. No storage, fact, transport, MEDIA-ID, Stage 08 or Stage 09 change.

**It must prove:**

1. A local-only customer completes Choose Folder → Choose Curation → Done without ever meeting
   the words "Media Library".
2. The shared library identity is still minted silently on that Curation choice, so the customer
   is second-device-ready without having done anything for it.
3. Connecting Sync and meeting a peer surfaces the cross-device question for the first time — and
   only then.
4. Safety and recovery states are never hidden, and Advanced always reaches the full selector.
5. **All 52 existing tests pass unchanged.** Not adjusted. Unchanged. Any test requiring an edit
   is evidence the slice crossed into semantics and should stop.

Proof obligation 5 is the gate. Proof obligation 2 is the one that shows the North Star and the
V3 architecture are allies rather than opponents.

---

## Final verdict

```text
NORTH STAR ARCHITECTURE: SOUND
V2 SIMPLICITY CAN BE PRESERVED: YES
V3 INTERNAL MACHINERY WORTH PRESERVING: YES
MEDIA LIBRARY CAN BE MOSTLY HIDDEN: YES
PARENT/CHILD CURATION INHERITANCE: CONDITIONAL
CROSS-DEVICE STRUCTURAL NOTES: CONDITIONAL
GOOGLE FITS NORTH STAR: CONDITIONAL
NATIVE BG FITS NORTH STAR: YES
STREAMLOOP PATH PRESERVED: YES

RECOMMENDED FIRST NORTH STAR SLICE:
  Progressive disclosure of Media Library — presentation layer only.
  The selector, its settings group and its two introduction cards appear ONLY when a
  genuine cross-device question exists (a peer device, or a catalog entry this device
  did not create). Everything else is unchanged. Must prove: local-only Choose Folder →
  Choose Curation → Done with no Media Library vocabulary; silent libraryId minting
  still occurs; the question appears on peer arrival; safety/recovery states never
  hidden; all 52 existing tests pass UNCHANGED.

PERMANENT NORTH STAR DOC READY FOR REVIEW: YES

BLOCKERS: none for the first slice.
  Deferred conditions, not blockers:
   · Parent/child inheritance requires the four §9.4 constraints and its own exhaustive
     pure-model test table before implementation.
   · Cross-device structural notes require a new `structure` replica container built to
     the Stage 04B pattern (allow-list + shape guard in one edit, own transport file,
     asV3Replica normalization) — the first phase to touch V3 facts.
   · Google fits only with the OAuth broker; browser-only auth cannot deliver
     "connect once and forget" and the promise must not be made until it can.

REPORT: ~/codex-reports/North-Star/NORTH-STAR-ARCHITECTURE-AUDIT.md
```
