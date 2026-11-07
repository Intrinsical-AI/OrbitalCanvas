/**
 * Projection strategies: world space (3D) -> screen space (2D).
 *
 * This module is the entire difference between the two view modes. Both projectors
 * consume the same `Scene` and emit the same record shape, so `renderer.js` never branches
 * on the view mode and the two views can never disagree about where a particle is.
 *
 * @typedef {object} Projected
 * @property {number} sx Screen x, CSS pixels.
 * @property {number} sy Screen y, CSS pixels.
 * @property {number} scale Size multiplier. Always 1 in the 2D view.
 * @property {number} depth Camera-space z, for sorting. Always 0 in the 2D view.
 * @property {boolean} visible False when the point is behind the near plane.
 *
 * @typedef {object} Projector
 * @property {string} id
 * @property {boolean} sortsByDepth
 * @property {(viewport: {width: number, height: number}, fitRadius: number) => void} configure
 * @property {(p: import('../core/geometry/euclidean.js').Vec3, out: Projected) => Projected} project
 */

/** Fraction of the viewport left as breathing room around the outermost ring. */
const FIT_MARGIN = 1.12;

/**
 * Centre the origin in the viewport and set the uniform world-to-screen scale that fits a
 * sphere of `fitRadius` into it.
 *
 * @param {{scale: number, cx: number, cy: number}} projector
 * @param {{width: number, height: number}} viewport CSS pixels.
 * @param {number} fitRadius World units.
 */
function fitToViewport(projector, viewport, fitRadius) {
  const shortest = Math.min(viewport.width, viewport.height);
  projector.scale = shortest / (2 * Math.max(fitRadius, 1) * FIT_MARGIN);
  projector.cx = viewport.width / 2;
  projector.cy = viewport.height / 2;
}

/**
 * @returns {Projected} A reusable record, so the render loop allocates nothing per particle.
 */
export function createProjected() {
  return { sx: 0, sy: 0, scale: 1, depth: 0, visible: true };
}

/**
 * Top-down orthographic projection: the view looking straight down the Z axis at the XY
 * plane.
 *
 * `z` is dropped outright — no perspective divide, no depth-dependent size, no sorting.
 * Two points differing only in `z` land on exactly the same pixel, which is the defining
 * property of this mode and what the unit tests assert. Tilted rings therefore appear as
 * clean ellipses, the orthographic shadow of the 3D scene.
 *
 * @implements {Projector}
 */
export class TopOrthoProjector {
  constructor() {
    this.id = '2d';
    this.sortsByDepth = false;
    this.scale = 1;
    this.cx = 0;
    this.cy = 0;
  }

  configure(viewport, fitRadius) {
    fitToViewport(this, viewport, fitRadius);
  }

  project(p, out) {
    out.sx = this.cx + p.x * this.scale;
    // Negated: world Y points up, canvas Y points down.
    out.sy = this.cy - p.y * this.scale;
    out.scale = 1;
    out.depth = 0;
    out.visible = true;
    return out;
  }
}

/**
 * Perspective projection through an orbit camera — the default 3D view.
 *
 * @implements {Projector}
 */
export class PerspectiveProjector {
  /**
   * @param {import('./camera.js').Camera} camera
   */
  constructor(camera) {
    this.id = '3d';
    this.sortsByDepth = true;
    this.camera = camera;
    this.scale = 1;
    this.cx = 0;
    this.cy = 0;
    /** Points closer to the eye than this are clipped. */
    this.near = 1 / 380;
    /** Reused camera-space point; project() consumes it synchronously. */
    this.cameraPoint = { x: 0, y: 0, z: 0 };
  }

  configure(viewport, fitRadius) {
    fitToViewport(this, viewport, fitRadius);
  }

  project(p, out) {
    const c = this.camera.toCameraSpace(p, this.cameraPoint);
    const eyeDistance = this.camera.distance - c.z;

    if (eyeDistance <= this.near) {
      out.visible = false;
      out.sx = 0;
      out.sy = 0;
      out.scale = 0;
      out.depth = c.z;
      return out;
    }

    const w = this.camera.focalLength / eyeDistance;
    out.sx = this.cx + c.x * w * this.scale;
    out.sy = this.cy - c.y * w * this.scale;
    out.scale = w;
    out.depth = c.z;
    out.visible = true;
    return out;
  }
}

/**
 * @param {'2d'|'3d'} view
 * @param {import('./camera.js').Camera} camera
 * @returns {Projector}
 * @throws {Error} On an unknown view id.
 */
export function createProjector(view, camera) {
  if (view === '2d') return new TopOrthoProjector();
  if (view === '3d') return new PerspectiveProjector(camera);
  throw new Error(`Unknown view mode "${view}". Expected "2d" or "3d".`);
}
