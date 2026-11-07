/** History stores authored state, never the running simulation or raster trails. */
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
    const entry = this.pending;
    this.pending = null;
    if (JSON.stringify(entry.state) === JSON.stringify(state)) return false;
    this.past.push(entry);
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
    return true;
  }
  cancel() {
    const entry = this.pending;
    this.pending = null;
    return entry?.state;
  }
  undo(state) {
    this.commit(state);
    const entry = this.past.pop();
    if (!entry) return null;
    this.future.push({ state: structuredClone(state), label: entry.label });
    return structuredClone(entry);
  }
  redo(state) {
    const entry = this.future.pop();
    if (!entry) return null;
    this.past.push({ state: structuredClone(state), label: entry.label });
    return structuredClone(entry);
  }
}
