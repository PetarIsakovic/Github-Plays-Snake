/**
 * mulberry32: a tiny, fast, seedable 32-bit PRNG. The whole generator state is one
 * uint32, so it can be stored inside the game state and replayed exactly.
 */
export function nextRandom(state: number): { value: number; state: number } {
  const s = (state + 0x6d2b79f5) >>> 0;
  let t = s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, state: s };
}

/** Uniform integer in [0, n). */
export function nextInt(state: number, n: number): { value: number; state: number } {
  const r = nextRandom(state);
  return { value: Math.floor(r.value * n), state: r.state };
}

export function randomSeed(): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0]!;
}
