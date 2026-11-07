/**
 * A ring is one orbital circle: a set of `numPoints` particles sharing a radius,
 * an orientation and a rotation phase.
 *
 * Orientation is stored as two angles rather than a matrix, together with their cosines and
 * sines: live geometry edits refresh the cache once per ring, so the geometry never needs
 * to evaluate trigonometry per particle.
 */

/**
 * @typedef {object} Ring
 * @property {number} seq Monotonic creation index. Drives tilt, yaw and direction, so a
 *   ring's orientation is a pure function of when it was created.
 * @property {number} orientationSlot Bounded seq % 48 slot, independent of radius.
 * @property {number} radialSlot Cyclic radial position, independent of orientation.
 * @property {number} radius World units.
 * @property {number} tilt Rotation about the X axis, radians.
 * @property {number} yaw Rotation about the Z axis applied after the tilt, radians.
 * @property {1|-1} direction Rotation sense; alternates between successive rings.
 * @property {number} phase Accumulated rotation, radians. Advanced by `dt * speed`, never
 *   derived from absolute time — this is what makes speed changes continuous.
 * @property {number} tiltCos
 * @property {number} tiltSin
 * @property {number} yawCos
 * @property {number} yawSin
 * @property {number} phaseCos
 * @property {number} phaseSin
 * @property {number} opacity 0..1.
 * @property {boolean} fading True once the ring has been evicted and is fading out.
 * @property {number} fadeElapsed Seconds spent fading.
 */

/**
 * @param {object} params
 * @param {number} params.seq
 * @param {number} params.radius
 * @param {number} params.planeAngle Tilt increment per ring, radians.
 * @returns {Ring}
 */
export function createRing({ seq, radius, planeAngle }) {
  return syncRingTrig({
    seq,
    radius,
    orientationSlot: seq % 48,
    radialSlot: 0,
    tilt: (seq % 48) * planeAngle,
    yaw: (seq % 48) * planeAngle,
    direction: seq % 2 === 0 ? 1 : -1,
    phase: 0,
    opacity: 1,
    fading: false,
    fadeElapsed: 0,
  });
}

/**
 * Recompute the cached cosines and sines from `tilt`, `yaw` and `phase`. Call after setting
 * any of those angles directly.
 *
 * @template {Omit<Ring, 'tiltCos'|'tiltSin'|'yawCos'|'yawSin'|'phaseCos'|'phaseSin'>} T
 * @param {T} ring
 * @returns {Ring}
 */
export function syncRingTrig(ring) {
  ring.tiltCos = Math.cos(ring.tilt);
  ring.tiltSin = Math.sin(ring.tilt);
  ring.yawCos = Math.cos(ring.yaw);
  ring.yawSin = Math.sin(ring.yaw);
  ring.phaseCos = Math.cos(ring.phase);
  ring.phaseSin = Math.sin(ring.phase);
  return /** @type {Ring} */ (ring);
}

/**
 * Advance a ring's rotation phase and fade state.
 *
 * @param {Ring} ring
 * @param {number} dt Seconds.
 * @param {number} speed Radians per second.
 * @param {number} fadeDuration Seconds.
 * @returns {boolean} False once the ring has fully faded and should be removed.
 */
export function stepRing(ring, dt, speed, fadeDuration) {
  ring.phase += dt * speed * ring.direction;
  ring.phaseCos = Math.cos(ring.phase);
  ring.phaseSin = Math.sin(ring.phase);

  if (!ring.fading) return true;

  ring.fadeElapsed += dt;
  ring.opacity = fadeDuration > 0 ? Math.max(0, 1 - ring.fadeElapsed / fadeDuration) : 0;
  return ring.opacity > 0;
}
