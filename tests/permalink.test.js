import { describe, expect, it } from 'vitest';
import { CONTROLS, createConfig, DEFAULTS, rangeBounds } from '../src/core/config.js';
import { decodeConfig, encodeConfig, initialConfig } from '../src/ui/permalink.js';

describe('encodeConfig / decodeConfig', () => {
  it('round-trips every control key', () => {
    const config = createConfig();
    const { values } = decodeConfig(encodeConfig(config));

    for (const spec of CONTROLS) {
      expect(values, `missing ${spec.key}`).toHaveProperty(spec.key);
      expect(values[spec.key], `mismatch on ${spec.key}`).toEqual(config[spec.key]);
    }
  });

  it('round-trips a non-default configuration', () => {
    const config = createConfig({
      numPoints: 96,
      speed: 1.25,
      size: 4.5,
      color: '#3fa9c2',
      shape: 'disc',
      glow: true,
      chromaticChords: false,
    });
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
    const encoded = encodeConfig(createConfig(), {
      view: '2d',
      spawnMode: 'static',
      rangeMode: 'experimental',
    });
    const { meta } = decodeConfig(encoded);

    expect(meta).toEqual({ view: '2d', spawnMode: 'static', rangeMode: 'experimental' });
  });

  it('preserves values that only exist under the experimental profile', () => {
    // 200 particles per ring is above the safe ceiling of 128. Encoding and decoding under
    // the experimental profile must not quietly clamp it back down.
    const config = createConfig({ numPoints: 200 });
    const encoded = encodeConfig(config, { rangeMode: 'experimental' });
    const { values, meta } = decodeConfig(encoded);

    expect(meta.rangeMode).toBe('experimental');
    expect(values.numPoints).toBe(200);
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
    const { values } = decodeConfig(encodeConfig(createConfig()));
    for (const key of Object.keys(values)) expect(DEFAULTS).toHaveProperty(key);
  });
});

describe('initialConfig', () => {
  it('prefers the URL hash over storage', () => {
    const result = initialConfig({ hash: '#numPoints=40' });
    expect(result.fromUrl).toBe(true);
    expect(result.values.numPoints).toBe(40);
  });

  it('falls back when the hash carries nothing usable', () => {
    // No `localStorage` in the node test environment, so this also covers the
    // storage-unavailable path staying non-fatal.
    const result = initialConfig({ hash: '#nothing=here' });
    expect(result.fromUrl).toBe(false);
    expect(result.values).toEqual({});
  });

  it('does not throw on a location without a hash', () => {
    expect(() => initialConfig({})).not.toThrow();
  });
});
