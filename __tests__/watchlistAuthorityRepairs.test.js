// Lane B — Smart Watchlist authority repairs.
//   SEC-KPLUS-001  push-token ownership survives an actor boundary
//   INT-KPLUS-005  the Home entry derives from feature availability, not K+ alone
//   INT-KPLUS-008  manual refresh claims atomically instead of merely selecting

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CLAIM_DEVICE_SQL = read(
  'supabase', 'migrations', '20260831120000_watchlist_device_ownership_claim.sql',
);
const CLAIM_REFRESH_SQL = read(
  'supabase', 'migrations', '20260831120500_claim_user_commerce_watches_for_refresh.sql',
);
const EDGE = read('supabase', 'functions', 'commerce-watch-refresh', 'index.ts');
const PUSH_CLIENT = read('services', 'watchlist', 'pushRegistration.ts');
const AUTH_CTX = read('contexts', 'AuthSessionContext.tsx');
const HOME = read('components', 'home', 'HomeLuxuryTechV1.tsx');
const FLAGS = read('constants', 'featureFlags.ts');

// ── SEC-KPLUS-001 ────────────────────────────────────────────────────────────

test('claim_device_for_actor retires every OTHER actor live route on the device', () => {
  assert.match(CLAIM_DEVICE_SQL, /create or replace function public\.claim_device_for_actor/);
  assert.match(CLAIM_DEVICE_SQL, /set revoked_at = now\(\)/);
  assert.match(CLAIM_DEVICE_SQL, /where revoked_at is null/);
  assert.match(CLAIM_DEVICE_SQL, /and device_id = p_device_id/);
  assert.match(
    CLAIM_DEVICE_SQL,
    /and user_id <> p_user_id/,
    'must retire OTHER actors, and must not touch this actor own registration',
  );
});

test('claim_device_for_actor is service_role only, like every other push RPC', () => {
  assert.match(
    CLAIM_DEVICE_SQL,
    /revoke all on function public\.claim_device_for_actor\(uuid, text\) from public, anon, authenticated;/,
  );
  assert.match(
    CLAIM_DEVICE_SQL,
    /grant execute on function public\.claim_device_for_actor\(uuid, text\) to service_role;/,
  );
});

test('the claim is scoped by DEVICE, never by push token, so it cannot revoke this actor other devices', () => {
  const body = CLAIM_DEVICE_SQL.slice(CLAIM_DEVICE_SQL.indexOf('update public.user_device_push_tokens'));
  // NB: the TABLE name user_device_push_tokens contains the substring
  // "push_token", so match the column/parameter usage specifically.
  assert.doesNotMatch(
    body.slice(0, body.indexOf('get diagnostics')),
    /(?:^|\s)push_token\s*=|p_push_token/,
    'claiming physical custody must key on device_id alone',
  );
});

test('the claim reports how many routes it retired, so a failure is observable', () => {
  assert.match(CLAIM_DEVICE_SQL, /returns integer/);
  assert.match(CLAIM_DEVICE_SQL, /get diagnostics retired_count = row_count;/);
  assert.match(EDGE, /watchlist_device_claim_retired_foreign_routes/);
  assert.match(EDGE, /watchlist_device_claim_failed/);
});

test('the Edge function exposes claim_device and routes it to the RPC', () => {
  assert.match(EDGE, /case 'claim_device':/);
  assert.match(EDGE, /rpc\('claim_device_for_actor'/);
  // Identity comes from the verified JWT, never the body.
  assert.match(EDGE, /p_user_id: authUser\.id,\s*\n\s*p_device_id: deviceId,/);
});

test('the client claims on an ARRIVING actor, not only on a departing one', () => {
  assert.match(PUSH_CLIENT, /export async function claimDeviceForCurrentActor/);
  assert.match(PUSH_CLIENT, /action: 'claim_device'/);
  assert.match(AUTH_CTX, /claimDeviceForCurrentActor\(\)/);
  // It must sit on the actor-boundary path, next to the runtime reset.
  const resetIdx = AUTH_CTX.indexOf('resetActorScopedRuntimeState(usableSession?.user.id ?? null)');
  const claimIdx = AUTH_CTX.indexOf('claimDeviceForCurrentActor()');
  assert.ok(resetIdx > 0 && claimIdx > resetIdx, 'the claim must run on the actor boundary');
});

test('the claim never mints a device id and never blocks sign-in', () => {
  const fn = PUSH_CLIENT.slice(
    PUSH_CLIENT.indexOf('export async function claimDeviceForCurrentActor'),
    PUSH_CLIENT.indexOf('DEF-WL-01 (hostile-audit repair)'),
  );
  assert.match(fn, /readDeviceId\(\)/, 'must read, not create');
  assert.doesNotMatch(fn, /getOrCreateDeviceId/, 'a device that never registered has no route');
  assert.match(fn, /try \{/);
  assert.match(fn, /\} catch \{/);
});

test('the previously-shipped DEF-WL-01 server invariants are preserved', () => {
  const prior = read('supabase', 'migrations', '20260830190000_watchlist_push_token_actor_isolation.sql');
  assert.match(prior, /user_device_push_tokens_live_token_uidx/);
  assert.match(prior, /register_device_push_token/);
  // The new claim is additive: it must not redefine the registration RPC.
  assert.doesNotMatch(CLAIM_DEVICE_SQL, /function public\.register_device_push_token/);
  assert.match(PUSH_CLIENT, /export async function revokeWatchAlertsForThisDevice/);
});

// ── INT-KPLUS-008 ────────────────────────────────────────────────────────────

test('manual refresh CLAIMS its rows instead of selecting them', () => {
  assert.match(EDGE, /rpc\('claim_user_commerce_watches_for_refresh'/);
  const handler = EDGE.slice(
    EDGE.indexOf('async function handleRefresh'),
    EDGE.indexOf('async function handleRegisterPushToken'),
  );
  assert.doesNotMatch(
    handler,
    /buildDueWatchPath/,
    'the plain staleness SELECT is not mutual exclusion and must not remain on this path',
  );
});

test('the Tier 1 claim uses the same atomic mechanic as the Tier 2 sweep', () => {
  // Stamp-as-claim under SKIP LOCKED is what makes the loser of a race do no
  // provider work.
  assert.match(CLAIM_REFRESH_SQL, /set last_checked_at = now\(\)/);
  assert.match(CLAIM_REFRESH_SQL, /for update skip locked/);
  const worker = read('supabase', 'migrations', '20260830162500_claim_watchable_commerce_watches.sql');
  assert.match(worker, /for update skip locked/);
  assert.match(worker, /set last_checked_at = now\(\)/);
});

test('the Tier 1 claim is owner-scoped and re-checks K+ at claim time', () => {
  assert.match(CLAIM_REFRESH_SQL, /where user_id = p_user_id/);
  assert.match(CLAIM_REFRESH_SQL, /public\.kplus_has_active_entitlement\(p_user_id, 'k_plus'\)/);
  assert.match(CLAIM_REFRESH_SQL, /and status = 'active'/);
  assert.match(CLAIM_REFRESH_SQL, /and deleted_at is null/);
});

test('the Tier 1 claim preserves existing staleness protection', () => {
  assert.match(CLAIM_REFRESH_SQL, /p_min_interval_ms/);
  assert.match(
    CLAIM_REFRESH_SQL,
    /last_checked_at is null or last_checked_at < now\(\) - make_interval/,
  );
  assert.match(EDGE, /p_min_interval_ms: MIN_REFRESH_INTERVAL_MS/);
});

test('Tier 1 deliberately does NOT inherit the buy_under/push_enabled narrowing', () => {
  // A user may refresh a passive "just watching" Watch; the background loop
  // correctly ignores it (§55). This is the one place the two RPCs differ.
  assert.doesNotMatch(CLAIM_REFRESH_SQL, /watch_intent = 'buy_under'/);
  assert.doesNotMatch(CLAIM_REFRESH_SQL, /push_enabled = true/);
  const worker = read('supabase', 'migrations', '20260830162500_claim_watchable_commerce_watches.sql');
  assert.match(worker, /watch_intent = 'buy_under'/);
});

test('the Tier 1 claim is service_role only', () => {
  assert.match(CLAIM_REFRESH_SQL, /revoke all on function public\.claim_user_commerce_watches_for_refresh/);
  assert.match(CLAIM_REFRESH_SQL, /grant execute on function public\.claim_user_commerce_watches_for_refresh\(uuid, uuid, int, bigint\) to service_role;/);
});

// ── INT-KPLUS-005 ────────────────────────────────────────────────────────────

function loadFlags(env) {
  const source = read('constants', 'featureFlags.ts');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = { exports: {} };
  const sandbox = {
    console,
    exports: mod.exports,
    module: mod,
    process: { env },
    // React Native global, present at runtime but not in a bare vm context.
    __DEV__: false,
    require: () => ({}),
  };
  vm.createContext(sandbox);
  new vm.Script(output, { filename: 'featureFlags.ts' }).runInContext(sandbox);
  return mod.exports;
}

test('SMART_WATCHLIST_V1 is opt-in by environment, like the other V1 flags', () => {
  assert.equal(loadFlags({ EXPO_PUBLIC_SMART_WATCHLIST_V1: 'true' }).SMART_WATCHLIST_V1, true);
  for (const value of [undefined, '', 'false', '1', 'TRUE', 'yes']) {
    assert.equal(
      loadFlags({ EXPO_PUBLIC_SMART_WATCHLIST_V1: value }).SMART_WATCHLIST_V1,
      false,
      `${JSON.stringify(value)} must not enable the feature`,
    );
  }
});

test('the Home entry gates on availability, not on K+ entitlement alone', () => {
  assert.match(HOME, /const watchlistEnabled = SMART_WATCHLIST_V1;/);
  assert.match(HOME, /\{watchlistEnabled && \(/);
  // The availability gate must WRAP the entitlement gate, not sit inside it:
  // an unavailable feature shows no entry at all, rather than an upgrade prompt
  // for something that does not exist here.
  const gateIdx = HOME.indexOf('{watchlistEnabled && (');
  const kplusIdx = HOME.indexOf('<KPlusGate source="home_tile">');
  assert.ok(gateIdx > 0 && kplusIdx > gateIdx, 'availability must gate outside K+');
});

test('K+ entitlement still governs the entry when the feature IS available', () => {
  assert.match(HOME, /isActive \? router\.push\('\/watchlist'\) : openUpgrade\(\)/);
});

test('the flag helper is exported for testing, matching the packing convention', () => {
  assert.match(FLAGS, /export function resolveSmartWatchlistEnabled/);
  assert.match(FLAGS, /export const SMART_WATCHLIST_V1 = resolveSmartWatchlistEnabled\(\);/);
});

// ── migrations are well-formed ───────────────────────────────────────────────

test('both new migrations are discoverable and ordered after the repairs they extend', () => {
  const files = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
  const claim = '20260831120000_watchlist_device_ownership_claim.sql';
  const refresh = '20260831120500_claim_user_commerce_watches_for_refresh.sql';
  assert.ok(files.includes(claim));
  assert.ok(files.includes(refresh));
  assert.ok(
    files.indexOf(claim) > files.indexOf('20260830190000_watchlist_push_token_actor_isolation.sql'),
  );
  assert.ok(
    files.indexOf(refresh) > files.indexOf('20260830162500_claim_watchable_commerce_watches.sql'),
  );
});
