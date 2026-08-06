#!/usr/bin/env node
'use strict';

/**
 * Regression guard for eas.json's Supabase environment targeting.
 *
 * 2026-08-06: the Candidate Artifact Exposure Gate found that the
 * `development` and `preview` EAS build profiles referenced the PRODUCTION
 * Supabase project (wyyuqfdxucjksghsmhry) and a production anon key,
 * instead of staging -- meaning `eas build --profile preview` or
 * `--profile development` produced a build that talked to production. Only
 * `staging` correctly used the staging project. Fixed by pointing
 * development/preview at staging; `production`'s own profile is untouched
 * (it is the one profile that is SUPPOSED to reference production).
 *
 * This reads the real eas.json directly (not a fixture) so it fails loudly
 * if the file ever drifts back.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { classifyJwt, PRODUCTION_PROJECT_REF, STAGING_PROJECT_REF } = require('../../security/scripts/scan-candidate-artifacts');

const easPath = path.join(__dirname, '..', '..', 'eas.json');
const eas = JSON.parse(fs.readFileSync(easPath, 'utf8'));

const NON_PRODUCTION_PROFILES = ['development', 'preview', 'staging'];

for (const profile of NON_PRODUCTION_PROFILES) {
  test(`eas.json: ${profile} profile cannot resolve to the production Supabase URL`, () => {
    const url = eas.build[profile].env.EXPO_PUBLIC_SUPABASE_URL;
    assert.ok(!url.includes(PRODUCTION_PROJECT_REF), `${profile} EXPO_PUBLIC_SUPABASE_URL resolves to production: ${url}`);
  });

  test(`eas.json: ${profile} profile's anon key does not decode to the production project`, () => {
    const key = eas.build[profile].env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
    const classification = classifyJwt(key);
    assert.notEqual(classification.ruleId, 'PRODUCTION_JWT', `${profile} EXPO_PUBLIC_SUPABASE_ANON_KEY decodes to the production project`);
  });
}

test('eas.json: development and preview resolve only to the staging Supabase project', () => {
  for (const profile of ['development', 'preview']) {
    const url = eas.build[profile].env.EXPO_PUBLIC_SUPABASE_URL;
    assert.ok(url.includes(STAGING_PROJECT_REF), `${profile} EXPO_PUBLIC_SUPABASE_URL does not resolve to staging: ${url}`);
  }
});

test('eas.json: staging profile resolves only to the staging Supabase project', () => {
  const url = eas.build.staging.env.EXPO_PUBLIC_SUPABASE_URL;
  assert.ok(url.includes(STAGING_PROJECT_REF));
  assert.ok(!url.includes(PRODUCTION_PROJECT_REF));
});

test('eas.json: production profile resolves only to the production Supabase project', () => {
  const url = eas.build.production.env.EXPO_PUBLIC_SUPABASE_URL;
  assert.ok(url.includes(PRODUCTION_PROJECT_REF), `production EXPO_PUBLIC_SUPABASE_URL does not resolve to production: ${url}`);
  assert.ok(!url.includes(STAGING_PROJECT_REF));
});

test('eas.json: production profile anon key decodes to the production project (expected here, and only here)', () => {
  const key = eas.build.production.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  const classification = classifyJwt(key);
  assert.equal(classification.ruleId, 'PRODUCTION_JWT');
});

test('eas.json: every profile\'s Supabase anon key is a public client key, not a private credential', () => {
  for (const profile of Object.keys(eas.build)) {
    const key = eas.build[profile].env && eas.build[profile].env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
    if (!key) continue;
    const classification = classifyJwt(key);
    assert.notEqual(classification.ruleId, 'SUPABASE_SERVICE_ROLE_JWT', `${profile} carries a service-role JWT, not a public anon key`);
    assert.ok(
      ['STAGING_ANON_JWT', 'PRODUCTION_JWT'].includes(classification.ruleId),
      `${profile} anon key classified unexpectedly: ${classification.ruleId}`
    );
  }
});

test('eas.json: no service-role, secret, provider, or administrative key anywhere in the file', () => {
  const raw = fs.readFileSync(easPath, 'utf8');
  assert.ok(!/service_role/i.test(raw), 'literal "service_role" must not appear in eas.json');
  assert.ok(!/sb_secret_/.test(raw), 'a Supabase secret-format key must not appear in eas.json');
  assert.ok(!/sbp_[a-f0-9]{40}/.test(raw), 'a Supabase personal/CI access token must not appear in eas.json');
  assert.ok(!/sk-[A-Za-z0-9]{20,}/.test(raw), 'an OpenAI-style private key must not appear in eas.json');
  assert.ok(!/AIza[0-9A-Za-z_-]{35}/.test(raw), 'a Google/Gemini API key must not appear in eas.json');
});

test('Candidate Artifact Exposure Gate: eas.json passes with zero blocked findings after the correction', () => {
  const { scan, summarize } = require('../../security/scripts/scan-candidate-artifacts');
  const summary = summarize(scan([easPath]));
  assert.equal(summary.blockedCount, 0, JSON.stringify(summary.findings.filter((f) => f.verdict === 'BLOCK')));
  assert.equal(summary.verdict, 'PASS');
});
