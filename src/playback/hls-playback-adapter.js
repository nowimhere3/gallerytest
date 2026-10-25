// HLS feeds the same video element owned by the viewer/runtime. This adapter
// selects a source and owns its resources; it never starts playback or advances
// the gallery. The pinned, same-origin module also works under a Pages subpath.
const loadBundledHls = async () => (await import("../../vendor/hls/hls.mjs")).default;

function describeHlsError(data = {}) {
  const detail = String(data.details || "");
  const status = Number(data.response?.code || data.networkDetails?.status || 0);
  const resource = /manifest|level|audioTrack/i.test(detail) ? "playlist" : /frag/i.test(detail) ? "media segment" : /key/i.test(detail) ? "encryption key" : "stream";

  if (status === 401 || status === 403) {
    return { code: "access-denied", message: `The provider rejected the HLS ${resource} (HTTP ${status}). A signed URL may have expired or require authorization; obtain a fresh permitted link if needed.` };
  }
  if (status === 410) {
    return { code: "link-unavailable", message: `The HLS ${resource} is no longer available (HTTP 410). If the link expired, obtain a fresh permitted URL; retrying cannot renew it.` };
  }
  if (/incompatibleCodecs|addCodec/i.test(detail)) {
    return { code: "unsupported-codec", message: "This browser cannot play the codecs in this HLS stream." };
  }
  if (data.type === "keySystemError") {
    return { code: "protected-stream", message: "This HLS stream requires protected playback or authorization that is unavailable here." };
  }
  if (/LoadError|LoadTimeOut|LoadTimeout/i.test(detail) || data.type === "networkError") {
    const code = /manifest|level|audioTrack/i.test(detail) ? "manifest-load-failed" : /frag/i.test(detail) ? "segment-load-failed" : "network-error";
    const reason = status > 0
      ? `HTTP ${status}.`
      : "The browser did not expose an HTTP status; CORS denial, network failure, or provider access restrictions may be responsible.";
    return { code, message: `Cannot load the HLS ${resource}. ${reason}` };
  }
  if (/manifest|level/i.test(detail)) {
    return { code: "manifest-invalid", message: "The HLS playlist could not be read or contains no playable media." };
  }
  if (/frag|buffer|decode/i.test(detail) || data.type === "mediaError" || data.type === "muxError") {
    return { code: "media-error", message: "The HLS media could not be decoded. Its codec or media segments may be unsupported or damaged." };
  }
  return { code: "playback-failed", message: "HLS playback failed. The stream may be unavailable or unsupported by this browser." };
}

export class HlsPlaybackAdapter {
  #loadHls;
  #video = null;
  #hls = null;
  #listeners = [];
  #token = 0;

  // Injection keeps pathway, error and cancellation tests independent of MSE.
  constructor({ loadHls = loadBundledHls } = {}) {
    this.#loadHls = loadHls;
  }

  async attach(video, url, { onStatus = () => {}, onError = () => {} } = {}) {
    this.detach();
    const token = this.#token;
    this.#video = video;
    const current = () => token === this.#token;
    const status = (code, message) => {
      if (current()) onStatus({ code, message });
    };
    const fail = (error) => {
      if (!current()) return;
      // Never pass hls.js data, browser error text, or the source URL to UI/logs:
      // each may contain credentials or a complete signed CDN URL.
      this.detach();
      onError({ ...error, fatal: true });
    };
    const listen = (event, listener) => {
      video.addEventListener(event, listener);
      this.#listeners.push([event, listener]);
    };

    status("loading", "Loading HLS stream…");
    listen("playing", () => status("playing", ""));

    if (video.canPlayType?.("application/vnd.apple.mpegurl") || video.canPlayType?.("application/x-mpegURL")) {
      listen("error", () => {
        const code = video.error?.code;
        if (code === 1) return; // explicit abort/navigation is not a failure
        fail(code === 3
          ? { code: "media-error", message: "The browser could not decode this HLS stream. Its codec or media segments may be unsupported or damaged." }
          : code === 4
            ? { code: "unsupported-source", message: "Native HLS could not play this source. Its codec may be unsupported, or the provider may have denied access." }
            : { code: "network-error", message: "Native HLS could not load the stream. The browser cannot distinguish a network failure, CORS denial, or an expired or rejected link here." });
      });
      video.src = url;
      status("native", "Loading HLS with native browser support…");
      return "native";
    }

    let Hls;
    try {
      Hls = await this.#loadHls();
    } catch {
      fail({ code: "dependency-unavailable", message: "The bundled HLS playback engine could not be loaded. Reload the application and check that its files are available." });
      return null;
    }
    if (!current()) return null;
    let supported = false;
    try { supported = Boolean(Hls?.isSupported?.()); } catch { /* unavailable MSE capability check */ }
    if (!supported) {
      fail({ code: "unsupported-browser", message: "HLS playback is unavailable in this browser. Native HLS or MediaSource support with compatible codecs is required." });
      return null;
    }

    try {
      // ESM builds require a separate worker asset. Keep V1 same-origin and
      // self-contained; hls.js transmuxes on the main thread. No URL logging.
      const hls = new Hls({ debug: false, enableWorker: false, backBufferLength: 30 });
      this.#hls = hls;
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (current() && data?.fatal) fail(describeHlsError(data));
      });
      hls.on(Hls.Events.MANIFEST_PARSED, () => status("ready", ""));
      hls.attachMedia(video);
      if (!current()) return null;
      hls.loadSource(url);
    } catch {
      fail({ code: "initialization-failed", message: "The HLS engine could not attach this stream to the video player." });
      return null;
    }
    if (!current()) return null;
    status("hlsjs", "Loading HLS with the streaming engine…");
    return "hlsjs";
  }

  detach() {
    this.#token += 1; // cancel an unresolved module import and all old callbacks
    const video = this.#video;
    this.#video = null;
    if (video) {
      for (const [event, listener] of this.#listeners) video.removeEventListener(event, listener);
    }
    this.#listeners = [];
    const hls = this.#hls;
    this.#hls = null;
    // Stop audible playback before destroying MSE/aborting network requests.
    if (video) {
      try { video.pause(); } catch { /* already discarded */ }
    }
    if (hls) {
      try { hls.destroy(); } catch { /* teardown remains best effort */ }
    }
    if (video) {
      try {
        video.removeAttribute("src");
        video.load();
      } catch { /* already discarded */ }
    }
  }
}
