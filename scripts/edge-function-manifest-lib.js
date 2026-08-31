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
 *
 * B34-DEF-001: this constant was inherited unchanged from the mobile
 * (Android) line, which deploys to production. That is wrong for THIS
 * branch: `rebuild/staging-v2-backend` exists specifically to be the
 * canonical staging backend authority (see
 * docs/staging-rebuild/backend-authority-manifest.md — "Working branch
 * rebuild/staging-v2-backend", "K Scan AI Staging in-place rebuild"), and
 * its own `supabase/config.toml` has always declared the staging project
 * ref. The two disagreeing is exactly the kind of cross-branch confusion
 * this gate exists to catch — it was simply never caught here because
 * nobody had run the gate on this branch since it diverged. Corrected to
 * match this branch's actual, documented, deliberate deploy target.
 * Production remains read-only and is never a deploy target from this
 * branch or any automation in this repository.
 */
const APPROVED_PROJECT_REF = 'yzqjvdfgefveprobvvyw';

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
 * B34-DEF-001 extended this from 3 to every function this branch's own tree
 * carries (excluding `_shared`, which is not itself a deployable function).
 * This branch is the documented canonical backend authority (see
 * docs/staging-rebuild/backend-authority-manifest.md); its whole purpose is
 * to be the complete composite, not just the image-identification loop, so
 * scoping its own gate down to 3 functions understated what it is meant to
 * cover. `stylist-speech`, `handle-user-deletion`, and
 * `process-account-deletions` are the three the Build 34 brief named as an
 * explicit minimum; the remainder were already deployed from real
 * committed source in this tree and had no reason to stay ungoverned.
 * `staging-health` is included because it is a real deployed function with
 * real source here, even though it is staging-only tooling never intended
 * for production.
 *
 * It is also required rather than optional: scripts/deploy-edge-functions.js
 * refuses to deploy any function absent from the manifest, so hosting the
 * versioned private Dressing Room contract here means governing it here.
 */
const GOVERNED_FUNCTIONS = [
  'scan-identify',
  'commerce-watch-refresh',
  'stylechat-generate',
  'style-outfit-generate',
  'stylist-speech',
  'handle-user-deletion',
  'process-account-deletions',
  'privacy-correction-request',
  'privacy-data-export',
  'restore-account',
  'resend-restoration-email',
  'kickscrew-sneaker-description',
  'kplus-activate',
  'kplus-reconcile-revenuecat',
  'nike-shoe-details',
  'product-search-deals',
  'search-vinted-secondhand',
  'shared-room-image-url',
  'tryon-clothes-pro',
  'staging-health',
  'vto-generate',
];

const FUNCTIONS_ROOT = path.join('supabase', 'functions');
const CONFIG_RELATIVE_PATH = path.join('supabase', 'config.toml');

/**
 * Matches `from '<spec>'`, `import '<spec>'` and `import('<spec>')`.
 *
 * B34-DEF-001: the capture groups exclude newlines (`[^'"\n]+`, not
 * `[^'"]+`). A real import/export specifier is always single-line, but the
 * bare `[^'"]+` form does not know that -- a TypeScript index-access type
 * like `['storage']['from']` contains the literal token `from` immediately
 * followed by a closing quote, which the old pattern read as the START of an
 * import specifier and then greedily consumed everything (including
 * newlines) up to the next unrelated quote character anywhere later in the
 * file. That produced a "specifier" that was actually several lines of
 * unrelated source, silently corrupting the manifest for
 * `process-account-deletions` and `shared-room-image-url` the moment they
 * were added to GOVERNED_FUNCTIONS. Restricting the match to one line makes
 * the false-positive fail to match at all (there is no real closing quote on
 * that line), instead of matching a huge, wrong pseudo-specifier.
 */
const SPECIFIER_PATTERNS = [
  /\bfrom\s*['"]([^'"\n]+)['"]/g,
  /\bimport\s*['"]([^'"\n]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  /\bexport\s*\*\s*from\s*['"]([^'"\n]+)['"]/g,
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

/**
 * Strips `/* *\/` block comments before specifier extraction runs.
 * B34-DEF-001: a JSDoc comment prose like `from "doesn't exist at all"`
 * contains the literal token `from` followed by a quote, then an apostrophe
 * a few characters later that SPECIFIER_PATTERNS reads as the closing quote
 * -- extracting "doesn" as a bogus specifier. Real import/export statements
 * are never themselves inside a block comment, so removing block-comment
 * text first (replaced with matching-length whitespace, so line numbers
 * anything downstream might report stay unaffected) is a safe, narrow way to
 * stop prose from being read as source.
 *
 * Deliberately does NOT strip `//` line comments: a real remote specifier is
 * routinely written as `'https://esm.sh/...'`, and a naive `//`-strip would
 * truncate that legitimate specifier at the scheme's own double slash.
 */
function stripBlockComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '));
}

function extractSpecifiers(source) {
  const withoutComments = stripBlockComments(source);
  const found = new Set();
  for (const pattern of SPECIFIER_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(withoutComments)) !== null) found.add(match[1]);
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
  extractSpecifiers,
  listFilesRecursively,
  readProjectRef,
  resolveBundle,
  serializeManifest,
  sha256OfFile,
  toPosix,
};
