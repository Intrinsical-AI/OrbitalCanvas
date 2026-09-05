import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Recorder } from '../src/ui/recorder.js';
import { encode, selectCodec } from '../src/ui/webcodecs-export.js';

vi.mock('../src/ui/webcodecs-export.js', () => ({
  selectCodec: vi.fn(),
  encode: vi.fn(),
}));

describe('Recorder', () => {
  let now;
  let frames;
  let frameId;
  let track;
  let canvas;
  let instance;
  let constructorError;
  let startError;
  let download;

  class Capture extends EventTarget {
    static isTypeSupported() {
      return true;
    }

    constructor() {
      super();
      if (constructorError) throw constructorError;
      instance = this;
      this.state = 'inactive';
    }

    start() {
      if (startError) throw startError;
      this.state = 'recording';
    }

    stop() {
      this.state = 'inactive';
      this.dispatchEvent(Object.assign(new Event('dataavailable'), { data: new Blob(['clip']) }));
      this.dispatchEvent(new Event('stop'));
    }
  }

  beforeEach(() => {
    now = 0;
    frameId = 0;
    frames = new Map();
    constructorError = null;
    startError = null;
    instance = null;
    track = { stop: vi.fn() };
    canvas = { captureStream: vi.fn(() => ({ getTracks: () => [track] })) };
    download = vi.fn();
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:clip');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.stubGlobal('document', { createElement: () => ({ click: download }) });
    vi.stubGlobal('VideoEncoder', undefined);
    vi.stubGlobal('MediaRecorder', Capture);
    vi.stubGlobal('requestAnimationFrame', (callback) => {
      frames.set(++frameId, callback);
      return frameId;
    });
    vi.stubGlobal('cancelAnimationFrame', (id) => frames.delete(id));
    selectCodec.mockReset().mockResolvedValue(null);
    encode.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function frame(time) {
    now = time;
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(time);
    await Promise.resolve();
  }

  it.each(['no VideoEncoder', 'no encodable codec'])(
    'advances the fallback by elapsed time: %s',
    async (reason) => {
      if (reason === 'no encodable codec') vi.stubGlobal('VideoEncoder', class {});
      const renderFrame = vi.fn();
      const recorder = new Recorder(canvas);
      const result = recorder.record({ fps: 30, duration: 1, renderFrame });
      await vi.dynamicImportSettled();
      await frame(100);
      await frame(250);
      await frame(600);
      await frame(1100);
      await expect(result).resolves.toMatchObject({ strategy: 'mediarecorder' });
      expect(renderFrame.mock.calls.map(([dt]) => dt)).toEqual([0.1, 0.15, 0.35, 0.4]);
      expect(download).toHaveBeenCalledOnce();
      expect(track.stop).toHaveBeenCalledOnce();
      expect(frames.size).toBe(0);
      expect(recorder.recording).toBe(false);
    }
  );

  it.each(['constructor', 'start'])('releases tracks when %s throws', async (phase) => {
    const error = new Error(`${phase} failed`);
    if (phase === 'constructor') constructorError = error;
    else startError = error;
    const recorder = new Recorder(canvas);
    await expect(recorder.record({ fps: 30, duration: 1, renderFrame: vi.fn() })).rejects.toBe(
      error
    );
    expect(track.stop).toHaveBeenCalledOnce();
    expect(frames.size).toBe(0);
    expect(recorder.recording).toBe(false);
    expect(download).not.toHaveBeenCalled();
  });

  it('cancels capture without waiting for another animation frame', async () => {
    const recorder = new Recorder(canvas);
    const result = recorder.record({ fps: 30, duration: 10, renderFrame: vi.fn() });
    const rejection = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    recorder.cancel();
    await rejection;
    expect(instance.state).toBe('inactive');
    expect(track.stop).toHaveBeenCalledOnce();
    expect(frames.size).toBe(0);
    expect(download).not.toHaveBeenCalled();
  });

  it('reports an encoder error and stops the frame loop and tracks', async () => {
    const recorder = new Recorder(canvas);
    const result = recorder.record({ fps: 30, duration: 10, renderFrame: vi.fn() });
    const error = new Error('capture failed');
    const rejection = expect(result).rejects.toBe(error);
    instance.dispatchEvent(Object.assign(new Event('error'), { error }));
    await rejection;
    expect(instance.state).toBe('inactive');
    expect(track.stop).toHaveBeenCalledOnce();
    expect(frames.size).toBe(0);
    expect(download).not.toHaveBeenCalled();
  });

  it('releases capture when rendering a frame throws', async () => {
    const error = new Error('render failed');
    const recorder = new Recorder(canvas);
    const result = recorder.record({
      fps: 30,
      duration: 1,
      renderFrame: () => {
        throw error;
      },
    });
    const rejection = expect(result).rejects.toBe(error);
    await frame(100);
    await rejection;
    expect(track.stop).toHaveBeenCalledOnce();
    expect(frames.size).toBe(0);
    expect(download).not.toHaveBeenCalled();
  });

  it('does not enter the fallback after cancellation during codec selection', async () => {
    vi.stubGlobal('VideoEncoder', class {});
    let finishSelection;
    selectCodec.mockImplementation(() => new Promise((resolve) => (finishSelection = resolve)));
    const recorder = new Recorder(canvas);
    const result = recorder.record({ fps: 30, duration: 1, renderFrame: vi.fn() });
    const rejection = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    await vi.dynamicImportSettled();
    recorder.cancel();
    finishSelection(null);
    await rejection;
    expect(canvas.captureStream).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  });

  it('uses the frame-exact encoder without starting captureStream', async () => {
    vi.stubGlobal('VideoEncoder', class {});
    selectCodec.mockResolvedValue('vp9');
    encode.mockResolvedValue({ blob: new Blob(['encoded']), extension: 'webm' });
    const renderFrame = vi.fn();
    const recorder = new Recorder(canvas);
    await expect(recorder.record({ fps: 30, duration: 1, renderFrame })).resolves.toMatchObject({
      strategy: 'webcodecs:vp9',
    });
    expect(encode).toHaveBeenCalledWith(expect.objectContaining({ renderFrame, fps: 30 }));
    expect(canvas.captureStream).not.toHaveBeenCalled();
    expect(download).toHaveBeenCalledOnce();
  });
});
