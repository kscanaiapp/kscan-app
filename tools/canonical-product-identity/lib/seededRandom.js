'use strict';

/**
 * Deterministic PRNG (mulberry32) seeded from a string via a small FNV-1a
 * hash. Every corpus/case generator in this lab derives all randomness from
 * this so a fixed seed always reproduces byte-identical output (spec section
 * 39/43#1/#23 - corpus generation and the resolver must be deterministic).
 *
 * Never use Math.random() anywhere under tools/canonical-product-identity.
 */

function fnv1aSeed(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

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

/** Returns a self-contained deterministic RNG object for `seedString`. */
function createRng(seedString) {
  const next = mulberry32(fnv1aSeed(String(seedString)));
  return {
    float() {
      return next();
    },
    int(minInclusive, maxInclusive) {
      return minInclusive + Math.floor(next() * (maxInclusive - minInclusive + 1));
    },
    pick(array) {
      if (!Array.isArray(array) || array.length === 0) return undefined;
      return array[this.int(0, array.length - 1)];
    },
    bool(pTrue = 0.5) {
      return next() < pTrue;
    },
    /** Derive a fresh independent RNG scoped to a sub-namespace of this seed. */
    child(suffix) {
      return createRng(`${seedString}::${suffix}`);
    },
  };
}

module.exports = { createRng, fnv1aSeed, mulberry32 };
