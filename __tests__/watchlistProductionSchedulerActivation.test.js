// Build 35 Watchlist operational activation: a protected Production deploy
// environment cannot serve an unattended six-hour worker cadence. This test
// guards separate narrow automation authority without weakening manual gates.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const yaml = fs.readFileSync(path.resolve(__dirname, '../.github/workflows/watchlist-tier2-sweep-production.yml'), 'utf8');

test('scheduled Watchlist sweep uses a separate narrowly scoped automation environment', () => {
  assert.match(yaml, /schedule:\s*\n\s*- cron: '17 \*\/6 \* \* \*'/);
  assert.ok(yaml.includes("name: ${{ github.event_name == 'schedule' && 'watchlist-production-automation' || 'production' }}"));
  assert.match(yaml, /environment:\s*\n\s*name:/);
});

test('manual Production invocations retain reviewer gate and explicit confirmation', () => {
  assert.match(yaml, /inputs\.confirm == 'RUN-SWEEP'/);
  assert.ok(yaml.includes("|| 'production' }}"));
  assert.match(yaml, /workflow_dispatch:/);
});

test('worker invocation remains credential-scoped, exact-origin, and fail closed', () => {
  assert.match(yaml, /secrets\.WATCHLIST_WORKER_SECRET/);
  assert.match(yaml, /vars\.SUPABASE_PRODUCTION_FUNCTIONS_URL/);
  assert.match(yaml, /https:\/\/wyyuqfdxucjksghsmhry\.functions\.supabase\.co/);
  assert.match(yaml, /Preflight — refuse to run unconfigured/);
  assert.match(yaml, /if: steps\.preflight\.outputs\.configured == 'true'/);
  assert.match(yaml, /x-watchlist-worker-secret:/);
  assert.doesNotMatch(yaml, /SUPABASE_SERVICE_ROLE_KEY|SUPABASE_ACCESS_TOKEN|SUPABASE_DB_PASSWORD/);
});

test('a reviewer-gated manual run cannot starve the unattended schedule via a shared concurrency group', () => {
  // B35-GATE-01: one unapproved 'production' run held the single shared group,
  // so every later scheduled run stayed pending with zero jobs and was cancelled.
  const block = yaml.match(/^concurrency:\s*\n((?:[ \t]+.*\n)+)/m);
  assert.ok(block, 'workflow-level concurrency block must exist');
  const group = block[1].match(/group:\s*(.+)/);
  assert.ok(group, 'concurrency group must be declared');
  assert.equal(
    group[1].trim(),
    "watchlist-tier2-sweep-production-${{ github.event_name == 'schedule' && 'schedule' || 'manual' }}",
    'scheduled and manual runs must resolve to different concurrency groups',
  );
  assert.match(block[1], /cancel-in-progress:\s*false/, 'a running sweep must never be cancelled mid-flight');
  // Exactly one workflow-level group and no job-level group that could re-merge the paths.
  assert.equal((yaml.match(/^\s*group:/gm) || []).length, 1);
});

test('workflow never runs a migration or Edge Function deploy', () => {
  assert.doesNotMatch(yaml, /supabase functions deploy|supabase db push|apply-production-migration\.mjs/);
  assert.match(yaml, /\/commerce-watch-refresh/);
});
