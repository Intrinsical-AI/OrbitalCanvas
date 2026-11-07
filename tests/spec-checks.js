/**
 * Consistency checks over the static configuration tables. They run in the test suite only:
 * the tables are constants, so checking them at runtime would re-prove the same thing on
 * every page load.
 */
import {
  CONTROLS,
  DEFAULTS,
  PRESETS,
  SECTIONS,
  toDisplay,
  toInternal,
} from '../src/core/config.js';

/**
 * Assert the control spec is internally consistent.
 *
 * @param {ReadonlyArray<import('../src/core/config.js').ControlSpec>} [specs] Overridable so
 *   tests can prove each check actually fires.
 * @returns {string[]} Problems found; empty means valid.
 */
export function validateControls(specs = CONTROLS) {
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
      const spec = CONTROLS.find((control) => control.key === key);
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
