import { expect, it } from 'vitest';
import { History } from '../src/ui/history.js';
it('groups a drag, restores initial values and supports redo', () => {
  const h = new History();
  let value = { x: 1 };
  h.begin(value, 'drag');
  value.x = 2;
  h.begin(value, 'drag');
  value.x = 3;
  h.commit(value);
  expect(h.past).toHaveLength(1);
  const undone = h.undo(value);
  expect(undone.state).toEqual({ x: 1 });
  expect(h.redo(undone.state).state).toEqual({ x: 3 });
});
it('a new edit discards redo and snapshots are independent', () => {
  const h = new History(),
    state = { x: { y: 1 } };
  h.begin(state);
  state.x.y = 2;
  h.commit(state);
  h.undo(state);
  h.begin({ x: { y: 1 } });
  h.commit({ x: { y: 5 } });
  expect(h.future).toHaveLength(0);
  expect(h.undo({ x: { y: 5 } }).state).toEqual({ x: { y: 1 } });
});
it('bounds history and drops no-op transactions', () => {
  const h = new History(2);
  h.begin({ x: 1 });
  expect(h.commit({ x: 1 })).toBe(false);
  for (let x = 0; x < 4; x++) {
    h.begin({ x });
    h.commit({ x: x + 1 });
  }
  expect(h.past).toHaveLength(2);
  expect(h.undo({ x: 4 }).state.x).toBe(3);
  expect(h.undo({ x: 3 }).state.x).toBe(2);
  expect(h.undo({ x: 2 })).toBeNull();
});
it('cancel returns the initial state without retaining an operation', () => {
  const h = new History();
  h.begin({ x: 1 });
  expect(h.cancel({ x: 2 })).toEqual({ state: { x: 1 }, label: 'edit', paths: [['x']] });
  expect(h.past).toHaveLength(0);
});

it('undo and redo change only the edited document fields', () => {
  const h = new History();
  const before = { parameters: { size: 3, speed: 0.5 }, camera: { yaw: 1, zoom: 1 } };
  h.begin(before, 'size');
  h.commit({ ...before, parameters: { ...before.parameters, size: 5 } });
  const current = {
    parameters: { size: 5, speed: 2 },
    camera: { yaw: 2, zoom: 1.5 },
  };
  const undone = h.undo(current);
  expect(undone).toEqual({
    state: { ...current, parameters: { size: 3, speed: 2 } },
    label: 'size',
    paths: [['parameters', 'size']],
  });
  expect(h.redo(undone.state).state).toEqual(current);
  expect(current.parameters.size).toBe(5);
});

it('commits an active edit before redo and discards the abandoned future', () => {
  const h = new History();
  h.begin({ x: 0 });
  h.commit({ x: 1 });
  h.undo({ x: 1 });
  h.begin({ x: 0 });
  expect(h.redo({ x: 2 })).toBeNull();
  expect(h.pending).toBeNull();
  expect(h.future).toHaveLength(0);
  expect(h.undo({ x: 2 }).state).toEqual({ x: 0 });
  expect(h.redo({ x: 0 }).state).toEqual({ x: 2 });
});

it('a pending no-op does not prevent redo', () => {
  const h = new History();
  h.begin({ x: 0 });
  h.commit({ x: 1 });
  h.undo({ x: 1 });
  h.begin({ x: 0 });
  expect(h.redo({ x: 0 }).state).toEqual({ x: 1 });
  expect(h.pending).toBeNull();
});

it('cancel preserves the redo stack and snapshots remain independent', () => {
  const h = new History();
  h.begin({ parameters: { size: 3 } });
  h.commit({ parameters: { size: 5 } });
  h.undo({ parameters: { size: 5 } });
  const before = { parameters: { size: 3 } };
  h.begin(before, 'drag');
  before.parameters.size = 99;
  const cancelled = h.cancel({ parameters: { size: 4 } });
  expect(cancelled).toEqual({
    state: { parameters: { size: 3 } },
    label: 'drag',
    paths: [['parameters', 'size']],
  });
  expect(h.redo(cancelled.state).state.parameters.size).toBe(5);
  expect(h.cancel(cancelled.state)).toBeNull();
});

it('exposes independent changed paths for undo, redo and cancellation', () => {
  const h = new History();
  const before = { camera: { yaw: 0, pitch: 0.2 }, parameters: { size: 3 } };
  const after = { camera: { yaw: 0.5, pitch: 0.2 }, parameters: { size: 5 } };
  h.begin(before, 'orbit and size');
  h.commit(after);
  const undone = h.undo(after);
  expect(undone.paths).toEqual([
    ['camera', 'yaw'],
    ['parameters', 'size'],
  ]);
  undone.paths[0][1] = 'pitch';
  const redone = h.redo(undone.state);
  expect(redone.paths).toEqual([
    ['camera', 'yaw'],
    ['parameters', 'size'],
  ]);
  expect(redone.state).toEqual(after);
  h.begin(after, 'pitch');
  const cancelled = h.cancel({ ...after, camera: { ...after.camera, pitch: 0.4 } });
  expect(cancelled.paths).toEqual([['camera', 'pitch']]);
  expect(cancelled.state).toEqual(after);
});
