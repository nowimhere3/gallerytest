// Primary is shared fallback preference, never a per-source association.
// Presence matters: an explicit source Fact<null> is P1 and blocks Primary.
export function primaryFallbackTarget({ primaryProfileId, hasSourceChoice = false,
  sessionOverride = false, safetyRefused = false } = {}) {
  return !hasSourceChoice && !sessionOverride && !safetyRefused ? primaryProfileId || null : null;
}
