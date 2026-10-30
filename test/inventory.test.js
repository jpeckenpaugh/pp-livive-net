import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BALL_COLORS,
  ITEM_CATALOG,
  getItemDefinition,
  createItemInstance,
  ensureItemUid,
  findItemByUid,
  getItemInstance,
  normalizeInventory,
  createStarterInventory
} from '../src/inventory.js';

test('createStarterInventory keeps the existing catalog behaviour', () => {
  const inventory = createStarterInventory();
  assert.equal(inventory.length, 10);
  assert.deepEqual(
    inventory.map(item => item.id),
    ['ball', 'tic-tac-toe', 'checkers', 'chess', 'memory-grid', 'connect-four', 'big-o-bracelet', 'chamo-clip', 'teleport-tricorder', 'wings']
  );

  const ball = inventory.find(item => item.id === 'ball');
  assert.ok(BALL_COLORS.includes(ball.color));
  assert.equal(ball.name, ITEM_CATALOG.ball.name);
  assert.equal(getItemDefinition('chess').id, 'chess');
  assert.equal(getItemDefinition('missing'), null);
});

test('item instances round-trip through inventory lookup', () => {
  const ball = createItemInstance('ball', { color: '#123456', uid: 'ball-test' });
  assert.equal(ball.id, 'ball');
  assert.equal(ball.uid, 'ball-test');
  assert.equal(ball.color, '#123456');
  assert.equal(ball.name, ITEM_CATALOG.ball.name);

  const inventory = [ball];
  assert.equal(findItemByUid(inventory, 'ball-test'), ball);
  assert.equal(getItemInstance(inventory, 'ball-test'), ball);
  assert.equal(getItemInstance(inventory, 'ball'), ball);
  assert.equal(getItemInstance(inventory, 'missing'), null);
  assert.equal(getItemInstance(null, 'ball'), null);
});

test('createItemInstance tolerates unknown and invalid ids', () => {
  const unknown = createItemInstance('mystery-trinket', { uid: 'mystery-1' });
  assert.equal(unknown.id, 'mystery-trinket');
  assert.equal(unknown.uid, 'mystery-1');
  assert.equal(unknown.name, undefined);

  const generated = createItemInstance('mystery-trinket');
  assert.equal(typeof generated.uid, 'string');
  assert.ok(generated.uid.length > 0);

  assert.equal(createItemInstance(''), null);
  assert.equal(createItemInstance(null), null);
});

test('ensureItemUid migrates legacy id-only items deterministically', () => {
  const legacy = { id: 'ball' };
  assert.equal(ensureItemUid(legacy, 2), 'ball-2');
  assert.equal(legacy.uid, 'ball-2');
  assert.equal(ensureItemUid(legacy, 7), 'ball-2');

  const nameless = {};
  assert.equal(ensureItemUid(nameless, 0), 'item-0');
  assert.equal(ensureItemUid(null), null);
});

test('normalizeInventory upgrades legacy entries and skips junk', () => {
  const normalized = normalizeInventory([
    { id: 'ball' },
    { id: 'ball' },
    { id: 'chess', uid: 'chess-keep' },
    'tic-tac-toe',
    null,
    42
  ]);

  assert.equal(normalized.length, 4);
  const uids = normalized.map(item => item.uid);
  assert.equal(new Set(uids).size, uids.length);
  assert.ok(uids.every(uid => typeof uid === 'string' && uid));
  assert.equal(normalized[2].uid, 'chess-keep');

  const strings = normalized.filter(item => item.id === 'tic-tac-toe');
  assert.equal(strings.length, 1);
  assert.ok(strings[0].uid);

  assert.deepEqual(normalizeInventory(null), []);
});
