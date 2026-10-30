import { decodeTerrain, encodeTerrain } from './world.js';
import { normalizeInventory, createItemInstance } from './inventory.js';
import { normalizeForage } from './forage.js';

export const STORAGE_KEY = 'playpark.save.v1';
export const STATS_KEY = 'playpark.stats.v1';
export const SAVE_VERSION = 2;

// New parks receive these in data/items.json. Grant them once to pre-v2 saves
// so existing testers can see the headline effects without using Debug.
const V1_STARTER_EFFECTS = ['big-o-bracelet', 'chamo-clip', 'teleport-tricorder'];

// Starter games and gear added after a save was created should still appear in
// that player's bag. Idempotent: matching ids are skipped.
const EXTRA_STARTER_ITEMS = ['memory-grid', 'connect-four', 'wings'];

// Fields that belong to a live frame (paths, staging, fetch AI, timers) and must
// never leak into a save. Profit: reloads start with clean, deterministic actors.
const TRANSIENT_CHARACTER_KEYS = [
  'path',
  'stagedDestination',
  'miniGameTarget',
  'fetchTarget',
  'carryingBall',
  'cheerTimer',
  'cheerElapsed',
  'cheerPhase',
  'cheerRate',
  'cheerHeight',
  'cheerTurnTimer',
  'cheerReturnDirection',
  'blockedWait',
  'elapsed',
  'moving',
  'fromX',
  'fromY',
  'toX',
  'toY',
  'fx',
  'effectGhosts',
  'inMiniGame',
  'inDialogue'
];

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stripTransient(record) {
  if (!isObject(record)) return {};
  const copy = { ...record };
  for (const key of TRANSIENT_CHARACTER_KEYS) delete copy[key];
  return copy;
}

/**
 * Normalise equipped entries to the persistent subset. Transition clocks
 * (`since`/`until`) and live ghost entries are deliberately dropped so a
 * reloaded effect starts fully active instead of replaying a stale animation.
 */
export function normalizeEquipped(entries) {
  if (!Array.isArray(entries)) return [];
  const seen = new Set();
  const result = [];
  for (const entry of entries) {
    let next = null;
    if (typeof entry === 'string' && entry) {
      next = { uid: entry };
    } else if (isObject(entry)) {
      const uid = (typeof entry.uid === 'string' && entry.uid)
        || (typeof entry.itemId === 'string' && entry.itemId)
        || null;
      if (!uid) continue;
      next = { uid };
      if (typeof entry.slot === 'string' && entry.slot) next.slot = entry.slot;
      if (typeof entry.itemId === 'string' && entry.itemId) next.itemId = entry.itemId;
      if (typeof entry.effectId === 'string' && entry.effectId) next.effectId = entry.effectId;
    }
    if (!next || seen.has(next.uid)) continue;
    seen.add(next.uid);
    result.push(next);
  }
  return result;
}

function emptyBehaviorBlock() {
  return {
    version: 1,
    relations: { version: 1, pairs: [] },
    cooldowns: { version: 1, entries: [] },
    counters: {}
  };
}

function normalizeRelations(source) {
  const pairsSource = Array.isArray(source) ? source : source?.pairs;
  const pairs = Array.isArray(pairsSource)
    ? pairsSource
      .filter(entry => entry && typeof entry.key === 'string' && entry.key)
      .map(entry => ({
        key: entry.key,
        a: entry.a ?? null,
        b: entry.b ?? null,
        greets: Math.max(0, Math.floor(Number(entry.greets) || 0)),
        activities: Math.max(0, Math.floor(Number(entry.activities) || 0)),
        friends: entry.friends === true
      }))
    : [];
  return { version: 1, pairs };
}

function normalizeCooldowns(source) {
  const entriesSource = Array.isArray(source) ? source : source?.entries;
  const entries = Array.isArray(entriesSource)
    ? entriesSource
      .filter(entry => entry && ['actor', 'pair', 'global'].includes(entry.scope)
        && entry.key != null && Number.isFinite(entry.readyAt))
      .map(entry => ({ scope: entry.scope, key: entry.key, readyAt: entry.readyAt }))
    : [];
  return { version: 1, entries };
}

function normalizeCounters(source) {
  if (!isObject(source)) return {};
  const counters = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'number' && Number.isFinite(value)) counters[key] = value;
    else if (typeof value === 'string' || typeof value === 'boolean') counters[key] = value;
  }
  return counters;
}

/**
 * Serialise the persistent slice of behavior state: NPC pair relations, active
 * (unexpired) cooldowns, and any diagnostic counters. Accepts either a plain
 * `{ relations, cooldowns, counters }` object or a live BehaviorRuntime, from
 * which relations/cooldowns are read through their own serializers.
 */
export function normalizeBehaviorBlock(input) {
  const empty = emptyBehaviorBlock();
  if (!input) return empty;

  let source = input;
  if (typeof input.serialize === 'function') {
    try {
      source = input.serialize() || {};
    } catch {
      source = {};
    }
  }
  if (!isObject(source)) return empty;

  const relationsSource = source.relations
    ?? source.pairs
    ?? (typeof input.blackboard?.serializeRelations === 'function'
      ? input.blackboard.serializeRelations()
      : null);
  const cooldownsSource = (typeof input.cooldowns?.serialize === 'function'
    ? input.cooldowns.serialize(input.now ?? 0)
    : null)
    ?? source.cooldowns
    ?? source.entries;

  return {
    version: 1,
    relations: normalizeRelations(relationsSource),
    cooldowns: normalizeCooldowns(cooldownsSource),
    counters: normalizeCounters(source.counters ?? input.counters)
  };
}

function serializeCharacterGear(record) {
  if (!isObject(record)) return { inventory: [], equipped: [] };
  return {
    inventory: normalizeInventory(record.inventory),
    equipped: normalizeEquipped(record.equipped)
  };
}

/** Persist reserve companions with their gear, dropping live frame state. */
function serializeReserveCompanions(companions) {
  if (!Array.isArray(companions)) return [];
  return companions
    .filter(isObject)
    .map(comp => ({
      ...stripTransient(comp),
      ...serializeCharacterGear(comp)
    }));
}

/**
 * Build a v2 save. `behaviorState` is optional and may be a plain object or a
 * BehaviorRuntime; live FSM entries, paths, staging, and host sessions are
 * never persisted.
 */
export function serializeSave(game, draft, friends, behaviorState = null) {
  if (!game?.terrain || !game.player || !draft) return null;
  const playerGear = serializeCharacterGear(game.player);
  const stabledCompanions = serializeReserveCompanions(game.player.stabledCompanions);

  return {
    version: SAVE_VERSION,
    savedAt: new Date().toISOString(),
    worldSeed: game.worldSeed,
    terrain: encodeTerrain(game.terrain),
    playerName: game.player.name,
    playerRecipe: game.player.recipe,
    player: {
      x: game.player.x,
      y: game.player.y,
      direction: game.player.direction,
      inventory: playerGear.inventory,
      coins: Number.isFinite(game.player.coins) ? game.player.coins : 0,
      equipped: playerGear.equipped,
      stabledCompanions
    },
    npcs: game.npcs.map(npc => ({
      id: npc.id,
      name: npc.name,
      recipe: npc.recipe,
      vibe: npc.vibe,
      x: npc.x,
      y: npc.y,
      direction: npc.direction,
      ...serializeCharacterGear(npc),
      coins: Number.isFinite(npc.coins) ? npc.coins : 0,
      stabledCompanions: serializeReserveCompanions(npc.stabledCompanions)
    })),
    companions: (game.companions || []).map(comp => ({
      id: comp.id,
      name: comp.name,
      buddyId: comp.buddyId,
      recipe: comp.recipe,
      x: comp.x,
      y: comp.y,
      direction: comp.direction,
      ...serializeCharacterGear(comp)
    })),
    friends: [...friends],
    wander: game.wander,
    forage: normalizeForage(game.forage),
    behavior: normalizeBehaviorBlock(behaviorState)
  };
}

function migrateCharacterRecord(record) {
  if (!isObject(record)) return record;
  const next = { ...record };
  const gear = serializeCharacterGear(record);
  next.inventory = gear.inventory;
  next.equipped = gear.equipped;
  return next;
}

/**
 * NPCs gain ownership fields in Phase 2. Old v2 saves (and v1 migrations)
 * default to zero coins and an empty reserve without bumping the version.
 */
function migrateNpcRecord(record) {
  const next = migrateCharacterRecord(record);
  if (!isObject(next)) return next;
  next.coins = Number.isFinite(next.coins) ? next.coins : 0;
  next.stabledCompanions = Array.isArray(next.stabledCompanions)
    ? next.stabledCompanions
      .filter(isObject)
      .map(comp => migrateCharacterRecord(stripTransient(comp)))
    : [];
  return next;
}

/**
 * Upgrade a v1 save (or clean a v2 save) to the current schema. Returns null
 * for malformed input and for future versions so callers can fall back to a
 * fresh park without risking data corruption.
 */
export function migrateSave(state) {
  if (!isObject(state)) return null;
  const version = Number(state.version);
  if (version !== 1 && version !== SAVE_VERSION) return null;

  const next = { ...state, version: SAVE_VERSION };

  if (isObject(state.player)) {
    const player = migrateCharacterRecord(state.player);
    player.stabledCompanions = Array.isArray(state.player.stabledCompanions)
      ? state.player.stabledCompanions
        .filter(isObject)
        .map(comp => migrateCharacterRecord(stripTransient(comp)))
      : [];
    if (version === 1) {
      const owned = new Set(player.inventory.map(item => item.id));
      for (const id of V1_STARTER_EFFECTS) {
        if (owned.has(id)) continue;
        const item = createItemInstance(id);
        if (item) player.inventory.push(item);
      }
    }
    const ownedGames = new Set(player.inventory.map(item => item.id));
    for (const id of EXTRA_STARTER_ITEMS) {
      if (ownedGames.has(id)) continue;
      const item = createItemInstance(id);
      if (item) player.inventory.push(item);
    }
    next.player = player;
  }

  next.npcs = Array.isArray(state.npcs)
    ? state.npcs.filter(isObject).map(migrateNpcRecord)
    : [];
  next.companions = Array.isArray(state.companions)
    ? state.companions.filter(isObject).map(comp => migrateCharacterRecord(stripTransient(comp)))
    : [];
  next.friends = Array.isArray(state.friends) ? state.friends.filter(id => typeof id === 'string') : [];
  next.forage = normalizeForage(state.forage);
  next.behavior = normalizeBehaviorBlock(state.behavior);

  return next;
}

export function saveState(state) {
  if (!state) return false;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch {
    // Saving is a convenience; the playground still works without it.
    return false;
  }
}

export function loadSave() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const state = migrateSave(JSON.parse(raw));
    if (!state || !state.playerRecipe || !decodeTerrain(state.terrain)) return null;
    return state;
  } catch {
    return null;
  }
}

export function clearSave() {
  try {
    localStorage.removeItem(STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

export function loadStats() {
  try {
    const raw = localStorage.getItem(STATS_KEY);
    if (!raw) {
      return {
        totalWins: 0,
        totalLosses: 0,
        totalDraws: 0,
        friends: {}
      };
    }
    const data = JSON.parse(raw);
    return {
      totalWins: Number(data.totalWins) || 0,
      totalLosses: Number(data.totalLosses) || 0,
      totalDraws: Number(data.totalDraws) || 0,
      friends: data.friends && typeof data.friends === 'object' ? data.friends : {}
    };
  } catch {
    return { totalWins: 0, totalLosses: 0, totalDraws: 0, friends: {} };
  }
}

export function recordGameResult({ opponentId, opponentName, result }) {
  const stats = loadStats();
  if (result === 'win') stats.totalWins++;
  else if (result === 'loss') stats.totalLosses++;
  else if (result === 'draw') stats.totalDraws++;

  if (opponentId) {
    if (!stats.friends[opponentId]) {
      stats.friends[opponentId] = {
        name: opponentName || 'Neighbour',
        wins: 0,
        losses: 0,
        draws: 0
      };
    }
    if (opponentName) stats.friends[opponentId].name = opponentName;
    if (result === 'win') stats.friends[opponentId].wins++;
    else if (result === 'loss') stats.friends[opponentId].losses++;
    else if (result === 'draw') stats.friends[opponentId].draws++;
  }

  try {
    localStorage.setItem(STATS_KEY, JSON.stringify(stats));
  } catch {
    // Ignore storage errors
  }
  return stats;
}
