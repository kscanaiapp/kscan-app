#!/usr/bin/env node
'use strict';

/**
 * Section 8.2 mechanical non-mutation guardrail.
 *
 * Fails (exit 1) if any file changed relative to a base ref matches a
 * PROTECTED prefix in protected-paths.json and is not covered by an
 * ALLOWED_EXCEPTIONS entry or an ALWAYS_ALLOWED_PREFIXES prefix.
 *
 * This is a mechanical check, not a substitute for review: it only proves
 * the diff's file *paths* stay outside production/runtime territory. It
 * cannot verify semantic safety of what changed inside kscan-live-vto/.
 *
 * Usage:
 *   node kscan-live-vto/tools/validate-protected-paths.js [baseRef]
 *
 * baseRef defaults to $PROTECTED_PATH_BASE_REF, then origin/master, then
 * the current branch's merge-base with master.
 */

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim();
const CONFIG_PATH = path.join(__dirname, 'protected-paths.json');
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

function resolveBaseRef() {
  const explicit = process.argv[2] || process.env.PROTECTED_PATH_BASE_REF;
  if (explicit) return explicit;

  try {
    execFileSync('git', ['rev-parse', '--verify', 'origin/master'], { stdio: 'ignore' });
    return execFileSync('git', ['merge-base', 'HEAD', 'origin/master']).toString().trim();
  } catch (_) {
    // origin/master unavailable (e.g. shallow clone / offline run) — fall
    // back to comparing against the previous commit so the script still
    // does something useful locally.
    return 'HEAD~1';
  }
}

function changedFiles(baseRef) {
  const tracked = execFileSync('git', ['diff', '--name-only', `${baseRef}...HEAD`])
    .toString()
    .split('\n')
    .filter(Boolean);

  const staged = execFileSync('git', ['diff', '--name-only', '--cached'])
    .toString()
    .split('\n')
    .filter(Boolean);

  const unstaged = execFileSync('git', ['diff', '--name-only'])
    .toString()
    .split('\n')
    .filter(Boolean);

  const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'])
    .toString()
    .split('\n')
    .filter(Boolean);

  return Array.from(new Set([...tracked, ...staged, ...unstaged, ...untracked]));
}

function matchesPrefix(file, prefix) {
  if (prefix.endsWith('/')) return file === prefix.slice(0, -1) || file.startsWith(prefix);
  return file === prefix;
}

function isAlwaysAllowed(file) {
  return config.ALWAYS_ALLOWED_PREFIXES.some((p) => matchesPrefix(file, p));
}

function isExplicitException(file) {
  return config.ALLOWED_EXCEPTIONS.includes(file);
}

function isProtected(file) {
  return config.PROTECTED.some((p) => matchesPrefix(file, p));
}

/**
 * The single decision this guardrail makes about one path, exposed so it can
 * be exercised with SYNTHETIC path input rather than only through a real git
 * diff.
 *
 * This matters because protection here is PREFIX-based, not
 * existence-based. The current VTO authority lives on
 * integration/backend-kplus-complimentary-staging-v1, whose history shares
 * NO common ancestor with master (`git merge-base` exits 1). Six of the
 * seven VTO authority paths therefore do not exist on the master baseline
 * this branch diffs against. A reader could reasonably assume that means
 * they are unprotected. They are not: `components/vto/...` is blocked by the
 * `components/` prefix whether or not that file exists on any branch, and
 * tests/guardrail/protectedPathSemantics.test.js pins exactly that.
 */
function classifyPath(file) {
  if (isAlwaysAllowed(file)) return 'allowed:workspace';
  if (isExplicitException(file)) return 'allowed:exception';
  if (isProtected(file)) return 'blocked';
  return 'allowed:unprotected';
}

function main() {
  const baseRef = resolveBaseRef();
  const files = changedFiles(baseRef);

  const violations = files.filter((file) => {
    if (isAlwaysAllowed(file)) return false;
    if (isExplicitException(file)) return false;
    return isProtected(file);
  });

  console.log(`[protected-paths] base ref: ${baseRef}`);
  console.log(`[protected-paths] files checked: ${files.length}`);

  if (violations.length > 0) {
    console.error('\n[protected-paths] FAIL — changes touch protected production/runtime paths:\n');
    for (const v of violations) console.error(`  - ${v}`);
    console.error(
      '\nThe isolated Live VTO research program (Section 1/8 of the build plan) is not ' +
      'authorized to modify these paths. If this is a legitimate, reviewed exception, add ' +
      'it to ALLOWED_EXCEPTIONS in kscan-live-vto/tools/protected-paths.json with a comment ' +
      'explaining why, in a commit a human has explicitly approved.'
    );
    process.exit(1);
  }

  console.log('[protected-paths] PASS — no protected paths touched.');
}

if (require.main === module) {
  main();
}

module.exports = { classifyPath, isProtected, isAlwaysAllowed, isExplicitException, matchesPrefix, config };
