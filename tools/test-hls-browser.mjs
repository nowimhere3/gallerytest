// Optional real-browser verification. No browser packages are installed in the app.
// HLS_BROWSER_REQUIRED=1 PLAYWRIGHT_MODULE_PATH=/path/to/playwright/index.mjs \
//   HLS_BROWSER_LIVE=1 node tools/test-hls-browser.mjs
// Public playback uses the Mux sample linked by the official hls.js basic demo.
// It travels directly from the provider to the browser (no proxy or CORS bypass).
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

let playwright;
try {
  playwright = await import(process.env.PLAYWRIGHT_MODULE_PATH
    ? pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE_PATH)).href : "playwright");
} catch (error) {
  if (process.env.HLS_BROWSER_REQUIRED === "1") throw error;
  console.log("HLS browser: SKIP (install Playwright externally or set PLAYWRIGHT_MODULE_PATH; require with HLS_BROWSER_REQUIRED=1)");
  process.exit(0);
}

let browser;
try {
  browser = await playwright.chromium.launch({ headless: true, args: ["--no-sandbox"] });
} catch (error) {
  if (process.env.HLS_BROWSER_REQUIRED === "1") throw error;
  console.log("HLS browser: SKIP (Chromium unavailable; require with HLS_BROWSER_REQUIRED=1)");
  process.exit(0);
}

const root = resolve(import.meta.dirname, "..");
const fixtures = new Map();
const requests = [];
const timers = new Set();
let firstSyntheticManifest = true;
const mimeTypes = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".png": "image/png" };
const server = createServer(async (request, response) => {
  let pathname = new URL(request.url, "http://localhost").pathname;
  if (pathname.startsWith("/gallerytest/")) pathname = pathname.slice("/gallerytest".length);
  if (pathname.startsWith("/__hls_test__/")) {
    requests.push(pathname);
    if (pathname.endsWith("denied.m3u8")) {
      response.writeHead(403).end("Synthetic rejected URL");
      return;
    }
    if (pathname.endsWith("slow.m3u8")) {
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (!response.destroyed) response.writeHead(404).end();
      }, 30000);
      timer.unref();
      timers.add(timer);
      return;
    }
    const fixture = fixtures.get(pathname);
    if (!fixture) { response.writeHead(404).end(); return; }
    if (pathname.endsWith("synthetic.m3u8") && firstSyntheticManifest) {
      firstSyntheticManifest = false;
      await new Promise(resolveDelay => setTimeout(resolveDelay, 250));
      if (response.destroyed) return;
    }
    response.writeHead(200, { "content-type": fixture.type, "content-length": fixture.body.length });
    response.end(fixture.body);
    return;
  }
  const target = resolve(root, `.${decodeURIComponent(pathname === "/" ? "/index.html" : pathname)}`);
  if (!target.startsWith(root + sep)) { response.writeHead(403).end(); return; }
  try {
    const body = await readFile(target);
    response.writeHead(200, { "content-type": mimeTypes[extname(target)] || "application/octet-stream" });
    response.end(body);
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
const origin = `http://127.0.0.1:${server.address().port}`;
const url = name => `${origin}/__hls_test__/${name}`;
const evidence = { browser: browser.version(), assertions: 0, publicPlayback: "NOT REQUESTED" };
const check = (condition, message) => { assert(condition, message); evidence.assertions++; };
const fixture = (name, type, body) => fixtures.set(`/__hls_test__/${name}`, { type, body: Buffer.from(body) });

async function floppy(page, lines) {
  await page.locator("#file-input").setInputFiles({ name: "hls-v1-test.txt", mimeType: "text/plain", buffer: Buffer.from(lines.join("\n")) });
  await page.waitForFunction(expected => {
    const names = [...document.querySelectorAll(".gallery-name")].map(node => node.textContent);
    return JSON.stringify(names) === JSON.stringify(expected) && document.querySelector("#remote-status-text").textContent.includes("ready");
  }, lines.map(line => decodeURIComponent(new URL(line).pathname.split("/").pop())));
}
async function pick(page, name) {
  await page.locator(".gallery-card").filter({ has: page.locator(".gallery-name", { hasText: name }) }).first().click();
}
async function rememberVideo(page) {
  await page.evaluate(() => { window.__retiredVideo = document.querySelector("#viewer-stage video"); });
}
async function retiredIsReleased(page, label) {
  const state = await page.evaluate(() => ({ exists: Boolean(window.__retiredVideo), paused: window.__retiredVideo?.paused, hasSource: window.__retiredVideo?.hasAttribute("src"), connected: window.__retiredVideo?.isConnected }));
  check(state.exists && state.paused && !state.hasSource && !state.connected, `${label}: ${JSON.stringify(state)}`);
}
async function decoded(page, timeout = 30000) {
  await page.waitForFunction(() => {
    const video = document.querySelector("#viewer-stage video");
    return video && video.currentTime > 0.2 && video.videoWidth > 0 && video.getVideoPlaybackQuality().totalVideoFrames > 0;
  }, null, { timeout });
  return page.locator("#viewer-stage video").evaluate(video => ({ time: video.currentTime, width: video.videoWidth, height: video.videoHeight, frames: video.getVideoPlaybackQuality().totalVideoFrames }));
}

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  // Explicitly exercise the real hls.js/MSE branch even on newer Chromium builds
  // advertising native HLS. This is a capability override, not a mocked engine.
  await context.addInitScript(() => {
    Math.random = () => 0; // deterministic initial gallery selection
    const original = HTMLMediaElement.prototype.canPlayType;
    HTMLMediaElement.prototype.canPlayType = function(type) {
      return /mpegurl/i.test(type) ? "" : original.call(this, type);
    };
  });
  const page = await context.newPage();
  await page.goto(origin);
  await page.waitForFunction(() => !document.querySelector("#file-input").disabled);
  await page.locator("#shuffle-input").evaluate(input => {
    input.checked = false; input.dispatchEvent(new Event("change", { bubbles: true }));
  });

  // Browser-generated H.264 fMP4 provides repeatable decoded-frame proof without
  // bundling a copyrighted clip or relying on a remote network for regressions.
  const mp4 = Buffer.from(await page.evaluate(async () => {
    const canvas = document.createElement("canvas"); canvas.width = 160; canvas.height = 90;
    const context2d = canvas.getContext("2d");
    const stream = canvas.captureStream(12);
    const recorder = new MediaRecorder(stream, { mimeType: "video/mp4;codecs=avc1.42E01E" });
    const chunks = [];
    recorder.ondataavailable = event => chunks.push(event.data);
    const done = new Promise(resolveStop => recorder.onstop = resolveStop);
    const timer = setInterval(() => {
      context2d.fillStyle = `hsl(${Date.now() % 360} 90% 45%)`; context2d.fillRect(0, 0, 160, 90);
      context2d.fillStyle = "white"; context2d.fillText("HLS V1 test", 25, 45);
    }, 80);
    recorder.start();
    await new Promise(resolveWait => setTimeout(resolveWait, 2000));
    recorder.stop(); await done; clearInterval(timer); stream.getTracks().forEach(track => track.stop());
    return Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer()));
  }));
  let mediaOffset = -1;
  for (let offset = 0; offset + 8 <= mp4.length;) {
    const length = mp4.readUInt32BE(offset);
    if (mp4.toString("ascii", offset + 4, offset + 8) === "moof") { mediaOffset = offset; break; }
    assert(length >= 8, "valid generated MP4 boxes"); offset += length;
  }
  assert(mediaOffset > 0, "MediaRecorder generated fragmented MP4");
  fixture("init.mp4", "video/mp4", mp4.subarray(0, mediaOffset));
  fixture("clip.m4s", "video/mp4", mp4.subarray(mediaOffset));
  fixture("ordinary.mp4", "video/mp4", mp4);
  fixture("still.png", "image/png", Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1sAAAAASUVORK5CYII=", "base64"));
  fixture("synthetic.m3u8", "application/vnd.apple.mpegurl", "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:3\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:2.0,\nclip.m4s\n#EXT-X-ENDLIST\n");

  await page.evaluate(async () => {
    const { default: Hls } = await import(new URL("vendor/hls/hls.mjs", document.baseURI).href);
    window.__hlsDestroyed = 0;
    const destroy = Hls.prototype.destroy;
    Hls.prototype.destroy = function(...args) { window.__hlsDestroyed++; return destroy.apply(this, args); };
  });
  const lines = [url("still.png"), url("synthetic.m3u8"), url("ordinary.mp4"), url("denied.m3u8"), url("slow.m3u8"), ...Array.from({ length: 30 }, (_, index) => url(`thumb-${index}.m3u8`))];
  await floppy(page, lines);
  await pick(page, "still.png");
  check(!requests.some(path => /thumb-\d+\.m3u8/.test(path)), "HLS thumbnails initiate no streaming");
  check(await page.locator(".gallery-thumb video").count() <= 1, "only the ordinary-video thumbnail has a video element");
  await pick(page, "synthetic.m3u8");
  await page.waitForFunction(() => document.querySelector("#viewer-stage video")?.dataset.hlsState === "ready");
  await page.locator("#viewer-stage video").evaluate(video => {
    window.__originalVideoPlay = video.play;
    video.play = () => Promise.reject(new DOMException("Synthetic autoplay denial", "NotAllowedError"));
  });
  await page.locator("#play-btn").click();
  await page.waitForFunction(() => document.querySelector(".hls-playback-status")?.textContent.includes("Autoplay was blocked"));
  await page.waitForFunction(() => document.querySelector("#viewer-stage video")?.readyState >= 1);
  check((await page.locator(".hls-playback-status").textContent()).includes("Autoplay was blocked"), "autoplay guidance survives later manifest and metadata readiness");
  await page.locator("#viewer-stage video").evaluate(video => { video.play = window.__originalVideoPlay; });
  await page.locator("#play-btn").click();
  await page.locator("#play-btn").click();
  evidence.syntheticPlayback = await decoded(page);
  check(evidence.syntheticPlayback.frames > 0, "real bundled hls.js decodes synthetic HLS through canonical player");
  await page.locator("#play-btn").click();
  check(await page.locator("#viewer-stage video").evaluate(video => video.paused), "canonical Pause pauses HLS");
  await rememberVideo(page);
  await page.locator("#next-btn").click();
  await retiredIsReleased(page, "Next releases HLS video source and pauses it");
  check((await page.evaluate(() => window.__hlsDestroyed)) >= 1, "Next destroys the hls.js instance");
  check(await page.locator("#viewer-stage video").evaluate(video => video.src.endsWith("ordinary.mp4")), "HLS to MP4 retains direct-video path");
  await page.locator("#play-btn").click();
  evidence.mp4Playback = await decoded(page);
  await page.locator("#play-btn").click();
  await page.locator("#prev-btn").click();
  await rememberVideo(page);
  await page.locator("#prev-btn").click();
  await retiredIsReleased(page, "Previous HLS to image releases the previous video");
  check(await page.locator("#viewer-stage img").count() === 1, "image pathway survives HLS");
  await pick(page, "synthetic.m3u8");
  await page.waitForFunction(() => document.querySelector("#viewer-stage video")?.dataset.hlsState === "ready");
  await page.locator("#viewer-stage video").evaluate(video => { video.volume = 0.35; video.muted = false; });
  const beforeFavorite = await page.evaluate(() => window.__hlsDestroyed);
  await page.locator("#favorite-btn").click();
  check(await page.evaluate(() => window.__hlsDestroyed) === beforeFavorite, "Favorite state re-emit retains HLS instance");
  await rememberVideo(page);
  await page.locator("#fill-panel-btn").click();
  check(await page.evaluate(() => document.querySelector("#viewer-stage video") === window.__retiredVideo), "Presentation Mode retains canonical HLS video");
  check(await page.locator("#viewer-stage video").evaluate(video => video.volume === 0.35 && !video.muted), "Presentation Mode retains canonical mute and volume values");
  await page.locator("#overlay-play-btn").click();
  check(await page.locator("#viewer-stage video").evaluate(video => video.paused), "Presentation Pause controls canonical HLS video");
  await page.locator("#video-loop-input").evaluate(input => {
    input.checked = true; input.dispatchEvent(new Event("change", { bubbles: true }));
    window.__hlsNaturalEnds = 0;
    document.querySelector("#viewer-stage video").addEventListener("ended", () => window.__hlsNaturalEnds++);
  });
  await page.locator("#overlay-play-btn").click();
  await page.waitForFunction(() => window.__hlsNaturalEnds > 0);
  check(await page.evaluate(() => document.querySelector("#viewer-stage video") === window.__retiredVideo), "Presentation Loop replays natural HLS end on same canonical video");
  await page.locator("#video-loop-input").evaluate(input => {
    input.checked = false; input.dispatchEvent(new Event("change", { bubbles: true }));
    const video = document.querySelector("#viewer-stage video"); video.currentTime = video.duration - 0.05;
  });
  await page.waitForFunction(() => document.querySelector("#viewer-stage video")?.src.endsWith("ordinary.mp4"));
  await retiredIsReleased(page, "natural HLS end advances to MP4 through existing runtime");
  await page.locator("#overlay-prev-btn").click();
  await rememberVideo(page);
  await page.locator("#overlay-next-btn").click();
  await retiredIsReleased(page, "Presentation Next releases HLS");
  await page.keyboard.press("Escape");
  await pick(page, "slow.m3u8");
  await rememberVideo(page);
  await floppy(page, [url("still.png")]);
  await retiredIsReleased(page, "Floppy replacement releases pending HLS");
  check(await page.locator("#viewer-stage img").count() === 1, "replacement session displays image");
  await page.evaluate(() => window.__retiredVideo.dispatchEvent(new Event("ended")));
  check(await page.locator("#viewer-stage img").count() === 1, "stale ended event cannot advance replacement session");
  await floppy(page, [url("denied.m3u8")]);
  await page.waitForFunction(() => document.querySelector("#viewer-stage video")?.dataset.hlsState === "error");
  check((await page.locator("#viewer-empty").textContent()).includes("403"), "rejected signed URL produces honest access error");
  check((await page.locator("#gallery-count").textContent()).includes("1"), "recognized HLS remains in Gallery after playback failure");
  await floppy(page, [url("synthetic.m3u8")]);
  await page.locator("#play-btn").click();
  await decoded(page);
  await rememberVideo(page);
  await page.locator("#clear-btn").evaluate(button => button.click());
  await retiredIsReleased(page, "Clear Media releases HLS");
  check(await page.locator("#viewer-stage video").count() === 0, "Clear Media removes canonical video");
  await floppy(page, [url("slow.m3u8")]);
  await rememberVideo(page);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide")));
  await retiredIsReleased(page, "pagehide releases pending HLS");
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
  check(await page.locator("#viewer-stage video").count() === 1, "cached page restore rebuilds one canonical viewer");
  check(await page.locator("#viewer-stage video").evaluate(video => video.paused), "cached page restore retains paused runtime intent");
  await page.locator("#clear-btn").evaluate(button => button.click());
  const subpathPage = await context.newPage();
  await subpathPage.goto(`${origin}/gallerytest/`);
  await floppy(subpathPage, [url("synthetic.m3u8")]);
  await subpathPage.locator("#play-btn").click();
  evidence.projectSubpathPlayback = await decoded(subpathPage);
  check(evidence.projectSubpathPlayback.frames > 0, "same-origin dependency loads and decodes under GitHub Pages project subpath");
  await subpathPage.close();

  if (process.env.HLS_BROWSER_LIVE === "1") {
    const publicUrl = "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8";
    let firstTsResponse;
    page.on("response", response => {
      if (!firstTsResponse && response.ok() && new URL(response.url()).pathname.endsWith(".ts")) {
        firstTsResponse = response.body();
      }
    });
    await floppy(page, [publicUrl]);
    await page.locator("#play-btn").click();
    evidence.publicPlayback = await decoded(page, 60000);
    check(evidence.publicPlayback.frames > 0, "public remote sample decodes directly through bundled hls.js");
    await page.screenshot({ path: process.env.HLS_BROWSER_SCREENSHOT || "/tmp/gallery-hls-public-playback.png" });
    check(await page.evaluate(() => typeof window.muxjs?.mp4?.Transmuxer === "function"), "existing mux.js dependency is available for local TS regression");
    assert(firstTsResponse, "public HLS sample supplied an MPEG-TS media segment");
    await page.locator("#file-input").setInputFiles({ name: "public-test-segment.ts", mimeType: "video/mp2t", buffer: await firstTsResponse });
    await page.waitForFunction(() => document.querySelector(".gallery-name")?.textContent === "public-test-segment.ts");
    await page.locator("#play-btn").click();
    evidence.localTsPlayback = await decoded(page);
    check(evidence.localTsPlayback.frames > 0, "existing local TS adapter still decodes through canonical player");
    await rememberVideo(page);
    await floppy(page, [url("still.png")]);
    await retiredIsReleased(page, "local TS to image retains adapter teardown");
    const nativeContext = await browser.newContext();
    const nativePage = await nativeContext.newPage();
    await nativePage.goto(origin);
    const supported = await nativePage.evaluate(() => Boolean(document.createElement("video").canPlayType("application/vnd.apple.mpegurl")));
    if (supported) {
      await floppy(nativePage, [publicUrl]);
      await nativePage.locator("#play-btn").click();
      evidence.nativePlayback = await decoded(nativePage, 60000);
      check(evidence.nativePlayback.frames > 0, "public remote sample decodes through native HLS pathway");
    } else evidence.nativePlayback = "UNSUPPORTED in this browser";
    await nativeContext.close();
  }
  await context.close();
  console.log(`HLS browser: PASS ${JSON.stringify(evidence)}`);
} finally {
  await browser.close();
  for (const timer of timers) clearTimeout(timer);
  server.closeAllConnections();
  await new Promise(resolveClose => server.close(resolveClose));
}
