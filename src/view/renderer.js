import { createProjected } from './projectors.js';
import { getShape } from './shapes.js';

/** Alpha range applied as a depth cue in the 3D view. */
const DEPTH_ALPHA_MIN = 0.4;
const DEPTH_ALPHA_MAX = 1;

/**
 * Canvas2D renderer.
 *
 * Deliberately projection-agnostic: it asks a `Projector` where each particle lands and
 * never inspects the view mode. Everything that differs between 3D and 2D — perspective,
 * depth sorting, depth-modulated alpha — falls out of the projector's `sortsByDepth` flag
 * and the `scale`/`depth` fields it returns.
 */
export class Renderer {
  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {import('./viewport.js').Viewport} viewport
   */
  constructor(ctx, viewport) {
    this.ctx = ctx;
    this.viewport = viewport;
    /**
     * Slot pool. Grown on demand and never shrunk, so a steady-state frame allocates
     * nothing.
     * @type {Array<import('./projectors.js').Projected & {alpha: number}>}
     */
    this.pool = [];
    /**
     * References into `pool` for the current frame. Reset by truncation, and sorted in
     * place for the 3D view — which is exact, unlike sorting a partially filled pool.
     * @type {Array<import('./projectors.js').Projected & {alpha: number}>}
     */
    this.active = [];
    /** Reused shape argument; shape.draw() consumes it synchronously. */
    this.shapeState = { sx: 0, sy: 0, radius: 0, time: 0 };
  }

  /**
   * Draw one frame.
   *
   * @param {import('../core/scene.js').Scene} scene
   * @param {import('./projectors.js').Projector} projector
   * @param {{background: string, foreground: string, trailAlpha: number}} theme
   */
  render(scene, projector, theme) {
    projector.configure(this.viewport, scene.config.initialRadius);

    this.#drawBackground(theme);
    this.#project(scene, projector);

    if (projector.sortsByDepth) this.#sortByDepth();

    this.#drawParticles(scene, projector);
    this.#drawEdges(scene, theme);
  }

  /**
   * Translucent full-canvas fill. Lower `trailAlpha` leaves longer motion trails; this is
   * the trail technique from the original, with the colour now sourced from the theme
   * instead of a mode flag that nothing ever toggled.
   *
   * @param {{background: string, foreground: string, trailAlpha: number}} theme
   */
  #drawBackground(theme) {
    const { ctx, viewport } = this;
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = theme.background;
    ctx.globalAlpha = theme.trailAlpha;
    ctx.fillRect(0, 0, viewport.width, viewport.height);
    ctx.restore();
  }

  /**
   * Project every particle into the slot pool and collect the frame's active slots.
   * @param {import('../core/scene.js').Scene} scene
   * @param {import('./projectors.js').Projector} projector
   */
  #project(scene, projector) {
    this.active.length = 0;
    let i = 0;
    scene.forEachParticleInto((position, ring) => {
      let slot = this.pool[i];
      if (!slot) {
        slot = { ...createProjected(), alpha: 1 };
        this.pool[i] = slot;
      }
      projector.project(position, slot);
      slot.alpha = ring.opacity;
      this.active.push(slot);
      i += 1;
    });
  }

  /** Painter's algorithm: farthest first, so nearer particles overdraw. */
  #sortByDepth() {
    this.active.sort((a, b) => a.depth - b.depth);
  }

  /**
   * @param {import('../core/scene.js').Scene} scene
   * @param {import('./projectors.js').Projector} projector
   */
  #drawParticles(scene, projector) {
    const { ctx } = this;
    const { config } = scene;
    const shape = getShape(config.shape);

    // Depth range for the 3D alpha cue. Skipped entirely in 2D, where every depth is 0.
    let minDepth = Infinity;
    let maxDepth = -Infinity;
    if (projector.sortsByDepth) {
      for (const p of this.active) {
        if (p.depth < minDepth) minDepth = p.depth;
        if (p.depth > maxDepth) maxDepth = p.depth;
      }
    }
    const depthSpan = maxDepth - minDepth;

    ctx.save();
    ctx.fillStyle = config.color;
    if (config.glow) {
      ctx.shadowColor = config.color;
      ctx.shadowBlur = 16;
    }

    for (const p of this.active) {
      if (!p.visible) continue;

      const radius = config.size * p.scale;
      if (radius <= 0.05) continue;

      let alpha = p.alpha;
      if (projector.sortsByDepth && depthSpan > 0) {
        const t = (p.depth - minDepth) / depthSpan;
        alpha *= DEPTH_ALPHA_MIN + (DEPTH_ALPHA_MAX - DEPTH_ALPHA_MIN) * t;
      }
      if (alpha <= 0.01) continue;

      ctx.globalAlpha = alpha;
      this.shapeState.sx = p.sx;
      this.shapeState.sy = p.sy;
      this.shapeState.radius = radius;
      this.shapeState.time = scene.time;
      shape.draw(ctx, this.shapeState);
    }

    ctx.restore();
  }

  /**
   * Chords between particles.
   *
   * Selection maths is carried over unchanged from the original: a frame counter drives a
   * `skip` stride and an `offset` rotation, so the connection pattern mutates over time.
   * The drawing is not carried over — the original issued one `beginPath`/`stroke` pair per
   * chord even though `strokeStyle` is constant for the whole frame. All chords now share a
   * single path and a single stroke.
   *
   * @param {import('../core/scene.js').Scene} scene
   * @param {{background: string, foreground: string}} theme
   */
  #drawEdges(scene, theme) {
    const n = this.active.length;
    if (n < 2 || scene.config.chordAlpha <= 0) return;

    const { ctx } = this;
    const { config } = scene;
    const timeMs = scene.time * 1000;

    const frame = Math.floor(timeMs / config.edgeFrequency);
    const skip = Math.floor(Math.abs(Math.sin(frame * 0.1)) * (n / 3)) + 1;
    const offset = ((frame % n) + n) % n;

    ctx.save();
    ctx.strokeStyle = config.chromaticChords
      ? `hsl(${(timeMs / 20) % 360}, 100%, 70%)`
      : theme.foreground;
    ctx.lineWidth = config.lineWidth;
    ctx.globalAlpha = config.chordAlpha;

    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const a = this.active[i];
      const b = this.active[(i + skip + offset) % n];
      if (!a.visible || !b.visible) continue;
      ctx.moveTo(a.sx, a.sy);
      ctx.lineTo(b.sx, b.sy);
    }
    ctx.stroke();
    ctx.restore();
  }

  /** Erase the canvas completely, bypassing the translucent trail fill. */
  clear() {
    const { ctx } = this;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.restore();
  }
}
