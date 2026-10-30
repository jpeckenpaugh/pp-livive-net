import {
  WORLD_SIZE,
  DIRS,
  isWalkable,
  typeAt,
  findOpenTile,
  findPath
} from './world.js';
import { occupantAtTile, reservationAtTile, canCollide } from './characters.js';
import { directionForStep, DOWN, LEFT, RIGHT } from './facing.js';
import {
  WorldRenderer,
  TILE,
  CHARACTER_HEIGHT,
  COMPANION_HEIGHT,
  characterEffectOwner,
  characterVisualHeight
} from './renderer.js';
import { resolveFx } from './effects.js';
import engineConfig from '../data/engine_config.json' with { type: 'json' };

export {
  TILE,
  CHARACTER_HEIGHT,
  COMPANION_HEIGHT,
  characterVisualHeight
} from './renderer.js';

export const PLAYER_STEP = engineConfig.timings.playerStep;
export const NPC_STEP = engineConfig.timings.npcStep;
export const COMPANION_STEP = engineConfig.timings.companionStep;

const MOVE_KEYS = new Map([
  ['w', { dx: 0, dy: -1, dir: 2 }],
  ['arrowup', { dx: 0, dy: -1, dir: 2 }],
  ['s', { dx: 0, dy: 1, dir: 0 }],
  ['arrowdown', { dx: 0, dy: 1, dir: 0 }],
  ['a', { dx: -1, dy: 0, dir: 3 }],
  ['arrowleft', { dx: -1, dy: 0, dir: 3 }],
  ['d', { dx: 1, dy: 0, dir: 1 }],
  ['arrowright', { dx: 1, dy: 0, dir: 1 }]
]);

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// Companion roster caps live in data/engine_config.json. Read the block
// defensively so an older config (or a partially rolled-out one) still runs;
// the fallbacks mirror the locked Phase 2 defaults.
const COMPANION_CAP_FALLBACKS = Object.freeze({
  playerActiveMax: 3,
  npcActiveMax: 2,
  npcReserveMax: 6,
  globalActiveMax: 80
});

function capValue(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

export const COMPANION_CAPS = Object.freeze({
  playerActiveMax: capValue(
    engineConfig.companions?.playerActiveMax,
    COMPANION_CAP_FALLBACKS.playerActiveMax
  ),
  npcActiveMax: capValue(
    engineConfig.companions?.npcActiveMax,
    COMPANION_CAP_FALLBACKS.npcActiveMax
  ),
  npcReserveMax: capValue(
    engineConfig.companions?.npcReserveMax,
    COMPANION_CAP_FALLBACKS.npcReserveMax
  ),
  globalActiveMax: capValue(
    engineConfig.companions?.globalActiveMax,
    COMPANION_CAP_FALLBACKS.globalActiveMax
  )
});

export function isPlayerOwner(owner) {
  return Boolean(owner && (owner.isPlayer === true || owner.id === 'player'));
}

/** Active follower cap for any owner: the player or an NPC. */
export function activeCompanionCap(owner) {
  return isPlayerOwner(owner)
    ? COMPANION_CAPS.playerActiveMax
    : COMPANION_CAPS.npcActiveMax;
}

/** Reserve collection for an owner; never mutates and always returns an array. */
export function getReserveCompanions(owner) {
  return Array.isArray(owner?.stabledCompanions) ? owner.stabledCompanions : [];
}

/** Count active companions in a flat companion list that follow `ownerId`. */
export function countActiveCompanions(companions, ownerId) {
  if (!Array.isArray(companions) || !ownerId) return 0;
  return companions.filter(comp => comp && comp.buddyId === ownerId).length;
}

/**
 * Roster summary for an owner. Pass the flat `game.companions` list as the
 * second argument (the Game method does this automatically); when omitted,
 * `owner.activeCompanions` is used if an owner keeps a derived list.
 */
export function companionCounts(owner, companions = null) {
  const active = Array.isArray(companions)
    ? countActiveCompanions(companions, owner?.id)
    : (Array.isArray(owner?.activeCompanions) ? owner.activeCompanions.length : 0);
  return {
    active,
    reserve: getReserveCompanions(owner).length,
    cap: activeCompanionCap(owner)
  };
}

/**
 * Create an active companion for any owner via the existing `makeCompanion`
 * factory and append it to `game.companions`. Does not enforce caps; reward
 * and roster policy decide whether a new buddy is active or reserve.
 */
export function addActiveCompanion(game, owner, companionData = {}) {
  if (!game || !owner || typeof game.makeCompanion !== 'function') return null;
  const companion = game.makeCompanion(companionData || {}, owner);
  if (!Array.isArray(game.companions)) game.companions = [];
  game.companions.push(companion);
  return companion;
}

/**
 * Add an unrendered reserve companion to `owner.stabledCompanions`, filling in
 * the ownership defaults. Recruitment stays policy-free: callers decide whether
 * to reserve or activate a companion.
 */
export function reserveCompanion(owner, companionData = {}) {
  if (!owner) return null;
  if (!Array.isArray(owner.stabledCompanions)) owner.stabledCompanions = [];
  const source = companionData && typeof companionData === 'object' ? companionData : {};
  const reserved = {
    ...source,
    id: source.id || `comp-${Math.random().toString(36).slice(2, 9)}`,
    name: source.name || 'Buddy',
    buddyId: owner.id || source.buddyId || 'player',
    inventory: Array.isArray(source.inventory) ? source.inventory : [],
    equipped: Array.isArray(source.equipped) ? source.equipped : [],
    coins: Number.isFinite(source.coins) ? source.coins : 0,
    stabledCompanions: Array.isArray(source.stabledCompanions) ? source.stabledCompanions : []
  };
  owner.stabledCompanions.push(reserved);
  return reserved;
}

/**
 * Move a reserve companion back into the active roster when the owner is under
 * its active cap. Returns `{ ok, companion, reason }`; failures leave the
 * reserve collection untouched.
 */
export function activateReserveCompanion(game, owner, id) {
  const reserve = getReserveCompanions(owner);
  const index = typeof id === 'string' && id
    ? reserve.findIndex(comp => comp && comp.id === id)
    : -1;
  if (index < 0) return { ok: false, companion: null, reason: 'not-found' };
  if (!game || typeof game.makeCompanion !== 'function') {
    return { ok: false, companion: null, reason: 'unavailable' };
  }
  if (companionCounts(owner, game.companions).active >= activeCompanionCap(owner)) {
    return { ok: false, companion: null, reason: 'at-cap' };
  }
  if ((game.companions || []).length >= COMPANION_CAPS.globalActiveMax) {
    return { ok: false, companion: null, reason: 'global-cap' };
  }

  const [data] = reserve.splice(index, 1);
  const companion = addActiveCompanion(game, owner, data);
  return { ok: true, companion, reason: null };
}

/**
 * Clamp an animation-frame delta to a safe, non-negative simulation step.
 * The first rAF timestamp can precede the performance.now() captured in
 * start(), which previously produced a negative dt and tripped strict
 * runtime guards.
 */
export function frameDelta(now, last, max = 0.05) {
  const seconds = (Number(now) - Number(last)) / 1000;
  if (!Number.isFinite(seconds)) return 0;
  return Math.max(0, Math.min(seconds, max));
}

export class Game {
  constructor({ canvas, minimap, onSelect, onToast, onDialogue, onActionKey, isMenuOpen } = {}) {
    this.canvas = canvas;
    this.renderer = new WorldRenderer({ canvas, minimap });
    this.onSelect = onSelect || (() => {});
    this.onToast = onToast || (() => {});
    this.onDialogue = onDialogue || (() => {});
    this.onActionKey = onActionKey || (() => {});
    this.isMenuOpen = isMenuOpen || (() => false);

    this.terrain = null;
    this.worldSeed = null;
    this.scenery = [];
    this.forage = null;
    this.player = null;
    this.npcs = [];
    this.companions = [];
    this.miniGames = [];
    this.miniGameHost = null;
    this.behaviorRuntime = null;
    this.speechBubbles = null;
    this.wander = true;
    this.previewFocus = { x: WORLD_SIZE / 2, y: WORLD_SIZE / 2 };
    this.camera = { x: 0, y: 0 };
    this.cameraSnap = true;
    this.time = 0;
    this.last = 0;
    this.running = false;
    this.interactive = false;
    this.hovered = null;
    this.selected = null;
    this.dialogueNpc = null;
    this.paused = false;
    this.destination = null;
    this.pointer = { x: -1, y: -1 };
    this.heldKeys = [];
    this.width = 0;
    this.height = 0;
    this.dpr = 1;

    this.frame = this.frame.bind(this);
    this.resize = this.resize.bind(this);
    this.handleKeyDown = this.handleKeyDown.bind(this);
    this.handleKeyUp = this.handleKeyUp.bind(this);
    this.handlePointerDown = this.handlePointerDown.bind(this);
    this.handlePointerMove = this.handlePointerMove.bind(this);
    this.handlePointerLeave = this.handlePointerLeave.bind(this);
    this.handleBlur = this.handleBlur.bind(this);
  }

  registerMiniGame(miniGame) {
    this.miniGames.push(miniGame);
  }

  setMiniGameHost(host) {
    this.miniGameHost = host || null;
    return this;
  }

  setBehaviorRuntime(runtime) {
    this.behaviorRuntime = runtime || null;
    return this;
  }

  setSpeechBubbles(bubbles) {
    this.speechBubbles = bubbles || null;
    return this;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.resize();
    window.addEventListener('resize', this.resize);
    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
    window.addEventListener('blur', this.handleBlur);
    this.canvas.addEventListener('pointerdown', this.handlePointerDown);
    this.canvas.addEventListener('pointermove', this.handlePointerMove);
    this.canvas.addEventListener('pointerleave', this.handlePointerLeave);
    this.last = performance.now();
    requestAnimationFrame(this.frame);
  }

  resize() {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.renderer.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.cameraSnap = true;
  }

  makeCharacter(input, isPlayer = false) {
    const x = clamp(Math.round(Number(input.x) || 0), 0, WORLD_SIZE - 1);
    const y = clamp(Math.round(Number(input.y) || 0), 0, WORLD_SIZE - 1);
    return {
      id: input.id ?? (isPlayer ? 'player' : `npc-${Math.random().toString(36).slice(2, 9)}`),
      name: input.name || 'Wanderer',
      recipe: input.recipe,
      vibe: input.vibe || '',
      inventory: Array.isArray(input.inventory) ? input.inventory : [],
      equipped: Array.isArray(input.equipped) ? input.equipped : [],
      coins: Number.isFinite(input.coins) ? input.coins : 0,
      stabledCompanions: Array.isArray(input.stabledCompanions) ? input.stabledCompanions : [],
      isPlayer,
      x,
      y,
      fromX: x,
      fromY: y,
      toX: x,
      toY: y,
      moving: false,
      elapsed: 0,
      duration: isPlayer ? PLAYER_STEP : NPC_STEP,
      direction: Number(input.direction) || 0,
      wait: 0.3 + Math.random() * 1.2,
      path: []
    };
  }

  makeCompanion(input, buddy) {
    const defaultX = buddy?.x ?? 0;
    const defaultY = buddy?.y ?? 0;
    const rawX = Number.isFinite(Number(input.x)) ? Number(input.x) : defaultX;
    const rawY = Number.isFinite(Number(input.y)) ? Number(input.y) : defaultY;
    const x = clamp(Math.round(rawX), 0, WORLD_SIZE - 1);
    const y = clamp(Math.round(rawY), 0, WORLD_SIZE - 1);
    const direction = Number(input.direction) || 0;
    return {
      id: input.id || `comp-${Math.random().toString(36).slice(2, 9)}`,
      name: input.name || 'Buddy',
      buddyId: buddy.id,
      recipe: input.recipe,
      inventory: Array.isArray(input.inventory) ? input.inventory : [],
      equipped: Array.isArray(input.equipped) ? input.equipped : [],
      isCompanion: true,
      x,
      y,
      fromX: x,
      fromY: y,
      toX: x,
      toY: y,
      moving: false,
      elapsed: 0,
      duration: COMPANION_STEP,
      direction,
      fetchTarget: null,
      carryingBall: false,
      cheerTimer: 0,
      cheerElapsed: 0,
      cheerPhase: Math.random() * Math.PI * 2,
      cheerRate: 9 + Math.random() * 6,
      cheerHeight: 0.36 + Math.random() * 0.12,
      cheerTurnTimer: 0,
      cheerReturnDirection: direction,
      path: []
    };
  }

  triggerCheer(buddyId, duration = 1.4) {
    const comps = this.getCompanionsFor(buddyId);
    for (const comp of comps) {
      // Randomise the hop phase, cadence, and length so buddies never bounce in unison.
      comp.cheerTimer = duration * (0.85 + Math.random() * 0.3);
      comp.cheerElapsed = 0;
      comp.cheerPhase = Math.random() * Math.PI * 2;
      comp.cheerRate = 9 + Math.random() * 6;
      comp.cheerHeight = 0.36 + Math.random() * 0.12;
      comp.cheerTurnTimer = 0.12 + Math.random() * 0.22;
      if (!comp.moving) comp.cheerReturnDirection = comp.direction;
    }
  }

  getCompanionFor(buddyId) {
    return this.companions.find(comp => comp.buddyId === buddyId) || null;
  }

  getCompanionsFor(buddyId) {
    return this.companions.filter(comp => comp.buddyId === buddyId);
  }

  // Companion roster helpers. The pure functions above are the shared
  // implementation; these methods bind the current game's companion list.
  getReserveCompanions(owner) {
    return getReserveCompanions(owner);
  }

  activeCompanionCap(owner) {
    return activeCompanionCap(owner);
  }

  companionCounts(owner) {
    return companionCounts(owner, this.companions);
  }

  addActiveCompanion(owner, companionData) {
    return addActiveCompanion(this, owner, companionData);
  }

  reserveCompanion(owner, companionData) {
    return reserveCompanion(owner, companionData);
  }

  activateReserveCompanion(owner, id) {
    return activateReserveCompanion(this, owner, id);
  }

  globalCompanionCount() {
    return Array.isArray(this.companions) ? this.companions.length : 0;
  }

  setWorld({ terrain, worldSeed, player, npcs, companions = [], scenery = [], forage = null, wander = true }) {
    this.terrain = terrain;
    this.worldSeed = worldSeed;
    this.scenery = scenery;
    this.forage = forage;
    this.player = player ? this.makeCharacter(player, true) : null;
    this.npcs = (npcs || []).map(npc => this.makeCharacter(npc, false));

    // Initialize companions
    this.companions = [];
    const allBuddies = this.player ? [this.player, ...this.npcs] : [...this.npcs];
    for (const comp of companions) {
      const buddy = allBuddies.find(b => b.id === comp.buddyId);
      if (buddy) this.companions.push(this.makeCompanion(comp, buddy));
    }

    this.wander = wander;
    this.selected = null;
    this.hovered = null;
    this.dialogueNpc = null;
    this.paused = false;
    this.destination = null;
    this.heldKeys = [];
    this.previewFocus = this.player
      ? { x: this.player.x, y: this.player.y }
      : { x: WORLD_SIZE / 2, y: WORLD_SIZE / 2 };
    this.renderer.buildMinimapBase(terrain);
    this.cameraSnap = true;
  }

  setPreview(terrain, worldSeed, focus) {
    this.terrain = terrain;
    this.worldSeed = worldSeed;
    this.scenery = [];
    this.forage = null;
    this.player = null;
    this.npcs = [];
    this.companions = [];
    this.selected = null;
    this.hovered = null;
    this.dialogueNpc = null;
    this.paused = false;
    this.destination = null;
    this.previewFocus = focus || { x: WORLD_SIZE / 2, y: WORLD_SIZE / 2 };
    this.renderer.buildMinimapBase(terrain);
    this.cameraSnap = true;
  }

  setInteractive(value) {
    this.interactive = Boolean(value);
    if (!this.interactive) {
      this.heldKeys = [];
      this.canvas.style.cursor = 'default';
    }
  }

  setWander(value) {
    this.wander = Boolean(value);
  }

  getNpc(id) {
    return this.npcs.find(npc => npc.id === id) || null;
  }

  addNpc(raw, companionRaw = null) {
    if (!this.terrain || !this.player) return null;
    const occupied = new Set([`${this.player.x},${this.player.y}`]);
    for (const npc of this.npcs) occupied.add(`${npc.x},${npc.y}`);
    for (const comp of this.companions) occupied.add(`${comp.x},${comp.y}`);
    // Search for an open tile at a comfortable distance from the player (e.g. 6-10 tiles)
    let spot = findOpenTile(this.terrain, { x: this.player.x, y: this.player.y }, occupied, 6);
    if (!spot) {
      spot = findOpenTile(this.terrain, { x: this.player.x, y: this.player.y }, occupied, 2);
    }
    const npc = this.makeCharacter({ ...raw, x: spot.x, y: spot.y });
    this.npcs.push(npc);
    occupied.add(`${npc.x},${npc.y}`);

    if (companionRaw) {
      const compSpot = findOpenTile(this.terrain, { x: npc.x, y: npc.y }, occupied, 1);
      const comp = this.makeCompanion({ ...companionRaw, x: compSpot.x, y: compSpot.y }, npc);
      this.companions.push(comp);
    }
    return npc;
  }

  removeNpc(id) {
    this.npcs = this.npcs.filter(npc => npc.id !== id);
    this.companions = this.companions.filter(comp => comp.buddyId !== id);
    if (this.selected?.id === id) this.selected = null;
    if (this.hovered?.id === id) this.hovered = null;
  }

  updateNpcRecipe(id, recipe) {
    const npc = this.getNpc(id);
    if (npc) npc.recipe = recipe;
  }

  select(id) {
    if (!id) {
      this.selected = null;
      return;
    }
    if (id === 'player') {
      this.selected = this.player;
      return;
    }
    this.selected = this.getNpc(id) || this.companions.find(c => c.id === id) || null;
  }

  allOtherCharacters(exclude = null) {
    const list = [];
    if (this.player && this.player !== exclude) list.push(this.player);
    for (const npc of this.npcs) {
      if (npc !== exclude) list.push(npc);
    }
    for (const comp of this.companions) {
      if (comp !== exclude) list.push(comp);
    }
    return list;
  }

  tryPlayerStep(dx, dy) {
    if (!this.player || !this.interactive || this.paused) return false;
    const nx = this.player.x + dx;
    const ny = this.player.y + dy;
    this.player.direction = directionForStep(dx, dy);

    // Teleport ignores terrain, bumps, and board blocking; tryStep handles the
    // 3-tile landing search and the free-landing check.
    const fx = this.resolveFxFor(this.player);
    if (fx?.motionId === 'teleport') {
      return this.tryStep(this.player, dx, dy, PLAYER_STEP);
    }

    // Check collision with NPCs
    const bumpNpc = occupantAtTile(this.npcs, nx, ny);
    if (bumpNpc) {
      const isMiniGameActive = Boolean(this.miniGameHost?.isOpen?.())
        || this.miniGames.some(m => m.isOpen && m.isOpen());
      if (isMiniGameActive && bumpNpc.inMiniGame) {
        this.heldKeys = [];
        this.player.path = [];
        this.destination = null;
        return false;
      }
      this.openDialogueWith(bumpNpc);
      return false;
    }

    // Check collision with Companions (opens dialogue only with NPC companions, not player's companions)
    const bumpComp = occupantAtTile(this.companions, nx, ny);
    if (bumpComp && canCollide(this.player, bumpComp)) {
      this.openDialogueWith(bumpComp);
      return false;
    }

    // Prevent stepping into any tile reserved by an NPC or colliding Companion
    const reservedBy = reservationAtTile(
      [...this.npcs, ...this.companions].filter(other => canCollide(this.player, other)),
      nx,
      ny
    );
    if (reservedBy) {
      this.heldKeys = [];
      this.player.path = [];
      this.destination = null;
      return false;
    }

    return this.tryStep(this.player, dx, dy, PLAYER_STEP);
  }

  openDialogueWith(npc) {
    if (!npc || this.dialogueNpc) return;
    this.dialogueNpc = npc;
    this.paused = true;
    this.interactive = false;
    this.heldKeys = [];
    this.destination = null;
    if (this.player) this.player.path = [];
    this.hovered = null;
    this.canvas.style.cursor = 'default';
    this.onDialogue(npc);
  }

  resumeFromDialogue() {
    this.dialogueNpc = null;
    this.paused = false;
    this.interactive = true;
  }

  cameraFocus() {
    if (this.player) return this.interpolated(this.player);
    return this.previewFocus;
  }

  updateCamera(dt) {
    const worldPx = WORLD_SIZE * TILE;
    const focus = this.cameraFocus();
    const focusX = (focus.x + 0.5) * TILE;
    const focusY = (focus.y + 0.5) * TILE;
    let targetX = focusX - this.width / 2;
    let targetY = focusY - this.height / 2;
    targetX = worldPx <= this.width ? (worldPx - this.width) / 2 : clamp(targetX, 0, worldPx - this.width);
    targetY = worldPx <= this.height ? (worldPx - this.height) / 2 : clamp(targetY, 0, worldPx - this.height);

    if (this.cameraSnap) {
      this.camera.x = targetX;
      this.camera.y = targetY;
      this.cameraSnap = false;
      return;
    }

    const t = 1 - Math.exp(-dt * 9);
    this.camera.x += (targetX - this.camera.x) * t;
    this.camera.y += (targetY - this.camera.y) * t;
  }

  resolveFxFor(character) {
    if (!character) return null;
    const owner = characterEffectOwner(this, character);
    return resolveFx(character, this.time * 1000, owner);
  }

  canFly(character) {
    const fx = this.resolveFxFor(character);
    return Boolean(fx?.abilities?.fly);
  }

  interpolated(character) {
    if (!character) return { x: 0, y: 0 };
    if (!character.moving) return { x: character.x, y: character.y };
    const t = clamp(character.elapsed / character.duration, 0, 1);
    const arriveAt = Number.isFinite(character.motionArriveAt)
      ? clamp(character.motionArriveAt, 0, 1)
      : 1;
    // Teleport-style motion snaps to the destination early, but only after the
    // same collision/reservation/board checks a normal step performs.
    if (t >= arriveAt) return { x: character.toX, y: character.toY };
    return {
      x: character.fromX + (character.toX - character.fromX) * t,
      y: character.fromY + (character.toY - character.fromY) * t
    };
  }

  tryStep(character, dx, dy, duration) {
    if (!this.terrain) return false;
    const fx = this.resolveFxFor(character);

    // Teleport is the one movement style allowed to bypass terrain and board
    // blocking. It still refuses to land on another character, so reservations
    // and bump-to-talk remain coherent.
    if (fx?.motionId === 'teleport') {
      return this.tryTeleportStep(character, dx, dy, duration, fx);
    }

    const nx = character.x + dx;
    const ny = character.y + dy;
    const tileType = typeAt(this.terrain, nx, ny);
    const flying = Boolean(fx?.abilities?.fly);
    // A character stranded on water (wings removed mid-flight) may wade out
    // rather than being permanently stuck.
    const stranded = !isWalkable(typeAt(this.terrain, character.x, character.y));
    if (tileType === null || (!flying && !isWalkable(tileType) && !stranded)) return false;
    // Flying lets a character cross water; solid board footprints and other
    // characters still block below.

    // Strict occupancy and reservation collision with collision exclusion rule:
    // Filter other characters using canCollide(character, other)
    // (e.g. Walking NPCs are not blocked by companions, but companions are blocked by NPCs)
    const collidingObstacles = this.allOtherCharacters(character).filter(other => canCollide(character, other));
    if (reservationAtTile(collidingObstacles, nx, ny)) {
      return false;
    }

    // Check if an active mini-game blocks movement onto this tile. The host is
    // authoritative when present; legacy mini-game instances remain supported.
    if (this.miniGameHost) {
      if (typeof this.miniGameHost.blocksStep === 'function'
        && this.miniGameHost.blocksStep(character, nx, ny)) {
        return false;
      }
    } else {
      for (const miniGame of this.miniGames) {
        if (miniGame.blocksStep && miniGame.blocksStep(character, nx, ny)) {
          return false;
        }
      }
    }

    // Effect movement is cosmetic: it scales the step clock and records a
    // motion style, but never bypasses the checks above.
    const durationScale = Number.isFinite(fx?.stats?.stepDurationScale)
      ? fx.stats.stepDurationScale
      : 1;

    this.recordEffectTrail(character, fx);
    character.fromX = character.x;
    character.fromY = character.y;
    character.toX = nx;
    character.toY = ny;
    character.moving = true;
    character.elapsed = 0;
    character.duration = Math.max(0.01, duration * durationScale);
    character.direction = directionForStep(dx, dy);

    const motionId = fx?.motionId || null;
    character.motionStyle = motionId;
    character.motionArriveAt = 1;
    if (motionId === 'teleport') {
      const blinkMs = Number(fx?.motion?.blinkMs);
      const durationMs = character.duration * 1000;
      character.motionArriveAt = Number.isFinite(blinkMs) && durationMs > 0
        ? clamp(blinkMs / durationMs, 0.05, 1)
        : 0.6;
    }
    return true;
  }

  /**
   * Teleport up to `motion.distance` tiles in a direction. Intermediate tiles
   * may be water, scenery, or board tiles; only the landing tile must be free
   * of other characters so reservations never overlap.
   */
  tryTeleportStep(character, dx, dy, duration, fx) {
    const maxDistance = clamp(Number(fx?.motion?.distance) || 3, 1, 3);
    const collidingObstacles = this.allOtherCharacters(character).filter(other => canCollide(character, other));
    let landing = null;

    for (let distance = 1; distance <= maxDistance; distance++) {
      const tx = character.x + dx * distance;
      const ty = character.y + dy * distance;
      if (tx < 0 || tx >= WORLD_SIZE || ty < 0 || ty >= WORLD_SIZE) break;
      if (reservationAtTile(collidingObstacles, tx, ty)) continue;
      landing = { x: tx, y: ty, distance };
    }
    if (!landing) return false;

    // Echo-style effects still show the skipped tiles.
    for (let step = 0; step < landing.distance; step++) {
      this.recordEffectTrailPoint(character, {
        x: character.x + dx * step,
        y: character.y + dy * step
      }, fx);
    }

    const durationScale = Number.isFinite(fx?.stats?.stepDurationScale)
      ? fx.stats.stepDurationScale
      : 1;

    character.fromX = character.x;
    character.fromY = character.y;
    character.toX = landing.x;
    character.toY = landing.y;
    character.moving = true;
    character.elapsed = 0;
    character.duration = Math.max(0.01, duration * durationScale);
    character.direction = directionForStep(dx, dy);
    character.motionStyle = 'teleport';
    character.motionArriveAt = 1;
    const blinkMs = Number(fx?.motion?.blinkMs);
    const durationMs = character.duration * 1000;
    character.motionArriveAt = Number.isFinite(blinkMs) && durationMs > 0
      ? clamp(blinkMs / durationMs, 0.05, 1)
      : 0.6;
    return true;
  }

  recordEffectTrailPoint(character, point, fx) {
    if (!Array.isArray(fx?.trail) || !fx.trail.length || !point) return;
    const maxCount = Math.max(
      1,
      ...fx.trail.map(trail => Math.max(1, Number(trail.count) || 3))
    );
    if (!Array.isArray(character.effectTrail)) character.effectTrail = [];
    character.effectTrail.push({
      x: point.x,
      y: point.y,
      at: (this.time || 0) * 1000
    });
    while (character.effectTrail.length > maxCount) character.effectTrail.shift();
  }

  recordEffectTrail(character, fx) {
    this.recordEffectTrailPoint(character, { x: character.x, y: character.y }, fx);
  }

  updatePlayer(dt) {
    const player = this.player;
    if (!player) return;

    if (player.moving) {
      player.elapsed += dt;
      if (player.elapsed >= player.duration) {
        player.x = player.toX;
        player.y = player.toY;
        player.moving = false;
        player.elapsed = 0;
      }
      return;
    }

    if (this.heldKeys.length) {
      const move = this.heldKeys[this.heldKeys.length - 1];
      this.tryPlayerStep(move.dx, move.dy);
      this.destination = null;
      return;
    }

    if (player.path.length) {
      const next = player.path.shift();
      const dx = next.x - player.x;
      const dy = next.y - player.y;
      if (Math.abs(dx) + Math.abs(dy) === 1 && this.tryPlayerStep(dx, dy)) {
        if (player.motionStyle === 'teleport') {
          player.path = [];
          this.destination = null;
        } else if (!player.path.length) {
          this.destination = null;
        }
        return;
      }
      player.path = [];
      this.destination = null;
    }
  }

  updateNpc(npc, dt) {
    if (npc.moving) {
      npc.elapsed += dt;
      if (npc.elapsed >= npc.duration) {
        npc.x = npc.toX;
        npc.y = npc.toY;
        npc.moving = false;
        npc.elapsed = 0;
        npc.wait = 0.5 + Math.random() * 1.6;
      }
      return;
    }

    if (npc.inMiniGame) {
      if (npc.path && npc.path.length) {
        const next = npc.path[0];
        const dx = next.x - npc.x;
        const dy = next.y - npc.y;
        if (Math.abs(dx) + Math.abs(dy) === 1) {
          if (this.tryStep(npc, dx, dy, NPC_STEP)) {
            npc.path.shift();
            npc.blockedWait = 0;
          } else {
            // Momentarily blocked by another character (e.g. player):
            // Fallback: wait briefly, or try lateral evasion around the blocker
            npc.blockedWait = (npc.blockedWait || 0) + dt;
            if (npc.blockedWait > 0.4) {
              // Try lateral step options to navigate around the blocker
              const lateralOptions = dx !== 0
                ? [{ dx: 0, dy: 1 }, { dx: 0, dy: -1 }]
                : [{ dx: 1, dy: 0 }, { dx: -1, dy: 0 }];

              let stepped = false;
              for (const opt of lateralOptions) {
                if (this.tryStep(npc, opt.dx, opt.dy, NPC_STEP)) {
                  stepped = true;
                  npc.blockedWait = 0;
                  // Repath from new position to final destination tile if steppingTo exists
                  const target = npc.miniGameTarget || (npc.path.length ? npc.path[npc.path.length - 1] : null);
                  if (target) {
                    const repath = findPath(this.terrain, { x: npc.toX, y: npc.toY }, target);
                    npc.path = repath.length ? repath : [];
                  }
                  break;
                }
              }
              if (!stepped && npc.blockedWait > 1.2) {
                // If persistently blocked after waiting and lateral attempts, repath entirely
                const target = npc.miniGameTarget || (npc.path.length ? npc.path[npc.path.length - 1] : null);
                if (target) {
                  const repath = findPath(this.terrain, { x: npc.x, y: npc.y }, target);
                  npc.path = repath.length ? repath : [];
                }
                npc.blockedWait = 0;
              }
            }
          }
        } else {
          npc.path = [];
          npc.blockedWait = 0;
        }
      }
      return;
    }

    // Behavior runtime owns wander decisions when present. Movement completion
    // and inMiniGame staging above still run every frame.
    if (this.behaviorRuntime) return;

    if (!this.wander) return;
    npc.wait -= dt;
    if (npc.wait > 0) return;

    const occupied = new Set();
    for (const other of this.allOtherCharacters(npc)) {
      if (canCollide(npc, other)) {
        occupied.add(`${other.x},${other.y}`);
        if (other.moving) occupied.add(`${other.toX},${other.toY}`);
      }
    }

    const options = [];
    for (const { dx, dy } of DIRS) {
      const nx = npc.x + dx;
      const ny = npc.y + dy;
      if (!isWalkable(typeAt(this.terrain, nx, ny))) continue;
      if (occupied.has(`${nx},${ny}`)) continue;
      options.push({ dx, dy, same: (dx === 1 && npc.direction === 1) || (dx === -1 && npc.direction === 3) || (dy === 1 && npc.direction === 0) || (dy === -1 && npc.direction === 2) });
    }

    if (!options.length) {
      npc.wait = 0.7;
      return;
    }

    const forward = options.filter(option => option.same);
    const pool = forward.length && Math.random() < 0.55 ? forward : options;
    const move = pool[Math.floor(Math.random() * pool.length)];
    this.tryStep(npc, move.dx, move.dy, NPC_STEP);
  }

  getMiniGameBlockedTiles() {
    if (this.miniGameHost) {
      if (typeof this.miniGameHost.getBlockedTiles === 'function') {
        return this.miniGameHost.getBlockedTiles();
      }
      return new Set();
    }
    const blocked = new Set();
    for (const game of this.miniGames) {
      if (game.isOpen?.() && game.activeBoard?.originX !== undefined) {
        const size = game.boardSize || 3;
        for (let by = 0; by < size; by++) {
          for (let bx = 0; bx < size; bx++) {
            blocked.add(`${game.activeBoard.originX + bx},${game.activeBoard.originY + by}`);
          }
        }
      }
    }
    return blocked;
  }

  isCharacterOnMiniGameBoard(character) {
    if (!character) return false;
    if (this.miniGameHost) {
      return typeof this.miniGameHost.isTileOnBoard === 'function'
        ? Boolean(this.miniGameHost.isTileOnBoard(character.x, character.y))
        : false;
    }
    for (const game of this.miniGames) {
      if (game.isOpen?.() && game.isTileOnBoard?.(character.x, character.y)) {
        return true;
      }
    }
    return false;
  }

  isParticipantCompanion(comp) {
    if (!comp) return false;
    if (this.miniGameHost) {
      if (typeof this.miniGameHost.isParticipant === 'function'
        && this.miniGameHost.isParticipant(comp)) {
        return true;
      }
      if (typeof this.miniGameHost.getParticipantCompanions === 'function') {
        return this.miniGameHost.getParticipantCompanions()
          .some(candidate => candidate === comp || (candidate?.id && candidate.id === comp.id));
      }
      return false;
    }
    for (const game of this.miniGames) {
      if (game.isOpen?.()) {
        const opponentId = game.activeBoard?.opponent?.id;
        if (comp.buddyId === 'player' || (opponentId && comp.buddyId === opponentId)) {
          return true;
        }
      }
    }
    return false;
  }

  updateCompanion(comp, dt) {
    if (comp.cheerTimer > 0) {
      comp.cheerTimer = Math.max(0, comp.cheerTimer - dt);
      comp.cheerElapsed = (comp.cheerElapsed || 0) + dt;

      // Turn in place now and then while cheering so the hop reads as clapping
      // rather than a rigid synchronized bounce. Facing is restored afterwards.
      if (!comp.moving) {
        comp.cheerTurnTimer = (comp.cheerTurnTimer || 0) - dt;
        if (comp.cheerTurnTimer <= 0) {
          const roll = Math.random();
          comp.direction = roll < 0.4 ? LEFT : (roll < 0.8 ? RIGHT : DOWN);
          comp.cheerTurnTimer = 0.18 + Math.random() * 0.42;
        }
      }

      if (comp.cheerTimer === 0 && !comp.moving) {
        comp.direction = comp.cheerReturnDirection ?? comp.direction;
      }
    }

    if (comp.moving) {
      comp.elapsed += dt;
      if (comp.elapsed >= comp.duration) {
        comp.x = comp.toX;
        comp.y = comp.toY;
        comp.moving = false;
        comp.elapsed = 0;
      }
      return;
    }

    // Handle active mini-game participant companions (player and opponent companions):
    // 1. Keep them parked at their staged spectator position (or move toward it)
    // 2. Prevent them from following their buddy around onto the board while playing
    const isParticipant = this.isParticipantCompanion(comp);
    if (isParticipant) {
      comp.inMiniGame = true;
      if (comp.stagedDestination) {
        // Already at staged spectator spot: stay still facing the board
        if (comp.x === comp.stagedDestination.x && comp.y === comp.stagedDestination.y) {
          comp.moving = false;
          return;
        }

        if (comp.path && comp.path.length) {
          const next = comp.path.shift();
          const dx = next.x - comp.x;
          const dy = next.y - comp.y;
          if (Math.abs(dx) + Math.abs(dy) === 1) {
            this.tryStep(comp, dx, dy, COMPANION_STEP);
          } else {
            const blocked = this.getMiniGameBlockedTiles();
            const repath = findPath(this.terrain, { x: comp.x, y: comp.y }, comp.stagedDestination, blocked);
            comp.path = repath.length ? repath : [];
          }
          return;
        } else {
          const blocked = this.getMiniGameBlockedTiles();
          const repath = findPath(this.terrain, { x: comp.x, y: comp.y }, comp.stagedDestination, blocked);
          if (repath.length) {
            comp.path = repath;
          } else {
            comp.x = comp.stagedDestination.x;
            comp.y = comp.stagedDestination.y;
            comp.path = [];
          }
          return;
        }
      }
      // If a participant companion is on the board without a staged destination, let them walk off
      const isTrappedOnBoard = this.isCharacterOnMiniGameBoard(comp);
      if (!isTrappedOnBoard) {
        comp.moving = false;
        return;
      }
    }

    // Bystander companions (and participant companions moving off the board):
    // If they have an active evacuation path to flee the board, continue following it
    if (comp.path && comp.path.length) {
      const next = comp.path.shift();
      const dx = next.x - comp.x;
      const dy = next.y - comp.y;
      if (Math.abs(dx) + Math.abs(dy) === 1) {
        this.tryStep(comp, dx, dy, COMPANION_STEP);
        return;
      }
      comp.path = [];
    }

    // Determine target location: either fetchTarget or trailing its buddy
    let target = comp.fetchTarget;
    if (!target) {
      // The behavior runtime drives companion following (style-specific) when
      // present; keep the legacy buddy-trail fallback only as a no-runtime path.
      if (this.behaviorRuntime) return;
      const buddy = (this.player && this.player.id === comp.buddyId)
        ? this.player
        : this.npcs.find(n => n.id === comp.buddyId);

      if (!buddy) return;

      // For multiple player companions, trail in an entourage behind the buddy or previous companion
      let leader = buddy;
      if (comp.buddyId === 'player') {
        const playerComps = this.getCompanionsFor('player');
        const index = playerComps.indexOf(comp);
        if (index > 0 && playerComps[index - 1]) {
          leader = playerComps[index - 1];
        }
      }

      const dist = Math.hypot(leader.x - comp.x, leader.y - comp.y);
      if (dist <= 1.5) return;

      target = { x: leader.x, y: leader.y };
    }

    // Path or step toward target (bypassing active mini-game board tiles)
    const dx = target.x - comp.x;
    const dy = target.y - comp.y;
    const stepX = dx === 0 ? 0 : (dx > 0 ? 1 : -1);
    const stepY = dy === 0 ? 0 : (dy > 0 ? 1 : -1);

    if (Math.abs(dx) >= Math.abs(dy)) {
      if (stepX !== 0 && this.tryStep(comp, stepX, 0, COMPANION_STEP)) return;
      if (stepY !== 0 && this.tryStep(comp, 0, stepY, COMPANION_STEP)) return;
    } else {
      if (stepY !== 0 && this.tryStep(comp, 0, stepY, COMPANION_STEP)) return;
      if (stepX !== 0 && this.tryStep(comp, stepX, 0, COMPANION_STEP)) return;
    }

    // If direct step failed (e.g. board or obstacle in the way), pathfind around the board
    const blocked = this.getMiniGameBlockedTiles();
    const repath = findPath(this.terrain, { x: comp.x, y: comp.y }, target, blocked);
    if (repath.length) {
      const next = repath.shift();
      const pdx = next.x - comp.x;
      const pdy = next.y - comp.y;
      if (Math.abs(pdx) + Math.abs(pdy) === 1) {
        this.tryStep(comp, pdx, pdy, COMPANION_STEP);
        comp.path = repath;
      }
    }
  }

  update(dt) {
    this.time += dt;
    if (!this.paused) {
      this.updatePlayer(dt);
      for (const npc of this.npcs) this.updateNpc(npc, dt);
      for (const comp of this.companions) this.updateCompanion(comp, dt);
      if (this.behaviorRuntime && typeof this.behaviorRuntime.update === 'function') {
        this.behaviorRuntime.update(dt * 1000);
      }
      if (this.miniGameHost) {
        if (typeof this.miniGameHost.update === 'function') {
          this.miniGameHost.update(dt * 1000);
        }
      } else {
        for (const game of this.miniGames) game.update?.(dt);
      }
    }
    this.updateCamera(dt);
    if (this.destination && this.time > this.destination.until) this.destination = null;
  }

  frame(now) {
    if (!this.running) return;
    const dt = frameDelta(now, this.last);
    this.last = now;
    this.update(dt);
    this.renderer.drawFrame(this);
    this.onFrame?.();
    requestAnimationFrame(this.frame);
  }

  pointerWorld(event) {
    const rect = this.canvas.getBoundingClientRect();
    const sx = event.clientX - rect.left;
    const sy = event.clientY - rect.top;
    return { sx, sy, x: sx + this.camera.x, y: sy + this.camera.y };
  }

  characterAtScreen(sx, sy) {
    const characters = [...this.npcs, ...this.companions];
    if (this.player) characters.push(this.player);
    characters.sort((a, b) => this.interpolated(b).y - this.interpolated(a).y);
    for (const character of characters) {
      const position = this.interpolated(character);
      const footX = (position.x + 0.5) * TILE - this.camera.x;
      const footY = (position.y + 1) * TILE - this.camera.y;
      const fx = this.resolveFxFor(character);
      const h = characterVisualHeight(character, fx);
      const width = h * 0.78;
      if (sx >= footX - width / 2 && sx <= footX + width / 2 && sy >= footY - h && sy <= footY) {
        return character;
      }
    }
    return null;
  }

  handlePointerMove(event) {
    if (!this.interactive) return;
    const { sx, sy } = this.pointerWorld(event);
    this.pointer = { x: sx, y: sy };
    const character = this.characterAtScreen(sx, sy);
    this.hovered = character;
    this.canvas.style.cursor = character ? 'pointer' : 'default';
  }

  handlePointerLeave() {
    this.hovered = null;
    this.canvas.style.cursor = 'default';
  }

  handlePointerDown(event) {
    if (!this.interactive || event.button !== 0) return;
    const { sx, sy, x, y } = this.pointerWorld(event);
    const character = this.characterAtScreen(sx, sy);
    if (character) {
      this.selected = character;
      this.onSelect(character);
      return;
    }

    const tileX = Math.floor(x / TILE);
    const tileY = Math.floor(y / TILE);
    if (!this.player || !this.terrain) return;
    const flying = this.canFly(this.player)
      || !isWalkable(typeAt(this.terrain, this.player.x, this.player.y));
    if (!flying && !isWalkable(typeAt(this.terrain, tileX, tileY))) {
      this.onToast('That spot is water.');
      return;
    }

    const blocked = new Set();
    for (const npc of this.npcs) {
      blocked.add(`${npc.x},${npc.y}`);
      if (npc.moving) blocked.add(`${npc.toX},${npc.toY}`);
    }
    const path = findPath(
      this.terrain,
      { x: this.player.x, y: this.player.y },
      { x: tileX, y: tileY },
      blocked,
      { fly: flying }
    );
    if (path.length) {
      this.player.path = path;
      this.destination = { x: tileX, y: tileY, until: this.time + 1.4 };
      this.heldKeys = [];
      this.selected = null;
      this.onSelect(null);
    } else {
      this.onToast('No clear path there.');
    }
  }

  handleKeyDown(event) {
    if (!this.interactive || !this.player) return;
    if (event.target instanceof HTMLElement && event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
    if (this.isMenuOpen()) return;

    if (event.key === 'Enter' || event.key === ' ') {
      this.onActionKey?.(this.player);
      return;
    }

    const move = MOVE_KEYS.get(event.key.toLowerCase());
    if (!move) return;
    event.preventDefault();
    if (!this.heldKeys.some(item => item.key === event.key.toLowerCase())) {
      this.heldKeys.push({ key: event.key.toLowerCase(), ...move });
    }
    this.player.path = [];
    this.destination = null;
    if (!this.player.moving) this.tryPlayerStep(move.dx, move.dy);
  }

  handleKeyUp(event) {
    const key = event.key.toLowerCase();
    this.heldKeys = this.heldKeys.filter(item => item.key !== key);
  }

  handleBlur() {
    this.heldKeys = [];
  }
}
