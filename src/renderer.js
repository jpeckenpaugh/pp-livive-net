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
import {
  homeItem,
  homeItemSize,
  itemColors
} from './home_items.js';
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
  dresser: drawDresser
};

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
    // A full-view activity owns the whole canvas; the Park is not painted.
    if (game.miniGameHost?.renderView?.(this.ctx, {
      width: game.width,
      height: game.height,
      dpr: game.dpr,
      tileSize: TILE
    })) return;
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

    // Ground cover (the rug) sits above the floor and below doors and actors.
    this.drawHomeItemsGround(ctx, game);

    // Travel doors sit above the ground and below every actor, so a character
    // standing in the doorway is drawn in front of it.
    for (const door of game.doors || []) this.drawDoorMarker(ctx, door, game.time);

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
    for (const buddy of game.homeBuddies || []) {
      renderables.push({ type: 'char', y: game.interpolated(buddy).y, entity: buddy });
    }
    // Furniture sorts by its footprint's bottom row, so a tall bed occludes the
    // player behind it and never the player in front. Ground cover is skipped:
    // the rug already drew below every actor.
    for (const entry of game.homeItems || []) {
      const item = homeItem(entry.itemId);
      const size = homeItemSize(entry.itemId, entry.rot);
      if (!item || !size || item.ground) continue;
      renderables.push({
        type: 'home-item',
        y: entry.y + size.h - 1,
        x: entry.x,
        entity: entry
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

    renderables.sort((a, b) => (a.y - b.y) || ((a.x ?? 0) - (b.x ?? 0)));

    for (const item of renderables) {
      if (item.type === 'char') {
        this.drawCharacter(game, item.entity);
      } else if (item.type === 'forage') {
        this.drawForageItem(game, item.entity);
      } else if (item.type === 'home-item') {
        this.drawHomeItem(item.entity);
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

  drawHomeItemsGround(ctx, game) {
    for (const entry of game.homeItems || []) {
      const item = homeItem(entry.itemId);
      if (!item?.ground) continue;
      const bounds = itemBounds(entry);
      if (!bounds) continue;
      ctx.save();
      drawRugShape(ctx, bounds, itemColors(entry.itemId, entry.variant));
      ctx.restore();
    }
  }

  drawHomeItem(entry) {
    const { ctx } = this;
    const item = homeItem(entry.itemId);
    const bounds = itemBounds(entry);
    if (!item || !bounds) return;
    const draw = HOME_ITEM_SHAPES[item.shape] || drawGenericFurniture;
    ctx.save();
    draw(ctx, itemPad(bounds), itemColors(entry.itemId, entry.variant));
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
    const sitting = character.pose === 'sit';
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

    // Home buddies settle with a small squash rather than a new sprite frame.
    if (sitting) offsetY += height * 0.08;
    const scaleX = (animTransform.scaleX ?? 1) * (sitting ? 1.08 : 1);
    const scaleY = (animTransform.scaleY ?? 1) * (sitting ? 0.7 : 1);
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
