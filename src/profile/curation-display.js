// [SYNCV3 / STAGE-10 / CURATION-CHOICE-LABELS]
//
// Pure presentation for Curation choice lists (the Curation switcher, the
// Media Library association picker, and any future picker that lets a
// customer choose between Curations). No DOM, no storage, no ProfileStore —
// and no mutation of the records handed in.
//
// BREADCRUMBS - WAS: Curation choices displayed only their human-readable
//   names. Two distinct V3 identities (Profiles) that happened to share a
//   name — e.g. two Curations both named "BEAST" — were therefore visually
//   indistinguishable everywhere a picker listed them.
// BREADCRUMBS - IS: human-readable names remain clean by default. When two
//   or more Curations in the SAME choice list share a display name, only
//   those colliding entries receive an eight-character durable-identity
//   suffix, via `shortDisplayId` — the same short-id convention Sync V3
//   already uses for filesystem disambiguation (sync-v3-names.js). Unique
//   names are never touched, and the stored Curation name is never read.
// BREADCRUMBS - WILL BE: future Curation selection surfaces should call
//   `displayCurationLabel` too, rather than re-deriving their own
//   duplicate-name check or permanently exposing internal identity
//   plumbing.
//
// The label is presentation only. Selection is always keyed by `id`; nothing
// here is written back, and two Curations may legitimately share a name.

import { shortDisplayId } from "./sync-v3-names.js";

function displayName(curation) {
  const name = typeof curation?.name === "string" ? curation.name.trim() : "";
  return name || "Unnamed Curation";
}

/**
 * The choice-list label for one Curation: its name alone when that name is
 * unique among `relevantCurations`, or `<name> — <short id>` when one or
 * more other entries in the same list share it.
 *
 * @param {{id: string, name: string}} curation
 * @param {Array<{id: string, name: string}>} relevantCurations the full set
 *   of Curations being presented alongside `curation` in this choice list
 */
export function displayCurationLabel(curation, relevantCurations = []) {
  const name = displayName(curation);
  const list = Array.isArray(relevantCurations) ? relevantCurations : [];
  const collisions = list.reduce((total, entry) => (displayName(entry) === name ? total + 1 : total), 0);
  if (collisions <= 1) return name;
  return `${name} — ${shortDisplayId(curation?.id)}`;
}
