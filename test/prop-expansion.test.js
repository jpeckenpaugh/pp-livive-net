import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LOCATIONS,
  createLocationRecord,
  doorsFor,
  propsForLocation,
  residentsFor,
  worldFor
} from '../src/locations.js';
import { findPath } from '../src/world.js';
import {
  LOCATION_PROP_IDS,
  PROP_PATTERNS,
  PROP_SIGN_STYLES,
  SOFT_PROP_SHAPES,
  canPlaceLocationProp,
  locationBlockedTiles,
  locationProp,
  locationPropSize,
  normalizeLocationProps,
  propDefinition,
  propDetail,
  propFootprintTiles,
  propRenderMeta,
  propSource,
  propTiles
} from '../src/location_props.js';

const INTERIORS = [
  'cafe',
  'bakery',
  'clinic',
  'rose-cottage',
  'workshop-north',
  'maple-house',
  'workshop-south',
  'willow-house',
  'hill-house'
];

const WAVE_ONE = [
  'cafe-counter', 'stool', 'cafe-table', 'awning',
  'display-case', 'oven', 'flour-sack',
  'exam-bed', 'supply-cabinet', 'privacy-screen',
  'workbench', 'tool-rack', 'wardrobe', 'vanity'
];

function key(tile) {
  return `${tile.x},${tile.y}`;
}

test('location records can resolve Home furniture ids through one catalog', () => {
  assert.equal(locationProp('couch'), null, 'couch is not in the location catalog');
  const couch = propDefinition('couch');
  assert.ok(couch, 'the shared resolver finds the Home couch');
  assert.equal(couch.shape, 'couch');
  assert.deepEqual(couch.size, { w: 2, h: 1 });
  assert.equal(couch.solid, true);
  assert.equal(propSource('couch'), 'home');
  assert.equal(propSource('bench'), 'location');
  assert.equal(propSource('not-a-prop'), null);

  // The location catalog keeps priority for the two shared ids.
  assert.equal(propDefinition('rug').shape, 'rug');
  assert.equal(propSource('rug'), 'location');

  const [record] = normalizeLocationProps([{ type: 'couch', x: 3, y: 4, variant: 1 }]);
  assert.deepEqual(record, { type: 'couch', x: 3, y: 4, rot: 0, variant: 1 });
  assert.deepEqual(propTiles(record), [{ x: 3, y: 4 }, { x: 4, y: 4 }]);
  assert.deepEqual(locationPropSize('couch', 1), { w: 1, h: 2 });

  const meta = propRenderMeta(record);
  assert.equal(meta.source, 'home');
  assert.equal(meta.shape, 'couch');
  assert.equal(meta.solid, true);
  assert.deepEqual(meta.size, { w: 2, h: 1 });
  assert.equal(meta.sortY, 4);
  assert.equal(meta.colors.base, '#8a6a4f', 'the Home warm variant palette resolves');

  const blocked = locationBlockedTiles([record]);
  assert.ok(blocked.has('3,4') && blocked.has('4,4'), 'a Home couch blocks its footprint');
  assert.equal(
    canPlaceLocationProp({ props: [record], type: 'armchair', x: 4, y: 4 }).reason,
    'occupied',
    'solid Home items share the location overlap rules'
  );
});

test('seeded detail is deterministic and derives from the seed alone', () => {
  const first = propDetail({ type: 'couch', x: 2, y: 3, seed: 'sunny-couch' });
  const moved = propDetail({ type: 'couch', x: 19, y: 27, seed: 'sunny-couch' });
  assert.deepEqual(first, moved, 'the same seed keeps its detail on another tile');
  assert.ok(PROP_PATTERNS.includes(first.pattern));
  assert.match(first.patternColor, /^#[0-9a-f]{6}$/i);
  assert.match(first.trim, /^#[0-9a-f]{6}$/i);

  const patterns = new Set();
  for (let index = 0; index < 24; index += 1) {
    patterns.add(propDetail({ type: 'bed', x: 1, y: 1, seed: `bed-${index}` }).pattern);
  }
  assert.ok(patterns.size > 1, 'seeds vary the cushion pattern');

  for (const shape of SOFT_PROP_SHAPES) {
    const detail = propDetail({ type: shape, x: 1, y: 1 });
    assert.ok(PROP_PATTERNS.includes(detail.pattern), `${shape} takes a seeded pattern`);
  }

  const fallback = propDetail({ type: 'armchair', x: 8, y: 9 });
  assert.deepEqual(fallback, propDetail({ type: 'armchair', x: 8, y: 9 }), 'no seed still reloads identically');
  assert.notEqual(fallback.seed, propDetail({ type: 'armchair', x: 8, y: 10 }).seed);

  const sign = propDetail({ type: 'building', x: 5, y: 5, label: 'Café', seed: 'cafe-sign' });
  assert.ok(PROP_SIGN_STYLES.includes(sign.sign), 'labelled props pick a sign style');
  assert.equal(propDetail({ type: 'building', x: 5, y: 5, seed: 'cafe-sign' }).sign, null, 'no label, no sign');
});

test('normalised records keep seeds and re-render the same detail after a round trip', () => {
  const normalized = normalizeLocationProps([
    { type: 'couch', x: 4, y: 4, seed: '  cushion-7  ' },
    { type: 'bed', x: 8, y: 8, detailSeed: 'quilt-2' }
  ]);
  assert.equal(normalized[0].seed, 'cushion-7', 'seeds are trimmed');
  assert.equal(normalized[1].seed, 'quilt-2', 'detailSeed is accepted');

  const reloaded = JSON.parse(JSON.stringify(normalized));
  assert.deepEqual(propRenderMeta(reloaded[0]), propRenderMeta(normalized[0]));
  assert.deepEqual(propDetail(reloaded[0]), propDetail(normalized[0]));
  assert.notEqual(propDetail(reloaded[0]).seed, propDetail(reloaded[1]).seed);
});

test('Wave 1 interior props are complete catalog rows with use metadata', () => {
  assert.equal(new Set(WAVE_ONE).size, WAVE_ONE.length, 'the wave list is unique');
  for (const id of WAVE_ONE) {
    const prop = locationProp(id);
    assert.ok(prop, `${id} exists`);
    assert.equal(prop.id, id);
    assert.equal(typeof prop.label, 'string');
    assert.ok(prop.label.length > 0);
    assert.ok(Number.isInteger(prop.size.w) && prop.size.w > 0, `${id} width`);
    assert.ok(Number.isInteger(prop.size.h) && prop.size.h > 0, `${id} height`);
    assert.equal(typeof prop.solid, 'boolean', `${id} solid`);
    assert.ok(typeof prop.shape === 'string' && prop.shape, `${id} shape`);
    assert.ok(prop.colors && typeof prop.colors.base === 'string', `${id} palette`);
    assert.ok(Array.isArray(prop.variants) && prop.variants.length >= 2, `${id} variants`);
    assert.equal(typeof prop.use?.kind, 'string', `${id} use kind`);
    assert.equal(typeof prop.use?.verb, 'string', `${id} use verb`);
    assert.equal(typeof prop.use?.line, 'string', `${id} use line`);
  }

  assert.equal(new Set(LOCATION_PROP_IDS).size, LOCATION_PROP_IDS.length, 'catalog ids are unique');
  for (const id of LOCATION_PROP_IDS) assert.equal(locationProp(id).id, id, `${id} key matches its id`);
});

test('the nine interiors reuse Home furniture and place every declared prop', () => {
  const shared = new Set();
  for (const id of INTERIORS) {
    const props = propsForLocation(id);
    const declared = LOCATIONS[id].props;
    assert.equal(props.length, declared.length, `${id} places every declared prop`);
    assert.ok(props.length >= 8, `${id} is furnished`);

    for (const prop of props) {
      const meta = propRenderMeta(prop);
      assert.ok(meta, `${id} ${prop.type} renders`);
      if (meta.source === 'home') shared.add(prop.type);
    }

    const seen = new Set();
    for (const prop of props) {
      const stamp = `${prop.type}:${prop.x},${prop.y}`;
      assert.ok(!seen.has(stamp), `${id} has no duplicate ${stamp}`);
      seen.add(stamp);
    }

    const solidTiles = new Set();
    for (const prop of props) {
      if (!propDefinition(prop.type).solid) continue;
      for (const tile of propTiles(prop)) {
        assert.ok(!solidTiles.has(key(tile)), `${id} solid props never overlap at ${key(tile)}`);
        solidTiles.add(key(tile));
      }
    }

    const seeds = props.map(prop => prop.seed).filter(Boolean);
    assert.equal(new Set(seeds).size, seeds.length, `${id} prop seeds are unique`);
  }

  for (const id of ['couch', 'armchair', 'bed', 'dining-table', 'chair', 'counter', 'dresser']) {
    assert.ok(shared.has(id), `interiors reuse the Home ${id}`);
  }
});

test('interior props keep the spawn, door, resident, and walking path clear', () => {
  for (const id of INTERIORS) {
    const world = worldFor(id);
    const props = propsForLocation(id);
    const blocked = locationBlockedTiles(props);
    const spawn = world.spawn;
    const door = LOCATIONS[id].door;
    const resident = residentsFor(id)[0];

    assert.ok(!blocked.has(key(spawn)), `${id} spawn is clear`);
    assert.ok(!blocked.has(key(door)), `${id} door is clear`);
    assert.ok(!blocked.has(key(resident)), `${id} resident is clear`);
    assert.ok(
      findPath(world.grid, spawn, door, blocked).length > 0,
      `${id} spawn can reach the door`
    );
    assert.ok(
      findPath(world.grid, spawn, residence(resident), blocked).length > 0,
      `${id} resident is reachable`
    );
  }
});

function residence(resident) {
  return { x: resident.x, y: resident.y };
}

test('collision footprints follow the shared size and solid flag', () => {
  assert.deepEqual(
    propFootprintTiles({ type: 'wardrobe', x: 10, y: 10 }),
    [{ x: 10, y: 10 }, { x: 11, y: 10 }]
  );
  assert.deepEqual(
    propFootprintTiles({ type: 'wardrobe', x: 10, y: 10, rot: 1 }),
    [{ x: 10, y: 10 }, { x: 10, y: 11 }]
  );

  const records = normalizeLocationProps([
    { type: 'wardrobe', x: 10, y: 10 },
    { type: 'rug', x: 10, y: 10 },
    { type: 'awning', x: 12, y: 10 }
  ]);
  const blocked = locationBlockedTiles(records);
  assert.ok(blocked.has('10,10') && blocked.has('11,10'), 'the wardrobe blocks two tiles');
  assert.equal(blocked.size, 2, 'ground cover and awnings never block');
});

const WAVE_TWO = [
  'fence', 'hedge', 'bin', 'mailbox', 'signpost', 'market-stall',
  'bus-stop', 'statue', 'flower-bed', 'string-lights', 'notice-board', 'bike-rack'
];
const WAVE_THREE = [
  'deck-chair', 'towel', 'cooler', 'sandcastle', 'surfboard',
  'buoy', 'shell-pile', 'beach-ball', 'kite', 'shower-post'
];
const WAVE_FOUR = [
  'globe', 'chalkboard', 'locker', 'reading-table', 'beanbag', 'easel', 'science-bench'
];

const WAVE_SOLID = {
  fence: true,
  hedge: true,
  bin: true,
  mailbox: true,
  signpost: true,
  'market-stall': true,
  'bus-stop': true,
  statue: true,
  'flower-bed': false,
  'string-lights': false,
  'notice-board': true,
  'bike-rack': true,
  'deck-chair': true,
  towel: false,
  cooler: true,
  sandcastle: true,
  surfboard: true,
  buoy: false,
  'shell-pile': false,
  'beach-ball': false,
  kite: false,
  'shower-post': true,
  globe: true,
  chalkboard: true,
  locker: true,
  'reading-table': true,
  beanbag: false,
  easel: true,
  'science-bench': true
};

const WAVE_BY_LOCATION = {
  town: WAVE_TWO,
  beach: WAVE_THREE,
  library: WAVE_FOUR
};

test('Waves 2–4 add complete, unique catalog rows with use metadata', () => {
  const waves = [...WAVE_TWO, ...WAVE_THREE, ...WAVE_FOUR];
  assert.equal(new Set(waves).size, waves.length, 'the wave lists are unique');
  assert.equal(waves.length, 29);
  for (const id of waves) {
    const prop = locationProp(id);
    assert.ok(prop, `${id} exists`);
    assert.equal(prop.id, id);
    assert.equal(typeof prop.label, 'string');
    assert.ok(prop.label.length > 0);
    assert.ok(Number.isInteger(prop.size.w) && prop.size.w > 0, `${id} width`);
    assert.ok(Number.isInteger(prop.size.h) && prop.size.h > 0, `${id} height`);
    assert.equal(prop.solid, WAVE_SOLID[id], `${id} solidity`);
    assert.ok(typeof prop.shape === 'string' && prop.shape, `${id} shape`);
    assert.equal(typeof prop.colors.base, 'string');
    assert.ok(Array.isArray(prop.variants) && prop.variants.length >= 2, `${id} variants`);
    assert.equal(typeof prop.use?.kind, 'string', `${id} use kind`);
    assert.equal(typeof prop.use?.verb, 'string', `${id} use verb`);
    assert.equal(typeof prop.use?.line, 'string', `${id} use line`);
  }

  assert.equal(new Set(LOCATION_PROP_IDS).size, LOCATION_PROP_IDS.length, 'catalog ids are unique');
  for (const id of LOCATION_PROP_IDS) assert.equal(locationProp(id).id, id, `${id} key matches its id`);
});

test('Town, Beach, and Library place every Wave 2–4 prop without drops or duplicates', () => {
  for (const [locationId, wave] of Object.entries(WAVE_BY_LOCATION)) {
    const record = createLocationRecord(locationId);
    const declared = LOCATIONS[locationId].props;
    const props = propsForLocation(locationId, record);
    assert.equal(props.length, declared.length, `${locationId} places every declared prop`);

    const byType = new Set(props.map(prop => prop.type));
    for (const type of wave) assert.ok(byType.has(type), `${locationId} has a ${type}`);

    const stamps = props.map(prop => `${prop.type}:${prop.x},${prop.y},${prop.rot}`);
    assert.equal(new Set(stamps).size, stamps.length, `${locationId} has no duplicate placements`);

    const solidTiles = new Set();
    for (const prop of props) {
      if (!propDefinition(prop.type).solid) continue;
      for (const tile of propTiles(prop)) {
        const stamp = key(tile);
        assert.ok(!solidTiles.has(stamp), `${locationId} solid props overlap at ${stamp}`);
        solidTiles.add(stamp);
      }
    }
  }
});

test('new town props leave every door, resident, and plaza route walkable', () => {
  const world = worldFor('town', undefined, createLocationRecord('town'));
  const record = createLocationRecord('town');
  const props = propsForLocation('town', record);
  const blocked = locationBlockedTiles(props);
  const doors = doorsFor('town', { terrain: world.grid, spawn: world.spawn });
  const targets = [
    ...doors.map(door => ({ x: door.x, y: door.y, name: `door ${door.to}` })),
    ...residentsFor('town').map(resident => ({ x: resident.x, y: resident.y, name: resident.id })),
    { x: 29, y: 34, name: 'plaza' },
    { x: 2, y: 60, name: 'ring south-west' },
    { x: 61, y: 5, name: 'ring north-east' },
    { x: 31, y: 10, name: 'V2 north' }
  ];

  assert.ok(!blocked.has(key(world.spawn)), 'spawn stays clear');
  for (const target of targets) {
    assert.ok(!blocked.has(key(target)), `${target.name} stays clear`);
    const path = findPath(world.grid, world.spawn, target, blocked);
    assert.ok(path.length > 0, `${target.name} is reachable from the spawn`);
    assert.deepEqual(path.at(-1), { x: target.x, y: target.y });
  }
});

test('new beach props leave the Town door, pier, and residents reachable', () => {
  const world = worldFor('beach', undefined, createLocationRecord('beach'));
  const props = propsForLocation('beach', createLocationRecord('beach'));
  const blocked = locationBlockedTiles(props);
  const targets = [
    { x: 3, y: 31, name: 'town door' },
    { x: 46, y: 31, name: 'pier end' },
    { x: 20, y: 55, name: 'southern sand' },
    ...residentsFor('beach').map(resident => ({ x: resident.x, y: resident.y, name: resident.id }))
  ];

  assert.ok(!blocked.has(key(world.spawn)), 'spawn stays clear');
  const pierPath = findPath(world.grid, world.spawn, { x: 46, y: 31 }, blocked);
  assert.ok(pierPath.length > 0, 'the boardwalk and pier path stays open');
  for (const target of targets) {
    assert.ok(!blocked.has(key(target)), `${target.name} stays clear`);
    const path = findPath(world.grid, world.spawn, target, blocked);
    assert.ok(path.length > 0, `${target.name} is reachable from the spawn`);
  }
});

test('new library props leave the spawn, door, and librarian reachable', () => {
  const world = worldFor('library', undefined, createLocationRecord('library'));
  const props = propsForLocation('library', createLocationRecord('library'));
  const blocked = locationBlockedTiles(props);
  const spawn = world.spawn;
  const door = LOCATIONS.library.door;
  const librarian = residentsFor('library')[0];

  for (const target of [{ x: door.x, y: door.y, name: 'door' }, { x: librarian.x, y: librarian.y, name: librarian.id }]) {
    assert.ok(!blocked.has(key(target)), `${target.name} stays clear`);
    const path = findPath(world.grid, spawn, target, blocked);
    assert.ok(path.length > 0, `${target.name} is reachable from the spawn`);
  }
});

test('Wave 2–4 footprints size the collision boxes and ground cover stays walkable', () => {
  assert.deepEqual(propFootprintTiles({ type: 'market-stall', x: 4, y: 5 }), [
    { x: 4, y: 5 }, { x: 5, y: 5 }, { x: 6, y: 5 },
    { x: 4, y: 6 }, { x: 5, y: 6 }, { x: 6, y: 6 }
  ]);
  assert.deepEqual(propFootprintTiles({ type: 'fence', x: 4, y: 5 }), [
    { x: 4, y: 5 }, { x: 5, y: 5 }
  ]);
  assert.deepEqual(propFootprintTiles({ type: 'surfboard', x: 4, y: 5 }), [
    { x: 4, y: 5 }, { x: 4, y: 6 }
  ]);
  assert.deepEqual(propFootprintTiles({ type: 'reading-table', x: 4, y: 5, rot: 1 }), [
    { x: 4, y: 5 }, { x: 5, y: 5 },
    { x: 4, y: 6 }, { x: 5, y: 6 },
    { x: 4, y: 7 }, { x: 5, y: 7 }
  ]);

  const records = normalizeLocationProps([
    { type: 'statue', x: 10, y: 10 },
    { type: 'string-lights', x: 13, y: 10 },
    { type: 'flower-bed', x: 13, y: 12 },
    { type: 'towel', x: 15, y: 12 },
    { type: 'beanbag', x: 17, y: 10 },
    { type: 'buoy', x: 18, y: 10 },
    { type: 'science-bench', x: 20, y: 10 }
  ]);
  const blocked = locationBlockedTiles(records);
  assert.ok(blocked.has('10,10') && blocked.has('11,11'), 'the statue blocks its 2×2 footprint');
  assert.ok(blocked.has('20,10') && blocked.has('22,10'), 'the science bench blocks three tiles');
  for (const tile of ['13,10', '14,10', '13,12', '15,12', '17,10', '18,10']) {
    assert.ok(!blocked.has(tile), `${tile} is ground cover or a loose toy`);
  }
});
