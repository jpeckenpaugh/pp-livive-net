import bank from '../../data/voice_bank.json' with { type: 'json' };

export const VOICE_BANK = bank;
export const BANK_SCHEMA = 1;

export function voiceIds() {
  return Object.keys(bank.voices);
}

export function phraseIds() {
  return Object.keys(bank.phrases);
}

export function hookNames() {
  return Object.keys(bank.hooks);
}

export function languageIds() {
  return [...new Set(Object.values(bank.voices).map(voice => voice.language))];
}

export function getVoice(voiceId) {
  return bank.voices[voiceId] || null;
}

export function getPhrase(phraseId) {
  return bank.phrases[phraseId] || null;
}

export function getHook(hook) {
  const candidates = bank.hooks[hook];
  return Array.isArray(candidates) ? candidates : null;
}

/** Candidate phrase ids for a hook, or null when the hook is unknown. */
export function hookCandidates(hook) {
  const candidates = getHook(hook);
  return candidates && candidates.length ? candidates : null;
}

export function clipFor(voiceId, phraseId) {
  return bank.voices[voiceId]?.clips?.[phraseId] || null;
}

/** Repo-root-relative path to a baked clip, or null when it is not banked. */
export function clipPath(voiceId, phraseId) {
  return clipFor(voiceId, phraseId)?.path || null;
}

export function voicesForLanguage(language) {
  return Object.entries(bank.voices)
    .filter(([, voice]) => voice.language === language)
    .map(([voiceId]) => voiceId);
}

/**
 * Verify the manifest is internally complete: every banked voice has every
 * phrase, every hook names real phrases, and the wasm entries are described.
 * Pure over the manifest; file bytes are checked by the vendor `--check` gate.
 */
export function assertComplete() {
  const problems = [];
  if (bank.schema !== BANK_SCHEMA) problems.push(`bank schema ${bank.schema} is not ${BANK_SCHEMA}`);

  const phrases = phraseIds();
  if (!phrases.length) problems.push('no phrases');
  if (!Object.keys(bank.voices).length) problems.push('no voices');

  for (const entry of ['js', 'bin']) {
    const wasm = bank.wasm?.[entry];
    if (!wasm?.path || !wasm?.bytes || !wasm?.sha256) problems.push(`wasm.${entry} is not described`);
  }

  for (const [voiceId, voice] of Object.entries(bank.voices)) {
    if (!voice.language) problems.push(`${voiceId} has no language`);
    for (const phraseId of phrases) {
      const clip = voice.clips?.[phraseId];
      if (!clip) {
        problems.push(`${voiceId} is missing ${phraseId}`);
        continue;
      }
      if (!clip.path) problems.push(`${voiceId}/${phraseId} has no path`);
      if (!(clip.bytes > 0)) problems.push(`${voiceId}/${phraseId} has no byte count`);
      if (!(clip.samples > 0)) problems.push(`${voiceId}/${phraseId} has no sample count`);
    }
    for (const phraseId of Object.keys(voice.clips || {})) {
      if (!bank.phrases[phraseId]) problems.push(`${voiceId} has orphan clip ${phraseId}`);
    }
  }

  for (const [hook, candidates] of Object.entries(bank.hooks)) {
    if (!Array.isArray(candidates) || !candidates.length) {
      problems.push(`hook ${hook} is empty`);
      continue;
    }
    for (const phraseId of candidates) {
      if (!bank.phrases[phraseId]) problems.push(`hook ${hook} names unknown phrase ${phraseId}`);
      for (const voice of Object.values(bank.voices)) {
        if (!voice.clips?.[phraseId]) {
          problems.push(`hook ${hook} phrase ${phraseId} is not banked for every voice`);
          break;
        }
      }
    }
  }

  if (problems.length) throw new Error(`voice bank incomplete: ${problems.join('; ')}`);
  return true;
}
