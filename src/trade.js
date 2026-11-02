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

/** Coins offered for an item stay inside this multiple of its catalog value. */
export const TRADE_PRICE_BAND = Object.freeze({ min: 0.8, max: 1.2 });

/** Two items may swap when the cheaper one is at least this share of the dearer. */
export const TRADE_SWAP_RATIO = 0.75;

export const TRADE_OFFER_LIMIT = 3;

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

/**
 * The first template this pair can actually complete, in `data/trades.json`
 * order. Returns `{ id, template, offer }` or `null` when nothing works, so a
 * card never offers a trade the NPC cannot afford or does not own.
 */
export function pickTradeOffer(player, npc, templates = TRADE_TEMPLATES) {
  const entries = templates && typeof templates === 'object'
    ? Object.entries(templates)
    : [];

  for (const [key, template] of entries) {
    if (!isObject(template)) continue;
    const checked = canTrade(player, npc, template);
    if (checked.ok) {
      return {
        id: typeof template.id === 'string' && template.id ? template.id : key,
        template,
        offer: checked.offer
      };
    }
  }
  return null;
}

/** Stable FNV-1a hash so a default seed is reproducible across runs. */
function hashSeed(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** A small deterministic PRNG; an injected `rng` function wins over a seed. */
function createTradeRng(source, fallback) {
  if (typeof source === 'function') {
    return () => {
      const value = Number(source());
      if (!Number.isFinite(value)) return 0;
      return Math.min(Math.max(value, 0), 0.999999999);
    };
  }

  let state = hashSeed(String(source == null ? fallback : source));
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function tradeSeed(player, npc) {
  const part = character => {
    const ids = inventoryOf(character)
      .filter(item => isObject(item) && typeof item.id === 'string')
      .map(item => item.id)
      .sort();
    return `${characterId(character) || '?'}|${ids.join(',')}`;
  };
  return `${part(player)}::${part(npc)}`;
}

function shuffle(list, rng) {
  const out = [...list];
  for (let index = out.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(rng() * (index + 1));
    [out[index], out[swap]] = [out[swap], out[index]];
  }
  return out;
}

/** Item ids this character can actually hand over right now. */
function availableItemIds(character) {
  const ids = [];
  for (const item of inventoryOf(character)) {
    if (!isObject(item) || typeof item.id !== 'string' || !item.id) continue;
    if (ids.includes(item.id)) continue;
    if (!isTradeableItem(item.id)) continue;
    if (!resolveTradeItem(character, item.id).ok) continue;
    ids.push(item.id);
  }
  return ids;
}

function itemValue(itemId) {
  const value = getItemDefinition(itemId)?.value;
  return Number.isFinite(value) && value > 0 ? value : 1;
}

/**
 * Integer coins inside the fairness band. Rounding is inward (`ceil`/`floor`)
 * so every price really is between 0.8x and 1.2x of value, and at least 1.
 */
export function fairPrice(value, rng) {
  const base = Number.isFinite(value) && value > 0 ? value : 1;
  const low = Math.max(1, Math.ceil(base * TRADE_PRICE_BAND.min));
  const high = Math.max(low, Math.floor(base * TRADE_PRICE_BAND.max));
  const roll = typeof rng === 'function' ? Number(rng()) : 0.5;
  const step = Number.isFinite(roll) ? Math.min(Math.max(roll, 0), 0.999999) : 0;
  return low + Math.floor(step * (high - low + 1));
}

/** Swaps only appear when the two catalog values are reasonably close. */
export function valuesAreClose(left, right) {
  const high = Math.max(left, right);
  const low = Math.min(left, right);
  return high > 0 && (low / high) >= TRADE_SWAP_RATIO;
}

/**
 * Direction-and-item identity shared by generated offers and fixed templates,
 * so a completed `buy-park-postcard` retires `npc-sells:park-postcard` too.
 */
export function tradeDealKey(offer) {
  if (Number.isFinite(offer?.give?.coins) && typeof offer?.get?.itemId === 'string') {
    return `buy:${offer.get.itemId}`;
  }
  if (typeof offer?.give?.itemId === 'string' && Number.isFinite(offer?.get?.coins)) {
    return `sell:${offer.give.itemId}`;
  }
  if (typeof offer?.give?.itemId === 'string' && typeof offer?.get?.itemId === 'string') {
    const pair = [offer.give.itemId, offer.get.itemId].sort();
    return `swap:${pair[0]}:${pair[1]}`;
  }
  return '';
}

/**
 * Build up to `max` deterministic offers from what each side owns and can
 * afford: the NPC sells an item, the NPC buys a player item, and close-value
 * item swaps. Offer ids are stable and semantic (`npc-sells:park-postcard`) so
 * callers can pass completed ids back through `exclude` and never repeat one.
 */
export function generateTradeOffers(player, npc, options = {}) {
  const { max = TRADE_OFFER_LIMIT, rng = null, exclude = [] } = options || {};
  if (!isObject(player) || !isObject(npc) || player === npc) return [];

  const limit = Number.isInteger(max) ? Math.max(0, max) : TRADE_OFFER_LIMIT;
  if (limit === 0) return [];

  const random = createTradeRng(rng, tradeSeed(player, npc));
  const skip = new Set(Array.isArray(exclude) ? exclude.filter(id => typeof id === 'string') : []);
  const playerCoins = coinsOf(player);
  const npcCoins = coinsOf(npc);
  const playerStock = availableItemIds(player);
  const npcStock = availableItemIds(npc);

  const sells = shuffle(npcStock, random)
    .map(itemId => ({ itemId, price: fairPrice(itemValue(itemId), random) }))
    .filter(({ price }) => price > 0 && playerCoins >= price)
    .map(({ itemId, price }) => ({
      id: `npc-sells:${itemId}`,
      dealKey: `buy:${itemId}`,
      kind: 'buy',
      offer: { give: { coins: price }, get: { itemId, qty: SUPPORTED_QTY } }
    }))
    .filter(entry => canTrade(player, npc, entry.offer).ok);

  const buys = shuffle(playerStock, random)
    .map(itemId => ({ itemId, price: fairPrice(itemValue(itemId), random) }))
    .filter(({ price }) => price > 0 && npcCoins >= price)
    .map(({ itemId, price }) => ({
      id: `npc-buys:${itemId}`,
      dealKey: `sell:${itemId}`,
      kind: 'sell',
      offer: { give: { itemId, qty: SUPPORTED_QTY }, get: { coins: price } }
    }))
    .filter(entry => canTrade(player, npc, entry.offer).ok);

  const swaps = [];
  for (const giveId of shuffle(playerStock, random)) {
    for (const getId of shuffle(npcStock, random)) {
      if (giveId === getId) continue;
      if (!valuesAreClose(itemValue(giveId), itemValue(getId))) continue;
      const id = `npc-swap:${giveId}:${getId}`;
      const offer = {
        give: { itemId: giveId, qty: SUPPORTED_QTY },
        get: { itemId: getId, qty: SUPPORTED_QTY }
      };
      const dealKey = tradeDealKey(offer);
      if (swaps.some(entry => entry.id === id)) continue;
      if (canTrade(player, npc, offer).ok) swaps.push({ id, dealKey, kind: 'swap', offer });
    }
  }

  // Round-robin the three shapes and keep each item in at most one offer, so
  // the list reads as three distinct ideas instead of a reversed duplicate.
  const pools = [sells, buys, swaps];
  const offers = [];
  const usedItems = new Set();
  while (offers.length < limit) {
    let added = false;
    for (const pool of pools) {
      while (pool.length) {
        const candidate = pool.shift();
        if (skip.has(candidate.id)) continue;
        if (candidate.dealKey && skip.has(candidate.dealKey)) continue;
        if (offers.some(entry => entry.id === candidate.id)) continue;
        const itemIds = [candidate.offer.give?.itemId, candidate.offer.get?.itemId].filter(Boolean);
        if (itemIds.some(itemId => usedItems.has(itemId))) continue;
        offers.push(candidate);
        for (const itemId of itemIds) usedItems.add(itemId);
        added = true;
        break;
      }
      if (offers.length >= limit) break;
    }
    if (!added) break;
  }
  return offers;
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
