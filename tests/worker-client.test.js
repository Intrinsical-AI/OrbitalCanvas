import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkerCapture } from '../src/ui/worker-client.js';

let workers;
class Worker {
  constructor(url, options) {
    this.url = url;
    this.options = options;
    this.terminate = vi.fn();
    this.postMessage = vi.fn();
    workers.push(this);
  }
  send(data) {
    this.onmessage?.({ data: { jobId: this.postMessage.mock.calls[0][0].jobId, ...data } });
  }
}
beforeEach(() => {
  workers = [];
  vi.stubGlobal('Worker', Worker);
});
afterEach(() => vi.unstubAllGlobals());

describe('worker capture ownership', () => {
  const request = { document: {}, spec: { width: 640, height: 480 } };
  it.each(['probing', 'encoding', 'finalizing'])(
    'cancels while %s is pending without an acknowledgement',
    async (phase) => {
      const onState = vi.fn(),
        task = new WorkerCapture(onState);
      const pending = task.run(request),
        worker = workers[0];
      worker.send({ type: 'phase', phase });
      const late = worker.onmessage;
      const jobId = worker.postMessage.mock.calls[0][0].jobId;
      const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      task.cancel();
      await rejection;
      expect(worker.terminate).toHaveBeenCalledOnce();
      expect(task.job).toBeNull();
      late({ data: { type: 'complete', jobId, result: { buffer: new ArrayBuffer(1) } } });
      expect(onState).toHaveBeenCalledOnce();
      task.cancel();
      expect(worker.terminate).toHaveBeenCalledOnce();
    }
  );
  it('ends successful workers and permits a fresh job with a different identity', async () => {
    const task = new WorkerCapture();
    const first = task.run(request);
    const result = { buffer: new ArrayBuffer(1), codec: 'avc' };
    workers[0].send({ type: 'complete', result });
    await expect(first).resolves.toBe(result);
    const second = task.run(request);
    expect(workers[0].terminate).toHaveBeenCalledOnce();
    expect(workers[1].postMessage.mock.calls[0][0].jobId).not.toBe(
      workers[0].postMessage.mock.calls[0][0].jobId
    );
    const rejection = expect(second).rejects.toMatchObject({ name: 'AbortError' });
    task.cancel();
    await rejection;
  });
  it('distinguishes unavailable encoders from runtime errors', async () => {
    const task = new WorkerCapture();
    const unavailable = task.run(request);
    const first = expect(unavailable).rejects.toMatchObject({ code: 'CAPTURE_UNAVAILABLE' });
    workers[0].send({ type: 'unavailable', message: 'No worker canvas' });
    await first;
    const pending = task.run(request);
    const failure = expect(pending).rejects.toThrow('flush failed');
    workers[1].send({ type: 'error', message: 'flush failed' });
    await failure;
    expect(workers[1].terminate).toHaveBeenCalledOnce();
  });
  it('treats worker script failures as errors without hiding them behind fallback', async () => {
    const task = new WorkerCapture(),
      pending = task.run(request);
    const rejection = expect(pending).rejects.toThrow('Script failed');
    workers[0].onerror({ message: 'Script failed', preventDefault: vi.fn() });
    await rejection;
    expect(workers[0].terminate).toHaveBeenCalledOnce();
  });
  it('cleans up after postMessage cannot clone a request', async () => {
    const failure = new DOMException('Cannot clone request', 'DataCloneError');
    vi.stubGlobal(
      'Worker',
      class extends Worker {
        constructor(...args) {
          super(...args);
          this.postMessage.mockImplementation(() => {
            throw failure;
          });
        }
      }
    );
    await expect(new WorkerCapture().run(request)).rejects.toBe(failure);
    expect(workers[0].terminate).toHaveBeenCalledOnce();
  });
  it('reports missing worker capability before starting a job', async () => {
    vi.stubGlobal('Worker', undefined);
    await expect(new WorkerCapture().run(request)).rejects.toMatchObject({
      code: 'CAPTURE_UNAVAILABLE',
    });
    expect(workers).toHaveLength(0);
  });
});
