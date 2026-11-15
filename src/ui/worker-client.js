import { cancelled, unavailable } from './capture-errors.js';

let nextJobId = 0;

/** One worker owns one export. The page can always end it without awaiting native code. */
export class WorkerCapture {
  constructor(onState) {
    this.onState = onState;
    this.job = null;
  }

  run(request) {
    if (this.job) throw new Error('A worker capture is already in progress.');
    if (typeof Worker !== 'function')
      return Promise.reject(unavailable('This browser cannot start a capture worker.'));
    let worker;
    try {
      worker = new Worker(new URL('./capture-worker.js', import.meta.url), { type: 'module' });
    } catch {
      return Promise.reject(unavailable('This browser could not start a capture worker.'));
    }
    return new Promise((resolve, reject) => {
      const jobId = ++nextJobId;
      this.job = { worker, jobId, resolve, reject };
      worker.onmessage = ({ data }) => {
        if (this.job?.jobId !== jobId || data?.jobId !== jobId) return;
        if (data.type === 'complete') this.finish(null, data.result);
        else if (data.type === 'unavailable') this.finish(unavailable(data.message));
        else if (data.type === 'error')
          this.finish(
            Object.assign(new Error(data.message || 'Video encoding failed.'), { code: data.code })
          );
        else if (data.type === 'progress' || data.type === 'phase') this.onState?.(data);
      };
      worker.onerror = (event) => {
        if (this.job?.jobId !== jobId) return;
        event.preventDefault?.();
        this.finish(new Error(event.message || 'The capture worker failed to load or encode.'));
      };
      worker.onmessageerror = () => {
        if (this.job?.jobId === jobId)
          this.finish(new Error('The capture worker returned an unreadable result.'));
      };
      try {
        worker.postMessage({ type: 'start', jobId, ...request });
      } catch (error) {
        this.finish(error);
      }
    });
  }

  finish(error, result) {
    const job = this.job;
    if (!job) return;
    this.job = null;
    job.worker.onmessage = job.worker.onerror = job.worker.onmessageerror = null;
    job.worker.terminate();
    if (error) job.reject(error);
    else job.resolve(result);
  }

  cancel(reason = cancelled()) {
    this.finish(reason);
  }
}
