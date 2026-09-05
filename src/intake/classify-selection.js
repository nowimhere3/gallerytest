/*
BREADCRUMBS - WAS

Media intake controls were hard-wired directly to source-specific owners, so
the UI had to know which mechanism would process a selection.

BREADCRUMBS - IS

Selection classification is a pure source-routing decision made before
existing loaders take ownership.

BREADCRUMBS - WILL BE

Future intake UI may collapse around user intent and selection shape while
existing backend owners remain separate.
*/

export function classifySelection(evidence) {
  const shape = evidence?.shape;
  const entries = Array.isArray(evidence?.entries) ? evidence.entries : [];

  if (shape !== "files" && shape !== "folder") return "unsupported";

  let supportedMedia = 0;
  let qualifyingFloppies = 0;

  for (const entry of entries) {
    if (entry?.isSupportedMedia === true) supportedMedia += 1;
    if (entry?.qualifiesAsFloppy === true) qualifyingFloppies += 1;
  }

  if (supportedMedia > 0 && qualifyingFloppies > 0) return "mixed";

  if (shape === "folder") {
    if (supportedMedia > 0) return "local-folder";
    if (qualifyingFloppies > 0) return "floppy-folder";
    return "unsupported";
  }

  if (supportedMedia > 0) return "local-files";
  if (qualifyingFloppies === 1) return "floppy-file";
  return "unsupported";
}
