import { expect, it } from 'vitest';
import { Scene } from '../src/core/scene.js';
import { createRing } from '../src/core/ring.js';

it.each(['numPoints', 'planeAngle'])('editing %s preserves live rings and their clock', (key) => {
  const scene = new Scene({ circleInterval: 0.2 });
  for (let i = 0; i < 100; i++) scene.step(0.1);
  const rings = [...scene.rings];
  const phases = rings.map((ring) => ring.phase);
  const time = scene.time;
  scene.setMany([[key, scene.config[key] + 1]]);
  expect(scene.rings).toEqual(rings);
  expect(scene.rings.map((ring) => ring.phase)).toEqual(phases);
  expect(scene.time).toBe(time);
});

it('relative geometry preserves identity and phase while updating radius immediately', () => {
  const scene = new Scene();
  scene.step(0.1);
  const rings = [...scene.rings];
  const phases = rings.map((ring) => ring.phase);
  scene.setMany([
    ['innerRatio', 0.6],
    ['ringSpacing', 0.2],
  ]);
  expect(scene.rings.every((ring, index) => ring === rings[index])).toBe(true);
  expect(scene.rings.map((ring) => ring.phase)).toEqual(phases);
  expect(scene.rings.every((ring) => ring.radius >= 0.6 && ring.radius <= 1)).toBe(true);
  expect(scene.state.nextRadialSlot).toBeLessThan(3);
});

it('returning to Safe immediately drops the oldest prefix including fading rings', () => {
  const scene = new Scene({ numPoints: 240, maxRings: 48, circleInterval: 0.2 });
  scene.step(0.3);
  scene.setMany([
    ['numPoints', 128],
    ['maxRings', 25],
  ]);
  const time = scene.time,
    before = [...scene.rings];
  expect(before.some((ring) => ring.fading)).toBe(true);
  scene.enforceBudget();
  expect(scene.particleCount).toBeLessThanOrEqual(4000);
  expect(scene.rings).toEqual(before.slice(-31));
  expect(scene.rings.map((ring) => ring.seq)).toEqual(
    Array.from({ length: 31 }, (_, i) => before.at(-31).seq + i)
  );
  expect(scene.time).toBe(time);
});

it('bounds ring orientation independently of a long-running creation index', () => {
  const ring = createRing({ seq: 48000003, radius: 1, planeAngle: 0.2 });
  expect(ring.orientationSlot).toBe(3);
  expect(ring.tilt).toBeCloseTo(0.6);
  expect(ring.seq).toBe(48000003);
});
