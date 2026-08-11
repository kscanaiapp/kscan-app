#!/usr/bin/env node
'use strict';

/**
 * Deterministic fingerprint over ALLOWLISTED, NON-SECRET configuration
 * STRUCTURE.
 *
 * SECURITY CONTRACT - read before extending:
 *
 *   This module hashes configuration SHAPE, never configuration VALUES.
 *   Environment variables contribute their NAME and a boolean
 *   present/absent, never their contents. That is a deliberate design
 *   constraint, not an oversight: hashing a low-entropy secret value would
 *   produce a digest that is brute-forceable back to the secret, so a
 *   "fingerprint" that included values would itself become a credential
 *   disclosure channel.
 *
 *   The allowlist below is exhaustive by design. Anything not named here is
 *   excluded. Adding a value-bearing input to this fingerprint requires
 *   demonstrating the input is genuinely non-secret and high-entropy or
 *   public.
 *
 * Node built-ins only.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { assertNoEmbeddedSecret } = require('../scripts/lib/secret-shape-guard');

/**
 * Environment variable NAMES whose presence/absence is release-relevant.
 * Values are never read. This is a structural allowlist.
 */
const ENV_NAME_ALLOWLIST = Object.freeze([
  'EXPO_PUBLIC_SUPABASE_URL',
  'EXPO_PUBLIC_SUPABASE_ANON_KEY',
  'EXPO_PUBLIC_API_URL',
  'GEMINI_API_KEY',
  'OPENROUTER_API_KEY',
  'OPENROUTER_MODEL',
  'USE_OPENROUTER',
  'ACCOUNT_DELETION_WORKER_SECRET',
  'KSCAN_DEPLOY_VERSION',
]);

/** Feature-flag NAMES whose default policy is release-relevant. Values come from source, not env. */
const FEATURE_FLAG_SOURCES = Object.freeze([
  'constants/featureFlags.ts',
  'constants/freeTierBackendFlags.ts',
  'constants/freeTierUtilityFlags.ts',
]);

/** Stable JSON stringify: object keys sorted recursively, so key order can never change a digest. */
function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Parses per-function verify_jwt declarations out of supabase/config.toml.
 * These are authentication POSTURE (a boolean), not secrets.
 */
function parseVerifyJwtPolicy(configToml) {
  const policy = {};
  const lines = String(configToml).split(/\r?\n/);
  let current = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('#')) continue;
    const section = line.match(/^\[functions\.([\w-]+)\]$/);
    if (section) {
      current = section[1];
      continue;
    }
    if (line.startsWith('[')) {
      current = null;
      continue;
    }
    const kv = line.match(/^verify_jwt\s*=\s*(true|false)\s*$/);
    if (kv && current) policy[current] = kv[1] === 'true';
  }
  return policy;
}

/** Extracts exported flag NAMES (not values) from a flags source file. */
function extractFlagNames(source) {
  const names = new Set();
  const re = /\b(?:EXPO_PUBLIC_[A-Z0-9_]+)\b/g;
  let m;
  while ((m = re.exec(String(source))) !== null) names.add(m[0]);
  return [...names].sort();
}

/**
 * Builds the structural config input. Every field is a name, a boolean, or a
 * version identifier - never a credential.
 *
 * @param {object} opts
 * @param {string} opts.repoRoot
 * @param {object} [opts.env] - defaults to process.env; only KEY PRESENCE is read
 * @param {string} opts.healthContractVersion
 */
function buildConfigStructure({ repoRoot, env = process.env, healthContractVersion }) {
  const configTomlPath = path.join(repoRoot, 'supabase', 'config.toml');
  const verifyJwtPolicy = fs.existsSync(configTomlPath)
    ? parseVerifyJwtPolicy(fs.readFileSync(configTomlPath, 'utf8'))
    : {};

  const environmentVariables = {};
  for (const name of ENV_NAME_ALLOWLIST) {
    // Presence only. The value is never read, hashed, or recorded.
    environmentVariables[name] = Object.prototype.hasOwnProperty.call(env, name) && env[name] !== '';
  }

  const featureFlagNames = {};
  for (const rel of FEATURE_FLAG_SOURCES) {
    const full = path.join(repoRoot, rel);
    featureFlagNames[rel] = fs.existsSync(full) ? extractFlagNames(fs.readFileSync(full, 'utf8')) : [];
  }

  const structure = {
    schemaVersion: 1,
    environmentVariablePresence: environmentVariables,
    verifyJwtPolicy,
    featureFlagNames,
    healthContractVersion: healthContractVersion || null,
  };

  // Defense in depth: if a value ever leaked into this structure via a future
  // edit, refuse to fingerprint it rather than publishing the digest.
  assertNoEmbeddedSecret(structure, 'configStructure');

  return structure;
}

/** @returns {{structure: object, digest: string}} */
function computeConfigFingerprint(opts) {
  const structure = buildConfigStructure(opts);
  return { structure, digest: sha256(canonicalize(structure)) };
}

module.exports = {
  ENV_NAME_ALLOWLIST,
  FEATURE_FLAG_SOURCES,
  canonicalize,
  sha256,
  parseVerifyJwtPolicy,
  buildConfigStructure,
  computeConfigFingerprint,
};
