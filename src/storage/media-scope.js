// [MEDIA-ID / STAGE-01 / MEDIA-SCOPE]
//
// Resolves WHICH identity universe a freshly loaded folder belongs to.
//
// ---- Why a third identity -------------------------------------------------
//
// [WHY: neither existing identity can key a media index.
//
//  `record.id` ("lib-...") is minted on EVERY FSA pick (library-registry.js),
//  so MASTER/ and MASTER/Animals/Cats/ picked separately are two different
//  rows. Keying by it would make them two identity universes for the same
//  files — precisely the bug MEDIA-ID exists to fix.
//
//  `record.libraryId` is the SHARED logical id, and it is minted ONLY on an
//  explicit association (ensureLibraryId's "mint-once, preserve-forever";
//  recordLibraryLoaded returns null rather than minting). An un-associated
//  library genuinely has none, so keying by it would leave most folders with
//  no key at all.
//
//  So MEDIA-ID mints its own: a scopeId, local, opaque, never written to the
//  library registry, never into facts, never synced. A scope is the UNION of
//  physical roots PROVEN to live in one tree.]
//
// ---- Association semantics are not touched --------------------------------
//
// [WHY: this module never calls ensureLibraryId, setLibraryProfile or
//  linkLocalLibraryToSharedId, never mints or links a libraryId, and never
//  publishes an association fact. Two roots sharing a media scope remain two
//  independent library rows with independent — possibly different, possibly
//  absent — Profile associations. MEDIA-ID deliberately does NOT "fix" such a
//  mismatch: that would be a semantic change nobody approved, and the
//  profileId tagging on path evidence is what keeps the two Profiles' curation
//  from bleeding together instead.]

import { ANCESTRY, probeAncestry, isAncestryAvailable } from "./fsa-ancestry.js";
import { claimRoot, createScope, getRoot, getScope, listRoots, rebaseScope, recordAncestryAttempt } from "./media-identity.js";

/**
 * Expresses a provider-relative path in scope-relative terms.
 *
 * This one line is what makes MASTER's "Staging area/Mackenzie/cat.jpg" and the
 * subfolder pick's "cat.jpg" the SAME index key.
 */
export function toScopeRelativePath(prefixFromScopeRoot, relativePath) {
  if (!prefixFromScopeRoot) return relativePath;
  return `${prefixFromScopeRoot}${relativePath}`;
}

/**
 * Pure decision step, separated from all I/O so it can be tested exhaustively
 * against every combination of ancestry outcomes.
 *
 * `probes` is [{ rootId, scopeId, prefixFromScopeRoot, asDescendant, asAncestor }]
 * where asDescendant/asAncestor are probeAncestry results.
 *
 * Returns one of:
 *   { action: "join",   scopeId, prefixFromScopeRoot, viaRootId }
 *   { action: "rebase", scopeId, viaRootId, prefixToPrepend }
 *   { action: "mint" }
 */
export function decideScopeJoin(probes) {
  const descendantOf = [];
  const ancestorOf = [];

  for (const probe of probes) {
    const down = probe.asDescendant;
    // PROVEN membership only. "unknown" is skipped — it is the absence of a
    // result, never a negative one, and never a positive one either.
    if (down && (down.relation === ANCESTRY.DESCENDANT || down.relation === ANCESTRY.SELF)) {
      descendantOf.push({
        scopeId: probe.scopeId,
        viaRootId: probe.rootId,
        // The known root already sits at some depth inside its scope; the new
        // root sits at `down.prefix` inside THAT root. Both hops compose.
        prefixFromScopeRoot: `${probe.prefixFromScopeRoot || ""}${down.prefix || ""}`,
        depth: (down.segments || []).length,
      });
      continue;
    }

    const up = probe.asAncestor;
    if (up && up.relation === ANCESTRY.DESCENDANT) {
      ancestorOf.push({ scopeId: probe.scopeId, viaRootId: probe.rootId, prefixToPrepend: up.prefix });
    }
  }

  if (descendantOf.length) {
    // [WHY: joining as a descendant is preferred over re-basing whenever both
    //  are available — it needs no migration at all, so it cannot half-apply.
    //  The SHALLOWEST known ancestor wins, which yields the shortest prefix and
    //  keeps scope-relative paths as close to the true master as possible.]
    descendantOf.sort((a, b) => a.depth - b.depth);
    const best = descendantOf[0];
    return {
      action: "join",
      scopeId: best.scopeId,
      prefixFromScopeRoot: best.prefixFromScopeRoot,
      viaRootId: best.viaRootId,
    };
  }

  if (ancestorOf.length) {
    // Subfolder-first, master-later. This new root sits ABOVE an existing
    // scope, so the scope's root moves up to it and everything below re-bases.
    //
    // [WHY: only ONE scope may be re-based per load. If this root were proven
    //  to be the ancestor of roots in two DIFFERENT scopes, the correct answer
    //  is to merge those scopes — a strictly larger operation with its own
    //  identity-collision questions, deliberately deferred past Stage 01. The
    //  first is re-based, the rest are recorded as diagnostics and left alone.
    //  Leaving them separate is the same safe degradation as never having
    //  noticed: no curation is lost, some is simply not recovered yet.]
    const distinctScopes = new Set(ancestorOf.map((entry) => entry.scopeId));
    const chosen = ancestorOf[0];
    return {
      action: "rebase",
      scopeId: chosen.scopeId,
      viaRootId: chosen.viaRootId,
      prefixToPrepend: chosen.prefixToPrepend,
      deferredScopeMerges: distinctScopes.size > 1 ? [...distinctScopes].filter((id) => id !== chosen.scopeId) : [],
    };
  }

  return { action: "mint" };
}

/**
 * Finds or establishes the media scope for a freshly loaded root.
 *
 * `handle` may be null (Legacy provider) — such a root simply gets its own
 * scope, because there is no handle to prove ancestry with. Merging Legacy
 * scopes is a structural question, and structure alone never auto-resolves.
 *
 * `knownRootHandles` is [{ rootId, handle }] for other roots this device has
 * persisted, supplied by the caller so this module never opens the library
 * registry itself.
 *
 * Returns { scopeId, rootId, prefixFromScopeRoot, action, diagnostics }.
 */
export async function resolveScopeForRoot({ rootId, handle = null, sourceKind = "fsa", knownRootHandles = [], at = Date.now() }) {
  if (!rootId) throw new Error("resolveScopeForRoot requires a local rootId.");

  const existing = await getRoot(rootId);
  if (existing) {
    return {
      scopeId: existing.scopeId,
      rootId,
      prefixFromScopeRoot: existing.prefixFromScopeRoot || "",
      action: "existing",
      diagnostics: { probed: 0 },
    };
  }

  const probes = [];
  let attempted = 0;

  if (handle && isAncestryAvailable(handle)) {
    const members = await listRoots();
    const handleByRootId = new Map(knownRootHandles.filter((entry) => entry && entry.handle).map((entry) => [entry.rootId, entry.handle]));

    for (const member of members) {
      if (member.rootId === rootId) continue;
      const memberHandle = handleByRootId.get(member.rootId);
      if (!memberHandle) continue;

      attempted += 1;
      // Both directions, because either could be true and they mean different
      // things: down = this root is inside a known one; up = a known one is
      // inside this root (subfolder-first, master-later).
      const asDescendant = await probeAncestry(memberHandle, handle);
      const asAncestor =
        asDescendant.relation === ANCESTRY.DESCENDANT || asDescendant.relation === ANCESTRY.SELF
          ? null
          : await probeAncestry(handle, memberHandle);

      probes.push({
        rootId: member.rootId,
        scopeId: member.scopeId,
        prefixFromScopeRoot: member.prefixFromScopeRoot || "",
        asDescendant,
        asAncestor,
      });
    }
  }

  const decision = decideScopeJoin(probes);

  // Local-only diagnostics. Answers "does resolve() work at permission state
  // prompt?" empirically over ordinary use, without that answer ever being
  // load-bearing anywhere.
  const attemptLog = probes.map((probe) => ({
    at,
    againstRootId: probe.rootId,
    permissionState: probe.asDescendant ? probe.asDescendant.permissionState : "unavailable",
    outcome: probe.asDescendant ? probe.asDescendant.relation : "unknown",
    reason: probe.asDescendant ? probe.asDescendant.reason : "no-probe",
  }));

  if (decision.action === "join") {
    const claimed = await claimRoot({
      rootId,
      scopeId: decision.scopeId,
      prefixFromScopeRoot: decision.prefixFromScopeRoot,
      sourceKind,
      createdAt: at,
      ancestryEvidence: { relation: ANCESTRY.DESCENDANT, provenAgainstRootId: decision.viaRootId, at },
    });
    for (const entry of attemptLog) await recordAncestryAttempt(claimed.root.scopeId, entry);
    return {
      scopeId: claimed.root.scopeId,
      rootId,
      prefixFromScopeRoot: claimed.root.prefixFromScopeRoot || "",
      action: claimed.created ? "joined" : "existing",
      diagnostics: { probed: attempted, viaRootId: decision.viaRootId },
    };
  }

  if (decision.action === "rebase") {
    const scope = await getScope(decision.scopeId);
    if (!scope) return mintFreshScope({ rootId, sourceKind, at, attempted, attemptLog });

    // The new root becomes the scope root, so its own prefix is "".
    const claimed = await claimRoot({
      rootId,
      scopeId: decision.scopeId,
      prefixFromScopeRoot: "",
      sourceKind,
      createdAt: at,
      ancestryEvidence: { relation: "ancestor", provenAgainstRootId: decision.viaRootId, at },
    });

    // Version-guarded. A racing tab that re-based first bumps scopeVersion, this
    // call returns version-conflict, and the prefix is NOT applied twice.
    const result = await rebaseScope(decision.scopeId, scope.scopeVersion, {
      newScopeRootId: rootId,
      prefixToPrepend: decision.prefixToPrepend,
      at,
    });

    if (!result.ok) {
      // Lost the race (or the scope moved). Re-read the winner's state and use
      // it as-is; retrying our own re-base on top would double-apply.
      const fresh = await getRoot(rootId);
      return {
        scopeId: decision.scopeId,
        rootId,
        prefixFromScopeRoot: fresh ? fresh.prefixFromScopeRoot || "" : "",
        action: "rebase-deferred",
        diagnostics: { probed: attempted, rebaseSkipped: result.reason, deferredScopeMerges: decision.deferredScopeMerges },
      };
    }

    for (const entry of attemptLog) await recordAncestryAttempt(decision.scopeId, entry);

    // [WHY: re-read from storage rather than returning the in-memory row
    //  claimRoot built a moment ago. The re-base runs ON TOP of that row, so the
    //  object in hand describes state that no longer exists — and returning it
    //  meant the caller seeded against a prefix the database did not hold. That
    //  is precisely how the re-base defect stayed invisible: the value returned
    //  and the value persisted disagreed, and only the returned one was ever
    //  looked at. Everything downstream now reads persisted truth.]
    const persisted = await getRoot(rootId);
    return {
      scopeId: decision.scopeId,
      rootId,
      prefixFromScopeRoot: persisted ? persisted.prefixFromScopeRoot || "" : "",
      action: "rebased",
      diagnostics: {
        probed: attempted,
        viaRootId: decision.viaRootId,
        rebasedPaths: result.rebasedPaths,
        rebasedRoots: result.rebasedRoots,
        deferredScopeMerges: decision.deferredScopeMerges,
      },
    };
  }

  return mintFreshScope({ rootId, sourceKind, at, attempted, attemptLog });
}

async function mintFreshScope({ rootId, sourceKind, at, attempted, attemptLog }) {
  const scope = await createScope(rootId, { at });
  const claimed = await claimRoot({
    rootId,
    scopeId: scope.scopeId,
    prefixFromScopeRoot: "",
    sourceKind,
    createdAt: at,
    ancestryEvidence: null,
  });

  // claimRoot may have lost a race, in which case the winner's scope is
  // authoritative and the scope minted just above is inert and unreferenced.
  const scopeId = claimed.root.scopeId;
  for (const entry of attemptLog) await recordAncestryAttempt(scopeId, entry);

  return {
    scopeId,
    rootId,
    prefixFromScopeRoot: claimed.root.prefixFromScopeRoot || "",
    action: claimed.created ? "minted" : "existing",
    diagnostics: { probed: attempted },
  };
}
