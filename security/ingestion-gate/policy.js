'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_POLICY_PATH = path.join(__dirname, '..', 'uploads', 'image-ingestion-policy.json');

// Loaded once per process by default (callers running many requests should
// cache the return value); tests pass an explicit policyPath or a pre-parsed
// object to avoid touching the filesystem.
function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = fs.readFileSync(policyPath, 'utf8');
  const policy = JSON.parse(raw);
  if (!Array.isArray(policy.allowedFormats) || policy.allowedFormats.length === 0) {
    throw new Error('image-ingestion-policy.json: allowedFormats must be a non-empty array');
  }
  for (const format of policy.allowedFormats) {
    if (!Array.isArray(format.requiredMagicBytes) || format.requiredMagicBytes.length === 0) {
      throw new Error(`image-ingestion-policy.json: format "${format.id}" is missing requiredMagicBytes`);
    }
  }
  return policy;
}

function getFormatById(policy, id) {
  return policy.allowedFormats.find((f) => f.id === id) || null;
}

function getFormatByMime(policy, mime) {
  return policy.allowedFormats.find((f) => f.allowedMimeTypes.includes(mime)) || null;
}

function maxAllowedBytes(policy) {
  return Math.max(...policy.allowedFormats.map((f) => f.maxCompressedBytes));
}

module.exports = { DEFAULT_POLICY_PATH, loadPolicy, getFormatById, getFormatByMime, maxAllowedBytes };
