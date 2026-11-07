import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expect } from './browser-helpers.mjs';

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
}
