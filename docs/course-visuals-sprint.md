# Course Board & Side-Scroller Visual Sprint

**Baseline:** `88131ce` · 718 tests · three courses (Jungle Gym, Rooftops, Shoreline)
**Status:** Recommendation · **Last updated:** 2026-11-02

---

## 1. What is wrong today

### The entrance is a ladder icon

`drawActivityDoorMarker()` draws a 0.56 × 0.86-tile climbing frame at the Park playground tile. From normal camera distance it reads as scenery, not “three playable courses live here”. The Player Menu and Backpack shortcuts exist, but the world itself does not advertise the feature.

### The courses are flat placeholder rectangles

`src/activities/platformer.js` renders:

- a vertical sky gradient,
- one flat `theme.ground` fill for every ground segment,
- one flat `theme.platform` fill with a 3-pixel edge for every ledge,
- a finish line,
- ghost and player.

The theme data is a set of dark neon colours (`#0b110d`, `#1d3324`, `#24402c`). There is no grass, dirt, sand, water, wood, stone, backdrop, or set dressing. The three courses are distinguished mostly by background tint and platform count.

The user’s direction is clear: **use the top-down map vocabulary, viewed from the side.** Grass is a surface cap with dirt beneath it; sand has its own cap and body; water fills pits; platforms are wooden planks or stone ledges. Vertical position is screen Y, not a Z layer.

---

## 2. Sprint goal

Make the courses look like part of the same world as the Park, and make the entrance impossible to miss.

Three outcomes:

1. A **playground gateway** that reads as “courses” from across the screen.
2. A **side-view terrain renderer** that reuses grass, dirt, sand, water, wood, and stone.
3. **Three redesigned courses** with their own theme, backdrop, props, and finish gate.

---

## 3. Sprint slices

### Slice 1 — Course gateway and kiosk

Replace the tiny ladder marker with a multi-tile gateway at the Park playground.

- A 4×3 painted gateway: two posts, a crossbeam, a banner reading **COURSES**, and three pennants (one per course colour).
- A small **course kiosk** prop beside it with a board listing the three course names and pars.
- Both are decorative; the trigger tile stays walkable under the arch. The gateway can be drawn by `drawActivityDoorMarker` so no collision or door data changes.
- Add a soft glow/flag animation so it catches the eye at 1–2 screens away.
- Keep the Player Menu and Backpack shortcuts.

**Acceptance:** from the Park spawn, the gateway is visually obvious; walking under it and pressing Enter opens the course board.

### Slice 2 — Side-view terrain renderer

Replace the flat rectangles with a tile-style renderer driven by theme data.

**Data additions per course:**

```json
"surface": "grass",          // grass | dirt | sand | stone | boardwalk
"subsurface": "dirt",        // dirt | rock | sand
"platformMaterial": "wood",  // wood | stone | metal | boardwalk
"backdrop": "park",          // park | city | shore
"props": [
  { "type": "tree", "x": 420, "y": 440, "scale": 1.1 },
  { "type": "lamp", "x": 900, "y": 440 }
]
```

**Rendering rules:**

- Ground segments draw a surface cap (grass blades, sand ripple, stone edge) and 2–3 body rows beneath, using the same palette family as the Park.
- Ground sides get a darker cut edge and subtle tile seams, so pits read as depth.
- Platforms draw planks with end caps and small supports, or stone ledges with a chipped edge.
- Water pits draw a waterline, a lighter shallow band, and a darker body.
- Backdrop layers are parallax silhouettes: park trees, city rooftops, or sea and palms.
- Foreground tufts, flowers, flags, and small props sit above the terrain but behind the player.
- Everything uses screen Y; nothing is drawn as an overlay “under” the player.

**Acceptance:** a still frame of each course looks like a side view of the Park/Town/Beach palette, not a neon test level.

### Slice 3 — Course redesign

Rebuild the three course layouts around the new vocabulary.

| Course | Look | Layout notes |
| --- | --- | --- |
| Jungle Gym | Grass surface, dirt body, wooden platforms, park trees, playground props, bunting | Keep the existing beats but add a grass mound, a log ledge, and a finish gate made of two posts and a banner |
| Rooftops | Stone/brick roof caps, metal ledges, city skyline, water tanks, signage | Staggered rooftops, a water-tank platform, an alley gap; finish on a rooftop sign |
| Shoreline | Sand surface, wet-sand shallow, water pits, boardwalk platforms, palms, umbrellas | Long low beach, pier-plank platforms, a shallow-water crossing, finish at a lifeguard hut |

Keep physics and par roughly intact. Add non-colliding set dressing (`props`) and a start banner plus a finish gate to each. Spectators can be simple silhouettes or small DiceBear billboards at the start/finish later.

**Acceptance:** three courses are visually distinct at a glance, all remain finishable, pars stay within a few seconds of today.

### Slice 4 — Polish

- Course board UI: show a small thumbnail/swatch of each course.
- Finish/start copy and a short “new best” flourish.
- 360 px readability: terrain seams and platforms stay legible at the narrower view.
- Performance: cache tile patterns if the renderer starts doing per-tile work.

---

## 4. Where the work lives

| Area | File |
| --- | --- |
| Gateway marker | `src/renderer.js` (`drawActivityDoorMarker`) |
| Kiosk prop (optional) | `data/location_props.json`, `src/renderer.js` |
| Theme data | `data/activities.json` |
| Side-view renderer | `src/activities/platformer.js` (`renderView`, helpers) |
| Course layouts | `data/activities.json` (`course`, `props`, `backdrop`) |
| Course board UI | `src/main.js` (`openActivityChooser`) |
| Tests | `test/activities*.test.js`, `test/data-validation.test.js` |

No new binary assets. Everything stays canvas-drawn and data-driven.

---

## 5. Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Visuals drift from collision | High | Render directly from the same ground/platform rects the physics uses; decorate inside those bounds |
| Per-tile drawing costs too much | Medium | Pre-render pattern tiles or cache per course; the courses are one screen tall |
| 360 px becomes muddy | Medium | Thicker caps, fewer seams, higher contrast at narrow widths |
| Course identity blur | Medium | Each course gets one dominant material and one backdrop |
| Signifier becomes clutter | Medium | One gateway at the playground, no duplicated signs elsewhere |
| Redesign breaks pars | Medium | Keep the existing beats; tune with the headless bot after the art pass |

---

## 6. Recommendation

Run **Slice 1 + 2 together** first: the gateway makes the feature discoverable, and the terrain renderer makes it look like the same game. Then **Slice 3** to redesign the three courses, and **Slice 4** for the board thumbnails and 360 px polish.

Do not add new mechanics in this sprint. The goal is identity and readability: grass on top, dirt below, wood underfoot, a park behind you, and a gateway that says “courses” from the spawn.
