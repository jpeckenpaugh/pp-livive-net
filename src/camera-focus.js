/**
 * Pure camera framing math for in-world board sessions.
 *
 * A board has no UI of its own, so the camera has to keep the shared-world
 * board readable while still leaving the player legible. The focus point is a
 * weighted blend of the player and the board centre; on wide screens the
 * result is clamped so the whole board rectangle fits in the viewport.
 * Narrow screens deliberately drop the clamp and favour the player, because an
 * 8x8 board is wider than the screen and no clamp can satisfy both.
 */

export const NARROW_MAX_WIDTH = 520;
export const BOARD_WEIGHT = 0.5;
export const NARROW_BOARD_WEIGHT = 0.25;
export const DEFAULT_TILE = 48;

/** Blend weight and clamp policy for a viewport width. */
export function focusOptionsFor(viewportWidth) {
  const width = Number(viewportWidth);
  const narrow = Number.isFinite(width) && width <= NARROW_MAX_WIDTH;
  return narrow
    ? { weight: NARROW_BOARD_WEIGHT, clampBoard: false }
    : { weight: BOARD_WEIGHT, clampBoard: true };
}

function clamp(value, min, max) {
  if (min > max) return (min + max) / 2;
  return Math.max(min, Math.min(max, value));
}

function isRectangle(rect) {
  return Boolean(rect)
    && Number.isFinite(rect.x)
    && Number.isFinite(rect.y)
    && Number.isFinite(rect.width)
    && Number.isFinite(rect.height)
    && rect.width > 0
    && rect.height > 0;
}

/**
 * Clamp one focus axis so the board's whole span stays inside the viewport.
 * A board larger than the viewport cannot satisfy that, so it is centred on
 * the board instead (the narrow-screen path skips this function entirely).
 */
function clampAxis(focus, boardStart, boardSize, viewportSize) {
  const min = boardStart + boardSize - viewportSize / 2;
  const max = boardStart + viewportSize / 2;
  return clamp(focus, min, max);
}

/**
 * Resolve the world-pixel point the camera should centre on.
 *
 * @param {{
 *   player?: { x: number, y: number } | null,
 *   board?: { x: number, y: number, width: number, height: number } | null,
 *   viewportWidth?: number,
 *   viewportHeight?: number,
 *   tile?: number,
 *   weight?: number,
 *   clampBoard?: boolean
 * }} options
 * @returns {{ x: number, y: number } | null} focus point in world pixels
 */
export function focusPointFor({
  player = null,
  board = null,
  viewportWidth = 0,
  viewportHeight = 0,
  tile = DEFAULT_TILE,
  weight = BOARD_WEIGHT,
  clampBoard = false
} = {}) {
  if (!player || !Number.isFinite(player.x) || !Number.isFinite(player.y)) return null;

  const tileSize = Number.isFinite(tile) && tile > 0 ? tile : DEFAULT_TILE;
  const viewWidth = Number.isFinite(viewportWidth) ? Math.max(0, viewportWidth) : 0;
  const viewHeight = Number.isFinite(viewportHeight) ? Math.max(0, viewportHeight) : 0;
  const playerFocus = {
    x: (player.x + 0.5) * tileSize,
    y: (player.y + 0.5) * tileSize
  };

  if (!isRectangle(board)) return playerFocus;

  const boardFocus = {
    x: (board.x + board.width / 2) * tileSize,
    y: (board.y + board.height / 2) * tileSize
  };
  const blend = Number.isFinite(weight) ? clamp(weight, 0, 1) : BOARD_WEIGHT;
  const focus = {
    x: playerFocus.x + (boardFocus.x - playerFocus.x) * blend,
    y: playerFocus.y + (boardFocus.y - playerFocus.y) * blend
  };

  if (!clampBoard) return focus;

  return {
    x: clampAxis(focus.x, board.x * tileSize, board.width * tileSize, viewWidth),
    y: clampAxis(focus.y, board.y * tileSize, board.height * tileSize, viewHeight)
  };
}
