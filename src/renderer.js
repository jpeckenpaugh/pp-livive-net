import {
  WORLD_SIZE,
  TILE_TYPES,
  TERRAIN_COLORS,
  terrainColorsFor,
  mulberry32,
  hashString
} from './world.js';
import { drawAvatar, getAvatarImage, loadAvatarImage } from './avatar.js';
import { shouldMirror, UP } from './facing.js';
import { getAnimationProfile } from './animation.js';
import { composeRenderTransform, resolveFx } from './effects.js';
import { isMushroomHidden, isMushroomScenery } from './forage.js';
import {
  homeItem,
  homeItemSize,
  homePoseAnchor,
  itemColors,
  itemTierAccent
} from './home_items.js';
import { propRenderMeta, propTiles } from './location_props.js';
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

export function makeTileTextures(colors = TERRAIN_COLORS) {
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
      ctx.fillStyle = colors[type] || TERRAIN_COLORS[type];
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

      if (type === 'home-floor') {
        // Wide wooden boards laid across the room.
        const boards = 4;
        const boardHeight = size / boards;
        for (let i = 0; i < boards; i++) {
          ctx.fillStyle = i % 2 === 0
            ? 'rgba(255, 231, 190, 0.07)'
            : 'rgba(58, 36, 20, 0.08)';
          ctx.fillRect(0, i * boardHeight, size, boardHeight);
          ctx.strokeStyle = 'rgba(58, 38, 22, 0.38)';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(0, i * boardHeight + boardHeight);
          ctx.lineTo(size, i * boardHeight + boardHeight);
          ctx.stroke();
          // One staggered end joint per board keeps the grain from reading as stripes.
          const joint = (i % 2 === 0 ? 0.28 : 0.68) * size;
          ctx.beginPath();
          ctx.moveTo(joint, i * boardHeight);
          ctx.lineTo(joint, i * boardHeight + boardHeight);
          ctx.stroke();
        }
        for (let i = 0; i < 12; i++) {
          ctx.fillStyle = 'rgba(72, 48, 28, 0.22)';
          ctx.fillRect(random() * size, random() * size, 6 + random() * 14, 1);
        }
      }

      if (type === 'home-wall') {
        // Offset brick courses so a wall run never looks like a plain colour block.
        const rows = 4;
        const brickHeight = size / rows;
        const brickWidth = size / 3;
        for (let row = 0; row < rows; row++) {
          const offset = row % 2 === 0 ? 0 : -brickWidth / 2;
          for (let col = -1; col <= 3; col++) {
            const bx = col * brickWidth + offset + 2;
            const by = row * brickHeight + 2;
            ctx.fillStyle = random() > 0.5
              ? 'rgba(255, 239, 214, 0.08)'
              : 'rgba(24, 18, 14, 0.12)';
            ctx.fillRect(bx, by, brickWidth - 4, brickHeight - 4);
          }
        }
        ctx.strokeStyle = 'rgba(28, 22, 18, 0.35)';
        ctx.lineWidth = 2;
        for (let row = 1; row < rows; row++) {
          ctx.beginPath();
          ctx.moveTo(0, (size * row) / rows);
          ctx.lineTo(size, (size * row) / rows);
          ctx.stroke();
        }
      }

      ctx.strokeStyle = 'rgba(232, 245, 223, 0.06)';
      ctx.lineWidth = 2;
      ctx.strokeRect(1, 1, size - 2, size - 2);
      textures[type].push(canvas);
    }
  }

  return textures;
}

/* ------------------------------------------------------------------------ *
 * Home furniture shapes. Each helper draws inside a padded footprint box in
 * world pixels, using the loaded item palette. The dispatcher keys on the
 * data-file `shape` so a new item type is data plus one function.
 * ------------------------------------------------------------------------ */

const ITEM_SHADOW = 'rgba(8, 14, 9, 0.3)';

function itemBounds(entry) {
  const size = homeItemSize(entry?.itemId, entry?.rot);
  if (!size) return null;
  return {
    left: entry.x * TILE,
    top: entry.y * TILE,
    right: (entry.x + size.w) * TILE,
    bottom: (entry.y + size.h) * TILE,
    width: size.w * TILE,
    height: size.h * TILE
  };
}

function itemPad(bounds) {
  const inset = TILE * 0.1;
  return {
    left: bounds.left + inset,
    right: bounds.right - inset,
    top: bounds.top + inset,
    bottom: bounds.bottom - inset,
    width: Math.max(1, bounds.width - inset * 2),
    height: Math.max(1, bounds.height - inset * 2),
    baseY: bounds.bottom - TILE * 0.08
  };
}

function roundRectPath(ctx, x, y, w, h, radius) {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

function fillRoundRect(ctx, x, y, w, h, radius, color) {
  roundRectPath(ctx, x, y, w, h, radius);
  ctx.fillStyle = color;
  ctx.fill();
}

function strokeRoundRect(ctx, x, y, w, h, radius, color, lineWidth = 2) {
  roundRectPath(ctx, x, y, w, h, radius);
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.stroke();
}

function itemShadow(ctx, box) {
  ctx.save();
  ctx.globalAlpha = 0.55;
  ctx.fillStyle = ITEM_SHADOW;
  ctx.beginPath();
  ctx.ellipse(
    (box.left + box.right) / 2,
    box.baseY + TILE * 0.02,
    box.width * 0.44,
    TILE * 0.12,
    0,
    0,
    Math.PI * 2
  );
  ctx.fill();
  ctx.restore();
}

function drawCouch(ctx, box, colors) {
  itemShadow(ctx, box);
  const backHeight = TILE * 0.58;
  const seatY = box.baseY - TILE * 0.36;
  fillRoundRect(ctx, box.left, box.baseY - backHeight, box.width, backHeight, 6, colors.trim);
  fillRoundRect(ctx, box.left + TILE * 0.02, box.baseY - TILE * 0.46, box.width - TILE * 0.04, TILE * 0.34, 5, colors.base);
  const cushions = Math.max(2, Math.round(box.width / (TILE * 0.85)));
  const cushionWidth = (box.width - TILE * 0.04) / cushions;
  for (let index = 0; index < cushions; index += 1) {
    fillRoundRect(
      ctx,
      box.left + TILE * 0.02 + index * cushionWidth + 2,
      seatY,
      cushionWidth - 4,
      TILE * 0.26,
      4,
      colors.accent
    );
  }
  fillRoundRect(ctx, box.left, box.baseY - TILE * 0.5, TILE * 0.13, TILE * 0.42, 4, colors.accent);
  fillRoundRect(ctx, box.right - TILE * 0.13, box.baseY - TILE * 0.5, TILE * 0.13, TILE * 0.42, 4, colors.accent);
  fillRoundRect(ctx, box.left + TILE * 0.1, box.baseY - TILE * 0.06, TILE * 0.1, TILE * 0.08, 2, colors.trim);
  fillRoundRect(ctx, box.right - TILE * 0.2, box.baseY - TILE * 0.06, TILE * 0.1, TILE * 0.08, 2, colors.trim);
}

function drawArmchair(ctx, box, colors) {
  itemShadow(ctx, box);
  const backHeight = TILE * 0.5;
  fillRoundRect(ctx, box.left, box.baseY - backHeight, box.width, backHeight, 6, colors.trim);
  fillRoundRect(ctx, box.left + 2, box.baseY - TILE * 0.42, box.width - 4, TILE * 0.3, 5, colors.base);
  fillRoundRect(ctx, box.left + TILE * 0.16, box.baseY - TILE * 0.38, box.width - TILE * 0.32, TILE * 0.2, 4, colors.accent);
  fillRoundRect(ctx, box.left, box.baseY - TILE * 0.44, TILE * 0.12, TILE * 0.36, 4, colors.accent);
  fillRoundRect(ctx, box.right - TILE * 0.12, box.baseY - TILE * 0.44, TILE * 0.12, TILE * 0.36, 4, colors.accent);
  fillRoundRect(ctx, box.left + TILE * 0.12, box.baseY - TILE * 0.05, TILE * 0.08, TILE * 0.07, 2, colors.trim);
  fillRoundRect(ctx, box.right - TILE * 0.2, box.baseY - TILE * 0.05, TILE * 0.08, TILE * 0.07, 2, colors.trim);
}

function drawCoffeeTable(ctx, box, colors) {
  itemShadow(ctx, box);
  const topY = box.baseY - TILE * 0.52;
  fillRoundRect(ctx, box.left + TILE * 0.08, topY + TILE * 0.14, TILE * 0.07, TILE * 0.42, 2, colors.trim);
  fillRoundRect(ctx, box.right - TILE * 0.15, topY + TILE * 0.14, TILE * 0.07, TILE * 0.42, 2, colors.trim);
  fillRoundRect(ctx, box.left, topY, box.width, TILE * 0.16, 5, colors.accent);
  fillRoundRect(ctx, box.left + 3, topY + TILE * 0.14, box.width - 6, TILE * 0.1, 3, colors.base);
}

function drawTv(ctx, box, colors) {
  itemShadow(ctx, box);
  const centerX = (box.left + box.right) / 2;
  const bodyWidth = Math.min(box.width * 0.88, TILE * 0.9);
  const bodyHeight = TILE * 0.76;
  const bodyX = centerX - bodyWidth / 2;
  const bodyY = box.baseY - TILE * 0.12 - bodyHeight;
  fillRoundRect(ctx, centerX - TILE * 0.2, box.baseY - TILE * 0.14, TILE * 0.4, TILE * 0.1, 3, colors.trim);
  fillRoundRect(ctx, bodyX, bodyY, bodyWidth, bodyHeight, 6, colors.base);
  fillRoundRect(ctx, bodyX + 4, bodyY + 4, bodyWidth - 16, bodyHeight - 10, 4, colors.accent);
  ctx.save();
  ctx.globalAlpha = 0.22;
  ctx.strokeStyle = colors.trim;
  ctx.lineWidth = 1;
  for (let line = 1; line <= 3; line += 1) {
    const y = bodyY + 4 + ((bodyHeight - 10) * line) / 4;
    ctx.beginPath();
    ctx.moveTo(bodyX + 5, y);
    ctx.lineTo(bodyX + bodyWidth - 13, y);
    ctx.stroke();
  }
  ctx.restore();
  ctx.beginPath();
  ctx.arc(bodyX + bodyWidth - 7, bodyY + bodyHeight * 0.36, 1.8, 0, Math.PI * 2);
  ctx.fillStyle = colors.trim;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(bodyX + bodyWidth - 7, bodyY + bodyHeight * 0.6, 1.8, 0, Math.PI * 2);
  ctx.fill();
}

function drawRadio(ctx, box, colors) {
  itemShadow(ctx, box);
  const centerX = (box.left + box.right) / 2;
  const bodyWidth = Math.min(box.width * 0.72, TILE * 0.66);
  const bodyHeight = TILE * 0.46;
  const bodyX = centerX - bodyWidth / 2;
  const bodyY = box.baseY - TILE * 0.1 - bodyHeight;
  ctx.strokeStyle = colors.trim;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(bodyX + bodyWidth * 0.2, bodyY + 2);
  ctx.lineTo(bodyX + bodyWidth * 0.05, bodyY - TILE * 0.28);
  ctx.stroke();
  fillRoundRect(ctx, bodyX, bodyY, bodyWidth, bodyHeight, 5, colors.base);
  ctx.beginPath();
  ctx.arc(bodyX + bodyWidth * 0.3, bodyY + bodyHeight * 0.52, bodyHeight * 0.28, 0, Math.PI * 2);
  ctx.fillStyle = colors.trim;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(bodyX + bodyWidth * 0.3, bodyY + bodyHeight * 0.52, bodyHeight * 0.16, 0, Math.PI * 2);
  ctx.fillStyle = colors.accent;
  ctx.fill();
  fillRoundRect(ctx, bodyX + bodyWidth * 0.62, bodyY + bodyHeight * 0.22, bodyWidth * 0.24, bodyHeight * 0.16, 2, colors.accent);
  fillRoundRect(ctx, bodyX + bodyWidth * 0.62, bodyY + bodyHeight * 0.5, bodyWidth * 0.24, bodyHeight * 0.16, 2, colors.trim);
}

function drawFloorLamp(ctx, box, colors) {
  itemShadow(ctx, box);
  const centerX = (box.left + box.right) / 2;
  const topY = box.baseY - TILE * 1.14;
  ctx.save();
  ctx.globalAlpha = 0.22;
  ctx.fillStyle = colors.accent;
  ctx.beginPath();
  ctx.ellipse(centerX, topY + TILE * 0.18, TILE * 0.34, TILE * 0.3, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.strokeStyle = colors.trim;
  ctx.lineWidth = Math.max(2, TILE * 0.045);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(centerX, box.baseY - TILE * 0.02);
  ctx.lineTo(centerX, topY + TILE * 0.26);
  ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(centerX, box.baseY, TILE * 0.16, TILE * 0.05, 0, 0, Math.PI * 2);
  ctx.fillStyle = colors.trim;
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(centerX - TILE * 0.2, topY + TILE * 0.26);
  ctx.lineTo(centerX + TILE * 0.2, topY + TILE * 0.26);
  ctx.lineTo(centerX + TILE * 0.13, topY);
  ctx.lineTo(centerX - TILE * 0.13, topY);
  ctx.closePath();
  ctx.fillStyle = colors.accent;
  ctx.fill();
  ctx.strokeStyle = colors.trim;
  ctx.lineWidth = 2;
  ctx.stroke();
}

function drawBookshelf(ctx, box, colors) {
  itemShadow(ctx, box);
  const top = box.baseY - Math.min(box.height * 0.92, TILE * 1.82);
  fillRoundRect(ctx, box.left, top, box.width, box.baseY - top, 4, colors.trim);
  fillRoundRect(ctx, box.left + 3, top + 3, box.width - 6, box.baseY - top - 6, 2, colors.base);
  const shelves = 3;
  const shelfHeight = (box.baseY - top - 8) / shelves;
  for (let row = 0; row < shelves; row += 1) {
    const shelfY = top + 4 + row * shelfHeight;
    ctx.beginPath();
    ctx.moveTo(box.left + 4, shelfY + shelfHeight - 2);
    ctx.lineTo(box.right - 4, shelfY + shelfHeight - 2);
    ctx.strokeStyle = colors.trim;
    ctx.lineWidth = 2;
    ctx.stroke();
    const bookWidth = (box.width - 12) / 4;
    for (let book = 0; book < 4; book += 1) {
      const height = shelfHeight * (0.42 + ((row + book) % 3) * 0.12);
      fillRoundRect(
        ctx,
        box.left + 6 + book * bookWidth,
        shelfY + shelfHeight - 3 - height,
        bookWidth - 2,
        height,
        1,
        book % 2 ? colors.accent : colors.trim
      );
    }
  }
}

function drawPlant(ctx, box, colors) {
  itemShadow(ctx, box);
  const centerX = (box.left + box.right) / 2;
  const potTop = box.baseY - TILE * 0.34;
  ctx.beginPath();
  ctx.moveTo(centerX - TILE * 0.17, potTop);
  ctx.lineTo(centerX + TILE * 0.17, potTop);
  ctx.lineTo(centerX + TILE * 0.13, box.baseY - TILE * 0.02);
  ctx.lineTo(centerX - TILE * 0.13, box.baseY - TILE * 0.02);
  ctx.closePath();
  ctx.fillStyle = colors.accent;
  ctx.fill();
  ctx.strokeStyle = colors.trim;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.strokeStyle = colors.trim;
  ctx.beginPath();
  ctx.moveTo(centerX, potTop);
  ctx.lineTo(centerX, potTop - TILE * 0.34);
  ctx.stroke();
  const leaves = [
    { dx: -0.18, dy: -0.5, rx: 0.19, ry: 0.11, angle: -0.5, color: colors.base },
    { dx: 0.17, dy: -0.44, rx: 0.19, ry: 0.11, angle: 0.5, color: colors.base },
    { dx: -0.04, dy: -0.66, rx: 0.14, ry: 0.2, angle: -0.15, color: colors.trim },
    { dx: 0.1, dy: -0.6, rx: 0.14, ry: 0.12, angle: 0.9, color: colors.base }
  ];
  for (const leaf of leaves) {
    ctx.beginPath();
    ctx.ellipse(
      centerX + TILE * leaf.dx,
      potTop + TILE * leaf.dy,
      TILE * leaf.rx,
      TILE * leaf.ry,
      leaf.angle,
      0,
      Math.PI * 2
    );
    ctx.fillStyle = leaf.color;
    ctx.fill();
  }
}

function drawFridge(ctx, box, colors) {
  itemShadow(ctx, box);
  const width = Math.min(box.width * 0.72, TILE * 0.7);
  const height = TILE * 1.36;
  const x = (box.left + box.right) / 2 - width / 2;
  const y = box.baseY - height;
  fillRoundRect(ctx, x, y, width, height, 5, colors.base);
  fillRoundRect(ctx, x + 2, y + 2, width - 4, height * 0.32, 3, colors.accent);
  ctx.beginPath();
  ctx.moveTo(x + 2, y + height * 0.36);
  ctx.lineTo(x + width - 2, y + height * 0.36);
  ctx.strokeStyle = colors.trim;
  ctx.lineWidth = 2;
  ctx.stroke();
  fillRoundRect(ctx, x + width - TILE * 0.09, y + TILE * 0.08, TILE * 0.035, TILE * 0.2, 2, colors.trim);
  fillRoundRect(ctx, x + width - TILE * 0.09, y + height * 0.44, TILE * 0.035, TILE * 0.26, 2, colors.trim);
}

function drawStove(ctx, box, colors) {
  itemShadow(ctx, box);
  const width = Math.min(box.width * 0.8, TILE * 0.76);
  const height = TILE * 0.82;
  const x = (box.left + box.right) / 2 - width / 2;
  const y = box.baseY - height;
  fillRoundRect(ctx, x, y, width, height, 4, colors.base);
  fillRoundRect(ctx, x + 2, y + 2, width - 4, TILE * 0.16, 3, colors.accent);
  for (let index = 0; index < 4; index += 1) {
    const cx = x + width * (0.3 + (index % 2) * 0.4);
    const cy = y + TILE * 0.16 * (index < 2 ? 0.45 : 1.05);
    ctx.beginPath();
    ctx.arc(cx, cy, TILE * 0.06, 0, Math.PI * 2);
    ctx.strokeStyle = colors.trim;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  fillRoundRect(ctx, x + 4, y + TILE * 0.26, width - 8, height - TILE * 0.32, 3, colors.trim);
  ctx.save();
  ctx.globalAlpha = 0.35;
  fillRoundRect(ctx, x + 7, y + TILE * 0.3, width - 14, height - TILE * 0.4, 2, colors.accent);
  ctx.restore();
  ctx.beginPath();
  ctx.moveTo(x + 8, y + TILE * 0.26);
  ctx.lineTo(x + width - 8, y + TILE * 0.26);
  ctx.strokeStyle = colors.accent;
  ctx.lineWidth = 2;
  ctx.stroke();
}

function drawCounter(ctx, box, colors) {
  itemShadow(ctx, box);
  const height = TILE * 0.76;
  const y = box.baseY - height;
  fillRoundRect(ctx, box.left, y, box.width, height, 3, colors.base);
  fillRoundRect(ctx, box.left - 2, y - TILE * 0.04, box.width + 4, TILE * 0.14, 3, colors.accent);
  const doors = Math.max(2, Math.round(box.width / TILE));
  const doorWidth = box.width / doors;
  for (let index = 0; index < doors; index += 1) {
    strokeRoundRect(
      ctx,
      box.left + index * doorWidth + 3,
      y + TILE * 0.16,
      doorWidth - 6,
      height - TILE * 0.2,
      2,
      colors.trim,
      1.5
    );
    ctx.beginPath();
    ctx.arc(box.left + (index + 1) * doorWidth - 6, y + height * 0.52, 1.6, 0, Math.PI * 2);
    ctx.fillStyle = colors.trim;
    ctx.fill();
  }
}

function drawDiningTable(ctx, box, colors) {
  itemShadow(ctx, box);
  const topX = box.left + TILE * 0.1;
  const topW = box.width - TILE * 0.2;
  const topY = box.top + TILE * 0.1;
  const topH = Math.max(TILE * 0.5, box.height - TILE * 0.5);
  const legTop = topY + topH - TILE * 0.06;
  const legHeight = Math.max(TILE * 0.12, box.baseY - legTop + TILE * 0.06);
  fillRoundRect(ctx, topX + TILE * 0.12, legTop, TILE * 0.11, legHeight, 2, colors.trim);
  fillRoundRect(ctx, topX + topW - TILE * 0.23, legTop, TILE * 0.11, legHeight, 2, colors.trim);
  fillRoundRect(ctx, topX, topY, topW, topH, 8, colors.accent);
  strokeRoundRect(ctx, topX, topY, topW, topH, 8, colors.trim, 2);
  ctx.save();
  ctx.globalAlpha = 0.22;
  ctx.strokeStyle = colors.trim;
  ctx.lineWidth = 1.5;
  for (let line = 1; line <= 2; line += 1) {
    const y = topY + (topH * line) / 3;
    ctx.beginPath();
    ctx.moveTo(topX + 6, y);
    ctx.lineTo(topX + topW - 6, y);
    ctx.stroke();
  }
  ctx.restore();
  ctx.beginPath();
  ctx.ellipse(
    topX + topW / 2,
    topY + topH / 2,
    TILE * 0.26,
    TILE * 0.12,
    0,
    0,
    Math.PI * 2
  );
  ctx.fillStyle = colors.base;
  ctx.fill();
  ctx.strokeStyle = colors.trim;
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

function drawChair(ctx, box, colors) {
  itemShadow(ctx, box);
  const centerX = (box.left + box.right) / 2;
  const seatWidth = Math.min(box.width * 0.62, TILE * 0.6);
  const seatY = box.baseY - TILE * 0.42;
  fillRoundRect(ctx, centerX - seatWidth / 2, box.baseY - TILE * 0.62, seatWidth, TILE * 0.2, 4, colors.trim);
  fillRoundRect(ctx, centerX - seatWidth / 2, seatY, seatWidth, TILE * 0.2, 4, colors.base);
  fillRoundRect(ctx, centerX - seatWidth / 2, box.baseY - TILE * 0.63, seatWidth, TILE * 0.1, 3, colors.accent);
  fillRoundRect(ctx, centerX - seatWidth / 2 + 2, seatY + TILE * 0.18, TILE * 0.07, TILE * 0.2, 2, colors.trim);
  fillRoundRect(ctx, centerX + seatWidth / 2 - TILE * 0.09, seatY + TILE * 0.18, TILE * 0.07, TILE * 0.2, 2, colors.trim);
}

function drawBed(ctx, box, colors) {
  itemShadow(ctx, box);
  fillRoundRect(ctx, box.left, box.top + TILE * 0.08, box.width, box.height - TILE * 0.16, 6, colors.trim);
  fillRoundRect(ctx, box.left + 3, box.top + TILE * 0.16, box.width - 6, box.height - TILE * 0.3, 5, colors.accent);
  fillRoundRect(ctx, box.left + 2, box.top + TILE * 0.14, box.width - 4, TILE * 0.16, 4, colors.trim);
  const pillowWidth = (box.width - TILE * 0.42) / 2;
  fillRoundRect(ctx, box.left + TILE * 0.16, box.top + TILE * 0.32, pillowWidth, TILE * 0.34, 6, colors.accent);
  fillRoundRect(ctx, box.left + TILE * 0.26 + pillowWidth, box.top + TILE * 0.32, pillowWidth, TILE * 0.34, 6, colors.accent);
  fillRoundRect(
    ctx,
    box.left + 3,
    box.top + TILE * 0.78,
    box.width - 6,
    box.height - TILE * 0.92,
    4,
    colors.base
  );
  ctx.save();
  ctx.globalAlpha = 0.25;
  ctx.beginPath();
  ctx.moveTo(box.left + 4, box.top + TILE * 0.8);
  ctx.lineTo(box.right - 4, box.top + TILE * 0.8);
  ctx.strokeStyle = colors.accent;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
}

function drawNightstand(ctx, box, colors) {
  itemShadow(ctx, box);
  const width = Math.min(box.width * 0.72, TILE * 0.68);
  const height = TILE * 0.56;
  const x = (box.left + box.right) / 2 - width / 2;
  const y = box.baseY - height;
  fillRoundRect(ctx, x, y, width, height, 3, colors.base);
  fillRoundRect(ctx, x - 1, y - TILE * 0.03, width + 2, TILE * 0.08, 2, colors.accent);
  strokeRoundRect(ctx, x + 4, y + TILE * 0.12, width - 8, height - TILE * 0.18, 2, colors.trim, 1.5);
  ctx.beginPath();
  ctx.arc(x + width / 2, y + height * 0.52, 1.8, 0, Math.PI * 2);
  ctx.fillStyle = colors.accent;
  ctx.fill();
}

function drawDresser(ctx, box, colors) {
  itemShadow(ctx, box);
  const height = TILE * 0.62;
  const y = box.baseY - height;
  fillRoundRect(ctx, box.left, y, box.width, height, 3, colors.base);
  fillRoundRect(ctx, box.left - 1, y - TILE * 0.04, box.width + 2, TILE * 0.1, 2, colors.accent);
  const drawers = Math.max(2, Math.round(box.width / TILE));
  const drawerWidth = box.width / drawers;
  for (let index = 0; index < drawers; index += 1) {
    strokeRoundRect(
      ctx,
      box.left + index * drawerWidth + 4,
      y + TILE * 0.14,
      drawerWidth - 8,
      height - TILE * 0.2,
      2,
      colors.trim,
      1.5
    );
    ctx.beginPath();
    ctx.arc(box.left + (index + 0.5) * drawerWidth, y + height * 0.55, 1.8, 0, Math.PI * 2);
    ctx.fillStyle = colors.accent;
    ctx.fill();
  }
}

function drawPiano(ctx, box, colors) {
  itemShadow(ctx, box);
  const bodyHeight = TILE * 0.86;
  const bodyY = box.baseY - bodyHeight;
  fillRoundRect(ctx, box.left, bodyY, box.width, bodyHeight, 5, colors.base);
  fillRoundRect(ctx, box.left + 3, bodyY + 3, box.width - 6, bodyHeight - 6, 3, colors.trim);
  // Lid, music ledge, and the keys along the front edge.
  fillRoundRect(ctx, box.left + TILE * 0.08, bodyY + TILE * 0.08, box.width - TILE * 0.16, TILE * 0.2, 3, colors.accent);
  fillRoundRect(ctx, box.left + TILE * 0.05, bodyY + TILE * 0.3, box.width - TILE * 0.1, TILE * 0.12, 2, colors.base);
  const keysY = box.baseY - TILE * 0.3;
  fillRoundRect(ctx, box.left + TILE * 0.04, keysY, box.width - TILE * 0.08, TILE * 0.22, 3, colors.accent);
  ctx.save();
  ctx.fillStyle = colors.trim;
  const keyCount = Math.max(6, Math.round((box.width - TILE * 0.1) / (TILE * 0.11)));
  for (let index = 1; index < keyCount; index += 1) {
    const x = box.left + TILE * 0.04 + (index * (box.width - TILE * 0.08)) / keyCount;
    ctx.fillRect(x, keysY + 1, Math.max(1, TILE * 0.018), TILE * 0.13);
  }
  ctx.restore();
  fillRoundRect(ctx, box.left + TILE * 0.06, box.baseY - TILE * 0.06, TILE * 0.1, TILE * 0.06, 2, colors.trim);
  fillRoundRect(ctx, box.right - TILE * 0.16, box.baseY - TILE * 0.06, TILE * 0.1, TILE * 0.06, 2, colors.trim);
}

function drawAquarium(ctx, box, colors) {
  itemShadow(ctx, box);
  const standHeight = TILE * 0.16;
  const standY = box.baseY - standHeight;
  fillRoundRect(ctx, box.left + TILE * 0.08, standY, box.width - TILE * 0.16, standHeight, 3, colors.trim);
  const tankHeight = TILE * 0.74;
  const tankY = standY - tankHeight;
  const tankX = box.left + TILE * 0.06;
  const tankW = box.width - TILE * 0.12;
  fillRoundRect(ctx, tankX, tankY, tankW, tankHeight, 4, colors.base);
  ctx.save();
  ctx.globalAlpha = 0.55;
  fillRoundRect(ctx, tankX + 3, tankY + 3, tankW - 6, tankHeight - 6, 3, colors.accent);
  ctx.restore();
  // Two little fish and a bubble trail.
  ctx.fillStyle = colors.trim;
  for (const fish of [
    { dx: 0.3, dy: 0.58, w: 0.12 },
    { dx: 0.62, dy: 0.38, w: 0.1 }
  ]) {
    ctx.beginPath();
    ctx.ellipse(tankX + tankW * fish.dx, tankY + tankHeight * fish.dy, TILE * fish.w, TILE * 0.05, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.strokeStyle = colors.accent;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(tankX + tankW * 0.2, tankY + tankHeight * 0.7);
  ctx.lineTo(tankX + tankW * 0.2, tankY + tankHeight * 0.45);
  ctx.stroke();
  strokeRoundRect(ctx, tankX, tankY, tankW, tankHeight, 4, colors.trim, 2);
}

function drawWallClock(ctx, box, colors) {
  itemShadow(ctx, box);
  const centerX = (box.left + box.right) / 2;
  const caseWidth = Math.min(box.width * 0.56, TILE * 0.54);
  const caseHeight = TILE * 1.44;
  const caseX = centerX - caseWidth / 2;
  const caseY = box.baseY - caseHeight;
  fillRoundRect(ctx, caseX, caseY, caseWidth, caseHeight, caseWidth * 0.24, colors.base);
  strokeRoundRect(ctx, caseX + 2, caseY + 2, caseWidth - 4, caseHeight - 4, caseWidth * 0.2, colors.trim, 1.5);
  const faceRadius = caseWidth * 0.34;
  const faceX = centerX;
  const faceY = caseY + caseWidth * 0.44;
  ctx.beginPath();
  ctx.arc(faceX, faceY, faceRadius, 0, Math.PI * 2);
  ctx.fillStyle = colors.accent;
  ctx.fill();
  ctx.strokeStyle = colors.trim;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.strokeStyle = colors.trim;
  ctx.lineWidth = Math.max(1.5, TILE * 0.025);
  ctx.beginPath();
  ctx.moveTo(faceX, faceY);
  ctx.lineTo(faceX, faceY - faceRadius * 0.55);
  ctx.moveTo(faceX, faceY);
  ctx.lineTo(faceX + faceRadius * 0.45, faceY + faceRadius * 0.2);
  ctx.stroke();
  fillRoundRect(ctx, centerX - caseWidth * 0.12, caseY + caseHeight - TILE * 0.28, caseWidth * 0.24, TILE * 0.5, 3, colors.trim);
  fillRoundRect(ctx, caseX - 2, box.baseY - TILE * 0.08, caseWidth + 4, TILE * 0.08, 2, colors.trim);
}

function drawGenericFurniture(ctx, box, colors) {
  itemShadow(ctx, box);
  fillRoundRect(ctx, box.left, box.baseY - TILE * 0.6, box.width, TILE * 0.6, 4, colors.base);
  fillRoundRect(ctx, box.left, box.baseY - TILE * 0.64, box.width, TILE * 0.12, 3, colors.accent);
}

function drawRugShape(ctx, bounds, colors) {
  const inset = TILE * 0.08;
  const x = bounds.left + inset;
  const y = bounds.top + inset;
  const w = bounds.width - inset * 2;
  const h = bounds.height - inset * 2;
  fillRoundRect(ctx, x, y, w, h, TILE * 0.26, colors.base);
  strokeRoundRect(ctx, x + 2, y + 2, w - 4, h - 4, TILE * 0.24, colors.accent, Math.max(1.5, TILE * 0.035));
  ctx.save();
  ctx.globalAlpha = 0.5;
  strokeRoundRect(
    ctx,
    x + TILE * 0.24,
    y + TILE * 0.24,
    w - TILE * 0.48,
    h - TILE * 0.48,
    TILE * 0.2,
    colors.accent,
    Math.max(1, TILE * 0.025)
  );
  ctx.restore();
}

/**
 * Tier trim, drawn after the shape so it reads as a finish rather than a
 * recolour: a front-edge band for furniture, a dotted band for deluxe.
 */
function drawGroundTierAccent(ctx, bounds, entry) {
  const accent = itemTierAccent(entry?.itemId, entry?.tier);
  if (!accent) return;
  const tier = Math.max(0, Math.round(Number(entry?.tier) || 0));
  const inset = TILE * 0.3;
  const width = bounds.width - inset * 2;
  const height = bounds.height - inset * 2;
  if (width <= 0 || height <= 0) return;
  strokeRoundRect(
    ctx,
    bounds.left + inset,
    bounds.top + inset,
    width,
    height,
    TILE * 0.18,
    accent,
    Math.max(1.5, TILE * 0.03)
  );
  if (tier >= 2) {
    ctx.save();
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(bounds.left + bounds.width / 2, bounds.top + inset, Math.max(1.6, TILE * 0.04), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

function drawItemTierAccent(ctx, bounds, entry) {
  const accent = itemTierAccent(entry?.itemId, entry?.tier);
  if (!accent) return;
  const tier = Math.max(0, Math.round(Number(entry?.tier) || 0));
  const inset = TILE * 0.12;
  const thickness = Math.max(2, TILE * 0.04);
  const y = bounds.bottom - inset - thickness;
  fillRoundRect(
    ctx,
    bounds.left + inset,
    y,
    bounds.width - inset * 2,
    thickness,
    thickness / 2,
    accent
  );
  if (tier >= 2) {
    ctx.save();
    ctx.fillStyle = accent;
    for (const x of [bounds.left + inset + thickness * 0.5, bounds.right - inset - thickness * 0.5]) {
      ctx.beginPath();
      ctx.arc(x, y + thickness / 2, thickness * 0.85, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

const HOME_ITEM_SHAPES = {
  couch: drawCouch,
  armchair: drawArmchair,
  'coffee-table': drawCoffeeTable,
  tv: drawTv,
  radio: drawRadio,
  'floor-lamp': drawFloorLamp,
  bookshelf: drawBookshelf,
  plant: drawPlant,
  fridge: drawFridge,
  stove: drawStove,
  counter: drawCounter,
  'dining-table': drawDiningTable,
  chair: drawChair,
  bed: drawBed,
  nightstand: drawNightstand,
  dresser: drawDresser,
  piano: drawPiano,
  aquarium: drawAquarium,
  'wall-clock': drawWallClock
};

/* ------------------------------------------------------------------------ *
 * Location prop shapes. Same contract as furniture: draw inside a padded
 * footprint box in world pixels with a `{ base, accent, trim }` palette, so a
 * new prop type is data plus one dispatcher entry.
 * ------------------------------------------------------------------------ */

function propShadow(ctx, box) {
  ctx.save();
  ctx.globalAlpha = 0.4;
  ctx.fillStyle = ITEM_SHADOW;
  ctx.beginPath();
  ctx.ellipse(
    (box.left + box.right) / 2,
    box.baseY,
    box.width * 0.46,
    TILE * 0.13,
    0,
    0,
    Math.PI * 2
  );
  ctx.fill();
  ctx.restore();
}

function drawFountain(ctx, box, colors, time = 0) {
  propShadow(ctx, box);
  const cx = (box.left + box.right) / 2;
  const cy = box.baseY - box.height * 0.3;
  ctx.fillStyle = colors.trim;
  ctx.beginPath();
  ctx.ellipse(cx, cy, box.width * 0.47, box.height * 0.31, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = colors.base;
  ctx.beginPath();
  ctx.ellipse(cx, cy - TILE * 0.05, box.width * 0.43, box.height * 0.27, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = colors.accent;
  ctx.beginPath();
  ctx.ellipse(cx, cy - TILE * 0.07, box.width * 0.32, box.height * 0.19, 0, 0, Math.PI * 2);
  ctx.fill();
  const pulse = 0.5 + Math.sin((time || 0) * 2.4) * 0.5;
  ctx.globalAlpha = 0.55 + pulse * 0.25;
  ctx.strokeStyle = '#e8f7ff';
  ctx.lineWidth = Math.max(1.5, TILE * 0.035);
  ctx.beginPath();
  ctx.ellipse(cx, cy - TILE * 0.08, box.width * (0.12 + pulse * 0.08), box.height * 0.07, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = 1;
  fillRoundRect(ctx, cx - TILE * 0.08, cy - TILE * 0.38, TILE * 0.16, TILE * 0.32, 3, colors.base);
  ctx.fillStyle = '#dff6ff';
  ctx.beginPath();
  ctx.arc(cx, cy - TILE * 0.4, TILE * 0.08, 0, Math.PI * 2);
  ctx.fill();
}

function drawBench(ctx, box, colors) {
  propShadow(ctx, box);
  const seatY = box.baseY - TILE * 0.34;
  fillRoundRect(ctx, box.left + TILE * 0.05, seatY, box.width - TILE * 0.1, TILE * 0.14, 3, colors.base);
  fillRoundRect(ctx, box.left + TILE * 0.05, seatY - TILE * 0.24, box.width - TILE * 0.1, TILE * 0.1, 3, colors.accent);
  for (const side of [box.left + TILE * 0.12, box.right - TILE * 0.2]) {
    fillRoundRect(ctx, side, seatY + TILE * 0.1, TILE * 0.08, TILE * 0.28, 2, colors.trim);
  }
}

function drawLamp(ctx, box, colors) {
  propShadow(ctx, box);
  const cx = (box.left + box.right) / 2;
  fillRoundRect(ctx, cx - TILE * 0.04, box.baseY - TILE * 0.78, TILE * 0.08, TILE * 0.72, 2, colors.trim);
  fillRoundRect(ctx, cx - TILE * 0.14, box.baseY - TILE * 0.96, TILE * 0.28, TILE * 0.2, 4, colors.base);
  ctx.fillStyle = colors.accent;
  ctx.beginPath();
  ctx.arc(cx, box.baseY - TILE * 0.88, TILE * 0.09, 0, Math.PI * 2);
  ctx.fill();
}

function drawGate(ctx, box, colors) {
  propShadow(ctx, box);
  const left = box.left + TILE * 0.1;
  const right = box.right - TILE * 0.1;
  for (const x of [left, right - TILE * 0.14]) {
    fillRoundRect(ctx, x, box.baseY - TILE * 0.86, TILE * 0.14, TILE * 0.8, 3, colors.base);
    fillRoundRect(ctx, x - TILE * 0.03, box.baseY - TILE * 0.9, TILE * 0.2, TILE * 0.1, 3, colors.accent);
  }
  fillRoundRect(ctx, left, box.baseY - TILE * 0.72, right - left, TILE * 0.1, 2, colors.trim);
  fillRoundRect(ctx, left + TILE * 0.1, box.baseY - TILE * 0.84, right - left - TILE * 0.2, TILE * 0.06, 2, colors.accent);
}

function drawSlide(ctx, box, colors) {
  propShadow(ctx, box);
  const topY = box.top + TILE * 0.4;
  const runX = box.right - TILE * 0.12;
  ctx.strokeStyle = colors.base;
  ctx.lineWidth = Math.max(4, TILE * 0.12);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(box.left + TILE * 0.2, topY);
  ctx.quadraticCurveTo(box.left + TILE * 0.55, topY + TILE * 0.4, runX, box.baseY - TILE * 0.12);
  ctx.stroke();
  fillRoundRect(ctx, box.left + TILE * 0.08, topY - TILE * 0.28, TILE * 0.18, TILE * 0.62, 3, colors.accent);
  fillRoundRect(ctx, box.left + TILE * 0.26, box.baseY - TILE * 0.5, TILE * 0.06, TILE * 0.48, 2, colors.trim);
  fillRoundRect(ctx, box.left + TILE * 0.08, box.baseY - TILE * 0.12, TILE * 0.3, TILE * 0.08, 2, colors.trim);
}

function drawSwingFrame(ctx, box, colors) {
  propShadow(ctx, box);
  const topY = box.top + TILE * 0.32;
  ctx.strokeStyle = colors.base;
  ctx.lineWidth = Math.max(3, TILE * 0.09);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(box.left + TILE * 0.12, box.baseY);
  ctx.lineTo(box.left + TILE * 0.32, topY);
  ctx.lineTo(box.right - TILE * 0.32, topY);
  ctx.lineTo(box.right - TILE * 0.12, box.baseY);
  ctx.stroke();
  fillRoundRect(ctx, box.left + TILE * 0.28, topY, box.width - TILE * 0.56, TILE * 0.09, 3, colors.accent);
  for (const offset of [0.34, 0.62]) {
    const x = box.left + box.width * offset;
    ctx.strokeStyle = colors.trim;
    ctx.lineWidth = Math.max(1.5, TILE * 0.035);
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(x + side * TILE * 0.18, topY + TILE * 0.06);
      ctx.lineTo(x + side * TILE * 0.1, box.baseY - TILE * 0.26);
      ctx.stroke();
    }
    fillRoundRect(ctx, x - TILE * 0.2, box.baseY - TILE * 0.28, TILE * 0.4, TILE * 0.07, 3, colors.base);
  }
}

function drawAmphitheatreTier(ctx, box, colors) {
  for (let index = 0; index < 3; index += 1) {
    const inset = index * TILE * 0.08;
    fillRoundRect(
      ctx,
      box.left + inset,
      box.baseY - TILE * (0.26 + index * 0.16),
      box.width - inset * 2,
      TILE * 0.16,
      4,
      index % 2 === 0 ? colors.base : colors.accent
    );
  }
  fillRoundRect(ctx, box.left, box.baseY - TILE * 0.08, box.width, TILE * 0.08, 2, colors.trim);
}

/** A small painted sign so shop, home, library, and shells read apart. */
function drawBuildingSign(ctx, box, meta, roofY, colors) {
  const rawLabel = typeof meta?.label === 'string' ? meta.label : '';
  if (!rawLabel || rawLabel === 'Building') return;
  const style = meta?.detail?.sign || 'plaque';
  let text = style === 'plaque' ? rawLabel : rawLabel.toUpperCase();
  const maxWidth = box.width * 0.82;
  const fontSize = Math.max(8, Math.round(TILE * (style === 'painted' ? 0.2 : 0.18)));
  ctx.save();
  ctx.font = `${style === 'painted' ? 800 : 700} ${fontSize}px system-ui, -apple-system, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  let width = ctx.measureText(text).width;
  while (width > maxWidth - TILE * 0.18 && text.length > 3) {
    text = text.slice(0, -1);
    width = ctx.measureText(text).width;
  }
  const cx = (box.left + box.right) / 2;
  if (style === 'painted') {
    // Painted straight onto the facade: a dark outline keeps it legible.
    const top = roofY + TILE * 0.44;
    ctx.lineWidth = Math.max(2, fontSize * 0.28);
    ctx.strokeStyle = 'rgba(32, 22, 16, 0.55)';
    ctx.strokeText(text, cx, top + fontSize / 2);
    ctx.fillStyle = '#f4e3ae';
    ctx.fillText(text, cx, top + fontSize / 2);
    ctx.restore();
    return;
  }
  const plaqueWidth = Math.min(maxWidth, width + TILE * 0.22);
  const plaqueHeight = Math.max(11, TILE * 0.25);
  const top = roofY + TILE * 0.42;
  if (style === 'board') {
    fillRoundRect(ctx, cx - plaqueWidth / 2, top, plaqueWidth, plaqueHeight, 2, '#2f3b32');
    strokeRoundRect(
      ctx,
      cx - plaqueWidth / 2 + 1.5,
      top + 1.5,
      plaqueWidth - 3,
      plaqueHeight - 3,
      1,
      colors.trim,
      1.5
    );
  } else {
    fillRoundRect(ctx, cx - plaqueWidth / 2, top, plaqueWidth, plaqueHeight, plaqueHeight / 2, colors.trim);
  }
  ctx.fillStyle = style === 'board' ? '#f0e6cf' : '#f4e3ae';
  ctx.fillText(text, cx, top + plaqueHeight / 2 + 0.5);
  ctx.restore();
}

function drawBuilding(ctx, box, colors, time = 0, meta = null) {
  propShadow(ctx, box);
  const roofY = box.top + TILE * 0.18;
  fillRoundRect(ctx, box.left, roofY + TILE * 0.24, box.width, box.baseY - roofY - TILE * 0.24, 5, colors.base);
  ctx.fillStyle = colors.accent;
  ctx.beginPath();
  ctx.moveTo(box.left - TILE * 0.08, roofY + TILE * 0.3);
  ctx.lineTo((box.left + box.right) / 2, roofY - TILE * 0.22);
  ctx.lineTo(box.right + TILE * 0.08, roofY + TILE * 0.3);
  ctx.closePath();
  ctx.fill();
  fillRoundRect(ctx, box.left, roofY + TILE * 0.22, box.width, TILE * 0.1, 2, colors.trim);
  drawBuildingSign(ctx, box, meta, roofY, colors);

  const tileWidth = box.width / Math.max(1, meta?.size?.w || 1);
  const openings = Array.isArray(meta?.openings) ? meta.openings : [];
  // The lowest opening is the front of the placed footprint. A solid shell
  // draws a display window instead, so a facade never promises a door it lacks.
  const front = openings.reduce((best, opening) => (
    !best || opening.dy > best.dy ? opening : best
  ), null);
  if (front) {
    const doorWidth = tileWidth * 0.74;
    const centerX = box.left + (front.dx + 0.5) * tileWidth;
    const top = box.baseY - TILE * 1.02;
    fillRoundRect(ctx, centerX - doorWidth / 2 - 3, top - 3, doorWidth + 6, TILE * 1.05, 4, colors.trim);
    // A dark, walkable opening reads as a real doorway rather than a painted one.
    fillRoundRect(ctx, centerX - doorWidth / 2, top, doorWidth, TILE * 0.98, 3, '#1c1510');
    fillRoundRect(
      ctx,
      centerX - doorWidth / 2 + 2,
      top + TILE * 0.1,
      doorWidth - 4,
      TILE * 0.16,
      2,
      'rgba(240, 212, 138, 0.22)'
    );
  } else {
    const windowWidth = Math.max(TILE * 0.7, box.width * 0.22);
    const centerX = (box.left + box.right) / 2;
    fillRoundRect(
      ctx,
      centerX - windowWidth / 2,
      box.baseY - TILE * 1.0,
      windowWidth,
      TILE * 0.62,
      4,
      '#6f8f96'
    );
    fillRoundRect(
      ctx,
      centerX - windowWidth / 2 + 3,
      box.baseY - TILE * 0.98,
      windowWidth / 2 - 5,
      TILE * 0.58,
      3,
      '#8fb3ba'
    );
    fillRoundRect(ctx, centerX - 1.5, box.baseY - TILE * 1.0, 3, TILE * 0.62, 0, colors.trim);
  }

  const windowWidth = Math.max(TILE * 0.34, box.width * 0.12);
  for (const x of [box.left + TILE * 0.18, box.right - TILE * 0.18 - windowWidth]) {
    fillRoundRect(ctx, x, box.baseY - TILE * 1.34, windowWidth, TILE * 0.4, 3, '#7fa9b8');
    fillRoundRect(ctx, x + windowWidth * 0.44, box.baseY - TILE * 1.34, 2, TILE * 0.4, 0, colors.trim);
  }
}

function drawPier(ctx, box, colors) {
  const planks = Math.max(2, Math.round(box.height / (TILE * 0.42)));
  for (let index = 0; index < planks; index += 1) {
    const y = box.top + (index / planks) * box.height;
    fillRoundRect(
      ctx,
      box.left,
      y + 1,
      box.width,
      box.height / planks - 2,
      2,
      index % 2 === 0 ? colors.base : colors.accent
    );
  }
  for (const x of [box.left + box.width * 0.16, box.right - box.width * 0.16]) {
    ctx.strokeStyle = colors.trim;
    ctx.lineWidth = Math.max(2, TILE * 0.05);
    ctx.beginPath();
    ctx.moveTo(x, box.top);
    ctx.lineTo(x, box.bottom);
    ctx.stroke();
  }
}

function drawPalm(ctx, box, colors) {
  propShadow(ctx, box);
  const cx = (box.left + box.right) / 2;
  const baseY = box.baseY;
  ctx.strokeStyle = colors.base;
  ctx.lineWidth = Math.max(4, TILE * 0.1);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(cx, baseY);
  ctx.quadraticCurveTo(cx + TILE * 0.14, baseY - TILE * 0.6, cx + TILE * 0.04, baseY - TILE * 1.12);
  ctx.stroke();
  const crownY = baseY - TILE * 1.14;
  for (let index = 0; index < 6; index += 1) {
    const angle = (Math.PI * 2 * index) / 6 - Math.PI / 2;
    ctx.strokeStyle = index % 2 === 0 ? colors.accent : colors.trim;
    ctx.lineWidth = Math.max(3, TILE * 0.07);
    ctx.beginPath();
    ctx.moveTo(cx, crownY);
    ctx.quadraticCurveTo(
      cx + Math.cos(angle) * TILE * 0.34,
      crownY + Math.sin(angle) * TILE * 0.18,
      cx + Math.cos(angle) * TILE * 0.58,
      crownY + Math.sin(angle) * TILE * 0.3
    );
    ctx.stroke();
  }
}

function drawUmbrella(ctx, box, colors) {
  propShadow(ctx, box);
  const cx = (box.left + box.right) / 2;
  const baseY = box.baseY - TILE * 0.18;
  fillRoundRect(ctx, cx - TILE * 0.035, box.top + TILE * 0.42, TILE * 0.07, baseY - box.top - TILE * 0.42, 2, colors.trim);
  const radius = box.width * 0.48;
  ctx.fillStyle = colors.base;
  ctx.beginPath();
  ctx.ellipse(cx, box.top + TILE * 0.5, radius, box.height * 0.28, 0, Math.PI, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = colors.accent;
  ctx.beginPath();
  ctx.ellipse(cx, box.top + TILE * 0.5, radius * 0.62, box.height * 0.2, 0, Math.PI, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = colors.trim;
  ctx.beginPath();
  ctx.ellipse(cx, box.top + TILE * 0.52, radius, TILE * 0.05, 0, 0, Math.PI);
  ctx.fill();
}

function drawDesk(ctx, box, colors) {
  propShadow(ctx, box);
  const topY = box.baseY - TILE * 0.48;
  fillRoundRect(ctx, box.left, topY, box.width, TILE * 0.16, 3, colors.base);
  fillRoundRect(ctx, box.left + TILE * 0.08, topY + TILE * 0.16, TILE * 0.1, TILE * 0.34, 2, colors.trim);
  fillRoundRect(ctx, box.right - TILE * 0.18, topY + TILE * 0.16, TILE * 0.1, TILE * 0.34, 2, colors.trim);
  fillRoundRect(ctx, box.left + box.width * 0.42, topY - TILE * 0.08, TILE * 0.34, TILE * 0.2, 2, colors.accent);
  fillRoundRect(ctx, box.left + box.width * 0.46, topY + TILE * 0.01, TILE * 0.26, TILE * 0.02, 1, colors.trim);
}

function drawPropBookshelf(ctx, box, colors) {
  propShadow(ctx, box);
  fillRoundRect(ctx, box.left, box.top + TILE * 0.12, box.width, box.height - TILE * 0.18, 3, colors.base);
  for (let row = 0; row < 2; row += 1) {
    const shelfY = box.top + TILE * 0.24 + row * (box.height - TILE * 0.44) / 2;
    const books = 4;
    for (let index = 0; index < books; index += 1) {
      const bookW = (box.width - TILE * 0.16) / books;
      ctx.fillStyle = index % 2 === 0 ? colors.accent : colors.trim;
      ctx.fillRect(
        box.left + TILE * 0.08 + index * bookW,
        shelfY,
        bookW - 2,
        Math.max(3, (box.height - TILE * 0.5) / 2 - 4)
      );
    }
    fillRoundRect(ctx, box.left, shelfY + Math.max(3, (box.height - TILE * 0.5) / 2), box.width, 2, 1, colors.trim);
  }
}

function drawPlanter(ctx, box, colors) {
  propShadow(ctx, box);
  fillRoundRect(ctx, box.left + TILE * 0.16, box.baseY - TILE * 0.42, box.width - TILE * 0.32, TILE * 0.4, 4, colors.base);
  fillRoundRect(ctx, box.left + TILE * 0.22, box.baseY - TILE * 0.38, box.width - TILE * 0.44, TILE * 0.08, 2, colors.trim);
  for (let index = 0; index < 4; index += 1) {
    const x = box.left + box.width * (0.28 + index * 0.14);
    ctx.fillStyle = index % 2 === 0 ? colors.accent : colors.trim;
    ctx.beginPath();
    ctx.ellipse(x, box.baseY - TILE * 0.56 - (index % 2) * TILE * 0.06, TILE * 0.11, TILE * 0.18, index * 0.4, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** A flat gingham blanket: no shadow, no height, walkable ground cover. */
function drawPicnicBlanket(ctx, box, colors) {
  const cells = 4;
  const cellW = box.width / cells;
  const cellH = box.height / cells;
  for (let row = 0; row < cells; row += 1) {
    for (let col = 0; col < cells; col += 1) {
      ctx.fillStyle = (row + col) % 2 === 0 ? colors.base : colors.accent;
      ctx.fillRect(
        box.left + col * cellW,
        box.top + row * cellH,
        cellW + 0.5,
        cellH + 0.5
      );
    }
  }
  ctx.strokeStyle = colors.trim;
  ctx.lineWidth = Math.max(1, TILE * 0.03);
  ctx.strokeRect(box.left, box.top, box.width, box.height);
}

/** A flat woven rug: ground cover with a border and a simple diamond motif. */
function drawRug(ctx, box, colors) {
  const inset = TILE * 0.08;
  fillRoundRect(
    ctx,
    box.left + inset,
    box.top + inset,
    box.width - inset * 2,
    box.height - inset * 2,
    TILE * 0.12,
    colors.base
  );
  ctx.strokeStyle = colors.accent;
  ctx.lineWidth = Math.max(2, TILE * 0.05);
  ctx.strokeRect(
    box.left + inset * 2,
    box.top + inset * 2,
    box.width - inset * 4,
    box.height - inset * 4
  );
  const cx = (box.left + box.right) / 2;
  const cy = (box.top + box.bottom) / 2;
  ctx.fillStyle = colors.trim;
  ctx.beginPath();
  ctx.moveTo(cx, cy - box.height * 0.22);
  ctx.lineTo(cx + box.width * 0.22, cy);
  ctx.lineTo(cx, cy + box.height * 0.22);
  ctx.lineTo(cx - box.width * 0.22, cy);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = colors.accent;
  ctx.beginPath();
  ctx.moveTo(cx, cy - box.height * 0.11);
  ctx.lineTo(cx + box.width * 0.11, cy);
  ctx.lineTo(cx, cy + box.height * 0.11);
  ctx.lineTo(cx - box.width * 0.11, cy);
  ctx.closePath();
  ctx.fill();
}

/* ------------------------------------------------------------------------ *
 * Wave 1 interior props. Same contract: draw inside a padded footprint with a
 * `{ base, accent, trim }` palette. These cover cafés, bakeries, clinics,
 * workshops, and cottage bedrooms without new assets.
 * ------------------------------------------------------------------------ */

function drawCafeCounter(ctx, box, colors) {
  propShadow(ctx, box);
  const height = TILE * 0.82;
  const y = box.baseY - height;
  fillRoundRect(ctx, box.left, y, box.width, height, 4, colors.base);
  fillRoundRect(ctx, box.left - 3, y - TILE * 0.05, box.width + 6, TILE * 0.16, 4, colors.accent);
  const panels = Math.max(2, Math.round(box.width / TILE));
  const panelWidth = box.width / panels;
  for (let index = 0; index < panels; index += 1) {
    strokeRoundRect(
      ctx,
      box.left + index * panelWidth + 3,
      y + TILE * 0.2,
      panelWidth - 6,
      height - TILE * 0.26,
      2,
      colors.trim,
      1.5
    );
  }
  // Cup, saucer, and a little pastry dome on the counter top.
  const top = y - TILE * 0.06;
  fillRoundRect(ctx, box.left + box.width * 0.18, top - TILE * 0.13, TILE * 0.14, TILE * 0.13, 2, colors.accent);
  ctx.beginPath();
  ctx.arc(box.left + box.width * 0.25, top - TILE * 0.02, TILE * 0.09, 0, Math.PI * 2);
  ctx.fillStyle = colors.trim;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(box.left + box.width * 0.68, top - TILE * 0.05, TILE * 0.11, Math.PI, Math.PI * 2);
  ctx.fillStyle = colors.accent;
  ctx.fill();
}

function drawStool(ctx, box, colors) {
  propShadow(ctx, box);
  const cx = (box.left + box.right) / 2;
  const seatY = box.baseY - TILE * 0.34;
  ctx.strokeStyle = colors.trim;
  ctx.lineWidth = Math.max(2, TILE * 0.045);
  ctx.lineCap = 'round';
  for (const dx of [-0.14, 0.14]) {
    ctx.beginPath();
    ctx.moveTo(cx + dx * TILE, seatY + TILE * 0.06);
    ctx.lineTo(cx + dx * TILE * 1.5, box.baseY - TILE * 0.02);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(cx - TILE * 0.16, seatY + TILE * 0.26);
  ctx.lineTo(cx + TILE * 0.16, seatY + TILE * 0.26);
  ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(cx, seatY, TILE * 0.25, TILE * 0.1, 0, 0, Math.PI * 2);
  ctx.fillStyle = colors.base;
  ctx.fill();
  ctx.strokeStyle = colors.trim;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(cx, seatY - TILE * 0.02, TILE * 0.17, TILE * 0.06, 0, 0, Math.PI * 2);
  ctx.fillStyle = colors.accent;
  ctx.fill();
}

function drawCafeTable(ctx, box, colors) {
  propShadow(ctx, box);
  const cx = (box.left + box.right) / 2;
  const topY = box.baseY - TILE * 0.52;
  fillRoundRect(ctx, cx - TILE * 0.04, topY + TILE * 0.08, TILE * 0.08, TILE * 0.38, 2, colors.trim);
  fillRoundRect(ctx, cx - TILE * 0.16, box.baseY - TILE * 0.06, TILE * 0.32, TILE * 0.05, 2, colors.trim);
  ctx.beginPath();
  ctx.ellipse(cx, topY, TILE * 0.3, TILE * 0.13, 0, 0, Math.PI * 2);
  ctx.fillStyle = colors.base;
  ctx.fill();
  ctx.strokeStyle = colors.trim;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(cx, topY - TILE * 0.02, TILE * 0.22, TILE * 0.09, 0, 0, Math.PI * 2);
  ctx.fillStyle = colors.accent;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx + TILE * 0.08, topY - TILE * 0.03, TILE * 0.05, 0, Math.PI * 2);
  ctx.fillStyle = colors.trim;
  ctx.fill();
}

/** Wall-mounted café canopy, walkable floor cover with a scalloped valance. */
function drawAwning(ctx, box, colors) {
  const top = box.top + TILE * 0.16;
  const height = TILE * 0.42;
  const stripes = 6;
  const stripeWidth = box.width / stripes;
  for (let index = 0; index < stripes; index += 1) {
    ctx.fillStyle = index % 2 === 0 ? colors.base : colors.accent;
    ctx.fillRect(box.left + index * stripeWidth, top, stripeWidth + 0.5, height);
  }
  for (let index = 0; index < stripes; index += 1) {
    ctx.beginPath();
    ctx.arc(
      box.left + (index + 0.5) * stripeWidth,
      top + height,
      stripeWidth / 2,
      0,
      Math.PI
    );
    ctx.fillStyle = index % 2 === 0 ? colors.base : colors.accent;
    ctx.fill();
  }
  fillRoundRect(ctx, box.left, top - TILE * 0.05, box.width, TILE * 0.08, 2, colors.trim);
}

function drawDisplayCase(ctx, box, colors) {
  propShadow(ctx, box);
  const cabinetHeight = TILE * 0.34;
  const cabinetY = box.baseY - cabinetHeight;
  fillRoundRect(ctx, box.left, cabinetY, box.width, cabinetHeight, 3, colors.base);
  strokeRoundRect(ctx, box.left + 4, cabinetY + 4, box.width - 8, cabinetHeight - 8, 2, colors.trim, 1.5);
  const glassTop = cabinetY - TILE * 0.5;
  ctx.save();
  ctx.globalAlpha = 0.32;
  fillRoundRect(ctx, box.left + 2, glassTop, box.width - 4, TILE * 0.5, 4, colors.accent);
  ctx.restore();
  strokeRoundRect(ctx, box.left + 2, glassTop, box.width - 4, TILE * 0.5, 4, colors.trim, 2);
  for (const offset of [0.22, 0.55, 0.82]) {
    ctx.beginPath();
    ctx.ellipse(box.left + box.width * offset, cabinetY - TILE * 0.08, TILE * 0.1, TILE * 0.06, 0, 0, Math.PI * 2);
    ctx.fillStyle = colors.base;
    ctx.fill();
    ctx.strokeStyle = colors.trim;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(box.left + 4, glassTop + TILE * 0.3);
  ctx.lineTo(box.right - 4, glassTop + TILE * 0.3);
  ctx.strokeStyle = colors.trim;
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

function drawOven(ctx, box, colors) {
  propShadow(ctx, box);
  const width = Math.min(box.width * 0.92, TILE * 1.7);
  const height = TILE * 1.22;
  const x = (box.left + box.right) / 2 - width / 2;
  const y = box.baseY - height;
  fillRoundRect(ctx, x, y + TILE * 0.18, width, height - TILE * 0.18, 6, colors.base);
  ctx.beginPath();
  ctx.moveTo(x, y + TILE * 0.36);
  ctx.quadraticCurveTo((x + x + width) / 2, y - TILE * 0.08, x + width, y + TILE * 0.36);
  ctx.closePath();
  ctx.fillStyle = colors.base;
  ctx.fill();
  ctx.strokeStyle = colors.trim;
  ctx.lineWidth = 2;
  ctx.stroke();
  // Arched mouth with a banked ember glow.
  const mouthW = width * 0.46;
  const mouthH = TILE * 0.44;
  const mouthX = x + width / 2 - mouthW / 2;
  const mouthY = box.baseY - mouthH - TILE * 0.08;
  ctx.beginPath();
  ctx.moveTo(mouthX, box.baseY - TILE * 0.08);
  ctx.lineTo(mouthX, mouthY + mouthH * 0.4);
  ctx.quadraticCurveTo(mouthX + mouthW / 2, mouthY - mouthH * 0.35, mouthX + mouthW, mouthY + mouthH * 0.4);
  ctx.lineTo(mouthX + mouthW, box.baseY - TILE * 0.08);
  ctx.closePath();
  ctx.fillStyle = colors.trim;
  ctx.fill();
  ctx.save();
  ctx.globalAlpha = 0.6;
  fillRoundRect(
    ctx,
    mouthX + 4,
    box.baseY - TILE * 0.24,
    mouthW - 8,
    TILE * 0.12,
    3,
    colors.accent
  );
  ctx.restore();
  fillRoundRect(ctx, x + 4, y + TILE * 0.3, width - 8, TILE * 0.09, 2, colors.trim);
  for (let index = 0; index < 5; index += 1) {
    const brickY = y + TILE * 0.5 + index * TILE * 0.13;
    ctx.beginPath();
    ctx.moveTo(x + 3, brickY);
    ctx.lineTo(x + width - 3, brickY);
    ctx.strokeStyle = `rgba(0, 0, 0, 0.16)`;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

function drawFlourSack(ctx, box, colors) {
  propShadow(ctx, box);
  const cx = (box.left + box.right) / 2;
  const width = Math.min(box.width * 0.62, TILE * 0.6);
  const bodyTop = box.baseY - TILE * 0.58;
  ctx.beginPath();
  ctx.moveTo(cx - width * 0.32, bodyTop + TILE * 0.1);
  ctx.quadraticCurveTo(cx - width * 0.55, box.baseY - TILE * 0.18, cx - width * 0.4, box.baseY - TILE * 0.02);
  ctx.lineTo(cx + width * 0.4, box.baseY - TILE * 0.02);
  ctx.quadraticCurveTo(cx + width * 0.55, box.baseY - TILE * 0.18, cx + width * 0.32, bodyTop + TILE * 0.1);
  ctx.closePath();
  ctx.fillStyle = colors.base;
  ctx.fill();
  ctx.strokeStyle = colors.trim;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  fillRoundRect(ctx, cx - width * 0.3, bodyTop, width * 0.6, TILE * 0.1, 3, colors.accent);
  fillRoundRect(ctx, cx - width * 0.08, bodyTop + TILE * 0.02, width * 0.16, TILE * 0.06, 2, colors.trim);
  ctx.save();
  ctx.globalAlpha = 0.4;
  ctx.fillStyle = colors.accent;
  ctx.beginPath();
  ctx.ellipse(cx, box.baseY - TILE * 0.2, width * 0.26, TILE * 0.1, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawExamBed(ctx, box, colors) {
  propShadow(ctx, box);
  fillRoundRect(ctx, box.left + TILE * 0.08, box.top + TILE * 0.1, box.width - TILE * 0.16, box.height - TILE * 0.16, 5, colors.trim);
  fillRoundRect(
    ctx,
    box.left + TILE * 0.1,
    box.top + TILE * 0.16,
    box.width - TILE * 0.2,
    box.height - TILE * 0.34,
    4,
    colors.accent
  );
  fillRoundRect(ctx, box.left + TILE * 0.16, box.top + TILE * 0.22, box.width - TILE * 0.32, TILE * 0.28, 5, '#ffffff');
  fillRoundRect(
    ctx,
    box.left + TILE * 0.12,
    box.top + TILE * 0.6,
    box.width - TILE * 0.24,
    box.height - TILE * 0.76,
    4,
    colors.base
  );
  ctx.beginPath();
  ctx.moveTo(box.left + TILE * 0.1, box.baseY - TILE * 0.2);
  ctx.lineTo(box.left + TILE * 0.1, box.baseY - TILE * 0.02);
  ctx.moveTo(box.right - TILE * 0.1, box.baseY - TILE * 0.2);
  ctx.lineTo(box.right - TILE * 0.1, box.baseY - TILE * 0.02);
  ctx.strokeStyle = colors.trim;
  ctx.lineWidth = Math.max(2, TILE * 0.05);
  ctx.stroke();
}

function drawSupplyCabinet(ctx, box, colors) {
  propShadow(ctx, box);
  const height = TILE * 0.94;
  const y = box.baseY - height;
  fillRoundRect(ctx, box.left, y, box.width, height, 3, colors.base);
  fillRoundRect(ctx, box.left - 2, y - TILE * 0.04, box.width + 4, TILE * 0.1, 2, colors.accent);
  const doors = 2;
  const doorWidth = box.width / doors;
  for (let index = 0; index < doors; index += 1) {
    strokeRoundRect(
      ctx,
      box.left + index * doorWidth + 4,
      y + TILE * 0.12,
      doorWidth - 8,
      height - TILE * 0.2,
      2,
      colors.trim,
      1.5
    );
  }
  // Health cross on the left door.
  const cx = box.left + doorWidth * 0.5;
  const cy = y + height * 0.48;
  const arm = TILE * 0.045;
  const span = TILE * 0.16;
  ctx.fillStyle = colors.accent;
  ctx.fillRect(cx - arm, cy - span, arm * 2, span * 2);
  ctx.fillRect(cx - span, cy - arm, span * 2, arm * 2);
}

function drawPrivacyScreen(ctx, box, colors) {
  propShadow(ctx, box);
  const panels = 3;
  const panelWidth = box.width / panels;
  const top = box.top + TILE * 0.1;
  const height = box.height - TILE * 0.16;
  for (let index = 0; index < panels; index += 1) {
    const x = box.left + index * panelWidth;
    const lean = index % 2 === 0 ? TILE * 0.05 : -TILE * 0.05;
    ctx.beginPath();
    ctx.moveTo(x + lean, top);
    ctx.lineTo(x + panelWidth + lean, top);
    ctx.lineTo(x + panelWidth - lean, top + height);
    ctx.lineTo(x - lean, top + height);
    ctx.closePath();
    ctx.fillStyle = index % 2 === 0 ? colors.base : colors.accent;
    ctx.fill();
    ctx.strokeStyle = colors.trim;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  fillRoundRect(ctx, box.left, top, box.width, TILE * 0.05, 2, colors.trim);
}

function drawWorkbench(ctx, box, colors) {
  propShadow(ctx, box);
  const topY = box.baseY - TILE * 0.56;
  fillRoundRect(ctx, box.left, topY, box.width, TILE * 0.16, 3, colors.accent);
  fillRoundRect(ctx, box.left + TILE * 0.06, topY + TILE * 0.16, TILE * 0.1, TILE * 0.38, 2, colors.trim);
  fillRoundRect(ctx, box.right - TILE * 0.16, topY + TILE * 0.16, TILE * 0.1, TILE * 0.38, 2, colors.trim);
  // Vice on the left, saw and mallet laid across the top.
  fillRoundRect(ctx, box.left + TILE * 0.04, topY - TILE * 0.12, TILE * 0.2, TILE * 0.12, 2, colors.trim);
  fillRoundRect(ctx, box.left + TILE * 0.06, topY - TILE * 0.16, TILE * 0.05, TILE * 0.06, 1, colors.base);
  ctx.strokeStyle = colors.trim;
  ctx.lineWidth = Math.max(2, TILE * 0.035);
  ctx.beginPath();
  ctx.moveTo(box.left + box.width * 0.36, topY + TILE * 0.02);
  ctx.lineTo(box.left + box.width * 0.72, topY + TILE * 0.02);
  ctx.stroke();
  fillRoundRect(ctx, box.left + box.width * 0.7, topY - TILE * 0.06, TILE * 0.18, TILE * 0.08, 2, colors.base);
}

function drawToolRack(ctx, box, colors) {
  propShadow(ctx, box);
  const top = box.top + TILE * 0.16;
  const height = TILE * 0.72;
  fillRoundRect(ctx, box.left, top, box.width, height, 3, colors.base);
  strokeRoundRect(ctx, box.left + 4, top + 4, box.width - 8, height - 8, 2, colors.trim, 1.5);
  for (let index = 0; index < 3; index += 1) {
    const x = box.left + box.width * (0.22 + index * 0.28);
    ctx.fillStyle = colors.accent;
    if (index === 0) {
      // Hammer.
      fillRoundRect(ctx, x - TILE * 0.02, top + TILE * 0.14, TILE * 0.04, TILE * 0.34, 1, colors.trim);
      fillRoundRect(ctx, x - TILE * 0.08, top + TILE * 0.12, TILE * 0.16, TILE * 0.08, 2, colors.accent);
    } else if (index === 1) {
      // Wrench.
      ctx.strokeStyle = colors.accent;
      ctx.lineWidth = Math.max(2, TILE * 0.04);
      ctx.beginPath();
      ctx.moveTo(x, top + TILE * 0.14);
      ctx.lineTo(x, top + TILE * 0.42);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, top + TILE * 0.12, TILE * 0.06, 0, Math.PI * 1.4);
      ctx.stroke();
    } else {
      // Saw.
      ctx.beginPath();
      ctx.moveTo(x - TILE * 0.09, top + TILE * 0.16);
      ctx.lineTo(x + TILE * 0.09, top + TILE * 0.24);
      ctx.lineTo(x + TILE * 0.09, top + TILE * 0.42);
      ctx.closePath();
      ctx.fillStyle = colors.accent;
      ctx.fill();
      fillRoundRect(ctx, x - TILE * 0.11, top + TILE * 0.14, TILE * 0.05, TILE * 0.09, 2, colors.trim);
    }
  }
  for (let index = 0; index < 4; index += 1) {
    ctx.beginPath();
    ctx.arc(box.left + TILE * 0.12 + index * (box.width - TILE * 0.24) / 3, top + height - TILE * 0.08, 1.4, 0, Math.PI * 2);
    ctx.fillStyle = colors.trim;
    ctx.fill();
  }
}

function drawWardrobe(ctx, box, colors) {
  propShadow(ctx, box);
  const height = TILE * 1.7;
  const y = box.baseY - height;
  fillRoundRect(ctx, box.left, y, box.width, height, 4, colors.trim);
  fillRoundRect(ctx, box.left + 3, y + 3, box.width - 6, height - 6, 3, colors.base);
  fillRoundRect(ctx, box.left - 2, y - TILE * 0.04, box.width + 4, TILE * 0.12, 3, colors.accent);
  const doorWidth = box.width / 2;
  for (let index = 0; index < 2; index += 1) {
    strokeRoundRect(
      ctx,
      box.left + index * doorWidth + 4,
      y + TILE * 0.14,
      doorWidth - 8,
      height - TILE * 0.24,
      2,
      colors.trim,
      1.5
    );
  }
  ctx.fillStyle = colors.accent;
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.arc((box.left + box.right) / 2 + side * TILE * 0.05, y + height * 0.56, 2, 0, Math.PI * 2);
    ctx.fill();
  }
  fillRoundRect(ctx, box.left + 4, box.baseY - TILE * 0.08, box.width - 8, TILE * 0.06, 2, colors.trim);
}

function drawVanity(ctx, box, colors) {
  propShadow(ctx, box);
  const bodyHeight = TILE * 0.5;
  const y = box.baseY - bodyHeight;
  fillRoundRect(ctx, box.left, y, box.width, bodyHeight, 3, colors.base);
  fillRoundRect(ctx, box.left - 2, y - TILE * 0.04, box.width + 4, TILE * 0.1, 2, colors.accent);
  const cx = (box.left + box.right) / 2;
  // Oval mirror above the desk.
  ctx.beginPath();
  ctx.ellipse(cx, y - TILE * 0.34, box.width * 0.24, TILE * 0.27, 0, 0, Math.PI * 2);
  ctx.fillStyle = colors.trim;
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(cx, y - TILE * 0.34, box.width * 0.19, TILE * 0.22, 0, 0, Math.PI * 2);
  ctx.fillStyle = colors.accent;
  ctx.fill();
  strokeRoundRect(ctx, box.left + 4, y + TILE * 0.12, box.width - 8, bodyHeight - TILE * 0.18, 2, colors.trim, 1.5);
  ctx.beginPath();
  ctx.arc(cx, y + bodyHeight * 0.62, 1.8, 0, Math.PI * 2);
  ctx.fillStyle = colors.accent;
  ctx.fill();
}

/* ------------------------------------------------------------------------ *
 * Wave 2 street and town props. Block edges, pavements, and the plaza.
 * ------------------------------------------------------------------------ */

function drawFence(ctx, box, colors) {
  propShadow(ctx, box);
  const postWidth = TILE * 0.1;
  for (const offset of [0.05, 0.5, 0.95]) {
    const x = box.left + box.width * offset - postWidth / 2;
    fillRoundRect(ctx, x, box.baseY - TILE * 0.64, postWidth, TILE * 0.62, 2, colors.base);
    fillRoundRect(ctx, x - 1, box.baseY - TILE * 0.68, postWidth + 2, TILE * 0.08, 2, colors.accent);
  }
  for (const lift of [0.26, 0.46]) {
    fillRoundRect(
      ctx,
      box.left,
      box.baseY - TILE * lift,
      box.width,
      TILE * 0.07,
      2,
      colors.accent
    );
  }
}

function drawHedge(ctx, box, colors) {
  propShadow(ctx, box);
  const cy = box.baseY - TILE * 0.3;
  for (let index = 0; index < 6; index += 1) {
    const cx = box.left + box.width * (0.09 + index * 0.165);
    ctx.fillStyle = index % 2 === 0 ? colors.base : colors.accent;
    ctx.beginPath();
    ctx.ellipse(
      cx,
      cy + Math.sin(index * 1.7) * TILE * 0.03,
      TILE * 0.19,
      TILE * 0.3,
      index * 0.16,
      0,
      Math.PI * 2
    );
    ctx.fill();
  }
  fillRoundRect(ctx, box.left, box.baseY - TILE * 0.14, box.width, TILE * 0.12, 3, colors.trim);
  ctx.save();
  ctx.globalAlpha = 0.45;
  ctx.fillStyle = colors.accent;
  for (let index = 0; index < 4; index += 1) {
    ctx.beginPath();
    ctx.arc(box.left + box.width * (0.18 + index * 0.22), cy - TILE * 0.14, TILE * 0.035, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawBin(ctx, box, colors) {
  propShadow(ctx, box);
  const width = box.width * 0.54;
  const x = (box.left + box.right) / 2 - width / 2;
  const top = box.baseY - TILE * 0.68;
  fillRoundRect(ctx, x, top, width, TILE * 0.62, 4, colors.base);
  fillRoundRect(ctx, x - 2, top - TILE * 0.08, width + 4, TILE * 0.12, 3, colors.accent);
  fillRoundRect(ctx, x + width * 0.24, top + TILE * 0.04, width * 0.52, TILE * 0.05, 1, colors.trim);
  fillRoundRect(ctx, x + width * 0.16, top + TILE * 0.26, width * 0.68, TILE * 0.03, 1, colors.accent);
  fillRoundRect(ctx, x + width * 0.2, box.baseY - TILE * 0.08, width * 0.6, TILE * 0.05, 2, colors.trim);
}

function drawMailbox(ctx, box, colors) {
  propShadow(ctx, box);
  const cx = (box.left + box.right) / 2;
  fillRoundRect(ctx, cx - TILE * 0.035, box.baseY - TILE * 0.48, TILE * 0.07, TILE * 0.44, 2, colors.trim);
  const width = box.width * 0.66;
  const left = cx - width / 2;
  const top = box.baseY - TILE * 0.8;
  fillRoundRect(ctx, left, top, width, TILE * 0.4, TILE * 0.16, colors.base);
  fillRoundRect(ctx, left + 3, top + 4, width - 6, TILE * 0.08, 2, colors.accent);
  fillRoundRect(ctx, left + width * 0.24, top + TILE * 0.22, width * 0.52, TILE * 0.04, 1, colors.trim);
  // Raised flag on the right.
  fillRoundRect(ctx, left + width - 3, top + TILE * 0.06, TILE * 0.04, TILE * 0.2, 1, colors.trim);
  fillRoundRect(ctx, left + width - TILE * 0.12, top + TILE * 0.05, TILE * 0.14, TILE * 0.09, 1, colors.accent);
}

function drawSignpost(ctx, box, colors) {
  propShadow(ctx, box);
  const cx = (box.left + box.right) / 2;
  fillRoundRect(ctx, cx - TILE * 0.04, box.top + TILE * 0.28, TILE * 0.08, box.height - TILE * 0.32, 2, colors.trim);
  const boardH = TILE * 0.16;
  // Two arrows point opposite ways so the post reads as a junction sign.
  ctx.fillStyle = colors.accent;
  ctx.beginPath();
  ctx.moveTo(box.left + TILE * 0.06, box.top + TILE * 0.34);
  ctx.lineTo(box.right - TILE * 0.14, box.top + TILE * 0.34);
  ctx.lineTo(box.right - TILE * 0.04, box.top + TILE * 0.34 + boardH / 2);
  ctx.lineTo(box.right - TILE * 0.14, box.top + TILE * 0.34 + boardH);
  ctx.lineTo(box.left + TILE * 0.06, box.top + TILE * 0.34 + boardH);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = colors.base;
  ctx.beginPath();
  ctx.moveTo(box.right - TILE * 0.06, box.top + TILE * 0.59);
  ctx.lineTo(box.left + TILE * 0.14, box.top + TILE * 0.59);
  ctx.lineTo(box.left + TILE * 0.04, box.top + TILE * 0.59 + boardH / 2);
  ctx.lineTo(box.left + TILE * 0.14, box.top + TILE * 0.59 + boardH);
  ctx.lineTo(box.right - TILE * 0.06, box.top + TILE * 0.59 + boardH);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = colors.trim;
  for (const y of [0.4, 0.65]) {
    ctx.fillRect(box.left + TILE * 0.16, box.top + TILE * y, TILE * 0.34, TILE * 0.025);
  }
}

function drawMarketStall(ctx, box, colors) {
  propShadow(ctx, box);
  // Striped canopy.
  const top = box.top + TILE * 0.16;
  const canopyH = TILE * 0.42;
  const stripes = 6;
  const stripeW = box.width / stripes;
  for (let index = 0; index < stripes; index += 1) {
    ctx.fillStyle = index % 2 === 0 ? colors.base : colors.accent;
    ctx.fillRect(box.left + index * stripeW, top, stripeW + 0.5, canopyH);
    ctx.beginPath();
    ctx.arc(box.left + (index + 0.5) * stripeW, top + canopyH, stripeW / 2, 0, Math.PI);
    ctx.fill();
  }
  fillRoundRect(ctx, box.left - 2, top - TILE * 0.05, box.width + 4, TILE * 0.08, 2, colors.trim);
  // Corner posts and counter.
  for (const x of [box.left + TILE * 0.06, box.right - TILE * 0.12]) {
    fillRoundRect(ctx, x, top + canopyH * 0.6, TILE * 0.06, box.baseY - top - canopyH * 0.56, 2, colors.trim);
  }
  fillRoundRect(ctx, box.left + TILE * 0.05, box.baseY - TILE * 0.44, box.width - TILE * 0.1, TILE * 0.4, 3, colors.base);
  fillRoundRect(ctx, box.left + TILE * 0.02, box.baseY - TILE * 0.5, box.width - TILE * 0.04, TILE * 0.1, 2, colors.accent);
  // Baskets of produce on the counter.
  for (const offset of [0.28, 0.52, 0.76]) {
    const cx = box.left + box.width * offset;
    ctx.fillStyle = colors.trim;
    ctx.beginPath();
    ctx.ellipse(cx, box.baseY - TILE * 0.53, TILE * 0.14, TILE * 0.05, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = colors.accent;
    for (const dx of [-0.05, 0.03]) {
      ctx.beginPath();
      ctx.arc(cx + dx * TILE, box.baseY - TILE * 0.58, TILE * 0.05, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawBusStop(ctx, box, colors) {
  propShadow(ctx, box);
  const top = box.top + TILE * 0.12;
  fillRoundRect(ctx, box.left + TILE * 0.04, top, box.width - TILE * 0.18, TILE * 0.12, 3, colors.base);
  fillRoundRect(ctx, box.left + TILE * 0.02, top - TILE * 0.04, box.width - TILE * 0.14, TILE * 0.06, 2, colors.trim);
  // Glass back panel.
  ctx.save();
  ctx.globalAlpha = 0.34;
  fillRoundRect(ctx, box.left + TILE * 0.08, top + TILE * 0.12, box.width - TILE * 0.26, TILE * 0.58, 3, colors.accent);
  ctx.restore();
  for (const x of [box.left + TILE * 0.08, box.right - TILE * 0.22]) {
    fillRoundRect(ctx, x, top + TILE * 0.1, TILE * 0.05, TILE * 0.66, 2, colors.trim);
  }
  // Bench and a little timetable sign.
  fillRoundRect(ctx, box.left + TILE * 0.16, box.baseY - TILE * 0.26, box.width - TILE * 0.4, TILE * 0.08, 2, colors.base);
  fillRoundRect(ctx, box.left + TILE * 0.2, box.baseY - TILE * 0.18, TILE * 0.05, TILE * 0.14, 1, colors.trim);
  fillRoundRect(ctx, box.right - TILE * 0.2, box.baseY - TILE * 0.18, TILE * 0.05, TILE * 0.14, 1, colors.trim);
  fillRoundRect(ctx, box.right - TILE * 0.11, top + TILE * 0.12, TILE * 0.04, TILE * 0.64, 1, colors.trim);
  fillRoundRect(ctx, box.right - TILE * 0.18, top + TILE * 0.08, TILE * 0.18, TILE * 0.18, 2, colors.accent);
  fillRoundRect(ctx, box.right - TILE * 0.14, top + TILE * 0.13, TILE * 0.1, TILE * 0.03, 1, colors.base);
}

function drawStatue(ctx, box, colors) {
  propShadow(ctx, box);
  const cx = (box.left + box.right) / 2;
  fillRoundRect(ctx, box.left + TILE * 0.1, box.baseY - TILE * 0.24, box.width - TILE * 0.2, TILE * 0.22, 3, colors.trim);
  fillRoundRect(ctx, box.left + TILE * 0.2, box.baseY - TILE * 0.46, box.width - TILE * 0.4, TILE * 0.24, 2, colors.base);
  // Simple robed figure with a raised lantern.
  fillRoundRect(ctx, cx - TILE * 0.15, box.baseY - TILE * 0.98, TILE * 0.3, TILE * 0.54, 4, colors.base);
  ctx.beginPath();
  ctx.arc(cx, box.baseY - TILE * 1.06, TILE * 0.11, 0, Math.PI * 2);
  ctx.fillStyle = colors.accent;
  ctx.fill();
  ctx.strokeStyle = colors.trim;
  ctx.lineWidth = Math.max(2, TILE * 0.035);
  ctx.beginPath();
  ctx.moveTo(cx + TILE * 0.12, box.baseY - TILE * 0.9);
  ctx.lineTo(cx + TILE * 0.26, box.baseY - TILE * 1.12);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx + TILE * 0.27, box.baseY - TILE * 1.16, TILE * 0.08, 0, Math.PI * 2);
  ctx.fillStyle = colors.accent;
  ctx.fill();
  ctx.strokeStyle = colors.trim;
  ctx.stroke();
  fillRoundRect(ctx, cx - TILE * 0.2, box.baseY - TILE * 0.98, TILE * 0.4, TILE * 0.05, 2, colors.accent);
}

function drawFlowerBed(ctx, box, colors) {
  fillRoundRect(ctx, box.left + 2, box.top + 2, box.width - 4, box.height - 4, 5, colors.base);
  fillRoundRect(ctx, box.left + 6, box.top + 6, box.width - 12, box.height - 12, 4, colors.trim);
  const cols = 3;
  const rows = 3;
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const cx = box.left + box.width * ((col + 0.5) / cols);
      const cy = box.top + box.height * ((row + 0.5) / rows);
      ctx.strokeStyle = colors.accent;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(cx, cy + TILE * 0.06);
      ctx.lineTo(cx - TILE * 0.04, cy + TILE * 0.12);
      ctx.moveTo(cx, cy + TILE * 0.06);
      ctx.lineTo(cx + TILE * 0.04, cy + TILE * 0.12);
      ctx.stroke();
      ctx.fillStyle = (row + col) % 2 === 0 ? colors.accent : '#f4e3c1';
      for (let petal = 0; petal < 4; petal += 1) {
        const angle = (Math.PI / 2) * petal;
        ctx.beginPath();
        ctx.ellipse(
          cx + Math.cos(angle) * TILE * 0.045,
          cy + Math.sin(angle) * TILE * 0.045,
          TILE * 0.04,
          TILE * 0.025,
          angle,
          0,
          Math.PI * 2
        );
        ctx.fill();
      }
      ctx.fillStyle = '#f0c46a';
      ctx.beginPath();
      ctx.arc(cx, cy, TILE * 0.025, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawStringLights(ctx, box, colors) {
  const left = box.left + TILE * 0.12;
  const right = box.right - TILE * 0.12;
  const baseY = box.baseY - TILE * 0.08;
  for (const x of [left, right]) {
    fillRoundRect(ctx, x - TILE * 0.03, box.top + TILE * 0.16, TILE * 0.06, baseY - box.top - TILE * 0.16, 2, colors.trim);
  }
  const wireY = box.top + TILE * 0.28;
  ctx.strokeStyle = colors.trim;
  ctx.lineWidth = Math.max(1.5, TILE * 0.03);
  ctx.beginPath();
  ctx.moveTo(left, wireY);
  ctx.quadraticCurveTo((left + right) / 2, wireY + TILE * 0.3, right, wireY);
  ctx.stroke();
  for (let index = 1; index <= 4; index += 1) {
    const t = index / 5;
    const x = left + (right - left) * t;
    const y = wireY + Math.sin(Math.PI * t) * TILE * 0.15;
    ctx.save();
    ctx.globalAlpha = 0.28;
    ctx.fillStyle = colors.base;
    ctx.beginPath();
    ctx.arc(x, y + TILE * 0.06, TILE * 0.1, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = index % 2 === 0 ? colors.accent : colors.base;
    ctx.beginPath();
    ctx.ellipse(x, y + TILE * 0.06, TILE * 0.045, TILE * 0.06, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawNoticeBoard(ctx, box, colors) {
  propShadow(ctx, box);
  const top = box.top + TILE * 0.1;
  for (const x of [box.left + TILE * 0.14, box.right - TILE * 0.2]) {
    fillRoundRect(ctx, x, top + TILE * 0.34, TILE * 0.06, box.height - TILE * 0.4, 2, colors.trim);
  }
  fillRoundRect(ctx, box.left, top, box.width, TILE * 0.58, 3, colors.base);
  fillRoundRect(ctx, box.left + 4, top + 4, box.width - 8, TILE * 0.5, 2, colors.accent);
  // Pinned notes in a loose grid.
  const notes = [
    { dx: 0.14, dy: 0.12, w: 0.22, h: 0.2 },
    { dx: 0.42, dy: 0.1, w: 0.18, h: 0.24 },
    { dx: 0.66, dy: 0.14, w: 0.2, h: 0.18 },
    { dx: 0.2, dy: 0.42, w: 0.26, h: 0.16 },
    { dx: 0.56, dy: 0.44, w: 0.18, h: 0.14 }
  ];
  for (const note of notes) {
    fillRoundRect(
      ctx,
      box.left + box.width * note.dx,
      top + TILE * 0.58 * note.dy,
      box.width * note.w,
      TILE * note.h,
      1,
      '#f7efd8'
    );
    ctx.fillStyle = colors.trim;
    ctx.beginPath();
    ctx.arc(
      box.left + box.width * (note.dx + note.w / 2),
      top + TILE * 0.58 * note.dy + 2,
      1.5,
      0,
      Math.PI * 2
    );
    ctx.fill();
  }
}

function drawBikeRack(ctx, box, colors) {
  propShadow(ctx, box);
  const baseY = box.baseY - TILE * 0.04;
  fillRoundRect(ctx, box.left + TILE * 0.06, baseY - TILE * 0.08, box.width - TILE * 0.12, TILE * 0.07, 2, colors.trim);
  ctx.strokeStyle = colors.accent;
  ctx.lineWidth = Math.max(3, TILE * 0.07);
  ctx.lineCap = 'round';
  for (const offset of [0.28, 0.56, 0.84]) {
    const cx = box.left + box.width * offset;
    ctx.beginPath();
    ctx.arc(cx, baseY - TILE * 0.1, TILE * 0.17, Math.PI, 0);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - TILE * 0.17, baseY - TILE * 0.1);
    ctx.lineTo(cx - TILE * 0.17, baseY - TILE * 0.02);
    ctx.moveTo(cx + TILE * 0.17, baseY - TILE * 0.1);
    ctx.lineTo(cx + TILE * 0.17, baseY - TILE * 0.02);
    ctx.stroke();
  }
  ctx.fillStyle = colors.trim;
  ctx.beginPath();
  ctx.arc(box.left + box.width * 0.2, baseY - TILE * 0.22, TILE * 0.07, 0, Math.PI * 2);
  ctx.fill();
}

/* ------------------------------------------------------------------------ *
 * Wave 3 beach and leisure props: sand, boardwalk, and pier.
 * ------------------------------------------------------------------------ */

function drawDeckChair(ctx, box, colors) {
  propShadow(ctx, box);
  const left = box.left + TILE * 0.06;
  const right = box.right - TILE * 0.06;
  // Reclined frame.
  ctx.strokeStyle = colors.trim;
  ctx.lineWidth = Math.max(2, TILE * 0.045);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(left + box.width * 0.12, box.baseY - TILE * 0.52);
  ctx.lineTo(left + box.width * 0.44, box.baseY - TILE * 0.16);
  ctx.lineTo(right - box.width * 0.08, box.baseY - TILE * 0.18);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(left + box.width * 0.18, box.baseY - TILE * 0.04);
  ctx.lineTo(left + box.width * 0.18, box.baseY - TILE * 0.3);
  ctx.moveTo(right - box.width * 0.12, box.baseY - TILE * 0.04);
  ctx.lineTo(right - box.width * 0.12, box.baseY - TILE * 0.3);
  ctx.stroke();
  // Striped canvas seat.
  ctx.beginPath();
  ctx.moveTo(left + box.width * 0.16, box.baseY - TILE * 0.52);
  ctx.lineTo(left + box.width * 0.47, box.baseY - TILE * 0.2);
  ctx.lineTo(right - box.width * 0.12, box.baseY - TILE * 0.22);
  ctx.lineTo(right - box.width * 0.3, box.baseY - TILE * 0.5);
  ctx.closePath();
  ctx.fillStyle = colors.base;
  ctx.fill();
  ctx.save();
  ctx.clip();
  ctx.strokeStyle = colors.accent;
  ctx.lineWidth = Math.max(2, TILE * 0.06);
  for (let offset = -box.height; offset < box.width + box.height; offset += TILE * 0.16) {
    ctx.beginPath();
    ctx.moveTo(left + offset, box.baseY - TILE * 0.6);
    ctx.lineTo(left + offset - TILE * 0.2, box.baseY - TILE * 0.1);
    ctx.stroke();
  }
  ctx.restore();
}

function drawTowel(ctx, box, colors) {
  const inset = TILE * 0.08;
  fillRoundRect(ctx, box.left + inset, box.top + inset, box.width - inset * 2, box.height - inset * 2, 4, colors.base);
  ctx.save();
  ctx.globalAlpha = 0.85;
  for (let index = 0; index < 4; index += 1) {
    fillRoundRect(
      ctx,
      box.left + inset + (index + 0.6) * (box.width - inset * 2) / 5,
      box.top + inset * 2,
      Math.max(2, (box.width - inset * 2) * 0.07),
      box.height - inset * 4,
      1,
      colors.accent
    );
  }
  ctx.restore();
  ctx.strokeStyle = colors.trim;
  ctx.lineWidth = 1;
  for (const side of [0.06, 0.94]) {
    for (let index = 0; index < 6; index += 1) {
      const x = box.left + box.width * side;
      const y = box.top + box.height * (0.2 + index * 0.12);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + (side < 0.5 ? -3 : 3), y + 2);
      ctx.stroke();
    }
  }
}

function drawCooler(ctx, box, colors) {
  propShadow(ctx, box);
  const width = box.width * 0.72;
  const x = (box.left + box.right) / 2 - width / 2;
  const top = box.baseY - TILE * 0.52;
  fillRoundRect(ctx, x, top, width, TILE * 0.48, 3, colors.base);
  fillRoundRect(ctx, x - 2, top - TILE * 0.08, width + 4, TILE * 0.12, 3, colors.accent);
  ctx.strokeStyle = colors.trim;
  ctx.lineWidth = Math.max(2, TILE * 0.04);
  ctx.beginPath();
  ctx.arc((box.left + box.right) / 2, top - TILE * 0.08, width * 0.24, Math.PI, 0);
  ctx.stroke();
  fillRoundRect(ctx, x + width * 0.38, top + TILE * 0.22, width * 0.24, TILE * 0.05, 1, colors.accent);
  fillRoundRect(ctx, x + width * 0.44, top + TILE * 0.3, width * 0.12, TILE * 0.08, 1, colors.trim);
}

function drawSandcastle(ctx, box, colors) {
  propShadow(ctx, box);
  const baseY = box.baseY - TILE * 0.02;
  // Mound.
  ctx.fillStyle = colors.base;
  ctx.beginPath();
  ctx.ellipse((box.left + box.right) / 2, baseY, box.width * 0.46, TILE * 0.16, 0, 0, Math.PI * 2);
  ctx.fill();
  // Two crenellated towers.
  for (const side of [-1, 1]) {
    const cx = (box.left + box.right) / 2 + side * TILE * 0.34;
    const towerW = TILE * 0.34;
    const towerH = TILE * (side < 0 ? 0.72 : 0.56);
    fillRoundRect(ctx, cx - towerW / 2, baseY - towerH, towerW, towerH, 2, colors.accent);
    for (let index = 0; index < 3; index += 1) {
      fillRoundRect(
        ctx,
        cx - towerW / 2 + index * (towerW / 3) + 1,
        baseY - towerH - TILE * 0.1,
        towerW / 3 - 2,
        TILE * 0.12,
        1,
        colors.accent
      );
    }
    ctx.fillStyle = colors.trim;
    ctx.beginPath();
    ctx.moveTo(cx - TILE * 0.06, baseY);
    ctx.lineTo(cx - TILE * 0.06, baseY - TILE * 0.2);
    ctx.quadraticCurveTo(cx, baseY - TILE * 0.3, cx + TILE * 0.06, baseY - TILE * 0.2);
    ctx.lineTo(cx + TILE * 0.06, baseY);
    ctx.closePath();
    ctx.fill();
  }
  // Central wall and a little pennant.
  fillRoundRect(ctx, box.left + box.width * 0.32, baseY - TILE * 0.44, box.width * 0.36, TILE * 0.42, 2, colors.base);
  fillRoundRect(ctx, box.left + box.width * 0.44, baseY - TILE * 0.58, TILE * 0.035, TILE * 0.2, 1, colors.trim);
  ctx.fillStyle = colors.trim;
  ctx.beginPath();
  ctx.moveTo(box.left + box.width * 0.47, baseY - TILE * 0.58);
  ctx.lineTo(box.left + box.width * 0.61, baseY - TILE * 0.53);
  ctx.lineTo(box.left + box.width * 0.47, baseY - TILE * 0.48);
  ctx.closePath();
  ctx.fill();
}

function drawSurfboard(ctx, box, colors) {
  propShadow(ctx, box);
  const cx = (box.left + box.right) / 2;
  const width = box.width * 0.42;
  const top = box.top + TILE * 0.12;
  const bottom = box.baseY - TILE * 0.06;
  ctx.save();
  ctx.translate(cx, top);
  ctx.rotate(-0.08);
  const height = bottom - top;
  fillRoundRect(ctx, -width / 2, 0, width, height, width / 2, colors.base);
  fillRoundRect(ctx, -width * 0.09, TILE * 0.14, width * 0.18, height - TILE * 0.3, 2, colors.accent);
  ctx.strokeStyle = colors.trim;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(0, TILE * 0.1);
  ctx.lineTo(0, height - TILE * 0.12);
  ctx.stroke();
  // Fin.
  ctx.fillStyle = colors.trim;
  ctx.beginPath();
  ctx.moveTo(-2, height - TILE * 0.06);
  ctx.lineTo(width * 0.34, height + TILE * 0.02);
  ctx.lineTo(-2, height + TILE * 0.02);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawBuoy(ctx, box, colors) {
  propShadow(ctx, box);
  const cx = (box.left + box.right) / 2;
  const cy = box.baseY - TILE * 0.26;
  const r = TILE * 0.2;
  ctx.fillStyle = colors.base;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = colors.accent;
  ctx.beginPath();
  ctx.ellipse(cx, cy - r * 0.3, r * 0.99, r * 0.3, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = colors.trim;
  ctx.lineWidth = Math.max(1.5, TILE * 0.03);
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.56, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy - r - TILE * 0.05, TILE * 0.06, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx, cy + r);
  ctx.quadraticCurveTo(cx + TILE * 0.14, cy + r + TILE * 0.1, cx + TILE * 0.04, cy + r + TILE * 0.18);
  ctx.stroke();
}

function drawShellPile(ctx, box, colors) {
  const cx = (box.left + box.right) / 2;
  const baseY = box.baseY - TILE * 0.06;
  const shells = [
    { dx: -0.1, dy: 0, rx: 0.13, ry: 0.1, color: colors.base },
    { dx: 0.1, dy: 0.02, rx: 0.11, ry: 0.08, color: colors.accent },
    { dx: 0.01, dy: -0.08, rx: 0.1, ry: 0.09, color: colors.base }
  ];
  for (const shell of shells) {
    ctx.fillStyle = shell.color;
    ctx.beginPath();
    ctx.ellipse(cx + TILE * shell.dx, baseY - TILE * shell.dy, TILE * shell.rx, TILE * shell.ry, 0.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = colors.trim;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx + TILE * shell.dx, baseY - TILE * shell.dy);
    ctx.lineTo(cx + TILE * (shell.dx - shell.rx * 0.7), baseY - TILE * (shell.dy + shell.ry * 0.3));
    ctx.moveTo(cx + TILE * shell.dx, baseY - TILE * shell.dy);
    ctx.lineTo(cx + TILE * (shell.dx + shell.rx * 0.7), baseY - TILE * (shell.dy + shell.ry * 0.3));
    ctx.stroke();
  }
}

function drawBeachBall(ctx, box, colors) {
  propShadow(ctx, box);
  const cx = (box.left + box.right) / 2;
  const cy = box.baseY - TILE * 0.26;
  const r = TILE * 0.22;
  ctx.fillStyle = colors.base;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  for (const [start, color] of [[-0.4, colors.accent], [1.7, colors.trim], [3.5, colors.accent]]) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, start, start + 0.9);
    ctx.closePath();
    ctx.fill();
  }
  ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
  ctx.beginPath();
  ctx.arc(cx - r * 0.32, cy - r * 0.36, r * 0.18, 0, Math.PI * 2);
  ctx.fill();
}

function drawKite(ctx, box, colors) {
  const cx = (box.left + box.right) / 2;
  const cy = box.baseY - TILE * 0.62;
  const half = TILE * 0.24;
  ctx.fillStyle = colors.base;
  ctx.beginPath();
  ctx.moveTo(cx, cy - half);
  ctx.lineTo(cx + half * 0.8, cy);
  ctx.lineTo(cx, cy + half);
  ctx.lineTo(cx - half * 0.8, cy);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = colors.trim;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.strokeStyle = colors.accent;
  ctx.lineWidth = Math.max(2, TILE * 0.04);
  ctx.beginPath();
  ctx.moveTo(cx, cy - half);
  ctx.lineTo(cx, cy + half);
  ctx.moveTo(cx - half * 0.8, cy);
  ctx.lineTo(cx + half * 0.8, cy);
  ctx.stroke();
  // Tail with two little bows.
  ctx.strokeStyle = colors.trim;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(cx, cy + half);
  ctx.quadraticCurveTo(cx + TILE * 0.16, cy + half + TILE * 0.1, cx + TILE * 0.06, cy + half + TILE * 0.22);
  ctx.stroke();
  for (let index = 0; index < 2; index += 1) {
    ctx.fillStyle = index % 2 === 0 ? colors.accent : colors.base;
    ctx.beginPath();
    ctx.ellipse(cx + TILE * (0.1 + index * 0.02), cy + half + TILE * (0.1 + index * 0.08), TILE * 0.05, TILE * 0.025, -0.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawShowerPost(ctx, box, colors) {
  propShadow(ctx, box);
  const cx = (box.left + box.right) / 2;
  const top = box.top + TILE * 0.14;
  fillRoundRect(ctx, cx - TILE * 0.035, top, TILE * 0.07, box.baseY - top - TILE * 0.04, 2, colors.trim);
  fillRoundRect(ctx, cx - TILE * 0.03, top - TILE * 0.04, TILE * 0.22, TILE * 0.06, 2, colors.base);
  ctx.beginPath();
  ctx.arc(cx + TILE * 0.18, top + TILE * 0.02, TILE * 0.07, 0, Math.PI);
  ctx.fillStyle = colors.accent;
  ctx.fill();
  ctx.fillStyle = colors.base;
  ctx.beginPath();
  ctx.arc(cx - TILE * 0.13, top + TILE * 0.16, TILE * 0.06, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = colors.accent;
  ctx.lineWidth = 1.5;
  for (const dx of [-0.02, 0.05, 0.12]) {
    ctx.beginPath();
    ctx.moveTo(cx + TILE * (0.16 + dx), top + TILE * 0.12);
    ctx.lineTo(cx + TILE * (0.16 + dx), top + TILE * 0.3);
    ctx.stroke();
  }
  fillRoundRect(ctx, cx - TILE * 0.2, box.baseY - TILE * 0.08, TILE * 0.4, TILE * 0.06, 2, colors.base);
}

/* ------------------------------------------------------------------------ *
 * Wave 4 school and library props: the reading room and a little science corner.
 * ------------------------------------------------------------------------ */

function drawGlobe(ctx, box, colors) {
  propShadow(ctx, box);
  const cx = (box.left + box.right) / 2;
  const cy = box.baseY - TILE * 0.5;
  const r = TILE * 0.24;
  fillRoundRect(ctx, cx - TILE * 0.16, box.baseY - TILE * 0.12, TILE * 0.32, TILE * 0.1, 3, colors.trim);
  fillRoundRect(ctx, cx - TILE * 0.025, cy, TILE * 0.05, TILE * 0.38, 2, colors.base);
  ctx.fillStyle = colors.accent;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = colors.base;
  ctx.beginPath();
  ctx.ellipse(cx - r * 0.32, cy - r * 0.18, r * 0.34, r * 0.5, 0.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(cx + r * 0.38, cy + r * 0.24, r * 0.26, r * 0.4, -0.3, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = colors.trim;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(cx, cy, r, -0.6, 0.7);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 2.2, 3.6);
  ctx.stroke();
}

function drawChalkboard(ctx, box, colors) {
  propShadow(ctx, box);
  const top = box.top + TILE * 0.14;
  const boardH = box.height - TILE * 0.32;
  fillRoundRect(ctx, box.left + TILE * 0.04, top, box.width - TILE * 0.08, boardH, 3, colors.trim);
  fillRoundRect(ctx, box.left + TILE * 0.09, top + 4, box.width - TILE * 0.18, boardH - 8, 2, colors.base);
  ctx.strokeStyle = colors.accent;
  ctx.lineWidth = Math.max(1.2, TILE * 0.025);
  ctx.beginPath();
  ctx.moveTo(box.left + TILE * 0.2, top + boardH * 0.3);
  ctx.lineTo(box.left + TILE * 0.42, top + boardH * 0.3);
  ctx.moveTo(box.left + TILE * 0.2, top + boardH * 0.5);
  ctx.lineTo(box.left + TILE * 0.55, top + boardH * 0.5);
  ctx.moveTo(box.left + TILE * 0.2, top + boardH * 0.7);
  ctx.lineTo(box.left + TILE * 0.36, top + boardH * 0.7);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(box.left + box.width * 0.68, top + boardH * 0.5, TILE * 0.1, 0, Math.PI * 2);
  ctx.stroke();
  fillRoundRect(ctx, box.left + TILE * 0.12, top + boardH - TILE * 0.05, box.width - TILE * 0.24, TILE * 0.06, 2, colors.trim);
}

function drawLocker(ctx, box, colors) {
  propShadow(ctx, box);
  const top = box.top + TILE * 0.14;
  const height = box.height - TILE * 0.22;
  fillRoundRect(ctx, box.left + TILE * 0.04, top, box.width - TILE * 0.08, height, 3, colors.trim);
  const doorWidth = (box.width - TILE * 0.12) / 2;
  for (let index = 0; index < 2; index += 1) {
    const x = box.left + TILE * 0.06 + index * doorWidth;
    fillRoundRect(ctx, x, top + 3, doorWidth - 3, height - 6, 2, colors.base);
    for (let vent = 0; vent < 4; vent += 1) {
      fillRoundRect(ctx, x + 4, top + 8 + vent * TILE * 0.06, doorWidth - 11, TILE * 0.022, 1, colors.trim);
    }
    fillRoundRect(ctx, x + doorWidth - 12, top + height * 0.48, TILE * 0.05, TILE * 0.12, 1, colors.accent);
  }
  fillRoundRect(ctx, box.left + TILE * 0.06, box.baseY - TILE * 0.1, box.width - TILE * 0.12, TILE * 0.06, 2, colors.trim);
}

function drawReadingTable(ctx, box, colors) {
  propShadow(ctx, box);
  const topY = box.baseY - TILE * 0.46;
  fillRoundRect(ctx, box.left, topY, box.width, TILE * 0.16, 3, colors.base);
  for (const x of [box.left + TILE * 0.1, box.right - TILE * 0.18]) {
    fillRoundRect(ctx, x, topY + TILE * 0.14, TILE * 0.1, TILE * 0.32, 2, colors.trim);
  }
  // Open book at the centre.
  const cx = (box.left + box.right) / 2;
  ctx.fillStyle = colors.accent;
  ctx.beginPath();
  ctx.moveTo(cx, topY - TILE * 0.02);
  ctx.lineTo(cx - TILE * 0.34, topY - TILE * 0.1);
  ctx.lineTo(cx - TILE * 0.32, topY + TILE * 0.02);
  ctx.lineTo(cx, topY + TILE * 0.08);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(cx, topY - TILE * 0.02);
  ctx.lineTo(cx + TILE * 0.34, topY - TILE * 0.1);
  ctx.lineTo(cx + TILE * 0.32, topY + TILE * 0.02);
  ctx.lineTo(cx, topY + TILE * 0.08);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = colors.trim;
  ctx.lineWidth = 1;
  for (const side of [-1, 1]) {
    for (let line = 0; line < 3; line += 1) {
      ctx.beginPath();
      ctx.moveTo(cx + side * TILE * 0.08, topY - TILE * 0.02 + line * TILE * 0.035);
      ctx.lineTo(cx + side * TILE * 0.26, topY - TILE * 0.06 + line * TILE * 0.035);
      ctx.stroke();
    }
  }
  // A small reading lamp at the right end.
  fillRoundRect(ctx, box.right - TILE * 0.38, topY - TILE * 0.28, TILE * 0.05, TILE * 0.24, 1, colors.trim);
  ctx.beginPath();
  ctx.arc(box.right - TILE * 0.36, topY - TILE * 0.3, TILE * 0.11, Math.PI, 0);
  ctx.fillStyle = colors.accent;
  ctx.fill();
}

function drawBeanbag(ctx, box, colors) {
  propShadow(ctx, box);
  const cx = (box.left + box.right) / 2;
  ctx.fillStyle = colors.base;
  ctx.beginPath();
  ctx.moveTo(cx - box.width * 0.38, box.baseY - TILE * 0.08);
  ctx.quadraticCurveTo(cx - box.width * 0.48, box.baseY - TILE * 0.44, cx - box.width * 0.16, box.baseY - TILE * 0.5);
  ctx.quadraticCurveTo(cx + box.width * 0.16, box.baseY - TILE * 0.58, cx + box.width * 0.38, box.baseY - TILE * 0.3);
  ctx.quadraticCurveTo(cx + box.width * 0.46, box.baseY - TILE * 0.1, cx + box.width * 0.24, box.baseY - TILE * 0.04);
  ctx.quadraticCurveTo(cx, box.baseY + TILE * 0.02, cx - box.width * 0.38, box.baseY - TILE * 0.08);
  ctx.fill();
  ctx.strokeStyle = colors.trim;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(cx - box.width * 0.22, box.baseY - TILE * 0.1);
  ctx.quadraticCurveTo(cx, box.baseY - TILE * 0.2, cx + box.width * 0.24, box.baseY - TILE * 0.12);
  ctx.stroke();
  ctx.fillStyle = colors.accent;
  ctx.beginPath();
  ctx.ellipse(cx + box.width * 0.08, box.baseY - TILE * 0.32, TILE * 0.1, TILE * 0.06, -0.2, 0, Math.PI * 2);
  ctx.fill();
}

function drawEasel(ctx, box, colors) {
  propShadow(ctx, box);
  const cx = (box.left + box.right) / 2;
  const top = box.top + TILE * 0.16;
  ctx.strokeStyle = colors.trim;
  ctx.lineWidth = Math.max(2, TILE * 0.045);
  ctx.lineCap = 'round';
  for (const offset of [-0.18, 0.16]) {
    ctx.beginPath();
    ctx.moveTo(cx + TILE * offset, top + TILE * 0.14);
    ctx.lineTo(cx + TILE * offset * 1.7, box.baseY - TILE * 0.04);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(cx, top + TILE * 0.34);
  ctx.lineTo(cx, box.baseY - TILE * 0.02);
  ctx.stroke();
  fillRoundRect(ctx, cx - TILE * 0.32, top, TILE * 0.64, TILE * 0.46, 2, colors.accent);
  strokeRoundRect(ctx, cx - TILE * 0.32, top, TILE * 0.64, TILE * 0.46, 2, colors.trim, 1.5);
  // A tiny painted beach on the canvas.
  ctx.fillStyle = colors.base;
  ctx.beginPath();
  ctx.moveTo(cx - TILE * 0.26, top + TILE * 0.28);
  ctx.lineTo(cx - TILE * 0.08, top + TILE * 0.12);
  ctx.lineTo(cx + TILE * 0.12, top + TILE * 0.3);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = colors.trim;
  ctx.beginPath();
  ctx.arc(cx + TILE * 0.18, top + TILE * 0.12, TILE * 0.05, 0, Math.PI * 2);
  ctx.fill();
  fillRoundRect(ctx, cx - TILE * 0.38, top + TILE * 0.46, TILE * 0.76, TILE * 0.07, 2, colors.base);
}

function drawScienceBench(ctx, box, colors) {
  propShadow(ctx, box);
  const topY = box.baseY - TILE * 0.52;
  fillRoundRect(ctx, box.left, topY, box.width, TILE * 0.14, 3, colors.base);
  fillRoundRect(ctx, box.left + TILE * 0.06, topY + TILE * 0.12, TILE * 0.09, TILE * 0.36, 2, colors.trim);
  fillRoundRect(ctx, box.right - TILE * 0.15, topY + TILE * 0.12, TILE * 0.09, TILE * 0.36, 2, colors.trim);
  // Three flasks with coloured contents.
  for (let index = 0; index < 3; index += 1) {
    const cx = box.left + box.width * (0.22 + index * 0.28);
    const flaskH = TILE * (index === 1 ? 0.26 : 0.2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.beginPath();
    ctx.moveTo(cx - TILE * 0.05, topY - flaskH);
    ctx.lineTo(cx + TILE * 0.05, topY - flaskH);
    ctx.lineTo(cx + TILE * 0.1, topY - TILE * 0.01);
    ctx.lineTo(cx - TILE * 0.1, topY - TILE * 0.01);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = colors.trim;
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.fillStyle = index === 1 ? colors.trim : colors.accent;
    ctx.beginPath();
    ctx.moveTo(cx - TILE * 0.08, topY - TILE * 0.08);
    ctx.lineTo(cx + TILE * 0.08, topY - TILE * 0.08);
    ctx.lineTo(cx + TILE * 0.1, topY - TILE * 0.01);
    ctx.lineTo(cx - TILE * 0.1, topY - TILE * 0.01);
    ctx.closePath();
    ctx.fill();
    if (index === 1) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
      for (const [dx, dy] of [[0, -0.16], [0.04, -0.2], [-0.03, -0.23]]) {
        ctx.beginPath();
        ctx.arc(cx + TILE * dx, topY + TILE * dy, TILE * 0.018, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}

/** Seeded cushion/throw pattern, clipped to the part of the shape it belongs on. */
function propPatternRect(box, shape) {
  const inset = TILE * 0.06;
  switch (shape) {
    case 'rug':
      return {
        x: box.left + inset * 2,
        y: box.top + inset * 2,
        w: Math.max(2, box.width - inset * 4),
        h: Math.max(2, box.height - inset * 4)
      };
    case 'bed':
      return {
        x: box.left + 3,
        y: box.top + TILE * 0.78,
        w: Math.max(2, box.width - 6),
        h: Math.max(2, box.height - TILE * 0.92)
      };
    case 'couch':
      return {
        x: box.left + TILE * 0.02,
        y: box.baseY - TILE * 0.46,
        w: Math.max(2, box.width - TILE * 0.04),
        h: TILE * 0.26
      };
    case 'armchair':
      return {
        x: box.left + TILE * 0.16,
        y: box.baseY - TILE * 0.38,
        w: Math.max(2, box.width - TILE * 0.32),
        h: TILE * 0.2
      };
    case 'chair': {
      const seatWidth = Math.min(box.width * 0.62, TILE * 0.6);
      return {
        x: (box.left + box.right) / 2 - seatWidth / 2,
        y: box.baseY - TILE * 0.42,
        w: seatWidth,
        h: TILE * 0.2
      };
    }
    default:
      return null;
  }
}

function drawPropPattern(ctx, box, meta) {
  const detail = meta?.detail;
  const rect = propPatternRect(box, meta?.shape);
  if (!detail?.pattern || detail.pattern === 'plain' || !rect || !detail.patternColor) return;
  const { x, y, w, h } = rect;
  if (w < 3 || h < 3) return;
  ctx.save();
  roundRectPath(ctx, x, y, w, h, Math.min(4, h / 3));
  ctx.clip();
  ctx.globalAlpha = 0.4;
  ctx.strokeStyle = detail.patternColor;
  ctx.fillStyle = detail.patternColor;
  if (detail.pattern === 'stripes') {
    ctx.lineWidth = Math.max(1.5, TILE * 0.045);
    for (let offset = -h; offset < w + h; offset += TILE * 0.18) {
      ctx.beginPath();
      ctx.moveTo(x + offset, y);
      ctx.lineTo(x + offset - h, y + h);
      ctx.stroke();
    }
  } else if (detail.pattern === 'checks') {
    ctx.lineWidth = Math.max(1, TILE * 0.03);
    const step = Math.max(TILE * 0.2, w / 7);
    for (let offset = 0; offset <= w; offset += step) {
      ctx.beginPath();
      ctx.moveTo(x + offset, y);
      ctx.lineTo(x + offset, y + h);
      ctx.stroke();
    }
    for (let offset = 0; offset <= h; offset += step) {
      ctx.beginPath();
      ctx.moveTo(x, y + offset);
      ctx.lineTo(x + w, y + offset);
      ctx.stroke();
    }
  } else {
    const step = Math.max(TILE * 0.2, w / 6);
    for (let row = 0; row * step < h; row += 1) {
      for (let col = 0; col * step < w; col += 1) {
        const dx = (row % 2 === 0 ? 0 : step / 2) + col * step;
        ctx.beginPath();
        ctx.arc(x + dx, y + row * step + step / 2, Math.max(1.2, TILE * 0.03), 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  ctx.restore();
}

function drawGenericProp(ctx, box, colors) {
  propShadow(ctx, box);
  fillRoundRect(ctx, box.left, box.top + TILE * 0.18, box.width, box.height - TILE * 0.24, 5, colors.base);
  fillRoundRect(ctx, box.left + TILE * 0.08, box.top + TILE * 0.28, box.width - TILE * 0.16, TILE * 0.1, 3, colors.accent);
  fillRoundRect(ctx, box.left + TILE * 0.08, box.baseY - TILE * 0.18, box.width - TILE * 0.16, TILE * 0.08, 3, colors.trim);
}

const LOCATION_PROP_SHAPES = {
  fountain: drawFountain,
  bench: drawBench,
  lamp: drawLamp,
  gate: drawGate,
  slide: drawSlide,
  'swing-frame': drawSwingFrame,
  'amphitheatre-tier': drawAmphitheatreTier,
  building: drawBuilding,
  pier: drawPier,
  palm: drawPalm,
  umbrella: drawUmbrella,
  desk: drawDesk,
  bookshelf: drawPropBookshelf,
  planter: drawPlanter,
  'picnic-blanket': drawPicnicBlanket,
  rug: drawRug,
  'cafe-counter': drawCafeCounter,
  stool: drawStool,
  'cafe-table': drawCafeTable,
  awning: drawAwning,
  'display-case': drawDisplayCase,
  oven: drawOven,
  'flour-sack': drawFlourSack,
  'exam-bed': drawExamBed,
  'supply-cabinet': drawSupplyCabinet,
  'privacy-screen': drawPrivacyScreen,
  workbench: drawWorkbench,
  'tool-rack': drawToolRack,
  wardrobe: drawWardrobe,
  vanity: drawVanity,
  fence: drawFence,
  hedge: drawHedge,
  bin: drawBin,
  mailbox: drawMailbox,
  signpost: drawSignpost,
  'market-stall': drawMarketStall,
  'bus-stop': drawBusStop,
  statue: drawStatue,
  'flower-bed': drawFlowerBed,
  'string-lights': drawStringLights,
  'notice-board': drawNoticeBoard,
  'bike-rack': drawBikeRack,
  'deck-chair': drawDeckChair,
  towel: drawTowel,
  cooler: drawCooler,
  sandcastle: drawSandcastle,
  surfboard: drawSurfboard,
  buoy: drawBuoy,
  'shell-pile': drawShellPile,
  'beach-ball': drawBeachBall,
  kite: drawKite,
  'shower-post': drawShowerPost,
  globe: drawGlobe,
  chalkboard: drawChalkboard,
  locker: drawLocker,
  'reading-table': drawReadingTable,
  beanbag: drawBeanbag,
  easel: drawEasel,
  'science-bench': drawScienceBench
};

/**
 * One dispatcher for location records: Home furniture ids resolve to the Home
 * shapes, and the location catalog overrides the two shared ids (rug,
 * bookshelf) because its art is the outdoor/interior prop version.
 */
const PROP_SHAPE_DRAWERS = { ...HOME_ITEM_SHAPES, ...LOCATION_PROP_SHAPES };

export class WorldRenderer {
  constructor({ canvas, minimap } = {}) {
    this.canvas = canvas;
    this.ctx = canvas?.getContext?.('2d') || null;
    this.minimap = minimap;
    this.mctx = minimap?.getContext?.('2d') || null;
    this.tileTextures = null;
    this.tileTextureCache = new Map();
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

  initTextures(theme = null) {
    if (typeof document === 'undefined') return;
    const key = theme ? JSON.stringify(theme) : '';
    if (!this.tileTextureCache.has(key)) {
      this.tileTextureCache.set(key, makeTileTextures(terrainColorsFor(theme)));
    }
    this.tileTextures = this.tileTextureCache.get(key);
  }

  buildMinimapBase(terrain, theme = null) {
    if (!terrain || typeof document === 'undefined') return;
    const scale = 4;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = WORLD_SIZE * scale;
    const ctx = canvas.getContext('2d');
    const colors = terrainColorsFor(theme);
    for (let y = 0; y < WORLD_SIZE; y++) {
      for (let x = 0; x < WORLD_SIZE; x++) {
        ctx.fillStyle = colors[terrain[y][x]] || TERRAIN_COLORS[terrain[y][x]];
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
    // A full-view activity owns the whole canvas; the Park is not painted.
    if (game.miniGameHost?.renderView?.(this.ctx, {
      width: game.width,
      height: game.height,
      dpr: game.dpr,
      tileSize: TILE
    })) return;
    this.initTextures(game.theme);
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

    // Ground cover (the rug) sits above the floor and below doors and actors.
    this.drawHomeItemsGround(ctx, game);
    // A lit lamp casts a warm pool before actors and furniture draw over it.
    this.drawHomeLampGlow(ctx, game);
    // Floor coverings (rugs, blankets, towels, flower beds) paint below doors
    // and every object/actor, so nothing is sorted on top of them.
    for (const record of game.locationProps || []) {
      if (game.worldDraft?.kind === 'prop' && record.uid === game.worldDraft.uid) continue;
      if (propRenderMeta(record)?.ground) this.drawLocationProp(record, game);
    }
    // A rug or blanket being moved paints in the ground pass, like its source.
    if (game.worldDraft?.kind === 'prop'
      && propRenderMeta(game.worldDraft.record)?.ground) {
      this.drawWorldDraft(ctx, game.worldDraft, game);
    }
    if (game.worldSelected && !game.worldDraft) this.drawWorldSelection(ctx, game);

    // Travel doors sit above the ground and below every actor, so a character
    // standing in the doorway is drawn in front of it. Doors cut into a solid
    // footprint are held back: their floating marker climbs above the building.
    const doorHosts = new Map();
    if (Array.isArray(game.locationProps)) {
      const propAtTile = new Map();
      for (const record of game.locationProps) {
        for (const tile of propTiles(record)) propAtTile.set(`${tile.x},${tile.y}`, record);
      }
      for (const door of game.doors || []) {
        const host = propAtTile.get(`${door.x},${door.y}`);
        if (host) doorHosts.set(door, host);
      }
    }
    for (const door of game.doors || []) {
      if (!doorHosts.has(door)) this.drawDoorMarker(ctx, door, game.time);
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

    if (game.homeDraft) this.drawHomeDraft(ctx, game.homeDraft);
    if (game.worldDraft
      && !(game.worldDraft.kind === 'prop' && propRenderMeta(game.worldDraft.record)?.ground)) {
      this.drawWorldDraft(ctx, game.worldDraft, game);
    }

    // Render characters and scenery sorted by Y depth
    const renderables = [];
    const poseAnchor = game.player?.homePose
      ? homePoseAnchor(game.homeItems, game.player.homePose)
      : null;
    if (game.player) {
      renderables.push({
        type: 'char',
        // A sleeping or seated player sorts with the item it is resting on, so
        // the blanket and sprite stay above the furniture.
        y: poseAnchor ? poseAnchor.sortY : game.interpolated(game.player).y,
        entity: game.player
      });
    }
    for (const npc of game.npcs) renderables.push({ type: 'char', y: game.interpolated(npc).y, entity: npc });
    for (const comp of game.companions) renderables.push({ type: 'char', y: game.interpolated(comp).y, entity: comp });
    for (const buddy of game.homeBuddies || []) {
      renderables.push({ type: 'char', y: game.interpolated(buddy).y, entity: buddy });
    }
    // Furniture sorts by its footprint's bottom row, so a tall bed occludes the
    // player behind it and never the player in front. Ground cover is skipped:
    // the rug already drew below every actor.
    const draftUid = game.homeDraft?.uid || null;
    for (const entry of game.homeItems || []) {
      const item = homeItem(entry.itemId);
      const size = homeItemSize(entry.itemId, entry.rot);
      if (!item || !size || item.ground) continue;
      // The piece being moved is hidden while its translucent draft is shown.
      if (draftUid && entry.uid === draftUid) continue;
      renderables.push({
        type: 'home-item',
        y: entry.y + size.h - 1,
        x: entry.x,
        entity: entry
      });
    }
    if (game.homeDraft) {
      const draft = game.homeDraft;
      const size = homeItemSize(draft.itemId, draft.rot);
      const item = homeItem(draft.itemId);
      if (size && item && !item.ground) {
        renderables.push({
          type: 'home-item',
          y: draft.y + size.h - 1,
          x: draft.x,
          entity: {
            uid: draft.uid,
            itemId: draft.itemId,
            x: draft.x,
            y: draft.y,
            rot: draft.rot,
            variant: draft.variant,
            tier: draft.tier,
            on: draft.on === true
          },
          draft: true
        });
      }
    }

    // Location props (fountains, benches, facades) sort with actors on their
    // footprint's bottom row, so a character in front draws over them.
    for (const record of game.locationProps || []) {
      if (game.worldDraft?.kind === 'prop' && record.uid === game.worldDraft.uid) continue;
      const meta = propRenderMeta(record);
      if (!meta || meta.ground) continue;
      renderables.push({
        type: 'location-prop',
        y: meta.sortY,
        x: meta.x,
        entity: record
      });
    }

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
        // The object being moved is hidden while its translucent draft is shown.
        if (game.worldDraft?.kind === 'scenery'
          && (item.uid || item.id) === game.worldDraft.uid) continue;
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

    for (const shell of game.forage?.shells || []) {
      renderables.push({ type: 'forage', y: shell.y, entity: shell, kind: 'shell' });
    }

    renderables.sort((a, b) => (a.y - b.y) || ((a.x ?? 0) - (b.x ?? 0)));

    for (const item of renderables) {
      if (item.type === 'char') {
        this.drawCharacter(game, item.entity);
      } else if (item.type === 'forage') {
        this.drawForageItem(game, item.entity, item.kind);
      } else if (item.type === 'home-item') {
        this.drawHomeItem(item.entity, game, { draft: Boolean(item.draft) });
      } else if (item.type === 'location-prop') {
        this.drawLocationProp(item.entity, game);
      } else {
        this.drawSceneryItem(ctx, item.entity, item.opacity);
      }
    }

    // Interior door triggers are intentionally unlabelled: the doorway art in
    // the facade is the cue, and a floating ENTER pill would clutter the town.

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

  drawDoorMarker(ctx, door, time = 0) {
    if (!door) return;
    if (door.kind === 'activity') {
      this.drawActivityDoorMarker(ctx, door, time);
      return;
    }
    const cx = (door.x + 0.5) * TILE;
    const baseY = (door.y + 0.9) * TILE;
    const doorW = TILE * 0.6;
    const doorH = TILE * 0.9;
    const left = cx - doorW / 2;
    const top = baseY - doorH;
    const pulse = 0.5 + Math.sin((time || 0) * 2.2 + door.x * 0.6) * 0.5;

    // A soft welcome ring reads as "this one is interactive".
    ctx.save();
    ctx.globalAlpha = 0.16 + pulse * 0.14;
    ctx.fillStyle = '#e5f4a5';
    ctx.beginPath();
    ctx.ellipse(cx, baseY, TILE * 0.42, TILE * 0.18, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.globalAlpha = 0.24;
    ctx.fillStyle = '#0b140d';
    ctx.beginPath();
    ctx.ellipse(cx, baseY, doorW * 0.62, TILE * 0.1, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.save();
    // Frame.
    ctx.fillStyle = '#3f2d20';
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(left - 3, top - 3, doorW + 6, doorH + 3, 5);
    else ctx.rect(left - 3, top - 3, doorW + 6, doorH + 3);
    ctx.fill();
    // Panelled door.
    ctx.fillStyle = '#8a5c34';
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(left, top, doorW, doorH, 4);
    else ctx.rect(left, top, doorW, doorH);
    ctx.fill();
    ctx.strokeStyle = 'rgba(41, 27, 16, 0.55)';
    ctx.lineWidth = 1.5;
    for (let i = 1; i <= 2; i++) {
      const y = top + (doorH * i) / 3;
      ctx.beginPath();
      ctx.moveTo(left + 3, y);
      ctx.lineTo(left + doorW - 3, y);
      ctx.stroke();
    }
    ctx.fillStyle = '#f0d48a';
    ctx.beginPath();
    ctx.arc(left + doorW * 0.78, top + doorH * 0.58, 2.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /**
   * A doorway set inside a building footprint needs a marker above the roof:
   * the ordinary door art would be painted under the facade. The pill bobs on
   * the same clock as the door ring so it reads as part of the same system.
   */
  drawInteriorDoorMarker(ctx, door, meta, time = 0) {
    if (!door || !meta?.size) return;
    const cx = (door.x + 0.5) * TILE;
    const pulse = 0.5 + Math.sin((time || 0) * 2.2 + door.x * 0.6) * 0.5;
    const bob = Math.sin((time || 0) * 2.6 + door.x * 0.4) * TILE * 0.04;
    const label = 'ENTER';
    const pillH = Math.max(14, TILE * 0.34);
    const top = meta.y * TILE - pillH - TILE * 0.2 + bob;

    ctx.save();
    ctx.font = `700 ${Math.max(9, Math.round(TILE * 0.19))}px system-ui, -apple-system, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const pillW = Math.max(TILE * 0.9, ctx.measureText(label).width + TILE * 0.34);
    const left = cx - pillW / 2;

    // A small down arrow points at the roof the doorway hides beneath.
    ctx.beginPath();
    ctx.moveTo(cx, top + pillH + TILE * 0.16);
    ctx.lineTo(cx - TILE * 0.1, top + pillH + TILE * 0.01);
    ctx.lineTo(cx + TILE * 0.1, top + pillH + TILE * 0.01);
    ctx.closePath();
    ctx.fillStyle = '#f0d48a';
    ctx.fill();

    ctx.globalAlpha = 0.82 + pulse * 0.15;
    ctx.fillStyle = '#15251b';
    ctx.strokeStyle = '#e5f4a5';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(left, top, pillW, pillH, pillH / 2);
    else ctx.rect(left, top, pillW, pillH);
    ctx.fill();
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#e5f4a5';
    ctx.fillText(label, cx, top + pillH / 2 + 0.5);
    ctx.restore();
  }

  /**
   * A course entrance reads as a climbing frame, not a front door: two posts,
   * three rungs, and the same welcome ring as a travel door.
   */
  drawActivityDoorMarker(ctx, door, time = 0) {
    const cx = (door.x + 0.5) * TILE;
    const baseY = (door.y + 0.9) * TILE;
    const frameW = TILE * 0.56;
    const frameH = TILE * 0.86;
    const left = cx - frameW / 2;
    const top = baseY - frameH;
    const pulse = 0.5 + Math.sin((time || 0) * 2.2 + door.x * 0.6) * 0.5;

    ctx.save();
    ctx.globalAlpha = 0.18 + pulse * 0.14;
    ctx.fillStyle = '#b6e37c';
    ctx.beginPath();
    ctx.ellipse(cx, baseY, TILE * 0.44, TILE * 0.18, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.strokeStyle = '#6f9f5b';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(left, baseY);
    ctx.lineTo(left, top);
    ctx.moveTo(left + frameW, baseY);
    ctx.lineTo(left + frameW, top);
    for (let i = 0; i < 3; i++) {
      const y = top + (frameH * (i + 1)) / 4;
      ctx.moveTo(left, y);
      ctx.lineTo(left + frameW, y);
    }
    ctx.stroke();
    ctx.strokeStyle = 'rgba(229, 244, 165, 0.55)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(left, top);
    ctx.lineTo(left + frameW, top);
    ctx.stroke();
    ctx.restore();
  }

  drawForageItem(game, item, kind = 'apple') {
    const { ctx } = this;
    if (!item) return;
    if (kind === 'shell') {
      this.drawForageShell(game, item);
      return;
    }
    const apple = item;
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

  /** A small scallop shell on the sand: canvas only, no image assets. */
  drawForageShell(game, shell) {
    const { ctx } = this;
    if (!shell) return;
    const time = game.time || 0;
    const bob = Math.sin(time * 2.4 + shell.x * 0.9) * TILE * 0.025;
    const cx = (shell.x + 0.5) * TILE;
    const cy = (shell.y + 0.82) * TILE + bob;
    const r = TILE * 0.16;

    // Soft collectible ring, tinted like sunlit shell.
    const pulse = 0.5 + Math.sin(time * 2 + shell.y * 0.8) * 0.5;
    ctx.save();
    ctx.globalAlpha = 0.18 + pulse * 0.12;
    ctx.strokeStyle = '#ffeccc';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(cx, (shell.y + 0.92) * TILE, r * 1.8, r * 0.72, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = '#0b140d';
    ctx.beginPath();
    ctx.ellipse(cx, (shell.y + 0.94) * TILE, r * 1.05, r * 0.4, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-0.24 + Math.sin(time * 0.8 + shell.y) * 0.05);

    // Fan silhouette with a rounded hinge at the bottom.
    ctx.beginPath();
    ctx.moveTo(0, r * 0.85);
    ctx.quadraticCurveTo(-r * 1.05, r * 0.15, -r * 0.95, -r * 0.55);
    ctx.quadraticCurveTo(-r * 0.5, -r * 1.1, 0, -r * 1.05);
    ctx.quadraticCurveTo(r * 0.5, -r * 1.1, r * 0.95, -r * 0.55);
    ctx.quadraticCurveTo(r * 1.05, r * 0.15, 0, r * 0.85);
    ctx.closePath();
    ctx.fillStyle = '#f7e6cd';
    ctx.fill();
    ctx.strokeStyle = '#c8a27b';
    ctx.lineWidth = Math.max(1, TILE * 0.025);
    ctx.stroke();

    // Radiating ridges.
    ctx.strokeStyle = 'rgba(180, 135, 95, 0.65)';
    ctx.lineWidth = Math.max(1, TILE * 0.02);
    for (let i = -2; i <= 2; i += 1) {
      const angle = -Math.PI / 2 + i * 0.3;
      ctx.beginPath();
      ctx.moveTo(0, r * 0.68);
      ctx.lineTo(Math.cos(angle) * r * 0.86, Math.sin(angle) * r * 0.86);
      ctx.stroke();
    }

    ctx.fillStyle = '#d8b088';
    ctx.beginPath();
    ctx.ellipse(0, r * 0.78, r * 0.28, r * 0.18, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  drawHomeItemsGround(ctx, game) {
    const draft = game.homeDraft;
    const draftUid = draft?.uid || null;
    for (const entry of game.homeItems || []) {
      const item = homeItem(entry.itemId);
      if (!item?.ground) continue;
      if (draftUid && entry.uid === draftUid) continue;
      const bounds = itemBounds(entry);
      if (!bounds) continue;
      ctx.save();
      drawRugShape(ctx, bounds, itemColors(entry.itemId, entry.variant));
      drawGroundTierAccent(ctx, bounds, entry);
      ctx.restore();
    }
    if (draft && homeItem(draft.itemId)?.ground) {
      const bounds = itemBounds(draft);
      if (bounds) {
        ctx.save();
        ctx.globalAlpha = 0.7;
        drawRugShape(ctx, bounds, itemColors(draft.itemId, draft.variant));
        drawGroundTierAccent(ctx, bounds, draft);
        ctx.restore();
      }
    }
  }

  /** Warm pool under every lit floor lamp. `on` is the only persisted state. */
  drawHomeLampGlow(ctx, game) {
    for (const entry of game.homeItems || []) {
      if (entry.on !== true) continue;
      if (homeItem(entry.itemId)?.shape !== 'floor-lamp') continue;
      const size = homeItemSize(entry.itemId, entry.rot);
      if (!size) continue;
      const cx = (entry.x + size.w / 2) * TILE;
      const cy = (entry.y + size.h - 0.4) * TILE;
      const radius = TILE * 3.1;
      const gradient = ctx.createRadialGradient(cx, cy, TILE * 0.12, cx, cy, radius);
      gradient.addColorStop(0, 'rgba(255, 218, 150, 0.32)');
      gradient.addColorStop(0.55, 'rgba(255, 198, 112, 0.14)');
      gradient.addColorStop(1, 'rgba(255, 190, 100, 0)');
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.ellipse(cx, cy, radius, radius * 0.72, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  /** Dashed footprint under the piece being moved; red when it cannot sit there. */
  drawHomeDraft(ctx, draft) {
    const size = homeItemSize(draft.itemId, draft.rot);
    if (!size) return;
    const x = draft.x * TILE;
    const y = draft.y * TILE;
    const width = size.w * TILE;
    const height = size.h * TILE;
    const valid = draft.reason == null;
    ctx.save();
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = valid ? '#b6e37c' : '#e07a6b';
    ctx.fillRect(x + 2, y + 2, width - 4, height - 4);
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = valid ? '#d8f7a8' : '#ff9d8a';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(x + 1.5, y + 1.5, width - 3, height - 3);
    ctx.restore();
  }

  /** Footprint bounds for one world object, in tiles. */
  worldObjectBounds(draft) {
    const tiles = draft.kind === 'scenery'
      ? [{ x: draft.x, y: draft.y }]
      : propTiles({ ...draft.record, x: draft.x, y: draft.y, rot: draft.rot });
    if (!tiles.length) return null;
    const xs = tiles.map(tile => tile.x);
    const ys = tiles.map(tile => tile.y);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    return {
      x: minX,
      y: minY,
      w: Math.max(...xs) - minX + 1,
      h: Math.max(...ys) - minY + 1
    };
  }

  /** Translucent prop/tree at the draft tile plus a red or green footprint. */
  drawWorldDraft(ctx, draft, game = null) {
    const bounds = this.worldObjectBounds(draft);
    if (!bounds) return;
    const valid = draft.reason == null;

    if (draft.kind === 'scenery') {
      this.drawSceneryItem(ctx, {
        ...draft.record,
        x: draft.x,
        y: draft.y,
        scale: draft.scale ?? draft.record?.scale
      }, 0.72);
    } else {
      ctx.save();
      ctx.globalAlpha = 0.72;
      this.drawLocationProp({
        ...draft.record,
        x: draft.x,
        y: draft.y,
        rot: draft.rot,
        variant: draft.variant,
        seed: draft.seed
      }, game);
      ctx.restore();
    }

    const x = bounds.x * TILE;
    const y = bounds.y * TILE;
    const width = bounds.w * TILE;
    const height = bounds.h * TILE;
    ctx.save();
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = valid ? '#b6e37c' : '#e07a6b';
    ctx.fillRect(x + 2, y + 2, width - 4, height - 4);
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = valid ? '#d8f7a8' : '#ff9d8a';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(x + 1.5, y + 1.5, width - 3, height - 3);
    ctx.restore();
  }

  /** Quiet dashed outline on the object an open Decorate card points at. */
  drawWorldSelection(ctx, game) {
    const selection = game.worldSelected;
    if (!selection?.uid) return;
    const list = selection.kind === 'scenery' ? game.scenery : game.locationProps;
    const record = (list || []).find(item => (item.uid || item.id) === selection.uid);
    if (!record) return;
    const bounds = this.worldObjectBounds({
      kind: selection.kind,
      record,
      x: record.x,
      y: record.y,
      rot: record.rot
    });
    if (!bounds) return;
    ctx.save();
    ctx.strokeStyle = 'rgba(229, 244, 165, 0.8)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(
      bounds.x * TILE + 2,
      bounds.y * TILE + 2,
      bounds.w * TILE - 4,
      bounds.h * TILE - 4
    );
    ctx.restore();
  }

  drawHomeItem(entry, game = null, { draft = false } = {}) {
    const { ctx } = this;
    const item = homeItem(entry.itemId);
    const bounds = itemBounds(entry);
    if (!item || !bounds) return;
    const draw = HOME_ITEM_SHAPES[item.shape] || drawGenericFurniture;
    const box = itemPad(bounds);
    ctx.save();
    if (draft) ctx.globalAlpha = 0.72;
    draw(ctx, box, itemColors(entry.itemId, entry.variant));
    if (!draft && entry.on === true && item.shape === 'tv') {
      this.drawTvStatic(ctx, box, game?.time || 0);
    }
    drawItemTierAccent(ctx, bounds, entry);
    ctx.restore();
  }

  /** One outdoor prop, drawn inside its rotated footprint. */
  drawLocationProp(record, game = null) {
    const meta = propRenderMeta(record);
    if (!meta) return;
    const { ctx } = this;
    const bounds = {
      left: meta.x * TILE,
      top: meta.y * TILE,
      right: (meta.x + meta.size.w) * TILE,
      bottom: (meta.y + meta.size.h) * TILE,
      width: meta.size.w * TILE,
      height: meta.size.h * TILE
    };
    const box = itemPad(bounds);
    const draw = PROP_SHAPE_DRAWERS[meta.shape] || drawGenericProp;
    ctx.save();
    draw(ctx, box, meta.colors, game?.time || 0, meta);
    drawPropPattern(ctx, box, meta);
    ctx.restore();
  }

  /** Animated static; derived from game.time so a reload needs no extra state. */
  drawTvStatic(ctx, box, time) {
    const centerX = (box.left + box.right) / 2;
    const bodyWidth = Math.min(box.width * 0.88, TILE * 0.9);
    const bodyHeight = TILE * 0.76;
    const bodyX = centerX - bodyWidth / 2;
    const bodyY = box.baseY - TILE * 0.12 - bodyHeight;
    const screenX = bodyX + 4;
    const screenY = bodyY + 4;
    const screenW = Math.max(2, bodyWidth - 16);
    const screenH = Math.max(2, bodyHeight - 10);
    ctx.save();
    ctx.beginPath();
    ctx.rect(screenX, screenY, screenW, screenH);
    ctx.clip();
    ctx.fillStyle = '#22332c';
    ctx.fillRect(screenX, screenY, screenW, screenH);
    const rows = Math.max(4, Math.floor(screenH / 3));
    for (let row = 0; row < rows; row += 1) {
      const seed = Math.sin(time * 11 + row * 91.7) * 0.5 + 0.5;
      ctx.globalAlpha = 0.16 + seed * 0.46;
      ctx.fillStyle = seed > 0.6 ? '#e6fff2' : '#9dc7b5';
      ctx.fillRect(
        screenX + seed * screenW * 0.3,
        screenY + (row / rows) * screenH,
        screenW * (0.2 + seed * 0.7),
        1.3
      );
    }
    const rollY = screenY + ((time * 26) % screenH);
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = '#f2fff8';
    ctx.fillRect(screenX, rollY, screenW, 2);
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
    const homePose = character.homePose;
    const poseAnchor = homePose ? homePoseAnchor(game.homeItems, homePose) : null;
    const asleep = homePose?.kind === 'sleep';
    const sitting = character.pose === 'sit' || homePose?.kind === 'sit';
    const profile = getAnimationProfile(character.recipe);
    const is3DModel = Boolean(profile.family?.startsWith('pet-') || profile.family?.startsWith('creature-'));
    const baseHeight = characterBaseHeight(character);
    const nowMs = (game.time || 0) * 1000;
    const fx = resolveFx(character, nowMs, characterEffectOwner(game, character));
    const height = characterVisualHeight(character, fx);
    const width = height;
    const position = game.interpolated(character);
    let footX = (position.x + 0.5) * TILE;
    let footY = (position.y + 1) * TILE;
    // Seated and sleeping poses render over the seat/bed while the logical tile
    // stays where collision expects it.
    if (poseAnchor) {
      footX = (poseAnchor.x + 0.5) * TILE;
      footY = (poseAnchor.y + 1) * TILE;
    }
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

    // Home buddies and the seated/sleeping player settle with a small squash
    // rather than a new sprite frame.
    if (sitting) offsetY += height * 0.08;
    const scaleX = (animTransform.scaleX ?? 1) * (sitting ? 1.08 : 1);
    const scaleY = (animTransform.scaleY ?? 1) * (asleep ? 0.52 : sitting ? 0.7 : 1);
    const shadowScale = (animTransform.shadowScale ?? 1) * (sitting ? 1.12 : 1);
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

    if (asleep) {
      const blanketWidth = width * 0.9;
      const blanketHeight = height * 0.26;
      const blanketX = drawX - blanketWidth / 2;
      const blanketY = footY - height * 0.34;
      ctx.save();
      ctx.globalAlpha = 0.94;
      fillRoundRect(ctx, blanketX, blanketY, blanketWidth, blanketHeight, 7, '#d7e6cf');
      fillRoundRect(ctx, blanketX, blanketY, blanketWidth, blanketHeight * 0.32, 6, '#b6d2a8');
      ctx.globalAlpha = 0.5;
      strokeRoundRect(ctx, blanketX + 1, blanketY + 1, blanketWidth - 2, blanketHeight - 2, 6, '#7d9a72', 1.2);
      ctx.restore();

      // Drifting zzz, one letter per beat.
      const beat = (game.time || 0) * 1.6;
      ctx.save();
      ctx.font = '700 15px system-ui, -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(229, 244, 165, 0.92)';
      for (let index = 0; index < 3; index += 1) {
        const phase = (beat + index * 0.38) % 1;
        ctx.globalAlpha = 0.15 + phase * 0.75;
        ctx.fillText(
          'z',
          drawX + width * (0.26 + index * 0.12),
          footY - height * 0.6 - 6 - phase * TILE * 0.5 - index * 4
        );
      }
      ctx.restore();
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
    const homePose = character.homePose;
    const poseAnchor = homePose ? homePoseAnchor(game.homeItems, homePose) : null;
    const asleep = homePose?.kind === 'sleep';
    const sitting = character.pose === 'sit' || homePose?.kind === 'sit';
    const position = game.interpolated(character);
    let footX = (position.x + 0.5) * TILE - game.camera.x;
    let footY = (position.y + 1) * TILE - game.camera.y;
    // The posed sprite renders on the seat/bed and squashes, so the plate
    // follows the drawn top instead of the logical tile.
    if (poseAnchor) {
      footX = (poseAnchor.x + 0.5) * TILE - game.camera.x;
      footY = (poseAnchor.y + 1) * TILE - game.camera.y;
    }
    const spriteHeight = height * (asleep ? 0.52 : sitting ? 0.7 : 1);
    const poseLift = sitting ? height * 0.08 : 0;
    let label = character.name;
    if (character.isPlayer) label = `${character.name} · you`;
    else if (isCompanion) label = `${character.name} · buddy`;

    ctx.save();
    ctx.font = '600 11px system-ui, -apple-system, sans-serif';
    const textWidth = ctx.measureText(label).width;
    const width = textWidth + 16;
    const boxHeight = 22;
    const x = clamp(footX - width / 2, 6, game.width - width - 6);
    const y = footY - spriteHeight - 24 + poseLift + (fx.offsetY || 0);
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

    for (const buddy of game.homeBuddies || []) {
      const position = game.interpolated(buddy);
      mctx.beginPath();
      mctx.arc((position.x + 0.5) * (size / WORLD_SIZE), (position.y + 0.5) * (size / WORLD_SIZE), Math.max(1.8, size / 130), 0, Math.PI * 2);
      mctx.fillStyle = 'rgba(229, 244, 165, 0.7)';
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

    for (const shell of game.forage?.shells || []) {
      mctx.beginPath();
      mctx.arc(
        (shell.x + 0.5) * (size / WORLD_SIZE),
        (shell.y + 0.5) * (size / WORLD_SIZE),
        Math.max(1.4, size / 240),
        0,
        Math.PI * 2
      );
      mctx.fillStyle = 'rgba(247, 230, 205, 0.95)';
      mctx.fill();
    }

    for (const door of game.doors || []) {
      const marker = Math.max(2.5, size / 120);
      mctx.fillStyle = door.kind === 'activity'
        ? 'rgba(182, 227, 124, 0.95)'
        : 'rgba(240, 212, 138, 0.95)';
      mctx.fillRect(
        (door.x + 0.5) * (size / WORLD_SIZE) - marker / 2,
        (door.y + 0.5) * (size / WORLD_SIZE) - marker / 2,
        marker,
        marker
      );
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
