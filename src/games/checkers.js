import { findPath, findOpenTile, isWalkable, typeAt } from '../world.js';
import { spectatorOffsets } from '../characters.js';
import { recordGameResult } from '../storage.js';

export const CHECKERS_BOARD_SIZE = 8;

export class CheckersMiniGame {
  constructor({ game, onToast, onGameEnd, onAbandonPrompt, recordResult } = {}) {
    this.game = game;
    this.onToast = onToast || (() => {});
    this.onGameEnd = onGameEnd || (() => {});
    this.onAbandonPrompt = onAbandonPrompt || (() => {});
    // Injectable so contract adapters can leave stats/rewards to the host.
    this.recordResult = recordResult || recordGameResult;
    this.activeBoard = null;
    this.boardSize = CHECKERS_BOARD_SIZE;
    this.nextStarter = 'player';
    this.abandonPromptActive = false;
    this.selectedCell = null; // { row, col, index }
  }

  isOpen() {
    return Boolean(this.activeBoard);
  }

  // Ensure board has at least 1 extra walkable tile boundary around 8x8
  // i.e., originX - 1 to originX + 8, and originY - 1 to originY + 8
  canPlaceAt(originX, originY) {
    if (!this.game?.terrain) return false;
    const size = CHECKERS_BOARD_SIZE;
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
    // Search nearby coordinates around player where an 8x8 area + 1 tile margin fits
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

    // Broader search if immediate offsets fail
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

  // Create initial 8x8 board:
  // Standard draughts: played only on dark squares where (row + col) % 2 === 1
  // Player (red) starts on rows 5, 6, 7 (player side, left/bottom)
  // Opponent (black) starts on rows 0, 1, 2 (opponent side, right/top)
  createInitialPieces() {
    const pieces = Array(64).fill(null);
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        if ((r + c) % 2 === 1) {
          if (r < 3) {
            pieces[r * 8 + c] = { side: 'opponent', king: false };
          } else if (r > 4) {
            pieces[r * 8 + c] = { side: 'player', king: false };
          }
        }
      }
    }
    return pieces;
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
        this.onToast('Need clear open ground to lay out the 8x8 Checkerboard.');
        return false;
      }
      spot = { originX, originY };
    } else {
      spot = this.findPlacementSpot(player.x, player.y);
      if (!spot) {
        this.onToast('Need clear open ground to lay out the 8x8 Checkerboard.');
        return false;
      }
    }

    const starter = this.nextStarter;
    this.nextStarter = starter === 'player' ? 'opponent' : 'player';

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

    // Auto-walk all active Player companions to spectator positions
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

      // Auto-walk Opponent's companion
      const oppComp = this.game.getCompanionFor?.(opponent.id);
      if (oppComp) {
        oppComp.stagedDestination = opponentCompTarget;
        const oppCompPath = findPath(this.game.terrain, { x: oppComp.x, y: oppComp.y }, opponentCompTarget);
        if (oppCompPath.length) oppComp.path = oppCompPath;
        else { oppComp.x = opponentCompTarget.x; oppComp.y = opponentCompTarget.y; }
        oppComp.direction = 3;
      }
    }

    // Flee bystanders (NPCs and companions) caught standing on the newly launched board
    const oppComp = opponent ? this.game.getCompanionFor?.(opponent.id) : null;
    this.evacuateBoard(spot.originX, spot.originY, [player, ...playerComps, opponent, oppComp]);

    this.activeBoard = {
      originX: spot.originX,
      originY: spot.originY,
      sidelineX: opponentTarget.x,
      sidelineY: opponentTarget.y,
      playerSidelineX: playerTarget.x,
      playerSidelineY: playerTarget.y,
      pieces: this.createInitialPieces(),
      animatingPiece: null,
      opponent,
      turn: starter,
      winner: null,
      status: 'unfolding', // 'unfolding', 'playing', 'refolding', 'ended'
      foldTimer: 0,
      foldPhase: 0,
      phaseProgress: 0,
      thinkingTimer: starter === 'opponent' ? 0.8 : 0,
      multiJumpFrom: null
    };

    this.selectedCell = null;
    this.onToast('Unfurling 8x8 Checkerboard on the ground...');
    return true;
  }

  resetRound() {
    if (!this.activeBoard) return;
    const starter = this.nextStarter;
    this.nextStarter = starter === 'player' ? 'opponent' : 'player';

    // Reset hopping piece animation if new round starts
    this.activeBoard.animatingPiece = null;
    this.activeBoard.pieces = this.createInitialPieces();
    this.activeBoard.turn = starter;
    this.activeBoard.winner = null;
    this.activeBoard.status = 'playing';
    this.activeBoard.thinkingTimer = starter === 'opponent' ? 0.6 : 0;
    this.activeBoard.multiJumpFrom = null;
    this.selectedCell = null;
    this.walkOpponentToSideline();

    const starterText = starter === 'player' ? 'You start!' : `${this.activeBoard.opponent?.name || 'Opponent'} starts!`;
    this.onToast(`New round! ${starterText}`);
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
    // Characters already on the board are completely unrestricted and free to walk off.
    // They are only blocked if they are off the board and attempting to walk onto it.
    const currentlyOnBoard = this.isTileOnBoard(character.x, character.y);
    const destinationOnBoard = this.isTileOnBoard(nx, ny);

    if (!currentlyOnBoard && destinationOnBoard) {
      return true; // Blocked from entering the board
    }

    return false; // Free to move anywhere else (including walking off the board)
  }

  isTileOnBoard(x, y) {
    if (!this.activeBoard) return false;
    const { originX, originY } = this.activeBoard;
    const size = CHECKERS_BOARD_SIZE;
    return x >= originX && x < originX + size && y >= originY && y < originY + size;
  }

  evacuateBoard(originX, originY, participants = []) {
    if (!this.game) return;
    const size = CHECKERS_BOARD_SIZE;
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

      if (boardTiles.has(`${curX},${curY}`)) {
        // Bystander is standing on the spawning 8x8 board: find open tile off the board to flee to
        const escapeTile = findOpenTile(this.game.terrain, { x: curX, y: curY }, reservedTiles, 1);
        if (escapeTile) {
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
    }
  }

  packUpBoard() {
    if (!this.activeBoard) return;
    this.selectedCell = null;
    this.activeBoard.status = 'refolding';
    this.activeBoard.foldTimer = 0;
    this.activeBoard.foldPhase = 3;
    this.activeBoard.phaseProgress = 1;
    this.activeBoard.onRefoldComplete = () => {
      if (this.activeBoard?.opponent) {
        this.activeBoard.opponent.inMiniGame = false;
      }
      // Clear staged spectator destination on companions so they resume following
      for (const comp of this.game.companions || []) {
        comp.stagedDestination = null;
      }
      this.activeBoard = null;
      this.onToast('Packed up the Checkerboard into your backpack.');
    };
  }

  cellAtTile(x, y) {
    if (!this.activeBoard) return null;
    const { originX, originY } = this.activeBoard;
    const col = x - originX;
    const row = y - originY;
    if (col >= 0 && col < CHECKERS_BOARD_SIZE && row >= 0 && row < CHECKERS_BOARD_SIZE) {
      return { row, col, index: row * 8 + col };
    }
    return null;
  }

  // --- Checkers Rules & Move Computation ---

  getLegalMoves(side, pieces = this.activeBoard?.pieces, forcedFromIndex = null) {
    if (!pieces) return [];
    const allJumps = [];
    const allSimple = [];

    const indices = forcedFromIndex !== null
      ? [forcedFromIndex]
      : Array.from({ length: 64 }, (_, i) => i);

    for (const i of indices) {
      const piece = pieces[i];
      if (!piece || piece.side !== side) continue;

      const r = Math.floor(i / 8);
      const c = i % 8;

      // Directions:
      // Player regular moves: up toward row 0 (dr = -1)
      // Opponent regular moves: down toward row 7 (dr = +1)
      // Kings can move in both directions (dr = -1, dr = +1)
      const drs = piece.king ? [-1, 1] : (side === 'player' ? [-1] : [1]);
      const dcs = [-1, 1];

      // Check jumps (captures)
      for (const dr of drs) {
        for (const dc of dcs) {
          const midR = r + dr;
          const midC = c + dc;
          const toR = r + dr * 2;
          const toC = c + dc * 2;

          if (toR >= 0 && toR < 8 && toC >= 0 && toC < 8) {
            const midPiece = pieces[midR * 8 + midC];
            const toPiece = pieces[toR * 8 + toC];

            if (midPiece && midPiece.side !== side && toPiece === null) {
              allJumps.push({
                from: { row: r, col: c, index: i },
                to: { row: toR, col: toC, index: toR * 8 + toC },
                jumped: { row: midR, col: midC, index: midR * 8 + midC }
              });
            }
          }
        }
      }

      // Check simple non-jumping moves only if not in multi-jump continuation
      if (forcedFromIndex === null) {
        for (const dr of drs) {
          for (const dc of dcs) {
            const toR = r + dr;
            const toC = c + dc;
            if (toR >= 0 && toR < 8 && toC >= 0 && toC < 8) {
              if (pieces[toR * 8 + toC] === null) {
                allSimple.push({
                  from: { row: r, col: c, index: i },
                  to: { row: toR, col: toC, index: toR * 8 + toC },
                  jumped: null
                });
              }
            }
          }
        }
      }
    }

    // In checkers, jumps are mandatory if any jump is available
    if (allJumps.length > 0) {
      return allJumps;
    }
    return forcedFromIndex !== null ? [] : allSimple;
  }

  applyMove(move, animate = false) {
    const board = this.activeBoard;
    if (!board) return false;
    const { from, to, jumped } = move;
    const piece = board.pieces[from.index];
    if (!piece) return false;

    if (animate) {
      board.animatingPiece = {
        piece: { ...piece },
        fromRow: from.row,
        fromCol: from.col,
        toRow: to.row,
        toCol: to.col,
        elapsed: 0,
        duration: 0.35,
        jumpedIndex: jumped ? jumped.index : null,
        promotesToKing: (piece.side === 'player' && to.row === 0 && !piece.king) ||
                        (piece.side === 'opponent' && to.row === 7 && !piece.king)
      };
    }

    // Move piece
    board.pieces[from.index] = null;
    board.pieces[to.index] = { ...piece };

    // Capture jumped piece
    if (jumped) {
      board.pieces[jumped.index] = null;
    }

    // King promotion (Player reaches row 0, Opponent reaches row 7)
    let crowned = false;
    if (piece.side === 'player' && to.row === 0 && !piece.king) {
      board.pieces[to.index].king = true;
      crowned = true;
    } else if (piece.side === 'opponent' && to.row === 7 && !piece.king) {
      board.pieces[to.index].king = true;
      crowned = true;
    }

    // Multi-jump check (only if a piece was just jumped and wasn't just crowned)
    if (jumped && !crowned) {
      const furtherJumps = this.getLegalMoves(piece.side, board.pieces, to.index);
      if (furtherJumps.length > 0) {
        board.multiJumpFrom = to.index;
        return { completed: false, furtherJumps };
      }
    }

    board.multiJumpFrom = null;
    return { completed: true };
  }

  checkWinner() {
    const board = this.activeBoard;
    if (!board) return null;

    let playerCount = 0;
    let opponentCount = 0;
    for (const p of board.pieces) {
      if (p?.side === 'player') playerCount++;
      else if (p?.side === 'opponent') opponentCount++;
    }

    if (playerCount === 0) return 'opponent';
    if (opponentCount === 0) return 'player';

    // If active player has no moves available, other player wins
    const moves = this.getLegalMoves(board.turn, board.pieces, board.multiJumpFrom);
    if (moves.length === 0) {
      return board.turn === 'player' ? 'opponent' : 'player';
    }

    return null;
  }

  handleAction(character) {
    if (!this.activeBoard || this.activeBoard.status !== 'playing') return false;
    const isPlayer = character === this.game.player;

    if (isPlayer && this.activeBoard.turn !== 'player') {
      this.onToast(`It's ${this.activeBoard.opponent?.name || 'opponent'}'s turn.`);
      return false;
    }

    const cell = this.cellAtTile(character.x, character.y);
    if (!cell) {
      if (isPlayer) {
        this.onToast('Step onto a checkers board square and press Enter.');
      }
      return false;
    }

    const pieceAtCell = this.activeBoard.pieces[cell.index];
    const availableMoves = this.getLegalMoves(
      this.activeBoard.turn,
      this.activeBoard.pieces,
      this.activeBoard.multiJumpFrom
    );

    // If standing on own piece: Select piece
    if (pieceAtCell && pieceAtCell.side === this.activeBoard.turn) {
      // Must obey multiJumpFrom if in middle of multi-jump
      if (this.activeBoard.multiJumpFrom !== null && this.activeBoard.multiJumpFrom !== cell.index) {
        this.onToast('You must continue jumping with the active piece!');
        return false;
      }

      const movesForPiece = availableMoves.filter(m => m.from.index === cell.index);
      if (movesForPiece.length === 0) {
        if (availableMoves.some(m => m.jumped)) {
          this.onToast('A capture jump is available elsewhere!');
        } else {
          this.onToast('No legal moves for that piece.');
        }
        return false;
      }

      this.selectedCell = cell;
      this.onToast(`Selected ${pieceAtCell.king ? 'King' : 'piece'} at (${cell.col + 1}, ${cell.row + 1}). Now step to destination.`);
      return true;
    }

    // If a piece is currently selected: Try to move to this destination cell
    if (this.selectedCell) {
      const matchingMove = availableMoves.find(
        m => m.from.index === this.selectedCell.index && m.to.index === cell.index
      );

      if (!matchingMove) {
        if (isPlayer) this.onToast('Illegal move! Checkers moves diagonally onto dark squares.');
        return false;
      }

      // Execute move with hopping animation
      const result = this.applyMove(matchingMove, true);
      this.game.triggerCheer(character.id, 1.2);

      if (result.completed) {
        this.selectedCell = null;

        // Walk opponent back if opponent moved
        if (!isPlayer) {
          setTimeout(() => {
            if (this.activeBoard) this.walkOpponentToSideline();
          }, 300);
        }

        // Check for end of game only after handing the turn to the opponent.
        // Otherwise a mover with no remaining moves can be declared the loser
        // even though the opponent has not taken their last turn yet.
        this.activeBoard.turn = isPlayer ? 'opponent' : 'player';
        const winner = this.checkWinner();
        if (winner) {
          this.finishGame(winner);
          return true;
        }

        // Switch-turn messaging/timers
        if (isPlayer) {
          this.activeBoard.thinkingTimer = 0.5 + Math.random() * 0.5;
        } else {
          this.onToast('Your turn! Select a piece to move.');
        }
      } else {
        // Multi-jump continues
        this.selectedCell = matchingMove.to;
        this.onToast('Double jump! Take the next capture.');

        // The opponent keeps the turn for a forced chain jump, so schedule its
        // next leap rather than leaving the board waiting forever.
        if (!isPlayer) {
          this.activeBoard.thinkingTimer = 0.35 + Math.random() * 0.25;
        }
      }

      return true;
    }

    if (isPlayer) {
      this.onToast('Step onto one of your red pieces first to select it.');
    }
    return false;
  }

  finishGame(winner) {
    this.activeBoard.winner = winner;
    this.activeBoard.status = 'ended';

    const resultOutcome = winner === 'player' ? 'win' : (winner === 'opponent' ? 'loss' : 'draw');
    const opponent = this.activeBoard.opponent;
    this.recordResult({
      opponentId: opponent?.id,
      opponentName: opponent?.name,
      result: resultOutcome
    });

    const winnerId = winner === 'player' ? 'player' : opponent?.id;
    if (winnerId) {
      this.game.triggerCheer(winnerId, 2.5);
    }

    setTimeout(() => {
      if (this.activeBoard && this.activeBoard.status === 'ended') {
        this.onGameEnd(winner, opponent);
      }
    }, 1000);
  }

  executeOpponentMove() {
    const board = this.activeBoard;
    if (!board || board.status !== 'playing') return;
    const opponent = board.opponent;
    if (!opponent) return;

    const availableMoves = this.getLegalMoves('opponent', board.pieces, board.multiJumpFrom);
    if (availableMoves.length === 0) {
      this.finishGame('player');
      return;
    }

    // Pick a random available move (favoring captures)
    const jumps = availableMoves.filter(m => m.jumped);
    const pool = jumps.length > 0 ? jumps : availableMoves;
    const chosenMove = pool[Math.floor(Math.random() * pool.length)];

    // Target tile for opponent to step to
    const targetTile = {
      x: board.originX + chosenMove.to.col,
      y: board.originY + chosenMove.to.row
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

    // Pre-select piece and execute move once arrival verified
    this.selectedCell = chosenMove.from;
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
          this.onToast(board.turn === 'player'
            ? 'Checkers ready! Step onto a red piece and press Enter to select.'
            : `${board.opponent?.name || 'Opponent'} is contemplating the opening move...`);
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

    // Check distance: If player wanders more than 2 spaces away from 8x8 board
    if (board.status === 'playing' && this.game.player && !this.abandonPromptActive && !this.returningToBoard) {
      const p = this.game.player;
      const minX = board.originX;
      const maxX = board.originX + CHECKERS_BOARD_SIZE - 1;
      const minY = board.originY;
      const maxY = board.originY + CHECKERS_BOARD_SIZE - 1;

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
      const maxX = board.originX + CHECKERS_BOARD_SIZE - 1;
      const minY = board.originY;
      const maxY = board.originY + CHECKERS_BOARD_SIZE - 1;
      const dist = Math.max(0, minX - p.x, p.x - maxX, minY - p.y, p.y - maxY);
      if (dist <= 2) {
        this.returningToBoard = false;
      }
    }

    // Opponent thinking and walking
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

  render(ctx, camera) {
    if (!this.activeBoard) return;
    const { originX, originY, pieces, status, foldPhase, phaseProgress } = this.activeBoard;
    const TILE = 48;
    const screenX = originX * TILE - camera.x;
    const screenY = originY * TILE - camera.y;
    const boardSize = CHECKERS_BOARD_SIZE * TILE;

    ctx.save();

    const isFolding = status === 'unfolding' || status === 'refolding';
    const progress = typeof phaseProgress === 'number' ? phaseProgress : 1;

    // Helper to draw a square or sub-grid on the checkerboard with wooden border
    const drawBoardCells = (cStart, rStart, cols, rows) => {
      for (let r = rStart; r < rStart + rows; r++) {
        for (let c = cStart; c < cStart + cols; c++) {
          const isDark = (r + c) % 2 === 1;
          ctx.fillStyle = isDark ? '#3d2817' : '#e6d2b5';
          ctx.fillRect(screenX + c * TILE, screenY + r * TILE, TILE, TILE);

          ctx.strokeStyle = 'rgba(0, 0, 0, 0.15)';
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

      // Outer border mat for this section
      ctx.fillStyle = 'rgba(74, 48, 28, 0.95)';
      ctx.fillRect(px - 4, py - 4, pw + 8, ph + 8);
      ctx.strokeStyle = 'rgba(40, 24, 12, 0.85)';
      ctx.lineWidth = 2.5;
      ctx.strokeRect(px - 4, py - 4, pw + 8, ph + 8);

      // Cells inside
      drawBoardCells(cStart, rStart, cols, rows);

      // Flap fold crease shading
      if (isFlap) {
        ctx.fillStyle = `rgba(0, 0, 0, ${0.25 * (1 - Math.sin(foldAngle))})`;
        ctx.fillRect(px, py, pw, ph);
      }
      ctx.restore();
    };

    if (isFolding) {
      // 4 folding stages:
      // Stage 0: 2x2 base center-left at cols 1..2, rows 3..4. Flap extends horizontally right to form 2x4 (cols 1..4, rows 3..4)
      // Stage 1: 2x4 (cols 1..4, rows 3..4). Flap extends vertically up and down to form 4x4 (cols 1..4, rows 2..5)
      // Stage 2: 4x4 (cols 1..4, rows 2..5). Flap extends horizontally to cols 0..7 (8x4, rows 2..5)
      // Stage 3: 8x4 (cols 0..7, rows 2..5). Flaps extend vertically up to row 0 and down to row 7 (8x8)
      if (foldPhase === 0) {
        // Base 2x2 at cols 1..2, rows 3..4
        drawPanel(1, 3, 2, 2);
        // Flap opening to the right (cols 3..4, rows 3..4)
        const flapW = 2 * progress;
        if (flapW > 0.05) {
          ctx.save();
          drawPanel(3, 3, flapW, 2, true, progress * Math.PI * 0.5);
          ctx.restore();
        }
      } else if (foldPhase === 1) {
        // Flat 2x4 at cols 1..4, rows 3..4
        drawPanel(1, 3, 4, 2);
        // Flaps opening vertically up (row 2) and down (row 5)
        const flapH = 1 * progress;
        if (flapH > 0.05) {
          drawPanel(1, 3 - flapH, 4, flapH, true, progress * Math.PI * 0.5);
          drawPanel(1, 5, 4, flapH, true, progress * Math.PI * 0.5);
        }
      } else if (foldPhase === 2) {
        // Flat 4x4 at cols 1..4, rows 2..5 (rows 2, 3, 4, 5)
        drawPanel(1, 2, 4, 4);
        // Flaps opening horizontally left (col 0) and right (cols 5..7)
        const flapLeftW = 1 * progress;
        const flapRightW = 3 * progress;
        if (flapLeftW > 0.05) {
          drawPanel(1 - flapLeftW, 2, flapLeftW, 4, true, progress * Math.PI * 0.5);
        }
        if (flapRightW > 0.05) {
          drawPanel(5, 2, flapRightW, 4, true, progress * Math.PI * 0.5);
        }
      } else if (foldPhase === 3) {
        // Flat 8x4 at cols 0..7, rows 2..5
        drawPanel(0, 2, 8, 4);
        // Flaps opening vertically up (rows 0..1) and down (rows 6..7)
        const flapH = 2 * progress;
        if (flapH > 0.05) {
          drawPanel(0, 2 - flapH, 8, flapH, true, progress * Math.PI * 0.5);
          drawPanel(0, 6, 8, flapH, true, progress * Math.PI * 0.5);
        }
      }
    } else {
      // Fully open 8x8 board
      ctx.fillStyle = 'rgba(74, 48, 28, 0.95)';
      ctx.fillRect(screenX - 6, screenY - 6, boardSize + 12, boardSize + 12);
      ctx.strokeStyle = 'rgba(40, 24, 12, 0.8)';
      ctx.lineWidth = 3;
      ctx.strokeRect(screenX - 6, screenY - 6, boardSize + 12, boardSize + 12);

      drawBoardCells(0, 0, 8, 8);
    }

    // Highlight selected piece square and legal move destinations
    if (this.selectedCell && status === 'playing') {
      const selX = screenX + this.selectedCell.col * TILE;
      const selY = screenY + this.selectedCell.row * TILE;
      ctx.fillStyle = 'rgba(241, 196, 15, 0.45)';
      ctx.fillRect(selX, selY, TILE, TILE);
      ctx.strokeStyle = '#f1c40f';
      ctx.lineWidth = 2.5;
      ctx.strokeRect(selX + 2, selY + 2, TILE - 4, TILE - 4);

      // Highlight possible destinations for selected piece
      const moves = this.getLegalMoves(
        this.activeBoard.turn,
        pieces,
        this.activeBoard.multiJumpFrom
      ).filter(m => m.from.index === this.selectedCell.index);

      for (const m of moves) {
        const destX = screenX + m.to.col * TILE;
        const destY = screenY + m.to.row * TILE;
        ctx.fillStyle = 'rgba(46, 204, 113, 0.4)';
        ctx.fillRect(destX, destY, TILE, TILE);
        ctx.strokeStyle = '#2ecc71';
        ctx.lineWidth = 2;
        ctx.strokeRect(destX + 2, destY + 2, TILE - 4, TILE - 4);
      }
    }

    // Helper to draw a single checkers piece disc
    const drawPieceDisc = (piece, cx, cy, radius, scale = 1, hopOffset = 0) => {
      ctx.save();
      // Drop shadow expands and softens when piece is high in the air
      ctx.beginPath();
      const shadowY = cy + 2 + hopOffset * 0.4;
      const shadowRadius = radius * (1 - hopOffset * 0.005);
      ctx.arc(cx + 1, shadowY, Math.max(1, shadowRadius), 0, Math.PI * 2);
      ctx.fillStyle = `rgba(0, 0, 0, ${Math.max(0.12, 0.35 - hopOffset * 0.008)})`;
      ctx.fill();

      // Outer piece disc elevated by hopOffset
      const pieceY = cy - hopOffset;
      ctx.beginPath();
      ctx.arc(cx, pieceY, radius * scale, 0, Math.PI * 2);
      ctx.fillStyle = piece.side === 'player' ? '#d63031' : '#2d3436';
      ctx.fill();
      ctx.strokeStyle = piece.side === 'player' ? '#ff7675' : '#636e72';
      ctx.lineWidth = 2.5 * scale;
      ctx.stroke();

      // Inner ridge circle
      ctx.beginPath();
      ctx.arc(cx, pieceY, radius * 0.65 * scale, 0, Math.PI * 2);
      ctx.strokeStyle = piece.side === 'player' ? '#fab1a0' : '#b2bec3';
      ctx.lineWidth = 1.5 * scale;
      ctx.stroke();

      // King crown insignia
      if (piece.king) {
        ctx.fillStyle = '#f1c40f';
        ctx.font = `bold ${Math.round(16 * scale)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('👑', cx, pieceY);
      }
      ctx.restore();
    };

    // Render pieces
    if (status === 'playing' || status === 'ended') {
      const anim = this.activeBoard.animatingPiece;
      const skipIndex = anim ? anim.toRow * 8 + anim.toCol : -1;

      for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
          const idx = r * 8 + c;
          if (idx === skipIndex) continue; // Drawn by tween animation below

          const piece = pieces[idx];
          if (!piece) continue;

          const cx = screenX + (c + 0.5) * TILE;
          const cy = screenY + (r + 0.5) * TILE;
          const radius = TILE * 0.38;
          drawPieceDisc(piece, cx, cy, radius);
        }
      }

      // Render animating piece with smooth parabolic hop arc
      if (anim) {
        const t = Math.min(1, anim.elapsed / anim.duration);
        // Smooth sine ease in-out for horizontal/vertical translation
        const ease = 0.5 - 0.5 * Math.cos(t * Math.PI);
        const curCol = anim.fromCol + (anim.toCol - anim.fromCol) * ease;
        const curRow = anim.fromRow + (anim.toRow - anim.fromRow) * ease;

        const cx = screenX + (curCol + 0.5) * TILE;
        const cy = screenY + (curRow + 0.5) * TILE;
        // Parabolic jump arc: peak hop at middle of trajectory (t = 0.5)
        const hopHeight = 22 * Math.sin(t * Math.PI);
        const radius = TILE * 0.38;
        const scale = 1 + 0.12 * Math.sin(t * Math.PI);

        drawPieceDisc(anim.piece, cx, cy, radius, scale, hopHeight);
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
      const label = this.activeBoard.winner === 'player'
        ? 'You Won Checkers!'
        : `${this.activeBoard.opponent?.name || 'Opponent'} Won Checkers!`;
      ctx.fillText(label, screenX + boardSize / 2, screenY + boardSize / 2);
    }

    ctx.restore();
  }
}
