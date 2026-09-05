/**
 * Device-pixel-ratio aware canvas sizing.
 *
 * The backing store is sized to `cssSize * devicePixelRatio` and the context is scaled by
 * the same factor, so every other module can work in CSS pixels and still get a sharp
 * image on HiDPI displays.
 *
 * The pre-refactor code sized the backing store to `window.innerWidth/innerHeight` while
 * CSS laid the element out inside a grid column with its own `min-height`, so the two
 * disagreed: the image was distorted at narrow widths and blurry everywhere on HiDPI.
 */
export class Viewport {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {CanvasRenderingContext2D} ctx
   * @param {() => void} [onResize] Called after the canvas has been resized.
   */
  constructor(canvas, ctx, onResize) {
    this.canvas = canvas;
    this.ctx = ctx;
    this.onResize = onResize;
    /** CSS pixels. */
    this.width = 0;
    /** CSS pixels. */
    this.height = 0;
    this.dpr = 1;

    this.observer = new ResizeObserver(() => this.sync());
    this.observer.observe(canvas);
    this.sync();
  }

  /**
   * Resize the backing store to match the element's current layout size.
   * No-ops when nothing changed, so it is safe to call every frame.
   *
   * @returns {boolean} True if the backing store was resized.
   */
  sync() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const cssWidth = Math.max(1, Math.round(rect.width));
    const cssHeight = Math.max(1, Math.round(rect.height));
    const pixelWidth = Math.round(cssWidth * dpr);
    const pixelHeight = Math.round(cssHeight * dpr);

    if (this.canvas.width === pixelWidth && this.canvas.height === pixelHeight) {
      return false;
    }

    this.canvas.width = pixelWidth;
    this.canvas.height = pixelHeight;
    this.width = cssWidth;
    this.height = cssHeight;
    this.dpr = dpr;

    // Resizing the backing store resets all context state, so the transform must be
    // reapplied here rather than once at startup.
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.onResize?.();
    return true;
  }

  /** Detach the observer. Call from the app's `destroy()`. */
  destroy() {
    this.observer.disconnect();
  }
}
