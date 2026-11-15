import { CaptureScene, PAYLOAD_LIMIT, validateCaptureSpec } from './capture.js';
import { WorkerCapture } from './worker-client.js';
import { cancelled } from './capture-errors.js';

/** Owns a cancellable worker export, or an explicitly allowed real-time fallback. */
export class Recorder {
  constructor(canvas, onState) {
    this.canvas = canvas;
    this.onState = onState;
    this.recording = false;
    this.fallback = false;
    this.aborted = false;
    this.cancelCapture = null;
    this.workerTask = null;
  }

  cancel(reason = cancelled()) {
    if (!this.recording) return;
    this.aborted = true;
    this.abortReason = reason;
    this.cancelCapture?.(reason);
  }

  /** No page-thread encoder or simulation callback is retained by the worker job. */
  async record({
    document,
    width = this.canvas.width,
    height = this.canvas.height,
    format = 'share',
    fps,
    duration,
  }) {
    if (this.recording) throw new Error('A recording is already in progress.');
    const spec = validateCaptureSpec({ width, height, format, fps, duration });
    this.recording = true;
    this.fallback = false;
    this.aborted = false;
    this.abortReason = null;
    try {
      this.#report(true, 0, 'preparing encoder');
      this.workerTask = new WorkerCapture((state) => {
        const progress =
          state.type === 'progress' ? state.progress : state.phase === 'finalizing' ? 1 : 0;
        const note =
          state.phase === 'finalizing'
            ? 'Finalizing video'
            : state.codec
              ? `${state.codec.toUpperCase()} · frame-exact`
              : 'preparing encoder';
        this.#report(true, progress, note);
      });
      this.cancelCapture = (reason) => this.workerTask?.cancel(reason);
      let encoded;
      try {
        encoded = await this.workerTask.run({ document, spec });
      } catch (error) {
        if (this.aborted) throw this.abortReason;
        if (error.code !== 'CAPTURE_UNAVAILABLE') throw error;
        if (format === 'share') throw sharingUnavailable();
        return await this.#recordWithMediaRecorder({ document, ...spec });
      }
      if (this.aborted) throw this.abortReason;
      const blob = new Blob([encoded.buffer], { type: encoded.mimeType });
      const filename = `orbital-canvas-${timestamp()}.${encoded.extension}`;
      download(blob, filename);
      return { filename, strategy: `webcodecs:${encoded.codec}` };
    } finally {
      this.workerTask = null;
      this.cancelCapture = null;
      this.recording = false;
      this.fallback = false;
      this.#report(false, 0, '');
    }
  }

  #report(recording, progress, note) {
    this.onState?.({ recording, progress, note });
  }

  /** Real-time is selected only for capability failure before deterministic encoding starts. */
  async #recordWithMediaRecorder({ document: captureDocument, width, height, fps, duration }) {
    this.fallback = true;
    if (typeof MediaRecorder === 'undefined' || !this.canvas.captureStream)
      throw new Error('This browser supports neither WebCodecs nor MediaRecorder capture.');
    if ((this.canvas.ownerDocument ?? globalThis.document)?.hidden)
      throw new Error('Real-time capture needs a visible tab. Keep this tab open and try again.');
    this.canvas.width = width;
    this.canvas.height = height;
    const scene = new CaptureScene(captureDocument, this.canvas);
    const stream = this.canvas.captureStream(fps);
    let recorder;
    let rafId = null;
    try {
      const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find(
        (type) => MediaRecorder.isTypeSupported(type)
      );
      recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const chunks = [];
      let payloadBytes = 0;
      let rejectCapture;
      recorder.addEventListener('dataavailable', (event) => {
        payloadBytes += event.data.size;
        if (payloadBytes > PAYLOAD_LIMIT)
          rejectCapture?.(
            new Error('Capture exceeded the 60 MiB limit. Reduce duration, FPS or resolution.')
          );
        else if (event.data.size > 0) chunks.push(event.data);
      });
      await new Promise((resolve, reject) => {
        rejectCapture = reject;
        recorder.addEventListener('stop', resolve, { once: true });
        recorder.addEventListener(
          'error',
          (event) => reject(event.error ?? new Error('Capture failed.')),
          { once: true }
        );
        this.cancelCapture = (reason = cancelled()) => reject(reason);
        const startedAt = performance.now();
        let previousElapsed = 0;
        let renderedFrame = 0;
        const tick = (now) => {
          rafId = null;
          try {
            if (this.aborted) {
              reject(this.abortReason);
              return;
            }
            const elapsed = Math.min(duration, Math.max(0, (now - startedAt) / 1000));
            const dueFrame = Math.floor(elapsed * fps + 1e-7);
            if (dueFrame > renderedFrame || elapsed >= duration) {
              scene.render(elapsed - previousElapsed);
              previousElapsed = elapsed;
              renderedFrame = dueFrame;
              this.#report(true, elapsed / duration, 'MediaRecorder · real time');
            }
            if (elapsed >= duration) recorder.stop();
            else rafId = requestAnimationFrame(tick);
          } catch (error) {
            reject(error);
          }
        };
        recorder.start(250);
        this.#report(true, 0, 'MediaRecorder · real time');
        rafId = requestAnimationFrame(tick);
      });
      if (this.aborted) throw this.abortReason;
      const actualType = recorder.mimeType || chunks.find((chunk) => chunk.type)?.type || mimeType;
      const extension = { 'video/webm': 'webm', 'video/mp4': 'mp4' }[
        actualType?.split(';')[0].trim().toLowerCase()
      ];
      if (!extension) throw new Error(`Unsupported capture format: ${actualType || 'unknown'}.`);
      const blob = new Blob(chunks, { type: actualType });
      if (!blob.size) throw new Error('Capture produced no video data.');
      const filename = `orbital-canvas-${timestamp()}.${extension}`;
      download(blob, filename);
      return { filename, strategy: 'mediarecorder' };
    } finally {
      this.cancelCapture = null;
      if (rafId !== null) cancelAnimationFrame(rafId);
      try {
        if (recorder && recorder.state !== 'inactive') recorder.stop();
      } finally {
        for (const track of stream.getTracks()) track.stop();
      }
    }
  }
}

function sharingUnavailable() {
  return new Error(
    'H.264/MP4 encoding is unavailable in this browser. Try another browser or choose Automatic for other video formats.'
  );
}

/** @returns {string} Filesystem-safe UTC timestamp. */
export function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

/**
 * @param {Blob} blob
 * @param {string} filename
 */
export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  // Revoke on the next task so the browser has picked the URL up first.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
