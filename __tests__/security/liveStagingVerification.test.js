#!/usr/bin/env node
'use strict';

/**
 * Coverage for the live staging RLS/grant/Storage verification wiring
 * (query-staging-metadata.js + verify-live-staging-security.js). Every
 * scenario Phase 3 of the task brief lists explicitly: missing credential,
 * malformed credential, production credential, staging credential, query
 * failure, timeout, unexpected anon grant, missing RLS, public bucket,
 * uncontrolled search_path, successful verified state.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  queryStagingMetadata,
  classifyTargetRef,
  wrapReadOnly,
  redact,
  PRODUCTION_PROJECT_REF,
  STAGING_PROJECT_REF,
} = require('../../security/scripts/query-staging-metadata');
const { evaluate } = require('../../security/scripts/verify-live-staging-security');

function fakeFetch(status, body) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}

// Cycles through the fixed QUERIES call order so each metadata field gets a
// distinct fixture value from a single sequential mock.
function sequencedFetch(bodies) {
  let i = 0;
  return async () => {
    const body = bodies[Math.min(i, bodies.length - 1)];
    i += 1;
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
}

test('classifyTargetRef: no ref supplied is BLOCKED, not a silent pass', () => {
  const result = classifyTargetRef(undefined);
  assert.equal(result.ok, false);
  assert.equal(result.status, 'BLOCKED');
});

test('classifyTargetRef: production ref is BLOCKED', () => {
  const result = classifyTargetRef(PRODUCTION_PROJECT_REF);
  assert.equal(result.ok, false);
  assert.equal(result.status, 'BLOCKED');
});

test('classifyTargetRef: staging ref is allowed', () => {
  assert.equal(classifyTargetRef(STAGING_PROJECT_REF).ok, true);
});

test('classifyTargetRef: an unrecognized ref (neither staging nor production) is BLOCKED', () => {
  const result = classifyTargetRef('some-other-project-ref');
  assert.equal(result.ok, false);
  assert.equal(result.status, 'BLOCKED');
});

test('wrapReadOnly: every query is wrapped in an explicit read-only transaction with a short timeout', () => {
  const wrapped = wrapReadOnly('select 1;', 5000);
  assert.match(wrapped, /^begin read only;/);
  assert.match(wrapped, /statement_timeout = '5000ms'/);
  assert.match(wrapped, /commit;$/);
});

test('redact: strips a bearer token out of an error message', () => {
  const redacted = redact('failed with Authorization: Bearer sbp_abcdef1234567890');
  assert.ok(!redacted.includes('sbp_abcdef1234567890'));
});

test('queryStagingMetadata: missing credential -> NOT_CONFIGURED, no network call attempted', async () => {
  let called = false;
  const result = await queryStagingMetadata({
    projectRef: STAGING_PROJECT_REF,
    accessToken: undefined,
    fetchImpl: async () => { called = true; return { ok: true, status: 200, json: async () => ({}) }; },
  });
  assert.equal(result.status, 'NOT_CONFIGURED');
  assert.equal(called, false);
});

test('queryStagingMetadata: production project ref is BLOCKED before any network call', async () => {
  let called = false;
  const result = await queryStagingMetadata({
    projectRef: PRODUCTION_PROJECT_REF,
    accessToken: 'fake-token',
    fetchImpl: async () => { called = true; return { ok: true, status: 200, json: async () => ({}) }; },
  });
  assert.equal(result.status, 'BLOCKED');
  assert.equal(called, false);
});

test('queryStagingMetadata: malformed/rejected credential (401) -> OPERATIONAL_FAILURE, not NOT_CONFIGURED', async () => {
  const result = await queryStagingMetadata({
    projectRef: STAGING_PROJECT_REF,
    accessToken: 'wrong-token',
    fetchImpl: fakeFetch(401, { message: 'Invalid API key' }),
  });
  assert.equal(result.status, 'OPERATIONAL_FAILURE');
  assert.equal(result.classification, 'MALFORMED_CREDENTIAL');
});

test('queryStagingMetadata: query failure (non-auth error status) -> OPERATIONAL_FAILURE', async () => {
  const result = await queryStagingMetadata({
    projectRef: STAGING_PROJECT_REF,
    accessToken: 'a-token',
    fetchImpl: fakeFetch(400, { message: 'syntax error' }),
  });
  assert.equal(result.status, 'OPERATIONAL_FAILURE');
  assert.equal(result.classification, 'QUERY_FAILURE');
});

test('queryStagingMetadata: timeout -> OPERATIONAL_FAILURE, not a hang', async () => {
  const hangingFetch = async (url, opts) => new Promise((resolve, reject) => {
    opts.signal.addEventListener('abort', () => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      reject(err);
    });
  });
  const result = await queryStagingMetadata({
    projectRef: STAGING_PROJECT_REF,
    accessToken: 'a-token',
    timeoutMs: 20,
    fetchImpl: hangingFetch,
  });
  assert.equal(result.status, 'OPERATIONAL_FAILURE');
  assert.equal(result.classification, 'TIMEOUT');
});

test('queryStagingMetadata: staging credential + successful responses -> COLLECTED with all five datasets', async () => {
  const result = await queryStagingMetadata({
    projectRef: STAGING_PROJECT_REF,
    accessToken: 'a-token',
    fetchImpl: sequencedFetch([
      [{ tableName: 'profiles', rlsEnabled: true }],
      [{ functionName: 'get_public_room_preview', anonCanExecute: true }],
      [{ functionName: 'get_public_room_preview', securityDefiner: true, searchPathSetting: 'search_path=public' }],
      [{ name: 'style-library-images', public: false, fileSizeLimit: 5242880, allowedMimeTypes: ['image/png'] }],
      [],
    ]),
  });
  assert.equal(result.status, 'COLLECTED');
  assert.equal(result.tables.length, 1);
  assert.equal(result.grants.length, 1);
  assert.equal(result.definerFunctions.length, 1);
  assert.equal(result.buckets.length, 1);
  assert.deepEqual(result.verdictWriteGrants, []);
});

test('evaluate: fully clean metadata -> overall PASS', () => {
  const metadata = {
    tables: [{ tableName: 'profiles', rlsEnabled: true }],
    grants: [{ functionName: 'get_public_room_preview', anonCanExecute: true }],
    definerFunctions: [{ functionName: 'get_public_room_preview', securityDefiner: true, searchPathSetting: 'search_path=public' }],
    buckets: [{ name: 'style-library-images', public: false, fileSizeLimit: 5242880, allowedMimeTypes: ['image/png'] }],
    verdictWriteGrants: [],
  };
  const report = evaluate(metadata);
  assert.equal(report.overall, 'PASS');
});

test('evaluate: an unintended anon grant fails the anonGrants dimension only', () => {
  const metadata = {
    tables: [],
    grants: [{ functionName: 'revoke_user_sessions', anonCanExecute: true }],
    definerFunctions: [],
    buckets: [],
    verdictWriteGrants: [],
  };
  const report = evaluate(metadata);
  assert.equal(report.overall, 'FAIL');
  assert.equal(report.findings.anonGrants.status, 'FAIL');
  assert.deepEqual(report.findings.anonGrants.unintendedAnonGrants, ['revoke_user_sessions']);
  assert.equal(report.findings.rls.status, 'PASS');
});

test('evaluate: a table with RLS disabled fails the rls dimension', () => {
  const metadata = {
    tables: [{ tableName: 'new_unprotected_table', rlsEnabled: false }],
    grants: [],
    definerFunctions: [],
    buckets: [],
    verdictWriteGrants: [],
  };
  const report = evaluate(metadata);
  assert.equal(report.overall, 'FAIL');
  assert.deepEqual(report.findings.rls.tablesWithoutRls, ['new_unprotected_table']);
});

test('evaluate: an unallowlisted public bucket fails the storage dimension', () => {
  const metadata = {
    tables: [],
    grants: [],
    definerFunctions: [],
    buckets: [{ name: 'accidental-public-bucket', public: true, fileSizeLimit: null, allowedMimeTypes: null }],
    verdictWriteGrants: [],
  };
  const report = evaluate(metadata);
  assert.equal(report.overall, 'FAIL');
  assert.equal(report.findings.storage.status, 'FAIL');
  assert.deepEqual(report.findings.storage.unexpectedPublicBuckets, ['accidental-public-bucket']);
});

test('evaluate: a SECURITY DEFINER function without search_path fails the securityDefiner dimension', () => {
  const metadata = {
    tables: [],
    grants: [],
    definerFunctions: [{ functionName: 'risky_definer_fn', securityDefiner: true, searchPathSetting: null }],
    buckets: [],
    verdictWriteGrants: [],
  };
  const report = evaluate(metadata);
  assert.equal(report.overall, 'FAIL');
  assert.deepEqual(report.findings.securityDefiner.definerFunctionsWithoutSearchPath, ['risky_definer_fn']);
});

test('evaluate: a client role able to write image_scan_verdicts fails verdictWriteProtection', () => {
  const metadata = {
    tables: [],
    grants: [],
    definerFunctions: [],
    buckets: [],
    verdictWriteGrants: [{ grantee: 'authenticated', privilege_type: 'INSERT' }],
  };
  const report = evaluate(metadata);
  assert.equal(report.overall, 'FAIL');
  assert.deepEqual(report.findings.verdictWriteProtection.unexpectedGrants, ['authenticated:INSERT']);
});

test('evaluate: authenticated EXECUTE on a service-role-only function fails serviceRoleOnlyGrants (2026-08-06 regression)', () => {
  const metadata = {
    tables: [],
    grants: [{ functionName: 'revoke_user_sessions', anonCanExecute: false, authenticatedCanExecute: true }],
    definerFunctions: [],
    buckets: [],
    verdictWriteGrants: [],
  };
  const report = evaluate(metadata);
  assert.equal(report.overall, 'FAIL');
  assert.deepEqual(report.findings.serviceRoleOnlyGrants.unexpectedAuthenticatedGrants, ['revoke_user_sessions']);
});

test('evaluate: authenticated EXECUTE on an ordinary (non-denylisted) function does not fail serviceRoleOnlyGrants', () => {
  const metadata = {
    tables: [],
    grants: [{ functionName: 'register_user_device_session', anonCanExecute: false, authenticatedCanExecute: true }],
    definerFunctions: [],
    buckets: [],
    verdictWriteGrants: [],
  };
  const report = evaluate(metadata);
  assert.equal(report.overall, 'PASS');
});
