// [NORTH-STAR / N2 / DEVICE-AWARE-HUMAN-QUESTION]
// Policy above N5/MEDIA-ID: portable evidence may nominate one peer Library,
// but only the customer's YES may cross the existing guarded local-link seam.

import { VERDICT } from "./media-identity-matcher.js";
import { matchPortableStructure } from "../storage/portable-structure-evidence.js";

const hasOwn = (object, key) => Boolean(key)
  && Object.prototype.hasOwnProperty.call(object || {}, key);

export function resolveDeviceAwareMediaQuestion({
  currentRootId,
  currentLibrary,
  currentSample,
  structure = {},
  libraries = {},
  associations = {},
  knownProfileIds = [],
  ownDeviceId = null,
} = {}) {
  if (!currentRootId || !currentLibrary || currentLibrary.id !== currentRootId) return null;
  // Existing local/shared identity and every explicit association outrank N2.
  if (currentLibrary.libraryId || currentLibrary.profileId) return null;

  const match = matchPortableStructure({ currentSample, structure });
  if (match.verdict !== VERDICT.RESOLVED || !match.libraryId) return null;

  const library = libraries[match.libraryId];
  const sourceDeviceId = library?.sourceDeviceId?.v;
  const profileId = hasOwn(associations, match.libraryId) ? associations[match.libraryId]?.v : null;
  const known = knownProfileIds instanceof Set ? knownProfileIds : new Set(knownProfileIds || []);
  if (typeof sourceDeviceId !== "string" || !sourceDeviceId || sourceDeviceId === ownDeviceId) return null;
  if (typeof profileId !== "string" || !profileId || !known.has(profileId)) return null;

  return Object.freeze({
    currentRootId,
    libraryId: match.libraryId,
    sourceDeviceId,
    profileId,
  });
}

export async function performDeviceAwareMediaQuestionAction({
  kind,
  pendingQuestion,
  getCurrentRootId,
  resolveCurrentQuestion,
  linkLocalLibrary,
} = {}) {
  if (kind !== "yes" && kind !== "no") throw new TypeError("Unknown device-aware media action.");
  if (!pendingQuestion || getCurrentRootId() !== pendingQuestion.currentRootId) {
    return Object.freeze({ status: "stale", linked: false });
  }
  if (kind === "no") return Object.freeze({ status: "declined", linked: false });

  const current = await resolveCurrentQuestion();
  if (!current
    || current.currentRootId !== pendingQuestion.currentRootId
    || current.libraryId !== pendingQuestion.libraryId
    || current.sourceDeviceId !== pendingQuestion.sourceDeviceId) {
    return Object.freeze({ status: "stale", linked: false });
  }

  const result = await linkLocalLibrary(current.currentRootId, current.libraryId);
  if (!result || result.ok === false) {
    return Object.freeze({
      status: result?.reason === "claimed" ? "claimed" : "link-failed",
      linked: false,
    });
  }
  return Object.freeze({ status: "linked", linked: true, profileId: current.profileId });
}
