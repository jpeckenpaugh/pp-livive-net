/**
 * Snakes and Ladders — a contract-native, two-seat 10×10 race to square 100.
 *
 * Seats alternate. The acting seat presses roll (or the seat 1 AI rolls after a
 * short delay), and their token walks forward square by square. Landing on the
 * foot of a ladder climbs it; landing on a snake's head slides down. A roll that
 * would overshoot 100 is forfeited, exactly like the classic paper board.
 *
 * Rules and state only: no DOM, timers, rewards, stats, or dialogue. The host
 * settles the single finish event this game emits. Snakes, ladders, dice, and
 * pacing all come from data/snakes-ladders.json.
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
import boardData from '../../data/snakes-ladders.json' with { type: 'json' };

export const SNAKES_LADDERS_SIZE = 10;
export const SNAKES_LADDERS_SQUARES = 100;
export const SNAKES_LADDERS_DICE = 6;
export const SNAKES_LADDERS_START = 0;

const DICE_PIPS = Object.freeze({
  1: [[0.5, 0.5]],
  2: [[0.3, 0.3], [0.7, 0.7]],
  3: [[0.28, 0.28], [0.5, 0.5], [0.72, 0.72]],
  4: [[0.3, 0.3], [0.7, 0.3], [0.3, 0.7], [0.7, 0.7]],
  5: [[0.3, 0.3], [0.7, 0.3], [0.5, 0.5], [0.3, 0.7], [0.7, 0.7]],
  6: [[0.3, 0.25], [0.7, 0.25], [0.3, 0.5], [0.7, 0.5], [0.3, 0.75], [0.7, 0.75]]
});
export const SNAKES_LADDERS_DATA = boardData;

const DEFAULT_BOARD = Object.freeze({
  width: SNAKES_LADDERS_SIZE,
  height: SNAKES_LADDERS_SIZE,
  margin: 1,
  blocksMovement: true,
  hiddenZones: []
});

const DEFAULT_META = Object.freeze({
  id: 'snakes-ladders',
  title: 'Snakes and Ladders',
  kind: 'board',
  itemId: 'snakes-ladders',
  dialogueKey: 'snakes-ladders',
  rewardKey: 'snakes-ladders',
  players: 2,
  seats: 2,
  board: DEFAULT_BOARD,
  input: { mode: 'action', actionLabel: 'roll' },
  renderLayers: ['ground'],
  timing: { openMs: 700, closeMs: 600, turnMs: 900 },
  persist: false,
  activity: 'turn-based'
});

// A 10×10 footprint plus its standing margin needs a 12×12 clearing. Try the
// nearest rings first; parks are not always tidy next to a tree, and a slightly
// farther pitch is better than refusing to unfold the board.
function createPlacementOffsets(maxRadius = 16) {
  const offsets = [];
  for (let radius = 1; radius <= maxRadius; radius++) {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) === radius) {
          offsets.push({ dx, dy });
        }
      }
    }
  }
  return offsets;
}

const PLACEMENT_OFFSETS = Object.freeze(createPlacementOffsets(16));

const SEAT_COLORS = Object.freeze(['#e07a3f', '#3f8ea0']);
const FAILURE_MESSAGE = 'Need open ground with room to stand around to lay out Snakes and Ladders.';

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function clampRoll(value, sides) {
  const numeric = Number(value);
  const normalized = Number.isFinite(numeric)
    ? Math.min(0.999999999, Math.max(0, numeric))
    : Math.random();
  return Math.floor(normalized * sides) + 1;
}

/**
 * Resolve the authored board into the shape the rules use. Invalid transitions
 * are ignored rather than throwing, so a data typo degrades to a plain board.
 */
export function normalizeSnakesLaddersData(source = SNAKES_LADDERS_DATA) {
  const size = isPositiveInteger(source?.board?.size)
    ? source.board.size
    : SNAKES_LADDERS_SIZE;
  const squares = isPositiveInteger(source?.board?.squares)
    ? source.board.squares
    : size * size;
  const diceSides = isPositiveInteger(source?.dice?.sides)
    ? source.dice.sides
    : SNAKES_LADDERS_DICE;
  const start = Number.isInteger(source?.start) ? source.start : SNAKES_LADDERS_START;
  const transitions = new Map();

  const snakes = (Array.isArray(source?.snakes) ? source.snakes : [])
    .filter(entry => Number.isInteger(entry?.from) && Number.isInteger(entry?.to))
    .filter(entry => entry.from > entry.to && entry.to >= 0 && entry.from <= squares)
    .map(entry => ({ from: entry.from, to: entry.to }));
  for (const snake of snakes) {
    if (!transitions.has(snake.from)) {
      transitions.set(snake.from, { kind: 'snake', from: snake.from, to: snake.to });
    }
  }

  const ladders = (Array.isArray(source?.ladders) ? source.ladders : [])
    .filter(entry => Number.isInteger(entry?.from) && Number.isInteger(entry?.to))
    .filter(entry => entry.to > entry.from && entry.from >= 0 && entry.to <= squares)
    .map(entry => ({ from: entry.from, to: entry.to }));
  for (const ladder of ladders) {
    if (!transitions.has(ladder.from)) {
      transitions.set(ladder.from, { kind: 'ladder', from: ladder.from, to: ladder.to });
    }
  }

  return {
    size,
    squares,
    diceSides,
    start,
    snakes,
    ladders,
    transitions,
    stepMs: Number.isFinite(source?.timing?.stepMs)
      ? Math.max(0, source.timing.stepMs)
      : 170,
    aiDelayMs: Number.isFinite(source?.timing?.aiDelayMs)
      ? Math.max(0, source.timing.aiDelayMs)
      : (DEFAULT_META.timing?.turnMs ?? 900)
  };
}

function seatCharacter(seat) {
  return seat?.character ?? seat ?? null;
}

function seatEntry(value, index) {
  if (!value) return null;
  const character = seatCharacter(value);
  if (!character) return null;
  return {
    index,
    character,
    controller: value.controller || (index === 0 ? 'human' : 'ai'),
    role: value.role || (index === 0 ? 'player' : 'opponent')
  };
}

function currentTile(character) {
  if (!character) return null;
  if (character.moving && Number.isFinite(character.toX) && Number.isFinite(character.toY)) {
    return { x: character.toX, y: character.toY };
  }
  if (!Number.isFinite(character.x) || !Number.isFinite(character.y)) return null;
  return { x: character.x, y: character.y };
}

export class SnakesLaddersGame extends MiniGameBase {
  constructor({ host = null, meta = null, game = null, options = {} } = {}) {
    super(meta || DEFAULT_META);
    this.host = host;
    this.game = game || options?.game || host?.game || null;
    this.options = { ...(options || {}) };

    this.data = normalizeSnakesLaddersData(options?.boardData || options?.data);
    this.rng = typeof this.options.rng === 'function' ? this.options.rng : Math.random;
    this.stepMs = Number.isFinite(this.options.stepMs)
      ? Math.max(0, this.options.stepMs)
      : this.data.stepMs;
    this.aiDelayMs = Number.isFinite(this.options.aiDelayMs)
      ? Math.max(0, this.options.aiDelayMs)
      : this.data.aiDelayMs;

    this.active = false;
    this.seatEntries = [];
    this.seatCharacters = [null, null];
    this.seatTargets = [];
    this.abandonPromptActive = false;
    this.returningToBoard = false;
    this._resetRound();
  }

  get board() {
    return this.meta?.board || DEFAULT_BOARD;
  }

  open({ seats = [], placement = null, options = {} } = {}) {
    const base = super.open({ seats, placement, options });
    if (typeof options?.rng === 'function') this.rng = options.rng;
    if (Number.isFinite(options?.stepMs)) this.stepMs = Math.max(0, options.stepMs);
    if (Number.isFinite(options?.aiDelayMs)) this.aiDelayMs = Math.max(0, options.aiDelayMs);
    if (options?.boardData || options?.data) {
      this.data = normalizeSnakesLaddersData(options.boardData || options.data);
    }
    this.options = { ...this.options, ...(options || {}) };

    this._resetRound();
    this.active = false;

    const rawSeats = Array.isArray(seats) ? seats : [];
    this.seatEntries = rawSeats.map((entry, index) => seatEntry(entry, index)).filter(Boolean);
    this.seatCharacters = [null, null];
    for (const entry of this.seatEntries) {
      if (entry.index < 2) this.seatCharacters[entry.index] = entry.character;
    }
    if (!this.seatEntries.length || !this.seatCharacters[0]) {
      return this._fail('No one is seated at the Snakes and Ladders table.');
    }

    const terrain = this.game?.terrain || options?.terrain || this.options?.terrain || null;
    const anchor = currentTile(this.game?.player) || currentTile(this.seatCharacters[0]);
    if (!anchor) return this._fail('No player is standing near enough to set up Snakes and Ladders.');

    let candidate = null;
    if (placement) {
      candidate = {
        originX: placement.originX ?? placement.x,
        originY: placement.originY ?? placement.y
      };
    } else {
      if (!terrain) return this._fail(FAILURE_MESSAGE);
      candidate = findFootprintPlacement({
        terrain,
        board: this.board,
        around: anchor,
        offsets: PLACEMENT_OFFSETS
      });
      if (!candidate) return this._fail(FAILURE_MESSAGE);
    }

    const check = validateFootprint({ terrain, placement: candidate, board: normalizeBoard(this.board) });
    if (!check.ok) return this._fail(FAILURE_MESSAGE);
    this.placement = { originX: check.footprint.x, originY: check.footprint.y };

    const companions = this._resolveCompanions(this.seatCharacters);
    this.seatTargets = stageSeats({
      terrain,
      seats: this.seatEntries,
      placement: this.placement,
      board: this.board
    });
    stageCompanions({
      terrain,
      companions,
      placement: this.placement,
      board: this.board
    });

    const reserved = new Set();
    for (const character of [...this.seatCharacters, ...companions]) {
      const tile = currentTile(character);
      if (tile) reserved.add(`${tile.x},${tile.y}`);
      if (character?.stagedDestination) {
        reserved.add(`${character.stagedDestination.x},${character.stagedDestination.y}`);
      }
    }
    evacuateBystanders({
      terrain,
      placement: this.placement,
      board: this.board,
      participants: [...this.seatCharacters, ...companions].filter(Boolean),
      characters: [...(this.game?.npcs || []), ...(this.game?.companions || [])],
      reserved
    });

    for (const character of this.seatCharacters) {
      if (character) character.inMiniGame = true;
    }

    this.turn = 0;
    this.active = true;
    this.phase = PHASES.PLAYING;
    return { ok: true, phase: this.phase, durationMs: base.durationMs };
  }

  ready() {
    this.phase = this.active ? PHASES.PLAYING : PHASES.IDLE;
    return { ok: this.active, phase: this.phase };
  }

  update(dtMs) {
    const dt = Number.isFinite(dtMs) ? Math.max(0, dtMs) : 0;
    this._advanceDiceVisual(dt);
    if (!this.active || this.phase !== PHASES.PLAYING || this.finished) {
      return emptyStepResult();
    }
    this._checkAbandon();

    if (this.motion) return this._advanceMotion(dt);

    if (this.turn === 1 && this.seatCharacters[1]) {
      this.aiWaitMs += dt;
      if (this.aiWaitMs >= this.aiDelayMs) {
        this.aiWaitMs = 0;
        return this.rollForSeat(1);
      }
    }

    return emptyStepResult();
  }

  /** The player's only input: roll for their seat. */
  handleInput(input = {}) {
    if (!this.active || this.phase !== PHASES.PLAYING || this.finished) {
      return emptyStepResult();
    }
    const kind = input.kind || input.type;
    if (kind && kind !== 'action') return emptyStepResult();

    const seat = Number.isInteger(input.seat)
      ? input.seat
      : this.seatCharacters.indexOf(input.character);
    if (seat !== 0 && seat !== 1) return emptyStepResult();
    const fromHuman = seat === 0 && input.controller !== 'ai';

    if (this.turn !== seat) {
      return fromHuman ? this._reject('not-turn') : emptyStepResult();
    }
    if (this.motion) {
      return fromHuman ? this._reject('illegal') : emptyStepResult();
    }

    return this.rollForSeat(seat);
  }

  /**
   * Roll one die for a seat, then either start the walk or (on an overshoot)
   * stay put and hand the turn over immediately.
   */
  rollForSeat(seat = this.turn) {
    if (!this.active || this.phase !== PHASES.PLAYING || this.finished) {
      return emptyStepResult();
    }
    if (seat !== 0 && seat !== 1) return emptyStepResult();
    if (this.motion) return seat === 0 ? this._reject('illegal') : emptyStepResult();
    if (this.turn !== seat) return seat === 0 ? this._reject('not-turn') : emptyStepResult();

    const value = this.rollDice();
    const from = this.positions[seat];
    const landing = from + value;
    const overshoot = landing > this.data.squares;

    this.lastRoll = value;
    this.lastRollSeat = seat;
    this.rollCount += 1;

    // Visual only: the die leaves the roller's tile, arcs over the board, and
    // settles near the centre. It never gate-keeps the turn.
    const seatCharacter = this._characterForSeat(seat);
    if (this.placement) {
      const origin = originOf(this.placement);
      const startTile = seatCharacter
        ? { x: seatCharacter.x, y: seatCharacter.y }
        : (this.squarePosition(0) || { x: origin.x - 1, y: origin.y + this.data.size - 1 });
      const offsetX = ((this.rollCount * 7 + value * 3) % 5) - 2;
      const offsetY = ((this.rollCount * 5 + value * 2) % 5) - 2;
      this.diceAnim = {
        seat,
        value,
        elapsed: 0,
        duration: 620,
        holdMs: 520,
        startX: startTile.x,
        startY: startTile.y,
        endX: origin.x + (this.data.size - 1) / 2 + offsetX * 0.5,
        endY: origin.y + (this.data.size - 1) / 2 + offsetY * 0.5
      };
    }

    const events = [{
      type: 'roll',
      seat,
      value,
      from,
      to: overshoot ? from : landing,
      overshoot
    }];

    if (overshoot) {
      events.push({
        type: 'toast',
        message: `${this._seatLabel(seat)} rolled ${value} — needs exactly ${this.data.squares - from} to finish.`
      });
      this._passTurn(events);
      return createStepResult({ handled: true, changed: true, events });
    }

    this.motion = {
      seat,
      value,
      from,
      remaining: value,
      elapsed: 0
    };
    return createStepResult({ handled: true, changed: true, events });
  }

  /** One fair die from the injected RNG. */
  rollDice() {
    return clampRoll(this.rng(), this.data.diceSides);
  }

  /** World tile for a square, boustrophedon from the bottom-left. */
  squarePosition(square) {
    if (!this.placement) return null;
    const origin = originOf(this.placement);
    const size = this.data.size;
    if (square <= 0) {
      return { x: origin.x - 1, y: origin.y + size - 1 };
    }
    const bounded = Math.min(this.data.squares, Math.max(1, Math.trunc(square)));
    const index = bounded - 1;
    const rowFromBottom = Math.floor(index / size);
    const offset = index % size;
    const col = rowFromBottom % 2 === 0 ? offset : size - 1 - offset;
    const rowFromTop = size - 1 - rowFromBottom;
    return { x: origin.x + col, y: origin.y + rowFromTop };
  }

  /** Map a board tile to its square number, or null off the board. */
  squareAtTile(x, y) {
    if (!this.placement) return null;
    const origin = originOf(this.placement);
    const size = this.data.size;
    const col = Math.trunc(x) - origin.x;
    const rowFromTop = Math.trunc(y) - origin.y;
    if (col < 0 || col >= size || rowFromTop < 0 || rowFromTop >= size) return null;
    const rowFromBottom = size - 1 - rowFromTop;
    const offset = rowFromBottom % 2 === 0 ? col : size - 1 - col;
    return rowFromBottom * size + offset + 1;
  }

  describeStatus() {
    if (!this.active) return null;
    if (this.phase !== PHASES.PLAYING || this.finished) {
      return { turnSeat: null, instruction: null, detail: null };
    }
    return {
      turnSeat: Number.isInteger(this.turn) ? this.turn : null,
      instruction: this.motion ? null : (this.meta?.strip?.instruction || null),
      detail: this._detailText()
    };
  }

  serialize() {
    return {
      ...super.serialize(),
      positions: [...this.positions],
      turn: this.turn,
      lastRoll: this.lastRoll,
      rollCount: this.rollCount,
      winnerSeat: this.winnerSeat,
      finished: this.finished
    };
  }

  getFootprint() {
    if (!this.active || !this.placement) return null;
    const board = normalizeBoard(this.board);
    const origin = originOf(this.placement);
    return { x: origin.x, y: origin.y, width: board.width, height: board.height };
  }

  render(ctx, layer, view = {}) {
    if (!this.active || layer !== 'ground' || !this.placement) return false;
    const tile = Number.isFinite(view?.tileSize) && view.tileSize > 0 ? view.tileSize : 48;
    const origin = originOf(this.placement);
    const size = this.data.size;
    const boardX = origin.x * tile;
    const boardY = origin.y * tile;
    const boardSize = size * tile;
    const pad = Math.max(3, tile * 0.13);

    ctx.save();

    // Wooden frame and cream playing surface.
    ctx.fillStyle = 'rgba(0, 0, 0, 0.22)';
    ctx.fillRect(boardX - pad + 3, boardY - pad + 5, boardSize + pad * 2, boardSize + pad * 2);
    ctx.fillStyle = '#6b4426';
    ctx.fillRect(boardX - pad, boardY - pad, boardSize + pad * 2, boardSize + pad * 2);
    ctx.strokeStyle = '#3f2716';
    ctx.lineWidth = Math.max(1, tile * 0.06);
    ctx.strokeRect(boardX - pad, boardY - pad, boardSize + pad * 2, boardSize + pad * 2);

    for (let row = 0; row < size; row++) {
      for (let col = 0; col < size; col++) {
        const x = boardX + col * tile;
        const y = boardY + row * tile;
        const number = this.squareAtTile(origin.x + col, origin.y + row);
        const even = (row + col) % 2 === 0;
        ctx.fillStyle = even ? '#f3ead2' : '#dce7c8';
        ctx.fillRect(x + 0.5, y + 0.5, tile - 1, tile - 1);

        if (number) {
          ctx.fillStyle = 'rgba(66, 84, 54, 0.55)';
          ctx.font = `${Math.max(8, Math.round(tile * 0.2))}px system-ui, sans-serif`;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'top';
          ctx.fillText(String(number), x + tile * 0.1, y + tile * 0.08);
        }
      }
    }

    // Route guides: a small chevron at each row end makes the serpentine path
    // readable even where no snake or ladder crosses it.
    ctx.strokeStyle = 'rgba(87, 110, 70, 0.45)';
    ctx.lineWidth = Math.max(1, tile * 0.045);
    ctx.lineCap = 'round';
    for (let rowFromBottom = 0; rowFromBottom < size - 1; rowFromBottom++) {
      const even = rowFromBottom % 2 === 0;
      const col = even ? size - 1 : 0;
      const rowFromTop = size - 1 - rowFromBottom;
      const cx = boardX + (col + 0.5) * tile;
      const cy = boardY + rowFromTop * tile + tile * 0.82;
      ctx.beginPath();
      ctx.moveTo(cx - tile * 0.12, cy);

      // Up into the next row, then back across it.
      ctx.lineTo(cx, cy - tile * 0.12);
      ctx.lineTo(cx + tile * 0.12, cy);
      ctx.stroke();
    }

    for (const ladder of this.data.ladders) this._drawLadder(ctx, ladder, tile);
    for (const snake of this.data.snakes) this._drawSnake(ctx, snake, tile);
    this._drawStart(ctx, tile);

    this.positions.forEach((position, seat) => {
      this._drawToken(ctx, seat, position, tile);
    });

    this._drawDice(ctx, tile);

    // Turn / dice banner above the frame.
    const bannerHeight = Math.max(18, tile * 0.6);
    const bannerY = boardY - pad - bannerHeight - tile * 0.06;
    ctx.fillStyle = 'rgba(20, 30, 22, 0.85)';
    ctx.fillRect(boardX, bannerY, boardSize, bannerHeight);
    ctx.fillStyle = '#edf4e9';
    ctx.font = `700 ${Math.max(11, Math.round(tile * 0.26))}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(this._bannerText(), boardX + boardSize / 2, bannerY + bannerHeight / 2 + 1);

    ctx.restore();
    return true;
  }

  close({ reason = 'closed' } = {}) {
    this.active = false;
    this.motion = null;
    this.diceAnim = null;
    this.abandonPromptActive = false;
    this.returningToBoard = false;
    return super.close({ reason });
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  _resetRound() {
    const start = Number.isInteger(this.data?.start) ? this.data.start : SNAKES_LADDERS_START;
    this.positions = [start, start];
    this.turn = 0;
    this.lastRoll = null;
    this.lastRollSeat = null;
    this.motion = null;
    this.diceAnim = null;
    this.lastTransition = null;
    this.aiWaitMs = 0;
    this.winnerSeat = null;
    this.finished = false;
    this.rollCount = 0;
    this.finishEvent = null;
    this.abandonPromptActive = false;
    this.returningToBoard = false;
  }

  _advanceDiceVisual(dt) {
    if (!this.diceAnim) return;
    this.diceAnim.elapsed += dt;
    if (this.diceAnim.elapsed >= this.diceAnim.duration + this.diceAnim.holdMs) {
      this.diceAnim = null;
    }
  }

  _advanceMotion(dt) {
    const motion = this.motion;
    motion.elapsed += dt;
    let changed = false;

    while (motion.remaining > 0) {
      if (this.stepMs > 0 && motion.elapsed < this.stepMs) break;
      if (this.stepMs > 0) motion.elapsed -= this.stepMs;
      this.positions[motion.seat] += 1;
      motion.remaining -= 1;
      changed = true;
    }

    if (motion.remaining > 0) {
      return createStepResult({ handled: changed, changed });
    }

    const seat = motion.seat;
    this.motion = null;
    return this._land(seat);
  }

  _land(seat) {
    const events = [];
    const landed = this.positions[seat];
    const transition = this.data.transitions.get(landed);

    if (transition) {
      this.positions[seat] = transition.to;
      this.lastTransition = {
        seat,
        kind: transition.kind,
        from: transition.from,
        to: transition.to
      };
      events.push({
        type: 'slide',
        seat,
        kind: transition.kind,
        from: transition.from,
        to: transition.to
      });
      events.push({
        type: 'toast',
        message: transition.kind === 'ladder'
          ? `Ladder! ${this._seatLabel(seat)} climbs ${transition.from} → ${transition.to}.`
          : `Snake! ${this._seatLabel(seat)} slides ${transition.from} → ${transition.to}.`
      });
    }

    if (this.positions[seat] >= this.data.squares) {
      return this._finish(seat, events);
    }

    this._passTurn(events);
    return createStepResult({ handled: true, changed: true, events });
  }

  _finish(seat, events = []) {
    this.finished = true;
    this.winnerSeat = seat;
    this.turn = null;
    this.motion = null;
    const result = this.finish({ winnerSeat: seat });
    events.push(...result.events);
    return createStepResult({ handled: true, changed: true, events });
  }

  _passTurn(events) {
    this.turn = this.turn === 0 ? 1 : 0;
    this.aiWaitMs = 0;
    events.push({
      type: 'turn',
      seat: this.turn,
      characterId: this._characterForSeat(this.turn)?.id ?? null
    });
  }

  _reject(reason) {
    return createStepResult({ handled: true, changed: false, events: [{ type: 'reject', reason }] });
  }

  _seatLabel(seat) {
    if (seat === 0) return 'you';
    return this.seatCharacters[1]?.name || 'friend';
  }

  _detailText() {
    const die = Number.isInteger(this.lastRoll) ? `🎲 ${this.lastRoll}` : '🎲 –';
    const start = this.data.start;
    const label = value => (value <= start ? 'start' : String(value));
    return `${die} · you ${label(this.positions[0])} · ${this._seatLabel(1)} ${label(this.positions[1])}`;
  }

  _bannerText() {
    if (this.finished) {
      if (this.winnerSeat === 0) return 'you win!';
      if (this.winnerSeat === 1) return `${this._seatLabel(1)} wins!`;
      return 'race over';
    }
    if (this.motion) return `${this._seatLabel(this.motion.seat)} rolling ${this.lastRoll}…`;
    const turn = this.turn === 0 ? 'your turn' : `${this._seatLabel(1)}'s turn`;
    const die = Number.isInteger(this.lastRoll) ? `dice ${this.lastRoll}` : 'dice –';
    return `${turn} · ${die}`;
  }

  _characterForSeat(seat) {
    return this.seatEntries.find(entry => entry.index === seat)?.character || null;
  }

  _resolveCompanions(characters) {
    const explicit = Array.isArray(this.options?.companions) ? this.options.companions : null;
    if (explicit) return [...new Set(explicit.filter(Boolean))];

    const resolver = this.game?.getCompanionsFor;
    if (typeof resolver !== 'function') return [];
    const resolved = [];
    for (const character of characters) {
      if (!character?.id) continue;
      let found = [];
      try {
        found = resolver.call(this.game, character.id) || [];
      } catch (error) {
        found = [];
      }
      for (const companion of found) {
        if (companion && !resolved.includes(companion)) resolved.push(companion);
      }
    }
    return resolved;
  }

  _drawStart(ctx, tile) {
    const tilePos = this.squarePosition(0);
    if (!tilePos) return;
    const cx = (tilePos.x + 0.5) * tile;
    const cy = (tilePos.y + 0.5) * tile;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, tile * 0.34, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(238, 228, 202, 0.9)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(95, 70, 42, 0.65)';
    ctx.lineWidth = Math.max(1, tile * 0.04);
    ctx.stroke();
    ctx.fillStyle = 'rgba(76, 92, 62, 0.8)';
    ctx.font = `${Math.max(7, Math.round(tile * 0.16))}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('start', cx, cy);
    ctx.restore();
  }

  _drawLadder(ctx, ladder, tile) {
    const from = this.squarePosition(ladder.from);
    const to = this.squarePosition(ladder.to);
    if (!from || !to) return;

    const ax = (from.x + 0.5) * tile;
    const ay = (from.y + 0.5) * tile;
    const bx = (to.x + 0.5) * tile;
    const by = (to.y + 0.5) * tile;
    const dx = bx - ax;
    const dy = by - ay;
    const length = Math.hypot(dx, dy) || 1;
    const nx = -dy / length;
    const ny = dx / length;
    const gap = Math.max(3, tile * 0.16);

    ctx.save();
    ctx.strokeStyle = 'rgba(122, 79, 42, 0.82)';
    ctx.lineWidth = Math.max(1.5, tile * 0.055);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(ax + nx * gap, ay + ny * gap);
    ctx.lineTo(bx + nx * gap, by + ny * gap);
    ctx.moveTo(ax - nx * gap, ay - ny * gap);
    ctx.lineTo(bx - nx * gap, by - ny * gap);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(190, 137, 74, 0.9)';
    ctx.lineWidth = Math.max(1, tile * 0.04);
    const rungs = Math.max(2, Math.round(length / (tile * 0.55)));
    ctx.beginPath();
    for (let i = 1; i < rungs; i++) {
      const t = i / rungs;
      const x = ax + dx * t;
      const y = ay + dy * t;
      ctx.moveTo(x + nx * gap, y + ny * gap);
      ctx.lineTo(x - nx * gap, y - ny * gap);
    }
    ctx.stroke();
    ctx.restore();
  }

  _drawSnake(ctx, snake, tile) {
    const from = this.squarePosition(snake.from);
    const to = this.squarePosition(snake.to);
    if (!from || !to) return;

    const ax = (from.x + 0.5) * tile;
    const ay = (from.y + 0.5) * tile;
    const bx = (to.x + 0.5) * tile;
    const by = (to.y + 0.5) * tile;
    const dx = bx - ax;
    const dy = by - ay;
    const length = Math.hypot(dx, dy) || 1;
    const nx = -dy / length;
    const ny = dx / length;
    const points = [];
    const segments = 22;

    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const wobble = Math.sin(t * Math.PI * 3) * Math.sin(t * Math.PI) * tile * 0.7;
      points.push({
        x: ax + dx * t + nx * wobble,
        y: ay + dy * t + ny * wobble
      });
    }

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(34, 92, 56, 0.85)';
    ctx.lineWidth = Math.max(2, tile * 0.12);
    ctx.beginPath();
    points.forEach((point, index) => {
      if (index === 0) ctx.moveTo(point.x, point.y);
      else ctx.lineTo(point.x, point.y);
    });
    ctx.stroke();

    ctx.strokeStyle = 'rgba(126, 174, 96, 0.75)';
    ctx.lineWidth = Math.max(1, tile * 0.045);
    ctx.setLineDash([tile * 0.16, tile * 0.12]);
    ctx.beginPath();
    points.forEach((point, index) => {
      if (index === 0) ctx.moveTo(point.x, point.y);
      else ctx.lineTo(point.x, point.y);
    });
    ctx.stroke();
    ctx.setLineDash([]);

    // Head at the landed-on square.
    ctx.beginPath();
    ctx.arc(ax, ay, tile * 0.16, 0, Math.PI * 2);
    ctx.fillStyle = '#2f7d46';
    ctx.fill();
    ctx.strokeStyle = 'rgba(20, 58, 34, 0.9)';
    ctx.lineWidth = Math.max(1, tile * 0.035);
    ctx.stroke();
    ctx.fillStyle = '#f6f0dc';
    ctx.beginPath();
    ctx.arc(ax - tile * 0.05, ay - tile * 0.04, tile * 0.025, 0, Math.PI * 2);
    ctx.arc(ax + tile * 0.05, ay - tile * 0.04, tile * 0.025, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  _drawDice(ctx, tile) {
    const dice = this.diceAnim;
    if (!dice) return;

    const t = clamp01(dice.elapsed / dice.duration);
    const eased = t * t * (3 - 2 * t);
    const landed = dice.elapsed >= dice.duration;
    const holdT = landed ? clamp01((dice.elapsed - dice.duration) / dice.holdMs) : 0;
    const alpha = landed ? (holdT > 0.75 ? 1 - (holdT - 0.75) / 0.25 : 1) : 1;
    if (alpha <= 0) return;

    const startX = (dice.startX + 0.5) * tile;
    const startY = (dice.startY + 0.5) * tile;
    const endX = (dice.endX + 0.5) * tile;
    const endY = (dice.endY + 0.5) * tile;
    const arc = Math.sin(Math.PI * t) * Math.min(150, tile * 3);
    const cx = startX + (endX - startX) * eased;
    const cy = startY + (endY - startY) * eased - arc;
    const size = Math.max(12, tile * 0.62) * (landed ? 1 : 1 + 0.18 * Math.sin(Math.PI * t));
    const spin = landed ? 0 : (1 - eased) * Math.PI * 3 + (dice.seat === 0 ? 0 : Math.PI);

    ctx.save();
    ctx.globalAlpha = Math.max(0, alpha);

    // The landing shadow sits at the target and fills in as the die arrives.
    ctx.beginPath();
    ctx.ellipse(endX, endY + tile * 0.22, size * 0.4, size * 0.17, 0, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(15, 22, 16, ${landed ? 0.32 : 0.08 + eased * 0.24})`;
    ctx.fill();

    ctx.translate(cx, cy);
    ctx.rotate(spin);

    const half = size / 2;
    ctx.fillStyle = '#f7f1df';
    ctx.strokeStyle = '#3d3324';
    ctx.lineWidth = Math.max(1, tile * 0.035);
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(-half, -half, size, size, size * 0.18);
    } else {
      ctx.rect(-half, -half, size, size);
    }
    ctx.fill();
    ctx.stroke();

    const pips = DICE_PIPS[dice.value] || DICE_PIPS[1];
    const radius = Math.max(1.2, size * 0.075);
    ctx.fillStyle = '#2f2a20';
    for (const [px, py] of pips) {
      ctx.beginPath();
      ctx.arc(-half + px * size, -half + py * size, radius, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  _drawToken(ctx, seat, position, tile) {
    const tilePos = this.squarePosition(position);
    if (!tilePos) return;
    const bothHere = this.positions[0] === this.positions[1];
    const shift = bothHere ? (seat === 0 ? -1 : 1) * tile * 0.18 : 0;
    const cx = (tilePos.x + 0.5) * tile + shift;
    const cy = (tilePos.y + 0.5) * tile + (position <= this.data.start ? -tile * 0.12 : 0);
    const radius = Math.max(4, tile * 0.21);

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx + 1.5, cy + 2, radius, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(20, 25, 18, 0.28)';
    ctx.fill();

    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fillStyle = SEAT_COLORS[seat] || '#d9a441';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 250, 235, 0.92)';
    ctx.lineWidth = Math.max(1.5, tile * 0.045);
    ctx.stroke();
    ctx.restore();
  }

  _checkAbandon() {
    if (this.abandonPromptActive || this.finished) return;
    const player = this.seatCharacters[0];
    const footprint = this.getFootprint();
    if (!player || !footprint) return;

    const minX = footprint.x;
    const maxX = footprint.x + footprint.width - 1;
    const minY = footprint.y;
    const maxY = footprint.y + footprint.height - 1;
    const distance = Math.max(0, minX - player.x, player.x - maxX, minY - player.y, player.y - maxY);
    if (distance <= 2) {
      this.returningToBoard = false;
      return;
    }
    if (this.returningToBoard) return;

    const handler = this.options?.onAbandonPrompt;
    if (typeof handler !== 'function') return;
    this.abandonPromptActive = true;
    handler(
      () => { this.abandonPromptActive = false; },
      () => {
        this.abandonPromptActive = false;
        this.returningToBoard = true;
        this._returnPlayerToSeat();
      }
    );
  }

  _returnPlayerToSeat() {
    const player = this.seatCharacters[0];
    const target = this.seatTargets?.[0];
    if (!player || !target) return;
    const path = this.game?.terrain
      ? findPath(this.game.terrain, { x: player.x, y: player.y }, target)
      : [];
    if (path.length) player.path = path;
    else {
      player.x = target.x;
      player.y = target.y;
      player.path = [];
    }
  }

  _fail(message) {
    this.active = false;
    this.phase = PHASES.IDLE;
    this.placement = null;
    this.motion = null;
    this.seatCharacters = [null, null];
    this.seatEntries = [];
    this.seatTargets = [];
    this._resetRound();
    return { ok: false, phase: this.phase, message };
  }
}

export function createSnakesLaddersGame(context = {}) {
  return new SnakesLaddersGame(context);
}
