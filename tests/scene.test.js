import { describe, expect, it } from 'vitest';
import { CONTROLS, rangeBounds } from '../src/core/config.js';
import { PARTICLE_BUDGET, Scene } from '../src/core/scene.js';
import { length, sub } from '../src/core/vec3.js';

/**
 * Collect every particle position in the scene.
 * @param {Scene} scene
 * @returns {import('../src/core/vec3.js').Vec3[]}
 */
function positions(scene) {
  const out = [];
  scene.forEachParticle((p) => out.push(p));
  return out;
}

/**
 * @param {Scene} scene
 * @param {number} seconds
 * @param {number} [dt]
 */
function run(scene, seconds, dt = 1 / 60) {
  for (let t = 0; t < seconds; t += dt) scene.step(dt);
}

describe('Scene construction', () => {
  it('starts with one ring in generative mode', () => {
    const scene = new Scene({ spawnMode: 'generative' });
    expect(scene.rings).toHaveLength(1);
    expect(scene.rings[0].radius).toBe(scene.config.initialRadius);
  });

  it('starts with exactly ringCount rings in static mode', () => {
    const scene = new Scene({ spawnMode: 'static', ringCount: 7 });
    expect(scene.rings).toHaveLength(7);
  });

  it('produces numPoints particles per ring', () => {
    const scene = new Scene({ spawnMode: 'static', ringCount: 3, numPoints: 8 });
    expect(positions(scene)).toHaveLength(24);
    expect(scene.particleCount).toBe(24);
  });

  it('rejects an unknown geometry or spawn mode at construction', () => {
    expect(() => new Scene({ geometry: 'nope' })).toThrow(/Unknown geometry/);
    expect(() => new Scene({ spawnMode: 'nope' })).toThrow(/Unknown spawn mode/);
  });
});

describe('Scene.step — phase-based time', () => {
  it('does not teleport particles when the speed changes mid-run', () => {
    // Regression guard for the central pre-refactor bug: position was derived from
    // `performance.now() * speed`, so changing the speed rescaled absolute time and
    // every particle jumped. Integrating a rate cannot do that.
    const scene = new Scene({ spawnMode: 'static', ringCount: 1, numPoints: 6, speed: 0.5 });
    run(scene, 30);

    const before = positions(scene);
    scene.set('speed', 3);
    scene.step(1 / 60);
    const after = positions(scene);

    for (let i = 0; i < before.length; i++) {
      // One frame at 3 rad/s on a 380-unit ring moves ~19 units. A rescale of 30 s of
      // absolute time would move the particle across the whole ring instead.
      expect(length(sub(after[i], before[i]))).toBeLessThan(25);
    }
  });

  it('moves particles proportionally to dt', () => {
    const slow = new Scene({ spawnMode: 'static', ringCount: 1, numPoints: 4, speed: 0.1 });
    const start = positions(slow)[0];
    slow.step(0.01);
    const small = length(sub(positions(slow)[0], start));

    const other = new Scene({ spawnMode: 'static', ringCount: 1, numPoints: 4, speed: 0.1 });
    other.step(0.02);
    const large = length(sub(positions(other)[0], start));

    expect(large).toBeGreaterThan(small);
    expect(large / small).toBeCloseTo(2, 1);
  });

  it('is deterministic: identical inputs give identical output', () => {
    const a = new Scene({ spawnMode: 'static', ringCount: 5, numPoints: 12 });
    const b = new Scene({ spawnMode: 'static', ringCount: 5, numPoints: 12 });
    run(a, 5);
    run(b, 5);
    expect(positions(a)).toEqual(positions(b));
  });

  it('clamps oversized frame deltas so a backgrounded tab does not jump', () => {
    const a = new Scene({ spawnMode: 'static', ringCount: 1, numPoints: 4 });
    const b = new Scene({ spawnMode: 'static', ringCount: 1, numPoints: 4 });
    a.step(0.1);
    b.step(30);
    expect(positions(b)).toEqual(positions(a));
  });

  it('ignores zero and negative deltas', () => {
    const scene = new Scene({ spawnMode: 'static', ringCount: 1, numPoints: 4 });
    const before = positions(scene);
    scene.step(0);
    scene.step(-5);
    expect(positions(scene)).toEqual(before);
    expect(scene.time).toBe(0);
  });

  it('alternates rotation direction between successive rings', () => {
    const scene = new Scene({ spawnMode: 'static', ringCount: 4, numPoints: 4 });
    scene.step(0.5);
    expect(scene.rings.map((r) => Math.sign(r.phase))).toEqual([1, -1, 1, -1]);
  });
});

describe('Scene.set', () => {
  it('rebuilds when a structural key changes', () => {
    const scene = new Scene({ spawnMode: 'static', ringCount: 3 });
    expect(scene.set('ringCount', 9)).toBe(true);
    expect(scene.rings).toHaveLength(9);
  });

  it('does not rebuild for cosmetic keys', () => {
    const scene = new Scene({ spawnMode: 'static', ringCount: 3 });
    run(scene, 2);
    const phases = scene.rings.map((r) => r.phase);
    expect(scene.set('color', '#00ff00')).toBe(false);
    expect(scene.set('lineWidth', 4)).toBe(false);
    expect(scene.rings.map((r) => r.phase)).toEqual(phases);
  });

  it('is a no-op when the value is unchanged', () => {
    const scene = new Scene({ spawnMode: 'static', ringCount: 3 });
    run(scene, 2);
    const time = scene.time;
    expect(scene.set('ringCount', 3)).toBe(false);
    expect(scene.time).toBe(time);
  });

  it('restarts from the current configuration without restoring defaults', () => {
    const scene = new Scene({
      spawnMode: 'static',
      ringCount: 4,
      numPoints: 8,
      speed: 1.25,
    });
    run(scene, 2);
    const config = { ...scene.config };

    scene.restart();

    expect(scene.config).toEqual(config);
    expect(scene.time).toBe(0);
    expect(scene.rings).toHaveLength(4);
    expect(scene.rings.every((ring) => ring.phase === 0 && ring.opacity === 1)).toBe(true);
  });

  it('switching spawn mode rebuilds the ring set', () => {
    const scene = new Scene({ spawnMode: 'generative' });
    expect(scene.set('spawnMode', 'static')).toBe(true);
    expect(scene.rings).toHaveLength(scene.config.ringCount);
  });

  it('batches structural changes into one rebuild', () => {
    const scene = new Scene({ spawnMode: 'static', ringCount: 3 });
    const rebuild = scene.rebuild.bind(scene);
    let rebuilds = 0;
    scene.rebuild = () => {
      rebuilds += 1;
      return rebuild();
    };

    expect(
      scene.setMany([
        ['ringCount', 9],
        ['numPoints', 32],
        ['lineWidth', 3],
      ])
    ).toBe(true);
    expect(rebuilds).toBe(1);
    expect(scene.rings).toHaveLength(9);
    expect(scene.config.numPoints).toBe(32);
    expect(scene.config.lineWidth).toBe(3);
  });
});

describe('particle budget', () => {
  it('keeps the Safe profile below the particle budget', () => {
    const points = rangeBounds(CONTROLS.find((control) => control.key === 'numPoints')).max;
    const rings = rangeBounds(CONTROLS.find((control) => control.key === 'ringCount')).max;
    const safe = new Scene({ spawnMode: 'static', ringCount: rings, numPoints: points });
    expect(safe.particleCount).toBeLessThanOrEqual(PARTICLE_BUDGET);
  });

  it('flags configurations that will not hold frame rate', () => {
    const ok = new Scene({ spawnMode: 'static', ringCount: 4, numPoints: 50 });
    expect(ok.isOverBudget()).toBe(false);

    const heavy = new Scene({ spawnMode: 'static', ringCount: 40, numPoints: 200 });
    expect(heavy.particleCount).toBeGreaterThan(PARTICLE_BUDGET);
    expect(heavy.isOverBudget()).toBe(true);
  });
});
