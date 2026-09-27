/**
 * Flat, zero-curvature geometry: a ring is a Euclidean circle in a plane of R³.
 *
 * A geometry decides *where a particle is in space*, given a ring and an index. It knows
 * nothing about cameras, canvases or projection — that is `view/projectors.js`.
 *
 * The plane starts as XY and is rotated by `ring.tilt` about X, then by `ring.yaw`
 * about Z. The yaw is applied *after* the tilt on purpose — applying it first would be a
 * no-op, since a circle centred on the origin is invariant under rotation about its own
 * axis. Together the two angles sweep the ring's normal over the sphere as `seq` grows.
 *
 * @typedef {{x: number, y: number, z: number}} Vec3
 */

/** Unit-circle table for the particle count currently in use. */
let tableCount = 0;
let tableCos = new Float64Array(0);
let tableSin = new Float64Array(0);

/** @param {number} count */
function unitCircle(count) {
  if (count === tableCount) return;
  tableCount = count;
  tableCos = new Float64Array(count);
  tableSin = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const angle = (2 * Math.PI * i) / count;
    tableCos[i] = Math.cos(angle);
    tableSin[i] = Math.sin(angle);
  }
}

export const euclidean = {
  id: 'euclidean',
  label: 'Euclidean',

  /**
   * Write a world-space particle position into a caller-owned object.
   *
   * No trigonometry per particle: the particle angle comes from a table, the ring phase is
   * added by angle addition, and the orientation terms are cached on the ring.
   *
   * @param {import('../ring.js').Ring} ring
   * @param {number} index
   * @param {number} count
   * @param {Vec3} out
   * @returns {Vec3}
   */
  orbitPoint(ring, index, count, out) {
    unitCircle(count);
    const c = tableCos[index];
    const s = tableSin[index];
    // cos/sin(2πi/count + phase)
    const cosTheta = c * ring.phaseCos - s * ring.phaseSin;
    const sinTheta = s * ring.phaseCos + c * ring.phaseSin;

    const localX = ring.radius * cosTheta;
    const localY = ring.radius * sinTheta;
    const tiltedY = localY * ring.tiltCos;

    out.x = localX * ring.yawCos - tiltedY * ring.yawSin;
    out.y = localX * ring.yawSin + tiltedY * ring.yawCos;
    out.z = localY * ring.tiltSin;
    return out;
  },
};
