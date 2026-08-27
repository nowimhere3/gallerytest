# Browser Gallery North Star

**Status:** Approved product/architecture constitution.
**Applies to:** all North Star work, and any change that touches what the customer sees.
**Companion reading:** the North Star Architecture Audit (in the project's Reports and Docs), which
contains the evidence behind every rule stated here.

---

## Purpose

Browser Gallery's architecture will keep getting more capable. That is good, and it should
continue.

But capability has a dangerous tendency to leak into the interface. Every internal concept that
is genuinely useful will, at some point, seem worth exposing — because it is real, because it is
correct, and because exposing it is the shortest path to solving whatever problem is on the desk
that day. This has already happened once: SyncV3 made Browser Gallery substantially more correct,
and the customer was asked to learn more concepts, read more explanations and make more choices
than SyncV2 required.

**This document exists to stop that.**

It is a constitution, not a project plan. It states what Browser Gallery is for, what it promises
the person using it, and which rules may not be broken in pursuit of any feature.

> **A change that conflicts with this document is wrong — unless the human product owner
> explicitly amends this document first.**

An agent that finds a rule here inconvenient should say so, in writing, and ask. It should not
route around it.

---

## Customer Promise

> **Same media. Different device. Same Curation. Almost no setup.**

The customer's job is never "configure synchronization" and never "associate logical media
identities". Their job is:

> **"I have this media set up here. I want the same experience over there."**

Everything Browser Gallery builds is in service of that sentence.

---

## Governing Philosophy

> **Make the user think as little as possible.**
> **Make the user do as little as possible.**
> **Make the machine think harder so the human thinks less.**

Inherited from StreamLoop. Increasing architectural sophistication is justified **only** when it
reduces human work, human decisions, or human understanding requirements. Sophistication that
increases any of those is a regression, however correct the internals are.

### The governing regression test

For every change, ask:

> **Does this make the user think or do more than before?**

If **yes**, there must be a concrete, unavoidable, written reason. Otherwise it is a North Star
violation — regardless of how much it improves the architecture.

Stronger architecture is meant to *purchase* simplicity. If it has not bought any, it has not
been spent.

---

## Customer Mental Model

The customer owns approximately **three** ordinary concepts. That is the budget.

```text
MY MEDIA        the folders I point Browser Gallery at
MY CURATION     my Favorites, Hidden items and Tags — one saved set of my choices
MY DEVICES      the machines I use Browser Gallery on
```

The operational target:

```text
Choose Folder → Choose Curation → Done
```

**Everything else is machinery.** Non-exhaustive, and every item on this list is real, valuable,
and normally invisible:

```text
Media Library / logical collection identity     replica
libraryId                                       association fact
mediaId                                         transport
scope                                           writer lease
prefix                                          alias index
deviceId                                        generation
```

The customer's correct level of awareness of machinery is **none**. Not "simplified". Not
"explained well". None.

---

## Hidden Architecture Principle

> **A concept earns customer-facing existence only when a customer decision depends on it.**

The same rule applies to presentations of state: **do not show two customer-facing
representations when Browser Gallery can resolve them into one.** Stored state does not earn a
permanent control merely because it exists. A second representation appears only while a real
customer decision depends on the distinction, then retreats when the states agree.

Browser Gallery may create, maintain, synchronize and depend on as much internal identity as it
needs. **Creating an identity is not a reason to show it.** An internal concept becomes
customer-facing only when the customer must make a decision that cannot be expressed without it —
and even then it is expressed in the customer's own nouns, never the system's.

The corollary, which is where this principle is usually lost:

> **Never ask a plumbing question when Browser Gallery can ask a human question.**

```text
GOOD   "Is this the same media you use on Chromebook Pro?"
BAD    "Which Media Library should this Media Folder be associated with?"
```

Both may perform the identical internal operation. Only one requires the customer to have learned
Browser Gallery's architecture.

---

## Decision Ladder

Whenever Browser Gallery faces a decision, in this order:

```text
1. KNOW      Is the answer already in stored state?
                → act. Never ask.

2. PROVE     Can it be settled deterministically?
                → act. Never ask.

3. REDUCE    Can the ambiguity be narrowed first?
                → narrow it.

4. PROPOSE   Is there ONE strong, corroborated possibility?
                → propose it, as a yes/no in the customer's nouns.

5. ASK       Genuine ambiguity.
                → one human question, with a safe default.
```

> **Proof licenses action. Evidence licenses a proposal.**

These are different verbs and must never be confused. Proof permits Browser Gallery to act on the
customer's behalf. Anything short of proof permits only a proposal.

> **Names, layouts and visual similarity never prove identity.**

The counterexample is ordinary in a media library: a backup copy has identical structure and
identical filenames while being genuinely different files. Nothing structural separates them.
Content corroboration is mandatory, and a single contradiction is a **veto**, not a lowered score.

---

## Curation Philosophy

Curation is one of the very few concepts that genuinely **deserves** customer-facing prominence,
and it should become *more* prominent as everything else recedes.

A Curation is a saved set of the customer's own choices: Favorites, Hidden items, Tags.

Customers may deliberately keep several — for themselves, a spouse, a child, a guest; for
different purposes; for simplified or expanded organization; over the same media source or over
different ones. All of these are ordinary and intended.

> **Changing Curation must always be something the customer does because they want a different
> experience — never because Browser Gallery needs bookkeeping assistance.**

If a Curation prompt appears for an administrative reason, that is a defect in Browser Gallery,
not a decision for the customer.

---

## Folder Identity Philosophy

Two identities exist, and they are deliberately separate:

```text
PHYSICAL FOLDER IDENTITY     device-local truth
                             which folder on THIS machine, its handle, its path

LOGICAL COLLECTION IDENTITY  shared truth
                             which collection this is, agreed across devices
```

Rules:

1. **Never collapse them internally.** They answer different questions and fail in different ways.
2. **Never require the customer to understand the distinction merely because it exists.** The
   distinction is real and load-bearing for the machine. It is not a customer concept.
3. **Never mint shared identity merely because a folder was opened.** Opening a folder is not a
   statement about collections. If every opened folder acquired synchronized identity, every
   customer would accumulate identities nobody asked for.
4. **Shared identity may be created silently** when an explicit customer action genuinely implies
   it — for example, choosing a Curation for a folder. Silent creation is correct. Silent
   creation *plus* a UI announcing it is not.
5. **Names are presentation, never identity.** Not folder names, not file names, not device names,
   not directory names in the sync tree. A renamed thing is the same thing.

---

## Parent / Child Philosophy

Folders are trees. A selected root may contain nested subfolders with dispersed media, and a
customer who has curated a parent has, in a real sense, already answered the question for its
children.

Browser Gallery already has proven ancestry machinery. Where it can **prove** that one folder is
inside another, it should not ask the customer the same question twice.

```text
Explicit choice for THIS folder      → wins, permanently
Otherwise, proven nearest ancestor   → may supply the Curation
Otherwise, proven descendants        → may produce a SUGGESTION
Otherwise                            → ask
```

### The critical asymmetry

> **Downward inheritance may ACT when ancestry is proven and the child is unassigned.**
> **Upward inference may only SUGGEST.**

This asymmetry is deliberate and must not be "tidied up". A child is provably a *view into* the
parent's collection, so the parent's Curation applies to it. A parent is provably *more than* any
one child's collection, so a child's Curation is at most a plausible default. The cost asymmetry
points the same way: a wrong parent Curation mis-presents the customer's entire library; a wrong
child Curation mis-presents one subfolder.

### Non-negotiables

- **Never overwrite an explicit child association.** Inheritance fills a vacuum. It never resolves
  a conflict.
- **`UNKNOWN` must remain different from `UNRELATED`.** Ancestry has three meaningful outcomes:
  proven, proven-not, and *no information*. A throw, a missing API, an unheld handle and an
  ungranted permission all produce the third. Collapsing it into "unrelated" would let a
  permission-blocked parent silently strand a customer's curation. **Unknown always declines to
  conclude.**
- **MEDIA-ID is EVIDENCE. North Star Curation resolution is POLICY.** Do not merge those
  responsibilities. The layer that observes must never be the layer that decides. Policy reads
  evidence read-only and lives above it.

---

## Cross-Device Philosophy

Devices compare notes. Portable knowledge exists for exactly one reason: **so the human does not
have to repeat setup.**

What may travel:

- synchronized logical identity two devices have agreed on
- Curation relationships
- safe *relative* structural evidence — but only after its own audited phase

What stays local, always:

- physical and absolute filesystem paths
- folder handles
- local scope ids and local row keys
- permission state

Anything that is a *capability* rather than a *fact* stays local by definition.

### The approved correction — peer existence is not question existence

> **Another device existing does not itself create a customer decision.**
>
> **Peer existence is not cross-device-question existence.**

A peer device is **context**. It is information Browser Gallery may use while resolving identity,
and it is what makes a human question *answerable* when one is genuinely needed. It is **not**
itself a reason to expose identity plumbing.

```text
One device                                              → identity plumbing invisible
Sync connected, still one device                        → identity plumbing invisible
Two devices connected, no unresolved identity decision  → identity plumbing invisible
An unresolved identity decision for the CURRENT media   → one human question may appear
```

A question appears only when Browser Gallery actually has an unresolved identity decision **for
the media currently in front of the customer** — and cannot safely answer it itself.

Do not make identity plumbing appear because another device joined Sync.

### Words

Be careful with "share". It must never imply that photos or videos are copied, moved, combined or
uploaded. **Browser Gallery shares knowledge *about* media. It never moves media.**

---

## Media Library Philosophy

This section exists because future agents **will** misunderstand the North Star, and this is the
specific misunderstanding to expect.

> **Media Library is valuable internal architecture. It should become less VISIBLE, not less
> IMPORTANT.**

**Do not delete or weaken `libraryId`.** Its long-term importance may actually *increase*, because
it is a durable machine address for:

- synchronization
- logical media identity
- automation
- StreamLoop

The intended inversion is:

> **More load-bearing for machines. Less visible to humans.**

These are not in tension. It is the same fact playing its correct role in two layers: an opaque,
stable handle for machines, and nothing at all for humans. Hiding an identifier from the interface
does not weaken it — it *protects* it, because a customer-facing identifier acquires renaming,
merging and "why are there two?" pressure that an internal address never does.

### When ordinary customers should encounter Media Library

Not because:

- they loaded a folder
- Sync exists
- Google exists
- another device exists
- a Curation exists

It may surface **only** through human-language recovery or ambiguity interactions, when genuinely
unavoidable — and even then it should be phrased in the customer's nouns wherever possible.

Advanced / diagnostic access to the full plumbing may remain permanently available. That is an
escape hatch, not the ordinary path, and it is how the concept stays reachable without being
taught.

---

## Browser Trajectory

The genuine browser floor, stated honestly so future work does not mistake it for laziness:

```text
First use:    Choose Folder → Choose Curation → Done
Later use:    Choose recent folder → Done
```

Browser limitations that are real:

- **The first folder pick requires a user gesture.** It cannot be automated away.
- **Permission may need re-granting after a restart,** and that also requires a gesture.
- **Therefore the later-use floor is one click. It cannot be zero.**
- File System Access support is not universal, and legacy folder picking has no durable handle at
  all — it is permanently a full re-pick.
- Convergence is tab-lifetime. There is no background sync with no tab open.

Anything beyond that floor is ceremony, and ceremony is a defect.

> **Do not allow browser constraints to become load-bearing data-model assumptions.**

A data model shaped around a browser limitation closes the native door. Today's model does not
have that problem, and that is why native remains cheap.

---

## Native Trajectory

The installed edition removes the browser's constraints and should go further.

```text
First setup:  Add Folder once → Choose Curation → Done
Normal use:   Open Browser Gallery → Enjoy your media
```

No folder picker. No re-scan ceremony. No reconnection ritual under normal conditions. The
customer changes Curation only when they want a different Curation.

Registered folders eventually become:

- permission-ready
- persistent
- indexed
- refreshable
- Curation-aware
- addressable
- playback-ready

> **Native must reuse the existing provider and transport seams rather than require a second
> Browser Gallery architecture.**

Native is a provider and a transport behind seams that already exist. Browser work must keep those
seams single and clean so that native stays a small change.

### The private local media gateway

The native trajectory may eventually include a **very small private localhost media gateway**, so
that registered local media can be consumed — by Browser Gallery's own native runtime, and by
StreamLoop where the two are used together — without a folder-picker round trip.

Constraints on it, stated now so the direction cannot drift:

- It serves **media the user already owns on that machine**. It is not a hosted service.
- It is **private and local**. Not a library other people connect to, not a network product, and
  not a customer-facing surface anyone has to configure.
- It exists to remove setup ceremony, which is the same reason everything else here exists.
- **Browser Gallery is not becoming a centralized or general-purpose media server.** The non-goal
  is the Plex/Jellyfin shape, not the act of serving local bytes to a local consumer.

The distinction matters because the README's non-goals list says Browser Gallery is not a media
server. That remains true in the sense that matters — and it must not be read as forbidding this
narrow local bridge.

---

## StreamLoop Relationship

### Standalone first

> **Browser Gallery is a standalone product. It does not require StreamLoop to exist, operate,
> provide value, or succeed.**

```text
Browser Gallery              a standalone personal-media platform
StreamLoop                   a standalone orchestration platform
Browser Gallery + StreamLoop deeply compatible products, more powerful together
```

Browser Gallery must always remain independently usable as a complete personal-media application.
Never describe it as merely a StreamLoop component, plugin, subordinate application or dependency.

The phrase **"StreamLoop's personal-media arm"** names the integration role Browser Gallery can
play *when the two products are used together*. It does not redefine Browser Gallery as dependent
on StreamLoop. Both truths hold:

> **Standalone first. Seamlessly integrable by design.**

This is not merely diplomatic phrasing — it is an architectural constraint. Every capability below
must be worth building for Browser Gallery's own users on its own terms. If a feature only makes
sense because StreamLoop exists, it is a StreamLoop feature and it does not belong here.

### Shared philosophy

StreamLoop's philosophy is Browser Gallery's:

- reduce friction
- reduce manual action
- increase automation
- let the user intervene whenever they want
- ask only when genuinely necessary

The long-term runtime target — worth building for Browser Gallery's own users first, and equally
what makes integration possible:

```text
Load BG source
Set Curation
Filter Favorites
Shuffle
Play
```

No folder chooser in every panel. No setup ceremony inside automation.

> **Press go → start go.**

And the architectural insight that makes it possible:

> **A durable source identity and a Curation together form a machine address.**

Internal ids must remain stable across customer-facing renames and reorganizations. A rename is a
presentation event; it never changes an address. This is the direct reason the Media Library
inversion above matters: the thing being hidden from humans is the thing automation will depend
on.

---

## Automation Philosophy

> **Automation exists to remove work, never to remove control.**

Rules:

- **proof → act**
- **evidence → propose**
- **ambiguity → ask**
- explain an automatic action in **one sentence**
- make automatic behaviour **reversible by one control**
- **explicit customer choice permanently outranks automation** — and is remembered until the
  customer changes it

> **An automation that requires constant supervision has failed to automate.**
> **An automation that cannot be overridden is not acceptable.**

---

## Breadcrumb Constitution

This codebase records **why**, not just **what** — including the defects that paid for each rule.
That practice is not decoration. It is the reason correct decisions in this project have survived
being casually undone, repeatedly, across many stages and several agents.

> **A future agent should be able to distinguish a rule nobody revisited from a rule the project
> paid dearly to learn.**

That sentence is the entire point of breadcrumbs. Everything below is mechanism.

**Breadcrumbs are also what makes old implementation reports disposable.** A finished phase's
reports should eventually be deletable, because everything durable they established has graduated
into code, tests, `[WHY:]`, breadcrumbs, the README, or this document. If a future agent would
need to read an old phase's report folder to work safely, that is a breadcrumb defect to fix —
not a reason to keep the archive forever. See the README's *Reports and Docs* section.

### Canonical forms

```text
BREADCRUMBS — IS
BREADCRUMBS — WAS
BREADCRUMBS — WILL BE / FUTURE
```

Alongside these, `[WHY: …]` blocks carry the reasoning for a specific decision at the point where
it is made. Both conventions are current and neither replaces the other: `[WHY:]` explains a line
or a rule; `BREADCRUMBS` explains a seam's trajectory through time.

#### BREADCRUMBS — IS

Current architectural or product truth.

- what this seam or rule does **now**
- why it exists **now**
- which invariant it protects

#### BREADCRUMBS — WAS

Historical context that **materially explains** the current design.

- what the previous behaviour or design was
- what defect or problem caused it to change
- why reverting casually would be dangerous

**Do not use WAS as a changelog.** Git already holds the history. Use WAS only when history
explains a present rule that would otherwise look arbitrary or removable.

#### BREADCRUMBS — WILL BE / FUTURE

Approved direction, or an intentionally preserved seam.

- what future capability this seam is intended to support
- what today's code must **avoid doing** so that future remains possible

**A FUTURE breadcrumb is not a feature promise.** It protects architectural optionality. It says
"keep this door open", not "we are going to walk through it".

**Add one only when today's code is actually shaped by it.** A FUTURE breadcrumb is architectural
protection, not feature brainstorming. If the seam would look identical without the future in
mind, the future does not belong in the code — put it in a report or the working sequence instead.

### Style

Breadcrumbs are usually **one to two sentences**. They record *why*, not a line-by-line narration
of the code. A breadcrumb that describes what the next line does has failed; a breadcrumb that
explains why the next line is not the obvious alternative has succeeded.

### Approved CURRENT → FUTURE directions

These are architectural direction, **not feature promises**. They exist so that today's code
leaves the right doors open.

```text
CURRENT:  Browser FSA folders require a user gesture, and permission may need re-granting.
FUTURE:   A native provider owns persistent folder access.
PROTECT:  Keep provider access behind the existing provider seam. Never let a gesture
          requirement become an assumption in the data model.
```

```text
CURRENT:  Media Library / libraryId is SyncV3's internal shared identity.
FUTURE:   It can become a StreamLoop automation address.
PROTECT:  Keep it stable and hidden. Never derive it from a name; never let a rename
          change it; never delete it because it became invisible.
```

```text
CURRENT:  MEDIA-ID proves local folder ancestry and media aliases, and synchronizes nothing.
FUTURE:   North Star policy may consume that evidence for Curation inheritance.
PROTECT:  MEDIA-ID remains evidence-only. Policy reads it; policy never moves into it.
```

```text
CURRENT:  The manual Sync Folder is a proven, account-free transport.
FUTURE:   Google appDataFolder may become the low-friction provider.
PROTECT:  Keep the transport directory-shaped. Keep the manual folder as a peer provider.
          Do not promise persistence until the authorization model can truthfully deliver it.
```

```text
CURRENT:  Browser Gallery serves no bytes; the browser reads files the OS hands it.
FUTURE:   A very small PRIVATE LOCALHOST media gateway may let the native runtime — and
          StreamLoop, where both are used — consume registered local media without a
          folder-picker round trip.
PROTECT:  Keep media access behind the provider seam. Do not build anything that only makes
          sense as a hosted/multi-user service; the non-goal is the centralized media-server
          shape, not serving local bytes to a local consumer.
```

```text
CURRENT:  Cross-device knowledge is limited to Curations, Libraries and associations.
FUTURE:   Safe relative structural evidence may travel, enabling devices to compare notes.
PROTECT:  Keep absolute paths, handles, scope ids and permission state strictly local.
          Any new portable fact goes through the replica's allow-list and shape guard.
```

---

## Anti-Patterns

Things future agents must not reintroduce.

1. **Exposing an internal concept because it exists.** The concept must be required by a customer
   *decision*, not merely present in the architecture.
2. **Deleting internal identity because it is hidden.** Hiding a concept from the interface and
   removing it from the architecture are opposite actions.
3. **Asking a question Browser Gallery already knows the answer to** — especially one whose
   default value Browser Gallery computed itself.
4. **Teaching architecture before the customer has a decision to make.** Introductions explaining
   concepts nobody has needed yet are a symptom that too many concepts are exposed.
5. **Treating `UNKNOWN` as `NO`.** In any contract, anywhere.
6. **Resolving identity from names, layouts or appearance.** A backup copy defeats all three.
7. **Auto-resolving a safety refusal** on the customer's behalf.
8. **Minting synchronized identity merely because a folder was opened.**
9. **Confusing display names with identity** — in either direction.
10. **Pushing policy into the evidence layer.** The layer that observes must never decide.
11. **Making browser limitations load-bearing** in a data model. It closes the native door.
12. **Promising persistence the authorization model cannot deliver.** A promise that silently
    fails is worse than a smaller promise kept.
13. **Adding a Settings group instead of solving the decision.** A new group heading is usually
    evidence that Browser Gallery asked the customer to do its thinking.
14. **Using "share" where a customer could hear "copies my photos".**
15. **Trading identity safety for convenience.** This is the one rule with no exceptions.
16. **Surfacing cross-device plumbing merely because another device exists.** Peer presence is
    context, not a customer decision.

---

## Working Sequence

**This section is the one part of this document that is NOT constitution.** It is the current
working plan and may be revised freely as work proceeds. Everything above it may not.

### North Star browser/product slices

```text
N1  Progressive Disclosure          make Media Library invisible on the ordinary path
N2  Device-Aware Human Questions    "Is this the same media you use on Chromebook Pro?"
N3  Proven Parent Inheritance       downward, proven, vacuum-only, announced, reversible
N4  Reverse Suggestion              upward, suggestion only, never applied
N5  Portable Structure              new replica container; first phase to touch V3 facts
```

N1 through N4 touch no synchronized data. That ordering is deliberate: most of the North Star's
*felt* benefit is reachable without opening the files this project most carefully protects.

### Future major initiatives — scope and numbering deliberately open

```text
FUTURE MAJOR INITIATIVE — Google-authorized low-friction Sync    exact phase/name TBD
FUTURE MAJOR INITIATIVE — Native Browser Gallery                 exact phase/name TBD
```

**These are not slices, and they are deliberately not numbered.** Both are substantially larger
bodies of work than N1–N5 — a Drive transport plus an authorization broker, and a persistent
native runtime — and either may become a separate major phase, a separately named initiative, a
later North Star phase, or something organized differently once N1–N5 have settled the model.

Their **architectural direction is settled** and is stated in the Browser and Native Trajectory
sections above, along with the breadcrumbs that keep their doors open. Only their
implementation-phase taxonomy is open. Do not let a planning shorthand harden into a claim that
either has already been sized, scheduled, or reduced to a single slice.

### The N1 predicate — stated carefully

The first target is:

> **Make Media Library invisible when there is no genuine customer identity decision.**

The condition for surfacing it is conceptually:

```text
unresolvedCrossDeviceIdentityDecisionForCurrentFolder
```

**It is emphatically not `peers.length > 0`.** A peer existing may help Browser Gallery *create
and evaluate* candidates. It does not itself make this predicate true. See the approved correction
under Cross-Device Philosophy.

The exact production predicate is deliberately not fixed here. What is fixed is the distinction:

```text
peer exists  ≠  customer decision exists
```

---

## Amending This Document

This constitution is amended by the human product owner, deliberately, in writing.

An agent that believes a rule here is wrong should **say so and stop**, presenting the conflict
and the evidence. It should not implement around a rule it disagrees with, and it should not
quietly narrow a rule to fit a task.
