import { describe, expect, it } from 'vitest';
import { Camera } from '../src/view/camera.js';
import {
  createProjected,
  createProjector,
  PerspectiveProjector,
  TopOrthoProjector,
} from '../src/view/projectors.js';

const vec3 = (x, y, z) => ({ x: x / 400, y: y / 400, z: z / 400 });

const VIEWPORT = { width: 800, height: 600 };
const FIT_RADIUS = 1;

/**
 * @param {import('../src/view/projectors.js').Projector} projector
 * @param {import('../src/core/geometry/euclidean.js').Vec3} p
 */
function project(projector, p) {
  return projector.project(p, createProjected());
}

describe('createProjector', () => {
  it('returns the matching implementation', () => {
    expect(createProjector('2d', new Camera())).toBeInstanceOf(TopOrthoProjector);
    expect(createProjector('3d', new Camera())).toBeInstanceOf(PerspectiveProjector);
  });

  it('rejects unknown view ids', () => {
    expect(() => createProjector('isometric', new Camera())).toThrow(/Unknown view mode/);
  });
});

describe('TopOrthoProjector — the 2D view', () => {
  /** @returns {TopOrthoProjector} */
  const make = () => {
    const p = new TopOrthoProjector();
    p.configure(VIEWPORT, FIT_RADIUS);
    return p;
  };

  it('drops z entirely: points differing only in depth land on the same pixel', () => {
    // This is the defining property of "looking straight down the Z axis".
    const projector = make();
    const near = project(projector, vec3(120, -80, -350));
    const far = project(projector, vec3(120, -80, 900));
    expect(near.sx).toBe(far.sx);
    expect(near.sy).toBe(far.sy);
  });

  it('is strictly flat: uniform scale, zero depth, no sorting', () => {
    const projector = make();
    expect(projector.sortsByDepth).toBe(false);
    for (const z of [-500, 0, 500]) {
      const out = project(projector, vec3(50, 50, z));
      expect(out.scale).toBe(1);
      expect(out.depth).toBe(0);
      expect(out.visible).toBe(true);
    }
  });

  it('puts the origin at the centre of the viewport', () => {
    const out = project(make(), vec3(0, 0, 0));
    expect(out.sx).toBeCloseTo(400, 9);
    expect(out.sy).toBeCloseTo(300, 9);
  });

  it('flips Y, because world Y points up and canvas Y points down', () => {
    const projector = make();
    const up = project(projector, vec3(0, 100, 0));
    const down = project(projector, vec3(0, -100, 0));
    expect(up.sy).toBeLessThan(300);
    expect(down.sy).toBeGreaterThan(300);
  });

  it('fits the scene inside the shortest viewport axis', () => {
    const projector = make();
    const edge = project(projector, vec3(FIT_RADIUS, 0, 0));
    expect(edge.sx - 400).toBeLessThan(VIEWPORT.height / 2);
    expect(edge.sx).toBeGreaterThan(400);
  });

  it('is linear in x and y', () => {
    const projector = make();
    const one = project(projector, vec3(100, 0, 0));
    const two = project(projector, vec3(200, 0, 0));
    expect(two.sx - 400).toBeCloseTo(2 * (one.sx - 400), 9);
  });

  it('ignores camera state completely', () => {
    const camera = new Camera();
    const projector = createProjector('2d', camera);
    projector.configure(VIEWPORT, FIT_RADIUS);
    const before = project(projector, vec3(90, 40, 30));
    camera.orbitBy(400, 200);
    camera.zoomBy(2);
    const after = project(projector, vec3(90, 40, 30));
    expect(after.sx).toBe(before.sx);
    expect(after.sy).toBe(before.sy);
  });
});

describe('PerspectiveProjector — the 3D view', () => {
  /** @returns {PerspectiveProjector} */
  const make = (camera = new Camera({ yaw: 0, pitch: 0, zoom: 1 })) => {
    const p = new PerspectiveProjector(camera);
    p.configure(VIEWPORT, FIT_RADIUS);
    return p;
  };

  it('does not drop z: depth changes the projected position', () => {
    const projector = make();
    const near = project(projector, vec3(120, -80, 300));
    const far = project(projector, vec3(120, -80, -300));
    expect(near.sx).not.toBeCloseTo(far.sx, 3);
    expect(near.depth).not.toBe(far.depth);
  });

  it('sorts by depth and reports a perspective scale', () => {
    const projector = make();
    expect(projector.sortsByDepth).toBe(true);
    const near = project(projector, vec3(0, 100, 400));
    const far = project(projector, vec3(0, 100, -400));
    expect(near.scale).toBeGreaterThan(far.scale);
  });

  it('grows monotonically as a point approaches the eye', () => {
    const projector = make();
    let previous = 0;
    for (const z of [-600, -300, 0, 300, 600]) {
      const out = project(projector, vec3(0, 50, z));
      expect(out.scale).toBeGreaterThan(previous);
      previous = out.scale;
    }
  });

  it('zooms the entire focal plane in and out, including particle size', () => {
    const camera = new Camera({ yaw: 0, pitch: 0, zoom: 1 });
    const projector = make(camera);
    const point = vec3(200, 100, 0);
    const initial = project(projector, point);
    camera.zoomBy(2);
    const farther = project(projector, point);
    expect(farther.sx - 400).toBeCloseTo((initial.sx - 400) / 2, 10);
    expect(farther.sy - 300).toBeCloseTo((initial.sy - 300) / 2, 10);
    expect(farther.scale).toBeCloseTo(initial.scale / 2, 10);
    camera.zoomBy(0.25);
    const closer = project(projector, point);
    expect(closer.sx - 400).toBeCloseTo((initial.sx - 400) * 2, 10);
    expect(closer.scale).toBeCloseTo(initial.scale * 2, 10);
  });

  it('keeps the origin centred regardless of camera orientation', () => {
    for (const camera of [
      new Camera({ yaw: 0, pitch: 0 }),
      new Camera({ yaw: 1.2, pitch: -0.4 }),
    ]) {
      const out = project(make(camera), vec3(0, 0, 0));
      expect(out.sx).toBeCloseTo(400, 9);
      expect(out.sy).toBeCloseTo(300, 9);
    }
  });

  it('clips points behind the near plane instead of projecting them', () => {
    const projector = make(new Camera({ yaw: 0, pitch: 0, zoom: 3 }));
    const behind = project(projector, vec3(0, 0, 500));
    expect(behind.visible).toBe(false);
    expect(behind.scale).toBe(0);
  });

  it('agrees with the 2D view when the camera looks straight down the Z axis', () => {
    // pitch = 0 means the camera sits on +Z looking at the origin, so a point on the
    // XY plane must project to the same place both ways up to the perspective scale.
    const camera = new Camera({ yaw: 0, pitch: 0, zoom: 1 });
    const perspective = make(camera);
    const ortho = new TopOrthoProjector();
    ortho.configure(VIEWPORT, FIT_RADIUS);

    const p = vec3(150, -90, 0);
    const a = project(perspective, p);
    const b = project(ortho, p);
    expect(Math.sign(a.sx - 400)).toBe(Math.sign(b.sx - 400));
    expect(Math.sign(a.sy - 300)).toBe(Math.sign(b.sy - 300));
    expect(a.scale).toBeCloseTo(1, 9);
  });
});

describe('Camera', () => {
  it('clamps pitch short of the poles', () => {
    const camera = new Camera({ pitch: 0 });
    camera.orbitBy(0, 100000);
    expect(camera.pitch).toBeLessThan(Math.PI / 2);
    camera.orbitBy(0, -1000000);
    expect(camera.pitch).toBeGreaterThan(-Math.PI / 2);
  });

  it('clamps zoom to a sane range', () => {
    const camera = new Camera();
    for (let i = 0; i < 200; i++) camera.zoomBy(0.5);
    expect(camera.distance).toBeGreaterThanOrEqual(1400 / 380 / 3);
    for (let i = 0; i < 200; i++) camera.zoomBy(2);
    expect(camera.distance).toBeLessThanOrEqual(1400 / 380 / 0.25);
  });

  it('only auto-orbits when asked', () => {
    const camera = new Camera({ yaw: 0 });
    camera.update(1, false);
    expect(camera.yaw).toBe(0);
    camera.update(1, true);
    expect(camera.yaw).toBeCloseTo(0.12, 12);
  });

  it('writes camera-space coordinates into a reusable output object', () => {
    const camera = new Camera({ yaw: Math.PI / 2, pitch: Math.PI / 2 });
    const out = { x: 0, y: 0, z: 0 };
    const point = vec3(40, -20, 90);
    expect(camera.toCameraSpace(point, out)).toBe(out);
    expect(out.x).toBeCloseTo(-20 / 400, 10);
    expect(out.y).toBeCloseTo(90 / 400, 10);
    expect(out.z).toBeCloseTo(40 / 400, 10);
  });
});
