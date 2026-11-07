import { Scene } from '../core/scene.js';
import { Camera } from '../view/camera.js';
import { createProjector } from '../view/projectors.js';
import { Renderer } from '../view/renderer.js';

export const PIXEL_FRAME_BUDGET = 1920 * 1080 * 60 * 30;
export const PAYLOAD_LIMIT = 60 * 1024 * 1024;
export const FILE_LIMIT = 64 * 1024 * 1024;
const SIZES = { landscape: [1920, 1080], square: [1080, 1080], portrait: [1080, 1920] };

export function captureSize(resolution, screen) {
  let width, height;
  if (resolution === 'screen') {
    const scale = Math.min(
      1,
      1920 / Math.max(screen.width, screen.height),
      Math.sqrt(2073600 / (screen.width * screen.height))
    );
    width = Math.max(2, Math.floor((screen.width * scale) / 2) * 2);
    height = Math.max(2, Math.floor((screen.height * scale) / 2) * 2);
  } else {
    if (!SIZES[resolution]) throw new Error('Choose a capture resolution.');
    [width, height] = SIZES[resolution];
  }
  return { width, height };
}

export function captureLimit(size, fps) {
  return Math.min(120, Math.floor(PIXEL_FRAME_BUDGET / (size.width * size.height * fps)));
}

export function validateCapture(options, screen) {
  const size = captureSize(options.resolution, screen);
  if (![24, 30, 60, 120].includes(options.fps)) throw new Error('Choose 24, 30, 60 or 120 FPS.');
  const limit = captureLimit(size, options.fps);
  if (!Number.isInteger(options.duration) || options.duration < 1 || options.duration > limit) {
    throw new Error('Use 1–' + limit + ' seconds, or reduce FPS or resolution.');
  }
  return { ...size, ...options };
}

/** Separate resources and a fresh, fully populated deterministic timeline. */
export class CaptureScene {
  constructor(document, size, owner = window.document) {
    this.canvas = owner.createElement('canvas');
    this.canvas.width = size.width;
    this.canvas.height = size.height;
    this.context = this.canvas.getContext('2d', { alpha: false, willReadFrequently: true });
    if (!this.context) throw new Error('Could not create the capture canvas.');
    this.scene = new Scene(document.parameters);
    this.camera = new Camera(document.camera);
    this.orbit = document.camera.autoOrbit && document.view === '3d';
    this.projector = createProjector(document.view, this.camera);
    this.renderer = new Renderer(this.context, size);
    this.theme =
      document.appearance === 'light'
        ? { background: '#ffffff', foreground: '#000000' }
        : { background: '#000000', foreground: '#ffffff' };
    this.render(0);
  }
  render(dt) {
    if (dt === 0) this.renderer.clear(this.theme.background);
    this.scene.step(dt);
    this.camera.update(dt, this.orbit);
    this.renderer.render(this.scene, this.projector, this.theme, dt);
  }
}
