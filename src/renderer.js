import {
  WORLD_SIZE,
  TILE_TYPES,
  TERRAIN_COLORS,
  mulberry32,
  hashString
} from './world.js';
import { drawAvatar, getAvatarImage, loadAvatarImage } from './avatar.js';
import { shouldMirror, UP } from './facing.js';
import { getAnimationProfile } from './animation.js';
import { composeRenderTransform, resolveFx } from './effects.js';
import { isMushroomHidden, isMushroomScenery } from './forage.js';
import sceneryAssets from '../data/nature_scenery.json' with { type: 'json' };

export const TILE = 48;
export const CHARACTER_HEIGHT = TILE * 1.72;
export const COMPANION_HEIGHT = TILE * 1.05;
export const PET_HEIGHT = COMPANION_HEIGHT * 2; // Twice the companion size to match 256x256 rendering area

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/** Base (unscaled) sprite height shared by the renderer and the hitbox. */
export function characterBaseHeight(character) {
  const profile = getAnimationProfile(character?.recipe);
  const is3DModel = Boolean(
    profile.family?.startsWith('pet-') || profile.family?.startsWith('creature-')
  );
  if (character?.isCompanion) return is3DModel ? PET_HEIGHT : COMPANION_HEIGHT;
  return CHARACTER_HEIGHT;
}

/**
 * Visual height after effect scaling. Big-O grows the sprite, nameplate, and
 * click hitbox by the same amount while leaving the camera and minimap alone.
 */
export function characterVisualHeight(character, fx = null) {
  const scale = Number.isFinite(fx?.scale) ? fx.scale : 1;
  return characterBaseHeight(character) * scale;
}

/** Companions inherit party effects from the buddy they follow. */
export function characterEffectOwner(game, character) {
  if (!game || !character?.isCompanion) return null;
  if (game.player && game.player.id === character.buddyId) return game.player;
  return (game.npcs || []).find(npc => npc.id === character.buddyId) || null;
}

export function makeTileTextures() {
  const textures = {};
  const scale = 2;
  const size = TILE * scale;

  for (const type of TILE_TYPES) {
    textures[type] = [];
    for (let variant = 0; variant < 3; variant++) {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext('2d');
      const random = mulberry32(hashString(`${type}:${variant}:playpark`));
      ctx.fillStyle = TERRAIN_COLORS[type];
      ctx.fillRect(0, 0, size, size);

      if (type === 'grass' || type === 'field') {
        for (let i = 0; i < 26; i++) {
          const x = random() * size;
          const y = random() * size;
          if (type === 'grass') {
            ctx.fillStyle = random() > 0.5 ? 'rgba(192, 223, 120, 0.32)' : 'rgba(30, 65, 43, 0.32)';
            ctx.fillRect(x, y, 2 + random() * 2, 2 + random() * 2);
          } else {
            ctx.fillStyle = random() > 0.55 ? 'rgba(216, 202, 102, 0.55)' : 'rgba(72, 94, 36, 0.3)';
            ctx.fillRect(x, y, 2 + random() * 2, 2 + random() * 2);
          }
        }
      }

      if (type === 'dirt') {
        for (let i = 0; i < 20; i++) {
          ctx.fillStyle = random() > 0.5 ? 'rgba(84, 60, 52, 0.28)' : 'rgba(196, 154, 108, 0.26)';
          ctx.fillRect(random() * size, random() * size, 2 + random() * 3, 2 + random() * 2);
        }
      }

      if (type === 'sand') {
        for (let i = 0; i < 24; i++) {
          ctx.fillStyle = random() > 0.5 ? 'rgba(255, 240, 168, 0.32)' : 'rgba(140, 112, 64, 0.2)';
          ctx.fillRect(random() * size, random() * size, 2, 2);
        }
      }

      if (type === 'water') {
        for (let i = 0; i < 7; i++) {
          const x = random() * size;
          const y = random() * size;
          ctx.fillStyle = 'rgba(213, 245, 255, 0.28)';
          ctx.fillRect(x, y, 10 + random() * 18, 2);
          ctx.fillStyle = 'rgba(18, 74, 104, 0.24)';
          ctx.fillRect(x + 8, y + 5, 8 + random() * 10, 2);
        }
      }

      if (type === 'field') {
        ctx.strokeStyle = 'rgba(213, 184, 91, 0.48)';
        ctx.lineWidth = 2;
        for (let i = 1; i < 5; i++) {
          const y = (size * i) / 5;
          ctx.beginPath();
          ctx.moveTo(size * 0.08, y);
          ctx.lineTo(size * 0.92, y);
          ctx.stroke();
        }
        ctx.fillStyle = 'rgba(216, 202, 102, 0.5)';
        for (let i = 0; i < 4; i++) ctx.fillRect(size * (0.15 + i * 0.2), size * 0.17, 2, size * 0.66);
      }

      ctx.strokeStyle = 'rgba(232, 245, 223, 0.06)';
      ctx.lineWidth = 2;
      ctx.strokeRect(1, 1, size - 2, size - 2);
      textures[type].push(canvas);
    }
  }

  return textures;
}

export class WorldRenderer {
  constructor({ canvas, minimap } = {}) {
    this.canvas = canvas;
    this.ctx = canvas?.getContext?.('2d') || null;
    this.minimap = minimap;
    this.mctx = minimap?.getContext?.('2d') || null;
    this.tileTextures = null;
    this.minimapBase = null;
    this.sceneryImages = new Map();
    this.sceneryOpacity = new Map(); // id -> current rendered opacity (0 to 1)
    this.lastFrameTime = performance.now();
    this.initScenery();
  }

  initScenery() {
    if (typeof Image === 'undefined') return;
    for (const [key, uri] of Object.entries(sceneryAssets)) {
      const img = new Image();
      img.src = uri;
      this.sceneryImages.set(key, img);
    }
  }

  initTextures() {
    if (!this.tileTextures && typeof document !== 'undefined') {
      this.tileTextures = makeTileTextures();
    }
  }

  buildMinimapBase(terrain) {
    if (!terrain || typeof document === 'undefined') return;
    const scale = 4;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = WORLD_SIZE * scale;
    const ctx = canvas.getContext('2d');
    for (let y = 0; y < WORLD_SIZE; y++) {
      for (let x = 0; x < WORLD_SIZE; x++) {
        ctx.fillStyle = TERRAIN_COLORS[terrain[y][x]];
        ctx.fillRect(x * scale, y * scale, scale, scale);
      }
    }
    this.minimapBase = canvas;
  }

  variantFor(x, y) {
    return Math.abs((x * 73856093) ^ (y * 19349663) ^ (x * y * 83492791)) % 3;
  }

  drawFrame(game) {
    if (!game.terrain) return;
    this.initTextures();
    const { ctx } = this;
    const { width, height, camera, terrain } = game;

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#0b110d';
    ctx.fillRect(0, 0, width, height);

    const camX = Math.round(camera.x);
    const camY = Math.round(camera.y);
    ctx.save();
    ctx.translate(-camX, -camY);

    // The host renderer already handed use a translated context; adapters pass
    // a zero camera into legacy games, so `view` never applies the camera twice.
    const view = {
      camera: { x: 0, y: 0 },
      width,
      height,
      tileSize: TILE,
      worldSpace: true
    };

    const x0 = clamp(Math.floor(camX / TILE) - 1, 0, WORLD_SIZE - 1);
    const y0 = clamp(Math.floor(camY / TILE) - 1, 0, WORLD_SIZE - 1);
    const x1 = clamp(Math.ceil((camX + width) / TILE) + 1, 0, WORLD_SIZE - 1);
    const y1 = clamp(Math.ceil((camY + height) / TILE) + 1, 0, WORLD_SIZE - 1);

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const texture = this.tileTextures[terrain[y][x]][this.variantFor(x, y)];
        ctx.drawImage(texture, x * TILE, y * TILE, TILE, TILE);
      }
    }

    // Mini-game ground/object layers. The host owns sessions when present;
    // legacy miniGames remain a fallback for older wiring.
    if (game.miniGameHost) {
      game.miniGameHost.renderLayer?.(ctx, 'ground', view);
      game.miniGameHost.renderLayer?.(ctx, 'object', view);
    } else {
      for (const mg of game.miniGames) {
        if (mg.renderGround) mg.renderGround(ctx, camera);
        else if (mg.render) mg.render(ctx, { x: 0, y: 0 });
      }
    }

    if (game.destination) {
      const pulse = 0.5 + Math.sin(game.time * 7) * 0.5;
      const cx = (game.destination.x + 0.5) * TILE;
      const cy = (game.destination.y + 0.5) * TILE;
      ctx.beginPath();
      ctx.arc(cx, cy, TILE * (0.24 + pulse * 0.05), 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(229, 244, 165, ${0.35 + pulse * 0.35})`;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, cy, 3, 0, Math.PI * 2);
      ctx.fillStyle = '#e5f4a5';
      ctx.fill();
    }

    // Render characters and scenery sorted by Y depth
    const renderables = [];
    if (game.player) renderables.push({ type: 'char', y: game.interpolated(game.player).y, entity: game.player });
    for (const npc of game.npcs) renderables.push({ type: 'char', y: game.interpolated(npc).y, entity: npc });
    for (const comp of game.companions) renderables.push({ type: 'char', y: game.interpolated(comp).y, entity: comp });

    if (Array.isArray(game.scenery)) {
      // Delta time calculation for smooth scenery fade tweening
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const epochNow = Date.now();
      const dt = Math.min((now - (this.lastFrameTime || now)) / 1000, 0.1);
      this.lastFrameTime = now;
      const FADE_SPEED = 3.5; // ~0.28s to fade in/out completely

      // Find bounding zones of all currently open mini-game boards (expanded by 1 tile margin)
      const hiddenZones = [];
      if (game.miniGameHost && typeof game.miniGameHost.getHiddenZones === 'function') {
        for (const zone of game.miniGameHost.getHiddenZones() || []) {
          if (!zone) continue;
          hiddenZones.push({
            minX: zone.x - 2,
            maxX: zone.x + zone.width + 1,
            minY: zone.y - 2,
            maxY: zone.y + zone.height + 1
          });
        }
      } else {
        for (const mg of game.miniGames || []) {
          if (mg.isOpen?.() && mg.activeBoard?.originX !== undefined) {
            const size = mg.boardSize || 3;
            hiddenZones.push({
              minX: mg.activeBoard.originX - 1,
              maxX: mg.activeBoard.originX + size,
              minY: mg.activeBoard.originY - 1,
              maxY: mg.activeBoard.originY + size
            });
          }
        }
      }

      for (const item of game.scenery) {
        // Harvested mushrooms are off the ground until their respawn clock runs out.
        if (isMushroomScenery(item) && isMushroomHidden(game.forage, item.id, epochNow)) continue;
        // Target opacity: 0 if on or adjacent to active board, 1 if clear
        const isHidden = hiddenZones.some(
          zone => item.x >= zone.minX && item.x <= zone.maxX && item.y >= zone.minY && item.y <= zone.maxY
        );
        const targetOpacity = isHidden ? 0 : 1;
        const currentOpacity = this.sceneryOpacity.has(item.id) ? this.sceneryOpacity.get(item.id) : 1;

        // Smooth tween toward target opacity
        let newOpacity = currentOpacity;
        if (currentOpacity < targetOpacity) {
          newOpacity = Math.min(targetOpacity, currentOpacity + FADE_SPEED * dt);
        } else if (currentOpacity > targetOpacity) {
          newOpacity = Math.max(targetOpacity, currentOpacity - FADE_SPEED * dt);
        }
        this.sceneryOpacity.set(item.id, newOpacity);

        // Render if opacity > 0
        if (newOpacity > 0.01) {
          renderables.push({ type: 'scenery', y: item.y, entity: item, opacity: newOpacity });
        }
      }
    }

    for (const apple of game.forage?.apples || []) {
      renderables.push({ type: 'forage', y: apple.y, entity: apple });
    }

    renderables.sort((a, b) => a.y - b.y);

    for (const item of renderables) {
      if (item.type === 'char') {
        this.drawCharacter(game, item.entity);
      } else if (item.type === 'forage') {
        this.drawForageItem(game, item.entity);
      } else {
        this.drawSceneryItem(ctx, item.entity, item.opacity);
      }
    }

    // Overlay layer (tokens, hover highlights) sits above characters.
    if (game.miniGameHost) {
      game.miniGameHost.renderLayer?.(ctx, 'overlay', view);
    }

    // Speech bubbles are world-space and follow moving actors.
    if (game.speechBubbles) {
      game.speechBubbles.render?.(ctx, {
        tileSize: TILE,
        worldSpace: true,
        width,
        height
      });
    }

    ctx.restore();

    // HUD layer is screen-space and therefore drawn after restoring the camera.
    if (game.miniGameHost) {
      game.miniGameHost.renderLayer?.(ctx, 'hud', view);
    }

    const hovered = game.hovered || game.selected;
    if (hovered) this.drawNameplate(game, hovered);
    this.drawMinimap(game);
  }

  drawForageItem(game, apple) {
    const { ctx } = this;
    if (!apple) return;
    const bob = Math.sin((game.time || 0) * 3 + apple.x * 0.7) * TILE * 0.04;
    const cx = (apple.x + 0.5) * TILE;
    const cy = (apple.y + 0.8) * TILE + bob;
    const r = TILE * 0.14;

    // Soft collectible ring so apples read as pickups rather than scenery.
    const pulse = 0.5 + Math.sin((game.time || 0) * 2.2 + apple.y) * 0.5;
    ctx.save();
    ctx.globalAlpha = 0.18 + pulse * 0.12;
    ctx.strokeStyle = '#ffe9a8';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(cx, (apple.y + 0.92) * TILE, r * 1.7, r * 0.7, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    // Ground shadow.
    ctx.save();
    ctx.globalAlpha = 0.24;
    ctx.fillStyle = '#0b140d';
    ctx.beginPath();
    ctx.ellipse(cx, (apple.y + 0.94) * TILE, r * 1.05, r * 0.42, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.translate(cx, cy);
    ctx.fillStyle = '#d93a3a';
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#b02727';
    ctx.beginPath();
    ctx.arc(r * 0.22, r * 0.18, r * 0.78, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255, 246, 232, 0.45)';
    ctx.beginPath();
    ctx.ellipse(-r * 0.34, -r * 0.36, r * 0.26, r * 0.18, -0.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#6b4a2f';
    ctx.lineWidth = Math.max(1.5, TILE * 0.035);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(0, -r * 0.8);
    ctx.quadraticCurveTo(r * 0.1, -r * 1.35, r * 0.02, -r * 1.6);
    ctx.stroke();
    ctx.fillStyle = '#5fae5f';
    ctx.beginPath();
    ctx.ellipse(r * 0.55, -r * 1.32, r * 0.5, r * 0.24, -0.55, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  drawSceneryItem(ctx, item, opacity = 1) {
    const img = this.sceneryImages.get(item.type);
    if (!img || !img.complete) return;

    const isTree = item.type.includes('tree');
    const isBushOrRock = item.type.includes('bush') || item.type.includes('rock');

    // Trees stand tall (2.5 - 3.2 tiles), bushes and boulders are medium (1.4 - 1.5 tiles),
    // ground cover (flowers, mushrooms, grass) is compact (0.7 - 0.9 tiles)
    let baseW;
    let baseH;
    if (isTree) {
      baseW = TILE * 2.5;
      baseH = TILE * 3.0;
    } else if (isBushOrRock) {
      baseW = TILE * 1.5;
      baseH = TILE * 1.4;
    } else {
      baseW = TILE * 0.8;
      baseH = TILE * 0.8;
    }

    const width = baseW * (item.scale || 1);
    const height = baseH * (item.scale || 1);

    const footX = (item.x + 0.5) * TILE;
    const footY = (item.y + 1) * TILE;

    // Compensate for transparent padding at the bottom of source images so objects plant firmly on the ground
    const BOTTOM_OFFSETS = {
      'apple-tree': 0.148,
      'chestnut-tree': 0.107,
      'puffy-tree': 0.086,
      'rounded-bush': 0.068,
      'flowering-bush': 0.0,
      'rock-boulder': 0.0,
      'mushroom': 0.0,
      'mushroom-cluster': 0.0,
      'flower-red': 0.088,
      'grass-tuft': 0.0
    };
    const bottomTrim = (BOTTOM_OFFSETS[item.type] || 0) * height;

    if (opacity < 0.999) {
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, opacity));
      ctx.drawImage(img, footX - width / 2, footY - height + bottomTrim, width, height);
      ctx.restore();
    } else {
      ctx.drawImage(img, footX - width / 2, footY - height + bottomTrim, width, height);
    }
  }

  drawCharacter(game, character) {
    const { ctx } = this;
    const isCompanion = Boolean(character.isCompanion);
    const profile = getAnimationProfile(character.recipe);
    const is3DModel = Boolean(profile.family?.startsWith('pet-') || profile.family?.startsWith('creature-'));
    const baseHeight = characterBaseHeight(character);
    const nowMs = (game.time || 0) * 1000;
    const fx = resolveFx(character, nowMs, characterEffectOwner(game, character));
    const height = characterVisualHeight(character, fx);
    const width = height;
    const position = game.interpolated(character);
    const footX = (position.x + 0.5) * TILE;
    const footY = (position.y + 1) * TILE;
    const movingT = character.moving ? clamp(character.elapsed / character.duration, 0, 1) : 0;
    const cheerHop = isCompanion && character.cheerTimer > 0
      ? Math.abs(Math.sin(
          (character.cheerPhase || 0) + (character.cheerElapsed || 0) * (character.cheerRate || 12)
        )) * TILE * (character.cheerHeight || 0.42)
      : 0;

    // Hash character id to de-synchronize blinks and idle cycles so neighbours don't blink in unison
    const charTimeOffset = (hashString(character.id || 'char') % 1000) * 0.01;
    const animTime = (game.time || 0) + charTimeOffset;

    // Determine family-specific procedural transform (both idle AND movement locomotion)
    const animTransform = profile.getTransform
      ? profile.getTransform(animTime, baseHeight, {
          moving: Boolean(character.moving),
          movingT,
          direction: character.direction
        })
      : { translateY: 0, translateX: 0, rotate: 0, scaleX: 1, scaleY: 1, alpha: 1, shadowScale: 1 };

    // One composition point: animation transform -> effect channels -> motion.
    // Effect rotate values are authored in degrees; animation rotate is radians.
    const composed = composeRenderTransform({
      scale: 1,
      alpha: animTransform.alpha ?? 1,
      offsetX: animTransform.translateX || 0,
      offsetY: (animTransform.translateY || 0) - cheerHop,
      rotate: (animTransform.rotate || 0) * RAD_TO_DEG
    }, fx);

    let offsetX = composed.offsetX;
    let offsetY = composed.offsetY;
    let rotate = composed.rotate * DEG_TO_RAD;
    let alpha = composed.alpha;

    if (fx.motionId === 'float' && fx.motion) {
      const period = Math.max(1, Number(fx.motion.periodMs) || 2400);
      const amplitude = Number(fx.motion.amplitude) || 0;
      offsetY -= Math.abs(Math.sin((nowMs / period) * Math.PI * 2)) * amplitude;
    } else if (fx.motionId === 'sway' && fx.motion) {
      const period = Math.max(1, Number(fx.motion.periodMs) || 2200);
      const degrees = Number(fx.motion.rotateDeg) || 0;
      rotate += Math.sin((nowMs / period) * Math.PI * 2) * degrees * DEG_TO_RAD;
    } else if (fx.motionId === 'bounce' && fx.motion) {
      const period = Math.max(1, Number(fx.motion.periodMs) || 260);
      const amplitude = Number(fx.motion.amplitude) || 0;
      const strength = character.moving ? 1 : 0.28;
      offsetY -= Math.abs(Math.sin((nowMs / period) * Math.PI * 2)) * amplitude * strength;
    } else if (fx.motionId === 'flap' && fx.motion) {
      const period = Math.max(1, Number(fx.motion.periodMs) || 420);
      const amplitude = Number(fx.motion.amplitude) || 0;
      const tilt = (Number(fx.motion.tiltDeg) || 0) * DEG_TO_RAD;
      const wing = Math.sin((nowMs / period) * Math.PI * 2);
      // Wings keep a lazy hover at rest and beat harder while moving.
      const strength = character.moving ? 1 : 0.55;
      offsetY -= (wing * 0.5 + 0.5) * amplitude * strength;
      rotate += wing * tilt * strength;
    }

    // Teleport is cosmetic: the step already passed collision checks in Game.
    if (character.motionStyle === 'teleport' && character.moving && character.duration > 0) {
      const progress = clamp(character.elapsed / character.duration, 0, 1);
      if (progress > 0.35 && progress < 0.65) alpha *= 0.12;
    }

    const scaleX = animTransform.scaleX ?? 1;
    const scaleY = animTransform.scaleY ?? 1;
    const shadowScale = animTransform.shadowScale ?? 1;
    const drawX = footX + offsetX;
    const top = footY - height + offsetY;

    // Dust trails (Bouncy Boots): short lines of fading puffs behind the step.
    const trailConfigs = Array.isArray(fx.trail) ? fx.trail : [];
    const history = Array.isArray(character.effectTrail) ? character.effectTrail : [];
    const entriesForTrail = (config) => {
      const life = Math.max(80, Number(config?.lifeMs) || 620);
      const count = Math.max(1, Number(config?.count) || 4);
      return history
        .filter(entry => entry && nowMs - entry.at <= life)
        .slice(-count);
    };

    for (const config of trailConfigs) {
      const style = config?.style || 'echo';
      if (style !== 'dust') continue;
      const entries = entriesForTrail(config);
      const life = Math.max(80, Number(config?.lifeMs) || 620);
      for (const entry of entries) {
        const age = clamp((nowMs - entry.at) / life, 0, 1);
        const puffX = (entry.x + 0.5) * TILE;
        const puffY = (entry.y + 0.55) * TILE;
        const radius = TILE * (0.12 + 0.22 * (1 - age));
        ctx.save();
        ctx.globalAlpha = clamp((Number(config.alpha) || 0.6) * (1 - age), 0, 1);
        ctx.fillStyle = config.color || '#f4a261';
        ctx.beginPath();
        ctx.ellipse(puffX, puffY, radius, radius * 0.62, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }

    if (Array.isArray(fx.aura) && fx.aura.length) {
      for (const aura of fx.aura) {
        if (!aura) continue;
        const radius = Number(aura.radius) || 18;
        const pulseMs = Number(aura.pulseMs);
        const weight = Number(aura.weight) || 1;
        const pulse = pulseMs > 0
          ? 0.72 + 0.28 * Math.sin((nowMs / pulseMs) * Math.PI * 2)
          : 1;
        const baseAlpha = clamp((Number(aura.opacity) || 0.2) * weight * pulse, 0, 1);
        const centerY = footY - height * 0.45;

        ctx.save();
        if (aura.rainbow) {
          const spokes = Math.max(3, Number(aura.spokes) || 6);
          const spin = (nowMs / Math.max(200, pulseMs || 1800)) * Math.PI * 2;
          ctx.lineWidth = Math.max(3, radius * 0.12);
          ctx.lineCap = 'round';
          for (let i = 0; i < spokes; i++) {
            const start = spin + (i / spokes) * Math.PI * 2;
            ctx.beginPath();
            ctx.strokeStyle = `hsl(${Math.round((i / spokes) * 360)}, 95%, 62%)`;
            ctx.globalAlpha = clamp(baseAlpha * 0.9, 0, 1);
            ctx.arc(drawX, centerY, radius * (0.86 + 0.14 * pulse), start, start + 0.42);
            ctx.stroke();
          }
        } else {
          ctx.globalAlpha = clamp(baseAlpha * 0.75, 0, 1);
          ctx.fillStyle = aura.color || '#e5f4a5';
          ctx.beginPath();
          ctx.ellipse(drawX, centerY, radius, radius * 1.1, 0, 0, Math.PI * 2);
          ctx.fill();
        }

        const sparks = Math.max(0, Number(aura.sparks) || 0);
        if (sparks) {
          const sparkRadius = Number(aura.sparkRadius) || radius * 0.7;
          for (let i = 0; i < sparks; i++) {
            const angle = (nowMs / 900) + (i / sparks) * Math.PI * 2;
            const sx = drawX + Math.cos(angle) * sparkRadius;
            const sy = centerY + Math.sin(angle) * sparkRadius * 0.62;
            ctx.beginPath();
            ctx.globalAlpha = clamp(baseAlpha, 0, 1);
            ctx.fillStyle = aura.color || '#b9fbc0';
            ctx.shadowColor = aura.color || '#b9fbc0';
            ctx.shadowBlur = 12;
            ctx.arc(sx, sy, 3.2, 0, Math.PI * 2);
            ctx.fill();
          }
        }
        ctx.restore();
      }
    }

    // Holographic projection glow on the ground for floating digi-buddies ('gaze')
    if (animTransform.hologramGlow) {
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(footX + offsetX * 0.5, footY - 3, TILE * 0.28 * shadowScale, TILE * 0.10 * shadowScale, 0, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(102, 217, 232, 0.26)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(153, 233, 242, 0.55)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();
    }

    if (character === game.player || character === game.selected || character === game.hovered) {
      ctx.beginPath();
      ctx.ellipse(footX, footY - 2, TILE * 0.42, TILE * 0.16, 0, 0, Math.PI * 2);
      ctx.fillStyle = character === game.player ? 'rgba(229, 244, 165, 0.16)' : 'rgba(229, 244, 165, 0.28)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(229, 244, 165, 0.55)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // Alternate walk frames for pets and creatures
    let targetFrame = 'default';
    if (isCompanion && character.cheerTimer > 0 && profile.frames?.includes('cheer')) {
      targetFrame = 'cheer';
    } else if (character.moving && is3DModel) {
      // Alternate walk frames: walk1 on first half of step, walk2 on second half
      targetFrame = movingT < 0.5 ? 'walk1' : 'walk2';
    } else if (profile.getFrame) {
      const f = profile.getFrame(animTime);
      // Allow gaze companions to look around even while floating; other walkers default during step unless blinking
      targetFrame = (character.moving && f !== 'blink' && !animTransform.hologramGlow) ? 'default' : f;
    } else if (profile.isBlinking && profile.isBlinking(animTime)) {
      targetFrame = 'blink';
    }

    // For pet & creature companions facing UP (away from camera), switch to the reverse 3D view
    if (is3DModel && character.direction === UP) {
      const backKey = `back_${targetFrame}`;
      if (profile.frames?.includes(backKey)) {
        targetFrame = backKey;
      }
    }

    let image = getAvatarImage(character.recipe, { frame: targetFrame });
    if (!image) {
      // Trigger lazy load for missing frame and fallback to default frame
      loadAvatarImage(character.recipe, { frame: targetFrame }).catch(() => {});
      image = getAvatarImage(character.recipe, { frame: 'default' });
    }

    if (image) {
      const flip = shouldMirror(character.direction);
      for (const config of trailConfigs) {
        const style = config?.style || 'echo';
        if (style !== 'echo') continue;
        const entries = entriesForTrail(config);
        const life = Math.max(80, Number(config?.lifeMs) || 620);
        for (const entry of entries) {
          const age = clamp((nowMs - entry.at) / life, 0, 1);
          const ghostAlpha = clamp((Number(config.alpha) || 0.35) * (1 - age), 0, 1);
          const ghostScale = 0.92 + 0.08 * (1 - age);
          const ghostX = (entry.x + 0.5) * TILE;
          const ghostY = (entry.y + 1) * TILE;
          const ghostWidth = width * ghostScale;
          const ghostHeight = height * ghostScale;
          ctx.save();
          ctx.globalAlpha = 1;
          ctx.shadowColor = config.color || '#c77dff';
          ctx.shadowBlur = 10;
          drawAvatar(
            ctx,
            image,
            ghostX - ghostWidth / 2,
            ghostY - ghostHeight,
            ghostWidth,
            ghostHeight,
            flip,
            ghostAlpha
          );
          ctx.restore();
        }
      }
    }

    if (image) {
      const flip = shouldMirror(character.direction);
      ctx.save();
      if (offsetX !== 0 || rotate !== 0 || scaleX !== 1 || scaleY !== 1) {
        // Transform around the character's foot anchor so effects and squash
        // both grow/shrink toward the ground.
        ctx.translate(drawX, footY);
        if (rotate !== 0) ctx.rotate(flip ? -rotate : rotate);
        if (scaleX !== 1 || scaleY !== 1) ctx.scale(scaleX, scaleY);
        ctx.translate(-drawX, -footY);
      }
      drawAvatar(ctx, image, drawX - width / 2, top, width, height, flip, clamp(alpha, 0, 1));
      ctx.restore();
    } else {
      const frames = profile.frames || ['default', 'blink'];
      for (const f of frames) {
        loadAvatarImage(character.recipe, { frame: f }).catch(() => {});
      }
      ctx.fillStyle = 'rgba(20, 30, 22, 0.8)';
      ctx.beginPath();
      ctx.arc(drawX, footY - height * 0.45, height * 0.3, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(229, 244, 165, 0.5)';
      ctx.stroke();
    }

    if (fx.outline) {
      ctx.save();
      ctx.globalAlpha = clamp(Number(fx.outline.alpha) || 0.3, 0, 1);
      ctx.strokeStyle = fx.outline.color || '#e5f4a5';
      ctx.lineWidth = Number(fx.outline.width) || 1;
      ctx.beginPath();
      ctx.ellipse(drawX, footY - height * 0.48, width * 0.34, height * 0.46, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  drawNameplate(game, character) {
    const { ctx } = this;
    const isCompanion = Boolean(character.isCompanion);
    const fx = resolveFx(character, (game.time || 0) * 1000, characterEffectOwner(game, character));
    const height = characterVisualHeight(character, fx);
    const position = game.interpolated(character);
    const footX = (position.x + 0.5) * TILE - game.camera.x;
    const footY = (position.y + 1) * TILE - game.camera.y;
    let label = character.name;
    if (character.isPlayer) label = `${character.name} · you`;
    else if (isCompanion) label = `${character.name} · buddy`;

    ctx.save();
    ctx.font = '600 11px system-ui, -apple-system, sans-serif';
    const textWidth = ctx.measureText(label).width;
    const width = textWidth + 16;
    const boxHeight = 22;
    const x = clamp(footX - width / 2, 6, game.width - width - 6);
    const y = footY - height - 24 + (fx.offsetY || 0);
    ctx.fillStyle = 'rgba(10, 17, 12, 0.9)';
    ctx.strokeStyle = 'rgba(163, 210, 139, 0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, width, boxHeight, 6);
    else ctx.rect(x, y, width, boxHeight);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#edf4e9';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x + width / 2, y + boxHeight / 2 + 0.5);
    ctx.restore();
  }

  drawMinimap(game) {
    if (!this.minimapBase || !this.mctx) return;
    const size = this.minimap.width;
    const { mctx } = this;
    mctx.clearRect(0, 0, size, size);
    mctx.imageSmoothingEnabled = false;
    mctx.drawImage(this.minimapBase, 0, 0, size, size);

    const scale = size / (WORLD_SIZE * TILE);
    mctx.fillStyle = 'rgba(229, 244, 165, 0.55)';
    mctx.strokeStyle = 'rgba(229, 244, 165, 0.55)';
    mctx.lineWidth = Math.max(1, size / 320);
    mctx.strokeRect(
      game.camera.x * scale,
      game.camera.y * scale,
      Math.min(size, game.width * scale),
      Math.min(size, game.height * scale)
    );

    for (const npc of game.npcs) {
      const position = game.interpolated(npc);
      mctx.beginPath();
      mctx.arc((position.x + 0.5) * (size / WORLD_SIZE), (position.y + 0.5) * (size / WORLD_SIZE), Math.max(2, size / 110), 0, Math.PI * 2);
      mctx.fillStyle = 'rgba(233, 240, 232, 0.65)';
      mctx.fill();
    }

    for (const apple of game.forage?.apples || []) {
      mctx.beginPath();
      mctx.arc(
        (apple.x + 0.5) * (size / WORLD_SIZE),
        (apple.y + 0.5) * (size / WORLD_SIZE),
        Math.max(1.4, size / 240),
        0,
        Math.PI * 2
      );
      mctx.fillStyle = 'rgba(217, 58, 58, 0.9)';
      mctx.fill();
    }

    if (game.player) {
      const position = game.interpolated(game.player);
      mctx.beginPath();
      mctx.arc((position.x + 0.5) * (size / WORLD_SIZE), (position.y + 0.5) * (size / WORLD_SIZE), Math.max(3, size / 75), 0, Math.PI * 2);
      mctx.fillStyle = '#e5f4a5';
      mctx.fill();
      mctx.strokeStyle = 'rgba(10, 17, 12, 0.9)';
      mctx.lineWidth = Math.max(1.5, size / 180);
      mctx.stroke();
    }
  }
}
