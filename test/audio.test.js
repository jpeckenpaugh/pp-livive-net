import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SOUND_CONFIG,
  SOUND_CUES,
  describeCue,
  cueDurationMs,
  cueIds,
  SoundBoard
} from '../src/audio.js';

function fakeStorage() {
  const store = new Map();
  return {
    getItem: key => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: key => store.delete(key),
    store
  };
}

test('every configured cue resolves to positive note specs', () => {
  assert.ok(Number(SOUND_CONFIG.masterGain) > 0);
  assert.ok(cueIds().length >= 6);

  for (const id of cueIds()) {
    const notes = describeCue(id);
    assert.ok(notes, `${id} should resolve`);
    assert.ok(notes.length > 0, `${id} needs notes`);
    for (const note of notes) {
      assert.ok(note.freq >= 40, `${id} frequency`);
      assert.ok(note.ms >= 20, `${id} duration`);
      assert.ok(note.at >= 0, `${id} offset`);
      assert.ok(note.gain >= 0, `${id} gain`);
      assert.equal(typeof note.wave, 'string');
    }
    assert.ok(cueDurationMs(id) > 0, `${id} duration`);
  }

  for (const id of ['game-open', 'place', 'turn', 'win', 'loss', 'draw', 'pickup']) {
    assert.ok(SOUND_CUES[id], `missing cue ${id}`);
  }
  assert.equal(describeCue('missing-cue'), null);
  assert.equal(describeCue(''), null);
  assert.equal(cueDurationMs('missing-cue'), 0);
});

test('sound preference toggles, persists, and survives a new board', () => {
  const storage = fakeStorage();
  const board = new SoundBoard({ storage, enabled: null });
  assert.equal(board.enabled, true, 'sound is on by default');

  assert.equal(board.toggle(), false);
  assert.equal(board.enabled, false);
  assert.deepEqual(JSON.parse(storage.store.get('playpark.sound.v1')), { enabled: false });

  const reloaded = new SoundBoard({ storage, enabled: null });
  assert.equal(reloaded.enabled, false);
  assert.equal(reloaded.toggle(), true);
  assert.equal(reloaded.enabled, true);
});

test('play fails soft when Web Audio is unavailable', () => {
  const board = new SoundBoard({ storage: fakeStorage(), enabled: true });
  assert.equal(board.supported, false);
  assert.doesNotThrow(() => board.play('game-open'));
  assert.equal(board.play('game-open'), false);
  assert.equal(board.play('missing-cue'), false);
  assert.equal(board.unlock(), false);

  const muted = new SoundBoard({ storage: fakeStorage(), enabled: false });
  assert.equal(muted.play('win'), false);
});
