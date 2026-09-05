/**
 * Particle shapes.
 *
 * A shape draws one particle at an already-projected screen position. It receives the
 * projected `scale` so it can honour perspective foreshortening in the 3D view; in the 2D
 * view `scale` is always 1, which is what keeps that mode strictly flat.
 */

const PHI = (1 + Math.sqrt(5)) / 2;

/**
 * The twelve vertices of a regular icosahedron, normalised to the unit sphere.
 *
 * Hoisted to module scope and computed once. The pre-refactor renderer rebuilt and
 * re-normalised this table inside `draw`, i.e. once per particle per frame.
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
 * @property {(ctx: CanvasRenderingContext2D, s: ShapeContext) => void} draw
 */

/** @type {Shape} */
export const disc = {
  id: 'disc',
  label: 'Disc',
  draw(ctx, { sx, sy, radius }) {
    ctx.beginPath();
    ctx.arc(sx, sy, radius, 0, Math.PI * 2);
    ctx.fill();
  },
};

/**
 * The signature look of the original project: each particle is a cluster of twelve small
 * discs at the vertices of a slowly tumbling icosahedron, with sub-disc size modulated by
 * the vertex's own depth.
 *
 * @type {Shape}
 */
export const icosahedron = {
  id: 'icosahedron',
  label: 'Icosahedron',
  draw(ctx, { sx, sy, radius, time }) {
    const clusterRadius = radius * 1.8;
    const a = time * 0.8;
    const b = time * 0.6;
    const cosA = Math.cos(a);
    const sinA = Math.sin(a);
    const cosB = Math.cos(b);
    const sinB = Math.sin(b);

    ctx.beginPath();
    for (const [vx, vy, vz] of ICOSAHEDRON_VERTICES) {
      // Tumble about Y, then about X.
      const xr = vx * cosA + vz * sinA;
      const zy = -vx * sinA + vz * cosA;
      const yr = vy * cosB - zy * sinB;
      const zr = vy * sinB + zy * cosB;

      const subRadius = radius * (0.7 + 0.28 * zr);
      if (subRadius <= 0) continue;

      const px = sx + xr * clusterRadius;
      const py = sy + yr * clusterRadius;
      ctx.moveTo(px + subRadius, py);
      ctx.arc(px, py, subRadius, 0, Math.PI * 2);
    }
    ctx.fill();
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
