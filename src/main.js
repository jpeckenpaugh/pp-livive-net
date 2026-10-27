import { Game, COMPANION_CAPS } from './game.js';
import {
  createRecipe,
  createCompanionRecipe,
  avatarDataUrl,
  bindAnimatedAvatar,
  preloadAvatars
} from './avatar.js';
import {
  generateWorld,
  encodeTerrain,
  decodeTerrain,
  makeSeed,
  isWalkable,
  findOpenTile,
  findPath
} from './world.js';
import { PLAYER_NAMES, COMPANION_NAMES, pickName, pickVibe } from './names.js';
import { serializeSave, saveState, loadSave, clearSave, recordGameResult } from './storage.js';
import { DialogueManager } from './dialogue.js';
import { createItemInstance, createStarterInventory, normalizeInventory } from './inventory.js';
import { SetupWizard } from './ui/wizard.js';
import { PanelsUI } from './ui/panels.js';
import { MiniGameHost } from './minigames/host.js';
import { registerContractGames } from './games/contract-adapters.js';
import { buildAbandonPrompt, dialogueForMeta } from './minigames/settlement.js';
import { SpeechBubbles } from './ui/speech.js';
import { BehaviorRuntime } from './behavior/runtime.js';
import { CooldownStore } from './behavior/cooldowns.js';
import {
  bridgeBehaviorEvents,
  createNpcGameAdapter,
  createSocialActions
} from './behavior/actions/social.js';
import { EFFECT_CATALOG } from './effects.js';
import engineConfig from '../data/engine_config.json' with { type: 'json' };
import dialogueData from '../data/dialogues.json' with { type: 'json' };
import behaviorData from '../data/behaviors.json' with { type: 'json' };
import miniGamesData from '../data/minigames.json' with { type: 'json' };
import { rollReward, applyReward } from './rewards.js';
import { awardNpcGame } from './npc/game-rewards.js';
import { autoEquipOwner } from './npc/loadout.js';

const MAX_NPCS = engineConfig.crowd.maxNpcs;
const DEFAULT_CROWD = engineConfig.crowd.defaultCount;
const DEFAULT_STEP_MS = 180;

const $ = id => document.getElementById(id);

let game = null;
let draft = null;
let dialogue = null;
let host = null;
let bubbles = null;
let behaviorRuntime = null;
let npcGameAdapter = null;
let wizard = null;
let panels = null;
let friends = new Set();
let toastTimer = 0;
let entered = false;
let lastFrameAt = 0;
let npcWatchPrompt = null;
let delegated = { host: false, runtime: false, bubbles: false };

function makeId(prefix) {
  const value = globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2, 10);
  return `${prefix}-${value}`;
}

function randomFrom(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function msToSeconds(ms) {
  const value = Number(ms);
  return Number.isFinite(value) && value > 0 ? value / 1000 : DEFAULT_STEP_MS / 1000;
}

function resolveCharacter(id) {
  if (!game || id == null) return null;
  if (id === 'player' || id === game.player?.id) return game.player;
  return game.getNpc?.(id) || game.companions?.find(companion => companion.id === id) || null;
}

function behaviorActors() {
  if (!game) return [];
  return [...(game.npcs || []), ...(game.companions || [])];
}

function showToast(message) {
  const toast = $('toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove('show'), 2400);
}

function friendNpcs() {
  if (!game) return [];
  return game.npcs.filter(npc => friends.has(npc.id));
}

function onFriendshipChanged(npcId, isFriend) {
  if (isFriend) friends.add(npcId);
  else friends.delete(npcId);
  panels?.updateFriendsUI();
  saveNow();
}

function onDialogueEnded() {
  game?.select(null);
  game?.resumeFromDialogue();
  behaviorRuntime?.setDialogue(false);
  panels?.updateFriendsUI();
  saveNow();
}

/** Table games are friends-only; metadata supplies the item and label. */
function tableGamesFor(opponent) {
  if (!host || !game?.player) return [];
  const isFriend = Boolean(opponent && friends.has(opponent.id));
  const owned = new Set((game.player.inventory || []).map(item => item?.id).filter(Boolean));
  return [...host.registry.values()]
    .filter(entry => entry.meta.kind === 'board')
    .filter(entry => owned.has(entry.meta.itemId))
    .map(entry => ({
      id: entry.meta.id,
      label: entry.meta.title || entry.meta.id,
      enabled: isFriend
    }));
}

function openDialogue(npc) {
  if (!npc) return;
  dismissNpcWatchPrompt();
  panels?.closeAllPanels();
  game.select(npc.id);
  behaviorRuntime?.setDialogue(true);
  const isFriend = friends.has(npc.id);
  dialogue.open(npc, isFriend, { games: tableGamesFor(npc) });
}

function refreshMiniGameFlags() {
  if (!game) return;
  const participants = new Set(host?.session?.participants || []);
  for (const npc of game.npcs || []) npc.inMiniGame = participants.has(npc);
  for (const companion of game.companions || []) companion.inMiniGame = participants.has(companion);
  if (game.player) game.player.inMiniGame = participants.has(game.player);
}

function npcOwnsSession() {
  const session = host?.session;
  return Boolean(session && session.seats?.length && session.seats.every(seat => seat.controller === 'ai'));
}

function packUpNpcSession(reason = 'packed-up') {
  const token = npcGameAdapter?.activeToken?.();
  if (token) npcGameAdapter.finish(token, { reason });
  else if (host?.isOpen()) host.close({ reason, settle: false, record: false, reward: false });
  refreshMiniGameFlags();
}

function packUpGame(gameId = null) {
  if (!host?.isOpen()) return false;
  const session = host.session;
  if (gameId && session.meta.id !== gameId) return false;
  if (npcOwnsSession()) {
    packUpNpcSession('packed-up');
  } else {
    host.close({ reason: 'packed-up', settle: false });
    refreshMiniGameFlags();
  }
  showToast(`${session.meta.title || 'Game'} packed up.`);
  return true;
}

function onPlayGame(gameId, opponent) {
  if (!host || !game?.player) return;
  const meta = host.getMeta(gameId);
  if (!meta) {
    showToast('That game is not unpacked yet.');
    return;
  }

  if (host.isOpen()) {
    if (npcOwnsSession()) {
      packUpNpcSession('player-start');
    } else if (host.activeGameId === gameId) {
      showToast(`${meta.title} is already open. Pack it up first.`);
      return;
    } else {
      showToast(`${host.session.meta.title || 'A game'} is already open. Pack it up first.`);
      return;
    }
  }

  const friend = opponent || friendNpcs()[0] || null;
  if (!friend) {
    showToast('Make a friend first — table games are for friends.');
    return;
  }

  const result = host.start(gameId, {
    seats: [
      { character: game.player, controller: 'human', role: 'player' },
      { character: friend, controller: 'ai', role: 'opponent' }
    ],
    controllers: ['human', 'ai'],
    options: {
      onAbandonPrompt: (onConfirm, onCancel) => showAbandonPrompt(meta, friend, onConfirm, onCancel)
    }
  });

  if (!result.ok) {
    showToast(result.message || `${meta.title} could not open here.`);
    return;
  }
  refreshMiniGameFlags();
  panels?.updateDebugUI?.();
}

function facingTile(character, distance = 3) {
  const directions = [
    { dx: 0, dy: 1 },
    { dx: 1, dy: 0 },
    { dx: 0, dy: -1 },
    { dx: -1, dy: 0 }
  ];
  const delta = directions[character?.direction] || directions[0];
  return {
    x: Math.max(0, Math.min(63, (character?.x ?? 32) + delta.dx * distance)),
    y: Math.max(0, Math.min(63, (character?.y ?? 32) + delta.dy * distance))
  };
}

function onThrowBall({ color } = {}) {
  if (!host || !game?.player) return;
  if (host.isOpen()) {
    showToast(`${host.session.meta.title || 'A game'} is already open. Pack it up first.`);
    return;
  }
  const result = host.start('fetch', {
    seats: [{ character: game.player, controller: 'human', role: 'player' }],
    controllers: ['human'],
    options: {
      targetTile: facingTile(game.player, 3),
      color,
      onAbandonPrompt: (onConfirm, onCancel) => showAbandonPrompt(
        host.getMeta('fetch'),
        game.player,
        onConfirm,
        onCancel
      )
    }
  });
  if (!result.ok) showToast(result.message || 'Could not throw the ball.');
}

function showAbandonPrompt(meta, opponent, onConfirm, onCancel) {
  if (!meta) return;
  const spec = dialogueForMeta(meta, dialogueData);
  const prompt = buildAbandonPrompt({
    meta,
    opponentName: opponent?.name || 'Your friend',
    dialogueSpec: spec
  });
  const choices = prompt.choices.map(choice => ({
    label: choice.label,
    className: choice.className,
    onClick: () => {
      dialogue.close();
      if (choice.action === 'abandon') {
        if (host?.isOpen()) {
          host.close({ reason: 'abandoned', outcome: 'abandoned', record: false, reward: false });
          refreshMiniGameFlags();
        } else {
          onConfirm?.();
        }
      } else {
        onCancel?.();
      }
    }
  }));
  dialogue.openCustomBeat(opponent && opponent.name ? opponent : { name: 'Game' }, prompt.text, choices);
}

function handleGameEnd(payload) {
  const { meta, outcome, settlement, dialogue: beat, session } = payload;
  const opponentSeat = session?.seats?.find(seat => seat.controller !== 'human' && seat.character !== game?.player);
  const opponent = opponentSeat?.character
    || (settlement?.opponentId ? resolveCharacter(settlement.opponentId) : null)
    || { name: settlement?.opponentName || 'Your friend' };

  let text = beat?.text || `${meta?.title || 'Game'} finished.`;
  const notices = Array.isArray(settlement?.notifications) ? settlement.notifications : [];
  if (notices.length) {
    text += `\nRewards: ${notices.join(' · ')}`;
    showToast(`Rewards: ${notices.join(' · ')}`);
  }
  if (outcome === 'win' && game?.player) game.triggerCheer('player');

  const choices = (beat?.choices || []).map(choice => ({
    label: choice.label,
    className: choice.className,
    onClick: () => {
      dialogue.close();
      if (choice.action === 'play_again') {
        if (host?.isOpen()) host.close({ reason: 'play-again', settle: false });
        refreshMiniGameFlags();
        onPlayGame(meta.id, opponentSeat?.character || opponent);
      } else {
        packUpGame(meta.id);
      }
    }
  }));

  dialogue.openCustomBeat(opponent, text, choices);
  panels?.updateDebugUI?.();
}

function makeDraft() {
  const worldSeed = makeSeed();
  const world = generateWorld(worldSeed);
  const playerBuddyId = 'player';
  const playerCompanion = {
    id: makeId('comp'),
    name: randomFrom(COMPANION_NAMES),
    buddyId: playerBuddyId,
    recipe: createCompanionRecipe()
  };

  return {
    worldSeed,
    world,
    playerName: randomFrom(PLAYER_NAMES),
    playerRecipe: createRecipe(),
    playerCompanion,
    playerInventory: createStarterInventory(),
    npcs: [],
    crowdCount: DEFAULT_CROWD,
    crowdInitialized: false
  };
}

function makeNpc() {
  const used = new Set(draft.npcs.map(npc => npc.name));
  const npcId = makeId('npc');
  return {
    id: npcId,
    name: pickName(used),
    recipe: createRecipe(),
    vibe: pickVibe(),
    inventory: createStarterInventory(),
    companion: {
      id: makeId('comp'),
      name: randomFrom(COMPANION_NAMES),
      buddyId: npcId,
      recipe: createCompanionRecipe()
    }
  };
}

function openWizard({ fresh = false } = {}) {
  dismissNpcWatchPrompt();
  if (fresh || !draft) {
    draft = makeDraft();
    ensureGame();
    friends = new Set();
  }

  if (host?.isOpen()) {
    if (npcOwnsSession()) packUpNpcSession('new-park');
    else host.close({ reason: 'new-park', settle: false, record: false, reward: false });
  }
  refreshMiniGameFlags();
  bubbles?.clear();

  if (dialogue?.isOpen()) dialogue.close();
  panels?.closeAllPanels();
  entered = false;
  game.setInteractive(false);
  game.setPreview(draft.world.grid, draft.worldSeed, draft.world.spawn);
  panels?.updateFriendsUI();
  wizard.setDraft(draft);
  wizard.open({ fresh });
}

function openPlayerMenu() {
  if (!game?.player) return;
  const player = game.player;

  const choices = dialogueData.playerMenu.items.map(item => ({
    label: item.label,
    className: item.className,
    onClick: () => {
      dialogue.close();
      if (item.id === 'backpack') panels?.toggleInventoryPanel();
      else if (item.id === 'companions') {
        const playerComp = game.companions?.find(c => c.buddyId === 'player');
        if (playerComp) panels?.showCard(playerComp);
        else showToast('No companions following you right now.');
      } else if (item.id === 'friends') panels?.toggleFriendsPanel();
      else if (item.id === 'stats') panels?.toggleStatsPanel();
      else if (item.id === 'debug') openDebugMenu();
    }
  }));

  dialogue.openCustomBeat(player, dialogueData.playerMenu.title, choices);
}

function openDebugMenu() {
  if (!game?.player) return;
  const player = game.player;

  const choices = dialogueData.debugMenu.items.map(item => ({
    label: item.label,
    className: item.className,
    onClick: () => {
      if (item.id === 'addNeighbour') {
        addNeighbour();
        dialogue.close();
      } else if (item.id === 'newPark') {
        dialogue.close();
        if (!window.confirm('Start a new park? Your current park and neighbours will be replaced.')) return;
        clearSave();
        entered = false;
        openWizard({ fresh: true });
      } else if (item.id === 'back') {
        openPlayerMenu();
      }
    }
  }));

  dialogue.openCustomBeat(player, dialogueData.debugMenu.title, choices);
}

function handleActionKey(character) {
  if (host?.isOpen()) {
    const result = host.handleAction(character);
    if (result?.handled || result?.changed) return;
    const seated = Boolean(character && host.session?.seats?.some(seat => seat.character === character));
    if (seated) return;
  }
  if (dialogue?.isOpen() || (Date.now() - (dialogue?.justClosedAt || 0) < 300)) {
    return;
  }
  if (panels?.isMenuOpen?.()) {
    // Already in menu: trigger focused action
    panels.triggerFocusedAction();
    return;
  }
  if (panels?.isAnyPanelOpen?.()) {
    panels.closeAllPanels();
    return;
  }
  // Open top-right HUD player menu
  panels?.setActiveTab(panels.lastActiveTab || 'backpack');
}

function hostHooks() {
  return {
    onToast: showToast,
    onCheer: (characterId, duration) => game?.triggerCheer(characterId || 'player', duration),
    onGameEnd: handleGameEnd,
    recordGameResult,
    rollReward: (currentGame, rewardKey, outcome) => rollReward(currentGame || game, rewardKey, outcome),
    applyReward: (currentGame, reward) => {
      const notices = applyReward(currentGame || game, reward);
      // A reward can add an active companion. The behavior runtime snapshots
      // its actor list, so rebuild it immediately or the new buddy has no
      // follow behavior until the page is reloaded.
      syncBehaviorWorld({ reset: true });
      panels?.updateDebugUI?.();
      saveNow();
      return notices;
    },
    dialogues: dialogueData,
    onEvent: event => {
      if (event?.type === 'open') refreshMiniGameFlags();
    }
  };
}

function behaviorQuery() {
  return {
    get: id => resolveCharacter(id),
    distance: (a, b) => {
      if (!a || !b) return Infinity;
      return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
    },
    buddy: actor => {
      const buddyId = actor?.buddyId;
      return buddyId != null ? resolveCharacter(buddyId) : null;
    },
    nearestOpen: point => {
      if (!point || !game?.terrain) return point || null;
      return findOpenTile(game.terrain, point) || point;
    }
  };
}

function behaviorDeps() {
  return {
    tryStep: (actor, dx, dy, durationMs) => {
      if (!game?.tryStep) return false;
      // Mini-game participants and staged spectators are parked by the game;
      // behavior decisions must not drag them back onto the board.
      if (actor?.inMiniGame || actor?.stagedDestination) return false;
      // The wander toggle parks neighbours but leaves companions following.
      if (!game.wander && actor && !actor.isCompanion) return false;
      return game.tryStep(actor, dx, dy, msToSeconds(durationMs));
    },
    findPath: (actor, target, blocked) => {
      if (!game?.terrain || !actor || !target) return [];
      return findPath(game.terrain, { x: actor.x, y: actor.y }, target, blocked);
    },
    face: (actor, direction) => {
      if (!actor) return;
      if (typeof game?.face === 'function') game.face(actor, direction);
      else actor.direction = direction;
    },
    startGame: request => npcGameAdapter.start({
      game: request.game,
      actor: request.actor,
      partner: request.partner,
      terrain: game?.terrain || null
    }),
    gameStatus: token => npcGameAdapter.status(token),
    abortGame: token => npcGameAdapter.abort(token)
  };
}

function socialLine({ key }) {
  return dialogueData.social?.[key] || null;
}

function ensureBehaviorRuntime() {
  if (behaviorRuntime || !game) return behaviorRuntime;
  npcGameAdapter = createNpcGameAdapter({ host, onResult: handleNpcGameResult });
  bubbles = bubbles || new SpeechBubbles({ getActor: resolveCharacter });
  const social = createSocialActions({
    bubbles,
    adapter: npcGameAdapter,
    lineFor: socialLine
  });

  behaviorRuntime = new BehaviorRuntime({
    config: behaviorData,
    actors: behaviorActors(),
    player: game.player,
    query: behaviorQuery(),
    deps: behaviorDeps(),
    actions: social
  });

  bridgeBehaviorEvents(behaviorRuntime, bubbles, {
    host,
    onToast: showToast,
    notifyGames: false,
    onGameStart: (detail, session) => promptNpcGameWatch(detail, session)
  });

  game.setBehaviorRuntime?.(behaviorRuntime);
  return behaviorRuntime;
}

function syncBehaviorWorld({ reset = false } = {}) {
  if (!behaviorRuntime || !game) return;
  if (reset) behaviorRuntime.setWorld({ actors: behaviorActors(), player: game.player, now: behaviorRuntime.now });
  else behaviorRuntime.blackboard.sync(behaviorActors(), game.player, behaviorRuntime.now);
}

function isNpcCharacter(character) {
  return Boolean(character && Array.isArray(game?.npcs) && game.npcs.includes(character));
}

function npcNearPlayer(character) {
  const player = game?.player;
  if (!player || !character) return false;
  return Math.abs(player.x - character.x) + Math.abs(player.y - character.y) <= 10;
}

function gameTitle(gameId) {
  return host?.getMeta?.(gameId)?.title || gameId || 'a game';
}

function npcGameNow() {
  return (Number(game?.time) || 0) * 1000;
}

/** Rebuild behavior actors, persist, and refresh any open NPC UI. */
function settleNpcWorld() {
  syncBehaviorWorld({ reset: true });
  saveNow();
  panels?.updateDebugUI?.();
  if (panels?.cardCharacter) panels.showCard?.(panels.cardCharacter);
  panels?.renderCompanion?.();
}

function toastNpcReward(winner, title, notices) {
  const summary = Array.isArray(notices) && notices.length
    ? `: ${notices.join(' · ')}`
    : '.';
  showToast(`${winner.name} won ${title}${summary}`);
}

/**
 * NPC game adapter result hook. Rewards only NPC owners; the player's stats,
 * inventory, dialogue, and cheer are never involved.
 */
function handleNpcGameResult({ winnerId, loserId, game: gameId, outcome, session } = {}) {
  if (!game) return;
  const now = npcGameNow();
  const title = gameTitle(gameId);

  if (outcome === 'draw') {
    const seats = Array.isArray(session?.seats)
      ? session.seats.map(seat => seat?.character).filter(isNpcCharacter)
      : [];
    const participants = seats.filter((npc, index) => seats.indexOf(npc) === index);
    if (!participants.length) return;

    const results = participants.map((npc, index) => awardNpcGame({
      game,
      winner: npc,
      loser: participants[index === 0 ? 1 : 0] || null,
      gameId,
      outcome: 'draw',
      now
    }));
    const awarded = results.filter(result => result.ok);
    if (!awarded.length) return;

    settleNpcWorld();
    const nearby = participants.find(npcNearPlayer);
    if (nearby) {
      const notices = awarded.flatMap(result => result.notices);
      const names = participants.map(npc => npc.name).join(' and ');
      showToast(notices.length
        ? `${names} drew ${title}: ${notices.join(' · ')}`
        : `${names} drew ${title}.`);
    }
    return;
  }

  const winner = resolveCharacter(winnerId);
  if (!isNpcCharacter(winner)) return;
  const loser = resolveCharacter(loserId);

  const result = awardNpcGame({
    game,
    winner,
    loser: isNpcCharacter(loser) ? loser : null,
    gameId,
    // `outcome` is seat-relative in the adapter; the resolved winner always
    // rolls the win table.
    outcome: 'win',
    now
  });
  if (!result.ok) return;

  settleNpcWorld();
  if (npcNearPlayer(winner)) toastNpcReward(winner, title, result.notices);
}

function debugNpcTarget(character) {
  if (!isNpcCharacter(character)) {
    showToast('Pick a neighbour on the map first.');
    return null;
  }
  return character;
}

function randomEffectItemId() {
  const ids = [];
  const seen = new Set();
  for (const effect of Object.values(EFFECT_CATALOG)) {
    const id = effect?.itemId;
    if (typeof id !== 'string' || !id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids.length ? randomFrom(ids) : null;
}

function autoEquipNpcLoadout(npc) {
  const companions = typeof game?.getCompanionsFor === 'function'
    ? game.getCompanionsFor(npc.id)
    : [];
  return autoEquipOwner(npc, companions || [], { now: npcGameNow() });
}

function onGrantNpcEffect(character) {
  const npc = debugNpcTarget(character);
  if (!npc) return;
  const itemId = randomEffectItemId();
  const item = itemId ? createItemInstance(itemId) : null;
  if (!item) {
    showToast('No effect items are available right now.');
    return;
  }

  if (!Array.isArray(npc.inventory)) npc.inventory = [];
  npc.inventory.push(item);
  const loadout = autoEquipNpcLoadout(npc);
  settleNpcWorld();
  const worn = loadout.equipped.length ? ' and equipped it' : '';
  showToast(`Gave ${npc.name} a ${item.name || item.id}${worn}.`);
}

function onGrantNpcBuddy(character) {
  const npc = debugNpcTarget(character);
  if (!npc) return;

  const buddy = {
    name: randomFrom(COMPANION_NAMES),
    recipe: createCompanionRecipe()
  };
  const counts = game.companionCounts?.(npc) || { active: 0, reserve: 0 };
  const underActiveCap = counts.active < COMPANION_CAPS.npcActiveMax;
  const underGlobalCap = (game.companions?.length || 0) < COMPANION_CAPS.globalActiveMax;

  if (underActiveCap && underGlobalCap) {
    game.addActiveCompanion?.(npc, buddy);
    settleNpcWorld();
    showToast(`${npc.name} adopted ${buddy.name}.`);
    return;
  }

  if (counts.reserve >= COMPANION_CAPS.npcReserveMax) {
    showToast(`${npc.name}'s collection is full.`);
    return;
  }

  const reserved = game.reserveCompanion?.(npc, buddy);
  settleNpcWorld();
  showToast(`${npc.name} added ${reserved?.name || buddy.name} to their collection.`);
}

function onSimulateNpcWin(character) {
  const winner = debugNpcTarget(character);
  if (!winner) return;
  const loser = (game?.npcs || []).find(npc => npc !== winner && !npc.inMiniGame);
  if (!loser) {
    showToast('Need another neighbour for a match.');
    return;
  }

  const result = awardNpcGame({
    game,
    winner,
    loser,
    gameId: 'tic-tac-toe',
    outcome: 'win',
    now: npcGameNow()
  });
  if (!result.ok) {
    showToast('That win could not be scored.');
    return;
  }

  settleNpcWorld();
  toastNpcReward(winner, gameTitle('tic-tac-toe'), result.notices);
}

function onAutoEquipNpc(character) {
  const npc = debugNpcTarget(character);
  if (!npc) return;
  const loadout = autoEquipNpcLoadout(npc);
  settleNpcWorld();
  showToast(loadout.equipped.length
    ? `${npc.name} auto-equipped ${loadout.equipped.length} item${loadout.equipped.length === 1 ? '' : 's'}.`
    : `${npc.name} has nothing new to wear.`);
}

function completeContinuousActivity() {
  const session = host?.session;
  if (!session || session.meta?.activity !== 'continuous') return;
  const legacy = session.game?.legacy;
  if (legacy && legacy.activeBall === null) {
    host.close({ reason: 'activity-complete', settle: false, record: false, reward: false });
    refreshMiniGameFlags();
  }
}

function ensureGame() {
  if (!game) {
    dialogue = new DialogueManager({
      onDialogueEnd: onDialogueEnded,
      onFriendshipChange: onFriendshipChanged,
      onPlayGame,
      getGame: () => game
    });

    game = new Game({
      canvas: $('world'),
      minimap: $('minimap'),
      onSelect: character => panels?.showCard(character),
      onToast: showToast,
      onDialogue: openDialogue,
      onActionKey: handleActionKey,
      isMenuOpen: () => Boolean(panels?.isMenuOpen?.())
    });

    bubbles = new SpeechBubbles({ getActor: resolveCharacter });
    host = new MiniGameHost({ game, hooks: hostHooks() });
    registerContractGames(host, miniGamesData.miniGames);

    delegated = {
      host: typeof game.setMiniGameHost === 'function',
      runtime: typeof game.setBehaviorRuntime === 'function'
    };
    game.setMiniGameHost?.(host);
    game.setSpeechBubbles?.(bubbles);
    ensureBehaviorRuntime();

    game.onFrame = () => {
      if (dialogue?.isOpen()) dialogue.updatePosition();

      const now = performance.now();
      const dtMs = lastFrameAt ? Math.max(0, Math.min(now - lastFrameAt, 80)) : 0;
      lastFrameAt = now;

      // Fallbacks keep the app playable if the runtime integration is not present.
      if (!delegated.host) host?.update(dtMs);
      if (!delegated.runtime) behaviorRuntime?.update(dtMs);
      // The renderer draws bubbles; the app shell always advances their timers.
      bubbles?.update(dtMs);

      // Drive ambient NPC games even when the debug trigger started one
      // directly (the behavior runtime also polls via awaitNpcGame).
      npcGameAdapter?.activeToken?.();

      completeContinuousActivity();
      if (host && !host.isOpen()) refreshMiniGameFlags();
    };
  }
  return game;
}

function updateWanderButton() {
  const button = $('wander-toggle');
  if (!button) return;
  const on = Boolean(game?.wander);
  button.setAttribute('aria-pressed', String(on));
  const label = button.querySelector('.label');
  if (label) label.textContent = on ? 'Wander on' : 'Wander paused';
}

function updateMeta() {
  // Brand header removed from HUD
}

function makeLiveNpc() {
  const used = new Set(game.npcs.map(npc => npc.name));
  const npcId = makeId('npc');
  return {
    id: npcId,
    name: pickName(used),
    recipe: createRecipe(),
    vibe: pickVibe(),
    inventory: createStarterInventory(),
    companion: {
      id: makeId('comp'),
      name: randomFrom(COMPANION_NAMES),
      buddyId: npcId,
      recipe: createCompanionRecipe()
    }
  };
}

function scatterNpcs(terrain, component, spawn, count) {
  const walkableCells = (component && component.length ? component : [])
    .filter(cell => isWalkable(terrain[cell.y]?.[cell.x]) && !(cell.x === spawn.x && cell.y === spawn.y));

  if (walkableCells.length < count * 2) {
    walkableCells.length = 0;
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        if (isWalkable(terrain[y]?.[x]) && !(x === spawn.x && y === spawn.y)) {
          walkableCells.push({ x, y });
        }
      }
    }
  }

  for (let i = walkableCells.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [walkableCells[i], walkableCells[j]] = [walkableCells[j], walkableCells[i]];
  }

  const chosen = [];
  const distanceFromSpawn = cell => Math.abs(cell.x - spawn.x) + Math.abs(cell.y - spawn.y);

  const near = walkableCells.filter(cell => distanceFromSpawn(cell) >= 3 && distanceFromSpawn(cell) <= 12);
  const mid = walkableCells.filter(cell => distanceFromSpawn(cell) > 12 && distanceFromSpawn(cell) <= 25);
  const far = walkableCells.filter(cell => distanceFromSpawn(cell) > 25);

  const pool = [];
  const maxLen = Math.max(near.length, mid.length, far.length);
  for (let i = 0; i < maxLen; i++) {
    if (far[i]) pool.push(far[i]);
    if (mid[i]) pool.push(mid[i]);
    if (near[i]) pool.push(near[i]);
  }
  pool.push(...walkableCells);

  for (const cell of pool) {
    if (chosen.length >= count) break;
    if (isWalkable(terrain[cell.y]?.[cell.x]) &&
        chosen.every(other => Math.abs(other.x - cell.x) + Math.abs(other.y - cell.y) >= 3)) {
      chosen.push(cell);
    }
  }

  for (const cell of pool) {
    if (chosen.length >= count) break;
    if (isWalkable(terrain[cell.y]?.[cell.x]) &&
        chosen.every(other => Math.abs(other.x - cell.x) + Math.abs(other.y - cell.y) >= 2)) {
      chosen.push(cell);
    }
  }

  for (const cell of pool) {
    if (chosen.length >= count) break;
    if (isWalkable(terrain[cell.y]?.[cell.x]) &&
        !chosen.some(other => other.x === cell.x && other.y === cell.y)) {
      chosen.push(cell);
    }
  }

  return chosen;
}

function buildLiveNpcs() {
  const spots = scatterNpcs(draft.world.grid, draft.world.component, draft.world.spawn, draft.npcs.length);
  const occupied = new Set([`${draft.world.spawn.x},${draft.world.spawn.y}`]);

  return draft.npcs.map((npc, index) => {
    let spot = spots[index];

    if (!spot || !isWalkable(draft.world.grid[spot.y]?.[spot.x]) || occupied.has(`${spot.x},${spot.y}`)) {
      spot = findOpenTile(draft.world.grid, draft.world.spawn, occupied, 4);
    }
    occupied.add(`${spot.x},${spot.y}`);

    return {
      id: npc.id,
      name: npc.name,
      recipe: npc.recipe,
      vibe: npc.vibe,
      inventory: npc.inventory || createStarterInventory(),
      companion: npc.companion,
      x: spot.x,
      y: spot.y
    };
  });
}

async function enterPark() {
  const button = $('enter-park');
  button.disabled = true;
  button.textContent = 'Opening the gate…';

  const npcs = buildLiveNpcs();
  const companions = [];

  if (draft.playerCompanion) {
    companions.push({
      ...draft.playerCompanion,
      x: draft.world.spawn.x,
      y: draft.world.spawn.y
    });
  }

  for (const npc of npcs) {
    if (npc.companion) {
      companions.push({
        ...npc.companion,
        x: npc.x,
        y: npc.y
      });
    }
  }

  await preloadAvatars([
    draft.playerRecipe,
    draft.playerCompanion?.recipe,
    ...npcs.map(npc => npc.recipe),
    ...companions.map(c => c.recipe)
  ]);

  const playerName = draft.playerName.trim() || 'You';
  const state = {
    version: 1,
    worldSeed: draft.worldSeed,
    terrain: encodeTerrain(draft.world.grid),
    playerName,
    playerRecipe: draft.playerRecipe,
    player: {
      x: draft.world.spawn.x,
      y: draft.world.spawn.y,
      inventory: draft.playerInventory || createStarterInventory(),
      equipped: []
    },
    npcs,
    companions,
    friends: [],
    wander: true
  };

  applyState(state);
  panels?.closeCard();
  wizard.close();
  game.setInteractive(true);
  game.start();
  updateWanderButton();
  updateMeta();
  saveNow();
  showToast(`Welcome to the park, ${playerName}. Check your Bag for toys!`);
  button.disabled = false;
  button.textContent = 'Enter the park';
}

function applyBehaviorState(state) {
  if (!behaviorRuntime) return;
  const saved = state?.behavior ?? state?.behaviors ?? state?.behaviorState ?? null;
  if (!saved || typeof saved !== 'object') return;

  const relations = saved.relations || saved.blackboard || null;
  if (relations && typeof behaviorRuntime.blackboard?.loadRelations === 'function') {
    behaviorRuntime.blackboard.loadRelations(relations);
  }

  const cooldowns = saved.cooldowns || saved.cooldownStore || null;
  if (cooldowns) {
    const now = behaviorRuntime.now || 0;
    const savedNow = Number(saved.counters?.savedAtMs);
    const entries = Array.isArray(cooldowns)
      ? cooldowns
      : (Array.isArray(cooldowns.entries) ? cooldowns.entries : []);
    // Cooldowns are stored on the runtime clock; rebase them onto this session.
    const rebased = Number.isFinite(savedNow)
      ? entries.map(entry => ({
        ...entry,
        readyAt: now + Math.max(0, (Number(entry.readyAt) || 0) - savedNow)
      }))
      : entries;
    behaviorRuntime.cooldowns = CooldownStore.deserialize({ entries: rebased }, { now });
    behaviorRuntime.cooldowns.now = now;
  }
}

function applyState(state) {
  // A reload never resumes a live board or bubbles.
  if (host?.isOpen()) {
    if (npcOwnsSession()) packUpNpcSession('load');
    else host.close({ reason: 'load', settle: false, record: false, reward: false });
  }
  refreshMiniGameFlags();
  bubbles?.clear();

  const worldData = generateWorld(state.worldSeed);
  const terrain = decodeTerrain(state.terrain) || worldData.grid;
  const scenery = worldData.scenery || [];
  const rawPlayer = {
    id: 'player',
    name: state.playerName || 'You',
    recipe: state.playerRecipe,
    x: Number.isFinite(Number(state.player?.x)) ? Math.round(Number(state.player.x)) : 32,
    y: Number.isFinite(Number(state.player?.y)) ? Math.round(Number(state.player.y)) : 32,
    direction: state.player?.direction ?? 0,
    inventory: normalizeInventory(state.player?.inventory || createStarterInventory()),
    equipped: Array.isArray(state.player?.equipped) ? state.player.equipped : [],
    effectGhosts: Array.isArray(state.player?.effectGhosts) ? state.player.effectGhosts : [],
    coins: Number.isFinite(state.player?.coins) ? state.player.coins : 0,
    stabledCompanions: Array.isArray(state.player?.stabledCompanions) ? state.player.stabledCompanions : []
  };
  if (!isWalkable(terrain[rawPlayer.y]?.[rawPlayer.x])) {
    const spot = findOpenTile(terrain, { x: 32, y: 32 });
    rawPlayer.x = spot.x;
    rawPlayer.y = spot.y;
  }

  const npcs = (Array.isArray(state.npcs) ? state.npcs : [])
    .filter(npc => npc && npc.recipe && npc.name)
    .map(npc => {
      const hasPosition = Number.isFinite(Number(npc.x)) && Number.isFinite(Number(npc.y));
      const entry = {
        id: npc.id || makeId('npc'),
        name: npc.name,
        recipe: npc.recipe,
        vibe: npc.vibe || '',
        inventory: normalizeInventory(npc.inventory || createStarterInventory()),
        equipped: Array.isArray(npc.equipped) ? npc.equipped : [],
        effectGhosts: Array.isArray(npc.effectGhosts) ? npc.effectGhosts : [],
        x: hasPosition ? Math.round(Number(npc.x)) : -1,
        y: hasPosition ? Math.round(Number(npc.y)) : -1,
        direction: Number(npc.direction) || 0,
        coins: Number.isFinite(npc.coins) ? npc.coins : 0,
        stabledCompanions: Array.isArray(npc.stabledCompanions) ? npc.stabledCompanions : []
      };
      if (!isWalkable(terrain[entry.y]?.[entry.x])) {
        const spot = findOpenTile(terrain, { x: rawPlayer.x, y: rawPlayer.y });
        entry.x = spot.x;
        entry.y = spot.y;
      }
      return entry;
    });

  const occupiedPositions = new Set([`${rawPlayer.x},${rawPlayer.y}`]);
  for (const npc of npcs) {
    let key = `${npc.x},${npc.y}`;
    if (occupiedPositions.has(key)) {
      const spot = findOpenTile(terrain, { x: rawPlayer.x, y: rawPlayer.y }, occupiedPositions, 1);
      npc.x = spot.x;
      npc.y = spot.y;
      key = `${npc.x},${npc.y}`;
    }
    occupiedPositions.add(key);
  }

  let companions = Array.isArray(state.companions) ? state.companions : [];
  if (!companions.length) {
    companions.push({
      id: makeId('comp'),
      name: randomFrom(COMPANION_NAMES),
      buddyId: 'player',
      recipe: createCompanionRecipe(),
      x: rawPlayer.x,
      y: rawPlayer.y,
      direction: 0
    });
    for (const npc of npcs) {
      companions.push({
        id: makeId('comp'),
        name: randomFrom(COMPANION_NAMES),
        buddyId: npc.id,
        recipe: createCompanionRecipe(),
        x: npc.x,
        y: npc.y,
        direction: 0
      });
    }
  }

  ensureGame();
  game.setWorld({
    terrain,
    worldSeed: state.worldSeed,
    player: rawPlayer,
    npcs,
    companions,
    scenery,
    wander: state.wander !== false
  });
  syncBehaviorWorld({ reset: true });
  applyBehaviorState(state);
  behaviorRuntime?.setDialogue(false);
  friends = new Set(
    (Array.isArray(state.friends) ? state.friends : [])
      .filter(id => npcs.some(npc => npc.id === id))
  );
  draft = {
    worldSeed: state.worldSeed,
    world: { grid: terrain, spawn: { x: rawPlayer.x, y: rawPlayer.y }, component: [] },
    playerName: rawPlayer.name,
    playerRecipe: rawPlayer.recipe,
    playerInventory: rawPlayer.inventory,
    npcs,
    crowdCount: npcs.length,
    crowdInitialized: true
  };
  wizard.setDraft(draft);
  entered = true;
  updateWanderButton();
  panels?.updateFriendsUI();
  updateMeta();
}

function behaviorSaveState() {
  if (!behaviorRuntime) return null;
  return {
    relations: behaviorRuntime.blackboard?.serializeRelations?.() || null,
    cooldowns: behaviorRuntime.cooldowns?.serialize?.(behaviorRuntime.now) || null,
    counters: { savedAtMs: behaviorRuntime.now || 0 }
  };
}

function saveNow() {
  if (!entered) return;
  const state = serializeSave(game, draft, friends, behaviorSaveState());
  saveState(state);
}

function grantAllEffects() {
  const player = game?.player;
  if (!player) return;
  if (!Array.isArray(player.inventory)) player.inventory = [];
  const owned = new Set(player.inventory.map(item => item?.id).filter(Boolean));
  let added = 0;

  for (const effect of Object.values(EFFECT_CATALOG)) {
    const itemId = effect?.itemId;
    if (!itemId || owned.has(itemId)) continue;
    const item = createItemInstance(itemId);
    if (!item) continue;
    player.inventory.push(item);
    owned.add(itemId);
    added += 1;
  }

  if (added) {
    panels?.renderInventory?.();
    saveNow();
    showToast(`${added} effect item${added === 1 ? '' : 's'} added to your bag.`);
  } else {
    showToast('You already own every effect item.');
  }
}

function triggerNpcGame() {
  const npcs = (game?.npcs || []).filter(npc => !npc.inMiniGame);
  if (npcs.length < 2) {
    showToast('Need two neighbours for an NPC game.');
    return;
  }
  if (host?.isOpen()) {
    showToast(`${host.session.meta.title || 'A game'} is already open. Pack it up first.`);
    return;
  }

  // Pick the closest pair so the spectators do not spend half a minute walking.
  let pair = [npcs[0], npcs[1]];
  let bestDistance = Infinity;
  for (let i = 0; i < npcs.length; i++) {
    for (let j = i + 1; j < npcs.length; j++) {
      const distance = Math.abs(npcs[i].x - npcs[j].x) + Math.abs(npcs[i].y - npcs[j].y);
      if (distance < bestDistance) {
        bestDistance = distance;
        pair = [npcs[i], npcs[j]];
      }
    }
  }

  const result = npcGameAdapter.start({
    game: 'tic-tac-toe',
    actor: pair[0],
    partner: pair[1],
    terrain: game.terrain || null
  });
  if (!result.ok) {
    showToast(result.message || 'The neighbours could not start a game.');
    return;
  }
  refreshMiniGameFlags();
  panels?.updateDebugUI?.();
  showToast(`${pair[0].name} and ${pair[1].name} started Tic-Tac-Toe.`);
  promptNpcGameWatch({
    actorId: pair[0].id,
    partnerId: pair[1].id,
    game: 'tic-tac-toe'
  }, host?.session || null);
}

function dismissNpcWatchPrompt() {
  if (!npcWatchPrompt) return;
  if (npcWatchPrompt.timer) clearInterval(npcWatchPrompt.timer);
  npcWatchPrompt = null;
}

function isNpcOnlySession(session) {
  if (!session || !Array.isArray(session.seats) || !session.seats.length) return false;
  return session.seats.every(seat => seat?.character && seat.character !== game?.player);
}

function walkPlayerToSpectate(session) {
  const player = game?.player;
  if (!player || !game?.terrain || !session) return;
  const board = session.game?.legacy?.activeBoard || null;
  const metaBoard = session.meta?.board || {};
  const originX = session.placement?.originX ?? board?.originX;
  const originY = session.placement?.originY ?? board?.originY;
  if (!Number.isFinite(originX) || !Number.isFinite(originY)) return;
  const height = metaBoard.height || 3;
  const width = metaBoard.width || 3;
  const occupied = new Set();
  for (const actor of [...(game.npcs || []), ...(game.companions || [])]) {
    if (actor) occupied.add(`${actor.x},${actor.y}`);
  }
  for (let y = originY; y < originY + height; y++) {
    for (let x = originX; x < originX + width; x++) {
      occupied.add(`${x},${y}`);
    }
  }
  const candidate = { x: originX - 1, y: originY + height + 1 };
  const spot = findOpenTile(game.terrain, candidate, occupied, 1);
  if (!spot) return;
  const path = findPath(game.terrain, { x: player.x, y: player.y }, spot);
  if (path.length) {
    player.path = path;
    game.destination = { x: spot.x, y: spot.y, until: game.time + 6 };
  } else {
    showToast('Could not find a clear spot to watch from.');
  }
}

function promptNpcGameWatch(detail = {}, session = null) {
  if (!detail || detail.ok === false) return;
  const activeSession = session || host?.session || null;
  if (!isNpcOnlySession(activeSession)) return;
  if (dialogue?.isOpen() || npcWatchPrompt) return;

  panels?.closeMenu?.();
  const actor = resolveCharacter(detail.actorId) || activeSession.seats[0]?.character || null;
  const partner = resolveCharacter(detail.partnerId) || activeSession.seats[1]?.character || null;
  const gameId = detail.game || activeSession.meta?.id || 'tic-tac-toe';
  const gameName = host?.getMeta?.(gameId)?.title
    || miniGamesData.miniGames?.[gameId]?.title
    || 'a mini-game';
  const social = dialogueData.social || {};
  const template = social.npcGamePrompt
    || '{a} and {b} are about to play a game of {game}. Want to watch?';
  const baseText = template
    .replaceAll('{a}', actor?.name || 'A neighbour')
    .replaceAll('{b}', partner?.name || 'another neighbour')
    .replaceAll('{game}', gameName);

  const prompt = { token: {}, timer: null };
  npcWatchPrompt = prompt;
  let remaining = 5;
  const textFor = seconds => `${baseText} (${seconds})`;

  const dismiss = () => {
    if (npcWatchPrompt?.token !== prompt.token) return false;
    dismissNpcWatchPrompt();
    return true;
  };

  const choices = [
    {
      label: social.npcGameWatch || 'Watch',
      className: 'primary',
      onClick: () => {
        if (!dismiss()) return;
        dialogue.close();
        walkPlayerToSpectate(activeSession);
      }
    },
    {
      label: social.npcGameDecline || 'Maybe later',
      className: 'pill quiet',
      onClick: () => {
        if (!dismiss()) return;
        dialogue.close();
      }
    }
  ];

  dialogue.openCustomBeat(
    game?.player || { name: 'Park' },
    textFor(remaining),
    choices
  );

  prompt.timer = setInterval(() => {
    if (npcWatchPrompt?.token !== prompt.token) return;
    if (!dialogue?.isOpen()) {
      dismissNpcWatchPrompt();
      return;
    }
    remaining -= 1;
    if (remaining <= 0) {
      dismissNpcWatchPrompt();
      dialogue.close();
      return;
    }
    dialogue.setText?.(textFor(remaining));
  }, 1000);
}

function addNeighbour() {
  if (!game.player) return;
  if (game.npcs.length >= MAX_NPCS) {
    showToast('The park is full. Forty neighbours is plenty.');
    return;
  }
  const npc = makeLiveNpc();
  preloadAvatars([npc.recipe, npc.companion?.recipe]);
  game.addNpc(npc, npc.companion);
  syncBehaviorWorld();
  panels?.updateFriendsUI();
  saveNow();
  showToast(`${npc.name} and their buddy ${npc.companion.name} moved in.`);
}

function toggleWander() {
  if (!game) return;
  game.setWander(!game.wander);
  updateWanderButton();
  saveNow();
  showToast(game.wander ? 'Neighbours are wandering.' : 'Neighbours are staying put.');
}

function rerollCardCharacter() {
  const cardCharacter = panels?.cardCharacter;
  if (!cardCharacter || cardCharacter.isPlayer || cardCharacter.isCompanion) return;
  const recipe = createRecipe();
  cardCharacter.recipe = recipe;
  cardCharacter.vibe = pickVibe();
  game.updateNpcRecipe(cardCharacter.id, recipe);
  bindAnimatedAvatar($('npc-avatar'), recipe, 0);
  $('npc-vibe').textContent = cardCharacter.vibe;
  saveNow();
  showToast(`New look for ${cardCharacter.name}.`);
}

function removeCardCharacter() {
  const cardCharacter = panels?.cardCharacter;
  if (!cardCharacter || cardCharacter.isPlayer || cardCharacter.isCompanion) return;
  const name = cardCharacter.name;
  if (host?.isOpen() && host.session?.participantIds?.has(cardCharacter.id)) {
    packUpGame();
  }
  friends.delete(cardCharacter.id);
  game.removeNpc(cardCharacter.id);
  syncBehaviorWorld();
  panels?.closeCard();
  panels?.updateFriendsUI();
  saveNow();
  showToast(`${name} left the park.`);
}

function bindEvents() {
  $('wander-toggle')?.addEventListener('click', toggleWander);
  $('add-npc')?.addEventListener('click', addNeighbour);
  $('new-park')?.addEventListener('click', () => {
    if (!window.confirm('Start a new park? Your current park and neighbours will be replaced.')) return;
    clearSave();
    entered = false;
    openWizard({ fresh: true });
  });

  $('npc-shuffle').addEventListener('click', rerollCardCharacter);
  $('npc-remove').addEventListener('click', removeCardCharacter);

  // Mobile / touch screen virtual d-pad & action buttons
  const simulateKey = (key, type = 'keydown') => {
    const event = new KeyboardEvent(type, {
      key,
      code: key === 'Enter' ? 'Enter' : (key === 'Escape' ? 'Escape' : (key === 'ArrowUp' ? 'ArrowUp' : (key === 'ArrowDown' ? 'ArrowDown' : (key === 'ArrowLeft' ? 'ArrowLeft' : 'ArrowRight')))),
      bubbles: true,
      cancelable: true
    });
    window.dispatchEvent(event);
  };

  const bindTouchButton = (id, key) => {
    const btn = $(id);
    if (!btn) return;
    let isDown = false;
    let repeatTimer = null;

    const start = e => {
      e.preventDefault();
      if (isDown) return;
      isDown = true;
      simulateKey(key, 'keydown');
      // For movement keys, auto-repeat while held
      if (key.startsWith('Arrow')) {
        repeatTimer = window.setInterval(() => {
          if (isDown) simulateKey(key, 'keydown');
        }, 180);
      }
    };

    const stop = e => {
      if (!isDown) return;
      e.preventDefault();
      isDown = false;
      if (repeatTimer) {
        window.clearInterval(repeatTimer);
        repeatTimer = null;
      }
      simulateKey(key, 'keyup');
    };

    btn.addEventListener('pointerdown', start);
    btn.addEventListener('pointerup', stop);
    btn.addEventListener('pointercancel', stop);
    btn.addEventListener('contextmenu', e => e.preventDefault());
  };

  bindTouchButton('touch-up', 'ArrowUp');
  bindTouchButton('touch-down', 'ArrowDown');
  bindTouchButton('touch-left', 'ArrowLeft');
  bindTouchButton('touch-right', 'ArrowRight');
  bindTouchButton('touch-enter', 'Enter');
  bindTouchButton('touch-esc', 'Escape');

  window.addEventListener('keydown', event => {
    if (dialogue?.isOpen()) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        event.stopPropagation();
        dialogue.triggerFocusedChoice();
        return;
      }
    }

    if (event.key !== 'Escape') return;
    if (dialogue?.isOpen()) {
      dialogue.close();
      return;
    }
    panels?.closeMenu();
  });

  window.addEventListener('pagehide', saveNow);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveNow();
  });

  window.setInterval(saveNow, 8000);
}

function boot() {
  ensureGame();

  panels = new PanelsUI({
    getGame: () => game,
    getFriends: () => friends,
    onThrowBall,
    onPlayGame,
    onPackUpGame: gameId => packUpGame(gameId),
    isGameOpen: gameId => Boolean(host?.isOpen() && host.activeGameId === gameId),
    getGameMetas: () => (host ? [...host.registry.values()].map(entry => entry.meta) : []),
    getHostState: () => host?.getState?.() || null,
    getBehaviorSummary: () => behaviorRuntime?.snapshot?.() || null,
    onGrantEffects: grantAllEffects,
    onGrantNpcEffect,
    onGrantNpcBuddy,
    onSimulateNpcWin,
    onAutoEquipNpc,
    onTriggerNpcGame: triggerNpcGame,
    onRosterChanged: () => syncBehaviorWorld({ reset: true }),
    onToast: showToast,
    onSave: saveNow,
    onSelect: character => panels?.showCard(character),
    onAddNeighbour: addNeighbour,
    onNewPark: () => {
      if (!window.confirm('Start a new park? Your current park and neighbours will be replaced.')) return;
      panels?.closeMenu();
      if (host?.isOpen()) packUpGame();
      bubbles?.clear();
      clearSave();
      entered = false;
      openWizard({ fresh: true });
    },
    onToggleWander: toggleWander
  });

  wizard = new SetupWizard({
    onEnterPark: enterPark,
    onDraftChange: (action, count) => {
      if (action === 'to-crowd') {
        if (!draft.crowdInitialized) wizard.resizeCrowd(draft.crowdCount || DEFAULT_CROWD, makeNpc);
        else wizard.renderCrowd();
      } else if (action === 'resize-crowd') {
        wizard.resizeCrowd(count, makeNpc);
      }
    },
    makeSeed
  });

  bindEvents();

  const saved = loadSave();
  if (saved) {
    applyState(saved);
    panels.closeCard();
    wizard.close();
    game.start();
    game.setInteractive(true);
    updateWanderButton();
    updateMeta();
    showToast('Welcome back to the park.');
  } else {
    draft = makeDraft();
    wizard.setDraft(draft);
    openWizard();
    game.start();
    updateMeta();
  }
}

boot();

window.playPark = {
  get game() { return game; },
  get draft() { return draft; },
  get dialogue() { return dialogue; },
  get host() { return host; },
  get miniGameHost() { return host; },
  get hostState() { return host?.getState?.() || null; },
  get bubbles() { return bubbles; },
  get behaviorRuntime() { return behaviorRuntime; },
  get npcGameAdapter() { return npcGameAdapter; },
  get fetchGame() { return host?.activeGameId === 'fetch' ? host.session?.game?.legacy || null : null; },
  get tttGame() { return host?.activeGameId === 'tic-tac-toe' ? host.session?.game?.legacy || null : null; },
  get checkersGame() { return host?.activeGameId === 'checkers' ? host.session?.game?.legacy || null : null; },
  get chessGame() { return host?.activeGameId === 'chess' ? host.session?.game?.legacy || null : null; },
  getDebugState() {
    return {
      host: host?.getState?.() || null,
      behavior: behaviorRuntime?.snapshot?.() || null,
      bubbles: bubbles?.snapshot?.() || null
    };
  }
};
