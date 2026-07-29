'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..', '..');

function sha256OfFile(absolutePath) {
  const bytes = fs.readFileSync(absolutePath);
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function resolveImageRef(refValue, { storageRoot = process.env.KSCAN_EVAL_STORAGE_ROOT } = {}) {
  if (!/^[a-z0-9+.-]+:\/\//i.test(refValue)) {
    return path.join(ROOT, refValue);
  }
  if (!storageRoot) {
    throw new Error(
      `governed storage ref ${refValue} cannot be resolved: set KSCAN_EVAL_STORAGE_ROOT to the governed storage root`
    );
  }

  const withoutScheme = refValue.replace(/^[a-z0-9+.-]+:\/\//i, '');
  const parts = withoutScheme.split('/').filter(Boolean);
  const tierIdx = parts.findIndex((part) => part === 'tier-a');
  const tail = tierIdx >= 0 ? parts.slice(tierIdx + 1) : parts.slice(1);
  const candidate = path.join(storageRoot, ...tail);
  if (fs.existsSync(candidate)) return candidate;
  for (const ext of ['.jpg', '.jpeg', '.png']) {
    if (fs.existsSync(candidate + ext)) return candidate + ext;
  }
  return candidate;
}

module.exports = { ROOT, resolveImageRef, sha256OfFile };
