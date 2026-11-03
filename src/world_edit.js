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

/** Every refusal `canPlaceWorldObject` or `planBuildingMove` may return. */
export const WORLD_PLACE_REASONS = [
  'outside-world',
  'outside-room',
  'overlap',
  'door',
  'spawn',
  'character',
  'terrain',
  'no-path',
  'no-scoot-space',
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
 * relative to the building origin, so the door travels with a moved facade.
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

/** Buildings move as whole facades; their doors travel with them. */
export function isWorldBuilding(record) {
  return record?.type === 'building';
}

/** Ground cover (rug, towel, blanket, flower bed) never blocks or scoots. */
function isGroundCover(record) {
  const prop = propDefinition(record?.type);
  return prop?.ground === true;
}

function objectLabel(record, kind = 'prop') {
  const label = typeof record?.label === 'string' ? record.label.trim() : '';
  if (label) return label;
  const prop = propDefinition(record?.type);
  if (prop?.label) return prop.label;
  const words = String(record?.type || (kind === 'scenery' ? 'scenery' : 'object')).replace(/-/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Attach each declarative travel door whose tile sits inside a building
 * footprint to that building as `door: { to, dx, dy, prompt }`. The door tile
 * becomes relative to the building origin, so the trigger follows a move.
 *
 * A building that already carries a saved door keeps it verbatim; this is how a
 * moved town survives a reload. Returns the normalised prop list plus every
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
 * The actions a world-object card offers for one object. Scenery has no
 * rotation, and a building only moves or resets: the facade art is south-facing.
 */
export function worldObjectCardActions(kind, record) {
  if (!record) return ['close'];
  if (kind === 'prop' && isWorldBuilding(record)) return ['move', 'reset', 'close'];
  const actions = ['move', 'style'];
  if (kind === 'prop') actions.push('rotate');
  actions.push('reset', 'close');
  return actions;
}

/**
 * Resolve a canvas click without a global editing mode. A draft owns every
 * click, characters beat objects so a neighbour in front of a bench still
 * opens their card, and empty ground falls through to walking.
 *
 * Returns one of: `place-draft`, `character`, `open-object`, `close-card`,
 * or `walk`.
 */
export function resolveWorldClick({ character = null, draft = false, card = false, hit = null } = {}) {
  if (draft) return 'place-draft';
  if (character) return 'character';
  if (hit) return 'open-object';
  if (card) return 'close-card';
  return 'walk';
}

const WORLD_EDIT_MOVES = {
  arrowup: [0, -1],
  w: [0, -1],
  arrowdown: [0, 1],
  s: [0, 1],
  arrowleft: [-1, 0],
  a: [-1, 0],
  arrowright: [1, 0],
  d: [1, 0]
};

/**
 * The keyboard action an open editor surface claims. A draft captures the
 * movement keys, `R`, `C`, Enter, and Escape; with no draft only Escape may
 * close the object card, so walking and global shortcuts keep working.
 * Buildings pass `rotatable: false` and `stylable: false`: their art is fixed.
 */
export function worldEditorKeyAction(
  key,
  { draft = false, card = false, rotatable = true, stylable = true } = {}
) {
  if (draft) {
    if (key === 'Escape') return { action: 'cancel' };
    if (key === 'Enter' || key === ' ') return { action: 'place' };
    const lower = String(key || '').toLowerCase();
    if (lower === 'r') return rotatable ? { action: 'rotate' } : null;
    if (lower === 'c') return stylable ? { action: 'style' } : null;
    const move = WORLD_EDIT_MOVES[lower];
    if (move) return { action: 'move', dx: move[0], dy: move[1] };
    return null;
  }
  if (card && key === 'Escape') return { action: 'close-card' };
  return null;
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

/** A room constraint may arrive as tile records, tile keys, a Set, or `{ tiles }`. */
function roomKeySet(room) {
  const list = room instanceof Set
    ? [...room]
    : (Array.isArray(room) ? room : (isRecord(room) && Array.isArray(room.tiles) ? room.tiles : null));
  if (!list || !list.length) return null;
  const keys = new Set();
  for (const tile of list) {
    if (isRecord(tile)) {
      const x = finiteTile(tile.x);
      const y = finiteTile(tile.y);
      if (x !== null && y !== null) keys.add(`${x},${y}`);
    } else if (typeof tile === 'string' && /^-?\d+,-?\d+$/.test(tile)) {
      keys.add(tile);
    }
  }
  return keys.size ? keys : null;
}

/** Candidates in expanding Chebyshev rings, nearest-first inside each ring. */
function spiralOffsets(maxRadius) {
  const offsets = [{ dx: 0, dy: 0, distance: 0 }];
  for (let radius = 1; radius <= maxRadius; radius += 1) {
    const ring = [];
    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
        ring.push({ dx, dy, distance: dx * dx + dy * dy });
      }
    }
    ring.sort((a, b) => (
      a.distance - b.distance
      || Math.abs(a.dy) - Math.abs(b.dy)
      || a.dx - b.dx
    ));
    offsets.push(...ring);
  }
  return offsets;
}

function buildingFootprintKeys(record) {
  return new Set(worldObjectTiles(record, 'prop').map(propTileKey));
}

/** The tile just outside each edge doorway: keep the approach clear when scooting. */
function doorwayApproachKeys(record) {
  const keys = new Set();
  const size = locationPropSize(record?.type, record?.rot);
  const originX = finiteTile(record?.x);
  const originY = finiteTile(record?.y);
  if (!size || originX === null || originY === null) return keys;
  for (const opening of propOpenings(record)) {
    const dx = finiteTile(opening.dx);
    const dy = finiteTile(opening.dy);
    if (dx === null || dy === null) continue;
    const x = originX + dx;
    const y = originY + dy;
    if (dy === 0) keys.add(`${x},${y - 1}`);
    if (dy === size.h - 1) keys.add(`${x},${y + 1}`);
    if (dx === 0) keys.add(`${x - 1},${y}`);
    if (dx === size.w - 1) keys.add(`${x + 1},${y}`);
  }
  return keys;
}

function occupantsOf(props, extra = []) {
  return worldBlockedTiles([...(Array.isArray(props) ? props : []), ...extra]);
}

/**
 * Plan a free building move, scooting every soft object the footprint covers.
 *
 * Hard blockers refuse the move outright: another building, a door/activity
 * trigger, the spawn, a character, unwalkable terrain, the map edge, and (when
 * supplied) the room. Scenery and non-building props are soft: each finds the
 * nearest valid footprint by spiral search, honouring its own size, terrain,
 * doors, spawn, characters, other objects, and the new facade.
 *
 * Ground cover is left alone beneath the building. The whole plan is built and
 * path-checked before this returns, so a failed plan moves nothing.
 *
 * Returns `{ ok, reason, tiles, building, door, props, scenery, scoots, moves }`
 * on success; `{ ok: false, reason, tiles }` (plus `blocker` when a soft object
 * has nowhere to go) otherwise.
 */
export function planBuildingMove({
  props = [],
  scenery = [],
  record = null,
  target = null,
  terrain = null,
  doors = [],
  spawn = null,
  characters = [],
  room = null,
  requirePath = true,
  maxScoot = 12
} = {}) {
  const list = Array.isArray(props) ? props : [];
  const sceneryList = Array.isArray(scenery) ? scenery : [];
  const targetX = finiteTile(target?.x);
  const targetY = finiteTile(target?.y);
  if (!isWorldBuilding(record) || targetX === null || targetY === null) {
    return { ok: false, reason: 'unknown', tiles: [] };
  }

  const movingIndex = list.findIndex(item => (
    item === record || (record.uid && item?.uid === record.uid)
  ));
  if (movingIndex < 0) return { ok: false, reason: 'unknown', tiles: [] };
  const current = list[movingIndex];
  const building = {
    ...current,
    x: targetX,
    y: targetY,
    rot: normalizePropRotation(current.rot)
  };
  const footprint = worldObjectTiles(building, 'prop');
  if (!footprint.length) return { ok: false, reason: 'outside-world', tiles: [] };
  if (footprint.some(tile => (
    tile.x < 0 || tile.x >= WORLD_SIZE || tile.y < 0 || tile.y >= WORLD_SIZE
  ))) {
    return { ok: false, reason: 'outside-world', tiles: footprint };
  }

  const roomKeys = roomKeySet(room);
  if (roomKeys && !footprint.every(tile => roomKeys.has(propTileKey(tile)))) {
    return { ok: false, reason: 'outside-room', tiles: footprint };
  }

  // A facade may not stand in water or another unwalkable cell.
  if (terrain && footprint.some(tile => !isWalkable(typeAt(terrain, tile.x, tile.y)))) {
    return { ok: false, reason: 'terrain', tiles: footprint };
  }

  const footprintKeys = new Set(footprint.map(propTileKey));
  const approachKeys = doorwayApproachKeys(building);
  const otherBuildings = list.filter((item, index) => index !== movingIndex && isWorldBuilding(item));
  const allBuildingKeys = new Set(footprintKeys);
  for (const other of otherBuildings) {
    for (const key of buildingFootprintKeys(other)) allBuildingKeys.add(key);
  }
  if (otherBuildings.some(other => {
    const keys = buildingFootprintKeys(other);
    return [...keys].some(key => footprintKeys.has(key));
  })) {
    return { ok: false, reason: 'overlap', tiles: footprint };
  }

  const spawnTile = isRecord(spawn)
    ? { x: finiteTile(spawn.x), y: finiteTile(spawn.y) }
    : null;
  const hasSpawn = spawnTile && spawnTile.x !== null && spawnTile.y !== null;
  const spawnKey = hasSpawn ? propTileKey(spawnTile) : null;
  const characterKeys = new Set(tileKeyList(characters).map(propTileKey));
  const fixedDoorTiles = tileKeyList(doors);
  const newBuildingDoor = buildingDoorEntries([building])[0] || null;
  const doorTiles = [
    ...fixedDoorTiles,
    ...(newBuildingDoor ? [{ x: newBuildingDoor.x, y: newBuildingDoor.y }] : [])
  ];
  const fixedDoorKeys = new Set(fixedDoorTiles.map(propTileKey));
  const doorKeys = new Set(doorTiles.map(propTileKey));

  // The building's own new doorway is inside its footprint by design; only a
  // fixed trigger (park gate, beach path, activity entrance) is a hard blocker.
  if ([...footprintKeys].some(key => fixedDoorKeys.has(key))) {
    return { ok: false, reason: 'door', tiles: footprint };
  }
  if (spawnKey && footprintKeys.has(spawnKey)) {
    return { ok: false, reason: 'spawn', tiles: footprint };
  }
  if ([...footprintKeys].some(key => characterKeys.has(key))) {
    return { ok: false, reason: 'character', tiles: footprint };
  }

  // Soft overlaps: solid props and scenery under the new facade. Ground cover
  // stays where it is, safely beneath the building.
  const softPropIndexes = new Set();
  for (let index = 0; index < list.length; index += 1) {
    if (index === movingIndex) continue;
    const item = list[index];
    if (isWorldBuilding(item) || isGroundCover(item)) continue;
    if (worldObjectTiles(item, 'prop').some(tile => footprintKeys.has(propTileKey(tile)))) {
      softPropIndexes.add(index);
    }
  }
  const softSceneryIndexes = new Set();
  for (let index = 0; index < sceneryList.length; index += 1) {
    const item = sceneryList[index];
    if (footprintKeys.has(`${finiteTile(item?.x)},${finiteTile(item?.y)}`)) {
      softSceneryIndexes.add(index);
    }
  }

  const restProps = list.filter((item, index) => (
    index !== movingIndex && !softPropIndexes.has(index)
  ));
  const placedProps = [];
  const sceneryOccupancy = new Set();
  for (let index = 0; index < sceneryList.length; index += 1) {
    if (softSceneryIndexes.has(index)) continue;
    const x = finiteTile(sceneryList[index]?.x);
    const y = finiteTile(sceneryList[index]?.y);
    if (x !== null && y !== null) sceneryOccupancy.add(`${x},${y}`);
  }

  const roomTiles = roomKeys
    ? [...roomKeys].map(key => {
      const [x, y] = key.split(',').map(Number);
      return { x, y };
    })
    : null;
  const offsets = spiralOffsets(Math.max(0, Math.round(Number(maxScoot) || 12)));
  const scoots = [];
  const scootProps = new Map();
  const scootScenery = new Map();

  const candidateFits = (tiles) => {
    if (!tiles.length) return false;
    if (tiles.some(tile => (
      tile.x < 0 || tile.x >= WORLD_SIZE || tile.y < 0 || tile.y >= WORLD_SIZE
    ))) return false;
    if (roomKeys && !tiles.every(tile => roomKeys.has(propTileKey(tile)))) return false;
    if (tiles.some(tile => allBuildingKeys.has(propTileKey(tile)))) return false;
    if (tiles.some(tile => approachKeys.has(propTileKey(tile)))) return false;
    if (tiles.some(tile => doorKeys.has(propTileKey(tile)))) return false;
    if (spawnKey && tiles.some(tile => propTileKey(tile) === spawnKey)) return false;
    if (tiles.some(tile => characterKeys.has(propTileKey(tile)))) return false;
    if (terrain && tiles.some(tile => !isWalkable(typeAt(terrain, tile.x, tile.y)))) return false;
    return true;
  };

  // Props first: a 2 x 1 bench keeps its size and rotation.
  for (const index of softPropIndexes) {
    const item = list[index];
    const from = { x: Math.round(Number(item.x)), y: Math.round(Number(item.y)) };
    let placed = null;
    for (const offset of offsets) {
      const candidate = { ...item, x: from.x + offset.dx, y: from.y + offset.dy };
      const tiles = worldObjectTiles(candidate, 'prop');
      if (!candidateFits(tiles)) continue;
      if (tiles.some(tile => sceneryOccupancy.has(propTileKey(tile)))) continue;
      const placement = canPlaceWorldObject({
        kind: 'prop',
        props: [...restProps, building, ...placedProps],
        type: candidate.type,
        x: candidate.x,
        y: candidate.y,
        rot: candidate.rot,
        variant: candidate.variant,
        seed: candidate.seed,
        uid: candidate.uid,
        openings: candidate.openings,
        terrain,
        roomTiles,
        doors: doorTiles,
        spawn,
        characters,
        requirePath: false
      });
      if (!placement.ok) continue;
      placed = candidate;
      break;
    }
    if (!placed) {
      return {
        ok: false,
        reason: 'no-scoot-space',
        blocker: objectLabel(item).toLowerCase(),
        blockerUid: item.uid || '',
        blockerKind: 'prop',
        tiles: []
      };
    }
    placedProps.push(placed);
    scootProps.set(index, placed);
    scoots.push({
      kind: 'prop',
      uid: item.uid || '',
      label: objectLabel(item).toLowerCase(),
      from,
      to: { x: placed.x, y: placed.y }
    });
  }

  for (const index of softSceneryIndexes) {
    const item = sceneryList[index];
    const from = {
      x: finiteTile(item?.x),
      y: finiteTile(item?.y)
    };
    let placed = null;
    for (const offset of offsets) {
      const next = { x: from.x + offset.dx, y: from.y + offset.dy };
      const tiles = [{ x: next.x, y: next.y }];
      if (!candidateFits(tiles)) continue;
      if (tiles.some(tile => sceneryOccupancy.has(propTileKey(tile)))) continue;
      const blocked = occupantsOf([...restProps, building, ...placedProps]);
      if (tiles.some(tile => blocked.has(propTileKey(tile)))) continue;
      placed = next;
      break;
    }
    if (!placed) {
      return {
        ok: false,
        reason: 'no-scoot-space',
        blocker: objectLabel(item, 'scenery').toLowerCase(),
        blockerUid: item.uid || '',
        blockerKind: 'scenery',
        tiles: []
      };
    }
    sceneryOccupancy.add(propTileKey(placed));
    scootScenery.set(index, { ...item, x: placed.x, y: placed.y });
    scoots.push({
      kind: 'scenery',
      uid: item.uid || '',
      label: objectLabel(item, 'scenery').toLowerCase(),
      from,
      to: placed
    });
  }

  const nextProps = list.map((item, index) => {
    if (index === movingIndex) return building;
    return scootProps.get(index) || item;
  });
  const nextScenery = sceneryList.map((item, index) => scootScenery.get(index) || item);

  // Validate the whole final layout: spawn plus every fixed and building door.
  if (requirePath && terrain && hasSpawn) {
    const blocked = worldBlockedTiles(nextProps);
    if (blocked.has(spawnKey)) return { ok: false, reason: 'no-path', tiles: footprint };
    const reachable = reachableWorldTiles(terrain, spawnTile, blocked);
    const finalDoors = [
      ...tileKeyList(doors),
      ...buildingDoorEntries(nextProps).map(entry => ({ x: entry.x, y: entry.y }))
    ];
    if (finalDoors.some(tile => !reachable.has(propTileKey(tile)))) {
      return { ok: false, reason: 'no-path', tiles: footprint };
    }
  }

  const oldDoor = buildingDoorEntries([current])[0] || null;
  return {
    ok: true,
    reason: null,
    tiles: footprint,
    building,
    door: newBuildingDoor,
    props: nextProps,
    scenery: nextScenery,
    scoots,
    moves: {
      building: {
        uid: current.uid || '',
        from: { x: Math.round(Number(current.x)), y: Math.round(Number(current.y)) },
        to: { x: targetX, y: targetY }
      },
      door: oldDoor && newBuildingDoor ? {
        uid: newBuildingDoor.uid || '',
        to: newBuildingDoor.to,
        from: { x: oldDoor.x, y: oldDoor.y },
        to: { x: newBuildingDoor.x, y: newBuildingDoor.y }
      } : null
    }
  };
}

/**
 * Player-facing confirmation for a successful building plan. Ground cover is
 * never listed; solid soft objects are named so nothing moves by surprise.
 */
export function buildingMoveConfirmation(plan) {
  const labels = (Array.isArray(plan?.scoots) ? plan.scoots : [])
    .map(scoot => scoot.label)
    .filter(label => typeof label === 'string' && label);
  const name = objectLabel(plan?.building).toLowerCase();
  const count = labels.length;
  return {
    needed: count > 0,
    title: `Place the ${name} here?`,
    note: count
      ? `${count} ${count === 1 ? 'object' : 'objects'} will move nearby: ${labels.join(', ')}`
      : '',
    confirm: count ? 'Place and move them' : 'Place',
    cancel: 'Cancel',
    labels
  };
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

/** Player-facing copy for a placement refusal (used by the contextual editor). */
export function worldObjectReasonText(reason, detail = null) {
  switch (reason) {
    case 'outside-world': return 'that needs to stay on the map.';
    case 'outside-room': return 'that needs to stay inside the room.';
    case 'overlap': return 'something else is already there.';
    case 'door': return 'keep the doorway clear.';
    case 'spawn': return 'leave the arrival spot open.';
    case 'character': return 'someone is standing there.';
    case 'terrain': return 'that does not belong on this ground.';
    case 'no-path': return 'that would block the way through.';
    case 'no-scoot-space': {
      const blocker = typeof detail === 'string' ? detail : detail?.blocker;
      return blocker
        ? `there is no room nearby to move the ${blocker}.`
        : 'there is no room nearby to move what it covers.';
    }
    case 'unknown': return 'that object is missing from the catalog.';
    default: return 'that spot will not work.';
  }
}
