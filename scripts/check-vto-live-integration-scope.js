#!/usr/bin/env node
/**
 * P3-C scope guard.
 *
 * WHY THIS EXISTS AND WHY IT IS NOT THE OLD PROTECTION MODEL. The Live VTO
 * research lanes (#291, #295) treated every production VTO path as immutable
 * and enforced that with a protected-paths validator. P3-C intentionally
 * changes that rule -- this lane IS authorized to modify the VTO client. The
 * wrong response to that is to delete the old protection; the right one is to
 * replace a blanket denial with a narrow, justified allow-list.
 *
 * So this guard fails when the branch's diff touches anything the integration
 * manifest does not authorize. The manifest is the single source: a path
 * becomes authorized by acquiring a table row WITH a reason and a source
 * authority, not by being appended to a list in a script.
 *
 * Usage:
 *   node scripts/check-vto-live-integration-scope.js [baseRef]
 *
 * Exit codes:
 *   0  every changed path is authorized (or the base ref could not be
 *      resolved, in which case it reports SKIPPED and says why -- a guard that
 *      silently reports success on an empty diff is worse than no guard)
 *   1  the diff reached outside the authorized boundary, or the manifest is
 *      unparseable / self-inconsistent
 */

'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST = path.join('docs', 'vto-live-integration-manifest.md');

const DEFAULT_BASE_REFS = [
  'origin/integration/backend-kplus-complimentary-staging-v1',
  'integration/backend-kplus-complimentary-staging-v1',
  // The manifest's own recorded base, so the guard still works in a checkout
  // that has the commit but not the branch ref.
  'f2ef091aae0f270a8b966dc03d7c18198070b42f',
];

/**
 * Reads the authorized-path table out of the manifest.
 *
 * A row is only authorized when it carries BOTH a reason and a source
 * authority. That is the whole control: appending a bare path to the table
 * does not widen the boundary, it fails the guard.
 */
function parseAuthorizedPatterns(markdown) {
  const patterns = [];
  const problems = [];
  const lines = markdown.split('\n');
  let inTable = false;

  for (const line of lines) {
    if (/^\|\s*AUTHORIZED PATH\s*\|/.test(line)) {
      inTable = true;
      continue;
    }
    if (!inTable) continue;
    if (!line.startsWith('|')) break;
    if (/^\|\s*-+\s*\|/.test(line)) continue;

    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 3) continue;

    const [rawPath, why, authority] = cells;
    const match = rawPath.match(/^`([^`]+)`$/);
    if (!match) {
      problems.push(`row path is not a single backtick-quoted path: ${rawPath}`);
      continue;
    }
    if (!why) problems.push(`${match[1]} has no WHY MUTATION IS REQUIRED`);
    if (!authority) problems.push(`${match[1]} has no SOURCE AUTHORITY`);
    patterns.push(match[1]);
  }

  return { patterns, problems };
}

/**
 * Deliberately tiny matcher: `**` means "this prefix and everything under it",
 * a trailing `*` means "this prefix", and anything else is an exact path.
 *
 * Not a general glob library, on purpose. A guard whose matching rules are
 * hard to reason about is a guard nobody can audit, and every pattern this
 * manifest needs is one of those three shapes.
 */
function matchesPattern(changedPath, pattern) {
  if (pattern.endsWith('/**')) {
    return changedPath.startsWith(pattern.slice(0, -2));
  }
  if (pattern.endsWith('*')) {
    return changedPath.startsWith(pattern.slice(0, -1));
  }
  return changedPath === pattern;
}

function classifyChangedPaths(changedPaths, patterns) {
  const authorized = [];
  const unauthorized = [];
  for (const changedPath of changedPaths) {
    if (patterns.some((pattern) => matchesPattern(changedPath, pattern))) {
      authorized.push(changedPath);
    } else {
      unauthorized.push(changedPath);
    }
  }
  return { authorized, unauthorized };
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

function resolveBaseRef(explicit) {
  const candidates = explicit ? [explicit] : DEFAULT_BASE_REFS;
  for (const candidate of candidates) {
    try {
      git(['rev-parse', '--verify', `${candidate}^{commit}`]);
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function main() {
  const markdownPath = path.join(ROOT, MANIFEST);
  if (!fs.existsSync(markdownPath)) {
    console.error(`FAIL: ${MANIFEST} is missing -- the authorized boundary is undefined.`);
    process.exit(1);
  }

  const { patterns, problems } = parseAuthorizedPatterns(fs.readFileSync(markdownPath, 'utf8'));
  if (problems.length > 0) {
    console.error('FAIL: the authorized-path table is incomplete:');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  if (patterns.length === 0) {
    console.error(`FAIL: ${MANIFEST} declares no authorized paths.`);
    process.exit(1);
  }

  const baseRef = resolveBaseRef(process.argv[2]);
  if (!baseRef) {
    // Explicit, not silent: an unrunnable guard must not read as a pass.
    console.log('SKIPPED: no base ref resolved (tried: ' + DEFAULT_BASE_REFS.join(', ') + ').');
    console.log('The manifest parsed cleanly with ' + patterns.length + ' authorized patterns.');
    console.log('Pass a base ref explicitly to run the diff check.');
    process.exit(0);
  }

  let changedPaths = [];
  try {
    const output = git(['diff', '--name-only', `${baseRef}...HEAD`]);
    changedPaths = output ? output.split('\n').filter(Boolean) : [];
  } catch (err) {
    console.error(`FAIL: could not diff against ${baseRef}: ${err.message}`);
    process.exit(1);
  }

  const { authorized, unauthorized } = classifyChangedPaths(changedPaths, patterns);

  console.log('─'.repeat(64));
  console.log(`Base ref:              ${baseRef}`);
  console.log(`Authorized patterns:   ${patterns.length}`);
  console.log(`Changed paths:         ${changedPaths.length}`);
  console.log(`Within boundary:       ${authorized.length}`);
  console.log(`Outside boundary:      ${unauthorized.length}`);
  console.log('─'.repeat(64));

  if (unauthorized.length > 0) {
    console.error('FAIL: this lane touched paths the integration manifest does not authorize:');
    for (const changedPath of unauthorized) console.error(`  - ${changedPath}`);
    console.error('');
    console.error(`Either revert them, or add a row to ${MANIFEST} with a real reason and`);
    console.error('source authority. Do not widen the boundary to make a diff pass.');
    process.exit(1);
  }

  console.log('PASS: every changed path is inside the authorized P3-C boundary.');
  process.exit(0);
}

module.exports = { parseAuthorizedPatterns, matchesPattern, classifyChangedPaths, MANIFEST };

if (require.main === module) main();
