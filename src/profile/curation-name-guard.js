// [CURATION-IMPORT / STAGE-D / CREATE + RENAME NAME-COLLISION GUARD]
//
// Shared by manual Curation creation (Feature 5) and front-facing Rename
// (Feature 6): both need to ask "does a Curation already display this name?"
// and, if the customer creates/keeps a duplicate anyway, propose the next
// free "Name (2)" / "Name (3)" — the familiar filesystem convention — rather
// than silently colliding. This is a presentation-time collision WARNING
// only: choosing to proceed with a duplicate name never merges or aliases
// any Curation identity. Two Curations may legitimately share a display name
// forever (see curation-display.js, which is what disambiguates them
// wherever they're later listed).
//
// Name equivalence is the same trim + case-insensitive rule used everywhere
// else in this amendment (see name-equivalence.js).

import { namesMatch } from "./name-equivalence.js";

/**
 * Existing Curations that already display `name`, excluding `excludingId`
 * (pass the Curation being renamed so it doesn't collide with itself).
 *
 * @param {string} name
 * @param {Array<{id: string, name: string}>} curations
 * @param {string|null} excludingId
 */
export function findCurationNameCollisions(name, curations = [], excludingId = null) {
  return curations.filter((curation) => curation.id !== excludingId && namesMatch(curation.name, name));
}

/**
 * The next free "<name> (n)" that collides with nothing in `existingNames`,
 * starting at (2). `existingNames` should be every OTHER Curation's display
 * name (the one being created/renamed is not yet among them).
 */
export function suggestNextCurationName(name, existingNames = []) {
  const base = typeof name === "string" ? name.trim() : "";
  if (!base) return base;

  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base} (${suffix})`;
    if (!existingNames.some((existing) => namesMatch(existing, candidate))) return candidate;
  }
  // Exhausting 998 numbered variants never happens in practice; fall back to
  // something guaranteed distinct rather than looping forever.
  return `${base} (${Date.now()})`;
}
