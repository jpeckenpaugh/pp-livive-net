/**
 * Forage: ground apples and harvestable mushrooms.
 *
 * Pure, DOM-free helpers. The app owns the render list and save round-trip;
 * this module only tracks what is on the ground, what has been picked, and
 * when it comes back.
 */
import forageConfig from '../data/forage.json' with { type: 'json' };
import { WORLD_SIZE, isWalkable, typeAt } from './world.js';

export const FORAGE_CONFIG = forageConfig;
export const FORAGE_ITEMS = forageConfig.items;
export const FORAGE_APPLE_TYPES = forageConfig.apples.tiles;
export const FORAGE_MUSHROOM_TYPES = forageConfig.mushrooms.sceneryTypes;

const APPLE_RESPAWN_MS = Math.max(1000, Number(forageConfig.apples.respawnMs) || 20000);
const MUSHROOM_RESPAWN_MS = Math.max(1000, Number(forageConfig.mushrooms.respawnMs) || 75000);
const APPLE_INITIAL = Math.max(0, Math.floor(Number(forageConfig.apples.initial) || 0));
const APPLE_MAX = Math.max(APPLE_INITIAL, Math.floor(Number(forageConfig.apples.max) || APPLE_INITIAL));
const MAX_ATTEMPTS = 500;

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toTile(value) {
  const number = Math.round(Number(value));
  return Number.isFinite(number) && number >= 0 && number < WORLD_SIZE ? number : null;
}

function toCount(value) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number > 0 ? number : 0;
}

export function appleKey(x, y) {
  return `apple:${x},${y}`;
}

export function isMushroomScenery(item) {
  return Boolean(item) && FORAGE_MUSHROOM_TYPES.includes(item.type);
}

function normalizeBasket(source) {
  const basket = isObject(source) ? source : {};
  return {
    apple: toCount(basket.apple),
    mushroom: toCount(basket.mushroom)
  };
}

function normalizeApples(source) {
  if (!Array.isArray(source)) return [];
  const apples = [];
  const seen = new Set();
  for (const entry of source) {
    if (!isObject(entry)) continue;
    const x = toTile(entry.x);
    const y = toTile(entry.y);
    if (x === null || y === null) continue;
    const id = typeof entry.id === 'string' && entry.id ? entry.id : appleKey(x, y);
    if (seen.has(id)) continue;
    seen.add(id);
    apples.push({ id, x, y });
  }
  return apples;
}

function normalizeHarvested(source) {
  if (!isObject(source)) return {};
  const harvested = {};
  for (const [id, until] of Object.entries(source)) {
    if (!id) continue;
    const value = Number(until);
    if (Number.isFinite(value) && value > 0) harvested[id] = value;
  }
  return harvested;
}

/**
 * Coerce a saved (or partial) forage block into the current shape. Unknown
 * fields are dropped so saves stay small and forward-compatible.
 */
export function normalizeForage(source) {
  const block = isObject(source) ? source : {};
  const apples = normalizeApples(block.apples);
  return {
    apples,
    basket: normalizeBasket(block.basket),
    harvested: normalizeHarvested(block.harvested),
    nextAppleAt: Number.isFinite(Number(block.nextAppleAt)) ? Number(block.nextAppleAt) : 0,
    seeded: block.seeded === true || apples.length > 0
  };
}

export function createForageState(source = null) {
  return normalizeForage(source);
}

/** Deterministic-ish spawn: random attempts over walkable grass/field tiles. */
export function findAppleTile(grid, { random = Math.random, occupied = new Set() } = {}) {
  if (!Array.isArray(grid) || !grid.length) return null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const x = Math.floor(random() * WORLD_SIZE);
    const y = Math.floor(random() * WORLD_SIZE);
    const key = `${x},${y}`;
    if (occupied.has(key)) continue;
    const type = typeAt(grid, x, y);
    if (!FORAGE_APPLE_TYPES.includes(type) || !isWalkable(type)) continue;
    return { x, y };
  }
  return null;
}

function appleTiles(state, occupied) {
  for (const apple of state.apples) occupied.add(`${apple.x},${apple.y}`);
  return occupied;
}

/** Scatter the initial apple crop. Existing apples are kept. */
export function seedApples(state, { grid, count = APPLE_INITIAL, random = Math.random, occupied = new Set(), nowMs = Date.now() } = {}) {
  const field = isObject(state) ? state : createForageState();
  const taken = appleTiles(field, new Set(occupied));
  const target = Math.min(APPLE_MAX, Math.max(0, Math.floor(count)));
  let added = 0;
  while (field.apples.length < target) {
    const tile = findAppleTile(grid, { random, occupied: taken });
    if (!tile) break;
    field.apples.push({ id: appleKey(tile.x, tile.y), x: tile.x, y: tile.y });
    taken.add(`${tile.x},${tile.y}`);
    added += 1;
  }
  field.seeded = true;
  if (!Number.isFinite(field.nextAppleAt) || field.nextAppleAt <= 0) {
    field.nextAppleAt = nowMs + APPLE_RESPAWN_MS;
  }
  return added;
}

/**
 * Advance respawn clocks. Returns how many apples sprouted and how many
 * mushrooms returned. Safe to call every frame.
 */
export function growForage(state, { grid, nowMs = Date.now(), random = Math.random, occupied = new Set() } = {}) {
  const field = isObject(state) ? state : null;
  if (!field) return { applesAdded: 0, mushroomsReturned: 0 };

  let mushroomsReturned = 0;
  for (const [id, until] of Object.entries(field.harvested)) {
    if (Number(until) <= nowMs) {
      delete field.harvested[id];
      mushroomsReturned += 1;
    }
  }

  let applesAdded = 0;
  if (!Number.isFinite(field.nextAppleAt) || field.nextAppleAt <= 0) {
    field.nextAppleAt = nowMs + APPLE_RESPAWN_MS;
  }
  const taken = appleTiles(field, new Set(occupied));
  let guard = 0;
  while (nowMs >= field.nextAppleAt && guard < 64) {
    guard += 1;
    if (field.apples.length < APPLE_MAX) {
      const tile = findAppleTile(grid, { random, occupied: taken });
      if (tile) {
        field.apples.push({ id: appleKey(tile.x, tile.y), x: tile.x, y: tile.y });
        taken.add(`${tile.x},${tile.y}`);
        applesAdded += 1;
      }
    }
    field.nextAppleAt += APPLE_RESPAWN_MS;
  }
  if (field.nextAppleAt <= nowMs) field.nextAppleAt = nowMs + APPLE_RESPAWN_MS;

  return { applesAdded, mushroomsReturned };
}

export function appleAt(state, x, y) {
  if (!isObject(state) || !Array.isArray(state.apples)) return null;
  return state.apples.find(apple => apple.x === x && apple.y === y) || null;
}

export function mushroomAt(scenery, x, y) {
  if (!Array.isArray(scenery)) return null;
  return scenery.find(item => item && item.x === x && item.y === y && isMushroomScenery(item)) || null;
}

export function isMushroomHidden(state, id, nowMs = Date.now()) {
  if (!isObject(state) || !isObject(state.harvested) || typeof id !== 'string') return false;
  const until = Number(state.harvested[id]);
  return Number.isFinite(until) && until > nowMs;
}

/** Pick up whatever is under a tile. Mutates state; returns a pickup record. */
export function collectForageAt(state, {
  x,
  y,
  scenery = [],
  nowMs = Date.now()
} = {}) {
  if (!isObject(state)) return null;

  const apple = appleAt(state, x, y);
  if (apple) {
    state.apples = state.apples.filter(candidate => candidate !== apple);
    state.basket = normalizeBasket(state.basket);
    state.basket.apple += 1;
    return { kind: 'apple', item: FORAGE_ITEMS.apple, amount: 1, apple };
  }

  const mushroom = mushroomAt(scenery, x, y);
  if (mushroom && !isMushroomHidden(state, mushroom.id, nowMs)) {
    state.harvested = isObject(state.harvested) ? state.harvested : {};
    state.harvested[mushroom.id] = nowMs + MUSHROOM_RESPAWN_MS;
    state.basket = normalizeBasket(state.basket);
    state.basket.mushroom += 1;
    return { kind: 'mushroom', item: FORAGE_ITEMS.mushroom, amount: 1, scenery: mushroom };
  }

  return null;
}

/** Basket counts plus a short label for the bag panel. */
export function basketSummary(state) {
  const basket = normalizeBasket(state?.basket);
  return {
    apple: basket.apple,
    mushroom: basket.mushroom,
    total: basket.apple + basket.mushroom,
    label: `🍎 ${basket.apple} · 🍄 ${basket.mushroom}`,
    respawnMs: {
      apple: APPLE_RESPAWN_MS,
      mushroom: MUSHROOM_RESPAWN_MS
    }
  };
}
