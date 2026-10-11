/**
 * Deterministic pseudo-random generator (mulberry32).
 *
 * The synthetic engine must produce identical output for identical input, otherwise
 * analysing the same video twice would report different potholes. Never use
 * Math.random() or the wall clock in the synthetic pipeline.
 */
export function createPrng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform float in [min, max). */
export function randomBetween(rng: () => number, min: number, max: number): number {
  return min + rng() * (max - min);
}
