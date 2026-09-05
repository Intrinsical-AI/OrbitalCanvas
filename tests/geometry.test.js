import { describe, expect, it } from 'vitest';
import { euclidean, getGeometry, listGeometries } from '../src/core/geometry/index.js';
import { createRing } from '../src/core/ring.js';
import { length } from '../src/core/vec3.js';

/**
 * @param {object} [overrides]
 * @returns {import('../src/core/ring.js').Ring}
 */
function ring(overrides = {}) {
  return { ...createRing({ seq: 0, radius: 100, planeAngle: 0 }), ...overrides };
}

describe('geometry registry', () => {
  it('resolves the euclidean geometry', () => {
    expect(getGeometry('euclidean')).toBe(euclidean);
  });

  it('throws with a helpful message on an unknown id', () => {
    expect(() => getGeometry('hyperbolic')).toThrow(/Unknown geometry "hyperbolic"/);
    expect(() => getGeometry('hyperbolic')).toThrow(/euclidean/);
  });

  it('lists registered geometries for the UI', () => {
    expect(listGeometries()).toEqual([{ value: 'euclidean', label: 'Euclidean' }]);
  });
});

describe('euclidean.orbitPoint', () => {
  it('places every particle at exactly the ring radius, whatever the orientation', () => {
    for (const tilt of [0, 0.3, 1.1, Math.PI / 2, 2.9]) {
      for (const yaw of [0, 0.7, 2.2]) {
        const r = ring({ radius: 137, tilt, yaw });
        for (let i = 0; i < 12; i++) {
          expect(length(euclidean.orbitPoint(r, i, 12))).toBeCloseTo(137, 9);
        }
      }
    }
  });

  it('keeps an untilted ring in the XY plane', () => {
    const r = ring({ tilt: 0, yaw: 0 });
    for (let i = 0; i < 16; i++) {
      expect(euclidean.orbitPoint(r, i, 16).z).toBeCloseTo(0, 12);
    }
  });

  it('puts a quarter-turn tilt into the XZ plane', () => {
    // rotateX(PI/2) sends the local +Y axis to +Z, so the circle loses its Y extent.
    const r = ring({ tilt: Math.PI / 2, yaw: 0 });
    for (let i = 0; i < 16; i++) {
      expect(euclidean.orbitPoint(r, i, 16).y).toBeCloseTo(0, 12);
    }
  });

  it('a tilted ring genuinely leaves the XY plane', () => {
    // The pre-refactor code had no z coordinate at all; this is the regression guard.
    const r = ring({ tilt: 0.6, yaw: 0.2 });
    const zs = Array.from({ length: 24 }, (_, i) => euclidean.orbitPoint(r, i, 24).z);
    expect(Math.max(...zs.map(Math.abs))).toBeGreaterThan(1);
  });

  it('distributes particles evenly around the circle', () => {
    const r = ring({ tilt: 0, yaw: 0, radius: 10 });
    const first = euclidean.orbitPoint(r, 0, 4);
    const quarter = euclidean.orbitPoint(r, 1, 4);
    expect(first.x).toBeCloseTo(10, 9);
    expect(first.y).toBeCloseTo(0, 9);
    expect(quarter.x).toBeCloseTo(0, 9);
    expect(quarter.y).toBeCloseTo(10, 9);
  });

  it('advances every particle by the ring phase', () => {
    const base = ring({ tilt: 0, yaw: 0, radius: 10, phase: 0 });
    const turned = ring({ tilt: 0, yaw: 0, radius: 10, phase: Math.PI / 2 });
    const a = euclidean.orbitPoint(base, 0, 4);
    const b = euclidean.orbitPoint(turned, 0, 4);
    expect(b.x).toBeCloseTo(euclidean.orbitPoint(base, 1, 4).x, 9);
    expect(b.y).toBeCloseTo(euclidean.orbitPoint(base, 1, 4).y, 9);
    expect(a.x).not.toBeCloseTo(b.x, 3);
  });

  it('yaw is not a no-op once the ring is tilted', () => {
    const tilted = ring({ tilt: 0.8, yaw: 0 });
    const yawed = ring({ tilt: 0.8, yaw: 1.2 });
    const a = euclidean.orbitPoint(tilted, 3, 12);
    const b = euclidean.orbitPoint(yawed, 3, 12);
    expect(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)).toBeGreaterThan(1);
  });

  it('can write a point into a reusable output object', () => {
    const r = ring({ radius: 73, tilt: 0.4, yaw: 0.7, phase: 0.2 });
    const out = { x: 0, y: 0, z: 0 };
    expect(euclidean.orbitPointInto(r, 5, 18, out)).toBe(out);
    expect(out).toEqual(euclidean.orbitPoint(r, 5, 18));
  });
});

describe('euclidean curvature interface', () => {
  it('is flat', () => {
    expect(euclidean.curvature).toBe(0);
  });

  it('uses the kappa=0 branch of the circumference law', () => {
    expect(euclidean.circumference(1)).toBeCloseTo(2 * Math.PI, 12);
    expect(euclidean.circumference(5)).toBeCloseTo(10 * Math.PI, 12);
    // Linear in r — the property that distinguishes it from sin/sinh curved branches.
    expect(euclidean.circumference(10) / euclidean.circumference(5)).toBeCloseTo(2, 12);
  });
});
