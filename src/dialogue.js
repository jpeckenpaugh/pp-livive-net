import { avatarDataUrl, bindAnimatedAvatar } from './avatar.js';
import { formatCompanionInfo } from './characters.js';
import dialogueData from '../data/dialogues.json' with { type: 'json' };
import voicePolicy from '../data/voice.json' with { type: 'json' };

const LANGUAGE_LABELS = new Map(
  (Array.isArray(voicePolicy.languages) ? voicePolicy.languages : [])
    .filter(entry => entry && typeof entry.id === 'string')
    .map(entry => [entry.id, entry.label || entry.id])
);

/**
 * Resolve the dialogue language chip for an actor: a two-letter code plus the
 * full language name. English, companions, and any actor without a stored
 * voice return `null`, so the header shows only the name.
 */
export function languageChipFor(character) {
  const lang = typeof character?.voice?.lang === 'string' ? character.voice.lang.toLowerCase() : '';
  if (!lang || lang === 'en') return null;
  const label = LANGUAGE_LABELS.get(lang);
  if (!label) return null;
  return { code: lang.toUpperCase(), label };
}

function interpolate(template, vars) {
  return template.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? '');
}

const BOARD_TILE = 48;
const BOARD_GAP = 12;

function clampValue(value, min, max) {
  if (min > max) return min;
  return Math.max(min, Math.min(max, value));
}

function rectsOverlap(a, b) {
  return a.left < b.left + b.width
    && a.left + a.width > b.left
    && a.top < b.top + b.height
    && a.top + a.height > b.top;
}

function boardScreenRect(game) {
  const target = game?.cameraTarget;
  if (!target) return null;
  return {
    left: target.x * BOARD_TILE - game.camera.x,
    top: target.y * BOARD_TILE - game.camera.y,
    width: target.width * BOARD_TILE,
    height: target.height * BOARD_TILE
  };
}

function placementDistance(a, b) {
  const dx = (a.left + a.width / 2) - (b.left + b.width / 2);
  const dy = (a.top + a.height / 2) - (b.top + b.height / 2);
  return dx * dx + dy * dy;
}

/**
 * Keep the bubble off the board footprint while a session is open. Prefers the
 * closest side that fits the viewport, so it reads as a nudge rather than a
 * jump; if no side fits (a board filling a tiny screen) the original placement
 * stands and the board keeps priority.
 */
function placeClearOfBoard(card, board, bounds) {
  if (!rectsOverlap(card, board)) return { left: card.left, top: card.top };
  const clampLeft = value => clampValue(value, bounds.left, Math.max(bounds.left, bounds.right - card.width));
  const clampTop = value => clampValue(value, bounds.top, Math.max(bounds.top, bounds.bottom - card.height));
  const centredLeft = clampLeft(board.left + board.width / 2 - card.width / 2);
  const centredTop = clampTop(board.top + board.height / 2 - card.height / 2);
  const candidates = [
    { left: centredLeft, top: board.top - card.height - BOARD_GAP },
    { left: centredLeft, top: board.top + board.height + BOARD_GAP },
    { left: board.left - card.width - BOARD_GAP, top: centredTop },
    { left: board.left + board.width + BOARD_GAP, top: centredTop }
  ].map(candidate => ({ ...candidate, width: card.width, height: card.height }));
  const fitting = candidates.filter(candidate => (
    candidate.left >= bounds.left
    && candidate.left + candidate.width <= bounds.right
    && candidate.top >= bounds.top
    && candidate.top + candidate.height <= bounds.bottom
    && !rectsOverlap(candidate, board)
  ));
  if (!fitting.length) return { left: card.left, top: card.top };
  const best = fitting.reduce((winner, candidate) => (
    placementDistance(candidate, card) < placementDistance(winner, card) ? candidate : winner
  ));
  return { left: best.left, top: best.top };
}

const LEGACY_GAME_FLAGS = Object.freeze([
  { id: 'tic-tac-toe', flag: 'canPlayTicTacToe', labelKey: 'playTttLabel', fallback: 'Play Tic-Tac-Toe' },
  { id: 'checkers', flag: 'canPlayCheckers', labelKey: 'playCheckersLabel', fallback: 'Play Checkers' },
  { id: 'chess', flag: 'canPlayChess', labelKey: 'playChessLabel', fallback: 'Play Chess' }
]);

/**
 * Normalise the generic `games` option while accepting the legacy per-game
 * booleans. Enabled entries keep caller order; the first one becomes primary.
 *
 * @param {{ games?: Array<{id:string,label?:string,enabled?:boolean}>, canPlayTicTacToe?: boolean, canPlayCheckers?: boolean, canPlayChess?: boolean }} options
 * @param {object} [friendSpec] data/dialogues.json `friend` block
 * @returns {Array<{ id: string, label: string, primary: boolean }>}
 */
export function resolveGameChoices(options = {}, friendSpec = {}) {
  const provided = Array.isArray(options.games) ? options.games : [];
  const list = provided.length
    ? provided
        .filter(game => game && typeof game.id === 'string' && game.enabled !== false)
        .map(game => ({ id: game.id, label: game.label || game.id }))
    : LEGACY_GAME_FLAGS
        .filter(entry => options[entry.flag])
        .map(entry => ({
          id: entry.id,
          label: friendSpec[entry.labelKey] || entry.fallback
        }));

  return list.map((game, index) => ({ ...game, primary: index === 0 }));
}

export class DialogueManager {
  constructor({ containerId = 'dialogue', onDialogueEnd, onFriendshipChange, onPlayGame, onBeat, getGame } = {}) {
    this.dialogueNpc = null;
    this.onDialogueEnd = onDialogueEnd;
    this.onFriendshipChange = onFriendshipChange;
    this.onPlayGame = onPlayGame;
    this.onBeat = onBeat;
    this.getGame = getGame;
    this.container = document.getElementById(containerId);
    this.name = document.getElementById('dialogue-name');
    this.language = document.getElementById('dialogue-language');
    this.text = document.getElementById('dialogue-text');
    this.choices = document.getElementById('dialogue-choices');
  }

  isOpen() {
    return this.container && !this.container.hidden;
  }

  setBeat(text, choices) {
    if (!this.text || !this.choices) return;
    this.text.textContent = text;
    this.choices.replaceChildren();

    for (const choice of choices) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = choice.className || 'pill';
      button.textContent = choice.label;
      button.addEventListener('click', choice.onClick);
      this.choices.append(button);
    }

    this.bindArrowNavigation();
    window.requestAnimationFrame(() => this.choices.querySelector('button')?.focus({ preventScroll: true }));
  }

  setText(text) {
    if (this.text) this.text.textContent = text;
  }

  /**
   * Show the language chip for a voiced, non-English actor. English speakers,
   * companions, and menu beats pass `null` and the chip is cleared.
   */
  setLanguageChip(character) {
    const chip = this.language ? languageChipFor(character) : null;
    if (!this.language) return;
    if (!chip) {
      this.language.hidden = true;
      this.language.textContent = '';
      this.language.removeAttribute('aria-label');
      this.language.removeAttribute('title');
      return;
    }
    this.language.textContent = chip.code;
    this.language.setAttribute('aria-label', `speaks ${chip.label}`);
    this.language.title = chip.label;
    this.language.hidden = false;
  }

  /**
   * Announce a spoken beat for the current NPC. Called from the beat call
   * sites after `setBeat`, so custom beats, menus, and choice re-renders stay
   * silent. Listeners must never block the dialogue.
   */
  emitBeat(event) {
    if (!this.dialogueNpc || !event) return;
    this.onBeat?.(this.dialogueNpc, event);
  }

  bindArrowNavigation() {
    if (this._hasKeyNav) return;
    this._hasKeyNav = true;

    window.addEventListener('keydown', event => {
      if (!this.isOpen()) return;
      const key = event.key.toLowerCase();
      const isNext = key === 'arrowright' || key === 'arrowdown' || key === 's' || key === 'd';
      const isPrev = key === 'arrowleft' || key === 'arrowup' || key === 'w' || key === 'a';

      if (!isNext && !isPrev) return;

      const buttons = Array.from(this.choices.querySelectorAll('button'));
      if (!buttons.length) return;

      event.preventDefault();
      event.stopPropagation();

      const currentIndex = buttons.indexOf(document.activeElement);
      let nextIndex = 0;
      if (currentIndex === -1) {
        nextIndex = 0;
      } else if (isNext) {
        nextIndex = (currentIndex + 1) % buttons.length;
      } else if (isPrev) {
        nextIndex = (currentIndex - 1 + buttons.length) % buttons.length;
      }
      buttons[nextIndex]?.focus({ preventScroll: true });
    }, { capture: true });
  }

  open(character, isFriend, {
    games = null,
    canPlayTicTacToe = false,
    canPlayCheckers = false,
    canPlayChess = false
  } = {}) {
    if (!character || !this.container) return;
    this.dialogueNpc = character;
    document.body.classList.add('dialogue-open');
    this.container.hidden = false;
    this.name.textContent = character.name;
    this.setLanguageChip(character);
    this.updatePosition();

    // Handle companion dialogue (shows name, class, and type)
    if (character.isCompanion) {
      const info = formatCompanionInfo(character);
      const choices = dialogueData.dialogues.companion.choices.map(c => ({
        ...c,
        onClick: () => this.close()
      }));
      this.setBeat(info.text, choices);
      return;
    }

    const npc = character;
    if (isFriend) {
      const friendSpec = dialogueData.dialogues.friend;
      const gameChoices = resolveGameChoices(
        { games, canPlayTicTacToe, canPlayCheckers, canPlayChess },
        friendSpec
      );
      const choices = gameChoices.map(game => ({
        label: game.label,
        className: game.primary ? 'primary' : 'pill',
        onClick: () => {
          const opponent = this.dialogueNpc;
          this.close();
          this.onPlayGame?.(game.id, opponent);
        }
      }));
      choices.push({
        label: friendSpec.closeLabel,
        className: choices.length ? 'pill quiet' : 'primary',
        onClick: () => this.close()
      });

      this.setBeat(interpolate(friendSpec.text, { name: npc.name }), choices);
      this.emitBeat('dialogue.friend');
      return;
    }

    const strangerSpec = dialogueData.dialogues.stranger;
    const choices = strangerSpec.choices.map(c => ({
      label: c.label,
      className: c.className,
      onClick: c.action === 'accept' ? () => this.acceptFriendship() : () => this.declineFriendship()
    }));
    this.setBeat(interpolate(strangerSpec.text, { name: npc.name }), choices);
    this.emitBeat('dialogue.stranger');
  }

  openCustomBeat(npc, text, choices) {
    if (!npc || !this.container) return;
    this.dialogueNpc = npc;
    document.body.classList.add('dialogue-open');
    this.container.hidden = false;
    this.name.textContent = npc.name;
    this.setLanguageChip(null);
    this.setBeat(text, choices);
    this.updatePosition();
  }

  triggerFocusedChoice() {
    const active = document.activeElement;
    if (active && active.parentElement === this.choices) {
      active.click();
      return true;
    }
    const first = this.choices?.querySelector('button');
    if (first) {
      first.click();
      return true;
    }
    return false;
  }

  updatePosition() {
    if (!this.isOpen() || !this.dialogueNpc || !this.container) return;
    const game = this.getGame?.();
    if (!game) return;

    const npc = this.dialogueNpc;
    const player = game.player;
    const npcPos = game.interpolated ? game.interpolated(npc) : { x: npc.x, y: npc.y };
    const playerPos = player && game.interpolated ? game.interpolated(player) : (player ? { x: player.x, y: player.y } : null);

    const npcScreenX = (npcPos.x + 0.5) * 48 - game.camera.x;
    const npcScreenY = npcPos.y * 48 - game.camera.y;

    const playerScreenX = playerPos ? (playerPos.x + 0.5) * 48 - game.camera.x : npcScreenX;

    const bubbleW = this.container.offsetWidth || 280;
    const bubbleH = this.container.offsetHeight || 100;
    const pad = 12;

    // Primary goal: Do not cover the NPC or the Player.
    // Placement strategy:
    // 1. Try placing ABOVE the NPC and player
    let top = npcScreenY - bubbleH - 20;
    let left = npcScreenX - bubbleW / 2;

    // If top is clipped by HUD topbar (or off screen), place to the side opposite the player
    if (top < 65) {
      if (playerScreenX >= npcScreenX) {
        // Player is to the right of NPC: place bubble to the LEFT of NPC
        left = npcScreenX - bubbleW - 36;
      } else {
        // Player is to the left of NPC: place bubble to the RIGHT of NPC
        left = npcScreenX + 36;
      }
      top = npcScreenY - bubbleH / 2;
    }

    // Viewport containment:
    // If left overflows viewport, adjust
    if (left + bubbleW > window.innerWidth - pad) {
      left = window.innerWidth - bubbleW - pad;
    }
    if (left < pad) {
      left = pad;
    }

    // Keep clear of bottom controls (virtual d-pad / action buttons on mobile)
    const maxBottom = window.innerHeight - 170;
    if (top + bubbleH > maxBottom) {
      top = Math.max(65, maxBottom - bubbleH);
    }
    if (top < 65) {
      top = 65;
    }

    // A board session owns the camera; keep the bubble clear of the squares.
    if (document.body.classList.contains('board-open')) {
      const board = boardScreenRect(game);
      if (board) {
        const placed = placeClearOfBoard(
          { left, top, width: bubbleW, height: bubbleH },
          board,
          { left: pad, right: window.innerWidth - pad, top: 65, bottom: Math.max(65, maxBottom) }
        );
        left = placed.left;
        top = placed.top;
      }
    }

    this.container.style.left = `${Math.round(left)}px`;
    this.container.style.top = `${Math.round(top)}px`;
  }

  acceptFriendship() {
    if (!this.dialogueNpc) return;
    const npc = this.dialogueNpc;
    this.onFriendshipChange?.(npc.id, true);
    const spec = dialogueData.dialogues.accepted;
    const choices = spec.choices.map(c => ({
      ...c,
      onClick: () => this.close()
    }));
    this.setBeat(interpolate(spec.text, { name: npc.name }), choices);
    this.emitBeat('dialogue.accepted');
  }

  declineFriendship() {
    if (!this.dialogueNpc) return;
    const spec = dialogueData.dialogues.declined;
    const choices = spec.choices.map(c => ({
      ...c,
      onClick: () => this.close()
    }));
    this.setBeat(spec.text, choices);
    this.emitBeat('dialogue.declined');
  }

  close() {
    if (!this.isOpen()) return;
    this.container.hidden = true;
    document.body.classList.remove('dialogue-open');
    const npc = this.dialogueNpc;
    this.dialogueNpc = null;
    this.justClosedAt = Date.now();
    this.onDialogueEnd?.(npc);
  }
}
