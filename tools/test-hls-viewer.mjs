// Executes the production viewer functions with a small DOM/MSE stand-in.
// These tests prove integration/lifecycle behavior, not browser media decoding.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { HlsPlaybackAdapter } from "../src/playback/hls-playback-adapter.js";
import { TsPlaybackAdapter } from "../src/playback/ts-playback-adapter.js";
import { MediaRuntime } from "../src/runtime/media-runtime.js";
import { RemoteUrlProvider } from "../src/providers/remote-url-provider.js";
import { extractRemoteUrls } from "../src/providers/remote-url-parser.js";

const mainSource = await readFile(new URL("../src/main.js", import.meta.url), "utf8");
let assertions = 0;
function check(condition, label) {
  assert.ok(condition, label);
  assertions += 1;
}

function sourceFunction(name) {
  const expression = new RegExp(`^(?:async )?function ${name}\\(`, "m");
  const match = expression.exec(mainSource);
  assert.ok(match, `production function ${name} exists`);
  const rest = mainSource.slice(match.index);
  const next = /\n(?:async )?function \w+\(/.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

class FakeNode extends EventTarget {
  constructor(tagName) {
    super();
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.attributes = new Map();
    this.classes = new Set();
    this.classList = {
      add: (...names) => names.forEach((name) => this.classes.add(name)),
      remove: (...names) => names.forEach((name) => this.classes.delete(name)),
      contains: (name) => this.classes.has(name),
      toggle: (name, enabled = !this.classes.has(name)) => {
        if (enabled) this.classes.add(name);
        else this.classes.delete(name);
        return enabled;
      },
    };
    this.className = "";
    this.textContent = "";
    this.src = "";
    this.paused = true;
    this.playCalls = 0;
    this.pauseCalls = 0;
    this.loadCalls = 0;
    this.currentTime = 0;
    this.volume = 1;
  }
  set innerHTML(value) {
    assert.equal(value, "");
    this.children = [];
  }
  get firstChild() { return this.children[0] || null; }
  appendChild(child) { this.children.push(child); return child; }
  insertBefore(child, before) {
    const index = this.children.indexOf(before);
    this.children.splice(index < 0 ? this.children.length : index, 0, child);
    return child;
  }
  querySelector(selector) {
    return this.children.find((child) => child.className.split(" ").includes(selector.slice(1))) || null;
  }
  setAttribute(name, value) { this.attributes.set(name, value); }
  removeAttribute(name) {
    this.attributes.delete(name);
    if (name === "src") this.src = "";
  }
  canPlayType() { return ""; }
  play() {
    this.playCalls += 1;
    if (this.playError) return Promise.reject(this.playError);
    this.paused = false;
    return Promise.resolve();
  }
  pause() { this.pauseCalls += 1; this.paused = true; }
  load() { this.loadCalls += 1; }
  emit(type) { this.dispatchEvent(new Event(type)); }
}

const fakeTimers = new Map();
let nextTimer = 0;
const testWindow = new EventTarget();
testWindow.setTimeout = (callback) => {
  const id = ++nextTimer;
  fakeTimers.set(id, callback);
  return id;
};
testWindow.clearTimeout = (id) => fakeTimers.delete(id);
const previousWindow = globalThis.window;
globalThis.window = testWindow;
const flush = () => new Promise((resolve) => setImmediate(resolve));

function harness({ loadHls } = {}) {
  const instances = [];
  class FakeHls {
    static Events = { ERROR: "error", MANIFEST_PARSED: "manifestParsed" };
    static isSupported() { return true; }
    constructor(config) {
      this.config = config;
      this.listeners = new Map();
      this.destroyCalls = 0;
      instances.push(this);
    }
    on(type, listener) { this.listeners.set(type, listener); }
    attachMedia(video) { this.video = video; video.src = "blob:test-hls"; }
    loadSource(url) { this.url = url; }
    destroy() { this.destroyCalls += 1; }
    fire(type, data = {}) { this.listeners.get(type)?.(type, data); }
  }
  const favorites = new Set();
  const profileListeners = new Set();
  const profile = {
    isFavorite: (path) => favorites.has(path),
    isHidden: () => false,
    subscribe(listener) { profileListeners.add(listener); return () => profileListeners.delete(listener); },
    toggleFavorite(path) {
      if (favorites.has(path)) favorites.delete(path);
      else favorites.add(path);
      for (const listener of profileListeners) listener();
    },
  };
  const runtime = new MediaRuntime({ profile });
  runtime.setShuffle(false);
  const nodes = [];
  const hlsPlaybackAdapter = new HlsPlaybackAdapter({ loadHls: () => loadHls ? loadHls(FakeHls) : Promise.resolve(FakeHls) });
  const actualTsAdapter = new TsPlaybackAdapter();
  const tsCalls = { attach: [], detach: 0 };
  const tsPlaybackAdapter = {
    attach(...args) { tsCalls.attach.push(args); return actualTsAdapter.attach(...args); },
    detach() { tsCalls.detach += 1; actualTsAdapter.detach(); },
  };
  const disposable = () => ({ disposed: 0, dispose() { this.disposed += 1; } });
  const context = {
    console: { info() {}, log() {}, warn() {} }, performance, window: testWindow,
    document: { createElement(tag) { const node = new FakeNode(tag); nodes.push(node); return node; } },
    runtime, hlsPlaybackAdapter, tsPlaybackAdapter, extractRemoteUrls,
    remoteProvider: new RemoteUrlProvider(), provider: disposable(), fsaProvider: disposable(),
    viewerStage: new FakeNode("div"), viewerEmpty: new FakeNode("div"), appShell: new FakeNode("div"),
    clearBtn: new FakeNode("button"),
    currentViewerNode: null, currentViewerItem: null,
    currentViewerPreparationInFlight: false, lastRenderEntryAt: 0,
    fillModeActive: false, videoLoopInput: { checked: false },
    activeLoopRule: { type: "forever" }, loopRuleVideoToken: 0,
    loopRuleCompletedPlays: 0, loopRuleTimerId: null, tsDiagnosticCounter: 0,
    galleryGeneration: 0, libraryLoadGeneration: 0,
    currentSessionIsUrlBacked: false, isLoadingFiles: false, BATCH_SIZE: 250,
    fsaStatusText: {}, remoteStatusText: {},
    associationWriteSuppression: { setLoadedLibrary() {} },
    ambientProfileObserver: { clearContext() {} },
    outcomes: [], recordMediaRenderOutcome(outcome) { context.outcomes.push(outcome); },
    takePreparedViewerImage: () => null,
    releaseStaleReadyQueueEntries() {}, refreshReadyQueue() {},
    closeControlsDrawer() {}, measureTransitionReady() {},
    // Image preparation is outside this slice. Releasing a committed visual
    // still informs the real runtime, as the production terminal seam does.
    handleCurrentViewerTerminal() { context.currentViewerPreparationInFlight = false; runtime.notifyCurrentItemVisible(); },
    clearReverseCurationSuggestion() {}, clearDeviceAwareMediaQuestion() {},
    syncMobileLoadState() {}, syncUndoHideButton() {}, syncAssociateButtonVisibility() {},
    renderAmbientProfileOffer() {}, resetMediaRenderOutcomes() {},
    bumpGalleryGeneration() { context.galleryGeneration += 1; },
    exitFillMode() { context.fillModeActive = false; },
    finishLoadingItems(items) { runtime.load(items); },
    cancelWarmStart() {}, maybeBeginWarmStart() {},
    syncVideoLoopControl() {}, closeAutomationsTray() {},
  };
  vm.createContext(context);
  for (const name of [
    "isTsItem", "isHlsItem", "showHlsStatus", "playViewerVideo", "clearViewerNode",
    "buildViewer", "mountThumbMedia", "togglePlay", "clearLoopRuleTimer",
    "applyLoopRuleToCurrentVideo", "armLoopRuleForCurrentVideo", "shouldLoopRuleRestartVideo",
    "completeFiniteLoopAutomationAndAdvance", "loadRemoteSession",
  ]) vm.runInContext(sourceFunction(name), context, { filename: `src/main.js:${name}` });
  context.render = context.buildViewer;
  const clearStart = mainSource.indexOf('clearBtn.addEventListener("click",');
  const clearEnd = mainSource.indexOf('favoriteBtn.addEventListener("click",', clearStart);
  assert.ok(clearStart >= 0 && clearEnd > clearStart, "Clear Media production callback exists");
  vm.runInContext(mainSource.slice(clearStart, clearEnd), context);
  const pageStart = mainSource.indexOf('window.addEventListener("pagehide",');
  const pageEnd = mainSource.indexOf("// [STREAMLOOP-INTEGRATION / N6-6]", pageStart);
  assert.ok(pageStart >= 0 && pageEnd > pageStart, "page lifecycle production callbacks exist");
  // Each harness gets its own listeners, removed by its cleanup wrapper.
  const pageListeners = [];
  context.window = {
    setTimeout: testWindow.setTimeout, clearTimeout: testWindow.clearTimeout,
    addEventListener(type, listener) { pageListeners.push([type, listener]); },
  };
  vm.runInContext(mainSource.slice(pageStart, pageEnd), context);
  const unsubscribe = runtime.subscribe(context.buildViewer);
  return {
    context, runtime, instances, nodes, tsCalls, FakeHls,
    async ready(items) { runtime.load(items); await flush(); },
    page(type, properties = {}) { for (const [eventType, listener] of pageListeners) if (eventType === type) listener(properties); },
    close() { runtime.clear(); unsubscribe(); hlsPlaybackAdapter.detach(); tsPlaybackAdapter.detach(); context.clearLoopRuleTimer(); runtime.setProfile(null); },
  };
}

const hlsItem = (name = "one") => ({ id: name, name: `${name}.m3u8`, kind: "video", type: "application/vnd.apple.mpegurl", url: `https://cdn.example.com/${name}.m3u8?token=synthetic-fixture`, relativePath: `remote://${name}` });
const mp4Item = () => ({ id: "mp4", name: "ordinary.mp4", kind: "video", type: "", url: "https://cdn.example.com/ordinary.mp4", relativePath: "remote://ordinary" });
const imageItem = () => ({ id: "image", name: "photo.jpg", kind: "image", type: "", url: "https://cdn.example.com/photo.jpg", relativePath: "remote://photo" });

try {
  {
    const h = harness();
    const first = hlsItem();
    const second = hlsItem("two");
    await h.ready([first, second]);
    const oldNode = h.context.currentViewerNode;
    h.runtime.play();
    check(!oldNode.paused, "runtime Play reaches the canonical HLS video");
    h.runtime.next();
    await flush();
    check(h.instances.length === 2 && h.instances[0].destroyCalls === 1, "Next destroys the previous HLS instance exactly once");
    check(oldNode.paused && oldNode.src === "", "Next silences and releases the outgoing video source");
    h.runtime.previous();
    await flush();
    check(h.instances.length === 3 && h.instances[1].destroyCalls === 1, "Previous destroys the outgoing HLS instance");
    check(h.runtime.getCurrentItem() === first && h.context.currentViewerItem === first, "Previous retains canonical runtime selection");
    const active = h.instances[2];
    h.context.clearBtn.emit("click");
    check(active.destroyCalls === 1 && h.context.currentViewerNode === null, "actual Clear Media callback destroys HLS and clears the viewer");
    check(!h.runtime.getState().hasItems && !h.runtime.getState().isPlaying, "Clear Media clears canonical runtime playback");
    h.close();
  }
  {
    const h = harness();
    const first = hlsItem();
    const image = imageItem();
    await h.ready([first, image, mp4Item()]);
    h.runtime.play();
    const oldNode = h.context.currentViewerNode;
    const oldEngine = h.instances[0];
    h.runtime.next();
    check(h.context.currentViewerNode.tagName === "IMG" && h.context.currentViewerNode.src === image.url, "HLS to image uses the existing image pathway");
    check(oldEngine.destroyCalls === 1 && oldNode.paused && oldNode.src === "", "HLS to image releases streaming resources and audible playback");
    oldNode.emit("ended");
    check(h.runtime.getCurrentItem() === image, "a late HLS ended event cannot advance an image");
    oldEngine.fire(h.FakeHls.Events.ERROR, { fatal: true, details: "manifestLoadError", type: "networkError" });
    check(h.context.viewerEmpty.classList.contains("hidden"), "late HLS errors cannot replace the new image with an error state");
    h.runtime.next();
    check(h.context.currentViewerNode.tagName === "VIDEO" && h.context.currentViewerNode.src.endsWith("ordinary.mp4"), "ordinary MP4 still uses a direct video source");
    check(h.instances.length === 1, "image and ordinary MP4 create no extra HLS engine");
    h.close();
  }
  {
    const h = harness();
    await h.ready([hlsItem(), mp4Item()]);
    const outgoing = h.instances[0];
    h.runtime.next();
    check(outgoing.destroyCalls === 1 && h.context.currentViewerNode.src.endsWith("ordinary.mp4"), "direct HLS to MP4 tears down HLS before direct playback");
    h.close();
  }
  {
    let resolveModule;
    const pendingModule = new Promise((resolve) => { resolveModule = resolve; });
    const h = harness({ loadHls: () => pendingModule });
    await h.ready([hlsItem()]);
    h.runtime.play();
    const staleVideo = h.context.currentViewerNode;
    check(staleVideo.playCalls === 0, "runtime re-emits do not play an empty HLS source while its module loads");
    await h.context.loadRemoteSession("https://cdn.example.com/replacement.mp4", { name: "New Floppy.txt" });
    const replacementVideo = h.context.currentViewerNode;
    check(replacementVideo !== staleVideo && replacementVideo.src.endsWith("replacement.mp4"), "actual Floppy replacement loads through the canonical direct-video viewer");
    resolveModule(h.FakeHls);
    await flush();
    check(h.instances.length === 0, "Floppy replacement cancels a stale lazy HLS module before engine construction");
    check(staleVideo.paused && staleVideo.src === "" && h.context.currentViewerNode === replacementVideo, "late module completion cannot revive or replace stale playback");
    check(h.context.remoteStatusText.textContent.includes("1 videos"), "recognized media is retained in Floppy load diagnostics");
    h.close();
  }
  {
    const h = harness();
    await h.ready([hlsItem(), mp4Item()]);
    const video = h.context.currentViewerNode;
    video.currentTime = 17;
    video.muted = false;
    video.volume = 0.4;
    h.context.fillModeActive = true;
    h.context.togglePlay();
    check(h.runtime.getState().isPlaying && !video.paused, "Presentation Play uses runtime and the existing video");
    h.context.togglePlay();
    check(!h.runtime.getState().isPlaying && video.paused, "Presentation Pause stops the existing video through runtime");
    h.runtime.toggleFavorite();
    check(h.context.currentViewerNode === video && h.instances.length === 1, "Play/Pause and Favorite re-renders retain one player and one HLS engine");
    check(video.currentTime === 17 && !video.muted && video.volume === 0.4, "same-item re-renders preserve position, mute and volume");
    check(h.runtime.getCurrentItem().isFavorite, "HLS favorites still flow through canonical profile stamping");
    h.context.videoLoopInput.checked = true;
    h.context.activeLoopRule = { type: "times", totalPlays: 2 };
    h.context.applyLoopRuleToCurrentVideo();
    h.context.togglePlay();
    video.emit("ended");
    check(h.runtime.getState().currentIndex === 0 && video.currentTime === 0 && !video.paused, "Presentation finite loop restarts HLS through the canonical video");
    video.emit("ended");
    check(h.runtime.getState().currentIndex === 1 && !h.context.videoLoopInput.checked, "finite loop completion advances runtime once and clears the loop");
    video.emit("ended");
    check(h.runtime.getState().currentIndex === 1, "stale ended cannot cause duplicate auto-advance after a loop completes");
    h.close();
  }
  {
    const h = harness();
    await h.ready([hlsItem()]);
    const video = h.context.currentViewerNode;
    video.playError = Object.assign(new Error("test"), { name: "NotAllowedError" });
    h.runtime.play();
    await flush();
    const status = h.context.viewerStage.querySelector(".hls-playback-status");
    check(status.textContent.includes("Autoplay was blocked") && !status.classList.contains("hidden"), "autoplay rejection displays an actionable status beside the same video");
    check(h.runtime.getState().isPlaying && h.instances.length === 1, "autoplay rejection retains runtime intent without creating another engine");
    h.instances[0].fire(h.FakeHls.Events.MANIFEST_PARSED);
    check(status.textContent.includes("Autoplay was blocked") && !status.classList.contains("hidden"), "a later manifest-ready event preserves the actionable autoplay-blocked status");
    delete video.playError;
    await video.play();
    video.emit("playing");
    check(status.classList.contains("hidden"), "successful manual playback clears the autoplay status");
    check(!("hlsAutoplayBlocked" in video.dataset), "actual playing clears the autoplay-blocked flag");
    h.instances[0].fire(h.FakeHls.Events.ERROR, { fatal: true, type: "networkError", details: "manifestLoadError", response: { code: 403 } });
    check(!h.runtime.getState().isPlaying && h.runtime.getState().total === 1, "fatal HLS failure stops runtime while retaining the recognized media item");
    check(h.context.currentViewerItem === h.runtime.getCurrentItem() && h.context.viewerEmpty.textContent.includes("HTTP 403"), "fatal error retains canonical selection and exposes the provider rejection");
    check(h.instances[0].destroyCalls === 1 && video.paused && video.src === "", "fatal failure destroys streaming work and silences the canonical video");
    check(!h.context.viewerEmpty.textContent.includes("token="), "error UI does not expose a signed URL");
    h.close();
  }
  {
    const h = harness();
    const file = new Blob(["synthetic TS routing fixture"], { type: "video/mp2t" });
    const tsItem = { id: "ts", name: "local.TS", kind: "video", type: "video/mp2t", file, url: "blob:provider-ts", relativePath: "local.TS" };
    await h.ready([tsItem, hlsItem()]);
    const video = h.context.currentViewerNode;
    const objectUrl = video.src;
    check(h.tsCalls.attach.length === 1 && h.tsCalls.attach[0][0] === video && h.tsCalls.attach[0][1] === file, "local MPEG-TS still attaches its File to the canonical video through the original TS adapter");
    check(objectUrl.startsWith("blob:") && h.instances.length === 0, "the actual TS unsupported-MSE fallback remains reachable without HLS interception");
    check((await fetch(objectUrl)).ok, "TS fallback owns a usable object URL before navigation");
    const detachCount = h.tsCalls.detach;
    h.runtime.next();
    await flush();
    check(h.tsCalls.detach > detachCount && video.paused && video.src === "", "navigation preserves unconditional TS detach and outgoing-video cleanup");
    let revoked = false;
    try { await fetch(objectUrl); } catch { revoked = true; }
    check(revoked, "the original TS adapter revokes its object URL on navigation");
    check(h.instances.length === 1, "TS to HLS selects the new adapter for the next item only");
    h.close();
  }
  {
    const h = harness();
    const before = h.nodes.length;
    const thumbs = Array.from({ length: 60 }, (_, index) => {
      const thumb = new FakeNode("div");
      thumb._galleryItem = hlsItem(`thumb-${index}`);
      h.context.mountThumbMedia(thumb);
      h.context.mountThumbMedia(thumb);
      return thumb;
    });
    check(h.nodes.length - before === 60 && h.nodes.every((node) => node.tagName !== "VIDEO"), "sixty HLS thumbnails create only one neutral placeholder each and no video nodes");
    check(h.instances.length === 0 && h.nodes.every((node) => !node.src), "HLS thumbnails start no HLS engines or media-source requests");
    check(thumbs.every((thumb) => thumb.dataset.mounted === "true" && thumb.firstChild.attributes.get("aria-label").includes(thumb._galleryItem.name)), "HLS placeholders preserve mounted state and accessible filenames");
    const normalThumb = new FakeNode("div");
    normalThumb._galleryItem = mp4Item();
    h.context.mountThumbMedia(normalThumb);
    check(normalThumb.firstChild.tagName === "VIDEO" && normalThumb.firstChild.src === normalThumb._galleryItem.url && normalThumb.firstChild.preload === "metadata", "ordinary-video thumbnails retain their existing metadata pathway");
    const imageThumb = new FakeNode("div");
    imageThumb._galleryItem = imageItem();
    h.context.mountThumbMedia(imageThumb);
    check(imageThumb.firstChild.tagName === "IMG" && imageThumb.firstChild.src === imageThumb._galleryItem.url, "image thumbnails retain their existing pathway");
    h.close();
  }
  {
    const h = harness();
    await h.ready([hlsItem()]);
    h.runtime.play();
    const video = h.context.currentViewerNode;
    h.page("pagehide");
    check(h.instances[0].destroyCalls === 1 && video.paused && h.context.currentViewerNode === null, "actual pagehide handler destroys HLS and clears the audible player");
    check(!h.runtime.getState().isPlaying && h.runtime.getState().total === 1, "pagehide preserves the session with canonical playback paused");
    h.page("pageshow", { persisted: true });
    await flush();
    check(h.instances.length === 2 && h.context.currentViewerNode !== video && h.context.currentViewerNode.paused, "back-forward cache restoration rebuilds the canonical HLS viewer paused");
    h.page("beforeunload");
    check(h.instances[1].destroyCalls === 1 && h.context.currentViewerNode === null, "actual unload handler releases restored HLS resources");
    check(h.context.provider.disposed > 0 && h.context.fsaProvider.disposed > 0, "unload preserves existing local-provider disposal");
    h.close();
  }
  check(fakeTimers.size === 0, "integration tests leave no runtime or loop timers behind");
  console.log(`HLS viewer integration: ${assertions} assertions passed (DOM/MSE stand-ins; not live playback proof)`);
} finally {
  if (previousWindow === undefined) delete globalThis.window;
  else globalThis.window = previousWindow;
}
