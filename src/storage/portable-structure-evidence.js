// [NORTH-STAR / N5 / PORTABLE-STRUCTURE-EVIDENCE]
//
// The single audited export seam from a completed media observation into a
// portable replica value. It accepts provider-neutral MediaItems and emits only
// bounded relative path + size evidence. No MEDIA-ID database key, handle,
// permission, local root id, or local scope id can enter this shape.

import { proposeStructuralMembership, VERDICT } from "../profile/media-identity-matcher.js";

export const PORTABLE_STRUCTURE_VERSION = 1;
export const PORTABLE_SAMPLE_MODULUS = 50;
export const PORTABLE_SMALL_LIBRARY_THRESHOLD = 200;

function fnv1a32(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function safeRelativePath(value) {
  if (typeof value !== "string" || !value || value.startsWith("/") || value.startsWith("\\")) return null;
  if (/^[A-Za-z]:[\\/]/.test(value) || value.split(/[\\/]/).includes("..")) return null;
  return value.replaceAll("\\", "/");
}

export function buildPortableStructureSample(items = []) {
  const eligible = [];
  let totalSize = 0;
  for (const item of items) {
    const path = safeRelativePath(item?.relativePath);
    const size = Number(item?.size);
    if (!path || !Number.isFinite(size) || size < 0) continue;
    eligible.push({ path, size });
    totalSize += size;
  }

  const sampled = eligible.length <= PORTABLE_SMALL_LIBRARY_THRESHOLD
    ? eligible
    : eligible.filter((entry) => fnv1a32(entry.path) % PORTABLE_SAMPLE_MODULUS === 0);

  return Object.freeze({
    v: PORTABLE_STRUCTURE_VERSION,
    count: eligible.length,
    totalSize,
    entries: Object.freeze(sampled
      .map((entry) => Object.freeze({ path: entry.path, size: entry.size }))
      .sort((a, b) => a.path.localeCompare(b.path) || a.size - b.size)),
  });
}

function validSample(value) {
  return Boolean(value
    && value.v === PORTABLE_STRUCTURE_VERSION
    && Number.isInteger(value.count) && value.count >= 0
    && Number.isFinite(value.totalSize) && value.totalSize >= 0
    && Array.isArray(value.entries));
}

function sampleMaps(sample) {
  const observedByPath = new Map();
  for (const entry of sample.entries) {
    const path = safeRelativePath(entry?.path);
    const size = Number(entry?.size);
    if (!path || !Number.isFinite(size) || size < 0) continue;
    observedByPath.set(path, { size });
  }
  return observedByPath;
}

/**
 * Returns T2's proposal/refusal verdict with `libraryId` added for the one
 * strong candidate. This never links a folder and never reads names.
 */
export function matchPortableStructure({ currentSample, structure = {} } = {}) {
  if (!validSample(currentSample)) {
    return Object.freeze({ verdict: VERDICT.NONE, libraryId: null, reason: "invalid-current-sample" });
  }

  const observedByPath = sampleMaps(currentSample);
  const candidates = [];
  for (const libraryId of Object.keys(structure).sort()) {
    const sample = structure[libraryId]?.sample?.v;
    if (!validSample(sample)) continue;
    const storedByPath = new Map(
      [...sampleMaps(sample)].map(([path, signature]) => [path, { observedSignature: signature }])
    );
    candidates.push({
      scopeId: libraryId,
      subtreePrefix: "",
      storedPaths: new Set(storedByPath.keys()),
      storedByPath,
      itemCount: sample.count,
    });
  }

  const result = proposeStructuralMembership({
    observedPaths: [...observedByPath.keys()],
    observedByPath,
    observedItemCount: currentSample.count,
    candidates,
  });
  return Object.freeze({
    ...result,
    libraryId: result.verdict === VERDICT.RESOLVED ? result.scopeId : null,
  });
}

export function isPortableStructureSample(value) {
  if (!validSample(value)) return false;
  return value.entries.every((entry) => {
    const path = safeRelativePath(entry?.path);
    return Boolean(path && path === entry.path && Number.isFinite(entry.size) && entry.size >= 0);
  });
}
