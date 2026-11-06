// Regression guard for the owner-authorized Nov 6, 2026 Staging application.
// The SQL was applied once, under the timestamp allocated by the deployment API;
// no migration history or SQL was rewritten. Production remains unapplied.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const manifest = require(path.join(root, 'config/migration-authority-manifest.json'));
const remote = '20261106164732';
const local = '20261106120000';

 test('B41 Staging exact-content alias does not authorize replay or Production application', () => {
  const environments = manifest.ledgerReconciliation.environments;
  const stage = environments.yzqjvdfgefveprobvvyw;
  const production = environments.wyyuqfdxucjksghsmhry;
  assert.ok(stage && production);
  const matches = stage.reconciled.filter(e => e.localVersion === local);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].classification, 'EXACT_CONTENT_RENUMBER');
  assert.deepEqual(matches[0].remoteVersions, [remote]);
  assert.equal(stage.knownPending.some(e => e.localVersion === local), false);
  assert.equal(stage.remoteOnly.some(e => e.remoteVersion === remote), false);
  assert.equal(production.reconciled.some(e => e.localVersion === local), false);
  assert.equal(production.knownPending.some(e => e.localVersion === local && e.disposition === 'KNOWN_FUTURE_UNAPPLIED'), true);
  assert.ok(fs.existsSync(path.join(root, 'supabase/migrations', local + '_kplus_sandbox_review_access.sql')));
});
