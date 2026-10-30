import test from 'node:test';
import assert from 'node:assert/strict';
import effectsConfig from '../data/effects.json' with { type: 'json' };
import {
  EFFECT_SLOTS,
  EFFECT_CATALOG,
  EFFECT_MOTIONS,
  EFFECT_COMPOSITION,
  getEffect,
  getEffectForItem,
  getItemEffectId,
  getTransition,
  activeEntries,
  equippedInSlot,
  equip,
  unequip,
  resolveFx,
  composeRenderTransform,
  slotCapacity,
  easeWeight
} from '../src/effects.js';
import { createItemInstance } from '../src/inventory.js';

const EFFECT_IDS = [
  'big-o',
  'chamo',
  'tricorder',
  'hover-halo',
  'prism-pin',
  'echo-bell',
  'bouncy-boots',
  'buddy-cape',
  'glowworm-jar',
  'lucky-clover',
  'wings'
];

const VISUAL_CHANNELS = [
  'scale',
  'alpha',
  'offsetX',
  'offsetY',
  'rotate',
  'tint',
  'aura',
  'trail',
  'outline'
];

function makeCharacter(itemIds = []) {
  return {
    id: 'player',
    inventory: itemIds.map(id => createItemInstance(id)),
    equipped: [],
    effectGhosts: []
  };
}

function equipAll(character, now) {
  for (const item of character.inventory) {
    const result = equip(character, item, now);
    assert.equal(result.ok, true, `expected ${item.id} to equip`);
  }
}

test('effects data defines slots, composition, motions, and all eleven effects', () => {
  assert.equal(effectsConfig.schemaVersion, 1);

  for (const slot of ['head', 'face', 'hand', 'back', 'feet', 'charm', 'buddy']) {
    assert.ok(EFFECT_SLOTS[slot], `missing slot ${slot}`);
  }
  assert.equal(EFFECT_SLOTS.charm.capacity, 2);
  assert.equal(EFFECT_SLOTS.head.capacity, 1);
  assert.equal(slotCapacity('charm'), 2);
  assert.equal(slotCapacity('unknown'), 1);

  for (const channel of VISUAL_CHANNELS) {
    assert.ok(EFFECT_COMPOSITION.channels.includes(channel), `missing channel ${channel}`);
  }
  assert.equal(EFFECT_COMPOSITION.operations.scale, 'multiply');
  assert.equal(EFFECT_COMPOSITION.operations.alpha, 'multiply');
  assert.equal(EFFECT_COMPOSITION.operations.offsetX, 'add');
  assert.equal(EFFECT_COMPOSITION.operations.offsetY, 'add');
  assert.equal(EFFECT_COMPOSITION.operations.rotate, 'add');

  for (const motion of ['float', 'sway', 'teleport']) {
    assert.ok(EFFECT_MOTIONS[motion], `missing motion ${motion}`);
  }

  assert.deepEqual(Object.keys(EFFECT_CATALOG).sort(), [...EFFECT_IDS].sort());

  for (const id of EFFECT_IDS) {
    const effect = EFFECT_CATALOG[id];
    assert.equal(effect.id, id);
    assert.ok(effect.itemId, `${id} needs an itemId`);
    assert.ok(EFFECT_SLOTS[effect.slot], `${id} has an unknown slot`);
    assert.ok(['self', 'party', 'buddy'].includes(effect.target), `${id} target`);
    assert.ok(typeof effect.trigger === 'string' && effect.trigger, `${id} trigger`);
    assert.equal(effect.duration, 'permanent', `${id} duration`);
    assert.ok(typeof effect.stacking === 'string' && effect.stacking, `${id} stacking`);
    assert.ok(effect.motion === null || EFFECT_MOTIONS[effect.motion], `${id} motion`);

    for (const channel of VISUAL_CHANNELS) {
      assert.ok(channel in effect.visual, `${id} missing visual.${channel}`);
    }
    assert.equal(typeof effect.stats.stepDurationScale, 'number');
    assert.equal(typeof effect.stats.coinBonus, 'number');
    assert.ok(Array.isArray(effect.vfx) && effect.vfx.length > 0);
    assert.equal(typeof effect.transition.equipMs, 'number');
    assert.equal(typeof effect.transition.unequipMs, 'number');
    assert.equal(typeof effect.transition.easing, 'string');
    assert.equal(typeof effect.ui.summary, 'string');
    assert.equal(typeof effect.ui.badge, 'string');

    assert.equal(getEffect(id), effect);
  }

  const itemIds = new Set(Object.values(EFFECT_CATALOG).map(effect => effect.itemId));
  assert.equal(itemIds.size, 11, 'each effect should own a distinct item id');
});

test('headline effect values match the approved design', () => {
  assert.equal(getEffect('big-o').visual.scale, 1.5);
  assert.equal(getEffect('chamo').visual.alpha, 0.4);
  assert.equal(getEffect('tricorder').motion, 'teleport');
  assert.equal(getEffect('buddy-cape').target, 'party');
  assert.equal(getEffect('lucky-clover').stats.coinBonus, 1);
  assert.equal(getEffect('bouncy-boots').stats.stepDurationScale, 0.6);
});

test('charm capacity holds two effects and swaps the oldest on overflow', () => {
  const character = makeCharacter(['prism-pin', 'echo-bell', 'lucky-clover']);
  const [prism, echo, clover] = character.inventory;

  assert.equal(equip(character, prism).ok, true);
  assert.deepEqual(equip(character, echo).swapped, []);
  assert.equal(activeEntries(character).length, 2);

  const third = equip(character, clover);
  assert.equal(third.ok, true);
  assert.deepEqual(third.swapped, [prism.uid]);
  assert.equal(equippedInSlot(character, 'charm').length, 2);

  const activeIds = activeEntries(character).map(entry => entry.effectId).sort();
  assert.deepEqual(activeIds, ['echo-bell', 'lucky-clover']);
});

test('capacity-one slots swap the current item', () => {
  const character = makeCharacter(['glowworm-jar', 'tricorder']);
  const [jar, tricorder] = character.inventory;

  assert.equal(equip(character, jar).ok, true);
  const result = equip(character, tricorder);
  assert.equal(result.ok, true);
  assert.deepEqual(result.swapped, [jar.uid]);
  assert.deepEqual(equippedInSlot(character, 'hand').map(entry => entry.effectId), ['tricorder']);
});

test('unique effects replace an earlier copy and duplicate uids are rejected', () => {
  const character = makeCharacter(['big-o-bracelet', 'big-o-bracelet']);
  const [first, second] = character.inventory;

  assert.equal(equip(character, first).ok, true);
  const replacement = equip(character, second);
  assert.equal(replacement.ok, true);
  assert.deepEqual(replacement.swapped, [first.uid]);
  assert.deepEqual(activeEntries(character).map(entry => entry.uid), [second.uid]);

  const duplicateSlotCharacter = {
    inventory: [second],
    equipped: [{ slot: 'head', uid: second.uid }],
    effectGhosts: []
  };
  const duplicate = equip(duplicateSlotCharacter, second);
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.reason, 'duplicate-uid');
  assert.equal(duplicate.occupiedSlot, 'head');

  const malformed = {
    inventory: [second],
    equipped: [
      { slot: 'charm', uid: second.uid },
      { slot: 'charm', uid: second.uid }
    ]
  };
  assert.equal(activeEntries(malformed).length, 1);
});

test('composition multiplies scale/alpha and adds offsets/rotation', () => {
  const character = makeCharacter(['big-o-bracelet', 'bouncy-boots', 'hover-halo', 'prism-pin']);
  equipAll(character);
  const fx = resolveFx(character);

  assert.equal(fx.scale, 1.5);
  assert.equal(fx.offsetX, 1);
  assert.equal(fx.offsetY, -7);
  assert.equal(fx.rotate, 2);
  assert.equal(fx.stats.stepDurationScale, 0.6);
  assert.equal(fx.stats.coinBonus, 0);
  assert.ok(fx.aura.some(aura => aura.key === 'halo.glow'));
  assert.ok(fx.vfx.includes('big-o.pop'));

  const transform = composeRenderTransform(
    { scale: 2, alpha: 0.5, offsetX: 5, offsetY: 1, rotate: 10 },
    fx
  );
  assert.equal(transform.scale, 3);
  assert.equal(transform.alpha, 0.5);
  assert.equal(transform.offsetX, 6);
  assert.equal(transform.offsetY, -6);
  assert.equal(transform.rotate, 12);
  assert.equal(composeRenderTransform({ tint: '#ffffff' }, { tint: null }).tint, null);

  const chamoCharacter = makeCharacter(['chamo-clip']);
  equipAll(chamoCharacter);
  const faded = resolveFx(chamoCharacter);
  assert.equal(faded.alpha, 0.4);
  assert.equal(composeRenderTransform({ alpha: 0.5 }, faded).alpha, 0.2);
  assert.equal(faded.outline, null);
});

test('stacking effects add their stats', () => {
  const character = makeCharacter(['lucky-clover', 'lucky-clover']);
  equipAll(character);
  const fx = resolveFx(character);
  assert.equal(fx.stats.coinBonus, 2);
});

test('equip transitions ramp 0 to 1 and unequip ghosts fade back', () => {
  const character = makeCharacter(['big-o-bracelet']);
  const item = character.inventory[0];
  const transition = getTransition(getEffect('big-o'));

  equip(character, item, 1000);
  assert.equal(resolveFx(character, 1000).scale, 1);
  const mid = resolveFx(character, 1000 + transition.equipMs / 2);
  assert.ok(mid.scale > 1 && mid.scale < 1.5, `mid scale was ${mid.scale}`);
  assert.equal(resolveFx(character, 1000 + transition.equipMs).scale, 1.5);

  const removed = unequip(character, item.uid, 5000);
  assert.equal(removed.ok, true);
  assert.equal(removed.ghost, true);
  assert.equal(resolveFx(character, 5000).scale, 1.5);

  const fading = resolveFx(character, 5000 + transition.unequipMs / 2);
  assert.ok(fading.scale > 1 && fading.scale < 1.5, `fade scale was ${fading.scale}`);
  assert.equal(fading.entries[0].phase, 'out');

  const done = resolveFx(character, 5000 + transition.unequipMs);
  assert.equal(done.scale, 1);
  assert.equal(done.entries.length, 0);
});

test('legacy equipped entries are active immediately with weight 1', () => {
  const character = { inventory: [], equipped: [{ slot: 'charm', uid: 'big-o-bracelet' }] };
  const fx = resolveFx(character, 12345);
  assert.equal(fx.scale, 1.5);
  assert.equal(fx.entries[0].weight, 1);
});

test('motion priority chooses teleport over float', () => {
  const character = makeCharacter(['teleport-tricorder', 'hover-halo']);
  equipAll(character);
  assert.equal(resolveFx(character).motionId, 'teleport');
  assert.equal(resolveFx(character).motionPriority, 100);

  const item = character.inventory.find(entry => entry.id === 'teleport-tricorder');
  assert.equal(unequip(character, item.uid).ok, true);
  assert.equal(resolveFx(character).motionId, 'float');

  const noMotion = makeCharacter(['big-o-bracelet']);
  equipAll(noMotion);
  assert.equal(resolveFx(noMotion).motionId, null);
});

test('party effects inherit from the owner but not unrelated characters', () => {
  const owner = makeCharacter(['buddy-cape']);
  equipAll(owner);
  assert.equal(resolveFx(owner).scale, 1.1);

  const companion = {
    id: 'comp-1',
    buddyId: 'player',
    inventory: [],
    equipped: [],
    effectGhosts: []
  };
  const inherited = resolveFx(companion, undefined, owner);
  assert.equal(inherited.scale, 1.1);
  assert.equal(inherited.tint, '#4cc9f0');
  assert.ok(inherited.effects.some(effect => effect.inherited && effect.effectId === 'buddy-cape'));
  assert.ok(inherited.aura.some(aura => aura.key === 'cape.party-link'));

  const solo = resolveFx(companion);
  assert.equal(solo.scale, 1);
  assert.equal(solo.entries.length, 0);
});

test('unknown items and effects fail safe', () => {
  assert.equal(getEffect('missing-effect'), null);
  assert.equal(getEffectForItem('missing-item'), null);
  assert.equal(getItemEffectId('missing-item'), null);

  const character = {
    inventory: [],
    equipped: [
      { slot: 'charm', uid: 'missing-item' },
      { slot: 'head', uid: 'missing-effect-uid', effectId: 'missing-effect' },
      'not-an-object'
    ]
  };
  assert.deepEqual(activeEntries(character), []);
  assert.doesNotThrow(() => resolveFx(character, 1000));
  assert.equal(resolveFx(character, 1000).scale, 1);

  const unknown = equip(character, { uid: 'u-1', id: 'missing-item' });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.reason, 'unknown-effect');

  assert.equal(equip(null, 'big-o-bracelet').reason, 'no-character');
  assert.equal(unequip(character, 'not-equipped').reason, 'not-equipped');
  assert.equal(resolveFx(null).scale, 1);
  assert.equal(composeRenderTransform(null, null).scale, 1);
  assert.equal(easeWeight('linear', 0.5), 0.5);
});

test('equip works from item or effect ids without a catalog entry', () => {
  const character = { inventory: [], equipped: [] };
  const byItem = equip(character, 'big-o-bracelet');
  assert.equal(byItem.ok, true);
  assert.equal(byItem.effectId, 'big-o');
  assert.equal(resolveFx(character).scale, 1.5);

  const byEffect = equip(character, 'chamo');
  assert.equal(byEffect.ok, true);
  assert.equal(byEffect.effectId, 'chamo');
  assert.equal(resolveFx(character).alpha, 0.4);
});
