import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONTROLS, DEFAULTS, rangeBounds } from '../src/core/config.js';
import {
  CONFIG_STORAGE_KEY,
  decodeConfig,
  encodeConfig,
  initialConfig,
  storeConfig,
} from '../src/ui/permalink.js';

afterEach(() => vi.unstubAllGlobals());

describe('encodeConfig / decodeConfig', () => {
  it('round-trips every control key', () => {
    const config = { ...DEFAULTS };
    const { values } = decodeConfig(encodeConfig(config));

    for (const spec of CONTROLS) {
      expect(values, `missing ${spec.key}`).toHaveProperty(spec.key);
      expect(values[spec.key], `mismatch on ${spec.key}`).toEqual(config[spec.key]);
    }
  });

  it('round-trips a non-default configuration', () => {
    const config = {
      ...DEFAULTS,
      numPoints: 96,
      speed: 1.25,
      size: 4.5,
      color: '#3fa9c2',
      shape: 'disc',
      glow: true,
      chromaticChords: false,
    };
    const { values } = decodeConfig(encodeConfig(config));

    expect(values.numPoints).toBe(96);
    expect(values.speed).toBeCloseTo(1.25, 10);
    expect(values.size).toBe(4.5);
    expect(values.color).toBe('#3fa9c2');
    expect(values.shape).toBe('disc');
    expect(values.glow).toBe(true);
    expect(values.chromaticChords).toBe(false);
  });

  it('carries the view, spawn mode and range profile', () => {
    const encoded = encodeConfig(
      { ...DEFAULTS },
      {
        view: '2d',
        spawnMode: 'static',
        rangeMode: 'experimental',
      }
    );
    const { meta } = decodeConfig(encoded);

    expect(meta).toEqual({ view: '2d', spawnMode: 'static', rangeMode: 'experimental' });
  });

  it('preserves values that only exist under the experimental profile', () => {
    // 200 particles per ring is above the safe ceiling of 128. Encoding and decoding under
    // the experimental profile must not quietly clamp it back down.
    const config = { ...DEFAULTS, numPoints: 200 };
    const encoded = encodeConfig(config, { rangeMode: 'experimental' });
    const { values, meta } = decodeConfig(encoded);

    expect(meta.rangeMode).toBe('experimental');
    expect(values.numPoints).toBe(200);
  });

  it('preserves automatic versus explicitly chosen colours', () => {
    for (const color of ['auto', '#ffffff', '#000000', '#31a9cc']) {
      expect(decodeConfig(encodeConfig({ ...DEFAULTS, color })).values.color).toBe(color);
    }
  });
});

describe('decodeConfig is total', () => {
  it('returns empty results for junk input', () => {
    for (const input of ['', '#', '???', 'not=a&real=config', null, undefined, 42]) {
      const { values, meta } = decodeConfig(input);
      expect(values).toEqual({});
      expect(meta).toEqual({});
    }
  });

  it('tolerates a leading # or ?', () => {
    expect(decodeConfig('#numPoints=40').values.numPoints).toBe(40);
    expect(decodeConfig('?numPoints=40').values.numPoints).toBe(40);
  });

  it('clamps out-of-range numbers instead of trusting them', () => {
    const { values } = decodeConfig('numPoints=999999&speed=-50');
    const points = CONTROLS.find((spec) => spec.key === 'numPoints');
    const speed = CONTROLS.find((spec) => spec.key === 'speed');

    expect(values.numPoints).toBe(rangeBounds(points, 'safe').max);
    expect(values.speed).toBe(rangeBounds(speed, 'safe').min);
  });

  it('snaps numbers onto the control step grid', () => {
    // `size` steps by 0.5, so 4.37 is not a representable value.
    const { values } = decodeConfig('size=4.37');
    expect(values.size).toBe(4.5);
  });

  it('drops non-numeric values for range controls', () => {
    const { values } = decodeConfig('numPoints=banana&speed=NaN');
    expect(values).not.toHaveProperty('numPoints');
    expect(values).not.toHaveProperty('speed');
  });

  it('drops unknown keys', () => {
    const { values } = decodeConfig('numPoints=40&somethingElse=7&__proto__=x');
    expect(values).toEqual({ numPoints: 40 });
  });

  it('rejects a select option that does not exist', () => {
    expect(decodeConfig('shape=disc').values.shape).toBe('disc');
    expect(decodeConfig('shape=dodecahedron').values).not.toHaveProperty('shape');
  });

  it('rejects a malformed colour', () => {
    expect(decodeConfig('color=%23ABCDEF').values.color).toBe('#abcdef');
    expect(decodeConfig('color=red').values).not.toHaveProperty('color');
    expect(decodeConfig('color=%23fff').values).not.toHaveProperty('color');
  });

  it('rejects out-of-vocabulary meta values', () => {
    const { meta } = decodeConfig('view=4d&spawn=chaotic&range=wild');
    expect(meta).toEqual({});
  });

  it('reads checkboxes as booleans', () => {
    expect(decodeConfig('glow=1').values.glow).toBe(true);
    expect(decodeConfig('glow=0').values.glow).toBe(false);
    expect(decodeConfig('glow=nonsense').values.glow).toBe(false);
  });

  it('only produces values the scene already understands', () => {
    const { values } = decodeConfig(encodeConfig({ ...DEFAULTS }));
    for (const key of Object.keys(values)) expect(DEFAULTS).toHaveProperty(key);
  });
});

describe('initialConfig', () => {
  it('prefers the URL hash over storage', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => encodeConfig({ ...DEFAULTS, numPoints: 80 }, { view: '3d' }),
    });
    const result = initialConfig({ hash: '#numPoints=40' });
    expect(result.values.numPoints).toBe(40);
    expect(result.meta).toEqual({});
  });

  it('falls back when the hash carries nothing usable', () => {
    // No `localStorage` in the node test environment, so this also covers the
    // storage-unavailable path staying non-fatal.
    const result = initialConfig({ hash: '#nothing=here' });
    expect(result.values).toEqual({});
  });

  it('restores view, profile and automatic colour from the same stored configuration', () => {
    const storage = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    });
    const meta = { view: '2d', spawnMode: 'static', rangeMode: 'experimental' };
    storeConfig({ ...DEFAULTS, color: 'auto' }, meta);
    expect([...storage.keys()]).toEqual([CONFIG_STORAGE_KEY]);
    const restored = initialConfig({ hash: '' });
    expect(restored.meta).toEqual(meta);
    expect(restored.values.color).toBe('auto');
  });

  it('ignores query-string and separate stored view overrides', () => {
    vi.stubGlobal('localStorage', {
      getItem: (key) =>
        key === CONFIG_STORAGE_KEY ? encodeConfig({ ...DEFAULTS }, { view: '3d' }) : '2d',
    });
    expect(initialConfig({ hash: '', search: '?view=2d' }).meta.view).toBe('3d');
  });

  it('does not throw on a location without a hash', () => {
    expect(() => initialConfig({})).not.toThrow();
  });
});
