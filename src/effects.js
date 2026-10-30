import effectsConfig from '../data/effects.json' with { type: 'json' };
import {
  createItemInstance,
  ensureItemUid,
  getItemDefinition,
  getItemInstance
} from './inventory.js';

export const EFFECTS_SCHEMA_VERSION = effectsConfig.schemaVersion;
export const EFFECT_SLOTS = effectsConfig.slots;
export const EFFECT_CATALOG = effectsConfig.effects;
export const EFFECT_MOTIONS = effectsConfig.motions;
export const EFFECT_COMPOSITION = effectsConfig.composition;
export const EFFECT_TRANSITIONS = effectsConfig.transitions;

const DEFAULT_TRANSITION = { equipMs: 220, unequipMs: 180, easing: 'ease-out' };
const DEFAULT_SLOT_CAPACITY = 1;
const EPSILON = 1e-6;
const MAX_GHOSTS = 16;

// item id -> effect id, derived from data so no effect ids are hardcoded here.
const ITEM_EFFECT_IDS = Object.values(EFFECT_CATALOG).reduce((map, effect) => {
  if (effect && typeof effect.itemId === 'string' && effect.itemId) {
    map[effect.itemId] = effect.id;
  }
  return map;
}, Object.create(null));

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function num(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function round(value) {
  return Math.round(value * 10000) / 10000;
}

export function getEffect(effectId) {
  if (typeof effectId !== 'string' || !effectId) return null;
  return EFFECT_CATALOG[effectId] || null;
}

/**
 * Resolve the effect id for an item id, item instance, or effect id. Unknown
 * values return null; declared-but-unknown effect ids are returned so callers
 * can report a useful failure reason.
 */
export function getItemEffectId(itemOrId) {
  if (typeof itemOrId === 'string' && itemOrId) {
    if (EFFECT_CATALOG[itemOrId]) return itemOrId;
    if (ITEM_EFFECT_IDS[itemOrId]) return ITEM_EFFECT_IDS[itemOrId];
    const definition = getItemDefinition(itemOrId);
    if (definition && typeof definition.effect === 'string' && definition.effect) {
      return definition.effect;
    }
    return null;
  }

  if (!isObject(itemOrId)) return null;

  const declared = itemOrId.effectId || itemOrId.effect;
  if (typeof declared === 'string' && declared) return declared;

  const id = itemOrId.id;
  if (typeof id !== 'string' || !id) return null;
  if (EFFECT_CATALOG[id]) return id;
  if (ITEM_EFFECT_IDS[id]) return ITEM_EFFECT_IDS[id];

  const definition = getItemDefinition(id);
  if (definition && typeof definition.effect === 'string' && definition.effect) {
    return definition.effect;
  }
  return null;
}

export function getEffectForItem(itemOrId) {
  return getEffect(getItemEffectId(itemOrId));
}

export function getSlotDefinition(slot) {
  if (typeof slot !== 'string' || !slot) return null;
  return EFFECT_SLOTS[slot] || null;
}

export function slotCapacity(slot) {
  const definition = getSlotDefinition(slot);
  const capacity = num(definition?.capacity, DEFAULT_SLOT_CAPACITY);
  return capacity > 0 ? Math.floor(capacity) : DEFAULT_SLOT_CAPACITY;
}

export function getTransition(effect) {
  const declared = isObject(effect?.transition) ? effect.transition : {};
  const defaults = isObject(EFFECT_TRANSITIONS?.defaults)
    ? EFFECT_TRANSITIONS.defaults
    : DEFAULT_TRANSITION;
  return {
    equipMs: Math.max(0, num(declared.equipMs, num(defaults.equipMs, DEFAULT_TRANSITION.equipMs))),
    unequipMs: Math.max(0, num(declared.unequipMs, num(defaults.unequipMs, DEFAULT_TRANSITION.unequipMs))),
    easing: typeof declared.easing === 'string' && declared.easing
      ? declared.easing
      : (typeof defaults.easing === 'string' && defaults.easing
        ? defaults.easing
        : DEFAULT_TRANSITION.easing)
  };
}

export function easeWeight(easing, progress) {
  const t = clamp01(progress);
  switch (easing) {
    case 'ease-in':
      return t * t * t;
    case 'ease-out':
      return 1 - Math.pow(1 - t, 3);
    case 'ease-in-out':
      return t < 0.5
        ? 4 * t * t * t
        : 1 - Math.pow(-2 * t + 2, 3) / 2;
    case 'sine':
      return 1 - Math.cos((t * Math.PI) / 2);
    case 'linear':
    default:
      return t;
  }
}

export function transitionWeight(phase, since, durationMs, now, easing = 'ease-out') {
  if (!Number.isFinite(now) || !Number.isFinite(since)) return 1;
  if (!Number.isFinite(durationMs) || durationMs <= 0) return 1;
  const progress = clamp01((now - since) / durationMs);
  const eased = clamp01(easeWeight(easing, progress));
  return phase === 'out' ? clamp01(1 - eased) : eased;
}

function resolveItemForEntry(character, source, uid) {
  const inventory = Array.isArray(character?.inventory) ? character.inventory : [];
  let item = getItemInstance(inventory, uid);
  if (!item && typeof source.itemId === 'string') {
    item = getItemInstance(inventory, source.itemId) || getItemDefinition(source.itemId);
  }
  if (!item && typeof source.id === 'string') {
    item = getItemInstance(inventory, source.id) || getItemDefinition(source.id);
  }
  return item;
}

function buildEntry(character, raw, now, phase) {
  const source = typeof raw === 'string' ? { uid: raw } : raw;
  if (!isObject(source)) return null;

  const uid = typeof source.uid === 'string' && source.uid
    ? source.uid
    : (typeof source.itemId === 'string' ? source.itemId : null);
  if (!uid) return null;

  const item = resolveItemForEntry(character, source, uid);
  const itemId = (typeof source.itemId === 'string' && source.itemId)
    || (item && typeof item.id === 'string' ? item.id : null)
    || uid;

  const effectId = (typeof source.effectId === 'string' && source.effectId)
    || getItemEffectId(item)
    || getItemEffectId(itemId)
    || getItemEffectId(uid);
  const effect = getEffect(effectId);
  if (!effect) return null;

  const slot = (typeof source.slot === 'string' && EFFECT_SLOTS[source.slot])
    ? source.slot
    : effect.slot;
  if (!slot) return null;

  const transition = getTransition(effect);
  const since = Number.isFinite(source.since)
    ? source.since
    : (Number.isFinite(source.at) ? source.at : null);

  let weight = 1;
  if (phase === 'out') {
    const until = Number.isFinite(source.until) ? source.until : null;
    const duration = until !== null && since !== null ? until - since : transition.unequipMs;
    weight = transitionWeight('out', since, duration, now, transition.easing);
  } else {
    weight = transitionWeight('in', since, transition.equipMs, now, transition.easing);
  }

  return {
    slot,
    uid,
    itemId,
    item,
    effectId: effect.id,
    effect,
    phase,
    weight: round(clamp01(weight)),
    since
  };
}

/**
 * Equipped entries plus transient unequip ghosts. Duplicate uids keep their
 * first occurrence; unknown items/effects are skipped rather than throwing.
 */
export function activeEntries(character, now) {
  if (!isObject(character)) return [];
  const equipped = Array.isArray(character.equipped) ? character.equipped : [];
  const ghosts = Array.isArray(character.effectGhosts) ? character.effectGhosts : [];
  const entries = [];
  const seen = new Set();

  for (const raw of equipped) {
    const entry = buildEntry(character, raw, now, 'in');
    if (!entry || seen.has(entry.uid)) continue;
    seen.add(entry.uid);
    entries.push(entry);
  }

  for (const raw of ghosts) {
    const entry = buildEntry(character, raw, now, 'out');
    if (!entry || seen.has(entry.uid) || entry.weight <= EPSILON) continue;
    seen.add(entry.uid);
    entries.push(entry);
  }

  return entries;
}

export function equippedInSlot(character, slot) {
  return activeEntries(character).filter(entry => entry.slot === slot);
}

export function hasEffect(character, effectId, now) {
  return activeEntries(character, now).some(entry => entry.effect.id === effectId);
}

function resolveEquipItem(character, item) {
  if (typeof item === 'string' && item) {
    const inventoryItem = getItemInstance(character.inventory, item);
    if (inventoryItem) {
      const index = Array.isArray(character.inventory) ? character.inventory.indexOf(inventoryItem) : 0;
      ensureItemUid(inventoryItem, index);
      return {
        item: inventoryItem,
        uid: inventoryItem.uid,
        itemId: inventoryItem.id || item
      };
    }
    const definition = getItemDefinition(item);
    const id = definition?.id || getEffect(item)?.itemId || item;
    const instance = createItemInstance(id);
    return {
      item: instance,
      uid: instance?.uid || `${id}-0`,
      itemId: id
    };
  }

  if (!isObject(item)) return null;
  const id = typeof item.id === 'string' && item.id ? item.id : null;
  const explicitUid = typeof item.uid === 'string' && item.uid ? item.uid : null;

  if (explicitUid) {
    const inventoryItem = getItemInstance(character.inventory, explicitUid);
    return {
      item: inventoryItem || item,
      uid: explicitUid,
      itemId: item.id || inventoryItem?.id || null
    };
  }

  if (Array.isArray(character.inventory) && character.inventory.length) {
    const exactIndex = character.inventory.findIndex(candidate => candidate === item);
    const idIndex = id
      ? character.inventory.findIndex(candidate => candidate && candidate.id === id)
      : -1;
    const index = exactIndex >= 0 ? exactIndex : idIndex;
    if (index >= 0) {
      const inventoryItem = character.inventory[index];
      ensureItemUid(inventoryItem, index);
      return {
        item: inventoryItem,
        uid: inventoryItem.uid,
        itemId: inventoryItem.id || id
      };
    }
  }

  if (!id) return null;
  const instance = createItemInstance(id, item);
  return { item: instance, uid: instance.uid, itemId: id };
}

function effectIdForEntry(character, entry) {
  if (typeof entry.effectId === 'string' && entry.effectId) return entry.effectId;
  const item = getItemInstance(character?.inventory, entry.uid);
  return getItemEffectId(item)
    || getItemEffectId(entry.itemId)
    || getItemEffectId(entry.uid);
}

/**
 * Equip an item instance (or item/effect id) into its effect slot. Returns a
 * result object; never throws for bad input. The oldest entry in a full slot
 * is swapped out, and unique effects replace an earlier copy.
 */
export function equip(character, item, now) {
  if (!isObject(character)) return { ok: false, reason: 'no-character' };

  const resolved = resolveEquipItem(character, item);
  if (!resolved || !resolved.uid) return { ok: false, reason: 'unknown-item' };

  const effectId = getItemEffectId(resolved.item)
    || getItemEffectId(resolved.itemId)
    || getItemEffectId(item);
  const effect = getEffect(effectId);
  if (!effect) {
    return {
      ok: false,
      reason: 'unknown-effect',
      uid: resolved.uid,
      itemId: resolved.itemId
    };
  }

  const slot = effect.slot || resolved.item?.slot || null;
  if (!getSlotDefinition(slot)) {
    return {
      ok: false,
      reason: 'unknown-slot',
      slot,
      uid: resolved.uid,
      itemId: resolved.itemId,
      effectId: effect.id
    };
  }

  const uid = resolved.uid;
  const itemId = resolved.itemId || resolved.item?.id || null;
  const equipped = Array.isArray(character.equipped)
    ? character.equipped.filter(entry => isObject(entry) && typeof entry.uid === 'string')
    : [];

  const sameUid = equipped.find(entry => entry.uid === uid);
  if (sameUid) {
    if (sameUid.slot === slot) {
      return {
        ok: true,
        alreadyEquipped: true,
        slot,
        uid,
        itemId,
        effectId: effect.id,
        swapped: []
      };
    }
    return {
      ok: false,
      reason: 'duplicate-uid',
      slot,
      uid,
      itemId,
      effectId: effect.id,
      occupiedSlot: sameUid.slot
    };
  }

  let next = equipped;
  const swapped = [];

  if (effect.stacking === 'unique') {
    next = next.filter(entry => {
      if (effectIdForEntry(character, entry) === effect.id) {
        swapped.push(entry.uid);
        return false;
      }
      return true;
    });
  }

  const capacity = slotCapacity(slot);
  while (next.filter(entry => entry.slot === slot).length >= capacity) {
    const candidates = next
      .filter(entry => entry.slot === slot)
      .map((entry, index) => ({ entry, index }))
      .sort((a, b) => {
        const aSince = num(a.entry.since, 0);
        const bSince = num(b.entry.since, 0);
        return aSince === bSince ? a.index - b.index : aSince - bSince;
      });
    if (!candidates.length) break;
    const victim = candidates[0].entry;
    next = next.filter(entry => entry !== victim);
    swapped.push(victim.uid);
  }

  const entry = { slot, uid };
  if (Number.isFinite(now)) entry.since = now;
  if (itemId) entry.itemId = itemId;
  entry.effectId = effect.id;
  next = next.concat(entry);

  character.equipped = next;
  if (Array.isArray(character.effectGhosts)) {
    character.effectGhosts = character.effectGhosts.filter(ghost => ghost && ghost.uid !== uid);
  }

  const swapUids = [...new Set(swapped)];
  return {
    ok: true,
    slot,
    uid,
    itemId,
    effectId: effect.id,
    swapped: swapUids,
    replaced: swapUids.length > 0
  };
}

/**
 * Remove an equipped entry. When a transition duration is configured, a ghost
 * entry fades the effect out over `unequipMs` instead of popping.
 */
export function unequip(character, uid, now) {
  if (!isObject(character)) return { ok: false, reason: 'no-character' };
  if (typeof uid !== 'string' || !uid) return { ok: false, reason: 'unknown-uid' };

  const equipped = Array.isArray(character.equipped) ? character.equipped : [];
  const index = equipped.findIndex(entry => isObject(entry) && entry.uid === uid);
  if (index < 0) return { ok: false, reason: 'not-equipped', uid };

  const removed = equipped[index];
  character.equipped = equipped.slice(0, index).concat(equipped.slice(index + 1));

  const item = getItemInstance(character.inventory, uid);
  const effectId = effectIdForEntry(character, removed)
    || getItemEffectId(item)
    || getItemEffectId(removed.itemId);
  const effect = getEffect(effectId);
  if (!effect) {
    return {
      ok: true,
      uid,
      slot: removed.slot,
      itemId: removed.itemId || item?.id || null,
      effectId: effectId || null,
      removed,
      ghost: false
    };
  }

  const transition = getTransition(effect);
  let ghost = false;
  if (Number.isFinite(now) && transition.unequipMs > 0) {
    const ghosts = Array.isArray(character.effectGhosts)
      ? character.effectGhosts.filter(entry => isObject(entry))
      : [];
    ghosts.push({
      slot: removed.slot || effect.slot,
      uid,
      itemId: removed.itemId || item?.id || effect.itemId || null,
      effectId: effect.id,
      since: now,
      until: now + transition.unequipMs,
      easing: transition.easing
    });
    character.effectGhosts = ghosts.slice(-MAX_GHOSTS);
    ghost = true;
  }

  return {
    ok: true,
    uid,
    slot: removed.slot || effect.slot,
    itemId: removed.itemId || item?.id || null,
    effectId: effect.id,
    removed,
    ghost
  };
}

function canInherit(entry, character, owner) {
  const target = entry.effect?.target;
  if (target === 'party') return true;
  if (target === 'buddy') {
    const ownerId = typeof owner?.id === 'string' ? owner.id : null;
    return Boolean(ownerId && (
      character?.buddyId === ownerId
      || (typeof owner?.buddyId === 'string' && character?.id === owner.buddyId)
    ));
  }
  return false;
}

/**
 * Compose all active effects for a character. `owner` is optional and supplies
 * party effects (for example Buddy Cape) to companions; an array of owners is
 * also accepted.
 */
export function resolveFx(character, now, owner) {
  const own = activeEntries(character, now);
  const owners = Array.isArray(owner) ? owner : (owner ? [owner] : []);
  const inherited = [];
  const seen = new Set(own.map(entry => entry.uid));

  for (const candidate of owners) {
    if (!isObject(candidate) || candidate === character) continue;
    for (const entry of activeEntries(candidate, now)) {
      if (!entry.effect || seen.has(entry.uid)) continue;
      if (!canInherit(entry, character, candidate)) continue;
      seen.add(entry.uid);
      inherited.push({ ...entry, inherited: true, phase: 'party' });
    }
  }

  const entries = own.concat(inherited);
  let scale = 1;
  let alpha = 1;
  let offsetX = 0;
  let offsetY = 0;
  let rotate = 0;
  let tint = null;
  let tintWeight = 0;
  let outline = null;
  let outlineWeight = 0;
  let stepDurationScale = 1;
  let coinBonus = 0;
  let fly = false;
  let motion = null;
  let motionPriority = -Infinity;
  const aura = [];
  const trail = [];
  const vfx = [];
  const vfxSeen = new Set();

  for (const entry of entries) {
    const weight = clamp01(entry.weight);
    if (weight <= EPSILON) continue;
    const effect = entry.effect;
    const visual = isObject(effect.visual) ? effect.visual : {};

    const effectScale = num(visual.scale, 1);
    const effectAlpha = num(visual.alpha, 1);
    scale *= 1 + (effectScale - 1) * weight;
    alpha *= 1 + (effectAlpha - 1) * weight;
    offsetX += num(visual.offsetX, 0) * weight;
    offsetY += num(visual.offsetY, 0) * weight;
    rotate += num(visual.rotate, 0) * weight;

    if (visual.tint !== null && visual.tint !== undefined) {
      tint = visual.tint;
      tintWeight = weight;
    }
    if (visual.outline !== null && visual.outline !== undefined) {
      outline = visual.outline;
      outlineWeight = weight;
    }
    if (Array.isArray(visual.aura)) {
      for (const source of visual.aura) {
        if (source && typeof source === 'object') {
          aura.push({ ...source, effectId: effect.id, weight });
        }
      }
    }
    if (Array.isArray(visual.trail)) {
      for (const source of visual.trail) {
        if (source && typeof source === 'object') {
          trail.push({ ...source, effectId: effect.id, weight });
        }
      }
    }

    const stats = isObject(effect.stats) ? effect.stats : {};
    stepDurationScale *= 1 + (num(stats.stepDurationScale, 1) - 1) * weight;
    coinBonus += num(stats.coinBonus, 0) * weight;
    if (stats.fly === true && weight >= 0.5) fly = true;

    if (typeof effect.motion === 'string' && effect.motion) {
      const candidate = EFFECT_MOTIONS[effect.motion];
      const priority = num(candidate?.priority, 0);
      if (candidate && priority > motionPriority) {
        motion = candidate;
        motionPriority = priority;
      }
    }

    if (Array.isArray(effect.vfx)) {
      for (const key of effect.vfx) {
        if (typeof key === 'string' && key && !vfxSeen.has(key)) {
          vfxSeen.add(key);
          vfx.push(key);
        }
      }
    }
  }

  const effects = entries.map(entry => ({
    uid: entry.uid,
    itemId: entry.itemId,
    effectId: entry.effect.id,
    slot: entry.slot,
    target: entry.effect.target || 'self',
    phase: entry.phase,
    inherited: Boolean(entry.inherited),
    weight: round(clamp01(entry.weight))
  }));

  return {
    scale: round(scale),
    alpha: round(alpha),
    offsetX: round(offsetX),
    offsetY: round(offsetY),
    rotate: round(rotate),
    tint,
    tintWeight: round(tintWeight),
    aura,
    trail,
    outline,
    outlineWeight: round(outlineWeight),
    motion: motion ? { ...motion } : null,
    motionId: motion?.id || null,
    motionPriority: motion ? num(motion.priority, 0) : 0,
    stats: {
      stepDurationScale: round(stepDurationScale),
      coinBonus: round(coinBonus)
    },
    abilities: {
      fly
    },
    vfx,
    entries,
    effects
  };
}

/**
 * Fold an effect composition into a renderer transform. Multiplicative fields
 * multiply, additive fields add, and extra base properties are preserved.
 */
export function composeRenderTransform(base, fx) {
  const b = isObject(base) ? base : {};
  const f = isObject(fx) ? fx : {};
  const result = {
    ...b,
    scale: round(num(b.scale, 1) * num(f.scale, 1)),
    alpha: round(num(b.alpha, 1) * num(f.alpha, 1)),
    offsetX: round(num(b.offsetX, 0) + num(f.offsetX, 0)),
    offsetY: round(num(b.offsetY, 0) + num(f.offsetY, 0)),
    rotate: round(num(b.rotate, 0) + num(f.rotate, 0))
  };

  if ('tint' in f) result.tint = f.tint;
  else if ('tint' in b) result.tint = b.tint;
  if ('outline' in f) result.outline = f.outline;
  else if ('outline' in b) result.outline = b.outline;
  if (Array.isArray(f.aura)) result.aura = f.aura;
  if (Array.isArray(f.trail)) result.trail = f.trail;
  result.motionId = f.motionId ?? b.motionId ?? null;
  result.stats = {
    ...(isObject(b.stats) ? b.stats : {}),
    ...(isObject(f.stats) ? f.stats : {})
  };
  result.abilities = {
    ...(isObject(b.abilities) ? b.abilities : {}),
    ...(isObject(f.abilities) ? f.abilities : {})
  };
  return result;
}
