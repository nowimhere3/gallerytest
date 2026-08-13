import { LocalFileInputProvider } from "./providers/local-file-input-provider.js";
import { FsaFileProvider } from "./providers/fsa-file-provider.js";
import {
  listLibraries,
  addOrUpdateLibrary,
  touchLibrary,
  removeFromRecents,
  setLibraryProfile,
  listLegacyLibraries,
  addLegacyLibrary,
  updateLegacyLibrarySignature,
} from "./storage/library-registry.js";
import { computeLegacySignature, matchLegacySignature } from "./storage/legacy-library-signature.js";
import {
  loadPreferences,
  savePlaybackPreferences,
  savePresentationPreferences,
  DEFAULT_GHOST_OPACITY_PERCENT,
} from "./storage/app-preferences.js";
import { MediaRuntime } from "./runtime/media-runtime.js";
import { haveSameDuplicateKey, skipDuplicateMedia } from "./runtime/duplicate-filter.js";
import { ProfileStore } from "./profile/profile-store.js";
import { ProfileSync } from "./profile/profile-sync.js";
import { TsPlaybackAdapter } from "./playback/ts-playback-adapter.js";

const provider = new LocalFileInputProvider();
// [FSA] A second, independent provider for the File System Access folder
// path. Only one of `provider`/`fsaProvider` ever has "live" object URLs
// at a time — whichever load function runs disposes the OTHER one first
// (see loadFiles/loadFromFsaHandle below), since only one media set is
// ever actually loaded into the app at once.
const fsaProvider = new FsaFileProvider();
const profile = new ProfileStore();
// [PROFILE-SYNC]
// WHAT: The Profile Sync engine — watches `profile` for changes and mirrors
// the full Profile collection into a separately-chosen sync folder.
// WHY: Constructed once, here, alongside `profile` itself, and NEVER
// referenced from loadFiles()/loadFromFsaHandle() or any other
// media-source code below — that absence is deliberate. See
// profile-sync.js's header for the architectural boundary this protects:
// Profile Sync must survive every media-library change untouched.
// FUTURE / DO-NOT-BREAK: If a future change ever needs these two to
// interact, that almost certainly means the boundary is being crossed by
// mistake — re-read profile-sync.js's header first.
const profileSync = new ProfileSync(profile);
const runtime = new MediaRuntime({ profile });

// [TS-POC] Single adapter instance reused across items — attach() always
// tears down whatever it was previously doing first, so this is safe to
// call repeatedly across NEXT/PREV without accumulating state. See
// src/playback/ts-playback-adapter.js for the full explanation.
const tsPlaybackAdapter = new TsPlaybackAdapter();
let tsDiagnosticCounter = 0;

// Files are processed in chunks of this size (with a yield to the browser
// between chunks) so very large folder selections (1000+ files) don't
// block the main thread / spike memory all at once. Could be exposed as a
// user-facing setting later; for now it's a single constant to tune.
const BATCH_SIZE = 250;

// How far outside the viewport a gallery thumbnail's real <img>/<video>
// element gets mounted ahead of time, so scrolling still feels instant.
const THUMB_LAZY_ROOT_MARGIN = "400px 0px";

// ---- DOM references ----------------------------------------------------

const appShell = document.querySelector(".app-shell");
const layoutEl = document.querySelector(".layout");

const fileInput = document.getElementById("file-input");
const folderInput = document.getElementById("folder-input");
const legacyPickerDetails = document.getElementById("legacy-picker-details");
const fsaChooseFolderBtn = document.getElementById("fsa-choose-folder-btn");
const fsaRecentLibrariesEl = document.getElementById("fsa-recent-libraries");
const fsaStatusText = document.getElementById("fsa-status-text");
const fsaAssociateBtn = document.getElementById("fsa-associate-btn");
const fsaAssociateBtnLabel = document.getElementById("fsa-associate-btn-label");
const intervalInput = document.getElementById("interval-input");
const intervalDecreaseBtn = document.getElementById("interval-decrease-btn");
const intervalIncreaseBtn = document.getElementById("interval-increase-btn");
const shuffleInput = document.getElementById("shuffle-input");
const skipDuplicatesInput = document.getElementById("skip-duplicates-input");
const loopInput = document.getElementById("loop-input");
const videoLoopInput = document.getElementById("video-loop-input");
const videoLoopControl = document.getElementById("video-loop-control");
const fillInput = document.getElementById("fill-input");

const allMediaBtn = document.getElementById("all-media-btn");
const favoritesOnlyBtn = document.getElementById("favorites-only-btn");

const typeAllBtn = document.getElementById("type-all-btn");
const typeImagesBtn = document.getElementById("type-images-btn");
const typeVideosBtn = document.getElementById("type-videos-btn");

const tagsFilterToggleBtn = document.getElementById("tags-filter-toggle-btn");
const tagsFilterPanel = document.getElementById("tags-filter-panel");
const tagsFilterEmpty = document.getElementById("tags-filter-empty");
const tagsFilterGrid = document.getElementById("tags-filter-grid");

const profileSelect = document.getElementById("profile-select");
const profileSectionDetails = document.querySelector(".profile-section");
const profileAssociateBtn = document.getElementById("profile-associate-btn");
const profileDeleteBtn = document.getElementById("profile-delete-btn");
const profileCreateInput = document.getElementById("profile-create-input");
const profileCreateBtn = document.getElementById("profile-create-btn");
const profileActiveStatusText = document.getElementById("profile-active-status-text");

const profileExportBtn = document.getElementById("profile-export-btn");
const profileImportMergeBtn = document.getElementById("profile-import-merge-btn");
const profileImportReplaceBtn = document.getElementById("profile-import-replace-btn");
const profileImportInput = document.getElementById("profile-import-input");
const profileImportCopyBtn = document.getElementById("profile-import-copy-btn");
const profileImportCopyInput = document.getElementById("profile-import-copy-input");
const profileSkipMissingInput = document.getElementById("profile-skip-missing-input");
const profileStatusText = document.getElementById("profile-status-text");

// [PROFILE-SYNC] DOM refs for the compact Profile Sync block — see
// index.html's own [PROFILE-SYNC] comment on `.profile-sync-section`.
const profileSyncStatusText = document.getElementById("profile-sync-status-text");
const profileSyncChooseBtn = document.getElementById("profile-sync-choose-btn");
const profileSyncReconnectBtn = document.getElementById("profile-sync-reconnect-btn");
const profileSyncConnectedRow = document.getElementById("profile-sync-connected-row");
const profileSyncNowBtn = document.getElementById("profile-sync-now-btn");
const profileSyncManageToggleBtn = document.getElementById("profile-sync-manage-toggle-btn");
const profileSyncManagePanel = document.getElementById("profile-sync-manage-panel");
const profileSyncChangeBtn = document.getElementById("profile-sync-change-btn");
const profileSyncDisconnectBtn = document.getElementById("profile-sync-disconnect-btn");
const profileSyncConflictPanel = document.getElementById("profile-sync-conflict-panel");
const profileSyncUseSyncedBtn = document.getElementById("profile-sync-use-synced-btn");
const profileSyncKeepLocalBtn = document.getElementById("profile-sync-keep-local-btn");

// [PROFILE-SYNC-SETUP] Refs for the first-time setup modal — see the
// [PROFILE-SYNC-SETUP] comment on the <dialog> in index.html.
const profileSyncSetupDialog = document.getElementById("profile-sync-setup-dialog");
const profileSyncSetupFolderName = document.getElementById("profile-sync-setup-foldername");
const profileSyncSetupCopyBtn = document.getElementById("profile-sync-setup-copy-btn");
const profileSyncSetupCancelBtn = document.getElementById("profile-sync-setup-cancel-btn");
const profileSyncSetupOpenBtn = document.getElementById("profile-sync-setup-open-btn");

const tagCreateInput = document.getElementById("tag-create-input");
const tagCreateBtn = document.getElementById("tag-create-btn");
const tagsStatusText = document.getElementById("tags-status-text");
const tagsEmpty = document.getElementById("tags-empty");
const tagsGrid = document.getElementById("tags-grid");
const tagActivityNeutral = document.getElementById("tag-activity-neutral");
const tagActivityContent = document.getElementById("tag-activity-content");
const tagActivityName = document.getElementById("tag-activity-name");
const tagActivityRows = document.getElementById("tag-activity-rows");
const tagActivityEmpty = document.getElementById("tag-activity-empty");

const prevBtn = document.getElementById("prev-btn");
const nextBtn = document.getElementById("next-btn");
const playBtn = document.getElementById("play-btn");
const stopBtn = document.getElementById("stop-btn");
const clearBtn = document.getElementById("clear-btn");

const statusText = document.getElementById("status-text");
const selectedText = document.getElementById("selected-text");
const viewModeText = document.getElementById("view-mode-text");
const associatedText = document.getElementById("associated-text");
const counterText = document.getElementById("counter-text");
const galleryCount = document.getElementById("gallery-count");

const viewerPanel = document.getElementById("viewer-panel");
const viewerEmpty = document.getElementById("viewer-empty");
const viewerStage = document.getElementById("viewer-stage");
const favoriteBtn = document.getElementById("favorite-btn");

const galleryEmpty = document.getElementById("gallery-empty");
const galleryGrid = document.getElementById("gallery-grid");

const galleryJumpInput = document.getElementById("gallery-jump-input");
const galleryJumpModeFindBtn = document.getElementById("gallery-jump-mode-find-btn");
const galleryJumpModePlayBtn = document.getElementById("gallery-jump-mode-play-btn");

const presentationControls = document.getElementById("presentation-controls");
const presentationSettings = document.getElementById("presentation-settings");
const ghostToggleBtn = document.getElementById("ghost-toggle-btn");
const ghostPopunder = document.getElementById("ghost-popunder");
const ghostOpacityInput = document.getElementById("ghost-opacity-input");
const ghostOpacityLabel = document.getElementById("ghost-opacity-label");
const ghostRememberInput = document.getElementById("ghost-remember-input");
const presentationTagsEmpty = document.getElementById("presentation-tags-empty");
const presentationTagsRow = document.getElementById("presentation-tags-row");
const presentationTagsOverflow = document.getElementById("presentation-tags-overflow");

const overlayFavoriteBtn = document.getElementById("overlay-favorite-btn");
const overlayPrevBtn = document.getElementById("overlay-prev-btn");
const overlayPlayBtn = document.getElementById("overlay-play-btn");
const overlayNextBtn = document.getElementById("overlay-next-btn");
const overlayHideBtn = document.getElementById("overlay-hide-btn");
const overlayUndoHideBtn = document.getElementById("overlay-undo-hide-btn");
const overlayExitBtn = document.getElementById("overlay-exit-btn");
const overlaySettingsBtn = document.getElementById("overlay-settings-btn");
const overlayAutomationBtn = document.getElementById("overlay-automation-btn");

const automationPanel = document.getElementById("automation-panel");
const automationStepChoose = document.getElementById("automation-step-choose");
const automationStepTimes = document.getElementById("automation-step-times");
const automationStepTimer = document.getElementById("automation-step-timer");

const automationChoiceForeverBtn = document.getElementById("automation-choice-forever-btn");
const automationChoiceTimesBtn = document.getElementById("automation-choice-times-btn");
const automationChoiceTimerBtn = document.getElementById("automation-choice-timer-btn");

const automationTimesBackBtn = document.getElementById("automation-times-back-btn");
const automationTimesValueEl = document.getElementById("automation-times-value");
const automationTimesDecreaseBtn = document.getElementById("automation-times-decrease-btn");
const automationTimesIncreaseBtn = document.getElementById("automation-times-increase-btn");
const automationTimesApplyBtn = document.getElementById("automation-times-apply-btn");

const automationTimerBackBtn = document.getElementById("automation-timer-back-btn");
const automationTimerMinutesValueEl = document.getElementById("automation-timer-minutes-value");
const automationTimerMinutesDecreaseBtn = document.getElementById("automation-timer-minutes-decrease-btn");
const automationTimerMinutesIncreaseBtn = document.getElementById("automation-timer-minutes-increase-btn");
const automationTimerSecondsValueEl = document.getElementById("automation-timer-seconds-value");
const automationTimerSecondsDecreaseBtn = document.getElementById("automation-timer-seconds-decrease-btn");
const automationTimerSecondsIncreaseBtn = document.getElementById("automation-timer-seconds-increase-btn");
const automationTimerApplyBtn = document.getElementById("automation-timer-apply-btn");

// ---- App state -----------------------------------------------------------

let allItems = [];
let viewMode = "all"; // "all" | "favorites"
let typeFilter = "all"; // "all" | "image" | "video" — Media Type filter (Filtering Phase 1)
let activeTagFilters = []; // tag ids — Gallery Tag Filtering (Phase 6.3), AND-combined via filterMedia
// WHAT: Session-global viewing preference applied while deriving the runtime list.
// WHY: Duplicate suppression must be reversible and must not become Profile or library-registry data.
// FUTURE / DO-NOT-BREAK: Preferences may supply its initial value later; keep loaded media ownership in allItems.
let skipDuplicates = false;
let galleryJumpMode = "find"; // "find" | "play" — Gallery Media Navigation (Phase 2)
let fillModeActive = false;
let currentViewerNode = null;
let currentViewerItem = null;
let isLoadingFiles = false;
// [LIBRARY-PROFILE-ASSOCIATION / Phase 8.4-2] The library-registry record
// for whichever FSA library is currently loaded, if any — null when the
// current source is the webkitdirectory picker (see legacySessionAssociated
// below) or nothing is loaded. Tracked here purely so the "Associate this
// Library with Current Profile" button knows what it's associating; not a
// second source of truth for the association itself, which — for FSA —
// always lives in IndexedDB via library-registry.js.
let activeLibraryRecord = null;

// [Phase 8.4-2] Which picker produced the currently loaded media, if any.
// This — not "FSA vs legacy" scattered across call sites — is the one
// thing association-button visibility is computed from. See
// currentLoadIsAssociated()/syncAssociateButtonVisibility() below.
let currentSourceKind = "none"; // "fsa" | "legacy" | "none"

// [P1-DIAGNOSTIC / TEMPORARY] See the DevTools-callable probe block at the
// bottom of this file. Holds the most recently loaded FSA root handle (and
// its name) purely so that probe can walk from it — nothing in production
// code paths reads these. Safe to delete alongside that block.
let __p1DiagnosticRootHandle = null;
let __p1DiagnosticRootName = null;
// [P1-DIAGNOSTIC / TEMPORARY] Independent snapshots, NOT read from
// provider.getItems()/fsaProvider.getItems() live — loadFiles() and
// loadFromFsaHandle() each dispose() the OTHER provider at the start of
// every load (by design: only one live source at a time), which would
// otherwise make it impossible to have both sides' data available to
// compare at once. These snapshots persist across that disposal.
let __p1LegacySnapshot = [];
let __p1FsaSnapshot = [];

// [Phase 8.4-2] webkitdirectory carries no durable physical-folder
// identity on its own — no isSameEntry()-equivalent exists for it. As of
// Phase 8.4-3, a FOLDER pick (not a bare "Choose Files" multi-select) CAN
// still be recognized on a later re-pick, via a metadata fingerprint — see
// legacyHasDurableIdentity below and legacy-library-signature.js. This
// flag remains the fallback for the case that genuinely has no folder
// context at all: it lives purely in memory, resets to false on every
// fresh legacy load, and is never persisted. Clicking "Associate" while
// this is the active mechanism just flips it so the button hides for the
// REST of this load/session — nothing more.
let legacySessionAssociated = false;

// [Phase 8.4-3] True for the current load only when it came through the
// webkitdirectory FOLDER picker (has a root folder context to fingerprint)
// — as opposed to the plain multi-file "Choose Files" input, which has no
// meaningful folder identity to build a durable association from (see
// loadFiles()). When true, currentLoadIsAssociated() and the Associate
// click handler use activeLibraryRecord + the persisted legacy registry
// instead of the ephemeral legacySessionAssociated flag above.
let legacyHasDurableIdentity = false;

// [Phase 8.4-3] The signature computed for the CURRENTLY loaded legacy
// folder, kept only for the case where no stored record matched it yet —
// so that if the user then clicks "Associate", a new legacy library record
// can be created from the signature already computed at load time instead
// of recomputing it. Cleared once a record exists (matched OR newly
// created) for the current load.
let pendingLegacySignature = null;

// [LIBRARY-PROFILE-UX / Phase 8.5]
// WHAT: A short-lived, navigation-only hint set while the Load Media
// Associate/Change shortcut opens the Profile section.
// WHY: It lets expandAndScrollToProfileSection() put focus on the explicit
// Profile-side association button. It never authorizes or triggers a
// persisted association; only clicking that button does.
// FUTURE: Keep this flag purely presentational. Profile switching,
// creation, and import must remain ordinary profile actions.
let pendingLibraryAssociationIntent = false;

// [Phase 8.4-2] Single visibility rule for whether the current load is
// considered associated — drives both the Associate/Change button's LABEL
// (see syncAssociateButtonVisibility) and the green "Associated:" status
// row (see updateAssociatedStatusRow), never a separately-tracked boolean.
function currentLoadIsAssociated() {
  if (currentSourceKind === "fsa") {
    // No persisted library.id (e.g. addOrUpdateLibrary() failed to save
    // this folder — see fsaChooseFolderBtn's catch) means there is
    // nothing a click could actually persist an association against;
    // treat that as "can't participate" rather than dangling a button
    // that would silently no-op when clicked.
    if (!activeLibraryRecord || !activeLibraryRecord.id) return true;
    // [Phase 8.5] Checked against REAL known profiles, not just
    // truthiness — a profileId can go stale in-memory the moment its
    // Profile is deleted, without waiting for a reload (see
    // profileDeleteBtn's stale-clearing below). Must agree with
    // updateAssociatedStatusRow()'s own "Not associated" fallback.
    return Boolean(activeLibraryRecord.profileId && getProfileNameById(activeLibraryRecord.profileId));
  }
  if (currentSourceKind === "legacy") {
    // [Phase 8.4-3] A folder pick with durable identity behaves exactly
    // like FSA here — same activeLibraryRecord.profileId check — it's
    // just persisted via a signature instead of a handle. Only the
    // handle-less "Choose Files" case falls back to the ephemeral flag.
    if (legacyHasDurableIdentity) {
      return Boolean(
        activeLibraryRecord && activeLibraryRecord.profileId && getProfileNameById(activeLibraryRecord.profileId)
      );
    }
    return legacySessionAssociated;
  }
  return true; // "none" — nothing loaded; not a real association state,
  // but this makes updateAssociatedStatusRow's "—" case share the same
  // underlying check rather than needing its own separate one.
}

// Looks up the DISPLAY NAME for a profileId that may or may not be the
// currently active profile — the green status row must reflect the
// LOADED LIBRARY's association, not whatever profile the user happens to
// be looking at right now (see updateAssociatedStatusRow's own comment).
function getProfileNameById(profileId) {
  if (!profileId) return null;
  const entry = profile.listProfiles().find((candidate) => candidate.id === profileId);
  return entry ? entry.name : null;
}

// [LIBRARY-PROFILE-UX / Phase 8.5]
// WHAT: Updates the green "Associated:" row in the live status box.
// WHY: Section 1 — must reflect the CURRENTLY LOADED library's own
// association, not the globally active profile (they can differ — e.g.
// Profile B is active but the just-loaded Library A is unassociated).
// FUTURE: Always call this alongside syncAssociateButtonVisibility() (see
// that function) rather than adding separate call sites — they must never
// drift out of sync with each other.
function updateAssociatedStatusRow() {
  if (currentSourceKind === "none") {
    associatedText.textContent = "—";
    return;
  }

  if (!currentLoadIsAssociated()) {
    associatedText.textContent = "Not associated";
    return;
  }

  const usesDurableRecord = currentSourceKind === "fsa" || (currentSourceKind === "legacy" && legacyHasDurableIdentity);
  if (usesDurableRecord) {
    // Deliberately NO fallback to profile.getProfileName() here: if
    // activeLibraryRecord.profileId doesn't resolve to a real profile
    // (deleted since — see profileDeleteBtn's stale-clearing below), that
    // MUST read "Not associated", never the currently-active profile's
    // name — this is exactly the "do not display the globally active
    // Profile" rule from section 1.
    const name = activeLibraryRecord ? getProfileNameById(activeLibraryRecord.profileId) : null;
    associatedText.textContent = name || "Not associated";
    return;
  }

  // Ephemeral ("Choose Files") association has no stored profileId to look
  // up at all — it only ever means "the profile that was active at the
  // moment Associate was clicked", i.e. whatever profile is active now.
  associatedText.textContent = profile.getProfileName() || "Not associated";
}

// [LIBRARY-PROFILE-UX / Phase 8.5]
// WHAT: Shows/hides the Associate/Change button AND sets its label — one
// button, "Associate with Profile" when the current load has no
// association, "Change Profile" once it does (see the button's own HTML
// comment for why this is deliberately one element, not two). Also
// refreshes the green Associated: row every time, since both are driven
// by the exact same underlying state.
// WHY: Consolidates every place that used to independently decide
// "hidden or not" into one call, so the button and the status row can
// never disagree with each other.
// FUTURE: If a new source kind is ever added, this + currentLoadIsAssociated()
// are the only two functions that need to learn about it.
function syncAssociateButtonVisibility() {
  const shouldShow = currentSourceKind !== "none";
  const associated = currentLoadIsAssociated();
  fsaAssociateBtn.classList.toggle("hidden", !shouldShow);
  fsaAssociateBtn.disabled = !shouldShow;
  profileAssociateBtn.classList.toggle("hidden", !shouldShow);
  profileAssociateBtn.disabled = !shouldShow;
  if (shouldShow) {
    fsaAssociateBtnLabel.textContent = associated ? "Change Profile" : "Associate with Profile";
  }
  updateAssociatedStatusRow();
}

// [LIBRARY-PROFILE-UX / Phase 8.5]
// WHAT: Expands the Profile <details> section if collapsed and smooth-
// scrolls it into view.
// WHY: Section 4/6 — "Associate"/"Change Profile" are navigation-only;
// all actual profile selection/creation/import stays in Profile itself,
// never duplicated here.
// FUTURE: Do not add profile-selection UI to this function or its
// caller — if Load Media ever needs more than a shortcut, that's a
// scope change, not an extension of this helper.
function expandAndScrollToProfileSection() {
  if (profileSectionDetails && !profileSectionDetails.open) {
    profileSectionDetails.open = true;
  }
  profileSectionDetails?.scrollIntoView({ behavior: "smooth", block: "start" });
  syncAssociateButtonVisibility();
  if (pendingLibraryAssociationIntent) {
    pendingLibraryAssociationIntent = false;
    profileAssociateBtn?.focus();
  } else {
    profileSelect?.focus();
  }
}

// [Phase 8.4-3] Debug breadcrumbs for legacy folder matching, privacy-safe
// by construction — every call site below only ever passes counts, short
// hashes, or internally-generated record ids, never filenames/paths/root
// names themselves. See legacy-library-signature.js's header comment for
// why raw rootName is fine to STORE (it's just local IndexedDB data, same
// as an FSA handle's name already is) but not fine to LOG.
function logLegacyIdentity(event, details) {
  console.debug(`[LEGACY-IDENTITY] ${event}`, details || "");
}

// ---- Undo Last Hide ---------------------------------------------------
//
// Deliberately NOT a history/command system — single-level only, per spec.
// Remembers just the relativePath of the most recently hidden item so one
// accidental 🙈 can be reversed. Lives here (main.js), not ProfileStore or
// MediaRuntime: it's an ephemeral UI affordance, not curation data (that's
// still just isHidden on the Profile record) and not playback/session
// state. Restoring goes straight through ProfileStore.setHidden (the same
// path toggleHidden uses), so this never becomes a second source of truth
// for hidden state — it only ever remembers *which* record to restore.
let lastHiddenRelativePath = null;

// Bumped any time the underlying item *list* changes (new load, filter
// switch, an item dropping out of Favorites Only). Slideshow navigation
// (next/previous/timer tick) does NOT bump this, so renderGallery() can
// tell "the list changed, do a full rebuild" apart from "just the current
// index moved, only update highlighting" — critical for large libraries,
// since rebuilding 1000+ cards on every slideshow tick would be its own
// performance problem.
let galleryGeneration = 0;
let renderedGalleryGeneration = -1;
let galleryCardEls = [];
let galleryThumbEls = [];
let galleryObserver = null;
let galleryJumpTargetIndex = null;

// ---- Loop Automations (Phase 5 + Phase 5.1 refinement) ---------------------
//
// A Loop Rule governs how many times (or how long) the CURRENTLY DISPLAYED
// video is allowed to loop-on-end — the existing per-video 🔁 toggle above —
// before Presentation advances to the next item. Everything here is local
// to this module and to the current Presentation session only: no Runtime,
// ProfileStore, or IndexedDB involvement, and nothing survives Presentation
// ending, per this phase's requirements.
//
//   { type: "forever" }
//   { type: "times", totalPlays: N }
//   { type: "timer", minutes: M, seconds: S }
//
// Adding a future rule type (e.g. "Until Clock Time") means adding one more
// branch to shouldLoopRuleRestartVideo()/applyLoopRuleToCurrentVideo() and
// one more editor step — the choose/back/Apply flow and video "ended"
// wiring below don't need to change shape.
//
// APPLIED vs DRAFT: `activeLoopRule` below is the rule actually governing
// playback right now. It is intentionally separate from the automation
// editor's draft state (further down, near the panel wiring) — opening the
// row, changing steps, or adjusting a stepper only ever touches the draft;
// nothing reaches `activeLoopRule` until Apply is clicked. Closing the row
// via 🤖 (not Apply) discards the draft and leaves `activeLoopRule` alone.
let activeLoopRule = { type: "forever" };

// Enforcement progress for whichever video is currently on screen.
//
// For "times": the number of plays that have already FINISHED (i.e. the
// count of "ended" events processed so far for this rule) — NOT including
// whichever play is currently in progress. "X Times = N" means N total
// plays including the one already in progress when Apply was clicked, so
// the current play is play 1 before a single "ended" event has fired; the
// first "ended" event completes that play and brings this counter to 1.
// Reset to 0 whenever a genuinely new video is displayed
// (armLoopRuleForCurrentVideo) or the rule is re-applied to the same video
// (applyLoopRuleToCurrentVideo, called from Apply/Forever/Loop-toggle-on).
let loopRuleCompletedPlays = 0;
let loopRuleTimerId = null;

// Bumped whenever a genuinely new video starts being displayed, OR a finite
// automation completes and hands off to the next item. Lets a pending timer
// (or a video's own "ended" listener) recognize it's stale — left over from
// a video/rule that's since been superseded — and no-op instead of
// double-advancing Presentation.
let loopRuleVideoToken = 0;


function bumpGalleryGeneration() {
  galleryGeneration += 1;
}

// ---- Helpers ---------------------------------------------------------

// ---- Shared filtering pipeline (Filtering & Tagging Phase 1) --------------
//
// The single place that decides what media any playback mode is allowed to
// see. Gallery, Presentation, Slideshow, and Shuffle never filter items
// themselves — they all consume whatever this returns via getVisibleItems()
// below, which is the only thing that ever gets handed to runtime.load().
// A future user-tag filter is one more optional field here, not a new
// pipeline.
function filterMedia(items, { favourites = false, mediaType = "all", tags = [] } = {}) {
  let result = items;

  if (favourites) {
    result = result.filter((item) => item.isFavorite);
  }

  if (mediaType && mediaType !== "all") {
    result = result.filter((item) => item.mediaType === mediaType);
  }

  if (tags && tags.length) {
    result = result.filter((item) => tags.every((tag) => item.userTags.includes(tag)));
  }

  return result;
}

function getVisibleItems() {
  let filtered = filterMedia(allItems, {
    favourites: viewMode === "favorites",
    mediaType: typeFilter,
    tags: activeTagFilters,
  });

  if (skipDuplicates) {
    filtered = skipDuplicateMedia(filtered);
  }

  if (viewMode === "favorites") {
    // Newest favorite first (Favourite Ordering). Items favorited under an
    // older profile schema (no timestamp) sort after timestamped ones, but
    // otherwise keep their existing relative order — Array#sort is stable.
    return [...filtered].sort((a, b) => (b.favoritedAt ?? -1) - (a.favoritedAt ?? -1));
  }

  // Normal Gallery ordering is unchanged.
  return filtered;
}

// Shared tail of every "a folder/fileset finished loading" path (the
// original webkitdirectory path AND the FSA path below). Stamps
// favorite/hidden/tag status from the Profile immediately, before
// getVisibleItems() (used by reloadRuntime) might filter down to Favorites
// Only — otherwise that filter would run against items that don't know
// their own favorite/hidden status yet.
function finishLoadingItems(items) {
  items.forEach((item) => {
    item.isFavorite = profile.isFavorite(item.relativePath);
    item.isHidden = profile.isHidden(item.relativePath);
    item.favoritedAt = profile.getFavoritedAt(item.relativePath);
    item.userTags = profile.getItemTags(item.relativePath);
  });

  allItems = items;
  reloadRuntime({ randomizeInitial: shouldRandomizeInitialSelection() });
}

async function loadFiles(fileList, { isFolderPick = false, rootName = null } = {}) {
  const total = (fileList || []).length;
  if (!total || isLoadingFiles) return;

  isLoadingFiles = true;

  // Clear immediately so stale thumbnails / soon-to-be-revoked object URLs
  // from a previous selection aren't left on screen while the new batch
  // loads in the background.
  bumpGalleryGeneration();
  runtime.clear();
  clearViewerNode();
  exitFillMode();
  setLoadingState(true, total);
  lastHiddenRelativePath = null;
  syncUndoHideButton();
  // [FSA] Switching TO the local-picker path — release whatever the FSA
  // path had loaded, since only one media set is ever active at once.
  fsaProvider.dispose();
  activeLibraryRecord = null;
  currentSourceKind = "legacy";
  // [Phase 8.4-3] Only a real folder pick (webkitdirectory, has a root to
  // fingerprint) participates in durable identity — "Choose Files" keeps
  // the old ephemeral, ununrecognizable-on-reload behavior unchanged (see
  // currentLoadIsAssociated()). Recomputed on every load rather than
  // trusted from a previous one.
  legacyHasDurableIdentity = Boolean(isFolderPick && rootName);
  legacySessionAssociated = false;
  pendingLegacySignature = null;
  // [LIBRARY-PROFILE-UX / Phase 8.5] A pending "navigate to Profile to
  // associate" intent belongs to whatever was loaded when it was set —
  // never carry it forward onto a new, unrelated load that's only just
  // starting now.
  pendingLibraryAssociationIntent = false;
  fsaAssociateBtn.classList.add("hidden");
  fsaAssociateBtn.disabled = true;

  // [Phase 8.4-3] Mirrors loadFromFsaHandle's own recognizedProfileName —
  // only set when a legacy re-pick actually causes a Profile switch, so
  // the note below appears exactly for that case.
  let recognizedProfileName = null;

  try {
    const items = await provider.loadFromFileList(fileList, {
      batchSize: BATCH_SIZE,
      onProgress: (loaded, totalCount) => {
        statusText.textContent = `Loading media… ${loaded} / ${totalCount}`;
      },
    });

    // [Phase 8.4-3] Resolve legacy identity BEFORE finishLoadingItems()
    // stamps favorite/hidden/tag state — mirrors the FSA flow's ordering
    // exactly, so a recognized folder's Profile is active by the time
    // items get stamped, not after.
    if (legacyHasDurableIdentity) {
      try {
        const signature = await computeLegacySignature(items, rootName);
        const storedRecords = await listLegacyLibraries();
        logLegacyIdentity("signature generated", {
          rootNameHash: signature.rootNameHash,
          itemCount: signature.itemCount,
          sampleSize: signature.sampleEntries.length,
        });
        logLegacyIdentity("candidates checked", { count: storedRecords.length });

        const matchResult = matchLegacySignature(signature, storedRecords);

        if (matchResult.status === "match") {
          logLegacyIdentity("match found", { matchedId: matchResult.record.id, score: Number(matchResult.score.toFixed(2)) });
          // Refresh the stored signature to what was just seen (drift
          // tracking — see updateLegacyLibrarySignature's own comment),
          // preserving id/profileId.
          const refreshed = await updateLegacyLibrarySignature(matchResult.record.id, signature);
          activeLibraryRecord = refreshed || matchResult.record;
          pendingLegacySignature = null;

          if (activeLibraryRecord.profileId) {
            const knownProfileIds = new Set(profile.listProfiles().map((entry) => entry.id));
            if (knownProfileIds.has(activeLibraryRecord.profileId)) {
              if (activeLibraryRecord.profileId !== profile.getProfileId()) {
                await profile.switchProfile(activeLibraryRecord.profileId);
              }
              recognizedProfileName = profile.getProfileName();
              logLegacyIdentity("associated profile id", { profileId: activeLibraryRecord.profileId });
            } else {
              // [Phase 8.4-3] Same stale-association handling as the FSA
              // path: the profile this library pointed at no longer
              // exists (deleted since). Clear it rather than switching to
              // nothing or leaving a dangling reference.
              console.warn("[LEGACY-IDENTITY] Recognized library's associated profile no longer exists — clearing the stale association.");
              try {
                const cleared = await setLibraryProfile(activeLibraryRecord.id, null);
                activeLibraryRecord = cleared || { ...activeLibraryRecord, profileId: null };
              } catch (error) {
                activeLibraryRecord = { ...activeLibraryRecord, profileId: null };
              }
            }
          }
        } else if (matchResult.status === "ambiguous") {
          // Per spec: false negatives are preferable to guessing. Treated
          // identically to "no match" from here on — unassociated, no
          // profile switch, Associate button will offer to create a new
          // record if the user proceeds.
          logLegacyIdentity("ambiguous — refusing to guess", { candidateIds: matchResult.candidateIds });
          activeLibraryRecord = null;
          pendingLegacySignature = signature;
        } else {
          logLegacyIdentity("no match — new/unrecognized library");
          activeLibraryRecord = null;
          pendingLegacySignature = signature;
        }
      } catch (error) {
        // Identity resolution must never block the actual media load —
        // worst case, this folder just isn't recognized this time.
        console.warn("[LEGACY-IDENTITY] Could not resolve legacy folder identity.", error);
        activeLibraryRecord = null;
        pendingLegacySignature = null;
      }
    }

    finishLoadingItems(items);
    // [P1-DIAGNOSTIC / TEMPORARY] Snapshot BEFORE anything later in this
    // session can dispose() the legacy provider out from under it.
    __p1LegacySnapshot = [...items];
    // [Phase 8.4-2] Legacy loads participate in the same Associate-button
    // UI as FSA during the current session — see the Core Visibility Rule.
    syncAssociateButtonVisibility();
    // [LIBRARY-PROFILE-UX / Phase 8.5]
    // WHAT: Collapses the Legacy Picker disclosure after a successful load.
    // WHY: Section 2 — it's rarely needed again immediately after loading;
    // collapsing it back reclaims the vertical space it was expanded for.
    // FUTURE: Whether this auto-collapses at all may become a user
    // Preference later (see Gallery Control Settings Preferences, not
    // built yet) — this unconditional collapse is a placeholder default.
    legacyPickerDetails.open = false;
    // [Phase 8.4-3] Same "brief recognition note" treatment as the FSA
    // path — fsaStatusText survives the reactive statusText re-render
    // finishLoadingItems() just triggered, so it's the right element for
    // a message that should stick around, not the generic status line.
    if (recognizedProfileName) {
      fsaStatusText.textContent = `✓ Recognized this library — Profile: ${recognizedProfileName}.`;
    }
  } finally {
    isLoadingFiles = false;
    setLoadingState(false);
  }
}

// ---- File System Access API folder loading -------------------------------
//
// Mirrors loadFiles() above (same staging: clear, setLoadingState, dispose
// the other provider, finishLoadingItems tail) but drives FsaFileProvider's
// recursive directory walk instead of a FileList. Kept as its own function
// rather than folded into loadFiles since the two inputs (a File[]-like
// FileList vs. a directory handle) and their progress semantics ("N of
// known total" vs. "N found so far") are different enough that forcing one
// shared signature would obscure both.
function isFsaSupported() {
  return typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";
}

async function loadFromFsaHandle(dirHandle, libraryRecord) {
  if (isLoadingFiles) return;

  isLoadingFiles = true;

  // [P1-DIAGNOSTIC / TEMPORARY] Retains the root handle for the
  // DevTools-callable probe at the bottom of this file — see that block's
  // header comment for removal instructions. Not used by any production
  // code path; safe to delete alongside that block.
  __p1DiagnosticRootHandle = dirHandle;
  __p1DiagnosticRootName = dirHandle.name;

  // [LIBRARY-PROFILE-ASSOCIATION] Resolved BEFORE any of the staging/UI
  // reset below, so a profile switch (if this library is associated with
  // one) happens once, cleanly — the rest of this function's UI reset
  // (tags grid, profile selector, etc., via profile.subscribe()
  // elsewhere) already reflects the CORRECT profile while "Scanning
  // folder…" is showing, rather than briefly showing the outgoing
  // profile's state. See the breadcrumb at the top of
  // library-registry.js for where this association is stored and why.
  //
  // NOTE: profile.listProfiles()/getProfileId() read ProfileStore's
  // already-resolved in-memory state; switchProfile() itself internally
  // awaits ProfileStore's own readiness, so this is safe even if called
  // very early. The one path not fully covered is listProfiles() being
  // read before that initial resolution completes (returns an empty
  // list) — in practice unreachable here, since reaching this function
  // at all requires either the FSA folder-picker round trip or a Recent
  // Libraries click, both far slower than one IndexedDB open.
  activeLibraryRecord = libraryRecord || null;
  currentSourceKind = "fsa";
  // [LIBRARY-PROFILE-UX / Phase 8.5] Same reset as loadFiles() — a new
  // load starting means any pending Associate/Change-Profile navigation
  // intent from a PREVIOUS load no longer applies.
  pendingLibraryAssociationIntent = false;
  fsaAssociateBtn.classList.add("hidden");
  fsaAssociateBtn.disabled = true;

  // [Phase 8.5-2] Set for an associated library that was genuinely
  // recognized: either an existing folder was re-picked, or a Recent
  // Library resumed and switched profiles. A newly registered folder is
  // not described as recognized merely because it has a record now.
  let recognizedProfileName = null;

  if (activeLibraryRecord && activeLibraryRecord.id && activeLibraryRecord.profileId) {
    const knownProfileIds = new Set(profile.listProfiles().map((entry) => entry.id));

    if (knownProfileIds.has(activeLibraryRecord.profileId)) {
      const switchedProfiles = activeLibraryRecord.profileId !== profile.getProfileId();
      if (switchedProfiles) {
        await profile.switchProfile(activeLibraryRecord.profileId);
      }
      if (activeLibraryRecord.wasExisting || switchedProfiles) {
        recognizedProfileName = profile.getProfileName();
      }
    } else {
      // [LIBRARY-PROFILE-ASSOCIATION] Test F — the Profile this library
      // was associated with no longer exists. Never guess a replacement
      // (no name-matching, no falling back to whatever's active): clear
      // the stale pointer and fall through to the "unassociated" path
      // below, which offers re-association once the library has loaded.
      console.warn(
        `[LIBRARY-REGISTRY] "${activeLibraryRecord.name}" was associated with a profile that no longer exists. Clearing the stale association.`
      );
      try {
        const updated = await setLibraryProfile(activeLibraryRecord.id, null);
        if (updated) activeLibraryRecord = updated;
      } catch (error) {
        console.warn("[LIBRARY-REGISTRY] Could not clear the stale profile association.", error);
        activeLibraryRecord = { ...activeLibraryRecord, profileId: null };
      }
    }
  }

  bumpGalleryGeneration();
  runtime.clear();
  clearViewerNode();
  exitFillMode();
  setLoadingState(true);
  statusText.textContent = "Scanning folder…";
  lastHiddenRelativePath = null;
  syncUndoHideButton();
  // [FSA] Switching TO the FSA path — release whatever the local <input>
  // picker had loaded.
  provider.dispose();

  fsaStatusText.textContent = "";

  // [LIBRARY-REGISTRY] Reliability requirement: given the diagnosed FSA
  // traversal gap (see library-registry.js's header comment / the
  // investigation this came out of), a resume must never silently trust
  // whatever count a fresh walk returns. Compare against what this
  // library's registry record last reported, if anything.
  const previousCount =
    activeLibraryRecord && typeof activeLibraryRecord.itemCount === "number" ? activeLibraryRecord.itemCount : null;

  try {
    const result = await fsaProvider.loadFromDirectoryHandle(dirHandle, {
      batchSize: BATCH_SIZE,
      onProgress: (loaded) => {
        statusText.textContent = `Scanning folder… ${loaded} media file${loaded === 1 ? "" : "s"} found so far`;
      },
    });

    const count = result.items.length;
    const driftNote =
      previousCount !== null && previousCount !== count
        ? ` (previously ${previousCount} item${previousCount === 1 ? "" : "s"} on record — folder contents may have changed, or the scan may be incomplete; see console)`
        : "";
    // [Phase 8.4-2] Optional, brief recognition note — not a separate
    // notification system, just a prefix on the same status line that
    // already reports the load result.
    const recognizedNote = recognizedProfileName ? `✓ Recognized this library — Profile: ${recognizedProfileName}. ` : "";

    if (result.incomplete) {
      // Reliability requirement: an interrupted scan must never be
      // reported as if it were a complete one. Diagnostics already went to
      // the console (see FsaFileProvider); this surfaces it to the user
      // too, with whatever was actually found before the failure.
      fsaStatusText.textContent =
        `${recognizedNote}Folder scan stopped early — only ${count} item${count === 1 ? "" : "s"} loaded.${driftNote} ` +
        "Check the browser console for details, then try again.";
    } else if (result.diagnostics.errors.length) {
      fsaStatusText.textContent =
        `${recognizedNote}Loaded ${count} item${count === 1 ? "" : "s"}, but ${result.diagnostics.errors.length} file` +
        `${result.diagnostics.errors.length === 1 ? "" : "s"} could not be read (see console).${driftNote}`;
    } else {
      fsaStatusText.textContent = `${recognizedNote}Loaded ${count} item${count === 1 ? "" : "s"} from "${dirHandle.name}".${driftNote}`;
    }

    finishLoadingItems(result.items);
    // [P1-DIAGNOSTIC / TEMPORARY] Snapshot BEFORE anything later in this
    // session can dispose() the FSA provider out from under it.
    __p1FsaSnapshot = [...result.items];

    if (activeLibraryRecord && activeLibraryRecord.id) {
      try {
        await touchLibrary(activeLibraryRecord.id, { itemCount: count });
      } catch (error) {
        // Doesn't affect this session's already-loaded library — only
        // means the registry's remembered count/timestamp is stale.
        console.warn("[LIBRARY-REGISTRY] Could not update this library's saved record.", error);
      }
      await renderRecentLibraries();
    }

    // [Phase 8.4-2] Single visibility rule, same one loadFiles() uses for
    // the legacy path — see currentLoadIsAssociated() for the id-less
    // edge case (a library that failed to persist never shows the
    // button, since a click would have nothing to associate).
    syncAssociateButtonVisibility();
  } catch (error) {
    console.error("[FSA] Failed to load the selected folder.", error);
    fsaStatusText.textContent = `Could not load that folder: ${error.message}`;
  } finally {
    isLoadingFiles = false;
    setLoadingState(false);
  }
}

fsaChooseFolderBtn.addEventListener("click", async () => {
  if (!isFsaSupported()) {
    fsaStatusText.textContent = "This browser does not support the File System Access API.";
    return;
  }

  let dirHandle;
  try {
    dirHandle = await window.showDirectoryPicker();
  } catch (error) {
    if (error && error.name === "AbortError") return; // user closed the picker — not an error
    console.error("[FSA] Folder picker failed.", error);
    fsaStatusText.textContent = `Could not open the folder picker: ${error.message}`;
    return;
  }

  // [LIBRARY-REGISTRY] addOrUpdateLibrary() deduplicates via the real FSA
  // isSameEntry() identity check, so re-picking a folder that's already
  // registered updates that record instead of creating a duplicate entry.
  let record;
  try {
    record = await addOrUpdateLibrary(dirHandle);
    await renderRecentLibraries();
  } catch (error) {
    // Persistence failing doesn't block using the folder THIS session —
    // it just won't be resumable next time. Fall back to an in-memory-only
    // record so the load below still has something to report drift against.
    console.warn("[LIBRARY-REGISTRY] Could not save this folder for future sessions.", error);
    record = { id: null, name: dirHandle.name, itemCount: null };
  }

  await loadFromFsaHandle(dirHandle, record);
});

// [LIBRARY-REGISTRY] Resumes one specific remembered library (a click on a
// "Recent Libraries" row) — checks/re-requests read permission for its
// saved handle, same flow the old single-slot "Start Here" button used,
// now parameterized by which record was clicked instead of a fixed key.
async function resumeLibrary(record) {
  fsaStatusText.textContent = "Checking folder access…";

  const dirHandle = record.handle;
  if (!dirHandle) {
    fsaStatusText.textContent = `"${record.name}" has no saved folder access. Choose it again with "Choose Folder (FSA)".`;
    return;
  }

  // Browsers do not guarantee stored permission survives a restart —
  // check first, and only prompt if actually needed. requestPermission()
  // must be called from a user gesture; this click handler is one.
  try {
    let permission = await dirHandle.queryPermission({ mode: "read" });
    if (permission !== "granted") {
      permission = await dirHandle.requestPermission({ mode: "read" });
    }
    if (permission !== "granted") {
      fsaStatusText.textContent = `Access to "${record.name}" was not granted.`;
      return;
    }
  } catch (error) {
    // A handle can become genuinely invalid (folder deleted/moved, browser
    // data cleared, etc.) — fail gracefully rather than throwing, and stop
    // offering a broken resume for it.
    console.error("[FSA] A saved folder is no longer accessible.", error);
    fsaStatusText.textContent = `"${record.name}" is no longer available — it may have moved or been deleted. Removing it from Recent Libraries.`;
    // [LIBRARY-PROFILE-ASSOCIATION] Soft-remove, not removeLibrary() — a
    // permission failure doesn't mean the physical folder is gone for
    // good (it may just be a revoked permission on an otherwise-fine
    // folder). Keeping the record means re-picking the same folder later
    // can still recognize it via isSameEntry() and recover this library's
    // profile association, same as an explicit "X" — see
    // library-registry.js.
    try {
      await removeFromRecents(record.id);
    } catch (removeError) {
      console.warn("[LIBRARY-REGISTRY] Could not remove the stale library record.", removeError);
    }
    await renderRecentLibraries();
    return;
  }

  await loadFromFsaHandle(dirHandle, record);
}

// [LIBRARY-PROFILE-ASSOCIATION] Shows which Profile (if any) this library
// is associated with — the "Main Library / 2151 items · Profile: Main"
// row the phase spec described as optional. Reads profile.listProfiles()
// fresh each render rather than caching a name, so a profile rename is
// reflected here immediately without this module needing its own
// invalidation logic.
function formatLibraryMeta(record) {
  const parts = [];
  if (typeof record.itemCount === "number") {
    parts.push(`${record.itemCount} item${record.itemCount === 1 ? "" : "s"}`);
  }
  if (record.lastOpenedAt) parts.push(`opened ${formatRelativeTime(record.lastOpenedAt)}`);
  if (record.profileId) {
    const associated = profile.listProfiles().find((entry) => entry.id === record.profileId);
    parts.push(`Profile: ${associated ? associated.name : "unknown"}`);
  }
  return parts.join(" · ");
}

function formatRelativeTime(timestamp) {
  const diffMs = Date.now() - timestamp;
  const minute = 60000;
  const hour = 3600000;
  const day = 86400000;
  if (diffMs < minute) return "just now";
  if (diffMs < hour) return `${Math.round(diffMs / minute)}m ago`;
  if (diffMs < day) return `${Math.round(diffMs / hour)}h ago`;
  const days = Math.round(diffMs / day);
  return days === 1 ? "yesterday" : `${days}d ago`;
}

// [LIBRARY-REGISTRY] Re-renders the "Recent Libraries" list from IndexedDB.
// Rebuilt from scratch each call (list is small — a handful of libraries
// at most) rather than diffed, matching renderTagsGrid()'s existing
// pattern elsewhere in this file. Does NOT touch permissions or load
// anything on its own — purely a metadata read, safe to call at boot.
async function renderRecentLibraries() {
  let records;
  try {
    records = await listLibraries();
  } catch (error) {
    console.warn("[LIBRARY-REGISTRY] Could not read saved libraries.", error);
    records = [];
  }

  fsaRecentLibrariesEl.innerHTML = "";
  fsaRecentLibrariesEl.classList.toggle("hidden", records.length === 0);

  for (const record of records) {
    const row = document.createElement("div");
    row.className = "fsa-recent-library-row";

    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.className = "fsa-recent-library-btn";
    openBtn.addEventListener("click", () => resumeLibrary(record));

    const nameEl = document.createElement("span");
    nameEl.className = "fsa-recent-library-name";
    nameEl.textContent = record.name;

    const metaEl = document.createElement("span");
    metaEl.className = "fsa-recent-library-meta";
    metaEl.textContent = formatLibraryMeta(record);

    openBtn.appendChild(nameEl);
    openBtn.appendChild(metaEl);

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "fsa-recent-library-remove-btn";
    removeBtn.title = `Remove "${record.name}" from Recent Libraries`;
    removeBtn.setAttribute("aria-label", `Remove "${record.name}" from Recent Libraries`);
    removeBtn.textContent = "✕";
    removeBtn.addEventListener("click", async (event) => {
      event.stopPropagation();
      // [LIBRARY-PROFILE-ASSOCIATION] Soft-remove — takes this row out of
      // Recent Libraries but deliberately does NOT touch its Profile
      // association or identity (handle). Re-picking this same physical
      // folder later still recognizes it and recovers the association.
      // See library-registry.js.
      try {
        await removeFromRecents(record.id);
      } catch (error) {
        console.warn("[LIBRARY-REGISTRY] Could not remove this library from Recent Libraries.", error);
      }
      await renderRecentLibraries();
    });

    row.appendChild(openBtn);
    row.appendChild(removeBtn);
    fsaRecentLibrariesEl.appendChild(row);
  }
}

// [LIBRARY-PROFILE-UX / Phase 8.5]
// WHAT: The actual persistence step — associates whatever is CURRENTLY
// loaded with targetProfileId, branching on source kind exactly as the
// old direct click handler used to. Returns true/false so the explicit
// Profile-side association action can report whether it succeeded.
// WHY: Keeps the persistence logic separate from the Load Media shortcut,
// which is navigation-only.
// FUTURE: This is the ONE place that writes a library<->profile
// association. Do not duplicate this logic at a new call site — call this
// function instead.
async function associateCurrentLibraryWithProfile(targetProfileId) {
  if (!targetProfileId) return false;

  if (currentSourceKind === "legacy") {
    if (legacyHasDurableIdentity) {
      fsaAssociateBtn.disabled = true;
      profileAssociateBtn.disabled = true;
      try {
        let record = activeLibraryRecord;
        if (!record) {
          if (!pendingLegacySignature) return false; // nothing to create a record from
          record = await addLegacyLibrary(pendingLegacySignature);
        }

        const updated = await setLibraryProfile(record.id, targetProfileId);
        activeLibraryRecord = updated || { ...record, profileId: targetProfileId };
        pendingLegacySignature = null;
        logLegacyIdentity("associated profile id", { profileId: targetProfileId, libraryId: activeLibraryRecord.id });
        syncAssociateButtonVisibility();
        fsaStatusText.textContent =
          `Associated this folder with "${profile.getProfileName()}". ` +
          "It should be recognized next time you pick the same folder here.";
        return true;
      } catch (error) {
        console.warn("[LEGACY-IDENTITY] Could not save this legacy library association.", error);
        fsaStatusText.textContent = "Could not save the association. Try again.";
        return false;
      } finally {
        fsaAssociateBtn.disabled = false;
        profileAssociateBtn.disabled = false;
      }
    }

    // Ephemeral fallback ("Choose Files", no folder context) — see
    // legacySessionAssociated's own comment. Nothing is persisted;
    // re-loading (even the exact same files again) starts unassociated
    // again, by design.
    legacySessionAssociated = true;
    syncAssociateButtonVisibility();
    fsaStatusText.textContent = `Associated the current folder with "${profile.getProfileName()}" for this session.`;
    return true;
  }

  if (currentSourceKind !== "fsa" || !activeLibraryRecord || !activeLibraryRecord.id) return false;

  fsaAssociateBtn.disabled = true;
  profileAssociateBtn.disabled = true;
  try {
    const updated = await setLibraryProfile(activeLibraryRecord.id, targetProfileId);
    if (updated) activeLibraryRecord = updated;
    syncAssociateButtonVisibility();
    fsaStatusText.textContent = `Associated "${activeLibraryRecord.name}" with "${profile.getProfileName()}".`;
    await renderRecentLibraries();
    return true;
  } catch (error) {
    console.warn("[LIBRARY-REGISTRY] Could not associate this library with the current profile.", error);
    fsaStatusText.textContent = "Could not save the association. Try again.";
    return false;
  } finally {
    fsaAssociateBtn.disabled = false;
    profileAssociateBtn.disabled = false;
  }
}

// [LIBRARY-PROFILE-UX / Phase 8.5]
// WHAT: "Associate with Profile" / "Change Profile" — navigation only. No
// longer persists anything itself.
// WHY: Section 4/5 — clicking this must never write a profile association
// directly; it hands off to the Profile section, where the user can choose
// a profile and then click the explicit association button.
// FUTURE: If this ever needs to do more than "set intent + navigate", that
// is itself a sign the design boundary from section 4/6 is being crossed —
// reconsider before adding logic here.
fsaAssociateBtn.addEventListener("click", () => {
  if (currentSourceKind === "none") return;
  pendingLibraryAssociationIntent = true;
  expandAndScrollToProfileSection();
});

profileAssociateBtn.addEventListener("click", async () => {
  if (currentSourceKind === "none") return;
  await associateCurrentLibraryWithProfile(profile.getProfileId());
});

function setLoadingState(isLoading, total) {
  fileInput.disabled = isLoading;
  folderInput.disabled = isLoading;
  clearBtn.disabled = isLoading || !allItems.length;
  // [FSA] Prevent starting a second folder load (either source) while one
  // is already in progress — mirrors the existing fileInput/folderInput
  // disabling above.
  fsaChooseFolderBtn.disabled = isLoading;
  fsaRecentLibrariesEl.classList.toggle("is-loading", isLoading);

  if (isLoading) {
    statusText.textContent = total ? `Loading media… 0 / ${total}` : "Loading media…";
  }
}

function reloadRuntime({ preserveId, keepPlaying, randomizeInitial } = {}) {
  const wasPlaying = keepPlaying ?? runtime.getState().isPlaying;
  const visible = getVisibleItems();

  bumpGalleryGeneration();
  runtime.load(visible);

  if (preserveId) {
    const idx = visible.findIndex((item) => item.id === preserveId);
    if (idx >= 0) runtime.setCurrentIndex(idx);
  } else if (randomizeInitial && visible.length > 1) {
    // Used whenever the visible media SET fundamentally changes — a fresh
    // library load, a View switch (All <-> Favorites), or a Type switch
    // (All/Images/Videos) — so the newly-filtered set doesn't always open
    // on its first item. Never used for ordinary navigation (Next,
    // Previous, Hide, Undo Hide, slideshow ticks), which call
    // runtime.next()/previous() directly and never pass through here.
    // Goes through the existing setCurrentIndex path — same one preserveId
    // above already uses — so this isn't a new navigation mechanism, just
    // a different starting index fed into it.
    const randomIndex = Math.floor(Math.random() * visible.length);
    runtime.setCurrentIndex(randomIndex);
  }

  if (wasPlaying && visible.length) {
    runtime.play();
  }
}

// Random Initial Selection applies only to non-Favorites browsing (All /
// Images / Videos) — a fresh load or a View/Type switch there should still
// feel fresh rather than always opening on the same first item. Favorites
// is intentionally exempt: it's already self-ordering via "Recently
// Favorited First" (see getVisibleItems), so that ordering is the source
// of variation there, not a second, independent layer of randomization on
// top of it. Whenever Favorites is the resulting/active view — including a
// Type switch (Images/Videos) made while already browsing Favorites — this
// returns false, and reloadRuntime falls through to its existing "start at
// the first item in the filtered list" default. Centralized here so every
// call site (fresh load, View switch, Type switch) decides this the same
// way; reloadRuntime()'s own randomizeInitial handling is untouched.
function shouldRandomizeInitialSelection() {
  return viewMode !== "favorites";
}

function handleFavoriteToggle() {
  // Reacting to the change — including a currently-favorites-only view
  // needing to add/drop this item — is handled centrally by the profile
  // subscription set up at boot. It doesn't matter whether the change
  // came from this toggle, an Import, or anything else; there's exactly
  // one place that decides what a profile change means for the UI.
  runtime.toggleFavorite();
}

function setViewMode(mode) {
  if (viewMode === mode) return;

  viewMode = mode;
  allMediaBtn.classList.toggle("active", mode === "all");
  favoritesOnlyBtn.classList.toggle("active", mode === "favorites");
  viewModeText.textContent = mode === "all" ? "All Media" : "Favorites Only";

  // viewMode is already updated above, so this reflects the mode being
  // switched TO — e.g. All -> Favorites lands on the first (most recently
  // favorited) item deterministically, while Favorites -> All randomizes
  // again now that Favorites' curated ordering is no longer in play.
  reloadRuntime({ keepPlaying: runtime.getState().isPlaying, randomizeInitial: shouldRandomizeInitialSelection() });
}

function setTypeFilter(type) {
  if (typeFilter === type) return;

  typeFilter = type;
  typeAllBtn.classList.toggle("active", type === "all");
  typeImagesBtn.classList.toggle("active", type === "image");
  typeVideosBtn.classList.toggle("active", type === "video");

  // Shuffle, Presentation, and Slideshow all draw from whatever
  // getVisibleItems() hands to runtime.load() below — there's no separate
  // Type control for them because they already can't see anything this
  // filter excludes.
  //
  // Whether this randomizes depends on the CURRENT viewMode, not the type
  // being switched to — e.g. Favorites -> Images stays deterministic
  // (Favorites is still active, just narrowed by type), while All ->
  // Images still randomizes.
  reloadRuntime({ keepPlaying: runtime.getState().isPlaying, randomizeInitial: shouldRandomizeInitialSelection() });
}

// ---- Gallery Tag Filtering (Phase 6.3) -------------------------------------
//
// Plugs into the exact same shared pipeline as View/Type (getVisibleItems
// -> filterMedia) rather than being a parallel filtering mechanism.
// Multiple tags can be active at once — filterMedia AND-combines them (an
// item must carry every active tag), matching the Fast Tagging panel's own
// multi-select, click-to-toggle interaction.

function toggleTagFilter(tagId) {
  activeTagFilters = activeTagFilters.includes(tagId)
    ? activeTagFilters.filter((id) => id !== tagId)
    : [...activeTagFilters, tagId];

  renderTagsFilterGrid();

  // Same reasoning as setViewMode/setTypeFilter: the visible set just
  // fundamentally changed, so it gets the same "randomize unless browsing
  // Favorites" treatment as any other filter narrowing.
  reloadRuntime({ keepPlaying: runtime.getState().isPlaying, randomizeInitial: shouldRandomizeInitialSelection() });
}

function renderTagsFilterGrid() {
  const tags = profile.getTags();

  tagsFilterEmpty.classList.toggle("hidden", tags.length > 0);
  tagsFilterGrid.classList.toggle("hidden", tags.length === 0);
  tagsFilterGrid.innerHTML = "";

  tags.forEach((tag) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tag-filter-btn filter-btn";
    btn.textContent = tag.name;
    const isActive = activeTagFilters.includes(tag.id);
    btn.classList.toggle("active", isActive);
    btn.setAttribute("aria-pressed", isActive ? "true" : "false");
    btn.addEventListener("click", () => toggleTagFilter(tag.id));
    tagsFilterGrid.appendChild(btn);
  });
}

function toggleTagsFilterPanel() {
  tagsFilterPanel.classList.toggle("hidden");
  tagsFilterToggleBtn.setAttribute(
    "aria-expanded",
    tagsFilterPanel.classList.contains("hidden") ? "false" : "true"
  );
}

function syncVideoLoopControl() {
  const enabled = videoLoopInput.checked;
  videoLoopControl.classList.toggle("is-enabled", enabled);
  // Toolbar resizing/polish pass (Change C1): the visible control shows
  // only the 🔁 icon now — ON/OFF is communicated by color/glow (see
  // .loop-toggle-control.is-enabled) plus this title tooltip, not by text
  // in the button itself.
  videoLoopControl.title = enabled ? "Loop: ON (click to disable)" : "Loop: OFF (click to enable)";

  // Loop Rules cannot exist independently — they're only ever available
  // while the master Loop toggle itself is on. The button itself stays
  // clickable either way (Phase 5.2): when Loop is off, clicking it turns
  // Loop on for you (see the click handler below) instead of requiring a
  // separate step first. is-available is purely visual here now.
  overlayAutomationBtn.classList.toggle("is-available", enabled);

  if (!enabled) {
    // "Turning Loop OFF immediately disables the active Loop Rule."
    activeLoopRule = { type: "forever" };
    loopRuleCompletedPlays = 0;
    clearLoopRuleTimer();
    closeAutomationEditor();
  } else {
    // Loop was just turned on with a video already on screen — arm
    // whatever rule is currently configured for it right away, rather
    // than waiting for that video to happen to end first.
    applyLoopRuleToCurrentVideo();
  }
}

// ---- Loop Automations engine ----------------------------------------------

function clearLoopRuleTimer() {
  if (loopRuleTimerId !== null) {
    window.clearTimeout(loopRuleTimerId);
    loopRuleTimerId = null;
  }
}

// Arms whatever the active rule needs for the video CURRENTLY on screen,
// without treating it as a new video (does not bump loopRuleVideoToken).
// Used when the rule changes (Apply) or Loop is turned on mid-video.
function applyLoopRuleToCurrentVideo() {
  loopRuleCompletedPlays = 0;
  clearLoopRuleTimer();

  const isShowingVideo = currentViewerNode && currentViewerNode.tagName === "VIDEO";

  if (activeLoopRule.type === "timer" && videoLoopInput.checked && isShowingVideo) {
    const durationMs = (activeLoopRule.minutes * 60 + activeLoopRule.seconds) * 1000;
    if (durationMs > 0) {
      const token = loopRuleVideoToken;
      loopRuleTimerId = window.setTimeout(() => {
        loopRuleTimerId = null;
        // Ignore this firing if a different video/rule has since
        // superseded it — otherwise a slow/expired timer from a previous
        // video could advance Presentation a second, unrelated time.
        if (token === loopRuleVideoToken) {
          completeFiniteLoopAutomationAndAdvance();
        }
      }, durationMs);
    }
  }
}

// Called once per genuinely new video shown (from buildViewer). Bumps the
// token (invalidating any still-pending timer/listener from the previous
// video) and returns the fresh token for that video's own "ended" listener
// to capture and compare against later.
function armLoopRuleForCurrentVideo() {
  loopRuleVideoToken += 1;
  applyLoopRuleToCurrentVideo();
  return loopRuleVideoToken;
}

// Called from the video "ended" listener when the master Loop toggle is on,
// Presentation is playing, and the active rule is "times". Returns true if
// the video should replay (another play is still owed) or false once the
// requested total has been reached. Naming: `loopRuleCompletedPlays` is
// plays that have actually finished; `activeLoopRule.totalPlays` is the
// total number of plays requested (including the one already in progress
// when Apply was clicked) — NOT a count of "extra" replays on top of that.
function shouldLoopRuleRestartVideo() {
  loopRuleCompletedPlays += 1; // this "ended" event just finished one play
  return loopRuleCompletedPlays < activeLoopRule.totalPlays;
}

// Centralized completion path for a finite automation (X Times reaching its
// requested total, or Until Timer's countdown firing) — the ONLY place
// either finite mode reaches its end. Per the lifecycle rule "Loop +
// Automation applies only to the current media item": this must run BEFORE
// advancing, so the item being left behind can't restart itself, and the
// next item always starts with Loop off / no inherited automation.
function completeFiniteLoopAutomationAndAdvance() {
  clearLoopRuleTimer();
  // Bump the token too: invalidates a same-tick race between a pending
  // "timer" setTimeout and a video "ended" event for this same video,
  // beyond what clearing the timer/rule alone would guard against.
  loopRuleVideoToken += 1;

  activeLoopRule = { type: "forever" };
  loopRuleCompletedPlays = 0;

  videoLoopInput.checked = false;
  syncVideoLoopControl(); // turns 🔁 UI off, disables/greys 🤖 — Loop is now genuinely off
  closeAutomationEditor();

  runtime.notifyVideoEnded(); // advance exactly once
}

// Manual Next/Previous during an in-progress finite automation must not let
// it keep running against whatever media the user navigates to — but per
// the refinement spec, manual navigation does not itself force Loop off
// (that's an explicit, separate lifecycle rule that only applies to finite
// automation *completion*). This only invalidates the finite rule's
// progress/timer; it does not touch videoLoopInput or activeLoopRule.type.
function invalidateActiveFiniteAutomation() {
  if (activeLoopRule.type === "forever") return;

  clearLoopRuleTimer();
  loopRuleVideoToken += 1;
  loopRuleCompletedPlays = 0;
  activeLoopRule = { type: "forever" };
}

// ---- Manual-navigation Loop/Automation reset (Presentation Mode regression
// pass) ----------------------------------------------------------------
//
// Single entry point for every manual-navigation control — Gallery
// Prev/Next, Presentation overlay Prev/Next, and Presentation keyboard
// Left/Right — so the branching below exists exactly once rather than at
// each call site.
//
// There are two cases:
//
// 1. Ordinary indefinite looping — the plain 🔁 toggle with no automation
//    configured, and the "Forever" automation choice, are the SAME
//    `activeLoopRule.type === "forever"` state (see the block comment
//    above `activeLoopRule`'s declaration). It belongs to the item being
//    left, not whatever the user is navigating to, so manual navigation
//    ends it outright: Loop OFF, automation reset, panel closed — routed
//    through the exact same syncVideoLoopControl() path the 🔁 checkbox's
//    own change listener uses, so there is still only one way Loop ever
//    turns off.
//
// 2. Finite automations (X Times / Until Timer) are explicitly EXEMPT from
//    the above — they keep using the existing, already-working
//    invalidateActiveFiniteAutomation() behavior (cancel only that rule's
//    progress/timer; the master Loop toggle itself is left alone). Their
//    counting/timer/completion/handoff lifecycle is untouched by this
//    function.
function handleManualNavigationLoopReset() {
  if (videoLoopInput.checked && activeLoopRule.type === "forever") {
    // [DEBUG-8.4-MANUAL-NAV-RESET] Ordinary infinite Loop / Forever
    // automation is cancelled here on manual navigation.
    videoLoopInput.checked = false;
    syncVideoLoopControl();
    return;
  }

  invalidateActiveFiniteAutomation();
}

function resetLoopRuleToDefault() {
  activeLoopRule = { type: "forever" };
  loopRuleCompletedPlays = 0;
  clearLoopRuleTimer();
  loopRuleVideoToken += 1; // invalidate any in-flight "ended"/timer callback
  closeAutomationEditor();
}

// ---- Automation editor (draft) state ---------------------------------------
//
// Deliberately separate from `activeLoopRule` above (the APPLIED rule).
// Opening the row, clicking a type, Back, or nudging a stepper only ever
// changes this draft; nothing here reaches `activeLoopRule` until Apply.
let automationEditorStep = "choose"; // "choose" | "times" | "timer"
let automationDraftTotalPlays = 5;
let automationDraftMinutes = 0;
let automationDraftSeconds = 0;

function renderAutomationEditor() {
  automationStepChoose.classList.toggle("hidden", automationEditorStep !== "choose");
  automationStepTimes.classList.toggle("hidden", automationEditorStep !== "times");
  automationStepTimer.classList.toggle("hidden", automationEditorStep !== "timer");

  automationTimesValueEl.textContent = String(automationDraftTotalPlays);
  automationTimerMinutesValueEl.textContent = String(automationDraftMinutes);
  automationTimerSecondsValueEl.textContent = String(automationDraftSeconds);
}

function openAutomationEditor() {
  automationEditorStep = "choose";
  renderAutomationEditor();
  automationPanel.classList.remove("hidden");
}

// The one shared close path (per "prefer a shared panel-state function
// rather than duplicating close logic") — used by Apply, Back-to-close,
// the 🤖 toggle, Loop turning off, finite-automation completion, and
// exiting Presentation. Always resets the draft back to the first step, so
// reopening later never shows stale values from a discarded edit.
function closeAutomationEditor() {
  automationPanel.classList.add("hidden");
  automationEditorStep = "choose";
  automationDraftTotalPlays = 5;
  automationDraftMinutes = 0;
  automationDraftSeconds = 0;
  renderAutomationEditor();
}

function setAutomationEditorStep(step) {
  automationEditorStep = step;
  renderAutomationEditor();
}

// ---- Fill Panel (simulated fullscreen) ---------------------------------

function enterFillMode() {
  if (fillModeActive) return;

  fillModeActive = true;
  appShell.classList.add("simulated-fullscreen");
  layoutEl.classList.add("simulated-fullscreen-layout");
  viewerPanel.classList.add("simulated-fullscreen-viewer");
  presentationControls.classList.remove("hidden");
}

function exitFillMode() {
  if (!fillModeActive) return;

  // Leaving Presentation is also an explicit end to its playback session.
  // MediaRuntime owns the timer and playing state, so use its established
  // stop path rather than keeping any presentation-specific playback state.
  runtime.stop();
  fillModeActive = false;
  appShell.classList.remove("simulated-fullscreen");
  layoutEl.classList.remove("simulated-fullscreen-layout");
  viewerPanel.classList.remove("simulated-fullscreen-viewer");
  presentationControls.classList.add("hidden");
  presentationSettings.classList.add("hidden");
  closeGhostPopunder();
  automationPanel.classList.add("hidden");
  // "Ending Presentation clears the active Loop Rule. Nothing is
  // persisted." — Loop Rules are session-local by design (Phase 5).
  resetLoopRuleToDefault();
}

function applyGhostOpacity(percent) {
  currentGhostOpacityPercent = percent;
  presentationControls.style.setProperty("--ghost-opacity", String(percent / 100));
  ghostOpacityLabel.textContent = `${percent}%`;
}

// UI/UX Polish — the Ghost Opacity slider moved out of always-visible space
// in #presentation-settings into its own compact 👻 pop-under. Purely a
// relocation: applyGhostOpacity above (and everything that calls it) is
// completely untouched.
function closeGhostPopunder() {
  ghostPopunder.classList.add("hidden");
  ghostToggleBtn.classList.remove("is-open");
  ghostToggleBtn.setAttribute("aria-expanded", "false");
}

function toggleGhostPopunder() {
  const willOpen = ghostPopunder.classList.contains("hidden");
  ghostPopunder.classList.toggle("hidden", !willOpen);
  ghostToggleBtn.classList.toggle("is-open", willOpen);
  ghostToggleBtn.setAttribute("aria-expanded", willOpen ? "true" : "false");
}

function togglePlay() {
  if (runtime.getState().isPlaying) {
    runtime.stop();
  } else {
    runtime.play();
  }
}

// ---- Rendering ---------------------------------------------------------

// [TS-POC] Extension check only — kept local to main.js's routing
// decision rather than added as a new MediaItem field, since this branch
// exists to answer a feasibility question, not to grow the item schema.
function isTsItem(item) {
  return typeof item.name === "string" && item.name.toLowerCase().endsWith(".ts");
}

function clearViewerNode() {
  // Unconditional and cheap even when the outgoing item wasn't .ts — see
  // TsPlaybackAdapter#detach()'s own comment for why this is the simplest
  // correct place to guarantee cleanup on every item change.
  tsPlaybackAdapter.detach();

  if (currentViewerNode && currentViewerNode.tagName === "VIDEO") {
    currentViewerNode.pause();
    currentViewerNode.removeAttribute("src");
    currentViewerNode.load();
  }

  viewerStage.innerHTML = "";
  currentViewerNode = null;
  currentViewerItem = null;
}

function buildViewer(state) {
  const { currentItem: item, isPlaying, hasItems, hasVisibleItems } = state;

  // Items are loaded, but every one of them is hidden (Success Criteria
  // Scenario 7) — show a specific message rather than the empty-library
  // one, and never render the (still technically "current") hidden item.
  if (hasItems && !hasVisibleItems) {
    clearViewerNode();
    viewerStage.classList.add("hidden");
    viewerEmpty.classList.remove("hidden");
    viewerEmpty.textContent = "All media is hidden. Unhide items in the Gallery to continue.";
    return;
  }

  // Profile changes emit a fresh runtime state, but they do not change the
  // media being viewed. Keep the existing node in that case so a video keeps
  // its current time instead of being recreated at 0:00.
  if (item && currentViewerItem === item && currentViewerNode) {
    if (currentViewerNode.tagName === "VIDEO") {
      if (isPlaying) {
        currentViewerNode.play().catch(() => {
          // ignore autoplay failures
        });
      } else {
        currentViewerNode.pause();
      }
    }
    return;
  }

  clearViewerNode();

  if (!item) {
    viewerStage.classList.add("hidden");
    viewerEmpty.classList.remove("hidden");
    viewerEmpty.textContent = "Choose files or a folder to begin.";
    return;
  }

  viewerEmpty.classList.add("hidden");
  viewerStage.classList.remove("hidden");
  currentViewerItem = item;

  if (item.kind === "image") {
    const img = document.createElement("img");
    img.src = item.url;
    img.alt = item.name;
    currentViewerNode = img;
    viewerStage.appendChild(img);
    return;
  }

  if (item.kind === "video") {
    const video = document.createElement("video");
    video.controls = true;
    video.playsInline = true;
    video.preload = "metadata";
    video.muted = true;
    currentViewerNode = video;
    viewerStage.appendChild(video);

    if (isTsItem(item)) {
      // [TS-POC] Phase 5 diagnostic timing — counter-based ID only, never
      // the filename/path, per the branch's logging requirement.
      const diagnosticId = `ts-${++tsDiagnosticCounter}`;
      tsPlaybackAdapter.attach(video, item.file, {
        onTiming: (label, elapsedMs) => {
          console.log(`[TS TEST] ${diagnosticId} ${label}: ${elapsedMs.toFixed(1)}ms`);
        },
      });
    } else {
      video.src = item.url;
    }

    // A fresh video is on screen — arm whatever the active Loop Rule
    // needs for it (e.g. start an "Until Timer" countdown), and capture
    // the token this listener should keep matching against.
    const loopRuleToken = armLoopRuleForCurrentVideo();

    video.addEventListener("ended", () => {
      // A newer video/rule has since superseded this listener (stale, left
      // over from a video that's no longer current, or a just-completed
      // finite automation) — do nothing.
      if (loopRuleToken !== loopRuleVideoToken) return;

      if (fillModeActive && videoLoopInput.checked && runtime.getState().isPlaying) {
        if (activeLoopRule.type === "times") {
          if (shouldLoopRuleRestartVideo()) {
            video.currentTime = 0;
            video.play().catch(() => {
              // ignore autoplay failures
            });
            return;
          }
          // Requested total plays reached — this is completion, not just
          // "don't restart": Loop must turn off and the rule must clear
          // before advancing (see completeFiniteLoopAutomationAndAdvance).
          completeFiniteLoopAutomationAndAdvance();
          return;
        }

        if (activeLoopRule.type === "timer") {
          // The armed setTimeout (see applyLoopRuleToCurrentVideo) is what
          // advances Presentation once time is up, independent of this
          // event — until it fires, every natural video end just replays.
          video.currentTime = 0;
          video.play().catch(() => {
            // ignore autoplay failures
          });
          return;
        }

        // "forever" (and any unrecognized type, defensively) — loop
        // indefinitely until manually advanced, per Requirement 6.
        video.currentTime = 0;
        video.play().catch(() => {
          // ignore autoplay failures
        });
        return;
      }

      runtime.notifyVideoEnded();
    });

    if (isPlaying) {
      video.play().catch(() => {
        // ignore autoplay failures
      });
    }

    return;
  }
}

function renderGallery(state) {
  const sameList =
    renderedGalleryGeneration === galleryGeneration && galleryCardEls.length === state.items.length;

  if (sameList) {
    updateGalleryHighlightsAndBadges(state);
    return;
  }

  fullRebuildGallery(state);
  renderedGalleryGeneration = galleryGeneration;
}

// Cheap path: item list is unchanged (e.g. slideshow advanced, next/prev
// clicked), so just move the "active" highlight and refresh favorite
// badges instead of rebuilding every card.
function updateGalleryHighlightsAndBadges(state) {
  galleryCardEls.forEach((card, index) => {
    card.classList.toggle("active", index === state.currentIndex);

    const item = state.items[index];
    const thumb = galleryThumbEls[index];
    let favoriteBadge = thumb.querySelector(".gallery-favorite-badge");

    if (item.isFavorite && !favoriteBadge) {
      favoriteBadge = document.createElement("div");
      favoriteBadge.className = "gallery-favorite-badge";
      favoriteBadge.textContent = "♥";
      thumb.appendChild(favoriteBadge);
    } else if (!item.isFavorite && favoriteBadge) {
      favoriteBadge.remove();
    }

    let hiddenBadge = thumb.querySelector(".gallery-hidden-badge");

    if (item.isHidden && !hiddenBadge) {
      hiddenBadge = document.createElement("div");
      hiddenBadge.className = "gallery-hidden-badge";
      hiddenBadge.textContent = "🙈";
      thumb.appendChild(hiddenBadge);
    } else if (!item.isHidden && hiddenBadge) {
      hiddenBadge.remove();
    }

    card.classList.toggle("is-hidden-media", Boolean(item.isHidden));
  });
}

// Expensive path: the item list itself changed (new load, filter switch,
// item dropped from Favorites Only). Rebuilds all cards, but each card's
// actual <img>/<video> is NOT created here — see mountThumbMedia(), which
// only runs once a card's thumbnail scrolls near the viewport. That's what
// keeps a 1000+ item gallery from mounting 1000 live video elements at once.
function fullRebuildGallery(state) {
  if (galleryObserver) {
    galleryObserver.disconnect();
    galleryObserver = null;
  }

  galleryGrid.innerHTML = "";
  galleryCardEls = [];
  galleryThumbEls = [];
  galleryJumpTargetIndex = null;

  if (!state.items.length) {
    galleryGrid.classList.add("hidden");
    galleryEmpty.classList.remove("hidden");
    galleryCount.textContent = "0 items";
    return;
  }

  galleryEmpty.classList.add("hidden");
  galleryGrid.classList.remove("hidden");
  galleryCount.textContent = `${state.items.length} item${state.items.length === 1 ? "" : "s"}`;

  galleryObserver = new IntersectionObserver(handleThumbIntersect, {
    root: null,
    rootMargin: THUMB_LAZY_ROOT_MARGIN,
    threshold: 0.01,
  });

  state.items.forEach((item, index) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "gallery-card";
    if (index === state.currentIndex) {
      card.classList.add("active");
    }

    const thumb = document.createElement("div");
    thumb.className = "gallery-thumb";
    thumb.dataset.mounted = "false";
    thumb._galleryItem = item;

    if (item.isFavorite) {
      const badge = document.createElement("div");
      badge.className = "gallery-favorite-badge";
      badge.textContent = "♥";
      thumb.appendChild(badge);
    }

    if (item.isHidden) {
      const hiddenBadge = document.createElement("div");
      hiddenBadge.className = "gallery-hidden-badge";
      hiddenBadge.textContent = "🙈";
      thumb.appendChild(hiddenBadge);
      card.classList.add("is-hidden-media");
    }

    const meta = document.createElement("div");
    meta.className = "gallery-meta";

    const name = document.createElement("div");
    name.className = "gallery-name";
    name.textContent = item.name;

    const type = document.createElement("div");
    type.className = "gallery-type";
    type.textContent = item.kind === "video" ? "Video" : "Image";

    meta.appendChild(name);
    meta.appendChild(type);

    card.appendChild(thumb);
    card.appendChild(meta);

    card.addEventListener("click", () => {
      clearGalleryJumpTarget();
      runtime.setCurrentIndex(index);
      viewerPanel.scrollIntoView({ behavior: "smooth", block: "start" });
    });

    galleryGrid.appendChild(card);
    galleryCardEls.push(card);
    galleryThumbEls.push(thumb);
    galleryObserver.observe(thumb);
  });
}

function handleThumbIntersect(entries) {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    mountThumbMedia(entry.target);
    galleryObserver.unobserve(entry.target);
  }
}

function mountThumbMedia(thumb) {
  const item = thumb._galleryItem;
  if (!item || thumb.dataset.mounted === "true") return;

  let mediaEl;

  if (item.kind === "image") {
    mediaEl = document.createElement("img");
    mediaEl.src = item.url;
    mediaEl.alt = item.name;
  } else if (item.kind === "video") {
    mediaEl = document.createElement("video");
    mediaEl.src = item.url;
    mediaEl.muted = true;
    mediaEl.preload = "metadata";
  } else {
    mediaEl = document.createElement("span");
    mediaEl.textContent = "Unsupported";
  }

  thumb.insertBefore(mediaEl, thumb.firstChild);
  thumb.dataset.mounted = "true";
}

function syncFavoriteButtons(item) {
  // ProfileStore is the ONLY source of truth for Favorite state. Read it
  // directly here at render time instead of trusting item.isFavorite (a
  // cached stamp the Runtime maintains) — that keeps the button correct
  // even if something upstream someday forgets to re-stamp an item, and
  // means it's never displaying anything other than what's actually
  // persisted right now.
  const isFavorite = Boolean(item && profile.isFavorite(item.relativePath));

  favoriteBtn.classList.toggle("hidden", !item);
  favoriteBtn.classList.toggle("is-favorite", isFavorite);
  favoriteBtn.textContent = isFavorite ? "♥" : "♡";

  overlayFavoriteBtn.classList.toggle("hidden", !item);
  overlayFavoriteBtn.classList.toggle("is-favorite", isFavorite);
  overlayFavoriteBtn.textContent = isFavorite ? "♥" : "♡";
}

function syncHideButton(item) {
  const isHidden = Boolean(item && item.isHidden);

  // In the ordinary case item.isHidden is always false here, since the
  // runtime moves off a hidden current item on its own — this only ever
  // reads true in the brief instant right before that happens.
  overlayHideBtn.classList.toggle("hidden", !item);
  overlayHideBtn.classList.toggle("is-hidden", isHidden);
}

function syncUndoHideButton() {
  overlayUndoHideBtn.disabled = lastHiddenRelativePath === null;
}

// ---- Presentation Mode Tags panel (Phase 6.2 — Fast Tagging) --------------
//
// Lives in the "⚙ row" alongside 👻 + the "Tags" label — all sharing one
// bar-height row (up to 4 tag chips fit there). Unlike the Loop Automation
// editor, this panel is deliberately NOT closed after each click —
// tagging is a repeated action ("Next → Tag → Next → Tag"), and closing on
// every click would interrupt that flow. It only closes when the user
// presses ⚙ again (see overlaySettingsBtn's own toggle) or exits
// Presentation. One click assigns a tag; the same click again removes it
// — no dialog, no typing, no Save button.
function makePresentationTagButton(tag, appliedTagIds, item) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "presentation-tag-btn";
  btn.textContent = tag.name;
  btn.disabled = !item;
  btn.classList.toggle("is-applied", appliedTagIds.has(tag.id));
  btn.setAttribute("aria-pressed", appliedTagIds.has(tag.id) ? "true" : "false");

  btn.addEventListener("click", () => {
    if (!item) return;
    const state = runtime.getState();
    const isApplying = !profile.hasItemTag(item.relativePath, tag.id);
    profile.toggleItemTag(item.relativePath, tag.id);
    if (isApplying) {
      // [8.4] Shuffle context travels WITH the activity record it
      // describes, not as separate global state — a later switch of the
      // Shuffle toggle must never retroactively relabel what this specific
      // tagging pass meant. See ProfileStore#recordTagActivity's own note.
      profile.recordTagActivity(tag.id, {
        position: state.currentIndex + 1,
        total: state.total,
        shuffle: state.shuffle,
      });
    }
    // No re-render call needed here — profile.subscribe() below re-runs
    // this same function once the toggle lands, keeping this a single
    // source of truth for what the grid shows.
  });

  return btn;
}

function renderPresentationTagsPanel(item) {
  const tags = profile.getTags();

  presentationTagsEmpty.classList.toggle("hidden", tags.length > 0);
  presentationTagsRow.classList.toggle("hidden", tags.length === 0);
  presentationTagsRow.innerHTML = "";
  presentationTagsOverflow.innerHTML = "";
  presentationTagsOverflow.classList.toggle("hidden", tags.length <= 4);

  if (!tags.length) return;

  // Read applied tags directly from ProfileStore rather than
  // item.userTags (a cached stamp) — same reasoning as syncFavoriteButtons:
  // never display anything other than what's actually persisted right now.
  const appliedTagIds = item ? new Set(profile.getItemTags(item.relativePath)) : new Set();

  // First 4 tags share the "⚙ row" (with 👻 + the "Tags" label). Anything
  // beyond that starts a new row underneath, same 4-per-row shape, rather
  // than growing the shared row sideways.
  tags.slice(0, 4).forEach((tag) => {
    presentationTagsRow.appendChild(makePresentationTagButton(tag, appliedTagIds, item));
  });
  tags.slice(4).forEach((tag) => {
    presentationTagsOverflow.appendChild(makePresentationTagButton(tag, appliedTagIds, item));
  });
}

// ---- Gallery Media Navigation (Phase 1) ------------------------------------
//
// "Jump to" reuses the SAME visible-items sequence the runtime/filter
// pipeline already produces (state.items / galleryCardEls, built in
// fullRebuildGallery from that exact same state) — no second ordering
// system, no bypassing the existing Viewer loading mechanism, no touching
// the Gallery's lazy thumbnail mounting (scrollIntoView just brings a
// card into the IntersectionObserver's view like scrolling by hand would).

function setGalleryJumpMode(mode) {
  galleryJumpMode = mode;
  galleryJumpModeFindBtn.classList.toggle("active", mode === "find");
  galleryJumpModePlayBtn.classList.toggle("active", mode === "play");
  galleryJumpModeFindBtn.setAttribute("aria-pressed", mode === "find" ? "true" : "false");
  galleryJumpModePlayBtn.setAttribute("aria-pressed", mode === "play" ? "true" : "false");
}

function clearGalleryJumpTarget() {
  if (galleryJumpTargetIndex !== null) {
    galleryCardEls[galleryJumpTargetIndex]?.classList.remove("gallery-jump-highlight");
  }
  galleryJumpTargetIndex = null;
}

// Placeholder-only — never becomes the input's actual value. Native
// `placeholder` already guarantees focusing the field doesn't populate it,
// so no extra focus/blur handling is needed to satisfy that requirement.
function updateGalleryJumpPlaceholder(state) {
  galleryJumpInput.placeholder = state.hasItems ? `${state.currentIndex + 1} / ${state.total}` : "";
}

function flashInvalidGalleryJumpInput() {
  galleryJumpInput.classList.remove("is-invalid");
  // Force a reflow so re-adding the class restarts, even if a previous
  // flash's timeout hasn't cleared it yet (rapid repeated invalid Enters).
  void galleryJumpInput.offsetWidth;
  galleryJumpInput.classList.add("is-invalid");
  window.setTimeout(() => galleryJumpInput.classList.remove("is-invalid"), 500);
}

// [8.5] "find"/"play" (galleryJumpMode) ARE the search-vs-direct jump
// distinction the product spec asks for — not a separate mechanism to
// build. Both already jump within whatever search/filter context is
// currently active (state.total already reflects getVisibleItems(), see
// the comment at this control's HTML). "find" = SEARCH jump: locate a
// position in that context (scroll/highlight only, nothing loads).
// "play" = DIRECT jump: unconditionally load that position into the
// Viewer. Keeping these two names/behaviors distinct (rather than
// collapsing to one "jump" now that 8.3 adds a real filter-apply action)
// matters for the next phase too: once FSA master-folder auto-detection
// exists, "direct jump" must keep meaning "load it, full stop" even if a
// future profile/folder switch changes what's in the search context.
function performGalleryJump() {
  const state = runtime.getState();
  const raw = galleryJumpInput.value.trim();

  // Human-readable 1-based numbering only. Anything that isn't a plain
  // positive integer (empty, negative, decimal, non-numeric) is rejected
  // outright rather than guessed at.
  if (!/^\d+$/.test(raw)) {
    flashInvalidGalleryJumpInput();
    return;
  }

  const oneBased = Number(raw);
  if (!state.total || oneBased < 1 || oneBased > state.total) {
    flashInvalidGalleryJumpInput();
    return;
  }

  const zeroBasedIndex = oneBased - 1;

  if (galleryJumpMode === "play") {
    // "Take me there and load it" — the exact same call a Gallery card
    // click already makes.
    clearGalleryJumpTarget();
    runtime.setCurrentIndex(zeroBasedIndex);
    viewerPanel.scrollIntoView({ behavior: "smooth", block: "start" });
  } else {
    // "Take me to this part of my library" — scroll only, Viewer/
    // currentIndex untouched.
    const card = galleryCardEls[zeroBasedIndex];
    if (card) {
      clearGalleryJumpTarget();
      galleryJumpTargetIndex = zeroBasedIndex;
      card.scrollIntoView({ behavior: "smooth", block: "center" });
      card.classList.add("gallery-jump-highlight");
    }
  }

  galleryJumpInput.value = "";
}

galleryJumpModeFindBtn.addEventListener("click", () => {
  setGalleryJumpMode("find");
  performGalleryJump();
});
galleryJumpModePlayBtn.addEventListener("click", () => {
  setGalleryJumpMode("play");
  performGalleryJump();
});
galleryJumpInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  performGalleryJump();
});

function syncControls(state) {
  const hasItems = state.hasItems;
  const canNavigate = state.hasVisibleItems;

  prevBtn.disabled = !canNavigate;
  nextBtn.disabled = !canNavigate;
  playBtn.disabled = !canNavigate || state.isPlaying;
  stopBtn.disabled = !state.isPlaying;
  clearBtn.disabled = isLoadingFiles || !allItems.length;

  overlayPrevBtn.disabled = !canNavigate;
  overlayNextBtn.disabled = !canNavigate;
  overlayHideBtn.disabled = !state.currentItem;

  if (hasItems && !canNavigate) {
    statusText.textContent = "All media is hidden";
  } else if (state.waitingOnVideo) {
    statusText.textContent = "Slideshow running (playing video)";
  } else if (state.isPlaying) {
    statusText.textContent = "Slideshow running";
  } else if (hasItems) {
    statusText.textContent = "Media loaded";
  } else {
    statusText.textContent = "No media loaded";
  }

  selectedText.textContent = state.currentItem ? state.currentItem.name : "—";
  counterText.textContent = hasItems ? `${state.currentIndex + 1} / ${state.total}` : "0 / 0";

  overlayPlayBtn.textContent = state.isPlaying ? "⏸" : "⏯";

  syncFavoriteButtons(state.currentItem);
  syncHideButton(state.currentItem);
  renderPresentationTagsPanel(state.currentItem);
}

function render(state) {
  renderGallery(state);
  buildViewer(state);
  syncControls(state);
  updateGalleryJumpPlaceholder(state);
}

// ---- Event wiring ---------------------------------------------------------

fileInput.addEventListener("change", (event) => {
  loadFiles(event.target.files);
  fileInput.value = "";
});

folderInput.addEventListener("change", (event) => {
  const files = event.target.files;

  // Record which top-level folder this profile is currently associated
  // with (Phase 8.1 — Multi-Profile Foundation). Purely descriptive
  // metadata — the folder's own name, nothing more. No matching/detection
  // happens here or anywhere yet; that's deferred to a later phase.
  const firstFile = files && files[0];
  const topFolderName = firstFile && firstFile.webkitRelativePath ? firstFile.webkitRelativePath.split("/")[0] : null;
  if (topFolderName) profile.setMasterFolder({ name: topFolderName });

  // [Phase 8.4-3] isFolderPick=true is what unlocks durable legacy
  // identity in loadFiles() — the plain "Choose Files" input below never
  // sets this, since a set of individually-picked files has no folder
  // root to fingerprint against.
  loadFiles(files, { isFolderPick: true, rootName: topFolderName });
  folderInput.value = "";
});

intervalInput.addEventListener("change", () => {
  runtime.setIntervalMs(Number(intervalInput.value) * 1000);
  savePlaybackPreferences({ intervalSeconds: Number(intervalInput.value) });
});

function adjustInterval(direction) {
  if (direction < 0) {
    intervalInput.stepDown();
  } else {
    intervalInput.stepUp();
  }

  // Button presses use the same constrained input and change handler as
  // keyboard edits, so slideshow timing behavior remains identical.
  intervalInput.dispatchEvent(new Event("change"));
}

intervalDecreaseBtn.addEventListener("click", () => adjustInterval(-1));
intervalIncreaseBtn.addEventListener("click", () => adjustInterval(1));

shuffleInput.addEventListener("change", () => {
  runtime.setShuffle(shuffleInput.checked);
  savePlaybackPreferences({ shuffle: shuffleInput.checked });
});

skipDuplicatesInput.addEventListener("change", () => {
  const currentItem = runtime.getState().currentItem;
  skipDuplicates = skipDuplicatesInput.checked;
  savePlaybackPreferences({ skipDuplicates });

  // WHAT: A suppressed current copy resolves to the retained equivalent before rebuilding the runtime list.
  // WHY: Live toggling must not strand the viewer or jump arbitrarily when an exact duplicate remains playable.
  // FUTURE / DO-NOT-BREAK: Reconciliation is by view-only duplicate key; never rewrite either item's id or Profile metadata.
  const retainedEquivalent = skipDuplicates
    ? getVisibleItems().find((item) => haveSameDuplicateKey(item, currentItem))
    : null;
  reloadRuntime({
    preserveId: retainedEquivalent?.id || currentItem?.id,
    keepPlaying: runtime.getState().isPlaying,
  });
});

loopInput.addEventListener("change", () => {
  runtime.setLoop(loopInput.checked);
  savePlaybackPreferences({ loopPlaylist: loopInput.checked });
});

videoLoopInput.addEventListener("change", syncVideoLoopControl);

fillInput.addEventListener("change", () => {
  if (fillInput.checked && runtime.getState().isPlaying) {
    enterFillMode();
  } else if (!fillInput.checked) {
    exitFillMode();
  }
  savePlaybackPreferences({ fillPanel: fillInput.checked });
});

allMediaBtn.addEventListener("click", () => setViewMode("all"));
favoritesOnlyBtn.addEventListener("click", () => setViewMode("favorites"));

typeAllBtn.addEventListener("click", () => setTypeFilter("all"));
typeImagesBtn.addEventListener("click", () => setTypeFilter("image"));
typeVideosBtn.addEventListener("click", () => setTypeFilter("video"));

tagsFilterToggleBtn.addEventListener("click", () => toggleTagsFilterPanel());

prevBtn.addEventListener("click", () => {
  handleManualNavigationLoopReset();
  runtime.previous();
});
nextBtn.addEventListener("click", () => {
  handleManualNavigationLoopReset();
  runtime.next();
});

playBtn.addEventListener("click", () => {
  runtime.play();
  if (fillInput.checked) {
    enterFillMode();
  }
});

stopBtn.addEventListener("click", () => runtime.stop());

clearBtn.addEventListener("click", () => {
  bumpGalleryGeneration();
  runtime.clear();
  provider.dispose();
  fsaProvider.dispose(); // [FSA] whichever source was active, release it
  allItems = [];
  clearViewerNode();
  exitFillMode();
  lastHiddenRelativePath = null;
  syncUndoHideButton();
  // [Phase 8.4-2/8.4-3] Nothing is loaded anymore — an "Associate this
  // Library…" click after this point would have nothing to associate.
  activeLibraryRecord = null;
  currentSourceKind = "none";
  legacySessionAssociated = false;
  legacyHasDurableIdentity = false;
  pendingLegacySignature = null;
  // [LIBRARY-PROFILE-UX / Phase 8.5] A pending "navigate to Profile to
  // associate" intent belongs to whatever was loaded when it was set —
  // never carry it forward onto a different, unrelated later load.
  pendingLibraryAssociationIntent = false;
  syncAssociateButtonVisibility();
});

favoriteBtn.addEventListener("click", () => {
  handleFavoriteToggle();
});

// -- overlay / fill-panel controls --

overlayFavoriteBtn.addEventListener("click", () => {
  handleFavoriteToggle();
});

overlayPrevBtn.addEventListener("click", () => {
  handleManualNavigationLoopReset();
  runtime.previous();
});
overlayNextBtn.addEventListener("click", () => {
  handleManualNavigationLoopReset();
  runtime.next();
});

overlayHideBtn.addEventListener("click", () => {
  // Capture which item this action is about BEFORE toggling — once hidden,
  // MediaRuntime moves off it on its own, so runtime.getCurrentItem() would
  // no longer point at it afterward.
  const item = runtime.getCurrentItem();
  runtime.toggleHidden();

  if (item) {
    lastHiddenRelativePath = item.relativePath;
    syncUndoHideButton();
  }
});

overlayUndoHideBtn.addEventListener("click", () => {
  if (lastHiddenRelativePath === null) return;

  // Go straight through ProfileStore rather than toggleHidden — this is
  // always meant as "restore," regardless of the record's current state,
  // not a toggle.
  profile.setHidden(lastHiddenRelativePath, false);

  lastHiddenRelativePath = null;
  syncUndoHideButton();
});

overlayPlayBtn.addEventListener("click", () => {
  togglePlay();
});

overlayExitBtn.addEventListener("click", () => {
  exitFillMode();
});

overlaySettingsBtn.addEventListener("click", () => {
  closeAutomationEditor();
  closeGhostPopunder();
  presentationSettings.classList.toggle("hidden");
});

ghostToggleBtn.addEventListener("click", () => {
  toggleGhostPopunder();
});

overlayAutomationBtn.addEventListener("click", () => {
  // Only one pop-out panel makes sense open at a time.
  presentationSettings.classList.add("hidden");
  closeGhostPopunder();

  // Phase 5.2: the button is never gated on Loop already being on. If
  // Loop is off, one click both turns it on — through the exact same
  // syncVideoLoopControl() the 🔁 checkbox's own change listener calls, so
  // there's no second, special-cased way Loop ends up on — and opens the
  // editor straight away, instead of making the user enable Loop first.
  if (!videoLoopInput.checked) {
    videoLoopInput.checked = true;
    syncVideoLoopControl();
    openAutomationEditor();
    return;
  }

  // [DEBUG-8.4-AUTOMATION-TOGGLE] 🤖 is now a genuine ON/OFF control, not
  // just a panel-visibility switch: while Loop is on, ANY click here turns
  // it back off — cancelling the active automation, clearing its
  // timer/progress, and closing the panel — via the exact same
  // syncVideoLoopControl() path the 🔁 checkbox itself uses. Does not
  // navigate media. (Previously this branch only toggled the panel's
  // hidden state, leaving Loop running with no way to turn it off from 🤖
  // itself — that one-directional behavior is the bug this replaces.)
  videoLoopInput.checked = false;
  syncVideoLoopControl();
});

// -- Step 1: choose the automation type --

automationChoiceForeverBtn.addEventListener("click", () => {
  // Forever is a complete selection with nothing to configure — apply
  // immediately and close, per the refinement's "simplest interaction"
  // guidance, rather than adding an unnecessary confirmation step.
  activeLoopRule = { type: "forever" };
  applyLoopRuleToCurrentVideo();
  closeAutomationEditor();
});

automationChoiceTimesBtn.addEventListener("click", () => {
  automationDraftTotalPlays = 5;
  setAutomationEditorStep("times");
});

automationChoiceTimerBtn.addEventListener("click", () => {
  automationDraftMinutes = 0;
  automationDraftSeconds = 0;
  setAutomationEditorStep("timer");
});

// -- Step 2: Back is navigation only — it must not apply or alter anything --

automationTimesBackBtn.addEventListener("click", () => {
  setAutomationEditorStep("choose");
});

automationTimerBackBtn.addEventListener("click", () => {
  setAutomationEditorStep("choose");
});

// -- Step 2: steppers edit the DRAFT only, never the applied rule --

automationTimesDecreaseBtn.addEventListener("click", () => {
  automationDraftTotalPlays = Math.max(1, automationDraftTotalPlays - 1);
  renderAutomationEditor();
});
automationTimesIncreaseBtn.addEventListener("click", () => {
  automationDraftTotalPlays += 1;
  renderAutomationEditor();
});

automationTimerMinutesDecreaseBtn.addEventListener("click", () => {
  automationDraftMinutes = Math.max(0, automationDraftMinutes - 1);
  renderAutomationEditor();
});
automationTimerMinutesIncreaseBtn.addEventListener("click", () => {
  automationDraftMinutes += 1;
  renderAutomationEditor();
});

// Seconds only ever land on 0/10/20/30/40/50 — always moving by exactly 10
// from a starting point of 0 guarantees that, per this phase's spec.
automationTimerSecondsDecreaseBtn.addEventListener("click", () => {
  automationDraftSeconds = Math.max(0, automationDraftSeconds - 10);
  renderAutomationEditor();
});
automationTimerSecondsIncreaseBtn.addEventListener("click", () => {
  automationDraftSeconds = Math.min(50, automationDraftSeconds + 10);
  renderAutomationEditor();
});

// -- Apply copies the draft into the applied rule, then closes the row --

automationTimesApplyBtn.addEventListener("click", () => {
  activeLoopRule = { type: "times", totalPlays: automationDraftTotalPlays };
  applyLoopRuleToCurrentVideo();
  closeAutomationEditor();
});

automationTimerApplyBtn.addEventListener("click", () => {
  activeLoopRule = { type: "timer", minutes: automationDraftMinutes, seconds: automationDraftSeconds };
  applyLoopRuleToCurrentVideo();
  closeAutomationEditor();
});

ghostOpacityInput.addEventListener("input", () => {
  applyGhostOpacity(Number(ghostOpacityInput.value));
});

// `change` (commit, not every drag tick) is the persistence path — avoids
// an IndexedDB write per pixel of slider movement. Only writes when
// "Remember this value" is checked; unchecked, the live value above still
// applies for the rest of this session but never touches the saved
// default.
ghostOpacityInput.addEventListener("change", () => {
  if (!ghostRememberInput.checked) return;
  savePresentationPreferences({ ghostOpacityPercent: Number(ghostOpacityInput.value) });
});

// Checking the box immediately commits whatever the slider currently shows
// as the new remembered default; unchecking it just persists the
// unchecked state itself (the built-in 15% fallback is what a future
// unchecked launch uses — see loadPreferences()/normalizeRecord(), not a
// stale remembered number).
ghostRememberInput.addEventListener("change", () => {
  const remember = ghostRememberInput.checked;
  const partial = { rememberGhostOpacity: remember };
  if (remember) {
    partial.ghostOpacityPercent = Number(ghostOpacityInput.value);
  }
  savePresentationPreferences(partial);
});

// ---- Keyboard shortcuts (Presentation Mode only) -------------------------
//
// Single, centralized listener rather than scattering key handling across
// individual controls. Only acts while fillModeActive is true, and is a
// no-op while focus is on any form control (text input, textarea, select,
// contenteditable, or the ghost-opacity range slider) so it never fights
// with normal typing or the slider's own native arrow-key handling.

function isTypingTarget(el) {
  if (!el) return false;
  if (el.isContentEditable) return true;

  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

function handlePresentationKeydown(event) {
  if (!fillModeActive) return;

  if (event.key === "Escape") {
    event.preventDefault();
    exitFillMode();
    return;
  }

  if (isTypingTarget(document.activeElement)) return;

  switch (event.key) {
    case "ArrowRight":
      event.preventDefault();
      handleManualNavigationLoopReset();
      runtime.next();
      break;
    case "ArrowLeft":
      event.preventDefault();
      handleManualNavigationLoopReset();
      runtime.previous();
      break;
    case " ":
    case "Spacebar": // older browsers
      // Prevents both the page-scroll default AND a focused button's
      // native "activate on Space" behavior — Space always means
      // play/pause in Presentation Mode, regardless of what has focus.
      event.preventDefault();
      togglePlay();
      break;
    default:
      break;
  }
}

document.addEventListener("keydown", handlePresentationKeydown);

// ---- Ghost UI hover behavior ----------------------------------------------
//
// Driven by literal pointer presence (mouseenter/mouseleave) rather than
// CSS :hover/:focus-within. Clicking a button gives it DOM focus as a
// browser side effect, and :focus-within doesn't clear on mouseleave — that
// was leaving the controls "stuck" visible after any click. Tracking the
// pointer directly sidesteps focus entirely: the bar reveals only while the
// cursor is actually over it, and reverts the instant it isn't, regardless
// of what has focus.

let currentGhostOpacityPercent = Number(ghostOpacityInput.value);

presentationControls.addEventListener("mouseenter", () => {
  presentationControls.style.setProperty("--ghost-opacity", "1");
});

presentationControls.addEventListener("mouseleave", () => {
  applyGhostOpacity(currentGhostOpacityPercent);
});

// ---- Tags (Phase 6.1 — Tag Management) -------------------------------------
//
// Vocabulary management only, per this milestone: create/rename/delete a
// tag definition in Gallery Settings. No media gets tagged here — that's a
// later milestone (Presentation Mode applies the vocabulary; Gallery uses
// it to filter). This card is entirely self-contained: its own render
// function, its own profile subscription, no interaction with allItems,
// getVisibleItems(), or runtime.load() at all in this phase.

let tagEditingId = null; // id of the tag currently showing its inline rename input, if any
let selectedTagActivityId = null;

function formatTagActivityTime(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";

  const dateText = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
  const timeText = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
  return `${dateText} · ${timeText}`;
}

// [Phase 8.3-2] Replaces the old "Find in Gallery" tag-filter shortcut.
// This is a RESUME action, not a filter action: it hands the stored
// tagging position straight to the existing Gallery Jump input, the same
// as if the user had read the number off this card and typed it in
// themselves. No new navigation system, no tag filter applied. Whether
// that number still lands on the same item depends on the current visible
// set matching the one that existed at tag time — performGalleryJump's
// existing range check already guards against a now-invalid number
// (smaller current total, etc.) exactly as it would for any manually
// typed value, so nothing extra is needed here for that case.
function resumeTagActivityToJump(slot) {
  if (!slot) return;

  galleryJumpInput.value = String(slot.position);
  galleryJumpInput.scrollIntoView({ behavior: "smooth", block: "center" });
  galleryJumpInput.focus();
  galleryJumpInput.select();
}

function buildTagActivityRow(label, slot) {
  const row = document.createElement("div");
  row.className = "tag-activity-row tag-activity-details";

  const value = document.createElement("span");
  value.className = "tag-activity-value";
  value.textContent = label ? `${label} · ${slot.position} / ${slot.total}` : `${slot.position} / ${slot.total}`;
  row.appendChild(value);

  const time = document.createElement("time");
  time.className = "tag-activity-value";
  time.textContent = formatTagActivityTime(slot.timestamp);
  time.dateTime = new Date(slot.timestamp).toISOString();
  row.appendChild(time);

  const findBtn = document.createElement("button");
  findBtn.type = "button";
  findBtn.className = "tag-activity-search-btn secondary";
  findBtn.textContent = "Find";
  findBtn.setAttribute("aria-label", label ? `Resume from ${label} position` : "Resume from this position");
  findBtn.addEventListener("click", () => resumeTagActivityToJump(slot));
  row.appendChild(findBtn);

  return row;
}

function renderTagActivityCenter() {
  const selectedTag = profile.getTags().find((tag) => tag.id === selectedTagActivityId);

  tagActivityNeutral.classList.toggle("hidden", Boolean(selectedTag));
  tagActivityContent.classList.toggle("hidden", !selectedTag);
  if (!selectedTag) return;

  tagActivityName.textContent = selectedTag.name;

  const { shuffleOff, shuffleOn, legacy } = profile.getTagActivity(selectedTagActivityId);
  const hasActivity = Boolean(shuffleOff || shuffleOn || legacy);

  tagActivityRows.classList.toggle("hidden", !hasActivity);
  tagActivityEmpty.classList.toggle("hidden", hasActivity);
  tagActivityRows.innerHTML = "";

  if (shuffleOff) tagActivityRows.appendChild(buildTagActivityRow("Shuffle OFF", shuffleOff));
  if (shuffleOn) tagActivityRows.appendChild(buildTagActivityRow("Shuffle ON", shuffleOn));
  // `legacy` = a record from before Shuffle context was ever tracked — no
  // label, since labeling it either way would be a guess (see
  // ProfileStore#getTagActivity). Still fully usable to resume from.
  if (legacy) tagActivityRows.appendChild(buildTagActivityRow(null, legacy));
}


function renderTagsGrid() {
  const tags = profile.getTags();

  tagsGrid.innerHTML = "";

  if (!tags.length) {
    tagsEmpty.classList.remove("hidden");
    tagsGrid.classList.add("hidden");
    return;
  }

  tagsEmpty.classList.add("hidden");
  tagsGrid.classList.remove("hidden");

  tags.forEach((tag) => {
    const row = document.createElement("div");
    row.className = "tag-chip-row";

    if (tagEditingId === tag.id) {
      row.classList.add("is-editing");

      const input = document.createElement("input");
      input.type = "text";
      input.className = "tag-rename-input";
      input.maxLength = 40;
      input.value = tag.name;

      const commit = () => {
        const value = input.value.trim();
        if (value && value !== tag.name) {
          const ok = profile.renameTag(tag.id, value);
          tagsStatusText.textContent = ok ? "" : `A tag named "${value}" already exists.`;
        }
        tagEditingId = null;
        renderTagsGrid();
      };

      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        } else if (event.key === "Escape") {
          event.preventDefault();
          tagEditingId = null;
          renderTagsGrid();
        }
      });
      input.addEventListener("blur", commit);

      row.appendChild(input);

      // No separate confirm button: Enter/blur commits, Escape cancels —
      // consistent with the "keep every workflow lightweight" guidance.
      queueMicrotask(() => input.focus());
    } else {
      const label = document.createElement("button");
      label.type = "button";
      label.className = "tag-chip tag-status-select";
      label.textContent = tag.name;
      label.classList.toggle("is-selected", selectedTagActivityId === tag.id);
      label.setAttribute("aria-pressed", selectedTagActivityId === tag.id ? "true" : "false");
      label.addEventListener("click", () => {
        selectedTagActivityId = tag.id;
        renderTagsGrid();
        renderTagActivityCenter();
      });
      row.appendChild(label);

      const actions = document.createElement("div");
      actions.className = "tag-chip-actions";

      const renameBtn = document.createElement("button");
      renameBtn.type = "button";
      renameBtn.className = "tag-action-btn secondary";
      renameBtn.setAttribute("aria-label", `Rename ${tag.name}`);
      renameBtn.textContent = "✎";
      renameBtn.addEventListener("click", () => {
        tagEditingId = tag.id;
        tagsStatusText.textContent = "";
        renderTagsGrid();
      });

      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "tag-action-btn secondary";
      deleteBtn.setAttribute("aria-label", `Delete ${tag.name}`);
      deleteBtn.textContent = "✕";
      deleteBtn.addEventListener("click", () => {
        profile.deleteTag(tag.id);
      });

      actions.appendChild(renameBtn);
      actions.appendChild(deleteBtn);
      row.appendChild(actions);
    }

    tagsGrid.appendChild(row);
  });
}

function createTagFromInput() {
  const value = tagCreateInput.value.trim();
  if (!value) return;

  const tag = profile.createTag(value);

  if (tag) {
    tagCreateInput.value = "";
    tagsStatusText.textContent = "";
  } else {
    tagsStatusText.textContent = `A tag named "${value}" already exists.`;
  }
}

tagCreateBtn.addEventListener("click", createTagFromInput);
tagCreateInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    createTagFromInput();
  }
});

// A tag being created/renamed/deleted anywhere always re-renders this grid.
// Kept as its own subscription (rather than folded into the item-focused
// one below) since it reacts to a completely different slice of profile
// state and has nothing to do with allItems/runtime.
profile.subscribe(() => {
  // Deleting the tag currently being edited (e.g. via a second browser
  // tab) shouldn't leave a phantom input bound to a tag that no longer
  // exists.
  if (tagEditingId && !profile.getTags().some((tag) => tag.id === tagEditingId)) {
    tagEditingId = null;
  }
  if (selectedTagActivityId && !profile.getTags().some((tag) => tag.id === selectedTagActivityId)) {
    selectedTagActivityId = null;
  }
  renderTagsGrid();
  renderTagActivityCenter();
  // A tag being renamed or deleted (label change, or a chip disappearing
  // entirely) needs to reach the Presentation Tags panel too, not just
  // Gallery Settings' own grid.
  renderPresentationTagsPanel(runtime.getState().currentItem);

  // A tag filter active in the Gallery toolbar that's just been deleted
  // would otherwise silently filter the gallery down to nothing (its id
  // no longer matches any item) — drop it from the active set rather than
  // leave the toolbar filtering on a tag that no longer exists.
  const validTagIds = new Set(profile.getTags().map((tag) => tag.id));
  const prunedTagFilters = activeTagFilters.filter((id) => validTagIds.has(id));
  if (prunedTagFilters.length !== activeTagFilters.length) {
    activeTagFilters = prunedTagFilters;
    reloadRuntime({ keepPlaying: runtime.getState().isPlaying });
  }
  renderTagsFilterGrid();
});

// ---- Profile Selector / Creation (Phase 8.3) -------------------------------
//
// Purely a thin UI layer over ProfileStore's existing multi-profile APIs
// (listProfiles/createProfile/switchProfile/getProfileId) — no profile
// state is held or duplicated here. profile.subscribe() below keeps the
// selector in sync with the registry the same way renderTagsGrid() stays
// in sync with the tag vocabulary.

function renderProfileSelector() {
  const profiles = profile.listProfiles();
  const activeId = profile.getProfileId();

  profileSelect.innerHTML = "";

  profiles.forEach((entry) => {
    const option = document.createElement("option");
    option.value = entry.id;
    option.textContent = entry.name;
    profileSelect.appendChild(option);
  });

  if (activeId) profileSelect.value = activeId;
}

profileSelect.addEventListener("change", async () => {
  const targetId = profileSelect.value;
  if (!targetId || targetId === profile.getProfileId()) return;

  const ok = await profile.switchProfile(targetId);
  if (!ok) {
    profileActiveStatusText.textContent = "Could not switch profile.";
    renderProfileSelector(); // revert the <select> to the still-active profile
    return;
  }
});

async function createProfileFromInput() {
  const name = profileCreateInput.value.trim();
  if (!name) return;

  profileCreateBtn.disabled = true;
  try {
    // [DEBUG-8.3-PROFILE-UI] This is where a newly-created profile becomes
    // active: createProfile(name) registers the profile but — by design
    // (see profile-store.js) — does NOT activate it, so switchProfile(id)
    // is the ProfileStore API that actually performs the transition
    // (persists activeProfileId, resets in-memory state, loads the new
    // profile's isolated items/tags). "Save" in the UI == these two calls
    // in sequence.
    const created = await profile.createProfile(name);
    await profile.switchProfile(created.id);

    profileCreateInput.value = "";
    profileActiveStatusText.textContent = `Created and switched to "${created.name}".`;
  } catch (error) {
    profileActiveStatusText.textContent = `Could not create profile: ${error.message}`;
  } finally {
    profileCreateBtn.disabled = false;
  }
}

profileCreateBtn.addEventListener("click", createProfileFromInput);
profileCreateInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    createProfileFromInput();
  }
});

profileDeleteBtn.addEventListener("click", async () => {
  const activeId = profile.getProfileId();
  if (!activeId) return;

  const activeName = profile.getProfileName();
  const confirmed = window.confirm(
    `Delete profile "${activeName}"? This removes its tags, favorites, and hidden state. Your media files are not affected. This cannot be undone.`
  );
  if (!confirmed) return;

  profileDeleteBtn.disabled = true;
  try {
    await profile.deleteProfile(activeId);
    profileActiveStatusText.textContent = `Deleted "${activeName}". Now on "${profile.getProfileName()}".`;

    // [LIBRARY-PROFILE-UX / Phase 8.5]
    // WHAT: If the CURRENTLY LOADED library was associated with the
    // profile just deleted, clear that association right now.
    // WHY: Section 1 — "update the row immediately when... a stale/deleted
    // Profile association is cleared" — without this, activeLibraryRecord
    // keeps pointing at a profileId that no longer exists until the next
    // reopen (updateAssociatedStatusRow already refuses to fall back to
    // the active profile's name in that case, but "Associate with
    // Profile" should reappear immediately too, not just the row text).
    // FUTURE: Mirrors the existing stale-profile clearing already done at
    // LOAD time in loadFromFsaHandle/loadFiles — this is the same cleanup,
    // just triggered by a live delete instead of a re-pick.
    if (activeLibraryRecord && activeLibraryRecord.profileId === activeId) {
      if (currentSourceKind === "fsa" || (currentSourceKind === "legacy" && legacyHasDurableIdentity)) {
        try {
          const cleared = await setLibraryProfile(activeLibraryRecord.id, null);
          activeLibraryRecord = cleared || { ...activeLibraryRecord, profileId: null };
        } catch (error) {
          activeLibraryRecord = { ...activeLibraryRecord, profileId: null };
        }
      }
    } else if (currentSourceKind === "legacy" && !legacyHasDurableIdentity && legacySessionAssociated) {
      // Ephemeral association has no stored profileId to compare against —
      // it's simply "the profile active when Associate was clicked". If a
      // deletion just happened at all while that ephemeral association is
      // live, the safest assumption is it may have been that very profile;
      // clear it rather than risk it silently pointing at a name that no
      // longer means what the user thinks.
      legacySessionAssociated = false;
    }
    syncAssociateButtonVisibility();
  } catch (error) {
    profileActiveStatusText.textContent = `Could not delete profile: ${error.message}`;
  } finally {
    profileDeleteBtn.disabled = false;
  }
});

// Registry changes (create, switch, rename, master-folder update) all funnel
// through ProfileStore's #emit(), same signal as favorites/tags. Keeping
// this as its own subscription — like the Tags one above — since it reacts
// to profile IDENTITY, not item/tag content.
profile.subscribe(() => {
  renderProfileSelector();
  // [LIBRARY-PROFILE-UX / Phase 8.5] The green "Associated:" row can name
  // a profile that isn't the active one (see updateAssociatedStatusRow) —
  // a rename of THAT profile, or a switch away from it, needs to refresh
  // this row even though nothing about the loaded library itself changed.
  syncAssociateButtonVisibility();
});

// ---- Profile Export / Import ----------------------------------------------

let pendingImportMode = "merge";

function downloadTextFile(filename, text, mimeType = "application/json") {
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

profileExportBtn.addEventListener("click", () => {
  const text = profile.exportText();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  // Trivial, isolated filename cosmetic (Phase 8.3): the export JSON body
  // already carries profileName (see ProfileStore#toJSON, unchanged since
  // Phase 8.1) — this just makes the on-disk filename recognizable too
  // when a user has several profiles exported side by side.
  const nameSlug = profile.getProfileName().trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  const filenamePrefix = nameSlug ? `gallery-profile-${nameSlug}` : "gallery-profile";
  downloadTextFile(`${filenamePrefix}-${stamp}.json`, text);

  const count = profile.size();
  profileStatusText.textContent = `Exported ${count} curated item${count === 1 ? "" : "s"}.`;
});

profileImportMergeBtn.addEventListener("click", () => {
  pendingImportMode = "merge";
  profileImportInput.click();
});

profileImportReplaceBtn.addEventListener("click", () => {
  pendingImportMode = "replace";
  profileImportInput.click();
});

profileImportInput.addEventListener("change", async (event) => {
  const file = event.target.files && event.target.files[0];
  profileImportInput.value = "";
  if (!file) return;

  try {
    const text = await file.text();
    const knownRelativePaths = allItems.map((item) => item.relativePath);

    const result = profile.importJSON(text, {
      mode: pendingImportMode,
      skipMissingFiles: profileSkipMissingInput.checked,
      knownRelativePaths,
    });

    profileStatusText.textContent =
      `Import (${result.mode}) complete: ${result.applied} applied` +
      (result.skipped ? `, ${result.skipped} skipped` : "") +
      ".";
  } catch (error) {
    profileStatusText.textContent = `Import failed: ${error.message}`;
  }
});

// [LIBRARY-PROFILE-UX / Phase 8.5]
// WHAT: "Import as New Profile" — populates a brand-new Profile from an
// exported .json instead of merging/replacing into whichever Profile is
// currently active.
// WHY: Section 9 — reusing another Profile as a starting point without
// two libraries ending up silently sharing one mutable Profile. Built
// entirely from EXISTING primitives already used elsewhere on this page
// (createProfile, switchProfile, importJSON) — no new persistence.
// FUTURE: This is a one-time copy — the new Profile diverges independently
// from here on, there is no ongoing link back to the source file.
profileImportCopyBtn.addEventListener("click", () => profileImportCopyInput.click());

profileImportCopyInput.addEventListener("change", async (event) => {
  const file = event.target.files && event.target.files[0];
  profileImportCopyInput.value = "";
  if (!file) return;

  try {
    const text = await file.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("Not a recognized profile file (invalid JSON).");
    }

    const suggestedName = typeof parsed.profileName === "string" && parsed.profileName.trim() ? parsed.profileName.trim() : "Imported Profile";
    const name = window.prompt("Name for the new profile:", suggestedName);
    if (!name || !name.trim()) return; // cancelled

    const created = await profile.createProfile(name.trim());
    await profile.switchProfile(created.id);
    const result = profile.importJSON(parsed, { mode: "replace" });

    profileActiveStatusText.textContent = `Created "${created.name}" from import (${result.applied} applied).`;
  } catch (error) {
    profileActiveStatusText.textContent = `Could not import as a new profile: ${error.message}`;
  }
});

// Centralized reaction to ANY profile change — a single toggle, a merge
// import, or a replace import all funnel through here. allItems is kept in
// sync regardless of what's currently loaded into the runtime (so an item
// hidden by the Favorites Only filter still gets updated), and Favorites
// Only reloads to pick up whatever just changed.
profile.subscribe(() => {
  allItems.forEach((item) => {
    item.isFavorite = profile.isFavorite(item.relativePath);
    item.isHidden = profile.isHidden(item.relativePath);
    item.favoritedAt = profile.getFavoritedAt(item.relativePath);
    item.userTags = profile.getItemTags(item.relativePath);
  });

  // Reload whenever the currently-applied filters could be affected by
  // what just changed: Favorites Only obviously needs it, and so does an
  // active Tag filter (Phase 6.3) — tagging/untagging the current item
  // from the Presentation panel can move it in or out of that set.
  if (viewMode === "favorites" || activeTagFilters.length > 0) {
    reloadRuntime({ keepPlaying: runtime.getState().isPlaying });
  }
  renderPresentationTagsPanel(runtime.getState().currentItem);
});

// ---- Profile Sync UI (Profile Sync Folder POC) ---------------------------
//
// [PROFILE-SYNC] Purely a thin UI layer over ProfileSync's own state
// machine (getStatus/subscribe) — no connection/sync state is held or
// duplicated here, same relationship renderProfileSelector() above has to
// ProfileStore. profileSync.subscribe(renderProfileSync) below keeps every
// element in sync with the engine automatically.

function renderProfileSync() {
  const status = profileSync.getStatus();

  profileSyncChooseBtn.classList.toggle("hidden", status.configured);
  profileSyncReconnectBtn.classList.toggle("hidden", status.status !== "permission-needed");
  profileSyncConnectedRow.classList.toggle(
    "hidden",
    !status.configured || status.status === "permission-needed"
  );
  profileSyncNowBtn.disabled = status.status === "syncing" || status.status === "conflict";
  profileSyncConflictPanel.classList.toggle("hidden", status.status !== "conflict");

  if (!status.configured) {
    profileSyncManagePanel.classList.add("hidden");
  }

  let line;
  switch (status.status) {
    case "not-configured":
      line = "Status: Not configured";
      break;
    case "checking":
      line = "Status: Checking folder access…";
      break;
    case "permission-needed":
      line = `Status: Permission needed for "${status.folderName}".`;
      break;
    case "syncing":
      line = "Status: Syncing…";
      break;
    case "conflict":
      line = "Profile changed on another device. Choose a version below.";
      break;
    case "offline":
      line = `Offline — saved locally. Changes will sync when available.${status.message ? ` (${status.message})` : ""}`;
      break;
    case "connected":
    default:
      line = `✓ Connected — "${status.folderName}" · Auto Sync: ON · Last sync: ${
        status.lastSyncAt ? formatRelativeTime(status.lastSyncAt) : "just now"
      }`;
  }
  profileSyncStatusText.textContent = line;
}

// [PROFILE-SYNC-SETUP]
// WHAT: Opens the first-time setup modal. Shown for BOTH entry points that
// deliberately start a fresh folder selection — "Choose Google Drive
// Folder" (unconfigured) and "Change Sync Folder" (already configured).
// WHY: The native OS folder picker can't explain the shared-Drive-folder
// convention itself, so this modal does, once, right before it.
// FUTURE / DO-NOT-BREAK: This must NOT be reachable from the Reconnect
// button or startup silent reconnect — those reuse the remembered handle
// via profileSync.reconnect()/init() and must never re-open a picker or
// this modal (see profile-sync.js). If a new "start a fresh folder"
// affordance is ever added, route it here too rather than calling the
// picker directly.
function openSyncSetupModal() {
  if (!isFsaSupported()) {
    profileSyncStatusText.textContent = "This browser does not support the File System Access API.";
    return;
  }

  // Reached from "Change Sync Folder" leaves the Manage panel open behind
  // the dimmed backdrop otherwise — collapse it as the modal takes over.
  profileSyncManagePanel.classList.add("hidden");

  if (typeof profileSyncSetupDialog.showModal === "function") {
    profileSyncSetupCopyBtn.textContent = "Copy Folder Name"; // reset any leftover "Copied!" from a prior open
    profileSyncSetupDialog.showModal();
  } else {
    // <dialog> unsupported but FSA present is not a real browser
    // combination; rather than dead-end, fall straight through to the
    // picker so setup still works.
    runSyncFolderPicker();
  }
}

// [PROFILE-SYNC-SETUP] The actual folder-selection path — the SAME setup
// logic as before this modal existed (picker -> connectNewFolder). Invoked
// only from the modal's primary button so showDirectoryPicker() keeps its
// own direct user gesture; never duplicated anywhere else.
async function runSyncFolderPicker() {
  let dirHandle;
  try {
    dirHandle = await window.showDirectoryPicker({ mode: "readwrite" });
  } catch (error) {
    if (error && error.name === "AbortError") return; // user closed the picker — not an error
    profileSyncStatusText.textContent = `Could not open the folder picker: ${error.message}`;
    return;
  }

  await profileSync.connectNewFolder(dirHandle);
}

// Copies the recommended folder name. The name's single source of truth is
// the modal's inset field (textContent) — never a second literal here — so
// it can't drift from what the user sees. Failure stays inside the modal:
// briefly show "Copy failed" and leave the (user-select:all) inset field so
// the name can still be selected and copied by hand.
let syncSetupCopyResetTimer = null;
async function copySyncFolderName() {
  const name = profileSyncSetupFolderName.textContent.trim();

  let ok = false;
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(name);
      ok = true;
    }
  } catch {
    ok = false;
  }

  if (!ok) {
    // Fallback for a blocked/absent async clipboard. Appended INSIDE the
    // dialog (not document.body) since a modal dialog makes the rest of the
    // page inert, and an inert textarea can't be selected/copied.
    try {
      const textarea = document.createElement("textarea");
      textarea.value = name;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      profileSyncSetupDialog.appendChild(textarea);
      textarea.select();
      ok = document.execCommand("copy");
      textarea.remove();
    } catch {
      ok = false;
    }
  }

  if (syncSetupCopyResetTimer) clearTimeout(syncSetupCopyResetTimer);
  profileSyncSetupCopyBtn.textContent = ok ? "Copied!" : "Copy failed";
  syncSetupCopyResetTimer = setTimeout(() => {
    profileSyncSetupCopyBtn.textContent = "Copy Folder Name";
  }, 1800);
}

profileSyncChooseBtn.addEventListener("click", openSyncSetupModal);
profileSyncChangeBtn.addEventListener("click", openSyncSetupModal);

profileSyncSetupCopyBtn.addEventListener("click", copySyncFolderName);

// Cancel (and Escape, which fires the dialog's own cancel/close) simply
// closes — never opens the picker, never touches the current sync
// relationship.
profileSyncSetupCancelBtn.addEventListener("click", () => profileSyncSetupDialog.close());

// Close synchronously FIRST, then open the picker in the same task — the
// click's transient user activation survives a synchronous close(), so
// showDirectoryPicker()'s user-gesture requirement is still met.
profileSyncSetupOpenBtn.addEventListener("click", () => {
  profileSyncSetupDialog.close();
  runSyncFolderPicker();
});

profileSyncDisconnectBtn.addEventListener("click", async () => {
  const confirmed = window.confirm(
    "Disconnect Profile Sync? Your Profiles remain saved locally — they will just stop syncing to this folder."
  );
  if (!confirmed) return;
  await profileSync.disconnect();
  profileSyncManagePanel.classList.add("hidden");
});

profileSyncReconnectBtn.addEventListener("click", () => profileSync.reconnect());
profileSyncNowBtn.addEventListener("click", () => profileSync.syncNow());
profileSyncManageToggleBtn.addEventListener("click", () => {
  const nowOpen = profileSyncManagePanel.classList.toggle("hidden") === false;
  profileSyncManageToggleBtn.setAttribute("aria-expanded", String(nowOpen));
});
profileSyncUseSyncedBtn.addEventListener("click", () => profileSync.resolveConflict("use-synced"));
profileSyncKeepLocalBtn.addEventListener("click", () => profileSync.resolveConflict("keep-local"));

profileSync.subscribe(renderProfileSync);
renderProfileSync();

// ---- Boot ---------------------------------------------------------------

// [APP-PREFERENCES] Applies a loaded (already validated/defaulted —
// see loadPreferences()/normalizeRecord() in app-preferences.js) global
// preferences record to the DOM controls and to MediaRuntime. Called once,
// synchronously, before any of the hardcoded boot calls below that used to
// read these same controls' HTML-default values — so a saved preference is
// never overwritten by that hardcoded initialization.
//
// A stored `ghostOpacityPercent` is deliberately ignored when
// `rememberGhostOpacity` is false: it may be a stale value left over from
// before the user unchecked "Remember this value", and unchecked launches
// must always show the built-in fallback, not that old number.
function applyLoadedPreferences(preferences) {
  const { playback, presentation } = preferences;

  intervalInput.value = String(playback.intervalSeconds);
  shuffleInput.checked = playback.shuffle;
  skipDuplicatesInput.checked = playback.skipDuplicates;
  skipDuplicates = playback.skipDuplicates;
  loopInput.checked = playback.loopPlaylist;
  fillInput.checked = playback.fillPanel;

  ghostRememberInput.checked = presentation.rememberGhostOpacity;
  const ghostPercent = presentation.rememberGhostOpacity
    ? presentation.ghostOpacityPercent
    : DEFAULT_GHOST_OPACITY_PERCENT;
  ghostOpacityInput.value = String(ghostPercent);

  runtime.setShuffle(shuffleInput.checked);
  runtime.setLoop(loopInput.checked);
  runtime.setIntervalMs(Number(intervalInput.value) * 1000);
  applyGhostOpacity(Number(ghostOpacityInput.value));
}

applyLoadedPreferences(await loadPreferences());

syncVideoLoopControl();
resetLoopRuleToDefault();
syncUndoHideButton();
renderTagsGrid();
renderTagsFilterGrid();
renderProfileSelector();
// [LIBRARY-PROFILE-UX / Phase 8.5] Redundant with the HTML default (both
// already read "—"), but explicit here so the boot sequence doesn't rely
// on the markup default staying in sync with this function's logic.
syncAssociateButtonVisibility();

runtime.subscribe(render);

window.addEventListener("beforeunload", () => {
  runtime.stop();
  provider.dispose();
  fsaProvider.dispose(); // [FSA]
});

// [LIBRARY-REGISTRY] Boot-time: render whatever libraries were previously
// remembered so the user sees "Recent Libraries" immediately. This is a
// pure metadata read — it does NOT check/request permission or load
// anything on its own (requestPermission needs a user gesture, and
// queryPermission-only would still mean silently touching folder access
// on every page load without the user asking).
(async function initFsaLibraries() {
  if (!isFsaSupported()) {
    fsaChooseFolderBtn.disabled = true;
    fsaStatusText.textContent = "This browser does not support the File System Access API.";
    return;
  }

  await renderRecentLibraries();
})();

// [PROFILE-SYNC] Boot-time: silently reconnect to a remembered sync folder
// if permission is still usable — see ProfileSync#init(). Not awaited here
// (same pattern as initFsaLibraries above) so a slow permission check never
// blocks the rest of boot; renderProfileSync() (already subscribed above)
// picks up whatever state this settles into.
profileSync.init();

// =============================================================================
// [P1-DIAGNOSTIC / TEMPORARY] FSA direct-lookup recovery test.
//
// WHAT: Two DevTools-callable functions comparing Legacy (webkitdirectory)
// vs FSA discovery on the CURRENTLY LOADED folder, then probing whether
// FSA's getDirectoryHandle() can directly resolve a directory FSA's own
// entries() enumeration omitted.
// WHY: Determines whether FSA enumeration being incomplete also means FSA
// lookup is dead-ended, or whether the omitted subtree is still directly
// addressable — the fork in the road between an FSA-only recovery
// strategy and needing Legacy-assisted orchestration.
// FUTURE / DO-NOT-BREAK: This entire block is temporary and additive —
// nothing in it is called by any production path. Delete this block, the
// four __p1* variables, and the two snapshot lines (in loadFiles() and
// loadFromFsaHandle()) once P1 concludes. Never trim/normalize/reconstruct
// the real relativePath strings this reads from the __p1*Snapshot arrays
// (not the providers' own .getItems() — see those snapshot vars' own
// comment for why); they are read once into __p1RealPathsById and never
// logged.
//
// NOTE: loadFiles()/loadFromFsaHandle() each dispose() the OTHER provider
// at the start of every load, so only ONE of provider/fsaProvider ever has
// live items at a time — you must load BOTH pickers (either order) before
// calling __fsaP1FindCandidates(), even though only the most-recently-
// loaded one's items are visible via .getItems() at any given moment.
//
// USAGE (run in the DevTools console, on this app, after loading the SAME
// folder via BOTH pickers — the Legacy Picker's <input webkitdirectory>,
// then "Choose Folder" (FSA) — in either order, most-recent load per
// picker is what's compared):
//
//   __fsaP1FindCandidates()       // lists anonymized candidates: D01, D02,
//                                 // ... (Legacy-only, i.e. FSA-omitted) and
//                                 // C01, C02, ... (present in both — controls)
//   __fsaP1Probe('D01')           // runs the direct-lookup probe on one
//   __fsaP1Probe('C01')           // and a control, for comparison
// =============================================================================

const __p1RealPathsById = new Map(); // anonymous id -> real relativePath; never logged, never returned

function __p1CodePointMeta(name) {
  const cps = Array.from(name); // code-point aware, not UTF-16-code-unit aware
  return {
    length: cps.length,
    startsWithAsciiSpace: name.length > 0 && name.charCodeAt(0) === 0x20,
    endsWithAsciiSpace: name.length > 0 && name.charCodeAt(name.length - 1) === 0x20,
    firstCodePoint: cps.length ? "U+" + cps[0].codePointAt(0).toString(16).toUpperCase().padStart(4, "0") : null,
    lastCodePoint: cps.length ? "U+" + cps[cps.length - 1].codePointAt(0).toString(16).toUpperCase().padStart(4, "0") : null,
  };
}

// All ancestor directory relativePaths implied by a file's relativePath,
// e.g. "A/B/C.jpg" -> ["A", "A/B"]. Root-level files contribute nothing.
function __p1DirPrefixesOf(relativePath) {
  const segments = relativePath.split("/");
  segments.pop(); // drop the filename itself
  const prefixes = [];
  let running = "";
  for (const segment of segments) {
    running = running ? `${running}/${segment}` : segment;
    prefixes.push(running);
  }
  return prefixes;
}

window.__fsaP1FindCandidates = function () {
  const legacyItems = __p1LegacySnapshot;
  const fsaItems = __p1FsaSnapshot;

  if (!legacyItems.length || !fsaItems.length) {
    console.warn(
      "[P1] Need BOTH a Legacy Picker load and an FSA Choose Folder load of the SAME folder before comparing. " +
        `Currently: legacy items=${legacyItems.length}, fsa items=${fsaItems.length}.`
    );
    return { started: true, completed: false, reason: "missing-comparison-data" };
  }

  const legacyDirs = new Set();
  for (const item of legacyItems) for (const p of __p1DirPrefixesOf(item.relativePath)) legacyDirs.add(p);

  const fsaDirs = new Set();
  for (const item of fsaItems) for (const p of __p1DirPrefixesOf(item.relativePath)) fsaDirs.add(p);

  const omitted = [...legacyDirs].filter((p) => !fsaDirs.has(p));
  const present = [...legacyDirs].filter((p) => fsaDirs.has(p));

  __p1RealPathsById.clear();
  const rows = [];

  omitted.forEach((path, i) => {
    const id = `D${String(i + 1).padStart(2, "0")}`;
    __p1RealPathsById.set(id, path);
    const finalSegment = path.split("/").pop();
    rows.push({ id, kind: "omitted (Legacy-only)", ...__p1CodePointMeta(finalSegment) });
  });

  // Prefer control candidates that also have edge/internal spaces, so a
  // parity failure isn't masked by only ever testing plain ASCII names —
  // but any present-in-both directory is a valid control if none do.
  const controlPool =
    present.filter((p) => {
      const seg = p.split("/").pop();
      return seg.includes(" ");
    }).length > 0
      ? present.filter((p) => p.split("/").pop().includes(" "))
      : present;

  controlPool.slice(0, 3).forEach((path, i) => {
    const id = `C${String(i + 1).padStart(2, "0")}`;
    __p1RealPathsById.set(id, path);
    const finalSegment = path.split("/").pop();
    rows.push({ id, kind: "control (present in both)", ...__p1CodePointMeta(finalSegment) });
  });

  console.log(`[P1] Legacy dirs: ${legacyDirs.size}, FSA dirs: ${fsaDirs.size}, omitted: ${omitted.length}.`);
  console.table(rows);
  console.log("[P1] Run __fsaP1Probe('D01') (etc.) next. No real paths were logged above.");

  return { started: true, completed: true, candidateIds: rows.map((r) => r.id) };
};

async function __p1ResolveAncestors(rootHandle, segments) {
  let handle = rootHandle;
  for (const segment of segments) {
    try {
      handle = await handle.getDirectoryHandle(segment, { create: false });
    } catch (error) {
      return { ok: false, failedAtSegmentIndex: segments.indexOf(segment), errorName: error?.name ?? "Unknown" };
    }
  }
  return { ok: true, handle };
}

// Minimal recursive counter — deliberately NOT FsaFileProvider (no object
// URLs, no MediaItem shaping, no batching); this only needs counts to
// prove the recovered subtree is real and traversable, per the P1 spec.
async function __p1CountRecursive(dirHandle) {
  let files = 0;
  let dirs = 0;
  for await (const [, handle] of dirHandle.entries()) {
    if (handle.kind === "directory") {
      dirs += 1;
      const nested = await __p1CountRecursive(handle);
      files += nested.files;
      dirs += nested.dirs;
    } else if (handle.kind === "file") {
      files += 1;
    }
  }
  return { files, dirs };
}

window.__fsaP1Probe = async function (candidateId) {
  const report = { candidateId, started: true, completed: false, cancelled: false, exception: null };

  const realPath = __p1RealPathsById.get(candidateId);
  if (!realPath) {
    console.warn(`[P1] Unknown candidate id "${candidateId}". Run __fsaP1FindCandidates() first.`);
    report.completed = false;
    return report;
  }
  if (!__p1DiagnosticRootHandle) {
    console.warn("[P1] No FSA root handle on record — load a folder via Choose Folder (FSA) first.");
    report.completed = false;
    return report;
  }

  // exactLegacyName is read directly from the untouched relativePath
  // captured by __fsaP1FindCandidates — never trimmed/normalized here.
  const segments = realPath.split("/");
  const exactLegacyName = segments[segments.length - 1];
  const ancestorSegments = segments.slice(0, -1);

  const integrity = __p1CodePointMeta(exactLegacyName);
  console.log(`[P1] ${candidateId} exact-name integrity (re-derived fresh, not cached):`, integrity);

  const ancestorResult = await __p1ResolveAncestors(__p1DiagnosticRootHandle, ancestorSegments);
  if (!ancestorResult.ok) {
    console.log(
      `[P1] ${candidateId}: could not resolve to the correct parent handle ` +
        `(failed at ancestor segment index ${ancestorResult.failedAtSegmentIndex}, ${ancestorResult.errorName}).`
    );
    report.completed = true;
    report.result = "C";
    report.reason = "ancestor-resolution-failed";
    return report;
  }
  const parentHandle = ancestorResult.handle;

  // Enumeration confirmation, under the SAME parent, via the SAME entries()
  // method the production FSA walker uses — no sibling names logged.
  let enumeratedChildren = 0;
  let presentInEnumeration = false;
  try {
    for await (const [name] of parentHandle.entries()) {
      enumeratedChildren += 1;
      if (name === exactLegacyName) presentInEnumeration = true;
    }
  } catch (error) {
    report.completed = true;
    report.result = "C";
    report.reason = `enumeration-threw: ${error?.name ?? "Unknown"}`;
    console.log(`[P1] ${candidateId}: enumeration itself threw — cannot trust this run.`, report.reason);
    return report;
  }
  console.log(`[P1] ${candidateId}: enumeratedChildren=${enumeratedChildren}, presentInEnumeration=${presentInEnumeration}`);

  // Direct lookup probe — the primary P1 question.
  let directLookupResult;
  try {
    const handle = await parentHandle.getDirectoryHandle(exactLegacyName, { create: false });
    directLookupResult = { success: true, kind: handle.kind, handle };
  } catch (error) {
    // WHAT: Captures error.message alongside error.name.
    // WHY: error.name alone (e.g. "TypeError") doesn't distinguish "the
    // API rejected this name before touching the filesystem" from other
    // failure modes — the message text does.
    // FUTURE / DO-NOT-BREAK: n/a — read-only diagnostic output.
    directLookupResult = {
      success: false,
      errorName: error?.name ?? "Unknown",
      errorMessage: error?.message ?? "(no message)",
    };
  }

  report.completed = true;
  report.enumeration = presentInEnumeration ? "HIT" : "MISS";
  report.directLookup = directLookupResult.success ? "SUCCESS" : `FAIL (${directLookupResult.errorName})`;

  if (!presentInEnumeration && directLookupResult.success) {
    report.result = "A";
  } else if (!presentInEnumeration && !directLookupResult.success) {
    report.result = "B";
  } else if (presentInEnumeration && directLookupResult.success) {
    report.result = "control-parity-confirmed";
  } else {
    report.result = "C";
    report.reason = "enumeration HIT but direct lookup FAILED — inconsistent, needs manual review";
  }

  console.log(`[P1] ${candidateId}: enumeration=${report.enumeration}, directLookup=${report.directLookup} -> RESULT ${report.result}`);
  if (!directLookupResult.success) {
    console.log(`[P1] ${candidateId} error detail: ${directLookupResult.errorName} — "${directLookupResult.errorMessage}"`);
    report.errorMessage = directLookupResult.errorMessage;
  }

  if (directLookupResult.success) {
    try {
      const immediate = [];
      for await (const _entry of directLookupResult.handle.entries()) immediate.push(1);
      const recursive = await __p1CountRecursive(directLookupResult.handle);

      const legacyPrefix = `${realPath}/`;
      const legacyFilesUnderPath = __p1LegacySnapshot.filter((it) => it.relativePath.startsWith(legacyPrefix)).length;
      const fsaFilesUnderPathBefore = __p1FsaSnapshot.filter((it) => it.relativePath.startsWith(legacyPrefix)).length;

      report.recoveredImmediateChildren = immediate.length;
      report.recoveredRecursiveFiles = recursive.files;
      report.legacyFilesUnderThisPath = legacyFilesUnderPath;
      report.previouslyAbsentFromFsaScan = legacyFilesUnderPath - fsaFilesUnderPathBefore;

      console.log(
        `[P1] ${candidateId} recovered subtree — immediateChildren=${immediate.length}, ` +
          `recursiveFiles=${recursive.files}, legacyFilesUnderThisPath=${legacyFilesUnderPath}, ` +
          `previouslyAbsentFromFsaScan=${report.previouslyAbsentFromFsaScan}`
      );
    } catch (error) {
      console.log(`[P1] ${candidateId}: recovered handle exists but subtree traversal threw — `, error?.name ?? error);
      report.subtreeTraversalError = error?.name ?? "Unknown";
    }
  }

  return report;
};
