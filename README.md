# Play Park

A tiny browser playground at [pp.livive.net](https://pp.livive.net). A 64 × 64 tile park,
locally generated **DiceBear Voxel Art** characters, and a crowd of wandering neighbours.

Everything runs in the browser. DiceBear is vendored into `vendor/dicebear-voxel.js`, so
avatar generation makes **no network requests at runtime**. The site is plain HTML, CSS,
and ES modules — there is no build step to serve it.

## Features

- **Seeded 64 × 64 park** — grass, dirt paths, sand, ponds, and flower fields.
- **Follow camera and minimap** — the world is larger than the viewport; the minimap shows
  your position, neighbours, and the visible area.
- **Local character creator** — generate a DiceBear Voxel Art character from a seed and
  customise hair, outfit, glasses, beard, skin, and clothing colours.
- **Companion buddies** — each player and neighbour gets a companion following them around the
  park: DiceBear styles (**Clay**, **Critters**, **Gaze**, **Sprouts**, **Voxel bot**), 10 Cube World
  animal pets (**Dog**, **Cat**, **Chicken**, **Chick**, **Horse**, **Pig**, **Sheep**, **Wolf**,
  **Raccoon**, **Hedgehog**), or 8 fantasy creatures (**Yeti**, **Demon**, **Goblin**, **Giant**,
  **Skeleton**, **Skeleton Armor**, **Zombie**, **Wizard**).
- **In-world Inventory & Mini-games** — each character carries an inventory with starter items
  like a bouncy ball and an oversized Tic-Tac-Toe board:
  - **Fetch**: Throw the ball onto the park grass and watch your companion fetch and return it.
  - **Tic-Tac-Toe**: Unfurl a giant 3×3 game mat directly onto park tiles. Walk onto squares and
    press `Enter` or `Space` to place your piece while playing with friends.
- **Glider Wings** — equip the wings to fly over ponds and paths; click a water tile to glide there.
- **Foraging** — apples dot the grass and mushrooms already grow in the park. Walk over either one
  to collect it into your basket; apples sprout again on a timer and mushrooms regrow after a while.
- **Sound effects** — a tiny synthesized cue set plays when games open, turns change, pieces land,
  and matches are won or lost. Toggle it from the 🔊 button in the top bar.
- **Match Stats & Head-to-Head Records** — win, loss, and draw records are tracked across all
  Tic-Tac-Toe matches with each park neighbour in the **🏆 Stats** panel.
- **Neighbour generator** — roll a crowd, reroll individuals, and add more later.
- **Tile-based collision** — no two characters can occupy the same tile, including while
  one of them is moving. Movement destinations are reserved.
- **Bump-to-talk dialogue** — walking into a neighbour pauses the park and starts a short
  conversation with a Yes / No choice.
- **Friend list** — a live `Friends n/m` counter and a panel listing everyone you've
  friended.
- **Wander AI** — neighbours stroll around, avoid water and each other, and pause
  automatically during dialogue.
- **Keyboard and click movement** — WASD/arrow keys, or click a tile to pathfind there.
- **Autosave** — the park, characters, positions, and friendships persist in
  `localStorage`.

## Quick start

```sh
./install.sh    # install dev dependencies
./run.sh        # start local static server at http://localhost:4173
```

Or using standard npm commands:

```sh
npm start
```

Open <http://localhost:4173>. No install or build is required to run the site.

To run the tests:

```sh
npm test
```

To rebuild the local DiceBear bundle (only needed after changing its entry point or
upgrading the package):

```sh
npm install
npm run vendor
```

Requires Node.js 20 or newer for the tooling; the game itself only needs a modern browser.

## Controls

| Action | Input |
| --- | --- |
| Walk | `WASD` or arrow keys |
| Walk to a tile | Click the ground |
| Inspect a character | Click them |
| Talk | Walk into them |
| Open Player HUD Menu | `Enter` (when no dialogue is active) |
| Cycle HUD Tabs | `A` / `D` or `ArrowLeft` / `ArrowRight` (when menu open) |
| Navigate Menu Rows | `W` / `S` or `ArrowUp` / `ArrowDown` (when menu open) |
| Trigger Menu Action | `Enter` or `Space` (when menu item highlighted) |
| Close panel or dialogue | `Escape` |
| Throw / Action key | `Enter` or `Space` (place TTT mark or interact) |
| Toggle sound effects | 🔊 button in the top bar |

## How it works

```text
index.html                     Canvas, HUD, setup wizard, dialogue, friend list
css/app.css                    Layout, panels, responsive rules
data/avatar_config.json        Avatar variants, palettes, and companion styles
data/engine_config.json        Movement timings, tile dimensions, crowd limits
data/items.json                Item catalog, starter loadouts, icons, actions
data/forage.json               Apple/mushroom pickup and respawn settings
data/sounds.json               Synthesized sound cue recipes
data/dialogues.json            Dialogue templates and HUD action menu schemas
data/entities.json             NPC names, player names, and personality vibe text
data/cubeworld_pets.json       Pre-rendered offline 3D voxel sprite sheets
src/main.js                    App state, event wiring, and save coordinator
src/game.js                    Camera, movement physics, collisions, character registry
src/renderer.js                Canvas WorldRenderer, viewport math, and minimap
src/animation.js               Family animation profiles, locomotion, and cycles
src/dialogue.js                Dialogue manager for bump-to-talk conversations
src/storage.js                 Game state persistence, save migrations, and stats
src/world.js                   Seeded terrain generation, terrain encoding, pathfinding
src/avatar.js                  DiceBear recipes, local SVG generation, image cache
src/characters.js              Pure tile-occupancy, exclusions, companion formatters
src/facing.js                  Direction mapping and left/right mirroring
src/names.js                   Name picker and vibe selectors backed by entities.json
src/inventory.js               Item getters and starter inventory factory
src/forage.js                  Apple spawning, mushroom harvests, and basket state
src/audio.js                   Web Audio cue synthesis and sound preference
src/ui/panels.js               Consolidated 5-tab HUD player menu & keyboard nav
src/ui/wizard.js               Character and park setup wizard
src/games/fetch.js             Fetch mini-game: ball trajectory and companion fetch AI
src/games/tic-tac-toe.js       In-world 3×3 Tic-Tac-Toe board on map tiles
src/games/checkers.js          In-world 8×8 Checkers/Draughts board on map tiles
vendor-src/dicebear.js         Entry point for the vendored bundle
vendor/dicebear-voxel.js       Generated DiceBear + Voxel Art bundle (committed)
scripts/render_cubeworld_pets.py Standalone 3D software rasterizer for pet models
test/                          Node test runner suites for pure logic
```

### Characters

A character is stored as a compact recipe:

```js
{
  seed: 'clover-4pxbyrw',
  look: {
    top: 'random',
    outfit: 'hoodie',
    glasses: 'none',
    beard: 'random',
    skin: '#c08457',
    hair: '#241a14',
    shirt: '#f76707',
    pants: '#2f4160',
    shoes: '#6741d9'
  }
}
```

The recipe is passed to the bundled DiceBear renderer to produce a deterministic SVG,
which is cached as a data URL and drawn onto the canvas. No uploaded images are stored.

### World and save format

`generateWorld(seed)` creates the terrain deterministically from a seed. The save format
stores the terrain compactly as a 4,096-character string (`g`, `d`, `s`, `w`, `f` for
grass, dirt, sand, water, field) plus character recipes, positions, friendships, the
wander flag, and the forage basket (picked apples/mushrooms plus regrow clocks). State is
saved under `playpark.save.v1` in `localStorage`.

### Collision rules

- A character on a tile occupies it.
- A moving character also reserves its destination tile.
- Player steps and NPC steps are rejected if either tile is reserved by someone else.
- Bumping into an NPC starts a dialogue instead of moving into their tile.

## Tests

The pure logic is tested with Node's built-in test runner:

```sh
npm test
```

Coverage includes world generation, terrain round-tripping, pathfinding (including the
wings' water-crossing mode), blocked paths, tile reservation/collision helpers,
facing/mirroring rules, avatar determinism, name generation, forage respawn and
basket state, effect abilities, and sound cue data. `src/game.js` is intentionally import-safe in Node so the module can at least
be smoke-tested without a browser.

## Attributions & Credits

- **[DiceBear](https://www.dicebear.com/)**: Character avatars and companion styles ([Voxel Art](https://www.dicebear.com/styles/voxel-art/), Clay, Critters, Gaze, Sprouts, and Bot) are provided by [DiceBear](https://www.dicebear.com/) and licensed under [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/). The bundle is vendored locally into `vendor/dicebear-voxel.js`.
- **[Quaternius](https://quaternius.com/)**: Cube World animal pets and fantasy creature 3D voxel models are created by [Quaternius](https://quaternius.com/) (CC0 / Public Domain), pre-rendered offline into directional voxel sprite sheets (`data/cubeworld_pets.json`) using our standalone software rasterizer (`scripts/render_cubeworld_pets.py`).
- **[Kitbitz](https://kitbitz.art/)**: Illustrated park nature scenery (Apple Trees, Puffy Birch Trees, Chestnut Trees, Flowering Bushes, Boulders, Red Flowers, Forest Mushrooms, and Grass Tufts) from the [Nature Kit](https://kitbitz.art/kits/nature-kit) are provided by [Kitbitz](https://kitbitz.art/) and licensed under [CC0 1.0 Universal (Public Domain)](https://creativecommons.org/publicdomain/zero/1.0/).

## Deployment

The site is static and can be served from the repository root. The `CNAME` file points
GitHub Pages at `pp.livive.net`. Pushes to `main` are the only deployment step.

## License

The application code is MIT licensed. See [LICENSE](LICENSE).
