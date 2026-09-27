/**
 * Backing-store density ceiling. Above 2x the extra pixels are barely visible but every
 * full-canvas trail fill and every exported frame pays for them (DPR 3 is 2.25x the pixels).
 */
const MAX_DPR = 2;

/** @returns {number} The device pixel ratio the backing store is sized for. */
export function currentDpr() {
  return Math.min(window.devicePixelRatio || 1, MAX_DPR);
}

/**
 * Device-pixel-ratio aware canvas sizing.
 *
 * The backing store is sized to `cssSize * dpr` and the context is scaled by the same
 * factor, so every other module can work in CSS pixels and still get a sharp image on HiDPI
 * displays. `dpr` is capped at `MAX_DPR`.
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

    this.onDprChange = () => this.sync();
    this.observer = new ResizeObserver(() => this.sync());
    this.observer.observe(canvas);
    this.sync();
  }

  /**
   * Resize the backing store to match the element's current layout size.
   * No-ops when nothing changed.
   *
   * @returns {boolean} True if the backing store, CSS metrics or DPR changed.
   */
  sync() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = currentDpr();
    const cssWidth = Math.max(1, Math.round(rect.width));
    const cssHeight = Math.max(1, Math.round(rect.height));
    const pixelWidth = Math.round(cssWidth * dpr);
    const pixelHeight = Math.round(cssHeight * dpr);

    if (
      this.canvas.width === pixelWidth &&
      this.canvas.height === pixelHeight &&
      this.width === cssWidth &&
      this.height === cssHeight &&
      this.dpr === dpr
    ) {
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
    // Re-arm after any detected change, including a sync triggered by the frame loop.
    this.dprQuery?.removeEventListener('change', this.onDprChange);
    // Watch the raw ratio: a capped value would describe a resolution the screen is not at.
    this.dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    this.dprQuery.addEventListener('change', this.onDprChange);
    this.onResize?.();
    return true;
  }

  /** Detach the size observer and DPR listener. Call from the app's `destroy()`. */
  destroy() {
    this.observer.disconnect();
    this.dprQuery.removeEventListener('change', this.onDprChange);
  }
}
