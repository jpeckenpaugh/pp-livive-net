/**
 * Pure formatting for the persistent game strip.
 *
 * The strip reuses the shell's `#hint` node. Copy (instructions and rejection
 * lines) comes from `data/minigames.json`; this module only chooses which line
 * applies and joins the parts. No DOM access.
 */

export const REJECT_REASONS = Object.freeze(['occupied', 'not-turn', 'off-square', 'illegal']);

function fill(template, values = {}) {
  return String(template).replace(/\{(\w+)\}/g, (match, key) => (
    values[key] === undefined ? match : String(values[key])
  ));
}

/** Data-driven rejection line for a closed reason key. */
export function reasonLine(copy, reason) {
  if (!reason) return null;
  const line = copy?.reasons?.[reason];
  return typeof line === 'string' && line.trim() ? line.trim() : null;
}

/** Name of the seat whose turn it is, falling back to "friend". */
export function turnNameFor(seats = [], seat = 1) {
  const listed = Array.isArray(seats)
    ? (seats.find(entry => entry?.index === seat) || seats[seat] || null)
    : null;
  return listed?.character?.name || listed?.name || 'friend';
}

/**
 * Compose the one-line strip: title · turn/outcome · instruction or rejection.
 *
 * @param {object} args
 * @param {object} args.state host.getState() result
 * @param {object} [args.copy] the `strip` block from data/minigames.json
 * @param {string} [args.turnName] opponent's name for "their turn"
 * @param {string} [args.keyLabel] "press Enter" or "tap X"
 * @param {{ reason: string }|null} [args.reject] the last rejected action
 * @returns {string|null} null when no session is active
 */
export function formatGameStrip({
  state = null,
  copy = {},
  turnName = 'friend',
  keyLabel = 'press Enter',
  reject = null
} = {}) {
  if (!state?.active) return null;

  const parts = [state.title || state.gameId || 'game'];
  const waiting = Number.isInteger(state.turnSeat) && state.turnSeat !== 0;

  if (state.settled) {
    const outcome = state.outcome || 'complete';
    const word = copy?.outcome?.[outcome] || copy?.phase?.ending || 'finished';
    parts.push(fill(word, { name: turnName }));
  } else if (Number.isInteger(state.turnSeat)) {
    parts.push(state.turnSeat === 0
      ? fill(copy?.turn || 'your turn', {})
      : fill(copy?.theirTurn || "{name}'s turn", { name: turnName }));
  } else if (!state.instruction) {
    // A no-turn state with its own instruction explains itself; only fall back
    // to the phase label when the game has nothing to say.
    parts.push(copy?.phase?.[state.phase] || state.phase || 'in play');
  }

  const rejection = state.settled ? null : reasonLine(copy, reject?.reason);
  if (rejection) {
    parts.push(rejection);
  } else if (!state.settled && !waiting && typeof state.instruction === 'string' && state.instruction.trim()) {
    parts.push(fill(state.instruction.trim(), { key: keyLabel }));
  }

  return parts.join(' · ');
}
