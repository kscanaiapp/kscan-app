#!/usr/bin/env node
/**
 * Deterministic, portable full-suite test discovery.
 *
 * WHY THIS EXISTS: the previous full-suite invocation used a top-level shell
 * glob (`__tests__/*.test.js`). That pattern is non-recursive, so
 * `__tests__/glasses/mockGlassesService.test.js` was silently excluded and the
 * reported "full suite" total was short by one file. A shell `**` is not
 * portable across cmd.exe / PowerShell / bash, so discovery is done here in
 * Node instead of being delegated to the shell.
 *
 * Prints the inventory the release gates require:
 *   total files found / executed / excluded (+ reason for each exclusion)
 *
 * Usage:  node scripts/run-all-tests.js [rootDir]
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(process.argv[2] || '__tests__');
const TEST_SUFFIX = '.test.js';

/** Directories never executed as part of the suite, with an explicit reason. */
const EXCLUDED_DIRS = new Map([
  ['node_modules', 'third-party dependency tree'],
  ['__snapshots__', 'snapshot fixtures, not executable tests'],
  ['fixtures', 'static fixture data, not executable tests'],
]);

const found = [];
const excluded = [];

function walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    excluded.push({ file: dir, reason: `unreadable directory: ${err.code}` });
    return;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const reason = EXCLUDED_DIRS.get(entry.name);
      if (reason) {
        excluded.push({ file: path.relative(process.cwd(), full), reason });
        continue;
      }
      walk(full);
    } else if (entry.isFile() && entry.name.endsWith(TEST_SUFFIX)) {
      found.push(path.relative(process.cwd(), full));
    }
  }
}

if (!fs.existsSync(ROOT)) {
  console.error(`Test root not found: ${ROOT}`);
  process.exit(1);
}

walk(ROOT);

console.log('─'.repeat(64));
console.log(`Test root:            ${path.relative(process.cwd(), ROOT) || '.'}`);
console.log(`Total test files found:    ${found.length}`);
console.log(`Total test files excluded: ${excluded.length}`);
for (const item of excluded) {
  console.log(`  EXCLUDED ${item.file} — ${item.reason}`);
}
const nested = found.filter((file) => path.dirname(file) !== path.relative(process.cwd(), ROOT));
console.log(`Nested (sub-directory) test files: ${nested.length}`);
for (const file of nested) console.log(`  NESTED  ${file}`);
console.log(`Total test files to execute: ${found.length}`);
console.log('─'.repeat(64));

if (found.length === 0) {
  console.error('No test files discovered — refusing to report a passing suite.');
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...found], {
  stdio: 'inherit',
  env: process.env,
});

process.exit(result.status == null ? 1 : result.status);
