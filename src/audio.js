/**
 * Tiny synthesized sound board. No audio files, no network: every cue is a
 * short oscillator envelope described in data/sounds.json.
 *
 * Browser-only concerns (AudioContext, localStorage) are resolved lazily so the
 * module stays import-safe in Node tests.
 */
import soundConfig from '../data/sounds.json' with { type: 'json' };

export const SOUND_CONFIG = soundConfig;
export const SOUND_CUES = soundConfig.cues;
export const SOUND_STORAGE_KEY = soundConfig.storageKey || 'playpark.sound.v1';

const DEFAULT_NOTE = { at: 0, freq: 440, ms: 100, wave: 'sine', gain: 0.5 };
const MIN_NOTE_MS = 20;

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Resolve a cue to plain note specs, or null when the id is unknown. */
export function describeCue(cueId) {
  if (typeof cueId !== 'string' || !cueId) return null;
  const cue = SOUND_CUES[cueId];
  if (!isObject(cue) || !Array.isArray(cue.notes) || !cue.notes.length) return null;
  const notes = cue.notes
    .filter(isObject)
    .map(note => ({
      at: Math.max(0, Number(note.at) || 0),
      freq: Math.max(40, Number(note.freq) || DEFAULT_NOTE.freq),
      ms: Math.max(MIN_NOTE_MS, Number(note.ms) || DEFAULT_NOTE.ms),
      wave: typeof note.wave === 'string' && note.wave ? note.wave : DEFAULT_NOTE.wave,
      gain: Number.isFinite(Number(note.gain)) ? Math.max(0, Number(note.gain)) : DEFAULT_NOTE.gain
    }));
  return notes.length ? notes : null;
}

export function cueDurationMs(cueId) {
  const notes = describeCue(cueId);
  if (!notes) return 0;
  return notes.reduce((longest, note) => Math.max(longest, note.at + note.ms), 0);
}

export function cueIds() {
  return Object.keys(SOUND_CUES);
}

function readStoredEnabled(storage) {
  try {
    const raw = storage?.getItem?.(SOUND_STORAGE_KEY);
    if (!raw) return true;
    const parsed = JSON.parse(raw);
    return parsed?.enabled !== false;
  } catch {
    return true;
  }
}

export class SoundBoard {
  constructor({ config = soundConfig, storage = null, enabled = null } = {}) {
    this.config = config;
    this.storage = storage || (typeof globalThis !== 'undefined' ? globalThis.localStorage : null);
    this.enabled = enabled === null ? readStoredEnabled(this.storage) : Boolean(enabled);
    this.context = null;
    this.master = null;
    this.muted = !this.enabled;
  }

  get supported() {
    return typeof globalThis !== 'undefined'
      && Boolean(globalThis.AudioContext || globalThis.webkitAudioContext);
  }

  setEnabled(value) {
    this.enabled = Boolean(value);
    this.muted = !this.enabled;
    this.persist();
    if (!this.enabled && this.context) {
      try {
        this.context.suspend?.();
      } catch {
        // Ignore: a suspended context is best-effort.
      }
    }
    return this.enabled;
  }

  toggle() {
    return this.setEnabled(!this.enabled);
  }

  persist() {
    try {
      this.storage?.setItem?.(SOUND_STORAGE_KEY, JSON.stringify({ enabled: this.enabled }));
    } catch {
      // Sound preference is a convenience; storage may be unavailable.
    }
  }

  /** Create or resume the audio context. Call from a user gesture. */
  unlock() {
    if (!this.supported) return false;
    if (!this.context) {
      const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
      try {
        this.context = new Ctor();
      } catch {
        this.context = null;
        return false;
      }
      this.master = this.context.createGain();
      this.master.gain.value = Math.max(0, Math.min(1, Number(this.config.masterGain) || 0.2));
      this.master.connect(this.context.destination);
    }
    if (this.context.state === 'suspended' && this.enabled) {
      this.context.resume?.().catch?.(() => {});
    }
    return true;
  }

  /** Play a cue by id. Unknown cues and unsupported environments are no-ops. */
  play(cueId) {
    if (!this.enabled) return false;
    if (!this.unlock()) return false;
    const notes = describeCue(cueId);
    if (!notes) return false;
    const ctx = this.context;
    const master = this.master;
    if (!ctx || !master) return false;

    const start = ctx.currentTime + 0.001;
    for (const note of notes) {
      try {
        const oscillator = ctx.createOscillator();
        const envelope = ctx.createGain();
        oscillator.type = note.wave;
        oscillator.frequency.setValueAtTime(note.freq, start + note.at / 1000);
        envelope.gain.setValueAtTime(0.0001, start + note.at / 1000);
        envelope.gain.exponentialRampToValueAtTime(
          Math.max(0.0001, note.gain),
          start + note.at / 1000 + 0.012
        );
        envelope.gain.exponentialRampToValueAtTime(
          0.0001,
          start + (note.at + note.ms) / 1000
        );
        oscillator.connect(envelope);
        envelope.connect(master);
        oscillator.start(start + note.at / 1000);
        oscillator.stop(start + (note.at + note.ms) / 1000 + 0.02);
      } catch {
        // A dropped note should never break gameplay.
      }
    }
    return true;
  }
}
