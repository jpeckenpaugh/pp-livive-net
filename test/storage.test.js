import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeTerrain } from '../src/world.js';
import {
  serializeSave,
  loadSave,
  migrateSave,
  normalizeBehaviorBlock,
  STORAGE_KEY,
  SAVE_VERSION
} from '../src/storage.js';

function grassTerrain() {
  return Array.from({ length: 64 }, () => Array.from({ length: 64 }, () => 'grass'));
}

function baseGame(overrides = {}) {
  return {
    worldSeed: 'test-seed',
    terrain: grassTerrain(),
    wander: true,
    player: {
      name: 'Tester',
      recipe: { seed: 'p-seed', look: {} },
      x: 10,
      y: 12,
      direction: 1,
      inventory: [],
      equipped: [],
      coins: 0,
      stabledCompanions: []
    },
    npcs: [],
    companions: [],
    ...overrides
  };
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

test('serializeSave handles empty or uninitialized game', () => {
  assert.equal(serializeSave(null, null, new Set()), null);
  assert.equal(serializeSave({}, null, new Set()), null);
});

test('serializeSave writes v2 with normalised instances and empty gear', () => {
  const fakeGame = baseGame({
    player: {
      name: 'Tester',
      recipe: { seed: 'p-seed', look: {} },
      x: 10,
      y: 12,
      direction: 1,
      inventory: [{ id: 'ball', name: 'Ball' }]
    },
    npcs: [
      {
        id: 'npc-1',
        name: 'Pip',
        recipe: { seed: 'n-seed', look: {} },
        vibe: 'Friendly',
        x: 14,
        y: 15,
        direction: 0,
        inventory: [{ id: 'checkers', uid: 'board-1' }]
      }
    ]
  });

  const save = serializeSave(fakeGame, {}, new Set(['npc-1']));
  assert.equal(save.version, SAVE_VERSION);
  assert.equal(save.version, 2);
  assert.equal(save.worldSeed, 'test-seed');
  assert.equal(save.playerName, 'Tester');
  assert.equal(save.player.x, 10);
  assert.equal(save.player.y, 12);
  assert.equal(save.player.inventory[0].uid, 'ball-0');
  assert.deepEqual(save.player.equipped, []);
  assert.deepEqual(save.npcs[0].equipped, []);
  assert.equal(save.npcs[0].inventory[0].uid, 'board-1');
  assert.deepEqual(save.friends, ['npc-1']);
  assert.equal(save.wander, true);
  assert.deepEqual(save.behavior, {
    version: 1,
    relations: { version: 1, pairs: [] },
    cooldowns: { version: 1, entries: [] },
    counters: {}
  });
});

test('v1 saves migrate to v2 instances, equipped defaults, and behavior block', () => {
  const v1 = {
    version: 1,
    worldSeed: 'legacy-seed',
    terrain: encodeTerrain(grassTerrain()),
    playerName: 'Old Timer',
    playerRecipe: { seed: 'old', look: {} },
    player: {
      x: 4,
      y: 5,
      direction: 2,
      coins: 9,
      inventory: [
        { id: 'ball', name: 'Ball', color: 'red' },
        { id: 'ball', name: 'Second Ball' },
        { id: 'mystery-trinket', name: 'Mystery' }
      ],
      stabledCompanions: [
        { id: 'stable-1', name: 'Mo', buddyId: 'player', recipe: { style: 'dog' } }
      ]
    },
    npcs: [
      {
        id: 'npc-1',
        name: 'Pip',
        recipe: { seed: 'n', look: {} },
        inventory: [{ id: 'checkers', name: 'Checkers' }]
      }
    ],
    companions: [],
    friends: ['npc-1', 42],
    wander: true
  };

  const migrated = migrateSave(v1);
  assert.equal(migrated.version, 2);
  assert.equal(migrated.playerName, 'Old Timer');
  const migratedUids = migrated.player.inventory.map(item => item.uid);
  assert.deepEqual(migratedUids.slice(0, 3), ['ball-0', 'ball-1', 'mystery-trinket-2']);
  const migratedIds = migrated.player.inventory.map(item => item.id);
  for (const id of ['big-o-bracelet', 'chamo-clip', 'teleport-tricorder']) {
    assert.ok(migratedIds.includes(id), `v1 migration should grant ${id}`);
  }
  assert.equal(migrated.player.inventory[0].name, 'Ball');
  assert.equal(migrated.player.inventory[0].color, 'red');
  assert.deepEqual(migrated.player.equipped, []);
  assert.equal(migrated.npcs[0].inventory[0].uid, 'checkers-0');
  assert.deepEqual(migrated.npcs[0].equipped, []);
  assert.deepEqual(migrated.player.stabledCompanions[0].inventory, []);
  assert.deepEqual(migrated.player.stabledCompanions[0].equipped, []);
  assert.deepEqual(migrated.friends, ['npc-1']);
  assert.deepEqual(migrated.behavior, {
    version: 1,
    relations: { version: 1, pairs: [] },
    cooldowns: { version: 1, entries: [] },
    counters: {}
  });
});

test('equipped gear round-trips for player, NPC, companion, and stabled companion', () => {
  const game = baseGame({
    player: {
      name: 'Tester',
      recipe: { seed: 'p', look: {} },
      x: 10,
      y: 12,
      direction: 1,
      coins: 7,
      inventory: [{ id: 'big-o-bracelet' }],
      equipped: [
        {
          slot: 'charm',
          uid: 'big-o-bracelet-0',
          itemId: 'big-o-bracelet',
          effectId: 'big-o',
          since: 1234
        }
      ],
      stabledCompanions: [
        {
          id: 'stable-1',
          name: 'Mo',
          buddyId: 'player',
          recipe: { style: 'dog' },
          inventory: [{ id: 'buddy-cape' }],
          equipped: [{ slot: 'buddy', uid: 'buddy-cape-0', since: 88 }]
        }
      ]
    },
    npcs: [
      {
        id: 'npc-1',
        name: 'Pip',
        recipe: { seed: 'n', look: {} },
        x: 14,
        y: 15,
        direction: 0,
        inventory: [{ id: 'checkers' }],
        equipped: [{ slot: 'hand', uid: 'checkers-0' }]
      }
    ],
    companions: [
      {
        id: 'comp-1',
        name: 'Rusty',
        buddyId: 'player',
        recipe: { style: 'dog' },
        x: 11,
        y: 12,
        direction: 0,
        inventory: [{ id: 'lucky-clover' }],
        equipped: [{ slot: 'charm', uid: 'lucky-clover-0' }]
      }
    ]
  });

  const save = serializeSave(game, {}, new Set(['npc-1']));
  assert.equal(save.player.equipped[0].uid, 'big-o-bracelet-0');
  assert.equal('since' in save.player.equipped[0], false);
  assert.equal(save.npcs[0].equipped[0].uid, 'checkers-0');
  assert.equal(save.companions[0].equipped[0].uid, 'lucky-clover-0');
  assert.equal(save.player.stabledCompanions[0].equipped[0].uid, 'buddy-cape-0');
  assert.ok(save.player.inventory[0].uid);

  const loaded = migrateSave(JSON.parse(JSON.stringify(save)));
  assert.equal(loaded.version, 2);
  assert.deepEqual(loaded.player.equipped, save.player.equipped);
  assert.deepEqual(loaded.npcs[0].equipped, save.npcs[0].equipped);
  assert.deepEqual(loaded.companions[0].equipped, save.companions[0].equipped);
  assert.deepEqual(loaded.player.stabledCompanions[0].equipped, save.player.stabledCompanions[0].equipped);
  assert.ok(loaded.companions[0].inventory[0].uid);
  assert.ok(loaded.player.stabledCompanions[0].inventory[0].uid);
  assert.equal('path' in loaded.companions[0], false);
});

test('behavior block round-trips relations, cooldowns, and counters', () => {
  const behaviorState = {
    relations: {
      pairs: [
        { key: 'npc-a::npc-b', a: 'npc-a', b: 'npc-b', greets: 2, activities: 1, friends: true, extra: 'dropped' }
      ]
    },
    cooldowns: {
      entries: [
        { scope: 'pair', key: 'greetPair:npc-a::npc-b', readyAt: 12345 },
        { scope: 'nonsense', key: 'bad', readyAt: 1 }
      ]
    },
    counters: { greets: 4, note: 'ok', nested: { drop: true } }
  };

  const save = serializeSave(baseGame(), {}, new Set(), behaviorState);
  assert.deepEqual(save.behavior.relations.pairs, [
    { key: 'npc-a::npc-b', a: 'npc-a', b: 'npc-b', greets: 2, activities: 1, friends: true }
  ]);
  assert.deepEqual(save.behavior.cooldowns.entries, [
    { scope: 'pair', key: 'greetPair:npc-a::npc-b', readyAt: 12345 }
  ]);
  assert.deepEqual(save.behavior.counters, { greets: 4, note: 'ok' });

  const loaded = migrateSave(JSON.parse(JSON.stringify(save)));
  assert.deepEqual(loaded.behavior, save.behavior);
});

test('behavior block accepts a runtime-like blackboard and cooldown store', () => {
  const runtimeLike = {
    now: 500,
    blackboard: {
      serializeRelations: () => ({
        pairs: [{ key: 'a::b', a: 'a', b: 'b', greets: 1, activities: 0, friends: false }]
      })
    },
    cooldowns: {
      serialize: now => ({ entries: [{ scope: 'actor', key: 'greetActor:a', readyAt: now + 1000 }] })
    },
    counters: { decisions: 3 }
  };

  const block = normalizeBehaviorBlock(runtimeLike);
  assert.equal(block.relations.pairs[0].greets, 1);
  assert.equal(block.cooldowns.entries[0].readyAt, 1500);
  assert.deepEqual(block.counters, { decisions: 3 });
});

test('future save versions are rejected gracefully', () => {
  assert.equal(migrateSave({ version: 3, playerRecipe: { seed: 'x' } }), null);
  assert.equal(migrateSave({ version: 0 }), null);
  assert.equal(migrateSave(null), null);

  withLocalStorage(store => {
    store.setItem(STORAGE_KEY, JSON.stringify({
      version: 3,
      playerRecipe: { seed: 'future' },
      terrain: encodeTerrain(grassTerrain())
    }));
    assert.equal(loadSave(), null);
  });
});

test('NPC coins and reserve companions round-trip with gear', () => {
  const game = baseGame({
    npcs: [
      {
        id: 'npc-1',
        name: 'Fern',
        recipe: { seed: 'fern', look: {} },
        vibe: 'Curious',
        x: 14,
        y: 15,
        direction: 0,
        coins: 23,
        inventory: [{ id: 'checkers' }],
        equipped: [{ slot: 'hand', uid: 'checkers-0' }],
        stabledCompanions: [
          {
            id: 'npc-reserve-1',
            name: 'Moss',
            buddyId: 'npc-1',
            recipe: { style: 'dog' },
            coins: 4,
            inventory: [{ id: 'lucky-clover' }],
            equipped: [{ slot: 'charm', uid: 'lucky-clover-0' }]
          }
        ]
      }
    ],
    companions: [
      {
        id: 'npc-comp-1',
        name: 'Pip',
        buddyId: 'npc-1',
        recipe: { style: 'dog' },
        x: 15,
        y: 15,
        direction: 0,
        inventory: [{ id: 'buddy-cape' }],
        equipped: [{ slot: 'buddy', uid: 'buddy-cape-0' }]
      }
    ]
  });

  const save = serializeSave(game, {}, new Set(['npc-1']));
  assert.equal(save.version, 2);
  assert.equal(save.npcs[0].coins, 23);
  assert.equal(save.npcs[0].stabledCompanions.length, 1);
  assert.equal(save.npcs[0].stabledCompanions[0].id, 'npc-reserve-1');
  assert.equal(save.npcs[0].stabledCompanions[0].buddyId, 'npc-1');
  assert.equal(save.npcs[0].stabledCompanions[0].coins, 4);
  assert.equal(save.npcs[0].stabledCompanions[0].inventory[0].uid, 'lucky-clover-0');
  assert.deepEqual(save.npcs[0].stabledCompanions[0].equipped, [
    { slot: 'charm', uid: 'lucky-clover-0' }
  ]);
  assert.equal(save.companions[0].buddyId, 'npc-1');
  assert.equal(save.companions[0].equipped[0].uid, 'buddy-cape-0');

  const loaded = migrateSave(JSON.parse(JSON.stringify(save)));
  assert.equal(loaded.npcs[0].coins, 23);
  assert.equal(loaded.npcs[0].stabledCompanions[0].buddyId, 'npc-1');
  assert.deepEqual(
    loaded.npcs[0].stabledCompanions[0].equipped,
    save.npcs[0].stabledCompanions[0].equipped
  );
  assert.equal(loaded.npcs[0].stabledCompanions[0].inventory[0].uid, 'lucky-clover-0');
  assert.equal(loaded.companions[0].buddyId, 'npc-1');
  assert.deepEqual(loaded.companions[0].equipped, save.companions[0].equipped);
  assert.equal('path' in loaded.npcs[0].stabledCompanions[0], false);
});

test('v2 saves without NPC coins or reserve load with defaults', () => {
  const legacyV2 = {
    version: 2,
    worldSeed: 'legacy-v2',
    terrain: encodeTerrain(grassTerrain()),
    playerName: 'Tester',
    playerRecipe: { seed: 'p', look: {} },
    player: { x: 4, y: 5, direction: 0, inventory: [], equipped: [], coins: 0, stabledCompanions: [] },
    npcs: [
      {
        id: 'npc-old',
        name: 'Old Pip',
        recipe: { seed: 'n', look: {} },
        x: 8,
        y: 9,
        direction: 1,
        inventory: [{ id: 'checkers' }]
      }
    ],
    companions: [
      { id: 'comp-old', name: 'Rusty', buddyId: 'npc-old', recipe: { style: 'dog' }, x: 9, y: 9, direction: 0 }
    ],
    friends: ['npc-old'],
    wander: true
  };

  const migrated = migrateSave(legacyV2);
  assert.equal(migrated.npcs[0].coins, 0);
  assert.deepEqual(migrated.npcs[0].stabledCompanions, []);
  assert.equal(migrated.npcs[0].inventory[0].uid, 'checkers-0');

  withLocalStorage(store => {
    store.setItem(STORAGE_KEY, JSON.stringify(legacyV2));
    const loaded = loadSave();
    assert.equal(loaded.npcs[0].coins, 0);
    assert.deepEqual(loaded.npcs[0].stabledCompanions, []);
    assert.equal(loaded.companions[0].buddyId, 'npc-old');
  });
});

test('loadSave migrates a stored v1 save to v2', () => {
  withLocalStorage(store => {
    store.setItem(STORAGE_KEY, JSON.stringify({
      version: 1,
      worldSeed: 'stored',
      terrain: encodeTerrain(grassTerrain()),
      playerName: 'Stored',
      playerRecipe: { seed: 'stored', look: {} },
      player: {
        x: 3,
        y: 4,
        inventory: [{ id: 'ball', name: 'Ball' }]
      },
      npcs: [],
      companions: [],
      friends: []
    }));
    const loaded = loadSave();
    assert.equal(loaded.version, 2);
    assert.equal(loaded.player.inventory[0].uid, 'ball-0');
    assert.deepEqual(loaded.player.equipped, []);
    assert.ok(loaded.behavior);
  });
});

test('migration grants newly added starter games to existing saves once', () => {
  const v2 = {
    version: 2,
    player: { inventory: [{ id: 'ball', uid: 'ball-0' }], equipped: [] },
    npcs: [],
    companions: []
  };
  const migrated = migrateSave(v2);
  const ids = migrated.player.inventory.map(item => item.id);
  assert.ok(ids.includes('memory-grid'));
  assert.ok(ids.includes('connect-four'));
  assert.ok(ids.includes('wings'));

  const again = migrateSave(JSON.parse(JSON.stringify(migrated)));
  assert.equal(
    again.player.inventory.filter(item => item.id === 'memory-grid').length,
    1
  );
  assert.equal(
    again.player.inventory.filter(item => item.id === 'connect-four').length,
    1
  );
  assert.equal(
    again.player.inventory.filter(item => item.id === 'wings').length,
    1
  );
});

test('forage basket, apples, and mushroom clocks round-trip through a save', () => {
  const game = baseGame({
    forage: {
      apples: [{ id: 'apple:12,14', x: 12, y: 14 }],
      basket: { apple: 6, mushroom: 3 },
      harvested: { 'scenery-4': 123456 },
      nextAppleAt: 999,
      seeded: true
    }
  });
  const save = serializeSave(game, {}, new Set());
  assert.deepEqual(save.forage.apples, [{ id: 'apple:12,14', x: 12, y: 14 }]);
  assert.deepEqual(save.forage.basket, { apple: 6, mushroom: 3 });
  assert.deepEqual(save.forage.harvested, { 'scenery-4': 123456 });
  assert.equal(save.forage.seeded, true);

  const migrated = migrateSave({ version: 2, player: { inventory: [], equipped: [] } });
  assert.deepEqual(migrated.forage.basket, { apple: 0, mushroom: 0 });
  assert.deepEqual(migrated.forage.apples, []);
  assert.equal(migrated.forage.seeded, false);
});
