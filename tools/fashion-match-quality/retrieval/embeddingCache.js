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
 *
 * PROVIDER BOUNDARY (spec section 12), added by the visual-re-ranker lane.
 * Distinct revision strings stop stub and real entries COLLIDING, but they do
 * not by themselves stop a subtler failure: a caller that passes a real
 * resolved `modelRevision` while a stub embedder quietly services the call as
 * a fallback would write harness-stub bytes to disk under a real-model cache
 * identity. Every later run would then read those bytes back, see a real
 * revision, and have no way left to tell they were never FashionCLIP's.
 *
 * So `provider` is now load-bearing on both ends, not just descriptive
 * metadata:
 *   - `putCached` REFUSES to write a non-model provider under an immutable
 *     (real) model revision, and refuses the mirror case too.
 *   - `getCached` verifies a stored entry's provider against the caller's
 *     `expectedProvider`; a mismatch is reported as a MISS carrying a
 *     `providerMismatch` record, never silently served.
 * Both directions are proved in rerank/tests/cacheProviderBoundary.test.js.
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

/** Providers that are by construction NOT the real model. Kept as a literal
 * here rather than imported from rerank/executionIdentity.js so this module
 * stays dependency-free for the plain #402 retrieval path; the two lists are
 * pinned together by rerank/tests/cacheProviderBoundary.test.js. */
const NON_MODEL_PROVIDERS = Object.freeze(['HARNESS_STUB_NOT_FASHIONCLIP', 'HARNESS_VISUAL_DESCRIPTOR_NOT_FASHIONCLIP']);
const REAL_MODEL_PROVIDER = 'FASHIONCLIP';

/** A resolved huggingface revision is a 40-hex commit SHA; a stub revision is not. */
function isImmutableModelRevision(revision) {
  return typeof revision === 'string' && /^[0-9a-f]{40}$/.test(revision);
}

/**
 * The stub/real boundary, enforced at the moment of writing.
 *
 * @throws {Error} when provider and modelRevision disagree about whether this
 *   embedding came from the real model.
 */
function assertProviderRevisionCoherent(provider, modelRevision) {
  const realRevision = isImmutableModelRevision(modelRevision);
  if (NON_MODEL_PROVIDERS.includes(provider) && realRevision) {
    throw new Error(
      `CACHE_IDENTITY_VIOLATION: refusing to store provider '${provider}' under real model revision ` +
        `'${modelRevision}'. Harness-stub embeddings must never be reachable under a real-model cache identity.`,
    );
  }
  if (provider === REAL_MODEL_PROVIDER && !realRevision) {
    throw new Error(
      `CACHE_IDENTITY_VIOLATION: refusing to store provider '${REAL_MODEL_PROVIDER}' under non-immutable revision ` +
        `'${modelRevision}'. A real-model embedding must carry a resolved commit SHA.`,
    );
  }
  return true;
}

/** Returns { hit:false, key } or { hit:true, key, embedding, provider, cachedAt }. Never throws - a corrupt entry is treated as a miss, not a crash. */
function getCached({ cacheDir = DEFAULT_CACHE_DIR, inputHash, modelRevision, preprocessingVersion, expectedProvider }) {
  const key = cacheKey({ inputHash, modelRevision, preprocessingVersion });
  const file = cacheFilePath(cacheDir, key);
  if (!fs.existsSync(file)) return { hit: false, key };
  let record;
  try {
    record = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { hit: false, key };
  }
  // Provider boundary: a stored entry whose provider disagrees with what the
  // caller is asking for is NOT served. Treating it as a miss (rather than
  // throwing) keeps one poisoned entry from aborting a whole evaluation pass,
  // while `providerMismatch` makes the event visible instead of silent.
  if (expectedProvider !== undefined && record.provider !== expectedProvider) {
    return {
      hit: false,
      key,
      providerMismatch: { expected: expectedProvider, found: record.provider },
    };
  }
  return { hit: true, key, embedding: record.embedding, provider: record.provider, cachedAt: record.cachedAt };
}

function putCached({ cacheDir = DEFAULT_CACHE_DIR, inputHash, modelRevision, preprocessingVersion, embedding, provider }) {
  assertProviderRevisionCoherent(provider, modelRevision);
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
function embedWithCache({ cacheDir = DEFAULT_CACHE_DIR, input, modelRevision, preprocessingVersion, embedFn, expectedProvider }) {
  const inputHash = computeInputHash(input);
  const cached = getCached({ cacheDir, inputHash, modelRevision, preprocessingVersion, expectedProvider });
  if (cached.hit) {
    return {
      ok: true,
      fromCache: true,
      key: cached.key,
      embedding: cached.embedding,
      provider: cached.provider,
      providerVerified: expectedProvider !== undefined,
    };
  }

  const result = embedFn(input);
  if (!result.ok) return result;

  // A caller that declared which provider it expects must actually get it.
  // Without this, an embedder that silently fell back to a stub would write
  // stub bytes under the caller's declared identity - the exact substitution
  // spec section 12 forbids.
  if (expectedProvider !== undefined && result.provider !== expectedProvider) {
    return {
      ok: false,
      blocker: 'PROVIDER_MISMATCH',
      detail: `expected embeddings from '${expectedProvider}' but the embedder returned '${result.provider}'`,
    };
  }

  const key = putCached({
    cacheDir,
    inputHash,
    modelRevision,
    preprocessingVersion,
    embedding: result.embedding,
    provider: result.provider,
  });
  return {
    ok: true,
    fromCache: false,
    key,
    embedding: result.embedding,
    provider: result.provider,
    providerVerified: expectedProvider !== undefined,
  };
}

module.exports = {
  DEFAULT_CACHE_DIR,
  NON_MODEL_PROVIDERS,
  REAL_MODEL_PROVIDER,
  computeInputHash,
  cacheKey,
  isImmutableModelRevision,
  assertProviderRevisionCoherent,
  getCached,
  putCached,
  embedWithCache,
};
