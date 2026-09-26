# Orbital Canvas

Generative particle animation on a three-dimensional orbital scene, rendered to
a plain HTML canvas. One simulation, two projections:

| Mode               | What it is                                                                                                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **3D** _(default)_ | Perspective projection through an orbit camera. Drag to orbit, scroll to zoom. Depth-modulated alpha, drawn far to near.                                                                    |
| **2D**             | Orthographic projection looking straight down the Z axis onto the XY plane. `z` is dropped outright: uniform size, uniform alpha, no sorting. Tilted rings appear as clean nested ellipses. |

Switching modes swaps a projector, nothing else. The scene, its rotation phases and the
camera and particle connections are preserved.

![Interface](resources/interface.png)

Inspired by [Geometría Aurea](https://instagram.com/geometria_aurea/).

## Quick start

```bash
npm ci
npm run dev      # http://localhost:5173
```

| Script            | Purpose                                                   |
| ----------------- | --------------------------------------------------------- |
| `npm run dev`     | Vite dev server with HMR                                  |
| `npm run build`   | Production bundle into `dist/`                            |
| `npm run preview` | Serve the built bundle                                    |
| `npm test`        | Unit tests (vitest)                                       |
| `npm run lint`    | ESLint                                                    |
| `npm run format`  | Prettier                                                  |
| `npm run smoke`   | Chromium application and export regressions (build first) |

After `npm run build` you can serve `dist/` with any static server.

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

- **3D / 2D** — projection mode. Stored with the other scene parameters in `localStorage`.
  Share writes the configuration into the URL hash, which takes precedence on opening a link.
  Editing stores changes immediately and clears that snapshot from the address bar, so reload
  uses the updated local configuration. Share creates a new link when needed. There is no
  separate query-string view override.
- **Ring lifecycle**
  - _Generative_ (default) — rings spawn on an interval with a decrementing radius; once the
    live-ring budget is reached the oldest fades out.
  - _Static_ — a fixed set of rings spread evenly across the radius range, built up front.
    Fully deterministic; use it for reproducible exports and snapshot comparisons.
- **Drag** the canvas to orbit the camera, **scroll** to zoom. Both apply to the 3D view only.
- **Parameter range** — _Safe_ reserves room for fading rings below the 4,000-particle
  warning threshold. _Experimental_ opens wider creative ranges; switching back to Safe
  clamps values to its limits. The threshold is a heuristic, not an FPS guarantee:
  shapes, glow, resolution and hardware also affect rendering cost.
- Play/pause, PNG snapshot, randomise, restart the current configuration, restore all defaults,
  and video export.
- <kbd>Esc</kbd> closes the parameter drawer.

**Chord opacity** controls the density of crossing lines. **Chromatic chords** enables
their rotating hue cycle.

The default particle colour tracks the theme — white on black, black on white — until you
pick a colour of your own. The configuration stores either `auto` or a hexadecimal colour;
that choice survives reloads, shared links and undo. The Default preset and Restore defaults
return to theme tracking; restarting preserves the choice.

A preset sets every control — its own values over the defaults — so the result does not
depend on what was set before. Auto-orbit is the exception: it is a motion preference and
presets leave it alone.

Undo after Restore defaults also restores the camera and export duration/FPS.

Typography is self-hosted Inter Tight and JetBrains Mono, latin subset only (~85 kB of
woff2, bundled locally). No CDN and no third-party request at any point.

## Video export

Export uses [Mediabunny](https://mediabunny.dev) over the **WebCodecs** API. The exporter
owns the clock during a WebCodecs recording and steps the scene by exactly `1/fps` per frame, so the
output contains precisely `duration × fps` frames regardless of render speed, and encoding
can run faster than real time.

Verify frame-exactness on any clip:

```bash
ffprobe -v error -count_frames -select_streams v:0 \
  -show_entries stream=nb_read_frames,r_frame_rate -of default=nw=1 orbital-canvas-*.mp4
# nb_read_frames must equal duration × fps
```

Codec preference is `avc → av1 → vp9 → vp8`, muxed into MP4 or WebM accordingly. Browsers
without `VideoEncoder` or a usable codec fall back to `MediaRecorder` + `captureStream`.
That fallback also advances the scene itself, using elapsed real time; it may drop frames
under load and does not promise an exact frame count. The downloaded extension follows the
actual MP4 or WebM container; other fallback containers are rejected. Convert afterwards with ffmpeg as needed:

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
The patch also closes the temporary encoder and frame used by Firefox codec probes,
including unsuccessful probes.

## Architecture

```
src/
  core/            pure simulation — no DOM, no canvas, no performance.now()
    config.js        DEFAULTS + control schema + display/internal unit conversion
    ring.js          one orbital circle: radius, tilt, yaw, direction, phase
    spawner.js       generative | static ring lifecycle policies
    scene.js         owns the rings; step(dt) integrates rotation phase
    geometry/        euclidean.js: where a particle is in space, given a ring and an index
  view/            everything that touches a 2D context
    camera.js        orbit camera (yaw, pitch, distance)
    projectors.js    PerspectiveProjector | TopOrthoProjector
    renderer.js      background/trails, opacity-batched particles and chords
    shapes.js        disc | icosahedron particle shapes
    viewport.js      DPR-aware sizing via ResizeObserver, capped at 2x
  ui/              DOM wiring
    controls.js      spec-driven control panel and segmented controls
    theme.js         data-theme, persistence, canvas colours
    permalink.js     one scene format for shared links and local persistence
    recorder.js      strategy selection and the MediaRecorder fallback
    webcodecs-export.js  Mediabunny encoder, dynamically imported
  styles.css       the entire design system
  main.js          composition root, frame loop, HUD behaviour
```

Two invariants hold the design together:

1. **Time enters only as `dt`.** Ring rotation is an integrated phase, never a function of
   absolute time. Changing the speed changes a derivative, so it can never teleport a
   particle. The application bounds elapsed time once before advancing both camera and scene.
2. **The core is projection-agnostic.** The renderer asks a projector where a particle lands
   and never inspects the view mode; perspective and depth alpha fall out of what the
   projector returns.

`geometry/euclidean.js` supplies `orbitPoint(ring, index, count, out)`, independently of
projection. It evaluates no trigonometry per particle: rings cache their orientation and phase
terms, and particle angles come from a unit-circle table. Particle iteration and coordinate
transforms reuse output objects: callbacks must copy a position if they retain it.

The renderer quantises particle opacity (ring fade × depth cue) into 16 levels and fills each
level as one path, lowest opacity first, so a frame costs at most 16 particle fills instead of
one per particle. Shapes only `trace` subpaths; an icosahedron cluster smaller than 1.5 px
collapses to one disc. The depth cue is normalised to the fixed scene extent, so a particle's
shade does not change when other rings spawn.

Scene mutations go through `setMany(changes)`; `restart()` reconstructs the current scene.
Changing ring inclination or ring limits reconstructs the rings. The perspective camera keeps a fixed focal
length while changing its distance for zoom. Chords connect particles by stable identity
(ring sequence and index over the configured ring capacity), so the pattern changes only at
the chord change rate — not when a ring spawns or is removed, and not with projection or camera
angle. Chords touching a fading ring fade with it.

## Testing

```bash
npm test
```

Unit tests cover geometry, projection, scene stepping, spawn policies, viewport sizing,
config unit conversion, renderer draw calls and video-export failure paths. Notable properties asserted:

- `TopOrthoProjector` maps two points differing only in `z` to the **same pixel** — the
  defining property of the top-down view.
- Changing `speed` mid-run moves particles by `O(dt)`, not `O(t)` — regression guard for the
  bug where position was derived from `performance.now() * speed`.
- Safe generative scenes include fading rings when checking the particle budget over long runs.
- The control and preset tables are consistent (`tests/spec-checks.js`), every default sits
  inside its own range, and applying a preset gives the same result whatever preset came before.
- Clearing the canvas paints the theme background opaquely (never `clearRect`, which is black
  on an opaque canvas). Every 30 frames an additive background fill steps trail pixels that
  8-bit rounding has stalled short of white, which otherwise leaves permanent grey trails in
  the light theme.
- Chords use the theme foreground unless chromatic mode is on, and are skipped entirely at
  zero opacity; camera motion and ring spawns do not change the connected particle identities.
- Both MediaRecorder fallback entry points advance frames with elapsed time. Constructor,
  start, encoder-event and rendering failures release tracks and pending animation frames.
- WebCodecs advances and timestamps the exact selected frame count; encoding failures and
  cancellation during the final frame request output cancellation without downloading a success.

Browser acceptance also checks downloaded video, control locking, resize cancellation and
the app lifecycle. The unit doubles do not prove that a particular browser can encode a codec.

`tests/mediabunny-cleanup.test.js` imports the installed dependency and replaces only native
resources to exercise color/alpha flush failures, prior encoder errors and cleanup failures.
It checks error identity and resource closure across success, cancellation, repeated close
and codec preparation. Native doubles verify lifecycle behavior, not physical Firefox encoding.

For real browser acceptance, build first and run:

```bash
npx playwright install chromium
npm run build
npm run smoke
```

Playwright is a local development dependency; `ffprobe` and `ffmpeg` must be on PATH.
Exports from `dist/` verify failed-finalize recovery, the next successful 60-frame clip,
MediaRecorder motion and capture cleanup, control locking, cancellation and resize.
Application regressions use a local Vite source server to inspect the real App instance:
randomisation units, persistence and sharing, automatic/custom colour, budget warnings,
modal focus, bounded camera time, full undo and destruction during capture.
Downloaded clips and a JSON summary are kept in the printed temporary directory.

## License

MIT. Made by [MrCabss69](https://github.com/MrCabss69).
