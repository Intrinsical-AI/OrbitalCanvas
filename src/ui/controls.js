import {
  CONTROLS,
  DEFAULTS,
  SECTIONS,
  formatValue,
  rangeBounds,
  toDisplay,
  toInternal,
} from '../core/config.js';

const ESSENTIAL = ['numPoints', 'planeAngle', 'speed', 'size', 'chordAlpha', 'trailHalfLife'];
const ADJUST_KEYS = [
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
  'PageUp',
  'PageDown',
];

export class Controls {
  constructor(container, callbacks, groups = {}) {
    this.container = container;
    this.callbacks = callbacks;
    this.listeners = new AbortController();
    this.rows = new Map();
    this.inputs = new Map();
    this.values = new Map();
    this.build(groups);
  }
  on(element, name, handler) {
    element.addEventListener(name, handler, { signal: this.listeners.signal });
  }
  build(groups) {
    const basic = document.createElement('section');
    basic.className = 'essentials';
    const sections = new Map();
    this.container.append(basic);
    for (const section of SECTIONS) {
      const details = document.createElement('details');
      details.className = 'control-group';
      details.open = groups[section.id] === true;
      const summary = document.createElement('summary');
      summary.textContent = section.label + ' · Advanced';
      const reset = document.createElement('button');
      reset.type = 'button';
      reset.textContent = 'Reset group';
      this.on(reset, 'click', () => this.callbacks.resetGroup(section.id));
      details.append(summary, reset);
      this.on(details, 'toggle', () => this.callbacks.group(section.id, details.open));
      sections.set(section.id, details);
      this.container.append(details);
    }
    const ordered = [
      ...ESSENTIAL.map((key) => CONTROLS.find((s) => s.key === key)),
      ...CONTROLS.filter((s) => !ESSENTIAL.includes(s.key)),
    ];
    for (const spec of ordered) {
      const row = document.createElement('div');
      row.className = 'control';
      const head = document.createElement('div');
      head.className = 'control__head';
      const label = document.createElement('label');
      label.htmlFor = spec.id;
      label.textContent = spec.label;
      const reset = document.createElement('button');
      reset.type = 'button';
      reset.className = 'control__reset';
      reset.textContent = '↺';
      reset.setAttribute('aria-label', 'Reset ' + spec.label);
      this.on(reset, 'click', () => this.callbacks.change(spec.key, DEFAULTS[spec.key], true));
      head.append(label);
      row.append(head);
      let input;
      if (spec.type === 'range') {
        const numeric = document.createElement('input');
        numeric.type = 'number';
        numeric.className = 'control__value';
        numeric.setAttribute('aria-label', spec.label + ' value');
        this.on(numeric, 'change', () => this.numeric(spec, numeric));
        this.on(numeric, 'keydown', (event) => {
          if (event.key === 'Enter') {
            this.numeric(spec, numeric);
            numeric.blur();
            input.focus();
          }
        });
        const unit = document.createElement('span');
        unit.className = 'control__unit';
        unit.textContent = spec.unit?.trim() ?? '';
        unit.setAttribute('aria-hidden', 'true');
        head.append(numeric, unit, reset);
        this.values.set(spec.key, numeric);
        input = document.createElement('input');
        input.type = 'range';
        this.on(input, 'pointerdown', () => this.callbacks.begin(spec.label));
        this.on(input, 'pointercancel', () => this.callbacks.cancel());
        let keyboard = false;
        this.on(input, 'keydown', (event) => {
          if (ADJUST_KEYS.includes(event.key)) {
            keyboard = true;
            this.callbacks.begin(spec.label);
          }
        });
        this.on(input, 'keyup', (event) => {
          if (ADJUST_KEYS.includes(event.key)) {
            keyboard = false;
            this.callbacks.commit();
          }
        });
        this.on(input, 'input', () =>
          this.callbacks.change(spec.key, toInternal(spec, input.value, this.mode))
        );
        this.on(input, 'change', () => {
          if (!keyboard) this.callbacks.commit();
        });
        this.on(input, 'blur', () => {
          keyboard = false;
          this.callbacks.commit();
        });
        this.on(input, 'dblclick', () => this.callbacks.change(spec.key, DEFAULTS[spec.key], true));
      } else if (spec.type === 'select') {
        input = document.createElement('div');
        input.className = 'segmented';
        input.setAttribute('role', 'group');
        input.setAttribute('aria-label', spec.label);
        for (const option of spec.options) {
          const button = document.createElement('button');
          button.type = 'button';
          button.dataset.value = option.value;
          button.textContent = option.label;
          this.on(button, 'click', () => this.callbacks.change(spec.key, option.value, true));
          input.append(button);
        }
        head.append(reset);
      } else {
        input = document.createElement('input');
        input.type = spec.type;
        if (spec.type === 'checkbox') {
          this.on(input, 'change', () => this.callbacks.change(spec.key, input.checked, true));
          head.append(input, reset);
        } else {
          this.on(input, 'input', () => this.callbacks.change(spec.key, input.value));
          this.on(input, 'change', () => this.callbacks.commit());
          const auto = document.createElement('button');
          auto.type = 'button';
          auto.textContent = 'Auto';
          auto.dataset.autoColor = '';
          this.on(auto, 'click', () => this.callbacks.change(spec.key, 'auto', true));
          head.append(auto, reset);
        }
      }
      input.id = spec.id;
      if (spec.type !== 'checkbox') row.append(input);
      if (spec.key === 'glow') {
        const note = document.createElement('p');
        note.className = 'note';
        note.textContent = 'Glow can reduce frame rate.';
        row.append(note);
      }
      (ESSENTIAL.includes(spec.key) ? basic : sections.get(spec.section)).append(row);
      this.rows.set(spec.key, row);
      this.inputs.set(spec.key, input);
    }
  }
  numeric(spec, input) {
    if (!input.value.trim() || !Number.isFinite(Number(input.value))) {
      this.sync(this.document);
      return;
    }
    this.callbacks.change(spec.key, toInternal(spec, input.value, this.mode), true);
  }
  sync(doc) {
    this.document = doc;
    this.mode = doc.rangeMode;
    for (const spec of CONTROLS) {
      const value = doc.parameters[spec.key];
      const row = this.rows.get(spec.key),
        input = this.inputs.get(spec.key);
      row.hidden = Boolean(spec.spawnMode && spec.spawnMode !== doc.parameters.spawnMode);
      const disabled =
        ['lineWidth', 'chromaticChords', 'edgeFrequency'].includes(spec.key) &&
        doc.parameters.chordAlpha === 0;
      if (spec.type === 'range') {
        const bounds = rangeBounds(spec, this.mode);
        for (const field of [input, this.values.get(spec.key)]) {
          Object.assign(field, bounds);
          if (document.activeElement !== field || field === input)
            field.value = String(toDisplay(spec, value, this.mode));
        }
        input.setAttribute('aria-valuetext', formatValue(spec, value, this.mode));
        input.disabled = disabled;
        this.values.get(spec.key).disabled = disabled;
      } else if (spec.type === 'select') {
        for (const button of input.children)
          button.setAttribute('aria-pressed', String(button.dataset.value === value));
      } else if (spec.type === 'checkbox') {
        input.checked = value;
        input.disabled = disabled;
      } else {
        input.value =
          value === 'auto' ? (doc.appearance === 'light' ? '#000000' : '#ffffff') : value;
        row
          .querySelector('[data-auto-color]')
          .setAttribute('aria-pressed', String(value === 'auto'));
      }
    }
  }
  destroy() {
    this.listeners.abort();
    this.container.replaceChildren();
  }
}
