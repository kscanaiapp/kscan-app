#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { compareRpcGrants, CLASSIFICATIONS: C, PRODUCTION_REF } = require('../../security/scripts/verify-rpc-policy');

const ROOT = path.join(__dirname, '..', '..');
const POLICY_PATH = path.join(ROOT, 'security', 'staging', 'rpc-access-policy.json');
const SEARCH_PATH_MIGRATION = path.join(ROOT, 'supabase', 'migrations', '20260808115552_harden_trigger_function_search_path.sql');
const PRIVILEGE_MIGRATION = path.join(ROOT, 'supabase', 'migrations', '20260808115735_enforce_rpc_privilege_boundary.sql');

const policy = JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8'));

const VALID_CLASSIFICATIONS = new Set([
  'PUBLIC_INTENTIONAL',
  'AUTHENTICATED_INTENTIONAL',
  'SERVICE_ROLE_ONLY',
  'TRIGGER_ONLY',
  'INTERNAL_ONLY',
]);

function fixturePolicy(fn) {
  return {
    staging_project_ref: 'yzqjvdfgefveprobvvyw',
    functions: [{
      signature: 'public.worker_fn(uuid)',
      name: 'worker_fn',
      classification: 'SERVICE_ROLE_ONLY',
      search_path: 'public',
      expected_anon_execute: false,
      expected_authenticated_execute: false,
      expected_service_role_execute: true,
      ...fn,
    }],
  };
}

function observedGrants(row) {
  return {
    project_ref: 'yzqjvdfgefveprobvvyw',
    rpc_grants: [{
      id: 'public.worker_fn(uuid)',
      security_definer: true,
      search_path: 'public',
      anon_execute: false,
      authenticated_execute: false,
      service_role_execute: true,
      ...row,
    }],
  };
}

test('policy-conformant grants report MATCH', () => {
  const result = compareRpcGrants({ policy: fixturePolicy(), observed: observedGrants() });
  assert.equal(result.ok, true);
  assert.equal(result.summary.byClassification[C.MATCH], 1);
});

test('new anonymous SECURITY DEFINER exposure is flagged HIGH', () => {
  const result = compareRpcGrants({ policy: fixturePolicy(), observed: observedGrants({ anon_execute: true }) });
  assert.equal(result.ok, false);
  assert.deepEqual(result.summary.anonSecurityDefinerExposures, ['public.worker_fn(uuid)']);
  const drift = result.findings.find((f) => f.classification === C.PRIVILEGE_DRIFT);
  assert.equal(drift.severity, 'HIGH');
});

test('anon access on a PUBLIC_INTENTIONAL function is not an exposure', () => {
  const result = compareRpcGrants({
    policy: fixturePolicy({ classification: 'PUBLIC_INTENTIONAL', expected_anon_execute: true, expected_authenticated_execute: true }),
    observed: observedGrants({ anon_execute: true, authenticated_execute: true }),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.summary.anonSecurityDefinerExposures, []);
});

test('new authenticated exposure outside the allowlist is PRIVILEGE_DRIFT', () => {
  const result = compareRpcGrants({ policy: fixturePolicy(), observed: observedGrants({ authenticated_execute: true }) });
  assert.equal(result.ok, false);
  const drift = result.findings.find((f) => f.classification === C.PRIVILEGE_DRIFT);
  assert.match(drift.detail, /authenticated_execute: unexpected grant present/);
});

test('service-role-only RPC made client-callable is caught on both roles', () => {
  const result = compareRpcGrants({
    policy: fixturePolicy(),
    observed: observedGrants({ anon_execute: true, authenticated_execute: true }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.findings.filter((f) => f.classification === C.PRIVILEGE_DRIFT).length, 2);
});

test('missing expected application RPC access is reported, not silently accepted', () => {
  const result = compareRpcGrants({
    policy: fixturePolicy({ classification: 'AUTHENTICATED_INTENTIONAL', expected_authenticated_execute: true }),
    observed: observedGrants({ authenticated_execute: false }),
  });
  assert.equal(result.ok, false);
  const drift = result.findings.find((f) => f.classification === C.PRIVILEGE_DRIFT);
  assert.equal(drift.missingExpectedAccess, true);
  assert.match(drift.detail, /expected access missing/);
});

test('search_path regression to mutable is CONFIGURATION_DRIFT', () => {
  const result = compareRpcGrants({ policy: fixturePolicy(), observed: observedGrants({ search_path: null }) });
  assert.equal(result.ok, false);
  assert.ok(result.findings.some((f) => f.classification === C.CONFIGURATION_DRIFT));
});

test('a live function absent from the policy is UNTRACKED_LIVE_OBJECT', () => {
  const observed = observedGrants();
  observed.rpc_grants.push({
    id: 'public.brand_new_fn()',
    security_definer: true,
    search_path: 'public',
    anon_execute: true,
    authenticated_execute: true,
    service_role_execute: true,
  });
  const result = compareRpcGrants({ policy: fixturePolicy(), observed });
  assert.equal(result.ok, false);
  const untracked = result.findings.find((f) => f.classification === C.UNTRACKED_LIVE_OBJECT);
  assert.equal(untracked.id, 'public.brand_new_fn()');
  assert.equal(untracked.severity, 'HIGH');
});

test('a policy function absent from live is MISSING_LIVE_OBJECT', () => {
  const result = compareRpcGrants({ policy: fixturePolicy(), observed: { project_ref: 'yzqjvdfgefveprobvvyw', rpc_grants: [] } });
  assert.equal(result.ok, false);
  assert.ok(result.findings.some((f) => f.classification === C.MISSING_LIVE_OBJECT));
});

test('missing policy evidence is OPERATIONAL_FAILURE and never MATCH', () => {
  const result = compareRpcGrants({ policy: fixturePolicy(), observed: null });
  assert.equal(result.ok, false);
  assert.equal(result.summary.byClassification[C.OPERATIONAL_FAILURE], 1);
  assert.equal(result.summary.byClassification[C.MATCH], 0);
});

test('an observed row missing a grant field is OPERATIONAL_FAILURE', () => {
  const observed = observedGrants();
  delete observed.rpc_grants[0].anon_execute;
  const result = compareRpcGrants({ policy: fixturePolicy(), observed });
  assert.equal(result.ok, false);
  assert.ok(result.findings.some((f) => f.classification === C.OPERATIONAL_FAILURE));
});

test('production project ref is refused outright', () => {
  assert.throws(
    () => compareRpcGrants({ policy: fixturePolicy({}), observed: { project_ref: PRODUCTION_REF, rpc_grants: [] } }),
    (error) => error.code === 'PRODUCTION_TARGET_DETECTED',
  );
  const productionPolicy = fixturePolicy();
  productionPolicy.staging_project_ref = PRODUCTION_REF;
  assert.throws(
    () => compareRpcGrants({ policy: productionPolicy, observed: observedGrants() }),
    (error) => error.code === 'PRODUCTION_TARGET_DETECTED',
  );
});

// ---- checked-in policy invariants ----

test('checked-in policy targets staging and classifies every function', () => {
  assert.equal(policy.staging_project_ref, 'yzqjvdfgefveprobvvyw');
  assert.notEqual(policy.staging_project_ref, PRODUCTION_REF);
  assert.ok(policy.functions.length > 0);
  for (const fn of policy.functions) {
    assert.ok(VALID_CLASSIFICATIONS.has(fn.classification), `${fn.signature} has invalid classification ${fn.classification}`);
    assert.ok(fn.reason && fn.reason.length > 10, `${fn.signature} needs a reason`);
    assert.ok(Array.isArray(fn.callers) && fn.callers.length > 0, `${fn.signature} needs recorded callers`);
    assert.equal(typeof fn.expected_anon_execute, 'boolean');
    assert.equal(typeof fn.expected_authenticated_execute, 'boolean');
    assert.equal(typeof fn.expected_service_role_execute, 'boolean');
  }
});

test('no SERVICE_ROLE_ONLY or TRIGGER_ONLY function expects client access', () => {
  for (const fn of policy.functions) {
    if (fn.classification !== 'SERVICE_ROLE_ONLY' && fn.classification !== 'TRIGGER_ONLY') continue;
    assert.equal(fn.expected_anon_execute, false, `${fn.signature} must not expect anon EXECUTE`);
    assert.equal(fn.expected_authenticated_execute, false, `${fn.signature} must not expect authenticated EXECUTE`);
  }
});

test('only the reviewed public share-link contract expects anon EXECUTE', () => {
  const anonExpected = policy.functions.filter((f) => f.expected_anon_execute).map((f) => f.name).sort();
  assert.deepEqual(anonExpected, [
    'get_item_reaction_counts',
    'get_public_room_decision_preview',
    'get_public_room_preview',
  ]);
});

test('every declared remediation is actually implemented by the migrations', () => {
  const searchPathSql = fs.readFileSync(SEARCH_PATH_MIGRATION, 'utf8');
  const privilegeSql = fs.readFileSync(PRIVILEGE_MIGRATION, 'utf8');

  for (const signature of policy.remediation_summary.revoke_anon) {
    assert.ok(
      privilegeSql.includes(`revoke execute on function ${signature} from anon;`),
      `privilege migration is missing the anon revoke for ${signature}`,
    );
  }
  for (const signature of policy.remediation_summary.revoke_authenticated) {
    assert.ok(
      privilegeSql.includes(`revoke execute on function ${signature} from authenticated;`),
      `privilege migration is missing the authenticated revoke for ${signature}`,
    );
  }
  for (const signature of policy.remediation_summary.harden_search_path) {
    assert.ok(
      searchPathSql.includes(`alter function ${signature} set search_path`),
      `search_path migration is missing ${signature}`,
    );
  }
});

test('privilege migration never revokes a reviewed public or authenticated contract', () => {
  const privilegeSql = fs.readFileSync(PRIVILEGE_MIGRATION, 'utf8');
  for (const fn of policy.functions) {
    if (fn.expected_anon_execute) {
      assert.ok(
        !privilegeSql.includes(`revoke execute on function ${fn.signature} from anon;`),
        `${fn.signature} is a public contract and must keep anon EXECUTE`,
      );
    }
    if (fn.expected_authenticated_execute) {
      assert.ok(
        !privilegeSql.includes(`revoke execute on function ${fn.signature} from authenticated;`),
        `${fn.signature} is an authenticated contract and must keep authenticated EXECUTE`,
      );
    }
  }
});

test('privilege migration is revoke-only apart from the reviewed internal-schema repair', () => {
  const privilegeSql = fs.readFileSync(PRIVILEGE_MIGRATION, 'utf8');
  const grants = privilegeSql
    .split('\n')
    .filter((line) => /^\s*grant /i.test(line))
    .map((line) => line.trim());
  assert.deepEqual(grants, ['grant usage on schema internal to authenticated;']);
  assert.doesNotMatch(privilegeSql, /^\s*(drop|truncate|delete|alter table)\b/im);
  assert.ok(privilegeSql.includes('revoke all on schema internal from anon;'),
    'anon must remain without USAGE on the internal schema');
});

test('search_path migration only attaches configuration and never redefines a function', () => {
  const sql = fs.readFileSync(SEARCH_PATH_MIGRATION, 'utf8');
  const statements = sql.split('\n').filter((line) => line.trim() && !line.trim().startsWith('--'));
  for (const statement of statements) {
    assert.match(statement.trim(), /^alter function public\.[a-z_]+\(\) set search_path = pg_catalog, public;$/,
      `unexpected statement in search_path migration: ${statement}`);
  }
  assert.doesNotMatch(sql, /create or replace function/i);
});

test('every RLS-enabled table with no policy is documented as intentional deny-all', () => {
  const documented = policy.rls_enabled_no_policy_expected;
  assert.ok(Array.isArray(documented));

  // Named rather than counted, so adding a deny-all table is a deliberate,
  // reviewable edit here instead of a number that quietly drifts.
  assert.deepEqual(documented.map((e) => e.table).sort(), [
    'internal.edge_function_errors',
    'public.deletion_state_transitions',
    'public.privacy_request_rate_limits',
    'public.product_catalog',
    'public.provider_request_limits',
    'public.provider_security_events',
    'public.style_chat_burst_usage',
    'public.style_outfit_burst_usage',
    'public.stylechat_quota_events',
    'public.waitlist_signups',
  ]);

  for (const entry of documented) {
    assert.match(entry.table, /^(public|internal)\./);
    assert.ok(entry.reason && entry.reason.length > 20, `${entry.table} needs a documented reason`);
  }
});
