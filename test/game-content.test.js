import test from 'node:test';
import assert from 'node:assert/strict';
import { itemAction } from '../src/ui/panels.js';
import { MiniGameHost } from '../src/minigames/host.js';
import {
  ADAPTER_FACTORIES,
  registerContractGames
} from '../src/games/contract-adapters.js';
import { MEMORY_GRID_SIZE } from '../src/games/memory-grid.js';
import {
  CONNECT_FOUR_COLUMNS,
  CONNECT_FOUR_ROWS
} from '../src/games/connect-four.js';
import itemsData from '../data/items.json' with { type: 'json' };
import miniGamesData from '../data/minigames.json' with { type: 'json' };
import dialoguesData from '../data/dialogues.json' with { type: 'json' };
import rewardsData from '../data/rewards.json' with { type: 'json' };

const metas = miniGamesData.miniGames;
const metaList = Object.values(metas);
const catalog = itemsData.catalog;
const starterIds = itemsData.starter.map(spec => spec.id);
const ALL_GAME_IDS = ['checkers', 'chess', 'connect-four', 'fetch', 'memory-grid', 'tic-tac-toe'];

test('every mini-game item exists in the catalog and the starter backpack', () => {
  for (const meta of metaList) {
    assert.ok(catalog[meta.itemId], `${meta.id} itemId ${meta.itemId} is missing from the catalog`);
    assert.ok(
      starterIds.includes(meta.itemId),
      `${meta.id} itemId ${meta.itemId} is missing from the starter inventory`
    );
  }

  for (const id of ['memory-grid', 'connect-four']) {
    const item = catalog[id];
    assert.equal(item.action, 'unfurl', `${id} should unfurl from the backpack`);
    assert.equal(typeof item.icon, 'string');
    assert.ok(item.icon.length > 0, `${id} needs an icon`);
    assert.equal(typeof item.description, 'string');
    assert.ok(item.description.length > 0, `${id} needs a friendly description`);
    assert.ok(starterIds.includes(id), `${id} should be in the starter inventory`);
  }
});

test('every mini-game dialogue key resolves with win, loss, draw, abandon, and end choices', () => {
  for (const meta of metaList) {
    const spec = dialoguesData.dialogues[meta.dialogueKey];
    assert.ok(spec, `${meta.id} dialogueKey ${meta.dialogueKey} does not resolve`);

    if (meta.kind !== 'board') continue;
    for (const outcome of ['win', 'loss', 'draw']) {
      assert.equal(typeof spec[outcome], 'string', `${meta.id} dialogue is missing ${outcome}`);
    }
    assert.match(spec.abandonPrompt, /\{name\}/, `${meta.id} abandonPrompt needs {name}`);
    assert.ok(
      spec.abandonChoices.some(choice => choice.action === 'abandon'),
      `${meta.id} abandonChoices needs an abandon action`
    );
    assert.ok(
      spec.endChoices.some(choice => choice.action === 'play_again'),
      `${meta.id} endChoices needs play again`
    );
    assert.ok(
      spec.endChoices.some(choice => choice.action === 'pack_up'),
      `${meta.id} endChoices needs pack up`
    );
  }
});

test('every mini-game reward key resolves for each competitive outcome', () => {
  for (const meta of metaList) {
    const spec = rewardsData.miniGames[meta.rewardKey];
    assert.ok(spec, `${meta.id} rewardKey ${meta.rewardKey} does not resolve`);
    if (meta.kind !== 'board') continue;

    for (const outcome of ['win', 'loss', 'draw']) {
      assert.ok(spec[outcome], `${meta.id} rewards are missing ${outcome}`);
      assert.ok(Number.isFinite(spec[outcome].coins), `${meta.id}.${outcome} needs coins`);
    }

    if (spec.win.bonusLootTable) {
      const table = rewardsData.lootTables[spec.win.bonusLootTable];
      assert.ok(Array.isArray(table) && table.length > 0, `${meta.id} bonus loot table is missing`);
    }
  }

  assert.deepEqual(rewardsData.miniGames['memory-grid'], {
    win: { coins: 15, bonusRollChance: 0.4, bonusLootTable: 'memory_grid_win_loot' },
    draw: { coins: 5 },
    loss: { coins: 2 }
  });
  assert.deepEqual(rewardsData.miniGames['connect-four'], {
    win: { coins: 20, bonusRollChance: 0.5, bonusLootTable: 'connect_four_win_loot' },
    draw: { coins: 6 },
    loss: { coins: 2 }
  });
});

test('memory-grid and connect-four bag items unfurl by metadata id', () => {
  for (const id of ['memory-grid', 'connect-four']) {
    const action = itemAction(catalog[id], metaList);
    assert.equal(action.type, 'unfurl', `${id} should dispatch as unfurl`);
    assert.equal(action.gameId, id);
    assert.equal(action.meta, metas[id]);
    assert.equal(action.item.id, id);
  }

  // Missing metadata still fails closed rather than guessing a game id.
  assert.deepEqual(
    itemAction({ id: 'unknown-toy', action: 'unfurl' }, metaList),
    { type: 'none', item: { id: 'unknown-toy', action: 'unfurl' } }
  );
});

test('host registry registers all six metadata-backed games without error', () => {
  const host = new MiniGameHost({ game: { terrain: null } });
  const results = registerContractGames(host, metas);

  assert.equal(results.length, 6);
  for (const result of results) {
    assert.equal(result.ok, true, `${result.id} failed to register: ${result.reason || result.message || ''}`);
  }
  assert.deepEqual(results.map(result => result.id).sort(), ALL_GAME_IDS);
  assert.deepEqual(Object.keys(ADAPTER_FACTORIES).sort(), ALL_GAME_IDS);

  for (const id of ALL_GAME_IDS) {
    assert.equal(host.getMeta(id)?.id, id, `${id} should be readable from the host`);
  }
});

test('host can start both new games on open ground with a friend seat', () => {
  const terrain = Array.from({ length: 64 }, () => Array.from({ length: 64 }, () => 'grass'));
  const player = { id: 'player', name: 'You', x: 20, y: 20, direction: 0, moving: false, path: [] };
  const npc = { id: 'npc-1', name: 'Fern', x: 24, y: 20, direction: 0, moving: false, path: [] };
  const world = {
    terrain,
    player,
    npcs: [npc],
    companions: [],
    getCompanionsFor: () => [],
    getCompanionFor: () => null,
    triggerCheer: () => {}
  };

  for (const id of ['memory-grid', 'connect-four']) {
    const host = new MiniGameHost({ game: world });
    registerContractGames(host, metas);
    const started = host.start(id, {
      player,
      opponent: npc,
      placement: { originX: 10, originY: 10 },
      terrain
    });
    assert.equal(started.ok, true, `${id} should start: ${started.message || ''}`);
    assert.deepEqual(host.session.game.getFootprint(), {
      x: 10,
      y: 10,
      width: metas[id].board.width,
      height: metas[id].board.height
    });
    host.packUp();
  }
});

test('new board metadata matches the game classes and their contract shape', () => {
  assert.equal(metas['memory-grid'].board.width, MEMORY_GRID_SIZE);
  assert.equal(metas['memory-grid'].board.height, MEMORY_GRID_SIZE);
  assert.equal(metas['connect-four'].board.width, CONNECT_FOUR_COLUMNS);
  assert.equal(metas['connect-four'].board.height, CONNECT_FOUR_ROWS);

  const cases = [
    ['memory-grid', { width: 4, height: 4, actionLabel: 'flip', title: 'Memory Grid', icon: '🧠' }],
    ['connect-four', { width: 7, height: 6, actionLabel: 'drop', title: 'Connect Four', icon: '🔴' }]
  ];

  for (const [id, expected] of cases) {
    const meta = metas[id];
    assert.equal(meta.title, expected.title);
    assert.equal(catalog[meta.itemId].icon, expected.icon);
    assert.equal(meta.kind, 'board');
    assert.equal(meta.players, 2);
    assert.equal(meta.seats, 2);
    assert.equal(meta.board.margin, 1);
    assert.equal(meta.board.blocksMovement, true);
    assert.deepEqual(meta.board.hiddenZones, []);
    assert.equal(meta.board.width, expected.width);
    assert.equal(meta.board.height, expected.height);
    assert.equal(meta.input.mode, 'tile');
    assert.equal(meta.input.actionLabel, expected.actionLabel);
    assert.deepEqual(meta.renderLayers, ['ground']);
    assert.deepEqual(meta.timing, { openMs: 700, closeMs: 600, turnMs: 700 });
    assert.equal(meta.persist, false);
    assert.equal(meta.activity, 'turn-based');
  }
});
