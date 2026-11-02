/**
 * NPC voice playback: lazy wasm, rendered PCM cache, and per-actor sources.
 *
 * Everything browser-only (AudioContext, IndexedDB, wasm, fetch) is created on
 * first use, never at import time, so this module loads in Node. The pure
 * pieces — cache keys, the LRU, and event → phrase resolution — are exported
 * for tests; the wasm loader, IDB factory, and context factory are injectable.
 *
 * Failures are quiet: `speak()` and `prefetch()` resolve `false`/`0`, set
 * `lastError` once, and never throw into gameplay.
 */
import { VOICE_SCHEMA, hookPhrase, normalizeVoice, voiceForRecord } from './casting.js';
import { clipPath, hookCandidates } from './bank.js';
import { readVoicePrefs, writeVoicePrefs, clampVolume } from './prefs.js';
import policyDoc from '../../data/voice.json' with { type: 'json' };
import bankDoc from '../../data/voice_bank.json' with { type: 'json' };

export const VOICE_DB_NAME = 'playpark-voice';
export const VOICE_DB_VERSION = 1;
export const VOICE_PCM_STORE = 'pcm';
export const VOICE_CACHE_LIMIT = 20;
export const VOICE_SAMPLE_RATE = 48000;

/**
 * Join the identity of one rendered line. Knobs are canonicalised as numbers so
 * `1` and `1.0` share a key, and the corpus build pins a cache to one bake.
 */
export function cacheKey(voice, phrase, corpusBuild = bankDoc.corpusBuild, schema = VOICE_SCHEMA) {
  if (!voice || typeof voice !== 'object' || typeof phrase !== 'string' || !phrase) return null;
  const knob = value => {
    const number = Number(value);
    return Number.isFinite(number) ? String(number) : '';
  };
  return [
    schema,
    voice.voiceId || '',
    phrase,
    knob(voice.pitchSt),
    knob(voice.formantRatio),
    knob(voice.tiltDbPerOct),
    corpusBuild || ''
  ].join('|');
}

/** Insertion-ordered LRU over a `Map`; the oldest entry is evicted first. */
export function createLru(limit = VOICE_CACHE_LIMIT) {
  const max = Math.max(1, Math.floor(limit));
  const entries = new Map();
  return {
    get(key) {
      if (!entries.has(key)) return null;
      const value = entries.get(key);
      entries.delete(key);
      entries.set(key, value);
      return value;
    },
    set(key, value) {
      if (!key) return value;
      entries.delete(key);
      entries.set(key, value);
      while (entries.size > max) entries.delete(entries.keys().next().value);
      return value;
    },
    has: key => entries.has(key),
    delete: key => entries.delete(key),
    clear: () => entries.clear(),
    keys: () => [...entries.keys()],
    get size() {
      return entries.size;
    }
  };
}

/** Map a Play Park event (or a raw hook) to a bank hook, or null. */
export function resolveHook(event, policy = policyDoc) {
  if (typeof event !== 'string' || !event) return null;
  const hook = policy?.events?.[event] || event;
  return hookCandidates(hook) ? hook : null;
}

/** Deterministic phrase for `(voice, event, attempt)`, or null when unknown. */
export function phraseFor(voice, event, attempt = 0, policy = policyDoc) {
  const hook = resolveHook(event, policy);
  if (!hook) return null;
  return hookPhrase(bankDoc, voice?.seed, hook, attempt);
}

/**
 * Accept either an NPC character record (which carries `voice`) or a voice spec
 * itself. A record with a damaged block is re-cast by `voiceForRecord`; a bare
 * `{ id }` with no voice block is not a voice, so it returns null.
 */
export function normalizeTarget(target) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) return null;
  if (target.voice && typeof target.voice === 'object') return voiceForRecord(target);
  if (target.voiceId) return normalizeVoice(target);
  return null;
}

function defaultStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

function defaultIdbFactory() {
  try {
    return globalThis.indexedDB || null;
  } catch {
    return null;
  }
}

function defaultWasmLoader() {
  return import(new URL('../../vendor/rasp/rasp.js', import.meta.url).href);
}

function defaultContextFactory() {
  const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
  return Ctor ? new Ctor() : null;
}

function openDatabase(idbFactory) {
  if (!idbFactory || typeof idbFactory.open !== 'function') return Promise.resolve(null);
  return new Promise(resolve => {
    let request;
    try {
      request = idbFactory.open(VOICE_DB_NAME, VOICE_DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const database = request.result;
      if (database?.objectStoreNames?.contains) {
        if (!database.objectStoreNames.contains(VOICE_PCM_STORE)) {
          database.createObjectStore(VOICE_PCM_STORE, { keyPath: 'key' });
        }
      }
    };
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

function readRecord(database, key) {
  return new Promise(resolve => {
    let request;
    try {
      request = database.transaction(VOICE_PCM_STORE, 'readonly').objectStore(VOICE_PCM_STORE).get(key);
    } catch {
      resolve(null);
      return;
    }
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => resolve(null);
  });
}

function writeRecord(database, record) {
  return new Promise(resolve => {
    let request;
    try {
      request = database.transaction(VOICE_PCM_STORE, 'readwrite').objectStore(VOICE_PCM_STORE).put(record);
    } catch {
      resolve(false);
      return;
    }
    request.onsuccess = () => resolve(true);
    request.onerror = () => resolve(false);
  });
}

/** Build an `AudioBuffer` from a stored record or fresh wasm output. */
function toAudioBuffer(context, record) {
  if (!context || !record) return null;
  const samples = record.buffer instanceof ArrayBuffer
    ? new Float32Array(record.buffer)
    : (record.samples instanceof Float32Array ? record.samples : null);
  if (!samples || !samples.length) return null;
  const channels = Math.max(1, Math.floor(Number(record.channels)) || 1);
  const frames = Math.max(0, Math.floor(Number(record.length)) || Math.floor(samples.length / channels));
  if (!frames) return null;
  const rate = Number(record.sampleRate) > 0 ? Number(record.sampleRate) : VOICE_SAMPLE_RATE;
  const buffer = context.createBuffer(channels, frames, rate);
  if (!buffer) return null;
  if (channels === 1) {
    buffer.copyToChannel?.(samples.subarray(0, frames), 0);
    if (!buffer.copyToChannel) buffer.getChannelData(0).set(samples.subarray(0, frames));
    return buffer;
  }
  for (let channel = 0; channel < channels; channel++) {
    const data = new Float32Array(frames);
    for (let frame = 0; frame < frames; frame++) data[frame] = samples[frame * channels + channel];
    buffer.copyToChannel?.(data, channel);
    if (!buffer.copyToChannel) buffer.getChannelData(channel).set(data);
  }
  return buffer;
}

export class VoiceEngine {
  constructor({
    storage = null,
    policy = policyDoc,
    bank = bankDoc,
    wasmLoader = defaultWasmLoader,
    idbFactory = null,
    createContext = defaultContextFactory,
    fetchFn = null,
    lruLimit = VOICE_CACHE_LIMIT,
    prefs = null
  } = {}) {
    this.storage = storage || defaultStorage();
    this.policy = policy;
    this.bank = bank;
    this.loadWasm = wasmLoader;
    this.idbFactory = idbFactory === null ? defaultIdbFactory() : idbFactory;
    this.createContext = createContext;
    this.fetchFn = fetchFn || (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);
    this.maxBuffers = Math.max(1, Math.floor(Number(lruLimit)) || VOICE_CACHE_LIMIT);

    const initial = prefs || readVoicePrefs(this.storage);
    this.enabled = initial.enabled !== false;
    this.volume = clampVolume(initial.volume);
    this.hintShown = initial.hintShown === true;

    this.context = null;
    this.master = null;
    this.module = null;
    this.modulePromise = null;
    this.databasePromise = undefined;
    this.buffers = createLru(this.maxBuffers);
    this.sources = new Map();
    this.lastError = null;
    this.reportedError = false;
    this.lastPlayback = null;
  }

  get supported() {
    return typeof globalThis !== 'undefined'
      && Boolean(globalThis.AudioContext || globalThis.webkitAudioContext);
  }

  /** The wasm URL pinned to the vendored corpus build. */
  get wasmUrl() {
    const path = this.bank?.wasm?.bin?.path;
    if (!path) return null;
    const url = new URL(`../../${path}`, import.meta.url);
    const build = this.bank?.corpusBuild;
    if (build) url.searchParams.set('build', build);
    return url;
  }

  clipUrl(clipPathValue) {
    if (!clipPathValue) return null;
    return new URL(`../../${clipPathValue}`, import.meta.url);
  }

  /** Record the first failure once, then stay quiet. */
  fail(error) {
    if (!this.lastError) {
      this.lastError = error instanceof Error ? error : new Error(String(error || 'voice failed'));
    }
    if (!this.reportedError) {
      this.reportedError = true;
      try {
        console.info('voice unavailable:', this.lastError.message);
      } catch {
        // Console is best-effort.
      }
    }
    return false;
  }

  /** Snapshot one playback attempt for the Debug readout. */
  recordPlayback(fields = {}) {
    this.lastPlayback = {
      at: Date.now(),
      ok: false,
      voiceId: null,
      lang: null,
      phrase: null,
      cache: null,
      error: null,
      ...fields
    };
    return this.lastPlayback;
  }

  /**
   * Mark an attempt as failed. `report` stays false for expected no-ops — a
   * muted engine, an unknown event, or a missing clip — which are not
   * failures worth logging.
   */
  failPlayback(playback, error, report = true) {
    if (report) this.fail(error);
    if (playback) {
      playback.ok = false;
      playback.cache = null;
      playback.error = error instanceof Error ? error.message : String(error || 'voice failed');
    }
    return false;
  }

  /** Create or resume the voice context. Safe to call from a gesture handler. */
  unlock() {
    if (!this.supported) {
      this.fail(new Error('AudioContext is not available'));
      return null;
    }
    if (!this.context) {
      let context = null;
      try {
        context = this.createContext();
      } catch (error) {
        this.fail(error);
        return null;
      }
      if (!context) {
        this.fail(new Error('AudioContext could not be created'));
        return null;
      }
      this.context = context;
      this.master = context.createGain();
      this.master.gain.value = this.enabled ? this.volume : 0;
      this.master.connect(context.destination);
    }
    if (this.context.state === 'suspended') {
      try {
        this.context.resume?.()?.catch?.(() => {});
      } catch {
        // A refused resume retries on the next gesture.
      }
    }
    return this.context;
  }

  /** Stop playing voices and suspend the context while the tab is hidden. */
  suspend() {
    this.stopAll();
    try {
      this.context?.suspend?.()?.catch?.(() => {});
    } catch {
      // Suspending is best-effort.
    }
  }

  /** Write the whole prefs block so unrelated fields survive a mute or volume change. */
  persistPrefs() {
    writeVoicePrefs(this.storage, {
      enabled: this.enabled,
      volume: this.volume,
      hintShown: this.hintShown
    });
  }

  setEnabled(value) {
    this.enabled = Boolean(value);
    if (!this.enabled) this.stopAll();
    if (this.master) this.master.gain.value = this.enabled ? this.volume : 0;
    this.persistPrefs();
    return this.enabled;
  }

  setVolume(value) {
    this.volume = clampVolume(value);
    if (this.master) this.master.gain.value = this.enabled ? this.volume : 0;
    this.persistPrefs();
    return this.volume;
  }

  /** Remember that the first-use cue has been shown; persisted with the prefs. */
  setHintShown(value = true) {
    this.hintShown = Boolean(value);
    this.persistPrefs();
    return this.hintShown;
  }

  stopActor(actorId) {
    const entry = this.sources.get(actorId);
    if (!entry) return false;
    this.sources.delete(actorId);
    try {
      entry.source?.stop?.();
    } catch {
      // A finished source throws when stopped twice.
    }
    try {
      entry.source?.disconnect?.();
      entry.gain?.disconnect?.();
    } catch {
      // Disconnecting a closed graph is harmless.
    }
    return true;
  }

  stopAll() {
    for (const actorId of [...this.sources.keys()]) this.stopActor(actorId);
  }

  async database() {
    if (this.databasePromise === undefined) this.databasePromise = openDatabase(this.idbFactory);
    return this.databasePromise;
  }

  /** Lazily import and initialise the vendored wasm module. */
  wasm() {
    if (this.module) return Promise.resolve(this.module);
    if (this.modulePromise) return this.modulePromise;
    this.modulePromise = (async () => {
      const module = await this.loadWasm();
      const wasmUrl = this.wasmUrl;
      if (!module || typeof module.render_params !== 'function') throw new Error('voice wasm is missing');
      if (!wasmUrl) throw new Error('voice wasm path is not banked');
      await module.default({ module_or_path: wasmUrl });
      this.module = module;
      return module;
    })().catch(error => {
      this.modulePromise = null;
      this.fail(error);
      return null;
    });
    return this.modulePromise;
  }

  /** Fetch a baked clip and render it at the voice's knobs. */
  async renderClip(voice, phrase) {
    const module = await this.wasm();
    if (!module) throw new Error('voice wasm unavailable');
    const path = clipPath(voice.voiceId, phrase);
    if (!path) throw new Error(`no clip for ${voice.voiceId}/${phrase}`);
    if (!this.fetchFn) throw new Error('fetch is not available');
    const url = this.clipUrl(path);
    const response = await this.fetchFn(url);
    if (!response?.ok) throw new Error(`clip fetch failed (${response?.status || 'no response'})`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    return module.render_params(bytes, voice.pitchSt, voice.formantRatio, voice.tiltDbPerOct);
  }

  remember(key, buffer) {
    this.buffers.set(key, buffer);
    return buffer;
  }

  /** Memory LRU → IndexedDB → render; the miss is written back to both. */
  async bufferFor(context, voice, phrase) {
    const key = cacheKey(voice, phrase, this.bank?.corpusBuild);
    if (!key) return null;
    const cached = this.buffers.get(key);
    if (cached) return { buffer: cached, cache: 'memory' };

    const database = await this.database();
    if (database) {
      const record = await readRecord(database, key);
      const restored = toAudioBuffer(context, record);
      if (restored) return { buffer: this.remember(key, restored), cache: 'idb' };
    }

    const samples = await this.renderClip(voice, phrase);
    if (!(samples instanceof Float32Array) || !samples.length) return null;
    const buffer = toAudioBuffer(context, {
      samples,
      length: samples.length,
      channels: 1,
      sampleRate: VOICE_SAMPLE_RATE
    });
    if (!buffer) return null;
    this.remember(key, buffer);
    if (database) {
      const copy = samples.slice();
      await writeRecord(database, {
        key,
        buffer: copy.buffer,
        sampleRate: VOICE_SAMPLE_RATE,
        length: copy.length,
        channels: 1,
        bytes: copy.byteLength,
        createdAt: Date.now()
      });
    }
    return { buffer, cache: 'render' };
  }

  actorIdFor(target, voice) {
    const id = target?.id ?? target?.npcId;
    if (typeof id === 'string' && id) return id;
    return voice?.seed || voice?.voiceId || 'voice';
  }

  /**
   * Speak one beat for an NPC. `event` is a Play Park event alias or a raw bank
   * hook; `attempt` rotates through the hook's phrase candidates.
   *
   * Every attempt updates `lastPlayback`, including muted and failed ones, so
   * the Debug readout can explain the outcome without console logs.
   */
  async speak(target, event, attempt = 0) {
    const playback = this.recordPlayback();
    try {
      const voice = normalizeTarget(target);
      const phrase = voice ? phraseFor(voice, event, attempt, this.policy) : null;
      playback.voiceId = voice?.voiceId || null;
      playback.lang = voice?.lang || null;
      playback.phrase = phrase;

      if (!this.enabled) return this.failPlayback(playback, 'muted', false);
      if (!voice) return this.failPlayback(playback, 'no voice', false);
      if (!phrase) return this.failPlayback(playback, 'no phrase', false);

      const context = this.unlock();
      if (!context) return this.failPlayback(playback, this.lastError?.message || 'audio unavailable');

      const result = await this.bufferFor(context, voice, phrase);
      if (!result?.buffer) return this.failPlayback(playback, 'no audio buffer', false);

      const actorId = this.actorIdFor(target, voice);
      this.stopActor(actorId);

      const gain = context.createGain();
      gain.gain.value = 1;
      gain.connect(this.master);
      const source = context.createBufferSource();
      source.buffer = result.buffer;
      source.connect(gain);
      source.onended = () => {
        const current = this.sources.get(actorId);
        if (current?.source === source) this.sources.delete(actorId);
        try {
          source.disconnect?.();
          gain.disconnect?.();
        } catch {
          // Already disconnected.
        }
      };
      this.sources.set(actorId, { source, gain });
      source.start();

      playback.ok = true;
      playback.cache = result.cache;
      playback.error = null;
      return true;
    } catch (error) {
      return this.failPlayback(playback, error);
    }
  }

  /**
   * Render beats without playing them, so the next `speak()` is a cache hit.
   * Returns how many lines are ready.
   */
  async prefetch(target, events = []) {
    try {
      if (!this.enabled) return 0;
      const voice = normalizeTarget(target);
      if (!voice) return 0;
      const context = this.unlock();
      if (!context) return 0;
      const list = Array.isArray(events) ? events : [events];
      let ready = 0;
      for (const [index, event] of list.entries()) {
        const phrase = phraseFor(voice, event, index, this.policy);
        if (!phrase) continue;
        const result = await this.bufferFor(context, voice, phrase);
        if (result?.buffer) ready++;
      }
      return ready;
    } catch (error) {
      this.fail(error);
      return 0;
    }
  }
}
