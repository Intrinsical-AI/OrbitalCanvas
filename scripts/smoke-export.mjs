// Real Chromium exports from dist; the source server is used only for App.destroy().
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer, preview } from 'vite';

const repo = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const { chromium, expect } = require(
  process.env.PLAYWRIGHT_MODULE ||
    path.resolve(repo, '../../web/python-lair-2026/node_modules/@playwright/test')
);
let browser, built, dev, artifacts;
const results = [];
const origin = (server) => `http://127.0.0.1:${server.httpServer.address().port}`;

before(async () => {
  artifacts = await mkdtemp(path.join(tmpdir(), 'orbital-export-'));
  built = await preview({ root: repo, preview: { host: '127.0.0.1', port: 0, open: false } });
  browser = await chromium.launch();
});
after(async () => {
  if (browser) await browser.close();
  if (dev) await dev.close();
  if (built)
    await new Promise((resolve, reject) =>
      built.httpServer.close((error) => (error ? reject(error) : resolve()))
    );
  if (artifacts) {
    await writeFile(path.join(artifacts, 'summary.json'), JSON.stringify(results, null, 2) + '\n');
    process.stdout.write(`Export evidence: ${artifacts}\n`);
  }
});

async function newPage({ fallback = false, url = origin(built), exposeApp = false } = {}) {
  const page = await browser.newPage({
    viewport: { width: 640, height: 480 },
    acceptDownloads: true,
  });
  page.setDefaultTimeout(15000);
  const downloads = [],
    errors = [];
  page.on('download', (download) => downloads.push(download));
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(
    ({ fallback }) => {
      if (fallback)
        Object.defineProperty(window, 'VideoEncoder', { value: undefined, configurable: true });
      window.captureTracks = [];
      const capture = HTMLCanvasElement.prototype.captureStream;
      HTMLCanvasElement.prototype.captureStream = function (...args) {
        const stream = capture.apply(this, args);
        window.captureTracks.push(...stream.getTracks());
        return stream;
      };
    },
    { fallback }
  );
  if (exposeApp) {
    // Test-only access to the existing instance; production lifecycle code stays intact.
    await page.route('**/src/main.js', async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        response,
        body: `${await response.text()}\nglobalThis.smokeApp = app;\n`,
      });
    });
  }
  await page.goto(url);
  await expect(page.locator('#playButton')).toHaveAttribute('aria-label', 'Pause animation');
  await page.evaluate(() => {
    document.querySelector('#fpsInput').value = '30';
    document.querySelector('#durationInput').value = '2';
  });
  return { page, downloads, errors };
}

async function locked(page) {
  await expect(page.locator('#playButton')).toBeDisabled();
  await expect(page.locator('#recordButton')).toBeEnabled();
  assert.equal(
    await page.evaluate(() =>
      [...document.querySelectorAll('button, input, select')]
        .filter((element) => element.id !== 'recordButton')
        .every((element) => element.disabled)
    ),
    true
  );
  await page.keyboard.press('Space');
  await expect(page.locator('#playButton')).toHaveAttribute('aria-label', 'Play animation');
}

async function restored(page, playing) {
  await expect(page.locator('#playButton')).toBeEnabled();
  await expect(page.locator('#fpsInput')).toBeEnabled();
  await expect(page.locator('#durationInput')).toBeEnabled();
  await expect(page.locator('#recordButton')).toHaveAttribute('data-state', 'idle');
  await expect(page.locator('#playButton')).toHaveAttribute(
    'aria-label',
    playing ? 'Pause animation' : 'Play animation'
  );
}

async function savedVideo(download, name, exact) {
  const file = path.join(artifacts, `${name}${path.extname(download.suggestedFilename())}`);
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
        'stream=nb_read_frames,r_frame_rate:format=duration',
        '-of',
        'json',
        file,
      ],
      { encoding: 'utf8' }
    )
  );
  const frames = Number(probe.streams[0].nb_read_frames);
  const duration = Number(probe.format.duration);
  const raw = execFileSync(
    'ffmpeg',
    ['-v', 'error', '-i', file, '-map', '0:v:0', '-f', 'framemd5', '-'],
    { encoding: 'utf8' }
  );
  const uniqueFrames = new Set(
    raw
      .split('\n')
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => line.split(',').at(-1).trim())
  ).size;
  assert.ok(uniqueFrames > 1, 'The exported scene must advance');
  assert.ok(duration >= 1.8 && duration <= 2.5, `Unexpected video duration: ${duration}`);
  if (exact) {
    assert.equal(frames, 60);
    assert.equal(probe.streams[0].r_frame_rate, '30/1');
  } else assert.ok(frames > 1, 'MediaRecorder must capture advancing frames');
  return { file, frames, uniqueFrames, duration, frameRate: probe.streams[0].r_frame_rate };
}

test('failed real WebCodecs finalize releases encoders; the next export succeeds', async () => {
  const { page, downloads, errors } = await newPage();
  try {
    await page.evaluate(() => {
      if (!window.VideoEncoder) throw new Error('Chromium WebCodecs is required for this smoke');
      window.encoderProbe = { encoders: [], closes: [], failed: false };
      const proto = VideoEncoder.prototype;
      const original = { configure: proto.configure, close: proto.close, flush: proto.flush };
      proto.configure = function (...args) {
        if (!window.encoderProbe.encoders.includes(this)) window.encoderProbe.encoders.push(this);
        return original.configure.apply(this, args);
      };
      proto.close = function (...args) {
        window.encoderProbe.closes.push(this);
        return original.close.apply(this, args);
      };
      proto.flush = function (...args) {
        // Hold the native boundary so control assertions do not race a fast encoder.
        return new Promise((resolve) => {
          window.releaseFlush = resolve;
        }).then(() => {
          window.releaseFlush = null;
          if (!window.encoderProbe.failed) {
            window.encoderProbe.failed = true;
            throw new Error('Injected native encoder flush failure');
          }
          return original.flush.apply(this, args);
        });
      };
      window.restoreEncoder = () => Object.assign(proto, original);
    });
    await page.locator('#recordButton').click();
    await locked(page);
    await page.waitForFunction(() => typeof window.releaseFlush === 'function');
    await page.evaluate(() => window.releaseFlush());
    await expect(page.locator('#statusLine')).toContainText(
      'Recording failed: Injected native encoder flush failure'
    );
    await restored(page, true);
    assert.equal(downloads.length, 0);
    const cleanup = await page.evaluate(() => ({
      failed: window.encoderProbe.failed,
      states: window.encoderProbe.encoders.map((encoder) => encoder.state),
      closeCounts: window.encoderProbe.encoders.map(
        (encoder) => window.encoderProbe.closes.filter((item) => item === encoder).length
      ),
    }));
    assert.equal(cleanup.failed, true);
    assert.ok(cleanup.states.length > 0);
    assert.ok(cleanup.states.every((state) => state === 'closed'));
    assert.ok(cleanup.closeCounts.every((count) => count === 1));
    const next = page.waitForEvent('download');
    await page.locator('#recordButton').click();
    await locked(page);
    await page.waitForFunction(() => typeof window.releaseFlush === 'function');
    await page.evaluate(() => window.releaseFlush());
    const video = await savedVideo(await next, 'webcodecs', true);
    await page.evaluate(() => window.restoreEncoder());
    await restored(page, true);
    await expect(page.locator('#statusLine')).toContainText('webcodecs:');
    assert.equal(downloads.length, 1);
    assert.deepEqual(errors, []);
    results.push({ case: 'failed_finalize_then_success', cleanup, ...video });
  } finally {
    await page.close();
  }
});

test('real MediaRecorder advances, restores paused state and cancels on Escape and resize', async () => {
  const { page, downloads, errors } = await newPage({ fallback: true });
  try {
    await page.locator('#playButton').click();
    const next = page.waitForEvent('download');
    await page.locator('#recordButton').click();
    await locked(page);
    const video = await savedVideo(await next, 'mediarecorder', false);
    await restored(page, false);
    await expect(page.locator('#statusLine')).toContainText('mediarecorder');
    for (const cancel of ['Escape', 'resize']) {
      await page.locator('#recordButton').click();
      await locked(page);
      if (cancel === 'Escape') await page.keyboard.press('Escape');
      else await page.setViewportSize({ width: 650, height: 480 });
      await restored(page, false);
      await expect(page.locator('#statusLine')).toContainText('Recording cancelled.');
    }
    assert.equal(downloads.length, 1);
    const tracks = await page.evaluate(() => window.captureTracks.map((track) => track.readyState));
    assert.equal(tracks.length, 3);
    assert.ok(tracks.every((state) => state === 'ended'));
    assert.deepEqual(errors, []);
    results.push({ case: 'mediarecorder_success_cancel_resize', tracks, ...video });
  } finally {
    await page.close();
  }
});

test('destroying the real App during capture cancels without restarting animation', async () => {
  dev = await createServer({ root: repo, server: { host: '127.0.0.1', port: 0, open: false } });
  await dev.listen();
  const { page, downloads, errors } = await newPage({
    fallback: true,
    url: origin(dev),
    exposeApp: true,
  });
  try {
    await page.locator('#recordButton').click();
    await expect(page.locator('#recordingIndicator')).toContainText('MediaRecorder');
    await page.evaluate(() => {
      window.smokeApp.destroy();
      window.smokeApp.destroy();
    });
    await page.waitForFunction(
      () => !window.smokeApp.recorder.recording && !window.smokeApp.exporting
    );
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    );
    const state = await page.evaluate(() => ({
      destroyed: window.smokeApp.destroyed,
      running: window.smokeApp.running,
      rafId: window.smokeApp.rafId,
      renderRafId: window.smokeApp.renderRafId,
      listeners: window.smokeApp.teardown.length,
      cancelCapture: window.smokeApp.recorder.cancelCapture,
      tracks: window.captureTracks.map((track) => track.readyState),
    }));
    assert.deepEqual(state, {
      destroyed: true,
      running: false,
      rafId: null,
      renderRafId: null,
      listeners: 0,
      cancelCapture: null,
      tracks: ['ended'],
    });
    assert.equal(downloads.length, 0);
    assert.deepEqual(errors, []);
    results.push({ case: 'destroy_during_capture', ...state });
  } finally {
    await page.close();
  }
});
