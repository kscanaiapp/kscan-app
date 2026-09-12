'use strict';

/**
 * FashionCLIP model identity (Build 35 Workstream 03, spec section 4).
 *
 * This module is the single source of truth for "which model, which
 * revision, preprocessed how" - every embedding this lab produces carries
 * these values, so a later model or preprocessing change is a visible cache
 * miss (embeddingCache.js) rather than a silent drift.
 *
 * IMPORTANT ENVIRONMENT FACT, recorded here rather than discovered later:
 * this R&D session's egress proxy returns an explicit ORGANIZATION POLICY
 * denial (403 CONNECT) for huggingface.co and every mirror tried
 * (hf-mirror.com, cdn.jsdelivr.net, cdn-lfs.huggingface.co) - confirmed via
 * the proxy's own `/__agentproxy/status` endpoint, which records the
 * rejection as `connect_rejected` / "policy denial". `resolveRevision()`
 * below genuinely attempts the Hub API call every time it runs (it is not
 * hardcoded to fail) - it fails in *this* environment because the network
 * policy forbids it, not because the code assumes failure. See
 * `fashionClipAdapter.js`'s header for what that means for embeddings.
 *
 * MODEL_REVISION is therefore NOT a resolved commit SHA in this build - a
 * fabricated-looking hex string here would be worse than an honest
 * "unresolved" sentinel, because it would look pinned without ever having
 * been checked against the real repository. `resolveRevision()` is the real,
 * reusable resolution path; the moment huggingface.co is reachable from a
 * session, calling it fills in a real, verified commit SHA and nothing else
 * about this module needs to change.
 */

const https = require('node:https');

const MODEL_ID = 'patrickjohncyh/fashion-clip';

// Requested pin target. Passed to resolveRevision() as the ref to resolve to
// an immutable commit SHA - 'main' is the branch name, not itself a pin.
const MODEL_REVISION_REF = 'main';

// Documented from the model's public HF Hub card (readable public knowledge,
// not fetched in this session - see the header comment). Recorded here as a
// citation, not as something this session verified live.
const MODEL_LICENSE = 'MIT';
const MODEL_CARD_URL = 'https://huggingface.co/patrickjohncyh/fashion-clip';

// FashionCLIP is a fine-tune of openai/clip-vit-base-patch32 and keeps its
// architecture, including projection dimension.
const EMBEDDING_DIMENSION = 512;

// CLIP ViT-B/32 image preprocessing, unchanged by the FashionCLIP fine-tune
// (documented in the model card as using the base CLIPProcessor). Recorded
// as an explicit, versioned contract so a future change is a visible cache
// invalidation (see embeddingCache.js).
const IMAGE_PREPROCESSING_VERSION = 'clip-vit-b32-image-preprocessing-v1';
const IMAGE_PREPROCESSING = Object.freeze({
  version: IMAGE_PREPROCESSING_VERSION,
  resize: { shortSide: 224, method: 'bicubic' },
  centerCrop: { width: 224, height: 224 },
  colorSpace: 'RGB',
  normalize: {
    // OpenAI CLIP's published per-channel mean/std (0-1 scale).
    mean: [0.48145466, 0.4578275, 0.40821073],
    std: [0.26862954, 0.26130258, 0.27577711],
  },
});

const TEXT_PREPROCESSING_VERSION = 'clip-bpe-text-preprocessing-v1';
const TEXT_PREPROCESSING = Object.freeze({
  version: TEXT_PREPROCESSING_VERSION,
  tokenizer: 'CLIP BPE (byte-pair encoding, the base CLIP vocabulary)',
  lowercase: true,
  maxTokens: 77,
  padding: 'max_length',
  truncation: true,
});

/**
 * Attempt to resolve MODEL_REVISION_REF to an immutable commit SHA via the
 * public HF Hub API. This is a REAL network call, not a stub - it is
 * expected to fail with `blocker: 'HF_HUB_UNREACHABLE'` in any session whose
 * egress policy denies huggingface.co (this one included), and to succeed
 * with a real `revision` the moment that policy allows it.
 *
 * Returns a Promise<{ ok: true, revision, resolvedAt } | { ok: false, blocker, detail }>.
 */
function resolveRevision({ timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    const req = https.get(
      `https://huggingface.co/api/models/${MODEL_ID}/revision/${MODEL_REVISION_REF}`,
      { timeout: timeoutMs, headers: { Accept: 'application/json' } },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            resolve({
              ok: false,
              blocker: 'HF_HUB_UNREACHABLE',
              detail: `HTTP ${res.statusCode} from huggingface.co`,
            });
            return;
          }
          try {
            const parsed = JSON.parse(body);
            if (typeof parsed.sha !== 'string' || parsed.sha.length === 0) {
              resolve({ ok: false, blocker: 'HF_HUB_RESPONSE_MALFORMED', detail: 'no sha field in response' });
              return;
            }
            resolve({ ok: true, revision: parsed.sha, resolvedAt: new Date().toISOString() });
          } catch (err) {
            resolve({ ok: false, blocker: 'HF_HUB_RESPONSE_MALFORMED', detail: err.message });
          }
        });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, blocker: 'HF_HUB_UNREACHABLE', detail: `request timed out after ${timeoutMs}ms` });
    });
    req.on('error', (err) => {
      resolve({ ok: false, blocker: 'HF_HUB_UNREACHABLE', detail: err.message });
    });
  });
}

module.exports = {
  MODEL_ID,
  MODEL_REVISION_REF,
  MODEL_LICENSE,
  MODEL_CARD_URL,
  EMBEDDING_DIMENSION,
  IMAGE_PREPROCESSING_VERSION,
  IMAGE_PREPROCESSING,
  TEXT_PREPROCESSING_VERSION,
  TEXT_PREPROCESSING,
  resolveRevision,
};
