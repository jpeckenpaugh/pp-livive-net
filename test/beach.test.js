import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WORLD_SIZE,
  TILE_TYPES,
  beachShoreline,
  decodeTerrain,
  findPath,
  generateBeach,
  generateTown,
  hashString,
  isWalkable,
  largestComponentFrom,
  mulberry32,
  typeAt
} from '../src/world.js';
import {
  LOCATIONS,
  allowsShells,
  createLocationRecord,
  doorsFor,
  locationTheme,
  propsForLocation,
  residentsFor,
  travelTargets,
  worldFor
} from '../src/locations.js';
import { locationBlockedTiles } from '../src/location_props.js';
import {
  FORAGE_CONFIG,
  basketSummary,
  collectForageAt,
  createForageState,
  findShellTile,
  growForage,
  normalizeForage,
  seedForage,
  seedShells
} from '../src/forage.js';
import { applyGoalEvent, validateGoalsData } from '../src/goals.js';
import { captureLocationRecord, migrateSave } from '../src/storage.js';
import goalsData from '../data/goals.json' with { type: 'json' };

const BEACH_SEED = LOCATIONS.beach.seed;

function seededRandom(seed = 'beach-shells') {
  return mulberry32(hashString(seed));
}

function beachWorld() {
  return generateBeach(BEACH_SEED);
}

test('Beach is a valid 64 × 64 shore with an east sea and one walkable component', () => {
  const world = beachWorld();
  assert.equal(world.template, 'beach');
  assert.equal(world.grid.length, WORLD_SIZE);
  for (const row of world.grid) {
    assert.equal(row.length, WORLD_SIZE);
    for (const tile of row) assert.ok(TILE_TYPES.includes(tile), `unknown tile ${tile}`);
  }

  assert.ok(isWalkable(typeAt(world.grid, world.spawn.x, world.spawn.y)), 'spawn is walkable');
  assert.ok(world.componentKeys.has(`${world.spawn.x},${world.spawn.y}`), 'spawn is in the component');
  assert.equal(largestComponentFrom(world.grid).length, world.component.length);
  assert.ok(world.component.length > 2800, 'the beach is one connected, mostly open map');

  // The sea runs the whole east edge; deep water is the far column.
  for (let y = 0; y < WORLD_SIZE; y += 4) {
    assert.equal(typeAt(world.grid, 62, y), 'water', `row ${y} ends in water`);
  }
  assert.equal(typeAt(world.grid, 5, 31), 'dirt', 'boardwalk at the Town gate');
  assert.equal(typeAt(world.grid, 20, 20), 'sand', 'open beach sand');
  assert.equal(typeAt(world.grid, 30, 45), 'sand', 'sand south of the boardwalk');

  // The waterline is curved, with a wet sand band before deep water.
  assert.notEqual(beachShoreline(10), beachShoreline(30));
  for (const y of [5, 20, 34, 50]) {
    const edge = beachShoreline(y);
    assert.equal(typeAt(world.grid, Math.floor(edge) + 1, y), 'sand', `shallow band row ${y}`);
    assert.equal(typeAt(world.grid, Math.ceil(edge) + 3, y), 'water', `deep water row ${y}`);
  }
});

test('Beach declares its template, spawn, Town door, theme, and shell opt-in', () => {
  const def = LOCATIONS.beach;
  assert.equal(def.enabled, true);
  assert.equal(def.template, 'beach');
  assert.equal(def.label, 'Beach');
  assert.deepEqual(def.spawn, { x: 5, y: 31 });
  assert.equal(def.menu.label, 'Beach');
  assert.equal(def.shells, true);
  assert.equal(allowsShells('beach'), true);
  assert.equal(allowsShells('park'), false);
  assert.ok(locationTheme('beach'));

  const record = createLocationRecord('beach');
  assert.equal(record.layout, 'beach');
  assert.deepEqual(decodeTerrain(record.terrain), beachWorld().grid);
  assert.equal(record.forage.shells.length, 0, 'shells seed on arrival');
  assert.equal(record.forage.nextShellAt, 0);

  const world = beachWorld();
  const doors = doorsFor('beach', { terrain: world.grid, spawn: world.spawn });
  assert.equal(doors.length, 1);
  assert.equal(doors[0].to, 'town');
  assert.equal(doors[0].prompt, 'Head back to town?');
  assert.deepEqual({ x: doors[0].x, y: doors[0].y }, { x: 3, y: 31 });
  assert.ok(isWalkable(typeAt(world.grid, doors[0].x, doors[0].y)));
});

test('Town opens an east door onto the Beach and lists it Nearby', () => {
  const town = generateTown(LOCATIONS.town.seed);
  const doors = doorsFor('town', { terrain: town.grid, spawn: town.spawn });
  const beachDoor = doors.find(door => door.to === 'beach');
  assert.ok(beachDoor);
  assert.equal(beachDoor.prompt, 'Walk down to the beach?');
  assert.deepEqual({ x: beachDoor.x, y: beachDoor.y }, { x: 62, y: 31 });
  assert.equal(typeAt(town.grid, beachDoor.x, beachDoor.y), 'sand', 'the door stands on the cove');

  const target = travelTargets('town').find(row => row.id === 'beach');
  assert.ok(target);
  assert.equal(target.label, 'Beach');
  assert.equal(target.nearby, true);
});

test('Beach props and residents stand on open sand and every zone is reachable', () => {
  const world = beachWorld();
  const record = createLocationRecord('beach');
  const declared = LOCATIONS.beach.props.length;
  const props = propsForLocation('beach', record);
  assert.equal(props.length, declared, 'no declared prop is dropped as an overlap');
  assert.equal(propsForLocation('beach', null).length, declared);

  for (const type of ['palm', 'umbrella', 'bench', 'lamp', 'pier']) {
    assert.ok(props.some(prop => prop.type === type), `beach needs a ${type}`);
  }
  const pier = props.find(prop => prop.type === 'pier');
  assert.equal(pier.rot, 1, 'the pier reaches east over the water');
  assert.deepEqual({ x: pier.x, y: pier.y }, { x: 43, y: 30 });

  const blocked = locationBlockedTiles(props);
  const residents = residentsFor('beach');
  assert.equal(residents.length, 2);
  for (const resident of residents) {
    assert.equal(resident.resident, true);
    assert.ok(isWalkable(typeAt(world.grid, resident.x, resident.y)), `${resident.id} stands on sand`);
    assert.ok(!blocked.has(`${resident.x},${resident.y}`), `${resident.id} is not inside a prop`);
  }

  const targets = [
    { x: 3, y: 31 }, // Town door
    { x: 46, y: 31 }, // end of the pier
    { x: 20, y: 55 }, // far southern sand
    { x: 24, y: 36 }, // Coral
    { x: 33, y: 25 } // Finn
  ];
  for (const target of targets) {
    const path = findPath(world.grid, world.spawn, target, blocked);
    assert.ok(path.length > 0, `path to ${target.x},${target.y}`);
    assert.deepEqual(path.at(-1), target);
    for (const step of path) assert.ok(isWalkable(typeAt(world.grid, step.x, step.y)));
  }

  // Both templates agree with the dispatch helper.
  assert.deepEqual(worldFor('beach', BEACH_SEED).grid, world.grid);
});

test('shells only seed on walkable sand and only where a location opts in', () => {
  const world = beachWorld();
  const state = createForageState();
  const seeded = seedForage(state, {
    grid: world.grid,
    shells: true,
    random: seededRandom(),
    nowMs: 1000
  });

  assert.equal(seeded.shellsAdded, FORAGE_CONFIG.shells.initial);
  assert.equal(seeded.applesAdded, 0, 'sand grows no apples');
  assert.equal(state.shells.length, FORAGE_CONFIG.shells.initial);
  assert.equal(state.nextShellAt, 1000 + FORAGE_CONFIG.shells.respawnMs);
  assert.equal(new Set(state.shells.map(shell => shell.id)).size, state.shells.length);
  for (const shell of state.shells) {
    assert.match(shell.id, /^shell:\d+,\d+$/);
    assert.equal(typeAt(world.grid, shell.x, shell.y), 'sand', 'shells wash up on sand only');
  }

  const grass = Array.from({ length: WORLD_SIZE }, () => Array.from({ length: WORLD_SIZE }, () => 'grass'));
  assert.equal(findShellTile(grass, { random: () => 0.5 }), null);
  const found = findShellTile(world.grid, { random: () => 0.1 });
  assert.deepEqual(found, { x: Math.floor(0.1 * WORLD_SIZE), y: Math.floor(0.1 * WORLD_SIZE) });

  const unseeded = createForageState();
  seedForage(unseeded, { grid: world.grid, shells: false, random: seededRandom(), nowMs: 1000 });
  assert.equal(unseeded.shells.length, 0);
  assert.equal(unseeded.nextShellAt, 0, 'the shell clock never starts without shells');
});

test('walking over a shell collects it into the basket exactly once', () => {
  const state = createForageState();
  state.shells.push({ id: 'shell:4,4', x: 4, y: 4 });

  const pickup = collectForageAt(state, { x: 4, y: 4, nowMs: 1000 });
  assert.equal(pickup.kind, 'shell');
  assert.deepEqual(pickup.item, { id: 'shell', label: 'Shell', icon: '🐚' });
  assert.deepEqual(state.basket, { apple: 0, mushroom: 0, shell: 1 });
  assert.equal(state.shells.length, 0);
  assert.equal(collectForageAt(state, { x: 4, y: 4, nowMs: 1100 }), null);

  const summary = basketSummary(state);
  assert.equal(summary.shell, 1);
  assert.equal(summary.total, 1);
  assert.match(summary.label, /🐚 1/);
});

test('shells respawn on their clock up to the cap', () => {
  const world = beachWorld();
  const state = createForageState();
  seedShells(state, { grid: world.grid, count: 0, nowMs: 0 });
  state.nextShellAt = 1000;

  const first = growForage(state, {
    grid: world.grid,
    nowMs: 1000,
    random: seededRandom('shell-respawn')
  });
  assert.equal(first.shellsAdded, 1);
  assert.equal(state.shells.length, 1);
  assert.equal(state.nextShellAt, 1000 + FORAGE_CONFIG.shells.respawnMs);

  growForage(state, {
    grid: world.grid,
    nowMs: 1000 + FORAGE_CONFIG.shells.respawnMs * 100,
    random: seededRandom('shell-respawn-late')
  });
  assert.ok(state.shells.length <= FORAGE_CONFIG.shells.max);
  assert.ok(state.nextShellAt > 1000);
});

test('the beach shell goal completes once and pays its reward', () => {
  assert.deepEqual(validateGoalsData(goalsData), []);
  const goal = goalsData.goals.find(entry => entry.id === 'shell-collected');
  assert.ok(goal);
  assert.equal(goal.title, 'collect a beach shell');
  assert.equal(goal.hint, 'walk over a shell on the beach sand.');
  assert.equal(goal.event, 'shell.collected');
  assert.equal(goal.reward, 15);

  const first = applyGoalEvent({ completed: {} }, 'shell.collected', goalsData.goals, 5000);
  assert.equal(first.changed, true);
  assert.deepEqual(first.completed.map(entry => entry.id), ['shell-collected']);

  const again = applyGoalEvent(first.progress, 'shell.collected', goalsData.goals, 6000);
  assert.equal(again.changed, false);
  assert.deepEqual(again.progress, first.progress);
});

test('shells, their clock, and the basket round-trip through a save', () => {
  const world = beachWorld();
  const state = createForageState();
  seedForage(state, { grid: world.grid, shells: true, random: seededRandom(), nowMs: 1000 });
  const picked = state.shells[0];
  collectForageAt(state, { x: picked.x, y: picked.y, nowMs: 2000 });

  const beach = captureLocationRecord({
    seed: BEACH_SEED,
    layout: 'beach',
    terrain: world.grid,
    player: { ...world.spawn, direction: 1 },
    npcs: [],
    forage: state
  });
  const park = createLocationRecord('park');
  const loaded = migrateSave({
    version: 4,
    currentLocation: 'beach',
    locations: { park, beach }
  });

  const saved = loaded.locations.beach.forage;
  assert.equal(saved.basket.shell, 1);
  assert.equal(saved.shells.length, FORAGE_CONFIG.shells.initial - 1);
  assert.equal(saved.nextShellAt, 1000 + FORAGE_CONFIG.shells.respawnMs);
  for (const shell of saved.shells) {
    assert.equal(typeAt(world.grid, shell.x, shell.y), 'sand');
  }

  // A save written before shells existed still reads as an empty shell field.
  const legacy = normalizeForage({ apples: [], basket: { apple: 2, mushroom: 1 }, seeded: true });
  assert.deepEqual(legacy.shells, []);
  assert.equal(legacy.nextShellAt, 0);
  assert.equal(legacy.basket.shell, 0);
});
