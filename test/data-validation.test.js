import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ACTION_NAMES, actions } from '../src/behavior/actions.js';
import { SOCIAL_ACTION_NAMES, socialActions } from '../src/behavior/actions/social.js';
import { SELECTOR_NAMES } from '../src/behavior/selectors.js';
import { assertPredicate } from '../src/behavior/predicates.js';
import { validateConfig } from '../src/behavior/config.js';
import { validateMeta, INPUT_MODES, RENDER_LAYERS } from '../src/minigames/contract.js';
import { REJECT_REASONS } from '../src/minigames/strip.js';
import { EFFECT_MOTIONS, EFFECT_SLOTS } from '../src/effects.js';
import { TRADE_REJECT_REASONS, TRADE_TEMPLATES, validateOffer } from '../src/trade.js';

function readJson(name) {
  return JSON.parse(readFileSync(new URL(`../data/${name}`, import.meta.url), 'utf8'));
}

const items = readJson('items.json');
const effects = readJson('effects.json');
const minigames = readJson('minigames.json');
const activities = readJson('activities.json');
const world = readJson('world.json');
const engineConfig = readJson('engine_config.json');
const rewards = readJson('rewards.json');
const dialogues = readJson('dialogues.json');
const behaviors = readJson('behaviors.json');
const snakesLadders = readJson('snakes-ladders.json');
const voicePolicy = readJson('voice.json');
const voiceBank = readJson('voice_bank.json');
const voicePools = readJson('voice_pools.json');

const catalog = items.catalog;
const catalogIds = new Set(Object.keys(catalog));

// Selector params are intentionally plain. This table mirrors selectors.js so a
// typo in data/behaviors.json fails here instead of silently selecting nothing.
const SELECTOR_PARAM_KEYS = {
  nearest: new Set([
    'kind', 'maxDistance', 'radius', 'minPlayerDistance', 'notFriends', 'friendsOnly',
    'requireFriend', 'minGreets', 'minActivities', 'excludeIds', 'maxFriendCount'
  ]),
  byId: new Set(['id', 'actorId', 'targetId']),
  mutualFriend: new Set(['kind', 'maxDistance', 'radius', 'minPlayerDistance']),
  buddy: new Set(['kind', 'maxDistance']),
  midpoint: new Set(['a', 'b', 'with', 'targetId', 'open'])
};

test('every effect item resolves to an effects.json entry, slot, and compatible owner', () => {
  const effectItems = Object.values(catalog).filter(item => item.kind === 'effect');
  assert.equal(effectItems.length, 11, 'the catalog should contain eleven effect items');

  for (const item of effectItems) {
    const effectId = item.effect;
    assert.equal(typeof effectId, 'string', `${item.id} needs an effect id`);
    const effect = effects.effects[effectId];
    assert.ok(effect, `${item.id} points at missing effect ${effectId}`);
    assert.equal(effect.id, effectId, `${item.id} effect id mismatch`);
    assert.equal(effect.itemId, item.id, `${item.id} effect must point back to the item`);

    assert.ok(EFFECT_SLOTS[item.slot], `${item.id} uses unknown slot ${item.slot}`);
    assert.equal(effect.slot, item.slot, `${item.id} slot differs from effects.json`);

    assert.ok(Array.isArray(item.owners) && item.owners.length > 0, `${item.id} needs owners`);
    for (const owner of item.owners) {
      assert.ok(['player', 'npc', 'companion'].includes(owner), `${item.id} has invalid owner ${owner}`);
    }
    assert.ok(item.owners.includes('player'), `${item.id} must be player-ownable`);
    if (effect.target === 'party' || effect.target === 'buddy') {
      assert.ok(item.owners.includes('player'), `${item.id} party effect needs a player owner`);
    }
  }
});

test('every effects.json itemId exists and points back to the same effect', () => {
  for (const effect of Object.values(effects.effects)) {
    const item = catalog[effect.itemId];
    assert.ok(item, `effect ${effect.id} references missing item ${effect.itemId}`);
    assert.equal(item.kind, 'effect', `${effect.itemId} should be kind=effect`);
    assert.equal(item.effect, effect.id, `${effect.itemId} should point back at ${effect.id}`);
    assert.equal(item.slot, effect.slot, `${effect.itemId} slot differs from effect ${effect.id}`);
  }
});

test('every full-view activity resolves its definition and every entrance names one', () => {
  const defined = activities.activities || {};
  const fullview = Object.values(minigames.miniGames).filter(meta => meta.render?.mode === 'fullview');
  assert.ok(fullview.length >= 1, 'the jungle gym should be the first full-view activity');

  for (const meta of fullview) {
    assert.equal(typeof meta.activityId, 'string', `${meta.id} needs an activityId`);
    const definition = defined[meta.activityId];
    assert.ok(definition, `${meta.id} activityId ${meta.activityId} does not resolve`);
    assert.equal(definition.id, meta.activityId);
    assert.equal(definition.title, meta.title);
    assert.equal(typeof definition.enabled, 'boolean');
    assert.ok(Number.isFinite(definition.par) && definition.par > 0, `${meta.id} needs a par time`);

    const derived = (definition.course.finishX - definition.course.startX) / definition.physics.ghostSpeed;
    assert.ok(Math.abs(definition.par - derived) < 0.02, `${meta.id} par must match the ghost's pace`);
    assert.ok(definition.course.ground.length > 1, `${meta.id} needs real gaps`);
    assert.ok(definition.course.platforms.length > 0, `${meta.id} needs one-way platforms`);
    assert.ok(definition.ghost.legs.length > 0, `${meta.id} needs an authored ghost line`);
  }

  for (const [locationId, location] of Object.entries(world.locations || {})) {
    for (const door of Array.isArray(location.doors) ? location.doors : []) {
      if (door.kind !== 'activity') continue;
      assert.ok(
        defined[door.activityId],
        `${locationId} entrance references missing activity ${door.activityId}`
      );
      assert.ok(Number.isInteger(door.x) && Number.isInteger(door.y), `${locationId} entrance needs a tile`);
      assert.equal(typeof door.prompt, 'string');
    }
  }
});

test('every mini-game metadata record resolves items, dialogue, rewards, board, seats, input, and layers', () => {
  for (const [id, meta] of Object.entries(minigames.miniGames)) {
    assert.equal(meta.id, id, `miniGames.${id} id must match its key`);
    const report = validateMeta(meta);
    assert.equal(report.ok, true, `${id}: ${report.errors.join('; ')}`);

    // Door-driven activities declare itemId: null; everything else must resolve.
    if (meta.itemId !== null) {
      assert.ok(catalogIds.has(meta.itemId), `${id} references missing item ${meta.itemId}`);
    }
    if (meta.dialogueKey !== null && meta.dialogueKey !== undefined) {
      assert.ok(dialogues.dialogues[meta.dialogueKey], `${id} missing dialogue ${meta.dialogueKey}`);
    }
    if (meta.rewardKey !== null && meta.rewardKey !== undefined) {
      assert.ok(rewards.miniGames[meta.rewardKey], `${id} missing reward key ${meta.rewardKey}`);
    }

    if (meta.board === null) {
      assert.equal(meta.kind, 'activity', `${id} board-less games should be activities`);
    } else {
      assert.equal(meta.kind, 'board', `${id} board games should be kind=board`);
      assert.ok(Number.isInteger(meta.board.width) && meta.board.width > 0, `${id} board width`);
      assert.ok(Number.isInteger(meta.board.height) && meta.board.height > 0, `${id} board height`);
      assert.ok(meta.board.margin >= 0, `${id} board margin`);
      assert.equal(typeof meta.board.blocksMovement, 'boolean', `${id} blocksMovement`);
      assert.ok(Array.isArray(meta.board.hiddenZones), `${id} hiddenZones`);
    }

    assert.ok(Number.isInteger(meta.seats) && meta.seats > 0, `${id} seats`);
    assert.ok(meta.seats >= meta.players, `${id} seats should cover every player`);
    assert.ok(INPUT_MODES.includes(meta.input.mode), `${id} input mode ${meta.input.mode}`);
    assert.ok(Array.isArray(meta.renderLayers) && meta.renderLayers.length > 0, `${id} renderLayers`);
    for (const layer of meta.renderLayers) {
      assert.ok(RENDER_LAYERS.includes(layer), `${id} unknown render layer ${layer}`);
    }
  }
});

test('every loot table pool and item row references the item catalog', () => {
  const lootTables = rewards.lootTables || {};
  for (const [tableId, table] of Object.entries(lootTables)) {
    assert.ok(Array.isArray(table) && table.length > 0, `${tableId} must be a non-empty table`);
    for (const row of table) {
      assert.ok(row && typeof row === 'object', `${tableId} has a malformed row`);
      assert.ok(Number.isFinite(row.weight) && row.weight > 0, `${tableId} row needs positive weight`);

      if (row.type === 'item') {
        const hasPool = Array.isArray(row.pool) && row.pool.length > 0;
        assert.ok(hasPool || typeof row.id === 'string', `${tableId} item row needs a pool or id`);
        if (hasPool) {
          for (const itemId of row.pool) {
            assert.ok(catalogIds.has(itemId), `${tableId} pool references unknown item ${itemId}`);
          }
        }
        if (typeof row.id === 'string') {
          assert.ok(catalogIds.has(row.id), `${tableId} row references unknown item ${row.id}`);
        }
      } else if (row.type === 'coins') {
        assert.ok(Number.isFinite(row.amount) && row.amount >= 0, `${tableId} coin row needs an amount`);
      }
    }
  }

  for (const [gameId, table] of Object.entries(rewards.miniGames || {})) {
    for (const [outcome, spec] of Object.entries(table)) {
      if (spec?.bonusLootTable) {
        assert.ok(lootTables[spec.bonusLootTable], `${gameId}.${outcome} missing loot table ${spec.bonusLootTable}`);
      }
    }
  }
});

test('behavior actions, selectors, predicates, and cooldown references all resolve', () => {
  const report = validateConfig(behaviors, { extraActions: SOCIAL_ACTION_NAMES });
  assert.equal(report.ok, true, report.errors.map(error => `${error.path}: ${error.message}`).join('; '));

  const sourceActions = new Set([...ACTION_NAMES, ...SOCIAL_ACTION_NAMES]);
  for (const [behaviorId, behavior] of Object.entries(behaviors.behaviors)) {
    if (behavior.when) assertPredicate(behavior.when, `behaviors.${behaviorId}.when`);

    if (behavior.target) {
      const selector = behavior.target.selector;
      assert.ok(SELECTOR_NAMES.includes(selector), `${behaviorId} target uses unknown selector ${selector}`);
      const definition = behaviors.selectors[selector];
      assert.ok(definition, `${behaviorId} target selector ${selector} is missing from data`);
      assert.equal(definition.type, selector, `selectors.${selector}.type should match its key`);
      const allowed = SELECTOR_PARAM_KEYS[selector];
      assert.ok(allowed, `no verifier parameter table for selector ${selector}`);
      for (const key of Object.keys(behavior.target.params || {})) {
        assert.ok(allowed.has(key), `${behaviorId} target has unsupported ${selector} param ${key}`);
      }
    }

    for (const [stateId, state] of Object.entries(behavior.states)) {
      assert.ok(sourceActions.has(state.action), `${behaviorId}.${stateId} unknown action ${state.action}`);
      assert.ok(
        typeof actions[state.action] === 'function' || typeof socialActions[state.action] === 'function',
        `${behaviorId}.${stateId} action ${state.action} has no implementation`
      );
      for (const [index, transition] of (state.transitions || []).entries()) {
        assertPredicate(transition.when, `behaviors.${behaviorId}.states.${stateId}.transitions[${index}].when`);
      }
    }

    for (const [index, cooldownId] of (behavior.cooldowns || []).entries()) {
      assert.ok(behaviors.cooldowns[cooldownId], `${behaviorId}.cooldowns[${index}] unknown ${cooldownId}`);
    }
  }
});

test('assignment styles and families exist or intentionally fall back', () => {
  const styles = new Set(Object.keys(behaviors.styleFamilies));
  const families = new Set(Object.values(behaviors.styleFamilies));
  const assignedStyles = new Set();
  const assignedFamilies = new Set();
  let hasCompanionFallback = false;
  let hasNpcAssignment = false;

  for (const [index, assignment] of behaviors.assignments.entries()) {
    const match = assignment.match || {};
    if (match.style) {
      assert.ok(styles.has(match.style), `assignments[${index}] style ${match.style} is missing from styleFamilies`);
      assignedStyles.add(match.style);
    }
    if (match.family) {
      assert.ok(families.has(match.family), `assignments[${index}] family ${match.family} is not produced by styleFamilies`);
      assignedFamilies.add(match.family);
    }
    if (!match.style && !match.family) {
      assert.ok(match.kind === 'companion' || match.kind === 'npc' || match.kind === 'player',
        `assignments[${index}] generic fallback needs a valid kind`);
      if (match.kind === 'companion') hasCompanionFallback = true;
      if (match.kind === 'npc') hasNpcAssignment = true;
    }
  }

  for (const style of ['dog', 'gaze', 'clay', 'skeleton']) {
    assert.ok(styles.has(style), `styleFamilies is missing the ${style} profile`);
  }
  for (const style of ['dog', 'gaze', 'clay']) {
    assert.ok(assignedStyles.has(style), `assignments is missing the ${style} follow override`);
  }
  // Skeleton companions are intentionally matched by family, because several
  // skin styles (skeleton, skeleton-armor, skeleton_armor) share one profile.
  assert.ok(
    assignedStyles.has('skeleton') || assignedFamilies.has(behaviors.styleFamilies.skeleton),
    'assignments is missing the skeleton follow override'
  );
  assert.ok(hasCompanionFallback, 'companions need a generic follow fallback');
  assert.ok(hasNpcAssignment, 'NPCs need a wander assignment');
});

test('effect motions and every metadata dialogue key resolve in data', () => {
  for (const effect of Object.values(effects.effects)) {
    if (effect.motion === null || effect.motion === undefined) continue;
    assert.ok(EFFECT_MOTIONS[effect.motion], `${effect.id} references missing motion ${effect.motion}`);
  }

  for (const [id, meta] of Object.entries(minigames.miniGames)) {
    if (meta.dialogueKey === null || meta.dialogueKey === undefined) continue;
    assert.ok(dialogues.dialogues[meta.dialogueKey], `${id} dialogueKey ${meta.dialogueKey} does not resolve`);
  }

  const socialLines = dialogues.social || {};
  for (const [behaviorId, behavior] of Object.entries(behaviors.behaviors)) {
    for (const [stateId, state] of Object.entries(behavior.states)) {
      if (state.action !== 'say' && state.action !== 'speak') continue;
      const key = state.params?.key;
      if (!key) continue;
      assert.ok(socialLines[key] || dialogues.dialogues[key],
        `${behaviorId}.${stateId} says unknown dialogue key ${key}`);
    }
  }
});

test('voice.json resolves against the vendored bank and pools', () => {
  assert.equal(voicePolicy.version, 1);
  assert.equal(typeof voicePolicy.enabled, 'boolean');
  assert.ok(voicePolicy.volume >= 0 && voicePolicy.volume <= 1);
  assert.ok(Number(voicePolicy.prefetchRadiusTiles) > 0);
  assert.ok(Number(voicePolicy.chatRadiusTiles) > 0, 'chatRadiusTiles is required');
  assert.ok(Number(voicePolicy.chatCooldownMs) > 0, 'chatCooldownMs is required');
  assert.ok(Number(voicePolicy.chatGlobalCooldownMs) > 0, 'chatGlobalCooldownMs is required');
  assert.ok(
    Number(voicePolicy.chatGlobalCooldownMs) <= Number(voicePolicy.chatCooldownMs),
    'the park window should not outlast a single voice window'
  );

  const languageIds = new Set(voicePolicy.languages.map(language => language.id));
  assert.equal(languageIds.size, voicePolicy.languages.length, 'duplicate voice language ids');
  for (const language of voicePolicy.languages) {
    assert.ok(Number(language.weight) > 0, `${language.id} needs a positive weight`);
    assert.ok(language.label, `${language.id} needs a label`);
    assert.ok(Array.isArray(voicePools.languages[language.id]) && voicePools.languages[language.id].length,
      `${language.id} has no pool entries`);
  }

  for (const [event, hook] of Object.entries(voicePolicy.events)) {
    assert.ok(Array.isArray(voiceBank.hooks[hook]) && voiceBank.hooks[hook].length,
      `${event} maps to unknown or empty hook ${hook}`);
  }
  for (const event of voicePolicy.prefetchEvents) {
    assert.ok(voicePolicy.events[event], `prefetch event ${event} is not aliased`);
  }
});

test('board strip copy covers every rejection reason and instruction placeholder', () => {
  const strip = minigames.strip;
  assert.ok(strip, 'data/minigames.json needs a top-level strip block');
  for (const reason of REJECT_REASONS) {
    assert.equal(typeof strip.reasons[reason], 'string', `missing strip copy for ${reason}`);
    assert.ok(strip.reasons[reason].trim().length > 0, `${reason} copy is empty`);
  }
  for (const outcome of ['win', 'loss', 'draw', 'abandoned']) {
    assert.equal(typeof strip.outcome[outcome], 'string', `missing outcome copy for ${outcome}`);
  }
  assert.equal(typeof strip.keyHint, 'string');
  assert.equal(typeof strip.touchHint, 'string');

  for (const id of ['tic-tac-toe', 'checkers', 'chess', 'memory-grid', 'connect-four', 'snakes-ladders']) {
    const instruction = minigames.miniGames[id].strip?.instruction;
    assert.match(instruction, /\{key\}/, `${id} instruction needs the {key} placeholder`);
    assert.equal(minigames.miniGames[id].kind, 'board', id);
  }
});

test('snakes-ladders.json defines a complete 10×10 race board', () => {
  assert.equal(snakesLadders.version, 1);
  assert.equal(snakesLadders.board.size, 10);
  assert.equal(snakesLadders.board.squares, 100);
  assert.equal(snakesLadders.dice.sides, 6);
  assert.equal(snakesLadders.start, 0);
  assert.ok(Number(snakesLadders.timing.stepMs) > 0);
  assert.ok(Number(snakesLadders.timing.aiDelayMs) > 0);

  const starts = new Set();
  for (const snake of snakesLadders.snakes) {
    assert.ok(Number.isInteger(snake.from) && Number.isInteger(snake.to));
    assert.ok(snake.from > snake.to, `snake ${snake.from} must slide down`);
    assert.ok(snake.to >= 1 && snake.from <= 100);
    assert.ok(!starts.has(snake.from), `duplicate snake/ladder start ${snake.from}`);
    starts.add(snake.from);
  }
  for (const ladder of snakesLadders.ladders) {
    assert.ok(Number.isInteger(ladder.from) && Number.isInteger(ladder.to));
    assert.ok(ladder.to > ladder.from, `ladder ${ladder.from} must climb up`);
    assert.ok(ladder.from >= 1 && ladder.to <= 100);
    assert.ok(!starts.has(ladder.from), `duplicate snake/ladder start ${ladder.from}`);
    starts.add(ladder.from);
  }
  assert.ok(snakesLadders.snakes.length >= 5);
  assert.ok(snakesLadders.ladders.length >= 5);
  assert.ok(starts.has(80) || starts.has(100), 'the map should offer a late climb or finish');
});

test('home_items.json defines the furnished room and a testable default layout', () => {
  const homeItems = readJson('home_items.json');
  assert.equal(homeItems.version, 1);
  assert.equal(typeof homeItems.items, 'object');
  assert.ok(Object.keys(homeItems.items).length >= 15);

  for (const [id, item] of Object.entries(homeItems.items)) {
    assert.equal(item.id, id);
    assert.equal(typeof item.label, 'string');
    assert.ok(item.label.length > 0);
    assert.ok(['living', 'kitchen', 'dining', 'bedroom'].includes(item.zone), `${id} zone`);
    assert.ok(item.size && item.size.w >= 1 && item.size.h >= 1, `${id} size`);
    assert.equal(typeof item.solid, 'boolean', `${id} solid`);
    assert.equal(item.shape, id);
    assert.ok(item.colors && typeof item.colors.base === 'string', `${id} palette`);
    assert.ok(Array.isArray(item.variants) && item.variants.length >= 2, `${id} variants`);
    assert.ok(item.interact === null || typeof item.interact?.kind === 'string', `${id} interact`);
    assert.ok(Array.isArray(item.tiers) && item.tiers.length === 3, `${id} tiers`);
    assert.equal(item.tiers[0].price, 0, `${id} plain is free`);
    assert.ok(item.tiers[1].price > 0, `${id} comfy price`);
    assert.ok(item.tiers[2].price >= item.tiers[1].price, `${id} deluxe price`);
  }

  assert.equal(homeItems.items.rug.solid, false);
  assert.equal(homeItems.items.plant.solid, true);
  assert.ok(Array.isArray(homeItems.layout) && homeItems.layout.length >= 15);
  for (const entry of homeItems.layout) {
    assert.ok(homeItems.items[entry.itemId], `layout references unknown ${entry.itemId}`);
    assert.ok(Number.isInteger(entry.dx) && Number.isInteger(entry.dy));
    assert.ok(Number.isInteger(entry.rot) && entry.rot >= 0 && entry.rot <= 3);
  }
});

test('world.json locations resolve ids, doors, spawns, and the Home flag', () => {
  const worldConfig = readJson('world.json');
  assert.equal(worldConfig.version, 1);
  assert.equal(typeof worldConfig.travel.confirm, 'string');
  assert.equal(typeof worldConfig.travel.cancel, 'string');

  for (const [id, def] of Object.entries(worldConfig.locations)) {
    assert.equal(def.id, id, `locations.${id} id must match its key`);
    assert.equal(typeof def.label, 'string', `${id} needs a label`);
    assert.equal(typeof def.enabled, 'boolean', `${id} enabled must be explicit`);
    assert.equal(typeof def.mapLabel, 'string', `${id} needs a map label`);
    assert.ok(def.menu && typeof def.menu.label === 'string' && def.menu.label, `${id} needs a menu row label`);
    assert.ok(def.door && typeof def.door.to === 'string', `${id} needs a door target`);
    assert.ok(worldConfig.locations[def.door.to], `${id} door targets unknown location ${def.door.to}`);
    assert.ok(Number.isInteger(def.door.x) && Number.isInteger(def.door.y), `${id} door tile`);
    assert.ok(typeof def.door.prompt === 'string' && def.door.prompt.trim(), `${id} door prompt`);
    assert.ok(Number.isInteger(def.spawn?.x) && Number.isInteger(def.spawn?.y), `${id} spawn tile`);
  }

  // The Home slice is complete: the flag is on and the door is reachable.
  assert.equal(worldConfig.locations.park.enabled, true);
  assert.equal(worldConfig.locations.home.enabled, true);
  assert.equal(worldConfig.locations.home.forage, false);

  const home = worldConfig.locations.home;
  const { x, y, width, height } = home.house;
  assert.ok(width >= 5 && height >= 5, 'the room needs a floor');
  assert.ok(x > 0 && y > 0 && x + width <= 64 && y + height <= 64, 'house fits the lot');
  const onWall = home.door.x === x || home.door.x === x + width - 1
    || home.door.y === y || home.door.y === y + height - 1;
  assert.ok(onWall, 'home door must cut through a wall');
  const inside = home.spawn.x > x && home.spawn.x < x + width - 1
    && home.spawn.y > y && home.spawn.y < y + height - 1;
  assert.ok(inside, 'home spawn must stand inside the room');
});

test('every catalog item carries a value and a tradeable flag in the agreed bands', () => {
  for (const item of Object.values(catalog)) {
    assert.ok(Number.isInteger(item.value) && item.value > 0, `${item.id} needs a positive integer value`);
    assert.equal(typeof item.tradeable, 'boolean', `${item.id} needs a boolean tradeable flag`);

    const isEffect = item.kind === 'effect';
    const isTrinket = item.kind === 'trinket';
    if (isTrinket) {
      // Trinkets are the small-change trade goods: tradeable, no action, tiny value.
      assert.equal(item.tradeable, true, `${item.id} trinkets are tradeable`);
      assert.equal(item.action, undefined, `${item.id} trinkets are not toys`);
      assert.ok(item.value >= 1 && item.value <= 10, `${item.id} trinket value ${item.value} outside 1–10`);
      continue;
    }

    assert.equal(item.tradeable, isEffect, `${item.id} tradeability should follow its category`);
    if (isEffect) {
      assert.ok(item.value >= 20 && item.value <= 60, `${item.id} effect value ${item.value} outside 20–60`);
    } else {
      assert.ok(item.value >= 10 && item.value <= 40, `${item.id} toy value ${item.value} outside 10–40`);
      assert.ok(['throw', 'unfurl'].includes(item.action), `${item.id} should be a toy`);
    }
  }

  // The starter postcard gives a fresh park one affordable buy and one affordable sell.
  assert.equal(catalog['park-postcard']?.kind, 'trinket');
  assert.equal(catalog['park-postcard']?.value, 4);
  assert.ok(items.starter.some(spec => spec.id === 'park-postcard'), 'starter grants the postcard');

  const startingCoins = engineConfig.economy?.startingCoins;
  assert.ok(Number.isInteger(startingCoins) && startingCoins > 0, 'economy.startingCoins must be a positive integer');
});

test('every trade template validates, matches its key, and names tradeable items', () => {
  const templates = Object.entries(TRADE_TEMPLATES);
  assert.ok(templates.length >= 2, 'trading needs at least two templates');
  assert.equal(new Set(TRADE_REJECT_REASONS).size, 4);

  for (const [key, offer] of templates) {
    assert.equal(offer.id, key, `${key} id must match its template key`);
    const result = validateOffer(offer);
    assert.equal(result.ok, true, `${key}: ${result.detail || 'invalid'}`);

    for (const side of [offer.give, offer.get]) {
      if (side.itemId) {
        assert.ok(catalog[side.itemId], `${key} references missing item ${side.itemId}`);
        assert.equal(catalog[side.itemId].tradeable, true, `${key} trades untradeable ${side.itemId}`);
      }
    }
  }
});
