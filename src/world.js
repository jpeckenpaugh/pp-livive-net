import worldData from '../data/world.json' with { type: 'json' };

export const WORLD_SIZE = 64;
export const TILE_TYPES = ['grass', 'dirt', 'sand', 'water', 'field', 'home-floor', 'home-wall'];
export const TERRAIN_COLORS = {
  grass: '#4e8950',
  dirt: '#98704a',
  sand: '#d0b876',
  water: '#347da0',
  field: '#82934b',
  'home-floor': '#8a6844',
  'home-wall': '#5c5148'
};

/**
 * Theme keys are location-facing names; tile types are internal. Locations may
 * override any subset in `data/world.json` under `theme`.
 */
const THEME_TILE_KEYS = {
  grass: 'grass',
  dirt: 'dirt',
  sand: 'sand',
  water: 'water',
  field: 'field',
  wall: 'home-wall',
  floor: 'home-floor'
};

export function terrainColorsFor(theme) {
  if (!theme || typeof theme !== 'object') return TERRAIN_COLORS;
  const colors = { ...TERRAIN_COLORS };
  for (const [key, tile] of Object.entries(THEME_TILE_KEYS)) {
    const value = theme[key];
    if (typeof value === 'string' && value) colors[tile] = value;
  }
  return colors;
}

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
  f: 'field',
  h: 'home-floor',
  x: 'home-wall'
};
const TYPE_TO_CHAR = Object.fromEntries(
  Object.entries(CHAR_TO_TYPE).map(([letter, type]) => [type, letter])
);

/** Terrain types that block a step. Water and the Home lot's walls only. */
export const BLOCKING_TILES = ['water', 'home-wall'];

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
  return Boolean(type) && !BLOCKING_TILES.includes(type);
}

export function typeAt(grid, x, y) {
  return inBounds(x, y) ? grid[y][x] : null;
}

export function encodeTerrain(grid) {
  return grid.map(row => row.map(type => TYPE_TO_CHAR[type]).join('')).join('');
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

/* ------------------------------------------------------------------------ *
 * Central Park: a designed 64 × 64 city park rather than a wild meadow.
 * Geometry is algorithmic; the named zones and the amphitheatre rows below
 * are the map. Props (fountain, benches, gate) stay in `data/world.json` so
 * the layout only owns ground, paths, and spawn.
 * ------------------------------------------------------------------------ */

const CENTRAL_PARK = {
  centre: { x: 32, y: 30 },
  plazaRadius: 9.4,
  ring: { inner: 12, outer: 14 },
  lake: { x: 48, y: 16, rx: 8, ry: 6 },
  lakeShore: 1.35,
  playground: { x: 8, y: 10, w: 13, h: 13 },
  stage: { x: 17, y: 42, radius: 3.4 },
  // Lawn cleared for the tiered seating; the tiers themselves are props.
  amphitheatre: { x: 4, y: 45, w: 28, h: 12 },
  flowerBeds: [
    { x: 27, y: 22, rx: 2.4, ry: 1.8 },
    { x: 38, y: 47, rx: 2.6, ry: 2 },
    { x: 53, y: 36, rx: 2.6, ry: 2.2 }
  ],
  picnicSpots: [{ x: 52, y: 45 }, { x: 55, y: 49 }, { x: 24, y: 56 }],
  lodge: { x: 44, y: 47, w: 8, h: 6 },
  spawn: { x: 32, y: 58 }
};

function paintTile(grid, x, y, type, allowed = null) {
  if (!inBounds(x, y)) return;
  if (allowed && !allowed(grid[y][x])) return;
  grid[y][x] = type;
}

function paintRect(grid, { x, y, w, h }, type, allowed = null) {
  for (let ty = y; ty < y + h; ty++) {
    for (let tx = x; tx < x + w; tx++) paintTile(grid, tx, ty, type, allowed);
  }
}

function paintEllipse(grid, shape, type, allowed = null) {
  const rx = Math.max(0.5, shape.rx ?? shape.radius ?? 1);
  const ry = Math.max(0.5, shape.ry ?? shape.radius ?? 1);
  const minX = Math.max(0, Math.floor(shape.x - rx));
  const maxX = Math.min(WORLD_SIZE - 1, Math.ceil(shape.x + rx));
  const minY = Math.max(0, Math.floor(shape.y - ry));
  const maxY = Math.min(WORLD_SIZE - 1, Math.ceil(shape.y + ry));
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const distance = ((x - shape.x) / rx) ** 2 + ((y - shape.y) / ry) ** 2;
      if (distance <= 1) paintTile(grid, x, y, type, allowed);
    }
  }
}

function paintRing(grid, { x, y, inner, outer }, type, allowed = null) {
  for (let ty = 0; ty < WORLD_SIZE; ty++) {
    for (let tx = 0; tx < WORLD_SIZE; tx++) {
      const distance = Math.hypot(tx - x, ty - y);
      if (distance >= inner && distance <= outer) paintTile(grid, tx, ty, type, allowed);
    }
  }
}

/** One-tile-wide gravel link between two path points. */
function paintLine(grid, from, to, type, allowed = null) {
  const steps = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y));
  for (let step = 0; step <= steps; step++) {
    const t = steps ? step / steps : 0;
    paintTile(
      grid,
      Math.round(from.x + (to.x - from.x) * t),
      Math.round(from.y + (to.y - from.y) * t),
      type,
      allowed
    );
  }
}

export function generateCentralPark(seed) {
  const park = CENTRAL_PARK;
  const grid = Array.from({ length: WORLD_SIZE }, () => Array(WORLD_SIZE).fill('grass'));
  // Gravel and lawn paint over open ground, never over water or walls.
  const openGround = type => type === 'grass' || type === 'field' || type === 'sand';

  // Flower beds under the paths: a radial cuts through a bed like a real path.
  for (const bed of park.flowerBeds) paintEllipse(grid, bed, 'field', type => type === 'grass');

  // Lake: a water bowl with a sand shoreline on the grass around it.
  for (let y = 0; y < WORLD_SIZE; y++) {
    for (let x = 0; x < WORLD_SIZE; x++) {
      const distance = ((x - park.lake.x) / park.lake.rx) ** 2
        + ((y - park.lake.y) / park.lake.ry) ** 2;
      if (distance <= 1) grid[y][x] = 'water';
      else if (distance <= park.lakeShore && grid[y][x] === 'grass') grid[y][x] = 'sand';
    }
  }

  // Playground: a broad sand apron in the north-west lawn.
  paintRect(grid, park.playground, 'sand', type => type === 'grass');

  // Central plaza, ring path, and the four radial paths.
  paintEllipse(grid, { ...park.centre, radius: park.plazaRadius }, 'dirt', openGround);
  paintRing(grid, { ...park.centre, ...park.ring }, 'dirt', openGround);
  paintRect(grid, { x: 31, y: 2, w: 2, h: 20 }, 'dirt', openGround); // north
  paintRect(grid, { x: 31, y: 39, w: 2, h: 23 }, 'dirt', openGround); // south
  paintRect(grid, { x: 41, y: 29, w: 23, h: 2 }, 'dirt', openGround); // east
  paintRect(grid, { x: 1, y: 29, w: 23, h: 2 }, 'dirt', openGround); // west

  // The lodge lane hooks off the south walk; the pier walk climbs from the
  // east walk to the lake, and the jetty is shallow sand under the boards.
  paintRect(grid, { x: 47, y: 52, w: 2, h: 5 }, 'dirt', openGround);
  paintRect(grid, { x: 32, y: 55, w: 17, h: 2 }, 'dirt', openGround);
  paintRect(grid, { x: 46, y: 23, w: 2, h: 7 }, 'dirt', openGround);
  paintRect(grid, { x: 47, y: 18, w: 2, h: 5 }, 'sand', type => type === 'water' || type === 'sand');

  // Short spurs tie the playground and the amphitheatre to the ring.
  paintLine(grid, { x: 23, y: 21 }, { x: 20, y: 22 }, 'dirt', openGround);
  paintLine(grid, { x: 23, y: 39 }, { x: 18, y: 42 }, 'dirt', openGround);
  paintEllipse(grid, park.stage, 'dirt', openGround);

  // The spawn is the first open tile inside the south gate; the component is
  // the largest walkable region, exactly like the seeded park.
  const component = largestWalkableComponent(grid);
  const requested = park.spawn;
  const componentKeys = new Set(component.map(cell => `${cell.x},${cell.y}`));
  const spawn = isWalkable(grid[requested.y]?.[requested.x])
    && componentKeys.has(`${requested.x},${requested.y}`)
    ? requested
    : nearestCell(component, requested.x, requested.y);

  // Clear trees off the seating bowl, the lodge, and the picnic spots.
  const keepClear = new Set();
  const amphitheatre = park.amphitheatre;
  for (let y = amphitheatre.y; y < amphitheatre.y + amphitheatre.h; y++) {
    for (let x = amphitheatre.x; x < amphitheatre.x + amphitheatre.w; x++) {
      keepClear.add(`${x},${y}`);
    }
  }
  for (let y = park.lodge.y - 1; y < park.lodge.y + park.lodge.h + 1; y++) {
    for (let x = park.lodge.x - 1; x < park.lodge.x + park.lodge.w + 1; x++) {
      keepClear.add(`${x},${y}`);
    }
  }
  for (const spot of park.picnicSpots) {
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) keepClear.add(`${spot.x + dx},${spot.y + dy}`);
    }
  }

  const scenery = generateScenery(grid, seed, spawn)
    .filter(item => !keepClear.has(`${item.x},${item.y}`));

  return {
    seed,
    grid,
    spawn,
    template: 'central-park',
    component,
    componentKeys,
    scenery
  };
}

/* ------------------------------------------------------------------------ *
 * Town: an east–west grid of streets rather than a single high street.
 *
 *   ring road            perimeter, 2 tiles wide, 1-tile pavements
 *   H1 / H2              y 20–21 and y 42–43, 2 tiles wide
 *   V1 / V2 / V3         x 16–17, x 31–32, x 47–48, 2 tiles wide
 *   high street          y 30–31, the main promenade and crossing
 *   plaza                an ellipse at the centre crossing (31, 31)
 *   cove                 soft sand at the east edge, door to the Beach
 *
 * Ground and spawn only. Every building, bench, lamp, planter, and the
 * fountain are props in `data/world.json`; the `buildings` list below only
 * keeps scenery from growing through a facade.
 * ------------------------------------------------------------------------ */

const TOWN = {
  spawn: { x: 31, y: 35 },
  plaza: { x: 31, y: 31, rx: 6.5, ry: 5 },
  cove: { x: 62, y: 31, rx: 4.5, ry: 7.5 },
  buildings: [
    // Row A — north of H1, fronts facing south onto its pavement.
    { x: 6, y: 15 }, { x: 21, y: 15 }, { x: 36, y: 15 }, { x: 51, y: 15 },
    // Row B — north of the high street, fronts on the y 29 pavement.
    { x: 6, y: 25 }, { x: 21, y: 25 }, { x: 36, y: 25 }, { x: 51, y: 25 },
    // Row C — north of H2, fronts on the y 41 pavement.
    { x: 6, y: 37 }, { x: 21, y: 37 }, { x: 36, y: 37 }, { x: 51, y: 37 }
  ],
  // Two-tile carriageways. Each paints a four-tile sand band first, leaving a
  // one-tile pavement on both sides.
  horizontalStreets: [{ x: 1, y: 20, w: 62, h: 2 }, { x: 1, y: 42, w: 62, h: 2 }],
  verticalStreets: [{ x: 16, y: 1, w: 2, h: 62 }, { x: 31, y: 1, w: 2, h: 62 }, { x: 47, y: 1, w: 2, h: 62 }],
  highStreet: { x: 1, y: 30, w: 62, h: 2 },
  ringStreets: [
    { x: 1, y: 2, w: 62, h: 2 },
    { x: 1, y: 60, w: 62, h: 2 },
    { x: 2, y: 1, w: 2, h: 62 },
    { x: 60, y: 1, w: 2, h: 62 }
  ]
};

/** Grow a one-tile pavement around a street rectangle. */
function pavementOf({ x, y, w, h }) {
  return { x: x - 1, y: y - 1, w: w + 2, h: h + 2 };
}

export function generateTown(seed) {
  const town = TOWN;
  const grid = Array.from({ length: WORLD_SIZE }, () => Array(WORLD_SIZE).fill('grass'));

  // Pavements first so every carriageway, junction, and ring corner is dirt.
  const streets = [...town.ringStreets, ...town.horizontalStreets, ...town.verticalStreets, town.highStreet];
  for (const street of streets) paintRect(grid, pavementOf(street), 'sand');
  for (const street of streets) paintRect(grid, street, 'dirt');

  // A soft sand cove at the east edge swallows the ring road for a stretch;
  // sand is walkable, so the ring still closes around the town.
  paintEllipse(grid, town.plaza, 'dirt');
  paintEllipse(grid, town.cove, 'sand', type => type !== 'water');

  const component = largestWalkableComponent(grid);
  const componentKeys = new Set(component.map(cell => `${cell.x},${cell.y}`));
  const requested = town.spawn;
  const spawn = isWalkable(grid[requested.y]?.[requested.x])
    && componentKeys.has(`${requested.x},${requested.y}`)
    ? requested
    : nearestCell(component, requested.x, requested.y);

  // Keep trees and flowers out of every facade, the plaza, and the cove.
  const keepClear = new Set();
  for (const building of town.buildings) {
    for (let y = building.y - 1; y < building.y + 5; y++) {
      for (let x = building.x - 1; x < building.x + 7; x++) keepClear.add(`${x},${y}`);
    }
  }
  const plaza = town.plaza;
  for (let y = Math.floor(plaza.y - plaza.ry - 1); y <= Math.ceil(plaza.y + plaza.ry + 1); y++) {
    for (let x = Math.floor(plaza.x - plaza.rx - 1); x <= Math.ceil(plaza.x + plaza.rx + 1); x++) {
      const distance = ((x - plaza.x) / (plaza.rx + 1)) ** 2
        + ((y - plaza.y) / (plaza.ry + 1)) ** 2;
      if (distance <= 1) keepClear.add(`${x},${y}`);
    }
  }
  for (let y = Math.floor(town.cove.y - town.cove.ry); y <= Math.ceil(town.cove.y + town.cove.ry); y++) {
    for (let x = Math.floor(town.cove.x - town.cove.rx); x <= Math.ceil(town.cove.x + town.cove.rx); x++) {
      keepClear.add(`${x},${y}`);
    }
  }

  // The streets are busy, so the town keeps a lighter scatter than the meadow.
  const random = mulberry32(hashString(`town-scenery:${seed}`));
  const scenery = generateScenery(grid, seed, spawn)
    .filter(item => !keepClear.has(`${item.x},${item.y}`))
    .filter(() => random() < 0.4)
    .sort((a, b) => a.y - b.y);

  return {
    seed,
    grid,
    spawn,
    template: 'town',
    layout: 'town-grid',
    component,
    componentKeys,
    scenery
  };
}

/* ------------------------------------------------------------------------ *
 * Beach: a 64 × 64 shore. Land and a long boardwalk sit on the west; the sea
 * curls across the east edge with a wet shallow band at the waterline. The
 * pier and its sandy jetty are the only walkable ground in the water. Ground
 * and spawn only: palms, umbrellas, benches, and the pier are props in
 * `data/world.json`.
 * ------------------------------------------------------------------------ */

const BEACH = {
  shoreBase: 46,
  shoreAmpA: 4,
  shoreFreqA: 0.16,
  shoreAmpB: 2,
  shoreFreqB: 0.09,
  shorePhaseB: 1.1,
  shallowBand: 2,
  boardwalk: { x: 1, y: 30, w: 34, h: 2 },
  jetty: { x: 38, y: 30, w: 11, h: 2 },
  spawn: { x: 5, y: 31 }
};

/** The curved waterline for one row; land is west of it. */
export function beachShoreline(y) {
  return BEACH.shoreBase
    + Math.sin(y * BEACH.shoreFreqA) * BEACH.shoreAmpA
    + Math.sin(y * BEACH.shoreFreqB + BEACH.shorePhaseB) * BEACH.shoreAmpB;
}

export function generateBeach(seed) {
  const beach = BEACH;
  const grid = Array.from({ length: WORLD_SIZE }, () => Array(WORLD_SIZE).fill('sand'));

  // Sand runs from the west edge to the curved waterline. The two tiles just
  // past it are the wet shallow band; deep water starts beyond that.
  for (let y = 0; y < WORLD_SIZE; y++) {
    const edge = beachShoreline(y);
    for (let x = 0; x < WORLD_SIZE; x++) {
      if (x > edge + beach.shallowBand) grid[y][x] = 'water';
    }
  }

  // Boardwalk from the Town gate out onto the sand.
  paintRect(grid, beach.boardwalk, 'dirt', type => type === 'sand');
  // A sandy jetty under the pier keeps the boards walkable over the water.
  paintRect(grid, beach.jetty, 'sand', type => type === 'water' || type === 'sand');

  const component = largestWalkableComponent(grid);
  const componentKeys = new Set(component.map(cell => `${cell.x},${cell.y}`));
  const requested = beach.spawn;
  const spawn = isWalkable(grid[requested.y]?.[requested.x])
    && componentKeys.has(`${requested.x},${requested.y}`)
    ? requested
    : nearestCell(component, requested.x, requested.y);

  return {
    seed,
    grid,
    spawn,
    template: 'beach',
    component,
    componentKeys,
    // Sand does not grow the Park's trees and flowers; the beach look lives in
    // its location props instead.
    scenery: []
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

/**
 * Build the Home lot: a 64×64 grassy yard with one modest room in the middle.
 *
 * The house is real terrain rather than scenery: `home-wall` is unwalkable and
 * `home-floor` is walkable, so the room needs no new collision rules. The door
 * tile is carved out of the wall as floor, which keeps the yard and the room in
 * one walkable component. Layout comes from `data/world.json`, so no coordinate
 * is hardcoded here.
 */
export function generateHome(seed, spec = worldData.locations.home) {
  const house = spec?.house || { x: 24, y: 22, width: 17, height: 17 };
  const door = spec?.door || { x: 32, y: 38, to: 'park' };
  const spawnSpec = spec?.spawn || { x: 32, y: 36 };
  const maxX = house.x + house.width - 1;
  const maxY = house.y + house.height - 1;

  const grid = [];
  for (let y = 0; y < WORLD_SIZE; y++) {
    const row = [];
    for (let x = 0; x < WORLD_SIZE; x++) row.push('grass');
    grid.push(row);
  }

  for (let y = house.y; y <= maxY; y++) {
    for (let x = house.x; x <= maxX; x++) {
      const onWall = x === house.x || x === maxX || y === house.y || y === maxY;
      grid[y][x] = onWall ? 'home-wall' : 'home-floor';
    }
  }

  // The doorway is part of the wall line but walkable floor.
  if (inBounds(door.x, door.y)) grid[door.y][door.x] = 'home-floor';

  // A short dirt path from the door into the yard reads as an entrance.
  for (let y = door.y + 1; y <= Math.min(WORLD_SIZE - 1, door.y + 8); y++) {
    for (let x = door.x - 1; x <= door.x + 1; x++) {
      if (!inBounds(x, y) || grid[y][x] !== 'grass') continue;
      grid[y][x] = 'dirt';
    }
  }

  const component = largestWalkableComponent(grid);
  const safeComponent = component.length ? component : [{ x: door.x, y: door.y }];
  const requested = {
    x: clampTile(spawnSpec.x),
    y: clampTile(spawnSpec.y)
  };
  const spawn = isWalkable(grid[requested.y][requested.x])
    && safeComponent.some(cell => cell.x === requested.x && cell.y === requested.y)
    ? requested
    : nearestCell(safeComponent, requested.x, requested.y);

  return {
    seed,
    grid,
    spawn,
    house,
    door: { x: door.x, y: door.y, to: door.to || 'park' },
    component: safeComponent,
    componentKeys: new Set(safeComponent.map(cell => `${cell.x},${cell.y}`)),
    scenery: generateScenery(grid, seed, spawn)
  };
}

function clampTile(value) {
  return Math.max(0, Math.min(WORLD_SIZE - 1, Math.round(Number(value) || 0)));
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
