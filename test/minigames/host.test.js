import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MiniGameHost } from '../../src/minigames/host.js';
import { PHASES } from '../../src/minigames/contract.js';

const data = JSON.parse(readFileSync(new URL('../../data/minigames.json', import.meta.url), 'utf8'));
const tttMeta = data.miniGames['tic-tac-toe'];
const fetchMeta = data.miniGames.fetch;

const terrain = Array.from({ length: 64 }, () => Array.from({ length: 64 }, () => 'grass'));

function makeGame(meta) {
  return {
    meta,
    phase: PHASES.OPENING,
    events: [],
    openArgs: null,
    lastInput: null,
    closedWith: null,
    open(args) {
      this.openArgs = args;
      this.phase = PHASES.READY;
      return { ok: true, phase: PHASES.READY };
    },
    ready() {
      this.phase = PHASES.READY;
      return { ok: true, phase: PHASES.READY };
    },
    update() {
      return { handled: false, changed: false, events: this.events.splice(0) };
    },
    handleInput(input) {
      this.lastInput = input;
      return { handled: true, changed: true, events: [] };
    },
    close(args) {
      this.closedWith = args;
    },
    getFootprint() {
      return { x: 10, y: 10, width: 3, height: 3 };
    },
    getHiddenZones() {
      return [{ x: 10, y: 10, width: 1, height: 1 }];
    },
    render(ctx, layer, view) {
      this.renderedLayers = [...(this.renderedLayers || []), layer];
    }
  };
}

function setup(overrides = {}) {
  const player = { id: 'player', x: 9, y: 11, moving: false, path: [] };
  const npc = { id: 'npc-1', name: 'Fern', x: 13, y: 11, moving: false, path: [] };
  const bystander = { id: 'npc-2', x: 30, y: 30, moving: false, path: [] };
  const playerComp = { id: 'comp-player', buddyId: 'player', x: 8, y: 11, moving: false, path: [] };
  const npcComp = { id: 'comp-npc', buddyId: 'npc-1', x: 14, y: 11, moving: false, path: [] };

  const hooks = {
    onToast: () => {},
    onCheer: () => {},
    onGameEnd: () => {},
    recordGameResult: () => ({}),
    rollReward: () => null,
    applyReward: () => [],
    ...overrides.hooks
  };

  const host = new MiniGameHost({
    game: { terrain },
    getCompanionsFor: id => (
      id === 'player' ? [playerComp] : (id === 'npc-1' ? [npcComp] : [])
    ),
    hooks
  });
  host.register({ meta: tttMeta, create: ({ meta }) => makeGame(meta) });

  return { host, player, npc, bystander, playerComp, npcComp, hooks };
}

test('registry rejects invalid metadata, duplicates, and missing factories', () => {
  const host = new MiniGameHost();
  const invalid = host.register({ ...tttMeta, kind: 'arcade' }, () => ({}));
  assert.equal(invalid.ok, false);
  assert.equal(invalid.reason, 'invalid-meta');

  const missing = host.register(tttMeta);
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'missing-factory');

  const good = host.register(tttMeta, () => ({}));
  assert.equal(good.ok, true);
  assert.equal(host.getMeta('tic-tac-toe').id, 'tic-tac-toe');

  const duplicate = host.register(tttMeta, () => ({}));
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.reason, 'duplicate-id');
});

test('start opens one session and a second start fails as busy', () => {
  const { host, player, npc } = setup();
  const result = host.start('tic-tac-toe', {
    player,
    opponent: npc,
    placement: { originX: 10, originY: 10 },
    terrain
  });

  assert.equal(result.ok, true);
  assert.equal(result.gameId, 'tic-tac-toe');
  assert.equal(host.isOpen(), true);
  assert.equal(host.activeGameId, 'tic-tac-toe');
  assert.equal(host.session.seats.length, 2);
  assert.deepEqual(host.session.seats.map(seat => seat.controller), ['human', 'ai']);
  assert.equal(result.game.openArgs.seats.length, 2);

  const busy = host.start('fetch', { seats: [player], terrain });
  assert.equal(busy.ok, false);
  assert.equal(busy.reason, 'busy');
  assert.equal(busy.activeGameId, 'tic-tac-toe');
  assert.match(busy.message, /already open/i);
  assert.equal(host.activeGameId, 'tic-tac-toe');
});

test('start rejects unknown games, missing participants, and bad placements', () => {
  const { host, player } = setup();
  const unknown = host.start('mystery', { seats: [player], terrain });
  assert.equal(unknown.reason, 'unknown-game');

  const empty = host.start('tic-tac-toe', { terrain });
  assert.equal(empty.reason, 'no-participants');

  const waterTerrain = terrain.map(row => [...row]);
  waterTerrain[9][9] = 'water';
  const bad = host.start('tic-tac-toe', {
    seats: [player, { id: 'npc-9', x: 20, y: 20 }],
    placement: { originX: 10, originY: 10 },
    terrain: waterTerrain
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'invalid-placement');
  assert.equal(host.isOpen(), false);
});

test('participants are exempt while bystanders may enter blocked and escape', () => {
  const { host, player, npc, bystander, playerComp } = setup();
  host.start('tic-tac-toe', { player, opponent: npc, placement: { originX: 10, originY: 10 }, terrain });

  assert.equal(host.isParticipant(player), true);
  assert.equal(host.isParticipant(npc), true);
  assert.equal(host.isParticipant(bystander), false);
  assert.equal(host.blocksStep(player, 11, 11), false);

  const companionOfParticipant = playerComp;
  assert.equal(host.getParticipantCompanions().length, 2);
  assert.equal(host.blocksStep(companionOfParticipant, 11, 11), false);

  // Bystander outside tries to enter.
  assert.equal(host.blocksStep(bystander, 11, 12), true);
  // A bystander already standing on the board may walk off.
  const onBoard = { id: 'npc-3', x: 11, y: 11 };
  assert.equal(host.blocksStep(onBoard, 11, 9), false);
  // Unrelated tiles are free.
  assert.equal(host.blocksStep(bystander, 20, 20), false);

  assert.equal(host.isTileOnBoard(10, 10), true);
  assert.equal(host.isTileOnBoard(13, 13), false);
  assert.equal(host.getBlockedTiles().size, 9);
  assert.ok(host.getHiddenZones().some(zone => zone.x === 10 && zone.y === 10));
});

test('board-less activities never block steps', () => {
  const host = new MiniGameHost({ game: { terrain } });
  host.register({ meta: fetchMeta, create: ({ meta }) => ({ ...makeGame(meta), getFootprint: () => null }) });
  const result = host.start('fetch', { seats: [{ id: 'player', x: 5, y: 5 }], terrain });
  assert.equal(result.ok, true);
  assert.equal(host.getBlockedTiles().size, 0);
  assert.equal(host.blocksStep({ id: 'npc' }, 5, 5), false);
  assert.equal(host.isTileOnBoard(5, 5), false);
});

test('handleAction routes only participant input to the active game', () => {
  const { host, player, npc, bystander } = setup();
  host.start('tic-tac-toe', { player, opponent: npc, placement: { originX: 10, originY: 10 }, terrain });

  const ignored = host.handleAction(bystander);
  assert.deepEqual(ignored, { handled: false, changed: false, events: [] });

  const result = host.handleAction(player);
  assert.equal(result.handled, true);
  assert.equal(host.session.game.lastInput.seat, 0);
  assert.equal(host.session.game.lastInput.controller, 'human');
  assert.deepEqual(host.session.game.lastInput.tile, { x: 9, y: 11 });

  host.pause('dialogue');
  assert.equal(host.handleAction(npc).handled, false);
  host.resume();
  assert.equal(host.handleAction(npc).handled, true);
});

test('finish settles exactly once through injected callbacks', () => {
  const calls = { record: [], roll: [], apply: [], ends: [], toasts: [], cheers: [] };
  const { host, player, npc } = setup({
    hooks: {
      onToast: message => calls.toasts.push(message),
      onCheer: (id, duration) => calls.cheers.push({ id, duration }),
      onGameEnd: payload => calls.ends.push(payload),
      recordGameResult: args => {
        calls.record.push(args);
        return { totalWins: 1 };
      },
      rollReward: (game, key, outcome) => {
        calls.roll.push({ key, outcome });
        return { coins: 10, items: [], newCompanion: null };
      },
      applyReward: (game, reward) => {
        calls.apply.push(reward);
        return ['+10 coins'];
      }
    }
  });
  host.start('tic-tac-toe', { player, opponent: npc, placement: { originX: 10, originY: 10 }, terrain });

  host.session.game.events.push(
    { type: 'toast', message: 'nice move' },
    { type: 'cheer', characterId: 'player', duration: 2 },
    { type: 'finish', winnerSeat: 0 }
  );
  host.update(16);

  assert.equal(calls.record.length, 1);
  assert.deepEqual(calls.record[0], { opponentId: 'npc-1', opponentName: 'Fern', result: 'win' });
  assert.deepEqual(calls.roll, [{ key: 'tic-tac-toe', outcome: 'win' }]);
  assert.equal(calls.apply.length, 1);
  assert.deepEqual(calls.toasts, ['nice move']);
  assert.deepEqual(calls.cheers, [{ id: 'player', duration: 2 }]);
  assert.equal(calls.ends.length, 1);
  assert.equal(calls.ends[0].settlement.outcome, 'win');
  assert.equal(calls.ends[0].dialogue.key, 'ttt');
  assert.equal(host.session.settled, true);

  host.session.game.events.push({ type: 'finish', winnerSeat: 0 });
  host.update(16);
  assert.equal(calls.record.length, 1);
  assert.equal(calls.ends.length, 1);

  const closed = host.close();
  assert.equal(closed.ok, true);
  assert.equal(calls.record.length, 1);
  assert.equal(host.isOpen(), false);
  assert.equal(host.getState().active, false);
});

test('close and packUp release staging and session state', () => {
  const { host, player, npc, playerComp } = setup();
  host.start('tic-tac-toe', { player, opponent: npc, placement: { originX: 10, originY: 10 }, terrain });
  player.inMiniGame = true;
  player.stagedDestination = { x: 9, y: 11 };
  playerComp.stagedDestination = { x: 8, y: 12 };

  const packed = host.packUp();
  assert.equal(packed.ok, true);
  assert.equal(packed.reason, 'packed-up');
  assert.equal(host.session, null);
  assert.equal(player.inMiniGame, false);
  assert.equal(player.stagedDestination, null);
  assert.equal(playerComp.stagedDestination, null);
  assert.equal(host.close().reason, 'no-session');
});

test('pause, resume, and render layers delegate by metadata', () => {
  const { host, player, npc } = setup();
  host.start('tic-tac-toe', { player, opponent: npc, placement: { originX: 10, originY: 10 }, terrain });

  assert.deepEqual(host.pause('dialogue'), { ok: true, paused: true, reason: 'dialogue' });
  assert.deepEqual(host.update(16), { handled: false, changed: false, events: [] });
  assert.deepEqual(host.resume('dialogue'), { ok: true, paused: false, reason: 'dialogue' });

  const ctx = {};
  const view = { width: 800 };
  assert.equal(host.renderLayer(ctx, 'ground', view), true);
  assert.equal(host.renderLayer(ctx, 'hud', view), false);
  assert.deepEqual(host.session.game.renderedLayers, ['ground']);
});

test('host binds game.getCompanionsFor and does not mark companions for boardless activities', () => {
  const player = { id: 'player', x: 9, y: 11, moving: false, path: [] };
  const npc = { id: 'npc-1', name: 'Fern', x: 13, y: 11, moving: false, path: [] };
  const playerComp = { id: 'comp-player', buddyId: 'player', x: 8, y: 11, moving: false, path: [] };
  const game = {
    terrain,
    companions: [playerComp],
    getCompanionsFor(id) {
      return this.companions.filter(comp => comp.buddyId === id);
    }
  };

  const host = new MiniGameHost({
    game,
    hooks: {
      onToast: () => {},
      onCheer: () => {},
      onGameEnd: () => {},
      recordGameResult: () => ({}),
      rollReward: () => null,
      applyReward: () => []
    }
  });
  host.register({ meta: tttMeta, create: ({ meta }) => makeGame(meta) });
  const started = host.start('tic-tac-toe', { player, opponent: npc, placement: { originX: 10, originY: 10 }, terrain });
  assert.equal(started.ok, true, started.message);
  assert.deepEqual(host.getParticipantCompanions().map(comp => comp.id), ['comp-player']);
  host.close({ reason: 'test' });

  host.register({ meta: fetchMeta, create: ({ meta }) => makeGame(meta) });
  const fetchStarted = host.start('fetch', { player, options: { targetTile: { x: 12, y: 11 } }, terrain });
  assert.equal(fetchStarted.ok, true, fetchStarted.message);
  assert.deepEqual(host.getParticipantCompanions(), []);
  host.close({ reason: 'test' });
});

test('hidden zones include the full board footprint for scenery culling', () => {
  const { host, player, npc } = setup();
  host.start('tic-tac-toe', { player, opponent: npc, placement: { originX: 10, originY: 10 }, terrain });

  const zones = host.getHiddenZones();
  assert.ok(zones.some(zone => (
    zone.x === 10 && zone.y === 10 && zone.width === 3 && zone.height === 3
  )), 'board footprint should be hidden from scenery');
});

test('getState surfaces the game turn seat and instruction', () => {
  const { host, player, npc } = setup();
  host.start('tic-tac-toe', { player, opponent: npc, placement: { originX: 10, originY: 10 }, terrain });

  assert.equal(host.getState().turnSeat, null);
  assert.equal(host.getState().instruction, null);
  assert.equal(host.getState().kind, 'board');

  host.session.game.describeStatus = () => ({ turnSeat: 1, instruction: 'step onto a square' });
  const state = host.getState();
  assert.equal(state.turnSeat, 1);
  assert.equal(state.instruction, 'step onto a square');

  host.session.game.describeStatus = () => { throw new Error('boom'); };
  assert.equal(host.getState().turnSeat, null);
});

test('reject events reach the reject hook, skip the toast hook, and land in the trace', () => {
  const seen = { rejects: [], toasts: [] };
  const { host, player, npc } = setup({
    hooks: {
      onToast: message => seen.toasts.push(message),
      onReject: event => seen.rejects.push(event)
    }
  });
  host.start('tic-tac-toe', { player, opponent: npc, placement: { originX: 10, originY: 10 }, terrain });
  host.clearTrace();
  host.session.game.handleInput = () => ({
    handled: true,
    changed: false,
    events: [{ type: 'reject', reason: 'occupied' }]
  });

  host.handleAction(player);
  assert.deepEqual(seen.rejects.map(event => event.reason), ['occupied']);
  assert.deepEqual(seen.toasts, []);

  const entry = host.getTrace().at(-1);
  assert.equal(entry.action, 'action');
  assert.equal(entry.accepted, false);
  assert.equal(entry.reason, 'occupied');
  assert.equal(entry.gameId, 'tic-tac-toe');
});

test('the trace keeps the newest 50 entries in order and clears on demand', () => {
  const { host, player, npc } = setup();
  host.start('tic-tac-toe', { player, opponent: npc, placement: { originX: 10, originY: 10 }, terrain });
  host.clearTrace();

  for (let i = 0; i < 60; i++) host._notify({ type: 'turn', seat: i % 2 }, host.session);
  const trace = host.getTrace();
  assert.equal(trace.length, 50);
  assert.equal(trace[0].seq, 11);
  assert.equal(trace.at(-1).seq, 60);
  assert.equal(trace.at(-1).action, 'turn');
  assert.ok(trace.every((entry, index) => index === 0 || entry.seq > trace[index - 1].seq));

  // Mutating the copy must not touch the buffer.
  trace[0].reason = 'tampered';
  assert.equal(host.getTrace()[0].reason, null);

  host.clearTrace();
  assert.deepEqual(host.getTrace(), []);
});

test('start, accepted actions, settlement, and close are traced', () => {
  const { host, player, npc } = setup();
  host.start('tic-tac-toe', { player, opponent: npc, placement: { originX: 10, originY: 10 }, terrain });
  assert.deepEqual(host.getTrace().map(entry => entry.action), ['open', 'start']);

  host.handleAction(player);
  assert.equal(host.getTrace().at(-1).action, 'action');
  assert.equal(host.getTrace().at(-1).accepted, true);

  host.settle({ winnerSeat: 0 });
  assert.equal(host.getTrace().at(-1).action, 'settle');
  assert.equal(host.getTrace().at(-1).reason, 'win');

  host.close({ reason: 'packed-up' });
  assert.equal(host.getTrace().at(-1).action, 'close');
  assert.equal(host.getTrace().at(-1).reason, 'packed-up');
});

test('target hints come from the game and draw one overlay ring each', () => {
  const { host, player, npc } = setup();
  host.start('tic-tac-toe', { player, opponent: npc, placement: { originX: 10, originY: 10 }, terrain });
  host.session.game.describeTarget = tile => ({
    tile: { x: tile.x, y: tile.y },
    valid: tile.x === 10
  });

  const hints = host.setTargetTiles([{ x: 10, y: 10 }, { x: 11, y: 10 }]);
  assert.deepEqual(hints.map(hint => hint.valid), [true, false]);
  assert.equal(hints[0].facing, false);
  assert.equal(hints[1].facing, true);

  const strokes = [];
  const ctx = {
    save() {},
    restore() {},
    fillRect() {},
    setLineDash() {},
    strokeRect(x, y, w, h) { strokes.push({ x, y, w, h }); },
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 0
  };
  const handled = host.renderLayer(ctx, 'overlay', { tileSize: 32 });
  assert.equal(handled, true);
  assert.equal(strokes.length, 2);

  host.setTargetTiles([]);
  assert.deepEqual(host.targetHints, []);
  host.close({ reason: 'test' });
  assert.deepEqual(host.setTargetTiles([{ x: 10, y: 10 }]), []);
});
