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
  locationPropSize,
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
 * A building-owned travel trigger in its compact save shape. Offsets are
 * relative to the building origin, so the door travels with a swapped facade.
 * A door without a destination or an in-footprint offset is not a door.
 */
function normalizeBuildingDoor(entry, prop, x, y, rot) {
  if (!isRecord(entry)) return null;
  const to = typeof entry.to === 'string' ? entry.to.trim().slice(0, 48) : '';
  if (!to) return null;
  const dx = finiteTile(entry.dx);
  const dy = finiteTile(entry.dy);
  if (dx === null || dy === null) return null;
  const size = locationPropSize(prop?.id, rot);
  if (!size || dx < 0 || dx >= size.w || dy < 0 || dy >= size.h) return null;
  const prompt = typeof entry.prompt === 'string' ? entry.prompt.trim().slice(0, 120) : '';
  return { to, dx, dy, ...(prompt ? { prompt } : {}) };
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
    const door = normalizeBuildingDoor(entry.door, prop, x, y, rot);

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

/** Buildings swap whole lots; their doors travel with them. */
export function isWorldBuilding(record) {
  return record?.type === 'building';
}

/**
 * Attach each declarative travel door whose tile sits inside a building
 * footprint to that building as `door: { to, dx, dy, prompt }`. The door tile
 * becomes relative to the building origin, so the trigger follows a swap.
 *
 * A building that already carries a saved door keeps it verbatim; this is how a
 * swapped town survives a reload. Returns the normalised prop list plus every
 * door no building claimed (park gate, beach path, activity entrances).
 */
export function linkBuildingDoors(props, doors = []) {
  const list = Array.isArray(props) ? props : [];
  const next = list.map(record => ({ ...record }));
  const hosts = new Map();
  for (let index = 0; index < list.length; index += 1) {
    const record = list[index];
    if (!isWorldBuilding(record)) continue;
    for (const tile of worldObjectTiles(record, 'prop')) {
      hosts.set(propTileKey(tile), index);
    }
  }

  const leftovers = [];
  for (const door of Array.isArray(doors) ? doors : []) {
    if (!isRecord(door) || door.kind === 'activity') {
      leftovers.push(door);
      continue;
    }
    const x = finiteTile(door.x);
    const y = finiteTile(door.y);
    const index = x === null || y === null ? undefined : hosts.get(`${x},${y}`);
    if (index === undefined) {
      leftovers.push(door);
      continue;
    }
    const target = next[index];
    // An already-linked building owns its trigger. A second declarative door on
    // its footprint is stale data, not a reason to move the door again.
    if (isRecord(target.door)) continue;
    const meta = normalizeBuildingDoor({
      to: door.to,
      dx: x - Math.round(Number(target.x)),
      dy: y - Math.round(Number(target.y)),
      prompt: door.prompt
    }, propDefinition(target.type), target.x, target.y, target.rot);
    if (meta) target.door = meta;
  }

  return { props: next, doors: leftovers };
}

/**
 * Runtime-ready building triggers in prop list order. Geometry only; the caller
 * adds copy, confirm/cancel labels, and the enabled check.
 */
export function buildingDoorEntries(props = []) {
  const entries = [];
  for (const record of Array.isArray(props) ? props : []) {
    if (!isWorldBuilding(record) || !isRecord(record.door)) continue;
    const x = finiteTile(record.x);
    const y = finiteTile(record.y);
    if (x === null || y === null) continue;
    const dx = finiteTile(record.door.dx);
    const dy = finiteTile(record.door.dy);
    if (dx === null || dy === null || typeof record.door.to !== 'string' || !record.door.to) continue;
    entries.push({
      uid: record.uid || '',
      to: record.door.to,
      dx,
      dy,
      x: x + dx,
      y: y + dy,
      prompt: typeof record.door.prompt === 'string' ? record.door.prompt : ''
    });
  }
  return entries;
}

/** Swap two buildings' tiles; each keeps its own label, door, and openings. */
export function swapWorldBuildings(props, aUid, bUid) {
  const list = Array.isArray(props) ? props : [];
  if (!aUid || !bUid || aUid === bUid) return list;
  const a = list.find(record => record?.uid === aUid && isWorldBuilding(record));
  const b = list.find(record => record?.uid === bUid && isWorldBuilding(record));
  if (!a || !b) return list;
  const ax = finiteTile(a.x);
  const ay = finiteTile(a.y);
  const bx = finiteTile(b.x);
  const by = finiteTile(b.y);
  if (ax === null || ay === null || bx === null || by === null) return list;
  return list.map(record => {
    if (record === a) return { ...record, x: bx, y: by };
    if (record === b) return { ...record, x: ax, y: ay };
    return record;
  });
}

/**
 * Validate a two-building lot swap. Both facades must stay in bounds, keep
 * their doorway clear of solids, scenery, characters, the spawn, and every
 * door (including the other buildings' triggers), and leave the spawn
 * connected to every trigger.
 */
export function canSwapWorldBuildings({
  props = [],
  aUid = null,
  bUid = null,
  terrain = null,
  spawn = null,
  doors = [],
  scenery = [],
  characters = [],
  requirePath = true
} = {}) {
  const list = Array.isArray(props) ? props : [];
  const a = list.find(record => record?.uid === aUid && isWorldBuilding(record));
  const b = list.find(record => record?.uid === bUid && isWorldBuilding(record));
  if (!a || !b || aUid === bUid) return { ok: false, reason: 'unknown', tiles: [] };

  const next = swapWorldBuildings(list, aUid, bUid);
  const movedUids = new Set([aUid, bUid]);
  const moved = next.filter(record => movedUids.has(record?.uid));
  const others = next.filter(record => !movedUids.has(record?.uid));
  if (moved.length !== 2) return { ok: false, reason: 'unknown', tiles: [] };

  const blockedByBuilding = moved.map(record => new Set(solidTiles(record).map(propTileKey)));
  const movedBlocked = new Set(blockedByBuilding.flatMap(set => [...set]));

  for (const record of moved) {
    const tiles = worldObjectTiles(record, 'prop');
    if (!tiles.length || tiles.some(tile => (
      tile.x < 0 || tile.x >= WORLD_SIZE || tile.y < 0 || tile.y >= WORLD_SIZE
    ))) {
      return { ok: false, reason: 'outside-world', tiles };
    }
  }

  // The two facades may not interlock, and neither may land on a solid prop.
  const taken = worldBlockedTiles(others);
  if (blockedByBuilding[0] && [...blockedByBuilding[0]].some(key => blockedByBuilding[1].has(key))) {
    return { ok: false, reason: 'overlap', tiles: [] };
  }
  if ([...movedBlocked].some(key => taken.has(key))) {
    return { ok: false, reason: 'overlap', tiles: [] };
  }

  // A tree or flower inside a facade would draw through it. Scenery never
  // blocks a step, but a building is not allowed to swallow it.
  const sceneryKeys = new Set(
    (Array.isArray(scenery) ? scenery : [])
      .map(item => `${finiteTile(item?.x)},${finiteTile(item?.y)}`)
  );
  if ([...movedBlocked].some(key => sceneryKeys.has(key))) {
    return { ok: false, reason: 'overlap', tiles: [] };
  }

  const spawnTile = isRecord(spawn)
    ? { x: finiteTile(spawn.x), y: finiteTile(spawn.y) }
    : null;
  if (spawnTile && spawnTile.x !== null && spawnTile.y !== null
    && movedBlocked.has(propTileKey(spawnTile))) {
    return { ok: false, reason: 'spawn', tiles: [] };
  }

  const characterKeys = new Set(tileKeyList(characters).map(propTileKey));
  if ([...movedBlocked].some(key => characterKeys.has(key))) {
    return { ok: false, reason: 'character', tiles: [] };
  }

  // Every trigger that stays put, plus every building trigger at its new tile.
  const fixedDoors = tileKeyList(doors);
  const buildingDoors = buildingDoorEntries(next);
  const doorTiles = [
    ...fixedDoors,
    ...buildingDoors.map(door => ({ x: door.x, y: door.y }))
  ];
  const doorKeys = new Set(doorTiles.map(propTileKey));
  if ([...movedBlocked].some(key => doorKeys.has(key))) {
    return { ok: false, reason: 'door', tiles: [] };
  }

  if (requirePath && terrain && spawnTile && spawnTile.x !== null && spawnTile.y !== null) {
    const blocked = new Set(taken);
    for (const key of movedBlocked) blocked.add(key);
    const reachable = reachableWorldTiles(terrain, spawnTile, blocked);
    if (doorTiles.some(tile => !reachable.has(propTileKey(tile)))) {
      return { ok: false, reason: 'no-path', tiles: [] };
    }
  }

  return { ok: true, reason: null, tiles: [] };
}

/**
 * Topmost editable object at one tile. A solid prop wins over ground cover,
 * and any prop wins over scenery (scenery draws beneath props). Returns
 * `{ kind, record }` or null. Used by the Decorate hit test.
 */
export function worldObjectAt(props, scenery, x, y) {
  const tileX = finiteTile(x);
  const tileY = finiteTile(y);
  if (tileX === null || tileY === null) return null;

  const hits = (Array.isArray(props) ? props : []).filter(record => (
    worldObjectTiles(record, 'prop').some(tile => tile.x === tileX && tile.y === tileY)
  ));
  if (hits.length) {
    const solid = record => {
      const prop = propDefinition(record?.type);
      return prop?.solid === true && prop.ground !== true;
    };
    const ordered = [...hits].sort((a, b) => (
      (solid(b) ? 1 : 0) - (solid(a) ? 1 : 0)
      || (Number(b?.y) || 0) - (Number(a?.y) || 0)
    ));
    return { kind: 'prop', record: ordered[0] };
  }

  const sceneryRecord = (Array.isArray(scenery) ? scenery : []).find(record => (
    finiteTile(record?.x) === tileX && finiteTile(record?.y) === tileY
  ));
  return sceneryRecord ? { kind: 'scenery', record: sceneryRecord } : null;
}

/**
 * The actions a Decorate card offers for one object. Scenery has no rotation;
 * a building offers only a lot swap and Close.
 */
export function worldObjectCardActions(kind, record) {
  if (!record) return ['close'];
  if (kind === 'prop' && isWorldBuilding(record)) return ['swap', 'close'];
  const actions = ['move', 'style'];
  if (kind === 'prop') actions.push('rotate');
  actions.push('reset', 'close');
  return actions;
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
 * Commit one Decorate draft onto its list. The uid never changes, so a moved
 * object stays the same object to the save and to `resetWorldObject`.
 */
export function applyWorldDraft(objects, draft = {}) {
  const list = Array.isArray(objects) ? objects : [];
  const uid = typeof draft?.uid === 'string' ? draft.uid : '';
  if (!uid) return list;
  const x = finiteTile(draft.x);
  const y = finiteTile(draft.y);
  let found = false;
  const next = list.map(record => {
    if (record?.uid !== uid) return record;
    found = true;
    const updated = { ...record };
    if (x !== null && y !== null) {
      updated.x = x;
      updated.y = y;
    }
    if (draft.rot !== undefined) updated.rot = normalizePropRotation(draft.rot);
    const sceneryOnly = SCENERY_TYPE_SET.has(record.type) && !propDefinition(record.type);
    if (sceneryOnly) {
      if (draft.scale !== undefined) updated.scale = normalizeSceneryScale(draft.scale);
      return updated;
    }
    const prop = propDefinition(record.type);
    if (draft.variant !== undefined) updated.variant = normalizePropVariant(prop, draft.variant);
    if (draft.seed !== undefined) {
      const seed = normalizePropSeed(draft.seed);
      if (seed) updated.seed = seed;
      else delete updated.seed;
    }
    return updated;
  });
  return found ? next : list;
}

/**
 * Put one object back at its seeded position/style. The matching record comes
 * from the same data-derived defaults list; an object with no seed is untouched.
 */
export function resetWorldObject(objects, uid, defaults = []) {
  const list = Array.isArray(objects) ? objects : [];
  if (!uid) return list;
  const source = (Array.isArray(defaults) ? defaults : [])
    .find(record => record?.uid === uid);
  if (!source) return list;
  return list.map(record => (record?.uid === uid ? { ...source } : record));
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
