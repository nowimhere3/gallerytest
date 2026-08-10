// [FSA] File System Access API folder provider.
//
// Produces the SAME MediaItem shape as LocalFileInputProvider (id, name,
// path, relativePath, type, kind, size, lastModified, file, url,
// mediaType, systemTags, userTags) so nothing downstream — MediaRuntime,
// ProfileStore, Gallery rendering, the TS playback adapter, filtering —
// needs to know or care which folder-access mechanism produced a given
// item. This is deliberately an ADDITIONAL source, not a replacement for
// the proven webkitdirectory path in local-file-input-provider.js, which
// is untouched.
//
// isSupportedFile/getKind are imported (not reimplemented) from that same
// module, so a .ts file (or any other file type) is classified identically
// regardless of which picker the user used.
import { isSupportedFile, getKind } from "./local-file-input-provider.js";

const DEFAULT_BATCH_SIZE = 250;

function nextFrame() {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => resolve());
    } else {
      setTimeout(resolve, 0);
    }
  });
}

export class FsaFileProvider {
  #items = [];
  #activeUrls = [];
  #loadToken = 0;

  /**
   * Recursively walks a FileSystemDirectoryHandle and turns every
   * supported file inside it into a MediaItem, batched/yielded the same
   * way loadFromFileList is.
   *
   * Returns { items, diagnostics, incomplete, fatalError }:
   *   - items: everything successfully discovered and processed, even if
   *     the traversal did not fully complete (see `incomplete`) — callers
   *     MUST check `incomplete` themselves rather than assuming a returned
   *     item list is the complete folder. This function never claims
   *     success on a partial scan; it only reports what happened.
   *   - diagnostics: { dirsVisited, filesSeen, filesSkipped, errors: [{path,
   *     error}] } — errors accumulates NON-fatal per-file/per-directory
   *     problems (e.g. one unreadable file) that traversal continued past;
   *     a genuinely fatal iterator failure is reported via `fatalError`
   *     instead, since that one stops the whole scan.
   *   - incomplete: true if the scan did not finish normally (fatal
   *     iterator error, or superseded by a newer load/dispose call).
   *   - fatalError: the error that stopped traversal early, or null.
   *
   * options: batchSize, onProgress(loadedCount, totalSoFar), onBatch.
   * (onProgress's second argument is "found so far," not a known final
   * total — the total isn't knowable until the whole tree is walked.)
   */
  async loadFromDirectoryHandle(rootHandle, options = {}) {
    this.dispose();
    const token = this.#loadToken;

    const { batchSize = DEFAULT_BATCH_SIZE, onProgress, onBatch } = options;

    const diagnostics = { dirsVisited: 0, filesSeen: 0, filesSkipped: 0, errors: [] };
    const discovered = []; // { file, relativePath }

    let fatalError = null;
    try {
      await this.#walk(rootHandle, "", discovered, diagnostics, token);
    } catch (error) {
      fatalError = error;
      console.error(
        "[FSA] Folder traversal stopped early due to an error. Results below are incomplete.",
        error,
        diagnostics
      );
    }

    if (token !== this.#loadToken) {
      // Superseded by a newer load (or dispose/Clear Media) while walking.
      // Explicitly incomplete — never reported as a successful full load.
      return { items: [], diagnostics, incomplete: true, fatalError: null };
    }

    const supported = discovered.filter(({ file }) => isSupportedFile(file));
    diagnostics.filesSeen = discovered.length;
    diagnostics.filesSkipped += discovered.length - supported.length;

    const total = supported.length;
    const items = [];

    for (let start = 0; start < total; start += batchSize) {
      if (token !== this.#loadToken) {
        return { items: [...this.#items], diagnostics, incomplete: true, fatalError: null };
      }

      const batchEntries = supported.slice(start, start + batchSize);

      const batchItems = batchEntries.map((entry, offset) => {
        const index = start + offset;
        const { file, relativePath } = entry;
        const objectUrl = URL.createObjectURL(file);
        const kind = getKind(file);

        this.#activeUrls.push(objectUrl);

        return {
          id: `fsa-${index}-${file.name}-${file.lastModified}`,
          name: file.name,
          path: relativePath,
          relativePath,
          type: file.type,
          kind,
          size: file.size,
          lastModified: file.lastModified,
          file,
          url: objectUrl,
          mediaType: kind,
          systemTags: [kind],
          userTags: [],
        };
      });

      items.push(...batchItems);
      this.#items = items;

      if (onProgress) onProgress(items.length, total);
      if (onBatch) onBatch(batchItems, [...items]);

      const isLastBatch = start + batchSize >= total;
      if (!isLastBatch) await nextFrame();
    }

    return { items: [...this.#items], diagnostics, incomplete: Boolean(fatalError), fatalError };
  }

  // Depth-first recursive walk. `relativePrefix` is the path built so far,
  // NOT including the root folder's own name — this matches
  // computeRelativePath() in local-file-input-provider.js, which strips
  // the picked folder's name from webkitRelativePath. Keeping both
  // providers' relative-path semantics identical is what lets
  // Profile/Favorites/Hidden/Tags (keyed by relativePath) keep working
  // the same way regardless of which picker was used.
  //
  // Any error thrown by the directory iterator itself (not a per-entry
  // problem) propagates up rather than being swallowed — per the
  // reliability requirement, an interrupted scan must never look like a
  // complete one. Per-file problems (e.g. one file's getFile() rejecting)
  // are recorded in diagnostics.errors and traversal continues.
  async #walk(dirHandle, relativePrefix, out, diagnostics, token) {
    if (token !== this.#loadToken) return;
    diagnostics.dirsVisited += 1;

    for await (const [name, handle] of dirHandle.entries()) {
      if (token !== this.#loadToken) return; // cancelled mid-directory

      const entryPath = relativePrefix ? `${relativePrefix}/${name}` : name;

      if (handle.kind === "directory") {
        await this.#walk(handle, entryPath, out, diagnostics, token);
        continue;
      }

      if (handle.kind !== "file") continue; // defensive: unknown handle kind

      try {
        const file = await handle.getFile();
        if (token !== this.#loadToken) return; // cancelled while reading this file
        out.push({ file, relativePath: entryPath });
      } catch (error) {
        // One unreadable file (permission hiccup, deleted mid-scan, etc.)
        // does not abort the whole folder scan — recorded, not silent.
        diagnostics.errors.push({ path: entryPath, error: String(error && error.message ? error.message : error) });
      }
    }
  }

  getItems() {
    return [...this.#items];
  }

  dispose() {
    this.#loadToken += 1;

    for (const url of this.#activeUrls) {
      URL.revokeObjectURL(url);
    }

    this.#activeUrls = [];
    this.#items = [];
  }
}
