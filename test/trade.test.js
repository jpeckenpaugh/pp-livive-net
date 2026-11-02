import test from 'node:test';
import assert from 'node:assert/strict';
import { equip } from '../src/effects.js';
import { createItemInstance } from '../src/inventory.js';
import {
  TRADE_REJECT_REASONS,
  TRADE_TEMPLATES,
  applyTrade,
  canTrade,
  isTradeableItem,
  validateOffer
} from '../src/trade.js';

function makeCharacter(id, itemIds = [], coins = 0) {
  return {
    id,
    inventory: itemIds.map(itemId => createItemInstance(itemId)),
    equipped: [],
    coins
  };
}

function offerFor(give, get) {
  return { give, get };
}

function coinsTrade(amount) {
  return offerFor({ coins: amount }, { itemId: 'hover-halo', qty: 1 });
}

test('validateOffer accepts the three supported barter shapes', () => {
  const buy = validateOffer(coinsTrade(50));
  assert.equal(buy.ok, true);
  assert.deepEqual(buy.offer, {
    give: { coins: 50 },
    get: { itemId: 'hover-halo', qty: 1 }
  });

  const sell = validateOffer(offerFor(
    { itemId: 'prism-pin', qty: 1 },
    { coins: 35 }
  ));
  assert.equal(sell.ok, true);

  const swap = validateOffer(offerFor(
    { itemId: 'prism-pin', qty: 1 },
    { itemId: 'echo-bell', qty: 1 }
  ));
  assert.equal(swap.ok, true);
});

test('validateOffer rejects malformed offers with invalid-offer', () => {
  const invalid = [
    null,
    'buy-hover-halo',
    {},
    { give: { coins: 10 } },
    { get: { coins: 10 } },
    offerFor({ coins: 10 }, { coins: 5 }),
    offerFor({ coins: 0 }, { itemId: 'hover-halo', qty: 1 }),
    offerFor({ coins: -5 }, { itemId: 'hover-halo', qty: 1 }),
    offerFor({ coins: 2.5 }, { itemId: 'hover-halo', qty: 1 }),
    offerFor({ itemId: 'nope', qty: 1 }, { coins: 5 }),
    offerFor({ itemId: 'hover-halo', qty: 2 }, { coins: 5 }),
    offerFor({ itemId: 'hover-halo', qty: 0 }, { coins: 5 }),
    offerFor({ itemId: 'hover-halo', qty: -1 }, { coins: 5 }),
    offerFor({ itemId: 'hover-halo' }, { coins: 5 }),
    offerFor({ itemId: 'hover-halo', qty: 1, coins: 5 }, { coins: 5 }),
    offerFor({ coins: 5, extra: true }, { itemId: 'hover-halo', qty: 1 }),
    offerFor({ coins: 5, qty: 1 }, { itemId: 'hover-halo', qty: 1 }),
    offerFor({ coins: 5 }, { itemId: 'uef-unknown', qty: 1 })
  ];

  for (const offer of invalid) {
    const result = validateOffer(offer);
    assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(offer)}`);
    assert.equal(result.reason, 'invalid-offer');
    assert.equal(typeof result.detail, 'string');
  }
});

test('every trade template validates and is self-consistent', () => {
  const entries = Object.entries(TRADE_TEMPLATES);
  assert.ok(entries.length >= 2);

  for (const [key, offer] of entries) {
    assert.equal(offer.id, key, `${key} must carry its own id`);
    const result = validateOffer(offer);
    assert.equal(result.ok, true, `${key}: ${result.detail || ''}`);
  }
});

test('catalog tradeability is limited to effects and every item carries a value', () => {
  assert.equal(isTradeableItem('hover-halo'), true);
  assert.equal(isTradeableItem('ball'), false);
  assert.equal(isTradeableItem('chess'), false);
  assert.equal(isTradeableItem('missing'), false);
  assert.equal(isTradeableItem(null), false);
});

test('canTrade validates without mutating either character', () => {
  const player = makeCharacter('player', [], 100);
  const npc = makeCharacter('npc-1', ['hover-halo'], 10);

  const result = canTrade(player, npc, coinsTrade(50));
  assert.equal(result.ok, true);
  assert.equal(result.plan.length, 2);

  assert.equal(player.coins, 100);
  assert.equal(npc.coins, 10);
  assert.equal(player.inventory.length, 0);
  assert.equal(npc.inventory.length, 1);
});

test('applyTrade buys an item with coins', () => {
  const player = makeCharacter('player', [], 100);
  const npc = makeCharacter('npc-1', ['hover-halo'], 10);
  const halo = npc.inventory[0];

  const result = applyTrade(player, npc, coinsTrade(50));
  assert.equal(result.ok, true);
  assert.deepEqual(result.changes, {
    coins: { player: -50, npc: 50 },
    items: [{
      itemId: 'hover-halo',
      uid: halo.uid,
      fromId: 'npc-1',
      toId: 'player'
    }]
  });

  assert.equal(player.coins, 50);
  assert.equal(npc.coins, 60);
  assert.deepEqual(player.inventory.map(item => item.id), ['hover-halo']);
  assert.equal(player.inventory[0].uid, halo.uid);
  assert.equal(npc.inventory.length, 0);
});

test('applyTrade sells an item for coins', () => {
  const player = makeCharacter('player', ['prism-pin'], 0);
  const npc = makeCharacter('npc-1', [], 100);
  const pin = player.inventory[0];

  const result = applyTrade(player, npc, offerFor(
    { itemId: 'prism-pin', qty: 1 },
    { coins: 35 }
  ));
  assert.equal(result.ok, true);
  assert.equal(player.coins, 35);
  assert.equal(npc.coins, 65);
  assert.deepEqual(npc.inventory.map(item => item.id), ['prism-pin']);
  assert.equal(npc.inventory[0].uid, pin.uid);
  assert.equal(player.inventory.length, 0);
});

test('applyTrade swaps one item for another', () => {
  const player = makeCharacter('player', ['prism-pin'], 15);
  const npc = makeCharacter('npc-1', ['echo-bell'], 25);

  const result = applyTrade(player, npc, offerFor(
    { itemId: 'prism-pin', qty: 1 },
    { itemId: 'echo-bell', qty: 1 }
  ));
  assert.equal(result.ok, true);
  assert.deepEqual(player.inventory.map(item => item.id), ['echo-bell']);
  assert.deepEqual(npc.inventory.map(item => item.id), ['prism-pin']);
  assert.equal(player.coins, 15);
  assert.equal(npc.coins, 25);
  assert.deepEqual(result.changes.coins, { player: 0, npc: 0 });
});

test('insufficient coins rejects without moving anything', () => {
  const player = makeCharacter('player', [], 20);
  const npc = makeCharacter('npc-1', ['hover-halo'], 5);

  const result = applyTrade(player, npc, coinsTrade(50));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'insufficient-coins');
  assert.equal(result.changes, null);
  assert.deepEqual(result.detail, { characterId: 'player', required: 50, available: 20 });

  assert.equal(player.coins, 20);
  assert.equal(npc.coins, 5);
  assert.equal(npc.inventory.length, 1);
});

test('a missing item rejects without moving anything', () => {
  const player = makeCharacter('player', [], 100);
  const npc = makeCharacter('npc-1', [], 100);
  const npcsBefore = npc.inventory.length;

  const result = applyTrade(player, npc, coinsTrade(50));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing-item');
  assert.equal(result.changes, null);
  assert.equal(result.detail.itemId, 'hover-halo');
  assert.equal(player.coins, 100);
  assert.equal(npc.inventory.length, npcsBefore);
});

test('boards and the ball are untradeable on either side', () => {
  const player = makeCharacter('player', ['chess'], 100);
  const npc = makeCharacter('npc-1', ['ball'], 100);

  const board = applyTrade(player, npc, offerFor(
    { itemId: 'chess', qty: 1 },
    { coins: 10 }
  ));
  assert.equal(board.ok, false);
  assert.equal(board.reason, 'untradeable');

  const ball = applyTrade(player, npc, offerFor(
    { coins: 10 },
    { itemId: 'ball', qty: 1 }
  ));
  assert.equal(ball.ok, false);
  assert.equal(ball.reason, 'untradeable');

  assert.deepEqual(player.inventory.map(item => item.id), ['chess']);
  assert.deepEqual(npc.inventory.map(item => item.id), ['ball']);
});

test('an equipped item is protected with an equipped detail', () => {
  const player = makeCharacter('player', ['hover-halo'], 0);
  const npc = makeCharacter('npc-1', [], 100);
  const halo = player.inventory[0];
  assert.equal(equip(player, halo).ok, true);

  const result = applyTrade(player, npc, offerFor(
    { itemId: 'hover-halo', qty: 1 },
    { coins: 40 }
  ));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'untradeable');
  assert.equal(result.changes, null);
  assert.deepEqual(result.equipped, {
    characterId: 'player',
    uid: halo.uid,
    slot: 'head',
    itemId: 'hover-halo'
  });
  assert.equal(player.inventory.length, 1);
  assert.equal(npc.coins, 100);
});

test('legacy equipped entries that only know an item id still protect it', () => {
  const player = makeCharacter('player', ['hover-halo'], 0);
  const npc = makeCharacter('npc-1', [], 100);
  // Pre-instance saves stored the item id (or an item id as uid) in `equipped`.
  player.equipped = [{ uid: 'hover-halo', slot: 'head' }];

  const result = applyTrade(player, npc, offerFor(
    { itemId: 'hover-halo', qty: 1 },
    { coins: 40 }
  ));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'untradeable');
  assert.equal(player.inventory.length, 1);
});

test('an unequipped duplicate of an equipped item remains tradeable', () => {
  const player = makeCharacter('player', ['hover-halo', 'hover-halo'], 0);
  const npc = makeCharacter('npc-1', [], 100);
  const [worn, spare] = player.inventory;
  assert.equal(equip(player, worn).ok, true);

  const result = applyTrade(player, npc, offerFor(
    { itemId: 'hover-halo', qty: 1 },
    { coins: 40 }
  ));
  assert.equal(result.ok, true);
  assert.deepEqual(player.inventory.map(item => item.uid), [worn.uid]);
  assert.deepEqual(npc.inventory.map(item => item.uid), [spare.uid]);
  assert.equal(player.equipped.length, 1);
  assert.equal(player.equipped[0].uid, worn.uid);
});

test('qty above one is rejected before any mutation', () => {
  const player = makeCharacter('player', [], 100);
  const npc = makeCharacter('npc-1', ['hover-halo'], 100);

  const result = applyTrade(player, npc, offerFor(
    { coins: 50 },
    { itemId: 'hover-halo', qty: 2 }
  ));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid-offer');
  assert.equal(result.changes, null);
  assert.equal(player.coins, 100);
  assert.equal(npc.inventory.length, 1);
});

test('trades preserve total item count and keep uids unique', () => {
  const player = makeCharacter('player', ['hover-halo'], 100);
  const npc = makeCharacter('npc-1', ['hover-halo'], 100);
  // Legacy saves can collide on deterministic per-character uids.
  player.inventory[0].uid = 'hover-halo-0';
  npc.inventory[0].uid = 'hover-halo-0';

  const before = player.inventory.length + npc.inventory.length;
  const result = applyTrade(player, npc, coinsTrade(50));
  assert.equal(result.ok, true);

  const after = player.inventory.length + npc.inventory.length;
  assert.equal(after, before);
  assert.equal(player.inventory.length, 2);
  assert.equal(npc.inventory.length, 0);

  const uids = player.inventory.map(item => item.uid);
  assert.equal(new Set(uids).size, uids.length);
  assert.ok(uids.includes('hover-halo-trade-1'));
  assert.equal(result.changes.items[0].uid, 'hover-halo-trade-1');
});

test('a character cannot trade with itself or a missing character', () => {
  const player = makeCharacter('player', ['prism-pin'], 0);
  const offer = offerFor({ itemId: 'prism-pin', qty: 1 }, { coins: 10 });

  assert.equal(applyTrade(player, player, offer).ok, false);
  assert.equal(applyTrade(player, null, offer).reason, 'invalid-offer');
  assert.equal(canTrade(null, player, offer).reason, 'invalid-offer');
});

test('the published rejection reasons are exactly the supported set', () => {
  assert.deepEqual([...TRADE_REJECT_REASONS], [
    'invalid-offer',
    'missing-item',
    'untradeable',
    'insufficient-coins'
  ]);
});
