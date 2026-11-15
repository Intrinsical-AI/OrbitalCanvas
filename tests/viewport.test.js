import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { currentDpr, Viewport } from '../src/view/viewport.js';

let rect;
let ctx;
let canvas;
let resizeObserver;
let queries;

beforeEach(() => {
  rect = { width: 300, height: 150 };
  ctx = { setTransform: vi.fn() };
  canvas = { width: 300, height: 150, getBoundingClientRect: () => rect };
  queries = [];
  vi.stubGlobal('window', {
    devicePixelRatio: 1,
    matchMedia: (media) => {
      const query = new EventTarget();
      query.media = media;
      queries.push(query);
      return query;
    },
  });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback) {
        this.callback = callback;
        this.observe = vi.fn();
        this.disconnect = vi.fn();
        resizeObserver = this;
      }
    }
  );
});

afterEach(() => vi.unstubAllGlobals());

describe('Viewport', () => {
  it('initializes metrics even when the existing backing store already has the right size', () => {
    const resized = vi.fn();
    const viewport = new Viewport(canvas, ctx, resized);
    expect(viewport.width).toBe(300);
    expect(viewport.height).toBe(150);
    expect(ctx.setTransform).toHaveBeenCalledWith(1, 0, 0, 1, 0, 0);
    expect(resized).toHaveBeenCalledOnce();
    expect(viewport.sync()).toBe(false);
    expect(resized).toHaveBeenCalledOnce();
    viewport.destroy();
    expect(resizeObserver.disconnect).toHaveBeenCalledOnce();
  });

  it('updates CSS metrics and transform when DPR changes with the same backing dimensions', () => {
    rect = { width: 800, height: 600 };
    const viewport = new Viewport(canvas, ctx);
    rect = { width: 400, height: 300 };
    globalThis.window.devicePixelRatio = 2;
    resizeObserver.callback();
    expect(canvas.width).toBe(800);
    expect(canvas.height).toBe(600);
    expect(viewport.width).toBe(400);
    expect(viewport.height).toBe(300);
    expect(viewport.dpr).toBe(2);
    expect(queries.at(-1).media).toBe('(resolution: 2dppx)');
    expect(ctx.setTransform).toHaveBeenLastCalledWith(2, 0, 0, 2, 0, 0);
  });

  it('tracks successive DPR-only changes and detaches its listener on destroy', () => {
    const resized = vi.fn();
    const viewport = new Viewport(canvas, ctx, resized);
    for (const dpr of [1.5, 2]) {
      globalThis.window.devicePixelRatio = dpr;
      queries.at(-1).dispatchEvent(new Event('change'));
      expect(canvas.width).toBe(300 * dpr);
      expect(canvas.height).toBe(150 * dpr);
      expect(viewport.width).toBe(300);
      expect(viewport.height).toBe(150);
      expect(queries.at(-1).media).toBe(`(resolution: ${dpr}dppx)`);
      expect(ctx.setTransform).toHaveBeenLastCalledWith(dpr, 0, 0, dpr, 0, 0);
    }
    viewport.destroy();
    globalThis.window.devicePixelRatio = 1;
    for (const query of queries) query.dispatchEvent(new Event('change'));
    expect(canvas.width).toBe(600);
    expect(resized).toHaveBeenCalledTimes(3);
  });

  it('caps the backing-store density at 2x but watches the raw ratio', () => {
    globalThis.window.devicePixelRatio = 3;
    const viewport = new Viewport(canvas, ctx);
    expect(viewport.dpr).toBe(2);
    expect(canvas.width).toBe(600);
    expect(canvas.height).toBe(300);
    expect(ctx.setTransform).toHaveBeenLastCalledWith(2, 0, 0, 2, 0, 0);
    expect(queries.at(-1).media).toBe('(resolution: 3dppx)');
    expect(currentDpr()).toBe(2);
  });

  it('keeps watching raw DPR changes while successive backing densities remain capped', () => {
    globalThis.window.devicePixelRatio = 3;
    const resized = vi.fn();
    const viewport = new Viewport(canvas, ctx, resized);
    globalThis.window.devicePixelRatio = 4;
    queries.at(-1).dispatchEvent(new Event('change'));
    expect(queries.at(-1).media).toBe('(resolution: 4dppx)');
    expect(canvas.width).toBe(600);
    expect(resized).toHaveBeenCalledOnce();

    // The 4dppx query changes to false on the next move, even though 3dppx stays false.
    globalThis.window.devicePixelRatio = 1.5;
    queries.at(-1).dispatchEvent(new Event('change'));
    expect(queries.at(-1).media).toBe('(resolution: 1.5dppx)');
    expect(canvas.width).toBe(450);
    expect(viewport.dpr).toBe(1.5);
    expect(resized).toHaveBeenCalledTimes(2);
    viewport.destroy();
  });
});
