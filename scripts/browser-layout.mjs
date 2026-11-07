import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expect } from './browser-helpers.mjs';

export function layoutCases(get) {
  test('built preset previews load from the production bundle', async () => {
    const { page, context, errors } = await get().page({ source: false });
    try {
      await page.locator('#presetsButton').click();
      const previews = page.locator('#presetCards img');
      assert.equal(await previews.count(), 4);
      await expect
        .poll(() =>
          previews.evaluateAll((images) => images.every((image) => image.naturalWidth > 0))
        )
        .toBe(true);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });
  for (const [width, height] of [
    [320, 568],
    [360, 740],
    [390, 844],
    [768, 1024],
    [820, 600],
    [844, 390],
    [1440, 900],
  ]) {
    test('usable layout ' + width + '×' + height, async () => {
      const { page, context, errors } = await get().page({
        viewport: { width, height },
        hasTouch: width < 1024,
      });
      try {
        await page.evaluate(() => window.smokeApp.stop());
        for (const appearance of ['dark', 'light']) {
          await page.evaluate((appearance) => {
            window.smokeApp.document.appearance = appearance;
            window.smokeApp.apply();
          }, appearance);
          const header = await page.evaluate(() => {
            const a = document.querySelector('.mark').getBoundingClientRect(),
              b = document.querySelector('.topbar__actions').getBoundingClientRect();
            return {
              overlap: a.right > b.left,
              bottomHeight: document.querySelector('#bottomBar').getBoundingClientRect().height,
              overflow: document.documentElement.scrollWidth > innerWidth,
            };
          });
          assert.equal(header.overlap, false);
          assert.equal(header.overflow, false);
          assert.ok(header.bottomHeight <= 64);
          await page.locator('#panelToggle').click();
          const panel = await page.evaluate(() => {
            const app = window.smokeApp,
              r = document.querySelector('#numPointsControl').getBoundingClientRect(),
              body = document.querySelector('.panel__body').getBoundingClientRect();
            return {
              frame: app.viewport.frame,
              sliderBottom: r.bottom,
              bodyBottom: body.bottom,
              bodyTop: body.top,
              sliderTop: r.top,
            };
          });
          assert.ok(
            panel.sliderBottom <= panel.bodyBottom + 1,
            'first slider visible without scrolling'
          );
          assert.ok(panel.sliderTop >= panel.bodyTop);
          assert.ok(panel.frame.width >= 16 && panel.frame.height >= 16);
          await page.screenshot({
            path: get().artifacts + '/' + width + '-' + height + '-' + appearance + '.png',
          });
          await page.locator('#panelClose').click();
        }
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    });
  }
  test('dialogs contain focus; character shortcuts can be disabled; Hide UI has a keyboard exit', async () => {
    const { page, context } = await get().page();
    try {
      await page.locator('#canvas').focus();
      await page.keyboard.press('?');
      await expect(page.locator('#shortcuts')).toBeVisible();
      for (const key of ['Tab', 'Shift+Tab']) {
        for (let i = 0; i < 12; i++) {
          await page.keyboard.press(key);
          const focus = await page.evaluate(() => ({
            inside: document.querySelector('#shortcuts').contains(document.activeElement),
            activeId: document.activeElement.id,
            activeTag: document.activeElement.tagName,
            documentFocused: document.hasFocus(),
          }));
          assert.ok(focus.inside, JSON.stringify({ key, step: i, ...focus }));
        }
      }
      await page.locator('#shortcutsEnabled').uncheck();
      await page.keyboard.press('Escape');
      await page.locator('#canvas').focus();
      await page.keyboard.press('2');
      await expect(page.locator('#canvas')).toHaveAttribute('data-view', '3d');
      await page.locator('#moreMenu summary').click();
      await page.locator('#hideButton').click();
      await expect(page.locator('#showUiButton')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.locator('#hud')).toBeVisible();
      await page.locator('#captureButton').click();
      await page.keyboard.press('Tab');
      assert.ok(
        await page.evaluate(() =>
          document.querySelector('#captureDialog').contains(document.activeElement)
        )
      );
      await page.keyboard.press('Escape');
      await expect(page.locator('#captureButton')).toBeFocused();
    } finally {
      await context.close();
    }
  });
  test('reduced motion opens a complete, paused scene without auto-orbit', async () => {
    const { page, context } = await get().page({ reducedMotion: 'reduce' });
    try {
      assert.deepEqual(
        await page.evaluate(() => ({
          running: window.smokeApp.running,
          orbit: window.smokeApp.document.camera.autoOrbit,
          count: window.smokeApp.scene.rings.length,
        })),
        { running: false, orbit: false, count: 12 }
      );
    } finally {
      await context.close();
    }
  });
}
