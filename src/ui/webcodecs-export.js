import {
  BufferTarget,
  CanvasSource,
  getFirstEncodableVideoCodec,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  WebMOutputFormat,
} from 'mediabunny';
import { cancelled } from './recorder.js';

/**
 * WebCodecs export, isolated in its own module.
 *
 * The imports above are static so the bundler can tree-shake Mediabunny down to the muxers
 * actually used; `recorder.js` reaches this module through a dynamic `import()`, which keeps
 * the whole encoder out of the initial page load. Destructuring a dynamic namespace import
 * directly would defeat tree-shaking and pull in every demuxer too.
 */

/** Codecs tried in order of preference. */
const CODEC_PREFERENCE = ['avc', 'av1', 'vp9', 'vp8'];

/** Container to use per codec. */
const CONTAINER = {
  avc: { format: () => new Mp4OutputFormat(), extension: 'mp4' },
  av1: { format: () => new Mp4OutputFormat(), extension: 'mp4' },
  vp9: { format: () => new WebMOutputFormat(), extension: 'webm' },
  vp8: { format: () => new WebMOutputFormat(), extension: 'webm' },
};

/**
 * Pick the best codec this browser can actually encode at the given canvas size.
 *
 * @param {HTMLCanvasElement} canvas
 * @returns {Promise<string|null>} Codec id, or null when none is encodable.
 */
export function selectCodec(canvas) {
  return getFirstEncodableVideoCodec([...CODEC_PREFERENCE], {
    width: canvas.width,
    height: canvas.height,
    bitrate: QUALITY_HIGH,
  });
}

/**
 * Encode a fixed number of frames, driving the animation at a constant `dt`.
 *
 * Because the exporter owns the clock, the output contains exactly `duration * fps` frames
 * no matter how long each frame takes to render, and encoding can run faster than real
 * time. `MediaRecorder` cannot offer either property.
 *
 * @param {object} options
 * @param {HTMLCanvasElement} options.canvas
 * @param {string} options.codec
 * @param {number} options.fps
 * @param {number} options.duration Seconds.
 * @param {(dt: number) => void} options.renderFrame
 * @param {(progress: number) => void} options.onProgress
 * @param {() => boolean} options.isAborted Polled at each frame boundary.
 * @returns {Promise<{blob: Blob, extension: string}>}
 * @throws {DOMException} `AbortError` when cancelled.
 */
export async function encode({ canvas, codec, fps, duration, renderFrame, onProgress, isAborted }) {
  const container = CONTAINER[codec] ?? CONTAINER.avc;
  const target = new BufferTarget();
  const output = new Output({ format: container.format(), target });
  const source = new CanvasSource(canvas, { codec, bitrate: QUALITY_HIGH });

  const totalFrames = Math.max(1, Math.round(duration * fps));
  const dt = 1 / fps;

  try {
    output.addVideoTrack(source, { frameRate: fps });
    await output.start();
    for (let frame = 0; frame < totalFrames; frame++) {
      if (isAborted()) throw cancelled();
      renderFrame(dt);
      if (isAborted()) throw cancelled();
      // Awaiting is the backpressure signal: it resolves once the encoder and writer are
      // ready for more, and it yields so the progress indicator can repaint.
      await source.add(frame * dt, dt);
      if (isAborted()) throw cancelled();
      onProgress((frame + 1) / totalFrames);
    }
    await output.finalize();
  } catch (error) {
    await output.cancel();
    throw error;
  }

  return {
    blob: new Blob([target.buffer], { type: output.format.mimeType }),
    extension: container.extension,
  };
}
