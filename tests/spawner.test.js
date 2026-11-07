import { describe, expect, it } from 'vitest';
import { DEFAULTS } from '../src/core/config.js';
import { Scene } from '../src/core/scene.js';
import { generativeSpawner, getSpawner, staticSpawner } from '../src/core/spawner.js';

/**
 * @param {Scene} scene
 * @param {number} seconds
 */
function run(scene, seconds) {
  const dt = 1 / 60;
  for (let t = 0; t < seconds; t += dt) scene.step(dt);
}

describe('spawner registry', () => {
  it('resolves both policies', () => {
    expect(getSpawner('generative')).toBe(generativeSpawner);
    expect(getSpawner('static')).toBe(staticSpawner);
  });

  it('throws on an unknown mode', () => {
    expect(() => getSpawner('spiral')).toThrow(/Unknown spawn mode "spiral"/);
  });
});

describe('static spawner', () => {
  it('builds exactly ringCount rings and never changes them', () => {
    const scene = new Scene({ spawnMode: 'static', ringCount: 6 });
    expect(scene.rings).toHaveLength(6);
    run(scene, 120);
    expect(scene.rings).toHaveLength(6);
  });

  it('spreads radii evenly across the full range', () => {
    const config = { ...DEFAULTS, ringCount: 5, innerRatio: 0.1 };
    const radii = staticSpawner.initial(config).map((r) => r.radius);
    expect(radii[0]).toBeCloseTo(1, 9);
    expect(radii.at(-1)).toBeCloseTo(0.1, 9);
    const gaps = radii.slice(1).map((r, i) => radii[i] - r);
    for (const gap of gaps) expect(gap).toBeCloseTo(gaps[0], 9);
  });

  it('handles a single ring without dividing by zero', () => {
    const config = { ...DEFAULTS, ringCount: 1, innerRatio: 0.1 };
    const rings = staticSpawner.initial(config);
    expect(rings).toHaveLength(1);
    expect(rings[0].radius).toBe(1);
  });

  it('is fully deterministic', () => {
    const config = { ...DEFAULTS, ringCount: 8 };
    expect(staticSpawner.initial(config)).toEqual(staticSpawner.initial(config));
  });

  it('accumulates tilt across the set', () => {
    const config = { ...DEFAULTS, ringCount: 4, planeAngle: 0.2 };
    const tilts = staticSpawner.initial(config).map((r) => r.tilt);
    expect(tilts).toEqual([0, 0.2, 0.4, 0.6000000000000001]);
  });
});

describe('generative spawner', () => {
  it('spawns a ring on every interval', () => {
    const scene = new Scene({
      spawnMode: 'generative',
      circleInterval: 1,
      maxRings: 40,
      fadeDuration: 0.5,
    });
    scene.restart('intro');
    expect(scene.rings).toHaveLength(1);
    run(scene, 3.1);
    expect(scene.rings.length).toBeGreaterThanOrEqual(4);
  });

  it('never exceeds the ring budget over a long run', () => {
    const scene = new Scene({
      spawnMode: 'generative',
      circleInterval: 0.25,
      maxRings: 5,
      fadeDuration: 0.2,
    });

    let peakLive = 0;
    for (let t = 0; t < 200; t += 1 / 60) {
      scene.step(1 / 60);
      const live = scene.rings.filter((r) => !r.fading).length;
      peakLive = Math.max(peakLive, live);
    }
    expect(peakLive).toBeLessThanOrEqual(5);
  });

  it('evicts the oldest ring first', () => {
    const scene = new Scene({
      spawnMode: 'generative',
      circleInterval: 0.1,
      maxRings: 3,
      fadeDuration: 5,
    });
    run(scene, 1);

    const fading = scene.rings.filter((r) => r.fading).map((r) => r.seq);
    const live = scene.rings.filter((r) => !r.fading).map((r) => r.seq);
    expect(fading.length).toBeGreaterThan(0);
    expect(Math.max(...fading)).toBeLessThan(Math.min(...live));
  });

  it('removes rings once they have fully faded', () => {
    const scene = new Scene({
      spawnMode: 'generative',
      circleInterval: 0.2,
      maxRings: 2,
      fadeDuration: 0.3,
    });
    run(scene, 20);
    expect(scene.rings.length).toBeLessThanOrEqual(2 + 2);
    for (const ring of scene.rings) expect(ring.opacity).toBeGreaterThan(0);
  });

  it('wraps the radius back to the outside instead of stalling', () => {
    // The original stopped spawning once the radius ran out; the endless inward spiral
    // is preserved by restarting from initialRadius.
    const scene = new Scene({
      spawnMode: 'generative',
      circleInterval: 0.05,
      ringSpacing: 0.25,
      innerRatio: 0.1,
      maxRings: 30,
      fadeDuration: 0.1,
    });
    run(scene, 10);
    const radii = scene.rings.map((r) => r.radius);
    expect(Math.max(...radii)).toBeGreaterThan(0.5);
    expect(scene.rings.length).toBeGreaterThan(1);
  });

  it('does not accumulate unbounded spawn debt after a long frame', () => {
    const scene = new Scene({
      spawnMode: 'generative',
      circleInterval: 0.05,
      maxRings: 4,
      fadeDuration: 0.1,
    });
    // Even when a caller supplies a huge delta, the spawn policy drops excess debt.
    scene.step(600);
    expect(scene.rings.filter((r) => !r.fading).length).toBeLessThanOrEqual(4);
  });

  it('alternates ring direction as the sequence grows', () => {
    const scene = new Scene({
      spawnMode: 'generative',
      circleInterval: 0.1,
      maxRings: 20,
      fadeDuration: 0.1,
    });
    run(scene, 1);
    for (const ring of scene.rings) {
      expect(ring.direction).toBe(ring.seq % 2 === 0 ? 1 : -1);
    }
  });
});
