# Priorities 02 — Architecture Analysis & Delivery Cycle

**Source:** `priorities02.md` (locations, Home, side-scroller, trading)
**Target:** Play Park at `459` tests, build `0cb54e3`
**Status:** Proposed · **Last updated:** 2026-11-01

---

## 1. Verdict

The proposal is sequenced correctly: one new location before several, companion presence
before construction, an activity before an economy, NPC trading before player trading. The
scope boundaries are the right ones.

Two things need adjusting before Phase 1 starts:

1. **Phase 1 and Phase 2 should ship as one milestone.** A Home with no companions is an
   empty second map. "Home slice" = location + travel + all buddies present + two
   behaviours + one placeable. That is the smallest thing worth play-testing.
2. **Phase 3 is the only genuine architecture risk.** Everything else extends systems that
   already exist. The side-scroller does not: it needs its own physics, collision, camera,
   and render pass. Treat it as a new activity module behind the existing mini-game
   contract, not as a mode bolted onto `Game`.

Trading is feasible now because NPCs already own inventory, equipment, and coins. What is
missing is a value model — the item catalog has no `value` or `price` field today.

---

## 2. What can be reused as-is

| Need | Existing system | Fit |
| --- | --- | --- |
| Swap maps at runtime | `Game.setWorld({terrain, worldSeed, player, npcs, companions, scenery, forage})` and `setPreview` | **Direct.** The wizard already swaps terrain; the renderer rebuilds the minimap. |
| Terrain generation and storage | `generateWorld(seed)`, `encodeTerrain`/`decodeTerrain` (4,096 chars) | **Direct** for a 64×64 Home. |
| Companion party | `game.companions`, `getCompanionsFor`, `player.stabledCompanions`, behaviour runtime | **Direct** for active buddies; stabled records need instantiating for display. |
| Activities | `MiniGameHost` open/ready/input/close/settle, staging, settlement, strip, trace, voice events | **Direct** for a side-scroller session; the renderer and input are the new parts. |
| Inventory, currency, equipment | Player and NPC `inventory`, `equipped`, `coins`; NPC economy from Phase 2 | **Direct** for NPC trading. |
| Travel UI | Player menu (`panels.js`), dialogue, toasts, NPC card actions | **Direct** for a "Home" entry. |
| Save migrations | `SAVE_VERSION`, `migrateSave` accepts 1..N, `test/storage.test.js` fixtures | **Direct**, but the v4 shape needs deciding before Phase 1. |

**Hard constraint:** the world is 64×64 by construction. `WORLD_SIZE` appears in 55 places
across `world.js`, `game.js`, `renderer.js`, `staging.js`, and `forage.js`. Generalising map
dimensions is a real refactor, not a parameter.

**Recommendation:** do **not** generalise it for Phase 1. Make Home a 64×64 lot containing a
modest house and yard. If the room reads as too large in play-testing, schedule a
dimension refactor as its own slice with tests, not as a hidden part of the Home work.

---

## 3. Data model before Phase 1

The current save stores one world. Phase 1 needs a location map. Bump to **v4** and migrate
v1–v3 by wrapping the existing state as `park`.

```json
{
  "version": 4,
  "currentLocation": "park",
  "locations": {
    "park": {
      "seed": "willow-…", "terrain": "gggg…",
      "player": { "x": 32, "y": 30, "direction": "down" },
      "npcs": [ … existing records … ],
      "forage": { … }, "scenery": [ … ]
    },
    "home": {
      "seed": "acorn-…", "terrain": "wwww…",
      "player": { "x": 12, "y": 10, "direction": "down" },
      "npcs": [],
      "decor": [ { "id": "rug-round", "x": 10, "y": 8 } ],
      "buddies": [ { "companionId": "comp_…", "x": 9, "y": 7, "pose": "sit" } ]
    }
  },
  "player": { "inventory": …, "coins": …, "equipped": …, "stabledCompanions": … },
  "companions": [ … shared party records … ],
  "friends": [ … ], "behavior": { … }
}
```

Rules:

- **Shared:** player gear, currency, friends, the companion roster, voice specs.
- **Per location:** terrain, seed, player position, NPCs, forage, scenery, decor, buddy
  placement.
- **Migration:** v3 → v4 wraps the existing world as `park` and generates Home lazily on
  first travel; no terrain rewrite for the Park.
- **Travel must close any active mini-game session** before the swap; a board cannot span
  locations.
- **Behaviour runtime** is Park-scoped. Reset or suspend it on travel rather than carrying
  stale targets across maps.

This is the only migration that needs doing before Phase 1. Trading needs no new top-level
save shape; it mutates existing inventories and coins atomically.

---

## 4. Milestone 1 — the Home slice (Phases 1 + 2)

**Goal:** walk from the Park into Home, see every buddy, change one thing, walk back, and
find the Park exactly as you left it.

| Task | Notes |
| --- | --- |
| Save v4 + migration | Locations map, current location, per-location state; tested v1/v2/v3 → v4. |
| Home map | `generateHome(seed)`: one room + small yard, walls, door, spawn, no NPCs. 64×64 lot. |
| Travel | A visible door in the Park and a "Home" row in the player menu; return door in Home. Current location named in the HUD. |
| Location swap | `Game.setWorld` for terrain/positions; close sessions; suspend behaviour; rebuild minimap; restore Park state untouched. |
| Companion presence | Instantiate active + stabled buddies as Home characters; place around the room; no party change. |
| Two behaviours | Idle wander inside the room, and sit on a rug/spot when nearby. No social scoring, no pathfinding across the lot. |
| One decoration | A rug and a plant the player can place or swap; persisted in `home.decor`. |

**Deliberately not in this milestone:** multiple destinations, building/editor, furniture
catalogue, companion trading, Home NPCs, world-size refactor.

**Acceptance (also the play-test checklist):**
- Enter, return, and re-enter without losing player or companion state.
- Park activities, friends, forage, and any active effects survive the round trip.
- Every owned buddy is findable and distinguishable in Home.
- At least two behaviours happen without commands.
- One decoration change persists across reload.
- Save from v3 migrates cleanly; a v4 save reloads identically.
- 360 px and touch controls work in Home.

**Estimate:** 4–6 dev days across three waves — save/location, Home content, companions +
decor.

---

## 5. Milestone 2 — the jungle-gym activity (Phase 3)

This is the only phase that adds a new engine.

**Architecture:** a new `src/activities/` module implementing the mini-game contract, with
its own fixed-step physics and render pass, opened as a host session (`kind: 'activity'`).
The Park's top-down loop pauses exactly as it does for a board. Reuse the host lifecycle,
settlement, game strip, trace, and voice cues.

**Scope cut for v1:** run, jump, one finish line, one short course, one scripted
time-based competitor drawn as a billboard. **Defer** slide and swing. Add climb only if the
course genuinely needs it; ladders are cheap, swinging is not.

**Known risks:**
- **Art:** DiceBear avatars are front-facing SVGs, not side-view sprite sheets. Use them as
  billboards in v1; do not commission art before the course is fun.
- **Physics:** fixed timestep, coyote time, and one-way platforms are the whole game feel.
  Budget tuning time; do not fold it into the Park's tile movement.
- **Input:** reuse left/right and Enter/Space; the touch d-pad and action button already
  exist. Do not add a second control scheme.
- **Return state:** the host must close the session and hand control back to `Game` without
  a camera jump or a paused loop.
- **Scope:** one course, one competitor, no obstacle editor.

**Estimate:** 4–6 dev days for a playable slice, plus tuning.

---

## 6. Milestone 3 — NPC trading (Phase 4)

The plumbing exists: NPCs have inventories, equipment, and coins; the player has the same;
the save persists all of it. The missing piece is **value**.

**Minimal offer:** one fixed barter type — coins for one item, or one item for one item —
presented as a two-column offer with both sides visible and one explicit confirm.

**Prerequisites:**
- Add a numeric `value` to `data/items.json` (data-driven valuation; no hardcoded prices).
- Define what cannot be traded: equipped items, quest items, companions (deferred).
- One atomic apply: validate both sides, mutate once, save immediately, show the result.
- Reject with a reason ("not enough coins", "inventory full", "they won't part with it").

**Risks:** duplicated or negative trades, trading an equipped item, losing items on a
failed save. Cover with pure transaction tests before UI.

**Estimate:** 2–3 dev days.

---

## 7. Development and deployment cycle

The repo deploys `main` straight to `pp.livive.net`. That constrains the process more than
the feature design does: **nothing half-built should be reachable in production.**

### Per slice

| Step | Output |
| --- | --- |
| 0. Decision doc | Shape, scope, acceptance, and the play-test checklist written before code. |
| 1. Orient | One agent reads the sources and returns questions only. |
| 2. Converge | PM + human settle the questions; decisions recorded in the doc. |
| 3. Build | One agent per wave; no parallel agents on the same files. |
| 4. Verify | `npm test`, `npm run voice:vendor -- --check`, static checks. |
| 5. Human play-test | The checklist, on desktop and 360 px, plus one phone where it matters. |
| 6. Commit + deploy | Commit, push, watch the Pages run, verify the live asset. |
| 7. Retro note | What changed in the plan; what the next slice inherits. |

### Keeping production safe between slices

- **Commit only reachable work.** A Home that cannot be entered is harmless; a Home that
  can be entered with no companions is confusing. Land the travel entry last, or behind a
  data flag (`data/world.json` → `locations.home.enabled: false`) until the slice is whole.
- **Save migrations land early and alone.** v4 and its fixture tests can ship before Home
  is reachable; the save shape is then stable for the whole milestone.
- **One slice at a time.** Do not start the side-scroller while Home is uncommitted; two
  uncommitted features make rollback and review ambiguous.
- **Rollback** is `git revert` plus a redeploy. A forward-only save migration is the one
  thing that cannot be rolled back in a player's browser, so migration tests matter more
  than usual.
- **Worktrees** are worth it only for the side-scroller, where a long-lived experimental
  branch is expected. Home and trading fit the current working-tree flow.

### Suggested dispatch order

| Wave | Work | Gate |
| --- | --- | --- |
| 0 | Location/save decision doc + v4 migration | Fixtures green, no UI |
| 1 | Home map + travel entry/exit + location swap | Human walks both ways |
| 2 | Companion presence + two behaviours + decoration | Human checks the checklist |
| 3 | Side-scroller spike (physics only, no art) | Playable grey-box course |
| 4 | Side-scroller activity + host integration | Finish and return cleanly |
| 5 | Item values + trade transaction (pure) | Transaction tests |
| 6 | Trade UI | Human completes and declines a trade |

Each wave is one agent, one human check, one commit. The grey-box spike in wave 3 is the
cheapest way to find out whether the side-scroller is fun before committing to art or
course content.

---

## 8. Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| 64×64 Home reads as an empty warehouse | Medium | Build the room at the centre with a yard; if it still feels wrong, schedule a dimension refactor as its own slice |
| Save v4 migration corrupts an existing park | High | Fixture tests for every version; migrate lazily; never rewrite Park terrain |
| Travel leaves stale mini-game or behaviour state | Medium | Close sessions and suspend behaviour before `setWorld`; assert in tests |
| Companion duplication between Park and Home | Medium | Home displays the same companion records; party membership changes only through the existing panel |
| Side-scroller destabilises Park movement | High | Separate module and loop; no changes to tile movement; grey-box spike first |
| Side-scroller art mismatch | Medium | Billboard the existing avatars; art decision after the course is fun |
| Trade duplication or negative inventory | High | Pure transaction function, atomic apply, reject reasons, tests before UI |
| Production gets a half-built location | Medium | Land travel last or flag it off; one slice in flight at a time |
| Scope creep into multiple destinations | High | The proposal's own boundary: add a destination only with a distinct activity |

---

## 9. Scope adjustments I recommend

1. **Merge Phases 1 and 2** into the Home slice.
2. **Home is a lot, not a room** for v1; keep the 64×64 engine untouched.
3. **Two companion behaviours, one decoration** — not a catalogue.
4. **Side-scroller: run + jump + finish only.** Climb optional, slide and swing deferred.
5. **Trading: one offer type, NPC only.** Add item `value` first; no companion trading.
6. **No Shop/Town/Island/Theme Park** until a destination has an activity.
7. **One slice in flight.**

---

## 10. Open questions

1. **Home scale:** 64×64 lot with a centred house (recommended), or generalise map size now?
2. **Travel affordance:** a visible door in the Park only, a HUD "Home" row only, or both?
   Recommendation: both — the door teaches, the menu rescues.
3. **Companion cap in Home:** show all owned buddies, or cap the visible group and add a
   "collection" wall past 12?
4. **Side-scroller camera:** fixed horizontal follow with no zoom (recommended) or a
   scrolling course with a vertical component?
5. **Competitor:** a scripted timer ghost (recommended) or a simple AI on the same course?
6. **Trading values:** add `value` to the item catalog (recommended) or a small barter table
   per NPC?
7. **Home NPCs:** none in v1 — confirm.
8. **Feature flags:** a `data/world.json` enabled flag for Home during the slice, or rely on
   "travel lands last"?
