/**
 * Forage: ground apples, harvestable mushrooms, and beach shells.
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
export const FORAGE_SHELL_TYPES = forageConfig.shells?.tiles || ['sand'];

const APPLE_RESPAWN_MS = Math.max(1000, Number(forageConfig.apples.respawnMs) || 20000);
const MUSHROOM_RESPAWN_MS = Math.max(1000, Number(forageConfig.mushrooms.respawnMs) || 75000);
const APPLE_INITIAL = Math.max(0, Math.floor(Number(forageConfig.apples.initial) || 0));
const APPLE_MAX = Math.max(APPLE_INITIAL, Math.floor(Number(forageConfig.apples.max) || APPLE_INITIAL));
const SHELL_RESPAWN_MS = Math.max(1000, Number(forageConfig.shells?.respawnMs) || 45000);
const SHELL_INITIAL = Math.max(0, Math.floor(Number(forageConfig.shells?.initial) || 0));
const SHELL_MAX = Math.max(SHELL_INITIAL, Math.floor(Number(forageConfig.shells?.max) || SHELL_INITIAL));
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

export function shellKey(x, y) {
  return `shell:${x},${y}`;
}

export function isMushroomScenery(item) {
  return Boolean(item) && FORAGE_MUSHROOM_TYPES.includes(item.type);
}

function normalizeBasket(source) {
  const basket = isObject(source) ? source : {};
  return {
    apple: toCount(basket.apple),
    mushroom: toCount(basket.mushroom),
    shell: toCount(basket.shell)
  };
}

function normalizeGround(source, keyFor) {
  if (!Array.isArray(source)) return [];
  const items = [];
  const seen = new Set();
  for (const entry of source) {
    if (!isObject(entry)) continue;
    const x = toTile(entry.x);
    const y = toTile(entry.y);
    if (x === null || y === null) continue;
    const id = typeof entry.id === 'string' && entry.id ? entry.id : keyFor(x, y);
    if (seen.has(id)) continue;
    seen.add(id);
    items.push({ id, x, y });
  }
  return items;
}

function normalizeApples(source) {
  return normalizeGround(source, appleKey);
}

function normalizeShells(source) {
  return normalizeGround(source, shellKey);
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
    shells: normalizeShells(block.shells),
    basket: normalizeBasket(block.basket),
    harvested: normalizeHarvested(block.harvested),
    nextAppleAt: Number.isFinite(Number(block.nextAppleAt)) ? Number(block.nextAppleAt) : 0,
    nextShellAt: Number.isFinite(Number(block.nextShellAt)) ? Number(block.nextShellAt) : 0,
    seeded: block.seeded === true || apples.length > 0
  };
}

export function createForageState(source = null) {
  return normalizeForage(source);
}

/** Deterministic-ish spawn: random attempts over walkable tiles of the given types. */
export function findForageTile(grid, {
  tiles = FORAGE_APPLE_TYPES,
  random = Math.random,
  occupied = new Set()
} = {}) {
  if (!Array.isArray(grid) || !grid.length) return null;
  const allowed = Array.isArray(tiles) && tiles.length ? tiles : FORAGE_APPLE_TYPES;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const x = Math.floor(random() * WORLD_SIZE);
    const y = Math.floor(random() * WORLD_SIZE);
    const key = `${x},${y}`;
    if (occupied.has(key)) continue;
    const type = typeAt(grid, x, y);
    if (!allowed.includes(type) || !isWalkable(type)) continue;
    return { x, y };
  }
  return null;
}

/** Apples prefer open grass and meadow tiles. */
export function findAppleTile(grid, options = {}) {
  return findForageTile(grid, { ...options, tiles: FORAGE_APPLE_TYPES });
}

/** Shells only wash up on sand. */
export function findShellTile(grid, options = {}) {
  return findForageTile(grid, { ...options, tiles: FORAGE_SHELL_TYPES });
}

function groundTiles(items, occupied) {
  for (const item of items) occupied.add(`${item.x},${item.y}`);
  return occupied;
}

/** Scatter the initial apple crop. Existing apples are kept. */
export function seedApples(state, { grid, count = APPLE_INITIAL, random = Math.random, occupied = new Set(), nowMs = Date.now() } = {}) {
  const field = isObject(state) ? state : createForageState();
  const taken = groundTiles(field.apples, new Set(occupied));
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

/** Scatter the initial shell crop on sand. Existing shells are kept. */
export function seedShells(state, { grid, count = SHELL_INITIAL, random = Math.random, occupied = new Set(), nowMs = Date.now() } = {}) {
  const field = isObject(state) ? state : createForageState();
  field.shells = Array.isArray(field.shells) ? field.shells : [];
  const taken = groundTiles(field.shells, new Set(occupied));
  const target = Math.min(SHELL_MAX, Math.max(0, Math.floor(count)));
  let added = 0;
  while (field.shells.length < target) {
    const tile = findShellTile(grid, { random, occupied: taken });
    if (!tile) break;
    field.shells.push({ id: shellKey(tile.x, tile.y), x: tile.x, y: tile.y });
    taken.add(`${tile.x},${tile.y}`);
    added += 1;
  }
  // A shell clock only runs in locations that actually seed shells.
  if (!Number.isFinite(field.nextShellAt) || field.nextShellAt <= 0) {
    field.nextShellAt = nowMs + SHELL_RESPAWN_MS;
  }
  return added;
}

/**
 * Seed every pickup a location supports in one call. Apples grow anywhere
 * open; shells are opt-in per location (`shells: true` in `data/world.json`).
 */
export function seedForage(state, {
  grid,
  shells = false,
  count = APPLE_INITIAL,
  shellCount = SHELL_INITIAL,
  random = Math.random,
  occupied = new Set(),
  nowMs = Date.now()
} = {}) {
  const applesAdded = seedApples(state, { grid, count, random, occupied, nowMs });
  const shellsAdded = shells
    ? seedShells(state, { grid, count: shellCount, random, occupied, nowMs })
    : 0;
  return { applesAdded, shellsAdded };
}

/**
 * Advance respawn clocks. Returns how many apples and shells sprouted and how
 * many mushrooms returned. Safe to call every frame.
 */
export function growForage(state, { grid, nowMs = Date.now(), random = Math.random, occupied = new Set() } = {}) {
  const field = isObject(state) ? state : null;
  if (!field) return { applesAdded: 0, mushroomsReturned: 0, shellsAdded: 0 };

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
  const taken = groundTiles(field.apples, new Set(occupied));
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

  // `nextShellAt` stays 0 in locations that do not seed shells, so the clock
  // never starts somewhere shells do not belong.
  let shellsAdded = 0;
  if (Number(field.nextShellAt) > 0) {
    field.shells = Array.isArray(field.shells) ? field.shells : [];
    const shellTaken = groundTiles(field.shells, new Set(occupied));
    let shellGuard = 0;
    while (nowMs >= field.nextShellAt && shellGuard < 64) {
      shellGuard += 1;
      if (field.shells.length < SHELL_MAX) {
        const tile = findShellTile(grid, { random, occupied: shellTaken });
        if (tile) {
          field.shells.push({ id: shellKey(tile.x, tile.y), x: tile.x, y: tile.y });
          shellTaken.add(`${tile.x},${tile.y}`);
          shellsAdded += 1;
        }
      }
      field.nextShellAt += SHELL_RESPAWN_MS;
    }
    if (field.nextShellAt <= nowMs) field.nextShellAt = nowMs + SHELL_RESPAWN_MS;
  }

  return { applesAdded, mushroomsReturned, shellsAdded };
}

export function appleAt(state, x, y) {
  if (!isObject(state) || !Array.isArray(state.apples)) return null;
  return state.apples.find(apple => apple.x === x && apple.y === y) || null;
}

export function shellAt(state, x, y) {
  if (!isObject(state) || !Array.isArray(state.shells)) return null;
  return state.shells.find(shell => shell.x === x && shell.y === y) || null;
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

  const shell = shellAt(state, x, y);
  if (shell) {
    state.shells = state.shells.filter(candidate => candidate !== shell);
    state.basket = normalizeBasket(state.basket);
    state.basket.shell += 1;
    return { kind: 'shell', item: FORAGE_ITEMS.shell, amount: 1, shell };
  }

  return null;
}

/** Basket counts plus a short label for the bag panel. */
export function basketSummary(state) {
  const basket = normalizeBasket(state?.basket);
  return {
    apple: basket.apple,
    mushroom: basket.mushroom,
    shell: basket.shell,
    total: basket.apple + basket.mushroom + basket.shell,
    label: `🍎 ${basket.apple} · 🍄 ${basket.mushroom} · 🐚 ${basket.shell}`,
    respawnMs: {
      apple: APPLE_RESPAWN_MS,
      mushroom: MUSHROOM_RESPAWN_MS,
      shell: SHELL_RESPAWN_MS
    }
  };
}

/**
 * Copy a carried basket into a location record before arrivals. The basket is
 * shared across locations, so apples picked in the Park are bakeable at Home and
 * a pie baked at Home leaves the same count when you walk back out.
 */
export function carryBasket(record, basket) {
  if (!isObject(record)) return record;
  return {
    ...record,
    forage: {
      ...(isObject(record.forage) ? record.forage : {}),
      basket: normalizeBasket(basket)
    }
  };
}
