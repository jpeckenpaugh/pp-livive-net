import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MiniGameHost } from '../src/minigames/host.js';
import {
  ADAPTER_FACTORIES,
  registerContractGames
} from '../src/games/contract-adapters.js';
import { createNpcGameAdapter } from '../src/behavior/actions/social.js';
import { compileConfig, resolveAssignment } from '../src/behavior/config.js';
import { createBlackboard, pairKey } from '../src/behavior/blackboard.js';
import { BehaviorRuntime } from '../src/behavior/runtime.js';
import { EventLog } from '../src/behavior/events.js';
import {
  activeEntries,
  equip,
  getTransition,
  resolveFx,
  unequip
} from '../src/effects.js';
import { createItemInstance } from '../src/inventory.js';
import minigamesData from '../data/minigames.json' with { type: 'json' };

const metas = minigamesData.miniGames;
const realBehaviors = JSON.parse(
  readFileSync(new URL('../data/behaviors.json', import.meta.url), 'utf8')
);

function grassTerrain() {
  return Array.from({ length: 64 }, () => Array.from({ length: 64 }, () => 'grass'));
}

function makeWorld() {
  const terrain = grassTerrain();
  const player = {
    id: 'player',
    name: 'You',
    isPlayer: true,
    x: 20,
    y: 20,
    direction: 0,
    moving: false,
    path: [],
    recipe: { style: 'voxel-art' }
  };
  const npc = {
    id: 'npc-1',
    name: 'Fern',
    x: 24,
    y: 20,
    direction: 0,
    moving: false,
    path: [],
    recipe: { style: 'voxel-art' }
  };
  const npc2 = {
    id: 'npc-2',
    name: 'Moss',
    x: 25,
    y: 20,
    direction: 0,
    moving: false,
    path: [],
    recipe: { style: 'voxel-art' }
  };
  const companion = {
    id: 'comp-player',
    name: 'Pip',
    isCompanion: true,
    buddyId: 'player',
    x: 19,
    y: 22,
    direction: 0,
    moving: false,
    path: [],
    fetchTarget: null,
    carryingBall: false
  };
  const world = {
    terrain,
    player,
    npcs: [npc, npc2],
    companions: [companion],
    heldKeys: [],
    destination: null,
    getCompanionsFor: id => (id === 'player' ? [companion] : []),
    getCompanionFor: id => (id === 'player' ? companion : null),
    triggerCheer: () => {}
  };
  return { world, player, npc, npc2, companion };
}

function makeHost(world, hooks = {}) {
  const host = new MiniGameHost({ game: world, hooks });
  const registrations = registerContractGames(host, metas);
  assert.equal(registrations.length, 6);
  assert.ok(registrations.every(result => result.ok === true));
  return host;
}

function seeded(seed = 99) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

test('host registers all six adapter factories and starts each one in an all-grass world', () => {
  assert.deepEqual(
    Object.keys(ADAPTER_FACTORIES).sort(),
    ['checkers', 'chess', 'connect-four', 'fetch', 'memory-grid', 'tic-tac-toe']
  );

  for (const gameId of ['tic-tac-toe', 'checkers', 'chess', 'connect-four', 'memory-grid']) {
    const { world, player, npc } = makeWorld();
    const host = makeHost(world);
    const started = host.start(gameId, {
      player,
      opponent: npc,
      placement: { originX: 10, originY: 10 },
      terrain: world.terrain
    });

    assert.equal(started.ok, true, `${gameId} should start`);
    assert.equal(started.reason, undefined);
    assert.equal(host.activeGameId, gameId);
    assert.equal(host.getState().active, true);
    assert.equal(host.getState().phase, 'playing');

    const board = metas[gameId].board;
    assert.deepEqual(host.session.game.getFootprint(), {
      x: 10,
      y: 10,
      width: board.width,
      height: board.height
    });
    assert.equal(host.isTileOnBoard(10, 10), true);
    assert.equal(host.isTileOnBoard(10 + board.width, 10), false);
    assert.equal(host.getBlockedTiles().size, board.width * board.height);

    assert.doesNotThrow(() => host.update(16));
    const packed = host.packUp();
    assert.equal(packed.ok, true);
    assert.equal(host.isOpen(), false);
    assert.equal(host.getState().active, false);
  }

  const { world, player } = makeWorld();
  const host = makeHost(world);
  const fetchStart = host.start('fetch', {
    seats: [player],
    options: { targetTile: { x: 23, y: 20 }, color: '#ffffff' },
    terrain: world.terrain
  });

  assert.equal(fetchStart.ok, true);
  assert.equal(host.activeGameId, 'fetch');
  assert.equal(host.getState().phase, 'playing');
  assert.equal(host.getMeta('fetch').board, null);
  assert.equal(host.session.game.getFootprint(), null);
  assert.equal(host.getBlockedTiles().size, 0);
  assert.equal(host.isTileOnBoard(23, 20), false);
  assert.equal(host.blocksStep({ id: 'outsider', x: 22, y: 20 }, 23, 20), false);

  assert.doesNotThrow(() => host.update(16));
  assert.equal(host.packUp().ok, true);
  assert.equal(host.isOpen(), false);
});

test('host refuses a second game while one session is open', () => {
  const { world, player, npc } = makeWorld();
  const host = makeHost(world);

  const first = host.start('tic-tac-toe', {
    player,
    opponent: npc,
    placement: { originX: 10, originY: 10 },
    terrain: world.terrain
  });
  assert.equal(first.ok, true);

  const second = host.start('checkers', {
    player,
    opponent: npc,
    placement: { originX: 30, originY: 10 },
    terrain: world.terrain
  });
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'busy');
  assert.equal(second.activeGameId, 'tic-tac-toe');
  assert.match(second.message, /already open/i);

  // The open session must be untouched by the rejected start.
  assert.equal(host.activeGameId, 'tic-tac-toe');
  assert.equal(host.getState().active, true);
  assert.deepEqual(host.session.game.getFootprint(), { x: 10, y: 10, width: 3, height: 3 });
  assert.equal(host.packUp().ok, true);
});

test('board bystanders are blocked on entry but may leave, while participants and companions are exempt', () => {
  const { world, player, npc, companion } = makeWorld();
  const host = makeHost(world);
  const started = host.start('tic-tac-toe', {
    player,
    opponent: npc,
    companions: [companion],
    placement: { originX: 10, originY: 10 },
    terrain: world.terrain
  });
  assert.equal(started.ok, true);

  const outsider = { id: 'outsider', x: 9, y: 10 };
  const onBoard = { id: 'visitor', x: 11, y: 11 };

  assert.equal(host.blocksStep(outsider, 10, 10), true, 'entering the board is blocked');
  assert.equal(host.blocksStep(outsider, 9, 10), false, 'stepping outside the board is allowed');
  assert.equal(host.blocksStep(onBoard, 12, 11), false, 'a bystander already on the board can escape');
  assert.equal(host.blocksStep(player, 10, 10), false, 'seat 0 is exempt');
  assert.equal(host.blocksStep(npc, 10, 10), false, 'seat 1 is exempt');
  assert.equal(host.blocksStep(companion, 10, 10), false, 'participant companions are exempt');
  assert.equal(host.isParticipant(player), true);
  assert.equal(host.isParticipant(outsider), false);
});

test('real catalog effects equip, unequip, compose headline values, and keep motion priority', () => {
  const character = {
    id: 'player',
    inventory: ['big-o-bracelet', 'chamo-clip', 'teleport-tricorder', 'hover-halo']
      .map(id => createItemInstance(id)),
    equipped: [],
    effectGhosts: []
  };
  const byId = new Map(character.inventory.map(item => [item.id, item]));

  for (const item of character.inventory) {
    const result = equip(character, item, 1000);
    assert.equal(result.ok, true, `failed to equip ${item.id}`);
  }

  const active = resolveFx(character, 5000);
  assert.equal(active.scale, 1.5, 'Big-O should scale by 1.5');
  assert.equal(active.alpha, 0.4, 'Chamo should fade to 60% see-through');
  assert.equal(active.motionId, 'teleport', 'teleport motion outranks float');
  assert.equal(active.motionPriority, 100);
  assert.equal(activeEntries(character, 5000).length, 4);
  assert.equal(character.inventory.length, 4, 'equipping must not consume instances');

  const bigO = byId.get('big-o-bracelet');
  const bigTransition = getTransition(active.entries
    .find(entry => entry.effectId === 'big-o').effect);
  const removedBigO = unequip(character, bigO.uid, 6000);
  assert.equal(removedBigO.ok, true);
  assert.equal(removedBigO.ghost, true);

  const afterBigO = resolveFx(character, 6000 + bigTransition.unequipMs + 1);
  assert.equal(afterBigO.scale, 1);
  assert.equal(afterBigO.alpha, 0.4);
  assert.equal(character.inventory.length, 4);

  const chamo = byId.get('chamo-clip');
  const chamoTransition = getTransition(active.entries
    .find(entry => entry.effectId === 'chamo').effect);
  const removedChamo = unequip(character, chamo.uid, 7000);
  assert.equal(removedChamo.ok, true);

  const afterChamo = resolveFx(character, 7000 + chamoTransition.unequipMs + 1);
  assert.equal(afterChamo.alpha, 1);
  assert.equal(afterChamo.motionId, 'teleport', 'the remaining tricorder still wins the motion slot');
  assert.equal(character.inventory.length, 4);
});

test('NPC-vs-NPC Tic-Tac-Toe opens two AI seats and suppresses every player settlement hook', () => {
  const { world, player, npc, npc2 } = makeWorld();
  const calls = { record: 0, reward: 0, end: 0, toast: 0 };
  const host = makeHost(world, {
    recordGameResult() { calls.record += 1; return { totalWins: 1 }; },
    rollReward() { calls.reward += 1; return { coins: 10 }; },
    applyReward() { return ['reward']; },
    onGameEnd() { calls.end += 1; },
    onToast() { calls.toast += 1; }
  });

  const adapter = createNpcGameAdapter({ host });
  const started = adapter.start({
    game: 'tic-tac-toe',
    actor: npc,
    partner: npc2,
    placement: { originX: 10, originY: 10 },
    terrain: world.terrain
  });

  assert.equal(started.ok, true, started.reason);
  assert.equal(host.activeGameId, 'tic-tac-toe');
  const state = host.getState();
  assert.deepEqual(state.participants, [npc.id, npc2.id]);
  assert.equal(state.participants.includes(player.id), false, 'the player is not seated');

  const session = host.session;
  assert.equal(session.seats.length, 2);
  assert.deepEqual(session.seats.map(seat => seat.controller), ['ai', 'ai']);
  assert.deepEqual(session.seats.map(seat => seat.character.id), [npc.id, npc2.id]);

  assert.equal(typeof host.hooks.recordGameResult, 'undefined');
  assert.equal(typeof host.hooks.rollReward, 'undefined');
  assert.equal(typeof host.hooks.onGameEnd, 'undefined');
  assert.equal(typeof host.hooks.onToast, 'undefined');

  session.game.legacy.update = () => {};
  session.game.legacy.activeBoard.status = 'ended';
  session.game.legacy.activeBoard.winner = 'X';
  host.update(16);

  assert.equal(session.settled, true, 'NPC game still settles internally');
  assert.equal(calls.record, 0, 'no player stats recorded');
  assert.equal(calls.reward, 0, 'no player loot rolled');
  assert.equal(calls.end, 0, 'no player end dialogue');
  assert.equal(calls.toast, 0, 'no player toast');

  const finished = adapter.finish(started.token, { outcome: 'draw' });
  assert.equal(finished.ok, true);
  assert.equal(host.isOpen(), false);
  assert.equal(typeof host.hooks.recordGameResult, 'function', 'hooks restored after the NPC game');
  assert.equal(typeof host.hooks.onGameEnd, 'function');
  assert.equal(calls.record, 0);
  assert.equal(calls.end, 0);
});

test('behavior fixture greets twice on cooldown, befriends once, and resolves style follows', () => {
  const config = compileConfig(realBehaviors);
  const npcA = { id: 'npc-a', x: 5, y: 5, recipe: { style: 'voxel-art' } };
  const npcB = { id: 'npc-b', x: 6, y: 5, recipe: { style: 'voxel-art' } };
  const player = { id: 'player', x: 30, y: 30, isPlayer: true };
  const blackboard = createBlackboard({
    actors: [npcA, npcB],
    player,
    styleFamilies: config.styleFamilies,
    maxPairRecords: config.limits.maxPairRecords,
    maxFriendshipsPerNpc: config.limits.maxFriendshipsPerNpc,
    friendThreshold: config.limits.friendThreshold
  });
  const events = new EventLog(5000);
  const starts = [];
  let firstGreetCooldownMs = null;
  let runtime = null;

  runtime = new BehaviorRuntime({
    config,
    blackboard,
    events,
    rng: seeded(99),
    deps: {
      tryStep: () => false,
      face: (actor, direction) => { actor.direction = direction; }
    },
    onEvent: entry => {
      if (entry.type !== 'behavior.start') return;
      starts.push(entry.detail);
      if (entry.detail.behaviorId === 'greet' && firstGreetCooldownMs === null) {
        firstGreetCooldownMs = runtime.cooldowns.remaining(
          'pair',
          `greetPair:${pairKey(npcA, npcB)}`
        );
      }
    }
  });

  for (let elapsed = 0; elapsed < 180000; elapsed += 100) runtime.update(100);

  const counts = starts.reduce((map, detail) => {
    map[detail.behaviorId] = (map[detail.behaviorId] || 0) + 1;
    return map;
  }, {});
  assert.equal(counts.greet, 2, 'friendship needs exactly two greetings');
  assert.equal(counts.befriend, 1, 'the pair should befriend once');
  assert.ok((counts.inviteGame || 0) >= 1, 'friends should be able to start a game');
  assert.ok(starts.length <= 20, `unexpected behavior churn: ${starts.map(start => start.behaviorId).join(', ')}`);
  assert.ok(firstGreetCooldownMs > 0, 'a pair greet cooldown is consumed when the state starts');

  const relation = blackboard.relation(npcA, npcB);
  assert.ok(relation.greets >= 2);
  assert.ok(relation.activities >= 1);
  assert.equal(relation.friends, true);
  assert.equal(blackboard.isFriend(npcA, npcB), true);

  const styleCases = [
    ['dog', 'trot', { distance: 2.5, roamChance: 0.35 }],
    ['gaze', 'hover', { hover: true }],
    ['clay', 'hop-roll', { hop: true, roll: true }],
    ['skeleton', 'shamble', { shamble: true }],
    ['cat', 'generic', {}]
  ];
  for (const [style, cadence, extra] of styleCases) {
    const resolved = resolveAssignment(
      { id: style, isCompanion: true, recipe: { style } },
      config
    );
    assert.ok(resolved, `${style} companion should get an assignment`);
    assert.equal(resolved.behavior, 'follow', `${style} should follow`);
    assert.equal(resolved.params.cadence, cadence, `${style} cadence`);
    for (const [key, value] of Object.entries(extra)) {
      assert.equal(resolved.params[key], value, `${style}.${key}`);
    }
  }
});
