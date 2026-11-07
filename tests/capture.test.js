import { expect, it } from 'vitest';
import {
  captureSize,
  captureLimit,
  validateCapture,
  PIXEL_FRAME_BUDGET,
} from '../src/ui/capture.js';
import { trailOpacity } from '../src/view/renderer.js';

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
it.each([30, 60, 120])('trail luminance halves after one half-life at %s FPS', (fps) => {
  const h = 0.5,
    alpha = trailOpacity(h, 1 / fps);
  expect(Math.pow(1 - alpha, h * fps)).toBeCloseTo(0.5, 10);
  expect(trailOpacity(0, 0)).toBe(1);
});
