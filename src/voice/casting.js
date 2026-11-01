import policyDoc from '../../data/voice.json' with { type: 'json' };
import poolsDoc from '../../data/voice_pools.json' with { type: 'json' };
import { getVoice } from './bank.js';

export const VOICE_SCHEMA = 1;

/** FNV-1a over UTF-16 code units. Small, stable, and enough for casting. */
export function hashSeed(text) {
  let hash = 0x811c9dc5;
  const value = String(text);
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** mulberry32 seeded from a string, so migration is reproducible across runs. */
export function seededRandom(seed) {
  let state = hashSeed(seed) || 1;
  return function random() {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Draw a language id from a weighted policy, normalised at draw time. */
export function drawLanguage(policy, rand = Math.random) {
  const languages = (policy?.languages || []).filter(lang => Number(lang.weight) > 0);
  const total = languages.reduce((sum, lang) => sum + Number(lang.weight), 0);
  if (!languages.length || total <= 0) throw new Error('voice policy has no weighted languages');

  let roll = rand() * total;
  for (const lang of languages) {
    roll -= Number(lang.weight);
    if (roll < 0) return lang.id;
  }
  return languages[languages.length - 1].id;
}

/** Draw a pre-resolved voice spec for a language from the committed pool. */
export function drawSpec(pool, lang, rand = Math.random) {
  const list = pool?.languages?.[lang];
  if (!Array.isArray(list) || !list.length) throw new Error(`voice pool has no entries for language ${lang}`);
  return list[Math.min(list.length - 1, Math.floor(rand() * list.length))];
}

/**
 * Deterministic phrase pick for a hook. Attempts rotate through the candidate
 * list, so consecutive beats in one conversation do not repeat a line.
 * Returns null for an unknown or empty hook.
 */
export function hookPhrase(bank, seed, hook, attempt = 0) {
  const candidates = bank?.hooks?.[hook];
  if (!Array.isArray(candidates) || !candidates.length) return null;
  const offset = Number.isFinite(Number(attempt)) ? Math.max(0, Math.floor(Number(attempt))) : 0;
  return candidates[(hashSeed(`${seed}:${hook}`) + offset) % candidates.length];
}

/**
 * Cast a complete voice block. Pass `rand` for injectable randomness, or `id`
 * alone for a deterministic cast (migration). With neither, it is a fresh
 * random identity.
 */
export function castVoice({ id = '', rand, policy = policyDoc, pools = poolsDoc } = {}) {
  const random = typeof rand === 'function'
    ? rand
    : (String(id) ? seededRandom(`voice:${id}`) : Math.random);
  const lang = drawLanguage(policy, random);
  const spec = drawSpec(pools, lang, random);
  return {
    schema: VOICE_SCHEMA,
    seed: spec.seed,
    lang,
    voiceId: spec.voiceId,
    pitchSt: spec.pitchSt,
    formantRatio: spec.formantRatio,
    tiltDbPerOct: spec.tiltDbPerOct
  };
}

/**
 * Validate and copy a stored voice block. Checked against the bank, not the
 * pool: a regenerated pool must never re-voice a stored NPC. Returns null for
 * anything malformed or unknown.
 */
export function normalizeVoice(block) {
  if (!block || typeof block !== 'object' || Array.isArray(block)) return null;
  if (block.schema !== VOICE_SCHEMA) return null;
  if (typeof block.seed !== 'string' || !block.seed) return null;
  if (typeof block.lang !== 'string' || !block.lang) return null;
  const voice = getVoice(block.voiceId);
  if (!voice || voice.language !== block.lang) return null;

  const pitchSt = Number(block.pitchSt);
  const formantRatio = Number(block.formantRatio);
  const tiltDbPerOct = Number(block.tiltDbPerOct);
  if (![pitchSt, formantRatio, tiltDbPerOct].every(Number.isFinite)) return null;

  return {
    schema: VOICE_SCHEMA,
    seed: block.seed,
    lang: block.lang,
    voiceId: block.voiceId,
    pitchSt,
    formantRatio,
    tiltDbPerOct
  };
}

/** Keep a valid stored voice, otherwise re-cast deterministically from the id. */
export function voiceForRecord(record) {
  return normalizeVoice(record?.voice) || castVoice({ id: String(record?.id || 'npc') });
}
