import { describe, expect, it } from 'vitest';
import { Scene } from '../src/core/scene.js';
import { Camera } from '../src/view/camera.js';
import { createProjector } from '../src/view/projectors.js';
import { ALPHA_LEVELS, Renderer } from '../src/view/renderer.js';
import { getShape, ICOSAHEDRON_VERTICES } from '../src/view/shapes.js';

const THEME = { background: '#000000', foreground: '#ffffff', trailAlpha: 0.1 };

/**
 * Minimal recording stand-in for `CanvasRenderingContext2D`.
 *
 * Only the operations the renderer actually performs are implemented; anything else being
 * called would throw, which is itself a useful assertion.
 */
function fakeContext() {
  const calls = {
    moveTo: [],
    lineTo: [],
    arc: [],
    fill: 0,
    stroke: 0,
    fillRect: 0,
    fillRectAlpha: [],
    fillRectComposite: [],
    fillRectArgs: [],
    clearRect: 0,
    fillStyle: [],
    strokeStyle: [],
  };
  const state = { globalAlpha: 1, lineWidth: 1, composite: 'source-over' };
  return {
    calls,
    canvas: { width: 800, height: 600 },
    save() {},
    restore() {},
    beginPath() {},
    setTransform() {},
    clearRect() {
      calls.clearRect += 1;
    },
    fillRect(...args) {
      calls.fillRect += 1;
      calls.fillRectAlpha.push(state.globalAlpha);
      calls.fillRectComposite.push(state.composite);
      calls.fillRectArgs.push(args);
    },
    moveTo(x, y) {
      calls.moveTo.push([x, y]);
    },
    lineTo(x, y) {
      calls.lineTo.push([x, y]);
    },
    arc(x, y, r) {
      calls.arc.push([x, y, r]);
    },
    fill() {
      calls.fill += 1;
    },
    stroke() {
      calls.stroke += 1;
    },
    set globalAlpha(v) {
      state.globalAlpha = v;
    },
    get globalAlpha() {
      return state.globalAlpha;
    },
    set fillStyle(v) {
      calls.fillStyle.push(v);
    },
    set strokeStyle(v) {
      calls.strokeStyle.push(v);
    },
    set shadowColor(_v) {},
    set shadowBlur(_v) {},
    set globalCompositeOperation(v) {
      state.composite = v;
    },
    set lineWidth(v) {
      state.lineWidth = v;
    },
    get lineWidth() {
      return state.lineWidth;
    },
  };
}

const viewport = { width: 800, height: 600 };

/** Chord segments are the last `lineTo.length` moveTo calls; particle traces come first. */
const chordStarts = (ctx) => ctx.calls.moveTo.slice(-ctx.calls.lineTo.length || Infinity);

/**
 * @param {object} sceneOptions
 * @param {'2d'|'3d'} view
 */
function renderOnce(sceneOptions, view = '3d') {
  const scene = new Scene({ spawnMode: 'static', ...sceneOptions });
  const ctx = fakeContext();
  const renderer = new Renderer(ctx, viewport);
  renderer.render(scene, createProjector(view, new Camera()), THEME);
  return { ctx, renderer, scene };
}

describe('Renderer', () => {
  it('draws the trail fill exactly once per frame', () => {
    const { ctx } = renderOnce({ ringCount: 2, numPoints: 8 });
    expect(ctx.calls.fillRect).toBe(1);
  });

  it('emits finite coordinates for every particle and chord', () => {
    for (const view of ['2d', '3d']) {
      const { ctx } = renderOnce({ ringCount: 4, numPoints: 16, planeAngle: 0.4 }, view);
      for (const [x, y, r] of ctx.calls.arc) {
        expect(Number.isFinite(x)).toBe(true);
        expect(Number.isFinite(y)).toBe(true);
        expect(Number.isFinite(r)).toBe(true);
        expect(r).toBeGreaterThan(0);
      }
      for (const [x, y] of [...ctx.calls.moveTo, ...ctx.calls.lineTo]) {
        expect(Number.isFinite(x)).toBe(true);
        expect(Number.isFinite(y)).toBe(true);
      }
    }
  });

  it('strokes all chords in a single path when no ring is fading', () => {
    const { ctx } = renderOnce({ ringCount: 3, numPoints: 24, shape: 'disc' });
    expect(ctx.calls.stroke).toBe(1);
    expect(ctx.calls.lineTo.length).toBeGreaterThan(50);
  });

  it('draws one chord per particle', () => {
    const { ctx } = renderOnce({ ringCount: 2, numPoints: 10, shape: 'disc' });
    expect(ctx.calls.lineTo).toHaveLength(20);
  });

  it('keeps chord endpoints in scene order across projections and camera movement', () => {
    const scene = new Scene({ spawnMode: 'static', ringCount: 3, numPoints: 8, shape: 'disc' });
    const camera = new Camera();
    const ctx = fakeContext();
    const renderer = new Renderer(ctx, viewport);
    for (const view of ['2d', '3d', '3d']) {
      if (view === '3d') camera.orbitBy(100, 50);
      const projector = createProjector(view, camera);
      projector.configure(viewport, scene.config.initialRadius);
      const expected = [];
      scene.forEachParticle((position) => {
        const { sx, sy } = projector.project(position, {});
        expected.push([sx, sy]);
      });
      ctx.calls.moveTo.length = 0;
      ctx.calls.lineTo.length = 0;
      renderer.render(scene, projector, THEME);
      // At t=0 the chord pattern links each particle to its successor.
      expect(chordStarts(ctx)).toEqual(expected);
      expect(ctx.calls.lineTo).toEqual([...expected.slice(1), expected[0]]);
    }
  });

  it('indexes chords safely for degenerate particle counts', () => {
    for (const [ringCount, numPoints] of [
      [1, 3],
      [1, 4],
      [2, 3],
      [8, 200],
    ]) {
      expect(() => renderOnce({ ringCount, numPoints, shape: 'disc' })).not.toThrow();
    }
  });

  it('draws nothing but the background when there is a single particle', () => {
    const scene = new Scene({ spawnMode: 'static', ringCount: 1, numPoints: 1, shape: 'disc' });
    const ctx = fakeContext();
    new Renderer(ctx, viewport).render(scene, createProjector('2d', new Camera()), THEME);
    expect(ctx.calls.stroke).toBe(0);
    expect(ctx.calls.fillRect).toBe(1);
  });

  it('reuses its slot pool across frames', () => {
    const scene = new Scene({ spawnMode: 'static', ringCount: 3, numPoints: 12 });
    const renderer = new Renderer(fakeContext(), viewport);
    const projector = createProjector('3d', new Camera());
    renderer.render(scene, projector, THEME);
    const pooled = renderer.pool;
    const first = renderer.pool[0];
    renderer.render(scene, projector, THEME);
    expect(renderer.pool).toBe(pooled);
    expect(renderer.pool[0]).toBe(first);
    expect(renderer.count).toBe(36);
  });

  it('fills particles in at most one call per opacity level', () => {
    const { ctx } = renderOnce({ ringCount: 12, numPoints: 72, planeAngle: 0.4 }, '3d');
    expect(ctx.calls.fill).toBeGreaterThan(1);
    expect(ctx.calls.fill).toBeLessThanOrEqual(ALPHA_LEVELS);
  });

  it('paints clear() opaquely in the given background, never with clearRect', () => {
    // On an `alpha: false` canvas clearRect yields opaque black, wrong for the light theme.
    const ctx = fakeContext();
    new Renderer(ctx, viewport).clear('#ffffff');
    expect(ctx.calls.clearRect).toBe(0);
    expect(ctx.calls.fillStyle).toEqual(['#ffffff']);
    expect(ctx.calls.fillRectAlpha).toEqual([1]);
    expect(ctx.calls.fillRectArgs).toEqual([[0, 0, 800, 600]]);
  });

  it('nudges stalled trail pixels with one additive background fill every 30 frames', () => {
    const scene = new Scene({ spawnMode: 'static', ringCount: 1, numPoints: 3 });
    const projector = createProjector('2d', new Camera());
    const ctx = fakeContext();
    const renderer = new Renderer(ctx, viewport);
    for (let frame = 0; frame < 60; frame++) {
      renderer.render(scene, projector, { ...THEME, trailAlpha: 0.02 });
    }
    const additive = ctx.calls.fillRectComposite
      .map((mode, k) => [mode, ctx.calls.fillRectAlpha[k]])
      .filter(([mode]) => mode === 'lighter');
    expect(additive).toEqual([
      ['lighter', 10 / 255],
      ['lighter', 10 / 255],
    ]);
    expect(ctx.calls.fillRectAlpha.filter((a) => a === 0.02)).toHaveLength(60);
  });

  it('keeps chord endpoints stable when a ring spawns within one change window', () => {
    const scene = new Scene({
      circleInterval: 0.5,
      fadeDuration: 0.625,
      maxRings: 4,
      numPoints: 6,
      shape: 'disc',
      edgeFrequency: 1000,
    });
    const projector = createProjector('2d', new Camera());
    const renderer = new Renderer(fakeContext(), viewport);
    const pairs = () => {
      const ctx = fakeContext();
      renderer.ctx = ctx;
      renderer.render(scene, projector, THEME);
      // Identify each endpoint by (ring seq, index) through its screen position.
      const ids = new Map();
      scene.forEachParticle((position, ring, index) => {
        const { sx, sy } = projector.project(position, {});
        ids.set(`${sx},${sy}`, `${ring.seq}:${index}`);
      });
      const starts = chordStarts(ctx);
      return new Set(
        starts.map((a, k) => `${ids.get(String(a))}>${ids.get(String(ctx.calls.lineTo[k]))}`)
      );
    };

    // Steps of 1/8 s are exact in binary, so t = 4 s lands exactly on a chord-frame edge.
    for (let i = 0; i < 32; i++) scene.step(0.125); // Fill the ring budget.
    scene.config.speed = 0; // Freeze positions so only topology can change.
    // Frame 4 for the rest of the test. Frame 0 would not do: sin(0) = 0 hides the stride,
    // so even a count-dependent pattern looks stable there.
    expect(Math.floor(scene.time)).toBe(4);

    // A spawn raises the live count before the faded ring is removed 0.625 s later; that
    // count change is what used to reshuffle every chord.
    let before = pairs();
    const count = scene.rings.length;
    while (scene.rings.length === count) {
      before = pairs();
      scene.step(0.125);
    }
    expect(Math.floor(scene.time)).toBe(4);
    const after = pairs();
    const shared = [...before].filter((pair) => after.has(pair));
    // Chords between rings present in both frames survive; nothing is reshuffled.
    expect(shared.length).toBeGreaterThan(before.size / 2);
  });

  it('fades the chords of a fading ring in a separate, dimmer stroke', () => {
    const scene = new Scene({ spawnMode: 'static', ringCount: 3, numPoints: 8, shape: 'disc' });
    scene.rings[0].fading = true;
    scene.rings[0].opacity = 0.3;
    const ctx = fakeContext();
    new Renderer(ctx, viewport).render(scene, createProjector('2d', new Camera()), THEME);
    expect(ctx.calls.stroke).toBe(2);
  });

  it('skips the chord layer entirely at zero opacity', () => {
    const { ctx } = renderOnce({ ringCount: 3, numPoints: 20, chordAlpha: 0 });
    expect(ctx.calls.stroke).toBe(0);
    expect(ctx.calls.lineTo).toHaveLength(0);
  });

  it('draws chords in the theme foreground when chromatic mode is off', () => {
    // Monochrome by default: the shell introduces no hue, and neither does the artwork
    // until the user asks for it.
    const { ctx } = renderOnce({ ringCount: 2, numPoints: 12, chromaticChords: false });
    expect(ctx.calls.strokeStyle).toContain('#ffffff');
    for (const style of ctx.calls.strokeStyle) expect(style).not.toMatch(/^hsl/);
  });

  it('restores the hue cycle when chromatic mode is on', () => {
    const { ctx } = renderOnce({ ringCount: 2, numPoints: 12, chromaticChords: true });
    expect(ctx.calls.strokeStyle.some((s) => /^hsl\(/.test(s))).toBe(true);
  });

  it('follows the theme foreground rather than hardcoding white', () => {
    const scene = new Scene({ spawnMode: 'static', ringCount: 2, numPoints: 12 });
    const ctx = fakeContext();
    new Renderer(ctx, viewport).render(scene, createProjector('2d', new Camera()), {
      background: '#ffffff',
      foreground: '#000000',
      trailAlpha: 0.1,
    });
    expect(ctx.calls.strokeStyle).toContain('#000000');
  });

  it.each([
    ['auto', '#123456', '#123456'],
    ['#fedcba', '#123456', '#fedcba'],
  ])('resolves particle colour %s without changing the scene', (color, foreground, expected) => {
    const scene = new Scene({ spawnMode: 'static', ringCount: 1, shape: 'disc', color });
    const ctx = fakeContext();
    new Renderer(ctx, viewport).render(scene, createProjector('2d', new Camera()), {
      ...THEME,
      foreground,
    });
    expect(ctx.calls.fillStyle.at(-1)).toBe(expected);
    expect(scene.config.color).toBe(color);
  });

  it('keeps every particle the same size in the 2D view', () => {
    // Strictly flat: no perspective foreshortening, whatever the ring tilt.
    const { ctx } = renderOnce(
      { ringCount: 4, numPoints: 12, planeAngle: 0.5, shape: 'disc' },
      '2d'
    );
    const radii = new Set(ctx.calls.arc.map(([, , r]) => r.toFixed(9)));
    expect(radii.size).toBe(1);
  });

  it('varies particle size with depth in the 3D view', () => {
    const { ctx } = renderOnce(
      { ringCount: 4, numPoints: 12, planeAngle: 0.5, shape: 'disc' },
      '3d'
    );
    const radii = ctx.calls.arc.map(([, , r]) => r);
    expect(Math.max(...radii)).toBeGreaterThan(Math.min(...radii));
  });
});

describe('shapes', () => {
  it('normalises the icosahedron vertices once, at module scope', () => {
    expect(ICOSAHEDRON_VERTICES).toHaveLength(12);
    for (const [x, y, z] of ICOSAHEDRON_VERTICES) {
      expect(Math.hypot(x, y, z)).toBeCloseTo(1, 12);
    }
    expect(Object.isFrozen(ICOSAHEDRON_VERTICES)).toBe(true);
  });

  it('resolves registered shapes and rejects unknown ones', () => {
    expect(getShape('disc').id).toBe('disc');
    expect(getShape('icosahedron').id).toBe('icosahedron');
    expect(() => getShape('cube')).toThrow(/Unknown particle shape "cube"/);
  });

  it('traces the icosahedron as twelve sub-discs without filling', () => {
    const ctx = fakeContext();
    getShape('icosahedron').trace(ctx, { sx: 100, sy: 100, radius: 4, time: 0 });
    expect(ctx.calls.arc).toHaveLength(12);
    expect(ctx.calls.fill).toBe(0);
  });

  it('collapses a sub-pixel icosahedron cluster into one disc', () => {
    const ctx = fakeContext();
    getShape('icosahedron').trace(ctx, { sx: 100, sy: 100, radius: 0.5, time: 0 });
    expect(ctx.calls.arc).toEqual([[100, 100, 0.9]]);
  });

  it('tumbles the icosahedron with time', () => {
    const at = (time) => {
      const ctx = fakeContext();
      getShape('icosahedron').trace(ctx, { sx: 0, sy: 0, radius: 4, time });
      return ctx.calls.arc;
    };
    expect(at(1)).not.toEqual(at(0));
    expect(at(0)).toEqual(at(0));
  });

  it('traces a disc as one arc without filling', () => {
    const ctx = fakeContext();
    getShape('disc').trace(ctx, { sx: 10, sy: 20, radius: 3, time: 0 });
    expect(ctx.calls.arc).toEqual([[10, 20, 3]]);
    expect(ctx.calls.fill).toBe(0);
  });
});
