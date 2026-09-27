/**
 * Particle shapes.
 *
 * A shape traces one particle at an already-projected screen position and radius. The
 * renderer applies perspective scaling in 3D; the 2D view keeps every radius uniform.
 */

const PHI = (1 + Math.sqrt(5)) / 2;

/**
 * The twelve vertices of a regular icosahedron, normalised to the unit sphere.
 *
 * @type {ReadonlyArray<readonly [number, number, number]>}
 */
export const ICOSAHEDRON_VERTICES = Object.freeze(
  [
    [-1, PHI, 0],
    [1, PHI, 0],
    [-1, -PHI, 0],
    [1, -PHI, 0],
    [0, -1, PHI],
    [0, 1, PHI],
    [0, -1, -PHI],
    [0, 1, -PHI],
    [PHI, 0, -1],
    [PHI, 0, 1],
    [-PHI, 0, -1],
    [-PHI, 0, 1],
  ].map(([x, y, z]) => {
    const len = Math.hypot(x, y, z);
    return Object.freeze([x / len, y / len, z / len]);
  })
);

/**
 * @typedef {object} ShapeContext
 * @property {number} sx Screen x.
 * @property {number} sy Screen y.
 * @property {number} radius Particle radius in screen pixels, perspective already applied.
 * @property {number} time Simulated seconds, for shapes that animate.
 *
 * @typedef {object} Shape
 * @property {string} id
 * @property {string} label
 * @property {(ctx: CanvasRenderingContext2D, s: ShapeContext) => void} trace Append the
 *   particle's subpaths to the current path. The renderer owns `beginPath` and `fill`, so
 *   particles sharing an opacity are filled in one call.
 */

/** Below this cluster radius (CSS pixels) the twelve sub-discs are indistinguishable. */
const CLUSTER_LOD_RADIUS = 1.5;

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x
 * @param {number} y
 * @param {number} radius
 */
function traceDisc(ctx, x, y, radius) {
  ctx.moveTo(x + radius, y);
  ctx.arc(x, y, radius, 0, Math.PI * 2);
}

/** @type {Shape} */
export const disc = {
  id: 'disc',
  label: 'Disc',
  trace(ctx, { sx, sy, radius }) {
    traceDisc(ctx, sx, sy, radius);
  },
};

/**
 * Tumbled vertices `[x, y, z]` × 12. The tumble depends only on time, so every particle in
 * a frame shares it and it is computed once per frame rather than once per particle.
 */
const tumbled = new Float64Array(ICOSAHEDRON_VERTICES.length * 3);
let tumbledAt = NaN;

/** @param {number} time */
function tumble(time) {
  if (time === tumbledAt) return;
  tumbledAt = time;
  const cosA = Math.cos(time * 0.8);
  const sinA = Math.sin(time * 0.8);
  const cosB = Math.cos(time * 0.6);
  const sinB = Math.sin(time * 0.6);
  let k = 0;
  for (const [vx, vy, vz] of ICOSAHEDRON_VERTICES) {
    // Tumble about Y, then about X.
    const zy = -vx * sinA + vz * cosA;
    tumbled[k++] = vx * cosA + vz * sinA;
    tumbled[k++] = vy * cosB - zy * sinB;
    tumbled[k++] = vy * sinB + zy * cosB;
  }
}

/**
 * Each particle is a cluster of twelve small discs at the vertices of a slowly tumbling
 * icosahedron, with sub-disc size modulated by the vertex's own depth.
 *
 * @type {Shape}
 */
export const icosahedron = {
  id: 'icosahedron',
  label: 'Icosahedron',
  trace(ctx, { sx, sy, radius, time }) {
    const clusterRadius = radius * 1.8;
    if (clusterRadius < CLUSTER_LOD_RADIUS) {
      traceDisc(ctx, sx, sy, clusterRadius);
      return;
    }

    tumble(time);
    for (let k = 0; k < tumbled.length; k += 3) {
      // 0.7 + 0.28 * z stays within [0.42, 0.98] on the unit sphere.
      traceDisc(
        ctx,
        sx + tumbled[k] * clusterRadius,
        sy + tumbled[k + 1] * clusterRadius,
        radius * (0.7 + 0.28 * tumbled[k + 2])
      );
    }
  },
};
/** @type {Record<string, Shape>} */
const REGISTRY = {
  [disc.id]: disc,
  [icosahedron.id]: icosahedron,
};

/**
 * @param {string} id
 * @returns {Shape}
 * @throws {Error} If `id` is not registered.
 */
export function getShape(id) {
  const shape = REGISTRY[id];
  if (!shape) {
    throw new Error(
      `Unknown particle shape "${id}". Available: ${Object.keys(REGISTRY).join(', ')}`
    );
  }
  return shape;
}
