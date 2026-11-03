/**
 * Park courses — the shared side-scrolling run-and-jump activity.
 *
 * One implementation serves every course id in `data/activities.json`. Each
 * entry carries its own title, terrain theme, physics, authored course, par,
 * ghost line, and coin reward. Rules and state only; the host owns settlement,
 * stats, rewards, and dialogue.
 *
 * The course is fixed-step (120 Hz) and deterministic. Physics and course data
 * live in data/activities.json and are covered by tests.
 */
import {
  MiniGameBase,
  PHASES,
  createStepResult,
  emptyStepResult
} from '../minigames/contract.js';
import { drawAvatar, getAvatarImage, loadAvatarImage } from '../avatar.js';
import activitiesData from '../../data/activities.json' with { type: 'json' };

export const ACTIVITIES = activitiesData.activities || {};

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HEX_PATTERN = /^#[0-9a-f]{6}$/i;

/**
 * The side-view terrain vocabulary. Data picks names from these lists, never
 * free-form art directions, so a typo fails validation instead of silently
 * falling back to a grey rectangle.
 */
export const SURFACE_TYPES = Object.freeze(['grass', 'dirt', 'sand', 'stone', 'boardwalk']);
export const SUBSURFACE_TYPES = Object.freeze(['dirt', 'rock', 'sand']);
export const PLATFORM_MATERIALS = Object.freeze(['wood', 'stone', 'metal', 'boardwalk']);
export const BACKDROPS = Object.freeze(['park', 'city', 'shore']);
export const PROP_TYPES = Object.freeze([
  'tree', 'bush', 'lamp', 'bench', 'flag', 'umbrella', 'palm', 'sign',
  'tank', 'vent', 'towel', 'shell', 'hut'
]);

/**
 * Material palettes. The course theme names a material and optionally overrides
 * the flat body colours; the renderer owns the per-material detail.
 */
const SURFACE_STYLES = Object.freeze({
  grass: { cap: '#5f9f58', lip: '#8ccc7a', blade: '#a5e08c', detail: '#3f7a45' },
  dirt: { cap: '#a17a4f', lip: '#c19a68', blade: '#8a6540', detail: '#7a5836' },
  sand: { cap: '#ddc584', lip: '#f0dfae', blade: '#efe0b4', detail: '#bfa469' },
  stone: { cap: '#8b8494', lip: '#ada6b7', blade: '#756e7f', detail: '#625b6c' },
  boardwalk: { cap: '#b98a56', lip: '#d8ab72', blade: '#96693c', detail: '#7d5731' }
});

const SUBSURFACE_STYLES = Object.freeze({
  dirt: {
    base: '#8f6a45',
    seam: 'rgba(58, 38, 22, 0.24)',
    speck: 'rgba(200, 164, 116, 0.55)',
    edge: 'rgba(46, 30, 16, 0.45)'
  },
  rock: {
    base: '#7b7268',
    seam: 'rgba(32, 28, 24, 0.3)',
    speck: 'rgba(168, 162, 150, 0.5)',
    edge: 'rgba(28, 26, 22, 0.48)'
  },
  sand: {
    base: '#cdb377',
    seam: 'rgba(120, 94, 44, 0.16)',
    speck: 'rgba(240, 224, 176, 0.55)',
    edge: 'rgba(112, 88, 42, 0.35)'
  }
});

const PLATFORM_STYLES = Object.freeze({
  wood: { base: '#a97a49', top: '#cba06a', dark: '#7a5630', seam: 'rgba(86, 58, 30, 0.42)', nail: '#e0c79a' },
  stone: { base: '#867e8c', top: '#aaa3b4', dark: '#5c5666', seam: 'rgba(56, 50, 64, 0.32)', nail: '#c9c3d2' },
  metal: { base: '#5b646f', top: '#8f9aa6', dark: '#39414a', seam: 'rgba(24, 30, 36, 0.5)', nail: '#c4ccd6' },
  boardwalk: { base: '#bd9660', top: '#dbb77f', dark: '#8d6a3e', seam: 'rgba(104, 74, 40, 0.4)', nail: '#f0dcb4' }
});

/** Fallback palette; every shipped course overrides it in data. */
export const DEFAULT_THEME = Object.freeze({
  skyTop: '#7fc4e8',
  skyBottom: '#d9efc8',
  far: 'rgba(255, 255, 255, 0.10)',
  ground: '#4e8950',
  groundEdge: '#8ed07f',
  platform: '#a97a49',
  platformEdge: '#d3a56e',
  platformDash: 'rgba(90, 62, 32, 0.35)',
  finish: '#8fd47f',
  finishFaint: 'rgba(143, 212, 127, 0.3)',
  ghost: 'rgba(255, 255, 255, 0.55)',
  player: '#ffd98a',
  playerEdge: '#3b2f1c',
  eye: '#3b2f1c',
  surface: 'grass',
  subsurface: 'dirt',
  platformMaterial: 'wood',
  backdrop: 'park',
  water: null,
  props: Object.freeze([])
});

/** Resolve one activity definition, or null when the id is unknown. */
export function activityDefinition(id, data = ACTIVITIES) {
  return (data && data[id]) || null;
}

export function isActivityEnabled(id, data = ACTIVITIES) {
  return Boolean(activityDefinition(id, data)?.enabled);
}

/**
 * Every course a chooser may offer, in data order. Disabled entries are left
 * out so a half-built course is never reachable.
 */
export function activityList(data = ACTIVITIES) {
  return Object.values(data || {}).filter(entry => entry && entry.enabled === true);
}

/** Merge one course's palette over the shared default. */
export function themeFor(definition) {
  return { ...DEFAULT_THEME, ...(definition?.theme || {}) };
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isPositive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function overlaps(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** Stable pseudo-random in [0, 1); deco only, so it never touches physics. */
function hash01(n) {
  const value = Math.sin(n * 127.1 + 311.7) * 43758.5453123;
  return value - Math.floor(value);
}

function styleFor(table, name, fallback) {
  return table[name] || table[fallback];
}

function spansView(rect, view) {
  return !view || (rect.x + rect.w > view.left - 160 && rect.x < view.right + 160);
}

/** World units per second for the authored ghost line, and therefore par. */
export function parTimeFor(course, physics) {
  const distance = Math.max(0, course.finishX - course.startX);
  return physics.ghostSpeed > 0 ? distance / physics.ghostSpeed : 0;
}

/** Turn the data course into solid ground rects and one-way platform rects. */
export function buildCourse(definition) {
  const data = definition.course;
  const groundY = data.groundY;
  const solids = data.ground.map(seg => ({
    x: seg.x,
    y: groundY,
    w: seg.w,
    h: data.groundDepth,
    kind: 'ground'
  }));
  const oneWays = data.platforms.map(platform => ({
    x: platform.x,
    y: platform.y,
    w: platform.w,
    h: platform.h || 16,
    kind: 'platform'
  }));
  return {
    startX: data.startX,
    finishX: data.finishX,
    width: data.width,
    groundY,
    pitY: data.pitY,
    solids,
    oneWays,
    colliders: [...solids, ...oneWays]
  };
}

/** A fresh run at the start line. Pure data; no DOM and no timers. */
export function createRun(course, physics) {
  const spawnY = course.groundY - physics.playerHeight;
  return {
    player: {
      x: course.startX,
      y: spawnY,
      w: physics.playerWidth,
      h: physics.playerHeight,
      vx: 0,
      vy: 0,
      grounded: true,
      coyote: physics.coyoteTime,
      jumpBuffer: 0,
      facing: 1
    },
    lastSafe: { x: course.startX, y: spawnY, surface: course.solids[0] || null },
    elapsed: 0,
    finishTime: null,
    jumps: 0,
    falls: 0,
    started: false,
    finished: false
  };
}

/**
 * Sample the authored ghost line onto a flat lookup array indexed by x.
 * Screen space only: the ghost never collides with anything.
 */
export function buildGhostPath(definition) {
  const course = definition.course;
  const step = definition.ghost.sampleStep || 4;
  const path = [];
  for (const leg of definition.ghost.legs) {
    const [x0, y0] = leg.from;
    const [x1, y1] = leg.to;
    const arc = Number(leg.arc) || 0;
    const steps = Math.max(1, Math.round((x1 - x0) / step));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = x0 + (x1 - x0) * t;
      const y = y0 + (y1 - y0) * t - arc * 4 * t * (1 - t);
      path[Math.round((x - course.startX) / step)] = y;
    }
  }
  return { path, step };
}

/** Ghost foot height at a world x, interpolated between samples. */
export function ghostYAt(sample, x, course) {
  const path = sample?.path || [];
  if (!path.length) return course.groundY;
  const raw = (x - course.startX) / (sample.step || 4);
  const i = clamp(Math.floor(raw), 0, path.length - 1);
  const f = clamp(raw - i, 0, 1);
  const a = path[i] ?? path[i - 1] ?? course.groundY;
  const b = path[i + 1] ?? a;
  return a + (b - a) * f;
}

/** Ghost front foot x at elapsed seconds; the authored pace is constant. */
export function ghostXAt(elapsed, definition) {
  const { course } = definition;
  return Math.min(course.finishX, course.startX + definition.physics.ghostSpeed * Math.max(0, elapsed));
}

/** Take-off timestamps of the authored jumps, used by tests and debug UI. */
export function ghostJumpTimes(definition) {
  const { course, physics } = definition;
  return definition.ghost.legs
    .filter(leg => (Number(leg.arc) || 0) > 0)
    .map(leg => ({
      takeoffX: leg.from[0],
      landX: leg.to[0],
      at: (leg.from[0] - course.startX) / physics.ghostSpeed
    }));
}

/** Win means finishing at or under par. */
export function outcomeForTime(time, par) {
  return Number(time) <= Number(par) ? 'win' : 'loss';
}

function respawn(run, course, physics) {
  const player = run.player;
  const safe = run.lastSafe;
  const surface = safe?.surface || course.solids[0];
  if (!surface) {
    player.x = course.startX;
    player.y = course.groundY - physics.playerHeight;
  } else {
    const back = Math.max(surface.x + 16, (safe?.x ?? surface.x) - 140);
    player.x = clamp(back, surface.x + 16, surface.x + surface.w - player.w - 16);
    player.y = surface.y - player.h;
  }
  player.vx = 0;
  player.vy = 0;
  player.grounded = true;
  player.coyote = physics.coyoteTime;
  player.jumpBuffer = 0;
  run.falls += 1;
}

/**
 * Advance one fixed step. Mutates `run`; clears the edge flags on `input`.
 * Returns what changed so the caller can raise events.
 */
export function stepRun(run, input, physics, course, dt) {
  const player = run.player;
  const result = { fell: false, finished: false };

  if (input.jumpQueued) {
    player.jumpBuffer = physics.jumpBuffer;
    input.jumpQueued = false;
  }

  const direction = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  if (direction !== 0) {
    const accel = player.grounded ? physics.accelGround : physics.accelAir;
    player.vx += direction * accel * dt;
    if (Math.abs(player.vx) > physics.runSpeed) player.vx = Math.sign(player.vx) * physics.runSpeed;
    player.facing = direction;
  } else {
    const friction = (player.grounded ? physics.frictionGround : physics.frictionAir) * dt;
    if (Math.abs(player.vx) <= friction) player.vx = 0;
    else player.vx -= Math.sign(player.vx) * friction;
  }

  player.jumpBuffer = Math.max(0, player.jumpBuffer - dt);
  player.coyote = player.grounded ? physics.coyoteTime : Math.max(0, player.coyote - dt);

  if (player.jumpBuffer > 0 && player.coyote > 0) {
    player.vy = -physics.jumpVelocity;
    player.grounded = false;
    player.coyote = 0;
    player.jumpBuffer = 0;
    run.jumps += 1;
  }

  // Variable height: releasing early while rising cuts the arc.
  if (input.jumpCut) {
    if (player.vy < 0) player.vy *= physics.jumpCut;
    input.jumpCut = false;
  }

  player.vy += (player.vy < 0 ? physics.gravityUp : physics.gravityDown) * dt;
  if (player.vy > physics.maxFallSpeed) player.vy = physics.maxFallSpeed;

  // Horizontal against solid ground only; platforms never block sideways.
  player.x += player.vx * dt;
  for (const solid of course.solids) {
    if (!overlaps(player, solid)) continue;
    if (player.vx > 0) player.x = solid.x - player.w;
    else if (player.vx < 0) player.x = solid.x + solid.w;
    player.vx = 0;
  }
  if (player.x < 0) {
    player.x = 0;
    player.vx = Math.max(0, player.vx);
  }
  if (player.x + player.w > course.width) {
    player.x = course.width - player.w;
    player.vx = Math.min(0, player.vx);
  }

  // Vertical: land on the highest surface crossed this step.
  const previousBottom = player.y + player.h;
  player.y += player.vy * dt;
  player.grounded = false;
  let surface = null;
  for (const collider of course.colliders) {
    if (!(player.x < collider.x + collider.w && player.x + player.w > collider.x)) continue;
    if (player.vy < 0) continue;
    if (previousBottom > collider.y + 1) continue;
    if (player.y + player.h < collider.y) continue;
    if (surface && collider.y >= surface.y) continue;
    surface = collider;
  }
  if (surface) {
    player.y = surface.y - player.h;
    player.vy = 0;
    player.grounded = true;
    run.lastSafe = { x: player.x, y: player.y, surface };
  }

  if (player.y > course.pitY) {
    respawn(run, course, physics);
    result.fell = true;
  }

  if (player.x + player.w / 2 >= course.finishX && !run.finished) {
    run.finished = true;
    run.finishTime = run.elapsed;
    result.finished = true;
  }

  return result;
}

/** Fixed-step camera follow, horizontal only. */
export function stepCamera(camera, run, physics, course, viewWidth, dt) {
  const player = run.player;
  const width = Number(viewWidth) > 0 ? viewWidth : physics.minViewWidth;
  const target = clamp(
    player.x + player.w / 2 - width * physics.cameraLead,
    0,
    Math.max(0, course.width + 200 - width)
  );
  if (camera.snap) {
    camera.x = target;
    camera.snap = false;
  } else {
    camera.x += (target - camera.x) * (1 - Math.exp(-dt * physics.cameraSmooth));
  }
  return camera.x;
}

/**
 * Coins for one finish: a small base every time, plus a flat under-par bonus.
 * The activity never touches the purse itself; the shell applies this once.
 */
export function rewardForActivity(definition, { outcome = null } = {}) {
  const reward = definition?.reward || {};
  const base = Math.max(0, Math.round(Number(reward.base) || 0));
  const underPar = Math.max(0, Math.round(Number(reward.underPar) || 0));
  const bonus = outcome === 'win' ? underPar : 0;
  return { coins: base + bonus, base, bonus };
}

/** Best time in milliseconds for one course, or null when never finished. */
export function bestMsFor(records, id) {
  const best = records?.[id]?.bestMs;
  return Number.isFinite(best) && best > 0 ? Math.round(best) : null;
}

/**
 * Fold one finish into the best-time table. Returns a new table; the caller
 * owns persistence. Clears count every finish, bestMs only improves.
 */
export function recordActivityAttempt(records, id, timeMs) {
  const source = isObject(records) ? records : {};
  const previous = isObject(source[id]) ? source[id] : {};
  const previousBest = Number.isFinite(previous.bestMs) && previous.bestMs > 0
    ? Math.round(previous.bestMs)
    : null;
  const clears = Math.max(0, Math.floor(Number(previous.clears) || 0));
  const ms = Number.isFinite(Number(timeMs)) ? Math.max(1, Math.round(Number(timeMs))) : null;
  if (!id || ms === null) {
    return {
      records: source,
      bestMs: previousBest,
      clears,
      improved: false,
      recorded: false
    };
  }
  const bestMs = previousBest === null ? ms : Math.min(previousBest, ms);
  return {
    records: { ...source, [id]: { bestMs, clears: clears + 1 } },
    bestMs,
    clears: clears + 1,
    improved: previousBest === null || ms < previousBest,
    recorded: true
  };
}

/** Seconds with two decimals, the HUD's time format. */
export function formatActivityTime(ms) {
  return Number.isFinite(ms) && ms > 0 ? (ms / 1000).toFixed(2) : null;
}

/**
 * One course row for the board: title, a short look-and-feel subtitle, par, and
 * the player's best. Shared so the chooser copy and its test read one string.
 */
export function activityChoiceLabel(definition, bestMs = null) {
  const badge = typeof definition?.badge === 'string' ? definition.badge.trim() : '';
  const title = typeof definition?.title === 'string' && definition.title ? definition.title : 'Course';
  const subtitle = typeof definition?.subtitle === 'string' ? definition.subtitle.trim() : '';
  const par = Number(definition?.par);
  const parLabel = Number.isFinite(par) && par > 0 ? `par ${par.toFixed(2)}s` : 'par —';
  const best = formatActivityTime(bestMs);
  const bestLabel = best ? `best ${best}s` : 'no time yet';
  return `${badge ? `${badge} ` : ''}${title}${subtitle ? ` · ${subtitle}` : ''} · ${parLabel} · ${bestLabel}`;
}

/**
 * Structural checks for one activity entry. Returns human-readable errors so a
 * data test, the debug UI, and the chooser can all report the same thing.
 */
export function validateActivityDefinition(definition) {
  const errors = [];
  if (!isObject(definition)) return { ok: false, errors: ['activity must be an object'] };
  if (!ID_PATTERN.test(String(definition.id))) errors.push('id must be kebab-case');
  if (typeof definition.enabled !== 'boolean') errors.push('enabled must be a boolean');
  if (!definition.title || typeof definition.title !== 'string') errors.push('title must be a non-empty string');
  if (definition.subtitle !== undefined
    && (typeof definition.subtitle !== 'string' || !definition.subtitle.trim())) {
    errors.push('subtitle must be a non-empty string when present');
  }
  if (definition.badge !== undefined
    && (typeof definition.badge !== 'string'
      || !definition.badge.trim()
      || definition.badge.trim().length > 8)) {
    errors.push('badge must be a short non-empty string when present');
  }

  const physics = definition.physics;
  if (!isObject(physics)) {
    errors.push('physics must be an object');
  } else {
    for (const key of [
      'stepHz', 'maxCatchupSteps', 'viewHeight', 'minViewWidth', 'runSpeed',
      'accelGround', 'accelAir', 'frictionGround', 'frictionAir', 'gravityUp',
      'gravityDown', 'jumpVelocity', 'jumpCut', 'maxFallSpeed', 'coyoteTime',
      'jumpBuffer', 'playerWidth', 'playerHeight', 'cameraLead', 'cameraSmooth',
      'ghostSpeed'
    ]) {
      if (!isPositive(physics[key])) errors.push(`physics.${key} must be a positive number`);
    }
  }

  const course = definition.course;
  if (!isObject(course)) {
    errors.push('course must be an object');
  } else {
    for (const key of ['startX', 'finishX', 'width', 'groundY', 'groundDepth', 'pitY']) {
      if (!isPositive(course[key])) errors.push(`course.${key} must be a positive number`);
    }
    if (!Array.isArray(course.ground) || course.ground.length < 2) {
      errors.push('course.ground needs at least two segments');
    } else {
      let cursor = 0;
      for (const [index, seg] of course.ground.entries()) {
        if (!isObject(seg) || !Number.isFinite(seg.x) || !isPositive(seg.w)) {
          errors.push(`course.ground[${index}] must be { x, w }`);
          continue;
        }
        if (seg.x < cursor) errors.push(`course.ground[${index}] overlaps the previous segment`);
        cursor = seg.x + seg.w;
      }
      const first = course.ground[0];
      const last = course.ground[course.ground.length - 1];
      if (isObject(first) && !(course.startX >= first.x && course.startX < first.x + first.w)) {
        errors.push('course.startX must stand on the first ground segment');
      }
      if (isObject(last) && !(course.finishX > last.x && course.finishX <= last.x + last.w)) {
        errors.push('course.finishX must land on the last ground segment');
      }
      if (course.finishX > course.width) errors.push('course.width must cover the finish');
      if (course.width < cursor - 1) errors.push('course.width is narrower than its ground');
      if (!(course.pitY > course.groundY)) errors.push('course.pitY must sit below the ground line');
    }
    if (!Array.isArray(course.platforms)) {
      errors.push('course.platforms must be an array');
    } else {
      for (const [index, platform] of course.platforms.entries()) {
        if (!isObject(platform) || !isPositive(platform.w) || !Number.isFinite(platform.y)) {
          errors.push(`course.platforms[${index}] must be { x, w, y }`);
          continue;
        }
        if (!(platform.y < course.groundY)) errors.push(`course.platforms[${index}] must float above ground`);
      }
    }
    if (isObject(physics) && isPositive(physics.ghostSpeed)) {
      const derived = parTimeFor(course, physics);
      if (!(Number(definition.par) > 0)) errors.push('par must be a positive number');
      else if (Math.abs(definition.par - derived) > 0.02) {
        errors.push(`par ${definition.par} drifts from the ghost pace ${derived.toFixed(2)}`);
      }
    }
  }

  const ghost = definition.ghost;
  if (!isObject(ghost) || !Array.isArray(ghost.legs) || !ghost.legs.length) {
    errors.push('ghost.legs must be a non-empty array');
  } else {
    let lastX = -Infinity;
    for (const [index, leg] of ghost.legs.entries()) {
      if (!isObject(leg) || !Array.isArray(leg.from) || !Array.isArray(leg.to)) {
        errors.push(`ghost.legs[${index}] must be { from, to, arc }`);
        continue;
      }
      if (!(leg.to[0] >= leg.from[0])) errors.push(`ghost.legs[${index}] must run left to right`);
      if (leg.from[0] < lastX) errors.push(`ghost.legs[${index}] starts behind the previous leg`);
      if (!Number.isFinite(Number(leg.arc) || 0) || Number(leg.arc || 0) < 0) {
        errors.push(`ghost.legs[${index}] arc must be non-negative`);
      }
      lastX = leg.to[0];
    }
    if (isObject(course) && ghost.legs[0]?.from?.[0] !== course.startX) {
      errors.push('the ghost must start on the start line');
    }
    if (isObject(course) && ghost.legs[ghost.legs.length - 1]?.to?.[0] < course.finishX) {
      errors.push('the ghost must reach the finish line');
    }
  }

  const theme = definition.theme;
  if (!isObject(theme)) {
    errors.push('theme must be an object');
  } else {
    for (const key of ['skyTop', 'skyBottom', 'ground', 'groundEdge', 'platform', 'platformEdge', 'finish', 'player']) {
      if (typeof theme[key] !== 'string' || !theme[key]) errors.push(`theme.${key} must be a colour`);
    }
    if (typeof theme.skyTop === 'string' && HEX_PATTERN.test(theme.skyTop) === false) {
      errors.push('theme.skyTop must be a hex colour');
    }

    // Side-view terrain vocabulary. Every key is optional so a minimal theme
    // still validates; when present it must name a material we can draw.
    for (const [key, allowed] of [
      ['surface', SURFACE_TYPES],
      ['subsurface', SUBSURFACE_TYPES],
      ['platformMaterial', PLATFORM_MATERIALS],
      ['backdrop', BACKDROPS]
    ]) {
      if (theme[key] !== undefined && !allowed.includes(theme[key])) {
        errors.push(`theme.${key} must be one of ${allowed.join(', ')}`);
      }
    }
    if (theme.water !== undefined && (typeof theme.water !== 'string' || !theme.water)) {
      errors.push('theme.water must be a colour when present');
    }
    if (theme.props !== undefined) {
      if (!Array.isArray(theme.props)) {
        errors.push('theme.props must be an array');
      } else {
        for (const [index, prop] of theme.props.entries()) {
          if (!isObject(prop)) {
            errors.push(`theme.props[${index}] must be an object`);
            continue;
          }
          if (!PROP_TYPES.includes(prop.type)) {
            errors.push(`theme.props[${index}].type must be one of ${PROP_TYPES.join(', ')}`);
          }
          if (!Number.isFinite(prop.x) || prop.x < 0) {
            errors.push(`theme.props[${index}].x must be a non-negative number`);
          }
          if (!Number.isFinite(prop.y)) errors.push(`theme.props[${index}].y must be a number`);
          if (prop.scale !== undefined && !isPositive(prop.scale)) {
            errors.push(`theme.props[${index}].scale must be a positive number`);
          }
          if (isObject(course) && isPositive(course.width)
            && Number.isFinite(prop.x) && prop.x > course.width) {
            errors.push(`theme.props[${index}].x must sit inside the course`);
          }
        }
      }
    }
  }

  if (!isObject(definition.reward)) {
    errors.push('reward must be an object');
  } else {
    for (const key of ['base', 'underPar']) {
      if (!Number.isFinite(definition.reward[key]) || definition.reward[key] < 0) {
        errors.push(`reward.${key} must be a non-negative number`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * The activity itself. Host contract entry points: open/ready/update/
 * handleInput/close, plus describeStatus and the full-view render pass.
 */
export class CourseActivity extends MiniGameBase {
  constructor({ host = null, meta = null, game = null, options = {} } = {}) {
    super(meta || {});
    this.host = host;
    this.game = game || options?.game || host?.game || null;
    this.options = options || {};
    const id = meta?.activityId || meta?.id || 'jungle-gym';
    this.definition = activityDefinition(id);
    if (!this.definition) throw new Error(`Unknown activity: ${id}`);
    this.physics = this.definition.physics;
    this.course = buildCourse(this.definition);
    this.ghostSample = buildGhostPath(this.definition);
    this.par = parTimeFor(this.course, this.physics);
    this.theme = themeFor(this.definition);
    this.input = { left: false, right: false, jumpQueued: false, jumpCut: false };
    this.accumulator = 0;
    this.viewWidth = 0;
    this.camera = { x: 0, snap: true };
    this.playerCharacter = null;
    this.ghostCharacter = null;
    this.finishSent = false;
    this._events = [];
    this.run = createRun(this.course, this.physics);
  }

  open({ seats = [], placement = null, options = {} } = {}) {
    const base = super.open({ seats, placement, options });
    this.options = { ...this.options, ...options };
    this.playerCharacter = seats[0]?.character || this.game?.player || null;
    this.ghostCharacter = seats[1]?.character || this.options.opponent || null;
    this.reset();
    this.phase = PHASES.READY;
    return { ok: true, phase: this.phase, durationMs: base.durationMs };
  }

  ready() {
    if (this.phase === PHASES.IDLE) {
      return { ok: false, phase: this.phase, message: `the ${this.definition.title.toLowerCase()} is not open` };
    }
    this.phase = PHASES.READY;
    return { ok: true, phase: this.phase };
  }

  start() {
    if (!this.run.started) this.run.started = true;
    this.phase = PHASES.PLAYING;
    return { ok: true, phase: this.phase };
  }

  /** Put the runner back on the start line without closing the session. */
  reset() {
    this.run = createRun(this.course, this.physics);
    this.input = { left: false, right: false, jumpQueued: false, jumpCut: false };
    this.accumulator = 0;
    this.camera = { x: 0, snap: true };
    this.finishSent = false;
    this._events = [];
    this.phase = PHASES.READY;
    return { ok: true, phase: this.phase };
  }

  restart() {
    return this.reset();
  }

  update(dtMs) {
    if (this.phase !== PHASES.PLAYING) return emptyStepResult();
    const seconds = Number.isFinite(dtMs) ? clamp(dtMs / 1000, 0, 0.25) : 0;
    this.accumulator += seconds;

    const stepSeconds = 1 / this.physics.stepHz;
    let steps = 0;
    while (this.accumulator >= stepSeconds && steps < this.physics.maxCatchupSteps) {
      this.tick(stepSeconds);
      this.accumulator -= stepSeconds;
      steps += 1;
      if (this.run.finished) break;
    }
    if (steps >= this.physics.maxCatchupSteps) this.accumulator = 0;

    return createStepResult({
      handled: steps > 0,
      changed: steps > 0,
      events: this._drain()
    });
  }

  /** One fixed simulation step; also advances the camera and the clock. */
  tick(dt) {
    if (this.run.finished) return;
    this.run.elapsed += dt;
    const change = stepRun(this.run, this.input, this.physics, this.course, dt);
    // The camera only follows once a render has told us how wide the view is;
    // until then it stays snapped so the first visible frame is already framed.
    if (this.viewWidth > 0) {
      stepCamera(this.camera, this.run, this.physics, this.course, this.viewWidth, dt);
    } else {
      this.camera.snap = true;
    }
    if (change.finished && !this.finishSent) {
      this.finishSent = true;
      this.phase = PHASES.ENDING;
      const par = this.par;
      const time = this.run.finishTime ?? this.run.elapsed;
      const outcome = outcomeForTime(time, par);
      this._events.push({
        type: 'finish',
        seat: 0,
        winnerSeat: outcome === 'win' ? 0 : 1,
        outcome,
        record: true,
        reward: false,
        time: Number(time.toFixed(2)),
        timeMs: Math.round(time * 1000),
        par: Number(par.toFixed(2))
      });
    }
    return change;
  }

  /**
   * Accepts `{ type: 'hold', left, right, jumpPressed, jumpReleased }`,
   * `{ type: 'action' }` for Enter/Space, and `{ type: 'restart' }`.
   */
  handleInput(input = {}) {
    if (!input || typeof input !== 'object') return emptyStepResult();
    const kind = input.kind || input.type;
    let changed = false;

    if (kind === 'restart') {
      this.reset();
      return createStepResult({ handled: true, changed: true, events: [] });
    }
    // The end beat owns input once the run is over; only restart leaves it.
    if (this.phase === PHASES.ENDING) return emptyStepResult();

    if (kind === 'hold') {
      const left = Boolean(input.left);
      const right = Boolean(input.right);
      if (left !== this.input.left || right !== this.input.right) {
        this.input.left = left;
        this.input.right = right;
        changed = true;
      }
      if (input.jumpPressed) {
        this.input.jumpQueued = true;
        changed = true;
      }
      if (input.jumpReleased) {
        this.input.jumpCut = true;
      }
    } else if (kind === 'action' || kind === 'jump') {
      this.input.jumpQueued = true;
      changed = true;
    } else {
      return emptyStepResult();
    }

    if (this.phase === PHASES.READY && (changed || this.run.started)) this.start();

    return createStepResult({ handled: changed, changed, events: this._drain() });
  }

  describeStatus() {
    if (this.phase === PHASES.READY) {
      return { instruction: 'press enter or tap X to run' };
    }
    if (this.phase === PHASES.PLAYING) return { instruction: null };
    return null;
  }

  /** Remember the saved best for the HUD and the chooser. */
  setBestMs(ms) {
    this.options.bestMs = Number.isFinite(ms) && ms > 0 ? Math.round(ms) : null;
    return this.options.bestMs;
  }

  /** Read-only snapshot the shell renders in its activity HUD. */
  getHud() {
    const time = this.run.finished ? this.run.finishTime : this.run.elapsed;
    return {
      id: this.definition.id,
      title: this.meta?.title || this.definition.title,
      time: Number((time || 0).toFixed(2)),
      par: Number(this.par.toFixed(2)),
      delta: Number(((time || 0) - this.par).toFixed(2)),
      bestMs: Number.isFinite(this.options?.bestMs) ? Math.round(this.options.bestMs) : null,
      state: this.run.finished ? 'finished' : (this.phase === PHASES.PLAYING ? 'running' : 'ready'),
      outcome: this.run.finished && this.run.finishTime !== null
        ? outcomeForTime(this.run.finishTime, this.par)
        : null,
      jumps: this.run.jumps,
      falls: this.run.falls,
      ghostName: this.ghostCharacter?.name || null
    };
  }

  getFootprint() {
    return null;
  }

  getHiddenZones() {
    return [];
  }

  blocksStep() {
    return false;
  }

  isTileOnBoard() {
    return false;
  }

  /**
   * Full-view render pass. The shell skips the Park entirely and hands us the
   * raw canvas; we own layout, camera, and every pixel until close.
   *
   * Draw order is screen order: sky, parallax backdrop, pit recess/water, ground,
   * platforms, set dressing, gates, then the characters. Everything positions by
   * screen Y so the terrain always reads as a side view of the Park.
   */
  renderView(ctx, view = {}) {
    const width = Number(view.width) || 0;
    const height = Number(view.height) || 0;
    if (!width || !height) return false;
    const dpr = Number(view.dpr) || 1;
    const { physics, course, theme } = this;

    const scale = Math.min(height / physics.viewHeight, width / physics.minViewWidth);
    const viewW = width / scale;
    const viewH = height / scale;
    this.viewWidth = viewW;

    const camX = this.camera.x;
    const camY = course.groundY - viewH * 0.78;
    const frame = { left: camX, right: camX + viewW, top: camY, bottom: camY + viewH };

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.drawSky(ctx, width, height);
    this.drawBackdrop(ctx, { dpr, scale, camX, camY, viewW });

    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * -camX * scale, dpr * -camY * scale);

    // Warm haze between the backdrop and the play space; `far` is the tint.
    ctx.fillStyle = theme.far;
    ctx.fillRect(camX - 40, course.groundY - 150, viewW + 80, 152);

    this.drawPits(ctx, frame);
    this.drawGround(ctx, frame);
    this.drawPlatforms(ctx, frame);
    this.drawProps(ctx, frame);
    this.drawStartGate(ctx);
    this.drawFinishGate(ctx);
    this.drawGhost(ctx);
    this.drawPlayer(ctx);

    ctx.restore();
    return true;
  }

  drawSky(ctx, width, height) {
    const theme = this.theme;
    const sky = ctx.createLinearGradient(0, 0, 0, height);
    sky.addColorStop(0, theme.skyTop);
    sky.addColorStop(1, theme.skyBottom);
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, width, height);

    // Soft sun/moon glow, fixed in screen space.
    const glow = theme.backdrop === 'city' ? '#ffd2a0' : '#fff6cf';
    const cx = width * 0.76;
    const cy = height * 0.22;
    const radius = Math.max(26, width * 0.045);
    ctx.globalAlpha = 0.4;
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 0.16;
    ctx.beginPath();
    ctx.arc(cx, cy, radius * 1.7, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  /** Parallax silhouettes, one vocabulary per backdrop name. */
  drawBackdrop(ctx, { dpr, scale, camX, camY, viewW }) {
    const groundY = this.course.groundY;
    const backdrop = BACKDROPS.includes(this.theme.backdrop) ? this.theme.backdrop : 'park';
    const layer = factor => ctx.setTransform(
      dpr * scale,
      0,
      0,
      dpr * scale,
      dpr * -camX * factor * scale,
      dpr * -camY * scale
    );
    const repeat = (spacing, factor, draw) => {
      const origin = camX * factor;
      const first = Math.floor(origin / spacing) - 1;
      const last = first + Math.ceil(viewW / spacing) + 3;
      for (let i = first; i <= last; i++) draw(i * spacing, i);
    };

    if (backdrop === 'city') this.drawCityBackdrop({ ctx, layer, repeat, groundY });
    else if (backdrop === 'shore') this.drawShoreBackdrop({ ctx, layer, repeat, groundY, viewW, camX });
    else this.drawParkBackdrop({ ctx, layer, repeat, groundY });
  }

  drawParkBackdrop({ ctx, layer, repeat, groundY }) {
    // Distant hills.
    layer(0.16);
    repeat(540, 0.16, (x, i) => {
      const n = hash01(i * 3.17);
      ctx.fillStyle = 'rgba(154, 200, 148, 0.42)';
      ctx.beginPath();
      ctx.ellipse(x + 140, groundY + 52, 260 + n * 80, 118 + n * 58, 0, 0, Math.PI * 2);
      ctx.fill();
    });

    // Treeline.
    layer(0.34);
    repeat(300, 0.34, (x, i) => {
      const n = hash01(i * 7.71);
      if (n < 0.16) return;
      const height = 96 + n * 76;
      const trunkX = x + 70 + n * 60;
      const trunkTop = groundY - height * 0.62;
      ctx.fillStyle = 'rgba(92, 120, 82, 0.5)';
      ctx.fillRect(trunkX - 5, trunkTop, 10, groundY - trunkTop);
      ctx.fillStyle = 'rgba(96, 148, 94, 0.6)';
      this.fillCircle(ctx, trunkX, groundY - height, 32 + n * 12);
      ctx.fillStyle = 'rgba(124, 176, 114, 0.55)';
      this.fillCircle(ctx, trunkX - 16, groundY - height - 12, 20 + n * 8);
      ctx.fillStyle = 'rgba(76, 122, 80, 0.5)';
      this.fillCircle(ctx, trunkX + 17, groundY - height + 8, 17 + n * 6);
    });

    // Bushes along the ground line.
    layer(0.52);
    repeat(190, 0.52, (x, i) => {
      const n = hash01(i * 11.3);
      if (n < 0.42) return;
      const height = 20 + n * 14;
      ctx.fillStyle = 'rgba(70, 116, 76, 0.55)';
      ctx.beginPath();
      ctx.ellipse(x + 60, groundY, 22 + n * 10, height, 0, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  drawCityBackdrop({ ctx, layer, repeat, groundY }) {
    // Far skyline, hazy.
    layer(0.16);
    repeat(180, 0.16, (x, i) => {
      const n = hash01(i * 5.31);
      const bw = 84 + n * 66;
      const bh = 110 + n * 170;
      const top = groundY - bh;
      ctx.fillStyle = 'rgba(76, 90, 126, 0.5)';
      ctx.fillRect(x, top, bw, bh);
      ctx.fillStyle = 'rgba(255, 216, 160, 0.16)';
      for (let wy = top + 16; wy < groundY - 24; wy += 26) {
        for (let wx = x + 10; wx < x + bw - 14; wx += 20) {
          if (hash01(wx * 0.7 + wy * 1.3) > 0.62) ctx.fillRect(wx, wy, 6, 9);
        }
      }
    });

    // Nearer blocks with lit windows and parapets.
    layer(0.34);
    repeat(230, 0.34, (x, i) => {
      const n = hash01(i * 9.13);
      const bw = 140 + n * 80;
      const bh = 92 + n * 138;
      const top = groundY - bh;
      ctx.fillStyle = 'rgba(42, 50, 76, 0.92)';
      ctx.fillRect(x, top, bw, bh);
      ctx.fillStyle = 'rgba(255, 196, 128, 0.5)';
      ctx.fillRect(x, top, bw, 4);
      ctx.fillStyle = 'rgba(26, 32, 52, 0.9)';
      ctx.fillRect(x + bw * 0.16, top - 12, 26, 12);
      for (let wy = top + 22; wy < groundY - 30; wy += 30) {
        for (let wx = x + 14; wx < x + bw - 20; wx += 26) {
          const lit = hash01(wx * 1.7 + wy * 0.9);
          if (lit > 0.66) ctx.fillStyle = 'rgba(255, 206, 132, 0.72)';
          else if (lit > 0.5) ctx.fillStyle = 'rgba(150, 188, 220, 0.28)';
          else continue;
          ctx.fillRect(wx, wy, 10, 12);
        }
      }
    });

    // Nearest roofline with a water tank.
    layer(0.52);
    repeat(300, 0.52, (x, i) => {
      const n = hash01(i * 13.7);
      if (n < 0.45) return;
      const bh = 60 + n * 40;
      const top = groundY - bh;
      ctx.fillStyle = 'rgba(28, 34, 52, 0.9)';
      ctx.fillRect(x + 120, top, 74, bh);
      ctx.fillStyle = 'rgba(255, 188, 120, 0.35)';
      ctx.fillRect(x + 120, top, 74, 3);
      ctx.fillStyle = 'rgba(52, 58, 78, 0.95)';
      ctx.fillRect(x + 150, top - 40, 30, 30);
      ctx.beginPath();
      ctx.ellipse(x + 165, top - 40, 15, 5, 0, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  drawShoreBackdrop({ ctx, layer, repeat, groundY, viewW, camX }) {
    // Sea band from the horizon down to the beach line.
    layer(0.12);
    const seaTop = groundY - 96;
    const originX = camX * 0.12 - 40;
    ctx.fillStyle = 'rgba(104, 176, 198, 0.55)';
    ctx.fillRect(originX, seaTop, viewW + 80, 98);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.fillRect(originX, seaTop, viewW + 80, 2);

    repeat(720, 0.12, (x, i) => {
      const n = hash01(i * 6.4);
      const height = 20 + n * 16;
      // Low headland sitting on the horizon.
      ctx.fillStyle = 'rgba(104, 148, 128, 0.5)';
      ctx.beginPath();
      ctx.moveTo(x + 140, seaTop + 2);
      ctx.lineTo(x + 186, seaTop - height * 0.6);
      ctx.lineTo(x + 238, seaTop - height);
      ctx.lineTo(x + 300, seaTop - height * 0.4);
      ctx.lineTo(x + 352, seaTop + 2);
      ctx.fill();
      // Sail boat.
      ctx.fillStyle = 'rgba(250, 246, 232, 0.6)';
      ctx.beginPath();
      ctx.moveTo(x + 470, seaTop + 24);
      ctx.lineTo(x + 470, seaTop - 8);
      ctx.lineTo(x + 487, seaTop + 24);
      ctx.fill();
    });

    // Distant beach and surf, just above the foreground terrace.
    layer(0.2);
    const beachX = camX * 0.2 - 40;
    ctx.fillStyle = 'rgba(236, 220, 178, 0.85)';
    ctx.fillRect(beachX, groundY - 14, viewW + 80, 14);
    ctx.fillStyle = 'rgba(250, 248, 232, 0.65)';
    ctx.fillRect(beachX, groundY - 15, viewW + 80, 2);

    // Palms on the dune line.
    layer(0.36);
    repeat(330, 0.36, (x, i) => {
      const n = hash01(i * 8.9);
      if (n < 0.28) return;
      const px = x + 80 + n * 90;
      const height = 96 + n * 42;
      const top = groundY - height;
      const crownX = px + 16;
      ctx.strokeStyle = 'rgba(70, 92, 74, 0.85)';
      ctx.lineWidth = 7;
      ctx.beginPath();
      ctx.moveTo(px, groundY);
      ctx.lineTo(px + 7, top + height * 0.5);
      ctx.lineTo(crownX, top);
      ctx.stroke();
      ctx.fillStyle = 'rgba(58, 112, 82, 0.85)';
      for (let f = 0; f < 6; f++) {
        const angle = -Math.PI * 0.95 + f * (Math.PI * 0.38);
        const tipX = crownX + Math.cos(angle) * 54;
        const tipY = top + 8 + Math.sin(angle) * 30;
        ctx.beginPath();
        ctx.moveTo(crownX, top);
        ctx.lineTo(tipX, tipY);
        ctx.lineTo(crownX + Math.cos(angle) * 24, top + 10 + Math.sin(angle) * 12);
        ctx.fill();
      }
    });
  }

  fillCircle(ctx, x, y, radius) {
    ctx.beginPath();
    ctx.arc(x, y, Math.max(1, radius), 0, Math.PI * 2);
    ctx.fill();
  }

  /** Interior gaps between ground segments, in course space. */
  coursePits() {
    const pits = [];
    let cursor = null;
    for (const solid of this.course.solids) {
      if (cursor !== null && solid.x > cursor) pits.push({ x: cursor, w: solid.x - cursor });
      cursor = Math.max(cursor ?? 0, solid.x + solid.w);
    }
    return pits;
  }

  /** Pits read as depth: a dark recess, or water on shore courses. */
  drawPits(ctx, frame) {
    const theme = this.theme;
    const base = this.course.solids[0];
    const groundY = this.course.groundY;
    const bottom = groundY + (base ? base.h : 200) + 80;
    const wallTop = groundY + 2;
    const wallHeight = Math.min(bottom - groundY, 150);

    for (const gap of this.coursePits()) {
      if (!spansView(gap, frame)) continue;

      if (theme.water) {
        const surfaceY = groundY + 20;
        ctx.fillStyle = 'rgba(112, 88, 44, 0.92)';
        ctx.fillRect(gap.x, wallTop, gap.w, surfaceY - wallTop);
        const body = ctx.createLinearGradient(0, surfaceY, 0, bottom);
        body.addColorStop(0, theme.water);
        body.addColorStop(1, '#1d5670');
        ctx.fillStyle = body;
        ctx.fillRect(gap.x, surfaceY, gap.w, bottom - surfaceY);
        // shallow band, waterline, ripples
        ctx.fillStyle = 'rgba(255, 255, 255, 0.18)';
        ctx.fillRect(gap.x, surfaceY + 3, gap.w, 9);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
        ctx.fillRect(gap.x, surfaceY, gap.w, 2);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
        for (let px = gap.x + 8; px < gap.x + gap.w - 8; px += 26) {
          const n = hash01(px * 1.9);
          ctx.fillRect(px + n * 6, surfaceY + 14 + n * 10, 10, 2);
        }
      } else {
        const recess = ctx.createLinearGradient(0, groundY, 0, bottom);
        recess.addColorStop(0, 'rgba(58, 50, 40, 0.92)');
        recess.addColorStop(0.55, 'rgba(34, 30, 26, 0.96)');
        recess.addColorStop(1, 'rgba(16, 15, 13, 1)');
        ctx.fillStyle = recess;
        ctx.fillRect(gap.x, wallTop, gap.w, bottom - wallTop);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
        for (let py = groundY + 26; py < groundY + 150; py += 34) {
          ctx.fillRect(gap.x + 6, py, gap.w - 12, 2);
        }
      }

      // Inner wall shadow just below the lip.
      ctx.fillStyle = 'rgba(0, 0, 0, 0.18)';
      ctx.fillRect(gap.x, wallTop, 5, wallHeight);
      ctx.fillRect(gap.x + gap.w - 5, wallTop, 5, wallHeight);
    }
  }

  /**
   * Ground slabs: the collidable segments plus the land running off the finish
   * edge. The off-course slab starts on the last segment so its seams line up
   * and the segment's cut edge is covered, not repeated.
   */
  groundSlabs() {
    const slabs = this.course.solids.map(solid => ({
      x: solid.x,
      y: solid.y,
      w: solid.w,
      h: solid.h,
      outer: false
    }));
    const last = this.course.solids[this.course.solids.length - 1];
    if (last) {
      slabs.push({ x: last.x, y: last.y, w: last.w + 640, h: last.h, outer: true });
    }
    return slabs;
  }

  drawGround(ctx, frame) {
    const theme = this.theme;
    const surfaceName = SURFACE_TYPES.includes(theme.surface) ? theme.surface : 'grass';
    const subsurfaceName = SUBSURFACE_TYPES.includes(theme.subsurface) ? theme.subsurface : 'dirt';
    const surface = SURFACE_STYLES[surfaceName];
    const body = SUBSURFACE_STYLES[subsurfaceName];
    const capH = 16;

    for (const solid of this.groundSlabs()) {
      if (!spansView(solid, frame)) continue;
      const { x, y, w, h, outer } = solid;

      // Subsurface body.
      ctx.fillStyle = body.base;
      ctx.fillRect(x, y + capH - 2, w, h);

      // Tile seams: three body rows, brick-offset vertical joints.
      const rowH = 34;
      for (let row = 0; row < 3; row++) {
        const rowY = y + capH + row * rowH;
        ctx.fillStyle = body.seam;
        ctx.fillRect(x, rowY, w, 1.5);
        if (subsurfaceName === 'sand') continue;
        const offset = (row % 2) * 31;
        for (let sx = x + offset; sx < x + w - 2; sx += 62) {
          ctx.fillRect(sx, rowY, 1.5, rowH);
        }
      }
      if (subsurfaceName === 'sand') {
        // Loose wind ripples instead of masonry joints.
        ctx.fillStyle = 'rgba(255, 246, 214, 0.16)';
        for (let px = x + 14; px < x + w - 14; px += 46) {
          const n = hash01(px * 0.51);
          ctx.fillRect(px + n * 10, y + capH + 14 + n * 42, 18, 2);
        }
      }
      ctx.fillStyle = body.speck;
      for (let px = x + 9; px < x + w - 8; px += 37) {
        const n = hash01(px * 0.37);
        const size = n > 0.62 ? 3 : 2;
        ctx.fillRect(px, y + capH + 10 + n * 76, size, size);
      }

      // Darker cut sides so a pit wall reads as depth. The very first segment
      // has no left cut, and the off-course slab repeats none.
      if (!outer) {
        const firstSolid = this.course.solids[0];
        ctx.fillStyle = body.edge;
        if (!firstSolid || solid.x > firstSolid.x) {
          ctx.fillRect(x, y + capH, 6, h - capH);
        }
        ctx.fillRect(x + w - 6, y + capH, 6, h - capH);
      }

      // Surface cap.
      ctx.fillStyle = surface.cap;
      ctx.fillRect(x, y, w, capH);
      ctx.fillStyle = surface.lip;
      ctx.fillRect(x, y, w, 4);
      ctx.fillStyle = surface.detail;
      ctx.fillRect(x, y + capH - 2, w, 2);
      this.drawSurfaceDetail(ctx, surfaceName, surface, solid, capH);
    }
  }

  drawSurfaceDetail(ctx, surfaceName, surface, solid, capH) {
    const { x, y, w } = solid;

    if (surfaceName === 'grass') {
      for (let px = x + 3; px < x + w - 3; px += 12) {
        const n = hash01(px * 1.37);
        const blade = 3 + n * 6;
        ctx.fillStyle = n > 0.55 ? surface.blade : surface.detail;
        ctx.beginPath();
        ctx.moveTo(px, y + 1);
        ctx.lineTo(px + 2, y - blade);
        ctx.lineTo(px + 4.5, y + 1);
        ctx.fill();
      }
      ctx.fillStyle = surface.detail;
      for (let px = x + 9; px < x + w - 6; px += 29) {
        ctx.fillRect(px, y + capH - 4, 5, 2);
      }
      return;
    }

    if (surfaceName === 'sand') {
      ctx.fillStyle = surface.blade;
      for (let px = x + 6; px < x + w - 12; px += 22) {
        const n = hash01(px * 0.93);
        ctx.fillRect(px + n * 8, y + 6 + n * 3, 9, 2);
        if (n > 0.52) ctx.fillRect(px + 14, y + 10, 5, 2);
      }
      ctx.fillStyle = surface.detail;
      for (let px = x + 14; px < x + w - 8; px += 53) {
        ctx.fillRect(px, y + 2, 3, 3);
      }
      return;
    }

    if (surfaceName === 'stone') {
      ctx.fillStyle = surface.detail;
      for (let px = x + 12; px < x + w - 12; px += 46) {
        ctx.fillRect(px, y, 2, capH);
        const n = hash01(px * 2.1);
        ctx.fillRect(px + 10 + n * 10, y - 2, 7, 2);
      }
      ctx.fillStyle = surface.lip;
      for (let px = x + 22; px < x + w - 10; px += 46) {
        ctx.fillRect(px, y + 3, 12, 2);
      }
      return;
    }

    if (surfaceName === 'boardwalk') {
      for (let px = x; px < x + w - 2; px += 32) {
        ctx.fillStyle = surface.detail;
        ctx.fillRect(px + 30, y, 2, capH);
        ctx.fillStyle = surface.lip;
        ctx.fillRect(px + 2, y + 3, 26, 2);
        ctx.fillStyle = surface.detail;
        ctx.fillRect(px + 5, y + 8, 2, 2);
        ctx.fillRect(px + 23, y + 8, 2, 2);
      }
      return;
    }

    // Loose dirt clods.
    ctx.fillStyle = surface.detail;
    for (let px = x + 8; px < x + w - 8; px += 27) {
      const n = hash01(px * 1.1);
      ctx.fillRect(px + n * 6, y + 4 + n * 4, 5, 3);
    }
  }

  drawPlatforms(ctx, frame) {
    const theme = this.theme;
    const material = PLATFORM_MATERIALS.includes(theme.platformMaterial)
      ? theme.platformMaterial
      : 'wood';
    const style = PLATFORM_STYLES[material];
    for (const platform of this.course.oneWays) {
      if (!spansView(platform, frame)) continue;
      this.drawPlatform(ctx, platform, material, style);
    }
  }

  drawPlatform(ctx, platform, material, style) {
    const { x, y, w, h } = platform;

    // Supports first, so the deck sits on top of them.
    ctx.fillStyle = style.dark;
    if (material === 'boardwalk') {
      ctx.fillRect(x + 4, y + h, 5, 14);
      ctx.fillRect(x + w - 9, y + h, 5, 14);
    } else if (material === 'metal') {
      ctx.fillRect(x + 6, y + h, 3, 8);
      ctx.fillRect(x + w - 9, y + h, 3, 8);
    } else if (material === 'stone') {
      ctx.fillRect(x + 8, y + h, 6, 5);
      ctx.fillRect(x + w - 14, y + h, 6, 5);
    } else {
      ctx.fillRect(x + 5, y + h, 4, 9);
      ctx.fillRect(x + w - 9, y + h, 4, 9);
      ctx.fillRect(x + w / 2 - 2, y + h, 4, 7);
    }

    // Deck.
    ctx.fillStyle = style.base;
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = style.top;
    ctx.fillRect(x, y, w, 4);
    ctx.fillStyle = style.dark;
    ctx.fillRect(x, y + h - 3, w, 3);
    ctx.fillRect(x, y, 5, h);
    ctx.fillRect(x + w - 5, y, 5, h);

    if (material === 'metal') {
      ctx.fillStyle = style.seam;
      for (let px = x + 9; px < x + w - 9; px += 8) {
        ctx.fillRect(px, y + 6, 3, h - 10);
      }
      ctx.fillStyle = style.nail;
      for (let px = x + 6; px < x + w - 6; px += 22) ctx.fillRect(px, y + 1, 3, 2);
    } else if (material === 'stone') {
      ctx.fillStyle = style.seam;
      for (let px = x + 24; px < x + w - 8; px += 34) ctx.fillRect(px, y + 4, 2, h - 6);
      const n = hash01(x * 0.7);
      ctx.fillStyle = style.top;
      ctx.fillRect(x + 6 + n * 10, y - 1, 6, 2);
    } else {
      // Wood and boardwalk planks: joints plus nail heads.
      ctx.fillStyle = style.seam;
      for (let px = x + 12; px < x + w - 8; px += 20) ctx.fillRect(px, y + 4, 1.5, h - 7);
      ctx.fillStyle = style.nail;
      for (let px = x + 16; px < x + w - 10; px += 20) {
        ctx.fillRect(px, y + 6, 2, 2);
        ctx.fillRect(px, y + h - 9, 2, 2);
      }
    }

    // Dashed underside stays: pass-through from below.
    ctx.fillStyle = this.theme.platformDash || style.dark;
    for (let px = x + 5; px < x + w - 9; px += 12) ctx.fillRect(px, y + h - 2, 6, 2);
  }

  /** Set dressing from `theme.props`, painted behind the characters. */
  drawProps(ctx, frame) {
    const theme = this.theme;
    const props = Array.isArray(theme.props) ? theme.props : [];
    const visible = props
      .filter(prop => isObject(prop) && PROP_TYPES.includes(prop.type))
      .filter(prop => Number.isFinite(prop.x) && Number.isFinite(prop.y))
      .filter(prop => spansView({ x: prop.x - 70, w: 140 }, frame))
      .sort((a, b) => a.y - b.y || a.x - b.x);

    for (const prop of visible) {
      const scale = isPositive(prop.scale) ? prop.scale : 1;
      ctx.save();
      ctx.translate(prop.x, prop.y);
      ctx.scale(scale, scale);
      this.drawProp(ctx, prop.type);
      ctx.restore();
    }
  }

  drawProp(ctx, type) {
    ctx.fillStyle = 'rgba(20, 30, 20, 0.18)';
    ctx.beginPath();
    ctx.ellipse(0, 1, 22, 6, 0, 0, Math.PI * 2);
    ctx.fill();

    if (type === 'tree') this.drawTreeProp(ctx);
    else if (type === 'bush') this.drawBushProp(ctx);
    else if (type === 'lamp') this.drawLampProp(ctx);
    else if (type === 'bench') this.drawBenchProp(ctx);
    else if (type === 'flag') this.drawFlagProp(ctx);
    else if (type === 'umbrella') this.drawUmbrellaProp(ctx);
    else if (type === 'palm') this.drawPalmProp(ctx);
    else if (type === 'tank') this.drawTankProp(ctx);
    else if (type === 'vent') this.drawVentProp(ctx);
    else if (type === 'towel') this.drawTowelProp(ctx);
    else if (type === 'shell') this.drawShellProp(ctx);
    else if (type === 'hut') this.drawHutProp(ctx);
    else this.drawSignProp(ctx);
  }

  drawTreeProp(ctx) {
    ctx.fillStyle = '#7a5533';
    ctx.fillRect(-6, -58, 12, 58);
    ctx.fillStyle = '#9a7043';
    ctx.fillRect(-6, -58, 4, 58);
    ctx.fillStyle = '#4f8a4e';
    this.fillCircle(ctx, 0, -78, 30);
    this.fillCircle(ctx, -22, -64, 21);
    this.fillCircle(ctx, 21, -66, 23);
    ctx.fillStyle = '#66a862';
    this.fillCircle(ctx, -8, -88, 18);
    ctx.fillStyle = 'rgba(180, 224, 150, 0.5)';
    this.fillCircle(ctx, -14, -94, 8);
  }

  drawBushProp(ctx) {
    ctx.fillStyle = '#4f8a4e';
    ctx.beginPath();
    ctx.ellipse(-12, -10, 16, 12, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(12, -9, 15, 11, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#66a862';
    ctx.beginPath();
    ctx.ellipse(0, -18, 18, 14, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(190, 228, 160, 0.5)';
    this.fillCircle(ctx, -6, -22, 5);
  }

  drawLampProp(ctx) {
    ctx.fillStyle = '#4d5b52';
    ctx.fillRect(-3, -66, 6, 66);
    ctx.fillRect(-7, -6, 14, 6);
    ctx.fillStyle = '#39443f';
    ctx.fillRect(-8, -80, 16, 12);
    ctx.fillStyle = '#ffe8a8';
    ctx.fillRect(-6, -77, 12, 7);
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = '#ffe6a0';
    this.fillCircle(ctx, 0, -72, 20);
    ctx.globalAlpha = 1;
  }

  drawBenchProp(ctx) {
    ctx.fillStyle = '#6b4a2c';
    ctx.fillRect(-22, -16, 4, 16);
    ctx.fillRect(16, -16, 4, 16);
    ctx.fillStyle = '#a97a49';
    ctx.fillRect(-28, -24, 52, 6);
    ctx.fillStyle = '#c29a63';
    ctx.fillRect(-28, -24, 52, 2);
    ctx.fillStyle = '#96693c';
    ctx.fillRect(-28, -44, 6, 22);
    ctx.fillRect(-28, -40, 40, 4);
    ctx.fillRect(-28, -33, 40, 4);
  }

  drawFlagProp(ctx) {
    ctx.fillStyle = '#8d9a94';
    ctx.fillRect(-1.5, -96, 3, 96);
    ctx.fillStyle = this.theme.finish;
    ctx.beginPath();
    ctx.moveTo(2, -94);
    ctx.lineTo(44, -83);
    ctx.lineTo(2, -70);
    ctx.fill();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.beginPath();
    ctx.moveTo(2, -94);
    ctx.lineTo(44, -83);
    ctx.lineTo(2, -82);
    ctx.fill();
  }

  drawUmbrellaProp(ctx) {
    ctx.fillStyle = '#e8e2d0';
    ctx.fillRect(-1.5, -56, 3, 56);
    ctx.fillStyle = '#f4e6cf';
    ctx.beginPath();
    ctx.ellipse(0, -56, 34, 22, 0, Math.PI, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#e8735f';
    ctx.beginPath();
    ctx.ellipse(0, -56, 24, 16, 0, Math.PI, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#f4e6cf';
    ctx.beginPath();
    ctx.ellipse(0, -56, 13, 9, 0, Math.PI, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#c9c2a8';
    ctx.fillRect(-3, -58, 6, 3);
  }

  drawPalmProp(ctx) {
    // Segmented trunk leaning gently to the right.
    for (let i = 0; i < 5; i++) {
      ctx.fillStyle = i % 2 === 0 ? '#a4814d' : '#8a6a3e';
      ctx.fillRect(-5 + i * 1.6, -12 * (i + 1), 10, 12);
    }
    // Filled, drooping fronds.
    const crownY = -60;
    const tips = [[-40, -2], [-30, -20], [-10, -30], [12, -28], [30, -16], [44, 0]];
    for (const [tipX, tipY] of tips) {
      ctx.fillStyle = '#3f7d4a';
      ctx.beginPath();
      ctx.moveTo(3, crownY);
      ctx.lineTo(tipX, crownY + tipY);
      ctx.lineTo(tipX * 0.42, crownY + tipY * 0.45 + 7);
      ctx.fill();
    }
    ctx.fillStyle = '#6b4a2a';
    this.fillCircle(ctx, -4, -58, 3);
    this.fillCircle(ctx, 5, -57, 3);
  }

  drawSignProp(ctx) {
    ctx.fillStyle = '#7a5733';
    ctx.fillRect(-19, -38, 4, 38);
    ctx.fillRect(15, -38, 4, 38);
    ctx.fillStyle = '#c9a06a';
    ctx.fillRect(-27, -66, 54, 30);
    ctx.strokeStyle = '#7a5733';
    ctx.lineWidth = 2;
    ctx.strokeRect(-27, -66, 54, 30);
    ctx.fillStyle = '#6b4e2e';
    ctx.fillRect(-20, -59, 40, 3);
    ctx.fillRect(-20, -51, 32, 3);
    ctx.fillRect(-20, -43, 36, 3);
  }

  /** Rooftop water tank: a banded barrel on a steel frame. */
  drawTankProp(ctx) {
    ctx.fillStyle = '#3c444d';
    ctx.fillRect(-16, -20, 4, 20);
    ctx.fillRect(12, -20, 4, 20);
    ctx.fillRect(-16, -12, 32, 3);
    ctx.fillRect(-16, -4, 32, 3);

    ctx.fillStyle = '#8d6a44';
    ctx.fillRect(-22, -62, 44, 42);
    ctx.fillStyle = '#a9835a';
    ctx.fillRect(-22, -62, 12, 42);
    ctx.fillStyle = '#6d5133';
    ctx.fillRect(-22, -62, 44, 5);
    ctx.fillRect(-22, -48, 44, 3);
    ctx.fillRect(-22, -33, 44, 3);
    ctx.fillRect(-22, -25, 44, 5);

    ctx.fillStyle = '#4a3a29';
    ctx.beginPath();
    ctx.moveTo(-24, -62);
    ctx.lineTo(0, -74);
    ctx.lineTo(24, -62);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(255, 244, 214, 0.28)';
    ctx.fillRect(-18, -58, 4, 30);
  }

  /** Flat roof vent: a squat housing with a capped stack. */
  drawVentProp(ctx) {
    ctx.fillStyle = '#454e58';
    ctx.fillRect(-18, -18, 36, 18);
    ctx.fillStyle = '#737d89';
    ctx.fillRect(-18, -18, 36, 4);
    ctx.fillStyle = '#2f363d';
    for (let i = 0; i < 3; i++) ctx.fillRect(-13 + i * 10, -13, 6, 10);
    ctx.fillStyle = '#59636e';
    ctx.fillRect(-7, -42, 14, 26);
    ctx.fillStyle = '#8b959f';
    ctx.fillRect(-10, -48, 20, 7);
    ctx.fillStyle = '#2f363d';
    ctx.fillRect(-10, -42, 20, 3);
  }

  /** Beach towel: a striped rectangle lying flat on the sand. */
  drawTowelProp(ctx) {
    ctx.fillStyle = '#f2e7cd';
    ctx.beginPath();
    ctx.moveTo(-26, -4);
    ctx.lineTo(22, -8);
    ctx.lineTo(27, -1);
    ctx.lineTo(-22, 3);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#e8735f';
    ctx.beginPath();
    ctx.moveTo(-18, -4);
    ctx.lineTo(-8, -5);
    ctx.lineTo(-5, 2);
    ctx.lineTo(-15, 3);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#63b8c9';
    ctx.beginPath();
    ctx.moveTo(2, -6);
    ctx.lineTo(12, -7);
    ctx.lineTo(15, 0);
    ctx.lineTo(5, 1);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(120, 90, 50, 0.18)';
    ctx.fillRect(-24, 2, 46, 2);
  }

  /** A shell or two half-buried in the sand. */
  drawShellProp(ctx) {
    ctx.fillStyle = '#f6e7d5';
    ctx.beginPath();
    ctx.ellipse(-4, -5, 12, 8, 0, Math.PI, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#e0c3a8';
    ctx.fillRect(-14, -5, 20, 3);
    ctx.strokeStyle = '#d9b79a';
    ctx.lineWidth = 1.4;
    for (const dx of [-9, -5, -1, 3]) {
      ctx.beginPath();
      ctx.moveTo(dx, -5);
      ctx.lineTo(dx + 2, -11);
      ctx.stroke();
    }
    ctx.fillStyle = '#f4cdb4';
    ctx.beginPath();
    ctx.ellipse(15, -3, 7, 5, 0, Math.PI, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#dcb69a';
    ctx.fillRect(8, -3, 14, 2);
  }

  /** Lifeguard hut: stilts, an open deck, a railing, and a sloped roof. */
  drawHutProp(ctx) {
    // Stilts and cross-brace.
    ctx.fillStyle = '#8d6a44';
    ctx.fillRect(-38, -46, 7, 46);
    ctx.fillRect(31, -46, 7, 46);
    ctx.fillRect(-38, -26, 76, 4);
    ctx.fillStyle = '#6d5133';
    ctx.fillRect(-31, -18, 4, 18);
    ctx.fillRect(27, -18, 4, 18);

    // Cabin.
    ctx.fillStyle = '#e9dcc0';
    ctx.fillRect(-34, -104, 68, 58);
    ctx.fillStyle = '#d6c5a4';
    ctx.fillRect(-34, -104, 12, 58);
    ctx.fillStyle = '#4e7285';
    ctx.fillRect(-16, -94, 32, 22);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.fillRect(-13, -91, 10, 6);
    ctx.fillStyle = '#b9564a';
    ctx.fillRect(-10, -60, 20, 14);
    ctx.fillStyle = '#f2e7cd';
    ctx.fillRect(-3, -57, 6, 8);

    // Deck and railing.
    ctx.fillStyle = '#b98a56';
    ctx.fillRect(-42, -46, 84, 8);
    ctx.fillStyle = '#8d6a3e';
    ctx.fillRect(-42, -40, 84, 3);
    ctx.fillStyle = '#f2e7cd';
    for (let i = -38; i <= 34; i += 12) ctx.fillRect(i, -58, 3, 12);
    ctx.fillRect(-42, -60, 84, 3);

    // Roof with a small flag.
    ctx.fillStyle = '#b9564a';
    ctx.beginPath();
    ctx.moveTo(-44, -104);
    ctx.lineTo(0, -132);
    ctx.lineTo(44, -104);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#d4705f';
    ctx.fillRect(-44, -108, 88, 5);
    ctx.fillStyle = '#f2e7cd';
    ctx.fillRect(-1, -146, 2, 16);
    ctx.fillStyle = '#f4d06f';
    ctx.beginPath();
    ctx.moveTo(1, -146);
    ctx.lineTo(19, -140);
    ctx.lineTo(1, -134);
    ctx.fill();
  }

  /** Start line: two posts, a crossbar, a cloth banner, and bunting. */
  drawStartGate(ctx) {
    const theme = this.theme;
    const x = this.course.startX;
    const base = this.course.groundY;
    const top = base - 136;

    ctx.fillStyle = '#6c4a2f';
    ctx.fillRect(x - 58, top, 6, 136);
    ctx.fillRect(x + 52, top, 6, 136);
    ctx.fillStyle = '#8b6440';
    ctx.fillRect(x - 58, top, 2, 136);
    ctx.fillRect(x + 52, top, 2, 136);

    ctx.fillStyle = '#6c4a2f';
    ctx.fillRect(x - 62, top - 7, 122, 8);

    ctx.fillStyle = theme.finish;
    ctx.fillRect(x - 52, top + 1, 104, 26);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.fillRect(x - 52, top + 8, 104, 3);
    ctx.fillStyle = 'rgba(24, 36, 26, 0.22)';
    ctx.fillRect(x - 52, top + 25, 104, 2);

    const bunting = [theme.finish, '#f5f2e6', theme.finishFaint || theme.finish];
    for (let i = 0; i < 5; i++) {
      const px = x - 44 + i * 22;
      ctx.fillStyle = bunting[i % bunting.length];
      ctx.beginPath();
      ctx.moveTo(px, top + 30);
      ctx.lineTo(px + 16, top + 30);
      ctx.lineTo(px + 8, top + 44);
      ctx.fill();
    }

    ctx.fillStyle = '#4d3520';
    ctx.fillRect(x - 61, base - 5, 12, 5);
    ctx.fillRect(x + 49, base - 5, 12, 5);
  }

  /** Finish line: two posts and a chequered banner, plus a ground stripe. */
  drawFinishGate(ctx) {
    const theme = this.theme;
    const x = this.course.finishX;
    const base = this.course.groundY;
    const top = base - 172;

    // Posts.
    ctx.fillStyle = '#584437';
    ctx.fillRect(x - 58, top, 9, 172);
    ctx.fillRect(x + 49, top, 9, 172);
    ctx.fillStyle = '#7b6152';
    ctx.fillRect(x - 58, top, 2, 172);
    ctx.fillRect(x + 49, top, 2, 172);

    // Crossbar.
    ctx.fillStyle = '#4a3a2c';
    ctx.fillRect(x - 62, top - 9, 124, 10);

    // Chequered cloth.
    const bannerX = x - 48;
    const bannerY = top + 8;
    const cell = 12;
    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < 8; col++) {
        ctx.fillStyle = (row + col) % 2 === 0 ? '#f5f2e6' : theme.finish;
        ctx.fillRect(bannerX + col * cell, bannerY + row * cell, cell, cell);
      }
    }
    ctx.fillStyle = 'rgba(40, 30, 22, 0.24)';
    ctx.fillRect(bannerX, bannerY + cell * 2, cell * 8, 2);

    // Corner flags.
    ctx.fillStyle = theme.finish;
    for (const px of [x - 64, x + 54]) {
      ctx.fillRect(px, top - 26, 2, 26);
      ctx.beginPath();
      ctx.moveTo(px + 2, top - 26);
      ctx.lineTo(px + 20, top - 20);
      ctx.lineTo(px + 2, top - 12);
      ctx.fill();
    }

    // Ground stripe underfoot.
    for (let i = 0; i < 6; i++) {
      ctx.fillStyle = i % 2 === 0 ? '#f5f2e6' : theme.finish;
      ctx.fillRect(x - 18 + i * 6, base - 6, 6, 6);
    }
  }

  /** Semi-transparent billboard of the seated competitor, on the authored line. */
  drawGhost(ctx) {
    const x = ghostXAt(this.run.elapsed, this.definition);
    const footY = ghostYAt(this.ghostSample, x, this.course);
    const w = this.definition.visual.ghostWidth;
    const h = this.definition.visual.ghostHeight;
    const image = this.avatarFor(this.ghostCharacter);
    if (image) {
      drawAvatar(ctx, image, x - w / 2, footY - h, w, h, true, this.definition.visual.ghostAlpha);
    } else {
      ctx.save();
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 5]);
      ctx.strokeStyle = this.theme.ghost;
      ctx.strokeRect(
        x - this.physics.playerWidth / 2,
        footY - this.physics.playerHeight,
        this.physics.playerWidth,
        this.physics.playerHeight
      );
      ctx.restore();
    }
  }

  drawPlayer(ctx) {
    const player = this.run.player;
    const footY = player.y + player.h;
    const visual = this.definition.visual;
    const w = visual.playerWidth;
    const h = visual.playerHeight;
    const image = this.avatarFor(this.playerCharacter);
    if (image) {
      drawAvatar(ctx, image, player.x + player.w / 2 - w / 2, footY - h, w, h, player.facing > 0, 1);
      return;
    }
    ctx.fillStyle = this.theme.player;
    ctx.fillRect(player.x, player.y, player.w, player.h);
    ctx.fillStyle = this.theme.eye;
    const eyeX = player.facing >= 0 ? player.x + player.w - 7 : player.x + 3;
    ctx.fillRect(eyeX, player.y + 8, 4, 5);
    ctx.fillRect(eyeX, player.y + 17, 4, 3);
    ctx.strokeStyle = this.theme.playerEdge;
    ctx.lineWidth = 1;
    ctx.strokeRect(player.x + 0.5, player.y + 0.5, player.w - 1, player.h - 1);
  }

  avatarFor(character) {
    const recipe = character?.recipe;
    if (!recipe) return null;
    const image = getAvatarImage(recipe);
    if (image) return image;
    // Lazy local render; no network, same cache the Park uses.
    loadAvatarImage(recipe).catch(() => {});
    return getAvatarImage(recipe);
  }

  close({ reason = 'closed' } = {}) {
    this.input = { left: false, right: false, jumpQueued: false, jumpCut: false };
    this.phase = PHASES.CLOSING;
    return super.close({ reason });
  }

  serialize() {
    return {
      ...super.serialize(),
      gameId: this.definition.id,
      elapsed: Number(this.run.elapsed.toFixed(2)),
      finished: this.run.finished,
      finishTime: this.run.finishTime === null ? null : Number(this.run.finishTime.toFixed(2)),
      jumps: this.run.jumps,
      falls: this.run.falls
    };
  }

  _drain() {
    const events = this._events;
    this._events = [];
    return events;
  }
}

/** Factory for the host registry. */
export function createActivity(context = {}) {
  return new CourseActivity(context);
}

// Back-compat aliases for the original single-course module.
export const JungleGymActivity = CourseActivity;
export const createJungleGym = createActivity;
