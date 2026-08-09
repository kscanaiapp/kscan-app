#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const INCLUDED_PREFIXES = [
  'android/', 'ios/', 'app/', 'assets/', 'components/', 'config/', 'constants/',
  'contexts/', 'contracts/', 'data/', 'hooks/', 'lib/', 'modules/', 'server/',
  'services/', 'src/', 'stores/', 'supabase/functions/', 'supabase/migrations/', 'types/',
];
const INCLUDED_FILES = new Set([
  '.easignore', '.easignore.txt', '.env.example', '.env.e2e.example',
  'app.js', 'app.json', 'index.js', 'eas.json', 'metro.config.js',
  'package.json', 'package-lock.json', 'Procfile', 'render.yaml', 'server.js',
  'store.config.json', 'tsconfig.json', 'supabase/config.toml',
]);
const INCLUDED_ROOT_PATTERNS = [/^app\.config\.(?:js|ts|mjs|cjs)$/];

function isIncluded(file) {
  const normalized = String(file).replace(/\\/g, '/');
  return INCLUDED_FILES.has(normalized)
    || INCLUDED_ROOT_PATTERNS.some((pattern) => pattern.test(normalized))
    || INCLUDED_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function computeFromEntries(entries) {
  const included = entries.filter((entry) => isIncluded(entry.path)).sort((a, b) => a.path.localeCompare(b.path));
  const serialized = included.map((entry) => `${entry.mode} ${entry.type} ${entry.object}\t${entry.path}`).join('\n');
  return {
    model: 'RUNTIME_RELEASE_TREE',
    digest_algorithm: 'sha256',
    digest: crypto.createHash('sha256').update(`${serialized}\n`).digest('hex'),
    file_count: included.length,
    files: included.map((entry) => entry.path),
  };
}

function entriesForRef(ref) {
  const output = execFileSync('git', ['ls-tree', '-r', '-z', ref], { encoding: 'buffer', maxBuffer: 128 * 1024 * 1024 });
  return output.toString('utf8').split('\0').filter(Boolean).map((line) => {
    const match = line.match(/^(\d+)\s+(\S+)\s+([0-9a-f]+)\t(.+)$/);
    if (!match) throw new Error(`Unable to parse git ls-tree entry: ${line}`);
    return { mode: match[1], type: match[2], object: match[3], path: match[4] };
  });
}

function main() {
  const args = process.argv.slice(2);
  const refIndex = args.indexOf('--ref');
  const ref = refIndex === -1 ? null : args[refIndex + 1];
  const json = args.includes('--json');
  if (!ref) throw new Error('Usage: --ref <commit-or-tree> [--json]');
  const report = { ref, ...computeFromEntries(entriesForRef(ref)) };
  process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : `${report.digest}\n`);
}

if (require.main === module) main();
module.exports = { isIncluded, computeFromEntries, entriesForRef, INCLUDED_PREFIXES, INCLUDED_FILES };
