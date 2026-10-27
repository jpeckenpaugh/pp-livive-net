import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MiniGameBase, PHASES } from '../../src/minigames/contract.js';
import { MiniGameHost } from '../../src/minigames/host.js';
import {
  ADAPTER_FACTORIES,
  createTicTacToeAdapter,
  createCheckersAdapter,
  createChessAdapter,
  createFetchAdapter,
  registerContractGames,
  winnerSeatFor
} from '../../src/games/contract-adapters.js';

const data = JSON.parse(readFileSync(new URL('../../data/minigames.json', import.meta.url), 'utf8'));
const metas = data.miniGames;

const BOARD_FACTORIES = [
  ['tic-tac-toe', createTicTacToeAdapter],
  ['checkers', createCheckersAdapter],
  ['chess', createChessAdapter]
];

function makeTerrain() {
  return Array.from({ length: 64 }, () => Array.from({ length: 64 }, () => 'grass'));
}

function makeWorld(overrides = {}) {
  const terrain = overrides.terrain === undefined ? makeTerrain() : overrides.terrain;
  const player = { id: 'player', name: 'You', x: 20, y: 20, direction: 0, moving: false, path: [] };
  const npc = { id: 'npc-1', name: 'Fern', x: 24, y: 20, direction: 0, moving: false, path: [] };
  const companion = {
    id: 'comp-player',
    name: 'Pip',
    isCompanion: true,
    buddyId: 'player',
    x: 19,
    y: 22,
    direction: 0,
    moving: false,
    path: [],
    fetchTarget: null,
    carryingBall: false
  };
  const world = {
    terrain,
    player,
    npcs: [npc],
    companions: [companion],
    heldKeys: [],
    destination: null,
    getCompanionsFor: id => (id === 'player' ? [companion] : []),
    getCompanionFor: id => (id === 'player' ? companion : null),
    triggerCheer: () => {},
    ...overrides.world
  };
  return { world, player, npc, companion };
}

function openBoard(factory, id, placement = { originX: 10, originY: 10 }) {
  const info = makeWorld();
  const adapter = factory({ meta: metas[id], game: info.world, options: {} });
  const result = adapter.open({
    seats: [{ character: info.player }, { character: info.npc }],
    placement,
    options: {}
  });
  return { adapter, result, ...info };
}

test('adapter factories use data/minigames.json metadata and extend MiniGameBase', () => {
  const { world } = makeWorld();
  for (const [id, factory] of Object.entries(ADAPTER_FACTORIES)) {
    const adapter = factory({ meta: metas[id], game: world });
    assert.ok(adapter instanceof MiniGameBase, `${id} should extend MiniGameBase`);
    assert.equal(adapter.meta.id, id);
    assert.equal(adapter.id, id);
    assert.equal(adapter.phase, PHASES.IDLE);
    assert.equal(adapter.meta.kind, metas[id].kind);
  }

  assert.deepEqual(
    Object.keys(ADAPTER_FACTORIES).sort(),
    ['checkers', 'chess', 'connect-four', 'fetch', 'memory-grid', 'tic-tac-toe']
  );
  assert.equal(winnerSeatFor('X'), 0);
  assert.equal(winnerSeatFor('O'), 1);
  assert.equal(winnerSeatFor('draw'), null);
});

test('all six adapters register with the host using their data metadata', () => {
  const { world } = makeWorld();
  const host = new MiniGameHost({ game: world });
  const results = registerContractGames(host);
  assert.equal(results.length, 6);
  for (const result of results) assert.equal(result.ok, true, `${result.id} should register`);
  assert.equal(host.getMeta('tic-tac-toe').board.width, 3);
  assert.equal(host.getMeta('fetch').board, null);
});

test('board adapters open at an explicit placement and fail without valid ground', () => {
  for (const [id, factory] of BOARD_FACTORIES) {
    const { adapter, result } = openBoard(factory, id);
    assert.equal(result.ok, true, `${id} should open`);
    assert.equal(adapter.phase, PHASES.PLAYING);

    const board = metas[id].board;
    assert.deepEqual(adapter.getFootprint(), {
      x: 10,
      y: 10,
      width: board.width,
      height: board.height
    });
    assert.equal(adapter.isTileOnBoard(10, 10), true);
    assert.equal(adapter.isTileOnBoard(10 + board.width, 10), false);
  }

  // No terrain -> the legacy placement search cannot find a spot.
  const info = makeWorld({ terrain: null });
  const adapter = createTicTacToeAdapter({ meta: metas['tic-tac-toe'], game: info.world });
  const failed = adapter.open({
    seats: [{ character: info.player }, { character: info.npc }],
    options: {}
  });
  assert.equal(failed.ok, false);
  assert.match(failed.message, /open ground/i);
  assert.equal(adapter.phase, PHASES.IDLE);
  assert.equal(adapter.getFootprint(), null);

  // Explicit placement over water is rejected too.
  const wet = makeWorld();
  wet.world.terrain[10][10] = 'water';
  const wetAdapter = createTicTacToeAdapter({ meta: metas['tic-tac-toe'], game: wet.world });
  const rejected = wetAdapter.open({
    seats: [{ character: wet.player }, { character: wet.npc }],
    placement: { originX: 10, originY: 10 },
    options: {}
  });
  assert.equal(rejected.ok, false);
  assert.match(rejected.message, /open ground/i);
});

test('handleInput maps action input onto legacy handleAction', () => {
  const { adapter, player } = openBoard(createTicTacToeAdapter, 'tic-tac-toe');
  let received = null;
  adapter.legacy.handleAction = character => {
    received = character;
    return true;
  };

  const result = adapter.handleInput({ kind: 'action', character: player });
  assert.equal(received, player);
  assert.equal(result.handled, true);
  assert.equal(result.changed, true);

  const ignored = adapter.handleInput({ kind: 'tile', character: player });
  assert.equal(ignored.handled, false);
  assert.equal(ignored.changed, false);
});

test('update converts host milliseconds to legacy seconds', () => {
  const { adapter } = openBoard(createCheckersAdapter, 'checkers');
  const seen = [];
  adapter.legacy.update = seconds => seen.push(seconds);

  adapter.update(250);
  adapter.update(16.5);
  assert.deepEqual(seen, [0.25, 0.0165]);
});

test('legacy end state emits one finish event with the right winner seat', () => {
  const cases = [
    ['tic-tac-toe', createTicTacToeAdapter, 'X', 0],
    ['tic-tac-toe', createTicTacToeAdapter, 'O', 1],
    ['tic-tac-toe', createTicTacToeAdapter, 'draw', null],
    ['checkers', createCheckersAdapter, 'player', 0],
    ['checkers', createCheckersAdapter, 'opponent', 1],
    ['chess', createChessAdapter, 'player', 0],
    ['chess', createChessAdapter, 'opponent', 1],
    ['chess', createChessAdapter, 'draw', null]
  ];

  for (const [id, factory, winner, seat] of cases) {
    const { adapter } = openBoard(factory, id);
    adapter.legacy.update = () => {};
    adapter.legacy.activeBoard.status = 'ended';
    adapter.legacy.activeBoard.winner = winner;

    const result = adapter.update(16);
    const finish = result.events.find(event => event.type === 'finish');
    assert.ok(finish, `${id} ${winner} should emit finish`);
    assert.equal(finish.winnerSeat, seat);

    const duplicate = adapter.update(16);
    assert.equal(duplicate.events.some(event => event.type === 'finish'), false);
  }
});

test('legacy onGameEnd callback queues finish and adapters never record results', () => {
  const { adapter } = openBoard(createChessAdapter, 'chess');
  assert.equal(typeof adapter.recordGameResult, 'undefined');
  assert.equal(adapter.legacy.recordResult({ opponentId: 'x' }), null);

  adapter.legacy.update = () => {};
  adapter.legacy.onGameEnd('opponent', { id: 'npc-1' });
  const result = adapter.update(0);
  const finish = result.events.find(event => event.type === 'finish');
  assert.ok(finish);
  assert.equal(finish.winnerSeat, 1);
});

test('fetch adapter is a board-less activity that requires a target', () => {
  const { world, player } = makeWorld();
  const adapter = createFetchAdapter({ meta: metas.fetch, game: world });

  const missing = adapter.open({ seats: [player], options: {} });
  assert.equal(missing.ok, false);
  assert.match(missing.message, /throw the ball/i);
  assert.equal(adapter.getFootprint(), null);
  assert.equal(adapter.blocksStep({ id: 'npc' }, 5, 5), false);
  assert.equal(adapter.isTileOnBoard(5, 5), false);
  assert.deepEqual(adapter.getHiddenZones(), []);

  const opened = adapter.open({
    seats: [player],
    options: { color: '#ffffff', targetTile: { x: 23, y: 20 } }
  });
  assert.equal(opened.ok, true);
  assert.equal(adapter.phase, PHASES.PLAYING);
  assert.equal(adapter.legacy.activeBall.targetX, 23);
  assert.equal(adapter.legacy.activeBall.targetY, 20);
  assert.equal(adapter.legacy.activeBall.color, '#ffffff');

  // No board footprint, so the host never blocks or hides tiles.
  assert.equal(adapter.getFootprint(), null);
  const action = adapter.handleInput({ kind: 'action', character: player });
  assert.equal(action.handled, false);

  adapter.close({ reason: 'packed-up' });
  assert.equal(adapter.legacy.activeBall, null);
  assert.equal(adapter.getFootprint(), null);
});

test('render delegates the legacy canvas pass once on its primary layer', () => {
  const cases = [
    ['tic-tac-toe', createTicTacToeAdapter, 'ground'],
    ['checkers', createCheckersAdapter, 'ground'],
    ['chess', createChessAdapter, 'ground'],
    ['fetch', createFetchAdapter, 'object']
  ];

  for (const [id, factory, layer] of cases) {
    const info = makeWorld();
    const adapter = factory({ meta: metas[id], game: info.world });
    if (id === 'fetch') {
      adapter.open({ seats: [info.player], options: { targetTile: { x: 23, y: 20 } } });
    } else {
      adapter.open({
        seats: [{ character: info.player }, { character: info.npc }],
        placement: { originX: 10, originY: 10 },
        options: {}
      });
    }

    const calls = [];
    adapter.legacy.render = (ctx, camera) => calls.push({ ctx, camera });
    const ctx = { save() {}, restore() {} };
    const view = { camera: { x: 999, y: 999 }, width: 800 };

    assert.equal(adapter.render(ctx, layer, view), true, `${id} renders on ${layer}`);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].ctx, ctx);
    // Already-translated canvas: legacy must receive a zero camera.
    assert.deepEqual(calls[0].camera, { x: 0, y: 0 });

    assert.equal(adapter.render(ctx, 'hud', view), false);
    assert.equal(calls.length, 1);
  }
});

test('close packs up the legacy board and releases staging', () => {
  const { adapter, npc, companion } = openBoard(createCheckersAdapter, 'checkers');
  npc.inMiniGame = true;
  companion.stagedDestination = { x: 9, y: 13 };

  const result = adapter.close({ reason: 'packed-up' });
  assert.equal(result.events[0].type, 'closed');
  assert.equal(result.events[0].reason, 'packed-up');
  assert.equal(adapter.legacy.activeBoard, null);
  assert.equal(adapter.getFootprint(), null);
  assert.equal(npc.inMiniGame, false);
  assert.equal(companion.stagedDestination, null);
});

test('host runs an adapted board game and settles exactly once through its hooks', () => {
  const info = makeWorld();
  const calls = { record: [], ends: [], toasts: [] };
  const host = new MiniGameHost({
    game: info.world,
    hooks: {
      recordGameResult: args => {
        calls.record.push(args);
        return { totalWins: 1 };
      },
      rollReward: () => null,
      applyReward: () => [],
      onGameEnd: payload => calls.ends.push(payload),
      onToast: message => calls.toasts.push(message)
    }
  });

  registerContractGames(host);
  const started = host.start('tic-tac-toe', {
    player: info.player,
    opponent: info.npc,
    placement: { originX: 10, originY: 10 },
    terrain: info.world.terrain
  });
  assert.equal(started.ok, true);
  assert.deepEqual(host.session.game.getFootprint(), { x: 10, y: 10, width: 3, height: 3 });

  host.session.game.legacy.update = () => {};
  host.session.game.legacy.activeBoard.status = 'ended';
  host.session.game.legacy.activeBoard.winner = 'X';
  host.update(16);

  assert.equal(calls.record.length, 1);
  assert.deepEqual(calls.record[0], { opponentId: 'npc-1', opponentName: 'Fern', result: 'win' });
  assert.equal(calls.ends.length, 1);
  assert.equal(calls.ends[0].settlement.outcome, 'win');

  host.update(16);
  assert.equal(calls.record.length, 1);
  assert.equal(calls.ends.length, 1);

  host.packUp();
  assert.equal(host.isOpen(), false);
});

test('NPC-mode board adapters leave the human in place and stage both seats on free margins', () => {
  const info = makeWorld();
  const partner = { id: 'npc-2', name: 'Moss', x: 26, y: 20, direction: 0, moving: false, path: [] };
  info.world.npcs.push(partner);
  const adapter = createTicTacToeAdapter({ meta: metas['tic-tac-toe'], game: info.world });
  const placement = { originX: 10, originY: 10 };
  const humanStart = { x: info.player.x, y: info.player.y };

  const opened = adapter.open({
    seats: [{ character: info.npc }, { character: partner }],
    placement,
    options: {}
  });
  assert.equal(opened.ok, true, opened.message);

  const board = adapter.legacy.activeBoard;
  assert.equal(info.npc.inMiniGame, true);
  assert.deepEqual(info.npc.miniGameTarget, { x: board.originX - 1, y: board.originY + 1 });
  assert.ok(info.npc.path.length > 0, 'seat 0 should walk to the left margin');
  assert.deepEqual(board.npcSeatTargets[0], { x: board.originX - 1, y: board.originY + 1 });
  assert.deepEqual(board.npcSeatTargets[1], { x: board.originX + 3, y: board.originY + 1 });

  // The human is not moved and the legacy auto-walk is cancelled.
  assert.deepEqual({ x: info.player.x, y: info.player.y }, humanStart);
  assert.equal(info.player.path.length, 0);
  assert.equal(info.player.moving, false);

  // Seats are exempt from board blocking; bystanders are not.
  assert.equal(adapter.blocksStep(info.npc, board.originX, board.originY), false);
  assert.equal(adapter.blocksStep(partner, board.originX, board.originY), false);
  const bystander = { id: 'npc-3', x: board.originX - 2, y: board.originY - 1, moving: false, path: [] };
  assert.equal(adapter.blocksStep(bystander, board.originX, board.originY), true);
});
