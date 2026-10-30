# AGENTS.md

Guidance for agents working in this repository.

## Project

**Play Park** is a static browser playground for [pp.livive.net](https://pp.livive.net).
It renders a seeded 64 × 64 tile park on a canvas, generates player and NPC characters
locally with DiceBear **Voxel Art**, and provides wandering neighbours, bump-to-talk
dialogue, friendships, and autosave.

The repository root is the deployable site. There is no bundler or framework in the app:
`index.html`, `css/app.css`, and native ES modules in `src/`. DiceBear is pre-bundled into
`vendor/dicebear-voxel.js` so the app makes no runtime network requests.

## Commands

```sh
./install.sh        # install dev dependencies
./run.sh            # static server at http://localhost:4173
npm start           # static server at http://localhost:4173
npm test            # node:test suites in test/
npm run vendor      # rebuild vendor/dicebear-voxel.js from vendor-src/dicebear.js
npm run render:pets # re-render data/cubeworld_pets.json from assets/cubeworld-src
```

`npm install` is only needed for `npm run vendor` or when changing dev tooling. Do not
commit `node_modules/`.

## Architecture

| Path | Responsibility |
| --- | --- |
| `data/avatar_config.json` | Avatar variants, color palettes, and companion style list |
| `data/engine_config.json` | Movement timings, tile dimensions, and crowd parameters |
| `data/items.json` | Item catalog, starter loadouts, metadata, and default icons |
| `data/forage.json` | Apple/mushroom pickup caps and respawn timings |
| `data/sounds.json` | Oscillator recipes for synthesized game cues |
| `data/dialogues.json` | Dialogue templates, prompts with `{name}` interpolation, and menu schemas |
| `data/entities.json` | NPC names, player names, and vibes/flavour text |
| `data/cubeworld_pets.json` | Pre-rendered offline sprite sheets for Cube World animal pets and creatures |
| `src/main.js` | App state, dialogue triggers, save loop, and event wiring |
| `src/game.js` | Movement physics, tile collision, camera, character registry, wander AI |
| `src/renderer.js` | Canvas WorldRenderer, viewport math, layer sorting, and minimap |
| `src/animation.js` | Family animation profiles, procedural locomotion, and cycle frame evaluators |
| `src/dialogue.js` | Dialogue manager for bump-to-talk conversations and friendship updates |
| `src/storage.js` | LocalStorage serialization, schema migrations, and match statistics |
| `src/world.js` | Seeded terrain generation, terrain encoding, BFS pathfinding, open-tile search |
| `src/avatar.js` | Recipe builder, DiceBear options, local SVG generation, image cache |
| `src/characters.js` | Pure occupancy, collision exclusions, and companion info formatters |
| `src/facing.js` | Four-direction mapping and Voxel Art left/right mirroring |
| `src/names.js` | Name picker and vibe generator backed by `data/entities.json` |
| `src/inventory.js` | Starter inventory factory and item definition getters |
| `src/forage.js` | Apple spawning, harvestable mushrooms, and basket persistence |
| `src/audio.js` | Synthesized sound effects and the saved mute preference |
| `src/ui/panels.js` | Unified 5-tab HUD player menu, keyboard navigation, and side panels |
| `src/ui/wizard.js` | Park setup wizard, draft creation, and avatar customizer |
| `src/games/fetch.js` | Fetch mini-game: ball trajectory and companion fetch AI |
| `src/games/tic-tac-toe.js` | In-world 3×3 Tic-Tac-Toe board on map tiles with turn-taking |
| `src/games/checkers.js` | In-world 8×8 Checkers/Draughts board on map tiles with turn-taking |
| `vendor-src/dicebear.js` | Source entry used to build the committed vendor bundle |
| `vendor/dicebear-voxel.js` | Generated bundle; do not hand-edit |
| `scripts/render_cubeworld_pets.py` | Standalone 3D software rasterizer generating `data/cubeworld_pets.json` |
| `test/` | `node:test` suites for pure logic |

Keep `src/game.js` import-safe in Node: no DOM access at module top level, only inside the
`Game` class or its methods. This lets tests import the module and keeps pure logic
extractable.

## Core invariants

- **No runtime API calls.** Do not switch avatar generation to `api.dicebear.com`. The
  app must work offline. Add new styles by extending the vendored bundle.
- **Characters are recipes, not images.** Persist `{ seed, look }`; render the SVG locally.
  Do not store uploaded avatars in saves.
- **Tile collision is strict.** A character occupies its current tile and reserves its
  destination while moving. Player steps and NPC steps must fail if either tile is
  reserved by someone else. Use `src/characters.js`; do not duplicate the reservation
  logic.
- **Bumping is dialogue.** Moving into an NPC should open the dialogue instead of moving
  or overlapping. Dialogue pauses movement and wanders.
- **Voxel Art faces left by default.** `shouldMirror(direction)` in `src/facing.js` only
  mirrors rightward movement (`RIGHT`). Keep that convention if you change rendering.
- **The world is 64 × 64.** Terrain rows are 64 tiles. `encodeTerrain` produces exactly
  4,096 characters (`g`, `d`, `s`, `w`, `f`) and `decodeTerrain` validates that.
- **Save compatibility.** Saves live under `playpark.save.v1`. When changing the shape,
  either keep reading older saves or bump the version and handle migration. Persist
  `friends` as NPC IDs, not indexes.
- **Character recipes vs. companion sprite sheets.** Player and humanoid NPCs deliberately
  use DiceBear Voxel Art recipes `{ seed, look }` rendered offline to local SVGs. Companion
  animals and creatures use pre-rendered 3D software-rasterized voxel sprite sheets in
  `data/cubeworld_pets.json`. No runtime external API requests are permitted for either.
- **Data-driven configuration.** Constants, avatar variants, items, engine parameters,
  and dialogue scripts belong in `data/*.json` files. Prefer updating external JSON data
  over hardcoding constants in JavaScript modules.

## Testing policy

- Add or update tests in `test/` for any change to world generation, pathfinding,
  collision/reservation rules, facing, avatar recipes, saves, or name generation.
- Prefer pure functions/modules so logic can be tested without a browser.
- Run `npm test` before committing.
- Use the browser only for a brief visual/console sanity check, not as the primary test
  harness. Do not add browser automation or screenshots to the repository.

## UI conventions

- Plain HTML/CSS/JS, native `<button>` elements, labels for inputs, and `aria-*` state
  where interactive panels toggle.
- Use the existing CSS variables in `css/app.css`; keep the dark-green park palette.
- Keep the HUD usable on small screens. Panels are fixed-position and responsive at the
  existing breakpoints.
- Do not block the canvas with modal overlays except the setup wizard and dialogue, which
  intentionally pause play.
- Player-facing copy is short, friendly, and lower-case casual.

## Workflow

1. Read the relevant module and tests first.
2. Make the smallest change that fits the existing patterns.
3. Run `npm test`.
4. For visual changes, check `npm start` once in a browser.
5. Commit only source, tests, docs, and required vendor output. Never commit
   `node_modules`, local saves, screenshots, or secrets.

## Deployment

GitHub Pages serves the repository root. `CNAME` maps it to `pp.livive.net`. Pushing to
`main` is the deployment step; do not add a build pipeline unless the project actually
needs one.

## Licenses & Attributions

- Application code: MIT (`LICENSE`).
- Character avatars: [DiceBear](https://www.dicebear.com/) (Voxel Art & companion avatar styles, CC0 1.0).
- 3D Cube World pets & creatures: [Quaternius](https://quaternius.com/) (CC0 / Public Domain), rasterized offline via `scripts/render_cubeworld_pets.py`. See `README.md` for details.
- Park nature scenery: [Kitbitz](https://kitbitz.art/) Nature Kit (CC0 1.0 Universal).
