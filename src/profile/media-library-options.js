// [SYNCV3 / STAGE-10 / MEDIA-LIBRARY-OPTION-LABELS]
//
// Pure presentation for the Media Library selector. No DOM, no storage, no
// ProfileStore, and — critically — no mutation of the records handed in.
//
// BREADCRUMBS — IS: a Media Library option shows its NAME and nothing else
//   until a name is genuinely ambiguous. Disambiguation is added one rung at a
//   time, and a raw Library id prefix is the last rung, reached only when
//   nothing human-readable can separate two entries.
// BREADCRUMBS — WAS: the label was built as
//   `[name, sourceDeviceName || deviceName, id.slice(0, 8)].filter(Boolean)`.
//   No projected Library record has ever carried `sourceDeviceName` or
//   `deviceName` — see projectLibrary() in sync-facts.js, whose fields are
//   id / name / sourceDeviceId / lastLoadedAt / associatedProfileId — so the
//   device segment was always dropped and the id prefix was always kept. Every
//   customer saw a UUID on every option, including unmistakably unique ones
//   ("Mackenzie · d7751417…").
// BREADCRUMBS — FUTURE: there is no peer device-NAME registry in the catalog;
//   `sourceDeviceId` is a raw uuid and would read worse than the id prefix it
//   would replace. If peer device names ever become available, add them as a
//   rung between "This device" and the id prefix — do not resurrect a
//   `sourceDeviceName` field on the projection to do it.
//
// The label is presentation only. Selection is always keyed by `id`; nothing
// here is written back, and two Media Libraries may legitimately share a name.

/** Shortest prefix length (>= min) that separates every id in `ids`. */
function shortestDistinguishingLength(ids, min = 4) {
  const longest = ids.reduce((max, id) => Math.max(max, id.length), 0);
  for (let length = min; length < longest; length += 1) {
    const seen = new Set(ids.map((id) => id.slice(0, length)));
    if (seen.size === ids.length) return length;
  }
  return longest;
}

function displayName(library) {
  const name = typeof library?.name === "string" ? library.name.trim() : "";
  return name || "Unnamed Media Library";
}

/**
 * Describes each Media Library as { id, label }, in the order supplied.
 *
 * @param {object} options
 * @param {Array}  options.libraries      projected Library records
 * @param {string} options.currentDeviceId this installation's device id
 */
export function describeMediaLibraryOptions({ libraries = [], currentDeviceId = null } = {}) {
  const catalog = Array.isArray(libraries) ? libraries : [];

  // Rung 1 — a name that only one Media Library uses needs nothing after it.
  const byName = new Map();
  for (const library of catalog) {
    const name = displayName(library);
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(library);
  }

  return catalog.map((library) => {
    const name = displayName(library);
    const sharing = byName.get(name) || [];
    if (sharing.length === 1) return Object.freeze({ id: library.id, label: name });

    // Rung 2 — among Media Libraries sharing a name, the one that came from
    // THIS device can say so. It is the only human-readable distinction the
    // catalog actually carries.
    const fromThisDevice = Boolean(currentDeviceId) && library.sourceDeviceId === currentDeviceId;
    if (fromThisDevice) {
      const othersHere = sharing.filter((entry) => entry.sourceDeviceId === currentDeviceId);
      if (othersHere.length === 1) return Object.freeze({ id: library.id, label: `${name} · This device` });
    }

    // Rung 3 — last resort. Nothing readable separates these, so use the
    // SHORTEST id prefix that actually does, not a fixed eight characters.
    const ambiguous = sharing.filter((entry) => {
      const entryFromHere = Boolean(currentDeviceId) && entry.sourceDeviceId === currentDeviceId;
      if (!entryFromHere) return true;
      return sharing.filter((other) => other.sourceDeviceId === currentDeviceId).length > 1;
    });
    const ids = ambiguous.map((entry) => String(entry.id));
    const length = shortestDistinguishingLength(ids);
    return Object.freeze({ id: library.id, label: `${name} · ${String(library.id).slice(0, length)}…` });
  });
}
