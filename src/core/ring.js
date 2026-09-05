/**
 * A ring is one orbital circle: a set of `numPoints` particles sharing a radius,
 * an orientation and a rotation phase.
 *
 * Orientation is stored as two angles rather than a matrix because that is all the
 * geometry needs, and it keeps rings cheap to create and trivial to assert on in tests.
 */

/**
 * @typedef {object} Ring
 * @property {number} seq Monotonic creation index. Drives tilt, yaw and direction, so a
 *   ring's orientation is a pure function of when it was created.
 * @property {number} radius World units.
 * @property {number} tilt Rotation about the X axis, radians.
 * @property {number} yaw Rotation about the Z axis applied after the tilt, radians.
 * @property {1|-1} direction Rotation sense; alternates between successive rings.
 * @property {number} phase Accumulated rotation, radians. Advanced by `dt * speed`, never
 *   derived from absolute time — this is what makes speed changes continuous.
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
  return {
    seq,
    radius,
    tilt: seq * planeAngle,
    yaw: seq * planeAngle,
    direction: seq % 2 === 0 ? 1 : -1,
    phase: 0,
    opacity: 1,
    fading: false,
    fadeElapsed: 0,
  };
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

  if (!ring.fading) return true;

  ring.fadeElapsed += dt;
  ring.opacity = fadeDuration > 0 ? Math.max(0, 1 - ring.fadeElapsed / fadeDuration) : 0;
  return ring.opacity > 0;
}
