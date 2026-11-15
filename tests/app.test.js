import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../src/ui/app.js';
import { EditorState } from '../src/ui/editor-state.js';
import { defaultDocument, DOCUMENT_KEY, PREFERENCES_KEY } from '../src/ui/permalink.js';
import { Scene } from '../src/core/scene.js';
import { createProjector } from '../src/view/projectors.js';

function setup() {
  const app = Object.create(App.prototype);
  const link = { hidden: false };
  const location = new URL('https://example.test/editor/#v=2');
  vi.stubGlobal('location', location);
  vi.stubGlobal('window', {
    history: {
      replaceState: vi.fn((_state, _title, url) => {
        location.href = url.href;
      }),
    },
  });
  const storage = { setItem: vi.fn() };
  vi.stubGlobal('localStorage', storage);
  Object.assign(app, {
    editor: new EditorState(defaultDocument()),
    scene: new Scene(),
    preferences: { capture: { format: 'auto', duration: 12, fps: 60, resolution: 'square' } },
    cameraInteraction: { finish: vi.fn() },
    doc: { getElementById: () => link },
    sync: vi.fn(),
    draw: vi.fn(),
    paintHistory: vi.fn(),
    status: vi.fn(),
    dirty: false,
  });
  app.projector = createProjector(app.document.view, app.camera);
  return { app, storage, link, location };
}

afterEach(() => vi.unstubAllGlobals());

it('invalidates the shared link on input but stores only when the gesture is committed', () => {
  const { app, storage, link, location } = setup();
  app.changeParameter('numPoints', 80);
  app.changeParameter('numPoints', 90);
  expect(location.hash).toBe('');
  expect(link.hidden).toBe(true);
  expect(storage.setItem).not.toHaveBeenCalled();
  expect(app.history.past).toHaveLength(0);
  app.commit();
  expect(app.history.past).toHaveLength(1);
  expect(storage.setItem).toHaveBeenCalledOnce();
  expect(storage.setItem).toHaveBeenCalledWith(DOCUMENT_KEY, expect.any(String));
  expect(JSON.parse(storage.setItem.mock.calls[0][1]).parameters.numPoints).toBe(90);
  expect(storage.setItem).not.toHaveBeenCalledWith(PREFERENCES_KEY, expect.anything());
});

it('persists the live camera without adding automatic motion to history', () => {
  const { app, storage } = setup();
  app.changeParameter('size', 4);
  app.camera.update(10, true);
  const yaw = app.camera.yaw;
  app.commit();
  expect(JSON.parse(storage.setItem.mock.calls[0][1]).camera.yaw).toBeCloseTo(yaw, 12);
  expect(app.history.past[0].changes.map(({ path }) => path)).toEqual([['parameters', 'size']]);
  app.undo();
  expect(app.camera.yaw).toBeCloseTo(yaw, 12);
  expect(app.document.parameters.size).toBe(3);
  expect(app.preferences.capture.duration).toBe(12);
});

it('keeps the live camera when toggling automatic motion through an application action', () => {
  const { app } = setup();
  app.camera.update(10, true);
  const camera = app.camera;
  const yaw = camera.yaw;
  app.action('camera motion', () => {
    app.document.camera.autoOrbit = false;
  });
  expect(app.camera).toBe(camera);
  expect(app.camera.yaw).toBeCloseTo(yaw, 12);
  app.undo();
  expect(app.document.camera.autoOrbit).toBe(true);
  expect(app.camera.yaw).toBeCloseTo(yaw, 12);
});

it('announces failed persistence once, then retries the unsaved document', () => {
  const { app, storage } = setup();
  storage.setItem.mockImplementationOnce(() => {
    throw new Error('Storage blocked');
  });
  app.changeParameter('size', 4, true);
  expect(app.dirty).toBe(true);
  expect(app.status).toHaveBeenCalledOnce();
  app.commit();
  expect(app.dirty).toBe(false);
  expect(storage.setItem).toHaveBeenCalledTimes(2);
  expect(app.status).toHaveBeenCalledOnce();
});

it('persists a pending edit when Redo commits it and discards the old future', () => {
  const { app, storage } = setup();
  app.changeParameter('size', 4, true);
  app.undo();
  storage.setItem.mockClear();
  app.changeParameter('size', 5);
  app.undo(true);
  expect(app.document.parameters.size).toBe(5);
  expect(app.history.pending).toBeNull();
  expect(app.history.future).toHaveLength(0);
  expect(storage.setItem).toHaveBeenCalledOnce();
  expect(JSON.parse(storage.setItem.mock.calls[0][1]).parameters.size).toBe(5);
  expect(app.dirty).toBe(false);
});
