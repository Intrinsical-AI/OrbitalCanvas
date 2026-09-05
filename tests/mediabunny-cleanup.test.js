import { afterEach, describe, expect, it, vi } from 'vitest';
import { BufferTarget, CanvasSource, Output, WebMOutputFormat } from 'mediabunny';

// Real Mediabunny sources, output and muxer. Only native resources are replaced;
// private fields here arrange failure states that the public API cannot inject.
async function setup() {
  class Canvas {}
  vi.stubGlobal('OffscreenCanvas', Canvas);
  const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
  const source = new CanvasSource(new Canvas(), { codec: 'vp9', bitrate: 100000 });
  output.addVideoTrack(source, { frameRate: 30 });
  await output.start();
  const encoder = () => ({
    state: 'configured',
    flush: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(function () {
      this.state = 'closed';
    }),
  });
  const color = encoder(),
    alpha = encoder();
  const frame = { close: vi.fn() },
    splitter = { close: vi.fn() };
  Object.assign(source._encoder, {
    encoder: color,
    alphaEncoder: alpha,
    alphaFrameQueue: [frame, null],
    splitter,
  });
  return { source, output, color, alpha, frame, splitter };
}

function expectClosed({ source, color, alpha, frame, splitter }) {
  expect(source._closed).toBe(true);
  for (const resource of [color, alpha, frame, splitter]) {
    expect(resource.close).toHaveBeenCalledOnce();
  }
  expect(color.state).toBe('closed');
  expect(alpha.state).toBe('closed');
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Mediabunny native resource cleanup', () => {
  it.each(['color', 'alpha', 'stored'])(
    'closes exactly once after %s encoder failure',
    async (phase) => {
      const fixture = await setup();
      const primary = new Error(`${phase} encoder failure`);
      if (phase === 'stored') fixture.source._encoder.setError(primary);
      else fixture[phase].flush.mockRejectedValueOnce(primary);
      await expect(fixture.output.finalize()).rejects.toBe(primary);
      expectClosed(fixture);
      await fixture.output.cancel();
      await fixture.output.cancel();
      fixture.source.close();
      fixture.source.close();
      expectClosed(fixture);
      if (phase === 'stored') expect(fixture.color.flush).not.toHaveBeenCalled();
    }
  );

  it('closes resources on successful finalization', async () => {
    const fixture = await setup();
    await fixture.output.finalize();
    expect(fixture.output.state).toBe('finalized');
    expectClosed(fixture);
    fixture.source.close();
    await fixture.output.cancel();
    expectClosed(fixture);
  });

  it('cancels before finalization without flushing', async () => {
    const fixture = await setup();
    await fixture.output.cancel();
    expect(fixture.output.state).toBe('canceled');
    expectClosed(fixture);
    expect(fixture.color.flush).not.toHaveBeenCalled();
    expect(fixture.alpha.flush).not.toHaveBeenCalled();
    await fixture.output.cancel();
    fixture.source.close();
    expectClosed(fixture);
  });

  it('does not close an already closed encoder twice', async () => {
    const fixture = await setup();
    fixture.alpha.state = 'closed';
    fixture.color.flush.mockRejectedValueOnce(new Error('flush failed'));
    await expect(fixture.output.finalize()).rejects.toThrow('flush failed');
    expect(fixture.color.close).toHaveBeenCalledOnce();
    expect(fixture.alpha.close).not.toHaveBeenCalled();
    expect(fixture.frame.close).toHaveBeenCalledOnce();
    expect(fixture.splitter.close).toHaveBeenCalledOnce();
  });

  it('preserves the primary error and reports failed forced cleanup separately', async () => {
    const fixture = await setup();
    const primary = new Error('primary flush failure'),
      secondary = new Error('close failed');
    fixture.color.flush.mockRejectedValueOnce(primary);
    fixture.color.close.mockImplementationOnce(() => {
      throw secondary;
    });
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(fixture.output.finalize()).rejects.toBe(primary);
    expect(diagnostic).toHaveBeenCalledWith(
      'Mediabunny source cleanup failed after finalization error:',
      secondary
    );
    expect(fixture.source._closed).toBe(false);
    expect(fixture.color.state).toBe('configured');
    await fixture.output.cancel();
    fixture.source.close();
    expect(fixture.color.close).toHaveBeenCalledOnce();
  });
});
