import test from 'node:test';
import assert from 'node:assert/strict';
import { MiniGameBase, PHASES } from '../src/minigames/contract.js';
import { MiniGameHost } from '../src/minigames/host.js';
import { mulberry32 } from '../src/world.js';
import {
  MemoryGridGame,
  createMemoryGridGame,
  MEMORY_GRID_CARDS,
  MEMORY_GRID_PAIRS,
  MEMORY_SYMBOLS
} from '../src/games/memory-grid.js';

const META = {
  id: 'memory-grid',
  title: 'Memory Grid',
  kind: 'board',
  itemId: 'memory-grid',
  dialogueKey: 'memory-grid',
  rewardKey: 'memory-grid',
  players: 2,
  seats: 2,
  board: { width: 4, height: 4, margin: 1, blocksMovement: true, hiddenZones: [] },
  input: { mode: 'tile', actionLabel: 'flip' },
  renderLayers: ['ground'],
  timing: { openMs: 0, closeMs: 0, turnMs: 0 },
  persist: false,
  activity: 'turn-based'
};

function makeTerrain() {
  return Array.from({ length: 64 }, () => Array.from({ length: 64 }, () => 'grass'));
}

function makeWorld(overrides = {}) {
  const terrain = overrides.terrain === undefined ? makeTerrain() : overrides.terrain;
  const player = {
    id: 'player', name: 'You', x: 20, y: 20, direction: 0, moving: false, path: []
  };
  const npc = {
    id: 'npc-1', name: 'Fern', x: 24, y: 20, direction: 0, moving: false, path: []
  };
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
    fetchTarget: null
  };
  const world = {
    terrain,
    player,
    npcs: [npc],
    companions: [companion],
    getCompanionsFor: id => (id === 'player' ? [companion] : []),
    ...overrides.world
  };
  return { world, player, npc, companion };
}

function newGame(world, options = {}) {
  return new MemoryGridGame({ meta: META, game: world, options });
}

function openGame(info, options = {}) {
  const game = newGame(info.world, options);
  const result = game.open({
    seats: [{ character: info.player }, { character: info.npc }],
    placement: { originX: 10, originY: 10 },
    options
  });
  return { game, result };
}

function standOn(game, character, index) {
  const tile = game.tileForIndex(index);
  character.x = tile.x;
  character.y = tile.y;
  character.moving = false;
  character.path = [];
  character.miniGameTarget = { x: tile.x, y: tile.y };
  return tile;
}

function flip(game, info, seat, index) {
  const character = seat === 0 ? info.player : info.npc;
  standOn(game, character, index);
  return game.handleInput({ type: 'action', character, seat, tile: { x: character.x, y: character.y } });
}

function fakeCtx() {
  const calls = [];
  return new Proxy({ calls }, {
    get(target, prop) {
      if (prop === 'calls') return calls;
      if (prop in target) return target[prop];
      return (...args) => {
        calls.push([prop, ...args]);
      };
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    }
  });
}

test('memory grid extends the contract base and builds a 16-card, 8-pair deck', () => {
  const info = makeWorld();
  const game = createMemoryGridGame({ meta: META, game: info.world, options: { rng: mulberry32(1) } });
  assert.ok(game instanceof MiniGameBase);
  assert.equal(game.id, 'memory-grid');
  assert.equal(game.phase, PHASES.IDLE);
  assert.equal(game.cards.length, 0);

  const opened = game.open({
    seats: [{ character: info.player }, { character: info.npc }],
    placement: { originX: 10, originY: 10 }
  });
  assert.equal(opened.ok, true);
  assert.equal(game.phase, PHASES.PLAYING);

  assert.equal(game.cards.length, MEMORY_GRID_CARDS);
  assert.equal(game.cards.length, 16);
  assert.equal(MEMORY_GRID_PAIRS, 8);

  const counts = new Map();
  for (const card of game.cards) {
    counts.set(card.symbol, (counts.get(card.symbol) || 0) + 1);
    assert.equal(card.matched, false);
  }
  assert.equal(counts.size, 8);
  for (const symbol of MEMORY_SYMBOLS) assert.equal(counts.get(symbol), 2);

  const pairCounts = new Map();
  for (const card of game.cards) {
    pairCounts.set(card.pairId, (pairCounts.get(card.pairId) || 0) + 1);
  }
  assert.equal(pairCounts.size, 8);
  for (const count of pairCounts.values()) assert.equal(count, 2);
});

test('a seeded RNG produces a reproducible shuffle', () => {
  const info = makeWorld();
  const build = seed => {
    const game = newGame(info.world, { rng: mulberry32(seed) });
    game.open({
      seats: [{ character: info.player }, { character: info.npc }],
      placement: { originX: 10, originY: 10 }
    });
    return game.cards.map(card => card.symbol).join(',');
  };

  assert.equal(build(1234), build(1234));
  assert.notEqual(build(1234), build(4321));
});

test('tile to card mapping covers the 4x4 board and rejects off-board tiles', () => {
  const info = makeWorld();
  const game = newGame(info.world, { rng: mulberry32(2) });
  assert.equal(game.cellAtTile(10, 10), null, 'no board before open');

  game.open({
    seats: [{ character: info.player }, { character: info.npc }],
    placement: { originX: 10, originY: 10 }
  });

  assert.deepEqual(game.cellAtTile(10, 10), { row: 0, col: 0, index: 0 });
  assert.deepEqual(game.cellAtTile(11, 11), { row: 1, col: 1, index: 5 });
  assert.deepEqual(game.cellAtTile(13, 13), { row: 3, col: 3, index: 15 });
  assert.deepEqual(game.tileForIndex(0), { x: 10, y: 10 });
  assert.deepEqual(game.tileForIndex(5), { x: 11, y: 11 });
  assert.deepEqual(game.tileForIndex(15), { x: 13, y: 13 });

  assert.equal(game.cellAtTile(14, 10), null);
  assert.equal(game.cellAtTile(10, 14), null);
  assert.equal(game.cellAtTile(9, 9), null);
  assert.equal(game.tileForIndex(16), null);
});

test('open finds a placement around the player and stages both seats', () => {
  const info = makeWorld();
  const game = newGame(info.world, { rng: mulberry32(3) });
  const result = game.open({
    seats: [{ character: info.player }, { character: info.npc }]
  });

  assert.equal(result.ok, true, result.message);
  assert.deepEqual(game.placement, { originX: 21, originY: 19 });
  assert.deepEqual(game.getFootprint(), { x: 21, y: 19, width: 4, height: 4 });
  assert.equal(game.phase, PHASES.PLAYING);

  // Seat 0 / seat 1 anchors sit on the centre row, left and right of the board.
  assert.equal(info.player.inMiniGame, true);
  assert.equal(info.npc.inMiniGame, true);
  assert.deepEqual(info.player.miniGameTarget, { x: 20, y: 20 });
  assert.deepEqual(info.npc.miniGameTarget, { x: 25, y: 20 });
  assert.ok(info.npc.path.length > 0, 'seat 1 walks to its anchor');

  // Participant companions are staged as spectators and told to clear fetch.
  assert.equal(info.companion.inMiniGame, true);
  assert.equal(info.companion.fetchTarget, null);
  assert.deepEqual(info.companion.stagedDestination, { x: 20, y: 21 });
});

test('open fails cleanly without ground and rejects an unwalkable explicit origin', () => {
  const dry = makeWorld({ terrain: null });
  const noGround = newGame(dry.world, { rng: mulberry32(4) });
  const failed = noGround.open({
    seats: [{ character: dry.player }, { character: dry.npc }]
  });
  assert.equal(failed.ok, false);
  assert.match(failed.message, /open ground/i);
  assert.equal(failed.phase, PHASES.IDLE);
  assert.equal(noGround.active, false);
  assert.equal(noGround.getFootprint(), null);
  assert.equal(noGround.render(fakeCtx(), 'ground', { tileSize: 32 }), false);

  const wet = makeWorld();
  wet.world.terrain[10][10] = 'water';
  const wetGame = newGame(wet.world, { rng: mulberry32(4) });
  const rejected = wetGame.open({
    seats: [{ character: wet.player }, { character: wet.npc }],
    placement: { originX: 10, originY: 10 }
  });
  assert.equal(rejected.ok, false);
  assert.match(rejected.message, /open ground/i);
  assert.equal(wetGame.phase, PHASES.IDLE);
});

test('input ignores the wrong seat, matched cards, face-up cards, and reveal time', () => {
  const info = makeWorld();
  const { game } = openGame(info, { rng: mulberry32(5) });
  game.turnSeat = 0;
  game.cards[0].symbol = 'leaf';
  game.cards[1].symbol = 'acorn';
  game.cards[3].matched = true;

  // Seat 1 cannot act on seat 0's turn.
  assert.equal(flip(game, info, 1, 2).handled, false);
  assert.deepEqual(game.faceUp, []);

  // A matched card cannot be flipped.
  assert.equal(flip(game, info, 0, 3).handled, false);
  assert.deepEqual(game.faceUp, []);

  // First card flips.
  assert.equal(flip(game, info, 0, 0).handled, true);
  assert.deepEqual(game.faceUp, [0]);

  // The same face-up card cannot be picked again.
  assert.equal(flip(game, info, 0, 0).handled, false);
  assert.deepEqual(game.faceUp, [0]);

  // Second card mismatches and starts the reveal beat.
  assert.equal(flip(game, info, 0, 1).handled, true);
  assert.deepEqual(game.faceUp, [0, 1]);
  assert.ok(game.revealTimer > 0);
  assert.equal(game.turnSeat, 0);

  // Input is ignored while the mismatch is visible.
  assert.equal(flip(game, info, 0, 2).handled, false);
  assert.deepEqual(game.faceUp, [0, 1]);

  game.update(4000);
  assert.equal(game.turnSeat, 1);
  assert.deepEqual(game.faceUp, []);
});

test('a match scores a pair and keeps the turn', () => {
  const info = makeWorld();
  const { game } = openGame(info, { rng: mulberry32(6) });
  game.turnSeat = 0;
  game.cards[0].symbol = 'star';
  game.cards[1].symbol = 'star';

  assert.equal(flip(game, info, 0, 0).handled, true);
  assert.equal(flip(game, info, 0, 1).handled, true);

  assert.deepEqual(game.scores, [1, 0]);
  assert.equal(game.turnSeat, 0);
  assert.deepEqual(game.faceUp, []);
  assert.equal(game.revealTimer, 0);
  assert.equal(game.cards[0].matched, true);
  assert.equal(game.cards[1].matched, true);

  // Matched cards stay put and cannot be selected again.
  assert.equal(flip(game, info, 0, 0).handled, false);
});

test('a mismatch holds both cards for ~3 seconds, then flips back and switches seats', () => {
  const info = makeWorld();
  const { game } = openGame(info, { rng: mulberry32(7) });
  game.turnSeat = 0;
  game.cards[0].symbol = 'leaf';
  game.cards[1].symbol = 'gem';

  flip(game, info, 0, 0);
  flip(game, info, 0, 1);
  assert.equal(game.revealTimer, 3000);
  assert.equal(game.scores[0], 0);

  const mid = game.update(1000);
  assert.equal(mid.handled, true);
  assert.equal(game.revealTimer, 2000);
  assert.deepEqual(game.faceUp, [0, 1]);
  assert.equal(game.turnSeat, 0);

  game.update(2000);
  assert.equal(game.revealTimer, 0);
  assert.deepEqual(game.faceUp, []);
  assert.equal(game.cards[0].matched, false);
  assert.equal(game.cards[1].matched, false);
  assert.equal(game.turnSeat, 1);
});

test('a zero-length reveal beat flips back and passes the turn immediately', () => {
  const info = makeWorld();
  const { game } = openGame(info, { rng: mulberry32(16), mismatchMs: 0 });
  game.cards[0].symbol = 'leaf';
  game.cards[1].symbol = 'gem';
  game.turnSeat = 0;

  flip(game, info, 0, 0);
  flip(game, info, 0, 1);

  assert.deepEqual(game.faceUp, []);
  assert.equal(game.revealTimer, 0);
  assert.equal(game.turnSeat, 1);
  assert.deepEqual(game.scores, [0, 0]);
});

test('finishing all pairs emits one finish event with the higher-scoring seat', () => {
  const info = makeWorld();
  const { game } = openGame(info, { rng: mulberry32(8) });
  for (let index = 0; index < 14; index++) game.cards[index].matched = true;
  game.cards[14].symbol = 'gem';
  game.cards[15].symbol = 'gem';
  game.scores = [7, 0];
  game.turnSeat = 0;

  flip(game, info, 0, 14);
  const result = flip(game, info, 0, 15);

  assert.deepEqual(game.scores, [8, 0]);
  assert.equal(game.cards.every(card => card.matched), true);
  assert.equal(game.phase, PHASES.ENDING);
  assert.equal(game.finished, true);
  assert.equal(game.winnerSeat, 0);

  const finishes = result.events.filter(event => event.type === 'finish');
  assert.equal(finishes.length, 1);
  assert.equal(finishes[0].winnerSeat, 0);

  // Further input is ignored once the game is over.
  assert.equal(flip(game, info, 0, 0).handled, false);
});

test('an even final score finishes as a draw', () => {
  const info = makeWorld();
  const { game } = openGame(info, { rng: mulberry32(9) });
  for (let index = 0; index < 14; index++) game.cards[index].matched = true;
  game.cards[14].symbol = 'drop';
  game.cards[15].symbol = 'drop';
  game.scores = [3, 4];
  game.turnSeat = 0;

  flip(game, info, 0, 14);
  const result = flip(game, info, 0, 15);

  assert.deepEqual(game.scores, [4, 4]);
  assert.equal(game.winnerSeat, null);
  const finish = result.events.find(event => event.type === 'finish');
  assert.ok(finish);
  assert.equal(finish.winnerSeat, null);
});

test('AI takes a known pair, including the partner of the face-up card', () => {
  const info = makeWorld();
  const { game } = openGame(info, { rng: mulberry32(10) });
  game.turnSeat = 1;
  game.aiMemory.set(0, 'shell');
  game.aiMemory.set(5, 'shell');

  const first = game.chooseAiCard(1);
  assert.ok(first === 0 || first === 5, `expected a known pair card, got ${first}`);

  game.faceUp = [5];
  assert.equal(game.chooseAiCard(1), 0);
});

test('AI prefers unseen cards when it has no known pair', () => {
  const info = makeWorld();
  const { game } = openGame(info, { rng: mulberry32(11) });
  game.turnSeat = 1;
  game.aiMemory.set(2, 'gem');

  const choice = game.chooseAiCard(1);
  assert.equal(Number.isInteger(choice), true);
  assert.notEqual(choice, 2, 'a lone known card is not worth re-flipping');

  // With every card known but no pair recorded, it still picks a valid unmatched card.
  for (let index = 0; index < game.cards.length; index++) {
    game.aiMemory.set(index, `unique-${index}`);
  }
  const fallback = game.chooseAiCard(1);
  assert.ok(fallback >= 0 && fallback < MEMORY_GRID_CARDS);
  assert.equal(game.cards[fallback].matched, false);
});

test('AI walks to its chosen card and flips through the normal input handler', () => {
  const info = makeWorld();
  const { game } = openGame(info, { rng: mulberry32(12) });
  game.turnSeat = 1;
  info.npc.path = [];
  info.npc.moving = false;

  const step = game.update(0);
  assert.equal(step.handled, true);
  assert.ok(game.aiTarget, 'AI chose a card');
  assert.equal(info.npc.inMiniGame, true);
  assert.deepEqual(info.npc.miniGameTarget, { x: game.aiTarget.x, y: game.aiTarget.y });
  assert.ok(info.npc.path.length > 0, 'AI walks across the grass');

  const target = { ...game.aiTarget };
  info.npc.x = target.x;
  info.npc.y = target.y;
  info.npc.path = [];
  info.npc.moving = false;

  const flipped = game.update(0);
  assert.equal(flipped.changed, true);
  assert.deepEqual(game.faceUp, [target.index]);
  assert.equal(info.npc.miniGameTarget, null);
});

test('AI places itself on the card when no walkable path exists', () => {
  const info = makeWorld({ terrain: null });
  const game = newGame(info.world, { rng: mulberry32(13) });
  const opened = game.open({
    seats: [{ character: info.player }, { character: info.npc }],
    placement: { originX: 10, originY: 10 }
  });
  assert.equal(opened.ok, true, opened.message);

  game.turnSeat = 1;
  info.npc.path = [];
  info.npc.moving = false;
  game.update(0);

  const target = game.aiTarget;
  assert.ok(target);
  assert.deepEqual({ x: info.npc.x, y: info.npc.y }, { x: target.x, y: target.y });

  game.update(0);
  assert.deepEqual(game.faceUp, [target.index]);
});

test('render draws the board on the ground layer only', () => {
  const info = makeWorld();
  const { game } = openGame(info, { rng: mulberry32(14) });

  const ctx = fakeCtx();
  assert.equal(game.render(ctx, 'ground', { tileSize: 32 }), true);
  assert.ok(ctx.calls.some(call => call[0] === 'fillRect'));
  assert.ok(ctx.calls.some(call => call[0] === 'fillText'));

  for (const layer of ['object', 'overlay', 'hud']) {
    assert.equal(game.render(ctx, layer, { tileSize: 32 }), false, `${layer} stays untouched`);
  }
});

test('close delegates to the contract base and drops the footprint', () => {
  const info = makeWorld();
  const { game } = openGame(info, { rng: mulberry32(15) });
  const result = game.close({ reason: 'packed-up' });

  assert.equal(result.events[0].type, 'closed');
  assert.equal(result.events[0].reason, 'packed-up');
  assert.equal(game.phase, PHASES.CLOSING);
  assert.equal(game.active, false);
  assert.equal(game.getFootprint(), null);
});

test('the host registers, opens, and packs up the game through the factory', () => {
  const info = makeWorld();
  const host = new MiniGameHost({ game: info.world });
  const registered = host.register({ meta: META, create: createMemoryGridGame });
  assert.equal(registered.ok, true);

  const started = host.start('memory-grid', {
    seats: [{ character: info.player }, { character: info.npc }],
    terrain: info.world.terrain
  });
  assert.equal(started.ok, true, started.message);
  assert.equal(host.activeGameId, 'memory-grid');
  assert.ok(host.session.game instanceof MemoryGridGame);
  assert.equal(host.session.game.phase, PHASES.PLAYING);
  assert.deepEqual(host.session.game.getFootprint(), { x: 21, y: 19, width: 4, height: 4 });
  assert.equal(host.isTileOnBoard(21, 19), true);

  const packed = host.packUp();
  assert.equal(packed.ok, true);
  assert.equal(host.isOpen(), false);
  assert.equal(info.player.inMiniGame, false);
  assert.equal(info.npc.inMiniGame, false);
});

test('walking away opens the abandon prompt and cancel walks the player back', () => {
  const info = makeWorld();
  let prompt = null;
  const { game } = openGame(info, {
    onAbandonPrompt: (confirm, cancel) => { prompt = { confirm, cancel }; }
  });
  info.player.x = 30;
  info.player.y = 30;
  game.update(16);
  assert.ok(prompt, 'abandon prompt should fire away from the board');
  prompt.cancel();
  assert.equal(game.abandonPromptActive, false);
  assert.equal(game.returningToBoard, true);
  assert.ok(info.player.path.length > 0, 'player should walk back to the seat');
});
