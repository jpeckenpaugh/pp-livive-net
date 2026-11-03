/**
 * Pure per-location object layer: saved props and scenery, stable uids,
 * default seeding, and the world-placement validator.
 *
 * Location props and scenery used to be rebuilt from `data/world.json` and the
 * world seed on every load. This module gives both a save-shaped record so an
 * editor (Phase 2) can move, rotate, restyle, and reset them while leaving the
 * existing data-driven layout as the seed for untouched locations.
 *
 * No DOM here: footprints, overlap, and the path check are testable in Node.
 */
import sceneryData from '../data/nature_scenery.json' with { type: 'json' };
import {
  locationBlockedTiles,
  normalizePropRotation,
  normalizePropSeed,
  normalizePropVariant,
  propDefinition,
  propFootprintTiles,
  propOpenings,
  propTileKey
} from './location_props.js';
import { DIRS, WORLD_SIZE, isWalkable, typeAt } from './world.js';

export const SCENERY_TYPES = Object.keys(sceneryData);
const SCENERY_TYPE_SET = new Set(SCENERY_TYPES);

export const SCENERY_SCALE_MIN = 0.5;
export const SCENERY_SCALE_MAX = 1.6;

/** Every refusal `canPlaceWorldObject` may return. */
export const WORLD_PLACE_REASONS = [
  'outside-world',
  'outside-room',
  'overlap',
  'door',
  'spawn',
  'character',
  'terrain',
  'no-path',
  'unknown'
];

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function finiteTile(value) {
  const tile = Math.round(Number(value));
  return Number.isFinite(tile) ? tile : null;
}

function slug(value) {
  return String(value || 'object')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'object';
}

/** A uid that is stable for type + tile and unique inside one list. */
function objectUid(prefix, type, x, y, used) {
  const base = `${prefix}-${slug(type)}-${x}-${y}`;
  let uid = base;
  let index = 2;
  while (used.has(uid)) {
    uid = `${base}-${index}`;
    index += 1;
  }
  used.add(uid);
  return uid;
}

/** Saved uids are kept; a seed or a legacy row derives one from its type + tile. */
function resolveUid(entry, prefix, type, x, y, used) {
  const requested = typeof entry?.uid === 'string' ? entry.uid.trim().slice(0, 64) : '';
  if (requested && !used.has(requested)) {
    used.add(requested);
    return requested;
  }
  return objectUid(prefix, type, x, y, used);
}

export function normalizeSceneryScale(scale) {
  const value = Number(scale);
  if (!Number.isFinite(value)) return 1;
  return Math.min(SCENERY_SCALE_MAX, Math.max(SCENERY_SCALE_MIN, value));
}

/**
 * Normalise a prop list, whether it came from `data/world.json`, a save, or a
 * live game. Known catalogue rows only, in bounds, quarter turns, unique uids,
 * and no two solid footprints on the same tile. Ground cover never reserves a
 * tile, so a rug may sit under a bench.
 */
export function normalizeWorldProps(entries) {
  if (!Array.isArray(entries)) return [];
  const usedUids = new Set();
  const taken = new Set();
  const records = [];

  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const prop = propDefinition(entry.type);
    if (!prop) continue;
    const x = finiteTile(entry.x);
    const y = finiteTile(entry.y);
    if (x === null || y === null) continue;
    const rot = normalizePropRotation(entry.rot);
    const tiles = propFootprintTiles({ type: prop.id, x, y, rot });
    if (!tiles.length) continue;
    if (tiles.some(tile => (
      tile.x < 0 || tile.x >= WORLD_SIZE || tile.y < 0 || tile.y >= WORLD_SIZE
    ))) continue;

    const keys = tiles.map(propTileKey);
    const solid = prop.solid === true && prop.ground !== true;
    if (solid) {
      if (keys.some(key => taken.has(key))) continue;
      for (const key of keys) taken.add(key);
    }

    const openings = propOpenings({ type: prop.id, x, y, rot, openings: entry.openings });
    const label = typeof entry.label === 'string' && entry.label.trim()
      ? entry.label.trim().slice(0, 24)
      : '';
    const seed = normalizePropSeed(entry.seed || entry.detailSeed);
    const lot = typeof entry.lot === 'string' && entry.lot ? entry.lot.slice(0, 16) : '';
    const door = isRecord(entry.door) ? { ...entry.door } : null;

    records.push({
      uid: resolveUid(entry, 'prop', prop.id, x, y, usedUids),
      type: prop.id,
      x,
      y,
      rot,
      variant: normalizePropVariant(prop, entry.variant),
      ...(label ? { label } : {}),
      ...(seed ? { seed } : {}),
      ...(openings.length ? { openings } : {}),
      ...(lot ? { lot } : {}),
      ...(door ? { door } : {})
    });
  }

  return records;
}

/** Saved/declared/generated scenery in its compact save shape. */
export function normalizeWorldScenery(entries) {
  if (!Array.isArray(entries)) return [];
  const usedUids = new Set();
  const records = [];

  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const type = typeof entry.type === 'string' ? entry.type : '';
    if (!SCENERY_TYPE_SET.has(type)) continue;
    const x = finiteTile(entry.x);
    const y = finiteTile(entry.y);
    if (x === null || y === null) continue;
    if (x < 0 || x >= WORLD_SIZE || y < 0 || y >= WORLD_SIZE) continue;

    records.push({
      uid: resolveUid(entry, 'scenery', type, x, y, usedUids),
      type,
      x,
      y,
      scale: normalizeSceneryScale(entry.scale)
    });
  }

  return records;
}

/** First-load defaults: data props plus the generated nature scatter. */
export function seedWorldProps(entries) {
  return normalizeWorldProps(entries);
}

export function seedWorldScenery(entries) {
  return normalizeWorldScenery(entries);
}

/** Footprint of one prop or scenery record. Scenery always occupies one tile. */
export function worldObjectTiles(record, kind = 'prop') {
  if (kind === 'scenery') {
    const x = finiteTile(record?.x);
    const y = finiteTile(record?.y);
    return x === null || y === null ? [] : [{ x, y }];
  }
  return propFootprintTiles({
    type: record?.type,
    x: record?.x,
    y: record?.y,
    rot: record?.rot
  });
}

/** Solid tiles inside a footprint; declared openings stay walkable. */
function solidTiles(record) {
  const tiles = worldObjectTiles(record, 'prop');
  if (!tiles.length) return [];
  const prop = propDefinition(record?.type);
  if (!prop?.solid || prop.ground === true) return [];
  const originX = Math.round(Number(record.x));
  const originY = Math.round(Number(record.y));
  const openings = new Set(
    propOpenings(record).map(opening => `${opening.dx},${opening.dy}`)
  );
  return tiles.filter(tile => !openings.has(`${tile.x - originX},${tile.y - originY}`));
}

/** Blocked tiles for a whole prop list, with building openings respected. */
export function worldBlockedTiles(props = []) {
  return locationBlockedTiles(props);
}

/**
 * Walkable tiles reachable from `from` with `blocked` removed. Used by the
 * placement path check; exported so tests can assert a door stays connected.
 */
export function reachableWorldTiles(terrain, from, blocked = null) {
  const start = {
    x: finiteTile(from?.x),
    y: finiteTile(from?.y)
  };
  const visited = new Set();
  if (start.x === null || start.y === null) return visited;
  if (!isWalkable(typeAt(terrain, start.x, start.y))) return visited;
  const reserved = blocked instanceof Set ? blocked : new Set(blocked || []);
  const startKey = `${start.x},${start.y}`;
  if (reserved.has(startKey)) return visited;

  const queue = [start];
  visited.add(startKey);
  let head = 0;
  while (head < queue.length) {
    const tile = queue[head];
    head += 1;
    for (const { dx, dy } of DIRS) {
      const x = tile.x + dx;
      const y = tile.y + dy;
      if (x < 0 || y < 0 || x >= WORLD_SIZE || y >= WORLD_SIZE) continue;
      const key = `${x},${y}`;
      if (visited.has(key) || reserved.has(key)) continue;
      if (!isWalkable(typeAt(terrain, x, y))) continue;
      visited.add(key);
      queue.push({ x, y });
    }
  }
  return visited;
}

function tileKeyList(tiles) {
  return (Array.isArray(tiles) ? tiles : [])
    .map(tile => ({ x: finiteTile(tile?.x), y: finiteTile(tile?.y) }))
    .filter(tile => tile.x !== null && tile.y !== null);
}

function terrainRule(prop, allowedTerrain) {
  if (Array.isArray(allowedTerrain) && allowedTerrain.length) return allowedTerrain;
  if (Array.isArray(prop?.terrain) && prop.terrain.length) return prop.terrain;
  if (typeof prop?.terrain === 'string' && prop.terrain) return [prop.terrain];
  return null;
}

/**
 * Validate one prop or scenery placement.
 *
 * Props: every footprint tile must be inside the world (and the room, when a
 * room tile list is supplied); solid props may not overlap another solid, sit
 * on a door/spawn/character, break a declared terrain rule, or cut the spawn
 * off from any door. Ground cover is exempt from solid rules.
 *
 * Scenery: bounds only. Trees and flowers never block a step, so they need no
 * overlap or path check.
 */
export function canPlaceWorldObject({
  kind = 'prop',
  objects = null,
  props = null,
  type,
  x,
  y,
  rot = 0,
  variant = 0,
  seed = '',
  uid = null,
  openings = null,
  terrain = null,
  roomTiles = null,
  doors = null,
  door = null,
  spawn = null,
  characters = [],
  allowedTerrain = null,
  requirePath = true
} = {}) {
  const placement = {
    type,
    x: finiteTile(x),
    y: finiteTile(y),
    rot: normalizePropRotation(rot),
    variant,
    seed,
    uid
  };

  if (kind === 'scenery') {
    if (typeof type !== 'string' || !SCENERY_TYPE_SET.has(type)) {
      return { ok: false, reason: 'unknown', tiles: [] };
    }
    if (placement.x === null || placement.y === null) {
      return { ok: false, reason: 'outside-world', tiles: [] };
    }
    const tiles = [{ x: placement.x, y: placement.y }];
    if (placement.x < 0 || placement.x >= WORLD_SIZE
      || placement.y < 0 || placement.y >= WORLD_SIZE) {
      return { ok: false, reason: 'outside-world', tiles };
    }
    return { ok: true, reason: null, tiles };
  }

  const prop = propDefinition(type);
  if (!prop) return { ok: false, reason: 'unknown', tiles: [] };

  // Ground cover never blocks: it may overlap other ground cover and sit under
  // a solid, so it skips every solid rule below.
  const solid = prop.solid === true && prop.ground !== true;
  placement.openings = Array.isArray(openings)
    ? openings
    : (Array.isArray(prop.openings) ? prop.openings : undefined);
  const tiles = worldObjectTiles(placement, 'prop');
  if (!tiles.length) return { ok: false, reason: 'outside-world', tiles };
  if (tiles.some(tile => (
    tile.x < 0 || tile.x >= WORLD_SIZE || tile.y < 0 || tile.y >= WORLD_SIZE
  ))) {
    return { ok: false, reason: 'outside-world', tiles };
  }

  const room = Array.isArray(roomTiles) && roomTiles.length
    ? new Set(roomTiles.map(propTileKey))
    : null;
  if (room && !tiles.every(tile => room.has(propTileKey(tile)))) {
    return { ok: false, reason: 'outside-room', tiles };
  }

  const list = Array.isArray(props) ? props
    : (Array.isArray(objects) ? objects : []);
  const others = list.filter(record => !uid || record?.uid !== uid);
  const blockedTiles = solidTiles(placement);
  const doorTiles = tileKeyList([
    ...(Array.isArray(doors) ? doors : []),
    ...(isRecord(door) ? [door] : [])
  ]);
  const spawnTile = isRecord(spawn)
    ? { x: finiteTile(spawn.x), y: finiteTile(spawn.y) }
    : null;

  if (solid) {
    const doorKeys = new Set(doorTiles.map(propTileKey));
    if (blockedTiles.some(tile => doorKeys.has(propTileKey(tile)))) {
      return { ok: false, reason: 'door', tiles };
    }

    if (spawnTile && spawnTile.x !== null && spawnTile.y !== null
      && blockedTiles.some(tile => tile.x === spawnTile.x && tile.y === spawnTile.y)) {
      return { ok: false, reason: 'spawn', tiles };
    }

    const characterKeys = new Set(
      tileKeyList(characters).map(propTileKey)
    );
    if (blockedTiles.some(tile => characterKeys.has(propTileKey(tile)))) {
      return { ok: false, reason: 'character', tiles };
    }
  }

  const allowed = terrainRule(prop, allowedTerrain);
  if (allowed && terrain) {
    if (!tiles.every(tile => allowed.includes(typeAt(terrain, tile.x, tile.y)))) {
      return { ok: false, reason: 'terrain', tiles };
    }
  }

  if (solid) {
    const taken = worldBlockedTiles(others);
    if (blockedTiles.some(tile => taken.has(propTileKey(tile)))) {
      return { ok: false, reason: 'overlap', tiles };
    }

    if (requirePath && terrain && spawnTile && spawnTile.x !== null && spawnTile.y !== null) {
      const blocked = new Set(taken);
      for (const tile of blockedTiles) blocked.add(propTileKey(tile));
      const reachable = reachableWorldTiles(terrain, spawnTile, blocked);
      const required = [spawnTile, ...doorTiles];
      if (required.some(tile => !reachable.has(propTileKey(tile)))) {
        return { ok: false, reason: 'no-path', tiles };
      }
    }
  }

  return { ok: true, reason: null, tiles };
}

/** Move one record by uid; a missing uid or bad tile returns the same list. */
export function moveWorldObject(objects, uid, x, y) {
  const list = Array.isArray(objects) ? objects : [];
  const tx = finiteTile(x);
  const ty = finiteTile(y);
  if (!uid || tx === null || ty === null) return list;
  let found = false;
  const next = list.map(record => {
    if (record?.uid !== uid) return record;
    found = true;
    return { ...record, x: tx, y: ty };
  });
  return found ? next : list;
}

/** Turn one record a quarter-turn clockwise by default. */
export function rotateWorldObject(objects, uid, turns = 1) {
  const list = Array.isArray(objects) ? objects : [];
  if (!uid) return list;
  const amount = Math.round(Number(turns) || 0) || 1;
  let found = false;
  const next = list.map(record => {
    if (record?.uid !== uid) return record;
    found = true;
    return { ...record, rot: normalizePropRotation(normalizePropRotation(record.rot) + amount) };
  });
  return found ? next : list;
}

/**
 * Restyle one record. Props take a palette `variant` and a detail `seed`;
 * scenery takes a `scale`. Unknown catalogue values fall back to the existing
 * record instead of corrupting it.
 */
export function styleWorldObject(objects, uid, patch = {}) {
  const list = Array.isArray(objects) ? objects : [];
  if (!uid || !isRecord(patch)) return list;
  let found = false;
  const next = list.map(record => {
    if (record?.uid !== uid) return record;
    found = true;
    const updated = { ...record };
    if (SCENERY_TYPE_SET.has(record?.type) && !propDefinition(record?.type)) {
      if (patch.scale !== undefined) updated.scale = normalizeSceneryScale(patch.scale);
      return updated;
    }
    const prop = propDefinition(record?.type);
    if (patch.variant !== undefined) updated.variant = normalizePropVariant(prop, patch.variant);
    if (patch.seed !== undefined) {
      const seed = normalizePropSeed(patch.seed);
      if (seed) updated.seed = seed;
      else delete updated.seed;
    }
    return updated;
  });
  return found ? next : list;
}

/**
 * Reset a location's object layer to its data defaults. The record keeps every
 * other field (terrain, player, NPCs, forage); only the two object lists change.
 */
export function resetLocationObjects(record, defaults = {}) {
  const base = isRecord(record) ? record : {};
  return {
    ...base,
    props: seedWorldProps(defaults?.props),
    scenery: seedWorldScenery(defaults?.scenery)
  };
}

/** Player-facing copy for a placement refusal (used by the Phase 2 editor). */
export function worldObjectReasonText(reason) {
  switch (reason) {
    case 'outside-world': return 'that needs to stay on the map.';
    case 'outside-room': return 'that needs to stay inside the room.';
    case 'overlap': return 'something else is already there.';
    case 'door': return 'keep the doorway clear.';
    case 'spawn': return 'leave the arrival spot open.';
    case 'character': return 'someone is standing there.';
    case 'terrain': return 'that does not belong on this ground.';
    case 'no-path': return 'that would block the way through.';
    case 'unknown': return 'that object is missing from the catalog.';
    default: return 'that spot will not work.';
  }
}
