/**
 * Pure outdoor prop logic for non-Home locations: type lookup, rotated
 * footprints, blocked tiles, placement validation, and the metadata the
 * renderer needs to draw one record.
 *
 * Props live in `data/location_props.json`; a location opts in with a `props`
 * array in `data/world.json`. Nothing here reads the DOM, so collision and
 * placement can be tested in Node.
 */
import propsData from '../data/location_props.json' with { type: 'json' };
import { WORLD_SIZE } from './world.js';

export const LOCATION_PROP_TYPES = propsData.types || {};
export const LOCATION_PROP_IDS = Object.keys(LOCATION_PROP_TYPES);

const PROP_BY_ID = new Map(LOCATION_PROP_IDS.map(id => [id, LOCATION_PROP_TYPES[id]]));

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function propTileKey(tile) {
  return `${tile?.x},${tile?.y}`;
}

export function locationProp(id) {
  return PROP_BY_ID.get(id) || null;
}

export function locationPropLabel(id) {
  return locationProp(id)?.label || id;
}

/** Quarter turns only; negative and huge values wrap safely. */
export function normalizePropRotation(rot) {
  const value = Math.round(Number(rot) || 0);
  return ((value % 4) + 4) % 4;
}

export function normalizePropVariant(prop, variant) {
  const count = Array.isArray(prop?.variants) ? prop.variants.length : 0;
  if (!count) return 0;
  const value = Math.round(Number(variant) || 0);
  return value >= 0 && value < count ? value : 0;
}

/** Rotated size; odd quarter turns swap width and height. */
export function locationPropSize(type, rot = 0) {
  const prop = locationProp(type);
  if (!prop) return null;
  const width = Math.max(1, Math.round(Number(prop.size?.w) || 1));
  const height = Math.max(1, Math.round(Number(prop.size?.h) || 1));
  return normalizePropRotation(rot) % 2 === 1
    ? { w: height, h: width }
    : { w: width, h: height };
}

/** Palette for one variant; variant colours override only the keys they set. */
export function locationPropColors(type, variant = 0) {
  const prop = locationProp(type);
  if (!prop) return { base: '#8a8a8a', accent: '#b0b0b0', trim: '#5a5a5a' };
  const base = isRecord(prop.colors) ? prop.colors : {};
  const entry = Array.isArray(prop.variants)
    ? prop.variants[normalizePropVariant(prop, variant)]
    : null;
  const overrides = isRecord(entry?.colors) ? entry.colors : {};
  return {
    base: overrides.base || base.base || '#8a8a8a',
    accent: overrides.accent || base.accent || '#b0b0b0',
    trim: overrides.trim || base.trim || '#5a5a5a'
  };
}

export function propFootprintTiles({ type, x, y, rot = 0 } = {}) {
  const size = locationPropSize(type, rot);
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

export function propTiles(record) {
  return propFootprintTiles({
    type: record?.type,
    x: record?.x,
    y: record?.y,
    rot: record?.rot
  });
}

/** Solid footprints only; a pier or umbrella never blocks a step. */
export function locationBlockedTiles(props = []) {
  const blocked = new Set();
  for (const record of Array.isArray(props) ? props : []) {
    const prop = locationProp(record?.type);
    if (!prop?.solid) continue;
    for (const tile of propTiles(record)) blocked.add(propTileKey(tile));
  }
  return blocked;
}

/**
 * Validate one prop placement. `blocked` is any set/iterable of tile keys that
 * must stay clear (doors, spawn, other actors). `walkable` is an optional
 * predicate over a tile `{ x, y }` for terrain-dependent props.
 */
export function canPlaceLocationProp({
  props = [],
  type,
  x,
  y,
  rot = 0,
  blocked = null,
  walkable = null,
  ignore = null
} = {}) {
  const prop = locationProp(type);
  if (!prop) return { ok: false, reason: 'unknown-type', tiles: [] };
  const tiles = propFootprintTiles({ type, x, y, rot });
  if (!tiles.length) return { ok: false, reason: 'outside-world', tiles };
  if (tiles.some(tile => (
    tile.x < 0 || tile.x >= WORLD_SIZE || tile.y < 0 || tile.y >= WORLD_SIZE
  ))) {
    return { ok: false, reason: 'outside-world', tiles };
  }

  const reserved = blocked
    ? new Set(blocked instanceof Set ? blocked : [...blocked])
    : new Set();
  if (ignore && typeof ignore === 'object') {
    for (const tile of propTiles(ignore)) reserved.delete(propTileKey(tile));
  }
  if (tiles.some(tile => reserved.has(propTileKey(tile)))) {
    return { ok: false, reason: 'reserved', tiles };
  }

  const occupied = new Set();
  for (const record of Array.isArray(props) ? props : []) {
    if (record === ignore) continue;
    const other = locationProp(record?.type);
    if (!other?.solid) continue;
    for (const tile of propTiles(record)) occupied.add(propTileKey(tile));
  }
  if (prop.solid && tiles.some(tile => occupied.has(propTileKey(tile)))) {
    return { ok: false, reason: 'occupied', tiles };
  }

  if (typeof walkable === 'function' && !tiles.every(tile => walkable(tile))) {
    return { ok: false, reason: 'unwalkable', tiles };
  }

  return { ok: true, reason: null, tiles };
}

/** Saved/declared props normalised without trusting the data file or a save. */
export function normalizeLocationProps(entries) {
  if (!Array.isArray(entries)) return [];
  const records = [];
  const taken = new Set();
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const prop = locationProp(entry.type);
    if (!prop) continue;
    const x = Math.round(Number(entry.x));
    const y = Math.round(Number(entry.y));
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const rot = normalizePropRotation(entry.rot);
    const tiles = propFootprintTiles({ type: prop.id, x, y, rot });
    if (!tiles.length) continue;
    if (tiles.some(tile => (
      tile.x < 0 || tile.x >= WORLD_SIZE || tile.y < 0 || tile.y >= WORLD_SIZE
    ))) continue;
    const keys = tiles.map(propTileKey);
    if (prop.solid && keys.some(key => taken.has(key))) continue;
    for (const key of keys) taken.add(key);
    records.push({
      type: prop.id,
      x,
      y,
      rot,
      variant: normalizePropVariant(prop, entry.variant)
    });
  }
  return records;
}

/** Default renderer metadata: shape key, palette, footprint size, sort row. */
export function propRenderMeta(record) {
  const prop = locationProp(record?.type);
  const size = locationPropSize(record?.type, record?.rot);
  if (!prop || !size) return null;
  const x = Math.round(Number(record.x) || 0);
  const y = Math.round(Number(record.y) || 0);
  return {
    type: prop.id,
    label: prop.label || prop.id,
    shape: prop.shape || prop.id,
    solid: prop.solid === true,
    colors: locationPropColors(prop.id, record.variant),
    size,
    x,
    y,
    sortY: y + size.h - 1
  };
}
