// Build 35: scheduled catalog sync must not depend on human approval.
// These source checks do not establish credential provisioning or runtime success.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const yaml = fs.readFileSync(path.resolve(__dirname, '../.github/workflows/black-owned-catalog-sync.yml'), 'utf8').replace(/\r\n/g, '\n');

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

// Execute the exact Python validator shipped in the workflow. No HTTP/provider
// calls and no substitute implementation: this catches false-green responses.
function validateResponse(value, raw = false) {
  const block = yaml.match(/python3 - "\$\{BODY_FILE\}" <<'PY'\r?\n([\s\S]*?)^          PY\s*$/m);
  assert.ok(block, 'workflow response validator is present');
  const script = block[1].replace(/^          /gm, '');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-response-'));
  try {
    const file = path.join(dir, 'body.json');
    fs.writeFileSync(file, raw ? value : JSON.stringify(value));
    const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-', file], {
      input: script, encoding: 'utf8', shell: false,
    });
    assert.ifError(result.error);
    return result;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const emptyReport = { mode: 'catalog_sync', enabled: true, merchants: 0, succeeded: 0, failed: 0, skipped: 0, products: 0 };

test('actual scheduler validator accepts enabled-empty and kill-switch responses distinctly', () => {
  const enabled = validateResponse(emptyReport);
  assert.equal(enabled.status, 0, enabled.stderr);
  assert.doesNotMatch(enabled.stdout, /disabled/);
  const disabled = validateResponse({ ...emptyReport, enabled: false });
  assert.equal(disabled.status, 0, disabled.stderr);
  assert.match(disabled.stdout, /disabled; no inventory was refreshed/);
});

test('actual scheduler validator rejects malformed or missing-schema HTTP 200 bodies', () => {
  for (const value of [{ error: 'upstream_failure' }, {}, null, [], { ...emptyReport, mode: 'other' },
    { ...emptyReport, enabled: 'true' }, { ...emptyReport, merchants: true },
    { ...emptyReport, products: -1 }, { ...emptyReport, products: 0.5 },
    { ...emptyReport, succeeded: undefined }, { ...emptyReport, merchants: 26, skipped: 26 },
    { ...emptyReport, merchants: 1 }, { ...emptyReport, enabled: false, products: 1 }]) {
    assert.equal(validateResponse(value).status, 1, JSON.stringify(value));
  }
  const malformed = validateResponse('private-response-not-json', true);
  assert.equal(malformed.status, 1);
  assert.doesNotMatch(malformed.stdout + malformed.stderr, /private-response-not-json/);
});

test('actual scheduler validator rejects total failure and emits aggregate counts only', () => {
  assert.equal(validateResponse({ ...emptyReport, merchants: 1, failed: 1 }).status, 1);
  const partial = validateResponse({ ...emptyReport, merchants: 3, succeeded: 1, skipped: 1, failed: 1, products: 2,
    privateMerchantData: 'must-not-be-logged' });
  assert.equal(partial.status, 0, partial.stderr);
  assert.doesNotMatch(partial.stdout + partial.stderr, /must-not-be-logged|privateMerchantData/);
});
