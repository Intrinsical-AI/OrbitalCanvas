import {
  BufferTarget,
  canEncodeVideo,
  CanvasSource,
  Mp4OutputFormat,
  Output,
  WebMOutputFormat,
} from 'mediabunny';
import { FILE_LIMIT, PAYLOAD_LIMIT } from './capture.js';

/**
 * WebCodecs export, isolated in its own module.
 *
 * The imports above are static so the bundler can tree-shake Mediabunny down to the muxers
 * actually used; the capture worker reaches this module through a dynamic import, which keeps
 * the whole encoder out of the initial page load. Destructuring a dynamic namespace import
 * directly would defeat tree-shaking and pull in every demuxer too.
 */

/** Codecs tried in order of preference. */
const CODEC_PREFERENCE = ['avc', 'av1', 'vp9', 'vp8'];
const REFERENCE_PIXELS = 1920 * 1080;
const BITRATE_FACTOR = { avc: 1, av1: 0.4, vp9: 0.6, vp8: 1.2 };

// H.264 Annex A: frame size, macroblocks per second and Main-profile bitrate.
const AVC_LEVELS = [
  { level: '1e', maxFrame: 1620, maxRate: 40500, maxBitrate: 10_000_000 },
  { level: '1f', maxFrame: 3600, maxRate: 108000, maxBitrate: 14_000_000 },
  { level: '20', maxFrame: 5120, maxRate: 216000, maxBitrate: 20_000_000 },
  { level: '28', maxFrame: 8192, maxRate: 245760, maxBitrate: 20_000_000 },
  { level: '2a', maxFrame: 8704, maxRate: 522240, maxBitrate: 50_000_000 },
  { level: '33', maxFrame: 36864, maxRate: 983040, maxBitrate: 240_000_000 },
];

// AV1 Annex A: picture size, dimensions, display rate and Main-tier bitrate.
// FPS must participate in level selection: 1080p60 exceeds level 4.0's display rate.
const AV1_LEVELS = [
  {
    level: '04',
    maxFrame: 665856,
    maxWidth: 4352,
    maxHeight: 2448,
    maxRate: 19_975_680,
    maxBitrate: 6_000_000,
  },
  {
    level: '05',
    maxFrame: 1065024,
    maxWidth: 5504,
    maxHeight: 3096,
    maxRate: 31_950_720,
    maxBitrate: 10_000_000,
  },
  {
    level: '08',
    maxFrame: 2359296,
    maxWidth: 6144,
    maxHeight: 3456,
    maxRate: 70_778_880,
    maxBitrate: 12_000_000,
  },
  {
    level: '09',
    maxFrame: 2359296,
    maxWidth: 6144,
    maxHeight: 3456,
    maxRate: 141_557_760,
    maxBitrate: 20_000_000,
  },
  {
    level: '12',
    maxFrame: 8912896,
    maxWidth: 8192,
    maxHeight: 4352,
    maxRate: 267_386_880,
    maxBitrate: 30_000_000,
  },
];

/** Build one encoding policy for capability checks and the actual encoder. */
function encodingOptions(canvas, codec, fps) {
  const { width, height } = canvas;
  if (
    !Number.isInteger(width) ||
    width <= 0 ||
    width > 1920 ||
    !Number.isInteger(height) ||
    height <= 0 ||
    height > 1920 ||
    width * height > REFERENCE_PIXELS ||
    !Number.isFinite(fps) ||
    fps <= 0 ||
    fps > 120
  )
    throw new RangeError(
      'Capture requires dimensions up to 1920 pixels / Full HD and FPS up to 120.'
    );
  if (!Object.hasOwn(BITRATE_FACTOR, codec)) throw new RangeError('Unknown capture codec.');

  const pixels = width * height;
  const bitrate = Math.max(
    1,
    Math.round(6_000_000 * (pixels / REFERENCE_PIXELS) * (fps / 30) * BITRATE_FACTOR[codec])
  );
  let fullCodecString;
  if (codec === 'avc') {
    const columns = Math.ceil(width / 16);
    const rows = Math.ceil(height / 16);
    const macroblocks = columns * rows;
    const level = AVC_LEVELS.find(
      (entry) =>
        macroblocks <= entry.maxFrame &&
        macroblocks * fps <= entry.maxRate &&
        columns ** 2 <= entry.maxFrame * 8 &&
        rows ** 2 <= entry.maxFrame * 8 &&
        bitrate <= entry.maxBitrate
    );
    if (!level) throw new RangeError('Capture exceeds the supported H.264 levels.');
    fullCodecString = `avc1.4d00${level.level}`;
  } else if (codec === 'av1') {
    const level = AV1_LEVELS.find(
      (entry) =>
        pixels <= entry.maxFrame &&
        width <= entry.maxWidth &&
        height <= entry.maxHeight &&
        pixels * fps <= entry.maxRate &&
        bitrate <= entry.maxBitrate
    );
    if (!level) throw new RangeError('Capture exceeds the supported AV1 levels.');
    fullCodecString = `av01.0.${level.level}M.08`;
  }
  return { bitrate, alpha: 'discard', ...(fullCodecString ? { fullCodecString } : {}) };
}

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
 * @param {HTMLCanvasElement|OffscreenCanvas} canvas
 * @param {{fps?: number, format?: 'share'|'auto'}} options
 * @returns {Promise<string|null>} Codec id, or null when none is encodable.
 */
export async function selectCodec(canvas, { fps = 30, format = 'share' } = {}) {
  if (format !== 'share' && format !== 'auto') throw new RangeError('Unknown capture format.');
  if (typeof VideoEncoder === 'undefined') return null;
  for (const codec of format === 'share' ? ['avc'] : CODEC_PREFERENCE) {
    const options = encodingOptions(canvas, codec, fps);
    // Mediabunny's public probe omits framerate. Check the exact MP4 codec/FPS first,
    // then retain its real-frame Firefox probe and encoder cleanup.
    if (
      options.fullCodecString &&
      !(
        await VideoEncoder.isConfigSupported({
          codec: options.fullCodecString,
          width: canvas.width,
          height: canvas.height,
          bitrate: options.bitrate,
          alpha: options.alpha,
          framerate: fps,
        })
      ).supported
    )
      continue;
    if (
      (await canEncodeVideo(codec, {
        width: canvas.width,
        height: canvas.height,
        ...options,
      })) &&
      (await probeFrame(canvas, codec, fps, options))
    )
      return codec;
  }
  return null;
}

/** Probe the exact track FPS through the same source/configuration as the final export. */
async function probeFrame(canvas, codec, fps, options) {
  const output = new Output({ format: CONTAINER[codec].format(), target: new BufferTarget() });
  let packets = 0;
  const source = new CanvasSource(canvas, {
    codec,
    ...options,
    onEncodedPacket: () => {
      packets++;
    },
  });
  try {
    output.addVideoTrack(source, { frameRate: fps });
    await output.start();
    await source.add(0, 1 / fps);
    await output.finalize();
    return packets > 0;
  } catch {
    try {
      await output.cancel();
    } catch (error) {
      console.error('Capture probe cleanup failed', error);
    }
    return false;
  }
}

/**
 * Encode a fixed number of frames, driving the animation at a constant `dt`.
 *
 * Because the exporter owns the clock, the output contains exactly `duration * fps` frames
 * no matter how long each frame takes to render, and encoding can run faster than real
 * time. `MediaRecorder` cannot offer either property.
 *
 * @param {object} options
 * @param {HTMLCanvasElement|OffscreenCanvas} options.canvas
 * @param {string} options.codec
 * @param {number} options.fps
 * @param {number} options.duration Seconds.
 * @param {(dt: number) => void} options.renderFrame
 * @param {(progress: number) => void} options.onProgress
 * @param {(phase: string) => void} [options.onPhase]
 * @returns {Promise<{buffer: ArrayBuffer, mimeType: string, extension: string, frames: number}>}
 */
export async function encode({
  canvas,
  codec,
  fps,
  duration,
  renderFrame,
  onProgress,
  onPhase,
  payloadLimit = PAYLOAD_LIMIT,
}) {
  const options = encodingOptions(canvas, codec, fps);
  const container = CONTAINER[codec];
  const target = new BufferTarget();
  const output = new Output({ format: container.format(), target });
  let payloadBytes = 0;
  let sizeError = null;
  const source = new CanvasSource(canvas, {
    codec,
    ...options,
    onEncodedPacket(packet) {
      payloadBytes += packet.data.byteLength;
      if (payloadBytes > payloadLimit)
        sizeError = new Error(
          'Capture exceeded the 60 MiB limit. Reduce duration, FPS or resolution.'
        );
    },
  });

  const totalFrames = Math.max(1, Math.round(duration * fps));
  const dt = 1 / fps;

  try {
    output.addVideoTrack(source, { frameRate: fps });
    await output.start();
    for (let frame = 0; frame < totalFrames; frame++) {
      renderFrame(frame === 0 ? 0 : dt);
      // Awaiting is the backpressure signal: it resolves once the encoder and writer are
      // ready for more, and it yields so the progress indicator can repaint.
      await source.add(frame * dt, dt);
      if (sizeError) throw sizeError;
      onProgress?.((frame + 1) / totalFrames);
    }
    onPhase?.('finalizing');
    await output.finalize();
    if (sizeError) throw sizeError;
  } catch (error) {
    try {
      await output.cancel();
    } catch (cleanupError) {
      console.error('Capture cleanup failed', cleanupError);
    }
    throw error;
  }

  if (!target.buffer?.byteLength) throw new Error('Capture produced no video data.');
  if (target.buffer.byteLength > FILE_LIMIT)
    throw new Error('Capture exceeded the 64 MiB file limit.');
  return {
    buffer: target.buffer,
    mimeType: output.format.mimeType,
    extension: container.extension,
    frames: totalFrames,
  };
}
