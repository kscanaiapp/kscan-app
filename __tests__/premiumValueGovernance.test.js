'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const baseline = require('../config/build35-premium-value-baseline.json');
const eas = JSON.parse(fs.readFileSync(path.join(root, 'eas.json'), 'utf8'));
function effective(config, name) {
  const profile = config.build[name];
  return { ...(profile.extends ? effective(config, profile.extends) : {}), ...profile.env };
}
function assertToday(config) {
  assert.deepEqual(Object.keys(config.build).sort(), Object.keys(baseline.todayByProfile).sort());
  for (const [name, expected] of Object.entries(baseline.todayByProfile)) {
    const env = effective(config, name);
    assert.deepEqual(baseline.todayFlagOrder.map(flag => env[flag]), expected, name);
  }
}
test('P0-TODAY-01: every effective Today flag preserves the owner hold baseline', () => assertToday(eas));
test('NC-PV-01: Today is OFF in every profile under the owner Build 35 hold', () => {
  for (const name of Object.keys(eas.build)) {
    for (const flag of baseline.todayFlagOrder) assert.equal(effective(eas, name)[flag], 'false', `${name}/${flag}`);
  }
});
for (const name of Object.keys(baseline.todayByProfile)) {
  for (const flag of baseline.todayFlagOrder) {
    test(`NC-PV-TODAY: ${name}/${flag} drift is rejected`, () => {
      const mutant = structuredClone(eas);
      mutant.build[name].env ??= {};
      mutant.build[name].env[flag] = effective(eas, name)[flag] === 'true' ? 'false' : 'true';
      assert.throws(() => assertToday(mutant), assert.AssertionError);
    });
  }
  test(`P0-02: ${name} keeps legacy K+ Early Access off`, () => {
    assert.equal(effective(eas, name).EXPO_PUBLIC_KPLUS_EARLY_ACCESS_ENABLED, 'false');
  });
}
test('owner-approved Build 35 store profiles enable the scoped premium features', () => {
  for (const profile of ['production', 'build35-release']) {
    const env = effective(eas, profile);
    for (const flag of ['PACKING_INTELLIGENCE', 'SMART_WATCHLIST', 'CLOSET_CLOUD_SYNC', 'CLOSET_CROSS_DEVICE_RESTORE', 'CLOSET_LEGACY_MIGRATION']) {
      assert.equal(env[`EXPO_PUBLIC_${flag}_V1`], 'true', `${profile}/${flag}`);
    }
  }
});
function assertProtected(read) {
  for (const [file, digest] of Object.entries(baseline.protectedSourceDigests)) {
    const actual = crypto.createHash('sha256').update(read(file).replace(/\r\n/g, '\n')).digest('hex');
    assert.equal(actual, digest, file);
  }
}
const readProtected = file => fs.readFileSync(path.join(root, file), 'utf8');
test('Today, Speech, VTO lifecycle, RevenueCat and K+ entitlement semantics preserve integration authority', () => assertProtected(readProtected));

test('C010 updates only the reviewed canonical adapter digest and retains all other protected baselines', () => {
  const { execFileSync } = require('node:child_process');
  const canonical = '531f288fe52ab7ff8ef733408779d19ba4d93c6b';
  const file = 'supabase/functions/vto-generate/providers/aiLabToolsProvider.ts';
  const before = JSON.parse(execFileSync('git', ['show', '8bdcaaba986b169a15cb5545008ffef34c7b65f7:config/build35-premium-value-baseline.json'], { cwd: root, encoding: 'utf8' }));
  const approved = execFileSync('git', ['show', `${canonical}:${file}`], { cwd: root, encoding: 'utf8' }).replace(/\r\n/g, '\n');
  const digest = crypto.createHash('sha256').update(approved).digest('hex');
  assert.deepEqual(baseline.protectedSourceDigests, { ...before.protectedSourceDigests, [file]: digest });
  assert.deepEqual(baseline.todayByProfile, before.todayByProfile);
  assert.equal(baseline.c010SourcePromotion.sha, canonical);
  assert.equal(baseline.c010SourcePromotion.pr, 659);
  assert.equal(baseline.c010SourcePromotion.priorDigest, before.protectedSourceDigests[file]);
  assert.equal(readProtected(file).replace(/\r\n/g, '\n'), approved);
  assert.throws(() => assertProtected(target => readProtected(target) + (target === file ? '\n// unreviewed mutation\n' : '')), assert.AssertionError);
});
test('NC-PV-10: changing RevenueCat or the legacy acquisition implementation fails the release guard', () => {
  for (const target of ['services/kplus/revenueCatNative.ts', 'components/kplus/KPlusEarlyAccessSheet.tsx']) {
    assert.throws(() => assertProtected(file => readProtected(file) + (file === target ? '\n// unauthorized change\n' : '')), assert.AssertionError);
  }
});
test('legacy Early Access cannot be re-enabled by a profile override', () => {
  for (const profile of Object.keys(baseline.todayByProfile)) {
    const mutant = structuredClone(eas); mutant.build[profile].env ??= {};
    mutant.build[profile].env.EXPO_PUBLIC_KPLUS_EARLY_ACCESS_ENABLED = 'true';
    assert.throws(() => assert.equal(effective(mutant, profile).EXPO_PUBLIC_KPLUS_EARLY_ACCESS_ENABLED, 'false'), assert.AssertionError);
  }
});
