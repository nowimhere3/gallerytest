export class MediaRuntime {
  #items = [];
  #currentIndex = -1;
  #timerId = null;
  #intervalMs = 5000;
  #shuffle = true;
  #loop = true;
  #isPlaying = false;
  #listeners = new Set();

  // [UI-REDESIGN / STAGE 6] [PM-HIDE-UNDO-WAYPOINT-RUNTIME-FIX]
  // WHAT: A plain incrementing/decrementing counter — +1 on every
  // successful next() move, -1 on every successful previous() move,
  // touched in EVERY branch that actually moves #currentIndex (shuffle
  // and sequential alike), regardless of what triggered the call: a
  // manual button/keyboard press, the slideshow's own interval timer, or
  // a video's "ended" event calling notifyVideoEnded() -> next(). Exposed
  // read-only via getState().navigationStep.
  // WHY this exists: a caller (main.js) that wants to know "how far has
  // the user moved past some earlier position" cannot reliably track that
  // by wrapping its OWN button click handlers — next()/previous() are also
  // called directly from INSIDE this class (the interval timer, video-end)
  // where no external caller ever runs, so any external interception
  // silently undercounts real movement the moment autoplay is involved.
  // This counter is instead updated at the one place both paths already
  // funnel through, so it can never be bypassed by an internal auto-advance
  // the way a call-site hook can.
  // Deliberately NOT reset by load()/clear() — a caller wanting to measure
  // "steps since some checkpoint" reads this value AT the checkpoint and
  // compares the DELTA later; resetting it here would just move the
  // bookkeeping burden onto guessing when a caller's checkpoint should also
  // reset, for zero benefit (a delta computation is agnostic to the
  // absolute baseline). #advanceIfCurrentHidden() deliberately does NOT
  // touch it either — that moves the CURRENT item off a newly-hidden one,
  // which is a landing point a caller measures FROM, not a step away from
  // anywhere.
  #navigationStep = 0;

  // Shuffle "back history" — a browser-style history stack. #history holds
  // the sequence of indices actually visited (oldest first); #historyCursor
  // points at the currently-displayed entry. Only used in shuffle mode —
  // sequential mode is already reversible on its own and doesn't need it.
  // This is SESSION state: it's about "what have I looked at in this tab",
  // not "what do I want to keep" — so it does NOT go through Profile.
  #history = [];
  #historyCursor = -1;
  #MAX_HISTORY = 500;
  #visitedShuffleIndices = new Set();

  // Profile (favorites, etc.) is USER state, not session state — it's
  // owned by ProfileStore, not by the runtime. The runtime only reads it
  // (to stamp isFavorite onto items) and writes to it via ProfileStore's
  // own API (toggleFavorite) — it never keeps its own copy of favorite
  // data. Subscribing here means an external profile change (e.g. an
  // Import) is immediately reflected in whatever's currently loaded,
  // without the runtime needing to know *how* the profile changed.
  #profile = null;
  #unsubscribeProfile = null;

  constructor({ profile = null } = {}) {
    this.setProfile(profile);
  }

  setProfile(profile) {
    if (this.#unsubscribeProfile) {
      this.#unsubscribeProfile();
      this.#unsubscribeProfile = null;
    }

    this.#profile = profile || null;

    if (this.#profile) {
      this.#unsubscribeProfile = this.#profile.subscribe(() => this.#reapplyProfile());
      this.#reapplyProfile();
    }
  }

  #stampProfileFields(item) {
    item.isFavorite = this.#profile ? this.#profile.isFavorite(item.relativePath) : Boolean(item.isFavorite);
    item.isHidden = this.#profile ? this.#profile.isHidden(item.relativePath) : Boolean(item.isHidden);
  }

  #reapplyProfile() {
    this.#items.forEach((item) => this.#stampProfileFields(item));
    // Runtime doesn't structurally know what "Presentation Mode" is (that's
    // a main.js/CSS-only concept), so "advance immediately when the
    // current item is hidden" lives here instead, triggered generically
    // off any profile change. That means it correctly handles a bulk
    // Import hiding the current item, not just the Hide button.
    this.#advanceIfCurrentHidden();
    this.#emit();
  }

  // Toggles the favorite status of whatever's currently displayed. This is
  // the ONLY path either UI (Gallery's favorite button or Presentation
  // Mode's overlay favorite button) should use — both call this exact
  // method, so there is exactly one place that writes favorite state.
  toggleFavorite() {
    const item = this.getCurrentItem();
    if (!item || !this.#profile) return;
    this.#profile.toggleFavorite(item.relativePath);
    // #reapplyProfile() runs synchronously via the subscription above and
    // already calls #emit() — no need to do it again here.
  }

  // Toggles the hidden status of whatever's currently displayed. This is
  // the ONLY path that should write hidden state — mirrors toggleFavorite
  // exactly. If this makes the current item hidden, #reapplyProfile (run
  // synchronously via the profile subscription) will immediately advance
  // Presentation to the next visible item.
  toggleHidden() {
    const item = this.getCurrentItem();
    if (!item || !this.#profile) return;
    this.#profile.toggleHidden(item.relativePath);
  }

  load(items) {
    this.stop();
    this.#items = Array.isArray(items) ? [...items] : [];
    this.#items.forEach((item) => this.#stampProfileFields(item));
    this.#currentIndex = this.#items.length ? 0 : -1;
    this.#resetHistory();
    this.#advanceIfCurrentHidden();
    this.#emit();
  }

  subscribe(listener) {
    this.#listeners.add(listener);
    listener(this.getState());
    return () => this.#listeners.delete(listener);
  }

  getState() {
    return {
      items: [...this.#items],
      currentIndex: this.#currentIndex,
      currentItem: this.getCurrentItem(),
      isPlaying: this.#isPlaying,
      intervalMs: this.#intervalMs,
      shuffle: this.#shuffle,
      loop: this.#loop,
      hasItems: this.#items.length > 0,
      // Distinct from hasItems: true only if at least one loaded item is
      // NOT hidden. Lets the UI tell "nothing loaded yet" apart from
      // "everything loaded is hidden" (Success Criteria Scenario 7).
      hasVisibleItems: this.#items.some((item) => !item.isHidden),
      total: this.#items.length,
      // true while we're playing but deliberately NOT running a timer,
      // because the current item is a video we're letting play to completion
      waitingOnVideo: this.#isPlaying && this.#timerId === null && this.#isCurrentItemVideo(),
      // [UI-REDESIGN / STAGE 6] [PM-HIDE-UNDO-WAYPOINT-RUNTIME-FIX]
      // See #navigationStep's own declaration comment for the full WHAT/WHY
      // — a caller measuring "steps since some earlier position" reads this
      // at that earlier position and compares the delta later.
      navigationStep: this.#navigationStep,
    };
  }

  getCurrentItem() {
    if (this.#currentIndex < 0 || this.#currentIndex >= this.#items.length) {
      return null;
    }
    return this.#items[this.#currentIndex];
  }

  setIntervalMs(ms) {
    const nextMs = Number(ms);
    if (!Number.isFinite(nextMs) || nextMs < 1000) return;

    this.#intervalMs = nextMs;
    this.#scheduleAdvance();
    this.#emit();
  }

  setShuffle(enabled) {
    this.#shuffle = Boolean(enabled);
    this.#emit();
  }

  setLoop(enabled) {
    this.#loop = Boolean(enabled);
    this.#emit();
  }

  // [UI-REDESIGN / Stage 5] `keepHistory` is opt-in and OFF by default, so
  // every existing caller keeps the exact behavior it has always had: a
  // fresh list needs a fresh history, which is right for reloadRuntime()'s
  // preserveId restore and for the deferred-flush fallback.
  //
  // With it ON, this behaves like following a link in a browser instead of
  // opening a new session: forward history is truncated, the picked index
  // becomes the newest entry, and everything visited before it stays
  // reachable via previous(). Used by Gallery thumbnail selection, which is
  // a navigation within the current sequence, not a new sequence.
  setCurrentIndex(index, { keepHistory = false } = {}) {
    if (!this.#items.length) return;
    if (index < 0 || index >= this.#items.length) return;

    this.#currentIndex = index;

    if (keepHistory) {
      this.#history.splice(this.#historyCursor + 1);
      // Re-picking the item already at the head would add a duplicate entry
      // that previous() would then have to step over twice.
      if (this.#history[this.#history.length - 1] !== index) {
        this.#history.push(index);
      }
      this.#historyCursor = this.#history.length - 1;
      this.#visitedShuffleIndices.add(index);
      this.#capHistory();
    } else {
      this.#resetHistory();
    }

    this.#scheduleAdvance();
    this.#emit();
  }

  // [UI-REDESIGN / Stage 5] Drops ONE item from the sequence in place,
  // keeping visit history intact.
  //
  // WHY THIS EXISTS: load() is the only other way to change the item list,
  // and it calls #resetHistory(), which collapses #history to just the
  // current index. With Shuffle on — the default — previous() is driven
  // entirely by that history, so a reload left Back with nowhere to go and
  // the sequence behaved as though it started at the item after the removed
  // one. That is correct for a genuinely new list (a fresh load, a filter
  // switch) and wrong for "one item stopped matching the active filter",
  // which is what this method is for.
  //
  // History holds INDICES, so removing an item shifts every later entry.
  // Everything below is that remap: drop visits to the removed item, shift
  // the rest down by one, and collapse the consecutive duplicates that
  // dropping an entry can create (A,D,A would otherwise become A,A).
  // #visitedShuffleIndices is remapped the same way, or the shuffle cycle
  // would start excluding the wrong items.
  //
  // Returns false if the id is not present, so the caller can fall back to a
  // full reload rather than assume this worked.
  removeItemById(id) {
    const removedIndex = this.#items.findIndex((item) => item.id === id);
    if (removedIndex === -1) return false;

    const wasCurrent = this.#currentIndex === removedIndex;
    this.#items.splice(removedIndex, 1);

    const shift = (index) => (index > removedIndex ? index - 1 : index);

    const history = [];
    // Tracks where the cursor lands as entries are dropped/shifted, so Back
    // resumes from the same place in the visit order rather than the start.
    let cursor = -1;
    this.#history.forEach((index, position) => {
      const withinCursor = position <= this.#historyCursor;
      if (index === removedIndex) {
        if (withinCursor) cursor = history.length - 1;
        return;
      }
      const mapped = shift(index);
      if (history.length && history[history.length - 1] === mapped) {
        if (withinCursor) cursor = history.length - 1;
        return;
      }
      history.push(mapped);
      if (withinCursor) cursor = history.length - 1;
    });

    this.#history = history;
    this.#historyCursor = history.length ? Math.min(Math.max(cursor, 0), history.length - 1) : -1;

    this.#visitedShuffleIndices = new Set(
      [...this.#visitedShuffleIndices].filter((index) => index !== removedIndex).map(shift)
    );

    if (!this.#items.length) {
      this.#currentIndex = -1;
    } else if (wasCurrent) {
      // The removed item's slot is now occupied by whatever followed it,
      // which is where the user should be standing.
      this.#currentIndex = Math.min(removedIndex, this.#items.length - 1);
      // Record that position as the newest visit so Back steps to the entry
      // before the removed item rather than two entries before it.
      if (this.#history[this.#historyCursor] !== this.#currentIndex) {
        this.#history.splice(this.#historyCursor + 1);
        this.#history.push(this.#currentIndex);
        this.#historyCursor = this.#history.length - 1;
        this.#visitedShuffleIndices.add(this.#currentIndex);
      }
    } else {
      this.#currentIndex = shift(this.#currentIndex);
    }

    this.#capHistory();
    this.#scheduleAdvance();
    this.#emit();
    return true;
  }

  next() {
    if (!this.#items.length) return;

    if (this.#shuffle && this.#items.length > 1) {
      // Walk any existing forward ("Redo") history first, skipping entries
      // that are now hidden — an item can be hidden after it was visited.
      let cursor = this.#historyCursor;
      while (cursor < this.#history.length - 1) {
        cursor += 1;
        const candidateIndex = this.#history[cursor];
        if (this.#isItemVisible(this.#items[candidateIndex])) {
          this.#historyCursor = cursor;
          this.#currentIndex = candidateIndex;
          this.#navigationStep += 1;
          this.#scheduleAdvance();
          this.#emit();
          return;
        }
      }

      // Picking a "new" item after having gone Back (or after forward
      // history ran out of visible entries) discards whatever forward
      // history existed — same as a browser visiting a fresh page after
      // you've clicked Back a few times.
      this.#history.splice(this.#historyCursor + 1);

      const eligibleIndices = this.#visibleIndices();

      if (!eligibleIndices.length) {
        // Every item is hidden — nothing left to shuffle to.
        this.stop();
        return;
      }

      let pool = eligibleIndices.filter((index) => !this.#visitedShuffleIndices.has(index));

      if (!pool.length) {
        // Completed a full cycle through the currently-visible items —
        // start a new cycle, but still avoid repeating the current item
        // immediately if any other visible item exists.
        this.#visitedShuffleIndices.clear();
        pool = eligibleIndices.filter((index) => index !== this.#currentIndex);
        if (!pool.length) pool = eligibleIndices;
      }

      const nextIndex = pool[Math.floor(Math.random() * pool.length)];

      this.#currentIndex = nextIndex;
      this.#history.push(nextIndex);
      this.#historyCursor = this.#history.length - 1;
      this.#visitedShuffleIndices.add(nextIndex);
      this.#capHistory();
      this.#navigationStep += 1;

      this.#scheduleAdvance();
      this.#emit();
      return;
    }

    const targetIndex = this.#findVisibleForward(this.#currentIndex);

    if (targetIndex === -1) {
      // No visible item ahead (and either not looping, or every item is
      // hidden) — stop gracefully instead of advancing onto nothing.
      this.stop();
      return;
    }

    this.#currentIndex = targetIndex;
    this.#navigationStep += 1;
    this.#scheduleAdvance();
    this.#emit();
  }

  previous() {
    if (!this.#items.length) return;

    if (this.#shuffle && this.#items.length > 1) {
      // True back history: revisit what was actually shown before, no new
      // random pick, exactly like a browser Back button — but skip any
      // entry that's now hidden.
      let cursor = this.#historyCursor;
      while (cursor > 0) {
        cursor -= 1;
        const candidateIndex = this.#history[cursor];
        if (this.#isItemVisible(this.#items[candidateIndex])) {
          this.#historyCursor = cursor;
          this.#currentIndex = candidateIndex;
          this.#navigationStep -= 1;
          this.#scheduleAdvance();
          this.#emit();
          return;
        }
      }

      // Nothing visible further back — Back does nothing at the oldest
      // usable entry, same as before.
      return;
    }

    const targetIndex = this.#findVisibleBackward(this.#currentIndex);
    if (targetIndex === -1) return;

    this.#navigationStep -= 1;
    this.#currentIndex = targetIndex;
    this.#scheduleAdvance();
    this.#emit();
  }

  play() {
    if (!this.#items.length || this.#isPlaying) return;

    this.#isPlaying = true;
    this.#scheduleAdvance();
    this.#emit();
  }

  stop() {
    if (!this.#isPlaying && this.#timerId === null) return;

    this.#isPlaying = false;
    this.#clearTimer();
    this.#emit();
  }

  /**
   * Called by the presentation layer when the current <video> element
   * fires its native "ended" event. This is how a playing video is
   * allowed to run to completion instead of being cut off by the
   * interval timer, which only ever governs images/gifs.
   */
  notifyVideoEnded() {
    if (!this.#isPlaying) return;
    this.next();
  }

  #isCurrentItemVideo() {
    const item = this.getCurrentItem();
    return Boolean(item && item.kind === "video");
  }

  // ---- Hidden Media (Phase 4 — Presentation Filter) ---------------------

  #isItemVisible(item) {
    return Boolean(item) && !item.isHidden;
  }

  #visibleIndices() {
    const indices = [];
    this.#items.forEach((item, index) => {
      if (this.#isItemVisible(item)) indices.push(index);
    });
    return indices;
  }

  // Sequential-mode forward search: tries fromIndex+1..end first, then
  // (only if #loop is on) wraps to 0..fromIndex-1. Used by next().
  #findVisibleForward(fromIndex) {
    const total = this.#items.length;

    for (let i = fromIndex + 1; i < total; i++) {
      if (this.#isItemVisible(this.#items[i])) return i;
    }

    if (this.#loop) {
      for (let i = 0; i < fromIndex; i++) {
        if (this.#isItemVisible(this.#items[i])) return i;
      }
    }

    return -1;
  }

  // Sequential-mode backward search: mirrors #findVisibleForward. Used by
  // previous().
  #findVisibleBackward(fromIndex) {
    const total = this.#items.length;

    for (let i = fromIndex - 1; i >= 0; i--) {
      if (this.#isItemVisible(this.#items[i])) return i;
    }

    if (this.#loop) {
      for (let i = total - 1; i > fromIndex; i--) {
        if (this.#isItemVisible(this.#items[i])) return i;
      }
    }

    return -1;
  }

  // Recovery search used only by #advanceIfCurrentHidden: always wraps
  // regardless of the #loop setting, since "the current item just became
  // invalid, find literally any visible item" isn't a normal navigation
  // step and shouldn't be constrained by the user's loop preference.
  #findAnyVisibleIndex(fromIndex) {
    const total = this.#items.length;

    for (let step = 1; step <= total; step++) {
      const index = (fromIndex + step) % total;
      if (this.#isItemVisible(this.#items[index])) return index;
    }

    return -1;
  }

  // If the currently-displayed item is hidden, immediately move off of it
  // (Success Criteria Scenario 1). Called after every profile change and
  // after load() — never called mid-next()/previous(), which already skip
  // hidden items on their own. Does not emit; callers emit once themselves.
  #advanceIfCurrentHidden() {
    const item = this.getCurrentItem();
    if (!item || !item.isHidden) return;

    const targetIndex = this.#findAnyVisibleIndex(this.#currentIndex);

    if (targetIndex === -1) {
      // Every loaded item is hidden — stop gracefully (Scenario 7). The
      // UI checks state.hasVisibleItems to show an appropriate message
      // rather than rendering this now-hidden current item.
      this.stop();
      return;
    }

    this.#currentIndex = targetIndex;

    // Keep shuffle history consistent with a normal forced move, so Back
    // still behaves sensibly afterward.
    if (this.#shuffle) {
      this.#history.splice(this.#historyCursor + 1);
      this.#history.push(targetIndex);
      this.#historyCursor = this.#history.length - 1;
      this.#visitedShuffleIndices.add(targetIndex);
      this.#capHistory();
    }

    this.#scheduleAdvance();
  }

  #clearTimer() {
    if (this.#timerId !== null) {
      window.clearTimeout(this.#timerId);
      this.#timerId = null;
    }
  }

  #scheduleAdvance() {
    this.#clearTimer();
    if (!this.#isPlaying) return;

    // Videos advance on their own "ended" event (see notifyVideoEnded),
    // not on the interval timer. Only images/gifs use the timer.
    if (this.#isCurrentItemVideo()) return;

    this.#timerId = window.setTimeout(() => {
      this.next();
    }, this.#intervalMs);
  }

  clear() {
    this.stop();
    this.#items = [];
    this.#currentIndex = -1;
    this.#resetHistory();
    this.#emit();
  }

  #resetHistory() {
    this.#history = this.#currentIndex >= 0 ? [this.#currentIndex] : [];
    this.#historyCursor = this.#history.length ? 0 : -1;
    this.#visitedShuffleIndices = this.#history.length ? new Set(this.#history) : new Set();
  }

  // Keeps the history stack from growing unbounded over a long-running
  // (kiosk-style) shuffle session. Trims from whichever end is farther
  // from the cursor, so the currently-displayed position never shifts.
  #capHistory() {
    const excess = this.#history.length - this.#MAX_HISTORY;
    if (excess <= 0) return;

    if (this.#historyCursor >= excess) {
      this.#history.splice(0, excess);
      this.#historyCursor -= excess;
    } else {
      this.#history.splice(this.#history.length - excess, excess);
    }
  }

  #emit() {
    const state = this.getState();
    for (const listener of this.#listeners) {
      listener(state);
    }
  }
}
