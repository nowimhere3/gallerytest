// [SYNCV3 / STAGE-03C / SAME-DEVICE-TAB-STATE]
// [WHY: same-origin tabs, windows and iframes share one IndexedDB and one
//  deviceId, but each has its OWN in-memory ProfileStore. Nothing today tells a
//  context that another one changed durable state, so every context is a
//  snapshot of whenever it last read - and with the V3 writer role now pinned to
//  a single tab, the tab that publishes may be the one with the oldest view.
//
//  This channel carries INVALIDATION only. IndexedDB remains the local durable
//  authority; a message says "something changed", never "here is the new
//  state". That distinction is the whole safety property: a payload-carrying
//  message would be a second source of truth that can arrive out of order,
//  arrive twice, or arrive from a context whose write later failed - and the
//  receiver would have no way to tell. A receiver that always re-reads the
//  database cannot be wrong about what the database says.]
//
// WHAT: a thin, fault-tolerant wrapper over BroadcastChannel, plus this
// context's ephemeral identity.
//
// FUTURE / DO-NOT-BREAK: do not start putting Profile payloads in these
// messages. If a message ever needs to be trusted without a re-read, the thing
// actually needed is a revision number, not a copy of the data.

/** The one channel name. Namespaced so it cannot collide with anything else on the origin. */
export const LOCAL_STATE_CHANNEL_NAME = "browser-gallery-profile-state";

export const LOCAL_STATE_MESSAGE_KINDS = Object.freeze({
  PROFILE_FACTS_CHANGED: "profile-facts-changed",
  PROFILE_REGISTRY_CHANGED: "profile-registry-changed",
  ASSOCIATIONS_CHANGED: "associations-changed",
  // [SYNCV3 / STAGE-04B / SHARED-LIBRARY-RECORD]
  // [WHY: its own kind rather than reusing ASSOCIATIONS_CHANGED. The two are
  //  separate durable rows with separate meanings, and a receiver that could not
  //  tell them apart would re-read both every time either moved - which is
  //  merely wasteful today, and becomes wrong the moment a future stage wants to
  //  react to one and not the other.]
  LIBRARIES_CHANGED: "libraries-changed",
  // [SYNCV3 / STAGE-05 / DEVICE-NAMING]
  // [WHY: the Device Name lives on the device record, which no other message
  //  kind causes a sibling to re-read. Without its own kind a rename in one tab
  //  would be invisible everywhere else until a reload - and, worse, the WRITER
  //  tab would keep publishing the old name.]
  DEVICE_NAME_CHANGED: "device-name-changed",
  // [SYNCV3 / STAGE-09 / SLICE-5-MULTITAB-DECISIONS]
  // [WHY: its own kind because the ambient decision row is durable, local-only,
  //  and shared by nothing else. Reusing ASSOCIATIONS_CHANGED would make every
  //  sibling re-read shared association storage for a change that touched none
  //  of it, and would make a purely local decision look like shared movement.
  //  Like every kind here this is INVALIDATION ONLY: it carries no decision, no
  //  Library id and no value. A receiver re-reads the decision store, which
  //  remains the single authority - see this file's header.]
  AMBIENT_DECISION_CHANGED: "ambient-decision-changed",
  // [SYNCV3 / STAGE-03C / SAME-DEVICE-TAB-STATE]
  // [WHY: presence, announced on open and answered once. The stale-row guard in
  //  ProfileStore#persist costs a read per save, so it should not run when there
  //  is nobody to be stale against - but it must already be armed BEFORE the
  //  first concurrent click, not armed by it. Waiting for a data message to
  //  arrive leaves precisely one write unprotected: the first one two fresh
  //  contexts make at the same moment, which is the exact case a user hits by
  //  opening a second tab and immediately clicking.
  //
  //  Two kinds rather than one so the handshake terminates: ONLINE is answered
  //  with HERE, and HERE is answered with nothing. A single kind that replied to
  //  itself would echo between every pair of contexts forever.]
  CONTEXT_ONLINE: "context-online",
  CONTEXT_HERE: "context-here",
});

/**
 * A per-page-load identity, used ONLY to suppress self-echo and to make a
 * diagnostic readable.
 *
 * [SYNCV3 / STAGE-03C / SAME-DEVICE-TAB-STATE]
 * [WHY: deliberately NOT persisted and deliberately not any of the durable ids.
 *  A contextId that survived a reload would let a reloaded page ignore messages
 *  from what is now genuinely a different context; one derived from deviceId
 *  would be identical in every tab and suppress everything. It identifies a
 *  page load, which is exactly the lifetime of the in-memory state it protects.]
 */
export function generateContextId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `ctx-${crypto.randomUUID()}`;
  }
  return `ctx-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Opens the local-state channel for this context.
 *
 * Returns { contextId, available, post(message), close() }. Every method is safe
 * to call when BroadcastChannel does not exist - see the fallback note below.
 *
 * [SYNCV3 / STAGE-03C / SAME-DEVICE-TAB-STATE]
 * [WHY: an unavailable BroadcastChannel degrades to a channel that posts nothing
 *  and receives nothing, rather than to a thrown error or a second mechanism.
 *  Freshness does not depend on this channel being present - the read-modify-
 *  write in ProfileStore#persist and the reload-before-publish in the V3 pass
 *  both hold without it (see their own breadcrumbs). This channel makes other
 *  contexts current PROMPTLY; it is not what makes them CORRECT.]
 */
export function createLocalStateChannel({
  channelName = LOCAL_STATE_CHANNEL_NAME,
  contextId = generateContextId(),
  onMessage = null,
  factory = undefined,
} = {}) {
  let channel = null;

  // [SYNCV3 / STAGE-03C / SAME-DEVICE-TAB-STATE]
  // [WHY: an explicit `factory: null` means "behave as though BroadcastChannel
  //  does not exist". Needed because the fallback path is a real supported
  //  configuration - some embeddings genuinely lack the API - and a fallback
  //  nothing can exercise is a fallback nobody knows is broken.]
  const construct =
    factory === null
      ? null
      : factory || (typeof BroadcastChannel === "function" ? (name) => new BroadcastChannel(name) : null);

  if (construct) {
    try {
      channel = construct(channelName);
    } catch (error) {
      console.warn("[SYNCV3] Could not open the local state channel; same-tab freshness will rely on reload-before-publish.", error);
      channel = null;
    }
  }

  // [SYNCV3 / STAGE-03C / SAME-DEVICE-TAB-STATE]
  // [WHY: the handler is settable AFTER construction, not only through the
  //  constructor. A caller that builds the channel itself and hands it to
  //  ProfileStore - a test putting two contexts on one channel name, or an
  //  embedder wanting to observe traffic - would otherwise get a channel that
  //  posts but never receives, and the silence looks exactly like "no peers".]
  let handler = typeof onMessage === "function" ? onMessage : null;

  if (channel) {
    channel.onmessage = (event) => {
      const message = event && event.data;
      if (!message || typeof message !== "object") return;
      // [SYNCV3 / STAGE-03C / SAME-DEVICE-TAB-STATE]
      // [WHY: self-echo is dropped HERE, once, rather than at each handler.
      //  BroadcastChannel does not deliver to the posting context today, but a
      //  same-page iframe, a future relay, or a test harness that shares one
      //  channel object between contexts all can - and a context that reloaded
      //  its own state in response to its own write would be harmless but
      //  endlessly noisy.]
      if (message.contextId && message.contextId === contextId) return;
      if (!handler) return;
      try {
        handler(message);
      } catch (error) {
        console.warn("[SYNCV3] A local state message handler failed.", error);
      }
    };
  }

  return {
    contextId,
    channelName,
    /** Installs (or replaces) the receive handler. Safe when the channel is unavailable. */
    setHandler(next) {
      handler = typeof next === "function" ? next : null;
    },
    get available() {
      return Boolean(channel);
    },
    post(message) {
      if (!channel || !message || typeof message !== "object") return false;
      try {
        channel.postMessage({ ...message, contextId });
        return true;
      } catch (error) {
        // A closed channel, or a structured-clone failure from a message that
        // should never have carried anything uncloneable in the first place.
        console.warn("[SYNCV3] Could not post a local state message.", error);
        return false;
      }
    },
    close() {
      if (!channel) return;
      try {
        channel.onmessage = null;
        if (typeof channel.close === "function") channel.close();
      } catch {
        // Already gone.
      }
      channel = null;
    },
  };
}
