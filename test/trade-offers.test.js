import test from 'node:test';
import assert from 'node:assert/strict';
import { equip } from '../src/effects.js';
import { createItemInstance, getItemDefinition } from '../src/inventory.js';
import {
  TRADE_PRICE_BAND,
  TRADE_TEMPLATES,
  applyTrade,
  canTrade,
  fairPrice,
  generateTradeOffers,
  tradeDealKey,
  valuesAreClose
} from '../src/trade.js';

function makeCharacter(id, itemIds = [], coins = 0) {
  return {
    id,
    name: id,
    inventory: itemIds.map(itemId => createItemInstance(itemId)),
    equipped: [],
    coins
  };
}

function coinPrice(entry) {
  const { give, get } = entry.offer;
  if (Number.isFinite(give?.coins)) {
    return { side: 'player-buys', price: give.coins, itemId: get.itemId };
  }
  if (Number.isFinite(get?.coins)) {
    return { side: 'npc-buys', price: get.coins, itemId: give.itemId };
  }
  return null;
}

test('offer generation is deterministic for a seed and for the default seed', () => {
  const player = makeCharacter('player', ['prism-pin', 'park-postcard'], 100);
  const npc = makeCharacter('npc-1', ['echo-bell', 'hover-halo'], 100);

  const first = generateTradeOffers(player, npc, { rng: 12345 });
  const second = generateTradeOffers(player, npc, { rng: 12345 });
  assert.deepEqual(first, second);
  assert.ok(first.length > 0);

  assert.deepEqual(generateTradeOffers(player, npc), generateTradeOffers(player, npc));

  const scripted = () => 0.5;
  assert.deepEqual(
    generateTradeOffers(player, npc, { rng: scripted }),
    generateTradeOffers(player, npc, { rng: scripted })
  );
});

test('every coin price is an integer inside the 0.8x-1.2x fairness band', () => {
  const player = makeCharacter('player', ['prism-pin', 'park-postcard', 'glowworm-jar'], 500);
  const npc = makeCharacter('npc-1', ['echo-bell', 'hover-halo', 'apple-pie', 'lucky-clover'], 500);
  const offers = generateTradeOffers(player, npc, { max: 50, rng: 7 });

  assert.ok(offers.length > 0);
  for (const entry of offers) {
    const priced = coinPrice(entry);
    if (!priced) continue;
    const value = getItemDefinition(priced.itemId).value;
    assert.ok(Number.isInteger(priced.price), `${entry.id} price must be integer`);
    assert.ok(priced.price > 0, `${entry.id} price must be positive`);
    assert.ok(
      priced.price >= Math.ceil(value * TRADE_PRICE_BAND.min),
      `${entry.id} price ${priced.price} is below the band for value ${value}`
    );
    assert.ok(
      priced.price <= Math.floor(value * TRADE_PRICE_BAND.max),
      `${entry.id} price ${priced.price} is above the band for value ${value}`
    );
  }

  assert.equal(fairPrice(30, () => 0), 24);
  assert.equal(fairPrice(30, () => 0.999), 36);
  assert.equal(fairPrice(4, () => 0.999), 4);
  assert.ok(fairPrice(undefined, () => 0.5) >= 1);
});

test('offers never exceed either wallet and always pass canTrade', () => {
  const poorPlayer = makeCharacter('player', ['prism-pin', 'echo-bell'], 5);
  const poorNpc = makeCharacter('npc-1', ['hover-halo', 'lucky-clover'], 2);
  const offers = generateTradeOffers(poorPlayer, poorNpc, { max: 10, rng: 3 });

  assert.ok(offers.length > 0, 'swaps should still be possible');
  for (const entry of offers) {
    assert.equal(canTrade(poorPlayer, poorNpc, entry.offer).ok, true, entry.id);
    const priced = coinPrice(entry);
    if (!priced) continue;
    const wallet = priced.side === 'player-buys' ? poorPlayer.coins : poorNpc.coins;
    assert.ok(priced.price <= wallet, `${entry.id} exceeds its buyer's wallet`);
  }

  // The floor of the band for a 30-value item is 24 coins.
  const exact = generateTradeOffers(
    makeCharacter('player', [], 24),
    makeCharacter('npc-1', ['echo-bell'], 0),
    { rng: () => 0 }
  );
  assert.ok(exact.some(entry => entry.offer.get?.itemId === 'echo-bell' && entry.offer.give.coins === 24));

  const short = generateTradeOffers(
    makeCharacter('player', [], 23),
    makeCharacter('npc-1', ['echo-bell'], 0),
    { rng: () => 0 }
  );
  assert.equal(short.some(entry => entry.offer.get?.itemId === 'echo-bell'), false);

  const npcExact = generateTradeOffers(
    makeCharacter('player', ['echo-bell'], 0),
    makeCharacter('npc-1', [], 24),
    { rng: () => 0 }
  );
  assert.ok(npcExact.some(entry => entry.offer.give?.itemId === 'echo-bell' && entry.offer.get.coins === 24));

  const npcShort = generateTradeOffers(
    makeCharacter('player', ['echo-bell'], 0),
    makeCharacter('npc-1', [], 23),
    { rng: () => 0 }
  );
  assert.equal(npcShort.some(entry => entry.offer.give?.itemId === 'echo-bell'), false);
});

test('equipped items and untradeable boards are never offered', () => {
  const player = makeCharacter('player', ['hover-halo', 'chess', 'ball', 'prism-pin'], 100);
  equip(player, player.inventory[0]);
  const npc = makeCharacter('npc-1', ['echo-bell', 'checkers', 'park-postcard'], 100);
  equip(npc, npc.inventory[0]);

  const offers = generateTradeOffers(player, npc, { max: 20, rng: 11 });
  const itemIds = offers.flatMap(entry => [
    entry.offer.give?.itemId,
    entry.offer.get?.itemId
  ]).filter(Boolean);

  for (const blocked of ['hover-halo', 'echo-bell', 'chess', 'ball', 'checkers']) {
    assert.equal(itemIds.includes(blocked), false, `${blocked} must not be offered`);
  }
  assert.ok(itemIds.includes('prism-pin'));
  assert.ok(itemIds.includes('park-postcard'));
});

test('an empty or malformed pair yields the empty state', () => {
  assert.deepEqual(generateTradeOffers(makeCharacter('p'), makeCharacter('n')), []);
  assert.deepEqual(
    generateTradeOffers(makeCharacter('p', ['ball', 'chess']), makeCharacter('n', ['ball'])),
    []
  );
  assert.deepEqual(generateTradeOffers(null, makeCharacter('n')), []);
  const solo = makeCharacter('p');
  assert.deepEqual(generateTradeOffers(solo, solo), []);
});

test('up to three distinct offers are generated and any one can be selected', () => {
  const player = makeCharacter('player', ['prism-pin', 'park-postcard', 'glowworm-jar'], 100);
  const npc = makeCharacter('npc-1', ['echo-bell', 'hover-halo', 'apple-pie'], 100);

  const offers = generateTradeOffers(player, npc, { max: 3, rng: 42 });
  assert.equal(offers.length, 3);
  assert.equal(new Set(offers.map(entry => entry.id)).size, offers.length);
  for (const entry of offers) {
    assert.equal(canTrade(player, npc, entry.offer).ok, true, entry.id);
  }

  const selected = offers[1];
  const beforePlayer = player.inventory.map(item => item.id).sort();
  const beforeNpc = npc.inventory.map(item => item.id).sort();
  const result = applyTrade(player, npc, selected.offer);

  assert.equal(result.ok, true);
  assert.notDeepEqual(player.inventory.map(item => item.id).sort(), beforePlayer);
  assert.notDeepEqual(npc.inventory.map(item => item.id).sort(), beforeNpc);

  assert.equal(generateTradeOffers(player, npc, { max: 1 }).length, 1);
  assert.deepEqual(generateTradeOffers(player, npc, { max: 0 }), []);
});

test('a completed offer is excluded when the list refreshes', () => {
  const player = makeCharacter('player', [], 10);
  // Two postcards means the same sale could otherwise come back immediately.
  const npc = makeCharacter('npc-1', ['park-postcard', 'park-postcard'], 100);

  const offers = generateTradeOffers(player, npc, { rng: () => 0.5 });
  assert.equal(offers[0].id, 'npc-sells:park-postcard');
  assert.equal(offers[0].dealKey, 'buy:park-postcard');
  assert.equal(tradeDealKey(offers[0].offer), offers[0].dealKey);
  assert.equal(tradeDealKey(TRADE_TEMPLATES['buy-park-postcard']), 'buy:park-postcard');
  assert.equal(tradeDealKey(TRADE_TEMPLATES['swap-prism-echo']), 'swap:echo-bell:prism-pin');
  assert.equal(
    tradeDealKey({ give: { itemId: 'echo-bell' }, get: { itemId: 'prism-pin' } }),
    'swap:echo-bell:prism-pin',
    'a swap retires in both directions'
  );
  assert.equal(applyTrade(player, npc, offers[0].offer).ok, true);

  for (const exclude of [[offers[0].id], [offers[0].dealKey]]) {
    const refreshed = generateTradeOffers(player, npc, {
      rng: () => 0.5,
      exclude
    });
    assert.equal(refreshed.some(entry => entry.id === offers[0].id), false);
    assert.equal(
      refreshed.some(entry => tradeDealKey(entry.offer) === offers[0].dealKey),
      false,
      'a template-shaped repeat is retired by the shared deal key'
    );
  }
  assert.ok(npc.inventory.some(item => item.id === 'park-postcard'), 'stock remains but the deal is retired');
});

test('item swaps only appear when catalog values are close', () => {
  assert.equal(valuesAreClose(30, 35), true);
  assert.equal(valuesAreClose(4, 60), false);

  const closePair = generateTradeOffers(
    makeCharacter('player', ['prism-pin'], 0),
    makeCharacter('npc-1', ['echo-bell'], 0),
    { rng: () => 0.5 }
  );
  assert.deepEqual(closePair.map(entry => entry.kind), ['swap']);

  const farPair = generateTradeOffers(
    makeCharacter('player', ['park-postcard'], 0),
    makeCharacter('npc-1', ['lucky-clover'], 0),
    { rng: () => 0.5 }
  );
  assert.deepEqual(farPair, []);
});
