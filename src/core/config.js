/**
 * Single source of truth for configuration.
 *
 * Two vocabularies exist and are deliberately kept apart:
 *
 *  - **internal units** — what the simulation runs on (radians, seconds, world units).
 *  - **display units** — what a slider shows the user (degrees, milliseconds, …).
 *
 * `CONTROLS` owns the conversion between them via `toInternal` / `toDisplay`, so the
 * translation exists in exactly one place. Nothing outside this module should convert
 * units, and no other module should hardcode a default.
 */

const DEG = Math.PI / 180;

/** @returns {number} */
const degToRad = (d) => d * DEG;
/** @returns {number} */
const radToDeg = (r) => r / DEG;

/** Parameter-range profiles exposed by the control drawer. */
/** @typedef {'safe'|'experimental'} RangeMode */
export const RANGE_MODES = Object.freeze(['safe', 'experimental']);

/**
 * Export limits share the same profile switch as the scene controls. The experimental export
 * ceiling intentionally remains the original 120 s / 120 fps: unlike a scene parameter, a
 * longer export only multiplies work and does not create a richer interactive state.
 */
export const EXPORT_LIMITS = Object.freeze({
  safe: Object.freeze({
    duration: Object.freeze({ min: 1, max: 30, step: 1 }),
    fps: Object.freeze({ min: 10, max: 60, step: 1 }),
  }),
  experimental: Object.freeze({
    duration: Object.freeze({ min: 1, max: 120, step: 1 }),
    fps: Object.freeze({ min: 10, max: 120, step: 1 }),
  }),
});

export const EXPORT_DEFAULTS = Object.freeze({ duration: 6, fps: 60 });

/**
 * Default configuration, in **internal units**.
 * @type {Readonly<Record<string, unknown>>}
 */
export const DEFAULTS = Object.freeze({
  // --- Simulation -------------------------------------------------------
  /** Geometry implementation id, resolved through `core/geometry/index.js`. */
  geometry: 'euclidean',
  /** `'generative'` spawns rings over time; `'static'` builds a fixed, deterministic set. */
  spawnMode: 'generative',
  /** Particles per ring. */
  numPoints: 72,
  /** Angular velocity, radians per second. Scales the phase derivative, never absolute time. */
  speed: 0.5,
  /** Tilt added to each successive ring, radians. */
  planeAngle: degToRad(15),
  /** Radius of the first (outermost) ring, world units. */
  initialRadius: 380,
  /**
   * Radius decrement between successive rings, world units.
   *
   * Raised from the original 10: with a 12-ring budget a step of 10 left every ring within
   * 110 units of the outermost one, so the whole set read as a single thick circle and the
   * accumulated tilt was invisible. 28 spreads the budget across the full radius range.
   */
  radiusStep: 28,
  /** Rings smaller than this are not spawned. */
  minRadius: 40,

  // --- Generative spawn mode -------------------------------------------
  /**
   * Seconds between ring spawns.
   *
   * Also lowered from the original 5: at that rate the scene needed roughly a minute
   * before it showed any depth at all, and a first-time visitor saw a flat circle.
   */
  circleInterval: 0.8,
  /** Ring budget; the oldest ring fades out once this is exceeded. */
  maxRings: 12,
  /** Seconds an evicted ring takes to fade to zero opacity. */
  fadeDuration: 1,

  // --- Static spawn mode ------------------------------------------------
  /** Exact number of rings built up front. Matches `maxRings` so the two modes look alike. */
  ringCount: 12,

  // --- Style ------------------------------------------------------------
  /** Particle shape id, resolved through `view/shapes.js`. */
  shape: 'icosahedron',
  /**
   * Particle radius, world units.
   *
   * Reduced from 5: the icosahedron shape draws a cluster at 1.8x this radius, so at 5 the
   * clusters on a ring overlapped into a continuous tube. At 3 they read as discrete beads,
   * which is what makes the ring structure legible without colour.
   */
  size: 3,
  /** Chord stroke width, CSS pixels. */
  lineWidth: 1,
  /**
   * Chord layer opacity.
   *
   * Was a hardcoded 0.5, which was tuned for rainbow chords where hue separated overlapping
   * lines. Monochrome has only luminance to work with, so hundreds of crossing chords at
   * that opacity sum to a solid white mass. Exposed as a control because it is the single
   * most effective density dial in the piece.
   */
  chordAlpha: 0.14,
  /**
   * Particle fill colour.
   *
   * White by default: the shell is strictly monochrome, so the canvas is the only place
   * colour appears and it is entirely the user's choice to introduce it.
   */
  color: '#ffffff',
  /**
   * Cycle chord colour through the hue wheel over time.
   *
   * Off by default, which draws chords in the theme foreground instead. The rainbow cycle
   * is the original behaviour and remains one click away.
   */
  chromaticChords: false,
  /** Canvas `shadowBlur` glow. Off by default: it is a canvas2d performance cliff. */
  glow: false,
  /** Milliseconds between chord-pattern changes. */
  edgeFrequency: 3500,
  /** Opacity of the per-frame background fill; lower means longer motion trails. */
  trailAlpha: 0.1,

  // --- View -------------------------------------------------------------
  /** `'3d'` = perspective orbit camera; `'2d'` = strictly flat top-down projection. */
  view: '3d',
  /** Slowly rotate the 3D camera on its own. */
  autoOrbit: true,
});

/**
 * Drawer sections, in render order.
 *
 * Seventeen controls in one flat list gave the drawer no structure at all; grouping them is
 * information architecture, not styling, so it lives here next to the specs rather than in the
 * DOM. `validateControls` rejects a spec pointing at an id that is not in this list, which is
 * the same guarantee that makes a phantom control impossible.
 *
 * @typedef {object} Section
 * @property {string} id
 * @property {string} label
 *
 * @type {ReadonlyArray<Section>}
 */
export const SECTIONS = Object.freeze([
  Object.freeze({ id: 'form', label: 'Form' }),
  Object.freeze({ id: 'motion', label: 'Motion' }),
  Object.freeze({ id: 'style', label: 'Style' }),
]);

/**
 * Declarative UI control specification.
 *
 * Drives input creation, badge formatting, reset and randomise. Every entry maps one DOM
 * element id to one `DEFAULTS` key. A missing element is a hard error surfaced by
 * `validateControls`, which is what makes the old "phantom control" bug impossible.
 *
 * @typedef {object} ControlSpec
 * @property {string} id DOM element id.
 * @property {string} key Key in the config object.
 * @property {'range'|'color'|'select'|'checkbox'} type
 * @property {string} label Human-readable label.
 * @property {string} section Drawer section id; must be one of `SECTIONS`.
 * @property {number} [min] Range minimum, display units.
 * @property {number} [max] Range maximum, display units.
 * @property {number} [experimentalMax] Wider explicit-exploration maximum, display units.
 * @property {number} [step] Range step, display units.
 * @property {string} [unit] Suffix appended to the badge.
 * @property {number} [precision] Badge decimal places.
 * @property {Array<{value: string, label: string}>} [options] For `select`.
 * @property {(display: number) => number} [toInternal]
 * @property {(internal: number) => number} [toDisplay]
 * @property {'generative'|'static'} [spawnMode] Only shown for this spawn mode.
 * @property {boolean} [randomise] Included in the randomise action. Defaults to true.
 */

/** @type {ReadonlyArray<ControlSpec>} */
export const CONTROLS = Object.freeze([
  {
    id: 'numPointsControl',
    key: 'numPoints',
    type: 'range',
    label: 'Particles per ring',
    section: 'form',
    min: 3,
    max: 128,
    experimentalMax: 240,
    step: 1,
    precision: 0,
  },
  {
    id: 'speedControl',
    key: 'speed',
    type: 'range',
    label: 'Speed',
    section: 'motion',
    min: 0,
    max: 2.5,
    experimentalMax: 4,
    step: 0.05,
    unit: ' rad/s',
    precision: 2,
  },
  {
    id: 'sizeControl',
    key: 'size',
    type: 'range',
    label: 'Particle size',
    section: 'style',
    min: 1,
    max: 7,
    experimentalMax: 12,
    step: 0.5,
    precision: 1,
  },
  {
    id: 'lineWidthControl',
    key: 'lineWidth',
    type: 'range',
    label: 'Chord width',
    section: 'style',
    min: 0.5,
    max: 5,
    experimentalMax: 12,
    step: 0.1,
    precision: 1,
  },
  {
    id: 'chordAlphaControl',
    key: 'chordAlpha',
    type: 'range',
    label: 'Chord opacity',
    section: 'style',
    min: 0,
    max: 0.6,
    experimentalMax: 1,
    step: 0.01,
    precision: 2,
  },
  {
    id: 'planeAngleControl',
    key: 'planeAngle',
    type: 'range',
    label: 'Plane tilt per ring',
    section: 'form',
    min: 0,
    max: 120,
    experimentalMax: 270,
    step: 1,
    unit: '°',
    precision: 0,
    toInternal: degToRad,
    toDisplay: radToDeg,
  },
  {
    id: 'initialRadiusControl',
    key: 'initialRadius',
    type: 'range',
    label: 'Outer radius',
    section: 'form',
    min: 100,
    max: 550,
    experimentalMax: 800,
    step: 10,
    precision: 0,
  },
  {
    id: 'radiusStepControl',
    key: 'radiusStep',
    type: 'range',
    label: 'Radius step',
    section: 'form',
    min: 5,
    max: 50,
    experimentalMax: 80,
    step: 1,
    precision: 0,
    // Static mode spreads `ringCount` rings evenly over [minRadius, initialRadius]
    // instead of stepping, so this control only applies to generative spawning.
    spawnMode: 'generative',
  },
  {
    id: 'circleIntervalControl',
    key: 'circleInterval',
    type: 'range',
    label: 'Spawn interval',
    section: 'motion',
    min: 0.2,
    max: 6,
    experimentalMax: 15,
    step: 0.1,
    unit: ' s',
    precision: 1,
    spawnMode: 'generative',
  },
  {
    id: 'maxRingsControl',
    key: 'maxRings',
    type: 'range',
    label: 'Ring budget',
    section: 'form',
    min: 1,
    max: 28,
    experimentalMax: 48,
    step: 1,
    precision: 0,
    spawnMode: 'generative',
  },
  {
    id: 'ringCountControl',
    key: 'ringCount',
    type: 'range',
    label: 'Ring count',
    section: 'form',
    min: 1,
    max: 28,
    experimentalMax: 48,
    step: 1,
    precision: 0,
    spawnMode: 'static',
  },
  {
    id: 'edgeFrequencyControl',
    key: 'edgeFrequency',
    type: 'range',
    label: 'Chord change rate',
    section: 'motion',
    min: 200,
    max: 7000,
    experimentalMax: 12000,
    step: 100,
    unit: ' ms',
    precision: 0,
  },
  {
    id: 'trailAlphaControl',
    key: 'trailAlpha',
    type: 'range',
    label: 'Trail persistence',
    section: 'motion',
    min: 0.02,
    max: 0.7,
    experimentalMax: 1,
    step: 0.01,
    precision: 2,
  },
  {
    id: 'colorControl',
    key: 'color',
    type: 'color',
    label: 'Particle colour',
    section: 'style',
  },
  {
    id: 'shapeControl',
    key: 'shape',
    type: 'select',
    label: 'Particle shape',
    section: 'style',
    options: [
      { value: 'icosahedron', label: 'Icosahedron' },
      { value: 'disc', label: 'Disc' },
    ],
  },
  {
    id: 'chromaticChordsControl',
    key: 'chromaticChords',
    type: 'checkbox',
    label: 'Chromatic chords',
    section: 'style',
    randomise: false,
  },
  {
    id: 'glowControl',
    key: 'glow',
    type: 'checkbox',
    label: 'Glow',
    section: 'style',
    randomise: false,
  },
  {
    id: 'autoOrbitControl',
    key: 'autoOrbit',
    type: 'checkbox',
    label: 'Auto-orbit camera',
    section: 'motion',
    randomise: false,
  },
]);

/**
 * Named starting points, in **internal units** so they read exactly like `DEFAULTS`.
 *
 * These exist because `randomize()` walks the whole parameter space uniformly, which mostly
 * lands on noise. A preset is a hand-picked region worth arriving at directly. Every key is
 * checked against `DEFAULTS` by `validatePresets`, so a preset cannot introduce a config key
 * the scene does not understand.
 *
 * @typedef {object} Preset
 * @property {string} id
 * @property {string} label
 * @property {Readonly<Record<string, unknown>>} values
 *
 * @type {ReadonlyArray<Preset>}
 */
export const PRESETS = Object.freeze([
  Object.freeze({
    id: 'default',
    label: 'Default',
    values: Object.freeze({}),
  }),
  Object.freeze({
    // Wide tilt across few, well-separated rings: the accumulated plane rotation is the
    // whole subject, so chords stay almost invisible.
    id: 'armature',
    label: 'Armature',
    values: Object.freeze({
      numPoints: 24,
      planeAngle: degToRad(72),
      initialRadius: 420,
      radiusStep: 46,
      maxRings: 8,
      ringCount: 8,
      speed: 0.2,
      size: 4.5,
      chordAlpha: 0.05,
      trailAlpha: 0.35,
      edgeFrequency: 5200,
    }),
  }),
  Object.freeze({
    // Dense chords at low opacity: the moiré between crossing lines is the subject and the
    // particles recede to almost nothing.
    id: 'weave',
    label: 'Weave',
    values: Object.freeze({
      numPoints: 118,
      planeAngle: degToRad(8),
      initialRadius: 460,
      radiusStep: 14,
      maxRings: 18,
      ringCount: 18,
      speed: 0.35,
      size: 1,
      lineWidth: 0.5,
      chordAlpha: 0.05,
      trailAlpha: 0.06,
      edgeFrequency: 900,
    }),
  }),
  Object.freeze({
    // Long trails and a fast phase: individual particles stop reading and the frame becomes
    // a smeared long exposure.
    id: 'exposure',
    label: 'Exposure',
    values: Object.freeze({
      numPoints: 60,
      planeAngle: degToRad(30),
      initialRadius: 330,
      radiusStep: 22,
      maxRings: 14,
      ringCount: 14,
      speed: 1.7,
      size: 2,
      chordAlpha: 0,
      trailAlpha: 0.03,
      edgeFrequency: 2400,
    }),
  }),
]);

/** Config keys whose change requires the ring set to be rebuilt from scratch. */
export const REBUILD_KEYS = Object.freeze([
  'geometry',
  'spawnMode',
  'numPoints',
  'initialRadius',
  'radiusStep',
  'minRadius',
  'ringCount',
]);

/**
 * @returns {Record<string, unknown>} A fresh mutable copy of the defaults.
 */
export function createConfig(overrides = {}) {
  return { ...DEFAULTS, ...overrides };
}

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * @param {ControlSpec} spec
 * @param {RangeMode} [mode='safe']
 * @returns {{min: number, max: number, step: number}}
 */
export function rangeBounds(spec, mode = 'safe') {
  if (spec.type !== 'range') {
    throw new Error(`Control "${spec.id}" is not a range.`);
  }
  return {
    min: spec.min,
    max: mode === 'experimental' ? (spec.experimentalMax ?? spec.max) : spec.max,
    step: spec.step,
  };
}

/**
 * Snap a value to the control's step grid, anchored at `min`, then clamp to range.
 * Guards against floating-point dust (e.g. 0.30000000000000004) by rounding to the
 * step's own decimal precision.
 *
 * @param {ControlSpec} spec
 * @param {number} value Display units.
 * @param {RangeMode} [mode='safe']
 * @returns {number} Display units.
 */
export function snapToStep(spec, value, mode = 'safe') {
  if (spec.type !== 'range') return value;
  const { min, max, step } = rangeBounds(spec, mode);
  const steps = Math.round((clamp(value, min, max) - min) / step);
  const snapped = min + steps * step;
  const decimals = decimalsOf(step);
  return clamp(Number(snapped.toFixed(decimals)), min, max);
}

/**
 * @param {number} step
 * @returns {number} Number of decimal places in `step`.
 */
function decimalsOf(step) {
  const text = String(step);
  const dot = text.indexOf('.');
  return dot === -1 ? 0 : text.length - dot - 1;
}

/**
 * Convert a display-unit value into the internal representation stored in config.
 * @param {ControlSpec} spec
 * @param {number|string|boolean} displayValue
 * @param {RangeMode} [mode='safe']
 * @returns {number|string|boolean}
 */
export function toInternal(spec, displayValue, mode = 'safe') {
  if (spec.type === 'color' || spec.type === 'select') return displayValue;
  if (spec.type === 'checkbox') return Boolean(displayValue);
  const snapped = snapToStep(spec, Number(displayValue), mode);
  return spec.toInternal ? spec.toInternal(snapped) : snapped;
}

/**
 * Convert an internal config value back into display units.
 * @param {ControlSpec} spec
 * @param {number|string|boolean} internalValue
 * @param {RangeMode} [mode='safe']
 * @returns {number|string|boolean}
 */
export function toDisplay(spec, internalValue, mode = 'safe') {
  if (spec.type === 'color' || spec.type === 'select') return internalValue;
  if (spec.type === 'checkbox') return Boolean(internalValue);
  const raw = spec.toDisplay ? spec.toDisplay(Number(internalValue)) : Number(internalValue);
  return snapToStep(spec, raw, mode);
}

/**
 * Format a control's current value for its badge.
 * @param {ControlSpec} spec
 * @param {number|string|boolean} internalValue
 * @param {RangeMode} [mode='safe']
 * @returns {string}
 */
export function formatValue(spec, internalValue, mode = 'safe') {
  if (spec.type === 'color') return String(internalValue).toUpperCase();
  if (spec.type === 'checkbox') return internalValue ? 'on' : 'off';
  if (spec.type === 'select') {
    const option = spec.options?.find((o) => o.value === internalValue);
    return option ? option.label : String(internalValue);
  }
  const display = Number(toDisplay(spec, internalValue, mode));
  return `${display.toFixed(spec.precision ?? 1)}${spec.unit ?? ''}`;
}

/**
 * Pick a random value for a control, respecting its step grid.
 * @param {ControlSpec} spec
 * @param {() => number} [rng] Injectable for deterministic tests.
 * @param {RangeMode} [mode='safe']
 * @returns {number|string|boolean}
 */
export function randomValue(spec, rng = Math.random, mode = 'safe') {
  if (spec.type === 'color') {
    const hex = Math.floor(rng() * 0xffffff)
      .toString(16)
      .padStart(6, '0');
    return `#${hex}`;
  }
  if (spec.type === 'select') {
    const options = spec.options ?? [];
    return options[Math.floor(rng() * options.length)].value;
  }
  if (spec.type === 'checkbox') return rng() < 0.5;
  const { min, max } = rangeBounds(spec, mode);
  return snapToStep(spec, min + rng() * (max - min), mode);
}

/**
 * Assert the spec is internally consistent and, when a document is supplied, that every
 * control id resolves to a real element.
 *
 * @param {Document} [doc] Omit to run the document-free checks only.
 * @param {ReadonlyArray<ControlSpec>} [specs] Overridable so tests can prove each check
 *   actually fires; production callers always validate the real `CONTROLS`.
 * @returns {string[]} Problems found; empty means valid.
 */
export function validateControls(doc, specs = CONTROLS) {
  const problems = [];
  const seenIds = new Set();
  const sectionIds = new Set(SECTIONS.map((section) => section.id));

  for (const spec of specs) {
    if (seenIds.has(spec.id)) problems.push(`duplicate control id: ${spec.id}`);
    seenIds.add(spec.id);

    if (!(spec.key in DEFAULTS)) {
      problems.push(`control "${spec.id}" targets unknown config key "${spec.key}"`);
    }
    if (!sectionIds.has(spec.section)) {
      problems.push(`control "${spec.id}" is in unknown section "${spec.section}"`);
    }
    if (spec.type === 'range') {
      for (const field of ['min', 'max', 'step', 'experimentalMax']) {
        if (typeof spec[field] !== 'number') {
          problems.push(`range control "${spec.id}" is missing "${field}"`);
        }
      }
      if (typeof spec.min === 'number' && typeof spec.max === 'number' && spec.min >= spec.max) {
        problems.push(`range control "${spec.id}" has min >= max`);
      }
      if (
        typeof spec.min === 'number' &&
        typeof spec.experimentalMax === 'number' &&
        spec.min >= spec.experimentalMax
      ) {
        problems.push(`range control "${spec.id}" has min >= experimentalMax`);
      }
      if (
        typeof spec.max === 'number' &&
        typeof spec.experimentalMax === 'number' &&
        spec.max > spec.experimentalMax
      ) {
        problems.push(`range control "${spec.id}" has max > experimentalMax`);
      }
    }
    if (spec.type === 'select' && !spec.options?.length) {
      problems.push(`select control "${spec.id}" has no options`);
    }
    if (doc && !doc.getElementById(spec.id)) {
      problems.push(`control "${spec.id}" has no matching element in the document`);
    }
  }

  return problems;
}

/**
 * Assert every preset only names keys the scene understands, and that its values survive the
 * control pipeline unchanged — a preset outside a control's own range would be silently
 * clamped on apply, which makes the preset a lie.
 *
 * @returns {string[]} Problems found; empty means valid.
 */
export function validatePresets() {
  const problems = [];
  const seenIds = new Set();

  for (const preset of PRESETS) {
    if (seenIds.has(preset.id)) problems.push(`duplicate preset id: ${preset.id}`);
    seenIds.add(preset.id);

    for (const [key, value] of Object.entries(preset.values)) {
      if (!(key in DEFAULTS)) {
        problems.push(`preset "${preset.id}" sets unknown config key "${key}"`);
        continue;
      }
      const spec = CONTROLS.find((candidate) => candidate.key === key);
      if (!spec || spec.type !== 'range') continue;
      // Round-trip through the safe profile: anything that moves is out of range.
      const round = toInternal(spec, toDisplay(spec, value, 'safe'), 'safe');
      if (Math.abs(Number(round) - Number(value)) > 1e-9) {
        problems.push(
          `preset "${preset.id}" value for "${key}" (${value}) is outside the safe range ` +
            `and would be clamped to ${round}`
        );
      }
    }
  }

  return problems;
}
