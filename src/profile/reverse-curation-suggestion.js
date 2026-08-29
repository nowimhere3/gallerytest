// [NORTH-STAR / N4 / REVERSE-SUGGESTION]
//
// Proposal policy above MEDIA-ID. Durable scope membership and prefix
// containment prove only that known roots are descendants. Unanimous Curation
// associations are evidence for a question, never authority for an upward
// write.

const hasOwn = (object, key) => Boolean(key)
  && Object.prototype.hasOwnProperty.call(object || {}, key);

function normalizedPrefix(value) {
  if (typeof value !== "string" || !value) return "";
  return value.endsWith("/") ? value : `${value}/`;
}

function explicitProfileForLibrary(record, associations, knownProfileIds) {
  if (!record) return null;
  const known = knownProfileIds instanceof Set ? knownProfileIds : new Set(knownProfileIds || []);
  if (record.libraryId && hasOwn(associations, record.libraryId)) {
    const profileId = associations[record.libraryId]?.v ?? null;
    return profileId && known.has(profileId) ? profileId : null;
  }
  return record.profileId && known.has(record.profileId) ? record.profileId : null;
}

export function resolveReverseCurationSuggestion({
  currentRootId,
  currentRoot,
  roots = [],
  libraries = [],
  associations = {},
  knownProfileIds = [],
  deferredScopeMerges = [],
} = {}) {
  if (!currentRootId || !currentRoot || currentRoot.rootId !== currentRootId || !currentRoot.scopeId) return null;
  if (Array.isArray(deferredScopeMerges) && deferredScopeMerges.length) return null;

  const libraryById = new Map(libraries.filter(Boolean).map((record) => [record.id, record]));
  const currentLibrary = libraryById.get(currentRootId);
  if (!currentLibrary) return null;
  if (currentLibrary.libraryId && hasOwn(associations, currentLibrary.libraryId)) return null;
  if (currentLibrary.profileId) return null;

  const currentPrefix = normalizedPrefix(currentRoot.prefixFromScopeRoot);
  const explicitDescendants = [];
  for (const root of roots) {
    if (!root || root.rootId === currentRootId || root.scopeId !== currentRoot.scopeId) continue;
    const descendantPrefix = normalizedPrefix(root.prefixFromScopeRoot);
    if (descendantPrefix === currentPrefix || !descendantPrefix.startsWith(currentPrefix)) continue;
    const profileId = explicitProfileForLibrary(libraryById.get(root.rootId), associations, knownProfileIds);
    if (profileId) explicitDescendants.push({ rootId: root.rootId, profileId });
  }

  if (!explicitDescendants.length) return null;
  const profileIds = new Set(explicitDescendants.map((entry) => entry.profileId));
  if (profileIds.size !== 1) return null;

  return Object.freeze({
    currentRootId,
    profileId: explicitDescendants[0].profileId,
    descendantCount: explicitDescendants.length,
  });
}

export async function performReverseCurationSuggestionAction({
  kind,
  pendingSuggestion,
  getCurrentRootId,
  resolveCurrentSuggestion,
  writeAssociation,
} = {}) {
  if (kind !== "yes" && kind !== "no") throw new TypeError("Unknown reverse Curation suggestion action.");
  if (!pendingSuggestion || getCurrentRootId() !== pendingSuggestion.currentRootId) {
    return Object.freeze({ status: "stale", wrote: false });
  }

  // NO is deliberately ephemeral for this load. It performs no evidence read,
  // association write, or switch; the UI owner retires the pending context.
  if (kind === "no") return Object.freeze({ status: "declined", wrote: false });

  const current = await resolveCurrentSuggestion();
  if (!current
    || current.currentRootId !== pendingSuggestion.currentRootId
    || current.profileId !== pendingSuggestion.profileId) {
    return Object.freeze({ status: "stale", wrote: false });
  }

  const written = await writeAssociation(current.profileId);
  return Object.freeze({
    status: written ? "applied" : "write-failed",
    wrote: Boolean(written),
    profileId: current.profileId,
  });
}
