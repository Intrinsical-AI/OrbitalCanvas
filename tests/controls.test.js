import { expect, it, vi } from 'vitest';
import { CONTROLS } from '../src/core/config.js';
import { Controls } from '../src/ui/controls.js';
import { defaultDocument } from '../src/ui/permalink.js';

function numericControl(key) {
  const control = Object.create(Controls.prototype);
  control.document = defaultDocument();
  control.mode = 'safe';
  control.callbacks = {
    change: vi.fn((changed, value) => {
      control.document.parameters[changed] = value;
    }),
  };
  return { control, spec: CONTROLS.find((entry) => entry.key === key) };
}

it.each([
  ['numPoints', '9999', '128', 128],
  ['numPoints', '-1', '3', 3],
  ['size', '3.26', '3.5', 3.5],
  ['planeAngle', '17.4', '17', (17 * Math.PI) / 180],
])('normalizes a committed %s field before it loses focus', (key, typed, shown, value) => {
  const { control, spec } = numericControl(key);
  const input = { value: typed };
  control.numeric(spec, input);
  expect(input.value).toBe(shown);
  expect(control.document.parameters[key]).toBeCloseTo(value, 12);
  expect(control.callbacks.change).toHaveBeenCalledWith(key, value, true);
});

it.each(['', ' ', 'NaN', 'Infinity'])(
  'restores the displayed value after an invalid numeric commit: %s',
  (typed) => {
    const { control, spec } = numericControl('numPoints');
    const input = { value: typed };
    control.numeric(spec, input);
    expect(input.value).toBe('72');
    expect(control.document.parameters.numPoints).toBe(72);
    expect(control.callbacks.change).not.toHaveBeenCalled();
  }
);

it('normalizes a no-op numeric commit without adding an edit', () => {
  const { control, spec } = numericControl('size');
  const input = { value: '3.000' };
  control.numeric(spec, input);
  expect(input.value).toBe('3');
  expect(control.callbacks.change).not.toHaveBeenCalled();
});
