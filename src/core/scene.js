import { createConfig, REBUILD_KEYS } from './config.js';
import { getGeometry } from './geometry/index.js';
import { getSpawner } from './spawner.js';
import { stepRing } from './ring.js';

/** Soft ceiling used to warn about configurations that will not hold 60 fps. */
export const PARTICLE_BUDGET = 4000;

/** Longest frame delta accepted, seconds. Guards against tab-backgrounding jumps. */
const MAX_DT = 0.1;

/**
 * The simulation. Pure: no DOM, no canvas, no `performance.now()`.
 *
 * The scene is always three-dimensional. The 3D and 2D views are two projections of this
 * single state (see `view/projectors.js`), which is why switching views cannot restart the
 * animation or let the two representations drift apart.
 *
 * Time enters only as `dt` through `step()`, and is integrated into each ring's `phase`.
 * The pre-refactor code derived position from `performance.now() * speed`, so changing the
 * speed rescaled *absolute* time and teleported every particle; integrating a rate cannot.
 */
export class Scene {
  /**
   * @param {object} [overrides] Partial config, merged over `DEFAULTS`.
   */
  constructor(overrides = {}) {
    this.config = createConfig(overrides);
    this.geometry = getGeometry(this.config.geometry);
    this.spawner = getSpawner(this.config.spawnMode);
    /** Total simulated time, seconds. Used for time-varying style, never for position. */
    this.time = 0;
    this.state = { rings: [], seq: 0, nextRadius: 0, sinceSpawn: 0 };
    this.rebuild();
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
  rebuild() {
    this.geometry = getGeometry(this.config.geometry);
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
   * Restart the simulation from its initial state while preserving the current config.
   * Kept separate from `rebuild()` so UI actions can express their intent explicitly.
   */
  restart() {
    this.rebuild();
  }

  /**
   * Apply a single config change, rebuilding only when the change invalidates the ring set.
   *
   * @param {string} key
   * @param {unknown} value
   * @returns {boolean} True if a rebuild was performed.
   */
  set(key, value) {
    return this.setMany([[key, value]]);
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

    if (rebuild) this.rebuild();
    return rebuild;
  }

  /**
   * Advance the simulation.
   *
   * @param {number} dt Seconds. Clamped to `MAX_DT`; negative values are ignored.
   */
  step(dt) {
    const delta = Math.min(Math.max(dt, 0), MAX_DT);
    if (delta === 0) return;

    this.time += delta;

    const { speed, fadeDuration } = this.config;
    const surviving = [];
    for (const ring of this.state.rings) {
      if (stepRing(ring, delta, speed, fadeDuration)) surviving.push(ring);
    }
    this.state.rings = surviving;

    this.spawner.update(this.state, delta, this.config);
  }

  /**
   * Visit every particle in the scene.
   *
   * Iteration order is ring creation order, which the renderer relies on for chord
   * indexing and for painter's-order fallback when depth sorting is disabled.
   *
   * @param {(position: import('./vec3.js').Vec3, ring: import('./ring.js').Ring,
   *   index: number, count: number) => void} callback
   */
  forEachParticle(callback) {
    const count = this.config.numPoints;
    for (const ring of this.state.rings) {
      for (let i = 0; i < count; i++) {
        callback(this.geometry.orbitPoint(ring, i, count), ring, i, count);
      }
    }
  }

  /**
   * Render-oriented particle iteration using one transient position object. The callback must
   * consume the position synchronously; callers that need to retain positions should use
   * `forEachParticle`, whose historical allocation semantics remain unchanged.
   *
   * @param {(position: import('./vec3.js').Vec3, ring: import('./ring.js').Ring,
   *   index: number, count: number) => void} callback
   */
  forEachParticleInto(callback) {
    if (typeof this.geometry.orbitPointInto !== 'function') {
      this.forEachParticle(callback);
      return;
    }

    const count = this.config.numPoints;
    const position = { x: 0, y: 0, z: 0 };
    for (const ring of this.state.rings) {
      for (let i = 0; i < count; i++) {
        this.geometry.orbitPointInto(ring, i, count, position);
        callback(position, ring, i, count);
      }
    }
  }

  /**
   * @returns {boolean} True when the current configuration exceeds the particle budget.
   */
  isOverBudget() {
    return this.particleCount > PARTICLE_BUDGET;
  }
}
