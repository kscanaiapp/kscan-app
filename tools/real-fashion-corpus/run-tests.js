#!/usr/bin/env node
'use strict';

/**
 * Run this lane's test suite.
 *
 * Discovery is done here in Node rather than delegated to a shell glob, for the
 * same reason `scripts/run-all-tests.js` does it: a top-level shell `*` is
 * non-recursive and `**` is not portable across cmd.exe, PowerShell and bash,
 * so a shell glob silently under-reports on Windows.
 *
 * Prints the inventory a reviewer needs (files found / executed) so a green
 * exit cannot be mistaken for a suite that discovered nothing - a prior lane in
 * this repository recorded exactly that failure mode.
 *
 *   node tools/real-fashion-corpus/run-tests.js
 *   node tools/real-fashion-corpus/run-tests.js --fmql   # also run the inherited FMQL suite
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, 'tests');
const FMQL_ROOT = path.join(__dirname, '..', 'fashion-match-quality');

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

function run(label, files) {
  console.log('-'.repeat(64));
  console.log(`${label}: ${files.length} test file(s)`);
  for (const file of files) console.log(`  ${path.relative(process.cwd(), file)}`);
  console.log('-'.repeat(64));

  if (files.length === 0) {
    console.error(`${label}: discovered NO test files - treating as failure, not success.`);
    return 1;
  }

  const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
  return result.status ?? 1;
}

function main() {
  const includeFmql = process.argv.includes('--fmql');

  let status = run('REAL FASHION MATCH CORPUS', discover(ROOT));

  if (includeFmql) {
    // The inherited authority must stay green and unmodified (mission
    // section 29 / invariant 42.13).
    const fmqlStatus = run('FASHION MATCH QUALITY LAB (inherited)', discover(FMQL_ROOT));
    status = status || fmqlStatus;
  }

  process.exit(status);
}

if (require.main === module) main();

module.exports = { discover };
