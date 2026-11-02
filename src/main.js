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
import { castVoice } from './voice/casting.js';
import { VoiceEngine } from './voice/engine.js';
import { DialogueManager } from './dialogue.js';
import { createItemInstance, createStarterInventory, normalizeInventory } from './inventory.js';
import { SetupWizard } from './ui/wizard.js';
import { PanelsUI } from './ui/panels.js';
import { MiniGameHost } from './minigames/host.js';
import { formatGameStrip, turnNameFor } from './minigames/strip.js';
import { registerContractGames } from './games/contract-adapters.js';
import { buildAbandonPrompt, dialogueForMeta } from './minigames/settlement.js';
import { SpeechBubbles } from './ui/speech.js';
import { BehaviorRuntime } from './behavior/runtime.js';
import { CooldownStore } from './behavior/cooldowns.js';
import {
  bridgeBehaviorEvents,
  createChatGate,
  createNpcGameAdapter,
  createSocialActions,
  pickNonPlayerSeat
} from './behavior/actions/social.js';
import { EFFECT_CATALOG } from './effects.js';
import engineConfig from '../data/engine_config.json' with { type: 'json' };
import dialogueData from '../data/dialogues.json' with { type: 'json' };
import behaviorData from '../data/behaviors.json' with { type: 'json' };
import miniGamesData from '../data/minigames.json' with { type: 'json' };
import { rollReward, applyReward } from './rewards.js';
import { awardNpcGame } from './npc/game-rewards.js';
import { autoEquipOwner } from './npc/loadout.js';
import {
  basketSummary,
  collectForageAt,
  createForageState,
  growForage,
  seedApples
} from './forage.js';
import { SoundBoard } from './audio.js';

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
const sounds = new SoundBoard();
let voice = null;
/** Most recent character that produced a speak attempt, for the Debug readout. */
let lastVoiceSpeaker = null;
let audioUnlocked = false;
const prefetchedVoices = new Set();
/** Sessions whose settlement line has already spoken (one line per result). */
const spokenSettlements = new WeakSet();
/** Sessions whose abandon prompt has already spoken (one line per session). */
const spokenAbandonSessions = new WeakSet();
/** Last bubble `seq` spoken per actor, so a re-show cannot replay the line. */
const spokenChatSeqs = new Map();
let chatGate = null;
/** Debounce for persisting the voice volume while the slider is dragged. */
let voiceVolumeTimer = 0;
/** Original `#hint` copy, restored when no board is open. */
let hintDefault = '';
/** Last rejected action shown in the strip until the next accept or turn. */
let stripReject = null;
/** Cache key for the target ring so chess/checkers do not regenerate moves per frame. */
let stripTargetKey = '';
/** Brief "abandoned" line after a board closes, since abandon has no end beat. */
let stripFlash = null;

/** Voice engine is built on the first gesture, never at module load. */
function ensureVoice() {
  if (!voice) voice = new VoiceEngine();
  return voice;
}

/** Friends hear the warmer greeting; strangers hear the hello. */
function greetingEventFor(npc) {
  return friends.has(npc?.id) ? 'dialogue.friend' : 'dialogue.stranger';
}

/**
 * Warm one event for one neighbour so the eventual `speak()` is a cache hit.
 * Prefetch is one event per call: the engine rotates phrases by list index, so
 * batching would warm a different phrase than `speak()` asks for.
 */
function prefetchVoiceBeat(npc, event) {
  if (!voice?.enabled || !audioUnlocked || !npc || !event) return;
  voice.prefetch(npc, [event]).catch(() => {});
}

/**
 * Beat hook from `DialogueManager`. Speech renders and plays off the critical
 * path; a muted, missing, or failed voice never delays the dialogue.
 */
function onDialogueBeat(npc, event) {
  if (!npc || !event) return;
  speakVoiceLine(npc, event);
  // A friend's menu is the only place the invite cue can be chosen from.
  if (event === 'dialogue.friend') prefetchVoiceBeat(npc, 'minigame.invite');
  if (event !== 'dialogue.stranger') return;
  prefetchVoiceBeat(npc, 'dialogue.accepted');
  prefetchVoiceBeat(npc, 'dialogue.declined');
}

/** Warm the greeting of any neighbour the player is walking up to. */
function prefetchNearbyGreetings() {
  const player = game?.player;
  if (!player || !voice?.enabled || !audioUnlocked || dialogue?.isOpen()) return;
  const radius = Number(voice.policy?.prefetchRadiusTiles) || 3;
  for (const npc of game.npcs || []) {
    if (!npc?.voice || prefetchedVoices.has(npc.id)) continue;
    const distance = Math.abs(player.x - npc.x) + Math.abs(player.y - npc.y);
    if (distance > radius) continue;
    prefetchedVoices.add(npc.id);
    prefetchVoiceBeat(npc, greetingEventFor(npc));
  }
}

/**
 * The single awaited speak path. Only a resolved `true` counts as a played
 * line, which is what earns the first-use cue; a mute, a prefetch, or a
 * failure never does. The sync return keeps the old "attempted" contract that
 * the settlement and abandon callers rely on.
 */
function speakVoiceLine(character, event) {
  if (!character?.voice || !event) return false;
  const engine = ensureVoice();
  lastVoiceSpeaker = { name: character.name || '', voice: character.voice };
  engine.speak(character, event)
    .then(played => {
      if (played) noteVoiceHint();
      refreshDebugIfOpen();
    })
    .catch(() => refreshDebugIfOpen());
  return engine.enabled;
}

/** Debug rows read live engine state, so refresh them only while visible. */
function refreshDebugIfOpen() {
  if ($('debug-panel') && !$('debug-panel').hidden) panels?.updateDebugUI?.();
}

/** Show the one-time language cue the first time a line actually plays. */
function noteVoiceHint() {
  const engine = ensureVoice();
  if (engine.hintShown) return;
  engine.setHintShown(true);
  showVoiceHint();
}

/** Fill the cue from `data/voice.json` and reveal it under the speaker pills. */
function showVoiceHint() {
  const callout = $('voice-hint');
  if (!callout) return;
  const hint = voice?.policy?.hint || {};
  const text = $('voice-hint-text');
  callout.hidden = false;
  if (text) text.textContent = hint.text || 'Neighbours speak their own language.';
  const dismiss = $('voice-hint-dismiss');
  if (dismiss) dismiss.setAttribute('aria-label', hint.dismiss || 'Dismiss voice hint');
}

/** Hide the cue and hand focus back to the speaker button when it was inside. */
function hideVoiceHint() {
  const callout = $('voice-hint');
  if (!callout) return;
  const returned = callout.contains(document.activeElement);
  callout.hidden = true;
  if (returned) $('voice-toggle')?.focus({ preventScroll: true });
}

/** Ambient chat limiter, built from the voice policy on first use. */
function ensureChatGate() {
  if (!chatGate) {
    chatGate = createChatGate({
      cooldownMs: Number(voice?.policy?.chatCooldownMs) || 8000,
      globalCooldownMs: Number(voice?.policy?.chatGlobalCooldownMs) || 5000
    });
  }
  return chatGate;
}

/**
 * Ambient `social.chat`: speak the bubble just shown, once per actor + bubble
 * seq, inside the chat radius, and within the per-actor and global cooldowns.
 * Chat addressed to the player skips the radius but keeps the rate limits.
 */
function onAmbientSay({ actorId, bubble, detail } = {}) {
  const actor = resolveCharacter(actorId);
  if (!actor?.voice || !voice?.enabled || !audioUnlocked) return false;

  const seq = Number(bubble?.seq);
  if (Number.isFinite(seq)) {
    const seen = spokenChatSeqs.get(String(actorId));
    if (seen === seq) return false;
    spokenChatSeqs.set(String(actorId), seq);
  }

  const player = game?.player || null;
  const targetId = detail?.targetId ?? detail?.target?.id ?? null;
  const addressedToPlayer = Boolean(player && targetId != null && targetId === player.id);
  if (!addressedToPlayer) {
    const radius = Number(voice.policy?.chatRadiusTiles) || 6;
    if (!player) return false;
    const distance = Math.abs(Number(actor.x) - Number(player.x))
      + Math.abs(Number(actor.y) - Number(player.y));
    if (!Number.isFinite(distance) || distance > radius) return false;
  }

  if (!ensureChatGate().allow(actorId, npcGameNow())) return false;
  speakVoiceLine(actor, 'bubble.chat');
  return true;
}

/**
 * Win, loss, and draw speak once per settled session. Draw already resolves to
 * the non-player seat, so the same speaker rule covers all three; an NPC-only
 * board has no speaker and stays silent.
 */
function speakSettlementResult(speaker, outcome, session) {
  const event = outcome === 'win'
    ? 'minigame.win'
    : outcome === 'loss'
      ? 'minigame.loss'
      : outcome === 'draw'
        ? 'minigame.draw'
        : null;
  if (!event || !speaker?.voice) return false;
  if (session && typeof session === 'object') {
    if (spokenSettlements.has(session)) return false;
    spokenSettlements.add(session);
  }
  return speakVoiceLine(speaker, event);
}

/**
 * The abandon prompt speaks once per session, and only when the opponent
 * record has a voice — fetch's opponent is the player, so it stays silent.
 */
function speakAbandonPrompt(opponent) {
  if (!opponent?.voice) return false;
  const session = host?.session || null;
  if (!session || typeof session !== 'object') return false;
  if (spokenAbandonSessions.has(session)) return false;
  spokenAbandonSessions.add(session);
  return speakVoiceLine(opponent, 'minigame.abandon');
}

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

/** Coarse pointers use the on-screen X button instead of a keyboard. */
function usesTouchControls() {
  return Boolean(window.matchMedia?.('(pointer: coarse)')?.matches);
}

/**
 * Persistent board strip. Reuses `#hint` while a board session is active and
 * restores the original hint afterwards. Runs every frame; DOM writes only
 * when the composed line changes.
 */
function refreshGameStrip() {
  const hint = $('hint');
  if (!hint) return;
  const state = host?.getState?.() || null;
  const boardOpen = Boolean(state?.active && state.kind !== 'activity');

  if (!boardOpen) {
    stripReject = null;
    stripTargetKey = '';
    if (host?.targetHints?.length) host.setTargetTiles?.([]);
    if (stripFlash && Date.now() < stripFlash.until) {
      hint.classList.add('game-strip');
      if (hint.textContent !== stripFlash.text) hint.textContent = stripFlash.text;
      return;
    }
    stripFlash = null;
    hint.classList.remove('game-strip');
    if (hintDefault && hint.textContent !== hintDefault) hint.textContent = hintDefault;
    return;
  }

  stripFlash = null;
  const copy = miniGamesData.strip || {};
  // A rejection is only meaningful for the turn it happened on. Legacy boards
  // emit no turn event, so the poll clears stale feedback here.
  if (stripReject && stripReject.turnSeat !== state.turnSeat) stripReject = null;
  const keyLabel = usesTouchControls()
    ? (copy.touchHint || 'tap X')
    : (copy.keyHint || 'press Enter');
  const text = formatGameStrip({
    state,
    copy,
    turnName: turnNameFor(host?.session?.seats, 1),
    keyLabel,
    reject: stripReject
  });

  hint.classList.add('game-strip');
  if (text && hint.textContent !== text) hint.textContent = text;
  updateGameTargets(state);
}

/** Brief strip line for an abandoned board: abandon has no end dialogue. */
function flashAbandonedStrip(title) {
  const copy = miniGamesData.strip || {};
  stripFlash = {
    text: formatGameStrip({
      state: { active: true, title: title || 'Game', settled: true, outcome: 'abandoned' },
      copy
    }),
    until: Date.now() + 3000
  };
}

/** Outline the tile under the player and the one they face, when on a board. */
function updateGameTargets(state) {
  const player = game?.player;
  const session = host?.session;
  const waiting = Number.isInteger(state?.turnSeat) && state.turnSeat !== 0;
  if (!session || !player || state?.settled || waiting) {
    if (host?.targetHints?.length) host.setTargetTiles([]);
    stripTargetKey = '';
    return;
  }
  if (!host.isTileOnBoard?.(player.x, player.y)) {
    stripTargetKey = '';
    host.setTargetTiles([]);
    return;
  }
  const key = `${player.x},${player.y},${player.direction}`;
  if (key === stripTargetKey) return;
  stripTargetKey = key;
  const facing = facingTile(player, 1);
  host.setTargetTiles([
    { x: player.x, y: player.y },
    { x: facing.x, y: facing.y }
  ]);
}

function friendNpcs() {
  if (!game) return [];
  return game.npcs.filter(npc => friends.has(npc.id));
}

/** Tiles apples must not share: scenery, characters, and open mini-game boards. */
function forageOccupiedTiles({ scenery = [], characters = [], blocked = [] } = {}) {
  const occupied = new Set();
  for (const item of scenery) {
    if (item) occupied.add(`${item.x},${item.y}`);
  }
  for (const character of characters) {
    if (character) occupied.add(`${character.x},${character.y}`);
  }
  for (const key of blocked) occupied.add(key);
  return occupied;
}

function liveForageOccupied() {
  return forageOccupiedTiles({
    scenery: game?.scenery || [],
    characters: [game?.player, ...(game?.npcs || []), ...(game?.companions || [])],
    blocked: host?.getBlockedTiles?.() || []
  });
}

/**
 * Grow and pick forage once per frame. Apples and mushrooms are collected by
 * standing on their tile, exactly like walking over a coin would feel.
 */
function updateForageGround(nowMs = Date.now()) {
  const player = game?.player;
  if (!game?.forage || !game.terrain || !player) return;
  growForage(game.forage, {
    grid: game.terrain,
    nowMs,
    occupied: liveForageOccupied()
  });
  const pickup = collectForageAt(game.forage, {
    x: player.x,
    y: player.y,
    scenery: game.scenery,
    nowMs
  });
  if (!pickup) return;
  const basket = basketSummary(game.forage);
  showToast(`+1 ${pickup.item.icon} ${pickup.item.label} · basket ${basket.label}`);
  sounds.play('pickup');
  panels?.renderInventory?.();
  saveNow();
}

function onFriendshipChanged(npcId, isFriend) {
  if (isFriend) friends.add(npcId);
  else friends.delete(npcId);
  panels?.updateFriendsUI();
  saveNow();
}

function onDialogueEnded(npc) {
  if (npc?.id) voice?.stopActor(npc.id);
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
  setVoiceVolumeOpen(false);
  dismissNpcWatchPrompt();
  panels?.closeAllPanels();
  game.select(npc.id);
  behaviorRuntime?.setDialogue(true);
  const isFriend = friends.has(npc.id);
  dialogue.open(npc, isFriend, { games: tableGamesFor(npc) });
}

/** Card actions take the bump path so pause, guards, and cleanup match. */
function openCardDialogue(npc) {
  if (!npc || !game) return;
  if (host?.isOpen() && npc.inMiniGame) {
    showToast('Finish the game first.');
    return;
  }
  game.openDialogueWith(npc);
}

/** Show a scripted beat, closing the volume popover so it cannot sit behind the dialogue. */
function showDialogueBeat(npc, text, choices) {
  setVoiceVolumeOpen(false);
  dialogue.openCustomBeat(npc, text, choices);
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
  // The opponent owns the invite line. `dialogue.close()` has already stopped
  // their greeting, so this starts cleanly; speech never blocks the board.
  speakVoiceLine(friend, 'minigame.invite');
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
          flashAbandonedStrip(host.session.meta.title || meta.title);
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
  showDialogueBeat(opponent && opponent.name ? opponent : { name: 'Game' }, prompt.text, choices);
  speakAbandonPrompt(opponent);
}

function handleGameEnd(payload) {
  const { meta, outcome, settlement, dialogue: beat, session } = payload;
  const opponentSeat = session?.seats?.find(seat => seat.controller !== 'human' && seat.character !== game?.player);
  const opponent = opponentSeat?.character
    || (settlement?.opponentId ? resolveCharacter(settlement.opponentId) : null)
    || { name: settlement?.opponentName || 'Your friend' };
  const speaker = pickNonPlayerSeat(session?.seats, game?.player);

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

  showDialogueBeat(opponent, text, choices);
  speakSettlementResult(speaker, outcome, session);
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
  const voice = castVoice();
  return {
    id: npcId,
    name: pickName(used),
    recipe: createRecipe(voice.seed),
    voice,
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
  prefetchedVoices.clear();
  spokenChatSeqs.clear();
  chatGate?.reset();

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

  showDialogueBeat(player, dialogueData.playerMenu.title, choices);
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

  showDialogueBeat(player, dialogueData.debugMenu.title, choices);
}

function handleActionKey(character) {
  if (host?.isOpen()) {
    const result = host.handleAction(character);
    if (result?.changed) {
      sounds.play('place');
      stripReject = null;
    }
    stripTargetKey = '';
    if (result?.handled || result?.changed) {
      refreshGameStrip();
      return;
    }
    const seated = Boolean(character && host.session?.seats?.some(seat => seat.character === character));
    if (seated) {
      refreshGameStrip();
      return;
    }
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
    onReject: event => {
      const current = host?.getState?.();
      stripReject = {
        reason: event?.reason || 'illegal',
        turnSeat: Number.isInteger(current?.turnSeat) ? current.turnSeat : null
      };
      stripTargetKey = '';
      refreshGameStrip();
      if ($('debug-panel') && !$('debug-panel').hidden) panels?.updateDebugUI?.();
    },
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
      if (!event) return;
      if (event.type === 'open') {
        stripReject = null;
        stripTargetKey = '';
        refreshMiniGameFlags();
        sounds.play('game-open');
      } else if (event.type === 'turn') {
        stripReject = null;
        stripTargetKey = '';
        sounds.play('turn');
      } else if (event.type === 'cheer') {
        sounds.play('cheer');
      } else if (event.type === 'finish') {
        stripReject = null;
        stripTargetKey = '';
        if (event.winnerSeat === null || event.winnerSeat === undefined) sounds.play('draw');
        else sounds.play(Number(event.winnerSeat) === 0 ? 'win' : 'loss');
      } else if (event.type === 'abandon') {
        stripReject = null;
        sounds.play('ui-click');
      }
      refreshGameStrip();
      if ($('debug-panel') && !$('debug-panel').hidden) panels?.updateDebugUI?.();
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
    onGameStart: (detail, session) => promptNpcGameWatch(detail, session),
    onSay: onAmbientSay
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
      onBeat: onDialogueBeat,
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
      refreshGameStrip();
      updateForageGround();
      prefetchNearbyGreetings();
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

function updateSoundButton() {
  const button = $('sound-toggle');
  if (!button) return;
  const on = sounds.enabled;
  button.setAttribute('aria-pressed', String(on));
  button.setAttribute('aria-label', on ? 'Mute sound effects' : 'Unmute sound effects');
  const icon = button.querySelector('.icon');
  if (icon) icon.textContent = on ? '🔊' : '🔇';
  const label = button.querySelector('.label');
  if (label) label.textContent = on ? 'Sound' : 'Muted';
}

function updateVoiceButton() {
  const button = $('voice-toggle');
  if (!button) return;
  const engine = ensureVoice();
  const on = engine.enabled;
  button.setAttribute('aria-pressed', String(on));
  button.setAttribute('aria-label', on ? 'Mute neighbour voices' : 'Unmute neighbour voices');
  const icon = button.querySelector('.icon');
  if (icon) icon.textContent = on ? '🗣' : '🔇';
  const label = button.querySelector('.label');
  if (label) label.textContent = on ? 'Voices' : 'Voices off';
  syncVoiceVolume(engine);
}

/** Mirror the engine's volume into the popover slider and its percentage. */
function syncVoiceVolume(engine = ensureVoice()) {
  const slider = $('voice-volume-slider');
  const value = $('voice-volume-value');
  const percent = Math.round(Math.max(0, Math.min(1, Number(engine.volume) || 0)) * 100);
  if (slider && Number(slider.value) !== percent) slider.value = String(percent);
  if (value) value.textContent = `${percent}%`;
}

/** Open or close the volume popover, keeping `aria-expanded` in step. */
function setVoiceVolumeOpen(open) {
  const popover = $('voice-volume');
  const button = $('voice-volume-toggle');
  if (!popover || !button) return;
  const next = Boolean(open);
  popover.hidden = !next;
  button.setAttribute('aria-expanded', String(next));
  if (next) syncVoiceVolume();
}

function isVoiceVolumeOpen() {
  const popover = $('voice-volume');
  return Boolean(popover && !popover.hidden);
}

function updateMeta() {
  // Brand header removed from HUD
}

function makeLiveNpc() {
  const used = new Set(game.npcs.map(npc => npc.name));
  const npcId = makeId('npc');
  const voice = castVoice();
  return {
    id: npcId,
    name: pickName(used),
    recipe: createRecipe(voice.seed),
    voice,
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
      voice: npc.voice,
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
  host?.clearTrace?.();
  refreshMiniGameFlags();
  bubbles?.clear();
  prefetchedVoices.clear();
  spokenChatSeqs.clear();
  chatGate?.reset();

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
        voice: npc.voice,
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
  const forage = createForageState(state.forage);
  if (!forage.seeded) {
    seedApples(forage, {
      grid: terrain,
      occupied: forageOccupiedTiles({
        scenery,
        characters: [rawPlayer, ...npcs, ...companions]
      })
    });
  }
  game.setWorld({
    terrain,
    worldSeed: state.worldSeed,
    player: rawPlayer,
    npcs,
    companions,
    scenery,
    forage,
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

  showDialogueBeat(
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
  const voice = castVoice();
  const recipe = createRecipe(voice.seed);
  cardCharacter.recipe = recipe;
  cardCharacter.voice = voice;
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
  $('sound-toggle')?.addEventListener('click', () => {
    const on = sounds.toggle();
    updateSoundButton();
    if (on) sounds.play('ui-click');
  });
  $('voice-toggle')?.addEventListener('click', () => {
    const engine = ensureVoice();
    const on = engine.setEnabled(!engine.enabled);
    if (on) engine.unlock();
    updateVoiceButton();
  });

  $('voice-volume-toggle')?.addEventListener('click', () => {
    setVoiceVolumeOpen(!isVoiceVolumeOpen());
  });

  $('voice-hint-dismiss')?.addEventListener('click', hideVoiceHint);
  $('voice-hint')?.addEventListener('keydown', event => {
    if (event.key === 'Escape') hideVoiceHint();
  });

  const volumeSlider = $('voice-volume-slider');
  const commitVoiceVolume = () => {
    voiceVolumeTimer = 0;
    if (!volumeSlider) return;
    const engine = ensureVoice();
    const next = Math.max(0, Math.min(1, Number(volumeSlider.value) / 100));
    // Raising the slider from silent is the same intention as unmuting.
    if (next > 0 && !engine.enabled) {
      engine.setEnabled(true);
      engine.unlock();
    }
    engine.setVolume(next);
    updateVoiceButton();
  };

  volumeSlider?.addEventListener('input', () => {
    const value = $('voice-volume-value');
    if (value) value.textContent = `${Math.round(Number(volumeSlider.value) || 0)}%`;
    window.clearTimeout(voiceVolumeTimer);
    voiceVolumeTimer = window.setTimeout(commitVoiceVolume, 120);
  });
  volumeSlider?.addEventListener('change', () => {
    window.clearTimeout(voiceVolumeTimer);
    commitVoiceVolume();
  });
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

  document.addEventListener('pointerdown', event => {
    if (!isVoiceVolumeOpen()) return;
    const popover = $('voice-volume');
    const button = $('voice-volume-toggle');
    if (popover?.contains(event.target) || button?.contains(event.target)) return;
    setVoiceVolumeOpen(false);
  });

  window.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !isVoiceVolumeOpen()) return;
    setVoiceVolumeOpen(false);
    $('voice-volume-toggle')?.focus({ preventScroll: true });
  });

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
    if (document.visibilityState === 'hidden') {
      saveNow();
      voice?.suspend();
    }
  });

  // Browsers only allow audio after a user gesture; unlock once, quietly.
  const unlockAudio = () => {
    sounds.unlock();
    ensureVoice().unlock();
    audioUnlocked = true;
  };
  window.addEventListener('pointerdown', unlockAudio, { once: true });
  window.addEventListener('keydown', unlockAudio, { once: true });

  window.setInterval(saveNow, 8000);
}

function boot() {
  ensureGame();
  hintDefault = $('hint')?.textContent || '';

  panels = new PanelsUI({
    getGame: () => game,
    getFriends: () => friends,
    onThrowBall,
    onPlayGame,
    onTalkNpc: openCardDialogue,
    getBoardGames: npc => tableGamesFor(npc),
    onPackUpGame: gameId => packUpGame(gameId),
    isGameOpen: gameId => Boolean(host?.isOpen() && host.activeGameId === gameId),
    getGameMetas: () => (host ? [...host.registry.values()].map(entry => entry.meta) : []),
    getHostState: () => host?.getState?.() || null,
    getHostTrace: () => host?.getTrace?.() || [],
    getVoicePlayback: () => voice?.lastPlayback || null,
    getLastVoiceSpeaker: () => lastVoiceSpeaker,
    getVoiceLanguages: () => voice?.policy?.languages || [],
    getBehaviorSummary: () => behaviorRuntime?.snapshot?.() || null,
    onGrantEffects: grantAllEffects,
    onGrantNpcEffect,
    onGrantNpcBuddy,
    onSimulateNpcWin,
    onAutoEquipNpc,
    onTriggerNpcGame: triggerNpcGame,
    onRosterChanged: () => syncBehaviorWorld({ reset: true }),
    onToast: showToast,
    onSound: cue => sounds.play(cue),
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
  updateSoundButton();
  updateVoiceButton();

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
  get voice() { return ensureVoice(); },
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
