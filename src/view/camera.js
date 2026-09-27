const DEG = Math.PI / 180;

/** Pitch is clamped just short of the poles to avoid a degenerate view basis. */
const MAX_PITCH = 89 * DEG;

/**
 * Orbit camera for the 3D view.
 *
 * The camera looks at the origin from a yaw/pitch direction at an adjustable distance. Rather
 * than build a full view matrix, world points are brought into camera space by undoing the
 * camera's own rotation — for an orbit camera that is exactly `rotateZ(-yaw)` followed by
 * `rotateX(-pitch)`.
 *
 * The 2D view deliberately ignores this object entirely: a top-down orthographic
 * projection has no camera state to respect.
 */
export class Camera {
  /** Rotation terms for the yaw/pitch they were computed at; see `#rotation`. */
  #cache = { yaw: NaN, pitch: NaN, yawCos: 1, yawSin: 0, pitchCos: 1, pitchSin: 0 };

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
    /** Fixed focal length preserves initial framing while distance changes produce zoom. */
    this.focalLength = distance;
    /** Radians per second applied by `update` when auto-orbit is enabled. */
    this.orbitSpeed = 0.12;
  }

  /**
   * Trigonometry of the current orientation, recomputed only when yaw or pitch has changed
   * since the last call, i.e. at most once per frame rather than once per particle.
   */
  get #rotation() {
    const r = this.#cache;
    if (r.yaw !== this.yaw || r.pitch !== this.pitch) {
      r.yaw = this.yaw;
      r.pitch = this.pitch;
      r.yawCos = Math.cos(this.yaw);
      r.yawSin = Math.sin(this.yaw);
      r.pitchCos = Math.cos(this.pitch);
      r.pitchSin = Math.sin(this.pitch);
    }
    return r;
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
   * @param {import('../core/geometry/euclidean.js').Vec3} p
   * @param {import('../core/geometry/euclidean.js').Vec3} out Caller-owned output.
   * @returns {import('../core/geometry/euclidean.js').Vec3}
   */
  toCameraSpace(p, out) {
    const { yawCos, yawSin, pitchCos, pitchSin } = this.#rotation;

    // rotateZ(p, -yaw), then rotateX(result, -pitch), expanded without intermediates.
    const yawedX = p.x * yawCos + p.y * yawSin;
    const yawedY = -p.x * yawSin + p.y * yawCos;
    out.x = yawedX;
    out.y = yawedY * pitchCos + p.z * pitchSin;
    out.z = -yawedY * pitchSin + p.z * pitchCos;
    return out;
  }
}
