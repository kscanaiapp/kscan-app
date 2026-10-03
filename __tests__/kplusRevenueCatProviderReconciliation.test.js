// Build 35 Phase E source-level security and architecture controls.
// Runtime behavior is covered by the Deno matrix; these controls deliberately
// mutate each protection and prove the corresponding audit goes red.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const ENDPOINT = read('supabase', 'functions', 'kplus-revenuecat-pull-reconcile', 'index.ts');
const CLIENT = read('supabase', 'functions', '_shared', 'revenuecat', 'revenueCatProviderStateClient.ts');
const RECONCILER = read('supabase', 'functions', '_shared', 'revenuecat', 'revenueCatProviderReconciliation.ts');
const WEBHOOK = read('supabase', 'functions', '_shared', 'revenuecat', 'revenueCatWebhookHandler.ts');
const MIGRATION = read('supabase', 'migrations', '20261003195716_kplus_provider_pull_reconciliation.sql');
const CONFIG = read('supabase', 'config.toml');

function mutant(source, from, to) {
  assert.ok(source.includes(from), `missing mutation anchor: ${from}`);
  return source.replace(from, to);
}

function mutationTurnsRed(audit, source, from, to) {
  audit(source); // fixture/protection is present in the real source.
  assert.throws(() => audit(mutant(source, from, to)), /phase-e-control/);
}

test('NC-1 actor injection: request fields cannot select another actor (mutation proof)', () => {
  const audit = (source) => {
    assert.match(source, /Object\.keys\(input\)\.some\(\(key\) => key !== 'trigger' && key !== 'force'\)/, 'phase-e-control');
    assert.match(source, /new URL\(req\.url\)\.searchParams\.keys\(\)/, 'phase-e-control');
    assert.match(source, /reconcileRevenueCatProviderState\(user\.id,/, 'phase-e-control');
    assert.match(source, /p_user_id: user\.id/, 'phase-e-control');
  };
  mutationTurnsRed(audit, ENDPOINT, "key !== 'trigger' && key !== 'force'", "key !== 'trigger' && key !== 'force' && key !== 'userId'");
});

test('NC-2 unknown product: exact server classification gates every transition (mutation proof)', () => {
  const audit = (source) => {
    assert.match(source, /classifyKPlusProduct\(config\.classification, store, product\.storeIdentifier\)/, 'phase-e-control');
    assert.match(source, /if \(classified\.status !== 'classified'\)[\s\S]{0,260}continue;/, 'phase-e-control');
  };
  mutationTurnsRed(audit, RECONCILER, "classified.status !== 'classified'", "false");
});

test('NC-3 grant-family destruction: pull view and wrappers are store-family scoped (mutation proof)', () => {
  const audit = (source) => {
    assert.match(source, /g\.source in \('store_subscription', 'store_lifetime'\)/, 'phase-e-control');
    assert.doesNotMatch(source, /delete\s+from\s+public\.kplus_entitlement_grants/i, 'phase-e-control');
    assert.match(source, /public\.apply_kplus_provider_transition\(/, 'phase-e-control');
    assert.match(source, /public\.apply_kplus_provider_lifetime_transition\(/, 'phase-e-control');
  };
  mutationTurnsRed(audit, MIGRATION, "g.source in ('store_subscription', 'store_lifetime')", "g.source in ('store_subscription', 'store_lifetime', 'complimentary')");
});

test('NC-4 sandbox contamination: every provider page carries the explicit deployment environment (mutation proof)', () => {
  const audit = (source) => {
    assert.match(source, /url\.searchParams\.set\('environment', config\.environment\)/, 'phase-e-control');
    assert.match(source, /nextUrl\.searchParams\.set\('environment', config\.environment\)/, 'phase-e-control');
  };
  mutationTurnsRed(audit, CLIENT, "url.searchParams.set('environment', config.environment);", "// environment filter removed");
});

test('NC-5 stale reactivation: reversal evidence must be newer than the local watermark (mutation proof)', () => {
  const audit = (source) => {
    assert.match(source, /timestamp\(event\.occurredAt\) > watermark/, 'phase-e-control');
    assert.match(source, /localState === 'terminal'\) return 'event_required'/, 'phase-e-control');
  };
  mutationTurnsRed(audit, RECONCILER, "timestamp(event.occurredAt) > watermark", "true");
});

test('NC-6 client provider authority: response requires a canonical reread and contains no summary/access grant (mutation proof)', () => {
  const audit = (source) => {
    assert.match(source, /canonicalRefreshRequired: true/, 'phase-e-control');
    assert.doesNotMatch(source, /summary:\s*KPlusEntitlementSummary|access:\s*'k_plus'/, 'phase-e-control');
  };
  mutationTurnsRed(audit, RECONCILER, "canonicalRefreshRequired: true", "access: 'k_plus'");
});

test('NC-7 secret exposure: REST key remains a server-only name and is never logged (mutation proof)', () => {
  const combined = `${ENDPOINT}\n${CLIENT}`;
  const audit = (source) => {
    assert.match(source, /REVENUECAT_RECONCILE_SECRET_API_KEY/, 'phase-e-control');
    assert.doesNotMatch(source, /EXPO_PUBLIC_/, 'phase-e-control');
    assert.doesNotMatch(source, /logEvent\([^\n]+secretApiKey|deps\.log\([^\n]+secretApiKey/, 'phase-e-control');
  };
  mutationTurnsRed(audit, combined, 'REVENUECAT_RECONCILE_SECRET_API_KEY', 'EXPO_PUBLIC_REVENUECAT_SECRET_API_KEY');
});

test('NC-8 cross-user lifetime transfer: both customer identities must equal JWT actor (mutation proof)', () => {
  const audit = (source) => {
    assert.match(source, /resource\.customerId !== actorId \|\| resource\.originalCustomerId !== actorId/, 'phase-e-control');
    assert.match(source, /status: 'ownership_conflict'/, 'phase-e-control');
  };
  mutationTurnsRed(audit, RECONCILER, 'resource.customerId !== actorId || resource.originalCustomerId !== actorId', 'false');
});

test('webhook and pull use the same serialized provider transition wrapper', () => {
  assert.match(WEBHOOK, /KPLUS_RECONCILE_PROVIDER_TRANSITION_RPC/);
  assert.match(WEBHOOK, /KPLUS_RECONCILE_PROVIDER_LIFETIME_TRANSITION_RPC/);
  const lock = "pg_advisory_xact_lock(hashtextextended('kplus_entitlement:' || p_user_id::text, 0))";
  assert.equal(MIGRATION.split(lock).length - 1, 2, 'both wrapper families take the shared actor lock');
  assert.match(MIGRATION, /ambiguous_provider_grant_identity/);
});

test('pull endpoint is JWT-verified while the separately authenticated webhook remains non-JWT', () => {
  assert.match(CONFIG, /\[functions\.kplus-revenuecat-pull-reconcile\]\s*verify_jwt = true/);
  assert.match(CONFIG, /\[functions\.kplus-revenuecat-webhook\]\s*verify_jwt = false/);
});

test('product lookup strategy is embedded then cache then authoritative cache-miss lookup', () => {
  const embedded = CLIENT.indexOf('if (embedded?.resourceId === productResourceId)');
  const cache = CLIENT.indexOf('deps.getProductCache');
  const lookup = CLIENT.indexOf('/products/${encodeURIComponent(productResourceId)}');
  assert.ok(embedded >= 0 && cache > embedded && lookup > cache);
  assert.match(MIGRATION, /create table if not exists public\.kplus_revenuecat_product_cache/);
});

test('per-actor lease and configurable cooldown bound provider calls', () => {
  assert.match(ENDPOINT, /KPLUS_REVENUECAT_RECONCILE_COOLDOWN_SECONDS/);
  assert.match(ENDPOINT, /KPLUS_REVENUECAT_RECONCILE_LEASE_SECONDS/);
  assert.match(ENDPOINT, /claim_kplus_provider_reconciliation/);
  assert.match(MIGRATION, /kplus_provider_reconcile:' \|\| p_user_id::text \|\| ':' \|\| p_environment/);
  assert.match(MIGRATION, /'classification', 'in_flight'/);
  assert.match(MIGRATION, /not p_force and v_row\.cooldown_until/);
});
