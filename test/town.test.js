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
import {
  locationBlockedTiles,
  propOpenings,
  propTiles
} from '../src/location_props.js';
import { activeLocation, captureLocationRecord, migrateSave } from '../src/storage.js';
import { Game } from '../src/game.js';

const TOWN_SEED = LOCATIONS.town.seed;
const ENTERABLE = [
  { to: 'home', x: 23, y: 17 },
  { to: 'shop', x: 8, y: 17 },
  { to: 'library', x: 38, y: 17 },
  { to: 'cafe', x: 53, y: 17 },
  { to: 'bakery', x: 8, y: 27 },
  { to: 'clinic', x: 23, y: 27 },
  { to: 'rose-cottage', x: 38, y: 27 },
  { to: 'workshop-north', x: 53, y: 27 },
  { to: 'maple-house', x: 8, y: 39 },
  { to: 'workshop-south', x: 23, y: 39 },
  { to: 'willow-house', x: 38, y: 39 },
  { to: 'hill-house', x: 53, y: 39 }
];

function townWorld() {
  return generateTown(TOWN_SEED);
}

function townProps(record = null) {
  return propsForLocation('town', record || createLocationRecord('town'));
}

test('Town is a valid 64 × 64 world with a walkable spawn and one component', () => {
  for (const seed of [TOWN_SEED, 'town-b', 'town-c']) {
    const world = generateTown(seed);
    assert.equal(world.template, 'town');
    assert.equal(world.layout, 'town-grid');
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

test('Town paints a grid of two-tile streets, pavements, a ring, and the east cove', () => {
  const grid = townWorld().grid;

  // Two horizontal streets with a one-tile pavement on either side.
  for (const y of [20, 42]) {
    assert.equal(typeAt(grid, 5, y), 'dirt', `H street at y ${y}`);
    assert.equal(typeAt(grid, 5, y + 1), 'dirt', `H street is two tiles wide at y ${y}`);
    assert.equal(typeAt(grid, 5, y - 1), 'sand', `north pavement at y ${y}`);
    assert.equal(typeAt(grid, 5, y + 2), 'sand', `south pavement at y ${y}`);
  }

  // Three vertical streets, likewise two tiles with pavements.
  for (const x of [16, 31, 47]) {
    assert.equal(typeAt(grid, x, 10), 'dirt', `V street at x ${x}`);
    assert.equal(typeAt(grid, x + 1, 10), 'dirt', `V street is two tiles wide at x ${x}`);
    assert.equal(typeAt(grid, x - 1, 10), 'sand', `west pavement at x ${x}`);
    assert.equal(typeAt(grid, x + 2, 10), 'sand', `east pavement at x ${x}`);
  }

  // High street and the central plaza/crossroads.
  assert.equal(typeAt(grid, 5, 30), 'dirt', 'high street');
  assert.equal(typeAt(grid, 5, 31), 'dirt', 'high street is two tiles wide');
  assert.equal(typeAt(grid, 5, 29), 'sand', 'high street north pavement');
  assert.equal(typeAt(grid, 5, 32), 'sand', 'high street south pavement');
  assert.equal(typeAt(grid, 31, 34), 'dirt', 'plaza south of the fountain');

  // The ring closes around the town, including its corners.
  assert.equal(typeAt(grid, 2, 2), 'dirt', 'north-west ring corner');
  assert.equal(typeAt(grid, 61, 61), 'dirt', 'south-east ring corner');
  assert.equal(typeAt(grid, 2, 30), 'dirt', 'west ring beside the Park gate');
  assert.equal(typeAt(grid, 60, 10), 'dirt', 'east ring');

  // Facades sit on grass; the sand cove is the Beach exit.
  assert.equal(typeAt(grid, 8, 17), 'grass', 'inside the shop footprint');
  assert.equal(typeAt(grid, 6, 15), 'grass', 'facade block');
  assert.equal(typeAt(grid, 62, 31), 'sand', 'Beach door cove');
  assert.ok(typeAt(grid, 63, 36) === 'sand', 'cove reaches the east edge');
});

test('every Town door and zone is reachable from the spawn around the solid props', () => {
  const world = townWorld();
  const props = townProps();
  const blocked = locationBlockedTiles(props);
  const doors = doorsFor('town', { terrain: world.grid, spawn: world.spawn });
  const targets = [
    ...doors.map(door => ({ x: door.x, y: door.y })),
    { x: 29, y: 34 }, // plaza beside the bench
    { x: 2, y: 60 }, // ring south-west
    { x: 61, y: 5 }, // ring north-east
    { x: 31, y: 10 } // V2 north
  ];
  for (const target of targets) {
    const path = findPath(world.grid, world.spawn, target, blocked);
    assert.ok(path.length > 0, `path to ${target.x},${target.y}`);
    assert.deepEqual(path.at(-1), target);
    for (const step of path) assert.ok(isWalkable(typeAt(world.grid, step.x, step.y)));
  }
});

test('Town declares the grid layout, spawn, theme, menu row, and 12 buildings', () => {
  const def = LOCATIONS.town;
  assert.equal(def.enabled, true);
  assert.equal(def.template, 'town');
  assert.equal(def.layout, 'town-grid');
  assert.equal(def.label, 'Town');
  assert.deepEqual(def.spawn, { x: 31, y: 35 });
  assert.equal(def.menu.label, 'Town');
  assert.ok(locationTheme('town'));

  const buildings = townProps().filter(prop => prop.type === 'building');
  assert.ok(buildings.length >= 12, 'the grid blocks hold at least twelve buildings');
  assert.equal(buildings.length, 12);
  assert.equal(new Set(buildings.map(prop => `${prop.x},${prop.y}`)).size, 12);
  assert.deepEqual(
    buildings.map(prop => prop.label),
    [
      'Shop', 'Home', 'Library', 'Café',
      'Bakery', 'Clinic', 'Rose Cottage', 'Workshop',
      'Maple House', 'Workshop', 'Willow House', 'Hill House'
    ]
  );

  const record = createLocationRecord('town');
  assert.equal(record.layout, 'town-grid');
  assert.deepEqual(decodeTerrain(record.terrain), townWorld().grid);
  assert.deepEqual(
    { x: record.player.x, y: record.player.y },
    { x: 31, y: 35 },
    'a fresh Town spawn is the new plaza tile'
  );
  assert.equal(locationLayout('town'), 'town-grid');
});

test('Town has doors to the Park, Beach, and every enterable building', () => {
  const world = townWorld();
  const doors = doorsFor('town', { terrain: world.grid, spawn: world.spawn });
  assert.deepEqual(doors.map(door => door.kind), Array(14).fill('travel'));
  assert.deepEqual(doors.map(door => door.to), [
    'park', 'home', 'shop', 'library', 'beach',
    'cafe', 'bakery', 'clinic', 'rose-cottage', 'workshop-north',
    'maple-house', 'workshop-south', 'willow-house', 'hill-house'
  ]);
  assert.deepEqual(doors.map(door => door.prompt), [
    'Head into the park?',
    'Go home?',
    'Step into the shop?',
    'Visit the library?',
    'Walk down to the beach?',
    'Step into the café?',
    'Visit the bakery?',
    'Visit the clinic?',
    'Call at Rose Cottage?',
    'Knock at the workshop?',
    'Call at Maple House?',
    'Knock at the workshop?',
    'Call at Willow House?',
    'Call at Hill House?'
  ]);
  assert.equal(new Set(doors.map(door => `${door.x},${door.y}`)).size, 14);

  const byTarget = new Map(doors.map(door => [door.to, door]));
  assert.deepEqual({ x: byTarget.get('park').x, y: byTarget.get('park').y }, { x: 2, y: 31 });
  assert.deepEqual({ x: byTarget.get('home').x, y: byTarget.get('home').y }, { x: 23, y: 17 });
  assert.deepEqual({ x: byTarget.get('shop').x, y: byTarget.get('shop').y }, { x: 8, y: 17 });
  assert.deepEqual({ x: byTarget.get('library').x, y: byTarget.get('library').y }, { x: 38, y: 17 });
  assert.deepEqual({ x: byTarget.get('beach').x, y: byTarget.get('beach').y }, { x: 62, y: 31 });
  for (const door of doors) {
    assert.ok(isWalkable(typeAt(world.grid, door.x, door.y)), `${door.to} door is walkable`);
    assert.ok(world.componentKeys.has(`${door.x},${door.y}`), `${door.to} door is reachable`);
  }
});

test('interior doors stand inside an enterable footprint, not on the pavement', () => {
  const props = townProps();
  const blocked = locationBlockedTiles(props);
  const buildings = props.filter(prop => prop.type === 'building');
  const doors = doorsFor('town', { terrain: townWorld().grid, spawn: townWorld().spawn });

  for (const expected of ENTERABLE) {
    const door = doors.find(entry => entry.to === expected.to);
    assert.ok(door, `${expected.to} door exists`);
    assert.deepEqual({ x: door.x, y: door.y }, { x: expected.x, y: expected.y });

    const host = buildings.find(building => (
      propTiles(building).some(tile => tile.x === door.x && tile.y === door.y)
    ));
    assert.ok(host, `${expected.to} door is inside a building footprint`);
    assert.equal(door.x, host.x + 2);
    assert.equal(door.y, host.y + 2);
    assert.ok(blocked.has(`${host.x + 2},${host.y + 3}`) === false, 'front opening stays walkable');
    assert.ok(!blocked.has(`${door.x},${door.y}`), 'inner trigger tile stays walkable');
    assert.ok(!blocked.has(`${door.x},${door.y + 1}`), 'the doorway is a two-tile corridor');
  }

  // Every building now has a doorway, so no facade is left as a solid shell.
  const shells = buildings.filter(building => propOpenings(building).length === 0);
  assert.equal(shells.length, 0, 'each town facade opens onto a room');
  assert.equal(ENTERABLE.length, buildings.length);
  for (const building of buildings) {
    const door = doors.find(entry => entry.x === building.x + 2 && entry.y === building.y + 2);
    assert.ok(door, `${building.label} has an inner door`);
  }
});

test('openings are excluded from locationBlockedTiles and still collide around them', () => {
  const shop = townProps().find(prop => prop.type === 'building' && prop.x === 6 && prop.y === 15);
  assert.deepEqual(propOpenings(shop), [{ dx: 2, dy: 3 }, { dx: 2, dy: 2 }]);
  const blocked = locationBlockedTiles([shop]);
  assert.equal(blocked.has('8,17'), false, 'inner trigger is walkable');
  assert.equal(blocked.has('8,18'), false, 'front doorway is walkable');
  assert.equal(blocked.has('7,17'), true, 'the wall beside the door is solid');
  assert.equal(blocked.has('8,16'), true, 'the wall behind the trigger is solid');

  // The interior trigger is reachable from the pavement through the doorway.
  const world = townWorld();
  const path = findPath(world.grid, { x: 8, y: 19 }, { x: 8, y: 17 }, blocked);
  assert.deepEqual(path, [{ x: 8, y: 18 }, { x: 8, y: 17 }]);
});

test('Town residents are ten stable neighbours, walkable and outside every prop', () => {
  const world = townWorld();
  const blocked = locationBlockedTiles(townProps());
  const residents = residentsFor('town');
  assert.equal(residents.length, 10);
  assert.equal(new Set(residents.map(resident => resident.id)).size, 10);
  assert.equal(new Set(residents.map(resident => resident.name)).size, 10);
  assert.equal(new Set(residents.map(resident => resident.recipe.seed)).size, 10);

  for (const resident of residents) {
    assert.equal(resident.resident, true);
    assert.ok(isWalkable(typeAt(world.grid, resident.x, resident.y)), `${resident.id} stands on ground`);
    assert.ok(!blocked.has(`${resident.x},${resident.y}`), `${resident.id} is not inside a prop`);
    assert.ok(
      findPath(world.grid, world.spawn, { x: resident.x, y: resident.y }, blocked).length > 0,
      `${resident.id} is reachable from the spawn`
    );
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
  const world = townWorld();
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
  const world = townWorld();
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

test('bumping the inner trigger of each Town door fires that travel target', () => {
  const world = townWorld();
  const props = townProps();
  const doors = doorsFor('town', { terrain: world.grid, spawn: world.spawn });

  const starts = {
    park: { x: 3, y: 31, dx: -1, dy: 0 },
    home: { x: 23, y: 18, dx: 0, dy: -1 },
    shop: { x: 8, y: 18, dx: 0, dy: -1 },
    library: { x: 38, y: 18, dx: 0, dy: -1 },
    beach: { x: 61, y: 31, dx: 1, dy: 0 },
    cafe: { x: 53, y: 18, dx: 0, dy: -1 },
    bakery: { x: 8, y: 28, dx: 0, dy: -1 },
    clinic: { x: 23, y: 28, dx: 0, dy: -1 },
    'rose-cottage': { x: 38, y: 28, dx: 0, dy: -1 },
    'workshop-north': { x: 53, y: 28, dx: 0, dy: -1 },
    'maple-house': { x: 8, y: 40, dx: 0, dy: -1 },
    'workshop-south': { x: 23, y: 40, dx: 0, dy: -1 },
    'willow-house': { x: 38, y: 40, dx: 0, dy: -1 },
    'hill-house': { x: 53, y: 40, dx: 0, dy: -1 }
  };

  for (const door of doors) {
    const start = starts[door.to];
    assert.ok(start, `test knows how to approach ${door.to}`);
    const game = new Game();
    game.terrain = world.grid;
    game.doors = doors;
    game.locationBlockedTiles = locationBlockedTiles(props);
    game.npcs = [];
    game.companions = [];
    game.homeBuddies = [];
    game.miniGames = [];
    game.interactive = true;
    game.paused = false;
    game.worldSuspended = false;
    game.player = game.makeCharacter({ id: 'player', x: start.x, y: start.y }, true);
    const fired = [];
    game.onDoor = doorHit => fired.push(doorHit.to);

    // Enterable doors are bumped from the threshold tile; the inner trigger
    // stops the step and fires travel.
    for (let step = 0; step < 4 && !fired.length; step += 1) {
      game.tryPlayerStep(start.dx, start.dy);
    }
    assert.deepEqual(fired, [door.to], `${door.to} door fired from its trigger tile`);
    assert.deepEqual(
      { x: game.player.x, y: game.player.y },
      { x: start.x, y: start.y },
      `${door.to} bump stops on the threshold`
    );
  }
});

test('a legacy Town layout rebuilds as the grid instead of a meadow, then settles', () => {
  const oldWorld = generateWorld('legacy-town-grid');
  const oldRecord = {
    seed: 'legacy-town-grid',
    layout: 'town',
    terrain: encodeTerrain(oldWorld.grid),
    player: { x: 12, y: 14, direction: 2 },
    npcs: [],
    forage: null
  };

  assert.equal(layoutMatches('town', oldRecord), false);
  assert.deepEqual(propsForLocation('town', oldRecord), [], 'stale markers get no new props');

  const rebuilt = worldFor('town', oldRecord.seed, oldRecord);
  assert.equal(rebuilt.template, 'town');
  assert.equal(rebuilt.layout, 'town-grid');
  assert.deepEqual(rebuilt.grid, generateTown(oldRecord.seed).grid);
  assert.notDeepEqual(rebuilt.grid, oldWorld.grid, 'the old meadow is not reused');
  assert.deepEqual(rebuilt.spawn, { x: 31, y: 35 }, 'the player resets to the grid spawn');

  // The same one-time upgrade main.js writes: marker, terrain, and spawn.
  const upgraded = captureLocationRecord({
    seed: rebuilt.seed,
    layout: locationLayout('town'),
    terrain: rebuilt.grid,
    player: { x: rebuilt.spawn.x, y: rebuilt.spawn.y, direction: 0 },
    npcs: [],
    forage: oldRecord.forage
  }, oldRecord);
  assert.equal(upgraded.layout, 'town-grid');
  assert.equal(layoutMatches('town', upgraded), true);
  assert.deepEqual(upgraded.player, { x: 31, y: 35, direction: 0 });
  assert.deepEqual(decodeTerrain(upgraded.terrain), rebuilt.grid);
  assert.equal(propsForLocation('town', upgraded).length, LOCATIONS.town.props.length);
  assert.deepEqual(worldFor('town', upgraded.seed, upgraded).grid, rebuilt.grid);

  // The loaded record is what the save layer exposes to the app.
  const loaded = migrateSave({
    version: 4,
    currentLocation: 'town',
    locations: { park: createLocationRecord('park'), town: oldRecord }
  });
  assert.equal(loaded.locations.town.layout, 'town', 'migration leaves the raw marker alone');
  assert.deepEqual(activeLocation(loaded).terrain, oldRecord.terrain);
  assert.equal(layoutMatches('town', activeLocation(loaded)), false, 'the app still sees a stale Town');
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
  assert.deepEqual(targets.map(target => target.id), ['park', 'home', 'shop', 'library', 'beach']);
  assert.deepEqual(targets.map(target => target.nearby), [true, true, true, true, true]);
  assert.equal(targets[0].label, 'Park');

  const fromPark = travelTargets('park');
  assert.deepEqual(fromPark.map(target => target.id), ['town', 'home', 'shop', 'library', 'beach']);
  assert.deepEqual(fromPark.map(target => target.nearby), [true, false, false, false, false]);

  for (const id of ['home', 'shop']) {
    const row = travelTargets(id).find(target => target.id === 'town');
    assert.ok(row?.nearby, `${id} should mark Town Nearby`);
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
