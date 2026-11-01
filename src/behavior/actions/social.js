/**
 * Social behavior actions + the NPC-vs-NPC mini-game adapter.
 *
 * These verbs are designed to be registered with C1's runtime as `extraActions`:
 *
 *   const bubbles = new SpeechBubbles({ getActor });
 *   const social = createSocialActions({ bubbles, host });
 *   const runtime = new BehaviorRuntime({ ..., actions: social });
 *
 * The adapter talks to A1's `MiniGameHost` directly. It always opens a
 * Tic-Tac-Toe session with two AI seats, passes NPC suppression options, and
 * additionally fences off player settlement hooks for the session's lifetime so
 * a migrated game cannot accidentally record stats, roll loot, or open an end
 * dialogue. When the NPC board finishes, the adapter reports the board winner
 * and loser through `onResult` so an NPC economy can reward the winner without
 * touching player settlement. `awaitNpcGame` polls host state; it never uses
 * timers.
 *
 * Every helper is dependency-injected and DOM-free, so tests can use a fake
 * host and fake bubbles.
 */

import { findPath } from '../../world.js';
import { findFootprintPlacement } from '../../minigames/staging.js';

export const NPC_GAME_IDS = Object.freeze(['tic-tac-toe']);

/**
 * Options handed to `host.start` and to `game.open`. A2 games and A1 settlement
 * should treat these as "no player-facing effects". They are also enforced by
 * the adapter's hook guard.
 */
export const NPC_GAME_OPTIONS = Object.freeze({
  npc: true,
  suppressPlayer: true,
  record: false,
  reward: false,
  settle: false,
  dialogue: false,
  cheer: false,
  showEndDialogue: false
});

/** Hooks that can leak player stats, rewards, toasts, or end dialogue. */
export const PLAYER_FACING_HOOKS = Object.freeze([
  'recordGameResult',
  'rollReward',
  'applyReward',
  'onGameEnd',
  'onToast',
  'onCheer'
]);

export const SOCIAL_ACTION_NAMES = Object.freeze([
  'speak',
  'bubble',
  'startNpcGame',
  'awaitNpcGame',
  'resolveNpcFriendship'
]);

const EMOTE_GLYPHS = Object.freeze({
  wave: '👋',
  dance: '♪',
  cheer: 'yay!',
  laugh: 'ha!',
  nod: 'ok!',
  shrug: 'hmm',
  think: '…',
  yawn: 'zzz'
});

const DEFAULT_BUBBLE_MS = 2400;
const DEFAULT_GAME_TIMEOUT_MS = 60000;
const MAX_ADAPTER_SESSIONS = 16;
const ACTIVE_PHASES = new Set(['opening', 'ready', 'playing', 'ending']);
const NPC_TTT_SYMBOLS = Object.freeze(['X', 'O']);

function atTile(character, tile) {
  return Boolean(character && tile) && character.x === tile.x && character.y === tile.y;
}

function stageNpcSeat(character, target, terrain) {
  if (!character || !target) return;
  character.inMiniGame = true;
  character.miniGameTarget = { x: target.x, y: target.y };
  if (atTile(character, target)) {
    character.path = [];
    character.moving = false;
    return;
  }
  const path = terrain
    ? findPath(terrain, { x: character.x, y: character.y }, target)
    : [];
  if (path.length) {
    character.path = path;
    character.moving = false;
  } else {
    // Explicit fallback only when no path exists (matches existing game code).
    character.x = target.x;
    character.y = target.y;
    character.path = [];
    character.moving = false;
  }
}

function tttSideline(board, seatIndex) {
  if (!board) return null;
  const staged = Array.isArray(board.npcSeatTargets) ? board.npcSeatTargets[seatIndex] : null;
  if (staged) return { x: staged.x, y: staged.y };
  if (seatIndex === 0) {
    return { x: board.originX - 1, y: board.originY + 1 };
  }
  return {
    x: board.sidelineX ?? (board.originX + 3),
    y: board.sidelineY ?? (board.originY + 1)
  };
}

function chooseTttIndex(grid) {
  const empty = [];
  for (let i = 0; i < grid.length; i++) {
    if (grid[i] === null) empty.push(i);
  }
  if (!empty.length) return -1;
  if (empty.includes(4) && Math.random() > 0.35) return 4;
  return empty[Math.floor(Math.random() * empty.length)];
}

/**
 * Record the driver's final board state on the adapter record. Outcomes stay
 * relative to seat 0 (X) so `win`/`loss` match `driveNpcTtt`'s `npc.outcome`.
 */
function markDriverResult(record, characters, winner) {
  const winnerSeat = winner === 'X' ? 0 : (winner === 'O' ? 1 : null);
  record.outcome = winner === 'draw' ? 'draw' : (winnerSeat === 0 ? 'win' : 'loss');
  record.winnerId = winnerSeat === null ? null : (characters[winnerSeat]?.id ?? null);
  record.loserId = winnerSeat === null ? null : (characters[winnerSeat === 0 ? 1 : 0]?.id ?? null);
}

/**
 * Drive a two-NPC Tic-Tac-Toe session using the legacy board for rendering and
 * winner detection. Both seats walk to their sideline, take turns stepping onto
 * an empty cell, walk back, and finish the host session without player rewards.
 */
function driveNpcTtt(record) {
  const session = record?.session;
  const legacy = session?.game?.legacy;
  const board = legacy?.activeBoard;
  if (!legacy || !board || !Array.isArray(board.grid)) return null;

  const seats = Array.isArray(session.seats) ? session.seats : [];
  const characters = seats.map(seat => seat?.character).filter(Boolean);
  if (characters.length < 2) return record.npcTtt || null;

  const terrain = legacy.game?.terrain || null;
  const npc = record.npcTtt || (record.npcTtt = {
    phase: 'staging',
    turn: 0,
    target: null,
    outcome: null,
    done: false
  });
  if (npc.done) return npc;

  const [seatA, seatB] = characters;
  const sidelineA = tttSideline(board, 0);
  const sidelineB = tttSideline(board, 1);

  const atSideline = (character, sideline) => (
    atTile(character, sideline) && !character.moving && !(character.path && character.path.length)
  );

  if (npc.phase === 'staging') {
    stageNpcSeat(seatA, sidelineA, terrain);
    stageNpcSeat(seatB, sidelineB, terrain);
    npc.phase = 'waiting';
    return npc;
  }

  if (npc.phase === 'waiting') {
    if (atSideline(seatA, sidelineA) && atSideline(seatB, sidelineB)) {
      npc.phase = 'turn';
    }
    return npc;
  }

  if (npc.phase === 'walking') {
    const mover = characters[npc.turn];
    if (!atTile(mover, npc.target) || mover.moving) return npc;

    board.grid[npc.target.index] = NPC_TTT_SYMBOLS[npc.turn];
    stageNpcSeat(mover, npc.turn === 0 ? sidelineA : sidelineB, terrain);

    const winner = legacy.checkWinner?.() || null;
    if (winner) {
      board.winner = winner;
      board.status = 'ended';
      npc.outcome = winner === 'draw'
        ? 'draw'
        : (winner === 'X' ? 'win' : 'loss');
      npc.done = true;
      npc.phase = 'done';
      markDriverResult(record, characters, winner);
      return npc;
    }

    npc.turn = npc.turn === 0 ? 1 : 0;
    npc.phase = 'returning';
    return npc;
  }

  if (npc.phase === 'returning') {
    if (atSideline(seatA, sidelineA) && atSideline(seatB, sidelineB)) {
      npc.phase = 'turn';
    }
    return npc;
  }

  if (npc.phase === 'turn') {
    if (!atSideline(seatA, sidelineA) || !atSideline(seatB, sidelineB)) {
      npc.phase = 'returning';
      return npc;
    }
    const index = chooseTttIndex(board.grid);
    if (index < 0) {
      board.status = 'ended';
      npc.outcome = 'draw';
      npc.done = true;
      npc.phase = 'done';
      markDriverResult(record, characters, 'draw');
      return npc;
    }
    const mover = characters[npc.turn];
    const target = {
      x: board.originX + (index % 3),
      y: board.originY + Math.floor(index / 3),
      index
    };
    npc.target = target;
    stageNpcSeat(mover, target, terrain);
    npc.phase = 'walking';
    return npc;
  }

  return npc;
}

/**
 * Create the NPC game adapter.
 *
 * @param {object} [options]
 * @param {object|null} [options.host] A1 MiniGameHost (or a compatible fake).
 * @param {string[]} [options.allowedGames] Must stay within `NPC_GAME_IDS`.
 * @param {(request:object)=>object} [options.onSessionClosed] debug hook
 * @param {(result:object)=>void} [options.onResult] NPC winner/loser callback
 */
export function createNpcGameAdapter({
  host = null,
  allowedGames = NPC_GAME_IDS,
  onSessionClosed = null,
  onResult = null
} = {}) {
  const permitted = NPC_GAME_IDS.filter(id => !Array.isArray(allowedGames) || allowedGames.includes(id));
  const sessions = new Map();
  let sequence = 0;

  function start({
    game = 'tic-tac-toe',
    actor = null,
    partner = null,
    placement = null,
    options = {},
    terrain = null
  } = {}) {
    if (!host || typeof host.start !== 'function') {
      return { ok: false, reason: 'no-host' };
    }
    if (!NPC_GAME_IDS.includes(game) || !permitted.includes(game)) {
      return { ok: false, reason: 'not-allowed', game };
    }
    if (!isNpc(actor) || !isNpc(partner)) {
      return { ok: false, reason: 'not-npc' };
    }
    if (actor.id == null || partner.id == null) {
      return { ok: false, reason: 'no-participants' };
    }
    if (String(actor.id) === String(partner.id)) {
      return { ok: false, reason: 'same-participant' };
    }
    if (typeof host.isOpen === 'function' && host.isOpen()) {
      return {
        ok: false,
        reason: 'busy',
        activeGameId: host.getState?.()?.gameId ?? host.activeGameId ?? null
      };
    }

    const seats = [
      { character: actor, controller: 'ai', role: 'player' },
      { character: partner, controller: 'ai', role: 'opponent' }
    ];
    const meta = typeof host.getMeta === 'function' ? host.getMeta(game) : null;
    let resolvedPlacement = placement || null;
    if (!resolvedPlacement && meta?.board && terrain) {
      resolvedPlacement = findFootprintPlacement({
        terrain,
        board: meta.board,
        around: {
          x: Math.round((actor.x + partner.x) / 2),
          y: Math.round((actor.y + partner.y) / 2)
        }
      });
      if (!resolvedPlacement) {
        return { ok: false, reason: 'no-space', message: 'No open ground near the pair.' };
      }
    }
    const startOptions = {
      ...NPC_GAME_OPTIONS,
      ...(options && typeof options === 'object' ? options : {}),
      npc: true,
      suppressPlayer: true,
      record: false,
      reward: false,
      settle: false,
      dialogue: false
    };

    let result;
    try {
      result = host.start(game, {
        seats,
        controllers: ['ai', 'ai'],
        placement: resolvedPlacement,
        options: startOptions,
        terrain
      });
    } catch (error) {
      return { ok: false, reason: 'start-failed', message: error?.message || String(error) };
    }
    if (!result || result.ok !== true) {
      return {
        ok: false,
        reason: result?.reason || 'start-failed',
        activeGameId: result?.activeGameId ?? null,
        message: result?.message ?? null
      };
    }

    const token = uniqueToken(sessions, result.sessionId || result.session?.id || `${game}-${++sequence}`);
    const record = {
      token,
      sessionId: token,
      game,
      actorId: actor.id,
      partnerId: partner.id,
      session: result.session || host.session || null,
      startedAtSeq: ++sequence,
      closed: false,
      npcTtt: null,
      outcome: null,
      winnerId: null,
      loserId: null,
      resultEmitted: false,
      restoreHooks: suppressPlayerHooks(host)
    };
    sessions.set(token, record);
    trimSessions(sessions);
    driveNpcTtt(record);

    return {
      ok: true,
      token,
      sessionId: token,
      gameId: result.gameId || game,
      session: result.session || null,
      meta: result.meta || null,
      phase: result.phase || null
    };
  }

  /** Poll one session without mutating anything except releasing expiry hooks. */
  function status(token) {
    const record = sessions.get(String(token));
    if (!record) return { known: false, active: false, reason: 'unknown-session' };

    const npc = driveNpcTtt(record);
    if (npc?.done) emitResult(record);
    if (npc?.done && !record.closed) {
      record.outcome = npc.outcome || record.outcome || 'complete';
      finish(record.token, {
        reason: 'npc-game-complete',
        outcome: record.outcome
      });
    }

    const state = readState(host);
    const currentSession = host?.session || null;
    const foreignSession = Boolean(
      (currentSession && record.session && currentSession !== record.session) ||
      (state?.gameId && record.game && state.gameId !== record.game)
    );
    const open = typeof host?.isOpen === 'function'
      ? host.isOpen()
      : Boolean(state?.active);
    const ended = state?.settled === true ||
      state?.phase === 'ending' ||
      state?.phase === 'closing' ||
      state?.phase === 'closed' ||
      record.session?.settled === true;
    const active = foreignSession ? false : ((state ? state.active === true : open) && !ended);

    if (!active) release(record);

    return {
      known: true,
      token: record.token,
      sessionId: record.sessionId,
      game: record.game,
      active,
      foreign: foreignSession,
      phase: state?.phase ?? null,
      outcome: record.outcome ?? state?.outcome ?? record.session?.settlement?.outcome ?? null,
      winnerId: record.winnerId ?? null,
      loserId: record.loserId ?? null,
      settled: state?.settled ?? null,
      closed: record.closed
    };
  }

  /**
   * Pack the NPC board up without settling anything. Safe to call more than
   * once and safe when the host already closed the session itself.
   */
  function finish(token, { reason = 'npc-game-complete', outcome = null } = {}) {
    const record = sessions.get(String(token));
    if (!record) return { ok: false, reason: 'unknown-session' };
    emitResult(record);
    release(record);

    const state = readState(host);
    const currentSession = host?.session || null;
    let ownsSession = true;
    if (currentSession && record.session) {
      ownsSession = currentSession === record.session;
    } else if (state?.gameId && record.game) {
      ownsSession = state.gameId === record.game;
    }
    if (!ownsSession) {
      closeRecord(record, { ok: false, reason: 'foreign-session' });
      return { ok: false, reason: 'foreign-session' };
    }

    if (typeof host?.close === 'function' && (host.session || host.isOpen?.())) {
      let result;
      try {
        result = host.close({
          reason,
          outcome,
          settle: false,
          record: false,
          reward: false
        });
      } catch (error) {
        result = { ok: false, reason: 'close-failed', message: error?.message || String(error) };
      }
      closeRecord(record, result);
      notifyClosed(record, result);
      return result;
    }

    closeRecord(record, { ok: true, reason: 'already-closed' });
    notifyClosed(record, { ok: true, reason: 'already-closed' });
    return { ok: true, reason: 'already-closed' };
  }

  /** Abort is a finish with a diagnostic reason; it still never settles. */
  function abort(token, reason = 'npc-game-aborted') {
    return finish(token, { reason });
  }

  function activeToken() {
    for (const token of sessions.keys()) {
      if (status(token).active) return token;
    }
    return null;
  }

  function listSessions() {
    return [...sessions.values()].map(record => ({
      token: record.token,
      sessionId: record.sessionId,
      game: record.game,
      actorId: record.actorId,
      partnerId: record.partnerId,
      closed: record.closed
    }));
  }

  function releaseAll() {
    for (const record of sessions.values()) release(record);
  }

  function release(record) {
    if (!record || typeof record.restoreHooks !== 'function') return;
    const restore = record.restoreHooks;
    record.restoreHooks = null;
    try {
      restore();
    } catch {
      // Restoration is best effort; a frozen fake host may reject assignment.
    }
  }

  function closeRecord(record, result) {
    record.closed = true;
    record.result = result || null;
    release(record);
  }

  function emitResult(record) {
    if (!record || record.resultEmitted || record.outcome == null) return;
    record.resultEmitted = true;
    if (typeof onResult !== 'function') return;
    const payload = {
      token: record.token,
      sessionId: record.sessionId,
      game: record.game,
      winnerId: record.winnerId ?? null,
      loserId: record.loserId ?? null,
      outcome: record.outcome,
      session: record.session
    };
    try {
      onResult(payload);
    } catch {
      // Result hooks never break gameplay.
    }
  }

  function notifyClosed(record, result) {
    if (typeof onSessionClosed !== 'function') return;
    try {
      onSessionClosed({
        token: record.token,
        game: record.game,
        actorId: record.actorId,
        partnerId: record.partnerId,
        result
      });
    } catch {
      // Debug hooks never break gameplay.
    }
  }

  return Object.freeze({
    start,
    status,
    finish,
    abort,
    activeToken,
    listSessions,
    releaseAll,
    permittedGames: Object.freeze([...permitted])
  });
}

/**
 * Build the social action verbs.
 *
 * @param {object} [deps]
 * @param {object|null} [deps.bubbles] SpeechBubbles-like object
 * @param {object|null} [deps.host] A1 MiniGameHost (or fake)
 * @param {object|null} [deps.adapter] pre-built adapter
 * @param {string[]} [deps.allowedGames]
 * @param {(result:object)=>void} [deps.onResult] NPC winner/loser callback
 * @param {(request:object)=>string} [deps.lineFor] copy resolver
 * @param {(emote:string, detail:object)=>string} [deps.emoteFor]
 */
export function createSocialActions({
  bubbles = null,
  host = null,
  adapter = null,
  allowedGames = NPC_GAME_IDS,
  onResult = null,
  lineFor = null,
  emoteFor = null
} = {}) {
  const npcGames = adapter || createNpcGameAdapter({ host, allowedGames, onResult });

  function speak(ctx) {
    const { actor, params = {}, stateMemory = {} } = ctx;
    if (!stateMemory.spoken) {
      stateMemory.spoken = true;
      const key = params.key || 'chat';
      const text = resolveLine(ctx, params, lineFor);
      if (text) {
        present(bubbles, ctx, text, bubbleDuration(params, ctx), key);
        emit(ctx, 'say', {
          actorId: actor?.id ?? null,
          key,
          text,
          bubble: false
        });
      }
    }
    return finishAfterDuration(ctx);
  }

  function bubble(ctx) {
    const { actor, params = {}, stateMemory = {} } = ctx;
    if (!stateMemory.bubbled) {
      stateMemory.bubbled = true;
      const key = params.key || params.emote || 'chat';
      const text = params.emote
        ? resolveEmote(params.emote, params, emoteFor)
        : resolveLine(ctx, params, lineFor);
      if (text) {
        present(bubbles, ctx, text, bubbleDuration(params, ctx), key);
        emit(ctx, 'say', {
          actorId: actor?.id ?? null,
          key,
          text,
          bubble: false,
          visualOnly: true
        });
      }
    }
    return finishAfterDuration(ctx);
  }

  function startNpcGame(ctx) {
    const { actor, target, params = {}, memory = {} } = ctx;
    if (memory.npcGameStarted) return { done: true, reason: 'already-started' };

    const game = params.game || 'tic-tac-toe';
    const allowed = Array.isArray(params.allowedGames)
      ? params.allowedGames
      : (Array.isArray(ctx.allowedGames) ? ctx.allowedGames : allowedGames);

    if (!NPC_GAME_IDS.includes(game) || !allowed.includes(game)) {
      memory.npcGameStarted = true;
      emit(ctx, 'game.blocked', {
        actorId: actor?.id ?? null,
        partnerId: target?.id ?? null,
        game,
        reason: 'not-allowed'
      });
      return { done: true, ok: false, reason: 'game-not-allowed' };
    }
    if (!isNpc(actor) || !isNpc(target)) {
      memory.npcGameStarted = true;
      emit(ctx, 'game.blocked', {
        actorId: actor?.id ?? null,
        partnerId: target?.id ?? null,
        game,
        reason: 'not-npc'
      });
      return { done: true, ok: false, reason: 'not-npc' };
    }

    const result = npcGames.start({
      game,
      actor,
      partner: target,
      placement: params.placement || null,
      options: params.options || {},
      terrain: params.terrain || null
    });
    memory.npcGameStarted = true;
    memory.npcGameToken = result.ok ? result.token : null;
    memory.npcGameId = game;

    emit(ctx, 'game.start', {
      actorId: actor?.id ?? null,
      partnerId: target?.id ?? null,
      game,
      ok: result.ok === true,
      reason: result.reason ?? null,
      token: result.token ?? null,
      npc: true
    });

    return {
      done: true,
      ok: result.ok === true,
      token: result.token ?? null,
      sessionId: result.sessionId ?? null,
      reason: result.ok ? 'started' : 'game-unavailable',
      detail: result
    };
  }

  function awaitNpcGame(ctx) {
    const { params = {}, memory = {}, stateMemory = {} } = ctx;
    const token = memory.npcGameToken || params.token || null;
    if (!token) return { done: true, reason: 'no-game' };
    if (stateMemory.gameEnded) {
      return { done: true, reason: stateMemory.gameOutcome || 'ended' };
    }

    const status = npcGames.status(token) || {};
    if (status.known === false) {
      stateMemory.gameEnded = true;
      return { done: true, reason: 'no-session' };
    }

    const active = status.active === true ||
      (status.active === undefined && ACTIVE_PHASES.has(status.phase));

    if (active) {
      const timeoutMs = Number.isFinite(Number(params.timeoutMs))
        ? Number(params.timeoutMs)
        : DEFAULT_GAME_TIMEOUT_MS;
      const elapsedMs = Number(ctx.elapsedMs) || 0;
      if (elapsedMs >= timeoutMs && !stateMemory.gameTimedOut) {
        stateMemory.gameTimedOut = true;
        stateMemory.gameEnded = true;
        npcGames.abort(token, 'npc-game-timeout');
        emit(ctx, 'game.timeout', {
          actorId: ctx.actor?.id ?? null,
          partnerId: ctx.target?.id ?? null,
          game: memory.npcGameId || params.game || null,
          token
        });
        return { done: true, reason: 'timeout' };
      }
      return { done: false };
    }

    stateMemory.gameEnded = true;
    stateMemory.gameOutcome = status.outcome || 'complete';
    npcGames.finish(token, {
      reason: 'npc-game-complete',
      outcome: status.outcome || null
    });
    emit(ctx, 'game.end', {
      actorId: ctx.actor?.id ?? null,
      partnerId: ctx.target?.id ?? null,
      game: memory.npcGameId || params.game || null,
      outcome: stateMemory.gameOutcome,
      winnerId: status.winnerId ?? null,
      loserId: status.loserId ?? null,
      token,
      npc: true
    });
    return { done: true, reason: stateMemory.gameOutcome };
  }

  function resolveNpcFriendship(ctx) {
    const { actor, target, params = {}, stateMemory = {} } = ctx;
    if (stateMemory.resolved) return { done: true, reason: 'already-resolved' };
    if (!target) return { done: true, reason: 'no-target' };
    if (!isNpc(actor) || !isNpc(target)) {
      stateMemory.resolved = true;
      return { done: true, reason: 'not-npc' };
    }

    const interaction = params.interaction || 'greet';
    const result = typeof ctx.resolveFriendship === 'function'
      ? ctx.resolveFriendship({ actor, target, interaction })
      : { ok: false, friends: false, reason: 'unavailable' };

    stateMemory.resolved = true;
    stateMemory.result = result;
    emit(ctx, 'friendship.resolve', {
      actorId: actor?.id ?? null,
      targetId: target.id ?? null,
      interaction,
      friends: result?.friends === true,
      reason: result?.reason ?? null
    });
    return { done: true, reason: result?.friends ? 'friends' : (result?.reason || 'pending') };
  }

  return {
    speak,
    bubble,
    startNpcGame,
    awaitNpcGame,
    resolveNpcFriendship
  };
}

/** Default no-dependency verbs. Register with `createSocialActions` for bubbles/host. */
export const socialActions = Object.freeze(createSocialActions());

/**
 * Bridge C1 runtime events to speech bubbles and small game notifications.
 *
 * Attaches to `runtime.onEvent` (composing any existing handler) or to a
 * `subscribe`/function listener. The returned `handle` can also be called by
 * integration directly. Events already rendered by `speak` set
 * `detail.bubble === false` and are skipped here.
 *
 * @param {object|Function|null} runtime BehaviorRuntime or event subscriber
 * @param {object|null} bubbles SpeechBubbles-like object
 * @param {object} [options]
 * @param {object|null} [options.host] optional, used for game titles
 * @param {(message:string)=>void} [options.onToast]
 * @param {boolean} [options.notifyGames=true]
 * @param {(emote:string, detail:object)=>string} [options.emoteFor]
 * @param {(payload:object)=>void} [options.onSay] after a `say` bubble is shown;
 *   receives `{ actorId, key, text, bubble, detail }`. Speaks are skipped.
 */
export function bridgeBehaviorEvents(runtime, bubbles, {
  host = null,
  onToast = null,
  notifyGames = true,
  onGameStart = null,
  onGameEnd = null,
  emoteFor = null,
  onSay = null
} = {}) {
  let lastGame = null;

  const handle = entry => {
    if (!entry || typeof entry !== 'object') return null;
    const type = entry.type;
    const detail = entry.detail && typeof entry.detail === 'object' ? entry.detail : entry;

    if (type === 'say') {
      if (detail.bubble === false) return null;
      const actorId = detail.actorId;
      const text = detail.text;
      if (actorId == null || text == null) return null;
      const key = detail.key ?? null;
      const bubble = showBubble(bubbles, {
        actorId,
        text,
        key,
        durationMs: detail.bubbleMs ?? detail.durationMs ?? DEFAULT_BUBBLE_MS,
        x: detail.x,
        y: detail.y
      });
      if (bubble && typeof onSay === 'function') {
        try {
          onSay({ actorId, key, text, bubble, detail });
        } catch {
          // Voice wiring never breaks the bubble or the runtime.
        }
      }
      return bubble;
    }

    if (type === 'emote') {
      if (detail.bubble === false) return null;
      const actorId = detail.actorId;
      if (actorId == null) return null;
      const text = resolveEmote(detail.emote, detail, emoteFor);
      return showBubble(bubbles, {
        actorId,
        text,
        key: detail.emote ?? 'emote',
        durationMs: detail.bubbleMs ?? 1400,
        x: detail.x,
        y: detail.y
      });
    }

    if (type === 'game.start') {
      if (detail.game) lastGame = detail.game;
      if (detail.ok !== false && typeof onGameStart === 'function') {
        onGameStart(detail, host?.session || null);
      }
      if (!notifyGames || typeof onToast !== 'function') return null;
      const label = gameLabel(host, detail.game || lastGame);
      onToast(detail.ok === false ? `${label} unavailable` : `${label} started`);
      return null;
    }

    if (type === 'game.end' || type === 'game.timeout') {
      if (detail.game) lastGame = detail.game;
      if (typeof onGameEnd === 'function') {
        onGameEnd(detail, host?.session || null);
      }
      if (!notifyGames || typeof onToast !== 'function') return null;
      const label = gameLabel(host, detail.game || lastGame);
      if (type === 'game.timeout') {
        onToast(`${label} timed out`);
      } else {
        const outcome = detail.outcome ? ` · ${detail.outcome}` : '';
        onToast(`${label} finished${outcome}`);
      }
      return null;
    }

    return null;
  };

  const detach = attachListener(runtime, handle);
  return { handle, detach };
}

/**
 * Per-actor and global rate limit for ambient chat voices. Pure and DOM-free:
 * callers inject a monotonic `nowMs`, and a `true` result consumes the slot.
 *
 * @param {object} [options]
 * @param {number} [options.cooldownMs=8000] one line per actor per window
 * @param {number} [options.globalCooldownMs=5000] one line for the whole park
 */
export function createChatGate({ cooldownMs = 8000, globalCooldownMs = 5000 } = {}) {
  const actorCooldown = Math.max(0, Number(cooldownMs) || 0);
  const globalCooldown = Math.max(0, Number(globalCooldownMs) || 0);
  const lastByActor = new Map();
  let lastGlobalAt = Number.NEGATIVE_INFINITY;

  return {
    /** True when this actor may speak now; a true result consumes the slot. */
    allow(actorId, nowMs) {
      if (actorId == null) return false;
      const now = Number(nowMs);
      if (!Number.isFinite(now)) return false;
      if (now - lastGlobalAt < globalCooldown) return false;
      const id = String(actorId);
      const last = lastByActor.get(id);
      if (last != null && now - last < actorCooldown) return false;
      lastByActor.set(id, now);
      lastGlobalAt = now;
      return true;
    },
    reset() {
      lastByActor.clear();
      lastGlobalAt = Number.NEGATIVE_INFINITY;
    },
    get actors() {
      return lastByActor.size;
    }
  };
}

/**
 * The opponent seat for a settled game: the first seat whose character is not
 * the player. Returns null when no player is seated, so an NPC-vs-NPC board
 * stays silent. `player` may be a character record or an id.
 */
export function pickNonPlayerSeat(seats, player = null) {
  const list = Array.isArray(seats) ? seats : [];
  const playerId = player && typeof player === 'object' ? player.id : player;
  const seated = list.filter(entry => entry?.character);
  const isPlayerSeat = entry => {
    const character = entry.character;
    if (character.isPlayer === true) return true;
    return playerId != null && character.id === playerId;
  };
  if (!seated.some(isPlayerSeat)) return null;
  return seated.find(entry => !isPlayerSeat(entry))?.character || null;
}

function present(bubbles, ctx, text, durationMs, key) {
  // Bubbles are injected per integration; a ctx-provided instance wins for tests.
  const sink = ctx.bubbles || ctx.speechBubbles || bubbles || null;
  if (sink && typeof sink.show === 'function') {
    return sink.show({
      actorId: ctx.actor?.id ?? null,
      text,
      durationMs,
      key,
      x: ctx.actor?.x,
      y: ctx.actor?.y
    });
  }
  return null;
}

function showBubble(bubbles, input) {
  if (!bubbles || typeof bubbles.show !== 'function') return null;
  return bubbles.show(input);
}

function resolveLine(ctx, params, lineFor) {
  const key = params.key || 'chat';
  if (typeof lineFor === 'function') {
    const custom = lineFor({
      key,
      actor: ctx.actor || null,
      target: ctx.target || null,
      params,
      rng: ctx.rng
    });
    if (custom != null && String(custom).trim()) return String(custom);
  }
  if (params.lines && typeof params.lines === 'object' && params.lines[key] != null) {
    return String(params.lines[key]);
  }
  if (params.text != null && String(params.text).trim()) return String(params.text);
  return '…';
}

function resolveEmote(emote, detail = {}, emoteFor = null) {
  if (typeof emoteFor === 'function') {
    const custom = emoteFor(emote, detail);
    if (custom != null && String(custom).trim()) return String(custom);
  }
  if (detail.text != null && String(detail.text).trim()) return String(detail.text);
  return EMOTE_GLYPHS[emote] || '…';
}

function bubbleDuration(params, ctx) {
  if (Number.isFinite(Number(params.bubbleMs))) return Number(params.bubbleMs);
  const stateDuration = Number(ctx.durationMs);
  if (Number.isFinite(stateDuration) && stateDuration > 0) {
    return Math.max(1500, Math.min(stateDuration + 600, 4000));
  }
  return DEFAULT_BUBBLE_MS;
}

function finishAfterDuration(ctx) {
  const duration = Math.max(0, Number(ctx.durationMs) || 0);
  if (duration <= 0) return { done: true };
  return { done: Number(ctx.elapsedMs) >= duration };
}

function emit(ctx, type, detail) {
  if (typeof ctx.emit === 'function') ctx.emit(type, detail);
}

function isNpc(value) {
  return Boolean(value) && !value.isPlayer && !value.isCompanion;
}

function readState(host) {
  if (!host || typeof host.getState !== 'function') return null;
  try {
    return host.getState() || null;
  } catch {
    return null;
  }
}

function gameLabel(host, gameId) {
  if (!gameId) return 'mini-game';
  const meta = typeof host?.getMeta === 'function' ? host.getMeta(gameId) : null;
  return meta?.title || gameId;
}

function uniqueToken(sessions, base) {
  let token = String(base);
  let suffix = 2;
  while (sessions.has(token)) token = `${base}-${suffix++}`;
  return token;
}

function trimSessions(sessions) {
  while (sessions.size > MAX_ADAPTER_SESSIONS) {
    const first = sessions.keys().next().value;
    const record = sessions.get(first);
    if (record && typeof record.restoreHooks === 'function') {
      try {
        record.restoreHooks();
      } catch {
        // Best effort: the session is leaving the bounded map anyway.
      }
      record.restoreHooks = null;
    }
    sessions.delete(first);
  }
}

/**
 * Temporarily blank player-facing host hooks. This is belt-and-braces on top of
 * the record/reward/settle options: even a game that emits `finish` without
 * echoing those flags cannot reach the player's stats, loot, toast, or end
 * dialogue while an NPC board owns the host.
 */
function suppressPlayerHooks(host) {
  const hooks = host?.hooks;
  if (!hooks || typeof hooks !== 'object') return () => {};

  const saved = [];
  try {
    for (const key of PLAYER_FACING_HOOKS) {
      const had = Object.prototype.hasOwnProperty.call(hooks, key);
      saved.push({ key, had, value: hooks[key] });
      hooks[key] = undefined;
    }
  } catch {
    return () => {};
  }

  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    for (const { key, had, value } of saved) {
      if (had) hooks[key] = value;
      else delete hooks[key];
    }
  };
}

function attachListener(runtime, handle) {
  if (!runtime) return () => {};
  if (typeof runtime === 'function') {
    const off = runtime(handle);
    return typeof off === 'function' ? off : () => {};
  }
  if (typeof runtime.subscribe === 'function') {
    const off = runtime.subscribe(handle);
    return typeof off === 'function' ? off : () => {};
  }
  if (typeof runtime === 'object') {
    const previous = typeof runtime.onEvent === 'function' ? runtime.onEvent : null;
    const wrapper = entry => {
      if (previous) previous(entry);
      handle(entry);
    };
    runtime.onEvent = wrapper;
    return () => {
      if (runtime.onEvent === wrapper) runtime.onEvent = previous;
    };
  }
  return () => {};
}
