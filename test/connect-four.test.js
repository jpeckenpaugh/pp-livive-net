import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ConnectFourGame,
  createConnectFourGame,
  CONNECT_FOUR_COLUMNS,
  CONNECT_FOUR_ROWS
} from '../src/games/connect-four.js';
import { PHASES } from '../src/minigames/contract.js';

const META = {
  id: 'connect-four',
  title: 'Connect Four',
  kind: 'board',
  itemId: 'connect-four',
  dialogueKey: 'connect-four',
  rewardKey: 'connect-four',
  players: 2,
  seats: 2,
  board: { width: 7, height: 6, margin: 1, blocksMovement: true, hiddenZones: [] },
  input: { mode: 'tile', actionLabel: 'drop' },
  renderLayers: ['ground'],
  timing: { openMs: 0, closeMs: 0, turnMs: 0 },
  persist: false,
  activity: 'turn-based'
};

// Full 7×6 board with no four-in-a-row (verified by exhaustive line checks).
const DRAW_ROWS = [
  [0, 0, 0, 1, 0, 0, 0],
  [0, 0, 0, 1, 0, 0, 0],
  [0, 0, 1, 0, 1, 0, 0],
  [1, 1, 1, 0, 1, 1, 1],
  [0, 0, 0, 1, 0, 0, 0],
  [0, 0, 0, 1, 0, 0, 0]
];

function makeTerrain(type = 'grass') {
  return Array.from({ length: 64 }, () => Array(64).fill(type));
}

function makeCharacter(id, x, y, name = id) {
  return { id, name, x, y, direction: 2, path: [], moving: false };
}

function makeGame({
  terrain = makeTerrain(),
  player = makeCharacter('player', 20, 20, 'You'),
  npc = makeCharacter('npc', 18, 20, 'Moss'),
  companions = []
} = {}) {
  return {
    terrain,
    player,
    npcs: [npc],
    companions,
    getCompanionsFor(id) {
      return companions.filter(companion => companion.buddyId === id);
    }
  };
}

function openGame(context = {}) {
  const game = context.game || makeGame(context);
  const player = game.player;
  const npc = game.npcs[0];
  const instance = new ConnectFourGame({
    meta: context.meta || META,
    game,
    options: context.options || {}
  });
  const result = instance.open({
    seats: context.seats || [
      { character: player, controller: 'human' },
      { character: npc, controller: 'ai' }
    ],
    placement: context.placement || null,
    options: context.options || {}
  });
  return { instance, game, player, npc, result };
}

function setGrid(instance, rows) {
  instance.grid = rows.map(row => [...row]);
  instance.moveCount = instance.grid.reduce(
    (total, row) => total + row.filter(cell => cell !== null).length,
    0
  );
}

function boardTile(instance, column, row) {
  return {
    x: instance.placement.originX + column,
    y: instance.placement.originY + row
  };
}

test('opens with an empty 7×6 board and both seats staged', () => {
  const companion = { ...makeCharacter('buddy', 17, 20, 'Pip'), buddyId: 'player' };
  const { instance, player, npc, result } = openGame({ companions: [companion] });

  assert.equal(result.ok, true);
  assert.equal(instance.phase, PHASES.PLAYING);
  assert.equal(instance.grid.length, CONNECT_FOUR_ROWS);
  assert.ok(instance.grid.every(row => row.length === CONNECT_FOUR_COLUMNS));
  assert.ok(instance.grid.every(row => row.every(cell => cell === null)));
  assert.equal(instance.turn, 0);
  assert.equal(instance.moveCount, 0);
  assert.equal(player.inMiniGame, true);
  assert.equal(npc.inMiniGame, true);
  assert.equal(companion.inMiniGame, true);
  assert.deepEqual(instance.placement, { originX: 21, originY: 19 });
  assert.deepEqual(instance.getFootprint(), { x: 21, y: 19, width: 7, height: 6 });
});

test('cellAtTile maps board tiles to columns and rejects off-board tiles', () => {
  const { instance } = openGame();

  assert.deepEqual(instance.cellAtTile(21, 19), { row: 0, column: 0, col: 0, index: 0 });
  assert.deepEqual(instance.cellAtTile(27, 24), { row: 5, column: 6, col: 6, index: 41 });
  assert.deepEqual(instance.cellAtTile(24, 21), { row: 2, column: 3, col: 3, index: 17 });
  assert.equal(instance.cellAtTile(20, 19), null);
  assert.equal(instance.cellAtTile(21, 25), null);
  assert.equal(instance.cellAtTile(28, 19), null);
});

test('dropDisc applies gravity and rejects a full column', () => {
  const { instance } = openGame();

  assert.deepEqual(instance.dropDisc(3, 0), { ok: true, row: 5, column: 3, col: 3, seat: 0 });
  assert.deepEqual(instance.dropDisc(3, 1), { ok: true, row: 4, column: 3, col: 3, seat: 1 });
  assert.equal(instance.grid[5][3], 0);
  assert.equal(instance.grid[4][3], 1);

  for (let i = 0; i < 4; i++) {
    assert.equal(instance.dropDisc(3, i % 2).ok, true);
  }
  assert.equal(instance.grid[0][3], 1);

  const full = instance.dropDisc(3, 0);
  assert.deepEqual(full, { ok: false, reason: 'column-full', column: 3 });
  assert.equal(instance.moveCount, CONNECT_FOUR_ROWS);
});

test('detects horizontal, vertical and both diagonal wins', () => {
  const { instance } = openGame();

  setGrid(instance, [
    [null, null, null, null, null, null, null],
    [null, null, null, null, null, null, null],
    [null, null, null, null, null, null, null],
    [null, null, null, null, null, null, null],
    [null, null, null, null, null, null, null],
    [0, 0, 0, 0, 1, 1, 1]
  ]);
  assert.equal(instance.checkWinner({ row: 5, column: 3, seat: 0 }), 0);

  setGrid(instance, [
    [null, null, null, null, null, null, null],
    [null, null, null, null, null, null, null],
    [null, null, null, null, 1, null, null],
    [null, null, null, null, 1, null, null],
    [null, null, null, null, 1, null, null],
    [null, null, null, null, 1, null, null]
  ]);
  assert.equal(instance.checkWinner({ row: 2, column: 4, seat: 1 }), 1);

  setGrid(instance, [
    [null, null, null, null, null, null, null],
    [null, null, null, null, null, null, null],
    [null, null, null, 0, null, null, null],
    [null, null, 0, 1, null, null, null],
    [null, 0, 1, 1, null, null, null],
    [0, 1, 1, 1, null, null, null]
  ]);
  assert.equal(instance.checkWinner({ row: 2, column: 3, seat: 0 }), 0);

  setGrid(instance, [
    [null, null, null, null, null, null, null],
    [null, null, null, null, null, null, null],
    [0, null, null, null, null, null, null],
    [1, 0, null, null, null, null, null],
    [1, 1, 0, null, null, null, null],
    [1, 1, 1, 0, null, null, null]
  ]);
  assert.equal(instance.checkWinner({ row: 2, column: 0, seat: 0 }), 0);

  // A stale last move (cell no longer matches) never reports a winner.
  assert.equal(instance.checkWinner({ row: 5, column: 6, seat: 1 }), null);
});

test('draw detection fills the last cell and emits a finish with no winner', () => {
  const { instance, player } = openGame();
  const rows = DRAW_ROWS.map(row => [...row]);
  rows[0][0] = null;
  setGrid(instance, rows);
  assert.equal(instance.moveCount, 41);
  instance.turn = 0;

  const tile = boardTile(instance, 0, 0);
  player.x = tile.x;
  player.y = tile.y;

  const result = instance.handleInput({
    type: 'action',
    seat: 0,
    controller: 'human',
    character: player,
    tile
  });

  assert.equal(result.handled, true);
  assert.equal(instance.finished, true);
  assert.equal(instance.isBoardFull(), true);
  assert.equal(instance.isDraw(), true);
  const finish = result.events.find(event => event.type === 'finish');
  assert.ok(finish);
  assert.equal(finish.winnerSeat, null);
  assert.equal(instance.phase, PHASES.ENDING);
});

test('AI takes an immediate win', () => {
  const { instance } = openGame();
  setGrid(instance, [
    [null, null, null, null, null, null, null],
    [null, null, null, null, null, null, null],
    [null, null, null, null, null, null, null],
    [null, null, null, null, null, null, null],
    [null, null, null, null, null, null, null],
    [1, 1, 1, null, null, null, null]
  ]);

  assert.equal(instance.chooseAiColumn(1), 3);
});

test('AI blocks seat 0 immediate win', () => {
  const { instance } = openGame();
  setGrid(instance, [
    [null, null, null, null, null, null, null],
    [null, null, null, null, null, null, null],
    [null, null, null, null, null, null, null],
    [null, null, null, null, null, null, null],
    [null, null, null, null, null, null, null],
    [0, 0, 0, null, null, null, null]
  ]);

  assert.equal(instance.chooseAiColumn(1), 3);
});

test('AI falls back to legal center-preferring columns', () => {
  const { instance } = openGame();
  assert.equal(instance.chooseAiColumn(1), 3);

  for (let i = 0; i < CONNECT_FOUR_ROWS; i++) {
    instance.grid[i][3] = i % 2;
  }
  instance.moveCount = CONNECT_FOUR_ROWS;
  assert.ok([2, 4].includes(instance.chooseAiColumn(1)));
});

test('AI walks into the chosen column and drops through the same input handler', () => {
  const { instance, npc } = openGame();
  // Start off the board; the AI should request a path to the center column top.
  instance.turn = 1;
  npc.x = instance.placement.originX - 1;
  npc.y = instance.placement.originY + 2;
  npc.path = [];

  const planning = instance.update(0);
  assert.equal(planning.events.length, 0);
  assert.equal(npc.path.length > 0, true);
  assert.equal(npc.inMiniGame, true);
  assert.deepEqual(npc.miniGameTarget, boardTile(instance, 3, 0));

  // Simulate arrival (the world update moves characters; this game only ticks).
  const target = boardTile(instance, 3, 0);
  npc.x = target.x;
  npc.y = target.y;
  npc.path = [];
  npc.moving = false;

  const dropped = instance.update(0);
  assert.equal(dropped.handled, true);
  assert.equal(instance.grid[5][3], 1);
  assert.equal(instance.turn, 0);
  assert.equal(dropped.events[0].type, 'turn');
  assert.equal(dropped.events[0].seat, 0);
});

test('AI drops directly when it cannot path to the column', () => {
  const { instance, npc } = openGame({ options: { aiThinkMs: 0 } });
  instance.turn = 1;
  // Isolate the AI on an island so findPath has no route to the board.
  const terrain = makeTerrain('water');
  for (let y = 50; y < 56; y++) {
    for (let x = 50; x < 56; x++) terrain[y][x] = 'grass';
  }
  instance.game.terrain = terrain;
  npc.x = 52;
  npc.y = 52;
  npc.path = [];
  instance.placement = { originX: 21, originY: 19 };

  const result = instance.update(0);
  assert.equal(result.handled, true);
  assert.equal(instance.grid[5][3], 1);
  assert.equal(instance.turn, 0);
  assert.equal(npc.inMiniGame, true);
});

test('turn switching rejects out-of-turn and full-column actions', () => {
  const { instance, player, npc } = openGame();
  player.x = instance.placement.originX;
  player.y = instance.placement.originY + 5;

  const first = instance.handleInput({ type: 'action', seat: 0, character: player });
  assert.equal(first.handled, true);
  assert.equal(first.changed, true);
  assert.equal(instance.grid[5][0], 0);
  assert.equal(instance.turn, 1);

  const outOfTurn = instance.handleInput({ type: 'action', seat: 0, character: player });
  assert.equal(outOfTurn.handled, true);
  assert.equal(outOfTurn.changed, false);
  assert.equal(outOfTurn.events[0].type, 'toast');
  assert.match(outOfTurn.events[0].message, /turn/i);

  // Fill column 1 and let seat 0 try it after regaining the turn.
  instance.turn = 0;
  for (let i = 0; i < CONNECT_FOUR_ROWS; i++) instance.grid[i][1] = i % 2;
  instance.moveCount = CONNECT_FOUR_ROWS;
  const full = instance.handleInput({
    type: 'action',
    seat: 0,
    character: player,
    tile: boardTile(instance, 1, 0)
  });
  assert.equal(full.handled, true);
  assert.equal(full.changed, false);
  assert.match(full.events[0].message, /full/i);
  assert.equal(instance.turn, 0);
  assert.equal(npc.inMiniGame, true);
});

test('a winning drop emits finish with the winner seat', () => {
  const { instance, player } = openGame();
  setGrid(instance, [
    [null, null, null, null, null, null, null],
    [null, null, null, null, null, null, null],
    [null, null, null, null, null, null, null],
    [null, null, null, null, null, null, null],
    [null, null, null, null, null, null, null],
    [0, 0, 0, null, null, null, null]
  ]);
  instance.turn = 0;

  const tile = boardTile(instance, 3, 5);
  const result = instance.handleInput({
    type: 'action',
    seat: 0,
    character: player,
    tile
  });

  assert.equal(instance.finished, true);
  assert.equal(instance.winnerSeat, 0);
  assert.equal(instance.turn, null);
  const finish = result.events.find(event => event.type === 'finish');
  assert.ok(finish);
  assert.equal(finish.winnerSeat, 0);
  assert.equal(instance.phase, PHASES.ENDING);
  assert.equal(instance.finishEvent, finish);
});

test('open fails cleanly when no open ground fits the board', () => {
  const game = makeGame({ terrain: makeTerrain('water') });
  const instance = createConnectFourGame({ meta: META, game });
  const result = instance.open({
    seats: [
      { character: game.player, controller: 'human' },
      { character: game.npcs[0], controller: 'ai' }
    ]
  });

  assert.equal(result.ok, false);
  assert.equal(result.phase, PHASES.IDLE);
  assert.match(result.message, /open ground/i);
  assert.equal(instance.active, false);
  assert.equal(instance.placement, null);
  assert.equal(instance.getFootprint(), null);
});

test('open rejects an explicit placement that overlaps water', () => {
  const terrain = makeTerrain();
  for (let y = 19; y < 25; y++) {
    for (let x = 21; x < 28; x++) terrain[y][x] = 'water';
  }
  const { result, instance } = openGame({
    game: makeGame({ terrain }),
    placement: { originX: 21, originY: 19 }
  });

  assert.equal(result.ok, false);
  assert.match(result.message, /open ground/i);
  assert.equal(instance.phase, PHASES.IDLE);
});

test('render draws only on the ground layer with world coordinates', () => {
  const { instance } = openGame();
  instance.grid[5][0] = 0;
  instance.grid[4][0] = 1;
  instance.lastMove = { row: 4, column: 0, seat: 1 };
  instance.turn = 0;

  const calls = [];
  const ctx = {
    save: () => calls.push('save'),
    restore: () => calls.push('restore'),
    fillRect: (...args) => calls.push(['fillRect', ...args]),
    strokeRect: (...args) => calls.push(['strokeRect', ...args]),
    beginPath: () => calls.push('beginPath'),
    arc: (...args) => calls.push(['arc', ...args]),
    fill: () => calls.push('fill'),
    stroke: () => calls.push('stroke'),
    fillText: (...args) => calls.push(['fillText', ...args])
  };

  assert.equal(instance.render(ctx, 'ground', { tileSize: 48 }), true);
  assert.ok(calls.some(call => Array.isArray(call) && call[0] === 'fillRect'));
  const arcs = calls.filter(call => Array.isArray(call) && call[0] === 'arc');
  assert.equal(arcs.length, CONNECT_FOUR_COLUMNS * CONNECT_FOUR_ROWS + 1);
  // World coordinates: first board rect starts at originX * 48.
  assert.ok(calls.some(call => Array.isArray(call) && call[0] === 'fillRect'
    && call[1] === instance.placement.originX * 48));
  assert.ok(calls.some(call => Array.isArray(call) && call[0] === 'fillText'
    && String(call[1]).includes('turn')));

  const before = calls.length;
  assert.equal(instance.render(ctx, 'object', { tileSize: 48 }), false);
  assert.equal(instance.render(ctx, 'overlay', { tileSize: 48 }), false);
  assert.equal(calls.length, before);
});

test('close delegates to the base close result', () => {
  const { instance, player, npc } = openGame();
  const result = instance.close({ reason: 'test' });

  assert.equal(result.events[0].type, 'closed');
  assert.equal(result.events[0].reason, 'test');
  assert.equal(instance.phase, PHASES.CLOSING);
  assert.equal(instance.active, false);
  assert.equal(player.inMiniGame, true); // host's releaseSession owns cleanup
  assert.equal(npc.inMiniGame, true);
});
