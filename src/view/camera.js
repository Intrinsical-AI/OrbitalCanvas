import { CAMERA_DEFAULTS } from '../core/config.js';

const FOCAL_LENGTH = 1400 / 380;
/** Dimensionless orbit camera; the authored zoom is independent of the surface. */
export class Camera {
  constructor(options = {}) {
    const pose = { ...CAMERA_DEFAULTS, ...options };
    this.yaw = pose.yaw;
    this.pitch = pose.pitch;
    this.zoom = pose.zoom;
    this.focalLength = FOCAL_LENGTH;
    this.cache = { yaw: NaN, pitch: NaN };
  }
  get distance() {
    return FOCAL_LENGTH / this.zoom;
  }
  pose(autoOrbit) {
    return { yaw: this.yaw, pitch: this.pitch, zoom: this.zoom, autoOrbit };
  }
  update(dt, orbiting) {
    if (orbiting) this.yaw = (this.yaw + dt * 0.12) % (2 * Math.PI);
  }
  orbitBy(dx, dy) {
    this.yaw += dx * 0.005;
    this.pitch = Math.min(
      (89 * Math.PI) / 180,
      Math.max((-89 * Math.PI) / 180, this.pitch + dy * 0.005)
    );
  }
  zoomBy(factor) {
    this.zoom = Math.min(3, Math.max(0.25, this.zoom / factor));
  }
  toCameraSpace(p, out) {
    const c = this.cache;
    if (c.yaw !== this.yaw || c.pitch !== this.pitch) {
      Object.assign(c, {
        yaw: this.yaw,
        pitch: this.pitch,
        yc: Math.cos(this.yaw),
        ys: Math.sin(this.yaw),
        pc: Math.cos(this.pitch),
        ps: Math.sin(this.pitch),
      });
    }
    const x = p.x * c.yc + p.y * c.ys;
    const y = -p.x * c.ys + p.y * c.yc;
    out.x = x;
    out.y = y * c.pc + p.z * c.ps;
    out.z = -y * c.ps + p.z * c.pc;
    return out;
  }
}
