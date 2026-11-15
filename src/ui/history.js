const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function changesBetween(before, after, path = [], changes = []) {
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const beforeExists = Object.hasOwn(before, key),
      afterExists = Object.hasOwn(after, key),
      previous = before[key],
      next = after[key];
    if (beforeExists && afterExists && isRecord(previous) && isRecord(next)) {
      changesBetween(previous, next, [...path, key], changes);
    } else if (beforeExists !== afterExists || !Object.is(previous, next)) {
      changes.push({
        path: [...path, key],
        before: structuredClone(previous),
        after: structuredClone(next),
        beforeExists,
        afterExists,
      });
    }
  }
  return changes;
}

function mergeChanges(state, changes, direction) {
  const merged = structuredClone(state);
  for (const change of changes) {
    let target = merged;
    for (const key of change.path.slice(0, -1)) {
      if (!isRecord(target[key])) target[key] = {};
      target = target[key];
    }
    const key = change.path.at(-1);
    if (change[direction + 'Exists']) target[key] = structuredClone(change[direction]);
    else delete target[key];
  }
  return merged;
}

/** History stores changed document fields, never preferences, simulation or raster trails. */
export class History {
  constructor(limit = 50) {
    this.limit = limit;
    this.past = [];
    this.future = [];
    this.pending = null;
  }
  begin(state, label = 'edit') {
    if (!this.pending) this.pending = { state: structuredClone(state), label };
  }
  commit(state) {
    if (!this.pending) return false;
    const { state: before, label } = this.pending;
    this.pending = null;
    const changes = changesBetween(before, state);
    if (!changes.length) return false;
    this.past.push({ changes, label });
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
    return true;
  }
  cancel(state) {
    const entry = this.pending;
    this.pending = null;
    if (!entry) return null;
    const changes = changesBetween(entry.state, state);
    return {
      state: mergeChanges(state, changes, 'before'),
      label: entry.label,
      paths: changes.map(({ path }) => [...path]),
    };
  }
  undo(state) {
    this.commit(state);
    const entry = this.past.pop();
    if (!entry) return null;
    this.future.push(entry);
    return {
      state: mergeChanges(state, entry.changes, 'before'),
      label: entry.label,
      paths: entry.changes.map(({ path }) => [...path]),
    };
  }
  redo(state) {
    this.commit(state);
    const entry = this.future.pop();
    if (!entry) return null;
    this.past.push(entry);
    return {
      state: mergeChanges(state, entry.changes, 'after'),
      label: entry.label,
      paths: entry.changes.map(({ path }) => [...path]),
    };
  }
}
