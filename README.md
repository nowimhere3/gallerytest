# Local Media Gallery

A small static browser app for loading **local** images and videos, viewing them in a gallery, and running a basic slideshow.

## What it does

- Load local media directly from your computer
- Supports:
  - selecting multiple files
  - selecting a folder in browsers that support `webkitdirectory`
- Shows a gallery grid of images/videos
- Lets you click an item to view it larger
- Provides slideshow controls:
  - start
  - stop
  - next
  - previous
  - adjustable interval
  - shuffle toggle
- Uses browser object URLs, so files stay local and are not uploaded anywhere

## What it does **not** do

This is intentionally a small v1:

- no backend
- no uploads
- no editing
- no persistence across reloads
- no reconnect-to-folder flow
- no Stream Loop panel embedding yet

## Architecture

This app is split into three light layers:

- `src/providers/local-file-input-provider.js`
  - turns browser-selected `File` objects into gallery items
  - creates and later revokes object URLs
- `src/runtime/media-runtime.js`
  - owns collection state
  - owns current item
  - owns slideshow timer
  - handles next/previous/shuffle
- `src/main.js`
  - wires DOM events to the runtime
  - renders the viewer and gallery UI

This keeps the core slideshow logic separate from the file-loading mechanism, so the app can later grow toward other providers or alternate presentation modes.

## How to run locally

Because this uses ES modules, serve it with a small static server instead of opening the HTML file directly.

### Python

```bash
python -m http.server 8080
```

Then open:

```text
http://localhost:8080
```

### Node

If you have a static server installed, for example:

```bash
npx serve .
```

## How to host it statically

You can host this on any static host:

- GitHub Pages
- Netlify
- Vercel
- Cloudflare Pages

Since there is no backend, hosting just means serving the files as a normal static site.

## Slideshow behavior

Current behavior in v1:

- Images advance on the selected interval
- Videos are shown in the slideshow and begin playback when they become the active viewer item
- The slideshow still advances by the timer interval, not by waiting for a video to finish
- Videos are muted by default in the main viewer to reduce autoplay issues in browsers

That means short intervals may cut videos off before they finish. This is acceptable for v1 and can be improved later.

## Browser notes

### Choose Files
Works broadly in modern browsers.

### Choose Folder
Uses `webkitdirectory`, which is supported in Chromium-based browsers and some others, but not universally in the same way everywhere.

If folder picking is unavailable or awkward in your browser, use **Choose Files** instead.

## Limitations

- Only formats the browser can natively decode will actually display/play
- Some unusual codecs or RAW image formats may not render even if selected
- No persistence on refresh
- No multi-panel “fill panel” mode yet
- No drag-and-drop yet

## Next likely improvements

- drag-and-drop file loading
- better video slideshow rules
- folder/session persistence
- panel-fill presentation mode
- multiple independent viewers/slideshows on one page
