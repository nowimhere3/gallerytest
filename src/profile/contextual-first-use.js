// [SYNCV3 / STAGE-10 / CONTEXTUAL-FIRST-USE]
// The permanent Help disclosure owns the full definitions. These deliberately
// short introduction steps name the Help concepts they summarize so tests can
// catch vocabulary drift without duplicating the whole glossary here.
export const PROFILE_SYNC_INTRO_STEPS = Object.freeze([
  Object.freeze({
    id: "media",
    concepts: Object.freeze(["folder", "sync"]),
    title: "Your media stays where it is",
    body: "Browser Gallery reads your folder on this device. Sync does not upload, move or copy your photos and videos.",
  }),
  Object.freeze({
    id: "profile",
    concepts: Object.freeze(["profile"]),
    title: "Profiles keep your organization together",
    body: "Each Profile is a unique set of Favorites, Hidden items and Tags.",
  }),
  Object.freeze({
    id: "sync",
    concepts: Object.freeze(["folder", "library", "profile", "sync"]),
    title: "Use the same collection on another device",
    body: "Link both folders to the same Library. With Sync, the other device can use that Library and Profile when you choose.",
  }),
]);

export function createContextualFirstUseState({ seen = false } = {}) {
  return Object.freeze({ visible: false, stepIndex: 0, seen: seen === true, replay: false });
}

function result(state, effect = null) {
  return Object.freeze({ state: Object.freeze(state), effect });
}

export function transitionContextualFirstUse(state, event) {
  switch (event?.type) {
    case "enter-profile-sync":
      // [WHY: passive boot/render calls carry no intentional flag. Only a
      // user navigation into Profile & Sync may consume the first-use moment.]
      if (!event.intentional || state.seen || state.visible) return result(state);
      return result({ ...state, visible: true, stepIndex: 0, replay: false });
    case "replay":
      // [WHY: replay is an explicit viewing action, not a reset. A completed
      // device must never become "unseen" and auto-open again later.]
      return result({ ...state, visible: true, stepIndex: 0, replay: true });
    case "next":
      if (!state.visible || state.stepIndex >= PROFILE_SYNC_INTRO_STEPS.length - 1) return result(state);
      return result({ ...state, stepIndex: state.stepIndex + 1 });
    case "back":
      if (!state.visible || state.stepIndex <= 0) return result(state);
      return result({ ...state, stepIndex: state.stepIndex - 1 });
    case "skip":
    case "done": {
      if (!state.visible) return result(state);
      const shouldPersist = !state.seen;
      return result(
        { ...state, visible: false, stepIndex: 0, seen: true, replay: false },
        shouldPersist ? "persist-seen" : null,
      );
    }
    default:
      return result(state);
  }
}
