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

/**
 * DEPLOYED EDGE IDENTITY. Production does not run this repository's
 * `supabase/functions` copy: every function is deployed from the backend
 * authority, and two functions that bundle the same file can run DIFFERENT
 * versions of it (stylechat-generate and commerce-watch-refresh both bundle
 * scan-identify/shoppingProvider.ts, at different authority commits). One
 * working-tree copy therefore cannot describe both, and hashing it would bind a
 * Production proof to code Production does not run.
 *
 * So when EDGE_BASIS_RELATIVE_PATH exists, an Edge entry's identity is the
 * recorded per-file hashes of the bundle actually deployed to Production
 * (captured by `scripts/capture-premium-edge-basis.js`, which refuses unless
 * every deployed file equals the named backend commit). Client and database
 * files still hash from this tree. The basis file itself is a governed input:
 * editing it changes the identity and withdraws every proof bound to the old
 * one. A revision WITHOUT the file (every historical proof commit) keeps the
 * original working-copy method, so recorded identities stay reproducible.
 */
const EDGE_BASIS_RELATIVE_PATH = 'config/premium-capability-edge-basis.json';
const EDGE_BASIS_VERSION = 'kscan-premium-edge-basis-v1';
const PRODUCTION_PROJECT_REF = 'wyyuqfdxucjksghsmhry';
const HEX64 = /^[0-9a-f]{64}$/;
const HEX40 = /^[0-9a-f]{40}$/;

function validateEdgeBasisEntry(entry, basis) {
  const fail = (why) => { throw new Error(`Edge basis for ${entry} is invalid: ${why}`); };
  if (!/^supabase\/functions\/[a-z0-9-]+\/index\.ts$/.test(entry)) fail('the key must be a function entrypoint');
  if (!basis || typeof basis !== 'object') fail('missing record');
  if (basis.function !== entry.split('/')[2]) fail('function does not match the entrypoint');
  if (basis.environment !== 'production' || basis.projectRef !== PRODUCTION_PROJECT_REF) fail('must describe the Production deployment');
  if (!HEX40.test(basis.basisCommit ?? '')) fail('basisCommit must be a full backend commit SHA');
  if (!HEX64.test(basis.ezbrSha256 ?? '')) fail('ezbrSha256 must be the deployed bundle hash');
  if (!Number.isSafeInteger(basis.deployedVersion) || basis.deployedVersion <= 0) fail('deployedVersion must be a positive integer');
  if (!Number.isFinite(Date.parse(basis.capturedAt ?? ''))) fail('capturedAt must be a timestamp');
  if (!Array.isArray(basis.files) || basis.files.length === 0) fail('files must list the deployed bundle');
  const seen = new Set();
  for (const file of basis.files) {
    const rel = file && file.path;
    if (typeof rel !== 'string' || !rel.startsWith('supabase/functions/') || rel.split('/').includes('..') || isTestFile(rel)) fail(`invalid file path ${rel}`);
    if (!HEX64.test(file.sha256 ?? '')) fail(`invalid hash for ${rel}`);
    if (seen.has(rel)) fail(`duplicate file ${rel}`);
    seen.add(rel);
  }
  if (!seen.has(entry)) fail('the deployed files must include the entrypoint');
}

/** The parsed basis, or null on a revision that predates it. Malformed fails closed. */
function loadEdgeBasis(reader) {
  const raw = reader.read(EDGE_BASIS_RELATIVE_PATH);
  if (raw === null) return null;
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error(`${EDGE_BASIS_RELATIVE_PATH} is not valid JSON`); }
  if (!parsed || parsed.version !== EDGE_BASIS_VERSION || !parsed.entries || typeof parsed.entries !== 'object' || Array.isArray(parsed.entries)) {
    throw new Error(`${EDGE_BASIS_RELATIVE_PATH} must be ${EDGE_BASIS_VERSION} with an entries object`);
  }
  for (const [entry, basis] of Object.entries(parsed.entries)) validateEdgeBasisEntry(entry, basis);
  return parsed;
}

function domainFor(domainName) {
  const domain = DOMAINS[domainName];
  if (!domain) throw new Error(`No fingerprint domain for proof type: ${domainName}`);
  return domain;
}

function clientFiles(domain, reader) {
  const files = new Set(domain.files);
  for (const dir of domain.dirs) {
    const listed = reader.list(dir).filter((rel) => /\.(?:ts|tsx)$/.test(rel) && !isTestFile(rel));
    if (listed.length === 0) throw new Error(`Governed directory is empty or missing: ${dir}`);
    listed.forEach((rel) => files.add(rel));
  }
  return files;
}

function recordedEdgeBasis(entry, basisDoc) {
  const basis = basisDoc.entries[entry];
  if (!basis) throw new Error(`No deployed Edge basis is recorded for ${entry} in ${EDGE_BASIS_RELATIVE_PATH}`);
  return basis;
}

/** Edge files that define a domain: the recorded deployed bundle, or (legacy) the working-copy closure. */
function edgeFiles(domainName, reader) {
  const domain = domainFor(domainName);
  const basisDoc = loadEdgeBasis(reader);
  const files = new Set();
  for (const entry of domain.edgeEntries) {
    if (basisDoc) recordedEdgeBasis(entry, basisDoc).files.forEach((file) => files.add(file.path));
    else edgeClosure(entry, reader).forEach((rel) => files.add(rel));
  }
  return [...files].sort();
}

/** Files whose CONTENT this tree must supply: client sources, plus the basis file or the legacy closure. */
function governedFiles(domainName, reader) {
  const domain = domainFor(domainName);
  const files = clientFiles(domain, reader);
  if (domain.edgeEntries.length > 0) {
    if (loadEdgeBasis(reader)) files.add(EDGE_BASIS_RELATIVE_PATH);
    else edgeFiles(domainName, reader).forEach((rel) => files.add(rel));
  }
  return [...files].sort();
}

function computeFingerprint(domainName, reader = fsReader()) {
  const domain = domainFor(domainName);
  const basisDoc = loadEdgeBasis(reader);
  const hashes = new Map();
  const readHash = (rel) => {
    const source = reader.read(rel);
    if (source === null) throw new Error(`Governed source is missing: ${rel}`);
    return sha256(normalise(source));
  };
  for (const rel of clientFiles(domain, reader)) hashes.set(rel, readHash(rel));
  for (const entry of domain.edgeEntries) {
    if (basisDoc) for (const file of recordedEdgeBasis(entry, basisDoc).files) hashes.set(file.path, file.sha256);
    else for (const rel of edgeClosure(entry, reader)) hashes.set(rel, readHash(rel));
  }
  const lines = [...hashes.keys()].sort().map((rel) => ({ path: rel, sha256: hashes.get(rel) }));
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
  DOMAINS, EDGE_BASIS_RELATIVE_PATH, EDGE_BASIS_VERSION, FINGERPRINT_VERSION, GENERATED_RELATIVE_PATH, REPO_ROOT,
  computeAllFingerprints, computeFingerprint, edgeClosure, edgeFiles, fsReader, gitReader, loadEdgeBasis,
  governedFiles, localImports, memoryReader, normalise, renderGeneratedModule, validateEdgeBasisEntry,
};
