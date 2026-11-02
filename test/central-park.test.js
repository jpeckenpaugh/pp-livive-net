import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WORLD_SIZE,
  TILE_TYPES,
  decodeTerrain,
  encodeTerrain,
  findPath,
  generateCentralPark,
  generateWorld,
  isWalkable,
  largestComponentFrom,
  typeAt
} from '../src/world.js';
import {
  LOCATIONS,
  createLocationRecord,
  doorsFor,
  locationTheme,
  propsForLocation,
  worldFor
} from '../src/locations.js';
import { locationBlockedTiles, locationProp } from '../src/location_props.js';
import { migrateSave } from '../src/storage.js';

const SPAWN = { x: 32, y: 58 };

test('Central Park is a valid 64 × 64 world with a walkable spawn and component', () => {
  for (const seed of ['central-a', 'central-b', 'clover-park']) {
    const world = generateCentralPark(seed);
    assert.equal(world.template, 'central-park');
    assert.equal(world.grid.length, WORLD_SIZE);
    for (const row of world.grid) {
      assert.equal(row.length, WORLD_SIZE);
      for (const tile of row) assert.ok(TILE_TYPES.includes(tile));
    }
    assert.deepEqual(world.spawn, SPAWN);
    assert.ok(isWalkable(typeAt(world.grid, world.spawn.x, world.spawn.y)), 'spawn is walkable');
    assert.ok(world.component.length > 3000, 'the park is mostly walkable ground');
    assert.ok(world.componentKeys.has(`${world.spawn.x},${world.spawn.y}`), 'spawn is in the component');
    assert.equal(largestComponentFrom(world.grid).length, world.component.length);
    assert.ok(world.scenery.length > 20, 'the park keeps nature-kit scenery');
  }

  const world = generateCentralPark('central-a');
  assert.equal(typeAt(world.grid, 32, 62), 'grass', 'the gate sits at the south edge');
  assert.equal(world.componentKeys.has('32,62'), true, 'the gate lip is reachable');
});

test('Central Park paints the plaza, ring, radials, lake, playground, and amphitheatre', () => {
  const world = generateCentralPark('central-zones');
  const grid = world.grid;

  assert.equal(typeAt(grid, 32, 30), 'dirt', 'central plaza');
  assert.equal(typeAt(grid, 28, 30), 'dirt', 'plaza apron');
  assert.equal(typeAt(grid, 41, 21), 'dirt', 'ring path');
  assert.equal(typeAt(grid, 32, 2), 'dirt', 'north radial');
  assert.equal(typeAt(grid, 62, 30), 'dirt', 'east radial');
  assert.equal(typeAt(grid, 2, 30), 'dirt', 'west radial');
  assert.equal(typeAt(grid, 32, 41), 'dirt', 'south radial');

  assert.equal(typeAt(grid, 48, 16), 'water', 'lake centre');
  assert.equal(typeAt(grid, 39, 16), 'sand', 'curving shore');
  assert.equal(typeAt(grid, 47, 20), 'sand', 'walkable jetty under the pier');

  assert.equal(typeAt(grid, 9, 10), 'sand', 'playground apron');
  assert.equal(typeAt(grid, 18, 19), 'sand', 'jungle-gym entrance');

  assert.equal(typeAt(grid, 17, 42), 'dirt', 'amphitheatre stage');
  assert.equal(typeAt(grid, 27, 22), 'field', 'flower bed');
  assert.equal(typeAt(grid, 48, 53), 'dirt', 'lodge lane');

  assert.equal(isWalkable(typeAt(grid, 18, 42)), true, 'the stage is open from the north');
});

test('the park stays one walkable piece and every zone is reachable from the spawn', () => {
  const world = generateCentralPark('central-walk');
  const targets = [
    { x: 17, y: 42 }, // amphitheatre stage
    { x: 18, y: 19 }, // jungle gym
    { x: 47, y: 20 }, // pier
    { x: 48, y: 52 }, // town door
    { x: 32, y: 61 } // gate lip
  ];
  for (const target of targets) {
    const path = findPath(world.grid, world.spawn, target);
    assert.ok(path.length > 0, `path to ${target.x},${target.y}`);
    assert.deepEqual(path.at(-1), target);
    for (const step of path) assert.ok(isWalkable(typeAt(world.grid, step.x, step.y)));
  }
});

test('park props avoid the spawn, doors, gym, and gate lip and never trap the spawn', () => {
  const world = generateCentralPark('central-props');
  const def = LOCATIONS.park;
  const declared = Array.isArray(def.props) ? def.props : [];
  const props = propsForLocation('park');

  // A dropped prop means two solid footprints overlapped in the data file.
  assert.equal(props.length, declared.length);
  for (const prop of props) assert.ok(locationProp(prop.type));

  const blocked = locationBlockedTiles(props);
  const reserved = [
    world.spawn,
    { x: 48, y: 52 }, // town door
    { x: 18, y: 19 }, // jungle gym
    { x: 32, y: 61 } // gate lip
  ];
  for (const tile of reserved) {
    assert.ok(!blocked.has(`${tile.x},${tile.y}`), `prop blocks ${tile.x},${tile.y}`);
  }

  // Every key location is still reachable around the solid props.
  for (const target of [reserved[1], reserved[2], { x: 32, y: 44 }, { x: 39, y: 16 }]) {
    const path = findPath(world.grid, world.spawn, target, blocked);
    assert.ok(path.length > 0, `props cut off ${target.x},${target.y}`);
  }

  assert.equal(locationProp('picnic-blanket').solid, false, 'blankets are ground cover');
});

test('the park doors lead to Town and put the Jungle Gym on the playground', () => {
  const world = generateCentralPark('central-doors');
  const doors = doorsFor('park', { terrain: world.grid, spawn: world.spawn });
  assert.deepEqual(doors.map(door => door.kind), ['travel', 'activity']);

  const travel = doors.find(door => door.kind === 'travel');
  assert.equal(travel.to, 'town');
  assert.equal(travel.prompt, 'Head into town?');
  assert.deepEqual({ x: travel.x, y: travel.y }, { x: 48, y: 52 });

  const gym = doors.find(door => door.kind === 'activity');
  assert.equal(gym.activityId, 'jungle-gym');
  assert.deepEqual({ x: gym.x, y: gym.y }, { x: 18, y: 19 });
  assert.equal(typeAt(world.grid, gym.x, gym.y), 'sand');

  for (const door of doors) {
    assert.ok(isWalkable(typeAt(world.grid, door.x, door.y)));
  }
});

test('the park location declares the template, theme, props, and designed spawn', () => {
  const def = LOCATIONS.park;
  assert.equal(def.template, 'central-park');
  assert.equal(def.spawn.x, SPAWN.x);
  assert.equal(def.spawn.y, SPAWN.y);
  assert.ok(locationTheme('park'));
  assert.ok(propsForLocation('park').length > 20);

  const world = worldFor('park', 'central-dispatch');
  assert.equal(world.template, 'central-park');
  assert.equal(world.spawn.x, SPAWN.x);
  assert.equal(world.spawn.y, SPAWN.y);

  const record = createLocationRecord('park');
  assert.deepEqual(decodeTerrain(record.terrain), generateCentralPark('park-01').grid);
});

test('existing saved park terrain still wins over the new template', () => {
  const legacy = generateWorld('legacy-park');
  const terrain = encodeTerrain(legacy.grid);
  const saved = {
    version: 4,
    currentLocation: 'park',
    locations: {
      park: {
        seed: 'legacy-park',
        terrain,
        player: { x: 12, y: 14, direction: 2 },
        npcs: [],
        forage: null
      }
    }
  };

  const loaded = migrateSave(JSON.parse(JSON.stringify(saved)));
  assert.equal(loaded.locations.park.terrain, terrain);
  assert.deepEqual(decodeTerrain(loaded.locations.park.terrain), legacy.grid);
  assert.deepEqual(loaded.locations.park.player, saved.locations.park.player);

  // The template has moved on, but the stored world was never re-rolled.
  assert.notDeepEqual(worldFor('park', 'legacy-park').grid, legacy.grid);
});
