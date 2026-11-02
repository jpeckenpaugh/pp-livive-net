import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REJECT_REASONS,
  formatGameStrip,
  reasonLine,
  turnNameFor
} from '../../src/minigames/strip.js';
import data from '../../data/minigames.json' with { type: 'json' };

const copy = data.strip;

function state(overrides = {}) {
  return {
    active: true,
    gameId: 'tic-tac-toe',
    title: 'Tic-Tac-Toe',
    kind: 'board',
    phase: 'playing',
    settled: false,
    outcome: null,
    turnSeat: 0,
    instruction: 'step onto an empty square and {key} to claim it',
    ...overrides
  };
}

test('an inactive session has no strip', () => {
  assert.equal(formatGameStrip({ state: { active: false }, copy }), null);
  assert.equal(formatGameStrip({ state: null, copy }), null);
});

test('the strip joins title, turn, and the data-driven instruction', () => {
  assert.equal(
    formatGameStrip({ state: state(), copy, keyLabel: 'press Enter' }),
    'Tic-Tac-Toe · your turn · step onto an empty square and press Enter to claim it'
  );
});

test('coarse pointers get the touch label instead of a keyboard key', () => {
  const line = formatGameStrip({ state: state(), copy, keyLabel: copy.touchHint });
  assert.match(line, /tap X to claim it$/);
  assert.doesNotMatch(line, /press Enter/);
});

test("the opponent's turn names the seat", () => {
  const line = formatGameStrip({
    state: state({ turnSeat: 1, instruction: null }),
    copy,
    turnName: 'Fern'
  });
  assert.equal(line, "Tic-Tac-Toe · Fern's turn");
});

test('a finished match reports the terse outcome word', () => {
  for (const [outcome, word] of Object.entries(copy.outcome)) {
    const line = formatGameStrip({
      state: state({ settled: true, turnSeat: null, outcome }),
      copy
    });
    assert.equal(line, `Tic-Tac-Toe · ${word}`, outcome);
  }
});

test('a rejection replaces the instruction with the mapped reason line', () => {
  const line = formatGameStrip({ state: state(), copy, reject: { reason: 'occupied' } });
  assert.equal(line, 'Tic-Tac-Toe · your turn · that square is taken');
});

test('every closed reason has copy, and unknown reasons fall back to the instruction', () => {
  for (const reason of REJECT_REASONS) {
    assert.equal(reasonLine(copy, reason), copy.reasons[reason], reason);
  }
  const line = formatGameStrip({ state: state(), copy, reject: { reason: 'mystery' } });
  assert.match(line, /step onto an empty square/);
  assert.equal(reasonLine(copy, null), null);
});

test('the strip tolerates a game with no instruction', () => {
  assert.equal(
    formatGameStrip({ state: state({ instruction: null }), copy }),
    'Tic-Tac-Toe · your turn'
  );
});

test('turnNameFor reads seat names and falls back to friend', () => {
  const seats = [
    { index: 0, character: { name: 'You' } },
    { index: 1, character: { name: 'Fern' } }
  ];
  assert.equal(turnNameFor(seats, 1), 'Fern');
  assert.equal(turnNameFor([{ character: { name: 'Ash' } }], 0), 'Ash');
  assert.equal(turnNameFor([], 1), 'friend');
  assert.equal(turnNameFor(null, 1), 'friend');
});

test('a no-turn state with its own instruction skips the phase label', () => {
  assert.equal(
    formatGameStrip({
      state: state({ turnSeat: null, instruction: 'unfolding the board' }),
      copy
    }),
    'Tic-Tac-Toe · unfolding the board'
  );
  assert.equal(
    formatGameStrip({
      state: state({ turnSeat: null, instruction: null, phase: 'opening' }),
      copy
    }),
    'Tic-Tac-Toe · opening the board'
  );
});

test("the opponent's turn hides the player's instruction", () => {
  const line = formatGameStrip({
    state: state({ turnSeat: 1 }),
    copy,
    turnName: 'Fern'
  });
  assert.equal(line, "Tic-Tac-Toe · Fern's turn");
});
