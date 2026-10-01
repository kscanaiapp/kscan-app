const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

function workflow(name) {
  return fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', name), 'utf8');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\function assertFailClosedSweep(source, environment, variable, origin) {');
}

function assertFailClosedSweep(source, environment, variable, origin) {
  assert.match(source, /workflow_dispatch:/, 'manual dispatch must remain available');
  assert.match(source, /confirm:\n\s+description: Must be RUN-SWEEP/, 'manual dispatch must require confirmation');
  assert.match(source, /schedule:\n\s+- cron: '17 \*\/6 \* \* \*'/, 'cadence must remain six-hourly');
  assert.match(source, new RegExp(`environment: ${environment}`), 'workflow must bind its intended Environment');
  assert.ok(
    source.includes('FUNCTIONS_URL: ${{ vars.' + variable + ' }}'),
    'workflow must use its scoped Functions URL',
  );
  assert.match(source, new RegExp(origin.replace(/[.]/g, '\\.'), 'g'), 'workflow must require its exact Functions origin');
  assert.match(source, /\[ -n "\$\{WORKER_SECRET:-\}" \]\s+\|\|\s+MISSING=/, 'worker secret preflight must fail closed');
  assert.match(source, /x-watchlist-worker-secret: \$\{WORKER_SECRET\}/, 'worker request must authenticate with the governed header');
  assert.doesNotMatch(source, /echo[^\n]*WORKER_SECRET/, 'workflow must never log the worker secret');
}

test('staging Tier 2 sweep stays fail-closed and cannot target production', () => {
  const source = workflow('watchlist-tier2-sweep.yml');
  assertFailClosedSweep(source, 'staging', 'SUPABASE_STAGING_FUNCTIONS_URL', 'yzqjvdfgefveprobvvyw.functions.supabase.co');
  assert.doesNotMatch(source, /wyyuqfdxucjksghsmhry/, 'staging workflow must not target production');
});

test('production Tier 2 sweep is protected and cannot target staging', () => {
  const source = workflow('watchlist-tier2-sweep-production.yml');
  assertFailClosedSweep(source, 'production', 'SUPABASE_PRODUCTION_FUNCTIONS_URL', 'wyyuqfdxucjksghsmhry.functions.supabase.co');
  assert.doesNotMatch(source, /yzqjvdfgefveprobvvyw/, 'production workflow must not target staging');
});
