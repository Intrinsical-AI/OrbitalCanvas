import { createServer, preview } from 'vite';
import { chromium, firefox, webkit, expect } from '@playwright/test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export { expect };
export const repo = fileURLToPath(new URL('..', import.meta.url));
export async function harness() {
  let dev, built, browser;
  const artifacts = await mkdtemp(path.join(tmpdir(), 'orbital-browser-'));
  try {
    dev = await createServer({ root: repo, server: { host: '127.0.0.1', port: 0, open: false } });
    await dev.listen();
    built = await preview({ root: repo, preview: { host: '127.0.0.1', port: 0, open: false } });
    const browserType = { chromium, firefox, webkit }[process.env.ORBITAL_BROWSER ?? 'chromium'];
    if (!browserType) throw new Error('Unknown ORBITAL_BROWSER');
    browser = await browserType.launch({ timeout: 90000 });
    const origin = (server) => 'http://127.0.0.1:' + server.httpServer.address().port;
    const receipts = [];
    return {
      artifacts,
      browser,
      receipts,
      async page({
        source = true,
        viewport = { width: 1280, height: 800 },
        fallback = false,
        ...contextOptions
      } = {}) {
        if (browserType === firefox) delete contextOptions.hasTouch;
        const context = await browser.newContext({
          viewport,
          colorScheme: 'dark',
          acceptDownloads: true,
          ...contextOptions,
        });
        const page = await context.newPage();
        page.setDefaultTimeout(12000);
        const errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        if (fallback)
          await page.addInitScript(() =>
            Object.defineProperty(window, 'VideoEncoder', { value: undefined, configurable: true })
          );
        if (source)
          await page.route(/\/src\/main\.js(?:\?.*)?$/, async (route) => {
            const response = await route.fetch();
            await route.fulfill({
              response,
              body: (await response.text()) + '\nglobalThis.smokeApp=app;\n',
            });
          });
        await page.goto(source ? origin(dev) : origin(built));
        if (source) await page.waitForFunction(() => Boolean(window.smokeApp));
        await expect(page.locator('#playButton')).toHaveAttribute('aria-label', /animation/);
        await page.evaluate(() => document.fonts.ready);
        return { page, context, errors };
      },
      async close() {
        await browser.close();
        await dev.close();
        await new Promise((resolve) => built.httpServer.close(resolve));
        await writeFile(path.join(artifacts, 'summary.json'), JSON.stringify(receipts, null, 2));
        process.stdout.write('Browser evidence: ' + artifacts + '\n');
      },
    };
  } catch (error) {
    await browser?.close();
    await dev?.close();
    if (built) await new Promise((resolve) => built.httpServer.close(resolve));
    throw error;
  }
}
