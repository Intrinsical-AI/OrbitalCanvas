import { harness } from './browser-helpers.mjs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
const h = await harness();
try {
  const { page, context } = await h.page();
  const images = await page.evaluate(async () => {
    const { CaptureScene } = await import('/src/ui/capture.js');
    const { defaultDocument } = await import('/src/ui/permalink.js');
    const { PRESETS, presetValues } = await import('/src/core/config.js');
    return PRESETS.map((p) => {
      const doc = defaultDocument();
      Object.assign(doc.parameters, presetValues(p));
      doc.camera.autoOrbit = false;
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 320;
      const scene = new CaptureScene(doc, canvas);
      for (let i = 0; i < 120; i++) scene.render(1 / 60);
      return { id: p.id, image: scene.canvas.toDataURL('image/png').split(',')[1] };
    });
  });
  for (const item of images)
    await writeFile(
      path.join('resources', 'preset-' + item.id + '.png'),
      Buffer.from(item.image, 'base64')
    );
  await page.reload();
  await page.waitForFunction(() => Boolean(window.smokeApp));
  await page.evaluate(() => {
    const app = window.smokeApp;
    app.stop();
    app.document.camera.autoOrbit = false;
    app.apply();
    app.scene.restart('full');
    for (let i = 0; i < 120; i++) app.advance(1 / 60);
    app.panel('edit');
  });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: 'resources/interface.png' });
  await context.close();
  const mobile = await h.page({ viewport: { width: 390, height: 844 }, hasTouch: true });
  await mobile.page.evaluate(() => {
    const app = window.smokeApp;
    app.stop();
    app.document.camera.autoOrbit = false;
    app.apply();
    app.scene.restart('full');
    for (let i = 0; i < 120; i++) app.advance(1 / 60);
    app.panel('edit');
  });
  await mobile.page.screenshot({ path: 'resources/interface-mobile.png' });
  await mobile.context.close();
} finally {
  await h.close();
}
