# Expansion Specs — Side-Scroller, Shop/Town, Trading

**Baseline:** Play Park `929c78f` + cleanup `a463949` · 546 tests · save v4
**Status:** Specs for review · **Last updated:** 2026-11-01

---

## 0. Shared constraints

Three things shape all three tracks:

1. **Locations are data-driven but only two exist.** `data/world.json` + `src/locations.js`
   already carry ids, spawns, doors, labels, and a per-location save record. Adding a
   location is mostly data plus a map builder, not a new system.
2. **Travel supports one travel door per location.** `doorFor()` returns a single travel
   door; `doorsFor()` only adds extra *activity* doors. Multiple destination doors need
   either menu-only entry or generalising `doors` to a travel list.
3. **NPCs belong to the Park.** Park NPCs are generated, saved, and driven by the
   Park-scoped behaviour runtime. A shopkeeper is a new, location-scoped NPC pattern.

Everything below is a first slice, not the full vision.

---

## 1. Track A — Side-scroller expansion

### Vision

A small course board in the Park with three themed courses, a shared timer/ghost system,
climb and slide mechanics, best times, and a coin reward for finishing under par.

### First slice

| Item | Scope |
| --- | --- |
| Courses | The existing Jungle Gym plus two new ones: **Rooftops** (vertical, gaps) and **Shoreline** (long, low). Three total. |
| Mechanics | Run, jump, **climb** (ladders), **slide** (slopes). No swing, no wall-jump, no combat. |
| Selection | A course board at the Park entrance with three buttons and each course's par/best. |
| Ghost | Authored ghost per course, plus a **personal best** time per course. No recorded-path ghost in v1. |
| Reward | Coins for finishing; bonus under par. This finally gives the activity an economy role. |
| HUD | Existing strip + timer + par + delta; add best time. |
| Save | `activities: { "rooftops": { bestMs, clears }, … }` at the top level. |

### Systems reused

- `MiniGameHost` contract, fullview render mode, suspend/resume, settlement, strip, trace.
- `src/activities/jungle-gym.js` physics and renderer; extract shared physics into
  `src/activities/platformer.js` and make each course a data entry.
- `data/activities.json` becomes a map of activity entries, each with `course`, `physics`,
  `ghost`, `par`, `reward`, `enabled`.

### New work

- Ladder and slope collision (tagged course segments, not tile terrain).
- Course selection board + menu.
- Best-time persistence and comparison.
- Coin reward through the existing reward system.

### Risks

- Mechanics multiply tuning: ladders and slopes each need their own feel checks.
- Two new themes tempt art work; stay canvas-primitive until the mechanics are fun.
- Best times invite cheating/edge cases (pause, tab-away); use elapsed simulation time,
  not wall clock.

### Acceptance

- Three courses selectable, each finishable, with a par and a best.
- Climb and slide behave consistently; no falling through slopes at speed.
- Finishing pays coins once; returning to the Park preserves state.
- Best time survives reload; 360 px and touch work on all three.

**Estimate:** 5–7 dev days.

---

## 2. Track B — Shop and Town

### Recommendation up front

**Build the Shop. Defer the Town.** The Shop completes the economy that Home upgrades and
trading have already opened. A Town is a corridor until it has its own activity; adding it
now would repeat the "empty destination" problem the proposal warns about.

### Shop — first slice

A small interior location (reuse the Home wall/floor tiles, ~13 × 11 room) off the Park.

| Element | Scope |
| --- | --- |
| Location | `shop` in `data/world.json`: spawn, counter, return door, menu label. Entry from the Park menu; a visible shop door in the Park only if we generalise travel doors. |
| Shopkeeper | One static, non-wandering NPC with a fixed recipe/seed, a voice, and a greeting. Reuses the NPC card and dialogue, not the behaviour runtime. |
| Catalog | 4 new furniture pieces (piano, aquarium, floor cushion, wall clock) plus 3 upgrade tiers for existing pieces. Data-driven stock with prices. |
| Purchase | A shop panel like the trade card: item, price, balance, Buy, result. Adds the item to **Home storage** (owned but unplaced) or applies the upgrade. |
| Placement | Furnish mode grows an "owned, unplaced" list; placing consumes the storage entry. |
| Save | `home.storage: [{ itemId, variant }]`, `home.items[].tier`. |
| Economy | Coins from mini-games, races, and trading; the Shop is the sink. |

### What the Shop is not

- Not a building editor, not a stock market, not a second inventory screen with categories.
- No restock timers, no haggling, no reputation in v1.
- No new currency.

### Town — deferred

Only worth building when it has a distinct activity or connects three destinations. The
minimum viable Town would be an outdoor hub with doors to Park, Home, and Shop and two NPCs.
That is 3–4 days for navigation value only. **Recommendation: skip until a fourth
destination or an activity needs a hub.**

### Systems reused

- `locations.js` / `worldFor`, save `locations` map, travel prompt, minimap, NPC card.
- Trading UI patterns, item values, coins, rewards.
- Home item data, renderer shapes, Furnish placement.

### Main gap to close

`doorFor()` returns one travel door. For the Shop we can rely on the Park menu; if we want a
visible shopfront in the Park, extend `doors` to travel entries and render multiple markers.
Recommendation: menu-only entry first, visible doors when a second destination exists.

### Risks

- Shopkeeper NPC needs a location-scoped lifecycle the Park runtime does not have.
- Unplaced furniture adds a second inventory concept; keep it to a flat list.
- Upgrade tiers overlap the Home item card. Decide one owner: card for upgrades, Shop for
  new furniture and bundles.
- New furniture art is canvas shapes again; budget for it.

### Acceptance

- Walk into the Shop from the menu, talk to the shopkeeper, buy a piece, see coins drop.
- The purchase appears in Furnish as unplaced; place it, reload, it stays.
- Buying an upgrade changes the item's look and persists.
- Insufficient coins refuses with plain copy.
- 360 px shop panel and catalog work.

**Estimate:** Shop 4–5 dev days. Town +3–4 if later approved.

---

## 3. Track C — Trading expansion

### Recommendation up front

Expand **NPC offer variety**, not ownership. Player-to-player trading is out: the game is
single-player, and companion trading cuts against companions as identity. If companion
trading ever ships, it needs a separate design review, not a feature branch.

### First slice — dynamic NPC offers

| Element | Scope |
| --- | --- |
| Offer generation | Up to 3 offers from what the NPC owns and what the player owns, priced from `value` with a fairness band (0.8–1.2×). No per-NPC tables. |
| Offer refresh | Regenerated when the card opens if the NPC's inventory changed; deterministic per NPC + day/seed. |
| Multi-item | One side may list up to 2 item stacks; quantity still 1 per stack. |
| Affordability | NPC coins are real; an offer the NPC cannot afford is never shown. |
| UI | Existing card, shows up to three offers as a small list; select one, Confirm. |
| Result | Existing atomic `applyTrade`; a short history line ("traded 2 items") optional. |

### Later, only with explicit rules

- **Companion trading:** requires stabled-only eligibility, no equipped gear, a two-step
  confirm, and a permanent record of the transfer. It also needs a reason to exist; right
  now there is none.
- **Player-to-player:** out of scope for a single-player build. Revisit only with profiles
  or async mail, which is a different product.

### Systems reused

- `src/trade.js` (`validateOffer`, `canTrade`, `applyTrade`), item values, the NPC card,
  inventory/coins persistence.

### Risks

- Value-based pricing can be gamed (buy low, sell high) if the band is wide; keep buy/sell
  spreads explicit.
- Generated offers need determinism or the card flickers.
- Multi-item offers complicate atomicity; extend the transaction tests first.
- Companion trading risks duplication and orphaned parties; treat as a separate project.

### Acceptance

- A fresh NPC with stock offers up to three sensible trades; none exceeds their coins.
- Accepting applies once; declining changes nothing.
- Offers refresh after a trade without duplicating items.
- Multi-item offer tests cover both sides and every rejection reason.

**Estimate:** dynamic offers 2–3 dev days. Companion trading +3–4, not recommended now.

---

## 4. Recommended sequence

| Order | Work | Why | Estimate |
| --- | --- | --- | --- |
| 1 | Home 7c polish | Closes the interaction loop; cheap | 0.5 d |
| 2 | **Home upgrades** | The item card is the right home for tiers; coins need a sink | 3–4 d |
| 3 | **Shop** | Completes the economy; proves a third location; Town deferred | 4–5 d |
| 4 | **Side-scroller expansion** | Content-rich and isolated; can run in parallel with 3 if we accept two agents | 5–7 d |
| 5 | **Trading expansion** | Lowest urgency; dynamic offers only | 2–3 d |

**Total ≈ 15–20 dev days**, staged. Shop and side-scroller touch disjoint files and could be
parallelised later, but sequential keeps review and play-testing simple.

### Why this order

- Home upgrades and the Shop are the same economy story; splitting them wastes the item card
  work already shipped.
- The side-scroller is content, not architecture; it can slot anywhere after 7c without
  blocking the economy.
- Trading expansion is the least necessary and the most exploitable; do it last, narrowly.

---

## 5. What I would not build

- **A Town before a fourth destination.** It would be a corridor.
- **Player-to-player trading.** No multiplayer, no profiles.
- **Companion trading without rules.** Companions are identity; trading them needs a design,
  not a UI.
- **Swing mechanics and wall-jumps** in the first platformer expansion.
- **A second currency, restock timers, or shop reputation** in the Shop v1.
- **Recorded-path ghosts** before authored ghosts and best times are proven.

---

## 6. Open questions

1. **Shop entry:** menu-only (recommended for v1) or a visible shopfront in the Park, which
   means generalising travel doors?
2. **Shopkeeper:** a fixed new character, or one of the existing neighbours running the shop?
3. **Upgrade ownership:** item card (recommended) or Shop only?
4. **Side-scroller themes:** Rooftops and Shoreline, or would you rather one new course done
   deeply?
5. **Coins for racing:** flat finish reward plus an under-par bonus, or under-par only?
6. **Trading companion rule:** confirm companions stay untradeable for the foreseeable
   future.
