/**
 * Park Passport goals: pure progress bookkeeping for `data/goals.json`.
 *
 * A goal is a one-shot milestone keyed by an event name. Progress is a single
 * `{ completed: { [goalId]: timestamp } }` block, so completion is idempotent:
 * replaying an event never awards a second time. No DOM or storage access here.
 */

export const GOAL_EVENTS = [
  'social.greet',
  'social.friend',
  'games.board',
  'travel.home',
  'home.furnish',
  'activity.finish',
  'shop.buy',
  'home.upgrade',
  'trade.completed',
  'lesson.completed',
  'shell.collected'
];

const GOAL_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const EVENT_NAME = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*)+$/;

export function goalList(source) {
  if (Array.isArray(source)) return source.filter(goal => goal && typeof goal === 'object');
  if (Array.isArray(source?.goals)) return source.goals.filter(goal => goal && typeof goal === 'object');
  return [];
}

/** Every event that completes this goal; `events` wins over the singular key. */
export function goalEvents(goal) {
  const source = Array.isArray(goal?.events) ? goal.events : [goal?.event];
  const seen = new Set();
  const events = [];
  for (const event of source) {
    if (typeof event !== 'string' || !EVENT_NAME.test(event) || seen.has(event)) continue;
    seen.add(event);
    events.push(event);
  }
  return events;
}

export function goalReward(goal) {
  const reward = Number(goal?.reward);
  return Number.isFinite(reward) && reward > 0 ? Math.floor(reward) : 0;
}

/**
 * Coerce any saved shape into `{ completed: { id: timestampMs } }`. Unknown,
 * malformed, and negative entries are dropped; `knownIds` (a Set) additionally
 * prunes goals that are no longer in the data file.
 */
export function normalizeGoalProgress(source, knownIds = null) {
  const completed = {};
  const raw = source?.completed;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [id, value] of Object.entries(raw)) {
      if (!GOAL_ID.test(id)) continue;
      if (knownIds && !knownIds.has(id)) continue;
      const timestamp = Number(value);
      if (!Number.isFinite(timestamp) || timestamp < 0) continue;
      completed[id] = Math.round(timestamp);
    }
  }
  return { completed };
}

export function isGoalComplete(progress, goalId) {
  return Boolean(progress?.completed && typeof progress.completed[goalId] === 'number');
}

/**
 * Apply one game event. Returns the next progress block plus the goals that
 * were completed by this call (empty when the event is unknown, already done,
 * or does not match a goal). `progress` is never mutated.
 */
export function applyGoalEvent(progress, event, goals, now = Date.now()) {
  const list = goalList(goals);
  const knownIds = new Set(list.map(goal => goal.id).filter(id => GOAL_ID.test(id)));
  const current = normalizeGoalProgress(progress, knownIds);
  const timestamp = Number.isFinite(Number(now)) && Number(now) >= 0
    ? Math.round(Number(now))
    : Date.now();

  if (typeof event !== 'string' || !EVENT_NAME.test(event)) {
    return { progress: current, completed: [], changed: false };
  }

  const completed = [];
  for (const goal of list) {
    if (!GOAL_ID.test(goal?.id) || current.completed[goal.id]) continue;
    if (!goalEvents(goal).includes(event)) continue;
    current.completed[goal.id] = timestamp;
    completed.push(goal);
  }

  return { progress: current, completed, changed: completed.length > 0 };
}

/**
 * Ordered view for the panel: every goal in data order, with completion state.
 * `next` is the first open goal (or null when the passport is full).
 */
export function goalSummary(progress, goals) {
  const list = goalList(goals);
  const normalized = normalizeGoalProgress(progress, new Set(list.map(goal => goal.id)));
  const items = list.map(goal => {
    const completedAt = normalized.completed[goal.id] ?? null;
    return {
      id: goal.id,
      goal,
      title: typeof goal.title === 'string' ? goal.title : goal.id,
      hint: typeof goal.hint === 'string' ? goal.hint : '',
      reward: goalReward(goal),
      done: completedAt !== null,
      completedAt
    };
  });
  const completed = items.filter(item => item.done).length;
  return {
    items,
    total: items.length,
    completed,
    open: items.length - completed,
    percent: items.length ? Math.round((completed / items.length) * 100) : 0,
    next: items.find(item => !item.done) || null
  };
}

export function nextGoal(progress, goals) {
  return goalSummary(progress, goals).next;
}

/**
 * Validation used by the data test and safe for runtime callers: returns a list
 * of human-readable problems (empty when the data is usable).
 */
export function validateGoalsData(data) {
  const errors = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return ['goals data must be an object'];
  }
  if (data.version !== 1) errors.push('goals data version must be 1');
  if (!Array.isArray(data.goals)) return [...errors, 'goals must be an array'];
  if (data.goals.length !== 10) errors.push(`expected 10 goals, found ${data.goals.length}`);

  const knownEvents = new Set(GOAL_EVENTS);
  const seen = new Set();
  data.goals.forEach((goal, index) => {
    const where = `goal[${index}]`;
    if (!goal || typeof goal !== 'object' || Array.isArray(goal)) {
      errors.push(`${where} must be an object`);
      return;
    }
    if (typeof goal.id !== 'string' || !GOAL_ID.test(goal.id)) {
      errors.push(`${where} needs a slug id`);
    } else if (seen.has(goal.id)) {
      errors.push(`${where} repeats id ${goal.id}`);
    } else {
      seen.add(goal.id);
    }
    if (typeof goal.title !== 'string' || !goal.title.trim()) errors.push(`${where} needs a title`);
    if (typeof goal.hint !== 'string' || !goal.hint.trim()) errors.push(`${where} needs a hint`);

    const events = goalEvents(goal);
    if (!events.length) errors.push(`${where} needs an event`);
    for (const event of events) {
      if (!knownEvents.has(event)) errors.push(`${where} has unknown event ${event}`);
    }

    if (!Number.isInteger(goal.count) || goal.count < 1) errors.push(`${where} needs a positive count`);
    if (!Number.isInteger(goal.reward) || goal.reward <= 0) errors.push(`${where} needs a positive reward`);
  });

  return errors;
}
