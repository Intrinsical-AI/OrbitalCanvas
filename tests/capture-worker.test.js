import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultDocument } from '../src/ui/permalink.js';

const mocks = vi.hoisted(() => ({
  selectCodec: vi.fn(),
  encode: vi.fn(),
  render: vi.fn(),
  scene: vi.fn(),
}));
vi.mock('../src/ui/webcodecs-export.js', () => ({
  selectCodec: mocks.selectCodec,
  encode: mocks.encode,
}));
vi.mock('../src/ui/capture.js', async (original) => ({
  ...(await original()),
  CaptureScene: class {
    constructor(...args) {
      mocks.scene(...args);
    }
    render = mocks.render;
  },
}));
let scope;
beforeEach(() => {
  vi.resetModules();
  for (const fn of Object.values(mocks)) fn.mockReset();
  scope = { postMessage: vi.fn() };
  vi.stubGlobal('self', scope);
  vi.stubGlobal(
    'OffscreenCanvas',
    class {
      constructor(width, height) {
        this.width = width;
        this.height = height;
      }
      getContext() {
        return {};
      }
    }
  );
  vi.stubGlobal(
    'VideoEncoder',
    class {
      static isConfigSupported() {}
    }
  );
  vi.stubGlobal('VideoFrame', class {});
  mocks.selectCodec.mockResolvedValue('avc');
  mocks.encode.mockImplementation(async ({ renderFrame, onProgress, onPhase }) => {
    renderFrame(0);
    onProgress(1);
    onPhase('finalizing');
    return { buffer: new ArrayBuffer(1), mimeType: 'video/mp4', extension: 'mp4', frames: 30 };
  });
});
afterEach(() => vi.unstubAllGlobals());
const request = () => ({
  type: 'start',
  jobId: 7,
  document: defaultDocument(),
  spec: { width: 640, height: 480, fps: 30, duration: 1, format: 'share' },
});
async function run(data = request()) {
  await import('../src/ui/capture-worker.js');
  await scope.onmessage({ data });
}

describe('capture worker protocol', () => {
  it('owns the canvas and fresh simulation, then transfers the encoded result', async () => {
    await run();
    expect(mocks.scene).toHaveBeenCalledOnce();
    expect(mocks.render).toHaveBeenCalledWith(0);
    const [message, transfer] = scope.postMessage.mock.calls.at(-1);
    expect(message).toMatchObject({
      type: 'complete',
      jobId: 7,
      result: { codec: 'avc', mimeType: 'video/mp4', frames: 30 },
    });
    expect(transfer).toEqual([message.result.buffer]);
    expect(scope.postMessage.mock.calls.map(([data]) => data.type)).toEqual([
      'phase',
      'phase',
      'progress',
      'phase',
      'complete',
    ]);
  });
  it.each(['VideoEncoder', 'VideoFrame', 'OffscreenCanvas'])(
    'reports missing %s before starting encoding',
    async (name) => {
      vi.stubGlobal(name, undefined);
      await run();
      expect(scope.postMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({ type: 'unavailable', jobId: 7 }),
        []
      );
      expect(mocks.selectCodec).not.toHaveBeenCalled();
      expect(mocks.encode).not.toHaveBeenCalled();
    }
  );
  it('reports a missing 2D worker context as unavailable', async () => {
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        getContext() {
          return null;
        }
      }
    );
    await run();
    expect(scope.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'unavailable' }),
      []
    );
  });
  it('checks unsupported encoding before creating the exported timeline', async () => {
    mocks.selectCodec.mockResolvedValue(null);
    await run();
    expect(scope.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'unavailable' }),
      []
    );
    expect(mocks.scene).not.toHaveBeenCalled();
  });
  it('reports actual encoding errors without classifying them as unavailable', async () => {
    mocks.encode.mockRejectedValue(new Error('flush failed'));
    await run();
    expect(scope.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'error', message: 'flush failed' }),
      []
    );
  });
  it('rejects invalid input before probing capabilities and ignores a second start', async () => {
    const data = request();
    data.spec.duration = 121;
    await run(data);
    await scope.onmessage({ data: request() });
    expect(scope.postMessage).toHaveBeenCalledOnce();
    expect(mocks.encode).not.toHaveBeenCalled();
  });
});
