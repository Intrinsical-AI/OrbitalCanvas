import './styles.css';

import {
  CONTROLS,
  DEFAULTS,
  EXPORT_DEFAULTS,
  EXPORT_LIMITS,
  PRESETS,
  clamp,
} from './core/config.js';
import { PARTICLE_BUDGET, Scene } from './core/scene.js';
import { Camera } from './view/camera.js';
import { createProjector } from './view/projectors.js';
import { Renderer } from './view/renderer.js';
import { Viewport } from './view/viewport.js';
import { bindSegmented, Controls } from './ui/controls.js';
import { encodeConfig, initialConfig, storeConfig } from './ui/permalink.js';
import { Recorder } from './ui/recorder.js';
import { Theme } from './ui/theme.js';

const VIEW_STORAGE_KEY = 'orbital-canvas:view';

/** Below this width the parameter drawer covers the artwork, so it becomes a modal dialog. */
const WIDE_VIEWPORT = '(min-width: 1024px)';

/** Debounce for persisting the configuration; a slider drag emits far faster than this. */
const PERSIST_AFTER = 400;

/**
 * Composition root.
 *
 * Owns the frame loop and wires the pure core to the DOM. Everything below the UI layer is
 * DOM-free, so this is the only module that touches `document`, `requestAnimationFrame` or
 * `localStorage` besides `ui/`.
 */
class App {
  /**
   * @param {Document} doc
   */
  constructor(doc) {
    this.el = collectElements(doc);
    this.destroyed = false;
    this.exporting = false;
    this.reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

    /**
     * True once the user has picked a particle colour of their own. Until then the default
     * tracks the theme, because a fixed white default is invisible on a white canvas.
     */
    this.colorIsCustom = false;
    this.theme = new Theme((theme) => this.#onThemeChange(theme));

    // URL hash beats the stored session beats the defaults. Every value has already been
    // snapped and clamped by `decodeConfig`, so a hand-edited hash cannot get us here with an
    // out-of-range scene.
    const boot = initialConfig(window.location);
    // A colour that arrived in the link or the stored session is a colour the user chose, so
    // it must not be overwritten by the theme-tracking default.
    if ('color' in boot.values) this.colorIsCustom = true;

    this.scene = new Scene({
      view: initialView(doc, boot.meta),
      ...(boot.meta.spawnMode ? { spawnMode: boot.meta.spawnMode } : {}),
      ...boot.values,
      // A camera that orbits on its own is exactly the kind of unrequested motion the
      // reduced-motion preference is about. The control stays available either way.
      ...(this.reducedMotion ? { autoOrbit: false } : {}),
    });
    this.camera = new Camera();
    this.projector = createProjector(this.scene.config.view, this.camera);

    this.ctx = this.el.canvas.getContext('2d', { alpha: false });
    if (!this.ctx) throw new Error('Could not acquire a 2D context for #canvas.');

    this.viewport = new Viewport(this.el.canvas, this.ctx, () => {
      if (this.exporting) this.recorder.cancel();
      this.#renderOnce();
    });
    this.renderer = new Renderer(this.ctx, this.viewport);
    this.recorder = new Recorder(this.el.canvas, (state) => this.#onRecorderState(state));

    this.controls = new Controls(
      this.el.controls,
      this.scene.config,
      (key, value) => this.#onConfigChange(key, value),
      {
        onBatchChange: (changes) => this.#onConfigChanges(changes),
        onRangeModeChange: (mode) => this.#onRangeModeChange(mode),
        // The profile has to be in place before the inputs are built, or the range bounds
        // would be written at Safe limits and immediately clamp an Experimental link.
        rangeMode: boot.meta.rangeMode,
      }
    );
    this.#syncExportLimits(this.controls.rangeMode);

    this.running = false;
    this.rafId = null;
    this.renderRafId = null;
    this.lastTime = 0;
    this.persistTimer = null;
    /**
     * Single-step undo for the actions that overwrite the whole configuration at once.
     * @type {{config: Record<string, unknown>, rangeMode: string, colorIsCustom: boolean,
     *   label: string}|null}
     */
    this.undoState = null;
    /** @type {Array<() => void>} */
    this.teardown = [];

    this.#bindChrome();
    this.#bindPointer();
    this.#bindCanvasKeys();
    this.#bindKeyboard();
    this.#bindIdleFade();
    this.#updateBudgetWarning();
    // The Theme constructor ran before the scene existed, so apply its colour now.
    this.#onThemeChange();

    this.start();
  }

  // --- Frame loop -------------------------------------------------------

  start() {
    if (this.running || this.exporting || this.destroyed) return;
    this.running = true;
    this.lastTime = performance.now();
    this.#setPlayState(true);
    this.rafId = requestAnimationFrame((now) => this.#frame(now));
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    this.#setPlayState(false);
  }

  /** @param {number} now High-resolution timestamp from `requestAnimationFrame`. */
  #frame(now) {
    if (!this.running) return;
    this.rafId = requestAnimationFrame((next) => this.#frame(next));

    const dt = (now - this.lastTime) / 1000;
    this.lastTime = now;
    this.advance(dt);
  }

  /**
   * Advance the simulation and draw one frame.
   *
   * Exposed rather than private because the recorder drives it with a fixed `dt` during a
   * frame-exact export, while the rAF loop drives it with wall-clock deltas.
   *
   * @param {number} dt Seconds.
   */
  advance(dt) {
    if (this.destroyed) return;
    const orbiting = this.scene.config.autoOrbit && this.projector.sortsByDepth;
    this.camera.update(dt, orbiting);
    this.scene.step(dt);
    this.#draw();
  }

  #draw() {
    this.renderer.render(this.scene, this.projector, {
      ...this.theme.colors(),
      trailAlpha: this.scene.config.trailAlpha,
    });
  }

  /**
   * Request a redraw without advancing time. Paused interaction can produce many pointer/input
   * events per frame, so all such invalidations share one animation frame.
   */
  #renderOnce() {
    if (
      this.destroyed ||
      this.exporting ||
      !this.renderer ||
      this.running ||
      this.renderRafId !== null
    )
      return;
    this.renderRafId = requestAnimationFrame(() => {
      this.renderRafId = null;
      if (!this.running && !this.exporting && !this.destroyed) this.#draw();
    });
  }

  /**
   * Follow the theme with the default particle colour, so switching to light does not
   * leave white particles on a white canvas. A colour the user picked themselves is never
   * overwritten.
   *
   * @param {'dark'|'light'} [theme]
   */
  #onThemeChange(theme = this.theme?.current) {
    if (!this.colorIsCustom && this.scene) {
      this.scene.config.color = this.theme.colors().foreground;
      this.controls?.syncFromConfig(this.scene.config);
    }
    if (theme && this.el) {
      // The button offers the theme you would switch *to*, so its icon and label must
      // both flip. Driven by `data-state` like every other icon button here.
      this.el.themeButton.dataset.state = theme;
      const label = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
      // `title` is the hover tooltip and `aria-label` the accessible name; both are written
      // here so they cannot drift apart.
      this.el.themeButton.setAttribute('aria-label', label);
      this.el.themeButton.setAttribute('title', label);
    }
    this.#renderOnce();
  }

  // --- Configuration ----------------------------------------------------

  /**
   * @param {string} key
   * @param {unknown} value
   */
  #onConfigChange(key, value) {
    this.#onConfigChanges([[key, value]]);
  }

  /**
   * @param {ReadonlyArray<readonly [string, unknown]>} changes
   * @returns {boolean} Whether applying the changes rebuilt the scene.
   */
  #onConfigChanges(changes) {
    const rebuilt = this.scene.setMany(changes);
    for (const [key, value] of changes) {
      if (key === 'color') this.colorIsCustom = true;
      if (key === 'spawnMode') this.controls.updateVisibility(value);
    }
    this.#updateBudgetWarning();
    this.#renderOnce();
    this.#schedulePersist();
    return rebuilt;
  }

  // --- Persistence and sharing ------------------------------------------

  /** @returns {import('./ui/permalink.js').Meta} Non-control state carried in a permalink. */
  #meta() {
    return {
      view: this.scene.config.view,
      spawnMode: this.scene.config.spawnMode,
      rangeMode: this.controls.rangeMode,
    };
  }

  /**
   * Persist the configuration to `localStorage`, debounced — a slider drag emits an event per
   * frame and each one would otherwise be a synchronous storage write.
   *
   * Only storage. The URL hash is written on demand by the share action, because rewriting it
   * continuously would fight the address bar and flood history.
   */
  #schedulePersist() {
    clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      storeConfig(this.scene.config, this.#meta());
    }, PERSIST_AFTER);
  }

  /** Write the current scene into the URL and put that URL on the clipboard. */
  async #shareLink() {
    const url = new URL(window.location.href);
    url.hash = encodeConfig(this.scene.config, this.#meta());
    // Replace rather than push: sharing is not a navigation, and the back button should not
    // fill up with every scene the user copied.
    window.history.replaceState(null, '', url);

    try {
      await navigator.clipboard.writeText(url.href);
      this.#setStatus('Link copied');
    } catch {
      // Clipboard access can be refused or absent (insecure context, permissions). The hash
      // is in the address bar either way, so say so rather than failing silently.
      this.#setStatus('Link is in the address bar — copy it from there');
    }
  }

  // --- Undo -------------------------------------------------------------

  /**
   * Snapshot the whole configuration before an action that overwrites it.
   *
   * Randomise, reset and presets each discard a tuned scene in one click; without this there
   * is no way back to it. `colorIsCustom` is part of the snapshot because it is not stored in
   * the config — losing it would silently re-attach the particle colour to the theme.
   *
   * @param {string} label Shown in the status line.
   */
  #snapshotForUndo(label) {
    this.undoState = {
      config: { ...this.scene.config },
      rangeMode: this.controls.rangeMode,
      colorIsCustom: this.colorIsCustom,
      label,
    };
  }

  /** Restore the last snapshot, if there is one. */
  #undo() {
    if (!this.undoState) {
      this.#setStatus('Nothing to undo');
      return;
    }

    const { config, rangeMode, colorIsCustom, label } = this.undoState;
    // Single-step by design: the snapshot is consumed, not stacked.
    this.undoState = null;

    // Read the view before applying anything: `applyValues` writes `view` straight into the
    // config, so comparing afterwards would always report no change and the projector would
    // never be swapped.
    const viewChanged = config.view !== this.scene.config.view;

    if (rangeMode !== this.controls.rangeMode) {
      this.controls.setRangeMode(rangeMode);
      this.rangeToggle?.paint(rangeMode);
    }

    this.controls.applyValues(config);
    this.colorIsCustom = colorIsCustom;

    this.spawnToggle?.paint(config.spawnMode);
    this.controls.updateVisibility(config.spawnMode);
    if (viewChanged) {
      this.#applyView(config.view);
      this.viewToggle?.paint(config.view);
    }

    this.#onThemeChange();
    this.renderer.clear();
    this.#renderOnce();
    this.#setStatus(`Undid ${label}`);
  }

  /**
   * Apply a named preset. Unlike randomise, these are hand-picked regions of the parameter
   * space rather than a uniform sample of it.
   *
   * @param {string} id
   */
  #applyPreset(id) {
    const preset = PRESETS.find((candidate) => candidate.id === id);
    if (!preset) return;

    this.#snapshotForUndo(`preset "${preset.label}"`);
    // "Default" carries no values of its own, so it means every control key at its default —
    // restricted to control keys, because `view` and `spawnMode` are owned by their segmented
    // toggles and writing them here would desync the toggle from the scene.
    const values =
      preset.id === 'default'
        ? Object.fromEntries(CONTROLS.map((spec) => [spec.key, DEFAULTS[spec.key]]))
        : preset.values;
    this.controls.applyValues(values);
    this.renderer.clear();
    this.#renderOnce();
    this.#setStatus(`${preset.label} · Ctrl+Z to undo`);
  }

  /** @param {import('./core/config.js').RangeMode} mode */
  #onRangeModeChange(mode) {
    this.#syncExportLimits(mode);
    this.#setStatus(mode === 'safe' ? 'Safe parameter ranges' : 'Experimental parameter ranges');
  }

  /** @returns {Array<[string, HTMLInputElement]>} The export fields, paired with their key. */
  get #exportInputs() {
    return [
      ['duration', this.el.durationInput],
      ['fps', this.el.fpsInput],
    ];
  }

  /** @param {import('./core/config.js').RangeMode} mode */
  #syncExportLimits(mode) {
    const limits = EXPORT_LIMITS[mode];
    for (const [key, input] of this.#exportInputs) {
      const bound = limits[key];
      input.min = String(bound.min);
      input.max = String(bound.max);
      input.step = String(bound.step);
      input.setAttribute('aria-valuemin', String(bound.min));
      input.setAttribute('aria-valuemax', String(bound.max));
      input.setAttribute('aria-valuestep', String(bound.step));

      this.#clampExportInput(key, input, mode);
    }
  }

  /**
   * Snap one export field into its current profile's bounds.
   *
   * Bound to `change` as well as called from `#syncExportLimits`, because previously the only
   * clamp happened inside `#record` — so a typed `999` sat in the field looking accepted right
   * up until the export ran.
   *
   * @param {string} key
   * @param {HTMLInputElement} input
   * @param {import('./core/config.js').RangeMode} [mode]
   */
  #clampExportInput(key, input, mode = this.controls.rangeMode) {
    const bound = EXPORT_LIMITS[mode][key];
    const raw = Number(input.value);
    const value = Number.isFinite(raw) ? raw : EXPORT_DEFAULTS[key];
    input.value = String(clamp(Math.round(value), bound.min, bound.max));
  }

  /** @param {'2d'|'3d'} view */
  #applyView(view) {
    this.scene.config.view = view;
    // Only the projector is swapped: the scene, its phases and the camera are untouched,
    // so switching views is continuous and the two modes cannot drift apart.
    this.projector = createProjector(view, this.camera);
    this.el.canvas.dataset.view = view;
    document.body.dataset.view = view;
    this.#updateMeta();
    try {
      localStorage.setItem(VIEW_STORAGE_KEY, view);
    } catch {
      // Persisting the view is best-effort.
    }
  }

  /** @param {'2d'|'3d'} view */
  #setView(view) {
    if (this.scene.config.view === view) return;
    this.#applyView(view);
    this.#renderOnce();
  }

  /**
   * Surface an over-budget scene in both places it can be seen.
   *
   * The drawer carries the full sentence, but it is invisible while the drawer is closed —
   * which is exactly the case where a randomised 6,000-particle scene tanks the frame rate
   * with no explanation at all. The HUD notice covers that half, and is deliberately not a
   * `#setStatus` message: this is a standing condition, not a transient event, so it must not
   * self-clear after seven seconds.
   */
  #updateBudgetWarning() {
    const over = this.scene.isOverBudget();
    const { budgetWarning, budgetNotice } = this.el;

    budgetWarning.hidden = !over;
    budgetNotice.hidden = !over || this.#drawerOpen;

    if (over) {
      budgetWarning.textContent =
        `${this.scene.particleCount} particles exceeds the ${PARTICLE_BUDGET} budget — ` +
        'expect reduced frame rate.';
      budgetNotice.textContent = `${this.scene.particleCount} particles · over budget`;
    }
  }

  /**
   * Restart the simulation state without touching the current parameters, view, camera,
   * range profile, or export settings.
   */
  #restartCurrent() {
    this.scene.restart();
    this.renderer.clear();
    this.#updateBudgetWarning();
    this.#renderOnce();
    this.#setStatus('Restarted current configuration');
  }

  /**
   * Restore the complete application configuration in one transaction. The old reset action
   * only reset generated controls, which left spawn mode, projection and export settings
   * behind and made its name misleading.
   */
  #restoreDefaults() {
    const changes = this.controls.reset({ emit: false });
    changes.push(['spawnMode', DEFAULTS.spawnMode], ['view', DEFAULTS.view]);
    const rebuilt = this.#onConfigChanges(changes);
    // A default action is a restart even when only cosmetic/view values differed and the
    // config transaction therefore did not need a structural rebuild.
    if (!rebuilt) this.scene.restart();

    this.spawnToggle?.select(DEFAULTS.spawnMode, { notify: false });
    this.rangeToggle?.select('safe', { notify: false });
    this.viewToggle?.select(DEFAULTS.view, { notify: false });
    this.controls.updateVisibility(DEFAULTS.spawnMode);

    // Resetting the colour is special: the normal default follows the active theme rather
    // than being a fixed value, so clear the custom marker before syncing it.
    this.colorIsCustom = false;
    this.#onThemeChange();

    this.camera = new Camera();
    this.#applyView(DEFAULTS.view);

    this.el.durationInput.value = String(EXPORT_DEFAULTS.duration);
    this.el.fpsInput.value = String(EXPORT_DEFAULTS.fps);
    this.#syncExportLimits('safe');

    this.renderer.clear();
    this.#renderOnce();
    this.#setStatus('Defaults restored');
  }

  // --- Chrome -----------------------------------------------------------

  #bindChrome() {
    const { el } = this;

    this.#on(el.playButton, 'click', () => (this.running ? this.stop() : this.start()));

    this.#on(el.themeButton, 'click', () => this.theme.toggle());

    this.#on(el.restartButton, 'click', () => this.#restartCurrent());

    this.#on(el.resetButton, 'click', () => {
      this.#snapshotForUndo('reset');
      this.#restoreDefaults();
    });

    this.#on(el.randomizeButton, 'click', () => {
      this.#snapshotForUndo('randomise');
      this.controls.randomize();
      this.#setStatus('Randomised · Ctrl+Z to undo');
    });

    this.#on(el.shareButton, 'click', () => this.#shareLink());

    this.#on(el.snapshotButton, 'click', () => this.#saveSnapshot());

    // Export fields clamp as soon as you leave them, not at the moment you press Record.
    for (const [key, input] of this.#exportInputs) {
      this.#on(input, 'change', () => this.#clampExportInput(key, input));
    }

    for (const preset of PRESETS) {
      const option = document.createElement('option');
      option.value = preset.id;
      option.textContent = preset.label;
      el.presetSelect.append(option);
    }
    this.#on(el.presetSelect, 'change', () => this.#applyPreset(el.presetSelect.value));

    this.#on(el.recordButton, 'click', () => {
      if (this.recorder.recording) this.recorder.cancel();
      else this.#record();
    });

    this.viewToggle = bindSegmented(el.viewToggle, this.scene.config.view, (view) =>
      this.#setView(view)
    );
    this.spawnToggle = bindSegmented(el.spawnToggle, this.scene.config.spawnMode, (mode) => {
      this.controls.updateVisibility(mode);
      this.#onConfigChange('spawnMode', mode);
    });
    this.rangeToggle = bindSegmented(el.rangeToggle, this.controls.rangeMode, (mode) =>
      this.controls.setRangeMode(mode)
    );

    el.canvas.dataset.view = this.scene.config.view;
    document.body.dataset.view = this.scene.config.view;
    this.#bindDrawer();
    this.#bindShortcutSheet();

    el.year.textContent = String(new Date().getFullYear());
    this.#updateMeta();
  }

  /**
   * Slide-over parameter drawer.
   *
   * The drawer is a live preview of the artwork behind it, so on a wide viewport it is
   * deliberately **not** modal: no scrim, nothing dimmed, the piece keeps animating while a
   * slider is dragged. Previously the scrim sat at 40% opacity over the whole canvas, which
   * dimmed exactly the thing being tuned.
   *
   * Below the breakpoint the panel covers most of the screen, so there it is a real modal
   * dialog. The same query drives `.scrim` in styles.css; the two must stay in step.
   */
  #bindDrawer() {
    const { el } = this;

    this.wideViewport = window.matchMedia?.(WIDE_VIEWPORT) ?? { matches: true };
    // A resize across the breakpoint while the drawer is open must not strand the page in
    // the wrong mode — re-apply rather than waiting for the next open.
    const onBreakpoint = () => {
      if (this.#drawerOpen) this.#setDrawer(true, false);
    };
    this.wideViewport.addEventListener?.('change', onBreakpoint);
    this.teardown.push(() => this.wideViewport.removeEventListener?.('change', onBreakpoint));

    this.#on(el.panelToggle, 'click', () => this.#setDrawer(!this.#drawerOpen));
    this.#on(el.panelClose, 'click', () => this.#setDrawer(false));
    this.#on(el.scrim, 'click', () => this.#setDrawer(false));

    this.#setDrawer(false, false);
  }

  /** @returns {boolean} */
  get #drawerOpen() {
    return this.el.panel.classList.contains('is-open');
  }

  /** @returns {boolean} True when the open drawer should behave as a modal dialog. */
  get #drawerIsModal() {
    return !this.wideViewport?.matches;
  }

  /**
   * @param {boolean} open
   * @param {boolean} [moveFocus] False during initial setup, when nothing should be focused.
   */
  #setDrawer(open, moveFocus = true) {
    const { el } = this;
    const modal = open && this.#drawerIsModal;

    el.panel.classList.toggle('is-open', open);
    el.panel.setAttribute('aria-hidden', String(!open));
    el.panelToggle.setAttribute('aria-expanded', String(open));
    el.scrim.hidden = !modal;

    // Only claim to be a dialog when actually behaving like one. A non-modal panel announced
    // as `aria-modal` would tell a screen reader the rest of the page is unavailable when it
    // is fully available.
    if (modal) {
      el.panel.setAttribute('role', 'dialog');
      el.panel.setAttribute('aria-modal', 'true');
    } else {
      el.panel.removeAttribute('role');
      el.panel.removeAttribute('aria-modal');
    }

    // Focus containment. Without this, Tab walked straight out of the open modal drawer into
    // the HUD behind the scrim.
    this.#syncOutsideInert();

    // Move focus out first, then seal: setting `inert` while focus is still inside drops
    // it on the body instead of somewhere useful.
    if (moveFocus && !open) el.panelToggle.focus();
    // A closed drawer is only translated off-screen, so without `inert` its controls stay
    // in the tab order and in the accessibility tree while invisible.
    el.panel.inert = !open;
    // Only a modal drawer steals focus. On a wide viewport the panel is an inspector beside
    // the artwork, and yanking focus into it on open would be an interruption.
    if (moveFocus && modal) el.panelClose.focus();

    // The HUD notice and the in-drawer warning are two halves of one signal; opening the
    // drawer hands the message over from one to the other.
    this.#updateBudgetWarning();

    // An open drawer means deliberate interaction, so the idle timer stays parked.
    this.#wake();
  }

  /**
   * The shortcut sheet. Six keys were bound and documented nowhere in the UI.
   *
   * Always modal — it is a reference, not a tool, and there is nothing to preview behind it.
   */
  #bindShortcutSheet() {
    const { el } = this;
    this.#on(el.shortcutsButton, 'click', () => this.#setSheet(!this.#sheetOpen));
    this.#on(el.shortcutsClose, 'click', () => this.#setSheet(false));
    // Click-outside: the backdrop is the element itself, so only a hit on it (not on the
    // card inside) closes.
    this.#on(el.shortcuts, 'click', (event) => {
      if (event.target === el.shortcuts) this.#setSheet(false);
    });
  }

  /** @returns {boolean} */
  get #sheetOpen() {
    return !this.el.shortcuts.hidden;
  }

  /** @param {boolean} open */
  #setSheet(open) {
    const { el } = this;
    if (!open && this.#sheetOpen) el.shortcutsButton.focus();

    el.shortcuts.hidden = !open;
    el.shortcuts.inert = !open;
    el.shortcutsButton.setAttribute('aria-expanded', String(open));

    this.#syncOutsideInert();
    if (open) el.shortcutsClose.focus();
    this.#wake();
  }

  /**
   * Seal the canvas and HUD while a modal surface is up.
   *
   * Focus containment by `inert` rather than a manual Tab-cycling trap. Both the sheet and the
   * modal drawer need it, and they can be open at once, so the condition lives in one place —
   * two independent writers would race and leave the page permanently inert.
   */
  #syncOutsideInert() {
    const sealed = this.#sheetOpen || (this.#drawerOpen && this.#drawerIsModal);
    this.el.canvas.inert = sealed;
    this.el.hud.inert = sealed;
  }

  /**
   * Global keyboard shortcuts.
   *
   * Deliberately single keys with no modifiers, and suppressed whenever focus is in a form
   * control so they cannot fight with typing or with a button's own Space activation.
   */
  #bindKeyboard() {
    this.#on(document, 'keydown', (event) => {
      if (this.exporting) {
        if (event.key === 'Escape') this.recorder.cancel();
        return;
      }
      if (event.key === 'Escape') {
        if (this.#sheetOpen) {
          this.#setSheet(false);
          return;
        }
        if (this.#drawerOpen) {
          this.#setDrawer(false);
          return;
        }
      }

      // Undo is checked before the modifier guard below, because it is the one binding that
      // *is* a modifier chord. Still suppressed inside form controls so it cannot hijack the
      // browser's own undo while the user is editing the Fps field.
      const inField = event.target.closest?.('input, select, textarea');
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'z') {
        if (inField) return;
        event.preventDefault();
        this.#undo();
        return;
      }

      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.target.closest?.('input, select, textarea, button, a')) return;

      switch (event.key) {
        case ' ':
          event.preventDefault();
          if (this.running) this.stop();
          else this.start();
          break;
        case '2':
          this.viewToggle.select('2d');
          break;
        case '3':
          this.viewToggle.select('3d');
          break;
        case 'p':
        case 'P':
          this.#setDrawer(!this.#drawerOpen);
          break;
        case '?':
          event.preventDefault();
          this.#setSheet(!this.#sheetOpen);
          break;
        default:
          break;
      }
    });
  }

  /**
   * Keyboard camera control, so orbiting is not mouse-only.
   *
   * Bound to the canvas rather than the document because it is the canvas that is
   * focusable; the arrow keys only steal the viewport when the artwork itself has focus.
   */
  #bindCanvasKeys() {
    const STEP = 24;
    this.#on(this.el.canvas, 'keydown', (event) => {
      if (this.exporting) return;
      if (!this.projector.sortsByDepth) return;

      const moves = {
        ArrowLeft: [-STEP, 0],
        ArrowRight: [STEP, 0],
        ArrowUp: [0, -STEP],
        ArrowDown: [0, STEP],
      };
      const move = moves[event.key];
      if (move) {
        event.preventDefault();
        this.camera.orbitBy(move[0], move[1]);
      } else if (event.key === '+' || event.key === '=') {
        event.preventDefault();
        this.camera.zoomBy(1 / 1.12);
      } else if (event.key === '-' || event.key === '_') {
        event.preventDefault();
        this.camera.zoomBy(1.12);
      } else {
        return;
      }
      this.#renderOnce();
    });
  }

  /**
   * The HUD recedes to a low opacity once the pointer has been still for a while, so the
   * artwork is unobstructed by default. Any pointer, key or focus activity brings it back,
   * and it never recedes while the drawer is open or a control is focused.
   */
  #bindIdleFade() {
    const IDLE_AFTER = 2600;

    const wake = () => this.#wake();
    for (const type of ['pointermove', 'pointerdown', 'keydown', 'wheel', 'focusin']) {
      this.#on(window, type, wake, { passive: true });
    }

    this.idleTimer = null;
    this.wake = () => {
      // Idle state lives entirely in one class. The hint line reacts to it in CSS rather
      // than through a second JS flag, so the two can never disagree.
      document.body.classList.remove('is-idle');
      clearTimeout(this.idleTimer);
      if (this.el.panel.classList.contains('is-open')) return;
      this.idleTimer = setTimeout(() => document.body.classList.add('is-idle'), IDLE_AFTER);
    };
    this.teardown.push(() => clearTimeout(this.idleTimer));
    this.#wake();
  }

  #wake() {
    this.wake?.();
  }

  /** Keep the wordmark's subtitle in step with the geometry and projection in use. */
  #updateMeta() {
    const geometry = this.scene.geometry.label.toLowerCase();
    const projection = this.projector.sortsByDepth ? 'perspective' : 'orthographic';
    this.el.markMeta.textContent = `${geometry} · ${projection}`;
  }

  /**
   * Camera interaction. Pointer events are captured so a drag that leaves the canvas still
   * tracks, and only the 3D view responds — a top-down orthographic projection has no
   * camera to orbit.
   *
   * One pointer orbits; two pinch to zoom. Zoom used to be `wheel`-only, which meant that on
   * a phone or tablet — where the canvas also sets `touch-action: none` — it could not be
   * reached at all.
   */
  #bindPointer() {
    const { canvas } = this.el;
    /** Live pointers, so a second finger can be detected. @type {Map<number, {x: number, y: number}>} */
    const pointers = new Map();
    let lastX = 0;
    let lastY = 0;
    /** Pair distance on the previous move, or 0 when not pinching. */
    let pinchDistance = 0;

    /** @returns {number} Distance between the two live pointers. */
    const spread = () => {
      const [a, b] = [...pointers.values()];
      return Math.hypot(a.x - b.x, a.y - b.y);
    };

    /** Re-seat the orbit anchor on whichever single pointer is left. */
    const seatDrag = () => {
      const [only] = [...pointers.values()];
      if (only) {
        lastX = only.x;
        lastY = only.y;
      }
    };

    this.#on(canvas, 'pointerdown', (event) => {
      if (this.exporting) return;
      if (!this.projector.sortsByDepth) return;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      canvas.setPointerCapture(event.pointerId);

      if (pointers.size === 1) {
        lastX = event.clientX;
        lastY = event.clientY;
        canvas.classList.add('is-dragging');
      } else if (pointers.size === 2) {
        // Orbit is suppressed for the duration of the pinch, so the view does not lurch
        // while both fingers move.
        pinchDistance = spread();
        canvas.classList.remove('is-dragging');
      }
    });

    this.#on(canvas, 'pointermove', (event) => {
      if (this.exporting) {
        pointers.clear();
        pinchDistance = 0;
        canvas.classList.remove('is-dragging');
        return;
      }
      if (!pointers.has(event.pointerId)) return;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

      if (pointers.size >= 2) {
        const distance = spread();
        // `zoomBy` treats a factor above 1 as moving away, so pinching apart (a growing
        // distance) yields a factor below 1 and brings the camera closer.
        if (pinchDistance > 0 && distance > 0) this.camera.zoomBy(pinchDistance / distance);
        pinchDistance = distance;
      } else {
        this.camera.orbitBy(event.clientX - lastX, event.clientY - lastY);
        lastX = event.clientX;
        lastY = event.clientY;
      }
      this.#renderOnce();
    });

    const endPointer = (event) => {
      if (!pointers.delete(event.pointerId)) return;
      canvas.releasePointerCapture?.(event.pointerId);

      if (pointers.size < 2) pinchDistance = 0;
      if (pointers.size === 1) {
        // Dropping from a pinch back to one finger without re-seating would feed the leftover
        // anchor into `orbitBy` and snap the view.
        seatDrag();
        canvas.classList.add('is-dragging');
      } else if (pointers.size === 0) {
        canvas.classList.remove('is-dragging');
      }
    };
    this.#on(canvas, 'pointerup', endPointer);
    this.#on(canvas, 'pointercancel', endPointer);

    this.#on(
      canvas,
      'wheel',
      (event) => {
        if (this.exporting) return;
        if (!this.projector.sortsByDepth) return;
        event.preventDefault();
        this.camera.zoomBy(event.deltaY > 0 ? 1.08 : 1 / 1.08);
        this.#renderOnce();
      },
      { passive: false }
    );
  }

  // --- Actions ----------------------------------------------------------

  #saveSnapshot() {
    this.el.canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `orbital-canvas-${Date.now()}.png`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    }, 'image/png');
  }

  async #record() {
    if (this.exporting || this.destroyed) return;
    this.#syncExportLimits(this.controls.rangeMode);
    const fps = Number(this.el.fpsInput.value) || 60;
    const duration = Number(this.el.durationInput.value) || 6;
    const wasRunning = this.running;

    // Both exporters own the clock. Keep cancel visible while disabling scene changes.
    this.#setSheet(false);
    this.#setDrawer(false);
    const controls = [...this.el.canvas.ownerDocument.querySelectorAll('button, input, select')]
      .filter((element) => element !== this.el.recordButton)
      .map((element) => [element, element.disabled]);
    for (const [element] of controls) element.disabled = true;
    this.exporting = true;
    this.stop();
    if (this.renderRafId !== null) {
      cancelAnimationFrame(this.renderRafId);
      this.renderRafId = null;
    }

    try {
      const { filename, strategy } = await this.recorder.record({
        fps,
        duration,
        renderFrame: (dt) => this.advance(dt),
      });
      this.#setStatus(`Saved ${filename} (${strategy})`);
    } catch (error) {
      if (error.name === 'AbortError') this.#setStatus('Recording cancelled.');
      else {
        console.error('Recording failed', error);
        this.#setStatus(`Recording failed: ${error.message}`);
      }
    } finally {
      this.exporting = false;
      if (!this.destroyed) {
        for (const [element, disabled] of controls) element.disabled = disabled;
        if (wasRunning) this.start();
        else this.#renderOnce();
      }
    }
  }

  /**
   * @param {{recording: boolean, progress: number, note: string}} state
   */
  #onRecorderState({ recording, progress, note }) {
    if (this.destroyed) return;
    const { indicator, recordButton } = this.el;
    indicator.hidden = !recording;
    recordButton.dataset.state = recording ? 'recording' : 'idle';
    const label = recording ? 'Stop recording' : 'Record video';
    recordButton.setAttribute('aria-label', label);
    recordButton.setAttribute('title', label);
    if (recording) {
      indicator.textContent = `REC ${String(Math.round(progress * 100)).padStart(3, '0')}% · ${note}`;
    }
  }

  /**
   * Transient status message. Clears itself so a stale "Saved …" does not sit in the
   * corner for the rest of the session.
   *
   * @param {string} message
   */
  #setStatus(message) {
    if (this.destroyed) return;
    this.el.status.textContent = message;
    clearTimeout(this.statusTimer);
    if (message) this.statusTimer = setTimeout(() => this.#setStatus(''), 7000);
  }

  /** @param {boolean} playing */
  #setPlayState(playing) {
    const { playButton } = this.el;
    // Never assign `textContent` on an icon button: the pre-refactor code did, which
    // destroyed the child icon element on the very first click.
    playButton.dataset.state = playing ? 'playing' : 'paused';
    playButton.setAttribute('aria-label', playing ? 'Pause animation' : 'Play animation');
    playButton.setAttribute('title', playing ? 'Pause (Space)' : 'Play (Space)');
  }

  // --- Lifecycle --------------------------------------------------------

  /**
   * @param {EventTarget} target
   * @param {string} type
   * @param {EventListener} handler
   * @param {AddEventListenerOptions} [options]
   */
  #on(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    this.teardown.push(() => target.removeEventListener(type, handler, options));
  }

  /** Release every listener and observer this app owns. */
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stop();
    this.recorder.cancel();
    this.viewport.destroy();
    if (this.renderRafId !== null) cancelAnimationFrame(this.renderRafId);
    this.renderRafId = null;
    clearTimeout(this.statusTimer);
    clearTimeout(this.persistTimer);
    for (const off of this.teardown) off();
    this.teardown = [];
  }
}

/**
 * @param {Document} doc
 * @returns {Record<string, HTMLElement>}
 * @throws {Error} Listing every missing element at once, rather than failing on the first.
 */
function collectElements(doc) {
  const ids = {
    canvas: 'canvas',
    hud: 'hud',
    controls: 'controlsPanel',
    panel: 'panel',
    panelToggle: 'panelToggle',
    panelClose: 'panelClose',
    scrim: 'scrim',
    playButton: 'playButton',
    recordButton: 'recordButton',
    snapshotButton: 'snapshotButton',
    randomizeButton: 'randomizeButton',
    restartButton: 'restartButton',
    resetButton: 'resetButton',
    shareButton: 'shareButton',
    themeButton: 'themeButton',
    shortcutsButton: 'shortcutsButton',
    shortcutsClose: 'shortcutsClose',
    shortcuts: 'shortcuts',
    presetSelect: 'presetSelect',
    viewToggle: 'viewToggle',
    spawnToggle: 'spawnToggle',
    rangeToggle: 'rangeToggle',
    indicator: 'recordingIndicator',
    status: 'statusLine',
    hintLine: 'hintLine',
    markMeta: 'markMeta',
    budgetWarning: 'budgetWarning',
    budgetNotice: 'budgetNotice',
    fpsInput: 'fpsInput',
    durationInput: 'durationInput',
    year: 'year',
  };

  const found = {};
  const missing = [];
  for (const [name, id] of Object.entries(ids)) {
    const element = doc.getElementById(id);
    if (element) found[name] = element;
    else missing.push(id);
  }
  if (missing.length) throw new Error(`Missing required elements: #${missing.join(', #')}`);
  return found;
}

/**
 * Initial view mode: `?view=` wins, then the permalink hash, then the stored preference,
 * then 3D. The explicit query parameter stays on top because it is the documented override.
 *
 * @param {Document} doc
 * @param {import('./ui/permalink.js').Meta} [meta] Decoded from the hash or stored session.
 * @returns {'2d'|'3d'}
 */
function initialView(doc, meta = {}) {
  const fromUrl = new URL(doc.location.href).searchParams.get('view');
  if (fromUrl === '2d' || fromUrl === '3d') return fromUrl;
  if (meta.view === '2d' || meta.view === '3d') return meta.view;
  try {
    const stored = localStorage.getItem(VIEW_STORAGE_KEY);
    if (stored === '2d' || stored === '3d') return stored;
  } catch {
    // Fall through to the default.
  }
  return '3d';
}

const app = new App(document);

if (import.meta.hot) {
  import.meta.hot.dispose(() => app.destroy());
}

export { App };
