// Real exports from dist and application regressions through the source composition root.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer, preview } from 'vite';
import { chromium, expect } from '@playwright/test';

const repo = fileURLToPath(new URL('..', import.meta.url));
let browser, built, dev, artifacts;
const results = [];
const origin = (server) => `http://127.0.0.1:${server.httpServer.address().port}`;

before(async () => {
  artifacts = await mkdtemp(path.join(tmpdir(), 'orbital-browser-'));
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
    process.stdout.write(`Browser evidence: ${artifacts}\n`);
  }
});

async function newPage({
  fallback = false,
  url = origin(built),
  exposeApp = false,
  viewport = { width: 640, height: 480 },
} = {}) {
  const page = await browser.newPage({
    viewport,
    acceptDownloads: true,
    colorScheme: 'dark',
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

async function sourceOrigin() {
  if (!dev) {
    dev = await createServer({ root: repo, server: { host: '127.0.0.1', port: 0, open: false } });
    await dev.listen();
  }
  return origin(dev);
}

async function appPage() {
  const result = await newPage({
    url: await sourceOrigin(),
    exposeApp: true,
    viewport: { width: 1280, height: 800 },
  });
  await result.page.evaluate(() => window.smokeApp.stop());
  return result;
}

async function reloadPaused(page) {
  await page.reload();
  await page.waitForFunction(() => Boolean(window.smokeApp));
  await page.evaluate(() => window.smokeApp.stop());
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
    const download = await next;
    await page.evaluate(() => window.restoreEncoder());
    await restored(page, true);
    await expect(page.locator('#statusLine')).toContainText('webcodecs:');
    assert.equal(downloads.length, 1);
    assert.deepEqual(errors, []);
    const video = await savedVideo(download, 'webcodecs', true);
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
    const download = await next;
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
    const video = await savedVideo(download, 'mediarecorder', false);
    results.push({ case: 'mediarecorder_success_cancel_resize', tracks, ...video });
  } finally {
    await page.close();
  }
});

test('destroying the real App during capture cancels without restarting animation', async () => {
  const { page, downloads, errors } = await newPage({
    fallback: true,
    url: await sourceOrigin(),
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

test('randomise keeps internal units and a shared configuration round-trips', async () => {
  const { page, errors } = await appPage();
  try {
    const state = await page.evaluate(async () => {
      const app = window.smokeApp;
      app.controls.randomize(() => 0.5);
      const { encodeConfig, decodeConfig } = await import('/src/ui/permalink.js');
      const decoded = decodeConfig(
        encodeConfig(app.scene.config, { rangeMode: app.controls.rangeMode })
      );
      return {
        angle: app.scene.config.planeAngle,
        display: app.controls.inputs.get('planeAngle').value,
        restored: decoded.values.planeAngle,
      };
    });
    assert.ok(Math.abs(state.angle - Math.PI / 3) < 1e-12);
    assert.equal(state.display, '60');
    assert.equal(state.restored, state.angle);
    assert.deepEqual(errors, []);
    results.push({ case: 'randomise_units', ...state });
  } finally {
    await page.close();
  }
});

test('view, range and edits to shared scenes survive immediate reload', async () => {
  const { page, errors } = await appPage();
  try {
    // A stale query must no longer compete with the current state or the shared hash.
    await page.evaluate(() => {
      history.replaceState(null, '', '?view=3d');
      document.querySelector('#viewToggle [data-value="2d"]').click();
      location.reload();
    });
    await page.waitForFunction(() => window.smokeApp?.scene.config.view === '2d');
    await page.evaluate(() => window.smokeApp.stop());
    await page.locator('#panelToggle').click();
    await page.evaluate(() => {
      document.querySelector('#rangeToggle [data-value="experimental"]').click();
      location.reload();
    });
    await page.waitForFunction(() => window.smokeApp?.controls.rangeMode === 'experimental');
    await page.evaluate(() => window.smokeApp.stop());
    assert.deepEqual(
      await page.evaluate(() => [
        window.smokeApp.scene.config.view,
        window.smokeApp.controls.rangeMode,
      ]),
      ['2d', 'experimental']
    );
    assert.equal(await page.evaluate(() => localStorage.getItem('orbital-canvas:view')), null);
    await page.locator('#shareButton').click();
    assert.equal(
      await page.evaluate(() => new URLSearchParams(location.hash.slice(1)).get('view')),
      '2d'
    );
    await page.evaluate(() => {
      document.querySelector('#viewToggle [data-value="3d"]').click();
      location.reload();
    });
    await page.waitForFunction(() => window.smokeApp?.scene.config.view === '3d');
    assert.equal(await page.evaluate(() => window.smokeApp.scene.config.view), '3d');
    assert.equal(await page.evaluate(() => location.hash), '');
    await page.locator('#shareButton').click();
    assert.equal(
      await page.evaluate(() => new URLSearchParams(location.hash.slice(1)).get('view')),
      '3d'
    );
    assert.deepEqual(errors, []);
    results.push({ case: 'view_range_share_persistence', passed: true });
  } finally {
    await page.close();
  }
});

test('automatic and chosen colors survive persistence, sharing, theme changes and presets', async () => {
  const { page, errors } = await appPage();
  try {
    await page.locator('#viewToggle [data-value="2d"]').click();
    await expect
      .poll(() =>
        page.evaluate(() =>
          new URLSearchParams(localStorage.getItem('orbital-canvas:config')).get('color')
        )
      )
      .toBe('auto');
    await reloadPaused(page);
    await page.locator('#themeButton').click();
    assert.deepEqual(
      await page.evaluate(() => ({
        color: window.smokeApp.scene.config.color,
        input: window.smokeApp.controls.inputs.get('color').value,
      })),
      { color: 'auto', input: '#000000' }
    );
    await page.locator('#panelToggle').click();
    await page.locator('#presetSelect').selectOption('armature');
    await page.locator('#presetSelect').selectOption('default');
    assert.equal(await page.evaluate(() => window.smokeApp.scene.config.color), 'auto');
    await page.evaluate(() => {
      const input = window.smokeApp.controls.inputs.get('color');
      input.value = '#2468ac';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.locator('#panelClose').click();
    await page.locator('#shareButton').click();
    await reloadPaused(page);
    await page.locator('#themeButton').click();
    assert.equal(await page.evaluate(() => window.smokeApp.scene.config.color), '#2468ac');
    assert.deepEqual(errors, []);
    results.push({ case: 'auto_and_custom_color', passed: true });
  } finally {
    await page.close();
  }
});

test('budget warning follows generative growth and the Safe profile includes fading rings', async () => {
  const { page, errors } = await appPage();
  try {
    await page.locator('#panelToggle').click();
    await page.locator('#rangeToggle [data-value="experimental"]').click();
    await page.locator('#panelClose').click();
    const grown = await page.evaluate(() => {
      const app = window.smokeApp;
      app.controls.applyValues({
        numPoints: 128,
        maxRings: 28,
        circleInterval: 0.2,
        shape: 'disc',
        chordAlpha: 0,
      });
      for (let i = 0; i < 1200; i++) app.scene.step(1 / 60);
      app.advance(0);
      return {
        particles: app.scene.particleCount,
        warning: document.querySelector('#budgetNotice').hidden,
      };
    });
    assert.ok(grown.particles > 4000);
    assert.equal(grown.warning, false);
    await page.locator('#panelToggle').click();
    await page.locator('#rangeToggle [data-value="safe"]').click();
    assert.ok((await page.evaluate(() => window.smokeApp.scene.particleCount)) <= 4000);
    const safe = await page.evaluate(() => {
      const app = window.smokeApp;
      for (let i = 0; i < 1200; i++) app.scene.step(1 / 60);
      app.advance(0);
      return {
        particles: app.scene.particleCount,
        warning: document.querySelector('#budgetWarning').hidden,
      };
    });
    assert.ok(safe.particles <= 4000);
    assert.equal(safe.warning, true);
    assert.deepEqual(errors, []);
    results.push({ case: 'generative_budget', grown, safe });
  } finally {
    await page.close();
  }
});

test('shortcuts contain keyboard focus and restore it after closing', async () => {
  const { page, errors } = await appPage();
  try {
    await page.locator('#panelToggle').click();
    await page.locator('#canvas').focus();
    await page.keyboard.press('?');
    await expect(page.locator('#shortcutsClose')).toBeFocused();
    assert.equal(await page.locator('#panel').evaluate((el) => el.inert), true);
    await page.keyboard.press('Shift+Tab');
    assert.equal(
      await page.evaluate(() => Boolean(document.activeElement.closest('#panel'))),
      false
    );
    await page.locator('#shortcutsClose').focus();
    await page.keyboard.press('Escape');
    await expect(page.locator('#canvas')).toBeFocused();
    assert.equal(await page.locator('#panel').evaluate((el) => el.inert), false);
    // Crossing to the mobile layout while the inspector is open must seat focus inside it.
    await page.setViewportSize({ width: 640, height: 480 });
    await expect(page.locator('#panel')).toHaveAttribute('aria-modal', 'true');
    await expect
      .poll(() => page.evaluate(() => Boolean(document.activeElement.closest('#panel'))))
      .toBe(true);
    await page.keyboard.press('Escape');
    await expect(page.locator('#panelToggle')).toBeFocused();
    assert.deepEqual(errors, []);
    results.push({ case: 'modal_focus', passed: true });
  } finally {
    await page.close();
  }
});

test('camera and simulation share a bounded clock, and Undo restores the full reset state', async () => {
  const { page, errors } = await appPage();
  try {
    const delta = await page.evaluate(() => {
      const app = window.smokeApp;
      const time = app.scene.time,
        yaw = app.camera.yaw;
      app.advance(30);
      return { time: app.scene.time - time, yaw: app.camera.yaw - yaw };
    });
    assert.ok(Math.abs(delta.time - 0.1) < 1e-12);
    assert.ok(Math.abs(delta.yaw - 0.012) < 1e-12);
    await page.locator('#panelToggle').click();
    await page.locator('#rangeToggle [data-value="experimental"]').click();
    await page.locator('#panelClose').click();
    const original = await page.evaluate(() => {
      const app = window.smokeApp;
      app.controls.applyValues({ color: '#2468ac' });
      app.camera.orbitBy(30, 20);
      app.camera.zoomBy(1.3);
      document.querySelector('#durationInput').value = '120';
      document.querySelector('#fpsInput').value = '120';
      return { ...app.camera };
    });
    await page.locator('#resetButton').click();
    assert.deepEqual(
      await page.evaluate(() => [
        window.smokeApp.scene.config.color,
        window.smokeApp.controls.rangeMode,
      ]),
      ['auto', 'safe']
    );
    await page.keyboard.press('Control+z');
    assert.deepEqual(await page.evaluate(() => ({ ...window.smokeApp.camera })), original);
    await expect(page.locator('#durationInput')).toHaveValue('120');
    await expect(page.locator('#fpsInput')).toHaveValue('120');
    assert.deepEqual(
      await page.evaluate(() => [
        window.smokeApp.scene.config.color,
        window.smokeApp.controls.rangeMode,
      ]),
      ['#2468ac', 'experimental']
    );
    assert.deepEqual(errors, []);
    results.push({ case: 'shared_clock_and_full_undo', delta });
  } finally {
    await page.close();
  }
});

test('a DPR-only change resizes the canvas and cancels capture without a CSS resize', async () => {
  const { page, downloads, errors } = await newPage({
    fallback: true,
    url: await sourceOrigin(),
    exposeApp: true,
  });
  try {
    await page.evaluate(() => window.smokeApp.stop());
    await page.locator('#recordButton').click();
    await expect(page.locator('#recordingIndicator')).toContainText('MediaRecorder');
    const session = await page.context().newCDPSession(page);
    await session.send('Emulation.setDeviceMetricsOverride', {
      width: 640,
      height: 480,
      deviceScaleFactor: 2,
      mobile: false,
    });
    await restored(page, false);
    await expect(page.locator('#statusLine')).toContainText('Recording cancelled.');
    const dimensions = await page.evaluate(() => {
      const app = window.smokeApp;
      return {
        css: [app.viewport.width, app.viewport.height],
        pixels: [app.el.canvas.width, app.el.canvas.height],
        dpr: app.viewport.dpr,
        scale: app.ctx.getTransform().a,
        tracks: window.captureTracks.map((track) => track.readyState),
      };
    });
    assert.deepEqual(dimensions, {
      css: [640, 480],
      pixels: [1280, 960],
      dpr: 2,
      scale: 2,
      tracks: ['ended'],
    });
    assert.equal(downloads.length, 0);
    assert.deepEqual(errors, []);
    results.push({ case: 'dpr_capture_cancellation', ...dimensions });
  } finally {
    await page.close();
  }
});
