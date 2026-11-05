'use strict';
// Build 35 shared repair — ONE Cloud Closet rollout authority.
//
// Before this repair the Closet card asked the dated runtime proof while the
// sync/migration/restore engines asked only flag + K+: an active member's
// Closet uploaded in the background while the card said "Cloud backup is
// currently unavailable". These tests pin (1) the authority's answer for every
// proof shape and (2) that every Cloud Closet path asks THIS authority and no
// path keeps a private copy of the rule.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function load(relative, modules = {}, env = {}) {
  const module = { exports: {} };
  const require = id => { if (!(id in modules)) throw new Error(`unmapped import: ${id}`); return modules[id]; };
  vm.runInNewContext(ts.transpileModule(read(relative), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText,
    { module, exports: module.exports, require, Date, URL, process: { env } });
  return module.exports;
}

const generated = load('services/kplus/kplusCapabilityFingerprints.generated.ts');
function loadAuthority(env = {}) {
  const proof = load('services/kplus/kplusCapabilityProof.ts', { './kplusCapabilityFingerprints.generated': generated }, env);
  return { proof, authority: load('services/closet/cloudClosetRolloutAuthority.ts', { '../kplus/kplusCapabilityProof': proof }) };
}

const OUT = 'a'.repeat(64);
const RES = 'b'.repeat(64);
const NOW = Date.parse('2026-11-05T12:00:00Z');
const record = (proofType, overrides = {}) => ({
  capability: 'cloud_closet', proofType, environment: 'production',
  implementationFingerprint: proofType === 'closet_outbound_sync' ? OUT : RES,
  status: 'PROVEN_RUNTIME', provenAt: '2026-11-05T00:00:00Z', expiresAt: '2026-11-12T00:00:00Z',
  evidenceRef: 'docs/audits/test-evidence.json', ...overrides,
});
const ctx = (records, overrides = {}) => ({
  environment: 'production',
  implementationFingerprints: { closet_outbound_sync: OUT, closet_cross_device_restore: RES },
  nowMs: NOW, records, ...overrides,
});

const { authority } = loadAuthority();

test('fresh outbound proof authorizes backup only; restore needs its own proof', () => {
  const outboundOnly = ctx([record('closet_outbound_sync')]);
  assert.equal(authority.isCloudClosetOutboundAuthorized(outboundOnly), true);
  assert.equal(authority.isCloudClosetRestoreAuthorized(outboundOnly), false, 'outbound evidence never transfers to restore');
  const both = ctx([record('closet_outbound_sync'), record('closet_cross_device_restore')]);
  assert.equal(authority.isCloudClosetOutboundAuthorized(both), true);
  assert.equal(authority.isCloudClosetRestoreAuthorized(both), true);
});

test('restore proof alone never authorizes restore (backup must be authorized too)', () => {
  const restoreOnly = ctx([record('closet_cross_device_restore')]);
  assert.equal(authority.isCloudClosetOutboundAuthorized(restoreOnly), false);
  assert.equal(authority.isCloudClosetRestoreAuthorized(restoreOnly), false);
});

test('expired, future-dated, wrong-environment, wrong-fingerprint and source-only proofs are withheld', () => {
  const cases = {
    expired: record('closet_outbound_sync', { provenAt: '2026-10-07T00:00:00Z', expiresAt: '2026-10-14T00:00:00Z' }),
    notYetValid: record('closet_outbound_sync', { provenAt: '2026-11-06T00:00:00Z' }),
    stagingRecordInProduction: record('closet_outbound_sync', { environment: 'staging' }),
    otherSourceFingerprint: record('closet_outbound_sync', { implementationFingerprint: 'c'.repeat(64) }),
    sourceOnly: record('closet_outbound_sync', { status: 'PROVEN_SOURCE_ONLY' }),
    noEvidence: record('closet_outbound_sync', { evidenceRef: ' ' }),
  };
  for (const [name, r] of Object.entries(cases)) {
    assert.equal(authority.isCloudClosetOutboundAuthorized(ctx([r])), false, name);
  }
  assert.equal(authority.isCloudClosetOutboundAuthorized(ctx([record('closet_outbound_sync')], { environment: undefined })), false, 'unknown environment');
});

test('a proof earned by another account-scope record type never authorizes Cloud Closet', () => {
  const foreign = record('closet_outbound_sync', { capability: 'smart_watchlist' });
  assert.equal(authority.isCloudClosetOutboundAuthorized(ctx([foreign])), false);
});

test('TODAY: the shipped ledger withholds Cloud Closet in Production AND Staging', () => {
  for (const host of ['wyyuqfdxucjksghsmhry', 'yzqjvdfgefveprobvvyw']) {
    const { proof, authority: live } = loadAuthority({ EXPO_PUBLIC_SUPABASE_URL: `https://${host}.supabase.co` });
    const today = { ...proof.capabilityProofContext(), nowMs: NOW };
    assert.equal(live.isCloudClosetOutboundAuthorized(today), false, host);
    assert.equal(live.isCloudClosetRestoreAuthorized(today), false, host);
  }
  const { authority: unknownEnv } = loadAuthority({});
  assert.equal(unknownEnv.isCloudClosetOutboundAuthorized(), false, 'unknown backend fails closed');
});

// ── Single authority: every path asks it, no path keeps a private rule ──────

test('every Cloud Closet path consults the shared rollout authority', () => {
  const sync = read('services/closet/closetSyncEngine.ts');
  const execute = sync.slice(sync.indexOf('async function executePass'));
  assert.match(sync, /from '\.\/cloudClosetRolloutAuthority'/);
  assert.match(execute, /isCloudClosetOutboundAuthorized\(\)/, 'automatic + manual outbound sync (all coordinator triggers run this pass)');
  assert.match(execute, /discovered\.filter\(isDeletionWork\)/, 'withheld passes run deletion work only');

  const migration = read('services/closet/closetHistoricalMigrationEngine.ts');
  assert.match(migration.slice(migration.indexOf('async function executeMigrationPass')),
    /if \(!isCloudClosetOutboundAuthorized\(\)\) return emptyMigrationResult\('rollout_withheld'\)/);

  const restore = read('services/closet/closetRestoreEngine.ts');
  const restorePass = restore.slice(restore.indexOf('async function executeRestorePass'));
  assert.match(restorePass, /if \(!isCloudClosetRestoreAuthorized\(\)\) return emptyRestoreResult\('rollout_withheld'\)/);
  assert.match(restorePass, /if \(!isCloudClosetRestoreAuthorized\(\)\) break;/, 'restore stops if proof expires mid-pass');

  const card = read('components/closet/CloudClosetCard.tsx');
  assert.match(card, /from '\.\.\/\.\.\/services\/closet\/cloudClosetRolloutAuthority'/);
  assert.match(card, /if \(!isCloudClosetOutboundAuthorized\(\)\) \{\n\s+return \(\n\s+<View style=\{styles\.card\} testID="cloud-closet-unavailable">/);
  assert.match(card, /if \(!isCloudClosetOutboundAuthorized\(\)\) return;/, 'retained manual CHECK revalidates');
});

test('no Closet path asks the proof module directly (one rule, one place)', () => {
  const dirs = ['services/closet', 'components/closet', 'hooks'];
  const offenders = [];
  for (const dir of dirs) {
    for (const name of fs.readdirSync(path.join(ROOT, dir))) {
      if (!/\.(ts|tsx|js)$/.test(name) || name === 'cloudClosetRolloutAuthority.ts') continue;
      const src = read(`${dir}/${name}`);
      if (/hasRuntimeCapabilityProof\(\s*'cloud_closet'/.test(src)) offenders.push(`${dir}/${name}`);
    }
  }
  assert.deepEqual(offenders, []);
});
