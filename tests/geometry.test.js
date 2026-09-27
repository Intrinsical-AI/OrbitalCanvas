import { describe, expect, it } from 'vitest';
import { euclidean } from '../src/core/geometry/euclidean.js';
import { createRing, syncRingTrig } from '../src/core/ring.js';

function orbitPoint(ring, index, count) {
  return euclidean.orbitPoint(ring, index, count, { x: 0, y: 0, z: 0 });
}

/**
 * @param {object} [overrides]
 * @returns {import('../src/core/ring.js').Ring}
 */
function ring(overrides = {}) {
  return syncRingTrig({ ...createRing({ seq: 0, radius: 100, planeAngle: 0 }), ...overrides });
}

/** Closed-form reference: rotateX(tilt), then rotateZ(yaw), evaluated directly. */
function reference(r, index, count) {
  const theta = (2 * Math.PI * index) / count + r.phase;
  const localX = r.radius * Math.cos(theta);
  const localY = r.radius * Math.sin(theta);
  const tiltedY = localY * Math.cos(r.tilt);
  return {
    x: localX * Math.cos(r.yaw) - tiltedY * Math.sin(r.yaw),
    y: localX * Math.sin(r.yaw) + tiltedY * Math.cos(r.yaw),
    z: localY * Math.sin(r.tilt),
  };
}

describe('euclidean.orbitPoint', () => {
  it('matches the closed-form rotation for arbitrary rings, phases and counts', () => {
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 10 - 5;
    for (const count of [3, 7, 72, 240, 7]) {
      for (let trial = 0; trial < 20; trial++) {
        const r = ring({
          radius: 50 + Math.abs(rand()) * 100,
          tilt: rand(),
          yaw: rand(),
          phase: rand() * 40,
        });
        for (let i = 0; i < count; i += Math.max(1, count >> 3)) {
          const got = orbitPoint(r, i, count);
          const want = reference(r, i, count);
          expect(got.x).toBeCloseTo(want.x, 9);
          expect(got.y).toBeCloseTo(want.y, 9);
          expect(got.z).toBeCloseTo(want.z, 9);
        }
      }
    }
  });

  it('places every particle at exactly the ring radius, whatever the orientation', () => {
    for (const tilt of [0, 0.3, 1.1, Math.PI / 2, 2.9]) {
      for (const yaw of [0, 0.7, 2.2]) {
        const r = ring({ radius: 137, tilt, yaw });
        for (let i = 0; i < 12; i++) {
          const { x, y, z } = orbitPoint(r, i, 12);
          expect(Math.hypot(x, y, z)).toBeCloseTo(137, 9);
        }
      }
    }
  });

  it('keeps an untilted ring in the XY plane', () => {
    const r = ring({ tilt: 0, yaw: 0 });
    for (let i = 0; i < 16; i++) {
      expect(orbitPoint(r, i, 16).z).toBeCloseTo(0, 12);
    }
  });

  it('puts a quarter-turn tilt into the XZ plane', () => {
    // rotateX(PI/2) sends the local +Y axis to +Z, so the circle loses its Y extent.
    const r = ring({ tilt: Math.PI / 2, yaw: 0 });
    for (let i = 0; i < 16; i++) {
      expect(orbitPoint(r, i, 16).y).toBeCloseTo(0, 12);
    }
  });

  it('a tilted ring genuinely leaves the XY plane', () => {
    const r = ring({ tilt: 0.6, yaw: 0.2 });
    const zs = Array.from({ length: 24 }, (_, i) => orbitPoint(r, i, 24).z);
    expect(Math.max(...zs.map(Math.abs))).toBeGreaterThan(1);
  });

  it('distributes particles evenly around the circle', () => {
    const r = ring({ tilt: 0, yaw: 0, radius: 10 });
    const first = orbitPoint(r, 0, 4);
    const quarter = orbitPoint(r, 1, 4);
    expect(first.x).toBeCloseTo(10, 9);
    expect(first.y).toBeCloseTo(0, 9);
    expect(quarter.x).toBeCloseTo(0, 9);
    expect(quarter.y).toBeCloseTo(10, 9);
  });

  it('advances every particle by the ring phase', () => {
    const base = ring({ tilt: 0, yaw: 0, radius: 10, phase: 0 });
    const turned = ring({ tilt: 0, yaw: 0, radius: 10, phase: Math.PI / 2 });
    const a = orbitPoint(base, 0, 4);
    const b = orbitPoint(turned, 0, 4);
    expect(b.x).toBeCloseTo(orbitPoint(base, 1, 4).x, 9);
    expect(b.y).toBeCloseTo(orbitPoint(base, 1, 4).y, 9);
    expect(a.x).not.toBeCloseTo(b.x, 3);
  });

  it('yaw is not a no-op once the ring is tilted', () => {
    const tilted = ring({ tilt: 0.8, yaw: 0 });
    const yawed = ring({ tilt: 0.8, yaw: 1.2 });
    const a = orbitPoint(tilted, 3, 12);
    const b = orbitPoint(yawed, 3, 12);
    expect(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)).toBeGreaterThan(1);
  });

  it('can write a point into a reusable output object', () => {
    const r = ring({ radius: 73, tilt: Math.PI / 2, yaw: Math.PI / 2, phase: 0 });
    const out = { x: 0, y: 0, z: 0 };
    expect(euclidean.orbitPoint(r, 1, 4, out)).toBe(out);
    expect(out.x).toBeCloseTo(0, 10);
    expect(out.y).toBeCloseTo(0, 10);
    expect(out.z).toBeCloseTo(73, 10);
  });
});
