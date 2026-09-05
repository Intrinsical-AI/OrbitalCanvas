const STORAGE_KEY = 'orbital-canvas:theme';

/**
 * Per-theme canvas colours. The canvas cannot read CSS custom properties directly, so the
 * values are mirrored here and keyed by the same theme id.
 *
 * Pure black and pure white: the shell is strictly monochrome, and the canvas bleeds to
 * every edge of the viewport, so its background *is* the page background.
 *
 * `foreground` draws the chords when chromatic mode is off.
 */
const CANVAS_COLORS = {
  dark: { background: '#000000', foreground: '#ffffff' },
  light: { background: '#ffffff', foreground: '#000000' },
};

/**
 * Light/dark theme controller.
 *
 * Pre-refactor this was three disconnected pieces of dead code: a `#toggleTheme` button
 * with no listener, a `:root[data-theme="light"]` block that could never match, and an
 * `Animation.toggleMode()` only ever called from comments. They are now one thing, and the
 * canvas trail colour follows the document theme.
 */
export class Theme {
  /**
   * @param {(theme: string) => void} [onChange]
   */
  constructor(onChange) {
    this.onChange = onChange;
    this.current = Theme.#initial();
    this.#apply();
  }

  /** @returns {'dark'|'light'} Stored preference, else the OS preference, else dark. */
  static #initial() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === 'dark' || stored === 'light') return stored;
    } catch {
      // Storage can be unavailable (private mode, blocked cookies); fall through.
    }
    return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }

  #apply() {
    document.documentElement.dataset.theme = this.current;
    try {
      localStorage.setItem(STORAGE_KEY, this.current);
    } catch {
      // Persisting is best-effort; the theme still applies for this session.
    }
    this.onChange?.(this.current);
  }

  toggle() {
    this.current = this.current === 'dark' ? 'light' : 'dark';
    this.#apply();
  }

  /**
   * @returns {{background: string, foreground: string}} Canvas colours for the active theme.
   */
  colors() {
    return CANVAS_COLORS[this.current];
  }
}
