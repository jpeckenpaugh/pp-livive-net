/**
 * Voice playback preferences: mute, volume, and the first-use cue flag, stored
 * separately from the synthesized sound effects (`playpark.sound.v1`).
 *
 * Pure over an injected storage so the defaults, clamping, and round-trip are
 * testable in Node. A missing or throwing storage is not an error: the caller
 * gets the defaults and writes are swallowed.
 */

export const VOICE_PREFS_KEY = 'playpark.voice.v1';
export const DEFAULT_PREFS = Object.freeze({ enabled: true, volume: 0.8, hintShown: false });

/** Clamp a volume to 0…1, falling back to the default for anything unusable. */
export function clampVolume(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_PREFS.volume;
  return Math.max(0, Math.min(1, number));
}

/**
 * Copy any stored shape into a complete `{ enabled, volume, hintShown }` block.
 * A prefs file written before the first-use cue simply lacks `hintShown`, which
 * reads as "not shown yet".
 */
export function normalizePrefs(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    enabled: source.enabled !== false,
    volume: clampVolume(source.volume),
    hintShown: source.hintShown === true
  };
}

/** Read the saved block, or the defaults when storage is absent or malformed. */
export function readVoicePrefs(storage) {
  try {
    const raw = storage?.getItem?.(VOICE_PREFS_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    return normalizePrefs(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

/** Persist a block and return the normalized values that were written. */
export function writeVoicePrefs(storage, prefs) {
  const next = normalizePrefs(prefs);
  try {
    storage?.setItem?.(VOICE_PREFS_KEY, JSON.stringify(next));
  } catch {
    // Voice preferences are a convenience; storage may be unavailable.
  }
  return next;
}
