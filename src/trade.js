import tradesConfig from '../data/trades.json' with { type: 'json' };
import { findItemByUid, getItemDefinition } from './inventory.js';

/**
 * Pure NPC trading primitives.
 *
 * An offer is `{ give, get }`, where `give` is what the player hands over and
 * `get` is what the player receives. Each side is either `{ coins }` or
 * `{ itemId, qty }`. Wave 5 supports one item per side (`qty === 1`) and never
 * two coin sides, so the three legal shapes are coins-for-item, item-for-coins,
 * and item-for-item.
 *
 * `applyTrade` is all-or-nothing: every ownership, balance, and tradeability
 * check runs before the first mutation, so a rejection leaves both characters
 * untouched. It never touches saves, UI, or dialogue.
 */

export const TRADE_TEMPLATES = tradesConfig.templates;

export const TRADE_REJECT_REASONS = Object.freeze([
  'invalid-offer',
  'missing-item',
  'untradeable',
  'insufficient-coins'
]);

const SUPPORTED_QTY = 1;
const SIDE_KEYS = new Set(['coins', 'itemId', 'qty']);

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(source, key) {
  return Object.prototype.hasOwnProperty.call(source, key);
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function characterId(character) {
  return typeof character?.id === 'string' && character.id ? character.id : null;
}

function inventoryOf(character) {
  return Array.isArray(character?.inventory) ? character.inventory : [];
}

function coinsOf(character) {
  return Number.isFinite(character?.coins) ? character.coins : 0;
}

function decline(reason, extra = {}) {
  return { ok: false, reason, ...extra };
}

function rejectOffer(detail) {
  return decline('invalid-offer', { detail });
}

/** Normalise one offer side, or return a detail string describing the problem. */
function normalizeSide(side, label) {
  if (!isObject(side)) return { detail: `${label} must be an object` };

  for (const key of Object.keys(side)) {
    if (!SIDE_KEYS.has(key)) return { detail: `${label} has unknown key ${key}` };
  }

  const hasCoins = hasOwn(side, 'coins');
  const hasItem = hasOwn(side, 'itemId');
  if (hasCoins === hasItem) {
    return { detail: `${label} must name exactly one of coins or itemId` };
  }

  if (hasCoins) {
    if (hasOwn(side, 'qty')) return { detail: `${label} coins cannot carry qty` };
    if (!isPositiveInteger(side.coins)) {
      return { detail: `${label} coins must be a positive integer` };
    }
    return { side: { coins: side.coins } };
  }

  if (typeof side.itemId !== 'string' || !side.itemId) {
    return { detail: `${label} itemId must be a non-empty string` };
  }
  if (!getItemDefinition(side.itemId)) {
    return { detail: `${label} references unknown item ${side.itemId}` };
  }
  if (!Number.isInteger(side.qty) || side.qty !== SUPPORTED_QTY) {
    return { detail: `${label} qty must be ${SUPPORTED_QTY}` };
  }
  return { side: { itemId: side.itemId, qty: SUPPORTED_QTY } };
}

/**
 * Check an offer's shape without touching any character.
 * Returns `{ ok: true, offer }` with a normalised copy, or
 * `{ ok: false, reason: 'invalid-offer', detail }`.
 */
export function validateOffer(offer) {
  if (!isObject(offer)) return rejectOffer('offer must be an object');

  const give = normalizeSide(offer.give, 'give');
  if (give.detail) return rejectOffer(give.detail);
  const get = normalizeSide(offer.get, 'get');
  if (get.detail) return rejectOffer(get.detail);

  if (hasOwn(give.side, 'coins') && hasOwn(get.side, 'coins')) {
    return rejectOffer('offer cannot trade coins for coins');
  }

  return { ok: true, offer: { give: give.side, get: get.side } };
}

/** Catalog predicate: only items explicitly flagged tradeable may change hands. */
export function isTradeableItem(itemOrId) {
  const id = typeof itemOrId === 'string'
    ? itemOrId
    : (isObject(itemOrId) ? itemOrId.id : null);
  if (typeof id !== 'string' || !id) return false;
  return getItemDefinition(id)?.tradeable === true;
}

/** Deterministic uid for a legacy item, matching `ensureItemUid` without writing. */
function uidFor(character, item) {
  if (typeof item?.uid === 'string' && item.uid) return item.uid;
  const id = typeof item?.id === 'string' && item.id ? item.id : 'item';
  const index = inventoryOf(character).indexOf(item);
  return `${id}-${index >= 0 ? index : 0}`;
}

/**
 * The equipped entry protecting this exact instance, if any. Modern entries
 * bind by uid; legacy entries that only know an item id are honoured as long as
 * their uid does not resolve to a different owned copy.
 */
function equippedEntryFor(character, item) {
  const equipped = Array.isArray(character?.equipped) ? character.equipped : [];
  const uid = uidFor(character, item);
  const itemId = typeof item?.id === 'string' ? item.id : null;

  for (const entry of equipped) {
    if (!isObject(entry)) continue;
    if (typeof entry.uid === 'string' && entry.uid === uid) return entry;
    // Legacy saves used the item id itself as the equipped uid.
    if (typeof entry.uid === 'string' && itemId && entry.uid === itemId) return entry;
    if (typeof entry.itemId === 'string' && itemId && entry.itemId === itemId) {
      const bound = typeof entry.uid === 'string' && entry.uid
        ? findItemByUid(inventoryOf(character), entry.uid)
        : null;
      if (!bound || bound === item) return entry;
    }
  }
  return null;
}

function equippedDetail(character, item, entry) {
  return {
    characterId: characterId(character),
    uid: typeof entry?.uid === 'string' ? entry.uid : uidFor(character, item),
    slot: typeof entry?.slot === 'string' ? entry.slot : null,
    itemId: typeof item?.id === 'string' ? item.id : null
  };
}

/**
 * Resolve the instance a side would hand over. Untradeable catalog items and
 * fully equipped stacks are refused even when the character owns them.
 */
function resolveTradeItem(character, itemId) {
  const candidates = inventoryOf(character)
    .filter(item => isObject(item) && item.id === itemId);

  if (!candidates.length) {
    return decline('missing-item', {
      detail: { characterId: characterId(character), itemId }
    });
  }
  if (!isTradeableItem(itemId)) {
    return decline('untradeable', {
      detail: { characterId: characterId(character), itemId }
    });
  }

  const item = candidates.find(candidate => !equippedEntryFor(character, candidate));
  if (item) return { ok: true, item, uid: uidFor(character, item) };

  return decline('untradeable', {
    equipped: equippedDetail(character, candidates[0], equippedEntryFor(character, candidates[0]))
  });
}

function planSide(character, other, side) {
  if (hasOwn(side, 'coins')) {
    const available = coinsOf(character);
    if (available < side.coins) {
      return decline('insufficient-coins', {
        detail: {
          characterId: characterId(character),
          required: side.coins,
          available
        }
      });
    }
    return {
      ok: true,
      leg: { kind: 'coins', from: character, to: other, amount: side.coins }
    };
  }

  const resolved = resolveTradeItem(character, side.itemId);
  if (!resolved.ok) return resolved;
  return {
    ok: true,
    leg: { kind: 'item', from: character, to: other, item: resolved.item, uid: resolved.uid }
  };
}

/**
 * Validate an offer against two live characters without mutating either.
 * Returns `{ ok: true, offer, plan }` or a rejection with `reason` and, where
 * useful, `detail`/`equipped`.
 */
export function canTrade(player, npc, offer) {
  const validated = validateOffer(offer);
  if (!validated.ok) return validated;

  if (!isObject(player) || !isObject(npc)) {
    return decline('invalid-offer', { detail: 'two characters are required' });
  }
  if (player === npc) {
    return decline('invalid-offer', { detail: 'a character cannot trade with itself' });
  }

  const give = planSide(player, npc, validated.offer.give);
  if (!give.ok) return give;
  const get = planSide(npc, player, validated.offer.get);
  if (!get.ok) return get;

  return { ok: true, offer: validated.offer, plan: [give.leg, get.leg] };
}

/** Return a uid not already used by a different entry in the destination. */
function uniqueUidFor(character, item, uid) {
  const inventory = inventoryOf(character);
  const taken = next => inventory.some(entry => entry && entry !== item && entry.uid === next);
  if (!taken(uid)) return uid;

  const id = typeof item?.id === 'string' && item.id ? item.id : 'item';
  let suffix = 1;
  let next = `${id}-trade-${suffix}`;
  while (taken(next)) {
    suffix += 1;
    next = `${id}-trade-${suffix}`;
  }
  return next;
}

/**
 * Apply an offer atomically. Both sides are validated first; only then are
 * coins and item instances mutated. Returns
 * `{ ok: true, offer, changes }` where `changes` is
 * `{ coins: { player, npc }, items: [{ itemId, uid, fromId, toId }] }`.
 * Rejections return `{ ok: false, reason, changes: null }` plus any detail.
 */
export function applyTrade(player, npc, offer) {
  const checked = canTrade(player, npc, offer);
  if (!checked.ok) return { ...checked, changes: null };

  // Second pass: prove every item leg still resolves before mutating anything.
  for (const leg of checked.plan) {
    if (leg.kind !== 'item') continue;
    if (!inventoryOf(leg.from).includes(leg.item)) {
      return decline('missing-item', {
        detail: { characterId: characterId(leg.from), itemId: leg.item?.id ?? null },
        changes: null
      });
    }
  }

  const changes = { coins: { player: 0, npc: 0 }, items: [] };

  for (const leg of checked.plan) {
    const fromRole = leg.from === player ? 'player' : 'npc';
    const toRole = fromRole === 'player' ? 'npc' : 'player';

    if (leg.kind === 'coins') {
      leg.from.coins = coinsOf(leg.from) - leg.amount;
      leg.to.coins = coinsOf(leg.to) + leg.amount;
      changes.coins[fromRole] -= leg.amount;
      changes.coins[toRole] += leg.amount;
      continue;
    }

    const fromInventory = inventoryOf(leg.from);
    const index = fromInventory.indexOf(leg.item);
    if (!Array.isArray(leg.to.inventory)) leg.to.inventory = [];
    const [moved] = fromInventory.splice(index, 1);
    const uid = uniqueUidFor(leg.to, moved, leg.uid);
    moved.uid = uid;
    leg.to.inventory.push(moved);

    changes.items.push({
      itemId: typeof moved.id === 'string' ? moved.id : null,
      uid,
      fromId: characterId(leg.from),
      toId: characterId(leg.to)
    });
  }

  return { ok: true, offer: checked.offer, changes };
}
