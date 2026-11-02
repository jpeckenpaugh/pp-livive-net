/**
 * Library lesson questions: pure data validation, seeded draws, and scoring.
 *
 * Questions live in `data/lessons.json`. Nothing here reads the DOM, so a
 * lesson can be drawn and graded in Node without a browser.
 */
import lessonsData from '../data/lessons.json' with { type: 'json' };

export const LESSONS_DATA = lessonsData;

const QUESTION_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function randomIndex(rng, length) {
  const value = Number(rng());
  if (!Number.isFinite(value)) return 0;
  return Math.floor(clamp(value, 0, 0.999999) * length);
}

function shuffle(items, rng) {
  const list = [...items];
  for (let index = list.length - 1; index > 0; index -= 1) {
    const swap = randomIndex(rng, index + 1);
    [list[index], list[swap]] = [list[swap], list[index]];
  }
  return list;
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function topicIds(data) {
  return new Set(
    (Array.isArray(data?.topics) ? data.topics : [])
      .filter(topic => isRecord(topic) && typeof topic.id === 'string')
      .map(topic => topic.id)
  );
}

/** A question record safe to show and grade, or null when it is malformed. */
export function normalizeLessonQuestion(raw, topics = null) {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== 'string' || !QUESTION_ID.test(raw.id)) return null;
  if (typeof raw.topic !== 'string' || !raw.topic) return null;
  if (topics && !topics.has(raw.topic)) return null;
  if (typeof raw.prompt !== 'string' || !raw.prompt.trim()) return null;
  if (!Array.isArray(raw.choices) || raw.choices.length !== 3) return null;
  const choices = raw.choices.map(choice => (
    typeof choice === 'string' && choice.trim() ? choice : null
  ));
  if (choices.some(choice => choice === null)) return null;
  if (new Set(choices).size !== choices.length) return null;
  if (!Number.isInteger(raw.answer) || raw.answer < 0 || raw.answer >= choices.length) return null;
  if (typeof raw.explanation !== 'string' || !raw.explanation.trim()) return null;
  return {
    id: raw.id,
    topic: raw.topic,
    prompt: raw.prompt,
    choices,
    answer: raw.answer,
    explanation: raw.explanation
  };
}

/** Every usable question in data order. */
export function lessonQuestions(data = lessonsData) {
  const topics = topicIds(data);
  return (Array.isArray(data?.questions) ? data.questions : [])
    .map(raw => normalizeLessonQuestion(raw, topics))
    .filter(Boolean);
}

export function lessonTopicLabel(data, topicId) {
  const topic = (Array.isArray(data?.topics) ? data.topics : [])
    .find(entry => isRecord(entry) && entry.id === topicId);
  return typeof topic?.label === 'string' && topic.label ? topic.label : topicId;
}

export function lessonConfig(data = lessonsData) {
  const count = Math.round(Number(data?.questionsPerLesson));
  const perCorrect = Math.round(Number(data?.coinsPerCorrect));
  const bonus = Math.round(Number(data?.perfectBonus));
  return {
    count: Number.isInteger(count) && count > 0 ? count : 3,
    coinsPerCorrect: Number.isInteger(perCorrect) && perCorrect > 0 ? perCorrect : 5,
    perfectBonus: Number.isInteger(bonus) && bonus >= 0 ? bonus : 0
  };
}

/**
 * Draw a lesson. Questions are grouped by topic and shuffled, then one is taken
 * from each topic before filling any remaining slots, so a three-question
 * lesson almost always spans all three subjects. `rng` is injectable for tests.
 */
export function drawLessonQuestions(data = lessonsData, { count = null, rng = Math.random } = {}) {
  const config = lessonConfig(data);
  const questions = lessonQuestions(data);
  const want = clamp(
    Math.round(Number.isFinite(Number(count)) ? Number(count) : config.count) || config.count,
    1,
    Math.max(1, questions.length)
  );
  if (!questions.length) return [];

  const groups = new Map();
  for (const question of shuffle(questions, rng)) {
    if (!groups.has(question.topic)) groups.set(question.topic, []);
    groups.get(question.topic).push(question);
  }

  const picked = [];
  const used = new Set();
  for (const topic of shuffle([...groups.keys()], rng)) {
    if (picked.length >= want) break;
    const question = groups.get(topic)[0];
    picked.push(question);
    used.add(question.id);
  }
  for (const question of shuffle(questions, rng)) {
    if (picked.length >= want) break;
    if (used.has(question.id)) continue;
    picked.push(question);
    used.add(question.id);
  }

  return picked.slice(0, want).map(question => ({
    ...question,
    choices: [...question.choices]
  }));
}

/**
 * Grade a lesson. `answers` holds the chosen choice index per question; a
 * missing answer counts as wrong. Coins are the per-answer total plus the
 * perfect bonus, so an interrupted lesson simply earns less.
 */
export function gradeLesson(questions, answers, data = lessonsData) {
  const config = lessonConfig(data);
  const list = Array.isArray(questions) ? questions : [];
  const choices = Array.isArray(answers) ? answers : [];
  let correct = 0;
  list.forEach((question, index) => {
    if (Number(choices[index]) === question?.answer) correct += 1;
  });
  const total = list.length;
  const perfect = total > 0 && correct === total;
  const coins = correct * config.coinsPerCorrect + (perfect ? config.perfectBonus : 0);
  return { correct, total, perfect, coins };
}

/**
 * Coins a lesson may pay now. A session that already paid reports zero, so a
 * repeated result beat cannot grant the same reward twice.
 */
export function lessonCoinAward({ coins = 0, awarded = false } = {}) {
  if (awarded) return 0;
  const value = Math.round(Number(coins));
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** Data problems as human-readable strings; empty when the file is usable. */
export function validateLessonsData(data) {
  const errors = [];
  if (!isRecord(data)) return ['lessons data must be an object'];
  if (data.version !== 1) errors.push('lessons data version must be 1');

  const config = lessonConfig(data);
  if (!Number.isInteger(data.questionsPerLesson) || data.questionsPerLesson < 1) {
    errors.push('questionsPerLesson must be a positive integer');
  }
  if (!Number.isInteger(data.coinsPerCorrect) || data.coinsPerCorrect < 1) {
    errors.push('coinsPerCorrect must be a positive integer');
  }
  if (!Number.isInteger(data.perfectBonus) || data.perfectBonus < 0) {
    errors.push('perfectBonus must be zero or a positive integer');
  }

  const topics = Array.isArray(data.topics) ? data.topics : [];
  if (topics.length < 2 || topics.length > 3) errors.push('expected 2–3 topics');
  const seenTopics = new Set();
  for (const topic of topics) {
    if (!isRecord(topic) || typeof topic.id !== 'string' || !QUESTION_ID.test(topic.id)) {
      errors.push('every topic needs a slug id');
      continue;
    }
    if (seenTopics.has(topic.id)) errors.push(`topic ${topic.id} is duplicated`);
    seenTopics.add(topic.id);
    if (typeof topic.label !== 'string' || !topic.label.trim()) {
      errors.push(`topic ${topic.id} needs a label`);
    }
  }

  const questions = Array.isArray(data.questions) ? data.questions : [];
  if (!Array.isArray(data.questions)) errors.push('questions must be an array');
  if (questions.length < Math.max(6, config.count)) {
    errors.push(`expected at least ${Math.max(6, config.count)} questions`);
  }
  const seenQuestions = new Set();
  const seenInTopic = new Set();
  questions.forEach((raw, index) => {
    const where = `question[${index}]`;
    const question = normalizeLessonQuestion(raw, seenTopics);
    if (!question) {
      errors.push(`${where} is malformed`);
      return;
    }
    if (seenQuestions.has(question.id)) errors.push(`${where} repeats id ${question.id}`);
    seenQuestions.add(question.id);
    seenInTopic.add(question.topic);
  });
  for (const topic of seenTopics) {
    if (!seenInTopic.has(topic)) errors.push(`topic ${topic} has no questions`);
  }
  if (seenQuestions.size < config.count) {
    errors.push('not enough usable questions for one lesson');
  }

  return errors;
}
