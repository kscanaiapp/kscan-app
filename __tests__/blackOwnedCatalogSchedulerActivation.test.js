// Build 35: scheduled catalog sync must not depend on human approval.
// These source checks do not establish credential provisioning or runtime success.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const yaml = fs.readFileSync(path.resolve(__dirname, '../.github/workflows/black-owned-catalog-sync.yml'), 'utf8');

test('scheduled Production uses a separate automation Environment', () => {
  assert.match(yaml, /schedule:\s*\n\s*- cron: '41 \*\/6 \* \* \*'/);
  assert.ok(yaml.includes("environment: ${{ github.event_name == 'schedule' && matrix.target == 'production' && 'catalog-production-automation' || matrix.target }}"));
  assert.doesNotMatch(yaml, /^\s*environment:\s*\$\{\{ matrix\.target \}\}\s*$/m);
});

test('manual Production retains its protected Environment and explicit confirmation', () => {
  assert.match(yaml, /workflow_dispatch:/);
  assert.match(yaml, /inputs\.confirm == 'RUN-CATALOG-SYNC'/);
  assert.match(yaml, /github\.event_name == 'schedule'.*\|\| matrix\.target/);
});

test('worker requires worker-only secret and exact Functions origin', () => {
  assert.match(yaml, /secrets\.DISCOVERY_CATALOG_WORKER_SECRET/);
  assert.match(yaml, /vars\.SUPABASE_PRODUCTION_FUNCTIONS_URL/);
  assert.match(yaml, /vars\.SUPABASE_STAGING_FUNCTIONS_URL/);
  assert.match(yaml, /https:\/\/yzqjvdfgefveprobvvyw\.functions\.supabase\.co/);
  assert.match(yaml, /https:\/\/wyyuqfdxucjksghsmhry\.functions\.supabase\.co/);
  assert.match(yaml, /Preflight — refuse to run unconfigured/);
  assert.match(yaml, /if: steps\.preflight\.outputs\.configured == 'true'/);
  assert.match(yaml, /x-discovery-worker-secret/);
  assert.doesNotMatch(yaml, /SUPABASE_SERVICE_ROLE_KEY|SUPABASE_DB_PASSWORD|SUPABASE_ACCESS_TOKEN/);
});

test('manual approval cannot starve scheduled work via shared concurrency', () => {
  const block = yaml.match(/^concurrency:\s*\n((?:[ \t]+.*\n)+)/m);
  assert.ok(block, 'workflow-level concurrency block');
  assert.match(block[1], /github\.event_name == 'workflow_dispatch' && inputs\.target \|\| 'scheduled'/);
  assert.match(block[1], /cancel-in-progress:\s*false/);
  assert.equal((yaml.match(/^\s*group:/gm) || []).length, 1);
});

test('scheduler does not deploy, rotate secrets or change Production schema', () => {
  assert.doesNotMatch(yaml, /supabase functions deploy|supabase db push|supabase secrets set|gh secret set/);
  assert.match(yaml, /\/black-owned-catalog-sync/);
});
