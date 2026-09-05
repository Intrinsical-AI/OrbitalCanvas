import { euclidean } from './euclidean.js';

/**
 * Geometry registry.
 *
 * A geometry decides *where a particle is in space*, given a ring and an index. It knows
 * nothing about cameras, canvases or projection — that is `view/projectors.js`. Keeping
 * the two apart is what lets the 3D and 2D views share one simulation.
 *
 * Adding a curved geometry means adding one module implementing the interface below and
 * one entry here; nothing else in the codebase changes.
 *
 * @typedef {object} Geometry
 * @property {string} id
 * @property {string} label
 * @property {number} curvature
 * @property {(r: number) => number} circumference
 * @property {(ring: import('../ring.js').Ring, index: number, count: number)
 *   => import('../vec3.js').Vec3} orbitPoint
 * @property {(ring: import('../ring.js').Ring, index: number, count: number,
 *   out: import('../vec3.js').Vec3) => import('../vec3.js').Vec3} [orbitPointInto]
 */

/** @type {Record<string, Geometry>} */
const REGISTRY = {
  [euclidean.id]: euclidean,
};

/**
 * @param {string} id
 * @returns {Geometry}
 * @throws {Error} If `id` is not registered.
 */
export function getGeometry(id) {
  const geometry = REGISTRY[id];
  if (!geometry) {
    throw new Error(
      `Unknown geometry "${id}". Available: ${Object.keys(REGISTRY).join(', ') || '(none)'}`
    );
  }
  return geometry;
}

/**
 * @returns {Array<{value: string, label: string}>} Registry contents, for UI population.
 */
export function listGeometries() {
  return Object.values(REGISTRY).map((g) => ({ value: g.id, label: g.label }));
}

export { euclidean };
