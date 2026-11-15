import { CaptureScene, validateCaptureSpec } from './capture.js';
import { validateDocument } from './permalink.js';

let started = false;

self.onmessage = async ({ data }) => {
  if (started || data?.type !== 'start') return;
  started = true;
  const { jobId } = data;
  const send = (type, fields = {}, transfer = []) =>
    self.postMessage({ type, jobId, ...fields }, transfer);
  try {
    const spec = validateCaptureSpec(data.spec);
    const document = validateDocument(data.document);
    if (
      typeof OffscreenCanvas !== 'function' ||
      typeof VideoEncoder !== 'function' ||
      typeof VideoFrame !== 'function' ||
      typeof VideoEncoder.isConfigSupported !== 'function'
    ) {
      send('unavailable', { message: 'Worker video encoding is unavailable in this browser.' });
      return;
    }
    const canvas = new OffscreenCanvas(spec.width, spec.height);
    if (!canvas.getContext('2d', { alpha: false, willReadFrequently: true })) {
      send('unavailable', { message: 'Worker canvas rendering is unavailable in this browser.' });
      return;
    }
    send('phase', { phase: 'probing' });
    const { selectCodec, encode } = await import('./webcodecs-export.js');
    const codec = await selectCodec(canvas, spec);
    if (!codec) {
      send('unavailable', { message: 'No working video encoder supports this capture.' });
      return;
    }
    // Probing uses separate output resources; the exported simulation always starts fresh.
    const scene = new CaptureScene(document, canvas);
    send('phase', { phase: 'encoding', codec });
    let lastProgressAt = -Infinity;
    const result = await encode({
      canvas,
      codec,
      fps: spec.fps,
      duration: spec.duration,
      renderFrame: (dt) => scene.render(dt),
      onProgress: (progress) => {
        const now = performance.now();
        if (progress < 1 && now - lastProgressAt < 100) return;
        lastProgressAt = now;
        send('progress', { progress, codec });
      },
      onPhase: (phase) => send('phase', { phase, codec }),
    });
    send('complete', { result: { ...result, codec } }, [result.buffer]);
  } catch (error) {
    send('error', { message: error.message || 'Video encoding failed.', code: error.code });
  }
};
