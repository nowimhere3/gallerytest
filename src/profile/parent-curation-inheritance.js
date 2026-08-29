// [NORTH-STAR / N3 / PROVEN-PARENT-INHERITANCE]
//
// Curation policy lives here, above MEDIA-ID. MEDIA-ID supplies durable local
// evidence (scope membership and proven prefixes); this module only reads that
// evidence and decides whether it licenses a one-time association write.

function normalizedPrefix(value) {
  if (typeof value !== "string" || !value) return "";
  return value.endsWith("/") ? value : `${value}/`;
}

function prefixDepth(value) {
  return normalizedPrefix(value).split("/").filter(Boolean).length;
}

function explicitProfileForLibrary(record, associations, knownProfileIds) {
  if (!record) return null;
  const known = knownProfileIds instanceof Set ? knownProfileIds : new Set(knownProfileIds || []);
  if (record.libraryId && Object.prototype.hasOwnProperty.call(associations, record.libraryId)) {
    const profileId = associations[record.libraryId]?.v ?? null;
    return profileId && known.has(profileId) ? profileId : null;
  }
  return record.profileId && known.has(record.profileId) ? record.profileId : null;
}

/**
 * Returns the nearest proven ancestor whose explicit Curation may be inherited,
 * or null when any N3 precondition is absent.
 *
 * Roots can share a scope only after MEDIA-ID proof (or a version-guarded
 * rebase of such proof). Prefix containment inside that scope is therefore
 * deterministic. No name, path guess, handle probe, or UNKNOWN result enters
 * this policy function.
 */
export function resolveProvenParentCuration({
  currentRootId,
  currentRoot,
  roots = [],
  libraries = [],
  associations = {},
  knownProfileIds = [],
} = {}) {
  if (!currentRootId || !currentRoot || currentRoot.rootId !== currentRootId || !currentRoot.scopeId) return null;

  const libraryById = new Map(libraries.filter(Boolean).map((record) => [record.id, record]));
  const currentLibrary = libraryById.get(currentRootId);
  if (!currentLibrary) return null;

  // P1 and P3 both outrank N3. An explicit null shared fact also counts as an
  // association decision and therefore blocks inheritance.
  if (currentLibrary.libraryId
    && Object.prototype.hasOwnProperty.call(associations, currentLibrary.libraryId)) return null;
  if (currentLibrary.profileId) return null;

  const currentPrefix = normalizedPrefix(currentRoot.prefixFromScopeRoot);
  const candidates = [];

  for (const root of roots) {
    if (!root || root.rootId === currentRootId || root.scopeId !== currentRoot.scopeId) continue;
    const ancestorPrefix = normalizedPrefix(root.prefixFromScopeRoot);
    if (ancestorPrefix === currentPrefix || !currentPrefix.startsWith(ancestorPrefix)) continue;

    const profileId = explicitProfileForLibrary(libraryById.get(root.rootId), associations, knownProfileIds);
    if (!profileId) continue;
    candidates.push({
      ancestorRootId: root.rootId,
      ancestorPrefix,
      profileId,
      depth: prefixDepth(ancestorPrefix),
    });
  }

  candidates.sort((a, b) => b.depth - a.depth || a.ancestorRootId.localeCompare(b.ancestorRootId));
  return candidates[0] || null;
}
