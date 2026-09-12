'use strict';

/**
 * Node-side wrapper around the real FashionCLIP inference subprocess
 * (fashionClipAdapter.py). Mirrors tools/fashion-match-quality/l1/runL1.js's
 * pattern exactly: shell out to a pinned external runtime running the real
 * model, probe availability up front, and return `{ ok: false, blocker }`
 * rather than throwing when that runtime cannot run here - one blocked
 * embedding must never abort a whole evaluation pass.
 *
 * Why this is genuinely gated in this R&D session, not just defensively
 * coded: `isFashionClipAvailable()` checks three independent things, and any
 * one missing is real:
 *   1. `python3` is on PATH.
 *   2. `python3 -c "import torch, transformers"` succeeds (neither package is
 *      installed in this sandbox as of this build).
 *   3. A local HF cache for patrickjohncyh/fashion-clip already exists -
 *      `from_pretrained()` would otherwise need to reach huggingface.co,
 *      which this session's egress proxy explicitly policy-denies (see
 *      modelManifest.js's header). Checking this up front avoids spawning a
 *      subprocess that can only fail after a network timeout.
 * The moment all three hold in some environment, this module runs the real
 * model unmodified - nothing here needs to change.
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ADAPTER_SCRIPT = path.join(__dirname, 'fashionClipAdapter.py');
const MODEL_ID = 'patrickjohncyh/fashion-clip';

function hfCacheDirFor(modelId) {
  // Standard huggingface_hub cache layout: models--<org>--<name>.
  const slug = `models--${modelId.replace('/', '--')}`;
  const base = process.env.HF_HOME || path.join(os.homedir(), '.cache', 'huggingface');
  return path.join(base, 'hub', slug);
}

let _availability;
/**
 * Returns { available, reasons } - reasons lists every unmet precondition,
 * never just the first, so a diagnostic report can show the whole picture
 * at once (spec section 4 asks this to be recorded, not just asserted).
 */
function checkFashionClipAvailability({ forceRecheck = false } = {}) {
  if (_availability && !forceRecheck) return _availability;

  const reasons = [];

  const pythonProbe = spawnSync('python3', ['--version'], { encoding: 'utf8' });
  const hasPython = pythonProbe.status === 0;
  if (!hasPython) reasons.push('PYTHON3_NOT_FOUND');

  let hasRuntime = false;
  if (hasPython) {
    const runtimeProbe = spawnSync('python3', ['-c', 'import torch, transformers'], { encoding: 'utf8' });
    hasRuntime = runtimeProbe.status === 0;
    if (!hasRuntime) {
      reasons.push('TORCH_OR_TRANSFORMERS_NOT_INSTALLED');
    }
  }

  const cacheDir = hfCacheDirFor(MODEL_ID);
  const hasLocalModelCache = fs.existsSync(cacheDir) && fs.readdirSync(cacheDir).length > 0;
  if (!hasLocalModelCache) {
    reasons.push('MODEL_NOT_CACHED_LOCALLY_AND_HUGGINGFACE_CO_IS_NETWORK_BLOCKED_IN_THIS_SESSION');
  }

  _availability = { available: reasons.length === 0, reasons, cacheDirChecked: cacheDir };
  return _availability;
}

function isFashionClipAvailable() {
  return checkFashionClipAvailability().available;
}

/**
 * Read the commit SHA of the locally-cached model snapshot, synchronously
 * and without a network call - huggingface_hub's on-disk cache layout keeps
 * `<cacheDir>/refs/<ref>` as a plain-text file containing the commit SHA a
 * ref resolved to at download time, and `<cacheDir>/snapshots/<sha>/` as the
 * actual snapshot directory. This lets a cache key be computed BEFORE
 * running the model (avoiding "the revision is only known after inference"
 * chicken/egg problem) whenever a real cached model is present. Returns
 * null when no cache exists (nothing to resolve).
 */
function resolveLocalCachedRevision() {
  const cacheDir = hfCacheDirFor(MODEL_ID);
  const refFile = path.join(cacheDir, 'refs', 'main');
  if (fs.existsSync(refFile)) {
    const sha = fs.readFileSync(refFile, 'utf8').trim();
    if (sha) return sha;
  }
  const snapshotsDir = path.join(cacheDir, 'snapshots');
  if (fs.existsSync(snapshotsDir)) {
    const entries = fs.readdirSync(snapshotsDir).sort();
    if (entries.length > 0) return entries[0];
  }
  return null;
}

/**
 * Embed a batch of inputs through the real FashionCLIP model.
 *
 * @param {'image'|'text'} mode
 * @param {string[]} inputs - absolute image file paths (mode 'image') or raw
 *   text strings (mode 'text').
 * @returns {{ok:true, modelRevision:string, embeddings:number[][]} |
 *           {ok:false, blocker:string, detail:string}}
 */
function embedBatch(mode, inputs) {
  const availability = checkFashionClipAvailability();
  if (!availability.available) {
    return {
      ok: false,
      blocker: 'FASHIONCLIP_UNAVAILABLE',
      detail: `FashionCLIP cannot run in this environment: ${availability.reasons.join(', ')}`,
    };
  }

  const tmpFile = path.join(os.tmpdir(), `fashionclip-req-${mode}-${process.pid}-${Date.now()}.json`);
  try {
    fs.writeFileSync(tmpFile, JSON.stringify({ mode, inputs }), 'utf8');

    const result = spawnSync('python3', [ADAPTER_SCRIPT, tmpFile], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 120000,
    });

    if (result.error) {
      return { ok: false, blocker: 'FASHIONCLIP_SUBPROCESS_FAILED', detail: result.error.message };
    }
    if (result.status !== 0) {
      return {
        ok: false,
        blocker: 'FASHIONCLIP_SUBPROCESS_FAILED',
        detail: (result.stderr || 'unknown python failure').slice(0, 2000),
      };
    }

    const parsed = JSON.parse(result.stdout.trim());
    return parsed;
  } catch (err) {
    return { ok: false, blocker: 'FASHIONCLIP_WRAPPER_EXCEPTION', detail: err.message };
  } finally {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      // best-effort cleanup
    }
  }
}

function embedImages(imagePaths) {
  return embedBatch('image', imagePaths);
}

function embedTexts(texts) {
  return embedBatch('text', texts);
}

module.exports = {
  MODEL_ID,
  isFashionClipAvailable,
  checkFashionClipAvailability,
  resolveLocalCachedRevision,
  embedImages,
  embedTexts,
};
