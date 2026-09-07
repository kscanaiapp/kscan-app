'use strict';

/**
 * Deterministic pseudo-random generator (mulberry32) plus small derived
 * helpers. Given the same numeric seed this always produces the same
 * sequence, which is what section 52 (DETERMINISM) and section 17
 * (SYNTHESIZER_VERSION participates in corpus hashes) require: the corpus
 * generator must be a pure function of (fixtures, scripts, seed, version).
 *
 * Not cryptographic. Not shared with, or derived from, any other research
 * lane's RNG utility — written fresh for this lane per the parallel-lane
 * firewall instruction.
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

/** Hash a string seed (e.g. "closet:minimal:D01") to a 32-bit int seed. */
function seedFromString(text) {
  let h = 2166136261 >>> 0;
  const s = String(text);
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

class SeededRandom {
  constructor(seed) {
    this.seedValue = typeof seed === 'string' ? seedFromString(seed) : seed >>> 0;
    this.next = mulberry32(this.seedValue);
  }

  /** Float in [0, 1). */
  float() {
    return this.next();
  }

  /** Integer in [min, max] inclusive. */
  int(min, max) {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** Pick one element deterministically. */
  pick(array) {
    if (!array.length) throw new Error('SeededRandom.pick: empty array');
    return array[this.int(0, array.length - 1)];
  }

  /** Pick `count` distinct elements, order preserved by source array. */
  pickN(array, count) {
    const pool = array.slice();
    const chosenIdx = new Set();
    const n = Math.min(count, pool.length);
    while (chosenIdx.size < n) {
      chosenIdx.add(this.int(0, pool.length - 1));
    }
    return pool.filter((_, idx) => chosenIdx.has(idx));
  }

  /** Deterministic Fisher-Yates shuffle (does not mutate input). */
  shuffle(array) {
    const out = array.slice();
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = this.int(0, i);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  bool(probabilityTrue = 0.5) {
    return this.next() < probabilityTrue;
  }
}

module.exports = { SeededRandom, mulberry32, seedFromString };
