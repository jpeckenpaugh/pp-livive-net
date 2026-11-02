import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIVITIES,
  CourseActivity,
  activityList,
  bestMsFor,
  buildCourse,
  createActivity,
  createRun,
  formatActivityTime,
  parTimeFor,
  recordActivityAttempt,
  rewardForActivity,
  stepRun,
  validateActivityDefinition
} from '../src/activities/platformer.js';
import { validateMeta } from '../src/minigames/contract.js';
import { MiniGameHost } from '../src/minigames/host.js';
import { migrateSave, normalizeActivities, serializeSave } from '../src/storage.js';
import miniGamesData from '../data/minigames.json' with { type: 'json' };

const COURSE_IDS = ['jungle-gym', 'rooftops', 'shoreline'];

function grassTerrain() {
  return Array.from({ length: 64 }, () => Array.from({ length: 64 }, () => 'grass'));
}

/** Run right, jumping whenever the current surface ends just ahead. */
function runCourse(definition, maxSeconds = 120) {
  const course = buildCourse(definition);
  const physics = definition.physics;
  const dt = 1 / physics.stepHz;
  const run = createRun(course, physics);
  const input = { left: false, right: false, jumpQueued: false, jumpCut: false };
  let elapsed = 0;
  while (!run.finished && elapsed < maxSeconds) {
    input.right = true;
    const surface = run.lastSafe.surface;
    const edge = surface ? surface.x + surface.w : 0;
    if (run.player.grounded && run.player.x + run.player.w > edge - 12) input.jumpQueued = true;
    run.elapsed += dt;
    stepRun(run, input, physics, course, dt);
    elapsed += dt;
  }
  return run;
}

function baseGame() {
  return {
    worldSeed: 'test-seed',
    terrain: grassTerrain(),
    wander: true,
    player: {
      name: 'Tester',
      recipe: { seed: 'p-seed', look: {} },
      x: 10,
      y: 12,
      direction: 1,
      inventory: [],
      equipped: [],
      coins: 0,
      stabledCompanions: []
    },
    npcs: [],
    companions: []
  };
}

test('all three courses are enabled, themed, and structurally valid', () => {
  assert.deepEqual(Object.keys(ACTIVITIES), COURSE_IDS);
  assert.deepEqual(activityList().map(entry => entry.id), COURSE_IDS);

  const skies = new Set();
  const grounds = new Set();
  for (const id of COURSE_IDS) {
    const definition = ACTIVITIES[id];
    const report = validateActivityDefinition(definition);
    assert.equal(report.ok, true, `${id}: ${report.errors.join('; ')}`);
    assert.equal(definition.id, id);
    assert.equal(definition.enabled, true);
    assert.equal(definition.title.length > 0, true);

    // Par is the ghost's pace; the declared number must match this course.
    const derived = parTimeFor(buildCourse(definition), definition.physics);
    assert.ok(Math.abs(definition.par - derived) < 0.02, `${id} par drifts`);
    assert.ok(definition.par > 8 && definition.par < 60, `${id} par should stay playable`);

    assert.ok(definition.course.ground.length >= 2, `${id} needs real gaps`);
    assert.ok(definition.course.platforms.length > 0, `${id} needs one-way platforms`);
    assert.ok(definition.ghost.legs.length > 0, `${id} needs an authored ghost line`);
    assert.ok(definition.reward.base >= 0 && definition.reward.underPar >= 0);

    skies.add(definition.theme.skyTop);
    grounds.add(definition.theme.ground);
  }
  assert.equal(skies.size, 3, 'each course should have its own sky');
  assert.equal(grounds.size, 3, 'each course should have its own ground colour');
});

test('every course is finishable under par by a clean lip-jump run', () => {
  for (const id of COURSE_IDS) {
    const definition = ACTIVITIES[id];
    const run = runCourse(definition);
    assert.equal(run.finished, true, `${id} never reached the finish`);
    assert.equal(run.falls, 0, `${id} should not need a fall`);
    assert.ok(run.finishTime > 5, `${id} finished suspiciously fast`);
    assert.ok(run.finishTime < definition.par, `${id} finished at ${run.finishTime}, par ${definition.par}`);
    assert.ok(run.jumps > 0, `${id} should need at least one jump`);
  }
});

test('the shared factory resolves the requested course from metadata', () => {
  for (const id of COURSE_IDS) {
    const activity = createActivity({
      meta: { id, activityId: id, title: ACTIVITIES[id].title },
      options: { bestMs: 24500 }
    });
    assert.ok(activity instanceof CourseActivity);
    assert.equal(activity.definition.id, id);
    assert.equal(activity.getHud().id, id);
    assert.equal(activity.getHud().bestMs, 24500);
    assert.equal(activity.theme.ground, ACTIVITIES[id].theme.ground);
    assert.ok(Math.abs(activity.par - ACTIVITIES[id].par) < 0.01);
  }
  assert.throws(() => createActivity({ meta: { id: 'missing-course' } }), /Unknown activity/);
});

test('main-style metadata derived from the shared shape validates for every course', () => {
  const base = miniGamesData.miniGames['jungle-gym'];
  for (const definition of activityList()) {
    const meta = { ...base, id: definition.id, title: definition.title, activityId: definition.id };
    const report = validateMeta(meta);
    assert.equal(report.ok, true, `${definition.id}: ${report.errors.join('; ')}`);
    assert.equal(meta.render.mode, 'fullview');
  }
});

test('the host runs a second course through the full-view contract', () => {
  const base = miniGamesData.miniGames['jungle-gym'];
  const definition = ACTIVITIES.shoreline;
  const meta = { ...base, id: definition.id, title: definition.title, activityId: definition.id };
  const calls = { record: [], end: [] };
  const host = new MiniGameHost({
    game: { terrain: grassTerrain(), player: { id: 'player' } },
    hooks: {
      recordGameResult: payload => { calls.record.push(payload); return {}; },
      onGameEnd: payload => calls.end.push(payload),
      onToast: () => {},
      dialogues: {}
    }
  });
  assert.equal(host.register({ meta, create: createActivity }).ok, true);

  const started = host.start('shoreline', {
    seats: [{ character: { id: 'player', name: 'You', recipe: { seed: 'p', look: {} } }, controller: 'human', role: 'player' }],
    options: { bestMs: null }
  });
  assert.equal(started.ok, true);
  assert.equal(host.getState().mode, 'fullview');
  assert.equal(host.session.game.definition.id, 'shoreline');

  host.handleInput({ type: 'hold', right: true });
  const game = host.session.game;
  game.run.elapsed = 30;
  game.run.player.x = game.course.finishX - 5;
  host.update(16);

  assert.equal(calls.record.length, 1);
  assert.equal(calls.record[0].result, 'win');
  assert.equal(calls.end.length, 1);
  assert.equal(calls.end[0].meta.activityId, 'shoreline');
  assert.equal(calls.end[0].dialogue.key, 'jungle-gym');
  assert.equal(Number.isInteger(calls.end[0].event.timeMs), true);
  assert.ok(calls.end[0].event.timeMs > 0);
  assert.equal(host.session.settled, true);
});

test('best times only improve while clears count every finish', () => {
  const first = recordActivityAttempt({}, 'rooftops', 20000);
  assert.equal(first.recorded, true);
  assert.equal(first.improved, true);
  assert.deepEqual(first.records.rooftops, { bestMs: 20000, clears: 1 });
  assert.equal(bestMsFor(first.records, 'rooftops'), 20000);

  const slower = recordActivityAttempt(first.records, 'rooftops', 22400);
  assert.equal(slower.improved, false);
  assert.equal(slower.bestMs, 20000);
  assert.equal(slower.clears, 2);
  assert.deepEqual(slower.records.rooftops, { bestMs: 20000, clears: 2 });

  const faster = recordActivityAttempt(slower.records, 'rooftops', 19150);
  assert.equal(faster.improved, true);
  assert.deepEqual(faster.records.rooftops, { bestMs: 19150, clears: 3 });

  // The source table is never mutated.
  assert.deepEqual(slower.records.rooftops, { bestMs: 20000, clears: 2 });
  assert.equal(bestMsFor({}, 'rooftops'), null);
  assert.equal(recordActivityAttempt({}, 'rooftops', NaN).recorded, false);
});

test('finishing pays a base reward and an under-par bonus', () => {
  const definition = ACTIVITIES.rooftops;
  assert.deepEqual(rewardForActivity(definition, { outcome: 'win' }), { coins: 10, base: 5, bonus: 5 });
  assert.deepEqual(rewardForActivity(definition, { outcome: 'loss' }), { coins: 5, base: 5, bonus: 0 });
  assert.deepEqual(rewardForActivity({}, { outcome: 'win' }), { coins: 0, base: 0, bonus: 0 });
  assert.equal(formatActivityTime(19150), '19.15');
  assert.equal(formatActivityTime(null), null);
});

test('activities survive a save round trip and migrate missing to empty', () => {
  const records = {
    'jungle-gym': { bestMs: 28420, clears: 3 },
    rooftop: { bestMs: 15000, clears: 1 }
  };
  const save = serializeSave(baseGame(), {}, new Set(), null, { activities: records });
  assert.deepEqual(save.activities, records);

  const loaded = migrateSave(JSON.parse(JSON.stringify(save)));
  assert.deepEqual(loaded.activities, records);

  // A save written before courses existed still reads as an empty table.
  const legacy = JSON.parse(JSON.stringify(save));
  delete legacy.activities;
  assert.deepEqual(migrateSave(legacy).activities, {});

  assert.deepEqual(normalizeActivities(undefined), {});
  assert.deepEqual(normalizeActivities({
    'jungle-gym': { bestMs: '28420', clears: '2' },
    'bad id': { bestMs: 1, clears: 1 },
    empty: { bestMs: null, clears: 0 },
    junk: 4
  }), {
    'jungle-gym': { bestMs: 28420, clears: 2 }
  });
});
