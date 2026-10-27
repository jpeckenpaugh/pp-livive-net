import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeBoard,
  footprintFromPlacement,
  footprintTiles,
  validateFootprint,
  findFootprintPlacement,
  seatTargets,
  stageSeats,
  stageCompanions,
  evacuateBystanders,
  releaseSession,
  DEFAULT_OFFSETS
} from '../../src/minigames/staging.js';
import { LEFT, RIGHT } from '../../src/facing.js';
import { spectatorOffsets } from '../../src/characters.js';

const terrain = Array.from({ length: 64 }, () => Array.from({ length: 64 }, () => 'grass'));

test('normalizeBoard applies safe defaults', () => {
  assert.deepEqual(normalizeBoard({ width: 3, height: 3 }), {
    width: 3,
    height: 3,
    margin: 0,
    blocksMovement: true,
    hiddenZones: []
  });
  assert.equal(normalizeBoard({ width: 0, height: -2, margin: -4, blocksMovement: false }).width, 1);
  assert.equal(normalizeBoard({ blocksMovement: false }).blocksMovement, false);
});

test('footprint helpers convert placements and list tiles', () => {
  const footprint = footprintFromPlacement({ originX: 10, originY: 12 }, { width: 2, height: 2 });
  assert.deepEqual(footprint, { x: 10, y: 12, width: 2, height: 2 });
  assert.deepEqual(footprintTiles(footprint), [
    { x: 10, y: 12 }, { x: 11, y: 12 },
    { x: 10, y: 13 }, { x: 11, y: 13 }
  ]);
  assert.deepEqual(footprintFromPlacement({ x: 4, y: 5 }, { width: 1, height: 1 }), {
    x: 4, y: 5, width: 1, height: 1
  });
});

test('validateFootprint checks bounds, walkability, and the margin ring', () => {
  const board = { width: 3, height: 3, margin: 1 };
  const good = validateFootprint({ terrain, placement: { originX: 10, originY: 10 }, board });
  assert.equal(good.ok, true);
  assert.equal(good.tiles.length, 9);

  const waterTerrain = terrain.map(row => [...row]);
  waterTerrain[9][9] = 'water';
  assert.equal(validateFootprint({
    terrain: waterTerrain,
    placement: { originX: 10, originY: 10 },
    board
  }).reason, 'unwalkable');

  assert.equal(validateFootprint({
    terrain,
    placement: { originX: 0, originY: 0 },
    board
  }).reason, 'out-of-bounds');

  assert.equal(validateFootprint({
    terrain,
    placement: { originX: 10, originY: 10 },
    board,
    occupied: new Set(['12,12'])
  }).reason, 'occupied');

  assert.equal(validateFootprint({ terrain, placement: { originX: 10, originY: 10 }, board: null }).reason, 'no-board');
  assert.equal(validateFootprint({ placement: { originX: 10, originY: 10 }, board }).reason, 'no-terrain');
});

test('findFootprintPlacement scans candidate offsets around a character', () => {
  const board = { width: 3, height: 3, margin: 1 };
  const placement = findFootprintPlacement({ terrain, board, around: { x: 20, y: 20 } });
  assert.deepEqual(placement, { originX: 21, originY: 19 });
  assert.equal(validateFootprint({ terrain, placement, board }).ok, true);

  const blocked = validateFootprint({ terrain, placement, board });
  assert.equal(blocked.ok, true);
  assert.ok(DEFAULT_OFFSETS.length >= 4);

  const occupied = new Set(['21,19']);
  const second = findFootprintPlacement({ terrain, board, around: { x: 20, y: 20 }, occupied });
  assert.notDeepEqual(second, placement);
  assert.equal(validateFootprint({ terrain, placement, board, occupied }).reason, 'occupied');

  const impossible = findFootprintPlacement({
    terrain,
    board: { width: 3, height: 3, margin: 1 },
    around: { x: 0, y: 0 },
    offsets: [{ dx: 0, dy: 0 }]
  });
  assert.equal(impossible, null);
});

test('seatTargets places two seats left and right on the centre row', () => {
  const three = seatTargets({ placement: { originX: 10, originY: 10 }, board: { width: 3, height: 3 }, seats: 2 });
  assert.deepEqual(three, [
    { seat: 0, x: 9, y: 11, direction: RIGHT },
    { seat: 1, x: 13, y: 11, direction: LEFT }
  ]);

  const eight = seatTargets({ placement: { originX: 10, originY: 10 }, board: { width: 8, height: 8 }, seats: 4 });
  assert.deepEqual(eight[0], { seat: 0, x: 9, y: 13, direction: RIGHT });
  assert.deepEqual(eight[1], { seat: 1, x: 18, y: 13, direction: LEFT });
  assert.deepEqual(eight[2], { seat: 2, x: 9, y: 14, direction: RIGHT });
  assert.deepEqual(eight[3], { seat: 3, x: 18, y: 12, direction: LEFT });
});

test('stageSeats walks seated characters to their anchors', () => {
  const player = { id: 'player', x: 20, y: 20, moving: false, path: [] };
  const npc = { id: 'npc', x: 25, y: 25, moving: true, toX: 26, toY: 25, path: [] };

  const targets = stageSeats({
    terrain,
    seats: [player, { character: npc, controller: 'ai' }],
    placement: { originX: 10, originY: 10 },
    board: { width: 3, height: 3 }
  });

  assert.equal(targets.length, 2);
  assert.equal(player.inMiniGame, true);
  assert.equal(player.direction, RIGHT);
  assert.ok(player.path.length > 0);
  assert.deepEqual(player.path[player.path.length - 1], { x: 9, y: 11 });
  assert.equal(npc.direction, LEFT);
  assert.deepEqual(npc.path[npc.path.length - 1], { x: 13, y: 11 });
});

test('stageCompanions spreads spectators using spectatorOffsets', () => {
  const companions = [
    { id: 'c1', x: 20, y: 20, moving: false, path: [], fetchTarget: { x: 1, y: 1 } },
    { id: 'c2', x: 21, y: 21, moving: false, path: [] },
    { id: 'c3', x: 22, y: 22, moving: false, path: [] }
  ];
  const targets = stageCompanions({
    terrain,
    companions,
    placement: { originX: 10, originY: 10 },
    board: { width: 3, height: 3 }
  });

  const offsets = spectatorOffsets(3);
  assert.deepEqual(offsets, [1, -1, 2]);
  assert.deepEqual(targets.map(target => ({ x: target.x, y: target.y })), [
    { x: 9, y: 12 }, { x: 9, y: 10 }, { x: 9, y: 13 }
  ]);
  assert.ok(companions.every(companion => companion.inMiniGame === true));
  assert.equal(companions[0].fetchTarget, null);
  assert.deepEqual(companions[0].stagedDestination, { x: 9, y: 12 });
  assert.equal(companions[0].inMiniGame, true);
});

test('evacuateBystanders moves non-participants off the board only', () => {
  const participant = { id: 'player', x: 9, y: 11, moving: false, path: [] };
  const bystander = { id: 'npc-on-board', x: 11, y: 11, moving: false, path: [] };
  const far = { id: 'npc-far', x: 30, y: 30, moving: false, path: [] };
  const companion = { id: 'comp', x: 12, y: 12, moving: false, path: [] };

  const evacuated = evacuateBystanders({
    terrain,
    placement: { originX: 10, originY: 10 },
    board: { width: 3, height: 3 },
    participants: [participant],
    characters: [participant, bystander, far, companion]
  });

  assert.equal(evacuated.length, 2);
  assert.deepEqual(evacuated.map(entry => entry.character.id).sort(), ['comp', 'npc-on-board']);
  for (const entry of evacuated) {
    assert.ok(entry.character.path.length > 0);
    const last = entry.character.path[entry.character.path.length - 1];
    const onBoard = last.x >= 10 && last.x <= 12 && last.y >= 10 && last.y <= 12;
    assert.equal(onBoard, false);
  }
  assert.equal(participant.path.length, 0);
  assert.equal(far.path.length, 0);
});

test('releaseSession clears only the state a session touched', () => {
  const participant = { id: 'player', inMiniGame: true, miniGameTarget: { x: 9, y: 11 }, stagedDestination: { x: 9, y: 11 } };
  const companion = { id: 'comp', inMiniGame: true, miniGameTarget: null, stagedDestination: { x: 8, y: 11 } };
  const unrelated = { id: 'other', inMiniGame: true, miniGameTarget: { x: 1, y: 1 }, stagedDestination: { x: 1, y: 1 } };

  const released = releaseSession({ participants: [participant], companions: [companion] });
  assert.deepEqual(released.map(character => character.id), ['player', 'comp']);
  assert.equal(participant.inMiniGame, false);
  assert.equal(participant.miniGameTarget, null);
  assert.equal(participant.stagedDestination, null);
  assert.equal(companion.stagedDestination, null);
  assert.equal(unrelated.inMiniGame, true);
  assert.deepEqual(unrelated.stagedDestination, { x: 1, y: 1 });

  assert.deepEqual(releaseSession(), []);
});
