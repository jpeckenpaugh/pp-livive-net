import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BOARD_WEIGHT,
  NARROW_BOARD_WEIGHT,
  NARROW_MAX_WIDTH,
  focusOptionsFor,
  focusPointFor
} from '../src/camera-focus.js';
import { Game, TILE } from '../src/game.js';

const BOARD = { x: 20, y: 20, width: 3, height: 3 };

function tileFocus(x, y) {
  return { x: (x + 0.5) * TILE, y: (y + 0.5) * TILE };
}

test('focus options favour the player and drop the board clamp on narrow screens', () => {
  assert.deepEqual(focusOptionsFor(1200), { weight: BOARD_WEIGHT, clampBoard: true });
  assert.deepEqual(focusOptionsFor(NARROW_MAX_WIDTH + 1), { weight: BOARD_WEIGHT, clampBoard: true });
  assert.deepEqual(focusOptionsFor(NARROW_MAX_WIDTH), { weight: NARROW_BOARD_WEIGHT, clampBoard: false });
  assert.deepEqual(focusOptionsFor(360), { weight: NARROW_BOARD_WEIGHT, clampBoard: false });
  assert.deepEqual(focusOptionsFor(Number.NaN), { weight: BOARD_WEIGHT, clampBoard: true });
});

test('without a board the camera keeps following the player', () => {
  assert.deepEqual(focusPointFor({ player: { x: 10, y: 10 } }), tileFocus(10, 10));
  assert.deepEqual(focusPointFor({ player: { x: 10, y: 10 }, board: null }), tileFocus(10, 10));
  assert.equal(focusPointFor({ player: null }), null);
  assert.equal(focusPointFor(), null);
});

test('a malformed board falls back to the player focus', () => {
  const player = { x: 10, y: 10 };
  assert.deepEqual(
    focusPointFor({ player, board: { x: 5, y: 5, width: 0, height: 3 } }),
    tileFocus(10, 10)
  );
  assert.deepEqual(
    focusPointFor({ player, board: { x: 5, y: NaN, width: 3, height: 3 } }),
    tileFocus(10, 10)
  );
});

test('desktop blends player and board centre equally', () => {
  const focus = focusPointFor({
    player: { x: 10, y: 10 },
    board: BOARD,
    viewportWidth: 1200,
    viewportHeight: 800,
    weight: BOARD_WEIGHT,
    clampBoard: false
  });
  // Player 504/504, board centre 1032/1032, midpoint 768/768.
  assert.deepEqual(focus, { x: 768, y: 768 });
});

test('the board clamp wins when the player walks far away', () => {
  const focus = focusPointFor({
    player: { x: 60, y: 60 },
    board: { x: 10, y: 10, width: 3, height: 3 },
    viewportWidth: 1200,
    viewportHeight: 800,
    weight: BOARD_WEIGHT,
    clampBoard: true
  });
  // The blended point (1728/1728) is pushed back to the board-safe edge.
  assert.deepEqual(focus, { x: 1080, y: 880 });

  // That focus keeps every board tile inside the viewport.
  const board = { x: 10 * TILE, y: 10 * TILE, width: 3 * TILE, height: 3 * TILE };
  const camera = { x: focus.x - 1200 / 2, y: focus.y - 800 / 2 };
  assert.ok(board.x >= camera.x);
  assert.ok(board.x + board.width <= camera.x + 1200);
  assert.ok(board.y >= camera.y);
  assert.ok(board.y + board.height <= camera.y + 800);
});

test('the clamp also holds on the opposite edge', () => {
  const focus = focusPointFor({
    player: { x: 0, y: 0 },
    board: { x: 10, y: 10, width: 3, height: 3 },
    viewportWidth: 1200,
    viewportHeight: 800,
    weight: BOARD_WEIGHT,
    clampBoard: true
  });
  assert.deepEqual(focus, { x: 288, y: 288 });
});

test('narrow screens keep the player prominent and skip the board clamp', () => {
  const player = { x: 1, y: 1 };
  const board = { x: 10, y: 10, width: 8, height: 8 };
  const options = focusOptionsFor(360);
  const focus = focusPointFor({
    player,
    board,
    viewportWidth: 360,
    viewportHeight: 640,
    weight: options.weight,
    clampBoard: options.clampBoard
  });
  // Player 72/72, board centre 672/672, 0.25 blend => 222/222.
  assert.deepEqual(focus, { x: 222, y: 222 });

  // The clamped desktop path would have shifted focus onto the board.
  const clamped = focusPointFor({
    player,
    board,
    viewportWidth: 360,
    viewportHeight: 640,
    weight: options.weight,
    clampBoard: true
  });
  assert.ok(clamped.x > focus.x);
  assert.ok(clamped.y > focus.y);
});

test('a board wider than the viewport centres instead of producing an empty clamp', () => {
  const focus = focusPointFor({
    player: { x: 60, y: 60 },
    board: { x: 10, y: 10, width: 8, height: 8 },
    viewportWidth: 360,
    viewportHeight: 300,
    weight: BOARD_WEIGHT,
    clampBoard: true
  });
  // Board centre in pixels, since no focus can show all eight columns.
  assert.equal(focus.x, (10 + 4) * TILE);
  assert.equal(focus.y, (10 + 4) * TILE);
});

test('weights outside 0..1 are clamped', () => {
  const player = { x: 10, y: 10 };
  const board = { x: 20, y: 20, width: 3, height: 3 };
  assert.deepEqual(
    focusPointFor({ player, board, weight: -3, clampBoard: false }),
    tileFocus(10, 10)
  );
  assert.deepEqual(
    focusPointFor({ player, board, weight: 4, clampBoard: false }),
    { x: (20 + 1.5) * TILE, y: (20 + 1.5) * TILE }
  );
});

test('Game snaps on open only when the player is off the board', () => {
  const game = new Game();
  game.width = 1200;
  game.height = 800;
  game.camera = { x: 0, y: 0 };
  game.player = { x: 10, y: 10, moving: false, fromX: 10, fromY: 10, toX: 10, toY: 10, elapsed: 0, duration: 1 };

  game.cameraSnap = false;
  game.setCameraTarget({ x: 20, y: 20, width: 3, height: 3 });
  assert.equal(game.cameraSnap, true, 'opening away from the board snaps once');
  assert.deepEqual(game.cameraTarget, { x: 20, y: 20, width: 3, height: 3 });

  game.cameraSnap = false;
  game.setCameraTarget({ x: 10, y: 10, width: 3, height: 3 });
  assert.equal(game.cameraSnap, false, 'a session already open never re-snaps');
  assert.deepEqual(game.cameraTarget, { x: 10, y: 10, width: 3, height: 3 });
});

test('Game blends the focus while a target is set and eases back after close', () => {
  const game = new Game();
  game.width = 1200;
  game.height = 800;
  game.camera = { x: 0, y: 0 };
  game.player = { x: 60, y: 60, moving: false, fromX: 60, fromY: 60, toX: 60, toY: 60, elapsed: 0, duration: 1 };
  game.setCameraTarget({ x: 10, y: 10, width: 3, height: 3 });

  // Camera-safe focus 1080/880 => tile-space 22/17.8333.
  const blended = game.cameraFocus();
  assert.ok(Math.abs(blended.x - (1080 / TILE - 0.5)) < 1e-9);
  assert.ok(Math.abs(blended.y - (880 / TILE - 0.5)) < 1e-9);

  game.cameraSnap = true;
  game.updateCamera(0.016);
  const settled = { x: game.camera.x, y: game.camera.y };
  assert.deepEqual(settled, { x: 480, y: 480 });

  game.clearCameraTarget();
  assert.deepEqual(game.cameraFocus(), { x: 60, y: 60 });
  game.updateCamera(0.016);
  assert.ok(game.camera.x > settled.x, 'the camera eases toward the player, never jumps');
  assert.ok(game.camera.x < 1872, 'one frame cannot complete the return');
});

test('the camera target clears with a new world', () => {
  const game = new Game();
  game.cameraTarget = { x: 1, y: 2, width: 3, height: 4 };
  game.setPreview(Array.from({ length: 64 }, () => Array.from({ length: 64 }, () => 'grass')), 1);
  assert.equal(game.cameraTarget, null);
});
