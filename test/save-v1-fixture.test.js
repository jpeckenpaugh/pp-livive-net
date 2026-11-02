import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeTerrain, encodeTerrain } from '../src/world.js';
import {
  SAVE_VERSION,
  migrateSave,
  serializeSave
} from '../src/storage.js';

function grassTerrain() {
  return Array.from({ length: 64 }, () => Array.from({ length: 64 }, () => 'grass'));
}

// A representative pre-v2 save: legacy full item objects, no uids, no
// equipped arrays, and no behavior block at all.
function makeV1Fixture() {
  return {
    version: 1,
    worldSeed: 'fixture-seed-1',
    terrain: encodeTerrain(grassTerrain()),
    playerName: 'Fixture Pal',
    playerRecipe: { seed: 'fixture', look: { style: 'voxel-art' } },
    player: {
      x: 8,
      y: 9,
      direction: 1,
      coins: 17,
      inventory: [
        { id: 'ball', name: 'Bouncy Ball', color: '#ffffff' },
        { id: 'chamo-clip', name: 'Chamo Clip' }
      ],
      stabledCompanions: [
        {
          id: 'stable-1',
          name: 'Mo',
          buddyId: 'player',
          recipe: { style: 'dog' },
          inventory: [{ id: 'buddy-cape', name: 'Buddy Cape' }]
        }
      ]
    },
    npcs: [
      {
        id: 'npc-1',
        name: 'Fern',
        recipe: { seed: 'fern', look: {} },
        x: 12,
        y: 9,
        direction: 0,
        inventory: [{ id: 'checkers', name: 'Checkerboard' }]
      }
    ],
    companions: [
      {
        id: 'comp-1',
        name: 'Pip',
        buddyId: 'player',
        recipe: { style: 'dog' },
        x: 9,
        y: 9,
        direction: 0,
        inventory: [{ id: 'lucky-clover', name: 'Lucky Clover' }]
      }
    ],
    friends: ['npc-1', 42],
    wander: true
  };
}

function emptyBehaviorBlock() {
  return {
    version: 1,
    relations: { version: 1, pairs: [] },
    cooldowns: { version: 1, entries: [] },
    counters: {}
  };
}

function hydrateGame(save) {
  return {
    worldSeed: save.locations.park.seed,
    terrain: decodeTerrain(save.locations.park.terrain),
    wander: save.wander,
    player: {
      name: save.playerName,
      recipe: save.playerRecipe,
      x: save.locations.park.player.x,
      y: save.locations.park.player.y,
      direction: save.locations.park.player.direction,
      inventory: save.player.inventory,
      equipped: save.player.equipped,
      coins: save.player.coins,
      stabledCompanions: save.player.stabledCompanions
    },
    npcs: save.locations.park.npcs,
    companions: save.companions
  };
}

test('v1 fixture migrates to v4 with item instances, equipped arrays, and an empty behavior block', () => {
  const fixture = makeV1Fixture();
  const migrated = migrateSave(fixture);

  assert.ok(migrated);
  assert.equal(migrated.version, SAVE_VERSION);
  assert.equal(migrated.version, 4);
  assert.equal(migrated.locations.park.seed, fixture.worldSeed);
  assert.equal(migrated.locations.park.terrain, fixture.terrain);
  assert.equal(migrated.playerName, fixture.playerName);
  assert.deepEqual(migrated.playerRecipe, fixture.playerRecipe);
  assert.ok(decodeTerrain(migrated.locations.park.terrain), 'fixture terrain should stay valid');

  // Legacy item objects become instances with deterministic uids, retaining
  // their custom fields and leaving the inventory order intact.
  assert.deepEqual(
    migrated.player.inventory.slice(0, 2).map(item => [item.id, item.uid, item.name]),
    [
      ['ball', 'ball-0', 'Bouncy Ball'],
      ['chamo-clip', 'chamo-clip-1', 'Chamo Clip']
    ]
  );
  assert.equal(migrated.player.inventory[0].color, '#ffffff');
  assert.deepEqual(migrated.player.equipped, []);
  assert.equal(migrated.player.coins, 17);

  assert.deepEqual(migrated.locations.park.npcs[0].inventory.map(item => item.uid), ['checkers-0']);
  assert.deepEqual(migrated.locations.park.npcs[0].equipped, []);
  assert.deepEqual(migrated.companions[0].inventory.map(item => item.uid), ['lucky-clover-0']);
  assert.deepEqual(migrated.companions[0].equipped, []);

  const stabled = migrated.player.stabledCompanions[0];
  assert.deepEqual(stabled.inventory.map(item => item.uid), ['buddy-cape-0']);
  assert.deepEqual(stabled.equipped, []);

  assert.deepEqual(migrated.friends, ['npc-1']);
  assert.deepEqual(migrated.behavior, emptyBehaviorBlock());
});

test('migrated v1 save serializes back to v4 and survives a JSON round-trip', () => {
  const migrated = migrateSave(makeV1Fixture());
  const game = hydrateGame(migrated);
  const saved = serializeSave(game, {}, new Set(migrated.friends), migrated.behavior);

  assert.ok(saved);
  assert.equal(saved.version, 4);
  assert.equal(saved.playerName, 'Fixture Pal');
  assert.equal(saved.locations.park.terrain, migrated.locations.park.terrain);
  const savedUids = saved.player.inventory.map(item => item.uid);
  assert.deepEqual(savedUids.slice(0, 2), ['ball-0', 'chamo-clip-1']);
  const savedIds = saved.player.inventory.map(item => item.id);
  for (const id of ['big-o-bracelet', 'chamo-clip', 'teleport-tricorder']) {
    assert.ok(savedIds.includes(id), `v1 migration should retain/grant ${id}`);
  }
  assert.equal(saved.player.inventory[0].color, '#ffffff');
  assert.deepEqual(saved.player.equipped, []);
  assert.deepEqual(saved.locations.park.npcs[0].equipped, []);
  assert.deepEqual(saved.companions[0].equipped, []);
  assert.deepEqual(saved.player.stabledCompanions[0].equipped, []);
  assert.deepEqual(saved.behavior, emptyBehaviorBlock());
  assert.deepEqual(saved.friends, ['npc-1']);

  // JSON is the real save boundary; undefined-only keys such as an absent NPC
  // vibe are dropped there on purpose.
  const normalized = JSON.parse(JSON.stringify(saved));
  const roundTripped = migrateSave(JSON.parse(JSON.stringify(saved)));
  assert.ok(roundTripped);
  assert.equal(roundTripped.version, 4);
  assert.deepEqual(roundTripped.player.inventory, normalized.player.inventory);
  assert.deepEqual(roundTripped.player.equipped, normalized.player.equipped);
  assert.deepEqual(roundTripped.locations.park.npcs, normalized.locations.park.npcs);
  assert.deepEqual(roundTripped.companions, normalized.companions);
  assert.deepEqual(roundTripped.player.stabledCompanions, normalized.player.stabledCompanions);
  assert.deepEqual(roundTripped.behavior, normalized.behavior);
  assert.deepEqual(
    decodeTerrain(roundTripped.locations.park.terrain),
    decodeTerrain(normalized.locations.park.terrain)
  );
});
