const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

const WORKFLOW = read('.github', 'workflows', 'production-vto-testing-activation.yml');
const SCRIPT = read('scripts', 'activate-production-vto-testing.mjs');

test('VTO activation is manual-only and protected by the production Environment', () => {
  assert.match(WORKFLOW, /workflow_dispatch:/);
  assert.doesNotMatch(WORKFLOW, /^\s*schedule:/m);
  assert.match(WORKFLOW, /environment:\s*production/);
  assert.match(WORKFLOW, /ENABLE BUILD34 VTO LIVE TESTING/);
  assert.match(WORKFLOW, /rebuild\/backend-authority-v2/);
  assert.match(WORKFLOW, /Governed branch advanced while approval was pending/);
});

test('VTO activation targets only the canonical production project', () => {
  assert.match(WORKFLOW, /EXPECTED_PRODUCTION_REF:\s*wyyuqfdxucjksghsmhry/);
  assert.doesNotMatch(WORKFLOW, /yzqjvdfgefveprobvvyw/);
  assert.match(SCRIPT, /assertProductionTarget/);
  assert.match(SCRIPT, /PRODUCTION_PROJECT_REF/);
});

test('VTO activation requires the real provider credential name without exposing a value', () => {
  assert.match(WORKFLOW, /RAPIDAPI_KEY/);
  assert.match(WORKFLOW, /verified required production secret name: RAPIDAPI_KEY/);
  assert.doesNotMatch(WORKFLOW, /secrets\.RAPIDAPI_KEY/);
  assert.match(SCRIPT, /ailabtools_tryon_clothes_pro/);
});

test('VTO activation is config-only and leaves migrations/functions/schedulers alone', () => {
  assert.doesNotMatch(WORKFLOW, /functions\s+deploy|deploy-production-function|migration\s+repair|db\s+push/i);
  assert.doesNotMatch(SCRIPT, /migration\s+repair|db\s+push|truncate\s|drop\s+database|drop\s+schema/i);
  assert.match(SCRIPT, /migrationLedgerBefore/);
  assert.match(SCRIPT, /migrationLedgerAfter/);
  assert.match(SCRIPT, /Migration ledger changed during config-only activation/);
});

test('VTO activation keeps the dangerous background controls contained', () => {
  assert.match(SCRIPT, /watchlist_worker_enabled/);
  assert.match(SCRIPT, /watchlist_worker_enabled must exist and remain enabled=false/);
  assert.match(SCRIPT, /account_deletion_worker_enabled/);
  assert.match(SCRIPT, /account_deletion_worker_enabled must exist and remain enabled=false/);
  assert.match(SCRIPT, /orphan_media_destructive_mode/);
  assert.match(SCRIPT, /orphan_media_destructive_mode is enabled; refusing VTO activation/);
  assert.match(SCRIPT, /requireContainment\(before\)/);
  assert.match(SCRIPT, /requireContainment\(after\)/);
});

test('the only UPDATE is scoped to app_config.vto_generation', () => {
  const updates = SCRIPT.match(/update public\.app_config/gi) || [];
  assert.equal(updates.length, 1);
  assert.match(SCRIPT, /where key = 'vto_generation' returning key, value/);
  assert.doesNotMatch(SCRIPT, /update public\.user_|delete from|insert into/i);
  assert.match(SCRIPT, /provider.*ailabtools_tryon_clothes_pro/i);
  assert.match(SCRIPT, /enabled.*true/i);
});

test('activation is idempotent only for the exact governed provider posture', () => {
  assert.match(SCRIPT, /vtoBefore\.enabled === true && beforeProvider === EXPECTED_PROVIDER/);
  assert.match(SCRIPT, /VTO is already enabled with unexpected provider/);
  assert.match(SCRIPT, /VTO activation read-back does not match the governed live-testing posture/);
});
