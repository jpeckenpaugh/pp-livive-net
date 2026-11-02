import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WORLD_SIZE,
  TILE_TYPES,
  generateWorld,
  generateHome,
  encodeTerrain,
  decodeTerrain,
  findPath,
  isWalkable,
  typeAt
} from '../src/world.js';
import {
  allowsForage,
  arrivalTile,
  createHomeLocation,
  doorFor,
  isLocationEnabled,
  locationDef,
  travelTargets,
  worldFor
} from '../src/locations.js';
import { FORAGE_MUSHROOM_TYPES } from '../src/forage.js';

const HOME_SEED = locationDef('home').seed;

test('generateHome builds a 64 × 64 lot with one walled room and a reachable door', () => {
  const home = generateHome(HOME_SEED);
  assert.equal(home.grid.length, WORLD_SIZE);
  for (const row of home.grid) {
    assert.equal(row.length, WORLD_SIZE);
    for (const tile of row) assert.ok(TILE_TYPES.includes(tile), `unknown tile ${tile}`);
  }

  const house = home.house;
  const maxX = house.x + house.width - 1;
  const maxY = house.y + house.height - 1;

  // Perimeter is wall, interior is floor.
  assert.equal(home.grid[house.y][house.x], 'home-wall');
  assert.equal(home.grid[house.y][maxX], 'home-wall');
  assert.equal(home.grid[maxY][maxX], 'home-wall');
  assert.equal(isWalkable('home-wall'), false);
  assert.equal(isWalkable('home-floor'), true);
  assert.equal(home.grid[house.y + 1][house.x + 1], 'home-floor');

  // The door is carved out of the wall and stays walkable.
  assert.equal(typeAt(home.grid, home.door.x, home.door.y), 'home-floor');
  assert.ok(isWalkable(typeAt(home.grid, home.door.x, home.door.y)));

  // Spawn is a floor tile inside the room, and the yard connects through the door.
  assert.equal(typeAt(home.grid, home.spawn.x, home.spawn.y), 'home-floor');
  const yard = { x: home.door.x, y: home.door.y + 2 };
  assert.ok(isWalkable(typeAt(home.grid, yard.x, yard.y)));
  assert.ok(findPath(home.grid, home.spawn, yard).length > 0, 'spawn can walk out the door');
  assert.ok(home.component.length > 0);
  assert.ok(home.componentKeys.has(`${home.spawn.x},${home.spawn.y}`));
});

test('generateHome is deterministic per seed', () => {
  const a = generateHome(HOME_SEED);
  const b = generateHome(HOME_SEED);
  assert.deepEqual(a.grid, b.grid);
  assert.deepEqual(a.spawn, b.spawn);
  assert.deepEqual(a.scenery, b.scenery);
});

test('home tiles round-trip through the save format', () => {
  const home = generateHome(HOME_SEED);
  const encoded = encodeTerrain(home.grid);
  assert.equal(encoded.length, WORLD_SIZE * WORLD_SIZE);
  assert.deepEqual(decodeTerrain(encoded), home.grid);
  assert.equal(decodeTerrain('x'.repeat(WORLD_SIZE * WORLD_SIZE))[0][0], 'home-wall');
});

test('home scenery stays in the yard and contains no mushrooms', () => {
  const home = generateHome(HOME_SEED);
  const built = worldFor('home', HOME_SEED);
  for (const item of built.scenery) {
    assert.ok(!FORAGE_MUSHROOM_TYPES.includes(item.type), `mushroom ${item.type} in Home`);
    assert.equal(typeAt(home.grid, item.x, item.y), 'grass', 'scenery belongs on yard grass');
  }
  assert.ok(home.scenery.length >= built.scenery.length);
});

test('Home is a forage-free location', () => {
  assert.equal(allowsForage('home'), false);
  assert.equal(allowsForage('park'), true);

  const record = createHomeLocation({ basket: { apple: 2, mushroom: 1 } });
  assert.deepEqual(record.npcs, []);
  assert.deepEqual(record.forage.apples, []);
  assert.equal(record.forage.seeded, true);
  assert.deepEqual(record.forage.basket, { apple: 2, mushroom: 1 });
  assert.equal(decodeTerrain(record.terrain).length, WORLD_SIZE);
  assert.deepEqual(record.player, { x: homeSpawn().x, y: homeSpawn().y, direction: 0 });
});

function homeSpawn() {
  return locationDef('home').spawn;
}

test('the Home flag exposes the Park door and the menu row', () => {
  const park = generateWorld('home-door-fixture');

  // The completed Home slice ships enabled, so the Park door and destination exist.
  assert.equal(isLocationEnabled('home'), true);
  const door = doorFor('park', { terrain: park.grid, spawn: park.spawn });
  assert.ok(door);
  assert.equal(door.to, 'home');
  assert.equal(door.prompt, 'Go home?');
  assert.ok(isWalkable(typeAt(park.grid, door.x, door.y)));

  const targets = travelTargets('park');
  assert.deepEqual(targets.map(target => target.id), ['home']);
  assert.equal(targets[0].label, 'Home');
  // Home offers the Park as its way out.
  assert.deepEqual(
    travelTargets('home').map(target => target.id),
    ['park']
  );
});

test('the Home door lands on the carved doorway and returns to the park', () => {
  const home = generateHome(HOME_SEED);
  const door = doorFor('home', { terrain: home.grid, spawn: home.spawn, isEnabled: () => true });
  assert.ok(door);
  assert.equal(door.to, 'park');
  assert.deepEqual({ x: door.x, y: door.y }, { x: home.door.x, y: home.door.y });
  assert.ok(isWalkable(typeAt(home.grid, door.x, door.y)));
});

test('arrival uses the saved position and falls back to the declared spawn', () => {
  assert.deepEqual(
    arrivalTile('home', { player: { x: 12, y: 9, direction: 2 } }),
    { x: 12, y: 9, direction: 2 }
  );
  assert.deepEqual(arrivalTile('home', {}), {
    x: homeSpawn().x,
    y: homeSpawn().y,
    direction: 0
  });
  assert.deepEqual(arrivalTile('park', null), {
    x: locationDef('park').spawn.x,
    y: locationDef('park').spawn.y,
    direction: 0
  });
});
