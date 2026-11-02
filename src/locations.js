/**
 * Location definitions and pure travel helpers.
 *
 * `data/world.json` is the single source of truth for location ids, labels,
 * seeds, spawn tiles, door tiles, and the Home feature flag. Nothing here reads
 * the DOM, so the gating and arrival rules can be tested in Node.
 */
import worldData from '../data/world.json' with { type: 'json' };
import activitiesData from '../data/activities.json' with { type: 'json' };
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
 * Activity entrances are opt-in per location and per activity: a door whose
 * activity is disabled is not built at all, so production never shows an
 * entrance that cannot start anything.
 */
export function isActivityEnabled(id, data = activitiesData.activities || {}) {
  return Boolean(id && data?.[id]?.enabled === true);
}

/** Snap a declared door tile onto walkable ground, near the spawn. */
function doorTile(def, door, terrain, spawn, occupied = new Set()) {
  const origin = spawn || def.spawn || { x: 32, y: 32 };
  const taken = new Set(occupied);
  taken.add(`${origin.x},${origin.y}`);
  const x = Number(door.x);
  const y = Number(door.y);
  if (Number.isFinite(x) && Number.isFinite(y) && isWalkable(typeAt(terrain, x, y)) && !taken.has(`${x},${y}`)) {
    return { x, y };
  }
  const open = findOpenTile(terrain, origin, taken, 2);
  return { x: open.x, y: open.y };
}

/**
 * The travel door the player can bump in `id`, or null when its destination is
 * off. Park terrain is generated from a seed, so a declared door tile that
 * landed in water falls back to the nearest open tile instead of stranding the
 * player.
 */
export function doorFor(id, { terrain, spawn, isEnabled = isLocationEnabled } = {}) {
  const def = locationDef(id);
  const door = def?.door;
  if (!door || !isEnabled(door.to)) return null;
  const target = locationDef(door.to);
  if (!target) return null;

  const { x, y } = doorTile(def, door, terrain, spawn);
  return {
    x,
    y,
    to: door.to,
    prompt: door.prompt || `Go to ${locationLabel(door.to)}?`,
    confirm: TRAVEL_CONFIRM,
    cancel: TRAVEL_CANCEL
  };
}

/**
 * Every bumpable door in `id`: the travel door plus any activity entrances
 * declared under `doors`. Activity doors carry `kind: 'activity'` and an
 * `activityId`; the shell starts a session instead of swapping locations.
 */
export function doorsFor(id, {
  terrain,
  spawn,
  isEnabled = isLocationEnabled,
  isActivity = isActivityEnabled
} = {}) {
  const def = locationDef(id);
  if (!def) return [];
  const doors = [];
  const used = new Set();
  const travel = doorFor(id, { terrain, spawn, isEnabled });
  if (travel) {
    doors.push({ ...travel, kind: 'travel', id: travel.to });
    used.add(`${travel.x},${travel.y}`);
  }

  for (const extra of Array.isArray(def.doors) ? def.doors : []) {
    if (!extra || extra.kind !== 'activity') continue;
    if (!isActivity(extra.activityId)) continue;
    const { x, y } = doorTile(def, extra, terrain, spawn, used);
    used.add(`${x},${y}`);
    doors.push({
      x,
      y,
      kind: 'activity',
      id: extra.id || extra.activityId,
      activityId: extra.activityId,
      prompt: extra.prompt || `Try the ${extra.activityId}?`,
      confirm: extra.confirm || 'Go',
      cancel: TRAVEL_CANCEL
    });
  }

  return doors;
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
