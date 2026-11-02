# Playtest Recommendations 01 — Analysis & Action Plan

**Source:** `recommends01.md` (external live-test review, November 2026)
**Target:** Play Park (`pp.livive.net`) · **Basis:** build `0787afe` (voice integration released)
**Status:** Proposed · **Last updated:** 2026-11-01

---

## 1. Verdict

The review is directionally right: the two highest-value items are **social discovery**
(#1) and **board guidance** (#2), and both are real gaps rather than polish. Two of the
five need qualification:

- **#4 is mostly a visibility problem, not a lifecycle problem.** `MiniGameHost` already
  has `ready → active → ending → settled` phases, one session at a time, and a single-settle
  guard. What is missing is a persistent, player-visible status line and a rejection trace —
  not a lifecycle rewrite.
- **#5 is largely shipped.** Mute and volume already persist (`playpark.voice.v1`), zero
  volume is silent, keyboard and touch both operate the control, and playback failure falls
  back silently. The real deltas are a first-use cue, a debug readout, and the subtitle
  idea — and the subtitle does not currently work the way the review assumes (see §6).

| # | Recommendation | Current state | Real gap | Value | Effort | Risk | Priority |
|---|---|---|---|---|---|---|---|
| 1 | Discoverable friendship / invites | Bump-to-talk only; NPC card has no actions | Card actions + status | High | 1–1.5 d | Low | **P0** |
| 2 | Teach board controls | Transient toasts inside each game | Persistent prompt, target highlight, turn | High | 1.5–2 d | Low | **P0** |
| 3 | Keep the board readable | Camera follows the player; dialogue can overlap | Framing + occlusion | High | 1.5–2 d | Medium | **P1** |
| 4 | Explicit lifecycle + diagnostics | Phases exist; toasts are transient | Status strip + debug trace | Medium | 1 d | Low | **P1** |
| 5 | Testable voice path | Persistence, keyboard, touch, failure fallback done | First-use cue, debug readout, subtitle | Medium | 0.5–1 d | Low | **P1** |

**Recommended order:** #1 → #2 → #5 → #4 → #3. Ship #1 and #2 before touching the camera,
because both reduce the confusion that #3 is trying to solve, and #3 is the only item that
can make the game feel worse if tuned badly.

---

## 2. #1 — Make friendship and invites discoverable

**What exists.** Clicking an NPC selects them and opens the NPC card
(`panels.showCard`), which today shows the avatar, vibe, effects, roster, and only
**New look** / **Remove**. Talking is bump-only (`game.onDialogue`). Friendship is a
prerequisite for table games (`tableGamesFor`, `onPlayGame`). The card is the natural
surface, and it already has the character and the friends set.

**What to build.** A contextual action row in the card, for neighbours only:

| Action | Shown when | Behaviour |
| --- | --- | --- |
| **Talk** | Always | Opens the existing dialogue beat (same path as bump) |
| **Ask to be friends** | Not already a friend | Opens the existing stranger beat with Yes / No |
| **Invite to play** | Friend, and at least one board owned | Opens the game chooser or starts the primary board |
| Friendship badge | Always | `Friend` / `Not friends yet` beside the name |

Eligibility is stated in place: a non-friend sees "Become friends to play board games"
rather than a disabled button with no explanation.

**Why the card and not a new modal.** `showCard` already has the character, the friends
set, and the game reference. The card is already `aria-live` and closes cleanly. A new
modal would duplicate that state and add another pause path.

**Risks.** The card grows; at 360 px the action row must wrap or become a sticky footer.
Opening a dialogue from the card must close the card and pause movement, exactly as a bump
does. Companions and the player keep the current card.

**Acceptance.**
- A new player can talk, befriend, and invite from the card without knowing about bumping.
- Bump-to-talk still works unchanged.
- A non-friend sees why play is unavailable; a friend sees their boards.
- Card actions are keyboard reachable and at least 36 px tall on touch.

**Files:** `src/ui/panels.js` (card render), `index.html` (action row), `css/app.css`,
`src/main.js` (action handlers), `test/` for any pure eligibility helper.

---

## 3. #2 — Teach board controls in the moment

**What exists.** Each game already toasts the right instruction
(`tic-tac-toe.js:422,445`, `checkers.js:538,712`, `chess.js:585,712`), and `Enter`/`Space`
is the action key. The problem is that a toast is transient and the generic `#hint` bar
still says "bump into a neighbour to talk" while a board is open.

**What to build.**

1. **A persistent game strip** while `host.getState().active` is true: game title, phase,
   whose turn, and the one-line instruction. Reuse `#hint` or add a sibling; do not stack
   another toast.
2. **A target highlight** on the tile under the player and the tile they are facing, using
   the game's own validity check where one exists.
3. **Explicit rejection feedback** in the strip: "Square taken", "Not your turn", "Step
   onto a square first" — replacing the one-off toast.
4. **Touch parity:** the existing on-screen Enter button is the action; label it in the
   strip on coarse pointers.

**Why this is cheap.** The turn/phase data already exists in each game and in
`host.getState()`; the target tile is `facingTile()` in `main.js` plus the game's
`canPlace`/`isLegal` check. No new state machine.

**Acceptance.**
- The active square is visually clear before the action key is pressed.
- A valid move places one token; an occupied square says so in the strip.
- Turn changes are visible without watching a toast.
- The strip clears on pack-up and on settle.

**Files:** `src/main.js` (strip + target + rejection), `src/games/*.js` (expose a
validation/reason helper if not already public), `css/app.css`, `index.html`.

---

## 4. #3 — Keep the board readable while moving

**What exists.** `game.cameraFocus()` returns the player, and `updateCamera` clamps to the
world. `host._footprint()` knows the board's tile rectangle. Dialogue is positioned near the
NPC and can cover squares.

**What to build (recommended).** A game-aware focus point: during an active session, the
camera eases toward the midpoint of the player and the board centre, weighted so the player
stays inside the viewport. No second board UI, no fixed panel — the shared-world board is
the identity of the feature.

- If the player walks far from the board, clamp the focus so the board stays on screen
  rather than following the player off it.
- Raise the dialogue bubble in front of the board's z-order or shift it above/below the
  footprint.
- On narrow screens, reduce the focus blend so the player remains obvious.

**Why it is P1 and not P0.** #2's highlight and turn strip already remove most of the
uncertainty. Camera work is the item most likely to feel wrong and needs a human pass per
device.

**Acceptance.**
- Every square stays visible while the player walks the full perimeter.
- The player can tell where they are relative to the board.
- Closing a dialogue never leaves a square hidden.
- No motion sickness on the 360 px layout; the camera never snaps.

**Files:** `src/game.js` (focus), `src/main.js` (set/clear board focus), `css/app.css`
(dialogue layering).

---

## 5. #4 — Lifecycle visibility and diagnostics

**What exists.** `MiniGameHost` already has phases, a single session, a single-settle
guard, and `getState()`. Rejections are returned as `{ ok: false, reason }` internally but
surfaced only as toasts.

**What to build.**

1. **Player-facing:** the game strip from #2 is the lifecycle display. Add a clear
   **finished** state in the strip ("You won" / "Draw" / "Abandoned") that persists until
   the end dialogue is dismissed.
2. **Developer-facing:** a ring buffer of the last ~50 host events — game id, phase, turn,
   action, accept/reject reason — shown in the existing **Debug** tab. No new panel, no
   console noise, no URL flag.

**What not to do.** Do not refactor the host into a new lifecycle. It already behaves; the
review saw a visibility gap, not a state bug.

**Acceptance.**
- A player can say whether a match is active, finished, or packed up without guessing.
- The Debug tab shows the last transition and why an action was rejected.
- The trace is capped and cleared on park load.

**Files:** `src/minigames/host.js` (append events), `src/ui/panels.js` (Debug tab),
`src/main.js` (wire), `test/` for the ring buffer.

---

## 6. #5 — Voice controls: what is already done, and the subtitle trap

**Already shipped and verified.**

- Mute and volume persist under `playpark.voice.v1`.
- Zero volume is silent; raising the slider unmutes.
- Keyboard: Tab to ▾, Enter opens, arrows adjust, Escape closes and returns focus.
- Touch: the popover becomes a full-width sheet at ≤520 px.
- Playback failure resolves `false`, logs one line, and never affects dialogue.

**Real deltas.**

1. **First-use cue** — one short, dismissible line the first time a voice plays:
   "Neighbours speak their own language. 🗣 mutes them." Store a `hintShown` flag in the
   voice prefs. Low risk, high clarity.
2. **Debug readout** — in the Debug tab, show the selected NPC's `lang`, `voiceId`, the
   three knobs, `lastError`, and whether the last line was a cache hit. This is the
   "playback succeeded" inspection the review asks for, without developer docs.
3. **Subtitle** — **defer, and say why.** The spoken cue is not a translation of the
   English dialogue. "Hi, I'm Marisol. Good to see you again!" is spoken as
   "¡Qué bueno verte!" — a fixed corpus line chosen by hook, not a translation of the
   sentence. A subtitle would show a short unrelated phrase and make the mismatch more
   confusing, not less.

   The subtitle only becomes correct when the corpus lines are authored per dialogue line
   (upstream `inputs.json`) rather than per hook. That is a content project, not a UI
   toggle. Until then, the language chip plus the first-use cue is the honest affordance.

**Acceptance.**
- The first-use cue appears once and never again after dismissal.
- The Debug tab identifies the NPC's voice and the last playback outcome.
- No subtitle ships in this pass; the plan records why.

**Files:** `src/main.js`, `src/voice/prefs.js` (`hintShown`), `src/ui/panels.js` (Debug),
`data/voice.json` (cue copy), tests for the flag.

---

## 7. Wave plan

| Wave | Items | Why together | Estimate |
| --- | --- | --- | --- |
| **A** | #1 social actions | Highest value, self-contained, no game-state coupling | 1–1.5 d |
| **B** | #2 board guidance + #4 status strip | Both read the same host/game state; #4's trace supports #2's rejection reasons | 2–2.5 d |
| **C** | #5 voice affordances | Small, touches the same shell as A; do after A to avoid churn | 0.5–1 d |
| **D** | #3 camera framing | Needs human tuning; do last, with B in place | 1.5–2 d |

Total ≈ **5–7 dev days**, with a human check after each wave.

---

## 8. What I would not do now

- **A new board UI or fixed game panel.** It duplicates state and abandons the in-world
  board that makes the game distinctive.
- **A lifecycle rewrite.** The host is sound; #4 is a display and trace problem.
- **Subtitle without aligned lines.** It would expose the hook-vs-dialogue mismatch.
- **Auto-friending on click.** Keep the Yes/No beat; discovery is the problem, not consent.
- **Camera lock during games.** It fights player agency; a weighted focus is enough.

---

## 9. Open questions

1. **Card actions vs. a radial/context menu.** Card is simpler and already has state. Agree?
2. **"Invite to play"** — open the chooser every time, or start the last-played board when
   only one is owned? Recommendation: chooser when >1 board, otherwise start it.
3. **Game strip location** — replace `#hint`, or add a second line under the topbar?
   Recommendation: replace `#hint` while a game is active, restore it after.
4. **Camera blend** — 50/50 player/board midpoint, or clamp the existing player focus to
   the board rectangle? Recommendation: midpoint with a clamp, tuned by hand in wave D.
5. **First-use voice cue** — toast, or a line inside the dialogue on the first voice
   beat? Recommendation: toast tied to the speaker button, once.
6. **Debug trace retention** — 50 events in memory only, or also `sessionStorage` for a
   post-reload look? Recommendation: memory only in v1.
