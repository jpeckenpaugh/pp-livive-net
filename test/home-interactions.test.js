import test from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../src/game.js';
import { generateHome } from '../src/world.js';
import { locationDef } from '../src/locations.js';
import { carryBasket } from '../src/forage.js';
import { homeRoomTiles } from '../src/home.js';
import {
  HOME_ITEM_IDS,
  HOME_USE_KINDS,
  consumeRecipe,
  expandDefaultLayout,
  homeActionPriority,
  homeItem,
  homeItemAtTop,
  homeItemUse,
  homePoseAnchor,
  homePoseForUse,
  normalizeHomeItems,
  recipeStatus,
  rugTiles,
  toggleHomeItem
} from '../src/home_items.js';
import itemConfig from '../data/items.json' with { type: 'json' };
import soundsConfig from '../data/sounds.json' with { type: 'json' };

const HOME_SEED = locationDef('home').seed;

function homeWorld() {
  return generateHome(HOME_SEED);
}

function defaultItems() {
  return expandDefaultLayout(homeWorld().house);
}

function record(itemId, x, y, rot = 0) {
  return { uid: `test_${itemId}_${x}_${y}`, itemId, x, y, rot, variant: 0, on: false };
}

test('hit-testing picks the topmost draw-order record and keeps the rug lowest', () => {
  const rug = record('rug', 25, 27);
  const couch = record('couch', 25, 27);

  // The couch footprint covers the rug's upper-left tile; furniture wins there.
  assert.equal(homeItemAtTop([rug, couch], 25, 27)?.itemId, 'couch');
  // The rest of the rug is still its own click target.
  assert.equal(homeItemAtTop([rug, couch], 26, 28)?.itemId, 'rug');
  assert.equal(homeItemAtTop([rug, couch], 32, 32), null);

  // A taller footprint sorts below by its bottom row: the bed drawn over a
  // chair that overlaps its middle wins the click.
  const bed = record('bed', 25, 25);
  const chair = record('chair', 25, 26);
  assert.equal(homeItemAtTop([bed, chair], 25, 26)?.itemId, 'bed');

  // Exact ties keep the later record, as the renderer draws later on top.
  const first = record('armchair', 25, 25);
  const second = record('chair', 25, 25);
  assert.equal(homeItemAtTop([first, second], 25, 25), second);
});

test('every Home item resolves a use verb and kind, with the agreed core actions', () => {
  for (const id of HOME_ITEM_IDS) {
    const use = homeItemUse(id);
    assert.ok(use, `${id} needs a use block`);
    assert.equal(typeof use.verb, 'string');
    assert.ok(use.verb.length > 0, `${id} verb`);
    assert.ok(HOME_USE_KINDS.includes(use.kind), `${id} kind ${use.kind}`);
    assert.equal(typeof homeItem(id).use, 'object', `${id} data carries use`);
  }

  assert.equal(homeItemUse('bed').verb, 'Sleep');
  assert.equal(homeItemUse('bed').kind, 'sleep');
  assert.equal(homeItemUse('couch').kind, 'sit');
  assert.equal(homeItemUse('chair').kind, 'sit');
  assert.equal(homeItemUse('tv').verb, 'Watch');
  assert.equal(homeItemUse('tv').kind, 'toggle');
  assert.equal(homeItemUse('floor-lamp').verb, 'Light');
  assert.equal(homeItemUse('radio').cue, 'radio-tune');

  const stove = homeItemUse('stove');
  assert.equal(stove.verb, 'Bake a pie');
  assert.equal(stove.kind, 'recipe');
  assert.deepEqual(stove.recipe.inputs, { apple: 3 });
  assert.equal(stove.recipe.output, 'apple-pie');
});

test('the pie recipe reports missing apples and consumes exactly three', () => {
  const recipe = homeItemUse('stove').recipe;
  const short = recipeStatus(recipe, { apple: 2, mushroom: 1 });
  assert.equal(short.ok, false);
  assert.deepEqual(short.missing, [{ id: 'apple', need: 3, have: 2, short: 1 }]);

  const empty = consumeRecipe({ apple: 2 }, recipe);
  assert.equal(empty.ok, false);
  assert.equal(empty.basket.apple, 2, 'a failed bake never spends apples');

  const basket = { apple: 3, mushroom: 1 };
  const baked = consumeRecipe(basket, recipe);
  assert.equal(baked.ok, true);
  assert.equal(baked.output, 'apple-pie');
  assert.deepEqual(baked.basket, { apple: 0, mushroom: 1 });
  assert.deepEqual(basket, { apple: 3, mushroom: 1 }, 'the input basket is not mutated');
});

test('on/off is the only persisted switch and survives normalization', () => {
  const items = defaultItems();
  const tv = items.find(entry => entry.itemId === 'tv');

  const on = toggleHomeItem(items, tv.uid);
  assert.equal(on.on, true);
  assert.equal(on.record.uid, tv.uid);
  assert.equal(on.items.find(entry => entry.uid === tv.uid).on, true);
  assert.equal(items.find(entry => entry.uid === tv.uid).on, false, 'toggle returns a copy');

  const restored = normalizeHomeItems(JSON.parse(JSON.stringify(on.items)));
  assert.equal(restored.find(entry => entry.uid === tv.uid).on, true);

  const off = toggleHomeItem(restored, tv.uid);
  assert.equal(off.on, false);
  assert.equal(off.items.find(entry => entry.uid === tv.uid).on, false);

  const missing = toggleHomeItem(items, 'nope');
  assert.equal(missing.record, null);
  assert.equal(missing.items, items);
});

test('the basket travels between locations and keeps other forage state', () => {
  const park = {
    forage: {
      apples: [{ id: 'apple:1,1', x: 1, y: 1 }],
      basket: { apple: 1, mushroom: 0 },
      harvested: { mushroom: 5 }
    }
  };
  const carried = carryBasket(park, { apple: 3, mushroom: 2 });
  assert.deepEqual(carried.forage.basket, { apple: 3, mushroom: 2 });
  assert.deepEqual(carried.forage.apples, park.forage.apples);
  assert.deepEqual(carried.forage.harvested, { mushroom: 5 });
  assert.deepEqual(park.forage.basket, { apple: 1, mushroom: 0 }, 'the source record is untouched');
  assert.equal(carryBasket(null, { apple: 3 }), null);
});

test('sleep and sit poses anchor to the item and a step clears them', () => {
  assert.equal(homePoseForUse('bed'), 'sleep');
  assert.equal(homePoseForUse('couch'), 'sit');
  assert.equal(homePoseForUse('tv'), null);

  const items = defaultItems();
  const bed = items.find(entry => entry.itemId === 'bed');
  const chair = items.find(entry => entry.itemId === 'chair');

  const bedAnchor = homePoseAnchor(items, { kind: 'sleep', uid: bed.uid });
  assert.equal(bedAnchor.x, bed.x + 0.5);
  assert.equal(bedAnchor.y, bed.y + 1);
  assert.ok(bedAnchor.sortY > bed.y + 2, 'the sleeper sorts above the bed');

  const seatAnchor = homePoseAnchor(items, { kind: 'sit', uid: chair.uid });
  assert.deepEqual({ x: seatAnchor.x, y: seatAnchor.y }, { x: chair.x, y: chair.y });
  assert.equal(homePoseAnchor(items, { kind: 'sit', uid: 'missing' }), null);
  assert.equal(homePoseAnchor(items, { kind: 'look', uid: bed.uid }), null);

  const home = homeWorld();
  const game = new Game();
  game.setWorld({
    terrain: home.grid,
    worldSeed: HOME_SEED,
    player: {
      id: 'player',
      name: 'You',
      recipe: { seed: 'player', style: 'voxel-art' },
      x: home.spawn.x,
      y: home.spawn.y,
      direction: 0,
      inventory: [],
      equipped: []
    },
    npcs: [],
    companions: [],
    scenery: [],
    forage: null,
    homeItems: items,
    homeMode: true,
    homeBuddies: [],
    homeRoomTiles: homeRoomTiles(home.grid, home.house),
    homeRugTiles: rugTiles(items)
  });
  game.interactive = true;

  assert.equal(game.setHomePose('sleep', bed.uid), true);
  assert.deepEqual(game.player.homePose, { kind: 'sleep', uid: bed.uid });
  assert.equal(game.player.pose, 'sit');

  // Stepping into the solid bed fails, but waking still happens.
  game.player.x = bed.x;
  game.player.y = bed.y - 1;
  assert.equal(game.tryPlayerStep(0, 1), false);
  assert.equal(game.player.homePose, null);
  assert.equal(game.player.pose, 'stand');

  // A fresh pose is also cleared explicitly.
  game.player.x = home.spawn.x;
  game.player.y = home.spawn.y;
  game.setHomePose('sit', chair.uid);
  assert.equal(game.clearHomePose(), true);
  assert.equal(game.player.homePose, null);
});

test('Home action priority is dialogue, menu, item, door, then menu', () => {
  assert.equal(homeActionPriority({}), 'menu-open');
  assert.equal(homeActionPriority({ door: {} }), 'door');
  assert.equal(homeActionPriority({ facingItem: {}, door: {} }), 'item');
  assert.equal(homeActionPriority({ menuOpen: true, facingItem: {} }), 'menu');
  assert.equal(homeActionPriority({ dialogueOpen: true, menuOpen: true }), 'dialogue');
});

test('the pie and the radio cue are catalogued where the plan expects them', () => {
  const pie = itemConfig.catalog['apple-pie'];
  assert.equal(pie.name, 'Apple Pie');
  assert.equal(pie.value, 6);
  assert.equal(pie.tradeable, true);
  assert.equal(pie.icon, '🥧');
  assert.equal(pie.action, undefined, 'the pie is a plain item, not a toy');

  const cue = soundsConfig.cues['radio-tune'];
  assert.ok(Array.isArray(cue.notes) && cue.notes.length >= 3);
  assert.ok(cue.notes.every(note => note.wave === 'square'), 'the tune is an 8-bit square wave');
});
