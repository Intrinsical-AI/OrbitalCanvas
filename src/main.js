import './styles.css';
import { version } from '../package.json';
import {
  CAMERA_DEFAULTS,
  CONTROLS,
  DEFAULTS,
  PRESETS,
  clamp,
  presetValues,
  varyValues,
} from './core/config.js';
import { Scene, PARTICLE_BUDGET } from './core/scene.js';
import { Camera } from './view/camera.js';
import { Renderer } from './view/renderer.js';
import { createProjector } from './view/projectors.js';
import { Viewport, currentDpr } from './view/viewport.js';
import { Controls } from './ui/controls.js';
import { History } from './ui/history.js';
import {
  CAPTURE_DEFAULTS,
  defaultDocument,
  encodeDocument,
  initialDocument,
  readPreferences,
  storeDocument,
  storePreferences,
  validateDocument,
} from './ui/permalink.js';
import { CaptureScene, captureSize, captureLimit, validateCapture } from './ui/capture.js';
import { Recorder, download, timestamp } from './ui/recorder.js';
import { applyAppearance, colors } from './ui/theme.js';

const SIDE_PANEL = '(min-width: 1024px), (min-width: 720px) and (max-height: 500px)';
const clone = (value) => structuredClone(value);
const editableText = (target) =>
  target?.closest(
    'textarea, [contenteditable]:not([contenteditable="false"]), input:not([type="range"]):not([type="checkbox"]):not([type="color"])'
  );

export class App {
  constructor(doc) {
    this.doc = doc;
    const ids = [
      'canvas',
      'hud',
      'viewToggle',
      'topBar',
      'bottomBar',
      'panel',
      'panelToggle',
      'panelClose',
      'presetsButton',
      'expandButton',
      'exploreTab',
      'editTab',
      'explorePage',
      'editPage',
      'controlsPanel',
      'presetCards',
      'presetName',
      'reapplyButton',
      'strengthSelect',
      'variationButton',
      'playButton',
      'moreMenu',
      'shareButton',
      'restartButton',
      'resetButton',
      'cameraResetButton',
      'themeButton',
      'fullscreenButton',
      'hideButton',
      'showUiButton',
      'shortcutsButton',
      'shortcuts',
      'shortcutsClose',
      'shortcutsEnabled',
      'diagnosticsEnabled',
      'diagnostics',
      'versionLabel',
      'spawnSelect',
      'rangeSelect',
      'autoOrbitInput',
      'orbitField',
      'budgetNotice',
      'statusLine',
      'captureButton',
      'captureDialog',
      'captureClose',
      'captureType',
      'videoSettings',
      'resolutionInput',
      'durationInput',
      'fpsInput',
      'capturePreview',
      'capturePreviewNote',
      'captureSummary',
      'captureError',
      'captureProgress',
      'recordingIndicator',
      'exportButton',
      'cancelExportButton',
    ];
    this.el = Object.fromEntries(
      ids.map((id) => {
        const element = doc.getElementById(id);
        if (!element) throw new Error('Missing #' + id);
        return [id, element];
      })
    );
    this.abort = new AbortController();
    this.history = new History();
    this.preferences = readPreferences();
    this.reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const appearance = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    let storage;
    try {
      storage = localStorage;
    } catch {
      storage = { getItem: () => null };
    }
    const boot = initialDocument(location, storage, appearance);
    this.document = boot.document;
    if (this.reducedMotion) this.document.camera.autoOrbit = false;
    this.scene = new Scene(this.document.parameters);
    this.camera = new Camera(this.document.camera);
    this.appliedCamera = JSON.stringify(this.document.camera);
    this.projector = createProjector(this.document.view, this.camera);
    this.context = this.el.canvas.getContext('2d', { alpha: false });
    if (!this.context) throw new Error('Could not create the artwork canvas.');
    this.running = false;
    this.exporting = false;
    this.destroyed = false;
    this.panelExpanded = false;
    this.lastPreset = 'default';
    this.sidePanel = matchMedia(SIDE_PANEL);
    this.on(this.sidePanel, 'change', () => this.layout());
    this.viewport = new Viewport(this.el.canvas, this.context, () => this.layout());
    this.renderer = new Renderer(this.context, this.viewport);
    this.controls = new Controls(
      this.el.controlsPanel,
      {
        begin: (label) => this.begin(label),
        commit: () => this.commit(),
        cancel: () => this.cancelEdit(),
        change: (key, value, finish) => this.changeParameter(key, value, finish),
        resetGroup: (section) =>
          this.action('reset group', () => {
            for (const spec of CONTROLS.filter((s) => s.section === section))
              this.document.parameters[spec.key] = DEFAULTS[spec.key];
          }),
        group: (id, open) => {
          this.preferences.groups[id] = open;
          storePreferences(this.preferences);
        },
      },
      this.preferences.groups
    );
    this.bind();
    this.sync();
    this.layout();
    if (!this.reducedMotion) this.start();
    if (boot.error) this.status(boot.error);
  }
  on(target, type, handler, options = {}) {
    target.addEventListener(type, handler, { ...options, signal: this.abort.signal });
  }
  state() {
    return { document: clone(this.document), capture: clone(this.preferences.capture) };
  }
  begin(label = 'edit') {
    this.history.begin(this.state(), label);
  }
  commit() {
    this.history.commit(this.state());
    this.paintHistory();
  }
  cancelEdit() {
    const state = this.history.cancel();
    if (state) this.restore(state);
  }
  action(label, change) {
    this.commit();
    this.begin(label);
    change();
    this.apply();
    this.commit();
  }
  changeParameter(key, value, finish = false) {
    if (finish) this.commit();
    this.begin('change ' + key);
    this.document.parameters[key] = value;
    this.apply();
    if (finish) this.commit();
  }
  apply() {
    this.document = validateDocument(this.document);
    this.scene.setMany(Object.entries(this.document.parameters));
    if (this.document.rangeMode === 'safe') this.scene.enforceBudget();
    if (this.appliedCamera !== JSON.stringify(this.document.camera)) {
      this.camera = new Camera(this.document.camera);
      this.appliedCamera = JSON.stringify(this.document.camera);
    }
    this.projector = createProjector(this.document.view, this.camera);
    this.persist();
    this.sync();
    this.draw(0, true);
  }
  restore(state) {
    this.document = clone(state.document);
    this.preferences.capture = clone(state.capture);
    this.apply();
    this.paintHistory();
  }
  undo(redo = false) {
    const entry = redo ? this.history.redo(this.state()) : this.history.undo(this.state());
    if (entry) {
      this.restore(entry.state);
      this.status((redo ? 'Redid ' : 'Undid ') + entry.label);
    } else this.status(redo ? 'Nothing to redo' : 'Nothing to undo');
  }
  persist() {
    if (!storeDocument(this.document) && !this.storageNotice) {
      this.storageNotice = true;
      this.status('Changes work here, but this browser cannot save them for reload.');
    }
    storePreferences(this.preferences);
    if (location.hash) {
      const url = new URL(location.href);
      url.hash = '';
      window.history.replaceState(null, '', url);
    }
  }
  paintHistory() {
    for (const button of this.doc.querySelectorAll('[data-action="undo"]'))
      button.disabled = !this.history.past.length;
    for (const button of this.doc.querySelectorAll('[data-action="redo"]'))
      button.disabled = !this.history.future.length;
  }
  sync() {
    applyAppearance(this.document.appearance);
    this.controls.sync(this.document);
    this.el.spawnSelect.value = this.document.parameters.spawnMode;
    this.el.rangeSelect.value = this.document.rangeMode;
    this.el.autoOrbitInput.checked = this.document.camera.autoOrbit;
    this.el.orbitField.hidden = this.document.view === '2d';
    this.el.canvas.dataset.view = this.document.view;
    this.el.canvas.setAttribute(
      'aria-label',
      this.document.view === '3d'
        ? 'Orbital composition. Arrow keys orbit; plus and minus zoom.'
        : 'Orbital composition in flat 2D projection.'
    );
    for (const button of this.el.viewToggle.children)
      button.setAttribute('aria-pressed', String(button.dataset.value === this.document.view));
    this.el.themeButton.textContent =
      'Switch to ' + (this.document.appearance === 'dark' ? 'light' : 'dark') + ' appearance';
    this.el.shortcutsEnabled.checked = this.preferences.shortcuts;
    this.el.diagnosticsEnabled.checked = this.preferences.diagnostics;
    this.el.diagnostics.hidden = !this.preferences.diagnostics;
    this.el.versionLabel.textContent = 'Orbital Canvas · ' + version;
    const matched = PRESETS.find((p) =>
      Object.entries(presetValues(p)).every(
        ([key, value]) => this.document.parameters[key] === value
      )
    );
    this.el.presetName.textContent = matched?.label ?? 'Custom';
    this.el.reapplyButton.textContent =
      'Reapply ' + (PRESETS.find((p) => p.id === this.lastPreset)?.label ?? 'Default');
    for (const card of this.el.presetCards.children)
      card.setAttribute('aria-pressed', String(card.dataset.preset === matched?.id));
    this.paintHistory();
    this.updateBudget();
  }
  updateBudget() {
    const count = this.scene.particleCount,
      over = count > PARTICLE_BUDGET;
    this.el.budgetNotice.hidden = !over;
    if (over && this.budgetCount !== count)
      this.el.budgetNotice.textContent = count + ' particles · rendering may slow down';
    this.budgetCount = count;
  }
  start() {
    if (this.running || this.destroyed || this.el.captureDialog.open) return;
    this.running = true;
    this.lastTime = performance.now();
    this.paintPlay();
    this.raf = requestAnimationFrame((now) => this.frame(now));
  }
  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.paintPlay();
  }
  paintPlay() {
    this.el.playButton.textContent = this.running ? 'Pause' : 'Play';
    this.el.playButton.setAttribute(
      'aria-label',
      this.running ? 'Pause animation' : 'Play animation'
    );
  }
  frame(now) {
    if (!this.running || this.destroyed) return;
    const elapsed = (now - this.lastTime) / 1000;
    this.lastTime = now;
    this.advance(clamp(elapsed, 0, 0.1));
    this.fpsFrames = (this.fpsFrames ?? 0) + 1;
    this.fpsElapsed = (this.fpsElapsed ?? 0) + elapsed;
    if (this.fpsElapsed >= 1) {
      this.measuredFps = Math.round(this.fpsFrames / this.fpsElapsed);
      this.fpsFrames = 0;
      this.fpsElapsed = 0;
      this.el.diagnostics.textContent =
        this.measuredFps + ' FPS · ' + this.scene.particleCount + ' particles';
    }
    this.raf = requestAnimationFrame((next) => this.frame(next));
  }
  advance(dt) {
    dt = Number.isFinite(dt) ? clamp(dt, 0, 0.1) : 0;
    this.scene.step(dt);
    if (this.document.rangeMode === 'safe') this.scene.enforceBudget();
    this.camera.update(dt, this.document.camera.autoOrbit && this.document.view === '3d');
    this.updateBudget();
    this.draw(dt);
  }
  draw(dt = 0, clear = false) {
    if (!this.renderer || this.destroyed) return;
    if (this.viewport.dpr !== currentDpr()) {
      this.viewport.sync();
      return;
    }
    const theme = colors(this.document.appearance);
    if (clear) this.renderer.clear(theme.background);
    this.renderer.render(this.scene, this.projector, theme, dt);
  }
  layout() {
    if (!this.viewport) return;
    const top = this.el.topBar.getBoundingClientRect().bottom + 12;
    const bottom = this.el.bottomBar.getBoundingClientRect().top - 12;
    this.doc.documentElement.style.setProperty('--editor-top', top + 'px');
    this.doc.documentElement.style.setProperty('--editor-bottom', innerHeight - bottom + 'px');
    let x = 12,
      y = top,
      width = this.viewport.width - 24,
      height = Math.max(16, bottom - top);
    if (!this.el.panel.hidden) {
      const panel = this.el.panel.getBoundingClientRect();
      if (this.sidePanel.matches) {
        x = panel.right + 12;
        width = this.viewport.width - x - 12;
      } else height = Math.max(16, panel.top - y - 12);
    }
    if (this.uiHidden) {
      x = 0;
      y = 0;
      width = this.viewport.width;
      height = this.viewport.height;
    }
    this.viewport.frame = { x, y, width: Math.max(16, width), height };
    this.draw(0, true);
  }
  panel(page = 'edit', open = true) {
    this.el.panel.hidden = !open;
    this.el.explorePage.hidden = page !== 'explore';
    this.el.editPage.hidden = page !== 'edit';
    this.el.exploreTab.setAttribute('aria-pressed', String(page === 'explore'));
    this.el.editTab.setAttribute('aria-pressed', String(page === 'edit'));
    this.el.panelToggle.setAttribute('aria-expanded', String(open && page === 'edit'));
    this.el.presetsButton.setAttribute('aria-expanded', String(open && page === 'explore'));
    this.layout();
  }
  applyPreset(id) {
    const preset = PRESETS.find((p) => p.id === id);
    if (!preset) return;
    this.lastPreset = id;
    this.action('preset ' + preset.label, () =>
      Object.assign(this.document.parameters, presetValues(preset))
    );
    this.scene.restart('full');
    this.draw(0, true);
    this.status(preset.label + ' applied · Undo available');
  }
  variation() {
    this.action('variation', () =>
      Object.assign(
        this.document.parameters,
        varyValues(
          this.document.parameters,
          this.document.rangeMode,
          Number(this.el.strengthSelect.value)
        )
      )
    );
    this.status('Variation created · Undo available');
  }
  recenter() {
    this.action('recenter camera', () => {
      this.document.camera = { ...CAMERA_DEFAULTS, autoOrbit: this.document.camera.autoOrbit };
    });
  }
  status(message) {
    this.el.statusLine.textContent = message;
  }
  async share() {
    const shared = clone(this.document);
    shared.camera = this.camera.pose(shared.camera.autoOrbit);
    const url = new URL(location.href);
    url.hash = encodeDocument(shared);
    window.history.replaceState(null, '', url);
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Orbital Canvas', url: url.href });
        this.status('Configuration shared');
        return;
      } catch (error) {
        if (error.name === 'AbortError') {
          this.status('Sharing cancelled');
          return;
        }
      }
    }
    try {
      await navigator.clipboard.writeText(url.href);
      this.status('Configuration link copied');
    } catch {
      let field = this.doc.getElementById('shareLink');
      if (!field) {
        field = this.doc.createElement('input');
        field.id = 'shareLink';
        field.readOnly = true;
        field.setAttribute('aria-label', 'Configuration link');
        this.el.statusLine.after(field);
      }
      field.value = url.href;
      field.hidden = false;
      field.focus();
      field.select();
      this.status('Copy this configuration link');
    }
  }
  toggleUi(hidden = !this.uiHidden) {
    if (this.exporting) return;
    this.uiHidden = hidden;
    this.el.hud.hidden = hidden;
    this.el.panel.hidden = true;
    this.el.panelToggle.setAttribute('aria-expanded', 'false');
    this.el.presetsButton.setAttribute('aria-expanded', 'false');
    this.el.showUiButton.hidden = !hidden;
    this.layout();
    if (hidden) this.el.showUiButton.focus();
    else this.el.panelToggle.focus();
  }
  snapshot() {
    const { frame, dpr } = this.viewport;
    const canvas = this.doc.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(frame.width * dpr));
    canvas.height = Math.max(1, Math.floor(frame.height * dpr));
    const context = canvas.getContext('2d', { alpha: false });
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
  savePng(canvas = this.snapshot()) {
    canvas.toBlob((blob) => {
      if (!this.destroyed) {
        if (blob) {
          download(blob, 'orbital-canvas-' + timestamp() + '.png');
          this.status('PNG saved');
        } else this.status('PNG could not be created. Try again.');
      }
    }, 'image/png');
  }
  openCapture() {
    if (this.el.captureDialog.open) return;
    this.commit();
    this.captureWasRunning = this.running;
    this.stop();
    this.pngFrame = this.snapshot();
    this.captureDocument = clone(this.document);
    this.captureDocument.camera = this.camera.pose(this.document.camera.autoOrbit);
    this.el.resolutionInput.value = this.preferences.capture.resolution;
    this.el.durationInput.value = String(this.preferences.capture.duration);
    this.el.fpsInput.value = String(this.preferences.capture.fps);
    this.el.captureError.textContent = '';
    this.el.recordingIndicator.textContent = '';
    this.prepareCapture();
    this.el.captureDialog.showModal();
  }
  captureOptions() {
    return {
      resolution: this.el.resolutionInput.value,
      duration: Number(this.el.durationInput.value),
      fps: Number(this.el.fpsInput.value),
    };
  }
  prepareCapture() {
    const video = this.el.captureType.value === 'video';
    this.el.videoSettings.hidden = !video;
    this.el.exportButton.textContent = video ? 'Export video' : 'Save PNG';
    this.el.captureError.textContent = '';
    this.captureSpec = null;
    let source = this.pngFrame;
    if (video) {
      const options = this.captureOptions();
      const size = captureSize(options.resolution, this.pngFrame);
      const limit = captureLimit(size, options.fps);
      this.el.durationInput.max = String(limit);
      try {
        this.captureSpec = validateCapture(options, this.pngFrame);
      } catch (error) {
        this.el.captureError.textContent = error.message;
      }
      this.previewScene = new CaptureScene(this.captureDocument, size, this.doc);
      source = this.previewScene.canvas;
      this.el.captureSummary.textContent =
        size.width + ' × ' + size.height + ' · up to ' + limit + ' s at ' + options.fps + ' FPS';
      this.el.capturePreviewNote.textContent =
        'Reproducible restart · complete ring set · frame zero';
      if (this.captureSpec) {
        this.preferences.capture = options;
        storePreferences(this.preferences);
      }
    } else {
      this.el.captureSummary.textContent = source.width + ' × ' + source.height + ' · native PNG';
      this.el.capturePreviewNote.textContent = 'Exact current frame · includes accumulated trails';
    }
    this.el.exportButton.disabled = video && !this.captureSpec;
    Object.assign(this.el.capturePreview, { width: source.width, height: source.height });
    this.el.capturePreview.getContext('2d', { alpha: false }).drawImage(source, 0, 0);
  }
  async exportVideo() {
    if (this.exporting) return;
    if (this.el.captureType.value === 'png') {
      this.savePng(this.pngFrame);
      return;
    }
    this.prepareCapture();
    if (!this.captureSpec) return;
    const session = new CaptureScene(this.captureDocument, this.captureSpec, this.doc);
    this.exporting = true;
    this.el.captureProgress.hidden = false;
    this.el.captureProgress.value = 0;
    this.el.cancelExportButton.hidden = false;
    const locked = [...this.el.captureDialog.querySelectorAll('button,input,select')].filter(
      (e) => e !== this.el.cancelExportButton
    );
    const disabled = locked.map((e) => e.disabled);
    locked.forEach((e) => (e.disabled = true));
    this.recorder = new Recorder(session.canvas, (state) => {
      if (this.destroyed) return;
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
    try {
      const result = await this.recorder.record({
        ...this.captureSpec,
        renderFrame: (dt) => session.render(dt),
      });
      if (!this.destroyed) this.el.recordingIndicator.textContent = 'Saved ' + result.filename;
    } catch (error) {
      if (!this.destroyed)
        this.el.captureError.textContent =
          error.name === 'AbortError' ? 'Export cancelled.' : error.message;
    } finally {
      this.exporting = false;
      if (!this.destroyed) {
        locked.forEach((e, i) => (e.disabled = disabled[i]));
        this.el.cancelExportButton.hidden = true;
        this.el.captureProgress.hidden = true;
      }
      this.recorder = null;
    }
  }
  bind() {
    const e = this.el;
    this.on(e.playButton, 'click', () => (this.running ? this.stop() : this.start()));
    this.on(e.panelToggle, 'click', () => this.panel('edit', e.panel.hidden || e.editPage.hidden));
    this.on(e.presetsButton, 'click', () =>
      this.panel('explore', e.panel.hidden || e.explorePage.hidden)
    );
    this.on(e.panelClose, 'click', () => {
      const target = e.explorePage.hidden ? e.panelToggle : e.presetsButton;
      this.panel('edit', false);
      target.focus();
    });
    this.on(e.exploreTab, 'click', () => this.panel('explore'));
    this.on(e.editTab, 'click', () => this.panel('edit'));
    this.on(e.expandButton, 'click', () => {
      this.panelExpanded = !this.panelExpanded;
      e.panel.classList.toggle('is-expanded', this.panelExpanded);
      e.expandButton.textContent = this.panelExpanded ? 'Collapse' : 'Expand';
      e.expandButton.setAttribute('aria-expanded', String(this.panelExpanded));
      this.layout();
    });
    for (const preset of PRESETS) {
      const card = this.doc.createElement('button');
      card.type = 'button';
      card.dataset.preset = preset.id;
      card.className = 'preset-card';
      const image = this.doc.createElement('img');
      image.src = new URL(`../resources/preset-${preset.id}.png`, import.meta.url).href;
      image.alt = '';
      image.width = 160;
      image.height = 160;
      const label = this.doc.createElement('span');
      label.textContent = preset.label;
      card.append(image, label);
      e.presetCards.append(card);
      this.on(card, 'click', () => this.applyPreset(preset.id));
    }
    this.on(e.reapplyButton, 'click', () => this.applyPreset(this.lastPreset));
    this.on(e.variationButton, 'click', () => this.variation());
    this.on(e.spawnSelect, 'change', () =>
      this.changeParameter('spawnMode', e.spawnSelect.value, true)
    );
    this.on(e.rangeSelect, 'change', () =>
      this.action('parameter range', () => {
        this.document.rangeMode = e.rangeSelect.value;
      })
    );
    this.on(e.autoOrbitInput, 'change', () =>
      this.action('camera motion', () => {
        this.document.camera.autoOrbit = e.autoOrbitInput.checked;
      })
    );
    for (const button of this.doc.querySelectorAll('#viewToggle button'))
      this.on(button, 'click', () =>
        this.action('projection', () => {
          this.document.view = button.dataset.value;
        })
      );
    this.on(e.themeButton, 'click', () =>
      this.action('appearance', () => {
        this.document.appearance = this.document.appearance === 'dark' ? 'light' : 'dark';
      })
    );
    this.on(e.shareButton, 'click', () => this.share());
    this.on(e.cameraResetButton, 'click', () => this.recenter());
    this.on(e.restartButton, 'click', () => {
      this.scene.restart('intro');
      this.draw(0, true);
      this.status('Introduction restarted');
    });
    this.on(e.resetButton, 'click', () =>
      this.action('restore defaults', () => {
        this.document = defaultDocument(
          matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
        );
        if (this.reducedMotion) this.document.camera.autoOrbit = false;
        this.preferences.capture = { ...CAPTURE_DEFAULTS };
        this.scene = new Scene(this.document.parameters);
      })
    );
    for (const button of this.doc.querySelectorAll('[data-action]'))
      this.on(button, 'click', () => {
        const actions = {
          undo: () => this.undo(),
          redo: () => this.undo(true),
          variation: () => this.variation(),
          share: () => this.share(),
          recenter: () => this.recenter(),
        };
        actions[button.dataset.action]();
      });
    this.on(e.hideButton, 'click', () => this.toggleUi(true));
    this.on(e.showUiButton, 'click', () => this.toggleUi(false));
    this.on(e.fullscreenButton, 'click', () => this.fullscreen());
    e.fullscreenButton.disabled = !this.doc.fullscreenEnabled;
    this.on(e.shortcutsButton, 'click', () => e.shortcuts.showModal());
    this.on(e.shortcutsClose, 'click', () => e.shortcuts.close());
    this.on(e.shortcutsEnabled, 'change', () => {
      this.preferences.shortcuts = e.shortcutsEnabled.checked;
      storePreferences(this.preferences);
    });
    this.on(e.diagnosticsEnabled, 'change', () => {
      this.preferences.diagnostics = e.diagnosticsEnabled.checked;
      storePreferences(this.preferences);
      this.sync();
    });
    this.on(e.captureButton, 'click', () => this.openCapture());
    this.on(e.captureClose, 'click', () => {
      if (!this.exporting) e.captureDialog.close();
    });
    this.on(e.captureDialog, 'cancel', (event) => {
      if (this.exporting) {
        event.preventDefault();
        this.recorder?.cancel();
      }
    });
    this.on(e.captureDialog, 'close', () => {
      if (!this.destroyed && this.captureWasRunning) this.start();
      this.pngFrame = null;
      this.previewScene = null;
      this.captureDocument = null;
      e.captureButton.focus();
    });
    this.on(e.exportButton, 'click', () => this.exportVideo());
    this.on(e.cancelExportButton, 'click', () => this.recorder?.cancel());
    for (const input of [e.captureType, e.resolutionInput, e.durationInput, e.fpsInput])
      this.on(input, 'change', () => this.prepareCapture());
    this.on(window, 'resize', () => this.layout());
    this.on(window.visualViewport ?? window, 'resize', () => this.layout());
    this.on(this.doc, 'visibilitychange', () => {
      if (this.doc.hidden && this.recorder?.fallback)
        this.recorder.cancel(
          new Error('Real-time capture needs a visible tab. Keep this tab open and try again.')
        );
    });
    this.on(this.doc, 'keydown', (event) => this.keydown(event));
    this.bindPointer();
  }
  async fullscreen() {
    try {
      if (this.doc.fullscreenElement) await this.doc.exitFullscreen();
      else await this.doc.documentElement.requestFullscreen();
    } catch {
      this.status('Full screen is unavailable in this browser.');
    }
  }
  keydown(event) {
    if (event.key === 'Escape') {
      if (this.exporting) {
        event.preventDefault();
        this.recorder?.cancel();
        return;
      }
      if (this.el.captureDialog.open || this.el.shortcuts.open) return;
      if (this.uiHidden) {
        event.preventDefault();
        this.toggleUi(false);
      } else if (!this.el.panel.hidden) {
        this.panel('edit', false);
        this.el.panelToggle.focus();
      }
      return;
    }
    if (this.el.captureDialog.open || this.el.shortcuts.open || event.isComposing) return;
    const text = editableText(event.target);
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'z') {
      if (text) return;
      event.preventDefault();
      this.undo(event.shiftKey);
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey || text) return;
    if (event.target === this.el.canvas && this.document.view === '3d') {
      const moves = {
        ArrowLeft: [-24, 0],
        ArrowRight: [24, 0],
        ArrowUp: [0, -24],
        ArrowDown: [0, 24],
      };
      if (moves[event.key] || ['+', '=', '-', '_'].includes(event.key)) {
        event.preventDefault();
        this.begin('camera');
        if (moves[event.key]) this.camera.orbitBy(...moves[event.key]);
        else this.camera.zoomBy(['+', '='].includes(event.key) ? 1 / 1.12 : 1.12);
        this.document.camera = this.camera.pose(this.document.camera.autoOrbit);
        this.appliedCamera = JSON.stringify(this.document.camera);
        this.persist();
        this.draw(0, true);
        this.commit();
        return;
      }
    }
    if (event.target.closest('input,select,textarea,[contenteditable]')) return;
    if (event.key === ' ' && !event.repeat && !event.target.closest('button,a,summary')) {
      event.preventDefault();
      this.running ? this.stop() : this.start();
      return;
    }
    if (!this.preferences.shortcuts || event.repeat) return;
    const actions = {
      p: () => this.panel('edit', this.el.panel.hidden || this.el.editPage.hidden),
      2: () =>
        this.action('projection', () => {
          this.document.view = '2d';
        }),
      3: () =>
        this.action('projection', () => {
          this.document.view = '3d';
        }),
      '?': () => this.el.shortcuts.showModal(),
      f: () => this.fullscreen(),
      h: () => this.toggleUi(),
      r: () => this.variation(),
      s: () => this.savePng(),
      0: () => this.recenter(),
    };
    const action = actions[event.key.toLowerCase()];
    if (action) {
      event.preventDefault();
      action();
    }
  }
  bindPointer() {
    const canvas = this.el.canvas,
      pointers = new Map();
    let anchor = null,
      spread = 0;
    const distance = () => {
      const [a, b] = [...pointers.values()];
      return Math.hypot(a.x - b.x, a.y - b.y);
    };
    this.on(canvas, 'pointerdown', (event) => {
      if (this.document.view !== '3d' || pointers.size >= 2 || event.button !== 0) return;
      this.begin('camera');
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      canvas.setPointerCapture(event.pointerId);
      anchor = { x: event.clientX, y: event.clientY };
      if (pointers.size === 2) spread = distance();
    });
    this.on(canvas, 'pointermove', (event) => {
      if (!pointers.has(event.pointerId)) return;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pointers.size === 2) {
        const next = distance();
        if (spread > 0 && next > 0) this.camera.zoomBy(spread / next);
        spread = next;
      } else {
        this.camera.orbitBy(event.clientX - anchor.x, event.clientY - anchor.y);
        anchor = { x: event.clientX, y: event.clientY };
      }
      this.document.camera = this.camera.pose(this.document.camera.autoOrbit);
      this.appliedCamera = JSON.stringify(this.document.camera);
      this.persist();
      this.draw(0, true);
    });
    const end = (event) => {
      if (!pointers.delete(event.pointerId)) return;
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      spread = 0;
      anchor = [...pointers.values()][0] ?? null;
      if (!pointers.size) this.commit();
    };
    this.on(canvas, 'pointerup', end);
    this.on(canvas, 'pointercancel', end);
    this.on(
      canvas,
      'wheel',
      (event) => {
        if (this.document.view !== '3d') return;
        event.preventDefault();
        this.begin('camera zoom');
        this.camera.zoomBy(event.deltaY > 0 ? 1.08 : 1 / 1.08);
        this.document.camera = this.camera.pose(this.document.camera.autoOrbit);
        this.appliedCamera = JSON.stringify(this.document.camera);
        this.persist();
        this.draw(0, true);
        this.commit();
      },
      { passive: false }
    );
    this.on(canvas, 'dblclick', () => this.recenter());
  }
  destroy() {
    this.destroyed = true;
    this.stop();
    this.recorder?.cancel();
    this.abort.abort();
    this.viewport.destroy();
    this.controls.destroy();
    if (this.el.captureDialog.open) this.el.captureDialog.close();
    if (this.el.shortcuts.open) this.el.shortcuts.close();
  }
}

const app = new App(document);
if (import.meta.hot) import.meta.hot.dispose(() => app.destroy());
