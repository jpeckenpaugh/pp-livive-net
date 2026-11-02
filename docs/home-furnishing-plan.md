# Home Furnishing — First Pass Analysis & Recommendation

**Target:** the Home location at `pp.livive.net` (live since `6ace6b5`)
**Goal:** take Home from an empty room with two decor items to a small, furnished,
interactive sandbox the player can rearrange.
**Status:** Recommendation · **Last updated:** 2026-11-01

---

## 1. What Home is today

| Thing | Current state |
| --- | --- |
| House | 17 × 17 tiles, walls on the perimeter, 15 × 15 interior floor |
| Entry | Door on the bottom wall at `(32, 38)`, spawn at `(32, 36)` |
| Decor | Exactly two items — a round rug and a potted plant — placed at the player's feet from the Backpack |
| Collision | None. Furniture does not exist; only walls and water block |
| Drawing | Rug is a canvas ellipse; plant reuses a Kitbitz bush sprite |
| Persistence | `home.decor: [{ id, x, y }]`, preserved by the v4 save |
| Companions | Up to 12 wander the interior and sit near the rug |

The room has 225 interior tiles. Fifteen to eighteen pieces of furniture will fit
comfortably with walking lanes if the layout is zoned and the bottom-centre door path
stays clear.

---

## 2. Recommended first pass

**Fifteen item types, eighteen placed objects, one plain variant each**, drawn with canvas
primitives, solid footprints, a Furnish mode for moving/rotating/recolouring, and three
cheap interactions. No shop, no upgrades, no new binary assets.

### 2.1 Item set

Sizes are in tiles. `solid` items block movement; the rug does not.

| Zone | Item | Size | Solid | First-pass interaction |
| --- | --- | --- | --- | --- |
| Living | Couch | 2 × 1 | yes | Sit (flavour line) |
| Living | Armchair | 1 × 1 | yes | Sit (flavour line) |
| Living | Coffee table | 2 × 1 | yes | — |
| Living | TV | 1 × 1 | yes | Toggle on/off, static screen + cue |
| Living | Radio | 1 × 1 | yes | Toggle, short synthesized cue |
| Living | Floor lamp | 1 × 1 | yes | Toggle warm glow |
| Living | Bookshelf | 1 × 2 | yes | Flavour line |
| Living | Round rug | 2 × 2 | no | — (existing) |
| Living | Potted plant | 1 × 1 | yes | Flavour line (existing) |
| Kitchen | Fridge | 1 × 1 | yes | Flavour line |
| Kitchen | Stove | 1 × 1 | yes | Flavour line |
| Kitchen | Counter | 2 × 1 | yes | Flavour line |
| Dining | Dining table | 2 × 2 | yes | — |
| Dining | Chair × 2 | 1 × 1 | yes | Sit (flavour line) |
| Bedroom | Bed | 2 × 3 | yes | Sleep (flavour line) |
| Bedroom | Nightstand | 1 × 1 | yes | Flavour line |
| Bedroom | Dresser | 2 × 1 | yes | Flavour line |

Sixteen types, eighteen objects once the two chairs are counted. That is inside the
"10–15 types" ask with enough duplication to make the room feel lived in.

### 2.2 Default layout

A studio arrangement in three zones, leaving the door lane and one-tile walking paths:

```text
        x 25                    x 32                   x 39
y 23   [bookshelf] [lamp]      [stove] [fridge]        wall
y 24   [plant]                 [counter]
y 25   [armchair]                                     wall
y 26        [rug 2x2]          [chair] [dining 2x2]
y 27   [couch 2x1] [coffee]    [chair]
y 28                          [dresser 2x1]
y 30                                             [bed 2x3]
y 33                          [nightstand]
y 37   ─────────────── door lane ───────────────
```

Exact tiles live in `data/home_items.json` as offsets from the house origin, so the layout
moves with the house and can be tested without rendering.

### 2.3 Drawing

One canvas shape function per furniture type, using the existing park palette, a soft
shadow, and flat fills. This matches the "plain/ordinary" brief, needs no assets, and gives
each future upgrade a clear skin to replace.

Palettes: each item carries `colors` and two or three `variants` (e.g. warm, cool, neutral).
Pass one ships **plain** and exposes the variant index in Furnish mode; the shop can sell
variants later without a data change.

### 2.4 Furnish mode

Toggled from the Backpack (a **Furnish** row) or the `F` key while in Home.

- Click a piece to select it; its footprint outlines.
- Click a floor tile, or use the arrow keys, to move it.
- `R` rotates; `C` cycles the variant.
- `Enter` places; `Escape` cancels and returns the item to its prior tile.
- The Backpack lists every piece, so an item tucked behind the bed is still selectable.
- Placement rejects walls, the door tile, other items, the player, and any move that would
  leave the door with no walkable path into the room (flood fill).

Pass one does **not** include adding new items, selling, or buying. The item list is fixed;
rearranging is the sandbox.

### 2.5 Interactions

**Revised 2026-11-01 — click/tap opens an item menu.** The primary affordance is now
pointing at an item, not facing it and pressing a key.

Clicking or tapping any tile of a Home item opens a small item card anchored to it:

```text
┌─────────────────────┐
│ 🛏 Bed              │
│ [ Sleep ]  [ Move ] │
│            [ Close ]│
└─────────────────────┘
```

- **Use** is the primary button and is labelled with the item's verb — "Sleep", "Bake a
  pie", "Play a tune", "Watch", "Sit", "Read", "Water", "Open".
- **Move** closes the card and enters Furnish mode with that item selected. This is the
  bridge between the item menu and Wave 7b's placement controls.
- Clicking elsewhere, Escape, or Close dismisses it.
- The same card opens from the keyboard by facing an item and pressing Enter, so keyboard
  and touch reach the same surface. Enter does not skip the menu.
- Character clicks still win over item clicks; the item menu is Home-only.

| Item | Use verb | First-pass behaviour |
| --- | --- | --- |
| Bed | Sleep | Player lies on the bed, blanket overlay and a zzz bubble; any movement, Escape, or Use wakes them. No time skip. |
| Couch / armchair / chair | Sit | Player sits on the item in a settled pose; moving stands them up. |
| Stove | Bake a pie | Needs 3 apples in the basket; consumes them, adds `apple-pie` to the bag, plays `pickup`. Without 3 apples, says how many are missing. |
| Radio | Play a tune | Toggles a new `radio-tune` 8-bit square-wave cue from `data/sounds.json`; on/off persists. |
| TV | Watch | Toggles an animated static screen and a short cue; on/off persists. |
| Lamp | Light | Toggles a warm radial glow; on/off persists. |
| Bookshelf | Read | A short random flavour line. |
| Fridge | Open | A short flavour line. |
| Plant | Water | A short flavour line. |
| Counter / dresser / nightstand / coffee table | — | A short flavour line. |

The TV, radio, and lamp on/off state persists in the item record. Sleep and sit are
transient poses on the player, not saved.

**Input priority in Home:** item on the clicked tile → item menu; character → character
card; otherwise ground movement. With the keyboard: item on the facing tile → item menu;
otherwise door → travel; otherwise the player menu. This replaces the earlier "Enter toggles
the item directly" plan.

---

## 3. Data and save shape

### `data/home_items.json`

```json
{
  "version": 1,
  "items": {
    "couch": {
      "id": "couch", "label": "couch", "zone": "living",
      "size": { "w": 2, "h": 1 }, "solid": true,
      "shape": "couch",
      "colors": { "base": "#7d6a55", "accent": "#a89177" },
      "variants": ["plain", "warm", "cool"],
      "interact": { "kind": "sit", "line": "you sink into the couch." },
      "use": { "verb": "Sit", "kind": "sit" },
      "tier": 1, "price": 0
    },
    "stove": {
      "id": "stove", "label": "stove", "zone": "kitchen",
      "size": { "w": 1, "h": 1 }, "solid": true,
      "shape": "stove",
      "use": { "verb": "Bake a pie", "kind": "recipe",
               "recipe": { "inputs": { "apple": 3 }, "output": "apple-pie" } }
    }
  },
  "layout": [
    { "itemId": "couch", "dx": 0, "dy": 4, "rot": 0, "variant": 0 }
  ]
}
```

`tier`, `price`, and `variants` are reserved now so upgrades and purchases do not need a
schema change later.

### Save (`home.items`)

```json
"home": {
  "items": [
    { "uid": "home_couch_1", "itemId": "couch", "x": 25, "y": 27, "rot": 0, "variant": 0, "on": false }
  ]
}
```

- Additive to v4; no version bump.
- On load, a missing `home.items` gets the default layout.
- Existing `home.decor` entries are converted to rug/plant items once, preserving their
  positions; `decor` stops being written.
- Moving or restyling an item rewrites only its record.

**Wave 7a decisions (autopilot, 2026-11-01)**

- **Unify now.** Rug and plant fold into `home.items` in 7a; `home.decor` is read once when `items` is missing, then never written. The Backpack decor row keeps working by acting on the rug/plant items.
- **Layout offsets** are footprint top-lefts relative to `house.x/y` (interior 1..15), tested for bounds, overlap, and reachability against the generated terrain.
- **Draw order** sorts multi-tile items by footprint bottom row with a left-edge tie-break; the rug alone draws in the ground pass.
- **Collision** is `game.homeBlockedTiles`, empty outside Home, checked in `tryStep` before reservations, and passed to `tickHomeBuddy`.
- **Buddy placement** excludes furniture footprints and the door lane, not just wander.
- **Save:** read `decor` only when `items` is missing; write `items`; keep the stale `decor` key preserved but unread for one wave as a downgrade hedge.
- **Rendering:** one `drawHomeItem` dispatcher with per-shape helpers; colours and variants come from data.
- **Tests:** a new `test/home-items.test.js` for data, layout, rotation, and blocked derivation; extended buddy tests; a save round-trip and migration case; and a door-to-spawn reachability assertion through `findPath`.

---

## 4. Collision and companions

- Solid footprints join the Home blocked set, checked by player steps, companion wander,
  and placement validation.
- Rotation swaps width/height on odd quarter-turns.
- Home buddies pick destinations that are floor, unoccupied by furniture, and not the rug
  centre; they are already non-blocking to each other.
- The door tile and a one-tile path to it are always reserved.
- Park collision is untouched.

---

## 5. Delivery plan

**Revised 2026-11-01.** Click/tap is now the primary surface, and "Move" lives inside the
item menu, so the menu and placement must ship together. 7b absorbs the core Use actions;
7c is polish and the secondary lines.

| Wave | Work | Gate |
| --- | --- | --- |
| **7a** | Data file, default layout, canvas shapes, collision, save/migration | Done (`73be877`); room looks furnished and walks correctly |
| **7b** | Item menu (click/tap + keyboard), Move into Furnish mode, placement/rotate/variant, core Use: sleep, sit, bake pie, radio tune, TV/lamp toggles | You tap a bed, sleep, wake, tap Move, rearrange, reload |
| **7c** | Flavour lines for the remaining items, pie item polish, 360 px pass, edge cases | Every item has a response; touch and keyboard agree |

Two remaining waves, roughly **3–4 dev days**, one human check each, committed to `main` at
each gate. No new dependencies or binary assets.

**New data this adds:** `use: { verb, kind, line?, recipe?, cue? }` on each item;
`apple-pie` in `data/items.json` (value 6, tradeable, icon 🥧); a `radio-tune` cue in
`data/sounds.json`; and a transient `homePose` on the player for sleep/sit.

**Wave 7b decisions (autopilot, 2026-11-01)**

- **Card:** a new `#home-item-card` aside, positioned from the item's screen rectangle, viewport-clamped, hidden when Furnish opens. Use receives focus on open.
- **Hit-testing:** a pure `homeItemAtTop` in `home_items.js`, mirroring the renderer's bottom-row/left tie-break in reverse; the rug ranks below actors. Tested.
- **Furnish ownership:** `main.js` owns `{ uid, draft }` and intercepts canvas clicks before `handlePointerDown`; `Game.interactive` is untouched; Escape cancels.
- **Poses:** `homePose = { kind, uid }`; the player keeps its logical tile and the renderer offsets the sprite over the seat or bed. Movement wakes/stands. Never saved.
- **Pie:** a plain `apple-pie` catalog entry with no use action. The basket becomes **shared across locations** — travel carries the counts — so apples picked in the Park are bakeable at Home. A test covers the carry.
- **Radio:** one-shot `radio-tune` on turn-on, silence on off, no loop; respects the existing mute and unlock.
- **Toggles:** `on` is the only persisted state; TV static derives from `game.time`, the lamp is a radial pass over lit items.
- **Enter priority in Home:** dialogue → player menu → facing item → door → player menu (opened). Asserted in a test.

---

## 6. Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Canvas primitives look too plain | Medium | Plain is the brief; consistent palette and shadows carry it. Upgrades are skins later. |
| Room feels cluttered or unwalkable | Medium | Fixed zoned layout + path check on every move; 15 × 15 interior is generous |
| Companion collision breaks companion wander | Medium | Blocked set shared by player and Home buddies; destination filter, not new pathfinding |
| Save migration loses the existing rug/plant | Medium | Convert `decor` once on load and test both shapes |
| Furnish mode fights normal interaction | Medium | Mode is explicit; outside it, Enter interacts; inside it, Enter places |
| Input priority (item vs door vs menu) | Low | Item facing tile, then door, then menu — asserted in tests |
| Future shop/upgrades need a schema change | Low | `tier`, `price`, `variants` reserved now |

---

## 7. Recommendation summary

Build **15 types / 18 objects**, plain variants, canvas-drawn, auto-placed in three zones.
Make every solid piece block movement, add a Furnish mode for move/rotate/recolour, and ship
three real interactions (TV, radio, lamp) plus flavour lines for the rest. Convert the
existing decor into the same item model. No shop, no upgrades, no new assets in this pass.

**First commit point:** Wave 7a, where the room is furnished and stable. That is the
smallest change that makes Home feel like a home.
