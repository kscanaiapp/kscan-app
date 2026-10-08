'use strict';

/**
 * Governed source fingerprints for Premium Value runtime proofs.
 *
 * A runtime proof is evidence about ONE implementation. This module defines, per
 * proof type, which source files establish the proven behaviour and hashes them
 * into a single immutable identity. `services/kplus/kplusCapabilityProof.ts`
 * only honours a proof record whose `implementationFingerprint` equals the
 * identity of the code that is actually shipping, so changing governed source
 * silently withdraws the claim until fresh runtime evidence is recorded.
 *
 * The identity is hashed from file CONTENT (CRLF-normalised), never from a
 * commit SHA: a record committed in the same change as the code it proves could
 * never name its own commit, and every unrelated commit would otherwise
 * invalidate it.
 *
 * The device cannot read its own source, so the current identities are written
 * to `services/kplus/kplusCapabilityFingerprints.generated.ts` by
 * `scripts/generate-premium-capability-fingerprints.js` and a test proves that
 * file equals the real source.
 *
 * What is NOT covered: npm:/jsr:/https: dependency versions (pinned elsewhere),
 * the deployed Edge Function binary (a deploy is verified by source parity, not
 * by this hash), and presentation-only UI that the proof harness never loaded.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const FINGERPRINT_VERSION = 'kscan-premium-capability-fingerprint-v1';
const WATCH_CREATE_MIGRATION = 'supabase/migrations/20260830190500_watchlist_create_honours_changed_intent.sql';

/**
 * `files` and `dirs` are client/DB sources listed explicitly. `edgeEntries` are
 * Edge Function entrypoints whose local import closure is the deployable unit:
 * a function is one deploy artifact, so the Packing branch of
 * `stylechat-generate` cannot be separated from its router. Over-invalidation is
 * the fail-closed direction; a shared-file edit costs a re-proof, never a lie.
 *
 * Hooks and screens are deliberately absent: the harness drove the real clients
 * and deployed functions directly (`nativeAppCertified: false`), so UI code did
 * not earn these proofs. Proof types with no domain (worker behaviour, push)
 * have no identity and therefore can never be authorized.
 */
const DOMAINS = Object.freeze({
  packing_generation_and_refinement: Object.freeze({
    files: ['types/packing.ts'],
    dirs: ['services/packing'],
    edgeEntries: ['supabase/functions/stylechat-generate/index.ts'],
  }),
  watch_tracking: Object.freeze({
    files: ['types/watchlist.ts', 'services/watchlist/watchlistClient.ts',
      'services/watchlist/watchlistAvailability.ts', WATCH_CREATE_MIGRATION],
    dirs: [],
    edgeEntries: ['supabase/functions/commerce-watch-refresh/index.ts'],
  }),
  watch_provider_entitlement_boundary: Object.freeze({
    files: [WATCH_CREATE_MIGRATION],
    dirs: [],
    edgeEntries: ['supabase/functions/commerce-watch-refresh/index.ts'],
  }),
  closet_outbound_sync: Object.freeze({
    files: ['services/closet/closetCloudStatus.ts', 'services/closet/closetFactsSync.ts',
      'services/closet/closetSyncContract.ts', 'services/closet/closetSyncEngine.ts'],
    dirs: [],
    edgeEntries: [],
  }),
  closet_cross_device_restore: Object.freeze({
    files: ['services/closet/closetCloudStatus.ts', 'services/closet/closetFactsSync.ts',
      'services/closet/closetRestoreEngine.ts', 'services/closet/closetSyncContract.ts'],
    dirs: [],
    edgeEntries: [],
  }),
});

const normalise = (text) => text.replace(/\r\n/g, '\n');
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const isTestFile = (rel) => /\.test\.(?:ts|tsx|js)$/.test(rel) || rel.split('/').includes('__tests__');

/** Reader over the working tree. `read` returns null when the file is absent. */
function fsReader(root = REPO_ROOT) {
  return {
    read(rel) {
      try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return null; }
    },
    list(dir) {
      const out = [];
      const walk = (current) => {
        let entries = [];
        try { entries = fs.readdirSync(path.join(root, current), { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
          const rel = `${current}/${entry.name}`;
          if (entry.isDirectory()) walk(rel); else out.push(rel);
        }
      };
      walk(dir);
      return out.sort();
    },
  };
}

/** Reader over an immutable git revision, for recomputing a historical identity. */
function gitReader(rev, root = REPO_ROOT) {
  const git = (args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  return {
    read(rel) {
      try { return git(['show', `${rev}:${rel}`]); } catch { return null; }
    },
    list(dir) {
      try { return git(['ls-tree', '-r', '--name-only', rev, '--', dir]).split('\n').filter(Boolean).sort(); } catch { return []; }
    },
  };
}

/** In-memory reader. A test uses this to mutate one governed file. */
function memoryReader(files) {
  return {
    read: (rel) => (Object.prototype.hasOwnProperty.call(files, rel) ? files[rel] : null),
    list: (dir) => Object.keys(files).filter((rel) => rel.startsWith(`${dir}/`)).sort(),
  };
}

const IMPORT_PATTERN = /\b(?:import|export)\b[^'"`;]*?\bfrom\s*['"](\.{1,2}\/[^'"]+)['"]|\bimport\s*['"](\.{1,2}\/[^'"]+)['"]|\bimport\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;

function localImports(source) {
  const found = [];
  for (const match of source.matchAll(IMPORT_PATTERN)) found.push(match[1] ?? match[2] ?? match[3]);
  return found;
}

function edgeClosure(entry, reader) {
  const seen = new Set();
  const pending = [entry];
  while (pending.length > 0) {
    const rel = pending.pop();
    if (seen.has(rel)) continue;
    const source = reader.read(rel);
    if (source === null) throw new Error(`Governed Edge source is missing: ${rel}`);
    seen.add(rel);
    if (!/\.(?:ts|tsx|js|mjs)$/.test(rel)) continue;
    for (const specifier of localImports(source)) {
      pending.push(path.posix.normalize(path.posix.join(path.posix.dirname(rel), specifier)));
    }
  }
  return [...seen].filter((rel) => !isTestFile(rel));
}

function governedFiles(domainName, reader) {
  const domain = DOMAINS[domainName];
  if (!domain) throw new Error(`No fingerprint domain for proof type: ${domainName}`);
  const files = new Set(domain.files);
  for (const dir of domain.dirs) {
    const listed = reader.list(dir).filter((rel) => /\.(?:ts|tsx)$/.test(rel) && !isTestFile(rel));
    if (listed.length === 0) throw new Error(`Governed directory is empty or missing: ${dir}`);
    listed.forEach((rel) => files.add(rel));
  }
  for (const entry of domain.edgeEntries) edgeClosure(entry, reader).forEach((rel) => files.add(rel));
  return [...files].sort();
}

function computeFingerprint(domainName, reader = fsReader()) {
  const lines = governedFiles(domainName, reader).map((rel) => {
    const source = reader.read(rel);
    if (source === null) throw new Error(`Governed source is missing: ${rel}`);
    return { path: rel, sha256: sha256(normalise(source)) };
  });
  const body = `${FINGERPRINT_VERSION}\n${domainName}\n${lines.map((l) => `${l.path}\t${l.sha256}\n`).join('')}`;
  return { fingerprint: sha256(body), files: lines };
}

function computeAllFingerprints(reader = fsReader()) {
  return Object.fromEntries(Object.keys(DOMAINS).sort().map((name) => [name, computeFingerprint(name, reader).fingerprint]));
}

const GENERATED_RELATIVE_PATH = 'services/kplus/kplusCapabilityFingerprints.generated.ts';

function renderGeneratedModule(fingerprints) {
  const body = Object.entries(fingerprints).map(([name, value]) => `  ${name}: '${value}',`).join('\n');
  return [
    '// GENERATED FILE - do not edit by hand.',
    '// Regenerate with `npm run generate:premium-fingerprints` after an intentional change to',
    '// governed source. `__tests__/premiumCapabilityFingerprint.test.js` fails while this file',
    '// and the real source disagree. A changed identity withdraws every proof record bound to',
    '// the old one until fresh runtime evidence is recorded in kplusCapabilityProof.ts.',
    '// Definitions: scripts/premium-capability-fingerprint-lib.js',
    'export const CURRENT_IMPLEMENTATION_FINGERPRINTS: Readonly<Record<string, string>> = Object.freeze({',
    body,
    '});',
    '',
  ].join('\n');
}

module.exports = {
  DOMAINS, FINGERPRINT_VERSION, GENERATED_RELATIVE_PATH, REPO_ROOT,
  computeAllFingerprints, computeFingerprint, edgeClosure, fsReader, gitReader,
  governedFiles, localImports, memoryReader, normalise, renderGeneratedModule,
};
