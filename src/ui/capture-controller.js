import { CaptureScene, captureSize, captureLimit, validateCapture } from './capture.js';
import { storePreferences } from './permalink.js';
import { Recorder, download, timestamp } from './recorder.js';

/** Capture owns its dialog, previews and export lifetime; the editor owns the artwork. */
export class CaptureController {
  constructor(app) {
    this.app = app;
    this.el = app.el;
    this.exporting = false;
    this.recorder = null;
  }
  snapshot() {
    const { frame, dpr } = this.app.viewport;
    const canvas = this.app.doc.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(frame.width * dpr));
    canvas.height = Math.max(1, Math.floor(frame.height * dpr));
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('Could not create the PNG canvas.');
    context.drawImage(
      this.el.canvas,
      Math.floor(frame.x * dpr),
      Math.floor(frame.y * dpr),
      canvas.width,
      canvas.height,
      0,
      0,
      canvas.width,
      canvas.height
    );
    return canvas;
  }
  savePng(canvas) {
    try {
      (canvas ?? this.snapshot()).toBlob((blob) => {
        if (this.app.destroyed) return;
        if (blob) {
          download(blob, 'orbital-canvas-' + timestamp() + '.png');
          this.app.status('PNG saved');
        } else this.app.status('PNG could not be created. Try again.');
      }, 'image/png');
    } catch (error) {
      this.app.status(error.message);
    }
  }
  open() {
    if (this.el.captureDialog.open) return;
    this.app.cameraInteraction.finish();
    this.app.commit();
    this.wasRunning = this.app.running;
    this.app.stop();
    try {
      this.pngFrame = this.snapshot();
      this.previewScene = null;
      this.document = this.app.editor.liveDocument();
      const saved = this.app.preferences.capture;
      this.el.resolutionInput.value = saved.resolution;
      this.el.videoFormatInput.value = saved.format;
      this.el.durationInput.value = String(saved.duration);
      this.el.fpsInput.value = String(saved.fps);
      this.el.captureError.textContent = '';
      this.el.recordingIndicator.textContent = '';
      this.prepare();
      this.el.captureDialog.showModal();
    } catch (error) {
      this.release();
      this.app.status(error.message);
      if (this.wasRunning) this.app.start();
    }
  }
  canvas(size) {
    const canvas = this.app.doc.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    return canvas;
  }
  options() {
    return {
      format: this.el.videoFormatInput.value,
      resolution: this.el.resolutionInput.value,
      duration: Number(this.el.durationInput.value),
      fps: Number(this.el.fpsInput.value),
    };
  }
  prepare() {
    const text = (element, value) => {
      if (element.textContent !== value) element.textContent = value;
    };
    const video = this.el.captureType.value === 'video';
    this.el.videoSettings.hidden = !video;
    text(this.el.exportButton, video ? 'Export video' : 'Save PNG');
    text(this.el.captureError, '');
    this.spec = null;
    let source = this.pngFrame;
    if (video) {
      const options = this.options();
      const size = captureSize(options.resolution, this.pngFrame);
      const limit = captureLimit(size, options.fps);
      this.el.durationInput.max = String(limit);
      try {
        this.spec = validateCapture(options, this.pngFrame);
      } catch (error) {
        text(this.el.captureError, error.message);
      }
      if (
        !this.previewScene ||
        this.previewScene.canvas.width !== size.width ||
        this.previewScene.canvas.height !== size.height
      )
        this.previewScene = new CaptureScene(this.document, this.canvas(size));
      source = this.previewScene.canvas;
      text(
        this.el.captureSummary,
        size.width + ' × ' + size.height + ' · up to ' + limit + ' s at ' + options.fps + ' FPS'
      );
      text(this.el.capturePreviewNote, 'Reproducible restart · complete ring set · frame zero');
      if (this.spec && JSON.stringify(this.app.preferences.capture) !== JSON.stringify(options)) {
        this.app.preferences.capture = options;
        storePreferences(this.app.preferences);
      }
    } else {
      text(this.el.captureSummary, source.width + ' × ' + source.height + ' · native PNG');
      text(this.el.capturePreviewNote, 'Exact current frame · includes accumulated trails');
    }
    this.el.exportButton.disabled = video && !this.spec;
    if (this.el.capturePreview.width !== source.width) this.el.capturePreview.width = source.width;
    if (this.el.capturePreview.height !== source.height)
      this.el.capturePreview.height = source.height;
    const context = this.el.capturePreview.getContext('2d', { alpha: false });
    if (!context) throw new Error('Could not create the capture preview.');
    context.drawImage(source, 0, 0);
  }
  refresh() {
    try {
      this.prepare();
    } catch (error) {
      this.spec = null;
      this.el.exportButton.disabled = true;
      this.el.captureError.textContent = error.message;
    }
  }
  async export() {
    if (this.exporting) return;
    if (this.el.captureType.value === 'png') {
      this.savePng(this.pngFrame);
      return;
    }
    try {
      this.prepare();
    } catch (error) {
      this.el.captureError.textContent = error.message;
      return;
    }
    if (!this.spec) return;
    this.exporting = true;
    this.el.captureProgress.hidden = false;
    this.el.captureProgress.value = 0;
    this.el.cancelExportButton.hidden = false;
    const locked = [...this.el.captureDialog.querySelectorAll('button,input,select')].filter(
      (element) => element !== this.el.cancelExportButton
    );
    const disabled = locked.map((element) => element.disabled);
    locked.forEach((element) => (element.disabled = true));
    try {
      this.recorder = new Recorder(this.canvas(this.spec), (state) => {
        if (this.app.destroyed) return;
        this.el.captureProgress.value = state.progress;
        if (state.recording)
          this.el.recordingIndicator.textContent =
            Math.round(state.progress * 100) +
            '% · ' +
            (state.note.includes('MediaRecorder')
              ? 'Real-time capture; frames may vary'
              : state.progress === 0
                ? 'Preparing video'
                : 'Encoding video');
      });
      const result = await this.recorder.record({ ...this.spec, document: this.document });
      if (!this.app.destroyed) this.el.recordingIndicator.textContent = 'Saved ' + result.filename;
    } catch (error) {
      if (!this.app.destroyed)
        this.el.captureError.textContent =
          error.name === 'AbortError' ? 'Export cancelled.' : error.message;
    } finally {
      this.exporting = false;
      this.recorder = null;
      if (!this.app.destroyed) {
        locked.forEach((element, index) => (element.disabled = disabled[index]));
        this.el.cancelExportButton.hidden = true;
        this.el.captureProgress.hidden = true;
      }
    }
  }
  cancel() {
    this.recorder?.cancel();
  }
  release() {
    this.pngFrame = null;
    this.previewScene = null;
    this.document = null;
    this.spec = null;
    this.app.hideShareLink();
  }
  bind() {
    const on = (...args) => this.app.on(...args);
    const e = this.el;
    on(e.captureButton, 'click', () => this.open());
    on(e.captureClose, 'click', () => {
      if (!this.exporting) e.captureDialog.close();
    });
    on(e.captureDialog, 'cancel', (event) => {
      if (this.exporting) {
        event.preventDefault();
        this.cancel();
      }
    });
    on(e.captureDialog, 'close', () => {
      this.release();
      if (!this.app.destroyed) {
        if (this.wasRunning) this.app.start();
        e.captureButton.focus();
      }
    });
    on(e.exportButton, 'click', () => this.export());
    on(e.cancelExportButton, 'click', () => this.cancel());
    for (const input of [
      e.captureType,
      e.videoFormatInput,
      e.resolutionInput,
      e.durationInput,
      e.fpsInput,
    ])
      on(input, 'change', () => this.refresh());
    on(this.app.doc, 'visibilitychange', () => {
      if (this.app.doc.hidden && this.recorder?.fallback)
        this.recorder.cancel(
          new Error('Real-time capture needs a visible tab. Keep this tab open and try again.')
        );
    });
  }
  destroy() {
    this.cancel();
    this.release();
  }
}
