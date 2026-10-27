import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  PHASES,
  OUTCOMES,
  GAME_KINDS,
  INPUT_MODES,
  ACTIVITY_MODES,
  RENDER_LAYERS,
  MiniGameBase,
  validateMeta,
  assertValidMeta,
  createStepResult
} from '../../src/minigames/contract.js';
import {
  outcomeForSeat,
  settleGame,
  buildEndDialogue,
  buildAbandonPrompt,
  dialogueForMeta,
  DEFAULT_END_CHOICES
} from '../../src/minigames/settlement.js';

const data = JSON.parse(readFileSync(new URL('../../data/minigames.json', import.meta.url), 'utf8'));
const tttMeta = data.miniGames['tic-tac-toe'];
const fetchMeta = data.miniGames.fetch;

test('canonical phases and enums are frozen', () => {
  assert.deepEqual(Object.values(PHASES), ['idle', 'opening', 'ready', 'playing', 'ending', 'closing']);
  assert.ok(Object.isFrozen(PHASES));
  assert.deepEqual([...GAME_KINDS], ['board', 'activity']);
  assert.deepEqual([...INPUT_MODES], ['tile', 'action', 'world']);
  assert.deepEqual([...ACTIVITY_MODES], ['turn-based', 'continuous']);
  assert.deepEqual([...RENDER_LAYERS], ['ground', 'object', 'overlay', 'hud']);
  assert.deepEqual([...OUTCOMES], ['win', 'loss', 'draw', 'complete', 'abandoned']);
});

test('data/minigames.json contains valid metadata for all six games', () => {
  assert.ok(Object.isFrozen(data) === false);
  assert.deepEqual(Object.keys(data.miniGames).sort(), ['checkers', 'chess', 'connect-four', 'fetch', 'memory-grid', 'tic-tac-toe']);
  for (const [id, meta] of Object.entries(data.miniGames)) {
    assert.equal(meta.id, id);
    const result = validateMeta(meta);
    assert.equal(result.ok, true, `${id}: ${result.errors.join('; ')}`);
    assert.equal(meta.persist, false);
  }
  assert.equal(tttMeta.kind, 'board');
  assert.equal(tttMeta.board.width, 3);
  assert.equal(fetchMeta.kind, 'activity');
  assert.equal(fetchMeta.board, null);
  assert.deepEqual(fetchMeta.renderLayers, ['object', 'overlay']);
});

test('validateMeta reports missing fields and enum violations', () => {
  const missing = validateMeta({});
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.some(error => error.includes('missing required field: id')));
  assert.ok(missing.errors.some(error => error.includes('missing required field: kind')));

  const bad = validateMeta({
    ...tttMeta,
    id: 'Bad Id',
    kind: 'arcade',
    players: 3,
    seats: 2,
    board: { width: 0, height: -1, margin: -1, blocksMovement: 'yes' },
    input: { mode: 'keyboard' },
    renderLayers: ['sky'],
    timing: { openMs: -1, closeMs: 'fast', turnMs: null },
    persist: 'no',
    activity: 'realtime'
  });
  assert.equal(bad.ok, false);
  for (const expected of ['kebab-case', 'kind', 'seats', 'board.width', 'board.margin', 'input.mode', 'unknown layer', 'timing.openMs', 'persist', 'activity']) {
    assert.ok(bad.errors.some(error => error.includes(expected)), `expected error mentioning ${expected}`);
  }
});

test('validateMeta requires a board for board games and rejects seats below players', () => {
  assert.equal(validateMeta({ ...tttMeta, board: null }).ok, false);
  assert.equal(validateMeta({ ...tttMeta, players: 3, seats: 2 }).ok, false);
  assert.throws(() => assertValidMeta({ ...tttMeta, id: 'nope!' }), /Invalid mini-game metadata/);
  assert.equal(assertValidMeta(tttMeta), tttMeta);
});

test('MiniGameBase lifecycle is extendable and returns StepResult shapes', () => {
  const base = new MiniGameBase(tttMeta);
  assert.equal(base.phase, PHASES.IDLE);

  const opened = base.open({
    seats: [{ character: { id: 'player' } }],
    placement: { originX: 10, originY: 10 }
  });
  assert.equal(opened.ok, true);
  assert.equal(opened.phase, PHASES.OPENING);
  assert.equal(opened.durationMs, 1050);

  assert.deepEqual(base.update(16), { handled: false, changed: false, events: [] });
  assert.deepEqual(base.handleInput({ type: 'action' }), { handled: false, changed: false, events: [] });

  assert.equal(base.ready().phase, PHASES.READY);
  assert.equal(base.start().phase, PHASES.PLAYING);

  const paused = base.pause('dialogue');
  assert.deepEqual(paused, { paused: true, reason: 'dialogue' });
  assert.equal(base.paused, true);
  assert.equal(base.resume().paused, false);

  const finished = base.finish({ winnerSeat: 0 });
  assert.equal(base.phase, PHASES.ENDING);
  assert.equal(finished.events[0].type, 'finish');
  assert.equal(finished.events[0].winnerSeat, 0);

  const closed = base.close({ reason: 'packed-up' });
  assert.equal(base.phase, PHASES.CLOSING);
  assert.equal(closed.events[0].type, 'closed');
  assert.equal(closed.events[0].reason, 'packed-up');

  const state = base.serialize();
  assert.equal(state.phase, PHASES.CLOSING);
  assert.deepEqual(state.seats, ['player']);
  const restored = new MiniGameBase(tttMeta);
  restored.restore(state);
  assert.equal(restored.phase, PHASES.CLOSING);
  assert.deepEqual(restored.placement, { originX: 10, originY: 10 });
});

test('MiniGameBase derives footprint and hidden zones from metadata', () => {
  const base = new MiniGameBase({
    ...tttMeta,
    board: { ...tttMeta.board, hiddenZones: [{ x: 10, y: 10, width: 1, height: 1 }] }
  });
  base.open({ placement: { originX: 10, originY: 11 } });
  assert.deepEqual(base.getFootprint(), { x: 10, y: 11, width: 3, height: 3 });
  assert.deepEqual(base.getHiddenZones(), [{ x: 10, y: 10, width: 1, height: 1 }]);
  assert.deepEqual(base.getRenderables(), []);
});

test('createStepResult normalizes partial values', () => {
  assert.deepEqual(createStepResult(), { handled: false, changed: false, events: [] });
  assert.deepEqual(createStepResult({ handled: 1, changed: 'yes', events: null }), {
    handled: true,
    changed: true,
    events: []
  });
});

test('outcomeForSeat maps winner seats relative to seat zero', () => {
  assert.equal(outcomeForSeat(0), 'win');
  assert.equal(outcomeForSeat(1), 'loss');
  assert.equal(outcomeForSeat(null), 'draw');
  assert.equal(outcomeForSeat(undefined), 'draw');
  assert.equal(outcomeForSeat('draw'), 'draw');
  assert.equal(outcomeForSeat('abandoned'), 'abandoned');
  assert.equal(outcomeForSeat('1', 1), 'win');
  assert.equal(outcomeForSeat(1, 1), 'win');
});

test('settleGame calls injected stats and reward callbacks once', () => {
  const calls = { record: 0, roll: 0, apply: 0, recordArgs: null, rollArgs: null, applyArgs: null };
  const settlement = settleGame({
    meta: tttMeta,
    winnerSeat: 1,
    opponent: { id: 'npc-1', name: 'Fern' },
    player: { id: 'player' },
    game: { id: 'world' },
    recordGameResult: args => {
      calls.record++;
      calls.recordArgs = args;
      return { totalLosses: 1 };
    },
    rollReward: (game, key, outcome) => {
      calls.roll++;
      calls.rollArgs = { game, key, outcome };
      return { coins: 3, items: [], newCompanion: null };
    },
    applyReward: (game, reward) => {
      calls.apply++;
      calls.applyArgs = { game, reward };
      return ['+3 coins'];
    }
  });

  assert.equal(settlement.outcome, 'loss');
  assert.equal(settlement.recorded, true);
  assert.equal(settlement.rewarded, true);
  assert.deepEqual(settlement.stats, { totalLosses: 1 });
  assert.deepEqual(settlement.notifications, ['+3 coins']);
  assert.deepEqual(calls.recordArgs, { opponentId: 'npc-1', opponentName: 'Fern', result: 'loss' });
  assert.deepEqual(calls.rollArgs, { game: { id: 'world' }, key: 'tic-tac-toe', outcome: 'loss' });
  assert.equal(calls.record, 1);
  assert.equal(calls.roll, 1);
  assert.equal(calls.apply, 1);
});

test('settleGame can suppress side effects and skips stats for abandoned games', () => {
  let calls = 0;
  const suppressed = settleGame({
    meta: tttMeta,
    winnerSeat: 0,
    recordGameResult: () => { calls++; },
    rollReward: () => { calls++; return { coins: 1 }; },
    applyReward: () => { calls++; },
    record: false,
    reward: false
  });
  assert.equal(calls, 0);
  assert.equal(suppressed.recorded, false);
  assert.equal(suppressed.rewarded, false);

  const abandoned = settleGame({
    meta: tttMeta,
    outcome: 'abandoned',
    recordGameResult: () => { calls++; }
  });
  assert.equal(abandoned.outcome, 'abandoned');
  assert.equal(calls, 0);
});

test('end dialogue helpers use data choices and interpolate names', () => {
  const spec = {
    win: 'Great game, {name}!',
    endChoices: [{ label: 'Again', action: 'play_again' }]
  };
  const dialogue = buildEndDialogue({
    meta: tttMeta,
    outcome: 'win',
    opponentName: 'Fern',
    dialogueSpec: spec
  });
  assert.equal(dialogue.key, 'ttt');
  assert.equal(dialogue.text, 'Great game, Fern!');
  assert.deepEqual(dialogue.choices, [{ label: 'Again', action: 'play_again' }]);

  const fallback = buildEndDialogue({ meta: tttMeta, outcome: 'draw' });
  assert.deepEqual(fallback.choices, DEFAULT_END_CHOICES.map(choice => ({ ...choice })));

  const abandon = buildAbandonPrompt({
    meta: tttMeta,
    opponentName: 'Fern',
    dialogueSpec: { abandonPrompt: '{name}: leaving?' }
  });
  assert.equal(abandon.text, 'Fern: leaving?');
  assert.ok(abandon.choices.length >= 2);
});

test('dialogueForMeta resolves flat and nested dialogue data', () => {
  const flat = { ttt: { win: 'flat' } };
  const nested = { dialogues: { ttt: { win: 'nested' } } };
  assert.equal(dialogueForMeta(tttMeta, flat).win, 'flat');
  assert.equal(dialogueForMeta(tttMeta, nested).win, 'nested');
  assert.equal(dialogueForMeta(tttMeta, null), null);
  assert.equal(dialogueForMeta({}, flat), null);
});
