import test from 'node:test';
import assert from 'node:assert/strict';
import { TicTacToeMiniGame } from '../../src/games/tic-tac-toe.js';
import { CheckersMiniGame } from '../../src/games/checkers.js';
import { ChessMiniGame } from '../../src/games/chess.js';
import { MemoryGridGame } from '../../src/games/memory-grid.js';
import { ConnectFourGame } from '../../src/games/connect-four.js';
import { PHASES } from '../../src/minigames/contract.js';
import data from '../../data/minigames.json' with { type: 'json' };

const metas = data.miniGames;

const terrain = Array.from({ length: 64 }, () => Array.from({ length: 64 }, () => 'grass'));

function makeWorld() {
  return {
    terrain,
    player: { id: 'player', name: 'You', x: 10, y: 10, direction: 0, moving: false, path: [] },
    npcs: [],
    companions: [],
    getCompanionsFor: () => [],
    triggerCheer: () => {}
  };
}

function legacyGame(Class, id) {
  const rejects = [];
  const world = makeWorld();
  const instance = new Class({
    game: world,
    onToast: () => {},
    onReject: payload => rejects.push(payload.reason),
    onGameEnd: () => {},
    onAbandonPrompt: () => {}
  });
  instance.activeBoard = {
    originX: 10,
    originY: 10,
    status: 'playing',
    turn: 'player',
    winner: null,
    opponent: { id: 'npc-1', name: 'Fern', x: 20, y: 10, path: [] },
    grid: Array(9).fill(null),
    pieces: Array(64).fill(null),
    engine: null,
    thinkingTimer: 0,
    multiJumpFrom: null,
    sidelineX: 18,
    sidelineY: 13,
    playerSidelineX: 9,
    playerSidelineY: 13,
    animatingPiece: null
  };
  instance.walkOpponentToSideline = () => {};
  return { instance, world, rejects, id };
}

test('tic-tac-toe reports typed reasons for occupied, off-square, and not-turn', () => {
  const { instance, world, rejects } = legacyGame(TicTacToeMiniGame, 'tic-tac-toe');
  instance.activeBoard.grid[0] = 'O';

  world.player.x = 50;
  world.player.y = 50;
  assert.equal(instance.handleAction(world.player), false);
  assert.deepEqual(rejects, ['off-square']);

  world.player.x = 10;
  world.player.y = 10;
  assert.equal(instance.handleAction(world.player), false);
  assert.deepEqual(rejects, ['off-square', 'occupied']);

  instance.activeBoard.turn = 'opponent';
  instance.handleAction(world.player);
  assert.deepEqual(rejects, ['off-square', 'occupied', 'not-turn']);
});

test('checkers and chess reject off-square play and out-of-turn play by reason', () => {
  for (const [Class, id] of [[CheckersMiniGame, 'checkers'], [ChessMiniGame, 'chess']]) {
    const { instance, world, rejects } = legacyGame(Class, id);

    world.player.x = 50;
    world.player.y = 50;
    assert.equal(instance.handleAction(world.player), false, `${id} off-square`);
    assert.deepEqual(rejects, ['off-square'], id);

    world.player.x = 10;
    world.player.y = 10;
    instance.activeBoard.turn = 'opponent';
    assert.equal(instance.handleAction(world.player), false, `${id} not-turn`);
    assert.deepEqual(rejects, ['off-square', 'not-turn'], id);
  }
});

test('legacy target checks mark empty, occupied, and off-board tiles', () => {
  for (const [Class, id] of [[TicTacToeMiniGame, 'tic-tac-toe'], [CheckersMiniGame, 'checkers']]) {
    const { instance } = legacyGame(Class, id);
    const target = instance.describeTarget({ x: 10, y: 10 });
    assert.deepEqual(target.tile, { x: 10, y: 10 }, id);
    assert.equal(typeof target.valid, 'boolean', id);
    assert.equal(instance.describeTarget({ x: 40, y: 40 }).valid, false, id);
    assert.equal(instance.describeTarget(null), null, id);
  }

  const { instance: chess } = legacyGame(ChessMiniGame, 'chess');
  // No engine yet: the game still maps a tile but says nothing is valid.
  assert.equal(chess.describeTarget({ x: 40, y: 40 }).valid, false);
});

test('memory-grid rejects the wrong turn, an off-square press, and a taken card', () => {
  const game = new MemoryGridGame({ meta: metas['memory-grid'], game: makeWorld() });
  game.active = true;
  game.phase = PHASES.PLAYING;
  game.placement = { originX: 10, originY: 10 };
  game.cards = Array.from({ length: 16 }, (_, index) => ({ id: index, symbol: `s${index}` }));
  game.faceUp = [];
  game.turnSeat = 0;
  game.revealTimer = 0;

  const press = tile => game.handleInput({ type: 'action', seat: 0, controller: 'human', tile });
  const reasons = result => result.events.filter(event => event.type === 'reject').map(event => event.reason);

  game.turnSeat = 1;
  assert.deepEqual(reasons(press({ x: 10, y: 10 })), ['not-turn']);
  game.turnSeat = 0;
  assert.deepEqual(reasons(press({ x: 40, y: 40 })), ['off-square']);
  game.faceUp = [0];
  assert.deepEqual(reasons(press({ x: 10, y: 10 })), ['occupied']);

  // AI presses stay silent so the strip never blames the player.
  game.turnSeat = 1;
  const aiPress = game.handleInput({
    type: 'action',
    seat: 1,
    controller: 'ai',
    tile: { x: 10, y: 10 }
  });
  assert.deepEqual(aiPress.events, []);
});

test('connect-four rejects the wrong turn, an off-square press, and a full column', () => {
  const game = new ConnectFourGame({ meta: metas['connect-four'], game: makeWorld() });
  game.active = true;
  game.phase = PHASES.PLAYING;
  game.placement = { originX: 10, originY: 10 };
  game.grid = Array.from({ length: 6 }, () => Array(7).fill(null));
  game.moveCount = 0;
  game.turn = 0;
  game.finished = false;
  game.fallingDisc = null;
  game.seatEntries = [];

  const press = tile => game.handleInput({ type: 'action', seat: 0, controller: 'human', tile });
  const reasons = result => result.events.filter(event => event.type === 'reject').map(event => event.reason);

  game.turn = 1;
  assert.deepEqual(reasons(press({ x: 10, y: 10 })), ['not-turn']);
  game.turn = 0;
  assert.deepEqual(reasons(press({ x: 40, y: 40 })), ['off-square']);
  for (let row = 0; row < 6; row++) game.grid[row][0] = row % 2;
  assert.deepEqual(reasons(press({ x: 10, y: 10 })), ['occupied']);

  game.turn = 0;
  assert.equal(game.describeTarget({ x: 10, y: 10 }).valid, false);
  assert.equal(game.describeTarget({ x: 11, y: 10 }).valid, true);
  assert.equal(game.describeTarget({ x: 40, y: 40 }).valid, false);
  assert.equal(game.describeTarget(null), null);
});

test('memory-grid describes status and target validity from its own rules', () => {
  const game = new MemoryGridGame({ meta: metas['memory-grid'], game: makeWorld() });
  game.active = true;
  game.phase = PHASES.PLAYING;
  game.placement = { originX: 10, originY: 10 };
  game.cards = Array.from({ length: 16 }, (_, index) => ({ id: index, symbol: `s${index}` }));
  game.faceUp = [];
  game.turnSeat = 1;

  assert.deepEqual(game.describeStatus(), {
    turnSeat: 1,
    instruction: metas['memory-grid'].strip.instruction
  });
  assert.equal(game.describeTarget({ x: 10, y: 10 }).valid, true);
  game.faceUp = [0];
  assert.equal(game.describeTarget({ x: 10, y: 10 }).valid, false);
  assert.equal(game.describeTarget({ x: 40, y: 40 }).valid, false);
});
