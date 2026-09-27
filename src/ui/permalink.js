import { CONTROLS, RANGE_MODES, toDisplay, toInternal } from '../core/config.js';

/**
 * Configuration serialisation, for permalinks and for session persistence.
 *
 * Two properties matter here and both fall out of reusing `CONTROLS` as the schema:
 *
 *  1. **No new wire format.** Values are written in *display* units through `toDisplay`, which
 *     is what a slider shows, so a hash is readable and hand-editable.
 *  2. **Hostile input cannot produce an invalid scene.** Every value comes back through
 *     `toInternal`, which already snaps to the control's step grid and clamps to its range
 *     (`core/config.js`). A stale, truncated or hand-mangled hash therefore degrades to a
 *     valid scene rather than a broken one, and unknown keys are dropped outright.
 *
 * The format is `URLSearchParams`, so it is order-independent and forward-compatible: adding
 * or renaming a control does not invalidate previously shared links, it just drops the key.
 */

export const CONFIG_STORAGE_KEY = 'orbital-canvas:config';

/** Non-control keys carried alongside the control values. */
const VIEW_VALUES = ['2d', '3d'];
const SPAWN_VALUES = ['generative', 'static'];

/**
 * @typedef {object} Meta
 * @property {'2d'|'3d'} [view]
 * @property {'generative'|'static'} [spawnMode]
 * @property {import('../core/config.js').RangeMode} [rangeMode]
 */

/**
 * Serialise a configuration to a `URLSearchParams` string.
 *
 * @param {Readonly<Record<string, unknown>>} config Internal units.
 * @param {Meta} [meta]
 * @returns {string}
 */
export function encodeConfig(config, meta = {}) {
  const mode = RANGE_MODES.includes(meta.rangeMode) ? meta.rangeMode : 'safe';
  const params = new URLSearchParams();

  // Written first so a human reading the hash sees the profile before the values it governs.
  params.set('range', mode);
  if (VIEW_VALUES.includes(meta.view)) params.set('view', meta.view);
  if (SPAWN_VALUES.includes(meta.spawnMode)) params.set('spawn', meta.spawnMode);

  for (const spec of CONTROLS) {
    if (!(spec.key in config)) continue;
    const value = config[spec.key];
    if (spec.type === 'checkbox') params.set(spec.key, value ? '1' : '0');
    else params.set(spec.key, String(toDisplay(spec, value, mode)));
  }

  return params.toString();
}

/**
 * Parse a serialised configuration. Never throws: anything unparseable yields empty results.
 *
 * @param {string} text A `URLSearchParams` string, with or without a leading `#` or `?`.
 * @returns {{values: Record<string, unknown>, meta: Meta}} `values` in internal units.
 */
export function decodeConfig(text) {
  /** @type {Record<string, unknown>} */
  const values = {};
  /** @type {Meta} */
  const meta = {};

  if (typeof text !== 'string' || !text) return { values, meta };

  let params;
  try {
    params = new URLSearchParams(text.replace(/^[#?]+/, ''));
  } catch {
    return { values, meta };
  }

  const range = params.get('range');
  if (RANGE_MODES.includes(range)) meta.rangeMode = range;
  const mode = meta.rangeMode ?? 'safe';

  const view = params.get('view');
  if (VIEW_VALUES.includes(view)) meta.view = view;

  const spawn = params.get('spawn');
  if (SPAWN_VALUES.includes(spawn)) meta.spawnMode = spawn;

  for (const spec of CONTROLS) {
    if (!params.has(spec.key)) continue;
    const raw = params.get(spec.key);

    if (spec.type === 'checkbox') {
      values[spec.key] = raw === '1';
      continue;
    }
    if (spec.type === 'select') {
      // An unknown option would put the scene in a state no control can represent.
      if (spec.options?.some((option) => option.value === raw)) values[spec.key] = raw;
      continue;
    }
    if (spec.type === 'color') {
      if (raw === 'auto' || /^#[0-9a-f]{6}$/i.test(raw)) values[spec.key] = raw.toLowerCase();
      continue;
    }
    // Range. `toInternal` snaps and clamps, but it cannot rescue a non-number.
    const numeric = Number(raw);
    if (Number.isFinite(numeric)) values[spec.key] = toInternal(spec, numeric, mode);
  }

  return { values, meta };
}

/**
 * Read the persisted configuration. Storage can be unavailable (private mode, blocked
 * cookies), so this is best-effort in the same way as `ui/theme.js`.
 *
 * @returns {{values: Record<string, unknown>, meta: Meta}}
 */
function loadStoredConfig() {
  try {
    return decodeConfig(localStorage.getItem(CONFIG_STORAGE_KEY) ?? '');
  } catch {
    return { values: {}, meta: {} };
  }
}

/**
 * @param {Readonly<Record<string, unknown>>} config
 * @param {Meta} [meta]
 */
export function storeConfig(config, meta) {
  try {
    localStorage.setItem(CONFIG_STORAGE_KEY, encodeConfig(config, meta));
  } catch {
    // Persisting is best-effort; the session still works.
  }
}

/**
 * Resolve the configuration to boot with.
 *
 * The URL hash wins, then the stored session, then nothing (leaving `DEFAULTS` in place).
 *
 * @param {Location} location
 * @returns {{values: Record<string, unknown>, meta: Meta}}
 */
export function initialConfig(location) {
  const fromHash = decodeConfig(location.hash ?? '');
  if (Object.keys(fromHash.values).length || Object.keys(fromHash.meta).length) {
    return fromHash;
  }
  return loadStoredConfig();
}
