import { afterEach, expect, it, vi } from 'vitest';
import { CameraInteraction } from '../src/ui/camera-interaction.js';
import { EditorState } from '../src/ui/editor-state.js';
import { defaultDocument } from '../src/ui/permalink.js';

function emit(target, type, fields = {}) {
  const event = new Event(type, { cancelable: true });
  Object.assign(event, fields);
  target.dispatchEvent(event);
  return event;
}

class Canvas extends EventTarget {
  captures = new Set();
  focus() {}
  setPointerCapture(id) {
    this.captures.add(id);
  }
  hasPointerCapture(id) {
    return this.captures.has(id);
  }
  releasePointerCapture(id) {
    if (this.captures.delete(id)) emit(this, 'lostpointercapture', { pointerId: id });
  }
}

function setup() {
  vi.stubGlobal('window', new EventTarget());
  const editor = new EditorState(defaultDocument());
  const canvas = new Canvas();
  const persist = vi.fn();
  const listeners = [];
  const app = {
    editor,
    doc: new EventTarget(),
    el: { canvas },
    dirty: false,
    get document() {
      return editor.document;
    },
    get camera() {
      return editor.camera;
    },
    on(target, type, handler, options) {
      listeners.push({ target, type, handler });
      target.addEventListener(type, handler, options);
    },
    begin: vi.fn((label) => editor.begin(label)),
    commit: vi.fn(() => {
      const changed = editor.commit();
      if (changed || app.dirty) {
        persist(editor.liveDocument());
        app.dirty = false;
      }
      return changed;
    }),
    cancelEdit: vi.fn(() => editor.cancel()),
    changed: vi.fn(() => {
      app.dirty = true;
    }),
    draw: vi.fn(),
    recenter: vi.fn(),
  };
  const interaction = new CameraInteraction(app);
  const pointer = (type, pointerId, x = 0, y = 0) =>
    emit(canvas, type, { pointerId, button: 0, clientX: x, clientY: y });
  const keydown = (key, code = key, repeat = false) =>
    interaction.keydown({ key, code, repeat, target: canvas, preventDefault: vi.fn() });
  const keyup = (key, code = key) => emit(app.doc, 'keyup', { key, code });
  return { app, editor, canvas, interaction, persist, listeners, pointer, keydown, keyup };
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('groups a wheel burst until 250 ms of inactivity and persists only at the end', () => {
  vi.useFakeTimers();
  const { app, editor, canvas, interaction, persist } = setup();
  for (let i = 0; i < 3; i++) {
    const event = emit(canvas, 'wheel', { deltaY: 40 });
    expect(event.defaultPrevented).toBe(true);
    if (i < 2) vi.advanceTimersByTime(100);
  }
  expect(interaction.active).toBe(true);
  expect(editor.history.past).toHaveLength(0);
  expect(persist).not.toHaveBeenCalled();
  expect(app.changed).toHaveBeenCalledTimes(3);
  expect(app.draw).toHaveBeenCalledTimes(3);
  vi.advanceTimersByTime(249);
  expect(persist).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(interaction.active).toBe(false);
  expect(editor.history.past).toHaveLength(1);
  expect(persist).toHaveBeenCalledTimes(1);
  editor.undo();
  expect(editor.camera.zoom).toBe(1);
});

it('groups repeated keyboard movement until every held camera key is released', () => {
  const { editor, interaction, persist, keydown, keyup } = setup();
  const before = editor.camera.pose(true);
  expect(keydown('ArrowRight')).toBe(true);
  keydown('ArrowRight', 'ArrowRight', true);
  keydown('ArrowUp');
  keyup('ArrowRight');
  expect(interaction.active).toBe(true);
  expect(persist).not.toHaveBeenCalled();
  keyup('Shift', 'ShiftLeft');
  expect(interaction.active).toBe(true);
  keyup('ArrowUp');
  expect(interaction.active).toBe(false);
  expect(editor.history.past).toHaveLength(1);
  expect(persist).toHaveBeenCalledTimes(1);
  editor.undo();
  expect(editor.camera.pose(true)).toEqual(before);
});

it('ends shifted zoom when the physical key is released after Shift', () => {
  const { editor, interaction, persist, keydown, keyup } = setup();
  keydown('+', 'Equal');
  keyup('Shift', 'ShiftLeft');
  expect(interaction.active).toBe(true);
  keyup('=', 'Equal');
  expect(interaction.active).toBe(false);
  expect(editor.history.pending).toBeNull();
  expect(editor.history.past).toHaveLength(1);
  expect(persist).toHaveBeenCalledTimes(1);
});

it('pointer cancellation restores the live gesture start without adding history', () => {
  const { app, editor, canvas, interaction, pointer } = setup();
  editor.camera.update(10, true);
  const before = editor.camera.pose(true);
  pointer('pointerdown', 1, 20, 30);
  pointer('pointermove', 1, 60, 90);
  expect(editor.camera.yaw).not.toBe(before.yaw);
  pointer('pointercancel', 1);
  expect(editor.camera.pose(true)).toEqual(before);
  expect(editor.history.pending).toBeNull();
  expect(editor.history.past).toHaveLength(0);
  expect(interaction.active).toBe(false);
  expect(canvas.captures.size).toBe(0);
  expect(app.cancelEdit).toHaveBeenCalledTimes(1);
});

it('continues a pinch as an orbit from the remaining pointer without a jump', () => {
  const { app, editor, canvas, interaction, persist, pointer } = setup();
  const before = editor.camera.pose(true);
  pointer('pointerdown', 1, 0, 0);
  pointer('pointerdown', 2, 100, 0);
  pointer('pointermove', 2, 200, 0);
  expect(editor.camera.zoom).toBe(2);
  expect(editor.camera.yaw).toBe(before.yaw);
  pointer('pointerup', 2, 200, 0);
  expect(interaction.active).toBe(true);
  expect(persist).not.toHaveBeenCalled();
  pointer('pointermove', 1, 10, 20);
  expect(editor.camera.yaw).toBeCloseTo(before.yaw + 0.05, 12);
  expect(editor.camera.pitch).toBeCloseTo(before.pitch + 0.1, 12);
  expect(editor.camera.zoom).toBe(2);
  pointer('pointerup', 1, 10, 20);
  expect(editor.history.past).toHaveLength(1);
  expect(persist).toHaveBeenCalledTimes(1);
  expect(canvas.captures.size).toBe(0);
  expect(app.cancelEdit).not.toHaveBeenCalled();
});

it('finishes the camera edit and releases captures before a separate action begins', () => {
  const { app, editor, canvas, interaction, persist, pointer } = setup();
  pointer('pointerdown', 1, 0, 0);
  pointer('pointermove', 1, 20, 30);
  pointer('pointerdown', 2, 100, 0);
  const pose = editor.camera.pose(true);
  interaction.finish();
  expect(canvas.captures.size).toBe(0);
  expect(interaction.active).toBe(false);
  expect(app.cancelEdit).not.toHaveBeenCalled();
  expect(persist).toHaveBeenCalledTimes(1);
  app.begin('size');
  editor.document.parameters.size = 5;
  editor.apply();
  app.changed();
  app.commit();
  pointer('pointermove', 1, 500, 500);
  pointer('pointerup', 1);
  interaction.finish();
  expect(editor.camera.pose(true)).toEqual(pose);
  expect(editor.history.past).toHaveLength(2);
  expect(persist).toHaveBeenCalledTimes(2);
  editor.undo();
  expect(editor.document.parameters.size).toBe(3);
  expect(editor.camera.pose(true)).toEqual(pose);
  editor.undo();
  expect(editor.camera.pose(true)).toEqual(defaultDocument().camera);
});

it('canvas blur commits a keyboard gesture once even when keyup arrives later', () => {
  const { app, editor, canvas, interaction, persist, keydown, keyup } = setup();
  keydown('ArrowRight');
  emit(canvas, 'blur');
  expect(interaction.active).toBe(false);
  expect(editor.history.past).toHaveLength(1);
  expect(persist).toHaveBeenCalledTimes(1);
  keyup('ArrowRight');
  expect(persist).toHaveBeenCalledTimes(1);
  expect(app.cancelEdit).not.toHaveBeenCalled();
});

it('window blur commits a pointer gesture and releases its capture', () => {
  const { editor, canvas, interaction, persist, pointer } = setup();
  pointer('pointerdown', 1, 10, 20);
  pointer('pointermove', 1, 30, 40);
  emit(globalThis.window, 'blur');
  expect(interaction.active).toBe(false);
  expect(canvas.captures.size).toBe(0);
  expect(editor.history.past).toHaveLength(1);
  expect(persist).toHaveBeenCalledTimes(1);
});

it('unexpected loss of pointer capture cancels the gesture without retaining its edit', () => {
  const { app, editor, canvas, interaction, pointer } = setup();
  const before = editor.camera.pose(true);
  pointer('pointerdown', 1, 10, 20);
  pointer('pointermove', 1, 30, 40);
  canvas.releasePointerCapture(1);
  expect(interaction.active).toBe(false);
  expect(editor.camera.pose(true)).toEqual(before);
  expect(editor.history.past).toHaveLength(0);
  expect(app.cancelEdit).toHaveBeenCalledTimes(1);
});

it('switching from wheel to pointer closes the first edit and cancels its idle timer', () => {
  vi.useFakeTimers();
  const { editor, canvas, interaction, persist, pointer } = setup();
  emit(canvas, 'wheel', { deltaY: 40 });
  pointer('pointerdown', 1, 10, 20);
  expect(editor.history.past).toHaveLength(1);
  expect(persist).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(1000);
  expect(interaction.active).toBe(true);
  expect(persist).toHaveBeenCalledTimes(1);
  pointer('pointermove', 1, 30, 40);
  pointer('pointerup', 1);
  expect(editor.history.past).toHaveLength(2);
  expect(persist).toHaveBeenCalledTimes(2);
});

it.each(['pointer', 'wheel'])(
  'commits a numeric field on focus before starting the first %s gesture',
  (mode) => {
    vi.useFakeTimers();
    const { app, editor, canvas, interaction, persist, pointer } = setup();
    const before = editor.camera.pose(true);
    const focus = vi.spyOn(canvas, 'focus').mockImplementationOnce(() => {
      // The previous number field's blur runs App.changeParameter before canvas interaction.
      interaction.finish();
      app.commit();
      app.begin('change size');
      editor.document.parameters.size = 5;
      editor.apply();
      app.changed();
      app.commit();
    });
    if (mode === 'pointer') {
      pointer('pointerdown', 1, 10, 20);
      expect(canvas.hasPointerCapture(1)).toBe(true);
      pointer('pointermove', 1, 30, 40);
    } else emit(canvas, 'wheel', { deltaY: 40 });
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(interaction.active).toBe(true);
    expect(editor.document.parameters.size).toBe(5);
    expect(editor.history.past).toHaveLength(1);
    expect(persist).toHaveBeenCalledTimes(1);
    if (mode === 'pointer') {
      expect(editor.camera.yaw).toBeCloseTo(before.yaw + 0.1, 12);
      pointer('pointerup', 1, 30, 40);
    } else {
      expect(editor.camera.zoom).toBeLessThan(before.zoom);
      vi.advanceTimersByTime(250);
    }
    expect(interaction.active).toBe(false);
    expect(editor.history.past).toHaveLength(2);
    expect(persist).toHaveBeenCalledTimes(2);
    editor.undo();
    expect(editor.camera.pose(true)).toEqual(before);
    expect(editor.document.parameters.size).toBe(5);
    editor.undo();
    expect(editor.document.parameters.size).toBe(3);
  }
);
