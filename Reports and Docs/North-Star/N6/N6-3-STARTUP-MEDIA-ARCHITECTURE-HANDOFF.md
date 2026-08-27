# N6-3 — Startup Media + Advanced Disclosures (Architecture Handoff)

**Thursday, August 27, 2026 — 1:51 PM MDT** (America/Edmonton)

**Role:** architecture handoff for the implementer. Not an implementation.
**Baseline:** branch `SandboxSyncV3`, HEAD `c022f94` ("Complete North Star N6 zero-ceremony
reopen"), worktree clean.
**Constitution:** `Reports and Docs/NORTH-STAR.md` — it outranks this document.

Two bounded features. Both are Advanced-surface and neither touches identity, sync or the media
pipeline.

---

## Feature 1 — Startup Media

### What it is

An Advanced preference choosing what Browser Gallery loads at launch:

| Policy | Meaning |
| --- | --- |
| `last-used` | **Default.** Today's N6 behaviour, unchanged |
| `random-remembered` | Random pick among all remembered durable folders |
| `random-selected` | Random pick among a customer-chosen subset |

`random-selected` presents remembered durable FSA folders with checkboxes. The customer chooses
the eligible set **once**; Browser Gallery picks among them on every later launch.

Randomness is legitimate here precisely because the customer explicitly asked for a random policy.
That is a chosen behaviour, not Browser Gallery guessing — the Decision Ladder is not violated.

### State shape

Add one new section to `app-preferences.js`, beside `playback` / `presentation` / `microArcade` /
`onboarding`:

```js
const DEFAULT_STARTUP = {
  policy: "last-used",     // "last-used" | "random-remembered" | "random-selected"
  eligibleLibraryIds: [],  // local library row ids ("lib-…"), only meaningful for random-selected
};
```

Normalize on read exactly as the existing sections do: an unrecognized `policy` falls back to
`"last-used"`; `eligibleLibraryIds` coerces to an array of non-empty strings, deduplicated.

### Persistence location

`app-preferences.js`, via a new `saveStartupPreferences(partial)` wrapping the existing
`savePartial("startup", …)`. That helper is already a per-section read-modify-write, so saving a
policy cannot erase the eligible set or any sibling preference.

**Not on the library row.** `library-registry.js`'s header states it "ONLY persists
identity/metadata". A startup policy is neither. Keeping the set in preferences also means
removing a folder from Recents does not silently rewrite a customer's startup choice.

Both stores are device-local and neither is synced, so a startup policy stays a property of *this
device* — which is correct: different machines may reasonably start differently.

### Startup decision precedence

Extend the existing pure module rather than adding a second one:

```text
decideStartupMedia({ policy, rows, permissionStates, eligibleIds, random, context })
  → { restore: false } | { restore: true, rowId }
```

Order:

```text
1. A customer gesture already in flight wins        (existing libraryLoadGeneration guard)
2. Resolve the pool by policy:
     last-used         → [rows[0]]           ← N6 semantics, unchanged
     random-remembered → rows
     random-selected   → rows filtered to eligibleIds
3. Filter the pool to permission === "granted"      ← ALWAYS, after step 2
4. Pool empty → { restore: false }                  ← do nothing; Recents behaves as today
5. Pool non-empty → pick one:
     single-entry pool → that entry
     multi-entry pool  → pool[floor(random() * pool.length)]
```

Four rules that are easy to get wrong:

- **Filter to `granted` after building the pool, never before choosing the policy.** A random pick
  that lands on a non-granted row and then does nothing would read as broken.
- **`last-used` still consults `rows[0]` only.** N6 deliberately refuses to fall through to
  `rows[1]`; do not silently upgrade it to "most recent granted". `test-boot-restore.mjs` must
  still pass unchanged.
- **An empty eligible set under `random-selected` means do nothing** — it does not fall back to
  `last-used`. Falling back would override an explicit customer choice with a default.
- **Sort the pool deterministically before indexing** (by `lastOpenedAt` desc, then `id`) so a
  fixed `random()` maps to a fixed row across runs.

### Checkbox / set semantics

- The list shows remembered **durable FSA** rows — the same population `listLibraries()` returns.
  Legacy rows have no handle and never appear.
- The set stores **ids**, not names or handles.
- **Stale ids are tolerated, never pruned.** A folder removed from Recents simply stops matching
  at decision time. Do not eagerly rewrite the set when the registry changes — the same reasoning
  as N6's P6: a background tidy-up must not silently discard a customer's choice.
- Checking a folder does not touch its permission, identity, Curation or Recents position.

### Permission behaviour

Unchanged from N6, and non-negotiable:

- `queryPermission({ mode: "read" })` only. **Never `requestPermission` at boot** — it needs a
  gesture.
- Only `"granted"` is eligible. `"prompt"`, `"denied"`, a missing handle, a missing API or any
  throw all mean not eligible.
- If nothing is eligible, do nothing and leave the normal Recents flow exactly as it is.
- Permission is queried live each launch and never cached or persisted.

### Deterministic random-test seam

Inject the generator, exactly as `micro-arcade-selector.js:56` already does
(`random = Math.random`). `decideStartupMedia` takes `random` as a parameter and calls nothing
global. That makes every policy exhaustively testable in Node with a stub generator.

Copy that existing pattern — do not invent a new seeding scheme or a PRNG module.

### Future StreamLoop seam

`decideStartupMedia` accepts a `context` parameter, defaulting to `"browser"`. **That is the whole
seam.** Honour the parameter; write no detection logic and no second policy.

> **Do not infer StreamLoop from iframe presence.** `window.self !== window.top` proves only that
> some page framed us — any site can. A future StreamLoop launch must identify itself through an
> explicit launch/runtime contract, and only that contract may set `context`.

Leave this breadcrumb where the parameter is defined:

```text
BREADCRUMBS — WILL BE / FUTURE: `context` exists so an explicitly identified StreamLoop launch
  can select a different startup policy than ordinary browser use. It must be set only from an
  explicit launch/runtime contract — never inferred from framing, referrer, or user agent.
```

### Likely files

| File | Change |
| --- | --- |
| `src/storage/boot-restore.js` | Add `decideStartupMedia`; keep `decideBootRestore` as-is or as the `last-used` branch it already implements |
| `src/storage/app-preferences.js` | `DEFAULT_STARTUP`, normalization, `saveStartupPreferences` |
| `src/main.js` | Read the policy at boot; pass rows, permission states, eligible ids; render the Advanced control and checkbox list |
| `index.html` | The Startup Media Advanced disclosure (Feature 2) |

No change to `library-registry.js`, the providers, the runtime, MEDIA-ID, SyncV3, or any N1–N5
policy module.

---

## Feature 2 — Advanced Settings disclosures

Inside the existing `<details class="advanced-settings-section">`, each advanced function becomes
its own nested `<details>`, **closed by default**:

```text
Advanced Settings
  ▸ Media Library diagnostics      (currently div.advanced-media-library-section + h3)
  ▸ Arcade animations              (currently div.advanced-playback-section + h3)
  ▸ Sync Your Curations            (currently a bare h3 + content)
  ▸ Startup Media                  (new)
```

> Advanced means complexity is **available on demand**, not displayed all at once.

Two implementation notes:

- **Ids and listeners are unaffected.** `getElementById` works inside a closed `<details>`, so
  existing captures and handlers need no change.
- **Programmatic scroll/focus into a collapsed section will not show.** The repo already handles
  this pattern — `expandAndScrollToProfileSection()` sets `.open = true` before scrolling. Any
  existing path that scrolls or focuses into an advanced block must open both the outer and the
  new inner `<details>`. Audit those call sites; there are few.

---

## Out of scope

- Any StreamLoop detection, context-setting, or alternate policy behaviour
- Permission prompting at boot, under any condition
- Changing `last-used` (N6) semantics, including its refusal to try `rows[1]`
- Changing `resumeLibrary()`'s explicit-click behaviour or its Recents pruning
- Loading more than one folder at startup
- Weighting, ordering, rotation, or "don't repeat last time" logic — a later slice if ever wanted
- Any change to the media-loading pipeline itself; startup policy only *selects* a row
- Native work, Google/OAuth work, transport or identity changes
- Migrating existing users to a non-default policy

---

## Tests Sonnet must prove

**New — `tools/test-startup-media.mjs`** (pure, no DOM, stub `random`):

| Case | Expected |
| --- | --- |
| `last-used`, `rows[0]` granted | restore `rows[0]` |
| `last-used`, `rows[0]` not granted, `rows[1]` granted | **no restore** (N6 rule preserved) |
| `random-remembered`, none granted | no restore |
| `random-remembered`, subset granted | always picks from the granted subset |
| `random-remembered`, fixed `random` | same row every run (determinism) |
| `random-selected`, empty eligible set | **no restore** — never falls back to `last-used` |
| `random-selected`, eligible ids all stale | no restore, set not modified |
| `random-selected`, mixed stale/valid/granted | picks only from valid ∩ granted |
| any policy, unknown policy string | behaves as `last-used` |
| `context` omitted | behaves as `"browser"` |

Assert no code path can return a "request permission" outcome.

**Preferences:** round-trip `startup`; unknown policy normalizes to `last-used`;
`eligibleLibraryIds` normalizes and dedupes; saving `startup` leaves `playback` / `presentation` /
`microArcade` / `onboarding` intact.

**DOM:** each of the four advanced sections is a `<details>` without `open`;
`tools/check-dom-contract.js` passes.

**Regression:** the full suite passes, `test-boot-restore.mjs` **unchanged**. If it needs editing,
N6 semantics have moved and the slice has exceeded its scope.

**Human test required: NO.** Every branch is deterministic given injected permission states and an
injected generator, and disclosure state is a static DOM assertion.

---

## Sizing

Small-to-moderate. One pure function extended, one preference section, one settings control plus a
checkbox list, four disclosure conversions, one new test file. No storage-schema, identity, fact
or transport change. Reversible by restoring the default policy and unwrapping the disclosures.
