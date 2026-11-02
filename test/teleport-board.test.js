import test from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../src/game.js';

function makeGame() {
  const game = new Game();
  game.terrain = Array.from({ length: 64 }, () => Array.from({ length: 64 }, () => 'grass'));
  game.player = { id: 'player', x: 10, y: 10, direction: 1, moving: false };
  game.npcs = [];
  game.companions = [];
  game.homeBlockedTiles = new Set();
  game.miniGames = [];
  game.resolveFxFor = () => ({ motionId: 'teleport', motion: { distance: 3, blinkMs: 120 } });
  return game;
}

test('teleport blinks up to three tiles on the map', () => {
  const game = makeGame();
  assert.equal(game.tryStep(game.player, 1, 0, 0.18), true);
  assert.equal(game.player.motionStyle, 'teleport');
  assert.equal(game.player.toX, 13);
  assert.equal(game.player.toY, 10);
});

test('teleport is suppressed for a mini-game participant', () => {
  const game = makeGame();
  game.miniGameHost = {
    isOpen: () => true,
    isParticipant: () => true,
    blocksStep: () => false,
    getBlockedTiles: () => new Set()
  };
  game.player.inMiniGame = true;
  assert.equal(game.tryStep(game.player, 1, 0, 0.18), true);
  assert.notEqual(game.player.motionStyle, 'teleport');
  assert.equal(game.player.toX, 11);
});

test('teleport cannot land on a board the character may not enter', () => {
  const game = makeGame();
  game.miniGameHost = {
    isOpen: () => true,
    isParticipant: () => false,
    blocksStep: (character, x) => x >= 11,
    getBlockedTiles: () => new Set(['11,10', '12,10', '13,10'])
  };
  assert.equal(game.tryStep(game.player, 1, 0, 0.18), false);
  assert.equal(game.player.moving, false);
});
