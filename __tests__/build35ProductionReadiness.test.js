const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

test('Build 35 production ledger snapshot has no unexplained migration drift', async () => {
  const { compareMigrations } = await import('../scripts/staging-deploy-preflight.mjs');
  const { listLocalMigrationVersions } = await import('../scripts/lib/staging-helpers.mjs');
  const { loadLedgerReconciliation } = await import('../scripts/lib/migration-reconciliation.mjs');
  const snapshot = require('../docs/audits/build35-production-ledger-2026-10-04.json');
  const versions = snapshot.migrations.map(row => row.version);
  const authority = loadLedgerReconciliation(snapshot.projectRef);
  const report = compareMigrations(listLocalMigrationVersions(), versions, '', authority);
  console.error('BUILD35_LEDGER_DIAGNOSTIC', JSON.stringify({ blockers: report.blockers, unexplainedLocal: report.unexplainedLocal, unexplainedRemote: report.unexplainedRemote, knownPending: authority.knownPending?.map((row) => row.localVersion) ?? [] }));
  assert.equal(report.ok, true, JSON.stringify(report.blockers));
  assert.deepEqual(report.unexplainedLocal, []);
  assert.deepEqual(report.unexplainedRemote, []);
  assert.equal(report.approvedSelectedForExecution, 0);
  // Negative control: an undeclared ledger row must still block deployment.
  const corrupt = compareMigrations(listLocalMigrationVersions(), [...versions, '20990101000000'], '', authority);
  assert.equal(corrupt.ok, false);
  assert.ok(corrupt.unexplainedRemote.includes('20990101000000'));
});

test('both reconciliation functions use deterministic UUID selection, never min(uuid)', () => {
  const sql = fs.readFileSync(path.join(root, 'supabase/migrations/20261004231628_fix_kplus_reconciliation_uuid_selection.sql'), 'utf8');
  assert.equal((sql.match(/create or replace function/gi) || []).length, 2);
  assert.equal((sql.match(/array_agg\(g\.id order by g\.id\)/g) || []).length, 2);
  assert.doesNotMatch(sql, /count\(\*\),\s*min\(g\.id\)/i);
});
