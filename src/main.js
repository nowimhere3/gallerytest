import { LocalFileInputProvider } from "./providers/local-file-input-provider.js";
import { MediaRuntime } from "./runtime/media-runtime.js";
import { ProfileStore } from "./profile/profile-store.js";

const provider = new LocalFileInputProvider();
const profile = new ProfileStore();
const runtime = new MediaRuntime({ profile });

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
const intervalInput = document.getElementById("interval-input");
const intervalDecreaseBtn = document.getElementById("interval-decrease-btn");
const intervalIncreaseBtn = document.getElementById("interval-increase-btn");
const shuffleInput = document.getElementById("shuffle-input");
const loopInput = document.getElementById("loop-input");
const videoLoopInput = document.getElementById("video-loop-input");
const videoLoopControl = document.getElementById("video-loop-control");
const videoLoopStateText = document.getElementById("video-loop-state-text");
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

const profileExportBtn = document.getElementById("profile-export-btn");
const profileImportMergeBtn = document.getElementById("profile-import-merge-btn");
const profileImportReplaceBtn = document.getElementById("profile-import-replace-btn");
const profileImportInput = document.getElementById("profile-import-input");
const profileSkipMissingInput = document.getElementById("profile-skip-missing-input");
const profileStatusText = document.getElementById("profile-status-text");

const tagCreateInput = document.getElementById("tag-create-input");
const tagCreateBtn = document.getElementById("tag-create-btn");
const tagsStatusText = document.getElementById("tags-status-text");
const tagsEmpty = document.getElementById("tags-empty");
const tagsGrid = document.getElementById("tags-grid");

const prevBtn = document.getElementById("prev-btn");
const nextBtn = document.getElementById("next-btn");
const playBtn = document.getElementById("play-btn");
const stopBtn = document.getElementById("stop-btn");
const clearBtn = document.getElementById("clear-btn");

const statusText = document.getElementById("status-text");
const selectedText = document.getElementById("selected-text");
const viewModeText = document.getElementById("view-mode-text");
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
let galleryJumpMode = "find"; // "find" | "play" — Gallery Media Navigation (Phase 2)
let fillModeActive = false;
let currentViewerNode = null;
let currentViewerItem = null;
let isLoadingFiles = false;

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
  const filtered = filterMedia(allItems, {
    favourites: viewMode === "favorites",
    mediaType: typeFilter,
    tags: activeTagFilters,
  });

  if (viewMode === "favorites") {
    // Newest favorite first (Favourite Ordering). Items favorited under an
    // older profile schema (no timestamp) sort after timestamped ones, but
    // otherwise keep their existing relative order — Array#sort is stable.
    return [...filtered].sort((a, b) => (b.favoritedAt ?? -1) - (a.favoritedAt ?? -1));
  }

  // Normal Gallery ordering is unchanged.
  return filtered;
}

async function loadFiles(fileList) {
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

  try {
    const items = await provider.loadFromFileList(fileList, {
      batchSize: BATCH_SIZE,
      onProgress: (loaded, totalCount) => {
        statusText.textContent = `Loading media… ${loaded} / ${totalCount}`;
      },
    });

    // Stamp favorite/hidden status from the Profile immediately, before
    // getVisibleItems() (used by reloadRuntime below) might filter down to
    // Favorites Only — otherwise that filter would run against items that
    // don't know their own favorite/hidden status yet.
    items.forEach((item) => {
      item.isFavorite = profile.isFavorite(item.relativePath);
      item.isHidden = profile.isHidden(item.relativePath);
      item.favoritedAt = profile.getFavoritedAt(item.relativePath);
      item.userTags = profile.getItemTags(item.relativePath);
    });

    allItems = items;
    reloadRuntime({ randomizeInitial: shouldRandomizeInitialSelection() });
  } finally {
    isLoadingFiles = false;
    setLoadingState(false);
  }
}

function setLoadingState(isLoading, total) {
  fileInput.disabled = isLoading;
  folderInput.disabled = isLoading;
  clearBtn.disabled = isLoading || !allItems.length;

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
  videoLoopStateText.textContent = enabled ? "🔁 ON" : "🔁 OFF";
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

function clearViewerNode() {
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
    video.src = item.url;
    video.controls = true;
    video.playsInline = true;
    video.preload = "metadata";
    video.muted = true;
    currentViewerNode = video;
    viewerStage.appendChild(video);

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
    profile.toggleItemTag(item.relativePath, tag.id);
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

galleryJumpModeFindBtn.addEventListener("click", () => setGalleryJumpMode("find"));
galleryJumpModePlayBtn.addEventListener("click", () => setGalleryJumpMode("play"));
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
  loadFiles(event.target.files);
  folderInput.value = "";
});

intervalInput.addEventListener("change", () => {
  runtime.setIntervalMs(Number(intervalInput.value) * 1000);
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
});

loopInput.addEventListener("change", () => {
  runtime.setLoop(loopInput.checked);
});

videoLoopInput.addEventListener("change", syncVideoLoopControl);

fillInput.addEventListener("change", () => {
  if (fillInput.checked && runtime.getState().isPlaying) {
    enterFillMode();
  } else if (!fillInput.checked) {
    exitFillMode();
  }
});

allMediaBtn.addEventListener("click", () => setViewMode("all"));
favoritesOnlyBtn.addEventListener("click", () => setViewMode("favorites"));

typeAllBtn.addEventListener("click", () => setTypeFilter("all"));
typeImagesBtn.addEventListener("click", () => setTypeFilter("image"));
typeVideosBtn.addEventListener("click", () => setTypeFilter("video"));

tagsFilterToggleBtn.addEventListener("click", () => toggleTagsFilterPanel());

prevBtn.addEventListener("click", () => {
  invalidateActiveFiniteAutomation();
  runtime.previous();
});
nextBtn.addEventListener("click", () => {
  invalidateActiveFiniteAutomation();
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
  allItems = [];
  clearViewerNode();
  exitFillMode();
  lastHiddenRelativePath = null;
  syncUndoHideButton();
});

favoriteBtn.addEventListener("click", () => {
  handleFavoriteToggle();
});

// -- overlay / fill-panel controls --

overlayFavoriteBtn.addEventListener("click", () => {
  handleFavoriteToggle();
});

overlayPrevBtn.addEventListener("click", () => {
  invalidateActiveFiniteAutomation();
  runtime.previous();
});
overlayNextBtn.addEventListener("click", () => {
  invalidateActiveFiniteAutomation();
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

  if (automationPanel.classList.contains("hidden")) {
    openAutomationEditor();
  } else {
    // Closing via 🤖 again is navigation, not a cancel-with-side-effects:
    // discard whatever draft was mid-edit, but never touch the already
    // applied automation (Requirement 7, "close without Apply").
    closeAutomationEditor();
  }
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
      runtime.next();
      break;
    case "ArrowLeft":
      event.preventDefault();
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
      const label = document.createElement("span");
      label.className = "tag-chip";
      label.textContent = tag.name;
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
  renderTagsGrid();
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
  downloadTextFile(`gallery-profile-${stamp}.json`, text);

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

// ---- Boot ---------------------------------------------------------------

runtime.setShuffle(shuffleInput.checked);
runtime.setLoop(loopInput.checked);
syncVideoLoopControl();
resetLoopRuleToDefault();
syncUndoHideButton();
renderTagsGrid();
renderTagsFilterGrid();
runtime.setIntervalMs(Number(intervalInput.value) * 1000);
applyGhostOpacity(Number(ghostOpacityInput.value));

runtime.subscribe(render);

window.addEventListener("beforeunload", () => {
  runtime.stop();
  provider.dispose();
});
