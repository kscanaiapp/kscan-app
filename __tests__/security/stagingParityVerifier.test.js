#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  CLASSIFICATIONS: C,
  PRODUCTION_REF,
  DEFAULT_STAGING_REF,
  ProductionTargetError,
  assertNotProduction,
  compareStagingState,
} = require('../../security/scripts/verify-staging-parity');

const MANIFEST_PATH = path.join(__dirname, '..', '..', 'security', 'staging', 'staging-state-manifest.json');

// Every declared repo_source resolves; tests that need a missing file opt out explicitly.
const allPresent = () => true;

function baseManifest(overrides = {}) {
  return {
    staging_project_ref: DEFAULT_STAGING_REF,
    staging_branch: 'staging/production-parity',
    expected_branch_sha: 'abc123',
    migrations: [{ id: '20260101000000', name: 'init', repo_source: 'supabase/migrations/20260101000000_init.sql' }],
    tables: [{ id: 'profiles' }],
    rls: [{ id: 'profiles', rls_enabled: true, policy_count: 1 }],
    rpc_grants: [{
      id: 'public.do_thing()',
      security_definer: true,
      search_path: 'public',
      anon_execute: false,
      authenticated_execute: true,
      service_role_execute: true,
    }],
    storage: [{ id: 'legal-documents', public: true }],
    edge_functions: [{
      id: 'staging-health',
      verify_jwt: false,
      status: 'ACTIVE',
      ezbr_sha256: 'aaaa',
      repo_source: 'supabase/functions/staging-health/',
    }],
    known_exceptions: [],
    ...overrides,
  };
}

function baseObserved(overrides = {}) {
  return {
    project_ref: DEFAULT_STAGING_REF,
    branch_sha: 'abc123',
    migrations: [{ id: '20260101000000', name: 'init' }],
    tables: [{ id: 'profiles' }],
    rls: [{ id: 'profiles', rls_enabled: true, policy_count: 1 }],
    rpc_grants: [{
      id: 'public.do_thing()',
      security_definer: true,
      search_path: 'public',
      anon_execute: false,
      authenticated_execute: true,
      service_role_execute: true,
    }],
    storage: [{ id: 'legal-documents', public: true }],
    edge_functions: [{ id: 'staging-health', verify_jwt: false, status: 'ACTIVE', ezbr_sha256: 'aaaa' }],
    ...overrides,
  };
}

function run(manifest, observed, fileExists = allPresent) {
  return compareStagingState({ manifest, observed, repoRoot: '/repo', fileExists });
}

function classificationsFor(result, domain, id) {
  return result.findings.filter((f) => f.domain === domain && f.id === id).map((f) => f.classification);
}

test('exact match: identical live state reports ok with no blocking findings', () => {
  const result = run(baseManifest(), baseObserved());
  assert.equal(result.ok, true);
  assert.equal(result.summary.blockingCount, 0);
  assert.ok(result.summary.byClassification[C.MATCH] > 0);
});

test('missing repository migration source is a blocking MISSING_LIVE_OBJECT', () => {
  const result = run(baseManifest(), baseObserved(), () => false);
  assert.equal(result.ok, false);
  assert.deepEqual(classificationsFor(result, 'migration_source', '20260101000000'), [C.MISSING_LIVE_OBJECT]);
});

test('live migration with no repository source is UNTRACKED unless excepted', () => {
  const manifest = baseManifest({
    migrations: [{ id: '20260806153233', name: 'blocking', repo_source: null }],
  });
  const observed = baseObserved({ migrations: [{ id: '20260806153233', name: 'blocking' }] });

  const unexcepted = run(manifest, observed);
  assert.equal(unexcepted.ok, false);
  assert.deepEqual(classificationsFor(unexcepted, 'migration_source', '20260806153233'), [C.UNTRACKED_LIVE_OBJECT]);

  manifest.known_exceptions = [{ domain: 'migrations', id: '20260806153233', reason: 'documented', issue: 46 }];
  const excepted = run(manifest, observed);
  assert.equal(excepted.ok, true);
  assert.deepEqual(classificationsFor(excepted, 'migration_source', '20260806153233'), [C.EXPECTED_EXCEPTION]);
});

test('live-only Edge Function absent from the manifest is UNTRACKED_LIVE_OBJECT', () => {
  const observed = baseObserved({
    edge_functions: [
      { id: 'staging-health', verify_jwt: false, status: 'ACTIVE', ezbr_sha256: 'aaaa' },
      { id: 'public-sale-share-opt-out', verify_jwt: false, status: 'ACTIVE', ezbr_sha256: 'zzzz' },
    ],
  });
  const result = run(baseManifest(), observed);
  assert.equal(result.ok, false);
  assert.deepEqual(classificationsFor(result, 'edge_functions', 'public-sale-share-opt-out'), [C.UNTRACKED_LIVE_OBJECT]);
});

test('Edge Function with no repository source requires an explicit quarantine exception', () => {
  const manifest = baseManifest({
    edge_functions: [{ id: 'privacy-controls', verify_jwt: true, status: 'ACTIVE', ezbr_sha256: 'bbbb', repo_source: null }],
  });
  const observed = baseObserved({
    edge_functions: [{ id: 'privacy-controls', verify_jwt: true, status: 'ACTIVE', ezbr_sha256: 'bbbb' }],
  });

  const unexcepted = run(manifest, observed);
  assert.equal(unexcepted.ok, false);
  assert.deepEqual(classificationsFor(unexcepted, 'edge_function_source', 'privacy-controls'), [C.UNTRACKED_LIVE_OBJECT]);

  manifest.known_exceptions = [{
    domain: 'edge_functions',
    id: 'privacy-controls',
    reason: 'issue #46 quarantine',
    issue: 46,
  }];
  const excepted = run(manifest, observed);
  assert.equal(excepted.ok, true);
  assert.deepEqual(classificationsFor(excepted, 'edge_function_source', 'privacy-controls'), [C.EXPECTED_EXCEPTION]);
});

test('Edge Function bundle hash drift is SOURCE_HASH_MISMATCH', () => {
  const observed = baseObserved({
    edge_functions: [{ id: 'staging-health', verify_jwt: false, status: 'ACTIVE', ezbr_sha256: 'CHANGED' }],
  });
  const result = run(baseManifest(), observed);
  assert.equal(result.ok, false);
  assert.ok(classificationsFor(result, 'edge_functions', 'staging-health').includes(C.SOURCE_HASH_MISMATCH));
});

test('verify_jwt flip is CONFIGURATION_DRIFT, not a hash mismatch', () => {
  const observed = baseObserved({
    edge_functions: [{ id: 'staging-health', verify_jwt: true, status: 'ACTIVE', ezbr_sha256: 'aaaa' }],
  });
  const result = run(baseManifest(), observed);
  assert.equal(result.ok, false);
  assert.ok(classificationsFor(result, 'edge_functions', 'staging-health').includes(C.CONFIGURATION_DRIFT));
});

test('unexpected anon EXECUTE grant is PRIVILEGE_DRIFT', () => {
  const observed = baseObserved({
    rpc_grants: [{
      id: 'public.do_thing()',
      security_definer: true,
      search_path: 'public',
      anon_execute: true,
      authenticated_execute: true,
      service_role_execute: true,
    }],
  });
  const result = run(baseManifest(), observed);
  assert.equal(result.ok, false);
  assert.deepEqual(classificationsFor(result, 'rpc_grants', 'public.do_thing()'), [C.PRIVILEGE_DRIFT]);
});

test('search_path regression to mutable is CONFIGURATION_DRIFT', () => {
  const observed = baseObserved({
    rpc_grants: [{
      id: 'public.do_thing()',
      security_definer: true,
      search_path: null,
      anon_execute: false,
      authenticated_execute: true,
      service_role_execute: true,
    }],
  });
  const result = run(baseManifest(), observed);
  assert.equal(result.ok, false);
  assert.deepEqual(classificationsFor(result, 'rpc_grants', 'public.do_thing()'), [C.CONFIGURATION_DRIFT]);
});

test('storage bucket flipped to public is CONFIGURATION_DRIFT', () => {
  const manifest = baseManifest({ storage: [{ id: 'style-library-images', public: false }] });
  const observed = baseObserved({ storage: [{ id: 'style-library-images', public: true }] });
  const result = run(manifest, observed);
  assert.equal(result.ok, false);
  assert.deepEqual(classificationsFor(result, 'storage', 'style-library-images'), [C.CONFIGURATION_DRIFT]);
});

test('RLS disabled on a tracked table is CONFIGURATION_DRIFT', () => {
  const observed = baseObserved({ rls: [{ id: 'profiles', rls_enabled: false, policy_count: 1 }] });
  const result = run(baseManifest(), observed);
  assert.equal(result.ok, false);
  assert.ok(classificationsFor(result, 'rls', 'profiles').includes(C.CONFIGURATION_DRIFT));
});

test('object declared in manifest but absent live is MISSING_LIVE_OBJECT', () => {
  const observed = baseObserved({ migrations: [] });
  const result = run(baseManifest(), observed);
  assert.equal(result.ok, false);
  assert.deepEqual(classificationsFor(result, 'migrations', '20260101000000'), [C.MISSING_LIVE_OBJECT]);
});

test('missing evidence is OPERATIONAL_FAILURE and never reports MATCH', () => {
  const result = compareStagingState({ manifest: baseManifest(), observed: null, fileExists: allPresent });
  assert.equal(result.ok, false);
  assert.equal(result.summary.byClassification[C.OPERATIONAL_FAILURE], 1);
  assert.equal(result.summary.byClassification[C.MATCH], 0);
});

test('an uncollected domain is OPERATIONAL_FAILURE rather than silent parity', () => {
  const observed = baseObserved();
  delete observed.rpc_grants;
  const result = run(baseManifest(), observed);
  assert.equal(result.ok, false);
  assert.ok(result.findings.some((f) => f.domain === 'rpc_grants' && f.classification === C.OPERATIONAL_FAILURE));
});

test('an observed record missing a compared field is OPERATIONAL_FAILURE', () => {
  const observed = baseObserved({
    rpc_grants: [{ id: 'public.do_thing()', security_definer: true, search_path: 'public', authenticated_execute: true, service_role_execute: true }],
  });
  const result = run(baseManifest(), observed);
  assert.equal(result.ok, false);
  assert.ok(classificationsFor(result, 'rpc_grants', 'public.do_thing()').includes(C.OPERATIONAL_FAILURE));
});

test('production project ref in the manifest is refused immediately', () => {
  const manifest = baseManifest({ staging_project_ref: PRODUCTION_REF });
  assert.throws(
    () => run(manifest, baseObserved()),
    (error) => error instanceof ProductionTargetError && error.code === 'PRODUCTION_TARGET_DETECTED',
  );
});

test('production project ref in observed evidence is refused immediately', () => {
  const observed = baseObserved({ project_ref: PRODUCTION_REF });
  assert.throws(
    () => run(baseManifest(), observed),
    (error) => error.code === 'PRODUCTION_TARGET_DETECTED',
  );
});

test('assertNotProduction allows the staging ref and rejects the production ref', () => {
  assert.doesNotThrow(() => assertNotProduction(DEFAULT_STAGING_REF, 'test'));
  assert.throws(() => assertNotProduction(PRODUCTION_REF, 'test'), ProductionTargetError);
});

test('branch sha drift is reported as CONFIGURATION_DRIFT', () => {
  const result = run(baseManifest(), baseObserved({ branch_sha: 'deadbeef' }));
  assert.equal(result.ok, false);
  assert.ok(classificationsFor(result, 'evidence', 'branch_sha').includes(C.CONFIGURATION_DRIFT));
});

// ---- checked-in manifest invariants ----

test('checked-in manifest targets staging and never production', () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  assert.equal(manifest.staging_project_ref, DEFAULT_STAGING_REF);
  assert.notEqual(manifest.staging_project_ref, PRODUCTION_REF);
  assert.equal(manifest.staging_branch, 'staging/production-parity');
  assert.doesNotThrow(() => assertNotProduction(manifest.staging_project_ref, 'manifest'));
});

test('checked-in manifest carries no secret material', () => {
  const raw = fs.readFileSync(MANIFEST_PATH, 'utf8');
  const manifest = JSON.parse(raw);

  // Secret NAMES are permitted and expected; secret VALUES are not. Walk the
  // string values so an allowlisted name like SUPABASE_STAGING_SERVICE_ROLE_KEY
  // is not mistaken for the credential itself.
  const credentialShapes = [
    { re: /\beyJ[A-Za-z0-9_-]{20,}\./, label: 'JWT' },
    { re: /\bsb_(secret|publishable)_[A-Za-z0-9_-]{10,}/, label: 'Supabase API key' },
    { re: /postgres(?:ql)?:\/\/[^\s"]*:[^\s"@]+@/, label: 'database URL with password' },
    { re: /\bgh[pousr]_[A-Za-z0-9]{20,}/, label: 'GitHub token' },
  ];

  const offenders = [];
  const walk = (node, pathParts) => {
    if (typeof node === 'string') {
      for (const { re, label } of credentialShapes) {
        if (re.test(node)) offenders.push(`${pathParts.join('.')}: ${label}`);
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, [...pathParts, i]));
      return;
    }
    if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) walk(value, [...pathParts, key]);
    }
  };
  walk(manifest, ['manifest']);

  assert.deepEqual(offenders, [], `manifest must not embed credential values: ${offenders.join(', ')}`);
  assert.equal(manifest.production_project_ref_blocked, PRODUCTION_REF,
    'production ref may appear only as the explicitly blocked value');
});

test('every checked-in Edge Function without repo source has a quarantine exception', () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const unsourced = manifest.edge_functions.filter((fn) => !fn.repo_source);
  assert.ok(unsourced.length > 0, 'fixture expects at least one quarantined function');
  for (const fn of unsourced) {
    const ex = manifest.known_exceptions.find((e) => e.domain === 'edge_functions' && e.id === fn.id);
    assert.ok(ex, `missing quarantine exception for ${fn.id}`);
    assert.equal(ex.deployment_policy, 'DO_NOT_REDEPLOY');
    assert.equal(ex.modification_policy, 'SOURCE_RECOVERY_REQUIRED');
    assert.equal(ex.security_status, 'DEPLOYMENT_UNVERIFIED');
  }
});

test('checked-in manifest has every live migration backed by repository source', () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const repoRoot = path.join(__dirname, '..', '..');
  const unsourced = manifest.migrations.filter((m) => !m.repo_source);
  const excepted = new Set(manifest.known_exceptions.filter((e) => e.domain === 'migrations').map((e) => e.id));
  for (const m of unsourced) {
    assert.ok(excepted.has(m.id), `live migration ${m.id} has neither repository source nor a documented exception`);
  }
  for (const m of manifest.migrations.filter((x) => x.repo_source)) {
    assert.ok(fs.existsSync(path.join(repoRoot, m.repo_source)), `declared migration source missing: ${m.repo_source}`);
  }
});
