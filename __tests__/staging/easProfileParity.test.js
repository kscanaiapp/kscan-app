#!/usr/bin/env node
'use strict';

/**
 * Staging/production client-parity gate.
 *
 * WHY THIS EXISTS: the previous staging line drifted away from the released
 * production client without anything failing. A staging build is only a useful
 * pre-production signal if it runs the SAME client feature architecture as
 * production and differs ONLY in which backend it points at.
 *
 * This test fails on any client-feature flag drift between the production and
 * staging EAS profiles. The only differences allowed are the environment-
 * specific ones listed in ENVIRONMENT_SPECIFIC_KEYS below; adding to that list
 * is a deliberate, reviewable act.
 *
 * Pure unit test — no network, no secrets.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');

const PRODUCTION_PROJECT_REF = 'wyyuqfdxucjksghsmhry';
const STAGING_PROJECT_REF = 'yzqjvdfgefveprobvvyw';

/**
 * Keys permitted to differ between the production and staging profiles, each
 * with the reason it is environment-specific rather than a behavior change.
 * A key may ONLY appear here if changing it cannot alter client behavior.
 */
const ENVIRONMENT_SPECIFIC_KEYS = new Map([
  ['EXPO_PUBLIC_SUPABASE_URL', 'selects the backend project; not a client feature'],
  ['EXPO_PUBLIC_SUPABASE_ANON_KEY', 'publishable key for the selected project'],
  ['EXPO_PUBLIC_ENVIRONMENT', 'environment label surfaced in diagnostics only'],
  ['EXPO_PUBLIC_ENV_LABEL', 'environment label surfaced in diagnostics only'],
]);

function readEas() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'eas.json'), 'utf8'));
}

function envOf(eas, profile) {
  const build = eas.build || {};
  assert.ok(build[profile], `eas.json is missing the "${profile}" build profile`);
  return build[profile].env || {};
}

test('eas.json defines both a production and a staging build profile', () => {
  const eas = readEas();
  assert.ok(eas.build.production, 'production profile must exist');
  assert.ok(eas.build.staging, 'staging profile must exist');
});

test('staging exposes exactly the production client-feature flag set', () => {
  const eas = readEas();
  const production = envOf(eas, 'production');
  const staging = envOf(eas, 'staging');

  const missingFromStaging = Object.keys(production)
    .filter((key) => !(key in staging))
    .sort();
  const extraInStaging = Object.keys(staging)
    .filter((key) => !(key in production))
    .sort();

  assert.deepEqual(
    missingFromStaging,
    [],
    `staging profile is missing production flags: ${missingFromStaging.join(', ')}. ` +
      'A production flag omitted from staging means staging does not exercise released behavior.',
  );
  assert.deepEqual(
    extraInStaging,
    [],
    `staging profile declares flags production does not: ${extraInStaging.join(', ')}. ` +
      'Staging must not enable behavior that production has not shipped.',
  );
});

test('shared flags hold identical values unless allow-listed as environment-specific', () => {
  const eas = readEas();
  const production = envOf(eas, 'production');
  const staging = envOf(eas, 'staging');

  const unexplainedDrift = Object.keys(production)
    .filter((key) => key in staging)
    .filter((key) => production[key] !== staging[key])
    .filter((key) => !ENVIRONMENT_SPECIFIC_KEYS.has(key))
    .sort();

  assert.deepEqual(
    unexplainedDrift,
    [],
    `client-feature flags differ between production and staging without an allow-listed ` +
      `environment-specific reason: ${unexplainedDrift.join(', ')}`,
  );
});

test('production targets the production project and staging targets the staging project', () => {
  const eas = readEas();
  const production = envOf(eas, 'production');
  const staging = envOf(eas, 'staging');

  assert.match(
    production.EXPO_PUBLIC_SUPABASE_URL,
    new RegExp(`^https://${PRODUCTION_PROJECT_REF}\\.supabase\\.co/?$`),
    'production profile must point at the production Supabase project',
  );
  assert.match(
    staging.EXPO_PUBLIC_SUPABASE_URL,
    new RegExp(`^https://${STAGING_PROJECT_REF}\\.supabase\\.co/?$`),
    'staging profile must point at the staging Supabase project',
  );
  assert.notEqual(
    staging.EXPO_PUBLIC_SUPABASE_URL,
    production.EXPO_PUBLIC_SUPABASE_URL,
    'staging must never target production',
  );
  assert.notEqual(
    staging.EXPO_PUBLIC_SUPABASE_ANON_KEY,
    production.EXPO_PUBLIC_SUPABASE_ANON_KEY,
    'staging must not reuse the production publishable key',
  );
});

test('staging is internal, non-store distribution and production is unchanged', () => {
  const eas = readEas();
  const production = eas.build.production;
  const staging = eas.build.staging;

  // Production release behavior must not be altered by adding staging.
  assert.equal(production.distribution, 'store', 'production must remain store distribution');
  assert.equal(production.android?.buildType, 'app-bundle', 'production Android must remain an app bundle');
  assert.equal(production.autoIncrement, true, 'production autoIncrement must be preserved');
  assert.equal(eas.cli?.appVersionSource, 'remote', 'remote version source must be preserved');

  // Staging must not be publishable to a store.
  assert.equal(staging.distribution, 'internal', 'staging must be internal distribution');
  assert.equal(staging.android?.buildType, 'apk', 'staging Android artifact must be an APK');
});

test('the released home implementation remains the default entry, with no testing fallback', () => {
  const entry = fs.readFileSync(path.join(ROOT, 'app', 'index.tsx'), 'utf8');
  assert.match(
    entry,
    /HomeLuxuryTechV1/,
    'app/index.tsx must render the released production home implementation',
  );

  // The legacy testing fork shipped a fallback home that must never become the
  // staging default. Its absence is part of the parity contract.
  for (const fallback of ['SafeUnavailableScreen', 'FallbackHome', 'HomeFallback']) {
    assert.ok(
      !fs.existsSync(path.join(ROOT, 'components', `${fallback}.tsx`)),
      `testing-fork fallback component ${fallback}.tsx must not exist on the staging baseline`,
    );
    assert.doesNotMatch(
      entry,
      new RegExp(fallback),
      `app/index.tsx must not reference the testing-fork fallback ${fallback}`,
    );
  }
});
