export function shouldReleaseWarmStart({
  preparedCount = 0,
  readyThreshold = 0,
  elapsedMs = 0,
  maxMs = 0,
  cancelled = false,
} = {}) {
  if (cancelled) return { release: true, reason: "cancelled" };
  if (preparedCount >= readyThreshold) return { release: true, reason: "ready" };
  if (elapsedMs >= maxMs) return { release: true, reason: "timeout" };
  return { release: false, reason: null };
}

// The pure release threshold knows nothing about viewer state. This second
// narrow predicate freezes the controller rule that a ready/timeout decision
// cannot open the curtain before the current viewer has reached a real terminal
// outcome. Explicit cancellation remains immediate because human intent wins.
export function canApplyWarmStartRelease({ decision, currentVisualSettled = false } = {}) {
  if (!decision?.release) return false;
  return decision.reason === "cancelled" || currentVisualSettled;
}
