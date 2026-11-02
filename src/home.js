/**
 * Pure Home-slice logic: buddy roster selection, deterministic placement, the
 * cheap wander/sit tick, and decor placement rules.
 *
 * Nothing here touches the DOM or a live `Game`. The renderer owns the settled
 * pose; `Game.updateHomeBuddies` owns step animation. Tests drive these
 * functions with an injectable RNG so the two behaviours stay deterministic.
 */
import { WORLD_SIZE, isWalkable, typeAt } from './world.js';
import decorData from '../data/decor.json' with { type: 'json' };

export const HOME_BUDDY_CAP = 12;
export const HOME_SIT_RADIUS = 2;
export const HOME_SIT_MIN_SECONDS = 4;
export const HOME_SIT_MAX_SECONDS = 8;
export const HOME_SIT_CHANCE = 0.5;
export const HOME_WAIT_MIN = 0.6;
export const HOME_WAIT_MAX = 2.8;

const DOWN = 0;
const RIGHT = 1;
const UP = 2;
const LEFT = 3;
const DIRS = [
  { dx: 0, dy: 1, direction: DOWN },
  { dx: 1, dy: 0, direction: RIGHT },
  { dx: 0, dy: -1, direction: UP },
  { dx: -1, dy: 0, direction: LEFT }
];

export const DECOR_ITEMS = Array.isArray(decorData.items) ? decorData.items : [];
export const DEFAULT_DECOR_ID = decorData.default || DECOR_ITEMS[0]?.id || null;

const DECOR_BY_ID = new Map(DECOR_ITEMS.map(item => [item.id, item]));

export function decorItem(id) {
  return DECOR_BY_ID.get(id) || null;
}

export function tileKey(tile) {
  return `${tile?.x},${tile?.y}`;
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function compareIds(a, b) {
  const left = String(a?.id ?? '');
  const right = String(b?.id ?? '');
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** FNV-1a; stable across reloads and platforms. */
export function hashString(value) {
  const text = String(value ?? '');
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates on a copy, seeded so the same roster lands in the same spots. */
function seededShuffle(items, seed) {
  const list = [...items];
  const random = mulberry32(seed);
  for (let index = list.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [list[index], list[swap]] = [list[swap], list[index]];
  }
  return list;
}

/**
 * Player-owned buddies only: active party first, then stabled reserves, each in
 * stable id order. NPC-owned companions are deliberately excluded. The result
 * keeps the original records so callers never mutate a copy back into the party.
 */
export function selectHomeRoster(active = [], stabled = [], { cap = HOME_BUDDY_CAP } = {}) {
  const seen = new Set();
  const ordered = [];
  const sources = [['active', active], ['stabled', stabled]];

  for (const [source, list] of sources) {
    const records = (Array.isArray(list) ? list : [])
      .filter(record => isRecord(record) && record.id)
      .filter(record => source === 'stabled' || record.buddyId === 'player')
      .filter(record => !seen.has(record.id))
      .sort(compareIds);
    for (const record of records) {
      if (seen.has(record.id)) continue;
      seen.add(record.id);
      ordered.push({ record, source });
    }
  }

  const limit = Math.max(0, Math.floor(Number(cap) || HOME_BUDDY_CAP));
  const buddies = ordered.slice(0, limit);
  return {
    buddies,
    total: ordered.length,
    overflow: Math.max(0, ordered.length - buddies.length)
  };
}

/** Interior floor tiles for the house; the yard and the wall line are excluded. */
export function homeRoomTiles(terrain, house) {
  if (!terrain || !house) return [];
  const width = Math.floor(Number(house.width));
  const height = Math.floor(Number(house.height));
  const originX = Math.floor(Number(house.x));
  const originY = Math.floor(Number(house.y));
  if (![width, height, originX, originY].every(Number.isFinite)) return [];
  if (width < 3 || height < 3) return [];

  const tiles = [];
  for (let y = originY + 1; y <= originY + height - 2; y += 1) {
    for (let x = originX + 1; x <= originX + width - 2; x += 1) {
      if (isWalkable(typeAt(terrain, x, y))) tiles.push({ x, y });
    }
  }
  return tiles;
}

function directionBetween(from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    if (dx > 0) return RIGHT;
    if (dx < 0) return LEFT;
  }
  if (dy > 0) return DOWN;
  if (dy < 0) return UP;
  return DOWN;
}

function manhattan(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

/**
 * Place each selected buddy on its own interior floor tile, deterministically
 * from the roster ids. A few start near the rug so the sit behaviour is visible
 * soon after arrival; the rest spread across the room.
 */
export function placeHomeBuddies(selection = [], {
  terrain,
  house,
  spawn = null,
  rugTiles = [],
  cap = HOME_BUDDY_CAP
} = {}) {
  const room = homeRoomTiles(terrain, house);
  if (!room.length) return [];

  const blocked = new Set((Array.isArray(rugTiles) ? rugTiles : []).map(tileKey));
  if (spawn) blocked.add(tileKey(spawn));

  const current = room.filter(tile => !blocked.has(tileKey(tile)));
  const anchor = Array.isArray(rugTiles) && rugTiles.length
    ? rugTiles[0]
    : {
        x: Math.round(room.reduce((sum, tile) => sum + tile.x, 0) / room.length),
        y: Math.round(room.reduce((sum, tile) => sum + tile.y, 0) / room.length)
      };

  const near = [];
  const far = [];
  for (const tile of current) {
    if (manhattan(tile, anchor) <= HOME_SIT_RADIUS) near.push(tile);
    else far.push(tile);
  }

  const ids = selection.slice(0, Math.max(0, cap)).map(entry => entry.record?.id || '');
  const seed = hashString(`home:${ids.join(',')}`);
  const nearPool = seededShuffle(near, seed);
  const farPool = seededShuffle(far, seed ^ 0x9e3779b9);
  const fallback = seededShuffle(current, seed ^ 0x85ebca6b);
  const used = new Set();

  const take = pool => {
    while (pool.length) {
      const tile = pool.shift();
      const key = tileKey(tile);
      if (!used.has(key)) {
        used.add(key);
        return tile;
      }
    }
    return null;
  };

  const placed = [];
  for (let index = 0; index < selection.length && index < cap; index += 1) {
    const entry = selection[index];
    let tile = null;
    // The first four gather around the rug; the rest spread into the room.
    if (index < 4) tile = take(nearPool);
    if (!tile) tile = take(farPool);
    if (!tile) tile = take(nearPool);
    if (!tile) tile = take(fallback);
    if (!tile) break;

    const record = entry.record;
    placed.push({
      ...record,
      partyActive: entry.source === 'active',
      x: tile.x,
      y: tile.y,
      direction: directionBetween(tile, anchor),
      pose: 'stand',
      timer: HOME_WAIT_MIN + (hashString(`timer:${record.id}`) % 1800) / 1000,
      sitTimer: 0
    });
  }
  return placed;
}

function nearestRug(rugTiles, x, y, radius = HOME_SIT_RADIUS) {
  let best = null;
  let bestDistance = Infinity;
  for (const tile of Array.isArray(rugTiles) ? rugTiles : []) {
    const distance = Math.abs(tile.x - x) + Math.abs(tile.y - y);
    if (distance <= radius && distance < bestDistance) {
      best = tile;
      bestDistance = distance;
    }
  }
  return best;
}

function wanderOptions(state, roomTiles, blocked, occupied) {
  const options = [];
  for (const step of DIRS) {
    const x = state.x + step.dx;
    const y = state.y + step.dy;
    const key = `${x},${y}`;
    if (!roomTiles.has(key)) continue;
    if (blocked.has(key) || occupied.has(key)) continue;
    options.push({ x, y, direction: step.direction });
  }
  return options;
}

/**
 * Advance one Home buddy by `dt` seconds. Returns a new state; movement is
 * logical (the caller animates the step). While `moving` is true the caller
 * should not tick this buddy again.
 *
 * `rng` is injectable and defaults to Math.random; tests pass a fixed sequence.
 */
export function tickHomeBuddy(state, {
  dt = 0,
  terrain = null,
  roomTiles = [],
  rugTiles = [],
  occupied = new Set(),
  rng = Math.random
} = {}) {
  if (!isRecord(state) || state.moving) return state;
  const delta = Math.max(0, Number(dt) || 0);
  if (delta === 0) return state;

  if (state.pose === 'sit') {
    const remaining = (Number(state.sitTimer) || 0) - delta;
    if (remaining > 0) return { ...state, sitTimer: remaining };
    return {
      ...state,
      pose: 'stand',
      sitTimer: 0,
      timer: HOME_WAIT_MIN + rng() * (HOME_WAIT_MAX - HOME_WAIT_MIN)
    };
  }

  const timer = (Number(state.timer) || 0) - delta;
  if (timer > 0) return { ...state, timer };

  const rug = nearestRug(rugTiles, state.x, state.y);
  if (rug && rng() < HOME_SIT_CHANCE) {
    return {
      ...state,
      pose: 'sit',
      sitTimer: HOME_SIT_MIN_SECONDS + rng() * (HOME_SIT_MAX_SECONDS - HOME_SIT_MIN_SECONDS),
      timer: 0,
      direction: directionBetween(state, rug)
    };
  }

  const room = new Set((Array.isArray(roomTiles) ? roomTiles : []).map(tileKey));
  const blocked = new Set((Array.isArray(rugTiles) ? rugTiles : []).map(tileKey));
  const taken = occupied instanceof Set ? occupied : new Set(occupied || []);
  const options = wanderOptions(state, room, blocked, taken);

  if (!options.length) {
    return {
      ...state,
      timer: HOME_WAIT_MIN + rng() * (HOME_WAIT_MAX - HOME_WAIT_MIN)
    };
  }

  const choice = options[Math.floor(rng() * options.length)] || options[0];
  return {
    ...state,
    x: choice.x,
    y: choice.y,
    direction: choice.direction,
    timer: HOME_WAIT_MIN + rng() * (HOME_WAIT_MAX - HOME_WAIT_MIN)
  };
}

/** The rug's occupied tiles. Home buddies stand beside it, never on it. */
export function rugTiles(decor = []) {
  return (Array.isArray(decor) ? decor : [])
    .filter(entry => decorItem(entry?.id)?.kind === 'rug')
    .map(entry => ({ x: Math.round(Number(entry.x)), y: Math.round(Number(entry.y)) }))
    .filter(tile => Number.isFinite(tile.x) && Number.isFinite(tile.y));
}

/** Keep only the single known, in-bounds decoration the save format allows. */
export function normalizeDecor(entries) {
  if (!Array.isArray(entries)) return [];
  for (const entry of entries) {
    if (!isRecord(entry) || !decorItem(entry.id)) continue;
    const x = Math.round(Number(entry.x));
    const y = Math.round(Number(entry.y));
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < 0 || x >= WORLD_SIZE || y < 0 || y >= WORLD_SIZE) continue;
    return [{ id: entry.id, x, y }];
  }
  return [];
}

export function canPlaceDecor({ roomTiles = [], x, y } = {}) {
  const tx = Number(x);
  const ty = Number(y);
  if (!Number.isFinite(tx) || !Number.isFinite(ty)) return false;
  return (Array.isArray(roomTiles) ? roomTiles : []).some(tile => tile.x === tx && tile.y === ty);
}

/** Swap or move the single Home decoration. Returns a one-entry array. */
export function placeDecor(current, id, x, y) {
  if (!decorItem(id)) return normalizeDecor(current);
  const tx = Math.round(Number(x));
  const ty = Math.round(Number(y));
  if (!Number.isFinite(tx) || !Number.isFinite(ty)) return normalizeDecor(current);
  return [{ id, x: tx, y: ty }];
}
