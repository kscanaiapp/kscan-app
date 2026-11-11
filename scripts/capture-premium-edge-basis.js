#!/usr/bin/env node
/**
 * Records the DEPLOYED Production identity of one Premium Value Edge entry in
 * config/premium-capability-edge-basis.json (see EDGE_BASIS_RELATIVE_PATH in
 * scripts/premium-capability-fingerprint-lib.js).
 *
 * Input is a read-only download of the live bundle, ONE workdir per function
 * (functions that share files overwrite each other's _shared copies otherwise):
 *
 *   supabase functions download <slug> --project-ref wyyuqfdxucjksghsmhry --use-api --workdir <dir>
 *   node scripts/capture-premium-edge-basis.js --function <slug> --download <dir> \
 *     --basis <backend commit> --version <deployed version> --ezbr <deployed ezbr_sha256>
 *
 * It refuses unless EVERY deployed source file equals the named backend commit
 * byte-for-byte (CRLF-normalised), so a recorded basis can never describe code
 * Production is not running. Afterwards run `npm run generate:premium-fingerprints`.
 *
 * Exit codes: 0 recorded, 1 deployed bundle does not match the basis commit, 2 usage error.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const {
  EDGE_BASIS_RELATIVE_PATH, EDGE_BASIS_VERSION, REPO_ROOT, normalise, validateEdgeBasisEntry,
} = require('./premium-capability-fingerprint-lib.js');

const PRODUCTION_PROJECT_REF = 'wyyuqfdxucjksghsmhry';
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const isSource = (rel) => /\.(?:ts|tsx|js|mjs)$/.test(rel) && !/\.test\.(?:ts|tsx|js)$/.test(rel) && !rel.split('/').includes('__tests__');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function walk(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full, base) : [path.relative(base, full).split(path.sep).join('/')];
  });
}

function main() {
  const fn = arg('function'); const download = arg('download'); const basisArg = arg('basis');
  const version = Number(arg('version')); const ezbr = arg('ezbr'); const capturedAt = arg('captured-at') ?? new Date().toISOString();
  if (!fn || !download || !basisArg || !ezbr || !Number.isSafeInteger(version)) {
    console.error('usage: --function <slug> --download <workdir> --basis <commit> --version <n> --ezbr <sha256> [--captured-at <iso>]');
    return 2;
  }
  const git = (args) => execFileSync('git', ['-C', REPO_ROOT, ...args], { encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] });
  let basisCommit;
  try { basisCommit = git(['rev-parse', '--verify', `${basisArg}^{commit}`]).trim(); } catch { console.error(`basis commit not in this clone: ${basisArg}`); return 2; }
  const root = path.join(download, 'supabase', 'functions');
  if (!fs.existsSync(path.join(root, fn, 'index.ts'))) { console.error(`no downloaded entrypoint at ${root}/${fn}/index.ts`); return 2; }

  const files = [];
  const mismatched = [];
  for (const rel of walk(root).filter(isSource).sort()) {
    const repoPath = `supabase/functions/${rel}`;
    const deployed = normalise(fs.readFileSync(path.join(root, rel), 'utf8'));
    let atBasis = null;
    try { atBasis = normalise(git(['show', `${basisCommit}:${repoPath}`])); } catch { /* absent at basis */ }
    if (atBasis !== deployed) mismatched.push(repoPath);
    files.push({ path: repoPath, sha256: sha256(deployed) });
  }
  if (mismatched.length > 0) {
    console.error(`REFUSED: ${mismatched.length}/${files.length} deployed files differ from ${basisCommit}:`);
    mismatched.forEach((rel) => console.error(`  ${rel}`));
    return 1;
  }

  const entry = `supabase/functions/${fn}/index.ts`;
  const record = { function: fn, environment: 'production', projectRef: PRODUCTION_PROJECT_REF, basisCommit,
    deployedVersion: version, ezbrSha256: ezbr, capturedAt, files };
  validateEdgeBasisEntry(entry, record);

  const target = path.join(REPO_ROOT, EDGE_BASIS_RELATIVE_PATH);
  const doc = fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, 'utf8'))
    : { version: EDGE_BASIS_VERSION, purpose: '', entries: {} };
  doc.version = EDGE_BASIS_VERSION;
  doc.purpose = 'Deployed Production identity of each Premium Value Edge entry. Written only by '
    + 'scripts/capture-premium-edge-basis.js from a read-only download of the live bundle, after every '
    + 'deployed file matched basisCommit. deployedVersion is informational (secret writes bump versions '
    + 'without changing code); identity is the per-file hashes. Editing this file changes the Premium '
    + 'capability fingerprints and withdraws every proof bound to the old identity.';
  doc.entries = Object.fromEntries(Object.entries({ ...doc.entries, [entry]: record }).sort(([a], [b]) => a.localeCompare(b)));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`Recorded ${entry}: ${files.length} deployed files == ${basisCommit} (v${version}, ezbr ${ezbr.slice(0, 12)}…)`);
  return 0;
}

process.exitCode = main();
