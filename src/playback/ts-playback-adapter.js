// [TS-POC] Experimental MPEG-TS playback adapter.
//
// This branch's only question: can Browser Gallery locally read a
// complete H.264/AAC .ts file and play it through the EXISTING <video>
// element fast enough for Presentation Mode? Everything here exists to
// answer that, and nothing else — it is intentionally isolated from the
// rest of the app:
//
//   File (.ts, complete MPEG-TS container)
//        |
//        v
//   mux.js transmuxer  (MPEG-TS -> fragmented MP4, video/audio unchanged)
//        |
//        v
//   MediaSource + SourceBuffer
//        |
//        v
//   the SAME <video> element main.js already creates in buildViewer()
//
// main.js only ever calls attach()/detach() on this module. It does not
// need to know how transmuxing works, and this module does not touch
// Gallery/Runtime/ProfileStore/tagging/favorites/PM-toolbar state at all
// — the existing <video> element is the entire integration surface, so
// every consumer of that element (loop rules, "ended" handling, the PM
// toolbar, etc.) keeps working unmodified.
//
// Requires window.muxjs (loaded via a <script> tag in index.html — see
// that file for the CDN URL/version) and MediaSource Extensions support.
// If either is missing, attach() falls back to a plain `video.src =` set
// so the item at least attempts native playback instead of staying blank.

const CHUNK_SIZE = 1024 * 1024; // 1MB — small enough to yield between
// pushes so a large file doesn't block the main thread in one go, large
// enough that the transmuxer isn't constantly restarting its own internal
// segment boundaries.

// A broadly-compatible default codec string for H.264 (Main/High profile
// entry points, most real-world encodes fall under this) + AAC-LC. A
// production implementation would derive the exact profile/level from the
// parsed SPS instead of assuming one — that's out of scope for what this
// PoC needs to answer (see docs' roadmap entry for this branch).
const DEFAULT_MP4_MIME = 'video/mp4; codecs="avc1.64001f, mp4a.40.2"';

function nextTick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export class TsPlaybackAdapter {
  #videoEl = null;
  #mediaSource = null;
  #sourceBuffer = null;
  #transmuxer = null;
  #objectUrl = null;
  #token = 0;
  #pendingAppends = [];
  #appending = false;
  #initSegmentAppended = false;
  #transmuxDone = false;
  #onTiming = () => {};

  static isSupported() {
    return (
      typeof window !== "undefined" &&
      typeof window.MediaSource === "function" &&
      typeof window.muxjs !== "undefined" &&
      typeof window.muxjs.mp4 !== "undefined" &&
      typeof window.muxjs.mp4.Transmuxer === "function"
    );
  }

  /**
   * Attaches a .ts File to an existing <video> element, replacing
   * whatever this adapter instance was previously doing (detach() runs
   * first, unconditionally — see its own comment for why that's safe to
   * call even when nothing is attached).
   *
   * options.onTiming(label, elapsedMs) is called for each diagnostic
   * checkpoint (Phase 5): "adapter-start", "mediasource-open",
   * "first-media-appended", "canplay", "playing" — plus a few
   * best-effort error labels. main.js owns the actual log line/format
   * and any anonymization of which item this was.
   */
  attach(videoEl, file, { onTiming } = {}) {
    this.detach();

    this.#token += 1;
    const token = this.#token;
    this.#videoEl = videoEl;
    this.#onTiming = typeof onTiming === "function" ? onTiming : () => {};

    const t0 = performance.now();
    this.#onTiming("adapter-start", 0);

    if (!TsPlaybackAdapter.isSupported()) {
      this.#onTiming("unsupported-fallback-native-src", performance.now() - t0);
      videoEl.src = URL.createObjectURL(file);
      this.#objectUrl = videoEl.src;
      return token;
    }

    videoEl.addEventListener(
      "canplay",
      () => {
        if (token !== this.#token) return;
        this.#onTiming("canplay", performance.now() - t0);
      },
      { once: true }
    );
    videoEl.addEventListener(
      "playing",
      () => {
        if (token !== this.#token) return;
        this.#onTiming("playing", performance.now() - t0);
      },
      { once: true }
    );

    this.#mediaSource = new MediaSource();
    this.#objectUrl = URL.createObjectURL(this.#mediaSource);
    videoEl.src = this.#objectUrl;

    this.#mediaSource.addEventListener(
      "sourceopen",
      () => {
        if (token !== this.#token) return; // superseded before MSE was ready
        this.#onTiming("mediasource-open", performance.now() - t0);
        this.#startTransmux(file, token, t0);
      },
      { once: true }
    );

    return token;
  }

  /**
   * Tears down whatever this adapter instance is currently doing:
   * invalidates the token (so any in-flight transmux/append callback from
   * a superseded attach() becomes a silent no-op instead of feeding stale
   * data into a new video), aborts a mid-update SourceBuffer, releases
   * the MediaSource, and revokes the object URL. Safe — and cheap — to
   * call even when nothing is attached, which is why main.js's
   * clearViewerNode() calls it unconditionally on every item change
   * rather than only for items it knows were .ts.
   */
  detach() {
    this.#token += 1;

    if (this.#sourceBuffer) {
      try {
        if (this.#sourceBuffer.updating) this.#sourceBuffer.abort();
      } catch (error) {
        // MediaSource may already be closed — nothing left to clean up.
      }
      this.#sourceBuffer = null;
    }

    if (this.#mediaSource) {
      try {
        if (this.#mediaSource.readyState === "open") {
          this.#mediaSource.endOfStream();
        }
      } catch (error) {
        // Best-effort only; a half-open MediaSource being discarded is fine.
      }
      this.#mediaSource = null;
    }

    if (this.#objectUrl) {
      URL.revokeObjectURL(this.#objectUrl);
      this.#objectUrl = null;
    }

    this.#transmuxer = null;
    this.#pendingAppends = [];
    this.#appending = false;
    this.#initSegmentAppended = false;
    this.#transmuxDone = false;
    this.#videoEl = null;
    this.#onTiming = () => {};
  }

  async #startTransmux(file, token, t0) {
    this.#transmuxer = new window.muxjs.mp4.Transmuxer();

    this.#transmuxer.on("data", (segment) => {
      if (token !== this.#token) return; // a newer item superseded this one
      this.#handleSegment(segment, token, t0);
    });

    this.#transmuxer.on("done", () => {
      if (token !== this.#token) return;
      this.#transmuxDone = true;
      this.#maybeEndOfStream();
    });

    let buffer;
    try {
      buffer = await file.arrayBuffer();
    } catch (error) {
      if (token === this.#token) {
        this.#onTiming("read-error", performance.now() - t0);
      }
      return;
    }

    if (token !== this.#token) return; // cancelled while the read was in flight

    const bytes = new Uint8Array(buffer);
    for (let offset = 0; offset < bytes.byteLength; offset += CHUNK_SIZE) {
      if (token !== this.#token) return; // cancelled mid-push
      this.#transmuxer.push(bytes.subarray(offset, offset + CHUNK_SIZE));
      if (offset + CHUNK_SIZE < bytes.byteLength) await nextTick();
    }

    if (token !== this.#token) return;
    this.#transmuxer.flush();
  }

  #handleSegment(segment, token, t0) {
    if (!this.#sourceBuffer && !this.#createSourceBuffer(token, t0)) return;

    if (segment.initSegment && !this.#initSegmentAppended) {
      this.#pendingAppends.push(segment.initSegment);
    }
    if (segment.data && segment.data.byteLength) {
      this.#pendingAppends.push(segment.data);
    }

    this.#pumpAppendQueue(token, t0);
  }

  #createSourceBuffer(token, t0) {
    if (!window.MediaSource.isTypeSupported(DEFAULT_MP4_MIME)) {
      this.#onTiming("unsupported-codec", performance.now() - t0);
      return false;
    }

    this.#sourceBuffer = this.#mediaSource.addSourceBuffer(DEFAULT_MP4_MIME);
    this.#sourceBuffer.addEventListener("updateend", () => {
      // `token` here is the value CAPTURED when this SourceBuffer/listener
      // was created, not a live read of `this.#token` — otherwise this
      // staleness check would always trivially pass against itself.
      if (token !== this.#token) return;
      this.#appending = false;
      this.#pumpAppendQueue(token, t0);
      this.#maybeEndOfStream();
    });

    return true;
  }

  #pumpAppendQueue(token, t0) {
    if (token !== this.#token) return;
    if (this.#appending) return;
    if (!this.#sourceBuffer || this.#sourceBuffer.updating) return;

    const next = this.#pendingAppends.shift();
    if (!next) return;

    this.#appending = true;
    try {
      this.#sourceBuffer.appendBuffer(next);
      if (!this.#initSegmentAppended) {
        this.#initSegmentAppended = true;
        this.#onTiming("first-media-appended", performance.now() - t0);
      }
    } catch (error) {
      this.#appending = false;
      if (token === this.#token) {
        this.#onTiming("append-error", performance.now() - t0);
      }
    }
  }

  #maybeEndOfStream() {
    if (!this.#transmuxDone) return;
    if (this.#appending || this.#pendingAppends.length) return;
    if (!this.#mediaSource || this.#mediaSource.readyState !== "open") return;

    try {
      this.#mediaSource.endOfStream();
    } catch (error) {
      // Best-effort — a superseded/closed MediaSource is fine to skip.
    }
  }
}
