/**
 * K Scan AI -- Build 35 paid K+ Phase A: canonical lifetime foundation.
 *
 * Static and contract controls for
 *   supabase/migrations/*_kplus_paid_lifetime_entitlement_foundation.sql
 * and the lifetime half of supabase/functions/_shared/kplus/
 * kplusEntitlementContract.ts. Runtime behaviour -- the entitlement union,
 * lifecycle, ordering, idempotency, ownership, privileges -- is proven against a
 * real database by supabase/tests/kplus_paid_lifetime_foundation_test.sql.
 *
 * The migration audit is a function (auditMigration) so every rule is also run
 * against a deliberately broken copy and must fail: a rule that cannot fail
 * proves nothing.
 *
 * What these controls stop:
 *   - lifetime being modelled as an expiring subscription
 *   - a purchase deleting, shortening or rewriting a complimentary grant
 *   - any client role reaching lifetime authority
 *   - a price, trial, receipt, purchase token, payload or email entering the model
 *   - a store purchase entering the RevenueCat PROMOTIONAL mirror
 *   - SQL and the typed contract disagreeing on a name, a vocabulary or an argument
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
const NAME_PATTERN = /^\d{14}_kplus_paid_lifetime_entitlement_foundation\.sql$/;
const NAMES = fs.readdirSync(MIGRATIONS_DIR).filter((f) => NAME_PATTERN.test(f));
const MIGRATION_PATH = path.join(MIGRATIONS_DIR, NAMES[0] ?? 'missing');
const SQL = fs.existsSync(MIGRATION_PATH) ? fs.readFileSync(MIGRATION_PATH, 'utf8') : '';
const AUTH_SQL = fs.readFileSync(path.join(MIGRATIONS_DIR, '20260915030553_kplus_entitlement_authority.sql'), 'utf8');
const MIRROR_SQL = fs.readFileSync(path.join(MIGRATIONS_DIR, '20260915181554_kplus_revenuecat_mirror_retirement.sql'), 'utf8');
const SERVER_CONTRACT_PATH = path.join(ROOT, 'supabase', 'functions', '_shared', 'kplus', 'kplusEntitlementContract.ts');
const PGTAP_PATH = path.join(ROOT, 'supabase', 'tests', 'kplus_paid_lifetime_foundation_test.sql');
const DOC_PATH = path.join(ROOT, 'docs', 'build35-kplus-paid-phase-a.md');

/** The last Build 34 production migration. Every Build 35 migration sorts after it. */
const BUILD34_LAST_MIGRATION = '20261001204903_canonical_closet_owned_look_support.sql';

const LIFETIME_FN = 'apply_kplus_provider_lifetime_transition';
const REPLACED = ['kplus_entitlement_facts', 'kplus_entitlement_summary', 'revoke_kplus_grant'];
const DEFINED = [...REPLACED, LIFETIME_FN].sort();

const strip = (sql) => sql.replace(/--.*$/gm, '');
const norm = (s) => s.replace(/\s+/g, ' ').trim();

function fnIn(sql, name) {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  if (start < 0) return null;
  const bodyStart = sql.indexOf('as $$', start);
  const bodyEnd = sql.indexOf('\n$$;', bodyStart);
  return { header: sql.slice(start, bodyStart), body: sql.slice(bodyStart, bodyEnd) };
}

function loadTs(file, globals = {}) {
  const output = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = { exports: {} };
  const sandbox = {
    exports: mod.exports,
    module: mod,
    require: (specifier) => { throw new Error(`the contract module must not import anything: ${specifier}`); },
    ...globals,
  };
  vm.createContext(sandbox);
  new vm.Script(output, { filename: file }).runInContext(sandbox);
  return mod.exports;
}
const plain = (v) => JSON.parse(JSON.stringify(v));

/**
 * Every rule the migration must satisfy, as data. Returns the list of
 * violations; an empty list is a pass.
 */
function auditMigration(sql) {
  const code = strip(sql);
  const out = [];
  const lifetime = fnIn(sql, LIFETIME_FN);

  // Forward-only, additive.
  if (/\bdrop\s+(table|column|schema|function|policy)\b/i.test(code)) out.push('destructive: drop table/column/schema/function/policy');
  if (/\bdelete\s+from\b/i.test(code)) out.push('destructive: delete from');
  // A TRUNCATE *statement* (the privilege name 'TRUNCATE' inside the guard's
  // privilege list is not one).
  if (/(^|;)\s*truncate\b/im.test(code)) out.push('destructive: truncate');
  if (/\bcreate\s+table\b/i.test(code)) out.push('adds a table (Phase A adds none)');
  if (/\bcreate\s+policy\b/i.test(code)) out.push('adds an RLS policy');
  if (/\bgrant\s+(select|insert|update|delete|all)\b[^;]*\bon\s+(table\s+)?public\./i.test(code)) out.push('grants table privileges');

  // Complimentary and legacy rows are never written by a purchase.
  if (/\b(insert\s+into|update|delete\s+from)\s+public\.user_entitlements\b/i.test(code)) out.push('writes the legacy user_entitlements table');
  if (lifetime) {
    const writes = [...lifetime.body.matchAll(/\b(insert\s+into|update)\s+public\.([a-z_]+)/gi)].map((m) => m[2]);
    for (const table of writes) {
      if (!['kplus_entitlement_grants', 'kplus_entitlement_transitions', 'kplus_entitlement_activations'].includes(table)) out.push(`lifetime transition writes ${table}`);
    }
    for (const m of lifetime.body.matchAll(/update public\.kplus_entitlement_grants[\s\S]*?;/g)) {
      if (!/where id = v_grant\.id/.test(m[0])) out.push('a lifetime grant update is not scoped to the one grant it owns');
    }
    if (/source\s*(<>|!=|in \(|not in)[^;]*'complimentary/i.test(lifetime.body)) out.push('lifetime transition reasons about complimentary grants');
  } else {
    out.push('lifetime transition function missing');
  }

  // Function set, security mode, search_path.
  const defined = [...sql.matchAll(/create or replace function public\.([a-z_]+)\(/g)].map((m) => m[1]).sort();
  if (JSON.stringify(defined) !== JSON.stringify(DEFINED)) out.push(`defines ${defined.join(',')}`);
  for (const name of DEFINED) {
    const f = fnIn(sql, name);
    if (!f) continue;
    if (!/\bsecurity definer\b/.test(f.header)) out.push(`${name} is not security definer`);
    if (!/set search_path = public/.test(f.header)) out.push(`${name} does not pin search_path`);
  }

  // Privileges: nothing here is client-executable.
  for (const m of code.matchAll(/^grant execute on function public\.([a-z_]+)\([^)]*\) to ([a-z_, ]+);$/gm)) {
    if (m[2].split(',').map((r) => r.trim()).some((r) => r !== 'service_role')) out.push(`${m[1]} is executable by ${m[2]}`);
  }
  if (!new RegExp(`revoke all on function public\\.${LIFETIME_FN}\\([^)]*\\) from public, anon, authenticated;`).test(code)) {
    out.push('lifetime transition does not revoke public, anon and authenticated');
  }
  if (!new RegExp(`grant execute on function public\\.${LIFETIME_FN}\\([^)]*\\) to service_role;`).test(code)) {
    out.push('lifetime transition is not granted to service_role');
  }
  if (!/'apply_kplus_provider_lifetime_transition'/.test(code)) out.push('post-condition guard does not cover the lifetime transition');
  if (!/raise exception 'privileged K\+ functions must not be client-executable/.test(code)) out.push('post-condition guard missing');

  // The lifetime shape cannot express a subscription.
  const shape = sql.match(/\(source = 'store_lifetime'[\s\S]*?grant_key ~ '\^\[0-9a-f\]\{64\}\$'\)/);
  if (!shape) {
    out.push('lifetime shape constraint missing');
  } else {
    for (const required of ['is_open_ended and expires_at is null', 'current_period_type is null', 'current_period_starts_at is null',
      'trial_ends_at is null', 'will_renew is null', "billing_state = 'normal'", 'grace_period_expires_at is null', 'pause_resumes_at is null']) {
      if (!shape[0].includes(required)) out.push(`lifetime shape does not require: ${required}`);
    }
  }
  if (!/where source = 'store_lifetime'/.test(sql) || !/create unique index if not exists kplus_entitlement_grants_store_lifetime_key/.test(sql)) {
    out.push('no unique index keeps one lifetime purchase to one user');
  }

  // A store purchase is never a promotional mirror.
  const trigger = sql.match(/create trigger kplus_entitlement_grants_revenuecat_mirror_retire[\s\S]*?execute function/);
  if (!trigger) out.push('mirror trigger not recreated');
  else if (!/old\.source not in \('store_subscription', 'store_lifetime'\)/.test(trigger[0])) out.push('mirror trigger does not exclude store_lifetime');

  // No commercial values, no raw purchase data, no PII.
  const nonZeroAmount = /(?:\$|USD\s?|EUR\s?|GBP\s?|£|€)\s?(?:[1-9]\d*(?:\.\d{1,2})?|0\.\d*[1-9])/;
  if (nonZeroAmount.test(sql)) out.push('states a price');
  if (/monthly_price|lifetime_price|price_usd|priceUsd|trial_days|trial_duration|free_trial/i.test(code)) out.push('defines a commercial value');
  if (/K Scan(?! AI)/.test(sql)) out.push('shortens the product name');
  if (lifetime) {
    const params = [...lifetime.header.matchAll(/^\s+(p_[a-z_]+)\s+/gm)].map((m) => m[1]);
    for (const p of params) {
      if (/email|phone|name|payload|receipt|token|jwt|price|amount|currency|country|attribute|address|transaction|period|renew|trial|grace|expires|billing/.test(p)) {
        out.push(`lifetime transition accepts a forbidden input: ${p}`);
      }
    }
    if (!params.includes('p_purchase_ref_digest')) out.push('lifetime transition does not take a purchase digest');
    // Locking and ordering.
    const lock = lifetime.body.indexOf("pg_advisory_xact_lock(hashtextextended('kplus_entitlement:' || p_user_id::text, 0))");
    const firstWrite = lifetime.body.search(/\b(insert into|update public\.)/);
    if (!(lock > 0 && firstWrite > lock)) out.push('lifetime transition does not lock the user before its first write');
    if (!/\(p_provider_occurred_at, v_rank, p_external_event_id\)\s+<= \(v_grant\.provider_state_occurred_at, v_grant\.provider_state_rank, v_grant\.provider_state_event_id\)/.test(lifetime.body)) {
      out.push('lifetime ordering is not by provider facts');
    }
    if (/recorded_at|received_at|clock_timestamp/.test(lifetime.body)) out.push('lifetime ordering uses server receipt time');
    if (!/'purchase_owned_by_other_user'/.test(lifetime.body)) out.push('no cross-user purchase refusal');
    if (!/'environment_mismatch'/.test(lifetime.body)) out.push('no environment isolation');
  }
  return out;
}

// ── The migration ─────────────────────────────────────────────────────────────

test('exactly one Phase A migration exists, and it sorts after the Build 34 production ledger', () => {
  assert.equal(NAMES.length, 1);
  const all = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  assert.ok(all.indexOf(BUILD34_LAST_MIGRATION) >= 0, 'the Build 34 baseline migration must be present');
  assert.ok(all.indexOf(NAMES[0]) > all.indexOf(BUILD34_LAST_MIGRATION), 'a Build 35 migration must sort after 20261001204903');
  for (const dependency of ['20260915030553_kplus_entitlement_authority.sql', '20260915181554_kplus_revenuecat_mirror_retirement.sql']) {
    assert.ok(all.indexOf(dependency) < all.indexOf(NAMES[0]), `${dependency} must sort before the lifetime foundation`);
  }
});

test('no migration version collides (the repo\'s own guard), and the Phase A version is a unique 14-digit timestamp', () => {
  const { findVersionCollisions } = require('../scripts/check-migration-version-collisions.js');
  assert.deepEqual(findVersionCollisions(MIGRATIONS_DIR), []);
  const version = NAMES[0].split('_')[0];
  assert.match(version, /^\d{14}$/);
  const same = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql') && f.startsWith(`${version}_`));
  assert.deepEqual(same, [NAMES[0]]);
});

test('no recorded migration was edited: the Build 34 K+ migrations still have their recorded content (SHA-256 of the LF-normalised bytes at 5a0e2c3d)', () => {
  // Phase A is forward-only. The four migrations it builds on are pinned by
  // content, so an edit to a recorded migration -- which would diverge from every
  // ledger that has already applied it -- fails here rather than at deploy time.
  // Line endings are normalised: core.autocrlf checks these out as CRLF on Windows.
  const PINNED = {
    '20260915030553_kplus_entitlement_authority.sql': 'fab02416fe6158ce14a213adc7de6cd5c2c0b2e9a509f6fd1a77e53798d4d7d9',
    '20260915124849_kplus_reconcile_queue_excludes_inactive_rows.sql': 'dcc7ac89b0b0978d02f57644f68c70a479aa3d8641b8ed90d3e14ebc4f956afb',
    '20260915181554_kplus_revenuecat_mirror_retirement.sql': '212674c80b868904d3ed3cb90b6b93950a2aaf354b1cf688e922bc9c030946a0',
    '20260915181910_kplus_promotional_mirror_sources_search_path.sql': '62619f5f7658d6eb1b7896983436b1f280c0790626fb096fa94e12ffb6c5425e',
  };
  for (const [name, expected] of Object.entries(PINNED)) {
    const lf = fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8').replace(/\r\n/g, '\n');
    assert.equal(crypto.createHash('sha256').update(lf).digest('hex'), expected, `${name} was edited; migrations are immutable once recorded`);
  }
  assert.doesNotMatch(strip(SQL), /alter\s+table\s+public\.kplus_entitlement_grants\s+(add|rename|alter)\s+column/i);
});

test('the unmodified migration passes the whole audit', () => {
  assert.deepEqual(auditMigration(SQL), []);
});

test('the migration defines exactly the reviewed function set', () => {
  const defined = [...SQL.matchAll(/create or replace function public\.([a-z_]+)\(/g)].map((m) => m[1]).sort();
  assert.deepEqual(defined, DEFINED);
});

test('legacy Build 34 rows still resolve through the verbatim canonical predicate, unchanged', () => {
  const original = fnIn(AUTH_SQL, 'kplus_entitlement_facts').body;
  const replaced = fnIn(SQL, 'kplus_entitlement_facts').body;
  const legacy = (body) => norm(body.slice(body.indexOf("select\n    'legacy_grant'::text"), body.indexOf('union all')));
  assert.ok(legacy(replaced).length > 300, 'the legacy branch must be found');
  assert.equal(legacy(replaced), legacy(original), 'the legacy branch must be byte-for-byte the Build 34 branch');
  assert.match(replaced, /ue\.status = 'active'\s+and ue\.revoked_at is null\s+and ue\.expires_at is not null\s+and ue\.expires_at > p_at/);
});

test('the access predicate for grants is unchanged: lifetime is simply an open-ended grant that is not revoked', () => {
  const access = (body) => {
    const start = body.indexOf('(g.revoked_at is null');
    return norm(body.slice(start, body.indexOf('end),', start)));
  };
  assert.equal(access(fnIn(SQL, 'kplus_entitlement_facts').body), access(fnIn(AUTH_SQL, 'kplus_entitlement_facts').body),
    'access must not gain a lifetime-specific branch that could drift from the union rule');
  assert.doesNotMatch(access(fnIn(SQL, 'kplus_entitlement_facts').body), /store|apple|google|platform|lifetime/i);
});

test('the mirror-retirement trigger is the Build 34 trigger with exactly one clause widened', () => {
  const grab = (sql) => norm(sql.match(/create trigger kplus_entitlement_grants_revenuecat_mirror_retire[\s\S]*?execute function public\.kplus_grants_mirror_retire_tg\(\);/)[0]
    .replace(/--.*$/gm, ''));
  const widened = grab(SQL).replace("old.source not in ('store_subscription', 'store_lifetime')", "old.source <> 'store_subscription'");
  assert.equal(widened, grab(MIRROR_SQL));
});

test('the new migration never redefines the subscription transition, and never edits a recorded migration', () => {
  assert.doesNotMatch(strip(SQL), /create or replace function public\.apply_kplus_provider_transition\(/);
  assert.doesNotMatch(strip(SQL), /create or replace function public\.(kplus_effective_access_state|kplus_has_active_entitlement|grant_kplus_complimentary|grant_kplus_early_access|get_my_kplus_entitlement_summary)\(/);
});

test('no K+ table gains a free-form payload, price, receipt, token or PII column', () => {
  assert.doesNotMatch(strip(SQL), /\badd\s+column\b/i, 'Phase A adds no column');
  assert.doesNotMatch(strip(SQL), /\b(jsonb?|bytea)\b\s*(,|\))/i);
});

test('the lifetime function validates its closed vocabularies and refuses contradictory claims', () => {
  const { body } = fnIn(SQL, LIFETIME_FN);
  assert.match(body, /p_purchase_ref_digest !~ '\^\[0-9a-f\]\{64\}\$'/);
  assert.match(body, /p_lifecycle_state not in \('active', 'refunded', 'revoked'\)/);
  assert.match(body, /p_provider_event_type not in \(\s*'lifetime_purchase', 'refund', 'refund_reversed', 'transfer', 'reconciliation_snapshot'\)/);
  assert.match(body, /lifetime event type and lifecycle state disagree/);
  assert.match(body, /p_environment not in \('production', 'sandbox'\)/);
  assert.match(body, /p_store not in \('apple', 'google'\)/);
});

// ── Negative controls: the audit must go red ──────────────────────────────────

function mutated(find, replace) {
  const first = SQL.indexOf(find);
  assert.ok(first >= 0, `mutation anchor must exist: ${find.slice(0, 60)}`);
  assert.equal(SQL.indexOf(find, first + 1), -1, `mutation anchor must be unique: ${find.slice(0, 60)}`);
  return SQL.slice(0, first) + replace + SQL.slice(first + find.length);
}
const GRANT_FN = 'public.apply_kplus_provider_lifetime_transition(uuid, text, text, text, text, timestamptz, text, text, text, text, text, timestamptz, text)';
const CONTROLS = [
  ['lifetime transition granted to authenticated', mutated('-- 7. Post-condition guard', `grant execute on function ${GRANT_FN} to authenticated;\n-- 7. Post-condition guard`), /executable by authenticated/],
  ['lifetime transition not revoked from clients', mutated('revoke all on function public.apply_kplus_provider_lifetime_transition(uuid, text, text, text, text, timestamptz, text, text, text, text, text, timestamptz, text) from public, anon, authenticated;', ''), /does not revoke/],
  ['a purchase deletes complimentary grants', mutated('  select s.has_access, s.is_open_ended, s.effective_expires_at\n    into v_access_after, v_open_after, v_expires_after', "  delete from public.kplus_entitlement_grants where user_id = p_user_id;\n  select s.has_access, s.is_open_ended, s.effective_expires_at\n    into v_access_after, v_open_after, v_expires_after"), /destructive: delete from/],
  ['a purchase rewrites the legacy complimentary row', mutated('  select s.has_access, s.is_open_ended, s.effective_expires_at\n    into v_access_after, v_open_after, v_expires_after', "  update public.user_entitlements set status = 'expired' where user_id = p_user_id;\n  select s.has_access, s.is_open_ended, s.effective_expires_at\n    into v_access_after, v_open_after, v_expires_after"), /writes the legacy user_entitlements/],
  ['lifetime shape allows an expiry', mutated("        and is_open_ended and expires_at is null\n", '        and is_open_ended\n'), /does not require: is_open_ended and expires_at is null/],
  ['lifetime shape allows a renewal flag', mutated('        and trial_ends_at is null and will_renew is null\n        and billing_state = \'normal\' and grace_period_expires_at is null\n        and pause_resumes_at is null\n        and provider_state_occurred_at is not null and provider_state_rank is not null\n        and provider_state_event_id is not null\n        and grant_key ~ \'^[0-9a-f]{64}$\')\n      or\n      (source not in', '        and trial_ends_at is null\n        and billing_state = \'normal\' and grace_period_expires_at is null\n        and pause_resumes_at is null\n        and provider_state_occurred_at is not null and provider_state_rank is not null\n        and provider_state_event_id is not null\n        and grant_key ~ \'^[0-9a-f]{64}$\')\n      or\n      (source not in'), /does not require: will_renew is null/],
  ['a revoked lifetime purchase enters the promotional mirror queue', mutated("old.source not in ('store_subscription', 'store_lifetime')", "old.source <> 'store_subscription'"), /does not exclude store_lifetime/],
  ['one lifetime purchase may attach to many users (no unique index)', mutated('create unique index if not exists kplus_entitlement_grants_store_lifetime_key', 'create index if not exists kplus_entitlement_grants_store_lifetime_key'), /no unique index/],
  ['the function is not search_path pinned', mutated("language plpgsql\nvolatile\nsecurity definer\nset search_path = public\nas $$\ndeclare\n  c_max_future_skew", "language plpgsql\nvolatile\nsecurity definer\nas $$\ndeclare\n  c_max_future_skew"), /does not pin search_path/],
  ['the transition accepts a price', mutated('  p_purchased_at         timestamptz,\n', '  p_purchased_at         timestamptz,\n  p_price                numeric,\n'), /forbidden input: p_price/],
  ['the model states a price', `${SQL}\n-- lifetime is $49.99\n`, /states a price/],
  ['the model defines a trial duration', `${SQL}\ncreate or replace function public.kplus_x() returns int language sql as $$ select 7 as trial_days $$;\n`, /commercial value/],
  ['ordering uses server receipt time', mutated('update public.kplus_entitlement_grants\n       set starts_at = least(starts_at, p_purchased_at)\n     where id = v_grant.id;\n\n    insert', 'update public.kplus_entitlement_grants\n       set starts_at = least(starts_at, p_purchased_at), updated_at = recorded_at\n     where id = v_grant.id;\n\n    insert'), /server receipt time/],
  ['the lock is taken after the first write', mutated("  perform pg_advisory_xact_lock(hashtextextended('kplus_entitlement:' || p_user_id::text, 0));\n\n  -- 4. Idempotency. The key is shared", "  insert into public.kplus_entitlement_transitions (user_id, entitlement_key, cause, outcome, access_before, access_after) values (p_user_id, 'k_plus', 'grant_revocation', 'applied', false, false);\n  perform pg_advisory_xact_lock(hashtextextended('kplus_entitlement:' || p_user_id::text, 0));\n\n  -- 4. Idempotency. The key is shared"), /does not lock the user before its first write/],
  ['a destructive statement appears', `${SQL}\ndrop table public.kplus_entitlement_grants;\n`, /destructive: drop/],
  ['an RLS policy appears', `${SQL}\ncreate policy p on public.kplus_entitlement_grants for select using (true);\n`, /adds an RLS policy/],
  ['a table privilege is granted', `${SQL}\ngrant select on public.kplus_entitlement_grants to authenticated;\n`, /grants table privileges/],
];

for (const [label, source, expected] of CONTROLS) {
  test(`NEGATIVE CONTROL: ${label}`, () => {
    const violations = auditMigration(source);
    assert.ok(violations.length > 0, 'the audit must go red');
    assert.ok(violations.some((v) => expected.test(v)), `expected a violation matching ${expected}, got: ${violations.join(' | ')}`);
  });
}

// ── The typed contract ────────────────────────────────────────────────────────

const server = loadTs(SERVER_CONTRACT_PATH, { crypto: globalThis.crypto, TextEncoder });

test('the lifetime vocabularies in the server contract equal the SQL the function enforces', () => {
  const { body, header } = fnIn(SQL, LIFETIME_FN);
  const listed = (re) => [...body.match(re)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(listed(/p_lifecycle_state not in \(([^)]*)\)/), plain(server.KPLUS_LIFETIME_LIFECYCLE_STATES));
  assert.deepEqual(listed(/p_provider_event_type not in \(([^)]*)\)/), plain(server.KPLUS_LIFETIME_PROVIDER_EVENT_TYPES));
  for (const reason of server.KPLUS_LIFETIME_PROVIDER_REJECTION_REASONS) {
    assert.match(body, new RegExp(`'${reason}'`), `rejection reason ${reason}`);
  }
  // 'lifetime_purchase' is also a legal provider event type in the ledger CHECK.
  assert.ok(plain(server.KPLUS_PROVIDER_EVENT_TYPES).includes('lifetime_purchase'));
  assert.match(SQL, /'lifetime_purchase'\s*\)\);/);
  void header;
});

test('the event/lifecycle agreement table matches the SQL disagreement rules clause for clause', () => {
  const { body } = fnIn(SQL, LIFETIME_FN);
  const table = plain(server.KPLUS_LIFETIME_EVENT_LIFECYCLE);
  assert.deepEqual(table.lifetime_purchase, ['active']);
  assert.deepEqual(table.refund_reversed, ['active']);
  assert.deepEqual(table.refund, ['refunded']);
  assert.deepEqual(table.transfer, ['revoked']);
  assert.deepEqual(table.reconciliation_snapshot, ['active', 'refunded', 'revoked']);
  assert.match(body, /p_provider_event_type in \('lifetime_purchase', 'refund_reversed'\) and p_lifecycle_state <> 'active'/);
  assert.match(body, /p_provider_event_type = 'refund' and p_lifecycle_state <> 'refunded'/);
  assert.match(body, /p_provider_event_type = 'transfer' and p_lifecycle_state <> 'revoked'/);
});

test('the typed argument mapper names exactly the SQL parameters', () => {
  const { header } = fnIn(SQL, LIFETIME_FN);
  const sqlParams = [...header.matchAll(/^\s+(p_[a-z_]+)\s+/gm)].map((m) => m[1]).sort();
  const args = server.toApplyKPlusProviderLifetimeTransitionArgs({
    userId: 'u', provider: 'revenuecat', cause: 'provider_event', externalEventId: 'e', providerEventType: 'lifetime_purchase',
    providerOccurredAt: '2026-10-02T00:00:00.000Z', environment: 'production', store: 'apple', productId: 'synthetic.lifetime.product',
    purchaseRefDigest: 'a'.repeat(64), lifecycleState: 'active', purchasedAt: '2026-10-02T00:00:00.000Z',
  });
  assert.deepEqual(Object.keys(args).sort(), sqlParams);
  assert.equal(args.p_entitlement_key, 'k_plus');
});

test('the typed mapper refuses a raw purchase reference and a contradictory claim before they reach the database', () => {
  const base = {
    userId: 'u', provider: 'revenuecat', cause: 'provider_event', externalEventId: 'e', providerEventType: 'lifetime_purchase',
    providerOccurredAt: '2026-10-02T00:00:00.000Z', environment: 'production', store: 'apple', productId: 'synthetic.lifetime.product',
    purchaseRefDigest: 'a'.repeat(64), lifecycleState: 'active', purchasedAt: '2026-10-02T00:00:00.000Z',
  };
  assert.throws(() => server.toApplyKPlusProviderLifetimeTransitionArgs({ ...base, purchaseRefDigest: '1000000123456789' }), /SHA-256/);
  assert.throws(() => server.toApplyKPlusProviderLifetimeTransitionArgs({ ...base, purchaseRefDigest: 'A'.repeat(64) }), /SHA-256/);
  assert.throws(() => server.toApplyKPlusProviderLifetimeTransitionArgs({ ...base, lifecycleState: 'refunded' }), /disagree/);
  assert.throws(() => server.toApplyKPlusProviderLifetimeTransitionArgs({ ...base, providerEventType: 'refund', lifecycleState: 'active' }), /disagree/);
  assert.throws(() => server.toApplyKPlusProviderLifetimeTransitionArgs({ ...base, providerEventType: 'nonsense' }), /disagree/);
});

test('the lifetime contract cannot express a subscription: no period, renewal, trial, billing, grace or expiry field', () => {
  const source = fs.readFileSync(SERVER_CONTRACT_PATH, 'utf8');
  const start = source.indexOf('export interface KPlusLifetimeTransitionInput {');
  const block = source.slice(start, source.indexOf('\n}', start));
  const keys = [...block.matchAll(/^\s{2}([a-zA-Z]+)\??:/gm)].map((m) => m[1]);
  assert.ok(keys.length >= 10);
  for (const key of keys) {
    assert.doesNotMatch(key, /period|renew|trial|billing|grace|expires|pause|price|amount|currency|receipt|token|email/i, key);
  }
});

test('the lifetime digest is SHA-256 over a domain tag, so it can never collide with a subscription digest', async () => {
  const params = { provider: 'revenuecat', store: 'apple', environment: 'production' };
  const life = await server.deriveKPlusLifetimePurchaseRefDigest({ ...params, storePurchaseReference: '1000000123456789' });
  const expected = crypto.createHash('sha256').update('lifetime|revenuecat|apple|production|1000000123456789').digest('hex');
  assert.equal(life, expected);
  const sub = await server.deriveKPlusSubscriptionRefDigest({ ...params, storeSubscriptionReference: '1000000123456789' });
  assert.notEqual(life, sub, 'the same provider reference yields different digests for lifetime and subscription');
  assert.equal(await server.deriveKPlusLifetimePurchaseRefDigest({ ...params, storePurchaseReference: '  1000000123456789 ' }), life, 'whitespace-insensitive');
  assert.notEqual(await server.deriveKPlusLifetimePurchaseRefDigest({ ...params, environment: 'sandbox', storePurchaseReference: '1000000123456789' }), life, 'environment is part of the identity');
  assert.notEqual(await server.deriveKPlusLifetimePurchaseRefDigest({ ...params, store: 'google', storePurchaseReference: '1000000123456789' }), life, 'store is part of the identity');
  await assert.rejects(() => server.deriveKPlusLifetimePurchaseRefDigest({ ...params, storePurchaseReference: '   ' }));
});

test('RevenueCat normalization: a non-renewing purchase is a lifetime signal only; subscription mapping is unchanged', () => {
  assert.equal(server.REVENUECAT_EVENT_TYPE_TO_KPLUS_LIFETIME.NON_RENEWING_PURCHASE, 'lifetime_purchase');
  assert.equal(server.REVENUECAT_EVENT_TYPE_TO_KPLUS.NON_RENEWING_PURCHASE, null, 'a non-renewing purchase is not a subscription signal');
  assert.equal(server.REVENUECAT_EVENT_TYPE_TO_KPLUS_LIFETIME.RENEWAL, null);
  assert.equal(server.REVENUECAT_EVENT_TYPE_TO_KPLUS_LIFETIME.INITIAL_PURCHASE, null);
  assert.equal('CANCELLATION' in server.REVENUECAT_EVENT_TYPE_TO_KPLUS_LIFETIME, false,
    'a refund arrives as CANCELLATION with a reason; the adapter must inspect the reason, not map the type');
  for (const type of Object.values(server.REVENUECAT_EVENT_TYPE_TO_KPLUS_LIFETIME).filter(Boolean)) {
    assert.ok(plain(server.KPLUS_LIFETIME_PROVIDER_EVENT_TYPES).includes(type), type);
  }
});

test('store grants are exactly subscription and lifetime, and neither is a complimentary source', () => {
  assert.deepEqual(plain(server.KPLUS_STORE_GRANT_SOURCES), ['store_subscription', 'store_lifetime']);
  assert.ok(!plain(server.KPLUS_COMPLIMENTARY_SOURCES).includes('store_lifetime'));
  assert.deepEqual(
    plain(server.KPLUS_GRANT_SOURCES).filter((s) => !plain(server.KPLUS_STORE_GRANT_SOURCES).includes(s)).sort(),
    plain(server.KPLUS_COMPLIMENTARY_SOURCES).sort(),
  );
});

// ── Commercial values are not authorized here ────────────────────────────────

test('no Phase A file states a price, a trial length, a reminder timing or a store product', () => {
  const files = [MIGRATION_PATH, SERVER_CONTRACT_PATH, path.join(ROOT, 'types', 'kplusEntitlementContract.ts'),
    path.join(ROOT, 'services', 'kplus', 'kplusEntitlementReader.ts'), path.join(ROOT, 'services', 'kplus', 'kplusEntitlementStore.ts')];
  if (fs.existsSync(PGTAP_PATH)) files.push(PGTAP_PATH);
  if (fs.existsSync(DOC_PATH)) files.push(DOC_PATH);
  const nonZeroAmount = /(?:\$|USD\s?|EUR\s?|GBP\s?|£|€)\s?(?:[1-9]\d*(?:\.\d{1,2})?|0\.\d*[1-9])/;
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const rel = path.relative(ROOT, file);
    assert.doesNotMatch(text, nonZeroAmount, `${rel} must not state a price`);
    assert.doesNotMatch(text, /monthly_price|lifetime_price|price_usd(?!=0\b)|priceUsd|KPLUS_PRICE(?!_USD=0\b)|trial_days|trialDays|trial_duration|reminder_days|REMINDER_TIMING\s*=\s*\d/i, `${rel} must not define a commercial value`);
    assert.doesNotMatch(text, /K Scan(?! AI)/, `${rel} must say "K Scan AI"`);
  }
});

// ── The database-level matrix ────────────────────────────────────────────────

test('the pgTAP matrix exists, rolls back, and uses synthetic identities only', () => {
  assert.ok(fs.existsSync(PGTAP_PATH), 'supabase/tests/kplus_paid_lifetime_foundation_test.sql must exist');
  const sql = fs.readFileSync(PGTAP_PATH, 'utf8');
  assert.match(sql, /^begin;$/m);
  assert.match(sql, /^rollback;$/m);
  assert.match(sql, /kscan-test\.invalid/);
  assert.doesNotMatch(sql, /@(gmail|icloud|outlook|yahoo|hotmail)\./i, 'no real email domain');
  const assertions = sql.split('\n').filter((l) => /^select (ok|is|isnt|throws_ok|lives_ok)\(/.test(l)).length;
  assert.ok(assertions >= 120, `expected the full matrix, found ${assertions} assertions`);
  for (const section of ['A. Single sources', 'B. Coexistence', 'C. Required invariants', 'D. Provider authority', 'E. Shape and input hardening',
    'F. Legacy compatibility', 'G. Privilege boundary', 'H. Mirror and revocation']) {
    assert.ok(sql.includes(section), `section ${section}`);
  }
});
