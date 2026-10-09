'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const probe = require('../security/release/run-kplus-activate-hold-live-probe');

const ROOT = path.resolve(__dirname, '..');
const STAGING_REF = 'yzqjvdfgefveprobvvyw';
const PRODUCTION_REF = 'wyyuqfdxucjksghsmhry';
const ACTOR = '11111111-1111-4111-8111-111111111111';

function b64url(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}
const TOKEN = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ sub: ACTOR, role: 'authenticated' })}.signature`;

function env(overrides = {}) {
  return {
    SUPABASE_STAGING_PROJECT_REF: STAGING_REF,
    SUPABASE_STAGING_URL: `https://${STAGING_REF}.supabase.co`,
    SUPABASE_STAGING_PUBLISHABLE_KEY: 'publishable-test-key',
    SUPABASE_ACCESS_TOKEN: 'management-test-token',
    STAGING_SYNTHETIC_ACTIVE_EMAIL: 'synthetic-active@kscan-test.invalid',
    STAGING_SYNTHETIC_ACTIVE_PASSWORD: 'synthetic-password',
    ...overrides,
  };
}

/**
 * A fake of exactly the four surfaces the probe touches. `behavior.function`:
 *   'hold'        -> deployed hold: 403 CAMPAIGN_CLOSED, nothing written
 *   'vulnerable'  -> the pre-#528 function: 200 + a grant row + a completion log
 */
function fakeSupabase(behavior = {}) {
  const state = {
    calls: [],
    counts: { user_entitlements: 0, kplus_entitlement_grants: 0, kplus_activation_events: 0, kplus_entitlement_activations: 0, ...(behavior.initialCounts ?? {}) },
    closedLogs: 0,
    completedLogs: 0,
  };
  const json = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body), json: async () => body });
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    const method = (init.method ?? 'GET').toUpperCase();
    state.calls.push(`${method} ${url.replace(/^https:\/\/[^/]+/, '').split('?')[0]}`);
    if (url.includes('/auth/v1/token')) return json(200, { access_token: TOKEN });
    if (url.endsWith('/secrets')) {
      return behavior.secretsUnreadable
        ? json(403, {})
        : json(200, (behavior.controlsPresent ?? []).map((name) => ({ name, value: 'digest' })).concat([{ name: 'SOME_OTHER_SECRET', value: 'digest' }]));
    }
    if (url.endsWith('/database/query')) {
      return behavior.stateUnreadable ? json(500, {}) : json(200, Object.entries(state.counts).map(([t, n]) => ({ t, n })));
    }
    if (url.includes('/analytics/endpoints/logs')) {
      if (behavior.logsUnreadable) return json(500, {});
      const rows = [];
      for (let i = 0; i < state.closedLogs; i += 1) rows.push({ event_message: '{"event":"kplus_early_access_campaign_closed"}' });
      for (let i = 0; i < state.completedLogs; i += 1) rows.push({ event_message: '{"event":"kplus_activation_completed"}' });
      return json(200, { result: rows });
    }
    if (url.includes('/functions/v1/kplus-activate')) {
      const authorization = init.headers?.Authorization;
      if (!authorization) return json(401, { message: 'Missing authorization header' });
      if (authorization === 'Bearer not-a-real-jwt-at-all') return json(401, { message: 'Invalid JWT' });
      if (method !== 'POST') return json(405, { error: 'Method not allowed' });
      if ((behavior.function ?? 'hold') === 'vulnerable') {
        state.counts.user_entitlements += 1;
        state.counts.kplus_activation_events += 1;
        state.completedLogs += 1;
        return json(200, { entitlementKey: 'k_plus', campaignStatus: 'granted', expiresAt: '2027-04-08T00:00:00Z' });
      }
      state.closedLogs += 1;
      return json(403, { error: 'Early Access activation is unavailable.', code: 'CAMPAIGN_CLOSED' });
    }
    throw new Error(`unexpected request ${method} ${url}`);
  };
  return { state, fetchImpl };
}

const FAST_LOGS = { logPolling: { attempts: 2, delayMs: 0, sleep: async () => {} } };

test('the deployed hold passes every finding and leaves the actor state untouched', async () => {
  const { state, fetchImpl } = fakeSupabase();
  const report = await probe.run(env(), fetchImpl, FAST_LOGS);
  for (const [name, finding] of Object.entries(report.findings)) assert.equal(finding.pass, true, name);
  assert.deepEqual(report.findings.entitlementStateUnchanged.before, report.findings.entitlementStateUnchanged.after);
  assert.equal(report.findings.denialLoggedWithoutCompletion.closedCount, 2);
  assert.equal(state.calls.filter((c) => c === 'POST /functions/v1/kplus-activate').length, 4, 'anonymous, invalid-token and two authenticated POSTs');
  assert.equal(state.calls.filter((c) => c === 'GET /functions/v1/kplus-activate').length, 1, 'one non-POST method check');
});

test('MUTATION: the pre-#528 vulnerable function is caught (grant returned, rows written, completion logged)', async () => {
  const { fetchImpl } = fakeSupabase({ function: 'vulnerable' });
  const report = await probe.run(env(), fetchImpl, FAST_LOGS);
  assert.equal(report.findings.authenticatedDenied.pass, false);
  assert.equal(report.findings.authenticatedDenied.grantFieldsPresent, true);
  assert.equal(report.findings.repeatedRequestDenied.pass, false);
  assert.equal(report.findings.entitlementStateUnchanged.pass, false);
  assert.equal(report.findings.denialLoggedWithoutCompletion.pass, false);
});

test('campaign controls present (or unreadable) abort BEFORE any authenticated call', async () => {
  for (const behavior of [{ controlsPresent: ['KPLUS_EARLY_ACCESS_ENABLED'] }, { secretsUnreadable: true }]) {
    const { state, fetchImpl } = fakeSupabase(behavior);
    const report = await probe.run(env(), fetchImpl, FAST_LOGS);
    assert.equal(report.findings.campaignControlsAbsent.pass, false);
    assert.match(report.aborted, /no authenticated call made/);
    assert.equal(state.calls.some((c) => c.includes('/auth/v1/token') || c.includes('/functions/v1/')), false, 'no sign-in and no function call');
  }
});

test('unreadable state or logs fail closed instead of passing silently', async () => {
  const unreadableState = await probe.run(env(), fakeSupabase({ stateUnreadable: true }).fetchImpl, FAST_LOGS);
  assert.equal(unreadableState.findings.stateReadBefore.pass, false);
  assert.equal(unreadableState.findings.entitlementStateUnchanged.pass, false);
  const unreadableLogs = await probe.run(env(), fakeSupabase({ logsUnreadable: true }).fetchImpl, FAST_LOGS);
  assert.equal(unreadableLogs.findings.denialLoggedWithoutCompletion.pass, false);
  assert.equal(unreadableLogs.findings.denialLoggedWithoutCompletion.logsReadable, false);
});

test('production and unexpected targets are refused before any network call', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; throw new Error('must not be called'); };
  await assert.rejects(probe.run(env({ SUPABASE_STAGING_PROJECT_REF: PRODUCTION_REF }), fetchImpl), /production/);
  await assert.rejects(probe.run(env({ SUPABASE_STAGING_URL: `https://${PRODUCTION_REF}.supabase.co` }), fetchImpl), /production/);
  await assert.rejects(probe.run(env({ SUPABASE_STAGING_PROJECT_REF: 'someotherprojectref' }), fetchImpl), /not the staging project/);
  await assert.rejects(probe.run(env({ SUPABASE_ACCESS_TOKEN: '' }), fetchImpl), /missing required env vars/);
  assert.equal(called, false);
});

test('the report never carries a token, email, user id or management token shape', async () => {
  const report = await probe.run(env(), fakeSupabase().fetchImpl, FAST_LOGS);
  assert.doesNotThrow(() => probe.assertEvidencePrivacy(report));
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes(ACTOR), false);
  assert.equal(serialized.includes('kscan-test.invalid'), false);
  assert.equal(serialized.includes(TOKEN), false);
  for (const leak of [ACTOR, 'someone@example.com', TOKEN, 'sbp_abcdefghijklmnop']) {
    assert.throws(() => probe.assertEvidencePrivacy({ leak }), /forbidden secret\/PII shape/);
  }
});

test('the actor id comes from a valid JWT subject and is validated before it reaches SQL', () => {
  assert.equal(probe.actorIdFromJwt(TOKEN), ACTOR);
  const injected = `${b64url({})}.${b64url({ sub: "x'; drop table public.user_entitlements; --" })}.s`;
  assert.throws(() => probe.actorIdFromJwt(injected), /valid actor id/);
  assert.throws(() => probe.actorIdFromJwt('not-a-jwt'), /valid actor id/);
});

test('the live probe workflow is staging-only, read-only and never reveals or writes secrets', () => {
  // Assertions run against executable YAML only; prose comments may legitimately mention triggers.
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/staging-kplus-activate-hold-live-probe.yml'), 'utf8')
    .split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
  assert.match(workflow, /environment: staging/);
  assert.match(workflow, /permissions:\s*\n\s+contents: read/);
  assert.match(workflow, /node security\/release\/run-kplus-activate-hold-live-probe\.js/);
  assert.doesNotMatch(workflow, /--reveal|gh secret|secrets set|SERVICE_ROLE|wyyuqfdxucjksghsmhry/i);
  // Self-registration is scoped to exactly one probe branch (existing live-probe precedent).
  assert.match(workflow, /push:\s*\n\s+branches:\s*\n\s+- test\/build35-kplus-activate-hold-live-probe-v1\s*\n/);
  assert.doesNotMatch(workflow, /pull_request/);
  for (const line of workflow.split('\n').filter((l) => /uses:/.test(l))) assert.match(line, /@[0-9a-f]{40}\b/, `unpinned action: ${line.trim()}`);
});

test('the probe itself contains no write to the function or database beyond read-only reads', () => {
  const source = fs.readFileSync(path.join(ROOT, 'security/release/run-kplus-activate-hold-live-probe.js'), 'utf8');
  assert.doesNotMatch(source, /\b(insert|update|delete|truncate|drop|alter|grant)\s+(into|from|table)?\b[^'"`\n]*public\./i);
  assert.doesNotMatch(source, /rpc\/grant_kplus|SERVICE_ROLE|--reveal/);
});
