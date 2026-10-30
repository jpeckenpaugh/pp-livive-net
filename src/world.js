export const WORLD_SIZE = 64;
export const TILE_TYPES = ['grass', 'dirt', 'sand', 'water', 'field'];
export const TERRAIN_COLORS = {
  grass: '#4e8950',
  dirt: '#98704a',
  sand: '#d0b876',
  water: '#347da0',
  field: '#82934b'
};

export const DIRS = [
  { dx: 0, dy: 1, dir: 0 },
  { dx: 1, dy: 0, dir: 1 },
  { dx: 0, dy: -1, dir: 2 },
  { dx: -1, dy: 0, dir: 3 }
];

const CHAR_TO_TYPE = {
  g: 'grass',
  d: 'dirt',
  s: 'sand',
  w: 'water',
  f: 'field'
};

export function hashString(value) {
  let hash = 2166136261;
  const text = String(value);
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeSeed() {
  const words = ['fern', 'moss', 'clover', 'pebble', 'acorn', 'willow', 'bramble', 'daisy', 'maple', 'cricket'];
  const word = words[Math.floor(Math.random() * words.length)];
  return `${word}-${Math.random().toString(36).slice(2, 9)}`;
}

function smooth(t) {
  return t * t * (3 - 2 * t);
}

function makeNoise(random, size) {
  const values = new Float32Array(size * size);
  for (let i = 0; i < values.length; i++) values[i] = random();

  return function sample(u, v) {
    const x = u * (size - 1);
    const y = v * (size - 1);
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const x1 = Math.min(size - 1, x0 + 1);
    const y1 = Math.min(size - 1, y0 + 1);
    const tx = smooth(x - x0);
    const ty = smooth(y - y0);
    const top = values[y0 * size + x0] * (1 - tx) + values[y0 * size + x1] * tx;
    const bottom = values[y1 * size + x0] * (1 - tx) + values[y1 * size + x1] * tx;
    return top * (1 - ty) + bottom * ty;
  };
}

function inBounds(x, y) {
  return x >= 0 && y >= 0 && x < WORLD_SIZE && y < WORLD_SIZE;
}

export function isWalkable(type) {
  return Boolean(type) && type !== 'water';
}

export function typeAt(grid, x, y) {
  return inBounds(x, y) ? grid[y][x] : null;
}

export function encodeTerrain(grid) {
  return grid.map(row => row.map(type => type[0]).join('')).join('');
}

export function decodeTerrain(encoded) {
  if (typeof encoded !== 'string' || encoded.length !== WORLD_SIZE * WORLD_SIZE) return null;
  const grid = [];
  for (let y = 0; y < WORLD_SIZE; y++) {
    const row = [];
    for (let x = 0; x < WORLD_SIZE; x++) {
      const type = CHAR_TO_TYPE[encoded[y * WORLD_SIZE + x]];
      if (!type) return null;
      row.push(type);
    }
    grid.push(row);
  }
  return grid;
}

function largestWalkableComponent(grid) {
  const seen = new Uint8Array(WORLD_SIZE * WORLD_SIZE);
  let best = [];

  for (let y = 0; y < WORLD_SIZE; y++) {
    for (let x = 0; x < WORLD_SIZE; x++) {
      const index = y * WORLD_SIZE + x;
      if (seen[index] || !isWalkable(grid[y][x])) continue;
      const queue = [{ x, y }];
      const cells = [];
      seen[index] = 1;
      while (queue.length) {
        const cell = queue.pop();
        cells.push(cell);
        for (const { dx, dy } of DIRS) {
          const nx = cell.x + dx;
          const ny = cell.y + dy;
          if (!inBounds(nx, ny)) continue;
          const nextIndex = ny * WORLD_SIZE + nx;
          if (seen[nextIndex] || !isWalkable(grid[ny][nx])) continue;
          seen[nextIndex] = 1;
          queue.push({ x: nx, y: ny });
        }
      }
      if (cells.length > best.length) best = cells;
    }
  }

  return best;
}

function nearestCell(cells, cx, cy) {
  let best = cells[0];
  let bestScore = Infinity;
  for (const cell of cells) {
    const dx = cell.x - cx;
    const dy = cell.y - cy;
    const score = dx * dx + dy * dy;
    if (score < bestScore) {
      bestScore = score;
      best = cell;
    }
  }
  return best;
}

function paintPath(grid, points) {
  for (const { x, y } of points) {
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1]]) {
      const nx = x + dx;
      const ny = y + dy;
      if (inBounds(nx, ny) && isWalkable(grid[ny][nx])) grid[ny][nx] = 'dirt';
    }
  }
}

export function generateWorld(seed) {
  const random = mulberry32(hashString(seed));
  const elevationA = makeNoise(random, 5);
  const elevationB = makeNoise(random, 10);
  const elevationC = makeNoise(random, 20);
  const meadowNoise = makeNoise(random, 8);

  const grid = [];
  for (let y = 0; y < WORLD_SIZE; y++) {
    const row = [];
    for (let x = 0; x < WORLD_SIZE; x++) {
      const u = (x + 0.5) / WORLD_SIZE;
      const v = (y + 0.5) / WORLD_SIZE;
      let elevation =
        elevationA(u, v) * 0.52 +
        elevationB(u, v) * 0.3 +
        elevationC(u, v) * 0.18;
      elevation = (elevation - 0.5) * 1.55 + 0.5;

      const meadow = meadowNoise(u, v);
      let type;
      if (elevation < 0.34) type = 'water';
      else if (elevation < 0.4) type = 'sand';
      else if (meadow > 0.63 && elevation > 0.48 && meadow < 0.73) type = 'field';
      else type = 'grass';
      row.push(type);
    }
    grid.push(row);
  }

  // Two winding paths and a little central clearing give the park a shape.
  const horizontal = [];
  for (let x = 0; x < WORLD_SIZE; x++) {
    const y = Math.round(32 + Math.sin(x * 0.17) * 6 + Math.sin(x * 0.43) * 1.6);
    horizontal.push({ x, y });
  }
  const vertical = [];
  for (let y = 0; y < WORLD_SIZE; y++) {
    const x = Math.round(31 + Math.sin(y * 0.14) * 6.5 + Math.sin(y * 0.39) * 1.4);
    vertical.push({ x, y });
  }
  paintPath(grid, horizontal);
  paintPath(grid, vertical);

  const plaza = [];
  for (let y = 0; y < WORLD_SIZE; y++) {
    for (let x = 0; x < WORLD_SIZE; x++) {
      if (Math.hypot(x - 32, y - 32) <= 3.6) plaza.push({ x, y });
    }
  }
  paintPath(grid, plaza);

  const component = largestWalkableComponent(grid);
  const safeComponent = component.length ? component : (() => {
    for (let y = 24; y < 40; y++) for (let x = 24; x < 40; x++) grid[y][x] = 'grass';
    return largestWalkableComponent(grid);
  })();
  const safeSpawn = nearestCell(safeComponent, 32, 32);

  return {
    seed,
    grid,
    spawn: safeSpawn,
    component: safeComponent,
    componentKeys: new Set(safeComponent.map(cell => `${cell.x},${cell.y}`)),
    scenery: generateScenery(grid, seed, safeSpawn)
  };
}

export function generateScenery(grid, seed, spawn = { x: 32, y: 32 }) {
  const random = mulberry32(hashString(`scenery:${seed}`));
  const types = [
    'apple-tree',
    'puffy-tree',
    'chestnut-tree',
    'rounded-bush',
    'flowering-bush',
    'rock-boulder',
    'mushroom',
    'mushroom-cluster',
    'flower-red',
    'grass-tuft'
  ];
  const items = [];
  const occupied = new Set([`${spawn.x},${spawn.y}`]);

  // Scatter 60-80 scenery items (trees, bushes, rocks, flowers, mushrooms, grass) across grass and field tiles
  const targetCount = 60 + Math.floor(random() * 25);
  let attempts = 0;

  while (items.length < targetCount && attempts < 1200) {
    attempts++;
    const x = Math.floor(random() * WORLD_SIZE);
    const y = Math.floor(random() * WORLD_SIZE);
    const key = `${x},${y}`;

    if (occupied.has(key)) continue;
    if (Math.hypot(x - spawn.x, y - spawn.y) < 3) continue;

    const tile = grid[y]?.[x];
    // Place on grass or flower fields (not dirt paths or water)
    if (tile !== 'grass' && tile !== 'field') continue;

    const type = types[Math.floor(random() * types.length)];
    const isTree = type.includes('tree');
    const isBushOrRock = type.includes('bush') || type.includes('rock');
    
    // Scale variation appropriate for each asset category
    let scale;
    if (isTree) {
      scale = 0.85 + random() * 0.3;
    } else if (isBushOrRock) {
      scale = 0.8 + random() * 0.25;
    } else {
      // Ground cover (mushrooms, flowers, grass tufts)
      scale = 0.75 + random() * 0.3;
    }

    // Only trees and large boulders block pathfinding; flowers, grass, mushrooms, bushes are walkable
    const isObstacle = isTree || type === 'rock-boulder';

    items.push({
      id: `scenery-${items.length}`,
      type,
      x,
      y,
      scale,
      isObstacle
    });

    occupied.add(key);
  }

  // Sort by Y so they draw with natural depth
  items.sort((a, b) => a.y - b.y);
  return items;
}

export function largestComponentFrom(grid) {
  return largestWalkableComponent(grid);
}

export function walkableNeighbors(grid, x, y) {
  const result = [];
  for (const step of DIRS) {
    const nx = x + step.dx;
    const ny = y + step.dy;
    if (inBounds(nx, ny) && isWalkable(grid[ny][nx])) {
      result.push({ x: nx, y: ny, dir: step.dir });
    }
  }
  return result;
}

export function findOpenTile(grid, origin, occupied = new Set(), minDistance = 1) {
  const start = {
    x: Math.max(0, Math.min(WORLD_SIZE - 1, Math.round(Number(origin.x) || 0))),
    y: Math.max(0, Math.min(WORLD_SIZE - 1, Math.round(Number(origin.y) || 0)))
  };
  const queue = [start];
  const seen = new Set([`${start.x},${start.y}`]);
  let fallback = null;

  while (queue.length) {
    const cell = queue.shift();
    const key = `${cell.x},${cell.y}`;
    const distance = Math.abs(cell.x - start.x) + Math.abs(cell.y - start.y);
    if (isWalkable(typeAt(grid, cell.x, cell.y)) && !occupied.has(key)) {
      if (!fallback) fallback = cell;
      if (distance >= minDistance) return cell;
    }
    for (const { dx, dy } of DIRS) {
      const nx = cell.x + dx;
      const ny = cell.y + dy;
      const nextKey = `${nx},${ny}`;
      if (!inBounds(nx, ny) || seen.has(nextKey) || !isWalkable(grid[ny][nx])) continue;
      seen.add(nextKey);
      queue.push({ x: nx, y: ny });
    }
  }

  return fallback || start;
}

/**
 * BFS over walkable tiles. Pass `{ fly: true }` to let a path cross water (the
 * Glider Wings effect); out-of-bounds tiles are still refused.
 */
export function findPath(grid, from, to, blocked = null, options = {}) {
  const fly = Boolean(options && options.fly);
  const canStand = (x, y) => {
    const type = typeAt(grid, x, y);
    return type !== null && (isWalkable(type) || fly);
  };
  if (!canStand(to.x, to.y) || !canStand(from.x, from.y)) return [];
  if (from.x === to.x && from.y === to.y) return [];
  if (blocked?.has(`${to.x},${to.y}`)) return [];

  const width = WORLD_SIZE;
  const prev = new Int32Array(width * WORLD_SIZE).fill(-1);
  const seen = new Uint8Array(width * WORLD_SIZE);
  const queue = [from.y * width + from.x];
  const startIndex = queue[0];
  const targetIndex = to.y * width + to.x;
  seen[startIndex] = 1;
  let head = 0;

  while (head < queue.length) {
    const index = queue[head++];
    if (index === targetIndex) break;
    const x = index % width;
    const y = (index / width) | 0;
    for (const { dx, dy } of DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      if (!inBounds(nx, ny) || !canStand(nx, ny)) continue;
      if (blocked?.has(`${nx},${ny}`)) continue;
      const nextIndex = ny * width + nx;
      if (seen[nextIndex]) continue;
      seen[nextIndex] = 1;
      prev[nextIndex] = index;
      queue.push(nextIndex);
    }
  }

  if (!seen[targetIndex]) return [];
  const path = [];
  let cursor = targetIndex;
  while (cursor !== startIndex && cursor !== -1) {
    path.push({ x: cursor % width, y: (cursor / width) | 0 });
    cursor = prev[cursor];
  }
  return path.reverse();
}
