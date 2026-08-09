/**
 * GP-003 — every shipped source file must be valid UTF-8.
 *
 * services/reportAiOutput.ts carried a lone 0x97 byte (a Windows-1252 em dash
 * saved without conversion) inside the AI-output report subject line, so the
 * bundler decoded it as U+FFFD and the report a user files read
 * "K Scan AI <?> Report AI Output (StyleChat)".
 *
 * That is a Google-critical control's user-visible text, and the class of bug
 * is invisible in a diff, so this guards the whole shipped tree rather than
 * the one file that happened to have it.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');

const SCANNED_ROOTS = [
  'app',
  'components',
  'services',
  'hooks',
  'contexts',
  'constants',
  'config',
  'contracts',
  'stores',
  'src',
  'types',
  'plugins',
  'modules',
  'supabase/functions',
];

const SCANNED_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.json',
  '.sql',
  '.kt',
  '.swift',
]);

const SKIPPED_DIRECTORIES = new Set(['node_modules', 'build', '.git', '__snapshots__']);

function collectFiles(directory, out) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      collectFiles(full, out);
    } else if (SCANNED_EXTENSIONS.has(path.extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

test('GP-003: no shipped source file contains invalid UTF-8', () => {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const files = [];
  for (const root of SCANNED_ROOTS) {
    const absolute = path.join(ROOT, root);
    if (fs.existsSync(absolute)) collectFiles(absolute, files);
  }

  assert.ok(files.length > 500, `expected a substantial tree, scanned ${files.length}`);

  const invalid = [];
  for (const file of files) {
    try {
      decoder.decode(fs.readFileSync(file));
    } catch {
      invalid.push(path.relative(ROOT, file));
    }
  }

  assert.deepEqual(invalid, [], `invalid UTF-8 in: ${invalid.join(', ')}`);
});

test('GP-003: the AI reporting module contains no replacement characters', () => {
  const source = fs.readFileSync(path.join(ROOT, 'services/reportAiOutput.ts'), 'utf8');
  assert.ok(
    !source.includes('�'),
    'no replacement character may survive in the in-app reporting source',
  );
});
