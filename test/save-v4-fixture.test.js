import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeTerrain, encodeTerrain, generateHome } from '../src/world.js';
import {
  SAVE_VERSION,
  STORAGE_KEY,
  activeLocation,
  captureLocationRecord,
  loadSave,
  migrateSave,
  serializeSave
} from '../src/storage.js';
import { castVoice } from '../src/voice/casting.js';

function grassTerrain() {
  return Array.from({ length: 64 }, () => Array.from({ length: 64 }, () => 'grass'));
}

function withLocalStorage(run) {
  const store = new Map();
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const api = {
    getItem: key => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: key => store.delete(key)
  };
  Object.defineProperty(globalThis, 'localStorage', {
    value: api,
    configurable: true,
    writable: true
  });
  try {
    return run(api);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete globalThis.localStorage;
  }
}

function playerRecipe() {
  return { seed: 'fixture-player', look: { style: 'voxel-art' } };
}

function npcRecipe(id) {
  return { seed: `fixture-${id}`, look: {} };
}

// A pre-v3 save: full item objects, no voices, no reserve fields, stale live
// frame state that must not leak through the migration.
function adversarialV2() {
  return {
    version: 2,
    worldSeed: 'adversarial-v2',
    terrain: encodeTerrain(grassTerrain()),
    playerName: 'Vee',
    playerRecipe: playerRecipe(),
    player: {
      x: 5,
      y: 6,
      direction: 3,
      coins: 4,
      inventory: [{ id: 'ball', name: 'Bouncy Ball' }],
      equipped: [],
      stabledCompanions: [
        { id: 'stable-1', name: 'Mo', buddyId: 'player', recipe: { style: 'dog' } }
      ]
    },
    npcs: [
      {
        id: 'npc-1',
        name: 'Pip',
        recipe: npcRecipe('npc-1'),
        x: 9,
        y: 10,
        direction: 1,
        path: [{ x: 1, y: 2 }],
        moving: true,
        inventory: [{ id: 'checkers', name: 'Checkers' }],
        equipped: []
      }
    ],
    companions: [],
    friends: ['npc-1', 7],
    wander: false
  };
}

// A v3-shaped save with a broken voice block, stale transient state, and a
// partially populated forage basket.
function adversarialV3() {
  return {
    version: 3,
    worldSeed: 'adversarial-v3',
    terrain: encodeTerrain(grassTerrain()),
    playerName: 'Three',
    playerRecipe: playerRecipe(),
    player: {
      x: 11,
      y: 12,
      direction: 2,
      coins: 6,
      inventory: [{ id: 'ball', uid: 'ball-0' }],
      equipped: [{ slot: 'charm', uid: 'ball-0', since: 1234 }],
      stabledCompanions: []
    },
    npcs: [
      {
        id: 'npc-a',
        name: 'Fern',
        recipe: npcRecipe('npc-a'),
        voice: { schema: 2, seed: 'broken', lang: 'es' },
        x: 20,
        y: 21,
        direction: 0,
        inventory: [{ id: 'checkers', uid: 'checkers-0' }],
        equipped: [],
        coins: 2,
        stabledCompanions: []
      }
    ],
    companions: [],
    friends: ['npc-a'],
    wander: true,
    forage: { apples: [{ id: 'apple:3,4', x: 3, y: 4 }], basket: { apple: 2, mushroom: 1 } },
    behavior: { relations: 'nonsense', cooldowns: 42 }
  };
}

// A realistically shaped v3 save, as the v3 serializer wrote it.
function realisticV3() {
  return {
    version: 3,
    savedAt: '2026-10-30T10:00:00.000Z',
    worldSeed: 'willow-realistic',
    terrain: encodeTerrain(grassTerrain()),
    playerName: 'Robin',
    playerRecipe: playerRecipe(),
    player: {
      x: 32,
      y: 30,
      direction: 0,
      inventory: [{ id: 'ball', uid: 'ball-0' }],
      coins: 18,
      equipped: [],
      stabledCompanions: []
    },
    npcs: [
      {
        id: 'npc-real',
        name: 'Ash',
        recipe: npcRecipe('npc-real'),
        voice: castVoice({ id: 'npc-real' }),
        vibe: 'curious',
        x: 30,
        y: 29,
        direction: 2,
        inventory: [{ id: 'checkers', uid: 'checkers-0' }],
        equipped: [],
        coins: 5,
        stabledCompanions: []
      }
    ],
    companions: [
      {
        id: 'comp-1',
        name: 'Pip',
        buddyId: 'player',
        recipe: { isCompanion: true, style: 'dog', seed: 'comp-seed' },
        x: 33,
        y: 30,
        direction: 0,
        inventory: [],
        equipped: []
      }
    ],
    friends: ['npc-real'],
    wander: true,
    forage: {
      apples: [{ id: 'apple:12,14', x: 12, y: 14 }],
      basket: { apple: 3, mushroom: 0 },
      harvested: {},
      nextAppleAt: 999,
      seeded: true
    },
    behavior: {
      version: 1,
      relations: { version: 1, pairs: [] },
      cooldowns: { version: 1, entries: [] },
      counters: {}
    }
  };
}

test('adversarial v2 wraps as park without leaking gear or transient state', () => {
  const fixture = adversarialV2();
  const migrated = migrateSave(fixture);
  const park = migrated.locations.park;

  assert.equal(migrated.version, 4);
  assert.equal(migrated.currentLocation, 'park');
  assert.equal(park.seed, 'adversarial-v2');
  assert.equal(park.terrain, fixture.terrain);
  assert.deepEqual(park.player, { x: 5, y: 6, direction: 3 });
  assert.equal(park.npcs[0].x, 9);
  assert.equal(park.npcs[0].y, 10);
  assert.equal(park.npcs[0].coins, 0);
  assert.equal(park.npcs[0].inventory[0].uid, 'checkers-0');
  assert.equal('path' in park.npcs[0], false);
  assert.equal('moving' in park.npcs[0], false);
  assert.deepEqual(park.npcs[0].voice, castVoice({ id: 'npc-1' }));
  assert.deepEqual(migrated.player.stabledCompanions.map(comp => comp.id), ['stable-1']);
  assert.equal(migrated.player.inventory[0].uid, 'ball-0');
  assert.equal(migrated.player.coins, 4);
  assert.equal('x' in migrated.player, false);
  assert.deepEqual(migrated.friends, ['npc-1']);
  assert.equal(migrated.wander, false);
});

test('adversarial v3 re-casts a broken voice once and reloads identically', () => {
  const source = adversarialV3();
  const once = migrateSave(source);
  const twice = migrateSave(JSON.parse(JSON.stringify(once)));
  const thrice = migrateSave(JSON.parse(JSON.stringify(twice)));

  assert.equal(once.version, 4);
  assert.deepEqual(once.locations.park.npcs[0].voice, castVoice({ id: 'npc-a' }));
  assert.deepEqual(twice.locations.park.npcs[0].voice, once.locations.park.npcs[0].voice);
  assert.deepEqual(thrice.locations.park.npcs[0].voice, once.locations.park.npcs[0].voice);
  assert.equal(once.locations.park.terrain, source.terrain);
  assert.deepEqual(once.locations.park.forage.apples, [{ id: 'apple:3,4', x: 3, y: 4 }]);
  assert.deepEqual(once.locations.park.forage.basket, { apple: 2, mushroom: 1, shell: 0 });
  assert.deepEqual(once.behavior.relations, { version: 1, pairs: [] });
  assert.deepEqual(once.player.equipped, [{ slot: 'charm', uid: 'ball-0' }]);
});

test('realistic v3 Park state migrates unchanged', () => {
  const source = realisticV3();
  const migrated = migrateSave(source);
  const park = migrated.locations.park;

  assert.equal(migrated.version, 4);
  assert.equal(migrated.savedAt, source.savedAt);
  assert.equal(park.seed, source.worldSeed);
  assert.equal(park.terrain, source.terrain);
  assert.deepEqual(park.player, {
    x: source.player.x,
    y: source.player.y,
    direction: source.player.direction
  });
  assert.deepEqual(
    park.npcs.map(npc => [npc.id, npc.x, npc.y, npc.direction, npc.voice]),
    source.npcs.map(npc => [npc.id, npc.x, npc.y, npc.direction, npc.voice])
  );
  assert.deepEqual(park.forage, {
    ...source.forage,
    shells: [],
    basket: { ...source.forage.basket, shell: 0 },
    nextShellAt: 0
  });
  assert.deepEqual(migrated.friends, source.friends);
  assert.deepEqual(migrated.companions, source.companions);
  assert.equal(migrated.player.coins, source.player.coins);
  assert.equal(migrated.playerName, source.playerName);
  assert.deepEqual(migrated.playerRecipe, source.playerRecipe);
  assert.deepEqual(decodeTerrain(park.terrain), decodeTerrain(source.terrain));
});

test('strict v4 rejects a missing, non-object, or malformed park', () => {
  const terrain = encodeTerrain(grassTerrain());
  const valid = { version: 4, playerRecipe: playerRecipe(), locations: { park: { seed: 'x', terrain } } };

  assert.ok(migrateSave(valid));
  assert.equal(migrateSave({ version: 4, locations: {} }), null);
  assert.equal(migrateSave({ version: 4, locations: 'park' }), null);
  assert.equal(migrateSave({ version: 4, locations: [] }), null);
  assert.equal(migrateSave({ version: 4, locations: { park: {} } }), null);
  assert.equal(migrateSave({ version: 4, locations: { park: { seed: 'x' } } }), null);
  assert.equal(migrateSave({ version: 4, locations: { park: { seed: '', terrain } } }), null);
  assert.equal(migrateSave({ version: 4, locations: { park: { seed: 'x', terrain: 'nope' } } }), null);

  withLocalStorage(store => {
    for (const bad of [
      { version: 4, playerRecipe: playerRecipe(), locations: {} },
      { version: 4, playerRecipe: playerRecipe(), locations: 'park' },
      { version: 4, playerRecipe: playerRecipe(), locations: { park: { seed: 'x', terrain: 'gggg' } } }
    ]) {
      store.setItem(STORAGE_KEY, JSON.stringify(bad));
      assert.equal(loadSave(), null);
    }
  });
});

test('v4 serialization keeps every location and the current location', () => {
  const parkTerrain = encodeTerrain(grassTerrain());
  const homeTerrain = encodeTerrain(generateHome('acorn-hearth-01').grid);
  const game = {
    worldSeed: 'park-only',
    terrain: grassTerrain(),
    wander: true,
    player: {
      name: 'Tester',
      recipe: playerRecipe(),
      x: 10,
      y: 12,
      direction: 1,
      inventory: [],
      equipped: [],
      coins: 0,
      stabledCompanions: []
    },
    npcs: [],
    companions: []
  };

  const locations = {
    park: {
      seed: 'park-only',
      terrain: parkTerrain,
      player: { x: 10, y: 12, direction: 1 },
      npcs: [],
      forage: null
    },
    home: {
      seed: 'home-seed',
      terrain: homeTerrain,
      player: { x: 32, y: 36, direction: 0 },
      npcs: [],
      forage: { apples: [], basket: { apple: 0, mushroom: 0 }, harvested: {}, seeded: true },
      // Wave 2 fields must survive this wave's writer untouched.
      decor: [{ id: 'rug-round', x: 30, y: 34 }],
      buddies: [{ companionId: 'comp-1', x: 31, y: 33 }]
    }
  };

  const save = serializeSave(game, {}, new Set(), null, {
    locations,
    currentLocation: 'home',
    companions: []
  });

  assert.deepEqual(Object.keys(save.locations).sort(), ['home', 'park']);
  assert.equal(save.currentLocation, 'home');
  assert.equal(save.locations.park.seed, 'park-only');
  assert.equal(save.locations.home.seed, 'home-seed');
  assert.equal(decodeTerrain(save.locations.home.terrain).length, 64);
  assert.deepEqual(save.locations.home.decor, locations.home.decor);
  assert.deepEqual(save.locations.home.buddies, locations.home.buddies);
  // Shared fields never mirror the old top-level world shape.
  assert.equal('worldSeed' in save, false);
  assert.equal('terrain' in save, false);
  assert.equal('npcs' in save, false);
  assert.equal('forage' in save, false);

  // A reload keeps both locations and does not collapse back to the park.
  const loaded = migrateSave(JSON.parse(JSON.stringify(save)));
  assert.deepEqual(Object.keys(loaded.locations).sort(), ['home', 'park']);
  assert.equal(loaded.currentLocation, 'home');
  assert.equal(activeLocation(loaded).seed, 'home-seed');

  // Being at Home does not drop the Park record.
  const atPark = serializeSave(game, {}, new Set(), null, {
    locations,
    currentLocation: 'park',
    companions: []
  });
  assert.equal(atPark.currentLocation, 'park');
  assert.deepEqual(Object.keys(atPark.locations).sort(), ['home', 'park']);
});

test('captureLocationRecord encodes terrain and preserves unknown location keys', () => {
  const terrain = grassTerrain();
  const npc = {
    id: 'npc-1',
    name: 'Pip',
    recipe: npcRecipe('npc-1'),
    x: 4,
    y: 5,
    direction: 2,
    inventory: [],
    equipped: [],
    path: [{ x: 1, y: 1 }],
    moving: true
  };

  const record = captureLocationRecord({
    seed: 'capture-seed',
    terrain,
    player: { x: 7, y: 8, direction: 3 },
    npcs: [npc],
    forage: { apples: [], basket: { apple: 1 }, seeded: true }
  }, { decor: [{ id: 'plant' }], buddies: [] });

  assert.equal(typeof record.terrain, 'string');
  assert.equal(record.terrain.length, 64 * 64);
  assert.deepEqual(record.player, { x: 7, y: 8, direction: 3 });
  assert.equal(record.npcs[0].x, 4);
  assert.equal('path' in record.npcs[0], false);
  assert.equal('moving' in record.npcs[0], false);
  assert.deepEqual(record.forage.basket, { apple: 1, mushroom: 0, shell: 0 });
  assert.deepEqual(record.decor, [{ id: 'plant' }]);
  assert.deepEqual(record.buddies, []);

  // Capturing the same record again is stable (travel and save share this path).
  const again = captureLocationRecord(record, record);
  assert.deepEqual(again, record);
});

test('a v4 save round-trips without re-rolling voices or losing park state', () => {
  const game = {
    worldSeed: 'stable-v4',
    terrain: grassTerrain(),
    wander: true,
    player: {
      name: 'Tester',
      recipe: playerRecipe(),
      x: 7,
      y: 8,
      direction: 2,
      inventory: [{ id: 'ball' }],
      equipped: [{ slot: 'charm', uid: 'ball-0' }],
      coins: 3,
      stabledCompanions: []
    },
    npcs: [
      {
        id: 'npc-1',
        name: 'Pip',
        recipe: npcRecipe('npc-1'),
        x: 9,
        y: 10,
        direction: 0,
        inventory: [],
        equipped: []
      }
    ],
    companions: [],
    forage: { apples: [], basket: { apple: 1, mushroom: 2 }, seeded: true }
  };

  const saved = serializeSave(game, {}, new Set(['npc-1']));
  const loaded = migrateSave(JSON.parse(JSON.stringify(saved)));
  const reloaded = migrateSave(JSON.parse(JSON.stringify(loaded)));

  assert.deepEqual(loaded.locations.park, saved.locations.park);
  assert.deepEqual(reloaded.locations.park, loaded.locations.park);
  assert.deepEqual(reloaded.locations.park.npcs[0].voice, saved.locations.park.npcs[0].voice);
  assert.deepEqual(reloaded.player, loaded.player);
  assert.deepEqual(reloaded.friends, ['npc-1']);
});

test('activeLocation reads v4 state and falls back to the legacy wizard draft', () => {
  const terrain = encodeTerrain(grassTerrain());
  const v4 = {
    version: 4,
    currentLocation: 'park',
    locations: { park: { seed: 'v4-seed', terrain, player: { x: 1, y: 2 }, npcs: [], forage: null } },
    player: { inventory: [], coins: 0, equipped: [], stabledCompanions: [] }
  };
  assert.deepEqual(activeLocation(v4), {
    seed: 'v4-seed',
    terrain,
    player: { x: 1, y: 2 },
    npcs: [],
    forage: null
  });

  // enterPark still builds a v1-shaped object with world state at the top.
  const legacy = {
    version: 1,
    worldSeed: 'draft-seed',
    terrain,
    player: { x: 3, y: 4, direction: 1, inventory: [], equipped: [] },
    npcs: [{ id: 'npc-1' }],
    forage: { apples: [] }
  };
  const location = activeLocation(legacy);
  assert.equal(location.seed, 'draft-seed');
  assert.equal(location.terrain, terrain);
  assert.deepEqual(location.player, legacy.player);
  assert.deepEqual(location.npcs, legacy.npcs);
  assert.deepEqual(location.forage, legacy.forage);

  assert.equal(activeLocation(null), null);
});
