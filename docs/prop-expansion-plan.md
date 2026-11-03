# Prop Set — Inventory & Expansion Strategy

**Baseline:** `3a9959e` · 669 tests · Town grid with 12 enterable buildings
**Status:** Recommendation · **Last updated:** 2026-11-02

---

## 1. How many props exist

| Catalog | Count | Examples |
| --- | --- | --- |
| `data/location_props.json` | **16** | fountain, bench, lamp, gate, slide, swing-frame, amphitheatre-tier, building, pier, palm, umbrella, picnic-blanket, desk, bookshelf, rug, planter |
| `data/home_items.json` | **20** | couch, armchair, coffee table, TV, radio, floor lamp, bookshelf, rug, plant, fridge, stove, counter, dining table, chair, bed, nightstand, dresser, piano, aquarium, wall clock |
| `data/nature_scenery.json` | **10** | apple tree, puffy tree, chestnut tree, bushes, boulder, mushrooms, flowers, grass tufts |
| **Total** | **46 catalog entries** | 44 distinct ids; only `bookshelf` and `rug` currently overlap between the two furniture catalogs |

So the art is broader than it feels: there are 36 furniture/prop shapes and 10 nature pieces. The gap is not quantity — it is **coverage** (kitchens, clinics, workshops, street furniture) and **reuse** (interiors only use the 16 location props, never the 20 Home shapes).

---

## 2. The cheapest big win: share Home furniture with interiors

The Home catalog already contains exactly what cafés, clinics, cottages, and workshops need: couches, armchairs, tables, chairs, counters, fridges, stoves, dressers, beds, lamps, shelves, rugs.

Right now interiors can only use `desk`, `bench`, `bookshelf`, `rug`, `planter`, `lamp`. The two catalogs use the same `{ size, solid, shape, colors, variants }` shape and the same renderer primitives.

**Recommendation:** let location props reference Home item ids (or merge into one shared catalog with a `scope: indoor | outdoor` flag). That instantly gives interiors 20 more usable shapes with zero new art.

This is the highest-value change in the whole prop discussion.

---

## 3. Is there a “DiceBear of props”?

**Not really.** DiceBear is specifically an avatar generator. There is no equivalent seeded API for furniture or props. The closest options:

| Option | What it is | Fit |
| --- | --- | --- |
| **Kenney** (CC0) | Huge 2D/3D kits — furniture, city, tiny town | Broad, but stylistically different from flat canvas props |
| **KayKit** (CC0) | Low-poly furniture, city builder, restaurant kits | Good 3D, needs a sprite pipeline |
| **Quaternius** (CC0) | Modular buildings, furniture, nature — already used for pets | Consistent with the existing offline rasterizer |
| **Poly Pizza** | Searchable CC0/CC-BY models | License varies; avoid mixing |
| **Kitbitz** (CC0) | Nature kit — already used | Keep for trees, flowers, rocks |
| **Procgen tools** | Rocks/trees/buildings generators | Domain-specific, not a prop API |

**Recommendation: build our own tiny “DiceBear of props” on top of the existing shapes.**

A prop recipe is cheap and fits the architecture:

```text
shape (couch) + palette (warm/cool/neutral) + detail seed
  → deterministic cushion pattern, throw colour, wood tone, sign text
```

The data already has `colors` and `variants`. Add:

- `patterns` (stripes, checks, floral) rendered as simple canvas fills.
- `materials` (wood, metal, ceramic) driving a second accent.
- `seed` on a placed prop, resolved deterministically at load.
- Signed props (shop signs, house numbers) can pick from a small word list per seed.

That gives variety without assets, keeps the flat style coherent, and matches how avatars and voices already work in this project.

If we ever want real 3D props, use **one** CC0 kit (Quaternius or KayKit) and the same offline rasterizer as the Cube World pets — single angle, single palette, committed sprite sheets. Do not mix kits.

---

## 4. What to add, by gap

Current coverage is strong in “park” and “home living room”. The gaps are service interiors, street furniture, and beach leisure.

### Wave 1 — interiors (12 props + shared Home shapes)

Café: counter with display, stool, café table, awning.
Bakery: bread display, oven, flour sack.
Clinic: exam bed, supply cabinet, privacy screen.
Workshop: workbench, tool rack, stool.
Houses: wardrobe, vanity.

Plus expose Home’s couch, armchair, dining table, chair, dresser, bed, fridge, stove, counter, and lamps to interiors.

### Wave 2 — street and town (12 props)

Fence segment, hedge, litter bin, mailbox, signpost, market stall, bus stop, statue, flower bed, string lights, notice board, bike rack.

These make Town feel like a town rather than buildings on grass, and most are reusable in the Park.

### Wave 3 — beach and leisure (10 props)

Deck chair, towel, cooler, sandcastle, surfboard, buoy, shell pile, beach ball, kite, outdoor shower post.

### Wave 4 — school and library (8 props)

Globe, chalkboard, locker, reading table, beanbag, easel, science bench, display case.

### Cross-cutting metadata

Give every new prop a `use` block like Home items (`sit`, `read`, `brew`, `heal`, `repair`, `open`) so props are not just decoration. The interaction pattern already exists in the Home item card.

---

## 5. Style and performance

- **Stay canvas-primitive for now.** One coherent flat style beats a mixed asset pack.
- **Share shapes, not copies.** Reuse Home couch/table shapes in interiors via the shared catalog; do not redraw them.
- **Cache complex shapes.** If a Town block exceeds ~60 props, pre-render each shape type to an offscreen canvas and blit it; the current immediate-mode draw is fine at today's counts.
- **Seeded variants, not random.** Props must look the same after reload; derive detail from a stable seed.

---

## 6. Recommendation summary

1. **Unify the two furniture catalogs** so interiors can use Home shapes — biggest win for the least work.
2. **Add a seeded variant layer** (palette + pattern + material + sign) as our “DiceBear of props”.
3. **Expand in themed waves**: interiors, street, beach, school — 10–12 props each, with `use` metadata.
4. **Do not adopt an external prop pack yet.** If we do, pick one CC0 kit and rasterize it offline like the pets, for a single consistent look.

The current set is already nice. The next jump is not more shapes — it is **more reach**: the same couch in a café, the same counter in a bakery, with seeded colour and pattern doing the variety work.
