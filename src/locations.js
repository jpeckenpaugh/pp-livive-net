/**
 * Location definitions and pure travel helpers.
 *
 * `data/world.json` is the single source of truth for location ids, labels,
 * seeds, spawn tiles, door tiles, and the Home feature flag. Nothing here reads
 * the DOM, so the gating and arrival rules can be tested in Node.
 */
import worldData from '../data/world.json' with { type: 'json' };
import {
  generateWorld,
  generateHome,
  encodeTerrain,
  findOpenTile,
  isWalkable,
  typeAt
} from './world.js';
import { FORAGE_MUSHROOM_TYPES } from './forage.js';

export const WORLD_CONFIG = worldData;
export const LOCATIONS = worldData.locations || {};
export const DEFAULT_LOCATION = 'park';
export const TRAVEL_CONFIRM = worldData.travel?.confirm || 'Travel';
export const TRAVEL_CANCEL = worldData.travel?.cancel || 'Cancel';

export function locationDef(id) {
  return LOCATIONS[id] || null;
}

export function locationLabel(id) {
  return locationDef(id)?.label || id;
}

/**
 * Park is always available; every other location needs an explicit
 * `enabled: true`. A missing definition is never travelable.
 */
export function isLocationEnabled(id) {
  const def = locationDef(id);
  if (!def) return false;
  if (id === DEFAULT_LOCATION) return def.enabled !== false;
  return def.enabled === true;
}

/** Home is the only location that opts out of apples and mushrooms. */
export function allowsForage(id) {
  return locationDef(id)?.forage !== false;
}

/**
 * Destinations the player menu may offer from `fromId`. A disabled location is
 * absent here, which is how the flag keeps Home unreachable.
 */
export function travelTargets(fromId, { isEnabled = isLocationEnabled } = {}) {
  return Object.values(LOCATIONS)
    .filter(def => def && def.id !== fromId && isEnabled(def.id))
    .filter(def => def.menu && typeof def.menu.label === 'string' && def.menu.label)
    .map(def => ({
      id: def.id,
      label: def.menu.label,
      note: def.menu.note || '',
      mapLabel: def.mapLabel || `${def.label || def.id} map`
    }));
}

/** Build the terrain for a location. Home also drops mushrooms (no harvest). */
export function worldFor(id, seed) {
  if (id === 'home') {
    const world = generateHome(seed);
    return {
      ...world,
      scenery: (world.scenery || []).filter(item => !FORAGE_MUSHROOM_TYPES.includes(item.type))
    };
  }
  return generateWorld(seed);
}

/**
 * The door the player can bump in `id`, or null when its destination is off.
 * Park terrain is generated from a seed, so a declared door tile that landed in
 * water falls back to the nearest open tile instead of stranding the player.
 */
export function doorFor(id, { terrain, spawn, isEnabled = isLocationEnabled } = {}) {
  const def = locationDef(id);
  const door = def?.door;
  if (!door || !isEnabled(door.to)) return null;
  const target = locationDef(door.to);
  if (!target) return null;

  let x = Number(door.x);
  let y = Number(door.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    const origin = spawn || def.spawn || { x: 32, y: 32 };
    const open = findOpenTile(terrain, origin, new Set([`${origin.x},${origin.y}`]), 2);
    x = open.x;
    y = open.y;
  } else if (!isWalkable(typeAt(terrain, x, y))) {
    const origin = spawn || def.spawn || { x: 32, y: 32 };
    const open = findOpenTile(terrain, origin, new Set([`${origin.x},${origin.y}`]), 2);
    x = open.x;
    y = open.y;
  }

  return {
    x,
    y,
    to: door.to,
    prompt: door.prompt || `Go to ${locationLabel(door.to)}?`,
    confirm: TRAVEL_CONFIRM,
    cancel: TRAVEL_CANCEL
  };
}

/** Last known position in a location, falling back to its declared spawn. */
export function arrivalTile(id, record) {
  const def = locationDef(id);
  const spawn = def?.spawn || { x: 32, y: 32 };
  const saved = record?.player;
  const direction = Number.isFinite(Number(saved?.direction)) ? Number(saved.direction) : 0;
  if (saved && Number.isFinite(Number(saved.x)) && Number.isFinite(Number(saved.y))) {
    return { x: Math.round(Number(saved.x)), y: Math.round(Number(saved.y)), direction };
  }
  return { x: spawn.x, y: spawn.y, direction };
}

/**
 * A fresh Home location record. Forage is deliberately seeded and empty: Home
 * never grows or collects apples, and the player's basket travels with them.
 */
export function createHomeLocation({ seed = locationDef('home')?.seed, basket = null } = {}) {
  const world = worldFor('home', seed);
  return {
    seed,
    terrain: encodeTerrain(world.grid),
    player: { x: world.spawn.x, y: world.spawn.y, direction: 0 },
    npcs: [],
    decor: [],
    forage: {
      apples: [],
      basket: {
        apple: Math.max(0, Math.floor(Number(basket?.apple) || 0)),
        mushroom: Math.max(0, Math.floor(Number(basket?.mushroom) || 0))
      },
      harvested: {},
      nextAppleAt: 0,
      seeded: true
    }
  };
}
