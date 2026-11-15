import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Recorder } from '../src/ui/recorder.js';

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  cancel: vi.fn(),
  render: vi.fn(),
  scene: vi.fn(),
}));
vi.mock('../src/ui/worker-client.js', () => ({
  WorkerCapture: class {
    run = mocks.run;
    cancel = mocks.cancel;
  },
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

describe('Recorder', () => {
  let now,
    frames,
    frameId,
    track,
    canvas,
    instance,
    constructorError,
    startError,
    defaultMimeType,
    download;
  class Capture extends EventTarget {
    static isTypeSupported() {
      return true;
    }
    constructor(_stream, options) {
      super();
      if (constructorError) throw constructorError;
      instance = this;
      this.mimeType = options?.mimeType ?? defaultMimeType;
      this.state = 'inactive';
    }
    start() {
      if (startError) throw startError;
      this.state = 'recording';
    }
    stop() {
      this.state = 'inactive';
      this.dispatchEvent(
        Object.assign(new Event('dataavailable'), {
          data: new Blob(['clip'], { type: this.mimeType }),
        })
      );
      this.dispatchEvent(new Event('stop'));
    }
  }
  const options = (overrides = {}) => ({
    document: { rangeMode: 'safe' },
    format: 'auto',
    fps: 30,
    duration: 1,
    ...overrides,
  });
  beforeEach(() => {
    now = frameId = 0;
    frames = new Map();
    constructorError = startError = instance = null;
    defaultMimeType = 'video/webm';
    track = { stop: vi.fn() };
    canvas = {
      width: 640,
      height: 480,
      captureStream: vi.fn(() => ({ getTracks: () => [track] })),
    };
    download = vi.fn();
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:clip');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.stubGlobal('document', { createElement: () => ({ click: download }), hidden: false });
    vi.stubGlobal('MediaRecorder', Capture);
    vi.stubGlobal('requestAnimationFrame', (callback) => {
      frames.set(++frameId, callback);
      return frameId;
    });
    vi.stubGlobal('cancelAnimationFrame', (id) => frames.delete(id));
    for (const fn of Object.values(mocks)) fn.mockReset();
    mocks.run.mockRejectedValue(
      Object.assign(new Error('No worker encoder'), { code: 'CAPTURE_UNAVAILABLE' })
    );
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
  async function fallback(recorder, overrides) {
    const pending = recorder.record(options(overrides));
    await vi.dynamicImportSettled();
    return { pending };
  }

  it('advances fallback by elapsed time on its own fresh capture scene', async () => {
    const recorder = new Recorder(canvas);
    const { pending } = await fallback(recorder);
    for (const time of [100, 250, 600, 1100]) await frame(time);
    await expect(pending).resolves.toMatchObject({ strategy: 'mediarecorder' });
    expect(mocks.render.mock.calls.map(([dt]) => dt)).toEqual([0.1, 0.15, 0.35, 0.4]);
    expect(mocks.scene).toHaveBeenCalledWith({ rangeMode: 'safe' }, canvas);
    expect(download).toHaveBeenCalledOnce();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(frames.size).toBe(0);
    expect(recorder.recording).toBe(false);
  });
  it.each([60, 120, 144])('paces 24 FPS capture on a %i Hz display', async (hz) => {
    const recorder = new Recorder(canvas);
    const { pending } = await fallback(recorder, { fps: 24 });
    for (let frameIndex = 1; frameIndex <= hz; frameIndex++) await frame((frameIndex * 1000) / hz);
    await expect(pending).resolves.toMatchObject({ strategy: 'mediarecorder' });
    expect(mocks.render).toHaveBeenCalledTimes(24);
    expect(mocks.render.mock.calls.reduce((sum, [dt]) => sum + dt, 0)).toBeCloseTo(1, 10);
  });
  it.each(['constructor', 'start'])('releases tracks when %s throws', async (phase) => {
    const error = new Error(`${phase} failed`);
    if (phase === 'constructor') constructorError = error;
    else startError = error;
    await expect(new Recorder(canvas).record(options())).rejects.toBe(error);
    expect(track.stop).toHaveBeenCalledOnce();
    expect(frames.size).toBe(0);
    expect(download).not.toHaveBeenCalled();
  });
  it.each([
    ['video/webm;codecs=vp9', 'webm'],
    ['video/mp4;codecs=avc1.42e01e', 'mp4'],
  ])('uses the selected %s container as .%s', async (mimeType, extension) => {
    vi.spyOn(Capture, 'isTypeSupported').mockReturnValue(false);
    defaultMimeType = mimeType;
    const { pending } = await fallback(new Recorder(canvas));
    await frame(1100);
    await expect(pending).resolves.toMatchObject({
      filename: expect.stringMatching(new RegExp(`\\.${extension}$`)),
    });
    expect(URL.createObjectURL.mock.calls[0][0].type).toBe(mimeType);
  });
  it('uses chunk MIME when the recorder does not expose its format', async () => {
    vi.spyOn(Capture, 'isTypeSupported').mockReturnValue(false);
    defaultMimeType = '';
    const { pending } = await fallback(new Recorder(canvas));
    instance.dispatchEvent(
      Object.assign(new Event('dataavailable'), { data: new Blob(['mp4'], { type: 'video/mp4' }) })
    );
    await frame(1100);
    await expect(pending).resolves.toMatchObject({ filename: expect.stringMatching(/\.mp4$/) });
  });
  it('rejects unknown MIME rather than mislabeling a download', async () => {
    vi.spyOn(Capture, 'isTypeSupported').mockReturnValue(false);
    defaultMimeType = 'video/unknown';
    const { pending } = await fallback(new Recorder(canvas));
    const rejection = expect(pending).rejects.toThrow('Unsupported capture format');
    await frame(1100);
    await rejection;
    expect(download).not.toHaveBeenCalled();
    expect(track.stop).toHaveBeenCalledOnce();
  });
  it('cancels real-time capture without another frame', async () => {
    const recorder = new Recorder(canvas);
    const { pending } = await fallback(recorder, { duration: 10 });
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    recorder.cancel();
    await rejection;
    expect(instance.state).toBe('inactive');
    expect(track.stop).toHaveBeenCalledOnce();
    expect(frames.size).toBe(0);
  });
  it('preserves the reason when background capture is cancelled', async () => {
    const recorder = new Recorder(canvas);
    const { pending } = await fallback(recorder, { duration: 10 });
    const reason = new Error('Keep this tab visible');
    const rejection = expect(pending).rejects.toBe(reason);
    recorder.cancel(reason);
    await rejection;
    expect(download).not.toHaveBeenCalled();
  });
  it('rejects real-time capture if the tab is already hidden', async () => {
    globalThis.document.hidden = true;
    await expect(new Recorder(canvas).record(options())).rejects.toThrow('visible tab');
    expect(canvas.captureStream).not.toHaveBeenCalled();
  });
  it('stops the loop and tracks on encoder error', async () => {
    const { pending } = await fallback(new Recorder(canvas));
    const error = new Error('capture failed');
    const rejection = expect(pending).rejects.toBe(error);
    instance.dispatchEvent(Object.assign(new Event('error'), { error }));
    await rejection;
    expect(track.stop).toHaveBeenCalledOnce();
    expect(frames.size).toBe(0);
    expect(download).not.toHaveBeenCalled();
  });
  it('releases capture when rendering throws', async () => {
    const error = new Error('render failed');
    mocks.render.mockImplementation(() => {
      throw error;
    });
    const { pending } = await fallback(new Recorder(canvas));
    const rejection = expect(pending).rejects.toBe(error);
    await frame(100);
    await rejection;
    expect(track.stop).toHaveBeenCalledOnce();
    expect(frames.size).toBe(0);
  });
  it('refuses fallback for H.264 sharing', async () => {
    const recorder = new Recorder(canvas);
    await expect(recorder.record(options({ format: 'share' }))).rejects.toThrow(
      'H.264/MP4 encoding is unavailable'
    );
    expect(canvas.captureStream).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  });
  it('does not fall back after worker runtime failure', async () => {
    const failure = new Error('Native flush failed');
    mocks.run.mockRejectedValue(failure);
    await expect(new Recorder(canvas).record(options())).rejects.toBe(failure);
    expect(canvas.captureStream).not.toHaveBeenCalled();
  });
  it('downloads transferred worker data with the actual codec and format', async () => {
    mocks.run.mockResolvedValue({
      buffer: new Uint8Array([1]).buffer,
      mimeType: 'video/mp4',
      extension: 'mp4',
      codec: 'avc',
    });
    const recorder = new Recorder(canvas);
    await expect(recorder.record(options({ format: 'share', fps: 60 }))).resolves.toMatchObject({
      strategy: 'webcodecs:avc',
    });
    expect(mocks.run).toHaveBeenCalledWith({
      document: { rangeMode: 'safe' },
      spec: { width: 640, height: 480, format: 'share', fps: 60, duration: 1 },
    });
    expect(canvas.captureStream).not.toHaveBeenCalled();
    expect(download).toHaveBeenCalledOnce();
  });
  it('does not start fallback or download after cancellation during worker preparation', async () => {
    let resolve, reject;
    mocks.run.mockImplementation(
      () =>
        new Promise((yes, no) => {
          resolve = yes;
          reject = no;
        })
    );
    mocks.cancel.mockImplementation((reason) => reject(reason));
    const recorder = new Recorder(canvas);
    const pending = recorder.record(options());
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    recorder.cancel();
    await rejection;
    resolve({ codec: 'avc' });
    expect(canvas.captureStream).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  });
  it('rejects invalid dimensions and work budgets before creating a worker', async () => {
    await expect(
      new Recorder(canvas).record(options({ width: 1920, height: 1080, fps: 120, duration: 16 }))
    ).rejects.toThrow('reduce FPS');
    expect(mocks.run).not.toHaveBeenCalled();
  });
});
