'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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
test('P0-TODAY-01: every effective Today flag preserves the Phase 0 baseline', () => assertToday(eas));
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
test('ordinary Production keeps scoped premium rollout flags off', () => {
  const env = effective(eas, 'production');
  for (const flag of ['PACKING_INTELLIGENCE', 'SMART_WATCHLIST', 'CLOSET_CLOUD_SYNC', 'CLOSET_CROSS_DEVICE_RESTORE', 'CLOSET_LEGACY_MIGRATION']) {
    assert.notEqual(env[`EXPO_PUBLIC_${flag}_V1`], 'true', flag);
  }
});
