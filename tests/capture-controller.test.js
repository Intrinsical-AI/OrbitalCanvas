import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CaptureController } from '../src/ui/capture-controller.js';
import { EditorState } from '../src/ui/editor-state.js';
import { defaultDocument } from '../src/ui/permalink.js';

const mocks = vi.hoisted(() => ({
  store: vi.fn(),
  record: vi.fn(),
  cancel: vi.fn(),
  recorder: vi.fn(),
  download: vi.fn(),
}));
vi.mock('../src/ui/permalink.js', async (original) => ({
  ...(await original()),
  storePreferences: mocks.store,
}));
vi.mock('../src/ui/capture.js', async (original) => ({
  ...(await original()),
  CaptureScene: class {
    constructor(_document, canvas) {
      this.canvas = canvas;
    }
  },
}));
vi.mock('../src/ui/recorder.js', () => ({
  Recorder: class {
    constructor(...args) {
      mocks.recorder(...args);
    }
    record = mocks.record;
    cancel = mocks.cancel;
  },
  download: mocks.download,
  timestamp: () => '2026-11-15T20-00-00',
}));

class Element extends EventTarget {
  constructor(value = '') {
    super();
    this.value = value;
    this.textContent = '';
    this.hidden = false;
    this.disabled = false;
    this.open = false;
    this.width = 320;
    this.height = 240;
    this.focus = vi.fn();
    this.getContext = vi.fn(() => ({ drawImage: vi.fn() }));
    this.showModal = vi.fn(() => {
      this.open = true;
    });
    this.close = vi.fn(() => {
      this.open = false;
      this.dispatchEvent(new Event('close'));
    });
  }
}

function setup(running = true) {
  const ids = [
    'canvas',
    'captureButton',
    'captureClose',
    'videoSettings',
    'capturePreview',
    'captureSummary',
    'captureError',
    'capturePreviewNote',
    'recordingIndicator',
    'exportButton',
    'cancelExportButton',
    'captureProgress',
    'captureDialog',
  ];
  const el = Object.fromEntries(ids.map((id) => [id, new Element()]));
  Object.assign(el, {
    captureType: new Element('video'),
    videoFormatInput: new Element('share'),
    resolutionInput: new Element('screen'),
    durationInput: new Element('6'),
    fpsInput: new Element('30'),
  });
  el.cancelExportButton.hidden = el.captureProgress.hidden = true;
  const fields = [
    el.captureClose,
    el.captureType,
    el.videoFormatInput,
    el.resolutionInput,
    el.durationInput,
    el.fpsInput,
    el.exportButton,
    el.cancelExportButton,
  ];
  el.captureDialog.querySelectorAll = () => fields;
  const doc = new EventTarget();
  doc.createElement = vi.fn(() => new Element());
  const editor = new EditorState(defaultDocument());
  const app = {
    el,
    doc,
    editor,
    running,
    destroyed: false,
    viewport: { frame: { x: 10, y: 20, width: 320, height: 240 }, dpr: 1 },
    preferences: { capture: { format: 'share', resolution: 'screen', duration: 6, fps: 30 } },
    cameraInteraction: { finish: vi.fn() },
    commit: vi.fn(() => editor.commit()),
    stop: vi.fn(() => {
      app.running = false;
    }),
    start: vi.fn(() => {
      app.running = true;
    }),
    status: vi.fn(),
    hideShareLink: vi.fn(),
    on: (target, type, listener, options) => target.addEventListener(type, listener, options),
  };
  const controller = new CaptureController(app);
  controller.bind();
  return { app, el, controller, editor };
}

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
  mocks.record.mockResolvedValue({ filename: 'clip.mp4', strategy: 'webcodecs:avc' });
});

describe('capture dialog lifetime', () => {
  it.each([true, false])('restores prior playing=%s when snapshot allocation fails', (running) => {
    const { app, el, controller } = setup(running);
    app.doc.createElement.mockImplementationOnce(() => ({ getContext: () => null }));
    controller.open();
    expect(app.status).toHaveBeenCalledWith('Could not create the PNG canvas.');
    expect(el.captureDialog.showModal).not.toHaveBeenCalled();
    expect(app.running).toBe(running);
    expect(app.start).toHaveBeenCalledTimes(running ? 1 : 0);
    expect(controller.pngFrame).toBeNull();
    expect(controller.document).toBeNull();
    expect(app.hideShareLink).toHaveBeenCalledOnce();
  });
  it.each([true, false])('restores prior playing=%s when opening preview fails', (running) => {
    const { app, el, controller } = setup(running);
    el.capturePreview.getContext.mockReturnValue(null);
    controller.open();
    expect(app.status).toHaveBeenCalledWith('Could not create the capture preview.');
    expect(el.captureDialog.showModal).not.toHaveBeenCalled();
    expect(app.running).toBe(running);
    expect(app.start).toHaveBeenCalledTimes(running ? 1 : 0);
    expect(controller.previewScene).toBeNull();
    expect(controller.spec).toBeNull();
  });
  it.each([true, false])('closing releases buffers and restores prior playing=%s', (running) => {
    const { app, el, controller } = setup(running);
    controller.open();
    expect(el.captureDialog.open).toBe(true);
    expect(app.running).toBe(false);
    expect(controller.pngFrame).not.toBeNull();
    expect(controller.previewScene).not.toBeNull();
    el.captureDialog.close();
    for (const key of ['pngFrame', 'previewScene', 'document', 'spec'])
      expect(controller[key]).toBeNull();
    expect(app.hideShareLink).toHaveBeenCalledOnce();
    expect(app.running).toBe(running);
    expect(app.start).toHaveBeenCalledTimes(running ? 1 : 0);
    expect(el.captureButton.focus).toHaveBeenCalledOnce();
  });
  it('reports preparation failures without entering export or resuming the paused editor', async () => {
    const { app, el, controller } = setup(true);
    controller.open();
    el.capturePreview.getContext.mockReturnValue(null);
    await controller.export();
    expect(el.captureError.textContent).toBe('Could not create the capture preview.');
    expect(controller.exporting).toBe(false);
    expect(controller.recorder).toBeNull();
    expect(el.exportButton.disabled).toBe(false);
    expect(el.cancelExportButton.hidden).toBe(true);
    expect(el.captureProgress.hidden).toBe(true);
    expect(mocks.recorder).not.toHaveBeenCalled();
    expect(app.running).toBe(false);
    expect(app.start).not.toHaveBeenCalled();
    expect(el.captureDialog.open).toBe(true);
  });
  it('destroying an active export cancels it without restarting or restoring focus', async () => {
    let reject;
    mocks.record.mockImplementation(
      () =>
        new Promise((_resolve, no) => {
          reject = no;
        })
    );
    mocks.cancel.mockImplementation(() => reject(new DOMException('Cancelled', 'AbortError')));
    const { app, el, controller } = setup(true);
    controller.open();
    const pending = controller.export();
    expect(controller.exporting).toBe(true);
    expect(el.exportButton.disabled).toBe(true);
    app.destroyed = true;
    controller.destroy();
    el.captureDialog.close();
    await pending;
    expect(mocks.cancel).toHaveBeenCalledOnce();
    expect(controller.exporting).toBe(false);
    expect(controller.recorder).toBeNull();
    expect(controller.document).toBeNull();
    expect(app.running).toBe(false);
    expect(app.start).not.toHaveBeenCalled();
    expect(el.captureButton.focus).not.toHaveBeenCalled();
    expect(mocks.download).not.toHaveBeenCalled();
  });
});

it('capture choices remain outside document history and persist only when changed', () => {
  const { app, el, controller, editor } = setup();
  editor.action('size', (document) => {
    document.parameters.size = 5;
  });
  const before = editor.liveDocument();
  controller.open();
  expect(mocks.store).not.toHaveBeenCalled();
  el.durationInput.value = '9';
  el.durationInput.dispatchEvent(new Event('change'));
  expect(app.preferences.capture.duration).toBe(9);
  expect(mocks.store).toHaveBeenCalledOnce();
  expect(mocks.store).toHaveBeenCalledWith(app.preferences);
  el.durationInput.dispatchEvent(new Event('change'));
  controller.prepare();
  expect(mocks.store).toHaveBeenCalledOnce();
  expect(editor.history.past).toHaveLength(1);
  expect(editor.history.pending).toBeNull();
  expect(editor.liveDocument()).toEqual(before);
  editor.undo();
  expect(editor.document.parameters.size).not.toBe(5);
  expect(app.preferences.capture.duration).toBe(9);
});
