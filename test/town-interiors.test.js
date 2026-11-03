import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LOCATIONS,
  doorFor,
  doorsFor,
  isLocationEnabled,
  propsForLocation,
  residentsFor,
  travelTargets,
  worldFor
} from '../src/locations.js';
import {
  findPath,
  generateTown,
  isWalkable,
  typeAt
} from '../src/world.js';
import {
  locationBlockedTiles,
  propOpenings,
  propTiles
} from '../src/location_props.js';

const NEW_INTERIORS = [
  { id: 'cafe', role: 'barista' },
  { id: 'bakery', role: 'baker' },
  { id: 'clinic', role: 'nurse' },
  { id: 'rose-cottage', role: 'gardener' },
  { id: 'workshop-north', role: 'carpenter' },
  { id: 'maple-house', role: 'resident' },
  { id: 'workshop-south', role: 'carpenter' },
  { id: 'willow-house', role: 'resident' },
  { id: 'hill-house', role: 'resident' }
];

function townWorld() {
  return generateTown(LOCATIONS.town.seed);
}

test('the nine new interiors are enabled data-driven rooms without menu rows', () => {
  for (const { id } of NEW_INTERIORS) {
    const def = LOCATIONS[id];
    assert.ok(def, `${id} exists`);
    assert.equal(def.id, id);
    assert.equal(def.enabled, true, `${id} is enabled`);
    assert.equal(def.template, 'interior', `${id} reuses the interior template`);
    assert.equal(def.forage, false, `${id} is forage-free`);
    assert.equal(def.menu, undefined, `${id} stays out of the Player Menu`);
    assert.ok(def.theme?.wall && def.theme?.floor, `${id} has a small theme`);
    assert.ok(def.house, `${id} has a house spec`);

    const world = worldFor(id);
    assert.equal(world.template, 'interior');
    assert.ok(world.componentKeys.has(`${world.spawn.x},${world.spawn.y}`), `${id} spawn is connected`);
    assert.ok(isWalkable(typeAt(world.grid, world.spawn.x, world.spawn.y)), `${id} spawn is walkable`);

    const back = doorFor(id, { terrain: world.grid, spawn: world.spawn });
    assert.ok(back, `${id} has a return door`);
    assert.equal(back.to, 'town', `${id} returns to Town`);
    assert.ok(isWalkable(typeAt(world.grid, back.x, back.y)), `${id} door is walkable`);

    // The Player Menu still only lists the five labelled destinations.
    assert.equal(travelTargets('town').some(row => row.id === id), false);
  }
});

test('each interior is furnished with a resident clear of the spawn and door', () => {
  const roles = new Set(['barista', 'baker', 'nurse', 'gardener', 'carpenter', 'resident']);
  const residentIds = new Set();
  const residentNames = new Set();
  const residentSeeds = new Set();

  for (const { id, role } of NEW_INTERIORS) {
    const world = worldFor(id);
    const props = propsForLocation(id);
    assert.ok(props.length >= 8 && props.length <= 14, `${id} has a furnished room`);
    assert.equal(props.length, LOCATIONS[id].props.length, `${id} places every declared prop`);

    const blocked = locationBlockedTiles(props);
    const spawn = world.spawn;
    const door = LOCATIONS[id].door;
    assert.ok(!blocked.has(`${spawn.x},${spawn.y}`), `${id} spawn is clear of props`);
    assert.ok(!blocked.has(`${door.x},${door.y}`), `${id} door is clear of props`);
    assert.ok(findPath(world.grid, spawn, door, blocked).length > 0, `${id} door is reachable`);

    const residents = residentsFor(id);
    assert.equal(residents.length, 1, `${id} has one resident`);
    const resident = residents[0];
    assert.equal(resident.role, role, `${id} resident role`);
    assert.ok(roles.has(resident.role));
    assert.ok(!blocked.has(`${resident.x},${resident.y}`), `${id} resident is on open floor`);
    assert.notDeepEqual({ x: resident.x, y: resident.y }, spawn, `${id} resident is off the spawn`);
    assert.notDeepEqual({ x: resident.x, y: resident.y }, door, `${id} resident is off the door`);
    assert.ok(
      findPath(world.grid, spawn, { x: resident.x, y: resident.y }, blocked).length > 0,
      `${id} resident is reachable`
    );
    assert.ok(isWalkable(typeAt(world.grid, resident.x, resident.y)));

    assert.ok(!residentIds.has(resident.id), 'resident ids are unique');
    assert.ok(!residentNames.has(resident.name), 'resident names are unique');
    assert.ok(!residentSeeds.has(resident.recipe.seed), 'resident seeds are unique');
    residentIds.add(resident.id);
    residentNames.add(resident.name);
    residentSeeds.add(resident.recipe.seed);
  }
});

test('every Town door targets an enabled location on a unique inner tile', () => {
  const world = townWorld();
  const props = propsForLocation('town');
  const doors = doorsFor('town', { terrain: world.grid, spawn: world.spawn });
  const blocked = locationBlockedTiles(props);
  const buildings = props.filter(prop => prop.type === 'building');

  assert.equal(doors.length, 14, 'Park, Beach, and twelve enterable buildings');
  assert.equal(new Set(doors.map(door => `${door.x},${door.y}`)).size, doors.length, 'door tiles are unique');
  assert.equal(
    doors.map(door => door.to).filter(id => id !== 'beach').length,
    13,
    'Park plus twelve enterable buildings'
  );

  for (const door of doors) {
    assert.ok(LOCATIONS[door.to], `${door.to} exists`);
    assert.equal(isLocationEnabled(door.to), true, `${door.to} is enabled`);
    assert.ok(isWalkable(typeAt(world.grid, door.x, door.y)), `${door.to} door is walkable`);
    assert.ok(!blocked.has(`${door.x},${door.y}`), `${door.to} door is not under a prop`);
  }

  // Every building declares the two-tile doorway and its inner trigger.
  for (const building of buildings) {
    assert.deepEqual(propOpenings(building), [{ dx: 2, dy: 3 }, { dx: 2, dy: 2 }], `${building.label} opening`);
    const door = doors.find(entry => entry.x === building.x + 2 && entry.y === building.y + 2);
    assert.ok(door, `${building.label} has a door on its inner trigger`);
    assert.ok(!blocked.has(`${building.x + 2},${building.y + 3}`), `${building.label} front opening is open`);
    assert.ok(!blocked.has(`${building.x + 2},${building.y + 4}`), `${building.label} pavement is open`);
  }

  // The nine new building doors sit exactly on their interior ids.
  const byTarget = new Map(doors.map(door => [door.to, door]));
  for (const { id } of NEW_INTERIORS) {
    const building = buildings.find(prop => (
      propTiles(prop).some(tile => {
        const door = byTarget.get(id);
        return tile.x === door.x && tile.y === door.y;
      })
    ));
    assert.ok(building, `${id} door stands inside a building footprint`);
    assert.equal(byTarget.get(id).x, building.x + 2);
    assert.equal(byTarget.get(id).y, building.y + 2);
  }
});

test('existing Shop, Home, Library, and Beach doors keep their tiles', () => {
  const world = townWorld();
  const doors = doorsFor('town', { terrain: world.grid, spawn: world.spawn });
  const expected = {
    park: { x: 2, y: 31 },
    home: { x: 23, y: 17 },
    shop: { x: 8, y: 17 },
    library: { x: 38, y: 17 },
    beach: { x: 62, y: 31 }
  };
  for (const [id, tile] of Object.entries(expected)) {
    const door = doors.find(entry => entry.to === id);
    assert.ok(door, `${id} door survives`);
    assert.deepEqual({ x: door.x, y: door.y }, tile, `${id} tile is unchanged`);
  }
});
