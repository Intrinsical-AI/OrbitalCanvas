import { describe, expect, it } from 'vitest';
import { CONTROLS, toDisplay } from '../src/core/config.js';
import {
  DOCUMENT_KEY,
  decodeDocument,
  defaultDocument,
  encodeDocument,
  initialDocument,
  storeDocument,
  validateDocument,
  readPreferences,
} from '../src/ui/permalink.js';

const memory = (value = null) => ({
  getItem: () => value,
  setItem(_key, next) {
    value = next;
  },
});
describe('document v2', () => {
  it('round-trips all controls, camera and appearance', () => {
    const doc = defaultDocument('light');
    doc.parameters.color = '#123456';
    doc.camera = { yaw: 1.2, pitch: -0.3, zoom: 2, autoOrbit: false };
    const decoded = decodeDocument(encodeDocument(doc));
    expect(decoded.parameters).toEqual(doc.parameters);
    for (const key of ['yaw', 'pitch', 'zoom'])
      expect(decoded.camera[key]).toBeCloseTo(doc.camera[key], 10);
    expect(decoded.camera.autoOrbit).toBe(false);
    expect(decoded.appearance).toBe('light');
  });
  it.each(CONTROLS.filter((s) => s.type === 'range'))('uses display units for $key', (spec) => {
    const doc = defaultDocument();
    const params = new URLSearchParams(encodeDocument(doc));
    expect(Number(params.get(spec.key))).toBe(toDisplay(spec, doc.parameters[spec.key]));
  });
  it('preserves Experimental values', () => {
    const doc = defaultDocument();
    doc.rangeMode = 'experimental';
    doc.parameters.numPoints = 240;
    doc.parameters.ringSpacing = 0.005;
    expect(decodeDocument(encodeDocument(doc)).parameters).toEqual(doc.parameters);
  });
  it.each(['', '#view=3d', '#v=1', '#v=3'])('rejects incompatible format %s', (text) => {
    expect(() => decodeDocument(text)).toThrow();
  });
  it.each([
    'speed=NaN',
    'speed=',
    'zoom=Infinity',
    'glow=perhaps',
    'appearance=blue',
    'color=red',
    'shape=unknown',
    'spawn=nope',
  ])('rejects invalid known field %s', (field) => {
    expect(() => decodeDocument('#v=2&' + field)).toThrow();
  });
  it('bounds finite values and ignores unknown fields', () => {
    const doc = decodeDocument('#v=2&numPoints=9999&pitch=1000&zoom=99&unknown=1');
    expect(doc.parameters.numPoints).toBe(128);
    expect(doc.camera.zoom).toBe(3);
    expect(doc.camera.pitch).toBeCloseTo((89 * Math.PI) / 180, 10);
    expect(doc.parameters).not.toHaveProperty('unknown');
  });
  it('keeps automatic colour distinct from explicit white', () => {
    const auto = decodeDocument('#v=2&color=auto'),
      white = decodeDocument('#v=2&color=%23FFFFFF');
    expect(auto.parameters.color).toBe('auto');
    expect(white.parameters.color).toBe('#ffffff');
  });
  it('does not let an invalid link open an unrelated saved composition', () => {
    const saved = defaultDocument();
    saved.parameters.numPoints = 12;
    const result = initialDocument({ hash: '#v=1' }, memory(JSON.stringify(saved)), 'light');
    expect(result.document.parameters.numPoints).not.toBe(12);
    expect(result.error).toMatch(/version/);
  });
  it('valid link beats local, local beats system defaults', () => {
    const saved = defaultDocument('light');
    saved.parameters.numPoints = 12;
    expect(initialDocument({ hash: '' }, memory(JSON.stringify(saved)), 'dark').document).toEqual(
      saved
    );
    expect(
      initialDocument({ hash: '#v=2&numPoints=24' }, memory(JSON.stringify(saved)), 'dark').document
        .parameters.numPoints
    ).toBe(24);
  });
  it('persists synchronously in the new storage key', () => {
    let written;
    const doc = defaultDocument();
    expect(
      storeDocument(doc, {
        setItem: (key, value) => {
          written = [key, value];
        },
      })
    ).toBe(true);
    expect(written[0]).toBe(DOCUMENT_KEY);
    expect(JSON.parse(written[1])).toEqual(doc);
  });
  it('handles blocked storage without claiming success', () => {
    expect(
      storeDocument(defaultDocument(), {
        setItem() {
          throw new Error('blocked');
        },
      })
    ).toBe(false);
    expect(
      initialDocument(
        { hash: '' },
        {
          getItem() {
            throw new Error('blocked');
          },
        },
        'light'
      ).document.appearance
    ).toBe('light');
  });
  it('keeps preferences and edits usable when access to localStorage itself is blocked', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('Storage is disabled', 'SecurityError');
      },
    });
    try {
      expect(readPreferences()).toEqual(readPreferences(memory()));
      expect(storeDocument(defaultDocument())).toBe(false);
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
      else delete globalThis.localStorage;
    }
  });
  it.each(['null', '[]', '{"version":1}', 'broken'])(
    'invalid saved document %s uses defaults',
    (saved) => {
      expect(initialDocument({ hash: '' }, memory(saved), 'dark').document).toEqual(
        defaultDocument()
      );
    }
  );
  it('does not retain legacy properties in a validated document', () => {
    const doc = defaultDocument();
    doc.parameters.initialRadius = 800;
    doc.time = 500;
    const clean = validateDocument(doc);
    expect(clean).not.toHaveProperty('time');
    expect(clean.parameters).not.toHaveProperty('initialRadius');
  });
  it('validates editor preferences independently', () => {
    expect(readPreferences(memory('null')).capture.fps).toBe(30);
    expect(
      readPreferences(memory('{"shortcuts":false,"capture":{"fps":999,"duration":999}}')).capture
    ).toEqual({ resolution: 'screen', fps: 30, duration: 120 });
  });
});
