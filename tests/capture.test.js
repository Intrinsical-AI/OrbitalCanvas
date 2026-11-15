import { expect, it } from 'vitest';
import {
  captureSize,
  captureLimit,
  validateCapture,
  PIXEL_FRAME_BUDGET,
  CaptureScene,
  validateCaptureSpec,
} from '../src/ui/capture.js';
import { trailOpacity } from '../src/view/renderer.js';
import { defaultDocument } from '../src/ui/permalink.js';

it.each(['landscape', 'square', 'portrait', 'screen'])(
  'bounds %s dimensions and preserves Screen aspect',
  (resolution) => {
    const size = captureSize(resolution, { width: 4011, height: 2999 });
    expect(size.width % 2).toBe(0);
    expect(size.height % 2).toBe(0);
    expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(1920);
    expect(size.width * size.height).toBeLessThanOrEqual(2073600);
    if (resolution === 'screen') expect(size.width / size.height).toBeCloseTo(4011 / 2999, 2);
  }
);
it('bounds work by resolution, FPS and duration, independently of scene profile', () => {
  const screen = { width: 1920, height: 1080 };
  expect(captureLimit(screen, 60)).toBe(30);
  expect(captureLimit(screen, 120)).toBe(15);
  expect(() =>
    validateCapture({ resolution: 'landscape', fps: 120, duration: 16 }, screen)
  ).toThrow(/reduce FPS/);
  const spec = validateCapture({ resolution: 'landscape', fps: 60, duration: 30 }, screen);
  expect(spec.width * spec.height * spec.fps * spec.duration).toBe(PIXEL_FRAME_BUDGET);
});
it.each([0, NaN, 1.2, 121])('rejects invalid capture duration %s', (duration) => {
  expect(() =>
    validateCapture({ resolution: 'screen', fps: 30, duration }, { width: 640, height: 480 })
  ).toThrow();
});
it('rejects unknown size and FPS', () => {
  expect(() => captureSize('4k', { width: 1, height: 1 })).toThrow();
  expect(() =>
    validateCapture({ resolution: 'square', duration: 1, fps: 25 }, { width: 1, height: 1 })
  ).toThrow();
});
it('defaults to H.264 sharing and rejects unknown video formats', () => {
  const options = { resolution: 'screen', duration: 1, fps: 30 };
  const screen = { width: 640, height: 480 };
  expect(validateCapture(options, screen).format).toBe('share');
  expect(validateCapture({ ...options, format: 'auto' }, screen).format).toBe('auto');
  expect(() => validateCapture({ ...options, format: 'av1' }, screen)).toThrow('video format');
});
it.each([30, 60, 120])('trail luminance halves after one half-life at %s FPS', (fps) => {
  const h = 0.5,
    alpha = trailOpacity(h, 1 / fps);
  expect(Math.pow(1 - alpha, h * fps)).toBeCloseTo(0.5, 10);
  expect(trailOpacity(0, 0)).toBe(1);
});

it('does not accept dimensions supplied over the chosen capture resolution', () => {
  expect(
    validateCapture(
      { resolution: 'square', width: 4000, height: 4000, fps: 30, duration: 1 },
      { width: 640, height: 480 }
    )
  ).toMatchObject({ width: 1080, height: 1080 });
});

it.each([0, NaN, Infinity, -1])('rejects unusable Screen dimensions %s', (width) => {
  expect(() => captureSize('screen', { width, height: 480 })).toThrow('capture size');
});

it.each([
  { width: 641, height: 480 },
  { width: 1920, height: 1920 },
  { width: 0, height: 480 },
])('validates exact worker dimensions before allocation: %j', (size) => {
  expect(() => validateCaptureSpec({ ...size, fps: 30, duration: 1 })).toThrow('Full HD');
});

it('keeps Safe capture below the particle budget after a delayed real-time frame', () => {
  const context = new Proxy({}, { get: (target, key) => target[key] ?? (() => {}) });
  const canvas = { width: 640, height: 480, getContext: () => context };
  const document = defaultDocument();
  Object.assign(document.parameters, { numPoints: 128, maxRings: 25, circleInterval: 0.2 });
  const capture = new CaptureScene(document, canvas);
  expect(capture.canvas).toBe(canvas);
  expect(capture.scene.time).toBe(0);
  capture.render(1.6);
  expect(capture.scene.particleCount).toBeLessThanOrEqual(4000);
  expect(capture.scene.time).toBeCloseTo(1.6, 12);
});
