# World Editing — Analysis & Recommendation

**Baseline:** `f8d29a1` · 682 tests · Home Furnish mode, Town grid, prop catalog (59 types)
**Status:** Recommendation · **Last updated:** 2026-11-02

---

## 1. What exists today

| System | Editable? | Persistence |
| --- | --- | --- |
| Home furniture (`home.items`) | **Yes** — Move, rotate, recolour, place, reset via Backpack | Save `home.items` |
| Location props (benches, fountain, trees-as-props, buildings) | No | `data/world.json`, rebuilt every load |
| Nature scenery (trees, bushes, flowers, rocks) | No | generated from the seed, **not saved** |
| Doors / activity entrances | No | `data/world.json` |
| Players, NPCs, companions | No | saved positions |

The Home editor is the right model: a draft record, a valid/invalid reason, keyboard + tap placement, and a save per item. It is hardcoded to `currentLocationId === 'home'`, and its validator assumes a room rectangle.

Two immediate fixes are already shipped:

- The floating **ENTER** pills above Town buildings are removed; the doorway art is the cue.
- Floor coverings (`rug`, `picnic-blanket`, `towel`, `flower-bed`) now draw in a ground pass beneath doors, props, and actors, and are excluded from the Y-sorted object list.

---

## 2. What “the whole world is editable” should mean

Three object classes, one editor:

1. **Props** — benches, fountain, lamps, planters, market stalls, playground pieces, interiors furniture. Free move, rotate, restyle.
2. **Scenery** — trees, bushes, flowers, rocks. Free move, restyle/scale, remove.
3. **Buildings** — Town facades and their interior doors. **Lot-based**: snap to building lots and swap with another building. Freeform building drag is not recommended; it breaks roads and door paths.

Doors and activity entrances are **not independently editable**. A door belongs to its host building/entrance and moves with it.

---

## 3. Data model

Extend each location record (save v4, additive — no version bump needed):

```json
"town": {
  "layout": "town-grid",
  "props": [
    { "uid": "prop-…", "type": "bench", "x": 12, "y": 30, "rot": 0, "variant": 1, "seed": "bench-3" }
  ],
  "scenery": [
    { "uid": "tree-…", "type": "puffy-tree", "x": 8, "y": 22, "scale": 0.8 }
  ],
  "buildings": [
    { "uid": "bld-shop", "type": "building", "lot": "A1", "x": 6, "y": 15,
      "variant": 0, "label": "Shop",
      "door": { "to": "shop", "dx": 2, "dy": 2, "prompt": "Step into the shop?" } }
  ]
}
```

- **Base data** from `data/world.json` seeds these lists on first visit; stable uids are derived from type + tile.
- **Save overrides** replace the base lists for that location. Existing saves get the default lists on first load (no visible change).
- **Doors** are derived from `buildings[].door` and from non-building entrance records, so moving a building moves its trigger.
- **Scenery** must be saved because it is currently seed-generated; once saved, a moved tree stays moved.
- **Reset this place** deletes the override block and rebuilds from data.

This keeps the save compact (a few dozen records per location) and makes every edit reversible.

---

## 4. Editor UX

**Entry:** a `Decorate` row in the Backpack, available in any location (the Home row remains “Furnish”). While active, the usual movement still works; clicking a prop/scenery/building opens a small card:

```text
┌──────────────────────┐
│ 🪑 Bench             │
│ [ Move ] [ Style ]   │
│ [ Rotate ] [ Reset ] │
└──────────────────────┘
```

- **Move:** click a tile or use arrows; the footprint ghost turns red with a reason if it does not fit. Enter places, Escape cancels.
- **Style:** cycles the existing `variant`; a `C` key shortcut; seeded detail changes deterministically.
- **Rotate:** `R`; footprints swap width/height.
- **Buildings:** Move snaps between **lots**; if the destination lot is occupied, offer **Swap**. The door moves with the building.
- **Reset:** restores that one object, and a “Reset this place” action restores the whole location.
- **Exit:** Escape or the Decorate row.

Keyboard and touch use the same path; no new modal overlays.

---

## 5. Safeguards

Every move is validated by a pure `canPlaceLocationObject()`:

| Check | Rule |
| --- | --- |
| **Bounds** | Every footprint tile must be inside the map; interior props must stay inside the room |
| **Fit** | Solid objects cannot overlap another solid object or a building lot reserved by another building |
| **Terrain** | Props may declare allowed terrain (`palm` on sand, tree on grass); reject mismatches |
| **Doors & spawn** | No solid object may cover a door trigger, activity entrance, spawn, or resident tile |
| **Characters** | Reject placement under the player, an NPC, a companion, or a buddy |
| **Path** | Flood fill from the spawn and each door; reject any move that disconnects a door or the main walkable component |
| **Ground cover** | Rugs/blankets/towels may overlap other ground cover and sit under solids; they cannot block anything |
| **Lost objects** | Clamp to world bounds; “Reset this place” is always available |
| **Buildings** | Lot-snapped only; door path must remain valid; swap only if both footprints fit |

The path check is the important one. It turns “oops, I walled off the shop” into a red ghost and a reason line.

---

## 6. Phases

| Phase | Work | Test |
| --- | --- | --- |
| **0** | Done: ENTER markers removed, ground-cover Z fixed | Visible |
| **1** | Save shape + per-location `props` / `scenery` / `buildings`; seed defaults; reset | Existing locations unchanged |
| **2** | Decorate mode for **props + scenery**: move, rotate, style, fit/path checks | Move a bench/tree and reload |
| **3** | Buildings: lot anchors, move/swap, doors follow | Swap two houses; enter both |
| **4** | Polish: reset per object/location, undo last move, onboarding | Full loop |

Phase 1 is invisible and can land alone. Phases 2–3 are the feature. Phase 4 is optional polish.

---

## 7. Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Path disconnection | High | Flood-fill check on every move, including buildings |
| Door/lot desync | High | Doors derived from building records, not stored separately |
| Scenery save growth | Low | ~50 records per location; already saving terrain |
| Existing saves lose layout | Medium | Defaults seed on first visit; overrides are additive |
| Players trap NPCs or themselves | Medium | Reject character tiles and any move that disconnects the spawn |
| Editor feels cluttered | Medium | One card, four verbs, red/green ghost, reset always visible |
| Buildings moved onto roads | Medium | Lot-based snapping, not freeform |
| Undo expectations | Low | Phase 4 adds one-step undo; reset covers the rest |

---

## 8. Recommendation

Build **Phase 1 + 2** first: save per-location props and scenery, then a Decorate mode for everything that is not a building. That delivers most of the “whole world is mine” feeling — trees, benches, fountain, planters, market stalls, interior furniture — with a manageable blast radius.

Then **Phase 3** for buildings, because lot-swapping is the part that most needs the path and door safeguards.

Do **not** make doors independently movable, and do **not** allow freeform building dragging. Those are the two decisions that would turn a nice sandbox into a broken town.

**Immediate answer:** benches, trees, the fountain, and interiors can all share one editor. Houses should swap lots, not float. The fit + path checks are what make it safe.
