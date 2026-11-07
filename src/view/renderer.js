import { createProjected } from './projectors.js';
import { getShape } from './shapes.js';

/** Alpha range applied as a depth cue in the 3D view. */
const DEPTH_ALPHA_MIN = 0.4;
const DEPTH_ALPHA_MAX = 1;

/**
 * Particles are filled in this many opacity levels, one path and one `fill()` per level.
 * Levels are drawn in ascending opacity, which in 3D is roughly far to near.
 */
export const ALPHA_LEVELS = 16;

/** Chords touching a fading ring are stroked in this many opacity levels. */
const CHORD_LEVELS = 4;

/**
 * The translucent trail fill stalls short of the background once a pixel is close enough that
 * the per-frame change rounds to zero. Chromium's rounding lets a fade to black converge, but
 * a fade to white sticks: at trail alpha 0.02 whole trails stay ~50 levels grey forever.
 * Every `GHOST_SWEEP_FRAMES` frames an additive fill of the background at `GHOST_NUDGE`
 * steps stalled pixels up to it. Against black the additive fill adds nothing.
 */
const GHOST_SWEEP_SECONDS = 0.5;
const GHOST_NUDGE = 10 / 255;

/**
 * @typedef {import('./projectors.js').Projected & {opacity: number, alpha: number}} Slot
 *   `opacity` is the ring's fade; `alpha` is the final particle alpha including the depth cue.
 */

/**
 * Canvas2D renderer.
 *
 * Deliberately projection-agnostic: it asks a `Projector` where each particle lands and
 * never inspects the view mode. Everything that differs between 3D and 2D — perspective and
 * depth-modulated alpha — falls out of the projector's `sortsByDepth` flag and the
 * `scale`/`depth` fields it returns.
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
     * Projection slots in particle order, reused between frames; the pool retains its peak
     * capacity, so only the first `count` slots belong to the current frame.
     * @type {Slot[]}
     */
    this.pool = [];
    /** Number of particles projected this frame. */
    this.count = 0;
    /** Slot references per opacity level, truncated every frame. @type {Slot[][]} */
    this.buckets = Array.from({ length: ALPHA_LEVELS }, () => []);
    /** Chord endpoint pool indices per opacity level, as flat pairs. @type {number[][]} */
    this.chordBuckets = Array.from({ length: CHORD_LEVELS }, () => []);
    /** Reused shape argument; shape.trace() consumes it synchronously. */
    this.shapeState = { sx: 0, sy: 0, radius: 0, time: 0 };
    this.sweepElapsed = 0;
  }

  /**
   * Draw one frame.
   *
   * @param {import('../core/scene.js').Scene} scene
   * @param {import('./projectors.js').Projector} projector
   * @param {{background: string, foreground: string}} theme
   */
  render(scene, projector, theme, dt = 0) {
    this.sceneHalfLife = scene.config.trailHalfLife;
    this.#drawBackground(theme, dt);
    const frame = this.viewport.frame ?? {
      x: 0,
      y: 0,
      width: this.viewport.width,
      height: this.viewport.height,
    };
    const scale = Math.min(frame.width, frame.height) / 720;
    projector.configure({ width: frame.width / scale, height: frame.height / scale }, 1);
    this.ctx.save();
    this.ctx.translate(frame.x, frame.y);
    this.ctx.scale(scale, scale);
    this.#project(scene, projector);
    this.#drawParticles(scene, theme);
    this.#drawEdges(scene, theme);
    this.ctx.restore();
  }

  /**
   * Time-based translucent fill. Longer half-life leaves longer motion trails.
   *
   * @param {{background: string}} theme
   */
  #drawBackground(theme, dt) {
    const { ctx, viewport } = this;
    this.sweepElapsed += dt;
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = theme.background;
    ctx.globalAlpha = trailOpacity(this.sceneHalfLife ?? 0, dt);
    ctx.fillRect(0, 0, viewport.width, viewport.height);
    if (this.sweepElapsed + 1e-9 >= GHOST_SWEEP_SECONDS) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = GHOST_NUDGE;
      ctx.fillRect(0, 0, viewport.width, viewport.height);
      this.sweepElapsed = Math.max(
        0,
        this.sweepElapsed -
          Math.floor((this.sweepElapsed + 1e-9) / GHOST_SWEEP_SECONDS) * GHOST_SWEEP_SECONDS
      );
    }
    ctx.restore();
  }

  /**
   * Project every particle into the slot pool and assign it to an opacity level.
   *
   * The 3D depth cue is normalised to the fixed extent of the scene (radius 1)
   * rather than to each frame's depth range, so a particle's shade does
   * not shift when other rings spawn or rotate.
   *
   * @param {import('../core/scene.js').Scene} scene
   * @param {import('./projectors.js').Projector} projector
   */
  #project(scene, projector) {
    for (const bucket of this.buckets) bucket.length = 0;
    const depthCue = projector.sortsByDepth;
    const extent = 1;
    const { size } = scene.config;

    let i = 0;
    scene.forEachParticle((position, ring) => {
      let slot = this.pool[i];
      if (!slot) {
        slot = { ...createProjected(), opacity: 1, alpha: 1 };
        this.pool[i] = slot;
      }
      i += 1;
      projector.project(position, slot);
      slot.opacity = ring.opacity;

      let alpha = ring.opacity;
      if (depthCue) {
        const t = Math.min(1, Math.max(0, (slot.depth + extent) / (2 * extent)));
        alpha *= DEPTH_ALPHA_MIN + (DEPTH_ALPHA_MAX - DEPTH_ALPHA_MIN) * t;
      }
      slot.alpha = alpha;

      if (!slot.visible || alpha <= 0.01 || size * slot.scale <= 0.05) return;
      // Level k holds alphas in (k / L, (k + 1) / L] and is filled at its upper edge, so a
      // fully opaque particle is drawn at exactly 1.
      const level = Math.min(ALPHA_LEVELS - 1, Math.ceil(alpha * ALPHA_LEVELS) - 1);
      this.buckets[level].push(slot);
    });
    this.count = i;
  }

  /**
   * @param {import('../core/scene.js').Scene} scene
   * @param {{foreground: string}} theme
   */
  #drawParticles(scene, theme) {
    const { ctx, shapeState } = this;
    const { config } = scene;
    const shape = getShape(config.shape);

    ctx.save();
    const color = config.color === 'auto' ? theme.foreground : config.color;
    ctx.fillStyle = color;
    if (config.glow) {
      ctx.shadowColor = color;
      ctx.shadowBlur = 16;
    }

    shapeState.time = scene.time;
    for (let level = 0; level < ALPHA_LEVELS; level++) {
      const bucket = this.buckets[level];
      if (!bucket.length) continue;
      ctx.globalAlpha = (level + 1) / ALPHA_LEVELS;
      ctx.beginPath();
      for (const p of bucket) {
        shapeState.sx = p.sx;
        shapeState.sy = p.sy;
        shapeState.radius = config.size * p.scale;
        shape.trace(ctx, shapeState);
      }
      ctx.fill();
    }

    ctx.restore();
  }

  /**
   * Chords between particles.
   *
   * A frame counter derived from `edgeFrequency` drives a stride through the particle list,
   * so the connection pattern mutates over time. The stride is measured in stable particle
   * identity — `(ring seq, index)` over the configured ring capacity — rather than in the
   * live particle count, so a ring spawning or being removed does not reshuffle every chord;
   * the pattern changes only when the frame counter does.
   *
   * Chords are stroked in one path per opacity level: a single stroke unless a ring is
   * fading, in which case its chords fade with it.
   *
   * @param {import('../core/scene.js').Scene} scene
   * @param {{foreground: string}} theme
   */
  #drawEdges(scene, theme) {
    const n = this.count;
    const { config, rings } = scene;
    if (n < 2 || config.chordAlpha <= 0) return;

    const points = config.numPoints;
    const capacity =
      points * Math.max(1, config.spawnMode === 'static' ? config.ringCount : config.maxRings);
    const firstSeq = rings[0].seq;
    const liveRings = rings.length;
    const timeMs = scene.time * 1000;

    const frame = Math.floor(timeMs / config.edgeFrequency);
    const skip = Math.floor(Math.abs(Math.sin(frame * 0.1)) * (capacity / 3)) + 1;
    const stride = (skip + (frame % capacity)) % capacity;

    for (const bucket of this.chordBuckets) bucket.length = 0;
    for (let a = 0; a < n; a++) {
      const ringIndex = Math.floor(a / points);
      const identity = (firstSeq + ringIndex) * points + (a % points);
      // Forward along the stride; wrap back by one capacity when that runs past the newest
      // ring, which keeps every particle connected once the ring set is full.
      let partnerRing = Math.floor((identity + stride) / points) - firstSeq;
      if (partnerRing >= liveRings) partnerRing -= capacity / points;
      if (partnerRing < 0 || partnerRing >= liveRings) continue;
      const b = partnerRing * points + ((identity + stride) % points);
      if (b === a) continue;

      const pa = this.pool[a];
      const pb = this.pool[b];
      if (!pa.visible || !pb.visible) continue;
      const opacity = Math.min(pa.opacity, pb.opacity);
      if (opacity <= 0) continue;
      const bucket =
        this.chordBuckets[Math.min(CHORD_LEVELS, Math.ceil(opacity * CHORD_LEVELS)) - 1];
      bucket.push(a, b);
    }

    const { ctx } = this;
    ctx.save();
    ctx.strokeStyle = config.chromaticChords
      ? `hsl(${(timeMs / 20) % 360}, 100%, ${theme.background === '#ffffff' ? 35 : 70}%)`
      : theme.foreground;
    ctx.lineWidth = config.lineWidth;

    for (let level = 0; level < CHORD_LEVELS; level++) {
      const pairs = this.chordBuckets[level];
      if (!pairs.length) continue;
      ctx.globalAlpha = (config.chordAlpha * (level + 1)) / CHORD_LEVELS;
      ctx.beginPath();
      for (let k = 0; k < pairs.length; k += 2) {
        const pa = this.pool[pairs[k]];
        const pb = this.pool[pairs[k + 1]];
        ctx.moveTo(pa.sx, pa.sy);
        ctx.lineTo(pb.sx, pb.sy);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * Paint the whole backing store with the background, bypassing the translucent trail fill.
   * `clearRect` is not used: on an `alpha: false` context it clears to opaque black, which
   * is wrong for the light theme.
   *
   * @param {string} background
   */
  clear(background) {
    const { ctx } = this;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.restore();
    this.sweepElapsed = 0;
  }
}

export function trailOpacity(halfLife, dt) {
  return halfLife <= 0 ? 1 : 1 - Math.pow(2, -Math.max(0, dt) / halfLife);
}
