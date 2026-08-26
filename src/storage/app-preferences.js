// [APP-PREFERENCES] Global application preferences — Playback (interval,
// shuffle, skip duplicates, loop playlist, fill panel), Micro-Arcade,
// Presentation's Ghost Opacity "remember" state/value, and local onboarding.
// These are NOT Profile curation
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
