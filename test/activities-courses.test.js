import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIVITIES,
  BACKDROPS,
  CourseActivity,
  PLATFORM_MATERIALS,
  PROP_TYPES,
  SUBSURFACE_TYPES,
  SURFACE_TYPES,
  activityChoiceLabel,
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

/** The props that give each course its look: park, city roof, beach. */
const SIGNATURE_PROPS = {
  'jungle-gym': ['tree', 'bush', 'bench', 'lamp', 'flag'],
  rooftops: ['tank', 'vent', 'sign', 'lamp'],
  shoreline: ['palm', 'umbrella', 'towel', 'shell', 'hut']
};

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

/** Canvas stub that records what the terrain renderer paints. */
function recordingContext() {
  const calls = { fills: [], gradients: [], paths: 0, strokes: 0, texts: [] };
  return {
    calls,
    fillStyle: '#000000',
    strokeStyle: '#000000',
    lineWidth: 1,
    lineCap: 'butt',
    globalAlpha: 1,
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    save() {},
    restore() {},
    setTransform() {},
    translate() {},
    scale() {},
    rotate() {},
    beginPath() { calls.paths += 1; },
    closePath() {},
    moveTo() {},
    lineTo() {},
    quadraticCurveTo() {},
    bezierCurveTo() {},
    arc() {},
    ellipse() {},
    rect() {},
    roundRect() {},
    clip() {},
    setLineDash() {},
    fill() { calls.fills.push(this.fillStyle); },
    stroke() { calls.strokes += 1; },
    fillRect() { calls.fills.push(this.fillStyle); },
    strokeRect() {},
    fillText(text) { calls.texts.push(String(text)); },
    createLinearGradient() {
      const stops = [];
      calls.gradients.push(stops);
      return { addColorStop(offset, colour) { stops.push(colour); } };
    }
  };
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
  const badges = new Map([
    ['jungle-gym', '🌿'],
    ['rooftops', '🏙️'],
    ['shoreline', '🏖️']
  ]);
  for (const id of COURSE_IDS) {
    const definition = ACTIVITIES[id];
    const report = validateActivityDefinition(definition);
    assert.equal(report.ok, true, `${id}: ${report.errors.join('; ')}`);
    assert.equal(definition.id, id);
    assert.equal(definition.enabled, true);
    assert.equal(definition.title.length > 0, true);

    // One glanceable badge per course, used by the course board row.
    assert.equal(definition.badge, badges.get(id), `${id} badge`);
    assert.ok(activityChoiceLabel(definition, 28420).startsWith(`${definition.badge} `), `${id} board badge`);

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

test('every course declares a complete side-view terrain theme', () => {
  const surfaces = new Set();
  const backdrops = new Set();
  const materials = new Set();

  for (const id of COURSE_IDS) {
    const definition = ACTIVITIES[id];
    const theme = definition.theme;

    assert.ok(SURFACE_TYPES.includes(theme.surface), `${id} surface ${theme.surface}`);
    assert.ok(SUBSURFACE_TYPES.includes(theme.subsurface), `${id} subsurface ${theme.subsurface}`);
    assert.ok(PLATFORM_MATERIALS.includes(theme.platformMaterial), `${id} platform ${theme.platformMaterial}`);
    assert.ok(BACKDROPS.includes(theme.backdrop), `${id} backdrop ${theme.backdrop}`);
    surfaces.add(theme.surface);
    backdrops.add(theme.backdrop);
    materials.add(theme.platformMaterial);

    // Only the shore course floods its pits.
    if (id === 'shoreline') assert.equal(typeof theme.water, 'string', 'shoreline needs water');
    else assert.equal(theme.water, undefined, `${id} should stay dry`);

    // Set dressing stands on the authored ground line, never over a pit.
    assert.ok(Array.isArray(theme.props) && theme.props.length >= 6, `${id} needs props`);
    const propTypes = new Set(theme.props.map(prop => prop.type));
    for (const type of SIGNATURE_PROPS[id]) {
      assert.ok(propTypes.has(type), `${id} needs a ${type} for its look`);
    }
    for (const [index, prop] of theme.props.entries()) {
      assert.ok(PROP_TYPES.includes(prop.type), `${id} props[${index}] type ${prop.type}`);
      assert.ok(Number.isFinite(prop.x) && prop.x >= 0 && prop.x <= definition.course.width, `${id} props[${index}] x`);
      assert.ok(Number.isFinite(prop.y), `${id} props[${index}] y`);
      assert.ok(prop.scale === undefined || prop.scale > 0, `${id} props[${index}] scale`);
      const standing = definition.course.ground.some(segment => prop.x >= segment.x && prop.x <= segment.x + segment.w);
      assert.ok(standing, `${id} prop at ${prop.x} floats over a gap`);
    }
  }

  assert.equal(backdrops.size, 3, 'each course needs its own backdrop');
  assert.equal(surfaces.size, 3, 'each course needs its own surface');
  assert.equal(materials.size, 3, 'each course needs its own platform material');
});

test('every prop stands on the ground line or on a real platform deck', () => {
  for (const id of COURSE_IDS) {
    const { course, theme } = ACTIVITIES[id];
    for (const prop of theme.props) {
      const onGround = prop.y === course.groundY;
      const deck = course.platforms.find(platform => (
        Math.abs(platform.y - prop.y) < 0.001
        && prop.x >= platform.x - 24
        && prop.x <= platform.x + platform.w + 24
      ));
      assert.ok(onGround || deck, `${id} ${prop.type}@${prop.x} floats at y ${prop.y}`);
    }
  }
});

test('badges stay short, friendly, and optional', () => {
  const base = ACTIVITIES['jungle-gym'];
  const missing = { ...base };
  delete missing.badge;
  assert.equal(validateActivityDefinition(missing).ok, true, 'a badge is optional');

  for (const badge of ['', '   ', 7, 'not-an-emoji maybe too long']) {
    const report = validateActivityDefinition({ ...base, badge });
    assert.equal(report.ok, false, `badge ${JSON.stringify(badge)} should fail`);
    assert.ok(report.errors.some(error => error.includes('badge')), 'error names the badge');
  }
});

test('theme vocabulary rejects unknown materials and keeps the new keys optional', () => {
  const base = ACTIVITIES['jungle-gym'];
  const bad = {
    ...base,
    theme: {
      ...base.theme,
      surface: 'lava',
      subsurface: 'slime',
      platformMaterial: 'glass',
      backdrop: 'moon',
      water: 12,
      props: [
        { type: 'dragon', x: 100, y: 440 },
        { type: 'tree', x: -5, y: 440 },
        { type: 'tree', x: 999999, y: 440 },
        { type: 'tree', x: 200, y: 440, scale: 0 }
      ]
    }
  };
  const report = validateActivityDefinition(bad);
  assert.equal(report.ok, false);
  for (const needle of [
    'theme.surface', 'theme.subsurface', 'theme.platformMaterial', 'theme.backdrop',
    'theme.water', 'type must be one of', 'x must be a non-negative', 'inside the course', 'scale'
  ]) {
    assert.ok(report.errors.some(error => error.includes(needle)), `expected an error mentioning ${needle}`);
  }

  // A theme written before the terrain pass still validates.
  const legacy = { ...base, theme: { ...base.theme } };
  delete legacy.theme.surface;
  delete legacy.theme.subsurface;
  delete legacy.theme.platformMaterial;
  delete legacy.theme.backdrop;
  delete legacy.theme.props;
  const legacyReport = validateActivityDefinition(legacy);
  assert.equal(legacyReport.ok, true, legacyReport.errors.join('; '));
});

test('course geometry is independent of the visual theme', () => {
  for (const id of COURSE_IDS) {
    const definition = ACTIVITIES[id];
    const plain = buildCourse({ ...definition, theme: {} });
    const painted = buildCourse(definition);
    assert.deepEqual(plain.solids, painted.solids);
    assert.deepEqual(plain.oneWays, painted.oneWays);

    // The colliders are the authored ground and platforms, one for one.
    const raw = definition.course;
    assert.deepEqual(
      painted.solids.map(({ x, y, w, h }) => ({ x, y, w, h })),
      raw.ground.map(segment => ({ x: segment.x, y: raw.groundY, w: segment.w, h: raw.groundDepth }))
    );
    assert.deepEqual(
      painted.oneWays.map(({ x, y, w, h }) => ({ x, y, w, h })),
      raw.platforms.map(platform => ({ x: platform.x, y: platform.y, w: platform.w, h: platform.h || 16 }))
    );
  }
});

test('the terrain renderer paints all three courses at desktop and narrow widths', () => {
  for (const id of COURSE_IDS) {
    const definition = ACTIVITIES[id];
    const activity = createActivity({ meta: { id, activityId: id, title: definition.title } });
    activity.open({ seats: [{ character: { id: 'player', recipe: { seed: 'p', look: {} } } }] });
    const before = JSON.stringify(activity.course);

    for (const size of [
      { width: 1024, height: 768, dpr: 2 },
      { width: 360, height: 640, dpr: 1 }
    ]) {
      const ctx = recordingContext();
      assert.equal(activity.renderView(ctx, size), true, `${id} did not render at ${size.width}px`);
      assert.ok(activity.viewWidth > 0, `${id} should report a view width`);
      assert.ok(ctx.calls.fills.length > 40, `${id} should paint a full frame`);
      assert.ok(ctx.calls.paths > 10, `${id} should paint shaped terrain, props, and gates`);
      assert.equal(ctx.calls.texts.length, 0, 'the course paints no text into the scene');
    }

    assert.equal(JSON.stringify(activity.course), before, `${id} render must not move collision`);

    if (id === 'shoreline') {
      const ctx = recordingContext();
      activity.renderView(ctx, { width: 1024, height: 768, dpr: 1 });
      assert.ok(
        ctx.calls.gradients.some(stops => stops.includes(definition.theme.water)),
        'shoreline fills the pits with water'
      );
    }
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
