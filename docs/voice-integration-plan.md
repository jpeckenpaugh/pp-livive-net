# NPC Voices — Development & Integration Plan

**Status:** Proposed · **Owner:** Jarad · **Target:** Play Park (`pp.livive.net`)
**Voice stack:** [dgen](https://dg-pp.livive.net) (bake) → [RASP](https://rasp.livive.net) (per-NPC timbre) → Play Park (events + language)
**Pin:** dgen `inputs.json` v4 · corpus build `3e81bd1f069b` · RASP variant schema `1`
**Last updated:** 2026-11-01

---

## 1. Goal

Give every neighbour in the park a **stable, reproducible voice** cast from the same seed
that draws their face, and let that voice speak a **short line in the NPC's own language**
while the dialogue UI keeps showing **English text**.

```text
player bumps Marisol (es, ef_dora)
┌──────────────────────────────────────────┐
│ Marisol                              ES  │
│ Hi, I'm Marisol. Good to see you again!  │   ← on-screen English, unchanged
│ [ Play Chess ]  [ See you ]              │
└──────────────────────────────────────────┘
🔈 "¡Qué bueno verte!"                        ← spoken Spanish cue
```

### What "done" means

- Two NPCs with different seeds sound clearly different; the same NPC sounds the same
  forever, across sessions and reloads.
- A meaningful share of the park speaks a non-English cue, and the on-screen text is still
  English.
- The game is fully playable with voices disabled, on a browser without WebAssembly, and
  with the audio assets removed from the tree.
- No network request at play time. `git clone` + `npm start` works offline.
- `npm test` covers casting, hook selection, bank integrity, and save migration.

---

## 2. The voice stack

Three layers, each already built:

| Layer | Repo | Role | Output |
| --- | --- | --- | --- |
| **dgen** | `jpeckenpaugh/dgen-livive-net` | Text → multilingual speech. Dockerized Kokoro 82M, 54 voices, 8 languages | `dist/audio/<voice>/<phrase>.weba` + `registry.json` |
| **RASP** | `jpeckenpaugh/rasp-livive-net` | Seed → base voice + pitch/formant/tilt; renders one clip at a time | `Float32Array @ 48 kHz` |
| **Play Park** | this repo | Casts a voice per NPC, chooses the event, keeps the English text | Dialogue + audio |

The important consequence: **the line set is generated, not fixed.** `inputs.json` is the
source of truth for speech content. Adding a line is a phrase entry with English text plus
seven translations, then an incremental bake. The 26 current phrases are a starting
vocabulary, not a ceiling.

### What is baked today

| Thing | Value |
| --- | --- |
| Voices | 54 Kokoro v1.0: en 28 (20 US, 8 UK) · zh 8 · ja 5 · hi 4 · es 3 · pt 3 · it 2 · fr 1 |
| Phrases | 26, ids shared across languages, grouped greeting/friendship/play/win/loss/ambient/decline/close |
| Translations | `es`, `pt`, `hi`, `fr`, `it`, `ja`, `zh` — a phrase without a translation fails the build |
| Clips | 1,404 Opus 32 kbps mono in WebM, `.weba`, 7.01 MB total |
| Hooks | 17 semantic names in `inputs.json`, referenced by the registry RASP consumes |
| Encoding | trimmed, faded, peak-normalized to −1.5 dBFS, plain filenames, sha256 in the registry |
| Build path | `make build` is incremental; `clipKey` covers text, voice, speed, model, encoder, processing |
| Validation | `make validate` checks counts, sizes, hashes, totals, language coverage, hooks |

Those 54 are the **complete published Kokoro v1.0 model set**, and every model has all 26
lines. Coverage is complete by construction rather than sampled, so the language counts
above are the shape of the upstream model set, not a corpus gap — the only choice left to
Play Park is how much of that set to vendor and how to weight it across a park.

The hooks in `inputs.json` were written for this game and line up almost one-to-one with
Play Park's dialogue events, which is why the integration is mostly wiring rather than
translation.

Non-English phonemization differs by language: es/pt/hi/fr/it use the eSpeak NG fallback,
ja/zh use `misaki` G2P dictionaries. The bake is the place to catch any line that reads
badly; that is an upstream check, not a gate on this integration.

---

## 3. Design decisions

### V1 — Vendor the engine and a curated slice of the bake

The project invariant is "no runtime API calls" and "works offline". We vendor:

| Asset | Size | Notes |
| --- | --- | --- |
| `vendor/rasp/rasp.js` + `rasp_bg.wasm` | 0.63 MB raw (~0.22 MB gzip) | pinned to variant schema `1` |
| `vendor/rasp/audio/<voice>/<phrase>.weba` | 1.07–2.0 MB | 1–2 voices per language across all 8 languages |
| `data/voice_bank.json` | ~30 KB | manifest: voices, phrases, hooks, sha256, durations |

| Slice | Voices | Audio | Total tree growth |
| --- | --- | --- | --- |
| 1 voice per language, all 26 phrases | 8 | 1.07 MB | ~1.7 MB |
| **2 voices per language where available, all 26 phrases** | **15** | **2.00 MB** | **~2.6 MB** |
| 2 per language, 17 core phrases | 15 | 1.29 MB | ~1.9 MB |

Start with **2 per language** for cast variety; the slice is a config value in the vendor
script, so dropping to 1 per language is a one-line change if the repo size is contested.
We take all 26 phrases either way so a new dialogue hook never needs a re-vendor.

Selection is the first female and first male in registry order per language, with French
taking its single voice. All 54 Kokoro voices are quality-acceptable for this project, so
selection is not grade-based.

### V2 — Language is authored, not hashed

Each park gets a language policy (weights per language, in `data/voice.json`). At NPC
creation we draw a language from that policy, then a pre-resolved voice spec from a
committed pool for that language. This makes "this NPC is Spanish" a property of the park
rather than a side effect of a 54-way hash.

### V3 — Store the resolved spec, never re-derive it

The save stores the resolved voice on each NPC:

```json
"voice": {
  "schema": 1,
  "seed": "clover-4pxbyrw",
  "lang": "es",
  "voiceId": "ef_dora",
  "pitchSt": 1.75,
  "formantRatio": 1.09,
  "tiltDbPerOct": 0.5
}
```

RASP's D24 recommends this: a schema bump must not silently re-voice an existing cast. It
also means the game never calls `describe()` at runtime.

### V4 — Pre-resolved seed pools, generated offline

`describe()` needs the wasm. NPC creation happens in the setup wizard, before any audio
gesture, and must stay synchronous and testable in Node. So we precompute pools:

```json
{
  "schema": 1,
  "rasp": { "variantSchema": 1, "corpusBuild": "3e81bd1f069b" },
  "languages": {
    "es": [
      { "seed": "clover-4pxbyrw", "voiceId": "ef_dora", "archetype": "fem-low",
        "pitchSt": 1.75, "formantRatio": 1.09, "tiltDbPerOct": 0.5 },
      …
    ]
  }
}
```

100 seeds per banked voice, ~1,500 entries, ~50 KB. Creation is a random pick — no wasm, no
network, no `await`, fully testable. `npm run voice:pools` regenerates it; the schema and
corpus build are in the file so a bump is visible in review.

For **new** NPCs the pool seed is also used as the avatar seed, so "one seed, one identity"
still holds. For **existing** saves the avatar seed is untouched and a pool seed is assigned
deterministically from `hash(npc.id)` on migration.

### V5 — Hooks come from the bake, aliases live in the game

`inputs.json` already owns hook names and candidate phrase lists, and the registry carries
them. The vendor script copies `hooks` and `phrases` into `data/voice_bank.json`. Play Park
only maps its own events to hook names:

```json
"events": {
  "dialogue.stranger": "stranger",
  "dialogue.friend": "friend",
  "dialogue.accepted": "accepted",
  "dialogue.declined": "declined",
  "dialogue.companion": "companion",
  "bubble.chat": "social.chat",
  "minigame.invite": "social.invite",
  "minigame.win": "minigame.win",
  "minigame.loss": "minigame.loss",
  "minigame.draw": "minigame.draw",
  "minigame.abandon": "minigame.abandoned",
  "game.start": "game.start"
}
```

Phrase selection inside a hook is deterministic from `(seed, hook, attempt)` with a small
FNV-1a in JS. Adding a phrase upstream extends the candidate list with no Play Park change.

### V6 — Non-blocking, failure-tolerant audio

Dialogue opens immediately. The voice renders off the critical path, plays when ready, and
never delays a beat. If wasm fails, a clip is missing, or the browser is old, `speak()`
resolves `false`, sets `lastError` once, and the game is unchanged. One console info line,
no visible error.

### V7 — Cache aggressively

Rendered PCM goes to IndexedDB keyed by
`(schema, voiceId, phrase, pitchSt, formantRatio, tiltDbPerOct, corpusBuild)`.
An in-memory LRU holds ~20 decoded `AudioBuffer`s. Cached replay is < 5 ms; a first play is
~100–200 ms. IndexedDB unavailability (private mode) degrades to in-memory only.

### V8 — Voice is a separate preference from SFX

The existing 🔊 button owns synthesized cues. Voices get their own toggle and volume in the
same topbar cluster, persisted under `playpark.voice.v1`, default **on**. An `AudioContext`
is only created on the first user gesture, and is suspended while the tab is hidden.

---

## 4. Architecture

```text
dgen (upstream)        inputs.json ──► Kokoro bake ──► dist/*.weba + registry.json
                                                              │
                                                              ▼
vendor pipeline        scripts/vendor_voice_bank.mjs ──► vendor/rasp/** + data/voice_bank.json
                       scripts/build_voice_pools.mjs  ──► data/voice_pools.json
                                                              │
                                                              ▼
Play Park              ┌──────────────────────────┐
 NPC creation ────────►│ src/voice/casting.js     │  pure: lang → spec, hook → phrase
 and migration         └───────┬──────────────────┘
                               │ {voiceId, pitchSt, formantRatio, tiltDbPerOct}
                               ▼
                       ┌──────────────────────────┐
 dialogue beat ───────►│ src/voice/adapter.js     │  speak(npc, event), prefetch(npc)
 or bubble             └───────┬──────────────────┘
                               ▼
                       ┌──────────────────────────┐     ┌─────────────────────┐
                       │ src/voice/engine.js      │────►│ IndexedDB PCM cache │
                       └───────┬──────────────────┘     └─────────────────────┘
                               │
             vendor/rasp/audio/<voice>/<phrase>.weba
                               │
                 rasp_bg.wasm → render_params → Float32Array @ 48 kHz
                               │
                 AudioBufferSourceNode → gain → destination
```

`casting.js` and `bank.js` are DOM-free and import-safe in Node. `engine.js` is the only
module that touches `AudioContext`, `fetch`, or IndexedDB.

---

## 5. Data contracts

### `data/voice.json` (hand-authored policy)

```json
{
  "version": 1,
  "enabled": true,
  "volume": 0.8,
  "bank": "vendor/rasp",
  "languages": [
    { "id": "en", "weight": 40, "label": "English" },
    { "id": "es", "weight": 9,  "label": "Spanish" },
    { "id": "pt", "weight": 9,  "label": "Portuguese" },
    { "id": "ja", "weight": 9,  "label": "Japanese" },
    { "id": "zh", "weight": 9,  "label": "Mandarin" },
    { "id": "hi", "weight": 9,  "label": "Hindi" },
    { "id": "fr", "weight": 7,  "label": "French" },
    { "id": "it", "weight": 8,  "label": "Italian" }
  ],
  "events": { "…": "…" },
  "prefetchRadiusTiles": 3,
  "prefetchEvents": ["dialogue.friend", "dialogue.stranger", "bubble.chat"]
}
```

### `data/voice_bank.json` (generated from the bake)

```json
{
  "schema": 1,
  "corpusBuild": "3e81bd1f069b",
  "inputsVersion": 4,
  "wasm": {
    "js": { "path": "vendor/rasp/rasp.js", "bytes": 16960, "sha256": "15e03e…" },
    "bin": { "path": "vendor/rasp/rasp_bg.wasm", "bytes": 632123, "sha256": "c7e6cb…" }
  },
  "voices": {
    "ef_dora": {
      "language": "es", "locale": "es-ES", "gender": "female",
      "clips": {
        "greet": {
          "path": "vendor/rasp/audio/ef_dora/greet.weba",
          "bytes": 3420, "durationMs": 665, "samples": 31578, "sha256": "b86867…"
        }
      }
    }
  },
  "phrases": {
    "greet": { "text": "Hi there!", "group": "greeting",
               "translations": { "es": "¡Hola!", "ja": "やあ！", "…": "…" } }
  },
  "hooks": {
    "stranger": ["greet", "be-friends"],
    "minigame.win": ["nice-one", "well-played", "you-got-me"],
    "…": []
  }
}
```

Keeping the phrase text and translations in the manifest is what makes an optional
original-language subtitle possible later without another vendor run.

`durationMs` is registry metadata, not a sample-count oracle — the Phase 0 spike measured
registry durations 0.7–1.4% longer than the decoded frame count. The manifest carries the
decoded `samples` value and the engine sizes buffers from that, never from `durationMs`.

### Save change (v3)

| Record | Field | v1/v2 → v3 |
| --- | --- | --- |
| `npcs[]` | `voice` | absent → assigned on migration from `hash(npc.id)` |
| `player` | — | no voice in v1 (the player does not speak) |
| `companions[]` | — | silent in v1; see open question 5 |

`SAVE_VERSION` goes `2 → 3`. `migrateSave` keeps accepting v1 and v2, and writes `voice`
only when absent so a later load does not re-roll anyone.

---

## 6. Event → hook map

| Play Park event | Source | Hook | Spoken example (es) |
| --- | --- | --- | --- |
| Stranger bumps into you | `dialogue.open` (not friend) | `stranger` | "¡Hola!" |
| Friendship accepted | `acceptFriendship()` | `accepted` | "¡Genial!" |
| Friendship declined | `declineFriendship()` | `declined` | "No hay problema." |
| Friend bumps into you | `dialogue.open` (friend) | `friend` | "¡Qué bueno verte!" |
| Companion bump | `open()` companion branch | `companion` | "¡Hola, amigo!" |
| Game invite prompt | `npcGameWatch` beat | `social.invite` | "Vamos a jugar." |
| Mini-game win | settlement `win` | `minigame.win` | "¡Bien hecho!" |
| Mini-game loss | settlement `loss` | `minigame.loss` | "¡Buena partida!" |
| Mini-game draw | settlement `draw` | `minigame.draw` | "¡Casi!" |
| Abandon prompt | `abandonPrompt` | `minigame.abandoned` | "Quizás la próxima vez." |
| Ambient social bubble | `social.chat` | `social.chat` | "¡Buen día!" |

The English text in `data/dialogues.json` is **not changed**. The spoken cue is a companion
to it, not a replacement.

---

## 7. Adding a spoken line

This is the upstream loop, recorded here so the integration does not quietly become the
bottleneck.

1. **Author** the phrase in `inputs.json`: `id`, `text`, `group`, and translations for all
   seven non-source languages. A missing translation fails validation.
2. **Attach** the phrase to one or more hooks in the same file, or add a new hook.
3. **Bake** with `make build` — incremental, so only clips whose `clipKey` changed are
   regenerated. `make serve` to audition; `make validate` before publishing.
4. **Publish** dgen. The registry gets a new build id.
5. **Re-vendor** in Play Park: `npm run voice:vendor -- --build <new-id>`, then
   `npm run voice:pools`. The `--check` mode makes a stale bank a CI failure.
6. **Map** any new hook name in `data/voice.json` if Play Park should fire it.

No Play Park code changes for a new line inside an existing hook. A new hook is one line of
JSON.

---

## 8. Phases

Estimates assume one developer, existing test discipline, no upstream changes.

### Phase 0 — Integration spike (~0.5 day)

**Result (2026-11-01): PASS.** Human-confirmed in Chrome, Safari, and iOS Safari. Wasm
init 1.6–1.8 ms; render 12–18 ms; cached 5–8 ms; first sample at 32.8 ms from fetch, well
inside the 400 ms budget. A 48 kHz buffer in a 44.1 kHz context keeps its duration; the
mislabeled control runs 8.9% long, so the failure mode is detectable. Spike deleted after
sign-off.

**Converged parameters (PM + human, 2026-11-01)**

- Wasm and clips are downloaded once into `spike/`, sha256 recorded in the report, nothing committed; `spike/` is gitignored.
- Fixtures: `af_heart/greet.weba` for timing, `ef_dora/greet.weba` for a non-English listen check.
- The 44.1 kHz check uses `new AudioContext({ sampleRate: 44100 })`; the device's natural rate is reported alongside.
- Latency is reported as four separate numbers — wasm init, fetch + render, cached render, time-to-audible. The 400 ms budget applies to fetch + render → audible on a first encounter; init is a one-time warm-up outside it.
- Evidence is an in-page timing readout plus console output. No screenshots, no automation.
- Plain-HTTP LAN testing is acceptable for the spike (no secure context needed).
- iOS is reported as **unverified** unless the human tests a phone on the LAN; it is an open risk carried into Phase 3, not a Phase 0 gate.
- The spike is deleted after sign-off.

| Task | Acceptance |
| --- | --- |
| Load vendored wasm in a scratch page under `npm start` | `render_params()` returns a `Float32Array` from a local clip |
| Play through `AudioBufferSourceNode` on desktop Chrome + Safari | Audible, unmodified timbre, no console warnings |
| Measure the four latency numbers | fetch + render → audible ≤ 400 ms on a first encounter on the dev machine; cached ≤ 50 ms; init reported separately |
| Verify a 48 kHz buffer in a forced 44.1 kHz context | Correct pitch, no truncation |
| Attempt iOS Safari unlock on the first gesture | Audio starts on tap, not before — or explicitly marked unverified |

**Exit:** a one-line `voice.speak()` demo, not merged, plus a go/no-go written result.


### Phase 1 — Vendor pipeline (~1 day)

| Task | Acceptance |
| --- | --- |
| `scripts/vendor_voice_bank.mjs` | Reads the published `registry.json`, writes a pruned snapshot to `vendor/rasp/registry.json`, verifies `sha256`/`bytes`, copies the selected voices' 26 phrases into `vendor/rasp/`, decodes each clip once to record its frame count (`samples`), copies the wasm, writes `data/voice_bank.json` including `wasm`, `phrases`, and `hooks`; idempotent; `--check` verifies the tree and both generated JSONs against the local snapshot with no network |
| `scripts/build_voice_pools.mjs` | Loads the vendored wasm in Node, enumerates 100 seeds per banked voice, writes `data/voice_pools.json`; seeds use `makeSeed()` shape; knobs rounded to the bake's quantisation grid; per-archetype soft cap; deterministic across runs |
| Voice slice | First female + first male per language in registry order, French's single voice, all 26 phrases; recorded in the script config |
| `npm run voice:vendor`, `npm run voice:pools` | Wired in `package.json`; documented in `AGENTS.md` |
| Attribution | Kokoro-82M (Apache-2.0), dgen, and RASP (MIT) added to `README.md` |

**Exit:** ~2.0 MB of audio + 0.63 MB engine vendored; `vendor/rasp/` reproducible from the
corpus build id.

### Phase 2 — Casting and save v3 (~1 day)

**Converged decisions (2026-11-01)**

- One `castVoice({ id, rand, policy, pools })` helper in `src/voice/casting.js`, called by both NPC factories and by `migrateNpcRecord`. `game.js` stays a passthrough. `storage.js` may import the pure casting module and the two JSON policy files.
- "New look" re-casts language and voice, and the new pool seed becomes the avatar seed: a reroll is a new identity.
- The save carries `voice.seed` inside the `voice` block so the spec is self-contained and phrase rotation is stable regardless of `recipe.seed`.
- A malformed or unknown `voice` block is silently re-cast from `npc.id`; the NPC is never dropped and never left voiceless.
- The player and companions omit `voice` entirely.
- Language weights stay as planned and are normalised at draw time; an empty pool for a configured language fails a test.
- Migration draws a language by policy weight, then an entry from that language, both from `hash(npc.id)` — a migrated park feels like a fresh one.
- `prefetchRadiusTiles` / `prefetchEvents` land in `data/voice.json` now and are validated against hooks, even though they are unused until Phase 4.

| Task | Acceptance |
| --- | --- |
| `src/voice/casting.js` | `castVoice`, `drawLanguage`, `drawSpec`, `hookPhrase` — pure, DOM-free |
| `src/voice/bank.js` | Manifest lookup, clip resolution, `assertComplete()` |
| NPC creation | New NPCs draw a language and a spec; the pool seed is also used for `createRecipe(seed)` |
| Migration | v2 saves gain `voice` on each NPC; deterministic from `npc.id`; v1 still migrates |
| Validation | Unknown language/event/hook/phrase fails a test, not the browser |

**Exit:** a fresh park and a migrated park both have a complete, stable `voice` block per NPC.

### Phase 3 — Engine and playback (~1.5 days)

**Converged decisions (2026-11-01)**

- Voices get their own `AudioContext` and master gain; `src/audio.js` is untouched.
- The engine imports the vendored module via `import.meta.url` and passes an explicit `{ module_or_path }` URL for the wasm, cache-busted by `corpusBuild`.
- IndexedDB database `playpark-voice` v1, store `pcm`, records `{ key, buffer: ArrayBuffer, sampleRate, length, channels, bytes, createdAt }`, key as the joined tuple string. No eviction in v1; the cache grows with cast size.
- Sources are keyed per actor. A repeat `speak()` on the same actor cuts off the previous line; `stopAll()` handles mute and visibility.
- Manual testing is console-only through `window.playPark.voice` — no dev flag, no harness page.
- `speak()` accepts a character record or a spec, normalises through `voiceForRecord`, and resolves `Promise<boolean>`.
- `prefs.js` defaults to `{ enabled: true, volume: 0.8 }`, swallows write failures, and stays a plain read/write module.

| Task | Acceptance |
| --- | --- |
| `src/voice/engine.js` | Lazy wasm init; `speak(spec, phrase)`; typed failure → `false`, never throws |
| IndexedDB cache | Second play of the same line is served from cache; key includes corpus build and all four knobs |
| In-memory LRU | ≤ 20 buffers; no unbounded growth over 100 plays |
| Gesture unlock | Context created on first pointer/key event; `visibilitychange` suspends |
| Volume + mute | `playpark.voice.v1`; mute silences without stopping the game |
| `src/voice/prefs.js` | Pure read/write over an injected storage, testable in Node |

**Exit:** 100 consecutive speaks across 15 NPCs with zero errors and flat memory.

### Phase 4 — Dialogue hooks (~1 day)

**Converged decisions (2026-11-01)**

- `onBeat(npc, event)` fires at the five beat call sites, immediately after `setBeat`, never from inside `setBeat`.
- Companion bumps emit no beat event in v1; the `companion` alias stays for later. Spectator prompts stay silent.
- Prefetch rides the existing frame loop: Manhattan distance ≤ `prefetchRadiusTiles`, gated by a `prefetched` Set, `!dialogue.isOpen()`, voice enabled, and the audio-unlocked flag. Opening a dialogue also warms `accepted` / `declined`.
- The voice toggle is pulled forward from Phase 6: a `#voice-toggle` sibling of `#sound-toggle`, persisted on `playpark.voice.v1`, labelled "Voices", using existing pill styles.
- `onDialogueEnded` calls `stopActor(npc.id)` so a line never outlives the panel.
- No new DOM test for `dialogue.js`; the change is wiring. `npm test` stays green and the browser check covers it.

| Task | Acceptance |
| --- | --- |
| `DialogueManager` emits a beat event | `onBeat(npc, event)` fires for stranger open, friend open, accept, decline |
| Wire `main.js` | Speak from the dialogue callbacks; `stopActor` on close |
| Prefetch | Approaching within 3 tiles pre-renders the greeting; opening a dialogue pre-renders its beats |
| Mute toggle | Present beside 🔊, persisted, does not affect SFX |
| Failure isolation | Disabling voice leaves dialogue timing and focus unchanged |

**Exit:** the four social beats speak, in the NPC's language, with English text intact; the
mute toggle stops them without touching sound effects.

### Phase 5 — Mini-games and bubbles (~0.5 day)

| Task | Acceptance |
| --- | --- |
| Settlement hooks | win/loss/draw/abandon speak once per result, not per re-render |
| Speech bubbles | `social.chat` bubbles speak; one voice per actor, debounced |
| NPC-vs-NPC games | spectator prompts stay silent unless the prompt is addressed to the player |

**Exit:** a full Tic-Tac-Toe match against a Spanish-speaking NPC speaks greet → invite →
win/loss → close.

### Phase 6 — UI, docs, release (~1 day)

| Task | Acceptance |
| --- | --- |
| Voice toggle + volume | Native button with `aria-pressed`; volume in the same panel; keyboard operable; 360 px layout holds |
| Language chip in dialogue | Two-letter locale chip only when non-English; `aria-label` reads "speaks Spanish" |
| Docs | `README.md` features + attribution, `AGENTS.md` architecture rows and invariants, this file updated |
| Test suite | New suites pass; `npm test` green; no browser automation added |
| Manual smoke | Chrome + Safari + one phone; voices on/off; fresh park + migrated save |

**Exit:** shipped to `main`, Pages deploy verified.

**Total: ~5.5–6.5 dev days.**

---

## 9. File-by-file changes

| Path | Change |
| --- | --- |
| `data/voice.json` | **new** — policy, event aliases, prefetch, prefs defaults |
| `data/voice_bank.json` | **new**, generated — voices, phrases, hooks, hashes |
| `data/voice_pools.json` | **new**, generated — seed → spec pools |
| `src/voice/casting.js` | **new** — pure casting + hook selection |
| `src/voice/bank.js` | **new** — pure manifest access |
| `src/voice/engine.js` | **new** — wasm, cache, playback |
| `src/voice/adapter.js` | **new** — dialogue/bubble wiring |
| `src/voice/prefs.js` | **new** — mute/volume |
| `src/dialogue.js` | add `onBeat` callback and an event per beat (no text changes) |
| `src/main.js` | construct engine after gesture, wire events, prefetch, toggle |
| `src/storage.js` | `SAVE_VERSION = 3`; `voice` on NPC records; migration |
| `src/game.js` | pass `voice` through character creation (no logic) |
| `index.html` | voice toggle + volume control |
| `css/app.css` | toggle and chip styles, reusing existing variables |
| `scripts/vendor_voice_bank.mjs` | **new** — vendor pipeline |
| `scripts/build_voice_pools.mjs` | **new** — pool generator |
| `package.json` | `voice:vendor`, `voice:pools` scripts |
| `vendor/rasp/**` | **new**, generated — engine + clips |
| `test/voice-*.test.js` | **new** — 3–4 suites |
| `README.md`, `AGENTS.md` | features, architecture, attribution |

---

## 10. Testing

Pure logic in `node:test`, no browser automation in the repo.

| Suite | Covers |
| --- | --- |
| `test/voice-casting.test.js` | language weighting, spec determinism, pool coverage, hook rotation, unknown hook |
| `test/voice-bank.test.js` | every hook candidate exists for every banked voice; `sha256` and byte counts match the files; no orphan clips; event aliases resolve |
| `test/voice-save.test.js` | v1→v3 and v2→v3 migration, `voice` preserved on reload, no re-roll, malformed spec rejected |
| `test/voice-prefs.test.js` | mute/volume round-trip, default state, injected storage |
| `test/data-validation.test.js` | extend to validate `voice.json` against `voice_bank.json` |

Manual browser checks (not committed): first-play latency, Safari unlock, iOS layout,
voice-off fallback, one migrated save.

**Not tested automatically:** the DSP itself and the rendered audio — that is RASP's suite
and its listening rounds. We test the seam.

---

## 11. Risks

| # | Risk | Impact | Mitigation |
| --- | --- | --- | --- |
| 1 | Vendoring ~2.6 MB feels heavy | Medium | Slice is a config value; 1 voice per language is ~1.7 MB |
| 2 | RASP schema bump re-voices the cast | High | Store the resolved spec; pools pinned to schema + corpus build |
| 3 | Pool generation depends on `describe()` output | Medium | Pools are committed and `--check`-able; a bump fails the check instead of silently re-rolling |
| 4 | First-play latency feels like a desync | Medium | Prefetch on approach; never block the dialogue; accept ≤ 400 ms first encounter |
| 5 | A voice someone dislikes is locked in | Low | Swapping it is a config change plus `npm run voice:vendor`; the stored spec protects existing NPCs |
| 6 | iOS autoplay blocks the first line | Medium | Create the context on first gesture; retry on next interaction; never surface an error |
| 7 | A new line needs a bake + re-vendor | Low | Documented in §7; `--check` catches a stale bank. Content work, not an architecture limit |
| 8 | Foreign cue + English text confuses players | Low | Optional locale chip; a one-line hint in the wizard; toggle |
| 9 | IndexedDB unavailable (private mode) | Low | In-memory fallback; cache is best-effort |
| 10 | Attribution missed before public launch | Medium | Attribution lands in the same PR as the vendor files |

---

## 12. Open questions

1. **Voice slice size.** I recommend 2 voices per language (~2.6 MB total). 1 per language
   is ~1.7 MB and still covers all 8 languages, at the cost of cast variety.
2. **Language mix.** Default is ~40% English, ~9% each for es/pt/ja/zh/hi, ~7–8% for fr/it.
   A more even split is a one-line change; the question is how much of the park the player
   should understand.
3. **Show the language on screen?** A small `ES` chip is the default. The stronger version
   is a subtitle with the original text under the English line — the manifest already
   carries the translations, so this is a UI decision, not a data one.
4. **Should the player's own character speak?** Scoped out; the player has a recipe seed if
   it is ever wanted.
5. **Should companions speak?** The corpus is human speech, so a hedgehog saying "¡Hola,
   amigo!" is a design choice rather than a wiring task. I left them silent.
6. **Voice on by default?** I lean yes, with the toggle visible in the topbar.
7. **Migrated parks get a voice for the first time.** Faces stay the same. I think this is
   invisible, but it does change a park someone has been living in.
8. **Do you want the first content expansion scoped now?** The mechanism is in §7; the
   question is which new lines the first expansion should add, and in which languages.

---

## 13. Upstream notes

Only what affects this integration; both repos are upstream and not modified by this plan.

| Item | State | Effect here |
| --- | --- | --- |
| `inputs.json` v4, 26 phrases | Current | Our starting vocabulary; extending it is §7 |
| Registry hooks | Carried into `data/voice_bank.json` | Play Park maps events to hook names only |
| `rasp-client.js` | 404 on the live site | Not needed; we call the wasm exports |
| Robot / vocoder voices | Specified in RASP, not shipped | Out of scope |
| `PLAN.md` status table | Behind the commits | Read capability from code, not the tracker |

If live browser TTS ever replaces the bake, the input format changes from `.weba` bytes to
PCM and the engine surface would need a PCM entry point. That is not a dependency of this
plan, because the bake already produces exactly the format RASP consumes.

---

## 14. Out of scope for this plan

- Live TTS, translation, or speech recognition at runtime.
- Robot / vocoder voices.
- Player voice, companion voices, and animal vocalisations.
- Per-NPC manual knob tuning in the UI.
- Any server-side processing.

Adding lines is not out of scope — it is §7, upstream.
