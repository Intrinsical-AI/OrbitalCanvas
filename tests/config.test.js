import { describe, expect, it } from 'vitest';
import {
  clamp,
  CONTROLS,
  DEFAULTS,
  formatValue,
  PRESETS,
  presetValues,
  varyValues,
  RANGE_MODES,
  rangeBounds,
  SECTIONS,
  snapToStep,
  toDisplay,
  toInternal,
} from '../src/core/config.js';
import { validateControls, validatePresets } from './spec-checks.js';

describe('control specification', () => {
  it('is internally consistent', () => {
    expect(validateControls()).toEqual([]);
  });

  it('reports every problem it finds, not just the first', () => {
    const bad = CONTROLS.map((spec) => ({ ...spec, key: `${spec.key}Missing` }));
    const problems = validateControls(bad);
    expect(problems).toHaveLength(CONTROLS.length);
    for (const problem of problems) {
      expect(problem).toMatch(/targets unknown config key/);
    }
  });

  it('targets only real config keys', () => {
    for (const spec of CONTROLS) {
      expect(DEFAULTS).toHaveProperty(spec.key);
    }
  });

  it('has unique ids and unique keys', () => {
    expect(new Set(CONTROLS.map((c) => c.id)).size).toBe(CONTROLS.length);
    expect(new Set(CONTROLS.map((c) => c.key)).size).toBe(CONTROLS.length);
  });

  it('keeps every default inside its own control range', () => {
    for (const spec of CONTROLS.filter((c) => c.type === 'range')) {
      const display = Number(toDisplay(spec, DEFAULTS[spec.key]));
      expect(display).toBeGreaterThanOrEqual(spec.min);
      expect(display).toBeLessThanOrEqual(spec.max);
    }
  });

  it('assigns every control to a declared section', () => {
    const ids = new Set(SECTIONS.map((section) => section.id));
    for (const spec of CONTROLS) {
      expect(ids, `${spec.id} is in section "${spec.section}"`).toContain(spec.section);
    }
  });

  it('rejects a control in an unknown section', () => {
    // Guards the guard: the section check has to actually fire, or a typo'd section id would
    // silently drop the control out of the drawer entirely.
    const bad = { ...CONTROLS[0], section: 'nowhere' };
    const problems = validateControls([bad]);
    expect(problems).toContainEqual(expect.stringMatching(/unknown section "nowhere"/));
  });

  it('leaves no section empty', () => {
    for (const section of SECTIONS) {
      const members = CONTROLS.filter((spec) => spec.section === section.id);
      expect(members.length, `section "${section.id}" has no controls`).toBeGreaterThan(0);
    }
  });

  it('has unique section ids', () => {
    expect(new Set(SECTIONS.map((s) => s.id)).size).toBe(SECTIONS.length);
  });
});

describe('presets', () => {
  it('are internally consistent', () => {
    expect(validatePresets()).toEqual([]);
  });

  it('name only real config keys', () => {
    for (const preset of PRESETS) {
      for (const key of Object.keys(preset.values)) {
        expect(DEFAULTS, `preset "${preset.id}"`).toHaveProperty(key);
      }
    }
  });

  it('have unique ids and a default entry that carries no values', () => {
    expect(new Set(PRESETS.map((p) => p.id)).size).toBe(PRESETS.length);
    const fallback = PRESETS.find((p) => p.id === 'default');
    expect(fallback).toBeDefined();
    expect(Object.keys(fallback.values)).toHaveLength(0);
  });

  it('survive the control pipeline unchanged', () => {
    // A preset value outside its control's safe range would be silently clamped on apply,
    // which would make the preset a lie about the scene it produces.
    for (const preset of PRESETS) {
      for (const [key, value] of Object.entries(preset.values)) {
        const spec = CONTROLS.find((candidate) => candidate.key === key);
        if (!spec || spec.type !== 'range') continue;
        const round = toInternal(spec, toDisplay(spec, value, 'safe'), 'safe');
        expect(round, `preset "${preset.id}" key "${key}"`).toBeCloseTo(Number(value), 10);
      }
    }
  });

  it('produce the same controls whatever was applied before', () => {
    // Applying Weave and then Armature used to keep Weave's lineWidth, which Armature omits.
    const byId = (id) => PRESETS.find((p) => p.id === id);
    const fromDefaults = { ...DEFAULTS, ...presetValues(byId('armature')) };
    const afterWeave = {
      ...DEFAULTS,
      ...presetValues(byId('weave')),
      ...presetValues(byId('armature')),
    };
    expect(afterWeave).toEqual(fromDefaults);
    expect(fromDefaults.lineWidth).toBe(DEFAULTS.lineWidth);
  });

  it('cover every scene control while leaving the camera outside presets', () => {
    const keys = Object.keys(presetValues(PRESETS[0]));
    expect(keys.sort()).toEqual(CONTROLS.map((spec) => spec.key).sort());
    expect(presetValues(PRESETS.find((p) => p.id === 'default'))).not.toHaveProperty('autoOrbit');
  });

  it('each produce a configuration distinct from the defaults', () => {
    for (const preset of PRESETS.filter((p) => p.id !== 'default')) {
      const differs = Object.entries(preset.values).some(([key, value]) => DEFAULTS[key] !== value);
      expect(differs, `preset "${preset.id}" is identical to the defaults`).toBe(true);
    }
  });
});

describe('DEFAULTS', () => {
  it('is frozen', () => {
    expect(Object.isFrozen(DEFAULTS)).toBe(true);
  });
});

describe('unit conversion', () => {
  it('round-trips every control: toDisplay(toInternal(v)) === v', () => {
    for (const spec of CONTROLS.filter((c) => c.type === 'range')) {
      for (const t of [0, 0.25, 0.5, 0.75, 1]) {
        const display = snapToStep(spec, spec.min + t * (spec.max - spec.min));
        expect(toDisplay(spec, toInternal(spec, display))).toBeCloseTo(display, 6);
      }
    }
  });

  it('converts the tilt control between degrees and radians', () => {
    const spec = CONTROLS.find((c) => c.key === 'planeAngle');
    expect(toInternal(spec, 180)).toBeCloseTo((120 * Math.PI) / 180, 12);
    expect(toInternal(spec, 180, 'experimental')).toBeCloseTo(Math.PI, 12);
    expect(toDisplay(spec, Math.PI / 2)).toBeCloseTo(90, 9);
  });

  it('exposes wider experimental bounds without changing Safe defaults', () => {
    expect(RANGE_MODES).toEqual(['safe', 'experimental']);
    const points = CONTROLS.find((c) => c.key === 'numPoints');
    expect(rangeBounds(points, 'safe').max).toBe(128);
    expect(rangeBounds(points, 'experimental').max).toBe(240);
    expect(DEFAULTS.numPoints).toBeLessThanOrEqual(rangeBounds(points, 'safe').max);
  });

  it('stores speed with no hidden scale factor', () => {
    // The old code showed "5" on the badge while writing 0.5 into the config.
    const spec = CONTROLS.find((c) => c.key === 'speed');
    expect(toInternal(spec, 1.5)).toBe(1.5);
    expect(toDisplay(spec, 1.5)).toBe(1.5);
  });

  it('passes colours and select values through untouched', () => {
    const color = CONTROLS.find((c) => c.type === 'color');
    expect(toInternal(color, '#12ab34')).toBe('#12ab34');
    const select = CONTROLS.find((c) => c.type === 'select');
    expect(toInternal(select, 'disc')).toBe('disc');
  });

  it('coerces checkbox values to booleans', () => {
    const spec = CONTROLS.find((c) => c.type === 'checkbox');
    expect(toInternal(spec, 'on')).toBe(true);
    expect(toInternal(spec, false)).toBe(false);
  });
});

describe('clamp and snapToStep', () => {
  it('clamps to the given bounds', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
  });

  it('snaps to the step grid and clamps out-of-range values', () => {
    const spec = { type: 'range', min: 0, max: 10, step: 0.5 };
    expect(snapToStep(spec, 3.26)).toBe(3.5);
    expect(snapToStep(spec, 3.24)).toBe(3);
    expect(snapToStep(spec, -20)).toBe(0);
    expect(snapToStep(spec, 200)).toBe(10);
  });

  it('does not leave floating-point dust behind', () => {
    const spec = { type: 'range', min: 0.02, max: 1, step: 0.01 };
    for (let i = 0; i < 90; i++) {
      const value = snapToStep(spec, 0.02 + i * 0.01);
      expect(String(value)).not.toMatch(/\d{6,}/);
    }
  });

  it('handles a min that is not a multiple of the step', () => {
    const spec = { type: 'range', min: 0.2, max: 10, step: 0.1 };
    expect(snapToStep(spec, 0.2)).toBe(0.2);
    expect(snapToStep(spec, 0.24)).toBe(0.2);
    expect(snapToStep(spec, 0.26)).toBe(0.3);
  });

  it('leaves non-range controls alone', () => {
    expect(snapToStep({ type: 'color' }, '#fff')).toBe('#fff');
  });
});

describe('formatValue', () => {
  it('applies the declared unit and precision', () => {
    const tilt = CONTROLS.find((c) => c.key === 'planeAngle');
    expect(formatValue(tilt, Math.PI / 12)).toBe('15°');

    const speed = CONTROLS.find((c) => c.key === 'speed');
    expect(formatValue(speed, 0.5)).toBe('0.50 rad/s');

    const interval = CONTROLS.find((c) => c.key === 'circleInterval');
    expect(formatValue(interval, 5)).toBe('5.0 s');
  });

  it('renders colours, checkboxes and selects readably', () => {
    expect(
      formatValue(
        CONTROLS.find((c) => c.type === 'color'),
        'auto'
      )
    ).toBe('Auto');
    expect(
      formatValue(
        CONTROLS.find((c) => c.type === 'color'),
        '#ff0000'
      )
    ).toBe('#FF0000');
    expect(
      formatValue(
        CONTROLS.find((c) => c.key === 'glow'),
        true
      )
    ).toBe('on');
    expect(
      formatValue(
        CONTROLS.find((c) => c.key === 'shape'),
        'disc'
      )
    ).toBe('Disc');
  });
});

describe('bounded variations', () => {
  it.each(['safe', 'experimental'])(
    'keeps numeric values inside %s and leaves other controls alone',
    (mode) => {
      for (const strength of [0.05, 0.15, 0.3])
        for (const r of [0, 0.37, 0.5, 0.99]) {
          const varied = { ...DEFAULTS, ...varyValues(DEFAULTS, mode, strength, () => r) };
          expect(varied.color).toBe('auto');
          expect(varied.shape).toBe(DEFAULTS.shape);
          for (const spec of CONTROLS.filter((s) => s.type === 'range')) {
            const display = toDisplay(spec, varied[spec.key], mode),
              bounds = rangeBounds(spec, mode);
            expect(display).toBeGreaterThanOrEqual(bounds.min);
            expect(display).toBeLessThanOrEqual(bounds.max);
          }
        }
    }
  );
  it('does not vary hidden lifecycle controls', () => {
    const changes = varyValues({ ...DEFAULTS, spawnMode: 'static' }, 'safe', 0.3, () => 1);
    expect(changes).not.toHaveProperty('ringSpacing');
    expect(changes).not.toHaveProperty('maxRings');
    expect(changes).toHaveProperty('ringCount');
  });
});
