/*
BREADCRUMBS - WAS

Browser Gallery's local providers produced media records from File objects,
minted object URLs, and owned revocation of those URLs. The repository did not
have a provider whose playable addresses originated externally.

BREADCRUMBS - IS

RemoteUrlProvider solely turns validated remote URLs into Browser Gallery-
compatible media records. It mints no object URLs, so dispose() drops items
without revoking remote HTTP(S) addresses. Downstream runtime code does not
branch on source. Classification uses pathname extensions only; this provider
does no fetch, probe, MIME inference, retry, persistence, or rendering.

BREADCRUMBS - WILL BE

Remote .ts input stays skipped until Phase 1C can make rendering safe. size and
lastModified stay absent so duplicate filtering fails open without reliable
metadata. relativePath is temporary transport identity, not durable remote
identity. Phase 1B leaves currentSourceKind as "none" and accepts the temporary
"No Media Folder loaded." copy debt. If remote items later use blob/object URLs,
disposal ownership and revocation must be revisited. Richer discovery remains
upstream of this provider and must not infect Browser Gallery runtime policy.
*/

const DEFAULT_BATCH_SIZE = 250;
const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "gif"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "mov", "m4v"]);

function nextFrame() {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => resolve());
    } else {
      setTimeout(resolve, 0);
    }
  });
}

function inspectRemoteUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const encodedName = parsed.pathname.split("/").at(-1) || parsed.hostname;
  let name = encodedName;
  try {
    name = decodeURIComponent(encodedName);
  } catch {
    // Display the original pathname segment when percent-decoding is invalid.
  }

  const dot = encodedName.lastIndexOf(".");
  const extension = dot === -1 ? "" : encodedName.slice(dot + 1).toLowerCase();
  const kind = IMAGE_EXTENSIONS.has(extension)
    ? "image"
    : VIDEO_EXTENSIONS.has(extension)
      ? "video"
      : null;

  return { kind, name };
}

export class RemoteUrlProvider {
  #items = [];
  #loadToken = 0;

  async loadFromUrls(urls, options = {}) {
    this.dispose();
    const token = this.#loadToken;
    const { batchSize = DEFAULT_BATCH_SIZE, onProgress, onBatch } = options;
    const inputUrls = Array.from(urls || []);
    const diagnostics = {
      total: inputUrls.length,
      images: 0,
      videos: 0,
      skipped: 0,
    };
    const items = [];

    for (let start = 0; start < inputUrls.length; start += batchSize) {
      if (token !== this.#loadToken) {
        return { items: [...this.#items], diagnostics };
      }

      const batchItems = [];
      const batchUrls = inputUrls.slice(start, start + batchSize);

      for (let offset = 0; offset < batchUrls.length; offset += 1) {
        const url = batchUrls[offset];
        const inspected = inspectRemoteUrl(url);
        if (!inspected?.kind) {
          diagnostics.skipped += 1;
          continue;
        }

        const index = start + offset;
        const { kind, name } = inspected;
        diagnostics[kind === "image" ? "images" : "videos"] += 1;
        batchItems.push({
          id: `remote-${index}`,
          name,
          path: name,
          relativePath: `remote://${url}`,
          type: "",
          kind,
          url,
          mediaType: kind,
          systemTags: [kind],
          userTags: [],
        });
      }

      items.push(...batchItems);
      this.#items = items;

      const processed = Math.min(start + batchUrls.length, inputUrls.length);
      if (onProgress) onProgress(processed, inputUrls.length);
      if (onBatch) onBatch(batchItems, [...items]);

      if (processed < inputUrls.length) await nextFrame();
    }

    return { items: [...this.#items], diagnostics };
  }

  getItems() {
    return [...this.#items];
  }

  dispose() {
    this.#loadToken += 1;
    this.#items = [];
  }
}
