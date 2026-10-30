import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ACTION_NAMES, actions } from '../src/behavior/actions.js';
import { SOCIAL_ACTION_NAMES, socialActions } from '../src/behavior/actions/social.js';
import { SELECTOR_NAMES } from '../src/behavior/selectors.js';
import { assertPredicate } from '../src/behavior/predicates.js';
import { validateConfig } from '../src/behavior/config.js';
import { validateMeta, INPUT_MODES, RENDER_LAYERS } from '../src/minigames/contract.js';
import { EFFECT_MOTIONS, EFFECT_SLOTS } from '../src/effects.js';

function readJson(name) {
  return JSON.parse(readFileSync(new URL(`../data/${name}`, import.meta.url), 'utf8'));
}

const items = readJson('items.json');
const effects = readJson('effects.json');
const minigames = readJson('minigames.json');
const rewards = readJson('rewards.json');
const dialogues = readJson('dialogues.json');
const behaviors = readJson('behaviors.json');

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

test('every mini-game metadata record resolves items, dialogue, rewards, board, seats, input, and layers', () => {
  for (const [id, meta] of Object.entries(minigames.miniGames)) {
    assert.equal(meta.id, id, `miniGames.${id} id must match its key`);
    const report = validateMeta(meta);
    assert.equal(report.ok, true, `${id}: ${report.errors.join('; ')}`);

    assert.ok(catalogIds.has(meta.itemId), `${id} references missing item ${meta.itemId}`);
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
