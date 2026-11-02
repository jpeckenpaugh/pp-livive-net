/**
 * Pure Home furniture logic: item lookup, default layout expansion, rotated
 * footprints, the Home blocked set, placement validation, and the one-time
 * conversion of the old `home.decor` rug/plant records.
 *
 * No DOM here. The renderer draws these shapes; `Game` owns the live blocked
 * set and the step checks. Everything else is testable in Node.
 */
import homeItemsData from '../data/home_items.json' with { type: 'json' };
import { WORLD_SIZE, findPath, isWalkable, typeAt } from './world.js';

export const HOME_ITEM_ITEMS = homeItemsData.items || {};
export const HOME_ITEM_IDS = Object.keys(HOME_ITEM_ITEMS);
export const DEFAULT_HOME_LAYOUT = Array.isArray(homeItemsData.layout) ? homeItemsData.layout : [];
export const BACKPACK_ITEM_IDS = HOME_ITEM_IDS.filter(id => HOME_ITEM_ITEMS[id].backpack === true);
export const HOME_SHOP = homeItemsData.shop || {};
export const SHOP_STOCK_IDS = Array.isArray(HOME_SHOP.stock) ? HOME_SHOP.stock : [];

const ITEM_BY_ID = new Map(HOME_ITEM_IDS.map(id => [id, HOME_ITEM_ITEMS[id]]));

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function tileKey(tile) {
  return `${tile?.x},${tile?.y}`;
}

export function homeItem(id) {
  return ITEM_BY_ID.get(id) || null;
}

export function homeItemLabel(id) {
  return homeItem(id)?.label || id;
}

/** Quarter turns only; negative and huge values wrap safely. */
export function normalizeRotation(rot) {
  const value = Math.round(Number(rot) || 0);
  return ((value % 4) + 4) % 4;
}

export function normalizeVariant(item, variant) {
  const count = Array.isArray(item?.variants) ? item.variants.length : 0;
  if (!count) return 0;
  const value = Math.round(Number(variant) || 0);
  if (value < 0 || value >= count) return 0;
  return value;
}

/** Saved records use index 0 when they predate tiers or carry a bad value. */
export function normalizeTier(item, tier) {
  const count = Array.isArray(item?.tiers) ? item.tiers.length : 0;
  if (!count) return 0;
  const value = Math.round(Number(tier) || 0);
  if (value < 0 || value >= count) return 0;
  return value;
}

/** Rotated size; odd quarter turns swap width and height. */
export function homeItemSize(itemId, rot = 0) {
  const item = homeItem(itemId);
  if (!item) return null;
  const width = Math.max(1, Math.round(Number(item.size?.w) || 1));
  const height = Math.max(1, Math.round(Number(item.size?.h) || 1));
  return normalizeRotation(rot) % 2 === 1
    ? { w: height, h: width }
    : { w: width, h: height };
}

/** Palette for a variant index; variant colours override only the keys they set. */
export function itemColors(itemId, variant = 0) {
  const item = homeItem(itemId);
  if (!item) return { base: '#8a8a8a', accent: '#b0b0b0', trim: '#5a5a5a' };
  const base = isRecord(item.colors) ? item.colors : {};
  const entry = Array.isArray(item.variants)
    ? item.variants[normalizeVariant(item, variant)]
    : null;
  const overrides = isRecord(entry?.colors) ? entry.colors : {};
  return {
    base: overrides.base || base.base || '#8a8a8a',
    accent: overrides.accent || base.accent || '#b0b0b0',
    trim: overrides.trim || base.trim || '#5a5a5a'
  };
}

/**
 * The tier ladder for one item: name, price in coins, and a trim accent.
 * Tier 0 is always free and plain; the renderer only paints accents above it.
 */
export function homeItemTierInfo(itemId, tier = 0) {
  const item = homeItem(itemId);
  const tiers = Array.isArray(item?.tiers) && item.tiers.length
    ? item.tiers
    : [{ name: 'plain', price: 0, accent: null }];
  const index = normalizeTier(item, tier);
  const entry = tiers[index] || tiers[0];
  const nextEntry = tiers[index + 1] || null;
  const current = {
    index,
    name: typeof entry?.name === 'string' && entry.name ? entry.name : 'plain',
    price: Math.max(0, Math.round(Number(entry?.price) || 0)),
    accent: typeof entry?.accent === 'string' && entry.accent ? entry.accent : null,
    max: tiers.length - 1
  };
  return {
    ...current,
    next: nextEntry
      ? {
          index: index + 1,
          name: typeof nextEntry.name === 'string' && nextEntry.name ? nextEntry.name : 'upgraded',
          price: Math.max(0, Math.round(Number(nextEntry.price) || 0)),
          accent: typeof nextEntry.accent === 'string' && nextEntry.accent ? nextEntry.accent : null
        }
      : null
  };
}

/** Trim colour above tier 0, or null so the plain palette is untouched. */
export function itemTierAccent(itemId, tier = 0) {
  const info = homeItemTierInfo(itemId, tier);
  return info.index > 0 ? info.accent : null;
}

/**
 * One-click upgrade: validate the next tier and the wallet, then return the new
 * list and balance. `reason` is `max-tier`, `insufficient`, or `unknown-item`.
 */
export function upgradeHomeItem(items = [], uid, coins = 0) {
  const list = Array.isArray(items) ? items : [];
  const balance = Math.max(0, Math.round(Number(coins) || 0));
  const record = list.find(entry => entry?.uid === uid) || null;
  if (!record) {
    return { ok: false, reason: 'unknown-item', items: list, record: null, cost: 0, short: 0, coins: balance, tier: null };
  }
  const info = homeItemTierInfo(record.itemId, record.tier);
  if (!info.next) {
    return { ok: false, reason: 'max-tier', items: list, record, cost: 0, short: 0, coins: balance, tier: info };
  }
  if (balance < info.next.price) {
    return {
      ok: false,
      reason: 'insufficient',
      items: list,
      record,
      cost: info.next.price,
      short: info.next.price - balance,
      coins: balance,
      tier: info
    };
  }
  const nextItems = list.map(entry => (
    entry?.uid === uid ? { ...entry, tier: info.next.index } : entry
  ));
  return {
    ok: true,
    reason: null,
    items: nextItems,
    record: nextItems.find(entry => entry?.uid === uid) || null,
    cost: info.next.price,
    short: 0,
    coins: balance - info.next.price,
    tier: info.next
  };
}

/**
 * The shop's stock, resolved against the catalog. Only items that exist and
 * carry a positive price are offered, so a bad data row cannot sell nothing.
 */
export function shopStock() {
  return SHOP_STOCK_IDS
    .map(itemId => {
      const item = homeItem(itemId);
      const price = Math.max(0, Math.round(Number(item?.price) || 0));
      if (!item || price <= 0) return null;
      return {
        itemId,
        label: item.label || itemId,
        icon: item.icon || '•',
        price,
        line: item.use?.line || ''
      };
    })
    .filter(Boolean);
}

/** One-click purchase. Nothing mutates; the caller commits coins and storage. */
export function buyShopItem(itemId, { coins = 0, storage = [] } = {}) {
  const entry = shopStock().find(candidate => candidate.itemId === itemId) || null;
  const balance = Math.max(0, Math.round(Number(coins) || 0));
  const list = normalizeHomeStorage(storage);
  if (!entry) {
    return { ok: false, reason: 'unknown-item', coins: balance, storage: list, cost: 0, short: 0, entry: null };
  }
  if (balance < entry.price) {
    return {
      ok: false,
      reason: 'insufficient',
      coins: balance,
      storage: list,
      cost: entry.price,
      short: entry.price - balance,
      entry
    };
  }
  return {
    ok: true,
    reason: null,
    coins: balance - entry.price,
    storage: [...list, { itemId: entry.itemId, variant: 0 }],
    cost: entry.price,
    short: 0,
    entry
  };
}

/** Owned-but-unplaced furniture: known item ids with a valid palette index. */
export function normalizeHomeStorage(entries) {
  if (!Array.isArray(entries)) return [];
  const records = [];
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const item = homeItem(entry.itemId);
    if (!item) continue;
    records.push({ itemId: item.id, variant: normalizeVariant(item, entry.variant) });
  }
  return records;
}

/** Remove one stored piece so placing it cannot leave a duplicate behind. */
export function consumeHomeStorage(storage = [], index) {
  const list = normalizeHomeStorage(storage);
  const at = Number(index);
  if (!Number.isInteger(at) || at < 0 || at >= list.length) {
    return { ok: false, storage: list, entry: null };
  }
  return {
    ok: true,
    entry: list[at],
    storage: list.filter((entry, position) => position !== at)
  };
}

/** A uid that no placed record or pending draft already uses. */
export function nextHomeUid(items = [], itemId) {
  const used = new Set((Array.isArray(items) ? items : []).map(entry => entry?.uid).filter(Boolean));
  let index = 1;
  while (used.has(`home_${itemId}_${index}`)) index += 1;
  return `home_${itemId}_${index}`;
}

/**
 * First room tile where a stored piece fits, reading top-left to bottom-right.
 * Used when Furnish opens a piece that has no position yet.
 */
export function findHomePlacementTile({
  items = [],
  itemId,
  roomTiles = [],
  house = null,
  door = null,
  terrain = null,
  player = null,
  allowPlayer = false
} = {}) {
  const tiles = (Array.isArray(roomTiles) ? roomTiles : [])
    .slice()
    .sort((a, b) => (a.y - b.y) || (a.x - b.x));
  for (const tile of tiles) {
    const placement = canPlaceHomeItem({
      items,
      itemId,
      x: tile.x,
      y: tile.y,
      roomTiles,
      house,
      door,
      terrain,
      player,
      allowPlayer
    });
    if (placement.ok) return { x: tile.x, y: tile.y };
  }
  return null;
}

export function footprintTiles({ itemId, x, y, rot = 0 } = {}) {
  const size = homeItemSize(itemId, rot);
  const originX = Math.round(Number(x));
  const originY = Math.round(Number(y));
  if (!size || !Number.isFinite(originX) || !Number.isFinite(originY)) return [];
  const tiles = [];
  for (let dy = 0; dy < size.h; dy += 1) {
    for (let dx = 0; dx < size.w; dx += 1) {
      tiles.push({ x: originX + dx, y: originY + dy });
    }
  }
  return tiles;
}

export function itemTiles(record) {
  return footprintTiles({
    itemId: record?.itemId,
    x: record?.x,
    y: record?.y,
    rot: record?.rot
  });
}

/** Solid footprints only; the rug is ground cover and never blocks a step. */
export function blockedTiles(items = []) {
  const blocked = new Set();
  for (const record of Array.isArray(items) ? items : []) {
    const item = homeItem(record?.itemId);
    if (!item?.solid) continue;
    for (const tile of itemTiles(record)) blocked.add(tileKey(tile));
  }
  return blocked;
}

/** Ground-cover footprints (the rug) that Home buddies stand beside, never on. */
export function rugTiles(items = []) {
  const tiles = [];
  for (const record of Array.isArray(items) ? items : []) {
    const item = homeItem(record?.itemId);
    if (!item?.ground) continue;
    tiles.push(...itemTiles(record));
  }
  return tiles;
}

export function homeItemAt(items, x, y) {
  for (const record of Array.isArray(items) ? items : []) {
    if (itemTiles(record).some(tile => tile.x === x && tile.y === y)) return record;
  }
  return null;
}

/** A safe in-room tile used when a caller does not name a path target. */
export function houseCenterTile(house) {
  const origin = houseOrigin(house);
  if (!origin) return null;
  return {
    x: origin.x + Math.floor(origin.width / 2),
    y: origin.y + Math.floor(origin.height / 2)
  };
}

function houseOrigin(house) {
  if (!isRecord(house)) return null;
  const x = Math.floor(Number(house.x));
  const y = Math.floor(Number(house.y));
  const width = Math.floor(Number(house.width));
  const height = Math.floor(Number(house.height));
  if (![x, y, width, height].every(Number.isFinite)) return null;
  if (width < 3 || height < 3) return null;
  return { x, y, width, height };
}

/** Interior tiles of a house, without needing terrain. */
export function houseInteriorTiles(house) {
  const origin = houseOrigin(house);
  if (!origin) return [];
  const tiles = [];
  for (let y = origin.y + 1; y <= origin.y + origin.height - 2; y += 1) {
    for (let x = origin.x + 1; x <= origin.x + origin.width - 2; x += 1) {
      tiles.push({ x, y });
    }
  }
  return tiles;
}

/**
 * The doorway approach: the door tile plus `depth` interior tiles straight in
 * from the wall. Furniture may not block it, and buddies may not gather on it.
 */
export function doorLaneTiles({ house, door, depth = 3 } = {}) {
  const origin = houseOrigin(house);
  const lane = new Set();
  if (!origin || !isRecord(door)) return lane;
  const doorX = Math.round(Number(door.x));
  const doorY = Math.round(Number(door.y));
  if (!Number.isFinite(doorX) || !Number.isFinite(doorY)) return lane;
  lane.add(`${doorX},${doorY}`);

  const centerX = origin.x + Math.floor(origin.width / 2);
  const centerY = origin.y + Math.floor(origin.height / 2);
  const dx = centerX - doorX;
  const dy = centerY - doorY;
  const step = Math.abs(dx) >= Math.abs(dy)
    ? { x: Math.sign(dx), y: 0 }
    : { x: 0, y: Math.sign(dy) };
  if (step.x === 0 && step.y === 0) return lane;

  for (let index = 1; index <= Math.max(1, depth); index += 1) {
    lane.add(`${doorX + step.x * index},${doorY + step.y * index}`);
  }
  return lane;
}

function recordUid(itemId, used) {
  let index = 1;
  let uid = `home_${itemId}_${index}`;
  while (used.has(uid)) {
    index += 1;
    uid = `home_${itemId}_${index}`;
  }
  return uid;
}

/**
 * Turn the data-file layout into save-shaped records. Offsets are footprint
 * top-lefts relative to the house origin, so the room moves with the house.
 */
export function expandDefaultLayout(house, layout = DEFAULT_HOME_LAYOUT) {
  const origin = houseOrigin(house);
  if (!origin) return [];
  const used = new Set();
  const records = [];

  for (const entry of Array.isArray(layout) ? layout : []) {
    const item = homeItem(entry?.itemId);
    if (!item) continue;
    const uid = recordUid(item.id, used);
    used.add(uid);
    records.push({
      uid,
      itemId: item.id,
      x: origin.x + Math.round(Number(entry.dx) || 0),
      y: origin.y + Math.round(Number(entry.dy) || 0),
      rot: normalizeRotation(entry.rot),
      variant: normalizeVariant(item, entry.variant),
      tier: 0,
      on: false
    });
  }
  return records;
}

/**
 * Validate saved records without trusting them: known items, finite tiles,
 * quarter-turn rotation, in-range variant, unique ids, and optionally a room
 * that must fully contain the footprint.
 */
export function normalizeHomeItems(entries, { roomTiles = null } = {}) {
  if (!Array.isArray(entries)) return [];
  const room = Array.isArray(roomTiles) && roomTiles.length
    ? new Set(roomTiles.map(tileKey))
    : null;
  const used = new Set();
  const records = [];

  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const item = homeItem(entry.itemId);
    if (!item) continue;
    const x = Math.round(Number(entry.x));
    const y = Math.round(Number(entry.y));
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const rot = normalizeRotation(entry.rot);
    const tiles = footprintTiles({ itemId: item.id, x, y, rot });
    if (!tiles.length) continue;
    if (room && !tiles.every(tile => room.has(tileKey(tile)))) continue;
    if (tiles.some(tile => tile.x < 0 || tile.x >= WORLD_SIZE || tile.y < 0 || tile.y >= WORLD_SIZE)) continue;

    const requested = typeof entry.uid === 'string' && entry.uid ? entry.uid : '';
    const uid = requested && !used.has(requested) ? requested : recordUid(item.id, used);
    used.add(uid);
    records.push({
      uid,
      itemId: item.id,
      x,
      y,
      rot,
      variant: normalizeVariant(item, entry.variant),
      tier: normalizeTier(item, entry.tier),
      on: entry.on === true
    });
  }
  return records;
}

/**
 * One-time conversion of the pre-furniture `home.decor` rug/plant records.
 * The default layout is used for everything else; a saved decor position wins
 * when it still fits, otherwise that item stays at its default spot.
 */
export function migrateDecorItems(decor = [], { house, door, roomTiles = null } = {}) {
  const defaults = expandDefaultLayout(house);
  const room = Array.isArray(roomTiles) && roomTiles.length
    ? roomTiles
    : houseInteriorTiles(house);
  const lane = doorLaneTiles({ house, door });
  const saved = Array.isArray(decor) ? decor : [];

  const migrated = [];
  const claimed = new Set();
  for (const entry of saved) {
    if (!isRecord(entry)) continue;
    const item = homeItem(entry.id);
    if (!item?.backpack || claimed.has(item.id)) continue;
    const x = Math.round(Number(entry.x));
    const y = Math.round(Number(entry.y));
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    claimed.add(item.id);
    migrated.push({
      uid: `home_${item.id}_1`,
      itemId: item.id,
      x,
      y,
      rot: 0,
      variant: 0,
      tier: 0,
      on: false
    });
  }
  if (!migrated.length) return defaults;

  const records = defaults.filter(record => !claimed.has(record.itemId));
  const fits = record => canPlaceHomeItem({
    items: records,
    itemId: record.itemId,
    x: record.x,
    y: record.y,
    rot: record.rot,
    roomTiles: room,
    doorLane: lane,
    requirePath: false
  }).ok;

  for (const record of migrated) {
    if (fits(record)) {
      records.push(record);
      continue;
    }
    const fallback = defaults.find(candidate => candidate.itemId === record.itemId);
    if (fallback && fits(fallback)) records.push(fallback);
  }
  return records;
}

/**
 * Resolve the Home item list for a location record. Saved `items` are
 * authoritative (even when empty); a missing list falls back to a one-time
 * `decor` conversion, then to the default furnished layout.
 */
export function loadHomeItems(record, { house, door, roomTiles = null } = {}) {
  if (isRecord(record) && Array.isArray(record.items)) {
    return normalizeHomeItems(record.items, { roomTiles });
  }
  const decor = isRecord(record) && Array.isArray(record.decor) ? record.decor : [];
  if (decor.length) return migrateDecorItems(decor, { house, door, roomTiles });
  return expandDefaultLayout(house);
}

/**
 * Placement primitive shared with Wave 7b: bounds, door lane, overlap, the
 * player's tile, and optionally a flood-fill that keeps the door reachable.
 * Returns `{ ok, reason }` so the caller can explain a refusal.
 */
export function canPlaceHomeItem({
  items = [],
  itemId,
  x,
  y,
  rot = 0,
  roomTiles = [],
  house = null,
  door = null,
  doorLane = null,
  terrain = null,
  uid = null,
  player = null,
  allowPlayer = false,
  requirePath = true,
  target = null
} = {}) {
  const item = homeItem(itemId);
  if (!item) return { ok: false, reason: 'unknown-item' };
  const tiles = footprintTiles({ itemId, x, y, rot });
  if (!tiles.length) return { ok: false, reason: 'outside-room' };

  const room = Array.isArray(roomTiles) && roomTiles.length
    ? new Set(roomTiles.map(tileKey))
    : null;
  if (room && !tiles.every(tile => room.has(tileKey(tile)))) {
    return { ok: false, reason: 'outside-room' };
  }
  if (tiles.some(tile => tile.x < 0 || tile.x >= WORLD_SIZE || tile.y < 0 || tile.y >= WORLD_SIZE)) {
    return { ok: false, reason: 'outside-room' };
  }

  const lane = doorLane instanceof Set
    ? doorLane
    : doorLaneTiles({ house, door });
  if (tiles.some(tile => lane.has(tileKey(tile)))) {
    return { ok: false, reason: 'door-lane' };
  }

  const others = (Array.isArray(items) ? items : []).filter(record => !uid || record?.uid !== uid);
  const solidTaken = blockedTiles(others);
  const groundTaken = new Set();
  for (const record of others) {
    if (!homeItem(record?.itemId)?.ground) continue;
    for (const tile of itemTiles(record)) groundTaken.add(tileKey(tile));
  }
  // Solid pieces cannot overlap each other; ground cover (the rug) may sit under
  // furniture and furniture may sit on it. Two ground pieces may not stack.
  const taken = item.solid ? solidTaken : groundTaken;
  if (tiles.some(tile => taken.has(tileKey(tile)))) {
    return { ok: false, reason: 'occupied' };
  }

  if (player && !allowPlayer && tiles.some(tile => tile.x === player.x && tile.y === player.y)) {
    return { ok: false, reason: 'player' };
  }

  if (requirePath && terrain && house && door) {
    const blocked = blockedTiles(others);
    if (item.solid) {
      for (const tile of tiles) blocked.add(tileKey(tile));
    }
    const from = { x: Math.round(Number(door.x)), y: Math.round(Number(door.y)) };
    const to = target
      ? { x: Math.round(Number(target.x)), y: Math.round(Number(target.y)) }
      : houseCenterTile(house);
    if (!to) return { ok: true, reason: null };
    if (!findPath(terrain, from, to, blocked).length) {
      return { ok: false, reason: 'no-path' };
    }
  }

  return { ok: true, reason: null };
}

/** True when the door still reaches `target` with the current furniture. */
export function hasDoorPath({
  terrain,
  items = [],
  house,
  door,
  target = null
} = {}) {
  if (!terrain || !isRecord(house) || !isRecord(door)) return true;
  const from = { x: Math.round(Number(door.x)), y: Math.round(Number(door.y)) };
  const to = target
    ? { x: Math.round(Number(target.x)), y: Math.round(Number(target.y)) }
    : houseCenterTile(house);
  if (!to) return true;
  if (from.x === to.x && from.y === to.y) return true;
  if (!isWalkable(typeAt(terrain, from.x, from.y))) return false;
  return findPath(terrain, from, to, blockedTiles(items)).length > 0;
}

/**
 * Hit-testing order matches the renderer: ground cover draws below every actor,
 * then furniture sorts by its footprint's bottom row with a left-edge tie-break.
 * Ties keep the later record, because the renderer draws later records on top.
 */
function drawOrderKey(record) {
  const size = homeItemSize(record?.itemId, record?.rot);
  if (!size) return null;
  return {
    ground: Boolean(homeItem(record.itemId)?.ground),
    bottom: Math.round(Number(record.y) || 0) + size.h - 1,
    left: Math.round(Number(record.x) || 0)
  };
}

function compareDrawOrder(a, b) {
  if (a.ground !== b.ground) return a.ground ? -1 : 1;
  if (a.bottom !== b.bottom) return a.bottom - b.bottom;
  return a.left - b.left;
}

/** The record a click on this tile should act on, topmost in draw order. */
export function homeItemAtTop(items, x, y) {
  const tx = Math.round(Number(x));
  const ty = Math.round(Number(y));
  if (!Number.isFinite(tx) || !Number.isFinite(ty)) return null;
  let best = null;
  let bestKey = null;
  for (const record of Array.isArray(items) ? items : []) {
    if (!itemTiles(record).some(tile => tile.x === tx && tile.y === ty)) continue;
    const key = drawOrderKey(record);
    if (!key) continue;
    if (!best || compareDrawOrder(bestKey, key) <= 0) {
      best = record;
      bestKey = key;
    }
  }
  return best;
}

export const HOME_USE_KINDS = ['sit', 'sleep', 'toggle', 'recipe', 'look'];

/**
 * Resolve the card's primary action. `use` is authoritative; older records that
 * only carry `interact` still map to a verb and kind instead of going silent.
 */
export function homeItemUse(itemId) {
  const item = homeItem(itemId);
  if (!item) return null;
  const use = isRecord(item.use) ? item.use : {};
  const interact = isRecord(item.interact) ? item.interact : {};
  const kind = HOME_USE_KINDS.includes(use.kind)
    ? use.kind
    : (HOME_USE_KINDS.includes(interact.kind) ? interact.kind : 'look');
  const fallbackVerb = kind === 'sit'
    ? 'Sit'
    : kind === 'sleep'
      ? 'Sleep'
      : kind === 'toggle'
        ? 'Use'
        : 'Look';
  return {
    kind,
    verb: typeof use.verb === 'string' && use.verb ? use.verb : fallbackVerb,
    line: typeof use.line === 'string' ? use.line : (typeof interact.line === 'string' ? interact.line : ''),
    onLine: typeof use.onLine === 'string' ? use.onLine : (typeof interact.onLine === 'string' ? interact.onLine : ''),
    offLine: typeof use.offLine === 'string' ? use.offLine : (typeof interact.offLine === 'string' ? interact.offLine : ''),
    cue: typeof use.cue === 'string' ? use.cue : '',
    recipe: isRecord(use.recipe) ? use.recipe : (isRecord(interact.recipe) ? interact.recipe : null)
  };
}

/** Recipe requirement check against a basket of `{ apple, mushroom }` counts. */
export function recipeStatus(recipe, basket = {}) {
  const inputs = isRecord(recipe?.inputs) ? recipe.inputs : {};
  const missing = [];
  for (const [id, rawNeed] of Object.entries(inputs)) {
    const need = Math.max(0, Math.round(Number(rawNeed) || 0));
    if (!need) continue;
    const have = Math.max(0, Math.round(Number(basket?.[id]) || 0));
    if (have < need) missing.push({ id, need, have, short: need - have });
  }
  return {
    ok: missing.length === 0,
    missing,
    output: typeof recipe?.output === 'string' && recipe.output ? recipe.output : null,
    inputs
  };
}

/** Consume a recipe from a basket; returns a new basket and leaves the old one alone. */
export function consumeRecipe(basket = {}, recipe = null) {
  const status = recipeStatus(recipe, basket);
  if (!status.ok || !status.output) return { ...status, ok: false, basket };
  const nextBasket = { ...(isRecord(basket) ? basket : {}) };
  for (const [id, rawNeed] of Object.entries(status.inputs)) {
    const need = Math.max(0, Math.round(Number(rawNeed) || 0));
    if (!need) continue;
    nextBasket[id] = Math.max(0, Math.round(Number(nextBasket[id]) || 0) - need);
  }
  return { ...status, ok: true, basket: nextBasket };
}

/** Flip one record's persisted switch; returns a new list plus the new state. */
export function toggleHomeItem(items, uid) {
  const list = Array.isArray(items) ? items : [];
  let on = false;
  let found = null;
  const next = list.map(record => {
    if (record?.uid !== uid) return record;
    found = record;
    on = record.on !== true;
    return { ...record, on };
  });
  return { items: found ? next : list, on: found ? on : false, record: found };
}

export function setHomeItemOn(items, uid, on) {
  const list = Array.isArray(items) ? items : [];
  let found = null;
  const next = list.map(record => {
    if (record?.uid !== uid) return record;
    found = record;
    return { ...record, on: Boolean(on) };
  });
  return { items: found ? next : list, on: found ? Boolean(on) : false, record: found };
}

/** The posture a use implies, or null for a non-posture action. */
export function homePoseForUse(itemId) {
  const use = homeItemUse(itemId);
  return use?.kind === 'sit' || use?.kind === 'sleep' ? use.kind : null;
}

/**
 * Where the pose renders: the middle of the footprint, or its front seat row.
 * The player's logical tile never changes, so collision stays untouched.
 */
export function homePoseAnchor(items, pose) {
  const kind = pose?.kind;
  if (kind !== 'sit' && kind !== 'sleep') return null;
  const record = (Array.isArray(items) ? items : []).find(entry => entry?.uid === pose.uid);
  const size = record ? homeItemSize(record.itemId, record.rot) : null;
  if (!record || !size) return null;
  const bottom = Math.round(Number(record.y) || 0) + size.h - 1;
  return {
    x: Math.round(Number(record.x) || 0) + (size.w - 1) / 2,
    y: kind === 'sleep'
      ? Math.round(Number(record.y) || 0) + Math.floor(size.h / 2)
      : bottom,
    // Depth key: the resting sprite draws just above the piece it rests on.
    sortY: bottom + 0.55,
    kind,
    record
  };
}

/**
 * Action priority in Home, in the order the player expects it: an open
 * conversation, an open player menu, the item being faced, the door, then the
 * player menu itself.
 */
export function homeActionPriority({ dialogueOpen = false, menuOpen = false, facingItem = null, door = null } = {}) {
  if (dialogueOpen) return 'dialogue';
  if (menuOpen) return 'menu';
  if (facingItem) return 'item';
  if (door) return 'door';
  return 'menu-open';
}

/** Player-facing copy for a placement refusal. */
export function homeItemReasonText(reason) {
  switch (reason) {
    case 'outside-room': return 'that needs to stay inside the room.';
    case 'door-lane': return 'keep the doorway clear.';
    case 'occupied': return 'something else is already there.';
    case 'player': return 'step off that tile first.';
    case 'no-path': return 'the door needs a clear path.';
    case 'unknown-item': return 'that piece is missing from the catalog.';
    default: return 'that spot will not work.';
  }
}

/** Move an existing record; returns a new list, or the original on a bad uid. */
export function moveHomeItem(items, uid, x, y) {
  const list = Array.isArray(items) ? items : [];
  const tx = Math.round(Number(x));
  const ty = Math.round(Number(y));
  if (!uid || !Number.isFinite(tx) || !Number.isFinite(ty)) return list;
  let found = false;
  const next = list.map(record => {
    if (record?.uid !== uid) return record;
    found = true;
    return { ...record, x: tx, y: ty };
  });
  return found ? next : list;
}
