/**
 * K Scan AI -- K+ entitlement authority (K+ Paywall Program, Phase 1).
 *
 * Static and contract controls for the migration and the two typed contracts
 * (server: supabase/functions/_shared/kplus/kplusEntitlementContract.ts,
 * client: types/kplusEntitlementContract.ts). Runtime behaviour -- resolver,
 * lifecycle, ordering, idempotency, security, deletion -- is proven against a
 * real database by supabase/tests/kplus_entitlement_authority_test.sql.
 *
 * What these controls stop:
 *   - a K+ table or privileged K+ function becoming client-reachable
 *   - the legacy Build 34 predicate drifting (which would change existing
 *     users' access)
 *   - SQL, server contract and client contract disagreeing on a vocabulary
 *   - a free-form payload, PII, price or raw purchase identifier entering the
 *     ledger
 *   - a cached client snapshot resolving "free" or outliving the entitlement
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations');
const MIGRATION_NAMES = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{14}_kplus_entitlement_authority\.sql$/.test(f));
const MIGRATION_PATH = path.join(MIGRATIONS_DIR, MIGRATION_NAMES[0] ?? 'missing');
const SQL = fs.existsSync(MIGRATION_PATH) ? fs.readFileSync(MIGRATION_PATH, 'utf8') : '';
const SQL_TEST_PATH = path.join(ROOT, 'supabase', 'tests', 'kplus_entitlement_authority_test.sql');
const SERVER_CONTRACT_PATH = path.join(ROOT, 'supabase', 'functions', '_shared', 'kplus', 'kplusEntitlementContract.ts');
const CLIENT_CONTRACT_PATH = path.join(ROOT, 'types', 'kplusEntitlementContract.ts');
const DOC_PATH = path.join(ROOT, 'docs', 'build34-kplus-entitlement-authority-phase1.md');

const TABLES = ['kplus_entitlement_grants', 'kplus_entitlement_transitions', 'kplus_entitlement_activations'];
const FUNCTIONS = [
  'kplus_entitlement_facts',
  'kplus_effective_access_state',
  'kplus_has_active_entitlement',
  'kplus_user_entitlement_row_is_active',
  'kplus_entitlement_summary',
  'get_my_kplus_entitlement_summary',
  'grant_kplus_complimentary',
  'revoke_kplus_grant',
  'apply_kplus_provider_transition',
  'grant_kplus_early_access',
];
const MUTATING = ['grant_kplus_complimentary', 'revoke_kplus_grant', 'apply_kplus_provider_transition', 'grant_kplus_early_access'];

function loadTs(file, globals = {}) {
  const output = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = { exports: {} };
  const sandbox = {
    exports: mod.exports,
    module: mod,
    require: (specifier) => {
      throw new Error(`the contract module must not import anything: ${specifier}`);
    },
    ...globals,
  };
  vm.createContext(sandbox);
  new vm.Script(output, { filename: file }).runInContext(sandbox);
  return mod.exports;
}

/** Copy a value out of the vm realm so strict deep equality compares content. */
const plain = (value) => JSON.parse(JSON.stringify(value));

function fn(name) {
  const start = SQL.indexOf(`create or replace function public.${name}(`);
  assert.ok(start >= 0, `${name} must be defined in the migration`);
  const bodyStart = SQL.indexOf('as $$', start);
  const bodyEnd = SQL.indexOf('\n$$;', bodyStart);
  assert.ok(bodyStart > start && bodyEnd > bodyStart, `${name}: body anchors must be found`);
  return { header: SQL.slice(start, bodyStart), body: SQL.slice(bodyStart, bodyEnd) };
}

function checkList(constraintName, column) {
  const match = SQL.match(new RegExp(`constraint ${constraintName}\\s+check \\((?:${column} is null or )?${column} in \\(([\\s\\S]*?)\\)\\)`));
  assert.ok(match, `${constraintName} must be found`);
  const values = [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(values.length >= 2, `${constraintName} must list its values`);
  return values;
}

function interfaceKeys(source, name) {
  const start = source.indexOf(`export interface ${name} {`);
  assert.ok(start >= 0, `${name} must be declared`);
  const end = source.indexOf('\n}', start);
  return [...source.slice(start, end).matchAll(/^\s{2}([a-zA-Z]+)\??:/gm)].map((m) => m[1]).sort();
}

// ── Migration shape ────────────────────────────────────────────────────────────

test('exactly one K+ entitlement authority migration exists, after the Build 34 K+ migrations it builds on', () => {
  assert.equal(MIGRATION_NAMES.length, 1);
  const all = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  const index = all.indexOf(MIGRATION_NAMES[0]);
  for (const dependency of ['20260829120000_kplus_entitlements.sql', '20260829180000_fix_grant_kplus_early_access_variable_conflict.sql',
    '20260829203657_user_closet_items.sql']) {
    assert.ok(all.indexOf(dependency) >= 0 && all.indexOf(dependency) < index, `${dependency} must sort before the authority migration`);
  }
  assert.equal(index, all.length - 1, 'the authority migration is the newest migration on this line');
});

test('the migration defines exactly the reviewed function set', () => {
  const defined = [...SQL.matchAll(/create or replace function public\.([a-z_]+)\(/g)].map((m) => m[1]).sort();
  assert.deepEqual(defined, [...FUNCTIONS].sort());
});

test('every function is SECURITY DEFINER with a pinned search_path', () => {
  for (const name of FUNCTIONS) {
    const { header } = fn(name);
    assert.match(header, /\bsecurity definer\b/, `${name} must be security definer`);
    assert.match(header, /set search_path = public/, `${name} must pin search_path`);
  }
});

test('only get_my_kplus_entitlement_summary() is client-executable; everything else is service_role only', () => {
  const grants = new Map();
  for (const m of SQL.matchAll(/^grant execute on function public\.([a-z_]+)\([^)]*\) to ([a-z_, ]+);$/gm)) {
    grants.set(m[1], m[2].split(',').map((r) => r.trim()).sort());
  }
  assert.deepEqual([...grants.keys()].sort(), [...FUNCTIONS].sort());
  for (const name of FUNCTIONS) {
    const expected = name === 'get_my_kplus_entitlement_summary' ? ['authenticated'] : ['service_role'];
    assert.deepEqual(grants.get(name), expected, `${name} execute grant`);
    const revoke = SQL.match(new RegExp(`^revoke all on function public\\.${name}\\([^)]*\\) from ([a-z_, ]+);$`, 'm'));
    assert.ok(revoke, `${name} must revoke default privileges`);
    const revoked = revoke[1].split(',').map((r) => r.trim());
    assert.ok(revoked.includes('public') && revoked.includes('anon'), `${name} must revoke public and anon`);
    if (name !== 'get_my_kplus_entitlement_summary') assert.ok(revoked.includes('authenticated'), `${name} must revoke authenticated`);
  }
});

test('the migration fails itself if any client role can reach a K+ table or privileged function', () => {
  assert.match(SQL, /has_table_privilege\(r\.role_name, c\.oid, p\.priv\)/);
  assert.match(SQL, /has_function_privilege\(r\.role_name, pr\.oid, 'EXECUTE'\)/);
  assert.match(SQL, /raise exception 'K\+ entitlement tables must not be client-accessible/);
});

test('the three K+ tables have RLS, no policy, and SELECT for service_role only', () => {
  assert.doesNotMatch(SQL, /create policy/i);
  for (const table of TABLES) {
    assert.match(SQL, new RegExp(`create table if not exists public\\.${table} \\(`));
    assert.match(SQL, new RegExp(`alter table public\\.${table} enable row level security;`));
    assert.match(SQL, new RegExp(`revoke all on public\\.${table} from public, anon, authenticated, service_role;`));
    assert.match(SQL, new RegExp(`grant select on public\\.${table} to service_role;`));
    assert.doesNotMatch(SQL, new RegExp(`grant (insert|update|delete|all)[^;]*on public\\.${table}\\b`, 'i'));
  }
});

test('no K+ table has a free-form payload column or a column for PII, price or a raw purchase identifier', () => {
  for (const table of TABLES) {
    const start = SQL.indexOf(`create table if not exists public.${table} (`);
    const end = SQL.indexOf('\n);', start);
    const block = SQL.slice(start, end);
    const columns = [...block.matchAll(/^\s{2}([a-z_]+)\s+(uuid|text|timestamptz|boolean|smallint|integer|jsonb|json)\b/gm)];
    assert.ok(columns.length >= 10, `${table}: columns must parse`);
    for (const [, name, type] of columns) {
      assert.notEqual(type, 'json', `${table}.${name}`);
      assert.notEqual(type, 'jsonb', `${table}.${name}`);
      assert.doesNotMatch(name, /email|phone|full_name|display_name|payload|receipt|token|jwt|price|amount|currency|country|attribute|address|^ip_/,
        `${table}.${name} must not hold personal, payment or raw provider data`);
    }
  }
  // Store grants carry only a digest of the provider subscription reference.
  assert.match(SQL, /grant_key ~ '\^\[0-9a-f\]\{64\}\$'/);
});

test('legacy Build 34 rows resolve through the verbatim canonical predicate', () => {
  const { body } = fn('kplus_entitlement_facts');
  assert.match(body, /ue\.status = 'active'\s+and ue\.revoked_at is null\s+and ue\.expires_at is not null\s+and ue\.expires_at > p_at/);
  const row = fn('kplus_user_entitlement_row_is_active').body;
  assert.match(row, /ue\.status = 'active'\s+and ue\.revoked_at is null\s+and ue\.expires_at is not null\s+and ue\.expires_at > now\(\)/);
});

test('platform parity: the access predicate has no store, platform or device branch', () => {
  const { body } = fn('kplus_entitlement_facts');
  const start = body.indexOf('(g.revoked_at is null');
  const end = body.indexOf('end),', start);
  assert.ok(start > 0 && end > start, 'the grant access predicate must be found');
  const predicate = body.slice(start, end);
  assert.doesNotMatch(predicate, /store|apple|google|platform|ios|android|device/i,
    'Apple and Google subscriptions must resolve through the same access rule');
  assert.doesNotMatch(SQL, /\bp_(platform|device|os|client_time|now)\b/, 'no RPC accepts a platform, device or client time');
});

test('kplus_has_active_entitlement answers from the resolver, at server time, with its Build 34 signature', () => {
  const { header, body } = fn('kplus_has_active_entitlement');
  assert.match(header, /\(\s*p_user_id uuid,\s*p_entitlement_key text default 'k_plus'\s*\)/);
  assert.match(body, /kplus_effective_access_state\(p_user_id, p_entitlement_key, now\(\)\)/);
  assert.doesNotMatch(body, /user_entitlements/);
});

test('grant_kplus_early_access keeps its Build 34 signature and return shape', () => {
  const previous = fs.readFileSync(path.join(MIGRATIONS_DIR, '20260829180000_fix_grant_kplus_early_access_variable_conflict.sql'), 'utf8');
  const shape = (source) => {
    const start = source.indexOf('create or replace function public.grant_kplus_early_access(');
    return source.slice(start, source.indexOf('language plpgsql', start)).replace(/\s+/g, ' ').trim();
  };
  assert.equal(shape(SQL), shape(previous));
  assert.match(fn('grant_kplus_early_access').body, /on conflict \(user_id, entitlement_key\) do nothing/);
});

test('every K+ mutation takes the per-user advisory lock before its first write', () => {
  for (const name of MUTATING) {
    const { body } = fn(name);
    const lock = body.indexOf("pg_advisory_xact_lock(hashtextextended('kplus_entitlement:' || p_user_id::text, 0))");
    assert.ok(lock > 0, `${name} must lock`);
    const firstWrite = body.search(/\b(insert into|update public\.)/);
    assert.ok(firstWrite > lock, `${name} must lock before writing`);
  }
});

test('provider ordering uses provider facts only, never server receipt time', () => {
  const { body } = fn('apply_kplus_provider_transition');
  assert.match(body, /\(p_provider_occurred_at, v_rank, p_external_event_id\)\s+<= \(v_grant\.provider_state_occurred_at, v_grant\.provider_state_rank, v_grant\.provider_state_event_id\)/);
  assert.doesNotMatch(body, /recorded_at|received_at|clock_timestamp/);
  assert.match(body, /provider_time_in_future/);
});

test('the client read takes no argument and derives identity from auth.uid()', () => {
  const { header, body } = fn('get_my_kplus_entitlement_summary');
  assert.match(header, /get_my_kplus_entitlement_summary\(\)/);
  assert.match(body, /auth\.uid\(\)/);
  assert.match(body, /errcode = '42501'/);
});

// ── Contract parity ────────────────────────────────────────────────────────────

const server = loadTs(SERVER_CONTRACT_PATH, { crypto: globalThis.crypto, TextEncoder });
const client = loadTs(CLIENT_CONTRACT_PATH);
const SERVER_SOURCE = fs.readFileSync(SERVER_CONTRACT_PATH, 'utf8');
const CLIENT_SOURCE = fs.readFileSync(CLIENT_CONTRACT_PATH, 'utf8');

test('the SQL CHECK vocabularies and both typed contracts are identical', () => {
  assert.deepEqual(checkList('kplus_entitlement_grants_source_check', 'source'), plain(server.KPLUS_GRANT_SOURCES));
  assert.deepEqual(checkList('kplus_entitlement_grants_store_check', 'store'), plain(server.KPLUS_STORES));
  assert.deepEqual(checkList('kplus_entitlement_grants_environment_check', 'provider_environment'), plain(server.KPLUS_PROVIDER_ENVIRONMENTS));
  assert.deepEqual(checkList('kplus_entitlement_grants_period_type_check', 'current_period_type'), plain(server.KPLUS_PERIOD_TYPES));
  assert.deepEqual(checkList('kplus_entitlement_grants_billing_state_check', 'billing_state'), plain(server.KPLUS_BILLING_STATES));
  assert.deepEqual(checkList('kplus_entitlement_transitions_lifecycle_state_check', 'lifecycle_state'), plain(server.KPLUS_LIFECYCLE_STATES));
  assert.deepEqual(checkList('kplus_entitlement_transitions_event_type_check', 'provider_event_type'), plain(server.KPLUS_PROVIDER_EVENT_TYPES));
  assert.deepEqual(checkList('kplus_entitlement_activations_class_check', 'activation_class'), plain(server.KPLUS_ACTIVATION_CLASSES));

  assert.deepEqual(plain(client.KPLUS_STORES), plain(server.KPLUS_STORES));
  assert.deepEqual(plain(client.KPLUS_BILLING_STATES), plain(server.KPLUS_BILLING_STATES));
  assert.deepEqual(plain(client.KPLUS_DISPLAY_SOURCES), plain(server.KPLUS_DISPLAY_SOURCES));
  const facts = fn('kplus_entitlement_facts').body;
  for (const source of server.KPLUS_DISPLAY_SOURCES) {
    assert.match(facts, new RegExp(`'${source}'`), `the resolver must produce display source ${source}`);
  }
  for (const reason of server.KPLUS_PROVIDER_REJECTION_REASONS) {
    assert.match(fn('apply_kplus_provider_transition').body, new RegExp(`'${reason}'`), `rejection reason ${reason}`);
  }
});

test('the summary JSON keys match both typed contracts exactly', () => {
  const { body } = fn('kplus_entitlement_summary');
  const top = body.slice(body.indexOf('return jsonb_build_object('));
  const sqlKeys = [...top.matchAll(/^\s{4}'([a-zA-Z]+)',/gm)].map((m) => m[1]).sort();
  const nestedKeys = [...top.matchAll(/^\s{6}'([a-zA-Z]+)',/gm)].map((m) => m[1]).sort();
  assert.ok(sqlKeys.length >= 10 && nestedKeys.length === 2, 'summary keys must parse');
  assert.deepEqual(interfaceKeys(SERVER_SOURCE, 'KPlusEntitlementSummary'), sqlKeys);
  assert.deepEqual(interfaceKeys(CLIENT_SOURCE, 'KPlusEntitlementSummary'), sqlKeys);
  assert.deepEqual(interfaceKeys(SERVER_SOURCE, 'KPlusAccountManagement'), nestedKeys);
  assert.deepEqual(interfaceKeys(CLIENT_SOURCE, 'KPlusAccountManagement'), nestedKeys);
});

test('the subscription digest is SHA-256 over provider|store|environment|reference', async () => {
  const digest = await server.deriveKPlusSubscriptionRefDigest({
    provider: 'revenuecat', store: 'apple', environment: 'production', storeSubscriptionReference: '1000000123456789',
  });
  const expected = crypto.createHash('sha256').update('revenuecat|apple|production|1000000123456789').digest('hex');
  assert.equal(digest, expected);
});

// ── Client read / offline policy ───────────────────────────────────────────────

const ISSUED = Date.parse('2026-09-15T12:00:00.000Z');
const MINUTE = 60 * 1000;

function summary(overrides = {}) {
  return {
    contractVersion: 1,
    entitlementKey: 'k_plus',
    access: 'k_plus',
    displaySource: 'complimentary',
    effectiveExpiresAt: '2027-03-15T12:00:00.000Z',
    isOpenEnded: false,
    trialEndsAt: null,
    willRenew: null,
    store: null,
    billingState: null,
    accountManagement: { storeManagementRelevant: false, managementStore: null },
    snapshotIssuedAt: new Date(ISSUED).toISOString(),
    ...overrides,
  };
}
const FREE = {
  access: 'free', displaySource: null, effectiveExpiresAt: null, isOpenEnded: false,
};

test('the default presentation snapshot policy is 15 minutes, a client constant', () => {
  assert.equal(client.KPLUS_PRESENTATION_SNAPSHOT_POLICY.maxAgeMs, 15 * MINUTE);
  assert.doesNotMatch(SQL, /max_?age|presentation|cache_?ttl|snapshot_?validity/i,
    'the presentation cache age is client policy, never database authority');
});

test('a fresh K+ snapshot presents K+, and never beyond 15 minutes', () => {
  const s = summary();
  assert.equal(client.evaluateKPlusPresentationSnapshot(s, ISSUED + 14 * MINUTE).status, 'resolved');
  assert.equal(client.presentsKPlusAccess(client.evaluateKPlusPresentationSnapshot(s, ISSUED + 14 * MINUTE)), true);
  const stale = client.evaluateKPlusPresentationSnapshot(s, ISSUED + 15 * MINUTE);
  assert.deepEqual(plain(stale), { status: 'unavailable', reason: 'snapshot_expired' });
  assert.equal(client.shouldPresentKPlusPaywall(stale), false, 'a stale K+ snapshot becomes unverified, never a paywall');
});

test('snapshot validity is capped by the entitlement\'s own expiry, but not for open-ended access', () => {
  const soon = summary({ effectiveExpiresAt: new Date(ISSUED + 5 * MINUTE).toISOString() });
  assert.equal(client.evaluateKPlusPresentationSnapshot(soon, ISSUED + 4 * MINUTE).status, 'resolved');
  assert.equal(client.evaluateKPlusPresentationSnapshot(soon, ISSUED + 5 * MINUTE).status, 'unavailable');
  const open = summary({ effectiveExpiresAt: null, isOpenEnded: true });
  assert.equal(client.kplusPresentationSnapshotValidUntilMs(open), ISSUED + 15 * MINUTE);
});

test('a free snapshot never presents K+, and a stale one is unavailable rather than free', () => {
  const free = summary(FREE);
  const fresh = client.evaluateKPlusPresentationSnapshot(free, ISSUED + MINUTE);
  assert.equal(client.presentsKPlusAccess(fresh), false);
  assert.equal(client.shouldPresentKPlusPaywall(fresh), true);
  const stale = client.evaluateKPlusPresentationSnapshot(free, ISSUED + 16 * MINUTE);
  assert.equal(stale.status, 'unavailable');
  assert.equal(client.shouldPresentKPlusPaywall(stale), false);
});

test('a device clock set back cannot keep a snapshot alive', () => {
  const s = summary();
  assert.equal(client.evaluateKPlusPresentationSnapshot(s, ISSUED - 4 * MINUTE).status, 'resolved');
  assert.deepEqual(plain(client.evaluateKPlusPresentationSnapshot(s, ISSUED - 6 * MINUTE)), { status: 'unavailable', reason: 'clock_untrusted' });
});

test('resolving, unavailable and signed-out never show a paywall or K+', () => {
  for (const state of [{ status: 'resolving' }, { status: 'unavailable', reason: 'network' }, { status: 'signed_out' }]) {
    assert.equal(client.shouldPresentKPlusPaywall(state), false, state.status);
    assert.equal(client.presentsKPlusAccess(state), false, state.status);
  }
});

test('the summary parser accepts the contract and rejects anything malformed or inconsistent', () => {
  assert.ok(client.parseKPlusEntitlementSummary(summary()));
  assert.ok(client.parseKPlusEntitlementSummary(summary(FREE)));
  const withExtra = client.parseKPlusEntitlementSummary({ ...summary(), grantId: 'internal', providerEventId: 'x' });
  assert.deepEqual(Object.keys(withExtra).sort(), Object.keys(summary()).sort(), 'unknown server fields are dropped');
  for (const bad of [
    null, [], 'k_plus', {},
    summary({ contractVersion: 2 }),
    summary({ access: 'maybe' }),
    summary({ displaySource: null }),
    summary({ effectiveExpiresAt: null, isOpenEnded: false }),
    summary({ isOpenEnded: true }),
    summary({ ...FREE, displaySource: 'complimentary' }),
    summary({ store: 'amazon' }),
    summary({ billingState: 'suspended' }),
    summary({ snapshotIssuedAt: '2026-09-15 12:00' }),
    summary({ effectiveExpiresAt: '2027-03-15T12:00:00+02:00' }),
    summary({ accountManagement: null }),
  ]) {
    assert.equal(client.parseKPlusEntitlementSummary(bad), null, JSON.stringify(bad));
  }
});

// ── Scope, privacy and naming ──────────────────────────────────────────────────

test('the pgTAP matrix exists, rolls back, and uses synthetic identities only', () => {
  const sql = fs.readFileSync(SQL_TEST_PATH, 'utf8');
  assert.match(sql, /^begin;$/m);
  assert.match(sql, /^rollback;$/m);
  assert.match(sql, /kscan-test\.invalid/);
  const assertions = sql.split('\n').filter((l) => /^select (ok|is|isnt|throws_ok|lives_ok)\(/.test(l)).length;
  assert.ok(assertions >= 180, `expected the full matrix, found ${assertions} assertions`);
  for (const section of ['A. Existing Build 34', 'B. Free', 'C. Trial', 'D. Paid', 'E. Grace', 'F. Complimentary',
    'G. Overlapping', 'H. Idempotency and ordering', 'I. Time', 'J. Security', 'K. Ledger', 'L. Account deletion', 'M. Read contract',
    'N. Platform parity']) {
    assert.ok(sql.includes(section), `section ${section}`);
  }
});

test('the new K+ tables are registered in both deletion-purge registries', () => {
  const tsRegistry = fs.readFileSync(path.join(ROOT, 'supabase', 'functions', '_shared', 'deletion', 'userDataResources.ts'), 'utf8');
  const jsonRegistry = JSON.parse(fs.readFileSync(path.join(ROOT, 'lib', 'account-deletion', 'user-data-resources.json'), 'utf8'));
  for (const table of TABLES) {
    assert.match(tsRegistry, new RegExp(`table: '${table}', column: 'user_id', action: 'auth_delete_cascade'`));
    const entry = jsonRegistry.tables.find((e) => e.table === table);
    assert.ok(entry && entry.action === 'auth_delete_cascade' && entry.column === 'user_id', `${table} json entry`);
  }
  for (const table of TABLES) {
    assert.match(SQL, new RegExp(`create table if not exists public\\.${table} \\([\\s\\S]*?user_id\\s+uuid not null references auth\\.users\\(id\\) on delete cascade`));
  }
});

test('no K+ surface consumes the new client contract yet: Phase 1 changes no UI', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(tsx?|jsx?)$/.test(entry.name) && fs.readFileSync(full, 'utf8').includes('kplusEntitlementContract')) {
        offenders.push(path.relative(ROOT, full));
      }
    }
  };
  for (const dir of ['app', 'components', 'hooks', 'services', 'contexts']) walk(path.join(ROOT, dir));
  assert.deepEqual(offenders, []);
});

test('new K+ authority files carry no invented price and never shorten the product name', () => {
  const files = [MIGRATION_PATH, SQL_TEST_PATH, SERVER_CONTRACT_PATH, CLIENT_CONTRACT_PATH,
    path.join(ROOT, 'scripts', 'kplus', 'build-entitlement-authority-sql-batch.mjs')];
  if (fs.existsSync(DOC_PATH)) files.push(DOC_PATH);
  const nonZeroAmount = /(?:\$|USD\s?|EUR\s?|GBP\s?|£|€)\s?(?:[1-9]\d*(?:\.\d{1,2})?|0\.\d*[1-9])/;
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(text, nonZeroAmount, `${path.relative(ROOT, file)} must not state a price`);
    // The one permitted price statement is the owner-mandated current state,
    // CURRENT_KPLUS_PRICE_USD=0; any other price constant or column is refused.
    assert.doesNotMatch(text, /monthly_price|price_usd(?!=0\b)|priceUsd|KPLUS_PRICE(?!_USD=0\b)/i,
      `${path.relative(ROOT, file)} must not define a price`);
    assert.doesNotMatch(text, /K Scan(?! AI)/, `${path.relative(ROOT, file)} must say "K Scan AI"`);
  }
});
