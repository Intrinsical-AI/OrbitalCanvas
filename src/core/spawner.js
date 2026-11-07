import { createRing } from './ring.js';

export function radialLevels(config) {
  return Math.floor((1 - config.innerRatio + 1e-10) / config.ringSpacing) + 1;
}

export function layoutRing(ring, config, index = 0) {
  if (config.spawnMode === 'static') {
    ring.radius =
      config.ringCount <= 1 ? 1 : 1 - (index * (1 - config.innerRatio)) / (config.ringCount - 1);
  } else {
    ring.radialSlot %= radialLevels(config);
    ring.radius = 1 - ring.radialSlot * config.ringSpacing;
  }
}

export function evictOldest(rings, budget) {
  let live = rings.filter((r) => !r.fading).length;
  for (const ring of rings) {
    if (live <= budget) break;
    if (!ring.fading) {
      ring.fading = true;
      live--;
    }
  }
}

export const staticSpawner = {
  id: 'static',
  initial(config) {
    const layout = { ...config, spawnMode: 'static' };
    return Array.from({ length: config.ringCount }, (_, seq) => {
      const ring = createRing({ seq, radius: 1, planeAngle: config.planeAngle });
      layoutRing(ring, layout, seq);
      return ring;
    });
  },
  update() {},
};

export const generativeSpawner = {
  id: 'generative',
  initial(config, population = 'full') {
    return Array.from({ length: population === 'intro' ? 1 : config.maxRings }, (_, seq) => {
      const ring = createRing({ seq, radius: 1, planeAngle: config.planeAngle });
      ring.radialSlot = seq % radialLevels(config);
      layoutRing(ring, config);
      return ring;
    });
  },
  update(state, dt, config) {
    state.sinceSpawn += dt;
    let remaining = config.maxRings;
    while (state.sinceSpawn >= config.circleInterval && remaining-- > 0) {
      state.sinceSpawn -= config.circleInterval;
      state.seq++;
      const ring = createRing({ seq: state.seq, radius: 1, planeAngle: config.planeAngle });
      ring.radialSlot = state.nextRadialSlot % radialLevels(config);
      layoutRing(ring, config);
      state.nextRadialSlot = (ring.radialSlot + 1) % radialLevels(config);
      state.rings.push(ring);
    }
    if (state.sinceSpawn >= config.circleInterval) state.sinceSpawn = 0;
    evictOldest(state.rings, config.maxRings);
  },
};

export function getSpawner(id) {
  if (id === 'static') return staticSpawner;
  if (id === 'generative') return generativeSpawner;
  throw new Error('Unknown spawn mode "' + id + '".');
}
