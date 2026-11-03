import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LOCATIONS,
  createLocationRecord,
  locationLayout,
  propsForLocation,
  sceneryForLocation,
  worldFor
} from '../src/locations.js';
import {
  WORLD_PLACE_REASONS,
  canPlaceWorldObject,
  moveWorldObject,
  normalizeWorldProps,
  normalizeWorldScenery,
  reachableWorldTiles,
  resetLocationObjects,
  rotateWorldObject,
  seedWorldProps,
  seedWorldScenery,
  styleWorldObject,
  worldObjectReasonText
} from '../src/world_edit.js';
import { normalizeLocationProps } from '../src/location_props.js';
import { decodeTerrain, encodeTerrain, isWalkable, typeAt } from '../src/world.js';
import {
  activeLocation,
  captureLocationRecord,
  migrateSave
} from '../src/storage.js';

function grassTerrain() {
  return Array.from({ length: 64 }, () => Array.from({ length: 64 }, () => 'grass'));
}

function simpleRecord(extra = {}) {
  return {
    seed: 'world-edit-test',
    layout: locationLayout('park'),
    terrain: encodeTerrain(grassTerrain()),
    player: { x: 10, y: 10, direction: 0 },
    npcs: [],
    forage: null,
    ...extra
  };
}

test('untouched locations seed stable prop and scenery uids from data', () => {
  const first = propsForLocation('park');
  const second = propsForLocation('park');
  assert.equal(first.length, LOCATIONS.park.props.length);
  assert.ok(first.length > 20, 'the park keeps its full prop list');
  assert.deepEqual(second, first, 'seeding is deterministic');
  for (const record of first) {
    assert.match(record.uid, /^prop-/);
    assert.equal(typeof record.type, 'string');
  }

  const record = createLocationRecord('park');
  const generated = worldFor('park', record.seed).scenery;
  const scenery = sceneryForLocation('park', record, generated);
  assert.equal(scenery.length, generated.length);
  assert.deepEqual(sceneryForLocation('park', record, generated), scenery);
  for (const item of scenery) assert.match(item.uid, /^scenery-/);
});

test('seeding adds uids without changing the existing prop or scenery render data', () => {
  for (const id of ['park', 'town', 'beach', 'library']) {
    const seeded = propsForLocation(id);
    const legacy = normalizeLocationProps(LOCATIONS[id].props);
    assert.deepEqual(
      seeded.map(({ uid, ...record }) => record),
      legacy,
      `${id} props are identical apart from the new uid`
    );
  }

  const world = worldFor('park', LOCATIONS.park.seed);
  const seeded = sceneryForLocation('park', null, world.scenery);
  assert.deepEqual(
    seeded.map(({ type, x, y, scale }) => ({ type, x, y, scale })),
    world.scenery.map(({ type, x, y, scale }) => ({ type, x, y, scale })),
    'scenery keeps the same type, tile, and scale'
  );
  assert.deepEqual(
    seeded.map(({ uid }) => uid),
    world.scenery.map(item => `scenery-${item.type}-${item.x}-${item.y}`)
  );
});

test('a saved prop and scenery list wins over the data defaults', () => {
  const record = simpleRecord({
    props: [{ uid: 'prop-custom', type: 'bench', x: 3, y: 3 }],
    scenery: [{ uid: 'scenery-custom', type: 'puffy-tree', x: 4, y: 4, scale: 1.2 }]
  });
  const props = propsForLocation('park', record);
  const scenery = sceneryForLocation('park', record, []);
  assert.equal(props.length, 1);
  assert.equal(props[0].uid, 'prop-custom');
  assert.equal(props[0].x, 3);
  assert.equal(scenery.length, 1);
  assert.equal(scenery[0].uid, 'scenery-custom');
  assert.equal(scenery[0].scale, 1.2);
});

test('capture round-trips props and scenery in the compact save shape', () => {
  const props = seedWorldProps([
    { type: 'bench', x: 12, y: 30 },
    { type: 'rug', x: 12, y: 30 },
    {
      type: 'building',
      x: 20,
      y: 20,
      label: 'Shop',
      openings: [{ dx: 2, dy: 2 }],
      lot: 'A1',
      door: { to: 'shop', prompt: 'Step in?' }
    }
  ]);
  const scenery = seedWorldScenery([
    { type: 'puffy-tree', x: 8, y: 22, scale: 0.8 }
  ]);
  const captured = captureLocationRecord({
    ...simpleRecord(),
    props,
    scenery
  });
  assert.deepEqual(captured.props, props);
  assert.deepEqual(captured.scenery, scenery);
  assert.deepEqual(captured.props[0], {
    uid: 'prop-bench-12-30',
    type: 'bench',
    x: 12,
    y: 30,
    rot: 0,
    variant: 0
  });
  assert.deepEqual(captured.props[2].openings, [{ dx: 2, dy: 2 }]);
  assert.equal(captured.props[2].label, 'Shop');
  assert.equal(captured.props[2].lot, 'A1');
  assert.deepEqual(captured.props[2].door, { to: 'shop', prompt: 'Step in?' });
  assert.deepEqual(captured.scenery[0], {
    uid: 'scenery-puffy-tree-8-22',
    type: 'puffy-tree',
    x: 8,
    y: 22,
    scale: 0.8
  });

  const again = captureLocationRecord(captured, captured);
  assert.deepEqual(again, captured, 'capture is idempotent');
  assert.deepEqual(activeLocation({
    currentLocation: 'park',
    locations: { park: captured }
  }).props, props);
});

test('v4 migration preserves the object layer without a version bump', () => {
  const props = seedWorldProps([{ type: 'lamp', x: 5, y: 5 }]);
  const scenery = seedWorldScenery([{ type: 'flower-red', x: 6, y: 6, scale: 0.9 }]);
  const record = captureLocationRecord({ ...simpleRecord(), props, scenery });
  const migrated = migrateSave({
    version: 4,
    currentLocation: 'park',
    locations: { park: record }
  });
  assert.ok(migrated);
  assert.deepEqual(migrated.locations.park.props, props);
  assert.deepEqual(migrated.locations.park.scenery, scenery);
});

test('legacy records keep no lists and still generate the same scenery', () => {
  const legacy = {
    seed: 'legacy-seed',
    layout: 'meadow',
    terrain: encodeTerrain(grassTerrain()),
    player: { x: 1, y: 1, direction: 0 },
    npcs: [],
    forage: null
  };
  const captured = captureLocationRecord(legacy, legacy);
  assert.equal(Object.prototype.hasOwnProperty.call(captured, 'props'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(captured, 'scenery'), false);
  assert.deepEqual(propsForLocation('park', legacy), []);
  const generated = worldFor('park', legacy.seed).scenery;
  assert.equal(sceneryForLocation('park', legacy, generated).length, generated.length);
});

test('move, rotate, and style preserve the uid and normalise values', () => {
  const props = seedWorldProps([{ type: 'bench', x: 10, y: 10 }]);
  const uid = props[0].uid;
  assert.equal(uid, 'prop-bench-10-10');

  const moved = moveWorldObject(props, uid, 12, 14);
  assert.equal(moved[0].uid, uid, 'a moved object keeps its uid');
  assert.equal(moved[0].x, 12);
  assert.equal(moved[0].y, 14);
  assert.equal(props, moveWorldObject(props, 'missing-uid', 2, 2), 'unknown uid is a no-op');

  const turned = rotateWorldObject(moved, uid);
  assert.equal(turned[0].rot, 1);
  assert.equal(rotateWorldObject(turned, uid, 3)[0].rot, 0);

  const styled = styleWorldObject(turned, uid, { variant: 1, seed: '  bench-9  ' });
  assert.equal(styled[0].variant, 1);
  assert.equal(styled[0].seed, 'bench-9');
  assert.equal(styleWorldObject(styled, uid, { variant: 99 })[0].variant, 0);

  const scenery = seedWorldScenery([{ type: 'puffy-tree', x: 2, y: 2, scale: 1 }]);
  assert.equal(styleWorldObject(scenery, scenery[0].uid, { scale: 9 })[0].scale, 1.6);
});

test('every placement refusal has a stable reason and friendly copy', () => {
  const terrain = grassTerrain();
  const spawn = { x: 10, y: 10 };
  const doors = [{ x: 10, y: 20 }];
  const base = { terrain, spawn, doors };

  assert.equal(canPlaceWorldObject({ ...base, type: 'not-a-prop', x: 5, y: 5 }).reason, 'unknown');
  assert.equal(canPlaceWorldObject({ ...base, type: 'lamp', x: 64, y: 5 }).reason, 'outside-world');
  assert.equal(canPlaceWorldObject({
    ...base,
    type: 'lamp',
    x: 5,
    y: 5,
    roomTiles: [{ x: 6, y: 6 }]
  }).reason, 'outside-room');
  assert.equal(canPlaceWorldObject({
    ...base,
    type: 'lamp',
    x: 5,
    y: 5,
    props: seedWorldProps([{ type: 'lamp', x: 5, y: 5 }])
  }).reason, 'overlap');
  assert.equal(canPlaceWorldObject({ ...base, type: 'lamp', x: 10, y: 20 }).reason, 'door');
  assert.equal(canPlaceWorldObject({ ...base, type: 'lamp', x: 10, y: 10 }).reason, 'spawn');
  assert.equal(canPlaceWorldObject({
    ...base,
    type: 'lamp',
    x: 11,
    y: 11,
    characters: [{ x: 11, y: 11 }]
  }).reason, 'character');
  assert.equal(canPlaceWorldObject({
    ...base,
    type: 'lamp',
    x: 5,
    y: 5,
    allowedTerrain: ['sand']
  }).reason, 'terrain');

  for (const reason of WORLD_PLACE_REASONS) {
    assert.equal(typeof worldObjectReasonText(reason), 'string');
  }
});

test('a solid that walls off the spawn from a door is rejected as no-path', () => {
  const terrain = grassTerrain();
  // A water wall with one gap at x = 10. The spawn and door are on either side.
  for (let x = 0; x < 64; x += 1) {
    if (x !== 10) terrain[15][x] = 'water';
  }
  const spawn = { x: 10, y: 10 };
  const doors = [{ x: 10, y: 20 }];
  assert.ok(reachableWorldTiles(terrain, spawn).has('10,20'), 'the gap starts connected');

  const placement = canPlaceWorldObject({
    terrain,
    spawn,
    doors,
    type: 'lamp',
    x: 10,
    y: 15
  });
  assert.equal(placement.reason, 'no-path');
  assert.equal(placement.ok, false);
  assert.deepEqual(placement.tiles, [{ x: 10, y: 15 }]);

  // Scenery never blocks, so a tree in the same gap is fine.
  assert.equal(canPlaceWorldObject({
    kind: 'scenery',
    terrain,
    spawn,
    doors,
    type: 'puffy-tree',
    x: 10,
    y: 15
  }).ok, true);
});

test('ground cover overlaps other cover and sits under solids', () => {
  const terrain = grassTerrain();
  const rug = seedWorldProps([{ type: 'rug', x: 6, y: 6 }]);
  const lamp = seedWorldProps([{ type: 'lamp', x: 6, y: 6 }]);

  assert.equal(canPlaceWorldObject({
    terrain,
    type: 'lamp',
    x: 6,
    y: 6,
    props: rug
  }).ok, true, 'a solid may stand on a rug');

  assert.equal(canPlaceWorldObject({
    terrain,
    type: 'rug',
    x: 6,
    y: 6,
    props: lamp
  }).ok, true, 'ground cover may sit under a solid');

  assert.equal(canPlaceWorldObject({
    terrain,
    type: 'rug',
    x: 6,
    y: 6,
    props: rug
  }).ok, true, 'two ground pieces may overlap');
});

test('scenery validates bounds and catalogue types but never blocks', () => {
  const terrain = grassTerrain();
  assert.equal(canPlaceWorldObject({
    kind: 'scenery',
    type: 'puffy-tree',
    x: 3,
    y: 3,
    terrain,
    spawn: { x: 3, y: 3 },
    props: seedWorldProps([{ type: 'lamp', x: 3, y: 3 }])
  }).ok, true);
  assert.equal(canPlaceWorldObject({
    kind: 'scenery',
    type: 'puffy-tree',
    x: -1,
    y: 3
  }).reason, 'outside-world');
  assert.equal(canPlaceWorldObject({
    kind: 'scenery',
    type: 'not-scenery',
    x: 3,
    y: 3
  }).reason, 'unknown');
});

test('reset rebuilds a location from its data defaults', () => {
  const defaults = {
    props: [{ type: 'bench', x: 3, y: 3 }],
    scenery: [{ type: 'puffy-tree', x: 4, y: 4, scale: 0.8 }]
  };
  const seeded = seedWorldProps(defaults.props);
  const moved = moveWorldObject(seeded, seeded[0].uid, 20, 20);
  const record = simpleRecord({
    props: moved,
    scenery: seedWorldScenery([{ type: 'flower-red', x: 9, y: 9 }])
  });
  const reset = resetLocationObjects(record, defaults);
  assert.deepEqual(reset.props, seedWorldProps(defaults.props));
  assert.deepEqual(reset.scenery, seedWorldScenery(defaults.scenery));
  assert.equal(reset.props[0].x, 3);
  assert.equal(reset.seed, record.seed, 'other record fields are untouched');
});

test('normalisation drops bad rows and keeps valid openings', () => {
  const props = normalizeWorldProps([
    { type: 'bench', x: 1, y: 2 },
    { type: 'missing', x: 4, y: 4 },
    { type: 'lamp', x: 64, y: 4 },
    { type: 'bench', x: 1, y: 2 },
    {
      type: 'building',
      x: 20,
      y: 20,
      openings: [{ dx: 1, dy: 1 }, { dx: 9, dy: 9 }]
    }
  ]);
  assert.equal(props.length, 2);
  assert.deepEqual(props[0], {
    uid: 'prop-bench-1-2',
    type: 'bench',
    x: 1,
    y: 2,
    rot: 0,
    variant: 0
  });
  assert.deepEqual(props[1].openings, [{ dx: 1, dy: 1 }]);

  const scenery = normalizeWorldScenery([
    { type: 'puffy-tree', x: 1, y: 1 },
    { type: 'unknown', x: 1, y: 1 },
    { type: 'flower-red', x: 1, y: 1, uid: 'scenery-saved' }
  ]);
  assert.equal(scenery.length, 2);
  assert.equal(scenery[1].uid, 'scenery-saved');
});

test('saved terrain and other record fields survive capture', () => {
  const terrain = grassTerrain();
  const props = seedWorldProps([{ type: 'bench', x: 12, y: 30 }]);
  const captured = captureLocationRecord({
    ...simpleRecord(),
    terrain,
    props,
    scenery: seedWorldScenery([{ type: 'puffy-tree', x: 8, y: 22 }])
  });
  assert.deepEqual(decodeTerrain(captured.terrain), terrain);
  assert.ok(isWalkable(typeAt(decodeTerrain(captured.terrain), 12, 30)));
  assert.equal(captured.layout, locationLayout('park'));
});
