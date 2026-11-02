import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GOAL_EVENTS,
  applyGoalEvent,
  goalEvents,
  goalReward,
  goalSummary,
  isGoalComplete,
  nextGoal,
  normalizeGoalProgress,
  validateGoalsData
} from '../src/goals.js';
import { encodeTerrain } from '../src/world.js';
import { migrateSave, serializeSave } from '../src/storage.js';
import goalsData from '../data/goals.json' with { type: 'json' };

const goals = goalsData.goals;

function grassTerrain() {
  return Array.from({ length: 64 }, () => Array.from({ length: 64 }, () => 'grass'));
}

function baseGame() {
  return {
    worldSeed: 'goals-seed',
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
      coins: 10,
      stabledCompanions: []
    },
    npcs: [],
    companions: []
  };
}

test('goals data is valid: eight unique goals with known events and rewards', () => {
  assert.deepEqual(validateGoalsData(goalsData), []);
  assert.equal(goals.length, 8);
  assert.equal(new Set(goals.map(goal => goal.id)).size, 8);

  for (const goal of goals) {
    assert.ok(goal.title && goal.hint, `${goal.id} needs readable copy`);
    assert.ok(goalReward(goal) > 0, `${goal.id} needs a coin reward`);
    const events = goalEvents(goal);
    assert.ok(events.length >= 1, `${goal.id} needs at least one event`);
    for (const event of events) {
      assert.ok(GOAL_EVENTS.includes(event), `${goal.id} uses unknown event ${event}`);
    }
  }
});

test('validateGoalsData reports bad events, rewards, and duplicates', () => {
  const broken = {
    version: 1,
    goals: [
      { id: 'one', title: 'one', hint: 'hint', event: 'nope.nope', count: 1, reward: 0 },
      { id: 'one', title: 'two', hint: 'hint', event: 'social.greet', count: 1, reward: 5 }
    ]
  };
  const errors = validateGoalsData(broken);
  assert.ok(errors.some(error => error.includes('unknown event')));
  assert.ok(errors.some(error => error.includes('positive reward')));
  assert.ok(errors.some(error => error.includes('repeats id')));
});

test('normalizeGoalProgress defaults to empty and drops malformed rows', () => {
  assert.deepEqual(normalizeGoalProgress(null), { completed: {} });
  assert.deepEqual(normalizeGoalProgress({ completed: [] }), { completed: {} });

  const known = new Set(['say-hello', 'make-a-friend']);
  const normalized = normalizeGoalProgress({
    completed: {
      'say-hello': 1700,
      'make-a-friend': 'soon',
      'unknown-goal': 42,
      'bad id': 42
    }
  }, known);

  assert.deepEqual(normalized, { completed: { 'say-hello': 1700 } });
  assert.equal(isGoalComplete(normalized, 'say-hello'), true);
  assert.equal(isGoalComplete(normalized, 'make-a-friend'), false);
});

test('applyGoalEvent completes only the matching goal and is idempotent', () => {
  const first = applyGoalEvent({ completed: {} }, 'social.greet', goals, 1000);
  assert.equal(first.changed, true);
  assert.deepEqual(first.completed.map(goal => goal.id), ['say-hello']);
  assert.deepEqual(first.progress, { completed: { 'say-hello': 1000 } });

  const second = applyGoalEvent(first.progress, 'social.greet', goals, 2000);
  assert.equal(second.changed, false);
  assert.deepEqual(second.completed, []);
  assert.deepEqual(second.progress, first.progress, 'a repeat event must not move the stamp');
});

test('applyGoalEvent ignores unknown events and leaves progress untouched', () => {
  const progress = { completed: { 'say-hello': 1000 } };
  for (const event of ['nope.nothing', '', null, 42]) {
    const result = applyGoalEvent(progress, event, goals, 2000);
    assert.equal(result.changed, false);
    assert.deepEqual(result.completed, []);
    assert.deepEqual(result.progress, progress);
  }
});

test('a goal with multiple events completes on either one, once', () => {
  const upgrade = applyGoalEvent({ completed: {} }, 'home.upgrade', goals, 1000);
  assert.deepEqual(upgrade.completed.map(goal => goal.id), ['upgrade-or-trade']);

  const trade = applyGoalEvent(upgrade.progress, 'trade.completed', goals, 2000);
  assert.equal(trade.changed, false);
  assert.deepEqual(trade.progress, upgrade.progress);
});

test('goalSummary keeps data order and counts stamped goals', () => {
  const progress = { completed: { 'visit-home': 3000, 'say-hello': 1000 } };
  const summary = goalSummary(progress, goals);

  assert.equal(summary.total, 8);
  assert.equal(summary.completed, 2);
  assert.equal(summary.open, 6);
  assert.equal(summary.percent, 25);
  assert.deepEqual(summary.items.map(item => item.id), goals.map(goal => goal.id));
  assert.deepEqual(summary.items.filter(item => item.done).map(item => item.id), ['say-hello', 'visit-home']);
  assert.equal(summary.next.id, 'make-a-friend');
});

test('nextGoal walks the remaining goals in order and ends null', () => {
  let progress = { completed: {} };
  assert.equal(nextGoal(progress, goals).id, 'say-hello');

  for (const goal of goals) {
    progress = applyGoalEvent(progress, goalEvents(goal)[0], goals, 1000).progress;
  }
  assert.equal(nextGoal(progress, goals), null);
  assert.equal(goalSummary(progress, goals).completed, 8);
});

test('saved goals round trip through serializeSave and migrateSave', () => {
  const progress = {
    completed: {
      'say-hello': 1700000000000,
      'make-a-friend': 1700000001000
    }
  };
  const save = serializeSave(baseGame(), {}, new Set(), null, { goals: progress });
  assert.deepEqual(save.goals, progress);

  const migrated = migrateSave(JSON.parse(JSON.stringify(save)));
  assert.deepEqual(migrated.goals, progress);
  assert.deepEqual(migrated.goals, save.goals);
});

test('saves without goals default to an empty passport and keep the version', () => {
  const save = serializeSave(baseGame(), {}, new Set());
  assert.deepEqual(save.goals, { completed: {} });

  const legacyShape = { ...save };
  delete legacyShape.goals;
  const migrated = migrateSave(legacyShape);
  assert.equal(migrated.version, 4);
  assert.deepEqual(migrated.goals, { completed: {} });
});
