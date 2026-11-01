import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VOICE_CACHE_LIMIT,
  VoiceEngine,
  cacheKey,
  createLru,
  normalizeTarget,
  phraseFor,
  resolveHook
} from '../src/voice/engine.js';
import { castVoice, voiceForRecord } from '../src/voice/casting.js';
import { hookCandidates, voiceIds } from '../src/voice/bank.js';
import { readVoicePrefs } from '../src/voice/prefs.js';

function fakeStorage() {
  const store = new Map();
  return {
    getItem: key => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    store
  };
}

const SPEC = castVoice({ id: 'npc-clover' });

test('cache keys carry every knob, the phrase, and the corpus build', () => {
  const base = cacheKey(SPEC, 'greet');
  assert.equal(base, cacheKey({ ...SPEC }, 'greet'));
  assert.notEqual(base, cacheKey(SPEC, 'hello'));
  assert.notEqual(base, cacheKey({ ...SPEC, pitchSt: SPEC.pitchSt + 0.25 }, 'greet'));
  assert.notEqual(base, cacheKey({ ...SPEC, formantRatio: SPEC.formantRatio + 0.01 }, 'greet'));
  assert.notEqual(base, cacheKey({ ...SPEC, tiltDbPerOct: SPEC.tiltDbPerOct + 0.5 }, 'greet'));
  assert.notEqual(base, cacheKey({ ...SPEC, voiceId: 'af_heart' === SPEC.voiceId ? 'am_fenrir' : 'af_heart' }, 'greet'));
  assert.notEqual(base, cacheKey(SPEC, 'greet', 'other-build'));
  assert.equal(cacheKey(null, 'greet'), null);
  assert.equal(cacheKey(SPEC, ''), null);
});

test('cache keys treat numeric strings and numbers alike', () => {
  assert.equal(
    cacheKey({ ...SPEC, pitchSt: 1 }, 'greet'),
    cacheKey({ ...SPEC, pitchSt: '1.0' }, 'greet')
  );
});

test('the LRU evicts the oldest entry and never exceeds its limit', () => {
  const lru = createLru(3);
  lru.set('a', 1);
  lru.set('b', 2);
  lru.set('c', 3);
  assert.equal(lru.get('a'), 1);
  lru.set('d', 4);
  assert.equal(lru.size, 3);
  assert.equal(lru.has('b'), false);
  assert.deepEqual(lru.keys(), ['c', 'a', 'd']);
});

test('the LRU default cap is the documented 20 buffers', () => {
  const lru = createLru();
  for (let index = 0; index < VOICE_CACHE_LIMIT + 5; index++) lru.set(`k${index}`, index);
  assert.equal(lru.size, VOICE_CACHE_LIMIT);
  assert.equal(VOICE_CACHE_LIMIT, 20);
});

test('events resolve through aliases to a hook and rotate by attempt', () => {
  assert.equal(resolveHook('dialogue.stranger'), 'stranger');
  assert.equal(resolveHook('stranger'), 'stranger');
  assert.equal(resolveHook('not-an-event'), null);
  assert.equal(resolveHook(''), null);

  const candidates = hookCandidates('stranger');
  const first = phraseFor(SPEC, 'dialogue.stranger', 0);
  const second = phraseFor(SPEC, 'dialogue.stranger', 1);
  assert.ok(candidates.includes(first));
  assert.ok(candidates.includes(second));
  assert.notEqual(first, second);
  assert.equal(phraseFor(SPEC, 'dialogue.stranger', 0), phraseFor(SPEC, 'stranger', 0));
  assert.equal(phraseFor(SPEC, 'not-an-event', 0), null);
});

test('a character record and its spec normalize to the same voice', () => {
  const record = { id: 'npc-clover', name: 'Clover', voice: SPEC };
  assert.deepEqual(normalizeTarget(record), voiceForRecord(record));
  assert.deepEqual(normalizeTarget(SPEC), voiceForRecord(record));
  assert.equal(normalizeTarget({ id: 'no-voice' }), null);
  assert.equal(normalizeTarget(null), null);
});

test('a damaged record is re-cast deterministically, never dropped', () => {
  const broken = { id: 'npc-7', voice: { schema: 99, voiceId: 'nope' } };
  const first = normalizeTarget(broken);
  const second = normalizeTarget({ ...broken });
  assert.ok(voiceIds().includes(first.voiceId));
  assert.deepEqual(first, second);
});

test('speak fails quietly without an AudioContext and keeps the first error', async t => {
  const info = t.mock.method(console, 'info', () => {});
  const engine = new VoiceEngine({ storage: fakeStorage(), idbFactory: null, fetchFn: null });
  assert.equal(engine.supported, false);

  const record = { id: 'npc-clover', voice: SPEC };
  assert.equal(await engine.speak(record, 'dialogue.stranger'), false);
  const firstError = engine.lastError;
  assert.ok(firstError instanceof Error);
  assert.equal(info.mock.callCount(), 1);

  assert.equal(await engine.speak(record, 'dialogue.friend'), false);
  assert.equal(engine.lastError, firstError);
  assert.equal(info.mock.callCount(), 1);
});

test('speak returns false for unknown events and missing targets without an error', async () => {
  const engine = new VoiceEngine({ storage: fakeStorage(), idbFactory: null });
  assert.equal(await engine.speak({ id: 'npc-clover', voice: SPEC }, 'not-an-event'), false);
  assert.equal(engine.lastError, null);
  assert.equal(await engine.speak(null, 'dialogue.stranger'), false);
  assert.equal(await engine.speak({ id: 'no-voice' }, 'dialogue.stranger'), false);
  assert.equal(engine.lastError, null);
});

test('prefetch is a no-op in a headless environment', async () => {
  const engine = new VoiceEngine({ storage: fakeStorage(), idbFactory: null });
  assert.equal(await engine.prefetch({ id: 'npc-clover', voice: SPEC }, ['dialogue.stranger']), 0);
});

test('volume and mute persist through the injected storage', () => {
  const storage = fakeStorage();
  const engine = new VoiceEngine({ storage, idbFactory: null, prefs: { enabled: true, volume: 0.5 } });
  assert.equal(engine.volume, 0.5);
  assert.equal(engine.setVolume(1.4), 1);
  assert.deepEqual(readVoicePrefs(storage), { enabled: true, volume: 1 });

  assert.equal(engine.setEnabled(false), false);
  assert.deepEqual(readVoicePrefs(storage), { enabled: false, volume: 1 });

  const restored = new VoiceEngine({ storage, idbFactory: null });
  assert.equal(restored.enabled, false);
  assert.equal(restored.volume, 1);
});

test('mute stops every actor and stays a no-op with none playing', () => {
  const engine = new VoiceEngine({ storage: fakeStorage(), idbFactory: null });
  assert.equal(engine.stopAll(), undefined);
  assert.equal(engine.stopActor('ghost'), false);
  assert.equal(engine.setEnabled(false), false);
});
