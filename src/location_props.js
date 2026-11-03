/**
 * Pure prop logic for non-Home locations: one catalog lookup shared with the
 * Home furniture set, rotated footprints, blocked tiles, seeded detail,
 * placement validation, and the metadata the renderer needs to draw a record.
 *
 * Props live in `data/location_props.json`; a location opts in with a `props`
 * array in `data/world.json`. A record may name either a location prop or a
 * Home item id. Nothing here reads the DOM, so collision and placement can be
 * tested in Node.
 */
import propsData from '../data/location_props.json' with { type: 'json' };
import { homeItem } from './home_items.js';
import { WORLD_SIZE, hashString } from './world.js';

export const LOCATION_PROP_TYPES = propsData.types || {};
export const LOCATION_PROP_IDS = Object.keys(LOCATION_PROP_TYPES);

const PROP_BY_ID = new Map(LOCATION_PROP_IDS.map(id => [id, LOCATION_PROP_TYPES[id]]));

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function propTileKey(tile) {
  return `${tile?.x},${tile?.y}`;
}

/** Location props win over Home items, so the two shared ids keep outdoor art. */
export function locationProp(id) {
  return PROP_BY_ID.get(id) || null;
}

/**
 * One catalog lookup for both scopes: outdoor/interior props first, then the
 * Home furniture catalog. Records can therefore say `{ "type": "couch" }` in a
 * location and inherit the Home item's size, solid flag, palette, and shape.
 */
export function propDefinition(id) {
  return locationProp(id) || homeItem(id) || null;
}

export function propSource(id) {
  if (locationProp(id)) return 'location';
  if (homeItem(id)) return 'home';
  return null;
}

export function locationPropLabel(id) {
  return propDefinition(id)?.label || id;
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

/** Soft furnishings take a seeded cushion/throw pattern and trim tone. */
export const SOFT_PROP_SHAPES = ['couch', 'armchair', 'bed', 'rug', 'chair'];
export const PROP_PATTERNS = ['plain', 'stripes', 'checks', 'dots'];
export const PROP_SIGN_STYLES = ['plaque', 'board', 'painted'];

const PATTERN_COLORS = ['#f2e2bd', '#e8b06a', '#a8c4a0', '#d98c7a', '#9db6bd'];
const TRIM_TONES = ['#4a5840', '#6b4a33', '#575f6b', '#7d5a3c', '#3f4b46'];

export function normalizePropSeed(seed) {
  return typeof seed === 'string' ? seed.trim().slice(0, 48) : '';
}

/**
 * Deterministic detail for one placed prop. A declared seed wins; otherwise the
 * type and tile make a stable fallback, so a reload never reshuffles a cushion.
 * Soft shapes get a pattern, pattern colour, and trim tone; a labelled prop
 * gets a sign style.
 */
export function propDetail(record) {
  const prop = propDefinition(record?.type);
  if (!prop) return null;
  const x = Math.round(Number(record?.x) || 0);
  const y = Math.round(Number(record?.y) || 0);
  const seed = normalizePropSeed(record?.seed) || `${prop.id}:${x},${y}`;
  const shape = prop.shape || prop.id;
  const soft = SOFT_PROP_SHAPES.includes(shape);
  const labelled = typeof record?.label === 'string' && record.label.trim().length > 0;
  const pick = channel => hashString(`${seed}:${channel}`);

  return {
    seed,
    pattern: soft ? PROP_PATTERNS[pick('pattern') % PROP_PATTERNS.length] : null,
    patternColor: soft ? PATTERN_COLORS[pick('tone') % PATTERN_COLORS.length] : null,
    trim: soft ? TRIM_TONES[pick('trim') % TRIM_TONES.length] : null,
    sign: labelled ? PROP_SIGN_STYLES[pick('sign') % PROP_SIGN_STYLES.length] : null
  };
}

/** Rotated size; odd quarter turns swap width and height. */
export function locationPropSize(type, rot = 0) {
  const prop = propDefinition(type);
  if (!prop) return null;
  const width = Math.max(1, Math.round(Number(prop.size?.w) || 1));
  const height = Math.max(1, Math.round(Number(prop.size?.h) || 1));
  return normalizePropRotation(rot) % 2 === 1
    ? { w: height, h: width }
    : { w: width, h: height };
}

/** Palette for one variant; variant colours override only the keys they set. */
export function locationPropColors(type, variant = 0) {
  const prop = propDefinition(type);
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

/**
 * Walkable cut-outs inside a solid footprint, expressed as offsets from the
 * prop origin in its placed (post-rotation) orientation. A building declares a
 * 1×2 doorway so the player can step inside; the trigger tile itself is an
 * opening, not pavement outside the facade.
 */
export function propOpenings(record) {
  const size = locationPropSize(record?.type, record?.rot);
  if (!size) return [];
  const seen = new Set();
  const openings = [];
  for (const entry of Array.isArray(record?.openings) ? record.openings : []) {
    const dx = Math.round(Number(entry?.dx));
    const dy = Math.round(Number(entry?.dy));
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) continue;
    if (dx < 0 || dx >= size.w || dy < 0 || dy >= size.h) continue;
    const key = `${dx},${dy}`;
    if (seen.has(key)) continue;
    seen.add(key);
    openings.push({ dx, dy });
  }
  return openings;
}

/** Solid footprints only; a pier or umbrella never blocks a step. */
export function locationBlockedTiles(props = []) {
  const blocked = new Set();
  for (const record of Array.isArray(props) ? props : []) {
    const prop = propDefinition(record?.type);
    if (!prop?.solid) continue;
    const openings = new Set(propOpenings(record).map(opening => `${opening.dx},${opening.dy}`));
    for (const tile of propTiles(record)) {
      const offset = `${tile.x - Math.round(Number(record.x))},${tile.y - Math.round(Number(record.y))}`;
      if (openings.has(offset)) continue;
      blocked.add(propTileKey(tile));
    }
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
  const prop = propDefinition(type);
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
    const other = propDefinition(record?.type);
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
    const prop = propDefinition(entry.type);
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
    // Ground cover never reserves a tile; only solid footprints block each other.
    if (prop.solid) {
      if (keys.some(key => taken.has(key))) continue;
      for (const key of keys) taken.add(key);
    }
    const openings = propOpenings({ type: prop.id, x, y, rot, openings: entry.openings });
    const label = typeof entry.label === 'string' && entry.label.trim()
      ? entry.label.trim().slice(0, 24)
      : '';
    const seed = normalizePropSeed(entry.seed || entry.detailSeed);
    records.push({
      type: prop.id,
      x,
      y,
      rot,
      variant: normalizePropVariant(prop, entry.variant),
      ...(label ? { label } : {}),
      ...(seed ? { seed } : {}),
      ...(openings.length ? { openings } : {})
    });
  }
  return records;
}

/** Default renderer metadata: shape key, palette, footprint size, sort row. */
export function propRenderMeta(record) {
  const prop = propDefinition(record?.type);
  const size = locationPropSize(record?.type, record?.rot);
  if (!prop || !size) return null;
  const x = Math.round(Number(record.x) || 0);
  const y = Math.round(Number(record.y) || 0);
  const source = propSource(prop.id);
  const detail = propDetail(record);
  const colors = locationPropColors(prop.id, record.variant);
  return {
    type: prop.id,
    source,
    label: typeof record?.label === 'string' && record.label ? record.label : (prop.label || prop.id),
    shape: prop.shape || prop.id,
    solid: prop.solid === true,
    // A seeded trim tone recolours the finish without claiming a new variant.
    colors: detail?.trim ? { ...colors, trim: detail.trim } : colors,
    detail,
    size,
    x,
    y,
    openings: propOpenings(record),
    sortY: y + size.h - 1
  };
}
