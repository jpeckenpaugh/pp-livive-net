import { findPath, findOpenTile, isWalkable, typeAt } from '../world.js';
import { spectatorOffsets } from '../characters.js';
import { recordGameResult } from '../storage.js';
import { ChessEngine, WHITE, BLACK, PIECES } from './chess-engine.js';

export const CHESS_BOARD_SIZE = 8;

// Piece Material Values for AI evaluation
const PIECE_VALUES = {
  p: 100,
  n: 320,
  b: 330,
  r: 500,
  q: 900,
  k: 20000
};

// Piece-Square Tables (from White's perspective; row 0 is rank 8, row 7 is rank 1)
const PST_PAWN = [
  0,  0,  0,  0,  0,  0,  0,  0,
  50, 50, 50, 50, 50, 50, 50, 50,
  10, 10, 20, 30, 30, 20, 10, 10,
   5,  5, 10, 25, 25, 10,  5,  5,
   0,  0,  0, 20, 20,  0,  0,  0,
   5, -5,-10,  0,  0,-10, -5,  5,
   5, 10, 10,-20,-20, 10, 10,  5,
   0,  0,  0,  0,  0,  0,  0,  0
];

const PST_KNIGHT = [
  -50,-40,-30,-30,-30,-30,-40,-50,
  -40,-20,  0,  0,  0,  0,-20,-40,
  -30,  0, 10, 15, 15, 10,  0,-30,
  -30,  5, 15, 20, 20, 15,  5,-30,
  -30,  0, 15, 20, 20, 15,  0,-30,
  -30,  5, 10, 15, 15, 10,  5,-30,
  -40,-20,  0,  5,  5,  0,-20,-40,
  -50,-40,-30,-30,-30,-30,-40,-50
];

const PST_BISHOP = [
  -20,-10,-10,-10,-10,-10,-10,-20,
  -10,  0,  0,  0,  0,  0,  0,-10,
  -10,  0,  5, 10, 10,  5,  0,-10,
  -10,  5,  5, 10, 10,  5,  5,-10,
  -10,  0, 10, 10, 10, 10,  0,-10,
  -10, 10, 10, 10, 10, 10, 10,-10,
  -10,  5,  0,  0,  0,  0,  5,-10,
  -20,-10,-10,-10,-10,-10,-10,-20
];

const PST_ROOK = [
    0,  0,  0,  0,  0,  0,  0,  0,
    5, 10, 10, 10, 10, 10, 10,  5,
   -5,  0,  0,  0,  0,  0,  0, -5,
   -5,  0,  0,  0,  0,  0,  0, -5,
   -5,  0,  0,  0,  0,  0,  0, -5,
   -5,  0,  0,  0,  0,  0,  0, -5,
   -5,  0,  0,  0,  0,  0,  0, -5,
    0,  0,  0,  5,  5,  0,  0,  0
];

const PST_QUEEN = [
  -20,-10,-10, -5, -5,-10,-10,-20,
  -10,  0,  0,  0,  0,  0,  0,-10,
  -10,  0,  5,  5,  5,  5,  0,-10,
   -5,  0,  5,  5,  5,  5,  0, -5,
    0,  0,  5,  5,  5,  5,  0, -5,
  -10,  5,  5,  5,  5,  5,  0,-10,
  -10,  0,  5,  0,  0,  0,  0,-10,
  -20,-10,-10, -5, -5,-10,-10,-20
];

const PST_KING = [
  -30,-40,-40,-50,-50,-40,-40,-30,
  -30,-40,-40,-50,-50,-40,-40,-30,
  -30,-40,-40,-50,-50,-40,-40,-30,
  -30,-40,-40,-50,-50,-40,-40,-30,
  -20,-30,-30,-40,-40,-30,-30,-20,
  -10,-20,-20,-20,-20,-20,-20,-10,
   20, 20,  0,  0,  0,  0, 20, 20,
   20, 30, 10,  0,  0, 10, 30, 20
];

const PST_TABLES = {
  p: PST_PAWN,
  n: PST_KNIGHT,
  b: PST_BISHOP,
  r: PST_ROOK,
  q: PST_QUEEN,
  k: PST_KING
};

export class ChessMiniGame {
  constructor({ game, onToast, onReject, onGameEnd, onAbandonPrompt, recordResult } = {}) {
    this.game = game;
    this.onToast = onToast || (() => {});
    this.onReject = onReject || (() => {});
    this.onGameEnd = onGameEnd || (() => {});
    this.onAbandonPrompt = onAbandonPrompt || (() => {});
    // Injectable so contract adapters can leave stats/rewards to the host.
    this.recordResult = recordResult || recordGameResult;
    this.activeBoard = null;
    this.boardSize = CHESS_BOARD_SIZE;
    this.nextStarter = 'player'; // White is player, Black is opponent
    this.abandonPromptActive = false;
    this.selectedSquare = null; // 0..63
    this.pendingPromotionMove = null;
  }

  isOpen() {
    return Boolean(this.activeBoard);
  }

  canPlaceAt(originX, originY) {
    if (!this.game?.terrain) return false;
    const size = CHESS_BOARD_SIZE;
    for (let dy = -1; dy <= size; dy++) {
      for (let dx = -1; dx <= size; dx++) {
        const tx = originX + dx;
        const ty = originY + dy;
        if (tx < 0 || tx >= 64 || ty < 0 || ty >= 64) return false;
        const tileType = this.game.terrain[ty]?.[tx];
        if (!isWalkable(tileType)) {
          return false;
        }
      }
    }
    return true;
  }

  findPlacementSpot(aroundX, aroundY) {
    const offsets = [
      { dx: 1, dy: -3 },
      { dx: 1, dy: -2 },
      { dx: 1, dy: -4 },
      { dx: 1, dy: -1 },
      { dx: 2, dy: -3 },
      { dx: 2, dy: -4 },
      { dx: 1, dy: -5 },
      { dx: 1, dy: 0 },
      { dx: -9, dy: -3 },
      { dx: -9, dy: -4 },
      { dx: -4, dy: 1 },
      { dx: -4, dy: -9 }
    ];

    for (const offset of offsets) {
      const ox = aroundX + offset.dx;
      const oy = aroundY + offset.dy;
      if (this.canPlaceAt(ox, oy)) {
        return { originX: ox, originY: oy };
      }
    }

    for (let r = 1; r <= 8; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
          const ox = aroundX + dx;
          const oy = aroundY + dy;
          if (this.canPlaceAt(ox, oy)) {
            return { originX: ox, originY: oy };
          }
        }
      }
    }
    return null;
  }

  evacuateBoard(originX, originY, participants = []) {
    if (!this.game) return;
    const size = CHESS_BOARD_SIZE;
    const participantSet = new Set(participants.filter(Boolean));
    const boardTiles = new Set();
    for (let dy = 0; dy < size; dy++) {
      for (let dx = 0; dx < size; dx++) {
        boardTiles.add(`${originX + dx},${originY + dy}`);
      }
    }

    // Collect all NPCs and companions that are not active participants
    const bystanders = [
      ...(this.game.npcs || []).filter(npc => !participantSet.has(npc)),
      ...(this.game.companions || []).filter(comp => !participantSet.has(comp))
    ];

    // Identify reserved spots around board (e.g. participant staging locations)
    const reservedTiles = new Set(boardTiles);
    for (const p of participants) {
      if (p) reservedTiles.add(`${p.x},${p.y}`);
    }

    for (const bystander of bystanders) {
      const curX = bystander.moving ? bystander.toX : bystander.x;
      const curY = bystander.moving ? bystander.toY : bystander.y;

      if (!boardTiles.has(`${curX},${curY}`)) continue;

      const escapeTile = findOpenTile(this.game.terrain, { x: curX, y: curY }, reservedTiles, 1);
      if (!escapeTile) continue;

      reservedTiles.add(`${escapeTile.x},${escapeTile.y}`);
      const escapePath = findPath(this.game.terrain, { x: curX, y: curY }, escapeTile);
      if (escapePath.length) {
        bystander.path = escapePath;
        bystander.moving = false;
      } else {
        bystander.x = escapeTile.x;
        bystander.y = escapeTile.y;
        bystander.path = [];
        bystander.moving = false;
      }
    }
  }

  unfurlBoard(opponent, placement = null) {
    if (!this.game?.player) return false;
    const player = this.game.player;
    let spot;

    if (placement) {
      // Contract hosts validate and pass an explicit origin; honour it.
      const originX = placement.originX ?? placement.x;
      const originY = placement.originY ?? placement.y;
      if (!Number.isInteger(originX) || !Number.isInteger(originY) || !this.canPlaceAt(originX, originY)) {
        this.onToast('Need clear open ground to lay out the 8x8 Chessboard.');
        return false;
      }
      spot = { originX, originY };
    } else {
      spot = this.findPlacementSpot(player.x, player.y);
      if (!spot) {
        this.onToast('Need clear open ground to lay out the 8x8 Chessboard.');
        return false;
      }
    }

    // Player plays White (starter is White in standard chess)
    const starter = 'player';

    // Staging positions on sidelines of 8x8 board:
    // Left side (originX - 1):
    //   Row 3: (originX - 1, originY + 3) -> Player
    //   Row 4: (originX - 1, originY + 4) -> Player's Companion
    // Right side (originX + 8):
    //   Row 3: (originX + 8, originY + 3) -> Opponent
    //   Row 4: (originX + 8, originY + 4) -> Opponent's Companion
    const playerTarget = { x: spot.originX - 1, y: spot.originY + 3 };
    const playerCompTarget = { x: spot.originX - 1, y: spot.originY + 4 };
    const opponentTarget = { x: spot.originX + 8, y: spot.originY + 3 };
    const opponentCompTarget = { x: spot.originX + 8, y: spot.originY + 4 };

    // Auto-walk Player to sideline
    if (player.x !== playerTarget.x || player.y !== playerTarget.y) {
      const pPath = findPath(this.game.terrain, { x: player.x, y: player.y }, playerTarget);
      if (pPath.length) player.path = pPath;
      else { player.x = playerTarget.x; player.y = playerTarget.y; }
    }
    player.direction = 1; // Facing right toward board

    // Auto-walk active Player companions
    // They alternate above and below the player instead of stacking in one column.
    const playerComps = this.game.getCompanionsFor?.('player') || [];
    const offsets = spectatorOffsets(playerComps.length);
    playerComps.forEach((comp, idx) => {
      const target = { x: playerTarget.x, y: playerTarget.y + offsets[idx] };
      comp.fetchTarget = null;
      comp.stagedDestination = target;
      const compPath = findPath(this.game.terrain, { x: comp.x, y: comp.y }, target);
      if (compPath.length) comp.path = compPath;
      else { comp.x = target.x; comp.y = target.y; }
      comp.direction = 1;
    });

    // Auto-walk Opponent
    if (opponent) {
      opponent.inMiniGame = true;
      opponent.moving = false;
      const oppPath = findPath(this.game.terrain, { x: opponent.x, y: opponent.y }, opponentTarget);
      if (oppPath.length) opponent.path = oppPath;
      else { opponent.x = opponentTarget.x; opponent.y = opponentTarget.y; }
      opponent.direction = 3; // Facing left toward board

      const oppComp = this.game.getCompanionFor?.(opponent.id);
      if (oppComp) {
        oppComp.stagedDestination = opponentCompTarget;
        const oppCompPath = findPath(this.game.terrain, { x: oppComp.x, y: oppComp.y }, opponentCompTarget);
        if (oppCompPath.length) oppComp.path = oppCompPath;
        else { oppComp.x = opponentCompTarget.x; oppComp.y = opponentCompTarget.y; }
        oppComp.direction = 3;
      }
    }

    const oppComp = opponent ? this.game.getCompanionFor?.(opponent.id) : null;
    this.evacuateBoard(spot.originX, spot.originY, [player, ...playerComps, opponent, oppComp]);

    const engine = new ChessEngine();

    this.activeBoard = {
      originX: spot.originX,
      originY: spot.originY,
      sidelineX: opponentTarget.x,
      sidelineY: opponentTarget.y,
      playerSidelineX: playerTarget.x,
      playerSidelineY: playerTarget.y,
      engine,
      animatingPiece: null,
      opponent,
      turn: starter,
      winner: null,
      status: 'unfolding', // 'unfolding', 'playing', 'refolding', 'ended'
      foldTimer: 0,
      foldPhase: 0,
      phaseProgress: 0,
      thinkingTimer: 0,
      steppingTo: null
    };

    this.selectedSquare = null;
    this.pendingPromotionMove = null;
    this.onToast('Unfurling 8x8 Chessboard on the ground...');
    return true;
  }

  resetRound() {
    if (!this.activeBoard) return;
    this.activeBoard.engine = new ChessEngine();
    this.activeBoard.animatingPiece = null;
    this.activeBoard.turn = 'player';
    this.activeBoard.winner = null;
    this.activeBoard.status = 'playing';
    this.activeBoard.thinkingTimer = 0;
    this.activeBoard.steppingTo = null;
    this.selectedSquare = null;
    this.pendingPromotionMove = null;
    this.walkOpponentToSideline();

    this.onToast('New match! White (You) to move.');
  }

  returnPlayerToBoard() {
    const board = this.activeBoard;
    if (!board || !this.game.player) return;
    const player = this.game.player;
    const targetX = board.playerSidelineX;
    const targetY = board.playerSidelineY;

    if (player.x !== targetX || player.y !== targetY) {
      const path = findPath(this.game.terrain, { x: player.x, y: player.y }, { x: targetX, y: targetY });
      if (path.length) player.path = path;
      else { player.x = targetX; player.y = targetY; }
    }
    player.direction = 1;
  }

  walkOpponentToSideline() {
    const board = this.activeBoard;
    if (!board || !board.opponent) return;
    const opponent = board.opponent;
    if (opponent.x !== board.sidelineX || opponent.y !== board.sidelineY) {
      opponent.miniGameTarget = { x: board.sidelineX, y: board.sidelineY };
      const path = findPath(this.game.terrain, { x: opponent.x, y: opponent.y }, { x: board.sidelineX, y: board.sidelineY });
      if (path.length) {
        opponent.path = path;
      } else {
        opponent.x = board.sidelineX;
        opponent.y = board.sidelineY;
        opponent.miniGameTarget = null;
      }
      opponent.direction = 3;
    } else {
      opponent.miniGameTarget = null;
    }
  }

  blocksStep(character, nx, ny) {
    if (!this.isOpen()) return false;
    const isPlayer = character === this.game.player;
    const isOpponent = character === this.activeBoard?.opponent;
    const isStagingCompanion = character.isCompanion && Boolean(character.stagedDestination);
    if (isPlayer || isOpponent || isStagingCompanion) return false;

    // "Escape only" rule for bystanders (all other NPCs and companions):
    // Characters already on the board are free to walk off; they are only
    // blocked when trying to step onto it from outside.
    const currentlyOnBoard = this.isTileOnBoard(character.x, character.y);
    const destinationOnBoard = this.isTileOnBoard(nx, ny);

    if (!currentlyOnBoard && destinationOnBoard) {
      return true;
    }

    return false;
  }

  isTileOnBoard(x, y) {
    if (!this.activeBoard) return false;
    const { originX, originY } = this.activeBoard;
    return x >= originX && x < originX + CHESS_BOARD_SIZE &&
      y >= originY && y < originY + CHESS_BOARD_SIZE;
  }

  packUpBoard() {
    if (!this.activeBoard) return;
    this.activeBoard.status = 'refolding';
    this.activeBoard.foldTimer = 0;
    this.activeBoard.foldPhase = 3;
    this.activeBoard.phaseProgress = 1;
    this.activeBoard.onRefoldComplete = () => {
      if (this.activeBoard?.opponent) {
        this.activeBoard.opponent.inMiniGame = false;
        this.activeBoard.opponent.moving = false;
      }
      // Clear staged spectator destination on companions so they resume following
      for (const comp of this.game.companions || []) {
        comp.stagedDestination = null;
      }
      this.activeBoard = null;
      this.selectedSquare = null;
      this.onToast('Packed up the Chess Set.');
    };
  }

  cellAtTile(tileX, tileY) {
    if (!this.activeBoard) return null;
    const { originX, originY } = this.activeBoard;
    const col = tileX - originX;
    const row = tileY - originY;
    if (col < 0 || col >= 8 || row < 0 || row >= 8) {
      return null;
    }
    return { row, col, square: row * 8 + col };
  }

  /**
   * Target ring: an own piece is valid when it has a legal move; a destination
   * is valid when the selected square can legally reach it.
   */
  describeTarget(tile) {
    const board = this.activeBoard;
    if (!board || board.status !== 'playing' || !tile) return null;
    const target = { x: tile.x, y: tile.y };
    const cell = this.cellAtTile(tile.x, tile.y);
    if (!cell) return { tile: target, valid: false };

    const engine = board.engine;
    const piece = engine.board[cell.square];
    if (piece && piece.color === WHITE) {
      return { tile: target, valid: engine.moves({ square: cell.square }).length > 0 };
    }
    if (this.selectedSquare !== null) {
      const moves = engine.moves({ square: this.selectedSquare });
      return { tile: target, valid: moves.some(move => move.to === cell.square) };
    }
    return { tile: target, valid: false };
  }

  evaluateBoard(engine) {
    let score = 0;
    for (let i = 0; i < 64; i++) {
      const piece = engine.board[i];
      if (!piece) continue;

      const val = PIECE_VALUES[piece.type] || 0;
      const table = PST_TABLES[piece.type];
      let pstVal = 0;
      if (table) {
        // Table is oriented from White's perspective (row 0 = rank 8)
        const tableIdx = piece.color === WHITE ? i : (7 - Math.floor(i / 8)) * 8 + (i % 8);
        pstVal = table[tableIdx] || 0;
      }

      const totalVal = val + pstVal;
      if (piece.color === BLACK) {
        score += totalVal; // Opponent is Black
      } else {
        score -= totalVal; // Player is White
      }
    }
    return score;
  }

  minimax(engine, depth, alpha, beta, isMaximizing) {
    if (depth === 0 || engine.isGameOver()) {
      if (engine.isCheckmate()) {
        return isMaximizing ? -100000 + (3 - depth) : 100000 - (3 - depth);
      }
      if (engine.isStalemate()) {
        return 0;
      }
      return this.evaluateBoard(engine);
    }

    const legalMoves = engine.moves();
    // Sort captures and checks first for better alpha-beta pruning
    legalMoves.sort((a, b) => {
      const valA = (a.captured ? (PIECE_VALUES[a.captured.type] || 0) : 0);
      const valB = (b.captured ? (PIECE_VALUES[b.captured.type] || 0) : 0);
      return valB - valA;
    });

    if (isMaximizing) {
      let maxEval = -Infinity;
      for (const move of legalMoves) {
        engine.makeMoveRaw(move);
        const evaluation = this.minimax(engine, depth - 1, alpha, beta, false);
        engine.undoMoveRaw();
        maxEval = Math.max(maxEval, evaluation);
        alpha = Math.max(alpha, evaluation);
        if (beta <= alpha) break;
      }
      return maxEval;
    } else {
      let minEval = Infinity;
      for (const move of legalMoves) {
        engine.makeMoveRaw(move);
        const evaluation = this.minimax(engine, depth - 1, alpha, beta, true);
        engine.undoMoveRaw();
        minEval = Math.min(minEval, evaluation);
        beta = Math.min(beta, evaluation);
        if (beta <= alpha) break;
      }
      return minEval;
    }
  }

  getBestMoveForOpponent() {
    const engine = this.activeBoard?.engine;
    if (!engine) return null;

    const legalMoves = engine.moves();
    if (legalMoves.length === 0) return null;

    let bestScore = -Infinity;
    let candidates = [];
    const depth = 2; // Fast & effective minimax with PST evaluation

    for (const move of legalMoves) {
      engine.makeMoveRaw(move);
      const score = this.minimax(engine, depth - 1, -Infinity, Infinity, false);
      engine.undoMoveRaw();

      if (score > bestScore) {
        bestScore = score;
        candidates = [move];
      } else if (score === bestScore) {
        candidates.push(move);
      }
    }

    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  applyMove(move, animate = true) {
    const board = this.activeBoard;
    if (!board) return false;

    const fromSquare = move.from;
    const toSquare = move.to;
    const fromPiece = board.engine.board[fromSquare];
    if (!fromPiece) return false;

    if (animate) {
      board.animatingPiece = {
        piece: { ...fromPiece },
        fromRow: Math.floor(fromSquare / 8),
        fromCol: fromSquare % 8,
        toRow: Math.floor(toSquare / 8),
        toCol: toSquare % 8,
        elapsed: 0,
        duration: 0.38
      };
    }

    board.engine.makeMoveRaw(move);
    return true;
  }

  finishGame(winner) {
    if (!this.activeBoard) return;
    this.activeBoard.winner = winner;
    this.activeBoard.status = 'ended';

    const opponent = this.activeBoard.opponent;
    const opponentId = opponent?.id;
    const opponentName = opponent?.name;

    let result = 'draw';
    if (winner === 'player') result = 'win';
    else if (winner === 'opponent') result = 'loss';

    this.recordResult({ opponentId, opponentName, result });
    this.onGameEnd(winner, opponent);
  }

  handleAction(character) {
    if (!this.activeBoard || this.activeBoard.status !== 'playing') return false;
    const isPlayer = character === this.game.player;

    if (isPlayer && this.activeBoard.turn !== 'player') {
      this.onReject({ reason: 'not-turn' });
      return false;
    }

    const cell = this.cellAtTile(character.x, character.y);
    if (!cell) {
      if (isPlayer) {
        this.onReject({ reason: 'off-square' });
      }
      return false;
    }

    const engine = this.activeBoard.engine;
    const pieceAtCell = engine.board[cell.square];
    const currentColor = isPlayer ? WHITE : BLACK;

    // 1. Standing on own piece: Select piece
    if (pieceAtCell && pieceAtCell.color === currentColor) {
      const legalMoves = engine.moves({ square: cell.square });
      if (legalMoves.length === 0) {
        if (isPlayer) this.onReject({ reason: 'illegal' });
        return false;
      }

      this.selectedSquare = cell.square;
      const typeNames = { p: 'Pawn', n: 'Knight', b: 'Bishop', r: 'Rook', q: 'Queen', k: 'King' };
      const pieceName = typeNames[pieceAtCell.type] || 'Piece';
      const file = String.fromCharCode(97 + cell.col);
      const rank = 8 - cell.row;
      this.onToast(`Selected ${pieceName} at ${file}${rank}. Now step to your destination.`);
      return true;
    }

    // 2. A piece is already selected: Destination clicked/stepped
    if (this.selectedSquare !== null) {
      const legalMoves = engine.moves({ square: this.selectedSquare });
      const matchingMoves = legalMoves.filter(m => m.to === cell.square);

      if (matchingMoves.length === 0) {
        if (isPlayer) this.onReject({ reason: 'illegal' });
        return false;
      }

      // If move is a pawn promotion, default to Queen (standard in quick chess)
      const move = matchingMoves.find(m => m.promotion === 'q') || matchingMoves[0];

      this.applyMove(move, true);
      this.game.triggerCheer(character.id, 1.2);
      this.selectedSquare = null;

      // Check if check or checkmate
      const nextTurnColor = isPlayer ? BLACK : WHITE;
      if (engine.isCheckmate()) {
        this.finishGame(isPlayer ? 'player' : 'opponent');
        return true;
      }
      if (engine.isStalemate() || engine.isGameOver()) {
        this.finishGame('draw');
        return true;
      }

      if (engine.isInCheck(nextTurnColor)) {
        this.onToast('Check!');
      }

      // Switch turn
      if (isPlayer) {
        this.activeBoard.turn = 'opponent';
        this.activeBoard.thinkingTimer = 0.6 + Math.random() * 0.4;
      } else {
        this.activeBoard.turn = 'player';
        // The strip owns the turn cue.
        setTimeout(() => {
          if (this.activeBoard) this.walkOpponentToSideline();
        }, 300);
      }
      return true;
    }

    if (isPlayer) this.onReject({ reason: 'illegal' });
    return false;
  }

  executeOpponentMove() {
    const board = this.activeBoard;
    if (!board || board.status !== 'playing' || board.turn !== 'opponent') return;
    const opponent = board.opponent;
    if (!opponent) return;

    const chosenMove = this.getBestMoveForOpponent();
    if (!chosenMove) {
      if (board.engine.isCheckmate()) {
        this.finishGame('player');
      } else {
        this.finishGame('draw');
      }
      return;
    }

    // Target tile for opponent to step to
    const toCol = chosenMove.to % 8;
    const toRow = Math.floor(chosenMove.to / 8);
    const targetTile = {
      x: board.originX + toCol,
      y: board.originY + toRow
    };

    board.steppingTo = targetTile;
    opponent.miniGameTarget = targetTile;
    const path = findPath(this.game.terrain, { x: opponent.x, y: opponent.y }, targetTile);
    if (path.length) {
      opponent.path = path;
    } else {
      opponent.x = targetTile.x;
      opponent.y = targetTile.y;
    }

    this.selectedSquare = chosenMove.from;
  }

  update(dt) {
    if (!this.activeBoard) return;
    const board = this.activeBoard;

    const PHASE_DURATION = 0.35;
    if (board.status === 'unfolding') {
      board.foldTimer += dt;
      board.phaseProgress = Math.min(1, board.foldTimer / PHASE_DURATION);
      if (board.foldTimer >= PHASE_DURATION) {
        board.foldTimer = 0;
        board.phaseProgress = 0;
        board.foldPhase++;
        if (board.foldPhase >= 4) {
          board.status = 'playing';
          board.phaseProgress = 1;
          this.onToast('Chess ready! Step onto a White piece and press Enter to select.');
        }
      }
      return;
    }

    if (board.status === 'refolding') {
      board.foldTimer += dt;
      board.phaseProgress = Math.max(0, 1 - board.foldTimer / (PHASE_DURATION * 0.8));
      if (board.foldTimer >= PHASE_DURATION * 0.8) {
        board.foldTimer = 0;
        board.phaseProgress = 1;
        board.foldPhase--;
        if (board.foldPhase < 0) {
          const cb = board.onRefoldComplete;
          board.onRefoldComplete = null;
          cb?.();
        }
      }
      return;
    }

    // Update piece hopping tween animation
    if (board.animatingPiece) {
      board.animatingPiece.elapsed += dt;
      if (board.animatingPiece.elapsed >= board.animatingPiece.duration) {
        board.animatingPiece = null;
      }
    }

    // Wandering boundary check: Player walks more than 2 spaces away from 8x8 board
    if (board.status === 'playing' && this.game.player && !this.abandonPromptActive && !this.returningToBoard) {
      const p = this.game.player;
      const minX = board.originX;
      const maxX = board.originX + CHESS_BOARD_SIZE - 1;
      const minY = board.originY;
      const maxY = board.originY + CHESS_BOARD_SIZE - 1;
      const dist = Math.max(0, minX - p.x, p.x - maxX, minY - p.y, p.y - maxY);

      if (dist <= 2) {
        this.returningToBoard = false;
      } else {
        this.abandonPromptActive = true;
        this.onAbandonPrompt(() => {
          this.abandonPromptActive = false;
          this.returningToBoard = false;
          this.packUpBoard();
        }, () => {
          this.abandonPromptActive = false;
          this.returningToBoard = true;
          this.returnPlayerToBoard();
        });
      }
    } else if (this.returningToBoard && this.game.player) {
      const p = this.game.player;
      const minX = board.originX;
      const maxX = board.originX + CHESS_BOARD_SIZE - 1;
      const minY = board.originY;
      const maxY = board.originY + CHESS_BOARD_SIZE - 1;
      const dist = Math.max(0, minX - p.x, p.x - maxX, minY - p.y, p.y - maxY);
      if (dist <= 2) {
        this.returningToBoard = false;
      }
    }

    // Opponent thinking & stepping
    if (board.status === 'playing' && board.turn === 'opponent') {
      const opponent = board.opponent;
      if (!opponent) return;

      if (board.thinkingTimer > 0) {
        board.thinkingTimer -= dt;
        if (board.thinkingTimer <= 0) {
          this.executeOpponentMove();
        }
      } else if (board.steppingTo) {
        if (opponent.x === board.steppingTo.x && opponent.y === board.steppingTo.y && !opponent.moving) {
          board.steppingTo = null;
          this.handleAction(opponent);
        }
      }
    }
  }

  // Draw crisp vector silhouette piece symbol onto circular wooden disc
  drawPieceSilhouette(ctx, type, color, cx, cy, radius, scale = 1, hopOffset = 0) {
    ctx.save();
    const pieceY = cy - hopOffset;

    // Drop shadow under piece disc
    ctx.beginPath();
    const shadowY = cy + 2 + hopOffset * 0.4;
    const shadowRadius = radius * (1 - hopOffset * 0.005);
    ctx.arc(cx + 1, shadowY, Math.max(1, shadowRadius), 0, Math.PI * 2);
    ctx.fillStyle = `rgba(0, 0, 0, ${Math.max(0.12, 0.35 - hopOffset * 0.008)})`;
    ctx.fill();

    // Outer circular disc: Ivory White for Player vs Rich Dark Walnut for Opponent
    ctx.beginPath();
    ctx.arc(cx, pieceY, radius * scale, 0, Math.PI * 2);
    ctx.fillStyle = color === WHITE ? '#f5eee6' : '#2b1d16';
    ctx.fill();
    ctx.strokeStyle = color === WHITE ? '#d6c8b4' : '#4a372c';
    ctx.lineWidth = 2.5 * scale;
    ctx.stroke();

    // Subtle inner trim ring
    ctx.beginPath();
    ctx.arc(cx, pieceY, radius * 0.78 * scale, 0, Math.PI * 2);
    ctx.strokeStyle = color === WHITE ? '#e6d8c3' : '#3e2c22';
    ctx.lineWidth = 1.2 * scale;
    ctx.stroke();

    // Vector piece glyph / silhouette inside disc
    ctx.save();
    ctx.translate(cx, pieceY);
    ctx.scale(scale * (radius / 18), scale * (radius / 18));

    const glyphColor = color === WHITE ? '#2c221a' : '#f5ede3';
    ctx.fillStyle = glyphColor;
    ctx.strokeStyle = glyphColor;
    ctx.lineWidth = 1.2;

    switch (type) {
      case PIECES.PAWN: {
        // Head circle
        ctx.beginPath();
        ctx.arc(0, -6, 3.2, 0, Math.PI * 2);
        ctx.fill();
        // Body cone
        ctx.beginPath();
        ctx.moveTo(-1.8, -2.5);
        ctx.lineTo(1.8, -2.5);
        ctx.lineTo(3.8, 5);
        ctx.lineTo(-3.8, 5);
        ctx.closePath();
        ctx.fill();
        // Base pedestal
        ctx.fillRect(-5.5, 5, 11, 2.8);
        break;
      }
      case PIECES.KNIGHT: {
        // Stylized horse head
        ctx.beginPath();
        ctx.moveTo(-4.5, 7.5);
        ctx.lineTo(5.5, 7.5);
        ctx.lineTo(5.5, 5.5);
        ctx.lineTo(2.5, 4);
        ctx.lineTo(4.5, 0);
        ctx.lineTo(2, -7);
        ctx.lineTo(-1, -7.5);
        ctx.lineTo(-5.5, -3);
        ctx.lineTo(-6, 0.5);
        ctx.lineTo(-3.5, 0.5);
        ctx.lineTo(-4.5, 4);
        ctx.closePath();
        ctx.fill();
        break;
      }
      case PIECES.BISHOP: {
        // Mitre top ball
        ctx.beginPath();
        ctx.arc(0, -8.5, 1.2, 0, Math.PI * 2);
        ctx.fill();
        // Mitre dome
        ctx.beginPath();
        ctx.arc(0, -3.5, 4, 0, Math.PI * 2);
        ctx.fill();
        // Cut groove
        ctx.strokeStyle = color === WHITE ? '#f5eee6' : '#2b1d16';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(1, -6);
        ctx.lineTo(-1.5, -2);
        ctx.stroke();
        // Base pedestal
        ctx.fillStyle = glyphColor;
        ctx.beginPath();
        ctx.moveTo(-2.2, 0);
        ctx.lineTo(2.2, 0);
        ctx.lineTo(4, 5.5);
        ctx.lineTo(-4, 5.5);
        ctx.closePath();
        ctx.fill();
        ctx.fillRect(-5.5, 5.5, 11, 2.5);
        break;
      }
      case PIECES.ROOK: {
        // Battlements (castle turrets)
        ctx.fillRect(-5, -7.5, 2.6, 3.5);
        ctx.fillRect(-1.3, -7.5, 2.6, 3.5);
        ctx.fillRect(2.4, -7.5, 2.6, 3.5);
        // Tower torso
        ctx.beginPath();
        ctx.moveTo(-4, -4);
        ctx.lineTo(4, -4);
        ctx.lineTo(4.8, 5);
        ctx.lineTo(-4.8, 5);
        ctx.closePath();
        ctx.fill();
        // Base pedestal
        ctx.fillRect(-6, 5, 12, 2.8);
        break;
      }
      case PIECES.QUEEN: {
        // 3 Coronet spikes
        ctx.beginPath();
        ctx.arc(-4.5, -7.5, 1.2, 0, Math.PI * 2);
        ctx.arc(0, -9, 1.4, 0, Math.PI * 2);
        ctx.arc(4.5, -7.5, 1.2, 0, Math.PI * 2);
        ctx.fill();
        // Crown body
        ctx.beginPath();
        ctx.moveTo(-5, -6.5);
        ctx.lineTo(-2, -3);
        ctx.lineTo(0, -7);
        ctx.lineTo(2, -3);
        ctx.lineTo(5, -6.5);
        ctx.lineTo(3.5, 2);
        ctx.lineTo(4.5, 5);
        ctx.lineTo(-4.5, 5);
        ctx.lineTo(-3.5, 2);
        ctx.closePath();
        ctx.fill();
        // Base pedestal
        ctx.fillRect(-6, 5, 12, 2.8);
        break;
      }
      case PIECES.KING: {
        // Cross atop crown
        ctx.fillRect(-0.8, -10.5, 1.6, 4.5);
        ctx.fillRect(-2.5, -9, 5, 1.5);
        // Crown dome
        ctx.beginPath();
        ctx.moveTo(-4.5, -5.5);
        ctx.lineTo(4.5, -5.5);
        ctx.lineTo(4, 5);
        ctx.lineTo(-4, 5);
        ctx.closePath();
        ctx.fill();
        // Base pedestal
        ctx.fillRect(-6, 5, 12, 2.8);
        break;
      }
    }

    ctx.restore();
    ctx.restore();
  }

  render(ctx, camera) {
    if (!this.activeBoard) return;
    const { originX, originY, status, foldPhase, phaseProgress, engine } = this.activeBoard;
    const TILE = 48;
    const screenX = originX * TILE - camera.x;
    const screenY = originY * TILE - camera.y;
    const boardSize = CHESS_BOARD_SIZE * TILE;

    ctx.save();

    const isFolding = status === 'unfolding' || status === 'refolding';
    const progress = typeof phaseProgress === 'number' ? phaseProgress : 1;

    // Helper to draw cells
    const drawBoardCells = (cStart, rStart, cols, rows) => {
      for (let r = rStart; r < rStart + rows; r++) {
        for (let c = cStart; c < cStart + cols; c++) {
          const isDark = (r + c) % 2 === 1;
          ctx.fillStyle = isDark ? '#4a3424' : '#e8d7be';
          ctx.fillRect(screenX + c * TILE, screenY + r * TILE, TILE, TILE);

          ctx.strokeStyle = 'rgba(0, 0, 0, 0.12)';
          ctx.lineWidth = 1;
          ctx.strokeRect(screenX + c * TILE, screenY + r * TILE, TILE, TILE);
        }
      }
    };

    const drawPanel = (cStart, rStart, cols, rows, isFlap = false, foldAngle = 0) => {
      ctx.save();
      const px = screenX + cStart * TILE;
      const py = screenY + rStart * TILE;
      const pw = cols * TILE;
      const ph = rows * TILE;

      if (isFlap && foldAngle !== 0) {
        ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
        ctx.shadowBlur = 10;
        ctx.shadowOffsetY = 6;
      }

      ctx.fillStyle = 'rgba(64, 42, 24, 0.95)';
      ctx.fillRect(px - 4, py - 4, pw + 8, ph + 8);
      ctx.strokeStyle = 'rgba(35, 20, 10, 0.85)';
      ctx.lineWidth = 2.5;
      ctx.strokeRect(px - 4, py - 4, pw + 8, ph + 8);

      drawBoardCells(cStart, rStart, cols, rows);

      if (isFlap) {
        ctx.fillStyle = `rgba(0, 0, 0, ${0.25 * (1 - Math.sin(foldAngle))})`;
        ctx.fillRect(px, py, pw, ph);
      }
      ctx.restore();
    };

    if (isFolding) {
      if (foldPhase === 0) {
        drawPanel(1, 3, 2, 2);
        const flapW = 2 * progress;
        if (flapW > 0.05) {
          drawPanel(3, 3, flapW, 2, true, progress * Math.PI * 0.5);
        }
      } else if (foldPhase === 1) {
        drawPanel(1, 3, 4, 2);
        const flapH = 1 * progress;
        if (flapH > 0.05) {
          drawPanel(1, 3 - flapH, 4, flapH, true, progress * Math.PI * 0.5);
          drawPanel(1, 5, 4, flapH, true, progress * Math.PI * 0.5);
        }
      } else if (foldPhase === 2) {
        drawPanel(1, 2, 4, 4);
        const flapLeftW = 1 * progress;
        const flapRightW = 3 * progress;
        if (flapLeftW > 0.05) {
          drawPanel(1 - flapLeftW, 2, flapLeftW, 4, true, progress * Math.PI * 0.5);
        }
        if (flapRightW > 0.05) {
          drawPanel(5, 2, flapRightW, 4, true, progress * Math.PI * 0.5);
        }
      } else if (foldPhase === 3) {
        drawPanel(0, 2, 8, 4);
        const flapH = 2 * progress;
        if (flapH > 0.05) {
          drawPanel(0, 2 - flapH, 8, flapH, true, progress * Math.PI * 0.5);
          drawPanel(0, 6, 8, flapH, true, progress * Math.PI * 0.5);
        }
      }
    } else {
      ctx.fillStyle = 'rgba(64, 42, 24, 0.95)';
      ctx.fillRect(screenX - 6, screenY - 6, boardSize + 12, boardSize + 12);
      ctx.strokeStyle = 'rgba(35, 20, 10, 0.8)';
      ctx.lineWidth = 3;
      ctx.strokeRect(screenX - 6, screenY - 6, boardSize + 12, boardSize + 12);

      drawBoardCells(0, 0, 8, 8);
    }

    // In-Check Red Halo Indicator on King in check
    if (status === 'playing' && engine) {
      for (const color of [WHITE, BLACK]) {
        if (engine.isInCheck(color)) {
          const kingSq = engine.findKing(color);
          if (kingSq !== -1) {
            const kr = Math.floor(kingSq / 8);
            const kc = kingSq % 8;
            const kx = screenX + kc * TILE;
            const ky = screenY + kr * TILE;
            ctx.fillStyle = 'rgba(231, 76, 60, 0.45)';
            ctx.fillRect(kx, ky, TILE, TILE);
            ctx.strokeStyle = '#e74c3c';
            ctx.lineWidth = 3;
            ctx.strokeRect(kx + 2, ky + 2, TILE - 4, TILE - 4);
          }
        }
      }
    }

    // Highlight selected piece square and legal move destinations
    if (this.selectedSquare !== null && status === 'playing' && engine) {
      const selCol = this.selectedSquare % 8;
      const selRow = Math.floor(this.selectedSquare / 8);
      const selX = screenX + selCol * TILE;
      const selY = screenY + selRow * TILE;
      ctx.fillStyle = 'rgba(241, 196, 15, 0.45)';
      ctx.fillRect(selX, selY, TILE, TILE);
      ctx.strokeStyle = '#f1c40f';
      ctx.lineWidth = 2.5;
      ctx.strokeRect(selX + 2, selY + 2, TILE - 4, TILE - 4);

      const legalMoves = engine.moves({ square: this.selectedSquare });
      for (const m of legalMoves) {
        const destCol = m.to % 8;
        const destRow = Math.floor(m.to / 8);
        const destX = screenX + destCol * TILE;
        const destY = screenY + destRow * TILE;

        ctx.fillStyle = m.captured ? 'rgba(231, 76, 60, 0.4)' : 'rgba(46, 204, 113, 0.4)';
        ctx.fillRect(destX, destY, TILE, TILE);
        ctx.strokeStyle = m.captured ? '#e74c3c' : '#2ecc71';
        ctx.lineWidth = 2;
        ctx.strokeRect(destX + 2, destY + 2, TILE - 4, TILE - 4);
      }
    }

    // Render pieces
    if ((status === 'playing' || status === 'ended') && engine) {
      const anim = this.activeBoard.animatingPiece;
      const skipIndex = anim ? anim.toRow * 8 + anim.toCol : -1;

      for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
          const idx = r * 8 + c;
          if (idx === skipIndex) continue;

          const piece = engine.board[idx];
          if (!piece) continue;

          const cx = screenX + (c + 0.5) * TILE;
          const cy = screenY + (r + 0.5) * TILE;
          const radius = TILE * 0.38;
          this.drawPieceSilhouette(ctx, piece.type, piece.color, cx, cy, radius);
        }
      }

      // Render animating piece with parabolic hop arc
      if (anim) {
        const t = Math.min(1, anim.elapsed / anim.duration);
        const ease = 0.5 - 0.5 * Math.cos(t * Math.PI);
        const curCol = anim.fromCol + (anim.toCol - anim.fromCol) * ease;
        const curRow = anim.fromRow + (anim.toRow - anim.fromRow) * ease;

        const cx = screenX + (curCol + 0.5) * TILE;
        const cy = screenY + (curRow + 0.5) * TILE;
        const hopHeight = 22 * Math.sin(t * Math.PI);
        const radius = TILE * 0.38;
        const scale = 1 + 0.12 * Math.sin(t * Math.PI);

        this.drawPieceSilhouette(ctx, anim.piece.type, anim.piece.color, cx, cy, radius, scale, hopHeight);
      }
    }

    // Status banner if game has ended
    if (status === 'ended') {
      ctx.fillStyle = 'rgba(20, 30, 22, 0.88)';
      ctx.fillRect(screenX, screenY + boardSize / 2 - 24, boardSize, 48);
      ctx.fillStyle = '#edf4e9';
      ctx.font = '700 16px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      let label = 'Chess Match Draw!';
      if (this.activeBoard.winner === 'player') label = 'Checkmate! You Won Chess!';
      else if (this.activeBoard.winner === 'opponent') label = `Checkmate! ${this.activeBoard.opponent?.name || 'Opponent'} Won Chess!`;
      ctx.fillText(label, screenX + boardSize / 2, screenY + boardSize / 2);
    }

    ctx.restore();
  }
}
