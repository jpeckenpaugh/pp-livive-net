#!/usr/bin/env node
/**
 * scripts/vendor_voice_bank.mjs
 *
 * Vendors the RASP engine and a curated slice of the dgen Kokoro bake into
 * `vendor/rasp/`, and writes `data/voice_bank.json`.
 *
 *   npm run voice:vendor                    reuse the committed snapshot (offline)
 *   npm run voice:vendor -- --check         verify the tree, no network
 *   npm run voice:vendor -- --build <id>    re-vendor a newer corpus build (network)
 *
 * The published registry is the source of truth (https://rasp.livive.net/registry.json).
 * A pruned copy lives at `vendor/rasp/registry.json`; it is the offline oracle for
 * `--check` and the reason a normal re-run never touches the network.
 *
 * Slice: first female + first male per language in registry order (French has one
 * voice), all 26 phrases. Both the slice and the corpus build are recorded here.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const BASE_URL = 'https://rasp.livive.net/';
const REGISTRY_URL = `${BASE_URL}registry.json`;
const PINNED_BUILD = '3e81bd1f069b';
const INPUTS_VERSION = 4; // dgen inputs.json v4; the registry does not carry it
const VOICES_PER_LANGUAGE = 2;
const POOL_SIZE = 100;
const SNAPSHOT_PATH = 'vendor/rasp/registry.json';
const BANK_PATH = 'data/voice_bank.json';
const POOLS_PATH = 'data/voice_pools.json';
const WASM_FILES = [
  { key: 'js', url: 'wasm/rasp.js', path: 'vendor/rasp/rasp.js' },
  { key: 'bin', url: 'wasm/rasp_bg.wasm', path: 'vendor/rasp/rasp_bg.wasm' }
];

const state = { check: false, online: false, reused: 0, downloaded: 0, snapshotText: null };

function fail(message) {
  throw new Error(message);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function bytesLabel(count) {
  return count < 1024 ? `${count} B` : `${(count / 1024 / 1024).toFixed(2)} MB`;
}

async function writeIfChanged(path, text) {
  const current = await readFile(path, 'utf8').catch(() => null);
  if (current === text) {
    return false;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
  return true;
}

async function fetchBytes(url) {
  let response;
  try {
    response = await fetch(url);
  } catch (cause) {
    fail(`cannot reach ${url} (offline?): ${cause.message}`);
  }
  if (!response.ok) {
    fail(`${url} returned HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function parseArgs(argv) {
  const options = { check: false, build: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--check') {
      options.check = true;
    } else if (arg === '--build') {
      options.build = argv[i + 1];
      i += 1;
      if (!options.build) {
        fail('--build needs a corpus build id');
      }
    } else {
      fail(`unknown argument ${arg}`);
    }
  }
  return options;
}

function selectVoices(registry) {
  const picked = [];
  for (const language of registry.languages) {
    const candidates = registry.voices.filter((voice) => voice.language === language);
    const perLanguage = [];
    for (const gender of ['female', 'male']) {
      const voice = candidates.find((candidate) => candidate.gender === gender);
      if (voice) {
        perLanguage.push(voice);
      }
    }
    if (perLanguage.length === 0) {
      fail(`registry has no usable voice for ${language}`);
    }
    picked.push(...perLanguage.slice(0, VOICES_PER_LANGUAGE));
  }
  return picked;
}

function pruneRegistry(registry, wasm) {
  const voices = selectVoices(registry);
  const phrases = Object.fromEntries(
    Object.values(registry.phrases).map((phrase) => [
      phrase.id,
      { text: phrase.text, group: phrase.group, translations: phrase.translations }
    ])
  );
  const files = {};
  for (const voice of voices) {
    const voiceFiles = registry.files[voice.id];
    if (!voiceFiles) {
      fail(`registry has no files for ${voice.id}`);
    }
    files[voice.id] = {};
    for (const phraseId of Object.keys(phrases)) {
      const file = voiceFiles[phraseId];
      if (!file) {
        fail(`registry has no ${phraseId}.weba for ${voice.id}`);
      }
      files[voice.id][phraseId] = {
        path: file.path,
        bytes: file.bytes,
        durationMs: file.durationMs,
        sha256: file.sha256
      };
    }
  }
  for (const [hook, phraseIds] of Object.entries(registry.hooks)) {
    for (const phraseId of phraseIds) {
      if (!phrases[phraseId]) {
        fail(`hook ${hook} references unknown phrase ${phraseId}`);
      }
    }
  }
  return {
    schema: 1,
    source: REGISTRY_URL,
    build: {
      id: registry.build.id,
      createdAt: registry.build.createdAt,
      sourceHash: registry.build.sourceHash,
      clipVersion: registry.build.clipVersion,
      inputsVersion: INPUTS_VERSION
    },
    voices: voices.map((voice) => ({
      id: voice.id,
      language: voice.language,
      locale: voice.locale,
      gender: voice.gender,
      accent: voice.accent,
      country: voice.country
    })),
    phrases,
    hooks: registry.hooks,
    files,
    wasm
  };
}

async function resolveSnapshot(options) {
  const existing = await readFile(SNAPSHOT_PATH, 'utf8').catch(() => null);
  const snapshot = existing ? JSON.parse(existing) : null;

  if (options.check) {
    if (!snapshot) {
      fail(`missing ${SNAPSHOT_PATH}; run npm run voice:vendor first`);
    }
    if (options.build && options.build !== snapshot.build.id) {
      fail(`--check cannot change builds; snapshot is ${snapshot.build.id}, run without --check`);
    }
    return snapshot;
  }

  const target = options.build || (snapshot ? snapshot.build.id : PINNED_BUILD);
  if (snapshot && snapshot.build.id === target) {
    return snapshot;
  }

  state.online = true;
  const registry = JSON.parse((await fetchBytes(REGISTRY_URL)).toString('utf8'));
  if (options.build ? registry.build.id !== options.build : registry.build.id !== PINNED_BUILD) {
    fail(
      `published build is ${registry.build.id}, expected ${options.build || PINNED_BUILD}; ` +
        `pass --build ${registry.build.id} to vendor it`
    );
  }

  const wasm = {};
  for (const file of WASM_FILES) {
    const bytes = await fetchBytes(BASE_URL + file.url);
    wasm[file.key] = { url: file.url, path: file.path, bytes: bytes.length, sha256: sha256(bytes) };
  }
  const fresh = pruneRegistry(registry, wasm);
  state.snapshotText = JSON.stringify(fresh, null, 2) + '\n';
  console.log(`fetched ${REGISTRY_URL} (build ${fresh.build.id})`);
  return fresh;
}

async function ensureFile(path, expected, url) {
  const local = await readFile(path).catch(() => null);
  if (local && local.length === expected.bytes && sha256(local) === expected.sha256) {
    state.reused += 1;
    return local;
  }
  if (state.check) {
    fail(local ? `${path} does not match its recorded sha256` : `missing ${path}`);
  }
  if (!state.online) {
    fail(`${path} is missing or corrupt; delete ${SNAPSHOT_PATH} to re-download it`);
  }
  const bytes = await fetchBytes(url);
  if (bytes.length !== expected.bytes) {
    fail(`${url} is ${bytes.length} bytes, registry says ${expected.bytes}`);
  }
  if (sha256(bytes) !== expected.sha256) {
    fail(`${url} does not match its recorded sha256`);
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
  state.downloaded += 1;
  return bytes;
}

async function withConcurrency(items, limit, run) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      await run(items[cursor++]);
    }
  });
  await Promise.all(workers);
}

function decodeSamples(rasp, bytes, path) {
  let decoded;
  try {
    decoded = rasp.decode(bytes);
  } catch (error) {
    fail(`${path} does not decode: ${error.message}`);
  }
  try {
    return decoded.length();
  } finally {
    decoded.free();
  }
}

async function buildManifest(snapshot, rasp) {
  const samples = new Map();
  const clips = [];
  for (const voice of snapshot.voices) {
    for (const phraseId of Object.keys(snapshot.phrases)) {
      const file = snapshot.files[voice.id][phraseId];
      clips.push({
        key: `${voice.id}/${phraseId}`,
        path: `vendor/rasp/audio/${voice.id}/${phraseId}.weba`,
        expected: file,
        url: BASE_URL + file.path
      });
    }
  }

  await withConcurrency(clips, 8, async (clip) => {
    const bytes = await ensureFile(clip.path, clip.expected, clip.url);
    samples.set(clip.key, decodeSamples(rasp, bytes, clip.path));
  });

  const voices = {};
  for (const voice of snapshot.voices) {
    const entries = {};
    for (const phraseId of Object.keys(snapshot.phrases)) {
      const file = snapshot.files[voice.id][phraseId];
      entries[phraseId] = {
        path: `vendor/rasp/audio/${voice.id}/${phraseId}.weba`,
        bytes: file.bytes,
        durationMs: file.durationMs,
        samples: samples.get(`${voice.id}/${phraseId}`),
        sha256: file.sha256
      };
    }
    voices[voice.id] = {
      language: voice.language,
      locale: voice.locale,
      gender: voice.gender,
      clips: entries
    };
  }

  const wasm = {};
  for (const file of WASM_FILES) {
    wasm[file.key] = {
      path: file.path,
      bytes: snapshot.wasm[file.key].bytes,
      sha256: snapshot.wasm[file.key].sha256
    };
  }

  return {
    schema: 1,
    corpusBuild: snapshot.build.id,
    inputsVersion: snapshot.build.inputsVersion,
    wasm,
    voices,
    phrases: snapshot.phrases,
    hooks: snapshot.hooks
  };
}

function onGrid(value, step) {
  return Math.abs(value - Math.round(value / step) * step) < 1e-9;
}

async function checkPools(snapshot, manifest, variantSchema) {
  const text = await readFile(POOLS_PATH, 'utf8').catch(() => null);
  if (!text) {
    fail(`missing ${POOLS_PATH}; run npm run voice:pools`);
  }
  const pools = JSON.parse(text);
  if (pools.schema !== 1) {
    fail(`${POOLS_PATH} has schema ${pools.schema}`);
  }
  if (pools.rasp.corpusBuild !== manifest.corpusBuild) {
    fail(`${POOLS_PATH} was built for ${pools.rasp.corpusBuild}, bank is ${manifest.corpusBuild}`);
  }
  if (pools.rasp.variantSchema !== variantSchema) {
    fail(`${POOLS_PATH} was built for variant schema ${pools.rasp.variantSchema}, wasm is ${variantSchema}`);
  }

  const languages = [...new Set(snapshot.voices.map((voice) => voice.language))].sort();
  const poolLanguages = Object.keys(pools.languages).sort();
  if (languages.join() !== poolLanguages.join()) {
    fail(`${POOLS_PATH} languages are ${poolLanguages.join()}, bank has ${languages.join()}`);
  }

  const counts = new Map();
  const seeds = new Set();
  for (const [language, entries] of Object.entries(pools.languages)) {
    for (const entry of entries) {
      const voice = snapshot.voices.find((candidate) => candidate.id === entry.voiceId);
      if (!voice || voice.language !== language) {
        fail(`${POOLS_PATH} has ${entry.voiceId} under ${language}`);
      }
      if (seeds.has(entry.seed)) {
        fail(`${POOLS_PATH} repeats seed ${entry.seed}`);
      }
      seeds.add(entry.seed);
      if (!onGrid(entry.pitchSt, 0.05) || !onGrid(entry.formantRatio, 0.005) || !onGrid(entry.tiltDbPerOct, 0.25)) {
        fail(`${POOLS_PATH} entry ${entry.seed} is off the quantisation grid`);
      }
      counts.set(entry.voiceId, (counts.get(entry.voiceId) || 0) + 1);
    }
  }
  for (const voice of snapshot.voices) {
    const count = counts.get(voice.id) || 0;
    if (count !== POOL_SIZE) {
      fail(`${POOLS_PATH} has ${count} seeds for ${voice.id}, expected ${POOL_SIZE}`);
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  state.check = options.check;

  const snapshot = await resolveSnapshot(options);

  for (const file of WASM_FILES) {
    await ensureFile(file.path, snapshot.wasm[file.key], BASE_URL + file.url);
  }

  const rasp = await import(pathToFileURL(WASM_FILES[0].path).href);
  await rasp.default({ module_or_path: await readFile(WASM_FILES[1].path) });

  const manifest = await buildManifest(snapshot, rasp);
  const text = JSON.stringify(manifest, null, 2) + '\n';
  if (state.snapshotText) {
    await writeIfChanged(SNAPSHOT_PATH, state.snapshotText);
  }

  if (options.check) {
    const current = await readFile(BANK_PATH, 'utf8').catch(() => null);
    if (current === null) {
      fail(`missing ${BANK_PATH}; run npm run voice:vendor`);
    }
    if (current !== text) {
      fail(`${BANK_PATH} is stale; run npm run voice:vendor`);
    }
    await checkPools(snapshot, manifest, rasp.variant_schema());
    console.log(`ok: build ${manifest.corpusBuild}, ${snapshot.voices.length} voices, ${state.reused} files verified`);
    return;
  }

  const changed = await writeIfChanged(BANK_PATH, text);
  const audioBytes = Object.values(manifest.voices).reduce(
    (total, voice) => total + Object.values(voice.clips).reduce((sum, clip) => sum + clip.bytes, 0),
    0
  );
  console.log(
    `build ${manifest.corpusBuild}: ${snapshot.voices.length} voices, ` +
      `${Object.keys(manifest.phrases).length} phrases, ${state.downloaded} downloaded, ` +
      `${state.reused} reused, ${bytesLabel(audioBytes)} audio, ${bytesLabel(Buffer.byteLength(text))} manifest`
  );
  console.log(`${BANK_PATH} ${changed ? 'written' : 'unchanged'}`);

  const pools = await readFile(POOLS_PATH, 'utf8').catch(() => null);
  if (!pools || JSON.parse(pools).rasp.corpusBuild !== manifest.corpusBuild) {
    console.log('next: npm run voice:pools');
  }
}

main().catch((error) => {
  console.error(`error: ${error.message}`);
  process.exitCode = 1;
});
