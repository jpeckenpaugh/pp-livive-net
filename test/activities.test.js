import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIVITIES,
  JungleGymActivity,
  buildCourse,
  buildGhostPath,
  createJungleGym,
  createRun,
  ghostJumpTimes,
  ghostXAt,
  ghostYAt,
  isActivityEnabled,
  outcomeForTime,
  parTimeFor,
  stepRun
} from '../src/activities/jungle-gym.js';
import { MiniGameHost } from '../src/minigames/host.js';
import { RENDER_MODES, validateMeta } from '../src/minigames/contract.js';
import { Game } from '../src/game.js';
import activitiesData from '../data/activities.json' with { type: 'json' };
import miniGamesData from '../data/minigames.json' with { type: 'json' };
import dialoguesData from '../data/dialogues.json' with { type: 'json' };

const definition = activitiesData.activities['jungle-gym'];
const meta = miniGamesData.miniGames['jungle-gym'];
const course = buildCourse(definition);
const physics = definition.physics;
const stepSeconds = 1 / physics.stepHz;

function makeRun() {
  return {
    run: createRun(course, physics),
    input: { left: false, right: false, jumpQueued: false, jumpCut: false }
  };
}

/** Run right and jump whenever the current surface ends just ahead. */
function runWithLipJumps(maxSeconds = 120) {
  const { run, input } = makeRun();
  let elapsed = 0;
  while (!run.finished && elapsed < maxSeconds) {
    input.right = true;
    const surface = run.lastSafe.surface;
    const edge = surface ? surface.x + surface.w : 0;
    if (run.player.grounded && run.player.x + run.player.w > edge - 12) input.jumpQueued = true;
    run.elapsed += stepSeconds;
    stepRun(run, input, physics, course, stepSeconds);
    elapsed += stepSeconds;
  }
  return run;
}

function stubContext() {
  const noop = () => {};
  return {
    save: noop,
    restore: noop,
    setTransform: noop,
    fillRect: noop,
    strokeRect: noop,
    beginPath: noop,
    moveTo: noop,
    lineTo: noop,
    stroke: noop,
    fill: noop,
    arc: noop,
    ellipse: noop,
    rect: noop,
    roundRect: noop,
    setLineDash: noop,
    createLinearGradient: () => ({ addColorStop: noop })
  };
}

function makeGame() {
  const game = new Game();
  game.terrain = Array.from({ length: 64 }, () => Array.from({ length: 64 }, () => 'grass'));
  game.canvas = { style: {} };
  game.width = 1024;
  game.height = 768;
  game.camera = { x: 0, y: 0 };
  game.player = {
    id: 'player',
    name: 'You',
    x: 10,
    y: 10,
    direction: 0,
    moving: false,
    path: [],
    recipe: { seed: 'player', look: {} }
  };
  game.npcs = [];
  game.companions = [];
  game.miniGames = [];
  game.interactive = true;
  return game;
}

test('the jungle gym definition is enabled, data-driven, and internally consistent', () => {
  assert.equal(isActivityEnabled('jungle-gym'), true);
  assert.equal(isActivityEnabled('missing-activity'), false);
  assert.equal(ACTIVITIES['jungle-gym'], definition);
  assert.equal(definition.id, 'jungle-gym');

  for (const key of [
    'stepHz', 'maxCatchupSteps', 'viewHeight', 'minViewWidth', 'runSpeed',
    'accelGround', 'accelAir', 'frictionGround', 'frictionAir', 'gravityUp',
    'gravityDown', 'jumpVelocity', 'jumpCut', 'maxFallSpeed', 'coyoteTime',
    'jumpBuffer', 'playerWidth', 'playerHeight', 'cameraLead', 'cameraSmooth',
    'ghostSpeed'
  ]) {
    assert.ok(Number.isFinite(physics[key]) && physics[key] > 0, `${key} must be a positive number`);
  }
  assert.equal(physics.stepHz, 120);
  assert.equal(physics.maxCatchupSteps, 5);

  // Par is the ghost's pace; the declared number must match the course it races.
  const derived = parTimeFor(course, physics);
  assert.ok(Math.abs(definition.par - derived) < 0.02, `par ${definition.par} drifts from ${derived.toFixed(2)}`);
  assert.ok(derived >= 20 && derived <= 40, 'par should stay in the 20-40 s band');

  // Ground runs left to right without overlap; start and finish sit on it.
  let cursor = 0;
  for (const solid of course.solids) {
    assert.ok(solid.x >= cursor, 'ground segments must not overlap');
    assert.ok(solid.w > 0);
    cursor = solid.x + solid.w;
  }
  assert.ok(course.startX >= course.solids[0].x && course.startX < course.solids[0].x + course.solids[0].w);
  const last = course.solids[course.solids.length - 1];
  assert.ok(course.finishX > last.x && course.finishX <= last.x + last.w);
  assert.ok(course.width >= course.finishX);
  assert.ok(course.pitY > course.groundY + physics.playerHeight);

  // Platforms are one-way and always above the ground line.
  for (const platform of course.oneWays) {
    assert.ok(platform.y < course.groundY, 'platforms must float above the ground');
    assert.equal(platform.h, 16);
  }
});

test('the ghost line starts at the start, ends at the finish, and paces to par', () => {
  const sample = buildGhostPath(definition);
  assert.ok(sample.path.length > 100, 'the ghost path should be densely sampled');
  assert.equal(ghostXAt(0, definition), course.startX);
  assert.ok(Math.abs(ghostXAt(definition.par, definition) - course.finishX) < 0.5, 'par lands on the finish line');
  assert.equal(ghostXAt(definition.par * 2, definition), course.finishX, 'the ghost waits at the line');
  assert.equal(ghostYAt(sample, course.startX, course), course.groundY);

  const jumps = ghostJumpTimes(definition);
  assert.equal(jumps.length, 12);
  for (let i = 1; i < jumps.length; i++) {
    assert.ok(jumps[i].at > jumps[i - 1].at, 'ghost jumps must be in course order');
  }
  // The authored line never dips below the start ground line (arcs go up only).
  for (let x = course.startX; x <= course.finishX; x += 16) {
    assert.ok(ghostYAt(sample, x, course) <= course.groundY + 0.001, `ghost dips at ${x}`);
  }
});

test('a lip-jump run finishes under par with no falls', () => {
  const run = runWithLipJumps();
  assert.equal(run.finished, true);
  assert.ok(run.finishTime > 20 && run.finishTime < definition.par, `finished in ${run.finishTime}`);
  assert.equal(run.falls, 0);
  assert.ok(run.jumps >= 10, 'the course should need a real jump count');
  assert.equal(outcomeForTime(run.finishTime, definition.par), 'win');
});

test('running without jumping falls into the gaps and never finishes', () => {
  const { run, input } = makeRun();
  input.right = true;
  for (let i = 0; i < 1200 && !run.finished; i++) {
    run.elapsed += stepSeconds;
    stepRun(run, input, physics, course, stepSeconds);
  }
  assert.equal(run.finished, false);
  assert.ok(run.falls >= 3, `expected repeated falls, saw ${run.falls}`);
  assert.ok(run.player.x < 2000, 'a no-jump runner is stopped by the first gaps');
});

test('win means at or under par', () => {
  assert.equal(outcomeForTime(30.09, 30.09), 'win');
  assert.equal(outcomeForTime(29.5, 30.09), 'win');
  assert.equal(outcomeForTime(30.1, 30.09), 'loss');
});

test('the activity readies, starts on first input, and emits one finish event', () => {
  const activity = new JungleGymActivity({ meta, options: {} });
  const opened = activity.open({
    seats: [
      { character: { id: 'player', recipe: { seed: 'p', look: {} } }, controller: 'human', role: 'player' },
      { character: { id: 'npc', name: 'Fern', recipe: { seed: 'f', look: {} } }, controller: 'ai', role: 'opponent' }
    ]
  });
  assert.equal(opened.ok, true);
  assert.equal(activity.phase, 'ready');
  assert.equal(activity.getHud().state, 'ready');
  assert.equal(activity.update(16).handled, false, 'the clock waits for the first input');

  const started = activity.handleInput({ type: 'hold', right: true, left: false });
  assert.equal(started.changed, true);
  assert.equal(activity.phase, 'playing');
  assert.equal(activity.run.started, true);

  // Jump to the finish line and step once.
  activity.run.elapsed = 24;
  activity.run.player.x = course.finishX - 5;
  const result = activity.update(16);
  const finish = result.events.find(event => event.type === 'finish');
  assert.ok(finish, 'finishing must emit a finish event');
  assert.equal(finish.outcome, 'win');
  assert.equal(finish.winnerSeat, 0);
  assert.equal(finish.record, true);
  assert.equal(finish.reward, false);
  assert.equal(finish.time, 24.01);
  assert.equal(activity.phase, 'ending');
  assert.equal(activity.update(16).events.length, 0, 'only one finish event per run');

  // The end beat owns input; restart is the way back to the line.
  assert.equal(activity.handleInput({ type: 'action' }).handled, false);
  const restarted = activity.handleInput({ type: 'restart' });
  assert.equal(restarted.changed, true);
  assert.equal(activity.phase, 'ready');
  assert.equal(activity.run.elapsed, 0);
  assert.equal(activity.run.player.x, course.startX);
});

test('a slow finish emits a loss event against par', () => {
  const activity = new JungleGymActivity({ meta });
  activity.open({ seats: [{ character: { id: 'player', recipe: { seed: 'p', look: {} } } }] });
  activity.handleInput({ type: 'hold', right: true });
  activity.run.elapsed = definition.par + 4;
  activity.run.player.x = course.finishX - 5;
  const finish = activity.update(16).events.find(event => event.type === 'finish');
  assert.equal(finish.outcome, 'loss');
  assert.equal(finish.winnerSeat, 1);
});

test('renderView paints the course and hands back the view width', () => {
  const activity = new JungleGymActivity({ meta });
  activity.open({ seats: [{ character: { id: 'player', recipe: { seed: 'p', look: {} } } }] });
  let painted = 0;
  const ctx = stubContext();
  ctx.fillRect = () => { painted += 1; };
  assert.equal(activity.renderView(ctx, { width: 1024, height: 768, dpr: 2 }), true);
  assert.ok(painted > 40, 'the course should paint a full frame');
  assert.ok(activity.viewWidth > 0);
  assert.equal(activity.renderView(ctx, { width: 0, height: 0 }), false);
});

test('the host opens, renders, and settles the activity through the contract', () => {
  const calls = { record: [], reward: 0, end: [], cheer: [] };
  const host = new MiniGameHost({
    game: { terrain: makeGame().terrain, player: { id: 'player' } },
    hooks: {
      recordGameResult: payload => { calls.record.push(payload); return {}; },
      rollReward: () => { calls.reward += 1; return null; },
      onGameEnd: payload => calls.end.push(payload),
      onCheer: id => calls.cheer.push(id),
      onToast: () => {},
      dialogues: dialoguesData
    }
  });
  assert.equal(host.register({ meta, create: createJungleGym }).ok, true);

  const player = { id: 'player', name: 'You', recipe: { seed: 'p', look: {} } };
  const rival = { id: 'npc-1', name: 'Fern', recipe: { seed: 'f', look: {} } };
  const started = host.start('jungle-gym', {
    seats: [
      { character: player, controller: 'human', role: 'player' },
      { character: rival, controller: 'ai', role: 'opponent' }
    ],
    controllers: ['human', 'ai']
  });
  assert.equal(started.ok, true);
  assert.equal(host.getState().mode, 'fullview');
  assert.equal(host.getState().kind, 'activity');
  assert.equal(host.getFootprint(), null);
  assert.equal(host.blocksStep(player, 10, 10), false);

  const ctx = stubContext();
  assert.equal(host.renderView(ctx, { width: 800, height: 600, dpr: 1 }), true);
  assert.equal(host.renderLayer(ctx, 'ground', { tileSize: 48 }), false, 'full-view games do not paint layers');

  host.handleInput({ type: 'hold', right: true });
  const game = host.session.game;
  game.run.elapsed = 26;
  game.run.player.x = course.finishX - 5;
  host.update(16);

  assert.equal(calls.record.length, 1);
  assert.equal(calls.record[0].result, 'win');
  assert.equal(calls.reward, 0, 'no reward this wave');
  assert.equal(calls.end.length, 1);
  assert.equal(calls.end[0].settlement.outcome, 'win');
  assert.equal(calls.end[0].settlement.reward, null);
  assert.equal(calls.end[0].dialogue.key, 'jungle-gym');
  assert.match(calls.end[0].dialogue.text, /Fern/);
  assert.equal(host.session.settled, true);
});

test('Game suspends the Park but keeps stepping the host', () => {
  const game = makeGame();
  let hostSteps = 0;
  const host = { update: ms => { hostSteps += 1; assert.ok(ms > 0); } };
  game.setMiniGameHost(host);
  game.heldKeys = [{ key: 'd', dx: 1, dy: 0 }];

  const first = game.suspendWorld('activity');
  assert.equal(first.alreadySuspended, undefined);
  assert.equal(game.suspendWorld('activity').alreadySuspended, true, 'suspend is idempotent');
  assert.equal(game.worldSuspended, true);
  game.heldKeys = [{ key: 'd', dx: 1, dy: 0 }];
  game.update(0.2);
  assert.equal(game.player.x, 10, 'the player must not move while suspended');
  assert.equal(hostSteps, 1, 'the activity session still steps');
  assert.equal(game.tryPlayerStep(1, 0), false);
  assert.equal(game.paused, false, 'suspend is not dialogue pause');

  game.resumeWorld();
  assert.equal(game.worldSuspended, false);
  assert.equal(game.heldKeys.length, 0);
  game.update(0.2);
  assert.equal(hostSteps, 2);
});

test('fullview metadata validates and rejects mismatches', () => {
  assert.deepEqual([...RENDER_MODES], ['inline', 'fullview']);
  assert.equal(validateMeta(meta).ok, true);

  const boardFullview = validateMeta({ ...meta, kind: 'board' });
  assert.equal(boardFullview.ok, false);
  assert.ok(boardFullview.errors.some(error => error.includes('requires kind activity')));

  const inlineWithBoard = validateMeta({ ...meta, render: { mode: 'nope' } });
  assert.equal(inlineWithBoard.ok, false);
  assert.ok(inlineWithBoard.errors.some(error => error.includes('render.mode')));
});
