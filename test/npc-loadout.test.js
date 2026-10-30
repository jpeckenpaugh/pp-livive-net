import test from 'node:test';
import assert from 'node:assert/strict';
import { EFFECT_CATALOG, equip } from '../src/effects.js';
import { createItemInstance } from '../src/inventory.js';
import {
  LOADOUT_TARGETS,
  planAutoEquip,
  autoEquipOwner,
  transferItem
} from '../src/npc/loadout.js';

function makeCharacter(id, itemIds = []) {
  return {
    id,
    inventory: itemIds.map(itemId => createItemInstance(itemId)),
    equipped: [],
    effectGhosts: []
  };
}

function equipFirst(character) {
  const result = equip(character, character.inventory[0]);
  assert.equal(result.ok, true, `expected ${character.inventory[0].id} to equip`);
  return character.inventory[0];
}

test('self effects prefer the owner over companions', () => {
  const owner = makeCharacter('npc-1', ['hover-halo']);
  const buddy = makeCharacter('comp-1');

  const plan = planAutoEquip(owner, [buddy]);
  assert.equal(plan.skipped.length, 0);
  assert.equal(plan.moves.length, 1);
  assert.equal(plan.moves[0].targetId, 'npc-1');
  assert.equal(plan.moves[0].effectId, 'hover-halo');
  assert.equal(plan.moves[0].slot, 'head');
  assert.equal(plan.moves[0].uid, owner.inventory[0].uid);

  // Planning is pure: nothing moved or equipped yet.
  assert.equal(owner.inventory.length, 1);
  assert.equal(owner.equipped.length, 0);
  assert.equal(buddy.inventory.length, 0);
});

test('any effects fall through to a companion when the owner slot is full', () => {
  const owner = makeCharacter('npc-1', ['teleport-tricorder', 'glowworm-jar']);
  equipFirst(owner);
  const buddy = makeCharacter('comp-1');

  const plan = planAutoEquip(owner, [buddy]);
  assert.equal(plan.moves.length, 1);
  assert.equal(plan.moves[0].effectId, 'glowworm-jar');
  assert.equal(plan.moves[0].targetId, 'comp-1');

  const result = autoEquipOwner(owner, [buddy]);
  assert.deepEqual(result.equipped.map(entry => entry.targetId), ['comp-1']);
  assert.equal(result.skipped.length, 0);
  assert.deepEqual(buddy.equipped.map(entry => entry.slot), ['hand']);
});

test('party effects stay on the owner even when a companion has room', () => {
  const owner = makeCharacter('npc-1', ['buddy-cape']);
  const buddy = makeCharacter('comp-1');

  const plan = planAutoEquip(owner, [buddy]);
  assert.equal(plan.moves.length, 1);
  assert.equal(plan.moves[0].targetId, 'npc-1');
  assert.equal(plan.moves[0].slot, 'back');

  const result = autoEquipOwner(owner, [buddy]);
  assert.equal(result.equipped.length, 1);
  assert.equal(result.moved.length, 0);
  assert.deepEqual(owner.equipped.map(entry => entry.uid), [owner.inventory[0].uid]);
  assert.equal(buddy.inventory.length, 0);
});

test('full slots leave the item in the bag without swapping worn effects', () => {
  const owner = makeCharacter('npc-1', ['teleport-tricorder', 'glowworm-jar']);
  const worn = equipFirst(owner);
  const buddy = makeCharacter('comp-1', ['teleport-tricorder']);
  const buddyWorn = equipFirst(buddy);

  const result = autoEquipOwner(owner, [buddy]);
  assert.equal(result.equipped.length, 0);
  assert.equal(result.moved.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].effectId, 'glowworm-jar');
  assert.equal(result.skipped[0].reason, 'no-free-slot');

  assert.equal(owner.inventory.length, 2, 'the jar stays in the bag');
  assert.ok(owner.inventory.some(item => item.id === 'glowworm-jar'));
  assert.deepEqual(owner.equipped.map(entry => entry.uid), [worn.uid]);
  assert.deepEqual(buddy.equipped.map(entry => entry.uid), [buddyWorn.uid]);
});

test('companion transfers preserve uid and leave one copy in the right bag', () => {
  const owner = makeCharacter('npc-1', ['teleport-tricorder']);
  const { uid: tricorderUid } = equipFirst(owner);
  const jar = createItemInstance('glowworm-jar', { uid: 'jar-keep' });
  owner.inventory.push(jar);
  const buddy = makeCharacter('comp-1');

  const result = autoEquipOwner(owner, [buddy], { now: 500 });
  assert.equal(result.equipped.length, 1);
  assert.equal(result.equipped[0].targetId, 'comp-1');
  assert.equal(result.equipped[0].uid, 'jar-keep');
  assert.deepEqual(result.moved, [{
    item: jar,
    uid: 'jar-keep',
    itemId: 'glowworm-jar',
    fromId: 'npc-1',
    toId: 'comp-1'
  }]);

  assert.equal(owner.inventory.length, 1);
  assert.deepEqual(owner.inventory.map(item => item.uid), [tricorderUid]);
  assert.deepEqual(buddy.inventory.map(item => item.uid), ['jar-keep']);
  assert.deepEqual(buddy.equipped.map(entry => entry.uid), ['jar-keep']);
  assert.equal(buddy.equipped[0].since, 500);
  assert.equal(owner.equipped.length, 1);
});

test('already-equipped items are never re-homed and reruns are idempotent', () => {
  const owner = makeCharacter('npc-1', ['hover-halo', 'glowworm-jar']);
  const buddy = makeCharacter('comp-1');

  const first = autoEquipOwner(owner, [buddy]);
  assert.deepEqual(first.equipped.map(entry => entry.effectId).sort(), ['glowworm-jar', 'hover-halo']);
  assert.equal(first.moved.length, 0);
  assert.equal(owner.inventory.length, 2);

  const second = autoEquipOwner(owner, [buddy]);
  assert.deepEqual(second.equipped, []);
  assert.deepEqual(second.moved, []);
  assert.deepEqual(second.skipped, []);
  assert.equal(owner.equipped.length, 2);
  assert.equal(buddy.inventory.length, 0);
  assert.equal(buddy.equipped.length, 0);
});

test('non-effect and unknown items are ignored entirely', () => {
  const owner = makeCharacter('npc-1', ['ball', 'tic-tac-toe', 'checkers', 'chess']);
  owner.inventory.push({ id: 'mystery-trinket', uid: 'mystery-1' });

  const plan = planAutoEquip(owner, []);
  assert.deepEqual(plan.moves, []);
  assert.deepEqual(plan.skipped, []);

  const result = autoEquipOwner(owner, []);
  assert.deepEqual(result.equipped, []);
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(result.moved, []);
  assert.equal(owner.inventory.length, 5);
  assert.equal(owner.equipped.length, 0);

  assert.deepEqual(planAutoEquip(null), { moves: [], skipped: [] });
  assert.deepEqual(autoEquipOwner(null), { equipped: [], skipped: [], moved: [] });
  assert.equal(transferItem(owner, null, 'ball').reason, 'no-character');
});

test('candidate ordering is deterministic by ai.priority then item id', () => {
  const inventory = ['echo-bell', 'buddy-cape', 'glowworm-jar', 'teleport-tricorder'];
  const forward = makeCharacter('npc-1', inventory);
  const backward = makeCharacter('npc-1', [...inventory].reverse());
  const buddy = makeCharacter('comp-1');

  const expected = ['buddy-cape', 'glowworm-jar', 'tricorder', 'echo-bell'];
  const first = planAutoEquip(forward, [buddy]);
  const second = planAutoEquip(backward, [buddy]);

  assert.deepEqual(first.moves.map(move => move.effectId), expected);
  assert.deepEqual(second.moves.map(move => move.effectId), expected);
  assert.deepEqual(
    first.moves.map(move => move.targetId),
    ['npc-1', 'npc-1', 'comp-1', 'npc-1']
  );
  assert.equal(first.skipped.length, 0);

  // Equal priorities fall back to item id: glowworm-jar before teleport-tricorder.
  assert.ok(first.moves.some(move => move.effectId === 'glowworm-jar'));
  assert.ok(
    first.moves.findIndex(move => move.effectId === 'glowworm-jar')
      < first.moves.findIndex(move => move.effectId === 'tricorder')
  );
});

test('every effect ships valid ai metadata with the approved tiers', () => {
  const expected = {
    'buddy-cape': [60, 'self'],
    'lucky-clover': [55, 'self'],
    'big-o': [50, 'self'],
    'hover-halo': [45, 'self'],
    'chamo': [40, 'self'],
    'prism-pin': [35, 'self'],
    'wings': [32, 'self'],
    'glowworm-jar': [30, 'any'],
    'tricorder': [30, 'any'],
    'bouncy-boots': [25, 'self'],
    'echo-bell': [20, 'any']
  };

  assert.equal(Object.keys(EFFECT_CATALOG).length, 11);
  for (const [effectId, [priority, target]] of Object.entries(expected)) {
    const effect = EFFECT_CATALOG[effectId];
    assert.ok(effect, `missing effect ${effectId}`);
    assert.equal(effect.ai.priority, priority, `${effectId} priority`);
    assert.equal(effect.ai.target, target, `${effectId} target`);
  }

  for (const effect of Object.values(EFFECT_CATALOG)) {
    assert.ok(Number.isFinite(effect.ai.priority) && effect.ai.priority >= 0);
    assert.ok(LOADOUT_TARGETS.includes(effect.ai.target), `${effect.id} ai target`);
  }
});

test('buddy-target effects only consider active companions', () => {
  const treat = { id: 'buddy-treat', uid: 'treat-1', effect: 'buddy-treat' };
  const owner = { id: 'npc-1', inventory: [treat], equipped: [], effectGhosts: [] };
  const buddy = makeCharacter('comp-1');
  const effects = {
    'buddy-treat': {
      id: 'buddy-treat',
      slot: 'hand',
      target: 'buddy',
      stacking: 'unique',
      ai: { priority: 10, target: 'buddy' }
    }
  };

  const plan = planAutoEquip(owner, [buddy], { effects });
  assert.equal(plan.moves.length, 1);
  assert.equal(plan.moves[0].targetId, 'comp-1');

  const solo = planAutoEquip(owner, [], { effects });
  assert.equal(solo.moves.length, 0);
  assert.equal(solo.skipped[0].reason, 'no-free-slot');
});
