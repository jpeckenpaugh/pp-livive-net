import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  VOICE_BANK,
  assertComplete,
  clipFor,
  clipPath,
  getHook,
  getPhrase,
  getVoice,
  hookCandidates,
  languageIds,
  phraseIds,
  voiceIds
} from '../src/voice/bank.js';
import policy from '../data/voice.json' with { type: 'json' };
import pools from '../data/voice_pools.json' with { type: 'json' };

function readRepoFile(relativePath) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url));
}

test('the vendored bank is internally complete', () => {
  assert.equal(assertComplete(), true);
  assert.equal(voiceIds().length, 15);
  assert.equal(phraseIds().length, 26);
  assert.equal(languageIds().length, 8);
});

test('every configured language has banked voices and a non-empty pool', () => {
  for (const language of policy.languages) {
    const banked = voiceIds().filter(voiceId => getVoice(voiceId).language === language.id);
    assert.ok(banked.length > 0, `${language.id} has no banked voices`);
    assert.ok(Array.isArray(pools.languages[language.id]), `${language.id} has no pool block`);
    assert.ok(pools.languages[language.id].length > 0, `${language.id} has an empty pool`);
  }
  for (const language of Object.keys(pools.languages)) {
    assert.ok(languageIds().includes(language), `pool language ${language} is not banked`);
  }
});

test('every pool entry points at a banked voice of the same language', () => {
  for (const [language, entries] of Object.entries(pools.languages)) {
    for (const entry of entries) {
      const voice = getVoice(entry.voiceId);
      assert.ok(voice, `${language} pool names unknown voice ${entry.voiceId}`);
      assert.equal(voice.language, language);
      assert.ok(entry.seed, 'pool entries need a seed');
      assert.ok([entry.pitchSt, entry.formantRatio, entry.tiltDbPerOct].every(Number.isFinite));
    }
  }
});

test('event aliases and prefetch events resolve to bank hooks', () => {
  for (const [event, hook] of Object.entries(policy.events)) {
    assert.ok(getHook(hook), `${event} maps to unknown hook ${hook}`);
    assert.ok(hookCandidates(hook).length > 0, `${event} maps to an empty hook ${hook}`);
  }
  for (const event of policy.prefetchEvents) {
    assert.ok(policy.events[event], `prefetch event ${event} is not aliased`);
  }
  assert.ok(Number(policy.prefetchRadiusTiles) > 0);
  assert.equal(typeof policy.enabled, 'boolean');
  assert.ok(Number(policy.volume) >= 0 && Number(policy.volume) <= 1);
});

test('every hook candidate resolves to a banked phrase and clip', () => {
  for (const hook of Object.keys(VOICE_BANK.hooks)) {
    for (const phraseId of hookCandidates(hook)) {
      assert.ok(getPhrase(phraseId), `${hook} names unknown phrase ${phraseId}`);
      for (const voiceId of voiceIds()) {
        assert.ok(clipFor(voiceId, phraseId), `${voiceId} has no clip for ${phraseId}`);
      }
    }
  }
});

test('clip paths resolve for every voice and phrase', () => {
  for (const voiceId of voiceIds()) {
    for (const phraseId of phraseIds()) {
      const path = clipPath(voiceId, phraseId);
      assert.equal(path, `vendor/rasp/audio/${voiceId}/${phraseId}.weba`);
    }
  }
  assert.equal(clipPath('missing', 'greet'), null);
});

test('banked clips and wasm match their recorded bytes and sha256', () => {
  for (const voiceId of voiceIds()) {
    for (const phraseId of phraseIds()) {
      const clip = clipFor(voiceId, phraseId);
      const bytes = readRepoFile(clip.path);
      assert.equal(bytes.length, clip.bytes, `${clip.path} byte count drifted`);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), clip.sha256, `${clip.path} hash drifted`);
    }
  }

  for (const entry of ['js', 'bin']) {
    const wasm = VOICE_BANK.wasm[entry];
    const bytes = readRepoFile(wasm.path);
    assert.equal(bytes.length, wasm.bytes, `${wasm.path} byte count drifted`);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), wasm.sha256, `${wasm.path} hash drifted`);
  }
});
