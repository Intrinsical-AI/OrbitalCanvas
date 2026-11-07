import { before, after } from 'node:test';
import { harness } from './browser-helpers.mjs';
import { editingCases } from './browser-editing.mjs';
import { layoutCases } from './browser-layout.mjs';
import { captureCases } from './browser-capture.mjs';
let h;
before(async () => {
  h = await harness();
});
after(async () => {
  if (h) await h.close();
});
editingCases(() => h);
layoutCases(() => h);
captureCases(() => h);
