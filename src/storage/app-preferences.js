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

const DEFAULT_PRESENTATION = {
  rememberGhostOpacity: true,
  ghostOpacityPercent: 15,
};

const DEFAULT_MICRO_ARCADE = {
  // [PLAYBACK / MICRO-ARCADE / ANIMATION-ORDER]
  animationOrder: "true-random",
};

const DEFAULT_ONBOARDING = {
  profileSyncIntroSeen: false,
};

// [STARTUP-MEDIA / N6-4]
// [WHY: device-local, like every other section here — a startup policy is a
//  property of THIS machine, not a synchronized Curation fact. Different
//  devices may reasonably start differently. Not stored on the library row
//  either: library-registry.js's header states it "ONLY persists
//  identity/metadata", and a startup policy is neither — keeping it here
//  also means removing a folder from Recents can never silently rewrite a
//  customer's startup choice (see normalizeStartupEligibleLibraryIds()
//  below, which deliberately never prunes).]
const DEFAULT_STARTUP_POLICY = {
  policy: "last-used",
  eligibleLibraryIds: [],
};

// [STREAMLOOP-INTEGRATION / N6-6]
// BREADCRUMBS — IS: two fully independent startup policy records, one per
// launch context. "Normal Browser Gallery" and "When launched by StreamLoop"
// each get their own policy AND their own eligible-folder pool — checking a
// folder for one context never touches the other's set. Both blocks stay
// visible/editable in Advanced Settings regardless of which context the
// current tab was actually launched in; only main.js's boot-time decision
// (which record it reads before calling decideStartupMedia()) depends on
// the live launch context. See src/runtime/launch-context.js.
const DEFAULT_STARTUP = {
  browser: { ...DEFAULT_STARTUP_POLICY },
  streamloop: { ...DEFAULT_STARTUP_POLICY },
};

// [STREAMLOOP-INTEGRATION / N6-7]
// [WHY: a NEW top-level section, deliberately not nested inside
//  `startup.streamloop`. `startup.streamloop` answers "which folder loads";
//  this answers a different question — "what BG does AFTER a folder has
//  already loaded" — and belongs conceptually with playback/presentation
//  behavior, not source selection. Nesting it under `startup.streamloop`
//  would also create a confusing near-duplicate name one level down. Named
//  to match the "StreamLoop Integration" Advanced disclosure exactly, so a
//  future reader maps this section to its UI without cross-referencing
//  anything. `autoFillPanel` defaults OFF: entering Fill Panel is a screen
//  takeover the customer did not just click a button for, so — unlike
//  `autoplayOnFill` above, which only applies once Fill Panel is already
//  being entered deliberately — this default stays conservative.]
const DEFAULT_STREAMLOOP_INTEGRATION = {
  autoFillPanel: false,
};

// Exposed so main.js can apply the same built-in fallback when
// `rememberGhostOpacity` is false — in that case the stored
// `ghostOpacityPercent` is intentionally ignored (it may be a stale value
// left over from before the user unchecked "Remember this value"), and the
// UI must fall back to this constant rather than that stored number.
export const DEFAULT_GHOST_OPACITY_PERCENT = DEFAULT_PRESENTATION.ghostOpacityPercent;

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

function clampOpacity(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return DEFAULT_PRESENTATION.ghostOpacityPercent;
  const rounded = Math.round(num);
  if (rounded < 0 || rounded > 100) return DEFAULT_PRESENTATION.ghostOpacityPercent;
  return rounded;
}

function bool(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function shuffleMode(value) {
  return value === "true-random" ? "true-random" : "shuffle-loop";
}

// [STARTUP-MEDIA / N6-4] Any unrecognized value — including a policy string
// written by a future version this build doesn't know about — falls back to
// today's proven default, same reasoning shuffleMode()/arcadeAnimationOrder()
// already use above.
function startupPolicy(value) {
  return value === "random-remembered" || value === "random-selected" ? value : "last-used";
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

// [STREAMLOOP-INTEGRATION / N6-6]
function normalizeStartupSection(value) {
  return {
    policy: startupPolicy(value && typeof value === "object" ? value.policy : undefined),
    eligibleLibraryIds: normalizeStartupEligibleLibraryIds(value && typeof value === "object" ? value.eligibleLibraryIds : undefined),
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
function normalizeStartupContexts(startupSource) {
  const isLegacyFlatShape =
    startupSource &&
    typeof startupSource === "object" &&
    !("browser" in startupSource) &&
    !("streamloop" in startupSource) &&
    ("policy" in startupSource || "eligibleLibraryIds" in startupSource);

  if (isLegacyFlatShape) {
    return {
      browser: normalizeStartupSection(startupSource),
      streamloop: normalizeStartupSection(undefined),
    };
  }

  const source = startupSource && typeof startupSource === "object" ? startupSource : {};
  return {
    browser: normalizeStartupSection(source.browser),
    streamloop: normalizeStartupSection(source.streamloop),
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
  const streamloopIntegrationSource =
    source.streamloopIntegration && typeof source.streamloopIntegration === "object" ? source.streamloopIntegration : {};

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
      rememberGhostOpacity: bool(presentationSource.rememberGhostOpacity, DEFAULT_PRESENTATION.rememberGhostOpacity),
      ghostOpacityPercent: clampOpacity(presentationSource.ghostOpacityPercent ?? DEFAULT_PRESENTATION.ghostOpacityPercent),
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
    // [STARTUP-MEDIA / N6-4] [STREAMLOOP-INTEGRATION / N6-6]
    startup: normalizeStartupContexts(startupSource),
    // [STREAMLOOP-INTEGRATION / N6-7] Net-new key — no migration beyond the
    // usual missing-field-defaults-individually pattern this function already
    // uses for every other section (see `onboarding`/`microArcade`'s own
    // history). No DATABASE_VERSION bump: the store's shape hasn't changed,
    // only the record's, and every record is reshaped on every read.
    streamloopIntegration: {
      autoFillPanel: bool(streamloopIntegrationSource.autoFillPanel, DEFAULT_STREAMLOOP_INTEGRATION.autoFillPanel),
    },
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

// [STREAMLOOP-INTEGRATION / N6-7]
// [WHY: unlike saveStartupPreferences() above, this section has exactly one
//  flat boolean field — no per-context nesting — so the generic one-level
//  savePartial() is sufficient here. Do not reuse the two-level merge
//  pattern; it would be unnecessary machinery for a section with no
//  nesting.]
export function saveStreamloopIntegrationPreferences(partial) {
  return savePartial("streamloopIntegration", partial);
}
