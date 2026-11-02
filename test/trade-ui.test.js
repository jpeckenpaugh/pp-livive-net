import test from 'node:test';
import assert from 'node:assert/strict';
import engineConfig from '../data/engine_config.json' with { type: 'json' };
import itemsConfig from '../data/items.json' with { type: 'json' };
import { createItemInstance, createStarterInventory } from '../src/inventory.js';
import { STARTING_COINS, Game } from '../src/game.js';
import { applyTrade, pickTradeOffer, TRADE_TEMPLATES } from '../src/trade.js';
import { describeTradeRejection, npcCardActions } from '../src/ui/panels.js';

function character(id, extra = {}) {
  return {
    id,
    name: extra.name || id,
    coins: 0,
    inventory: [],
    equipped: [],
    ...extra
  };
}

function postcard(uid) {
  return createItemInstance('park-postcard', { uid });
}

function freshPlayer(extra = {}) {
  return character('player', {
    name: 'You',
    isPlayer: true,
    coins: STARTING_COINS,
    inventory: createStarterInventory(),
    ...extra
  });
}

function freshNpc(extra = {}) {
  return character('npc-1', {
    name: 'Fern',
    coins: STARTING_COINS,
    inventory: createStarterInventory(),
    ...extra
  });
}

test('starting coins come from data and apply only to new characters', () => {
  assert.ok(Number.isInteger(engineConfig.economy.startingCoins));
  assert.equal(STARTING_COINS, engineConfig.economy.startingCoins);
  assert.ok(STARTING_COINS > 0);

  const game = new Game();
  const fresh = game.makeCharacter({ id: 'npc-a', name: 'Fern', x: 2, y: 2 });
  assert.equal(fresh.coins, STARTING_COINS, 'a new character starts with the configured wallet');

  const returning = game.makeCharacter({ id: 'npc-b', name: 'Moss', x: 3, y: 3, coins: 0 });
  assert.equal(returning.coins, 0, 'an explicit balance is never overwritten');
});

test('the postcard is a tradeable non-effect trinket in the starter bag', () => {
  const def = itemsConfig.catalog['park-postcard'];
  assert.equal(def.kind, 'trinket');
  assert.equal(def.tradeable, true);
  assert.equal(def.action, undefined);
  assert.ok(Number.isInteger(def.value) && def.value > 0);

  const inventory = createStarterInventory();
  assert.equal(inventory.filter(item => item.id === 'park-postcard').length, 1);
});

test('a fresh park offers the small postcard purchase first', () => {
  const picked = pickTradeOffer(freshPlayer(), freshNpc());

  assert.ok(picked);
  assert.equal(picked.id, 'buy-park-postcard');
  assert.equal(picked.offer.give.coins, 6);
  assert.equal(picked.offer.get.itemId, 'park-postcard');
  assert.equal(picked.template, TRADE_TEMPLATES['buy-park-postcard']);
});

test('a short wallet flips the offer to selling the postcard', () => {
  const picked = pickTradeOffer(freshPlayer({ coins: 4 }), freshNpc());

  assert.equal(picked.id, 'sell-park-postcard');
  assert.equal(picked.offer.give.itemId, 'park-postcard');
  assert.equal(picked.offer.get.coins, 3);
});

test('offer selection needs both sides to afford their half', () => {
  // The neighbour cannot pay for the player's postcard and owns nothing to sell.
  const brokeNpc = pickTradeOffer(
    freshPlayer({ coins: 0 }),
    freshNpc({ coins: 0, inventory: [] })
  );
  assert.equal(brokeNpc, null);

  // An unaffordable neighbour cannot sell a postcard the player could buy.
  const poorBuyer = pickTradeOffer(
    freshPlayer({ coins: 0 }),
    freshNpc({ coins: 0 })
  );
  assert.equal(poorBuyer, null);
});

test('offer selection tolerates an empty or malformed template map', () => {
  assert.equal(pickTradeOffer(freshPlayer(), freshNpc(), {}), null);
  assert.equal(pickTradeOffer(freshPlayer(), freshNpc(), null), null);
  assert.equal(pickTradeOffer(freshPlayer(), freshNpc(), { bad: null }), null);
  assert.equal(pickTradeOffer(null, freshNpc()), null);
});

test('the first template that passes is the one the card shows', () => {
  const player = freshPlayer({ coins: 4 });
  const npc = freshNpc({ coins: 40, inventory: createStarterInventory() });
  const picked = pickTradeOffer(player, npc);

  assert.equal(picked.id, 'sell-park-postcard');
  // Selling is a real atomic trade, not just a passing check.
  const result = applyTrade(player, npc, picked.template);
  assert.equal(result.ok, true);
  assert.equal(player.coins, 7);
  assert.equal(npc.coins, 37);
});

test('rejection copy names the side that cannot pay', () => {
  const player = freshPlayer({ coins: 2 });
  const npc = freshNpc({ coins: 50 });

  assert.equal(
    describeTradeRejection({
      ok: false,
      reason: 'insufficient-coins',
      detail: { characterId: 'player', required: 6, available: 2 }
    }, { player, npc }),
    "You're 4 coins short for that trade."
  );

  assert.equal(
    describeTradeRejection({
      ok: false,
      reason: 'insufficient-coins',
      detail: { characterId: 'npc-1', required: 35, available: 10 }
    }, { player, npc }),
    'Fern is 25 coins short for that trade.'
  );

  assert.equal(
    describeTradeRejection({ ok: false, reason: 'insufficient-coins' }, { player, npc }),
    "You don't have enough coins for that trade."
  );
});

test('rejection copy names the missing item side', () => {
  const player = freshPlayer();
  const npc = freshNpc();

  assert.equal(
    describeTradeRejection({
      ok: false,
      reason: 'missing-item',
      detail: { characterId: 'npc-1', itemId: 'hover-halo' }
    }, { player, npc }),
    "Fern doesn't have a Hover Halo."
  );

  assert.equal(
    describeTradeRejection({
      ok: false,
      reason: 'missing-item',
      detail: { characterId: 'player', itemId: 'prism-pin' }
    }, { player, npc }),
    "You don't have a Prism Pin."
  );
});

test('rejection copy explains equipped and untradeable items', () => {
  const player = freshPlayer();
  const npc = freshNpc();

  assert.equal(
    describeTradeRejection({
      ok: false,
      reason: 'untradeable',
      equipped: { characterId: 'player', itemId: 'hover-halo', slot: 'head' }
    }, { player, npc }),
    'That item is equipped. Take it off first.'
  );

  assert.equal(
    describeTradeRejection({
      ok: false,
      reason: 'untradeable',
      equipped: { characterId: 'npc-1', itemId: 'prism-pin', slot: 'charm' }
    }, { player, npc }),
    "Fern is wearing that and won't trade it."
  );

  assert.equal(
    describeTradeRejection({ ok: false, reason: 'untradeable' }, { player, npc }),
    "They won't trade that."
  );

  assert.equal(
    describeTradeRejection({ ok: false, reason: 'invalid-offer' }, { player, npc }),
    "That trade can't happen right now."
  );

  assert.equal(describeTradeRejection({ ok: true }, { player, npc }), '');
  assert.equal(describeTradeRejection(null, { player, npc }), '');
});

test('a strangled offer still reports the reason from applyTrade', () => {
  const player = freshPlayer({ coins: 10 });
  const npc = freshNpc();
  const offer = TRADE_TEMPLATES['buy-park-postcard'];

  assert.equal(applyTrade(player, npc, offer).ok, true);
  const repeated = applyTrade(player, npc, offer);
  assert.equal(repeated.ok, false);
  assert.equal(repeated.reason, 'insufficient-coins');
  assert.equal(
    describeTradeRejection(repeated, { player, npc }),
    "You're 2 coins short for that trade."
  );
});

test('a duplicate postcard instance stays distinct after a trade', () => {
  const player = freshPlayer({ coins: 10, inventory: [postcard('card-1')] });
  const npc = freshNpc({ coins: 10, inventory: [postcard('card-2')] });

  const result = applyTrade(player, npc, TRADE_TEMPLATES['sell-park-postcard']);
  assert.equal(result.ok, true);
  assert.equal(player.inventory.length, 0);
  assert.deepEqual(npc.inventory.map(item => item.uid).sort(), ['card-1', 'card-2']);
  assert.equal(new Set(npc.inventory.map(item => item.uid)).size, npc.inventory.length);
});

test('the trade pill is offered to strangers and friends alike', () => {
  const stranger = npcCardActions(freshNpc(), { isFriend: false, boards: [] });
  const friend = npcCardActions(freshNpc(), { isFriend: true, boards: [] });

  for (const model of [stranger, friend]) {
    const trade = model.actions.find(action => action.id === 'trade');
    assert.ok(trade, 'every neighbour card has a trade action');
    assert.equal(trade.label, 'Trade');
    assert.equal(trade.primary, false);
    assert.equal(model.actions.at(-1).id, 'trade', 'trade sits last in the row');
  }
});
