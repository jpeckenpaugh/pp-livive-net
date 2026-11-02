# Location Plan — Plaza Park, Town, Beach, School/Library

**Baseline:** `fef1b89` · 607 tests · save v4 with a per-location map
**Status:** Proposal · **Last updated:** 2026-11-02

---

## 1. Where we are

| Location | Kind | How it is built | NPCs | Doors |
| --- | --- | --- | --- | --- |
| Park | outdoor, 64×64 | `generateWorld(seed)` — seeded terrain | generated, saved, behaviour runtime | one travel door (Home) + activity door |
| Home | interior lot | `generateHome(seed, spec)` — walls/floor + decor | buddies only | one travel door (Park) |
| Shop | interior lot | same builder, shopkeeper record | Wren | one travel door (Park) |

What already works in our favour:

- The save already stores a `locations` map with per-location terrain, player position, NPCs, forage, decor, and storage.
- `travelTargets` lists every enabled location with a menu label, so the Player Menu already travels anywhere.
- Interiors are data-driven: any location with a `house` spec uses the same builder.
- Props, collision, and canvas drawing exist for Home furniture; the pattern can be generalised.

What blocks a real world:

1. **One travel door per location.** `doorFor()` returns a single door; `doorsFor()` only adds activity doors. A Town with four buildings needs a list.
2. **No outdoor prop layer.** Home furniture is Home-only. A fountain, bench, building facade, or pier has nowhere to live.
3. **`worldFor` is a two-case switch** (interior lot or seeded park). New themes need templates.
4. **Park-scoped NPCs.** The behaviour runtime is built for the Park. Town residents need a simpler lifecycle or a location-aware runtime.
5. **The hub is implicit.** Home and Shop are menu destinations off the Park, not places in a world.

---

## 2. Recommended world model

```text
            ┌──────────────┐
            │  Central Park │  ← main hub, redesigned plaza layout
            └──────┬───────┘
                   │ path / door
            ┌──────▼───────┐
            │     Town      │  ← street with building fronts
            └──┬───┬───┬───┘
               │   │   │
        ┌──────▼┐ ┌▼───┐ ┌▼────────┐
        │ Home  │ │Shop│ │ Library │
        └───────┘ └────┘ └─────────┘
                   │
            ┌──────▼───────┐
            │   Beachside   │  ← off the Town's east end
            └──────────────┘
```

- **Town is the hub.** Home and Shop doors change from `to: park` to `to: town`. The Park door goes to Town.
- **Direct menu travel still works.** The Player Menu keeps listing every enabled location, so nobody is forced to walk the chain.
- **The Park is redesigned for new saves.** Existing saves keep their stored terrain; new parks use the Central Park template. `New Park` is the opt-in.

---

## 3. Location designs

### 3.1 Central Park (redesigned `park`)

A 64×64 city park, not a wild meadow.

| Zone | Content |
| --- | --- |
| Central plaza | Fountain at the centre, circular path, benches, lamps, flower beds |
| Lake / pond | Water feature with a curving shore, a small pier, ducks later |
| Playground | Sand area with a slide, swing frame, and climbing frame — the Jungle Gym entrance lives here |
| Amphitheatre | Semicircular stone tiers on a lawn, used later for events/music |
| Lawns | Open grass with trees, picnic blankets |
| Paths | Dirt/gravel radial and ring paths connecting the zones |
| Gate / exit | A formal gate at the south edge leading to Town |

Props are canvas-drawn: fountain, bench, lamp, slide, swing frame, amphitheatre tier, gate, picnic blanket. Nature uses the existing Kitbitz trees/bushes/flowers.

NPCs keep spawning on walkable paths and lawns; the behaviour runtime is unchanged.

### 3.2 Town

A 64×64 street, not a city.

| Zone | Content |
| --- | --- |
| Main street | Dirt/cobble path running east–west |
| North side | Building fronts: Shop, Home (house facade), Library/School, a café shell |
| South side | Small plaza with a fountain, benches, market stalls |
| East end | Path to the Beach |
| West end | Gate back to Central Park |

Each building is a prop with a solid footprint and a door tile in front. Doors travel to the matching interior. Residents (4–6) wander the street with simple strolls; no Park behaviour runtime required.

### 3.3 Beachside

A 64×64 shore.

| Zone | Content |
| --- | --- |
| Sand | Broad beach with umbrellas, towels, palms |
| Water | Sea along the east edge, shallow band, gentle shoreline |
| Boardwalk | Dirt/wood path with lamps and benches |
| Pier | Short pier over the water |
| Activity | Shell collecting (new forage item) first; beach-ball fetch or volleyball later |

### 3.4 School / Library

Start with one **Library** interior off Town; a school campus can follow.

| Zone | Content |
| --- | --- |
| Reading room | Bookshelves, rug, armchairs, lamps |
| Lesson desk | Opens a short quiz activity |
| Quiz | 3 questions from a data file (nature, maths, words), coin reward, "finish a lesson" goal |
| Later | Classroom, science room, playground; lessons as contract activities with progress |

---

## 4. Architecture changes

| # | Change | Why |
| --- | --- | --- |
| 1 | **Multi-door travel**: `doorsFor` builds every `doors[]` entry with `kind: 'travel'`; keep the legacy single `door` working | Town needs four doors |
| 2 | **Location templates**: `worldFor` dispatches on `template` (`central-park`, `town`, `beach`, `interior`); default stays the seeded park | New themes without a switch per id |
| 3 | **Prop layer**: `data/location_props.json` + `src/props.js` + renderer shapes; solid footprints feed the existing blocked-tile set, generalised from Home | Fountains, benches, facades, piers |
| 4 | **Per-location residents**: fixed `residents[]` in the location def, instantiated on arrival with stable ids; Town/Beach use simple wander, Park keeps the runtime | NPCs outside the Park |
| 5 | **Theme palette**: optional per-location tile tint/colour overrides passed to the renderer | Beach sand, town street, library floor |
| 6 | **Travel menu grouping**: "Nearby" (doors) and "All destinations" (menu) | Clarity once there are five places |
| 7 | **Location map screen** (later): a simple diagram of the world with the current node highlighted | Navigation polish |

Save impact: **none required**. The `locations` map is already generic. New locations are created on first travel; Home/Shop door targets are data changes. Existing parks keep their terrain.

---

## 5. Delivery slices

| Slice | Work | Play-test |
| --- | --- | --- |
| **A** | Multi-door travel + prop layer + template dispatch + per-location residents | Nothing new visually; verify existing Park/Home/Shop still travel and draw |
| **B** | Central Park template: plaza, fountain, lake, playground, amphitheatre, gate | Walk the new park; Jungle Gym still works |
| **C** | Town: street, four facades, doors, 4–6 residents; reparent Home/Shop doors | Park → Town → Shop/Home → back |
| **D** | Library interior + lesson quiz | Enter from Town, take a lesson, earn coins |
| **E** | Beach: sand, water, boardwalk, pier, shells | Travel from Town, collect shells |

Slices A–C are the cohesive "world" milestone. D and E are content additions after it.

### What I would not build yet

- A full city with many streets.
- Interiors for every facade (café, houses) before the four core ones exist.
- A second behaviour runtime per location; simple strolls are enough.
- New binary art; props stay canvas-drawn.
- A minimap overhaul; per-location minimaps already rebuild.

---

## 6. Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Multi-door conflicts (two doors on one tile) | Medium | `doorsFor` already tracks used tiles; extend and test |
| Existing saves lose their park layout | High | Only new parks use the Central Park template; stored terrain is untouched |
| Town residents break friendships/trading | Medium | Stable resident ids; relationships stay global; no runtime dependency |
| Prop collision traps the player or doors | Medium | Validate door paths on generation; blocked-tile tests |
| Beach water walkability | Low | Existing water rules; the shoreline is terrain, not props |
| Scope creep across four locations | High | Ship A–C as one milestone; D/E separately |

---

## 7. Recommendation

Build **Town as the hub**, redesign the Park for new saves, and treat Beach and School as later destinations.

The order is **A → B → C** as one world milestone, then **D → E**. That gives the biggest change — a coherent Park/Town/Home/Shop world — before adding two more destinations, and it reuses the location, save, and door systems already shipped.

**Decisions to confirm:**

1. Redesign the existing `park` for new saves, or add a separate `plaza` location? Recommendation: redesign; existing saves keep their stored park.
2. Make Town the hub and change Home/Shop doors to `to: town`? Recommendation: yes; the menu still lists everything.
3. Town residents: 4 static personalities or 6 wandering ones? Recommendation: 6, simple strolls.
4. Library before School? Recommendation: yes — one room and a quiz first.
5. Beach first activity: shells (recommendation) or volleyball?
