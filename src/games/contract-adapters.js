/**
 * Contract adapters for the legacy mini-games plus the contract-native
 * Memory Grid and Connect Four factories.
 *
 * The legacy classes stay the source of truth for rules and rendering. These
 * adapters only translate between the host contract (milliseconds, input
 * objects, StepResult events, render layers) and the legacy API (seconds,
 * characters, booleans, a single canvas pass).
 *
 * Camera convention: the host renderer hands us an already-translated canvas
 * (it has called ctx.translate(-camera.x, -camera.y)) plus a shared `view`.
 * Legacy render methods subtract a camera themselves, so adapters pass
 * `{ x: 0, y: 0 }` and never apply the camera a second time.
 */
import {
  MiniGameBase,
  PHASES,
  createStepResult,
  emptyStepResult
} from '../minigames/contract.js';
import { TicTacToeMiniGame } from './tic-tac-toe.js';
import { CheckersMiniGame } from './checkers.js';
import { ChessMiniGame } from './chess.js';
import { FetchMiniGame } from './fetch.js';
import { createMemoryGridGame } from './memory-grid.js';
import { createConnectFourGame } from './connect-four.js';
import { findPath } from '../world.js';
import miniGamesData from '../../data/minigames.json' with { type: 'json' };

const DEFAULT_META = miniGamesData.miniGames || {};
const NO_CAMERA = Object.freeze({ x: 0, y: 0 });

function resolveMeta(meta, id) {
  return meta || DEFAULT_META[id] || { id };
}

function seatCharacter(seat) {
  return seat?.character ?? seat ?? null;
}

/**
 * Legacy winner labels -> contract winner seat.
 * Tic-Tac-Toe uses X/O, checkers and chess use player/opponent.
 */
export function winnerSeatFor(winner) {
  if (winner === 'X' || winner === 'player' || winner === 0) return 0;
  if (winner === 'O' || winner === 'opponent' || winner === 1) return 1;
  return null;
}

class LegacyBoardAdapter extends MiniGameBase {
  constructor({
    host = null,
    meta = null,
    game = null,
    options = {},
    Legacy = null,
    gameId = '',
    failureMessage = ''
  } = {}) {
    super(resolveMeta(meta, gameId));
    this.host = host;
    this.game = game || options?.game || host?.game || null;
    this.options = options || {};
    this.failureMessage = failureMessage || `Need open ground to lay out ${this.meta.title || 'this game'}.`;
    this.renderLayerName = this.options.renderLayer || this.meta.renderLayers?.[0] || 'ground';
    this.active = false;
    this._events = [];
    this._finished = false;

    this.legacy = new Legacy({
      game: this.game,
      onToast: message => this._emit({ type: 'toast', message }),
      onGameEnd: winner => this._finishFromLegacy(winner),
      onAbandonPrompt: (onConfirm, onCancel) => this._handleAbandonPrompt(onConfirm, onCancel),
      // Stats/rewards belong to the host. The legacy game still calls this
      // injection point, but the adapter never records a result itself.
      recordResult: () => null
    });
  }

  open(context = {}) {
    const seats = Array.isArray(context.seats) ? context.seats : [];
    const placement = context.placement || null;
    const options = context.options || {};
    const base = super.open({ seats, placement, options });

    this.options = { ...this.options, ...options };
    this.seats = seats;
    this._events = [];
    this._finished = false;
    this.finishEvent = null;
    this.active = true;

    if (!this.game?.player) {
      return this._fail('No player is seated at this table.');
    }

    const opponent = seatCharacter(seats[1]) || options.opponent || null;
    let opened = false;
    try {
      opened = Boolean(this.legacy.unfurlBoard(opponent, placement));
    } catch (error) {
      return this._fail(error?.message || this.failureMessage);
    }

    const board = this.legacy.activeBoard;
    if (!opened || !board) {
      return this._fail(this.failureMessage);
    }

    // Reflect the board the legacy game actually laid out. This matters when
    // no placement was supplied and the legacy class searches around the player.
    this.placement = { originX: board.originX, originY: board.originY };

    // Legacy board games always walk game.player to the left sideline. In an
    // NPC-vs-NPC session the human must stay exactly where they are; stage both
    // NPC seats on free margin tiles instead.
    const playerSeat = seatCharacter(seats[0]);
    if (playerSeat && playerSeat !== this.game.player) {
      // Cancel the legacy auto-walk without moving the human.
      if (this.game.player) {
        this.game.player.path = [];
        this.game.player.moving = false;
      }
      const boardWidth = this.meta.board?.width ?? this.legacy.boardSize ?? 3;
      const boardHeight = this.meta.board?.height ?? this.legacy.boardSize ?? 3;
      const occupied = new Set();
      for (const actor of [
        this.game.player,
        ...(this.game.npcs || []),
        ...(this.game.companions || [])
      ]) {
        if (actor) occupied.add(`${actor.x},${actor.y}`);
      }

      const chooseMargin = (side, preferredY) => {
        const x = side === 'left' ? board.originX - 1 : board.originX + boardWidth;
        const offsets = [0, 1, -1, 2, -2, 3, -3, 4, -4];
        for (const offset of offsets) {
          const y = preferredY + offset;
          if (y < 0 || y > 63) continue;
          if (occupied.has(`${x},${y}`)) continue;
          return { x, y };
        }
        return { x, y: preferredY };
      };

      const targets = [
        chooseMargin('left', board.originY + 1),
        chooseMargin('right', board.originY + 1)
      ];
      board.npcSeatTargets = targets;

      const seatsToStage = [
        playerSeat,
        seatCharacter(seats[1]) || board.opponent || null
      ];
      seatsToStage.forEach((character, index) => {
        if (!character || !targets[index]) return;
        const target = targets[index];
        character.inMiniGame = true;
        character.miniGameTarget = { x: target.x, y: target.y };
        const path = findPath(
          this.game.terrain,
          { x: character.x, y: character.y },
          target
        );
        if (path.length) character.path = path;
        else {
          character.x = target.x;
          character.y = target.y;
          character.path = [];
        }
        character.direction = index === 0 ? 1 : 3;
      });
    }

    this.phase = PHASES.PLAYING;
    return { ok: true, phase: this.phase, durationMs: base.durationMs };
  }

  ready() {
    this.phase = this.active ? PHASES.PLAYING : PHASES.IDLE;
    return { ok: this.active, phase: this.phase };
  }

  update(dtMs) {
    if (!this.active) return emptyStepResult();
    const seconds = Number.isFinite(dtMs) ? Math.max(0, dtMs) / 1000 : 0;
    this.legacy.update(seconds);
    this._collectFinish();
    return this._drainEvents();
  }

  handleInput(input = {}) {
    if (!this.active) return emptyStepResult();
    const kind = input.kind || input.type;
    if (kind !== 'action') return emptyStepResult();

    const character = input.character || null;
    if (!character) return emptyStepResult();

    let changed = false;
    try {
      changed = Boolean(this.legacy.handleAction(character));
    } catch (error) {
      this._emit({ type: 'toast', message: error?.message || 'That move did not work.' });
    }
    this._collectFinish();

    const result = this._drainEvents();
    result.handled = true;
    result.changed = changed || result.changed;
    return result;
  }

  blocksStep(character, nx, ny) {
    if (!this.active) return false;
    if (Array.isArray(this.seats)
      && this.seats.some(seat => seat?.character === character)) {
      return false;
    }
    return Boolean(this.legacy.blocksStep?.(character, nx, ny));
  }

  isTileOnBoard(x, y) {
    if (!this.active) return false;
    return Boolean(this.legacy.isTileOnBoard?.(x, y));
  }

  getFootprint() {
    const board = this.legacy?.activeBoard;
    if (!this.active || !board) return null;
    const width = this.meta.board?.width ?? this.legacy.boardSize ?? 0;
    const height = this.meta.board?.height ?? this.legacy.boardSize ?? 0;
    if (!width || !height) return null;
    return { x: board.originX, y: board.originY, width, height };
  }

  getHiddenZones() {
    const zones = this.legacy.getHiddenZones?.();
    if (Array.isArray(zones)) return zones.map(zone => ({ ...zone }));
    return super.getHiddenZones();
  }

  render(ctx, layer, view) {
    if (!this.active || layer !== this.renderLayerName) return false;
    // `ctx` is already translated by the host renderer.
    this.legacy.render?.(ctx, NO_CAMERA, view);
    return true;
  }

  close({ reason = 'closed' } = {}) {
    this.active = false;
    this._releaseLegacyBoard();
    return super.close({ reason });
  }

  serialize() {
    return {
      ...super.serialize(),
      gameId: this.meta.id,
      legacyOrigin: this.placement ? { ...this.placement } : null
    };
  }

  _fail(message) {
    this.active = false;
    this.phase = PHASES.IDLE;
    return { ok: false, phase: this.phase, message };
  }

  _emit(event) {
    if (event) this._events.push(event);
  }

  _drainEvents() {
    const events = this._events;
    this._events = [];
    return createStepResult({
      handled: false,
      changed: events.length > 0,
      events
    });
  }

  _collectFinish() {
    const board = this.legacy?.activeBoard;
    if (!this.active || this._finished || !board || board.status !== 'ended') return;
    this._finishFromLegacy(board.winner);
  }

  _finishFromLegacy(winner) {
    if (!this.active || this._finished) return;
    this._finished = true;
    this.phase = PHASES.ENDING;
    this.finishEvent = { type: 'finish', winnerSeat: winnerSeatFor(winner) };
    this._emit(this.finishEvent);
  }

  _handleAbandonPrompt(onConfirm, onCancel) {
    // The host owns dialogue. If integration supplies a prompt handler, defer
    // to it; otherwise leave the legacy prompt pending (same as a no-op).
    const handler = this.options.onAbandonPrompt;
    if (typeof handler === 'function') {
      handler(onConfirm, onCancel);
    }
  }

  _releaseLegacyBoard() {
    const legacy = this.legacy;
    if (!legacy) return;

    if (typeof legacy.packUpBoard === 'function' && legacy.activeBoard) {
      legacy.packUpBoard();
      // Host close is immediate, so run the refold completion synchronously
      // instead of waiting for another update tick.
      const board = legacy.activeBoard;
      const complete = board?.onRefoldComplete;
      if (typeof complete === 'function') {
        board.onRefoldComplete = null;
        complete();
      }
    }

    if (legacy.activeBoard) {
      if (legacy.activeBoard.opponent) legacy.activeBoard.opponent.inMiniGame = false;
      legacy.activeBoard = null;
    }
    if ('selectedCell' in legacy) legacy.selectedCell = null;
    if ('selectedSquare' in legacy) legacy.selectedSquare = null;
  }
}

class FetchAdapter extends MiniGameBase {
  constructor({ host = null, meta = null, game = null, options = {} } = {}) {
    super(resolveMeta(meta, 'fetch'));
    this.host = host;
    this.game = game || options?.game || host?.game || null;
    this.options = options || {};
    this.renderLayerName = this.options.renderLayer || this.meta.renderLayers?.[0] || 'object';
    this.active = false;
    this._events = [];

    this.legacy = new FetchMiniGame({
      game: this.game,
      onToast: message => this._emit({ type: 'toast', message })
    });
  }

  open(context = {}) {
    const seats = Array.isArray(context.seats) ? context.seats : [];
    const options = { ...(context.options || {}) };
    if (context.targetTile) options.targetTile = context.targetTile;
    if (context.color) options.color = context.color;

    const base = super.open({ seats, placement: null, options });
    this.options = { ...this.options, ...options };
    this.seats = seats;
    this._events = [];
    this.active = true;

    if (!this.game?.player) {
      return this._fail('No player is ready to play fetch.');
    }
    if (!options.targetTile) {
      return this._fail('Choose where to throw the ball first.');
    }

    let thrown = false;
    try {
      thrown = Boolean(this.legacy.throwBall({
        targetTile: options.targetTile,
        color: options.color
      }));
    } catch (error) {
      return this._fail(error?.message || 'Could not throw the ball.');
    }
    if (!thrown) {
      return this._fail('Your companion is not nearby to play fetch.');
    }

    this.phase = PHASES.PLAYING;
    return { ok: true, phase: this.phase, durationMs: base.durationMs };
  }

  ready() {
    this.phase = this.active ? PHASES.PLAYING : PHASES.IDLE;
    return { ok: this.active, phase: this.phase };
  }

  update(dtMs) {
    if (!this.active) return emptyStepResult();
    const seconds = Number.isFinite(dtMs) ? Math.max(0, dtMs) / 1000 : 0;
    this.legacy.update(seconds);
    return this._drainEvents();
  }

  handleInput(input = {}) {
    if (!this.active) return emptyStepResult();
    const kind = input.kind || input.type;
    if (kind !== 'action' && kind !== 'throw') return emptyStepResult();
    if (this.legacy.canThrow && !this.legacy.canThrow()) return emptyStepResult();

    const targetTile = input.targetTile || null;
    if (!targetTile) return emptyStepResult();

    let thrown = false;
    try {
      thrown = Boolean(this.legacy.throwBall({ targetTile, color: input.color }));
    } catch (error) {
      this._emit({ type: 'toast', message: error?.message || 'Could not throw the ball.' });
    }
    const result = this._drainEvents();
    result.handled = thrown;
    result.changed = thrown || result.changed;
    return result;
  }

  blocksStep() {
    return false;
  }

  isTileOnBoard() {
    return false;
  }

  getFootprint() {
    return null;
  }

  getHiddenZones() {
    return [];
  }

  render(ctx, layer, view) {
    if (!this.active || layer !== this.renderLayerName) return false;
    // `ctx` is already translated by the host renderer.
    this.legacy.render?.(ctx, NO_CAMERA, view);
    return true;
  }

  close({ reason = 'closed' } = {}) {
    this.active = false;
    this._releaseBall();
    return super.close({ reason });
  }

  serialize() {
    return {
      ...super.serialize(),
      gameId: this.meta.id,
      ball: this.legacy.activeBall ? this.legacy.activeBall.state : null
    };
  }

  _fail(message) {
    this.active = false;
    this.phase = PHASES.IDLE;
    return { ok: false, phase: this.phase, message };
  }

  _emit(event) {
    if (event) this._events.push(event);
  }

  _drainEvents() {
    const events = this._events;
    this._events = [];
    return createStepResult({
      handled: false,
      changed: events.length > 0,
      events
    });
  }

  _releaseBall() {
    const ball = this.legacy?.activeBall;
    if (ball) {
      const companion = this.game?.companions?.find(entry => entry.id === ball.companionId);
      if (companion) {
        companion.fetchTarget = null;
        companion.carryingBall = false;
      }
    }
    if (this.legacy) this.legacy.activeBall = null;
  }
}

export class TicTacToeAdapter extends LegacyBoardAdapter {
  constructor(context = {}) {
    super({
      ...context,
      Legacy: TicTacToeMiniGame,
      gameId: 'tic-tac-toe',
      failureMessage: 'Need open ground with room to stand around to lay out Tic-Tac-Toe.'
    });
  }
}

export class CheckersAdapter extends LegacyBoardAdapter {
  constructor(context = {}) {
    super({
      ...context,
      Legacy: CheckersMiniGame,
      gameId: 'checkers',
      failureMessage: 'Need clear open ground to lay out the 8x8 Checkerboard.'
    });
  }
}

export class ChessAdapter extends LegacyBoardAdapter {
  constructor(context = {}) {
    super({
      ...context,
      Legacy: ChessMiniGame,
      gameId: 'chess',
      failureMessage: 'Need clear open ground to lay out the 8x8 Chessboard.'
    });
  }
}

export class FetchContractAdapter extends FetchAdapter {
  constructor(context = {}) {
    super(context);
  }
}

export function createTicTacToeAdapter(context = {}) {
  return new TicTacToeAdapter(context);
}

export function createCheckersAdapter(context = {}) {
  return new CheckersAdapter(context);
}

export function createChessAdapter(context = {}) {
  return new ChessAdapter(context);
}

export function createFetchAdapter(context = {}) {
  return new FetchContractAdapter(context);
}

// Short aliases for callers that prefer createTicTacToe({ ... }).
export const createTicTacToe = createTicTacToeAdapter;
export const createCheckers = createCheckersAdapter;
export const createChess = createChessAdapter;
export const createFetch = createFetchAdapter;

/** Host factories keyed by data/minigames.json id. */
export const ADAPTER_FACTORIES = Object.freeze({
  'tic-tac-toe': createTicTacToeAdapter,
  checkers: createCheckersAdapter,
  chess: createChessAdapter,
  'memory-grid': createMemoryGridGame,
  'connect-four': createConnectFourGame,
  fetch: createFetchAdapter
});

/** Create one adapter by data id, or null for an unknown id. */
export function createAdapter(gameId, context = {}) {
  const factory = ADAPTER_FACTORIES[gameId];
  return factory ? factory(context) : null;
}

/**
 * Convenience for runtime integration: register all six games in one call.
 * Metadata is read from data/minigames.json by default and validated by the host.
 */
export function registerContractGames(host, metaById = DEFAULT_META) {
  const results = [];
  for (const [id, create] of Object.entries(ADAPTER_FACTORIES)) {
    const meta = metaById?.[id];
    if (!meta) {
      results.push({ ok: false, reason: 'missing-meta', id });
      continue;
    }
    results.push({ id, ...host.register({ meta, create }) });
  }
  return results;
}
