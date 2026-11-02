import { findPath, findOpenTile, isWalkable, typeAt } from '../world.js';
import { spectatorOffsets } from '../characters.js';
import { recordGameResult } from '../storage.js';

export class TicTacToeMiniGame {
  constructor({ game, onToast, onReject, onGameEnd, onAbandonPrompt, recordResult } = {}) {
    this.game = game;
    this.onToast = onToast || (() => {});
    this.onReject = onReject || (() => {});
    this.onGameEnd = onGameEnd || (() => {});
    this.onAbandonPrompt = onAbandonPrompt || (() => {});
    // Injectable so contract adapters can leave stats/rewards to the host.
    this.recordResult = recordResult || recordGameResult;
    this.activeBoard = null;
    this.nextStarter = 'player'; // Alternate starting player between rounds
    this.abandonPromptActive = false;
  }

  isOpen() {
    return Boolean(this.activeBoard);
  }

  // Ensure board has at least 1 extra walkable tile to the left, right, top, and bottom
  // i.e., bounds from originX - 1 to originX + 3, and originY - 1 to originY + 3
  canPlaceAt(originX, originY) {
    if (!this.game?.terrain) return false;
    for (let dy = -1; dy <= 3; dy++) {
      for (let dx = -1; dx <= 3; dx++) {
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
    // Directly next to the player on the right (player at aroundX, board starts at aroundX + 1)
    const offsets = [
      { dx: 1, dy: -1 }, // directly adjacent right!
      { dx: 1, dy: 0 },
      { dx: 1, dy: -2 },
      { dx: 2, dy: -1 },
      { dx: -3, dy: -1 },
      { dx: -1, dy: 1 },
      { dx: -1, dy: -3 }
    ];

    for (const offset of offsets) {
      const ox = aroundX + offset.dx;
      const oy = aroundY + offset.dy;
      if (this.canPlaceAt(ox, oy)) {
        return { originX: ox, originY: oy };
      }
    }
    return null;
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
        this.onToast('Need open ground with room to stand around to lay out Tic-Tac-Toe.');
        return false;
      }
      spot = { originX, originY };
    } else {
      spot = this.findPlacementSpot(player.x, player.y);
      if (!spot) {
        this.onToast('Need open ground with room to stand around to lay out Tic-Tac-Toe.');
        return false;
      }
    }

    const starter = this.nextStarter;
    this.nextStarter = starter === 'player' ? 'opponent' : 'player';

    // 1.) Establish exact staging target coordinates around the 3x3 board:
    // Middle row (Y = originY + 1):
    //   Left of Tile 4:  (originX - 1, originY + 1) -> Player
    //   Right of Tile 6: (originX + 3, originY + 1) -> Opponent
    // Bottom row (Y = originY + 2):
    //   Left of Tile 1:  (originX - 1, originY + 2) -> Player's Companion
    //   Right of Tile 9: (originX + 3, originY + 2) -> Opponent's Companion
    const playerTarget = { x: spot.originX - 1, y: spot.originY + 1 };
    const playerCompTarget = { x: spot.originX - 1, y: spot.originY + 2 };
    const opponentTarget = { x: spot.originX + 3, y: spot.originY + 1 };
    const opponentCompTarget = { x: spot.originX + 3, y: spot.originY + 2 };

    // Block all 9 board tiles for staging pathfinding so characters walk around the board
    const boardBlocked = new Set();
    for (let dy = 0; dy < 3; dy++) {
      for (let dx = 0; dx < 3; dx++) {
        boardBlocked.add(`${spot.originX + dx},${spot.originY + dy}`);
      }
    }

    // Auto-walk Player to left of Tile 4
    if (player.x !== playerTarget.x || player.y !== playerTarget.y) {
      const pPath = findPath(this.game.terrain, { x: player.x, y: player.y }, playerTarget);
      if (pPath.length) player.path = pPath;
      else { player.x = playerTarget.x; player.y = playerTarget.y; }
    }
    player.direction = 1; // Facing right toward board

    // Auto-walk all active Player companions to spectator positions.
    // They alternate above and below the player instead of stacking in one column.
    const playerComps = this.game.getCompanionsFor?.('player') || [];
    const offsets = spectatorOffsets(playerComps.length);
    playerComps.forEach((comp, idx) => {
      const target = { x: spot.originX - 1, y: playerTarget.y + offsets[idx] };
      comp.fetchTarget = null;
      comp.stagedDestination = target;
      const compPath = findPath(this.game.terrain, { x: comp.x, y: comp.y }, target);
      if (compPath.length) comp.path = compPath;
      else { comp.x = target.x; comp.y = target.y; }
      comp.direction = 1;
    });

    // Auto-walk Opponent directly to right of Tile 6
    if (opponent) {
      opponent.inMiniGame = true;
      opponent.moving = false;
      const oppPath = findPath(this.game.terrain, { x: opponent.x, y: opponent.y }, opponentTarget);
      if (oppPath.length) opponent.path = oppPath;
      else { opponent.x = opponentTarget.x; opponent.y = opponentTarget.y; }
      opponent.direction = 3; // Facing left toward board
    }

    // Auto-walk Opponent's companion directly to right of Tile 9
    const oppComp = opponent ? this.game.getCompanionFor(opponent.id) : null;
    if (opponent && oppComp) {
      oppComp.fetchTarget = null;
      oppComp.stagedDestination = opponentCompTarget;
      const oppCompPath = findPath(this.game.terrain, { x: oppComp.x, y: oppComp.y }, opponentCompTarget);
      if (oppCompPath.length) oppComp.path = oppCompPath;
      else { oppComp.x = opponentCompTarget.x; oppComp.y = opponentCompTarget.y; }
      oppComp.direction = 3;
    }

    // Flee bystanders (NPCs and companions) caught standing on the newly launched board
    this.evacuateBoard(spot.originX, spot.originY, [player, ...playerComps, opponent, oppComp]);

    this.activeBoard = {
      originX: spot.originX,
      originY: spot.originY,
      sidelineX: opponentTarget.x,
      sidelineY: opponentTarget.y,
      grid: Array(9).fill(null),
      opponent,
      turn: starter,
      winner: null,
      status: 'unfolding', // 'unfolding', 'playing', 'refolding', 'ended'
      foldPhase: 0,
      phaseProgress: 0, // 0 to 1 smooth continuous progress for folding flap
      foldTimer: 0,
      thinkingTimer: starter === 'opponent' ? 0.8 : 0
    };

    this.abandonPromptActive = false;
    this.onToast(`Unfurling Tic-Tac-Toe board on the ground...`);
    return true;
  }

  resetRound() {
    if (!this.activeBoard) return;
    const starter = this.nextStarter;
    this.nextStarter = starter === 'player' ? 'opponent' : 'player';

    this.activeBoard.grid = Array(9).fill(null);
    this.activeBoard.turn = starter;
    this.activeBoard.winner = null;
    this.activeBoard.status = 'playing';
    this.activeBoard.thinkingTimer = starter === 'opponent' ? 0.4 + Math.random() * 0.4 : 0;
    this.walkOpponentToSideline();

    const starterText = starter === 'player' ? 'You start!' : `${this.activeBoard.opponent?.name || 'Opponent'} starts!`;
    this.onToast(`New round! ${starterText}`);
  }

  returnPlayerToBoard() {
    const board = this.activeBoard;
    if (!board || !this.game.player) return;
    const player = this.game.player;
    const targetX = board.originX - 1;
    const targetY = board.originY + 1;

    // Halt any current destination/movement
    player.moving = false;
    player.path = [];
    if (this.game) {
      this.game.heldKeys = [];
      this.game.destination = null;
    }

    if (player.x !== targetX || player.y !== targetY) {
      const pPath = findPath(this.game.terrain, { x: player.x, y: player.y }, { x: targetX, y: targetY });
      if (pPath.length) {
        player.path = pPath;
      } else {
        player.x = targetX;
        player.y = targetY;
      }
    }
    player.direction = 1; // Face right toward board
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
    return x >= originX && x <= originX + 2 && y >= originY && y <= originY + 2;
  }

  evacuateBoard(originX, originY, participants = []) {
    if (!this.game) return;
    const participantSet = new Set(participants.filter(Boolean));
    const boardTiles = new Set();
    for (let dy = 0; dy < 3; dy++) {
      for (let dx = 0; dx < 3; dx++) {
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
        // Bystander is standing on the spawning board: find nearby open tile off the board to flee to
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

  startRefolding(onComplete) {
    if (!this.activeBoard) return;
    this.activeBoard.status = 'refolding';
    this.activeBoard.foldPhase = 3;
    this.activeBoard.phaseProgress = 1;
    this.activeBoard.foldTimer = 0;
    this.activeBoard.onRefoldComplete = onComplete;
    this.walkOpponentToSideline();
  }

  packUpBoard() {
    if (!this.activeBoard) return;
    this.startRefolding(() => {
      if (this.activeBoard?.opponent) {
        this.activeBoard.opponent.inMiniGame = false;
      }
      // Clear staged spectator destination on companions so they resume following
      for (const comp of this.game.companions || []) {
        comp.stagedDestination = null;
      }
      this.activeBoard = null;
      this.onToast('Packed up the Tic-Tac-Toe board into your bag.');
    });
  }

  cellAtTile(x, y) {
    if (!this.activeBoard) return null;
    const { originX, originY } = this.activeBoard;
    const col = x - originX;
    const row = y - originY;
    if (col >= 0 && col < 3 && row >= 0 && row < 3) {
      return { row, col, index: row * 3 + col };
    }
    return null;
  }

  /** Target ring: a square is valid when the board is playing and it is empty. */
  describeTarget(tile) {
    const board = this.activeBoard;
    if (!board || board.status !== 'playing' || !tile) return null;
    const target = { x: tile.x, y: tile.y };
    const cell = this.cellAtTile(tile.x, tile.y);
    if (!cell) return { tile: target, valid: false };
    return { tile: target, valid: board.grid[cell.index] === null };
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

    if (this.activeBoard.grid[cell.index] !== null) {
      if (isPlayer) this.onReject({ reason: 'occupied' });
      return false;
    }

    const symbol = isPlayer ? 'X' : 'O';
    this.activeBoard.grid[cell.index] = symbol;

    // Trigger cheer for the character's buddy
    this.game.triggerCheer(character.id, 1.2);

    // If opponent made their move, walk them back to their sideline standby position
    if (!isPlayer) {
      setTimeout(() => {
        if (this.activeBoard) this.walkOpponentToSideline();
      }, 300);
    }

    const winner = this.checkWinner();
    if (winner) {
      this.activeBoard.winner = winner;
      this.activeBoard.status = 'ended';

      let resultOutcome = 'draw';
      if (winner === 'X') resultOutcome = 'win';
      else if (winner === 'O') resultOutcome = 'loss';

      const opponent = this.activeBoard.opponent;
      this.recordResult({
        opponentId: opponent?.id,
        opponentName: opponent?.name,
        result: resultOutcome
      });

      if (winner === 'draw') {
        this.game.triggerCheer(this.game.player?.id, 1.5);
        if (opponent) this.game.triggerCheer(opponent.id, 1.5);
      } else {
        const winnerId = winner === 'X' ? this.game.player?.id : opponent?.id;
        this.game.triggerCheer(winnerId, 2.5);
      }

      // Notify callback to trigger rematch dialogue
      setTimeout(() => {
        if (this.activeBoard && this.activeBoard.status === 'ended') {
          this.onGameEnd(winner, opponent);
        }
      }, 1000);

      return true;
    }

    // Switch turns
    if (isPlayer) {
      this.activeBoard.turn = 'opponent';
      this.activeBoard.thinkingTimer = 0.2 + Math.random() * 0.6;
    } else {
      this.activeBoard.turn = 'player';
    }

    return true;
  }

  update(dt) {
    if (!this.activeBoard) return;
    const board = this.activeBoard;

    // Unfolding animation phases with smooth angular opening
    const PHASE_DURATION = 0.35;
    if (board.status === 'unfolding') {
      board.foldTimer += dt;
      board.phaseProgress = Math.min(1, board.foldTimer / PHASE_DURATION);
      if (board.foldTimer >= PHASE_DURATION) {
        board.foldTimer = 0;
        board.phaseProgress = 0;
        board.foldPhase++;
        if (board.foldPhase >= 3) {
          board.status = 'playing';
          board.phaseProgress = 1;
          this.onToast(board.turn === 'player'
            ? 'Board is ready! Step onto a square and press Enter to mark X.'
            : `${board.opponent?.name || 'Opponent'} is contemplating the first move...`);
        }
      }
      return;
    }

    // Refolding animation phases with smooth closing
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

    // Distance check: If player wanders more than 2 spaces away from board boundary
    if (board.status === 'playing' && this.game.player && !this.abandonPromptActive && !this.returningToBoard) {
      const p = this.game.player;
      const minX = board.originX;
      const maxX = board.originX + 2;
      const minY = board.originY;
      const maxY = board.originY + 2;

      const distLeft = minX - p.x;
      const distRight = p.x - maxX;
      const distTop = minY - p.y;
      const distBottom = p.y - maxY;
      const dist = Math.max(0, distLeft, distRight, distTop, distBottom);

      // If returning to board, check if arrived back within boundary
      if (dist <= 2) {
        this.returningToBoard = false;
      } else {
        this.abandonPromptActive = true;
        this.onAbandonPrompt(() => {
          // Confirm abandon
          this.abandonPromptActive = false;
          this.returningToBoard = false;
          this.packUpBoard();
        }, () => {
          // Cancel abandon, stay in game: walk player back to the game board sideline
          this.abandonPromptActive = false;
          this.returningToBoard = true;
          this.returnPlayerToBoard();
        });
      }
    } else if (this.returningToBoard && this.game.player) {
      const p = this.game.player;
      const minX = board.originX;
      const maxX = board.originX + 2;
      const minY = board.originY;
      const maxY = board.originY + 2;
      const dist = Math.max(0, minX - p.x, p.x - maxX, minY - p.y, p.y - maxY);
      if (dist <= 2) {
        this.returningToBoard = false;
      }
    }

    // Opponent thinking, walking, and arrival flow
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

  executeOpponentMove() {
    const board = this.activeBoard;
    if (!board || board.status !== 'playing') return;
    const opponent = board.opponent;
    if (!opponent) return;

    // Find available spots
    const available = [];
    board.grid.forEach((val, idx) => {
      if (val === null) available.push(idx);
    });

    if (!available.length) return;

    // AI logic: center first, or random
    const chosenIndex = available.includes(4) && Math.random() > 0.3
      ? 4
      : available[Math.floor(Math.random() * available.length)];

    const col = chosenIndex % 3;
    const row = Math.floor(chosenIndex / 3);
    const targetX = board.originX + col;
    const targetY = board.originY + row;

    board.steppingTo = { x: targetX, y: targetY };
    opponent.miniGameTarget = { x: targetX, y: targetY };

    // Pathfind opponent from their current position (whether on sideline or walking back) to target cell
    const currentOppX = opponent.moving ? opponent.toX : opponent.x;
    const currentOppY = opponent.moving ? opponent.toY : opponent.y;
    const path = findPath(this.game.terrain, { x: currentOppX, y: currentOppY }, { x: targetX, y: targetY });

    if (path.length) {
      opponent.path = path;
    } else {
      opponent.x = targetX;
      opponent.y = targetY;
      board.steppingTo = null;
      this.handleAction(opponent);
    }
  }

  checkWinner() {
    const g = this.activeBoard.grid;
    const lines = [
      [0, 1, 2], [3, 4, 5], [6, 7, 8], // rows
      [0, 3, 6], [1, 4, 7], [2, 5, 8], // cols
      [0, 4, 8], [2, 4, 6]             // diagonals
    ];

    for (const [a, b, c] of lines) {
      if (g[a] && g[a] === g[b] && g[a] === g[c]) {
        return g[a];
      }
    }

    if (g.every(cell => cell !== null)) {
      return 'draw';
    }

    return null;
  }

  render(ctx, camera) {
    if (!this.activeBoard) return;
    const { originX, originY, grid, status, foldPhase, phaseProgress } = this.activeBoard;
    const TILE = 48;
    const screenX = originX * TILE - camera.x;
    const screenY = originY * TILE - camera.y;

    ctx.save();

    const isFolding = status === 'unfolding' || status === 'refolding';
    const progress = typeof phaseProgress === 'number' ? phaseProgress : 1;

    // Helper to draw a board panel/leaf with realistic cardboard/fabric texture and bevel
    const drawPanel = (x, y, w, h, isFlap = false, foldAngle = 0) => {
      ctx.save();
      if (isFlap && foldAngle !== 0) {
        // Perspective crease shadow when folding open/closed
        ctx.shadowColor = 'rgba(0, 0, 0, 0.25)';
        ctx.shadowBlur = 8;
        ctx.shadowOffsetY = 4;
      }

      // Base card surface
      ctx.fillStyle = isFlap ? 'rgba(238, 230, 210, 0.98)' : 'rgba(245, 238, 220, 0.95)';
      ctx.fillRect(x - 2, y - 2, w + 4, h + 4);

      // Cardboard/fabric trim border
      ctx.strokeStyle = isFlap ? 'rgba(90, 60, 35, 0.65)' : 'rgba(120, 80, 50, 0.45)';
      ctx.lineWidth = 2.5;
      ctx.strokeRect(x - 2, y - 2, w + 4, h + 4);

      // Crease line on edges
      if (isFlap) {
        ctx.fillStyle = `rgba(0, 0, 0, ${0.18 * (1 - Math.sin(foldAngle))})`;
        ctx.fillRect(x - 2, y - 2, w + 4, h + 4);
      }
      ctx.restore();
    };

    if (isFolding) {
      // Phase 0: Placed on center-left tile 4 (screenX, screenY + TILE).
      // Folds vertically up and down to reveal tiles 7 and 1 (entire column 0).
      if (foldPhase === 0) {
        // Center base tile
        drawPanel(screenX, screenY + TILE, TILE, TILE);

        // Flaps folding outward vertically
        const flapH = TILE * progress;
        if (flapH > 1) {
          // Top flap opening upward
          drawPanel(screenX, screenY + TILE - flapH, TILE, flapH, true, progress * Math.PI * 0.5);
          // Bottom flap opening downward
          drawPanel(screenX, screenY + TILE * 2, TILE, flapH, true, progress * Math.PI * 0.5);
        }
      } else if (foldPhase === 1) {
        // Phase 1: Column 0 is fully unfolded.
        // Middle column (tiles 2, 5, 8) unfolds outward to the right.
        drawPanel(screenX, screenY, TILE, TILE * 3);

        const flapW = TILE * progress;
        if (flapW > 1) {
          drawPanel(screenX + TILE, screenY, flapW, TILE * 3, true, progress * Math.PI * 0.5);
        }
      } else if (foldPhase === 2) {
        // Phase 2: Column 0 and Column 1 are flat.
        // Last column (tiles 3, 6, 9) unfolds outward to the right.
        drawPanel(screenX, screenY, TILE * 2, TILE * 3);

        const flapW = TILE * progress;
        if (flapW > 1) {
          drawPanel(screenX + TILE * 2, screenY, flapW, TILE * 3, true, progress * Math.PI * 0.5);
        }
      }
    } else {
      // Full 3x3 unfolded board
      drawPanel(screenX, screenY, TILE * 3, TILE * 3);
    }

    // Grid lines rendered once mostly flat
    if (!isFolding || foldPhase >= 2) {
      ctx.strokeStyle = 'rgba(60, 40, 20, 0.7)';
      ctx.lineWidth = 4;
      ctx.lineCap = 'round';

      // Vertical lines
      ctx.beginPath();
      ctx.moveTo(screenX + TILE, screenY);
      ctx.lineTo(screenX + TILE, screenY + TILE * 3);
      if (!isFolding || (foldPhase === 2 && progress > 0.8)) {
        ctx.moveTo(screenX + TILE * 2, screenY);
        ctx.lineTo(screenX + TILE * 2, screenY + TILE * 3);
      }
      // Horizontal lines
      ctx.moveTo(screenX, screenY + TILE);
      ctx.lineTo(screenX + (isFolding ? TILE * 2 : TILE * 3), screenY + TILE);
      ctx.moveTo(screenX, screenY + TILE * 2);
      ctx.lineTo(screenX + (isFolding ? TILE * 2 : TILE * 3), screenY + TILE * 2);
      ctx.stroke();
    }

    // Render pieces if in playing or ended state
    if (status === 'playing' || status === 'ended') {
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) {
          const piece = grid[r * 3 + c];
          if (!piece) continue;

          const cx = screenX + (c + 0.5) * TILE;
          const cy = screenY + (r + 0.5) * TILE;

          if (piece === 'X') {
            ctx.strokeStyle = '#e74c3c';
            ctx.lineWidth = 6;
            const s = 14;
            ctx.beginPath();
            ctx.moveTo(cx - s, cy - s);
            ctx.lineTo(cx + s, cy + s);
            ctx.moveTo(cx + s, cy - s);
            ctx.lineTo(cx - s, cy + s);
            ctx.stroke();
          } else if (piece === 'O') {
            ctx.strokeStyle = '#2980b9';
            ctx.lineWidth = 6;
            ctx.beginPath();
            ctx.arc(cx, cy, 14, 0, Math.PI * 2);
            ctx.stroke();
          }
        }
      }
    }

    // Status banner if ended
    if (status === 'ended') {
      const boardSize = TILE * 3;
      ctx.fillStyle = 'rgba(20, 30, 22, 0.85)';
      ctx.fillRect(screenX, screenY + boardSize / 2 - 20, boardSize, 40);
      ctx.fillStyle = '#edf4e9';
      ctx.font = '700 14px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const label = this.activeBoard.winner === 'draw'
        ? 'Draw Game!'
        : `${this.activeBoard.winner === 'X' ? 'You' : (this.activeBoard.opponent?.name || 'Opponent')} Won!`;
      ctx.fillText(label, screenX + boardSize / 2, screenY + boardSize / 2);
    }

    ctx.restore();
  }
}
