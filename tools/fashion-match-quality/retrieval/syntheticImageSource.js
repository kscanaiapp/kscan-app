'use strict';

/**
 * Deterministic placeholder image bytes for R&D wiring proof.
 *
 * No real garment photographs exist anywhere in the offline fixture
 * universe this lab indexes: FMQ's synthetic fixtures carry only
 * placeholder `imageUrl` strings (e.g. `https://cdn.example/...`), never
 * real bytes, and Real Fashion Corpus V2 has 0 real cases on this checkout
 * (see tools/real-fashion-corpus/docs/DESIGN.md's DM-12). To exercise a
 * genuine image-decode/hash preprocessing step - rather than only hashing a
 * URL string - this module reuses
 * tools/real-fashion-corpus/testAssets/generate.js#makePng, the exact
 * zero-dependency, genuinely-decodable PNG generator that lab already built
 * and tested for the identical purpose (PIPELINE_TEST_ASSET bytes that
 * exercise real pipeline mechanics without claiming to be photographs).
 * Reusing it avoids inventing a second PNG encoder in this monorepo.
 *
 * These bytes are NOT photographs of any garment. They carry no visual
 * information about the candidate they are named for beyond a
 * deterministic, candidateId-seeded pixel pattern - useful for proving
 * `lib/imageIntegrity.js#inspectImage` (decode, dimensions, sha256) runs for
 * real, and for giving the harness stub embedder distinct bytes per
 * candidate, never for approximating what that candidate actually looks
 * like.
 */

const crypto = require('node:crypto');
const { makePng } = require('../../real-fashion-corpus/testAssets/generate');

function syntheticImageFor(candidateId, { width = 32, height = 32 } = {}) {
  const seed = crypto.createHash('sha256').update(String(candidateId)).digest();
  const pattern = (x, y) => [
    (seed[(x + y) % seed.length] + x * 7) % 256,
    (seed[(x * 3 + 1) % seed.length] + y * 5) % 256,
    seed[(y * 2 + 3) % seed.length],
  ];
  return makePng({ width, height, pattern });
}

module.exports = { syntheticImageFor };
