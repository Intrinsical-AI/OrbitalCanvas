# Orbital Canvas

Generative particle animation on a **genuinely three-dimensional** orbital scene, rendered to
a plain HTML canvas. One simulation, two projections:

| Mode               | What it is                                                                                                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **3D** _(default)_ | Perspective projection through an orbit camera. Drag to orbit, scroll to zoom. Depth sorting and depth-modulated alpha.                                                                     |
| **2D**             | Orthographic projection looking straight down the Z axis onto the XY plane. `z` is dropped outright: uniform size, uniform alpha, no sorting. Tilted rings appear as clean nested ellipses. |

Switching modes swaps a projector, nothing else. The scene, its rotation phases and the
camera are untouched, so the transition is continuous and the two views cannot drift apart.

![Interface](resources/interface.png)

Inspired by [Geometría Aurea](https://instagram.com/geometria_aurea/).

## Quick start

```bash
npm ci
npm run dev      # http://localhost:5173
```

| Script            | Purpose                        |
| ----------------- | ------------------------------ |
| `npm run dev`     | Vite dev server with HMR       |
| `npm run build`   | Production bundle into `dist/` |
| `npm run preview` | Serve the built bundle         |
| `npm test`        | Unit tests (vitest)            |
| `npm run lint`    | ESLint                         |
| `npm run format`  | Prettier                       |

The demo needs a build step now; `python3 -m http.server` no longer serves the sources
directly. After `npm run build` you can serve `dist/` with any static server.

Build installs must include development dependencies. `npm ci` runs a version guard and
`patch-package --error-on-fail` to apply the tracked Mediabunny **1.51.0** cleanup patch.
Do not skip install scripts. Changing this exact pin requires reviewing the patch and
rerunning the real dependency and browser regressions below. Published `dist/` contains
the patched exporter and needs no package installation on the static host.

## Interface

The artwork bleeds to all four edges and the chrome floats above it, receding to 16% opacity
after ~2.6 s of inactivity so the piece is unobstructed by default. Any pointer, key or
keyboard-focus event brings it back, and it never recedes while the parameter drawer is open.

The shell is strictly monochrome — black, white, and greys derived from them, with no hue
anywhere. Active state is shown by **inversion**, never by an accent colour. The canvas is
the only surface allowed colour, and only by the user's choice.

- **3D / 2D** — projection mode. Persisted in `localStorage`; override with `?view=2d`.
- **Ring lifecycle**
  - _Generative_ (default) — rings spawn on an interval with a decrementing radius; once the
    ring budget is reached the oldest fades out. Bounded, steady-state frame rate.
  - _Static_ — a fixed set of rings spread evenly across the radius range, built up front.
    Fully deterministic; use it for reproducible exports and snapshot comparisons.
- **Drag** the canvas to orbit the camera, **scroll** to zoom. Both apply to the 3D view only.
- **Parameter range** — _Safe_ is the default fluent profile and keeps the maximum scene below
  the 4,000-particle budget. _Experimental_ opens wider creative ranges and may reduce frame
  rate; switching back to Safe clamps values to its limits.
- Play/pause, PNG snapshot, randomise, restart the current configuration, restore all defaults,
  and video export.
- <kbd>Esc</kbd> closes the parameter drawer.

Two controls exist specifically because monochrome has only luminance to work with:
**chord opacity** (default 0.14 — hundreds of crossing chords at the old hardcoded 0.5 sum
to a solid mass without hue to separate them) and **chromatic chords**, which restores the
original rotating-hue chord cycle.

The default particle colour tracks the theme — white on black, black on white — until you
pick a colour of your own, which is then never overwritten. Restore defaults returns to theme
tracking; restarting the current configuration preserves the chosen colour.

Typography is self-hosted Inter Tight and JetBrains Mono, latin subset only (~85 kB of
woff2, bundled locally). No CDN and no third-party request at any point.

## Video export

Export uses [Mediabunny](https://mediabunny.dev) over the **WebCodecs** API. The exporter
owns the clock during a WebCodecs recording and steps the scene by exactly `1/fps` per frame, so the
output contains precisely `duration × fps` frames regardless of render speed, and encoding
runs faster than real time.

Verify frame-exactness on any clip:

```bash
ffprobe -v error -count_frames -select_streams v:0 \
  -show_entries stream=nb_read_frames,r_frame_rate -of default=nw=1 orbital-canvas-*.mp4
# nb_read_frames must equal duration × fps
```

Codec preference is `avc → av1 → vp9 → vp8`, muxed into MP4 or WebM accordingly. Browsers
without `VideoEncoder` or a usable codec fall back to `MediaRecorder` + `captureStream`.
That fallback also advances the scene itself, using elapsed real time; it may drop frames
under load and does not promise an exact frame count. Convert afterwards with ffmpeg as needed:

```bash
ffmpeg -i orbital-canvas-*.mp4 -c:v libx264 -pix_fmt yuv420p out.mp4
ffmpeg -i orbital-canvas-*.mp4 -vf "fps=24,scale=720:-1" out.gif
```

The recording is captured at the canvas's current on-screen resolution, so size the window
before exporting. Resizing cancels the recording. Scene controls, camera gestures and
playback shortcuts are locked during export; the record button and Escape still cancel.
After success, cancellation or failure, controls and the prior playing/paused state are
restored. Capture tracks and animation callbacks are released on failure too. Destroying
the app cancels its export without restarting the animation.

The tracked patch covers the TypeScript source and the ESM module used by this app.
When finalization fails, it directly attempts forced source cleanup before propagating
the original error. If cleanup also fails, its error is logged separately and the source
is not marked closed. This guarantee concerns our `BufferTarget` path; it does not extend
to arbitrary file/stream targets or cancellation throughout Mediabunny's finalizing state.

## Architecture

```
src/
  core/            pure simulation — no DOM, no canvas, no performance.now()
    config.js        DEFAULTS + control schema + display/internal unit conversion
    vec3.js          vector maths
    ring.js          one orbital circle: radius, tilt, yaw, direction, phase
    spawner.js       generative | static ring lifecycle policies
    scene.js         owns the rings; step(dt) integrates rotation phase
    geometry/        where a particle is in space, given a ring and an index
  view/            everything that touches a 2D context
    camera.js        orbit camera (yaw, pitch, distance)
    projectors.js    PerspectiveProjector | TopOrthoProjector
    renderer.js      background/trails, particles, batched chords
    shapes.js        disc | icosahedron particle shapes
    viewport.js      DPR-aware sizing via ResizeObserver
  ui/              DOM wiring
    controls.js      spec-driven control panel and segmented controls
    theme.js         data-theme, persistence, canvas colours
    recorder.js      strategy selection and the MediaRecorder fallback
    webcodecs-export.js  Mediabunny encoder, dynamically imported
  styles.css       the entire design system
  main.js          composition root, frame loop, HUD behaviour
```

Two invariants hold the design together:

1. **Time enters only as `dt`.** Ring rotation is an integrated phase, never a function of
   absolute time. Changing the speed changes a derivative, so it can never teleport a
   particle.
2. **The core is projection-agnostic.** The renderer asks a projector where a particle lands
   and never inspects the view mode; perspective, depth sorting and depth alpha all fall out
   of what the projector returns.

### Extending to non-Euclidean geometry

`core/geometry/` is a registry behind the interface
`{ id, label, curvature, circumference(r), orbitPoint(ring, index, count) }`. Euclidean is
the only implementation today.

The generalisation is that a particle traverses a **geodesic circle of radius r** on a
manifold, and a **model map** takes that manifold to R². Under the κ-stereographic model a
single curvature parameter unifies the constant-curvature cases through the circumference
law `2π · s_κ(r)`:

```
s_κ(r) = sin(√κ·r)/√κ     κ > 0   spherical
         r                 κ = 0   Euclidean  (implemented)
         sinh(√−κ·r)/√−κ   κ < 0   hyperbolic
```

Conveniently, looking straight down the Z axis at a sphere **is** the azimuthal orthographic
projection, so the existing `TopOrthoProjector` is already the correct model map for both
κ = 0 and κ > 0. Only hyperbolic needs its own map (Poincaré disk), where circumference grows
like `sinh(r)` — the exponential crowding that makes hyperbolic space interesting for
embeddings.

Adding a geometry means one new file and one registry entry; nothing else changes.

## Testing

```bash
npm test
```

Unit tests cover vector maths, geometry, projection, scene stepping, spawn policies,
config unit conversion, renderer draw calls and video-export failure paths. Notable properties asserted:

- `TopOrthoProjector` maps two points differing only in `z` to the **same pixel** — the
  defining property of the top-down view.
- Changing `speed` mid-run moves particles by `O(dt)`, not `O(t)` — regression guard for the
  bug where position was derived from `performance.now() * speed`.
- The generative spawner never exceeds its ring budget over a long simulated run.
- Every control id resolves to a real element, and every default sits inside its own range.
- Chords use the theme foreground unless chromatic mode is on, and are skipped entirely at
  zero opacity.
- Both MediaRecorder fallback entry points advance frames with elapsed time. Constructor,
  start, encoder-event and rendering failures release tracks and pending animation frames.
- WebCodecs advances and timestamps the exact selected frame count; encoding failures and
  cancellation during the final frame request output cancellation without downloading a success.

Browser acceptance also checks downloaded video, control locking, resize cancellation and
the app lifecycle. The unit doubles do not prove that a particular browser can encode a codec.

`tests/mediabunny-cleanup.test.js` imports the installed dependency and replaces only native
resources to exercise color/alpha flush failures, prior encoder errors and cleanup failures.
It checks error identity and resource closure across success, cancellation and repeated close.

For real browser acceptance, build first and run:

```bash
npm run build
npm run smoke:export
```

The smoke reuses this workspace's Python Lair Playwright/Chromium installation. Elsewhere,
set `PLAYWRIGHT_MODULE` to an installed `@playwright/test` module path and install its Chromium;
`ffprobe` and `ffmpeg` must be on PATH. No browser dependency is added to this package.
Exports from `dist/` verify failed-finalize recovery, the next successful 60-frame clip,
MediaRecorder motion and capture cleanup, control locking, cancellation and resize.
The destroy probe uses a local Vite source server to inspect the real App instance.
Downloaded clips and a JSON summary are kept in the printed temporary directory.

## License

MIT. Made by [MrCabss69](https://github.com/MrCabss69).
