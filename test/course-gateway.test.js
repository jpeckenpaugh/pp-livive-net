import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  TILE,
  WorldRenderer,
  activityGatewayLayout
} from '../src/renderer.js';
import {
  activityChoiceLabel,
  activityList,
  validateActivityDefinition
} from '../src/activities/platformer.js';
import {
  LOCATION_PROP_IDS,
  locationBlockedTiles,
  locationProp,
  propTiles
} from '../src/location_props.js';
import { propsForLocation } from '../src/locations.js';

const world = JSON.parse(readFileSync(new URL('../data/world.json', import.meta.url), 'utf8'));
const park = world.locations.park;
const activityDoor = (park.doors || []).find(door => door.kind === 'activity');
const kioskRecord = (park.props || []).find(prop => prop.type === 'course-kiosk');

/** Minimal recording context; the gateway and kiosk only paint and write text. */
function stubContext() {
  const noop = () => {};
  return {
    texts: [],
    save: noop,
    restore: noop,
    beginPath: noop,
    closePath: noop,
    moveTo: noop,
    lineTo: noop,
    quadraticCurveTo: noop,
    rect: noop,
    roundRect: noop,
    arc: noop,
    ellipse: noop,
    fill: noop,
    stroke: noop,
    fillRect: noop,
    strokeRect: noop,
    globalAlpha: 1,
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    fillText(text, x, y) {
      this.texts.push({ text, x, y });
    }
  };
}

test('every course carries a short board subtitle and consistent metadata', () => {
  const expected = new Map([
    ['jungle-gym', 'grass & wood'],
    ['rooftops', 'city roofs'],
    ['shoreline', 'sand & sea']
  ]);
  assert.equal(activityList().length, expected.size);
  for (const definition of activityList()) {
    assert.equal(typeof definition.subtitle, 'string', `${definition.id} needs a subtitle`);
    assert.equal(definition.subtitle.trim(), expected.get(definition.id));
    assert.equal(validateActivityDefinition(definition).ok, true, definition.id);
  }
});

test('the course kiosk is a walkable 2×2 prop beside the playground', () => {
  assert.ok(LOCATION_PROP_IDS.includes('course-kiosk'));
  const kiosk = locationProp('course-kiosk');
  assert.equal(kiosk.shape, 'course-kiosk');
  assert.deepEqual(kiosk.size, { w: 2, h: 2 });
  assert.equal(kiosk.solid, false, 'the kiosk must stay walkable');
  assert.ok(Array.isArray(kiosk.variants) && kiosk.variants.length >= 2);

  assert.ok(kioskRecord, 'the Park places the kiosk');
  assert.deepEqual(propTiles(kioskRecord), [
    { x: 21, y: 17 },
    { x: 22, y: 17 },
    { x: 21, y: 18 },
    { x: 22, y: 18 }
  ]);

  // The kiosk flanks the arch instead of standing in it or on its approach.
  assert.ok(kioskRecord.x > activityDoor.x + 1, 'kiosk sits east of the gateway');
  assert.ok(kioskRecord.y < activityDoor.y, 'kiosk sits behind the door row');
  assert.ok(!propTiles(kioskRecord).some(tile => tile.x === activityDoor.x && tile.y === activityDoor.y));
});

test('the gateway stays centred on the activity door and leaves the trigger tile open', () => {
  const layout = activityGatewayLayout(activityDoor);
  assert.equal(layout.cx, (activityDoor.x + 0.5) * TILE);
  assert.equal(layout.baseY, (activityDoor.y + 0.9) * TILE);

  // The arch spans the door tile…
  assert.ok(layout.left <= activityDoor.x * TILE);
  assert.ok(layout.right >= (activityDoor.x + 1) * TILE);
  // …while both posts stand outside it, so nothing paints over the trigger.
  assert.ok(layout.left + layout.postWidth < activityDoor.x * TILE);
  assert.ok(layout.right - layout.postWidth > (activityDoor.x + 1) * TILE);

  const ctx = stubContext();
  const renderer = Object.create(WorldRenderer.prototype);
  renderer.drawActivityDoorMarker(ctx, activityDoor, 0);

  const banner = ctx.texts.find(entry => entry.text === 'COURSES');
  assert.ok(banner, 'the gateway banner reads COURSES');
  assert.ok(Math.abs(banner.x - layout.cx) < 1, 'the banner is centred over the door');
  assert.ok(banner.y < layout.baseY, 'the banner hangs above the walking line');
});

test('the kiosk renders its board with one row per course', () => {
  const ctx = stubContext();
  const renderer = Object.create(WorldRenderer.prototype);
  renderer.ctx = ctx;
  renderer.drawLocationProp(kioskRecord, { time: 2.5 });

  const lines = ctx.texts.map(entry => entry.text);
  assert.ok(lines.includes('COURSES'), 'the kiosk board has a heading');
  for (const definition of activityList()) {
    const short = String(definition.title).split(/\s+/)[0];
    assert.ok(lines.some(line => line.startsWith(short)), `kiosk lists ${short}`);
  }
});

test('no solid prop stands on the gym door or the Park spawn', () => {
  const blocked = locationBlockedTiles(propsForLocation('park'));
  assert.equal(blocked.has(`${activityDoor.x},${activityDoor.y}`), false, 'gym trigger is clear');
  assert.equal(blocked.has(`${park.spawn.x},${park.spawn.y}`), false, 'spawn is clear');

  for (const tile of propTiles(kioskRecord)) {
    assert.equal(blocked.has(`${tile.x},${tile.y}`), false, 'kiosk tiles are walkable');
  }
});

test('the course board label carries the subtitle, par, and best time', () => {
  for (const definition of activityList()) {
    const label = activityChoiceLabel(definition, 28420);
    assert.ok(label.includes(definition.title), `${definition.id} title`);
    assert.ok(label.includes(definition.subtitle), `${definition.id} subtitle`);
    assert.ok(label.includes(`par ${Number(definition.par).toFixed(2)}s`), `${definition.id} par`);
    assert.ok(label.includes('best 28.42s'), `${definition.id} best`);
    assert.ok(activityChoiceLabel(definition, null).includes('no time yet'));
  }
});
