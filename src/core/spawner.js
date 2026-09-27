import { createRing } from './ring.js';

/**
 * Ring lifecycle policies.
 *
 * Both policies answer the same question — *which rings exist at time t* — and hand the
 * `Scene` an identical `Ring[]`. Only the answer differs:
 *
 *  - `generative` is an endless inward spiral with a bounded ring count: rings spawn on an
 *    interval and the oldest fades out once the budget is exceeded.
 *  - `static` builds a fixed set up front and never changes it.
 *
 * Both policies are deterministic for the same config and sequence of frame deltas.
 *
 * @typedef {object} Spawner
 * @property {string} id
 * @property {(config: object) => import('./ring.js').Ring[]} initial Rings at t=0.
 * @property {(state: SpawnState, dt: number, config: object) => void} update Mutates
 *   `state.rings` in place; ring phase and fade advance in `Scene`.
 *
 * @typedef {object} SpawnState
 * @property {import('./ring.js').Ring[]} rings
 * @property {number} seq Last issued ring sequence number.
 * @property {number} nextRadius Radius the next spawned ring will use.
 * @property {number} sinceSpawn Seconds since the last spawn.
 */

/**
 * Radius of ring `i` in a static, evenly spread set.
 * @param {number} i
 * @param {number} count
 * @param {number} initialRadius
 * @param {number} minRadius
 * @returns {number}
 */
function staticRadius(i, count, initialRadius, minRadius) {
  if (count <= 1) return initialRadius;
  const span = initialRadius - minRadius;
  return initialRadius - (i * span) / (count - 1);
}

/** @type {Spawner} */
export const staticSpawner = {
  id: 'static',

  initial(config) {
    const { ringCount, initialRadius, minRadius, planeAngle } = config;
    const rings = [];
    for (let i = 0; i < ringCount; i++) {
      rings.push(
        createRing({
          seq: i,
          radius: staticRadius(i, ringCount, initialRadius, minRadius),
          planeAngle,
        })
      );
    }
    return rings;
  },

  update() {
    // Fixed set: nothing spawns, nothing is evicted.
  },
};

/** @type {Spawner} */
export const generativeSpawner = {
  id: 'generative',

  initial(config) {
    return [createRing({ seq: 0, radius: config.initialRadius, planeAngle: config.planeAngle })];
  },

  update(state, dt, config) {
    const { circleInterval, initialRadius, radiusStep, minRadius, planeAngle, maxRings } = config;

    state.sinceSpawn += dt;

    // `while`, not `if`: a long frame (tab regained focus) may owe several spawns, and a
    // very small interval may owe more than one per frame.
    let budget = Math.max(1, maxRings);
    while (state.sinceSpawn >= circleInterval && budget-- > 0) {
      state.sinceSpawn -= circleInterval;

      if (state.nextRadius < minRadius) state.nextRadius = initialRadius;
      state.seq += 1;
      state.rings.push(createRing({ seq: state.seq, radius: state.nextRadius, planeAngle }));
      state.nextRadius -= radiusStep;
    }
    // Drop any spawn debt we could not pay this frame rather than carrying it forward.
    if (state.sinceSpawn >= circleInterval) state.sinceSpawn = 0;

    evictOldest(state.rings, maxRings);
  },
};

/**
 * Mark the oldest live rings as fading until the live count fits the budget.
 *
 * Only non-fading rings count against the budget; otherwise every frame would re-mark the
 * same over-budget ring and the whole set would fade out at once.
 *
 * @param {import('./ring.js').Ring[]} rings
 * @param {number} maxRings
 */
function evictOldest(rings, maxRings) {
  let live = 0;
  for (const ring of rings) if (!ring.fading) live += 1;

  for (const ring of rings) {
    if (live <= maxRings) break;
    if (ring.fading) continue;
    ring.fading = true;
    live -= 1;
  }
}

/** @type {Record<string, Spawner>} */
const REGISTRY = {
  [generativeSpawner.id]: generativeSpawner,
  [staticSpawner.id]: staticSpawner,
};

/**
 * @param {string} id
 * @returns {Spawner}
 * @throws {Error} If `id` is not registered.
 */
export function getSpawner(id) {
  const spawner = REGISTRY[id];
  if (!spawner) {
    throw new Error(`Unknown spawn mode "${id}". Available: ${Object.keys(REGISTRY).join(', ')}`);
  }
  return spawner;
}
