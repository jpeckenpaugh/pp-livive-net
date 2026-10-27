/**
 * Memory Grid — a contract-native, two-seat 4×4 matching game.
 *
 * Seats alternate. On a turn the seated character walks onto a card tile and
 * presses the action key to flip it. A matching pair stays face-up, scores a
 * point, and keeps the turn. A mismatch reveals both cards for a short beat,
 * then flips them back and passes the turn.
 *
 * Rules and state only: no DOM, timers, rewards, stats, or dialogue. The host
 * settles the single finish event this game emits.
 */
import {
  MiniGameBase,
  PHASES,
  createStepResult,
  emptyStepResult
} from '../minigames/contract.js';
import {
  evacuateBystanders,
  findFootprintPlacement,
  normalizeBoard,
  originOf,
  stageCompanions,
  stageSeats,
  validateFootprint
} from '../minigames/staging.js';
import { findPath } from '../world.js';

export const MEMORY_GRID_SIZE = 4;
export const MEMORY_GRID_PAIRS = 8;
export const MEMORY_GRID_CARDS = MEMORY_GRID_SIZE * MEMORY_GRID_SIZE;
export const DEFAULT_MISMATCH_MS = 900;

/** Symbols are plain data keys; render() maps them to canvas glyphs. */
export const MEMORY_SYMBOLS = Object.freeze([
  'leaf',
  'acorn',
  'flower',
  'star',
  'mushroom',
  'shell',
  'gem',
  'drop'
]);

const GLYPHS = Object.freeze({
  leaf: '♣',
  acorn: '◆',
  flower: '✿',
  star: '★',
  mushroom: '▲',
  shell: '●',
  gem: '◈',
  drop: '☾'
});

const DEFAULT_BOARD = Object.freeze({
  width: MEMORY_GRID_SIZE,
  height: MEMORY_GRID_SIZE,
  margin: 1,
  blocksMovement: true,
  hiddenZones: []
});

const DEFAULT_META = Object.freeze({
  id: 'memory-grid',
  title: 'Memory Grid',
  kind: 'board',
  itemId: 'memory-grid',
  dialogueKey: 'memory-grid',
  rewardKey: 'memory-grid',
  players: 2,
  seats: 2,
  board: DEFAULT_BOARD,
  input: { mode: 'tile', actionLabel: 'flip' },
  renderLayers: ['ground'],
  timing: { openMs: 0, closeMs: 0, turnMs: 0 },
  persist: false,
  activity: 'turn-based'
});

function seatCharacter(seat) {
  return seat?.character ?? seat ?? null;
}

export class MemoryGridGame extends MiniGameBase {
  constructor({ host = null, meta = null, game = null, options = {} } = {}) {
    super(meta || DEFAULT_META);
    this.host = host;
    this.game = game || options?.game || host?.game || null;
    this.options = { ...(options || {}) };

    // Injectable RNG keeps decks reproducible in tests and replays.
    this.rng = typeof this.options.rng === 'function' ? this.options.rng : Math.random;
    this.mismatchMs = Number.isFinite(this.options.mismatchMs)
      ? Math.max(0, this.options.mismatchMs)
      : DEFAULT_MISMATCH_MS;

    this.active = false;
    this.cards = [];
    this.deck = this.cards;
    this.scores = [0, 0];
    this.turnSeat = 0;
    this.faceUp = [];
    this.revealTimer = 0;
    this.revealSeat = null;
    this.finished = false;
    this.winnerSeat = null;

    this.seatCharacters = [null, null];
    /** Seat 1's memory: card index -> symbol, filled from every reveal. */
    this.aiMemory = new Map();
    this.aiTarget = null;
  }

  get board() {
    return this.meta?.board || DEFAULT_BOARD;
  }

  /**
   * Lay out a board if needed, then stage both seats, their companions, and
   * evacuate bystanders caught on the footprint.
   *
   * @returns {{ ok: boolean, phase?: string, durationMs?: number, message?: string }}
   */
  open({ seats = [], placement = null, options = {} } = {}) {
    const base = super.open({ seats, placement, options });
    if (typeof options?.rng === 'function') this.rng = options.rng;
    if (Number.isFinite(options?.mismatchMs)) {
      this.mismatchMs = Math.max(0, options.mismatchMs);
    }
    this.options = { ...this.options, ...(options || {}) };

    this.seatCharacters = [seatCharacter(seats[0]), seatCharacter(seats[1])];
    const terrain = this.game?.terrain
      || this.options?.terrain
      || options?.terrain
      || null;

    const resolved = this._resolvePlacement(placement, terrain);
    if (resolved.error) return this._fail(resolved.error);

    this.placement = resolved.placement;
    this._resetRound();
    this.active = true;

    const companions = this._collectCompanions();
    stageSeats({
      terrain,
      seats: this.seatCharacters.filter(Boolean),
      placement: this.placement,
      board: this.board
    });
    stageCompanions({
      terrain,
      companions,
      placement: this.placement,
      board: this.board
    });

    const staged = new Set([...this.seatCharacters, ...companions].filter(Boolean));
    const bystanders = [
      ...(this.game?.npcs || []),
      ...(this.game?.companions || [])
    ].filter(character => character && !staged.has(character));

    evacuateBystanders({
      terrain,
      placement: this.placement,
      board: this.board,
      participants: [...staged],
      characters: bystanders
    });

    for (const character of this.seatCharacters) {
      if (character) character.inMiniGame = true;
    }

    this.phase = PHASES.PLAYING;
    return { ok: true, phase: this.phase, durationMs: base.durationMs };
  }

  ready() {
    this.phase = this.active ? PHASES.PLAYING : PHASES.IDLE;
    return { ok: this.active, phase: this.phase };
  }

  /** Milliseconds in, host-driven. Handles mismatch reveal and seat 1 AI. */
  update(dtMs) {
    if (!this.active || this.phase !== PHASES.PLAYING) return emptyStepResult();
    const dt = Number.isFinite(dtMs) ? Math.max(0, dtMs) : 0;
    let changed = false;
    const events = [];

    if (this.revealTimer > 0) {
      this.revealTimer = Math.max(0, this.revealTimer - dt);
      if (this.revealTimer > 0) return createStepResult({ handled: true });
      this._finishReveal();
      changed = true;
    }

    const ai = this._updateAi();
    if (ai) {
      changed = changed || ai.changed;
      events.push(...ai.events);
    }

    return createStepResult({ handled: changed || events.length > 0, changed, events });
  }

  /** Flip the card under the acting seat's feet. */
  handleInput(input = {}) {
    if (!this.active || this.phase !== PHASES.PLAYING) return emptyStepResult();
    const kind = input.kind || input.type;
    if (kind && kind !== 'action') return emptyStepResult();
    if (this.revealTimer > 0) return emptyStepResult();

    const character = input.character || null;
    const seat = Number.isInteger(input.seat) ? input.seat : this._seatOf(character);
    if (seat !== 0 && seat !== 1) return emptyStepResult();
    if (seat !== this.turnSeat) return emptyStepResult();

    const tile = input.tile && Number.isFinite(input.tile.x) && Number.isFinite(input.tile.y)
      ? input.tile
      : (character ? { x: character.x, y: character.y } : null);
    if (!tile) return emptyStepResult();

    const cell = this.cellAtTile(tile.x, tile.y);
    if (!cell) return emptyStepResult();

    const card = this.cards[cell.index];
    if (!card || card.matched || this.faceUp.includes(cell.index)) return emptyStepResult();

    return this._flip(seat, cell.index);
  }

  /** Map a world tile to { row, col, index } or null when off the board. */
  cellAtTile(x, y) {
    if (!this.active || !this.placement) return null;
    const origin = originOf(this.placement);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const col = Math.trunc(x) - origin.x;
    const row = Math.trunc(y) - origin.y;
    if (col < 0 || col >= MEMORY_GRID_SIZE || row < 0 || row >= MEMORY_GRID_SIZE) return null;
    return { row, col, index: row * MEMORY_GRID_SIZE + col };
  }

  /** World tile for a card index, or null when off the board. */
  tileForIndex(index) {
    if (!this.active || !this.placement) return null;
    if (!Number.isInteger(index) || index < 0 || index >= MEMORY_GRID_CARDS) return null;
    const origin = originOf(this.placement);
    return {
      x: origin.x + (index % MEMORY_GRID_SIZE),
      y: origin.y + Math.floor(index / MEMORY_GRID_SIZE)
    };
  }

  /**
   * Seat 1's card picker.
   *
   * 1. Complete a known pair (including a partner for the face-up card).
   * 2. Otherwise take a random card it has never seen.
   * 3. Otherwise take any random unmatched, non-face-up card.
   *
   * @returns {number|null}
   */
  chooseAiCard(seat = 1) {
    if (!this.active || this.phase !== PHASES.PLAYING) return null;
    if (this.revealTimer > 0 || this.finished) return null;

    const available = [];
    for (let index = 0; index < this.cards.length; index++) {
      const card = this.cards[index];
      if (!card || card.matched || this.faceUp.includes(index)) continue;
      available.push(index);
    }
    if (!available.length) return null;

    const faceUpIndex = this.faceUp.length === 1 ? this.faceUp[0] : null;
    if (faceUpIndex !== null) {
      const symbol = this.aiMemory.get(faceUpIndex) ?? this.cards[faceUpIndex]?.symbol;
      const partner = available.find(index => this.aiMemory.get(index) === symbol);
      if (partner !== undefined) return partner;
    }

    const known = available.filter(index => this.aiMemory.has(index));
    const unknown = available.filter(index => !this.aiMemory.has(index));

    // Prefer a fully known pair among cards that are not currently face-up.
    const bySymbol = new Map();
    for (const index of known) {
      const symbol = this.aiMemory.get(index);
      const group = bySymbol.get(symbol) || [];
      group.push(index);
      bySymbol.set(symbol, group);
    }
    const groups = [...bySymbol.values()].filter(group => group.length >= 2);
    if (groups.length) {
      const group = groups[this._pickIndex(groups.length)];
      return group[this._pickIndex(group.length)];
    }

    if (unknown.length) return unknown[this._pickIndex(unknown.length)];
    return available[this._pickIndex(available.length)];
  }

  serialize() {
    return {
      ...super.serialize(),
      scores: [...this.scores],
      turnSeat: this.turnSeat,
      matched: this.cards.filter(card => card.matched).length,
      winnerSeat: this.winnerSeat
    };
  }

  /** Ground layer only; world coordinates, no camera subtraction. */
  render(ctx, layer, view = {}) {
    if (!this.active || layer !== 'ground' || !this.placement) return false;
    const tile = Number.isFinite(view?.tileSize) && view.tileSize > 0 ? view.tileSize : 48;
    const origin = originOf(this.placement);
    const boardX = origin.x * tile;
    const boardY = origin.y * tile;
    const boardSize = MEMORY_GRID_SIZE * tile;

    ctx.save();

    // Wooden table under the cards.
    ctx.fillStyle = '#5b3d26';
    ctx.fillRect(boardX - 6, boardY - 6, boardSize + 12, boardSize + 12);
    ctx.fillStyle = '#7d5734';
    ctx.fillRect(boardX - 3, boardY - 3, boardSize + 6, boardSize + 6);

    const pad = Math.max(2, tile * 0.07);
    for (let row = 0; row < MEMORY_GRID_SIZE; row++) {
      for (let col = 0; col < MEMORY_GRID_SIZE; col++) {
        const index = row * MEMORY_GRID_SIZE + col;
        const card = this.cards[index];
        if (!card) continue;
        const x = boardX + col * tile + pad;
        const y = boardY + row * tile + pad;
        const w = tile - pad * 2;
        const h = tile - pad * 2;
        const faceUp = card.matched || this.faceUp.includes(index);

        if (faceUp) {
          ctx.fillStyle = '#f3ead2';
          ctx.fillRect(x, y, w, h);
          ctx.strokeStyle = '#8a6a44';
          ctx.lineWidth = Math.max(1, tile * 0.04);
          ctx.strokeRect(x, y, w, h);

          if (card.matched) {
            ctx.fillStyle = 'rgba(120, 200, 150, 0.5)';
            ctx.fillRect(x, y, w, h);
          }

          ctx.fillStyle = card.matched ? '#245c39' : '#3b3224';
          ctx.font = `${Math.max(12, Math.round(tile * 0.5))}px system-ui, sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(GLYPHS[card.symbol] || '?', x + w / 2, y + h / 2 + 1);
        } else {
          ctx.fillStyle = '#2f5d46';
          ctx.fillRect(x, y, w, h);
          ctx.strokeStyle = '#9fd6b0';
          ctx.lineWidth = Math.max(1, tile * 0.035);
          ctx.strokeRect(x, y, w, h);

          // Simple inset diamond so backs read as cards, not empty tiles.
          ctx.strokeStyle = 'rgba(159, 214, 176, 0.55)';
          ctx.beginPath();
          ctx.moveTo(x + w / 2, y + h * 0.2);
          ctx.lineTo(x + w * 0.8, y + h / 2);
          ctx.lineTo(x + w / 2, y + h * 0.8);
          ctx.lineTo(x + w * 0.2, y + h / 2);
          ctx.closePath();
          ctx.stroke();
        }
      }
    }

    // Score / turn banner above the board.
    const bannerHeight = Math.max(18, tile * 0.52);
    const bannerY = boardY - bannerHeight - 10;
    ctx.fillStyle = 'rgba(20, 30, 22, 0.85)';
    ctx.fillRect(boardX, bannerY, boardSize, bannerHeight);
    ctx.fillStyle = '#edf4e9';
    ctx.font = `${Math.max(11, Math.round(tile * 0.28))}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const turnName = this.turnSeat === 0
      ? 'you'
      : (this.seatCharacters[1]?.name || 'friend');
    const label = this.finished
      ? (this.winnerSeat === null ? 'draw' : `${this.winnerSeat === 0 ? 'you win' : `${turnName} wins`}`)
      : `${this.scores[0]} – ${this.scores[1]} · ${turnName}'s turn`;
    ctx.fillText(label, boardX + boardSize / 2, bannerY + bannerHeight / 2 + 1);

    ctx.restore();
    return true;
  }

  close({ reason = 'closed' } = {}) {
    this.active = false;
    this.aiTarget = null;
    return super.close({ reason });
  }

  getFootprint() {
    if (!this.active || !this.placement) return null;
    const board = normalizeBoard(this.board);
    const origin = originOf(this.placement);
    return { x: origin.x, y: origin.y, width: board.width, height: board.height };
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  _resolvePlacement(placement, terrain) {
    const board = normalizeBoard(this.board);
    if (placement) {
      const origin = originOf(placement);
      if (!Number.isInteger(origin.x) || !Number.isInteger(origin.y)) {
        return { error: 'Invalid Memory Grid placement.' };
      }
      const spot = { originX: origin.x, originY: origin.y };
      if (terrain) {
        const check = validateFootprint({ terrain, placement: spot, board });
        if (!check.ok) {
          return { error: 'Need open ground with room to stand around to lay out Memory Grid.' };
        }
      }
      return { placement: spot };
    }

    const around = this.game?.player || this.seatCharacters[0] || null;
    if (!terrain || !around) {
      return { error: 'Need open ground with room to stand around to lay out Memory Grid.' };
    }
    const spot = findFootprintPlacement({
      terrain,
      board,
      around: { x: around.x, y: around.y }
    });
    if (!spot) {
      return { error: 'Need open ground with room to stand around to lay out Memory Grid.' };
    }
    return { placement: spot };
  }

  _resetRound() {
    this.cards = this._buildDeck();
    this.deck = this.cards;
    this.scores = [0, 0];
    this.turnSeat = 0;
    this.faceUp = [];
    this.revealTimer = 0;
    this.revealSeat = null;
    this.finished = false;
    this.winnerSeat = null;
    this.finishEvent = null;
    this.aiMemory = new Map();
    this.aiTarget = null;
  }

  _buildDeck() {
    const deck = [];
    for (let pair = 0; pair < MEMORY_GRID_PAIRS; pair++) {
      const symbol = MEMORY_SYMBOLS[pair % MEMORY_SYMBOLS.length];
      deck.push({ symbol, pairId: pair });
      deck.push({ symbol, pairId: pair });
    }
    for (let i = deck.length - 1; i > 0; i--) {
      const j = this._pickIndex(i + 1);
      const swap = deck[i];
      deck[i] = deck[j];
      deck[j] = swap;
    }
    return deck.map((card, index) => ({ index, ...card, matched: false }));
  }

  _pickIndex(length) {
    if (length <= 0) return 0;
    const value = Number(this.rng());
    const normalized = Number.isFinite(value)
      ? Math.min(0.999999999, Math.max(0, value))
      : Math.random();
    return Math.floor(normalized * length);
  }

  _seatOf(character) {
    if (!character) return -1;
    const index = this.seatCharacters.indexOf(character);
    return index >= 0 ? index : -1;
  }

  _collectCompanions() {
    const explicit = Array.isArray(this.options?.companions) ? this.options.companions : [];
    const companions = [];
    const add = companion => {
      if (companion && !companions.includes(companion)) companions.push(companion);
    };
    explicit.forEach(add);
    for (const character of this.seatCharacters) {
      if (!character?.id) continue;
      const found = this.game?.getCompanionsFor?.(character.id);
      if (Array.isArray(found)) found.forEach(add);
    }
    return companions;
  }

  _remember(index) {
    const card = this.cards[index];
    if (card) this.aiMemory.set(index, card.symbol);
  }

  _flip(seat, index) {
    this._remember(index);
    this.faceUp.push(index);

    if (this.faceUp.length < 2) {
      return createStepResult({ handled: true, changed: true });
    }

    const [first, second] = this.faceUp;
    const match = this.cards[first].symbol === this.cards[second].symbol;

    if (!match) {
      if (this.mismatchMs <= 0) {
        // Zero-beat option (tests/tuning): flip back and pass the turn at once.
        this.faceUp = [];
        this.turnSeat = 1 - seat;
        return createStepResult({ handled: true, changed: true });
      }
      this.revealTimer = this.mismatchMs;
      this.revealSeat = seat;
      return createStepResult({ handled: true, changed: true });
    }

    this.cards[first].matched = true;
    this.cards[second].matched = true;
    this.scores[seat] += 1;
    this.faceUp = [];

    const matchedPairs = this.cards.filter(card => card.matched).length / 2;
    if (matchedPairs < MEMORY_GRID_PAIRS) {
      return createStepResult({ handled: true, changed: true });
    }

    const winnerSeat = this.scores[0] === this.scores[1]
      ? null
      : (this.scores[0] > this.scores[1] ? 0 : 1);
    this.winnerSeat = winnerSeat;
    this.finished = true;
    const result = this.finish({ winnerSeat });
    return createStepResult({ handled: true, changed: true, events: result.events });
  }

  _finishReveal() {
    const seat = Number.isInteger(this.revealSeat) ? this.revealSeat : this.turnSeat;
    this.faceUp = [];
    this.revealTimer = 0;
    this.revealSeat = null;
    this.turnSeat = 1 - seat;
  }

  _updateAi() {
    if (this.turnSeat !== 1 || this.finished) return null;
    const character = this.seatCharacters[1];
    if (!character) return null;

    if (this.aiTarget) {
      const path = Array.isArray(character.path) ? character.path : [];
      const arrived = !character.moving
        && path.length === 0
        && character.x === this.aiTarget.x
        && character.y === this.aiTarget.y;
      if (!arrived) return null;

      const tile = { x: this.aiTarget.x, y: this.aiTarget.y };
      this.aiTarget = null;
      character.miniGameTarget = null;
      return this.handleInput({
        type: 'action',
        action: 'primary',
        character,
        seat: 1,
        tile
      });
    }

    const index = this.chooseAiCard(1);
    if (index === null) return null;
    const tile = this.tileForIndex(index);
    if (!tile) return null;

    character.inMiniGame = true;
    character.miniGameTarget = { x: tile.x, y: tile.y };
    this.aiTarget = { index, x: tile.x, y: tile.y };

    const from = character.moving
      ? { x: character.toX ?? character.x, y: character.toY ?? character.y }
      : { x: character.x, y: character.y };
    const path = this.game?.terrain ? findPath(this.game.terrain, from, tile) : [];

    if (path.length) {
      character.path = path;
      return createStepResult({ handled: true, changed: true });
    }

    if (from.x === tile.x && from.y === tile.y) {
      return createStepResult({ handled: true, changed: true });
    }

    // Documented fallback: no walkable route, so stand on the card directly.
    // The next update sees the arrival and runs the normal flip handler.
    character.moving = false;
    character.path = [];
    character.x = tile.x;
    character.y = tile.y;
    return createStepResult({ handled: true, changed: true });
  }

  _fail(message) {
    this.active = false;
    this.phase = PHASES.IDLE;
    this.placement = null;
    this.aiTarget = null;
    this.cards = [];
    this.deck = this.cards;
    this.scores = [0, 0];
    this.turnSeat = 0;
    this.faceUp = [];
    this.revealTimer = 0;
    this.revealSeat = null;
    this.aiMemory = new Map();
    return { ok: false, phase: this.phase, message };
  }
}

export function createMemoryGridGame(context = {}) {
  return new MemoryGridGame(context);
}
