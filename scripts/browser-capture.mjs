import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect } from './browser-helpers.mjs';

async function closeCapture(h, page, context) {
  try {
    const state = await page.evaluate(() => {
      const field = (id) => document.getElementById(id);
      const app = window.smokeApp;
      return {
        name: 'capture_state',
        clicks: window.captureExportClicks,
        pointerEvents: window.capturePointerEvents,
        exporting: app?.capture?.exporting,
        recording: app?.capture?.recorder?.recording,
        fallback: app?.capture?.recorder?.fallback,
        specification: app?.capture?.spec,
        workerJobId: app?.capture?.recorder?.workerTask?.job?.jobId,
        workers: window.captureWorkers?.map((worker) => ({ ended: worker.ended })),
        workerEvents: window.captureWorkerEvents?.slice(-10),
        workerStates: window.captureWorkerStates?.slice(-10),
        error: field('captureError').textContent,
        progress: field('recordingIndicator').textContent,
        exportDisabled: field('exportButton').disabled,
        videoEncoder: typeof VideoEncoder,
        mediaRecorder: typeof MediaRecorder,
        captureStream: typeof HTMLCanvasElement.prototype.captureStream,
        supportedMimeTypes:
          typeof MediaRecorder === 'undefined'
            ? []
            : ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/mp4'].filter((type) =>
                MediaRecorder.isTypeSupported(type)
              ),
        preview: [field('capturePreview').width, field('capturePreview').height],
      };
    });
    h.receipts.push(state);
    process.stdout.write('Capture diagnostics: ' + JSON.stringify(state) + '\n');
  } catch (error) {
    process.stdout.write('Capture diagnostics unavailable: ' + error.message + '\n');
  } finally {
    await context.close();
  }
}

async function clickExport(page) {
  const before = await page.evaluate(() => window.captureExportClicks);
  await page.locator('#exportButton').click();
  await expect.poll(() => page.evaluate(() => window.captureExportClicks)).toBe(before + 1);
}

async function setup(h, options = {}) {
  const result = await h.page({ viewport: { width: 640, height: 560 }, ...options });
  const { page } = result;
  await page.evaluate(
    ({ fallback }) => {
      window.captureTracks = [];
      window.captureWorkers = [];
      window.captureWorkerEvents = [];
      window.captureWorkerStates = [];
      const NativeWorker = window.Worker;
      if (fallback)
        Object.defineProperty(window, 'Worker', { value: undefined, configurable: true });
      else if (NativeWorker)
        window.Worker = class extends NativeWorker {
          constructor(...args) {
            super(...args);
            if (!String(args[0]).includes('capture-worker')) return;
            this.ended = false;
            window.captureWorkers.push(this);
            this.addEventListener('message', ({ data }) => {
              if (data.type === 'worker-probe') window.captureWorkerEvents.push(data);
              if (data.type === 'phase' || data.type === 'progress') {
                window.captureWorkerStates.push(data);
                if (window.captureWorkerStates.length > 10) window.captureWorkerStates.shift();
              }
            });
          }
          terminate() {
            this.ended = true;
            super.terminate();
          }
        };
      const original = HTMLCanvasElement.prototype.captureStream;
      HTMLCanvasElement.prototype.captureStream = function (...args) {
        const stream = original.apply(this, args);
        window.captureTracks.push(...stream.getTracks());
        return stream;
      };
    },
    { fallback: options.fallback === true }
  );
  await page.locator('#captureButton').click();
  await page.locator('#captureType').selectOption('video');
  await page.locator('#videoFormatInput').selectOption('auto');
  await page.locator('#fpsInput').selectOption('30');
  await page.locator('#durationInput').fill('2');
  await page.locator('#durationInput').dispatchEvent('change');
  return result;
}

async function workerCapabilities(page) {
  return page.evaluate(async () => {
    if (typeof Worker !== 'function') return false;
    const url = URL.createObjectURL(
      new Blob(
        [
          `postMessage(typeof OffscreenCanvas === 'function' && typeof VideoEncoder === 'function' && typeof VideoFrame === 'function')`,
        ],
        { type: 'text/javascript' }
      )
    );
    let worker, timer;
    try {
      worker = new Worker(url, { type: 'module' });
      return await new Promise((resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Worker capability probe timed out after 12 seconds.')),
          12000
        );
        worker.onmessage = ({ data }) => resolve(data);
        worker.onmessageerror = () =>
          reject(new Error('Worker capability probe returned an unreadable message.'));
        worker.onerror = (event) => {
          event.preventDefault();
          reject(
            new Error(
              'Worker capability probe failed: ' + (event.message || 'Unknown worker error.')
            )
          );
        };
      });
    } finally {
      clearTimeout(timer);
      worker?.terminate();
      URL.revokeObjectURL(url);
    }
  });
}

async function probeWorker(page, mode) {
  const modes = Array.isArray(mode) ? [...mode] : [mode];
  await page.route(/capture-worker[^/]*\.js(?:\?.*)?$/, async (route) => {
    const response = await route.fetch();
    const injection = modes.shift() ?? 'normal';
    const prefix = `(${function install(mode) {
      const encoders = [],
        closes = [];
      let exporting = false,
        release;
      const post = self.postMessage.bind(self);
      self.postMessage = (message, ...args) => {
        if (message.type === 'phase' && message.phase === 'encoding') exporting = true;
        if (message.type === 'error' || message.type === 'complete')
          post({
            type: 'worker-probe',
            kind: 'resources',
            states: encoders.map((encoder) => encoder.state),
            closes: encoders.map((encoder) => closes.filter((closed) => closed === encoder).length),
          });
        post(message, ...args);
      };
      const proto = VideoEncoder.prototype;
      const original = { configure: proto.configure, close: proto.close, flush: proto.flush };
      proto.configure = function (...args) {
        if (!encoders.includes(this)) encoders.push(this);
        return original.configure.apply(this, args);
      };
      proto.close = function (...args) {
        closes.push(this);
        return original.close.apply(this, args);
      };
      proto.flush = function (...args) {
        if (!exporting || mode === 'normal') return original.flush.apply(this, args);
        post({ type: 'worker-probe', kind: 'flush' });
        if (mode === 'fail')
          return Promise.reject(new Error('Injected native encoder flush failure'));
        return new Promise((resolve) => {
          release = resolve;
        }).then(() => original.flush.apply(this, args));
      };
      self.addEventListener('message', ({ data }) => {
        if (data.type === 'release-probe') release?.();
      });
    }.toString()})(${JSON.stringify(injection)});\n`;
    await route.fulfill({ response, body: prefix + (await response.text()) });
  });
}

async function videoReceipt(h, download, name, exact = true) {
  const file = path.join(h.artifacts, name + path.extname(download.suggestedFilename()));
  await download.saveAs(file);
  const probe = JSON.parse(
    execFileSync(
      'ffprobe',
      [
        '-v',
        'error',
        '-count_frames',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=codec_name,pix_fmt,nb_read_frames,r_frame_rate,width,height:format=duration',
        '-of',
        'json',
        file,
      ],
      { encoding: 'utf8' }
    )
  );
  const stream = probe.streams[0],
    frames = Number(stream.nb_read_frames);
  if (exact) {
    assert.equal(frames, 60);
    assert.equal(stream.r_frame_rate, '30/1');
  } else assert.ok(frames > 1);
  const hashes = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'framemd5', '-'], {
    encoding: 'utf8',
  })
    .split('\n')
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.split(',').at(-1).trim());
  assert.ok(new Set(hashes).size > 1, 'video must contain advancing frames');
  h.receipts.push({
    name,
    file,
    frames,
    width: stream.width,
    height: stream.height,
    duration: probe.format.duration,
    uniqueFrames: new Set(hashes).size,
  });
  return stream;
}

export function captureCases(get) {
  test('PNG preserves the exact artwork buffer including trails', async () => {
    const { page, context } = await get().page();
    try {
      await page.evaluate(() => {
        const app = window.smokeApp;
        app.stop();
        for (let i = 0; i < 90; i++) app.advance(1 / 60);
      });
      await page.locator('#captureButton').click();
      const expected = await page.evaluate(
        () => window.smokeApp.capture.pngFrame.toDataURL().split(',')[1]
      );
      const pending = page.waitForEvent('download');
      await clickExport(page);
      const download = await pending,
        file = path.join(get().artifacts, 'exact-frame.png');
      await download.saveAs(file);
      assert.deepEqual(await readFile(file), Buffer.from(expected, 'base64'));
      get().receipts.push({ name: 'exact_png', file });
    } finally {
      await closeCapture(get(), page, context);
    }
  });
  test('built worker handles native flush failure and recovers on a fresh export', async (t) => {
    const { page, context, errors } = await setup(get(), { source: false });
    try {
      if (!(await workerCapabilities(page))) {
        t.skip('Worker WebCodecs is unavailable; real-time capture is exercised separately.');
        return;
      }
      await probeWorker(page, 'fail');
      await clickExport(page);
      await expect(page.locator('#captureError')).toContainText(
        'Injected native encoder flush failure'
      );
      await expect(page.locator('#exportButton')).toBeEnabled();
      const resources = await page.evaluate(() =>
        window.captureWorkerEvents.find((event) => event.kind === 'resources')
      );
      assert.ok(
        resources.states.length > 0 && resources.states.every((state) => state === 'closed')
      );
      assert.ok(resources.closes.every((count) => count === 1));
      const pending = page.waitForEvent('download');
      await clickExport(page);
      await videoReceipt(get(), await pending, 'worker-recovery');
      assert.ok(await page.evaluate(() => window.captureWorkers.every((worker) => worker.ended)));
      assert.deepEqual(errors, []);
    } finally {
      await closeCapture(get(), page, context);
    }
  });
  test('cancelling a worker blocked in native flush never waits for the encoder', async (t) => {
    const { page, context, errors } = await setup(get(), { source: false });
    try {
      if (!(await workerCapabilities(page))) {
        t.skip('Worker WebCodecs is unavailable.');
        return;
      }
      await probeWorker(page, ['hold', 'normal', 'hold', 'normal', 'hold', 'normal']);
      let downloads = 0;
      page.on('download', () => downloads++);
      for (let cycle = 0; cycle < 3; cycle++) {
        await clickExport(page);
        await page.waitForFunction(
          (count) =>
            window.captureWorkerEvents.filter((event) => event.kind === 'flush').length >= count,
          cycle + 1
        );
        await page.locator('#cancelExportButton').click();
        await expect(page.locator('#captureError')).toContainText('cancelled');
        await expect(page.locator('#exportButton')).toBeEnabled();
        assert.equal(downloads, cycle);
        assert.ok(await page.evaluate(() => window.captureWorkers.every((worker) => worker.ended)));
        const pending = page.waitForEvent('download');
        await clickExport(page);
        await videoReceipt(get(), await pending, 'worker-cancel-retry-' + (cycle + 1));
        await expect(page.locator('#exportButton')).toBeEnabled();
      }
      assert.equal(downloads, 3);
      assert.ok(
        await page.evaluate(
          () =>
            window.captureWorkers.length === 6 &&
            window.captureWorkers.every((worker) => worker.ended)
        )
      );
      const closures = await page.evaluate(() =>
        window.captureWorkerEvents.filter((event) => event.kind === 'resources')
      );
      assert.equal(closures.length, 3);
      assert.ok(
        closures.every(
          (event) =>
            event.states.every((state) => state === 'closed') &&
            event.closes.every((count) => count === 1)
        )
      );
      assert.deepEqual(errors, []);
    } finally {
      await closeCapture(get(), page, context);
    }
  });
  test('detached worker survives editor resize and DPR without advancing the editor', async (t) => {
    const { page, context, errors } = await setup(get());
    try {
      if (!(await workerCapabilities(page))) {
        t.skip('Worker WebCodecs is unavailable.');
        return;
      }
      const before = await page.evaluate(() => ({
        time: window.smokeApp.scene.time,
        phases: window.smokeApp.scene.rings.map((r) => r.phase),
      }));
      await probeWorker(page, 'hold');
      const pending = page.waitForEvent('download');
      await clickExport(page);
      await page.waitForFunction(() =>
        window.captureWorkerEvents.some((event) => event.kind === 'flush')
      );
      await page.setViewportSize({ width: 700, height: 620 });
      await page.evaluate(() => {
        Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true });
        window.smokeApp.viewport.sync();
      });
      await page.evaluate(() =>
        window.captureWorkers.at(-1).postMessage({ type: 'release-probe' })
      );
      await videoReceipt(get(), await pending, 'resize-safe');
      assert.deepEqual(
        await page.evaluate(() => ({
          time: window.smokeApp.scene.time,
          phases: window.smokeApp.scene.rings.map((r) => r.phase),
        })),
        before
      );
      assert.deepEqual(errors, []);
    } finally {
      await closeCapture(get(), page, context);
    }
  });
  test('fresh export sessions reproduce frame zero after arbitrary editor motion', async () => {
    const { page, context } = await setup(get());
    try {
      const result = await page.evaluate(async () => {
        const { CaptureScene } = await import('/src/ui/capture.js');
        const doc = window.smokeApp.capture.document;
        const create = () => {
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = 320;
          return new CaptureScene(doc, canvas);
        };
        const a = create();
        const zero = a.canvas.toDataURL();
        a.render(0);
        const repeatedZero = a.canvas.toDataURL();
        for (let i = 0; i < 30; i++) a.render(1 / 30);
        const first = a.canvas.toDataURL();
        window.smokeApp.scene.step(20);
        const b = create();
        for (let i = 0; i < 30; i++) b.render(1 / 30);
        const second = b.canvas.toDataURL();
        const pixels = async (url) => {
          const image = new Image();
          image.src = url;
          await image.decode();
          const canvas = document.createElement('canvas');
          canvas.width = 320;
          canvas.height = 320;
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(image, 0, 0);
          return ctx.getImageData(0, 0, 320, 320).data;
        };
        const compareArrays = (x, y) => {
          let differingPixels = 0,
            maxDelta = 0;
          for (let i = 0; i < x.length; i += 4) {
            let differs = false;
            for (let channel = 0; channel < 4; channel++) {
              const delta = Math.abs(x[i + channel] - y[i + channel]);
              maxDelta = Math.max(maxDelta, delta);
              differs ||= delta !== 0;
            }
            if (differs) differingPixels++;
          }
          return { differingPixels, maxDelta };
        };
        const comparePixels = async (left, right) =>
          compareArrays(await pixels(left), await pixels(right));
        let workerFrameZero = null;
        if (typeof Worker === 'function') {
          const moduleUrl = new URL('/src/ui/capture.js', location.href).href;
          const source = `import { CaptureScene } from ${JSON.stringify(moduleUrl)};
            onmessage = ({data}) => {
              if (typeof OffscreenCanvas !== 'function') { postMessage(null); return; }
              const canvas = new OffscreenCanvas(320,320);
              if (!canvas.getContext('2d', {alpha:false,willReadFrequently:true})) { postMessage(null); return; }
              const capture = new CaptureScene(data, canvas);
              const pixels = capture.context.getImageData(0,0,320,320).data;
              postMessage(pixels.buffer, [pixels.buffer]);
            };`;
          const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
          let worker, timer;
          try {
            worker = new Worker(url, { type: 'module' });
            const buffer = await new Promise((resolve, reject) => {
              timer = setTimeout(
                () =>
                  reject(
                    new Error('Worker frame-zero rendering probe timed out after 12 seconds.')
                  ),
                12000
              );
              worker.onmessage = ({ data }) => resolve(data);
              worker.onmessageerror = () =>
                reject(
                  new Error('Worker frame-zero rendering probe returned an unreadable message.')
                );
              worker.onerror = (event) => {
                event.preventDefault();
                reject(
                  new Error(
                    'Worker frame-zero rendering probe failed: ' +
                      (event.message || 'Unknown worker error.')
                  )
                );
              };
              worker.postMessage(doc);
            });
            if (buffer)
              workerFrameZero = compareArrays(await pixels(zero), new Uint8ClampedArray(buffer));
          } finally {
            clearTimeout(timer);
            worker?.terminate();
            URL.revokeObjectURL(url);
          }
        }
        return {
          zeroPngEqual: zero === repeatedZero,
          timelinePngEqual: first === second,
          simulationEqual:
            JSON.stringify(a.scene.state) === JSON.stringify(b.scene.state) &&
            JSON.stringify(a.camera.pose(a.orbit)) === JSON.stringify(b.camera.pose(b.orbit)),
          contextAttributes: a.context.getContextAttributes?.(),
          liveRings: b.scene.rings.filter((r) => !r.fading).length,
          expectedLiveRings: doc.parameters.maxRings,
          zeroPixels: await comparePixels(zero, repeatedZero),
          timelinePixels: await comparePixels(first, second),
          workerFrameZero,
          images:
            zero === repeatedZero && first === second
              ? []
              : [
                  ['capture-zero.png', zero],
                  ['capture-zero-repeated.png', repeatedZero],
                  ['capture-first.png', first],
                  ['capture-second.png', second],
                ],
        };
      });
      const { images, ...diagnostic } = result;
      for (const [name, url] of images)
        await writeFile(path.join(get().artifacts, name), Buffer.from(url.split(',')[1], 'base64'));
      get().receipts.push({ name: 'capture_determinism', ...diagnostic });
      process.stdout.write('Capture determinism: ' + JSON.stringify(diagnostic) + '\n');
      assert.equal(result.zeroPngEqual, true, JSON.stringify(diagnostic));
      assert.equal(result.timelinePngEqual, true, JSON.stringify(diagnostic));
      assert.equal(result.liveRings, result.expectedLiveRings, JSON.stringify(diagnostic));
      if (result.workerFrameZero)
        assert.deepEqual(
          result.workerFrameZero,
          { differingPixels: 0, maxDelta: 0 },
          JSON.stringify(diagnostic)
        );
    } finally {
      await closeCapture(get(), page, context);
    }
  });
  test('MediaRecorder captures motion from a detached canvas and cancels on Escape', async (t) => {
    const { page, context, errors } = await setup(get(), { fallback: true, source: false });
    try {
      if (
        !(await page.evaluate(
          () =>
            typeof MediaRecorder === 'function' &&
            typeof HTMLCanvasElement.prototype.captureStream === 'function'
        ))
      ) {
        t.skip('MediaRecorder/captureStream is absent; unsupported capture is tested separately.');
        return;
      }
      const pending = page.waitForEvent('download');
      await clickExport(page);
      const download = await pending;
      await expect(page.locator('#exportButton')).toBeEnabled();
      await videoReceipt(get(), download, 'mediarecorder', false);
      await clickExport(page);
      await expect(page.locator('#cancelExportButton')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.locator('#captureError')).toContainText('cancelled');
      await expect(page.locator('#captureDialog')).toBeVisible();
      assert.ok(
        await page.evaluate(() => window.captureTracks.every((t) => t.readyState === 'ended'))
      );
      assert.deepEqual(errors, []);
    } finally {
      await closeCapture(get(), page, context);
    }
  });
  test('destroying the editor cancels capture and releases tracks without a download', async (t) => {
    const { page, context } = await setup(get(), { fallback: true });
    try {
      if (
        !(await page.evaluate(
          () =>
            typeof MediaRecorder === 'function' &&
            typeof HTMLCanvasElement.prototype.captureStream === 'function'
        ))
      ) {
        t.skip('MediaRecorder/captureStream is absent; unsupported capture is tested separately.');
        return;
      }
      let downloads = 0;
      page.on('download', () => downloads++);
      await clickExport(page);
      await expect(page.locator('#cancelExportButton')).toBeVisible();
      await page.evaluate(() => {
        window.smokeApp.destroy();
        window.smokeApp.destroy();
      });
      await page.waitForFunction(() => !window.smokeApp.capture.exporting);
      assert.equal(await page.evaluate(() => window.smokeApp.running), false);
      assert.ok(
        await page.evaluate(() => window.captureTracks.every((t) => t.readyState === 'ended'))
      );
      assert.equal(downloads, 0);
    } finally {
      await closeCapture(get(), page, context);
    }
  });
  test('H.264 sharing produces an AVC MP4 when the encoder is available', async (t) => {
    const { page, context, errors } = await setup(get());
    try {
      await page.locator('#videoFormatInput').selectOption('share');
      const supported = await page.evaluate(async () => {
        if (typeof Worker !== 'function') return false;
        const canvas = window.smokeApp.capture.previewScene.canvas;
        const moduleUrl = new URL('/src/ui/webcodecs-export.js', location.href).href;
        const source = `import { selectCodec } from ${JSON.stringify(moduleUrl)};
          if (typeof OffscreenCanvas !== 'function' || typeof VideoEncoder !== 'function' || typeof VideoFrame !== 'function') postMessage(null);
          else selectCodec(new OffscreenCanvas(${canvas.width}, ${canvas.height}), {fps:30,format:'share'}).then(codec => postMessage(codec)).catch(error => postMessage({error:error.message}));`;
        const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
        let worker, timer;
        try {
          worker = new Worker(url, { type: 'module' });
          const result = await new Promise((resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error('H.264 worker codec probe timed out after 12 seconds.')),
              12000
            );
            worker.onmessage = ({ data }) => resolve(data);
            worker.onmessageerror = () =>
              reject(new Error('H.264 worker codec probe returned an unreadable message.'));
            worker.onerror = (event) => {
              event.preventDefault();
              reject(
                new Error(
                  'H.264 worker codec probe failed: ' + (event.message || 'Unknown worker error.')
                )
              );
            };
          });
          if (result?.error) throw new Error(result.error);
          return result === 'avc';
        } finally {
          clearTimeout(timer);
          worker?.terminate();
          URL.revokeObjectURL(url);
        }
      });
      if (!supported) {
        t.skip(
          'Native H.264 encoding is unavailable; the sharing error path is tested separately.'
        );
        return;
      }
      const pending = page.waitForEvent('download');
      await clickExport(page);
      const download = await pending;
      assert.equal(path.extname(download.suggestedFilename()), '.mp4');
      const stream = await videoReceipt(get(), download, 'h264-sharing');
      assert.equal(stream.codec_name, 'h264');
      assert.equal(stream.pix_fmt, 'yuv420p');
      assert.deepEqual(errors, []);
    } finally {
      await closeCapture(get(), page, context);
    }
  });
  test('H.264 sharing reports unavailable encoding without changing the format', async () => {
    const { page, context, errors } = await setup(get(), { fallback: true, source: false });
    try {
      await page.locator('#videoFormatInput').selectOption('share');
      let downloads = 0;
      page.on('download', () => downloads++);
      await clickExport(page);
      await expect(page.locator('#captureError')).toContainText(
        'H.264/MP4 encoding is unavailable'
      );
      await expect(page.locator('#videoFormatInput')).toHaveValue('share');
      await expect(page.locator('#exportButton')).toBeEnabled();
      assert.equal(await page.evaluate(() => window.captureTracks.length), 0);
      assert.equal(downloads, 0);
      assert.deepEqual(errors, []);
    } finally {
      await closeCapture(get(), page, context);
    }
  });
  test('missing recording APIs report an error and leave capture controls usable', async () => {
    const { page, context, errors } = await setup(get(), { fallback: true });
    try {
      await page.evaluate(() => {
        Object.defineProperty(window, 'MediaRecorder', { value: undefined, configurable: true });
      });
      await clickExport(page);
      await expect(page.locator('#captureError')).toContainText(
        'neither WebCodecs nor MediaRecorder'
      );
      await expect(page.locator('#exportButton')).toBeEnabled();
      await expect(page.locator('#cancelExportButton')).not.toBeVisible();
      assert.equal(await page.evaluate(() => window.captureTracks.length), 0);
      assert.deepEqual(errors, []);
    } finally {
      await closeCapture(get(), page, context);
    }
  });
  test('capture work limits are actionable without silently changing input', async () => {
    const { page, context } = await setup(get());
    try {
      await page.locator('#resolutionInput').selectOption('landscape');
      await page.locator('#fpsInput').selectOption('120');
      await page.locator('#durationInput').fill('16');
      await page.locator('#durationInput').dispatchEvent('change');
      await expect(page.locator('#captureError')).toContainText('1–15 seconds');
      await expect(page.locator('#durationInput')).toHaveValue('16');
      await expect(page.locator('#exportButton')).toBeDisabled();
      await page.locator('#durationInput').fill('15');
      await page.locator('#durationInput').dispatchEvent('change');
      await expect(page.locator('#exportButton')).toBeEnabled();
    } finally {
      await closeCapture(get(), page, context);
    }
  });
}
