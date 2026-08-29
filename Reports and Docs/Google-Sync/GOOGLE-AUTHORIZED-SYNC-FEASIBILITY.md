# [BROWSER GALLERY / GOOGLE-AUTHORIZED SYNC / ARCHITECTURE & FEASIBILITY SPIKE]

ROLE: Architecture only. No production code was written, no experiment was run,
no dependency added, no Google credential or Cloud resource created.

## 1. Timestamp

Research and inspection performed **2026-08-27, 03:00–03:14 UTC**.
All Google findings below were fetched from `developers.google.com` during that
window and are cited inline. Nothing here is recalled OAuth behaviour.

## 2. Branch / HEAD / worktree state

```text
git branch --show-current   → SandboxSyncV3
git status --short --branch → ## SandboxSyncV3...origin/SandboxSyncV3   (clean, no ahead/behind)
git log -1 --oneline        → 3c93e88 Complete SyncV3 Stage 10 UX closeout
git diff --check            → clean
```

**The Stage 10 gate passes.** `3c93e88` (`3c93e883043157e7ed306456f4de47bd3179bb00`) contains
the Stage 10 closeout — 25 files, +2061/−534, including `media-library-options.js`,
`sync-status-copy.js` and the new `test-sync-folder-change.mjs` / `test-media-library-selection.mjs`
suites. The worktree is clean and in sync with origin. Stage 10 is the product baseline.

Nothing was modified, committed, pushed or reset during this spike.

## 3. Current SyncV3 architecture summary

```text
ProfileStore ......... owns Curations/Profiles, Favorites, Hidden, Tags, tombstones,
                       Media Library catalog, Library→Curation associations,
                       logical clock (SyncIdentity), replica derivation, merge adoption
SyncIdentity ......... deviceId (minted locally, IndexedDB, NEVER from an account),
                       deviceName (presentation only), logical stamp floor
ProfileSync .......... ONE engine, ONE reconcile chain, ONE status surface.
                       Mode (v1|v2|v3) selects which pass body runs.
                       Owns the 3s debounce + 3s convergence poll + writer lease.
sync-v3.js ........... runSyncV3Pass(): preflight → settle facts → refreshFromStorage
                       → deviceId → writer lease → runV3PassBody()
sync-v3-transport.js . the file layout and its read/write/verify primitives
sync-v3-write-policy . the single seam authorizing a V3 write (Web Locks lease)
```

On-disk layout:

```text
<chosen folder>/sync-v3/devices/
  Chromebook -- a31f2c4e/          ← readable name, NOT identity
    device.json                    ← commit point, written LAST, carries every file's hash
    associations.json
    libraries.json
    profiles/
      BEAST -- 93bc1a7d.json       ← readable name, NOT identity
```

Three properties matter enormously for this spike:

1. **Identity is content-addressed** (Stage 02). Every filesystem name is presentation;
   `deviceId` is read out of `device.json`. A directory whose name changed is still the same
   device. `discoverDevices()` groups by `deviceId` read from content, sorts generations with
   `compareGenerations`, elects a winner and *reports* duplicates rather than failing.
2. **Commit is a manifest, not a filesystem primitive.** Data files are written first;
   `device.json` last, declaring `{file, hash}` for each. A reader that finds `device.json`
   missing sees "empty"; present-but-any-declared-file-missing/unparseable/hash-mismatched sees
   "invalid" and skips *the whole directory* for that pass. **A read never partially trusts a
   directory.**
3. **Publish is write → read back → verify → cleanup.** `publishOwnReplicaVerified()` re-reads
   its own directory and compares `replicasEqual(readBack.replica, normalized)` before it
   cleans anything up.

These three are what make a cloud transport credible. They are not FSA-derived — they are
Browser Gallery's own integrity model, and they happen to be exactly the properties a
non-atomic, duplicate-name-tolerant, eventually-consistent object store requires.

## 4. Exact FSA / directory-handle coupling points

There are **four** sites, and only four.

| # | Site | Coupling |
| --- | --- | --- |
| 1 | `profile-sync.js` | holds `#v3DirHandle`; `#refreshV3Connection()` calls `queryPermission` / `requestPermission`; `connectV3Folder(dirHandle)`; `getStatus().v3Configured = Boolean(#v3DirHandle)` |
| 2 | `storage/profile-sync-store.js` | `saveV3SyncConnection(handle)` / `loadV3SyncConfig()` / `clearV3SyncConfig()` — structured-clones a `FileSystemDirectoryHandle` into IndexedDB |
| 3 | `sync-v3.js:95–107, 185–186` | `dirHandle.queryPermission({mode:"readwrite"})` preflight, then `Transport.getSyncV3Root(dirHandle,{create})` → `Transport.getDevicesDir(root,{create})` |
| 4 | `sync-v3-transport.js` | every remaining call — and **every one is a method on a directory or file handle** |

The complete primitive set `sync-v3-transport.js` uses, enumerated from source:

```text
dir.entries()                            → async iterate [name, handle]
dir.getDirectoryHandle(name, {create})
dir.getFileHandle(name, {create})
fileHandle.getFile()  → .text()
fileHandle.createWritable() → .write(text) → .close()
dir.removeEntry(name, {recursive})
```

**Six operations.** Everything else in that 864-line module — hashing, name assignment,
manifest ordering, ownership markers, generation election, verification, cleanup — is pure and
already transport-agnostic.

**The decisive structural fact:** below `runSyncV3Pass`, the entire Drive-facing surface funnels
through a *single object*, `devicesDir`. `runV3PassBody` obtains it once and passes it to exactly
two functions: `discoverDevices(devicesDir, …)` and `publishOwnReplicaVerified(devicesDir, …)`.

Device identity is **fully independent of transport and of any account**: `SyncIdentity` mints
`deviceId` locally into IndexedDB, degrades to an ephemeral session identity when IndexedDB is
unavailable, and is never derived from a Google account. Google authorization changes nothing here.

## 5. Proposed transport boundary

**Recommendation: adapt at the directory-handle shape, not at a redesigned semantic interface.**

The task sketched `SyncTransport { listDevices(), readDeviceReplica(), … }`. Deriving the boundary
from actual code says something better and cheaper: because every FSA call is already a method on
a directory-shaped object, the minimal seam is a **duck-typed directory provider**:

```text
SyncDirectory {                      // what sync-v3-transport.js already consumes
  entries()                          // AsyncIterable<[name, SyncDirectory|SyncFile]>
  getDirectoryHandle(name, { create })
  getFileHandle(name, { create })
  removeEntry(name, { recursive })
}
SyncFile {
  getFile()          → { text() }
  createWritable()   → { write(text), close() }
}
```

Consequences, which are the whole argument for this shape:

- **`sync-v3-transport.js` does not change at all.** The proven merge/commit/verify code is
  untouched, so no Stage 02–09 semantics are at risk.
- `sync-v3.js` needs one change: the `queryPermission` preflight becomes a provider-supplied
  `ensureAccess()` (FSA → `queryPermission`; Drive → "do I hold a usable access token?").
- `profile-sync.js` stores a *provider descriptor* rather than a raw handle, and
  `v3Configured` becomes "a provider is configured" instead of "a handle exists".
- The Drive adapter is a genuinely new, self-contained module implementing six methods.

A semantic interface (`listDevices()/readDeviceReplica()`) would require rewriting the transport
against it — i.e. re-deriving the very code whose correctness is the reason this is feasible.
**Do not do that.**

### The one place the shapes genuinely differ — flag hard for Codex

`getDirectoryHandle(name, { create: true })` on FSA is **get-or-create by name**. Drive is not:
`files.create` with a duplicate name creates a **second** file/folder, and Drive names are
case-sensitive while `resolveOwnDirectoryName()` computes occupancy with `directoryName.toLowerCase()`.

The adapter must therefore implement get-or-create as *query-by-name-then-create*, and that
sequence is **not atomic** — two tabs or two devices can both create a directory of the same name.

This is survivable and already designed for, which is the striking part:

- The **writer lease** (`sync-v3-write-policy.js`, Web Locks) already serialises same-device tabs.
- Content-addressed identity means a duplicate directory is not an identity collision.
- `discoverDevices()` already elects a winner among generations sharing a `deviceId` and reports
  the losers as `duplicates`.
- `cleanupOwnStaleDirectories()` already removes a device's own superseded directories.

So Drive's weakest guarantee lands precisely on the case Stage 02 was built to absorb. That is not
luck — it is what content-addressing buys — but it must be *proven*, not assumed (see §23).

## 6. Google `appDataFolder` capability findings

From [Store application-specific data](https://developers.google.com/workspace/drive/api/guides/appdata)
(fetched 2026-08-27):

- A "special hidden folder that your app can use to store application-specific data, such as
  configuration files." Created automatically on first write.
- "This folder is only accessible by your app and its contents are hidden from the user and from
  other Google Drive apps."
- Supported: **create, list/search, download**.
- **Not** supported: sharing, moving files between spaces, **trashing** — these raise
  `notSupportedForAppDataFolderFiles`.
- Listing: `files.list()` with `spaces="appDataFolder"`.
- Lifecycle: "deleted when a user uninstalls your app from their My Drive. Users can also delete
  your app's data folder manually."

Mapping the BG layout onto it:

| BG need | Drive answer | Confidence |
| --- | --- | --- |
| nested directories | **Not documented for appDataFolder.** `files.create` with `mimeType: application/vnd.google-apps.folder` is the general mechanism ([folder guide](https://developers.google.com/workspace/drive/api/guides/folder)), but that guide contains **no appDataFolder example**. | **UNKNOWN — PoC question #1** |
| separate file per device replica | yes — keep it | high |
| separate manifest | yes — `device.json` stays the commit point | high |
| delete a stale file | `files.delete` (permanent). **Trashing is unsupported**, so the adapter must delete, never trash. | high |
| change detection | `changes.list` supports `spaces` with "Supported values are 'drive' and 'appDataFolder'"; "The page token doesn't expire" ([changes.list](https://developers.google.com/workspace/drive/api/reference/rest/v3/changes/list)) | high |
| browser calls | Drive API supports CORS from the browser. **The OAuth revocation endpoint does not** — revoke needs a redirect/form or a backend call. | high |
| quota (storage) | **Not authoritatively stated** for appDataFolder in current docs. Immaterial at BG's scale (kilobytes of JSON), but confirm empirically. | UNKNOWN — low risk |

**If nested folders turn out to be unsupported, this is not a blocker.** The adapter presents a
*virtual* tree over a flat namespace by encoding the path into the Drive file `name`
(`devices__Chromebook--a31f2c4e__profiles__BEAST--93bc1a7d.json`). `sync-v3-transport.js` still
sees directories and still cannot tell the difference. Design the adapter so this is a one-line
strategy switch, and the unknown stops being on the critical path.

### The scheduler assumption that does not survive the move

`CONVERGENCE_POLL_MS = 3000`. A full read pass over 3 devices costs roughly:
1 × `files.list` (100 units) + 3 × `files.list` (300) + ~12 downloads (200 each = 2,400)
≈ **2,800 quota units per pass**. At one pass per 3 s that is ~56,000 units/min against a
**325,000 units/min/user** ceiling ([usage limits](https://developers.google.com/workspace/drive/api/guides/limits)).

It fits, with under 6× headroom, while doing almost nothing useful. **Polling is free against a
local filesystem and metered against Drive.** The Drive provider must therefore supply cheap
change detection — `changes.getStartPageToken` once, then `changes.list(pageToken, spaces=appDataFolder)`
per tick (one call, 100 units) — and only run a full pass when the token reports a change. Idle
cost drops to ~2,000 units/min. Rate-limit handling is `403 User rate limit exceeded` / `429`
with exponential backoff `min(((2^n)+random_ms), maximum_backoff)`.

This is a **provider-level** concern. It does not change SyncV3 semantics: the pass still runs the
same body; the provider just decides when there is anything to run it for.

## 7. Required OAuth scopes

Least privilege, and it is a short list:

```text
https://www.googleapis.com/auth/drive.appdata
```

**That is the entire requirement.** Browser Gallery does not need the email address, a display
name, a profile picture, or any OpenID scope. Device identity is minted locally and is not derived
from an account (§4). Nothing in the sync model keys on a Google user.

Do **not** request `openid`, `email` or `profile` merely because a "Connect Google" button
conventionally shows an avatar. If a future multi-account guard needs to detect *"a different
account than last time"*, prefer the opaque `sub` claim available from the code exchange — and only
if a measured need appears.

**Verification burden — the good news.** Per
[Choose Drive API scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth),
`drive.appdata` is listed under **non-sensitive scopes** ("View and manage the app's own
configuration data in your Google Drive"). Restricted Drive scopes are `drive`, `drive.readonly`,
`drive.metadata*`, `drive.activity*`, `drive.scripts`, `drive.meet.readonly` — none of which BG
needs. **A non-sensitive scope avoids the sensitive/restricted verification path**: no demo video,
no justification review, no annual security assessment.

Consent screen: the user sees a single line to the effect of *"View and manage its own
configuration data in your Google Drive"*. That is an unusually easy thing to show someone who is
worried about their photos, and it is *literally true* — the app cannot see any other Drive file.

## 8. Authentication vs authorization

These are different operations and BG needs only one of them.

- **Authentication** ("who is this person") → OpenID Connect, `email`/`profile`. **BG does not need it.**
- **Authorization** ("may this app touch its own Drive app-data") → `drive.appdata`. **This is all BG needs.**

The customer-facing button can still read **`Connect Google`** while internally performing
authorization only. The label is honest: the user is connecting Google *storage*, not creating a
Browser Gallery account. There is no BG account, no user record, no profile — and that is worth
protecting, because it is precisely what lets the privacy copy in §17 stay true.

## 9. Browser token-model findings (Model A / B)

From [Choose an authorization model](https://developers.google.com/identity/oauth2/web/guides/choose-authorization-model)
and [Use the token model](https://developers.google.com/identity/oauth2/web/guides/use-token-model)
(both fetched 2026-08-27):

- The implicit/token model **does not issue refresh tokens**; the code model does.
- **"A user gesture such as button press or clicking on a link is required to request and obtain a
  new, valid access token."**
- **"By design, access tokens have a short lifetime."** On expiry, "obtain a new token by calling
  `requestAccessToken()` from a user-driven event such as a button press."
- **"In the Token model, an access token is not stored by the OS or browser, instead a new token is
  first obtained at page load time, or subsequently by triggering a call to `requestAccessToken()`
  through a user gesture."**
- Google's own comparison rates the token model **"Least"** on user security vs **"Most"** for the
  code model, and states: **"Authorization code flow is recommended because it provides a more
  secure flow."**

### What this means for the product promise

The intended promise is *"Connect Google once. Browser Gallery keeps synchronization working."*
The documented token model delivers, at best:

> Connect Google. Sync works for about an hour of active use. Then click again. Every reload,
> possibly click again.

That is **not** "Done For You". It is worth being blunt about it: a background convergence engine
that can only hold credentials while a human is present to click is not a background engine.

**One honest ambiguity, and it is the highest-value thing to measure.** The same page says a token
is "first obtained at page load time" *and* that a gesture is required. Whether
`requestAccessToken({ prompt: '' })` on a page whose grant already exists yields a token **without**
a click — and how often that silently fails (third-party-cookie policy, ITP, browser storage
partitioning, grant age) — is not settled by the documentation. It is settled by measurement, and
it decides whether Model B is "click hourly" or "click occasionally". See §23, Experiment 2.

Do not design Model B in on the optimistic reading. Design for the documented reading and let the
experiment upgrade it.

## 10. Authorization-code / backend findings (Model C)

From the same comparison plus
[Using OAuth 2.0 for Web Server Applications](https://developers.google.com/identity/protocols/oauth2/web-server)
and [OAuth 2.0 protocol](https://developers.google.com/identity/protocols/oauth2):

- The code model **"Requires backend platform"** for "endpoint hosting and storage".
- "After an initial user request, your platform exchanges the stored refresh token to obtain a new,
  valid access token necessary to call Google APIs." — i.e. **renewal without user interaction**.
- Refresh tokens stop working when: the user revokes access; **"The refresh token has not been used
  for six months"**; the account exceeds its live-refresh-token cap; time-based grant expiry.
- **"There is currently a limit of 100 refresh tokens per Google Account per OAuth 2.0 client ID."**
- **Critical operational trap:** a project with an external-user consent screen in **"Testing"**
  publishing status "is issued a refresh token expiring in **7 days**". BG must be **published /
  In production** — which, because `drive.appdata` is non-sensitive (§7), does *not* require
  passing sensitive-scope verification.

Model C restores the actual promise: connect once, and the device keeps syncing for as long as the
user does not revoke and does not go six months without using it.

## 11. Persistence / reconnect behaviour

| | Model A/B (token) | Model C (code + backend) |
| --- | --- | --- |
| First authorization | one consent click | one consent click |
| After ~1 h active use | **user gesture required** | silent refresh |
| After page reload | new token needed; silent acquisition unproven | silent refresh |
| Background/idle convergence | not realistic | realistic |
| After 7 days | fine | fine (if app is Published, not Testing) |
| After 6 months idle | fine | refresh token dead → one reconnect click |
| Token at rest | in JS memory only | refresh token server-side; browser holds short-lived access token only |
| Revocation by user | next call 401 | next refresh fails |

**BG's local-first contract is unaffected in every row.** Loss of authorization degrades sync to
"not syncing"; Curations, Favorites, Hidden, Tags and every Media Library fact remain fully usable
locally, exactly as they are today when a Sync Folder loses permission. That behaviour already
exists and is already tested — `mapSyncStatusCopy()` has a `permission-needed` state, and Stage 10
just added `Sync Folder chosen — not syncing yet`. A Drive provider reuses that surface rather than
inventing a new one.

## 12. New-device flow (Device B)

```text
Open Browser Gallery      → fully usable, local-only, no account
Connect Google            → consent to drive.appdata (one screen, one line)
BG lists appDataFolder    → finds existing sync-v3/devices/
Local deviceId            → already minted locally at first run; NOT from the account
First pass                → discoverDevices() sees peers; merge adopts their facts
Curations appear          → from adopted profile facts
Media Libraries appear    → from adopted libraries.json  ← the Stage 10 blocker, dissolved
Library→Curation appear   → from adopted associations.json
User picks the Media Folder on THIS device   ← still manual, still local truth
User selects the matching Media Library      ← now a real choice, because the catalog exists
Curation applies per Stage 09 rules          ← unchanged
```

**What Google authorization does and does not do here, stated precisely.** It removes the folder
ceremony and — importantly — it dissolves the Stage 10 finding that *"peer Media Libraries are
unavailable on a new device until synchronization has brought the catalog across"*. That constraint
does not disappear; it becomes **invisible**, because connecting is now one click instead of
"create a folder in Drive, name it, find it on the other device, pick the same one".

It emphatically does **not** identify the local Media Folder. Physical Folder → Media Library
remains device-local truth (Stage 08, frozen). The user still picks their folder and still says
which Media Library it represents. That invariant is not negotiable and this architecture does not
touch it.

## 13. First-device flow (Device A)

```text
Use BG locally, no account          → Curations, Favorites, Hidden, Tags all work
"Want this on your other devices?"  → [ Connect Google ]  [ Not now ]
Connect                             → consent to drive.appdata
BG writes appDataFolder             → created implicitly on first write; nothing to name
First publish                       → sync-v3/devices/<this device>/… exactly as today
```

**No Sync Folder concept ever appears.** Nothing to create, name, remember or find later. The
customer-visible vocabulary loses "Google Drive Sync Folder" entirely, along with the
Media-Folder-vs-Sync-Folder distinction that Stage 10 had to spend a Help entry, a role descriptor
and a dialog paragraph explaining.

## 14. Third-device / multi-device flow

The existing device-replica model already answers every question the task asks, unchanged:

- *Does the environment already contain other devices?* → `discoverDevices()` returns `peers[]`.
- *Is this installation new?* → `own === null` on the first pass.
- *Which peer device ids exist?* → `peers[].deviceId`, read from content.
- *Do peer names exist?* → yes: `device.json` carries an optional `label`
  (`UNKNOWN_DEVICE_LABEL` fallback). **Note for the setup-wizard question:** this is the one place
  peer device *names* exist. The Stage 10 closeout recorded that the Media Library selector has no
  peer device-name registry — a Drive/appdata transport does not change that, because the
  *Library* catalog still carries only `sourceDeviceId`. Joining the two is a separate,
  independently useful change and is **out of scope here**.
- *Anything extra for 3+ devices?* → no. Discovery is a scan of N subtrees; merge is per-fact
  last-writer-wins on the logical clock. Three devices cost three more listings per pass, which is
  exactly why §6's change-token gate matters.

## 15. Migration / coexistence with the manual Sync Folder

**Do not delete manual Sync Folder support.** It works, it is proven, and it is the only option for
a user who declines a Google account. Target state is three modes:

```text
Local only            → no account, no transport
Manual Sync Folder    → existing FSA provider  (keep)
Google Sync           → new Drive appdata provider
```

Design rules, derived from the current code:

- **One active V3 provider at a time.** `ProfileSync` is deliberately "one engine, one chain, one
  status" — its own header says a second engine would be "a second chance for two passes to overlap
  … and a second status surface for the UI to disagree with". Respect that: make the provider a
  property of the single engine, not a second engine.
- **Never double-publish one device through two transports.** Same `deviceId` publishing into two
  stores creates two divergent generations of one device, which is the one thing content-addressing
  cannot arbitrate. Switching providers must be an explicit, exclusive change.
- **Migration mints nothing.** Copy `sync-v3/devices/**` verbatim from the folder into appDataFolder.
  `deviceId`, `libraryId`, `profileId` and every logical stamp are content, not location. There is
  no re-identification step, and there must not be one.
- **Disconnecting Google** clears the provider and the stored credential. Local Curations,
  Libraries, associations and device identity are untouched — same shape as today's
  `disconnectV3()`, which "clears only the saved V3 connection and in-memory connection fields".
  Falling back to manual folder sync afterwards is then just picking a provider again.

## 16. Failure modes

| Failure | Detection | BG behaviour |
| --- | --- | --- |
| User revokes permission | 401 on next Drive call | status → needs reconnect; **local data untouched** |
| Access token expired | 401 | Model C: silent refresh. Model B: needs a gesture |
| Refresh token expired/revoked (incl. 6-month idle) | refresh fails at backend | one reconnect click |
| Wrong Google account | app-data appears empty, or contains an unexpected environment | see below |
| Multiple accounts | ditto | see below |
| appDataFolder empty | `discoverDevices()` → no peers | treated as first device — already a supported state |
| appDataFolder has existing BG state | normal discovery | join the environment |
| Corrupted BG data | manifest hash mismatch → directory "invalid" | that subtree skipped **for this pass only**; re-read next pass; nothing remembered |
| Network offline | fetch rejects | existing `offline` status; local writes continue and publish later |
| Quota / 403 / 429 | HTTP status | exponential backoff per Google guidance; pass reports, does not corrupt |
| Transient Drive 5xx | HTTP status | same |
| App authorization removed | 401/403 | same as revoke |
| App-data deleted by user | environment appears empty | **must not** be read as "peers deleted their data" — see below |
| Offline mid-write | partial files, no/old `device.json` | **already handled**: manifest is the commit point; readers see "empty" or "invalid", never partial trust |
| Two devices write concurrently | separate device subtrees | **already handled**: no device may write another's subtree; module-level guarantee |
| Two *tabs* write concurrently | same subtree | **already handled**: Web Locks writer lease |

Two that need explicit new design work, because they are genuinely new:

**Wrong / multiple accounts.** Today the user picks a folder and can see which one. With
appDataFolder the storage is invisible, so connecting the wrong account silently presents an empty
or foreign environment. Mitigation: on first successful connect, write an environment marker into
app-data (a BG-minted `environmentId`, not a Google identifier) and record it locally. If a later
connect finds a *different* `environmentId`, stop and ask rather than merging. This costs one file
and no new identity concept.

**Deleted app data must never look like deletion-of-record.** Google states users can delete the
app-data folder. An empty environment where the local device remembers peers must be treated as
*"storage was reset"*, not *"every peer was tombstoned"*. Local facts are authoritative and simply
republish. State this as an invariant before any code is written — getting it wrong destroys data
on every device.

## 17. Privacy / security analysis

The promise the product wants to make:

> Your photos and videos stay where they are.
> Google Sync stores Browser Gallery information such as Curations, Favorites, Hidden items, Tags
> and Media Library information. It does not upload your media.

**The architecture supports this literally, and the scope proves it.** With only `drive.appdata`,
Browser Gallery is *technically incapable* of reading or writing any other file in the user's
Drive — including their photos. This is a stronger guarantee than today's manual Sync Folder, where
the app holds a read-write `FileSystemDirectoryHandle` to a real user-visible folder and the
promise rests on BG's own restraint.

Verified against the transport: `sync-v3-transport.js` publishes only device manifests, profile
fact files, `associations.json` and `libraries.json`. No media provider participates in any sync
path. The existing `test-safety-reassurance.mjs` already asserts exactly this file set.

Security posture by model:
- **Model B**: access token lives in JS memory in the page. Google rates this "Least" secure. No
  long-lived credential exists anywhere, which is a real mitigation — the blast radius of an XSS is
  one hour of app-data access.
- **Model C**: the browser still only ever holds a short-lived access token; the refresh token
  lives server-side. Better on both counts, at the cost of holding a secret we must protect.

Local-first is preserved absolutely in both: no account required, no startup dependency on Google,
no local Curation depends on authorization, and losing connectivity cannot damage local data.

## 18. OAuth verification considerations

- `drive.appdata` is **non-sensitive** → **no sensitive/restricted verification path**: no demo
  video, no scope justification review, no third-party security assessment.
- The app must still have a configured consent screen, a verified domain, a privacy policy link and
  accurate branding.
- **Publishing status matters more than verification here.** An external consent screen left in
  *Testing* issues refresh tokens that **expire in 7 days** — which would make Model C behave like a
  worse Model B. Publishing is the fix and is cheap for a non-sensitive scope.
- Consent screen text is a single benign line about the app's own configuration data.
- Practical limit to respect: 100 refresh tokens per account per client id.

## 19. Decision matrix

| | **A** Manual Sync Folder (today) | **B** Browser token + appdata | **C** Code model + minimal backend + appdata | **D** Defer to native/Tauri |
| --- | --- | --- | --- | --- |
| User friction | **High** — create/name/find/repeat per device | Low first time, **recurring clicks** | **Lowest** — connect once | None now; none delivered either |
| "Done For You" quality | Poor | **Partial** | **Yes** | Deferred |
| Implementation complexity | zero (exists) | Medium (provider + GIS) | Medium-high (provider + GIS + backend) | zero now |
| Security | Good (no tokens) but broad FSA handle | Weakest token handling; narrowest scope | **Best**: narrow scope + no long-lived secret in browser | Best (OS keychain) |
| Privacy | Good | **Excellent** (appdata invisible, media unreachable) | **Excellent** | Excellent |
| Backend required | No | **No** | **Yes** (small) | No |
| Recurring cost | None | None | Low (serverless + KV) | None |
| Browser compatibility | FSA only (Chromium) | **Any modern browser** | **Any modern browser** | n/a |
| Offline / local-first | Preserved | Preserved | Preserved | Preserved |
| SyncV3 reuse | n/a | **Total** (transport untouched) | **Total** | Total |
| Migration difficulty | n/a | Low (copy subtree) | Low (copy subtree) | Low |
| Future native reuse | Low | **High** (provider + format) | **Highest** (provider + format + flow) | — |
| Expected reliability | High where FSA exists | Medium (auth gaps) | **High** | — |
| OAuth verification | None | **None** (non-sensitive) | **None** (non-sensitive, but must Publish) | Low |
| Product fit | Explains folders forever | Better, still explains re-connecting | **Matches the intended promise** | Abandons browser edition |

Notable side effect of B and C that A cannot offer: `drive.appdata` works in **any browser with
fetch**, whereas the manual Sync Folder requires File System Access — effectively Chromium.
Google Sync would make cross-device sync available on Firefox and Safari for the first time.

## 20. QUESTION 1 — Can appDataFolder replace the manually chosen Sync Folder as storage/transport?

**YES — conditional on one PoC-verifiable detail, with a designed fallback that makes it non-blocking.**

Supporting evidence:
- The transport needs six directory primitives; all are expressible as Drive calls.
- The whole Drive-facing surface funnels through one object (`devicesDir`), so the seam is a
  directory adapter, not a rewrite.
- BG's integrity model — content-addressed identity, manifest-as-commit-point, write→read-back→
  verify, per-device subtree isolation, a Web Locks writer lease — maps onto Drive's weaker
  guarantees *better than a filesystem-shaped design would*, because it never relied on filesystem
  atomicity in the first place.
- Merge logic remains authoritative and **unchanged**. Google stores bytes; it decides nothing.
- Change detection exists (`changes.list` + non-expiring page tokens over `spaces=appDataFolder`).

The condition: **nested folders inside appDataFolder are undocumented.** If unsupported, the
adapter presents a virtual tree over path-encoded flat names and the transport cannot tell.
Either way Q1 resolves YES.

Two provider-level obligations that are *not* semantic changes but must be built: get-or-create
must be query-then-create (Drive permits duplicate names, and the comparison is case-sensitive
where `resolveOwnDirectoryName` lower-cases), and deletion must use `files.delete` because trashing
is unsupported in this space.

## 21. QUESTION 2 — Can the browser authorize persistently enough to feel like "connect once and forget"?

**NO for a pure browser app (Model B). YES with a minimal backend (Model C).**

Google's own documentation is unambiguous: the token model issues no refresh token, access tokens
are short-lived, and **"A user gesture such as button press or clicking on a link is required to
request and obtain a new, valid access token."** Google explicitly recommends the code model and
rates the token model least secure.

Quantified recurring friction for Model B, on the documented reading: **one click per access-token
lifetime of active use (~1 hour), plus one per page load.** For a gallery app someone leaves open
while browsing photos for an evening, that is several interruptions — and, worse, sync silently
stops between them, which is exactly the failure shape Stage 10 just spent a whole pass eliminating
from the Sync UI.

The honest caveat, and it is the reason Experiment 2 exists: the same page also says a token is
"first obtained at page load time", which leaves open whether an existing grant permits a
gestureless acquisition via `prompt: ''`. If measurement shows that works reliably across browsers
and survives reloads, Model B moves from "click hourly" to "click rarely" and becomes a credible
*interim* shipping state. It still would not survive an idle background tab, and it still would not
be "forget about it".

**Q1 is YES while Q2 is only PARTIAL for the no-backend option. That asymmetry is the central
finding of this spike.**

## 22. ONE recommended browser direction

> **Build the Drive `appDataFolder` transport behind a directory-shaped provider seam, and pair it
> with the OAuth authorization-code model served by a minimal serverless token broker (Option C).
> Keep the manual Sync Folder as a peer provider indefinitely.**

Why this one:

- It is the only option that actually delivers the stated promise (§21).
- The expensive, risky part — the transport — is **identical across B, C and native**. Choosing C
  costs nothing in transport work and buys the persistence the product asked for.
- `drive.appdata` is non-sensitive, so the usual reason to fear a Google integration (verification)
  does not apply.
- BG sync data never touches our server; only a refresh token does.
- It makes cross-device sync work outside Chromium for the first time.
- The local-first, no-account character is fully preserved: users who never press *Connect Google*
  never encounter a backend, an account, or a network dependency.

**Sequencing matters more than the choice.** Build and prove the provider seam *first* (Experiment 1),
because it is auth-agnostic. Measure the auth behaviour *second* (Experiment 2). Only then commit
backend effort. If Experiment 2 surprises us favourably, Model B becomes a legitimate no-backend
interim release on the same transport.

### If a backend is built — the minimum

| Aspect | Specification |
| --- | --- |
| Endpoints | `POST /auth/exchange` (code + PKCE verifier → session), `POST /auth/token` (session → short-lived Drive access token), `POST /auth/disconnect` (revoke + delete) |
| Secrets held | OAuth client secret; per-user refresh tokens |
| Refresh-token storage | Serverless KV, encrypted at rest, keyed by an opaque session id |
| Account mapping | Minimal — opaque session ↔ refresh token. Google `sub` only if a multi-account guard needs it |
| Does BG sync data transit/store on our server? | **No. Never.** Curations, Favorites, Hidden, Tags, Libraries, associations go browser → Drive directly |
| Drive calls from browser? | **Yes** — Drive API supports CORS. The backend brokers credentials only |
| Serverless viable? | Yes (Cloudflare Workers + KV, or equivalent). Three endpoints, no database |
| Operational burden | Low: rotate the client secret, keep the consent screen **Published** (not Testing — 7-day refresh tokens) |
| If the backend is unavailable | New connects fail; existing access tokens work until expiry; then sync stops with an honest status. **Local Browser Gallery is entirely unaffected**, and manual Sync Folder still works |

## 23. Smallest next proof-of-concept

Two experiments, strictly ordered. **Experiment 1 needs no Google account, no credential, no
network, and no production change** — which is why it goes first.

### EXPERIMENT 1 — Provider-seam conformance harness (no Google involvement)

**Question:** can `sync-v3-transport.js` run *unmodified* against a non-FSA directory provider,
including one that reproduces Drive's hostile semantics?

**Build (test-tree only, e.g. `tools/lib/memory-sync-directory.mjs` + `tools/test-sync-provider-conformance.mjs`):**
1. `MemorySyncDirectory` — implements the six primitives over plain Maps.
2. `DriveShapedSyncDirectory` — same interface, deliberately hostile:
   - `getDirectoryHandle(name,{create:true})` is query-then-create with an **injectable interleave
     point**, so two concurrent creates can be forced to both succeed → duplicate names;
   - names are **case-sensitive**;
   - `entries()` may return a **stale listing** for N ms after a write (eventual consistency);
   - `removeEntry` is permanent (no trash);
   - every op can be told to fail with 401 / 403 / 429 / 5xx.
3. Run the **existing** `test-syncv3-*.mjs` suites against both, by injecting the provider where
   they currently build an FSA virtual directory.

**Acceptance criteria — all must hold:**
- **A1.** Every existing `test-syncv3-*` suite passes against `MemorySyncDirectory` with
  `sync-v3-transport.js` **byte-identical to `3c93e88`**. Any required edit is a finding, and the
  seam must move rather than the transport.
- **A2.** Under forced duplicate-directory creation, `discoverDevices()` still elects exactly one
  generation per `deviceId` and reports the rest in `duplicates` — no device is lost, no identity
  merges.
- **A3.** With a stale listing window, a pass never reports a peer's directory as valid-but-partial:
  it is `empty`, `invalid`, or fully valid. (This is the manifest-commit-point property; prove it,
  don't assume it.)
- **A4.** A publish interrupted after data files but before `device.json` leaves peers reading the
  *previous* generation, and the next pass recovers with no user action.
- **A5.** 401/403/429/5xx at any single operation fails the pass cleanly — status reported, **zero
  local mutation**, next pass recovers.
- **A6.** Case-sensitivity: two directories differing only in case do not collide into one device,
  and `resolveOwnDirectoryName`'s lower-cased occupancy check does not strand a device.
- **A7.** All Stage 09 suites remain green, untouched.

**Why this is the right first experiment:** it answers the only question that could invalidate the
whole direction — *is the transport genuinely portable?* — for zero external cost, and it produces
the exact adapter contract the Drive provider must satisfy.

### EXPERIMENT 2 — Auth persistence measurement (throwaway, outside the repo)

**Question:** how much recurring friction does Model B actually impose?

Requires the product owner to create one OAuth client id for a throwaway origin. **The architect
does not create Google resources; Codex should not either without explicit instruction.**

**Build:** a single disposable static page (outside `~/gallerytest`) that requests only
`drive.appdata`, then logs, with timestamps:
1. time from consent to first token, and the token's actual `expires_in`;
2. whether `requestAccessToken({ prompt: '' })` returns a token **without** a user gesture
   (a) immediately, (b) after a reload, (c) after 65 minutes;
3. the same three on Chrome, Firefox and Safari, and once with third-party cookies blocked;
4. a `files.list(spaces=appDataFolder)` round trip, to confirm CORS end to end;
5. **whether a folder can be created inside appDataFolder** (`mimeType:
   application/vnd.google-apps.folder`, `parents:['appDataFolder']`) and whether a file can then be
   created with that folder as parent and listed — **this is PoC question #1 from §6**.

**Acceptance criteria:**
- **B1.** A definite yes/no on gestureless renewal per browser, with counts over an 8-hour session.
- **B2.** Measured token lifetime, not assumed.
- **B3.** A definite yes/no on nested folders in appDataFolder. If no, confirm the flat
  path-encoded naming works and note any name-length limit.
- **B4.** Confirmation that `changes.getStartPageToken` + `changes.list(spaces=appDataFolder)`
  reports a change made by a second client.
- **B5.** A one-line verdict: *"Model B costs the user N interactions per 8-hour session."*

Only after B5 should backend work start.

## 24. What NOT to build yet

- No Google script tags in `index.html`; no GIS in the production bundle.
- No OAuth credentials, no client secret in the repo, no Cloud Console changes.
- No backend, no hosting, no KV.
- **No change to `sync-v3-transport.js`, `sync-v3.js`, `profile-sync.js` or `profile-sync-store.js`
  in Experiment 1** — the seam is exercised via injection from the test tree. Production plumbing
  comes only after A1–A7 pass.
- No Drive **media** provider: no Drive browsing, streaming, Picker, or account indexing. Explicitly
  out of scope.
- No setup wizard, no spotlight overlay, no new setup state.
- No removal of manual Sync Folder support.
- No new customer-facing copy yet — the Stage 10 vocabulary is settled and should not churn until
  the transport decision is real.

## 25. Future Tauri / native reuse

Reuse is high, and it is highest for exactly the piece Experiment 1 builds.

| Piece | Native reuse |
| --- | --- |
| Provider seam (six primitives) | **Total.** Native adds a third provider (real filesystem) beside FSA and Drive |
| Drive appdata adapter | **Total.** Same REST API, same file format |
| app-data file format (`sync-v3/**`) | **Total.** It is content, not location — a native client joins an environment a browser created |
| Account-neutral sync state | **Total.** `deviceId` is locally minted and never account-derived, so no identity rework |
| Migration logic | **Total.** Copy a subtree; mint nothing |
| Auth flow | **Partial.** Native uses the installed-app flow with PKCE and a loopback redirect, and can hold the refresh token in OS secure storage — **which removes the need for our backend entirely on native** |
| Scheduler / change detection | **Total** |

The strategic point: **Model C's backend is a browser-only tax.** Native eliminates it while reusing
every other component. That is an argument for keeping the backend as thin as the §22 table
specifies — three endpoints and a KV — rather than letting it accrete into a service we would then
have to keep running for a platform that does not need it.

## 26. Does Google authorization materially reduce the need for a setup wizard?

**Partially — it removes the worst step, and it removes it from the *hardest* moment.**

Eliminated outright as customer concepts: *Google Drive Sync Folder*, naming it, finding it again,
choosing the same one on each device, Media-Folder-vs-Sync-Folder confusion, and the
`v3Configured`-vs-active-mode split (a Drive provider is either connected or not — the state that
produced the Stage 10 "Change Sync Folder does nothing" defect stops existing).

**Still requires guidance, on every device, forever:**
1. Choosing a **Media Folder** (a real filesystem permission grant; Google cannot help).
2. Selecting/creating the **Media Library** for that folder (device-local truth, Stage 08, frozen).
3. Choosing/creating a **Curation** where no obvious default exists.
4. Understanding *Media Folder ≠ Media Library ≠ Curation* — the conceptual core, untouched by
   transport.

So a guided setup is still worth building, but it gets **materially smaller and much better
sequenced**: after *Connect Google*, the catalog is already present, so step 2 becomes *"which of
these existing Media Libraries is this folder?"* — a recognition task — instead of *"create one and
hope you pick the same name later"*. That is precisely the Stage 10 finding (peer Libraries
undiscoverable before sync) turned from a constraint into an advantage. Postponing the wizard until
after this decision was the right call.

## 27. Confirmation

- **No production code was modified.** `git status` is clean at `3c93e88`.
- **Nothing was committed. Nothing was pushed. Nothing was reset or discarded.**
- No experimental module, dependency, Google credential or Cloud resource was created.
- The only file written by this pass is this report.

---

GOOGLE APP-DATA TRANSPORT:
**CONDITIONAL** — YES on the evidence; conditional only on Experiment 1's A1–A7 and the nested-folder
question, which has a designed flat-namespace fallback that keeps the answer YES either way.

ONE-TIME BROWSER AUTH EXPERIENCE:
**CONDITIONAL** — NO with a pure browser token model (Google requires a user gesture per token and
issues no refresh token); YES with the authorization-code model plus a minimal backend.

BACKEND REQUIRED FOR RECOMMENDED DESIGN:
**YES** — three serverless endpoints and a KV. Browser Gallery sync data never transits or is stored
on it; it brokers credentials only, and native will not need it at all.

MANUAL SYNC FOLDER CAN EVENTUALLY BE OPTIONAL:
**CONDITIONAL** — it can stop being the *default* and stop appearing in first-run UI, but keep it as a
peer provider: it is the only cross-device option for a user who declines a Google account, and it
is proven.

RECOMMENDED BROWSER DIRECTION:
Drive `appDataFolder` transport behind a directory-shaped provider seam, authorized by the OAuth
authorization-code model via a minimal serverless token broker, with the manual Sync Folder retained
as a peer provider. Build and prove the seam first — it is auth-agnostic and reused by every option
including native.

NEXT EXPERIMENT:
Experiment 1 — the provider-seam conformance harness. Run the existing `test-syncv3-*` suites
unmodified against an in-memory directory provider and a deliberately hostile "Drive-shaped" one
(duplicate names, case-sensitive, stale listings, permanent deletes, injectable 401/403/429/5xx).
Zero Google involvement, zero production change; it either proves the transport is portable or kills
the direction cheaply.

SETUP WIZARD IMPACT:
Removes the Sync Folder entirely from customer vocabulary and dissolves the
"peer Media Libraries are invisible before sync" constraint. Still remaining, on every device:
choosing the Media Folder, selecting the Media Library it represents, choosing a Curation, and
teaching Media Folder ≠ Media Library ≠ Curation. The wizard stays worth building — smaller, and
sequenced so that selecting a Media Library becomes recognition rather than invention.
