# Play Park — Phase 2

**Status:** Proposed  
**Owner:** Project manager (AI)  
**Human acceptance:** Repository owner / live tester  
**Baseline:** `dca9098`, 223/223 tests passing  
**Theme:** Let NPCs own, earn, equip, and grow — then add more games on top.

---

## 1. Executive summary

Phase 1 shipped a reusable mini-game contract, effect items, and data-driven behaviors. Phase 2 should make the **existing** game loop dynamic before adding more mini-games:

- NPCs earn rewards when they win NPC-vs-NPC games.
- NPCs own real inventories and multiple companions.
- NPCs automatically equip ability items on themselves and their companions.
- NPCs grow over time: more buddies, more worn effects, more visual variety.
- Everything reuses existing concepts: items, effects, companions, rewards, behaviors, saves.

**Recommendation:** make **NPC ownership + economy** the first two waves. Add new mini-games only after that loop is proven, because every new game then immediately participates in the NPC economy without extra work.

---

## 2. What exists today

| Concern | Current behavior |
| --- | --- |
| NPC inventory | `makeCharacter` stores `inventory`, `equipped`, `coins`, `stabledCompanions`, but NPC save only persists inventory/equipped. NPC items are starter toys and are not used for effects. |
| NPC companions | Every NPC gets exactly one buddy at creation (`npc.companion` → flat `game.companions` entry). `getCompanionsFor(id)` already supports many; nothing creates more. |
| NPC game rewards | NPC-vs-NPC sessions explicitly suppress settlement (`record:false`, `reward:false`, `settle:false`) in `src/behavior/actions/social.js`. The winner gets nothing. |
| Player rewards | `rollReward`/`applyReward` hardcode `buddyId: 'player'`, player inventory, and the player’s 3-active-companion cap. |
| Effects | `equip(character, item)` already works for any character with an inventory; `resolveFx(character, now, owner)` already supports self + party effects for NPCs and companions. |
| Multiple buddies | Behaviors already support many companions per buddy and distinct follow slots. The roster is the only missing piece. |
| Persistence | Save v2 persists NPC inventory/equipped and all companions, but not NPC coins, NPC reserve companions, or an NPC roster policy. |
| UI | Character card shows worn effects; no NPC buddies list, bag, or inventory management. Debug exposes grants only for the player. |

**Key insight:** the hard systems already exist. Phase 2 is mostly ownership plumbing, a reward policy, an auto-loadout policy, caps, and UI.

---

## 3. Target model

### 3.1 Ownership

Every character — player, NPC, or companion — can own:

```js
{
  id,
  coins,
  inventory: [{ id, uid, ... }],
  equipped: [{ slot, uid }],
  activeCompanions: [companionRefs],   // derived from game.companions by buddyId
  reserveCompanions: [companionData]   // persisted collection, not rendered
}
```

Companions remain in the flat `game.companions` array with `buddyId`; active NPC buddies are simply more entries there. Reserve buddies live in `npc.stabledCompanions` (mirroring `player.stabledCompanions`).

### 3.2 Caps

Recommended defaults, data-driven in `data/engine_config.json`:

```json
"companions": {
  "playerActiveMax": 3,
  "npcActiveMax": 2,
  "npcReserveMax": 6,
  "globalActiveMax": 80
}
```

- **2 active buddies per NPC** keeps the park readable and bounds behavior/pathfinding work.
- Extra buddies go to that NPC’s reserve collection. They still own their gear and can be activated later via debug/card.
- **Global active cap** is a safety valve. If exceeded, the newest reward goes to reserve rather than spawning another follower.
- At 40 NPCs × 2 active + player 3, the world tops out around 83 companions. This is the practical ceiling to test against.

### 3.3 NPC rewards

Add a separate NPC economy in `data/rewards.json`:

```json
"npcMiniGames": {
  "tic-tac-toe": {
    "win": {
      "coins": 2,
      "itemChance": 0.7,
      "itemPool": "npc_effect_pool",
      "companionChance": 0.8,
      "bonusLootTable": "npc_ttt_loot"
    },
    "draw": { "coins": 1 },
    "loss": {}
  }
},
"npcLootTables": {
  "npc_effect_pool": ["big-o-bracelet", "chamo-clip", "hover-halo", "prism-pin", "echo-bell", "bouncy-boots", "glowworm-jar", "lucky-clover", "buddy-cape", "teleport-tricorder"]
}
```

- NPC wins can grant an ability item and/or a new buddy.
- Draws grant a small coin amount; losses grant nothing (keeps the loop moving).
- Player-facing stats, rewards, and end dialogues remain suppressed.
- Notification: a speech bubble or toast only when the player is nearby (e.g. 10 tiles); the character card always shows the result.

### 3.4 NPC game settlement

Extend the NPC game adapter, not the core contract:

- `createNpcGameAdapter` gains an `onResult` callback.
- When the NPC TTT driver finishes, it calls:

```js
onResult({
  winnerId, loserId, outcome: 'win' | 'draw' | 'loss',
  gameId, token, session
})
```

- Main resolves the winner NPC, calls `rewardNpcGame(winner, gameId, outcome)`, then:
  - applies owner-specific rewards,
  - auto-equips new items,
  - syncs the behavior world,
  - saves,
  - emits a nearby bubble/toast if appropriate.
- No player `recordGameResult`, player loot, player dialogue, or player cheer.

### 3.5 Auto-loadout

New pure module: `src/npc/loadout.js`.

Policy for v1:

1. NPC acquires item(s).
2. Sort candidate items by `effect.ai.priority` (new metadata in `data/effects.json`).
3. Try to equip each on the NPC’s own free slot.
4. If no free slot, try each active companion with a free slot.
5. If nothing fits, leave it in the NPC’s bag.
6. Never swap or discard worn effects automatically.
7. Party effects (`buddy-cape`) prefer the owner so the whole party benefits.
8. Teleport/Chamo/Big-O are valid on NPCs and companions; the renderer already supports both.

Example metadata:

```json
"big-o": { "ai": { "priority": 50, "target": "self" } },
"chamo": { "ai": { "priority": 40, "target": "self" } },
"buddy-cape": { "ai": { "priority": 60, "target": "self" } },
"echo-bell": { "ai": { "priority": 20, "target": "any" } }
```

Auto-loadout runs only on acquisition or roster change, never every frame.

### 3.6 Multiple buddies and effect inheritance

- Active NPC buddies are normal companions in `game.companions`; the existing follow assignment and distinct follow slots work per `buddyId`.
- `syncBehaviorWorld` runs after NPC reward/roster changes so new buddies follow immediately (same fix already applied to player rewards).
- Items equipped on an NPC’s companion apply to that companion via `resolveFx(companion, now, owner)`.
- Party effects equipped on the NPC apply to all its active companions.
- Reserves are not rendered and consume no behavior/pathfinding budget.

---

## 4. Data and schema changes

| File | Change |
| --- | --- |
| `data/engine_config.json` | Companion caps (`playerActiveMax`, `npcActiveMax`, `npcReserveMax`, `globalActiveMax`). |
| `data/rewards.json` | `npcMiniGames` specs, `npcLootTables`, NPC effect pools. |
| `data/effects.json` | Optional `ai: { priority, target }` per effect for auto-equip. |
| `src/rewards.js` | Owner-parameterized `rollReward`/`applyReward`; NPC reward policy; caps; reserve fallback. |
| `src/npc/loadout.js` (new) | Pure auto-equip planner and item transfer. |
| `src/behavior/actions/social.js` | NPC result callback with winner/loser/outcome. |
| `src/main.js` | NPC reward callback, nearby notification, card/debug wiring. |
| `src/ui/panels.js` + `css/app.css` | NPC card: buddies, bag, worn effects, reserve count; debug actions. |
| `src/storage.js` | Persist NPC `coins`, `stabledCompanions`, plus existing gear; keep v2 or add optional fields. |
| `src/game.js` | Roster helpers: active/reserve counts, add/activate companion for any owner. |
| `AGENTS.md` / `README.md` | Document NPC ownership and economy. |

### Save compatibility

- Keep `playpark.save.v1` key and `version: 2`.
- Add optional `npc.coins` and `npc.stabledCompanions`; old saves default to `0` / `[]`.
- Existing NPC companions remain active with their `buddyId`.
- No migration is required beyond defaults; if a future shape change is needed, bump to v3 with a migration test.

---

## 5. UI and observability

### Character card (NPC)

- Header: name + vibe.
- **Buddies (2 active / 1 reserve)** with small avatars and effect chips.
- **Worn effects** on the NPC.
- **Bag** count + item list (read-only initially).
- **Recent wins / rewards** summary (optional).

### Backpack / player UX

No change to player ownership. The existing “apply to you or companion” picker stays.

### Debug tab

- "Give selected NPC a random ability item"
- "Give selected NPC a buddy"
- "Simulate NPC win" (rewards the selected NPC and auto-equips)
- "Auto-equip NPC gear"
- "NPC economy summary" (active/reserve counts, item counts, global caps)

### Notifications

- Nearby player: short world bubble/toast, e.g. `"Fern won Tic-Tac-Toe and found a Hover Halo."`
- Otherwise silent, but visible on the NPC card.
- No modal dialogues, no player rewards.

---

## 6. Work breakdown and sub-agent plan

### Wave 0 — baseline (PM, ~5 min)

- Confirm clean tree and `npm test` 223/223.
- Freeze schemas for NPC rewards, caps, loadout, and result callback.
- Commit the phase plan.

### Wave 1 — ownership and rewards foundation (parallel)

| Agent | Owns | Deliverable |
| --- | --- | --- |
| **N1** `npc-economy-core` | `src/rewards.js`, `data/rewards.json`, `data/engine_config.json`, `test/npc-economy.test.js` | Owner-parameterized rewards, NPC specs/loot, caps, reserve fallback, tests |
| **N2** `npc-result-settlement` | `src/behavior/actions/social.js`, `test/behavior-social-actions.test.js` | Winner/loser result callback from NPC games; no player settlement |
| **N3** `npc-roster-save` | `src/game.js`, `src/storage.js`, `test/storage.test.js` | Roster helpers, NPC reserve persistence, active/reserve counts, save round-trip |
| **N4** `npc-loadout` | `src/npc/loadout.js`, `data/effects.json`, `test/npc-loadout.test.js` | Pure auto-equip planner + AI metadata + item transfer |

### Wave 2 — integration and UX (parallel, after Wave 1 interfaces are stable)

| Agent | Owns | Deliverable |
| --- | --- | --- |
| **N5** `npc-runtime-integration` | `src/main.js` reward/result handler, `test/acceptance.test.js` additions | Wire result → reward → loadout → behavior sync → save → nearby notice |
| **N6** `npc-roster-ui` | `src/ui/panels.js`, `css/app.css`, `index.html` if needed | NPC card buddies/bag/effects; debug grant/simulate controls |
| **N7** `qa-verifier` | new acceptance tests only | NPC win → item/buddy → auto-equip → follow; caps; reload; performance fixture |

### Wave 3 — new games on the now-dynamic loop (optional, after Phase 2A acceptance)

- Add 2–3 simple mini-games using the existing contract (Memory Grid, Race, Timing/Reaction).
- Let NPCs auto-play whichever games they already have.
- Then NPC checkers/chess auto-play if desired.

**Recommended timing:** two 45–60 minute waves for NPC economy, plus a third wave for new games. Do not mix new-game work into the ownership/reward wave; it makes regression triage harder.

---

## 7. Acceptance criteria

### NPC rewards

- An NPC winning an NPC-vs-NPC game receives a configured item and/or companion.
- No player stats, coins, inventory, dialogue, or cheer occur.
- Draw/loss follow the configured policy.
- Rewards are persisted and survive reload.

### Ownership and caps

- NPCs can have multiple active buddies up to `npcActiveMax`.
- Extra buddies go to `npc.stabledCompanions` without losing gear.
- A full global cap never crashes or spawns extra followers.
- Existing saves load with one buddy and empty reserve.

### Auto-loadout

- New ability items equip automatically on the NPC or a companion with a free slot.
- Items that do not fit remain in the NPC’s bag.
- No automatic swapping/discarding of worn effects.
- Party effects on an NPC benefit its active companions.

### Behavior/visuals

- Newly acquired NPC buddies start following without reload.
- Multiple NPC buddies use distinct follow slots.
- Worn effects render on NPCs and their companions.
- No O(n²) frame regressions with the global cap; behavior decisions remain bounded.

### UI

- NPC card shows active buddies, reserve count, worn effects, and bag.
- Debug can simulate a win and grant items/buddies.
- Nearby notifications appear only when the player is close.

---

## 8. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Save bloat from many NPC companions/items | Caps + reserve collections + instance storage; measure save size fixture |
| Behavior/pathfinding load | Active cap, reserve not simulated, decision budget, stagger updates |
| NPC economy snowball | Separate NPC reward rates, companion caps, no swap churn |
| Player-facing leaks | Result callback is NPC-only; player stats/rewards/dialogue stay suppressed |
| Item duplication/loss during transfer | Use one transfer helper; tests for move-to-companion and move-back |
| UI confusion | Card is read-only for NPC gear in v1; debug actions for experimentation |
| Contract drift | Reuse existing `equip`/`resolveFx`/`makeCompanion`; no new inventory model |

---

## 9. Open questions for product decisions

### 9.1 Locked decisions for Phase 2A

| Decision | Choice |
| --- | --- |
| Active buddies per NPC | 2 |
| Reserve buddies per NPC | 6 |
| Global active companion cap | 80 |
| NPC reward economy | Separate `npcMiniGames` / `npcLootTables` |
| Companion drop on win | 80% while under cap |
| Draw / loss | Small coins on draw; nothing on loss |
| Auto-loadout order | Self first, then active companions |
| Auto-swap | Never in v1; leftover items stay in the bag |
| NPC gear UI | Read-only card in v1; debug can mutate |
| New games | After NPC economy acceptance |

Remaining product questions (deferred):

1. **Reserve activation:** automatic when an active buddy is removed, or debug/UI only?
2. **Item gifting:** when should players be able to give items to NPCs?
3. **NPC coins:** future shop/economy design?
4. **Player visibility:** toast only within 10 tiles (locked for v1), or a reward log later?
5. **NPC checkers/chess:** after new games or before?

---

## 10. Recommendation

Proceed with **Phase 2A: NPC ownership and economy** first.

It converts existing NPC-vs-NPC games into the dynamic system you described with no new gameplay concepts, and it makes every future mini-game instantly more interesting. Once NPC rewards, multi-buddy rosters, auto-loadout, and the NPC card are stable, add new games and NPC checkers/chess on top.

---

## 11. Implementation status (Phase 2A)

**Delivered**

- Owner-parameterized rewards with separate `npcMiniGames` / `npcLootTables`.
- NPC game result callback (`winnerId`, `loserId`, outcome) with no player settlement leakage.
- NPC active cap 2, reserve cap 6, global active cap 80.
- NPC coins and reserve companions persisted in save v2.
- `src/npc/loadout.js` auto-equip planner with effect `ai` priority/target metadata.
- Runtime loop: NPC win/draw → reward → auto-equip → behavior sync → save → nearby toast.
- NPC card shows buddies (active/reserve), worn effects, bag, coins; debug actions grant items/buddies, simulate wins, and auto-equip.
- Tests: **289/289 passing**, including NPC economy, roster, loadout, runtime, UI helpers, data validation, and acceptance.

**Fixed during QA**

- Reserve activation could exceed the global 80-companion cap — now refused with `reason: 'global-cap'`.
- Player reserve activation now checks the same global cap before adding a follower.

**Known gaps / deferred**

- NPC-vs-NPC checkers/chess.
- Reserve activation UI for NPC buddies (debug/card only for now).
- Player-managed NPC gear (read-only card by design).
- NPC reward log / history.
- NPC coins have no shop or spend sink yet.
- Performance test at the 80-active-companion ceiling in a real browser.

---

## 12. Phase 3 — new games (implemented)

Two contract-native board games are now live:

| Game | Board | Rules |
| --- | --- | --- |
| **Memory Grid** | 4×4 | 8 symbol pairs, alternating seats, match keeps turn, mismatch reveals then flips back, AI remembers seen cards |
| **Connect Four** | 7×6 | drop discs into columns, gravity, four-in-a-row, AI wins/blocks/prefers center |

- Both have catalog items (starter inventory), metadata, dialogue beats, reward specs, host factories, staging, AI drivers, and ground-layer rendering.
- Both are available from the friend dialogue game list and the backpack.
- New games currently support **player-vs-NPC**; NPC auto-play remains TTT-only until generic NPC drivers are added.
- Tests: **330/330 passing**.


