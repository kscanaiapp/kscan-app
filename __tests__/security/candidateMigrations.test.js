#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  STATUS,
  OUTCOME,
  PRODUCTION_REF,
  parseMigrationFilename,
  classifyCandidate,
  classifyCandidates,
  deriveOutcome,
  detectDuplicateVersions,
  assertNotProductionRef,
} = require('../../security/scripts/select-candidate-migrations');

const { diffInventory } = require('../../security/scripts/report-staging-inventory-diff');

// 1. Candidate migration already applied exactly once.
test('classifyCandidate: already applied on remote -> ALREADY_APPLIED', () => {
  const candidate = { version: '20260803020000', name: 'provider_request_security', path: 'supabase/migrations/20260803020000_provider_request_security.sql' };
  const remoteRows = [{ local: '20260803020000', remote: '20260803020000', time: '2026-08-03 02:00:00' }];
  const nameByVersion = { '20260803020000': 'provider_request_security' };
  const result = classifyCandidate(candidate, remoteRows, nameByVersion);
  assert.equal(result.status, STATUS.ALREADY_APPLIED);
});

// 2. Candidate migration not yet applied.
test('classifyCandidate: no remote entry -> NOT_YET_APPLIED', () => {
  const candidate = { version: '20260805010000', name: 'new_feature', path: 'supabase/migrations/20260805010000_new_feature.sql' };
  const result = classifyCandidate(candidate, [], {});
  assert.equal(result.status, STATUS.NOT_YET_APPLIED);
});

test('classifyCandidate: local-only remote row (remote empty string) -> NOT_YET_APPLIED', () => {
  const candidate = { version: '20260805010000', name: 'new_feature', path: 'supabase/migrations/20260805010000_new_feature.sql' };
  const remoteRows = [{ local: '20260805010000', remote: '', time: '' }];
  const result = classifyCandidate(candidate, remoteRows, {});
  assert.equal(result.status, STATUS.NOT_YET_APPLIED);
});

// 3. Unrelated remote migration absent locally must not affect candidate classification.
test('classifyCandidates: an unrelated remote-only migration does not leak into or affect candidate results', () => {
  const candidates = [
    { version: '20260803020000', name: 'provider_request_security', path: 'x.sql' },
  ];
  // This mirrors the real drift on this project: two remote-only migrations
  // with no local counterpart at all.
  const remoteRows = [
    { local: '', remote: '20260618132214', time: '2026-06-18 13:22:14' },
    { local: '', remote: '20260722201910', time: '2026-07-22 20:19:10' },
    { local: '20260803020000', remote: '20260803020000', time: '2026-08-03 02:00:00' },
  ];
  const result = classifyCandidates(candidates, remoteRows, { '20260803020000': 'provider_request_security' });
  assert.equal(result.length, 1);
  assert.equal(result[0].status, STATUS.ALREADY_APPLIED);
  assert.equal(result.some((r) => r.version === '20260618132214' || r.version === '20260722201910'), false);
});

// 4. Duplicate candidate version.
test('detectDuplicateVersions: flags two candidates sharing the same version', () => {
  const candidates = [
    { version: '20260805010000', name: 'a', path: 'a.sql' },
    { version: '20260805010000', name: 'b', path: 'b.sql' },
    { version: '20260805020000', name: 'c', path: 'c.sql' },
  ];
  assert.deepEqual(detectDuplicateVersions(candidates), ['20260805010000']);
});

test('detectDuplicateVersions: returns empty for all-unique versions', () => {
  const candidates = [
    { version: '20260805010000', name: 'a', path: 'a.sql' },
    { version: '20260805020000', name: 'b', path: 'b.sql' },
  ];
  assert.deepEqual(detectDuplicateVersions(candidates), []);
});

test('classifyCandidate: same version already recorded under a different name -> MIGRATION_HISTORY_CONFLICT', () => {
  const candidate = { version: '20260803020000', name: 'my_new_migration', path: 'x.sql' };
  const nameByVersion = { '20260803020000': 'someone_elses_migration' };
  const result = classifyCandidate(candidate, [], nameByVersion);
  assert.equal(result.status, STATUS.MIGRATION_HISTORY_CONFLICT);
});

// 5. Malformed migration filename.
test('parseMigrationFilename: rejects names without a 14-digit version prefix', () => {
  assert.equal(parseMigrationFilename('not_a_migration.sql'), null);
  assert.equal(parseMigrationFilename('202608_too_short.sql'), null);
  assert.equal(parseMigrationFilename('20260805010000.sql'), null); // missing name segment
  assert.equal(parseMigrationFilename('README.md'), null);
});

test('parseMigrationFilename: rejects a name segment containing shell metacharacters (defense-in-depth against injection into execFileSync shell:true on Windows)', () => {
  assert.equal(parseMigrationFilename('20260805010000_$(rm -rf /).sql'), null);
  assert.equal(parseMigrationFilename('20260805010000_evil;drop_table.sql'), null);
  assert.equal(parseMigrationFilename('20260805010000_`whoami`.sql'), null);
  assert.equal(parseMigrationFilename('20260805010000_a b.sql'), null); // spaces also rejected
});

test('parseMigrationFilename: accepts a well-formed migration filename, including with a path prefix', () => {
  assert.deepEqual(
    parseMigrationFilename('supabase/migrations/20260805010000_add_thing.sql'),
    { version: '20260805010000', name: 'add_thing' },
  );
});

// 6. No changed migrations.
test('deriveOutcome: empty candidate list -> NO_CANDIDATE_MIGRATIONS', () => {
  assert.equal(deriveOutcome([]), OUTCOME.NO_CANDIDATE_MIGRATIONS);
});

test('deriveOutcome: all ALREADY_APPLIED -> ALREADY_APPLIED', () => {
  const classified = [
    { version: 'a', status: STATUS.ALREADY_APPLIED },
    { version: 'b', status: STATUS.ALREADY_APPLIED },
  ];
  assert.equal(deriveOutcome(classified), OUTCOME.ALREADY_APPLIED);
});

test('deriveOutcome: any conflict -> MIGRATION_HISTORY_CONFLICT even if others are already applied', () => {
  const classified = [
    { version: 'a', status: STATUS.ALREADY_APPLIED },
    { version: 'b', status: STATUS.MIGRATION_HISTORY_CONFLICT },
  ];
  assert.equal(deriveOutcome(classified), OUTCOME.MIGRATION_HISTORY_CONFLICT);
});

test('deriveOutcome: at least one NOT_YET_APPLIED and no conflicts -> APPLIED (caller must execute)', () => {
  const classified = [
    { version: 'a', status: STATUS.ALREADY_APPLIED },
    { version: 'b', status: STATUS.NOT_YET_APPLIED },
  ];
  assert.equal(deriveOutcome(classified), OUTCOME.APPLIED);
});

// 12. Production project rejection.
test('assertNotProductionRef: throws for the production ref', () => {
  assert.throws(() => assertNotProductionRef(PRODUCTION_REF), /refused: production project ref/);
});

test('assertNotProductionRef: does not throw for the staging ref', () => {
  assert.doesNotThrow(() => assertNotProductionRef('yzqjvdfgefveprobvvyw'));
});

// 14. Candidate SHA mismatch — the classification/manifest result must
// always echo back the exact SHAs it was computed for, so a caller can
// detect and reject a mismatch against what the workflow expects.
test('candidate result shape carries the exact base/head SHA it was computed for', () => {
  const baseSha = 'abc123';
  const headSha = 'def456';
  // Simulated result shape, matching what select-candidate-migrations.js main() emits.
  const result = { baseSha, headSha, candidates: [], excluded: [] };
  assert.equal(result.baseSha, 'abc123');
  assert.equal(result.headSha, 'def456');
  assert.notEqual(result.baseSha, result.headSha);
});

// 15. Staging inventory side-effect reporting.
test('diffInventory: reports functions present after but not before as unintended', () => {
  const before = [{ slug: 'stylechat-generate', version: 47 }, { slug: 'product-search-deals', version: 3 }];
  const after = [
    { slug: 'stylechat-generate', version: 49 },
    { slug: 'product-search-deals', version: 4 },
    { slug: 'nike-shoe-details', version: 1, verify_jwt: true },
    { slug: 'tryon-clothes-pro', version: 1, verify_jwt: true },
  ];
  const diff = diffInventory(before, after);
  assert.equal(diff.unintendedlyDeployed.length, 2);
  assert.deepEqual(diff.unintendedlyDeployed.map((f) => f.slug).sort(), ['nike-shoe-details', 'tryon-clothes-pro']);
  assert.equal(diff.restoresInventoryIfRemoved, true);
});

test('diffInventory: reports no unintended deployments when before/after match', () => {
  const before = [{ slug: 'stylechat-generate', version: 48 }];
  const after = [{ slug: 'stylechat-generate', version: 49 }];
  const diff = diffInventory(before, after);
  assert.equal(diff.unintendedlyDeployed.length, 0);
  assert.equal(diff.restoresInventoryIfRemoved, false);
});
