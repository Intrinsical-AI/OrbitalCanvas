import {
  CAMERA_DEFAULTS,
  CONTROLS,
  DEFAULTS,
  clamp,
  toDisplay,
  toInternal,
} from '../core/config.js';

export const DOCUMENT_KEY = 'orbital-canvas:document:v2';
export const PREFERENCES_KEY = 'orbital-canvas:preferences:v2';
export const CAPTURE_DEFAULTS = Object.freeze({ resolution: 'screen', duration: 6, fps: 30 });

export function defaultDocument(appearance = 'dark') {
  return {
    version: 2,
    parameters: { ...DEFAULTS },
    view: '3d',
    rangeMode: 'safe',
    camera: { ...CAMERA_DEFAULTS },
    appearance,
  };
}

function choice(value, allowed) {
  if (!allowed.includes(value)) throw new Error('Invalid document option.');
  return value;
}

export function validateDocument(input) {
  if (!input || input.version !== 2) throw new Error('Unsupported document version.');
  const doc = defaultDocument();
  doc.view = choice(input.view ?? doc.view, ['2d', '3d']);
  doc.rangeMode = choice(input.rangeMode ?? doc.rangeMode, ['safe', 'experimental']);
  doc.appearance = choice(input.appearance ?? doc.appearance, ['dark', 'light']);
  doc.parameters.spawnMode = choice(input.parameters?.spawnMode ?? DEFAULTS.spawnMode, [
    'static',
    'generative',
  ]);
  for (const spec of CONTROLS) {
    const value = input.parameters?.[spec.key] ?? DEFAULTS[spec.key];
    if (spec.type === 'range') {
      if (typeof value !== 'number' || !Number.isFinite(value))
        throw new Error('Invalid numeric parameter.');
      doc.parameters[spec.key] = toInternal(
        spec,
        spec.toDisplay ? spec.toDisplay(value) : value,
        doc.rangeMode
      );
    } else if (spec.type === 'checkbox') {
      if (typeof value !== 'boolean') throw new Error('Invalid switch.');
      doc.parameters[spec.key] = value;
    } else if (spec.type === 'select') {
      doc.parameters[spec.key] = choice(
        value,
        spec.options.map((o) => o.value)
      );
    } else {
      if (typeof value !== 'string' || (value !== 'auto' && !/^#[0-9a-f]{6}$/i.test(value)))
        throw new Error('Invalid colour.');
      doc.parameters[spec.key] = value.toLowerCase();
    }
  }
  const camera = { ...CAMERA_DEFAULTS, ...input.camera };
  for (const key of ['yaw', 'pitch', 'zoom']) {
    if (typeof camera[key] !== 'number' || !Number.isFinite(camera[key]))
      throw new Error('Invalid camera.');
  }
  if (typeof camera.autoOrbit !== 'boolean') throw new Error('Invalid camera motion.');
  if (camera.yaw < -Math.PI || camera.yaw >= Math.PI)
    camera.yaw =
      ((((camera.yaw + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
  camera.pitch = clamp(camera.pitch, (-89 * Math.PI) / 180, (89 * Math.PI) / 180);
  camera.zoom = clamp(camera.zoom, 0.25, 3);
  doc.camera = camera;
  return doc;
}

export function encodeDocument(input) {
  const doc = validateDocument(input);
  const params = new URLSearchParams({
    v: '2',
    view: doc.view,
    range: doc.rangeMode,
    appearance: doc.appearance,
    spawn: doc.parameters.spawnMode,
  });
  for (const spec of CONTROLS) {
    const value = doc.parameters[spec.key];
    params.set(
      spec.key,
      spec.type === 'checkbox' ? (value ? '1' : '0') : String(toDisplay(spec, value, doc.rangeMode))
    );
  }
  params.set('yaw', String((doc.camera.yaw * 180) / Math.PI));
  params.set('pitch', String((doc.camera.pitch * 180) / Math.PI));
  params.set('zoom', String(doc.camera.zoom));
  params.set('orbit', doc.camera.autoOrbit ? '1' : '0');
  return params.toString();
}

export function decodeDocument(text) {
  const params = new URLSearchParams(text.replace(/^#/, ''));
  if (params.get('v') !== '2') throw new Error('This link uses an unsupported document version.');
  const input = { version: 2, parameters: {}, camera: {} };
  for (const [name, key] of [
    ['view', 'view'],
    ['range', 'rangeMode'],
    ['appearance', 'appearance'],
  ]) {
    if (params.has(name)) input[key] = params.get(name);
  }
  if (params.has('spawn')) input.parameters.spawnMode = params.get('spawn');
  for (const spec of CONTROLS) {
    if (!params.has(spec.key)) continue;
    const value = params.get(spec.key);
    if (spec.type === 'range') {
      if (value.trim() === '' || !Number.isFinite(Number(value)))
        throw new Error('Invalid numeric parameter.');
      input.parameters[spec.key] = spec.toInternal ? spec.toInternal(Number(value)) : Number(value);
    } else if (spec.type === 'checkbox') {
      choice(value, ['0', '1']);
      input.parameters[spec.key] = value === '1';
    } else input.parameters[spec.key] = value;
  }
  for (const key of ['yaw', 'pitch', 'zoom']) {
    if (!params.has(key)) continue;
    const raw = params.get(key);
    if (!raw.trim() || !Number.isFinite(Number(raw))) throw new Error('Invalid camera.');
    input.camera[key] = Number(raw) * (key === 'zoom' ? 1 : Math.PI / 180);
  }
  if (params.has('orbit')) input.camera.autoOrbit = choice(params.get('orbit'), ['0', '1']) === '1';
  return validateDocument(input);
}

export function initialDocument(location, storage, appearance) {
  if (location.hash) {
    try {
      return { document: decodeDocument(location.hash), error: '' };
    } catch (error) {
      return { document: defaultDocument(appearance), error: error.message };
    }
  }
  try {
    const stored = storage.getItem(DOCUMENT_KEY);
    if (stored) return { document: validateDocument(JSON.parse(stored)), error: '' };
  } catch {
    /* An unavailable or invalid stored document uses fresh defaults. */
  }
  return { document: defaultDocument(appearance), error: '' };
}

export function storeDocument(document, storage) {
  try {
    storage ??= localStorage;
    storage.setItem(DOCUMENT_KEY, JSON.stringify(validateDocument(document)));
    return true;
  } catch {
    return false;
  }
}

export function readPreferences(storage) {
  let saved;
  try {
    storage ??= localStorage;
    saved = JSON.parse(storage.getItem(PREFERENCES_KEY) ?? '{}');
  } catch {
    saved = {};
  }
  if (!saved || typeof saved !== 'object') saved = {};
  return {
    shortcuts: saved.shortcuts !== false,
    diagnostics: saved.diagnostics === true,
    groups: saved.groups && typeof saved.groups === 'object' ? saved.groups : {},
    capture: {
      resolution: ['screen', 'landscape', 'square', 'portrait'].includes(saved.capture?.resolution)
        ? saved.capture.resolution
        : 'screen',
      duration: Number.isInteger(saved.capture?.duration)
        ? clamp(saved.capture.duration, 1, 120)
        : 6,
      fps: [24, 30, 60, 120].includes(saved.capture?.fps) ? saved.capture.fps : 30,
    },
  };
}

export function storePreferences(preferences) {
  try {
    localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
    return true;
  } catch {
    return false;
  }
}
