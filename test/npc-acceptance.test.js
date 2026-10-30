import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import engineConfig from '../data/engine_config.json' with { type: 'json' };
import rewardsConfig from '../data/rewards.json' with { type: 'json' };
import { COMPANION_CAPS } from '../src/game.js';
import { encodeTerrain } from '../src/world.js';
import { migrateSave, serializeSave, SAVE_VERSION } from '../src/storage.js';
import { createItemInstance } from '../src/inventory.js';
import { applyNpcReward, applyReward, rollNpcReward } from '../src/rewards.js';
import { autoEquipOwner } from '../src/npc/loadout.js';
import { awardNpcGame } from '../src/npc/game-rewards.js';
import { npcCardSummary, npcEconomySummary } from '../src/ui/panels.js';
import { createNpcGameAdapter } from '../src/behavior/actions/social.js';
import { compileConfig } from '../src/behavior/config.js';
import { BehaviorRuntime } from '../src/behavior/runtime.js';

const realBehaviors = JSON.parse(
  readFileSync(new URL('../data/behaviors.json', import.meta.url), 'utf8')
);
const behaviorConfig = compileConfig(realBehaviors);

function makeCharacter(id, extra = {}) {
  return {
    id,
    name: extra.name || id,
    coins: 0,
    inventory: [],
    equipped: [],
    stabledCompanions: [],
    ...extra
  };
}

function makeNpc(id, extra = {}) {
  return makeCharacter(id, {
    name: extra.name || id,
    recipe: { style: 'voxel-art' },
    x: 20,
    y: 20,
    ...extra
  });
}

function makeCompanion(id, buddyId, extra = {}) {
  return {
    id,
    name: extra.name || id,
    buddyId,
    isCompanion: true,
    recipe: { style: 'dog' },
    inventory: [],
    equipped: [],
    x: 21,
    y: 20,
    ...extra
  };
}

function makeGame({ companions = [], npcs = [] } = {}) {
  const player = makeCharacter('player', {
    name: 'You',
    isPlayer: true,
    x: 30,
    y: 30,
    recipe: { style: 'voxel-art' }
  });
  return {
    player,
    npcs,
    companions: [...companions],
    makeCompanion(input, buddy) {
      return {
        ...input,
        id: input.id || `comp-${Math.random().toString(36).slice(2, 9)}`,
        buddyId: buddy.id,
        isCompanion: true,
        inventory: Array.isArray(input.inventory) ? input.inventory : [],
        equipped: Array.isArray(input.equipped) ? input.equipped : []
      };
    },
    getCompanionsFor(id) {
      return this.companions.filter(comp => comp.buddyId === id);
    }
  };
}

/** Deterministic random that yields `values` in order, then `fallback`. */
function scripted(values, fallback = 0.99) {
  let index = 0;
  return () => (index < values.length ? values[index++] : fallback);
}

function playerSnapshot(player) {
  return structuredClone({
    coins: player.coins,
    inventory: player.inventory,
    equipped: player.equipped,
    stabledCompanions: player.stabledCompanions
  });
}

function grassTerrain() {
  return Array.from({ length: 64 }, () => Array.from({ length: 64 }, () => 'grass'));
}

/**
 * Minimal MiniGameHost stand-in with a real legacy TTT board. The NPC driver
 * can advance it one poll at a time; player-facing hooks are tracked so a
 * leak is visible.
 */
function createTttHost(grid = Array(9).fill(null)) {
  const calls = {
    recordGameResult: 0,
    rollReward: 0,
    applyReward: 0,
    onGameEnd: 0,
    onToast: 0,
    close: []
  };
  const hooks = {
    recordGameResult() { calls.recordGameResult += 1; },
    rollReward() { calls.rollReward += 1; return { coins: 99 }; },
    applyReward() { calls.applyReward += 1; return ['player reward']; },
    onGameEnd() { calls.onGameEnd += 1; },
    onToast() { calls.onToast += 1; },
    onCheer() { calls.onCheer = (calls.onCheer || 0) + 1; }
  };

  const lines = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8],
    [0, 3, 6], [1, 4, 7], [2, 5, 8],
    [0, 4, 8], [2, 4, 6]
  ];

  let session = null;
  let closed = false;
  let outcome = null;

  const legacy = {
    game: { terrain: null },
    activeBoard: {
      originX: 10,
      originY: 10,
      sidelineX: 13,
      sidelineY: 11,
      grid: [...grid],
      winner: null,
      status: 'playing',
      npcSeatTargets: [{ x: 9, y: 11 }, { x: 13, y: 11 }]
    },
    checkWinner() {
      const cells = legacy.activeBoard.grid;
      for (const [a, b, c] of lines) {
        if (cells[a] && cells[a] === cells[b] && cells[a] === cells[c]) return cells[a];
      }
      return cells.every(cell => cell !== null) ? 'draw' : null;
    }
  };

  const host = {
    hooks,
    get session() { return session; },
    isOpen: () => Boolean(session),
    get activeGameId() { return session ? 'tic-tac-toe' : null; },
    start(gameId, options = {}) {
      const seats = (options.seats || []).map((seat, index) => ({ ...seat, index }));
      session = {
        id: 'npc-ttt-qa',
        meta: { id: gameId, title: 'Tic-Tac-Toe' },
        game: { legacy },
        seats,
        participants: seats.map(seat => seat.character),
        settled: false
      };
      closed = false;
      return { ok: true, gameId, session, meta: session.meta, phase: 'playing' };
    },
    getState() {
      return {
        active: Boolean(session),
        gameId: 'tic-tac-toe',
        phase: closed ? 'closed' : 'playing',
        settled: closed,
        outcome
      };
    },
    close(options = {}) {
      calls.close.push({ ...options });
      closed = true;
      outcome = options.outcome ?? null;
      session = null;
      return { ok: true, gameId: 'tic-tac-toe', reason: options.reason, settlement: null };
    },
    getMeta(gameId) {
      return { id: gameId, title: 'Tic-Tac-Toe', board: null };
    }
  };

  return { host, calls, legacy };
}

function advanceNpcGame(adapter, token, steps = 20) {
  let status = null;
  for (let i = 0; i < steps; i++) {
    status = adapter.status(token);
    if (status.closed || status.active === false) return status;
  }
  return status;
}

test('an NPC win credits only the winner with coins, an item, and a buddy', () => {
  const npc = makeNpc('npc-1', { name: 'Fern' });
  const opponent = makeNpc('npc-2', { name: 'Moss' });
  const game = makeGame({ npcs: [npc, opponent] });
  game.player.coins = 42;
  game.player.inventory.push(createItemInstance('ball', { uid: 'ball-player' }));

  const reward = rollNpcReward(game, npc, 'tic-tac-toe', 'win', {
    // item chance, first pool item, buddy chance, buddy name, no bonus roll
    random: scripted([0, 0, 0, 0, 0.99])
  });

  assert.equal(reward.coins, 2);
  assert.deepEqual(reward.items, [{ id: 'big-o-bracelet' }]);
  assert.equal(reward.newCompanion.buddyId, 'npc-1');

  const notices = applyNpcReward(game, npc, reward);

  assert.equal(npc.coins, 2);
  assert.equal(npc.inventory.length, 1);
  assert.equal(npc.inventory[0].id, 'big-o-bracelet');
  assert.equal(typeof npc.inventory[0].uid, 'string');
  assert.equal(game.companions.length, 1);
  assert.equal(game.companions[0].buddyId, 'npc-1');
  assert.equal(game.companions[0].isCompanion, true);
  assert.ok(notices.some(notice => notice.includes('Big-O Bracelet')));

  assert.equal(opponent.coins, 0, 'the loser gets nothing');
  assert.equal(opponent.inventory.length, 0);

  assert.equal(game.player.coins, 42, 'player coins are untouched');
  assert.deepEqual(game.player.inventory.map(item => item.uid), ['ball-player']);
  assert.deepEqual(game.player.stabledCompanions, []);
  assert.equal(game.companions.some(comp => comp.buddyId === 'player'), false);
});

test('won items auto-equip on the winner first and then on an active buddy', () => {
  const npc = makeNpc('npc-1', { name: 'Fern' });
  const buddy = makeCompanion('comp-1', 'npc-1', { name: 'Pip', x: 21, y: 20 });
  const game = makeGame({ npcs: [npc], companions: [buddy] });

  const first = rollNpcReward(game, npc, 'tic-tac-toe', 'win', {
    // item chance, pick glowworm-jar (index 7 of the 11-item pool), no buddy/bonus
    random: scripted([0, 0.65, 0.99, 0.99])
  });
  const second = rollNpcReward(game, npc, 'tic-tac-toe', 'win', {
    // item chance, pick teleport-tricorder (last pool item), no buddy/bonus
    random: scripted([0, 0.99, 0.99, 0.99])
  });

  assert.deepEqual(first.items, [{ id: 'glowworm-jar' }]);
  assert.deepEqual(second.items, [{ id: 'teleport-tricorder' }]);
  assert.equal(first.newCompanion, null);
  assert.equal(second.newCompanion, null);

  applyNpcReward(game, npc, first);
  applyNpcReward(game, npc, second);
  assert.equal(npc.coins, 4);
  assert.equal(npc.inventory.length, 2);

  const result = autoEquipOwner(npc, [buddy]);

  assert.deepEqual(result.moved.map(move => move.toId), ['comp-1']);
  assert.equal(result.equipped.length, 2);
  assert.equal(result.skipped.length, 0);

  // Both are hand effects at priority 30; the item id breaks the tie.
  assert.deepEqual(npc.equipped.map(entry => entry.slot), ['hand']);
  assert.deepEqual(buddy.equipped.map(entry => entry.slot), ['hand']);
  assert.equal(npc.inventory.length, 1, 'the equipped owner instance stays in the NPC bag');
  assert.equal(buddy.inventory.length, 1, 'the transferred item moved to the buddy bag');

  const glowworm = npc.inventory.find(item => item.id === 'glowworm-jar');
  const tricorder = buddy.inventory.find(item => item.id === 'teleport-tricorder');
  assert.ok(glowworm);
  assert.ok(tricorder);
  assert.equal(npc.equipped[0].uid, glowworm.uid, 'the higher-sorting item stays on the owner');
  assert.equal(buddy.equipped[0].uid, tricorder.uid, 'the next item falls through to the buddy');
});

test('NPCs cap at two active buddies, reserve the rest, and stop at six reserves', () => {
  const npc = makeNpc('npc-1', { name: 'Fern' });
  const game = makeGame({
    npcs: [npc],
    companions: [
      makeCompanion('comp-a', 'npc-1'),
      makeCompanion('comp-b', 'npc-1')
    ]
  });

  assert.equal(COMPANION_CAPS.npcActiveMax, engineConfig.companions.npcActiveMax);
  assert.equal(COMPANION_CAPS.npcReserveMax, engineConfig.companions.npcReserveMax);

  applyNpcReward(game, npc, {
    newCompanion: { id: 'comp-reserve-1', name: 'Pip', recipe: { style: 'dog' } }
  });

  assert.equal(game.getCompanionsFor('npc-1').length, 2, 'no third follower spawns');
  assert.equal(npc.stabledCompanions.length, 1);
  assert.equal(npc.stabledCompanions[0].buddyId, 'npc-1');
  assert.deepEqual(npc.stabledCompanions[0].inventory, []);
  assert.deepEqual(npc.stabledCompanions[0].equipped, []);

  for (let index = 2; index <= COMPANION_CAPS.npcReserveMax; index++) {
    applyNpcReward(game, npc, {
      newCompanion: { id: `comp-reserve-${index}`, name: `Buddy ${index}` }
    });
  }
  assert.equal(npc.stabledCompanions.length, COMPANION_CAPS.npcReserveMax);

  let overflowNotices;
  assert.doesNotThrow(() => {
    overflowNotices = applyNpcReward(game, npc, {
      newCompanion: { id: 'comp-overflow', name: 'Too Many' }
    });
  });

  assert.equal(npc.stabledCompanions.length, COMPANION_CAPS.npcReserveMax);
  assert.equal(game.getCompanionsFor('npc-1').length, 2);
  assert.ok(overflowNotices.some(notice => notice.includes('collection is full')));
});

test('auto-loadout never swaps or discards a full slot', () => {
  const npc = makeNpc('npc-1', { name: 'Fern' });
  const wornNpc = createItemInstance('teleport-tricorder', { uid: 'tricorder-npc' });
  npc.inventory.push(wornNpc, createItemInstance('glowworm-jar', { uid: 'jar-npc' }));
  npc.equipped.push({ slot: 'hand', uid: 'tricorder-npc' });

  const buddy = makeCompanion('comp-1', 'npc-1', { name: 'Pip' });
  const wornBuddy = createItemInstance('teleport-tricorder', { uid: 'tricorder-buddy' });
  buddy.inventory.push(wornBuddy);
  buddy.equipped.push({ slot: 'hand', uid: 'tricorder-buddy' });

  const result = autoEquipOwner(npc, [buddy]);

  assert.deepEqual(result.equipped, []);
  assert.deepEqual(result.moved, []);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].effectId, 'glowworm-jar');
  assert.equal(result.skipped[0].reason, 'no-free-slot');

  assert.deepEqual(npc.equipped.map(entry => entry.uid), ['tricorder-npc']);
  assert.deepEqual(buddy.equipped.map(entry => entry.uid), ['tricorder-buddy']);
  assert.ok(npc.inventory.some(item => item.uid === 'jar-npc'), 'the jar stays in the bag');
  assert.deepEqual(buddy.inventory.map(item => item.uid), ['tricorder-buddy']);
});

test('a reward buddy follows its NPC after a behavior-world sync', () => {
  const npc = makeNpc('npc-1', { name: 'Fern', x: 10, y: 10 });
  const game = makeGame({ npcs: [npc] });

  const runtime = new BehaviorRuntime({
    config: behaviorConfig,
    actors: [npc],
    player: game.player,
    deps: {
      tryStep: () => false,
      face: (actor, direction) => { actor.direction = direction; }
    }
  });

  assert.deepEqual(runtime.blackboard.all().map(actor => actor.id), ['npc-1']);

  const buddy = makeCompanion('comp-new', 'npc-1', { name: 'Pip', x: 11, y: 10 });
  applyNpcReward(game, npc, { newCompanion: buddy });

  const active = game.getCompanionsFor('npc-1');
  assert.equal(active.length, 1);
  assert.equal(active[0].buddyId, 'npc-1');

  // Mirrors main.js syncBehaviorWorld({ reset: true }).
  runtime.setWorld({
    actors: [npc, ...game.companions],
    player: game.player,
    now: runtime.now
  });
  assert.deepEqual(
    runtime.blackboard.all().map(actor => actor.id).sort(),
    ['comp-new', 'npc-1']
  );

  let entry = null;
  for (let attempt = 0; attempt < 20; attempt++) {
    runtime.update(250);
    entry = runtime.getEntry('comp-new');
    if (entry?.behaviorId === 'follow') break;
  }

  assert.ok(entry, 'the new buddy is registered with the behavior runtime');
  assert.equal(entry.behaviorId, 'follow', 'the new buddy starts following without a reload');
  assert.equal(entry.target?.id, 'npc-1');
  assert.equal(runtime.blackboard.buddy(active[0]).id, 'npc-1');
});

test('NPC coins, active gear, and reserve buddies survive a save round-trip', () => {
  const npc = makeNpc('npc-1', {
    name: 'Fern',
    x: 24,
    y: 20,
    coins: 7,
    inventory: [createItemInstance('hover-halo', { uid: 'halo-npc' })],
    equipped: [{ slot: 'head', uid: 'halo-npc' }],
    stabledCompanions: [{
      id: 'comp-reserve',
      name: 'Mo',
      buddyId: 'npc-1',
      recipe: { style: 'dog' },
      coins: 3,
      inventory: [createItemInstance('lucky-clover', { uid: 'clover-reserve' })],
      equipped: [{ slot: 'charm', uid: 'clover-reserve' }],
      stabledCompanions: []
    }]
  });
  const activeBuddy = makeCompanion('comp-active', 'npc-1', {
    name: 'Pip',
    inventory: [createItemInstance('prism-pin', { uid: 'pin-active' })],
    equipped: [{ slot: 'charm', uid: 'pin-active' }]
  });
  const player = makeCharacter('player', {
    name: 'You',
    isPlayer: true,
    x: 20,
    y: 20,
    coins: 11
  });
  const game = {
    terrain: grassTerrain(),
    worldSeed: 1234,
    player,
    npcs: [npc],
    companions: [activeBuddy],
    wander: true
  };

  const saved = serializeSave(game, { worldSeed: game.worldSeed }, ['npc-1']);
  assert.ok(saved);
  const restored = migrateSave(JSON.parse(JSON.stringify(saved)));

  assert.ok(restored);
  assert.equal(restored.version, SAVE_VERSION);

  const restoredNpc = restored.npcs[0];
  assert.equal(restoredNpc.id, 'npc-1');
  assert.equal(restoredNpc.coins, 7);
  assert.deepEqual(restoredNpc.inventory.map(item => item.uid), ['halo-npc']);
  assert.deepEqual(restoredNpc.equipped, [{ slot: 'head', uid: 'halo-npc' }]);

  assert.equal(restoredNpc.stabledCompanions.length, 1);
  const restoredReserve = restoredNpc.stabledCompanions[0];
  assert.equal(restoredReserve.id, 'comp-reserve');
  assert.equal(restoredReserve.buddyId, 'npc-1');
  assert.equal(restoredReserve.coins, 3);
  assert.deepEqual(restoredReserve.inventory.map(item => item.uid), ['clover-reserve']);
  assert.deepEqual(restoredReserve.equipped, [{ slot: 'charm', uid: 'clover-reserve' }]);

  assert.equal(restored.companions.length, 1);
  assert.equal(restored.companions[0].buddyId, 'npc-1');
  assert.deepEqual(restored.companions[0].inventory.map(item => item.uid), ['pin-active']);
  assert.deepEqual(restored.companions[0].equipped, [{ slot: 'charm', uid: 'pin-active' }]);

  assert.equal(restored.player.coins, 11);
});

test('NPC result settlement fires once with winner/loser and never touches player hooks', () => {
  const npcA = makeNpc('npc-a', { name: 'Fern', x: 9, y: 11 });
  const npcB = makeNpc('npc-b', { name: 'Moss', x: 13, y: 11 });
  const game = makeGame({ npcs: [npcA, npcB] });
  const npcsById = new Map([[npcA.id, npcA], [npcB.id, npcB]]);
  const before = playerSnapshot(game.player);

  const { host, calls } = createTttHost([
    'X', 'X', null,
    'O', 'O', 'X',
    'X', 'O', 'O'
  ]);
  const results = [];
  const adapter = createNpcGameAdapter({
    host,
    onResult(result) {
      results.push(result);
      if (result.outcome !== 'win') return;
      const winner = npcsById.get(result.winnerId);
      if (!winner) return;
      awardNpcGame({
        game,
        winner,
        loser: npcsById.get(result.loserId) || null,
        gameId: result.game,
        outcome: 'win',
        random: () => 0.99
      });
    }
  });

  const started = adapter.start({
    game: 'tic-tac-toe',
    actor: npcA,
    partner: npcB
  });
  assert.equal(started.ok, true, started.reason);

  const status = advanceNpcGame(adapter, started.token);
  assert.equal(status.closed, true);
  assert.equal(results.length, 1, 'the result callback fires exactly once');
  assert.equal(results[0].token, started.token);
  assert.equal(results[0].game, 'tic-tac-toe');
  assert.equal(results[0].winnerId, 'npc-a');
  assert.equal(results[0].loserId, 'npc-b');
  assert.equal(results[0].outcome, 'win');

  assert.equal(npcA.coins, 2, 'the winner is rewarded');
  assert.equal(npcB.coins, 0, 'the loser is not rewarded');

  adapter.status(started.token);
  adapter.finish(started.token);
  assert.equal(results.length, 1, 'repeat polls/finishes do not re-emit');

  assert.equal(calls.recordGameResult, 0, 'no player stats recorded');
  assert.equal(calls.rollReward, 0, 'no player reward rolled');
  assert.equal(calls.applyReward, 0, 'no player reward applied');
  assert.equal(calls.onGameEnd, 0, 'no player end dialogue');
  assert.equal(calls.onToast, 0, 'no player toast');
  assert.equal(calls.close.length, 1);
  assert.equal(calls.close[0].settle, false);
  assert.equal(calls.close[0].record, false);
  assert.equal(calls.close[0].reward, false);
  assert.deepEqual(playerSnapshot(game.player), before, 'player ownership is unchanged');

  assert.equal(typeof host.hooks.recordGameResult, 'function', 'suppressed hooks are restored');
  assert.equal(typeof host.hooks.onToast, 'function');
});

test('a draw pays both participants the configured small coin amount', () => {
  const npcA = makeNpc('npc-a', { name: 'Fern', x: 9, y: 11 });
  const npcB = makeNpc('npc-b', { name: 'Moss', x: 13, y: 11 });
  const game = makeGame({ npcs: [npcA, npcB] });
  const before = playerSnapshot(game.player);

  assert.deepEqual(rewardsConfig.npcMiniGames['tic-tac-toe'].draw, { coins: 1 });

  const { host } = createTttHost([
    'X', 'O', 'X',
    'X', 'O', 'O',
    'O', 'X', null
  ]);
  const results = [];
  const adapter = createNpcGameAdapter({
    host,
    onResult(result) {
      results.push(result);
      if (result.outcome !== 'draw') return;
      const participants = (result.session?.seats || [])
        .map(seat => seat.character)
        .filter(Boolean);
      for (const participant of participants) {
        awardNpcGame({
          game,
          winner: participant,
          loser: participants.find(other => other !== participant) || null,
          gameId: result.game,
          outcome: 'draw',
          random: () => 0.5
        });
      }
    }
  });

  const started = adapter.start({ game: 'tic-tac-toe', actor: npcA, partner: npcB });
  assert.equal(started.ok, true, started.reason);

  const status = advanceNpcGame(adapter, started.token);
  assert.equal(status.closed, true);
  assert.equal(results.length, 1);
  assert.equal(results[0].outcome, 'draw');
  assert.equal(results[0].winnerId, null);
  assert.equal(results[0].loserId, null);

  assert.equal(npcA.coins, 1);
  assert.equal(npcB.coins, 1);
  assert.equal(npcA.inventory.length, 0);
  assert.equal(npcB.inventory.length, 0);
  assert.equal(game.companions.length, 0);
  assert.deepEqual(playerSnapshot(game.player), before);
});

test('the global active companion cap sends a won buddy to reserve at 80', () => {
  const npc = makeNpc('npc-1', { name: 'Fern' });
  const nearCap = Array.from({ length: COMPANION_CAPS.globalActiveMax - 1 }, (_, index) => ({
    id: `comp-${index}`,
    buddyId: `other-${index}`,
    inventory: [],
    equipped: []
  }));
  const game = makeGame({ npcs: [npc], companions: nearCap });

  applyNpcReward(game, npc, {
    newCompanion: { id: 'comp-79', name: 'Pip', recipe: { style: 'dog' } }
  });
  assert.equal(game.companions.length, COMPANION_CAPS.globalActiveMax);
  assert.equal(game.getCompanionsFor('npc-1').length, 1);
  assert.equal(npc.stabledCompanions.length, 0);

  const full = makeGame({
    npcs: [npc],
    companions: Array.from({ length: COMPANION_CAPS.globalActiveMax }, (_, index) => ({
      id: `full-${index}`,
      buddyId: `other-${index}`,
      inventory: [],
      equipped: []
    }))
  });
  const fullNpc = full.npcs[0];

  applyNpcReward(full, fullNpc, {
    newCompanion: { id: 'comp-over', name: 'Mo', recipe: { style: 'dog' } }
  });
  assert.equal(full.companions.length, COMPANION_CAPS.globalActiveMax);
  assert.equal(fullNpc.stabledCompanions.length, 1);
  assert.equal(fullNpc.stabledCompanions[0].buddyId, 'npc-1');

  applyReward(full, { newCompanion: { id: 'comp-player-over', name: 'Too Many' } });
  assert.equal(full.companions.length, COMPANION_CAPS.globalActiveMax);
  assert.equal(full.player.stabledCompanions.length, 1);
});

test('the NPC card summary shows active buddies, reserve, worn gear, and bag', () => {
  const npc = makeNpc('npc-1', {
    name: 'Fern',
    x: 24,
    y: 20,
    coins: 4,
    inventory: [createItemInstance('hover-halo', { uid: 'halo-card' })],
    equipped: [{ slot: 'head', uid: 'halo-card' }],
    stabledCompanions: [{
      id: 'comp-reserve',
      name: 'Mo',
      buddyId: 'npc-1',
      recipe: { style: 'dog' },
      inventory: [],
      equipped: []
    }]
  });
  const activeBuddy = makeCompanion('comp-a', 'npc-1', { name: 'Pip' });
  const playerBuddy = makeCompanion('comp-player', 'player', { name: 'Sunny' });

  const summary = npcCardSummary(npc, {
    companions: [activeBuddy, playerBuddy],
    cap: COMPANION_CAPS.npcActiveMax,
    now: 5000
  });

  assert.equal(summary.isNpc, true);
  assert.equal(summary.kind, 'npc');
  assert.deepEqual(summary.counts, {
    active: 1,
    reserve: 1,
    cap: COMPANION_CAPS.npcActiveMax,
    bag: 1,
    coins: 4
  });
  assert.deepEqual(summary.activeBuddies.map(buddy => buddy.name), ['Pip']);
  assert.deepEqual(summary.reserveBuddies.map(buddy => buddy.name), ['Mo']);
  assert.deepEqual(summary.wornNames, ['Hover Halo']);
  assert.equal(summary.labels.buddies, '1/2 active · 1 in reserve');
  assert.equal(summary.labels.bag, '1 item · 1 effect item');

  assert.equal(npcCardSummary({ id: 'player', isPlayer: true }).isNpc, false);
  assert.equal(npcCardSummary(playerBuddy).isNpc, false);
  assert.equal(npcCardSummary(playerBuddy).kind, 'companion');

  const economy = npcEconomySummary([npc], [activeBuddy, playerBuddy]);
  assert.equal(economy.npcCount, 1);
  assert.equal(economy.globalActive, 2);
  assert.equal(economy.activeBuddies, 1);
  assert.equal(economy.reserveBuddies, 1);
  assert.equal(economy.npcsWithReserve, 1);
  assert.equal(economy.coins, 4);
  assert.equal(economy.label, '2 followers · 1 in reserve · 1/1 NPCs stocked');
});

test('NPC reward application has no player-facing side effects', () => {
  const npc = makeNpc('npc-1', { name: 'Fern' });
  const game = makeGame({ npcs: [npc] });

  const clover = createItemInstance('lucky-clover', { uid: 'clover-player' });
  game.player.coins = 42;
  game.player.inventory.push(clover, createItemInstance('ball', { uid: 'ball-player' }));
  game.player.equipped.push({ slot: 'charm', uid: 'clover-player' });
  game.player.stabledCompanions.push({
    id: 'player-reserve',
    name: 'Pip',
    buddyId: 'player',
    inventory: [],
    equipped: []
  });
  const before = playerSnapshot(game.player);

  const award = awardNpcGame({
    game,
    winner: npc,
    gameId: 'tic-tac-toe',
    outcome: 'win',
    now: 2000,
    random: scripted([0, 0, 0, 0, 0.99])
  });

  assert.equal(award.ok, true);
  assert.equal(award.reward.coins, 2);
  assert.deepEqual(award.reward.items, [{ id: 'big-o-bracelet' }]);
  assert.equal(award.reward.newCompanion.buddyId, 'npc-1');
  assert.equal(npc.coins, 2);
  assert.equal(game.player.coins, 42, 'the player Lucky Clover must not fire for an NPC reward');
  assert.deepEqual(playerSnapshot(game.player), before);
  assert.equal(game.companions.length, 1);
  assert.equal(game.companions[0].buddyId, 'npc-1');
  assert.equal(game.companions.some(comp => comp.buddyId === 'player'), false);
});
