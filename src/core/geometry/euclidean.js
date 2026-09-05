/**
 * Flat, zero-curvature geometry: a ring is a Euclidean circle in a plane of R³.
 *
 * The plane starts as XY and is rotated by `ring.tilt` about X, then by `ring.yaw`
 * about Z. The yaw is applied *after* the tilt on purpose — applying it first would be a
 * no-op, since a circle centred on the origin is invariant under rotation about its own
 * axis. Together the two angles sweep the ring's normal over the sphere as `seq` grows.
 *
 * This replaces the pre-refactor "3D" effect, which added two independent radian offsets
 * to `x` and `y` — a Lissajous distortion with no `z` component and no plane to speak of.
 */
export const euclidean = {
  id: 'euclidean',
  label: 'Euclidean',

  /** Gaussian curvature. Zero here; the seam exists for spherical (>0) and hyperbolic (<0). */
  curvature: 0,

  /**
   * Circumference of a geodesic circle of radius `r`.
   *
   * The general constant-curvature law is `2π · s_κ(r)` with
   * `s_κ(r) = sin(√κ·r)/√κ` for κ>0, `r` for κ=0, `sinh(√−κ·r)/√−κ` for κ<0.
   * Only the κ=0 branch is implemented; the signature is what curved geometries will share.
   *
   * @param {number} r
   * @returns {number}
   */
  circumference(r) {
    return 2 * Math.PI * r;
  },

  /**
   * World-space position of particle `index` of `count` on `ring`.
   *
   * @param {import('../ring.js').Ring} ring
   * @param {number} index
   * @param {number} count
   * @returns {import('../vec3.js').Vec3}
   */
  orbitPoint(ring, index, count) {
    return this.orbitPointInto(ring, index, count, { x: 0, y: 0, z: 0 });
  },

  /**
   * Write a world-space particle position into a caller-owned object. The scalar form keeps
   * the exact rotate-X-then-rotate-Z order of `orbitPoint` without creating intermediate
   * vectors in the render loop.
   *
   * @param {import('../ring.js').Ring} ring
   * @param {number} index
   * @param {number} count
   * @param {import('../vec3.js').Vec3} out
   * @returns {import('../vec3.js').Vec3}
   */
  orbitPointInto(ring, index, count, out) {
    const theta = (2 * Math.PI * index) / count + ring.phase;
    const localX = ring.radius * Math.cos(theta);
    const localY = ring.radius * Math.sin(theta);
    const tiltCos = Math.cos(ring.tilt);
    const tiltSin = Math.sin(ring.tilt);
    const tiltedY = localY * tiltCos;
    const tiltedZ = localY * tiltSin;
    const yawCos = Math.cos(ring.yaw);
    const yawSin = Math.sin(ring.yaw);

    out.x = localX * yawCos - tiltedY * yawSin;
    out.y = localX * yawSin + tiltedY * yawCos;
    out.z = tiltedZ;
    return out;
  },
};
