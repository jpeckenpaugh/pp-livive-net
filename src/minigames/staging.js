/**
 * Generic mini-game staging: footprint checks, placement search, seat targets,
 * companion spectators, evacuation, and session-scoped release.
 *
 * Everything here is deterministic. World-touching helpers reuse src/world.js.
 */
import { findOpenTile, findPath, isWalkable, typeAt, WORLD_SIZE } from '../world.js';
import { spectatorOffsets } from '../characters.js';
import { LEFT, RIGHT } from '../facing.js';

const DEFAULT_OFFSETS = Object.freeze([
  { dx: 1, dy: -1 },
  { dx: 1, dy: 0 },
  { dx: 1, dy: -2 },
  { dx: 2, dy: -1 },
  { dx: -3, dy: -1 },
  { dx: -1, dy: 1 },
  { dx: -1, dy: -3 }
]);

export function normalizeBoard(board = {}) {
  return {
    width: Math.max(1, Math.trunc(board.width ?? 1)),
    height: Math.max(1, Math.trunc(board.height ?? 1)),
    margin: Math.max(0, Math.trunc(board.margin ?? 0)),
    blocksMovement: board.blocksMovement !== false,
    hiddenZones: Array.isArray(board.hiddenZones) ? board.hiddenZones : []
  };
}

export function originOf(placement = {}) {
  return {
    x: placement.originX ?? placement.x ?? 0,
    y: placement.originY ?? placement.y ?? 0
  };
}

export function footprintFromPlacement(placement, board) {
  const size = normalizeBoard(board);
  const origin = originOf(placement);
  return { x: origin.x, y: origin.y, width: size.width, height: size.height };
}

export function footprintTiles(footprint) {
  if (!footprint) return [];
  const tiles = [];
  for (let y = footprint.y; y < footprint.y + footprint.height; y++) {
    for (let x = footprint.x; x < footprint.x + footprint.width; x++) {
      tiles.push({ x, y });
    }
  }
  return tiles;
}

function tileWalkable(terrain, x, y) {
  return isWalkable(typeAt(terrain, x, y));
}

/**
 * Check that a board fits inside the world, every board tile is walkable, and
 * the requested margin ring is walkable and free of reserved tiles.
 *
 * @param {{ terrain: string[][], placement: object, board: object, occupied?: Set<string> }} args
 * @returns {{ ok: boolean, reason?: string, footprint?: object, tiles?: Array<{x:number,y:number}> }}
 */
export function validateFootprint({ terrain, placement, board, occupied = null } = {}) {
  if (!board) return { ok: false, reason: 'no-board' };
  if (!terrain) return { ok: false, reason: 'no-terrain' };
  const size = normalizeBoard(board);
  const origin = originOf(placement);
  if (!Number.isInteger(origin.x) || !Number.isInteger(origin.y)) {
    return { ok: false, reason: 'invalid-placement' };
  }

  const minX = origin.x - size.margin;
  const minY = origin.y - size.margin;
  const maxX = origin.x + size.width - 1 + size.margin;
  const maxY = origin.y + size.height - 1 + size.margin;
  if (minX < 0 || minY < 0 || maxX >= WORLD_SIZE || maxY >= WORLD_SIZE) {
    return { ok: false, reason: 'out-of-bounds' };
  }

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      if (!tileWalkable(terrain, x, y)) return { ok: false, reason: 'unwalkable' };
      if (occupied?.has(`${x},${y}`)) return { ok: false, reason: 'occupied' };
    }
  }

  return {
    ok: true,
    footprint: { x: origin.x, y: origin.y, width: size.width, height: size.height },
    tiles: footprintTiles({ x: origin.x, y: origin.y, width: size.width, height: size.height })
  };
}

/**
 * Try candidate origins around a character. Returns null when no candidate fits.
 */
export function findFootprintPlacement({
  terrain,
  board,
  around = { x: 0, y: 0 },
  offsets = DEFAULT_OFFSETS,
  occupied = null
} = {}) {
  for (const offset of offsets) {
    const placement = { originX: around.x + offset.dx, originY: around.y + offset.dy };
    if (validateFootprint({ terrain, placement, board, occupied }).ok) return placement;
  }
  return null;
}

/**
 * Seat anchors around a board. Seat 0 is left, seat 1 right, then alternate
 * outward rows so extra seats never stack on the same tile.
 *
 * @returns {Array<{ seat: number, x: number, y: number, direction: number }>}
 */
export function seatTargets({ placement, board, seats = 2 } = {}) {
  const size = normalizeBoard(board);
  const origin = originOf(placement);
  const centerRow = origin.y + Math.floor((size.height - 1) / 2);
  const targets = [];

  for (let index = 0; index < seats; index++) {
    const left = index % 2 === 0;
    const offset = index < 2
      ? 0
      : (left ? Math.ceil((index - 1) / 2) : -Math.ceil((index - 1) / 2));
    targets.push({
      seat: index,
      x: left ? origin.x - 1 : origin.x + size.width,
      y: centerRow + offset,
      direction: left ? RIGHT : LEFT
    });
  }
  return targets;
}

function currentTile(character) {
  return character.moving
    ? { x: character.toX ?? character.x, y: character.toY ?? character.y }
    : { x: character.x, y: character.y };
}

function walkTo(terrain, character, target) {
  character.moving = false;
  character.inMiniGame = true;
  if (terrain) {
    const from = currentTile(character);
    const path = findPath(terrain, from, target);
    if (path.length) {
      character.path = path;
      return;
    }
  }
  character.x = target.x;
  character.y = target.y;
  character.path = [];
}

/**
 * Move seat characters to their anchors. Accepts seat descriptors or raw
 * characters. Returns the resolved targets.
 */
export function stageSeats({ terrain = null, seats = [], placement, board } = {}) {
  const descriptors = seats.map((seat, index) => (
    seat && seat.character ? { index, character: seat.character } : { index, character: seat }
  )).filter(entry => entry.character);
  const targets = seatTargets({ placement, board, seats: descriptors.length });

  return descriptors.map((entry, index) => {
    const target = targets[index];
    walkTo(terrain, entry.character, target);
    entry.character.direction = target.direction;
    entry.character.miniGameTarget = { x: target.x, y: target.y };
    return { ...target, character: entry.character };
  });
}

/**
 * Stage participant companions as spectators. Offsets come from
 * spectatorOffsets so they spread above and below the left seat instead of
 * piling into one column.
 */
export function stageCompanions({ terrain = null, companions = [], placement, board } = {}) {
  if (!companions.length) return [];
  const size = normalizeBoard(board);
  const origin = originOf(placement);
  const centerRow = origin.y + Math.floor((size.height - 1) / 2);
  const offsets = spectatorOffsets(companions.length);
  const targets = [];

  companions.forEach((companion, index) => {
    if (!companion) return;
    const target = { x: origin.x - 1, y: centerRow + offsets[index], direction: RIGHT };
    companion.fetchTarget = null;
    companion.stagedDestination = { x: target.x, y: target.y };
    companion.inMiniGame = true;
    walkTo(terrain, companion, target);
    companion.direction = target.direction;
    targets.push({ ...target, companion });
  });

  return targets;
}

/**
 * Walk bystanders off newly placed board tiles. Participants and their
 * companions are excluded; everything else escapes to the nearest open tile.
 */
export function evacuateBystanders({
  terrain,
  placement,
  board,
  participants = [],
  characters = [],
  reserved = null
} = {}) {
  if (!terrain || !board) return [];
  const footprint = footprintFromPlacement(placement, board);
  const boardKeys = new Set(footprintTiles(footprint).map(tile => `${tile.x},${tile.y}`));
  const participantSet = new Set(participants.filter(Boolean));
  const reservedKeys = new Set([...boardKeys, ...(reserved || [])]);

  for (const participant of participants) {
    if (!participant) continue;
    reservedKeys.add(`${participant.x},${participant.y}`);
    if (participant.moving) reservedKeys.add(`${participant.toX},${participant.toY}`);
  }

  const evacuated = [];
  for (const character of characters) {
    if (!character || participantSet.has(character)) continue;
    const tile = currentTile(character);
    if (!boardKeys.has(`${tile.x},${tile.y}`)) continue;

    const escape = findOpenTile(terrain, tile, reservedKeys, 1);
    if (!escape || boardKeys.has(`${escape.x},${escape.y}`)) continue;
    reservedKeys.add(`${escape.x},${escape.y}`);

    const path = findPath(terrain, tile, escape);
    if (path.length) character.path = path;
    else {
      character.x = escape.x;
      character.y = escape.y;
      character.path = [];
    }
    character.moving = false;
    evacuated.push({ character, target: escape });
  }

  return evacuated;
}

/**
 * Clear only the state this session touched. Safe to call twice.
 */
export function releaseSession({ participants = [], companions = [] } = {}) {
  const seen = new Set();
  const released = [];

  for (const character of [...participants, ...companions]) {
    if (!character || seen.has(character)) continue;
    seen.add(character);
    character.inMiniGame = false;
    character.miniGameTarget = null;
    character.stagedDestination = null;
    released.push(character);
  }

  return released;
}

export { DEFAULT_OFFSETS };
