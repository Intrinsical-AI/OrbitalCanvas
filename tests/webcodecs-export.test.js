import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encode } from '../src/ui/webcodecs-export.js';

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  add: vi.fn(),
  finalize: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock('mediabunny', () => ({
  BufferTarget: class {
    buffer = new Uint8Array([1]);
  },
  CanvasSource: class {
    add = mocks.add;
  },
  Output: class {
    format = { mimeType: 'video/webm' };
    start = mocks.start;
    finalize = mocks.finalize;
    cancel = mocks.cancel;
    addVideoTrack() {}
  },
  Mp4OutputFormat: class {},
  WebMOutputFormat: class {},
  QUALITY_HIGH: 1,
  getFirstEncodableVideoCodec: vi.fn(),
}));

describe('WebCodecs export', () => {
  beforeEach(() => {
    for (const fn of Object.values(mocks)) fn.mockReset().mockResolvedValue(undefined);
  });

  function options(overrides = {}) {
    return {
      canvas: {},
      codec: 'vp9',
      fps: 30,
      duration: 2,
      renderFrame: vi.fn(),
      onProgress: vi.fn(),
      isAborted: () => false,
      ...overrides,
    };
  }

  it('advances and timestamps exactly duration × fps frames', async () => {
    const input = options();
    const result = await encode(input);
    expect(input.renderFrame).toHaveBeenCalledTimes(60);
    expect(input.renderFrame).toHaveBeenLastCalledWith(1 / 30);
    expect(mocks.add).toHaveBeenNthCalledWith(1, 0, 1 / 30);
    expect(mocks.add).toHaveBeenLastCalledWith(59 / 30, 1 / 30);
    expect(input.onProgress).toHaveBeenLastCalledWith(1);
    expect(mocks.finalize).toHaveBeenCalledOnce();
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(result.blob.size).toBeGreaterThan(0);
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

  it('cancels if requested while the last frame is encoding', async () => {
    let aborted = false;
    mocks.add.mockImplementation(async () => {
      aborted = true;
    });
    await expect(
      encode(options({ fps: 1, duration: 1, isAborted: () => aborted }))
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.cancel).toHaveBeenCalledOnce();
    expect(mocks.finalize).not.toHaveBeenCalled();
  });

  it('cancels after a rendering error', async () => {
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

  it('does not encode a resized frame when rendering requests cancellation', async () => {
    let aborted = false;
    await expect(
      encode(
        options({
          renderFrame: () => {
            aborted = true;
          },
          isAborted: () => aborted,
        })
      )
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.add).not.toHaveBeenCalled();
    expect(mocks.finalize).not.toHaveBeenCalled();
    expect(mocks.cancel).toHaveBeenCalledOnce();
  });
});
