#!/usr/bin/env node
'use strict';

// A source/build-environment guard, never a signed-artifact or device certificate.
const fs = require('node:fs');
const path = require('node:path');
const { resolveEasBuildProfile } = require('./resolve-eas-build-profiles');

const PROFILE = 'build35-release';
const PACKAGE = 'com.kscanai.app';
const PRODUCTION_REF = 'wyyuqfdxucjksghsmhry';
const PRODUCTION_URL = `https://${PRODUCTION_REF}.supabase.co`;
const REQUIRED_OFF = Object.freeze([
  'EXPO_PUBLIC_TODAY_WITH_ELISE_V1',
  'EXPO_PUBLIC_TODAY_WITH_ELISE_GENERATED_GREETING_V1',
  'EXPO_PUBLIC_TODAY_WITH_ELISE_WEATHER_V1',
  'EXPO_PUBLIC_CLOSET_CLOUD_SYNC_V1',
  'EXPO_PUBLIC_CLOSET_CROSS_DEVICE_RESTORE_V1',
  'EXPO_PUBLIC_CLOSET_LEGACY_MIGRATION_V1',
  'EXPO_PUBLIC_ELISE_SPEECH',
  'EXPO_PUBLIC_KPLUS_EARLY_ACCESS_ENABLED',
  'EXPO_PUBLIC_MULTI_IMAGE_SCANNER_ENABLED',
  'EXPO_PUBLIC_PACKING_INTELLIGENCE_V1',
  'EXPO_PUBLIC_SMART_WATCHLIST_V1',
  'EXPO_PUBLIC_VTO_UI_ENABLED',
  'EXPO_PUBLIC_VOICESCAN_ENABLED',
  'EXPO_PUBLIC_TEXTSCAN_VOICE_PLACEHOLDER',
]);
// Existing baseline policy leaves these selectors unconfigured. Do not add
// invented EAS worker/push variables: the worker is controlled in app_config.
const OPTIONAL_OFF = Object.freeze([
  'KSCAN_VOICE_NATIVE_CAPABILITY',
  'KSCAN_VOICE_CERTIFICATION',
  'EXPO_PUBLIC_LIVE_VTO_ENABLED',
  'EXPO_PUBLIC_LIVE_VTO_HARNESS',
  'EXPO_PUBLIC_SCAN_RESULTS_DEMO_UI',
  'EXPO_PUBLIC_TEXTSCAN_DEMO_RESULTS',
  'EXPO_PUBLIC_SCAN_IDENTITY_DEBUG',
  'SCAN_IDENTITY_DEBUG',
]);
// Deliberately fixed rather than inferred from production: adding a new ON
// feature to a parent must not silently expand the release surface.
const APPROVED_ON = new Set([
  'EXPO_PUBLIC_HOME_NAVIGATION_V2', 'EXPO_PUBLIC_ACCOUNT_HOME_UX_V1',
  'EXPO_PUBLIC_ONBOARDING_FRAMEWORK_V1', 'EXPO_PUBLIC_SCAN_ROOM_V2_UI',
  'EXPO_PUBLIC_SCAN_RESULTS_V2_UI', 'EXPO_PUBLIC_ROOM_CHAT_ENABLED',
  'EXPO_PUBLIC_WEATHER_STYLING_CONTEXT_ENABLED', 'EXPO_PUBLIC_STYLE_DNA_PROFILE_ENABLED',
  'EXPO_PUBLIC_STYLE_DNA_CONTEXT_ENABLED', 'EXPO_PUBLIC_STYLE_DNA_REASON_FEEDBACK_ENABLED',
  'EXPO_PUBLIC_FREE_TIER_UTILITY_ENABLED', 'EXPO_PUBLIC_FREE_TIER_WISHLIST_INTENT_ENABLED',
  'EXPO_PUBLIC_FREE_TIER_OUTFIT_GENERATOR_ENABLED', 'EXPO_PUBLIC_ENABLE_TEXTSCAN',
  'EXPO_PUBLIC_TEXTSCAN_BACKEND_ENABLED', 'EXPO_PUBLIC_SCAN_IDENTIFY_BACKEND_ENABLED',
  'EXPO_PUBLIC_DRESSING_ROOM_COLLABORATION_V1', 'EXPO_PUBLIC_DRESSING_ROOM_MESSAGES_V1',
  'EXPO_PUBLIC_DRESSING_ROOM_REACTIONS_V1', 'EXPO_PUBLIC_ELISE_VISUAL_ATTACHMENTS_V1_ENABLED',
  'EXPO_PUBLIC_ELISE_IDENTIFICATION_V2_ENABLED', 'EXPO_PUBLIC_ELISE_DRESSING_ROOM_ATTACHMENTS_V1',
  'EXPO_PUBLIC_ELISE_SHARED_ROOM_EVIDENCE_V1', 'EXPO_PUBLIC_AI_STYLIST_ENABLED',
  'EXPO_PUBLIC_AI_STYLIST_BACKEND_ENABLED', 'EXPO_PUBLIC_STYLECHAT_ATTACHMENTS_ENABLED',
  'EXPO_PUBLIC_CLOSET_SEPARATION_V1', 'EXPO_PUBLIC_CLOSET_DIRECT_INTAKE_V1',
  'EXPO_PUBLIC_CLOSET_CANDIDATE_STAGING_V1', 'EXPO_PUBLIC_CLOSET_BATCH_REVIEW_V2',
  'EXPO_PUBLIC_MIRROR_SELFIE_V1', 'EXPO_PUBLIC_PRIVATE_DRESSING_ROOM_V1',
  'EXPO_PUBLIC_PRIVATE_DRESSING_ROOM_INTERACTIONS_V1', 'EXPO_PUBLIC_PRIVATE_DRESSING_ROOM_ELISE_V1',
  'EXPO_PUBLIC_PRIVATE_DRESSING_ROOM_SAVED_LOOKS_V1',
]);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function resolveCheckedProfile(eas, name) {
  if (!isObject(eas?.build)) throw new Error('Build profile map is missing or invalid');
  const seen = new Set();
  let current = name;
  while (current !== undefined) {
    if (typeof current !== 'string' || seen.has(current)) {
      throw new Error('Build profile inheritance is invalid or cyclic');
    }
    seen.add(current);
    if (!Object.hasOwn(eas.build, current)) throw new Error('Build profile inheritance references a missing profile');
    const profile = eas.build[current];
    if (!isObject(profile)) throw new Error('Build profile inheritance references a missing or invalid profile');
    for (const key of ['env', 'android', 'ios']) {
      if (profile[key] !== undefined && !isObject(profile[key])) {
        throw new Error(`Build profile ${key} map is invalid`);
      }
    }
    current = profile.extends;
  }
  return resolveEasBuildProfile(eas, name);
}

function validateEnvironment(env, failures) {
  if (!isObject(env)) {
    failures.push('Effective environment must be an object');
    return;
  }
  for (const key of REQUIRED_OFF) {
    if (env[key] !== 'false') failures.push(`${key} must resolve explicitly false`);
  }
  for (const key of OPTIONAL_OFF) {
    if (env[key] !== undefined && env[key] !== 'false') failures.push(`${key} must be absent or explicitly false`);
  }
  if (env.EXPO_PUBLIC_ENVIRONMENT !== 'production') failures.push('Public environment must resolve production');
  if (env.EXPO_PUBLIC_SUPABASE_URL !== PRODUCTION_URL) failures.push('Supabase URL must resolve the exact production origin');
  // A public anon JWT is not authenticated here; check its source identity and
  // role without ever printing its value or decoded claims.
  try {
    const key = env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
    if (typeof key !== 'string' || key.split('.').length !== 3) throw new Error();
    const claims = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString('utf8'));
    if (claims.role !== 'anon' || claims.ref !== PRODUCTION_REF) throw new Error();
  } catch {
    failures.push('Public Supabase key must carry the production anon identity');
  }
  // There is no approved legacy API endpoint in the release profile. A new
  // one requires review, rather than a permissive HTTPS/substring check.
  if (env.EXPO_PUBLIC_API_URL !== undefined && env.EXPO_PUBLIC_API_URL !== '') {
    failures.push('Legacy API endpoint is not approved for the release profile');
  }
  for (const key of Object.keys(env)) {
    if (key.startsWith('EXPO_PUBLIC_') && env[key] === 'true' && !APPROVED_ON.has(key)) {
      failures.push('An unapproved public capability resolves enabled');
    }
    if (/^EXPO_PUBLIC_.*(?:SECRET|SERVICE_ROLE|ACCESS_TOKEN|PRIVATE_KEY|PASSWORD)/i.test(key)) {
      failures.push('A secret-shaped public environment variable is forbidden');
    }
  }
}

function validateReleaseProfile({ eas, app, gradle, effectiveEnv }) {
  const failures = [];
  let profile;
  try {
    profile = resolveCheckedProfile(eas, PROFILE);
  } catch (error) {
    return [error.message];
  }
  if (eas.build[PROFILE].extends !== 'production') failures.push('Release profile must extend production, independently of certification');
  if (profile.environment !== 'production') failures.push('EAS environment must resolve production');
  if (profile.distribution !== 'store') failures.push('Release distribution must resolve store');
  if (profile.autoIncrement !== true || eas.cli?.appVersionSource !== 'remote') failures.push('Release numbering must use remote versions with autoIncrement');
  if (profile.developmentClient === true) failures.push('Release cannot enable a development client');
  if (profile.android?.buildType !== 'app-bundle') failures.push('Android release must be an app bundle');
  if (profile.android?.gradleCommand !== undefined || profile.android?.withoutCredentials === true) failures.push('Android release cannot bypass the store build or signing path');
  if (profile.ios?.buildConfiguration !== 'Release' || profile.ios?.simulator === true) failures.push('iOS release must use a physical-device Release build');
  if (profile.android?.autoIncrement === false || profile.ios?.autoIncrement === false) failures.push('Platform version numbering cannot disable autoIncrement');
  for (const key of REQUIRED_OFF) {
    if (eas.build[PROFILE].env?.[key] !== 'false') failures.push(`${key} requires an explicit release override`);
  }
  validateEnvironment(profile.env, failures);
  if (effectiveEnv !== undefined) validateEnvironment(effectiveEnv, failures);
  const expo = app?.expo;
  if (expo?.android?.package !== PACKAGE || expo?.ios?.bundleIdentifier !== PACKAGE) failures.push('Both native identities must equal the approved package');
  // Strip comments so prose cannot satisfy a native identity assertion.
  const code = typeof gradle === 'string' ? gradle.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '') : '';
  for (const key of ['namespace', 'applicationId']) {
    const match = code.match(new RegExp(`\\b${key}\\s+['"]([^'"]+)['"]`));
    if (match?.[1] !== PACKAGE) failures.push(`Android ${key} must equal the approved package`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(expo?.version ?? '') || !/^\d+\.\d+\.\d+$/.test(expo?.ios?.version ?? '')) failures.push('Marketing versions must be explicit semantic versions');
  if (!Number.isSafeInteger(expo?.android?.versionCode) || expo.android.versionCode <= 0 || !/^[1-9]\d*$/.test(expo?.ios?.buildNumber ?? '')) failures.push('Checked-in build number seeds must be positive');
  return [...new Set(failures)];
}

function main(args = process.argv.slice(2)) {
  if (args.length !== 0 && !(args.length === 2 && args[0] === '--effective-env-json')) {
    console.error('Usage: node scripts/check-build35-release-profile.js [--effective-env-json <private-file>]');
    return 2;
  }
  const root = path.resolve(__dirname, '..');
  let input;
  try {
    input = {
      eas: JSON.parse(fs.readFileSync(path.join(root, 'eas.json'), 'utf8')),
      app: JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8')),
      gradle: fs.readFileSync(path.join(root, 'android/app/build.gradle'), 'utf8'),
      ...(args.length ? { effectiveEnv: JSON.parse(fs.readFileSync(args[1], 'utf8')) } : {}),
    };
  } catch {
    console.error('FAIL Build 35 release inputs could not be read or parsed (values withheld).');
    return 2;
  }
  const failures = validateReleaseProfile(input);
  for (const failure of failures) console.error(`FAIL ${failure}`);
  if (failures.length) return 1;
  console.log(`PASS ${PROFILE}: ${args.length ? 'source and supplied effective environment' : 'source configuration'} holds and identities; artifact/device/store certification remains required.`);
  return 0;
}

if (require.main === module) process.exitCode = main();
module.exports = { PROFILE, REQUIRED_OFF, OPTIONAL_OFF, resolveCheckedProfile, validateReleaseProfile, main };
