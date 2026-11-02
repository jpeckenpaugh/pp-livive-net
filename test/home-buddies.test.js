import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeTerrain, generateHome } from '../src/world.js';
import { createHomeLocation, locationDef } from '../src/locations.js';
import { captureLocationRecord } from '../src/storage.js';
import { Game } from '../src/game.js';
import {
  HOME_BUDDY_CAP,
  HOME_SIT_MAX_SECONDS,
  HOME_SIT_MIN_SECONDS,
  canPlaceDecor,
  homeRoomTiles,
  normalizeDecor,
  placeDecor,
  placeHomeBuddies,
  rugTiles,
  selectHomeRoster,
  tickHomeBuddy
} from '../src/home.js';

const HOME_SEED = locationDef('home').seed;

function buddy(id, buddyId = 'player') {
  return {
    id,
    name: id,
    buddyId,
    recipe: { seed: id, style: 'voxel-bot' },
    inventory: [],
    equipped: []
  };
}

function homeWorld() {
  return generateHome(HOME_SEED);
}

function keys(tiles) {
  return new Set(tiles.map(tile => `${tile.x},${tile.y}`));
}

test('Home roster keeps player buddies only, active first, then stabled, in id order', () => {
  const active = [buddy('p2'), buddy('p1'), buddy('npc-1', 'npc-1')];
  const stabled = [buddy('s2'), buddy('s1'), buddy('p1')];
  const selection = selectHomeRoster(active, stabled);

  assert.deepEqual(selection.buddies.map(entry => entry.record.id), ['p1', 'p2', 's1', 's2']);
  assert.deepEqual(selection.buddies.map(entry => entry.source), ['active', 'active', 'stabled', 'stabled']);
  assert.equal(selection.total, 4);
  assert.equal(selection.overflow, 0);
  assert.ok(selection.buddies.every(entry => entry.record.buddyId === 'player'));
});

test('Home roster caps at twelve and reports the quiet overflow', () => {
  const stabled = Array.from({ length: 14 }, (_, index) => buddy(`s${String(index).padStart(2, '0')}`));
  const selection = selectHomeRoster([], stabled);

  assert.equal(selection.buddies.length, HOME_BUDDY_CAP);
  assert.equal(selection.total, 14);
  assert.equal(selection.overflow, 2);
  assert.equal(selection.buddies[0].record.id, 's00');
  assert.equal(selection.buddies.at(-1).record.id, 's11');
});

test('Home placement is deterministic, unique, on the interior floor, and avoids spawn and rug', () => {
  const home = homeWorld();
  const room = homeRoomTiles(home.grid, home.house);
  const roomKeys = keys(room);
  const rug = [{ x: home.spawn.x + 2, y: home.spawn.y }];
  const rugKeys = keys(rug);
  const selection = selectHomeRoster(
    Array.from({ length: 12 }, (_, index) => buddy(`c${String(index).padStart(2, '0')}`)),
    []
  );

  const first = placeHomeBuddies(selection.buddies, {
    terrain: home.grid,
    house: home.house,
    spawn: home.spawn,
    rugTiles: rug
  });
  const second = placeHomeBuddies(selection.buddies, {
    terrain: home.grid,
    house: home.house,
    spawn: home.spawn,
    rugTiles: rug
  });

  assert.equal(first.length, 12);
  assert.deepEqual(
    first.map(entry => ({ id: entry.id, x: entry.x, y: entry.y })),
    second.map(entry => ({ id: entry.id, x: entry.x, y: entry.y }))
  );

  const occupied = new Set();
  for (const entry of first) {
    const key = `${entry.x},${entry.y}`;
    assert.ok(roomKeys.has(key), `${entry.id} is outside the room`);
    assert.ok(!rugKeys.has(key), `${entry.id} stands on the rug`);
    assert.notDeepEqual({ x: entry.x, y: entry.y }, home.spawn);
    assert.equal(occupied.has(key), false, `${entry.id} shares a tile`);
    occupied.add(key);
    assert.equal(entry.pose, 'stand');
    assert.equal(entry.partyActive, true);
  }
});

test('Home wander stays inside the room and never steps onto the rug or another buddy', () => {
  const home = homeWorld();
  const room = homeRoomTiles(home.grid, home.house);
  const roomKeys = keys(room);
  const rug = [{ x: home.spawn.x + 2, y: home.spawn.y }];
  const rugKeys = keys(rug);
  let state = {
    ...buddy('wanderer'),
    x: home.spawn.x,
    y: home.spawn.y,
    direction: 0,
    pose: 'stand',
    timer: 0,
    sitTimer: 0
  };

  // 0.99 skips sitting and always picks the last legal neighbour.
  const rng = () => 0.99;
  for (let tick = 0; tick < 400; tick += 1) {
    state = tickHomeBuddy(state, {
      dt: 1,
      terrain: home.grid,
      roomTiles: room,
      rugTiles: rug,
      occupied: new Set(),
      rng
    });
    const key = `${state.x},${state.y}`;
    assert.ok(roomKeys.has(key), `left the room at tick ${tick}`);
    assert.ok(!rugKeys.has(key), `stepped on the rug at tick ${tick}`);
    assert.equal(state.pose, 'stand');
  }

  // A buddy occupying every neighbour leaves the wanderer waiting, not overlapping.
  const walled = {
    ...state,
    timer: 0,
    x: home.spawn.x,
    y: home.spawn.y
  };
  const occupied = new Set([
    `${walled.x + 0},${walled.y + 1}`,
    `${walled.x + 1},${walled.y + 0}`,
    `${walled.x + 0},${walled.y - 1}`,
    `${walled.x - 1},${walled.y + 0}`
  ]);
  const stuck = tickHomeBuddy(walled, {
    dt: 1,
    terrain: home.grid,
    roomTiles: room,
    rugTiles: [],
    occupied,
    rng
  });
  assert.deepEqual({ x: stuck.x, y: stuck.y }, { x: walled.x, y: walled.y });
});

test('a buddy near the rug settles, squashes into a sit pose, and gets up after four to eight seconds', () => {
  const home = homeWorld();
  const room = homeRoomTiles(home.grid, home.house);
  const rug = [{ x: home.spawn.x + 2, y: home.spawn.y }];
  let state = {
    ...buddy('sitter'),
    x: home.spawn.x + 1,
    y: home.spawn.y,
    direction: 0,
    pose: 'stand',
    timer: 0,
    sitTimer: 0
  };

  state = tickHomeBuddy(state, {
    dt: 1,
    terrain: home.grid,
    roomTiles: room,
    rugTiles: rug,
    occupied: new Set(),
    rng: () => 0
  });
  assert.equal(state.pose, 'sit');
  assert.ok(state.sitTimer >= HOME_SIT_MIN_SECONDS);
  assert.ok(state.sitTimer <= HOME_SIT_MAX_SECONDS);
  assert.equal(state.x, home.spawn.x + 1);

  const sitting = tickHomeBuddy(state, {
    dt: HOME_SIT_MIN_SECONDS - 1,
    terrain: home.grid,
    roomTiles: room,
    rugTiles: rug,
    occupied: new Set(),
    rng: () => 0.5
  });
  assert.equal(sitting.pose, 'sit');

  const stood = tickHomeBuddy(sitting, {
    dt: 2,
    terrain: home.grid,
    roomTiles: room,
    rugTiles: rug,
    occupied: new Set(),
    rng: () => 0.5
  });
  assert.equal(stood.pose, 'stand');
  assert.deepEqual({ x: stood.x, y: stood.y }, { x: sitting.x, y: sitting.y });
});

test('a buddy more than two tiles from the rug does not settle', () => {
  const home = homeWorld();
  const room = homeRoomTiles(home.grid, home.house);
  const rug = [{ x: home.spawn.x + 5, y: home.spawn.y }];
  const state = {
    ...buddy('far'),
    x: home.spawn.x,
    y: home.spawn.y,
    direction: 0,
    pose: 'stand',
    timer: 0,
    sitTimer: 0
  };
  const next = tickHomeBuddy(state, {
    dt: 0.5,
    terrain: home.grid,
    roomTiles: room,
    rugTiles: rug,
    occupied: new Set(),
    rng: () => 0
  });
  assert.equal(next.pose, 'stand');
});

test('decor is one known item, only on the interior floor, and survives a location round-trip', () => {
  const home = homeWorld();
  const room = homeRoomTiles(home.grid, home.house);

  assert.deepEqual(normalizeDecor([{ id: 'rug', x: 10, y: 10 }]), [{ id: 'rug', x: 10, y: 10 }]);
  assert.deepEqual(normalizeDecor([{ id: 'unknown', x: 10, y: 10 }]), []);
  assert.deepEqual(normalizeDecor([{ id: 'rug' }]), []);
  assert.deepEqual(
    normalizeDecor([{ id: 'rug', x: 10, y: 10 }, { id: 'plant', x: 11, y: 10 }]),
    [{ id: 'rug', x: 10, y: 10 }]
  );

  const inside = room[0];
  assert.equal(canPlaceDecor({ roomTiles: room, x: inside.x, y: inside.y }), true);
  assert.equal(canPlaceDecor({ roomTiles: room, x: home.door.x, y: home.door.y }), false);
  assert.deepEqual(placeDecor([], 'rug', inside.x, inside.y), [{ id: 'rug', x: inside.x, y: inside.y }]);
  assert.deepEqual(placeDecor([{ id: 'rug', x: 1, y: 1 }], 'plant', inside.x, inside.y), [
    { id: 'plant', x: inside.x, y: inside.y }
  ]);
  assert.deepEqual(rugTiles([{ id: 'rug', x: 3, y: 4 }, { id: 'plant', x: 5, y: 6 }]), [{ x: 3, y: 4 }]);

  const terrain = encodeTerrain(home.grid);
  const record = captureLocationRecord({
    seed: HOME_SEED,
    terrain,
    player: { x: inside.x, y: inside.y, direction: 0 },
    npcs: [],
    forage: createHomeLocation().forage,
    decor: [{ id: 'rug', x: inside.x, y: inside.y }]
  }, null);
  assert.deepEqual(record.decor, [{ id: 'rug', x: inside.x, y: inside.y }]);

  // Capture with no decor argument keeps the previous placement (travel + save).
  const again = captureLocationRecord(record, record);
  assert.deepEqual(again.decor, record.decor);
});

test('Game keeps Home buddies in the display list, never the party', () => {
  const home = homeWorld();
  const room = homeRoomTiles(home.grid, home.house);
  const selection = selectHomeRoster([buddy('p1')], [buddy('s1')]);
  const placed = placeHomeBuddies(selection.buddies, {
    terrain: home.grid,
    house: home.house,
    spawn: home.spawn,
    rugTiles: []
  });

  const game = new Game();
  game.setWorld({
    terrain: home.grid,
    worldSeed: HOME_SEED,
    player: {
      id: 'player',
      name: 'You',
      recipe: { seed: 'player', style: 'voxel-art' },
      x: home.spawn.x,
      y: home.spawn.y,
      direction: 0,
      inventory: [],
      equipped: []
    },
    npcs: [],
    companions: [buddy('p1'), buddy('s1')],
    scenery: [],
    forage: null,
    homeMode: true,
    homeBuddies: placed,
    homeRoomTiles: room,
    homeRugTiles: []
  });

  assert.equal(game.companions.length, 0, 'Home must not admit a live party');
  assert.equal(game.homeBuddies.length, 2);
  assert.equal(game.homeBuddies[0].pose, 'stand');
  assert.ok(game.homeBuddies.every(entry => entry.homeOnly === true));

  game.updateHomeBuddies(2);
  assert.equal(game.companions.length, 0);
  assert.ok(game.homeBuddies.every(entry => (
    room.some(tile => tile.x === entry.x && tile.y === entry.y)
  )));
});
