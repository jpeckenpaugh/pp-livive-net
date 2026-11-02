import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WORLD_SIZE,
  TILE_TYPES,
  generateWorld,
  encodeTerrain,
  decodeTerrain,
  findPath,
  findOpenTile,
  largestComponentFrom,
  isWalkable,
  typeAt
} from '../src/world.js';

test('generates valid 64 × 64 worlds for several seeds', () => {
  for (const seed of ['fern-test', 'moss-2', 'clover-x', 'island', 'river']) {
    const world = generateWorld(seed);
    assert.equal(world.grid.length, WORLD_SIZE);
    for (const row of world.grid) {
      assert.equal(row.length, WORLD_SIZE);
      for (const tile of row) assert.ok(TILE_TYPES.includes(tile));
    }
    assert.ok(world.component.length > 0, 'has a walkable component');
    assert.ok(isWalkable(typeAt(world.grid, world.spawn.x, world.spawn.y)), 'spawn is walkable');
  }
});

test('terrain round-trips through the save format', () => {
  const world = generateWorld('round-trip');
  const encoded = encodeTerrain(world.grid);
  assert.equal(encoded.length, WORLD_SIZE * WORLD_SIZE);
  assert.deepEqual(decodeTerrain(encoded), world.grid);

  assert.equal(decodeTerrain('too short'), null);
  assert.equal(decodeTerrain('z'.repeat(WORLD_SIZE * WORLD_SIZE)), null);
});

test('generated component is the largest and fully walkable', () => {
  const world = generateWorld('largest-component');
  const largest = largestComponentFrom(world.grid);
  assert.equal(largest.length, world.component.length);
  for (const cell of largest) assert.ok(isWalkable(world.grid[cell.y][cell.x]));
});

test('findPath returns a connected walkable path', () => {
  const world = generateWorld('pathfinding');
  const target = world.component.find(cell =>
    Math.abs(cell.x - world.spawn.x) + Math.abs(cell.y - world.spawn.y) > 6
  );
  assert.ok(target, 'found a distant target');

  const path = findPath(world.grid, world.spawn, target);
  assert.ok(path.length > 0);

  let previous = world.spawn;
  for (const step of path) {
    assert.equal(Math.abs(step.x - previous.x) + Math.abs(step.y - previous.y), 1);
    assert.ok(isWalkable(world.grid[step.y][step.x]));
    previous = step;
  }
  assert.deepEqual(path.at(-1), target);
});

test('findPath respects blocked tiles', () => {
  const world = generateWorld('blocked-paths');
  const target = world.component.find(cell =>
    Math.abs(cell.x - world.spawn.x) + Math.abs(cell.y - world.spawn.y) > 4
  );
  assert.ok(findPath(world.grid, world.spawn, target).length > 0);
  assert.deepEqual(findPath(world.grid, world.spawn, target, new Set([`${target.x},${target.y}`])), []);
});

test('findOpenTile avoids occupied tiles and respects distance', () => {
  const world = generateWorld('open-tiles');
  const occupied = new Set([`${world.spawn.x},${world.spawn.y}`, '0,0']);
  const spot = findOpenTile(world.grid, world.spawn, occupied, 2);
  const distance = Math.abs(spot.x - world.spawn.x) + Math.abs(spot.y - world.spawn.y);
  assert.ok(distance >= 2);
  assert.ok(isWalkable(typeAt(world.grid, spot.x, spot.y)));
  assert.ok(!occupied.has(`${spot.x},${spot.y}`));
});

test('out-of-range tiles are not walkable', () => {
  assert.equal(typeAt(generateWorld('bounds').grid, -1, 0), null);
  assert.equal(isWalkable(null), false);
});
