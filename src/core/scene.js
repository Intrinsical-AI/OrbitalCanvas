import { DEFAULTS } from './config.js';
import { orbitPoint } from './geometry/euclidean.js';
import { evictOldest, getSpawner, layoutRing, radialLevels } from './spawner.js';
import { stepRing, syncRingTrig } from './ring.js';

/** Hard particle limit in Safe mode; rendering cost still depends on style and hardware. */
export const PARTICLE_BUDGET = 4000;

/**
 * The simulation. Pure: no DOM, no canvas, no `performance.now()`.
 *
 * The scene is always three-dimensional. The 3D and 2D views are two projections of this
 * single state (see `view/projectors.js`), which is why switching views cannot restart the
 * animation or let the two representations drift apart.
 *
 * Time enters only as `dt` through `step()`, and is integrated into each ring's `phase`.
 * Because speed scales a rate rather than absolute time, changing it never teleports a
 * particle.
 */
export class Scene {
  /**
   * @param {object} [overrides] Partial config, merged over `DEFAULTS`.
   */
  constructor(overrides = {}) {
    this.config = { ...DEFAULTS, ...overrides };
    this.restart();
  }

  /** @returns {import('./ring.js').Ring[]} */
  get rings() {
    return this.state.rings;
  }

  /** @returns {number} */
  get particleCount() {
    return this.state.rings.length * this.config.numPoints;
  }

  /**
   * Discard all rings and rebuild from the current config. Resets simulated time.
   */
  restart(population = 'full') {
    this.spawner = getSpawner(this.config.spawnMode);
    this.time = 0;

    const rings = this.spawner.initial(this.config, population);
    this.state = {
      rings,
      seq: rings.length ? rings[rings.length - 1].seq : 0,
      nextRadialSlot: rings.length % radialLevels(this.config),
      sinceSpawn: 0,
    };
  }

  /**
   * Update geometry in place. Only a spawn-mode or static ring-count change rebuilds rings.
   *
   * @param {ReadonlyArray<readonly [string, unknown]>} changes
   * @returns {boolean} True if a rebuild was performed.
   */
  setMany(changes) {
    const changed = new Set();
    for (const [key, value] of new Map(changes)) {
      if (this.config[key] === value) continue;
      this.config[key] = value;
      changed.add(key);
    }
    if (!changed.size) return false;

    const rebuild =
      changed.has('spawnMode') || (changed.has('ringCount') && this.config.spawnMode === 'static');

    if (rebuild) this.restart();
    else {
      const planesChanged = changed.has('planeAngle');
      const radiiChanged =
        changed.has('innerRatio') ||
        (changed.has('ringSpacing') && this.config.spawnMode === 'generative');
      if (planesChanged || radiiChanged) {
        this.rings.forEach((ring, index) => {
          if (planesChanged) {
            ring.tilt = ring.orientationSlot * this.config.planeAngle;
            ring.yaw = ring.tilt;
            syncRingTrig(ring);
          }
          if (radiiChanged) layoutRing(ring, this.config, index);
        });
      }
      if (this.config.spawnMode === 'generative') {
        if (radiiChanged) this.state.nextRadialSlot %= radialLevels(this.config);
        if (changed.has('maxRings')) evictOldest(this.rings, this.config.maxRings);
      }
    }
    return rebuild;
  }

  enforceBudget() {
    const capacity = Math.floor(PARTICLE_BUDGET / this.config.numPoints);
    if (this.rings.length > capacity) this.state.rings.splice(0, this.rings.length - capacity);
  }

  /**
   * Advance the simulation.
   *
   * @param {number} dt Seconds, normalized by the caller for all animated state.
   */
  step(dt) {
    if (!Number.isFinite(dt) || dt <= 0) return;
    this.time += dt;

    const { speed, fadeDuration } = this.config;
    const surviving = [];
    for (const ring of this.state.rings) {
      if (stepRing(ring, dt, speed, fadeDuration)) surviving.push(ring);
    }
    this.state.rings = surviving;

    this.spawner.update(this.state, dt, this.config);
  }

  /**
   * Visit every particle using one transient position. Copy it if retaining positions.
   *
   * Iteration order is ring creation order, which the renderer relies on for chord
   * indexing.
   *
   * @param {(position: import('./geometry/euclidean.js').Vec3, ring: import('./ring.js').Ring,
   *   index: number, count: number) => void} callback
   */
  forEachParticle(callback) {
    const count = this.config.numPoints;
    const position = { x: 0, y: 0, z: 0 };
    for (const ring of this.state.rings) {
      for (let i = 0; i < count; i++) {
        orbitPoint(ring, i, count, position);
        callback(position, ring, i, count);
      }
    }
  }
}

/** Advance the whole requested interval with bounded simulation steps and Safe limits. */
export function stepScene(scene, dt, rangeMode) {
  const elapsed = Number.isFinite(dt) && dt > 0 ? dt : 0;
  if (elapsed > 120) throw new RangeError('Simulation interval cannot exceed 120 seconds.');
  const count = Math.ceil(elapsed * 10);
  const step = count ? elapsed / count : 0;
  if (rangeMode === 'safe') scene.enforceBudget();
  for (let index = 0; index < count; index++) {
    scene.step(step);
    if (rangeMode === 'safe') scene.enforceBudget();
  }
}
