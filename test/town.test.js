import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WORLD_SIZE,
  TILE_TYPES,
  decodeTerrain,
  encodeTerrain,
  findPath,
  generateTown,
  generateWorld,
  isWalkable,
  largestComponentFrom,
  typeAt
} from '../src/world.js';
import {
  LOCATIONS,
  createLocationRecord,
  createShopLocation,
  doorFor,
  doorsFor,
  residentsFor,
  layoutMatches,
  locationLayout,
  locationTheme,
  propsForLocation,
  travelTargets,
  worldFor
} from '../src/locations.js';
import { locationBlockedTiles } from '../src/location_props.js';
import { activeLocation, captureLocationRecord, migrateSave } from '../src/storage.js';
import { Game } from '../src/game.js';

const TOWN_SEED = LOCATIONS.town.seed;

test('Town is a valid 64 × 64 world with a walkable spawn and one component', () => {
  for (const seed of [TOWN_SEED, 'town-b', 'town-c']) {
    const world = generateTown(seed);
    assert.equal(world.template, 'town');
    assert.equal(world.grid.length, WORLD_SIZE);
    for (const row of world.grid) {
      assert.equal(row.length, WORLD_SIZE);
      for (const tile of row) assert.ok(TILE_TYPES.includes(tile), `unknown tile ${tile}`);
    }
    assert.ok(isWalkable(typeAt(world.grid, world.spawn.x, world.spawn.y)), 'spawn is walkable');
    assert.ok(world.componentKeys.has(`${world.spawn.x},${world.spawn.y}`), 'spawn is in the component');
    assert.equal(largestComponentFrom(world.grid).length, world.component.length);
    assert.ok(world.component.length > 3800, 'the town is one connected, mostly open map');
    assert.ok(world.scenery.length >= 10, 'a few trees and flowers survive on the lawns');
  }
});

test('Town paints the street, north facades, south plaza, and east beach stub', () => {
  const world = generateTown(TOWN_SEED);
  const grid = world.grid;

  assert.equal(typeAt(grid, 3, 31), 'dirt', 'west gate');
  assert.equal(typeAt(grid, 32, 31), 'dirt', 'main street');
  assert.equal(typeAt(grid, 57, 31), 'dirt', 'street runs east');
  assert.equal(typeAt(grid, 12, 28), 'dirt', 'north walk in front of the facades');
  assert.equal(typeAt(grid, 14, 33), 'dirt', 'south walk');
  assert.equal(typeAt(grid, 32, 42), 'dirt', 'plaza centre');
  assert.equal(typeAt(grid, 32, 38), 'dirt', 'plaza link');
  assert.equal(typeAt(grid, 12, 24), 'grass', 'facades are props over grass');
  assert.equal(typeAt(grid, 62, 31), 'sand', 'beach at the east end');
  assert.equal(typeAt(grid, 59, 31), 'sand', 'sand begins where the street stops');
});

test('every Town zone is reachable from the spawn around the solid props', () => {
  const world = generateTown(TOWN_SEED);
  const props = propsForLocation('town', createLocationRecord('town'));
  const blocked = locationBlockedTiles(props);
  const targets = [
    { x: 3, y: 31 }, // Park door
    { x: 12, y: 28 }, // Home door
    { x: 26, y: 28 }, // Shop door
    { x: 62, y: 31 }, // beach stub
    { x: 27, y: 41 } // plaza, beside the fountain
  ];
  for (const target of targets) {
    const path = findPath(world.grid, world.spawn, target, blocked);
    assert.ok(path.length > 0, `path to ${target.x},${target.y}`);
    assert.deepEqual(path.at(-1), target);
    for (const step of path) assert.ok(isWalkable(typeAt(world.grid, step.x, step.y)));
  }
});

test('Town declares the template, spawn, theme, menu row, and four facades', () => {
  const def = LOCATIONS.town;
  assert.equal(def.enabled, true);
  assert.equal(def.template, 'town');
  assert.equal(def.label, 'Town');
  assert.deepEqual(def.spawn, { x: 32, y: 46 });
  assert.equal(def.menu.label, 'Town');
  assert.ok(locationTheme('town'));

  const buildings = propsForLocation('town').filter(prop => prop.type === 'building');
  assert.equal(buildings.length, 4);
  assert.deepEqual(buildings.map(prop => prop.x), [9, 23, 37, 51]);

  const record = createLocationRecord('town');
  assert.equal(record.layout, 'town');
  assert.deepEqual(decodeTerrain(record.terrain), generateTown(TOWN_SEED).grid);
  assert.equal(locationLayout('town'), 'town');
});

test('Town has doors to the Park, Home, and Shop but no Library door yet', () => {
  const world = generateTown(TOWN_SEED);
  const doors = doorsFor('town', { terrain: world.grid, spawn: world.spawn });
  assert.deepEqual(doors.map(door => door.kind), ['travel', 'travel', 'travel']);
  assert.deepEqual(doors.map(door => door.to), ['park', 'home', 'shop']);
  assert.deepEqual(doors.map(door => door.prompt), [
    'Head into the park?',
    'Go home?',
    'Step into the shop?'
  ]);
  assert.equal(new Set(doors.map(door => `${door.x},${door.y}`)).size, 3);

  const byTarget = new Map(doors.map(door => [door.to, door]));
  assert.deepEqual({ x: byTarget.get('park').x, y: byTarget.get('park').y }, { x: 3, y: 31 });
  assert.deepEqual({ x: byTarget.get('home').x, y: byTarget.get('home').y }, { x: 12, y: 28 });
  assert.deepEqual({ x: byTarget.get('shop').x, y: byTarget.get('shop').y }, { x: 26, y: 28 });
  for (const door of doors) {
    assert.ok(isWalkable(typeAt(world.grid, door.x, door.y)), `${door.to} door is walkable`);
    assert.ok(world.componentKeys.has(`${door.x},${door.y}`), `${door.to} door is reachable`);
  }
  assert.equal(doors.some(door => door.to === 'library'), false);
});

test('Park, Home, and Shop doors are reparented to Town', () => {
  const park = worldFor('park', 'town-reparent-park');
  const parkDoor = doorFor('park', { terrain: park.grid, spawn: park.spawn });
  assert.equal(parkDoor.to, 'town');
  assert.equal(parkDoor.prompt, 'Head into town?');

  const home = worldFor('home');
  const homeDoor = doorFor('home', { terrain: home.grid, spawn: home.spawn });
  assert.equal(homeDoor.to, 'town');
  assert.equal(homeDoor.prompt, 'Back to town?');

  const shop = worldFor('shop');
  const shopDoor = doorFor('shop', { terrain: shop.grid, spawn: shop.spawn });
  assert.equal(shopDoor.to, 'town');
  assert.equal(shopDoor.prompt, 'Back to town?');
});

test('Town is the nearby hub in the travel menu and still lists every destination', () => {
  const targets = travelTargets('town');
  assert.deepEqual(targets.map(target => target.id), ['park', 'home', 'shop']);
  assert.deepEqual(targets.map(target => target.nearby), [true, true, true]);
  assert.equal(targets[0].label, 'Park');

  const fromPark = travelTargets('park');
  assert.deepEqual(fromPark.map(target => target.id), ['town', 'home', 'shop']);
  assert.deepEqual(fromPark.map(target => target.nearby), [true, false, false]);

  for (const id of ['home', 'shop']) {
    const row = travelTargets(id).find(target => target.id === 'town');
    assert.ok(row?.nearby, `${id} should mark Town Nearby`);
  }
});

test('Town has six stable residents who are never written into the save', () => {
  const world = generateTown(TOWN_SEED);
  const props = propsForLocation('town', createLocationRecord('town'));
  const blocked = locationBlockedTiles(props);
  const residents = residentsFor('town');
  assert.equal(residents.length, 6);
  assert.equal(new Set(residents.map(resident => resident.id)).size, 6);
  assert.equal(new Set(residents.map(resident => resident.name)).size, 6);
  assert.equal(new Set(residents.map(resident => resident.recipe.seed)).size, 6);

  for (const resident of residents) {
    assert.equal(resident.resident, true);
    assert.ok(isWalkable(typeAt(world.grid, resident.x, resident.y)), `${resident.id} stands on ground`);
    assert.ok(!blocked.has(`${resident.x},${resident.y}`), `${resident.id} is not inside a prop`);
  }

  const record = captureLocationRecord({
    seed: TOWN_SEED,
    terrain: world.grid,
    player: { x: world.spawn.x, y: world.spawn.y, direction: 0 },
    npcs: residents.map(resident => ({
      ...resident,
      inventory: [],
      equipped: [],
      coins: 0,
      stabledCompanions: []
    })),
    forage: null
  });
  assert.deepEqual(record.npcs, []);

  // The shopkeeper is a Shop record, not a Town resident.
  const shop = createShopLocation();
  assert.ok(shop.npcs.length > 0);
  assert.equal(residents.some(resident => resident.id === 'shopkeeper'), false);
});

test('Town residents stroll with the lightweight wander fallback', () => {
  const world = generateTown(TOWN_SEED);
  const game = new Game();
  game.terrain = world.grid;
  game.wander = true;
  game.companions = [];
  game.homeBuddies = [];
  game.miniGames = [];
  game.player = game.makeCharacter({ id: 'player', x: 20, y: 20 }, true);
  game.behaviorRuntime = { update() {} };

  const resident = game.makeCharacter(residentsFor('town')[0], false);
  resident.resident = true;
  resident.wait = 0;
  game.npcs = [resident];
  game.updateNpc(resident, 1 / 60);
  assert.equal(resident.moving, true, 'a Town resident strolls without a behaviour actor');
});

test('props and doors never land on the spawn or each other', () => {
  const world = generateTown(TOWN_SEED);
  const record = createLocationRecord('town');
  const declared = LOCATIONS.town.props.length;
  const props = propsForLocation('town', record);
  assert.equal(props.length, declared, 'no solid prop dropped for an overlap');

  const blocked = locationBlockedTiles(props);
  const doors = doorsFor('town', { terrain: world.grid, spawn: world.spawn });
  const reserved = [world.spawn, ...doors.map(door => ({ x: door.x, y: door.y }))];
  for (const tile of reserved) {
    assert.ok(!blocked.has(`${tile.x},${tile.y}`), `prop blocks ${tile.x},${tile.y}`);
  }
});

test('a legacy park record keeps its terrain, doors, and scenery and gets no new props', () => {
  const legacy = generateWorld('legacy-town-slice');
  const terrain = encodeTerrain(legacy.grid);
  const record = {
    seed: 'legacy-town-slice',
    terrain,
    player: { x: 12, y: 14, direction: 2 },
    npcs: [],
    forage: null
  };

  assert.equal(layoutMatches('park', record), false);
  assert.deepEqual(propsForLocation('park', record), []);
  assert.equal(locationTheme('park', record), null);
  assert.deepEqual(
    worldFor('park', record.seed, record).grid,
    generateWorld(record.seed).grid,
    'legacy scenery is grown from the legacy template'
  );

  const loaded = migrateSave({
    version: 4,
    currentLocation: 'park',
    locations: { park: record }
  });
  assert.equal(loaded.locations.park.layout, undefined);
  assert.equal(activeLocation(loaded).terrain, terrain);
  assert.deepEqual(decodeTerrain(loaded.locations.park.terrain), legacy.grid);
  assert.deepEqual(propsForLocation('park', loaded.locations.park), []);

  const savedTerrain = decodeTerrain(loaded.locations.park.terrain);
  const door = doorFor('park', { terrain: savedTerrain, spawn: legacy.spawn });
  assert.equal(door.to, 'town');
  assert.ok(isWalkable(typeAt(savedTerrain, door.x, door.y)), 'the legacy door still works');
});

test('fresh records carry a layout marker that survives capture and migration', () => {
  const park = createLocationRecord('park');
  assert.equal(park.layout, 'central-park');
  assert.ok(propsForLocation('park', park).length > 20);
  assert.ok(locationTheme('park', park));

  const captured = captureLocationRecord({ seed: park.seed, terrain: park.terrain }, park);
  assert.equal(captured.layout, 'central-park');

  const loaded = migrateSave({
    version: 4,
    currentLocation: 'park',
    locations: { park }
  });
  assert.equal(loaded.locations.park.layout, 'central-park');
  assert.ok(propsForLocation('park', loaded.locations.park).length > 20);

  const home = createLocationRecord('home');
  assert.equal(home.layout, 'interior');
  assert.deepEqual(propsForLocation('home', home), []);

  // The wizard still enters the park through a v1-shaped state; its marker is
  // carried into the v4 park record instead of being dropped on migration.
  const fromV1 = migrateSave({
    version: 1,
    worldSeed: park.seed,
    layout: 'central-park',
    terrain: park.terrain,
    playerName: 'You',
    playerRecipe: { seed: 'you', look: {} },
    player: { x: park.player.x, y: park.player.y },
    npcs: [],
    forage: null
  });
  assert.equal(fromV1.locations.park.layout, 'central-park');
  assert.ok(propsForLocation('park', fromV1.locations.park).length > 20);
});
