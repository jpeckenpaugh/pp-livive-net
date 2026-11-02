/**
 * Shared mini-game contract.
 *
 * Games own rules and state only. They must not touch the DOM, timers, rewards,
 * stats, or dialogue. They report what happened through StepResult events and
 * the host settles those events.
 */

export const PHASES = Object.freeze({
  IDLE: 'idle',
  OPENING: 'opening',
  READY: 'ready',
  PLAYING: 'playing',
  ENDING: 'ending',
  CLOSING: 'closing'
});

// Alias used in the initiative plan.
export const PHASE = PHASES;

export const OUTCOMES = Object.freeze(['win', 'loss', 'draw', 'complete', 'abandoned']);

export const GAME_KINDS = Object.freeze(['board', 'activity']);

export const INPUT_MODES = Object.freeze(['tile', 'action', 'world']);

export const ACTIVITY_MODES = Object.freeze(['turn-based', 'continuous']);

export const RENDER_LAYERS = Object.freeze(['ground', 'object', 'overlay', 'hud']);

/**
 * How a session paints. `inline` draws layers over the Park; `fullview` owns
 * the whole canvas and the shell skips the Park entirely.
 */
export const RENDER_MODES = Object.freeze(['inline', 'fullview']);

export const REQUIRED_META_FIELDS = Object.freeze([
  'id',
  'title',
  'kind',
  'itemId',
  'dialogueKey',
  'rewardKey',
  'players',
  'seats',
  'board',
  'input',
  'renderLayers',
  'timing',
  'persist',
  'activity'
]);

/**
 * @typedef {Object} GameEvent
 * @property {string} type  e.g. toast, cheer, turn, finish, abandon, closed
 * Additional keys are game specific. Common shapes:
 *   { type: 'toast', message: string }
 *   { type: 'cheer', characterId: string, duration: number }
 *   { type: 'turn', seat: number, characterId?: string }
 *   { type: 'finish', winnerSeat: number|null, outcome?: 'win'|'loss'|'draw'|'complete'|'abandoned' }
 *   { type: 'abandon', reason?: string }
 *   { type: 'closed', reason?: string }
 */

/**
 * @typedef {Object} StepResult
 * @property {boolean} handled  input/update was consumed
 * @property {boolean} changed  visible state changed
 * @property {GameEvent[]} events  things the host should settle or surface
 */

/** @returns {StepResult} */
export function createStepResult({ handled = false, changed = false, events = [] } = {}) {
  return { handled: Boolean(handled), changed: Boolean(changed), events: Array.isArray(events) ? events : [] };
}

/** @returns {StepResult} */
export function emptyStepResult() {
  return createStepResult();
}

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function isNonNegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateBoard(board, errors) {
  if (!isPlainObject(board)) {
    errors.push('board must be an object or null');
    return;
  }
  if (!isPositiveInteger(board.width)) errors.push('board.width must be a positive integer');
  if (!isPositiveInteger(board.height)) errors.push('board.height must be a positive integer');
  if (board.margin !== undefined && !isNonNegativeInteger(board.margin)) {
    errors.push('board.margin must be a non-negative integer');
  }
  if (board.blocksMovement !== undefined && typeof board.blocksMovement !== 'boolean') {
    errors.push('board.blocksMovement must be a boolean');
  }
  if (board.hiddenZones !== undefined) {
    if (!Array.isArray(board.hiddenZones)) {
      errors.push('board.hiddenZones must be an array');
    } else {
      for (const [index, zone] of board.hiddenZones.entries()) {
        if (!isPlainObject(zone) || !Number.isInteger(zone.x) || !Number.isInteger(zone.y)
          || !isPositiveInteger(zone.width) || !isPositiveInteger(zone.height)) {
          errors.push(`board.hiddenZones[${index}] must be { x, y, width, height }`);
        }
      }
    }
  }
}

function validateTiming(timing, errors) {
  if (!isPlainObject(timing)) {
    errors.push('timing must be an object');
    return;
  }
  for (const key of ['openMs', 'closeMs', 'turnMs']) {
    if (!isNonNegativeNumber(timing[key])) errors.push(`timing.${key} must be a non-negative number`);
  }
}

/**
 * Validate one metadata record. Returns a list of human-readable errors so the
 * host, data tests, and debug UI can all report a precise failure.
 *
 * @param {object} meta
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateMeta(meta) {
  const errors = [];
  if (!isPlainObject(meta)) {
    return { ok: false, errors: ['meta must be an object'] };
  }

  for (const field of REQUIRED_META_FIELDS) {
    if (!(field in meta)) errors.push(`missing required field: ${field}`);
  }

  if (meta.id !== undefined && (!isNonEmptyString(meta.id) || !ID_PATTERN.test(meta.id))) {
    errors.push('id must be a kebab-case identifier');
  }
  if (meta.title !== undefined && !isNonEmptyString(meta.title)) {
    errors.push('title must be a non-empty string');
  }
  if (meta.kind !== undefined && !GAME_KINDS.includes(meta.kind)) {
    errors.push(`kind must be one of: ${GAME_KINDS.join(', ')}`);
  }
  if (meta.itemId !== undefined && meta.itemId !== null && !isNonEmptyString(meta.itemId)) {
    errors.push('itemId must be a non-empty string or null');
  }
  if (meta.dialogueKey !== undefined && meta.dialogueKey !== null && !isNonEmptyString(meta.dialogueKey)) {
    errors.push('dialogueKey must be a non-empty string or null');
  }
  if (meta.rewardKey !== undefined && meta.rewardKey !== null && !isNonEmptyString(meta.rewardKey)) {
    errors.push('rewardKey must be a non-empty string or null');
  }
  if (meta.activityId !== undefined && meta.activityId !== null
    && (!isNonEmptyString(meta.activityId) || !ID_PATTERN.test(meta.activityId))) {
    errors.push('activityId must be a kebab-case identifier or null');
  }

  if (meta.players !== undefined && !isPositiveInteger(meta.players)) {
    errors.push('players must be a positive integer');
  }
  if (meta.seats !== undefined && !isPositiveInteger(meta.seats)) {
    errors.push('seats must be a positive integer');
  }
  if (isPositiveInteger(meta.players) && isPositiveInteger(meta.seats) && meta.seats < meta.players) {
    errors.push('seats must be greater than or equal to players');
  }

  if (meta.board === null) {
    if (meta.kind === 'board') errors.push('board is required when kind is board');
  } else if (meta.board !== undefined) {
    validateBoard(meta.board, errors);
  }

  if (meta.input !== undefined) {
    if (!isPlainObject(meta.input)) {
      errors.push('input must be an object');
    } else {
      if (!INPUT_MODES.includes(meta.input.mode)) {
        errors.push(`input.mode must be one of: ${INPUT_MODES.join(', ')}`);
      }
      if (meta.input.actionLabel !== undefined && !isNonEmptyString(meta.input.actionLabel)) {
        errors.push('input.actionLabel must be a non-empty string');
      }
    }
  }

  if (meta.renderLayers !== undefined) {
    if (!Array.isArray(meta.renderLayers) || meta.renderLayers.length === 0) {
      errors.push('renderLayers must be a non-empty array');
    } else {
      for (const layer of meta.renderLayers) {
        if (!RENDER_LAYERS.includes(layer)) {
          errors.push(`renderLayers contains unknown layer: ${String(layer)}`);
        }
      }
    }
  }

  if (meta.render !== undefined) {
    if (!isPlainObject(meta.render)) {
      errors.push('render must be an object');
    } else {
      if (meta.render.mode !== undefined && !RENDER_MODES.includes(meta.render.mode)) {
        errors.push(`render.mode must be one of: ${RENDER_MODES.join(', ')}`);
      }
      if (meta.render.mode === 'fullview') {
        if (meta.kind !== 'activity') errors.push('render.mode fullview requires kind activity');
        if (meta.board !== null) errors.push('render.mode fullview requires board: null');
      }
    }
  }

  if (meta.timing !== undefined) validateTiming(meta.timing, errors);
  if (meta.persist !== undefined && typeof meta.persist !== 'boolean') {
    errors.push('persist must be a boolean');
  }
  if (meta.activity !== undefined && !ACTIVITY_MODES.includes(meta.activity)) {
    errors.push(`activity must be one of: ${ACTIVITY_MODES.join(', ')}`);
  }

  return { ok: errors.length === 0, errors };
}

export function assertValidMeta(meta) {
  const result = validateMeta(meta);
  if (!result.ok) {
    throw new Error(`Invalid mini-game metadata: ${result.errors.join('; ')}`);
  }
  return meta;
}

/**
 * Small default implementation games can extend. Only lifecycle and neutral
 * query/rendering methods live here; each concrete game supplies rules.
 */
export class MiniGameBase {
  constructor(meta = {}) {
    this.meta = meta;
    this.id = meta.id || '';
    this.phase = PHASES.IDLE;
    this.paused = false;
    this.pauseReason = null;
    this.seats = [];
    this.placement = null;
    this.options = {};
    this.closeReason = null;
    this.finishEvent = null;
  }

  /**
   * @param {{ seats?: Array<object>, placement?: object|null, options?: object }} [context]
   * @returns {{ ok: boolean, phase: string, durationMs?: number, message?: string }}
   */
  open({ seats = [], placement = null, options = {} } = {}) {
    this.seats = Array.isArray(seats) ? seats : [];
    this.placement = placement || null;
    this.options = options || {};
    this.phase = PHASES.OPENING;
    this.paused = false;
    this.pauseReason = null;
    this.closeReason = null;
    this.finishEvent = null;
    return {
      ok: true,
      phase: this.phase,
      durationMs: this.meta?.timing?.openMs ?? 0
    };
  }

  ready() {
    if (this.phase === PHASES.IDLE) {
      return { ok: false, phase: this.phase, message: 'game has not opened' };
    }
    this.phase = PHASES.READY;
    return { ok: true, phase: this.phase };
  }

  start() {
    if (this.phase === PHASES.IDLE) {
      return { ok: false, phase: this.phase, message: 'game has not opened' };
    }
    this.phase = PHASES.PLAYING;
    return { ok: true, phase: this.phase };
  }

  /** @returns {StepResult} */
  update(dtMs) {
    return emptyStepResult();
  }

  /** @returns {StepResult} */
  handleInput(input) {
    return emptyStepResult();
  }

  pause(reason = 'paused') {
    this.paused = true;
    this.pauseReason = reason;
    return { paused: true, reason };
  }

  resume(reason = 'resumed') {
    this.paused = false;
    this.pauseReason = null;
    return { paused: false, reason };
  }

  close({ reason = 'closed' } = {}) {
    this.closeReason = reason;
    this.phase = PHASES.CLOSING;
    return createStepResult({ events: [{ type: 'closed', reason }] });
  }

  finish({ winnerSeat = null, outcome = null, seat = 0 } = {}) {
    this.phase = PHASES.ENDING;
    this.finishEvent = { type: 'finish', winnerSeat, outcome, seat };
    return createStepResult({ handled: true, changed: true, events: [this.finishEvent] });
  }

  serialize() {
    return {
      id: this.id,
      phase: this.phase,
      paused: this.paused,
      seats: this.seats.map(seat => seat?.character?.id ?? seat?.character ?? null),
      placement: this.placement
    };
  }

  restore(state = {}) {
    if (state.phase) this.phase = state.phase;
    if (typeof state.paused === 'boolean') this.paused = state.paused;
    if (state.placement !== undefined) this.placement = state.placement;
    return { ok: true, phase: this.phase };
  }

  getFootprint() {
    const board = this.meta?.board;
    if (!board || !this.placement) return null;
    const x = this.placement.originX ?? this.placement.x;
    const y = this.placement.originY ?? this.placement.y;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y, width: board.width, height: board.height };
  }

  getHiddenZones() {
    const zones = this.meta?.board?.hiddenZones;
    return Array.isArray(zones) ? zones.map(zone => ({ ...zone })) : [];
  }

  getRenderables() {
    return [];
  }

  render(ctx, layer, view) {
    // Concrete games draw here.
  }
}
