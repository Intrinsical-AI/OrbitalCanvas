import { describe, expect, it } from 'vitest';
import { Scene } from '../src/core/scene.js';
import { Camera } from '../src/view/camera.js';
import { createProjector } from '../src/view/projectors.js';
import { Renderer } from '../src/view/renderer.js';
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
    fillStyle: [],
    strokeStyle: [],
  };
  const state = { globalAlpha: 1, lineWidth: 1 };
  return {
    calls,
    canvas: { width: 800, height: 600 },
    save() {},
    restore() {},
    beginPath() {},
    setTransform() {},
    clearRect() {},
    fillRect() {
      calls.fillRect += 1;
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
    set globalCompositeOperation(_v) {},
    set lineWidth(v) {
      state.lineWidth = v;
    },
    get lineWidth() {
      return state.lineWidth;
    },
  };
}

const viewport = { width: 800, height: 600 };

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

  it('strokes all chords in a single path', () => {
    // The original issued one beginPath/stroke pair per chord.
    const { ctx } = renderOnce({ ringCount: 3, numPoints: 24, shape: 'disc' });
    expect(ctx.calls.stroke).toBe(1);
    expect(ctx.calls.lineTo.length).toBeGreaterThan(50);
  });

  it('draws one chord per particle', () => {
    const { ctx } = renderOnce({ ringCount: 2, numPoints: 10, shape: 'disc' });
    expect(ctx.calls.lineTo).toHaveLength(20);
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
    expect(renderer.active).toHaveLength(36);
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

  it('batches the icosahedron cluster into a single fill', () => {
    // Twelve sub-discs, one fill call — the original issued twelve.
    const ctx = fakeContext();
    getShape('icosahedron').draw(ctx, { sx: 100, sy: 100, radius: 4, time: 0 });
    expect(ctx.calls.arc).toHaveLength(12);
    expect(ctx.calls.fill).toBe(1);
  });

  it('draws a disc as one arc', () => {
    const ctx = fakeContext();
    getShape('disc').draw(ctx, { sx: 10, sy: 20, radius: 3, time: 0 });
    expect(ctx.calls.arc).toEqual([[10, 20, 3]]);
    expect(ctx.calls.fill).toBe(1);
  });
});
