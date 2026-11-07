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
  expect(h.past[0].state).toEqual({ x: { y: 1 } });
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
  expect(h.cancel()).toEqual({ x: 1 });
  expect(h.past).toHaveLength(0);
});
