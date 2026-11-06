// B41 consolidated K+ repair -- onboarding claim truth (audit K-08 / K-17).
//
// Watchlist push delivery has no runtime proof (no watch_push_ios /
// watch_push_android record in services/kplus/kplusCapabilityProof.ts), and the
// only prompt that arms price alerts (components/ProductShelf.tsx) is gated on
// those proofs. Onboarding therefore must not promise price alerts, and the
// Step 5 CTA must not claim to go Home when it opens K+ membership (Step 6).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

function hasWatchPushProof() {
  const proof = stripComments(read('services', 'kplus', 'kplusCapabilityProof.ts'));
  const records = proof.slice(proof.indexOf('PREMIUM_VALUE_PROOFS'));
  return /proofType:\s*'watch_push_(ios|android)'/.test(records);
}

test('B41 K-17: onboarding Step 5 does not promise price alerts while push delivery is unproven', () => {
  const step5 = stripComments(read('components', 'account-home', 'PermissionsStepV1.tsx'));
  if (!hasWatchPushProof()) {
    assert.doesNotMatch(step5, /Get notified when a watched item hits your target price/);
    assert.doesNotMatch(step5, /['"`][^'"`]*\b(hits|reaches) your target price[^'"`]*['"`]/i);
  }
  // The arming prompt stays proof-gated (the claim and the capability move together).
  assert.match(read('components', 'ProductShelf.tsx'), /hasRuntimeCapabilityProof\('smart_watchlist',\s*\n?\s*Platform\.OS === 'ios' \? 'watch_push_ios' : 'watch_push_android'\)/);
});

test('B41 K-08: the Step 5 CTA does not say Home -- it opens K+ membership (Step 6)', () => {
  const step5 = read('components', 'account-home', 'PermissionsStepV1.tsx');
  assert.doesNotMatch(step5, /title="[^"]*CONTINUE TO HOME[^"]*"/);
  const onboarding = read('app', 'onboarding', 'index.tsx');
  assert.match(onboarding, /onContinueToHome=\{goToKPlusActivation\}/);
});
