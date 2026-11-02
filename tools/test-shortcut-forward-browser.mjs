// S9B-A real-browser proof of the iframe focus boundary: with focus INSIDE the
// Gallery iframe, real keyboard input must reach the cross-origin parent as
// SHORTCUT_KEY messages (and Ctrl/typing variants must not).
//   PLAYWRIGHT_MODULE_PATH=/path/to/playwright/index.mjs node tools/test-shortcut-forward-browser.mjs
// Optional: SKIPs when Playwright/Chromium is unavailable unless SHORTCUT_BROWSER_REQUIRED=1.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const required = process.env.SHORTCUT_BROWSER_REQUIRED === "1";
let playwright;
try {
  playwright = await import(process.env.PLAYWRIGHT_MODULE_PATH
    ? pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE_PATH)).href : "playwright");
} catch (error) {
  if (required) throw error;
  console.log("Shortcut forward browser: SKIP (set PLAYWRIGHT_MODULE_PATH; require with SHORTCUT_BROWSER_REQUIRED=1)");
  process.exit(0);
}
const chromium = playwright.chromium ?? playwright.default?.chromium;
let browser;
try { browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] }); } catch (error) {
  if (required) throw error;
  console.log("Shortcut forward browser: SKIP (Chromium unavailable)");
  process.exit(0);
}

const root = resolve(import.meta.dirname, "..");
const mime = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".png": "image/png" };
const gallery = createServer(async (request, response) => {
  const pathname = new URL(request.url, "http://localhost").pathname;
  const target = resolve(root, `.${decodeURIComponent(pathname === "/" ? "/index.html" : pathname)}`);
  if (!target.startsWith(root + sep)) { response.writeHead(403).end(); return; }
  try {
    response.writeHead(200, { "content-type": mime[extname(target)] || "application/octet-stream" });
    response.end(await readFile(target));
  } catch { response.writeHead(404).end(); }
});
await new Promise((r) => gallery.listen(0, "127.0.0.1", r));
const galleryOrigin = `http://127.0.0.1:${gallery.address().port}`;

// The parent is a DIFFERENT origin (localhost vs 127.0.0.1) and records everything.
const parentHtml = (launch) => `<!doctype html><title>parent</title><iframe id="g" src="${galleryOrigin}/${launch}" width="1200" height="900"></iframe>
<script>
window.log = []; window.parentKeys = [];
window.addEventListener("message", (e) => { if (e.source === document.getElementById("g").contentWindow) window.log.push({ origin: e.origin, data: e.data }); });
document.addEventListener("keydown", (e) => window.parentKeys.push(e.code));
window.query = (generation) => document.getElementById("g").contentWindow.postMessage({ source: "gs3-capability-bridge", version: 1,
  type: "QUERY_CAPABILITY", capability: "GALLERY_FAVORITE", generation }, "${galleryOrigin}");
</script>`;
const parent = createServer((request, response) => { response.writeHead(200, { "content-type": "text/html" });
  response.end(parentHtml(new URL(request.url, "http://x").searchParams.get("launch") ? "?launch=streamloop" : "")); });
await new Promise((r) => parent.listen(0, "127.0.0.1", r));
const parentOrigin = `http://localhost:${parent.address().port}`;

let assertions = 0;
const check = (c, m) => { assert(c, m); assertions++; };
const shortcuts = (page) => page.evaluate(() => window.log.filter((m) => m.data?.type === "SHORTCUT_KEY"));
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

try {
  for (const launch of ["", "?launch=streamloop"]) {
    const context = await browser.newContext({ viewport: { width: 1300, height: 1000 } });
    const page = await context.newPage();
    await page.goto(`${parentOrigin}/${launch ? "?launch=1" : ""}`);
    const frame = page.frameLocator("#g");
    await frame.locator("#file-input").waitFor({ state: "attached", timeout: 30000 });
    const child = page.frames().find((f) => f.url().startsWith(galleryOrigin));
    check(child.url().includes("launch=streamloop") === Boolean(launch), `${launch || "normal"}: expected launch mode loaded (${child.url()})`);
    await child.waitForFunction(() => document.readyState === "complete");
    await settle(500);
    // Before any handshake: real keys inside the iframe forward nothing.
    await child.evaluate(() => { document.body.setAttribute("tabindex", "-1"); document.body.focus(); });
    await page.keyboard.press("KeyZ");
    await settle();
    check((await shortcuts(page)).length === 0, `${launch}: nothing before handshake`);

    await page.evaluate(() => window.query("browser-gen-1"));
    await page.waitForFunction(() => window.log.some((m) => m.data?.type === "CAPABILITY_PRESENT"));
    const present = await page.evaluate(() => window.log.find((m) => m.data?.type === "CAPABILITY_PRESENT"));
    check(JSON.stringify(present.data.features) === JSON.stringify(["favoriteCurrent", "favoriteState", "keyForward"]), `${launch}: features`);
    check(present.origin === galleryOrigin, "reply came from the gallery origin");

    // Focus INSIDE the iframe, then use real browser keyboard input.
    const hasFocusInChild = await child.evaluate(() => document.hasFocus() && document.activeElement === document.body);
    check(hasFocusInChild, `${launch}: focus is inside the Gallery iframe`);
    for (const [press, code] of [["1", "Digit1"], ["2", "Digit2"], ["3", "Digit3"], ["4", "Digit4"], ["z", "KeyZ"], ["x", "KeyX"], ["c", "KeyC"], ["v", "KeyV"], ["m", "KeyM"], [",", "Comma"], [".", "Period"], ["/", "Slash"]]) {
      const before = (await shortcuts(page)).length;
      await page.keyboard.press(press);
      await page.waitForFunction((n) => window.log.filter((m) => m.data?.type === "SHORTCUT_KEY").length === n + 1, before);
      const last = (await shortcuts(page)).at(-1);
      check(last.data.code === code && last.data.generation === "browser-gen-1" && last.data.type === "SHORTCUT_KEY", `${launch}: ${code}`);
      check(JSON.stringify(Object.keys(last.data).sort()) === JSON.stringify(["capability", "code", "generation", "source", "type", "version"]), "no extra fields");
    }
    check((await page.evaluate(() => window.parentKeys.length)) === 0, "iframe isolation: parent document saw no keydown (the S9A boundary)");
    // Exactly one message per press, and a Ctrl variant sends nothing.
    const count = (await shortcuts(page)).length;
    check(count === 12, `${launch}: exactly one message per press (${count})`);
    await page.keyboard.press("Control+z"); await page.keyboard.press("Control+Digit1"); await page.keyboard.press("Alt+x"); await page.keyboard.press("Shift+c");
    for (const combo of ["Control+m", "Control+,", "Control+.", "Control+/", "Alt+m", "Shift+m", "Meta+m"]) await page.keyboard.press(combo);
    await settle();
    check((await shortcuts(page)).length === count, `${launch}: modified keys not forwarded`);
    // Held key: only the first keydown (repeat=false) is forwarded.
    await page.keyboard.down("v"); await page.keyboard.down("v"); await page.keyboard.down("v"); await page.keyboard.up("v");
    await settle();
    check((await shortcuts(page)).length === count + 1, `${launch}: auto-repeat not forwarded`);
    // Typing in a real editable control inside Gallery is not forwarded.
    const typed = await child.evaluate(() => {
      const input = document.createElement("input"); input.type = "text"; input.id = "s9b-probe";
      const area = document.createElement("textarea"); area.id = "s9b-probe-area";
      const edit = document.createElement("div"); edit.id = "s9b-probe-edit"; edit.setAttribute("contenteditable", "true"); edit.tabIndex = 0;
      const role = document.createElement("div"); role.id = "s9b-probe-role"; role.setAttribute("role", "searchbox"); role.tabIndex = 0;
      document.body.append(input, area, edit, role); return true;
    });
    check(typed, "probes added");
    const after = (await shortcuts(page)).length;
    for (const id of ["s9b-probe", "s9b-probe-area", "s9b-probe-edit", "s9b-probe-role"]) {
      await child.evaluate((i) => document.getElementById(i).focus(), id);
      for (const k of ["z", "x", "c", "v", "1", "2", "3", "4", "m", ",", ".", "/"]) await page.keyboard.press(k);
    }
    await settle();
    check((await shortcuts(page)).length === after, `${launch}: typing in editable controls not forwarded`);
    check((await child.evaluate(() => document.getElementById("s9b-probe").value)) === "zxcv1234m,./", "input still receives ordinary typing");
    // A newer handshake replaces the generation for future keys.
    await child.evaluate(() => { document.activeElement.blur(); document.body.focus(); });
    await page.evaluate(() => window.query("browser-gen-2"));
    await page.waitForFunction(() => window.log.filter((m) => m.data?.type === "CAPABILITY_PRESENT").length === 2);
    await page.keyboard.press("x");
    await page.waitForFunction((n) => window.log.filter((m) => m.data?.type === "SHORTCUT_KEY").length === n + 1, after);
    const latest = (await shortcuts(page)).at(-1);
    check(latest.data.generation === "browser-gen-2" && latest.data.code === "KeyX", `${launch}: new generation used`);
    await context.close();
  }
  console.log(`PASS shortcut forward browser (${browser.version()}): ${assertions} assertions; real iframe-focused keys reach the cross-origin parent; modifiers/repeat/editable blocked`);
} finally {
  await browser.close();
  gallery.close(); parent.close();
}
process.exit(0);
