import { HlsPlaybackAdapter } from "../src/playback/hls-playback-adapter.js";

let assertions = 0;
function assert(condition, label) {
  if (!condition) throw new Error(label);
  assertions += 1;
}

class Video extends EventTarget {
  src = "";
  pauses = 0;
  loads = 0;
  plays = 0;
  muted = true;
  volume = 0.4;
  loop = true;
  constructor(native = false) { super(); this.native = native; }
  canPlayType() { return this.native ? "probably" : ""; }
  pause() { this.pauses += 1; }
  play() { this.plays += 1; }
  load() { this.loads += 1; }
  removeAttribute(key) { if (key === "src") this.src = ""; }
}

class Hls {
  static Events = { ERROR: "error", MANIFEST_PARSED: "manifest" };
  static instances = [];
  static isSupported() { return true; }
  listeners = new Map();
  destroys = 0;
  constructor(options) { this.options = options; Hls.instances.push(this); }
  on(name, listener) { this.listeners.set(name, listener); }
  emit(name, data) { this.listeners.get(name)?.(name, data); }
  attachMedia(video) { this.video = video; video.src = "blob:synthetic-hls"; }
  loadSource(url) { this.url = url; }
  destroy() { this.destroys += 1; }
}

const signed = "https://example.test/video.m3u8?token=synthetic-test-secret&expires=123456";
let imports = 0;
const native = new Video(true);
const errors = [];
const statuses = [];
const adapter = new HlsPlaybackAdapter({ loadHls: async () => { imports += 1; return Hls; } });
assert(await adapter.attach(native, signed, { onError: (e) => errors.push(e), onStatus: (s) => statuses.push(s) }) === "native", "native HLS is selected first");
assert(imports === 0 && Hls.instances.length === 0, "native HLS does not load or instantiate hls.js");
assert(native.src === signed, "native HLS preserves the exact signed URL");
assert(native.plays === 0, "adapter leaves playback authority with the viewer/runtime");
assert(native.volume === 0.4 && native.muted && native.loop, "adapter preserves volume, mute and loop");
native.dispatchEvent(new Event("playing"));
assert(statuses.at(-1).code === "playing", "native playing clears loading state");
adapter.detach();
assert(native.pauses === 1 && native.loads === 1 && native.src === "", "native detach pauses and unloads the old source");
const count = statuses.length;
native.dispatchEvent(new Event("playing"));
native.dispatchEvent(new Event("error"));
assert(statuses.length === count && errors.length === 0, "native detach removes listeners");
adapter.detach();
assert(native.pauses === 1, "detach is idempotent");

const mse = new Video();
assert(await adapter.attach(mse, signed, { onError: (e) => errors.push(e), onStatus: (s) => statuses.push(s) }) === "hlsjs", "hls.js is selected where native HLS is unavailable");
const first = Hls.instances.at(-1);
assert(first.video === mse && first.url === signed, "hls.js uses the canonical video and untouched signed URL");
assert(first.options.debug === false && first.options.enableWorker === false, "engine disables URL logging and external worker loading");
first.emit(Hls.Events.MANIFEST_PARSED);
assert(statuses.at(-1).code === "ready", "manifest parsed exposes ready state without starting playback");
assert(mse.plays === 0, "hls.js pathway never calls play");

const nextVideo = new Video();
await adapter.attach(nextVideo, "https://example.test/next.m3u8", { onStatus: (s) => statuses.push(s) });
assert(first.destroys === 1 && mse.pauses === 1 && mse.src === "", "replacement destroys and unloads the previous HLS engine");
const statusCount = statuses.length;
first.emit(Hls.Events.MANIFEST_PARSED);
first.emit(Hls.Events.ERROR, { fatal: true, details: "manifestLoadError" });
assert(statuses.length === statusCount && errors.length === 0, "callbacks from replaced HLS cannot control new media");
const second = Hls.instances.at(-1);
adapter.detach();
assert(second.destroys === 1 && nextVideo.pauses === 1 && nextVideo.src === "", "detach destroys hls.js and stops audio before image/MP4/session replacement");
nextVideo.src = "https://example.test/direct.mp4";
adapter.detach();
assert(nextVideo.src.endsWith("direct.mp4"), "later detach cannot clear a new ordinary-video source");

const unsupportedErrors = [];
const unsupported = new HlsPlaybackAdapter({ loadHls: async () => ({ isSupported: () => false }) });
assert(await unsupported.attach(new Video(), signed, { onError: (e) => unsupportedErrors.push(e) }) === null, "unsupported browser returns no playback pathway");
assert(unsupportedErrors[0].code === "unsupported-browser" && unsupportedErrors[0].fatal, "unsupported browser has an honest fatal error");

const dependencyErrors = [];
const unavailable = new HlsPlaybackAdapter({ loadHls: async () => { throw new Error(signed); } });
await unavailable.attach(new Video(), signed, { onError: (e) => dependencyErrors.push(e) });
assert(dependencyErrors[0].code === "dependency-unavailable", "missing dependency fails gracefully");
assert(!JSON.stringify(dependencyErrors).includes("synthetic-test-secret"), "dependency errors redact underlying signed URL text");

let resolveImport;
const delayed = new HlsPlaybackAdapter({ loadHls: () => new Promise((resolve) => { resolveImport = resolve; }) });
const retired = new Video();
const staleErrors = [];
const pending = delayed.attach(retired, signed, { onError: (e) => staleErrors.push(e) });
const previousCount = Hls.instances.length;
delayed.detach();
retired.src = "https://example.test/new.mp4";
resolveImport(Hls);
assert(await pending === null, "retired lazy import resolves as cancelled");
assert(Hls.instances.length === previousCount && retired.src.endsWith("new.mp4"), "retired import creates no engine or stale source");
assert(staleErrors.length === 0, "retired import cancellation reports no spurious error");

let rejectImport;
const rejected = new HlsPlaybackAdapter({ loadHls: () => new Promise((_resolve, reject) => { rejectImport = reject; }) });
const rejectedPending = rejected.attach(new Video(), signed, { onError: (e) => staleErrors.push(e) });
rejected.detach();
rejectImport(new Error(signed));
await rejectedPending;
assert(staleErrors.length === 0, "retired import rejection is silent");

for (const [data, expected, phrase] of [
  [{ type: "networkError", details: "manifestLoadError", response: { code: 404 } }, "manifest-load-failed", "HTTP 404"],
  [{ type: "networkError", details: "fragLoadError", response: { code: 503 } }, "segment-load-failed", "HTTP 503"],
  [{ type: "networkError", details: "manifestLoadError", response: { code: 0 } }, "manifest-load-failed", "CORS denial"],
  [{ type: "networkError", details: "fragLoadError", response: { code: 403 } }, "access-denied", "may have expired"],
  [{ type: "networkError", details: "manifestLoadError", response: { code: 401 } }, "access-denied", "HTTP 401"],
  [{ type: "networkError", details: "manifestLoadError", response: { code: 410 } }, "link-unavailable", "retrying cannot renew"],
  [{ type: "mediaError", details: "manifestIncompatibleCodecsError" }, "unsupported-codec", "codecs"],
  [{ type: "mediaError", details: "bufferAddCodecError" }, "unsupported-codec", "codecs"],
  [{ type: "mediaError", details: "fragParsingError" }, "media-error", "decoded"],
  [{ type: "networkError", details: "manifestParsingError" }, "manifest-load-failed", "playlist"],
  [{ type: "keySystemError", details: "keySystemNoAccess" }, "protected-stream", "protected"],
]) {
  const reports = [];
  const video = new Video();
  await adapter.attach(video, signed, { onError: (e) => reports.push(e) });
  const engine = Hls.instances.at(-1);
  engine.emit(Hls.Events.ERROR, { ...data, fatal: false, url: signed, reason: signed });
  assert(reports.length === 0 && engine.destroys === 0, `${expected}: recoverable hls.js event is left to engine retry policy`);
  engine.emit(Hls.Events.ERROR, { ...data, fatal: true, url: signed, reason: signed });
  assert(reports[0].code === expected && reports[0].message.includes(phrase), `${expected}: distinct sanitized error`);
  assert(engine.destroys === 1 && video.pauses === 1 && video.src === "", `${expected}: fatal error stops streaming and audio`);
  assert(!JSON.stringify(reports).includes("synthetic-test-secret"), `${expected}: error does not expose the signed URL`);
  engine.emit(Hls.Events.ERROR, { ...data, fatal: true });
  assert(reports.length === 1, `${expected}: stale duplicate fatal event is ignored`);
}

for (const [mediaCode, expected] of [[2, "network-error"], [3, "media-error"], [4, "unsupported-source"]]) {
  const reports = [];
  const video = new Video(true);
  await adapter.attach(video, signed, { onError: (e) => reports.push(e) });
  video.error = { code: mediaCode, message: signed };
  video.dispatchEvent(new Event("error"));
  assert(reports[0].code === expected && !JSON.stringify(reports).includes("synthetic-test-secret"), "native media error is classified without exposing browser error text");
  assert(video.pauses === 1 && video.src === "", "native fatal error unloads source");
}

console.log(`HLS playback adapter: ${assertions} assertions passed (mocked integration, not live playback proof)`);
