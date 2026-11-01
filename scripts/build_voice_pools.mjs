#!/usr/bin/env node
/**
 * scripts/build_voice_pools.mjs
 *
 * Pre-resolves RASP voice specs into `data/voice_pools.json`, so casting an NPC
 * needs no wasm, no network and no `await`.
 *
 *   npm run voice:pools
 *
 * Seeds have Play Park's `makeSeed()` shape (`word-7 base36 chars`) and are
 * produced deterministically, so a re-run writes the same file. Knobs are rounded
 * to RASP's quantisation grid: pitch 0.05 st, formant 0.005, tilt 0.25 dB/oct.
 * No per-voice pool takes more than 20 seeds from one archetype.
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const BANK_PATH = 'data/voice_bank.json';
const POOLS_PATH = 'data/voice_pools.json';
const POOL_SIZE = 100;
const ARCHETYPE_CAP = 20;
const WORDS = ['fern', 'moss', 'clover', 'pebble', 'acorn', 'willow', 'bramble', 'daisy', 'maple', 'cricket'];

function fail(message) {
  throw new Error(message);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function seedAt(index) {
  const low = fnv1a(`playpark-voice-pool:${index}`);
  const high = fnv1a(`playpark-voice-pool:${index}:high`) % 36;
  const digits = (high * 36 ** 6 + (low % 36 ** 6)).toString(36).padStart(7, '0');
  return `${WORDS[low % WORDS.length]}-${digits}`;
}

function quantise(value, step, digits) {
  return Number((Math.round(value / step) * step).toFixed(digits));
}

function formatPools(pools) {
  const lines = ['{', '  "schema": 1,', `  "rasp": ${JSON.stringify(pools.rasp)},`, '  "languages": {'];
  const languages = Object.entries(pools.languages);
  languages.forEach(([language, entries], languageIndex) => {
    lines.push(`    ${JSON.stringify(language)}: [`);
    entries.forEach((entry, index) => {
      lines.push(`      ${JSON.stringify(entry)}${index < entries.length - 1 ? ',' : ''}`);
    });
    lines.push(`    ]${languageIndex < languages.length - 1 ? ',' : ''}`);
  });
  lines.push('  }', '}', '');
  return lines.join('\n');
}

async function main() {
  const bank = JSON.parse(await readFile(BANK_PATH, 'utf8'));
  if (bank.schema !== 1) {
    fail(`${BANK_PATH} has schema ${bank.schema}`);
  }

  for (const [key, file] of Object.entries(bank.wasm)) {
    const bytes = await readFile(file.path).catch(() => null);
    if (!bytes || bytes.length !== file.bytes || sha256(bytes) !== file.sha256) {
      fail(`${file.path} does not match ${BANK_PATH}; run npm run voice:vendor`);
    }
  }

  const rasp = await import(new URL('../vendor/rasp/rasp.js', import.meta.url).href);
  await rasp.default({ module_or_path: await readFile(bank.wasm.bin.path) });

  const voices = Object.entries(bank.voices).map(([id, voice]) => ({ id, ...voice }));
  const languages = [...new Set(voices.map((voice) => voice.language))];
  const pools = Object.fromEntries(languages.map((language) => [language, []]));
  const counts = new Map(voices.map((voice) => [voice.id, 0]));
  const archetypes = new Map(voices.map((voice) => [voice.id, new Map()]));
  const seen = new Set();

  const target = voices.length * POOL_SIZE;
  let filled = 0;
  for (let index = 1; filled < target; index += 1) {
    const seed = seedAt(index);
    if (seen.has(seed)) {
      continue;
    }
    seen.add(seed);
    const spec = rasp.describe(seed);
    if (!counts.has(spec.voiceId) || counts.get(spec.voiceId) >= POOL_SIZE) {
      continue;
    }
    const voiceArchetypes = archetypes.get(spec.voiceId);
    const archetypeCount = voiceArchetypes.get(spec.archetype) || 0;
    if (archetypeCount >= ARCHETYPE_CAP) {
      continue;
    }
    voiceArchetypes.set(spec.archetype, archetypeCount + 1);
    counts.set(spec.voiceId, counts.get(spec.voiceId) + 1);
    filled += 1;
    pools[bank.voices[spec.voiceId].language].push({
      seed,
      voiceId: spec.voiceId,
      archetype: spec.archetype,
      pitchSt: quantise(spec.pitchSt, 0.05, 2),
      formantRatio: quantise(spec.formantRatio, 0.005, 3),
      tiltDbPerOct: quantise(spec.tiltDbPerOct, 0.25, 2)
    });
  }

  const output = formatPools({
    schema: 1,
    rasp: { variantSchema: rasp.variant_schema(), corpusBuild: bank.corpusBuild },
    languages: pools
  });
  const current = await readFile(POOLS_PATH, 'utf8').catch(() => null);
  if (current !== output) {
    await writeFile(POOLS_PATH, output);
  }

  const summary = languages
    .map((language) => `${language} ${pools[language].length}`)
    .join(', ');
  console.log(
    `build ${bank.corpusBuild}: ${voices.length} voices, ${filled} seeds, ` +
      `${(Buffer.byteLength(output) / 1024).toFixed(0)} KB, ${summary}`
  );
  console.log(`${POOLS_PATH} ${current === output ? 'unchanged' : 'written'}`);
}

main().catch((error) => {
  console.error(`error: ${error.message}`);
  process.exitCode = 1;
});
