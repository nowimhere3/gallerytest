import { LocalFileInputProvider } from "./providers/local-file-input-provider.js";
import { FsaFileProvider } from "./providers/fsa-file-provider.js";
import { extractRemoteUrls } from "./providers/remote-url-parser.js";
import { RemoteUrlProvider } from "./providers/remote-url-provider.js";
import { classifySelection } from "./intake/classify-selection.js";
import {
  collectSelectionEvidence,
  combineQualifyingFloppyTexts,
} from "./intake/collect-selection-evidence.js";
import {
  getRememberedCassetteOwner,
  readRememberedFolder,
} from "./intake/collect-folder-evidence.js";
import {
  listLibraries,
  addOrUpdateLibrary,
  touchLibrary,
  removeFromRecents,
  listLegacyLibraries,
  addLegacyLibrary,
  updateLegacyLibrarySignature,
  getLibraryById,
  getLibraryByLibraryId,
} from "./storage/library-registry.js";
import {
  listCassettes,
  addOrUpdateCassette,
  touchCassette,
  removeCassette,
} from "./storage/cassette-registry.js";
import {
  getSourceCuration,
  setSourceCuration,
  clearSourceCuration,
} from "./storage/source-curation-registry.js";
import { decideBootRestore, decideStartupMedia } from "./storage/boot-restore.js";
// [PM-SHUFFLE-FOLDERS] Pure candidate ORDERING only — the switching itself
// stays on this file's existing authoritative resumeLibrary() path. See that
// module's header for why the two halves are split this way.
import { orderShuffleFolderCandidates } from "./runtime/folder-shuffle.js";
// [PRESENTATION-PERF / PHASE 3A] Pure staleness decision only — the preparing,
// the timing and the DOM commit all stay in this file. See that module's header
// for what each of the four guarded facts protects against.
import { shouldCommitPreparedViewer } from "./runtime/viewer-commit.js";
import { planReadyQueueWork } from "./runtime/ready-queue.js";
import { canApplyWarmStartRelease, shouldReleaseWarmStart } from "./runtime/warm-start.js";
import { computeLegacySignature, matchLegacySignature } from "./storage/legacy-library-signature.js";
// [MEDIA-ID / STAGE-01 / CAPTURE-NOW-SEEDING]
// [WHY: MEDIA-ID is a WRITE-ONLY evidence pass in Stage 01 — it records what is
//  observed and reads nothing back into anything the user sees. Nothing it does
//  can change how this file behaves, which is exactly why it is safe to land
//  before the Stage 01B shared-signature audit decides what Stage 02 may
//  project. It is also why it should land NOW rather than with Stage 02: the
//  evidence it banks is the intersection of Profile facts and files still
//  reachable at their historical paths, and that intersection shrinks every
//  time a folder is reorganized before it has been recorded.]
import { resolveScopeForRoot } from "./storage/media-scope.js";
import { listRoots } from "./storage/media-identity.js";
import { runSeedingPass } from "./storage/media-seeding.js";
import { buildPortableStructureSample } from "./storage/portable-structure-evidence.js";
// [MEDIA-ID / STAGE-02 / LOCAL-PROJECTION]
// [WHY: Stage 02 is the first stage that READS MEDIA-ID back into what the user
//  sees. It projects Favorite / favoritedAt / Hidden / Tags across
//  DETERMINISTIC same-device aliases only — T0 (exact key) and T1 (a prefix
//  proven by FileSystemDirectoryHandle.resolve() or by a version-guarded
//  re-base). No structural inference, no metadata matching, no hashing. Nothing
//  here migrates, rewrites, rekeys, copies or restamps a Profile fact: the
//  facts stay exactly where the user put them and the projection is a read.]
import { buildAliasIndexForLoad, createMediaIdentityChannel, MEDIA_IDENTITY_MESSAGE_KINDS } from "./storage/media-alias-index.js";
// [MEDIA-ID / STAGE-02B / TELEMETRY]
import { createSessionHistory, formatTelemetry, TELEMETRY_LIMITS } from "./profile/media-identity-telemetry.js";
import {
  loadPreferences,
  savePlaybackPreferences,
  savePresentationPreferences,
  saveMicroArcadePreferences,
  saveOnboardingPreferences,
  saveStartupPreferences,
  DEFAULT_GHOST_OPACITY_PERCENT,
  DEFAULT_HOVER_OPACITY_PERCENT,
} from "./storage/app-preferences.js";
import { MediaRuntime } from "./runtime/media-runtime.js";
import {
  DEFAULT_ARCADE_ANIMATION_ORDER,
  renderArcadeAnimationOrderHelper,
  selectArcadeScene,
} from "./runtime/micro-arcade-selector.js";
import { haveSameDuplicateKey, skipDuplicateMedia } from "./runtime/duplicate-filter.js";
import { ProfileStore } from "./profile/profile-store.js";
import { createProfileProjectionView } from "./profile/profile-projection-view.js";
import { ProfileSync } from "./profile/profile-sync.js";
import { mapSyncStatusCopy } from "./profile/sync-status-copy.js";
import { mapAssociationCopy, shouldShowActiveCurationChoice } from "./profile/association-copy.js";
import { describeMediaLibrarySurface, mapLinkState } from "./profile/link-state.js";
import { applyProductStatusTone } from "./profile/status-tone.js";
import {
  PROFILE_SYNC_INTRO_STEPS,
  createContextualFirstUseState,
  describeContextualFirstUseActions,
  transitionContextualFirstUse,
} from "./profile/contextual-first-use.js";
import { createAssociationWriteSuppression } from "./profile/association-write-suppression.js";
import { describeMediaLibraryOptions } from "./profile/media-library-options.js";
import { createAmbientProfileObserver } from "./profile/ambient-profile-observer.js";
import { applyLoadTimeProfileRestoration } from "./profile/load-time-profile-restoration.js";
import { resolveProvenParentCuration } from "./profile/parent-curation-inheritance.js";
import {
  performReverseCurationSuggestionAction,
  resolveReverseCurationSuggestion,
} from "./profile/reverse-curation-suggestion.js";
import {
  performDeviceAwareMediaQuestionAction,
  resolveDeviceAwareMediaQuestion,
} from "./profile/device-aware-media-question.js";
import {
  buildAmbientProfileOfferView,
  performAmbientProfileAction,
} from "./profile/ambient-profile-action.js";
import {
  deleteAmbientProfileDecision,
  loadAmbientProfileDecision,
  saveAmbientProfileDecision,
} from "./profile/indexeddb.js";
import { TsPlaybackAdapter } from "./playback/ts-playback-adapter.js";
import { parseLaunchContext, LAUNCH_CONTEXT_STREAMLOOP } from "./runtime/launch-context.js";
import { parseStreamLoopMessage, nextPendingIntent } from "./runtime/streamloop-bridge.js";

// [STREAMLOOP-INTEGRATION / N6-6]
// BREADCRUMBS — IS: parsed once, here, from the URL this tab was actually
// opened with. Runtime-only — never written to app-preferences.js or any
// other persistence, so every load re-derives it fresh rather than letting a
// context from one launch survive into an unrelated later one. See
// launch-context.js for why this must stay the only place StreamLoop
// identity is decided.
const launchContext = parseLaunchContext(window.location.search);

const provider = new LocalFileInputProvider();
// [FSA] A second, independent provider for the File System Access folder
// path. Only one of `provider`/`fsaProvider` ever has "live" object URLs
// at a time — whichever load function runs disposes the OTHER one first
// (see loadFiles/loadFromFsaHandle below), since only one media set is
// ever actually loaded into the app at once.
const fsaProvider = new FsaFileProvider();
const remoteProvider = new RemoteUrlProvider();
const profile = new ProfileStore();
// [MEDIA-ID / STAGE-02 / LOCAL-PROJECTION]
// [WHY: constructed immediately beside `profile` and handed to MediaRuntime
//  below, because the runtime and the render sites in this file MUST read the
//  same answer. Some code stamps item.isFavorite/isHidden/userTags onto the
//  MediaItem; other code reads the store live at render time. Routing only one
//  of those through the projection would make the heart button and the grid
//  disagree with each other. `profile` itself stays the writer and the owner of
//  everything that is not per-item curation (profiles, tags vocabulary,
//  import/export, associations) — this facade deliberately does not wrap those.]
const profileView = createProfileProjectionView({ profile });
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
// [SYNCV3 / STAGE-09 / SELF-WRITE-SUPPRESSION]
// [WHY: Stage 07's intentional association write emits before its local
// Library projection is refreshed. Keep that ordering race in one ephemeral
// coordinator so the future ambient observer cannot turn our own click into a
// remote-change prompt. Closing an intent schedules a fresh authoritative read;
// a genuinely different remote fact that landed during the window is therefore
// delayed, never discarded.]
const associationWriteSuppression = createAssociationWriteSuppression({
  onIntentClosed: () => refreshCurrentAssociationFromRegistry().catch(() => undefined),
});
const ambientProfileObserver = createAmbientProfileObserver({
  loadDecision: loadAmbientProfileDecision,
  deleteDecision: deleteAmbientProfileDecision,
});
// [MEDIA-ID / STAGE-02 / LOCAL-PROJECTION]
// The runtime uses exactly subscribe/isFavorite/isHidden/toggleFavorite/
// toggleHidden, all of which the projection view implements, so media-runtime.js
// is unmodified by this stage.
const runtime = new MediaRuntime({ profile: profileView });

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
const remoteStatusText = document.getElementById("remote-status-text");
const cassetteAddBtn = document.getElementById("cassette-add-btn");
const remoteCassettesEl = document.getElementById("remote-cassettes");
const fsaAssociateBtn = document.getElementById("fsa-associate-btn");
const fsaAssociateBtnLabel = document.getElementById("fsa-associate-btn-label");
const fsaAssociateHelp = document.getElementById("fsa-associate-help");
const intervalInput = document.getElementById("interval-input");
const intervalDecreaseBtn = document.getElementById("interval-decrease-btn");
const intervalIncreaseBtn = document.getElementById("interval-increase-btn");
const shuffleInput = document.getElementById("shuffle-input");
const arcadeAnimationOrderSelect = document.getElementById("arcade-animation-order-select");
const arcadeAnimationOrderHelper = document.getElementById("arcade-animation-order-helper");
// [STARTUP-MEDIA / N6-4] [STREAMLOOP-INTEGRATION / N6-6] [STREAMLOOP-INTEGRATION / N6-9]
// Two independent control groups — one per launch context. Keyed by the same
// "browser" | "streamloop" strings app-preferences.js's saveStartupPreferences()
// and normalizeStartupContexts() use, so a context string can be passed
// straight through without translation at any layer. Since N6-9, each
// context's ENTIRE startup+post-load configuration lives together in that
// context's own Advanced disclosure (Startup Media for browser, StreamLoop
// Integration for streamloop) — so each group now also owns its own Auto
// Fill checkbox/helper, not a separate top-level control.
const startupMediaControls = {
  browser: {
    policySelect: document.getElementById("startup-media-browser-policy-select"),
    policyHelper: document.getElementById("startup-media-browser-policy-helper"),
    eligibleSection: document.getElementById("startup-media-browser-eligible-section"),
    eligibleEmpty: document.getElementById("startup-media-browser-eligible-empty"),
    eligibleList: document.getElementById("startup-media-browser-eligible-list"),
    autoFillInput: document.getElementById("startup-media-browser-auto-fill-panel-input"),
    autoFillHelper: document.getElementById("startup-media-browser-auto-fill-helper"),
  },
  streamloop: {
    policySelect: document.getElementById("startup-media-streamloop-policy-select"),
    policyHelper: document.getElementById("startup-media-streamloop-policy-helper"),
    eligibleSection: document.getElementById("startup-media-streamloop-eligible-section"),
    eligibleEmpty: document.getElementById("startup-media-streamloop-eligible-empty"),
    eligibleList: document.getElementById("startup-media-streamloop-eligible-list"),
    autoFillInput: document.getElementById("streamloop-auto-fill-panel-input"),
    autoFillHelper: document.getElementById("streamloop-auto-fill-helper"),
  },
};
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
const profileMediaFolderControls = document.getElementById("profile-media-folder-controls");
const profileActiveGroup = document.getElementById("profile-active-group");
// [UI-REDESIGN / STAGE 6] [TAGS-PROFILE-ADMIN] [PROFILE-TAGS-DISCLOSURE]
const tagsAdminSectionDetails = document.querySelector(".tags-admin-section");
const profileAssociateBtn = document.getElementById("profile-associate-btn");
const profileLibraryAssociationText = document.getElementById("profile-library-association-text");
const profileAssociationRow = document.getElementById("profile-association-row");
const profileAssociationSelect = document.getElementById("profile-association-select");
const profileAssociationSaveBtn = document.getElementById("profile-association-save-btn");
const profileAssociationCancelBtn = document.getElementById("profile-association-cancel-btn");
const profileAssociationResult = document.getElementById("profile-association-result");
const ambientProfileOffer = document.getElementById("ambient-profile-offer");
const ambientProfileOfferText = document.getElementById("ambient-profile-offer-text");
const ambientProfileOfferYes = document.getElementById("ambient-profile-offer-yes");
const ambientProfileOfferNo = document.getElementById("ambient-profile-offer-no");
const ambientProfileOfferLater = document.getElementById("ambient-profile-offer-later");
const ambientProfileOfferClose = document.getElementById("ambient-profile-offer-close");
const ambientProfileOfferResult = document.getElementById("ambient-profile-offer-result");
const reverseCurationOffer = document.getElementById("reverse-curation-offer");
const reverseCurationOfferText = document.getElementById("reverse-curation-offer-text");
const reverseCurationOfferYes = document.getElementById("reverse-curation-offer-yes");
const reverseCurationOfferNo = document.getElementById("reverse-curation-offer-no");
const reverseCurationOfferResult = document.getElementById("reverse-curation-offer-result");
const deviceAwareMediaQuestion = document.getElementById("device-aware-media-question");
const deviceAwareMediaQuestionText = document.getElementById("device-aware-media-question-text");
const deviceAwareMediaQuestionYes = document.getElementById("device-aware-media-question-yes");
const deviceAwareMediaQuestionNo = document.getElementById("device-aware-media-question-no");
const deviceAwareMediaQuestionResult = document.getElementById("device-aware-media-question-result");
const profileFolderLinkSummary = document.getElementById("profile-folder-link-summary");
const profileMediaSource = document.getElementById("profile-media-source");
const profileFolderLinkAdvancedSummary = document.getElementById("profile-folder-link-advanced-summary");
const profileFolderLinkBtn = document.getElementById("profile-folder-link-btn");
const profileFolderActionHelp = document.getElementById("profile-folder-action-help");
const profileFolderLinkHelp = document.getElementById("profile-folder-link-help");
const profileFolderLinkRow = document.getElementById("profile-folder-link-row");
const profileFolderLinkSelect = document.getElementById("profile-folder-link-select");
const profileFolderLinkSaveBtn = document.getElementById("profile-folder-link-save-btn");
const profileFolderUnlinkBtn = document.getElementById("profile-folder-unlink-btn");
const profileFolderUnlinkHelp = document.getElementById("profile-folder-unlink-help");
const profileFolderLinkCancelBtn = document.getElementById("profile-folder-link-cancel-btn");
const profileFolderLinkConflict = document.getElementById("profile-folder-link-conflict");
const profileFolderLinkConflictHeading = document.getElementById("profile-folder-link-conflict-heading");
const profileFolderLinkConflictDetail = document.getElementById("profile-folder-link-conflict-detail");
const profileFolderLinkConflictAction = document.getElementById("profile-folder-link-conflict-action");
const profileFolderLinkResult = document.getElementById("profile-folder-link-result");
const profileFolderNewLibraryRow = document.getElementById("profile-folder-new-library-row");
const profileFolderNewLibraryInput = document.getElementById("profile-folder-new-library-input");
const profileFolderLibrarySyncHint = document.getElementById("profile-folder-library-sync-hint");
const profileFolderLibrarySyncBtn = document.getElementById("profile-folder-library-sync-btn");
const profileSyncGroup = document.getElementById("profile-sync-group");
const profileMediaFolderContextHelp = document.getElementById("profile-media-folder-context-help");
const profileMediaLibraryContextHelp = document.getElementById("profile-media-library-context-help");
const profileActiveContextHelp = document.getElementById("profile-active-context-help");
const profileSyncContextHelp = document.getElementById("profile-sync-context-help");
const profileSyncMediaSafety = document.getElementById("profile-sync-media-safety");
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
const profileSyncIntro = document.getElementById("profile-sync-intro");
const profileSyncIntroProgress = document.getElementById("profile-sync-intro-progress");
const profileSyncIntroTitle = document.getElementById("profile-sync-intro-title");
const profileSyncIntroBody = document.getElementById("profile-sync-intro-body");
const profileSyncIntroBack = document.getElementById("profile-sync-intro-back");
const profileSyncIntroNext = document.getElementById("profile-sync-intro-next");
const profileSyncIntroDone = document.getElementById("profile-sync-intro-done");
const profileSyncIntroSkip = document.getElementById("profile-sync-intro-skip");
const profileSyncIntroClose = document.getElementById("profile-sync-intro-close");
const profileSyncHelpBtn = document.getElementById("profile-sync-help-btn");

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
// [SYNCV3 / STAGE-06 / SCAFFOLDING-CLEANUP] Advanced diagnostic output and
// mode-generation controls retained separately from the product Sync surface.
const profileSyncV3StatusText = document.getElementById("profile-sync-v3-status-text");
// [SYNCV3 / STAGE-05 / DEVICE-NAMING] Temporary bridge control — see the panel
// comment in index.html for why this is deliberately minimal.
const profileSyncV3DeviceNameInput = document.getElementById("profile-sync-v3-device-name");
const profileSyncV3DeviceNameSaveBtn = document.getElementById("profile-sync-v3-device-name-save-btn");
const profileSyncV3DeviceNameResetBtn = document.getElementById("profile-sync-v3-device-name-reset-btn");
const profileSyncV3DeviceNameStatus = document.getElementById("profile-sync-v3-device-name-status");
const profileSyncV3ChooseBtn = document.getElementById("profile-sync-v3-choose-btn");
const profileSyncV3ReconnectBtn = document.getElementById("profile-sync-v3-reconnect-btn");
const profileSyncV3ActivateBtn = document.getElementById("profile-sync-v3-activate-btn");
const profileSyncV3LeaveBtn = document.getElementById("profile-sync-v3-leave-btn");
const profileSyncV3DisconnectBtn = document.getElementById("profile-sync-v3-disconnect-btn");
const profileSyncProductStatus = document.getElementById("profile-sync-product-status");
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
// [V2-POLISH / MICRO-ARCADE-CANVAS] Was #mobile-load-ascii (a <pre> of
// fixed-width text frames). Renamed with the element when the ASCII worker
// was replaced by the pixel canvas — the old id described a medium that no
// longer exists. Nothing outside this file's animation code ever referenced
// it (verified: one capture, one CSS rule, one markup line).
const mobileLoadCanvas = document.getElementById("mobile-load-canvas");
const warmStartOverlay = document.getElementById("warm-start-overlay");
const warmStartCanvas = document.getElementById("warm-start-canvas");
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
// [PM-TOOLBAR-OPACITY] `ghost-*` ids/vars are the pre-existing implementation
// — its customer-facing label is "Toolbar Opacity" now (see the <label> in
// index.html), but the id/storage-field names stay "ghost" deliberately:
// this mechanism predates the rename and already governed the correct
// resting-opacity behavior, so nothing about its storage path or internal
// naming changed, only what the customer reads on screen.
const ghostOpacityInput = document.getElementById("ghost-opacity-input");
const ghostOpacityLabel = document.getElementById("ghost-opacity-label");
const ghostRememberInput = document.getElementById("ghost-remember-input");
// Hover Opacity — the new sibling preference that replaces the old
// hardcoded 100% hover state (see the mouseenter listener below).
const hoverOpacityInput = document.getElementById("hover-opacity-input");
const hoverOpacityLabel = document.getElementById("hover-opacity-label");
const hoverRememberInput = document.getElementById("hover-remember-input");
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
// [PM-SHUFFLE-FOLDERS] The one-shot 🎲 action inside that same tray — see
// shuffleToAnotherRememberedFolder() below for why it is an ACTION and not
// an automation, and index.html's comment on this element for why it is not
// media-gated the way Loop/🤖 are.
const overlayShuffleFoldersBtn = document.getElementById("overlay-shuffle-folders-btn");

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

let profileSyncIntroState = createContextualFirstUseState();
let profileSyncIntroPreferencesReady = false;
let pendingIntentionalProfileSyncEntry = false;
let contextualHelpActiveEntry = null;
let syncContextHelpDefaultVisible = false;
let dismissedAssociationHelpKey = null;

// The full Stage 10 language remains background product knowledge. Settings
// renders only the short sentence belonging to the focused concept; this
// object is not itself a customer-facing destination.
const PROFILE_SYNC_BACKGROUND_GLOSSARY = Object.freeze({
  mediaFolder: "Where Browser Gallery opens your photos and videos from. Choose a Media Folder on this device or a Google Drive Media Folder. Browser Gallery does not upload, move or copy what is inside it.",
  mediaLibrary: "A Media Library is Browser Gallery's name for one collection of photos and videos. If that collection appears through different Media Folders across your devices, choose the same Media Library for each one. That tells Browser Gallery they represent the same collection, and which Favorites, Hidden items and Tags belong with it. Use the same Media Library only for Media Folders that show the same collection of photos and videos. Different collections use different Media Libraries. Choosing a Media Library does not create or change a folder. Nothing is copied, moved, combined or uploaded.",
  curation: "As you browse, you can mark Favorites, hide items and add Tags. One saved set of those choices is a Curation. Create different Curations for different people, purposes, or ways of organizing your media.",
  activeCuration: "The Curation this device is using right now. Its Favorites, Hidden items and Tags are the ones Browser Gallery uses while you browse your media. Each of your devices can use a different Curation. When you open a Media Library, Browser Gallery may switch to the Curation that Media Library remembers, or ask you first.",
  libraryCuration: "The Curation Browser Gallery remembers for this Media Library. It is the Favorites, Hidden items and Tags that belong with that collection. If another of your devices opens the same Media Library, Browser Gallery can ask whether to use that Curation there too.",
  sync: "Sync makes your Favorites, Hidden items and Tags available on your other devices. Connect each device you want to use to the same Google Drive Sync Folder. A Google Drive Sync Folder stores Browser Gallery information only. It is separate from a Google Drive Media Folder and does not contain your photos and videos.",
});

function glossaryExcerpt(key, sentenceCount) {
  const excerpt = PROFILE_SYNC_BACKGROUND_GLOSSARY[key].split(". ").slice(0, sentenceCount).join(". ");
  return excerpt.endsWith(".") ? excerpt : `${excerpt}.`;
}

document.getElementById("profile-media-folder-help").textContent = glossaryExcerpt("mediaFolder", 1);
profileFolderLinkHelp.textContent = glossaryExcerpt("mediaLibrary", 2);
profileActiveContextHelp.querySelector("p").textContent = glossaryExcerpt("activeCuration", 2);
profileSyncMediaSafety.textContent = glossaryExcerpt("sync", 2);

function associationHelpKey(associationUi) {
  return [
    currentSourceKind,
    activeCassetteRecord?.id || activeLibraryRecord?.id || "session",
    associationUi.state,
    associationUi.associatedProfileId || "none",
  ].join(":");
}

// [SYNCV3 / STAGE-10 / SETTINGS-COMPRESSION]
// BREADCRUMBS — IS: one focus-driven explainer may appear at the end of its
//   group; warnings, conflicts and an unsaved Media Library choice keep it.
// BREADCRUMBS — WAS: the same teaching copy occupied every healthy steady state.
// BREADCRUMBS — WILL BE / FUTURE: onboarding may replace this in Stage 11; do not turn
//   this presentation controller into a second product-state authority.
const contextualHelpEntries = [
  {
    group: profileMediaFolderControls,
    block: profileMediaFolderContextHelp,
    toneElement: profileFolderLinkSummary,
    hasPendingChange: () => false,
    hasConflict: () => false,
  },
  {
    group: profileFolderLinkRow,
    block: profileMediaLibraryContextHelp,
    toneElement: profileFolderLinkSummary,
    hasPendingChange: () => !profileFolderLinkSaveBtn.classList.contains("hidden"),
    hasConflict: () => !profileFolderLinkConflict.classList.contains("hidden"),
  },
  {
    group: profileActiveGroup,
    block: profileActiveContextHelp,
    toneElement: null,
    hasPendingChange: () => false,
    hasConflict: () => false,
  },
  {
    group: profileSyncGroup,
    block: profileSyncContextHelp,
    toneElement: profileSyncProductStatus,
    hasPendingChange: () => false,
    hasConflict: () => false,
  },
];

function contextualHelpHasWarning(entry) {
  return Boolean(entry.toneElement && (
    entry.toneElement.classList.contains("product-status-warning") ||
    entry.toneElement.classList.contains("product-status-danger")
  ));
}

function contextualHelpIsSticky(entry) {
  return entry.hasPendingChange() || contextualHelpHasWarning(entry) || entry.hasConflict();
}

function renderContextualHelp(requestedEntry = contextualHelpActiveEntry) {
  if (profileSyncIntroState.visible) {
    contextualHelpEntries.forEach((entry) => entry.block.classList.add("hidden"));
    return;
  }
  const visibleEntry = requestedEntry || (syncContextHelpDefaultVisible ? contextualHelpEntries[3] : null);
  contextualHelpEntries.forEach((entry) => entry.block.classList.toggle("hidden", entry !== visibleEntry));
}

function revealContextualHelp(entry) {
  contextualHelpActiveEntry = entry;
  renderContextualHelp(entry);
}

function retreatContextualHelp(entry) {
  if (contextualHelpActiveEntry !== entry || contextualHelpIsSticky(entry)) {
    renderContextualHelp();
    return;
  }
  contextualHelpActiveEntry = null;
  renderContextualHelp();
}

function refreshContextualHelpAfterRender(entry) {
  if (contextualHelpIsSticky(entry)) contextualHelpActiveEntry = entry;
  else if (contextualHelpActiveEntry === entry && !entry.group.contains(document.activeElement)) {
    contextualHelpActiveEntry = null;
  }
  renderContextualHelp();
}

contextualHelpEntries.forEach((entry) => {
  entry.group.addEventListener("focusin", () => revealContextualHelp(entry));
  entry.group.addEventListener("change", () => revealContextualHelp(entry));
  entry.group.addEventListener("focusout", (event) => {
    if (event.relatedTarget && entry.group.contains(event.relatedTarget)) return;
    queueMicrotask(() => {
      if (!entry.group.contains(document.activeElement)) retreatContextualHelp(entry);
    });
  });
});

function renderProfileSyncIntroduction() {
  const step = PROFILE_SYNC_INTRO_STEPS[profileSyncIntroState.stepIndex];
  profileSyncIntro.classList.toggle("hidden", !profileSyncIntroState.visible);
  profileSyncIntroProgress.textContent = `Step ${profileSyncIntroState.stepIndex + 1} of ${PROFILE_SYNC_INTRO_STEPS.length}`;
  profileSyncIntroTitle.textContent = step.title;
  profileSyncIntroBody.textContent = step.body;
  profileSyncIntro.dataset.helpConcepts = step.concepts.join(" ");
  // [SYNCV3 / STAGE-10 / FINAL-UX-POLISH]
  // [WHY: which actions the step offers is now derived by the same pure model
  // that owns the steps, so the approved Back / Skip Intro / forward pattern
  // cannot drift here. This function still only applies that result.]
  const actions = describeContextualFirstUseActions(profileSyncIntroState);
  profileSyncIntroBack.classList.toggle("hidden", !actions.back);
  profileSyncIntroSkip.classList.toggle("hidden", !actions.skip);
  profileSyncIntroClose.classList.toggle("hidden", !actions.close);
  profileSyncIntroNext.classList.toggle("hidden", !actions.next);
  profileSyncIntroDone.classList.toggle("hidden", !actions.done);
  renderContextualHelp();
}

function dispatchProfileSyncIntroduction(event) {
  const transition = transitionContextualFirstUse(profileSyncIntroState, event);
  profileSyncIntroState = transition.state;
  renderProfileSyncIntroduction();
  if (transition.effect === "persist-seen") {
    // The in-memory state remains seen even if this device-local write fails;
    // a later reload may offer the introduction again instead of falsely
    // claiming the durable preference was saved.
    saveOnboardingPreferences({ profileSyncIntroSeen: true });
  }
}

function handleIntentionalProfileSyncEntry() {
  if (!profileSyncIntroPreferencesReady) {
    pendingIntentionalProfileSyncEntry = true;
    return;
  }
  dispatchProfileSyncIntroduction({ type: "enter-profile-sync", intentional: true });
}

// [SYNCV3 / STAGE-10 / CONTEXTUAL-FIRST-USE]
// [WHY: the navigation caller must explicitly identify intentional Profile &
// Sync entry. Boot uses the same workspace renderer without this flag, so DOM
// existence, background refresh, and automatic Profile restoration can never
// consume or display the introduction.]
function initializeProfileSyncIntroduction(onboarding) {
  profileSyncIntroState = createContextualFirstUseState({
    seen: onboarding?.profileSyncIntroSeen,
  });
  profileSyncIntroPreferencesReady = true;
  renderProfileSyncIntroduction();
  if (pendingIntentionalProfileSyncEntry) {
    pendingIntentionalProfileSyncEntry = false;
    handleIntentionalProfileSyncEntry();
  }
}

function setActiveWorkspace(name, { focusTab = false, intentionalProfileSync = false } = {}) {
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

  if (target.name === "settings" && intentionalProfileSync) {
    handleIntentionalProfileSyncEntry();
  }
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
// WHY: The rail's "Choose/Change Profile for This Library" shortcut has
// always been navigation-only — it opens the Profile disclosure, scrolls to
// it, and focuses a control inside it. Now that the section sits in a
// hidden panel, both scrollIntoView() and focus() would silently do
// nothing, so the button would look dead. Same failure mode, and same fix,
// as ensureGalleryWorkspaceVisible() above.
// FUTURE: This is the ONLY sanctioned route from the rail to Profile
// management. Do not answer a future "the rail should let me switch
// profiles" request by adding a second selector to the rail.
function ensureSettingsWorkspaceVisible({ intentionalProfileSync = false } = {}) {
  if (activeWorkspace !== "settings") {
    setActiveWorkspace("settings", { intentionalProfileSync });
  } else if (intentionalProfileSync) {
    handleIntentionalProfileSyncEntry();
  }
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
    setActiveWorkspace(entry.name, { intentionalProfileSync: entry.name === "settings" });
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
    setActiveWorkspace(WORKSPACES[nextIndex].name, {
      focusTab: true,
      intentionalProfileSync: WORKSPACES[nextIndex].name === "settings",
    });
  });
});

profileSyncIntroBack.addEventListener("click", () => {
  dispatchProfileSyncIntroduction({ type: "back" });
});
profileSyncIntroNext.addEventListener("click", () => {
  dispatchProfileSyncIntroduction({ type: "next" });
});
profileSyncIntroDone.addEventListener("click", () => {
  dispatchProfileSyncIntroduction({ type: "done" });
});
profileSyncIntroClose.addEventListener("click", () => {
  // [SYNCV3 / STAGE-10 / REPLAY-CLOSE]
  // [WHY: Close shares the skip/done hide path exactly so a replay — where seen
  // is already true — can never produce a persist effect or reset the
  // device-local preference.]
  dispatchProfileSyncIntroduction({ type: "close" });
});
profileSyncIntroSkip.addEventListener("click", () => {
  dispatchProfileSyncIntroduction({ type: "skip" });
});
profileSyncHelpBtn.addEventListener("click", () => {
  // [WHY: replay deliberately does not alter profileSyncIntroSeen. It is a
  // manual view of the same material, never a request to auto-open it again.]
  dispatchProfileSyncIntroduction({ type: "replay" });
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
let currentSessionIsUrlBacked = false;
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
let activeCassetteRecord = null;
let activeCassetteCurationId = null;
// [SYNCV3 / STAGE-08 / LINK-STATE]
// Permission is presentation state, never identity. Losing it must leave the
// durable local row and its shared Library link untouched.
let currentFolderPermissionState = "granted";
let pendingFolderLinkClaimant = null;
// [SYNCV3 / STAGE-06 / ASSOCIATION-SUMMARY]
// Presentation-only name for a loaded legacy folder that does not have a
// registry record yet. Association truth remains entirely in the record/state
// consumed by the Stage 07 association-state adapter.
let activeLibraryDisplayName = null;

// [Phase 8.4-2] Which picker produced the currently loaded media, if any.
// This — not "FSA vs legacy" scattered across call sites — is the one
// thing association-button visibility is computed from. See
// syncAssociateButtonVisibility() below.
let currentSourceKind = "none"; // "none" | "legacy" | "fsa" | "cassette" | "cassette-folder"
// [SYNCV3 / STAGE-09 / STALE-LOAD-GUARD]
// [WHY: file loading is normally serialized by isLoadingFiles, but Clear Media
// can supersede a load while its new decision-store await is suspended. This
// monotonic token prevents that stale continuation from switching, deleting,
// or arming an offer after its Library context has gone away.]
let libraryLoadGeneration = 0;
let ambientProfileOfferRenderedKey = null;
let ambientProfileActionPending = false;
let pendingReverseCurationSuggestion = null;
let reverseCurationActionPending = false;
let pendingDeviceAwareMediaQuestion = null;
let deviceAwareMediaActionPending = false;

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
// loadFiles()). When true, the association-state adapter and Associate
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
// Looks up the DISPLAY NAME for a profileId that may or may not be the
// currently active profile — the green status row must reflect the
// LOADED LIBRARY's association, not whatever profile the user happens to
// be looking at right now (see updateAssociatedStatusRow's own comment).
function getProfileNameById(profileId) {
  if (!profileId) return null;
  const entry = profile.listProfiles().find((candidate) => candidate.id === profileId);
  return entry ? entry.name : null;
}

// [SYNCV3 / STAGE-07 / ASSOCIATION-STATE]
// The only adapter from live app state into the pure S0-S5 mapper.
function getCurrentAssociationUiState() {
  const mediaName = activeCassetteRecord?.name
    || activeLibraryRecord?.name
    || activeLibraryDisplayName
    || "Loaded Media Folder";
  const usesDurableRecord =
    currentSourceKind === "fsa" || (currentSourceKind === "legacy" && legacyHasDurableIdentity);
  const sharedCatalogEntry = activeLibraryRecord?.libraryId
    ? profile.listLibraries().find((library) => library.id === activeLibraryRecord.libraryId)
    : null;
  const associatedProfileId = currentSourceKind === "cassette" || currentSourceKind === "cassette-folder"
    ? activeCassetteCurationId
    : usesDurableRecord && activeLibraryRecord
      ? sharedCatalogEntry
        ? sharedCatalogEntry.associatedProfileId
        : activeLibraryRecord.profileId
      : null;
  return mapAssociationCopy({
    sourceKind: currentSourceKind,
    legacyHasDurableIdentity,
    mediaName,
    rememberedSourceId: activeCassetteRecord?.id ? `cassette:${activeCassetteRecord.id}` : null,
    associatedProfileId,
    associatedProfileName: getProfileNameById(associatedProfileId),
    activeProfileId: profile.getProfileId(),
    activeProfileName: profile.getProfileName(),
    legacySessionAssociated,
    canWriteAssociation:
      currentSourceKind === "cassette" || currentSourceKind === "cassette-folder"
        ? Boolean(activeCassetteRecord?.id)
        : currentSourceKind === "fsa"
        ? Boolean(activeLibraryRecord && activeLibraryRecord.id)
        : Boolean(activeLibraryRecord && activeLibraryRecord.id) || Boolean(pendingLegacySignature),
  });
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
  const associationUi = getCurrentAssociationUiState();
  associatedText.textContent = associationUi.associatedText;

  // [WHY: this is the third render target of this function's existing single
  // association computation; it never reads registry or Profile state itself.]
  profileLibraryAssociationText.textContent = associationUi.productLine;
  applyProductStatusTone(profileLibraryAssociationText, associationUi.tone);
  profileMediaSource.textContent = associationUi.sourceLine;
  applyProductStatusTone(profileMediaSource, associationUi.tone);
  return associationUi;
}

// [LIBRARY-PROFILE-UX / Phase 8.5]
// WHAT: Shows/hides the Associate/Change button AND sets its label — one
// button, "Choose Profile for This Library" when the current load has no
// Profile, "Change Profile for This Library" once it does (see the button's own HTML
// comment for why this is deliberately one element, not two). Also
// refreshes the green Associated: row every time, since both are driven
// by the exact same underlying state.
// WHY: Consolidates every place that used to independently decide
// "hidden or not" into one call, so the button and the status row can
// never disagree with each other.
// FUTURE: New source kinds belong in the single Stage 07 mapper adapter above.
function syncAssociateButtonVisibility() {
  const associationUi = updateAssociatedStatusRow();
  // [NORTH-STAR / N3-2 / CURATION-UI-COMPRESSION]
  // S2 means the remembered folder Curation and active local Curation already
  // agree. Keep both states internally, but do not make the customer inspect a
  // duplicate selector. S3 and every unresolved state still surface the local
  // choice because a real decision may depend on the distinction.
  profileActiveGroup.classList.toggle("hidden", !shouldShowActiveCurationChoice(associationUi));
  const shouldShow = associationUi.showAction;
  fsaAssociateBtn.classList.toggle("hidden", !shouldShow);
  fsaAssociateBtn.disabled = !shouldShow;
  profileAssociateBtn.classList.toggle("hidden", !shouldShow);
  profileAssociateBtn.disabled = !shouldShow;
  if (shouldShow) {
    // [SYNCV3 / STAGE-10 / FINAL-CLOSEOUT-POLISH]
    // [WHY: the rail card already names the concept in its own label directly
    // above this button, so the button says only what pressing it does. That
    // also retires the hard-coded line break the long label needed to wrap
    // tidily in the rail — a short label wraps on its own or not at all.]
    fsaAssociateBtnLabel.textContent = ["S2", "S3"].includes(associationUi.state)
      ? "Change Curation"
      : "Choose a Curation";
    profileAssociateBtn.textContent = associationUi.actionLabel;
  } else if (!profileAssociationRow.classList.contains("hidden")) {
    profileAssociationRow.classList.add("hidden");
    profileAssociateBtn.setAttribute("aria-expanded", "false");
  }
  // [SYNCV3 / STAGE-10 / FINAL-CLOSEOUT-POLISH]
  // [WHY: the benefit line follows the action's own availability — there is no
  // point explaining a control that is not being offered. Copy is owned by the
  // pure mapper beside actionLabel; this only applies it.]
  const actionHelpIsCurrent = dismissedAssociationHelpKey !== associationHelpKey(associationUi);
  fsaAssociateHelp.textContent = shouldShow && actionHelpIsCurrent ? (associationUi.actionHelp || "") : "";
  fsaAssociateHelp.classList.toggle("hidden", !shouldShow || !associationUi.actionHelp || !actionHelpIsCurrent);
  // [UI-REDESIGN / Stage 6] Ordered after updateAssociatedStatusRow() on
  // purpose — the compact header mirrors that function's output, so it must
  // read the row only once the row is current.
  syncMobileContextSummary();
  renderFolderLinkState();
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
  ensureSettingsWorkspaceVisible({ intentionalProfileSync: true });
  if (profileSectionDetails && !profileSectionDetails.open) {
    profileSectionDetails.open = true;
  }
  profileSectionDetails?.scrollIntoView({ behavior: "smooth", block: "start" });
  syncAssociateButtonVisibility();
  if (pendingLibraryAssociationIntent) {
    pendingLibraryAssociationIntent = false;
    openAssociationEditor();
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

// [REMOTE-CASSETTE / PHASE 1C]
// BREADCRUMBS - WAS
// Before remote media existed, mounted media came from local File-backed
// sources and object URLs. buildViewer() and mountThumbMedia() assigned media
// sources without observing load success or failure because failure was
// effectively outside the normal local model.
//
// BREADCRUMBS - IS
// Media addresses can now originate outside the machine, so mounting is an
// attempt rather than a certainty. This shared rendering seam observes outcomes
// source-neutrally and counts success/failure; it does not retry, substitute,
// reorder, or remove. A failed current item receives one human sentence while
// the overall session continues: one bad item must not destroy the session.
//
// BREADCRUMBS - WILL BE
// Remote .ts remains excluded upstream, with that invariant frozen by provider
// tests. ts-playback-adapter.js stays untouched because the remote TS path is
// structurally unreachable. Outcome counts remain console-only until real
// evidence justifies user-facing failure counts; no failure taxonomy is encoded
// yet. No retry, proxy, header, or cookie solution exists yet because those
// belong to later evidence-driven architecture. Load timings exist only to
// inform a future optimization decision; this stage must not pre-optimize.
let mediaRenderOutcomes = { mounted: 0, loaded: 0, failed: 0 };
let mediaRenderOutcomeTimer = null;

function resetMediaRenderOutcomes() {
  if (mediaRenderOutcomeTimer !== null) clearTimeout(mediaRenderOutcomeTimer);
  mediaRenderOutcomeTimer = null;
  mediaRenderOutcomes = { mounted: 0, loaded: 0, failed: 0 };
}

function recordMediaRenderOutcome(outcome) {
  mediaRenderOutcomes[outcome] += 1;
  if (mediaRenderOutcomeTimer !== null) clearTimeout(mediaRenderOutcomeTimer);
  mediaRenderOutcomeTimer = setTimeout(() => {
    console.info("[MEDIA RENDER] Outcomes", { ...mediaRenderOutcomes });
    mediaRenderOutcomeTimer = null;
  }, 1000);
}

// [PRESENTATION-PERF / PHASE 3A]
//
// BREADCRUMBS - WAS
// buildViewer() tore down the outgoing media unconditionally — clearViewerNode()
// empties #viewer-stage — before creating the incoming element, so the stage was
// empty for the whole of the resource wait. That was invisible while every
// source was a local blob: URL, and became the dominant customer-visible defect
// once media addresses started originating off-machine: 25 real manual-Next
// transitions through a Remote Cassette measured a ~4.65 s MEDIAN blank gap
// against a ~0.8 ms median application dispatch. The application was never slow;
// it was showing black while it waited.
//
// BREADCRUMBS - IS
// For an image following an image, the outgoing frame is HELD on screen while
// the incoming image loads and (best-effort) decodes. Teardown and insertion
// then happen in one synchronous block, so no empty stage is ever painted. A
// prepared node may commit only if its token, load generation, gallery
// generation and item identity ALL still match — otherwise it is discarded in
// silence (see runtime/viewer-commit.js). The path is advisory: any failure
// converges onto the pre-existing eager path and Phase 1C's "This item could not
// be loaded." It is source-neutral — a blob: URL and an https: URL take the
// identical route, and nothing here asks where an item came from.
//
// BREADCRUMBS - WILL BE
// This stage deliberately does NOT predict what comes next: no lookahead, no
// ready queue, no second RNG, and MediaRuntime remains untouched. Evidence shows
// resource readiness dominates (~4.65 s median vs ~0.8 ms dispatch), so a
// planned shuffle sequence feeding a small bounded preload queue is the
// justified next step — and it must keep ONE shuffle authority inside
// MediaRuntime, with next() consuming the plan rather than any external peek
// drawing separately. The per-transition CPU costs found during the audit (the
// O(n) passes in next(), the ~4,600 gallery DOM operations, the pool-key
// stringify) are real but measured at ~0.8 ms in total: they are cleanup
// candidates, not performance work, and must not be confused for this defect.
// Video readiness is a different problem — buffering, codec init, seek state —
// and is NOT covered by this mechanism, which is why the held path is restricted
// to image-following-image.
//
// Incremented on every entry into the held path. A prepared node whose token no
// longer matches has been superseded and may never commit. Same generation-token
// discipline as libraryLoadGeneration, galleryGeneration and the providers'
// private #loadToken — stale-result rejection, never cancellation.
let viewerPreparationCounter = 0;
let currentViewerPreparationInFlight = false;

const PLAN_LENGTH = 6;
const MAX_PREPARED = 6;
const MAX_CONCURRENT_WARMING = 2;
const preparedViewerImages = new Map();
const warmingViewerImages = new Map();
const failedWarmItems = new Set();
let lastVisibleCommitAt = null;
let lastViewerTerminalItem = null;

const RELEASE_READY_COUNT = 3;
const WARM_START_MAX_MS = 10000;
let warmStartState = "inactive";
let warmStartStartedAt = 0;
let warmStartTimeoutId = null;
let warmStartCurrentVisualSettled = false;
let warmStartTimeoutReached = false;

// t0 for a transition: the moment render() began. Deliberately NOT the button
// press or the interval tick — MediaRuntime owns those and is protected, so its
// own selection work is excluded from every number below. The human's profiler
// already bounded that exclusion at ~0.8 ms median for the whole dispatch.
let lastRenderEntryAt = 0;

const PM_TRANSITION_SUMMARY_EVERY = 10;
let transitionSamples = [];
let transitionSampleGeneration = -1;
let transitionCount = 0;

function transitionHost(item) {
  try {
    return new URL(item.url).hostname;
  } catch {
    // blob: URLs have no hostname, and a malformed URL must never break a
    // measurement. Either way there is nothing to report.
    return "";
  }
}

function percentileMs(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round(fraction * (sorted.length - 1))));
  return Math.round(sorted[index]);
}

// One concise line per COMMITTED transition, plus a rolling summary. Discarded
// preparations log nothing — they are not transitions, they are answers that
// arrived too late.
//
// Counts, durations and hostname at most. Never a full remote URL and never a
// query string: a signed URL can carry a token (Part 2 Section 52).
function recordPresentationTransition(sample) {
  if (transitionSampleGeneration !== libraryLoadGeneration) {
    // Numbers from two different sources must never mix in one window.
    transitionSampleGeneration = libraryLoadGeneration;
    transitionSamples = [];
    transitionCount = 0;
  }

  transitionCount += 1;
  transitionSamples.push(sample);

  console.info("[PM TRANSITION]", {
    n: transitionCount,
    held: sample.held,
    dispatch_to_src_ms: Math.round(sample.dispatchToSrcMs),
    src_wait_ms: Math.round(sample.srcWaitMs),
    decode_ms: sample.decodeMs === null ? null : Math.round(sample.decodeMs),
    blank_ms: Math.round(sample.blankMs),
    ready_ms: Math.round(sample.readyMs),
    visible_ms: sample.visibleMs === null ? null : Math.round(sample.visibleMs),
    ready_hit: sample.readyHit,
    host: sample.host,
  });

  if (transitionSamples.length < PM_TRANSITION_SUMMARY_EVERY) return;

  const window = transitionSamples;
  transitionSamples = [];
  const srcWait = window.map((entry) => entry.srcWaitMs);
  const blank = window.map((entry) => entry.blankMs);
  const ready = window.map((entry) => entry.readyMs);
  const heldCount = window.filter((entry) => entry.held).length;
  const visible = window.map((entry) => entry.visibleMs).filter((value) => value !== null);
  const readyHitCount = window.filter((entry) => entry.readyHit).length;

  console.info("[PM TRANSITION] Summary", {
    count: window.length,
    held: `${heldCount}/${window.length}`,
    src_wait_ms: { median: percentileMs(srcWait, 0.5), p90: percentileMs(srcWait, 0.9) },
    blank_ms: { median: percentileMs(blank, 0.5), p90: percentileMs(blank, 0.9) },
    ready_ms: { median: percentileMs(ready, 0.5), p90: percentileMs(ready, 0.9) },
    visible_ms: { median: percentileMs(visible, 0.5), p90: percentileMs(visible, 0.9) },
    ready_hit_rate: `${readyHitCount}/${window.length}`,
  });
}

// Schedules the one honest readiness timestamp: the animation frame AFTER a
// loaded image is in the stage.
//
// This is a PROXY for paint, not paint. rAF fires before the frame is
// composited, so it is the closest honest observation available without
// Element Timing — do not call it, or let any report call it, "painted".
function measureTransitionReady({ held, readyHit = false, renderEntryAt, srcAt, loadAt, decodeAt, teardownAt, item, node }) {
  requestAnimationFrame(() => {
    // A rapid manual Next can replace an already-committed node before this
    // frame callback runs. That obsolete callback must not release the newer
    // transition's advance hold or restart its timer.
    if (currentViewerNode !== node || currentViewerItem !== item) return;
    const readyAt = performance.now();
    const visibleMs = lastVisibleCommitAt === null ? null : readyAt - lastVisibleCommitAt;
    lastVisibleCommitAt = readyAt;
    recordPresentationTransition({
      held,
      dispatchToSrcMs: srcAt - renderEntryAt,
      srcWaitMs: loadAt - srcAt,
      decodeMs: decodeAt === null ? null : decodeAt - loadAt,
      // The interval the customer actually spends looking at no image: from the
      // moment the outgoing content was removed to the frame after a loaded
      // image occupies the stage. On the held path teardown and insertion are
      // one synchronous block, so this collapses to roughly a single frame. On
      // the eager path it is the whole resource wait, which is the defect.
      blankMs: readyAt - teardownAt,
      readyMs: readyAt - renderEntryAt,
      visibleMs,
      readyHit,
      host: transitionHost(item),
    });
    handleCurrentViewerTerminal(item);
  });
}

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
// [V2-POLISH / MICRO-ARCADE-CANVAS] The arcade canvas draws this as its
// score-style readout. Mirrored HERE, at the one place the truthful text
// readouts are already written from the loaders' own onProgress values —
// deliberately not a second count, not a derived estimate, and read-only
// everywhere else.
let mobileLoadLoadedCount = 0;
const MOBILE_ACTIVITY_BAR_WIDTH = 10;

function renderMobileLoadProgress(primaryText, loaded, total) {
  mobileLoadPrimaryText.textContent = primaryText;
  mobileLoadHasKnownTotal = typeof total === "number" && total > 0;
  mobileLoadLoadedCount = typeof loaded === "number" && loaded > 0 ? loaded : 0;

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

// ---- [V2-POLISH / MICRO-ARCADE-CANVAS] [V2-POLISH / STARFIGHTER-PROTOTYPE] -
//      [V2-POLISH / MICRO-ARCADE-SCENE-POOL] [V2-POLISH / MICRO-ARCADE-160X64]
//
// WHAT: The approved Micro-Arcade canvas expands from 128x64 to 160x64 logical
// pixels and becomes a reusable load-session scene pool, adding Bigfoot, UFO
// File Abduction, Projector Booth, and Pirate Ship sequences while retaining
// one shared renderer/lifecycle.
// WHY: The additional horizontal space gives character, machinery, travel,
// dodging, cannon arcs, entrances and exits enough breathing room to read as
// tiny vintage game/cartoon scenes without increasing the Live Status
// takeover's vertical footprint.
// FUTURE: The pool is intentionally extensible with additional curated scenes
// such as Chomper, Asteroid Run, Frame Carrier, Scanner Build, Kaiju, Tape
// Deck, submarine/sonar and other media/arcade sequences. The same selected
// scene can later power the planned desktop left-rail Live Status takeover.
//
// [V2-POLISH / MICRO-ARCADE-CREATIVE-PACK]
// WHAT: The Micro-Arcade pool was deliberately pruned and expanded around a
// higher entertainment bar, with scene choreography delegated more heavily to
// the implementer rather than predetermined through detailed storyboards.
// WHY: The strongest scenes emerged when composition and animation served the
// idea naturally. Scene concepts now define intent and emotional territory
// while leaving framing, timing and choreography open to creative execution.
// FUTURE: Keep only scenes that are genuinely enjoyable to watch. Prefer a
// smaller pool of distinctive, high-quality micro-films over a large pool of
// merely functional animations.
//
// [V2-POLISH / MICRO-ARCADE-COMPOSITION-FIRST]
// WHAT: Micro-Arcade scenes use scene-specific framing and choreography
// rather than a mandatory close-up/reveal formula. Close perspective is used
// only where it naturally supports the action or improves readability.
// WHY: Testing showed that forced close-ups and abrupt integer-scale
// transitions can reduce scene quality even when they add sprite detail.
// Full-machine, medium, wide, or close compositions should be chosen
// according to what makes each tiny scene most readable and entertaining.
// FUTURE: New Micro-Arcade scenes should optimize for composition,
// silhouette, motion, timing and payoff rather than following a universal
// camera template.
//
// [V2-POLISH / MICRO-ARCADE-IDENTITY-FIRST] SUPERSEDED, not deleted — the
// pass is still worth knowing about because its failure is instructive. It
// staged every scene as CLOSE-UP -> RECEDE -> ACTION on the theory that a
// large sprite teaches the viewer what the small one is. That held for
// Starfighter, where the ship genuinely flies away from the camera, and it
// was wrong everywhere else: the Projector's whole appeal is seeing the
// mechanism work at once, Bigfoot's joke needs the clearing in frame, the
// Pirate's conflict needs sea and monster sharing the canvas, and the UFO's
// legibility problem was solved far better by drawing a more detailed
// saucer than by moving a camera around a coarse one. What survives from
// that pass is the detail work it produced — the 36x13 saucer, the hull gun
// ports, the arm-swing walk cycle, the off-canvas cell culling — all of
// which help at any framing.
//
// The dramatic shape scenes actually follow is ESTABLISH -> ACTION ->
// ESCALATE -> PAYOFF -> LOOP. "Establish" means make the scene
// understandable and appealing; it does not mean open on a giant sprite.
// Where apparent depth IS used, two rules still apply: recede in integer
// scale steps using the same mask, and keep apparent size monotonic across
// the transition — anything that grows mid-recede reads as a cut.
//
// ARCHITECTURE — the split that keeps this from becoming a game engine:
//   SHARED (below, then the controller at the bottom) owns the canvas, the
//   palette, the pixel-drawing toolkit, timing, scene selection, looping,
//   reduced motion, and the start/stop lifecycle.
//   EACH SCENE owns only: a duration, a still-frame moment, an optional
//   mutable state factory, an optional update, and a draw. Scenes never touch
//   the canvas element, the rAF loop, selection, or the loader.
// A scene is a plain object — no classes, no registry indirection, no scene
// graph. Adding one is appending a literal to ARCADE_SCENES.
//
// SCOPE: presentation only. Nothing here reads, writes, delays, or blocks any
// loader state. The single product value any scene displays
// (mobileLoadLoadedCount, in Starfighter's HUD) is mirrored from the same
// renderMobileLoadProgress() call the truthful text readouts already use — it
// is never computed here and never fed back.
//
// RESOLUTION: 160x64 logical, a 25% horizontal expansion at exactly the same
// height. The height is load-bearing: the takeover slot is a wide, short card
// on a 390x844 phone, and growing vertically would push the truthful text
// readouts toward the fold. Widening costs nothing vertically and is what
// gives Bigfoot somewhere to walk and the cannonball somewhere to arc.
const ARCADE_WIDTH = 160;
const ARCADE_HEIGHT = 64;
const ARCADE_FRAME_MS = 33;

// Three phosphor intensities. Level 3 is exactly the #00ff00 the Live Status
// box already uses, so the brightest pixels on the screen and the green text
// around it are literally the same colour.
const ARCADE_BG = "#03140a";
const ARCADE_INK = { 1: "#0a5c22", 2: "#00b52a", 3: "#00ff00" };

// ---- shared pixel toolkit -------------------------------------------------
//
// Sprites are authored as pixel masks: "." is transparent, "1".."3" pick a
// phosphor intensity. Shading is what gives a small shape a readable
// silhouette at 1x and still holds up blown to 5x during Starfighter's
// fly-by. `inkOverride` flattens a mask to one intensity, which is how the
// same tree/ship mask doubles as its own dim background copy.

// Cells outside the canvas are skipped rather than handed to the context to
// clip. [V2-POLISH / MICRO-ARCADE-IDENTITY-FIRST] made this worth doing: the
// close-up passes deliberately crop large sprites against the frame edge (a
// 102px bust, a 108px saucer entering from off-left), so a partially visible
// sprite is now the normal case rather than the exception, and the invisible
// half was costing a fillRect per cell per frame.
function drawArcadeSprite(ctx, sprite, left, top, scale, inkOverride) {
  for (let r = 0; r < sprite.length; r++) {
    const y = top + r * scale;
    if (y + scale <= 0 || y >= ARCADE_HEIGHT) continue;
    const row = sprite[r];
    for (let c = 0; c < row.length; c++) {
      if (row[c] === ".") continue;
      const x = left + c * scale;
      if (x + scale <= 0 || x >= ARCADE_WIDTH) continue;
      const ink = inkOverride || ARCADE_INK[row[c]];
      if (!ink) continue;
      ctx.fillStyle = ink;
      ctx.fillRect(x, y, scale, scale);
    }
  }
}

function drawArcadeSpriteCentered(ctx, sprite, cx, cy, scale, inkOverride) {
  const left = Math.round(cx - (sprite[0].length * scale) / 2);
  const top = Math.round(cy - (sprite.length * scale) / 2);
  drawArcadeSprite(ctx, sprite, left, top, scale, inkOverride);
  return { left, top };
}

// Integer Bresenham — spokes, cone edges, masts, rigging and tentacles all
// need a real line, and a shared one keeps every scene's geometry snapped to
// the same pixel grid.
function drawArcadeLine(ctx, x0, y0, x1, y1, ink) {
  ctx.fillStyle = ink;
  let x = Math.round(x0);
  let y = Math.round(y0);
  const ex = Math.round(x1);
  const ey = Math.round(y1);
  const dx = Math.abs(ex - x);
  const dy = -Math.abs(ey - y);
  const sx = x < ex ? 1 : -1;
  const sy = y < ey ? 1 : -1;
  let err = dx + dy;
  for (let guard = 0; guard < 400; guard++) {
    ctx.fillRect(x, y, 1, 1);
    if (x === ex && y === ey) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
}

// Midpoint circle outline — projector reels and sonar-style ripples.
function drawArcadeCircle(ctx, cx, cy, radius, ink) {
  ctx.fillStyle = ink;
  let x = radius;
  let y = 0;
  let err = 1 - radius;
  while (x >= y) {
    const pts = [
      [cx + x, cy + y],
      [cx + y, cy + x],
      [cx - y, cy + x],
      [cx - x, cy + y],
      [cx - x, cy - y],
      [cx - y, cy - x],
      [cx + y, cy - x],
      [cx + x, cy - y],
    ];
    for (const [px, py] of pts) ctx.fillRect(Math.round(px), Math.round(py), 1, 1);
    y += 1;
    if (err < 0) {
      err += 2 * y + 1;
    } else {
      x -= 1;
      err += 2 * (y - x) + 1;
    }
  }
}

// [t, value] waypoints, linearly interpolated and clamped at both ends. Every
// scene's scripted motion goes through this rather than each inventing its
// own easing — Starfighter's cruise, the pirate ship's sail-in, the UFO's
// approach.
function arcadePath(waypoints, t) {
  if (t <= waypoints[0][0]) return waypoints[0][1];
  for (let i = 1; i < waypoints.length; i++) {
    if (t <= waypoints[i][0]) {
      const [t0, v0] = waypoints[i - 1];
      const [t1, v1] = waypoints[i];
      return v0 + (v1 - v0) * ((t - t0) / (t1 - t0));
    }
  }
  return waypoints[waypoints.length - 1][1];
}

function easeInOutCubic(p) {
  return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
}

function arcadeClamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// 3x5 arcade digits for Starfighter's score-style readout.
const ARCADE_DIGITS = {
  0: ["111", "1.1", "1.1", "1.1", "111"],
  1: [".1.", "11.", ".1.", ".1.", "111"],
  2: ["111", "..1", "111", "1..", "111"],
  3: ["111", "..1", "111", "..1", "111"],
  4: ["1.1", "1.1", "111", "..1", "..1"],
  5: ["111", "1..", "111", "..1", "111"],
  6: ["111", "1..", "111", "1.1", "111"],
  7: ["111", "..1", "..1", "..1", "..1"],
  8: ["111", "1.1", "111", "1.1", "111"],
  9: ["111", "1.1", "111", "..1", "111"],
};

function drawArcadeNumber(ctx, value, left, top, ink) {
  const text = String(value);
  ctx.fillStyle = ink;
  for (let i = 0; i < text.length; i++) {
    const glyph = ARCADE_DIGITS[text[i]];
    if (!glyph) continue;
    for (let r = 0; r < glyph.length; r++) {
      for (let c = 0; c < 3; c++) {
        if (glyph[r][c] === "1") ctx.fillRect(left + i * 4 + c, top + r, 1, 1);
      }
    }
  }
}

// Expanding chunky ring plus a bright core for the first third — pixel
// clusters rather than a circle, so it stays legible at this resolution.
// Shared by Starfighter's kills and the pirate cannon's impact.
const ARCADE_BURST_MS = 420;

function drawArcadeBurst(ctx, burst, now, lifeMs) {
  const age = (now - burst.born) / (lifeMs || ARCADE_BURST_MS);
  if (age < 0 || age >= 1) return;
  const radius = 1 + age * (burst.reach || 9);
  if (age < 0.35) {
    ctx.fillStyle = ARCADE_INK[3];
    ctx.fillRect(Math.round(burst.x) - 2, Math.round(burst.y) - 2, 4, 4);
  }
  ctx.fillStyle = age < 0.6 ? ARCADE_INK[3] : ARCADE_INK[2];
  const size = age < 0.5 ? 2 : 1;
  for (let i = 0; i < 10; i++) {
    const angle = (i / 10) * Math.PI * 2 + burst.seed;
    ctx.fillRect(
      Math.round(burst.x + Math.cos(angle) * radius),
      Math.round(burst.y + Math.sin(angle) * radius * 0.8),
      size,
      size
    );
  }
  if (age > 0.45) {
    ctx.fillStyle = ARCADE_INK[1];
    for (let i = 0; i < 6; i++) {
      const angle = (i / 6) * Math.PI * 2 - burst.seed;
      ctx.fillRect(
        Math.round(burst.x + Math.cos(angle) * radius * 0.55),
        Math.round(burst.y + Math.sin(angle) * radius * 0.45),
        1,
        1
      );
    }
  }
}

// ---- SCENE 1: starfighter -------------------------------------------------
//
// [V2-POLISH / STARFIGHTER-FLAGSHIP]
// WHAT: The original Starfighter Micro-Arcade prototype was expanded into a
// longer authored cinematic dogfight with richer spacecraft detail, multiple
// combat beats, enemy variation, environmental hazards, a distinct climax,
// and an integrated return-to-camera loop.
// WHY: Starfighter naturally supports near-to-far perspective because
// physical recession is part of the scene itself. The expanded timeline
// gives the battle enough space to read clearly and avoids excessive
// repetition during real library loads.
// FUTURE: Treat Starfighter as a quality benchmark for action-oriented
// Micro-Arcade scenes: readable silhouettes, composition-driven perspective,
// meaningful choreography, distinct escalation and payoff, and no
// unnecessary gameplay architecture.
//
// HOW THE NEAR->FAR TRANSITION AVOIDS SCALE POPPING — the quality gate of
// this rebuild. Three things, together:
//   1. FIVE authored sizes, not integer scaling of one mask. Every size is
//      generated from ONE shared profile by buildFighterMask(), so the
//      silhouette — nose, canopy, swept delta, wingtip lights, twin engine
//      cores — is provably identical at every distance. The eye tracks the
//      shape, so the shape must not change.
//   2. Gentle ratios. 73 -> 49 -> 33 -> 23 -> 15 px is about x0.67 per step,
//      versus the old 75 -> 15 in three violent jumps. Each step is near the
//      threshold where a size change reads as distance rather than as a cut.
//   3. Every step is COVERED by motion: the ship is translating and banking
//      through the swap, the engine plume shortens with distance, and the
//      starfield streaks hardest exactly across the transition. A size
//      change the viewer is not looking at is a size change they do not see.
const SF_DURATION_MS = 28000;

// One profile, five distances. `bank` squeezes one half-span and stretches
// the other, which changes the SILHOUETTE rather than just sliding the
// sprite — a banking ship has to look banked, not merely displaced.
function buildFighterMask(w, h, bank) {
  const width = 2 * w + 1;
  const cx = w;
  const g = Array.from({ length: h }, () => new Array(width).fill("."));
  const put = (r, c, ch) => {
    if (r >= 0 && r < h && c >= 0 && c < width) g[r][c] = ch;
  };

  for (let r = 0; r < h; r++) {
    const p = r / (h - 1);
    const fus = Math.max(0, Math.round(w * (0.08 + 0.26 * Math.min(1, p * 2.4))));
    let wing = 0;
    if (p >= 0.4 && p <= 0.86) {
      const wp = (p - 0.4) / 0.46;
      wing = Math.round(w * (0.3 + 0.7 * Math.min(1, wp * 1.6)));
      if (wp > 0.72) wing = Math.round(wing * (1 - (wp - 0.72) * 2));
    }
    const half = Math.max(fus, wing);
    const lh = Math.max(0, Math.round(half * (bank > 0 ? 0.62 : 1)));
    const rh = Math.max(0, Math.round(half * (bank < 0 ? 0.62 : 1)));
    for (let c = cx - lh; c <= cx + rh; c++) put(r, c, "2");
  }

  // Canopy — the single brightest mass, and the cue that reads as "cockpit"
  // even when the whole ship is 15px wide.
  for (let r = Math.round(h * 0.18); r <= Math.round(h * 0.36); r++) {
    const cw = Math.max(0, Math.round(w * 0.1));
    for (let c = cx - cw; c <= cx + cw; c++) put(r, c, "3");
  }
  put(0, cx, "3");

  // Twin engine cores.
  const eRow = h - Math.max(1, Math.round(h * 0.12)) - 1;
  const eOff = Math.max(1, Math.round(w * 0.22));
  for (let d = 0; d <= Math.max(0, Math.round(h * 0.06)); d++) {
    put(eRow + d, cx - eOff, "3");
    put(eRow + d, cx + eOff, "3");
  }

  // Wingtip navigation lights.
  for (let r = 0; r < h; r++) {
    const p = r / (h - 1);
    if (p <= 0.62 || p >= 0.72) continue;
    const row = g[r];
    const lit = row.indexOf("2");
    if (lit < 0) continue;
    let rit = width - 1;
    while (rit > 0 && row[rit] === ".") rit -= 1;
    put(r, lit, "3");
    put(r, rit, "3");
  }

  return { mask: g.map((r) => r.join("")), engineOff: eOff, w, h };
}

// XL is the close pass; S is the combat size. The two intermediate steps
// exist purely so no single change in apparent size is large enough to read
// as a cut.
const SF_XL = buildFighterMask(36, 35, 0);
const SF_L = buildFighterMask(24, 25, 0);
const SF_M = buildFighterMask(16, 17, 0);
const SF_SM = buildFighterMask(11, 13, 0);
const SF_S = buildFighterMask(7, 11, 0);
const SF_S_BANK_L = buildFighterMask(7, 11, -1);
const SF_S_BANK_R = buildFighterMask(7, 11, 1);
const SF_XL_BANK_L = buildFighterMask(36, 35, -1);
const SF_XL_BANK_R = buildFighterMask(36, 35, 1);
const SF_RECEDE = [SF_XL, SF_L, SF_M, SF_SM, SF_S];

// Three enemy silhouettes, each deliberately unlike the player's delta.
// SCOUT is a round drone, INTERCEPTOR a wide downward chevron, HEAVY a
// blocky cruiser — distinguishable at a glance by outline alone.
const SF_SCOUT = ["..333..", ".32223.", "3222223", ".22222.", "..2.2.."];

const SF_INTERCEPTOR = ["22222222222", "12222222221", ".233333332.", "..2333332..", "....333...."];

const SF_HEAVY = [
  "...22222222222...",
  ".222222222222222.",
  "22222333333322222",
  "22233333333333222",
  "32233333333333223",
  "22233333333333222",
  "22222333333322222",
  ".222222222222222.",
  "....222222222....",
];

const SF_ROCK = [".22..", "22322", "23222", ".222."];

// ---- timeline -------------------------------------------------------------
// CLOSE PASS   0     - 4000   hull fills frame, banking, stars streaking
// RECESSION    4000  - 7000   five sizes over 3s, covered by motion
// DOGFIGHT     7000  - 20000  beats A..E
// CLIMAX       20000 - 25200  the heavy
// RETURN       25200 - 28000  grows back over the camera, loop seam
const SF_PASS_MS = 4000;
const SF_RECEDE_MS = 7000;
const SF_FIGHT_MS = 20000;
const SF_CLIMAX_MS = 25200;

const SF_SHIP_Y = 50;
const SF_NOSE_Y = 44;
const SF_ENEMY_VY = 0.024;
const SF_BULLET_VY = -0.085;
const SF_HAZARD_VY = 0.042;

// Lateral flight path for the whole battle, in scene time. The dodges at
// 11200 and 18300 are authored to be clear of incoming fire; the long
// 12800->14600 sweep is the pursuit.
const SF_SHIP_PATH = [
  [7000, 80],
  [8000, 80],
  [8700, 44],
  [9800, 44],
  [10600, 96],
  [11200, 96],
  [12100, 30],
  [12800, 30],
  [14600, 132],
  [15400, 132],
  [16200, 60],
  [17200, 96],
  [17900, 96],
  [18300, 24],
  [19200, 24],
  [19900, 80],
  [21000, 80],
  [21700, 128],
  [22600, 128],
  [23200, 80],
  [24600, 80],
  [25200, 80],
];

// kind: scout | interceptor | heavy. fireAt fires one aimed shot downward.
//
// Every enemy's x is the x the SHIP PATH actually puts the fighter at when
// it fires, and every spawn time is solved backwards from the intended
// collision height so the shot connects where it is meant to. Hand-picking
// round numbers for these produced a scene whose climax silently never hit —
// the heavy sat at x=80 while the fighter fired from x=128 — which is
// exactly the kind of miss that looks like "nothing happened" rather than
// like a bug. The numbers below are solved, not guessed.
const SF_ENEMIES = [
  // BEAT A — first contact: a formation drifts in, two die.
  { t: 7080, x: 70, kind: "scout" },
  { t: 8090, x: 44, kind: "scout" },
  { t: 7300, x: 120, kind: "scout" },
  // BEAT B — crossing attack with return fire, then a kill.
  { t: 9885, x: 96, kind: "interceptor", fireAt: 10500 },
  { t: 10200, x: 140, kind: "scout" },
  // BEAT C — pursuit across the full width, three exchanges.
  { t: 11880, x: 41, kind: "scout" },
  { t: 12990, x: 92, kind: "interceptor" },
  { t: 13830, x: 132, kind: "scout" },
  // BEAT E — ambush: two vectors at once, crossfire, counterattack.
  { t: 17585, x: 24, kind: "interceptor", fireAt: 17900 },
  { t: 17200, x: 128, kind: "scout", fireAt: 18200 },
  { t: 18490, x: 40, kind: "scout" },
  // CLIMAX — three hits required, all from x=80 where the path parks.
  { t: 20200, x: 80, kind: "heavy", fireAt: 21400 },
];

// Extra aimed shots from the heavy, so the climax threat fires a pattern
// rather than a single pellet.
const SF_HEAVY_VOLLEY = [21400, 22100, 22800];

const SF_SHOTS = [8200, 9000, 10900, 13000, 13900, 14900, 18600, 19400, 21900, 23400, 23700, 24000];

// BEAT D — a drifting debris field the fighter threads through. Bullets
// destroy fragments; the fighter simply flies among them.
const SF_DEBRIS = [
  { t: 15100, x: 20 },
  { t: 15100, x: 58 },
  { t: 15400, x: 104 },
  { t: 15400, x: 140 },
  { t: 15900, x: 38 },
  { t: 15900, x: 122 },
  { t: 16400, x: 76 },
];

const SF_STARS = Array.from({ length: 40 }, (_, i) => ({
  x: (i * 37) % ARCADE_WIDTH,
  y: (i * 53) % ARCADE_HEIGHT,
  depth: 0.3 + ((i * 17) % 12) / 13,
}));

function createStarfighterState() {
  return { enemies: [], bullets: [], hazards: [], debris: [], bursts: [], spawned: 0, fired: 0, rocks: 0, volley: 0 };
}

// Star speed carries the whole depth illusion, so it is driven by the phase
// rather than being constant: fast during the close pass and both accel
// phases, slow while the dogfight needs a calm background.
function starfighterStarSpeed(t) {
  if (t < SF_PASS_MS) return 0.05;
  if (t < SF_RECEDE_MS) return 0.115;
  if (t < SF_FIGHT_MS) return 0.014;
  if (t < SF_CLIMAX_MS) return 0.02;
  return 0.13;
}

function starfighterShipX(t) {
  return arcadePath(SF_SHIP_PATH, t);
}

function updateStarfighter(state, t, dt, now) {
  const speed = starfighterStarSpeed(t);
  for (const star of SF_STARS) {
    star.y += speed * star.depth * dt;
    if (star.y > ARCADE_HEIGHT) {
      star.y -= ARCADE_HEIGHT;
      star.x = (star.x + 41) % ARCADE_WIDTH;
    }
  }

  if (t < SF_RECEDE_MS || t > SF_CLIMAX_MS) return;

  while (state.spawned < SF_ENEMIES.length && SF_ENEMIES[state.spawned].t <= t) {
    const def = SF_ENEMIES[state.spawned];
    state.enemies.push({
      x: def.x,
      y: def.kind === "heavy" ? -10 : -6,
      kind: def.kind,
      hp: def.kind === "heavy" ? 3 : 1,
      fireAt: def.fireAt || 0,
      fired: false,
      dead: false,
    });
    state.spawned += 1;
  }
  while (state.fired < SF_SHOTS.length && SF_SHOTS[state.fired] <= t) {
    state.bullets.push({ x: starfighterShipX(SF_SHOTS[state.fired]), y: SF_NOSE_Y, dead: false });
    state.fired += 1;
  }
  while (state.rocks < SF_DEBRIS.length && SF_DEBRIS[state.rocks].t <= t) {
    state.debris.push({ x: SF_DEBRIS[state.rocks].x, y: -6, dead: false });
    state.rocks += 1;
  }

  const heavy = state.enemies.find((e) => e.kind === "heavy" && !e.dead);
  while (state.volley < SF_HEAVY_VOLLEY.length && SF_HEAVY_VOLLEY[state.volley] <= t) {
    if (heavy) {
      // A spread, not a pellet — this is what makes the heavy read as a
      // different class of threat.
      for (const off of [-7, 0, 7]) state.hazards.push({ x: heavy.x + off, y: heavy.y + 6 });
    }
    state.volley += 1;
  }

  for (const enemy of state.enemies) {
    enemy.y += SF_ENEMY_VY * dt * (enemy.kind === "heavy" ? 0.42 : 1);
    if (enemy.kind === "heavy" && enemy.y > 16) enemy.y = 16;
    if (!enemy.fired && enemy.fireAt && t >= enemy.fireAt && enemy.kind !== "heavy") {
      enemy.fired = true;
      state.hazards.push({ x: enemy.x, y: enemy.y + 3 });
    }
  }
  for (const rock of state.debris) rock.y += SF_ENEMY_VY * 0.85 * dt;
  for (const bullet of state.bullets) bullet.y += SF_BULLET_VY * dt;
  for (const hazard of state.hazards) hazard.y += SF_HAZARD_VY * dt;

  for (const bullet of state.bullets) {
    if (bullet.dead) continue;
    for (const enemy of state.enemies) {
      if (enemy.dead) continue;
      const halfW = enemy.kind === "heavy" ? 9 : enemy.kind === "interceptor" ? 6 : 4;
      const halfH = enemy.kind === "heavy" ? 5 : 4;
      if (Math.abs(bullet.x - enemy.x) <= halfW && Math.abs(bullet.y - enemy.y) <= halfH) {
        bullet.dead = true;
        enemy.hp -= 1;
        if (enemy.hp <= 0) {
          enemy.dead = true;
          state.bursts.push({
            x: enemy.x,
            y: enemy.y,
            born: now,
            seed: (enemy.x % 7) * 0.9,
            reach: enemy.kind === "heavy" ? 30 : enemy.kind === "interceptor" ? 12 : 9,
            life: enemy.kind === "heavy" ? 1500 : 460,
          });
        } else {
          // Non-fatal hit: a small spark, so shots that do not kill still
          // read as landing.
          state.bursts.push({ x: bullet.x, y: enemy.y + 3, born: now, seed: 2.1, reach: 5, life: 240 });
        }
        break;
      }
    }
    if (bullet.dead) continue;
    for (const rock of state.debris) {
      if (rock.dead) continue;
      if (Math.abs(bullet.x - rock.x) <= 3 && Math.abs(bullet.y - rock.y) <= 3) {
        rock.dead = true;
        bullet.dead = true;
        state.bursts.push({ x: rock.x, y: rock.y, born: now, seed: 1.4, reach: 7, life: 380 });
      }
    }
  }

  state.enemies = state.enemies.filter((e) => !e.dead && e.y < ARCADE_HEIGHT + 10);
  state.debris = state.debris.filter((r) => !r.dead && r.y < ARCADE_HEIGHT + 8);
  state.bullets = state.bullets.filter((b) => !b.dead && b.y > -6);
  state.hazards = state.hazards.filter((h) => h.y < ARCADE_HEIGHT + 6);
  state.bursts = state.bursts.filter((b) => now - b.born < (b.life || ARCADE_BURST_MS));
}

// Engine plume, drawn beneath whichever hull size is current. Length scales
// with the hull so it shortens naturally with distance — one of the cues
// carrying the recession.
function drawFighterPlume(ctx, entry, left, top, thrust, now) {
  const cx = left + entry.w;
  const baseY = top + entry.h;
  const unit = Math.max(1, Math.round(entry.w / 7));
  const pulse = Math.floor(now / 70) % 3;
  const bands = [
    [ARCADE_INK[3], unit * (1 + pulse) * thrust],
    [ARCADE_INK[2], unit * 2 * thrust],
    [ARCADE_INK[1], unit * (1 + ((pulse + 1) % 3)) * thrust],
  ];
  for (const side of [-1, 1]) {
    let y = baseY - unit;
    for (const [ink, len] of bands) {
      const h = Math.max(1, Math.round(len));
      ctx.fillStyle = ink;
      ctx.fillRect(Math.round(cx + side * entry.engineOff - unit / 2), Math.round(y), Math.max(1, unit), h);
      y += h;
    }
  }
}

function drawStarfighterScene(ctx, state, t, now) {
  // Background: stars streak when the ship is moving through depth and sit
  // still during the dogfight, so speed is legible without any HUD.
  const streak = starfighterStarSpeed(t) > 0.04;
  ctx.fillStyle = ARCADE_INK[1];
  for (const star of SF_STARS) {
    const bright = star.depth > 1.1;
    ctx.fillStyle = bright ? ARCADE_INK[2] : ARCADE_INK[1];
    ctx.fillRect(Math.round(star.x), Math.round(star.y), 1, streak ? Math.round(2 + star.depth * 3) : 1);
  }

  let entry = SF_S;
  let cx = ARCADE_WIDTH / 2;
  let cy = SF_SHIP_Y;
  let thrust = 1;

  if (t < SF_PASS_MS) {
    // CLOSE PASS. Never static: the hull drifts, banks through the middle of
    // the beat, and rides a slow vertical float.
    const p = t / SF_PASS_MS;
    const bankPhase = Math.sin(p * Math.PI * 1.4);
    entry = bankPhase > 0.45 ? SF_XL_BANK_R : bankPhase < -0.45 ? SF_XL_BANK_L : SF_XL;
    cx = 80 + Math.sin(p * Math.PI * 1.1) * 16;
    cy = 26 + p * 8 + Math.sin(now / 520) * 1.5;
    thrust = 1.5 + Math.sin(now / 90) * 0.25;
  } else if (t < SF_RECEDE_MS) {
    // RECESSION.
    const p = (t - SF_PASS_MS) / (SF_RECEDE_MS - SF_PASS_MS);
    const idx = Math.min(SF_RECEDE.length - 1, Math.floor(p * SF_RECEDE.length));
    entry = SF_RECEDE[idx];
    const e = easeInOutCubic(p);
    cx = 80 + Math.sin(p * Math.PI) * 14;
    cy = 30 + (SF_SHIP_Y - 30) * e;
    thrust = 1.8 - 0.8 * e;
  } else if (t <= SF_CLIMAX_MS) {
    // COMBAT. Bank state is derived from actual lateral velocity, so the
    // ship banks because it is turning rather than on a timer.
    cx = starfighterShipX(t);
    const dx = starfighterShipX(Math.min(SF_CLIMAX_MS, t + 120)) - cx;
    entry = dx > 5 ? SF_S_BANK_R : dx < -5 ? SF_S_BANK_L : SF_S;
    cy = SF_SHIP_Y + Math.sin(t / 520);
    thrust = Math.abs(dx) > 5 ? 1.4 : 1;
  } else {
    // RETURN. The recession list played backwards, so the last frame of the
    // scene is the same hull at the same scale the first frame opens on.
    const p = (t - SF_CLIMAX_MS) / (SF_DURATION_MS - SF_CLIMAX_MS);
    const idx = Math.min(SF_RECEDE.length - 1, Math.floor((1 - p) * SF_RECEDE.length));
    entry = SF_RECEDE[idx];
    const e = easeInOutCubic(p);
    cx = 80 + Math.sin((1 - p) * Math.PI) * 14;
    cy = SF_SHIP_Y + (26 - SF_SHIP_Y) * e;
    thrust = 1 + 0.9 * e;
  }

  // Enemies, debris, fire.
  for (const rock of state.debris) drawArcadeSpriteCentered(ctx, SF_ROCK, rock.x, rock.y, 1);
  for (const enemy of state.enemies) {
    const sprite = enemy.kind === "heavy" ? SF_HEAVY : enemy.kind === "interceptor" ? SF_INTERCEPTOR : SF_SCOUT;
    drawArcadeSpriteCentered(ctx, sprite, enemy.x, enemy.y, 1);
  }

  // Player fire is a long bright lance; enemy fire is a short mid-tone
  // dash. Different length, different brightness, opposite direction —
  // three independent cues so they never read as the same object.
  ctx.fillStyle = ARCADE_INK[3];
  for (const bullet of state.bullets) ctx.fillRect(Math.round(bullet.x), Math.round(bullet.y), 1, 4);
  ctx.fillStyle = ARCADE_INK[2];
  for (const hazard of state.hazards) ctx.fillRect(Math.round(hazard.x), Math.round(hazard.y), 2, 2);

  const left = Math.round(cx - entry.w);
  const top = Math.round(cy - entry.h / 2);
  drawFighterPlume(ctx, entry, left, top, thrust, now);
  drawArcadeSprite(ctx, entry.mask, left, top, 1);

  for (const burst of state.bursts) drawArcadeBurst(ctx, burst, now, burst.life);

  if (mobileLoadLoadedCount > 0) drawArcadeNumber(ctx, mobileLoadLoadedCount, 3, 3, ARCADE_INK[1]);
}

// ---- SCENE 4: projector booth ---------------------------------------------
//
// The most literally on-brand scene: a machine whose entire job is showing you
// pictures. The wide canvas is what lets the machinery AND the projected image
// both be legible — at 128px one of the two always lost.
//
// Reels and film share ONE speed function, so when the film jams the reels
// stutter with it rather than each drifting on its own clock. That single
// shared value is what makes it read as a mechanism instead of two spinning
// circles.
const PROJECTOR_DURATION_MS = 15000;

const PROJECTED_FRAMES = [
  [
    "...............",
    "..........333..",
    "..........333..",
    ".......2.......",
    "......222......",
    ".....22322.....",
    "....2222222....",
    "...222222222...",
    "..22222222222..",
    ".2222222222222.",
    "222222222222222",
  ],
  [
    ".....22222.....",
    "...222222222...",
    "..22222222222..",
    "..23322233222..",
    "..22222222222..",
    "..22222222222..",
    "..22222222222..",
    "..22333333222..",
    "..22222222222..",
    "...222222222...",
    ".....22222.....",
  ],
  [
    ".......2.......",
    "......222......",
    ".....22322.....",
    "....2233222....",
    "...223333222...",
    "..22333333222..",
    "...223333222...",
    "....2233222....",
    ".....22322.....",
    "......222......",
    ".......2.......",
  ],
  [
    ".......2.......",
    "......222......",
    ".....22222.....",
    "....2222222....",
    "......222......",
    ".....22222.....",
    "....2222222....",
    "...222222222...",
    ".......1.......",
    ".......1.......",
    ".....22222.....",
  ],
];

// One speed curve drives both reels and the film. The 8000-9200 window is the
// jam: alternating near-stall and over-run, which is what a slipping sprocket
// actually looks like.
// [V2-POLISH / MICRO-ARCADE-COMPOSITION-FIRST]
// RESTORED to the original pre-close-up curves. The whole mechanism visible
// at once IS this scene, so it opens on the full machine and never cuts.
function projectorSpeed(t) {
  if (t < 1500) return 0;
  if (t < 2500) return ((t - 1500) / 1000) * 0.006;
  if (t < 8000) return 0.006;
  if (t < 9200) return Math.floor((t - 8000) / 150) % 2 === 0 ? 0.0009 : 0.0105;
  if (t < 12800) return 0.006;
  if (t < 14200) return 0.006 * (1 - (t - 12800) / 1400);
  return 0;
}

function projectorLamp(t) {
  if (t < 2500) return 0;
  if (t < 3500) return (t - 2500) / 1000;
  if (t < 12800) return 1;
  if (t < 14200) return 1 - (t - 12800) / 1400;
  return 0;
}

function createProjectorState() {
  return { angle: 0, film: 0 };
}

function updateProjectorState(state, t, dt) {
  const speed = projectorSpeed(t);
  state.angle += speed * dt;
  state.film += speed * dt * 9;
}

// [V2-POLISH / MICRO-ARCADE-IDENTITY-FIRST]
// The establishing close-up: one big reel cropped by the left edge, the film
// running right out of it through sprockets, and the gate it feeds. Drawn
// from the same primitives as the booth but at a `scale` multiplier, and
// positioned so that shrinking 3 -> 2 walks the reel toward exactly where
// the booth's feed reel will be. That is what makes the cut to the wide
// shot read as pulling back rather than as changing the subject.
function drawProjectorScene(ctx, state, t, now) {
  const lamp = projectorLamp(t);
  const jamming = t >= 8000 && t < 9200;
  const jitter = jamming ? (Math.floor(now / 60) % 2 === 0 ? 1 : -1) : 0;

  // --- projector body ---
  ctx.fillStyle = ARCADE_INK[1];
  ctx.fillRect(6, 30, 46, 20);
  ctx.fillStyle = ARCADE_INK[2];
  ctx.fillRect(6, 30, 46, 1);
  ctx.fillRect(6, 49, 46, 1);
  ctx.fillRect(6, 30, 1, 20);
  ctx.fillRect(51, 30, 1, 20);
  ctx.fillRect(20, 50, 4, 6);
  ctx.fillRect(38, 50, 4, 6);
  ctx.fillStyle = ARCADE_INK[1];
  ctx.fillRect(12, 54, 34, 2);

  // --- reels: feed above, take-up below-right, both on the shared angle ---
  const reels = [
    [17, 14, 9],
    [42, 18, 7],
  ];
  for (const [cx, cy, r] of reels) {
    drawArcadeCircle(ctx, cx, cy, r, ARCADE_INK[2]);
    drawArcadeCircle(ctx, cx, cy, Math.max(1, r - 5), ARCADE_INK[1]);
    for (let s = 0; s < 4; s++) {
      const angle = state.angle + (s * Math.PI) / 2;
      drawArcadeLine(
        ctx,
        cx + Math.cos(angle) * 2,
        cy + Math.sin(angle) * 2,
        cx + Math.cos(angle) * (r - 1),
        cy + Math.sin(angle) * (r - 1),
        ARCADE_INK[2]
      );
    }
  }

  // --- film path: feed reel -> gate -> take-up reel, sprockets travelling ---
  const filmPath = [
    [17, 23, 30, 36],
    [30, 36, 42, 25],
  ];
  for (const [x0, y0, x1, y1] of filmPath) {
    drawArcadeLine(ctx, x0, y0, x1, y1, ARCADE_INK[1]);
    drawArcadeLine(ctx, x0, y0 + 2, x1, y1 + 2, ARCADE_INK[1]);
    const len = Math.hypot(x1 - x0, y1 - y0);
    for (let s = 0; s < 6; s++) {
      const p = ((s * 4 + (state.film % 4)) % len) / len;
      ctx.fillStyle = ARCADE_INK[2];
      ctx.fillRect(Math.round(x0 + (x1 - x0) * p), Math.round(y0 + (y1 - y0) * p + 1), 1, 1);
    }
  }

  // --- gate + lamp house + lens ---
  ctx.fillStyle = ARCADE_INK[2];
  ctx.fillRect(28, 33, 5, 7);
  if (lamp > 0.05) {
    ctx.fillStyle = lamp > 0.6 ? ARCADE_INK[3] : ARCADE_INK[2];
    ctx.fillRect(29, 34, 3, 5);
  }
  ctx.fillStyle = ARCADE_INK[2];
  ctx.fillRect(52, 33, 6, 8);
  ctx.fillRect(58, 35, 2, 4);

  // --- light cone: lens out to the screen, widening ---
  const screenX = 112;
  const screenTop = 14;
  const screenH = 34;
  if (lamp > 0.05) {
    // The cone's axis tilts from the lens centre (37) to the SCREEN centre
    // (screenTop + screenH/2), and its half-height lands exactly on the
    // screen's own half-height. Aiming it straight out of the lens instead
    // left the light overshooting the bottom of the screen by 6px, which
    // reads as a misaligned projector rather than a working one.
    const screenMidY = screenTop + screenH / 2;
    const screenHalf = Math.round((screenH / 2) * lamp);
    ctx.fillStyle = ARCADE_INK[1];
    for (let x = 60; x < screenX; x += 1) {
      const p = (x - 60) / (screenX - 60);
      const half = Math.round((2 + p * (screenH / 2 - 2)) * lamp);
      if (half < 1) continue;
      const axis = 37 + (screenMidY - 37) * p;
      if (x % 2 === 0) ctx.fillRect(x, Math.round(axis - half), 1, half * 2);
    }
    drawArcadeLine(ctx, 60, 35, screenX, screenMidY - screenHalf, ARCADE_INK[2]);
    drawArcadeLine(ctx, 60, 39, screenX, screenMidY + screenHalf, ARCADE_INK[2]);
  }

  // --- screen ---
  ctx.fillStyle = ARCADE_INK[2];
  ctx.fillRect(screenX, screenTop, 1, screenH);
  ctx.fillRect(ARCADE_WIDTH - 4, screenTop, 1, screenH);
  ctx.fillRect(screenX, screenTop, ARCADE_WIDTH - 4 - screenX, 1);
  ctx.fillRect(screenX, screenTop + screenH, ARCADE_WIDTH - 4 - screenX, 1);

  if (lamp > 0.25 && t >= 3500) {
    const frame = PROJECTED_FRAMES[Math.floor((t - 3500) / 1100) % PROJECTED_FRAMES.length];
    const cx = (screenX + ARCADE_WIDTH - 4) / 2 + jitter;
    const cy = screenTop + screenH / 2 + (jamming ? jitter : 0);
    drawArcadeSpriteCentered(ctx, frame, cx, cy, 2, lamp > 0.7 ? null : ARCADE_INK[1]);

    // The jam leaves a burn blooming in the middle of the frame, which
    // shrinks away again once the mechanism catches up.
    if (jamming) {
      const burn = 2 + Math.round(6 * arcadeClamp01((t - 8000) / 1200));
      ctx.fillStyle = ARCADE_INK[3];
      ctx.fillRect(Math.round(cx - burn / 2), Math.round(cy - burn / 2), burn, burn);
    } else if (t >= 9200 && t < 9800) {
      const burn = Math.round(8 * (1 - arcadeClamp01((t - 9200) / 600)));
      if (burn > 0) {
        ctx.fillStyle = ARCADE_INK[2];
        ctx.fillRect(Math.round(cx - burn / 2), Math.round(cy - burn / 2), burn, burn);
      }
    }
  }
}

// ---- SCENE: science lab ---------------------------------------------------
//
// Wide bench, no camera moves. The entertainment here is SIMULTANEITY — the
// promise is "we're cooking something up for you", so the rule I set myself
// was that at any instant at least three different things must be moving:
// a flame licking, bubbles rising, a droplet travelling the tube, vapour
// curling, a needle creeping. A single-focus composition would have wasted
// the concept.
const LAB_DURATION_MS = 27000;
const LAB_BENCH_Y = 52;

// Glassware, all visibly different silhouettes rather than one triangle
// repeated. Sizes are ~35% up on the previous bench so liquid levels, bubbles
// and shapes are legible instead of implied.
const LAB_ROUND = [
  "...33333...",
  "..3.....3..",
  ".33.....33.",
  "3.........3",
  "3.........3",
  "3.........3",
  "3.........3",
  ".3.......3.",
  "..3.....3..",
  "...33333...",
];

const LAB_CONE = [
  "....333....",
  "....3.3....",
  "....3.3....",
  "...3...3...",
  ".3.......3.",
  "3.........3",
  "3.........3",
  "3.........3",
  "33333333333",
];

const LAB_BEAKER = ["33.....33", "3.......3", "3.......3", "3.......3", "3.......3", "3.......3", "33333333 "];

const LAB_CYLINDER = ["333", "3.3", "3.3", "3.3", "3.3", "3.3", "3.3", "3.3", "3.3", "3.3", "3.3", "333"];

const LAB_VIAL = ["3..3", "3..3", "3..3", "3..3", "33.3", ".33."];

const LAB_WIDE_FLASK = ["...33...", "...33...", "...33...", "..3..3..", ".3....3.", "3......3", "3......3", ".3....3.", "..3333.."];

const LAB_TALL_FLASK = ["..33..", "..33..", "..33..", "..33..", ".3..3.", "3....3", "3....3", ".3..3.", "..33.."];

const LAB_SMALL_ROUND = ["..33..", "..33..", ".3..3.", "3....3", ".3..3.", "..33.."];

const LAB_NARROW_CONE = ["..33..", "..33..", ".3..3.", ".3..3.", "3....3", "333333"];

const LAB_SQUAT_CONE = ["..33..", ".3..3.", "3....3", "3....3", "333333"];

const LAB_TILE = ["3333333", "3222223", "32.3.23", "32333.3", "3222223", "3333333"];

// Liquid poured into a vessel mask: fills from the bottom up to `level` rows,
// clipped to whatever is inside the glass on each row. One helper keeps every
// vessel's liquid consistent instead of hand-placing rectangles per flask.
function drawLabLiquid(ctx, mask, left, top, level, ink) {
  ctx.fillStyle = ink;
  for (let r = mask.length - 1; r >= 0 && mask.length - r <= level; r--) {
    const row = mask[r];
    let lo = -1;
    let hi = -1;
    for (let c = 0; c < row.length; c++) {
      if (row[c] !== ".") {
        if (lo < 0) lo = c;
        hi = c;
      }
    }
    if (lo < 0 || hi - lo < 2) continue;
    ctx.fillRect(left + lo + 1, top + r, hi - lo - 1, 1);
  }
}

function drawLabBubbles(ctx, left, top, w, h, count, rate, now, seed, ink) {
  for (let i = 0; i < count; i++) {
    const ph = ((now / rate + i * 0.31 + seed) % 1);
    const by = top + h - Math.round(ph * h);
    ctx.fillStyle = ph > 0.65 ? ARCADE_INK[3] : ink;
    ctx.fillRect(left + 1 + ((i * 5 + seed * 3) % Math.max(1, w - 2)), by, 1, 1);
  }
}

// Reaction energy 0..1 — the spine every other element reads from, so the
// whole bench escalates together instead of each vessel running its own clock.
function labEnergy(t) {
  if (t < 3000) return 0.08;
  if (t < 6000) return 0.08 + 0.32 * ((t - 3000) / 3000);
  if (t < 13000) return 0.4 + 0.25 * ((t - 6000) / 7000);
  if (t < 19000) return 0.65 + 0.3 * ((t - 13000) / 6000);
  if (t < 21500) return 0.95;
  if (t < 22200) return 1;
  if (t < 24500) return 0.35;
  return 0.15;
}

// THE COMPLICATION, 13.5s-17s: pressure runs away, the centre flask foams up
// toward its neck and the flame flares — then a
// hand reaches in and throttles the burner back. Without a scare in the middle
// the bench was just pleasant activity; the near-miss gives the success at the
// end something to be a success over.
function labPanic(t) {
  if (t < 13500 || t > 17000) return 0;
  if (t < 15200) return (t - 13500) / 1700;
  if (t < 15900) return 1;
  return 1 - (t - 15900) / 1100;
}

function drawLabScene(ctx, state, t, now) {
  const e = Math.min(1, labEnergy(t) + labPanic(t) * 0.35);
  const panic = labPanic(t);
  const burnerOn = t > 2600;
  const bench = LAB_BENCH_Y;

  // bench slab + a shelf line behind, for depth
  ctx.fillStyle = ARCADE_INK[2];
  ctx.fillRect(0, bench, ARCADE_WIDTH, 1);
  ctx.fillStyle = ARCADE_INK[1];
  ctx.fillRect(0, bench + 3, ARCADE_WIDTH, 1);
  ctx.fillRect(0, 8, ARCADE_WIDTH, 1);
  for (let x = 4; x < ARCADE_WIDTH; x += 30) ctx.fillRect(x, bench + 1, 3, 2);

  // ---- LEFT: burner + main round-bottom flask ----
  const rx = 8;
  const ry = bench - LAB_ROUND.length - 5;
  drawArcadeSprite(ctx, LAB_ROUND, rx, ry, 1);
  ctx.fillStyle = ARCADE_INK[3];
  ctx.fillRect(rx + 4, ry - 7, 1, 8);
  ctx.fillRect(rx + 6, ry - 7, 1, 8);
  ctx.fillRect(rx + 3, ry - 8, 5, 1);
  drawLabLiquid(ctx, LAB_ROUND, rx, ry, 6, ARCADE_INK[1]);
  drawLabBubbles(ctx, rx, ry + 3, 11, 7, 8, 240 - e * 110, now, 0, ARCADE_INK[2]);
  // burner
  ctx.fillStyle = ARCADE_INK[2];
  ctx.fillRect(rx + 2, bench - 4, 7, 1);
  ctx.fillRect(rx + 5, bench - 3, 1, 3);
  if (burnerOn) {
    const fl = 3 + Math.round(e * 4) + Math.round(panic * 5) + (Math.floor(now / 80) % 2);
    for (let i = 0; i < fl; i++) {
      ctx.fillStyle = i < fl - 2 ? ARCADE_INK[3] : ARCADE_INK[2];
      const w = Math.max(1, 4 - Math.floor(i / 2));
      ctx.fillRect(rx + 5 - Math.floor(w / 2), bench - 5 - i, w, 1);
    }
  }

  // ---- LEFT-CENTRE: a beaker simmering on its own ----
  const bx = 24;
  const by2 = bench - LAB_BEAKER.length;
  drawArcadeSprite(ctx, LAB_BEAKER, bx, by2, 1);
  drawLabLiquid(ctx, LAB_BEAKER, bx, by2, 4, ARCADE_INK[1]);
  drawLabBubbles(ctx, bx, by2 + 2, 9, 4, 4, 460, now, 1, ARCADE_INK[2]);

  // A staggered run of quieter experiments fills out the bench without
  // competing with the main reaction: low pulse, still sample, slow fizz.
  const wx = 36;
  const wy = bench - LAB_WIDE_FLASK.length;
  drawArcadeSprite(ctx, LAB_WIDE_FLASK, wx, wy, 1);
  drawLabLiquid(ctx, LAB_WIDE_FLASK, wx, wy, 2 + (Math.floor(now / 1100) % 2), ARCADE_INK[1]);

  const ntx = 47;
  const nty = bench - LAB_NARROW_CONE.length;
  drawArcadeSprite(ctx, LAB_NARROW_CONE, ntx, nty, 1);
  drawLabLiquid(ctx, LAB_NARROW_CONE, ntx, nty, 1, ARCADE_INK[1]);

  // ---- tubing: neck-to-neck round flask -> centre cone ----
  const ax = rx + 5;
  const cx2 = 57;
  const cy2 = bench - LAB_CONE.length;
  const tox = cx2 + 5;
  const tubeStartY = ry - 8;
  const tubeEndY = cy2;
  const tubePt = (p) => [
    ax + (tox - ax) * p,
    tubeStartY + (tubeEndY - tubeStartY) * p - Math.sin(p * Math.PI) * 10,
  ];
  ctx.fillStyle = ARCADE_INK[1];
  for (let p = 0; p <= 1.001; p += 0.02) {
    const [x, y] = tubePt(p);
    ctx.fillRect(Math.round(x), Math.round(y), 1, 1);
  }
  if (t > 7000) {
    for (let i = 0; i < 4; i++) {
      const [x, y] = tubePt((now / 1500 + i * 0.25) % 1);
      ctx.fillStyle = ARCADE_INK[3];
      ctx.fillRect(Math.round(x), Math.round(y) - 1, 1, 2);
    }
  }

  // ---- CENTRE: the main conical flask (the reaction vessel) ----
  drawArcadeSprite(ctx, LAB_CONE, cx2, cy2, 1);
  const fill = 2 + Math.round(arcadeClamp01((t - 7000) / 11000) * 6);
  drawLabLiquid(ctx, LAB_CONE, cx2, cy2, fill, ARCADE_INK[1]);
  drawLabBubbles(ctx, cx2, cy2 + 3, 11, 6, 7, 300 - e * 160, now, 2, ARCADE_INK[2]);

  // foam surging up the neck during the complication
  if (panic > 0.05) {
    const foam = Math.round(panic * 11);
    for (let i = 0; i < foam; i++) {
      ctx.fillStyle = i > foam - 3 ? ARCADE_INK[3] : ARCADE_INK[2];
      ctx.fillRect(cx2 + 2 + ((i * 2) % 4), cy2 - i, 5 + (i % 3), 1);
    }
    ctx.fillStyle = Math.floor(now / 130) % 2 === 0 ? ARCADE_INK[3] : ARCADE_INK[1];
    ctx.fillRect(88, bench - 6, 5, 5);
  }
  // a hand throttles the burner back
  if (t > 15600 && t < 17200) {
    const p = arcadeClamp01((t - 15600) / 700) - arcadeClamp01((t - 16600) / 600);
    const hx = rx + 20 - Math.round(p * 13);
    ctx.fillStyle = ARCADE_INK[2];
    // sleeve running back to the left frame edge, so the hand has an owner
    ctx.fillRect(0, bench - 9, hx + 2, 6);
    ctx.fillStyle = ARCADE_INK[1];
    ctx.fillRect(0, bench - 9, hx + 2, 1);
    ctx.fillStyle = ARCADE_INK[2];
    ctx.fillRect(hx, bench - 8, 8, 5);
    ctx.fillRect(hx + 6, bench - 11, 3, 8);
  }
  // vapour
  if (t > 9000) {
    for (let i = 0; i < 7; i++) {
      const ph = (now / 1700 + i * 0.15) % 1;
      ctx.fillStyle = ph > 0.55 ? ARCADE_INK[1] : ARCADE_INK[2];
      ctx.fillRect(cx2 + 5 + Math.round(Math.sin(ph * 7 + i) * (1 + ph * 5)), cy2 - Math.round(ph * 20), 1, 1);
    }
  }

  // ---- CENTRE-RIGHT: graduated cylinder + varied receiving glassware ----
  const gx2 = 74;
  drawArcadeSprite(ctx, LAB_CYLINDER, gx2, bench - LAB_CYLINDER.length, 1);
  drawLabLiquid(ctx, LAB_CYLINDER, gx2, bench - LAB_CYLINDER.length, 5 + Math.round(e * 4), ARCADE_INK[1]);
  ctx.fillStyle = ARCADE_INK[1];
  for (let i = 1; i < 6; i++) ctx.fillRect(gx2 + 3, bench - 2 - i * 2, 2, 1);

  const sbx = 82;
  const sby = bench - LAB_SMALL_ROUND.length;
  drawArcadeSprite(ctx, LAB_SMALL_ROUND, sbx, sby, 1);
  drawLabLiquid(ctx, LAB_SMALL_ROUND, sbx, sby, 2, ARCADE_INK[1]);

  const tfx = 91;
  const tfy = bench - LAB_TALL_FLASK.length;
  drawArcadeSprite(ctx, LAB_TALL_FLASK, tfx, tfy, 1);
  drawLabLiquid(ctx, LAB_TALL_FLASK, tfx, tfy, 5, ARCADE_INK[1]);
  drawLabBubbles(ctx, tfx, tfy + 3, 6, 5, 2, 920, now, 4, ARCADE_INK[2]);

  const tvx = 101;
  const tvy = bench - LAB_SQUAT_CONE.length;
  drawArcadeSprite(ctx, LAB_SQUAT_CONE, tvx, tvy, 1);
  drawLabLiquid(ctx, LAB_SQUAT_CONE, tvx, tvy, 4, ARCADE_INK[1]);

  // ---- RIGHT: test-tube rack, receiving vial, side flask ----
  const tr = 116;
  ctx.fillStyle = ARCADE_INK[2];
  ctx.fillRect(tr - 2, bench - 20, 30, 1);
  for (let i = 0; i < 4; i++) {
    const tx = tr + i * 7;
    ctx.fillStyle = ARCADE_INK[3];
    ctx.fillRect(tx, bench - 20, 1, 17);
    ctx.fillRect(tx + 4, bench - 20, 1, 17);
    ctx.fillRect(tx + 1, bench - 3, 3, 1);
    const lvl = 3 + Math.round(Math.abs(Math.sin(now / 900 + i)) * 7 * e) + i;
    ctx.fillStyle = ARCADE_INK[1];
    ctx.fillRect(tx + 1, bench - 3 - lvl, 3, lvl);
    if (i % 2 === 0) drawLabBubbles(ctx, tx, bench - 3 - lvl, 5, lvl, 3, 700, now, i, ARCADE_INK[2]);
    // Drips now start AT the dropper nozzle above each tube, not three rows
    // above the rack in open air — that was the unexplained floating object.
    ctx.fillStyle = ARCADE_INK[2];
    ctx.fillRect(tx + 1, bench - 26, 3, 4);
    ctx.fillRect(tx + 2, bench - 22, 1, 2);
    const dp = (now / 1200 + i * 0.3) % 1;
    if (dp < 0.4) {
      ctx.fillStyle = ARCADE_INK[3];
      ctx.fillRect(tx + 2, bench - 20 + Math.round((dp / 0.4) * 15), 1, 2);
    }
  }
  const vx2 = 148;
  drawArcadeSprite(ctx, LAB_VIAL, vx2, bench - LAB_VIAL.length, 1);
  drawLabLiquid(ctx, LAB_VIAL, vx2, bench - LAB_VIAL.length, 3, ARCADE_INK[1]);

  // ---- payoff ----
  if (t >= 21500 && t < 22200) {
    const p = (t - 21500) / 700;
    const r = Math.round(8 + p * 30);
    drawArcadeCircle(ctx, cx2 + 5, cy2 + 3, r, p < 0.5 ? ARCADE_INK[3] : ARCADE_INK[2]);
    drawArcadeCircle(ctx, cx2 + 5, cy2 + 3, Math.max(1, r - 5), ARCADE_INK[1]);
  }
  if (t >= 22200) {
    const p = arcadeClamp01((t - 22200) / 2200);
    const ty = cy2 - 3 - Math.round(easeInOutCubic(p) * 18);
    if (Math.floor(now / 160) % 2 === 0) {
      ctx.fillStyle = ARCADE_INK[1];
      ctx.fillRect(cx2 + 1, ty - 1, 9, 8);
    }
    drawArcadeSprite(ctx, LAB_TILE, cx2 + 2, ty, 1);
  }
}

const DIVER_DURATION_MS = 28000;

const DIVER_SPRITE = [
  "..2222..",
  ".233332.",
  ".233332.",
  "..2222..",
  ".222222.",
  "22222222",
  "22222222",
  "2.2222.2",
  "..2222..",
  "..2..2..",
  ".22..22.",
];

const DIVER_CHEST = [
  ".2222222222.",
  "222222222222",
  "23333333332 ",
  "222222222222",
  "2.22222222.2",
  "222222222222",
];

const DIVER_PARTICLES = Array.from({ length: 26 }, (_, i) => ({
  x: (i * 53) % ARCADE_WIDTH,
  y: (i * 29) % ARCADE_HEIGHT,
  sp: 0.004 + ((i * 7) % 5) / 700,
}));

function createDiverState() {
  return { bubbles: [] };
}

function updateDiverState(state, t, dt, now) {
  for (const p of DIVER_PARTICLES) {
    p.y -= p.sp * dt;
    if (p.y < 0) p.y += ARCADE_HEIGHT;
  }
  // bubble trail from the helmet, denser when the diver bolts
  const rate = t > 23000 ? 70 : 320;
  if (!state.last || now - state.last > rate) {
    state.last = now;
    const dy = diverY(t);
    state.bubbles.push({ x: diverX(t) + 3 + ((now / 97) % 3), y: dy, born: now });
  }
  state.bubbles = state.bubbles.filter((b) => now - b.born < 3200);
  for (const b of state.bubbles) b.y -= 0.011 * dt;
}

function diverX(t) {
  return arcadePath(
    [
      [0, 74],
      [9000, 74],
      [12000, 52],
      [17000, 52],
      [20000, 62],
      [23000, 62],
      [28000, 70],
    ],
    t
  );
}

function diverY(t) {
  return arcadePath(
    [
      [0, -12],
      [8500, 30],
      [12000, 34],
      [20500, 34],
      [23000, 30],
      [28000, -14],
    ],
    t
  );
}

function drawDiverScene(ctx, state, t, now) {
  // drifting motes — the only thing proving the water is water early on
  ctx.fillStyle = ARCADE_INK[1];
  for (const p of DIVER_PARTICLES) ctx.fillRect(Math.round(p.x), Math.round(p.y), 1, 1);

  const dx = diverX(t);
  const dy = diverY(t);

  // ---- lamp cone: reveals the world, sweeps when the diver looks around ----
  let aim = 0.5;
  if (t > 17000 && t < 20500) aim = 0.5 + Math.sin((t - 17000) / 900) * 0.55;
  if (t > 20500) aim = 0.95;
  const coneLen = 46;
  const cxs = dx + 4;
  const cys = dy + 6;
  for (let i = 6; i < coneLen; i++) {
    const spread = Math.round(i * 0.42);
    const ang = Math.PI * (0.18 + aim * 0.64);
    const px = cxs + Math.cos(ang) * i;
    const py = cys + Math.sin(ang) * i;
    if (i % 2) continue;
    ctx.fillStyle = i < 26 ? ARCADE_INK[1] : ARCADE_INK[1];
    ctx.fillRect(Math.round(px - spread / 2), Math.round(py), Math.max(1, spread), 1);
  }

  // ---- seabed + wreck, only from the point the descent nears it ----
  if (t > 6000) {
    const reveal = arcadeClamp01((t - 6000) / 2600);
    ctx.fillStyle = ARCADE_INK[1];
    for (let x = 0; x < ARCADE_WIDTH; x++) {
      const h = 3 + Math.round(Math.sin(x / 19) * 2 + Math.sin(x / 7) * 1.2);
      if (x / ARCADE_WIDTH > reveal + 0.15) continue;
      ctx.fillRect(x, ARCADE_HEIGHT - h, 1, h);
    }
    // wreck: a broken hull leaning on the seabed
    if (reveal > 0.5) {
      ctx.fillStyle = ARCADE_INK[1];
      drawArcadeLine(ctx, 96, 60, 132, 46, ARCADE_INK[2]);
      drawArcadeLine(ctx, 96, 60, 128, 58, ARCADE_INK[1]);
      drawArcadeLine(ctx, 132, 46, 128, 58, ARCADE_INK[1]);
      for (let i = 0; i < 5; i++) ctx.fillRect(104 + i * 6, 55 - i * 2, 2, 2);
      // mast stub
      drawArcadeLine(ctx, 120, 51, 118, 34, ARCADE_INK[1]);
    }
  }

  // ---- the chest: found, opened, treasure ----
  if (t > 9500) {
    const chestX = 40;
    const chestY = 52;
    drawArcadeSprite(ctx, DIVER_CHEST, chestX, chestY, 1);
    if (t > 13000) {
      // lid swings up
      const p = arcadeClamp01((t - 13000) / 900);
      drawArcadeLine(
        ctx,
        chestX,
        chestY,
        chestX + 12 - Math.round(p * 5),
        chestY - Math.round(p * 7),
        ARCADE_INK[2]
      );
      // glow pouring out, pulsing
      const gl = Math.floor(now / 180) % 2 === 0 ? 3 : 2;
      for (let i = 0; i < 7; i++) {
        const ph = (now / 900 + i * 0.14) % 1;
        ctx.fillStyle = ph > 0.6 ? ARCADE_INK[2] : ARCADE_INK[gl];
        ctx.fillRect(chestX + 2 + i, chestY - 1 - Math.round(ph * 9), 1, 1);
      }
      ctx.fillStyle = ARCADE_INK[3];
      ctx.fillRect(chestX + 3, chestY + 2, 6, 2);
    }
  }

  // ---- THE PAYOFF: it was never a wreck's shadow ----
  // Two eyes, far enough apart that the implied head is wider than the
  // whole seabed. Nothing else is ever drawn of it — the negative space
  // does the work, and drawing a body would only make it smaller.
  if (t > 20500) {
    const p = arcadeClamp01((t - 20500) / 1400);
    const open = Math.round(p * 5);
    if (open > 0) {
      for (const ex of [26, 118]) {
        ctx.fillStyle = ARCADE_INK[1];
        ctx.fillRect(ex - 9, 16 - open - 1, 18, open * 2 + 3);
        ctx.fillStyle = ARCADE_INK[3];
        ctx.fillRect(ex - 7, 16 - open, 14, open * 2);
        ctx.fillStyle = ARCADE_INK[1];
        // slit pupil, tracking the diver
        const px = ex + Math.round((dx - ex) * 0.06);
        ctx.fillRect(px - 1, 16 - open, 3, open * 2);
      }
      // the faintest suggestion of a brow ridge between them
      ctx.fillStyle = ARCADE_INK[1];
      for (let x = 30; x < 116; x += 3) {
        ctx.fillRect(x, 8 + Math.round(Math.sin(x / 26) * 2), 2, 1);
      }
    }
  }

  // bubbles
  for (const b of state.bubbles) {
    const age = (now - b.born) / 3200;
    ctx.fillStyle = age > 0.6 ? ARCADE_INK[1] : ARCADE_INK[2];
    ctx.fillRect(Math.round(b.x), Math.round(b.y), 1, 1);
  }

  // the diver
  if (dy > -12 && dy < ARCADE_HEIGHT) {
    drawArcadeSprite(ctx, DIVER_SPRITE, Math.round(dx), Math.round(dy), 1);
    // air line back up to the surface
    ctx.fillStyle = ARCADE_INK[1];
    for (let y = 0; y < dy; y += 3) {
      ctx.fillRect(Math.round(dx + 4 + Math.sin(y / 9 + now / 900) * 3), y, 1, 2);
    }
  }
}

// ---- SCENE: vintage superspy ----------------------------------------------
//
// The only scene in the pool with a CAMERA. Everything else is staged in a
// fixed 160px frame; this one is a ~900px world the camera tracks across,
// because a five-act story crammed into one static tableau read as clutter
// rather than as cinema — the first version drew the fence, the vault, the
// alarm and the getaway all at once and none of them had room. Panning gives
// each act a clean, uncrowded composition and turns the canvas width into
// pacing instead of a constraint.
//
// Staged in silhouette against searchlights: a suited figure in pure outline
// reads instantly at 5x11 where any attempt at a face would read as noise.
// Original throughout — no borrowed iconography.
const SPY_DURATION_MS = 32000;
const SPY_GROUND_Y = 50;

const SPY_AGENT = [".222.", ".222.", "22222", "32223", "22222", "22222", ".222.", ".2.2.", ".2.2.", "22.22"];
const SPY_AGENT_RUN = [".222.", ".222.", "22222", "32223", "22222", ".2222", ".2.2.", "22..2", "2...2", "......"];
const SPY_AGENT_CROUCH = ["......", "......", ".222..", "32223.", "222222", "22222.", ".2..2.", "22..22"];

const SPY_GUARD = [".22.", ".22.", "2222", "2222", ".22.", ".2.2", ".2.2", "22.2"];

const SPY_CAR = [
  ".....2222222......",
  "...2233333322....",
  "..223333333322...",
  ".22222222222222..",
  "222222222222222 2",
  "222222222222222222",
  ".33.222222.33.....",
];

// The camera. Authored as its own path so the pan can lead the action —
// it drifts ahead of the spy during stealth and snaps behind the car once
// the chase starts, which is what makes the escape feel fast.
function spyCam(t) {
  return arcadePath(
    [
      [0, 0],
      [3000, 10],
      [7000, 120],
      [11000, 190],
      [14500, 270],
      [18500, 300],
      [19500, 320],
      [24000, 470],
      [28000, 690],
      [31000, 790],
      [32000, 820],
    ],
    t
  );
}

// World x of the agent through the stealth acts.
function spyAgentWorldX(t) {
  return arcadePath(
    [
      [0, 30],
      [3000, 70],
      [5200, 120],
      [7000, 150],
      [9000, 205],
      [11000, 240],
      [12800, 250],
      [14500, 330],
      [18500, 355],
      [19600, 380],
      [22500, 470],
      [24200, 520],
    ],
    t
  );
}

function drawSpyScene(ctx, state, t, now) {
  const cam = spyCam(t);
  const X = (worldX) => Math.round(worldX - cam);
  const onScreen = (worldX, pad) => worldX - cam > -(pad || 40) && worldX - cam < ARCADE_WIDTH + (pad || 40);

  const alarm = t > 18500 && t < 29000;
  const flash = alarm && Math.floor(now / 200) % 2 === 0;

  // ---- sky: stars parallax at a fraction of the camera ----
  ctx.fillStyle = ARCADE_INK[1];
  for (let i = 0; i < 18; i++) {
    const sx = ((i * 61 - cam * 0.15) % 190 + 190) % 190 - 15;
    ctx.fillRect(Math.round(sx), 3 + ((i * 13) % 11), 1, 1);
  }
  drawArcadeCircle(ctx, X(120) + 0, 9, 4, ARCADE_INK[1]);

  // ---- ground ----
  ctx.fillStyle = ARCADE_INK[2];
  ctx.fillRect(0, SPY_GROUND_Y, ARCADE_WIDTH, 1);
  ctx.fillStyle = ARCADE_INK[1];
  for (let i = 0; i < 40; i++) {
    const wx = i * 26;
    if (onScreen(wx, 10)) ctx.fillRect(X(wx), SPY_GROUND_Y + 4, 6, 1);
  }

  // ---- ACT 1: perimeter fence + searchlight towers ----
  for (const [wx, phase] of [[0, 0], [230, 1.9]]) {
    if (!onScreen(wx, 60)) continue;
    const tx = X(wx);
    ctx.fillStyle = ARCADE_INK[2];
    ctx.fillRect(tx - 1, 22, 3, SPY_GROUND_Y - 22);
    ctx.fillRect(tx - 3, 20, 7, 3);
    const aim = Math.PI * (0.34 + Math.sin(now / 1600 + phase) * 0.15);
    for (let i = 5; i < 40; i++) {
      const px = tx + Math.cos(aim) * i;
      const py = 22 + Math.sin(aim) * i;
      if (py > SPY_GROUND_Y) break;
      const spread = Math.max(2, Math.round(i * 0.4));
      ctx.fillStyle = i % 3 === 0 ? ARCADE_INK[2] : ARCADE_INK[1];
      ctx.fillRect(Math.round(px - spread / 2), Math.round(py), spread, 1);
    }
  }
  // chain-link fence
  for (let wx = 40; wx < 200; wx += 4) {
    if (!onScreen(wx, 6)) continue;
    ctx.fillStyle = ARCADE_INK[1];
    ctx.fillRect(X(wx), 34, 1, SPY_GROUND_Y - 34);
  }
  ctx.fillStyle = ARCADE_INK[2];
  if (onScreen(120, 90)) ctx.fillRect(X(40), 34, 160, 1);

  // ---- ACT 1b: the security beam and the gadget that kills it ----
  const beamAlive = t < 9200;
  if (onScreen(212, 30)) {
    ctx.fillStyle = ARCADE_INK[2];
    ctx.fillRect(X(206), 30, 2, 6);
    ctx.fillRect(X(206), SPY_GROUND_Y - 8, 2, 6);
    if (beamAlive) {
      ctx.fillStyle = Math.floor(now / 120) % 2 === 0 ? ARCADE_INK[3] : ARCADE_INK[2];
      for (let y = 36; y < SPY_GROUND_Y - 8; y += 2) ctx.fillRect(X(207), y, 1, 1);
    } else if (t < 10200) {
      // dying sparks
      ctx.fillStyle = ARCADE_INK[2];
      for (let i = 0; i < 4; i++) ctx.fillRect(X(207) + ((i * 3) % 5) - 2, 38 + i * 3, 1, 1);
    }
  }
  // the gadget: a small disc the agent sets down, which pulses then kills it
  if (t > 7600 && t < 11500 && onScreen(200, 20)) {
    const pulse = Math.floor(now / 140) % 2 === 0;
    ctx.fillStyle = t < 9200 && pulse ? ARCADE_INK[3] : ARCADE_INK[2];
    ctx.fillRect(X(199), SPY_GROUND_Y - 3, 4, 2);
    if (t < 9200) {
      const r = 3 + Math.round(((now / 90) % 10));
      drawArcadeCircle(ctx, X(201), SPY_GROUND_Y - 3, r, ARCADE_INK[1]);
    }
  }

  // ---- ACT 1c: a guard on patrol ----
  const guardWorld = 268 + Math.sin(t / 2100) * 30;
  if (onScreen(guardWorld, 20)) {
    drawArcadeSprite(ctx, SPY_GUARD, X(guardWorld), SPY_GROUND_Y - SPY_GUARD.length, 1);
    // torch
    ctx.fillStyle = ARCADE_INK[1];
    const dir = Math.cos(t / 2100) > 0 ? 1 : -1;
    for (let i = 2; i < 14; i += 2) ctx.fillRect(X(guardWorld) + 2 + dir * i, SPY_GROUND_Y - 6 + (i >> 2), 2, 1);
  }

  // ---- ACT 2: the facility wall + vault ----
  if (onScreen(360, 120)) {
    ctx.fillStyle = flash ? ARCADE_INK[2] : ARCADE_INK[1];
    ctx.fillRect(X(300), 26, 1, SPY_GROUND_Y - 26);
    ctx.fillRect(X(430), 26, 1, SPY_GROUND_Y - 26);
    ctx.fillRect(X(300), 26, 131, 1);
    for (let i = 0; i < 8; i++) {
      const wx = 312 + i * 15;
      ctx.fillStyle = flash ? ARCADE_INK[3] : i % 3 === 0 ? ARCADE_INK[2] : ARCADE_INK[1];
      ctx.fillRect(X(wx), 31, 4, 3);
    }
    // vault
    const vx = X(348);
    ctx.fillStyle = ARCADE_INK[2];
    ctx.fillRect(vx, 36, 14, 14);
    ctx.fillStyle = ARCADE_INK[1];
    ctx.fillRect(vx + 1, 37, 12, 12);
    drawArcadeCircle(ctx, vx + 7, 43, 3, ARCADE_INK[2]);
    if (t > 15600) {
      ctx.fillStyle = ARCADE_INK[2];
      ctx.fillRect(vx - 6, 36, 6, 14);
      if (t < 18500) {
        ctx.fillStyle = Math.floor(now / 150) % 2 === 0 ? ARCADE_INK[3] : ARCADE_INK[2];
        ctx.fillRect(vx + 5, 41, 5, 5);
      }
    }
  }

  // ---- ACT 3: the closing gate, and the pursuer ----
  if (t > 22000 && onScreen(560, 60)) {
    const p = arcadeClamp01((t - 22000) / 3200);
    const gh = Math.round(p * 28);
    ctx.fillStyle = ARCADE_INK[2];
    ctx.fillRect(X(556), 20, 2, SPY_GROUND_Y - 20);
    ctx.fillRect(X(600), 20, 2, SPY_GROUND_Y - 20);
    ctx.fillRect(X(556), 20, 46, 2);
    for (let i = 0; i < gh; i += 3) ctx.fillRect(X(558), 22 + i, 42, 1);
  }
  if (t > 24500) {
    const chaseX = arcadePath([[24500, 420], [31000, 700]], t);
    if (onScreen(chaseX, 30)) {
      drawArcadeSprite(ctx, SPY_CAR, X(chaseX), SPY_GROUND_Y - 7, 1, ARCADE_INK[1]);
      if (flash) {
        ctx.fillStyle = ARCADE_INK[3];
        ctx.fillRect(X(chaseX) + 6, SPY_GROUND_Y - 11, 2, 2);
      }
    }
  }

  // ---- the agent ----
  let agentWorld = spyAgentWorldX(t);
  let sprite = SPY_AGENT;
  let agentVisible = t < 24600;
  if (t > 4200 && t < 5200) sprite = SPY_AGENT_CROUCH; // ducks a sweep
  else if (t > 7600 && t < 9200) sprite = SPY_AGENT_CROUCH; // placing the gadget
  else if (t > 11400 && t < 12900) sprite = SPY_AGENT_CROUCH; // hides from the guard
  else if (t > 18500) sprite = Math.floor(t / 130) % 2 === 0 ? SPY_AGENT_RUN : SPY_AGENT;
  else if (t > 3000 && t < 14500) sprite = Math.floor(t / 210) % 2 === 0 ? SPY_AGENT_RUN : SPY_AGENT;

  if (agentVisible && onScreen(agentWorld, 20)) {
    drawArcadeSprite(ctx, sprite, X(agentWorld), SPY_GROUND_Y - sprite.length, 1);
    // the stolen tile, once taken, stays visibly in hand for the rest of it
    if (t > 17400) {
      ctx.fillStyle = Math.floor(now / 150) % 2 === 0 ? ARCADE_INK[3] : ARCADE_INK[2];
      ctx.fillRect(X(agentWorld) - 2, SPY_GROUND_Y - sprite.length - 3, 4, 4);
    }
  }

  // ---- ACT 4: the car, the dock, and the payoff ----
  const carWorld = arcadePath(
    [
      [20000, 620],
      [23200, 505],
      [24400, 505],
      [28600, 800],
      [30000, 872],
      [32000, 940],
    ],
    t
  );
  const launched = t > 24400;

  // the dock and the water beyond it
  if (onScreen(840, 140)) {
    ctx.fillStyle = ARCADE_INK[2];
    ctx.fillRect(X(700), SPY_GROUND_Y, Math.max(0, X(846) - X(700)), 1);
    ctx.fillStyle = ARCADE_INK[1];
    for (let i = 0; i < 5; i++) ctx.fillRect(X(760 + i * 20), SPY_GROUND_Y + 1, 2, 6);
    // sea
    for (let x = Math.max(0, X(846)); x < ARCADE_WIDTH; x++) {
      const wy = SPY_GROUND_Y + 4 + Math.round(Math.sin((x + cam * 0.6 + now / 90) / 6) * 1.6);
      ctx.fillStyle = ARCADE_INK[2];
      ctx.fillRect(x, wy, 1, 1);
      ctx.fillStyle = ARCADE_INK[1];
      ctx.fillRect(x, wy + 5, 1, 1);
    }
  }

  if (t > 20000 && onScreen(carWorld, 40)) {
    // arc off the end of the dock, then submerge
    let carY = SPY_GROUND_Y - 7;
    let submerged = false;
    if (t > 29300) {
      const p = arcadeClamp01((t - 29300) / 900);
      carY = SPY_GROUND_Y - 7 - Math.round(Math.sin(p * Math.PI) * 9) + Math.round(p * 14);
      submerged = p >= 1;
    }
    if (!submerged) {
      drawArcadeSprite(ctx, SPY_CAR, X(carWorld), Math.round(carY), 1);
      if (launched) {
        ctx.fillStyle = ARCADE_INK[1];
        for (let i = 1; i <= 5; i++) ctx.fillRect(X(carWorld) - i * 8 - 4, Math.round(carY) + 3 + (i % 2), 6, 1);
      }
    } else {
      // PAYOFF: it surfaces as a submersible — hull, conning tower, periscope,
      // and the stolen tile still glowing behind the canopy.
      const subY = SPY_GROUND_Y + 8;
      ctx.fillStyle = ARCADE_INK[2];
      ctx.fillRect(X(carWorld) + 1, subY, 16, 4);
      ctx.fillRect(X(carWorld) + 5, subY - 3, 6, 3);
      ctx.fillStyle = ARCADE_INK[3];
      ctx.fillRect(X(carWorld) + 7, subY - 8, 1, 5);
      ctx.fillRect(X(carWorld) + 7, subY - 9, 3, 1);
      ctx.fillRect(X(carWorld) + 12, subY + 1, 2, 2);
      // bubbles
      ctx.fillStyle = ARCADE_INK[1];
      for (let i = 0; i < 5; i++) {
        const ph = (now / 700 + i * 0.2) % 1;
        ctx.fillRect(X(carWorld) - 3 - i * 3, subY + 2 - Math.round(ph * 6), 1, 1);
      }
    }
    // the splash as it hits
    if (t > 29900 && t < 30600) {
      const p = (t - 29900) / 700;
      ctx.fillStyle = p < 0.5 ? ARCADE_INK[3] : ARCADE_INK[2];
      for (let i = 0; i < 9; i++) {
        ctx.fillRect(
          X(carWorld) + 8 + Math.round((i - 4) * p * 9),
          SPY_GROUND_Y + 6 - Math.round(Math.sin(p * Math.PI) * 12) + Math.abs(i - 4),
          1,
          2
        );
      }
    }
  }
}

// ---- SCENE: aquarium ------------------------------------------------------
//
// The calm one. No story, no payoff to wait for — the brief is simply "this is
// a nice little aquarium", so the design goal was continuous life rather than
// progression.
//
// SEAMLESS LOOP: every fish's motion is a pure function of scene time whose
// period divides AQUARIUM_DURATION_MS exactly (32s / 1, 2 or 4). At t=duration
// every swimmer is therefore back where it began, so the wrap is invisible
// even on a load long enough to replay it several times. Bubbles and seaweed
// key off `now` instead and are continuous by construction.
const AQUARIUM_DURATION_MS = 32000;
const AQ_FLOOR_Y = 54;

// Fish silhouettes, deliberately unalike: a plain swimmer, a tall round one,
// a tiny dart, a long slow cruiser, and a flat bottom-dweller.
const AQ_FISH_S = [".22.", "2222", "3222", ".22."];
const AQ_FISH_S_L = [".22.", "2222", "2223", ".22."];
const AQ_FISH_ROUND = ["..222..", ".22222.", "3222222", ".222222", "..2222."];
const AQ_FISH_TINY = ["22.", "323"];
const AQ_FISH_BIG = [
  "....22222....",
  "..222222222..",
  ".32222222222.",
  "3222222222222",
  ".32222222222.",
  "..222222222..",
  "....22222....",
];
const AQ_FISH_FLAT = [".2222.", "322222", ".2222."];

// The landmark: a little sunken ship, listing to port with a snapped mast,
// two portholes and a half-buried bow.
const AQ_WRECK = [
  "..........3..........",
  ".........3...........",
  "........3............",
  "......33.............",
  ".....3...............",
  "..3333333333333......",
  ".3.2.....2....33.....",
  "33333333333333333....",
  "..3333333333333333...",
];

function aqFish(t, period, phase) {
  // 0..1, wrapping. Period divides the scene duration so the loop is clean.
  return ((t / period + phase) % 1 + 1) % 1;
}

function drawAqSeaweed(ctx, baseX, height, now, seed) {
  for (let i = 0; i < height; i++) {
    const sway = Math.sin(now / 900 + seed + i / 3.2) * (i / height) * 3.5;
    ctx.fillStyle = i > height - 3 ? ARCADE_INK[2] : ARCADE_INK[1];
    ctx.fillRect(Math.round(baseX + sway), AQ_FLOOR_Y - i, 2, 1);
  }
}

function drawAquariumScene(ctx, state, t, now) {
  // tank glass
  ctx.fillStyle = ARCADE_INK[1];
  ctx.fillRect(0, 1, ARCADE_WIDTH, 1);
  ctx.fillRect(0, 0, 1, ARCADE_HEIGHT);
  ctx.fillRect(ARCADE_WIDTH - 1, 0, 1, ARCADE_HEIGHT);
  // surface shimmer
  for (let x = 2; x < ARCADE_WIDTH - 2; x += 2) {
    const s = Math.sin((x + now / 40) / 7) > 0.3;
    ctx.fillStyle = s ? ARCADE_INK[2] : ARCADE_INK[1];
    ctx.fillRect(x, 3, 1, 1);
  }

  // gravel + rocks
  ctx.fillStyle = ARCADE_INK[1];
  for (let x = 1; x < ARCADE_WIDTH - 1; x++) {
    const h = 4 + Math.round(Math.sin(x / 13) * 1.6 + Math.sin(x / 5) * 0.9);
    ctx.fillRect(x, ARCADE_HEIGHT - h, 1, h);
  }
  ctx.fillStyle = ARCADE_INK[2];
  for (let x = 3; x < ARCADE_WIDTH; x += 7) ctx.fillRect(x, AQ_FLOOR_Y + 4, 2, 1);
  // a couple of boulders
  for (const [bx, bw] of [[18, 9], [96, 7]]) {
    ctx.fillStyle = ARCADE_INK[1];
    ctx.fillRect(bx, AQ_FLOOR_Y - 1, bw, 5);
    ctx.fillRect(bx + 1, AQ_FLOOR_Y - 3, bw - 2, 3);
    ctx.fillStyle = ARCADE_INK[2];
    ctx.fillRect(bx + 1, AQ_FLOOR_Y - 3, bw - 2, 1);
  }

  drawAqSeaweed(ctx, 8, 22, now, 0);
  drawAqSeaweed(ctx, 12, 15, now, 1.4);
  drawAqSeaweed(ctx, 140, 26, now, 2.1);
  drawAqSeaweed(ctx, 146, 17, now, 3.3);
  drawAqSeaweed(ctx, 70, 12, now, 4.7);

  // the sunken ship, the tank's landmark
  const wreckX = 46;
  const wreckY = AQ_FLOOR_Y - AQ_WRECK.length + 3;
  drawArcadeSprite(ctx, AQ_WRECK, wreckX, wreckY, 1);
  // it burps a bubble now and then, from the same porthole
  const burp = (now / 2600) % 1;
  if (burp < 0.5) {
    ctx.fillStyle = ARCADE_INK[2];
    ctx.fillRect(wreckX + 4, wreckY + 6 - Math.round(burp * 2 * 26), 1, 1);
  }

  // air stone, bottom left — a continuous column, the tank's heartbeat
  ctx.fillStyle = ARCADE_INK[2];
  ctx.fillRect(30, AQ_FLOOR_Y + 3, 5, 2);
  for (let i = 0; i < 9; i++) {
    const ph = ((now / 1500 + i * 0.111) % 1);
    const by = AQ_FLOOR_Y + 2 - Math.round(ph * (AQ_FLOOR_Y - 2));
    ctx.fillStyle = ph > 0.7 ? ARCADE_INK[1] : ARCADE_INK[2];
    ctx.fillRect(32 + Math.round(Math.sin(ph * 9 + i) * 2), by, 1, 1);
  }

  // ---- fish ----
  // Big slow cruiser, right to left, one full traverse per loop.
  {
    const p = aqFish(t, AQUARIUM_DURATION_MS, 0.15);
    const x = ARCADE_WIDTH + 16 - p * (ARCADE_WIDTH + 34);
    const y = 20 + Math.sin(p * Math.PI * 4) * 5;
    drawArcadeSprite(ctx, AQ_FISH_BIG, Math.round(x), Math.round(y), 1);
    // tail beat
    ctx.fillStyle = ARCADE_INK[2];
    const tw = Math.abs(Math.sin(now / 340)) > 0.5 ? 3 : 2;
    ctx.fillRect(Math.round(x) + 13, Math.round(y) + 2, tw, 3);

    // THE GAG: a tiny fish tucks in behind the cruiser and tags along, then
    // loses interest and peels off.
    const follow = p > 0.28 && p < 0.62;
    if (follow) {
      const fx = x + 17 + Math.sin(now / 300) * 2;
      drawArcadeSprite(ctx, AQ_FISH_TINY, Math.round(fx), Math.round(y + 3), 1);
    }
  }

  // Round fish, left to right, twice per loop, bobbing.
  {
    const p = aqFish(t, AQUARIUM_DURATION_MS / 2, 0.6);
    const x = -10 + p * (ARCADE_WIDTH + 22);
    const y = 32 + Math.sin(p * Math.PI * 6) * 6;
    drawArcadeSprite(ctx, AQ_FISH_ROUND, Math.round(x), Math.round(y), 1);
  }

  // Two small fish loosely schooling, right to left, twice per loop.
  for (let i = 0; i < 2; i++) {
    const p = aqFish(t, AQUARIUM_DURATION_MS / 2, 0.05 + i * 0.06);
    const x = ARCADE_WIDTH + 8 - p * (ARCADE_WIDTH + 20);
    const y = 12 + i * 5 + Math.sin(p * Math.PI * 8 + i) * 3;
    drawArcadeSprite(ctx, AQ_FISH_S_L, Math.round(x), Math.round(y), 1);
  }

  // Tiny darter: four traversals, moves in bursts then coasts.
  {
    const p = aqFish(t, AQUARIUM_DURATION_MS / 4, 0.33);
    const burst = Math.min(1, Math.max(0, (Math.sin(p * Math.PI * 6) + 1) / 2));
    const x = -6 + (p * 0.75 + burst * 0.25) * (ARCADE_WIDTH + 14);
    const y = 40 + Math.sin(p * Math.PI * 10) * 4;
    drawArcadeSprite(ctx, AQ_FISH_TINY, Math.round(x), Math.round(y), 1);
  }

  // Bottom-dweller, hugging the gravel, one slow pass per loop.
  {
    const p = aqFish(t, AQUARIUM_DURATION_MS, 0.72);
    const x = -8 + p * (ARCADE_WIDTH + 18);
    const y = AQ_FLOOR_Y - 3 + Math.sin(p * Math.PI * 12) * 1.2;
    drawArcadeSprite(ctx, AQ_FISH_FLAT, Math.round(x), Math.round(y), 1);
  }

  // A shy one that peeks out of the wreck and thinks better of it.
  {
    const ph = (t / (AQUARIUM_DURATION_MS / 2)) % 1;
    if (ph > 0.55 && ph < 0.78) {
      const out = Math.sin(((ph - 0.55) / 0.23) * Math.PI) * 6;
      drawArcadeSprite(ctx, AQ_FISH_S, Math.round(wreckX + 8 + out), wreckY + 5, 1);
    }
  }
}

// ---- SCENE: first-person drive --------------------------------------------
//
// The purest living diorama in the pool: the cockpit never moves at all, and
// every bit of motion comes from the world beyond the glass. The road is
// drawn with pseudo-3D scanlines — each screen row is a depth, so one
// curvature value bends the whole road AND slides the roadside furniture
// without anything being animated individually.
//
// PERFECT LOOP: curvature is sin() over exactly two cycles of the duration
// and the scroll distance over one duration is a whole multiple of the lane
// -marking period, so at t=duration every dash, pole and bend is exactly
// where it was at t=0.
const DRIVE_DURATION_MS = 33000;
const DRIVE_HORIZON = 22;
const DRIVE_DASH_PERIOD = 2;
const DRIVE_SPEED = 0.02;

// -1 hard left .. +1 hard right, returning to 0 at both ends of the loop.
function driveCurve(t) {
  const p = t / DRIVE_DURATION_MS;
  return Math.sin(p * Math.PI * 4) * 0.72 + Math.sin(p * Math.PI * 8) * 0.18;
}

function drawDriveScene(ctx, state, t, now) {
  const curve = driveCurve(t);
  const travel = t * DRIVE_SPEED;
  const dashBottom = 62;

  // ---- sky + distant hills ----
  ctx.fillStyle = ARCADE_INK[1];
  for (let i = 0; i < 12; i++) {
    const sx = ((i * 61 - curve * 30) % 170 + 170) % 170 - 5;
    ctx.fillRect(Math.round(sx), 4 + ((i * 17) % 9), 1, 1);
  }
  for (let x = 0; x < ARCADE_WIDTH; x++) {
    const h = 4 + Math.round(Math.sin((x + curve * 26) / 31) * 3 + Math.sin((x + curve * 26) / 13) * 1.4);
    ctx.fillStyle = ARCADE_INK[1];
    ctx.fillRect(x, DRIVE_HORIZON - h, 1, h);
  }
  ctx.fillStyle = ARCADE_INK[2];
  ctx.fillRect(0, DRIVE_HORIZON, ARCADE_WIDTH, 1);

  // ---- the road, one scanline per depth ----
  const centreAt = (d) => 80 + curve * (620 / (d + 6));
  for (let y = DRIVE_HORIZON + 1; y <= dashBottom; y++) {
    const d = y - DRIVE_HORIZON;
    const half = 2 + d * 2.05;
    const cxr = centreAt(d);
    // verge + edge lines
    ctx.fillStyle = ARCADE_INK[2];
    ctx.fillRect(Math.round(cxr - half), y, 2, 1);
    ctx.fillRect(Math.round(cxr + half - 1), y, 2, 1);
    // road surface tone, kept dim so the markings stay the brightest thing
    if (d % 3 === 0) {
      ctx.fillStyle = ARCADE_INK[1];
      ctx.fillRect(Math.round(cxr - half + 2), y, Math.max(1, Math.round(half * 2 - 4)), 1);
    }
    // centre dashes: world distance for this row, scrolling toward the viewer
    const worldZ = 260 / d + travel;
    if (worldZ % (DRIVE_DASH_PERIOD * 2) < DRIVE_DASH_PERIOD) {
      ctx.fillStyle = ARCADE_INK[3];
      const w = Math.max(1, Math.round(d / 9));
      ctx.fillRect(Math.round(cxr - w / 2), y, w, 1);
    }
  }

  // ---- roadside furniture: poles marching past on both shoulders ----
  for (let i = 0; i < 9; i++) {
    const z = ((i * 6 - travel) % 54 + 54) % 54 + 2;
    const d = 260 / z;
    if (d < 1.5 || d > 42) continue;
    const y = DRIVE_HORIZON + d;
    if (y > dashBottom) continue;
    const half = 2 + d * 2.05;
    const cxr = centreAt(d);
    const hgt = Math.max(2, Math.round(d * 0.62));
    for (const side of [-1, 1]) {
      const px = Math.round(cxr + side * (half + 3 + d * 0.16));
      if (px < -4 || px > ARCADE_WIDTH + 4) continue;
      ctx.fillStyle = ARCADE_INK[1];
      ctx.fillRect(px, Math.round(y) - hgt, Math.max(1, Math.round(d / 22)), hgt);
      // reflective marker catching the headlights
      ctx.fillStyle = d > 12 ? ARCADE_INK[3] : ARCADE_INK[2];
      ctx.fillRect(px, Math.round(y) - Math.round(hgt * 0.5), Math.max(1, Math.round(d / 20)), 1);
    }
  }

  // ---- cockpit: absolutely fixed, the anchor the whole scene reads from ----
  const dashTop = 44;
  // A-pillars + roof line
  ctx.fillStyle = ARCADE_INK[2];
  ctx.fillRect(0, 0, 6, dashTop);
  ctx.fillRect(ARCADE_WIDTH - 6, 0, 6, dashTop);
  ctx.fillRect(0, 0, ARCADE_WIDTH, 2);
  ctx.fillStyle = ARCADE_INK[1];
  ctx.fillRect(6, 2, ARCADE_WIDTH - 12, 1);

  // dashboard slab
  ctx.fillStyle = ARCADE_INK[1];
  ctx.fillRect(0, dashTop, ARCADE_WIDTH, ARCADE_HEIGHT - dashTop);
  ctx.fillStyle = ARCADE_INK[2];
  ctx.fillRect(0, dashTop, ARCADE_WIDTH, 1);

  // speedometer + tachometer, needles alive but calm
  for (const [gx, gy, gr, base, swing, rate] of [
    [26, 54, 8, 0.62, 0.06, 1900],
    [46, 55, 6, 0.5, 0.09, 1300],
  ]) {
    drawArcadeCircle(ctx, gx, gy, gr, ARCADE_INK[2]);
    for (let i = 0; i <= 5; i++) {
      const a = Math.PI * (0.82 + (i / 5) * 1.36);
      ctx.fillStyle = ARCADE_INK[1];
      ctx.fillRect(Math.round(gx + Math.cos(a) * (gr - 1)), Math.round(gy + Math.sin(a) * (gr - 1)), 1, 1);
    }
    const v = base + Math.sin(now / rate) * swing;
    const a = Math.PI * (0.82 + v * 1.36);
    drawArcadeLine(ctx, gx, gy, gx + Math.cos(a) * (gr - 2), gy + Math.sin(a) * (gr - 2), ARCADE_INK[3]);
  }
  // odometer digits
  drawArcadeNumber(ctx, 20 + (Math.floor(t / 900) % 80), 8, 50, ARCADE_INK[2]);
  // indicator lamps
  for (let i = 0; i < 3; i++) {
    const on = i === 0 ? Math.floor(now / 700) % 2 === 0 : i === 1;
    ctx.fillStyle = on ? ARCADE_INK[3] : ARCADE_INK[1];
    ctx.fillRect(58 + i * 5, 47, 3, 3);
  }

  // ---- steering wheel: rim + spokes, rotating with the bend ----
  const wcx = 112;
  const wcy = 62;
  const wr = 17;
  const rot = -curve * 0.5;
  drawArcadeCircle(ctx, wcx, wcy, wr, ARCADE_INK[3]);
  drawArcadeCircle(ctx, wcx, wcy, wr - 1, ARCADE_INK[2]);
  drawArcadeCircle(ctx, wcx, wcy, 3, ARCADE_INK[3]);
  for (let s = 0; s < 3; s++) {
    const a = rot + Math.PI + (s * Math.PI * 2) / 3;
    drawArcadeLine(ctx, wcx + Math.cos(a) * 3, wcy + Math.sin(a) * 3, wcx + Math.cos(a) * (wr - 1), wcy + Math.sin(a) * (wr - 1), ARCADE_INK[2]);
  }
  // grip mark, so the rotation is unmistakable
  ctx.fillStyle = ARCADE_INK[3];
  ctx.fillRect(Math.round(wcx + Math.cos(rot - Math.PI / 2) * (wr - 2)) - 1, Math.round(wcy + Math.sin(rot - Math.PI / 2) * (wr - 2)) - 1, 3, 3);
}

// ---- SCENE: control room --------------------------------------------------
//
// A wall of analog instrumentation that never moves; everything interesting
// happens inside the gauges. Grouped deliberately — meters left, scope
// centre, status column and lever right — so it reads as a console rather
// than a scatter of shapes.
const CTRL_DURATION_MS = 31000;

// One escalation, competently handled: a level creeps up, the warning lamp
// lights, the trace goes unstable, an operator reaches in and corrects it,
// everything settles and the status column goes fully lit.
function ctrlAlarm(t) {
  if (t < 9000) return 0;
  if (t < 13000) return (t - 9000) / 4000;
  if (t < 17500) return 1;
  if (t < 20500) return 1 - (t - 17500) / 3000;
  return 0;
}

function drawControlScene(ctx, state, t, now) {
  const alarm = ctrlAlarm(t);
  const settled = t > 21500;

  // console surface + panel frame
  ctx.fillStyle = ARCADE_INK[1];
  ctx.fillRect(0, 0, ARCADE_WIDTH, ARCADE_HEIGHT);
  ctx.fillStyle = ARCADE_BG;
  ctx.fillRect(2, 2, ARCADE_WIDTH - 4, 50);
  ctx.fillStyle = ARCADE_INK[2];
  ctx.fillRect(2, 2, ARCADE_WIDTH - 4, 1);
  ctx.fillRect(2, 51, ARCADE_WIDTH - 4, 1);
  ctx.fillRect(2, 2, 1, 50);
  ctx.fillRect(ARCADE_WIDTH - 3, 2, 1, 50);
  // desk lip
  ctx.fillStyle = ARCADE_INK[2];
  ctx.fillRect(0, 54, ARCADE_WIDTH, 1);
  ctx.fillStyle = ARCADE_INK[1];
  ctx.fillRect(0, 58, ARCADE_WIDTH, 1);

  // ---- LEFT: three round gauges, the middle one is the one that climbs ----
  for (let i = 0; i < 3; i++) {
    const gx = 15 + i * 22;
    const gy = 16;
    drawArcadeCircle(ctx, gx, gy, 10, ARCADE_INK[2]);
    for (let k = 0; k <= 6; k++) {
      const a = Math.PI * (0.8 + (k / 6) * 1.4);
      ctx.fillStyle = k > 4 ? ARCADE_INK[3] : ARCADE_INK[1];
      ctx.fillRect(Math.round(gx + Math.cos(a) * 8), Math.round(gy + Math.sin(a) * 8), 1, 1);
    }
    let v = 0.32 + Math.sin(now / (1400 + i * 500) + i) * 0.1;
    if (i === 1) v = 0.32 + alarm * 0.6;
    const a = Math.PI * (0.8 + v * 1.4);
    drawArcadeLine(ctx, gx, gy, gx + Math.cos(a) * 7, gy + Math.sin(a) * 7, i === 1 && alarm > 0.5 ? ARCADE_INK[3] : ARCADE_INK[2]);
    ctx.fillStyle = ARCADE_INK[1];
    ctx.fillRect(gx - 1, gy - 1, 3, 3);
  }

  // ---- LEFT-LOWER: bar meters fluctuating ----
  for (let i = 0; i < 7; i++) {
    const bx = 8 + i * 6;
    ctx.fillStyle = ARCADE_INK[1];
    ctx.fillRect(bx, 32, 3, 14);
    const h = Math.round((0.35 + Math.abs(Math.sin(now / (700 + i * 130) + i)) * 0.45 + alarm * 0.2) * 14);
    ctx.fillStyle = h > 11 ? ARCADE_INK[3] : ARCADE_INK[2];
    ctx.fillRect(bx, 46 - h, 3, h);
  }

  // ---- CENTRE: oscilloscope ----
  const ox = 84;
  const oy = 8;
  const ow = 44;
  const oh = 26;
  ctx.fillStyle = ARCADE_INK[2];
  ctx.fillRect(ox, oy, ow, 1);
  ctx.fillRect(ox, oy + oh, ow, 1);
  ctx.fillRect(ox, oy, 1, oh);
  ctx.fillRect(ox + ow - 1, oy, 1, oh);
  ctx.fillStyle = ARCADE_INK[1];
  for (let x = ox + 6; x < ox + ow; x += 8) ctx.fillRect(x, oy + 2, 1, oh - 4);
  for (let y = oy + 6; y < oy + oh; y += 7) ctx.fillRect(ox + 2, y, ow - 4, 1);
  // the trace: a clean sine that goes ragged under alarm
  let prevY = null;
  for (let x = 2; x < ow - 2; x++) {
    const ph = (x + now / 26) / 7;
    const noise = alarm * (Math.sin(ph * 5.3) * 4 + Math.sin(ph * 11.7) * 3);
    const yy = oy + oh / 2 + Math.sin(ph) * (5 + alarm * 3) + noise;
    const cy2 = Math.max(oy + 2, Math.min(oy + oh - 2, Math.round(yy)));
    ctx.fillStyle = alarm > 0.5 ? ARCADE_INK[3] : ARCADE_INK[2];
    if (prevY !== null) {
      const lo = Math.min(prevY, cy2);
      const hi = Math.max(prevY, cy2);
      ctx.fillRect(ox + x, lo, 1, hi - lo + 1);
    } else ctx.fillRect(ox + x, cy2, 1, 1);
    prevY = cy2;
  }

  // ---- RIGHT: warning lamp, status column, rotary selector, lever ----
  const warn = alarm > 0.35 && Math.floor(now / 190) % 2 === 0;
  ctx.fillStyle = warn ? ARCADE_INK[3] : ARCADE_INK[1];
  ctx.fillRect(134, 8, 12, 7);
  ctx.fillStyle = ARCADE_INK[2];
  ctx.fillRect(134, 8, 12, 1);
  ctx.fillRect(134, 14, 12, 1);

  // status column — all lit once the system is settled, the small payoff
  for (let i = 0; i < 5; i++) {
    const lit = settled || i < 3 - Math.round(alarm * 2);
    ctx.fillStyle = lit ? ARCADE_INK[3] : ARCADE_INK[1];
    ctx.fillRect(134, 19 + i * 5, 4, 3);
    ctx.fillStyle = ARCADE_INK[1];
    ctx.fillRect(140, 19 + i * 5, 6, 3);
  }

  // rotary selector, clicking round one step at a time
  const sel = 20 + Math.floor(t / 3400) % 6;
  drawArcadeCircle(ctx, 70, 42, 7, ARCADE_INK[2]);
  const sa = (sel % 6) * (Math.PI / 3);
  drawArcadeLine(ctx, 70, 42, 70 + Math.cos(sa) * 5, 42 + Math.sin(sa) * 5, ARCADE_INK[3]);

  // toggle switches, one of which flips mid-scene
  for (let i = 0; i < 6; i++) {
    const sx = 88 + i * 8;
    ctx.fillStyle = ARCADE_INK[1];
    ctx.fillRect(sx, 38, 5, 9);
    const up = i === 2 ? t < 17800 : i % 2 === 0;
    ctx.fillStyle = ARCADE_INK[3];
    ctx.fillRect(sx + 1, up ? 39 : 43, 3, 3);
  }

  // ---- the operator: one hand, used twice and never more ----
  const reach = t > 16400 && t < 19200;
  if (reach) {
    const p = arcadeClamp01((t - 16400) / 700) - arcadeClamp01((t - 18200) / 800);
    const hy = 62 - Math.round(p * 22);
    ctx.fillStyle = ARCADE_INK[2];
    ctx.fillRect(100, hy, 7, 64 - hy);
    ctx.fillStyle = ARCADE_INK[1];
    ctx.fillRect(100, hy, 7, 1);
    ctx.fillStyle = ARCADE_INK[2];
    ctx.fillRect(97, hy, 5, 4);
  }
}

// ---- SCENE: tape machine --------------------------------------------------
// A front-facing hybrid of a reel-to-reel and a cassette deck. Eight whole
// reel turns in each direction make both reverse points and the loop seam
// mechanically continuous rather than hiding a reset.
const TAPE_DURATION_MS = 34000;

function tapePlayback(t) {
  if (t < 15800) return { position: t / 15800, direction: 1, running: 1 };
  if (t < 17000) return { position: 1, direction: 1, running: 0 };
  if (t < 32800) return { position: 1 - (t - 17000) / 15800, direction: -1, running: 1 };
  return { position: 0, direction: -1, running: 0 };
}

function drawTapeReel(ctx, cx, cy, packRadius, angle, markerOffset) {
  drawArcadeCircle(ctx, cx, cy, 17, ARCADE_INK[2]);
  drawArcadeCircle(ctx, cx, cy, 15, ARCADE_INK[1]);
  drawArcadeCircle(ctx, cx, cy, packRadius, ARCADE_INK[2]);
  drawArcadeCircle(ctx, cx, cy, 4, ARCADE_INK[3]);
  // Five spokes plus one offset bright stud make even a small rotation clear.
  for (let i = 0; i < 5; i++) {
    const a = angle + (i * Math.PI * 2) / 5;
    drawArcadeLine(ctx, cx + Math.cos(a) * 5, cy + Math.sin(a) * 5,
      cx + Math.cos(a) * 14, cy + Math.sin(a) * 14, i === 0 ? ARCADE_INK[3] : ARCADE_INK[2]);
  }
  const ma = angle + markerOffset;
  ctx.fillStyle = ARCADE_INK[3];
  ctx.fillRect(Math.round(cx + Math.cos(ma) * 11) - 1, Math.round(cy + Math.sin(ma) * 11) - 1, 2, 2);
}

function drawTapeVu(ctx, left, top, value) {
  ctx.fillStyle = ARCADE_INK[2];
  ctx.fillRect(left, top, 39, 1);
  ctx.fillRect(left, top + 11, 39, 1);
  ctx.fillRect(left, top, 1, 12);
  ctx.fillRect(left + 38, top, 1, 12);
  ctx.fillStyle = ARCADE_INK[1];
  for (let i = 0; i < 6; i++) ctx.fillRect(left + 5 + i * 6, top + 2, 1, 2 + (i > 3 ? 1 : 0));
  const pivotX = left + 19;
  const pivotY = top + 10;
  const a = Math.PI * (1.15 + value * 0.7);
  drawArcadeLine(ctx, pivotX, pivotY, pivotX + Math.cos(a) * 14, pivotY + Math.sin(a) * 14, ARCADE_INK[3]);
  ctx.fillStyle = ARCADE_INK[2];
  ctx.fillRect(pivotX - 1, pivotY - 1, 3, 2);
}

function drawTapeMachineScene(ctx, state, t) {
  const play = tapePlayback(t);
  const turns = play.position * Math.PI * 16;
  const leftPack = Math.round(12 - play.position * 5);
  const rightPack = Math.round(7 + play.position * 5);

  // Full-frame faceplate, screws and separator rails establish one machine.
  ctx.fillStyle = ARCADE_INK[1];
  ctx.fillRect(1, 1, 158, 62);
  ctx.fillStyle = ARCADE_BG;
  ctx.fillRect(3, 3, 154, 58);
  ctx.fillStyle = ARCADE_INK[2];
  ctx.fillRect(3, 38, 154, 1);
  for (const [x, y] of [[5, 5], [154, 5], [5, 58], [154, 58]]) drawArcadeCircle(ctx, x, y, 1, ARCADE_INK[2]);

  drawTapeReel(ctx, 48, 20, leftPack, turns, 0.35);
  drawTapeReel(ctx, 109, 20, rightPack, turns, 1.55);

  // Tape leaves each pack tangentially, passes over guides and across the
  // head/capstan block. Every segment terminates on a visible mechanism.
  drawArcadeLine(ctx, 48, 20 + leftPack, 63, 35, ARCADE_INK[3]);
  drawArcadeCircle(ctx, 65, 35, 2, ARCADE_INK[2]);
  drawArcadeLine(ctx, 67, 35, 75, 37, ARCADE_INK[3]);
  ctx.fillStyle = ARCADE_INK[2];
  ctx.fillRect(75, 34, 18, 5);
  ctx.fillStyle = ARCADE_BG;
  ctx.fillRect(79, 34, 3, 3);
  ctx.fillRect(86, 34, 3, 3);
  drawArcadeCircle(ctx, 94, 35, 2, ARCADE_INK[2]);
  drawArcadeLine(ctx, 93, 37, 107, 20 + rightPack, ARCADE_INK[3]);
  ctx.fillStyle = ARCADE_INK[3];
  ctx.fillRect(82, 36, 4, 1);

  const waking = play.running ? Math.min(1, t < 17000 ? t / 450 : (t - 17000) / 450) : 0;
  const leftVu = waking * arcadeClamp01(0.38 + Math.sin(t / 510) * 0.16 + Math.sin(t / 137) * 0.1 + (Math.sin(t / 2400) > 0.88 ? 0.22 : 0));
  const rightVu = waking * arcadeClamp01(0.44 + Math.sin(t / 670 + 1.7) * 0.14 + Math.sin(t / 181) * 0.08 + (Math.sin(t / 3100 + 2) > 0.91 ? 0.2 : 0));
  drawTapeVu(ctx, 7, 42, leftVu);
  drawTapeVu(ctx, 49, 42, rightVu);

  // Four-digit mechanical counter tracks tape position in both directions.
  ctx.fillStyle = ARCADE_INK[1];
  ctx.fillRect(93, 42, 23, 10);
  ctx.fillStyle = ARCADE_BG;
  ctx.fillRect(95, 44, 19, 6);
  const counter = 372 + Math.floor(play.position * 13);
  drawArcadeNumber(ctx, String(counter).padStart(4, "0"), 97, 44, ARCADE_INK[3]);

  // Direction, record lamp and cassette-style transport bank.
  ctx.fillStyle = play.direction > 0 ? ARCADE_INK[3] : ARCADE_INK[1];
  drawArcadeLine(ctx, 121, 44, 126, 47, ctx.fillStyle);
  drawArcadeLine(ctx, 121, 50, 126, 47, ctx.fillStyle);
  ctx.fillStyle = play.direction < 0 ? ARCADE_INK[3] : ARCADE_INK[1];
  drawArcadeLine(ctx, 133, 44, 128, 47, ctx.fillStyle);
  drawArcadeLine(ctx, 133, 50, 128, 47, ctx.fillStyle);
  ctx.fillStyle = ARCADE_INK[1];
  ctx.fillRect(139, 43, 4, 4);
  ctx.fillStyle = play.running ? ARCADE_INK[3] : ARCADE_INK[1];
  ctx.fillRect(146, 43, 7, 4);
  for (let i = 0; i < 5; i++) {
    ctx.fillStyle = i === 1 && play.running ? ARCADE_INK[3] : ARCADE_INK[2];
    ctx.fillRect(119 + i * 7, 54, 5, 5);
  }
  ctx.fillStyle = ARCADE_BG;
  ctx.fillRect(120, 56, 2, 1); // rewind
  ctx.fillRect(127, 55, 1, 3); // play
  ctx.fillRect(134, 55, 3, 3); // stop
  ctx.fillRect(142, 56, 2, 1); // fast-forward
  drawArcadeCircle(ctx, 150, 56, 1, play.running ? ARCADE_INK[1] : ARCADE_INK[3]); // record/click lamp
}

// ---- the pool -------------------------------------------------------------
//
// A scene is a plain object. `create`/`update` are optional — scenes whose
// choreography is a pure function of scene time (Bigfoot, UFO, Pirate) omit
// them entirely, which is why only Starfighter and Projector carry mutable
// state at all.
//   durationMs  full loop length; ~15s so a small load sees a meaningful
//               chunk, a typical load sees most of one, and a big load
//               repeats only a couple of times.
//   stillAtMs   the moment rendered for prefers-reduced-motion. Chosen per
//               scene as its strongest single frame.
//   fade        alpha used to repaint the background each frame. Lower keeps
//               more phosphor trail. Fast-moving scenes want the smear;
//               character scenes want a crisper silhouette, so Bigfoot and
//               Projector sit near-opaque.
const ARCADE_SCENES = [
  {
    name: "starfighter",
    durationMs: SF_DURATION_MS,
    // The heavy on screen, its three-shot spread descending, the fighter
    // banking clear with a lance in flight — the frame with the most
    // "tiny space battle" context in it, rather than the one with the most
    // pixels.
    stillAtMs: 22000,
    fade: 0.62,
    create: createStarfighterState,
    update: updateStarfighter,
    draw: drawStarfighterScene,
  },
  {
    name: "projector",
    durationMs: PROJECTOR_DURATION_MS,
    stillAtMs: 6200,
    fade: 0.9,
    create: createProjectorState,
    update: updateProjectorState,
    draw: drawProjectorScene,
  },
  {
    name: "science-lab",
    durationMs: LAB_DURATION_MS,
    stillAtMs: 19000,
    fade: 0.94,
    draw: drawLabScene,
  },
  {
    name: "tape-machine",
    durationMs: TAPE_DURATION_MS,
    // Both tape packs are visibly unequal, meters active and PLAY lit.
    stillAtMs: 11200,
    fade: 1,
    draw: drawTapeMachineScene,
  },
  {
    name: "deep-sea-diver",
    durationMs: DIVER_DURATION_MS,
    stillAtMs: 22200,
    fade: 0.86,
    create: createDiverState,
    update: updateDiverState,
    draw: drawDiverScene,
  },
  {
    name: "superspy",
    durationMs: SPY_DURATION_MS,
    // Agent at the vault with the glowing tile, alarm just lit.
    stillAtMs: 17800,
    fade: 0.94,
    draw: drawSpyScene,
  },
  {
    name: "aquarium",
    durationMs: AQUARIUM_DURATION_MS,
    stillAtMs: 9000,
    fade: 0.9,
    draw: drawAquariumScene,
  },
  {
    name: "drive",
    durationMs: DRIVE_DURATION_MS,
    stillAtMs: 8000,
    fade: 1,
    draw: drawDriveScene,
  },
  {
    name: "control-room",
    durationMs: CTRL_DURATION_MS,
    stillAtMs: 15000,
    fade: 1,
    draw: drawControlScene,
  },
];

// ---- animation controller -------------------------------------------------

let arcadeRafId = null;
let arcadeCtx = null;
let arcadeCanvas = null;
let arcadeState = null;
let arcadeStartedAt = 0;
let arcadeLastLoopT = -1;
let arcadeLastRender = 0;

// [V2-POLISH / MICRO-ARCADE-SCENE-POOL]
// Session-scoped selection. arcadeCurrentScene is whatever is running now;
// arcadePreviousScene outlives the session purely so the next selection can
// exclude it. Selection happens in exactly one place —
// startArcadeAnimation(), reached only at an explicit host lifecycle edge, so
// no render, progress tick or loop wrap can ever re-pick.
let arcadeCurrentScene = null;
let arcadePreviousScene = null;
// Safe startup default while IndexedDB preferences load asynchronously.
let arcadeAnimationOrder = DEFAULT_ARCADE_ANIMATION_ORDER;
let arcadeShuffleLoopVisitedScenes = [];

// [STARTUP-MEDIA / N6-4] [STREAMLOOP-INTEGRATION / N6-6] [STREAMLOOP-INTEGRATION / N6-9]
// Safe default while IndexedDB preferences load asynchronously — mirrors
// DEFAULT_STARTUP in app-preferences.js. `autoFillPanel` lives per-context
// here too, since N6-9 — see that file's own breadcrumb for why it moved
// beside the policy it acts on instead of a separate section.
let currentStartupPreferences = {
  browser: { policy: "last-used", eligibleLibraryIds: [], autoFillPanel: false },
  streamloop: { policy: "last-used", eligibleLibraryIds: [], autoFillPanel: false },
};

// [PLAYBACK / MICRO-ARCADE / ANIMATION-ORDER]
// Keep the existing key so sequential review resumes at the same scene across
// preference and app upgrades.
const MICRO_ARCADE_INDEX_KEY = "bg-micro-arcade-test-index";

// sessionStorage, deliberately: it is scoped to the tab, dies with it, and
// needs no schema, migration or cleanup. Wrapped because storage access
// throws outright in some privacy modes and sandboxed frames, and preference
// storage must never be able to break a real load.
function readArcadeTestIndex() {
  try {
    const raw = window.sessionStorage.getItem(MICRO_ARCADE_INDEX_KEY);
    const parsed = Number.parseInt(raw, 10);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed % ARCADE_SCENES.length : 0;
  } catch (err) {
    return 0;
  }
}

function writeArcadeTestIndex(index) {
  try {
    window.sessionStorage.setItem(MICRO_ARCADE_INDEX_KEY, String(index));
  } catch (err) {
    /* a storage failure must not affect the load */
  }
}

function pickArcadeScene() {
  const selection = selectArcadeScene({
    scenes: ARCADE_SCENES,
    order: arcadeAnimationOrder,
    previousScene: arcadePreviousScene,
    visitedScenes: arcadeShuffleLoopVisitedScenes,
    readIndex: readArcadeTestIndex,
    writeIndex: writeArcadeTestIndex,
  });
  const chosen = selection.scene;
  arcadeShuffleLoopVisitedScenes = selection.visitedScenes;
  arcadeCurrentScene = chosen;
  arcadePreviousScene = chosen;
  return chosen;
}

// Shared frame: background persistence, the scene's own drawing, then the CRT
// overlays. Scanlines and flicker live here rather than in any scene so all
// five share one screen, and so a scene can never forget them.
function paintArcadeFrame(scene, state, t, now, solid) {
  const ctx = arcadeCtx;
  ctx.globalAlpha = solid ? 1 : scene.fade;
  ctx.fillStyle = ARCADE_BG;
  ctx.fillRect(0, 0, ARCADE_WIDTH, ARCADE_HEIGHT);
  ctx.globalAlpha = 1;

  scene.draw(ctx, state, t, now);

  ctx.fillStyle = "rgba(0, 0, 0, 0.16)";
  for (let y = 0; y < ARCADE_HEIGHT; y += 2) ctx.fillRect(0, y, ARCADE_WIDTH, 1);
  ctx.fillStyle = `rgba(0, 0, 0, ${0.03 + 0.02 * Math.sin(now / 260)})`;
  ctx.fillRect(0, 0, ARCADE_WIDTH, ARCADE_HEIGHT);
}

function renderArcadeFrame(now) {
  arcadeRafId = requestAnimationFrame(renderArcadeFrame);
  if (now - arcadeLastRender < ARCADE_FRAME_MS) return;

  // Clamped so a backgrounded or janked tab resumes with a sane step instead
  // of teleporting every sprite (which would also let Starfighter's bullets
  // tunnel through enemies and silently lose the explosion beat).
  const dt = Math.min(50, arcadeLastRender ? now - arcadeLastRender : ARCADE_FRAME_MS);
  arcadeLastRender = now;

  const scene = arcadeCurrentScene;
  const t = (now - arcadeStartedAt) % scene.durationMs;

  // A long load outlasting the scene replays THE SAME scene: only the
  // scene-local state is rebuilt at the wrap, never the selection.
  if (t < arcadeLastLoopT) arcadeState = scene.create ? scene.create() : null;
  arcadeLastLoopT = t;

  if (scene.update) scene.update(arcadeState, t, dt, now);
  paintArcadeFrame(scene, arcadeState, t, now, false);
}

// Reduced motion: fast-forward the selected scene's own timeline headlessly to
// its authored strongest moment, paint one frame, and never start the loop.
// Reusing the real simulation means the still is a genuine frame of that
// scene rather than a separate asset that could drift from it.
function renderArcadeStill(scene) {
  if (scene.onSessionStart) scene.onSessionStart();
  arcadeState = scene.create ? scene.create() : null;
  if (scene.update) {
    for (let t = 0; t <= scene.stillAtMs; t += ARCADE_FRAME_MS) {
      scene.update(arcadeState, t, ARCADE_FRAME_MS, t);
    }
  }
  paintArcadeFrame(scene, arcadeState, scene.stillAtMs, scene.stillAtMs, true);
}

function startArcadeAnimation(canvas) {
  if (arcadeRafId !== null) return;
  if (arcadeCanvas !== canvas || !arcadeCtx) {
    arcadeCanvas = canvas;
    arcadeCtx = canvas && canvas.getContext ? canvas.getContext("2d") : null;
    if (!arcadeCtx) return;
    arcadeCtx.imageSmoothingEnabled = false;
  }

  const scene = pickArcadeScene();
  // [V2-POLISH] Per-SESSION setup, distinct from create(): the controller
  // calls create() again on every loop wrap, so anything that must remain
  // fixed for the whole load belongs here instead.
  if (scene.onSessionStart) scene.onSessionStart();
  arcadeState = scene.create ? scene.create() : null;
  arcadeLastLoopT = -1;
  arcadeLastRender = 0;

  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    renderArcadeStill(scene);
    return;
  }

  arcadeStartedAt = performance.now();
  arcadeRafId = requestAnimationFrame(renderArcadeFrame);
}

// arcadePreviousScene is deliberately NOT cleared here: it must survive to
// the next startArcadeAnimation() so that call can exclude it.
function stopArcadeAnimation() {
  arcadeCurrentScene = null;
  if (arcadeRafId === null) return;
  cancelAnimationFrame(arcadeRafId);
  arcadeRafId = null;
}

const MOBILE_ATMOSPHERE_PHRASES = ["Building your gallery…", "Still working…", "Preparing your media…"];

let mobileTakeoverTextTimer = null;

// [UI-REDESIGN / STAGE 6] [MOBILE-LIVE-STATUS-TAKEOVER]
// The takeover's two TEXT decorations — the indeterminate activity-bar sweep
// and the rotating atmosphere phrase. Unchanged Stage 6 behavior on its
// original 550ms beat.
// [V2-POLISH / MICRO-ARCADE-CANVAS] This is deliberately a separate timer
// from the canvas scene's own requestAnimationFrame loop, rather than one
// clock driving both: the scene runs at ~30fps and the text at ~2fps, and an
// earlier attempt to derive one from the other only produced divide-down
// arithmetic whose sole purpose was to reconstruct this exact 550ms cadence.
// Two timers, each with one job, is the smaller thing.
// Idempotent — a second call while already running is a no-op, so this can
// never be started twice into two concurrent intervals. `tick` lives in this
// call's own closure, so every fresh load starts at tick 0 with no state
// carried over from a previous one.
function startMobileTakeoverTextTicker() {
  if (mobileTakeoverTextTimer !== null) return;

  let tick = 0;
  const renderTick = () => {
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

  mobileTakeoverTextTimer = setInterval(renderTick, 550);
}

function stopMobileTakeoverTextTicker() {
  if (mobileTakeoverTextTimer === null) return;
  clearInterval(mobileTakeoverTextTimer);
  mobileTakeoverTextTimer = null;
}

// [V2-POLISH / MICRO-ARCADE-CANVAS]
// The load-session lifecycle boundary, unchanged in shape from Stage 6:
// syncMobileLoadState() still calls exactly these two, on exactly the same
// not-loading -> loading and loading -> not-loading edges. Only what lives
// behind them changed (ASCII frames -> pixel canvas), which is the whole
// point of keeping the boundary — a future scene pool swaps the contents of
// startArcadeAnimation() without touching this seam or the loader.
// Both are idempotent; every exit path calls stop unconditionally rather
// than tracking whether reduced-motion left a timer unset.
function startMobileTakeoverAnimation() {
  startMobileTakeoverTextTicker();
  startArcadeAnimation(mobileLoadCanvas);
}

function stopMobileTakeoverAnimation() {
  stopMobileTakeoverTextTicker();
  stopArcadeAnimation();
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
let mediaIdSeedToken = 0;

// [MEDIA-ID / STAGE-02 / LOCAL-PROJECTION]
// [WHY: THE sequencing correction this stage turns on. Stage 01 resolved the
//  media scope INSIDE the fire-and-forget seeding pass, which runs after
//  finishLoadingItems() — so at first render getRoot() could still return null
//  for a first-ever pick, and, worse, a child-first/MASTER-later load would
//  render against the PRE-re-base prefixes because resolveScopeForRoot() is the
//  call that performs the re-base.
//
//  So the two halves are now separate, in this order:
//
//      resolve / claim / join / re-base   <- AWAITED, structural, cheap
//              -> build alias index       <- AWAITED
//                      -> finishLoadingItems()  (first render, already correct)
//                              -> bulk evidence seeding (fire-and-forget)
//
//  The scope is resolved EXACTLY ONCE: the seeding pass now receives the
//  resolved scope instead of computing its own, so no ancestry probe and no
//  re-base can run twice. media-scope.js and media-seeding.js needed no change
//  at all — runSeedingPass already takes scopeId/prefixFromScopeRoot.]
const PROJECTION_FIRST_RENDER_BUDGET_MS = 1500;
const PROJECTION_STATUS_AFTER_MS = 250;

// [MEDIA-ID / STAGE-02 / LOCAL-PROJECTION]
// [WHY: MEDIA-ID's own channel, invalidation only. A sibling tab that claims a
//  root or re-bases a scope moves every stored scope-relative path and every
//  root prefix, so this tab's cached alias index describes state that no longer
//  exists. The message carries a scopeId and a timestamp and NOTHING ELSE —
//  IndexedDB stays the authority and the receiver always re-reads it. Freshness
//  is PROMPT because of this channel; it is CORRECT because of the re-read, so
//  a browser without BroadcastChannel simply rebuilds on its next load.]
let mediaIdentityChannel = null;
let lastProjectionRequest = null;

function getMediaIdentityChannel() {
  if (mediaIdentityChannel) return mediaIdentityChannel;
  try {
    mediaIdentityChannel = createMediaIdentityChannel({
      deviceId: typeof profile.getDeviceId === "function" ? profile.getDeviceId() : null,
      onInvalidate: () => {
        // Drop the cache and rebuild from storage. Never trust the message.
        rebuildProjectionFromStorage("a sibling tab changed MEDIA-ID state");
      },
    });
  } catch (error) {
    console.warn("[MEDIA-ID] Could not open the invalidation channel; projection will refresh on the next load.", error);
    mediaIdentityChannel = null;
  }
  return mediaIdentityChannel;
}

function announceMediaIdentityChange(kind, scopeId) {
  const channel = getMediaIdentityChannel();
  if (channel) channel.announce(kind, { scopeId });
}

// [MEDIA-ID / STAGE-02 / DIAGNOSTIC]
// [WHY: a projection that produces nothing has SEVERAL distinct causes and they
//  need different fixes — no index at all (no scope row, or a single-root scope),
//  no curated paths to project (the BP-FAIL-01 timing defect), candidates found
//  but refused because a competing destination is PRESENT (correct duplicate
//  safety), or refused as UNKNOWN (a root that could not be proven either way).
//  The original line reported only "N aliased item(s)", which reads identically
//  for all four — and during BP-FAIL-01 that cost a diagnosis cycle. This
//  reports the counters only: no path lists, no fact values, no Profile contents.]
function describeProjection(index) {
  if (!index) return "no index (no scope row, or a single-root scope — nothing to project)";
  const d = index.diagnostics || {};
  const probes = d.probes || {};
  const existence = d.existence || {};
  return (
    `${index.aliases.size} aliased of ${d.observed ?? "?"} observed; ` +
    `factKeys=${d.factKeys ?? "?"} candidates=${d.candidates ?? 0} admitted=${d.admitted ?? 0} ` +
    `refused(present=${d.refusedPresent ?? 0}, unknown=${d.refusedUnknown ?? 0}); ` +
    `roots=${d.roots ?? "?"}(handles=${d.rootsWithHandles ?? "?"}) prefixes=[${(index.rootPrefixes || [])
      .map((prefix) => JSON.stringify(prefix))
      .join(", ")}]; ` +
    `census(observed=${existence.observedHits ?? 0}, durable=${existence.durableHits ?? 0}, ` +
    `absent=${existence.censusAbsent ?? 0}, probed=${existence.probed ?? 0}, unknown=${existence.unknown ?? 0}) ` +
    `probes(dir=${probes.directoryProbes ?? 0}, file=${probes.fileProbes ?? 0}` +
    `${probes.budgetExhausted ? ", BUDGET EXHAUSTED" : ""})` +
    // [MEDIA-ID / STAGE-02B / TELEMETRY]
    // [WHY: the Stage 02 line above says HOW MANY were refused; this says WHY,
    //  which is the whole question Stage 02B exists to answer. It stays on the
    //  same single line and keeps the same discipline — aggregate counters keyed
    //  by a CLOSED vocabulary, so its width is fixed whether the library holds
    //  twelve files or two hundred thousand. No path, filename or fact value is
    //  ever emitted here; the bounded exemplars that do carry paths are reachable
    //  only through window.__bgMediaIdTelemetry().]
    `; ${formatTelemetry(d.telemetry)}`
  );
}

// [MEDIA-ID / STAGE-02B / TELEMETRY]
// [WHY SESSION-LOCAL AND IN MEMORY: one load produces several builds (the
//  initial one, the one after evidence banking lands, one per sibling-tab
//  invalidation), and each console line overwrites the last in a developer's
//  attention. A fixed-length ring lets the whole sitting be read back at once —
//  MASTER-first against child-first — which is exactly the comparison that
//  decides whether Stage 03 is warranted.
//
//  It is deliberately NOT durable. A persistent store would need a schema, a
//  version, an eviction policy and a multi-tab convergence story, all to answer
//  a question one session already answers, and it would amount to a durable
//  record of which media this user curates. MULTI-TAB SEMANTICS ARE THEREFORE
//  NONE: nothing here is broadcast, nothing is read by another tab, and no tab
//  can see or corrupt another's counters. It dies with the tab.]
const mediaIdTelemetryHistory = createSessionHistory(TELEMETRY_LIMITS.SESSION_BUILDS);

function recordProjectionTelemetry(reason, index, extra = {}) {
  mediaIdTelemetryHistory.push({
    at: Date.now(),
    reason,
    aliasedItems: index ? index.aliases.size : 0,
    scopeId: index ? index.scopeId : null,
    rootPrefixes: index ? [...(index.rootPrefixes || [])] : [],
    diagnostics: index ? index.diagnostics || null : null,
    ...extra,
  });
}

async function rebuildProjectionFromStorage(reason) {
  if (!lastProjectionRequest) return;
  const request = lastProjectionRequest;
  try {
    const index = await buildAliasIndexForLoad(request);
    if (lastProjectionRequest !== request) return; // superseded by a newer load
    profileView.setAliasIndex(index);
    // [MEDIA-ID / STAGE-02B / TELEMETRY]
    recordProjectionTelemetry(`rebuild: ${reason}`, index);
    console.info(`[MEDIA-ID] Projection rebuilt (${reason}): ${describeProjection(index)}`);
  } catch (error) {
    console.warn("[MEDIA-ID] Could not rebuild the projection. Path-exact behaviour is unaffected.", error);
  }
}

async function applyProvenParentCurationForLoad({ rootId, scope }) {
  if (!rootId || !scope || scope.rootId !== rootId) return null;
  if (!activeLibraryRecord || activeLibraryRecord.id !== rootId) return null;

  try {
    const roots = await listRoots();
    const sameScopeRoots = roots.filter((root) => root && root.scopeId === scope.scopeId);
    const libraries = (await Promise.all(sameScopeRoots.map((root) => getLibraryById(root.rootId)))).filter(Boolean);

    const resolveCandidate = () => resolveProvenParentCuration({
      currentRootId: rootId,
      currentRoot: sameScopeRoots.find((root) => root.rootId === rootId) || null,
      roots: sameScopeRoots,
      libraries,
      associations: profile.getAssociations(),
      knownProfileIds: profile.listProfiles().map((entry) => entry.id),
    });

    let candidate = resolveCandidate();
    if (!candidate) return null;

    // Re-read the current and source rows immediately before the write. A
    // shared fact or explicit folder choice that arrived while evidence was
    // being enumerated restores P1/P3 precedence and cancels inheritance.
    const refreshed = await Promise.all(libraries.map((record) => getLibraryById(record.id)));
    libraries.splice(0, libraries.length, ...refreshed.filter(Boolean));
    candidate = resolveCandidate();
    if (!candidate || !activeLibraryRecord || activeLibraryRecord.id !== rootId) return null;

    const updated = await associateThroughSyncV2(rootId, candidate.profileId);
    if (!updated || !activeLibraryRecord || activeLibraryRecord.id !== rootId) return null;
    activeLibraryRecord = updated;
    establishAmbientProfileContext(activeLibraryRecord);

    if (profile.getProfileId() !== candidate.profileId) {
      const switched = await profile.switchProfile(candidate.profileId);
      if (!switched && profile.getProfileId() !== candidate.profileId) return null;
    }

    return {
      ...candidate,
      profileName: getProfileNameById(candidate.profileId) || profile.getProfileName(),
    };
  } catch (error) {
    // Inheritance is convenience, never a load requirement. Any unavailable
    // evidence or persistence failure declines to conclude and leaves the
    // ordinary unresolved flow intact.
    console.warn("[NORTH-STAR / N3] Could not apply proven parent Curation inheritance.", error);
    return null;
  }
}

async function resolveReverseCurationSuggestionForLoad({
  rootId,
  scopeId,
  deferredScopeMerges = [],
}) {
  if (!rootId || !scopeId) return null;
  const roots = (await listRoots()).filter((root) => root && root.scopeId === scopeId);
  const libraries = (await Promise.all(roots.map((root) => getLibraryById(root.rootId)))).filter(Boolean);
  const candidate = resolveReverseCurationSuggestion({
    currentRootId: rootId,
    currentRoot: roots.find((root) => root.rootId === rootId) || null,
    roots,
    libraries,
    associations: profile.getAssociations(),
    knownProfileIds: profile.listProfiles().map((entry) => entry.id),
    deferredScopeMerges,
  });
  if (!candidate) return null;
  return Object.freeze({
    ...candidate,
    scopeId,
    profileName: getProfileNameById(candidate.profileId),
  });
}

function clearReverseCurationSuggestion() {
  pendingReverseCurationSuggestion = null;
  reverseCurationActionPending = false;
  reverseCurationOfferResult.textContent = "";
  renderReverseCurationSuggestion();
}

function armReverseCurationSuggestion(candidate, loadToken) {
  if (!candidate
    || libraryLoadGeneration !== loadToken
    || !activeLibraryRecord
    || activeLibraryRecord.id !== candidate.currentRootId) return false;
  pendingReverseCurationSuggestion = Object.freeze({ ...candidate, loadToken });
  reverseCurationOfferResult.textContent = "";
  renderReverseCurationSuggestion();
  return true;
}

function renderReverseCurationSuggestion() {
  const suggestion = pendingReverseCurationSuggestion;
  const visible = Boolean(suggestion
    && suggestion.loadToken === libraryLoadGeneration
    && activeLibraryRecord?.id === suggestion.currentRootId
    && suggestion.profileName);
  reverseCurationOffer.classList.toggle("hidden", !visible);
  if (!visible) return;

  const subject = suggestion.descendantCount === 1 ? "A folder" : "Folders";
  reverseCurationOfferText.textContent =
    `${subject} inside this one use${suggestion.descendantCount === 1 ? "s" : ""} ${suggestion.profileName}. ` +
    "Use that Curation here too?";
  reverseCurationOfferYes.textContent = `Use ${suggestion.profileName}`;
  reverseCurationOfferYes.disabled = reverseCurationActionPending;
  reverseCurationOfferNo.disabled = reverseCurationActionPending;
}

async function writeReverseCurationAssociation(rootId, profileId) {
  if (!activeLibraryRecord || activeLibraryRecord.id !== rootId) return false;
  const updated = await associateThroughSyncV2(rootId, profileId);
  if (!updated || !activeLibraryRecord || activeLibraryRecord.id !== rootId) return false;
  activeLibraryRecord = updated;
  establishAmbientProfileContext(activeLibraryRecord);
  syncAssociateButtonVisibility();
  await renderRecentLibraries();
  return true;
}

async function handleReverseCurationSuggestionAction(kind) {
  if (reverseCurationActionPending || !pendingReverseCurationSuggestion) return;
  const pending = pendingReverseCurationSuggestion;
  reverseCurationActionPending = true;
  reverseCurationOfferResult.textContent = "";
  renderReverseCurationSuggestion();
  try {
    const result = await performReverseCurationSuggestionAction({
      kind,
      pendingSuggestion: pending,
      getCurrentRootId: () => activeLibraryRecord?.id || null,
      resolveCurrentSuggestion: () => resolveReverseCurationSuggestionForLoad({
        rootId: pending.currentRootId,
        scopeId: pending.scopeId,
      }),
      writeAssociation: (profileId) => writeReverseCurationAssociation(pending.currentRootId, profileId),
    });

    if (result.status === "applied") {
      pendingReverseCurationSuggestion = null;
      reverseCurationOfferResult.textContent = `Now remembered with ${pending.profileName}.`;
    } else if (result.status === "declined" || result.status === "stale") {
      // Ephemeral per-load dismissal. No re-evaluation path exists in this
      // context, so NO cannot immediately nag again.
      pendingReverseCurationSuggestion = null;
    } else if (result.status === "write-failed") {
      reverseCurationOfferResult.textContent = "Could not save that Curation. Try again.";
    }
  } finally {
    reverseCurationActionPending = false;
    renderReverseCurationSuggestion();
  }
}

function resolveDeviceAwareMediaQuestionForLoad({ rootId, currentSample }) {
  if (profileSync.getStatus().mode !== "v3" || !rootId || !currentSample) return null;
  return resolveDeviceAwareMediaQuestion({
    currentRootId: rootId,
    currentLibrary: activeLibraryRecord,
    currentSample,
    structure: profile.getStructure(),
    libraries: profile.getLibraries(),
    associations: profile.getAssociations(),
    knownProfileIds: profile.listProfiles().map((entry) => entry.id),
    ownDeviceId: profile.getDeviceId(),
  });
}

function clearDeviceAwareMediaQuestion() {
  pendingDeviceAwareMediaQuestion = null;
  deviceAwareMediaActionPending = false;
  deviceAwareMediaQuestionResult.textContent = "";
  renderDeviceAwareMediaQuestion();
}

function armDeviceAwareMediaQuestion(candidate, loadToken, currentSample) {
  if (!candidate
    || libraryLoadGeneration !== loadToken
    || activeLibraryRecord?.id !== candidate.currentRootId) return false;
  // Device names present evidence that already exists; they never participate
  // in candidate selection.
  const deviceName = profileSync.resolveDeviceName(candidate.sourceDeviceId);
  if (!deviceName) return false;
  pendingDeviceAwareMediaQuestion = Object.freeze({ ...candidate, deviceName, loadToken, currentSample });
  deviceAwareMediaQuestionResult.textContent = "";
  renderDeviceAwareMediaQuestion();
  return true;
}

function renderDeviceAwareMediaQuestion() {
  const question = pendingDeviceAwareMediaQuestion;
  const visible = Boolean(question
    && question.loadToken === libraryLoadGeneration
    && activeLibraryRecord?.id === question.currentRootId
    && question.deviceName);
  deviceAwareMediaQuestion.classList.toggle("hidden", !visible);
  if (!visible) return;
  deviceAwareMediaQuestionText.textContent = `Is this the same media you use on ${question.deviceName}?`;
  deviceAwareMediaQuestionYes.disabled = deviceAwareMediaActionPending;
  deviceAwareMediaQuestionNo.disabled = deviceAwareMediaActionPending;
}

async function linkDeviceAwareMediaCandidate(localRootId, sharedLibraryId) {
  if (activeLibraryRecord?.id !== localRootId) return null;
  const result = await profile.linkLocalLibraryToShared(localRootId, sharedLibraryId);
  if (!result || result.ok === false) return result;
  const refreshed = await getLibraryById(localRootId);
  if (!refreshed || refreshed.libraryId !== sharedLibraryId || activeLibraryRecord?.id !== localRootId) return null;
  activeLibraryRecord = refreshed;
  associationWriteSuppression.setLoadedLibrary(activeLibraryRecord);
  establishAmbientProfileContext(activeLibraryRecord);
  syncAssociateButtonVisibility();
  await renderRecentLibraries();
  return result;
}

async function handleDeviceAwareMediaQuestionAction(kind) {
  if (deviceAwareMediaActionPending || !pendingDeviceAwareMediaQuestion) return;
  const pending = pendingDeviceAwareMediaQuestion;
  deviceAwareMediaActionPending = true;
  deviceAwareMediaQuestionResult.textContent = "";
  renderDeviceAwareMediaQuestion();
  try {
    const result = await performDeviceAwareMediaQuestionAction({
      kind,
      pendingQuestion: pending,
      getCurrentRootId: () => activeLibraryRecord?.id || null,
      resolveCurrentQuestion: () => resolveDeviceAwareMediaQuestionForLoad({
        rootId: pending.currentRootId,
        currentSample: pending.currentSample,
      }),
      linkLocalLibrary: (localRootId, sharedLibraryId) =>
        linkDeviceAwareMediaCandidate(localRootId, sharedLibraryId),
    });
    if (result.status === "linked") {
      pendingDeviceAwareMediaQuestion = null;
      if (result.profileId && profile.getProfileId() !== result.profileId) {
        await profile.switchProfile(result.profileId);
      }
      deviceAwareMediaQuestionResult.textContent = "Got it — this media will use the same Curation.";
    } else if (result.status === "declined" || result.status === "stale") {
      // Retiring the load-scoped context prevents an immediate repeat. NO
      // writes no identity, association, Curation, or evidence state.
      pendingDeviceAwareMediaQuestion = null;
    } else if (result.status === "claimed") {
      deviceAwareMediaQuestionResult.textContent = "That media is already connected to another folder on this device.";
    } else {
      deviceAwareMediaQuestionResult.textContent = "Could not remember that choice. Try again.";
    }
  } finally {
    deviceAwareMediaActionPending = false;
    renderDeviceAwareMediaQuestion();
  }
}

async function recordPortableStructureForLoad(localLibraryId, items) {
  // N5 belongs only to SyncV3. Keeping the mode gate here prevents a V1/V2
  // transport from ever receiving a replica key it does not serialize.
  if (profileSync.getStatus().mode !== "v3" || !localLibraryId || !Array.isArray(items)) return null;
  const sample = buildPortableStructureSample(items);
  return profile.recordLibraryStructure(localLibraryId, sample);
}

/**
 * Resolves the media scope structurally, then builds this load's alias index.
 *
 * Returns { scope, index } or null. Never throws: every failure degrades to
 * today's exact-path behaviour rather than failing the media load.
 */
async function prepareMediaIdentityForLoad({
  rootId,
  handle,
  sourceKind,
  items,
  complete,
  rootName = null,
  loadTimePolicyDeadlineAt = Number.POSITIVE_INFINITY,
}) {
  let knownRootHandles = [];
  if (handle) {
    try {
      // Read-only enumeration of other roots this device has persisted, so
      // ancestry can be PROVEN against them. Unchanged from Stage 01.
      const libraries = await listLibraries();
      knownRootHandles = libraries
        .filter((record) => record && record.handle && record.id !== rootId)
        .map((record) => ({ rootId: record.id, handle: record.handle }));
    } catch (error) {
      console.warn("[MEDIA-ID] Could not enumerate known libraries for ancestry probing.", error);
    }
  }

  const scope = await resolveScopeForRoot({ rootId, handle, sourceKind, knownRootHandles });

  // A claim, a join, a mint or a re-base all move state sibling tabs have
  // cached. Announced here, once, at the moment it becomes durable.
  if (scope.action !== "existing") {
    announceMediaIdentityChange(MEDIA_IDENTITY_MESSAGE_KINDS.SCOPE_CHANGED, scope.scopeId);
  }

  // [NORTH-STAR / N3 / PROVEN-PARENT-INHERITANCE]
  // MEDIA-ID has finished observing here; policy reads its durable result from
  // above the evidence layer. The write makes inheritance an ordinary folder
  // association, so this path becomes unreachable on every future load unless
  // the customer explicitly changes it.
  const inheritedCuration = sourceKind === "fsa" && Date.now() <= loadTimePolicyDeadlineAt
    ? await applyProvenParentCurationForLoad({ rootId, scope })
    : null;

  // [NORTH-STAR / N4 / REVERSE-SUGGESTION]
  // Upward evidence may prepare a question only. There is intentionally no
  // association writer on this path; YES is the sole write boundary below.
  const reverseSuggestion = sourceKind === "fsa"
    && !inheritedCuration
    && Date.now() <= loadTimePolicyDeadlineAt
    ? await resolveReverseCurationSuggestionForLoad({
        rootId,
        scopeId: scope.scopeId,
        deferredScopeMerges: scope.diagnostics?.deferredScopeMerges || [],
      })
    : null;

  // [NORTH-STAR / N2 / DEVICE-AWARE-HUMAN-QUESTION]
  // A unique N5 match licenses only a proposal. Same-device structural policy
  // above gets first refusal, and candidate production has no write seam.
  const portableCurrentSample = sourceKind === "fsa" ? buildPortableStructureSample(items) : null;
  const deviceAwareQuestion = sourceKind === "fsa"
    && !inheritedCuration
    && !reverseSuggestion
    && Date.now() <= loadTimePolicyDeadlineAt
    ? resolveDeviceAwareMediaQuestionForLoad({ rootId, currentSample: portableCurrentSample })
    : null;

  // [MEDIA-ID / STAGE-02 / BP-FAIL-01]
  // [WHY: `factKeys` is a CALLBACK, not a captured array, and `profileId` is
  //  read through one too. ProfileStore starts #loadSavedRecords() in its
  //  constructor and never exposes a promise for it — whenFactsSettled() waits
  //  on the fact QUEUE, not on that read — so immediately after a page reload
  //  knownPaths() legitimately returns []. A build that froze the array at that
  //  instant saw zero curated paths, and because the SAME frozen request was
  //  replayed by every later rebuild, the projection stayed empty for the rest
  //  of the session. That is the Browser Preview failure exactly: correct scope,
  //  correct prefix, 222 paths refreshed, five stamped MASTER facts present, and
  //  "0 aliased item(s)" on every rebuild.
  //
  //  Both sources are the ACTIVE profile's, so Profile isolation is unchanged and
  //  remains structural: no API on this path can return another Profile's
  //  curation.]
  const request = {
    rootId,
    profileId: () => profile.getProfileId(),
    items,
    factKeys: () => currentFactKeys(),
    loadComplete: Boolean(complete),
  };
  lastProjectionRequest = request;
  lastProjectionRecordCount = typeof profile.size === "function" ? profile.size() : 0;
  lastProjectionFactPathCount = typeof profile.getFactPaths === "function" ? profile.getFactPaths().length : 0;

  const index = await buildAliasIndexForLoad(request);

  // [MEDIA-ID / STAGE-02B / TELEMETRY]
  recordProjectionTelemetry("initial build", index, {
    rootName: rootName || (handle && handle.name) || rootId,
    scopeAction: scope.action,
    prefixFromScopeRoot: scope.prefixFromScopeRoot,
  });

  // [MEDIA-ID / STAGE-02 / DIAGNOSTIC]
  // The INITIAL build, reported on the same terms as a rebuild. Previously only
  // rebuilds logged, so the first (and usually only) build was invisible.
  console.info(
    `[MEDIA-ID] Projection built for "${rootName || (handle && handle.name) || rootId}" ` +
      `(scope ${scope.scopeId}, ${scope.action}, prefix ${JSON.stringify(scope.prefixFromScopeRoot)}): ` +
      `${describeProjection(index)}`
  );

  return { scope, index, inheritedCuration, reverseSuggestion, deviceAwareQuestion, portableCurrentSample };
}

// [MEDIA-ID / STAGE-02 / BP-FAIL-01]
// [WHY: the other half of the same defect. Reading the curation live fixes a
//  rebuild, but nothing was ASKING for a rebuild once ProfileStore's records
//  finally arrived — the only rebuild triggers were a sibling tab's message and
//  this tab's own seeding pass. So on a reload the first build correctly saw no
//  curation and then nothing ever revisited it.
//
//  ProfileStore#loadSavedRecords ends with #emit(), and so does every adoption of
//  a peer's facts, so a subscription here is a sufficient signal without any new
//  ProfileStore API. It is gated on the CURATED PATH COUNT changing (size() is
//  O(1)) and then on the new keys being able to produce a candidate at all, so an
//  ordinary Favorite click on an already-curated item does no work, and a click
//  that creates a path which cannot alias does no work either. Without that
//  second gate a 20k library would re-run a ~70ms build on every first-time
//  favourite.]
let lastProjectionRecordCount = 0;
let lastProjectionFactPathCount = 0;
let projectionRebuildQueued = false;

// [MEDIA-ID / STAGE-02 / BP-FAIL-03]
// [WHY: alias DISCOVERY reads stamped fact paths, not flattened local records.
//  ProfileStore#setRecord deletes a record that carries only false/empty values,
//  so a path holding ONLY an un-favourite, an un-tag or an un-hide has no local
//  record and never appears in knownPaths() — while its stamped facts are
//  exactly what must beat the older positive value on a proven alias. Losing
//  them made removals one-way: MASTER -> child projected, child -> MASTER did
//  not, forever.
//
//  The union is deliberate and is the safe direction: getFactPaths() is the
//  authority, and knownPaths() only covers the brief window in which a mutation
//  has updated the local record but its fact has not yet been stamped. A key
//  with no fact contributes nothing to resolution, and every extra candidate
//  still goes through the unchanged competing-destination refusal.]
function currentFactKeys() {
  const fromFacts = typeof profile.getFactPaths === "function" ? profile.getFactPaths() : [];
  const fromRecords = typeof profile.knownPaths === "function" ? profile.knownPaths() : [];
  return [...new Set([...fromFacts, ...fromRecords])];
}

function couldChangeAliases() {
  const request = lastProjectionRequest;
  const index = profileView.getAliasIndex();
  if (!request || !index) return true; // nothing built yet — let the rebuild decide

  const observed = new Set();
  for (const item of request.items || []) {
    if (item && typeof item.relativePath === "string") observed.add(item.relativePath);
  }

  // A newly curated key matters only if some root prefix maps it onto a path
  // this load is actually showing. An index that cannot answer that question
  // falls through to rebuilding — the skip is an optimization, and it must never
  // be the reason a projection fails to appear.
  const prefixes = index.rootPrefixes;
  if (!Array.isArray(prefixes) || !prefixes.length) return true;
  for (const key of currentFactKeys()) {
    for (const prefix of prefixes) {
      if (prefix && !key.startsWith(prefix)) continue;
      const viewed = key.slice(prefix.length);
      if (viewed && observed.has(viewed) && !index.aliases.has(viewed)) return true;
    }
  }
  return false;
}

// [MEDIA-ID / STAGE-02 / BP-FAIL-03]
// [WHY: gating a rebuild on profile.size() alone was ALSO wrong, for the same
//  underlying reason. Un-favouriting a projected Favorite on the child writes
//  {favorite:false}, which isEmptyRecord() discards — so the record count does
//  not change, and could even DECREASE, while a brand-new stamped fact key
//  appeared. Measured directly: size stayed at 1 across the child removals.
//
//  The stamped fact-key COUNT is an exact signal here rather than a heuristic:
//  sync-facts.js has no remove-a-key operation ("Every removal is expressed as a
//  fact whose VALUE says removed") and mergeMaps only ever unions, so within one
//  Profile the fact-key set is append-only and a count change means new keys.
//  Both signals are consulted, so neither can suppress the other.]
function onProfileCurationChanged() {
  if (!lastProjectionRequest) return;
  const size = typeof profile.size === "function" ? profile.size() : 0;
  const factPathCount = typeof profile.getFactPaths === "function" ? profile.getFactPaths().length : 0;
  if (size === lastProjectionRecordCount && factPathCount === lastProjectionFactPathCount) return;
  lastProjectionRecordCount = size;
  lastProjectionFactPathCount = factPathCount;
  if (projectionRebuildQueued) return;

  projectionRebuildQueued = true;
  // Coalesced: a burst of adopted facts produces ONE rebuild, not one each.
  Promise.resolve().then(() => {
    projectionRebuildQueued = false;
    if (!couldChangeAliases()) return;
    rebuildProjectionFromStorage("the active Profile's curated paths changed");
  });
}

profile.subscribe(onProfileCurationChanged);

/**
 * Runs the structural preparation under a soft first-render budget.
 *
 * [WHY A BUDGET: everything here is tens of milliseconds except one case — a
 *  re-base rewrites every banked path row in the scope, which at 20k items is
 *  seconds. That is rare (once per scope-root promotion, never per load) but it
 *  must not silently stall the gallery. On overrun the load renders with exact
 *  path behaviour and the work CONTINUES: the transaction is atomic, so
 *  abandoning the wait never abandons the write, and the index is applied with a
 *  single extra emit when it lands.]
 */
function beginMediaIdentityForLoad({ rootId, handle, sourceKind, items, rootName = null, complete = true }) {
  mediaIdSeedToken += 1;
  const token = mediaIdSeedToken;

  // A new load invalidates the previous projection and every pending override.
  profileView.beginEpoch();
  profileView.setAliasIndex(null);
  lastProjectionRequest = null;

  if (!rootId || !Array.isArray(items) || !items.length) return Promise.resolve(null);

  const ready = prepareMediaIdentityForLoad({
    rootId,
    handle,
    sourceKind,
    items,
    complete,
    rootName,
    // A slow rebase may finish after path-exact rendering has already been
    // released. N3 declines on that load rather than switching Curations in a
    // live session; the durable proof is available immediately next load.
    loadTimePolicyDeadlineAt: Date.now() + PROJECTION_FIRST_RENDER_BUDGET_MS,
  }).catch((error) => {
    console.warn("[MEDIA-ID] Could not prepare media identity. Path-exact behaviour is unaffected.", error);
    return null;
  });

  // Bulk evidence banking — Stage 01's pass, unchanged in every respect except
  // that it no longer resolves the scope itself. Still fire-and-forget, still
  // after render, still superseded by a newer load, still failure-tolerant.
  ready.then((prepared) => {
    if (!prepared || !prepared.scope || token !== mediaIdSeedToken) return;
    startMediaIdentitySeeding({ scope: prepared.scope, rootId, items, rootName, handle, token });
  });

  return ready;
}

/**
 * Awaits the projection for at most the first-render budget, applies it, and
 * returns. Never rejects.
 */
async function applyProjectionWithinBudget(ready) {
  if (!ready) return null;

  let settled = false;
  let statusTimer = null;
  const previousStatus = statusText ? statusText.textContent : null;

  if (statusText) {
    statusTimer = setTimeout(() => {
      if (!settled) statusText.textContent = "Reconciling library identity…";
    }, PROJECTION_STATUS_AFTER_MS);
  }

  const budget = new Promise((resolve) => setTimeout(() => resolve("budget"), PROJECTION_FIRST_RENDER_BUDGET_MS));
  const outcome = await Promise.race([ready.then((value) => ({ value })), budget]);
  settled = true;
  if (statusTimer) clearTimeout(statusTimer);
  if (statusText && statusText.textContent === "Reconciling library identity…") {
    statusText.textContent = previousStatus || "";
  }

  if (outcome === "budget") {
    console.info("[MEDIA-ID] Structural preparation exceeded the first-render budget; rendering path-exact and applying the projection when it lands.");
    ready.then((prepared) => {
      if (prepared && prepared.index) profileView.setAliasIndex(prepared.index);
    });
    return null;
  }

  if (outcome.value && outcome.value.index) profileView.setAliasIndex(outcome.value.index);
  return outcome.value || null;
}

// ---- [MEDIA-ID / STAGE-01 / CAPTURE-NOW-SEEDING] --------------------------
//
// The bulk evidence-banking pass. Receives an ALREADY-RESOLVED scope (see
// beginMediaIdentityForLoad above) so no ancestry probing or re-base happens
// twice.
function startMediaIdentitySeeding({ scope, rootId, items, rootName, handle, token }) {
  // Fire-and-forget by design: a user must never wait on bookkeeping that has
  // no visible effect until the pass completes.
  (async () => {
    try {
      const stats = await runSeedingPass({
        scopeId: scope.scopeId,
        rootId,
        prefixFromScopeRoot: scope.prefixFromScopeRoot,
        items,
        factPaths: typeof profile.knownPaths === "function" ? profile.knownPaths() : [],
        profileId: profile.getProfileId(),
        shouldContinue: () => token === mediaIdSeedToken,
      });

      console.info(
        `[MEDIA-ID] Banked evidence for "${rootName || (handle && handle.name) || rootId}": ` +
          `${stats.created} new, ${stats.updated} refreshed, ${stats.adopted} adopted, ` +
          `${stats.batches} batch(es)${stats.superseded ? " (superseded by a newer load)" : ""}. ` +
          `Scope ${scope.scopeId} (${scope.action}).`
      );

      if (!stats.superseded && (stats.created || stats.updated)) {
        // The durable path census grew, which can only make projection MORE
        // conservative (more competing destinations become provably PRESENT).
        announceMediaIdentityChange(MEDIA_IDENTITY_MESSAGE_KINDS.EVIDENCE_CHANGED, scope.scopeId);
        if (token === mediaIdSeedToken) rebuildProjectionFromStorage("evidence banking completed");
      }
    } catch (error) {
      console.warn("[MEDIA-ID] Evidence seeding did not complete. No user-visible behaviour is affected.", error);
    }
  })();
}

function finishLoadingItems(items) {
  items.forEach((item) => {
    item.isFavorite = profileView.isFavorite(item.relativePath);
    item.isHidden = profileView.isHidden(item.relativePath);
    item.favoritedAt = profileView.getFavoritedAt(item.relativePath);
    item.userTags = profileView.getItemTags(item.relativePath);
  });

  allItems = items;
  reloadRuntime({ randomizeInitial: shouldRandomizeInitialSelection() });
}

async function loadRemoteSession(text, { name, record = null, sourceKind = "cassette", curationId = null } = {}) {
  if (isLoadingFiles) return;

  currentSessionIsUrlBacked = true;
  isLoadingFiles = true;
  const loadToken = ++libraryLoadGeneration;
  clearReverseCurationSuggestion();
  clearDeviceAwareMediaQuestion();
  lastMobileLoadFailed = false;
  syncMobileLoadState();
  bumpGalleryGeneration();
  runtime.clear();
  clearViewerNode();
  exitFillMode();
  recentHideUndo = null;
  syncUndoHideButton();

  provider.dispose();
  fsaProvider.dispose();
  activeLibraryRecord = null;
  activeCassetteRecord = record;
  activeCassetteCurationId = record ? curationId : null;
  associationWriteSuppression.setLoadedLibrary(null);
  ambientProfileObserver.clearContext();
  renderAmbientProfileOffer();
  activeLibraryDisplayName = name || record?.name || (sourceKind === "cassette-folder" ? "Floppy Folder" : "Floppy Disk");
  currentSourceKind = sourceKind;
  currentFolderPermissionState = "granted";
  legacySessionAssociated = false;
  legacyHasDurableIdentity = false;
  pendingLegacySignature = null;
  pendingLibraryAssociationIntent = false;
  syncAssociateButtonVisibility();
  fsaStatusText.textContent = "";
  resetMediaRenderOutcomes();

  const remoteSourceLabel = sourceKind === "cassette-folder" ? "Floppy Folder" : "Floppy Disk";
  remoteStatusText.textContent = `Loading ${remoteSourceLabel}…`;

  try {
    const parseStartedAt = performance.now();
    const parsed = extractRemoteUrls(text);
    const parseMs = performance.now() - parseStartedAt;
    const providerStartedAt = performance.now();
    const result = await remoteProvider.loadFromUrls(parsed.urls, {
      batchSize: BATCH_SIZE,
    });
    const providerMs = performance.now() - providerStartedAt;
    if (loadToken !== libraryLoadGeneration) {
      remoteStatusText.textContent = "";
      return;
    }

    const skipped = parsed.diagnostics.rejected + result.diagnostics.skipped;
    if (!result.items.length) {
      remoteStatusText.textContent = "No valid media URLs found in this file.";
    } else {
      remoteStatusText.textContent =
        `${remoteSourceLabel} ready. ${result.items.length} items · ` +
        `${result.diagnostics.images} images · ${result.diagnostics.videos} videos` +
        (skipped ? ` · ${skipped} links skipped` : "");
    }

    console.info("[REMOTE SESSION] Load counts", {
      parser: parsed.diagnostics,
      provider: result.diagnostics,
    });

    const firstPaintStartedAt = performance.now();
    finishLoadingItems(result.items);
    const toFirstPaintMs = performance.now() - firstPaintStartedAt;
    console.info("[REMOTE SESSION] Load phases", {
      parse_ms: parseMs,
      provider_ms: providerMs,
      to_first_paint_ms: toFirstPaintMs,
      parsed: parsed.urls.length,
      items: result.items.length,
    });
  } catch (error) {
    if (loadToken !== libraryLoadGeneration) {
      remoteStatusText.textContent = "";
      return;
    }
    remoteStatusText.textContent = "That file could not be read.";
    console.warn("[REMOTE SESSION] The selected file could not be loaded.", {
      message: error instanceof Error ? error.message : "Unknown error",
    });
  } finally {
    isLoadingFiles = false;
    syncMobileLoadState();
  }
}

async function loadFiles(fileList, { isFolderPick = false, rootName = null } = {}) {
  const total = (fileList || []).length;
  if (!total || isLoadingFiles) return;

  currentSessionIsUrlBacked = false;
  isLoadingFiles = true;
  const loadToken = ++libraryLoadGeneration;
  clearReverseCurationSuggestion();
  clearDeviceAwareMediaQuestion();
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
  remoteProvider.dispose();
  remoteStatusText.textContent = "";
  resetMediaRenderOutcomes();
  activeLibraryRecord = null;
  activeCassetteRecord = null;
  activeCassetteCurationId = null;
  associationWriteSuppression.setLoadedLibrary(null);
  ambientProfileObserver.clearContext();
  renderAmbientProfileOffer();
  activeLibraryDisplayName = rootName || (isFolderPick ? "Loaded Media Folder" : "Selected files");
  currentSourceKind = "legacy";
  currentFolderPermissionState = "granted";
  // [Phase 8.4-3] Only a real folder pick (webkitdirectory, has a root to
  // fingerprint) participates in durable identity — "Choose Files" keeps
  // the old ephemeral, ununrecognizable-on-reload behavior unchanged (see
  // association-state adapter). Recomputed on every load rather than
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
  let deferredLoadTimeOffer = null;

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
          associationWriteSuppression.setLoadedLibrary(activeLibraryRecord.id);
          establishAmbientProfileContext(activeLibraryRecord);
          pendingLegacySignature = null;

          const restoration = await restoreProfileForLoadedLibrary(activeLibraryRecord, loadToken);
          if (restoration && !restoration.stale) {
            const alreadyActive = restoration.result?.reason === "shared-target-already-active"
              || restoration.result?.reason === "local-row-already-active";
            if (restoration.switched || alreadyActive) {
              recognizedProfileName = profile.getProfileName();
              logLegacyIdentity("associated profile id", { profileId: profile.getProfileId() });
            }
            if (restoration.result?.action === "skip-and-ask") {
              deferredLoadTimeOffer = {
                id: activeLibraryRecord.id,
                libraryId: restoration.libraryId,
                currentFactValue: restoration.currentFactValue,
              };
            }
            if (restoration.result?.reason === "shared-target-unusable" && restoration.currentFactValue) {
              // [SYNCV3 / STAGE-07 / ASSOCIATION-STATE]
              // Preserve S4 when authoritative shared truth names a Profile
              // this device does not yet have; never fall back to a stale row.
              console.warn("[LEGACY-IDENTITY] Recognized library's associated Profile is unavailable.");
            } else if (restoration.result?.reason === "local-row-unusable" && activeLibraryRecord.profileId) {
              console.warn("[LEGACY-IDENTITY] Recognized library's associated Profile is unavailable.");
            }
          }
        } else if (matchResult.status === "ambiguous") {
          // Per spec: false negatives are preferable to guessing. Treated
          // identically to "no match" from here on — unassociated, no
          // profile switch, Associate button will offer to create a new
          // record if the user proceeds.
          logLegacyIdentity("ambiguous — refusing to guess", { candidateIds: matchResult.candidateIds });
          activeLibraryRecord = null;
          associationWriteSuppression.setLoadedLibrary(null);
          pendingLegacySignature = signature;
        } else {
          logLegacyIdentity("no match — new/unrecognized library");
          activeLibraryRecord = null;
          associationWriteSuppression.setLoadedLibrary(null);
          pendingLegacySignature = signature;
        }
      } catch (error) {
        // Identity resolution must never block the actual media load —
        // worst case, this folder just isn't recognized this time.
        console.warn("[LEGACY-IDENTITY] Could not resolve legacy folder identity.", error);
        activeLibraryRecord = null;
        associationWriteSuppression.setLoadedLibrary(null);
        pendingLegacySignature = null;
      }
    }

    finishLoadingItems(items);
    await armDeferredLoadTimeOffer(deferredLoadTimeOffer, loadToken);
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
      fsaStatusText.textContent = `✓ Recognized this folder's saved setup — Curation: ${recognizedProfileName}.`;
    }

    // [SYNCV3 / STAGE-04B / SHARED-LIBRARY-RECORD]
    // [WHY: the legacy picker's equivalent of the FSA hook — same rule, same
    //  moment: the items are loaded and finishLoadingItems() has run. A legacy
    //  Library DOES have stable shared identity once it has been explicitly
    //  associated (matchLegacySignature restores the row, libraryId and all), so
    //  it participates on exactly the same terms as FSA rather than being
    //  excluded. A legacy folder that was never associated, or that the matcher
    //  declined to recognize, simply has no shared libraryId and
    //  recordLibraryLoaded returns null — no identity is invented from a
    //  signature or a folder name.]
    if (activeLibraryRecord && activeLibraryRecord.id) {
      try {
        await profile.recordLibraryLoaded(activeLibraryRecord.id, { name: activeLibraryRecord.name || rootName });
        await recordPortableStructureForLoad(activeLibraryRecord.id, items);
      } catch (error) {
        console.warn("[SYNCV3] Could not record this legacy Library load/evidence in shared state.", error);
      }

      // [MEDIA-ID / STAGE-02 / LOCAL-PROJECTION]
      // [WHY: a legacy pick has no handle, so no ancestry can be proven and this
      //  root simply gets its own media scope — a single-root scope, for which
      //  buildAliasIndexForLoad returns null and every read is a plain
      //  delegation. That is a real limitation, not a degraded mode: structure
      //  alone never auto-resolves, so a Legacy root is never merged into
      //  another scope on a guess. Its evidence is still worth banking —
      //  legacy-library-signature.js is the only place in this app that ever
      //  retained historical path->size pairs.
      //
      //  The projection is not awaited here the way the FSA path awaits it: the
      //  identity work for a legacy root cannot change what the first render
      //  shows (no siblings, no proven prefix), so there is nothing to wait for.]
      beginMediaIdentityForLoad({
        rootId: activeLibraryRecord.id,
        handle: null,
        sourceKind: "legacy",
        items,
        rootName,
        complete: true,
      });
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

function isCassettePickerSupported() {
  return typeof window !== "undefined" && typeof window.showOpenFilePicker === "function";
}

async function loadFromFsaHandle(dirHandle, libraryRecord) {
  if (isLoadingFiles) return;

  currentSessionIsUrlBacked = false;
  isLoadingFiles = true;
  const loadToken = ++libraryLoadGeneration;
  clearReverseCurationSuggestion();
  clearDeviceAwareMediaQuestion();
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
  activeCassetteRecord = null;
  activeCassetteCurationId = null;
  associationWriteSuppression.setLoadedLibrary(activeLibraryRecord?.id || null);
  establishAmbientProfileContext(activeLibraryRecord);
  activeLibraryDisplayName = dirHandle.name || (libraryRecord && libraryRecord.name) || "Loaded Media Folder";
  currentSourceKind = "fsa";
  currentFolderPermissionState = "granted";
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
  let deferredLoadTimeOffer = null;

  if (activeLibraryRecord && activeLibraryRecord.id) {
    const restoration = await restoreProfileForLoadedLibrary(activeLibraryRecord, loadToken);
    if (restoration && !restoration.stale) {
      const alreadyActive = restoration.result?.reason === "shared-target-already-active"
        || restoration.result?.reason === "local-row-already-active";
      if (restoration.switched || (activeLibraryRecord.wasExisting && alreadyActive)) {
        recognizedProfileName = profile.getProfileName();
      }
      if (restoration.result?.action === "skip-and-ask") {
        deferredLoadTimeOffer = {
          id: activeLibraryRecord.id,
          libraryId: restoration.libraryId,
          currentFactValue: restoration.currentFactValue,
        };
      }
      if ((restoration.result?.reason === "shared-target-unusable" && restoration.currentFactValue)
        || (restoration.result?.reason === "local-row-unusable" && activeLibraryRecord.profileId)) {
        // [SYNCV3 / STAGE-07 / ASSOCIATION-STATE]
        // Never guess when the authoritative shared target (or Rule 0 local
        // fallback) is unavailable. Preserve S4/local identity for recovery.
        console.warn(
          `[LIBRARY-REGISTRY] "${activeLibraryRecord.name}" is associated with a Profile that is unavailable.`
        );
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
  remoteProvider.dispose();
  remoteStatusText.textContent = "";
  resetMediaRenderOutcomes();

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
    const recognizedNote = recognizedProfileName ? `✓ Recognized this folder's saved setup — Curation: ${recognizedProfileName}. ` : "";

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

    // [MEDIA-ID / STAGE-02 / LOCAL-PROJECTION]
    // [WHY: BEFORE finishLoadingItems(), not after. finishLoadingItems() stamps
    //  every item's Favorite/Hidden/Tags and calls reloadRuntime() — it IS the
    //  first render. Preparing the scope afterwards (as Stage 01 did) meant a
    //  first-ever pick had no scope row yet, and a child-first/MASTER-later load
    //  rendered against prefixes the re-base was about to replace.
    //
    //  Gated on !result.incomplete exactly as the evidence pass already is: an
    //  interrupted scan is not this folder's contents, so it can neither be
    //  banked nor used as the completeness census that proves a competing
    //  destination ABSENT.]
    const mediaIdentityReady =
      activeLibraryRecord && activeLibraryRecord.id && !result.incomplete
        ? beginMediaIdentityForLoad({
            rootId: activeLibraryRecord.id,
            handle: dirHandle,
            sourceKind: "fsa",
            items: result.items,
            rootName: dirHandle.name,
            complete: true,
          })
        : null;
    const preparedMediaIdentity = await applyProjectionWithinBudget(mediaIdentityReady);
    if (preparedMediaIdentity?.inheritedCuration?.profileName) {
      fsaStatusText.textContent =
        `✓ Using ${preparedMediaIdentity.inheritedCuration.profileName}, remembered from a parent folder. ` +
        fsaStatusText.textContent;
    }
    armReverseCurationSuggestion(preparedMediaIdentity?.reverseSuggestion || null, loadToken);
    armDeviceAwareMediaQuestion(
      preparedMediaIdentity?.deviceAwareQuestion || null,
      loadToken,
      preparedMediaIdentity?.portableCurrentSample || null
    );

    finishLoadingItems(result.items);
    await armDeferredLoadTimeOffer(deferredLoadTimeOffer, loadToken);
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

      // [SYNCV3 / STAGE-04B / SHARED-LIBRARY-RECORD]
      // [WHY: THE meaningful-load moment, and deliberately the same one
      //  touchLibrary already uses — the scan finished and this device knows
      //  which local Library it produced. Gated on `!result.incomplete` because
      //  a scan that stopped early is exactly what the provider reports as NOT a
      //  complete load; publishing "last loaded" for it would tell other devices
      //  this Library was opened successfully when it was not.
      //
      //  recordLibraryLoaded reads the shared libraryId and never mints one, so
      //  a folder that has never been explicitly associated is simply not
      //  catalogued (returns null) rather than acquiring a synchronized identity
      //  from being opened — Stage D3's rule, preserved. It writes locally and
      //  announces to sibling tabs; Drive is the scheduler's job, not this
      //  call's.]
      if (!result.incomplete) {
        try {
          await profile.recordLibraryLoaded(activeLibraryRecord.id, { name: dirHandle.name });
          await recordPortableStructureForLoad(activeLibraryRecord.id, result.items);
        } catch (error) {
          console.warn("[SYNCV3] Could not record this Library load/evidence in shared state.", error);
        }
      }

      await renderRecentLibraries();
    }

    // [MEDIA-ID / STAGE-02 / LOCAL-PROJECTION]
    // The evidence pass is started by beginMediaIdentityForLoad() above, off the
    // same resolved scope, so the ancestry probing and any re-base happen
    // exactly once per load. Its !result.incomplete gate moved up there with it,
    // unchanged in meaning: a scan that stopped early is NOT this folder's
    // contents, and banking it would write "these paths are all that exist here"
    // from a partial walk.

    // [Phase 8.4-2] Single visibility rule, same one loadFiles() uses for
    // the legacy path — see the Stage 07 association mapper for the id-less
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
    fsaStatusText.textContent = "This browser does not support remembered folders.";
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

  let folderIntake;
  try {
    folderIntake = await readRememberedFolder(dirHandle);
  } catch (error) {
    console.warn("[FOLDER INTAKE] Could not inspect the selected folder.", error);
    fsaStatusText.textContent = `Could not inspect that folder: ${error.message}`;
    return;
  }

  if (folderIntake.selectionKind === "mixed") {
    fsaStatusText.textContent = "This folder contains both media and Floppy Disks. Choose a folder containing one type.";
    return;
  }
  if (folderIntake.selectionKind === "unsupported") {
    fsaStatusText.textContent = "This folder doesn't contain supported media or Floppy Disks.";
    return;
  }
  if (folderIntake.selectionKind === "floppy-folder") {
    try {
      const record = await addOrUpdateCassette(dirHandle, { sourceKind: "cassette-folder" });
      await renderSavedLibraries();
      await openRememberedCassette(record);
    } catch (error) {
      remoteStatusText.textContent = "That Floppy Folder could not be opened.";
      console.warn("[REMOTE CASSETTE] Could not remember the selected Floppy Folder.", error);
    }
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

async function addRemoteCassette() {
  if (!isCassettePickerSupported()) {
    statusText.textContent = "This browser does not support remembered files.";
    return;
  }
  try {
    const [handle] = await window.showOpenFilePicker({
      multiple: false,
    });
    if (!handle) return;
    const file = await handle.getFile();
    const evidence = await collectSelectionEvidence([file], { shape: "files" });
    const selectionKind = classifySelection(evidence);
    if (selectionKind === "local-files") {
      statusText.textContent = "Browser Gallery can remember folders and Floppy Disks. Choose a folder to remember this media.";
      return;
    }
    if (selectionKind !== "floppy-file") {
      statusText.textContent = "Browser Gallery can't open that file.";
      return;
    }
    const record = await addOrUpdateCassette(handle);
    await renderRemoteCassettes();
    await openRemoteCassette(record);
  } catch (error) {
    if (error && error.name === "AbortError") return;
    remoteStatusText.textContent = "That Floppy Disk could not be opened.";
    console.warn("[REMOTE CASSETTE] Could not add the selected cassette.", {
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

async function openRemoteCassette(record) {
  const handle = record && record.handle;
  if (!handle) {
    remoteStatusText.textContent = `"${record.name}" is no longer available — it may have moved or been deleted.`;
    return;
  }

  let text;
  try {
    let permission = await handle.queryPermission({ mode: "read" });
    if (permission !== "granted") permission = await handle.requestPermission({ mode: "read" });
    if (permission !== "granted") {
      remoteStatusText.textContent = `Access to "${record.name}" was not granted.`;
      return;
    }

    const file = await handle.getFile();
    text = await file.text();
  } catch (error) {
    remoteStatusText.textContent = `"${record.name}" is no longer available — it may have moved or been deleted.`;
    console.warn("[REMOTE CASSETTE] A remembered cassette could not be opened.", {
      message: error instanceof Error ? error.message : "Unknown error",
    });
    return;
  }

  await touchCassette(record.id);
  await renderSavedLibraries();
  const association = await recallSourceCuration(record.id);
  await loadRemoteSession(text, {
    name: record.name, record, sourceKind: "cassette", curationId: association?.profileId || null,
  });
}

async function openRemoteCassetteFolder(record) {
  const handle = record && record.handle;
  if (!handle) {
    remoteStatusText.textContent = `"${record.name}" is no longer available â€” it may have moved or been deleted.`;
    return;
  }

  try {
    let permission = await handle.queryPermission({ mode: "read" });
    if (permission !== "granted") permission = await handle.requestPermission({ mode: "read" });
    if (permission !== "granted") {
      remoteStatusText.textContent = `Access to "${record.name}" was not granted.`;
      return;
    }

    const folderIntake = await readRememberedFolder(handle);
    if (folderIntake.selectionKind === "mixed") {
      remoteStatusText.textContent = "This folder contains both media and Floppy Disks. Choose a folder containing one type.";
      return;
    }
    if (folderIntake.selectionKind !== "floppy-folder") {
      remoteStatusText.textContent = "This folder doesn't contain supported media or Floppy Disks.";
      return;
    }

    await touchCassette(record.id);
    await renderSavedLibraries();
    const association = await recallSourceCuration(record.id);
    await loadRemoteSession(folderIntake.combinedText, {
      name: record.name, record, sourceKind: "cassette-folder", curationId: association?.profileId || null,
    });
  } catch (error) {
    remoteStatusText.textContent = `"${record.name}" is no longer available â€” it may have moved or been deleted.`;
    console.warn("[REMOTE CASSETTE] A remembered Floppy Folder could not be opened.", {
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

async function recallSourceCuration(cassetteId) {
  try {
    return await getSourceCuration(`cassette:${cassetteId}`);
  } catch (error) {
    console.warn("[SOURCE CURATION] Could not recall the remembered Floppy Curation.", error);
    return null;
  }
}

function openRememberedCassette(record) {
  return getRememberedCassetteOwner(record) === "folder"
    ? openRemoteCassetteFolder(record)
    : openRemoteCassette(record);
}

async function renderRemoteCassettes() {
  if (!isCassettePickerSupported()) {
    cassetteAddBtn.classList.remove("hidden");
    cassetteAddBtn.disabled = true;
    remoteCassettesEl.replaceChildren();
    await renderSavedLibraries();
    return;
  }

  cassetteAddBtn.classList.remove("hidden");
  cassetteAddBtn.disabled = false;
  await renderSavedLibraries();
}

cassetteAddBtn.addEventListener("click", addRemoteCassette);

// [LIBRARY-REGISTRY] Resumes one specific remembered library (a click on a
// "Recent Libraries" row) — checks/re-requests read permission for its
// saved handle, same flow the old single-slot "Start Here" button used,
// now parameterized by which record was clicked instead of a fixed key.
async function resumeLibrary(record) {
  fsaStatusText.textContent = "Checking folder access…";

  const dirHandle = record.handle;
  if (!dirHandle) {
    fsaStatusText.textContent = `"${record.name}" has no saved folder access. Choose it again with "Remember Folder".`;
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
    fsaStatusText.textContent = `"${record.name}" is no longer available — it may have moved or been deleted. Removing it from Saved Libraries.`;
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
function formatLibraryMeta(record, typeLabel) {
  const parts = [typeLabel];
  if (typeof record.itemCount === "number") {
    parts.push(`${record.itemCount} item${record.itemCount === 1 ? "" : "s"}`);
  }
  if (record.lastOpenedAt) parts.push(`opened ${formatRelativeTime(record.lastOpenedAt)}`);
  if (record.profileId) {
    const associated = profile.listProfiles().find((entry) => entry.id === record.profileId);
    parts.push(`Curation: ${associated ? associated.name : "unknown"}`);
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

async function renderSavedLibraries() {
  await renderRecentLibraries();
}

// [LIBRARY-REGISTRY] Re-renders the "Recent Libraries" list from IndexedDB.
// Rebuilt from scratch each call (list is small — a handful of libraries
// at most) rather than diffed, matching renderTagsGrid()'s existing
// pattern elsewhere in this file. Does NOT touch permissions or load
// anything on its own — purely a metadata read, safe to call at boot.
async function renderRecentLibraries() {
  let localRecords;
  let floppyRecords;
  try {
    [localRecords, floppyRecords] = await Promise.all([
      listLibraries(),
      (isCassettePickerSupported() || isFsaSupported()) ? listCassettes() : Promise.resolve([]),
    ]);
  } catch (error) {
    console.warn("[SAVED LIBRARIES] Could not read saved libraries.", error);
    localRecords = [];
    floppyRecords = [];
  }

  const records = [
    ...localRecords.map((record) => ({ type: "local", record })),
    ...floppyRecords.map((record) => ({ type: "floppy", record })),
  ].sort((a, b) =>
    (b.record.lastOpenedAt || 0) - (a.record.lastOpenedAt || 0) ||
    a.record.name.localeCompare(b.record.name)
  );

  fsaRecentLibrariesEl.replaceChildren();
  fsaRecentLibrariesEl.classList.toggle("hidden", records.length === 0);

  for (const entry of records) {
    const { record, type } = entry;
    const row = document.createElement("div");
    row.className = "fsa-recent-library-row";

    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.className = "fsa-recent-library-btn";
    openBtn.addEventListener("click", () => type === "local" ? resumeLibrary(record) : openRememberedCassette(record));

    const iconEl = document.createElement("span");
    iconEl.className = "saved-library-icon";
    iconEl.setAttribute("aria-hidden", "true");
    iconEl.textContent = type === "local" ? "\uD83D\uDCC1" : "\uD83D\uDCBE";

    const copyEl = document.createElement("span");
    copyEl.className = "saved-library-copy";

    const nameEl = document.createElement("span");
    nameEl.className = "fsa-recent-library-name";
    nameEl.textContent = record.name;

    const metaEl = document.createElement("span");
    metaEl.className = "fsa-recent-library-meta";
    metaEl.textContent = formatLibraryMeta(
      record,
      type === "local" ? "Local Folder" : record.sourceKind === "cassette-folder" ? "Floppy Folder" : "Floppy Disk"
    );

    copyEl.appendChild(nameEl);
    copyEl.appendChild(metaEl);
    openBtn.appendChild(iconEl);
    openBtn.appendChild(copyEl);

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "fsa-recent-library-remove-btn";
    removeBtn.title = `Forget "${record.name}" from Saved Libraries`;
    removeBtn.setAttribute("aria-label", `Forget "${record.name}" from Saved Libraries`);
    removeBtn.textContent = "✕";
    removeBtn.addEventListener("click", async (event) => {
      event.stopPropagation();
      // [LIBRARY-PROFILE-ASSOCIATION] Soft-remove — takes this row out of
      // Recent Libraries but deliberately does NOT touch its Profile
      // association or identity (handle). Re-picking this same physical
      // folder later still recognizes it and recovers the association.
      // See library-registry.js.
      try {
        if (type === "local") await removeFromRecents(record.id);
        else {
          await clearSourceCuration(`cassette:${record.id}`);
          await removeCassette(record.id);
        }
      } catch (error) {
        console.warn("[LIBRARY-REGISTRY] Could not remove this library from Recent Libraries.", error);
      }
      await renderRecentLibraries();
    });

    row.appendChild(openBtn);
    row.appendChild(removeBtn);
    fsaRecentLibrariesEl.appendChild(row);
  }

  // [STARTUP-MEDIA / N6-4] [STREAMLOOP-INTEGRATION / N6-6] Keeps BOTH
  // contexts' "Startup Media" eligible-folder checklists in sync with this
  // same population every time it changes — see renderStartupMediaSettings()'s
  // own comment for why this is called from here rather than duplicating the
  // listLibraries() read.
  await renderStartupMediaSettings("browser");
  await renderStartupMediaSettings("streamloop");
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
  // [SYNCV3 / STAGE-09 / SELF-WRITE-SUPPRESSION]
  // [WHY: setLibraryAssociation announces its durable fact before this module
  // updates activeLibraryRecord. The explicit token spans that exact await and
  // is always cleared in finally. On success, the exact locally minted (t,d)
  // identity returned by the write boundary lets later refreshes suppress only
  // our fact, not whichever newer fact may be current when this await resumes.]
  const intent = associationWriteSuppression.beginIntent(localLibraryId);
  try {
    const writeResult = await profile.setLibraryAssociation(localLibraryId, targetProfileId, {
      includeAuthoredFact: true,
    });
    if (!writeResult) return null;
    const { libraryId: sharedLibraryId, authoredFact } = writeResult;
    associationWriteSuppression.captureAuthoredFact(intent, sharedLibraryId, authoredFact);
    return getLibraryByLibraryId(sharedLibraryId);
  } finally {
    associationWriteSuppression.endIntent(intent);
  }
}

// [SYNCV3 / STAGE-07 / ASSOCIATION-WRITE]
// `targetProfileId: null` is an intentional shared disassociation. An omitted,
// undefined, or unknown id is invalid. The options object keeps those cases
// distinct without a truthy/falsy shortcut.
async function associateCurrentLibraryWithProfile({ targetProfileId } = {}) {
  if (targetProfileId !== null && !getProfileNameById(targetProfileId)) return false;

  if (currentSourceKind === "cassette" || currentSourceKind === "cassette-folder") {
    if (!activeCassetteRecord?.id) return false;
    try {
      await setSourceCuration(`cassette:${activeCassetteRecord.id}`, targetProfileId, {
        sourceKind: currentSourceKind,
      });
      activeCassetteCurationId = targetProfileId;
      syncAssociateButtonVisibility();
      const targetProfileName = getProfileNameById(targetProfileId);
      fsaStatusText.textContent = targetProfileName
        ? `Now remembered with ${targetProfileName} on this device.`
        : "This media now has No Curation on this device.";
      return true;
    } catch (error) {
      console.warn("[SOURCE CURATION] Could not save the remembered Floppy Curation.", error);
      fsaStatusText.textContent = "Could not save the Curation for this media. Try again.";
      return false;
    }
  }

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
        establishAmbientProfileContext(activeLibraryRecord);
        pendingLegacySignature = null;
        logLegacyIdentity("associated profile id", { profileId: targetProfileId, libraryId: activeLibraryRecord.id });
        syncAssociateButtonVisibility();
        const targetProfileName = getProfileNameById(targetProfileId);
        fsaStatusText.textContent = targetProfileName
          ? `Now remembered with ${targetProfileName}. It should be recognized next time you pick the same Media Folder here.`
          : "This folder now has No Curation.";
        return true;
      } catch (error) {
        console.warn("[LEGACY-IDENTITY] Could not save this legacy library association.", error);
        fsaStatusText.textContent = "Could not save the Curation for this folder. Try again.";
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
    // [SYNCV3 / STAGE-07 / ASSOCIATION-WRITE]
    // Stage 07 never offers its arbitrary-target picker for this id-less
    // session model. Preserve its historical active-Profile-only behavior.
    if (targetProfileId !== profile.getProfileId()) return false;
    legacySessionAssociated = true;
    syncAssociateButtonVisibility();
    fsaStatusText.textContent = `This Media Folder is remembered with "${profile.getProfileName()}" Curation for this session.`;
    return true;
  }

  if (currentSourceKind !== "fsa" || !activeLibraryRecord || !activeLibraryRecord.id) return false;

  fsaAssociateBtn.disabled = true;
  profileAssociateBtn.disabled = true;
  try {
    const updated = await associateThroughSyncV2(activeLibraryRecord.id, targetProfileId);
    activeLibraryRecord = updated || { ...activeLibraryRecord, profileId: targetProfileId };
    establishAmbientProfileContext(activeLibraryRecord);
    syncAssociateButtonVisibility();
    const targetProfileName = getProfileNameById(targetProfileId);
    fsaStatusText.textContent = targetProfileName
      ? `Now remembered with ${targetProfileName}.`
      : "This folder now has No Curation.";
    await renderRecentLibraries();
    return true;
  } catch (error) {
    console.warn("[LIBRARY-REGISTRY] Could not associate this library with the current profile.", error);
    fsaStatusText.textContent = "Could not save the Curation for this folder. Try again.";
    return false;
  } finally {
    fsaAssociateBtn.disabled = false;
    profileAssociateBtn.disabled = false;
  }
}

// [LIBRARY-PROFILE-UX / Phase 8.5]
// WHAT: "Choose/Change Profile for This Library" — navigation only. No
// longer persists anything itself.
// WHY: Section 4/5 — clicking this must never write a profile association
// directly; it hands off to the Profile section, where the user can choose
// a profile and then click the explicit association button.
// FUTURE: If this ever needs to do more than "set intent + navigate", that
// is itself a sign the design boundary from section 4/6 is being crossed —
// reconsider before adding logic here.
fsaAssociateBtn.addEventListener("click", () => {
  if (currentSourceKind === "none") return;
  dismissedAssociationHelpKey = null;
  syncAssociateButtonVisibility();
  // [SYNCV3 / STAGE-07 / MOBILE-ASSOCIATION-HANDOFF]
  // [WHY: a mobile association shortcut must complete the navigation it
  // initiates; opening Profile beneath the Media Folder takeover leaves the
  // user in the wrong visible workspace. Route through the drawer's canonical
  // close owner, then let the existing Settings activation/open/focus path run.]
  // Desktop is deliberately unchanged: its rail is not a drawer and this
  // compact-only branch is skipped entirely.
  if (isCompactViewport()) closeControlsDrawer();
  pendingLibraryAssociationIntent = true;
  expandAndScrollToProfileSection();
});

// [SYNCV3 / STAGE-07 / ASSOCIATION-UI]
// [WHY: Stage 07 manages only the current local Library because catalog-only
// shared Libraries are not writable through the existing localLibraryId-keyed
// association path.]
function populateAssociationPicker({ preservePending = false } = {}) {
  const associationUi = getCurrentAssociationUiState();
  const pendingValue = preservePending ? profileAssociationSelect.value : null;
  const profiles = profile.listProfiles();
  profileAssociationSelect.innerHTML = "";

  const noProfile = document.createElement("option");
  noProfile.value = "";
  noProfile.textContent = "— No Curation —";
  profileAssociationSelect.appendChild(noProfile);

  for (const entry of profiles) {
    const option = document.createElement("option");
    option.value = entry.id;
    option.textContent = entry.name;
    profileAssociationSelect.appendChild(option);
  }

  const availableIds = new Set(profiles.map((entry) => entry.id));
  if (preservePending && pendingValue && availableIds.has(pendingValue)) {
    profileAssociationSelect.value = pendingValue;
  } else if (associationUi.state === "S1" && availableIds.has(profile.getProfileId())) {
    profileAssociationSelect.value = profile.getProfileId();
  } else if (["S2", "S3"].includes(associationUi.state) && availableIds.has(associationUi.associatedProfileId)) {
    profileAssociationSelect.value = associationUi.associatedProfileId;
  } else {
    profileAssociationSelect.value = "";
  }
}

function openAssociationEditor() {
  const associationUi = getCurrentAssociationUiState();
  if (!associationUi.allowPicker) return false;
  populateAssociationPicker();
  profileAssociationResult.textContent = "";
  profileAssociationRow.classList.remove("hidden");
  profileAssociateBtn.setAttribute("aria-expanded", "true");
  profileAssociationSelect.focus();
  return true;
}

function closeAssociationEditor({ returnFocus = true } = {}) {
  profileAssociationRow.classList.add("hidden");
  profileAssociateBtn.setAttribute("aria-expanded", "false");
  if (returnFocus) profileAssociateBtn.focus();
}

profileAssociateBtn.addEventListener("click", () => {
  dismissedAssociationHelpKey = null;
  syncAssociateButtonVisibility();
  if (profileAssociationRow.classList.contains("hidden")) openAssociationEditor();
  else closeAssociationEditor();
});

profileAssociationSaveBtn.addEventListener("click", async () => {
  const selectedProfileId = profileAssociationSelect.value || null;
  const selectedProfileName = selectedProfileId ? getProfileNameById(selectedProfileId) : null;
  const associationBeforeSave = getCurrentAssociationUiState();
  profileAssociationSaveBtn.disabled = true;
  profileAssociationCancelBtn.disabled = true;
  try {
    const saved = associationBeforeSave.associatedProfileId === selectedProfileId
      ? true
      : await associateCurrentLibraryWithProfile({ targetProfileId: selectedProfileId });
    if (!saved) {
      profileAssociationResult.textContent = "Could not save. Try again.";
      return;
    }
    const isCassetteSource = currentSourceKind === "cassette" || currentSourceKind === "cassette-folder";
    profileAssociationResult.textContent = isCassetteSource
      ? selectedProfileName
        ? `Now remembered with ${selectedProfileName} on this device.`
        : "This media now has No Curation on this device."
      : selectedProfileName
        ? `Now remembered with ${selectedProfileName}.`
        : "This folder now has No Curation.";
    // [SYNCV3 / STAGE-10 / COMPLETED-EXPLAINER]
    // [WHY: the old action's benefit has finished its job. Scope dismissal to
    // this exact Library/association state so a new state or later interaction
    // can explain its own current action without a timer or forced blur.]
    dismissedAssociationHelpKey = associationHelpKey(getCurrentAssociationUiState());
    syncAssociateButtonVisibility();
    closeAssociationEditor();
  } catch (error) {
    console.warn("[SYNCV3 / STAGE-07 / ASSOCIATION-WRITE] Could not save association.", error);
    profileAssociationResult.textContent = "Could not save. Try again.";
  } finally {
    profileAssociationSaveBtn.disabled = false;
    profileAssociationCancelBtn.disabled = false;
  }
});

profileAssociationCancelBtn.addEventListener("click", () => closeAssociationEditor());

profileAssociationRow.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  event.preventDefault();
  closeAssociationEditor();
});

const NEW_SHARED_LIBRARY_VALUE = "__new_shared_library__";

// [SYNCV3 / STAGE-08 / LINK-UI]
// [WHY: This is the single adapter from current local-folder state and the
// shared catalog into the pure L0-L7 model. Library names remain presentation;
// every selection and write is keyed by the catalog id.]
function getCurrentFolderLinkUiState({ selectedLibraryId = null, selectedClaimant = null } = {}) {
  const folderSourceKind = currentSourceKind === "cassette" || currentSourceKind === "cassette-folder"
    ? "none"
    : currentSourceKind;
  return mapLinkState({
    sourceKind: folderSourceKind,
    legacyHasDurableIdentity,
    folderName: activeLibraryRecord?.name || activeLibraryDisplayName || "Loaded Media Folder",
    localLibraryId: activeLibraryRecord?.id || null,
    sharedLibraryId: activeLibraryRecord?.libraryId || null,
    sharedLibraries: profile.listLibraries(),
    permissionState: currentFolderPermissionState,
    selectedLibraryId,
    selectedClaimant,
  });
}

function renderFolderLinkState({ selectedLibraryId = null, selectedClaimant = pendingFolderLinkClaimant } = {}) {
  if (!profileFolderLinkSummary) return null;
  const linkUi = getCurrentFolderLinkUiState({ selectedLibraryId, selectedClaimant });
  // [NORTH-STAR / N1 / PROGRESSIVE-DISCLOSURE]
  // BREADCRUMBS — IS: ordinary visibility deliberately reads no peers, v3Peers,
  //   v3Configured or shared catalog; link state alone drives disclosure.
  const ordinarySurface = describeMediaLibrarySurface({ linkState: linkUi, surface: "ordinary" });
  const advancedSurface = describeMediaLibrarySurface({ linkState: linkUi, surface: "advanced" });
  profileFolderLinkSummary.textContent = ordinarySurface.statusText;
  const hasFolderSource = currentSourceKind !== "cassette" && currentSourceKind !== "cassette-folder";
  profileFolderLinkSummary.classList.toggle("hidden", !hasFolderSource || !ordinarySurface.showStatus);
  applyProductStatusTone(profileFolderLinkSummary, linkUi.tone);
  profileFolderLinkAdvancedSummary.textContent = advancedSurface.statusText;
  applyProductStatusTone(profileFolderLinkAdvancedSummary, linkUi.tone);

  // [SYNCV3 / STAGE-10 / MEDIA-LIBRARY-SELECTION]
  // [WHY: the selector replaced the old Link/Share disclosure, so this button
  // now has exactly one job left — L7 reconnect. `showAction` is true in that
  // state alone; every other durable state renders the selector instead.]
  profileFolderLinkBtn.textContent = linkUi.actionLabel || "Reconnect Media Folder";
  profileFolderLinkBtn.classList.toggle("hidden", !hasFolderSource || !ordinarySurface.showRecoveryAction);
  profileFolderLinkBtn.disabled = !hasFolderSource || !ordinarySurface.showRecoveryAction;

  const showSelector = Boolean(advancedSurface.showSelector);
  const wasHidden = profileFolderLinkRow.classList.contains("hidden");
  profileFolderLinkRow.classList.toggle("hidden", !showSelector);
  if (!showSelector) {
    clearFolderLinkConflict();
    profileFolderActionHelp.textContent = "";
    refreshContextualHelpAfterRender(contextualHelpEntries[1]);
    return linkUi;
  }
  if (activeLibraryRecord?.id && (wasHidden || profileFolderLinkSelect.options.length === 0)) {
    populateFolderLinkPicker();
  }
  profileFolderLinkSelect.disabled = !activeLibraryRecord?.id || !linkUi.allowPicker;

  profileFolderActionHelp.textContent = linkUi.actionHelp;

  const linkedId = activeLibraryRecord?.libraryId || "";
  const selected = profileFolderLinkSelect.value;
  const isCreateNew = selected === NEW_SHARED_LIBRARY_VALUE;
  // Steady state is a plain property row. Save/Cancel appear only once the
  // reader has actually changed the selection, so choosing never feels like an
  // operation that has to be confirmed.
  const pendingChange = selected !== linkedId;

  // [SYNCV3 / STAGE-08 / LINK-COLLISION-WARNING]
  // [WHY: a storage-level claimant refusal is safety-critical and must be
  // visually distinct from ordinary explanatory text. Keep the select focused
  // and explain the disabled Save inline through its existing described-by id.]
  const showClaimantWarning = Boolean(selectedClaimant);
  // [SYNCV3 / STAGE-08 / DIRECT-RELINK-WARNING]
  // [WHY: choosing a different Media Library directly is intentionally
  // forbidden until the current one is explicitly removed; this identity-safety
  // refusal must be as visually obvious as a claimant collision. It shares
  // presentation, not semantics, with the claimant guard immediately above.
  // Stage 08 semantics are frozen: only the wording moved off "unlink".]
  const showDirectRelinkWarning = Boolean(
    !showClaimantWarning &&
    linkedId &&
    selected &&
    selected !== linkedId
  );
  const showSafetyWarning = showClaimantWarning || showDirectRelinkWarning;
  const selectedLibrary = selected && !isCreateNew
    ? profile.listLibraries().find((library) => library.id === selected)
    : null;
  const libraryName = selectedLibrary?.name || "That Media Library";
  const folderName = selectedClaimant?.name || "another Media Folder";
  const currentFolderName = activeLibraryRecord?.name || activeLibraryDisplayName || "This Media Folder";
  const targetLibraryName = selectedLibrary?.name || "a new Media Library";
  profileFolderLinkConflict.classList.toggle("hidden", !showSafetyWarning);
  profileFolderLinkConflictHeading.textContent = showClaimantWarning
    ? "⚠ Already used on this device"
    : showDirectRelinkWarning
      ? "⚠ Remove this Media Folder first"
      : "";
  profileFolderLinkConflictDetail.textContent = showClaimantWarning
    ? `“${libraryName}” already represents the Media Folder “${folderName}”.`
    : showDirectRelinkWarning
      ? `“${currentFolderName}” already uses another Media Library.`
      : "";
  profileFolderLinkConflictAction.textContent = showClaimantWarning
    ? `Remove ${folderName} from that Media Library first.`
    : showDirectRelinkWarning
      ? `Remove this Media Folder from its Media Library before choosing “${targetLibraryName}”.`
      : "";

  // [SYNCV3 / STAGE-10 / MEDIA-LIBRARY-SELECTION]
  // [WHY: naming belongs to creation, not to selection. The field is prefilled
  // from the Media Folder name because promoteLibraryToShared already stored
  // exactly that; the adjacent copy is what stops the prefill reading as a
  // folder rename.]
  profileFolderNewLibraryRow.classList.toggle("hidden", !isCreateNew);
  if (isCreateNew && !profileFolderNewLibraryInput.value.trim()) {
    profileFolderNewLibraryInput.value = activeLibraryRecord?.name || "";
  }

  // [SYNCV3 / STAGE-10 / MEDIA-LIBRARY-SELECTION]
  // [WHY: VERIFIED against ProfileStore, not assumed — a Media Library created
  // on another device reaches this catalog only through adoptMergedReplica(),
  // and the only callers of that are the sync-v2/sync-v3 passes and V2
  // activation. Before a Sync Folder is connected this list is local-only, so
  // an empty selector states the real prerequisite instead of looking broken.]
  const catalogIsEmpty = profile.listLibraries().length === 0;
  const syncStatus = profileSync.getStatus();
  const syncConfigured = Boolean(syncStatus.configured || syncStatus.v3Configured);
  const showSyncHint = catalogIsEmpty && !syncConfigured;
  profileFolderLibrarySyncHint.classList.toggle("hidden", !showSyncHint);
  profileFolderLibrarySyncBtn.classList.toggle("hidden", !showSyncHint);

  profileFolderLinkSaveBtn.textContent = isCreateNew ? "Create Media Library" : "Use This Media Library";
  profileFolderLinkSaveBtn.classList.toggle("hidden", !pendingChange);
  profileFolderLinkCancelBtn.classList.toggle("hidden", !pendingChange);
  profileFolderLinkSaveBtn.disabled = isCreateNew ? Boolean(linkedId) : !linkUi.saveEnabled;

  const canUnlink = Boolean(linkedId) && !pendingChange;
  profileFolderUnlinkBtn.classList.toggle("hidden", !canUnlink);
  profileFolderUnlinkHelp.classList.toggle("hidden", !canUnlink);
  refreshContextualHelpAfterRender(contextualHelpEntries[1]);
  return linkUi;
}

function populateFolderLinkPicker({ preservePending = false } = {}) {
  const pendingValue = preservePending ? profileFolderLinkSelect.value : "";
  const catalog = profile.listLibraries();
  const linkedId = activeLibraryRecord?.libraryId || "";
  profileFolderLinkSelect.innerHTML = "";

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Choose a Media Library…";
  profileFolderLinkSelect.appendChild(placeholder);

  // [SYNCV3 / STAGE-10 / MEDIA-LIBRARY-OPTION-LABELS]
  // [WHY: labels are derived in one pure pass over the whole catalog, because
  // whether a name needs disambiguating is a property of the SET, not of the
  // record. The option's value stays the durable id either way.]
  for (const option of describeMediaLibraryOptions({
    libraries: catalog,
    currentDeviceId: profile.getDeviceId(),
  })) {
    const element = document.createElement("option");
    element.value = option.id;
    element.textContent = option.label;
    profileFolderLinkSelect.appendChild(element);
  }

  if (linkedId && !catalog.some((library) => library.id === linkedId)) {
    // This one genuinely has no name yet — the Library fact has not reached
    // this device, so its id is the only thing there is to show.
    const pending = document.createElement("option");
    pending.value = linkedId;
    pending.textContent = `Media Library · ${linkedId.slice(0, 8)}…`;
    profileFolderLinkSelect.appendChild(pending);
  }

  // Creation stays at the bottom, after every existing Media Library, so
  // "choose the one you already use" is the path a reader meets first.
  const createOption = document.createElement("option");
  createOption.value = NEW_SHARED_LIBRARY_VALUE;
  createOption.textContent = "Create New Media Library…";
  profileFolderLinkSelect.appendChild(createOption);

  const values = new Set([...profileFolderLinkSelect.options].map((option) => option.value));
  if (preservePending && values.has(pendingValue)) profileFolderLinkSelect.value = pendingValue;
  else if (linkedId) profileFolderLinkSelect.value = linkedId;
  else profileFolderLinkSelect.value = "";
}

async function refreshFolderLinkSelection() {
  const selected = profileFolderLinkSelect.value;
  pendingFolderLinkClaimant = null;
  if (selected && selected !== NEW_SHARED_LIBRARY_VALUE && activeLibraryRecord?.id) {
    const claimant = await getLibraryByLibraryId(selected);
    if (profileFolderLinkSelect.value !== selected) return;
    if (claimant && claimant.id !== activeLibraryRecord.id) pendingFolderLinkClaimant = claimant;
  }
  renderFolderLinkState({ selectedLibraryId: selected, selectedClaimant: pendingFolderLinkClaimant });
}

async function refreshCurrentFolderPermission() {
  const recordId = activeLibraryRecord?.id;
  if (currentSourceKind !== "fsa" || !activeLibraryRecord?.handle?.queryPermission) {
    currentFolderPermissionState = "granted";
    renderFolderLinkState();
    return;
  }
  try {
    currentFolderPermissionState = await activeLibraryRecord.handle.queryPermission({ mode: "read" });
  } catch (_error) {
    currentFolderPermissionState = "prompt";
  }
  if (activeLibraryRecord?.id === recordId) renderFolderLinkState();
}

function clearFolderLinkConflict() {
  pendingFolderLinkClaimant = null;
  profileFolderLinkConflict.classList.add("hidden");
  profileFolderLinkConflictHeading.textContent = "";
  profileFolderLinkConflictDetail.textContent = "";
  profileFolderLinkConflictAction.textContent = "";
}

// [SYNCV3 / STAGE-10 / MEDIA-LIBRARY-SELECTION]
// [WHY: with the selector always visible there is nothing to close — Cancel
// simply puts the control back to the Media Library this Media Folder is
// actually using. Nothing is written, so this is never a destructive step.]
function resetFolderLinkSelection({ returnFocus = true } = {}) {
  clearFolderLinkConflict();
  profileFolderNewLibraryInput.value = "";
  populateFolderLinkPicker();
  renderFolderLinkState();
  if (returnFocus) profileFolderLinkSelect.focus();
}

profileFolderLinkBtn.addEventListener("click", () => {
  refreshCurrentFolderPermission().then(() => {
    const linkUi = getCurrentFolderLinkUiState();
    if (linkUi.reconnectNeeded) resumeLibrary(activeLibraryRecord);
  });
});
profileFolderLinkSelect.addEventListener("change", () => {
  profileFolderNewLibraryInput.value = "";
  refreshFolderLinkSelection();
});
profileFolderLinkCancelBtn.addEventListener("click", () => resetFolderLinkSelection());
profileFolderLinkRow.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  event.preventDefault();
  resetFolderLinkSelection();
});

// [SYNCV3 / STAGE-10 / MEDIA-LIBRARY-SELECTION]
// [WHY: reuses the existing Settings navigation — the Sync group is a sibling
// inside this same always-open section, so this is a scroll and a focus, not a
// second Sync entry point.]
profileFolderLibrarySyncBtn.addEventListener("click", () => {
  profileSyncGroup.scrollIntoView({ block: "nearest" });
  profileSyncV3ChooseBtn.focus();
});

profileFolderLinkSaveBtn.addEventListener("click", async () => {
  const selected = profileFolderLinkSelect.value;
  if (!selected || !activeLibraryRecord?.id) return;
  profileFolderLinkSaveBtn.disabled = true;
  try {
    let result;
    if (selected === NEW_SHARED_LIBRARY_VALUE) {
      const typedName = profileFolderNewLibraryInput.value.trim();
      result = await profile.promoteLibraryToShared(activeLibraryRecord.id, {
        name: typedName || activeLibraryRecord.name,
      });
    } else if (selected === activeLibraryRecord.libraryId) {
      result = activeLibraryRecord;
    } else {
      result = await profile.linkLocalLibraryToShared(activeLibraryRecord.id, selected);
    }
    if (result?.ok === false && result.reason === "claimed") {
      pendingFolderLinkClaimant = result.by;
      renderFolderLinkState({ selectedLibraryId: selected, selectedClaimant: result.by });
      return;
    }
    if (!result) {
      profileFolderLinkResult.textContent = "Could not save that Media Library. Try again.";
      return;
    }
    activeLibraryRecord = await getLibraryById(activeLibraryRecord.id) || result;
    establishAmbientProfileContext(activeLibraryRecord);
    // [SYNCV3 / STAGE-10 / MEDIA-LIBRARY-SELECTION]
    // [WHY: the one moment a reader most needs to hear that nothing happened to
    // their files. Uses the status line this group already owns rather than a
    // new notification surface.]
    const savedName = getSharedLibraryNameById(activeLibraryRecord.libraryId);
    profileFolderLinkResult.textContent = savedName
      ? `Now using the ${savedName} Media Library. Your files were not changed or moved.`
      : "Media Library saved. Your files were not changed or moved.";
    profileFolderNewLibraryInput.value = "";
    populateFolderLinkPicker();
    await renderRecentLibraries();
    syncAssociateButtonVisibility();
    clearFolderLinkConflict();
    renderFolderLinkState();
  } catch (error) {
    console.warn("[SYNCV3 / STAGE-08 / LINK-AND-SYNC] Could not save folder link.", error);
    profileFolderLinkResult.textContent = "Could not save that Media Library. Try again.";
  } finally {
    if (!pendingFolderLinkClaimant) profileFolderLinkSaveBtn.disabled = false;
  }
});

function getSharedLibraryNameById(libraryId) {
  if (!libraryId) return "";
  const entry = profile.listLibraries().find((library) => library.id === libraryId);
  return entry?.name || "";
}

profileFolderUnlinkBtn.addEventListener("click", async () => {
  if (!activeLibraryRecord?.id || !activeLibraryRecord.libraryId) return;
  profileFolderUnlinkBtn.disabled = true;
  try {
    // Stage 08 semantics unchanged: this clears only this device's local
    // Media Folder -> Media Library row. Nothing shared is deleted.
    const unlinked = await profile.unlinkLocalLibraryFromShared(activeLibraryRecord.id);
    if (!unlinked) throw new Error("Local Library row was unavailable.");
    activeLibraryRecord = unlinked;
    establishAmbientProfileContext(activeLibraryRecord);
    profileFolderLinkResult.textContent = "This Media Folder no longer uses a Media Library. Your files were not changed or moved.";
    profileFolderNewLibraryInput.value = "";
    populateFolderLinkPicker();
    await renderRecentLibraries();
    syncAssociateButtonVisibility();
    clearFolderLinkConflict();
    renderFolderLinkState();
  } catch (error) {
    console.warn("[SYNCV3 / STAGE-08 / UNLINK] Could not unlink folder.", error);
    profileFolderLinkResult.textContent = "Could not remove this Media Folder from its Media Library. Try again.";
  } finally {
    profileFolderUnlinkBtn.disabled = false;
  }
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
  cancelWarmStart();
  handleManualNavigationLoopReset();
  flushPendingFilterReload();
  runtime.previous();
}

function goToNextMedia() {
  cancelWarmStart();
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
  mobileContextText.textContent = `Curation: ${associatedText.textContent}`;
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

// [PM-SHUFFLE-FOLDERS] Extracted verbatim from toggleAutomationsTray()'s own
// open branch (which now calls it) so there is still exactly ONE way the tray
// opens. Needed as a callable step because a 🎲 switch runs through
// loadFromFsaHandle(), whose exitFillMode() closes the tray along with
// Presentation Mode itself — restoring it afterwards has to reach the same
// mutual-exclusion + aria-expanded work a click does, not re-set the class by
// hand and let aria drift.
function openAutomationsTray() {
  // Only one pop-out panel makes sense open at a time — same rule
  // #overlay-automation-btn and #overlay-settings-btn already follow.
  presentationSettings.classList.add("hidden");
  closeGhostPopunder();
  pmAutomationsGroup.classList.add("is-open");
  overlayAutomationsMenuBtn.classList.add("is-open");
  overlayAutomationsMenuBtn.setAttribute("aria-expanded", "true");
}

function toggleAutomationsTray() {
  const willOpen = !pmAutomationsGroup.classList.contains("is-open");

  if (!willOpen) {
    closeAutomationsTray();
    return;
  }

  openAutomationsTray();
}

// ---- PM Shuffle Folders (immediate runtime action) -------------------------
//
// [PM-SHUFFLE-FOLDERS]
// WHAT: ⚡ → 🎲 switches Browser Gallery to another remembered Media Folder,
// now. The whole customer interaction is those two clicks: no Settings trip,
// no Advanced Settings, no folder picker, no restart, and nothing to
// configure first.
//
// WHY it is an ACTION, not an automation: it happens once and is then over.
// It writes no state that outlives the switch, which is what keeps ⚡'s
// protected contract intact — syncAutomationsActiveIndicator() derives "an
// automation is active" from videoLoopInput.checked ALONE, this action never
// touches that checkbox or activeLoopRule, and so ⚡ keeps behaving exactly
// as before (idle → toggle the tray; Loop active → stop it). There is
// deliberately no Stop state for a one-shot: by the time one could be
// offered, there is nothing left running to stop.
//
// Guarded against re-entry by `isShufflingFolders` AND by the loader's own
// `isLoadingFiles`: loadFromFsaHandle() silently returns if a load is
// already in flight, so a second 🎲 landing mid-switch would otherwise look
// like it did nothing at all rather than like a control that was busy.
let isShufflingFolders = false;

// [PM-SHUFFLE-FOLDERS] "Can this remembered folder be opened WITHOUT asking
// the customer for anything?" — the live half of usability that
// folder-shuffle.js deliberately cannot answer.
//
// queryPermission() is a question, never a ceremony; requestPermission() is
// the ceremony, and this action must never reach it. That is the whole
// reason permission is pre-checked here rather than left to resumeLibrary():
// resumeLibrary() will happily PROMPT for a folder whose permission has
// lapsed (correct for a deliberate Recent-Media-Folders click, wrong for a
// die roll the customer expects to just switch), so only already-granted
// candidates are ever handed to it. A candidate that fails this is skipped
// and the next one tried — a revoked permission, a disconnected drive or a
// stale handle is a reason to move on, not to interrupt.
async function canShuffleToRememberedFolder(record) {
  const handle = record && record.handle;
  if (!handle || typeof handle.queryPermission !== "function") return false;

  try {
    return (await handle.queryPermission({ mode: "read" })) === "granted";
  } catch (error) {
    // A handle can be genuinely invalid (folder deleted/moved, browser data
    // cleared). Skip it quietly — unlike resumeLibrary()'s own catch, this
    // deliberately does NOT removeFromRecents(): the customer did not ask
    // for THIS folder, so a die roll must not prune their remembered list
    // as a side effect.
    console.warn("[PM-SHUFFLE-FOLDERS] Skipping a remembered Media Folder that could not be checked.", error);
    return false;
  }
}

async function shuffleToAnotherRememberedFolder() {
  if (isShufflingFolders || isLoadingFiles) return;

  isShufflingFolders = true;
  overlayShuffleFoldersBtn.disabled = true;

  try {
    // [LIBRARY-REGISTRY] listLibraries() is THE authoritative remembered-
    // Media-Folder collection — the same read renderRecentLibraries() and
    // the startup-media pass use. Read fresh on every click rather than
    // cached, so a folder added or removed since Presentation Mode opened
    // is reflected without this action needing its own invalidation.
    let rows;
    try {
      rows = await listLibraries();
    } catch (error) {
      console.warn("[PM-SHUFFLE-FOLDERS] Could not read the remembered Media Folders.", error);
      return;
    }

    const candidates = orderShuffleFolderCandidates({
      libraries: rows,
      currentLibraryId: activeLibraryRecord?.id || null,
    });

    for (const candidate of candidates) {
      if (!(await canShuffleToRememberedFolder(candidate))) continue;

      // Captured BEFORE the load, because loadFromFsaHandle() calls
      // exitFillMode() as part of its ordinary staging — that is existing,
      // protected behavior for every media load, not something to change
      // for this one caller. Restoring Presentation Mode afterwards is the
      // smallest safe continuation: it reuses enterFillMode()/
      // openAutomationsTray() exactly as a click would, and adds no new PM
      // navigation or playback mechanism.
      const wasPresenting = fillModeActive;
      const trayWasOpen = pmAutomationsGroup.classList.contains("is-open");

      // [LIBRARY-REGISTRY] The canonical remembered-folder load path, reused
      // whole: resumeLibrary() → loadFromFsaHandle(). Nothing about
      // directory scanning, media projection, FSA handling, profile
      // association or startup-media behavior is duplicated here. Because
      // permission was already confirmed granted just above, resumeLibrary()
      // takes its no-prompt path.
      //
      // Awaited to COMPLETION, not merely started: loadFromFsaHandle() only
      // reaches finishLoadingItems() — the MEDIA LOADED boundary, where
      // runtime.load() publishes the new media set — near the end of its own
      // work. Re-entering Presentation Mode before that would put the
      // customer back in front of the OUTGOING media set.
      await resumeLibrary(candidate);

      if (wasPresenting) {
        enterFillMode();
        if (trayWasOpen) openAutomationsTray();
      }
      return;
    }

    // Nothing usable to switch to — the only remembered folder is the one
    // already loaded, or every alternative needs customer intervention.
    // Staying put IS the correct outcome here: there is no failure to
    // report, so Presentation Mode is left exactly as it was rather than
    // pushed into an error state or interrupted by a modal.
  } finally {
    isShufflingFolders = false;
    overlayShuffleFoldersBtn.disabled = false;
  }
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
  transitionSamples = [];
  transitionCount = 0;
  lastVisibleCommitAt = currentViewerNode?.tagName === "IMG" ? performance.now() : null;
  refreshReadyQueue();
}

function exitFillMode() {
  if (!fillModeActive) return;

  cancelWarmStart();

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
  lastVisibleCommitAt = null;
  releaseReadyQueue({ includeWarming: true });
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

// Renamed on screen to "Toolbar Opacity" — this function/id/storage field
// keep their original "ghost" names (see the DOM-capture comment above).
function applyGhostOpacity(percent) {
  currentGhostOpacityPercent = percent;
  presentationControls.style.setProperty("--ghost-opacity", String(percent / 100));
  ghostOpacityLabel.textContent = `${percent}%`;
}

// [PM-TOOLBAR-OPACITY] Presentation Mode toolbar opacity has two independent
// states: normal opacity (Toolbar Opacity, applyGhostOpacity() above) and
// temporary hover opacity (this function). Hover never changes the stored
// normal value — see the mouseenter/mouseleave listeners below, where
// mouseleave always restores currentGhostOpacityPercent, never something
// this function touches.
//
// Also updates --ghost-opacity directly (not just currentHoverOpacityPercent
// + the label) as a live preview: this slider can only be dragged while the
// pointer is over #presentation-controls (the popunder that contains it is
// nested inside it), so the toolbar bar IS in its hovered state for as long
// as this slider is reachable — applying it immediately, rather than
// waiting for a mouseenter that already fired, is what makes the slider
// preview its own effect live, same as the resting slider already does.
function applyHoverOpacity(percent) {
  currentHoverOpacityPercent = percent;
  hoverOpacityLabel.textContent = `${percent}%`;
  presentationControls.style.setProperty("--ghost-opacity", String(percent / 100));
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
    cancelWarmStart();
    runtime.stop();
  } else {
    runtime.play();
    maybeBeginWarmStart();
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

// BREADCRUMBS - WAS
// Phase 3A prepared only the item already selected as current. It held the
// outgoing image until that one resource became ready, so the black frame was
// removed but the network wait still sat on the customer's critical path.
//
// BREADCRUMBS - IS
// While Presentation Mode is active and the current image is visibly committed,
// this bounded warmer reads MediaRuntime's actual six-item shuffle plan. It
// prepares image nodes source-neutrally, never chooses an item, and releases
// nodes that leave the plan. A ready node is advisory; every miss still takes
// Phase 3A's held-frame path.
//
// BREADCRUMBS - WILL BE
// The queue remains image-only and count-bounded. Video buffering, byte-based
// memory policy, retries, failure classification and dead-item auto-skip need
// separate evidence and architecture; none is implied by this seam.
function releasePreparedImage(item) {
  const entry = preparedViewerImages.get(item);
  if (!entry) return;
  entry.node.src = "";
  preparedViewerImages.delete(item);
}

function releaseReadyQueue({ includeWarming = false } = {}) {
  for (const item of [...preparedViewerImages.keys()]) releasePreparedImage(item);
  if (includeWarming) {
    for (const entry of warmingViewerImages.values()) entry.node.src = "";
    warmingViewerImages.clear();
    failedWarmItems.clear();
  }
}

function warmPlannedImage(item) {
  const entry = {
    item,
    node: new Image(),
    loadGeneration: libraryLoadGeneration,
    galleryGeneration,
  };
  const { node } = entry;
  node.alt = item.name;
  node.decoding = "async";
  warmingViewerImages.set(item, entry);

  const settled = new Promise((resolve, reject) => {
    node.addEventListener("load", resolve, { once: true });
    node.addEventListener("error", reject, { once: true });
  });
  node.src = item.url;

  (async () => {
    let loaded = false;
    try {
      await settled;
      loaded = true;
      if (typeof node.decode === "function") {
        try {
          await node.decode();
        } catch {
          // Native load remains authoritative; decode is best-effort only.
        }
      }
    } catch {
      // A warm failure changes no playback state and gets no retry loop.
    }

    if (warmingViewerImages.get(item) !== entry) {
      node.src = "";
      return;
    }
    warmingViewerImages.delete(item);

    const plannedItems = fillModeActive ? runtime.getPlannedItems(PLAN_LENGTH) : [];
    const remainsValid =
      loaded &&
      fillModeActive &&
      entry.loadGeneration === libraryLoadGeneration &&
      entry.galleryGeneration === galleryGeneration &&
      plannedItems.includes(item);

    if (remainsValid) {
      preparedViewerImages.set(item, entry);
    } else {
      node.src = "";
      if (!loaded && plannedItems.includes(item)) failedWarmItems.add(item);
    }
    refreshReadyQueue();
  })();
}

function refreshReadyQueue() {
  const state = runtime.getState();
  const currentImageVisible =
    state.currentItem?.kind === "image" &&
    currentViewerItem === state.currentItem &&
    currentViewerNode?.tagName === "IMG" &&
    !viewerStage.classList.contains("hidden");

  if (!fillModeActive || !currentImageVisible || currentViewerPreparationInFlight) return;

  const plannedItems = runtime.getPlannedItems(PLAN_LENGTH);
  for (const item of [...failedWarmItems]) {
    if (!plannedItems.includes(item)) failedWarmItems.delete(item);
  }
  const warmablePlan = plannedItems.filter((item) => item.kind === "image" && !failedWarmItems.has(item));
  const work = planReadyQueueWork({
    plannedItems: warmablePlan,
    preparedItems: [...preparedViewerImages.keys()],
    warmingItems: [...warmingViewerImages.keys()],
    maxPrepared: MAX_PREPARED,
    maxConcurrent: MAX_CONCURRENT_WARMING,
  });

  work.release.forEach(releasePreparedImage);
  work.start.forEach(warmPlannedImage);
  if (warmStartState === "warming") evaluateWarmStart();
}

function takePreparedViewerImage(item) {
  const entry = preparedViewerImages.get(item);
  if (!entry) return null;
  preparedViewerImages.delete(item);
  const token = ++viewerPreparationCounter;
  const commit = shouldCommitPreparedViewer({
    preparedToken: token,
    currentToken: viewerPreparationCounter,
    preparedLoadGeneration: entry.loadGeneration,
    currentLoadGeneration: libraryLoadGeneration,
    preparedGalleryGeneration: entry.galleryGeneration,
    currentGalleryGeneration: galleryGeneration,
    preparedItem: item,
    currentViewerItem: runtime.getState().currentItem,
  });
  if (!commit) {
    entry.node.src = "";
    return null;
  }
  return entry;
}

function releaseStaleReadyQueueEntries() {
  for (const [item, entry] of preparedViewerImages) {
    if (entry.loadGeneration !== libraryLoadGeneration || entry.galleryGeneration !== galleryGeneration) {
      releasePreparedImage(item);
    }
  }
  for (const [item, entry] of warmingViewerImages) {
    if (entry.loadGeneration !== libraryLoadGeneration || entry.galleryGeneration !== galleryGeneration) {
      entry.node.src = "";
      warmingViewerImages.delete(item);
    }
  }
}

// BREADCRUMBS - WAS
// Phase 3B began Presentation with an empty or shallow ready reserve. A slow
// image among the first few transitions could exhaust the runway before the
// six-deep reserve accumulated; real URL-backed Presentation runs observed
// this more than once as an approximately 15-20 second early stall.
//
// BREADCRUMBS - IS
// When URL-backed image playback begins in Presentation with fewer than three
// valid upcoming prepared images, one small curtain holds automatic advance
// while the existing two-worker queue fills. The current image still commits
// through the normal viewer path underneath it. Release occurs once three
// valid planned images are ready or ten seconds of EXTRA queue-building time
// has elapsed, but never before the current visual reaches a real terminal
// outcome. Human navigation cancels immediately.
//
// BREADCRUMBS - WILL BE
// This remains a fixed cold-start policy, not an adaptive buffer, another
// preloader, or a source model. Future changes require evidence; the runtime's
// six-item plan, two-worker limit, source neutrality and visible timer remain
// authoritative.
function countValidPreparedWarmStartItems() {
  releaseStaleReadyQueueEntries();
  const plannedItems = runtime.getPlannedItems(PLAN_LENGTH);
  let count = 0;
  for (const [item, entry] of preparedViewerImages) {
    const valid =
      entry.loadGeneration === libraryLoadGeneration &&
      entry.galleryGeneration === galleryGeneration &&
      plannedItems.includes(item);
    if (valid) {
      count += 1;
    } else {
      releasePreparedImage(item);
    }
  }
  return count;
}

function finishWarmStart(reason, preparedCount) {
  if (warmStartState !== "warming") return;
  const elapsedMs = performance.now() - warmStartStartedAt;
  warmStartState = "inactive";
  warmStartTimeoutReached = false;
  if (warmStartTimeoutId !== null) {
    window.clearTimeout(warmStartTimeoutId);
    warmStartTimeoutId = null;
  }
  warmStartOverlay.classList.add("hidden");
  stopArcadeAnimation();
  console.info("[PM WARM START] Release", {
    reason,
    elapsed_ms: Math.round(elapsedMs),
    valid_prepared: preparedCount,
  });
  runtime.notifyCurrentItemVisible();
}

function evaluateWarmStart({ cancelled = false } = {}) {
  if (warmStartState !== "warming") return;
  const preparedCount = countValidPreparedWarmStartItems();
  let decision = shouldReleaseWarmStart({
    preparedCount,
    readyThreshold: RELEASE_READY_COUNT,
    elapsedMs: performance.now() - warmStartStartedAt,
    maxMs: WARM_START_MAX_MS,
    cancelled,
  });
  if (!cancelled && warmStartTimeoutReached) decision = { release: true, reason: "timeout" };
  if (!canApplyWarmStartRelease({ decision, currentVisualSettled: warmStartCurrentVisualSettled })) return;
  finishWarmStart(decision.reason, preparedCount);
}

function cancelWarmStart() {
  evaluateWarmStart({ cancelled: true });
}

function maybeBeginWarmStart() {
  if (warmStartState === "warming") return;
  const item = runtime.getState().currentItem;
  if (!fillModeActive || !currentSessionIsUrlBacked || item?.kind !== "image") return;
  const preparedCount = countValidPreparedWarmStartItems();
  if (preparedCount >= RELEASE_READY_COUNT) return;

  warmStartState = "warming";
  warmStartStartedAt = performance.now();
  warmStartCurrentVisualSettled = lastViewerTerminalItem === item;
  warmStartTimeoutReached = false;
  warmStartOverlay.classList.remove("hidden");
  startArcadeAnimation(warmStartCanvas);
  runtime.holdAdvanceForPendingVisual();
  warmStartTimeoutId = window.setTimeout(() => {
    warmStartTimeoutId = null;
    warmStartTimeoutReached = true;
    evaluateWarmStart();
  }, WARM_START_MAX_MS);
}

function handleCurrentViewerTerminal(item) {
  lastViewerTerminalItem = item;
  currentViewerPreparationInFlight = false;
  if (warmStartState === "warming") {
    warmStartCurrentVisualSettled = true;
    refreshReadyQueue();
    evaluateWarmStart();
    return;
  }
  runtime.notifyCurrentItemVisible();
  refreshReadyQueue();
}

// [PRESENTATION-PERF / PHASE 3A]
// The held path. Starts the incoming image loading WITHOUT tearing down the
// outgoing one, then swaps only once the incoming image is genuinely ready —
// and only if it is still the image the viewer is waiting for.
//
// buildViewer() itself stays synchronous: this kicks off a detached promise
// chain and returns immediately, exactly as the eager path returns immediately
// after assigning src. The customer-visible difference is only WHEN the stage
// changes, never what ends up on it.
function prepareHeldFrameImage(item) {
  const renderEntryAt = lastRenderEntryAt;
  const token = ++viewerPreparationCounter;
  const preparedLoadGeneration = libraryLoadGeneration;
  const preparedGalleryGeneration = galleryGeneration;
  currentViewerPreparationInFlight = true;
  runtime.holdAdvanceForPendingVisual();

  // Claimed EAGERLY, before any await. This is what makes buildViewer()'s
  // same-item early return absorb every intervening re-emit — a profile change,
  // a favourite toggle, a status refresh — instead of starting a duplicate
  // preparation for the same item on each one. currentViewerItem therefore
  // means "the item the viewer is showing OR preparing" from here on.
  //
  // currentViewerNode is deliberately NOT touched: it still points at the
  // outgoing image, which is still on screen and still owns the stage. That is
  // the held frame.
  currentViewerItem = item;

  const img = document.createElement("img");
  img.alt = item.name;
  img.decoding = "async";
  const srcAt = performance.now();
  img.src = item.url;
  recordMediaRenderOutcome("mounted");

  // The load/error events are the AUTHORITY on success or failure. Phase 1C's
  // own listeners are deliberately not attached on this path: this promise is
  // the single outcome source for a prepared node, and attaching both would
  // double-count the tally.
  const loaded = new Promise((resolve, reject) => {
    img.addEventListener("load", resolve, { once: true });
    img.addEventListener("error", reject, { once: true });
  });

  (async () => {
    let loadAt = 0;
    let decodeAt = null;
    let failed = false;

    try {
      await loaded;
      loadAt = performance.now();
      if (typeof img.decode === "function") {
        try {
          await img.decode();
        } catch {
          // decode() is a refinement, never the verdict. It can reject for
          // images that render perfectly well, and `load` has already told us
          // the bytes arrived — so a rejection here must not become a failure.
        }
        decodeAt = performance.now();
      }
    } catch {
      failed = true;
    }

    const commit = shouldCommitPreparedViewer({
      preparedToken: token,
      currentToken: viewerPreparationCounter,
      preparedLoadGeneration,
      currentLoadGeneration: libraryLoadGeneration,
      preparedGalleryGeneration,
      currentGalleryGeneration: galleryGeneration,
      preparedItem: item,
      currentViewerItem,
    });

    if (!commit) {
      // Superseded, or the source/filter/viewer moved on. Release the decoded
      // bitmap and the pending request and do nothing else — no DOM, no
      // classes, no status text, and no outcome recorded, matching the eager
      // path's own `currentViewerNode !== img` guard.
      img.src = "";
      return;
    }

    // Teardown and insertion in ONE synchronous block, with no await between
    // them. This is the entire mechanism: the browser never gets a chance to
    // paint an empty stage.
    clearViewerNode();
    const teardownAt = performance.now();
    // clearViewerNode() nulls both refs; re-establish what this preparation
    // already owns.
    currentViewerItem = item;

    if (failed) {
      // Converge exactly onto Phase 1C's existing behaviour. The held frame is
      // released here, which is correct: image A cannot be held forever on
      // behalf of a dead image B. Nothing skips, retries, removes, reorders or
      // classifies — that is Phase 1C's territory and it stays there.
      recordMediaRenderOutcome("failed");
      viewerEmpty.textContent = "This item could not be loaded.";
      viewerStage.classList.add("hidden");
      viewerEmpty.classList.remove("hidden");
      handleCurrentViewerTerminal(item);
      return;
    }

    currentViewerNode = img;
    viewerStage.appendChild(img);
    recordMediaRenderOutcome("loaded");

    // #viewer-stage was already visible and #viewer-empty already hidden — the
    // held path only runs when a real image was on screen — so neither class is
    // touched here.
    measureTransitionReady({
      held: true,
      renderEntryAt,
      srcAt,
      loadAt,
      decodeAt,
      teardownAt,
      item,
      node: img,
    });
  })();
}

function buildViewer(state) {
  const { currentItem: item, isPlaying, hasItems, hasVisibleItems } = state;
  releaseStaleReadyQueueEntries();

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
    handleCurrentViewerTerminal(item);
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
    refreshReadyQueue();
    return;
  }

  // [PRESENTATION-PERF / PHASE 3A] Held-frame eligibility, decided BEFORE
  // teardown — because holding the outgoing frame means not calling
  // clearViewerNode() yet. Reaching this line is itself the fourth condition:
  // the same-item early return above did not fire, so this is a genuine item
  // change rather than a re-emit for the item already on screen.
  //
  // Restricted to image-following-image deliberately. Holding a PLAYING video
  // while an image prepares would entangle armLoopRuleForCurrentVideo(),
  // notifyVideoEnded() and the TS adapter, none of which are in scope. Every
  // other combination — image -> video, video -> image, video -> video, the
  // first item of a session, and recovery from the "could not be loaded" state
  // (where #viewer-stage is hidden and there is no frame worth holding) — falls
  // through to the eager path below, byte for byte unchanged.
  const outgoingNode = currentViewerNode;
  const canHoldOutgoingFrame =
    Boolean(item) &&
    item.kind === "image" &&
    Boolean(outgoingNode) &&
    outgoingNode.tagName === "IMG" &&
    !viewerStage.classList.contains("hidden");

  if (item?.kind === "image") {
    const prepared = takePreparedViewerImage(item);
    if (prepared) {
      clearViewerNode();
      const committedAt = performance.now();
      currentViewerItem = item;
      currentViewerNode = prepared.node;
      viewerEmpty.classList.add("hidden");
      viewerStage.classList.remove("hidden");
      viewerStage.appendChild(prepared.node);
      recordMediaRenderOutcome("mounted");
      recordMediaRenderOutcome("loaded");
      measureTransitionReady({
        held: true,
        readyHit: true,
        renderEntryAt: lastRenderEntryAt,
        srcAt: committedAt,
        loadAt: committedAt,
        decodeAt: committedAt,
        teardownAt: committedAt,
        item,
        node: prepared.node,
      });
      return;
    }
  }

  if (canHoldOutgoingFrame) {
    prepareHeldFrameImage(item);
    return;
  }

  clearViewerNode();
  // Captured at the call site rather than inside clearViewerNode(), which stays
  // the single teardown owner and keeps doing exactly what it did before.
  const teardownAt = performance.now();

  if (!item) {
    viewerStage.classList.add("hidden");
    viewerEmpty.classList.remove("hidden");
    viewerEmpty.textContent = "Choose files or a folder to begin.";
    handleCurrentViewerTerminal(item);
    return;
  }

  viewerEmpty.classList.add("hidden");
  viewerStage.classList.remove("hidden");
  currentViewerItem = item;

  if (item.kind === "image") {
    currentViewerPreparationInFlight = true;
    runtime.holdAdvanceForPendingVisual();
    const img = document.createElement("img");
    const renderEntryAt = lastRenderEntryAt;
    const srcAt = performance.now();
    img.src = item.url;
    recordMediaRenderOutcome("mounted");
    img.addEventListener("load", () => {
      if (currentViewerNode !== img) return;
      recordMediaRenderOutcome("loaded");
      // [PRESENTATION-PERF / PHASE 3A] The eager path measures itself with the
      // same definitions the held path uses, so before/after is one comparison
      // rather than two. On this path the element was appended EMPTY and only
      // becomes visible now — which is precisely why blank_ms here is the whole
      // resource wait, and why it is the number this stage exists to collapse.
      measureTransitionReady({
        held: false,
        renderEntryAt,
        srcAt,
        loadAt: performance.now(),
        decodeAt: null,
        teardownAt,
        item,
        node: img,
      });
    });
    img.addEventListener("error", () => {
      if (currentViewerNode !== img) return;
      recordMediaRenderOutcome("failed");
      viewerEmpty.textContent = "This item could not be loaded.";
      viewerStage.classList.add("hidden");
      viewerEmpty.classList.remove("hidden");
      handleCurrentViewerTerminal(item);
    });
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
    handleCurrentViewerTerminal(item);

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
      recordMediaRenderOutcome("mounted");
      video.addEventListener("loadedmetadata", () => {
        if (currentViewerNode !== video) return;
        recordMediaRenderOutcome("loaded");
      });
      video.addEventListener("error", () => {
        if (currentViewerNode !== video) return;
        recordMediaRenderOutcome("failed");
        viewerEmpty.textContent = "This item could not be loaded.";
        viewerStage.classList.add("hidden");
        viewerEmpty.classList.remove("hidden");
      });
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
  const mountedGeneration = galleryGeneration;

  if (item.kind === "image") {
    mediaEl = document.createElement("img");
    mediaEl.src = item.url;
    recordMediaRenderOutcome("mounted");
    mediaEl.addEventListener("load", () => {
      if (galleryGeneration !== mountedGeneration) return;
      recordMediaRenderOutcome("loaded");
    });
    mediaEl.addEventListener("error", () => {
      if (galleryGeneration !== mountedGeneration) return;
      recordMediaRenderOutcome("failed");
    });
    mediaEl.alt = item.name;
  } else if (item.kind === "video") {
    mediaEl = document.createElement("video");
    mediaEl.src = item.url;
    recordMediaRenderOutcome("mounted");
    mediaEl.addEventListener("loadedmetadata", () => {
      if (galleryGeneration !== mountedGeneration) return;
      recordMediaRenderOutcome("loaded");
    });
    mediaEl.addEventListener("error", () => {
      if (galleryGeneration !== mountedGeneration) return;
      recordMediaRenderOutcome("failed");
    });
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
  const isFavorite = Boolean(item && profileView.isFavorite(item.relativePath));

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
// [PM-SHUFFLE-FOLDERS] Loop/🤖 gating below is UNCHANGED — still exactly
// `!isVideo`, still the same two elements. What changed is the empty state's
// derivation: it used to be `isVideo` on the assumption that "photo" and
// "tray has nothing in it" were the same fact. 🎲 is the tray's first
// media-agnostic control (switching Media Folders means the same thing on a
// photo as on a video, so it is deliberately not gated here), which makes
// that assumption false. The message is now derived from what is ACTUALLY
// available — no control visible, nothing to offer — so it can never claim
// "no automations available" while one is sitting next to it. Kept rather
// than deleted: a tray whose whole contents are media-gated again is exactly
// what this element is for.
function syncAutomationsMediaAvailability(item) {
  const isVideo = Boolean(item && item.kind === "video");
  videoLoopControl.classList.toggle("hidden", !isVideo);
  overlayAutomationBtn.classList.toggle("hidden", !isVideo);

  const anyAvailable = [videoLoopControl, overlayAutomationBtn, overlayShuffleFoldersBtn].some(
    (element) => !element.classList.contains("hidden")
  );
  pmAutomationsPhotoEmpty.classList.toggle("hidden", anyAvailable);
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
    const isApplying = !profileView.hasItemTag(item.relativePath, tag.id);
    profileView.toggleItemTag(item.relativePath, tag.id);
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
  const appliedTagIds = item ? new Set(profileView.getItemTags(item.relativePath)) : new Set();

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
  // [PRESENTATION-PERF / PHASE 3A] t0 for every transition measurement. This is
  // the earliest point this file can honestly observe — MediaRuntime's own
  // selection work happens before it and is protected, so every number derived
  // from this excludes it. That exclusion is bounded and known: the pre-change
  // profiler measured the whole dispatch at ~0.8 ms median.
  lastRenderEntryAt = performance.now();

  // [PRESENTATION-PERF / PHASE 3A] Player first, gallery second. buildViewer()
  // is where the incoming image's src is assigned, so running it ahead of
  // renderGallery() starts the request before the gallery's per-card
  // bookkeeping rather than after it.
  //
  // Small, low-risk and regression-tested — NOT zero-risk, and not sold as one.
  // Verified by inspection before the swap: renderGallery() writes only gallery
  // state (renderedGalleryGeneration, galleryCardEls, galleryThumbEls,
  // galleryObserver, galleryJumpTargetIndex and the grid DOM), none of which
  // buildViewer() reads; both functions are called from here and nowhere else;
  // and syncGalleryJumpTarget() reads only `state` and its own input, so it is
  // unaffected by their relative order. The one comment in this file that
  // reasons about buildViewer()'s timing (see syncMobileLoadState's
  // .app-has-media note) depends on buildViewer() running inside this same
  // synchronous render() call, which moving it earlier only strengthens.
  //
  // The measured benefit is sub-millisecond. This is an ordering-correctness
  // change, not a performance fix — the blank frame was the defect.
  buildViewer(state);
  renderGallery(state);
  syncControls(state);
  syncGalleryJumpTarget(state);
  // [UI-REDESIGN / Stage 4] Catches the playback half of the strip's
  // condition — starting, stopping, and advancing to a new filename. The
  // workspace half is caught by setActiveWorkspace().
  syncNowPlayingStrip(state);
}

// ---- Event wiring ---------------------------------------------------------

/*
BREADCRUMBS - WAS
Media intake exposed separate local and Floppy controls, requiring the customer to understand which backend or source type should process a selection.

BREADCRUMBS - IS
The customer chooses only selection shape and intent: Open Files, Open Folder, Remember File, or Remember Folder. Unified intake classification determines whether existing local or Floppy owners handle the selection.

BREADCRUMBS - WILL BE
Future source types should extend classification and routing behind these generic controls rather than adding new customer-facing picker buttons.
*/

/*
BREADCRUMBS - WAS
Picker handlers passed browser-owned live FileLists into asynchronous intake routing and then cleared the inputs. Clearing the control could empty the selection before evidence collection consumed it.

BREADCRUMBS - IS
Picker selections are snapshotted into stable arrays before asynchronous unified intake routing. Input controls may be cleared without mutating the selection being classified.

BREADCRUMBS - WILL BE
Any future picker path crossing an asynchronous boundary must snapshot browser-owned selection state before yielding, clearing, or reusing the control.
*/
async function routeOpenSelection(fileList, { shape, rootName = null } = {}) {
  const evidence = await collectSelectionEvidence(fileList, { shape });
  const selectionKind = classifySelection(evidence);

  switch (selectionKind) {
    case "local-files":
      return loadFiles(fileList);
    case "local-folder":
      return loadFiles(fileList, { isFolderPick: true, rootName });
    case "floppy-file": {
      const floppy = evidence.entries.find((entry) => entry.qualifiesAsFloppy);
      return loadRemoteSession(floppy.floppyText, { name: floppy.name, sourceKind: "cassette" });
    }
    case "floppy-folder":
      return loadRemoteSession(combineQualifyingFloppyTexts(evidence), { name: rootName, sourceKind: "cassette-folder" });
    case "mixed":
      statusText.textContent = shape === "folder"
        ? "This folder contains both media and Floppy Disks. Choose a folder containing one type."
        : "Choose either media files or a Floppy Disk, not both.";
      return;
    default:
      statusText.textContent = shape === "folder"
        ? "This folder doesn't contain supported media or Floppy Disks."
        : "Browser Gallery can't open that file.";
  }
}

fileInput.addEventListener("change", async (event) => {
  const files = Array.from(event.target.files || []);
  fileInput.value = "";
  await routeOpenSelection(files, { shape: "files" });
});

folderInput.addEventListener("change", async (event) => {
  const files = Array.from(event.target.files || []);

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
  folderInput.value = "";
  await routeOpenSelection(files, { shape: "folder", rootName: topFolderName });
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

function updateArcadeAnimationOrderHelper() {
  renderArcadeAnimationOrderHelper(arcadeAnimationOrderHelper, arcadeAnimationOrderSelect.value);
}

arcadeAnimationOrderSelect.addEventListener("change", () => {
  arcadeAnimationOrder = arcadeAnimationOrderSelect.value;
  arcadeShuffleLoopVisitedScenes = [];
  updateArcadeAnimationOrderHelper();
  saveMicroArcadePreferences({ animationOrder: arcadeAnimationOrder });
});

// [STARTUP-MEDIA / N6-4] [STREAMLOOP-INTEGRATION / N6-6] [STREAMLOOP-INTEGRATION / N6-9]
function startupMediaPolicyHelperText(policy) {
  if (policy === "off") return "Browser Gallery won't open any folder automatically — choose one yourself whenever you like.";
  if (policy === "random-remembered") return "Randomly picks among every remembered folder Browser Gallery can still open.";
  if (policy === "random-selected") return "Randomly picks among the folders you check below.";
  return "Opens whichever folder you used last, if Browser Gallery still has access.";
}

// [STREAMLOOP-INTEGRATION / N6-9]
// BREADCRUMBS — IS: a context's Auto Fill checkbox is only meaningful when
// that same context's startup policy can actually load something — "off"
// has no startup media load for Auto Fill to act upon. Disabling the
// control (never unchecking it) is what lets a customer's saved true/false
// value survive untouched while policy is "off" and reappear the moment
// they pick an automatic mode again — see normalizeStartupSection() in
// app-preferences.js for the persistence half of this same guarantee.
function updateStartupMediaAutoFillAvailability(context) {
  const controls = startupMediaControls[context];
  const isOff = controls.policySelect.value === "off";
  controls.autoFillInput.disabled = isOff;
  controls.autoFillHelper.classList.toggle("hidden", !isOff);
}

function updateStartupMediaPolicyHelper(context) {
  const controls = startupMediaControls[context];
  controls.policyHelper.textContent = startupMediaPolicyHelperText(controls.policySelect.value);
  controls.eligibleSection.classList.toggle("hidden", controls.policySelect.value !== "random-selected");
  updateStartupMediaAutoFillAvailability(context);
}

// [WHY: rebuilt from scratch each call rather than diffed — same reasoning
//  renderRecentLibraries() immediately below already documents for its own
//  list ("list is small — a handful of libraries at most"). Called from
//  renderRecentLibraries() itself, once per context, so the three lists —
//  Recent Libraries and each context's eligible-folder checklist — can never
//  drift out of sync with each other. `context` is "browser" or "streamloop";
//  each draws from the same listLibraries() population but keeps its own
//  independent eligible set, per the N6-5 handoff's "strong product
//  preference" that each context owns its own selected-folder pool.]
async function renderStartupMediaSettings(context) {
  const controls = startupMediaControls[context];
  let rows;
  try {
    rows = await listLibraries();
  } catch (error) {
    console.warn("[STARTUP-MEDIA] Could not read saved libraries.", error);
    rows = [];
  }

  controls.eligibleList.innerHTML = "";
  controls.eligibleEmpty.classList.toggle("hidden", rows.length > 0);

  // [WHY: stale ids (folders no longer in `rows`, e.g. removed from Recents)
  //  are deliberately never pruned from the saved set here — only the ones
  //  still present get a checkbox at all. See
  //  normalizeStartupEligibleLibraryIds() in app-preferences.js.]
  const eligibleSet = new Set(currentStartupPreferences[context].eligibleLibraryIds);
  for (const record of rows) {
    const label = document.createElement("label");
    label.className = "startup-media-library-checkbox";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = eligibleSet.has(record.id);
    checkbox.addEventListener("change", () => {
      const nextIds = new Set(currentStartupPreferences[context].eligibleLibraryIds);
      if (checkbox.checked) nextIds.add(record.id);
      else nextIds.delete(record.id);
      currentStartupPreferences = {
        ...currentStartupPreferences,
        [context]: { ...currentStartupPreferences[context], eligibleLibraryIds: [...nextIds] },
      };
      saveStartupPreferences(context, { eligibleLibraryIds: currentStartupPreferences[context].eligibleLibraryIds });
    });

    const nameSpan = document.createElement("span");
    nameSpan.textContent = record.name;

    label.appendChild(checkbox);
    label.appendChild(nameSpan);
    controls.eligibleList.appendChild(label);
  }
}

for (const context of ["browser", "streamloop"]) {
  const controls = startupMediaControls[context];

  controls.policySelect.addEventListener("change", () => {
    currentStartupPreferences = {
      ...currentStartupPreferences,
      [context]: { ...currentStartupPreferences[context], policy: controls.policySelect.value },
    };
    updateStartupMediaPolicyHelper(context);
    saveStartupPreferences(context, { policy: currentStartupPreferences[context].policy });
  });

  // [STREAMLOOP-INTEGRATION / N6-9] Pure preference, same shape as
  // autoplayOnFillInput above — read only at the point attemptStartupMedia()
  // decides whether to auto-enter Fill Panel after THIS context's own
  // startup load, never acted on here. Ticking it never itself enters Fill
  // Panel, starts playback, or changes anything on screen. Independent per
  // context: toggling browser's checkbox never touches streamloop's saved
  // value or vice versa — see saveStartupPreferences()'s own two-level merge.
  controls.autoFillInput.addEventListener("change", () => {
    currentStartupPreferences = {
      ...currentStartupPreferences,
      [context]: { ...currentStartupPreferences[context], autoFillPanel: controls.autoFillInput.checked },
    };
    saveStartupPreferences(context, { autoFillPanel: currentStartupPreferences[context].autoFillPanel });
  });
}

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
  if (fillModeActive) maybeBeginWarmStart();
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
    cancelWarmStart();
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

  if (wasPlaying) {
    maybeBeginWarmStart();
    return;
  }
  if (!autoplayOnFillInput.checked) return;
  runtime.play();
  maybeBeginWarmStart();
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
  currentSessionIsUrlBacked = false;
  libraryLoadGeneration += 1;
  bumpGalleryGeneration();
  runtime.clear();
  provider.dispose();
  fsaProvider.dispose(); // [FSA] whichever source was active, release it
  remoteProvider.dispose();
  remoteStatusText.textContent = "";
  resetMediaRenderOutcomes();
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
  activeCassetteRecord = null;
  activeCassetteCurationId = null;
  associationWriteSuppression.setLoadedLibrary(null);
  clearReverseCurationSuggestion();
  clearDeviceAwareMediaQuestion();
  ambientProfileObserver.clearContext();
  renderAmbientProfileOffer();
  activeLibraryDisplayName = null;
  currentSourceKind = "none";
  currentFolderPermissionState = "granted";
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
  cancelWarmStart();
  handleManualNavigationLoopReset();
  runtime.previous();
});
overlayNextBtn.addEventListener("click", () => {
  cancelWarmStart();
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
  profileView.setHidden(recentHideUndo.hiddenRelativePath, false);

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

// [PM-SHUFFLE-FOLDERS] Deliberately the ONLY thing this click does — it does
// not close the tray, does not touch videoLoopInput/activeLoopRule, and does
// not call syncAutomationsActiveIndicator(): a one-shot action leaves ⚡
// idle, so repeated ⚡ → 🎲 → 🎲 keeps switching folders from the same open
// shelf. See shuffleToAnotherRememberedFolder() for the re-entry guard.
overlayShuffleFoldersBtn.addEventListener("click", () => {
  shuffleToAnotherRememberedFolder();
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

// [PM-TOOLBAR-OPACITY] Same input/change/Remember pattern as Ghost/Toolbar
// Opacity above, for Hover Opacity — its own independent preference, never
// merged with Toolbar Opacity's.
hoverOpacityInput.addEventListener("input", () => {
  applyHoverOpacity(Number(hoverOpacityInput.value));
});

hoverOpacityInput.addEventListener("change", () => {
  if (!hoverRememberInput.checked) return;
  savePresentationPreferences({ hoverOpacityPercent: Number(hoverOpacityInput.value) });
});

hoverRememberInput.addEventListener("change", () => {
  const remember = hoverRememberInput.checked;
  const partial = { rememberHoverOpacity: remember };
  if (remember) {
    partial.hoverOpacityPercent = Number(hoverOpacityInput.value);
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
      cancelWarmStart();
      handleManualNavigationLoopReset();
      runtime.next();
      break;
    case "ArrowLeft":
      event.preventDefault();
      cancelWarmStart();
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

// ---- PM toolbar hover behavior (Toolbar Opacity / Hover Opacity) ----------
//
// Driven by literal pointer presence (mouseenter/mouseleave) rather than
// CSS :hover/:focus-within. Clicking a button gives it DOM focus as a
// browser side effect, and :focus-within doesn't clear on mouseleave — that
// was leaving the controls "stuck" visible after any click. Tracking the
// pointer directly sidesteps focus entirely: the bar reveals only while the
// cursor is actually over it, and reverts the instant it isn't, regardless
// of what has focus.
//
// [PM-TOOLBAR-OPACITY] Presentation Mode toolbar opacity has exactly two
// configurable states: Toolbar Opacity (currentGhostOpacityPercent, applied
// below on mouseleave) and Hover Opacity (currentHoverOpacityPercent,
// applied on mouseenter — this used to be a hardcoded "1"/100%). Hover
// never changes the stored Toolbar Opacity value: mouseleave always
// restores currentGhostOpacityPercent exactly as it was, regardless of
// whatever Hover Opacity did while hovered.

let currentGhostOpacityPercent = Number(ghostOpacityInput.value);
let currentHoverOpacityPercent = Number(hoverOpacityInput.value);

presentationControls.addEventListener("mouseenter", () => {
  presentationControls.style.setProperty("--ghost-opacity", String(currentHoverOpacityPercent / 100));
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
  const activeName = profile.getProfileName();

  profileSelect.innerHTML = "";

  // [SYNCV3 / STAGE-10 / FINAL-UX-POLISH]
  // [WHY: "Curation" is display text only. The option VALUE stays the raw
  // profileId and the stored name is never rewritten, so switching, deletion,
  // export, association and Sync all keep reading the same identity they
  // always did — only what the collapsed select shows has changed.]
  profiles.forEach((entry) => {
    const option = document.createElement("option");
    option.value = entry.id;
    option.textContent = `${entry.name} Curation`;
    profileSelect.appendChild(option);
  });

  if (activeId) profileSelect.value = activeId;

  // [SYNCV3 / STAGE-07 / DELETE-PROFILE-LABEL]
  // [WHY: destructive actions should identify their exact target before
  // activation, not only inside the confirmation step.] These are the same
  // active Profile getters the delete handler reads at click time, so the
  // visible target and the actual target cannot become separate concepts.
  profileDeleteBtn.textContent = activeId && activeName ? `Delete ${activeName} Curation` : "Delete Curation";
  profileExportBtn.textContent = activeName ? `Export ${activeName} Curation (.json)` : "Export Curation (.json)";
}

function establishAmbientProfileContext(libraryRecord) {
  const localLibraryId = libraryRecord?.id || null;
  const libraryId = libraryRecord?.libraryId || null;
  if (!localLibraryId || !libraryId) {
    ambientProfileObserver.clearContext();
    renderAmbientProfileOffer();
    return;
  }
  const currentFactValue = profile.getAssociations()[libraryId]?.v || null;
  const targetKnown = Boolean(currentFactValue
    && profile.listProfiles().some((entry) => entry.id === currentFactValue));
  ambientProfileObserver.setContext({ localLibraryId, libraryId, currentFactValue, targetKnown });
  renderAmbientProfileOffer();
}

function getCurrentAmbientProfileContext() {
  const durable = currentSourceKind === "fsa"
    || (currentSourceKind === "legacy" && legacyHasDurableIdentity);
  if (!durable || !activeLibraryRecord?.id || !activeLibraryRecord.libraryId) return null;
  return {
    localLibraryId: activeLibraryRecord.id,
    libraryId: activeLibraryRecord.libraryId,
  };
}

function renderAmbientProfileOffer() {
  const pendingOffer = ambientProfileObserver.getSnapshot().pendingOffer;
  const context = getCurrentAmbientProfileContext();
  const targetName = pendingOffer ? getProfileNameById(pendingOffer.observedValue) : null;
  const view = buildAmbientProfileOfferView({
    pendingOffer,
    currentContext: context,
    libraryName: activeLibraryRecord?.name || activeLibraryDisplayName || "This folder",
    targetName,
    activeProfileName: profile.getProfileName() || "my current Curation",
  });

  if (!view.visible) {
    ambientProfileOffer.classList.add("hidden");
    ambientProfileOfferRenderedKey = null;
    return;
  }

  const key = `${pendingOffer.localLibraryId}\u0000${pendingOffer.libraryId}\u0000${pendingOffer.observedValue}`;
  if (ambientProfileOfferRenderedKey !== key) ambientProfileOfferResult.textContent = "";
  ambientProfileOfferRenderedKey = key;

  ambientProfileOfferText.textContent = view.text;
  ambientProfileOfferYes.textContent = view.yesLabel;
  ambientProfileOfferNo.textContent = view.noLabel;
  ambientProfileOfferLater.textContent = view.laterLabel;
  for (const button of [ambientProfileOfferYes, ambientProfileOfferNo, ambientProfileOfferLater, ambientProfileOfferClose]) {
    button.disabled = ambientProfileActionPending;
  }
  // [SYNCV3 / STAGE-09 / AMBIENT-NO-FOCUS-STEAL]
  // [WHY: sync may surface this while the user is editing elsewhere. Showing a
  // static card without focus() preserves their task while leaving every real
  // button reachable in ordinary tab order.]
  ambientProfileOffer.classList.remove("hidden");
}

function isLibraryLoadCurrent(loadToken, libraryRecord) {
  return libraryLoadGeneration === loadToken
    && Boolean(activeLibraryRecord)
    && activeLibraryRecord.id === libraryRecord?.id
    && (activeLibraryRecord.libraryId || null) === (libraryRecord?.libraryId || null);
}

async function restoreProfileForLoadedLibrary(libraryRecord, loadToken) {
  try {
    const outcome = await applyLoadTimeProfileRestoration({
      libraryRecord,
      getAssociations: () => profile.getAssociations(),
      getKnownProfileIds: () => profile.listProfiles().map((entry) => entry.id),
      getActiveProfileId: () => profile.getProfileId(),
      loadDecision: loadAmbientProfileDecision,
      deleteDecision: deleteAmbientProfileDecision,
      switchProfile: (target) => profile.switchProfile(target),
      isCurrent: () => isLibraryLoadCurrent(loadToken, libraryRecord),
    });
    if (outcome.decisionDeleteError) {
      console.warn("[SYNCV3 / STAGE-09] Could not clear a stale local association decision.", outcome.decisionDeleteError);
    }
    return outcome;
  } catch (error) {
    // Decision storage failure must not make an otherwise valid folder fail to
    // load. Conservatively preserve Active Profile rather than guessing past a
    // decision that could not be read.
    console.warn("[SYNCV3 / STAGE-09] Could not resolve load-time Profile policy.", error);
    return null;
  }
}

async function armDeferredLoadTimeOffer(deferredOffer, loadToken) {
  if (!deferredOffer || !isLibraryLoadCurrent(loadToken, deferredOffer)) return false;
  let decision;
  try {
    decision = await loadAmbientProfileDecision(deferredOffer.libraryId);
  } catch (error) {
    console.warn("[SYNCV3 / STAGE-09] Could not re-read LATER before arming its load-time offer.", error);
    return false;
  }
  if (!isLibraryLoadCurrent(loadToken, deferredOffer)) return false;
  const associations = profile.getAssociations();
  const hasSharedFact = Object.prototype.hasOwnProperty.call(associations, deferredOffer.libraryId);
  const currentFactValue = hasSharedFact ? associations[deferredOffer.libraryId]?.v ?? null : null;
  const targetKnown = Boolean(currentFactValue
    && profile.listProfiles().some((entry) => entry.id === currentFactValue));
  if (decision?.kind !== "later"
    || decision.observedValue !== currentFactValue
    || currentFactValue !== deferredOffer.currentFactValue
    || !targetKnown
    || currentFactValue === profile.getProfileId()) return false;

  // [SYNCV3 / STAGE-09 / LOAD-TIME-LATER-REASK]
  // [WHY: LATER explicitly asks once on a later successful load. Arm Slice 3's
  // existing pending slot after re-reading both decision and fact; do not fake
  // an ambient transition and do not create a parallel prompt mechanism.]
  const armed = ambientProfileObserver.armLoadTimeOffer({
    localLibraryId: deferredOffer.id,
    libraryId: deferredOffer.libraryId,
    currentFactValue,
  });
  renderAmbientProfileOffer();
  return armed;
}

async function refreshCurrentAssociationFromRegistry() {
  const localLibraryId = activeLibraryRecord && activeLibraryRecord.id;
  const durable = currentSourceKind === "fsa" || (currentSourceKind === "legacy" && legacyHasDurableIdentity);
  if (!durable || !localLibraryId) {
    ambientProfileObserver.clearContext();
    renderAmbientProfileOffer();
    return;
  }
  // [SYNCV3 / STAGE-09 / NO-DECISION-REARM-BUG]
  // [WHY: the local row projection is deliberately NOT fed into the ambient
  // observer. It is reconciliation/display state, never association policy
  // authority — and it necessarily lags here, because
  // ProfileStore#adoptMergedAssociations emits before reconciling rows. The
  // shared fact read below is the only ambient association authority.]
  const refreshed = await getLibraryById(localLibraryId);
  if (!refreshed || !activeLibraryRecord || activeLibraryRecord.id !== localLibraryId) return;
  const sharedLibraryId = refreshed.libraryId || null;
  const currentFact = sharedLibraryId ? profile.getAssociations()[sharedLibraryId] || null : null;
  // [SYNCV3 / STAGE-09 / SELF-WRITE-SUPPRESSION]
  // [WHY: `(t,d)` is used only to classify exact authorship here. The ambient
  // model receives only the fact VALUE, because a restamp has no user-facing
  // association meaning. Keeping both purposes at this seam prevents either
  // stamp metadata or the local row projection from becoming target authority.]
  const selfWriteSuppressed = associationWriteSuppression.shouldSuppress({
    localLibraryId,
    libraryId: sharedLibraryId,
    fact: currentFact,
  });
  activeLibraryRecord = refreshed;

  // [SYNCV3 / STAGE-09 / INITIAL-LOAD-BASELINE]
  // [WHY: a newly loaded, linked, promoted, or unlinked Library context starts
  // a baseline; it is not an ambient transition. Slice 3B will own load-time
  // NO/LATER behavior. Reset here as a safety net for a shared-link change that
  // reached this async seam before its explicit Stage 08 handler completed.]
  if (!sharedLibraryId) {
    ambientProfileObserver.clearContext();
  } else if (!ambientProfileObserver.matchesContext(localLibraryId, sharedLibraryId)) {
    establishAmbientProfileContext(refreshed);
  } else {
    const currentFactValue = currentFact?.v || null;
    const targetKnown = Boolean(currentFactValue
      && profile.listProfiles().some((entry) => entry.id === currentFactValue));
    // [SYNCV3 / STAGE-09 / ZERO-AUTO-SWITCH-AMBIENT]
    // [WHY: this path records only an internal, stale-prone offer. It contains
    // no switchProfile call and no association write; Slice 4 must re-read the
    // authoritative fact before acting on any future user response.]
    await ambientProfileObserver.observe({
      localLibraryId,
      libraryId: sharedLibraryId,
      currentFactValue,
      activeProfileId: profile.getProfileId(),
      targetKnown,
      selfWriteSuppressed,
    });
    // [SYNCV3 / STAGE-09 / ASYNC-CONTEXT-GUARD]
    // The observer checks generation and both identities after every decision
    // store await. Recheck the main context too before continuing UI refreshes.
    if (!activeLibraryRecord
      || activeLibraryRecord.id !== localLibraryId
      || (activeLibraryRecord.libraryId || null) !== sharedLibraryId) return;
  }
  renderAmbientProfileOffer();
  syncAssociateButtonVisibility();
  if (!profileAssociationRow.classList.contains("hidden")) {
    populateAssociationPicker({ preservePending: true });
  }
  if (!profileFolderLinkRow.classList.contains("hidden")) {
    populateFolderLinkPicker({ preservePending: true });
    await refreshFolderLinkSelection();
  }
  refreshCurrentFolderPermission().catch(() => undefined);
  return {
    selfWriteSuppressed,
    currentFact,
    ambientObservation: ambientProfileObserver.getSnapshot(),
  };
}

async function handleAmbientProfileOfferAction(kind) {
  if (ambientProfileActionPending) return;
  const pendingOffer = ambientProfileObserver.getSnapshot().pendingOffer;
  if (!pendingOffer) return;

  ambientProfileActionPending = true;
  ambientProfileOfferResult.textContent = "";
  renderAmbientProfileOffer();
  try {
    const result = await performAmbientProfileAction({
      kind,
      pendingOffer,
      getCurrentContext: getCurrentAmbientProfileContext,
      getAssociations: () => profile.getAssociations(),
      getKnownProfileIds: () => profile.listProfiles().map((entry) => entry.id),
      getActiveProfileId: () => profile.getProfileId(),
      switchProfile: (target) => profile.switchProfile(target),
      saveDecision: saveAmbientProfileDecision,
    });

    if (result.status === "applied") {
      ambientProfileObserver.dismissPendingOffer(pendingOffer);
      ambientProfileOfferResult.textContent = "";
      // [SYNCV3 / STAGE-09 / SLICE-5-MULTITAB-DECISIONS]
      // [WHY: announced only AFTER the decision row is durably saved, matching
      // every other write-then-announce in this app. A sibling told to re-read
      // before the row lands would read the old store, conclude it was current,
      // and never hear again. The message carries no payload.]
      profile.announceAmbientProfileDecisionChanged();
    } else if (result.status === "stale") {
      // A newer pending offer is protected by expected identity/value matching.
      ambientProfileObserver.dismissPendingOffer(pendingOffer);
      await refreshCurrentAssociationFromRegistry();
    } else if (result.status === "switch-failed") {
      ambientProfileOfferResult.textContent = "Could not switch Curations. Try again.";
    } else if (result.status === "stale-after-switch") {
      ambientProfileObserver.dismissPendingOffer(pendingOffer);
      await refreshCurrentAssociationFromRegistry();
      // [SYNCV3 / STAGE-10 / FINAL-CLOSEOUT-POLISH]
      // [WHY: copy only. Two different things change in this race — this
      // device's Curation, and the Media Library's remembered Curation — and
      // the previous wording used "changed" for both, leaving the reader to
      // guess which was which. The stale-after-switch semantics are untouched.]
      ambientProfileOfferResult.textContent = "Switched Curations, but this folder's remembered Curation changed again before your choice could be saved.";
    } else if (result.status === "persistence-failed") {
      if (result.switched) {
        ambientProfileObserver.dismissPendingOffer(pendingOffer);
        ambientProfileOfferResult.textContent = "Curation changed, but this choice could not be remembered on this device.";
      } else {
        // NO/LATER have no effect without durable persistence. Keep the exact
        // current offer visible so retrying is honest and safe.
        ambientProfileOfferResult.textContent = "Could not remember this choice on this device. Try again.";
      }
    }
  } finally {
    ambientProfileActionPending = false;
    renderAmbientProfileOffer();
  }
}

ambientProfileOfferYes.addEventListener("click", () => {
  handleAmbientProfileOfferAction("yes").catch((error) => {
    console.warn("[SYNCV3 / STAGE-09] Ambient YES failed.", error);
    ambientProfileActionPending = false;
    ambientProfileOfferResult.textContent = "Could not apply this choice. Try again.";
    renderAmbientProfileOffer();
  });
});

ambientProfileOfferNo.addEventListener("click", () => {
  handleAmbientProfileOfferAction("no").catch((error) => {
    console.warn("[SYNCV3 / STAGE-09] Ambient NO failed.", error);
    ambientProfileActionPending = false;
    ambientProfileOfferResult.textContent = "Could not remember this choice. Try again.";
    renderAmbientProfileOffer();
  });
});

function chooseAmbientProfileLater() {
  return handleAmbientProfileOfferAction("later");
}

// [SYNCV3 / STAGE-09 / ESCAPE-CLOSE-IS-LATER]
// [WHY: X and Escape are not transient dismissals. Both route through the
// exact durable LATER action so reload behavior cannot depend on how the card
// was closed.]
ambientProfileOfferLater.addEventListener("click", () => {
  chooseAmbientProfileLater().catch((error) => {
    console.warn("[SYNCV3 / STAGE-09] Ambient LATER failed.", error);
    ambientProfileOfferResult.textContent = "Could not remember this choice. Try again.";
  });
});
ambientProfileOfferClose.addEventListener("click", () => {
  chooseAmbientProfileLater().catch((error) => {
    console.warn("[SYNCV3 / STAGE-09] Ambient close/LATER failed.", error);
    ambientProfileOfferResult.textContent = "Could not remember this choice. Try again.";
  });
});

reverseCurationOfferYes.addEventListener("click", () => {
  handleReverseCurationSuggestionAction("yes").catch((error) => {
    console.warn("[NORTH-STAR / N4] Reverse-suggestion YES failed.", error);
    reverseCurationActionPending = false;
    reverseCurationOfferResult.textContent = "Could not save that Curation. Try again.";
    renderReverseCurationSuggestion();
  });
});

reverseCurationOfferNo.addEventListener("click", () => {
  handleReverseCurationSuggestionAction("no").catch((error) => {
    console.warn("[NORTH-STAR / N4] Reverse-suggestion NO failed.", error);
    reverseCurationActionPending = false;
    pendingReverseCurationSuggestion = null;
    renderReverseCurationSuggestion();
  });
});

deviceAwareMediaQuestionYes.addEventListener("click", () => {
  handleDeviceAwareMediaQuestionAction("yes").catch((error) => {
    console.warn("[NORTH-STAR / N2] Device-aware YES failed.", error);
    deviceAwareMediaActionPending = false;
    deviceAwareMediaQuestionResult.textContent = "Could not remember that choice. Try again.";
    renderDeviceAwareMediaQuestion();
  });
});

deviceAwareMediaQuestionNo.addEventListener("click", () => {
  handleDeviceAwareMediaQuestionAction("no").catch((error) => {
    console.warn("[NORTH-STAR / N2] Device-aware NO failed.", error);
    deviceAwareMediaActionPending = false;
    pendingDeviceAwareMediaQuestion = null;
    renderDeviceAwareMediaQuestion();
  });
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || event.defaultPrevented) return;
  if (ambientProfileOffer.classList.contains("hidden") || ambientProfileActionPending) return;
  // Existing Fill, drawer, popover, association editor, and native dialog
  // Escape handlers have priority and preventDefault before this late listener.
  if (fillModeActive || document.querySelector("dialog[open]")) return;
  event.preventDefault();
  chooseAmbientProfileLater().catch((error) => {
    console.warn("[SYNCV3 / STAGE-09] Ambient Escape/LATER failed.", error);
    ambientProfileOfferResult.textContent = "Could not remember this choice. Try again.";
  });
});

// [SYNCV3 / STAGE-09 / SLICE-5-MULTITAB-DECISIONS]
// [WHY: sibling tabs may each show the same offer, which is acceptable — but
// once ANY context on this device decides, the others must stop asking. The
// announcement is invalidation only; this re-reads the durable decision store
// and retires a now-decided offer without acting on it. No Profile is switched
// and no shared association is written on this path.]
profile.subscribeAmbientProfileDecisionChanged(() => {
  ambientProfileObserver.reconcilePendingOfferWithDecision()
    .then((state) => {
      if (state.dismissed) renderAmbientProfileOffer();
    })
    .catch((error) => {
      console.warn("[SYNCV3 / STAGE-09] Could not reconcile a sibling ambient decision.", error);
    });
});

profileSelect.addEventListener("change", async () => {
  const targetId = profileSelect.value;
  if (!targetId || targetId === profile.getProfileId()) return;

  const ok = await profile.switchProfile(targetId);
  if (!ok) {
    profileActiveStatusText.textContent = "Could not switch Curation.";
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
    profileActiveStatusText.textContent = `Could not create Curation: ${error.message}`;
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
    `Delete ${activeName} Curation? This removes its Tags, Favorites, and Hidden items. Your photos and videos are not affected. This cannot be undone.`
  );
  if (!confirmed) return;

  profileDeleteBtn.disabled = true;
  try {
    await profile.deleteProfile(activeId);
    profileActiveStatusText.textContent = `Deleted "${activeName}". Now on "${profile.getProfileName()}".`;

    // [SYNCV3 / STAGE-07 / ASSOCIATION-STATE]
    // Keep a durable current Library's missing profileId visible as S4. It is
    // still the shared association truth until the user explicitly chooses a
    // replacement or No Profile; silently clearing only the local projection
    // would hide that recovery state and could be reasserted by shared truth.
    if (activeLibraryRecord && activeLibraryRecord.profileId === activeId) {
      // Durable association intentionally retained for S4 recovery.
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
    profileActiveStatusText.textContent = `Could not delete Curation: ${error.message}`;
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
  if (!profileAssociationRow.classList.contains("hidden")) {
    populateAssociationPicker({ preservePending: true });
  }
  if (!profileFolderLinkRow.classList.contains("hidden")) {
    populateFolderLinkPicker({ preservePending: true });
    refreshFolderLinkSelection().catch(() => undefined);
  }
  // Existing ASSOCIATIONS_CHANGED adoption updates the registry projection
  // before emitting. Re-read only the current local row so another tab's
  // shared association change reaches this single management surface.
  refreshCurrentAssociationFromRegistry().catch(() => undefined);
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
      throw new Error("Not a recognized Curation file (invalid JSON).");
    }

    const suggestedName = typeof parsed.profileName === "string" && parsed.profileName.trim() ? parsed.profileName.trim() : "Imported Curation";
    const name = window.prompt("Name for the new Curation:", suggestedName);
    if (!name || !name.trim()) return; // cancelled

    const created = await profile.createProfile(name.trim());
    await profile.switchProfile(created.id);
    const result = profile.importJSON(parsed, { mode: "replace" });

    profileActiveStatusText.textContent = `Created "${created.name}" from import (${result.applied} applied).`;
  } catch (error) {
    profileActiveStatusText.textContent = `Could not import as a new Curation: ${error.message}`;
  }
});

// Centralized reaction to ANY profile change — a single toggle, a merge
// import, or a replace import all funnel through here. allItems is kept in
// sync regardless of what's currently loaded into the runtime (so an item
// hidden by the Favorites Only filter still gets updated), and Favorites
// Only reloads to pick up whatever just changed.
profile.subscribe(() => {
  allItems.forEach((item) => {
    item.isFavorite = profileView.isFavorite(item.relativePath);
    item.isHidden = profileView.isHidden(item.relativePath);
    item.favoritedAt = profileView.getFavoritedAt(item.relativePath);
    item.userTags = profileView.getItemTags(item.relativePath);
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

  // [SYNCV3 / STAGE-06 / SYNC-STATUS-RENDER]
  // [WHY: product and Advanced diagnostic copy consume this same snapshot;
  // neither renderer performs another getStatus() read or subscription.]
  const productStatus = mapSyncStatusCopy(status);
  profileSyncProductStatus.textContent = productStatus.line;
  applyProductStatusTone(profileSyncProductStatus, productStatus.tone);
  syncContextHelpDefaultVisible = !status.configured && !status.v3Configured;
  refreshContextualHelpAfterRender(contextualHelpEntries[3]);

  // [SYNCV3 / STAGE-01 / V3-ROOT-ISOLATION]
  // [WHY: every V1/V2 control below is additionally gated on `!isV3`. Under V3
  //  the engine has deliberately released the V1/V2 handle in memory while
  //  leaving its stored row untouched, so `status.configured` is false and these
  //  controls would otherwise re-render as "not configured" — inviting the user
  //  to choose a V1/V2 folder, which would overwrite the very V2 configuration
  //  this stage exists to preserve. Hiding them is the honest rendering of "V2 is
  //  dormant, not gone".]
  const isV3 = status.mode === "v3";

  profileSyncChooseBtn.classList.toggle("hidden", isV3 || status.configured);
  profileSyncReconnectBtn.classList.toggle("hidden", isV3 || status.status !== "permission-needed");
  profileSyncConnectedRow.classList.toggle(
    "hidden",
    isV3 || !status.configured || status.status === "permission-needed"
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
  profileSyncActivatePanel.classList.toggle(
    "hidden",
    isV2 || isV3 || !status.configured || status.status === "syncing"
  );

  if (!status.configured || isV3) {
    profileSyncManagePanel.classList.add("hidden");
  }

  renderSyncV3State(status, isV3);

  let line;
  switch (status.status) {
    case "not-configured":
      line = "Status: Not configured";
      break;
    case "checking":
      line = "Status: Checking Sync Folder access…";
      break;
    case "permission-needed":
      line = `Status: Permission needed for "${status.folderName}".`;
      break;
    case "syncing":
      line = "Status: Syncing…";
      break;
    case "conflict":
      line = "A Curation changed on another device. Choose a version below.";
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
      line = `Sync activation did not finish — ${status.message || "Your Curation is safe and saved locally."}`;
      break;
    // [SYNCV3 / STAGE-01 / V3-ROOT-ISOLATION]
    // [WHY: V3 gets its own status strings rather than reusing "connected".
    //  The default branch below renders "✓ Connected — … Sync V1", because its
    //  only mode test is `mode === "v2"` — so a V3 installation falling through
    //  would be told it is running Sync V1 over a folder nothing has ever
    //  written to. Every line here states plainly that no syncing happens yet;
    //  that remains true until the stage that adds the V3 transport.]
    case "v3-ready": {
      // [SYNCV3 / STAGE-03A / V3-ASSOCIATION-ISOLATION-AND-PASS-SKELETON]
      // [WHY: says which of the two things is true rather than one comforting
      //  sentence covering both. A pass that merged peers but was refused a
      //  publish is genuinely half-working, and the user is entitled to know
      //  their device is reading but not contributing.]
      line = `Sync V3 — "${status.v3FolderName}"`;
      // [SYNCV3 / STAGE-03B / SAME-DEVICE-WRITER-COORDINATION]
      // [WHY: a reader tab says WHY it is a reader, in the user's terms. "Another
      //  tab is writing" is normal and expected with two or three tabs open, and
      //  reads as reassuring; "this browser cannot coordinate writes" is a real
      //  limitation the user needs to know about, because that device will never
      //  contribute its changes. Collapsing both into one vague "read-only"
      //  would hide the second behind the first.]
      // [SYNCV3 / STAGE-03B-FIX / DUAL-WRITER-DIAGNOSIS]
      // [WHY: driven by v3IsWriter — whether this tab HOLDS the lease — rather
      //  than by whether the last pass happened to publish. A writer with
      //  nothing new to publish is still the writer, and reporting it as
      //  read-only would make the two tabs look identical again, which is the
      //  symptom that surfaced this bug in the first place.]
      if (status.v3IsWriter) {
        line += " · Writing for this device";
      } else {
        switch (status.v3PublishBlocked) {
          case "writer-lease-held-by-another-tab":
            line += " · Read-only — another Browser Gallery tab is writing for this device.";
            break;
          case "web-locks-unavailable":
            line += " · Read-only — this browser cannot coordinate Drive writes.";
            break;
          case "live-writes-disabled":
            line += " · Read-only — live V3 writes are turned off.";
            break;
          case "writer-lease-lost-mid-pass":
            line += " · Read-only — the writer role moved during this pass.";
            break;
          default:
            line += " · Read-only — waiting for the writer role.";
        }
      }
      if (status.v3MergedPeers) {
        line += ` · ${status.v3MergedPeers} peer device${status.v3MergedPeers === 1 ? "" : "s"} merged`;
      }
      if (status.v3SkippedPeers && status.v3SkippedPeers.length) {
        const count = status.v3SkippedPeers.length;
        line += ` · ${count} director${count === 1 ? "y" : "ies"} skipped this pass (will retry)`;
      }
      break;
    }
    case "v3-permission-needed":
      line = `Sync V3 — permission needed for "${status.v3FolderName}". Nothing is being synced.`;
      break;
    case "v3-not-configured":
      line = "Sync V3 is active — no Sync Folder chosen yet. Nothing is being synced.";
      break;
    // [SYNCV3 / STAGE-03A / V3-ASSOCIATION-ISOLATION-AND-PASS-SKELETON]
    // [WHY: a V3 status must never reach the `default` branch below, which
    //  renders "✓ Connected … Sync V1" because its only mode test is
    //  `mode === "v2"`. A V3 pass that failed read-back verification reported as
    //  a connected V1 sync is the precise false reassurance Stage B removed from
    //  V1, so every V3 status this engine can produce gets an explicit arm.]
    case "v3-verify-failed":
      line = `Sync V3 not completed — ${status.message || "nothing was accepted; your local Curation is unaffected."}`;
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

// [SYNCV3 / STAGE-06 / SCAFFOLDING-CLEANUP]
// WHAT: Renders the normal V3 actions and retained Advanced diagnostics from
// the SAME status snapshot renderProfileSync() already read.
// [WHY: takes `status` as an argument rather than calling getStatus() again.
//  Two reads of a live engine can straddle a state change, which is how one
//  panel ends up describing a connection the other has already released — the
//  same single-snapshot discipline the rest of this render function follows.]
function renderSyncV3State(status, isV3) {
  // [SYNCV3 / STAGE-05 / DEVICE-NAMING]
  // [WHY: the input shows the CUSTOM name only, never the detected fallback, so
  //  an empty field honestly means "you have not named this device". Pre-filling
  //  it with "Chromebook" would make a Save look like a no-op while actually
  //  freezing a detected value as a custom one. The status line underneath is
  //  where the effective customer-facing name is shown. Durable identity stays
  //  in the Advanced diagnostic line below; the human name never becomes identity.]
  if (document.activeElement !== profileSyncV3DeviceNameInput) {
    profileSyncV3DeviceNameInput.value = status.deviceName || "";
  }
  profileSyncV3DeviceNameStatus.textContent = status.deviceDisplayName
    ? `This device: ${status.deviceDisplayName}${status.deviceName ? "" : " (detected)"}`
    : "This device: unknown";
  profileSyncV3DeviceNameResetBtn.disabled = !status.deviceName;

  const connected = Boolean(status.v3Configured);

  profileSyncV3ChooseBtn.textContent = connected ? "Change Sync Folder" : "Choose Sync Folder";
  profileSyncV3ReconnectBtn.classList.toggle("hidden", !connected || status.v3Status !== "permission-needed");
  profileSyncV3DisconnectBtn.classList.toggle("hidden", !connected);
  profileSyncV3ActivateBtn.classList.toggle("hidden", isV3);
  profileSyncV3LeaveBtn.classList.toggle("hidden", !isV3);

  let line;
  if (!connected) {
    line = isV3
      ? "Mode: V3 (active) · No Sync Folder chosen yet."
      : "Mode: " + status.mode + " · No Sync Folder chosen yet.";
  } else if (status.v3Status === "permission-needed") {
    line = `Mode: ${isV3 ? "V3 (active)" : status.mode} · Folder "${status.v3FolderName}" — permission needed.`;
  } else {
    line = `Mode: ${isV3 ? "V3 (active)" : status.mode} · Folder "${status.v3FolderName}" — ready.`;
  }
  // [SYNCV3 / STAGE-03B-FIX / DUAL-WRITER-DIAGNOSIS]
  // [WHY: the Stage 01 line here said "No V3 transport yet — nothing is written
  //  to this folder", which stopped being true the moment live writes were
  //  enabled. A status surface that keeps asserting a retired invariant is worse
  //  than one that says nothing, because it is the line a user checks when
  //  deciding whether their data is safe to touch.]
  if (isV3) {
    line += status.v3IsWriter
      ? " This tab is the Drive writer for this device."
      : " This tab is read-only; another tab or browser holds the writer role.";
  }
  if (status.deviceId) line += ` Device ID: ${status.deviceId}.`;
  profileSyncV3StatusText.textContent = line;
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
    "Disconnect Curation Sync? Your Curations remain saved locally — they will just stop syncing to this Sync Folder."
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
      "• Nothing in your local Curations is deleted.\n\n" +
      "This is one-way for this device."
  );
  if (!confirmed) return;

  profileSyncActivateBtn.disabled = true;
  try {
    await profileSync.activateSyncV2();
  } finally {
    profileSyncActivateBtn.disabled = false;
  }
});

// [SYNCV3 / STAGE-01 / V3-ROOT-ISOLATION]
// WHAT: Handlers for the temporary Sync V3 development controls.
// [WHY: the picker is called DIRECTLY from the click, with no confirmation modal
//  in between — unlike the V1/V2 path, which routes through openSyncSetupModal()
//  to explain the shared-Drive convention. That modal names a specific
//  recommended folder and belongs to the V1/V2 relationship; reusing it would
//  point a V3 user at the V2 folder, which is the one folder V3 must never
//  adopt. The proper V3 setup explanation is part of the later Profile & Sync
//  Settings stage.]
// [SYNCV3 / STAGE-10 / CHANGE-SYNC-FOLDER-FIX]
// [WHY: this used to report failure ONLY through profileSyncV3StatusText, which
// lives inside the collapsed <details class="advanced-settings-section">. The
// button that calls it lives in the always-visible Sync group, so an
// unsupported browser or a picker error produced a click with no visible result
// whatsoever. Failures now also reach the product status line beside the
// button. renderProfileSync() overwrites that line on the next emit, which is
// correct — a failed pick emits nothing, so the message survives exactly as
// long as it is still true.]
function reportSyncFolderProblem(message, tone) {
  profileSyncV3StatusText.textContent = message;
  profileSyncProductStatus.textContent = message;
  applyProductStatusTone(profileSyncProductStatus, tone);
}

async function runV3FolderPicker() {
  if (!isFsaSupported()) {
    reportSyncFolderProblem("This browser does not support choosing a Sync Folder.", "warning");
    return;
  }

  let dirHandle;
  try {
    dirHandle = await window.showDirectoryPicker({ mode: "readwrite" });
  } catch (error) {
    if (error && error.name === "AbortError") return; // user closed the picker — not an error
    reportSyncFolderProblem(`Could not open the folder picker: ${error.message}`, "danger");
    return;
  }

  try {
    await profileSync.connectV3Folder(dirHandle);
  } catch (error) {
    // [WHY: connectV3Folder tolerates a failed PERSIST internally, so reaching
    // here means the connection itself failed. Swallowing it was the other way
    // this control could appear to do nothing.]
    console.warn("[SYNCV3] Could not connect the chosen Sync Folder.", error);
    reportSyncFolderProblem("Could not use that Sync Folder. Try choosing it again.", "danger");
  }
}

// [SYNCV3 / STAGE-05 / DEVICE-NAMING]
// [WHY: saving persists locally and notifies sibling tabs, and that is ALL it
//  does. It never touches Drive: the renamed directory appears when the
//  scheduler next publishes under the writer lease. renderProfileSync() runs off
//  ProfileStore's own subscription, so the new name is on screen immediately
//  without a reload.]
async function saveSyncV3DeviceName(rawValue) {
  profileSyncV3DeviceNameSaveBtn.disabled = true;
  profileSyncV3DeviceNameResetBtn.disabled = true;
  try {
    await profile.setDeviceName(rawValue);
  } catch (error) {
    console.warn("[SYNCV3] Could not save the Device Name.", error);
    profileSyncV3DeviceNameStatus.textContent = "Could not save the Device Name.";
  } finally {
    profileSyncV3DeviceNameSaveBtn.disabled = false;
    renderProfileSync();
  }
}

profileSyncV3DeviceNameSaveBtn.addEventListener("click", () =>
  saveSyncV3DeviceName(profileSyncV3DeviceNameInput.value)
);
// Blank or whitespace-only means "reset to the detected default" — the same rule
// setDeviceName applies, so Save-on-empty and Reset cannot disagree.
profileSyncV3DeviceNameResetBtn.addEventListener("click", () => saveSyncV3DeviceName(""));
profileSyncV3DeviceNameInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    saveSyncV3DeviceName(profileSyncV3DeviceNameInput.value);
  }
});

profileSyncV3ChooseBtn.addEventListener("click", runV3FolderPicker);
profileSyncV3ReconnectBtn.addEventListener("click", () => profileSync.reconnectV3());

profileSyncV3DisconnectBtn.addEventListener("click", async () => {
  const confirmed = window.confirm(
    "Disconnect this Sync Folder?\n\n" +
      "Syncing stops on this device. Your local Browser Gallery information and the files already in the Sync Folder are kept."
  );
  if (!confirmed) return;
  await profileSync.disconnectV3();
});

profileSyncV3ActivateBtn.addEventListener("click", async () => {
  const confirmed = window.confirm(
    "Activate Sync V3 on this device?\n\n" +
      "• Sync V3 has no transport yet — nothing will be synced or written to the V3 folder.\n" +
      "• Sync V2 becomes dormant. Its saved configuration is left completely intact.\n" +
      "• Nothing in your local Curations is deleted.\n\n" +
      "You can return to Sync V2 with \"Leave V3 Mode\"."
  );
  if (!confirmed) return;

  profileSyncV3ActivateBtn.disabled = true;
  try {
    await profileSync.activateSyncV3();
  } finally {
    profileSyncV3ActivateBtn.disabled = false;
  }
});

profileSyncV3LeaveBtn.addEventListener("click", async () => {
  profileSyncV3LeaveBtn.disabled = true;
  try {
    // Restores whatever V2's own untouched record says this installation was —
    // see ProfileSync#deactivateSyncV3 for why that is a re-read, not a restore
    // of remembered fields.
    await profileSync.deactivateSyncV3();
  } finally {
    profileSyncV3LeaveBtn.disabled = false;
  }
});

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
  const { playback, presentation, microArcade, startup } = preferences;

  intervalInput.value = String(playback.intervalSeconds);
  shuffleInput.checked = playback.shuffle;
  arcadeAnimationOrderSelect.value = microArcade.animationOrder;
  arcadeAnimationOrder = microArcade.animationOrder;
  updateArcadeAnimationOrderHelper();
  // [STARTUP-MEDIA / N6-4] [STREAMLOOP-INTEGRATION / N6-6] [STREAMLOOP-INTEGRATION / N6-9]
  // currentStartupPreferences must be set before renderRecentLibraries() (and
  // the renderStartupMediaSettings() calls it makes for BOTH contexts) first
  // runs — applyLoadedPreferences() always runs earlier in boot, well before
  // initFsaLibraries(). Each context's Auto Fill checkbox is seeded here too,
  // now that it lives alongside that context's own policy.
  currentStartupPreferences = startup;
  for (const context of ["browser", "streamloop"]) {
    startupMediaControls[context].policySelect.value = startup[context].policy;
    startupMediaControls[context].autoFillInput.checked = startup[context].autoFillPanel;
    updateStartupMediaPolicyHelper(context);
  }
  skipDuplicatesInput.checked = playback.skipDuplicates;
  skipDuplicates = playback.skipDuplicates;
  loopInput.checked = playback.loopPlaylist;
  // [UI-REDESIGN / Stage 3] `fillInput.checked = playback.fillPanel` retired
  // with the checkbox. Restored like every other playback control:
  // loadPreferences() has already defaulted this to true for records saved
  // before the key existed, so an older stored record lands here as ON.
  autoplayOnFillInput.checked = playback.autoplayOnFill;

  // "Toolbar Opacity" on screen; `ghost*`/`rememberGhostOpacity` internally
  // — see the DOM-capture comment above for why the names differ.
  ghostRememberInput.checked = presentation.rememberGhostOpacity;
  const ghostPercent = presentation.rememberGhostOpacity
    ? presentation.ghostOpacityPercent
    : DEFAULT_GHOST_OPACITY_PERCENT;
  ghostOpacityInput.value = String(ghostPercent);

  // Same "unchecked Remember falls back to the built-in default, not a
  // stale stored number" rule, applied independently to Hover Opacity.
  hoverRememberInput.checked = presentation.rememberHoverOpacity;
  const hoverPercent = presentation.rememberHoverOpacity
    ? presentation.hoverOpacityPercent
    : DEFAULT_HOVER_OPACITY_PERCENT;
  hoverOpacityInput.value = String(hoverPercent);

  runtime.setShuffle(shuffleInput.checked);
  runtime.setShuffleMode(playback.shuffleMode);
  runtime.setLoop(loopInput.checked);
  runtime.setIntervalMs(Number(intervalInput.value) * 1000);
  applyGhostOpacity(Number(ghostOpacityInput.value));
  // Seed Hover Opacity's tracked value/label directly rather than through
  // applyHoverOpacity() — at boot the pointer is not hovering the toolbar,
  // so the toolbar must render at Toolbar Opacity (just applied above), not
  // be forced into its hover look before any real hover has happened.
  currentHoverOpacityPercent = Number(hoverOpacityInput.value);
  hoverOpacityLabel.textContent = `${currentHoverOpacityPercent}%`;
}

const loadedPreferences = await loadPreferences();
applyLoadedPreferences(loadedPreferences);
initializeProfileSyncIntroduction(loadedPreferences.onboarding);

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
  remoteProvider.dispose();
});

// [STREAMLOOP-INTEGRATION / N6-6] [STREAMLOOP-INTEGRATION / N6-7]
// BREADCRUMBS — IS: consumes StreamLoop's existing LAUNCHPAD_PLAY/
// LAUNCHPAD_PAUSE postMessage contract (see streamloop-bridge.js's header for
// the exact confirmed shape). Mutates playback through the SAME
// runtime.play()/runtime.stop() calls togglePlay() already uses (see
// togglePlay() above) — a StreamLoop PLAY/PAUSE is indistinguishable,
// downstream, from a human click.
//
// [WHY: source validation checks event.source === window.parent rather than
//  event.origin, because GS3 posts with target origin '*' and has no fixed
//  origin of its own to validate against (self-hosted GS3 may run at any
//  dev/staging/prod origin) — see the N6-5 handoff's Part 3. This still
//  rejects messages from any window other than the one actually framing this
//  tab, including this tab's own window.]
//
// [WHY / N6-7 CORRECTION: N6-6 treated state.hasVisibleItems alone as
//  readiness. That is real but too early — hasVisibleItems flips true inside
//  loadFromFsaHandle()'s finishLoadingItems() call, BEFORE that same
//  function's own remaining Curation/registry bookkeeping (armDeferredLoadTimeOffer,
//  touchLibrary, recordLibraryLoaded, recordPortableStructureForLoad,
//  renderRecentLibraries) has settled — see loadFromFsaHandle()'s own
//  `finally` comment naming ITS completion the authoritative one. Readiness
//  now additionally requires streamLoopStartupSettled, which only becomes
//  true once attemptStartupMedia() itself has returned — see that function
//  below. This also guarantees Auto Fill Panel enters BEFORE any pending
//  PLAY/PAUSE is applied, exactly the ordering the N6-7 handoff proves.]
//
// This shared state is declared unconditionally (module scope), since
// attemptStartupMedia() below — reachable regardless of launch context —
// needs to set streamLoopStartupSettled and call tryBecomeStreamLoopReady().
// It stays completely inert for an ordinary browser tab: nothing calls into
// it, because the only two things that DO — the message listener and the
// extra runtime.subscribe() below — stay behind the launchContext guard, and
// attemptStartupMedia()'s own StreamLoop branch is itself gated the same way.
let streamLoopPendingIntent = null;
let streamLoopReady = false;
let streamLoopStartupSettled = false;

function applyStreamLoopIntent(intent) {
  if (intent === "play") runtime.play();
  else if (intent === "pause") runtime.stop();
}

// Shared by both trigger paths below — the boot-settle path
// (attemptStartupMedia()) and the fallback runtime.subscribe() path — so
// neither can double-apply a pending intent.
function tryBecomeStreamLoopReady() {
  if (streamLoopReady) return;
  if (!streamLoopStartupSettled) return;
  if (!runtime.getState().hasVisibleItems) return;
  streamLoopReady = true;
  if (streamLoopPendingIntent) applyStreamLoopIntent(streamLoopPendingIntent);
  streamLoopPendingIntent = null;
}

function isTrustedStreamLoopSource(event) {
  return event.source != null && event.source === window.parent && event.source !== window;
}

// Registered ONLY when this tab was explicitly launched with
// `?launch=streamloop` — an ordinary browser tab never adds this listener or
// the extra runtime.subscribe() below, so there is no dormant surface for a
// normal customer session.
if (launchContext === LAUNCH_CONTEXT_STREAMLOOP) {
  window.addEventListener("message", (event) => {
    if (!isTrustedStreamLoopSource(event)) return;
    const intent = parseStreamLoopMessage(event.data);
    if (!intent) return;
    if (streamLoopReady) {
      applyStreamLoopIntent(intent);
    } else {
      streamLoopPendingIntent = nextPendingIntent(intent);
    }
  });

  // Fallback ONLY: covers the boot-time StreamLoop load finding nothing to
  // restore, with media appearing later through some other path in the same
  // tab (e.g. a manual folder pick). Does NOT trigger Auto Fill Panel — see
  // attemptStartupMedia() below for why that stays scoped to the boot-time
  // load alone.
  runtime.subscribe((state) => {
    if (streamLoopReady || !state.hasVisibleItems) return;
    tryBecomeStreamLoopReady();
  });
}

// [BOOT-RESTORE / N6]
// [WHY: queryPermission ONLY, wrapped so a missing API, a missing handle, or
//  a thrown error all resolve to a non-"granted" string instead of
//  throwing — the same defensive shape fsa-ancestry.js's readPermission()
//  already uses for background permission reads. Deliberately separate from
//  resumeLibrary()'s own permission check below rather than shared with it:
//  resumeLibrary() must still requestPermission() and prune Recents on
//  failure (P1/P6), and folding those two different failure behaviours
//  behind one shared query helper risks quietly changing which branch a
//  thrown queryPermission error takes there. See P3/P6 in the N6 handoff.]
async function readFolderPermissionForBootRestore(handle) {
  if (!handle || typeof handle.queryPermission !== "function") return "unavailable";
  try {
    return await handle.queryPermission({ mode: "read" });
  } catch (error) {
    return `error:${error && error.name ? error.name : "unknown"}`;
  }
}

// [BOOT-RESTORE / N6]
// BREADCRUMBS — IS: at boot, if the most recently opened durable FSA folder
// still reports queryPermission() === "granted", load it silently through
// the SAME granted-folder load path a Recent-row click uses
// (loadFromFsaHandle) — so Curation restoration, Stage 09, MEDIA-ID and the
// N2/N3/N4 arming all behave exactly as on a manual open. Anything other
// than "granted" — "prompt", "denied", a missing handle, a missing API, or
// a thrown error — does nothing at all. Never requestPermission() here;
// that needs a user gesture this boot path does not have. Never falls
// through to a second candidate — see decideBootRestore()'s own comment.
// [WHY: the explicit-click failure behaviour in resumeLibrary() —
//  requestPermission() and removeFromRecents() on a bad handle — is
//  deliberately NOT reused here. A transient boot-time failure must not
//  silently delete the customer's remembered folder (P6); only a customer
//  watching an explicit click gets that pruning.]
async function attemptBootRestore() {
  let rows;
  try {
    rows = await listLibraries();
  } catch (error) {
    console.warn("[BOOT-RESTORE] Could not read saved libraries.", error);
    return;
  }

  const candidate = rows[0];
  if (!candidate) return;

  const state = await readFolderPermissionForBootRestore(candidate.handle);
  const decision = decideBootRestore({
    rows,
    permissionStates: candidate.id ? { [candidate.id]: state } : {},
  });
  if (!decision.restore) return;

  // [WHY: a customer gesture always wins (P5). loadFromFsaHandle() bumps
  //  libraryLoadGeneration into a fresh loadToken and every N2/N3/N4/Stage
  //  09 arming call already gates on that token — an explicit folder pick
  //  or Recent-row click started (or finished) after this one began simply
  //  supersedes it, with no new staleness machinery needed here.]
  await loadFromFsaHandle(candidate.handle, candidate);
}

// [LIBRARY-REGISTRY] Boot-time: render whatever libraries were previously
// remembered so the user sees "Recent Libraries" immediately. This is a
// pure metadata read — renderRecentLibraries() itself does NOT check/request
// permission or load anything on its own.
//
// [BOOT-RESTORE / N6] BREADCRUMBS — WAS: this comment used to say the whole
// boot sequence stayed hands-off because "queryPermission-only would still
// mean silently touching folder access on every page load without the user
// asking", and refused to do it. That reasoning predates the North Star.
// queryPermission is now called from non-gesture background paths in six
// other modules, and profileSync.init() (just below) already silently
// reconnects a remembered Sync Folder on the same basis. attemptBootRestore()
// below — the one deliberate exception, added by N6 — extends that same
// proven pattern to the folder the customer actually cares about.
(async function initFsaLibraries() {
  if (!isFsaSupported()) {
    fsaChooseFolderBtn.disabled = true;
    fsaStatusText.textContent = "This browser does not support remembered folders.";
    return;
  }

  await renderRecentLibraries();

  // Not awaited — same reasoning profileSync.init() below documents: a
  // permission check should never block the rest of boot, and nothing here
  // depends on startup media restore having settled.
  attemptStartupMedia();
})();

// Cassette file picking is an independent capability from directory picking;
// this boot path must still run when initFsaLibraries() returns early.
(async function initRemoteCassettes() {
  await renderRemoteCassettes();
})();

// [STARTUP-MEDIA / N6-4] [STREAMLOOP-INTEGRATION / N6-6]
// BREADCRUMBS — IS: an Advanced "Startup Media" preference (default
// "last-used", which is exactly N6's zero-ceremony reopen, unchanged) chooses
// what loads at boot. Since N6-6, TWO independent such preferences exist —
// "browser" and "streamloop" — and this function resolves which one applies
// by reading the live `launchContext` (parsed once from the URL at module
// load — see launch-context.js), BEFORE calling decideStartupMedia(). That
// function's own signature and decision table are untouched by this slice —
// it stays single-policy-in/single-decision-out; the dual-context resolution
// happens here, at the boundary that already knows launchContext, not inside
// the pure decision function itself.
//
// "random-remembered" and "random-selected" query permission — never request
// it — for every remembered durable folder in the relevant pool and hand the
// granted subset to decideStartupMedia() (boot-restore.js), which picks one
// row using an injected random(). The winning row loads through the SAME
// loadFromFsaHandle() every other caller uses — see attemptBootRestore()
// above, which this function delegates to unchanged for the default policy
// so N6's own frozen test/behavior never has to move for this slice.
//
// [STREAMLOOP-INTEGRATION / N6-7] Renamed from attemptStartupMedia() to
// runStartupMediaLoad() — this function's OWN body is unchanged; it is now
// wrapped by the real attemptStartupMedia() below, which awaits it (the
// authoritative "this load has settled" seam — see the N6-7 handoff's Part
// 2) before deciding anything about Auto Fill Panel or pending StreamLoop
// intent.
async function runStartupMediaLoad() {
  const activeContext = launchContext === LAUNCH_CONTEXT_STREAMLOOP ? "streamloop" : "browser";
  const startup =
    (currentStartupPreferences && currentStartupPreferences[activeContext]) ||
    { policy: "last-used", eligibleLibraryIds: [], autoFillPanel: false };

  // [STREAMLOOP-INTEGRATION / N6-9]
  // BREADCRUMBS — IS: "off" ("Do not load media automatically") performs no
  // remembered-folder load, no random selection, no permission query of any
  // kind, and no Auto Fill — it returns before any of that machinery runs,
  // leaving Browser Gallery exactly as available for a normal manual folder
  // pick as it always is. Checked BEFORE the "fall back to last-used"
  // branch below, which would otherwise treat "off" as an unrecognized
  // policy string and silently restore anyway.
  if (startup.policy === "off") return;

  if (startup.policy !== "random-remembered" && startup.policy !== "random-selected") {
    await attemptBootRestore();
    return;
  }

  let rows;
  try {
    rows = await listLibraries();
  } catch (error) {
    console.warn("[STARTUP-MEDIA] Could not read saved libraries.", error);
    return;
  }
  if (!rows.length) return;

  // [WHY: every row in the pool needs a live permission read before
  //  decideStartupMedia() can filter to "granted" — unlike last-used, which
  //  only ever needs rows[0]. Still queryPermission-only, still never a
  //  gesture-requiring permission prompt — see
  //  readFolderPermissionForBootRestore() above.]
  const permissionStates = {};
  for (const row of rows) {
    if (!row.id) continue;
    permissionStates[row.id] = await readFolderPermissionForBootRestore(row.handle);
  }

  const decision = decideStartupMedia({
    policy: startup.policy,
    rows,
    permissionStates,
    eligibleIds: startup.eligibleLibraryIds,
  });
  if (!decision.restore) return;

  const candidate = rows.find((row) => row.id === decision.rowId);
  if (!candidate) return;

  // [WHY: same P5 reasoning as attemptBootRestore() — loadFromFsaHandle()
  //  owns the one generation/token guard every caller shares, so no new
  //  staleness machinery is needed here either.]
  await loadFromFsaHandle(candidate.handle, candidate);
}

// [STREAMLOOP-INTEGRATION / N6-7] [STREAMLOOP-INTEGRATION / N6-9]
// BREADCRUMBS — IS: the thin settle-sequence wrapper around
// runStartupMediaLoad() (N6-4/N6-6's original attemptStartupMedia() body,
// renamed but otherwise untouched above). Awaiting it IS the authoritative
// "this load has settled" seam — see the N6-7 handoff's Part 2 for why
// state.hasVisibleItems alone is a weaker, earlier-firing proxy that this
// deliberately does not use. Since N6-9, Auto Fill Panel is symmetric:
// Normal Browser Gallery and StreamLoop each read THEIR OWN
// currentStartupPreferences[activeContext].autoFillPanel and each get the
// identical guarantee — Auto Fill may occur only after this same
// authoritative completion, never from an early or duplicated signal.
//
// Sequencing (verified against the real code in the N6-7 handoff, not
// assumed): Auto Fill Panel (if enabled for the active context and there is
// visible media) THROUGH enterFillPanelDeliberately(), the same shared entry
// point the `Fill ⛶` button and `F` shortcut use -> only THEN, for a
// StreamLoop launch specifically, apply whatever PLAY/PAUSE intent is
// currently pending. Applying the pending intent strictly after Fill Panel
// entry is what guarantees the most recent explicit StreamLoop signal
// always outranks BG's own "Autoplay on Fill" default, however that default
// already resolved a moment earlier inside enterFillPanelDeliberately() —
// see the N6-7 handoff's ordering table. Normal Browser Gallery has no
// PLAY/PAUSE concept at all, so its own path ends at Auto Fill Panel.
//
// Auto Fill Panel is deliberately scoped to THIS one call only — this
// function runs exactly once per page load, from initFsaLibraries() below —
// so it can never re-fire for a later manual folder pick in the same tab,
// for either context. If startup.policy for the active context is "off",
// runStartupMediaLoad() above returns without loading anything, so
// hasVisibleItems stays false and Auto Fill correctly never fires even if a
// customer had previously saved Auto Fill as ON for that context.
async function attemptStartupMedia() {
  await runStartupMediaLoad();

  const activeContext = launchContext === LAUNCH_CONTEXT_STREAMLOOP ? "streamloop" : "browser";
  const autoFillEnabled = Boolean(currentStartupPreferences?.[activeContext]?.autoFillPanel);

  if (runtime.getState().hasVisibleItems && autoFillEnabled) {
    enterFillPanelDeliberately();
  }

  if (launchContext !== LAUNCH_CONTEXT_STREAMLOOP) return;

  streamLoopStartupSettled = true;
  tryBecomeStreamLoopReady();
}

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
// [MEDIA-ID / STAGE-02B / TELEMETRY]
// window.__bgMediaIdTelemetry(options)
//
// The debug-only read-back of this SESSION's alias-index builds. Strictly
// read-only: it prints what the builds already recorded and runs no build, no
// probe, no IndexedDB read and no filesystem access, so typing it during a live
// two-root test cannot change what that test is measuring.
//
// [WHY EXEMPLAR PATHS ARE OPT-IN: the aggregate report answers every Stage 02B
//  question on its own and names no media. The bounded per-reason exemplars are
//  the only place a real path is retained, they exist so a developer can go and
//  LOOK at the file a refusal was about, and they are printed only when asked
//  for by name — never in normal operation and never in the console line the app
//  emits on every load.]
window.__bgMediaIdTelemetry = function (options = {}) {
  const { paths = false, all = false } = options;
  const builds = mediaIdTelemetryHistory.entries();
  const lines = [];

  lines.push("=== MEDIA-ID PROJECTION TELEMETRY (this session, in memory only) ===");
  lines.push(
    `${builds.length} build(s) retained` +
      `${mediaIdTelemetryHistory.dropped ? `, ${mediaIdTelemetryHistory.dropped} older build(s) dropped` : ""}` +
      ` (cap ${TELEMETRY_LIMITS.SESSION_BUILDS}). Nothing here is persisted or shared between tabs.`
  );

  if (!builds.length) {
    lines.push("");
    lines.push("(no projection has been built yet — load a folder, then call this again)");
    console.log(lines.join("\n"));
    return undefined;
  }

  const shown = all ? builds : builds.slice(-5);
  if (shown.length !== builds.length) {
    lines.push(`(showing the last ${shown.length}; pass { all: true } for every retained build)`);
  }

  for (const build of shown) {
    const d = build.diagnostics || {};
    const t = d.telemetry || null;
    lines.push("");
    lines.push(`--- ${new Date(build.at).toLocaleTimeString()}  ${build.reason} ---`);
    if (build.rootName) {
      lines.push(
        `Root: ${build.rootName}${build.scopeAction ? ` (${build.scopeAction})` : ""}` +
          `${build.prefixFromScopeRoot !== undefined ? ` prefix ${JSON.stringify(build.prefixFromScopeRoot)}` : ""}`
      );
    }
    if (!d || !t) {
      lines.push("No index (no scope row, or a single-root scope — nothing to project).");
      continue;
    }
    lines.push(
      `Observed ${d.observed ?? "?"} item(s); ${d.factKeys ?? "?"} curated fact key(s); ` +
        `${build.aliasedItems} item(s) aliased.`
    );
    lines.push(
      `Candidates ${t.candidates.total}: admitted ${t.candidates.admitted}, ` +
        `refused PRESENT ${t.candidates.refusedPresent}, refused UNKNOWN ${t.candidates.refusedUnknown}.`
    );
    lines.push(
      `Items with candidates ${t.items.withCandidates}: aliased ${t.items.aliased}, ` +
        `fully refused ${t.items.refused}, contested (>1 candidate key) ${t.items.contested}, ` +
        `multi-alias (>1 admitted) ${t.items.multiAlias}.`
    );

    const bucketLines = (title, buckets) => {
      const entries = Object.entries(buckets || {}).filter(([, count]) => count);
      if (!entries.length) return;
      lines.push(`${title}:`);
      entries.sort((a, b) => b[1] - a[1]);
      for (const [reason, count] of entries) {
        const detail = t.details && t.details[reason];
        const detailText = detail
          ? ` [${Object.entries(detail)
              .map(([value, n]) => `${value}×${n}`)
              .join(", ")}]`
          : "";
        lines.push(`  ${count.toString().padStart(6)}  ${reason}${detailText}`);
      }
    };
    bucketLines("Refused because a competitor was PRESENT, proven by", t.presentBy);
    bucketLines("Refused because existence was UNKNOWN, because", t.unknownBy);
    bucketLines("Competitors proven ABSENT by", t.absentBy);

    const probes = d.probes || {};
    lines.push(
      `Cost: ${probes.directoryProbes ?? 0} directory probe(s), ${probes.fileProbes ?? 0} file probe(s)` +
        `${probes.budgetExhausted ? "  *** PROBE BUDGET EXHAUSTED ***" : ""}.`
    );
    if (t.truncated && (t.truncated.details || t.truncated.exemplars)) {
      lines.push(
        `(bounded: ${t.truncated.details} detail value(s) and ${t.truncated.exemplars} exemplar(s) not retained)`
      );
    }

    if (paths) {
      const reasons = Object.keys(t.exemplars || {});
      if (!reasons.length) lines.push("Exemplars: (none)");
      for (const reason of reasons) {
        lines.push(`Exemplars for ${reason} (max ${TELEMETRY_LIMITS.EXEMPLARS_PER_REASON}):`);
        for (const sample of t.exemplars[reason]) {
          lines.push(`  viewed ${JSON.stringify(sample.scopePath)}`);
          lines.push(`    candidate key   ${JSON.stringify(sample.key)}`);
          lines.push(`    deciding target ${JSON.stringify(sample.destination)}`);
        }
      }
    }
  }

  if (!paths) {
    lines.push("");
    lines.push("(call __bgMediaIdTelemetry({ paths: true }) for the bounded per-reason path exemplars)");
  }

  console.log(lines.join("\n"));
  return undefined; // a human report; nothing to act on programmatically
};

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

  // [MEDIA-ID / STAGE-02 / LOCAL-PROJECTION]
  // [WHY: deliberately NOT routed through profileView. This block reports what
  //  is STORED, keyed by the literal fact path — the projection reports what is
  //  SHOWN. Projecting the diagnostic would hide the very divergence between
  //  those two that a diagnostic exists to reveal, and it would report a path's
  //  curation under a key that path does not hold.]
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
