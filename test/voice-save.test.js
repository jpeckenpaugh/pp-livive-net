import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeTerrain } from '../src/world.js';
import { SAVE_VERSION, migrateSave, serializeSave } from '../src/storage.js';
import { castVoice, normalizeVoice } from '../src/voice/casting.js';

function grassTerrain() {
  return Array.from({ length: 64 }, () => Array.from({ length: 64 }, () => 'grass'));
}

function npcRecord(id, overrides = {}) {
  return {
    id,
    name: `Neighbour ${id}`,
    recipe: { seed: `recipe-${id}`, look: {} },
    vibe: 'curious',
    x: 10,
    y: 10,
    direction: 0,
    inventory: [],
    equipped: [],
    coins: 0,
    stabledCompanions: [],
    ...overrides
  };
}

function v2Save(overrides = {}) {
  return {
    version: 2,
    worldSeed: 'voice-save-seed',
    terrain: encodeTerrain(grassTerrain()),
    playerName: 'Tester',
    playerRecipe: { seed: 'p-seed', look: {} },
    player: {
      x: 8,
      y: 9,
      direction: 1,
      inventory: [],
      equipped: [],
      coins: 0,
      stabledCompanions: []
    },
    npcs: [npcRecord('npc-1'), npcRecord('npc-2')],
    companions: [
      {
        id: 'comp-1',
        name: 'Mo',
        buddyId: 'npc-1',
        recipe: { isCompanion: true, style: 'dog', seed: 'c-seed' },
        x: 10,
        y: 10,
        direction: 0,
        inventory: [],
        equipped: []
      }
    ],
    friends: ['npc-1'],
    wander: true,
    ...overrides
  };
}

function liveGame(save) {
  return {
    worldSeed: save.worldSeed,
    terrain: grassTerrain(),
    wander: true,
    player: {
      name: save.playerName,
      recipe: save.playerRecipe,
      x: save.player.x,
      y: save.player.y,
      direction: save.player.direction,
      inventory: [],
      equipped: [],
      coins: 0,
      stabledCompanions: []
    },
    npcs: save.npcs.map(npc => ({ ...npc })),
    companions: save.companions.map(comp => ({ ...comp }))
  };
}

test('v2 saves migrate to v3 with a voice on every NPC', () => {
  const migrated = migrateSave(v2Save());

  assert.equal(migrated.version, SAVE_VERSION);
  assert.equal(migrated.version, 3);
  assert.equal(migrated.npcs.length, 2);
  for (const npc of migrated.npcs) {
    assert.ok(normalizeVoice(npc.voice), `${npc.id} should carry a valid voice`);
    assert.deepEqual(npc.voice, castVoice({ id: npc.id }));
  }
});

test('migration leaves recipes, friends, and companion records untouched by voice', () => {
  const source = v2Save();
  const migrated = migrateSave(JSON.parse(JSON.stringify(source)));

  assert.deepEqual(migrated.npcs[0].recipe, source.npcs[0].recipe);
  assert.deepEqual(migrated.npcs[1].recipe, source.npcs[1].recipe);
  assert.deepEqual(migrated.friends, source.friends);
  assert.equal('voice' in migrated.player, false);
  assert.equal('voice' in migrated.companions[0], false);
});

test('v1 saves also migrate to v3 with a voice on every NPC', () => {
  const v1 = v2Save({ version: 1 });
  delete v1.npcs[0].coins;
  delete v1.npcs[0].stabledCompanions;

  const migrated = migrateSave(v1);
  assert.equal(migrated.version, 3);
  for (const npc of migrated.npcs) {
    assert.ok(normalizeVoice(npc.voice));
    assert.deepEqual(npc.voice, castVoice({ id: npc.id }));
  }
});

test('a later load never re-rolls an NPC voice', () => {
  const first = migrateSave(v2Save());
  const second = migrateSave(JSON.parse(JSON.stringify(first)));
  const third = migrateSave(JSON.parse(JSON.stringify(second)));

  assert.deepEqual(second.npcs.map(npc => npc.voice), first.npcs.map(npc => npc.voice));
  assert.deepEqual(third.npcs.map(npc => npc.voice), first.npcs.map(npc => npc.voice));
});

test('serializeSave preserves a stored voice exactly', () => {
  const stored = {
    schema: 1,
    seed: 'clover-4pxbyrw',
    lang: 'fr',
    voiceId: 'ff_siwis',
    pitchSt: -1.25,
    formantRatio: 0.98,
    tiltDbPerOct: 0.75
  };
  const save = serializeSave(liveGame(v2Save()), {}, new Set(), null);

  save.npcs[0].voice = stored;
  const reloaded = migrateSave(JSON.parse(JSON.stringify(save)));

  assert.deepEqual(reloaded.npcs[0].voice, stored);
  assert.equal(reloaded.npcs[0].voice.seed, 'clover-4pxbyrw');
});

test('serializeSave gives a missing voice a stable cast from the NPC id', () => {
  const fake = liveGame(v2Save());
  delete fake.npcs[0].voice;

  const first = serializeSave(fake, {}, new Set(), null);
  const second = serializeSave(fake, {}, new Set(), null);

  assert.deepEqual(first.npcs[0].voice, castVoice({ id: 'npc-1' }));
  assert.deepEqual(second.npcs[0].voice, first.npcs[0].voice);
});

test('malformed voice blocks are silently re-cast from the NPC id', () => {
  const broken = [
    null,
    'es',
    [],
    {},
    { schema: 2, seed: 'x', lang: 'es', voiceId: 'ef_dora', pitchSt: 0, formantRatio: 1, tiltDbPerOct: 0 },
    { schema: 1, seed: '', lang: 'es', voiceId: 'ef_dora', pitchSt: 0, formantRatio: 1, tiltDbPerOct: 0 },
    { schema: 1, seed: 'x', lang: 'zz', voiceId: 'ef_dora', pitchSt: 0, formantRatio: 1, tiltDbPerOct: 0 },
    { schema: 1, seed: 'x', lang: 'es', voiceId: 'nope', pitchSt: 0, formantRatio: 1, tiltDbPerOct: 0 },
    { schema: 1, seed: 'x', lang: 'es', voiceId: 'af_heart', pitchSt: 0, formantRatio: 1, tiltDbPerOct: 0 },
    { schema: 1, seed: 'x', lang: 'es', voiceId: 'ef_dora', pitchSt: 'high', formantRatio: 1, tiltDbPerOct: 0 }
  ];

  for (const voice of broken) {
    const state = v2Save();
    state.npcs[0].voice = voice;
    const migrated = migrateSave(state);

    assert.ok(migrated, 'the NPC must never be dropped');
    assert.equal(migrated.npcs.length, 2);
    assert.deepEqual(migrated.npcs[0].voice, castVoice({ id: 'npc-1' }), `failed for ${JSON.stringify(voice)}`);
  }
});

test('a valid block for a different language is kept, not re-rolled', () => {
  const state = v2Save();
  state.npcs[1].voice = {
    schema: 1,
    seed: 'clover-4pxbyrw',
    lang: 'ja',
    voiceId: 'jf_alpha',
    pitchSt: 0.5,
    formantRatio: 1.02,
    tiltDbPerOct: -0.25
  };
  const migrated = migrateSave(state);
  assert.deepEqual(migrated.npcs[1].voice, state.npcs[1].voice);
});
