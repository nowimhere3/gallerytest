function hasReliableDuplicateMetadata(item) {
  return (
    item &&
    typeof item.name === "string" &&
    item.name.length > 0 &&
    typeof item.size === "number" &&
    Number.isFinite(item.size) &&
    item.size >= 0
  );
}

export function getDuplicateKeyParts(item) {
  if (!hasReliableDuplicateMetadata(item)) return null;
  return { name: item.name, size: item.size };
}

// WHAT: Keeps the first playable item for each exact filename + byte-size pair.
// WHY: Duplicate skipping is a runtime view filter; the authoritative loaded items and their Profile identities stay intact.
// FUTURE / DO-NOT-BREAK: Keep this O(n), fail open on missing metadata, and never merge or mutate media/Profile records here.
export function skipDuplicateMedia(items) {
  const result = [];
  const sizesByName = new Map();

  for (const item of items) {
    const key = getDuplicateKeyParts(item);
    if (!key) {
      result.push(item);
      continue;
    }

    let seenSizes = sizesByName.get(key.name);
    if (!seenSizes) {
      seenSizes = new Set();
      sizesByName.set(key.name, seenSizes);
    }

    if (seenSizes.has(key.size)) continue;
    seenSizes.add(key.size);
    result.push(item);
  }

  return result;
}

export function haveSameDuplicateKey(left, right) {
  const leftKey = getDuplicateKeyParts(left);
  const rightKey = getDuplicateKeyParts(right);
  return Boolean(leftKey && rightKey && leftKey.name === rightKey.name && leftKey.size === rightKey.size);
}
