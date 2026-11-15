const MOVES = {
  ArrowLeft: [-24, 0],
  ArrowRight: [24, 0],
  ArrowUp: [0, -24],
  ArrowDown: [0, 24],
};
const ZOOM_KEYS = ['+', '=', '-', '_'];

/** One authored edit per pointer, keyboard or wheel gesture. */
export class CameraInteraction {
  constructor(app) {
    this.app = app;
    this.canvas = app.el.canvas;
    this.pointers = new Map();
    this.keys = new Set();
    this.mode = null;
    this.wheelTimer = null;
    app.on(this.canvas, 'pointerdown', (event) => this.pointerdown(event));
    app.on(this.canvas, 'pointermove', (event) => this.pointermove(event));
    app.on(this.canvas, 'pointerup', (event) => this.pointerup(event));
    app.on(this.canvas, 'pointercancel', () => this.cancel());
    app.on(this.canvas, 'lostpointercapture', (event) => {
      if (this.pointers.has(event.pointerId)) this.cancel();
    });
    app.on(this.canvas, 'wheel', (event) => this.wheel(event), { passive: false });
    app.on(this.canvas, 'dblclick', () => app.recenter());
    app.on(this.canvas, 'blur', () => {
      if (this.mode === 'keyboard') this.finish();
    });
    app.on(app.doc, 'keyup', (event) => {
      this.keys.delete(event.code);
      if (this.mode === 'keyboard' && !this.keys.size) this.finish();
    });
    app.on(window, 'blur', () => this.finish());
  }
  get active() {
    return this.mode !== null;
  }
  begin(mode) {
    if (this.mode !== mode) {
      this.finish();
      this.app.commit();
      this.mode = mode;
    }
    this.app.begin('camera');
  }
  change(change) {
    // A previously focused control can commit on blur after pointerdown.
    this.app.begin('camera');
    change();
    this.app.editor.authorCamera();
    this.app.changed();
    this.app.draw(0, true);
  }
  distance() {
    const [a, b] = [...this.pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  }
  pointerdown(event) {
    if (this.app.document.view !== '3d' || this.pointers.size >= 2 || event.button !== 0) return;
    this.canvas.focus({ preventScroll: true });
    this.begin('pointer');
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    this.canvas.setPointerCapture(event.pointerId);
    this.anchor = { x: event.clientX, y: event.clientY };
    if (this.pointers.size === 2) this.spread = this.distance();
  }
  pointermove(event) {
    if (!this.pointers.has(event.pointerId)) return;
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    this.change(() => {
      if (this.pointers.size === 2) {
        const distance = this.distance();
        if (this.spread > 0 && distance > 0) this.app.camera.zoomBy(this.spread / distance);
        this.spread = distance;
      } else {
        this.app.camera.orbitBy(event.clientX - this.anchor.x, event.clientY - this.anchor.y);
        this.anchor = { x: event.clientX, y: event.clientY };
      }
    });
  }
  pointerup(event) {
    if (!this.pointers.delete(event.pointerId)) return;
    if (this.canvas.hasPointerCapture(event.pointerId))
      this.canvas.releasePointerCapture(event.pointerId);
    this.spread = 0;
    this.anchor = [...this.pointers.values()][0] ?? null;
    if (!this.pointers.size) this.finish();
  }
  keydown(event) {
    if (
      event.target !== this.canvas ||
      this.app.document.view !== '3d' ||
      (!MOVES[event.key] && !ZOOM_KEYS.includes(event.key))
    )
      return false;
    event.preventDefault();
    this.begin('keyboard');
    this.keys.add(event.code);
    this.change(() => {
      if (MOVES[event.key]) this.app.camera.orbitBy(...MOVES[event.key]);
      else this.app.camera.zoomBy(['+', '='].includes(event.key) ? 1 / 1.12 : 1.12);
    });
    return true;
  }
  wheel(event) {
    if (this.app.document.view !== '3d' || event.deltaY === 0) return;
    event.preventDefault();
    this.canvas.focus({ preventScroll: true });
    this.begin('wheel');
    this.change(() => this.app.camera.zoomBy(event.deltaY > 0 ? 1.08 : 1 / 1.08));
    clearTimeout(this.wheelTimer);
    this.wheelTimer = setTimeout(() => this.finish(), 250);
  }
  clear() {
    clearTimeout(this.wheelTimer);
    this.wheelTimer = null;
    const ids = [...this.pointers.keys()];
    this.pointers.clear();
    this.keys.clear();
    this.mode = null;
    for (const id of ids)
      if (this.canvas.hasPointerCapture(id)) this.canvas.releasePointerCapture(id);
  }
  finish() {
    if (!this.active) return;
    this.clear();
    this.app.commit();
  }
  cancel() {
    if (!this.active) return;
    this.clear();
    this.app.cancelEdit();
  }
  destroy() {
    this.finish();
  }
}
