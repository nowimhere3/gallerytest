// [APP-PREFERENCES] Global application preferences — Playback (interval,
// shuffle, skip duplicates, loop playlist, fill panel), Micro-Arcade,
// Presentation's Ghost Opacity "remember" state/value, local onboarding, and
// Startup Media policy (N6-4). These are NOT Profile curation
// data: they stay constant across Profile switches, are never part of
// Profile export/import/merge/replace, and deliberately live in their own
// tiny database rather than piggybacking on ProfileStore's or the FSA
// library registry's — same reasoning both of those already use for
// staying separate from each other (see library-registry.js's header).
//
// One module owns this database; callers (main.js) never call
// indexedDB.open() directly for this data.
const DATABASE_NAME = "loop-browser-gallery-preferences";
const DATABASE_VERSION = 1;
const STORE_NAME = "preferences";
const RECORD_ID = "global";

const DEFAULT_PLAYBACK = {
  intervalSeconds: 5,
  shuffle: true,
  // [PLAYBACK / SHUFFLE-MODES / PREFERENCE]
  // Compatibility default: this is the non-repeating cycle Browser Gallery
  // shipped before the preference existed.
  shuffleMode: "shuffle-loop",
  skipDuplicates: false,
  loopPlaylist: true,
  // [UI-REDESIGN / Stage 3] `fillPanel: true` retired with the checkbox it
  // backed. Deliberately not replaced in place: the setting it represented
  // ("Start should also go fullscreen") is now the explicit `Fill ⛶` button,
  // which is an action, not something to remember. Records saved earlier may
  // still carry a `fillPanel` key; normalizeRecord() below simply stops
  // copying it forward, so it disappears on the next write with no migration
  // and no data loss for anything else on the record.
  //
  // Whether deliberately entering Fill Panel should
  // start playback when nothing is playing. Default ON.
  //
  // Additive by design: normalizeRecord() below defaults every field
  // individually, so a record saved before this key existed simply reads
  // `undefined` here and picks up this default. DATABASE_VERSION is
  // deliberately NOT bumped — the object store's shape has not changed, only
  // the record's, and records are reshaped on every read. There is no
  // migration to run and nothing is rewritten or discarded.
  autoplayOnFill: true,
};

// [PM-TOOLBAR-OPACITY] `ghostOpacityPercent`/`rememberGhostOpacity` are the
// pre-existing implementation of what the customer now sees labeled
// "Toolbar Opacity" — its storage field names deliberately were NOT renamed
// (this mechanism predates the rename and already governed the correct
// resting-toolbar behavior; only its on-screen label changed). `hoverOpacityPercent`
// defaults to 100 because it replaces what used to be a hardcoded 100%
// hover state — a customer who never touches the new Hover Opacity slider
// sees exactly the same hover behavior as before.
const DEFAULT_PRESENTATION = {
  rememberGhostOpacity: true,
  ghostOpacityPercent: 15,
  rememberHoverOpacity: true,
  hoverOpacityPercent: 100,
};

const DEFAULT_MICRO_ARCADE = {
  // [PLAYBACK / MICRO-ARCADE / ANIMATION-ORDER]
  animationOrder: "true-random",
};

const DEFAULT_ONBOARDING = {
  profileSyncIntroSeen: false,
};

// [STARTUP-MEDIA / N6-4] [STREAMLOOP-INTEGRATION / N6-9]
// [WHY: device-local, like every other section here — a startup policy is a
//  property of THIS machine, not a synchronized Curation fact. Different
//  devices may reasonably start differently. Not stored on the library row
//  either: library-registry.js's header states it "ONLY persists
//  identity/metadata", and a startup policy is neither — keeping it here
//  also means removing a folder from Recents can never silently rewrite a
//  customer's startup choice (see normalizeStartupEligibleLibraryIds()
//  below, which deliberately never prunes).]
//
// [WHY / N6-9: `autoFillPanel` lives HERE, beside the policy it acts on,
//  rather than in a separate section — N6-7 originally kept it separate
//  because "which folder loads" and "what BG does after" were different
//  questions shown in different UI locations. N6-9's Advanced Settings
//  cleanup now co-locates a context's ENTIRE startup+post-load
//  configuration in one place (Startup Media for browser, StreamLoop
//  Integration for streamloop), so nesting it here mirrors the UI exactly
//  and is the smallest additive change — extending an existing per-context
//  object rather than inventing a second top-level "browser integration"
//  section merely for symmetry with the one this replaces. Defaults OFF:
//  entering Fill Panel is a screen takeover the customer did not just click
//  a button for, so — unlike `autoplayOnFill` above, which only applies
//  once Fill Panel is already being entered deliberately — this default
//  stays conservative for both contexts.]
const DEFAULT_STARTUP_POLICY = {
  policy: "last-used",
  eligibleLibraryIds: [],
  autoFillPanel: false,
};

// [STREAMLOOP-INTEGRATION / N6-6] [STREAMLOOP-INTEGRATION / N6-9]
// BREADCRUMBS — IS: two fully independent startup records, one per launch
// context. "Normal Browser Gallery" and "When launched by StreamLoop" each
// get their own policy, their own eligible-folder pool, AND their own
// post-load Auto Fill preference — changing one context's value never
// touches the other's. Both blocks stay visible/editable in Advanced
// Settings regardless of which context the current tab was actually
// launched in; only main.js's boot-time decision (which record it reads
// before calling decideStartupMedia(), and before deciding whether to Auto
// Fill) depends on the live launch context. See
// src/runtime/launch-context.js.
//
// BREADCRUMBS — IS: a startup policy may explicitly choose no automatic
// media load at all (`"off"` — see startupPolicy() below). This is a real,
// persisted, independently-set-per-context choice, not merely an ephemeral
// UI state — see normalizeStartupSection()'s own comment for exactly how a
// context's saved Auto Fill value survives untouched while its policy is
// "off".
const DEFAULT_STARTUP = {
  browser: { ...DEFAULT_STARTUP_POLICY },
  streamloop: { ...DEFAULT_STARTUP_POLICY },
};

// Exposed so main.js can apply the same built-in fallback when
// `rememberGhostOpacity` is false — in that case the stored
// `ghostOpacityPercent` is intentionally ignored (it may be a stale value
// left over from before the user unchecked "Remember this value"), and the
// UI must fall back to this constant rather than that stored number.
export const DEFAULT_GHOST_OPACITY_PERCENT = DEFAULT_PRESENTATION.ghostOpacityPercent;
// Same reasoning as DEFAULT_GHOST_OPACITY_PERCENT above, for Hover Opacity.
export const DEFAULT_HOVER_OPACITY_PERCENT = DEFAULT_PRESENTATION.hoverOpacityPercent;

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open the app preferences database."));
  });
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("App preferences request failed."));
  });
}

function completeTransaction(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error("App preferences operation failed."));
    transaction.onabort = () => reject(transaction.error || new Error("App preferences operation was aborted."));
  });
}

function clampInterval(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return DEFAULT_PLAYBACK.intervalSeconds;
  const rounded = Math.round(num);
  if (rounded < 1 || rounded > 300) return DEFAULT_PLAYBACK.intervalSeconds;
  return rounded;
}

// Generic 0-100 percent clamp shared by Ghost/Toolbar/Hover Opacity — each
// caller passes its own fallback so an invalid/out-of-range stored value
// falls back to THAT slider's own default, never another slider's.
function clampPercent(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  const rounded = Math.round(num);
  if (rounded < 0 || rounded > 100) return fallback;
  return rounded;
}

function clampOpacity(value) {
  return clampPercent(value, DEFAULT_PRESENTATION.ghostOpacityPercent);
}

function bool(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function shuffleMode(value) {
  return value === "true-random" ? "true-random" : "shuffle-loop";
}

// [STARTUP-MEDIA / N6-4] [STREAMLOOP-INTEGRATION / N6-9] Any unrecognized
// value — including a policy string written by a future version this build
// doesn't know about — falls back to today's proven default, same reasoning
// shuffleMode()/arcadeAnimationOrder() already use above.
//
// [WHY: `"off"` ("Do not load media automatically" in the UI) is reachable
//  ONLY by explicit customer selection — it is never the fallback for
//  missing/malformed/unrecognized data, which still falls back to
//  "last-used" exactly as before. This is what makes "absence of the new
//  startup OFF value naturally preserves existing startup behavior" true: a
//  record with no opinion about this field, or a genuinely corrupt one,
//  behaves exactly as it did before "off" existed.]
function startupPolicy(value) {
  return value === "random-remembered" || value === "random-selected" || value === "off" ? value : "last-used";
}

// [WHY: stale ids are tolerated, never pruned here — decideStartupMedia()
//  (boot-restore.js) simply skips an id that no longer matches a row at
//  decision time. Eagerly rewriting this set when the registry changes would
//  be a background tidy-up silently discarding a customer's explicit choice,
//  the same reasoning N6's P6 already established for Recents.]
function normalizeStartupEligibleLibraryIds(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  for (const entry of value) {
    if (typeof entry === "string" && entry) seen.add(entry);
  }
  return [...seen];
}

// [STREAMLOOP-INTEGRATION / N6-6] [STREAMLOOP-INTEGRATION / N6-9]
// [WHY: `autoFillDefault` is a per-call injected fallback, not a hardcoded
//  constant, so ONE normalizer can serve both contexts even though only
//  StreamLoop's ever had a value living somewhere else before N6-9 (see
//  normalizeStartupContexts()'s legacy-migration parameter below). Once a
//  section's OWN `autoFillPanel` field is present (a real boolean), it
//  always wins over the injected default — this is what makes a customer's
//  saved true/false value survive untouched while their policy is "off":
//  nothing here ever reads or reacts to `policy` when deciding
//  `autoFillPanel`, so switching policy to "off" and back can never
//  silently flip or drop this field.]
function normalizeStartupSection(value, autoFillDefault = DEFAULT_STARTUP_POLICY.autoFillPanel) {
  const source = value && typeof value === "object" ? value : {};
  return {
    policy: startupPolicy(source.policy),
    eligibleLibraryIds: normalizeStartupEligibleLibraryIds(source.eligibleLibraryIds),
    autoFillPanel: bool(source.autoFillPanel, autoFillDefault),
  };
}

// [WHY: a record written by N6-4 stores `startup: { policy, eligibleLibraryIds }`
//  directly — no `browser`/`streamloop` keys. That customer's existing choice
//  becomes their Normal Browser Gallery policy verbatim; StreamLoop starts at
//  today's safe default ("last-used", empty pool) rather than inheriting it,
//  since nobody had a StreamLoop-specific choice before this slice existed.
//  Detected structurally (no `browser`/`streamloop` key present, but a
//  `policy`/`eligibleLibraryIds` key is) rather than by a schema-version
//  bump — same reasoning autoplayOnFill's own comment above already uses:
//  the object store's shape hasn't changed, only the record's, and every
//  record is reshaped on every read.]
//
// [WHY / N6-9: `legacyStreamloopAutoFillPanel` migrates the N6-7/N6-8
//  top-level `streamloopIntegration.autoFillPanel` value (see
//  normalizeRecord() below, which reads it one last time and no longer
//  writes it back out — same retirement pattern `fillPanel` under
//  `playback` above already established) into its new home at
//  `startup.streamloop.autoFillPanel`. It is passed ONLY as streamloop's
//  fallback default — browser's Auto Fill has no prior location to migrate
//  from and correctly defaults to plain `false`. Once ANY write happens
//  under the new location, `normalizeStartupSection()`'s own `source.autoFillPanel`
//  check above wins forever after, so this migration path is naturally a
//  no-op for an already-migrated record.]
function normalizeStartupContexts(startupSource, legacyStreamloopAutoFillPanel) {
  const isLegacyFlatShape =
    startupSource &&
    typeof startupSource === "object" &&
    !("browser" in startupSource) &&
    !("streamloop" in startupSource) &&
    ("policy" in startupSource || "eligibleLibraryIds" in startupSource);

  if (isLegacyFlatShape) {
    return {
      browser: normalizeStartupSection(startupSource),
      streamloop: normalizeStartupSection(undefined, legacyStreamloopAutoFillPanel),
    };
  }

  const source = startupSource && typeof startupSource === "object" ? startupSource : {};
  return {
    browser: normalizeStartupSection(source.browser),
    streamloop: normalizeStartupSection(source.streamloop, legacyStreamloopAutoFillPanel),
  };
}

function arcadeAnimationOrder(value, temporaryShuffleValue) {
  if (value === "sequential" || value === "true-random" || value === "shuffle-loop") return value;
  // Minimal compatibility for the temporary boolean used by the preceding
  // development pass. The obsolete key is omitted from normalized output.
  if (value === undefined && typeof temporaryShuffleValue === "boolean") {
    return temporaryShuffleValue ? "true-random" : "sequential";
  }
  return DEFAULT_MICRO_ARCADE.animationOrder;
}

// Missing/malformed/out-of-range fields fall back to defaults individually
// (rather than discarding the whole record) so a single corrupt field can
// never break startup or silently reset unrelated preferences. Also the
// single place that shapes what gets written back, so unknown legacy junk
// on a stored record never round-trips forward.
function normalizeRecord(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const playbackSource = source.playback && typeof source.playback === "object" ? source.playback : {};
  const presentationSource = source.presentation && typeof source.presentation === "object" ? source.presentation : {};
  const microArcadeSource = source.microArcade && typeof source.microArcade === "object" ? source.microArcade : {};
  const onboardingSource = source.onboarding && typeof source.onboarding === "object" ? source.onboarding : {};
  const startupSource = source.startup && typeof source.startup === "object" ? source.startup : {};
  // [STREAMLOOP-INTEGRATION / N6-9] Read-only migration source: N6-7/N6-8
  // stored StreamLoop's Auto Fill preference in a separate top-level
  // `streamloopIntegration` section. It now lives at
  // `startup.streamloop.autoFillPanel` instead (see normalizeStartupContexts()
  // above) — this is consulted only as that field's fallback default, and
  // `streamloopIntegration` itself is no longer written back out below, so it
  // disappears from storage on the next write, same retirement pattern
  // `fillPanel` under `playback` above already established.
  const streamloopIntegrationSource =
    source.streamloopIntegration && typeof source.streamloopIntegration === "object" ? source.streamloopIntegration : {};
  const legacyStreamloopAutoFillPanel = bool(streamloopIntegrationSource.autoFillPanel, DEFAULT_STARTUP_POLICY.autoFillPanel);

  return {
    id: RECORD_ID,
    schemaVersion: 1,
    playback: {
      intervalSeconds: clampInterval(playbackSource.intervalSeconds ?? DEFAULT_PLAYBACK.intervalSeconds),
      shuffle: bool(playbackSource.shuffle, DEFAULT_PLAYBACK.shuffle),
      shuffleMode: shuffleMode(playbackSource.shuffleMode),
      skipDuplicates: bool(playbackSource.skipDuplicates, DEFAULT_PLAYBACK.skipDuplicates),
      loopPlaylist: bool(playbackSource.loopPlaylist, DEFAULT_PLAYBACK.loopPlaylist),
      // [UI-REDESIGN / Stage 3] `fillPanel` is intentionally absent — see
      // DEFAULT_PLAYBACK above. This function is documented as the single
      // place that shapes what gets written back, so omitting it here is
      // exactly how a retired key stops round-tripping.
      autoplayOnFill: bool(playbackSource.autoplayOnFill, DEFAULT_PLAYBACK.autoplayOnFill),
    },
    presentation: {
      // Displayed on screen as "Toolbar Opacity" — see DEFAULT_PRESENTATION's
      // own comment above for why the storage field names stay "ghost".
      rememberGhostOpacity: bool(presentationSource.rememberGhostOpacity, DEFAULT_PRESENTATION.rememberGhostOpacity),
      ghostOpacityPercent: clampOpacity(presentationSource.ghostOpacityPercent ?? DEFAULT_PRESENTATION.ghostOpacityPercent),
      // [PM-TOOLBAR-OPACITY] Independent from Toolbar Opacity above: Hover
      // Opacity is the PM toolbar's temporary opacity while the pointer is
      // over it, with its own Remember checkbox and its own fallback
      // default, exactly like Toolbar Opacity's own pair of fields.
      rememberHoverOpacity: bool(presentationSource.rememberHoverOpacity, DEFAULT_PRESENTATION.rememberHoverOpacity),
      hoverOpacityPercent: clampPercent(
        presentationSource.hoverOpacityPercent ?? DEFAULT_PRESENTATION.hoverOpacityPercent,
        DEFAULT_PRESENTATION.hoverOpacityPercent,
      ),
    },
    microArcade: {
      animationOrder: arcadeAnimationOrder(microArcadeSource.animationOrder, microArcadeSource.shuffle),
    },
    // [SYNCV3 / STAGE-10 / CONTEXTUAL-FIRST-USE]
    // [WHY: introduction progress is a preference of this browser/device, not
    // Profile or Library data. Keeping it in app preferences makes it durable
    // without allowing it into any SyncV3 replica or shared identity store.]
    onboarding: {
      profileSyncIntroSeen: bool(onboardingSource.profileSyncIntroSeen, DEFAULT_ONBOARDING.profileSyncIntroSeen),
    },
    // [STARTUP-MEDIA / N6-4] [STREAMLOOP-INTEGRATION / N6-6] [STREAMLOOP-INTEGRATION / N6-9]
    // `streamloopIntegration` is deliberately NOT included in this returned
    // record any more — see `legacyStreamloopAutoFillPanel` above for where
    // its one remaining value goes on the way out.
    startup: normalizeStartupContexts(startupSource, legacyStreamloopAutoFillPanel),
  };
}

function defaultPreferences() {
  return normalizeRecord(null);
}

// Serializes every read-modify-write. Without this, two saves fired close
// together (e.g. the Remember checkbox's own `change` immediately followed
// by the slider's `change`) could each open their own read of the record
// before the other's write lands, and whichever write completes last would
// silently overwrite the other's field with a stale copy. Chaining through
// one promise means each save's read always reflects the prior save.
let writeQueue = Promise.resolve();

function enqueueWrite(operation) {
  const result = writeQueue.then(operation, operation);
  writeQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/**
 * Loads the current global preferences, merged with defaults. Never
 * throws — an IndexedDB failure (unsupported, blocked, corrupt) logs a
 * warning and resolves to the built-in defaults so Playback/Ghost controls
 * remain usable for the current session.
 */
export async function loadPreferences() {
  try {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(STORE_NAME, "readonly");
      const record = await requestToPromise(transaction.objectStore(STORE_NAME).get(RECORD_ID));
      await completeTransaction(transaction);
      return normalizeRecord(record);
    } finally {
      database.close();
    }
  } catch (error) {
    console.warn("[app-preferences] Could not load saved preferences; using built-in defaults.", error);
    return defaultPreferences();
  }
}

async function readCurrentRecord(database) {
  const transaction = database.transaction(STORE_NAME, "readonly");
  const record = await requestToPromise(transaction.objectStore(STORE_NAME).get(RECORD_ID));
  await completeTransaction(transaction);
  return normalizeRecord(record);
}

async function writeRecord(database, record) {
  const transaction = database.transaction(STORE_NAME, "readwrite");
  transaction.objectStore(STORE_NAME).put(record);
  await completeTransaction(transaction);
}

// Read-modify-write against a single named section (`playback`, `presentation`,
// `microArcade`, or `onboarding`) so saving one preference can never erase a sibling
// preference (in the same section or the other one) that this call didn't
// touch.
function savePartial(section, partial) {
  return enqueueWrite(async () => {
    try {
      const database = await openDatabase();
      try {
        const current = await readCurrentRecord(database);
        const merged = normalizeRecord({
          ...current,
          [section]: { ...current[section], ...partial },
        });
        await writeRecord(database, merged);
        return merged;
      } finally {
        database.close();
      }
    } catch (error) {
      console.warn(`[app-preferences] Could not save ${section} preferences.`, error);
      return null;
    }
  });
}

export function savePlaybackPreferences(partial) {
  return savePartial("playback", partial);
}

export function savePresentationPreferences(partial) {
  return savePartial("presentation", partial);
}

export function saveMicroArcadePreferences(partial) {
  return savePartial("microArcade", partial);
}

export function saveOnboardingPreferences(partial) {
  return savePartial("onboarding", partial);
}

// [STREAMLOOP-INTEGRATION / N6-6]
// [WHY: savePartial() only merges ONE level deep — `{...current[section],
//  ...partial}`. Handed a `browser`/`streamloop` sub-object directly as
//  `partial`, it would REPLACE that whole sub-object, silently dropping
//  whichever of policy/eligibleLibraryIds the caller didn't include. This
//  function does its own two-level read-merge instead, so saving one field
//  in one context can never clobber a sibling field in the SAME context or
//  touch the OTHER context at all. `context` is a plain string the caller
//  passes explicitly ("browser" or "streamloop") — never the live
//  launchContext reinterpreted, since a customer editing Advanced Settings
//  from an ordinary browser tab must still be able to set the StreamLoop
//  pool.]
export function saveStartupPreferences(context, partial) {
  const key = context === "streamloop" ? "streamloop" : "browser";
  return enqueueWrite(async () => {
    try {
      const database = await openDatabase();
      try {
        const current = await readCurrentRecord(database);
        const merged = normalizeRecord({
          ...current,
          startup: { ...current.startup, [key]: { ...current.startup[key], ...partial } },
        });
        await writeRecord(database, merged);
        return merged;
      } finally {
        database.close();
      }
    } catch (error) {
      console.warn(`[app-preferences] Could not save startup (${key}) preferences.`, error);
      return null;
    }
  });
}
