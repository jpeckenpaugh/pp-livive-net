import test from 'node:test';
import assert from 'node:assert/strict';
import itemsConfig from '../data/items.json' with { type: 'json' };
import effectsConfig from '../data/effects.json' with { type: 'json' };
import rewardsConfig from '../data/rewards.json' with { type: 'json' };
import {
  createItemInstance,
  createStarterInventory,
  getItemDefinition
} from '../src/inventory.js';
import { getEffectForItem } from '../src/effects.js';
import { rollReward, applyReward, pickPoolItem } from '../src/rewards.js';

const EFFECT_ITEMS = [
  { id: 'big-o-bracelet', effect: 'big-o', slot: 'charm' },
  { id: 'chamo-clip', effect: 'chamo', slot: 'face' },
  { id: 'teleport-tricorder', effect: 'tricorder', slot: 'hand' },
  { id: 'hover-halo', effect: 'hover-halo', slot: 'head' },
  { id: 'prism-pin', effect: 'prism-pin', slot: 'charm' },
  { id: 'echo-bell', effect: 'echo-bell', slot: 'charm' },
  { id: 'bouncy-boots', effect: 'bouncy-boots', slot: 'feet' },
  { id: 'buddy-cape', effect: 'buddy-cape', slot: 'back' },
  { id: 'glowworm-jar', effect: 'glowworm-jar', slot: 'hand' },
  { id: 'lucky-clover', effect: 'lucky-clover', slot: 'charm' },
  { id: 'wings', effect: 'wings', slot: 'back' }
];

const HEADLINE_ITEM_IDS = ['big-o-bracelet', 'chamo-clip', 'teleport-tricorder'];
const STARTER_EFFECT_IDS = [...HEADLINE_ITEM_IDS, 'wings'];

function makeGame(companionCount = 0) {
  const companions = Array.from({ length: companionCount }, (_, index) => ({ id: `comp-${index}` }));
  return {
    player: { coins: 0, inventory: [], equipped: [], stabledCompanions: [] },
    companions,
    getCompanionsFor: () => companions,
    makeCompanion: spec => ({ ...spec, made: true })
  };
}

test('every effect item maps to an effects.json entry and a valid slot', () => {
  for (const expected of EFFECT_ITEMS) {
    const item = itemsConfig.catalog[expected.id];
    assert.ok(item, `missing catalog item ${expected.id}`);
    assert.equal(item.id, expected.id);
    assert.equal(item.kind, 'effect');
    assert.equal(item.action, 'equip');
    assert.equal(item.effect, expected.effect);
    assert.equal(item.slot, expected.slot);
    assert.ok(effectsConfig.slots[item.slot], `${expected.id} uses an unknown slot`);

    const effect = effectsConfig.effects[item.effect];
    assert.ok(effect, `${expected.id} points at missing effect ${item.effect}`);
    assert.equal(effect.id, item.effect);
    assert.equal(effect.itemId, item.id);
    assert.equal(effect.slot, item.slot);
    assert.equal(getEffectForItem(item.id)?.id, expected.effect, `${expected.id} does not resolve`);

    assert.ok(Array.isArray(item.owners) && item.owners.length > 0, `${expected.id} needs owners`);
    assert.ok(item.owners.includes('player'), `${expected.id} must be player-ownable`);
    assert.equal(typeof item.name, 'string');
    assert.equal(typeof item.icon, 'string');
    assert.equal(typeof item.description, 'string');
    assert.equal(typeof item.ui?.summary, 'string');
    assert.equal(typeof item.ui?.badge, 'string');
  }

  // Existing toy items keep their original shape.
  assert.equal(itemsConfig.catalog.ball.action, 'throw');
  assert.equal(itemsConfig.catalog['tic-tac-toe'].action, 'unfurl');
  assert.equal(itemsConfig.catalog.checkers.action, 'unfurl');
  assert.equal(itemsConfig.catalog.chess.action, 'unfurl');
  for (const id of ['ball', 'tic-tac-toe', 'checkers', 'chess']) {
    assert.equal(itemsConfig.catalog[id].kind, undefined, `${id} should stay a toy`);
  }
});

test('starter inventory grants the headline effect items and wings', () => {
  const inventory = createStarterInventory();
  const ids = inventory.map(item => item.id);

  for (const id of ['ball', 'tic-tac-toe', 'checkers', 'chess', ...STARTER_EFFECT_IDS]) {
    assert.ok(ids.includes(id), `starter is missing ${id}`);
  }

  const effects = inventory.filter(item => item.kind === 'effect');
  assert.deepEqual(
    effects.map(item => item.id).sort(),
    [...STARTER_EFFECT_IDS].sort()
  );
});

test('rollReward returns a catalog item from the loot pool', () => {
  const poolIds = new Set();
  for (const table of Object.values(rewardsConfig.lootTables)) {
    for (const row of table) {
      if (row.type !== 'item' || !Array.isArray(row.pool)) continue;
      for (const id of row.pool) poolIds.add(id);
    }
  }

  const game = makeGame();
  const seen = new Set();
  for (let i = 0; i < 300; i += 1) {
    const reward = rollReward(game, 'checkers', 'win');
    assert.ok(reward);
    for (const entry of reward.items) {
      assert.equal(typeof entry.id, 'string');
      assert.ok(poolIds.has(entry.id), `${entry.id} is not in any configured pool`);
      assert.ok(getItemDefinition(entry.id), `${entry.id} is not in the item catalog`);
      seen.add(entry.id);
    }
  }
  assert.ok(seen.size > 0, 'expected at least one item reward from checkers');

  // Tic-tac-toe stays companion-only, so the existing companion test keeps its odds.
  const ttt = rollReward(game, 'tic-tac-toe', 'win');
  assert.deepEqual(ttt.items, []);
});

test('pickPoolItem only chooses known catalog ids', () => {
  assert.equal(pickPoolItem(['ball', 'chess'], () => 0), 'ball');
  assert.equal(pickPoolItem(['ball', 'chess'], () => 0.99), 'chess');
  assert.equal(pickPoolItem(['ball', 'mystery-trinket', { id: 'chess' }], () => 0.99), 'chess');
  assert.equal(pickPoolItem(['mystery-trinket'], () => 0.5), null);
  assert.equal(pickPoolItem([], () => 0.5), null);
  assert.equal(pickPoolItem(null), null);
});

test('applyReward adds item rewards as instances with fresh uids', () => {
  const ball = createItemInstance('ball', { uid: 'ball-keep' });
  const game = makeGame();
  game.player.inventory.push(ball);

  const notices = applyReward(game, {
    coins: 5,
    items: [{ id: 'hover-halo' }, { id: 'hover-halo' }],
    newCompanion: null
  });

  assert.equal(game.player.coins, 5);
  assert.equal(game.player.inventory.length, 3);
  assert.equal(game.player.inventory[0], ball, 'existing inventory must be untouched');

  const added = game.player.inventory.slice(1);
  assert.deepEqual(added.map(item => item.id), ['hover-halo', 'hover-halo']);
  for (const item of added) {
    assert.equal(typeof item.uid, 'string');
    assert.ok(item.uid.length > 0);
    assert.notEqual(item.uid, 'ball-keep');
    assert.equal(item.name, itemsConfig.catalog['hover-halo'].name);
    assert.equal(item.slot, 'head');
    assert.equal(item.kind, 'effect');
  }
  assert.notEqual(added[0].uid, added[1].uid);
  assert.ok(notices.some(notice => notice.includes('Hover Halo')), 'item reward should be announced');
});

test('applyReward avoids uid collisions with existing items', () => {
  const existing = createItemInstance('hover-halo', { uid: 'hover-1' });
  const game = makeGame();
  game.player.inventory.push(existing);

  applyReward(game, { items: [{ id: 'hover-halo', uid: 'hover-1' }] });

  assert.equal(game.player.inventory.length, 2);
  assert.equal(game.player.inventory[0], existing);
  assert.notEqual(game.player.inventory[1].uid, 'hover-1');
});

test('lucky clover adds one coin per reward without double counting', () => {
  const withClover = () => {
    const clover = createItemInstance('lucky-clover', { uid: 'clover-1' });
    return {
      player: { coins: 0, inventory: [clover], equipped: [{ slot: 'charm', uid: 'clover-1' }] }
    };
  };

  const game = withClover();
  const notices = applyReward(game, { coins: 10, items: [] });
  assert.equal(game.player.coins, 11);
  assert.ok(notices.some(notice => notice.includes('🍀')));

  const plain = makeGame();
  applyReward(plain, { coins: 10, items: [] });
  assert.equal(plain.player.coins, 10);

  // A reward without coins still triggers the clover exactly once.
  const noCoins = withClover();
  applyReward(noCoins, { coins: 0 });
  assert.equal(noCoins.player.coins, 1);

  // Two equipped clovers stack, and still never double-count the base coins.
  const stacked = withClover();
  stacked.player.inventory.push(createItemInstance('lucky-clover', { uid: 'clover-2' }));
  stacked.player.equipped.push({ slot: 'charm', uid: 'clover-2', since: 0 });
  applyReward(stacked, { coins: 10 });
  assert.equal(stacked.player.coins, 12);
});

test('unknown item ids and empty pools fail safe', () => {
  const game = makeGame();

  assert.doesNotThrow(() => applyReward(game, {
    items: [{ id: 'mystery-trinket' }, null, 'not-an-item', {}, { id: '' }]
  }));
  assert.equal(game.player.inventory.length, 0);

  assert.deepEqual(applyReward(game, null), []);
  assert.doesNotThrow(() => applyReward(null, { coins: 5 }));

  assert.equal(pickPoolItem(['mystery-trinket']), null);
  assert.equal(rollReward(game, 'unknown-game', 'win'), null);
  assert.equal(rollReward(game, 'checkers', 'unknown-outcome'), null);
});

test('coin and companion rewards keep their existing behaviour', () => {
  assert.equal(rollReward({}, 'tic-tac-toe', 'draw').coins, 3);
  assert.equal(rollReward({}, 'tic-tac-toe', 'loss').coins, 1);
  assert.equal(rollReward({}, 'chess', 'loss').coins, 5);
  const checkersWin = rollReward({}, 'checkers', 'win');
  assert.ok(checkersWin.coins >= 25, `base checkers win coins should be at least 25, got ${checkersWin.coins}`);
  assert.equal(checkersWin.newCompanion.buddyId, 'player');

  const game = makeGame();
  const notices = applyReward(game, {
    coins: 4,
    items: [],
    newCompanion: { id: 'comp-test', name: 'Pip' }
  });
  assert.equal(game.player.coins, 4);
  assert.equal(game.companions.length, 1);
  assert.equal(game.companions[0].name, 'Pip');
  assert.ok(notices.some(notice => notice.includes('Pip')));

  const fullParty = makeGame(3);
  applyReward(fullParty, { newCompanion: { id: 'comp-extra', name: 'Mo' } });
  assert.equal(fullParty.companions.length, 3);
  assert.equal(fullParty.player.stabledCompanions.length, 1);
  assert.equal(fullParty.player.stabledCompanions[0].name, 'Mo');
});
