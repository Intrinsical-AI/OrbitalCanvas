import { DEFAULTS, REBUILD_KEYS } from './config.js';
import { euclidean } from './geometry/euclidean.js';
import { getSpawner } from './spawner.js';
import { stepRing } from './ring.js';

/** Heuristic warning threshold; actual rendering cost depends on style and hardware. */
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
    this.geometry = euclidean;
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
  restart() {
    this.spawner = getSpawner(this.config.spawnMode);
    this.time = 0;

    const rings = this.spawner.initial(this.config);
    this.state = {
      rings,
      seq: rings.length ? rings[rings.length - 1].seq : 0,
      nextRadius: this.config.initialRadius - this.config.radiusStep,
      sinceSpawn: 0,
    };
  }

  /**
   * Apply several config changes and rebuild at most once. This is used by reset, randomise,
   * and range-profile clamping so a single user action cannot restart the scene repeatedly.
   *
   * @param {ReadonlyArray<readonly [string, unknown]>} changes
   * @returns {boolean} True if a rebuild was performed.
   */
  setMany(changes) {
    let rebuild = false;

    for (const [key, value] of changes) {
      if (this.config[key] === value) continue;
      this.config[key] = value;
      rebuild ||= REBUILD_KEYS.includes(key);
    }

    if (rebuild) this.restart();
    return rebuild;
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
   * indexing and for painter's-order fallback when depth sorting is disabled.
   *
   * @param {(position: import('./geometry/euclidean.js').Vec3, ring: import('./ring.js').Ring,
   *   index: number, count: number) => void} callback
   */
  forEachParticle(callback) {
    const count = this.config.numPoints;
    const position = { x: 0, y: 0, z: 0 };
    for (const ring of this.state.rings) {
      for (let i = 0; i < count; i++) {
        this.geometry.orbitPoint(ring, i, count, position);
        callback(position, ring, i, count);
      }
    }
  }
}
