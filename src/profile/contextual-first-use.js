// [SYNCV3 / STAGE-10 / CONTEXTUAL-FIRST-USE]
// The permanent Help disclosure owns the full definitions. These deliberately
// short introduction steps name the Help concepts they summarize so tests can
// catch vocabulary drift without duplicating the whole glossary here.
export const PROFILE_SYNC_INTRO_STEPS = Object.freeze([
  // [NORTH-STAR / N1 / PROGRESSIVE-DISCLOSURE]
  // BREADCRUMBS — WAS: five steps included two architecture lessons before any
  //   customer decision required them. BREADCRUMBS — IS: three customer-relevant
  //   steps remain; the no-copy/move/upload sentence stays because it earns trust.
  Object.freeze({
    id: "media",
    concepts: Object.freeze(["folder", "sync"]),
    title: "Your media stays where it is",
    body: "Browser Gallery opens your photos and videos from a Media Folder on this device or from a Media Folder in Google Drive. Browser Gallery does not upload, move or copy them.",
  }),
  Object.freeze({
    id: "curation",
    concepts: Object.freeze(["profile"]),
    title: "Your Curation",
    body: "As you browse, you can mark Favorites, hide items and add Tags. One saved set of those choices is a Curation. Create different Curations for different people, purposes, or ways of organizing your media.",
  }),
  Object.freeze({
    id: "sync",
    concepts: Object.freeze(["sync", "active-profile"]),
    title: "Sync your Curations",
    body: "To make your Favorites, Hidden items and Tags available on your other devices, connect each device you want to use to the same Google Drive Sync Folder. The Google Drive Sync Folder stores Browser Gallery information only. It is separate from a Google Drive Media Folder and does not contain or upload your photos and videos. Browser Gallery may ask before changing which Curation a device is using.",
  }),
]);

// [SYNCV3 / STAGE-10 / FINAL-UX-POLISH]
// [WHY: the approved action pattern is Back on the left and exactly one forward
// action — Next, then Done — always farthest right. Deriving that here makes the
// rule provable in the pure model instead of existing only as class toggles
// inside main.js.]
//
// BREADCRUMBS — IS: `Skip Intro` belongs to the FIRST-RUN introduction, which
//   the reader did not ask for. In replay the reader deliberately pressed
//   "Replay Introduction", so skipping it is semantically backwards; replay gets
//   an ordinary Close instead.
// BREADCRUMBS — WAS: Skip Intro was shown in both modes, which put a "get me out
//   of here" action under the pointer of someone who had just asked to see it.
// BREADCRUMBS — FUTURE: `close` is deliberately folded into the skip/done hide
//   path so replay can never write `seen: false`; keep it that way.
export function describeContextualFirstUseActions(state) {
  const lastIndex = PROFILE_SYNC_INTRO_STEPS.length - 1;
  const onLastStep = (state?.stepIndex ?? 0) >= lastIndex;
  const replay = state?.replay === true;
  return Object.freeze({
    back: (state?.stepIndex ?? 0) > 0,
    skip: !replay && !onLastStep,
    close: replay,
    next: !onLastStep,
    done: onLastStep,
  });
}

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
    case "close":
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
