/**
 * Jungle Gym — the Park's side-scrolling run-and-jump activity.
 *
 * Contract-native activity: fixed 120 Hz physics, one authored course, a
 * finish line, and a scripted time-based competitor ("the ghost") drawn as a
 * semi-transparent DiceBear billboard. Rules and state only; the host owns
 * settlement, stats, rewards, and dialogue.
 *
 * Physics and course live in data/activities.json. Constants and the ghost line
 * are the Wave 3 spike's approved set, moved into data and covered by tests.
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

const COLORS = Object.freeze({
  skyTop: '#0b110d',
  skyBottom: '#16241a',
  far: 'rgba(163, 210, 139, 0.055)',
  ground: '#1d3324',
  groundEdge: '#4f7a52',
  platform: '#24402c',
  platformEdge: '#7fae6f',
  finish: '#b6e37c',
  ghost: 'rgba(213, 243, 163, 0.55)',
  player: '#d5f3a3',
  playerEdge: '#101a0f',
  eye: '#1b2b18'
});

/** Resolve one activity definition, or null when the id is unknown. */
export function activityDefinition(id, data = ACTIVITIES) {
  return (data && data[id]) || null;
}

export function isActivityEnabled(id, data = ACTIVITIES) {
  return Boolean(activityDefinition(id, data)?.enabled);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function overlaps(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
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
    h: 16,
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
 * The activity itself. Host contract entry points: open/ready/update/
 * handleInput/close, plus describeStatus and the full-view render pass.
 */
export class JungleGymActivity extends MiniGameBase {
  constructor({ host = null, meta = null, game = null, options = {} } = {}) {
    super(meta || {});
    this.host = host;
    this.game = game || options?.game || host?.game || null;
    this.options = options || {};
    this.definition = activityDefinition(meta?.activityId || meta?.id || 'jungle-gym');
    this.physics = this.definition.physics;
    this.course = buildCourse(this.definition);
    this.ghostSample = buildGhostPath(this.definition);
    this.par = parTimeFor(this.course, this.physics);
    this.visual = this.definition.visual;
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
    if (this.phase === PHASES.IDLE) return { ok: false, phase: this.phase, message: 'the jungle gym is not open' };
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

  /** Read-only snapshot the shell renders in its activity HUD. */
  getHud() {
    const time = this.run.finished ? this.run.finishTime : this.run.elapsed;
    return {
      id: this.meta?.id || 'jungle-gym',
      title: this.meta?.title || this.definition.title,
      time: Number((time || 0).toFixed(2)),
      par: Number(this.par.toFixed(2)),
      delta: Number(((time || 0) - this.par).toFixed(2)),
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
   */
  renderView(ctx, view = {}) {
    const width = Number(view.width) || 0;
    const height = Number(view.height) || 0;
    if (!width || !height) return false;
    const dpr = Number(view.dpr) || 1;
    const { physics, course, visual } = this;

    const scale = Math.min(height / physics.viewHeight, width / physics.minViewWidth);
    const viewW = width / scale;
    const viewH = height / scale;
    this.viewWidth = viewW;

    const camX = this.camera.x;
    const camY = course.groundY - viewH * 0.78;

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const sky = ctx.createLinearGradient(0, 0, 0, height);
    sky.addColorStop(0, COLORS.skyTop);
    sky.addColorStop(1, COLORS.skyBottom);
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, width, height);

    // Faint parallax band so speed reads without any art.
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * -camX * 0.42 * scale, dpr * -camY * scale);
    ctx.fillStyle = COLORS.far;
    for (let i = 0; i < 40; i++) {
      const blockX = i * 320;
      const blockHeight = 100 + ((i * 53) % 7) * 26;
      ctx.fillRect(blockX, course.groundY - 34 - blockHeight, 44, blockHeight);
    }

    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * -camX * scale, dpr * -camY * scale);

    this.drawFinish(ctx);
    this.drawGround(ctx);
    this.drawPlatforms(ctx);
    this.drawGhost(ctx);
    this.drawPlayer(ctx);

    ctx.restore();
    return true;
  }

  drawGround(ctx) {
    for (const solid of this.course.solids) {
      ctx.fillStyle = COLORS.ground;
      ctx.fillRect(solid.x, solid.y, solid.w, solid.h);
      ctx.fillStyle = COLORS.groundEdge;
      ctx.fillRect(solid.x, solid.y, solid.w, 4);
    }
  }

  drawPlatforms(ctx) {
    for (const platform of this.course.oneWays) {
      ctx.fillStyle = COLORS.platform;
      ctx.fillRect(platform.x, platform.y, platform.w, platform.h);
      ctx.fillStyle = COLORS.platformEdge;
      ctx.fillRect(platform.x, platform.y, platform.w, 3);
      // Dashed underside reads as pass-through from below.
      ctx.fillStyle = 'rgba(127, 174, 111, 0.35)';
      for (let x = platform.x + 4; x < platform.x + platform.w - 4; x += 12) {
        ctx.fillRect(x, platform.y + platform.h - 3, 6, 2);
      }
    }
  }

  drawFinish(ctx) {
    const x = this.course.finishX;
    const top = this.course.groundY - 200;
    for (let i = 0; i < 10; i++) {
      ctx.fillStyle = i % 2 === 0 ? COLORS.finish : 'rgba(182, 227, 124, 0.18)';
      ctx.fillRect(x - 4, top + i * 20, 8, 20);
    }
    ctx.fillStyle = 'rgba(182, 227, 124, 0.9)';
    ctx.fillRect(x - 26, this.course.groundY - 6, 52, 6);
    ctx.fillRect(x - 2, this.course.groundY - 26, 4, 26);
  }

  /** Semi-transparent billboard of the seated competitor, on the authored line. */
  drawGhost(ctx) {
    const x = ghostXAt(this.run.elapsed, this.definition);
    const footY = ghostYAt(this.ghostSample, x, this.course);
    const w = this.visual.ghostWidth;
    const h = this.visual.ghostHeight;
    const image = this.avatarFor(this.ghostCharacter);
    if (image) {
      drawAvatar(ctx, image, x - w / 2, footY - h, w, h, true, this.visual.ghostAlpha);
    } else {
      ctx.save();
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 5]);
      ctx.strokeStyle = COLORS.ghost;
      ctx.strokeRect(x - this.physics.playerWidth / 2, footY - this.physics.playerHeight, this.physics.playerWidth, this.physics.playerHeight);
      ctx.restore();
    }
  }

  drawPlayer(ctx) {
    const player = this.run.player;
    const footY = player.y + player.h;
    const w = this.visual.playerWidth;
    const h = this.visual.playerHeight;
    const image = this.avatarFor(this.playerCharacter);
    if (image) {
      drawAvatar(ctx, image, player.x + player.w / 2 - w / 2, footY - h, w, h, player.facing > 0, 1);
      return;
    }
    ctx.fillStyle = COLORS.player;
    ctx.fillRect(player.x, player.y, player.w, player.h);
    ctx.fillStyle = COLORS.eye;
    const eyeX = player.facing >= 0 ? player.x + player.w - 7 : player.x + 3;
    ctx.fillRect(eyeX, player.y + 8, 4, 5);
    ctx.fillRect(eyeX, player.y + 17, 4, 3);
    ctx.strokeStyle = COLORS.playerEdge;
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
      gameId: this.meta?.id || 'jungle-gym',
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
export function createJungleGym(context = {}) {
  return new JungleGymActivity(context);
}
