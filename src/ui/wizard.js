import {
  createRecipe,
  rerollRecipe,
  avatarDataUrl,
  bindAnimatedAvatar,
  TOP_VARIANTS,
  OUTFIT_VARIANTS,
  GLASSES_VARIANTS,
  BEARD_VARIANTS,
  COLOR_PALETTES,
  prettyLabel
} from '../avatar.js';
import { PLAYER_NAMES, pickVibe } from '../names.js';
import { castVoice } from '../voice/casting.js';

const LOOK_FIELDS = ['top', 'outfit', 'glasses', 'beard', 'skin', 'hair', 'shirt', 'pants', 'shoes'];
const COLOR_FIELDS = ['skin', 'hair', 'shirt', 'pants', 'shoes'];

const $ = id => document.getElementById(id);

function randomFrom(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function fillSelect(select, entries) {
  const fragment = document.createDocumentFragment();
  for (const entry of entries) {
    const option = document.createElement('option');
    option.value = entry.value;
    option.textContent = entry.label;
    fragment.append(option);
  }
  select.append(fragment);
}

export class SetupWizard {
  constructor({ onEnterPark, onDraftChange, makeSeed }) {
    this.onEnterPark = onEnterPark;
    this.onDraftChange = onDraftChange;
    this.makeSeed = makeSeed;
    this.draft = null;
    this.buildLookControls();
    this.bindEvents();
  }

  setDraft(draft) {
    this.draft = draft;
  }

  buildLookControls() {
    fillSelect($('look-top'), [
      { value: 'random', label: 'Random' },
      { value: 'none', label: 'None' },
      ...TOP_VARIANTS.map(value => ({ value, label: prettyLabel(value) }))
    ]);
    fillSelect($('look-outfit'), [
      { value: 'random', label: 'Random' },
      ...OUTFIT_VARIANTS.map(value => ({ value, label: prettyLabel(value) }))
    ]);
    fillSelect($('look-glasses'), [
      { value: 'random', label: 'Random' },
      { value: 'none', label: 'None' },
      ...GLASSES_VARIANTS.map(value => ({ value, label: prettyLabel(value) }))
    ]);
    fillSelect($('look-beard'), [
      { value: 'random', label: 'Random' },
      { value: 'none', label: 'None' },
      ...BEARD_VARIANTS.map(value => ({ value, label: prettyLabel(value) }))
    ]);

    for (const key of COLOR_FIELDS) {
      fillSelect($(`look-${key}`), [
        { value: 'random', label: 'Random' },
        ...COLOR_PALETTES[key].map(color => ({ value: color, label: color }))
      ]);
    }

    for (const key of LOOK_FIELDS) {
      $(`look-${key}`).addEventListener('change', event => {
        if (!this.draft) return;
        this.draft.playerRecipe.look[key] = event.target.value;
        this.syncCreator();
      });
    }
  }

  syncSwatches() {
    if (!this.draft) return;
    for (const key of COLOR_FIELDS) {
      const swatch = $(`swatch-${key}`);
      if (!swatch) continue;
      const value = this.draft.playerRecipe.look[key];
      if (value === 'random') {
        swatch.style.background = 'conic-gradient(from 20deg, #f4d7bd, #c08457, #74452a, #8a3a2a, #f4d7bd)';
        swatch.title = 'Random colour';
      } else {
        swatch.style.background = value;
        swatch.title = value;
      }
    }
  }

  syncCreator() {
    if (!this.draft) return;
    $('player-name').value = this.draft.playerName;
    $('player-seed').value = this.draft.playerRecipe.seed;
    for (const key of LOOK_FIELDS) {
      const select = $(`look-${key}`);
      const value = this.draft.playerRecipe.look[key] || 'random';
      if ([...select.options].some(option => option.value === value)) select.value = value;
    }
    this.syncSwatches();
    const preview = $('player-preview');
    bindAnimatedAvatar(preview, this.draft.playerRecipe, 0);
    preview.alt = `${this.draft.playerName}'s Voxel Art character`;
  }

  setStep(step) {
    $('step-character').hidden = step !== 1;
    $('step-crowd').hidden = step !== 2;
    $('step-dot-1').classList.toggle('active', step === 1);
    $('step-dot-1').classList.toggle('done', step > 1);
    $('step-dot-2').classList.toggle('active', step === 2);
  }

  open({ fresh = false } = {}) {
    $('hud').hidden = true;
    $('wizard').hidden = false;
    document.body.classList.add('wizard-open');
    $('npc-card').hidden = true;
    this.syncCreator();
    this.setStep(1);
    window.setTimeout(() => $('player-name').focus({ preventScroll: true }), 120);
  }

  close() {
    $('wizard').hidden = true;
    $('hud').hidden = false;
    document.body.classList.remove('wizard-open');
  }

  renderCrowd() {
    const grid = $('crowd-grid');
    grid.replaceChildren();
    if (!this.draft.npcs.length) {
      const empty = document.createElement('p');
      empty.className = 'crowd-empty';
      empty.textContent = 'An empty park. You can always invite neighbours later.';
      grid.append(empty);
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const npc of this.draft.npcs) {
      const card = document.createElement('div');
      card.className = 'crowd-card';
      card.setAttribute('role', 'listitem');

      const image = document.createElement('img');
      bindAnimatedAvatar(image, npc.recipe, (npc.id ? npc.id.charCodeAt(npc.id.length - 1) : 0) * 0.37);
      image.alt = `${npc.name}, park neighbour`;
      image.loading = 'lazy';

      const copy = document.createElement('div');
      const name = document.createElement('strong');
      name.textContent = npc.name;
      const vibe = document.createElement('small');
      vibe.textContent = npc.vibe;
      copy.append(name, vibe);

      const shuffle = document.createElement('button');
      shuffle.type = 'button';
      shuffle.className = 'icon-button';
      shuffle.textContent = '↻';
      shuffle.title = `New look for ${npc.name}`;
      shuffle.setAttribute('aria-label', `New look for ${npc.name}`);
      shuffle.addEventListener('click', () => this.rerollDraftNpc(npc, card));

      card.append(image, copy, shuffle);
      fragment.append(card);
    }
    grid.append(fragment);
  }

  rerollDraftNpc(npc, card) {
    const voice = castVoice();
    npc.voice = voice;
    npc.recipe = createRecipe(voice.seed);
    npc.vibe = pickVibe();
    if (npc.companion) npc.companion.recipe = createRecipe(); // companion creation fallback or companion recipe
    const image = card.querySelector('img');
    const vibe = card.querySelector('small');
    if (image) bindAnimatedAvatar(image, npc.recipe, Math.random() * 5);
    if (vibe) vibe.textContent = npc.vibe;
  }

  resizeCrowd(count, makeNpcFn) {
    if (!this.draft) return;
    this.draft.crowdCount = count;
    this.draft.crowdInitialized = true;
    while (this.draft.npcs.length < count) {
      this.draft.npcs.push(makeNpcFn());
    }
    if (this.draft.npcs.length > count) {
      this.draft.npcs.length = count;
    }
    $('crowd-count-label').value = String(count);
    $('crowd-count').value = String(count);
    this.renderCrowd();
  }

  bindEvents() {
    $('shuffle-look').addEventListener('click', () => {
      if (!this.draft) return;
      this.draft.playerRecipe = rerollRecipe(this.draft.playerRecipe);
      this.syncCreator();
    });

    $('reset-look').addEventListener('click', () => {
      if (!this.draft) return;
      this.draft.playerRecipe = createRecipe(this.draft.playerRecipe.seed);
      this.syncCreator();
    });

    $('player-name').addEventListener('input', event => {
      if (!this.draft) return;
      this.draft.playerName = event.target.value;
    });

    $('player-seed').addEventListener('change', event => {
      if (!this.draft) return;
      const seed = event.target.value.trim() || this.makeSeed();
      this.draft.playerRecipe = createRecipe(seed, this.draft.playerRecipe.look);
      this.syncCreator();
    });

    $('to-crowd').addEventListener('click', () => {
      if (!this.draft) return;
      if (!this.draft.playerName.trim()) {
        this.draft.playerName = randomFrom(PLAYER_NAMES);
        this.syncCreator();
      }
      this.onDraftChange?.('to-crowd');
      this.setStep(2);
      $('enter-park').focus({ preventScroll: true });
    });

    $('back-to-character').addEventListener('click', () => {
      this.setStep(1);
      this.syncCreator();
    });

    $('crowd-count').addEventListener('input', event => {
      this.onDraftChange?.('resize-crowd', Number(event.target.value));
    });

    $('shuffle-crowd').addEventListener('click', () => {
      if (!this.draft) return;
      for (const npc of this.draft.npcs) {
        const voice = castVoice();
        npc.voice = voice;
        npc.recipe = createRecipe(voice.seed);
        npc.vibe = pickVibe();
      }
      this.renderCrowd();
    });

    $('enter-park').addEventListener('click', () => {
      this.onEnterPark?.();
    });
  }
}
