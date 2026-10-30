import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FORAGE_CONFIG,
  basketSummary,
  collectForageAt,
  createForageState,
  findAppleTile,
  growForage,
  isMushroomHidden,
  normalizeForage,
  seedApples
} from '../src/forage.js';
import { WORLD_SIZE, hashString, mulberry32 } from '../src/world.js';

function grassGrid() {
  return Array.from({ length: WORLD_SIZE }, () => Array.from({ length: WORLD_SIZE }, () => 'grass'));
}

function scripted(values, fallback = 0.5) {
  let index = 0;
  return () => (index < values.length ? values[index++] : fallback);
}

function seededRandom(seed = 'forage-test') {
  return mulberry32(hashString(seed));
}

test('forage config exposes apples and mushrooms with sane timings', () => {
  assert.ok(FORAGE_CONFIG.items.apple);
  assert.ok(FORAGE_CONFIG.items.mushroom);
  assert.ok(FORAGE_CONFIG.apples.initial > 0);
  assert.ok(FORAGE_CONFIG.apples.max >= FORAGE_CONFIG.apples.initial);
  assert.ok(FORAGE_CONFIG.apples.respawnMs > 0);
  assert.ok(FORAGE_CONFIG.mushrooms.respawnMs > 0);
  assert.ok(FORAGE_CONFIG.mushrooms.sceneryTypes.includes('mushroom'));
  assert.ok(FORAGE_CONFIG.mushrooms.sceneryTypes.includes('mushroom-cluster'));
});

test('normalizeForage keeps valid apples, basket counts, and harvest clocks', () => {
  const block = normalizeForage({
    apples: [
      { x: 1, y: 2 },
      { id: 'apple:3,4', x: 3, y: 4 },
      { x: 999, y: 2 },
      { x: 5, y: 5 },
      { x: 5, y: 5 }
    ],
    basket: { apple: 4, mushroom: 2 },
    harvested: { 'scenery-1': 5000, 'scenery-2': 'nope', '': 123 },
    nextAppleAt: 12345,
    seeded: true
  });

  assert.deepEqual(block.apples, [
    { id: 'apple:1,2', x: 1, y: 2 },
    { id: 'apple:3,4', x: 3, y: 4 },
    { id: 'apple:5,5', x: 5, y: 5 }
  ]);
  assert.deepEqual(block.basket, { apple: 4, mushroom: 2 });
  assert.deepEqual(block.harvested, { 'scenery-1': 5000 });
  assert.equal(block.nextAppleAt, 12345);
  assert.equal(block.seeded, true);

  const empty = normalizeForage(null);
  assert.deepEqual(empty.apples, []);
  assert.deepEqual(empty.basket, { apple: 0, mushroom: 0 });
  assert.equal(empty.seeded, false);
});

test('findAppleTile only picks walkable grass or field tiles', () => {
  const grid = Array.from({ length: WORLD_SIZE }, () => Array.from({ length: WORLD_SIZE }, () => 'water'));
  grid[32][32] = 'grass';

  const tile = findAppleTile(grid, { random: () => 0.5 });
  assert.deepEqual(tile, { x: 32, y: 32 });

  grid[32][33] = 'field';
  const occupied = new Set(['32,32']);
  const next = findAppleTile(grid, {
    random: scripted([0.5, 0.5, 0.52, 0.5]),
    occupied
  });
  assert.deepEqual(next, { x: 33, y: 32 });

  assert.equal(findAppleTile(grid, { random: () => 0.5, occupied: new Set(['32,32', '33,32']) }), null);
});

test('seedApples fills the initial crop without touching occupied tiles', () => {
  const state = createForageState();
  const occupied = new Set(['0,0']);
  const added = seedApples(state, {
    grid: grassGrid(),
    count: 5,
    occupied,
    random: seededRandom(),
    nowMs: 1000
  });

  assert.equal(added, 5);
  assert.equal(state.apples.length, 5);
  assert.equal(state.seeded, true);
  assert.equal(state.nextAppleAt, 1000 + FORAGE_CONFIG.apples.respawnMs);
  for (const apple of state.apples) {
    assert.notEqual(`${apple.x},${apple.y}`, '0,0');
    assert.match(apple.id, /^apple:\d+,\d+$/);
  }
});

test('walking onto an apple adds it to the basket exactly once', () => {
  const state = createForageState();
  state.apples.push({ id: 'apple:4,4', x: 4, y: 4 });

  const pickup = collectForageAt(state, { x: 4, y: 4, nowMs: 1000 });
  assert.equal(pickup.kind, 'apple');
  assert.equal(pickup.item.id, 'apple');
  assert.deepEqual(state.basket, { apple: 1, mushroom: 0 });
  assert.equal(state.apples.length, 0);
  assert.equal(collectForageAt(state, { x: 4, y: 4, nowMs: 1100 }), null);

  const summary = basketSummary(state);
  assert.equal(summary.apple, 1);
  assert.equal(summary.total, 1);
  assert.match(summary.label, /🍎 1/);
});

test('mushroom scenery is harvestable and returns after its respawn clock', () => {
  const now = 10_000;
  const scenery = [
    { id: 'scenery-1', type: 'mushroom', x: 2, y: 3 },
    { id: 'scenery-2', type: 'mushroom-cluster', x: 5, y: 6 },
    { id: 'scenery-3', type: 'flower-red', x: 7, y: 8 }
  ];
  const state = createForageState();

  assert.equal(collectForageAt(state, { x: 7, y: 8, scenery, nowMs: now }), null, 'flowers are not forage');
  assert.equal(isMushroomHidden(state, 'scenery-1', now), false);

  const pickup = collectForageAt(state, { x: 2, y: 3, scenery, nowMs: now });
  assert.equal(pickup.kind, 'mushroom');
  assert.equal(pickup.item.id, 'mushroom');
  assert.deepEqual(state.basket, { apple: 0, mushroom: 1 });
  assert.equal(isMushroomHidden(state, 'scenery-1', now + 1), true);
  assert.equal(isMushroomHidden(state, 'scenery-1', now + FORAGE_CONFIG.mushrooms.respawnMs), false);
  assert.equal(collectForageAt(state, { x: 2, y: 3, scenery, nowMs: now + 1 }), null);

  const grown = growForage(state, {
    grid: grassGrid(),
    nowMs: now + FORAGE_CONFIG.mushrooms.respawnMs,
    random: () => 0.5
  });
  assert.equal(grown.mushroomsReturned, 1);
  assert.equal(isMushroomHidden(state, 'scenery-1', now + FORAGE_CONFIG.mushrooms.respawnMs + 1), false);
});

test('growForage sprouts a new apple each respawn interval up to the cap', () => {
  const state = createForageState();
  state.seeded = true;
  state.nextAppleAt = 1000;
  const start = state.apples.length;

  const first = growForage(state, { grid: grassGrid(), nowMs: 1000, random: () => 0.5 });
  assert.equal(first.applesAdded, 1);
  assert.equal(state.apples.length, start + 1);
  assert.equal(state.nextAppleAt, 1000 + FORAGE_CONFIG.apples.respawnMs);

  // One huge jump should still respect the maximum crop size.
  growForage(state, {
    grid: grassGrid(),
    nowMs: 1000 + FORAGE_CONFIG.apples.respawnMs * 100,
    random: () => 0.5
  });
  assert.ok(state.apples.length <= FORAGE_CONFIG.apples.max);
  assert.ok(state.nextAppleAt > 1000);
});
