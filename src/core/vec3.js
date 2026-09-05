/**
 * Minimal 3D vector helpers.
 *
 * Vectors are plain `{ x, y, z }` objects. Every function is pure and allocating;
 * the scene creates at most `maxRings * numPoints` of them per frame, which is well
 * within budget for canvas2d and keeps the maths trivially testable.
 */

/**
 * @typedef {{ x: number, y: number, z: number }} Vec3
 */

/**
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @returns {Vec3}
 */
export function vec3(x = 0, y = 0, z = 0) {
  return { x, y, z };
}

/**
 * @param {Vec3} v
 * @returns {number} Euclidean norm.
 */
export function length(v) {
  return Math.hypot(v.x, v.y, v.z);
}

/**
 * @param {Vec3} v
 * @param {number} s
 * @returns {Vec3}
 */
export function scale(v, s) {
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}

/**
 * @param {Vec3} a
 * @param {Vec3} b
 * @returns {Vec3}
 */
export function add(a, b) {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

/**
 * @param {Vec3} a
 * @param {Vec3} b
 * @returns {Vec3}
 */
export function sub(a, b) {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

/**
 * @param {Vec3} a
 * @param {Vec3} b
 * @returns {number}
 */
export function dot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

/**
 * Right-handed rotation about the X axis.
 * @param {Vec3} v
 * @param {number} angle Radians.
 * @returns {Vec3}
 */
export function rotateX(v, angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { x: v.x, y: v.y * c - v.z * s, z: v.y * s + v.z * c };
}

/**
 * Right-handed rotation about the Y axis.
 * @param {Vec3} v
 * @param {number} angle Radians.
 * @returns {Vec3}
 */
export function rotateY(v, angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { x: v.x * c + v.z * s, y: v.y, z: -v.x * s + v.z * c };
}

/**
 * Right-handed rotation about the Z axis.
 * @param {Vec3} v
 * @param {number} angle Radians.
 * @returns {Vec3}
 */
export function rotateZ(v, angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c, z: v.z };
}
