# Always-On World Editing — Analysis & Recommendation

**Baseline:** `c1e2faf` · 708 tests · Decorate mode, per-location props/scenery, building swap
**Status:** Recommendation · **Last updated:** 2026-11-02

---

## 1. What feels wrong today

The current editor is a **mode**:

- A Decorate toggle in the Backpack turns canvas clicks into edit clicks.
- Outside it, clicking a prop does nothing; inside it, walking, NPC bumps, doors, and Home item clicks are suppressed.
- Buildings only **swap**; they cannot move to a free spot.
- Overlapping objects are always rejected, even when the overlap is a tree or a bench that could reasonably move.

The mode exists to disambiguate “walk here” from “edit this”, but it makes the world feel like a level editor you enter and leave. The Home item card already does better: tap the object, get its card, no global mode.

---

## 2. Recommendation: contextual editing, no mode

Remove the Decorate toggle. Resolve intent per click:

| Click target | Result |
| --- | --- |
| An NPC or companion | Their character card, as today |
| A Home item | Its Home item card, as today |
| A world prop or scenery item | Its world-object card (Move / Style / Rotate / Reset) |
| A building | Its building card (Move / Reset) |
| Empty ground | Walk / pathfind, as today |
| During an active draft | Place the object; everything else is suppressed |

The card is the mode. There is no global switch, no Backpack row required to start editing, and normal play is never blocked.

**Drag is an optional accelerator:** press and drag a prop/scenery item to move it directly; a short tap opens the card. On touch, tap opens the card and **Move** starts the draft, so no long-press gesture is required. A click that does not move beyond a small threshold is a tap.

Keyboard: when a draft is active, arrows/WASD move it, `R` rotates, `C` styles, Enter places, Escape cancels. When no draft is active, the keyboard behaves normally. A selected card may use `R`/`C` without stealing movement keys.

---

## 3. Buildings: free movement, not swaps

Replace the swap-only card with **Move**.

1. Tap a building → card with **Move**.
2. Move mode shows the building footprint; click/arrows place it anywhere that fits.
3. The door trigger and doorway openings travel with the building (already implemented).
4. Rotation is **not** in this pass; the facade art is south-facing.

There are no lots. A house can go anywhere a 6×4 footprint fits, provided the rules below pass.

---

## 4. Scooting: what happens when objects overlap

Two classes of obstruction:

**Hard blockers — placement refused.**
- Another building
- A door trigger or activity entrance
- The spawn tile
- The player, an NPC, a companion, or a buddy
- Water / unwalkable terrain
- The map edge

**Soft objects — can be scooted with confirmation.**
- Scenery: trees, bushes, flowers, rocks
- Ground cover: rugs, blankets, towels, flower beds
- Small props: benches, lamps, planters, bins, mailboxes, signs, market stalls, chairs, desks
- In short: every prop except buildings

Flow on drop:

```text
Building footprint overlaps 3 soft objects.
┌────────────────────────────────────────────┐
│ Place the house here?                      │
│ 3 objects will move nearby:                │
│   • puffy tree                             │
│   • bench                                  │
│   • planter                                │
│ [ Place and move them ]  [ Cancel ]        │
└────────────────────────────────────────────┘
```

On **Place**:

1. Compute a destination for each soft object: nearest open footprint by spiral search, honouring its own size, terrain, doors, spawn, characters, and other objects.
2. If any object cannot find a home, abort the whole placement with a reason (“no room nearby for the bench”). Nothing moves.
3. Apply the building move and every scoot as **one transaction**.
4. Rebuild doors and run the spawn/door path check on the final layout.

The confirmation is a small dialogue beat or card, not a full-screen modal. It lists what will move so the player is never surprised.

Non-blocking ground cover can sit under a building without moving; it is only listed if it would be visually buried and the player wants it moved. Recommendation: scoot solid soft objects, leave rugs/towels under the footprint alone.

---

## 5. Safeguards

| Check | Rule |
| --- | --- |
| Bounds | Footprint inside the map / room |
| Hard overlap | No building, door, spawn, character, or water |
| Soft overlap | Allowed only with the confirmation menu and a complete scoot plan |
| Path | Flood fill after the full plan; every door and the spawn must stay reachable |
| Terrain | Prop-specific allowed terrain (palms on sand, trees on grass) |
| Atomicity | Build the full plan, validate, then apply; failure changes nothing |
| Lost objects | Clamp to map; Reset object and Reset place always available |
| Accidental edits | Tap opens a card; drag needs a small threshold; scooting needs confirmation |
| Undo | One-step undo for the last move/place, optional phase |

---

## 6. Technical shape

- **Mode removal:** `decorate` keeps only `{ card, draft }`; drop the `active` gate. `handleCanvasPointer` always hit-tests, with character priority before props unless a draft is active. `handleDecorateKey` captures only while a draft exists.
- **Hit-test order:** character → selected draft → prop → ground cover → scenery → building → ground walk. Home items keep their existing path.
- **Building move:** extend `canPlaceWorldObject` to accept `kind: 'building'`; reuse the footprint/terrain/path checks.
- **Scoot planner:** new pure `planScoot(...)` in `src/world_edit.js` returning `{ ok, moves, reason }`. Reuse it for buildings and, later, for any large object.
- **Transaction:** `applyWorldMove({ building, scoots })` updates props/scenery/doors, then saves once.
- **UI:** reuse the existing world-object card and draft HUD. Delete the “Decorate this place” row; keep **Reset this place** in the Backpack.
- **Home:** unchanged; its card already behaves this way.

---

## 7. Phases

| Phase | Work | Test |
| --- | --- | --- |
| **A** | Remove the mode; always-on cards and drafts; character priority; card/HUD only while active | Click a bench while walking; click an NPC in front of it |
| **B** | Building free move, replacing swap; reject hard overlaps | Move a house to an empty block; door follows |
| **C** | Scoot plan + confirmation menu + atomic apply + path check | Move a house over a tree/bench; confirm; everyone lands nearby |
| **D** | Drag-to-move, one-step undo, polish | Drag a bench; undo |

A and B are the core change. C is the feature the request is really about. D is feel.

---

## 8. Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Always-on clicks fight walking | Medium | Object hit-test only wins when the click is actually on an object; empty ground walks |
| NPC hidden behind a prop becomes hard to click | Medium | Character priority before props |
| Destroying the town layout | High | Confirmation, scoot plan, path check, reset, undo |
| Scoot has nowhere to put an object | Medium | Abort the whole move with a named reason; nothing changes |
| Doors detach from buildings | High | Doors remain derived from building records; rebuild after every move |
| Accidental drags | Medium | Threshold + card tap; confirm for scooting |
| Save halfway through a move | High | One transaction, one save; validate before mutating |

---

## 9. Recommendation

Do **A + B** first: remove the mode and make buildings free-moving with hard-overlap rejection. That alone changes the feel from “editor mode” to “the world is mine”.

Then **C**: the confirmation-and-scoot flow. That is the part that makes placement forgiving instead of fussy, and it needs the transaction and path checks to be trustworthy.

Skip freeform building rotation for now. Keep the reset and add a one-step undo in D.

**Immediate answer:** yes — no mode, tap anything to edit it, drag to move, and buildings move freely. A house may overlap soft dressing only after a clear confirmation, and everything it displaces is re-homed nearby or the placement is refused.
