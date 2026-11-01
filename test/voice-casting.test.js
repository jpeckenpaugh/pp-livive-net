import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VOICE_SCHEMA,
  castVoice,
  drawLanguage,
  drawSpec,
  hashSeed,
  hookPhrase,
  normalizeVoice,
  seededRandom,
  voiceForRecord
} from '../src/voice/casting.js';
import { VOICE_BANK } from '../src/voice/bank.js';
import policy from '../data/voice.json' with { type: 'json' };
import pools from '../data/voice_pools.json' with { type: 'json' };

function poolEntry(seed, voiceId) {
  return { seed, voiceId, archetype: 'neutral-mid', pitchSt: 1, formantRatio: 1, tiltDbPerOct: 0 };
}

const smallPolicy = {
  languages: [
    { id: 'aa', weight: 1 },
    { id: 'bb', weight: 3 }
  ]
};

const smallPools = {
  languages: {
    aa: [poolEntry('aa-one', 'v1'), poolEntry('aa-two', 'v1')],
    bb: [poolEntry('bb-one', 'v2'), poolEntry('bb-two', 'v2'), poolEntry('bb-three', 'v2')]
  }
};

test('drawLanguage follows normalised weights', () => {
  assert.equal(drawLanguage(smallPolicy, () => 0), 'aa');
  assert.equal(drawLanguage(smallPolicy, () => 0.2499), 'aa');
  assert.equal(drawLanguage(smallPolicy, () => 0.25), 'bb');
  assert.equal(drawLanguage(smallPolicy, () => 0.9999), 'bb');
});

test('drawLanguage rejects a policy with no weighted languages', () => {
  assert.throws(() => drawLanguage({ languages: [] }, () => 0), /no weighted languages/);
  assert.throws(() => drawLanguage({ languages: [{ id: 'x', weight: 0 }] }, () => 0), /no weighted languages/);
});

test('drawLanguage distributes keys by weight', () => {
  const rand = seededRandom('distribution');
  const counts = { aa: 0, bb: 0 };
  for (let i = 0; i < 4000; i++) counts[drawLanguage(smallPolicy, rand)]++;
  assert.ok(counts.aa / 4000 > 0.22 && counts.aa / 4000 < 0.28, JSON.stringify(counts));
  assert.ok(counts.bb / 4000 > 0.72 && counts.bb / 4000 < 0.78, JSON.stringify(counts));
});

test('drawSpec picks a pool entry and clamps a rand of exactly 1', () => {
  assert.deepEqual(drawSpec(smallPools, 'bb', () => 0), smallPools.languages.bb[0]);
  assert.deepEqual(drawSpec(smallPools, 'bb', () => 1), smallPools.languages.bb[2]);
  assert.throws(() => drawSpec(smallPools, 'zz', () => 0), /no entries for language zz/);
  assert.throws(() => drawSpec({ languages: { zz: [] } }, 'zz', () => 0), /no entries for language zz/);
});

test('castVoice is deterministic from an id and differs across ids', () => {
  const first = castVoice({ id: 'npc-1' });
  assert.deepEqual(castVoice({ id: 'npc-1' }), first);
  assert.equal(normalizeVoice(first).seed, first.seed);

  const ids = Array.from({ length: 12 }, (_, index) => `npc-${index}`);
  const seeds = new Set(ids.map(id => castVoice({ id }).seed));
  assert.ok(seeds.size > 6, 'ids should not collapse onto a handful of voices');
});

test('castVoice with an explicit rand is reproducible and ignores the id', () => {
  const rand = seededRandom('injected');
  const first = castVoice({ id: 'a', rand });
  const second = castVoice({ id: 'b', rand: seededRandom('injected') });
  assert.deepEqual(first, second);
});

test('castVoice emits only the persisted schema fields', () => {
  const voice = castVoice();
  assert.deepEqual(Object.keys(voice).sort(), [
    'formantRatio', 'lang', 'pitchSt', 'schema', 'seed', 'tiltDbPerOct', 'voiceId'
  ]);
  assert.equal(voice.schema, VOICE_SCHEMA);
  assert.equal(normalizeVoice(voice).seed, voice.seed);
});

test('a freshly cast voice seeds a pool entry that exists in the bank and pool', () => {
  for (let i = 0; i < 500; i++) {
    const voice = castVoice();
    const entry = pools.languages[voice.lang].find(candidate => candidate.seed === voice.seed);
    assert.ok(entry, `seed ${voice.seed} is not in the ${voice.lang} pool`);
    assert.equal(entry.voiceId, voice.voiceId);
    assert.equal(VOICE_BANK.voices[voice.voiceId].language, voice.lang);
  }
});

test('cast tick follows the authored language weights', () => {
  const rand = seededRandom('park-mix');
  const counts = {};
  for (let i = 0; i < 6000; i++) {
    const voice = castVoice({ rand });
    counts[voice.lang] = (counts[voice.lang] || 0) + 1;
  }
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  for (const language of policy.languages) {
    assert.ok(counts[language.id] > 0, `${language.id} was never drawn`);
    const share = counts[language.id] / total;
    const expected = language.weight / 100;
    assert.ok(Math.abs(share - expected) < 0.03, `${language.id} share ${share} vs ${expected}`);
  }
});

test('hookPhrase is stable per seed and rotates through attempts', () => {
  const seed = 'acorn-ierq5d8';
  const first = hookPhrase(VOICE_BANK, seed, 'stranger', 0);
  assert.equal(hookPhrase(VOICE_BANK, seed, 'stranger', 0), first);
  assert.ok(VOICE_BANK.hooks.stranger.includes(first));

  const second = hookPhrase(VOICE_BANK, seed, 'stranger', 1);
  assert.notEqual(second, first);

  const candidates = VOICE_BANK.hooks['minigame.win'];
  const seen = new Set();
  for (let attempt = 0; attempt < candidates.length; attempt++) {
    seen.add(hookPhrase(VOICE_BANK, seed, 'minigame.win', attempt));
  }
  assert.equal(seen.size, candidates.length);
  assert.equal(hookPhrase(VOICE_BANK, seed, 'minigame.win', candidates.length), hookPhrase(VOICE_BANK, seed, 'minigame.win', 0));
});

test('hookPhrase returns null for unknown, empty, and missing hooks', () => {
  assert.equal(hookPhrase(VOICE_BANK, 'seed', 'not-a-hook', 0), null);
  assert.equal(hookPhrase({ hooks: { empty: [] } }, 'seed', 'empty', 0), null);
  assert.equal(hookPhrase(null, 'seed', 'stranger', 0), null);
});

test('hashSeed is stable and seededRandom is reproducible', () => {
  assert.equal(hashSeed('acorn'), hashSeed('acorn'));
  assert.notEqual(hashSeed('acorn'), hashSeed('acorns'));
  const a = seededRandom('same');
  const b = seededRandom('same');
  assert.equal(a(), b());
  assert.equal(a(), b());
});

test('voiceForRecord keeps a valid block and repairs a broken one', () => {
  const stored = castVoice({ id: 'npc-7' });
  assert.deepEqual(voiceForRecord({ id: 'npc-7', voice: stored }), stored);
  assert.deepEqual(
    voiceForRecord({ id: 'npc-7', voice: { schema: 9, seed: 'x' } }),
    castVoice({ id: 'npc-7' })
  );
});
