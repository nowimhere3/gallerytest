// [CURATION-IMPORT / STAGE-B / IDENTITY-CLASSIFICATION]
//
// The IDENTIFY step of the Curate Import pipeline. Pure: given an imported
// package's identity metadata and the customer's existing Curations, decides
// which of three cases applies — see the amendment brief for the full
// customer-facing framing of each:
//
//   SAME_ID                  — another copy/export of a Curation that
//                               already exists locally. Not a decision; the
//                               destination is simply that Curation.
//   SAME_NAME_DIFFERENT_ID   — a genuinely different Curation that happens
//                               to display the same name as one or more
//                               existing Curations. A human decision: bring
//                               the import into one of those, or keep it
//                               separate. Never resolved automatically.
//   DIFFERENT                — no existing Curation shares this id or name.
//                               Ordinary new-Curation import.
//
// This module never creates a Curation, never merges data, and never aliases
// identities — it only classifies. Bringing an import "into" a
// SAME_NAME_DIFFERENT_ID destination is a data transfer for THIS import only
// (see curation-import-plan.js / curation-import-commit.js); it does not
// permanently declare the two Curation ids the same Curation. That would be
// distributed identity lineage, which is out of scope for this amendment —
// see the brief's CRITICAL DISTINCTION section.

import { namesMatch } from "./name-equivalence.js";

/**
 * @param {object} options
 * @param {string|null} options.importedProfileId
 * @param {string} options.importedProfileName
 * @param {Array<{id: string, name: string}>} options.curations existing local Curations
 * @returns {{ kind: "SAME_ID"|"SAME_NAME_DIFFERENT_ID"|"DIFFERENT", destinations: Array<{id: string, name: string}> }}
 */
export function classifyCurationImport({ importedProfileId, importedProfileName, curations = [] } = {}) {
  const list = Array.isArray(curations) ? curations : [];

  const sameId = importedProfileId ? list.find((curation) => curation.id === importedProfileId) : null;
  if (sameId) {
    return { kind: "SAME_ID", destinations: [sameId] };
  }

  const sameName = list.filter((curation) => namesMatch(curation.name, importedProfileName));
  if (sameName.length > 0) {
    return { kind: "SAME_NAME_DIFFERENT_ID", destinations: sameName };
  }

  return { kind: "DIFFERENT", destinations: [] };
}
