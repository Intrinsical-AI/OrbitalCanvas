import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encode, selectCodec } from '../src/ui/webcodecs-export.js';

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  add: vi.fn(),
  finalize: vi.fn(),
  cancel: vi.fn(),
}));
const packets = vi.hoisted(() => ({ notify: null }));
const codecMocks = vi.hoisted(() => ({
  canEncodeVideo: vi.fn(),
  isConfigSupported: vi.fn(),
  sourceOptions: [],
}));

vi.mock('mediabunny', () => ({
  BufferTarget: class {
    buffer = new Uint8Array([1]).buffer;
  },
  CanvasSource: class {
    constructor(canvas, options) {
      this.options = options;
      packets.notify = options.onEncodedPacket;
      codecMocks.sourceOptions.push(options);
    }
    async add(...args) {
      await mocks.add(...args);
      this.options.onEncodedPacket({ data: new Uint8Array([1]) });
    }
  },
  Output: class {
    constructor({ format }) {
      this.format = format;
    }
    start = mocks.start;
    finalize = mocks.finalize;
    cancel = mocks.cancel;
    addVideoTrack() {}
  },
  Mp4OutputFormat: class {
    mimeType = 'video/mp4';
  },
  WebMOutputFormat: class {
    mimeType = 'video/webm';
  },
  canEncodeVideo: codecMocks.canEncodeVideo,
}));

describe('WebCodecs export', () => {
  beforeEach(() => {
    for (const fn of Object.values(mocks)) fn.mockReset().mockResolvedValue(undefined);
    codecMocks.canEncodeVideo.mockReset().mockResolvedValue(true);
    codecMocks.isConfigSupported.mockReset().mockResolvedValue({ supported: true });
    codecMocks.sourceOptions.length = 0;
    vi.stubGlobal('VideoEncoder', { isConfigSupported: codecMocks.isConfigSupported });
  });
  afterEach(() => vi.unstubAllGlobals());

  function options(overrides = {}) {
    return {
      canvas: { width: 1920, height: 1080 },
      codec: 'vp9',
      fps: 30,
      duration: 2,
      renderFrame: vi.fn(),
      onProgress: vi.fn(),
      ...overrides,
    };
  }

  it('defaults to H.264 MP4 without falling through to another codec', async () => {
    codecMocks.canEncodeVideo.mockResolvedValue(false);
    expect(await selectCodec(options().canvas)).toBeNull();
    expect(codecMocks.canEncodeVideo).toHaveBeenCalledOnce();
    expect(codecMocks.canEncodeVideo).toHaveBeenCalledWith('avc', expect.any(Object));
    expect(codecMocks.isConfigSupported).toHaveBeenCalledOnce();
  });

  it('rejects H.264 at the requested FPS before the real-frame capability probe', async () => {
    codecMocks.isConfigSupported.mockResolvedValue({ supported: false });
    expect(await selectCodec(options().canvas, { fps: 60 })).toBeNull();
    expect(codecMocks.canEncodeVideo).not.toHaveBeenCalled();
    expect(codecMocks.isConfigSupported).toHaveBeenCalledWith(
      expect.objectContaining({
        codec: 'avc1.4d002a',
        framerate: 60,
        bitrate: 12_000_000,
      })
    );
  });

  it('keeps codec fallthrough available only in automatic mode', async () => {
    codecMocks.canEncodeVideo.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    expect(await selectCodec(options().canvas, { fps: 60, format: 'auto' })).toBe('av1');
    expect(codecMocks.canEncodeVideo.mock.calls.map(([codec]) => codec)).toEqual(['avc', 'av1']);
  });

  it('falls through unsupported MP4 configurations to automatic WebM', async () => {
    codecMocks.isConfigSupported.mockResolvedValue({ supported: false });
    expect(await selectCodec(options().canvas, { format: 'auto' })).toBe('vp9');
    expect(codecMocks.canEncodeVideo).toHaveBeenCalledOnce();
    expect(codecMocks.canEncodeVideo).toHaveBeenCalledWith(
      'vp9',
      expect.objectContaining({
        bitrate: 3_600_000,
        alpha: 'discard',
      })
    );
  });

  it('returns no codec when neither MP4 nor WebM can be encoded', async () => {
    codecMocks.canEncodeVideo.mockResolvedValue(false);
    expect(await selectCodec(options().canvas, { format: 'auto' })).toBeNull();
    expect(codecMocks.canEncodeVideo.mock.calls.map(([codec]) => codec)).toEqual([
      'avc',
      'av1',
      'vp9',
      'vp8',
    ]);
  });

  it('returns no codec without WebCodecs', async () => {
    vi.stubGlobal('VideoEncoder', undefined);
    expect(await selectCodec(options().canvas)).toBeNull();
    expect(codecMocks.canEncodeVideo).not.toHaveBeenCalled();
  });

  it.each([
    ['avc', 24, 'avc1.4d0028', 4_800_000],
    ['avc', 30, 'avc1.4d0028', 6_000_000],
    ['avc', 60, 'avc1.4d002a', 12_000_000],
    ['avc', 120, 'avc1.4d0033', 24_000_000],
    ['av1', 24, 'av01.0.08M.08', 1_920_000],
    ['av1', 30, 'av01.0.08M.08', 2_400_000],
    ['av1', 60, 'av01.0.09M.08', 4_800_000],
    ['av1', 120, 'av01.0.12M.08', 9_600_000],
  ])(
    'probes and encodes 1080p %s at %i FPS with the same level and bitrate',
    async (codec, fps, fullCodecString, bitrate) => {
      codecMocks.canEncodeVideo.mockImplementation(async (candidate) => candidate === codec);
      const input = options({ codec, fps, duration: 1 / fps });
      expect(await selectCodec(input.canvas, { fps, format: 'auto' })).toBe(codec);
      const result = await encode(input);
      const expected = { fullCodecString, bitrate, alpha: 'discard' };
      expect(codecMocks.canEncodeVideo).toHaveBeenCalledWith(codec, {
        width: 1920,
        height: 1080,
        ...expected,
      });
      expect(codecMocks.sourceOptions.at(-1)).toEqual({
        codec,
        ...expected,
        onEncodedPacket: expect.any(Function),
      });
      expect(codecMocks.isConfigSupported).toHaveBeenCalledWith({
        codec: fullCodecString,
        width: 1920,
        height: 1080,
        bitrate,
        alpha: 'discard',
        framerate: fps,
      });
      expect(result.extension).toBe('mp4');
      expect(result.mimeType).toBe('video/mp4');
    }
  );

  it.each([
    ['avc', 'avc1.4d002a'],
    ['av1', 'av01.0.09M.08'],
  ])('uses the same throughput level for portrait 1080p60 %s', async (codec, fullCodecString) => {
    codecMocks.canEncodeVideo.mockImplementation(async (candidate) => candidate === codec);
    const canvas = { width: 1080, height: 1920 };
    expect(await selectCodec(canvas, { fps: 60, format: 'auto' })).toBe(codec);
    await encode(options({ canvas, codec, fps: 60, duration: 1 / 60 }));
    expect(codecMocks.sourceOptions.at(-1).fullCodecString).toBe(fullCodecString);
    expect(codecMocks.canEncodeVideo).toHaveBeenCalledWith(
      codec,
      expect.objectContaining({
        width: 1080,
        height: 1920,
        fullCodecString,
      })
    );
  });

  it.each([
    [30, 'avc1.4d001e'],
    [60, 'avc1.4d001f'],
    [120, 'avc1.4d0020'],
  ])('uses a lower H.264 level for 640×480 at %i FPS', async (fps, fullCodecString) => {
    await selectCodec({ width: 640, height: 480 }, { fps });
    expect(codecMocks.canEncodeVideo).toHaveBeenCalledWith(
      'avc',
      expect.objectContaining({
        fullCodecString,
      })
    );
  });

  it.each([
    [640, 480, 30, 'av01.0.04M.08'],
    [1280, 720, 30, 'av01.0.05M.08'],
    [1280, 720, 60, 'av01.0.08M.08'],
  ])('scales AV1 levels for %i×%i at %i FPS', async (width, height, fps, fullCodecString) => {
    codecMocks.canEncodeVideo.mockImplementation(async (candidate) => candidate === 'av1');
    expect(await selectCodec({ width, height }, { fps, format: 'auto' })).toBe('av1');
    expect(codecMocks.canEncodeVideo).toHaveBeenCalledWith(
      'av1',
      expect.objectContaining({
        fullCodecString,
      })
    );
  });

  it('accounts for the H.264 per-dimension macroblock constraint', async () => {
    await selectCodec({ width: 1920, height: 80 });
    expect(codecMocks.canEncodeVideo).toHaveBeenCalledWith(
      'avc',
      expect.objectContaining({
        fullCodecString: 'avc1.4d001f',
      })
    );
  });

  it.each([
    { width: 1922, height: 1080 },
    { width: 1920, height: 1920 },
    { width: 0, height: 1080 },
  ])('rejects dimensions outside the capture policy before probing or encoding', async (canvas) => {
    await expect(selectCodec(canvas)).rejects.toThrow('Full HD');
    await expect(encode(options({ canvas }))).rejects.toThrow('Full HD');
    expect(codecMocks.canEncodeVideo).not.toHaveBeenCalled();
    expect(codecMocks.sourceOptions).toHaveLength(0);
  });

  it('rejects unsupported FPS and unknown output modes', async () => {
    await expect(selectCodec(options().canvas, { fps: 121 })).rejects.toThrow('FPS');
    await expect(selectCodec(options().canvas, { format: 'other' })).rejects.toThrow('format');
    expect(codecMocks.canEncodeVideo).not.toHaveBeenCalled();
  });

  it('advances and timestamps exactly duration × fps frames', async () => {
    const input = options();
    const result = await encode(input);
    expect(input.renderFrame).toHaveBeenCalledTimes(60);
    expect(input.renderFrame).toHaveBeenNthCalledWith(1, 0);
    expect(input.renderFrame).toHaveBeenLastCalledWith(1 / 30);
    expect(mocks.add).toHaveBeenNthCalledWith(1, 0, 1 / 30);
    expect(mocks.add).toHaveBeenLastCalledWith(59 / 30, 1 / 30);
    expect(input.onProgress).toHaveBeenLastCalledWith(1);
    expect(mocks.finalize).toHaveBeenCalledOnce();
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(result.buffer.byteLength).toBeGreaterThan(0);
    expect(result.frames).toBe(60);
  });

  it('bounds the encoded payload while frames are being written', async () => {
    mocks.add.mockImplementation(async () => packets.notify({ data: new Uint8Array(6) }));
    await expect(encode(options({ payloadLimit: 10 }))).rejects.toThrow('60 MiB limit');
    expect(mocks.add).toHaveBeenCalledTimes(2);
    expect(mocks.finalize).not.toHaveBeenCalled();
    expect(mocks.cancel).toHaveBeenCalledOnce();
  });

  it('rejects payload overflow emitted during the final encoder flush', async () => {
    mocks.finalize.mockImplementation(async () => packets.notify({ data: new Uint8Array(11) }));
    await expect(encode(options({ fps: 1, duration: 1, payloadLimit: 10 }))).rejects.toThrow(
      '60 MiB limit'
    );
    expect(mocks.cancel).toHaveBeenCalledOnce();
  });

  it.each(['start', 'add', 'finalize'])(
    'requests output cancellation after %s fails',
    async (phase) => {
      const error = new Error(`${phase} failed`);
      mocks[phase].mockRejectedValueOnce(error);
      await expect(encode(options())).rejects.toBe(error);
      expect(mocks.cancel).toHaveBeenCalledOnce();
    }
  );

  it('reports finalization separately from submitted frames', async () => {
    const onPhase = vi.fn();
    await encode(options({ onPhase }));
    expect(onPhase).toHaveBeenCalledWith('finalizing');
  });

  it('closes a failed exact-FPS probe and tries the next automatic candidate', async () => {
    mocks.add.mockRejectedValueOnce(new Error('Requested FPS is unsupported'));
    expect(await selectCodec(options().canvas, { fps: 120, format: 'auto' })).toBe('av1');
    expect(mocks.cancel).toHaveBeenCalledOnce();
    expect(codecMocks.sourceOptions.map((options) => options.codec)).toEqual(['avc', 'av1']);
    expect(mocks.add).toHaveBeenLastCalledWith(0, 1 / 120);
  });

  it('probes VP9 and VP8 with an actual frame and flush at the requested FPS', async () => {
    codecMocks.canEncodeVideo.mockImplementation(async (codec) => codec === 'vp8');
    expect(await selectCodec(options().canvas, { fps: 120, format: 'auto' })).toBe('vp8');
    expect(mocks.add).toHaveBeenCalledWith(0, 1 / 120);
    expect(mocks.finalize).toHaveBeenCalledOnce();
  });

  it('cancels output after a rendering error', async () => {
    const error = new Error('render failed');
    await expect(
      encode(
        options({
          renderFrame: () => {
            throw error;
          },
        })
      )
    ).rejects.toBe(error);
    expect(mocks.cancel).toHaveBeenCalledOnce();
  });
});
