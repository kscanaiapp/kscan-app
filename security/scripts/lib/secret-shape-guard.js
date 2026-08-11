#!/usr/bin/env node
'use strict';

/**
 * Detects credential-shaped substrings inside arbitrary strings/objects so
 * release-control-plane records (transition history, manifests, reports)
 * fail closed rather than silently accepting an accidentally-pasted secret.
 *
 * This does not attempt to detect every possible secret shape - it mirrors
 * the shapes this repository's own credentials take (see
 * __tests__/security/stagingParityVerifier.test.js, "carries no secret
 * material"), so the same offender list stays consistent across the
 * verification suite and the new release control plane.
 *
 * Node built-ins only.
 */

const SECRET_SHAPES = Object.freeze([
  { re: /\beyJ[A-Za-z0-9_-]{20,}\./, label: 'JWT' },
  { re: /\bsb_(secret|publishable)_[A-Za-z0-9_-]{10,}/, label: 'Supabase API key' },
  { re: /postgres(?:ql)?:\/\/[^\s"]*:[^\s"@]+@/, label: 'database URL with password' },
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}/, label: 'GitHub token' },
  { re: /\bsbp_[A-Za-z0-9]{20,}/, label: 'Supabase personal access token' },
]);

/** Walks a value (string/array/object) and returns `{ path, label }` for every match. */
function findEmbeddedSecrets(value, rootLabel = 'value') {
  const offenders = [];
  const walk = (node, pathParts) => {
    if (typeof node === 'string') {
      for (const { re, label } of SECRET_SHAPES) {
        if (re.test(node)) offenders.push({ path: pathParts.join('.'), label });
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, [...pathParts, i]));
      return;
    }
    if (node && typeof node === 'object') {
      for (const [key, val] of Object.entries(node)) walk(val, [...pathParts, key]);
    }
  };
  walk(value, [rootLabel]);
  return offenders;
}

class EmbeddedSecretError extends Error {
  constructor(offenders) {
    super(`refusing to record embedded credential-shaped value(s): ${offenders.map((o) => `${o.path} (${o.label})`).join(', ')}`);
    this.name = 'EmbeddedSecretError';
    this.code = 'EMBEDDED_SECRET_DETECTED';
    this.offenders = offenders;
  }
}

function assertNoEmbeddedSecret(value, rootLabel = 'value') {
  const offenders = findEmbeddedSecrets(value, rootLabel);
  if (offenders.length > 0) throw new EmbeddedSecretError(offenders);
}

module.exports = {
  SECRET_SHAPES,
  findEmbeddedSecrets,
  assertNoEmbeddedSecret,
  EmbeddedSecretError,
};
