import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LOCATIONS,
  createLocationRecord,
  doorFor,
  doorsFor,
  locationTheme,
  nearbyTargetIds,
  propsForLocation,
  residentsFor,
  travelDoorsFor,
  travelTargets,
  worldFor
} from '../src/locations.js';
import {
  TERRAIN_COLORS,
  generateBeach,
  generateCentralPark,
  generateHome,
  generateTown,
  generateWorld,
  isWalkable,
  terrainColorsFor,
  typeAt
} from '../src/world.js';
import {
  LOCATION_PROP_IDS,
  canPlaceLocationProp,
  locationBlockedTiles,
  locationProp,
  locationPropColors,
  locationPropSize,
  normalizeLocationProps,
  propFootprintTiles,
  propRenderMeta,
  propTiles
} from '../src/location_props.js';
import { captureLocationRecord } from '../src/storage.js';
import { Game } from '../src/game.js';

/** Insert temporary location definitions and always restore the real map. */
function withLocations(entries, run) {
  const saved = new Map();
  for (const [id, def] of Object.entries(entries)) {
    saved.set(id, Object.prototype.hasOwnProperty.call(LOCATIONS, id) ? LOCATIONS[id] : undefined);
    LOCATIONS[id] = def;
  }
  try {
    return run();
  } finally {
    for (const [id, def] of saved) {
      if (def === undefined) delete LOCATIONS[id];
      else LOCATIONS[id] = def;
    }
  }
}

function baseDef(id, overrides = {}) {
  return {
    id,
    label: id,
    enabled: true,
    mapLabel: `${id} map`,
    spawn: { x: 32, y: 32 },
    door: { x: 32, y: 34, to: 'park', prompt: 'Leave?' },
    menu: { label: id, note: '' },
    ...overrides
  };
}

test('worldFor dispatches templates and gives the park the Central Park layout', () => {
  const seed = 'framework-template';
  const baseline = generateWorld(seed);
  const centralPark = generateCentralPark(seed);
  assert.equal(worldFor('park', seed).template, 'central-park');
  assert.deepEqual(worldFor('park', seed).grid, centralPark.grid);

  withLocations({
    'test-interior': baseDef('test-interior', { template: 'interior' }),
    'test-house': baseDef('test-house', { house: { x: 24, y: 22, width: 17, height: 17 } }),
    'test-central-park': baseDef('test-central-park', { template: 'central-park' }),
    'test-town': baseDef('test-town', { template: 'town' }),
    'test-beach': baseDef('test-beach', { template: 'beach' })
  }, () => {
    assert.equal(worldFor('test-interior', seed).template, 'interior');
    assert.equal(worldFor('test-house', seed).template, 'interior');
    const interior = worldFor('test-interior', seed);
    assert.deepEqual(interior.grid, generateHome(seed, LOCATIONS['test-interior']).grid);

    const templateWorld = worldFor('test-central-park', seed);
    assert.equal(templateWorld.template, 'central-park');
    assert.deepEqual(templateWorld.grid, centralPark.grid);

    for (const [id, template] of [
      ['test-town', 'town'],
      ['test-beach', 'beach']
    ]) {
      const world = worldFor(id, seed);
      assert.equal(world.template, template);
      assert.deepEqual(world.grid, baseline.grid);
    }
  });

  assert.equal(generateCentralPark(seed).template, 'central-park');
  assert.equal(generateTown(seed).template, 'town');
  assert.equal(generateBeach(seed).template, 'beach');
});

test('travelDoorsFor builds every enabled travel door and skips disabled targets', () => {
  const world = generateWorld('framework-doors');
  const def = baseDef('test-multi', {
    door: { x: 32, y: 34, to: 'home', prompt: 'Go home?' },
    doors: [
      { kind: 'travel', to: 'shop', x: 30, y: 34, prompt: 'Go shopping?' },
      { kind: 'travel', to: 'park', x: 28, y: 34 },
      { kind: 'activity', activityId: 'jungle-gym', x: 26, y: 34 }
    ]
  });

  const doors = travelDoorsFor(def, { terrain: world.grid, spawn: world.spawn });
  assert.deepEqual(doors.map(door => door.to), ['home', 'shop', 'park']);
  assert.deepEqual(doors.map(door => door.kind), ['travel', 'travel', 'travel']);
  assert.deepEqual(doors.map(door => door.prompt), [
    'Go home?',
    'Go shopping?',
    'Go to Park?'
  ]);
  assert.equal(new Set(doors.map(door => `${door.x},${door.y}`)).size, 3);

  const gated = travelDoorsFor(def, {
    terrain: world.grid,
    spawn: world.spawn,
    isEnabled: id => id !== 'shop'
  });
  assert.deepEqual(gated.map(door => door.to), ['home', 'park']);

  // Unknown destination ids never become doors.
  const unknown = travelDoorsFor(baseDef('test-unknown', {
    door: { x: 32, y: 34, to: 'nowhere', prompt: '?' }
  }), { terrain: world.grid, spawn: world.spawn });
  assert.deepEqual(unknown, []);
});

test('multi-door doorsFor keeps travel and activity doors, and legacy doorFor still answers', () => {
  const world = generateWorld('framework-doors-for');
  withLocations({
    'test-multi': baseDef('test-multi', {
      door: { x: 32, y: 34, to: 'home', prompt: 'Go home?' },
      doors: [
        { kind: 'travel', to: 'shop', x: 30, y: 34, prompt: 'Go shopping?' },
        { kind: 'activity', activityId: 'jungle-gym', x: 28, y: 34 }
      ]
    })
  }, () => {
    const doors = doorsFor('test-multi', { terrain: world.grid, spawn: world.spawn });
    assert.deepEqual(doors.map(door => door.kind), ['travel', 'travel', 'activity']);
    assert.equal(doors.filter(door => door.kind === 'travel').length, 2);
    assert.equal(doors.find(door => door.kind === 'activity').activityId, 'jungle-gym');
  });

  const home = generateHome('framework-door-home');
  const legacy = doorFor('home', {
    terrain: home.grid,
    spawn: home.spawn,
    isEnabled: () => true
  });
  assert.equal(legacy.to, 'park');
  assert.equal(legacy.kind, 'travel');
});

test('a door tile in water falls back to walkable ground and doors never share a tile', () => {
  const world = generateHome('framework-door-water');
  const grid = world.grid.map(row => row.slice());
  grid[34][32] = 'water';
  const def = baseDef('test-water', {
    spawn: { x: 32, y: 32 },
    door: { x: 32, y: 34, to: 'home', prompt: 'Home?' },
    doors: [
      { kind: 'travel', to: 'shop', x: 32, y: 34, prompt: 'Shop?' },
      { kind: 'travel', to: 'park', x: 32, y: 34, prompt: 'Park?' }
    ]
  });

  const doors = travelDoorsFor(def, { terrain: grid, spawn: { x: 32, y: 32 } });
  assert.equal(doors.length, 3);
  for (const door of doors) {
    assert.notEqual(`${door.x},${door.y}`, '32,34');
    assert.ok(isWalkable(typeAt(grid, door.x, door.y)), 'fallback door is walkable');
  }
  assert.equal(new Set(doors.map(door => `${door.x},${door.y}`)).size, 3);
});

test('the location prop catalog covers the framework set with complete metadata', () => {
  const expected = [
    'fountain', 'bench', 'lamp', 'gate', 'slide', 'swing-frame',
    'amphitheatre-tier', 'building', 'pier', 'palm', 'umbrella',
    'desk', 'bookshelf', 'planter', 'picnic-blanket'
  ];
  for (const id of expected) {
    const prop = locationProp(id);
    assert.ok(prop, `missing prop type ${id}`);
    assert.ok(typeof prop.label === 'string' && prop.label, `${id} label`);
    assert.ok(Number.isInteger(prop.size.w) && prop.size.w > 0, `${id} width`);
    assert.ok(Number.isInteger(prop.size.h) && prop.size.h > 0, `${id} height`);
    assert.equal(typeof prop.solid, 'boolean', `${id} solid flag`);
    assert.ok(typeof prop.shape === 'string' && prop.shape, `${id} shape`);
    for (const key of ['base', 'accent', 'trim']) {
      assert.ok(typeof prop.colors[key] === 'string', `${id} ${key} colour`);
    }
    assert.ok(Array.isArray(prop.variants) && prop.variants.length > 0, `${id} variants`);
  }
  assert.deepEqual(LOCATION_PROP_IDS.slice().sort(), expected.slice().sort());
});

test('prop footprints rotate, and only solid props block movement', () => {
  assert.deepEqual(locationPropSize('bench', 0), { w: 2, h: 1 });
  assert.deepEqual(locationPropSize('bench', 1), { w: 1, h: 2 });
  assert.deepEqual(locationPropSize('bench', 5), { w: 1, h: 2 });
  assert.deepEqual(
    propFootprintTiles({ type: 'bench', x: 4, y: 5, rot: 1 }),
    [{ x: 4, y: 5 }, { x: 4, y: 6 }]
  );

  const props = normalizeLocationProps([
    { type: 'bench', x: 10, y: 10, rot: 0, variant: 1 },
    { type: 'pier', x: 14, y: 10, rot: 0 }
  ]);
  const blocked = locationBlockedTiles(props);
  assert.ok(blocked.has('10,10'));
  assert.ok(blocked.has('11,10'));
  assert.ok(!blocked.has('14,10'), 'a pier is walkable ground');
  assert.deepEqual(propTiles(props[0]), [{ x: 10, y: 10 }, { x: 11, y: 10 }]);
  assert.equal(locationPropColors('bench', 1).base, '#5f8158');
});

test('prop placement validation checks overlap, bounds, reserved tiles, and terrain', () => {
  const building = normalizeLocationProps([{ type: 'building', x: 10, y: 10, rot: 0 }]);
  assert.equal(canPlaceLocationProp({ props: building, type: 'planter', x: 10, y: 10 }).reason, 'occupied');
  assert.equal(canPlaceLocationProp({ props: [], type: 'planter', x: 63, y: 63 }).ok, true);
  assert.equal(canPlaceLocationProp({ props: [], type: 'building', x: 63, y: 63 }).reason, 'outside-world');
  assert.equal(
    canPlaceLocationProp({ props: [], type: 'bench', x: 20, y: 20, blocked: new Set(['21,20']) }).reason,
    'reserved'
  );
  assert.equal(
    canPlaceLocationProp({ props: [], type: 'pier', x: 20, y: 20, walkable: () => false }).reason,
    'unwalkable'
  );
  assert.equal(canPlaceLocationProp({ props: [], type: 'not-a-prop', x: 1, y: 1 }).reason, 'unknown-type');
});

test('normalizeLocationProps drops bad rows and overlapping solid props', () => {
  const normalized = normalizeLocationProps([
    { type: 'bench', x: 1, y: 1 },
    { type: 'bench', x: 1, y: 1 },
    { type: 'not-a-prop', x: 2, y: 2 },
    { type: 'fountain', x: 63, y: 63 }
  ]);
  assert.equal(normalized.length, 1);
  assert.deepEqual(normalized[0], { type: 'bench', x: 1, y: 1, rot: 0, variant: 0 });
});

test('propRenderMeta gives the renderer a shape, palette, and y-sort row', () => {
  const meta = propRenderMeta({ type: 'bench', x: 4, y: 5, rot: 1, variant: 1 });
  assert.equal(meta.shape, 'bench');
  assert.deepEqual(meta.size, { w: 1, h: 2 });
  assert.equal(meta.sortY, 6);
  assert.equal(meta.solid, true);
  assert.equal(meta.colors.base, '#5f8158');
  assert.equal(propRenderMeta({ type: 'not-a-prop', x: 0, y: 0 }), null);
});

test('residentsFor instantiates stable NPC data and residents are never saved', () => {
  const world = generateWorld('framework-residents');
  withLocations({
    'test-town': baseDef('test-town', {
      template: 'town',
      residents: [
        { id: 'resident-mira', name: 'Mira', seed: 'mira-seed', look: { hair: 'bob' }, x: 30, y: 30, direction: 2 },
        { id: 'resident-oren', name: 'Oren', seed: 'oren-seed', x: 34, y: 30 },
        { id: 'resident-mira', name: 'Duplicate', seed: 'other', x: 1, y: 1 }
      ]
    })
  }, () => {
    const residents = residentsFor('test-town');
    assert.deepEqual(residents.map(resident => resident.id), ['resident-mira', 'resident-oren']);
    assert.equal(residents[0].name, 'Mira');
    assert.deepEqual(residents[0].recipe, { seed: 'mira-seed', look: { hair: 'bob' } });
    assert.equal(residents[0].resident, true);
    assert.equal(residents[1].recipe.seed, 'oren-seed');
    assert.equal(residents[1].direction, 0);

    const record = captureLocationRecord({
      seed: 'framework-residents',
      terrain: world.grid,
      player: { x: 32, y: 32, direction: 0 },
      npcs: [
        { ...residents[0], inventory: [], equipped: [], coins: 0, stabledCompanions: [] },
        {
          id: 'resident-extra',
          name: 'Saved neighbour',
          recipe: { seed: 'saved', look: {} },
          x: 20,
          y: 20,
          direction: 0
        }
      ]
    });
    assert.deepEqual(record.npcs.map(npc => npc.id), ['resident-extra']);
  });
});

test('a fresh template location gets a terrain record without saved residents', () => {
  withLocations({
    'test-town': baseDef('test-town', {
      template: 'town',
      seed: 'fresh-town',
      residents: [{ id: 'resident-mira', name: 'Mira', seed: 'mira', x: 30, y: 30 }]
    })
  }, () => {
    const record = createLocationRecord('test-town', { basket: { apple: 2, mushroom: 1 } });
    assert.equal(record.seed, 'fresh-town');
    assert.equal(record.terrain.length, 64 * 64);
    assert.deepEqual(record.npcs, []);
    assert.deepEqual(record.forage.basket, { apple: 2, mushroom: 1 });
    assert.equal(record.forage.seeded, false, 'outdoor templates seed their first crop');
    assert.ok(Number.isInteger(record.player.x) && Number.isInteger(record.player.y));
  });
});

test('travelTargets marks door-reachable rows Nearby and sorts them first', () => {
  const park = travelTargets('park');
  assert.deepEqual(park.map(target => target.id), ['home', 'shop']);
  assert.equal(park[0].nearby, true);
  assert.equal(park[1].nearby, false);

  withLocations({
    'test-hub': baseDef('test-hub', {
      door: { x: 32, y: 34, to: 'park', prompt: 'Park?' },
      doors: [{ kind: 'travel', to: 'shop', x: 30, y: 34 }]
    })
  }, () => {
    assert.deepEqual(
      [...nearbyTargetIds('test-hub')],
      ['park', 'shop']
    );
    const targets = travelTargets('test-hub');
    assert.deepEqual(targets.map(target => target.id), ['park', 'shop', 'home']);
    assert.deepEqual(targets.map(target => target.nearby), [true, true, false]);
  });
});

test('location theme overrides map onto tile colours and absent themes stay default', () => {
  assert.equal(terrainColorsFor(null), TERRAIN_COLORS);
  const themed = terrainColorsFor({
    grass: '#123456',
    wall: '#654321',
    floor: '#abcdef',
    beach: '#ff0000'
  });
  assert.equal(themed.grass, '#123456');
  assert.equal(themed['home-wall'], '#654321');
  assert.equal(themed['home-floor'], '#abcdef');
  assert.equal(themed.dirt, TERRAIN_COLORS.dirt);
  assert.equal(themed.water, TERRAIN_COLORS.water);
  assert.equal(locationTheme('park').grass, '#4b8750');
  assert.ok(propsForLocation('park').length > 0);

  withLocations({
    'test-beach': baseDef('test-beach', { template: 'beach', theme: { sand: '#eeddaa' } })
  }, () => {
    assert.deepEqual(locationTheme('test-beach'), { sand: '#eeddaa' });
    assert.equal(propsForLocation('test-beach').length, 0);
  });
});

test('residents use the lightweight wander even when the Park runtime is present', () => {
  const home = generateHome('framework-resident-wander');
  const game = new Game();
  game.terrain = home.grid;
  game.wander = true;
  game.companions = [];
  game.homeBuddies = [];
  game.miniGames = [];
  game.player = game.makeCharacter({ id: 'player', x: 20, y: 20 }, true);
  game.behaviorRuntime = { update() {} };

  const resident = game.makeCharacter({ id: 'resident-mira', x: 10, y: 10 }, false);
  resident.resident = true;
  resident.wait = 0;
  game.npcs = [resident];
  game.updateNpc(resident, 1 / 60);
  assert.equal(resident.moving, true, 'a resident strolls without a behaviour actor');

  const neighbour = game.makeCharacter({ id: 'npc-plain', x: 10, y: 10 }, false);
  neighbour.wait = 0;
  game.npcs = [neighbour];
  game.updateNpc(neighbour, 1 / 60);
  assert.equal(neighbour.moving, false, 'the runtime still owns ordinary Park neighbours');
});

test('solid location props block player steps through locationBlockedTiles', () => {
  const home = generateHome('framework-prop-collision');
  const game = new Game();
  game.terrain = home.grid;
  game.npcs = [];
  game.companions = [];
  game.homeBuddies = [];
  game.miniGames = [];
  game.interactive = true;
  game.paused = false;
  game.worldSuspended = false;
  game.locationBlockedTiles = new Set(['11,10']);
  game.player = game.makeCharacter({ id: 'player', x: 10, y: 10 }, true);

  assert.equal(game.tryStep(game.player, 1, 0, 0.1), false);
  assert.equal(game.blockedTile(11, 10), true);
  game.locationBlockedTiles = new Set();
  assert.equal(game.blockedTile(11, 10), false);
  assert.equal(game.tryStep(game.player, 1, 0, 0.1), true);
});
