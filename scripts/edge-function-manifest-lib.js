#!/usr/bin/env node
/**
 * Shared library for the Edge Function source-parity gate (IMG-006).
 *
 * WHY THIS EXISTS: Phase 2A proved that the deployed production bundles
 * (`scan-identify` v139, `stylechat-generate` v82 in project
 * `wyyuqfdxucjksghsmhry`) content-match the Android branch function trees,
 * while the iOS branch carried a different, independently deployable copy of
 * the same functions. Nothing in the repository detected that, and the
 * documented deploy flow (`supabase functions deploy ...` from any linked
 * checkout) would happily ship the wrong tree.
 *
 * This module computes a deterministic description of what would actually be
 * deployed, so a manifest can be committed once and verified from every branch.
 *
 * Two distinct file sets are tracked per function, because they answer
 * different questions:
 *
 *   bundle — the transitive local-module closure reachable from the function
 *            entry point. This is what Deno/Supabase actually uploads and runs.
 *            A change here changes production behaviour.
 *
 *   tree   — every file inside the function directory (including tests and
 *            currently unreachable modules) plus the whole bundle. A change
 *            here does not necessarily change production, but it is exactly the
 *            kind of silent divergence that produced IMG-006, so it is gated
 *            too.
 *
 * Remote specifiers (`npm:`, `https:`, `jsr:`) are recorded verbatim as part of
 * the bundle description but are not fetched or hashed: this gate is about
 * repository source parity, and reaching the network would make it
 * non-deterministic and unusable offline / in CI.
 *
 * No credential, secret, key or environment value is read or emitted.
 */

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// Single source of truth for project-ref -> environment. This gate must not
// carry its own copy of the mapping; that duplication is what produced the
// conflicting-authority defect this module now documents.
const {
  PRODUCTION_REF,
  STAGING_REF,
  resolveEnvironment,
} = require('../security/scripts/lib/environment-authority.js');

/** Bumped only when the manifest shape changes in a way consumers must notice. */
const MANIFEST_VERSION = 'edge-function-manifest-v2';

/**
 * Historical value of `parity.approvedProjectRef` (manifest v1).
 *
 * It was recorded from `supabase/config.toml` on the canonical (Android) line,
 * where that file declares the PRODUCTION project. That made the v1 manifest
 * assert a production deploy target — while the same manifest is, by design,
 * committed byte-identically on every branch, including
 * `staging/production-parity`, whose `config.toml` correctly declares STAGING.
 * The gate therefore failed on the staging line for a reason that had nothing
 * to do with source drift.
 *
 * Retained as provenance, not as an assertion: see DEPLOY_AUTHORITY below and
 * docs/release/ENVIRONMENT_AUTHORITY.md. The production deploy target is still
 * enforced, but by scripts/deploy-edge-functions.js through the shared
 * environment authority — not by this environment-neutral artifact manifest.
 */
const LEGACY_V1_APPROVED_PROJECT_REF = 'wyyuqfdxucjksghsmhry';

/**
 * Declares where deploy-target authority actually lives, so a reader of the
 * manifest cannot mistake the artifact inventory for an environment claim.
 * Constant across branches, so it does not break cross-branch convergence.
 */
const DEPLOY_AUTHORITY = Object.freeze({
  model: 'ENVIRONMENT_SUPPLIED_AND_VALIDATED_SEPARATELY',
  authoritativeSource:
    'supabase/config.toml project_id, resolved through security/scripts/lib/environment-authority.js',
  enforcedBy: 'scripts/deploy-edge-functions.js',
  legacyV1ApprovedProjectRef: LEGACY_V1_APPROVED_PROJECT_REF,
  legacyV1Note:
    'Manifest v1 asserted this production ref as the approved deploy target. It is preserved as provenance only; this manifest is environment-neutral and no longer compares it against the checkout.',
});

/**
 * Functions whose source is governed by this gate.
 *
 * Originally scoped to the image-identification loop that Phase 2A audited and
 * Phase 2A.5 cleared. Other Edge Functions (notably the account-lifecycle
 * family) also differ between the branches; that divergence is reported by
 * `scripts/check-edge-function-parity.js --report-ungoverned` and is an explicit
 * owner decision, not something a phase silently rewrites.
 *
 * `style-outfit-generate` joined in Build 3 Phase 4, and the reason is the exact
 * failure this gate exists to prevent: it is DEPLOYED and ACTIVE, yet its
 * `index.ts` had drifted between the platform branches — iOS carried the
 * allowlist-bound model router that production actually runs, Android still had
 * the retired generic default — and nothing in the repository objected, because
 * the function was outside this list.
 *
 * It is also required rather than optional: scripts/deploy-edge-functions.js
 * refuses to deploy any function absent from the manifest, so hosting the
 * versioned private Dressing Room contract here means governing it here.
 */
const GOVERNED_FUNCTIONS = ['scan-identify', 'stylechat-generate', 'style-outfit-generate'];

const FUNCTIONS_ROOT = path.join('supabase', 'functions');
const CONFIG_RELATIVE_PATH = path.join('supabase', 'config.toml');

/** Matches `from '<spec>'`, `import '<spec>'` and `import('<spec>')`. */
const SPECIFIER_PATTERNS = [
  /\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bexport\s*\*\s*from\s*['"]([^'"]+)['"]/g,
];

function toPosix(relativePath) {
  return relativePath.split(path.sep).join('/');
}

function sha256OfFile(absolutePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(absolutePath)).digest('hex');
}

function isLocalSpecifier(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

function extractSpecifiers(source) {
  const found = new Set();
  for (const pattern of SPECIFIER_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(source)) !== null) found.add(match[1]);
  }
  return [...found];
}

/**
 * Walks the local-module graph from a function entry point.
 *
 * Returns POSIX repo-relative paths for local modules and the raw specifier
 * strings for remote ones. A local specifier that does not resolve to a file is
 * a hard error: silently dropping it would let the gate under-report the bundle.
 */
function resolveBundle(repoRoot, functionName) {
  const entryRelative = path.join(FUNCTIONS_ROOT, functionName, 'index.ts');
  const entryAbsolute = path.join(repoRoot, entryRelative);
  if (!fs.existsSync(entryAbsolute)) {
    throw new Error(`Missing function entry point: ${toPosix(entryRelative)}`);
  }

  const localFiles = new Set();
  const remoteSpecifiers = new Set();
  const queue = [entryRelative];

  while (queue.length > 0) {
    const currentRelative = queue.shift();
    const posixCurrent = toPosix(currentRelative);
    if (localFiles.has(posixCurrent)) continue;

    const currentAbsolute = path.join(repoRoot, currentRelative);
    if (!fs.existsSync(currentAbsolute)) {
      throw new Error(`Unresolved local module referenced in bundle: ${posixCurrent}`);
    }
    localFiles.add(posixCurrent);

    const source = fs.readFileSync(currentAbsolute, 'utf8');
    for (const specifier of extractSpecifiers(source)) {
      if (!isLocalSpecifier(specifier)) {
        remoteSpecifiers.add(specifier);
        continue;
      }
      const resolved = path.normalize(path.join(path.dirname(currentRelative), specifier));
      queue.push(resolved);
    }
  }

  return {
    localFiles: [...localFiles].sort(),
    remoteSpecifiers: [...remoteSpecifiers].sort(),
  };
}

function listFilesRecursively(repoRoot, relativeDir) {
  const absoluteDir = path.join(repoRoot, relativeDir);
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(toPosix(path.relative(repoRoot, full)));
    }
  };
  walk(absoluteDir);
  return out.sort();
}

/**
 * Reads `project_id` from `supabase/config.toml`.
 *
 * Returns null when the file is absent. That is itself a finding: a checkout
 * with no project configuration cannot prove which backend a deploy would
 * reach, so the gate treats it as a failure rather than a pass-by-default.
 */
function readProjectRef(repoRoot) {
  const absolute = path.join(repoRoot, CONFIG_RELATIVE_PATH);
  if (!fs.existsSync(absolute)) return null;
  const match = /^\s*project_id\s*=\s*["']([^"']+)["']/m.exec(fs.readFileSync(absolute, 'utf8'));
  return match ? match[1] : null;
}

/** Order-independent aggregate over `path:hash` pairs. */
function aggregateHash(entries) {
  const hash = crypto.createHash('sha256');
  for (const entry of [...entries].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(`${entry.path}:${entry.sha256}\n`);
  }
  return hash.digest('hex');
}

/**
 * Builds the parity section of the manifest.
 *
 * Everything in here is a pure function of repository content, so the Android
 * and iOS branches must produce byte-identical output once synchronized. That
 * property is what makes a single committed manifest a cross-branch gate rather
 * than a per-branch snapshot. Provenance (timestamp, Git SHA) is deliberately
 * kept OUT of this section — it necessarily differs per branch and would
 * otherwise make the two manifests permanently unequal.
 */
function buildParity(repoRoot, functionNames = GOVERNED_FUNCTIONS) {
  const functions = functionNames.map((functionName) => {
    const { localFiles, remoteSpecifiers } = resolveBundle(repoRoot, functionName);
    const bundleSet = new Set(localFiles);

    const directoryFiles = listFilesRecursively(repoRoot, path.join(FUNCTIONS_ROOT, functionName));
    const treePaths = [...new Set([...directoryFiles, ...localFiles])].sort();

    const files = treePaths.map((relativePath) => ({
      path: relativePath,
      sha256: sha256OfFile(path.join(repoRoot, relativePath)),
      bundle: bundleSet.has(relativePath),
    }));

    return {
      name: functionName,
      entry: `${FUNCTIONS_ROOT.split(path.sep).join('/')}/${functionName}/index.ts`,
      remoteSpecifiers,
      bundleFileCount: files.filter((file) => file.bundle).length,
      treeFileCount: files.length,
      bundleHash: aggregateHash(files.filter((file) => file.bundle)),
      treeHash: aggregateHash(files),
      files,
    };
  });

  return {
    manifestVersion: MANIFEST_VERSION,
    // The artifact inventory is identical for every environment: the same
    // source deploys to staging and to production. Environment identity is
    // deliberately NOT part of this section.
    environmentScope: 'ENVIRONMENT_NEUTRAL',
    deployAuthority: DEPLOY_AUTHORITY,
    expectedFunctions: [...functionNames].sort(),
    functions,
  };
}

/**
 * Resolves which environment this checkout targets, from `supabase/config.toml`.
 *
 * Fail-closed by construction: a missing config, an unparseable project_id, or
 * a ref that is not one of the two known projects all resolve to `ok: false`.
 * There is no default and no fallback — a checkout that cannot prove its
 * environment is never treated as either one.
 *
 * @returns {{ok: boolean, ref: string|null, environment: 'staging'|'production'|null, code: string|null}}
 */
function resolveCheckoutEnvironment(repoRoot) {
  const ref = readProjectRef(repoRoot);
  if (ref === null) {
    return { ok: false, ref: null, environment: null, code: 'MISSING_ENVIRONMENT_IDENTITY' };
  }
  try {
    return { ok: true, ref, environment: resolveEnvironment(ref), code: null };
  } catch (error) {
    return { ok: false, ref, environment: null, code: error.code || 'UNKNOWN_PROJECT' };
  }
}

/** Stable serialization: the gate compares text, so key order must be fixed. */
function serializeManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

module.exports = {
  // `APPROVED_PROJECT_REF` is deliberately NOT exported any more: its name
  // implied a single canonical environment for every consumer, which is what
  // let a production deploy-target claim leak into an environment-neutral
  // artifact gate. Consumers now ask for the environment they mean.
  DEPLOY_AUTHORITY,
  LEGACY_V1_APPROVED_PROJECT_REF,
  PRODUCTION_REF,
  STAGING_REF,
  CONFIG_RELATIVE_PATH,
  FUNCTIONS_ROOT,
  GOVERNED_FUNCTIONS,
  MANIFEST_VERSION,
  aggregateHash,
  buildParity,
  listFilesRecursively,
  readProjectRef,
  resolveBundle,
  resolveCheckoutEnvironment,
  serializeManifest,
  sha256OfFile,
  toPosix,
};
