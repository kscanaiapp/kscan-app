// Regression guard for owner-authorized Nov 6, 2026 Staging and Production applications.
// The exact SQL was applied once per environment under versions assigned by the
// Supabase deployment API. No migration history or SQL was rewritten.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const manifest = require(path.join(root, 'config/migration-authority-manifest.json'));
const remote = '20261106164732';
const local = '20261106120000';

test('B41 Staging and Production exact-content aliases prevent replay', () => {
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
  assert.equal(production.knownPending.some(e => e.localVersion === local), false);
  const prod = production.reconciled.filter(e => e.localVersion === local);
  assert.equal(prod.length, 1);
  assert.equal(prod[0].classification, 'EXACT_CONTENT_RENUMBER');
  assert.deepEqual(prod[0].remoteVersions, ['20261106171646']);
  assert.equal(production.remoteOnly.some(e => e.remoteVersion === '20261106171646'), false);
  assert.ok(fs.existsSync(path.join(root, 'supabase/migrations', local + '_kplus_sandbox_review_access.sql')));
});
