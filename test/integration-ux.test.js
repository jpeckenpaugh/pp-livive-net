import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveGameChoices } from '../src/dialogue.js';
import { itemAction } from '../src/ui/panels.js';
import { MiniGameHost } from '../src/minigames/host.js';
import { registerContractGames } from '../src/games/contract-adapters.js';
import { buildAbandonPrompt, dialogueForMeta } from '../src/minigames/settlement.js';
import { equip, unequip, activeEntries, getEffectForItem } from '../src/effects.js';
import { ITEM_CATALOG } from '../src/inventory.js';
import miniGamesData from '../data/minigames.json' with { type: 'json' };
import dialogues from '../data/dialogues.json' with { type: 'json' };
import effectsConfig from '../data/effects.json' with { type: 'json' };

const metas = Object.values(miniGamesData.miniGames);

test('dialogue games list is generic and keeps the legacy flags working', () => {
  const generic = resolveGameChoices({
    games: [
      { id: 'tic-tac-toe', label: 'Tic-Tac-Toe', enabled: true },
      { id: 'checkers', label: 'Checkers', enabled: false },
      { id: 'chess', label: 'Chess', enabled: true }
    ]
  });
  assert.deepEqual(generic.map(game => game.id), ['tic-tac-toe', 'chess']);
  assert.equal(generic[0].primary, true);
  assert.equal(generic[1].primary, false);

  const legacy = resolveGameChoices(
    { canPlayTicTacToe: true, canPlayCheckers: false, canPlayChess: true },
    dialogues.dialogues.friend
  );
  assert.deepEqual(legacy.map(game => game.id), ['tic-tac-toe', 'chess']);
  assert.equal(legacy[0].label, dialogues.dialogues.friend.playTttLabel);
});

test('bag items dispatch through metadata instead of item ids', () => {
  const ttt = ITEM_CATALOG['tic-tac-toe'];
  assert.deepEqual(itemAction(ttt, metas), {
    type: 'unfurl',
    gameId: 'tic-tac-toe',
    meta: miniGamesData.miniGames['tic-tac-toe'],
    item: ttt
  });

  const ball = ITEM_CATALOG.ball;
  assert.equal(itemAction(ball, metas).type, 'throw');

  const bracelet = ITEM_CATALOG['big-o-bracelet'];
  assert.equal(itemAction(bracelet, metas).type, 'equip');
  assert.equal(getEffectForItem(bracelet).id, 'big-o');

  assert.equal(itemAction({ id: 'mystery', name: 'Mystery', action: 'unfurl' }, metas).type, 'none');
  assert.equal(itemAction(null, metas).type, 'none');
});

test('every mini-game dialogue key resolves to dialogue data', () => {
  for (const meta of metas) {
    const spec = dialogueForMeta(meta, dialogues);
    assert.ok(spec, `missing dialogue spec for ${meta.id}`);
    assert.equal(typeof spec.win, 'string');
    assert.ok(Array.isArray(spec.endChoices));
  }

  const abandon = buildAbandonPrompt({
    meta: miniGamesData.miniGames['tic-tac-toe'],
    opponentName: 'Fern',
    dialogueSpec: dialogues.dialogues.ttt
  });
  assert.match(abandon.text, /Fern/);
  assert.ok(abandon.choices.some(choice => choice.action === 'abandon'));
});

test('social bubble lines exist for behavior events', () => {
  for (const key of ['greet', 'chat', 'invite', 'friend']) {
    assert.equal(typeof dialogues.social[key], 'string');
  }
});

test('host registers all six metadata-backed adapters', () => {
  const host = new MiniGameHost({ game: { terrain: null } });
  const results = registerContractGames(host, miniGamesData.miniGames);
  assert.equal(results.length, 6);
  assert.ok(results.every(result => result.ok));
  assert.deepEqual(
    results.map(result => result.id).sort(),
    ['checkers', 'chess', 'connect-four', 'fetch', 'memory-grid', 'tic-tac-toe']
  );
  assert.equal(host.getMeta('fetch').itemId, 'ball');
  assert.equal(host.getMeta('chess').dialogueKey, 'chess');
});

test('all ten effect items equip and unequip without losing inventory instances', () => {
  const itemIds = Object.values(effectsConfig.effects).map(effect => effect.itemId);
  assert.equal(itemIds.length, 10);
  for (const id of itemIds) assert.ok(ITEM_CATALOG[id], `missing catalog item ${id}`);

  const character = {
    inventory: itemIds.map((id, index) => ({ ...ITEM_CATALOG[id], uid: `${id}-${index}` })),
    equipped: []
  };

  for (const item of character.inventory) {
    const result = equip(character, item, 1000);
    assert.equal(result.ok, true, `failed to equip ${item.id}`);
  }
  // Slots hold 7 at once: head, face, hand, back, feet, and charm x2.
  assert.equal(activeEntries(character, 1000).length, 7);
  assert.equal(character.inventory.length, 10);

  const first = character.equipped[0];
  const removed = unequip(character, first.uid, 1000);
  assert.equal(removed.ok, true);
  assert.equal(activeEntries(character, 1400).length, 6);
  assert.equal(character.inventory.length, 10);
});
