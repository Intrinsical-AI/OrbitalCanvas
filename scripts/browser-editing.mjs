import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expect } from './browser-helpers.mjs';

function assertPose(actual, expected, message) {
  for (const key of ['yaw', 'pitch', 'zoom'])
    assert.ok(Math.abs(actual[key] - expected[key]) < 1e-10, `${message}: ${key}`);
}

export function editingCases(get) {
  test('button focus preserves character shortcuts and native Space activation', async () => {
    const { page, context, errors } = await get().page();
    try {
      await page.locator('#presetsButton').click();
      await page.locator('[data-preset="armature"]').click();
      await page.keyboard.press('p');
      await expect(page.locator('#editPage')).toBeVisible();
      await page.keyboard.press('?');
      await expect(page.locator('#shortcuts')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.locator('#shortcuts')).not.toBeVisible();
      await page.keyboard.press('2');
      await expect(page.locator('#canvas')).toHaveAttribute('data-view', '2d');
      await page.keyboard.press('3');
      await expect(page.locator('#canvas')).toHaveAttribute('data-view', '3d');
      await page.locator('#presetsButton').click();
      await page.locator('#variationButton').focus();
      const before = await page.evaluate(() => ({
        parameters: JSON.stringify(window.smokeApp.document.parameters),
        running: window.smokeApp.running,
      }));
      await page.keyboard.press('Space');
      const after = await page.evaluate(() => ({
        parameters: JSON.stringify(window.smokeApp.document.parameters),
        running: window.smokeApp.running,
      }));
      assert.notEqual(after.parameters, before.parameters);
      assert.equal(after.running, before.running);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });
  test('editing geometry in pause preserves phases and clock; history groups a gesture', async () => {
    const { page, context } = await get().page();
    try {
      await page.evaluate(() => {
        const app = window.smokeApp;
        app.stop();
        for (let i = 0; i < 20; i++) app.advance(0.1);
      });
      await page.locator('#panelToggle').click();
      const before = await page.evaluate(() => ({
        time: window.smokeApp.scene.time,
        rings: window.smokeApp.scene.rings.map((r) => [r.seq, r.phase]),
      }));
      await page.locator('#numPointsControl').focus();
      await page.keyboard.press('ArrowRight');
      assert.deepEqual(
        await page.evaluate(() => ({
          time: window.smokeApp.scene.time,
          rings: window.smokeApp.scene.rings.map((r) => [r.seq, r.phase]),
        })),
        before
      );
      assert.equal(await page.evaluate(() => window.smokeApp.document.parameters.numPoints), 73);
      await page.keyboard.press('Control+z');
      assert.equal(await page.evaluate(() => window.smokeApp.document.parameters.numPoints), 72);
      await page.keyboard.press('Control+Shift+z');
      assert.equal(await page.evaluate(() => window.smokeApp.document.parameters.numPoints), 73);
      const clean = await page.evaluate(() => {
        const app = window.smokeApp;
        const a = app.el.canvas.toDataURL();
        app.draw(0, true);
        return a === app.el.canvas.toDataURL();
      });
      assert.equal(clean, true, 'paused preview must already be a clean redraw');
      await page.locator('#planeAngleControl').focus();
      await page.keyboard.press('ArrowRight');
      assert.equal(await page.evaluate(() => window.smokeApp.scene.time), before.time);
    } finally {
      await context.close();
    }
  });
  test('Safe clamping is immediately reversible, including from the selector', async () => {
    const { page, context } = await get().page();
    try {
      await page.evaluate(() => window.smokeApp.stop());
      await page.locator('#panelToggle').click();
      await page.locator('#sceneSettings').evaluate((e) => (e.open = true));
      await page.locator('#rangeSelect').selectOption('experimental');
      await page.locator('#numPointsControl').focus();
      await page.keyboard.press('End');
      assert.equal(await page.evaluate(() => window.smokeApp.document.parameters.numPoints), 240);
      await page.locator('#rangeSelect').selectOption('safe');
      assert.equal(await page.evaluate(() => window.smokeApp.document.parameters.numPoints), 128);
      assert.ok(await page.evaluate(() => window.smokeApp.scene.particleCount <= 4000));
      await page.keyboard.press('Control+z');
      assert.equal(await page.evaluate(() => window.smokeApp.document.parameters.numPoints), 240);
      await page.keyboard.press('Control+Shift+z');
      assert.equal(await page.evaluate(() => window.smokeApp.document.parameters.numPoints), 128);
    } finally {
      await context.close();
    }
  });
  test('Safe stays within its particle limit across spawns after leaving Experimental', async () => {
    const { page, context } = await get().page();
    try {
      const counts = await page.evaluate(() => {
        const app = window.smokeApp;
        app.stop();
        app.action('experimental population', () => {
          app.document.rangeMode = 'experimental';
          Object.assign(app.document.parameters, {
            numPoints: 128,
            maxRings: 48,
            circleInterval: 0.2,
          });
        });
        app.scene.restart('full');
        const experimental = app.scene.particleCount;
        app.action('return to Safe', () => {
          app.document.rangeMode = 'safe';
        });
        let peak = app.scene.particleCount;
        for (let i = 0; i < 30; i++) {
          app.advance(0.1);
          peak = Math.max(peak, app.scene.particleCount);
        }
        return { experimental, peak };
      });
      assert.ok(counts.experimental > 4000);
      assert.ok(counts.peak <= 4000);
    } finally {
      await context.close();
    }
  });
  test('preset state, reapplication, defaults and Auto colour remain truthful', async () => {
    const { page, context } = await get().page();
    try {
      await page.locator('#presetsButton').click();
      await page.locator('[data-preset="weave"]').click();
      await expect(page.locator('#presetName')).toHaveText('Weave');
      await page.locator('#editTab').click();
      await page.locator('#sizeControl').focus();
      await page.keyboard.press('ArrowRight');
      await expect(page.locator('#presetName')).toHaveText('Custom');
      await page.locator('#exploreTab').click();
      await page.locator('#reapplyButton').click();
      await expect(page.locator('#presetName')).toHaveText('Weave');
      await page.locator('#editTab').click();
      await page.locator('#colorControl').evaluate((input) => {
        input.closest('details').open = true;
        input.value = '#123456';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
      assert.equal(await page.evaluate(() => window.smokeApp.document.parameters.color), '#123456');
      await page.locator('[data-auto-color]').click();
      assert.equal(await page.evaluate(() => window.smokeApp.document.parameters.color), 'auto');
      await page.locator('#resetButton').click();
      await expect(page.locator('#presetName')).toHaveText('Default');
      await page.keyboard.press('Control+z');
      await expect(page.locator('#presetName')).toHaveText('Weave');
    } finally {
      await context.close();
    }
  });
  test('v2 links and synchronous local edits preserve appearance, camera and projection', async () => {
    const { page, context } = await get().page();
    try {
      await page.evaluate(() => {
        Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
        Object.defineProperty(navigator, 'clipboard', {
          value: {
            writeText: async (text) => {
              window.copiedLink = text;
            },
          },
          configurable: true,
        });
        const app = window.smokeApp;
        app.stop();
        app.action('setup', () => {
          app.document.view = '2d';
          app.document.appearance = 'light';
          app.document.camera = { yaw: 1, pitch: 0.3, zoom: 1.4, autoOrbit: false };
        });
      });
      await page.locator('#moreMenu summary').click();
      await page.locator('#shareButton').click();
      const link = await page.evaluate(() => window.copiedLink);
      assert.match(link, /#v=2&/);
      await page.goto(link);
      await page.waitForFunction(() => Boolean(window.smokeApp));
      assert.equal(await page.evaluate(() => window.smokeApp.document.appearance), 'light');
      assert.equal(await page.evaluate(() => window.smokeApp.document.view), '2d');
      assert.ok(
        Math.abs((await page.evaluate(() => window.smokeApp.document.camera.yaw)) - 1) < 1e-9
      );
      await page.locator('#panelToggle').click();
      await page.locator('#speedControl').focus();
      await page.keyboard.press('ArrowRight');
      const speed = await page.evaluate(() => window.smokeApp.document.parameters.speed);
      assert.equal(new URL(page.url()).hash, '');
      await page.reload();
      await page.waitForFunction(() => Boolean(window.smokeApp));
      assert.equal(await page.evaluate(() => window.smokeApp.document.parameters.speed), speed);
      assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
    } finally {
      await context.close();
    }
  });
  test('disabling auto-orbit keeps the live camera pose after ten seconds', async () => {
    const { page, context, errors } = await get().page();
    try {
      const before = await page.evaluate(() => {
        const app = window.smokeApp;
        app.stop();
        for (let i = 0; i < 100; i++) app.advance(0.1);
        return app.camera.pose(true);
      });
      await page.locator('#panelToggle').click();
      await page.locator('#sceneSettings').evaluate((element) => (element.open = true));
      await page.locator('#autoOrbitInput').uncheck();
      const after = await page.evaluate(() => window.smokeApp.camera.pose(false));
      assertPose(after, before, 'disabling auto-orbit must preserve the live pose');
      assert.equal(await page.evaluate(() => window.smokeApp.document.camera.autoOrbit), false);
      await page.keyboard.press('Control+z');
      assert.equal(await page.evaluate(() => window.smokeApp.document.camera.autoOrbit), true);
      assertPose(
        await page.evaluate(() => window.smokeApp.camera.pose(true)),
        before,
        'undoing camera motion must preserve the live pose'
      );
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });
  test('manual camera undo restores its gesture start; parameter undo preserves later motion', async () => {
    const { page, context, errors } = await get().page();
    try {
      const before = await page.evaluate(() => {
        const app = window.smokeApp;
        app.stop();
        for (let i = 0; i < 100; i++) app.advance(0.1);
        const { x, y, width, height } = app.viewport.frame;
        return {
          pose: app.camera.pose(true),
          x: x + width / 2,
          y: y + height / 2,
        };
      });
      await page.mouse.move(before.x, before.y);
      await page.mouse.down();
      await page.mouse.move(before.x + 70, before.y + 35, { steps: 3 });
      await page.mouse.up();
      const dragged = await page.evaluate(() => window.smokeApp.camera.pose(true));
      assert.ok(Math.abs(dragged.yaw - before.pose.yaw) > 0.1, 'drag must orbit the camera');
      await page.evaluate(() => {
        for (let i = 0; i < 50; i++) window.smokeApp.advance(0.1);
      });
      await page.locator('#canvas').focus();
      await page.keyboard.press('Control+z');
      assertPose(
        await page.evaluate(() => window.smokeApp.camera.pose(true)),
        before.pose,
        'camera undo must restore the gesture start after automatic motion'
      );
      await page.locator('#panelToggle').click();
      await page.locator('#numPointsControl').focus();
      await page.keyboard.press('ArrowRight');
      const later = await page.evaluate(() => {
        for (let i = 0; i < 100; i++) window.smokeApp.advance(0.1);
        return window.smokeApp.camera.pose(true);
      });
      await page.keyboard.press('Control+z');
      assert.equal(await page.evaluate(() => window.smokeApp.document.parameters.numPoints), 72);
      assertPose(
        await page.evaluate(() => window.smokeApp.camera.pose(true)),
        later,
        'parameter undo must preserve automatic motion since the edit'
      );
      await page.keyboard.press('Control+Shift+z');
      assert.equal(await page.evaluate(() => window.smokeApp.document.parameters.numPoints), 73);
      assertPose(
        await page.evaluate(() => window.smokeApp.camera.pose(true)),
        later,
        'parameter redo must preserve the current live pose'
      );
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });
  test('numeric commits show their clamped value after Tab and Enter and recover from blank input', async () => {
    const { page, context, errors } = await get().page();
    try {
      await page.evaluate(() => window.smokeApp.stop());
      await page.locator('#panelToggle').click();
      const numeric = page.getByRole('spinbutton', {
        name: 'Particles per ring value',
        exact: true,
      });
      for (const key of ['Tab', 'Enter']) {
        await numeric.fill('72');
        await numeric.press('Tab');
        await numeric.fill('9999');
        await numeric.press(key);
        await expect(numeric).toHaveValue('128');
        assert.equal(await page.evaluate(() => window.smokeApp.document.parameters.numPoints), 128);
        await numeric.fill('');
        await numeric.press(key);
        await expect(numeric).toHaveValue('128');
        assert.equal(await page.evaluate(() => window.smokeApp.document.parameters.numPoints), 128);
      }
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });
  test('redo during a held slider key commits the new edit and discards the old future', async () => {
    const { page, context, errors } = await get().page();
    try {
      await page.evaluate(() => window.smokeApp.stop());
      await page.locator('#panelToggle').click();
      await page.locator('#numPointsControl').focus();
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('Control+z');
      await page.keyboard.down('ArrowRight');
      await page.keyboard.down('ArrowRight');
      assert.equal(await page.evaluate(() => window.smokeApp.document.parameters.numPoints), 74);
      await page.keyboard.press('Control+Shift+z');
      assert.deepEqual(
        await page.evaluate(() => ({
          value: window.smokeApp.document.parameters.numPoints,
          pending: window.smokeApp.history.pending,
          future: window.smokeApp.history.future.length,
          past: window.smokeApp.history.past.length,
        })),
        { value: 74, pending: null, future: 0, past: 1 }
      );
      await page.keyboard.up('ArrowRight');
      await page.keyboard.press('Control+z');
      assert.equal(await page.evaluate(() => window.smokeApp.document.parameters.numPoints), 72);
      await page.keyboard.press('Control+Shift+z');
      assert.equal(await page.evaluate(() => window.smokeApp.document.parameters.numPoints), 74);
      assert.deepEqual(errors, []);
    } finally {
      await page.keyboard.up('ArrowRight');
      await context.close();
    }
  });
  test('a preset restores its generative lifecycle from a static composition', async () => {
    const { page, context, errors } = await get().page();
    try {
      await page.evaluate(() => window.smokeApp.stop());
      await page.locator('#panelToggle').click();
      await page.locator('#sceneSettings').evaluate((element) => (element.open = true));
      await page.locator('#spawnSelect').selectOption('static');
      await page.locator('#presetsButton').click();
      await page.locator('[data-preset="weave"]').click();
      await expect(page.locator('#presetName')).toHaveText('Weave');
      await expect(page.locator('#spawnSelect')).toHaveValue('generative');
      assert.equal(await page.evaluate(() => window.smokeApp.scene.config.spawnMode), 'generative');
      await page.keyboard.press('Control+z');
      assert.equal(
        await page.evaluate(() => window.smokeApp.document.parameters.spawnMode),
        'static'
      );
      assert.equal(await page.evaluate(() => window.smokeApp.scene.config.spawnMode), 'static');
      await page.keyboard.press('Control+Shift+z');
      await expect(page.locator('#presetName')).toHaveText('Weave');
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });
  test('reduced motion respects explicit link and saved camera motion while starting paused', async () => {
    const { page, context, errors } = await get().page({ reducedMotion: 'reduce' });
    try {
      const link = await page.evaluate(async () => {
        const { DOCUMENT_KEY, defaultDocument, encodeDocument } =
          await import('/src/ui/permalink.js');
        const document = defaultDocument('light');
        document.camera = { yaw: 1, pitch: 0.3, zoom: 1.4, autoOrbit: true };
        localStorage.setItem(DOCUMENT_KEY, JSON.stringify(document));
        const url = new URL(location.href);
        url.hash = encodeDocument(document);
        return url.href;
      });
      await page.reload();
      await page.waitForFunction(() => Boolean(window.smokeApp));
      for (const source of ['storage', 'link']) {
        if (source === 'link') {
          await page.evaluate(async () => {
            const { DOCUMENT_KEY } = await import('/src/ui/permalink.js');
            const document = JSON.parse(localStorage.getItem(DOCUMENT_KEY));
            document.camera.autoOrbit = false;
            localStorage.setItem(DOCUMENT_KEY, JSON.stringify(document));
          });
          await page.goto(link);
          await page.waitForFunction(() => Boolean(window.smokeApp));
        }
        const restored = await page.evaluate(() => ({
          running: window.smokeApp.running,
          camera: window.smokeApp.document.camera,
        }));
        assert.equal(restored.running, false, `${source} must start paused`);
        assert.equal(
          restored.camera.autoOrbit,
          true,
          `${source} must preserve explicit camera motion`
        );
        assertPose(restored.camera, { yaw: 1, pitch: 0.3, zoom: 1.4 }, `${source} pose`);
        await expect(page.locator('#playButton')).toHaveText('Play');
      }
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });
  test('Share fallback stays selectable inside Capture and is hidden after an edit', async () => {
    const { page, context, errors } = await get().page();
    try {
      await page.evaluate(() => {
        window.smokeApp.stop();
        Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
        Object.defineProperty(navigator, 'clipboard', {
          value: { writeText: async () => Promise.reject(new Error('Clipboard denied')) },
          configurable: true,
        });
      });
      await page.locator('#captureButton').click();
      await page.locator('#captureDialog [data-action="share"]').click();
      const field = page.locator('#captureDialog #shareLink');
      await expect(field).toBeVisible();
      await expect(field).toBeFocused();
      const selection = await field.evaluate((input) => ({
        start: input.selectionStart,
        end: input.selectionEnd,
        length: input.value.length,
        hash: new URL(input.value).hash,
      }));
      assert.equal(selection.start, 0);
      assert.equal(selection.end, selection.length);
      assert.match(selection.hash, /^#v=2&/);
      await page.locator('#captureClose').click();
      await page.locator('#panelToggle').click();
      await page.locator('#numPointsControl').focus();
      await page.keyboard.press('ArrowRight');
      assert.equal(await page.locator('#shareLink').evaluate((input) => input.hidden), true);
      assert.equal(new URL(page.url()).hash, '');
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });
}
