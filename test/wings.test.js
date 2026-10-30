import test from 'node:test';
import assert from 'node:assert/strict';
import { Game, PLAYER_STEP } from '../src/game.js';
import { findPath, WORLD_SIZE } from '../src/world.js';
import { createItemInstance } from '../src/inventory.js';
import { equip, resolveFx, getEffect } from '../src/effects.js';

function waterGrid() {
  return Array.from({ length: WORLD_SIZE }, () => Array.from({ length: WORLD_SIZE }, () => 'grass'));
}

function makeGame() {
  const game = new Game();
  game.terrain = waterGrid();
  // A full pond row splits the map so the only way across is flight.
  for (let x = 0; x < WORLD_SIZE; x++) game.terrain[10][x] = 'water';
  game.canvas = { style: {} };
  game.width = 1024;
  game.height = 768;
  game.camera = { x: 0, y: 0 };
  game.player = game.makeCharacter({
    id: 'player',
    name: 'You',
    x: 10,
    y: 9,
    recipe: { style: 'voxel-art' }
  }, true);
  game.npcs = [];
  game.companions = [];
  game.miniGames = [];
  game.interactive = true;
  return game;
}

function wearWings(character, now = 0) {
  const wings = createItemInstance('wings', { uid: 'wings-0' });
  character.inventory = [wings];
  character.equipped = [];
  return equip(character, wings, now);
}

test('wings data grants flight and uses the flap motion', () => {
  const effect = getEffect('wings');
  assert.ok(effect);
  assert.equal(effect.slot, 'back');
  assert.equal(effect.stats.fly, true);
  assert.equal(effect.motion, 'flap');
  assert.ok(effect.stats.stepDurationScale < 1, 'flight should be a little faster');
});

test('equipping wings turns on the fly ability, unequipping turns it off', () => {
  const game = makeGame();
  const player = game.player;

  assert.deepEqual(resolveFx(player, 1000).abilities, { fly: false });

  assert.equal(wearWings(player, 0).ok, true);
  game.time = 1;
  const fx = resolveFx(player, 1000);
  assert.deepEqual(fx.abilities, { fly: true });
  assert.equal(game.canFly(player), true);

  const removed = player.equipped[0];
  player.equipped = player.equipped.filter(entry => entry !== removed);
  game.time = 2;
  assert.equal(resolveFx(player, 2000).abilities.fly, false);
  assert.equal(game.canFly(player), false);
});

test('flying characters can step onto water, walking characters cannot', () => {
  const game = makeGame();
  const player = game.player;

  assert.equal(game.tryStep(player, 0, 1, PLAYER_STEP), false);
  assert.equal(player.moving, false);

  wearWings(player, 0);
  game.time = 1;
  assert.equal(game.tryStep(player, 0, 1, PLAYER_STEP), true);
  assert.equal(player.moving, true);
  assert.equal(player.toX, 10);
  assert.equal(player.toY, 10);
  assert.ok(player.duration < PLAYER_STEP, 'wings shorten the step clock');

  // Finish the step so the player really stands on the pond.
  player.x = player.toX;
  player.y = player.toY;
  player.moving = false;
  assert.equal(player.x, 10);
  assert.equal(player.y, 10);
});

test('finding a path over water requires the fly option', () => {
  const game = makeGame();
  const grid = game.terrain;
  const from = { x: 10, y: 9 };
  const to = { x: 10, y: 11 };

  assert.deepEqual(findPath(grid, from, to), []);
  assert.deepEqual(findPath(grid, from, to, null, { fly: true }), [
    { x: 10, y: 10 },
    { x: 10, y: 11 }
  ]);
  assert.deepEqual(findPath(grid, from, { x: 10, y: -1 }, null, { fly: true }), []);
});

test('a character stranded on water can wade back out after losing wings', () => {
  const game = makeGame();
  const player = game.player;
  player.x = 10;
  player.y = 10;
  player.equipped = [];

  // Stepping from water onto another water tile is allowed while stranded, so
  // the character is never permanently stuck.
  assert.equal(game.tryStep(player, 1, 0, PLAYER_STEP), true);
  assert.equal(player.toX, 11);
});
