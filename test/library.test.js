import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeTerrain,
  findPath,
  generateTown,
  isWalkable,
  mulberry32,
  typeAt
} from '../src/world.js';
import {
  LOCATIONS,
  createLocationRecord,
  doorFor,
  doorsFor,
  locationLayout,
  propsForLocation,
  residentsFor,
  worldFor
} from '../src/locations.js';
import { locationBlockedTiles } from '../src/location_props.js';
import {
  LESSONS_DATA,
  drawLessonQuestions,
  gradeLesson,
  lessonCoinAward,
  lessonConfig,
  lessonQuestions,
  lessonTopicLabel,
  validateLessonsData
} from '../src/lessons.js';
import { applyGoalEvent } from '../src/goals.js';
import goalsData from '../data/goals.json' with { type: 'json' };

const LIBRARY = LOCATIONS.library;

function libraryRecord() {
  return createLocationRecord('library');
}

test('Library is an enabled interior with a door back to Town and a menu row', () => {
  assert.equal(LIBRARY.enabled, true);
  assert.equal(LIBRARY.template, 'interior');
  assert.equal(LIBRARY.forage, false);
  assert.equal(LIBRARY.label, 'Library');
  assert.equal(LIBRARY.menu.label, 'Library');
  assert.equal(LIBRARY.door.to, 'town');
  assert.equal(LIBRARY.door.prompt, 'Back to town?');

  const { x, y, width, height } = LIBRARY.house;
  assert.ok(width >= 5 && height >= 5);
  assert.ok(x > 0 && y > 0 && x + width <= 64 && y + height <= 64);
  const onWall = LIBRARY.door.x === x || LIBRARY.door.x === x + width - 1
    || LIBRARY.door.y === y || LIBRARY.door.y === y + height - 1;
  assert.ok(onWall, 'the library door cuts through a wall');
  const inside = LIBRARY.spawn.x > x && LIBRARY.spawn.x < x + width - 1
    && LIBRARY.spawn.y > y && LIBRARY.spawn.y < y + height - 1;
  assert.ok(inside, 'the library spawn stands inside the room');

  const world = worldFor('library');
  assert.equal(world.template, 'interior');
  assert.equal(typeAt(world.grid, LIBRARY.spawn.x, LIBRARY.spawn.y), 'home-floor');
  assert.equal(typeAt(world.grid, LIBRARY.door.x, LIBRARY.door.y), 'home-floor');
  assert.ok(isWalkable(typeAt(world.grid, LIBRARY.spawn.x, LIBRARY.spawn.y)));
  assert.equal(locationLayout('library'), 'interior');
});

test('a fresh Library record reuses the Home builder and stores no residents', () => {
  const record = libraryRecord();
  const world = worldFor('library');
  assert.equal(record.layout, 'interior');
  assert.equal(record.forage.seeded, true, 'interiors do not seed forage');
  assert.deepEqual(record.npcs, [], 'data residents are never written into the save');
  assert.deepEqual(decodeTerrain(record.terrain), world.grid);
  assert.deepEqual(
    { x: record.player.x, y: record.player.y },
    { x: LIBRARY.spawn.x, y: LIBRARY.spawn.y }
  );
});

test('Town has a reachable library door on the third facade', () => {
  const town = generateTown(LOCATIONS.town.seed);
  const record = createLocationRecord('town');
  const blocked = locationBlockedTiles(propsForLocation('town', record));
  const doors = doorsFor('town', { terrain: town.grid, spawn: town.spawn });
  const door = doors.find(entry => entry.to === 'library');
  assert.ok(door, 'the town offers the library');
  assert.deepEqual({ x: door.x, y: door.y }, { x: 40, y: 28 });
  assert.equal(door.prompt, 'Visit the library?');
  assert.ok(isWalkable(typeAt(town.grid, door.x, door.y)));
  assert.ok(!blocked.has(`${door.x},${door.y}`), 'no prop sits on the library door');

  const path = findPath(town.grid, town.spawn, { x: door.x, y: door.y }, blocked);
  assert.ok(path.length > 0, 'the library door is walkable from the town spawn');
  assert.deepEqual(path.at(-1), { x: door.x, y: door.y });

  const library = worldFor('library');
  const back = doorFor('library', { terrain: library.grid, spawn: library.spawn });
  assert.equal(back.to, 'town');
  assert.equal(back.prompt, 'Back to town?');
  assert.ok(isWalkable(typeAt(library.grid, back.x, back.y)));
});

test('Library props furnish the reading room without trapping the door or spawn', () => {
  const record = libraryRecord();
  const props = propsForLocation('library', record);
  assert.equal(props.length, LIBRARY.props.length, 'every declared prop is placed');
  const types = new Set(props.map(prop => prop.type));
  for (const type of ['bookshelf', 'desk', 'rug', 'bench', 'lamp', 'planter']) {
    assert.ok(types.has(type), `the library has a ${type}`);
  }

  const blocked = locationBlockedTiles(props);
  const world = worldFor('library');
  const spawn = LIBRARY.spawn;
  const door = LIBRARY.door;
  assert.ok(!blocked.has(`${spawn.x},${spawn.y}`), 'the spawn is clear');
  assert.ok(!blocked.has(`${door.x},${door.y}`), 'the door is clear');

  const toDoor = findPath(world.grid, spawn, door, blocked);
  assert.ok(toDoor.length > 0, 'the door is reachable from the spawn');

  const librarian = residentsFor('library')[0];
  assert.ok(!blocked.has(`${librarian.x},${librarian.y}`), 'the librarian stands on open floor');
  const toLibrarian = findPath(world.grid, spawn, { x: librarian.x, y: librarian.y }, blocked);
  assert.ok(toLibrarian.length > 0, 'the librarian can be reached from the spawn');
});

test('the librarian is a stable, unsaved resident with the librarian role', () => {
  const residents = residentsFor('library');
  assert.equal(residents.length, 1);
  const librarian = residents[0];
  assert.equal(librarian.id, 'librarian-fern');
  assert.equal(librarian.name, 'Fern');
  assert.equal(librarian.role, 'librarian');
  assert.equal(librarian.resident, true);
  assert.ok(librarian.recipe.seed);

  const world = worldFor('library');
  assert.ok(isWalkable(typeAt(world.grid, librarian.x, librarian.y)));
  assert.equal(typeAt(world.grid, librarian.x, librarian.y), 'home-floor');
  assert.deepEqual(libraryRecord().npcs, []);
});

test('lesson data is valid and covers three topics with three choices each', () => {
  assert.deepEqual(validateLessonsData(LESSONS_DATA), []);
  const config = lessonConfig(LESSONS_DATA);
  assert.equal(config.count, 3);
  assert.equal(config.coinsPerCorrect, 5);
  assert.equal(config.perfectBonus, 5);

  const topics = new Set(LESSONS_DATA.topics.map(topic => topic.id));
  assert.equal(topics.size, 3);
  const questions = lessonQuestions(LESSONS_DATA);
  assert.ok(questions.length >= 6);
  for (const question of questions) {
    assert.ok(topics.has(question.topic), `${question.id} has a known topic`);
    assert.equal(question.choices.length, 3);
    assert.ok(question.answer >= 0 && question.answer < 3);
    assert.ok(question.explanation.length > 0);
    assert.equal(lessonTopicLabel(LESSONS_DATA, question.topic).length > 0, true);
  }
});

test('validateLessonsData rejects bad answers, duplicate choices, and unknown topics', () => {
  const broken = {
    version: 1,
    questionsPerLesson: 3,
    coinsPerCorrect: 5,
    perfectBonus: 5,
    topics: [
      { id: 'one', label: 'one' },
      { id: 'two', label: 'two' }
    ],
    questions: [
      { id: 'q1', topic: 'one', prompt: 'pick?', choices: ['a', 'a', 'c'], answer: 3, explanation: '' },
      { id: 'q2', topic: 'missing', prompt: 'pick?', choices: ['a', 'b', 'c'], answer: 0, explanation: 'x' },
      { id: 'q3', topic: 'two', prompt: 'pick?', choices: ['a', 'b', 'c'], answer: 999, explanation: 'x' }
    ]
  };
  const errors = validateLessonsData(broken);
  assert.ok(errors.length > 0);
  assert.ok(errors.some(error => error.includes('expected at least 6 questions')));
  assert.ok(errors.some(error => error.includes('not enough usable questions')));
});

test('a lesson draws three unique questions across all three topics', () => {
  const random = mulberry32(1337);
  const first = drawLessonQuestions(LESSONS_DATA, { rng: random });
  assert.equal(first.length, 3);
  assert.equal(new Set(first.map(question => question.id)).size, 3);
  assert.deepEqual(
    new Set(first.map(question => question.topic)),
    new Set(['park-nature', 'simple-maths', 'words'])
  );
  for (const question of first) {
    assert.equal(question.choices.length, 3);
    assert.ok(question.answer >= 0 && question.answer < 3);
  }

  const repeat = drawLessonQuestions(LESSONS_DATA, { rng: mulberry32(1337) });
  assert.deepEqual(repeat.map(question => question.id), first.map(question => question.id));

  const single = drawLessonQuestions(LESSONS_DATA, { count: 1, rng: mulberry32(7) });
  assert.equal(single.length, 1);
  assert.equal(drawLessonQuestions(LESSONS_DATA, { count: 99, rng: mulberry32(9) }).length, lessonQuestions(LESSONS_DATA).length);
});

test('lesson scoring pays five a question and a five-coin perfect bonus', () => {
  const questions = drawLessonQuestions(LESSONS_DATA, { rng: mulberry32(42) });
  const allRight = questions.map(question => question.answer);
  const perfect = gradeLesson(questions, allRight);
  assert.deepEqual(perfect, { correct: 3, total: 3, perfect: true, coins: 20 });

  const twoRight = [...allRight];
  twoRight[0] = (questions[0].answer + 1) % 3;
  assert.deepEqual(gradeLesson(questions, twoRight), {
    correct: 2,
    total: 3,
    perfect: false,
    coins: 10
  });

  const none = questions.map(question => (question.answer + 1) % 3);
  assert.deepEqual(gradeLesson(questions, none), {
    correct: 0,
    total: 3,
    perfect: false,
    coins: 0
  });
  assert.deepEqual(gradeLesson(questions, []), { correct: 0, total: 3, perfect: false, coins: 0 });
});

test('lesson coins pay once per session, even if the result beat repeats', () => {
  assert.equal(lessonCoinAward({ coins: 20, awarded: false }), 20);
  assert.equal(lessonCoinAward({ coins: 20, awarded: true }), 0);
  assert.equal(lessonCoinAward({ coins: 0 }), 0);
  assert.equal(lessonCoinAward({ coins: -5 }), 0);
  assert.equal(lessonCoinAward({ coins: '10' }), 10);
});

test('lesson.completed completes the library goal once and never pays twice', () => {
  const first = applyGoalEvent({ completed: {} }, 'lesson.completed', goalsData.goals, 1000);
  assert.equal(first.changed, true);
  assert.deepEqual(first.completed.map(goal => goal.id), ['take-a-library-lesson']);
  assert.equal(first.completed[0].reward, 20);

  const second = applyGoalEvent(first.progress, 'lesson.completed', goalsData.goals, 2000);
  assert.equal(second.changed, false);
  assert.deepEqual(second.completed, []);
  assert.deepEqual(second.progress, first.progress);

  // The payout helper mirrors the main loop: only a changed event adds coins.
  let progress = { completed: {} };
  let coins = 0;
  for (let index = 0; index < 3; index += 1) {
    const result = applyGoalEvent(progress, 'lesson.completed', goalsData.goals, 1000 + index);
    progress = result.progress;
    coins += result.completed.reduce((total, goal) => total + goal.reward, 0);
  }
  assert.equal(coins, 20);
});
