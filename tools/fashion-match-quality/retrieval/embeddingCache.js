'use strict';

/**
 * Embedding cache (spec section 8).
 *
 * Cache key = sha256(inputHash | modelRevision | preprocessingVersion).
 * All three are load-bearing: two different inputs must never collide
 * (inputHash), a model revision bump must never serve a stale embedding
 * (modelRevision), and a preprocessing change (resize/normalize parameters)
 * must invalidate every entry computed under the old preprocessing
 * (preprocessingVersion) - see modelManifest.js's IMAGE_PREPROCESSING_VERSION
 * / TEXT_PREPROCESSING_VERSION, which exist specifically to be threaded
 * through here.
 *
 * Persisted as one JSON file per key under `cacheDir`, which defaults to a
 * directory OUTSIDE committed source (see .gitignore alongside it) - this
 * mirrors tools/real-fashion-corpus/docs/DESIGN.md's DM-01 (real bytes never
 * committed; the manifest/hash is the version-controlled artifact, not the
 * payload). Embeddings computed by the harness stub embedder are cached
 * exactly the same way as real FashionCLIP embeddings - the cache is
 * provider-agnostic by design - but never collide with each other because
 * `harnessStubEmbedder.STUB_REVISION` and a real resolved model revision are
 * always different strings.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_CACHE_DIR = path.join(__dirname, 'cache');

function computeInputHash(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function cacheKey({ inputHash, modelRevision, preprocessingVersion }) {
  if (!inputHash || !modelRevision || !preprocessingVersion) {
    throw new Error('cacheKey requires inputHash, modelRevision, and preprocessingVersion');
  }
  return crypto.createHash('sha256').update(`${inputHash}|${modelRevision}|${preprocessingVersion}`).digest('hex');
}

function cacheFilePath(cacheDir, key) {
  return path.join(cacheDir, `${key}.json`);
}

/** Returns { hit:false, key } or { hit:true, key, embedding, provider, cachedAt }. Never throws - a corrupt entry is treated as a miss, not a crash. */
function getCached({ cacheDir = DEFAULT_CACHE_DIR, inputHash, modelRevision, preprocessingVersion }) {
  const key = cacheKey({ inputHash, modelRevision, preprocessingVersion });
  const file = cacheFilePath(cacheDir, key);
  if (!fs.existsSync(file)) return { hit: false, key };
  try {
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { hit: true, key, embedding: record.embedding, provider: record.provider, cachedAt: record.cachedAt };
  } catch {
    return { hit: false, key };
  }
}

function putCached({ cacheDir = DEFAULT_CACHE_DIR, inputHash, modelRevision, preprocessingVersion, embedding, provider }) {
  const key = cacheKey({ inputHash, modelRevision, preprocessingVersion });
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(
    cacheFilePath(cacheDir, key),
    JSON.stringify({ inputHash, modelRevision, preprocessingVersion, provider, embedding, cachedAt: new Date().toISOString() }),
    'utf8',
  );
  return key;
}

/**
 * Embed one input through `embedFn` (a single-input function returning
 * `{ok:true, embedding, provider}` or `{ok:false, blocker, detail}`),
 * consulting/populating the cache first. Never recomputes an embedding this
 * exact (input, modelRevision, preprocessingVersion) triple has already
 * produced (spec section 8's "do not repeatedly recompute unnecessarily").
 */
function embedWithCache({ cacheDir = DEFAULT_CACHE_DIR, input, modelRevision, preprocessingVersion, embedFn }) {
  const inputHash = computeInputHash(input);
  const cached = getCached({ cacheDir, inputHash, modelRevision, preprocessingVersion });
  if (cached.hit) return { ok: true, fromCache: true, key: cached.key, embedding: cached.embedding, provider: cached.provider };

  const result = embedFn(input);
  if (!result.ok) return result;

  const key = putCached({
    cacheDir,
    inputHash,
    modelRevision,
    preprocessingVersion,
    embedding: result.embedding,
    provider: result.provider,
  });
  return { ok: true, fromCache: false, key, embedding: result.embedding, provider: result.provider };
}

module.exports = {
  DEFAULT_CACHE_DIR,
  computeInputHash,
  cacheKey,
  getCached,
  putCached,
  embedWithCache,
};
