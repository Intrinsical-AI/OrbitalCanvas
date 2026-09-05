const DEG = Math.PI / 180;

/** Pitch is clamped just short of the poles to avoid a degenerate view basis. */
const MAX_PITCH = 89 * DEG;

/**
 * Orbit camera for the 3D view.
 *
 * The camera looks at the origin from a yaw/pitch direction at a fixed distance. Rather
 * than build a full view matrix, world points are brought into camera space by undoing the
 * camera's own rotation — for an orbit camera that is exactly `rotateZ(-yaw)` followed by
 * `rotateX(-pitch)`.
 *
 * The 2D view deliberately ignores this object entirely: a top-down orthographic
 * projection has no camera state to respect.
 */
export class Camera {
  /**
   * @param {object} [options]
   * @param {number} [options.yaw] Radians.
   * @param {number} [options.pitch] Radians.
   * @param {number} [options.distance] World units from the origin.
   */
  constructor({ yaw = -30 * DEG, pitch = 25 * DEG, distance = 1400 } = {}) {
    this.yaw = yaw;
    this.pitch = pitch;
    this.distance = distance;
    /** Radians per second applied by `update` when auto-orbit is enabled. */
    this.orbitSpeed = 0.12;
  }

  /**
   * @param {number} dt Seconds.
   * @param {boolean} autoOrbit
   */
  update(dt, autoOrbit) {
    if (autoOrbit) this.yaw += dt * this.orbitSpeed;
  }

  /**
   * Apply a drag gesture, in CSS pixels.
   * @param {number} dx
   * @param {number} dy
   */
  orbitBy(dx, dy) {
    this.yaw += dx * 0.005;
    this.pitch = Math.min(MAX_PITCH, Math.max(-MAX_PITCH, this.pitch + dy * 0.005));
  }

  /**
   * @param {number} factor Multiplier; >1 moves the camera away.
   */
  zoomBy(factor) {
    this.distance = Math.min(6000, Math.max(300, this.distance * factor));
  }

  /**
   * Transform a world point into camera space, where +Z points towards the viewer.
   * @param {import('../core/vec3.js').Vec3} p
   * @returns {import('../core/vec3.js').Vec3}
   */
  toCameraSpace(p) {
    return this.toCameraSpaceInto(p, { x: 0, y: 0, z: 0 });
  }

  /**
   * Write camera-space coordinates into a caller-owned object. The public allocating method
   * above remains available for tests and general callers; the projector uses this form for
   * every particle in a frame.
   *
   * @param {import('../core/vec3.js').Vec3} p
   * @param {import('../core/vec3.js').Vec3} out
   * @returns {import('../core/vec3.js').Vec3}
   */
  toCameraSpaceInto(p, out) {
    const yawCos = Math.cos(this.yaw);
    const yawSin = Math.sin(this.yaw);
    const pitchCos = Math.cos(this.pitch);
    const pitchSin = Math.sin(this.pitch);

    // rotateZ(p, -yaw), then rotateX(result, -pitch), expanded without intermediates.
    const yawedX = p.x * yawCos + p.y * yawSin;
    const yawedY = -p.x * yawSin + p.y * yawCos;
    out.x = yawedX;
    out.y = yawedY * pitchCos + p.z * pitchSin;
    out.z = -yawedY * pitchSin + p.z * pitchCos;
    return out;
  }
}
