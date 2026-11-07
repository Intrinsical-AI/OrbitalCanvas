import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect } from './browser-helpers.mjs';

async function setup(h, options = {}) {
  const result = await h.page({ viewport: { width: 640, height: 560 }, ...options });
  const { page } = result;
  await page.evaluate(() => {
    window.captureTracks = [];
    const original = HTMLCanvasElement.prototype.captureStream;
    HTMLCanvasElement.prototype.captureStream = function (...args) {
      const stream = original.apply(this, args);
      window.captureTracks.push(...stream.getTracks());
      return stream;
    };
  });
  await page.locator('#captureButton').click();
  await page.locator('#captureType').selectOption('video');
  await page.locator('#fpsInput').selectOption('30');
  await page.locator('#durationInput').fill('2');
  await page.locator('#durationInput').dispatchEvent('change');
  return result;
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
        'stream=nb_read_frames,r_frame_rate,width,height:format=duration',
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
        () => window.smokeApp.pngFrame.toDataURL().split(',')[1]
      );
      const pending = page.waitForEvent('download');
      await page.locator('#exportButton').click();
      const download = await pending,
        file = path.join(get().artifacts, 'exact-frame.png');
      await download.saveAs(file);
      assert.deepEqual(await readFile(file), Buffer.from(expected, 'base64'));
      get().receipts.push({ name: 'exact_png', file });
    } finally {
      await context.close();
    }
  });
  test('built WebCodecs handles flush failure, releases encoders and retries successfully', async (t) => {
    const { page, context, errors } = await setup(get(), { source: false });
    try {
      if (!(await page.evaluate(() => typeof VideoEncoder === 'function'))) {
        t.skip(
          'WebCodecs encoding is unavailable in this engine; MediaRecorder is exercised separately.'
        );
        return;
      }
      await page.evaluate(() => {
        window.probe = { encoders: [], exports: new WeakSet(), closes: [], failed: false };
        const proto = VideoEncoder.prototype,
          original = { configure: proto.configure, close: proto.close, flush: proto.flush };
        proto.configure = function (...args) {
          if (!window.probe.encoders.includes(this)) window.probe.encoders.push(this);
          if (Number.isFinite(args[0]?.framerate)) window.probe.exports.add(this);
          return original.configure.apply(this, args);
        };
        proto.close = function (...args) {
          window.probe.closes.push(this);
          return original.close.apply(this, args);
        };
        proto.flush = function (...args) {
          // Firefox probes codecs with temporary encoders before starting the export.
          if (!window.probe.exports.has(this)) return original.flush.apply(this, args);
          return new Promise((resolve) => {
            window.releaseFlush = resolve;
          }).then(() => {
            window.releaseFlush = null;
            if (!window.probe.failed) {
              window.probe.failed = true;
              throw new Error('Injected native encoder flush failure');
            }
            return original.flush.apply(this, args);
          });
        };
        window.restoreEncoder = () => Object.assign(proto, original);
      });
      await page.locator('#exportButton').click();
      await expect(page.locator('#cancelExportButton')).toBeVisible();
      await page.waitForFunction(() => typeof window.releaseFlush === 'function');
      await page.evaluate(() => window.releaseFlush());
      await expect(page.locator('#captureError')).toContainText(
        'Injected native encoder flush failure'
      );
      await expect(page.locator('#exportButton')).toBeEnabled();
      assert.ok(
        await page.evaluate(
          () =>
            window.probe.encoders.length > 0 &&
            window.probe.encoders.every((e) => e.state === 'closed')
        )
      );
      assert.ok(
        await page.evaluate(() =>
          window.probe.encoders.every(
            (e) => window.probe.closes.filter((c) => c === e).length === 1
          )
        )
      );
      const pending = page.waitForEvent('download');
      await page.locator('#exportButton').click();
      await page.waitForFunction(() => typeof window.releaseFlush === 'function');
      await page.evaluate(() => window.releaseFlush());
      const download = await pending;
      await page.evaluate(() => window.restoreEncoder());
      await expect(page.locator('#exportButton')).toBeEnabled();
      await videoReceipt(get(), download, 'webcodecs-recovery');
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });
  test('detached video survives editor resize and DPR without advancing the editor', async (t) => {
    const { page, context, errors } = await setup(get());
    try {
      if (!(await page.evaluate(() => typeof VideoEncoder === 'function'))) {
        t.skip(
          'WebCodecs encoding is unavailable in this engine; MediaRecorder is exercised separately.'
        );
        return;
      }
      const before = await page.evaluate(() => ({
        time: window.smokeApp.scene.time,
        phases: window.smokeApp.scene.rings.map((r) => r.phase),
      }));
      await page.evaluate(() => {
        const proto = VideoEncoder.prototype;
        const original = { configure: proto.configure, flush: proto.flush };
        const exports = new WeakSet();
        proto.configure = function (...args) {
          if (Number.isFinite(args[0]?.framerate)) exports.add(this);
          return original.configure.apply(this, args);
        };
        proto.flush = function (...args) {
          if (!exports.has(this)) return original.flush.apply(this, args);
          return new Promise((resolve) => {
            window.releaseFlush = () => resolve();
          }).then(() => original.flush.apply(this, args));
        };
      });
      const pending = page.waitForEvent('download');
      await page.locator('#exportButton').click();
      await page.waitForFunction(() => typeof window.releaseFlush === 'function');
      await page.setViewportSize({ width: 700, height: 620 });
      await page.evaluate(() => {
        Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true });
        window.smokeApp.viewport.sync();
      });
      await page.evaluate(() => window.releaseFlush());
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
      await context.close();
    }
  });
  test('fresh export sessions reproduce frame zero after arbitrary editor motion', async () => {
    const { page, context } = await setup(get());
    try {
      assert.equal(
        await page.evaluate(async () => {
          const { CaptureScene } = await import('/src/ui/capture.js');
          const doc = window.smokeApp.captureDocument;
          const a = new CaptureScene(doc, { width: 320, height: 320 });
          const zero = a.canvas.toDataURL();
          a.render(0);
          if (zero !== a.canvas.toDataURL()) return false;
          for (let i = 0; i < 30; i++) a.render(1 / 30);
          const first = a.canvas.toDataURL();
          window.smokeApp.scene.step(20);
          const b = new CaptureScene(doc, { width: 320, height: 320 });
          for (let i = 0; i < 30; i++) b.render(1 / 30);
          return (
            first === b.canvas.toDataURL() &&
            b.scene.rings.filter((r) => !r.fading).length === doc.parameters.maxRings
          );
        }),
        true
      );
    } finally {
      await context.close();
    }
  });
  test('MediaRecorder captures motion from a detached canvas and cancels on Escape', async () => {
    const { page, context, errors } = await setup(get(), { fallback: true, source: false });
    try {
      const pending = page.waitForEvent('download');
      await page.locator('#exportButton').click();
      const download = await pending;
      await expect(page.locator('#exportButton')).toBeEnabled();
      await videoReceipt(get(), download, 'mediarecorder', false);
      await page.locator('#exportButton').click();
      await expect(page.locator('#cancelExportButton')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.locator('#captureError')).toContainText('cancelled');
      await expect(page.locator('#captureDialog')).toBeVisible();
      assert.ok(
        await page.evaluate(() => window.captureTracks.every((t) => t.readyState === 'ended'))
      );
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });
  test('destroying the editor cancels capture and releases tracks without a download', async () => {
    const { page, context } = await setup(get(), { fallback: true });
    try {
      let downloads = 0;
      page.on('download', () => downloads++);
      await page.locator('#exportButton').click();
      await expect(page.locator('#cancelExportButton')).toBeVisible();
      await page.evaluate(() => {
        window.smokeApp.destroy();
        window.smokeApp.destroy();
      });
      await page.waitForFunction(() => !window.smokeApp.exporting);
      assert.equal(await page.evaluate(() => window.smokeApp.running), false);
      assert.ok(
        await page.evaluate(() => window.captureTracks.every((t) => t.readyState === 'ended'))
      );
      assert.equal(downloads, 0);
    } finally {
      await context.close();
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
      await context.close();
    }
  });
}
