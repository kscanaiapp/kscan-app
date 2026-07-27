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

/** Bumped only when the manifest shape changes in a way consumers must notice. */
const MANIFEST_VERSION = 'edge-function-manifest-v1';

/**
 * The Supabase project the canonical trees are allowed to be deployed to.
 * Recorded from `supabase/config.toml` on the canonical (Android) line and
 * re-asserted by the gate, so a deploy from a checkout linked to a different
 * project reference fails before it can reach an unintended backend.
 */
const APPROVED_PROJECT_REF = 'wyyuqfdxucjksghsmhry';

/**
 * Functions whose source is governed by this gate.
 *
 * Deliberately scoped to the image-identification loop that Phase 2A audited
 * and Phase 2A.5 is clearing. Other Edge Functions (notably the account
 * -lifecycle family) also differ between the branches; that divergence is
 * reported by `scripts/check-edge-function-parity.js --report-ungoverned` and
 * is an explicit owner decision, not something this phase silently rewrites.
 */
const GOVERNED_FUNCTIONS = ['scan-identify', 'stylechat-generate'];

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
    approvedProjectRef: APPROVED_PROJECT_REF,
    expectedFunctions: [...functionNames].sort(),
    functions,
  };
}

/** Stable serialization: the gate compares text, so key order must be fixed. */
function serializeManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

module.exports = {
  APPROVED_PROJECT_REF,
  CONFIG_RELATIVE_PATH,
  FUNCTIONS_ROOT,
  GOVERNED_FUNCTIONS,
  MANIFEST_VERSION,
  aggregateHash,
  buildParity,
  listFilesRecursively,
  readProjectRef,
  resolveBundle,
  serializeManifest,
  sha256OfFile,
  toPosix,
};
