// [SYNCV3 / STAGE-09 / SELF-WRITE-SUPPRESSION]
// [WHY: ProfileStore announces an association write before main.js updates its
// local Library projection. Stage 09's ambient observer must therefore identify
// both the open same-tab intent window and the exact fact authored by that
// intent. A timeout would guess about ordering; this coordinator instead uses
// explicit lifetime and the fact's durable (t,d) identity. Everything here is
// deliberately in memory: suppression is page-context state, not shared truth.]

function readFactIdentity(fact) {
  if (!fact || typeof fact !== "object") return null;
  if (!Number.isFinite(fact.t) || typeof fact.d !== "string" || !fact.d) return null;
  return { t: fact.t, d: fact.d };
}

function sameFactIdentity(left, right) {
  return Boolean(left && right && left.t === right.t && left.d === right.d);
}

export function createAssociationWriteSuppression({ onIntentClosed = null } = {}) {
  let loadedLocalLibraryId = null;
  let intent = null;
  let selfAuthored = null;
  let sequence = 0;

  function setLoadedLibrary(localLibraryId) {
    const nextId = typeof localLibraryId === "string" && localLibraryId ? localLibraryId : null;
    if (nextId === loadedLocalLibraryId) return false;
    loadedLocalLibraryId = nextId;
    intent = null;
    selfAuthored = null;
    return true;
  }

  function beginIntent(localLibraryId) {
    const normalizedId = typeof localLibraryId === "string" && localLibraryId ? localLibraryId : null;
    if (!normalizedId) throw new Error("Association write intent requires a loaded local Library id.");
    setLoadedLibrary(normalizedId);
    const token = Object.freeze({ sequence: ++sequence, localLibraryId: normalizedId });
    intent = token;
    return token;
  }

  function captureAuthoredFact(token, libraryId, fact) {
    if (intent !== token || token.localLibraryId !== loadedLocalLibraryId) return false;
    const identity = readFactIdentity(fact);
    if (typeof libraryId !== "string" || !libraryId || !identity) return false;
    selfAuthored = { localLibraryId: token.localLibraryId, libraryId, ...identity };
    return true;
  }

  function endIntent(token) {
    if (intent !== token) return false;
    intent = null;
    if (typeof onIntentClosed === "function") {
      onIntentClosed({
        localLibraryId: token.localLibraryId,
        libraryId: selfAuthored?.localLibraryId === token.localLibraryId ? selfAuthored.libraryId : null,
      });
    }
    return true;
  }

  function shouldSuppress({ localLibraryId, libraryId, fact } = {}) {
    if (!loadedLocalLibraryId || localLibraryId !== loadedLocalLibraryId) return false;

    // [SYNCV3 / STAGE-09 / SELF-WRITE-SUPPRESSION]
    // [WHY: while the writer is awaiting persistence, refresh may observe the
    // old projection, the new fact, or a concurrent remote fact. Suppress all
    // of those transient observations now, then make exactly one authoritative
    // re-evaluation when endIntent closes the window. That final pass is what
    // prevents a real remote transition from being swallowed.]
    if (intent && intent.localLibraryId === localLibraryId) return true;

    const identity = readFactIdentity(fact);
    return Boolean(
      selfAuthored &&
        selfAuthored.localLibraryId === localLibraryId &&
        selfAuthored.libraryId === libraryId &&
        sameFactIdentity(selfAuthored, identity)
    );
  }

  return Object.freeze({
    setLoadedLibrary,
    beginIntent,
    captureAuthoredFact,
    endIntent,
    shouldSuppress,
  });
}

