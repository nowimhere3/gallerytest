export class MediaRuntime {
  #items = [];
  #currentIndex = -1;
  #timerId = null;
  #intervalMs = 5000;
  #shuffle = true;
  #loop = true;
  #isPlaying = false;
  #listeners = new Set();

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

  setCurrentIndex(index) {
    if (!this.#items.length) return;
    if (index < 0 || index >= this.#items.length) return;

    this.#currentIndex = index;
    this.#resetHistory();
    this.#scheduleAdvance();
    this.#emit();
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
