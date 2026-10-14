'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const src = read('services/kplus/kplusAcquisitionSurface.ts');

function getAcquisitionResolver() {
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(`(function(exports, module) { ${js}\n})`, { Object })(module.exports, module);
  return module.exports;
}

test('Build 35 Voice Scan and onboarding K+ actions open paid membership, not retired complimentary Early Access', () => {
  const { resolveKPlusAcquisitionSurface: resolve } = getAcquisitionResolver();
  assert.equal(resolve('voice_scan'), 'membership');
  assert.equal(resolve('onboarding'), 'membership');
});

test('existing paid VTO, Packing, Watchlist and Closet upgrade paths are unchanged', () => {
  const { resolveKPlusAcquisitionSurface: resolve } = getAcquisitionResolver();
  for (const source of ['vto', 'packing', 'watchlist', 'closet_intelligence', 'account', 'wardrobe_concierge']) {
    assert.equal(resolve(source), 'membership', source);
  }
  // Unknown sources must never reactivate retired complimentary acquisition.
  assert.equal(resolve('unknown'), 'membership');
});

test('the fixed mapping connects the actual welcome permission and Home Voice Scan entry points', () => {
  assert.match(read('components/account-home/PermissionsStepV1.tsx'), /<KPlusGate source="onboarding">/);
  assert.match(read('components/home/HomeVoiceScanPill.tsx'), /<KPlusGate source="voice_scan">/);
  const gate = read('components/kplus/KPlusGate.tsx');
  assert.doesNotMatch(gate, /KPlusEarlyAccessSheet/);
  assert.match(gate, /KPlusMembershipSheet/);
});

test('premium acquisition fix does not reactivate the complimentary Early Access campaign', () => {
  const eas = JSON.parse(read('eas.json'));
  const effective = (name) => {
    const profile = eas.build[name];
    return { ...(profile.extends ? effective(profile.extends) : {}), ...(profile.env || {}) };
  };
  for (const profile of ['production', 'build35-release']) {
    assert.equal(effective(profile).EXPO_PUBLIC_KPLUS_EARLY_ACCESS_ENABLED, 'false');
  }
});
