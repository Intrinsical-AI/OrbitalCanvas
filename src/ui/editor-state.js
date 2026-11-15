import { Camera } from '../view/camera.js';
import { History } from './history.js';
import { validateDocument } from './permalink.js';

/** Authored document changes share one camera with the running renderer. */
export class EditorState {
  constructor(document) {
    this.document = validateDocument(document);
    this.camera = new Camera(this.document.camera);
    this.history = new History();
    this.authoredCamera = { ...this.document.camera };
  }
  liveDocument() {
    return validateDocument({
      ...this.document,
      camera: this.camera.pose(this.document.camera.autoOrbit),
    });
  }
  authorCamera() {
    this.document.camera = this.liveDocument().camera;
    this.authoredCamera = { ...this.document.camera };
  }
  begin(label = 'edit') {
    if (this.history.pending) return;
    this.authorCamera();
    this.history.begin(this.document, label);
  }
  commit() {
    return this.history.commit(this.document);
  }
  apply() {
    this.document = validateDocument(this.document);
    for (const key of ['yaw', 'pitch', 'zoom']) {
      if (this.document.camera[key] !== this.authoredCamera[key])
        this.camera[key] = this.document.camera[key];
    }
    this.authoredCamera = { ...this.document.camera };
    return this.document;
  }
  replace(document) {
    this.document = validateDocument(document);
    for (const key of ['yaw', 'pitch', 'zoom']) this.camera[key] = this.document.camera[key];
    this.authoredCamera = { ...this.document.camera };
  }
  action(label, change) {
    this.commit();
    this.begin(label);
    change(this.document);
    this.apply();
    this.commit();
  }
  restore(entry) {
    if (entry) {
      this.document = entry.state;
      this.apply();
      // A historical target can equal the authored baseline while the live camera has moved.
      for (const path of entry.paths) {
        if (path.length === 2 && path[0] === 'camera' && ['yaw', 'pitch', 'zoom'].includes(path[1]))
          this.camera[path[1]] = this.document.camera[path[1]];
      }
    }
    return entry;
  }
  cancel() {
    return this.restore(this.history.cancel(this.document));
  }
  undo() {
    return this.restore(this.history.undo(this.document));
  }
  redo() {
    return this.restore(this.history.redo(this.document));
  }
}
