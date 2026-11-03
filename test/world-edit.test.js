import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LOCATIONS,
  buildingDoorsFor,
  createLocationRecord,
  linkLocationDoors,
  locationLayout,
  propsForLocation,
  sceneryForLocation,
  worldFor
} from '../src/locations.js';
import * as worldEdit from '../src/world_edit.js';
import {
  WORLD_PLACE_REASONS,
  applyWorldDraft,
  buildingDoorEntries,
  buildingMoveConfirmation,
  canPlaceWorldObject,
  isWorldBuilding,
  linkBuildingDoors,
  moveWorldObject,
  normalizeWorldProps,
  normalizeWorldScenery,
  planBuildingMove,
  reachableWorldTiles,
  resetLocationObjects,
  resetWorldObject,
  resolveWorldClick,
  rotateWorldObject,
  seedWorldProps,
  seedWorldScenery,
  styleWorldObject,
  worldBlockedTiles,
  worldEditorKeyAction,
  worldObjectAt,
  worldObjectCardActions,
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
      door: { to: 'shop', dx: 2, dy: 2, prompt: 'Step in?' }
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
  assert.deepEqual(captured.props[2].door, { to: 'shop', dx: 2, dy: 2, prompt: 'Step in?' });
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

test('the world hit test prefers a solid prop, then scenery', () => {
  const props = seedWorldProps([
    { type: 'rug', x: 5, y: 5 },
    { type: 'bench', x: 5, y: 5 },
    { type: 'lamp', x: 9, y: 9 }
  ]);
  const scenery = seedWorldScenery([
    { type: 'puffy-tree', x: 5, y: 5 },
    { type: 'flower-red', x: 9, y: 9 }
  ]);

  const rugOrBench = worldObjectAt(props, scenery, 5, 5);
  assert.equal(rugOrBench.kind, 'prop');
  assert.equal(rugOrBench.record.type, 'bench', 'the solid wins over ground cover and scenery');

  const lampOrFlower = worldObjectAt(props, scenery, 9, 9);
  assert.equal(lampOrFlower.record.type, 'lamp', 'a prop wins over scenery');

  const facade = normalizeWorldProps([{ type: 'building', x: 20, y: 20 }]);
  assert.equal(worldObjectAt(facade, [], 20, 20).record.type, 'building');
  assert.equal(worldObjectAt([], [], 20, 20), null);
  assert.equal(worldObjectAt([], [], -1, 0), null);
});

test('world-object card actions omit rotate for scenery and style/rotate for buildings', () => {
  const bench = seedWorldProps([{ type: 'bench', x: 3, y: 3 }])[0];
  const tree = seedWorldScenery([{ type: 'puffy-tree', x: 3, y: 3 }])[0];
  const building = normalizeWorldProps([{ type: 'building', x: 3, y: 3 }])[0];

  assert.deepEqual(worldObjectCardActions('prop', bench), ['move', 'style', 'rotate', 'reset', 'close']);
  assert.deepEqual(worldObjectCardActions('scenery', tree), ['move', 'style', 'reset', 'close']);
  assert.deepEqual(worldObjectCardActions('prop', building), ['move', 'reset', 'close']);
  assert.deepEqual(worldObjectCardActions('scenery', null), ['close']);
});

test('a click prefers a character over the prop under them', () => {
  const bench = seedWorldProps([{ type: 'bench', x: 5, y: 5 }])[0];
  const hit = { kind: 'prop', record: bench };
  const character = { id: 'npc-1', x: 5, y: 5 };

  assert.equal(resolveWorldClick({ character, hit }), 'character');
  assert.equal(resolveWorldClick({ character, hit, card: true }), 'character');
  assert.equal(
    resolveWorldClick({ character, hit, draft: true }),
    'place-draft',
    'a live draft owns the click even over a character'
  );
  assert.equal(resolveWorldClick({ hit }), 'open-object');
});

test('empty ground closes the card and falls through to walking', () => {
  const lamp = seedWorldProps([{ type: 'lamp', x: 9, y: 9 }])[0];
  assert.equal(resolveWorldClick(), 'walk');
  assert.equal(resolveWorldClick({ card: true }), 'close-card');
  assert.equal(
    resolveWorldClick({ card: true, hit: { kind: 'prop', record: lamp } }),
    'open-object',
    'clicking another object switches cards'
  );
  assert.equal(
    resolveWorldClick({ draft: true }),
    'place-draft',
    'a draft places on empty ground instead of walking'
  );
});

test('keyboard capture is draft-only', () => {
  const idle = { draft: false, card: false };
  for (const key of [
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
    'w', 'a', 's', 'd', 'r', 'c', 'Enter', ' ', 'Escape'
  ]) {
    assert.equal(worldEditorKeyAction(key, idle), null, `${key} passes through with no surface open`);
  }

  assert.deepEqual(worldEditorKeyAction('Escape', { card: true }), { action: 'close-card' });
  assert.equal(worldEditorKeyAction('w', { card: true }), null, 'a card never steals movement');
  assert.equal(worldEditorKeyAction('r', { card: true }), null, 'a card never steals R');
  assert.equal(worldEditorKeyAction('Enter', { card: true }), null, 'a card never steals Enter');

  assert.deepEqual(worldEditorKeyAction('ArrowUp', { draft: true }), { action: 'move', dx: 0, dy: -1 });
  assert.deepEqual(worldEditorKeyAction('d', { draft: true }), { action: 'move', dx: 1, dy: 0 });
  assert.deepEqual(worldEditorKeyAction('R', { draft: true }), { action: 'rotate' });
  assert.deepEqual(worldEditorKeyAction('c', { draft: true }), { action: 'style' });
  assert.deepEqual(worldEditorKeyAction('Enter', { draft: true }), { action: 'place' });
  assert.deepEqual(worldEditorKeyAction('Escape', { draft: true }), { action: 'cancel' });
  assert.equal(worldEditorKeyAction('z', { draft: true }), null, 'unknown keys still pass through');

  // A building draft moves on the grid but never rotates or restyles.
  assert.equal(worldEditorKeyAction('r', { draft: true, rotatable: false }), null);
  assert.equal(worldEditorKeyAction('c', { draft: true, stylable: false }), null);
  assert.deepEqual(
    worldEditorKeyAction('ArrowLeft', { draft: true, rotatable: false }),
    { action: 'move', dx: -1, dy: 0 }
  );
});

test('reset this place restores props and scenery after any edit', () => {
  const defaults = {
    props: seedWorldProps([
      { type: 'bench', x: 3, y: 3 },
      { type: 'lamp', x: 8, y: 8 }
    ]),
    scenery: seedWorldScenery([{ type: 'puffy-tree', x: 4, y: 4, scale: 0.8 }])
  };
  const movedProps = applyWorldDraft(defaults.props, {
    uid: defaults.props[0].uid,
    x: 20,
    y: 20,
    rot: 2
  });
  const movedScenery = applyWorldDraft(defaults.scenery, {
    uid: defaults.scenery[0].uid,
    x: 12,
    y: 12,
    scale: 1.4
  });

  const reset = resetLocationObjects({ props: movedProps, scenery: movedScenery }, defaults);
  assert.deepEqual(reset.props, defaults.props);
  assert.deepEqual(reset.scenery, defaults.scenery);
});

test('a draft applies its tile, turn, variant, and scale without changing the uid', () => {
  const props = seedWorldProps([{ type: 'bench', x: 3, y: 3 }]);
  const uid = props[0].uid;
  const moved = applyWorldDraft(props, { uid, x: 8, y: 9, rot: 1, variant: 1, seed: '  oak-2 ' });
  assert.deepEqual(moved[0], {
    uid,
    type: 'bench',
    x: 8,
    y: 9,
    rot: 1,
    variant: 1,
    seed: 'oak-2'
  });
  assert.equal(applyWorldDraft(props, { uid: 'missing', x: 1, y: 1 }), props);

  const scenery = seedWorldScenery([{ type: 'puffy-tree', x: 2, y: 2, scale: 1 }]);
  const scaled = applyWorldDraft(scenery, { uid: scenery[0].uid, x: 4, y: 5, scale: 9 });
  assert.equal(scaled[0].x, 4);
  assert.equal(scaled[0].y, 5);
  assert.equal(scaled[0].scale, 1.6, 'scale is clamped to the catalogue range');
  assert.equal(scaled[0].uid, scenery[0].uid);
});

test('per-object reset restores the seeded record and leaves others alone', () => {
  const defaults = seedWorldProps([
    { type: 'bench', x: 3, y: 3 },
    { type: 'lamp', x: 8, y: 8 }
  ]);
  const moved = applyWorldDraft(defaults, {
    uid: defaults[0].uid,
    x: 20,
    y: 20,
    rot: 3,
    variant: 1
  });
  const reset = resetWorldObject(moved, defaults[0].uid, defaults);
  assert.deepEqual(reset[0], defaults[0]);
  assert.equal(reset[1].x, 8, 'the untouched object keeps its tile');
  assert.equal(resetWorldObject(moved, 'missing', defaults), moved);
  assert.equal(resetWorldObject(moved, defaults[0].uid, []), moved);
});

test('moving a solid recomputes blocked tiles and round-trips through the save', () => {
  const props = seedWorldProps([
    { type: 'bench', x: 12, y: 30 },
    { type: 'lamp', x: 20, y: 20 }
  ]);
  const before = worldBlockedTiles(props);
  assert.ok(before.has('12,30'));
  assert.ok(before.has('13,30'), 'the bench is two tiles wide');

  const moved = applyWorldDraft(props, { uid: 'prop-bench-12-30', x: 40, y: 41 });
  const after = worldBlockedTiles(moved);
  assert.equal(after.has('12,30'), false);
  assert.ok(after.has('40,41'));
  assert.ok(after.has('41,41'));

  const captured = captureLocationRecord({
    ...simpleRecord(),
    props: moved,
    scenery: seedWorldScenery([{ type: 'puffy-tree', x: 8, y: 22 }])
  });
  assert.deepEqual(captured.props, moved);
  assert.equal(captured.props[0].uid, 'prop-bench-12-30', 'the moved bench keeps its seeded uid');
  assert.equal(captured.props[0].x, 40);
  assert.deepEqual(activeLocation({
    currentLocation: 'park',
    locations: { park: captured }
  }).props, moved);
});

/* ------------------------------------------------------------------------ *
 * Phase 3: doors travel with buildings, and buildings move freely with scoots.
 * ------------------------------------------------------------------------ */

function townSetup() {
  const world = worldFor('town', LOCATIONS.town.seed);
  const props = propsForLocation('town');
  const layer = linkLocationDoors('town', {
    terrain: world.grid,
    spawn: LOCATIONS.town.spawn,
    props
  });
  return { terrain: world.grid, scenery: world.scenery, ...layer };
}

test('town travel doors attach to their building and keep their tile and prompt', () => {
  const { terrain, props, doors, fixedDoors } = townSetup();
  const buildings = props.filter(isWorldBuilding);
  assert.equal(buildings.length, 12);
  for (const building of buildings) {
    assert.ok(building.door, `${building.label} owns a door`);
    assert.equal(building.door.dx, 2);
    assert.equal(building.door.dy, 2);
  }

  const shop = props.find(record => record.label === 'Shop');
  assert.deepEqual(shop.door, {
    to: 'shop',
    dx: 2,
    dy: 2,
    prompt: 'Step into the shop?'
  });

  // Every original trigger still exists at the same tile, now derived from its
  // building record.
  for (const door of doors) {
    assert.ok(isWalkable(typeAt(terrain, door.x, door.y)), `${door.to} is on walkable ground`);
  }
  assert.deepEqual(
    doors.find(door => door.to === 'shop'),
    { x: 8, y: 17, to: 'shop', kind: 'travel', id: 'building-prop-building-6-15', prompt: 'Step into the shop?', confirm: 'Travel', cancel: 'Cancel' }
  );

  // Only the park gate and the beach path are still data-driven.
  assert.deepEqual(
    fixedDoors.map(door => `${door.to}@${door.x},${door.y}`),
    ['park@2,31', 'beach@62,31']
  );
  assert.ok(buildingDoorEntries(props).every(entry => entry.to !== 'park'));
});

test('a saved building keeps its own door instead of re-linking a stale one', () => {
  const { props } = townSetup();
  const shop = props.find(record => record.label === 'Shop');
  const home = props.find(record => record.label === 'Home');
  const saved = props.map(record => {
    if (record.uid === shop.uid) {
      return { ...record, x: home.x, y: home.y, door: { to: 'shop', dx: 3, dy: 1, prompt: 'Step inside?' } };
    }
    if (record.uid === home.uid) return { ...record, x: shop.x, y: shop.y };
    return record;
  });
  // The declarative doors now fall inside the swapped facades and are stale.
  const travel = [
    { to: 'shop', x: 8, y: 17, prompt: 'Step into the shop?' },
    { to: 'home', x: 23, y: 17, prompt: 'Go home?' }
  ];
  const linked = linkBuildingDoors(saved, travel);
  const nextShop = linked.props.find(record => record.uid === shop.uid);
  assert.deepEqual(nextShop.door, { to: 'shop', dx: 3, dy: 1, prompt: 'Step inside?' });
  assert.equal(linked.doors.length, 0, 'a declarative door on a linked facade is stale');
});


test('a moved building leaves no stale door at its old tile', () => {
  const { props } = townSetup();
  const shop = props.find(record => record.label === 'Shop');
  // Move the shop far away; its original tile no longer sits in a footprint.
  const moved = props.map(record => (
    record.uid === shop.uid ? { ...record, x: 30, y: 60 } : record
  ));
  const travel = [
    { to: 'shop', x: 8, y: 17, prompt: 'Step into the shop?' },
    { to: 'park', x: 2, y: 31, prompt: 'Head into the park?' }
  ];
  const linked = linkBuildingDoors(moved, travel);
  assert.equal(linked.doors.some(door => door.to === 'shop'), false, 'stale shop door is dropped');
  assert.equal(linked.doors.some(door => door.to === 'park'), true, 'unrelated fixed door is kept');
});


/* ------------------------------------------------------------------------ *
 * ------------------------------------------------------------------------ */

function buildingPlanBase(extra = {}) {
  const props = seedWorldProps([
    {
      type: 'building',
      x: 10,
      y: 10,
      label: 'House',
      openings: [{ dx: 2, dy: 2 }, { dx: 2, dy: 3 }],
      door: { to: 'shop', dx: 2, dy: 2, prompt: 'Step in?' }
    },
    ...(Array.isArray(extra.extraProps) ? extra.extraProps : [])
  ]);
  return {
    props,
    scenery: seedWorldScenery(extra.scenery || []),
    record: props.find(isWorldBuilding),
    target: extra.target || { x: 20, y: 20 },
    terrain: extra.terrain || grassTerrain(),
    spawn: extra.spawn || { x: 2, y: 2 },
    doors: extra.doors || [{ x: 60, y: 60, to: 'park' }],
    characters: extra.characters || [],
    room: extra.room ?? null
  };
}

test('a building moves freely to an empty footprint and keeps its door', () => {
  const base = buildingPlanBase();
  const plan = planBuildingMove(base);

  assert.equal(plan.ok, true, plan.reason || '');
  assert.deepEqual(plan.scoots, []);
  const house = plan.props.find(record => record.uid === base.record.uid);
  assert.equal(house.x, 20);
  assert.equal(house.y, 20);
  assert.equal(house.label, 'House');
  assert.deepEqual(house.door, base.record.door, 'the building keeps its own door');
  assert.deepEqual(plan.moves.building.from, { x: 10, y: 10 });
  assert.deepEqual(plan.moves.building.to, { x: 20, y: 20 });
  assert.deepEqual(plan.moves.door, {
    uid: plan.door.uid,
    to: 'shop',
    from: { x: 12, y: 12 },
    to: { x: 22, y: 22 }
  });

  // The plan never mutates its inputs.
  assert.equal(base.props.find(record => record.uid === base.record.uid).x, 10);
  assert.equal(base.props.length, plan.props.length);
});

test('a building move refuses overlaps, doors, spawn, people, terrain, bounds, and rooms', () => {
  assert.equal(planBuildingMove(buildingPlanBase({
    extraProps: [{ type: 'building', x: 22, y: 22, label: 'Other' }]
  })).reason, 'overlap');

  assert.equal(planBuildingMove(buildingPlanBase({
    doors: [{ x: 21, y: 21, to: 'park' }]
  })).reason, 'door');

  assert.equal(planBuildingMove(buildingPlanBase({
    spawn: { x: 21, y: 21 }
  })).reason, 'spawn');

  assert.equal(planBuildingMove(buildingPlanBase({
    characters: [{ x: 21, y: 21 }]
  })).reason, 'character');

  const wet = grassTerrain();
  wet[21][21] = 'water';
  assert.equal(planBuildingMove(buildingPlanBase({ terrain: wet })).reason, 'terrain');

  assert.equal(planBuildingMove(buildingPlanBase({ target: { x: 61, y: 20 } })).reason, 'outside-world');

  assert.equal(planBuildingMove(buildingPlanBase({
    room: [{ x: 20, y: 20 }, { x: 21, y: 20 }]
  })).reason, 'outside-room');
});

test('soft overlaps plan a scoot for props and scenery but leave ground cover alone', () => {
  const base = buildingPlanBase({
    extraProps: [
      { type: 'bench', x: 22, y: 22 },
      { type: 'rug', x: 21, y: 21 }
    ],
    scenery: [{ type: 'puffy-tree', x: 24, y: 23, scale: 1 }]
  });
  const plan = planBuildingMove(base);

  assert.equal(plan.ok, true, plan.reason || '');
  assert.equal(plan.scoots.length, 2);
  assert.deepEqual(plan.scoots.map(scoot => scoot.label), ['bench', 'puffy tree']);
  assert.deepEqual(plan.scoots.map(scoot => scoot.kind), ['prop', 'scenery']);

  const footprint = plan.tiles.map(tile => `${tile.x},${tile.y}`);
  for (const scoot of plan.scoots) {
    assert.equal(footprint.includes(`${scoot.to.x},${scoot.to.y}`), false, `${scoot.label} left the footprint`);
  }

  const bench = plan.props.find(record => record.type === 'bench');
  assert.equal(footprint.includes(`${bench.x},${bench.y}`), false);
  assert.equal(footprint.includes(`${bench.x + 1},${bench.y}`), false);
  assert.equal(plan.props.find(record => record.type === 'rug').x, 21, 'the rug stays beneath the building');
  assert.equal(plan.props.find(record => record.type === 'rug').y, 21);
  const tree = plan.scenery.find(item => item.type === 'puffy-tree');
  assert.equal(tree.x === 24 && tree.y === 23, false, 'the tree left its old tile');
  assert.equal(footprint.includes(`${tree.x},${tree.y}`), false);
  assert.ok(Math.abs(tree.x - 24) + Math.abs(tree.y - 23) <= 4, 'the tree lands nearby');
});

test('the confirmation lists the soft objects that will move', () => {
  const plan = planBuildingMove(buildingPlanBase({
    extraProps: [
      { type: 'bench', x: 22, y: 22 },
      { type: 'planter', x: 23, y: 20 }
    ],
    scenery: [{ type: 'puffy-tree', x: 24, y: 23, scale: 1 }]
  }));
  assert.equal(plan.ok, true, plan.reason || '');

  const copy = buildingMoveConfirmation(plan);
  assert.equal(copy.needed, true);
  assert.equal(copy.title, 'Place the house here?');
  assert.equal(
    copy.note,
    '3 objects will move nearby: bench, planter, puffy tree'
  );
  assert.equal(copy.confirm, 'Place and move them');
  assert.equal(copy.cancel, 'Cancel');
  assert.deepEqual(copy.labels, ['bench', 'planter', 'puffy tree']);

  const clean = buildingMoveConfirmation(planBuildingMove(buildingPlanBase()));
  assert.equal(clean.needed, false);
  assert.equal(clean.note, '');
  assert.equal(clean.confirm, 'Place');
});

test('an object with nowhere to go aborts the whole move', () => {
  const room = [];
  for (let y = 20; y < 24; y += 1) {
    for (let x = 20; x < 26; x += 1) room.push({ x, y });
  }
  const plan = planBuildingMove(buildingPlanBase({
    extraProps: [{ type: 'bench', x: 22, y: 22 }],
    room
  }));

  assert.equal(plan.ok, false);
  assert.equal(plan.reason, 'no-scoot-space');
  assert.equal(plan.blocker, 'bench');
  assert.equal(plan.props, undefined, 'nothing is handed back for a failed plan');
  assert.match(worldObjectReasonText(plan.reason, plan), /no room nearby.*bench/);
});

test('a building that walls off a door is refused as no-path', () => {
  const terrain = grassTerrain();
  for (let y = 0; y < 64; y += 1) {
    terrain[y][9] = 'water';
    terrain[y][16] = 'water';
  }
  const props = seedWorldProps([{ type: 'building', x: 30, y: 10, label: 'House' }]);
  const plan = planBuildingMove({
    props,
    scenery: [],
    record: props[0],
    target: { x: 10, y: 10 },
    terrain,
    doors: [{ x: 12, y: 60, to: 'park' }],
    spawn: { x: 12, y: 2 },
    characters: [],
    room: null
  });

  assert.equal(plan.ok, false);
  assert.equal(plan.reason, 'no-path');
  assert.equal(plan.props, undefined);
});

test('after the move every building trigger follows its inner tile and openings stay open', () => {
  const base = buildingPlanBase();
  const plan = planBuildingMove(base);
  assert.equal(plan.ok, true, plan.reason || '');

  assert.deepEqual(plan.door, {
    uid: base.record.uid,
    to: 'shop',
    dx: 2,
    dy: 2,
    x: 22,
    y: 22,
    prompt: 'Step in?'
  });
  const doors = buildingDoorsFor(plan.props);
  assert.deepEqual(
    doors.map(door => [door.to, door.x, door.y]),
    [['shop', 22, 22]]
  );
  assert.equal(buildingDoorEntries(plan.props)[0].prompt, 'Step in?');
  assert.equal(worldBlockedTiles(plan.props).has('22,22'), false, 'the doorway opening stays walkable');
  assert.equal(worldBlockedTiles(plan.props).has('21,20'), true, 'the facade around it still blocks');
});

test('a moved building round-trips through the save with its door', () => {
  const base = buildingPlanBase();
  const plan = planBuildingMove(base);
  const captured = captureLocationRecord({
    ...simpleRecord(),
    props: plan.props,
    scenery: plan.scenery
  });

  const reloaded = propsForLocation('park', captured);
  const house = reloaded.find(record => record.uid === base.record.uid);
  assert.equal(house.x, 20);
  assert.equal(house.y, 20);
  assert.deepEqual(house.door, base.record.door);
  assert.deepEqual(activeLocation({
    currentLocation: 'park',
    locations: { park: captured }
  }).props.find(record => record.uid === base.record.uid).x, 20);
});

test('resetting after a building move restores the default tile and door', () => {
  const base = buildingPlanBase({
    extraProps: [{ type: 'bench', x: 22, y: 22 }],
    scenery: [{ type: 'puffy-tree', x: 24, y: 23, scale: 1 }]
  });
  const plan = planBuildingMove(base);
  assert.equal(plan.ok, true, plan.reason || '');

  const reset = resetLocationObjects({ props: plan.props, scenery: plan.scenery }, {
    props: base.props,
    scenery: base.scenery
  });
  const house = reset.props.find(record => record.uid === base.record.uid);
  assert.equal(house.x, 10);
  assert.equal(house.y, 10);
  const door = buildingDoorEntries(reset.props)[0];
  assert.deepEqual([door.x, door.y, door.to], [12, 12, 'shop']);
  assert.deepEqual(reset.scenery.map(item => [item.x, item.y]), [[24, 23]]);
});

test('no building-swap helpers or card actions remain', () => {
  assert.equal(
    Object.keys(worldEdit).filter(key => /swap/i.test(key)).length,
    0,
    'the swap API is deleted, not merely unused'
  );
  assert.equal(typeof worldEdit.planBuildingMove, 'function');
  assert.equal(typeof worldEdit.buildingMoveConfirmation, 'function');
  const building = seedWorldProps([{ type: 'building', x: 3, y: 3 }])[0];
  assert.deepEqual(worldObjectCardActions('prop', building), ['move', 'reset', 'close']);
});
