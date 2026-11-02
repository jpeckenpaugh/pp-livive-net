import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SnakesLaddersGame,
  createSnakesLaddersGame,
  normalizeSnakesLaddersData,
  SNAKES_LADDERS_DICE,
  SNAKES_LADDERS_SQUARES
} from '../src/games/snakes-ladders.js';
import { MiniGameHost } from '../src/minigames/host.js';
import { registerContractGames } from '../src/games/contract-adapters.js';
import { PHASES } from '../src/minigames/contract.js';
import { settleGame } from '../src/minigames/settlement.js';
import miniGamesData from '../data/minigames.json' with { type: 'json' };
import boardData from '../data/snakes-ladders.json' with { type: 'json' };

const META = miniGamesData.miniGames['snakes-ladders'];

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
  const options = {
    stepMs: 0,
    aiDelayMs: 1000,
    rng: () => 0,
    ...(context.options || {})
  };
  const instance = new SnakesLaddersGame({
    meta: context.meta || META,
    game,
    options
  });
  const result = instance.open({
    seats: context.seats || [
      { character: player, controller: 'human' },
      { character: npc, controller: 'ai' }
    ],
    placement: context.placement || { originX: 10, originY: 10 },
    options
  });
  return { instance, game, player, npc, result };
}

function action(instance, seat = 0) {
  const character = instance.seatCharacters[seat];
  return instance.handleInput({
    type: 'action',
    action: 'primary',
    seat,
    controller: seat === 0 ? 'human' : 'ai',
    character,
    tile: { x: character.x, y: character.y }
  });
}

test('opens a 10×10 race board with both seats at the start', () => {
  const companion = { ...makeCharacter('buddy', 17, 20, 'Pip'), buddyId: 'player' };
  const { instance, player, npc, result } = openGame({ companions: [companion] });

  assert.equal(result.ok, true);
  assert.equal(instance.phase, PHASES.PLAYING);
  assert.deepEqual(instance.positions, [0, 0]);
  assert.equal(instance.turn, 0);
  assert.deepEqual(instance.placement, { originX: 10, originY: 10 });
  assert.deepEqual(instance.getFootprint(), { x: 10, y: 10, width: 10, height: 10 });
  assert.equal(player.inMiniGame, true);
  assert.equal(npc.inMiniGame, true);
  assert.equal(companion.inMiniGame, true);
});

test('the serpentine route maps squares to tiles and back', () => {
  const { instance } = openGame();

  assert.deepEqual(instance.squarePosition(0), { x: 9, y: 19 });
  assert.deepEqual(instance.squarePosition(1), { x: 10, y: 19 });
  assert.deepEqual(instance.squarePosition(10), { x: 19, y: 19 });
  assert.deepEqual(instance.squarePosition(11), { x: 19, y: 18 });
  assert.deepEqual(instance.squarePosition(20), { x: 10, y: 18 });
  assert.deepEqual(instance.squarePosition(100), { x: 10, y: 10 });

  for (let square = 1; square <= SNAKES_LADDERS_SQUARES; square++) {
    const tile = instance.squarePosition(square);
    assert.equal(instance.squareAtTile(tile.x, tile.y), square);
  }
  assert.equal(instance.squareAtTile(9, 19), null);
  assert.equal(instance.squareAtTile(20, 10), null);
});

test('the die always lands on a whole number from 1 to 6', () => {
  const observed = new Set();
  for (let index = 0; index < 600; index++) {
    const { instance } = openGame({ options: { rng: () => index / 600 } });
    const value = instance.rollDice();
    assert.ok(Number.isInteger(value));
    assert.ok(value >= 1 && value <= SNAKES_LADDERS_DICE);
    observed.add(value);
  }
  assert.deepEqual([...observed].sort(), [1, 2, 3, 4, 5, 6]);
});

test('the token walks square by square before the turn passes', () => {
  const { instance } = openGame({
    options: {
      rng: () => 0.34, // 3
      stepMs: 100,
      aiDelayMs: 100000
    }
  });

  const rolled = action(instance);
  assert.equal(rolled.handled, true);
  assert.equal(instance.lastRoll, 3);
  assert.deepEqual(instance.positions, [0, 0]);
  assert.equal(instance.turn, 0);
  assert.ok(instance.motion);

  instance.update(99);
  assert.deepEqual(instance.positions, [0, 0]);
  instance.update(1);
  assert.deepEqual(instance.positions, [1, 0]);
  instance.update(100);
  assert.deepEqual(instance.positions, [2, 0]);
  assert.equal(instance.turn, 0);

  const landed = instance.update(100);
  assert.deepEqual(instance.positions, [3, 0]);
  assert.equal(instance.turn, 1);
  assert.equal(instance.motion, null);
  assert.ok(landed.events.some(event => event.type === 'turn' && event.seat === 1));
});

test('a roll that would overshoot 100 stays put and passes the turn', () => {
  const { instance } = openGame({ options: { rng: () => 0.5 } }); // 4
  instance.positions[0] = 98;

  const result = action(instance);
  assert.equal(result.handled, true);
  assert.equal(instance.lastRoll, 4);
  assert.deepEqual(instance.positions, [98, 0]);
  assert.equal(instance.turn, 1);
  assert.equal(instance.motion, null);
  const roll = result.events.find(event => event.type === 'roll');
  assert.equal(roll.overshoot, true);
  assert.equal(roll.to, 98);
});

test('landing on a snake slides the token down', () => {
  const { instance } = openGame({ options: { rng: () => 0.4 } }); // 3
  instance.positions[0] = 13;

  const result = action(instance);
  instance.update(0);

  assert.deepEqual(instance.positions, [6, 0]);
  assert.equal(instance.lastTransition.kind, 'snake');
  assert.equal(instance.lastTransition.from, 16);
  assert.equal(instance.lastTransition.to, 6);
  assert.equal(instance.turn, 1);
  assert.ok(result.events.some(event => event.type === 'roll'));
});

test('landing on a ladder climbs the token up', () => {
  const { instance } = openGame({ options: { rng: () => 0.4 } }); // 3
  instance.positions[0] = 6;

  action(instance);
  const result = instance.update(0);

  assert.deepEqual(instance.positions, [31, 0]);
  assert.equal(instance.lastTransition.kind, 'ladder');
  assert.equal(instance.lastTransition.from, 9);
  assert.equal(instance.lastTransition.to, 31);
  assert.ok(result.events.some(event => event.type === 'slide' && event.kind === 'ladder'));
});

test('exact landing on 100 wins and emits one finish event', () => {
  const { instance } = openGame({ options: { rng: () => 0.4 } }); // 3
  instance.positions[0] = 97;

  action(instance);
  const result = instance.update(0);

  assert.equal(instance.finished, true);
  assert.equal(instance.winnerSeat, 0);
  assert.equal(instance.turn, null);
  assert.equal(instance.phase, PHASES.ENDING);
  assert.deepEqual(instance.positions, [100, 0]);
  const finishes = result.events.filter(event => event.type === 'finish');
  assert.equal(finishes.length, 1);
  assert.equal(finishes[0].winnerSeat, 0);
});

test('a ladder onto 100 also wins', () => {
  const { instance } = openGame({ options: { rng: () => 0.4 } }); // 3
  instance.positions[0] = 77;

  action(instance);
  instance.update(0);

  assert.equal(instance.finished, true);
  assert.equal(instance.winnerSeat, 0);
  assert.equal(instance.positions[0], 100);
});

test('the NPC rolls automatically after the delay and hands the turn back', () => {
  const { instance } = openGame({
    options: {
      rng: () => 0.5, // 4
      stepMs: 0,
      aiDelayMs: 500
    }
  });
  instance.turn = 1;

  const waiting = instance.update(499);
  assert.equal(waiting.handled, false);
  assert.deepEqual(instance.positions, [0, 0]);

  const rolled = instance.update(1);
  assert.equal(rolled.handled, true);
  assert.equal(instance.lastRollSeat, 1);
  assert.equal(instance.lastRoll, 4);

  instance.update(0);
  assert.deepEqual(instance.positions, [0, 14]);
  assert.equal(instance.turn, 0);
  assert.equal(instance.lastTransition.kind, 'ladder');
  assert.equal(instance.lastTransition.from, 4);
  assert.equal(instance.lastTransition.to, 14);
});

test('out-of-turn and mid-move presses are rejected for the human', () => {
  const { instance } = openGame({ options: { stepMs: 100 } });
  instance.turn = 1;
  const outOfTurn = action(instance);
  assert.equal(outOfTurn.events[0].type, 'reject');
  assert.equal(outOfTurn.events[0].reason, 'not-turn');

  instance.turn = 0;
  action(instance);
  const midMove = action(instance);
  assert.equal(midMove.events[0].type, 'reject');
  assert.equal(midMove.events[0].reason, 'illegal');
});

test('status exposes the die, squares, and whose turn it is', () => {
  const { instance } = openGame({ options: { rng: () => 0.4 } });
  const status = instance.describeStatus();
  assert.equal(status.turnSeat, 0);
  assert.match(status.instruction, /\{key\}/);
  assert.match(status.detail, /🎲/);
  assert.match(status.detail, /you start/);

  action(instance);
  const rolling = instance.describeStatus();
  assert.equal(rolling.instruction, null);
  assert.match(rolling.detail, /🎲 3/);
});

test('settlement maps the winner seat to a player-relative outcome', () => {
  const win = settleGame({ meta: META, winnerSeat: 0, seat: 0 });
  assert.equal(win.outcome, 'win');
  assert.equal(win.gameId, 'snakes-ladders');

  const loss = settleGame({ meta: META, winnerSeat: 1, seat: 0 });
  assert.equal(loss.outcome, 'loss');

  let recorded = null;
  settleGame({
    meta: META,
    winnerSeat: 0,
    seat: 0,
    recordGameResult: result => { recorded = result; }
  });
  assert.equal(recorded.result, 'win');
});

test('the host registers and starts snakes-ladders with the shared contract', () => {
  const info = makeGame();
  const host = new MiniGameHost({ game: info });
  const registered = registerContractGames(host, miniGamesData.miniGames);
  assert.ok(registered.some(entry => entry.id === 'snakes-ladders' && entry.ok));

  const started = host.start('snakes-ladders', {
    player: info.player,
    opponent: info.npcs[0],
    placement: { originX: 10, originY: 10 },
    terrain: info.terrain,
    options: { rng: () => 0.4, stepMs: 0 }
  });
  assert.equal(started.ok, true, started.message);
  assert.equal(host.activeGameId, 'snakes-ladders');
  assert.equal(host.getState().phase, PHASES.PLAYING);
  assert.equal(host.getState().turnSeat, 0);
  assert.match(host.getState().detail, /🎲/);

  const result = host.handleAction(info.player);
  assert.equal(result.changed, true);
  assert.equal(host.session.game.motion.remaining, 3);
  assert.ok(host.getTrace().some(entry => entry.action === 'roll'));

  host.packUp();
});

test('render draws the race board only on the ground layer', () => {
  const { instance } = openGame();
  instance.positions = [12, 9];
  instance.lastRoll = 4;

  const calls = [];
  const ctx = {
    save: () => calls.push('save'),
    restore: () => calls.push('restore'),
    fillRect: (...args) => calls.push(['fillRect', ...args]),
    strokeRect: (...args) => calls.push(['strokeRect', ...args]),
    beginPath: () => calls.push('beginPath'),
    closePath: () => calls.push('closePath'),
    moveTo: (...args) => calls.push(['moveTo', ...args]),
    lineTo: (...args) => calls.push(['lineTo', ...args]),
    arc: (...args) => calls.push(['arc', ...args]),
    fill: () => calls.push('fill'),
    stroke: () => calls.push('stroke'),
    fillText: (...args) => calls.push(['fillText', ...args]),
    setLineDash: (...args) => calls.push(['setLineDash', ...args])
  };

  assert.equal(instance.render(ctx, 'ground', { tileSize: 48 }), true);
  assert.ok(calls.some(call => Array.isArray(call) && call[0] === 'fillRect'
    && call[1] === instance.placement.originX * 48));
  assert.ok(calls.some(call => Array.isArray(call) && call[0] === 'fillText'
    && String(call[1]).includes('your turn')));
  assert.ok(calls.some(call => Array.isArray(call) && call[0] === 'fillText'
    && String(call[1]) === '100'));

  const before = calls.length;
  assert.equal(instance.render(ctx, 'object', { tileSize: 48 }), false);
  assert.equal(instance.render(ctx, 'overlay', { tileSize: 48 }), false);
  assert.equal(calls.length, before);
});

test('open finds a nearby clearing when no placement is supplied', () => {
  const info = makeGame();
  const instance = createSnakesLaddersGame({ meta: META, game: info });
  const result = instance.open({
    seats: [
      { character: info.player, controller: 'human' },
      { character: info.npcs[0], controller: 'ai' }
    ]
  });

  assert.equal(result.ok, true, result.message);
  assert.equal(instance.getFootprint().width, 10);
  assert.equal(instance.getFootprint().height, 10);
});

test('open fails cleanly when no clearing fits the board', () => {
  const game = makeGame({ terrain: makeTerrain('water') });
  const instance = createSnakesLaddersGame({ meta: META, game });
  const result = instance.open({
    seats: [
      { character: game.player, controller: 'human' },
      { character: game.npcs[0], controller: 'ai' }
    ]
  });

  assert.equal(result.ok, false);
  assert.equal(instance.phase, PHASES.IDLE);
  assert.match(result.message, /open ground/i);
  assert.equal(instance.getFootprint(), null);
});

test('authored data has unique, in-range snakes and ladders', () => {
  const normalized = normalizeSnakesLaddersData(boardData);
  assert.equal(normalized.size, 10);
  assert.equal(normalized.squares, 100);
  assert.equal(normalized.diceSides, 6);
  assert.ok(normalized.snakes.length >= 5);
  assert.ok(normalized.ladders.length >= 5);

  const starts = new Set();
  for (const entry of normalized.snakes) {
    assert.ok(entry.from > entry.to, `snake ${entry.from} must go down`);
    assert.ok(!starts.has(entry.from), `duplicate transition start ${entry.from}`);
    starts.add(entry.from);
  }
  for (const entry of normalized.ladders) {
    assert.ok(entry.to > entry.from, `ladder ${entry.from} must go up`);
    assert.ok(!starts.has(entry.from), `duplicate transition start ${entry.from}`);
    starts.add(entry.from);
  }
});
