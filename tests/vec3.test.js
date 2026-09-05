import { describe, expect, it } from 'vitest';
import { add, dot, length, rotateX, rotateY, rotateZ, scale, sub, vec3 } from '../src/core/vec3.js';

const HALF_PI = Math.PI / 2;

describe('vec3', () => {
  it('constructs with zero defaults', () => {
    expect(vec3()).toEqual({ x: 0, y: 0, z: 0 });
    expect(vec3(1, 2, 3)).toEqual({ x: 1, y: 2, z: 3 });
  });

  it('adds, subtracts, scales and dots', () => {
    const a = vec3(1, 2, 3);
    const b = vec3(4, 5, 6);
    expect(add(a, b)).toEqual({ x: 5, y: 7, z: 9 });
    expect(sub(b, a)).toEqual({ x: 3, y: 3, z: 3 });
    expect(scale(a, 2)).toEqual({ x: 2, y: 4, z: 6 });
    expect(dot(a, b)).toBe(32);
  });

  it('measures length', () => {
    expect(length(vec3(3, 4, 0))).toBe(5);
    expect(length(vec3(0, 0, 0))).toBe(0);
  });
});

describe('rotations', () => {
  const rotations = { rotateX, rotateY, rotateZ };

  for (const [name, rotate] of Object.entries(rotations)) {
    it(`${name}(0) is the identity`, () => {
      const v = vec3(1.5, -2.5, 3.5);
      const r = rotate(v, 0);
      expect(r.x).toBeCloseTo(v.x, 12);
      expect(r.y).toBeCloseTo(v.y, 12);
      expect(r.z).toBeCloseTo(v.z, 12);
    });

    it(`${name} preserves length`, () => {
      const v = vec3(3, -4, 12);
      for (const angle of [0.1, 1, 2.7, -5]) {
        expect(length(rotate(v, angle))).toBeCloseTo(length(v), 10);
      }
    });

    it(`${name} composes: two half turns return to the start`, () => {
      const v = vec3(2, 3, -1);
      const back = rotate(rotate(v, Math.PI), Math.PI);
      expect(back.x).toBeCloseTo(v.x, 10);
      expect(back.y).toBeCloseTo(v.y, 10);
      expect(back.z).toBeCloseTo(v.z, 10);
    });
  }

  it('rotateX maps +Y onto +Z (right-handed)', () => {
    const r = rotateX(vec3(0, 1, 0), HALF_PI);
    expect(r.x).toBeCloseTo(0, 12);
    expect(r.y).toBeCloseTo(0, 12);
    expect(r.z).toBeCloseTo(1, 12);
  });

  it('rotateZ maps +X onto +Y (right-handed)', () => {
    const r = rotateZ(vec3(1, 0, 0), HALF_PI);
    expect(r.x).toBeCloseTo(0, 12);
    expect(r.y).toBeCloseTo(1, 12);
    expect(r.z).toBeCloseTo(0, 12);
  });

  it('rotateY maps +Z onto +X (right-handed)', () => {
    const r = rotateY(vec3(0, 0, 1), HALF_PI);
    expect(r.x).toBeCloseTo(1, 12);
    expect(r.y).toBeCloseTo(0, 12);
    expect(r.z).toBeCloseTo(0, 12);
  });

  it('leaves its own axis untouched', () => {
    expect(rotateX(vec3(7, 0, 0), 1.23).x).toBeCloseTo(7, 12);
    expect(rotateY(vec3(0, 7, 0), 1.23).y).toBeCloseTo(7, 12);
    expect(rotateZ(vec3(0, 0, 7), 1.23).z).toBeCloseTo(7, 12);
  });
});
