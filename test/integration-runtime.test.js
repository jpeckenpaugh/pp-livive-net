import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Game,
  PLAYER_STEP,
  TILE,
  CHARACTER_HEIGHT,
  characterVisualHeight,
  frameDelta
} from '../src/game.js';
import { PET_HEIGHT } from '../src/renderer.js';

function makeGame() {
  const game = new Game();
  game.terrain = Array.from({ length: 64 }, () => Array.from({ length: 64 }, () => 'grass'));
  game.canvas = { style: {} };
  game.width = 1024;
  game.height = 768;
  game.camera = { x: 0, y: 0 };
  game.player = game.makeCharacter({
    id: 'player',
    name: 'You',
    x: 10,
    y: 10,
    recipe: { style: 'voxel-art' }
  }, true);
  game.npcs = [];
  game.companions = [];
  game.miniGames = [];
  game.interactive = true;
  return game;
}

function equip(character, id, slot, effectId) {
  const uid = `${id}-0`;
  character.inventory = [{ id, uid }];
  character.equipped = [{ slot, uid, itemId: id, effectId }];
  return uid;
}

test('Game delegates board queries, blocking, and updates to MiniGameHost', () => {
  const game = makeGame();
  const blocked = new Set(['10,9']);
  const updateCalls = [];
  const participantCompanion = {
    id: 'comp-a',
    buddyId: 'player',
    isCompanion: true,
    x: 12,
    y: 12
  };
  const host = {
    getBlockedTiles: () => blocked,
    isTileOnBoard: (x, y) => x === 10 && y === 9,
    isParticipant: () => false,
    getParticipantCompanions: () => [participantCompanion],
    blocksStep: (character, nx, ny) => nx === 10 && ny === 9,
    update: dtMs => updateCalls.push(dtMs)
  };
  game.setMiniGameHost(host);

  assert.equal(game.getMiniGameBlockedTiles(), blocked);
  assert.equal(game.isCharacterOnMiniGameBoard({ x: 10, y: 9 }), true);
  assert.equal(game.isCharacterOnMiniGameBoard({ x: 11, y: 9 }), false);
  assert.equal(game.isParticipantCompanion(participantCompanion), true);
  assert.equal(game.isParticipantCompanion({ id: 'other', buddyId: 'player', isCompanion: true }), false);

  assert.equal(game.tryStep(game.player, 0, -1, PLAYER_STEP), false);
  assert.equal(game.player.moving, false);

  game.update(0.02);
  assert.deepEqual(updateCalls, [20]);
});

test('host sessions suppress bump dialogue with seated NPCs', () => {
  const game = makeGame();
  const npc = game.makeCharacter({ id: 'npc-seat', name: 'Seat', x: 11, y: 10 });
  npc.inMiniGame = true;
  game.npcs = [npc];
  game.setMiniGameHost({
    isOpen: () => true,
    blocksStep: () => false,
    update: () => {}
  });

  assert.equal(game.tryPlayerStep(1, 0), false);
  assert.equal(game.dialogueNpc, null);
});

test('legacy miniGames remain a working fallback without a host or runtime', () => {
  const game = makeGame();
  game.player.x = 11;
  game.player.y = 10;
  const updateCalls = [];
  const legacy = {
    isOpen: () => true,
    activeBoard: { originX: 12, originY: 10 },
    boardSize: 3,
    isTileOnBoard: (x, y) => x >= 12 && x < 15 && y >= 10 && y < 13,
    blocksStep: (character, nx, ny) => nx >= 12 && nx < 15 && ny >= 10 && ny < 13,
    update: dt => updateCalls.push(dt)
  };
  game.registerMiniGame(legacy);

  const blocked = game.getMiniGameBlockedTiles();
  assert.equal(blocked.has('12,10'), true);
  assert.equal(blocked.has('14,12'), true);
  assert.equal(game.isCharacterOnMiniGameBoard({ x: 13, y: 11 }), true);
  assert.equal(game.isParticipantCompanion({ id: 'c', buddyId: 'player', isCompanion: true }), true);
  assert.equal(game.tryStep(game.player, 1, 0, PLAYER_STEP), false);

  game.update(0.02);
  assert.deepEqual(updateCalls, [0.02]);
});

test('behavior runtime receives one millisecond update per frame and pauses with the game', () => {
  const game = makeGame();
  const calls = [];
  game.setBehaviorRuntime({ update: dtMs => calls.push(dtMs) });

  game.update(0.016);
  game.update(0.05);
  assert.deepEqual(calls, [16, 50]);

  game.paused = true;
  game.update(0.1);
  assert.deepEqual(calls, [16, 50]);
});

test('host and behavior runtime each update once per frame', () => {
  const game = makeGame();
  const hostCalls = [];
  const behaviorCalls = [];
  game.setMiniGameHost({ update: dtMs => hostCalls.push(dtMs) });
  game.setBehaviorRuntime({ update: dtMs => behaviorCalls.push(dtMs) });

  game.update(0.03);
  assert.deepEqual(hostCalls, [30]);
  assert.deepEqual(behaviorCalls, [30]);
});

test('behavior runtime suppresses legacy NPC wander decisions', () => {
  const game = makeGame();
  const npc = game.makeCharacter({ id: 'npc-a', name: 'Pip', x: 12, y: 12 });
  npc.wait = 0;
  game.npcs = [npc];
  game.wander = true;

  let steps = 0;
  const original = game.tryStep.bind(game);
  game.tryStep = (...args) => {
    steps += 1;
    return original(...args);
  };

  game.setBehaviorRuntime({ update: () => {} });
  game.updateNpc(npc, 1);
  assert.equal(steps, 0, 'runtime should own wander decisions');

  game.setBehaviorRuntime(null);
  game.updateNpc(npc, 1);
  assert.equal(steps, 1, 'legacy wander still runs without a runtime');
});

test('behavior runtime suppresses legacy companion trail-follow but keeps fetch', () => {
  const game = makeGame();
  const companion = game.makeCompanion({
    id: 'comp-a',
    name: 'Rusty',
    x: 20,
    y: 20,
    recipe: { style: 'dog', isCompanion: true }
  }, game.player);
  game.companions = [companion];

  let steps = 0;
  const original = game.tryStep.bind(game);
  game.tryStep = (...args) => {
    steps += 1;
    return original(...args);
  };

  game.setBehaviorRuntime({ update: () => {} });
  game.updateCompanion(companion, 0.016);
  assert.equal(steps, 0, 'companion trail should belong to the runtime');

  companion.fetchTarget = { x: 20, y: 18 };
  game.updateCompanion(companion, 0.016);
  assert.equal(steps, 1, 'fetch movement still runs with a runtime');
});

test('Big-O scales sprite height and hitbox without changing step timing', () => {
  const game = makeGame();
  equip(game.player, 'big-o-bracelet', 'charm', 'big-o');

  const fx = game.resolveFxFor(game.player);
  assert.equal(fx.scale, 1.5);

  const expectedHeight = CHARACTER_HEIGHT * 1.5;
  assert.equal(characterVisualHeight(game.player, fx), expectedHeight);

  const footX = (game.player.x + 0.5) * TILE;
  const footY = (game.player.y + 1) * TILE;
  assert.equal(game.characterAtScreen(footX, footY - CHARACTER_HEIGHT * 1.2), game.player);
  assert.equal(game.characterAtScreen(footX, footY - expectedHeight * 1.1), null);
});

test('pet companion height uses the pet sprite size in the shared helper', () => {
  const game = makeGame();
  const pet = game.makeCompanion({
    id: 'comp-pet',
    x: 11,
    y: 10,
    recipe: { style: 'dog', isCompanion: true }
  }, game.player);
  assert.equal(characterVisualHeight(pet, null), PET_HEIGHT);
});

test('Bouncy Boots shortens the step duration through the effect stat', () => {
  const game = makeGame();
  equip(game.player, 'bouncy-boots', 'feet', 'bouncy-boots');

  assert.equal(game.tryStep(game.player, 0, 1, PLAYER_STEP), true);
  assert.ok(Math.abs(game.player.duration - PLAYER_STEP * 0.6) < 1e-9);
});

test('teleport jumps up to 3 tiles through water and characters, but not onto a board', () => {
  const waterGame = makeGame();
  waterGame.terrain[10][11] = 'water';
  equip(waterGame.player, 'teleport-tricorder', 'hand', 'tricorder');
  assert.equal(waterGame.tryStep(waterGame.player, 1, 0, PLAYER_STEP), true);
  assert.equal(waterGame.player.toX, 13);
  assert.equal(waterGame.player.toY, 10);

  const occupancyGame = makeGame();
  occupancyGame.npcs = [
    occupancyGame.makeCharacter({ id: 'npc-blocker', name: 'Pip', x: 11, y: 10 })
  ];
  equip(occupancyGame.player, 'teleport-tricorder', 'hand', 'tricorder');
  assert.equal(occupancyGame.tryStep(occupancyGame.player, 1, 0, PLAYER_STEP), true);
  assert.equal(occupancyGame.player.toX, 13);

  // Board play is a no-teleport zone: the effect must not leap the board.
  const boardGame = makeGame();
  boardGame.setMiniGameHost({
    blocksStep: () => true,
    isParticipant: () => false,
    getBlockedTiles: () => new Set(['11,10', '12,10', '13,10']),
    update: () => {}
  });
  equip(boardGame.player, 'teleport-tricorder', 'hand', 'tricorder');
  assert.equal(boardGame.tryStep(boardGame.player, 1, 0, PLAYER_STEP), false);
  assert.equal(boardGame.player.moving, false);

  const bumpGame = makeGame();
  const bumpNpc = bumpGame.makeCharacter({ id: 'npc-bump', name: 'Bop', x: 11, y: 10 });
  bumpGame.npcs = [bumpNpc];
  equip(bumpGame.player, 'teleport-tricorder', 'hand', 'tricorder');
  assert.equal(bumpGame.tryPlayerStep(1, 0), true);
  assert.equal(bumpGame.dialogueNpc, null);
  assert.equal(bumpGame.player.toX, 13);

  // A fully occupied landing line still refuses to overlap another character.
  const blockedGame = makeGame();
  blockedGame.npcs = [11, 12, 13].map(x => blockedGame.makeCharacter({
    id: `npc-${x}`,
    name: `N${x}`,
    x,
    y: 10
  }));
  equip(blockedGame.player, 'teleport-tricorder', 'hand', 'tricorder');
  assert.equal(blockedGame.tryStep(blockedGame.player, 1, 0, PLAYER_STEP), false);
  assert.equal(blockedGame.player.moving, false);
});

test('Echo Bell records a short trail of previous tiles', () => {
  const game = makeGame();
  equip(game.player, 'echo-bell', 'charm', 'echo-bell');

  assert.equal(game.tryStep(game.player, 1, 0, PLAYER_STEP), true);
  game.player.x = game.player.toX;
  game.player.y = game.player.toY;
  game.player.moving = false;
  game.time += 0.2;
  assert.equal(game.tryStep(game.player, 1, 0, PLAYER_STEP), true);

  assert.ok(Array.isArray(game.player.effectTrail));
  assert.equal(game.player.effectTrail.length, 2);
  assert.deepEqual(
    game.player.effectTrail.map(entry => [entry.x, entry.y]),
    [[10, 10], [11, 10]]
  );
});

test('teleport stores motion style and snaps interpolation at its arrive point', () => {
  const game = makeGame();
  equip(game.player, 'teleport-tricorder', 'hand', 'tricorder');

  assert.equal(game.tryStep(game.player, 1, 0, PLAYER_STEP), true);
  assert.equal(game.player.motionStyle, 'teleport');
  assert.equal(game.player.toX, 13);
  assert.ok(game.player.motionArriveAt > 0 && game.player.motionArriveAt < 1);

  game.player.elapsed = game.player.duration * game.player.motionArriveAt + 1e-6;
  assert.deepEqual(game.interpolated(game.player), {
    x: game.player.toX,
    y: game.player.toY
  });
});

test('companions inherit party effects from their buddy', () => {
  const game = makeGame();
  equip(game.player, 'buddy-cape', 'back', 'buddy-cape');
  const companion = game.makeCompanion({
    id: 'comp-a',
    name: 'Rusty',
    x: 11,
    y: 10,
    recipe: { style: 'dog', isCompanion: true }
  }, game.player);

  const fx = game.resolveFxFor(companion);
  assert.equal(fx.scale, 1.1);
  assert.equal(fx.tint, '#4cc9f0');
  assert.ok(fx.effects.some(effect => effect.inherited));
});

test('frameDelta clamps the first-frame negative and oversized deltas', () => {
  assert.equal(frameDelta(100, 200), 0);
  assert.equal(frameDelta(200, 100), 0.05);
  assert.equal(frameDelta(116, 100), 0.016);
  assert.equal(frameDelta(Number.NaN, 100), 0);
});

test('setters accept and clear optional runtime collaborators', () => {
  const game = makeGame();
  const host = { update: () => {} };
  const runtime = { update: () => {} };
  const bubbles = { render: () => 0 };

  assert.equal(game.setMiniGameHost(host), game);
  assert.equal(game.setBehaviorRuntime(runtime), game);
  assert.equal(game.setSpeechBubbles(bubbles), game);
  assert.equal(game.miniGameHost, host);
  assert.equal(game.behaviorRuntime, runtime);
  assert.equal(game.speechBubbles, bubbles);

  game.setMiniGameHost(null);
  game.setBehaviorRuntime(null);
  game.setSpeechBubbles(null);
  assert.equal(game.miniGameHost, null);
  assert.equal(game.behaviorRuntime, null);
  assert.equal(game.speechBubbles, null);
});
