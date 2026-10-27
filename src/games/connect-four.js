/**
 * Connect Four — contract-native mini-game.
 *
 * Rules/state only: no DOM, timers, rewards, stats, or dialogue. The host
 * settles the finish event.
 *
 * Board geometry is fixed: 7 columns × 6 rows. Row 0 is the top row visually
 * and discs settle on the lowest empty row, so the row index grows downward.
 * Seats are 0 (human, red) and 1 (NPC, yellow).
 */
import {
  MiniGameBase,
  PHASES,
  createStepResult,
  emptyStepResult
} from '../minigames/contract.js';
import {
  findFootprintPlacement,
  validateFootprint,
  stageSeats,
  stageCompanions,
  evacuateBystanders
} from '../minigames/staging.js';
import { findPath } from '../world.js';

export const CONNECT_FOUR_COLUMNS = 7;
export const CONNECT_FOUR_ROWS = 6;

const COLUMNS = CONNECT_FOUR_COLUMNS;
const ROWS = CONNECT_FOUR_ROWS;
const SEATS = 2;
const DEFAULT_MARGIN = 1;
const FAILURE_MESSAGE = 'Need open ground with room to stand around to lay out Connect Four.';
const CENTER_TIERS = Object.freeze([[3], [2, 4], [1, 5], [0, 6]]);

function seatEntry(value, index) {
  if (!value) return null;
  const character = value.character ?? value;
  if (!character) return null;
  return {
    index,
    character,
    controller: value.controller || (index === 0 ? 'human' : 'ai'),
    role: value.role || (index === 0 ? 'player' : 'opponent')
  };
}

function emptyGrid() {
  return Array.from({ length: ROWS }, () => Array(COLUMNS).fill(null));
}

function tileOf(character) {
  if (!character) return null;
  if (character.moving && Number.isFinite(character.toX) && Number.isFinite(character.toY)) {
    return { x: character.toX, y: character.toY };
  }
  if (!Number.isFinite(character.x) || !Number.isFinite(character.y)) return null;
  return { x: character.x, y: character.y };
}

function toast(message) {
  return createStepResult({ handled: true, changed: false, events: [{ type: 'toast', message }] });
}

export class ConnectFourGame extends MiniGameBase {
  constructor({ host = null, meta = null, game = null, options = {} } = {}) {
    super(meta || {});
    this.host = host;
    this.game = game || options?.game || host?.game || null;
    this.options = options || {};
    this.active = false;
    this.grid = emptyGrid();
    this.turn = 0;
    this.lastMove = null;
    this.winnerSeat = null;
    this.moveCount = 0;
    this.finished = false;
    this.seatEntries = [];
    this.seatTargets = [];
    this.aiTimer = 0;
    this.aiPlan = null;
    this.aiWaitMs = 0;
    this.fallingDisc = null;
    this.dropMs = Number.isFinite(this.options.dropMs)
      ? Math.max(0, this.options.dropMs)
      : 320;
    this.abandonPromptActive = false;
    this.returningToBoard = false;
    this.board = {
      width: COLUMNS,
      height: ROWS,
      margin: Number.isInteger(this.meta?.board?.margin) ? this.meta.board.margin : DEFAULT_MARGIN,
      blocksMovement: this.meta?.board?.blocksMovement !== false,
      hiddenZones: Array.isArray(this.meta?.board?.hiddenZones) ? this.meta.board.hiddenZones : []
    };
  }

  /**
   * Stage the board and both seats. Honours an explicit placement, otherwise
   * searches around the human player (or seat 0). Fails cleanly with a message
   * when no open ground fits the metadata board.
   */
  open({ seats = [], placement = null, options = {} } = {}) {
    const base = super.open({ seats, placement, options });
    this.options = { ...this.options, ...(options || {}) };
    this.active = false;
    this.grid = emptyGrid();
    this.turn = 0;
    this.lastMove = null;
    this.winnerSeat = null;
    this.moveCount = 0;
    this.finished = false;
    this.aiTimer = 0;
    this.aiPlan = null;
    this.aiWaitMs = 0;
    this.fallingDisc = null;
    this.dropMs = Number.isFinite(options.dropMs)
      ? Math.max(0, options.dropMs)
      : this.dropMs;
    this.abandonPromptActive = false;
    this.returningToBoard = false;

    const rawSeats = Array.isArray(seats) ? seats : [];
    this.seatEntries = rawSeats
      .map((entry, index) => seatEntry(entry, index))
      .filter(Boolean);
    this.seats = this.seatEntries;

    if (!this.seatEntries.length) {
      return this._fail('No one is seated at the Connect Four table.');
    }

    const terrain = this.game?.terrain || this.options.terrain || null;
    const anchor = tileOf(this.game?.player) || tileOf(this.seatEntries[0]?.character);
    if (!anchor) {
      return this._fail('No player is standing near enough to set up Connect Four.');
    }

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
        around: anchor
      });
      if (!candidate) return this._fail(FAILURE_MESSAGE);
    }

    const check = validateFootprint({ terrain, placement: candidate, board: this.board });
    if (!check.ok) return this._fail(FAILURE_MESSAGE);

    this.placement = {
      originX: check.footprint.x,
      originY: check.footprint.y
    };

    const seatCharacters = this.seatEntries.map(entry => entry.character);
    const companions = this._resolveCompanions(seatCharacters);

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
    for (const character of [...seatCharacters, ...companions]) {
      const tile = tileOf(character);
      if (tile) reserved.add(`${tile.x},${tile.y}`);
      if (character?.stagedDestination) {
        reserved.add(`${character.stagedDestination.x},${character.stagedDestination.y}`);
      }
    }
    const bystanders = [
      ...(this.game?.npcs || []),
      ...(this.game?.companions || [])
    ];
    evacuateBystanders({
      terrain,
      placement: this.placement,
      board: this.board,
      participants: [...seatCharacters, ...companions],
      characters: bystanders,
      reserved
    });

    for (const character of seatCharacters) {
      if (!character) continue;
      character.inMiniGame = true;
    }

    const starter = this.options.startingSeat === 1 ? 1 : 0;
    this.turn = starter;
    this.active = true;
    this.phase = PHASES.PLAYING;
    return { ok: true, phase: this.phase, durationMs: base.durationMs };
  }

  ready() {
    this.phase = this.active ? PHASES.PLAYING : PHASES.IDLE;
    return { ok: this.active, phase: this.phase };
  }

  /** AI decision/movement timer. No setTimeout; the host ticks this. */
  update(dtMs = 0) {
    if (!this.active || this.phase !== PHASES.PLAYING) {
      return emptyStepResult();
    }

    const dt = Number.isFinite(dtMs) ? Math.max(0, dtMs) : 0;
    let changed = false;
    if (this.fallingDisc) {
      this.fallingDisc.elapsed += dt;
      changed = true;
      if (this.fallingDisc.elapsed >= this.fallingDisc.duration) {
        this.fallingDisc = null;
      }
    }
    if (this.finished || this.fallingDisc) {
      return createStepResult({ handled: changed, changed });
    }

    this._checkAbandon();
    if (this.turn !== 1) return emptyStepResult();
    const entry = this.seatEntries.find(seat => seat.index === 1) || null;
    if (entry?.controller === 'human' && !this.options.autoPlay) return emptyStepResult();
    const ai = entry?.character || null;

    if (!this.aiPlan) {
      this.aiTimer += dt;
      const thinkMs = Number.isFinite(this.options.aiThinkMs)
        ? Math.max(0, this.options.aiThinkMs)
        : (this.meta?.timing?.turnMs ?? 700);
      if (this.aiTimer < thinkMs) return emptyStepResult();

      const column = this.chooseAiColumn(1);
      if (column === null) {
        return this._finishDraw();
      }
      this.aiPlan = this._planAiMove(column);
      this.aiWaitMs = 0;
    }

    const plan = this.aiPlan;
    if (!plan) return emptyStepResult();

    const arrived = Boolean(ai)
      && !ai.moving
      && (!ai.path || ai.path.length === 0)
      && ai.x === plan.target.x
      && ai.y === plan.target.y;

    if (plan.instant || arrived) {
      const result = this._aiDrop(plan.column);
      this.aiPlan = null;
      return result;
    }

    this.aiWaitMs += dt;
    const stuckMs = Number.isFinite(this.options.aiStuckMs)
      ? Math.max(0, this.options.aiStuckMs)
      : 3000;
    if (this.aiWaitMs >= stuckMs) {
      // Documented fallback: if the AI cannot path to the column (or stalls),
      // drop directly. The disc still obeys gravity and the board footprint.
      if (ai) {
        ai.path = [];
        ai.moving = false;
        ai.miniGameTarget = null;
      }
      const result = this._aiDrop(plan.column);
      this.aiPlan = null;
      return result;
    }

    return emptyStepResult();
  }

  /**
   * Action input from a seated character. The character may stand on any tile
   * of the column; the disc drops to the lowest empty row.
   */
  handleInput(input = {}) {
    if (!this.active || this.phase !== PHASES.PLAYING || this.finished || this.fallingDisc) {
      return emptyStepResult();
    }
    const kind = input.kind || input.type;
    if (kind !== 'action') return emptyStepResult();

    const seat = Number.isInteger(input.seat)
      ? input.seat
      : this.seatEntries.findIndex(entry => entry.character === input.character);
    if (seat < 0 || seat >= SEATS) return emptyStepResult();

    const character = input.character || this._characterForSeat(seat);
    const tile = input.tile || tileOf(character);
    if (!tile) return toast('Step onto a tile in a column of the board to drop a disc.');

    if (this.turn !== seat) {
      const who = seat === 0 ? 'your' : `${this._seatName(1)}'s`;
      return toast(`It's ${who} turn.`);
    }

    const cell = this.cellAtTile(tile.x, tile.y);
    if (!cell) {
      return toast('Step onto a tile in a column of the board to drop a disc.');
    }

    const drop = this.dropDisc(cell.column, seat);
    if (!drop.ok) {
      if (drop.reason === 'column-full') {
        return toast('That column is full. Pick another column.');
      }
      return toast('That disc could not be dropped. Try another column.');
    }

    this.lastMove = drop;
    if (this.dropMs > 0) {
      this.fallingDisc = {
        row: drop.row,
        column: drop.column,
        col: drop.col,
        seat: drop.seat,
        elapsed: 0,
        duration: this.dropMs
      };
    }

    const winner = this.checkWinner(drop);
    if (winner !== null) {
      this.finished = true;
      this.winnerSeat = winner;
      this.turn = null;
      this.aiPlan = null;
      return this.finish({ winnerSeat: winner });
    }

    if (this.isBoardFull()) {
      return this._finishDraw();
    }

    this.turn = seat === 0 ? 1 : 0;
    this.aiTimer = 0;
    this.aiPlan = null;
    this.aiWaitMs = 0;

    const nextCharacter = this._characterForSeat(this.turn);
    return createStepResult({
      handled: true,
      changed: true,
      events: [{
        type: 'turn',
        seat: this.turn,
        characterId: nextCharacter?.id ?? null
      }]
    });
  }

  /** Map a board tile to its column and row. Returns null off the board. */
  cellAtTile(x, y) {
    if (!this.placement) return null;
    if (!Number.isInteger(x) || !Number.isInteger(y)) return null;
    const column = x - this.placement.originX;
    const row = y - this.placement.originY;
    if (column < 0 || column >= COLUMNS || row < 0 || row >= ROWS) return null;
    return { row, column, col: column, index: row * COLUMNS + column };
  }

  /** Drop a disc for a seat. Does not switch turns or settle a finish. */
  dropDisc(column, seat = this.turn) {
    if (!Number.isInteger(column) || column < 0 || column >= COLUMNS) {
      return { ok: false, reason: 'invalid-column' };
    }
    if (seat !== 0 && seat !== 1) {
      return { ok: false, reason: 'invalid-seat' };
    }

    let row = -1;
    for (let r = ROWS - 1; r >= 0; r--) {
      if (this.grid[r][column] === null) {
        row = r;
        break;
      }
    }
    if (row < 0) return { ok: false, reason: 'column-full', column };

    this.grid[row][column] = seat;
    this.moveCount += 1;
    const move = { row, column, col: column, seat };
    this.lastMove = move;
    return { ok: true, ...move };
  }

  /** Winner seat for the last move, or null. */
  checkWinner(lastMove = this.lastMove) {
    if (!lastMove) return null;
    const column = lastMove.column ?? lastMove.col;
    const row = lastMove.row;
    const seat = lastMove.seat;
    if (!Number.isInteger(row) || !Number.isInteger(column) || (seat !== 0 && seat !== 1)) {
      return null;
    }
    if (row < 0 || row >= ROWS || column < 0 || column >= COLUMNS) return null;
    if (this.grid[row][column] !== seat) return null;
    return this._winnerAt(row, column, seat);
  }

  isBoardFull() {
    return this.moveCount >= COLUMNS * ROWS
      || this.grid.every(row => row.every(cell => cell !== null));
  }

  isDraw() {
    return this.isBoardFull() && this.checkWinner(this.lastMove) === null;
  }

  /**
   * Seat 1 AI: win now, block seat 0's immediate win, prefer center columns,
   * otherwise pick randomly within the nearest center tier.
   */
  chooseAiColumn(seat = 1) {
    const legal = [];
    for (let column = 0; column < COLUMNS; column++) {
      if (this.grid[0][column] === null) legal.push(column);
    }
    if (!legal.length) return null;

    for (const column of legal) {
      if (this._wouldWin(column, seat)) return column;
    }

    const opponent = seat === 1 ? 0 : 1;
    for (const column of legal) {
      if (this._wouldWin(column, opponent)) return column;
    }

    for (const tier of CENTER_TIERS) {
      const options = tier.filter(column => legal.includes(column));
      if (options.length) {
        return options[Math.floor(Math.random() * options.length)];
      }
    }
    return legal[0];
  }

  render(ctx, layer, view = {}) {
    if (!this.active || layer !== 'ground' || !this.placement) return false;

    const tile = Number.isFinite(view?.tileSize) && view.tileSize > 0 ? view.tileSize : 48;
    const originX = this.placement.originX * tile;
    const originY = this.placement.originY * tile;
    const width = COLUMNS * tile;
    const height = ROWS * tile;
    const pad = Math.max(3, tile * 0.16);

    ctx.save();

    // Wooden frame and blue recessed face.
    ctx.fillStyle = 'rgba(0, 0, 0, 0.22)';
    ctx.fillRect(originX - pad + 3, originY - pad + 5, width + pad * 2, height + pad * 2);
    ctx.fillStyle = '#6b4426';
    ctx.fillRect(originX - pad, originY - pad, width + pad * 2, height + pad * 2);
    ctx.strokeStyle = '#3f2716';
    ctx.lineWidth = Math.max(1, tile * 0.06);
    ctx.strokeRect(originX - pad, originY - pad, width + pad * 2, height + pad * 2);
    ctx.fillStyle = '#1c5aa6';
    ctx.fillRect(originX, originY, width, height);

    const radius = tile * 0.36;
    const falling = this.fallingDisc;
    for (let row = 0; row < ROWS; row++) {
      for (let column = 0; column < COLUMNS; column++) {
        const cx = originX + (column + 0.5) * tile;
        const cy = originY + (row + 0.5) * tile;
        const disc = this.grid[row][column];
        if (falling && falling.row === row && falling.column === column) {
          // The falling disc is drawn separately, above the board.
          ctx.beginPath();
          ctx.arc(cx, cy, radius, 0, Math.PI * 2);
          ctx.fillStyle = '#123f78';
          ctx.fill();
          ctx.strokeStyle = 'rgba(8, 30, 60, 0.55)';
          ctx.lineWidth = Math.max(1, tile * 0.04);
          ctx.stroke();
          continue;
        }

        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        if (disc === 0) ctx.fillStyle = '#d64541';
        else if (disc === 1) ctx.fillStyle = '#f2c94c';
        else ctx.fillStyle = '#123f78';
        ctx.fill();
        ctx.strokeStyle = disc === null ? 'rgba(8, 30, 60, 0.55)' : 'rgba(30, 20, 10, 0.35)';
        ctx.lineWidth = Math.max(1, tile * 0.04);
        ctx.stroke();
      }
    }

    if (falling) {
      const progress = Math.min(1, Math.max(0, falling.elapsed / falling.duration));
      const ease = progress * progress;
      const startY = originY - tile * 0.8;
      const endY = originY + (falling.row + 0.5) * tile;
      const cx = originX + (falling.column + 0.5) * tile;
      const cy = startY + (endY - startY) * ease;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.fillStyle = falling.seat === 0 ? '#d64541' : '#f2c94c';
      ctx.fill();
      ctx.strokeStyle = 'rgba(30, 20, 10, 0.35)';
      ctx.lineWidth = Math.max(1, tile * 0.04);
      ctx.stroke();
    }

    // Last-drop highlight.
    if (this.lastMove && !falling) {
      const cx = originX + (this.lastMove.column + 0.5) * tile;
      const cy = originY + (this.lastMove.row + 0.5) * tile;
      ctx.beginPath();
      ctx.arc(cx, cy, radius * 0.9, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
      ctx.lineWidth = Math.max(1.5, tile * 0.08);
      ctx.stroke();
    }

    // Turn/result banner above the frame.
    const bannerHeight = Math.max(18, tile * 0.7);
    const bannerY = originY - pad - bannerHeight - tile * 0.08;
    ctx.fillStyle = 'rgba(20, 30, 22, 0.85)';
    ctx.fillRect(originX, bannerY, width, bannerHeight);
    ctx.fillStyle = '#edf4e9';
    ctx.font = `700 ${Math.max(11, Math.round(tile * 0.28))}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(this._bannerText(), originX + width / 2, bannerY + bannerHeight / 2);

    ctx.restore();
    return true;
  }

  close({ reason = 'closed' } = {}) {
    this.active = false;
    this.aiPlan = null;
    this.fallingDisc = null;
    this.abandonPromptActive = false;
    this.returningToBoard = false;
    return super.close({ reason });
  }

  serialize() {
    return {
      ...super.serialize(),
      grid: this.grid.map(row => [...row]),
      turn: this.turn,
      winnerSeat: this.winnerSeat,
      moveCount: this.moveCount,
      finished: this.finished
    };
  }

  getFootprint() {
    if (!this.placement) return null;
    return {
      x: this.placement.originX,
      y: this.placement.originY,
      width: COLUMNS,
      height: ROWS
    };
  }

  _fail(message) {
    this.active = false;
    this.phase = PHASES.IDLE;
    this.placement = null;
    return { ok: false, phase: this.phase, message };
  }

  _finishDraw() {
    this.finished = true;
    this.winnerSeat = null;
    this.turn = null;
    this.aiPlan = null;
    return this.finish({ winnerSeat: null });
  }

  _checkAbandon() {
    if (this.abandonPromptActive || this.finished) return;
    const player = this._characterForSeat(0);
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
    const player = this._characterForSeat(0);
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

  _characterForSeat(seat) {
    return this.seatEntries.find(entry => entry.index === seat)?.character || null;
  }

  _seatName(seat) {
    return this._characterForSeat(seat)?.name || (seat === 1 ? 'Yellow' : 'Red');
  }

  _bannerText() {
    if (this.finished) {
      if (this.winnerSeat === 0) return 'Red wins!';
      if (this.winnerSeat === 1) return 'Yellow wins!';
      return 'Draw game';
    }
    if (this.turn === 0) return 'Your turn - drop red';
    return `${this._seatName(this.turn)} - drop yellow`;
  }

  _winnerAt(row, column, seat) {
    const directions = [[0, 1], [1, 0], [1, 1], [1, -1]];
    for (const [dr, dc] of directions) {
      let count = 1;
      for (const sign of [-1, 1]) {
        let r = row + dr * sign;
        let c = column + dc * sign;
        while (r >= 0 && r < ROWS && c >= 0 && c < COLUMNS && this.grid[r][c] === seat) {
          count += 1;
          r += dr * sign;
          c += dc * sign;
        }
      }
      if (count >= 4) return seat;
    }
    return null;
  }

  /** Simulate a drop without mutating the board. */
  _wouldWin(column, seat) {
    for (let row = ROWS - 1; row >= 0; row--) {
      if (this.grid[row][column] !== null) continue;
      this.grid[row][column] = seat;
      const win = this._winnerAt(row, column, seat) !== null;
      this.grid[row][column] = null;
      return win;
    }
    return false;
  }

  _planAiMove(column) {
    const target = {
      x: this.placement.originX + column,
      y: this.placement.originY
    };
    const ai = this._characterForSeat(1);
    if (!ai || !this.game?.terrain) {
      return { column, target, instant: true };
    }

    ai.inMiniGame = true;
    ai.miniGameTarget = { ...target };

    const from = tileOf(ai);
    if (!from || (from.x === target.x && from.y === target.y)) {
      ai.path = [];
      return { column, target, instant: true };
    }

    const path = findPath(this.game.terrain, from, target);
    if (!path.length) {
      // Unreachable: documented fallback, drop directly without moving.
      ai.path = [];
      return { column, target, instant: true };
    }

    ai.moving = false;
    ai.path = path;
    return { column, target, instant: false };
  }

  _aiDrop(column) {
    const ai = this._characterForSeat(1);
    if (ai) {
      ai.inMiniGame = true;
      ai.miniGameTarget = null;
    }
    return this.handleInput({
      type: 'action',
      action: 'primary',
      character: ai,
      seat: 1,
      controller: 'ai',
      role: 'opponent',
      tile: {
        x: this.placement.originX + column,
        y: this.placement.originY
      }
    });
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
}

export function createConnectFourGame(context = {}) {
  return new ConnectFourGame(context);
}
