// [PHASE-6-SYNC-V2]
// [STAGE-D1-LOCAL-FOUNDATION]
// [WHY: stamps are only meaningful if the device issuing them has a stable
//  identity and a clock that can never go backwards. deviceId is what breaks
//  ties deterministically between two devices at the same logical time, so if
//  it changed between sessions this installation would resolve ties against
//  its own past self; and if the clock floor reset on reload, a freshly issued
//  stamp could land BELOW facts this device already recorded, at which point
//  sync-facts.js's mergeFact correctly discards the new mutation and the user's
//  click silently does nothing. Both failures are invisible at the UI, which is
//  exactly why they are handled here rather than left to callers.]
//
// WHAT: SyncIdentity — mints/loads the installation's deviceId, restores the
// logical clock floor, and gates stamping behind a `ready` promise so that
// observe-before-tick is structurally enforced rather than remembered.
//
// FUTURE / DO-NOT-BREAK: deviceId must never be derived from anything that can
// legitimately change or collide — not a Profile ID, not the sync folder name,
// not the browser or machine name. Two installations sharing a deviceId would
// break tie-breaking in a way merge cannot detect. It is a random UUID, minted
// once, and persisted separately from the sync connection so "Disconnect Sync"
// cannot destroy it.

import { HybridClock } from "./sync-merge.js";
import { loadDeviceRecord, saveDeviceRecord, persistLastIssuedT } from "../storage/profile-sync-store.js";

// How long to coalesce clock-floor writes. The floor only has to be durable
// before the NEXT reload, not before the next tick, so batching keeps rapid
// tagging from producing one IndexedDB write per keystroke.
const FLOOR_PERSIST_DEBOUNCE_MS = 750;

/**
 * Stable, opaque installation identity. Prefers crypto.randomUUID (available in
 * secure contexts, including http://localhost); falls back to the same
 * timestamp+random style already used by generateProfileId().
 */
export function generateDeviceId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `dev-${crypto.randomUUID()}`;
  }
  return `dev-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// [PHASE-6-SYNC-V2]
// [STAGE-E-HUMAN-DEVICE-LABEL]
// [WHY: raw UUID device folders are technically precise but unusable for
//  real-device debugging; human labels must remain display-only and never
//  become identity. This function is deliberately COARSE — it answers "which
//  of the machines on my desk is this?", not "which installation is this?".
//  Two Chromebooks both reporting "Chromebook" is a correct outcome, not a
//  collision, because nothing anywhere keys off this string: deviceId remains
//  the sole identity, and it is generated independently (generateDeviceId
//  above) from a UUID that has no relationship to the platform.
//
//  Detection order matters: Chrome OS and Android both contain "Linux" in
//  their user-agent strings, so the specific platforms are tested before the
//  generic one or every Chromebook would read as "Linux" — which is exactly
//  the confusion this exists to remove.]
export function detectDeviceLabel(userAgent = undefined) {
  let ua = userAgent;
  if (ua === undefined) {
    try {
      ua = typeof navigator !== "undefined" && navigator.userAgent ? navigator.userAgent : "";
    } catch {
      ua = "";
    }
  }
  if (typeof ua !== "string" || !ua) return "Unknown Device";

  if (/CrOS/i.test(ua)) return "Chromebook";
  if (/Android/i.test(ua)) return "Android";
  if (/iPhone|iPad|iPod/i.test(ua)) return "iOS";
  if (/Windows/i.test(ua)) return "Windows";
  if (/Mac OS X|Macintosh/i.test(ua)) return "macOS";
  if (/Linux|X11/i.test(ua)) return "Linux";
  return "Unknown Device";
}

export class SyncIdentity {
  #deviceId = null;
  #clock = null;
  #ready;
  #persistTimer = null;
  #pendingFloor = 0;
  #ephemeral = false;
  #storage;

  /**
   * options.now — injectable time source, for deterministic tests.
   * options.storage — injectable persistence, for tests. Defaults to the real
   *   profile-sync store.
   */
  constructor({ now = undefined, storage = undefined } = {}) {
    this.#storage = storage || { loadDeviceRecord, saveDeviceRecord, persistLastIssuedT };
    this.#ready = this.#initialize(now);
  }

  // [PHASE-6-SYNC-V2][STAGE-D1-LOCAL-FOUNDATION]
  // [WHY: a missing device record must degrade to a WORKING installation, never
  //  to a thrown error that breaks Favorites. If persistence is unavailable
  //  entirely (private-browsing modes disable IndexedDB), an ephemeral identity
  //  is minted for the session so curation keeps working locally — the same
  //  tolerance ProfileStore#resolveActiveProfile already applies. Such a device
  //  is marked ephemeral so a later stage can refuse to PUBLISH under an
  //  identity that will not survive the reload.]
  async #initialize(now) {
    let record = null;
    try {
      record = await this.#storage.loadDeviceRecord();
    } catch (error) {
      console.warn("[SYNC-V2] Could not read the device record; using a session-only device identity.", error);
      this.#ephemeral = true;
    }

    if (record && record.deviceId) {
      this.#deviceId = record.deviceId;
    } else {
      this.#deviceId = generateDeviceId();
      if (!this.#ephemeral) {
        try {
          await this.#storage.saveDeviceRecord({ deviceId: this.#deviceId, lastIssuedT: 0 });
        } catch (error) {
          console.warn("[SYNC-V2] Could not persist the new device identity.", error);
          this.#ephemeral = true;
        }
      }
    }

    this.#clock = new HybridClock(this.#deviceId, now ? { now } : undefined);
    // Restoring the floor is the whole reason lastIssuedT is persisted: without
    // it, a reload on a device that had observed a peer from the future would
    // issue stamps below what it already published.
    this.#clock.observe(record && record.lastIssuedT ? record.lastIssuedT : 0);
  }

  /** Resolves once deviceId and the clock floor are restored. */
  get ready() {
    return this.#ready;
  }

  /** Null until `ready` resolves. */
  get deviceId() {
    return this.#deviceId;
  }

  /** True when this identity could not be persisted and will not survive a reload. */
  get isEphemeral() {
    return this.#ephemeral;
  }

  /**
   * Human-readable platform label for diagnostics ONLY — see detectDeviceLabel.
   * Never persisted alongside deviceId and never consulted by anything that
   * identifies, orders, or merges: recomputed fresh on every boot precisely so
   * it cannot drift into looking like durable state.
   */
  get label() {
    return detectDeviceLabel();
  }

  /**
   * Raises the clock floor above every stamp in a replica.
   *
   * [PHASE-6-SYNC-V2][STAGE-D1-LOCAL-FOUNDATION]
   * [WHY: this is the observe half of observe-before-tick. It must run against
   *  the locally persisted facts at boot, and against every merged peer replica
   *  before any mutation is stamped. Skipping it does not fail loudly — it
   *  produces a mutation whose stamp loses to a fact already present, so the
   *  user's action is silently discarded by an otherwise correct merge.]
   */
  observeReplica(replica) {
    if (this.#clock) this.#clock.observeReplica(replica);
    return this;
  }

  observe(t) {
    if (this.#clock) this.#clock.observe(t);
    return this;
  }

  /**
   * Issues the next stamp. Throws if called before `ready` — deliberately
   * loud, because a stamp issued against an un-restored floor is the exact
   * silent-loss bug this class exists to prevent.
   */
  tick() {
    if (!this.#clock) {
      throw new Error("SyncIdentity.tick() called before ready — await identity.ready first.");
    }
    const stamp = this.#clock.tick();
    this.#scheduleFloorPersist(stamp.t);
    return stamp;
  }

  #scheduleFloorPersist(t) {
    if (this.#ephemeral) return;
    if (t > this.#pendingFloor) this.#pendingFloor = t;
    if (this.#persistTimer) return;

    this.#persistTimer = setTimeout(() => {
      this.#persistTimer = null;
      const floor = this.#pendingFloor;
      Promise.resolve(this.#storage.persistLastIssuedT(floor)).catch((error) =>
        console.warn("[SYNC-V2] Could not persist the clock floor.", error)
      );
    }, FLOOR_PERSIST_DEBOUNCE_MS);
  }

  /** Flushes the debounced floor write immediately. Used at publish time and by tests. */
  async flush() {
    if (this.#persistTimer) {
      clearTimeout(this.#persistTimer);
      this.#persistTimer = null;
    }
    if (this.#ephemeral || !this.#pendingFloor) return;
    try {
      await this.#storage.persistLastIssuedT(this.#pendingFloor);
    } catch (error) {
      console.warn("[SYNC-V2] Could not persist the clock floor.", error);
    }
  }
}
