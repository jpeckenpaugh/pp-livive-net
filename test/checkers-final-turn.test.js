import test from 'node:test';
import assert from 'node:assert/strict';
import { CheckersMiniGame } from '../src/games/checkers.js';

test('checkers lets the opponent take their last turn before finishing', () => {
  const terrain = Array.from({ length: 64 }, () => Array.from({ length: 64 }, () => 'grass'));
  const player = { id: 'player', x: 13, y: 14, moving: false, path: [] };
  const opponent = { id: 'npc-opp', name: 'Fern', x: 20, y: 14, moving: false, path: [] };
  const game = {
    terrain,
    player,
    npcs: [opponent],
    companions: [],
    getCompanionsFor: () => [],
    getCompanionFor: () => null,
    triggerCheer: () => {}
  };
  const checkers = new CheckersMiniGame({
    game,
    onToast: () => {},
    onGameEnd: () => {},
    onAbandonPrompt: () => {}
  });
  checkers.walkOpponentToSideline = () => {};

  const pieces = Array(64).fill(null);
  // Player jumps an opponent and lands with no forward moves. The opponent
  // still has legal moves, so the game must not finish yet.
  pieces[49] = { side: 'player', king: false };   // row 6 col 1
  pieces[42] = { side: 'opponent', king: false }; // row 5 col 2 (jumped)
  pieces[26] = { side: 'opponent', king: false }; // row 3 col 2 blocks forward
  pieces[28] = { side: 'opponent', king: false }; // row 3 col 4 blocks forward
  pieces[17] = { side: 'opponent', king: false }; // row 2 col 1 blocks a further jump
  pieces[21] = { side: 'opponent', king: false }; // row 2 col 5 blocks a further jump

  checkers.activeBoard = {
    originX: 10,
    originY: 10,
    sidelineX: 18,
    sidelineY: 13,
    playerSidelineX: 9,
    playerSidelineY: 13,
    pieces,
    animatingPiece: null,
    opponent,
    turn: 'player',
    winner: null,
    status: 'playing',
    thinkingTimer: 0,
    multiJumpFrom: null
  };
  // Stand on the landing square after selecting the jumping piece.
  player.x = 10 + 3;
  player.y = 10 + 4;
  checkers.selectedCell = { row: 6, col: 1, index: 49 };

  assert.equal(checkers.handleAction(player), true);
  assert.equal(checkers.activeBoard.status, 'playing', 'must not end before the opponent moves');
  assert.equal(checkers.activeBoard.turn, 'opponent');
  assert.equal(checkers.activeBoard.pieces[35]?.side, 'player');
});
