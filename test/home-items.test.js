import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeTerrain, findPath, generateHome } from '../src/world.js';
import { createHomeLocation, locationDef } from '../src/locations.js';
import { captureLocationRecord } from '../src/storage.js';
import { Game } from '../src/game.js';
import { homeRoomTiles } from '../src/home.js';
import {
  BACKPACK_ITEM_IDS,
  HOME_ITEM_IDS,
  HOME_ITEM_ITEMS,
  blockedTiles,
  canPlaceHomeItem,
  doorLaneTiles,
  expandDefaultLayout,
  footprintTiles,
  hasDoorPath,
  homeItem,
  homeItemAt,
  homeItemSize,
  homeItemTierInfo,
  houseInteriorTiles,
  itemColors,
  itemTierAccent,
  loadHomeItems,
  normalizeHomeItems,
  normalizeRotation,
  normalizeTier,
  rugTiles,
  upgradeHomeItem
} from '../src/home_items.js';

const HOME_SEED = locationDef('home').seed;
const HOUSE = locationDef('home').house;
const DOOR = locationDef('home').door;

function homeWorld() {
  return generateHome(HOME_SEED);
}

function key(tile) {
  return `${tile.x},${tile.y}`;
}

test('home_items.json describes every furnished room type with three quality tiers', () => {
  assert.equal(HOME_ITEM_IDS.length, 17);

  for (const id of HOME_ITEM_IDS) {
    const item = HOME_ITEM_ITEMS[id];
    assert.equal(item.id, id);
    assert.equal(typeof item.label, 'string');
    assert.ok(item.label.length > 0);
    assert.ok(['living', 'kitchen', 'dining', 'bedroom'].includes(item.zone), `${id} zone`);
    assert.ok(Number(item.size.w) >= 1 && Number(item.size.h) >= 1, `${id} size`);
    assert.equal(typeof item.solid, 'boolean', `${id} solid`);
    assert.equal(item.shape, id, `${id} shape`);
    assert.equal(typeof item.colors.base, 'string', `${id} base colour`);
    assert.equal(typeof item.colors.accent, 'string', `${id} accent colour`);
    assert.ok(Array.isArray(item.variants) && item.variants.length >= 2, `${id} variants`);
    assert.ok(item.variants.every(variant => variant.id && typeof variant.label === 'string'));
    assert.ok(Array.isArray(item.tiers) && item.tiers.length === 3, `${id} tiers`);
    assert.equal(item.tiers[0].name, 'plain');
    assert.equal(item.tiers[0].price, 0);
    assert.ok(item.tiers.every(tier => typeof tier.name === 'string' && tier.name.length > 0));
    assert.ok(item.tiers.every(tier => Number.isFinite(tier.price) && tier.price >= 0));
    assert.ok(item.tiers.every(tier => /^#[0-9a-f]{6}$/i.test(tier.accent)));
    assert.ok(
      item.interact === null
        || (typeof item.interact === 'object' && typeof item.interact.kind === 'string'),
      `${id} interaction descriptor`
    );
  }

  assert.equal(homeItem('rug').solid, false);
  assert.equal(homeItem('rug').ground, true);
  assert.equal(homeItem('plant').solid, true);
  assert.equal(homeItem('bed').size.h, 3);
  assert.deepEqual(BACKPACK_ITEM_IDS, ['rug', 'plant']);
  assert.equal(homeItem('nope'), null);

  // Variants override only the palette keys they name.
  const plain = itemColors('couch', 0);
  const warm = itemColors('couch', 1);
  assert.equal(plain.trim, warm.trim);
  assert.notEqual(plain.base, warm.base);
  assert.equal(itemColors('couch', 99).base, plain.base);
});

test('quality tiers default to plain, clamp bad values, and price the ladder', () => {
  const home = homeWorld();
  const items = expandDefaultLayout(home.house);

  // New records are plain and free.
  assert.ok(items.every(record => record.tier === 0));
  assert.deepEqual(normalizeHomeItems([{ uid: 'c', itemId: 'chair', x: 5, y: 5 }]), [
    { uid: 'c', itemId: 'chair', x: 5, y: 5, rot: 0, variant: 0, tier: 0, on: false }
  ]);
  // Missing or nonsense saves migrate to 0; a valid tier survives.
  const [saved] = normalizeHomeItems([{ uid: 'c', itemId: 'chair', x: 5, y: 5, tier: 2 }]);
  assert.equal(saved.tier, 2);
  assert.equal(normalizeHomeItems([{ uid: 'c', itemId: 'chair', x: 5, y: 5, tier: 9 }])[0].tier, 0);
  assert.equal(normalizeHomeItems([{ uid: 'c', itemId: 'chair', x: 5, y: 5, tier: 'x' }])[0].tier, 0);
  assert.equal(normalizeTier(homeItem('chair'), -1), 0);

  const plainTier = homeItemTierInfo('chair', 0);
  assert.deepEqual(plainTier, {
    index: 0,
    name: 'plain',
    price: 0,
    accent: homeItem('chair').tiers[0].accent,
    max: 2,
    next: {
      index: 1,
      name: 'comfy',
      price: 10,
      accent: homeItem('chair').tiers[1].accent
    }
  });
  assert.equal(homeItemTierInfo('chair', 2).next, null);

  // Only upgraded pieces paint a trim accent.
  assert.equal(itemTierAccent('chair', 0), null);
  assert.equal(itemTierAccent('chair', 1), '#e2c48a');
  assert.equal(itemTierAccent('chair', 2), '#cfe9f4');
});

test('upgrading with coins bumps one tier, refuses shortfalls, and stops at deluxe', () => {
  const items = expandDefaultLayout(homeWorld().house);
  const couch = items.find(record => record.itemId === 'couch');

  const poor = upgradeHomeItem(items, couch.uid, 4);
  assert.equal(poor.ok, false);
  assert.equal(poor.reason, 'insufficient');
  assert.equal(poor.short, 6);
  assert.equal(poor.items, items, 'a failed purchase leaves the list untouched');

  const first = upgradeHomeItem(items, couch.uid, 12);
  assert.equal(first.ok, true);
  assert.equal(first.coins, 2);
  assert.equal(first.cost, 10);
  assert.equal(first.tier.name, 'comfy');
  assert.equal(first.items.find(record => record.uid === couch.uid).tier, 1);
  assert.equal(first.items.find(record => record.uid !== couch.uid).tier, 0);

  const second = upgradeHomeItem(first.items, couch.uid, first.coins + 25);
  assert.equal(second.ok, true);
  assert.equal(second.items.find(record => record.uid === couch.uid).tier, 2);
  assert.equal(second.coins, 2);

  const maxed = upgradeHomeItem(second.items, couch.uid, 999);
  assert.equal(maxed.ok, false);
  assert.equal(maxed.reason, 'max-tier');
  assert.equal(maxed.items, second.items);
  assert.equal(upgradeHomeItem(items, 'nope', 999).reason, 'unknown-item');
});

test('a purchased tier survives the save round-trip', () => {
  const home = homeWorld();
  const items = expandDefaultLayout(home.house);
  const bed = items.find(record => record.itemId === 'bed');
  const bought = upgradeHomeItem(items, bed.uid, 25).items;

  const record = captureLocationRecord({
    seed: HOME_SEED,
    terrain: encodeTerrain(home.grid),
    player: { x: home.spawn.x, y: home.spawn.y, direction: 0 },
    npcs: [],
    forage: createHomeLocation().forage,
    items: bought
  }, null);

  const loaded = normalizeHomeItems(record.items, { roomTiles: houseInteriorTiles(home.house) });
  assert.equal(loaded.find(entry => entry.uid === bed.uid).tier, 1);
  assert.equal(loadHomeItems(record, { house: home.house, door: home.door })
    .find(entry => entry.uid === bed.uid).tier, 1);
});

test('the default layout fits the house, never overlaps, and keeps the door reachable', () => {
  const home = homeWorld();
  const items = expandDefaultLayout(home.house);
  assert.equal(items.length, 18);

  const room = new Set(houseInteriorTiles(home.house).map(key));
  const used = new Map();
  for (const record of items) {
    assert.ok(record.uid.startsWith('home_'));
    assert.equal(record.on, false);
    const tiles = footprintTiles(record);
    assert.ok(tiles.length > 0, `${record.itemId} footprint`);
    for (const tile of tiles) {
      assert.ok(room.has(key(tile)), `${record.itemId} escapes the interior at ${key(tile)}`);
      assert.equal(used.has(key(tile)), false, `${record.itemId} overlaps ${used.get(key(tile))}`);
      used.set(key(tile), record.itemId);
    }
  }
  assert.equal(new Set(items.map(record => record.uid)).size, items.length);

  const lane = doorLaneTiles({ house: home.house, door: home.door });
  for (const tileKey of used.keys()) {
    assert.ok(!lane.has(tileKey), `furniture blocks the door lane at ${tileKey}`);
  }

  const blocked = blockedTiles(items);
  assert.ok(findPath(home.grid, home.door, home.spawn, blocked).length > 0, 'door reaches spawn');
  assert.equal(hasDoorPath({
    terrain: home.grid,
    items,
    house: home.house,
    door: home.door,
    target: home.spawn
  }), true);

  // Every free interior tile is reachable, so buddy wander cannot be sealed in.
  for (const tile of houseInteriorTiles(home.house)) {
    if (blocked.has(key(tile))) continue;
    assert.ok(
      findPath(home.grid, home.door, tile, blocked).length > 0,
      `${key(tile)} is walled off`
    );
  }
});

test('rotation swaps width and height on odd quarter turns', () => {
  assert.deepEqual(homeItemSize('bed', 0), { w: 2, h: 3 });
  assert.deepEqual(homeItemSize('bed', 1), { w: 3, h: 2 });
  assert.deepEqual(homeItemSize('bed', 2), { w: 2, h: 3 });
  assert.deepEqual(homeItemSize('bed', 3), { w: 3, h: 2 });
  assert.deepEqual(homeItemSize('bed', -1), { w: 3, h: 2 });
  assert.equal(normalizeRotation(5), 1);
  assert.equal(normalizeRotation(-2), 2);

  const tiles = footprintTiles({ itemId: 'bed', x: 30, y: 25, rot: 1 });
  assert.equal(tiles.length, 6);
  const width = Math.max(...tiles.map(tile => tile.x)) - Math.min(...tiles.map(tile => tile.x)) + 1;
  const height = Math.max(...tiles.map(tile => tile.y)) - Math.min(...tiles.map(tile => tile.y)) + 1;
  assert.deepEqual({ width, height }, { width: 3, height: 2 });
  assert.deepEqual(footprintTiles({ itemId: 'nope', x: 1, y: 1 }), []);
});

test('solid footprints join the blocked set and the rug does not', () => {
  const home = homeWorld();
  const items = expandDefaultLayout(home.house);
  const blocked = blockedTiles(items);
  assert.equal(blocked.size, 30);

  const rug = items.find(record => record.itemId === 'rug');
  assert.equal(rugTiles(items).length, 4);
  for (const tile of footprintTiles(rug)) {
    assert.equal(blocked.has(key(tile)), false, 'the rug must stay walkable');
  }

  const couch = items.find(record => record.itemId === 'couch');
  assert.equal(blocked.has(key(couch)), true);
  assert.equal(homeItemAt(items, couch.x, couch.y)?.uid, couch.uid);
  assert.equal(homeItemAt(items, couch.x, couch.y + 1), null);
  assert.equal(blockedTiles([]).size, 0);
});

test('placement validation rejects walls, the door lane, and overlapping solid furniture', () => {
  const home = homeWorld();
  const room = houseInteriorTiles(home.house);
  const items = expandDefaultLayout(home.house);
  const blocked = blockedTiles(items);
  const lane = doorLaneTiles({ house: home.house, door: home.door });

  const free = room.find(tile => !blocked.has(key(tile)) && !lane.has(key(tile)));
  assert.ok(free);
  const place = (itemId, x, y, extra = {}) => canPlaceHomeItem({
    items,
    itemId,
    x,
    y,
    roomTiles: room,
    house: home.house,
    door: home.door,
    terrain: home.grid,
    ...extra
  });

  assert.deepEqual(place('chair', free.x, free.y), { ok: true, reason: null });
  assert.equal(place('chair', home.house.x, home.house.y).reason, 'outside-room');
  assert.equal(place('chair', 0, 0).reason, 'outside-room');
  assert.equal(place('chair', home.spawn.x, home.spawn.y).reason, 'door-lane');
  assert.equal(place('nope', free.x, free.y).reason, 'unknown-item');

  const couch = items.find(record => record.itemId === 'couch');
  assert.equal(place('chair', couch.x, couch.y).reason, 'occupied');

  // Ground cover may sit under furniture, but two ground pieces may not stack.
  const rug = items.find(record => record.itemId === 'rug');
  assert.equal(place('chair', rug.x, rug.y).ok, true);
  assert.equal(place('rug', rug.x, rug.y).reason, 'occupied');

  // Moving a piece onto its own tile is not an overlap with itself.
  assert.equal(place(couch.itemId, couch.x, couch.y, { uid: couch.uid }).ok, true);

  // A corrupt save that blocks the doorway makes the path primitive fail.
  const sealed = [{ ...couch, x: home.door.x, y: home.door.y - 1 }];
  assert.equal(hasDoorPath({
    terrain: home.grid,
    items: sealed,
    house: home.house,
    door: home.door,
    target: home.spawn
  }), false);
});

test('saved items normalize, round-trip, and migrate the old decor record once', () => {
  const home = homeWorld();
  const terrain = encodeTerrain(home.grid);
  const player = { x: home.spawn.x, y: home.spawn.y, direction: 0 };
  const forage = createHomeLocation().forage;
  const items = expandDefaultLayout(home.house);

  const record = captureLocationRecord({
    seed: HOME_SEED,
    terrain,
    player,
    npcs: [],
    forage,
    items
  }, null);
  assert.deepEqual(record.items, items);
  assert.equal('decor' in record, false);

  const again = captureLocationRecord(record, record);
  assert.deepEqual(again.items, items);
  assert.deepEqual(loadHomeItems(record, { house: home.house, door: home.door }), items);

  // Malformed records are dropped, unknown items are ignored, rotation is clamped.
  assert.deepEqual(normalizeHomeItems([{ itemId: 'nope', x: 1, y: 1 }]), []);
  assert.deepEqual(normalizeHomeItems([{ itemId: 'chair', x: 'x', y: 1 }]), []);
  const clamped = normalizeHomeItems([{ itemId: 'chair', x: 30, y: 30, rot: 7, variant: 9 }]);
  assert.equal(clamped.length, 1);
  assert.equal(clamped[0].rot, 3);
  assert.equal(clamped[0].variant, 0);

  // A legacy save with only decor converts that placement into an item, once.
  const legacy = { ...record };
  delete legacy.items;
  const plant = items.find(entry => entry.itemId === 'plant');
  legacy.decor = [{ id: 'plant', x: plant.x + 3, y: plant.y + 2 }];
  const migrated = loadHomeItems(legacy, { house: home.house, door: home.door });
  assert.equal(migrated.length, 18);
  assert.deepEqual(
    migrated.find(entry => entry.itemId === 'plant'),
    { ...plant, x: plant.x + 3, y: plant.y + 2 }
  );
  assert.equal(migrated.filter(entry => entry.itemId === 'plant').length, 1);
  assert.equal(migrated.filter(entry => entry.itemId === 'rug').length, 1);

  // Items win on the next load, so the stale decor key stays unread.
  const loadedAgain = loadHomeItems({ ...legacy, items: migrated }, {
    house: home.house,
    door: home.door
  });
  assert.deepEqual(loadedAgain, migrated);

  // Capture keeps an old decor key for a downgrade but never needs it.
  const kept = captureLocationRecord({ ...record, items: null }, legacy);
  assert.deepEqual(kept.decor, legacy.decor);
});

test('furniture blocks player steps in Home and leaves Park collision untouched', () => {
  const home = homeWorld();
  const items = expandDefaultLayout(home.house);
  const player = {
    id: 'player',
    name: 'You',
    recipe: { seed: 'player', style: 'voxel-art' },
    x: home.spawn.x,
    y: home.spawn.y,
    direction: 0,
    inventory: [],
    equipped: []
  };

  const game = new Game();
  game.setWorld({
    terrain: home.grid,
    worldSeed: HOME_SEED,
    player,
    npcs: [],
    companions: [],
    scenery: [],
    forage: null,
    homeItems: items,
    homeMode: true,
    homeBuddies: [],
    homeRoomTiles: homeRoomTiles(home.grid, home.house),
    homeRugTiles: rugTiles(items)
  });
  game.interactive = true;

  const couch = items.find(record => record.itemId === 'couch');
  game.player.x = couch.x;
  game.player.y = couch.y + 1;
  assert.equal(game.tryPlayerStep(0, -1), false);
  assert.deepEqual({ x: game.player.x, y: game.player.y }, { x: couch.x, y: couch.y + 1 });

  // The rug is walkable.
  const rug = items.find(record => record.itemId === 'rug');
  game.player.x = rug.x;
  game.player.y = rug.y - 1;
  assert.equal(game.tryPlayerStep(0, 1), true);

  // A Park world built on the same terrain ignores the furniture entirely.
  game.setWorld({
    terrain: home.grid,
    worldSeed: 'park',
    player: { ...player, x: couch.x, y: couch.y + 1 },
    npcs: [],
    companions: [],
    scenery: [],
    forage: null
  });
  game.interactive = true;
  assert.equal(game.homeBlockedTiles.size, 0);
  assert.equal(game.tryPlayerStep(0, -1), true);
});
