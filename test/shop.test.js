import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createShopLocation,
  doorFor,
  doorsFor,
  isLocationEnabled,
  locationDef,
  travelTargets,
  worldFor
} from '../src/locations.js';
import { encodeTerrain, isWalkable, typeAt } from '../src/world.js';
import {
  HOME_ITEM_ITEMS,
  SHOP_STOCK_IDS,
  buyShopItem,
  canPlaceHomeItem,
  consumeHomeStorage,
  findHomePlacementTile,
  homeItem,
  houseInteriorTiles,
  loadHomeItems,
  nextHomeUid,
  normalizeHomeStorage,
  shopStock
} from '../src/home_items.js';
import { captureLocationRecord, activeLocation } from '../src/storage.js';

const SHOP = locationDef('shop');
const SHOP_ITEMS = JSON.parse(readFileSync(new URL('../data/home_items.json', import.meta.url), 'utf8'));

function shopWorld() {
  return worldFor('shop', SHOP.seed);
}

test('the shop ships enabled with a room, a spawn, a return door, and a menu row', () => {
  assert.ok(SHOP);
  assert.equal(isLocationEnabled('shop'), true);
  assert.equal(SHOP.label, 'Shop');
  assert.equal(SHOP.mapLabel, 'Shop map');
  assert.equal(SHOP.forage, false);
  assert.equal(SHOP.menu.label, 'Shop');
  assert.equal(SHOP.door.to, 'town');

  const { x, y, width, height } = SHOP.house;
  assert.ok(width >= 5 && height >= 5, 'the shop needs a floor');
  const onWall = SHOP.door.x === x || SHOP.door.x === x + width - 1
    || SHOP.door.y === y || SHOP.door.y === y + height - 1;
  assert.ok(onWall, 'the shop door must cut through a wall');
  const inside = SHOP.spawn.x > x && SHOP.spawn.x < x + width - 1
    && SHOP.spawn.y > y && SHOP.spawn.y < y + height - 1;
  assert.ok(inside, 'the shop spawn must stand inside the room');

  const targets = travelTargets('park').map(target => target.id);
  assert.ok(targets.includes('shop'), 'the park menu offers the shop');
  assert.ok(travelTargets('shop').some(target => target.id === 'park'));
});

test('the shop reuses the Home builder and keeps both doors walkable', () => {
  const world = shopWorld();
  assert.equal(world.grid.length, 64);
  assert.equal(typeAt(world.grid, SHOP.spawn.x, SHOP.spawn.y), 'home-floor');
  assert.equal(typeAt(world.grid, world.door.x, world.door.y), 'home-floor');
  assert.equal(typeAt(world.grid, SHOP.shopkeeper.x, SHOP.shopkeeper.y), 'home-floor');
  assert.ok(isWalkable(typeAt(world.grid, world.spawn.x, world.spawn.y)));

  // Interior lots opt out of mushrooms, like Home.
  assert.equal((world.scenery || []).some(item => item.type.includes('mushroom')), false);

  const door = doorFor('shop', { terrain: world.grid, spawn: world.spawn });
  assert.ok(door);
  assert.equal(door.to, 'town');
  const doors = doorsFor('shop', { terrain: world.grid, spawn: world.spawn });
  assert.deepEqual(doors.map(entry => entry.kind), ['travel']);
  assert.equal(doors[0].to, 'town');
});

test('a fresh shop record contains one fixed shopkeeper and no party', () => {
  const record = createShopLocation();
  assert.equal(record.seed, SHOP.seed);
  assert.equal(record.npcs.length, 1);
  const keeper = record.npcs[0];
  assert.equal(keeper.id, SHOP.shopkeeper.id);
  assert.equal(keeper.name, SHOP.shopkeeper.name);
  assert.deepEqual({ x: keeper.x, y: keeper.y }, {
    x: SHOP.shopkeeper.x,
    y: SHOP.shopkeeper.y
  });
  assert.equal(keeper.recipe.seed, SHOP.shopkeeper.seed);
  assert.equal(keeper.path, undefined, 'the keeper is not a wanderer');
  assert.deepEqual(record.player, { x: SHOP.spawn.x, y: SHOP.spawn.y, direction: 0 });
  assert.equal(record.forage.seeded, true);
  assert.deepEqual(record.forage.apples, []);
});

test('the catalog sells the three new pieces at their listed prices', () => {
  const stock = shopStock();
  assert.deepEqual(stock.map(entry => entry.itemId), ['piano', 'aquarium', 'wall-clock']);
  assert.deepEqual(stock.map(entry => entry.price), [15, 30, 20]);
  for (const entry of stock) {
    const item = homeItem(entry.itemId);
    assert.ok(item, `${entry.itemId} resolves`);
    assert.equal(item.solid, true);
    assert.equal(item.shape, entry.itemId);
    assert.equal(item.price, entry.price);
    assert.ok(entry.label && entry.icon);
  }
  assert.deepEqual(SHOP_STOCK_IDS, SHOP_ITEMS.shop.stock);
});

test('buying deducts coins, adds an unplaced copy, and refuses shortfalls', () => {
  const rich = buyShopItem('piano', { coins: 20, storage: [] });
  assert.equal(rich.ok, true);
  assert.equal(rich.cost, 15);
  assert.equal(rich.coins, 5);
  assert.deepEqual(rich.storage, [{ itemId: 'piano', variant: 0 }]);

  const again = buyShopItem('wall-clock', { coins: rich.coins + 20, storage: rich.storage });
  assert.equal(again.ok, true);
  assert.equal(again.coins, 5);
  assert.deepEqual(again.storage.map(entry => entry.itemId), ['piano', 'wall-clock']);

  const poor = buyShopItem('aquarium', { coins: 5, storage: again.storage });
  assert.equal(poor.ok, false);
  assert.equal(poor.reason, 'insufficient');
  assert.equal(poor.short, 25);
  assert.equal(poor.cost, 30);
  assert.deepEqual(poor.storage, again.storage, 'a failed buy changes nothing');
  assert.equal(poor.coins, 5);

  assert.equal(buyShopItem('nope', { coins: 99, storage: [] }).reason, 'unknown-item');
  assert.equal(buyShopItem('nope', { coins: 99 }).storage.length, 0);
});

test('home storage normalizes, consumes, and survives the save round-trip', () => {
  assert.deepEqual(normalizeHomeStorage([
    { itemId: 'piano', variant: 1 },
    { itemId: 'nope', variant: 0 },
    { itemId: 'aquarium', variant: 99 },
    null
  ]), [
    { itemId: 'piano', variant: 1 },
    { itemId: 'aquarium', variant: 0 }
  ]);
  assert.deepEqual(normalizeHomeStorage(null), []);

  const first = consumeHomeStorage([
    { itemId: 'piano', variant: 0 },
    { itemId: 'aquarium', variant: 1 }
  ], 0);
  assert.equal(first.ok, true);
  assert.deepEqual(first.entry, { itemId: 'piano', variant: 0 });
  assert.deepEqual(first.storage, [{ itemId: 'aquarium', variant: 1 }]);
  assert.equal(consumeHomeStorage([], 0).ok, false);
  assert.equal(consumeHomeStorage([{ itemId: 'piano' }], 4).ok, false);

  const world = shopWorld();
  const record = captureLocationRecord({
    seed: SHOP.seed,
    terrain: encodeTerrain(world.grid),
    player: { x: world.spawn.x, y: world.spawn.y, direction: 0 },
    npcs: [],
    forage: createShopLocation().forage,
    storage: [{ itemId: 'aquarium', variant: 2 }]
  }, null);
  assert.deepEqual(record.storage, [{ itemId: 'aquarium', variant: 2 }]);

  const again = captureLocationRecord(record, record);
  assert.deepEqual(again.storage, record.storage);

  // The live Home record surfaces storage, so a reload at Home sees it.
  const state = {
    version: 4,
    currentLocation: 'home',
    locations: {
      park: { seed: 'park', terrain: encodeTerrain(world.grid), npcs: [], forage: null },
      home: { ...record, items: [] }
    }
  };
  assert.deepEqual(activeLocation(state).storage, [{ itemId: 'aquarium', variant: 2 }]);
});

test('placing a stored piece adds it to the room and removes it from storage', () => {
  const world = worldFor('home');
  const house = locationDef('home').house;
  const door = locationDef('home').door;
  const roomTiles = houseInteriorTiles(house);
  const items = loadHomeItems({ items: [] }, { house, door, roomTiles });

  const stored = [
    { itemId: 'piano', variant: 1 },
    { itemId: 'wall-clock', variant: 0 }
  ];
  const spot = findHomePlacementTile({
    items,
    itemId: 'piano',
    roomTiles,
    house,
    door,
    terrain: world.grid
  });
  assert.ok(spot, 'an empty room has space for the piano');
  assert.equal(canPlaceHomeItem({
    items,
    itemId: 'piano',
    x: spot.x,
    y: spot.y,
    roomTiles,
    house,
    door,
    terrain: world.grid
  }).ok, true);

  const consumed = consumeHomeStorage(stored, 0);
  assert.equal(consumed.ok, true);
  const placed = {
    uid: nextHomeUid(items, 'piano'),
    itemId: 'piano',
    x: spot.x,
    y: spot.y,
    rot: 0,
    variant: consumed.entry.variant,
    tier: 0,
    on: false
  };
  const nextItems = [...items, placed];
  assert.equal(nextItems.filter(record => record.uid === placed.uid).length, 1);
  assert.deepEqual(consumed.storage, [{ itemId: 'wall-clock', variant: 0 }]);

  const record = captureLocationRecord({
    seed: 'home',
    terrain: encodeTerrain(world.grid),
    player: { x: world.spawn.x, y: world.spawn.y, direction: 0 },
    npcs: [],
    forage: createShopLocation().forage,
    items: nextItems,
    storage: consumed.storage
  }, null);
  const loaded = loadHomeItems(record, { house, door, roomTiles });
  assert.equal(loaded.some(entry => entry.itemId === 'piano'), true);
  assert.deepEqual(record.storage, [{ itemId: 'wall-clock', variant: 0 }]);
});

test('the three new pieces are data-only additions outside the default layout', () => {
  const layoutIds = new Set(SHOP_ITEMS.layout.map(entry => entry.itemId));
  for (const id of ['piano', 'aquarium', 'wall-clock']) {
    const item = HOME_ITEM_ITEMS[id];
    assert.ok(item, `${id} exists`);
    assert.equal(layoutIds.has(id), false, `${id} is bought, not pre-placed`);
    assert.ok(Number.isInteger(item.price) && item.price > 0, `${id} price`);
    assert.ok(item.size.w >= 1 && item.size.h >= 1, `${id} size`);
    assert.equal(item.solid, true, `${id} footprint is solid`);
    assert.ok(Array.isArray(item.variants) && item.variants.length >= 2, `${id} variants`);
    assert.equal(item.tiers.length, 3, `${id} tiers`);
    assert.equal(item.tiers[0].price, 0, `${id} plain tier is free`);
  }
});
