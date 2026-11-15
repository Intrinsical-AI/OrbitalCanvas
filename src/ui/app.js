import {
  CAMERA_DEFAULTS,
  CONTROLS,
  DEFAULTS,
  PRESETS,
  clamp,
  presetValues,
  varyValues,
} from '../core/config.js';
import { Scene, PARTICLE_BUDGET, stepScene } from '../core/scene.js';
import { Renderer } from '../view/renderer.js';
import { createProjector } from '../view/projectors.js';
import { Viewport, currentDpr } from '../view/viewport.js';
import { Controls } from './controls.js';
import { EditorState } from './editor-state.js';
import { CameraInteraction } from './camera-interaction.js';
import { CaptureController } from './capture-controller.js';
import {
  defaultDocument,
  encodeDocument,
  initialDocument,
  readPreferences,
  storeDocument,
  storePreferences,
} from './permalink.js';
import { applyAppearance, colors } from './theme.js';

const SIDE_PANEL = '(min-width: 1024px), (min-width: 720px) and (max-height: 500px)';
const editableText = (target) =>
  target?.closest(
    'textarea, [contenteditable]:not([contenteditable="false"]), input:not([type="range"]):not([type="checkbox"]):not([type="color"])'
  );

export class App {
  constructor(doc, version) {
    this.doc = doc;
    this.version = version;
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
      'videoFormatInput',
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
    if (this.reducedMotion && boot.source === 'defaults') boot.document.camera.autoOrbit = false;
    this.editor = new EditorState(boot.document);
    this.scene = new Scene(this.document.parameters);
    this.projector = createProjector(this.document.view, this.camera);
    this.context = this.el.canvas.getContext('2d', { alpha: false });
    if (!this.context) throw new Error('Could not create the artwork canvas.');
    this.running = false;
    this.destroyed = false;
    this.panelExpanded = false;
    this.lastPreset = this.matchedPreset()?.id ?? 'default';
    this.dirty = false;
    this.sidePanel = matchMedia(SIDE_PANEL);
    this.on(this.sidePanel, 'change', () => this.layout());
    this.viewport = new Viewport(this.el.canvas, this.context, () => this.layout());
    this.renderer = new Renderer(this.context, this.viewport);
    this.controls = new Controls(
      this.el.controlsPanel,
      {
        begin: (label) => {
          this.cameraInteraction.finish();
          this.begin(label);
        },
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
    this.capture = new CaptureController(this);
    this.cameraInteraction = new CameraInteraction(this);
    this.bind();
    this.sync();
    this.layout();
    if (!this.reducedMotion) this.start();
    if (boot.error) this.status(boot.error);
  }
  on(target, type, handler, options = {}) {
    target.addEventListener(type, handler, { ...options, signal: this.abort.signal });
  }
  get document() {
    return this.editor.document;
  }
  set document(value) {
    this.editor.document = value;
  }
  get camera() {
    return this.editor.camera;
  }
  get history() {
    return this.editor.history;
  }
  begin(label = 'edit') {
    this.editor.begin(label);
  }
  commit() {
    const changed = this.editor.commit();
    if (changed || this.dirty) this.persist();
    this.paintHistory();
  }
  cancelEdit() {
    if (this.editor.cancel()) {
      this.apply();
      this.persist();
    }
  }
  action(label, change) {
    this.cameraInteraction?.finish();
    this.commit();
    this.begin(label);
    change();
    this.apply();
    this.commit();
  }
  changeParameter(key, value, finish = false) {
    this.cameraInteraction.finish();
    if (finish) this.commit();
    this.begin('change ' + key);
    this.document.parameters[key] = value;
    this.apply();
    if (finish) this.commit();
  }
  apply() {
    this.editor.apply();
    this.scene.setMany(Object.entries(this.document.parameters));
    if (this.document.rangeMode === 'safe') this.scene.enforceBudget();
    if (this.projector.id !== this.document.view)
      this.projector = createProjector(this.document.view, this.camera);
    this.changed();
    this.sync();
    this.draw(0, true);
  }
  undo(redo = false) {
    this.cameraInteraction.finish();
    const entry = redo ? this.editor.redo() : this.editor.undo();
    if (entry) {
      this.apply();
      this.persist();
      this.status((redo ? 'Redid ' : 'Undid ') + entry.label);
    } else this.status(redo ? 'Nothing to redo' : 'Nothing to undo');
    this.paintHistory();
  }
  hideShareLink() {
    const field = this.doc.getElementById('shareLink');
    if (field) field.hidden = true;
  }
  changed() {
    this.dirty = true;
    this.hideShareLink();
    if (location.hash) {
      const url = new URL(location.href);
      url.hash = '';
      window.history.replaceState(null, '', url);
    }
  }
  persist() {
    const saved = storeDocument(this.editor.liveDocument());
    this.dirty = !saved;
    if (!saved && !this.storageNotice) {
      this.storageNotice = true;
      this.status('Changes work here, but this browser cannot save them for reload.');
    }
  }
  matchedPreset() {
    return PRESETS.find((p) =>
      Object.entries(presetValues(p)).every(
        ([key, value]) => this.document.parameters[key] === value
      )
    );
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
    this.el.versionLabel.textContent = 'Orbital Canvas · ' + this.version;
    const matched = this.matchedPreset();
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
    stepScene(this.scene, dt, this.document.rangeMode);
    this.camera.update(
      dt,
      this.document.camera.autoOrbit &&
        this.document.view === '3d' &&
        !this.cameraInteraction.active
    );
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
    this.cameraInteraction.finish();
    this.commit();
    const shared = this.editor.liveDocument();
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
      }
      if (this.el.captureDialog.open) this.el.captureSummary.after(field);
      else this.el.statusLine.after(field);
      field.value = url.href;
      field.hidden = false;
      field.focus();
      field.select();
      this.status('Copy this configuration link');
    }
  }
  toggleUi(hidden = !this.uiHidden) {
    if (this.capture.exporting) return;
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
      image.src = new URL(`../../resources/preset-${preset.id}.png`, import.meta.url).href;
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
        const document = defaultDocument(
          matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
        );
        if (this.reducedMotion) document.camera.autoOrbit = false;
        this.editor.replace(document);
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
    this.capture.bind();
    this.on(window, 'resize', () => this.layout());
    this.on(window.visualViewport ?? window, 'resize', () => this.layout());
    const flush = () => {
      this.cameraInteraction.finish();
      this.commit();
    };
    this.on(window, 'pagehide', flush);
    this.on(this.doc, 'visibilitychange', () => {
      if (this.doc.hidden) flush();
    });
    this.on(this.doc, 'keydown', (event) => this.keydown(event));
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
    const modal = this.el.captureDialog.open
      ? this.el.captureDialog
      : this.el.shortcuts.open
        ? this.el.shortcuts
        : null;
    if (modal && event.key === 'Tab' && !event.ctrlKey && !event.altKey && !event.metaKey) {
      const fields = [
        ...modal.querySelectorAll('button,input,select,textarea,a[href],[tabindex]'),
      ].filter((field) => !field.disabled && field.tabIndex >= 0 && field.getClientRects().length);
      const index = fields.indexOf(this.doc.activeElement);
      const next =
        index < 0
          ? event.shiftKey
            ? fields.length - 1
            : 0
          : (index + (event.shiftKey ? -1 : 1) + fields.length) % fields.length;
      event.preventDefault();
      (fields[next] ?? modal).focus();
      return;
    }
    if (event.key === 'Escape') {
      if (this.capture.exporting) {
        event.preventDefault();
        this.capture.cancel();
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
    if (this.cameraInteraction.keydown(event)) return;
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
      s: () => this.capture.savePng(),
      0: () => this.recenter(),
    };
    const action = actions[event.key.toLowerCase()];
    if (action) {
      event.preventDefault();
      action();
    }
  }
  destroy() {
    if (this.destroyed) return;
    this.cameraInteraction.destroy();
    this.commit();
    this.destroyed = true;
    this.stop();
    this.capture.destroy();
    this.abort.abort();
    this.viewport.destroy();
    this.controls.destroy();
    if (this.el.captureDialog.open) this.el.captureDialog.close();
    if (this.el.shortcuts.open) this.el.shortcuts.close();
  }
}
