import {
  CONTROLS,
  DEFAULTS,
  formatValue,
  randomValue,
  RANGE_MODES,
  rangeBounds,
  SECTIONS,
  toDisplay,
  toInternal,
  validateControls,
} from '../core/config.js';

/**
 * Spec-driven control panel.
 *
 * The inputs, their badges, reset and randomise are all generated from `CONTROLS`, so a
 * control cannot drift from the config key it edits. Range profiles are UI state only: the
 * scene continues to store one ordinary config value per control.
 */
export class Controls {
  /**
   * @param {HTMLElement} container
   * @param {object} config Live config object; read for initial values only.
   * @param {(key: string, value: unknown) => void} onChange
   * @param {object} [options]
   * @param {(changes: ReadonlyArray<readonly [string, unknown]>) => void} [options.onBatchChange]
   * @param {(mode: import('../core/config.js').RangeMode) => void} [options.onRangeModeChange]
   * @param {import('../core/config.js').RangeMode} [options.rangeMode] Initial profile. Must be
   *   set before `#build`, because the input bounds are written from it.
   */
  constructor(container, config, onChange, options = {}) {
    this.container = container;
    this.onChange = onChange;
    this.onBatchChange =
      options.onBatchChange ??
      ((changes) => changes.forEach(([key, value]) => onChange(key, value)));
    this.onRangeModeChange = options.onRangeModeChange;
    /** @type {import('../core/config.js').RangeMode} */
    this.rangeMode = RANGE_MODES.includes(options.rangeMode) ? options.rangeMode : 'safe';
    /** @type {Map<string, HTMLInputElement|HTMLSelectElement>} */
    this.inputs = new Map();
    /** @type {Map<string, HTMLElement>} */
    this.badges = new Map();
    /** @type {Map<string, HTMLElement>} */
    this.groups = new Map();
    /** Section wrapper per section id, so an entirely hidden section can hide its heading. */
    /** @type {Map<string, HTMLElement>} */
    this.sections = new Map();

    this.#build();
    this.#updateRangeMetadata();
    this.syncFromConfig(config);
    this.updateVisibility(config.spawnMode);

    const problems = validateControls(document);
    if (problems.length) {
      throw new Error(`Invalid control specification:\n  ${problems.join('\n  ')}`);
    }
  }

  #build() {
    const fragment = document.createDocumentFragment();

    // One wrapper per section, in `SECTIONS` order; specs keep their relative order within a
    // section. Reuses the existing `.group` / `.group__title` styles, so this adds no CSS.
    for (const section of SECTIONS) {
      const wrapper = document.createElement('section');
      wrapper.className = 'group';
      wrapper.dataset.section = section.id;

      const title = document.createElement('h3');
      title.className = 'group__title';
      title.textContent = section.label;
      wrapper.append(title);

      fragment.append(wrapper);
      this.sections.set(section.id, wrapper);
    }

    for (const spec of CONTROLS) {
      const group = document.createElement('div');
      group.className = 'control';
      if (spec.spawnMode) group.dataset.spawnMode = spec.spawnMode;

      const head = document.createElement('div');
      head.className = 'control__head';

      const label = document.createElement('label');
      label.setAttribute('for', spec.id);
      label.textContent = spec.label;
      head.append(label);

      const badge = document.createElement('output');
      badge.className = 'control__value';
      badge.id = `${spec.key}Value`;
      badge.setAttribute('for', spec.id);
      head.append(badge);

      const input = this.#createInput(spec);
      input.setAttribute('aria-describedby', badge.id);
      group.append(head, input);
      this.sections.get(spec.section).append(group);

      this.badges.set(spec.key, badge);
      this.groups.set(spec.key, group);
    }

    this.container.append(fragment);
  }

  /**
   * @param {import('../core/config.js').ControlSpec} spec
   * @returns {HTMLElement}
   */
  #createInput(spec) {
    let input;

    if (spec.type === 'select') {
      input = document.createElement('select');
      input.className = 'control__select';
      for (const option of spec.options) {
        const el = document.createElement('option');
        el.value = option.value;
        el.textContent = option.label;
        input.append(el);
      }
    } else {
      input = document.createElement('input');
      input.className = `control__input control__input--${spec.type}`;
      if (spec.type === 'range') {
        const bounds = rangeBounds(spec, this.rangeMode);
        input.type = 'range';
        input.min = String(bounds.min);
        input.max = String(bounds.max);
        input.step = String(bounds.step);
      } else if (spec.type === 'color') {
        input.type = 'color';
      } else {
        input.type = 'checkbox';
      }
    }

    input.id = spec.id;
    input.addEventListener('input', () => this.#handleInput(spec, input));
    this.inputs.set(spec.key, input);
    return input;
  }

  /**
   * @param {import('../core/config.js').ControlSpec} spec
   * @param {HTMLInputElement|HTMLSelectElement} input
   */
  #handleInput(spec, input) {
    const raw = spec.type === 'checkbox' ? input.checked : input.value;
    const value = toInternal(spec, raw, this.rangeMode);
    this.#writeValue(spec, value);
    this.onChange(spec.key, value);
  }

  /**
   * Push config values into the inputs and badges. Does not fire callbacks.
   * @param {object} config
   */
  syncFromConfig(config) {
    for (const spec of CONTROLS) this.#writeValue(spec, config[spec.key]);
  }

  /**
   * Change the active range profile. Values that no longer fit the narrower profile are
   * clamped and emitted together, so the scene rebuilds at most once.
   *
   * @param {import('../core/config.js').RangeMode} mode
   * @returns {boolean} True when the profile changed.
   */
  setRangeMode(mode) {
    if (!RANGE_MODES.includes(mode)) throw new Error(`Unknown range mode "${mode}".`);
    if (mode === this.rangeMode) return false;

    const previous = this.rangeMode;
    const current = new Map();
    for (const spec of CONTROLS) {
      if (spec.type === 'range') {
        current.set(spec.key, toInternal(spec, this.inputs.get(spec.key).value, previous));
      }
    }

    this.rangeMode = mode;
    this.#updateRangeMetadata();

    const changes = [];
    for (const spec of CONTROLS) {
      if (spec.type !== 'range') continue;
      const value = toInternal(spec, this.inputs.get(spec.key).value, mode);
      this.#writeValue(spec, value);
      if (value !== current.get(spec.key)) changes.push([spec.key, value]);
    }

    this.onRangeModeChange?.(mode);
    if (changes.length) this.onBatchChange(changes);
    return true;
  }

  /**
   * Show only the controls that apply to the active spawn mode.
   *
   * A section whose every control is hidden hides its own heading too — otherwise switching to
   * Static leaves a bare "Form" title with nothing under it.
   *
   * @param {'generative'|'static'} spawnMode
   */
  updateVisibility(spawnMode) {
    /** @type {Map<string, boolean>} */
    const sectionHasVisible = new Map();

    for (const spec of CONTROLS) {
      const group = this.groups.get(spec.key);
      const hidden = Boolean(spec.spawnMode) && spec.spawnMode !== spawnMode;
      group.hidden = hidden;
      sectionHasVisible.set(
        spec.section,
        (sectionHasVisible.get(spec.section) ?? false) || !hidden
      );
    }

    for (const [id, wrapper] of this.sections) {
      wrapper.hidden = !sectionHasVisible.get(id);
    }
  }

  /**
   * Restore every control to its default and return to the Safe profile. `DEFAULTS` is the
   * single source of truth here.
   *
   * `emit: false` is used by the app's full-default action so it can add the segmented scene
   * state (spawn mode and projection) to the same transaction and rebuild only once.
   *
   * @param {{emit?: boolean}} [options]
   * @returns {Array<[string, unknown]>} Changes written into the controls.
   */
  reset({ emit = true } = {}) {
    this.rangeMode = 'safe';
    this.#updateRangeMetadata();
    const changes = CONTROLS.map((spec) => [spec.key, DEFAULTS[spec.key]]);
    for (const [key, value] of changes) this.#writeValue(this.#specFor(key), value);
    this.onRangeModeChange?.('safe');
    if (emit) this.onBatchChange(changes);
    return changes;
  }

  /**
   * Apply an arbitrary set of config values — used by presets, by the permalink loader and by
   * undo. Same shape as `reset`, but with supplied values instead of `DEFAULTS`; keys the
   * control panel does not own are passed through to the scene untouched.
   *
   * @param {Readonly<Record<string, unknown>>} values Internal units.
   */
  applyValues(values) {
    const changes = [];
    for (const [key, value] of Object.entries(values)) {
      const spec = CONTROLS.find((candidate) => candidate.key === key);
      if (spec) this.#writeValue(spec, value);
      changes.push([key, value]);
    }
    if (changes.length) this.onBatchChange(changes);
  }

  /**
   * Randomise every control that opts in, respecting the active profile and each step grid.
   * @param {() => number} [rng] Injectable for deterministic tests.
   */
  randomize(rng = Math.random) {
    const changes = CONTROLS.filter((spec) => spec.randomise !== false).map((spec) => [
      spec.key,
      randomValue(spec, rng, this.rangeMode),
    ]);
    for (const [key, value] of changes) this.#writeValue(this.#specFor(key), value);
    this.onBatchChange(changes);
  }

  /**
   * @param {import('../core/config.js').ControlSpec} spec
   * @param {unknown} value Internal units.
   */
  #writeValue(spec, value) {
    const input = this.inputs.get(spec.key);
    if (spec.type === 'checkbox') input.checked = Boolean(value);
    else input.value = String(toDisplay(spec, value, this.rangeMode));

    const formatted = formatValue(spec, value, this.rangeMode);
    this.badges.get(spec.key).textContent = formatted;
    if (spec.type === 'range') {
      input.setAttribute('aria-valuetext', formatted);
      // The track is a hairline, so thumb position was the only cue for a value. `--fill`
      // drives a two-stop gradient on the track; see `.control__input--range` in styles.css.
      const { min, max } = rangeBounds(spec, this.rangeMode);
      const span = max - min;
      const fraction = span > 0 ? (Number(input.value) - min) / span : 0;
      input.style.setProperty('--fill', `${clampFraction(fraction) * 100}%`);
    }
  }

  #updateRangeMetadata() {
    for (const spec of CONTROLS) {
      if (spec.type !== 'range') continue;
      const input = this.inputs.get(spec.key);
      const bounds = rangeBounds(spec, this.rangeMode);
      input.min = String(bounds.min);
      input.max = String(bounds.max);
      input.step = String(bounds.step);
      input.setAttribute('aria-valuemin', String(bounds.min));
      input.setAttribute('aria-valuemax', String(bounds.max));
      input.setAttribute('aria-valuestep', String(bounds.step));
    }
  }

  /** @param {string} key */
  #specFor(key) {
    const spec = CONTROLS.find((candidate) => candidate.key === key);
    if (!spec) throw new Error(`Unknown control key "${key}".`);
    return spec;
  }
}

/**
 * @param {number} value
 * @returns {number} `value` clamped to 0..1, with NaN treated as 0.
 */
function clampFraction(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Wire a segmented button group: exactly one `[data-value]` child is active at a time.
 *
 * @param {HTMLElement} root Element containing the buttons.
 * @param {string} initial Initially active value.
 * @param {(value: string) => void} onSelect
 * @returns {{ select: (value: string, options?: {notify?: boolean}) => void,
 *   paint: (value: string) => void }}
 */
export function bindSegmented(root, initial, onSelect) {
  const buttons = [...root.querySelectorAll('[data-value]')];

  const paint = (value) => {
    for (const button of buttons) {
      const active = button.dataset.value === value;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    }
  };

  const select = (value, { notify = true } = {}) => {
    paint(value);
    if (notify) onSelect(value);
  };

  for (const button of buttons) {
    button.addEventListener('click', () => select(button.dataset.value));
  }

  paint(initial);
  return {
    select,
    paint,
  };
}
