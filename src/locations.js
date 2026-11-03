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
  generateCentralPark,
  generateTown,
  generateBeach,
  encodeTerrain,
  findOpenTile,
  isWalkable,
  typeAt
} from './world.js';
import { FORAGE_MUSHROOM_TYPES } from './forage.js';
import {
  buildingDoorEntries,
  linkBuildingDoors,
  normalizeWorldProps,
  seedWorldScenery
} from './world_edit.js';

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

/** Shells are opt-in: only locations that declare `shells: true` seed them. */
export function allowsShells(id) {
  return locationDef(id)?.shells === true;
}

/**
 * Destinations the player menu may offer from `fromId`. A disabled location is
 * absent here, which is how the flag keeps Home unreachable. Targets directly
 * reachable through a travel door are marked `nearby` and sorted first.
 */
export function travelTargets(fromId, { isEnabled = isLocationEnabled } = {}) {
  const nearby = nearbyTargetIds(fromId, { isEnabled });
  return Object.values(LOCATIONS)
    .filter(def => def && def.id !== fromId && isEnabled(def.id))
    .filter(def => def.menu && typeof def.menu.label === 'string' && def.menu.label)
    .map(def => ({
      id: def.id,
      label: def.menu.label,
      note: def.menu.note || '',
      mapLabel: def.mapLabel || `${def.label || def.id} map`,
      nearby: nearby.has(def.id)
    }))
    .sort((a, b) => Number(b.nearby) - Number(a.nearby));
}

/** Location ids one of this location's travel doors leads to. */
export function nearbyTargetIds(id, { isEnabled = isLocationEnabled } = {}) {
  const def = locationDef(id);
  const targets = new Set();
  for (const door of travelDoorEntries(def)) {
    if (isEnabled(door.to)) targets.add(door.to);
  }
  return targets;
}

/** Build the terrain for a location. Template dispatch keeps new themes out of `worldFor`. */
export function worldFor(id, seed, record = null) {
  const def = locationDef(id);
  const template = def?.template || (def?.house ? 'interior' : null);
  const builtSeed = seed ?? def?.seed;

  if (template === 'interior' || template === 'house') {
    const world = generateHome(builtSeed, def);
    // Rooms that opt out of forage never grow mushrooms either.
    return {
      ...world,
      template: 'interior',
      scenery: (world.scenery || []).filter(item => !FORAGE_MUSHROOM_TYPES.includes(item.type))
    };
  }
  // A save written before location layouts existed keeps its own grown world.
  // Generating the meadow gives that record scenery that matches its terrain
  // instead of Central Park trees dropped onto old ground.
  if (record && !layoutMatches(id, record)) {
    // A Town saved before the grid layout is regenerated rather than grown as
    // a meadow: its streets are the whole point, and the caller resets the
    // player to the new spawn. Every other stale record keeps the legacy
    // meadow fallback.
    if (template === 'town') return generateTown(builtSeed);
    return generateWorld(builtSeed);
  }
  if (template === 'central-park') return generateCentralPark(builtSeed);
  if (template === 'town') return generateTown(builtSeed);
  if (template === 'beach') return generateBeach(builtSeed);
  return generateWorld(builtSeed);
}

/**
 * The layout key a location's current definition builds. Fresh records store it
 * in `layout` so a save can tell which template its stored terrain came from.
 */
export function locationLayout(id) {
  const def = locationDef(id);
  if (!def) return null;
  // A location may version its template without renaming it; old records then
  // rebuild once. Town moved from a single street to a street grid this way.
  if (typeof def.layout === 'string' && def.layout) return def.layout;
  if (typeof def.template === 'string' && def.template) return def.template;
  if (def.house) return 'interior';
  return 'meadow';
}

/**
 * True when a saved record was built by the location's current layout. A record
 * without a marker predates layouts and is deliberately treated as legacy.
 */
export function layoutMatches(id, record) {
  if (!record || typeof record !== 'object') return true;
  return typeof record.layout === 'string' && record.layout === locationLayout(id);
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
 * Every raw travel entry a definition declares: the legacy single `door` first,
 * then `doors` entries with `kind: 'travel'`. Keeping the legacy form first
 * means `doorFor` still answers with the old door.
 */
function travelDoorEntries(def) {
  const entries = [];
  if (def?.door && typeof def.door.to === 'string' && def.door.to) entries.push(def.door);
  for (const extra of Array.isArray(def?.doors) ? def.doors : []) {
    if (extra && extra.kind === 'travel' && typeof extra.to === 'string' && extra.to) {
      entries.push(extra);
    }
  }
  return entries;
}

/**
 * Build every enabled travel door for a location (id or definition object).
 * Declared tiles that land in water, or on a tile another door already uses,
 * fall back to the nearest open tile near the spawn.
 */
export function travelDoorsFor(id, {
  terrain,
  spawn,
  isEnabled = isLocationEnabled,
  used = null
} = {}) {
  const def = typeof id === 'string' ? locationDef(id) : id;
  if (!def) return [];
  const taken = used instanceof Set ? used : new Set(used || []);
  const doors = [];
  for (const entry of travelDoorEntries(def)) {
    if (!isEnabled(entry.to)) continue;
    if (!locationDef(entry.to)) continue;
    const { x, y } = doorTile(def, entry, terrain, spawn, taken);
    taken.add(`${x},${y}`);
    doors.push({
      x,
      y,
      to: entry.to,
      kind: 'travel',
      id: entry.id || entry.to,
      prompt: entry.prompt || `Go to ${locationLabel(entry.to)}?`,
      confirm: entry.confirm || TRAVEL_CONFIRM,
      cancel: entry.cancel || TRAVEL_CANCEL
    });
  }
  return doors;
}

/**
 * The travel door the player can bump in `id`, or null when its destination is
 * off. A definition with several travel doors answers with the first enabled
 * one; `doorsFor` is the multi-door API.
 */
export function doorFor(id, options = {}) {
  return travelDoorsFor(id, options)[0] || null;
}

/**
 * Every bumpable door in `id`: all enabled travel doors plus any activity
 * entrances declared under `doors`. Activity doors carry `kind: 'activity'` and
 * an `activityId`; the shell starts a session instead of swapping locations.
 */
export function doorsFor(id, {
  terrain,
  spawn,
  isEnabled = isLocationEnabled,
  isActivity = isActivityEnabled
} = {}) {
  const def = locationDef(id);
  if (!def) return [];
  const used = new Set();
  const doors = travelDoorsFor(def, { terrain, spawn, isEnabled, used });

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

/**
 * Runtime triggers derived from building records. Each facade carries its own
 * `door` offset, so a swapped building's trigger sits on its new inner tile.
 */
export function buildingDoorsFor(props = [], { isEnabled = isLocationEnabled } = {}) {
  const doors = [];
  for (const entry of buildingDoorEntries(props)) {
    if (!isEnabled(entry.to)) continue;
    if (!locationDef(entry.to)) continue;
    doors.push({
      x: entry.x,
      y: entry.y,
      to: entry.to,
      kind: 'travel',
      id: entry.uid ? `building-${entry.uid}` : `building-${entry.x}-${entry.y}`,
      prompt: entry.prompt || `Go to ${locationLabel(entry.to)}?`,
      confirm: TRAVEL_CONFIRM,
      cancel: TRAVEL_CANCEL
    });
  }
  return doors;
}

/**
 * The complete door layer for one location. Declarative travel doors that land
 * inside a building footprint become that building's `door`; the rest stay put
 * (park gate, beach path, activity entrances). Building triggers are derived
 * from the prop list, so moving a facade moves its trigger with it.
 */
export function linkLocationDoors(id, {
  terrain,
  spawn,
  props = [],
  isEnabled = isLocationEnabled,
  isActivity = isActivityEnabled
} = {}) {
  const dataDoors = doorsFor(id, { terrain, spawn, isEnabled, isActivity });
  const travel = dataDoors.filter(door => door.kind !== 'activity');
  const activity = dataDoors.filter(door => door.kind === 'activity');
  const linked = linkBuildingDoors(props, travel);
  const fixedDoors = [...linked.doors, ...activity];
  return {
    props: linked.props,
    fixedDoors,
    doors: [...fixedDoors, ...buildingDoorsFor(linked.props, { isEnabled })]
  };
}

/** Fixed residents declared by a location, in stable data order. */
export function residentsFor(id) {
  const def = locationDef(id);
  if (!Array.isArray(def?.residents)) return [];
  const spawn = def?.spawn || { x: 32, y: 32 };
  const seen = new Set();
  const residents = [];
  for (const resident of def.residents) {
    if (!resident || typeof resident !== 'object') continue;
    const residentId = typeof resident.id === 'string' ? resident.id : '';
    if (!residentId || seen.has(residentId)) continue;
    seen.add(residentId);
    const x = Number.isFinite(Number(resident.x)) ? Math.round(Number(resident.x)) : spawn.x;
    const y = Number.isFinite(Number(resident.y)) ? Math.round(Number(resident.y)) : spawn.y;
    const look = resident.look && typeof resident.look === 'object' && !Array.isArray(resident.look)
      ? resident.look
      : {};
    residents.push({
      id: residentId,
      name: resident.name || residentId,
      recipe: { seed: resident.seed || residentId, look },
      x,
      y,
      direction: Number.isFinite(Number(resident.direction)) ? Number(resident.direction) : 0,
      ...(typeof resident.role === 'string' && resident.role ? { role: resident.role } : {}),
      resident: true
    });
  }
  return residents;
}

/**
 * The prop list for a location. A saved list is authoritative — even when it is
 * empty — so a moved or removed object survives a reload. A record without one
 * (and every legacy record, which has no `props` key) seeds from `data`.
 */
export function propsForLocation(id, record = null) {
  if (!layoutMatches(id, record)) return [];
  if (Array.isArray(record?.props)) return normalizeWorldProps(record.props);
  return normalizeWorldProps(locationDef(id)?.props);
}

/**
 * The scenery list for a location. Saved scenery wins; otherwise the generated
 * nature scatter seeds it once. Legacy records keep the generated list so an
 * old save looks exactly as it did before scenery was persisted.
 */
export function sceneryForLocation(id, record = null, generated = []) {
  if (!layoutMatches(id, record)) return seedWorldScenery(generated);
  if (Array.isArray(record?.scenery)) return seedWorldScenery(record.scenery);
  return seedWorldScenery(generated);
}

/** Optional per-location tile colour overrides. Legacy records keep defaults. */
export function locationTheme(id, record = null) {
  if (!layoutMatches(id, record)) return null;
  const theme = locationDef(id)?.theme;
  return theme && typeof theme === 'object' && !Array.isArray(theme) ? theme : null;
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
 * `storage` holds bought furniture that is owned but not yet placed.
 */
export function createHomeLocation({ seed = locationDef('home')?.seed, basket = null } = {}) {
  const world = worldFor('home', seed);
  return {
    seed,
    layout: 'interior',
    terrain: encodeTerrain(world.grid),
    player: { x: world.spawn.x, y: world.spawn.y, direction: 0 },
    npcs: [],
    storage: [],
    forage: emptyForage(basket)
  };
}

/**
 * A fresh location record. Home and Shop keep their bespoke builders; every
 * other location uses its template with an empty resident-free record.
 */
export function createLocationRecord(id, { basket = null } = {}) {
  const def = locationDef(id);
  if (!def) return null;
  if (id === 'home') return createHomeLocation({ basket });
  if (id === 'shop') return createShopLocation({ basket });
  const seed = def.seed || `${id}-01`;
  const world = worldFor(id, seed);
  return {
    seed,
    layout: world.layout || locationLayout(id),
    terrain: encodeTerrain(world.grid),
    player: { x: world.spawn.x, y: world.spawn.y, direction: 0 },
    npcs: [],
    // Outdoor locations seed their own apple crop on first arrival.
    forage: emptyForage(basket, { seeded: !allowsForage(id) })
  };
}

function emptyForage(basket = null, { seeded = true } = {}) {
  return {
    apples: [],
    shells: [],
    basket: {
      apple: Math.max(0, Math.floor(Number(basket?.apple) || 0)),
      mushroom: Math.max(0, Math.floor(Number(basket?.mushroom) || 0)),
      shell: Math.max(0, Math.floor(Number(basket?.shell) || 0))
    },
    harvested: {},
    nextAppleAt: 0,
    nextShellAt: 0,
    seeded
  };
}

/** The shopkeeper id is data, with a stable fallback for older world files. */
export const SHOPKEEPER_ID = locationDef('shop')?.shopkeeper?.id || 'shopkeeper';

/**
 * A fresh Shop record: the same interior builder as Home, plus one fixed
 * shopkeeper. The keeper is a plain NPC record, not a behaviour actor, so the
 * Park's wander runtime never claims him.
 */
export function createShopLocation({ basket = null } = {}) {
  const def = locationDef('shop');
  const world = worldFor('shop', def?.seed);
  const keeper = def?.shopkeeper || {};
  const hasKeeper = Number.isInteger(keeper.x) && Number.isInteger(keeper.y);
  return {
    seed: def?.seed,
    layout: 'interior',
    terrain: encodeTerrain(world.grid),
    player: { x: world.spawn.x, y: world.spawn.y, direction: 0 },
    npcs: hasKeeper
      ? [{
          id: keeper.id || SHOPKEEPER_ID,
          name: keeper.name || 'Shopkeeper',
          recipe: { seed: keeper.seed || 'shopkeeper', look: keeper.look || {} },
          x: keeper.x,
          y: keeper.y,
          direction: Number.isFinite(Number(keeper.direction)) ? Number(keeper.direction) : 0,
          inventory: [],
          equipped: [],
          coins: 0,
          stabledCompanions: []
        }]
      : [],
    forage: emptyForage(basket)
  };
}
