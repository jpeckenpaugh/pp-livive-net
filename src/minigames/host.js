/**
 * Mini-game host: registry, one active session, input routing, lifecycle,
 * pause/resume, blocking queries, render-layer delegation, and event settling.
 *
 * No DOM access. Runtime integration injects the world and callbacks.
 */
import {
  PHASES,
  emptyStepResult,
  createStepResult,
  validateMeta
} from './contract.js';
import { validateFootprint, releaseSession } from './staging.js';
import {
  settleGame,
  buildEndDialogue,
  dialogueForMeta
} from './settlement.js';

const HOOK_KEYS = [
  'onToast',
  'onReject',
  'onCheer',
  'onGameEnd',
  'onEvent',
  'recordGameResult',
  'rollReward',
  'applyReward',
  'dialogues'
];

export const TRACE_LIMIT = 50;

function freezeMeta(meta) {
  return Object.freeze({
    ...meta,
    board: meta.board
      ? Object.freeze({
        ...meta.board,
        hiddenZones: Object.freeze((meta.board.hiddenZones || []).map(zone => Object.freeze({ ...zone })))
      })
      : null,
    input: meta.input ? Object.freeze({ ...meta.input }) : null,
    renderLayers: Object.freeze([...(meta.renderLayers || [])]),
    timing: meta.timing ? Object.freeze({ ...meta.timing }) : null
  });
}

function pointInFootprint(footprint, x, y) {
  return Boolean(footprint)
    && x >= footprint.x
    && x < footprint.x + footprint.width
    && y >= footprint.y
    && y < footprint.y + footprint.height;
}

function seatFromEntry(entry, index, controllers = null) {
  if (entry && entry.character) {
    return {
      index,
      character: entry.character,
      controller: entry.controller || controllers?.[index] || (index === 0 ? 'human' : 'ai'),
      role: entry.role || (index === 0 ? 'player' : 'opponent')
    };
  }
  if (!entry) return null;
  return {
    index,
    character: entry,
    controller: controllers?.[index] || (index === 0 ? 'human' : 'ai'),
    role: index === 0 ? 'player' : 'opponent'
  };
}

export class MiniGameHost {
  constructor({ game = null, getCompanionsFor = null, hooks = {}, ...callbacks } = {}) {
    this.game = game;
    this.getCompanionsFor = getCompanionsFor;
    this.hooks = { ...(hooks || {}) };
    for (const key of HOOK_KEYS) {
      if (typeof callbacks[key] === 'function' || (key === 'dialogues' && callbacks[key])) {
        this.hooks[key] = callbacks[key];
      }
    }
    this.registry = new Map();
    this.session = null;
    this.trace = [];
    this.traceSeq = 0;
    this.targetHints = [];
  }

  get activeGameId() {
    return this.session?.meta?.id ?? null;
  }

  /**
   * Register a game factory plus metadata.
   * Accepts register({ meta, create }) or register(meta, create).
   */
  register(definition, factory = null) {
    const meta = definition?.meta || definition;
    const create = definition?.create || factory;
    const validation = validateMeta(meta);
    if (!validation.ok) {
      return { ok: false, reason: 'invalid-meta', errors: validation.errors };
    }
    if (this.registry.has(meta.id)) {
      return { ok: false, reason: 'duplicate-id', id: meta.id };
    }
    if (typeof create !== 'function') {
      return { ok: false, reason: 'missing-factory', id: meta.id };
    }
    this.registry.set(meta.id, { meta: freezeMeta(meta), create });
    return { ok: true, id: meta.id };
  }

  unregister(gameId) {
    return this.registry.delete(gameId);
  }

  getMeta(gameId) {
    return this.registry.get(gameId)?.meta || null;
  }

  isOpen() {
    return Boolean(this.session);
  }

  /**
   * Start a registered game. One session active globally; a busy host returns
   * { ok: false, reason: 'busy', activeGameId } without disturbing the board.
   */
  start(gameId, {
    seats = null,
    participants = null,
    player = null,
    opponent = null,
    controllers = null,
    companions = null,
    placement = null,
    options = {},
    terrain = null
  } = {}) {
    if (this.session) {
      const title = this.session.meta?.title || this.session.meta?.id || 'a game';
      this._trace({ action: 'start', accepted: false, reason: 'busy' });
      return {
        ok: false,
        reason: 'busy',
        activeGameId: this.session.meta?.id || null,
        message: `${title} is already open. Pack it up first.`
      };
    }

    const entry = this.registry.get(gameId);
    if (!entry) {
      this._trace({ gameId, action: 'start', accepted: false, reason: 'unknown-game' });
      return { ok: false, reason: 'unknown-game', message: `No mini-game registered as ${gameId}.` };
    }

    const seatInput = Array.isArray(seats)
      ? seats
      : (Array.isArray(participants) ? participants : [player, opponent]);
    const resolvedSeats = seatInput
      .map((entryValue, index) => seatFromEntry(entryValue, index, controllers))
      .filter(Boolean);

    if (!resolvedSeats.length) {
      this._trace({ gameId, action: 'start', accepted: false, reason: 'no-participants' });
      return { ok: false, reason: 'no-participants', message: 'A mini-game needs at least one seated character.' };
    }

    const worldTerrain = terrain || this.game?.terrain || null;
    if (entry.meta.board && placement && worldTerrain) {
      const check = validateFootprint({ terrain: worldTerrain, placement, board: entry.meta.board });
      if (!check.ok) {
        this._trace({ gameId, action: 'start', accepted: false, reason: 'invalid-placement' });
        return {
          ok: false,
          reason: 'invalid-placement',
          detail: check.reason,
          message: `Not enough open ground for ${entry.meta.title}.`
        };
      }
    }

    let game;
    try {
      game = entry.create({
        host: this,
        meta: entry.meta,
        game: options.game || this.game,
        options
      });
    } catch (error) {
      this._trace({ gameId, action: 'start', accepted: false, reason: 'create-failed' });
      return { ok: false, reason: 'create-failed', message: error?.message || 'Could not create game.' };
    }
    if (!game) {
      this._trace({ gameId, action: 'start', accepted: false, reason: 'create-failed' });
      return { ok: false, reason: 'create-failed', message: 'Game factory returned nothing.' };
    }

    let openResult;
    try {
      openResult = game.open?.({ seats: resolvedSeats, placement, options }) ?? { ok: true };
    } catch (error) {
      this._trace({ gameId, action: 'start', accepted: false, reason: 'open-failed' });
      return { ok: false, reason: 'open-failed', message: error?.message || 'Game failed to open.' };
    }
    if (openResult === false || openResult?.ok === false) {
      this._trace({ gameId, action: 'start', accepted: false, reason: 'open-failed' });
      return {
        ok: false,
        reason: 'open-failed',
        message: openResult?.message || `${entry.meta.title} could not open here.`
      };
    }

    if (openResult?.autoReady !== false && typeof game.ready === 'function') {
      let readyResult;
      try {
        readyResult = game.ready();
      } catch (error) {
        this._trace({ gameId, action: 'start', accepted: false, reason: 'open-failed' });
        return { ok: false, reason: 'open-failed', message: error?.message || 'Game failed to get ready.' };
      }
      if (readyResult?.ok === false) {
        this._trace({ gameId, action: 'start', accepted: false, reason: 'open-failed' });
        return {
          ok: false,
          reason: 'open-failed',
          message: readyResult?.message || `${entry.meta.title} could not get ready.`
        };
      }
    }

    const characters = resolvedSeats.map(seat => seat.character);
    const participantCompanions = this._resolveCompanions(characters, companions);
    const session = {
      meta: entry.meta,
      game,
      seats: resolvedSeats,
      participants: characters,
      participantSet: new Set(characters),
      participantIds: new Set(characters.map(character => character.id).filter(Boolean)),
      companions: participantCompanions,
      placement: placement || game.placement || null,
      paused: false,
      settled: false,
      settlement: null,
      startedAt: Date.now()
    };

    this.session = session;
    this._notify({ type: 'open', gameId: entry.meta.id }, session);
    this._trace({ action: 'start', accepted: true });
    return {
      ok: true,
      gameId: entry.meta.id,
      meta: entry.meta,
      game,
      session,
      phase: game.phase || openResult?.phase || PHASES.READY
    };
  }

  /**
   * End the active session immediately. Optionally settles a final outcome.
   */
  close({
    reason = 'closed',
    outcome = null,
    winnerSeat = null,
    settle = true,
    record = true,
    reward = true
  } = {}) {
    const session = this.session;
    if (!session) return { ok: false, reason: 'no-session' };

    let settlement = session.settlement;
    if (settle && !session.settled && (outcome !== null || winnerSeat !== null)) {
      const result = this.settle({ outcome, winnerSeat, record, reward });
      if (result.ok) settlement = result.settlement;
    }

    try {
      session.game.close?.({ reason });
    } catch (error) {
      session.closeError = error;
    }
    releaseSession({ participants: session.participants, companions: session.companions });
    this._trace({ action: 'close', accepted: true, reason });
    this.session = null;
    this.targetHints = [];

    return {
      ok: true,
      gameId: session.meta.id,
      reason,
      settlement,
      closeError: session.closeError || null
    };
  }

  packUp(options = {}) {
    return this.close({ ...options, reason: options.reason || 'packed-up' });
  }

  /**
   * Settle the active session exactly once. Host owns stats/rewards/dialogue.
   */
  settle({ winnerSeat = null, outcome = null, seat = 0, record = true, reward = true } = {}) {
    const session = this.session;
    if (!session) return { ok: false, reason: 'no-session' };
    if (session.settled) {
      return { ok: true, alreadySettled: true, settlement: session.settlement };
    }

    const perspective = session.seats.find(entry => entry.index === seat) || session.seats[0] || null;
    const opponentSeat = session.seats.find(entry => entry !== perspective) || null;
    const settlement = settleGame({
      meta: session.meta,
      winnerSeat,
      outcome,
      seat,
      player: perspective?.character || null,
      opponent: opponentSeat?.character || null,
      game: this.game,
      recordGameResult: this.hooks.recordGameResult,
      rollReward: this.hooks.rollReward,
      applyReward: this.hooks.applyReward,
      record,
      reward
    });

    session.settled = true;
    session.settlement = settlement;
    this._trace({ action: 'settle', accepted: true, reason: settlement.outcome });
    return { ok: true, settlement };
  }

  update(dtMs) {
    const session = this.session;
    if (!session || session.paused) return emptyStepResult();
    const result = createStepResult(session.game.update?.(dtMs) ?? {});
    this._processEvents(result.events, session);
    return result;
  }

  /**
   * Route an action key from a character already standing on/next to the board.
   */
  handleAction(character) {
    const session = this.session;
    if (!session || session.paused || !character) return emptyStepResult();

    const seat = session.seats.find(entry => entry.character === character);
    if (!seat) return emptyStepResult();

    const input = {
      type: 'action',
      action: 'primary',
      character,
      seat: seat.index,
      controller: seat.controller,
      role: seat.role,
      tile: { x: character.x, y: character.y }
    };
    const result = createStepResult(session.game.handleInput?.(input) ?? {});
    const rejection = result.events.find(event => event?.type === 'reject') || null;
    this._processEvents(result.events, session);
    // Rejections are already traced by _notify; record accepts here so a move
    // that silently changes the board still leaves a trace line.
    if (!rejection) {
      this._trace({
        action: 'action',
        accepted: Boolean(result.changed || result.handled)
      });
    }
    return result;
  }

  isParticipant(character) {
    const session = this.session;
    if (!session || !character) return false;
    return session.participantSet.has(character)
      || (Boolean(character.id) && session.participantIds.has(character.id));
  }

  getParticipantCompanions() {
    if (!this.session) return [];
    // Boardless activities (fetch) do not park or stage companions; they keep
    // following their buddy and can participate in the activity normally.
    if (!this.session.meta?.board) return [];
    return [...this.session.companions];
  }

  isTileOnBoard(x, y) {
    return pointInFootprint(this._footprint(), x, y);
  }

  /**
   * Public, read-only view of the active board rectangle in tile coordinates.
   * Returns `null` when the activity has no board.
   *
   * @returns {{ x: number, y: number, width: number, height: number } | null}
   */
  getFootprint() {
    const footprint = this._footprint();
    return footprint ? { ...footprint } : null;
  }

  /**
   * Board tiles that should be treated as solid. Activities with no footprint
   * simply return an empty set.
   */
  getBlockedTiles() {
    const footprint = this._footprint();
    if (!footprint || this.session?.meta?.board?.blocksMovement === false) return new Set();
    const tiles = new Set();
    for (let y = footprint.y; y < footprint.y + footprint.height; y++) {
      for (let x = footprint.x; x < footprint.x + footprint.width; x++) {
        tiles.add(`${x},${y}`);
      }
    }
    return tiles;
  }

  /**
   * Generic bystander rule: participants and their companions are exempt;
   * everyone else may walk off a board they are already on but cannot enter it.
   */
  blocksStep(character, nx, ny) {
    const session = this.session;
    if (!session) return false;
    if (this.isParticipant(character)) return false;
    if (session.companions.includes(character)) return false;
    if (session.meta?.board?.blocksMovement === false) return false;

    const footprint = this._footprint();
    if (!footprint) return false;
    const currentlyOnBoard = pointInFootprint(footprint, character.x, character.y);
    const destinationOnBoard = pointInFootprint(footprint, nx, ny);
    return !currentlyOnBoard && destinationOnBoard;
  }

  getHiddenZones() {
    const session = this.session;
    if (!session) return [];
    const zones = [];
    const footprint = this._footprint();
    if (footprint) {
      zones.push({
        x: footprint.x,
        y: footprint.y,
        width: footprint.width,
        height: footprint.height
      });
    }
    zones.push(
      ...(session.game.getHiddenZones?.() || []),
      ...(session.meta?.board?.hiddenZones || [])
    );
    const seen = new Set();
    return zones.filter(zone => {
      const key = `${zone.x},${zone.y},${zone.width},${zone.height}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).map(zone => ({ ...zone }));
  }

  renderLayer(ctx, layer, view) {
    const session = this.session;
    if (!session) return false;
    if (layer === 'overlay') this._renderTargets(ctx, view);
    if (!session.meta.renderLayers.includes(layer)) return false;
    session.game.render?.(ctx, layer, view);
    return true;
  }

  pause(reason = 'paused') {
    const session = this.session;
    if (!session) return { ok: false, reason: 'no-session' };
    session.paused = true;
    session.game.pause?.(reason);
    return { ok: true, paused: true, reason };
  }

  resume(reason = 'resumed') {
    const session = this.session;
    if (!session) return { ok: false, reason: 'no-session' };
    session.paused = false;
    session.game.resume?.(reason);
    return { ok: true, paused: false, reason };
  }

  getState() {
    const session = this.session;
    if (!session) {
      return { active: false, gameId: null, kind: null, turnSeat: null, instruction: null };
    }
    const status = this._describeStatus();
    return {
      active: true,
      gameId: session.meta.id,
      title: session.meta.title,
      kind: session.meta.kind || null,
      phase: session.game.phase || null,
      paused: session.paused,
      settled: session.settled,
      outcome: session.settlement?.outcome || null,
      turnSeat: Number.isInteger(status?.turnSeat) ? status.turnSeat : null,
      instruction: typeof status?.instruction === 'string' ? status.instruction : null,
      participants: session.participants.map(character => character.id || null),
      companions: session.companions.map(character => character.id || null)
    };
  }

  /**
   * Ask the active game which tile the acting player is aiming at, and whether
   * that tile is a legal target. Games without a target return null.
   *
   * @param {{ x: number, y: number }} tile
   * @returns {{ tile: { x: number, y: number }, valid: boolean|null }|null}
   */
  describeTarget(tile) {
    const session = this.session;
    if (!session || !tile || !Number.isFinite(tile.x) || !Number.isFinite(tile.y)) return null;
    const describe = session.game.describeTarget;
    if (typeof describe !== 'function') return null;
    let target = null;
    try {
      target = describe.call(session.game, { x: tile.x, y: tile.y });
    } catch (error) {
      return null;
    }
    if (!target || !target.tile || !Number.isFinite(target.tile.x) || !Number.isFinite(target.tile.y)) {
      return null;
    }
    return {
      tile: { x: target.tile.x, y: target.tile.y },
      valid: typeof target.valid === 'boolean' ? target.valid : null
    };
  }

  /**
   * Store the tiles the renderer should outline this frame. Main supplies the
   * tile under the player and the tile they face; the host resolves validity.
   */
  setTargetTiles(tiles = []) {
    const session = this.session;
    if (!session || !Array.isArray(tiles) || !tiles.length) {
      this.targetHints = [];
      return [];
    }
    const hints = [];
    tiles.forEach((tile, index) => {
      const described = this.describeTarget(tile);
      if (described) hints.push({ ...described, facing: index > 0 });
    });
    this.targetHints = hints;
    return hints;
  }

  /** Last 50 host events, oldest first. Memory only. */
  getTrace() {
    return this.trace.map(entry => ({ ...entry }));
  }

  clearTrace() {
    this.trace = [];
    this.traceSeq = 0;
  }

  _describeStatus() {
    const session = this.session;
    if (!session || typeof session.game.describeStatus !== 'function') return null;
    try {
      return session.game.describeStatus() || null;
    } catch (error) {
      return null;
    }
  }

  _turnSeat() {
    const status = this._describeStatus();
    return Number.isInteger(status?.turnSeat) ? status.turnSeat : null;
  }

  /** Append one capped trace entry. Never throws into gameplay. */
  _trace({ gameId = null, phase = null, turnSeat = undefined, action = 'event', accepted = null, reason = null } = {}) {
    try {
      const session = this.session;
      const entry = {
        seq: this.traceSeq + 1,
        at: Date.now(),
        gameId: gameId ?? session?.meta?.id ?? null,
        phase: phase ?? session?.game?.phase ?? null,
        turnSeat: turnSeat === undefined ? this._turnSeat() : turnSeat,
        action,
        accepted,
        reason: reason ?? null
      };
      this.traceSeq = entry.seq;
      this.trace.push(entry);
      if (this.trace.length > TRACE_LIMIT) this.trace.splice(0, this.trace.length - TRACE_LIMIT);
    } catch (error) {
      // Diagnostics must never break a game.
    }
  }

  _renderTargets(ctx, view) {
    if (!this.session || !this.targetHints.length) return;
    const size = Number(view?.tileSize) || 32;
    for (const hint of this.targetHints) {
      if (!hint?.tile) continue;
      const x = hint.tile.x * size;
      const y = hint.tile.y * size;
      const known = typeof hint.valid === 'boolean';
      const stroke = hint.valid === true
        ? 'rgba(229, 244, 165, 0.95)'
        : (known ? 'rgba(232, 140, 120, 0.8)' : 'rgba(255, 255, 255, 0.32)');
      ctx.save();
      ctx.lineWidth = 2;
      if (typeof ctx.setLineDash === 'function') ctx.setLineDash(hint.facing ? [4, 3] : []);
      if (hint.valid === true) {
        ctx.fillStyle = 'rgba(229, 244, 165, 0.14)';
        ctx.fillRect(x + 3, y + 3, size - 6, size - 6);
      }
      ctx.strokeStyle = stroke;
      ctx.strokeRect(x + 3, y + 3, size - 6, size - 6);
      ctx.restore();
    }
  }

  _footprint() {
    const session = this.session;
    if (!session) return null;
    const fromGame = session.game.getFootprint?.();
    if (fromGame) return fromGame;
    const board = session.meta.board;
    if (!board || !session.placement) return null;
    const x = session.placement.originX ?? session.placement.x;
    const y = session.placement.originY ?? session.placement.y;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y, width: board.width, height: board.height };
  }

  _resolveCompanions(characters, explicit) {
    const ids = new Set(characters.map(character => character?.id).filter(Boolean));
    const listed = Array.isArray(explicit) ? explicit : [];
    if (listed.length) {
      return [...new Set(listed.filter(companion => (
        companion && (!companion.buddyId || ids.has(companion.buddyId))
      )))];
    }

    const resolver = this.getCompanionsFor || this.game?.getCompanionsFor;
    const resolverThis = this.getCompanionsFor ? this : (this.game || this);
    const resolved = [];
    for (const character of characters) {
      if (!character?.id) continue;
      const found = typeof resolver === 'function' ? (resolver.call(resolverThis, character.id) || []) : [];
      for (const companion of found) {
        if (companion && !resolved.includes(companion)) resolved.push(companion);
      }
    }
    return resolved;
  }

  _processEvents(events, session) {
    if (!Array.isArray(events)) return;
    for (const event of events) {
      if (!event || typeof event !== 'object') continue;
      this._notify(event, session);

      if (event.type === 'toast' && event.message) {
        this.hooks.onToast?.(event.message);
      } else if (event.type === 'reject') {
        this.hooks.onReject?.(event);
      } else if (event.type === 'cheer') {
        this.hooks.onCheer?.(event.characterId, event.duration ?? 1.5);
      } else if (event.type === 'finish') {
        this._finishFromEvent(event, session);
      } else if (event.type === 'abandon' && !session.settled && event.settle !== false) {
        this.settle({ outcome: 'abandoned', record: false, reward: false });
      }
    }
  }

  _finishFromEvent(event, session) {
    const seat = Number.isInteger(event.seat) ? event.seat : 0;
    const result = this.settle({
      winnerSeat: event.winnerSeat ?? null,
      outcome: event.outcome ?? null,
      seat,
      record: event.record !== false,
      reward: event.reward !== false
    });
    if (!result.ok || result.alreadySettled) return;

    session.game.phase = PHASES.ENDING;
    const settlement = result.settlement;
    const dialogue = buildEndDialogue({
      meta: session.meta,
      outcome: settlement.outcome,
      opponentName: settlement.opponentName || 'Friend',
      dialogueSpec: dialogueForMeta(session.meta, this.hooks.dialogues)
    });

    this.hooks.onGameEnd?.({
      gameId: session.meta.id,
      meta: session.meta,
      winnerSeat: settlement.winnerSeat,
      outcome: settlement.outcome,
      settlement,
      dialogue,
      event,
      session
    });
  }

  _notify(event, session) {
    if (event.type === 'reject') {
      this._trace({ action: 'action', accepted: false, reason: event.reason || 'illegal' });
    } else {
      this._trace({
        action: event.type,
        accepted: event.type === 'finish' ? true : null,
        reason: event.reason || null
      });
    }
    this.hooks.onEvent?.(event, session);
    const named = this.hooks.events?.[event.type];
    if (typeof named === 'function') named(event, session);
  }
}
