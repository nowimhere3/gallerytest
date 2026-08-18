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
  // [PHASE-6-SYNC-V2][STAGE-E-LIVE-INTEGRATION]
  // [WHY: linkLocalLibraryToSharedId is the ONLY way a second device attaches
  //  its own physical folder to an already-shared library, and it is reachable
  //  from exactly one explicit user action (see the Link Shared Library
  //  controls) — never from a folder open, a name match, or a signature match.]
  getLibraryByLibraryId,
  linkLocalLibraryToSharedId,
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

// [UI-REDESIGN / Stage 6] The narrow-screen shell's own elements. Captured
// here with everything else — they are static markup like the rest, never
// created on first use, so the module-scope capture rule is unchanged.
const mobileContextText = document.getElementById("mobile-context-text");
const mobileControlsBtn = document.getElementById("mobile-controls-btn");
const controlsPanel = document.getElementById("controls-panel");
const controlsDrawerCloseBtn = document.getElementById("controls-drawer-close-btn");
const controlsScrim = document.getElementById("controls-scrim");

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
// [UI-REDESIGN / Stage 3] #fill-input retired — see index.html. Fill is now
// the explicit #fill-panel-btn action plus this preference.
const autoplayOnFillInput = document.getElementById("autoplay-on-fill-input");
const fillPanelBtn = document.getElementById("fill-panel-btn");

// [UI-REDESIGN / Stage 3] The Playback popover's own two elements. The
// controls INSIDE the popover are the same ones captured just above — they
// moved parents, not identities, so nothing else in this file changed.
const playbackSettingsBtn = document.getElementById("playback-settings-btn");
const playbackSettingsPopover = document.getElementById("playback-settings-popover");
// [UI-REDESIGN / Stage 6] The sheet's own × and its backdrop. Both belong to
// the SAME popover element above — there is no separate mobile panel, and
// these two are inert on desktop because CSS hides them there.
const playbackSheetCloseBtn = document.getElementById("playback-sheet-close-btn");
const playbackSheetScrim = document.getElementById("playback-sheet-scrim");

const allMediaBtn = document.getElementById("all-media-btn");
const favoritesOnlyBtn = document.getElementById("favorites-only-btn");

const typeAllBtn = document.getElementById("type-all-btn");
const typeImagesBtn = document.getElementById("type-images-btn");
const typeVideosBtn = document.getElementById("type-videos-btn");

const tagsFilterToggleBtn = document.getElementById("tags-filter-toggle-btn");
const tagsFilterPanel = document.getElementById("tags-filter-panel");
const tagsFilterEmpty = document.getElementById("tags-filter-empty");
const tagsFilterGrid = document.getElementById("tags-filter-grid");
// [UI-REDESIGN / STAGE 6] [TAG-DISCOVERY-HANDOFF]
const manageTagsBtn = document.getElementById("manage-tags-btn");

const profileSelect = document.getElementById("profile-select");
const profileSectionDetails = document.querySelector(".profile-section");
// [UI-REDESIGN / STAGE 6] [TAGS-PROFILE-ADMIN] [PROFILE-TAGS-DISCLOSURE]
const tagsAdminSectionDetails = document.querySelector(".tags-admin-section");
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
const profileSyncActivatePanel = document.getElementById("profile-sync-activate-panel");
const profileSyncActivateBtn = document.getElementById("profile-sync-activate-btn");
const profileSyncLinkPanel = document.getElementById("profile-sync-link-panel");
const profileSyncLinkSelect = document.getElementById("profile-sync-link-select");
const profileSyncLinkBtn = document.getElementById("profile-sync-link-btn");
const profileSyncLinkStatus = document.getElementById("profile-sync-link-status");
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
// [UI-REDESIGN / Stage 6] #play-btn is the transport's ONE Play/Pause button
// and #play-pause-icon is the single <path> inside it whose `d` it swaps.
// The former #stop-btn capture is gone with the element; nothing else in this
// file referenced it.
const playBtn = document.getElementById("play-btn");
const playPauseIcon = document.getElementById("play-pause-icon");
const clearBtn = document.getElementById("clear-btn");

const statusText = document.getElementById("status-text");
const selectedText = document.getElementById("selected-text");
const viewModeText = document.getElementById("view-mode-text");
const associatedText = document.getElementById("associated-text");

// [UI-REDESIGN / STAGE 6] [MOBILE-LIVE-STATUS-TAKEOVER] The mobile-only
// takeover composition — see its own block below for how each is driven.
const mobileLoadPrimaryText = document.getElementById("mobile-load-primary-text");
const mobileLoadActivityBar = document.getElementById("mobile-load-activity-bar");
const mobileLoadCountText = document.getElementById("mobile-load-count-text");
const mobileLoadAscii = document.getElementById("mobile-load-ascii");
const mobileLoadAtmosphereText = document.getElementById("mobile-load-atmosphere-text");
// [UI-REDESIGN / STAGE 6] [PLAYER-TRANSPORT-COUNTER-RETIRE] #counter-text and
// its capture (formerly `counterText`) are gone — the Player transport is
// actions only now; Gallery's target control (see syncGalleryJumpTarget())
// is the normal visible position/context surface.
const galleryCount = document.getElementById("gallery-count");

const viewerPanel = document.getElementById("viewer-panel");
const viewerEmpty = document.getElementById("viewer-empty");
const viewerStage = document.getElementById("viewer-stage");
const favoriteBtn = document.getElementById("favorite-btn");

const galleryEmpty = document.getElementById("gallery-empty");
const galleryGrid = document.getElementById("gallery-grid");

const galleryJumpInput = document.getElementById("gallery-jump-input");
// [UI-REDESIGN / STAGE 6] [GALLERY-TARGET-PROGRESSIVE-FLOW] The valid-range
// total, a plain non-editable readout next to the target input.
const galleryJumpTotalText = document.getElementById("gallery-jump-total");
// [UI-REDESIGN / STAGE 6] [GALLERY-TARGET-PROGRESSIVE-FLOW] Replaces the
// retired "Use Current" button — validates the target and advances to Step 2.
const galleryJumpNextBtn = document.getElementById("gallery-jump-next-btn");
// Step 2's two action buttons — same ids, same underlying jump logic as
// before this pass; only the mode-toggle behavior around them changed.
const galleryJumpModeFindBtn = document.getElementById("gallery-jump-mode-find-btn");
const galleryJumpModePlayBtn = document.getElementById("gallery-jump-mode-play-btn");
// [UI-REDESIGN / STAGE 6] [GALLERY-STEP2-ACTION-REFINEMENT] Mobile-only
// escape from Step 2 back to Step 1 — see its click handler for the exact,
// deliberately narrow contract.
const galleryJumpBackBtn = document.getElementById("gallery-jump-back-btn");
// [UI-REDESIGN / STAGE 6] [GALLERY-TARGET-PROGRESSIVE-FLOW] The two step
// wrappers — see setGalleryJumpStep() for how they are driven. Real layout
// containers on every viewport now, not a desktop-only display:contents
// passthrough — see styles.css.
const galleryJumpStepSelect = document.getElementById("gallery-jump-step-select");
const galleryJumpStepAction = document.getElementById("gallery-jump-step-action");
const nowPlayingStrip = document.getElementById("now-playing-strip");
const nowPlayingName = document.getElementById("now-playing-name");
const nowPlayingStopBtn = document.getElementById("now-playing-stop-btn");
const nowPlayingReturnBtn = document.getElementById("now-playing-return-btn");

// [UI-REDESIGN / Stage 1A]
// WHAT: The workspace shell's four tabs and four panels, captured here
// alongside every other module-scope reference.
// WHY: These are captured, not queried on demand, for exactly the reason
// the rest of this block is — every one of them must already exist in
// index.html when this module parses. That is also why the panels are
// switched with the `hidden` attribute rather than being created on first
// activation: a panel built at activation time would leave these consts
// pointing at nothing, silently.
// FUTURE: A new workspace adds a static tab + panel to index.html, a pair
// of captures here, and a row in WORKSPACES below. Nothing else.
// [UI-REDESIGN / STAGE 6] [MVP-WORKSPACE-IA] workspaceTabTaggingBtn /
// workspaceTaggingPanel are gone — the Tagging workspace itself is removed
// (its administration content now lives inside #workspace-settings, see
// tagsAdminSectionDetails below). Three destinations remain: gallery,
// cookbook (Automations), settings (Profile).
const workspaceTabGalleryBtn = document.getElementById("workspace-tab-gallery");
const workspaceTabCookbookBtn = document.getElementById("workspace-tab-cookbook");
const workspaceTabSettingsBtn = document.getElementById("workspace-tab-settings");
const workspaceGalleryPanel = document.getElementById("workspace-gallery");
const workspaceCookbookPanel = document.getElementById("workspace-cookbook");
const workspaceSettingsPanel = document.getElementById("workspace-settings");

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

// [UI-REDESIGN / STAGE 6] [PM-AUTOMATIONS-CANONICAL]
// The canonical PM Automations entry point (at every width now) and the
// tray it opens — see index.html's own comments on these elements for the
// full architecture.
const overlayAutomationsMenuBtn = document.getElementById("overlay-automations-menu-btn");
const pmAutomationsGroup = document.getElementById("pm-automations-group");
// [UI-REDESIGN / STAGE 6] [PM-AUTOMATIONS-MEDIA-SUPPORT]
const pmAutomationsPhotoEmpty = document.getElementById("pm-automations-photo-empty");

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

// ---- Workspace shell -------------------------------------------------------

// [UI-REDESIGN / Stage 1A]
// WHAT: The whole workspace switcher. setActiveWorkspace() does exactly
// three things — flip `hidden` on the panels, flip `aria-selected`
// and roving tabindex on the tabs, and record which one is active.
// WHY: It is deliberately this small. Switching workspaces must not reload
// the library, reset filters, change Profiles, destroy the current item,
// or stop playback — so this function touches no runtime, filter, profile,
// or library state and calls no render function. It cannot regress any of
// those because it never speaks to them. Playback state lives in
// MediaRuntime, filters in viewMode/typeFilter/activeTagFilters, library
// identity in currentSourceKind/activeLibraryRecord; none is derived from
// DOM visibility, and render() keeps arriving via runtime.subscribe(render)
// while a panel is hidden, so a workspace is already correct when it
// reappears.
// FUTURE: Keep this function free of side effects. If a workspace ever
// needs to refresh on activation, give that workspace its own subscriber
// rather than growing a render call here — and never swap `hidden` for the
// app's `.hidden` class, which feature code already owns.
// [UI-REDESIGN / STAGE 6] [MVP-WORKSPACE-IA]
// WHAT: Three permanent MVP V1 destinations — the "tagging" entry is gone.
// WHY: primary navigation should represent frequent product destinations,
// not every feature module; tag administration moved into the "settings"
// (Profile) panel instead of keeping its own top-level entry — see
// tagsAdminSectionDetails / expandAndScrollToTagsSection() below. Removing
// the entry here is sufficient by itself: the click/keydown wiring loop and
// the Left/Right/Home/End keyboard navigation just below both iterate this
// array, so neither needed a separate edit to stop reaching a workspace
// that no longer exists.
const WORKSPACES = [
  { name: "gallery", tab: workspaceTabGalleryBtn, panel: workspaceGalleryPanel },
  { name: "cookbook", tab: workspaceTabCookbookBtn, panel: workspaceCookbookPanel },
  { name: "settings", tab: workspaceTabSettingsBtn, panel: workspaceSettingsPanel },
];

let activeWorkspace = "gallery";

function setActiveWorkspace(name, { focusTab = false } = {}) {
  const target = WORKSPACES.find((entry) => entry.name === name);
  if (!target) return;

  activeWorkspace = target.name;

  WORKSPACES.forEach((entry) => {
    const isActive = entry === target;
    entry.panel.hidden = !isActive;
    entry.tab.setAttribute("aria-selected", isActive ? "true" : "false");
    // Roving tabindex: the tablist is one Tab stop, arrows move within it.
    entry.tab.tabIndex = isActive ? 0 : -1;
  });

  if (focusTab) target.tab.focus();

  // [UI-REDESIGN / Stage 6]
  // WHAT: Brings the selected tab fully into view in the horizontally
  // scrolling tablist.
  // WHY: On narrow screens the four tabs overflow, so arrowing from Gallery to
  // Settings could select a tab that is off screen — the roving tabindex moves
  // and nothing appears to happen. `inline: "nearest"` scrolls the tablist by
  // the minimum needed and `block: "nearest"` makes the vertical axis a no-op
  // when the bar is already visible, so this never yanks the page around on
  // desktop, where the tabs do not overflow and the call does nothing at all.
  // This does not violate the "no side effects" rule above: scrolling a
  // scroll container is not application state — no runtime, filter, profile or
  // library value is touched, and nothing here is persisted.
  // FUTURE: Keep it to scrollIntoView. Do not grow focus or selection logic
  // here; that belongs in the loop that owns the tabs.
  target.tab.scrollIntoView({ inline: "nearest", block: "nearest" });

  // [UI-REDESIGN / Stage 4] The one deliberate exception to the "no side
  // effects" rule above, and worth stating plainly rather than hiding.
  // The now-playing strip is a function of WHICH workspace is active, so it
  // genuinely cannot be kept correct without a call here — its runtime
  // subscription only ever hears about playback, never about navigation.
  // This stays safe because syncNowPlayingStrip() is read-only: it inspects
  // runtime state and activeWorkspace and toggles one `hidden` attribute. It
  // touches no runtime, filter, profile or library state and calls no render
  // function, so the guarantees in the comment above still hold.
  // FUTURE: This must remain the only such call, and it must stay read-only.
  // Anything that needs to MUTATE state on workspace activation still
  // belongs in its own subscriber, not here.
  syncNowPlayingStrip();
}

// [UI-REDESIGN / Stage 1A]
// WHAT: Brings the Gallery workspace forward before an action that targets
// an element living inside it.
// WHY: Some controls outside the Gallery workspace hand work to a control
// inside it — the Tag Status Update Center's "Find" writes into the
// Gallery Jump input and focuses it. focus()/scrollIntoView() on a
// display:none element fail silently, so without this the value would be
// set somewhere the user cannot see.
// FUTURE: Any future cross-workspace hand-off must call this (or its
// equivalent for another workspace) FIRST — never duplicate the target
// control into the calling workspace to avoid the problem.
function ensureGalleryWorkspaceVisible() {
  if (activeWorkspace !== "gallery") setActiveWorkspace("gallery");
}

// [UI-REDESIGN / Stage 6 fix]
// WHAT: The one route for "the user explicitly asked to go to Gallery, so
// hand the keyboard to the Player." Brings Gallery forward, then moves focus
// to the Player stage via focusPlayerStage(). Returns whether the hand-off
// actually happened.
//
// ROOT CAUSE this addresses: the now-playing strip's Return button had this
// behavior (Stage 5) but the workspace tablist's Gallery tab did not — its
// click handler was `() => setActiveWorkspace(entry.name)` and nothing else,
// so the tab stayed document.activeElement. The tab carries role="tab", which
// isKeyboardFocusedControl() matches, and :focus-visible latches on the next
// keypress — so ArrowLeft/ArrowRight/Space/F were suppressed for as long as
// the tab held focus, playing or stopped, from any workspace. (L kept working
// because it is exempt from that guard.) The two routes had drifted apart;
// they now share this function so they cannot drift again.
//
// Order is load-bearing: Gallery must come forward FIRST, because
// #viewer-stage lives inside that panel and focus() is a silent no-op on a
// display:none element.
//
// This touches no runtime, filter, profile, history or library state — it is
// setActiveWorkspace() plus a focus move — so playback continues untouched.
//
// FUTURE: This is deliberately NOT wired to render(), boot, filter changes or
// any runtime subscription. It is called ONLY on explicit ACTIVATION of a
// user-facing "go to Gallery" control — pointer click or Enter/Space alike,
// which is why callers do not filter on `event.detail`. Anything that focuses
// the Player as a side effect of Gallery state updating would steal focus out
// from under a user who is typing in Jump or tabbing the filters, and
// anything wired to tablist NAVIGATION (Arrow/Home/End) would take the
// keyboard away mid-arrow.
function returnToGalleryAndFocusPlayer({ onNoPlayer } = {}) {
  ensureGalleryWorkspaceVisible();
  if (focusPlayerStage()) return true;
  // Nothing mounted on the stage — no media loaded, or every item hidden.
  // There is no Player to hand the keyboard to, so each caller decides what
  // "sensible focus" means for the control the user just activated rather
  // than focusing an empty, `.hidden` stage.
  onNoPlayer?.();
  return false;
}

// [UI-REDESIGN / Stage 4]
// WHAT: Shows the now-playing strip only while a slideshow is running AND
// the user is looking at something other than Gallery.
// WHY: Both halves of that condition matter. In Gallery the Player and its
// transport are already on screen, so the strip would be noise; away from
// Gallery there is otherwise no sign playback is still running and no way to
// stop it without navigating back first.
// It derives everything from state it is given and holds none of its own —
// no "is the strip showing" flag, no cached filename. That is why it is safe
// to call from both the runtime subscription and setActiveWorkspace().
// FUTURE: Read-only. If this ever needs to CHANGE playback, route through an
// existing runtime action the way #now-playing-stop-btn routes to
// runtime.stop() — never add playback logic here.
function syncNowPlayingStrip(state = runtime.getState()) {
  const shouldShow = state.isPlaying && activeWorkspace !== "gallery";
  nowPlayingStrip.hidden = !shouldShow;
  if (!shouldShow) return;
  nowPlayingName.textContent = state.currentItem ? state.currentItem.name : "";
}

// [UI-REDESIGN / Stage 1C]
// WHAT: The same hand-off for the Settings workspace, which is where the
// Profile section now lives.
// WHY: The rail's "Associate with Profile" / "Change Profile" shortcut has
// always been navigation-only — it opens the Profile disclosure, scrolls to
// it, and focuses a control inside it. Now that the section sits in a
// hidden panel, both scrollIntoView() and focus() would silently do
// nothing, so the button would look dead. Same failure mode, and same fix,
// as ensureGalleryWorkspaceVisible() above.
// FUTURE: This is the ONLY sanctioned route from the rail to Profile
// management. Do not answer a future "the rail should let me switch
// profiles" request by adding a second selector to the rail.
function ensureSettingsWorkspaceVisible() {
  if (activeWorkspace !== "settings") setActiveWorkspace("settings");
}

WORKSPACES.forEach((entry, index) => {
  entry.tab.addEventListener("click", () => {
    // [UI-REDESIGN / Stage 6 fix]
    // Activating the Gallery tab is an explicit "take me back to the media",
    // exactly like the now-playing strip's Return button, so it goes through
    // the same hand-off. That includes activating Gallery while Gallery is
    // already selected — ensureGalleryWorkspaceVisible() is a no-op then, and
    // the hand-off is the entire point of the activation.
    //
    // Deliberately NOT split on `event.detail` the way the Gallery filter
    // buttons are. That split exists where pointer and keyboard users want
    // different outcomes (a tabbed-to filter must keep its focus and its
    // ring). Here they want the SAME outcome: pressing Enter or Space on the
    // Gallery tab is every bit as explicit a request for the media as
    // clicking it, and a keyboard user who lands in Gallery with the Player
    // shortcuts still suppressed is exactly the bug this fixes. So both
    // activation routes hand the keyboard to the Player.
    //
    // What keeps the tablist usable is that this is the ACTIVATION handler,
    // not the navigation one. Arrow/Home/End never reach it — they go through
    // the keydown listener below, which calls setActiveWorkspace(...,
    // { focusTab: true }) and leaves focus on the tab so arrowing onward
    // keeps working. Only a deliberate Enter/Space/click gives the Player the
    // keyboard.
    //
    // On the no-media path there is no fallback to run: the activation has
    // already put focus on the tab and it stays there. No blur — dropping
    // focus to <body> from a tab the user is still on is worse than leaving
    // it where they put it, and for the keyboard user it would be a dead end.
    if (entry.name === "gallery") {
      returnToGalleryAndFocusPlayer();
      return;
    }
    setActiveWorkspace(entry.name);
  });

  entry.tab.addEventListener("keydown", (event) => {
    const lastIndex = WORKSPACES.length - 1;
    let nextIndex = null;

    if (event.key === "ArrowRight") nextIndex = index === lastIndex ? 0 : index + 1;
    else if (event.key === "ArrowLeft") nextIndex = index === 0 ? lastIndex : index - 1;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = lastIndex;

    if (nextIndex === null) return;
    event.preventDefault();
    setActiveWorkspace(WORKSPACES[nextIndex].name, { focusTab: true });
  });
});

// Redundant with the static markup (Gallery already ships selected), but
// explicit so the boot state can never drift from this function's rules.
setActiveWorkspace("gallery");

// ---- App state -----------------------------------------------------------

let allItems = [];
let viewMode = "all"; // "all" | "favorites"
let typeFilter = "all"; // "all" | "image" | "video" — Media Type filter (Filtering Phase 1)
let activeTagFilters = []; // tag ids — Gallery Tag Filtering (Phase 6.3), AND-combined via filterMedia
// WHAT: Session-global viewing preference applied while deriving the runtime list.
// WHY: Duplicate suppression must be reversible and must not become Profile or library-registry data.
// FUTURE / DO-NOT-BREAK: Preferences may supply its initial value later; keep loaded media ownership in allItems.
let skipDuplicates = false;
// [UI-REDESIGN / STAGE 6] [GALLERY-TARGET-PROGRESSIVE-FLOW]
// Replaces the old galleryJumpMode "find" | "play" persistent toggle — Find
// Below/Load in Player are one-shot actions now, so there is no longer a
// standing "which mode is selected" to track between jumps.
// galleryJumpConfirmedIndex: the zero-based index Next → validated, held only
// for the brief window Step 2 is showing so Find Below/Load in Player know
// what to act on. Cleared the moment either fires.
let galleryJumpConfirmedIndex = null;
// galleryJumpIsEditing: true while the target input holds user-authored
// content that has not yet been confirmed (Next) or abandoned-and-restored
// (blur while empty). The ONLY thing this gates is whether
// syncGalleryJumpTarget() is allowed to overwrite `.value` from runtime
// truth on the next render() — it exists specifically so a background state
// change (playback advancing, a filter changing the total) cannot silently
// clobber what the user is mid-typing.
let galleryJumpIsEditing = false;
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

// [TEMP-PROFILE-IDENTITY-AUDIT]
// WHAT: Holds the diagnostics object (dirsVisited/filesSeen/filesSkipped/
// errors/incomplete/fatalError) from the MOST RECENT FSA folder scan, plus
// the remembered registry item count at that load, so the read-only audit
// entry point at the bottom of this file can report FSA completeness
// without re-scanning.
// WHY: FsaFileProvider.loadFromDirectoryHandle() already computes these
// (see fsa-file-provider.js) but they are otherwise local to loadFromFsaHandle
// and discarded after the status line is rendered — the audit needs them to
// tell "media never discovered" (discovery failure) apart from "media
// discovered, key differs" (identity failure).
// FUTURE / DO-NOT-BREAK: This is capture-only. It must never influence the
// load result, the reported count, or any control flow. Remove it together
// with the __bgProfileIdentityAudit block below once the cross-device cause
// is proven.
let __identityAuditLastFsaLoad = null;

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
  // [UI-REDESIGN / Stage 6] Ordered after updateAssociatedStatusRow() on
  // purpose — the compact header mirrors that function's output, so it must
  // read the row only once the row is current.
  syncMobileContextSummary();
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
  // [UI-REDESIGN / Stage 1C] Must come first — everything below acts on an
  // element inside the Settings workspace.
  ensureSettingsWorkspaceVisible();
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

// [UI-REDESIGN / STAGE 6] [TAGS-PROFILE-ADMIN] [PROFILE-TAGS-DISCLOSURE]
// [TAG-DISCOVERY-HANDOFF]
// WHAT: The Tags-section equivalent of expandAndScrollToProfileSection()
// immediately above — same shape, same reasoning, reusing the same
// ensureSettingsWorkspaceVisible() navigation path rather than inventing a
// second one. Expands <details class="tags-admin-section"> if collapsed,
// scrolls it into view, and focuses the tag-creation input.
// WHY: removing Tagging from top-level navigation must not make tag
// creation/administration harder to reach — every "go manage tags"
// affordance (the Gallery tag-filter empty state's Manage Tags button
// today; any future one) should call this rather than leaving the user to
// find Profile → Tags and open it manually.
// FUTURE: Any future "take me to tag administration" control calls THIS —
// never a second Tags-opening mechanism.
function expandAndScrollToTagsSection() {
  ensureSettingsWorkspaceVisible();
  if (tagsAdminSectionDetails && !tagsAdminSectionDetails.open) {
    tagsAdminSectionDetails.open = true;
  }
  tagsAdminSectionDetails?.scrollIntoView({ behavior: "smooth", block: "start" });
  tagCreateInput?.focus();
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
// [UI-REDESIGN / STAGE 6] [PM-HIDE-UNDO-WAYPOINT] [PM-HIDE-UNDO-WAYPOINT-RUNTIME-FIX]
// WHAT: Deliberately NOT a general history/command stack — one short-lived
// navigation WAYPOINT, per spec. Remembers the most recent Hide as three
// things: which item was hidden (hiddenRelativePath — restorable via
// ProfileStore, same as before), which item MediaRuntime landed on
// immediately afterward (landingItemId — the waypoint itself), and the
// runtime's OWN navigationStep counter value at that moment
// (landingNavigationStep — the expiration baseline; see below).
// WHY a waypoint keyed to the landing position, not a global "something is
// undoable" flag: Undo belongs to the specific media position reached
// immediately after a Hide, not to the user globally wherever they wander
// next. syncUndoHideButton() below only offers Undo while the CURRENT item
// is literally that landing item — see its own comment.
// landingItemId uses MediaItem.id (the same in-memory position identity
// `preserveId`/`pendingFilterReloadItemId` already use elsewhere), not
// relativePath — this is a live, in-session position comparison, never
// touching persisted storage. hiddenRelativePath still uses relativePath,
// because restoring it goes straight through ProfileStore.setHidden (the
// same path toggleHidden uses, keyed by file path, same as before) — this
// never becomes a second source of truth for hidden state, only for which
// record to restore and whether that offer is still honest right now.
//
// ROOT CAUSE of an earlier version of this waypoint failing in real-browser
// testing (an isolated Node simulation of the SAME logic passed cleanly,
// which is why this needed tracing rather than re-guessing): forward-step
// counting used to be driven by wrapping the SIX manual Prev/Next call
// sites (goToPreviousMedia/goToNextMedia, the PM overlay buttons, PM's
// keyboard Left/Right). But MediaRuntime.next() is ALSO called from two
// places no external wrapper can ever see: the slideshow's own interval
// timer (armed by #scheduleAdvance() any time Presentation is playing,
// including immediately after a Hide auto-advances onto the landing item
// itself) and a video's "ended" event via notifyVideoEnded(). Any one of
// those firing between "land on B" and "click Back" moved the real
// position without the external counter ever knowing — the exact "main.js
// cannot get in front of them" problem handlePendingFilterReloadOnAdvance()
// elsewhere in this file already had to solve for a different feature.
// FIX: MediaRuntime itself now maintains navigationStep — a plain
// increment-on-next/decrement-on-previous counter touched in every branch
// that actually moves the current position, shuffle and sequential alike,
// regardless of what triggered the call (see that field's own comment in
// media-runtime.js). recentHideUndo captures navigationStep's value at the
// moment it lands on B; expiration is then a REACTIVE comparison —
// `runtime.getState().navigationStep - recentHideUndo.landingNavigationStep`
// — recomputed on every render (see syncUndoHideButton()), so it can never
// be bypassed by a navigation this file didn't directly initiate.
let recentHideUndo = null; // { hiddenRelativePath, landingItemId, landingNavigationStep } | null

// How many net steps past the landing waypoint's navigationStep baseline
// remain recoverable (0 through 3 all still recover Undo by returning to
// B; a net distance of 4 discards the waypoint outright) — see
// syncUndoHideButton()'s own comment for exactly how this is applied.
const HIDE_UNDO_RECOVERY_WINDOW_STEPS = 3;

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

// ---- [UI-REDESIGN / STAGE 6] [MOBILE-LIVE-STATUS-TAKEOVER] ---------------
//
// WHAT: the compact mobile shell's alternate presentations while a folder
// load is in flight or its last attempt failed — a focused Live Status
// takeover during genuine activity, a narrower "show the real error"
// presentation once it fails — plus the automatic hand-off into the Player
// once loading genuinely finishes. Both loaders (legacy loadFiles() and FSA
// loadFromFsaHandle(), including its remembered-library resume calls) drive
// this through the SAME state below; there is no second implementation.
//
// WHY "loading" is never derived from a progress callback's own counters:
// there is a known, unresolved bug where a load's progress reaches N / N and
// never actually finishes (the pipeline stalls somewhere between the last
// onProgress tick and runtime.load() actually running). Defining this view's
// exit condition as "processed === total" would silently paper over that —
// the mobile shell would claim success the app itself has not reached. Using
// isLoadingFiles instead is correct specifically because it is already the
// SAME flag both loaders use to guard against a second concurrent load, and
// it is set false in the identical `finally` block that runs only after
// finishLoadingItems() -> reloadRuntime() -> runtime.load() has actually
// executed — not after any particular progress number. If that pipeline
// hangs, isLoadingFiles correctly stays true and this view correctly stays
// on Live Status; this task does not fix that bug, and this code does not
// pretend to.
let lastMobileLoadFailed = false;
let previousMobileLoadState = null;

// The 980 here MUST match the compact breakpoint in styles.css. It exists
// only to gate the one non-cosmetic effect below (moving focus) — every
// visual effect of [data-mobile-load-state] is already scoped by the real
// stylesheet media query and needs no JS check of its own.
function isCompactViewport() {
  return window.matchMedia("(max-width: 980px)").matches;
}

// [UI-REDESIGN / STAGE 6] [MOBILE-LIVE-STATUS-TAKEOVER]
// WHAT: mirrors the exact loaded/total numbers the two onProgress callbacks
// already have into the takeover's own primary-state and count readouts, and
// into the activity bar. Never a second computation of progress — call
// sites pass exactly the values they already have on hand for #status-text.
// total === null means "not knowable yet" (the FSA scan has no total until
// it finishes): the count line is hidden rather than showing a fabricated or
// partial total, and the activity bar's indeterminate sweep (driven by the
// animation tick below) takes over instead of a fake percentage.
let mobileLoadHasKnownTotal = false;
const MOBILE_ACTIVITY_BAR_WIDTH = 10;

function renderMobileLoadProgress(primaryText, loaded, total) {
  mobileLoadPrimaryText.textContent = primaryText;
  mobileLoadHasKnownTotal = typeof total === "number" && total > 0;

  if (mobileLoadHasKnownTotal) {
    mobileLoadCountText.textContent = `${loaded.toLocaleString()} / ${total.toLocaleString()} media files`;
    mobileLoadCountText.classList.remove("hidden");
    renderMobileActivityBarRatio(loaded / total);
  } else {
    mobileLoadCountText.textContent = "";
    mobileLoadCountText.classList.add("hidden");
    // Left as whatever the last indeterminate sweep tick drew — the next
    // tick (every 550ms while animating) repaints it regardless.
  }
}

function renderMobileActivityBarRatio(ratio) {
  const filled = Math.round(Math.max(0, Math.min(1, ratio)) * MOBILE_ACTIVITY_BAR_WIDTH);
  mobileLoadActivityBar.textContent = `[${"▓".repeat(filled)}${"░".repeat(MOBILE_ACTIVITY_BAR_WIDTH - filled)}]`;
}

function renderMobileActivityBarSweep(tick) {
  const windowSize = 3;
  const span = MOBILE_ACTIVITY_BAR_WIDTH - windowSize;
  const pos = tick % (span + 1);
  const cells = new Array(MOBILE_ACTIVITY_BAR_WIDTH).fill("░");
  for (let i = 0; i < windowSize; i++) cells[pos + i] = "▓";
  mobileLoadActivityBar.textContent = `[${cells.join("")}]`;
}

// [UI-REDESIGN / STAGE 6] [MOBILE-LIVE-STATUS-TAKEOVER]
// WHAT: a 6-frame, ping-pong "scan brackets" loop — abstract corner marks
// breathing in and out around a centre dot — plus a short, restrained set of
// atmospheric phrases. Both are pure decoration: neither is read by, nor
// feeds back into, any loader state. Every line is fixed-width (verified
// equal length) so the box never jitters between frames.
const MOBILE_TAKEOVER_FRAMES = [
  "┌───────────────┐\n│ ◢           ◣ │\n│       ·       │\n│ ◥           ◤ │\n└───────────────┘",
  "┌───────────────┐\n│    ◢     ◣    │\n│       ◦       │\n│    ◥     ◤    │\n└───────────────┘",
  "┌───────────────┐\n│      ◢ ◣      │\n│       ◉       │\n│      ◥ ◤      │\n└───────────────┘",
  "┌───────────────┐\n│      ◢ ◣      │\n│       ●       │\n│      ◥ ◤      │\n└───────────────┘",
  "┌───────────────┐\n│      ◢ ◣      │\n│       ◉       │\n│      ◥ ◤      │\n└───────────────┘",
  "┌───────────────┐\n│    ◢     ◣    │\n│       ◦       │\n│    ◥     ◤    │\n└───────────────┘",
];

const MOBILE_ATMOSPHERE_PHRASES = ["Building your gallery…", "Still working…", "Preparing your media…"];

let mobileTakeoverAnimationTimer = null;

// [UI-REDESIGN / STAGE 6] [MOBILE-LIVE-STATUS-TAKEOVER]
// Idempotent — a second call while already running is a no-op, so this can
// never be started twice into two concurrent intervals. `tick` lives in this
// call's own closure, so every fresh load starts the loop at frame 0 with no
// state carried over from a previous one.
// Respects prefers-reduced-motion by painting exactly one frame and
// returning before the interval is ever created — see the WHY below.
function startMobileTakeoverAnimation() {
  if (mobileTakeoverAnimationTimer !== null) return;

  let tick = 0;
  const renderTick = () => {
    mobileLoadAscii.textContent = MOBILE_TAKEOVER_FRAMES[tick % MOBILE_TAKEOVER_FRAMES.length];
    if (!mobileLoadHasKnownTotal) renderMobileActivityBarSweep(tick);
    if (tick % 8 === 0) {
      mobileLoadAtmosphereText.textContent = MOBILE_ATMOSPHERE_PHRASES[(tick / 8) % MOBILE_ATMOSPHERE_PHRASES.length];
    }
    tick += 1;
  };

  renderTick(); // paint immediately — no blank first frame while the interval's first tick is still pending

  // WHY checked here rather than once at module load: the user's OS-level
  // preference can only sensibly change between page loads for this app's
  // purposes, so checking once per takeover start (not reactively) is
  // correct and matches isCompactViewport()'s own once-per-transition check
  // above.
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  mobileTakeoverAnimationTimer = setInterval(renderTick, 550);
}

// Idempotent — safe to call even when nothing is running (every
// syncMobileLoadState() exit path from "loading" calls this unconditionally
// rather than trying to remember whether reduced-motion left it unset).
function stopMobileTakeoverAnimation() {
  if (mobileTakeoverAnimationTimer === null) return;
  clearInterval(mobileTakeoverAnimationTimer);
  mobileTakeoverAnimationTimer = null;
}

// The single place that decides the mobile load state and writes it to the
// DOM. Called immediately after every place isLoadingFiles or
// lastMobileLoadFailed changes (four call sites, all inside loadFiles() /
// loadFromFsaHandle()) — never from a general subscription, so it cannot
// silently drift out of sync with the two flags it reads.
//
// Three values, not two: "loading" (isLoadingFiles true — genuine activity,
// the full focused takeover, everything else in the panel hidden because
// none of it is actionable while every picker control is already disabled),
// "failed" (isLoadingFiles false but the last attempt's error is still the
// most current truth — the takeover's animation/bar/atmosphere stop, but the
// Libraries block stays visible because that is where the real error
// (#fsa-status-text) lives and where the user retries), and "normal"
// (neither — the ordinary compact shell, unchanged from before this state
// existed).
function syncMobileLoadState() {
  const state = isLoadingFiles ? "loading" : lastMobileLoadFailed ? "failed" : "normal";
  const wasActivelyLoading = previousMobileLoadState === "loading";
  const isActivelyLoading = state === "loading";

  appShell.dataset.mobileLoadState = state;

  if (!wasActivelyLoading && isActivelyLoading) startMobileTakeoverAnimation();

  if (wasActivelyLoading && !isActivelyLoading) {
    stopMobileTakeoverAnimation();

    // [UI-REDESIGN / STAGE 6] [MOBILE-LIVE-STATUS-TAKEOVER]
    // Fires exactly once, exactly on the loading -> genuinely-succeeded edge:
    // state === "normal" excludes the failure edge, and .app-has-media
    // (buildViewer()'s own truth about whether the Player has something to
    // show — see its own comment) is already correct by the time this runs,
    // because finishLoadingItems() -> reloadRuntime() -> runtime.load() ->
    // render() -> buildViewer() has already executed earlier in the same
    // synchronous call, before the `finally` block that resets
    // isLoadingFiles and calls this function reaches this line.
    //
    // returnToGalleryAndFocusPlayer() is documented as deliberately NOT
    // wired to render() or any runtime subscription, to stop a background
    // update from stealing focus out from under a user mid-interaction
    // elsewhere in Gallery. This call site is a deliberate, narrow exception
    // to that rule: .media-content — including the Jump box and filters
    // that note is protecting — has been hidden by
    // [data-mobile-load-state="loading"] CSS for this entire load, so there
    // is nothing on screen for this to interrupt. It is also gated to the
    // compact viewport only, so desktop never receives this auto-focus
    // behavior at all.
    if (state === "normal" && appShell.classList.contains("app-has-media") && isCompactViewport()) {
      returnToGalleryAndFocusPlayer();
    }
  }

  previousMobileLoadState = state;
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
  // [UI-REDESIGN / STAGE 6] [MOBILE-LOAD-STATUS-HANDOFF] A fresh attempt
  // clears any failure the PREVIOUS attempt left showing.
  lastMobileLoadFailed = false;
  syncMobileLoadState();

  // Clear immediately so stale thumbnails / soon-to-be-revoked object URLs
  // from a previous selection aren't left on screen while the new batch
  // loads in the background.
  bumpGalleryGeneration();
  runtime.clear();
  clearViewerNode();
  exitFillMode();
  setLoadingState(true, total);
  // [UI-REDESIGN / STAGE 6] [MOBILE-LIVE-STATUS-TAKEOVER] Mirrors the exact
  // "0 / total" setLoadingState() just wrote into #status-text, so the
  // takeover shows correct numbers from its very first frame rather than
  // sitting blank until the first batch completes.
  renderMobileLoadProgress("Loading media…", 0, total);
  // [UI-REDESIGN / STAGE 6] [PM-HIDE-UNDO-WAYPOINT] A new media load is
  // exactly the kind of major context change that makes any waypoint
  // ambiguous — clearing it here is safer than pretending Undo (or its
  // recovery window) still means anything against a different media set.
  recentHideUndo = null;
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
        renderMobileLoadProgress("Loading media…", loaded, totalCount);
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
    // [UI-REDESIGN / STAGE 6] [MOBILE-LOAD-STATUS-HANDOFF] The authoritative
    // completion point — after finishLoadingItems() (called above, inside the
    // try block, only on success) has already run runtime.load(). This
    // function has no catch block, so an exception here leaves
    // lastMobileLoadFailed at whatever it already was; see that flag's own
    // comment for why that asymmetry with the FSA path is left alone rather
    // than expanded here.
    syncMobileLoadState();
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
  // [UI-REDESIGN / STAGE 6] [MOBILE-LOAD-STATUS-HANDOFF] Same reset as
  // loadFiles() above — covers a fresh pick AND every remembered-library
  // resume call into this same function.
  lastMobileLoadFailed = false;
  syncMobileLoadState();

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
  // [UI-REDESIGN / STAGE 6] [MOBILE-LIVE-STATUS-TAKEOVER] total is null: the
  // FSA scan has no total until it finishes, so the takeover's count line
  // stays hidden and its activity bar runs the indeterminate sweep instead
  // of a fabricated percentage.
  renderMobileLoadProgress("Scanning folder…", 0, null);
  // [UI-REDESIGN / STAGE 6] [PM-HIDE-UNDO-WAYPOINT] Same reasoning as the
  // legacy-picker load path above — a new media load clears any waypoint.
  recentHideUndo = null;
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
        renderMobileLoadProgress("Scanning folder…", loaded, null);
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
    // [TEMP-PROFILE-IDENTITY-AUDIT] Capture-only: retain this scan's
    // completeness diagnostics for the read-only audit entry point (see the
    // block at the bottom of this file). Does not affect the load in any way.
    __identityAuditLastFsaLoad = {
      dirsVisited: result.diagnostics.dirsVisited,
      filesSeen: result.diagnostics.filesSeen,
      filesSkipped: result.diagnostics.filesSkipped,
      nonFatalErrors: result.diagnostics.errors.length,
      incomplete: result.incomplete,
      fatalError: result.fatalError ? String(result.fatalError.name || result.fatalError) : null,
      loadedCount: count,
      rememberedItemCount:
        activeLibraryRecord && typeof activeLibraryRecord.itemCount === "number" ? activeLibraryRecord.itemCount : null,
      rootHandleName: dirHandle.name,
    };

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
    // [UI-REDESIGN / STAGE 6] [MOBILE-LOAD-STATUS-HANDOFF] The one genuine,
    // already-truthful failure path this loader has — reached only when zero
    // items were accepted. Keeps the mobile Live-Status-only view up,
    // showing the message written just above, instead of silently reverting
    // to the ordinary empty-state UI.
    lastMobileLoadFailed = true;
  } finally {
    isLoadingFiles = false;
    setLoadingState(false);
    // [UI-REDESIGN / STAGE 6] [MOBILE-LOAD-STATUS-HANDOFF] Authoritative
    // completion point for this loader too — after finishLoadingItems() (only
    // reached on success, inside the try block above) has already run
    // runtime.load(), or after the catch above has already recorded a
    // genuine failure.
    syncMobileLoadState();
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
// [PHASE-6-SYNC-V2]
// [STAGE-E-LIVE-INTEGRATION]
// [WHY: the single seam where an EXPLICIT association becomes a synchronized
//  fact. Routing through ProfileStore (rather than calling setLibraryProfile
//  directly, as this used to) is what mints the shared libraryId — which by
//  design happens ONLY here, never on a folder open — and stamps
//  associations[libraryId] = profileId so the other device learns it. The
//  local row's own profileId field is still written, by setLibraryAssociation
//  itself, so every existing UI read of activeLibraryRecord.profileId keeps
//  working unchanged.
//
//  Deliberately NOT used by the three stale-association CLEARING sites
//  elsewhere in this file: those fire when the associated Profile no longer
//  exists locally, and publishing a null there would tell every peer the user
//  disassociated the library when they did not. Under V2 a deleted Profile is
//  itself a synced tombstone, so the association fact correctly keeps naming
//  it — and an explicit Restore brings both back together.]
async function associateThroughSyncV2(localLibraryId, targetProfileId) {
  const sharedLibraryId = await profile.setLibraryAssociation(localLibraryId, targetProfileId);
  if (!sharedLibraryId) return null;
  return getLibraryByLibraryId(sharedLibraryId);
}

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

        const updated = await associateThroughSyncV2(record.id, targetProfileId);
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
    const updated = await associateThroughSyncV2(activeLibraryRecord.id, targetProfileId);
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
  // [UI-REDESIGN / Stage 3 fix] Any full reload supersedes a deferred one —
  // a View switch, Type switch or fresh load has already rebuilt the list
  // from current filters, so a leftover deferred index would clamp against
  // the wrong sequence later. Cleared centrally here rather than at each
  // call site so no future caller can forget.
  pendingFilterReloadIndex = null;
  pendingFilterReloadItemId = null;

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

// [UI-REDESIGN / Stage 3 fix] Deferred-reload state for the one case where
// rebuilding the runtime list immediately would yank the media out from
// under the user: the CURRENT item dropping out of the active filter
// because of a change the user just made to that same item (un-favoriting
// it while Favorites is the active view; likewise untagging it under an
// active Tag filter).
//
// Holds the index the item occupied in the list it was removed from, or
// null when nothing is deferred. The index is what we want for the manual
// case: the item is gone from the filtered sequence, so what is worth
// preserving is its POSITION — where the user was — not the item itself.
let pendingFilterReloadIndex = null;

// The dropped item's id, tracked alongside the index purely so the runtime
// subscriber below can tell "still sitting on the dropped item" apart from
// "the slideshow has moved on by itself". Not a second source of truth for
// favorite state — it is only ever compared, never read for meaning.
let pendingFilterReloadItemId = null;

// Applies a deferred reload, if one is pending, immediately before the user
// navigates. Called from the Previous/Next paths only: the reload is what
// makes the removed item actually leave the sequence, and doing it at the
// moment of navigation is what keeps the un-favorite itself from moving the
// player. The clamp lands the user where the removed item used to be rather
// than at the start of the list, so Next/Previous continues from where they
// were reading.
function flushPendingFilterReload() {
  if (pendingFilterReloadIndex === null) return;

  // Read before either path below clears them (see reloadRuntime's note).
  const previousIndex = pendingFilterReloadIndex;
  const droppedItemId = pendingFilterReloadItemId;

  // [UI-REDESIGN / Stage 5 fix] Prefer removing just the one item that
  // stopped matching the filter, rather than rebuilding the whole list.
  //
  // ROOT CAUSE this replaces: reloadRuntime() -> runtime.load() ->
  // #resetHistory(), which collapses visit history to the current index.
  // With Shuffle on (the default) previous() walks that history, so Back
  // died at the refresh point and everything before the un-loved item became
  // unreachable — the sequence behaved as if it began at the next item.
  // removeItemById() does the same list change while remapping history by
  // index, so the items visited before the removal stay reachable in the
  // same order, with the removed one simply skipped.
  //
  // It also makes setCurrentIndex()'s own #resetHistory() unnecessary here,
  // which was the second place the history was being thrown away.
  pendingFilterReloadIndex = null;
  pendingFilterReloadItemId = null;

  if (droppedItemId && runtime.removeItemById(droppedItemId)) return;

  // Fallback for anything removeItemById could not account for — the id is
  // no longer in the runtime's list at all, or more than this one item
  // changed. Same behavior as before this fix.
  reloadRuntime({ keepPlaying: runtime.getState().isPlaying });

  const { total } = runtime.getState();
  if (total) runtime.setCurrentIndex(Math.min(previousIndex, total - 1));
}

// [UI-REDESIGN / Stage 3 fix] The automatic counterpart to the manual flush
// above, for when the SLIDESHOW moves off the dropped item on its own — the
// interval timer for images, or a video's own "ended" event. Both advance
// inside MediaRuntime by calling next() directly, so main.js cannot get in
// front of them; this reacts to the state they emit instead.
//
// The distinction that makes that safe: while the player is still sitting
// on the dropped item, nothing happens — that is the whole point of
// deferring, and it is what keeps the item on screen when the user
// un-favorites it. The moment the current item is a DIFFERENT one, the
// deferral has served its purpose and the list is rebuilt immediately,
// which is what drops the un-favorited item out of the sequence for good.
// It cannot be reached or played again after that.
//
// preserveId keeps whatever the slideshow just advanced TO — that item is
// still a genuine match for the active filter, so the rebuild must not move
// off it. The manual path deliberately clamps by index instead, because
// there the current item is the dropped one and has no place in the new
// list at all.
//
// No recursion: reloadRuntime() clears the pending state before it emits,
// so the re-entrant call this triggers returns at the first line.
function handlePendingFilterReloadOnAdvance(state) {
  if (pendingFilterReloadIndex === null) return;
  const current = state.currentItem;
  if (!current) return;
  if (current.id === pendingFilterReloadItemId) return;

  // [UI-REDESIGN / Stage 5 fix] THE INTEGRATED ROOT CAUSE of the surviving
  // history truncation.
  //
  // flushPendingFilterReload() was taught to use removeItemById(), but this
  // path — every way of leaving the dropped item that is NOT the Previous/
  // Next buttons — still went through reloadRuntime() -> load() ->
  // #resetHistory(). That covers the slideshow auto-advancing off the item,
  // a video ending, and clicking a Gallery thumbnail. So in a real session
  // the deferral was very often resolved HERE rather than in the flush, the
  // history was wiped, and Back hit a wall at the refresh point — which is
  // exactly why the isolated runtime test passed while the browser did not.
  //
  // Same primitive, same reasons. Clearing the pending state first makes the
  // re-entrant call this emit triggers a no-op.
  const droppedItemId = pendingFilterReloadItemId;
  pendingFilterReloadIndex = null;
  pendingFilterReloadItemId = null;

  if (droppedItemId && runtime.removeItemById(droppedItemId)) return;

  reloadRuntime({ preserveId: current.id, keepPlaying: state.isPlaying });
}

// [UI-REDESIGN / Stage 3 fix] The single Previous/Next path. The transport
// buttons and the keyboard shortcuts both route through these so they can
// never diverge — the shortcuts are a second way to trigger the existing
// action, not a second implementation of it.
function goToPreviousMedia() {
  handleManualNavigationLoopReset();
  flushPendingFilterReload();
  runtime.previous();
}

function goToNextMedia() {
  handleManualNavigationLoopReset();
  flushPendingFilterReload();
  runtime.next();
}

function setViewMode(mode) {
  if (viewMode === mode) return;

  viewMode = mode;
  allMediaBtn.classList.toggle("active", mode === "all");
  favoritesOnlyBtn.classList.toggle("active", mode === "favorites");
  // [UI-REDESIGN / Stage 5] aria-pressed set from the same expression as
  // .active, on the same line-for-line basis, so the visual state and the
  // announced state cannot drift.
  allMediaBtn.setAttribute("aria-pressed", mode === "all" ? "true" : "false");
  favoritesOnlyBtn.setAttribute("aria-pressed", mode === "favorites" ? "true" : "false");
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
  // [UI-REDESIGN / Stage 5] See setViewMode() above — same pairing.
  typeAllBtn.setAttribute("aria-pressed", type === "all" ? "true" : "false");
  typeImagesBtn.setAttribute("aria-pressed", type === "image" ? "true" : "false");
  typeVideosBtn.setAttribute("aria-pressed", type === "video" ? "true" : "false");

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
  // [UI-REDESIGN / STAGE 6] [TAG-DISCOVERY-HANDOFF] Same visibility rule as
  // tagsFilterEmpty above — Manage Tags is part of that empty state, not a
  // permanent fixture of the filter panel.
  manageTagsBtn.classList.toggle("hidden", tags.length > 0);
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
    // [UI-REDESIGN / Stage 4 fix] Belt and braces. toggleTagFilter() re-runs
    // this render, which clears tagsFilterGrid — removing a focused chip
    // already sends focus to <body> on its own. The explicit release keeps
    // the behavior true by intent rather than by that side effect, so a
    // future change to how the grid re-renders cannot quietly reintroduce
    // the stuck-focus bug.
    btn.addEventListener("click", (event) => {
      toggleTagFilter(tag.id);
      releaseFocusAfterPointerActivation(event);
    });
    tagsFilterGrid.appendChild(btn);
  });

  renderTagsFilterToggleLabel();
}

// ---- [UI-REDESIGN / STAGE 6] [TRANSIENT-FOCUS-SHORTCUT-RELEASE] ----------
// ---- extended by [TRANSPORT-KEYBOARD-SHORTCUT-RELEASE] -------------------
//
// WHAT: ONE small mechanism covering every case in this app where an element
// legitimately keeps keyboard focus after the interaction it was focused FOR
// has already finished — a Set of elements currently in a "shortcut
// ownership is restored" grace period. Two families of caller share it:
//   1. Transient disclosures that return focus to their own trigger on
//      close — the Tags filter panel, the Playback popover/sheet, and the
//      Folders drawer, all further down this file.
//   2. [TRANSPORT-KEYBOARD-SHORTCUT-RELEASE] Ordinary one-shot transport
//      commands activated FROM THE KEYBOARD — specifically only Play/Pause,
//      Previous, Next, Fill, and Favorite — via
//      releaseFocusAfterPointerActivation()'s new opt-in `grantShortcutGrace`
//      parameter (default false). That function's keyboard branch always
//      left focus alone already; passing `true` from exactly these five
//      call sites additionally grants the grace period there, since a
//      completed command is the identical situation transient-close already
//      handles: focus stayed exactly where genuine keyboard navigation put
//      it, and the guard needs to stop treating that as an ongoing reason to
//      block shortcuts. The parameter defaults to false so every OTHER
//      caller of that shared function (Gallery filter/type buttons, Tag
//      filter chips, the Gallery card grid) is untouched — see that
//      function's own comment for why those specifically must NOT get this
//      treatment.
//
// WHY: in every one of these cases, the element ends up correctly,
// legitimately focused — that focus is REQUIRED and untouched by this. But
// isKeyboardFocusedControl() (consulted by handleTransportKeydown()'s guard
// further down) then correctly reports it as keyboard-focused, and has no
// way to tell "the interaction this focus was for is already finished" from
// "the user tabbed here fresh and is about to drive this control" — those
// are otherwise IDENTICAL DOM state (same element, same :focus-visible).
// Without this, every shortcut but L stayed suppressed for as long as the
// element held focus, until the user clicked or tabbed elsewhere — reported
// for the three transient triggers first, then again for Tab-to-Play(or
// Previous/Next/Fill/Favorite)-then-Enter, which is the same failure class
// wearing a different trigger.
//
// WHY one shared Set rather than a copy of a flag + blur listener + guard
// exemption per caller: the rule is identical everywhere it applies —
// "focus staying somewhere legitimate does not mean shortcut ownership stays
// blocked, until focus genuinely leaves and re-enters that element." One
// place expresses that rule; each caller opts its one element in or out at
// exactly the point it already touches focus, and the guard below consults
// it once, for whichever element currently holds focus. Nothing here is a
// second keyboard system or a new global key listener — it only gates
// whether the EXISTING isKeyboardFocusedControl() guard is allowed to fire
// while one specific, already-known element holds focus, and it changes no
// shortcut's meaning: see releaseFocusAfterPointerActivation()'s own comment
// for why the native activation and the global shortcut it is now exempt
// from call the exact same underlying function for all five transport
// commands, so which path fires is not user-observable.
const transientTriggersReleased = new Set();

// Call from a transient surface's OWN close function, at the same point it
// may also return focus to its trigger — or, per
// [TRANSPORT-KEYBOARD-SHORTCUT-RELEASE], from
// releaseFocusAfterPointerActivation()'s keyboard branch, right after a
// transport command has finished running. Safe to call unconditionally,
// even when focus is NOT on the element (the outside-click case, which
// never returns focus): hasTransientShortcutGracePeriod() below always
// re-checks document.activeElement too, so an entry for an element that
// isn't currently focused has no effect on anything.
function releaseTransientTriggerFocus(trigger) {
  transientTriggersReleased.add(trigger);
}

// Call from a transient surface's OWN open path, at the point it already
// marks itself open. A fresh, deliberate open ends any leftover grace
// period from a previous visit, so reopening and closing again always
// reflects the MOST RECENT close, never a stale one.
function clearTransientTriggerFocusRelease(trigger) {
  transientTriggersReleased.delete(trigger);
}

// The one thing handleTransportKeydown()'s guard needs: true only while
// `el` is BOTH the current active element AND still within its grace
// period. A trigger that is in the Set but no longer focused (the user
// tabbed away and onto something else entirely) correctly reports false.
function hasTransientShortcutGracePeriod(el) {
  return Boolean(el) && transientTriggersReleased.has(el);
}

// ONE shared listener, not one per element. `focusout` bubbles, so this
// single document-level listener catches ANY element in the Set losing
// focus — the three transient triggers AND, per
// [TRANSPORT-KEYBOARD-SHORTCUT-RELEASE], Play/Previous/Next/Fill/Favorite —
// without a separate element-level blur listener per caller to keep in
// sync. This is what ends an element's grace period the moment the
// ambiguity it exists for is gone: once focus actually leaves it, a LATER
// arrival back (a fresh Tab) is unambiguously the ordinary case and must get
// the ordinary button-activation guard back, not this exemption. Deleting an
// element that was never in the Set is a harmless no-op, so this does not
// need to know which elements are currently opted in.
document.addEventListener("focusout", (event) => {
  transientTriggersReleased.delete(event.target);
});

// [UI-REDESIGN / Stage 4]
// WHAT: Keeps the closed Tag button honest about how many tags are active.
// WHY: The approved label is "Any tag" — but that is only true while none
// are selected. Leaving it fixed would have the button claim no filtering
// while it was filtering. This is a READOUT of activeTagFilters and nothing
// else: it selects nothing, clears nothing, and is never the source of what
// is filtered.
// FUTURE: Multi-select and AND-combination are the point of this filter. A
// count is shown rather than a single tag name precisely so the label can
// never imply only one tag can be active.
function renderTagsFilterToggleLabel() {
  const count = activeTagFilters.length;
  tagsFilterToggleBtn.textContent = count === 0
    ? "Any tag ▼"
    : `${count} tag${count === 1 ? "" : "s"} ▼`;
  tagsFilterToggleBtn.classList.toggle("active", count > 0);
}

// [UI-REDESIGN / Stage 6 fix] The close branch now routes through
// closeTagsFilterPanel() instead of toggling the class inline, so it is
// ACTUALLY the single close path the FUTURE note below already claimed —
// previously this toggle bypassed it, which meant a keyboard toggle-close
// (Tab to the trigger, press Enter/Space) never reached
// releaseTransientTriggerFocus() and stayed exempt from the fix below it.
// The open branch clears any leftover grace period from a prior visit, the
// same thing openPlaybackPopover()/openControlsDrawer() do at their own
// open points.
function toggleTagsFilterPanel() {
  if (isTagsFilterPanelOpen()) {
    closeTagsFilterPanel();
  } else {
    tagsFilterPanel.classList.remove("hidden");
    tagsFilterToggleBtn.setAttribute("aria-expanded", "true");
    clearTransientTriggerFocusRelease(tagsFilterToggleBtn);
  }
}

// [UI-REDESIGN / Stage 5]
// WHAT: Completes the Tag filter disclosure's keyboard and pointer
// behavior — Escape closes and returns focus to the trigger, and an outside
// click closes it.
// WHY: It was openable but only closable by clicking its own trigger again.
// A keyboard user who tabbed into the panel had no way out except tabbing
// back through it, and Escape — which every other disclosure in this app
// honours — did nothing. This is the accessibility completion the brief
// asks for, deliberately modelled on the Playback popover so the two
// disclosures behave identically rather than each having their own rules.
// FUTURE: closeTagsFilterPanel() is the single close path. Do not hide the
// panel directly, or aria-expanded will go stale.
function isTagsFilterPanelOpen() {
  return !tagsFilterPanel.classList.contains("hidden");
}

// `returnFocus` is the keyboard path only: Escape must put focus back on the
// trigger, while an outside click must not steal it back from wherever the
// user just chose to click.
function closeTagsFilterPanel({ returnFocus = false } = {}) {
  if (!isTagsFilterPanelOpen()) return;
  tagsFilterPanel.classList.add("hidden");
  tagsFilterToggleBtn.setAttribute("aria-expanded", "false");
  if (returnFocus) tagsFilterToggleBtn.focus();
  // [UI-REDESIGN / Stage 6 fix] See [TRANSIENT-FOCUS-SHORTCUT-RELEASE] above
  // toggleTagsFilterPanel() — this is now genuinely the single close path,
  // so one call here covers every route into it (toggle, Escape, outside
  // click).
  releaseTransientTriggerFocus(tagsFilterToggleBtn);
}

document.addEventListener("click", (event) => {
  if (!isTagsFilterPanelOpen()) return;
  if (tagsFilterPanel.contains(event.target)) return;
  // The trigger runs its own toggle; letting this handler also fire would
  // close what that click just opened.
  if (tagsFilterToggleBtn.contains(event.target)) return;
  closeTagsFilterPanel();
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!isTagsFilterPanelOpen()) return;
  // Presentation Mode's Escape means "leave Fill" and is registered first;
  // this panel belongs to the ordinary Gallery, which PM covers entirely.
  if (fillModeActive) return;
  event.preventDefault();
  closeTagsFilterPanel({ returnFocus: true });
});

// ---- Playback popover ---------------------------------------------------
//
// [UI-REDESIGN / Stage 3]
// WHAT: Open/close for #playback-settings-popover, which holds the interval
// stepper and the four playback checkboxes that used to sit permanently in
// the rail.
// WHY: Deliberately thin. The popover only shows and hides existing
// controls — it does not own, mirror, validate or persist any of their
// values. Each control still handles its own `change` event and its own
// savePlaybackPreferences() call exactly as it did in the rail, so opening
// or closing this popover can never itself change a preference.
// FUTURE: closePlaybackPopover() is the ONLY close path — second click,
// outside click, Escape, and entering Fill Panel all route through it. If a
// new way to dismiss it is ever needed, call this rather than hiding the
// element directly, or aria-expanded will silently go stale.
function isPlaybackPopoverOpen() {
  return !playbackSettingsPopover.classList.contains("hidden");
}

function openPlaybackPopover() {
  // [UI-REDESIGN / Stage 6 fix] See [TRANSIENT-FOCUS-SHORTCUT-RELEASE] near
  // the Tags filter panel above — a fresh open ends any "just closed" grace
  // period left over from a previous visit.
  clearTransientTriggerFocusRelease(playbackSettingsBtn);
  playbackSettingsPopover.classList.remove("hidden");
  playbackSettingsBtn.setAttribute("aria-expanded", "true");
  // [UI-REDESIGN / Stage 6] The backdrop is bound to the popover's open state,
  // not to a width: CSS decides whether it is drawn, exactly as it decides
  // whether the popover is a sheet or an anchored panel. Toggling it here — in
  // the one open path and the one close path — is what stops it from ever
  // being left on screen without the sheet.
  playbackSheetScrim.hidden = false;

  // [UI-REDESIGN / Stage 6] Focus enters the sheet when the sheet is what the
  // user actually got. The test is whether the × is RENDERED, not what the
  // viewport measures — offsetParent is null for a display:none element, so
  // this is the same "CSS owns the breakpoint" rule the drawer states, asked
  // as a question about the DOM rather than about a media query. On desktop
  // the header is display:none, so this is a no-op and the existing desktop
  // focus flow (tab forward into the panel) is untouched.
  if (playbackSheetCloseBtn.offsetParent !== null) playbackSheetCloseBtn.focus();
}

// `returnFocus` is for the keyboard path only: Escape must put focus back on
// the button that opened the popover, or a keyboard user is dropped at the
// top of the document. An outside CLICK must not steal focus back, because
// the click has already moved focus somewhere the user chose.
function closePlaybackPopover({ returnFocus = false } = {}) {
  if (!isPlaybackPopoverOpen()) return;
  playbackSettingsPopover.classList.add("hidden");
  playbackSettingsBtn.setAttribute("aria-expanded", "false");
  playbackSheetScrim.hidden = true;
  if (returnFocus) playbackSettingsBtn.focus();
  // [UI-REDESIGN / Stage 6 fix] The ONE shared close path — every close
  // route (×, Escape, outside click, toggle-close) already funnels through
  // this function, which is exactly why the shared
  // [TRANSIENT-FOCUS-SHORTCUT-RELEASE] fix (see its own block near the Tags
  // filter panel above) hooks in here and nowhere else. Safe to call
  // unconditionally regardless of whether focus is actually on the trigger.
  releaseTransientTriggerFocus(playbackSettingsBtn);
}

function togglePlaybackPopover() {
  if (isPlaybackPopoverOpen()) {
    closePlaybackPopover();
  } else {
    openPlaybackPopover();
  }
}

playbackSettingsBtn.addEventListener("click", (event) => {
  // Without this the same click continues to the document listener below,
  // which would immediately read it as an "outside" click and close what
  // this click just opened.
  event.stopPropagation();
  togglePlaybackPopover();
  // [UI-REDESIGN / Stage 4 fix] Same regression, same cause: a pointer click
  // left this button focused, and the :focus-visible latch then swallowed
  // the Player's shortcuts. Released only once the popover is CLOSED — while
  // it is open, isPlaybackPopoverOpen() already withholds the shortcuts on
  // purpose, and the controls inside need an undisturbed focus flow. A
  // keyboard user is exempt (detail === 0) and keeps focus on the trigger —
  // that used to mean the shortcuts stayed suppressed until the user tabbed
  // away, but closePlaybackPopover()'s call into the shared
  // [TRANSIENT-FOCUS-SHORTCUT-RELEASE] mechanism (see its own block near the
  // Tags filter panel above) now restores them immediately regardless, so
  // Escape's focus return and a keyboard toggle-close both keep the trigger
  // focused AND get shortcuts back at once.
  if (!isPlaybackPopoverOpen()) releaseFocusAfterPointerActivation(event);
});

// [UI-REDESIGN / Stage 6] The sheet's × — a keyboard-style close, so it puts
// focus back on the ⚙ that opened it, the same contract Escape has. It routes
// through closePlaybackPopover() like every other dismissal; it does not hide
// the element itself. stopPropagation keeps this click from also reaching the
// document handler below as an "outside" click — harmless today, since that
// handler no-ops once the popover is closed, but it keeps the two paths from
// racing if either ever grows.
playbackSheetCloseBtn.addEventListener("click", (event) => {
  event.stopPropagation();
  closePlaybackPopover({ returnFocus: true });
});

// Outside-click close. Bound once at module scope, and cheap when closed:
// isPlaybackPopoverOpen() short-circuits before any DOM walking.
// [UI-REDESIGN / Stage 6] #playback-sheet-scrim is deliberately NOT special-
// cased here: a tap on the backdrop is an outside click and is handled as one,
// which is also why it does not steal focus back to the trigger.
document.addEventListener("click", (event) => {
  if (!isPlaybackPopoverOpen()) return;
  if (playbackSettingsPopover.contains(event.target)) return;
  closePlaybackPopover();
});

// Escape closes and returns focus to the trigger. This runs alongside
// handlePresentationKeydown(), which ignores every key unless Fill Panel is
// active — and entering Fill Panel closes this popover — so the two can
// never both act on one Escape.
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!isPlaybackPopoverOpen()) return;
  event.preventDefault();
  closePlaybackPopover({ returnFocus: true });
});

// ---- Controls drawer (narrow screens) -----------------------------------
//
// [UI-REDESIGN / Stage 6]
// WHAT: Open/close for the left rail when it is a bottom sheet. The drawer IS
// #controls-panel — the same rail the desktop shows as a column. There is no
// mobile copy of Libraries, association, Clear Media or Live Status, and no
// mobile-only handler: every control inside keeps the listener it already had.
// WHY: This file therefore owns exactly three things — one class on the rail,
// one `hidden` attribute on the scrim, and one aria-expanded on the trigger.
// It deliberately does not know the breakpoint: CSS decides whether the rail
// is a column or a sheet, and on desktop the trigger is display:none so none
// of this can be reached. That is why there is no width check here.
// FUTURE: closeControlsDrawer() is the ONLY close path — the close button, the
// scrim, Escape, entering Fill Panel and growing past the breakpoint all route
// through it. Never toggle the class or the scrim directly, or aria-expanded
// goes stale. If this ever needs a focus trap, add it here rather than giving
// the drawer its own keydown handler somewhere else.
function isControlsDrawerOpen() {
  return controlsPanel.classList.contains("is-drawer-open");
}

function openControlsDrawer() {
  if (isControlsDrawerOpen()) return;
  // The Playback popover is also a bottom sheet at these widths, and it
  // stacks ABOVE the drawer — leaving it open would put a panel belonging to
  // the Player on top of the rail. Closing it through its own single close
  // path (never by hiding it here) is also what keeps the two from both
  // answering one Escape: they can no longer both be open.
  closePlaybackPopover();
  controlsPanel.classList.add("is-drawer-open");
  controlsScrim.hidden = false;
  mobileControlsBtn.setAttribute("aria-expanded", "true");
  // [UI-REDESIGN / Stage 6 fix] See [TRANSIENT-FOCUS-SHORTCUT-RELEASE] near
  // the Tags filter panel above — a fresh open ends any "just closed" grace
  // period left over from a previous visit.
  clearTransientTriggerFocusRelease(mobileControlsBtn);
  // Focus moves INTO the sheet, to its first control. Without this a keyboard
  // or screen-reader user is left on a trigger that now sits behind a scrim,
  // with the thing they opened unannounced. The close button is first in the
  // drawer's visual order (CSS `order: -1`) as well as being the way out, so
  // it is the honest landing point.
  controlsDrawerCloseBtn.focus();
}

// `returnFocus` follows the same rule as the Playback popover and the Tag
// filter panel: Escape and the close button put focus back on the trigger,
// while an outside click must not steal it from wherever the user just chose
// to click.
function closeControlsDrawer({ returnFocus = false } = {}) {
  if (!isControlsDrawerOpen()) return;
  controlsPanel.classList.remove("is-drawer-open");
  controlsScrim.hidden = true;
  mobileControlsBtn.setAttribute("aria-expanded", "false");
  if (returnFocus) mobileControlsBtn.focus();
  // [UI-REDESIGN / Stage 6 fix] closeControlsDrawer() is genuinely the
  // single close path (toggle, close button, outside click, Escape, and the
  // resize-driven auto-close below all route through it), so one call here
  // covers all of them — see [TRANSIENT-FOCUS-SHORTCUT-RELEASE] near the
  // Tags filter panel above.
  releaseTransientTriggerFocus(mobileControlsBtn);
}

mobileControlsBtn.addEventListener("click", (event) => {
  // Same reason as the Playback popover's trigger: without this the click
  // continues to the document listener below, which reads it as an outside
  // click and closes what this click just opened.
  event.stopPropagation();
  if (isControlsDrawerOpen()) {
    closeControlsDrawer();
  } else {
    openControlsDrawer();
  }
});

controlsDrawerCloseBtn.addEventListener("click", () => {
  closeControlsDrawer({ returnFocus: true });
});

// Outside-click close, covering the scrim and the sticky header alike. One
// document-level listener rather than a scrim-specific one: a click on the
// scrim bubbles here anyway, and the header — which the sheet does not cover —
// would need this listener regardless. Cheap when closed: isControlsDrawerOpen()
// short-circuits before any DOM walking, same as the popover's.
document.addEventListener("click", (event) => {
  if (!isControlsDrawerOpen()) return;
  if (controlsPanel.contains(event.target)) return;
  if (mobileControlsBtn.contains(event.target)) return;
  closeControlsDrawer();
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!isControlsDrawerOpen()) return;
  // Presentation Mode's Escape means "leave Fill" and takes precedence; the
  // drawer belongs to the ordinary shell, which PM covers entirely. Same
  // deference the Tag filter panel shows.
  if (fillModeActive) return;
  event.preventDefault();
  closeControlsDrawer({ returnFocus: true });
});

// [UI-REDESIGN / Stage 6]
// WHAT: Closes the drawer when the viewport grows past the shell breakpoint.
// WHY: The `is-drawer-open` class is meaningless on desktop — the rail is a
// column there and the CSS ignores it — but the scrim is NOT inside the media
// query's control, and aria-expanded would stay "true" on a button the user
// can no longer see. Rotating a tablet or dragging a window across 980px is a
// real path into that state.
// The literal 980 here must stay in step with the single shell breakpoint in
// styles.css; it is the one place JS knows the number, and it only ever
// CLOSES, so a drift would degrade to a stale scrim rather than a broken
// layout.
// FUTURE: If the breakpoint moves, move it here too. Do not add a second
// query — this is not a place to start branching layout in JavaScript.
const shellBreakpointQuery = window.matchMedia("(max-width: 980px)");
shellBreakpointQuery.addEventListener("change", (event) => {
  if (!event.matches) closeControlsDrawer();
});

// [UI-REDESIGN / Stage 6]
// WHAT: Mirrors the rail's association readout into the compact header.
// WHY: It reads #associated-text rather than recomputing anything, so the
// header cannot disagree with the rail: there is one writer
// (updateAssociatedStatusRow) and this runs immediately after it, from the
// single function that already owns both.
// FUTURE: Add context by mirroring another existing readout the same way.
// Never let this derive association, profile or library state itself.
function syncMobileContextSummary() {
  mobileContextText.textContent = `Profile: ${associatedText.textContent}`;
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

  // [UI-REDESIGN / STAGE 6] [PM-AUTOMATIONS-ACTIVE-INDICATOR]
  // Called from every path that already runs through this function — the
  // checkbox's own change handler, #overlay-automation-btn's toggle,
  // completeFiniteLoopAutomationAndAdvance() (natural completion), and
  // stopAllPresentationAutomations() (the ⚡ universal stop) — so ⚡'s
  // active indicator can never drift from `videoLoopInput.checked`, the
  // one existing truthful "is any Presentation automation active" signal
  // (Forever/Times/Timer all require it checked to actually arm — see
  // applyLoopRuleToCurrentVideo()'s own gate — and turning it off already
  // resets activeLoopRule and clears any timer, above).
  syncAutomationsActiveIndicator();
}

// [UI-REDESIGN / STAGE 6] [PM-AUTOMATIONS-ACTIVE-INDICATOR]
// WHAT: The ONE derivation of "is a Presentation automation active" for ⚡'s
// own state — videoLoopInput.checked, not a separate tracked flag. Updates
// the dashed-ring spin trigger class and the accessible name/tooltip to
// match: active = "Stop automations" (a click stops it); inactive =
// "Automations" (a click opens/closes the disclosure) — see
// #overlay-automations-menu-btn's click handler for how this label meaning
// is enforced by the actual click priority, not just described in text.
// WHY not a separate `isPresentationAutomationActive` variable: that would
// be a second place this fact could drift from the real engine state this
// pass was explicitly told not to touch — reading videoLoopInput.checked
// directly is one source of truth, not a CSS class or a stale guess.
// KNOWN EDGE CASE (existing engine behavior, not touched by this pass):
// manually navigating away from a video mid-FINITE-automation calls
// invalidateActiveFiniteAutomation(), which resets activeLoopRule to
// "forever" but does NOT itself uncheck videoLoopInput — so the checkbox
// (and therefore this indicator) can stay truthfully "on" as a plain
// Forever loop after leaving the video, including onto a photo, where
// Loop/🤖 are hidden by syncAutomationsMediaAvailability() but the ring
// keeps spinning. This is arguably correct (Loop genuinely resumes the
// moment the user returns to a video) rather than a bug, and changing it
// would mean altering existing Loop/navigation engine behavior — out of
// scope for this pass; see the STAGE 6 report for this exact note.
function syncAutomationsActiveIndicator() {
  const isActive = videoLoopInput.checked;
  overlayAutomationsMenuBtn.classList.toggle("is-automation-active", isActive);
  const label = isActive ? "Stop automations" : "Automations";
  overlayAutomationsMenuBtn.setAttribute("aria-label", label);
  overlayAutomationsMenuBtn.setAttribute("title", label);
}

// [UI-REDESIGN / STAGE 6] [PM-AUTOMATIONS-ACTIVE-STOP]
// WHAT: The one reliable stop path from ⚡ while an automation is active —
// composed entirely from the EXISTING authoritative "Loop OFF" path
// (setting the checkbox, then calling the same syncVideoLoopControl() the
// checkbox's own change handler and #overlay-automation-btn's toggle-off
// already call), not a second engine. That path already resets
// activeLoopRule to "forever", clears loopRuleCompletedPlays, clears any
// pending timer via clearLoopRuleTimer(), and closes the nested automation
// editor — covering plain Loop, Forever, X Times, and Until Timer alike,
// since all four are represented by the exact same
// videoLoopInput.checked/activeLoopRule state.
// Deliberately does NOT call runtime.notifyVideoEnded() or navigate —
// stopping an automation must not itself advance or move media.
function stopAllPresentationAutomations() {
  videoLoopInput.checked = false;
  syncVideoLoopControl();
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
  syncVideoLoopControl(); // turns 🔁 UI off, disables/greys 🤖, clears ⚡'s active indicator
  // [UI-REDESIGN / STAGE 6] [PM-AUTOMATIONS-ACTIVE-INDICATOR] closeAutomationsTray()
  // (was closeAutomationEditor() alone) — defensive completeness: the tray
  // should already be closed by this point (starting the automation
  // auto-closed it — see [PM-AUTOMATIONS-COMMIT-AND-CLOSE]), but this also
  // resets ⚡'s own aria-expanded/is-open state if it ever drifted, which
  // closeAutomationEditor() alone does not touch.
  closeAutomationsTray();

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

// ---- Canonical PM Automations tray (every width) ---------------------------
//
// [UI-REDESIGN / STAGE 6] [PM-AUTOMATIONS-CANONICAL]
// #pm-automations-group is a closed-by-default tray at every width now —
// see its own comment in styles.css for the "was display: contents above
// ≤448px, now a tray everywhere" history. This open/close pair governs it
// uniformly.
//
// closeAutomationsTray() always closes the nested 🤖 editor first (via the
// existing closeAutomationEditor(), never duplicated) — per the "avoid
// orphaned child panels" requirement, closing the outer tray while that
// editor is still open must not leave it stranded, visually hidden but
// still logically mid-edit.
function closeAutomationsTray() {
  closeAutomationEditor();
  pmAutomationsGroup.classList.remove("is-open");
  overlayAutomationsMenuBtn.classList.remove("is-open");
  overlayAutomationsMenuBtn.setAttribute("aria-expanded", "false");
}

function toggleAutomationsTray() {
  const willOpen = !pmAutomationsGroup.classList.contains("is-open");

  if (!willOpen) {
    closeAutomationsTray();
    return;
  }

  // Only one pop-out panel makes sense open at a time — same rule
  // #overlay-automation-btn and #overlay-settings-btn already follow.
  presentationSettings.classList.add("hidden");
  closeGhostPopunder();
  pmAutomationsGroup.classList.add("is-open");
  overlayAutomationsMenuBtn.classList.add("is-open");
  overlayAutomationsMenuBtn.setAttribute("aria-expanded", "true");
}

// ---- Fill Panel (simulated fullscreen) ---------------------------------

function enterFillMode() {
  if (fillModeActive) return;

  fillModeActive = true;
  // [UI-REDESIGN / Stage 3] The transport row and its popover are hidden by
  // CSS during Fill Panel, but a popover left open would come back open on
  // exit, with focus having been somewhere invisible in between. Closing it
  // here keeps aria-expanded honest and matches how exitFillMode() closes
  // the ghost popunder and the automation panel.
  closePlaybackPopover();
  // [UI-REDESIGN / Stage 6] Same reasoning, one stage later: Fill Panel hides
  // the rail by CSS, but the scrim is a body-level sibling that those rules do
  // not reach, and aria-expanded would stay "true" on a hidden trigger.
  // Routing through the single close path keeps both honest.
  closeControlsDrawer();
  appShell.classList.add("simulated-fullscreen");
  layoutEl.classList.add("simulated-fullscreen-layout");
  viewerPanel.classList.add("simulated-fullscreen-viewer");
  presentationControls.classList.remove("hidden");
}

function exitFillMode() {
  if (!fillModeActive) return;

  // [UI-REDESIGN / Stage 3] The unconditional `runtime.stop()` here is
  // retired. It previously treated leaving Presentation as an explicit end
  // to the playback session; exiting Fill now PRESERVES playback state, so a
  // slideshow running in Fill keeps running in the ordinary Player and a
  // paused one stays paused.
  //
  // This is a deliberate change to long-standing Presentation Mode exit
  // behavior, made together with the `Fill ⛶` / Autoplay on Fill work:
  // entering Fill is no longer a mode you commit a playback session to, so
  // leaving it should not end one. MediaRuntime still owns the timer and the
  // playing state — nothing presentation-specific is tracked here either
  // way; the difference is only that we no longer reach for its stop path.
  fillModeActive = false;
  appShell.classList.remove("simulated-fullscreen");
  layoutEl.classList.remove("simulated-fullscreen-layout");
  viewerPanel.classList.remove("simulated-fullscreen-viewer");
  presentationControls.classList.add("hidden");
  presentationSettings.classList.add("hidden");
  closeGhostPopunder();
  automationPanel.classList.add("hidden");
  // [UI-REDESIGN / STAGE 6] [PM-AUTOMATIONS-ENTRY] Same direct reset as the
  // automation panel line above, not the toggle helper — a hard exit needs
  // the tray's state cleared unconditionally, not the mutual-exclusion
  // side effects toggleAutomationsTray()/closeAutomationsTray() carry.
  pmAutomationsGroup.classList.remove("is-open");
  overlayAutomationsMenuBtn.classList.remove("is-open");
  overlayAutomationsMenuBtn.setAttribute("aria-expanded", "false");
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

// [UI-REDESIGN / Stage 3 fix] Closes the innermost open PM pop-out and
// reports whether it closed anything, so a caller can treat "a panel was
// open" and "nothing was open" as different outcomes.
//
// The order mirrors how these panels actually nest at runtime rather than
// their markup order. #ghost-popunder is opened by the 👻 button that lives
// inside the settings row, so it is innermost and must close first.
// #automation-panel and #presentation-settings are mutually exclusive with
// each other — see overlaySettingsBtn/overlayAutomationBtn, which each close
// the other on open ("Only one pop-out panel makes sense open at a time") —
// so their relative order here is immaterial; at most one is ever open.
//
// Each panel is closed through its own established close path, never by
// hiding the element directly, so aria-expanded and the toggle buttons'
// is-open styling stay correct. #presentation-settings is the one panel with
// no close helper of its own — its own toggle handler hides it inline the
// same way.
//
// [UI-REDESIGN / STAGE 6] [PM-AUTOMATIONS-ENTRY] #pm-automations-group's
// check sits between #automation-panel and #presentation-settings: at
// deep-compact widths the tray is the OUTER surface 🤖's editor opens
// inside, so one press closes just the editor (drops back to the Loop/🤖
// tray view) and a second closes the tray itself — the same "layered, like
// a back button" behavior this function already gives every other nested
// PM pop-out. At every width above the ≤448px tier the tray never opens
// (see toggleAutomationsTray()'s own comment), so this check is inert
// there.
function closeTopmostPresentationPanel() {
  if (!ghostPopunder.classList.contains("hidden")) {
    closeGhostPopunder();
    return true;
  }
  if (!automationPanel.classList.contains("hidden")) {
    closeAutomationEditor();
    return true;
  }
  if (pmAutomationsGroup.classList.contains("is-open")) {
    closeAutomationsTray();
    return true;
  }
  if (!presentationSettings.classList.contains("hidden")) {
    presentationSettings.classList.add("hidden");
    return true;
  }
  return false;
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

  // [UI-REDESIGN / Stage 6]
  // WHAT: One class on .app-shell recording whether the Player currently has
  // anything to show.
  // WHY: The narrow layout needs to answer "is there a Player worth putting
  // first?" in CSS, and the honest answer is exactly the condition the three
  // branches below already use to show or hide #viewer-stage. Deriving it here
  // from the same `state` — rather than setting a flag inside each branch —
  // is what stops the class and the stage from ever disagreeing. It is
  // presentational only: nothing reads it back in JavaScript.
  // FUTURE: If a fourth viewer branch is ever added, this expression must
  // learn about it. It belongs at the top of THIS function, next to the
  // branches it summarises — do not move it to a subscriber.
  const playerHasMedia = Boolean(item) && !(hasItems && !hasVisibleItems);
  appShell.classList.toggle("app-has-media", playerHasMedia);

  // Clear Media lives INSIDE the drawer, so using it is the one way to go from
  // "drawer open" to "empty state" in a single action. The empty state renders
  // the rail as an ordinary inline panel and hides its close button, which
  // would leave the scrim up over the whole page with nothing left to dismiss
  // it. Closing here is a no-op in every other case: the drawer cannot be
  // opened while empty (its trigger is hidden too), and this never fires while
  // media is present.
  if (!playerHasMedia) closeControlsDrawer();

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

    card.addEventListener("click", (event) => {
      clearGalleryJumpTarget();
      // [UI-REDESIGN / Stage 5 fix] THE call that was destroying history.
      // setCurrentIndex() reset it unconditionally, and it runs BEFORE the
      // pending-removal handler resolves — so by the time removeItemById()
      // ran there was nothing left for it to remap. Picking a thumbnail is
      // navigation within the current sequence, not the start of a new one,
      // so the pick is appended as the newest entry and everything visited
      // earlier stays reachable by Previous.
      runtime.setCurrentIndex(index, { keepHistory: true });
      viewerPanel.scrollIntoView({ behavior: "smooth", block: "start" });
      // [UI-REDESIGN / Stage 5 fix] Gallery cards are real <button> elements
      // (see createElement above), so activating one leaves it focused and
      // the :focus-visible latch then swallowed ArrowLeft/ArrowRight/Space/F
      // — L kept working only because it is exempt from that guard.
      //
      // Picking a card means "load this and let me drive the Player", so
      // both activation routes hand the keyboard over — but they need
      // different treatment:
      //
      // Pointer: just release. The user's hand is on the mouse and focus on
      // the card they already let go of serves nobody.
      //
      // Keyboard: blurring into nowhere would strand the user at the top of
      // the document, and Shift+Tabbing back out of a grid of thousands of
      // cards is not a route anyone would take. Focus MOVES to the viewer
      // stage instead — a genuine target rather than an absence — which both
      // frees the shortcuts and truthfully represents having gone from
      // choosing a card to controlling the Player. The stage takes focus via
      // tabindex="-1", so this changes nothing about Tab order.
      //
      // [UI-REDESIGN / Stage 5 fix] Routed through focusPlayerStage() rather
      // than calling viewerStage.focus() here, so this and the now-playing
      // strip's Return share ONE hand-off path — same target, same visible
      // ring, no chance of the two drifting apart. Behavior here is unchanged
      // apart from the ring now being explicit instead of depending on the
      // browser's modality heuristic.
      if (event.detail === 0) {
        focusPlayerStage();
      } else {
        releaseFocusAfterPointerActivation(event);
      }
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

// [UI-REDESIGN / STAGE 6] [PM-AUTOMATIONS-MEDIA-SUPPORT]
// WHAT: Loop and 🤖 Loop Automations are video-only automations — the
// existing engine already gates their real EXECUTION on `isShowingVideo`
// (see applyLoopRuleToCurrentVideo()); this is the matching PRESENTATION
// gate, so the controls never visually invite a click that would silently
// do nothing on a photo. ⚡ itself is NEVER gated by this — it stays
// available as a destination for both photos and videos; only the
// CONTENT inside the tray is media-aware. Exactly one of "Loop + 🤖" or
// the empty-state message is visible at a time.
// WHY read item.kind fresh here rather than caching "is this a video"
// anywhere: media changes on every ordinary navigation, and this is called
// from the same render()-adjacent sites as syncHideButton/
// syncUndoHideButton, so it never trusts a stale assumption — video → photo
// mid-tray-open immediately swaps to the empty state, and photo → video
// immediately restores Loop/🤖, using nothing but the current runtime
// truth.
// Does NOT touch videoLoopInput.checked, activeLoopRule, or any automation
// engine state — purely presentational. The existing engine's own
// isShowingVideo gating (untouched) is what actually keeps a stale
// Loop-on/finite-automation-active state from doing anything on a photo;
// see this function's own audit note in the STAGE 6 report for the one
// case where that state can outlive a manual navigation to a photo
// (`videoLoopInput.checked` staying true after a finite automation
// resets to "forever" without itself unchecking the box) — this is
// exactly the case hiding the controls here is a real, needed safety net
// for, not merely decorative.
function syncAutomationsMediaAvailability(item) {
  const isVideo = Boolean(item && item.kind === "video");
  videoLoopControl.classList.toggle("hidden", !isVideo);
  overlayAutomationBtn.classList.toggle("hidden", !isVideo);
  pmAutomationsPhotoEmpty.classList.toggle("hidden", isVideo);
}

// [UI-REDESIGN / STAGE 6] [PM-HIDE-UNDO-DYNAMIC-SLOT] [PM-HIDE-UNDO-WAYPOINT] [PM-HIDE-UNDO-WAYPOINT-RUNTIME-FIX]
// WHAT: Two independent questions answered fresh on every call — never
// cached, never computed anywhere else:
//   1. Has the waypoint expired? `runtime.getState().navigationStep`
//      (MediaRuntime's own counter — see its declaration in
//      media-runtime.js — incremented/decremented on EVERY next()/
//      previous() call, whichever triggered it: manual click, keyboard, the
//      slideshow's own interval timer, or a video's "ended" event) minus
//      recentHideUndo.landingNavigationStep is the NET distance moved since
//      the waypoint was created. Once that distance exceeds
//      HIDE_UNDO_RECOVERY_WINDOW_STEPS, the waypoint is cleared outright —
//      permanently, not just "currently out of range": clearing it here
//      (not merely skipping the Undo offer) is what makes this a one-way
//      ratchet, matching the brief's "F is the fourth forward step; the
//      waypoint may be discarded" rather than something the user could
//      un-expire by wandering back into range.
//   2. Is Undo offered right now? Only if a (still-unexpired) waypoint
//      exists AND the CURRENT item is literally the one MediaRuntime landed
//      on right after the hide (recentHideUndo.landingItemId) — not merely
//      "something was hidden at some point."
// `.pm-hide-undo-inactive` toggles the mutually-exclusive deep-compact slot
// from that same hasUndo condition; it only has a CSS effect inside the
// ≤448px tier (see styles.css) — at every wider width it sits on the DOM
// inertly, so Hide and Undo keep rendering side-by-side there exactly as
// before.
// WHY this must be called on every render, not only from the Hide/Undo
// click handlers: both questions above depend on live runtime state that
// changes on ordinary navigation — see the two render()-adjacent call
// sites (render() itself and the background-sync badge refresh) as well as
// the Hide/Undo click handlers, every waypoint-clearing site, and once at
// boot.
// WHY one shared function rather than splitting expiry and display into
// two: they read the exact same two pieces of state — computing them
// separately is how they could drift out of sync with each other.
function syncUndoHideButton() {
  if (recentHideUndo) {
    const stepsSinceLanding = runtime.getState().navigationStep - recentHideUndo.landingNavigationStep;
    if (stepsSinceLanding > HIDE_UNDO_RECOVERY_WINDOW_STEPS) {
      recentHideUndo = null;
    }
  }

  const currentItem = runtime.getCurrentItem();
  const hasUndo = Boolean(
    recentHideUndo && currentItem && currentItem.id === recentHideUndo.landingItemId
  );
  overlayUndoHideBtn.disabled = !hasUndo;
  overlayHideBtn.classList.toggle("pm-hide-undo-inactive", hasUndo);
  overlayUndoHideBtn.classList.toggle("pm-hide-undo-inactive", !hasUndo);
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

// [UI-REDESIGN / STAGE 6] [GALLERY-TARGET-PROGRESSIVE-FLOW]
// WHAT: which of the two .gallery-jump-step wrappers is visible — "select"
// (target input + Next →) or "action" (Find Below + Load in Player). Real,
// unconditional layout everywhere now — see styles.css — so this is the
// single, same-everywhere state Presentation Mode's Loop Automations panel
// already models with its own step variable.
// WHY a plain module variable rather than deriving it from something else:
// there is no existing piece of state this could be read from — it is
// genuinely new, UI-only information ("which half of the workflow is the
// user looking at"), unrelated to galleryJumpConfirmedIndex (WHICH target
// was confirmed) or galleryJumpIsEditing (whether the target is mid-edit).
let galleryJumpStep = "select"; // "select" | "action"

function setGalleryJumpStep(step) {
  galleryJumpStep = step;
  galleryJumpStepSelect.classList.toggle("gallery-jump-step-inactive", step !== "select");
  galleryJumpStepAction.classList.toggle("gallery-jump-step-inactive", step !== "action");
}

// [UI-REDESIGN / Stage 4] The find highlight is now TEMPORARY: it fades
// itself after a few seconds rather than sitting on the card indefinitely.
// It marks "here is what you searched for", which stops being true once the
// user has seen it — and a permanent marker competes with the active-card
// border for meaning, which is the same confusion the yellow recolour fixes.
// The existing clear paths (a new jump, a gallery rebuild) still apply; this
// only adds a third.
const GALLERY_FIND_HIGHLIGHT_MS = 4000;
let galleryJumpHighlightTimer = null;

function clearGalleryJumpTarget() {
  if (galleryJumpHighlightTimer !== null) {
    window.clearTimeout(galleryJumpHighlightTimer);
    galleryJumpHighlightTimer = null;
  }
  if (galleryJumpTargetIndex !== null) {
    galleryCardEls[galleryJumpTargetIndex]?.classList.remove("gallery-jump-highlight");
  }
  galleryJumpTargetIndex = null;
}

// [UI-REDESIGN / STAGE 6] [GALLERY-TARGET-PROGRESSIVE-FLOW]
// WHAT: the ONE place that writes the target input's `.value` from runtime
// truth, and the total span's text. Called from render() on every runtime
// state change — the same hook updateGalleryJumpPlaceholder() used, just
// writing a real value now instead of a placeholder (see the input's own
// HTML comment for why a placeholder would have meant "greyed out").
// WHY galleryJumpIsEditing gates the value write but not the total: the
// total is system information the user never edits, so a background change
// (a filter shrinking it, for instance) should always be reflected
// immediately; the target is user-editable, so a background change must
// never silently overwrite content the user is actively typing.
function syncGalleryJumpTarget(state) {
  galleryJumpTotalText.textContent = state.hasItems ? `/ ${state.total}` : "";
  if (galleryJumpIsEditing) return;
  galleryJumpInput.value = state.hasItems ? String(state.currentIndex + 1) : "";
}

function flashInvalidGalleryJumpInput() {
  galleryJumpInput.classList.remove("is-invalid");
  // Force a reflow so re-adding the class restarts, even if a previous
  // flash's timeout hasn't cleared it yet (rapid repeated invalid Enters).
  void galleryJumpInput.offsetWidth;
  galleryJumpInput.classList.add("is-invalid");
  window.setTimeout(() => galleryJumpInput.classList.remove("is-invalid"), 500);
}

// [UI-REDESIGN / STAGE 6] [GALLERY-TARGET-PROGRESSIVE-FLOW]
// WHAT: the SAME validation performGalleryJump() used to run inline —
// identical regex, identical range check, identical flash — factored into
// its own function purely so Next → can run it before Step 2's actions
// exist to consume the result. Returns the zero-based index on success, or
// null (having already flashed) on failure. No behavior changed, no
// duplicate rule written anywhere.
function validateGalleryJumpTarget() {
  const state = runtime.getState();
  const raw = galleryJumpInput.value.trim();

  // Human-readable 1-based numbering only. Anything that isn't a plain
  // positive integer (empty, negative, decimal, non-numeric) is rejected
  // outright rather than guessed at.
  if (!/^\d+$/.test(raw)) {
    flashInvalidGalleryJumpInput();
    return null;
  }

  const oneBased = Number(raw);
  if (!state.total || oneBased < 1 || oneBased > state.total) {
    flashInvalidGalleryJumpInput();
    return null;
  }

  return oneBased - 1;
}

// [UI-REDESIGN / STAGE 6] [GALLERY-TARGET-PROGRESSIVE-FLOW]
// WHAT: Step 1's Next → and Enter-in-the-input both call this. Validates,
// and only on success stores the confirmed target and shows Step 2.
// On failure the row stays on Step 1 exactly as it was — the invalid value
// is left visible with the flash already fired by validateGalleryJumpTarget()
// above, never silently cleared or replaced (this is what "explicit empty
// Next fails honestly" and "invalid Next stays Step 1" require).
function advanceGalleryJumpToActionStep() {
  const index = validateGalleryJumpTarget();
  if (index === null) return;
  galleryJumpConfirmedIndex = index;
  // [UI-REDESIGN / STAGE 6] [GALLERY-STEP2-ACTION-REFINEMENT] Kept true
  // (previously cleared here) — Step 2 can lead back to Step 1 via Back
  // without executing anything, and the confirmed target must still be
  // exactly what Step 1 shows when that happens. If this were cleared now, a
  // background render() firing while Step 2 is up (playback advancing, for
  // instance) would silently overwrite the hidden input with the CURRENT
  // runtime position before Back ever runs — the user would tap ↩ and see
  // the wrong number. Cleared instead in the Back handler and in
  // finishGalleryJumpAction(), both of which return to Step 1 through an
  // explicit, deliberate path rather than a background one.
  galleryJumpIsEditing = true;
  setGalleryJumpStep("action");
  // Step 1's Next → is about to be hidden by the step change above, which
  // would otherwise silently drop keyboard focus to <body>. Unconditional
  // (not gated to keyboard-only) because nothing else claims the scroll
  // position at this point — unlike the Step 2 -> Step 1 transition below,
  // where Find Below/Load in Player's own scrollIntoView() calls make an
  // equivalent auto-focus here actively harmful, so it is deliberately NOT
  // added there.
  galleryJumpModeFindBtn.focus();
}

// [8.5] "find"/"play" ARE the search-vs-direct jump distinction the product
// spec asks for — not a separate mechanism to build. Both already jump
// within whatever search/filter context is currently active (state.total
// already reflects getVisibleItems(), see the comment at this control's
// HTML). "find" = SEARCH jump: locate a position in that context
// (scroll/highlight only, nothing loads). "play" = DIRECT jump:
// unconditionally load that position into the Viewer. Keeping these two
// names/behaviors distinct matters for the next phase too: once FSA
// master-folder auto-detection exists, "direct jump" must keep meaning
// "load it, full stop" even if a future profile/folder switch changes
// what's in the search context.
// [UI-REDESIGN / STAGE 6] [GALLERY-TARGET-PROGRESSIVE-FLOW] Takes the
// zero-based index EXPLICITLY now, rather than re-reading and re-parsing
// galleryJumpInput.value — by the time either button can call this, the
// value has already been validated once (by Next →) and the input itself is
// hidden (Step 2 is showing), so re-reading it here would be reading a
// stale, currently-invisible field instead of the one number Step 2 is
// actually acting on.
function executeGalleryJump(zeroBasedIndex, mode) {
  if (mode === "play") {
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
      // [UI-REDESIGN / Stage 4] Self-clearing — see clearGalleryJumpTarget().
      // Routed through that same function so there is one teardown path, and
      // so the timer handle and the index can never disagree.
      galleryJumpHighlightTimer = window.setTimeout(
        () => clearGalleryJumpTarget(),
        GALLERY_FIND_HIGHLIGHT_MS
      );
    }
  }
}

// [UI-REDESIGN / STAGE 6] [GALLERY-TARGET-PROGRESSIVE-FLOW]
// WHAT: the shared "an action just ran" tail for both Find Below and Load in
// Player — resets to Step 1, then repopulates the target from CURRENT
// runtime truth.
// WHY reading runtime truth AFTER the action, unconditionally, is correct
// for BOTH modes without needing to know which one just ran: Load in Player
// already called runtime.setCurrentIndex() above, so
// runtime.getState().currentIndex now IS the confirmed target; Find Below
// never touches the runtime's current index at all, so the same read
// correctly yields the UNCHANGED original position. Never present a
// custom search target as though it became current when it did not — this
// is what makes that true without a mode-specific branch.
function finishGalleryJumpAction() {
  galleryJumpConfirmedIndex = null;
  setGalleryJumpStep("select");
  const state = runtime.getState();
  galleryJumpInput.value = state.hasItems ? String(state.currentIndex + 1) : "";
  galleryJumpIsEditing = false;
}

// [UI-REDESIGN / STAGE 6] [GALLERY-STEP2-ACTION-REFINEMENT]
// WHAT: ↩ Back — mobile-only in the UI, but the handler itself does not need
// to know that; the button simply does not exist as a reachable control on
// desktop (see styles.css), so this can never fire there.
// WHY this is NOT finishGalleryJumpAction(): that function is the "an action
// just ran" tail — it clears the confirmed target and REWRITES the input
// from current runtime truth, which is correct after Find Below/Load in
// Player actually did something. Back did nothing. Returning through that
// same tail would silently replace whatever custom target the user backed up
// to reconsider with the current Player position — exactly what this task
// forbids. Back's entire contract is narrower: flip the step back, leave
// every other piece of state (the input's value, runtime, filters,
// galleryJumpConfirmedIndex's target index itself) untouched. Only the
// bookkeeping flag changes, and only because Step 1 is now "the ordinary
// idle state" again and should resync from live truth the next time
// something legitimately changes it (see galleryJumpIsEditing's own comment
// in advanceGalleryJumpToActionStep()).
// executeGalleryJump() is never called, runtime.setCurrentIndex() is never
// called, no filter or clearGalleryJumpTarget() call happens — nothing here
// can move the Player or the Gallery.
function returnToGalleryJumpSelectStep() {
  galleryJumpConfirmedIndex = null;
  galleryJumpIsEditing = false;
  setGalleryJumpStep("select");
  // Step 2's ↩ is about to be hidden by the step change above; focusing the
  // now-visible target input is both the natural "you're back, here's the
  // field" landing point and what stops focus silently dropping to <body>.
  // Unconditional, not pointer-only: unlike the Find Below/Load in Player
  // handlers, nothing here calls scrollIntoView(), so there is no competing
  // scroll to protect and no reason to withhold this from a pointer click.
  galleryJumpInput.focus();
}

// [UI-REDESIGN / STAGE 6] [GALLERY-TARGET-PROGRESSIVE-FLOW]
// WHAT: the target input's click/tap-to-clear contract. A `click` event on a
// plain text input is ONLY ever dispatched by an actual pointer (mouse or
// touch) activation — Tab-arrival and other keyboard focus changes never
// synthesize one — so this listener alone already gives Tab focus a free
// pass without any extra modality check.
// WHY clear unconditionally rather than only when non-empty: clicking an
// already-empty/mid-edit field again is a harmless no-op repeat of the same
// intent ("I want to replace what's here"), and guarding it would only add
// a branch that changes nothing observable.
galleryJumpInput.addEventListener("click", () => {
  galleryJumpIsEditing = true;
  galleryJumpInput.value = "";
});

// Marks an edit as genuinely in progress the moment the value actually
// changes — covers keyboard-driven editing (Tab to the field, then type)
// which the click handler above never sees, so syncGalleryJumpTarget()
// cannot clobber mid-typing here either.
galleryJumpInput.addEventListener("input", () => {
  galleryJumpIsEditing = true;
});

// [UI-REDESIGN / STAGE 6] [GALLERY-TARGET-PROGRESSIVE-FLOW]
// WHAT: restores the actual current runtime target ONLY when the field is
// abandoned genuinely empty — "clicked, cleared, typed nothing, focus moved
// away". Deliberately skipped when relatedTarget is Next →: a click on Next
// fires `blur` on this input BEFORE Next's own `click` handler runs (browsers
// dispatch blur synchronously ahead of the new element's click), so restoring
// here unconditionally would silently replace an intentionally-submitted
// empty value with the current position before validateGalleryJumpTarget()
// ever saw it — exactly the "explicit empty Next silently substituted"
// outcome this app must not produce. Next's own validation already handles
// an empty submission honestly (flashes invalid, stays Step 1); this handler
// only needs to cover every OTHER way focus can leave the field.
// A non-empty value left behind (typed but never submitted) is deliberately
// NOT touched here — only genuinely empty abandonment is in scope.
galleryJumpInput.addEventListener("blur", (event) => {
  if (event.relatedTarget === galleryJumpNextBtn) return;
  if (galleryJumpInput.value.trim() !== "") return;
  galleryJumpIsEditing = false;
  const state = runtime.getState();
  galleryJumpInput.value = state.hasItems ? String(state.currentIndex + 1) : "";
});

galleryJumpNextBtn.addEventListener("click", () => advanceGalleryJumpToActionStep());

// [UI-REDESIGN / STAGE 6] [GALLERY-STEP2-ACTION-REFINEMENT] Mobile-only in
// the UI; see returnToGalleryJumpSelectStep()'s own comment for the exact,
// narrow contract this routes through.
galleryJumpBackBtn.addEventListener("click", () => returnToGalleryJumpSelectStep());

galleryJumpModeFindBtn.addEventListener("click", () => {
  if (galleryJumpConfirmedIndex === null) return;
  executeGalleryJump(galleryJumpConfirmedIndex, "find");
  finishGalleryJumpAction();
});
galleryJumpModePlayBtn.addEventListener("click", (event) => {
  if (galleryJumpConfirmedIndex === null) return;
  executeGalleryJump(galleryJumpConfirmedIndex, "play");
  finishGalleryJumpAction();
  // [UI-REDESIGN / Stage 5 fix] Load in Player hands the user back to the
  // Player — so it must hand the keyboard back too. Without this the button
  // kept focus, and the :focus-visible latch then swallowed
  // ArrowLeft/ArrowRight/Space/F until the user clicked elsewhere.
  //
  // Deliberately NOT applied to Find Below: that leaves the user working in
  // the command row, where the control keeping focus is correct. Moot here
  // for the KEYBOARD path regardless, since finishGalleryJumpAction() has
  // already hidden this button by returning to Step 1 — the browser drops
  // focus to <body> on its own in that case, same as Find Below now does.
  // Pointer-only, as everywhere else — a keyboard activation (detail === 0)
  // is a no-op here.
  releaseFocusAfterPointerActivation(event);
});
// [UI-REDESIGN / STAGE 6] [GALLERY-TARGET-PROGRESSIVE-FLOW] While on Step 1,
// Enter behaves exactly like Next → — same function, same validation, same
// advance-on-success. Step 2 has no input to receive Enter from; its two
// buttons use their own native Enter/Space activation, unchanged.
galleryJumpInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  advanceGalleryJumpToActionStep();
});

// [UI-REDESIGN / Stage 6] The two states of the ONE Play/Pause icon. They are
// the `d` of the same <path>, not two shapes taking turns, so there is nothing
// to keep in sync beyond this single attribute. Kept beside the function that
// writes them rather than in index.html because a value that changes at
// runtime belongs with the code that changes it.
const PLAY_ICON_PATH = "M8.2 5.4v13.2L19 12z";
const PAUSE_ICON_PATH = "M7.8 5.4h3.4v13.2H7.8z M12.8 5.4h3.4v13.2h-3.4z";

// [UI-REDESIGN / Stage 6] Paints #play-btn from the runtime's OWN isPlaying
// flag and nothing else — no local "is it playing" variable exists here, and
// none may be added. syncControls() is the only caller, and it runs from
// render(), which is the runtime subscription; so the icon, the accessible
// name and the tooltip cannot drift from what is actually playing, including
// when playback stops without anyone pressing this button (a filter hiding the
// last visible item, runtime.clear(), the end of a non-looping run).
//
// Deliberately writes all three of icon/aria-label/title together: a screen
// reader user hearing "Play" on a button that pauses is the failure mode this
// whole substage exists to avoid.
function syncPlayPauseButton(isPlaying) {
  const label = isPlaying ? "Pause" : "Play";
  playPauseIcon.setAttribute("d", isPlaying ? PAUSE_ICON_PATH : PLAY_ICON_PATH);
  playBtn.setAttribute("aria-label", label);
  playBtn.setAttribute("title", label);
  // Presentational only — lets the stylesheet treat the pause state
  // differently later without JS needing to know about it.
  playBtn.classList.toggle("is-playing", isPlaying);
}

function syncControls(state) {
  const hasItems = state.hasItems;
  const canNavigate = state.hasVisibleItems;

  prevBtn.disabled = !canNavigate;
  nextBtn.disabled = !canNavigate;
  // [UI-REDESIGN / Stage 6] One button, so one disabled rule. It was
  // `!canNavigate || state.isPlaying` while Start and Stop were separate —
  // Start went dead the moment playback began, which is exactly the state in
  // which this button now has to be pressable. `|| state.isPlaying` therefore
  // becomes `&& !state.isPlaying`: anything running can always be paused, even
  // in the transient case where the last visible item has just been filtered
  // away and the runtime has not yet emitted its own stop.
  playBtn.disabled = !canNavigate && !state.isPlaying;
  syncPlayPauseButton(state.isPlaying);
  clearBtn.disabled = isLoadingFiles || !allItems.length;

  // [UI-REDESIGN / Stage 3] Nothing to show fullscreen without a current
  // item — the same condition the `F` shortcut checks, kept here so the
  // button and the shortcut agree about when Fill is available.
  fillPanelBtn.disabled = !state.currentItem;

  // [UI-REDESIGN / STAGE 6] [GALLERY-TARGET-PROGRESSIVE-FLOW] There is no
  // target to confirm without items — validateGalleryJumpTarget() would
  // reject any input anyway (state.total is falsy), so this just keeps the
  // button from inviting a click that can only fail. The target input itself
  // is disabled for the same reason: nothing to type toward.
  galleryJumpNextBtn.disabled = !hasItems;
  galleryJumpInput.disabled = !hasItems;

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
  // [UI-REDESIGN / STAGE 6] [PLAYER-TRANSPORT-COUNTER-RETIRE] The
  // `counterText.textContent = ...` write that stood here is gone with
  // #counter-text — see syncGalleryJumpTarget(), called from this same
  // render() a few lines below, for the surface that now shows this.

  overlayPlayBtn.textContent = state.isPlaying ? "⏸" : "⏯";

  syncFavoriteButtons(state.currentItem);
  syncHideButton(state.currentItem);
  // [UI-REDESIGN / STAGE 6] [PM-HIDE-UNDO-WAYPOINT] Must re-run on every
  // render, not just after Hide/Undo itself — the waypoint's display
  // condition depends on the CURRENT item, which changes on ordinary
  // navigation.
  syncUndoHideButton();
  // [UI-REDESIGN / STAGE 6] [PM-AUTOMATIONS-MEDIA-SUPPORT] Same reasoning —
  // photo/video availability must track the CURRENT item on every render.
  syncAutomationsMediaAvailability(state.currentItem);
  renderPresentationTagsPanel(state.currentItem);
}

function render(state) {
  renderGallery(state);
  buildViewer(state);
  syncControls(state);
  syncGalleryJumpTarget(state);
  // [UI-REDESIGN / Stage 4] Catches the playback half of the strip's
  // condition — starting, stopping, and advancing to a new filename. The
  // workspace half is caught by setActiveWorkspace().
  syncNowPlayingStrip(state);
}

// ---- Event wiring ---------------------------------------------------------

fileInput.addEventListener("change", (event) => {
  loadFiles(event.target.files);
  fileInput.value = "";
});

folderInput.addEventListener("change", (event) => {
  const files = event.target.files;

  // [PHASE-6-SYNC-V2]
  // [STAGE-E-LIVE-INTEGRATION]
  // [WHY: this used to call profile.setMasterFolder({ name: topFolderName }),
  //  which wrote the opened folder's name onto WHICHEVER PROFILE HAPPENED TO BE
  //  ACTIVE — a durable association nobody asked for, created by the mere act
  //  of opening a folder. Two consequences made it unsafe: it silently
  //  re-pointed the active Profile's masterFolder every time a different folder
  //  was browsed, and under Sync V1 that value travels in the published
  //  collection, so one device browsing a folder rewrote metadata on every
  //  other device. Association is now EXCLUSIVELY an explicit user action —
  //  associateCurrentLibraryWithProfile() — which is also the only place that
  //  mints a shared libraryId. Opening a folder is navigation, not identity.
  //  topFolderName is still computed: loadFiles() needs it to fingerprint a
  //  legacy folder for RECOGNITION, which is local-only and associates nothing.]
  const firstFile = files && files[0];
  const topFolderName = firstFile && firstFile.webkitRelativePath ? firstFile.webkitRelativePath.split("/")[0] : null;

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

// [UI-REDESIGN / STAGE 6] [PM-AUTOMATIONS-COMMIT-AND-CLOSE]
// `change` only fires from genuine user interaction with the checkbox or
// its label — never from #overlay-automation-btn's own programmatic
// `videoLoopInput.checked = true` (a plain property assignment does not
// dispatch `change`), which is what makes this the correct, narrow place
// for "the user directly chose plain Loop" auto-close: 🤖's own path
// (which also turns Loop on, then immediately opens the nested Forever/X
// Times/Until Timer chooser) is untouched and must NOT auto-close here.
videoLoopInput.addEventListener("change", () => {
  syncVideoLoopControl();
  if (videoLoopInput.checked) {
    closeAutomationsTray();
  }
});

// [UI-REDESIGN / Stage 3] The #fill-input change listener is retired with
// the checkbox. It was the mechanism that made Fill a side effect of a
// stored setting — entering on tick-while-playing, exiting on untick. Fill
// is now entered only by an explicit act (#fill-panel-btn or the `F`
// shortcut) and left only by an explicit act (Escape or the PM toolbar).

// [UI-REDESIGN / Stage 3] Pure preference — read at the moment of
// deliberate Fill entry (see enterFillPanelDeliberately) and never acted on
// here, so ticking it does not itself enter Fill, start playback, or change
// anything on screen.
autoplayOnFillInput.addEventListener("change", () => {
  savePlaybackPreferences({ autoplayOnFill: autoplayOnFillInput.checked });
});

// [UI-REDESIGN / Stage 4 fix]
// WHAT: Releases focus from a Gallery filter control after a POINTER
// activation, so the ordinary Player gets its keyboard shortcuts back
// immediately. Keyboard activations are left completely alone.
//
// ROOT CAUSE this addresses: clicking one of these buttons leaves it as
// document.activeElement. isKeyboardFocusedControl() then tests
// :focus-visible, which the browser re-evaluates from recent input
// modality rather than fixing at focus time — so the moment the user
// pressed a key afterwards, the still-focused button began matching
// :focus-visible and swallowed ArrowLeft/ArrowRight/Space/F for as long as
// it held focus. (L was already exempt from that guard, which is exactly
// why L kept working and nothing else did.)
//
// `event.detail` is what separates the two cases, and it is the reason this
// does not cost any keyboard accessibility: a real pointer click reports
// detail > 0, while a click synthesized by Enter or Space on a focused
// button reports detail === 0. So a keyboard user who Tabs to a filter and
// presses Space keeps focus, keeps the focus ring, and keeps every native
// interaction; only the mouse user — who has no use for focus sitting on
// the button they just released — gives it up.
//
// FUTURE: This is deliberately NOT a global blur-on-click. It is attached
// to the specific controls named at each call site, because those are the
// ones that sit between the user and the Player. Do not generalize it into
// a document-level handler, and do not weaken isKeyboardFocusedControl()
// itself — that guard is what keeps Space from stealing a tabbed-to
// button's activation and arrows from stealing the workspace tablist.
//
// [UI-REDESIGN / STAGE 6] [TRANSPORT-KEYBOARD-SHORTCUT-RELEASE]
// WHAT: `grantShortcutGrace`, an opt-in second parameter, defaulting to
// false so every EXISTING call site (Gallery filter/type/tag buttons, the
// Tags filter chips, the Gallery card grid) is completely unaffected unless
// it explicitly asks for the new behavior. Only the five ordinary transport
// commands — Play/Pause, Previous, Next, Fill, Favorite — pass `true`.
// CONFIRMED REPRODUCTION this closes for those five: Tab to one of them,
// press Enter — the command runs, and the `detail === 0` branch below
// correctly leaves focus and its ring exactly where genuine keyboard
// navigation put them, same as always. But the COMMAND is now finished, and
// until this fix nothing told handleTransportKeydown()'s guard that:
// isKeyboardFocusedControl() kept reporting the still-focused button as
// genuinely keyboard-driven, so every shortcut but L stayed blocked for as
// long as it held focus.
// releaseTransientTriggerFocus() is the SAME grace mechanism the three
// transient disclosures already use for the identical shape of problem
// (focus legitimately staying somewhere after an interaction has already
// concluded) — see its own block's WHAT/WHY further up this file.
// WHY this needed to be OPT-IN rather than unconditional for every caller:
// the five transport commands share a property the other callers do NOT —
// native Enter/Space activation and the corresponding global shortcut
// (Space, ←/→, F, L) call the EXACT SAME underlying function for all five,
// so granting the grace changes no observable outcome there. A Gallery
// filter button (All media, Type, a Tag chip) has no such equivalence: Space
// pressed a second time while one of THOSE still holds focus is supposed to
// re-activate THAT button via native semantics, not fall through to a
// global shortcut with unrelated meaning. Making this unconditional for
// every caller would have silently broken repeated-Space-on-a-focused-
// filter-button for exactly that reason — the parameter is what keeps the
// fix scoped to the five controls it was proven safe for.
// The grace ends the moment focus actually leaves the button — see the
// shared `focusout` listener next to transientTriggersReleased's own
// declaration — so Tab-away-then-Tab-back-to-Play is unaffected and gets
// ordinary focused-button semantics again, exactly as before this fix.
function releaseFocusAfterPointerActivation(event, grantShortcutGrace = false) {
  if (event.detail === 0) {
    // Keyboard-synthesized click — the user is driving this control from
    // the keyboard and must keep both its focus and its ring.
    if (grantShortcutGrace) releaseTransientTriggerFocus(event.currentTarget);
    return;
  }
  event.currentTarget?.blur?.();
}

// [UI-REDESIGN / Stage 5 fix]
// WHAT: The single way anything hands the keyboard to the Player. Moves focus
// to #viewer-stage — the neutral, tabindex="-1" target Stage 5 already added
// for exactly this — and marks it so the focus is actually VISIBLE.
// WHY (the marker class): the stage is only ever focused by script, and after
// a POINTER activation the browser reports pointer modality and withholds
// :focus-visible, so the Stage 5 `[tabindex]:focus-visible` ring would not
// paint and focus would move with no sign of it. A plain `.viewer-stage:focus`
// rule is not the answer either: a tabindex="-1" element IS focusable by
// click, so clicking the media itself would then paint a ring nobody asked
// for. The class is set only on this deliberate hand-off and cleared on blur,
// which keeps the ring exactly on the hand-off and nowhere else.
// The blur listener is on the stage ELEMENT — there is deliberately no
// document-level focus/blur handler anywhere in this app.
// FUTURE: Any future "give the Player the keyboard back" control must call
// THIS rather than viewerStage.focus() directly, or it will move focus
// invisibly for mouse users.
function focusPlayerStage() {
  // focus() is a silent no-op on a display:none element, and .hidden is
  // `display: none !important`. The caller has already brought the Gallery
  // workspace forward; this covers the remaining case of a stage with nothing
  // mounted on it, where there is no Player to hand anything to.
  if (viewerStage.classList.contains("hidden")) return false;
  viewerStage.classList.add("is-focus-handoff");
  viewerStage.focus();
  return true;
}

viewerStage.addEventListener("blur", () => {
  viewerStage.classList.remove("is-focus-handoff");
});

allMediaBtn.addEventListener("click", (event) => {
  setViewMode("all");
  releaseFocusAfterPointerActivation(event);
});
favoritesOnlyBtn.addEventListener("click", (event) => {
  setViewMode("favorites");
  releaseFocusAfterPointerActivation(event);
});

typeAllBtn.addEventListener("click", (event) => {
  setTypeFilter("all");
  releaseFocusAfterPointerActivation(event);
});
typeImagesBtn.addEventListener("click", (event) => {
  setTypeFilter("image");
  releaseFocusAfterPointerActivation(event);
});
typeVideosBtn.addEventListener("click", (event) => {
  setTypeFilter("video");
  releaseFocusAfterPointerActivation(event);
});

// The Tag dropdown's own trigger. Blurring does not close the panel and does
// not touch its aria-expanded — the panel stays exactly as
// toggleTagsFilterPanel() left it. A keyboard user operating the dropdown is
// untouched (detail === 0), which is what "do not interfere while it is
// actively open and being keyboard-operated" requires.
tagsFilterToggleBtn.addEventListener("click", (event) => {
  toggleTagsFilterPanel();
  releaseFocusAfterPointerActivation(event);
});

// [UI-REDESIGN / STAGE 6] [TAG-DISCOVERY-HANDOFF]
manageTagsBtn.addEventListener("click", () => {
  expandAndScrollToTagsSection();
});

// [UI-REDESIGN / STAGE 6] [BROWSER-FOCUS-SHORTCUT-RESTORE] See playBtn's own
// click handler below for the full ROOT CAUSE — Previous/Next share it
// exactly: neither ever released focus after a pointer click, so either
// button could be left as document.activeElement indefinitely. The bug
// requires no keypress to surface: switching the whole browser tab away and
// back is enough (`:focus-visible` heuristics apply on browsing-context
// refocus, not only on the next keydown), so a session that starts with a
// mouse click on Previous or Next and includes so much as an alt-tab and
// back has always been able to reach the same stuck-shortcuts state — this
// was already broken by omission, not something the tab-switch introduces.
// [UI-REDESIGN / STAGE 6] [TRANSPORT-KEYBOARD-SHORTCUT-RELEASE] `true` here
// is the opt-in that grants the shortcut grace period on a keyboard
// activation — see releaseFocusAfterPointerActivation()'s own comment for
// why Previous/Next are safe additions (native Enter/Space activation and
// the ←/→ global shortcuts already call the exact same goToPreviousMedia()/
// goToNextMedia() functions, so the grace changes no observable outcome).
prevBtn.addEventListener("click", (event) => {
  goToPreviousMedia();
  releaseFocusAfterPointerActivation(event, true);
});
nextBtn.addEventListener("click", (event) => {
  goToNextMedia();
  releaseFocusAfterPointerActivation(event, true);
});

// [UI-REDESIGN / Stage 3] The ordinary Player's single "start" path. It is
// now reached only through toggleTransportPlayback(), which both the
// Play/Pause button and the Space shortcut call — so the two still cannot
// diverge, they just converge one level earlier than they used to.
//
// It is now just runtime.play(). The `if (fillInput.checked) enterFillMode()`
// half was retired with the checkbox: Start starts playback and nothing
// else. Going fullscreen is the `Fill ⛶` button's job, and Autoplay on Fill
// covers the reverse direction — entering Fill and wanting playback to
// begin.
function startPlaybackFromTransport() {
  runtime.play();
}

// The ordinary Player's Play/Pause. Deliberately NOT togglePlay(), which
// PM's own Space uses and which must keep going straight to the runtime —
// once PM is up, entering it again is meaningless and its keyboard behavior
// is established. Pausing is identical in both modes; only starting
// differs.
//
// [UI-REDESIGN / Stage 6] This is now the single entry point for BOTH the
// #play-btn click and the Space shortcut, and it is the only playback toggle
// the ordinary transport has. runtime.stop() is the pause half: it clears the
// interval and flips isPlaying, and it leaves #currentIndex and the current
// item exactly where they were, so resuming continues from the same media
// rather than restarting the sequence. Videos are paused in place by
// buildViewer() reading the same isPlaying, keeping their currentTime.
// FUTURE: There is ONE playback state and MediaRuntime owns it. Do not add a
// paused/resumed flag here to make this read more like a player.
function toggleTransportPlayback() {
  if (runtime.getState().isPlaying) {
    runtime.stop();
  } else {
    startPlaybackFromTransport();
  }
}

// [UI-REDESIGN / Stage 3] THE shared path for deliberately entering Fill
// Panel — as opposed to sliding into it as a side effect of pressing Start
// with Fullscreen / Fill Panel ticked, which is a different intent and
// deliberately does NOT come through here.
//
// Both deliberate-entry controls — the `Fill ⛶` button and the normal-mode
// `F` shortcut — call THIS. Any future control meaning "go fullscreen now"
// must too, rather than enterFillMode() directly, or the Autoplay on Fill
// preference will silently not apply to it.
//
// enterFillMode() no-ops if PM is already up and does not touch playback
// state, so it is safe regardless of what is running.
//
// Autoplay then applies to exactly one case: stopped, with the preference
// on. `wasPlaying` is sampled BEFORE entering and checked first, so a
// running slideshow is returned from untouched — entering Fill can never
// restart, reseek or reset it, whatever this preference says. Stopped with
// the preference off falls through to neither branch and stays paused,
// showing the current item and the PM toolbar.
function enterFillPanelDeliberately() {
  const wasPlaying = runtime.getState().isPlaying;

  enterFillMode();

  if (wasPlaying) return;
  if (!autoplayOnFillInput.checked) return;
  runtime.play();
}

// [UI-REDESIGN / Stage 6] The Play/Pause button and the Space shortcut are
// now literally the same call. It used to be startPlaybackFromTransport()
// here and toggleTransportPlayback() for Space, which only agreed because
// Start was disabled while playing; with one button that asymmetry would mean
// the click and the key doing different things, so both go through the
// toggle. startPlaybackFromTransport() is still the shared "start" half
// inside it, and Autoplay on Fill still reaches playback its own way.
//
// [UI-REDESIGN / STAGE 6] [BROWSER-FOCUS-SHORTCUT-RESTORE]
// ROOT CAUSE (confirmed reproduction: leave the browser tab, return, click
// Play, global shortcuts are now suppressed): this button never released
// focus after a pointer click, unlike every OTHER clickable control in the
// app (favoriteBtn, the Gallery filter/jump buttons, the three transient
// disclosure triggers) — all of those already call
// releaseFocusAfterPointerActivation() and are immune. A pointer click on
// #play-btn left it as document.activeElement indefinitely, with
// :focus-visible initially false (a pure pointer click never sets it) — so
// shortcuts kept working right up until either (a) a later keypress caused
// the browser to re-evaluate :focus-visible against "recent input modality"
// and flip it true, or (b) — the reported case — the whole browsing context
// lost and regained focus, which the CSS :focus-visible spec's own suggested
// heuristic explicitly treats as reason enough to make the
// currently-focused element focus-visible on its own, with no keypress
// required at all. Either path lands on the same place:
// isKeyboardFocusedControl() then sees #play-btn as genuinely
// keyboard-focused and the guard in handleTransportKeydown() blocks every
// shortcut but L, exactly matching the report.
// THE FIX: the same one-line pattern already used everywhere else in this
// file, extended to this button (and Previous/Next above, and Fill below —
// see A4: these three share the identical gap; Favorite and the three
// transient triggers already had it). This is not a window blur/focus
// listener and does not touch :focus-visible itself — it removes the
// PRECONDITION (a transport control left holding focus after an ordinary
// click) that both trigger paths depend on. Keyboard activation (detail ===
// 0) is untouched — Tab-to-Play-then-Enter still activates the button
// natively and keeps its focus ring, exactly as intended.
// [UI-REDESIGN / STAGE 6] [TRANSPORT-KEYBOARD-SHORTCUT-RELEASE] The `true`
// argument closes the remaining half of that same keyboard path — see
// releaseFocusAfterPointerActivation()'s own comment: without it, Tab to
// Play, press Enter, and every shortcut but L stayed blocked afterward even
// though the command had already completed.
playBtn.addEventListener("click", (event) => {
  toggleTransportPlayback();
  releaseFocusAfterPointerActivation(event, true);
});

// [UI-REDESIGN / Stage 3] Same shared entry path as the `F` shortcut.
// [UI-REDESIGN / STAGE 6] [BROWSER-FOCUS-SHORTCUT-RESTORE] Same gap, same
// fix as #play-btn above — see its comment for the full root cause.
// [UI-REDESIGN / STAGE 6] [TRANSPORT-KEYBOARD-SHORTCUT-RELEASE] Same `true`
// opt-in as Play above, for the same keyboard-Enter reason.
fillPanelBtn.addEventListener("click", (event) => {
  enterFillPanelDeliberately();
  releaseFocusAfterPointerActivation(event, true);
});

// [UI-REDESIGN / Stage 4] The now-playing strip's two controls. Both are
// distinct elements calling EXISTING functions — runtime.stop() is the same
// call toggleTransportPlayback() makes to pause (it was #stop-btn's call
// before Stage 6 retired that button), and ensureGalleryWorkspaceVisible()
// already existed for cross-workspace hand-offs. Neither re-implements
// anything, and no id is cloned.
nowPlayingStopBtn.addEventListener("click", () => runtime.stop());

// [UI-REDESIGN / Stage 5 fix]
// ROOT CAUSE of "shortcuts die after Return": this handler used to be
// `() => ensureGalleryWorkspaceVisible()` and nothing else, so activating it
// left #now-playing-return-btn as document.activeElement with no route back to
// the Player. It looked survivable because syncNowPlayingStrip() sets the
// strip's `hidden` attribute on the way out, which should have taken the
// focused button out of the layout and dropped focus to <body> — but
// `.now-playing-strip { display: flex }` is an AUTHOR rule and `[hidden]`'s
// `display: none` is a UA rule, and author beats UA outright. The strip never
// actually hid, the button kept focus, and on the next keypress it began
// matching :focus-visible, so isKeyboardFocusedControl() swallowed
// ArrowLeft/ArrowRight/Space/F. (See the matching `.now-playing-strip[hidden]`
// rule in styles.css, which is the other half of this fix and the same
// one-liner `.workspace-panel[hidden]` already carries.)
//
// The fix is not a stronger guard — it is an explicit hand-off. Returning is
// an unambiguous statement that the user has left the Tag workflow and is back
// in the media context, so focus MOVES to the Player rather than merely being
// released. Both activation routes get it, deliberately: unlike a Gallery
// filter button (pointer = release, keyboard = keep), there is nothing left to
// keep here — the control the user activated is on its way off screen either
// way, so blurring a keyboard user into nowhere would strand them at the top
// of the document.
//
// Order is load-bearing: Gallery must come forward FIRST, because #viewer-stage
// lives inside that panel and focus() does nothing on a display:none element.
// Neither call touches runtime state, so playback continues untouched — no
// restart, no stop, no seek.
//
// [UI-REDESIGN / Stage 6 fix] The activate-then-hand-off body moved into
// returnToGalleryAndFocusPlayer(), which the workspace tablist's Gallery tab
// now shares. Behavior here is unchanged; the point is that the two explicit
// "go to Gallery" controls can no longer drift apart. Only the no-Player
// fallback differs, and it is passed in: this button is on its way off screen
// either way, so releasing focus is strictly better than leaving it on a
// control that just left the layout — whereas the Gallery tab stays put and
// keeps its focus.
nowPlayingReturnBtn.addEventListener("click", (event) => {
  returnToGalleryAndFocusPlayer({
    onNoPlayer: () => event.currentTarget?.blur?.(),
  });
});

// [UI-REDESIGN / Stage 6] The `stopBtn.addEventListener("click", () =>
// runtime.stop())` that stood here is gone with #stop-btn. Its runtime.stop()
// is still reached from exactly two live places — toggleTransportPlayback()'s
// pause half, and #now-playing-stop-btn above.

clearBtn.addEventListener("click", () => {
  bumpGalleryGeneration();
  runtime.clear();
  provider.dispose();
  fsaProvider.dispose(); // [FSA] whichever source was active, release it
  allItems = [];
  clearViewerNode();
  exitFillMode();
  // [UI-REDESIGN / STAGE 6] [PM-HIDE-UNDO-WAYPOINT] Nothing is loaded
  // anymore, so any waypoint is meaningless — clear it.
  recentHideUndo = null;
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

favoriteBtn.addEventListener("click", (event) => {
  handleFavoriteToggle();
  // [UI-REDESIGN / Stage 5 fix] The transport ❤️ is a <button> that stays in
  // place after use — syncControls() only updates its class and glyph, never
  // replaces it — so a pointer click left it holding focus, and the
  // :focus-visible latch then swallowed ArrowLeft/ArrowRight/Space/F. L kept
  // working only because it is exempt from that guard: the same fingerprint
  // as every earlier instance.
  //
  // Favoriting is a per-item action taken WHILE watching the Player, not a
  // hand-off to somewhere else, so the pointer path just releases focus
  // rather than moving it — the user's attention is already on the media.
  // Keyboard activation (detail === 0) keeps focus and its ring, so Tab-to-
  // heart-then-Space still toggles Favorite and stays put.
  //
  // Nothing about persistence, the deferred Favorites-filter removal, or the
  // preserved history is touched — this runs after handleFavoriteToggle()
  // and only moves focus.
  // [UI-REDESIGN / STAGE 6] [TRANSPORT-KEYBOARD-SHORTCUT-RELEASE] `true`
  // grants the same keyboard-Enter shortcut grace Play/Previous/Next/Fill
  // now get — safe here for the same reason: native activation and the `L`
  // shortcut both call handleFavoriteToggle(), and L was already exempt from
  // the guard regardless, so this closes the same gap for Space/←/→/F
  // instead of leaving it as the one command still stuck after a keyboard
  // Enter.
  releaseFocusAfterPointerActivation(event, true);
});

// -- overlay / fill-panel controls --

// [UI-REDESIGN / Stage 5] The PM ❤️ deliberately gets NO focus release.
// handlePresentationKeydown() never consults isKeyboardFocusedControl() —
// verified — so a focused PM control cannot suppress PM shortcuts, and
// blurring here would only take focus away from a toolbar the user is
// actively clicking through.
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
    // [UI-REDESIGN / STAGE 6] [PM-HIDE-UNDO-WAYPOINT] [PM-HIDE-UNDO-WAYPOINT-RUNTIME-FIX]
    // The item MediaRuntime landed on immediately after hiding `item`
    // becomes the new waypoint, and the runtime's own navigationStep value
    // at this exact moment becomes the expiration baseline — see
    // recentHideUndo's own declaration comment for the full model. A
    // second Hide while an older waypoint is still active simply replaces
    // it wholesale (this pass is deliberately single-waypoint, not a
    // history stack).
    const landingItem = runtime.getCurrentItem();
    recentHideUndo = {
      hiddenRelativePath: item.relativePath,
      landingItemId: landingItem ? landingItem.id : null,
      landingNavigationStep: runtime.getState().navigationStep,
    };
    syncUndoHideButton();
  }
});

overlayUndoHideBtn.addEventListener("click", () => {
  if (!recentHideUndo) return;

  // Go straight through ProfileStore rather than toggleHidden — this is
  // always meant as "restore," regardless of the record's current state,
  // not a toggle.
  profile.setHidden(recentHideUndo.hiddenRelativePath, false);

  recentHideUndo = null;
  syncUndoHideButton();
});

overlayPlayBtn.addEventListener("click", () => {
  togglePlay();
});

overlayExitBtn.addEventListener("click", () => {
  exitFillMode();
});

// [UI-REDESIGN / Stage 4] Extracted verbatim from this button's own click
// handler so the ⚙ button and the `T` shortcut share ONE toggle path rather
// than two copies that can drift. The two closes are load-bearing and came
// with it: only one pop-out makes sense open at a time, so opening the Tags
// row closes the Automations editor and the Ghost popunder first.
// [UI-REDESIGN / STAGE 6] [PM-AUTOMATIONS-ENTRY] closeAutomationsTray() —
// not closeAutomationEditor() — is called here now: it already closes the
// editor as its own first step, and also closes the deep-compact tray
// itself, so opening Settings at ≤448px does not leave an orphaned,
// visually-empty tray open behind it.
// FUTURE: Any new way to open this row calls this — never toggle
// presentationSettings' class directly.
function togglePresentationSettingsPanel() {
  closeAutomationsTray();
  closeGhostPopunder();
  presentationSettings.classList.toggle("hidden");
}

overlaySettingsBtn.addEventListener("click", () => togglePresentationSettingsPanel());

ghostToggleBtn.addEventListener("click", () => {
  toggleGhostPopunder();
});

// [UI-REDESIGN / STAGE 6] [PM-AUTOMATIONS-CANONICAL] [PM-AUTOMATIONS-ACTIVE-STOP]
// WHAT: The canonical PM Automations entry point at every width, now a
// genuine two-state control:
//   ACTIVE (videoLoopInput.checked — see syncAutomationsActiveIndicator()'s
//   own comment for why this is the single source of truth): one click
//   STOPS all active Presentation automation behavior and closes the tray.
//   Does NOT open the tray first — active means this button IS the stop
//   command, not a route to go find one.
//   INACTIVE: ordinary open/close disclosure toggle, unchanged.
// This priority check must come first, exactly in this order — an active
// automation always wins over the open/close toggle, per the brief's own
// "IF automation active: stop... ELSE: toggle menu" state machine.
overlayAutomationsMenuBtn.addEventListener("click", () => {
  if (videoLoopInput.checked) {
    stopAllPresentationAutomations();
    closeAutomationsTray();
    return;
  }
  toggleAutomationsTray();
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
  // [UI-REDESIGN / STAGE 6] [PM-AUTOMATIONS-COMMIT-AND-CLOSE]
  // closeAutomationsTray() (was closeAutomationEditor() alone) — a
  // successful automation choice closes the WHOLE tray, not just the
  // nested chooser, per "the controls have completed their job."
  activeLoopRule = { type: "forever" };
  applyLoopRuleToCurrentVideo();
  closeAutomationsTray();
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

// -- Apply copies the draft into the applied rule, then closes the tray --
//
// [UI-REDESIGN / STAGE 6] [PM-AUTOMATIONS-COMMIT-AND-CLOSE]
// closeAutomationsTray() (was closeAutomationEditor() alone) — a
// successful Apply closes the WHOLE tray, not just the nested
// configuration row. Both draft values (automationDraftTotalPlays,
// automationDraftMinutes/Seconds) are already clamped to always-valid
// ranges by their own stepper handlers above (times ≥ 1; minutes ≥ 0;
// seconds 0–50 in steps of 10) — there is no existing "invalid Apply"
// state in this engine to preserve validation for, so both Apply handlers
// close unconditionally, exactly as before this pass, just closing one
// level higher.

automationTimesApplyBtn.addEventListener("click", () => {
  activeLoopRule = { type: "times", totalPlays: automationDraftTotalPlays };
  applyLoopRuleToCurrentVideo();
  closeAutomationsTray();
});

automationTimerApplyBtn.addEventListener("click", () => {
  activeLoopRule = { type: "timer", minutes: automationDraftMinutes, seconds: automationDraftSeconds };
  applyLoopRuleToCurrentVideo();
  closeAutomationsTray();
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
    default: {
      // [UI-REDESIGN / Stage 3] The two letter shortcuts, mirroring the
      // ordinary Player's: F toggles Fill (here, that means EXIT), and L is
      // Favorite. Both keys mean the same thing in both modes — F is
      // "toggle fullscreen", L is "favorite this" — so there is nothing to
      // remember about which mode you are in.
      //
      // These guards live HERE rather than at the top of this function on
      // purpose: PM's existing Escape/Arrow/Space branches have never had
      // them, and hoisting them would change established PM keyboard
      // behavior. They apply to the letter keys only.
      if (event.repeat) break;
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) break;

      const key = event.key.toLowerCase();

      if (key === "f") {
        // ROOT CAUSE of the reported regression, and why there is
        // deliberately NO focused-control guard on this branch:
        // isKeyboardFocusedControl() tests :focus-visible, and that state is
        // not fixed at focus time — the browser re-evaluates it from recent
        // input modality. Clicking ❤️ or a Tag control leaves that button
        // focused; the moment the user then touches the keyboard, the
        // focused button starts matching :focus-visible and the guard began
        // swallowing F permanently. The exit became unreachable without
        // first clicking somewhere neutral.
        //
        // Inside PM, F and Escape are the same command: get me out. Escape
        // has never consulted focus beyond the typing guard, and F must not
        // either. The isTypingTarget() check above is the ONLY guard — so F
        // still types a plain "f" into the tag-name field, an input, a
        // textarea, a select or any contenteditable, and exits from
        // everywhere else including an ordinary focused PM button.
        //
        // Layered, like a back button: one open PM pop-out closes on the
        // first press and Fill survives; with nothing open, the next press
        // exits. This is what makes F usable while the Tags row is up
        // without it being a trapdoor straight out of Presentation.
        //
        // preventDefault() is unconditional because F is always handled here
        // outside text entry — and it is what tells handleTransportKeydown
        // (which sees this same event) to keep its hands off, so exiting
        // cannot immediately re-enter.
        //
        // The exit itself is the same exitFillMode() the Escape branch above
        // and the PM Exit button both call — not a second implementation.
        // Playback state is preserved on the way out for all three.
        event.preventDefault();
        if (closeTopmostPresentationPanel()) break;
        exitFillMode();
        break;
      }

      if (key === "l") {
        // ROOT CAUSE of the reported regression, and why the focused-control
        // guard is gone from this branch too.
        //
        // isKeyboardFocusedControl() tests :focus-visible, which the browser
        // re-evaluates from recent input modality rather than fixing at
        // focus time. Clicking a Tag chip in the PM Settings/Tags row leaves
        // that button focused; the moment the user then touches the
        // keyboard it starts matching :focus-visible, and L was swallowed
        // for as long as that button held focus. Exactly the latching that
        // broke F two rounds ago — L was left exposed to it because the
        // instruction then was not to change L.
        //
        // Favoriting is a per-item action with no keyboard meaning on a Tag
        // chip, a toolbar button or anything else it could collide with, so
        // there is nothing for a focus guard to protect. Text entry is the
        // only real conflict, and it is handled below.
        //
        // isTextEntryTarget() rather than relying solely on the
        // isTypingTarget() check above: it additionally covers
        // [role="textbox"], and scoping it to this branch means PM's
        // Escape/Arrow/Space keep the exact guard they have always had.
        if (isTextEntryTarget(document.activeElement)) break;
        // Nothing on screen to favorite — same condition that hides the
        // overlay's own Favorite button (see the render path). Routed
        // through handleFavoriteToggle(), the exact function both Favorite
        // buttons call, so there is one Favorite path and one persistence
        // path rather than a keyboard-specific copy. Note it touches no
        // panel state — using L never closes Tags/Settings.
        if (overlayFavoriteBtn.classList.contains("hidden")) break;
        event.preventDefault();
        handleFavoriteToggle();
        break;
      }

      if (key === "t") {
        // [UI-REDESIGN / Stage 4] Opens/closes the PM Tags row — the exact
        // same togglePresentationSettingsPanel() the ⚙ button calls, so
        // there is one panel path, one set of class changes, and one rule
        // about which sibling pop-outs get closed. Nothing here duplicates
        // that logic and nothing here touches a Tag.
        //
        // No focused-control guard, for the same reason as F and L: a Tag
        // chip left focused by a pointer click must not suppress the key
        // (see the L branch for the :focus-visible latching explanation).
        // Text entry is the one real conflict — this is what lets a tag
        // name containing "t" be typed normally.
        //
        // PM-only by instruction: the ordinary Player deliberately has no
        // T binding yet.
        if (isTextEntryTarget(document.activeElement)) break;
        event.preventDefault();
        togglePresentationSettingsPanel();
        break;
      }
      break;
    }
  }
}

document.addEventListener("keydown", handlePresentationKeydown);

// ---- Ordinary Player keyboard shortcuts ---------------------------------
//
// [UI-REDESIGN / Stage 3 fix]
// WHAT: ArrowLeft / Space / ArrowRight drive Previous / Start-Stop / Next
// for the ordinary Player. Presentation Mode is untouched — it keeps its
// own handler above, and this one returns immediately while PM is active,
// so exactly one of the two ever responds to a given key.
// WHY: These are a keyboard route to the EXISTING buttons, not a new
// playback model. Previous/Next go through goToPreviousMedia()/
// goToNextMedia(), the same functions the buttons call, and Space uses the
// existing togglePlay() — deliberately NOT the transport button's click
// handler, because that also entered Fill Panel when Fill Panel was ticked,
// and a spacebar press silently going fullscreen would be an unpleasant
// surprise. [UI-REDESIGN / Stage 6] The sentence that stood here — "Start
// and Stop keep their labels and their separate buttons" — is no longer
// true of the ordinary Player: those two merged into one Play/Pause button.
// PM's own toolbar is unaffected and still has its own #overlay-play-btn.
// FUTURE: No visible shortcut hints in this stage, by instruction. If they
// are added later they belong next to the transport buttons, and this
// handler should stay the single source of what the keys do.
// [UI-REDESIGN / Stage 3 fix]
// Fields that swallow these keys as CONTENT — typing, caret movement, a
// select's own arrow handling. Blocked on focus alone, with no regard for
// how the focus was acquired: clicking into a text box with the mouse still
// means the next ArrowLeft is a caret move, not a Previous.
function isTextEntryTarget(el) {
  if (!el) return false;
  if (el.isContentEditable) return true;
  // closest() also tests the element itself, so this one call covers both
  // "focus IS the field" and "focus is inside one".
  return Boolean(
    el.closest?.(
      "input, textarea, select, [contenteditable=''], [contenteditable='true'], [role='textbox']"
    )
  );
}

// [UI-REDESIGN / Stage 3 fix]
// Buttons, links and tabs are different: they hold focus after a mouse
// click without the user having any intent to keep driving them from the
// keyboard.
//
// ROOT CAUSE of the reported regression: the previous guard blocked on any
// focused button. Mouse-clicking the transport ❤️ leaves it as
// document.activeElement, so every later ArrowLeft/ArrowRight/Space was
// suppressed until focus moved elsewhere — the shortcuts appeared to die.
//
// :focus-visible is exactly the distinction that was missing. The browser
// sets it when focus arrives by keyboard (Tab, or a shortcut it considers
// keyboard-driven) and withholds it when focus arrives by pointer. So a
// TABBED-to ❤️ still owns Space and toggles Favorite, while a CLICKED ❤️
// does not and the transport shortcuts keep working — which is the
// behavioral split asked for, rather than a blanket weakening of the guard.
function isKeyboardFocusedControl(el) {
  const control = el?.closest?.("button, a[href], [role='button'], [role='tab']");
  if (!control) return false;

  try {
    return control.matches(":focus-visible");
  } catch {
    // No :focus-visible support — fall back to the old, stricter behavior
    // (any focused control blocks) rather than silently firing shortcuts
    // out from under a keyboard user.
    return true;
  }
}

function handleTransportKeydown(event) {
  // [UI-REDESIGN / Stage 3 fix] ROOT CAUSE of the "F never exits Fill" bug.
  //
  // Both this and handlePresentationKeydown are document keydown listeners,
  // and PM's is registered first, so BOTH see the same F press. PM's handler
  // called exitFillMode(), which sets fillModeActive = false — and then this
  // handler ran on that same event, saw fillModeActive as already false,
  // sailed past the guard below, and re-entered Fill. One keypress exited
  // and immediately re-entered, so Fill appeared never to close while the PM
  // subpanels (closed by exitFillMode on the way out) did.
  //
  // Every branch in either handler calls preventDefault() when it acts, so
  // defaultPrevented is an accurate "this event is already spoken for".
  // Checked before the fillModeActive guard because it is about ownership of
  // the event, not about which mode we are in.
  if (event.defaultPrevented) return;
  // Presentation Mode owns the keyboard while it is up.
  if (fillModeActive) return;
  // Held keys must not machine-gun through the library.
  if (event.repeat) return;
  // Any modifier means the user is aiming at the browser or the OS, not at
  // the player — Ctrl+Left is a text/word jump, Alt+Left is Back, and so on.
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
  // An open Playback popover owns the keyboard while it is up, the same way
  // it already owns Escape — so Playback ⚙ keeps its normal keyboard
  // behavior instead of the transport stealing keys out from under an open
  // disclosure.
  if (isPlaybackPopoverOpen()) return;
  // Typing in a field always wins, however the field was focused.
  if (isTextEntryTarget(document.activeElement)) return;
  // A control the user is actually driving from the keyboard wins too —
  // this is what keeps ArrowLeft/Right working for the workspace tablist
  // and keeps Space on a tabbed-to ❤️ toggling Favorite. A control merely
  // left focused by a mouse click does NOT block; see
  // isKeyboardFocusedControl().
  //
  // [UI-REDESIGN / Stage 4 fix] L is exempt, matching its PM counterpart.
  // The guard exists to stop the transport stealing keys a focused control
  // needs — Space activates a button, arrows drive the tablist — but no
  // control anywhere in this app does anything with L, so there is nothing
  // for it to protect, and leaving it in meant a Tag chip or filter button
  // that merely held focus could suppress Favorite (see the PM branch for
  // the full :focus-visible latching explanation). Text entry is the one
  // genuine conflict and is already excluded on the line above.
  // F, Space and the arrows are deliberately unaffected.
  //
  // [UI-REDESIGN / STAGE 6] [TRANSIENT-FOCUS-SHORTCUT-RELEASE] The second
  // exemption: any of the three transient triggers (Playback ⚙, the Folders
  // drawer handle, the Tags filter toggle), but ONLY in the "a close path
  // just returned focus here" grace period — see the shared mechanism's own
  // block near the Tags filter panel above for the full ROOT CAUSE and WHY.
  // In one sentence: closing any of the three deliberately returns focus to
  // its trigger, isKeyboardFocusedControl() then correctly reports that
  // trigger as keyboard-focused, and nothing else distinguishes "just
  // closed" from "user tabbed here fresh, wanting to operate this control" —
  // without this, every shortcut but L stayed suppressed for as long as a
  // just-closed trigger held focus. A user who tabs to any of the three
  // fresh, having never opened it, still gets ordinary button semantics
  // (Space/Enter opens it) — the grace period is false for them.
  if (
    event.key.toLowerCase() !== "l" &&
    !hasTransientShortcutGracePeriod(document.activeElement) &&
    isKeyboardFocusedControl(document.activeElement)
  ) {
    return;
  }

  switch (event.key) {
    case "ArrowLeft":
      // Reading the button's own disabled state is what "respect existing
      // disabled/no-media behavior" means here — syncControls() already
      // computes it from the runtime, so there is no second rule to keep
      // in step.
      if (prevBtn.disabled) return;
      event.preventDefault();
      goToPreviousMedia();
      break;
    case "ArrowRight":
      if (nextBtn.disabled) return;
      event.preventDefault();
      goToNextMedia();
      break;
    case " ":
    case "Spacebar": // older browsers
      // [UI-REDESIGN / Stage 6] One button to consult, so one check. This
      // read `runtime.getState().isPlaying ? stopBtn.disabled :
      // playBtn.disabled` while the pair existed — picking whichever of the
      // two was live. #play-btn is now live in both directions and its
      // disabled state already accounts for playing (see syncControls), so
      // reading it is the whole rule. Same principle as ArrowLeft/ArrowRight
      // above: the button's own disabled state IS the shortcut's guard, so
      // there is never a second rule to keep in step.
      if (playBtn.disabled) return;
      // Also load-bearing for the mouse-clicked-❤️ case: a <button> that
      // still holds pointer focus would otherwise fire its own click on
      // Space and toggle Favorite as well. Preventing the default here
      // suppresses that activation, so Space means exactly one thing.
      event.preventDefault();
      // The exact call #play-btn's own click handler makes — one toggle, one
      // code path, so the key and the button can never disagree.
      toggleTransportPlayback();
      break;
    default:
      // [UI-REDESIGN / Stage 3] Two letter shortcuts. F toggles Fill —
      // this half enters, and handlePresentationKeydown's F exits — and L
      // is Favorite. Both keys mean the same thing in both modes; only the
      // direction of F differs, because that is what "toggle" means.
      //
      // preventDefault() keeps a stray letter out of Firefox's type-ahead
      // find; the guards above have already ruled out text fields and
      // keyboard-driven controls, and the repeat/modifier checks at the top
      // of this function cover both keys.
      if (event.key.toLowerCase() === "l") {
        // Nothing on screen to favorite — the same condition that hides the
        // transport's own ❤️ button. Same single path as that button:
        // handleFavoriteToggle(), no separate favorite state or persistence.
        if (favoriteBtn.classList.contains("hidden")) break;
        event.preventDefault();
        handleFavoriteToggle();
        break;
      }

      if (event.key.toLowerCase() === "f") {
        // Needs something to show. Entering PM on an empty library would
        // just be a black screen with a toolbar.
        if (!runtime.getState().currentItem) break;
        event.preventDefault();
        enterFillPanelDeliberately();
        break;
      }
      break;
  }
}

document.addEventListener("keydown", handleTransportKeydown);

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
// set matching the one that existed at tag time — validateGalleryJumpTarget's
// existing range check already guards against a now-invalid number
// (smaller current total, etc.) exactly as it would for any manually
// typed value, so nothing extra is needed here for that case.
function resumeTagActivityToJump(slot) {
  if (!slot) return;

  // [UI-REDESIGN / Stage 1A] The Jump input now lives inside the Gallery
  // workspace, so bring that workspace forward before writing to it —
  // scrollIntoView()/focus() are no-ops on a hidden element and this would
  // otherwise fail silently. Behavior is otherwise unchanged.
  ensureGalleryWorkspaceVisible();
  // [UI-REDESIGN / STAGE 6] [GALLERY-TARGET-PROGRESSIVE-FLOW] The target
  // input only exists on Step 1 — force the row back there first, or the
  // writes below land on a hidden field while Step 2's buttons are what's
  // actually on screen. Marks the value as a genuine edit in progress so a
  // background render cannot overwrite it before the user acts on it.
  setGalleryJumpStep("select");
  galleryJumpIsEditing = true;

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
      // [UI-REDESIGN / Stage 1C] Same flag on the outer card so the selected
      // treatment spans the whole tag, ✎/✕ cells included, instead of
      // stopping at this button's edge. Presentational only — no listener,
      // no state, and aria-pressed stays on the button that is actually
      // pressed.
      row.classList.toggle("is-selected", selectedTagActivityId === tag.id);
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
    // [UI-REDESIGN / Stage 5 fix] preserveId added — the same gap fixed in
    // the item-focused subscription below. Dropping a deleted tag from the
    // filter set widens the visible list, so the current item is almost
    // always still in it; without preserveId, load()'s index reset threw the
    // user to item 1 for a change that did not concern the item they were
    // looking at.
    reloadRuntime({
      preserveId: runtime.getState().currentItem?.id,
      keepPlaying: runtime.getState().isPlaying,
    });
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
    // [UI-REDESIGN / Stage 3 fix]
    // ROOT CAUSE of the reported jump: this reload used to be
    // unconditional. Un-favoriting the current item while Favorites Only
    // is active removes it from getVisibleItems(), so runtime.load() got a
    // list that no longer contained it. With no preserveId to match, the
    // runtime fell back to its default index and the player silently
    // jumped to a different item — the user's own click threw away what
    // they were looking at.
    //
    // So: when the current item is what just dropped out, defer the
    // reload instead of cancelling it. Nothing is duplicated and favorites
    // persistence is untouched — runtime.toggleFavorite() already wrote
    // through to the Profile before this subscription ran. The item simply
    // keeps playing until the user navigates away from it themselves, at
    // which point flushPendingFilterReload() rebuilds the filtered
    // sequence without it.
    const { currentItem, currentIndex, isPlaying } = runtime.getState();
    const currentStillVisible =
      !currentItem || getVisibleItems().some((item) => item.id === currentItem.id);

    if (currentStillVisible) {
      // [UI-REDESIGN / Stage 5 fix]
      // ROOT CAUSE of the "tagging jumps the player" report, and the other
      // half of the bug the Stage 3 note above only fixed for the dropped-out
      // case. MediaRuntime.load() ends with
      //     this.#currentIndex = this.#items.length ? 0 : -1;
      // so EVERY reload resets to the first item unless something puts the
      // index back. The dropped-out branch below was taught to do that;
      // this branch never was, so tagging an item that stayed perfectly
      // visible still rebuilt the list and landed on item 1.
      //
      // preserveId is the existing mechanism for exactly this — the same one
      // skipDuplicates' live toggle and the deferred flush already use. We
      // have just proven the item is in `visible`, so its findIndex cannot
      // miss.
      //
      // This is deliberately NOT a Favorites-specific patch: it is on the
      // shared branch, so it covers a Tag-filtered view and PM/Fill exactly
      // the same way, and it introduces no Tag state of its own.
      reloadRuntime({ preserveId: currentItem?.id, keepPlaying: isPlaying });
    } else {
      pendingFilterReloadIndex = currentIndex;
      pendingFilterReloadItemId = currentItem.id;
    }
  }
  // [PHASE-6-SYNC-V2]
  // [STAGE-E-LIVE-REMOTE-PROJECTION]
  // [WHY: synchronized facts adopted into the active Profile must immediately
  //  become visible in the loaded UI on either device without reload or local
  //  interaction. Re-projecting allItems above fixes the DATA, but the rendered
  //  surfaces are driven by runtime.subscribe(render) — and a REMOTE change
  //  moves no runtime state, so nothing re-rendered. Locally this was invisible
  //  because a click goes through runtime.toggleFavorite(), which does move the
  //  runtime; a peer's change has no such side effect. The filter branch above
  //  only re-renders when Favorites Only or a Tag filter happens to be active,
  //  so in the ordinary All view the badges and the favourite/hide controls kept
  //  showing pre-sync state.
  //
  //  These are the SAME functions render() already uses, called directly rather
  //  than through render(): buildViewer() would rebuild the media element and
  //  interrupt playback, which a background sync must never do. renderGallery()
  //  takes its own cheap same-list path (updateGalleryHighlightsAndBadges), so
  //  this refreshes badges without rebuilding 17k cards.]
  const projectedState = runtime.getState();
  renderGallery(projectedState);
  syncFavoriteButtons(projectedState.currentItem);
  syncHideButton(projectedState.currentItem);
  // [UI-REDESIGN / STAGE 6] [PM-HIDE-UNDO-WAYPOINT] Same reasoning as
  // render()'s own call — keeps the waypoint's display truthful here too.
  syncUndoHideButton();
  // [UI-REDESIGN / STAGE 6] [PM-AUTOMATIONS-MEDIA-SUPPORT] Same reasoning as
  // render()'s own call.
  syncAutomationsMediaAvailability(projectedState.currentItem);
  renderPresentationTagsPanel(projectedState.currentItem);
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

  // [PHASE-6-SYNC-V2][STAGE-E-LIVE-INTEGRATION]
  // [WHY: the recovery controls are gated on mode as well as status. A V2
  //  installation can never legitimately reach "conflict" (nothing in
  //  #reconcileV2 sets it), but gating on the mode too means a stale render
  //  from before activation cannot leave a whole-collection overwrite button
  //  on screen for an installation that has already cut over.]
  const isV2 = status.mode === "v2";
  profileSyncConflictPanel.classList.toggle("hidden", isV2 || status.status !== "conflict");

  // Offered only while still on V1, and only once a folder is actually
  // connected — activating with nothing to migrate from is possible but is a
  // Stage-E-and-later decision, not something to advertise here.
  profileSyncActivatePanel.classList.toggle("hidden", isV2 || !status.configured || status.status === "syncing");
  profileSyncLinkPanel.classList.toggle("hidden", !isV2 || !status.configured);

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
    // [PHASE-6-SYNC-V2]
    // [STAGE-B-VERIFIED-PUBLISH]
    // [WHY: a publish that failed read-back verification must never fall
    //  through to the `default` branch below, which renders "✓ Connected …
    //  Last sync: <time>" — the precise false reassurance this stage exists to
    //  remove. ProfileSync's own message is used verbatim because it is the
    //  only thing that knows WHICH verification failed; this switch must not
    //  paraphrase it into something more comforting.]
    case "verify-failed":
      line = `Sync not completed — ${status.message}`;
      break;
    // [PHASE-6-SYNC-V2]
    // [STAGE-E-LIVE-INTEGRATION]
    // [WHY: an installation whose activation did not finish is running NEITHER
    //  transport (see ProfileSync#reconcileImpl), so it must not render as
    //  connected, syncing, or offline — all three imply a working sync this
    //  installation does not currently have. It says so plainly and points at
    //  the retry, because the only correct next step is a user decision.]
    case "migration-failed":
      line = `Sync activation did not finish — ${status.message || "Your Profile data is safe and saved locally."}`;
      break;
    case "connected":
    default: {
      const v2 = status.mode === "v2";
      line = `✓ Connected — "${status.folderName}" · ${v2 ? "Sync V2" : "Sync V1"} · Auto Sync: ON · Last sync: ${
        status.lastSyncAt ? formatRelativeTime(status.lastSyncAt) : "just now"
      }`;
      // [PHASE-6-SYNC-V2][STAGE-E-LIVE-INTEGRATION]
      // [WHY: a skipped peer is appended to a CONNECTED line rather than
      //  replacing it. Skipping one device mid-write is normal, self-healing,
      //  and does not make this device's own verified pass any less real —
      //  reporting it as a failure would be as untruthful as hiding it.]
      if (v2 && status.skippedPeers && status.skippedPeers.length) {
        const count = status.skippedPeers.length;
        line += ` · ${count} device${count === 1 ? "" : "s"} skipped this pass (will retry)`;
      }
      if (v2 && status.migration && status.migration.reason) {
        line += ` · Note: ${status.migration.reason}`;
      }
    }
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

// [PHASE-6-SYNC-V2]
// [STAGE-E-LIVE-INTEGRATION]
// [WHY: one confirm, because activation is one-way for this device. The
//  wording states the two things the user cannot undo (this device stops
//  writing V1) and the one thing they might fear and shouldn't (nothing local
//  is deleted). ProfileSync.activateSyncV2() runs the migration and the first
//  real V2 pass; every status the user then sees comes from that pass, not
//  from this click.]
profileSyncActivateBtn.addEventListener("click", async () => {
  const confirmed = window.confirm(
    "Activate Sync V2 on this device?\n\n" +
      "• Changes from every device will be merged instead of one version replacing another.\n" +
      "• This device will stop writing the old sync format. Existing old files are left untouched.\n" +
      "• Nothing in your local Profiles is deleted.\n\n" +
      "This is one-way for this device."
  );
  if (!confirmed) return;

  profileSyncActivateBtn.disabled = true;
  try {
    await profileSync.activateSyncV2();
  } finally {
    profileSyncActivateBtn.disabled = false;
  }
  await renderSharedLibraryOptions();
});

// [PHASE-6-SYNC-V2]
// [STAGE-E-LIVE-INTEGRATION]
// [WHY: the list is built from association FACTS this device has merged — i.e.
//  libraries some device has actually shared — never from local folder names,
//  and never pre-selected. The user has to choose a specific shared id, which
//  is the whole point: matching a physical folder to a logical library is a
//  judgement only they can make safely.]
async function renderSharedLibraryOptions() {
  if (!profileSyncLinkSelect) return;
  const associations = profile.listAssociations();
  const ids = Object.keys(associations);

  // [PHASE-6-SYNC-V2][STAGE-E-CONVERGENCE-SCHEDULER]
  // [WHY: this now runs on every ProfileSync emit, and the scheduler makes
  //  those routine. Rebuilding the <select> unconditionally would discard the
  //  user's in-progress choice underneath them mid-interaction, so the DOM is
  //  only touched when the option set has genuinely changed.]
  const signature = ids.map((id) => `${id}:${associations[id]}`).join("|");
  if (profileSyncLinkSelect.dataset.signature === signature) return;
  profileSyncLinkSelect.dataset.signature = signature;

  profileSyncLinkSelect.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = ids.length ? "Choose a shared library…" : "No shared libraries known yet";
  profileSyncLinkSelect.appendChild(placeholder);

  for (const libraryId of ids) {
    const option = document.createElement("option");
    option.value = libraryId;
    const associatedProfile = profile.listProfiles().find((entry) => entry.id === associations[libraryId]);
    // Enough context to choose safely: which Profile it belongs to, plus the
    // id itself so two libraries on the same Profile are still distinguishable.
    option.textContent = `${associatedProfile ? associatedProfile.name : "Unknown Profile"} · ${libraryId.slice(0, 8)}…`;
    profileSyncLinkSelect.appendChild(option);
  }

  profileSyncLinkBtn.disabled = ids.length === 0;
}

profileSyncLinkBtn.addEventListener("click", async () => {
  const sharedLibraryId = profileSyncLinkSelect.value;
  if (!sharedLibraryId) {
    profileSyncLinkStatus.textContent = "Choose a shared library first.";
    return;
  }
  if (!activeLibraryRecord || !activeLibraryRecord.id) {
    profileSyncLinkStatus.textContent = "Load the folder you want to link first.";
    return;
  }

  profileSyncLinkBtn.disabled = true;
  try {
    const linked = await linkLocalLibraryToSharedId(activeLibraryRecord.id, sharedLibraryId);
    if (!linked) {
      profileSyncLinkStatus.textContent =
        "Could not link this folder — it is already linked to a different shared library.";
      return;
    }
    activeLibraryRecord = linked;
    // The next pass reconciles this row's Profile pointer from the association
    // fact; nothing is copied or moved here.
    await profileSync.syncNow();
    profileSyncLinkStatus.textContent = `Linked "${linked.name}" to the shared library.`;
    await renderRecentLibraries();
    syncAssociateButtonVisibility();
  } catch (error) {
    console.warn("[SYNC-V2] Could not link this folder to a shared library.", error);
    profileSyncLinkStatus.textContent = "Could not link this folder. Try again.";
  } finally {
    profileSyncLinkBtn.disabled = false;
  }
});

profileSync.subscribe(renderProfileSync);
profileSync.subscribe(() => {
  renderSharedLibraryOptions().catch(() => undefined);
});
renderProfileSync();
renderSharedLibraryOptions().catch(() => undefined);

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
  // [UI-REDESIGN / Stage 3] `fillInput.checked = playback.fillPanel` retired
  // with the checkbox. Restored like every other playback control:
  // loadPreferences() has already defaulted this to true for records saved
  // before the key existed, so an older stored record lands here as ON.
  autoplayOnFillInput.checked = playback.autoplayOnFill;

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

// [UI-REDESIGN / Stage 3 fix] Registered BEFORE render on purpose.
// MediaRuntime notifies listeners in insertion order, so this one gets to
// rebuild the list first and render() then draws the corrected state in the
// same pass — rather than painting the stale sequence and correcting it a
// frame later.
runtime.subscribe(handlePendingFilterReloadOnAdvance);

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

// =============================================================================
// [TEMP-PROFILE-IDENTITY-AUDIT / TEMPORARY]
//
// WHAT: One manually-invoked, read-only DevTools entry point —
// window.__bgProfileIdentityAudit(options) — that compares the ACTIVE
// Profile's stored media keys (Favorites / Hidden / tag-assigned) against the
// CURRENTLY LOADED media collection's keys, reporting aggregate exact-vs-
// normalized match counts, FSA scan-completeness diagnostics, safe path-shape
// aggregates, and read-only sync-folder-shape presence flags.
//
// WHY: The static audit proved the Profile lookup key is a raw, un-normalized
// `relativePath` string and that silent FSA under-enumeration is possible, but
// could NOT prove which effect causes the desktop's visible mismatch: discovery
// failure (media never scanned) vs identity failure (media scanned, key differs
// by Unicode/case/separator/root-level). This distinguishes them with direct
// runtime evidence, on both ChromeOS and Windows, WITHOUT changing behavior.
//
// FUTURE / DO-NOT-BREAK: This block is inert unless explicitly called. It must
// NEVER mutate, persist, sync, normalize, or migrate any record; never call a
// ProfileStore method that emits (it uses only read accessors); never write
// IndexedDB or the filesystem; never requestPermission (queryPermission only);
// and never print raw filenames/paths by default (hashing requires an explicit
// salt). Remove this entire block, the `__identityAuditLastFsaLoad` variable,
// and its single capture line in loadFromFsaHandle() once the cross-device
// cause is proven. Do not build production features on top of it.
// =============================================================================

// Normalization forms compared. Each is pure and side-effect-free.
const __iaNFC = (s) => s.normalize("NFC");
const __iaNFD = (s) => s.normalize("NFD");
const __iaCI = (s) => s.normalize("NFC").toLowerCase(); // case-insensitive, on an NFC base
const __iaSlash = (s) => s.normalize("NFC").replace(/\\/g, "/").replace(/\/+/g, "/"); // separator-normalized

// Salted SHA-256 hex (falls back to a non-crypto hash only if SubtleCrypto is
// unavailable — GitHub Pages is HTTPS so the real digest is used there). Used
// ONLY when the caller supplies a salt and opts into per-key hashing.
async function __iaHash(salt, value) {
  const text = `${salt} ${value}`;
  if (typeof crypto !== "undefined" && crypto.subtle && typeof crypto.subtle.digest === "function") {
    const bytes = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

// Builds Map<normalizedForm, Set<rawLoadedKey>> indexes for each normalization
// so match lookup AND ambiguity detection (>1 distinct loaded key sharing a
// normalized form) are both O(1) per stored key.
function __iaBuildLoadedIndexes(loadedKeys) {
  const mapOf = (fn) => {
    const m = new Map();
    for (const k of loadedKeys) {
      const key = fn(k);
      let set = m.get(key);
      if (!set) m.set(key, (set = new Set()));
      set.add(k);
    }
    return m;
  };
  return {
    exact: new Set(loadedKeys),
    nfc: mapOf(__iaNFC),
    nfd: mapOf(__iaNFD),
    ci: mapOf(__iaCI),
    slash: mapOf(__iaSlash),
  };
}

// Classifies stored keys into mutually-exclusive terminal buckets so the counts
// partition the total exactly:
//   exact + nfc + nfd + ci + slash + ambiguous + unmatched === total
// A normalized match that resolves to MORE THAN ONE distinct loaded key is
// classified `ambiguous` (never silently attributed to a single file).
function __iaClassify(storedKeys, idx) {
  const counts = { exact: 0, nfc: 0, nfd: 0, ci: 0, slash: 0, ambiguous: 0, unmatched: 0, total: storedKeys.length };
  const stages = [
    ["nfc", __iaNFC, idx.nfc],
    ["nfd", __iaNFD, idx.nfd],
    ["ci", __iaCI, idx.ci],
    ["slash", __iaSlash, idx.slash],
  ];
  const unmatched = [];
  const ambiguous = [];

  for (const k of storedKeys) {
    if (idx.exact.has(k)) {
      counts.exact += 1;
      continue;
    }
    let done = false;
    for (const [stage, fn, map] of stages) {
      const set = map.get(fn(k));
      if (set && set.size) {
        if (set.size > 1) {
          counts.ambiguous += 1;
          ambiguous.push({ stage });
        } else {
          counts[stage] += 1;
        }
        done = true;
        break;
      }
    }
    if (!done) {
      counts.unmatched += 1;
      unmatched.push(k);
    }
  }
  return { counts, unmatched, ambiguous };
}

// Distribution/collision aggregates over a key list — no raw paths, only shape.
function __iaShape(keys) {
  const depthHistogram = {};
  let withEdgeWhitespace = 0;
  let rawNeqNfc = 0;
  let nfcNeqNfd = 0;
  const firstSegments = new Set();
  const ciGroups = new Map();
  const nfcGroups = new Map();

  for (const k of keys) {
    const segments = k.split("/");
    const depth = segments.length;
    depthHistogram[depth] = (depthHistogram[depth] || 0) + 1;
    if (segments.some((s) => s !== s.trim())) withEdgeWhitespace += 1;
    if (k !== __iaNFC(k)) rawNeqNfc += 1;
    if (__iaNFC(k) !== __iaNFD(k)) nfcNeqNfd += 1;
    firstSegments.add(segments[0]);

    const ci = __iaCI(k);
    let ciSet = ciGroups.get(ci);
    if (!ciSet) ciGroups.set(ci, (ciSet = new Set()));
    ciSet.add(k);

    const nfc = __iaNFC(k);
    let nfcSet = nfcGroups.get(nfc);
    if (!nfcSet) nfcGroups.set(nfc, (nfcSet = new Set()));
    nfcSet.add(k);
  }

  const depths = Object.keys(depthHistogram).map(Number);
  const maxDepth = depths.length ? Math.max(...depths) : 0;

  return {
    count: keys.length,
    minDepth: depths.length ? Math.min(...depths) : 0,
    maxDepth,
    depthHistogram,
    keysWithEdgeWhitespaceSegment: withEdgeWhitespace,
    keysNotAlreadyNFC: rawNeqNfc,
    keysWhereNFCDiffersFromNFD: nfcNeqNfd,
    distinctFirstSegments: firstSegments.size,
    allShareSingleFirstSegment: firstSegments.size === 1 && maxDepth > 1,
    caseOnlyCollisionGroups: [...ciGroups.values()].filter((s) => s.size > 1).length,
    nfcCollisionGroups: [...nfcGroups.values()].filter((s) => s.size > 1).length,
  };
}

// Read-only sync-folder shape probe (Audit B). Reads the saved sync handle
// straight from its own IndexedDB store — never through ProfileSync, so no
// reconcile/write/Auto-Sync is triggered — and uses queryPermission only (never
// a prompt) plus create:false lookups (never a write). Reports presence flags
// for the normal vs nested generation without reading Profile contents.
async function __iaSyncFolderShape() {
  let loadSyncConfig;
  try {
    ({ loadSyncConfig } = await import("./storage/profile-sync-store.js"));
  } catch (error) {
    return { available: false, reason: `could not load sync store: ${error && error.name}` };
  }

  let config;
  try {
    config = await loadSyncConfig();
  } catch (error) {
    return { available: false, reason: `could not read sync config: ${error && error.name}` };
  }
  if (!config || !config.handle) return { available: true, configured: false };

  const handle = config.handle;
  let permission;
  try {
    permission = await handle.queryPermission({ mode: "readwrite" });
  } catch (error) {
    return { available: true, configured: true, folderName: config.folderName, permission: "error" };
  }
  if (permission !== "granted") {
    return { available: true, configured: true, folderName: config.folderName, permission };
  }

  const present = async (fn) => {
    try {
      await fn();
      return true;
    } catch {
      return false;
    }
  };

  const rootManifest = await present(() => handle.getFileHandle("manifest.json"));
  let rootProfilesDir = null;
  try {
    rootProfilesDir = await handle.getDirectoryHandle("profiles");
  } catch {
    rootProfilesDir = null;
  }
  const nestedProfilesDir = rootProfilesDir ? await present(() => rootProfilesDir.getDirectoryHandle("profiles")) : false;
  const nestedManifest = rootProfilesDir ? await present(() => rootProfilesDir.getFileHandle("manifest.json")) : false;

  return {
    available: true,
    configured: true,
    folderName: config.folderName,
    permission,
    selectedSyncHandleName: handle.name,
    rootManifestPresent: rootManifest,
    rootProfilesDirPresent: Boolean(rootProfilesDir),
    nestedProfilesDirPresent: nestedProfilesDir,
    nestedManifestPresent: nestedManifest,
  };
}

/**
 * [TEMP-PROFILE-IDENTITY-AUDIT] Manual, read-only entry point.
 *
 * Usage (DevTools console, after loading beebeegees via its FSA Recent Library
 * with BEAST active — do NOT click Sync Now):
 *
 *   await __bgProfileIdentityAudit()                      // aggregates only, no paths
 *   await __bgProfileIdentityAudit({ salt: "team-2026", hashUnmatched: true })
 *
 * options:
 *   - salt: string. Required only if hashUnmatched is true. The SAME salt on
 *     both devices makes emitted hashes comparable across devices while never
 *     revealing a filename. Never persisted, never synced.
 *   - hashUnmatched: false (default). When true (and salt given), emits salted
 *     SHA-256 hashes of unmatched Favorite keys AND all loaded keys, in both
 *     raw and NFC forms — so the two devices' sets can be intersected offline
 *     to separate "never discovered" (raw hashes don't intersect) from
 *     "discovered but different form" (NFC hashes intersect).
 *   - includeSyncFolder: true (default). Set false to skip the Audit-B probe.
 *   - maxHashSamples: 1000 (default) cap on emitted hashes per list.
 */
// [PHASE-6-SYNC-V2]
// [STAGE-E-HUMAN-DEVICE-LABEL]
// [WHY: real-device debugging must show a human-readable device name before
//  the raw UUID without allowing presentation metadata to affect sync
//  identity. Strictly READ-ONLY, and deliberately so: it reads ProfileSync's
//  already-published status surface rather than running a pass of its own, so
//  typing it into a console during a live two-device test cannot change what
//  that test is measuring — no sync pass, no write, no IndexedDB or Drive
//  access, no UI state change. Peer data is whatever the LAST pass observed;
//  if that reads as stale, run Sync Now deliberately and call this again.]
window.__bgSyncDevices = function () {
  const status = profileSync.getStatus();
  const lines = [];

  lines.push("=== SYNC V2 DEVICES ===");
  lines.push("");
  lines.push("THIS DEVICE");
  lines.push(`Device: ${status.deviceLabel || "Unknown Device"}`);
  lines.push(`Device ID: ${status.deviceId || "(not yet assigned)"}`);
  if (status.mode !== "v2") lines.push(`(Sync V2 is not active on this device — mode: ${status.mode})`);
  lines.push("");

  const peers = status.peers || [];
  lines.push(`PEERS (${peers.length} seen on the last pass)`);
  if (peers.length === 0) {
    lines.push("(none seen yet — run Sync Now, then call this again)");
  }
  for (const peer of peers) {
    lines.push("");
    lines.push(`Device: ${peer.label || "Unknown Device"}`);
    lines.push(`Device ID: ${peer.deviceId}`);
    lines.push(`Updated: ${peer.updatedAt ? new Date(peer.updatedAt).toLocaleString() : "unknown"}`);
  }

  const skipped = status.skippedPeers || [];
  if (skipped.length) {
    lines.push("");
    lines.push(`SKIPPED THIS PASS (${skipped.length})`);
    for (const peer of skipped) {
      lines.push(`  ${peer.deviceId} — ${peer.reason}`);
      // [PHASE-6-SYNC-V2][STAGE-E-REAL-DRIVE-HASH-RECOVERY]
      // [WHY: byte length and both digest prefixes are what distinguish a peer
      //  caught mid-propagation from a structural fault, which otherwise look
      //  identical from the outside.]
      if (peer.detail) lines.push(`      ${peer.detail}`);
    }
    lines.push("  (a skipped peer is retried automatically on the next pass — no action needed)");
  }

  if (status.ownGenerationSettling) {
    lines.push("");
    lines.push(
      `THIS DEVICE'S OWN GENERATION IS STILL SETTLING (pass ${status.ownGenerationSettling}) — ` +
        `${status.ownGenerationReason || "unreadable"}; waiting rather than rewriting.`
    );
  }

  console.log(lines.join("\n"));
  return undefined; // nothing to act on programmatically; this is a human report
};

window.__bgProfileIdentityAudit = async function (options = {}) {
  const { salt = null, hashUnmatched = false, includeSyncFolder = true, maxHashSamples = 1000 } = options;

  // ---- Identity context (all read-only accessors; none emit) --------------
  const activeProfileId = profile.getProfileId();
  const activeProfileName = profile.getProfileName();
  const knownPaths = profile.knownPaths();

  const favoriteKeys = knownPaths.filter((p) => profile.isFavorite(p));
  const hiddenKeys = knownPaths.filter((p) => profile.isHidden(p));
  const taggedKeys = knownPaths.filter((p) => profile.getItemTags(p).length > 0);
  const tagAssignmentTotal = knownPaths.reduce((sum, p) => sum + profile.getItemTags(p).length, 0);

  const loadedKeys = allItems.map((item) => item.relativePath);
  const loadedIdx = __iaBuildLoadedIndexes(loadedKeys);
  const loadedShape = __iaShape(loadedKeys);

  const favorites = __iaClassify(favoriteKeys, loadedIdx);
  const hidden = __iaClassify(hiddenKeys, loadedIdx);
  const tagged = __iaClassify(taggedKeys, loadedIdx);

  const report = {
    generatedAt: new Date().toISOString(),
    identity: {
      activeProfileId,
      activeProfileName,
      associatedLibraryName: activeLibraryRecord ? activeLibraryRecord.name : null,
      currentSourceKind, // "fsa" | "legacy" | "none"
      fsaRootHandleName: __p1DiagnosticRootName || (activeLibraryRecord ? activeLibraryRecord.name : null),
      loadedMediaCount: loadedKeys.length,
      rememberedRecentLibraryItemCount:
        activeLibraryRecord && typeof activeLibraryRecord.itemCount === "number" ? activeLibraryRecord.itemCount : null,
      storedProfileItemCount: knownPaths.length,
      storedFavoriteCount: favoriteKeys.length,
      storedHiddenCount: hiddenKeys.length,
      storedTagAssignmentCount: tagAssignmentTotal,
    },
    favoriteMatches: favorites.counts,
    hiddenMatches: hidden.counts,
    taggedRecordMatches: tagged.counts,
    loadedPathShape: loadedShape,
    storedFavoritePathShape: __iaShape(favoriteKeys),
    fsaCompleteness: __identityAuditLastFsaLoad
      ? {
          ...__identityAuditLastFsaLoad,
          countDriftVsRemembered:
            __identityAuditLastFsaLoad.rememberedItemCount !== null
              ? __identityAuditLastFsaLoad.loadedCount - __identityAuditLastFsaLoad.rememberedItemCount
              : null,
        }
      : { note: "No FSA scan has run in this session (load beebeegees via FSA Recent Library first)." },
    rootLevelEvidence: {
      fsaRootHandleName: __p1DiagnosticRootName || null,
      associatedLibraryName: activeLibraryRecord ? activeLibraryRecord.name : null,
      minSegmentDepth: loadedShape.minDepth,
      maxSegmentDepth: loadedShape.maxDepth,
      distinctFirstSegments: loadedShape.distinctFirstSegments,
      allKeysShareOneCommonFirstSegment: loadedShape.allShareSingleFirstSegment,
    },
  };

  // ---- Interpretation hint (NOT a verdict) --------------------------------
  const fav = favorites.counts;
  const normalizedRecovered = fav.nfc + fav.nfd + fav.ci + fav.slash;
  report.interpretationHint =
    fav.total === 0
      ? "No stored favorites in the active profile — confirm BEAST is the active profile."
      : fav.exact >= fav.total - fav.ambiguous
      ? "Mostly EXACT matches — identity is stable on this device."
      : normalizedRecovered > 0 && normalizedRecovered >= fav.unmatched
      ? "Normalized comparisons recover most misses => IDENTITY failure (Unicode/case/separator). Media WAS discovered."
      : fav.unmatched > normalizedRecovered
      ? "Most misses survive every safe normalization => likely DISCOVERY failure (media never scanned) OR a genuinely different key. Cross-check fsaCompleteness.countDriftVsRemembered and run hashUnmatched on both devices to confirm."
      : "Mixed signal — see counts; the cross-device hash comparison may be needed to distinguish.";

  // ---- Optional cross-device hashing (opt-in, salted) ---------------------
  if (hashUnmatched) {
    if (!salt || typeof salt !== "string") {
      report.hashes = { skipped: true, reason: "hashUnmatched requires a non-empty string `salt` (same on both devices)." };
    } else {
      const hashList = async (keys, fn) => Promise.all(keys.slice(0, maxHashSamples).map((k) => __iaHash(salt, fn(k))));
      report.hashes = {
        note: "Salted SHA-256. Intersect across devices: raw-hash overlap => same discovered file; NFC-hash overlap without raw overlap => same file, different Unicode form.",
        salted: true,
        truncatedTo: maxHashSamples,
        unmatchedFavoritesRaw: await hashList(favorites.unmatched, (s) => s),
        unmatchedFavoritesNFC: await hashList(favorites.unmatched, __iaNFC),
        loadedRaw: await hashList(loadedKeys, (s) => s),
        loadedNFC: await hashList(loadedKeys, __iaNFC),
      };
    }
  }

  // ---- Audit B: read-only sync-folder shape -------------------------------
  if (includeSyncFolder) {
    try {
      report.syncFolderShape = await __iaSyncFolderShape();
    } catch (error) {
      report.syncFolderShape = { available: false, reason: String(error && error.name) };
    }
  }

  // ---- Console summary (no raw paths) -------------------------------------
  console.log("%c[bgProfileIdentityAudit] read-only — nothing was modified.", "font-weight:bold");
  console.log("Identity / context:", report.identity);
  console.table({
    Favorites: report.favoriteMatches,
    Hidden: report.hiddenMatches,
    "Tagged records": report.taggedRecordMatches,
  });
  console.log("FSA completeness:", report.fsaCompleteness);
  console.log("Loaded path shape:", report.loadedPathShape);
  console.log("Root-level evidence:", report.rootLevelEvidence);
  if (report.syncFolderShape) console.log("Sync-folder shape (read-only):", report.syncFolderShape);
  console.log("%cInterpretation hint: " + report.interpretationHint, "color:#0a7");
  console.log("Full report object returned — use copy(await __bgProfileIdentityAudit()) or JSON.stringify it.");

  return report;
};
