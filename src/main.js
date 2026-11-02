import { Game, COMPANION_CAPS, STARTING_COINS } from './game.js';
import {
  createRecipe,
  createCompanionRecipe,
  avatarDataUrl,
  bindAnimatedAvatar,
  preloadAvatars
} from './avatar.js';
import {
  encodeTerrain,
  decodeTerrain,
  makeSeed,
  isWalkable,
  findOpenTile,
  findPath
} from './world.js';
import {
  DEFAULT_LOCATION,
  LOCATIONS,
  SHOPKEEPER_ID,
  allowsForage,
  allowsShells,
  arrivalTile,
  createHomeLocation,
  createLocationRecord,
  doorsFor,
  isLocationEnabled,
  locationDef,
  locationLabel,
  locationTheme,
  propsForLocation,
  residentsFor,
  travelTargets,
  worldFor
} from './locations.js';
import { PLAYER_NAMES, COMPANION_NAMES, pickName, pickVibe } from './names.js';
import {
  LESSONS_DATA,
  drawLessonQuestions,
  gradeLesson,
  lessonCoinAward,
  lessonTopicLabel
} from './lessons.js';
import {
  serializeSave,
  captureLocationRecord,
  saveState,
  loadSave,
  clearSave,
  normalizeActivities,
  recordGameResult,
  activeLocation
} from './storage.js';
import {
  homeRoomTiles,
  placeHomeBuddies,
  selectHomeRoster
} from './home.js';
import {
  HOME_SHOP,
  blockedTiles,
  buyShopItem,
  canPlaceHomeItem,
  consumeRecipe,
  consumeHomeStorage,
  doorLaneTiles,
  findHomePlacementTile,
  homeActionPriority,
  homeItem,
  homeItemAtTop,
  homeItemReasonText,
  homeItemSize,
  homeItemTierInfo,
  homeItemUse,
  loadHomeItems,
  nextHomeUid,
  normalizeHomeStorage,
  rugTiles,
  shopStock,
  toggleHomeItem,
  upgradeHomeItem
} from './home_items.js';
import { locationBlockedTiles } from './location_props.js';
import { castVoice } from './voice/casting.js';
import { VoiceEngine } from './voice/engine.js';
import { DialogueManager } from './dialogue.js';
import { createItemInstance, createStarterInventory, normalizeInventory } from './inventory.js';
import { applyTrade } from './trade.js';
import { applyGoalEvent, normalizeGoalProgress } from './goals.js';
import { SetupWizard } from './ui/wizard.js';
import { PanelsUI } from './ui/panels.js';
import { MiniGameHost } from './minigames/host.js';
import { formatGameStrip, turnNameFor } from './minigames/strip.js';
import { registerContractGames } from './games/contract-adapters.js';
import {
  activityDefinition,
  activityList,
  bestMsFor,
  createActivity,
  formatActivityTime,
  recordActivityAttempt,
  rewardForActivity
} from './activities/platformer.js';
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
import goalsData from '../data/goals.json' with { type: 'json' };
import behaviorData from '../data/behaviors.json' with { type: 'json' };
import miniGamesData from '../data/minigames.json' with { type: 'json' };
import { rollReward, applyReward } from './rewards.js';
import { awardNpcGame } from './npc/game-rewards.js';
import { autoEquipOwner } from './npc/loadout.js';
import {
  basketSummary,
  carryBasket,
  collectForageAt,
  createForageState,
  growForage,
  seedForage
} from './forage.js';
import { SoundBoard } from './audio.js';
import { TILE } from './renderer.js';

const MAX_NPCS = engineConfig.crowd.maxNpcs;
const DEFAULT_CROWD = engineConfig.crowd.defaultCount;
const DEFAULT_STEP_MS = 180;

const $ = id => document.getElementById(id);

let game = null;
let draft = null;
let dialogue = null;
let lessonSession = null;
let host = null;
let bubbles = null;
let behaviorRuntime = null;
let npcGameAdapter = null;
let wizard = null;
let panels = null;
let friends = new Set();
let toastTimer = 0;
let entered = false;
/** v4 locations map captured from the save, kept in sync by captureLocation(). */
let locationStates = {};
/** Location the live game is standing in. */
let currentLocationId = DEFAULT_LOCATION;
/** Shared companion roster; companions of absent buddies stay here, not in game.companions. */
let rosterCompanions = [];
/** Home (and any location with `forage: false`) never grows or collects pickups. */
let forageEnabled = true;
let lastFrameAt = 0;
let npcWatchPrompt = null;
/** Session the player explicitly chose to watch; only then does the camera leave the player. */
let spectatingSession = null;
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
/** Held directions for a full-view activity, fed by keyboard and touch alike. */
const activityHolds = new Set();
/** Throttle for the activity HUD text, so we do not touch the DOM every frame. */
let activityHudAt = 0;
/** Best time and clear count per activity course, mirrored into the save. */
let activityRecords = {};
/** Open Home item card: the record uid plus the item id for its verb and icon. */
let homeItemCard = null;
/** Home Furnish mode: the selected record and its uncommitted draft placement. */
let furnish = null;
/** Park Passport progress: completed goal ids mapped to a timestamp. */
let goalProgress = normalizeGoalProgress(null);

/** True while a session has taken over the whole canvas. */
function isActivitySession() {
  return Boolean(host?.isOpen?.() && host.session?.meta?.render?.mode === 'fullview');
}

/** True while a full-view activity is actually taking input (not its end beat). */
function activityAcceptsInput() {
  if (!isActivitySession() || dialogue?.isOpen()) return false;
  const phase = activityGame()?.phase;
  return phase === 'ready' || phase === 'playing';
}

/** The active full-view game, or null. */
function activityGame() {
  return isActivitySession() ? host.session.game : null;
}

/**
 * One hold path for keyboard and touch: update the set, then hand the shell's
 * booleans to the activity. Edges (jump) are derived from set membership, so
 * the d-pad's synthetic key repeats cannot re-trigger a jump.
 */
function setActivityHold(action, down) {
  if (!action) return false;
  const was = activityHolds.has(action);
  if (down) activityHolds.add(action);
  else activityHolds.delete(action);
  if (!activityAcceptsInput()) return false;
  host.handleInput({
    type: 'hold',
    left: activityHolds.has('left'),
    right: activityHolds.has('right'),
    jump: activityHolds.has('jump'),
    jumpPressed: down && action === 'jump' && !was,
    jumpReleased: !down && action === 'jump' && was
  });
  return true;
}

/** Map a key name to a side-scroller hold. Up/down are deliberately ignored. */
function activityActionForKey(key) {
  const name = String(key || '').toLowerCase();
  if (name === 'a' || name === 'arrowleft') return 'left';
  if (name === 'd' || name === 'arrowright') return 'right';
  if (name === ' ' || name === 'enter') return 'jump';
  return null;
}

function clearActivityHolds() {
  activityHolds.clear();
}

/** Ask the activity for its HUD snapshot and paint it; hide it when idle. */
function updateActivityHud(force = false) {
  const hud = $('activity-hud');
  if (!hud) return;
  const active = isActivitySession();
  hud.hidden = !active;
  document.body.classList.toggle('activity-open', active);
  if (!active) {
    if (activityHudAt) activityHudAt = 0;
    return;
  }
  const now = performance.now();
  if (!force && now - activityHudAt < 100) return;
  activityHudAt = now;

  const snapshot = activityGame()?.getHud?.() || null;
  if (!snapshot) return;
  const name = $('activity-name');
  const time = $('activity-time');
  const par = $('activity-par');
  const best = $('activity-best');
  const ghost = $('activity-ghost');
  const delta = $('activity-delta');
  if (name) name.textContent = snapshot.title || 'Course';
  if (time) time.textContent = snapshot.time.toFixed(2);
  if (par) par.textContent = snapshot.par.toFixed(2);
  if (best) best.textContent = formatActivityTime(snapshot.bestMs) || '—';
  if (ghost) ghost.textContent = snapshot.ghostName ? `vs ${snapshot.ghostName}` : 'solo run';
  if (delta) {
    const behind = snapshot.delta > 0;
    delta.textContent = snapshot.state === 'finished'
      ? `${behind ? '+' : '−'}${Math.abs(snapshot.delta).toFixed(2)}s`
      : (snapshot.state === 'ready' ? 'ready' : 'running');
    delta.classList.toggle('ahead', snapshot.state === 'finished' && !behind);
    delta.classList.toggle('behind', snapshot.state === 'finished' && behind);
  }
}

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
  // Shopkeepers and other fixed characters are scenery with dialogue, not
  // wanderers, so the Park's behaviour runtime never schedules them. Residents
  // declared by a location use the lighter wander in `Game.updateNpc`.
  return [...(game.npcs || []), ...(game.companions || [])]
    .filter(actor => !actor?.stationary && !actor?.shopkeeper && !actor?.resident);
}

function showToast(message) {
  const toast = $('toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove('show'), 2400);
}

/**
 * Apply one Park Passport event. Completion pays each goal's coins exactly once,
 * persists, refreshes the Goals panel, and plays the win cue. Unknown events are
 * a no-op, so callers can fire freely from gameplay hooks.
 */
function completeGoalEvent(event) {
  if (!entered || !game?.player) return [];
  const result = applyGoalEvent(goalProgress, event, goalsData.goals, Date.now());
  if (!result.changed) return [];
  goalProgress = result.progress;

  const coins = result.completed.reduce((total, goal) => total + (Number(goal.reward) || 0), 0);
  if (coins > 0) {
    game.player.coins = Math.max(0, Math.floor(Number(game.player.coins) || 0)) + coins;
  }
  saveNow();
  panels?.refreshGoals?.();
  const titles = result.completed.map(goal => goal.title || goal.id).join(' · ');
  // Let the action's own toast finish first; the passport line is the follow-up.
  const line = `🎯 ${titles} · +${coins}🪙`;
  window.setTimeout(() => showToast(line), 1500);
  sounds.play('win');
  return result.completed;
}

/** Coarse pointers use the on-screen X button instead of a keyboard. */
function usesTouchControls() {
  return Boolean(window.matchMedia?.('(pointer: coarse)')?.matches);
}

/** Frame the active board and flag it for dialogue placement. */
function syncBoardFraming(boardOpen, frame = true) {
  document.body.classList.toggle('board-open', boardOpen);
  if (!boardOpen) {
    spectatingSession = null;
  }
  if (!boardOpen || !frame) {
    game?.clearCameraTarget?.();
    return;
  }
  const footprint = host?.getFootprint?.() || null;
  if (footprint) game?.setCameraTarget?.(footprint);
  else game?.clearCameraTarget?.();
}

/**
 * Persistent board strip. Reuses `#hint` while a board session is active and
 * restores the original hint afterwards. Runs every frame; DOM writes only
 * when the composed line changes.
 */
function refreshGameStrip() {
  const state = host?.getState?.() || null;
  const sessionActive = Boolean(state?.active && state.kind !== 'activity');
  if (npcWatchPrompt && !state?.active) dismissNpcWatchPrompt();
  const session = host?.session || null;
  if (spectatingSession && (!session || playerBoardDistance(spectatingSession) > 10)) {
    spectatingSession = null;
  }
  const npcOnly = isNpcOnlySession(session);
  const watching = Boolean(spectatingSession && spectatingSession === session);
  // A far-away NPC game must not take over the strip or the camera. Only a
  // player-owned session or an explicit Watch does that.
  const boardOpen = sessionActive && (!npcOnly || watching);
  const frameBoard = !npcOnly || watching;
  syncBoardFraming(boardOpen, frameBoard);
  const hint = $('hint');
  if (!hint) return;

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
 * Grow and pick forage once per frame. Apples, mushrooms, and shells are
 * collected by standing on their tile, exactly like walking over a coin would
 * feel.
 */
function updateForageGround(nowMs = Date.now()) {
  const player = game?.player;
  if (!forageEnabled) return;
  // The Park is frozen while an activity owns the frame; pickups wait too.
  if (game?.worldSuspended) return;
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
  if (pickup.kind === 'shell') completeGoalEvent('shell.collected');
  saveNow();
}

function onFriendshipChanged(npcId, isFriend) {
  if (isFriend) friends.add(npcId);
  else friends.delete(npcId);
  if (isFriend) completeGoalEvent('social.friend');
  panels?.updateFriendsUI();
  saveNow();
}

function onDialogueEnded(npc) {
  if (npc?.id) voice?.stopActor(npc.id);
  lessonSession = null;
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
  // The librarian runs the lesson flow instead of the neighbour conversation.
  if (isLibrarian(npc)) {
    openLibrarianBeat(npc);
    return;
  }
  // The keeper does not use the neighbour conversation flow: one short greeting
  // and a door into the shop panel.
  if (isShopkeeper(npc)) {
    openShopBeat(npc);
    return;
  }
  closeHomeItemCard();
  setVoiceVolumeOpen(false);
  dismissNpcWatchPrompt();
  panels?.closeAllPanels();
  game.select(npc.id);
  behaviorRuntime?.setDialogue(true);
  const isFriend = friends.has(npc.id);
  dialogue.open(npc, isFriend, { games: tableGamesFor(npc) });
  completeGoalEvent('social.greet');
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
  dismissNpcWatchPrompt();
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

  if (meta.render?.mode === 'fullview') {
    startActivity(gameId, opponent);
    return;
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
  completeGoalEvent('games.board');
  refreshMiniGameFlags();
  panels?.updateDebugUI?.();
}

/** The competitor for a full-view activity: a buddy first, then any neighbour. */
function activityRival(opponent = null) {
  if (opponent && opponent !== game?.player) return opponent;
  const buddy = (game?.companions || []).find(companion => companion.buddyId === 'player');
  return buddy || (game?.npcs || [])[0] || null;
}

/**
 * The course board: one beat listing every enabled course with its par and the
 * player's best. The Park pauses under it; leaving resumes where they stood.
 */
function openActivityChooser(opponent = null) {
  if (!host || !game?.player) return false;
  const courses = activityList().filter(definition => host.getMeta(definition.id));
  if (!courses.length) {
    showToast('No courses are open right now.');
    return false;
  }
  if (courses.length === 1) return startActivity(courses[0].id, opponent);
  if (host.isOpen() && !npcOwnsSession()) {
    showToast(`${host.session.meta.title || 'A game'} is already open. Pack it up first.`);
    return false;
  }

  panels?.closeAllPanels();
  bubbles?.clear();
  game.paused = true;
  game.interactive = false;
  game.heldKeys = [];
  if (game.player.path) game.player.path = [];
  behaviorRuntime?.setDialogue(true);
  sounds.play('ui-click');

  const choices = courses.map(definition => {
    const best = bestMsFor(activityRecords, definition.id);
    const bestLabel = best ? `best ${formatActivityTime(best)}s` : 'no time yet';
    return {
      label: `${definition.title} · par ${Number(definition.par).toFixed(2)}s · ${bestLabel}`,
      className: definition.id === 'jungle-gym' ? 'primary' : 'pill',
      onClick: () => {
        dialogue.close();
        startActivity(definition.id, opponent);
      }
    };
  });
  choices.push({
    label: 'Not now',
    className: 'pill quiet',
    onClick: () => dialogue.close()
  });

  showDialogueBeat({ name: 'Course board' }, 'pick a course:', choices);
  return true;
}

/**
 * Start a full-view activity session for one course. The Park freezes on the
 * next frame (the shell syncs suspend from the session's render mode), and the
 * activity owns the canvas, the clock, and input until it settles or the
 * player leaves.
 */
function startActivity(activityId, opponent = null) {
  if (!host || !game?.player) return false;
  const meta = host.getMeta(activityId);
  const definition = activityDefinition(activityId);
  if (!meta || !definition) {
    showToast('That activity is not unpacked yet.');
    return false;
  }
  if (!definition.enabled) {
    showToast('That activity is closed for now.');
    return false;
  }
  if (host.isOpen()) {
    if (npcOwnsSession()) packUpNpcSession('activity-start');
    else {
      showToast(`${host.session.meta.title || 'A game'} is already open. Pack it up first.`);
      return false;
    }
  }

  const rival = activityRival(opponent);
  const seats = [
    { character: game.player, controller: 'human', role: 'player' },
    rival ? { character: rival, controller: 'ai', role: 'opponent' } : null
  ].filter(Boolean);

  if (dialogue?.isOpen()) dialogue.close();
  panels?.closeAllPanels();
  bubbles?.clear();
  clearActivityHolds();

  const result = host.start(activityId, {
    seats,
    controllers: seats.map(seat => seat.controller),
    options: {
      opponent: rival,
      bestMs: bestMsFor(activityRecords, definition.id)
    }
  });
  if (!result.ok) {
    showToast(result.message || `${meta.title} could not start here.`);
    return false;
  }

  syncActivitySuspend();
  updateActivityHud(true);
  refreshMiniGameFlags();
  if (rival?.voice) speakVoiceLine(rival, 'minigame.invite');
  panels?.updateDebugUI?.();
  return true;
}

/** Freeze or thaw the Park to match whether a full-view session is open. */
function syncActivitySuspend() {
  if (!game) return;
  if (isActivitySession()) game.suspendWorld?.('activity');
  else game.resumeWorld?.();
}

/** Leave a full-view activity without a result (Escape, or a menu exit). */
function packUpActivity() {
  if (!isActivitySession()) return false;
  const title = host.session.meta.title || 'activity';
  host.close({ reason: 'left-activity', settle: false, record: false, reward: false });
  clearActivityHolds();
  syncActivitySuspend();
  updateActivityHud(true);
  refreshMiniGameFlags();
  showToast(`Left the ${String(title).toLowerCase()}.`);
  return true;
}

/**
 * Apply one finished course run: count the clear, keep the fastest time, pay
 * the course reward once, and refresh the HUD's best. Returns the note the end
 * beat appends, or null when the event is not a course finish.
 */
function settleActivityFinish(event, session) {
  if (!session || session.meta?.render?.mode !== 'fullview') return null;
  const definition = activityDefinition(session.meta.activityId || session.meta.id);
  if (!definition) return null;
  const exactMs = Number(event?.timeMs);
  const seconds = Number(event?.time);
  const ms = Number.isFinite(exactMs) && exactMs > 0
    ? Math.round(exactMs)
    : (Number.isFinite(seconds) ? Math.max(1, Math.round(seconds * 1000)) : null);
  const recorded = recordActivityAttempt(activityRecords, definition.id, ms);
  if (!recorded.recorded) return null;
  activityRecords = recorded.records;
  const reward = rewardForActivity(definition, { outcome: event.outcome });
  if (game?.player && reward.coins > 0) {
    game.player.coins = Math.max(0, Math.floor(Number(game.player.coins) || 0)) + reward.coins;
  }
  session.game.setBestMs?.(recorded.bestMs);
  saveNow();
  completeGoalEvent('activity.finish');
  updateActivityHud(true);
  return {
    id: definition.id,
    title: definition.title,
    coins: reward.coins,
    bestMs: recorded.bestMs,
    improves: recorded.improved
  };
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

/** Eat a bag item: remove one instance, save, and say so. */
function eatBagItem(item) {
  const player = game?.player;
  if (!player || !item) return false;
  const inventory = Array.isArray(player.inventory) ? player.inventory : [];
  const index = inventory.findIndex(entry => (
    entry === item || (item.uid && entry?.uid === item.uid)
  ));
  if (index < 0) {
    showToast('that is not in the bag.');
    return false;
  }
  inventory.splice(index, 1);
  sounds.play('pickup');
  saveNow();
  panels?.renderInventory?.();
  showToast(`you eat the ${item.name || item.id}. tastes like a good afternoon.`);
  return true;
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
  if (session?.meta?.render?.mode === 'fullview') {
    const hud = session.game?.getHud?.();
    if (hud) {
      text += `\n${hud.time.toFixed(2)}s · par ${hud.par.toFixed(2)}s · ${hud.outcome === 'win' ? 'under par' : 'over par'}`;
    }
    const course = payload.event?.activityResult;
    if (course) {
      const bestLabel = formatActivityTime(course.bestMs);
      text += `\n+${course.coins}🪙 · ${course.improves ? 'new best' : 'best'} ${bestLabel}s`;
      showToast(`+${course.coins} coins · ${course.improves ? 'new best time!' : `best ${bestLabel}s`}`);
    }
  }
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
  const world = worldFor('park', worldSeed);
  const playerBuddyId = 'player';
  const playerCompanion = {
    id: makeId('comp'),
    name: randomFrom(COMPANION_NAMES),
    buddyId: playerBuddyId,
    recipe: createCompanionRecipe()
  };

  return {
    worldSeed,
    layout: world.template || null,
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

  const items = dialogueData.playerMenu.items
    .filter(item => item.id !== 'jungle-gym' || activityList().length > 0)
    .map(item => (item.id === 'jungle-gym' ? { ...item, label: '🌿 Courses' } : item));
  const choices = items.map(item => ({
    label: item.label,
    className: item.className,
    onClick: () => {
      dialogue.close();
      if (item.id === 'backpack') panels?.toggleInventoryPanel();
      else if (item.id === 'companions') {
        const playerComp = game.companions?.find(c => c.buddyId === 'player');
        if (playerComp) panels?.showCard(playerComp);
        else showToast('No companions following you right now.');
      } else if (item.id === 'jungle-gym') {
        openActivityChooser();
      } else if (item.id === 'goals') panels?.toggleGoalsPanel();
      else if (item.id === 'friends') panels?.toggleFriendsPanel();
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
  if (isActivitySession()) {
    // The end beat and any dialogue own Enter; a settled run leaves on the
    // next action press rather than trapping the player on a frozen course.
    if (dialogue?.isOpen()) return;
    const activity = activityGame();
    if (activity?.phase === 'ending' || host.session?.settled) {
      packUpActivity();
      return;
    }
    host.handleInput({ type: 'action', action: 'primary' });
    updateActivityHud(true);
    return;
  }
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
  // A pose is a rest state: the next action stands the player up or wakes them.
  if (game?.player?.homePose) {
    wakeHomePose();
    return;
  }
  // An open item card owns Enter: its focused button receives the native click.
  if (homeItemCard) return;
  if (furnish) return;
  if (panels?.isMenuOpen?.()) {
    // Already in menu: trigger focused action
    panels.triggerFocusedAction();
    return;
  }
  if (panels?.isAnyPanelOpen?.()) {
    panels.closeAllPanels();
    return;
  }
  // In Home the facing item beats the door; both beat opening the menu. This is
  // the same order asserted by homeActionPriority().
  const facing = currentLocationId === 'home' && game?.homeMode
    ? facingTile(game.player, 1)
    : null;
  const facingRecord = facing ? homeItemAtTop(activeHomeItems(), facing.x, facing.y) : null;
  const door = doorNearPlayer();
  const priority = homeActionPriority({ facingItem: facingRecord, door });
  if (priority === 'item') {
    openHomeItemCard(facingRecord);
    return;
  }
  if (priority === 'door') {
    openTravelPrompt(door);
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
        event.activityResult = settleActivityFinish(event, host?.session);
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

/**
 * One atomic neighbour trade. `applyTrade` validates both sides before any
 * mutation, so a rejection leaves coins and bags untouched; success saves at
 * once and the panel owns the refreshed copy.
 */
function applyNpcTrade(character, offer) {
  const player = game?.player;
  if (!player || !character || character.isPlayer || character.isCompanion) {
    return { ok: false, reason: 'invalid-offer' };
  }
  const result = applyTrade(player, character, offer);
  if (result.ok) {
    completeGoalEvent('trade.completed');
    saveNow();
  }
  return result;
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
      onSelect: character => {
        if (character && isShopkeeper(character)) {
          game.openDialogueWith(character);
          return;
        }
        if (character) closeHomeItemCard();
        panels?.showCard(character);
      },
      onToast: showToast,
      onDialogue: openDialogue,
      onActionKey: handleActionKey,
      onDoor: openTravelPrompt,
      isMenuOpen: () => Boolean(panels?.isMenuOpen?.()),
      onHomeItem: handleHomeItemClick,
      onCanvasPointer: handleHomeCanvasPointer
    });

    bubbles = new SpeechBubbles({ getActor: resolveCharacter });
    host = new MiniGameHost({ game, hooks: hostHooks() });
    registerContractGames(host, miniGamesData.miniGames);
    // Every enabled course registers from data/activities.json against the
    // shared full-view metadata shape. Disabled courses never reach the host.
    const activityBaseMeta = miniGamesData.miniGames['jungle-gym'];
    if (activityBaseMeta?.render?.mode === 'fullview') {
      for (const definition of activityList()) {
        host.register({
          meta: {
            ...activityBaseMeta,
            id: definition.id,
            title: definition.title,
            activityId: definition.id
          },
          create: createActivity
        });
      }
    }

    delegated = {
      host: typeof game.setMiniGameHost === 'function',
      runtime: typeof game.setBehaviorRuntime === 'function'
    };
    game.setMiniGameHost?.(host);
    game.setSpeechBubbles?.(bubbles);
    ensureBehaviorRuntime();

    game.onFrame = () => {
      if (dialogue?.isOpen()) dialogue.updatePosition();
      if (homeItemCard) positionHomeItemCard();

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
      syncActivitySuspend();
      updateActivityHud();
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
    layout: draft.layout || null,
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
  activityRecords = normalizeActivities(state.activities);
  goalProgress = normalizeGoalProgress(
    state.goals,
    new Set(goalsData.goals.map(goal => goal.id))
  );
  refreshMiniGameFlags();
  bubbles?.clear();
  prefetchedVoices.clear();
  spokenChatSeqs.clear();
  chatGate?.reset();
  // A new world never inherits an item card or an uncommitted furnishing draft.
  closeHomeItemCard();
  endFurnish();
  closeShopPanel({ silent: true });

  const requested = typeof state.currentLocation === 'string' ? state.currentLocation : DEFAULT_LOCATION;
  const locationId = isLocationEnabled(requested) ? requested : DEFAULT_LOCATION;
  const homeMode = locationId === 'home';
  const locationState = activeLocation(state) || {};
  const sharedPlayer = state.player && typeof state.player === 'object' ? state.player : {};
  const worldData = worldFor(locationId, locationState.seed, locationState);
  const terrain = decodeTerrain(locationState.terrain) || worldData.grid;
  const theme = locationTheme(locationId, locationState);
  const locationProps = propsForLocation(locationId, locationState);
  const locationBlocked = locationBlockedTiles(locationProps);
  // Scenery belongs to generated ground: never leave a tree inside a building.
  const scenery = (worldData.scenery || [])
    .filter(item => !locationBlocked.has(`${item.x},${item.y}`));
  const locationSpawn = locationDef(locationId)?.spawn || worldData.spawn || { x: 32, y: 32 };
  const arrival = arrivalTile(locationId, { player: locationState.player });
  const rawPlayer = {
    id: 'player',
    name: state.playerName || 'You',
    recipe: state.playerRecipe,
    x: arrival.x,
    y: arrival.y,
    direction: arrival.direction,
    inventory: normalizeInventory(sharedPlayer.inventory || createStarterInventory()),
    equipped: Array.isArray(sharedPlayer.equipped) ? sharedPlayer.equipped : [],
    effectGhosts: Array.isArray(sharedPlayer.effectGhosts) ? sharedPlayer.effectGhosts : [],
    coins: Number.isFinite(sharedPlayer.coins) ? sharedPlayer.coins : STARTING_COINS,
    stabledCompanions: Array.isArray(sharedPlayer.stabledCompanions) ? sharedPlayer.stabledCompanions : []
  };
  if (!isWalkable(terrain[rawPlayer.y]?.[rawPlayer.x])) {
    const spot = findOpenTile(terrain, locationSpawn);
    rawPlayer.x = spot.x;
    rawPlayer.y = spot.y;
  }

  // Home furniture resolves once per arrival: saved items win, a legacy
  // `decor` record converts on its first load, otherwise the default room is
  // furnished. An old saved tile now under a couch is nudged to open floor.
  const roomTiles = homeMode ? homeRoomTiles(terrain, worldData.house) : [];
  const homeItems = homeMode
    ? loadHomeItems(locationState, { house: worldData.house, door: worldData.door, roomTiles })
    : [];
  // Home storage travels with the Home record even while the player is at the
  // shop, so a purchase is never stranded in the shop's live state.
  const stateHome = isObjectMap(state.locations) ? state.locations.home : null;
  const homeStorage = normalizeHomeStorage(homeMode ? locationState.storage : stateHome?.storage);
  const homeBlocked = homeMode ? blockedTiles(homeItems) : new Set();
  const homeDoorLane = homeMode
    ? doorLaneTiles({ house: worldData.house, door: worldData.door })
    : new Set();
  // Solid props and furniture share the landing check: neither may trap a
  // player who saved inside a footprint that has since grown.
  const blockedLanding = new Set([...homeBlocked, ...locationBlocked]);
  if (blockedLanding.size && blockedLanding.has(`${rawPlayer.x},${rawPlayer.y}`)) {
    const spot = findOpenTile(terrain, locationSpawn, blockedLanding, 0);
    rawPlayer.x = spot.x;
    rawPlayer.y = spot.y;
  }

  // Declared residents are rebuilt from data on every arrival. A save written
  // before residents were excluded may still hold stale copies, so drop them.
  const declaredResidents = residentsFor(locationId);
  const declaredResidentIds = new Set(declaredResidents.map(resident => resident.id));
  const npcs = (Array.isArray(locationState.npcs) ? locationState.npcs : [])
    .filter(npc => npc && npc.recipe && npc.name)
    .filter(npc => !declaredResidentIds.has(npc.id))
    .map(npc => {
      const hasPosition = Number.isFinite(Number(npc.x)) && Number.isFinite(Number(npc.y));
      const isKeeper = locationId === 'shop' && (npc.id === SHOPKEEPER_ID);
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
        coins: Number.isFinite(npc.coins) ? npc.coins : STARTING_COINS,
        stabledCompanions: Array.isArray(npc.stabledCompanions) ? npc.stabledCompanions : [],
        // The shopkeeper stays behind the counter; the behaviour runtime skips him.
        shopkeeper: isKeeper,
        stationary: isKeeper
      };
      if (!isWalkable(terrain[entry.y]?.[entry.x])
        || locationBlocked.has(`${entry.x},${entry.y}`)) {
        const spot = findOpenTile(terrain, { x: rawPlayer.x, y: rawPlayer.y }, locationBlocked);
        entry.x = spot.x;
        entry.y = spot.y;
      }
      return entry;
    });

  // Data-declared residents are instantiated fresh on every arrival and are
  // never written into the save. Their stable ids carry friendships and trades.
  const residentBlocked = new Set([
    `${rawPlayer.x},${rawPlayer.y}`,
    ...locationBlocked,
    ...homeBlocked
  ]);
  for (const npc of npcs) residentBlocked.add(`${npc.x},${npc.y}`);
  const residentIds = new Set(npcs.map(npc => npc.id));
  for (const resident of declaredResidents) {
    if (residentIds.has(resident.id)) continue;
    const entry = {
      ...resident,
      // No voice in data: cast one deterministically from the stable id.
      voice: resident.voice || castVoice({ id: resident.id }),
      inventory: createStarterInventory(),
      equipped: [],
      effectGhosts: [],
      coins: 0,
      stabledCompanions: []
    };
    if (!isWalkable(terrain[entry.y]?.[entry.x])
      || residentBlocked.has(`${entry.x},${entry.y}`)) {
      const spot = findOpenTile(
        terrain,
        { x: rawPlayer.x, y: rawPlayer.y },
        residentBlocked,
        1
      );
      entry.x = spot.x;
      entry.y = spot.y;
    }
    residentIds.add(entry.id);
    residentBlocked.add(`${entry.x},${entry.y}`);
    npcs.push(entry);
  }

  const occupiedPositions = new Set([
    `${rawPlayer.x},${rawPlayer.y}`,
    ...homeBlocked,
    ...locationBlocked
  ]);
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
  // Only the wizard's v1 draft still needs synthesized buddies. A v4 save with
  // no active party must not invent one, especially in Home where it would stop
  // being "the same records".
  if (!companions.length && Number(state.version) < 4) {
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

  // A companion that follows the player between locations can arrive on a wall
  // tile (the Home spawn is nowhere near its Park coordinates). Nudge those
  // onto the nearest open tile instead of letting them spawn inside stone.
  // Home keeps the roster untouched: Home coordinates are never merged back,
  // so the Park party returns to the tiles it left.
  if (!homeMode) {
    const companionTiles = new Set([
      `${rawPlayer.x},${rawPlayer.y}`,
      ...npcs.map(npc => `${npc.x},${npc.y}`),
      ...locationBlocked
    ]);
    companions = companions.map(comp => {
      const x = Math.round(Number(comp.x));
      const y = Math.round(Number(comp.y));
      const key = `${x},${y}`;
      if (Number.isFinite(x) && Number.isFinite(y) && isWalkable(terrain[y]?.[x]) && !companionTiles.has(key)) {
        companionTiles.add(key);
        return comp;
      }
      const spot = findOpenTile(terrain, { x: rawPlayer.x, y: rawPlayer.y }, companionTiles, 1);
      companionTiles.add(`${spot.x},${spot.y}`);
      return { ...comp, x: spot.x, y: spot.y };
    });
  }

  const homeRugTiles = homeMode ? rugTiles(homeItems) : [];
  const homeSelection = homeMode
    ? selectHomeRoster(companions, rawPlayer.stabledCompanions)
    : { buddies: [], total: 0, overflow: 0 };
  const homeBuddies = homeMode
    ? placeHomeBuddies(homeSelection.buddies, {
      terrain,
      house: worldData.house,
      spawn: { x: rawPlayer.x, y: rawPlayer.y },
      rugTiles: homeRugTiles,
      blockedTiles: homeBlocked,
      doorLaneTiles: homeDoorLane
    })
    : [];

  ensureGame();
  const forage = createForageState(locationState.forage);
  forageEnabled = allowsForage(locationId);
  if (!forageEnabled) {
    // Home is a place to rest: no apples, mushrooms, shells, or respawn clocks.
    forage.apples = [];
    forage.shells = [];
    forage.harvested = {};
    forage.nextShellAt = 0;
    forage.seeded = true;
  } else if (!forage.seeded) {
    seedForage(forage, {
      grid: terrain,
      shells: allowsShells(locationId),
      occupied: forageOccupiedTiles({
        scenery,
        characters: [rawPlayer, ...npcs, ...companions],
        blocked: locationBlocked
      })
    });
  }
  const npcFlags = new Map(npcs.map(npc => [npc.id, npc]));
  game.setWorld({
    terrain,
    worldSeed: locationState.seed ?? worldData.seed,
    player: rawPlayer,
    npcs,
    companions: homeMode ? [] : companions,
    scenery,
    forage,
    homeItems,
    homeMode,
    homeBuddies,
    homeRoomTiles: roomTiles,
    homeRugTiles,
    locationProps,
    theme,
    wander: state.wander !== false
  });
  // `makeCharacter` rebuilds every NPC, so reapply the flags that shape
  // dialogue and wandering: the keeper stays put and residents stay residents.
  for (const npc of game.npcs || []) {
    const source = npcFlags.get(npc.id);
    if (!source) continue;
    for (const key of ['resident', 'stationary', 'shopkeeper', 'role']) {
      if (source[key] !== undefined) npc[key] = source[key];
    }
    // The librarian stays at the desk rather than strolling the reading room.
    if (npc.role === 'librarian') {
      npc.stationary = true;
      npc.wait = Number.POSITIVE_INFINITY;
    }
  }
  game.homeOverflow = homeSelection.overflow;
  game.homeStorage = homeStorage;
  // Doors are per location, so they are set after setWorld resets them.
  game.doors = doorsFor(locationId, { terrain, spawn: rawPlayer });

  const knownFriendIds = knownNpcIds(state, npcs);
  locationStates = isObjectMap(state.locations)
    ? { ...state.locations }
    : {
        park: captureLocationRecord({
          seed: locationState.seed ?? game.worldSeed,
          layout: locationState.layout || null,
          terrain,
          player: rawPlayer,
          npcs,
          forage: game.forage
        })
      };
  currentLocationId = locationId;
  rosterCompanions = companions.map(comp => ({ ...comp }));

  syncBehaviorWorld({ reset: true });
  applyBehaviorState(state);
  behaviorRuntime?.setDialogue(false);
  friends = new Set(
    (Array.isArray(state.friends) ? state.friends : [...friends])
      .filter(id => knownFriendIds.has(id))
  );
  draft = {
    worldSeed: locationState.seed ?? worldData.seed,
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
  panels?.refreshGoals?.();
  updateMeta();
  updateLocationChrome();
}

function isObjectMap(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Friend ids stay valid while their NPC exists in any location, not just this one. */
function knownNpcIds(state, currentNpcs) {
  const ids = new Set((currentNpcs || []).map(npc => npc?.id).filter(Boolean));
  const locations = isObjectMap(state?.locations) ? state.locations : null;
  if (locations) {
    for (const record of Object.values(locations)) {
      for (const npc of Array.isArray(record?.npcs) ? record.npcs : []) {
        if (npc?.id) ids.add(npc.id);
      }
    }
  }
  // Residents are not saved, but their stable ids still own friendships.
  for (const def of Object.values(LOCATIONS)) {
    for (const resident of Array.isArray(def?.residents) ? def.residents : []) {
      if (resident?.id) ids.add(resident.id);
    }
  }
  return ids;
}

/** HUD copy that names the current location. */
function updateLocationChrome() {
  const label = $('map-label');
  if (label) {
    label.textContent = locationDef(currentLocationId)?.mapLabel
      || `${locationLabel(currentLocationId)} map`;
  }
  const canvas = $('world');
  if (canvas) {
    canvas.setAttribute(
      'aria-label',
      `A 64 by 64 tile ${locationLabel(currentLocationId).toLowerCase()}. Use WASD or the arrow keys to walk, or click the ground to move.`
    );
  }
  updateHomeNote();
}

/** Quiet "and N more" note when the Home roster is over the placed cap. */
function updateHomeNote() {
  const note = $('home-note');
  if (!note) return;
  const overflow = Number(game?.homeOverflow) || 0;
  if (currentLocationId !== 'home' || overflow <= 0) {
    note.hidden = true;
    note.textContent = '';
    return;
  }
  note.hidden = false;
  note.textContent = `and ${overflow} more ${overflow === 1 ? 'buddy is' : 'buddies are'} resting elsewhere`;
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
  captureLocation();
  captureCompanions();
  const state = serializeSave(game, draft, friends, behaviorSaveState(), {
    locations: locationStates,
    currentLocation: currentLocationId,
    companions: rosterCompanions,
    activities: activityRecords,
    goals: goalProgress
  });
  saveState(state);
}

/** Write the live game back into its location record; shared by save and travel. */
function captureLocation() {
  if (!game?.terrain || !game.player) return;
  locationStates[currentLocationId] = captureLocationRecord({
    seed: game.worldSeed,
    terrain: game.terrain,
    player: game.player,
    // Location residents are instantiated from data on every arrival.
    npcs: (game.npcs || []).filter(npc => !npc.resident),
    forage: game.forage,
    items: currentLocationId === 'home' ? game.homeItems : null,
    storage: currentLocationId === 'home' ? activeHomeStorage() : null
  }, locationStates[currentLocationId] || null);
}

/**
 * Merge companions that are live here back into the shared roster. Buddies who
 * stay behind (NPC companions while at Home) keep their last captured record
 * instead of vanishing from the party. Companions moved into a reserve slot are
 * dropped from the roster so they do not load as active and stabled at once.
 */
function captureCompanions() {
  const byId = new Map((rosterCompanions || []).map(comp => [comp.id, comp]));
  for (const comp of game?.companions || []) {
    if (!comp?.id) continue;
    byId.set(comp.id, { ...(byId.get(comp.id) || {}), ...comp });
  }
  const stabled = new Set();
  for (const owner of [game?.player, ...(game?.npcs || [])]) {
    for (const comp of owner?.stabledCompanions || []) {
      if (comp?.id) stabled.add(comp.id);
    }
  }
  // A removed neighbour should not leave a buddy ghost behind in other
  // locations, so the roster only keeps buddies that still exist somewhere.
  const knownBuddies = new Set(['player']);
  for (const record of Object.values(locationStates || {})) {
    for (const npc of Array.isArray(record?.npcs) ? record.npcs : []) {
      if (npc?.id) knownBuddies.add(npc.id);
    }
  }
  rosterCompanions = [...byId.values()].filter(comp => (
    !stabled.has(comp.id) && knownBuddies.has(comp.buddyId)
  ));
}

/** The door under the player, or the one they face. */
function doorNearPlayer() {
  const player = game?.player;
  if (!player || !Array.isArray(game.doors) || !game.doors.length) return null;
  const standing = game.doors.find(door => door.x === player.x && door.y === player.y);
  if (standing) return standing;
  const facing = facingTile(player, 1);
  return game.doors.find(door => door.x === facing.x && door.y === facing.y) || null;
}

/** Ask before swapping worlds; door bumps and Enter on a door both land here. */
function openTravelPrompt(door) {
  if (!door || !game?.player || !dialogue) return;
  closeHomeItemCard();
  // Activity entrances open the course board instead of swapping worlds.
  if (door.kind === 'activity') {
    openActivityChooser();
    return;
  }
  if (!isLocationEnabled(door.to)) return;
  if (dialogue.isOpen() || host?.isOpen()) return;
  panels?.closeAllPanels();
  game.paused = true;
  game.interactive = false;
  game.heldKeys = [];
  game.destination = null;
  if (game.player.path) game.player.path = [];
  behaviorRuntime?.setDialogue(true);
  sounds.play('ui-click');
  showDialogueBeat(game.player, door.prompt, [
    {
      label: door.confirm,
      className: 'primary',
      onClick: () => {
        dialogue.close();
        travelTo(door.to);
      }
    },
    {
      label: door.cancel,
      className: 'pill quiet',
      onClick: () => dialogue.close()
    }
  ]);
}

/**
 * Swap the live world for another location.
 *
 * Ordering matters: any board closes first (a board cannot span locations),
 * then the departing location is captured, then the arriving world is built by
 * `applyState` through `Game.setWorld` (which rebuilds the minimap and snaps
 * the camera). Park state is never regenerated over the top of a capture.
 */
function travelTo(targetId) {
  if (!entered || !game?.player || !game.terrain) return false;
  if (!locationDef(targetId) || !isLocationEnabled(targetId)) {
    showToast('That way is closed for now.');
    return false;
  }
  if (targetId === currentLocationId) {
    showToast(`You are already at the ${locationLabel(targetId).toLowerCase()}.`);
    return false;
  }

  if (dialogue?.isOpen()) dialogue.close();
  if (host?.isOpen()) {
    if (npcOwnsSession()) packUpNpcSession('travel');
    else host.close({ reason: 'travel', settle: false, record: false, reward: false });
  }
  refreshMiniGameFlags();
  bubbles?.clear();
  panels?.closeAllPanels();
  closeShopPanel({ silent: true });
  cancelFurnish({ silent: true });
  closeHomeItemCard();
  wakeHomePose({ silent: true });

  const carriedBasket = game.forage?.basket;
  captureLocation();
  captureCompanions();
  // A location not visited since the save was written gets a fresh record from
  // its template; the basket carried in is preserved either way.
  if (!locationStates[targetId]) {
    const fresh = createLocationRecord(targetId, { basket: carriedBasket });
    if (fresh) locationStates[targetId] = fresh;
  }
  // The basket travels with the player, so Park apples are bakeable at Home and
  // a pie baked at Home spends the same count back in the Park.
  if (locationStates[targetId]) {
    locationStates[targetId] = carryBasket(locationStates[targetId], carriedBasket);
  }

  currentLocationId = targetId;
  applyState({
    version: 4,
    currentLocation: targetId,
    locations: locationStates,
    playerName: game.player.name,
    playerRecipe: game.player.recipe,
    player: {
      inventory: game.player.inventory,
      coins: game.player.coins,
      equipped: game.player.equipped,
      stabledCompanions: game.player.stabledCompanions
    },
    companions: rosterCompanions,
    friends: [...friends],
    wander: game.wander,
    behavior: behaviorSaveState(),
    goals: goalProgress
  });
  game.setInteractive(true);
  saveNow();
  if (targetId === 'home') completeGoalEvent('travel.home');
  sounds.play('ui-click');
  showToast(`You are at the ${locationLabel(targetId).toLowerCase()}.`);
  return true;
}

/** The live Home furniture records; always an array. */
function activeHomeItems() {
  return Array.isArray(game?.homeItems) ? game.homeItems : [];
}

/** Bought-but-unplaced Home furniture; always an array. */
function activeHomeStorage() {
  return Array.isArray(game?.homeStorage) ? game.homeStorage : [];
}

/** Commit the unplaced list; captureLocation writes it into the save. */
function applyHomeStorage(nextStorage) {
  if (!game) return;
  game.homeStorage = normalizeHomeStorage(nextStorage);
}

/**
 * Keep `locations.home.storage` in step with the live list. Buying happens at
 * the shop, where Home is not the captured location, so the purchase is mirrored
 * into the Home record immediately (creating a fresh, unvisited Home if needed).
 */
function persistHomeStorage() {
  if (!locationStates.home) {
    locationStates.home = createHomeLocation({ basket: game?.forage?.basket });
  }
  locationStates.home = { ...locationStates.home, storage: activeHomeStorage() };
}

/**
 * Commit a furniture list to the live room and rebuild the derived sets every
 * walker and buddy reads. Moving furniture stands sitting buddies up.
 */
function applyHomeItems(nextItems, { standBuddies = false } = {}) {
  if (!game) return;
  game.homeItems = Array.isArray(nextItems) ? nextItems : [];
  if (currentLocationId === 'home') {
    game.homeBlockedTiles = blockedTiles(game.homeItems);
    game.homeRugTiles = rugTiles(game.homeItems);
  }
  if (!standBuddies) return;
  for (const buddy of game.homeBuddies || []) {
    if (buddy.pose !== 'sit') continue;
    buddy.pose = 'stand';
    buddy.sitTimer = 0;
    buddy.timer = 0.4;
  }
}

function homeItemRecord(uid) {
  return activeHomeItems().find(record => record?.uid === uid) || null;
}

function variantLabel(item, index) {
  const entry = Array.isArray(item?.variants) ? item.variants[index] : null;
  return entry?.label || 'plain';
}

/**
 * Backpack furnishing list: every placed piece, plus the live draft when Furnish
 * mode is on. Null outside Home so the section never appears in the Park.
 */
function homeFurnishState() {
  if (currentLocationId !== 'home' || !game?.player) return null;
  return {
    active: Boolean(furnish),
    uid: furnish?.uid || null,
    moving: furnish ? (homeItem(furnish.itemId)?.label || furnish.itemId) : '',
    hint: furnish
      ? 'arrows move · R rotates · C recolours · Enter places · Esc cancels'
      : 'pick a piece to move, or tap one in the room',
    items: activeHomeItems().map(record => {
      const item = homeItem(record.itemId);
      return {
        uid: record.uid,
        itemId: record.itemId,
        label: item?.label || record.itemId,
        icon: item?.icon || '•',
        zone: item?.zone || '',
        note: `${variantLabel(item, record.variant)} · ${homeItemTierInfo(record.itemId, record.tier).name} · x${record.x} y${record.y}${record.on ? ' · on' : ''}`
      };
    }),
    unplaced: activeHomeStorage().map((entry, index) => {
      const item = homeItem(entry.itemId);
      return {
        key: `storage:${index}`,
        itemId: entry.itemId,
        label: item?.label || entry.itemId,
        icon: item?.icon || '•',
        note: `in storage · ${variantLabel(item, entry.variant)} · pick to place`
      };
    })
  };
}

/** Validate the current draft against walls, furniture, the player, and the door path. */
function validateFurnish() {
  if (!furnish || !game?.player) return null;
  const homeDef = locationDef('home');
  const placement = canPlaceHomeItem({
    items: activeHomeItems(),
    itemId: furnish.itemId,
    x: furnish.draft.x,
    y: furnish.draft.y,
    rot: furnish.draft.rot,
    roomTiles: game.homeRoomTiles || [],
    house: homeDef?.house,
    door: homeDef?.door,
    terrain: game.terrain,
    uid: furnish.uid,
    player: game.player
  });
  furnish.reason = placement.ok ? null : placement.reason;
  if (game.homeDraft) {
    game.homeDraft = {
      ...game.homeDraft,
      ...furnish.draft,
      reason: furnish.reason
    };
  }
  refreshFurnishHud();
  return placement;
}

/** Small screen-space banner while a piece is being moved. */
function refreshFurnishHud() {
  const hud = $('furnish-hud');
  if (!hud) return;
  hud.hidden = !furnish;
  if (!furnish) return;
  const item = homeItem(furnish.itemId);
  const title = $('furnish-title');
  if (title) title.textContent = `moving ${item?.label || furnish.itemId}`;
  const note = $('furnish-note');
  if (note) {
    note.textContent = furnish.reason
      ? `cannot place: ${homeItemReasonText(furnish.reason)}`
      : `${variantLabel(item, furnish.draft.variant)} · x${furnish.draft.x} y${furnish.draft.y} · tap a spot to move it`;
  }
  const place = $('furnish-place');
  if (place) place.disabled = Boolean(furnish.reason);
}

/** Leave Furnish mode, restoring normal clicks. The record was never touched. */
function endFurnish() {
  if (!furnish) return false;
  furnish = null;
  if (game) game.homeDraft = null;
  refreshFurnishHud();
  panels?.renderInventory?.();
  return true;
}

function cancelFurnish({ silent = false } = {}) {
  if (!furnish) return false;
  const label = homeItem(furnish.itemId)?.label || furnish.itemId;
  endFurnish();
  if (!silent) showToast(`Left the ${label} where it was.`);
  return true;
}

/** Enter Furnish with a placed piece selected (card Move, or the Backpack list). */
function startFurnish(target) {
  if (currentLocationId !== 'home' || !game?.player) return false;
  if (typeof target === 'string' && target.startsWith('storage:')) {
    return startStoredFurnish(Number(target.slice('storage:'.length)));
  }
  const record = typeof target === 'string' ? homeItemRecord(target) : target;
  const item = record ? homeItem(record.itemId) : null;
  if (!record?.uid || !item) return false;
  closeHomeItemCard();
  panels?.closeAllPanels();
  wakeHomePose({ silent: true });

  furnish = {
    uid: record.uid,
    itemId: record.itemId,
    storageIndex: null,
    draft: {
      x: record.x,
      y: record.y,
      rot: record.rot,
      variant: record.variant,
      tier: record.tier || 0,
      on: record.on === true
    },
    reason: null
  };
  game.homeDraft = { ...furnish.draft, uid: furnish.uid, itemId: furnish.itemId, reason: null };
  game.player.path = [];
  game.destination = null;
  game.heldKeys = [];
  validateFurnish();
  panels?.renderInventory?.();
  showToast(`Moving the ${item.label}. Arrows move, R rotates, C recolours, Enter places.`);
  return true;
}

/**
 * Place a bought piece that has no position yet: find the first valid room
 * tile, then run the same draft flow. Placing consumes its storage slot.
 */
function startStoredFurnish(index) {
  if (currentLocationId !== 'home' || !game?.player) return false;
  const entry = activeHomeStorage()[index] || null;
  const item = entry ? homeItem(entry.itemId) : null;
  if (!entry || !item) return false;
  const homeDef = locationDef('home');
  const spot = findHomePlacementTile({
    items: activeHomeItems(),
    itemId: entry.itemId,
    roomTiles: game.homeRoomTiles || [],
    house: homeDef?.house,
    door: homeDef?.door,
    terrain: game.terrain,
    player: game.player
  });
  if (!spot) {
    showToast(`There is no room for the ${item.label} right now.`);
    return false;
  }
  closeHomeItemCard();
  panels?.closeAllPanels();
  wakeHomePose({ silent: true });

  furnish = {
    uid: nextHomeUid(activeHomeItems(), entry.itemId),
    itemId: entry.itemId,
    storageIndex: index,
    draft: {
      x: spot.x,
      y: spot.y,
      rot: 0,
      variant: entry.variant,
      tier: 0,
      on: false
    },
    reason: null
  };
  game.homeDraft = { ...furnish.draft, uid: furnish.uid, itemId: furnish.itemId, reason: null };
  game.player.path = [];
  game.destination = null;
  game.heldKeys = [];
  validateFurnish();
  panels?.renderInventory?.();
  showToast(`Placing the ${item.label}. Arrows move, R rotates, C recolours, Enter places.`);
  return true;
}

function moveFurnishBy(dx, dy) {
  if (!furnish) return false;
  furnish.draft = {
    ...furnish.draft,
    x: furnish.draft.x + dx,
    y: furnish.draft.y + dy
  };
  validateFurnish();
  return true;
}

/** A tap places the footprint's centre under the tapped tile. */
function moveFurnishTo(tileX, tileY) {
  if (!furnish) return false;
  const size = homeItemSize(furnish.itemId, furnish.draft.rot);
  if (!size) return false;
  furnish.draft = {
    ...furnish.draft,
    x: Math.round(tileX) - Math.floor((size.w - 1) / 2),
    y: Math.round(tileY) - Math.floor((size.h - 1) / 2)
  };
  validateFurnish();
  return true;
}

function rotateFurnish() {
  if (!furnish) return false;
  furnish.draft = { ...furnish.draft, rot: (furnish.draft.rot + 1) % 4 };
  validateFurnish();
  return true;
}

function cycleFurnishVariant() {
  if (!furnish) return false;
  const item = homeItem(furnish.itemId);
  const count = Array.isArray(item?.variants) ? item.variants.length : 0;
  if (!count) return false;
  furnish.draft = { ...furnish.draft, variant: (furnish.draft.variant + 1) % count };
  if (game.homeDraft) game.homeDraft = { ...game.homeDraft, ...furnish.draft };
  refreshFurnishHud();
  return true;
}

function placeFurnish() {
  if (!furnish) return false;
  const placement = validateFurnish();
  if (!placement?.ok) {
    showToast(`Cannot place there: ${homeItemReasonText(furnish.reason)}`);
    return false;
  }
  const label = homeItem(furnish.itemId)?.label || furnish.itemId;
  const draft = furnish.draft;
  let nextItems;
  if (furnish.storageIndex != null) {
    const consumed = consumeHomeStorage(activeHomeStorage(), furnish.storageIndex);
    if (!consumed.ok) {
      showToast('That piece is no longer in storage.');
      endFurnish();
      return false;
    }
    applyHomeStorage(consumed.storage);
    nextItems = [
      ...activeHomeItems(),
      {
        uid: furnish.uid,
        itemId: furnish.itemId,
        x: draft.x,
        y: draft.y,
        rot: draft.rot,
        variant: draft.variant,
        tier: 0,
        on: false
      }
    ];
  } else {
    nextItems = activeHomeItems().map(record => (
      record.uid === furnish.uid
        ? { ...record, x: draft.x, y: draft.y, rot: draft.rot, variant: draft.variant }
        : record
    ));
  }
  applyHomeItems(nextItems, { standBuddies: true });
  endFurnish();
  sounds.play('place');
  saveNow();
  completeGoalEvent('home.furnish');
  showToast(`Placed the ${label}.`);
  return true;
}

// --- Home item card -------------------------------------------------------

function homeItemCardRecord() {
  return homeItemCard ? homeItemRecord(homeItemCard.uid) : null;
}

function cardStatusText(record, use) {
  if (!record || !use) return '';
  if (use.kind === 'toggle') return record.on === true ? 'on' : 'off';
  if (use.kind === 'recipe') {
    const need = Number(use.recipe?.inputs?.apple) || 0;
    const have = Number(game?.forage?.basket?.apple) || 0;
    return `needs ${need} apples · basket has ${have}`;
  }
  return '';
}

/** Anchor the card beside the item's footprint, clamped away from HUD and touch pad. */
function positionHomeItemCard() {
  const card = $('home-item-card');
  const record = homeItemCardRecord();
  if (!card || !record || !game?.camera) return;
  if (card.hidden) return;
  const size = homeItemSize(record.itemId, record.rot);
  if (!size) return;
  const left = record.x * TILE - game.camera.x;
  const top = record.y * TILE - game.camera.y;
  const width = size.w * TILE;
  const height = size.h * TILE;
  const viewWidth = window.innerWidth;
  const viewHeight = window.innerHeight;
  const cardWidth = card.offsetWidth || 208;
  const cardHeight = card.offsetHeight || 120;
  const margin = 8;
  const lotTop = 64;
  const coarse = window.matchMedia?.('(pointer: coarse)').matches || viewWidth <= 768;
  const bottomInset = coarse ? 196 : 12;
  let cardTop = top - cardHeight - 10;
  if (cardTop < lotTop) cardTop = top + height + 10;
  const cardLeft = Math.max(
    margin,
    Math.min(left + width / 2 - cardWidth / 2, viewWidth - cardWidth - margin)
  );
  cardTop = Math.max(lotTop, Math.min(cardTop, viewHeight - cardHeight - bottomInset));
  card.style.left = `${Math.round(cardLeft)}px`;
  card.style.top = `${Math.round(cardTop)}px`;
}

function openHomeItemCard(record) {
  if (!record?.uid || currentLocationId !== 'home' || furnish) return false;
  const item = homeItem(record.itemId);
  const use = homeItemUse(record.itemId);
  if (!item || !use) return false;
  panels?.closeAllPanels();
  if (game.player?.path?.length) game.player.path = [];
  game.destination = null;

  homeItemCard = { uid: record.uid, itemId: record.itemId };
  syncHomeItemCard();
  const card = $('home-item-card');
  card.hidden = false;
  positionHomeItemCard();
  $('home-item-use')?.focus?.({ preventScroll: true });
  return true;
}

/** Fill the card from the live record: title, tier badge, use, and upgrade. */
function syncHomeItemCard() {
  const record = homeItemCardRecord();
  if (!record) return false;
  const item = homeItem(record.itemId);
  const use = homeItemUse(record.itemId);
  if (!item || !use) return false;

  $('home-item-icon').textContent = item.icon || '•';
  $('home-item-name').textContent = item.label || record.itemId;
  $('home-item-use').textContent = use.verb;

  const info = homeItemTierInfo(record.itemId, record.tier);
  const tier = $('home-item-tier');
  if (tier) {
    tier.textContent = info.name;
    tier.hidden = info.index === 0;
  }
  const upgrade = $('home-item-upgrade');
  if (upgrade) {
    if (info.next) {
      upgrade.hidden = false;
      upgrade.textContent = `Upgrade · ${info.next.name} · ${info.next.price}🪙`;
      upgrade.setAttribute('aria-label', `Upgrade to ${info.next.name} for ${info.next.price} coins`);
    } else {
      upgrade.hidden = true;
    }
  }

  const status = $('home-item-status');
  if (status) {
    const statusText = cardStatusText(record, use);
    status.textContent = statusText;
    status.hidden = !statusText;
  }
  return true;
}

/** One click: pay the next tier's price, bump the record, and refresh in place. */
function upgradeHomeItemCard() {
  const record = homeItemCardRecord();
  if (!record) {
    closeHomeItemCard();
    return false;
  }
  const result = upgradeHomeItem(activeHomeItems(), record.uid, game?.player?.coins);
  if (!result.ok) {
    if (result.reason === 'insufficient') {
      showToast(`need ${result.short} more 🪙 for the ${result.tier.next.name} trim.`);
    } else if (result.reason === 'max-tier') {
      showToast('that piece is already deluxe.');
    }
    return false;
  }
  game.player.coins = result.coins;
  applyHomeItems(result.items);
  sounds.play('place');
  saveNow();
  completeGoalEvent('home.upgrade');
  syncHomeItemCard();
  const label = homeItem(record.itemId)?.label || record.itemId;
  showToast(`the ${label} is now ${result.tier.name}.`);
  return true;
}

function closeHomeItemCard() {
  if (!homeItemCard) return false;
  homeItemCard = null;
  const card = $('home-item-card');
  if (card) card.hidden = true;
  return true;
}

// --- Library lessons -------------------------------------------------------

function isLibrarian(character) {
  if (!character) return false;
  if (character.role === 'librarian') return true;
  // The character record is rebuilt on arrival, so the data role is the backstop.
  const def = locationDef(currentLocationId);
  return (Array.isArray(def?.residents) ? def.residents : [])
    .some(resident => resident?.id === character.id && resident.role === 'librarian');
}

/** The librarian's greeting: one line, then a lesson or a friendly no. */
function openLibrarianBeat(librarian) {
  if (!librarian) return false;
  closeHomeItemCard();
  setVoiceVolumeOpen(false);
  dismissNpcWatchPrompt();
  panels?.closeAllPanels();
  game?.select?.(librarian.id);
  behaviorRuntime?.setDialogue(true);
  sounds.play('ui-click');
  showDialogueBeat(librarian, 'Welcome to the library. Want a lesson?', [
    {
      label: 'Start lesson',
      className: 'primary',
      onClick: () => startLesson(librarian)
    },
    {
      label: 'Not now',
      className: 'pill quiet',
      onClick: () => dialogue.close()
    }
  ]);
  return true;
}

function startLesson(librarian) {
  const questions = drawLessonQuestions(LESSONS_DATA);
  if (!questions.length) {
    dialogue.close();
    showToast('the library is still shelving its questions.');
    return;
  }
  lessonSession = {
    npc: librarian,
    questions,
    index: 0,
    answers: [],
    awarded: false,
    result: null
  };
  sounds.play('ui-click');
  showLessonQuestion();
}

function showLessonQuestion() {
  const session = lessonSession;
  if (!session) return;
  const question = session.questions[session.index];
  if (!question) return;
  const topic = lessonTopicLabel(LESSONS_DATA, question.topic);
  showDialogueBeat(
    session.npc,
    `${topic} · question ${session.index + 1} of ${session.questions.length}. ${question.prompt}`,
    question.choices.map((choice, index) => ({
      label: choice,
      className: 'pill',
      onClick: () => answerLessonQuestion(index)
    }))
  );
}

function answerLessonQuestion(choiceIndex) {
  const session = lessonSession;
  if (!session || session.result) return;
  const question = session.questions[session.index];
  if (!question) return;
  session.answers[session.index] = choiceIndex;
  const correct = choiceIndex === question.answer;
  if (correct) sounds.play('pickup');
  const last = session.index >= session.questions.length - 1;
  const feedback = correct
    ? 'yes!'
    : `not quite — the answer is "${question.choices[question.answer]}".`;
  showDialogueBeat(session.npc, `${feedback} ${question.explanation}`, [
    {
      label: last ? 'See results' : 'Next',
      className: 'primary',
      onClick: () => {
        if (last) {
          finishLesson();
          return;
        }
        session.index += 1;
        showLessonQuestion();
      }
    }
  ]);
}

/**
 * Pay the lesson exactly once, then show the score. The session keeps the
 * result, so a double activation cannot award coins twice; the goal event is
 * idempotent on its own.
 */
function finishLesson() {
  const session = lessonSession;
  if (!session) return;
  if (session.result) {
    showLessonResult(session);
    return;
  }
  const result = gradeLesson(session.questions, session.answers);
  session.result = result;
  const award = lessonCoinAward({ coins: result.coins, awarded: session.awarded });
  if (award > 0) {
    session.awarded = true;
    game.player.coins = Math.max(0, Math.floor(Number(game.player.coins) || 0)) + award;
    saveNow();
    sounds.play('pickup');
  }
  completeGoalEvent('lesson.completed');
  showLessonResult(session);
}

function showLessonResult(session) {
  const result = session.result;
  if (!result) return;
  const perfect = result.perfect ? ' perfect score!' : '';
  const coins = result.coins > 0 ? ` +${result.coins}🪙` : '';
  showDialogueBeat(
    session.npc,
    `you got ${result.correct} of ${result.total}.${perfect}${coins}`,
    [
      {
        label: 'Done',
        className: 'primary',
        onClick: () => dialogue.close()
      }
    ]
  );
}

// --- Shop ------------------------------------------------------------------

function isShopkeeper(character) {
  return Boolean(character) && (
    character.shopkeeper === true
    || (currentLocationId === 'shop' && character.id === SHOPKEEPER_ID)
  );
}

/** The keeper's short beat: one line, then Browse or Leave. */
function openShopBeat(keeper) {
  if (!keeper) return false;
  closeHomeItemCard();
  setVoiceVolumeOpen(false);
  dismissNpcWatchPrompt();
  panels?.closeAllPanels();
  game?.select?.(keeper.id);
  behaviorRuntime?.setDialogue(true);
  sounds.play('ui-click');
  const greeting = locationDef('shop')?.shopkeeper?.greeting || 'Welcome in.';
  showDialogueBeat(keeper, greeting, [
    {
      label: 'Browse',
      className: 'primary',
      onClick: () => {
        dialogue.close();
        openShopPanel();
      }
    },
    {
      label: 'Leave',
      className: 'pill quiet',
      onClick: () => dialogue.close()
    }
  ]);
  return true;
}

function shopPanelOpen() {
  return Boolean($('shop-panel') && !$('shop-panel').hidden);
}

/** Open the compact catalog. Play pauses until the panel is closed. */
function openShopPanel() {
  if (!game?.player) return false;
  closeHomeItemCard();
  panels?.closeAllPanels();
  if (game.player.path) game.player.path = [];
  game.destination = null;
  game.heldKeys = [];
  game.paused = true;
  game.interactive = false;
  const result = $('shop-result');
  if (result) {
    result.hidden = true;
    result.textContent = '';
  }
  renderShopPanel();
  const panel = $('shop-panel');
  if (panel) panel.hidden = false;
  $('shop-close')?.focus?.({ preventScroll: true });
  return true;
}

function closeShopPanel({ silent = false } = {}) {
  const panel = $('shop-panel');
  if (!panel || panel.hidden) return false;
  panel.hidden = true;
  const result = $('shop-result');
  if (result) {
    result.hidden = true;
    result.textContent = '';
  }
  if (game) {
    game.paused = false;
    game.interactive = true;
  }
  if (!silent) sounds.play('ui-click');
  return true;
}

/** Coins, title, and one row per stock item. */
function renderShopPanel() {
  const list = $('shop-list');
  if (!list) return;
  const balance = Number(game?.player?.coins) || 0;
  const balanceEl = $('shop-balance');
  if (balanceEl) balanceEl.textContent = `${Math.max(0, Math.round(balance))} 🪙`;
  const title = $('shop-title');
  if (title) title.textContent = HOME_SHOP.title || 'Shop';
  const note = $('shop-note');
  if (note) note.textContent = HOME_SHOP.note || 'a few nice things for the house.';

  list.replaceChildren();
  for (const entry of shopStock()) {
    const row = document.createElement('div');
    row.className = 'shop-row';
    row.setAttribute('role', 'listitem');

    const icon = document.createElement('span');
    icon.className = 'shop-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = entry.icon;

    const copy = document.createElement('div');
    copy.className = 'shop-copy';
    const name = document.createElement('strong');
    name.textContent = entry.label;
    const price = document.createElement('small');
    price.textContent = `${entry.price} coins`;
    copy.append(name, price);

    const buy = document.createElement('button');
    buy.type = 'button';
    buy.className = 'pill primary shop-buy';
    buy.textContent = `Buy · ${entry.price}🪙`;
    buy.setAttribute('aria-label', `Buy the ${entry.label} for ${entry.price} coins`);
    buy.addEventListener('click', () => buyShopItemNow(entry.itemId));

    row.append(icon, copy, buy);
    list.append(row);
  }
}

/** One click: pay, add to unplaced storage, refresh, and say what happened. */
function buyShopItemNow(itemId) {
  if (!game?.player) return false;
  const result = buyShopItem(itemId, {
    coins: game.player.coins,
    storage: activeHomeStorage()
  });
  const out = $('shop-result');
  const say = text => {
    if (!out) return;
    out.textContent = text;
    out.hidden = false;
  };

  if (!result.ok) {
    if (result.reason === 'insufficient') {
      say(`need ${result.short} more 🪙 for the ${result.entry?.label || 'piece'}.`);
    } else {
      say('that piece is not on the shelf.');
    }
    return false;
  }

  game.player.coins = result.coins;
  applyHomeStorage(result.storage);
  persistHomeStorage();
  sounds.play('pickup');
  saveNow();
  completeGoalEvent('shop.buy');
  renderShopPanel();
  say(`bought the ${result.entry.label}. it is waiting in furnish.`);
  return true;
}

function recipeShortText(status) {
  const parts = (status?.missing || []).map(entry => {
    const name = entry.id === 'apple' ? 'apples' : `${entry.id}s`;
    return `${entry.need} ${name} (you have ${entry.have})`;
  });
  return `the recipe needs ${parts.join(' and ') || 'more ingredients'}.`;
}

/** Primary card action, dispatched by the data-driven `use.kind`. */
function useHomeItem() {
  const record = homeItemCardRecord();
  if (!record) {
    closeHomeItemCard();
    return false;
  }
  const item = homeItem(record.itemId);
  const use = homeItemUse(record.itemId);
  const label = item?.label || record.itemId;

  if (use?.kind === 'sit' || use?.kind === 'sleep') {
    // Using the same piece again stands the player up or wakes them.
    if (game.player?.homePose?.uid === record.uid) {
      wakeHomePose();
      closeHomeItemCard();
      return true;
    }
    if (!game.setHomePose?.(use.kind, record.uid)) return false;
    closeHomeItemCard();
    showToast(use.line || (use.kind === 'sleep' ? `you curl up on the ${label}.` : `you sit on the ${label}.`));
    return true;
  }

  if (use?.kind === 'recipe') {
    const result = consumeRecipe(game.forage?.basket, use.recipe);
    if (!result.ok) {
      showToast(recipeShortText(result));
      return false;
    }
    if (game.forage) game.forage.basket = result.basket;
    const baked = result.output ? createItemInstance(result.output) : null;
    if (baked) {
      if (!Array.isArray(game.player.inventory)) game.player.inventory = [];
      game.player.inventory.push(baked);
    }
    sounds.play('pickup');
    closeHomeItemCard();
    panels?.renderInventory?.();
    saveNow();
    showToast(`Baked an apple pie. ${result.basket.apple} apples left in the basket.`);
    return true;
  }

  if (use?.kind === 'toggle') {
    const result = toggleHomeItem(activeHomeItems(), record.uid);
    if (!result.record) return false;
    applyHomeItems(result.items);
    if (result.on && use.cue) sounds.play(use.cue);
    saveNow();
    showToast(result.on
      ? (use.onLine || `the ${label} turns on.`)
      : (use.offLine || `the ${label} turns off.`));
    // Keep the card open so on/off can be checked without reopening it.
    syncHomeItemCard();
    return true;
  }

  showToast(use?.line || `the ${label} is quiet.`);
  closeHomeItemCard();
  return false;
}

/** Stand up or wake; movement, Escape, and Use all land here. */
function wakeHomePose({ silent = false } = {}) {
  const pose = game?.player?.homePose;
  if (!pose) return false;
  game.clearHomePose?.();
  if (!silent) showToast(pose.kind === 'sleep' ? 'you wake up.' : 'you stand up.');
  return true;
}

/** Canvas click on a Home item: open its card. Null means "clicked the floor". */
function handleHomeItemClick(record) {
  if (currentLocationId !== 'home' || furnish) return false;
  if (!record) {
    closeHomeItemCard();
    return false;
  }
  return openHomeItemCard(record);
}

/**
 * Furnish owns canvas clicks while it is on: pick another piece, or drop the
 * draft under the tapped tile. Returning true stops Game's normal walk/select.
 */
function handleHomeCanvasPointer(event, point) {
  if (!furnish || !game) return false;
  if (event?.target && event.target !== game.canvas) return false;
  const record = homeItemAtTop(activeHomeItems(), point.tileX, point.tileY);
  if (record && record.uid !== furnish.uid) {
    startFurnish(record);
    return true;
  }
  if (record && record.uid === furnish.uid) return true;
  moveFurnishTo(point.tileX, point.tileY);
  return true;
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
  if (npcWatchPrompt?.timer) clearTimeout(npcWatchPrompt.timer);
  npcWatchPrompt = null;
  const prompt = $('spectate-prompt');
  if (prompt) prompt.hidden = true;
}

function isNpcOnlySession(session) {
  if (!session || !Array.isArray(session.seats) || !session.seats.length) return false;
  return session.seats.every(seat => seat?.character && seat.character !== game?.player);
}

/** Board centre in tiles, from the session placement or its seats. */
function sessionBoardCenter(session) {
  const board = session?.game?.legacy?.activeBoard || null;
  const meta = session?.meta?.board || {};
  const originX = session?.placement?.originX ?? board?.originX;
  const originY = session?.placement?.originY ?? board?.originY;
  if (Number.isFinite(originX) && Number.isFinite(originY)) {
    const width = Number.isFinite(Number(meta.width)) ? Number(meta.width) : 3;
    const height = Number.isFinite(Number(meta.height)) ? Number(meta.height) : 3;
    return { x: originX + (width - 1) / 2, y: originY + (height - 1) / 2 };
  }
  const seats = (session?.seats || []).map(seat => seat?.character).filter(Boolean);
  if (!seats.length) return null;
  return {
    x: seats.reduce((sum, actor) => sum + actor.x, 0) / seats.length,
    y: seats.reduce((sum, actor) => sum + actor.y, 0) / seats.length
  };
}

/** Manhattan distance in tiles from the player to an NPC board, or Infinity. */
function playerBoardDistance(session) {
  const player = game?.player;
  const center = sessionBoardCenter(session);
  if (!player || !center) return Infinity;
  return Math.abs(player.x - center.x) + Math.abs(player.y - center.y);
}

function watchNpcSession() {
  const prompt = npcWatchPrompt;
  const session = prompt?.session || host?.session || null;
  dismissNpcWatchPrompt();
  if (!session) return;
  spectatingSession = session;
  walkPlayerToSpectate(session);
  showToast('Watching the game.');
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
  // Only offer to watch when the board is actually in view. A game across the
  // park must not pull the camera or interrupt the player.
  if (playerBoardDistance(activeSession) > 8) return;

  const actor = resolveCharacter(detail.actorId) || activeSession.seats[0]?.character || null;
  const partner = resolveCharacter(detail.partnerId) || activeSession.seats[1]?.character || null;
  const gameId = detail.game || activeSession.meta?.id || 'tic-tac-toe';
  const gameName = host?.getMeta?.(gameId)?.title
    || miniGamesData.miniGames?.[gameId]?.title
    || 'a mini-game';
  const social = dialogueData.social || {};
  const template = social.npcGamePrompt
    || '{a} and {b} are about to play {game}. Want to watch?';
  const text = template
    .replaceAll('{a}', actor?.name || 'A neighbour')
    .replaceAll('{b}', partner?.name || 'another neighbour')
    .replaceAll('{game}', gameName);

  const prompt = { token: {}, session: activeSession, timer: null };
  npcWatchPrompt = prompt;

  const hostEl = $('spectate-prompt');
  const textEl = $('spectate-text');
  if (!hostEl || !textEl) return;
  textEl.textContent = text;
  hostEl.hidden = false;

  prompt.timer = window.setTimeout(() => {
    if (npcWatchPrompt?.token === prompt.token) dismissNpcWatchPrompt();
  }, 6000);
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
  $('spectate-watch')?.addEventListener('click', watchNpcSession);
  $('spectate-dismiss')?.addEventListener('click', dismissNpcWatchPrompt);

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

  // Home item card. The card closes on click-away and Escape; the canvas owns
  // its own click resolution so another item can replace the card in one tap.
  $('home-item-use')?.addEventListener('click', useHomeItem);
  $('home-item-move')?.addEventListener('click', () => {
    const record = homeItemCardRecord();
    if (record) startFurnish(record);
  });
  $('home-item-close')?.addEventListener('click', () => closeHomeItemCard());
  $('home-item-upgrade')?.addEventListener('click', upgradeHomeItemCard);
  $('shop-close')?.addEventListener('click', () => closeShopPanel());
  document.addEventListener('pointerdown', event => {
    if (!homeItemCard) return;
    const card = $('home-item-card');
    if (!card || card.hidden || card.contains(event.target)) return;
    if (game?.canvas?.contains(event.target)) return;
    closeHomeItemCard();
  });

  // Furnish HUD buttons mirror the keyboard hints for mouse and touch users.
  $('furnish-rotate')?.addEventListener('click', rotateFurnish);
  $('furnish-variant')?.addEventListener('click', cycleFurnishVariant);
  $('furnish-place')?.addEventListener('click', placeFurnish);
  $('furnish-cancel')?.addEventListener('click', () => cancelFurnish());

  // Furnish owns the keyboard while it is on. Capture phase beats the canvas
  // movement handler and the app's other global shortcuts.
  window.addEventListener('keydown', event => {
    if (!furnish) return;
    if (event.target instanceof HTMLElement
      && event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
    if (event.target instanceof HTMLElement
      && event.target.closest('button')
      && (event.key === 'Enter' || event.key === ' ')) return;
    const key = event.key;
    const lower = key.toLowerCase();
    let handled = true;
    if (key === 'Escape') cancelFurnish();
    else if (key === 'Enter' || key === ' ') placeFurnish();
    else if (lower === 'r') rotateFurnish();
    else if (lower === 'c') cycleFurnishVariant();
    else if (key === 'ArrowUp' || lower === 'w') moveFurnishBy(0, -1);
    else if (key === 'ArrowDown' || lower === 's') moveFurnishBy(0, 1);
    else if (key === 'ArrowLeft' || lower === 'a') moveFurnishBy(-1, 0);
    else if (key === 'ArrowRight' || lower === 'd') moveFurnishBy(1, 0);
    else handled = false;
    if (!handled) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  window.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    if (furnish) {
      event.preventDefault();
      cancelFurnish();
      return;
    }
    if (homeItemCard) {
      event.preventDefault();
      closeHomeItemCard();
      return;
    }
    if (shopPanelOpen()) {
      event.preventDefault();
      closeShopPanel();
      return;
    }
    if (game?.player?.homePose) {
      event.preventDefault();
      wakeHomePose();
    }
  });

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
    const action = activityActionForKey(key);

    const start = e => {
      e.preventDefault();
      if (isDown) return;
      isDown = true;
      btn.setPointerCapture?.(e.pointerId);
      // A full-view activity reads held state directly; Park movement keeps
      // the synthetic key events it has always used.
      if (setActivityHold(action, true)) return;
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
      if (setActivityHold(action, false)) return;
      simulateKey(key, 'keyup');
    };

    btn.addEventListener('pointerdown', start);
    btn.addEventListener('pointerup', stop);
    btn.addEventListener('pointercancel', stop);
    btn.addEventListener('lostpointercapture', stop);
    btn.addEventListener('contextmenu', e => e.preventDefault());
  };

  bindTouchButton('touch-up', 'ArrowUp');
  bindTouchButton('touch-down', 'ArrowDown');
  bindTouchButton('touch-left', 'ArrowLeft');
  bindTouchButton('touch-right', 'ArrowRight');
  bindTouchButton('touch-enter', 'Enter');
  bindTouchButton('touch-esc', 'Escape');

  // Full-view activity input. Real keys feed the same held booleans as the
  // touch pad, so there is exactly one control scheme.
  window.addEventListener('keydown', event => {
    if (!activityAcceptsInput()) return;
    if (event.target instanceof HTMLElement
      && event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
    if (event.key.toLowerCase() === 'r') {
      event.preventDefault();
      host.handleInput({ type: 'restart' });
      clearActivityHolds();
      updateActivityHud(true);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      packUpActivity();
      return;
    }
    const action = activityActionForKey(event.key);
    if (!action) return;
    event.preventDefault();
    setActivityHold(action, true);
  });

  window.addEventListener('keyup', event => {
    if (!isActivitySession()) return;
    const action = activityActionForKey(event.key);
    if (!action) return;
    event.preventDefault();
    setActivityHold(action, false);
  });
  window.addEventListener('blur', () => {
    if (isActivitySession()) clearActivityHolds();
  });

  $('activity-restart')?.addEventListener('click', event => {
    event.currentTarget.blur();
    if (!isActivitySession()) return;
    host.handleInput({ type: 'restart' });
    clearActivityHolds();
    updateActivityHud(true);
  });

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
    getGoals: () => goalProgress,
    onThrowBall,
    onEatItem: eatBagItem,
    onPlayGame,
    onTalkNpc: openCardDialogue,
    getBoardGames: npc => tableGamesFor(npc),
    onTrade: applyNpcTrade,
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
    getTravel: () => {
      const target = travelTargets(currentLocationId)[0] || null;
      return target ? { id: target.id, label: target.label, note: target.note } : null;
    },
    getTravels: () => travelTargets(currentLocationId)
      .map(target => ({
        id: target.id,
        label: target.label,
        note: target.note,
        icon: target.id === 'shop' ? '🛍️' : (target.id === 'home' ? '🏠' : '🚪'),
        group: target.nearby ? 'Nearby' : 'All destinations'
      })),
    onTravel: targetId => {
      panels?.closeMenu();
      return travelTo(targetId);
    },
    onOpenCourses: () => {
      panels?.closeMenu();
      return openActivityChooser();
    },
    getFurnish: homeFurnishState,
    onFurnishSelect: uid => startFurnish(uid),
    onFurnishStop: () => cancelFurnish(),
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
    showToast(`Welcome back to the ${locationLabel(currentLocationId).toLowerCase()}.`);
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
