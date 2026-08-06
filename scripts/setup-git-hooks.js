#!/usr/bin/env node
'use strict';

/**
 * One reproducible installation command for the repo's local security
 * hooks: `npm run setup:hooks` (also runs automatically via the "prepare"
 * npm lifecycle script on `npm install`/`npm ci`, so this does not depend on
 * a developer remembering a manual step). Points git at the versioned
 * .githooks/ directory instead of the untracked, per-clone .git/hooks/.
 *
 * No-ops in CI (no working tree to protect, and CI runners are ephemeral).
 */

const { execFileSync } = require('node:child_process');

function main() {
  if (process.env.CI) {
    console.log('setup-git-hooks: CI environment detected, skipping.');
    return;
  }

  try {
    execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'inherit' });
    console.log('setup-git-hooks: git core.hooksPath set to .githooks');
  } catch (err) {
    console.warn(`setup-git-hooks: could not configure git hooks (${err.message}). Run manually: git config core.hooksPath .githooks`);
  }
}

main();
