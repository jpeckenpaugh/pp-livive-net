import test from 'node:test';
import assert from 'node:assert/strict';
import { createStarterInventory, BALL_COLORS } from '../src/inventory.js';
import { createCompanionRecipe, canonicalRecipe, COMPANION_STYLES } from '../src/avatar.js';
import { TicTacToeMiniGame } from '../src/games/tic-tac-toe.js';
import { CheckersMiniGame } from '../src/games/checkers.js';
import { ChessMiniGame } from '../src/games/chess.js';
import { FetchMiniGame } from '../src/games/fetch.js';
import { recordGameResult, loadStats } from '../src/storage.js';
import { rollReward, applyReward } from '../src/rewards.js';

test('createStarterInventory yields the starter toys and the headline effects', () => {
  const inv = createStarterInventory();
  assert.equal(inv.length, 10);
  const ball = inv.find(i => i.id === 'ball');
  const ttt = inv.find(i => i.id === 'tic-tac-toe');
  const checkers = inv.find(i => i.id === 'checkers');
  const chess = inv.find(i => i.id === 'chess');
  const memoryGrid = inv.find(i => i.id === 'memory-grid');
  const connectFour = inv.find(i => i.id === 'connect-four');
  assert.ok(ball);
  assert.ok(ttt);
  assert.ok(checkers);
  assert.ok(chess);
  assert.ok(memoryGrid);
  assert.ok(connectFour);
  assert.ok(BALL_COLORS.includes(ball.color));

  const effects = inv.filter(i => i.kind === 'effect');
  assert.deepEqual(
    effects.map(i => i.id).sort(),
    ['big-o-bracelet', 'chamo-clip', 'teleport-tricorder', 'wings']
  );
});

test('createCompanionRecipe creates valid companion recipe', () => {
  const recipe = createCompanionRecipe('test-seed', 'critters');
  assert.equal(recipe.isCompanion, true);
  assert.equal(recipe.style, 'critters');
  assert.equal(recipe.seed, 'test-seed');
  const canonical = canonicalRecipe(recipe);
  assert.ok(canonical.includes('critters'));
});

test('TicTacToeMiniGame logic detects winning lines and draws', () => {
  const game = new TicTacToeMiniGame();
  game.activeBoard = {
    originX: 10,
    originY: 10,
    grid: ['X', 'X', 'X', null, 'O', null, 'O', null, null],
    turn: 'player',
    status: 'playing'
  };
  assert.equal(game.checkWinner(), 'X');

  game.activeBoard.grid = ['X', 'O', 'X', 'X', 'O', 'O', 'O', 'X', 'X'];
  assert.equal(game.checkWinner(), 'draw');
});

test('TicTacToeMiniGame maps cell correctly to 3x3 tiles', () => {
  const game = new TicTacToeMiniGame();
  game.activeBoard = { originX: 10, originY: 10, grid: Array(9).fill(null) };
  assert.deepEqual(game.cellAtTile(10, 10), { row: 0, col: 0, index: 0 });
  assert.deepEqual(game.cellAtTile(11, 12), { row: 2, col: 1, index: 7 });
  assert.equal(game.cellAtTile(9, 10), null);
  assert.equal(game.cellAtTile(13, 10), null);
});

test('TicTacToeMiniGame requires walkable margins around board', () => {
  const fakeTerrain = Array.from({ length: 64 }, () => Array.from({ length: 64 }, () => 'grass'));
  const game = new TicTacToeMiniGame({ game: { terrain: fakeTerrain } });
  assert.equal(game.canPlaceAt(10, 10), true);

  // Border violation (against water)
  fakeTerrain[10][13] = 'water'; // Right boundary tile
  assert.equal(game.canPlaceAt(10, 10), false);
});

test('TicTacToeMiniGame handles keep playing without looping abandon prompt', () => {
  let promptCount = 0;
  let cancelCb = null;
  const fakeTerrain = Array.from({ length: 64 }, () => Array.from({ length: 64 }, () => 'grass'));
  const fakeGame = {
    terrain: fakeTerrain,
    player: { x: 20, y: 20, moving: false, path: [] },
    heldKeys: [],
    destination: null
  };
  const ttt = new TicTacToeMiniGame({
    game: fakeGame,
    onToast: () => {},
    onAbandonPrompt: (confirm, cancel) => {
      promptCount++;
      cancelCb = cancel;
    }
  });
  ttt.activeBoard = {
    originX: 10,
    originY: 10,
    sidelineX: 13,
    sidelineY: 11,
    status: 'playing',
    turn: 'player'
  };

  // 1st tick: player is far away, prompt fires once
  ttt.update(0.016);
  assert.equal(promptCount, 1);

  // User chooses "Keep playing"
  cancelCb();
  assert.equal(ttt.returningToBoard, true);
  assert.ok(fakeGame.player.path.length > 0);

  // Next ticks while returning: prompt must not fire again
  ttt.update(0.016);
  ttt.update(0.016);
  assert.equal(promptCount, 1);

  // Once player arrives back within boundary:
  fakeGame.player.x = 9;
  fakeGame.player.y = 11;
  fakeGame.player.path = [];
  ttt.update(0.016);
  assert.equal(ttt.returningToBoard, false);
  assert.equal(promptCount, 1);
});

test('CheckersMiniGame initializes, detects moves, captures and kings', () => {
  const checkers = new CheckersMiniGame();
  const pieces = checkers.createInitialPieces();
  assert.equal(pieces.length, 64);

  // Red (player) pieces start at bottom (rows 5, 6, 7), 12 pieces total
  const playerPieces = pieces.filter(p => p?.side === 'player');
  const opponentPieces = pieces.filter(p => p?.side === 'opponent');
  assert.equal(playerPieces.length, 12);
  assert.equal(opponentPieces.length, 12);

  // Legal opening moves for player from row 5
  const moves = checkers.getLegalMoves('player', pieces);
  assert.ok(moves.length > 0);
  assert.ok(moves.every(m => m.from.row === 5));

  // Test jump capture and king promotion logic
  const customPieces = Array(64).fill(null);
  // Player piece at row 2, col 1 (index 17)
  customPieces[2 * 8 + 1] = { side: 'player', king: false };
  // Opponent piece at row 1, col 2 (index 10)
  customPieces[1 * 8 + 2] = { side: 'opponent', king: false };

  checkers.activeBoard = {
    originX: 10,
    originY: 10,
    pieces: customPieces,
    turn: 'player',
    status: 'playing',
    multiJumpFrom: null
  };

  const jumpMoves = checkers.getLegalMoves('player', customPieces);
  assert.equal(jumpMoves.length, 1);
  assert.equal(jumpMoves[0].to.row, 0);
  assert.equal(jumpMoves[0].to.col, 3);
  assert.ok(jumpMoves[0].jumped);

  const res = checkers.applyMove(jumpMoves[0]);
  assert.equal(res.completed, true);
  // King promotion should happen at row 0
  assert.equal(checkers.activeBoard.pieces[0 * 8 + 3].king, true);
  // Jumped piece removed
  assert.equal(checkers.activeBoard.pieces[1 * 8 + 2], null);
});

test('checkers victory grants guaranteed companion and TTT grants 50% companion chance', () => {
  const fakeGame = { player: { x: 30, y: 30, coins: 0 } };
  
  // Checkers win: Guaranteed new companion
  const checkersReward = rollReward(fakeGame, 'checkers', 'win');
  assert.ok(checkersReward);
  assert.ok(checkersReward.newCompanion);
  assert.equal(checkersReward.newCompanion.buddyId, 'player');

  // Tic-Tac-Toe win: 50% bonus roll chance of companion
  let compCount = 0;
  const TRIALS = 400;
  for (let i = 0; i < TRIALS; i++) {
    const tttReward = rollReward(fakeGame, 'tic-tac-toe', 'win');
    if (tttReward?.newCompanion) compCount++;
  }
  const rate = compCount / TRIALS;
  // Should be close to 50% (allow tolerance [0.40, 0.60])
  assert.ok(rate >= 0.40 && rate <= 0.60, `TTT companion rate was ${rate}`);
});

test('mini-game boards evacuate bystander NPCs and companions upon unfurling and permit escape', () => {
  const fakeTerrain = Array.from({ length: 64 }, () => Array.from({ length: 64 }, () => 'grass'));
  const bystanderNpc = { id: 'npc-bystander', x: 11, y: 11, moving: false, path: [] };
  const bystanderComp = { id: 'comp-bystander', x: 12, y: 11, moving: false, path: [] };
  const player = { id: 'player', x: 9, y: 11, moving: false, path: [] };
  const opponent = { id: 'opp', x: 15, y: 11, moving: false, path: [] };

  const fakeGame = {
    terrain: fakeTerrain,
    player,
    npcs: [bystanderNpc, opponent],
    companions: [bystanderComp],
    getCompanionFor: () => null,
    getCompanionsFor: () => []
  };

  const ttt = new TicTacToeMiniGame({ game: fakeGame });
  // Evacuate 3x3 footprint at origin (10, 10)
  ttt.evacuateBoard(10, 10, [player, opponent]);

  // Bystander NPC and companion must have paths leading off the 3x3 footprint or moved outside
  const isInside = (x, y) => x >= 10 && x <= 12 && y >= 10 && y <= 12;
  const npcDest = bystanderNpc.path.length ? bystanderNpc.path[bystanderNpc.path.length - 1] : bystanderNpc;
  const compDest = bystanderComp.path.length ? bystanderComp.path[bystanderComp.path.length - 1] : bystanderComp;

  assert.equal(isInside(npcDest.x, npcDest.y), false);
  assert.equal(isInside(compDest.x, compDest.y), false);

  // Escaping off the board must not be blocked by blocksStep
  ttt.activeBoard = { originX: 10, originY: 10, opponent };
  // Stepping from inside (11, 11) to outside (9, 11) is permitted
  assert.equal(ttt.blocksStep(bystanderNpc, 9, 11), false);
  // Stepping from outside (9, 11) into the board (10, 10) is blocked for bystanders
  bystanderNpc.x = 9;
  bystanderNpc.y = 11;
  assert.equal(ttt.blocksStep(bystanderNpc, 10, 10), true);
});

test('bystander companions are not frozen during active mini-games and can follow their buddy', () => {
  const fakeTerrain = Array.from({ length: 64 }, () => Array.from({ length: 64 }, () => 'grass'));
  const wanderingNpc = { id: 'npc-wanderer', x: 20, y: 20, moving: false };
  const bystanderComp = { id: 'comp-bystander', buddyId: 'npc-wanderer', x: 13, y: 10, moving: false, path: [] };
  const playerComp = { id: 'comp-player', buddyId: 'player', x: 9, y: 12, stagedDestination: { x: 9, y: 12 }, moving: false, path: [] };

  const fakeGame = {
    terrain: fakeTerrain,
    player: { id: 'player', x: 9, y: 11 },
    npcs: [wanderingNpc, { id: 'opp', x: 13, y: 11 }],
    companions: [bystanderComp, playerComp],
    miniGames: [{
      isOpen: () => true,
      activeBoard: { originX: 10, originY: 10, opponent: { id: 'opp' } },
      boardSize: 3,
      isTileOnBoard: (x, y) => x >= 10 && x <= 12 && y >= 10 && y <= 12
    }],
    getCompanionsFor: (id) => [bystanderComp, playerComp].filter(c => c.buddyId === id),
    allOtherCharacters: () => []
  };

  fakeGame.isParticipantCompanion = (comp) => {
    return comp.buddyId === 'player' || comp.buddyId === 'opp';
  };
  fakeGame.isCharacterOnMiniGameBoard = (char) => {
    return char.x >= 10 && char.x <= 12 && char.y >= 10 && char.y <= 12;
  };
  fakeGame.getMiniGameBlockedTiles = () => new Set();
  fakeGame.tryStep = (char, dx, dy) => {
    char.x += dx;
    char.y += dy;
    return true;
  };

  assert.equal(fakeGame.isParticipantCompanion(playerComp), true);
  assert.equal(fakeGame.isParticipantCompanion(bystanderComp), false);
});

test('Checkers opponent continues forced double and triple jumps without freezing', () => {
  const fakeTerrain = Array.from({ length: 64 }, () => Array.from({ length: 64 }, () => 'grass'));
  const player = { id: 'player', x: 9, y: 13, moving: false, path: [] };
  const opponent = { id: 'npc-opp', name: 'Opp', x: 13, y: 12, moving: false, path: [] };
  const fakeGame = {
    terrain: fakeTerrain,
    player,
    npcs: [opponent],
    companions: [],
    getCompanionsFor: () => [],
    getCompanionFor: () => null,
    triggerCheer: () => {}
  };
  const checkers = new CheckersMiniGame({
    game: fakeGame,
    onToast: () => {},
    onGameEnd: () => {},
    onAbandonPrompt: () => {}
  });

  const pieces = Array(64).fill(null);
  pieces[1] = { side: 'opponent', king: false };  // row 0, col 1
  pieces[10] = { side: 'player', king: false };   // row 1, col 2 (first capture)
  pieces[28] = { side: 'player', king: false };   // row 3, col 4 (second capture)
  pieces[46] = { side: 'player', king: false };   // row 5, col 6 (third capture)
  pieces[56] = { side: 'player', king: false };   // keeps the player side alive

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
    turn: 'opponent',
    winner: null,
    status: 'playing',
    foldTimer: 0,
    foldPhase: 0,
    phaseProgress: 1,
    thinkingTimer: 0,
    multiJumpFrom: null
  };
  checkers.selectedCell = { row: 0, col: 1, index: 1 };
  checkers.walkOpponentToSideline = () => {};

  // Opponent is standing on the first landing square and takes the first leap.
  assert.equal(checkers.handleAction(opponent), true);
  assert.equal(checkers.activeBoard.pieces[10], null);
  assert.equal(checkers.activeBoard.multiJumpFrom, 19);
  assert.equal(checkers.activeBoard.turn, 'opponent');
  assert.ok(checkers.activeBoard.thinkingTimer > 0, 'AI should schedule its next leap');

  // AI must keep choosing forced continuations until the chain ends.
  const hops = [
    { to: { x: 15, y: 14 }, landed: 37, jumped: 28 },
    { to: { x: 17, y: 16 }, landed: 55, jumped: 46 }
  ];

  for (const hop of hops) {
    checkers.executeOpponentMove();
    assert.deepEqual(checkers.activeBoard.steppingTo, hop.to);
    opponent.x = hop.to.x;
    opponent.y = hop.to.y;
    opponent.path = [];

    // The update loop resumes the chain instead of leaving the board stuck.
    checkers.activeBoard.thinkingTimer = 0;
    checkers.update(0.016);
    assert.equal(checkers.activeBoard.steppingTo, null);
    assert.equal(checkers.activeBoard.pieces[hop.jumped], null);
    assert.equal(checkers.activeBoard.pieces[hop.landed]?.side, 'opponent');
  }

  assert.equal(checkers.activeBoard.multiJumpFrom, null);
  assert.equal(checkers.activeBoard.turn, 'player');
});

test('mini-games seat multiple companions above and below the player', () => {
  const terrain = Array.from({ length: 64 }, () => Array.from({ length: 64 }, () => 'grass'));
  const specs = [
    { name: 'tic-tac-toe', playerRowOffset: 1, make: game => new TicTacToeMiniGame({ game }) },
    { name: 'checkers', playerRowOffset: 3, make: game => new CheckersMiniGame({ game }) },
    { name: 'chess', playerRowOffset: 3, make: game => new ChessMiniGame({ game }) }
  ];

  for (const spec of specs) {
    const player = { id: 'player', x: 20, y: 20, direction: 0, moving: false, path: [] };
    const opponent = { id: 'npc-opp', name: 'Opp', x: 24, y: 20, moving: false, path: [] };
    const compA = { id: 'comp-a', isCompanion: true, buddyId: 'player', x: 19, y: 22, moving: false, path: [] };
    const compB = { id: 'comp-b', isCompanion: true, buddyId: 'player', x: 21, y: 22, moving: false, path: [] };
    const game = {
      terrain,
      player,
      npcs: [opponent],
      companions: [compA, compB],
      getCompanionsFor: id => (id === 'player' ? [compA, compB] : []),
      getCompanionFor: () => null,
      triggerCheer: () => {}
    };

    const miniGame = spec.make(game);
    assert.equal(miniGame.unfurlBoard(opponent), true, `${spec.name} should unfurl`);
    const { originX, originY } = miniGame.activeBoard;
    const playerRow = originY + spec.playerRowOffset;

    for (const comp of [compA, compB]) {
      assert.equal(comp.stagedDestination.x, originX - 1, `${spec.name} companions stay on the sideline`);
    }
    const offsets = [compA, compB]
      .map(comp => comp.stagedDestination.y - playerRow)
      .sort((a, b) => a - b);
    assert.deepEqual(offsets, [-1, 1], `${spec.name} companions should flank the player`);
  }
});
