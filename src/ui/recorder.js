/**
 * Video export.
 *
 * Two strategies, in order:
 *
 *  1. **WebCodecs via Mediabunny** — the export drives the animation itself at a fixed
 *     `dt = 1/fps`, so the result is frame-exact and can encode faster than real time.
 *  2. **MediaRecorder** — real-time `captureStream` fallback for browsers without
 *     `VideoEncoder` or an encodable codec. Cannot guarantee frame timing.
 */
export class Recorder {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {(state: {recording: boolean, progress: number, note: string}) => void} onState
   */
  constructor(canvas, onState) {
    this.canvas = canvas;
    this.onState = onState;
    this.recording = false;
    this.aborted = false;
    this.cancelCapture = null;
  }

  /** @returns {boolean} True when WebCodecs encoding is available. */
  static supportsWebCodecs() {
    return typeof VideoEncoder !== 'undefined';
  }

  /** Request that an in-flight export stops at the next frame boundary. */
  cancel() {
    this.aborted = true;
    this.cancelCapture?.();
  }

  /**
   * Record and download a clip.
   *
   * @param {object} options
   * @param {number} options.fps
   * @param {number} options.duration Seconds.
   * @param {(dt: number) => void} options.renderFrame Advance the scene by `dt` and draw.
   *   Both strategies own the clock while the application's live loop is stopped.
   * @returns {Promise<{filename: string, strategy: string}>}
   */
  async record({ fps, duration, renderFrame }) {
    if (this.recording) throw new Error('A recording is already in progress.');
    this.recording = true;
    this.aborted = false;

    try {
      const result = Recorder.supportsWebCodecs()
        ? await this.#recordWithWebCodecs({ fps, duration, renderFrame })
        : await this.#recordWithMediaRecorder({ fps, duration, renderFrame });
      return result;
    } finally {
      this.recording = false;
      this.#report(false, 0, '');
    }
  }

  /**
   * @param {boolean} recording
   * @param {number} progress 0..1
   * @param {string} note
   */
  #report(recording, progress, note) {
    this.onState?.({ recording, progress, note });
  }

  /**
   * Deterministic offline export. The scene is stepped by exactly `1/fps` per frame, so
   * the output contains precisely `duration * fps` frames regardless of how fast the
   * machine renders them.
   *
   * @param {{fps: number, duration: number, renderFrame: (dt: number) => void}} options
   */
  async #recordWithWebCodecs({ fps, duration, renderFrame }) {
    this.#report(true, 0, 'preparing encoder');

    // Loaded on demand: the encoder is a large dependency and most sessions never export.
    const { encode, selectCodec } = await import('./webcodecs-export.js');

    const codec = await selectCodec(this.canvas);
    if (this.aborted) throw cancelled();
    if (!codec) {
      return this.#recordWithMediaRecorder({ fps, duration, renderFrame });
    }

    const { blob, extension } = await encode({
      canvas: this.canvas,
      codec,
      fps,
      duration,
      renderFrame,
      onProgress: (progress) =>
        this.#report(true, progress, `${codec.toUpperCase()} · frame-exact`),
      isAborted: () => this.aborted,
    });

    if (this.aborted) throw cancelled();
    const filename = `orbital-canvas-${timestamp()}.${extension}`;
    download(blob, filename);
    return { filename, strategy: `webcodecs:${codec}` };
  }

  /**
   * Real-time fallback. Frame timing is at the browser's discretion, so the clip may drop
   * frames under load; used when WebCodecs has no usable encoder.
   *
   * @param {{fps: number, duration: number, renderFrame: (dt: number) => void}} options
   */
  async #recordWithMediaRecorder({ fps, duration, renderFrame }) {
    if (typeof MediaRecorder === 'undefined' || !this.canvas.captureStream) {
      throw new Error('This browser supports neither WebCodecs nor MediaRecorder capture.');
    }

    const stream = this.canvas.captureStream(fps);
    let recorder;
    let rafId = null;
    try {
      const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find(
        (type) => MediaRecorder.isTypeSupported(type)
      );
      recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const chunks = [];
      recorder.addEventListener('dataavailable', (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      });

      await new Promise((resolve, reject) => {
        recorder.addEventListener('stop', resolve, { once: true });
        recorder.addEventListener(
          'error',
          (event) => reject(event.error ?? new Error('Capture failed.')),
          {
            once: true,
          }
        );
        // Cancellation must also work in a background tab where rAF is suspended.
        this.cancelCapture = () => reject(cancelled());
        const startedAt = performance.now();
        let previousElapsed = 0;
        const tick = (now) => {
          rafId = null;
          try {
            const elapsed = Math.min(duration, Math.max(0, (now - startedAt) / 1000));
            renderFrame(elapsed - previousElapsed);
            previousElapsed = elapsed;
            this.#report(true, elapsed / duration, 'MediaRecorder · real time');
            if (this.aborted) this.cancelCapture();
            else if (elapsed >= duration) recorder.stop();
            else rafId = requestAnimationFrame(tick);
          } catch (error) {
            reject(error);
          }
        };
        recorder.start();
        this.#report(true, 0, 'MediaRecorder · real time');
        rafId = requestAnimationFrame(tick);
      });

      if (this.aborted) throw cancelled();
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

/** @returns {DOMException} The error an export rejects with when cancelled. */
export function cancelled() {
  return new DOMException('Recording cancelled', 'AbortError');
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
