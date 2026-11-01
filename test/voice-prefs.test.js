import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VOICE_PREFS_KEY,
  DEFAULT_PREFS,
  clampVolume,
  normalizePrefs,
  readVoicePrefs,
  writeVoicePrefs
} from '../src/voice/prefs.js';

function fakeStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: key => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    store
  };
}

test('voice prefs default to on at 0.8 with no storage', () => {
  assert.deepEqual(readVoicePrefs(null), { enabled: true, volume: 0.8 });
  assert.deepEqual(readVoicePrefs(undefined), { enabled: true, volume: 0.8 });
  assert.deepEqual({ ...DEFAULT_PREFS }, { enabled: true, volume: 0.8 });
});

test('voice prefs round-trip through injected storage', () => {
  const storage = fakeStorage();
  const saved = writeVoicePrefs(storage, { enabled: false, volume: 0.35 });
  assert.deepEqual(saved, { enabled: false, volume: 0.35 });
  assert.deepEqual(readVoicePrefs(storage), { enabled: false, volume: 0.35 });
  assert.ok(storage.store.has(VOICE_PREFS_KEY));
});

test('voice prefs clamp volume and ignore unrelated fields', () => {
  assert.equal(clampVolume(2), 1);
  assert.equal(clampVolume(-1), 0);
  assert.equal(clampVolume('0.25'), 0.25);
  assert.equal(clampVolume('loud'), DEFAULT_PREFS.volume);
  assert.deepEqual(normalizePrefs({ volume: 5, extra: true }), { enabled: true, volume: 1 });
  assert.deepEqual(normalizePrefs(null), { enabled: true, volume: 0.8 });
});

test('malformed saved prefs fall back per field, not wholesale', () => {
  const storage = fakeStorage({ [VOICE_PREFS_KEY]: '{not json' });
  assert.deepEqual(readVoicePrefs(storage), { enabled: true, volume: 0.8 });

  storage.store.set(VOICE_PREFS_KEY, JSON.stringify({ enabled: false }));
  assert.deepEqual(readVoicePrefs(storage), { enabled: false, volume: 0.8 });
});

test('voice prefs survive a storage that throws', () => {
  const storage = {
    getItem() {
      throw new Error('blocked');
    },
    setItem() {
      throw new Error('blocked');
    }
  };
  assert.deepEqual(readVoicePrefs(storage), { enabled: true, volume: 0.8 });
  assert.deepEqual(writeVoicePrefs(storage, { enabled: false, volume: 0.1 }), {
    enabled: false,
    volume: 0.1
  });
});
