#!/usr/bin/env node
'use strict';

/**
 * Build 4 tracking and boundary guard (Phase 0C Lane D).
 *
 * THE HAZARD THIS GUARDS AGAINST
 *
 * `.git/info/exclude` contains a bare `tools/` rule, which blanket-ignores the
 * entire directory across every worktree of this repository. Files already
 * tracked under `tools/` were force-added previously, so they show as modified
 * normally — which is exactly what makes the hazard dangerous:
 *
 *   - a NEW file under tools/ does not appear in `git status`, not even with
 *     --untracked-files=all;
 *   - `git add <path>` silently skips it;
 *   - a clean `git status` therefore reads as "everything is committed" when
 *     harness work is in fact unstaged and unpushed.
 *
 * Staging under tools/ requires `git add -f`. This script is the backstop: it
 * compares what exists on disk in the authorized Build 4 paths against
 * `git ls-files`, and fails when an authorized file is untracked or ignored.
 *
 * It also enforces the path boundary in the other direction — that no Build 4
 * change has landed outside the four authorized roots.
 *
 * Read-only. Modifies nothing, and deliberately does NOT touch global or shared
 * Git configuration.
 *
 *   node tools/scanner-evaluation/check-build4-tracking.js
 *   node tools/scanner-evaluation/check-build4-tracking.js --base <sha>
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');

/** The only paths Build 4 may write to. */
const AUTHORIZED_ROOTS = Object.freeze([
  'evals/scanner-accuracy',
  'tools/scanner-evaluation',
  'experiments/scanner-accuracy-v2',
  'docs/scanner-accuracy',
]);

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function walk(dir, out = []) {
  const absolute = path.join(ROOT, dir);
  if (!fs.existsSync(absolute)) return out;
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const relative = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(relative, out);
    else out.push(relative);
  }
  return out;
}

/** Read the active exclude rules so the report names the actual hazard. */
function readExcludeRules() {
  let excludeFile;
  try {
    excludeFile = path.join(git(['rev-parse', '--git-common-dir']).trim(), 'info', 'exclude');
  } catch {
    return { path: null, rules: [] };
  }
  const resolved = path.isAbsolute(excludeFile) ? excludeFile : path.join(ROOT, excludeFile);
  if (!fs.existsSync(resolved)) return { path: resolved, rules: [] };
  const rules = fs
    .readFileSync(resolved, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  return { path: resolved, rules };
}

/** Which authorized roots are shadowed by an exclude rule. */
function shadowedRoots(rules) {
  return AUTHORIZED_ROOTS.filter((root) =>
    rules.some((rule) => {
      const bare = rule.replace(/\/$/, '');
      return root === bare || root.startsWith(`${bare}/`);
    })
  );
}

function main(argv = process.argv.slice(2)) {
  const baseIndex = argv.indexOf('--base');
  const base = baseIndex >= 0 ? argv[baseIndex + 1] : null;

  const tracked = new Set(git(['ls-files']).split('\n').filter(Boolean));
  const exclude = readExcludeRules();
  const shadowed = shadowedRoots(exclude.rules);

  const onDisk = AUTHORIZED_ROOTS.flatMap((root) => walk(root));
  const untracked = onDisk.filter((file) => !tracked.has(file));

  // Boundary in the other direction: nothing outside the authorized roots.
  let outsideBoundary = [];
  if (base) {
    const changed = git(['diff', '--name-only', `${base}..HEAD`]).split('\n').filter(Boolean);
    outsideBoundary = changed.filter(
      (file) => !AUTHORIZED_ROOTS.some((root) => file.startsWith(`${root}/`))
    );
  }

  const ok = untracked.length === 0 && outsideBoundary.length === 0;

  const report = {
    ok,
    excludeHazard: {
      excludeFile: exclude.path,
      rulesShadowingAuthorizedPaths: shadowed,
      hazardPresent: shadowed.length > 0,
      consequence:
        shadowed.length > 0
          ? `New files under ${shadowed.join(', ')} are invisible to git status and are silently skipped by a plain git add. Stage them with: git add -f <explicit paths>`
          : 'No authorized Build 4 path is shadowed by an exclude rule.',
      remediation:
        'Do NOT edit shared or global Git configuration to fix this — that is an owner decision. Use explicit forced staging and run this guard before every push.',
    },
    tracking: {
      authorizedRoots: AUTHORIZED_ROOTS,
      filesOnDisk: onDisk.length,
      untrackedCount: untracked.length,
      untracked,
    },
    boundary: base
      ? { base, outsideAuthorizedRoots: outsideBoundary, ok: outsideBoundary.length === 0 }
      : { base: null, note: 'pass --base <sha> to also check the path boundary' },
  };

  console.log(JSON.stringify(report, null, 2));
  if (!ok) process.exitCode = 1;
  return report;
}

if (require.main === module) main();

module.exports = { main, AUTHORIZED_ROOTS, readExcludeRules, shadowedRoots };
