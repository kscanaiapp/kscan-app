#!/usr/bin/env node
'use strict';

/**
 * Run the FashionCLIP retrieval lab's test suite.
 *
 * Discovery is done here in Node rather than delegated to a shell glob -
 * same reason tools/real-fashion-corpus/run-tests.js and
 * scripts/run-all-tests.js do it: a top-level shell `*` is non-recursive
 * and `**` is not portable across cmd.exe, PowerShell and bash.
 *
 *   node tools/fashion-match-quality/retrieval/run-tests.js
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// Discover recursively from the lab root so both `tests/` (the #402
// retrieval suite) and `rerank/tests/` (the visual re-ranker suite) are
// executed by one entry point - a runner that silently misses a whole
// subdirectory is the exact failure scripts/run-all-tests.js exists to avoid.
const ROOT = __dirname;

function discover(dir) {
  const found = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.test.js')) found.push(full);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return found;
}

function main() {
  const files = discover(ROOT);
  console.log('-'.repeat(64));
  console.log(`FASHIONCLIP RETRIEVAL + RE-RANK LAB: ${files.length} test file(s)`);
  for (const file of files) console.log(`  ${path.relative(process.cwd(), file)}`);
  console.log('-'.repeat(64));

  if (files.length === 0) {
    console.error('discovered NO test files - treating as failure, not success.');
    process.exit(1);
  }

  const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}

if (require.main === module) main();

module.exports = { discover };
