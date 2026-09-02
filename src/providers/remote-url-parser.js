/*
BREADCRUMBS - WAS

Browser Gallery's existing media source paths produced local File/Blob-backed
media records. The repository had no source-boundary parser for
newline-delimited remote URL text.

BREADCRUMBS - IS

This module is a pure source-boundary parser: text becomes validated URL
strings. It owns no application state, touches no DOM, creates no MediaItems,
renders and loads nothing, and knows nothing about gallery-dl, Presentation
Mode, or Browser Gallery runtime policy. Parsing and validation stop here; a
later provider owns URL[] to MediaItems.

BREADCRUMBS - WILL BE

Plain-text import remains independently useful as a diagnostic/import boundary
when richer discovery systems feed the same downstream provider architecture.
Integrated discovery must not require rewriting Browser Gallery's runtime.
Dirty-text URL extraction remains omitted until evidence requires it. Private-
network blocking remains omitted so controlled localhost testing stays
possible. Future expansion remains evidence-driven.
*/

function emptyResult() {
  return {
    urls: [],
    diagnostics: {
      totalLines: 0,
      blank: 0,
      rejected: 0,
      duplicates: 0,
    },
  };
}

export function extractRemoteUrls(text) {
  if (text == null || text === "") return emptyResult();

  const lines = String(text).split(/\r\n|\n|\r/);
  if (lines.at(-1) === "") lines.pop();

  const urls = [];
  const seen = new Set();
  const diagnostics = {
    totalLines: lines.length,
    blank: 0,
    rejected: 0,
    duplicates: 0,
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      diagnostics.blank += 1;
      continue;
    }

    let parsed;
    try {
      parsed = new URL(trimmed);
    } catch {
      diagnostics.rejected += 1;
      continue;
    }

    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username ||
      parsed.password
    ) {
      diagnostics.rejected += 1;
      continue;
    }

    if (seen.has(trimmed)) {
      diagnostics.duplicates += 1;
      continue;
    }

    seen.add(trimmed);
    urls.push(trimmed);
  }

  return { urls, diagnostics };
}
