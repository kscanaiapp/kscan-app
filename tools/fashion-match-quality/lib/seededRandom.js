'use strict';

/**
 * Deterministic seeded PRNG (mulberry32). Used for synthetic fixture
 * generation and bootstrap resampling so results are byte-reproducible
 * across runs, machines, and Node versions (per spec section 24 -
 * "fixed seeds").
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Simple deterministic string -> 32-bit seed hash (FNV-1a). */
function seedFromString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

class SeededRandom {
  constructor(seed) {
    this.seed = typeof seed === 'string' ? seedFromString(seed) : (seed >>> 0);
    this._next = mulberry32(this.seed);
  }

  /** Float in [0, 1). */
  float() {
    return this._next();
  }

  /** Integer in [min, max] inclusive. */
  int(min, max) {
    return Math.floor(this.float() * (max - min + 1)) + min;
  }

  /** Pick one element deterministically. */
  pick(arr) {
    return arr[this.int(0, arr.length - 1)];
  }

  /** Fisher-Yates shuffle using this generator's stream (does not mutate input). */
  shuffle(arr) {
    const out = arr.slice();
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = this.int(0, i);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }
}

module.exports = { SeededRandom, mulberry32, seedFromString };
