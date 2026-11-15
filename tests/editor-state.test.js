import { expect, it } from 'vitest';
import { CAMERA_DEFAULTS } from '../src/core/config.js';
import { EditorState } from '../src/ui/editor-state.js';
import { defaultDocument } from '../src/ui/permalink.js';

it('turns auto-orbit off at the live pose and keeps the same camera', () => {
  const editor = new EditorState(defaultDocument());
  const camera = editor.camera;
  camera.update(10, true);
  const yaw = camera.yaw;
  editor.action('camera motion', (doc) => {
    doc.camera.autoOrbit = false;
  });
  expect(editor.camera).toBe(camera);
  expect(editor.camera.yaw).toBeCloseTo(yaw, 12);
  expect(editor.document.camera.autoOrbit).toBe(false);
  editor.undo();
  expect(editor.camera.yaw).toBeCloseTo(yaw, 12);
  expect(editor.document.camera.autoOrbit).toBe(true);
});

it('undo and redo of parameter edits preserve the live camera after automatic motion', () => {
  const editor = new EditorState(defaultDocument());
  editor.action('size', (doc) => {
    doc.parameters.size = 5;
  });
  editor.camera.update(10, true);
  const yaw = editor.camera.yaw;
  editor.undo();
  expect(editor.document.parameters.size).toBe(3);
  expect(editor.camera.yaw).toBeCloseTo(yaw, 12);
  editor.redo();
  expect(editor.document.parameters.size).toBe(5);
  expect(editor.camera.yaw).toBeCloseTo(yaw, 12);
});

it('undoes a manual orbit to the pose at the beginning of the gesture', () => {
  const editor = new EditorState(defaultDocument());
  editor.camera.update(10, true);
  const before = editor.camera.yaw;
  editor.begin('orbit');
  editor.camera.orbitBy(20, 10);
  editor.authorCamera();
  const after = editor.camera.pose(true);
  editor.commit();
  editor.camera.update(5, true);
  editor.undo();
  expect(editor.camera.yaw).toBeCloseTo(before, 12);
  expect(editor.camera.pitch).toBeCloseTo(CAMERA_DEFAULTS.pitch, 12);
  editor.redo();
  expect(editor.camera.pose(true)).toEqual(after);
});

it('zoom history leaves later automatic rotation untouched', () => {
  const editor = new EditorState(defaultDocument());
  editor.begin('zoom');
  editor.camera.zoomBy(1.5);
  editor.authorCamera();
  editor.commit();
  editor.camera.update(10, true);
  const yaw = editor.camera.yaw;
  editor.undo();
  expect(editor.camera.zoom).toBe(1);
  expect(editor.camera.yaw).toBeCloseTo(yaw, 12);
  editor.redo();
  expect(editor.camera.zoom).toBeCloseTo(1 / 1.5, 12);
  expect(editor.camera.yaw).toBeCloseTo(yaw, 12);
});

it('a pending gesture keeps one initial pose and cancellation restores its changed fields', () => {
  const editor = new EditorState(defaultDocument());
  editor.begin('orbit');
  editor.camera.orbitBy(20, 10);
  editor.authorCamera();
  editor.begin('orbit');
  editor.camera.orbitBy(20, 10);
  editor.authorCamera();
  expect(editor.cancel()?.label).toBe('orbit');
  expect(editor.camera.pose(true)).toEqual({ ...CAMERA_DEFAULTS });
  expect(editor.history.past).toHaveLength(0);
});

it('commit excludes automatic movement that happens during a parameter gesture', () => {
  const editor = new EditorState(defaultDocument());
  editor.begin('size');
  editor.document.parameters.size = 5;
  editor.apply();
  editor.camera.update(10, true);
  editor.commit();
  const yaw = editor.camera.yaw;
  editor.undo();
  expect(editor.document.parameters.size).toBe(3);
  expect(editor.camera.yaw).toBeCloseTo(yaw, 12);
});

it('replace forces the requested pose on the existing camera and supports undo', () => {
  const editor = new EditorState(defaultDocument());
  const camera = editor.camera;
  camera.update(10, true);
  const yaw = camera.yaw;
  editor.action('restore defaults', () => editor.replace(defaultDocument()));
  expect(editor.camera).toBe(camera);
  expect(editor.camera.pose(true)).toEqual({ ...CAMERA_DEFAULTS });
  editor.undo();
  expect(editor.camera.yaw).toBeCloseTo(yaw, 12);
});

it('live snapshots normalize the current pose without mutating the document or camera', () => {
  const editor = new EditorState(defaultDocument());
  editor.camera.yaw = 4;
  const live = editor.liveDocument();
  expect(live.camera.yaw).toBeCloseTo(4 - Math.PI * 2, 12);
  expect(editor.camera.yaw).toBe(4);
  expect(editor.document.camera.yaw).toBe(CAMERA_DEFAULTS.yaw);
  live.parameters.size = 7;
  expect(editor.document.parameters.size).toBe(3);
});
